/**
 * Short-lived, environment-local USD-M price references for order sizing.
 *
 * The cache deliberately knows nothing about spot.  A 1000x multiplier contract
 * such as 1000PEPEUSDT has a different unit from the bare PEPEUSDT spot symbol,
 * so a spot price is never a valid sizing fallback.  The primary source is the
 * USD-M premium-index mark.  Only when that public mark is temporarily absent
 * do we use the midpoint of the USD-M execution book for the exact same symbol.
 */
import type { FuturesReferenceCacheEvent } from "./futures-reference-health.js";

export type FuturesMarketReferenceSource = "USD_M_MARK_PRICE" | "USD_M_BOOK_TICKER";

export interface FuturesMarketReference {
  symbol: string;
  price: number;
  atMs: number;
  source: FuturesMarketReferenceSource;
}

export interface FuturesMarketReferenceClient {
  getMarkPrice(symbol: string): Promise<number | null>;
  getBookTicker(symbol: string): Promise<{ bid: number | null; ask: number | null }>;
}

export interface FuturesMarketReferenceCacheOptions {
  nowMs?: () => number;
  /** A sizing reference must be very recent.  Expired entries are never returned. */
  maxAgeMs?: number;
  maxSymbols?: number;
  /** Observability only. Failures in this callback can never change pricing behavior. */
  onEvent?: (event: FuturesReferenceCacheEvent) => void;
}

const DEFAULT_MAX_AGE_MS = 10_000;
const DEFAULT_MAX_SYMBOLS = 256;

function canonicalSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function executableBookMid(book: { bid: number | null; ask: number | null }): number | null {
  // A one-sided book is not a safe canonical price for sizing: require the same
  // two-sided USD-M quote that the execution path itself can actually observe.
  if (!positiveFinite(book.bid) || !positiveFinite(book.ask) || book.ask < book.bid) return null;
  return (book.bid + book.ask) / 2;
}

/**
 * Runtime defense for injected/cached data.  TypeScript callers only construct
 * USD-M references, but this checks the source and exact symbol at the boundary
 * so a spot cache value can never become a multiplier sizing price by accident.
 */
export function verifiedFuturesMarketReferencePrice(
  symbol: string,
  reference: FuturesMarketReference | null | undefined,
): number | null {
  const canonical = canonicalSymbol(symbol);
  if (
    !reference ||
    reference.symbol !== canonical ||
    !positiveFinite(reference.price) ||
    (reference.source !== "USD_M_MARK_PRICE" && reference.source !== "USD_M_BOOK_TICKER")
  ) return null;
  return reference.price;
}

export class FuturesMarketReferenceCache {
  private readonly references = new Map<string, FuturesMarketReference>();
  private readonly inFlight = new Map<string, Promise<FuturesMarketReference | null>>();
  private readonly nowMs: () => number;
  private readonly maxAgeMs: number;
  private readonly maxSymbols: number;
  private readonly onEvent: ((event: FuturesReferenceCacheEvent) => void) | null;

  constructor(
    private readonly client: FuturesMarketReferenceClient,
    opts: FuturesMarketReferenceCacheOptions = {},
  ) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs! > 0
      ? Math.floor(opts.maxAgeMs!)
      : DEFAULT_MAX_AGE_MS;
    this.maxSymbols = Number.isFinite(opts.maxSymbols) && opts.maxSymbols! > 0
      ? Math.floor(opts.maxSymbols!)
      : DEFAULT_MAX_SYMBOLS;
    this.onEvent = opts.onEvent ?? null;
  }

  /** Returns a fresh exact-symbol USD-M reference, never a stale cache value. */
  read(symbol: string): FuturesMarketReference | null {
    const canonical = canonicalSymbol(symbol);
    const reference = this.freshReference(canonical);
    if (reference) this.emit({ type: "CACHE_HIT", symbol: canonical, atMs: this.nowMs() });
    return reference;
  }

  private freshReference(canonical: string): FuturesMarketReference | null {
    const reference = this.references.get(canonical);
    if (!reference) return null;
    const ageMs = this.nowMs() - reference.atMs;
    if (ageMs < 0 || ageMs > this.maxAgeMs) {
      this.references.delete(canonical);
      this.emit({ type: "STALE_CACHE_REJECTED", symbol: canonical, atMs: this.nowMs(), ageMs });
      return null;
    }
    return reference;
  }

  /**
   * Single-flight refresh: callers arriving in the same event-loop window share
   * one exchange lookup.  Failed refreshes intentionally return null instead of
   * reusing an expired reference, so an unverified contract cannot open a basket.
   */
  async refresh(symbol: string): Promise<FuturesMarketReference | null> {
    const canonical = canonicalSymbol(symbol);
    const fresh = this.freshReference(canonical);
    if (fresh) {
      this.emit({ type: "CACHE_HIT", symbol: canonical, atMs: this.nowMs() });
      return fresh;
    }

    const alreadyFetching = this.inFlight.get(canonical);
    if (alreadyFetching) return alreadyFetching;

    this.emit({ type: "CACHE_MISS", symbol: canonical, atMs: this.nowMs() });
    const refresh = this.fetchFresh(canonical);
    this.inFlight.set(canonical, refresh);
    try {
      return await refresh;
    } finally {
      if (this.inFlight.get(canonical) === refresh) this.inFlight.delete(canonical);
    }
  }

  private remember(reference: FuturesMarketReference): FuturesMarketReference {
    if (!this.references.has(reference.symbol) && this.references.size >= this.maxSymbols) {
      const oldest = this.references.keys().next();
      if (!oldest.done) this.references.delete(oldest.value);
    }
    this.references.set(reference.symbol, reference);
    return reference;
  }

  private emit(event: FuturesReferenceCacheEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Health accounting is strictly observational and must never disturb sizing.
    }
  }

  private failureReason(value: unknown, fallback: string): string {
    const message = value instanceof Error ? value.message : String(value ?? "");
    return message.trim().slice(0, 180) || fallback;
  }

  private async fetchFresh(symbol: string): Promise<FuturesMarketReference | null> {
    let markFailure = "premiumIndex returned no positive mark";
    try {
      const markPrice = await this.client.getMarkPrice(symbol);
      if (positiveFinite(markPrice)) {
        return this.remember({ symbol, price: markPrice, atMs: this.nowMs(), source: "USD_M_MARK_PRICE" });
      }
    } catch (error) {
      markFailure = this.failureReason(error, "premiumIndex unavailable");
    }
    this.emit({ type: "MARK_UNAVAILABLE", symbol, atMs: this.nowMs(), reason: markFailure });

    let bookFailure = "USD-M book has no safe two-sided midpoint";
    try {
      const book = await this.client.getBookTicker(symbol);
      const mid = executableBookMid(book);
      if (mid !== null) {
        return this.remember({ symbol, price: mid, atMs: this.nowMs(), source: "USD_M_BOOK_TICKER" });
      }
    } catch (error) {
      bookFailure = this.failureReason(error, "USD-M book unavailable");
    }
    this.emit({ type: "BOOK_UNAVAILABLE", symbol, atMs: this.nowMs(), reason: bookFailure });
    this.emit({
      type: "PUBLIC_REFERENCE_UNAVAILABLE",
      symbol,
      atMs: this.nowMs(),
      reason: `mark: ${markFailure}; book: ${bookFailure}`,
    });
    return null;
  }
}

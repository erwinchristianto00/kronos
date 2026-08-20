/**
 * Read-only health accounting for the exact USD-M price-reference chain used by
 * multiplier-contract sizing.  It intentionally has no spot client and exposes
 * no mutation/order capability.
 */
import type {
  FuturesMarketReference,
  FuturesMarketReferenceSource,
} from "./futures-market-reference-cache.js";

export type FuturesReferenceCacheEvent =
  | { type: "CACHE_HIT"; symbol: string; atMs: number }
  | { type: "CACHE_MISS"; symbol: string; atMs: number }
  | { type: "STALE_CACHE_REJECTED"; symbol: string; atMs: number; ageMs: number }
  | { type: "MARK_UNAVAILABLE"; symbol: string; atMs: number; reason: string }
  | { type: "BOOK_UNAVAILABLE"; symbol: string; atMs: number; reason: string }
  | { type: "PUBLIC_REFERENCE_UNAVAILABLE"; symbol: string; atMs: number; reason: string }
  | {
      type: "MARK_BOOK_DIVERGENCE";
      symbol: string;
      atMs: number;
      markPrice: number;
      bookMid: number;
      divergencePct: number;
      abnormal: boolean;
    };

export type FuturesReferenceDiagnosticSource =
  | FuturesMarketReferenceSource
  | "POSITION_RISK"
  | "NONE";

export type FuturesReferenceDiagnosticStatus =
  | "HEALTHY"
  | "FALLBACK"
  | "UNAVAILABLE"
  | "SCALE_GUARD_REJECTED"
  | "NOT_ELIGIBLE"
  | "UNVERIFIED"
  | "ALERT";

export interface FuturesReferenceHealthSymbol {
  symbol: string;
  eligible: boolean | null;
  reference: FuturesReferenceDiagnosticSource;
  price: number | null;
  status: FuturesReferenceDiagnosticStatus;
  lastUpdatedAt: string | null;
  lastFailure: string | null;
  markBookDivergencePct: number | null;
}

export interface FuturesReferenceHealthAlert {
  code:
    | "REFERENCE_UNAVAILABLE"
    | "FALLBACK_RATE_ABNORMAL"
    | "STALE_CACHE_INCREASING"
    | "SCALE_ANOMALY"
    | "MARK_BOOK_DIVERGENCE";
  severity: "BLOCK" | "WATCH";
  message: string;
}

export interface FuturesReferenceHealthSnapshot {
  enabled: true;
  generatedAt: string;
  startedAt: string;
  sourceChain: ["USD_M_MARK_PRICE", "USD_M_BOOK_TICKER", "POSITION_RISK", "FAIL_CLOSED"];
  counters: {
    usdMMarkUsed: number;
    bookFallback: number;
    positionRiskFallback: number;
    referenceUnavailable: number;
    scaleGuardRejected: number;
    staleCacheRejected: number;
    cacheHit: number;
    cacheMiss: number;
    cacheHitRatePct: number | null;
    fallbackRatePct: number | null;
    abnormalMarkBookDivergence: number;
  };
  thresholds: {
    abnormalFallbackRatePct: number;
    abnormalMarkBookDivergencePct: number;
  };
  lastFailure: { at: string; symbol: string; reason: string } | null;
  alerts: FuturesReferenceHealthAlert[];
  symbols: FuturesReferenceHealthSymbol[];
}

type MutableSymbol = {
  eligible: boolean | null;
  reference: FuturesReferenceDiagnosticSource;
  price: number | null;
  status: FuturesReferenceDiagnosticStatus;
  lastUpdatedAtMs: number | null;
  lastFailure: string | null;
  markBookDivergencePct: number | null;
};

const ABNORMAL_FALLBACK_RATE_PCT = 25;
const ABNORMAL_MARK_BOOK_DIVERGENCE_PCT = 0.5;

function canonicalSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function cleanReason(reason: unknown): string {
  return String(reason ?? "unknown USD-M reference failure").replace(/\s+/g, " ").slice(0, 220);
}

export class FuturesReferenceHealthTracker {
  private readonly nowMs: () => number;
  private readonly startedAtMs: number;
  private readonly diagnostics = new Map<string, MutableSymbol>();
  private usdMMarkUsed = 0;
  private bookFallback = 0;
  private positionRiskFallback = 0;
  private referenceUnavailable = 0;
  private scaleGuardRejected = 0;
  private staleCacheRejected = 0;
  private cacheHit = 0;
  private cacheMiss = 0;
  private abnormalMarkBookDivergence = 0;
  private latestFailure: { atMs: number; symbol: string; reason: string } | null = null;
  /** Expired entries are normal at a lower cache cadence; alert only until a fresh USD-M reference recovers them. */
  private readonly staleCacheAwaitingRecovery = new Set<string>();

  constructor(opts: { nowMs?: () => number } = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.startedAtMs = this.nowMs();
  }

  private entry(symbol: string): MutableSymbol {
    const canonical = canonicalSymbol(symbol);
    const existing = this.diagnostics.get(canonical);
    if (existing) return existing;
    const created: MutableSymbol = {
      eligible: null,
      reference: "NONE",
      price: null,
      status: "UNVERIFIED",
      lastUpdatedAtMs: null,
      lastFailure: null,
      markBookDivergencePct: null,
    };
    this.diagnostics.set(canonical, created);
    return created;
  }

  private fail(symbol: string, reason: unknown, atMs = this.nowMs()): void {
    const canonical = canonicalSymbol(symbol);
    const text = cleanReason(reason);
    const entry = this.entry(canonical);
    entry.lastFailure = text;
    entry.lastUpdatedAtMs = atMs;
    this.latestFailure = { atMs, symbol: canonical, reason: text };
  }

  recordCacheEvent(event: FuturesReferenceCacheEvent): void {
    const entry = this.entry(event.symbol);
    if (event.type === "CACHE_HIT") {
      this.cacheHit += 1;
      return;
    }
    if (event.type === "CACHE_MISS") {
      this.cacheMiss += 1;
      return;
    }
    if (event.type === "STALE_CACHE_REJECTED") {
      this.staleCacheRejected += 1;
      this.staleCacheAwaitingRecovery.add(canonicalSymbol(event.symbol));
      // A stale entry is deliberately discarded before the synchronous refresh below. It is an
      // audit counter, not a failure, unless no safe USD-M reference subsequently recovers it.
      entry.lastUpdatedAtMs = event.atMs;
      return;
    }
    if (event.type === "MARK_BOOK_DIVERGENCE") {
      entry.markBookDivergencePct = event.divergencePct;
      entry.lastUpdatedAtMs = event.atMs;
      if (event.abnormal) {
        this.abnormalMarkBookDivergence += 1;
        if (entry.status !== "UNAVAILABLE" && entry.status !== "NOT_ELIGIBLE") entry.status = "ALERT";
        this.fail(
          event.symbol,
          `USD-M mark/book divergence ${event.divergencePct.toFixed(3)}% exceeds ${ABNORMAL_MARK_BOOK_DIVERGENCE_PCT.toFixed(3)}%`,
          event.atMs,
        );
      }
      return;
    }
    this.fail(event.symbol, event.reason, event.atMs);
  }

  /** Actual exchangeInfo verdict: only active USD-M perpetual symbols are eligible. */
  recordEligibility(symbol: string, eligible: boolean | null, reason?: string): void {
    const entry = this.entry(symbol);
    entry.eligible = eligible;
    entry.lastUpdatedAtMs = this.nowMs();
    if (eligible === false) {
      entry.reference = "NONE";
      entry.price = null;
      entry.status = "NOT_ELIGIBLE";
      // An intentionally absent bare-spot alias (e.g. PEPEUSDT) is a healthy
      // eligibility verdict, not the panel's "Last Failure".
      if (reason) entry.lastFailure = cleanReason(reason);
    } else if (eligible === null) {
      entry.status = "UNVERIFIED";
      if (reason) this.fail(symbol, reason, entry.lastUpdatedAtMs);
    } else if (entry.status === "NOT_ELIGIBLE" || entry.status === "UNVERIFIED") {
      entry.status = "UNVERIFIED";
    }
  }

  private recordReference(reference: FuturesMarketReference, countAsSizingUse: boolean): void {
    const canonical = canonicalSymbol(reference.symbol);
    const entry = this.entry(canonical);
    entry.reference = reference.source;
    entry.price = finitePositive(reference.price) ? reference.price : null;
    entry.status = reference.source === "USD_M_MARK_PRICE" ? "HEALTHY" : "FALLBACK";
    entry.lastUpdatedAtMs = reference.atMs;
    entry.lastFailure = null;
    if (countAsSizingUse) {
      this.staleCacheAwaitingRecovery.delete(canonical);
      if (reference.source === "USD_M_MARK_PRICE") this.usdMMarkUsed += 1;
      else this.bookFallback += 1;
    }
  }

  /** Accepted by an actual sizing path. */
  recordReferenceUsed(reference: FuturesMarketReference): void {
    this.recordReference(reference, true);
  }

  /** Read-only mark/book probe updates the per-symbol diagnosis, never sizing counters. */
  recordReferenceObserved(reference: FuturesMarketReference): void {
    this.recordReference(reference, false);
  }

  /** positionRisk is allowed only as a same-environment, final USD-M fallback. */
  recordPositionRiskFallback(symbol: string, price: number): void {
    const canonical = canonicalSymbol(symbol);
    const entry = this.entry(canonical);
    entry.reference = "POSITION_RISK";
    entry.price = finitePositive(price) ? price : null;
    entry.status = "FALLBACK";
    entry.lastUpdatedAtMs = this.nowMs();
    entry.lastFailure = null;
    this.staleCacheAwaitingRecovery.delete(canonical);
    this.positionRiskFallback += 1;
  }

  /** Final failure only: no mark, no two-sided book, and no same-env positionRisk value. */
  recordReferenceUnavailable(symbol: string, reason: unknown): void {
    const entry = this.entry(symbol);
    if (entry.status !== "NOT_ELIGIBLE") entry.status = "UNAVAILABLE";
    entry.reference = "NONE";
    entry.price = null;
    this.referenceUnavailable += 1;
    this.fail(symbol, reason);
  }

  /** Guardrail rejects source/alias/scale data before it becomes a sizing reference. */
  recordScaleGuardRejected(symbol: string, reason: unknown): void {
    const entry = this.entry(symbol);
    entry.status = "SCALE_GUARD_REJECTED";
    entry.reference = "NONE";
    entry.price = null;
    this.scaleGuardRejected += 1;
    this.fail(symbol, reason);
  }

  /** Read-only comparison; neither value is substituted into a sizing decision here. */
  recordMarkBookComparison(symbol: string, markPrice: number, bookMid: number, atMs = this.nowMs()): void {
    if (!finitePositive(markPrice) || !finitePositive(bookMid)) return;
    const divergencePct = 100 * Math.abs(bookMid / markPrice - 1);
    this.recordCacheEvent({
      type: "MARK_BOOK_DIVERGENCE",
      symbol,
      atMs,
      markPrice,
      bookMid,
      divergencePct,
      abnormal: divergencePct >= ABNORMAL_MARK_BOOK_DIVERGENCE_PCT,
    });
  }

  snapshot(watchSymbols: string[] = []): FuturesReferenceHealthSnapshot {
    for (const symbol of watchSymbols) this.entry(symbol);
    const resolved = this.usdMMarkUsed + this.bookFallback + this.positionRiskFallback;
    const attempts = resolved + this.referenceUnavailable;
    const fallback = this.bookFallback + this.positionRiskFallback;
    const cacheAccesses = this.cacheHit + this.cacheMiss;
    const cacheHitRatePct = cacheAccesses > 0 ? (100 * this.cacheHit) / cacheAccesses : null;
    const fallbackRatePct = attempts > 0 ? (100 * fallback) / attempts : null;
    const alerts: FuturesReferenceHealthAlert[] = [];
    if (this.referenceUnavailable > 0) {
      alerts.push({
        code: "REFERENCE_UNAVAILABLE",
        severity: "BLOCK",
        message: `${this.referenceUnavailable} final USD-M reference lookup(s) failed closed.`,
      });
    }
    if (attempts >= 5 && fallbackRatePct !== null && fallbackRatePct >= ABNORMAL_FALLBACK_RATE_PCT) {
      alerts.push({
        code: "FALLBACK_RATE_ABNORMAL",
        severity: "WATCH",
        message: `Fallback rate ${fallbackRatePct.toFixed(1)}% exceeds ${ABNORMAL_FALLBACK_RATE_PCT}%.`,
      });
    }
    if (this.staleCacheAwaitingRecovery.size > 0) {
      alerts.push({
        code: "STALE_CACHE_INCREASING",
        severity: "WATCH",
        message: `${this.staleCacheRejected} stale cache entr${this.staleCacheRejected === 1 ? "y was" : "ies were"} rejected; ${this.staleCacheAwaitingRecovery.size} remain${this.staleCacheAwaitingRecovery.size === 1 ? "s" : ""} unrecovered by a verified USD-M reference.`,
      });
    }
    if (this.scaleGuardRejected > 0) {
      alerts.push({
        code: "SCALE_ANOMALY",
        severity: "BLOCK",
        message: `${this.scaleGuardRejected} source/alias scale value(s) were rejected before sizing.`,
      });
    }
    if (this.abnormalMarkBookDivergence > 0) {
      alerts.push({
        code: "MARK_BOOK_DIVERGENCE",
        severity: "WATCH",
        message: `${this.abnormalMarkBookDivergence} abnormal USD-M mark/book divergence observation(s).`,
      });
    }
    const symbols = Array.from(this.diagnostics.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, value]): FuturesReferenceHealthSymbol => ({
        symbol,
        eligible: value.eligible,
        reference: value.reference,
        price: value.price,
        status: value.status,
        lastUpdatedAt: value.lastUpdatedAtMs === null ? null : new Date(value.lastUpdatedAtMs).toISOString(),
        lastFailure: value.lastFailure,
        markBookDivergencePct: value.markBookDivergencePct,
      }));
    return {
      enabled: true,
      generatedAt: new Date(this.nowMs()).toISOString(),
      startedAt: new Date(this.startedAtMs).toISOString(),
      sourceChain: ["USD_M_MARK_PRICE", "USD_M_BOOK_TICKER", "POSITION_RISK", "FAIL_CLOSED"],
      counters: {
        usdMMarkUsed: this.usdMMarkUsed,
        bookFallback: this.bookFallback,
        positionRiskFallback: this.positionRiskFallback,
        referenceUnavailable: this.referenceUnavailable,
        scaleGuardRejected: this.scaleGuardRejected,
        staleCacheRejected: this.staleCacheRejected,
        cacheHit: this.cacheHit,
        cacheMiss: this.cacheMiss,
        cacheHitRatePct,
        fallbackRatePct,
        abnormalMarkBookDivergence: this.abnormalMarkBookDivergence,
      },
      thresholds: {
        abnormalFallbackRatePct: ABNORMAL_FALLBACK_RATE_PCT,
        abnormalMarkBookDivergencePct: ABNORMAL_MARK_BOOK_DIVERGENCE_PCT,
      },
      lastFailure: this.latestFailure
        ? {
            at: new Date(this.latestFailure.atMs).toISOString(),
            symbol: this.latestFailure.symbol,
            reason: this.latestFailure.reason,
          }
        : null,
      alerts,
      symbols,
    };
  }
}

/** Read-only observations for Astra, not an alpha selector or order admission gate. */
import type { BinanceFuturesPrivateClient, FuturesExecutionBookTicker, FuturesKline } from "./binance-futures-private.js";

type Client = Pick<BinanceFuturesPrivateClient, "getAstraTicker24h" | "getAstraPremiumIndexes" | "getAstraCommissionRate">;
type Observation<T> = { status: "AVAILABLE"; observedAt: number; value: T } |
  { status: "UNAVAILABLE"; observedAt: number; reason: string; value: null };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const rounded = (v: number) => Number(v.toFixed(4));

export function spreadBps(book: FuturesExecutionBookTicker | null): number | null {
  return book && positive(book.bid) && positive(book.ask) && book.ask >= book.bid
    ? rounded((book.ask - book.bid) / ((book.ask + book.bid) / 2) * 10000) : null;
}

export function applyExecutionBook<T extends { roundTripTakerFeeBps: number | null; funding: {
  status: string; nextFundingTime: number | null; nextSettlementCostBpsIfRateUnchanged: { LONG: number; SHORT: number } | null;
} }>(economics: T, book: FuturesExecutionBookTicker | null, now: number) {
  const bookFresh = book?.time != null && Math.abs(now - book.time) <= 30000;
  const spread = bookFresh ? spreadBps(book) : null;
  const settlementFuture = positive(economics.funding.nextFundingTime) && economics.funding.nextFundingTime > now;
  return { ...economics, bookTime: book?.time ?? null, bookFresh, spreadBps: spread,
    feeAndSpreadBps: economics.roundTripTakerFeeBps != null && spread != null ? rounded(economics.roundTripTakerFeeBps + spread) : null,
    funding: { ...economics.funding,
      status: settlementFuture ? economics.funding.status : "UNAVAILABLE",
      nextFundingTime: settlementFuture ? economics.funding.nextFundingTime : null,
      nextSettlementCostBpsIfRateUnchanged: settlementFuture ? economics.funding.nextSettlementCostBpsIfRateUnchanged : null } };
}

export function candleFeatures(candles: FuturesKline[], now: number) {
  const rows = candles.filter(c => c.closeTime < now && positive(c.close) && positive(c.high) && positive(c.low));
  const last = rows.at(-1);
  const contiguous = rows.every((r, i) => !i || r.openTime - rows[i - 1].openTime === 300000);
  const change = (bars: number) => contiguous && rows.length > bars
    ? rounded((last!.close / rows[rows.length - 1 - bars].close - 1) * 100) : null;
  const tr = rows.slice(-14).map((c, i, slice) => {
    const prev = i ? slice[i - 1].close : rows[rows.length - slice.length - 1]?.close;
    return Math.max(c.high - c.low, positive(prev) ? Math.abs(c.high - prev) : 0, positive(prev) ? Math.abs(c.low - prev) : 0);
  });
  return { closedBars: rows.length, lastCloseTime: last?.closeTime ?? null,
    candleAgeMs: last ? now - last.closeTime : null, contiguous5m: contiguous,
    change15mPct: change(3), change60mPct: change(12), change4hPct: change(48),
    meanTrueRange14Bps: last && contiguous && rows.length >= 15 ? rounded(tr.reduce((a,b) => a+b, 0) / 14 / last.close * 10000) : null,
    meaning: "Descriptive closed-candle changes and mean true range, not predicted returns or validated expectancy." };
}

export class AstraResearchContext {
  private cache = new Map<string, { until: number; result: Observation<unknown> }>();
  private pending = new Map<string, Promise<Observation<unknown>>>();
  constructor(private client: Client, private now: () => number) {}

  private async read<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<Observation<T>> {
    const old = this.cache.get(key);
    if (old && old.until > this.now()) return old.result as Observation<T>;
    const running = this.pending.get(key);
    if (running) return running as Promise<Observation<T>>;
    const work = (async (): Promise<Observation<T>> => {
      let result: Observation<T>;
      try { result = { status: "AVAILABLE", observedAt: this.now(), value: await fetcher() }; }
      catch { result = { status: "UNAVAILABLE", observedAt: this.now(), value: null, reason: "VENUE_READ_FAILED_OR_INVALID; no assumed zero or mainnet fallback" }; }
      // Timestamp when the response completed, not before time in the shared queue.
      result.observedAt = this.now();
      this.cache.set(key, { until: this.now() + (result.status === "AVAILABLE" ? ttl : 60000), result });
      return result;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }

  async overview(symbols: string[], books: Map<string, FuturesExecutionBookTicker>, unavailable: string[], equity: number,
    minimums: Map<string, { minNotional: number }>) {
    const tickers = await this.read("ticker24h", 120000, () => this.client.getAstraTicker24h());
    const bySymbol = new Map((tickers.value ?? []).map(t => [t.symbol, t]));
    const rows = symbols.map(symbol => {
      const t = bySymbol.get(symbol), book = books.get(symbol) ?? null;
      const freshTicker = !!t && positive(t.closeTime) && Math.abs(this.now() - t.closeTime) <= 300000;
      return { symbol, change24hPct: freshTicker && finite(t.priceChangePercent) ? rounded(t.priceChangePercent) : null,
        quoteVolume24h: freshTicker && finite(t.quoteVolume) && t.quoteVolume >= 0 ? rounded(t.quoteVolume) : null,
        range24hPct: freshTicker && positive(t.highPrice) && positive(t.lowPrice) && t.highPrice >= t.lowPrice
          ? rounded((t.highPrice / t.lowPrice - 1) * 100) : null,
        statsFresh: freshTicker, spreadBps: spreadBps(book),
        screenable: freshTicker && !unavailable.includes(symbol) && minimums.get(symbol)!.minNotional <= equity &&
          book?.time != null && Math.abs(this.now() - book.time) <= 30000 && spreadBps(book) != null };
    });
    const eligible = rows.filter(r => r.screenable);
    const top = (key: "change24hPct" | "quoteVolume24h", direction: number) => eligible.filter(r => finite(r[key]))
      .sort((a,b) => direction * (a[key]! - b[key]!) || a.symbol.localeCompare(b.symbol)).slice(0, 12).map(r => r.symbol);
    return { rows, screening: { source: "BINANCE_USDM_TESTNET_24H", status: tickers.status, observedAt: tickers.observedAt,
      universeCount: symbols.length, withFreshStatistics: rows.filter(r => r.statsFresh).length,
      screenableCount: eligible.length, strongest24h: top("change24hPct", -1), weakest24h: top("change24hPct", 1),
      highestQuoteVolume24h: top("quoteVolume24h", -1),
      meaning: "Attention aids only, not long/short signals or an allowlist. All universe contracts remain selectable. Minimum/ownership/book screening is provisional; entry rechecks exact quantity and fresh BBO. 24h volume is activity, not guaranteed execution depth." } };
  }

  async economics(symbol: string, book: FuturesExecutionBookTicker | null) {
    const [commission, premium] = await Promise.all([
      this.read("fee:" + symbol, 900000, () => this.client.getAstraCommissionRate(symbol)),
      this.read("premium", 60000, () => this.client.getAstraPremiumIndexes()),
    ]);
    const p = premium.value?.find(row => row.symbol === symbol);
    const fundingFresh = p != null && positive(p.time) && Math.abs(this.now() - p.time) <= 120000 && positive(p.nextFundingTime) && p.nextFundingTime > this.now();
    const fee = commission.value;
    const spread = spreadBps(book);
    const roundTripFeeBps = fee ? rounded(fee.takerCommissionRate * 2 * 10000) : null;
    const rate = fundingFresh && finite(p.lastFundingRate) ? p.lastFundingRate : null;
    return applyExecutionBook({ commission: { status: commission.status, observedAt: commission.observedAt, source: "TESTNET_ACCOUNT_SYMBOL_COMMISSION_RATE",
        makerRate: fee?.makerCommissionRate ?? null, takerRate: fee?.takerCommissionRate ?? null },
      executionAssumption: "Taker entry + taker exit; bounded IOC does not justify maker discounts. Exit notional can differ from entry.",
      spreadBps: spread, bookTime: book?.time ?? null, roundTripTakerFeeBps: roundTripFeeBps,
      feeAndSpreadBps: roundTripFeeBps != null && spread != null ? rounded(roundTripFeeBps + spread) : null,
      funding: { status: rate != null ? "INDICATIVE" : "UNAVAILABLE", observedAt: premium.observedAt,
        exchangeTime: p?.time ?? null, lastFundingRate: rate, nextFundingTime: fundingFresh ? p.nextFundingTime : null,
        markPrice: fundingFresh ? p.markPrice : null, indexPrice: fundingFresh ? p.indexPrice : null,
        nextSettlementCostBpsIfRateUnchanged: rate != null ? { LONG: rounded(rate * 10000), SHORT: rounded(-rate * 10000) } : null },
      calculation: "Cost USD = notional * bps / 10000. Add chosen entry+exit slippage buffers and funding settlements crossed by the hold. Positive funding cost is paid; negative is received. Current funding is indicative, not a guaranteed future charge; do not make a trade depend on receiving it. feeAndSpreadBps is a baseline, NOT all-in cost or an expected return." }, book, this.now());
  }
}

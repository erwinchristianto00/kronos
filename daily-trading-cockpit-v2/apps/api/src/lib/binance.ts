import type { Candle } from "@dtc/shared";

const BINANCE_BASE_URL = "https://api.binance.com";
export const BINANCE_SPOT_BASE_URLS = [BINANCE_BASE_URL, "https://api-gcp.binance.com"] as const;
const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";
// Matches FETCH_TIMEOUT_MS in external-candidate-metadata-fetcher.ts — survives cold TLS handshakes
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RETRIES = 2;
const DEFAULT_KLINE_CACHE_TTL_MS = 30_000;

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

interface BinanceTicker24h {
  symbol: string;
  volume: string;
  quoteVolume: string;
}

interface BinanceBookTicker {
  symbol: string;
  bidPrice: string;
  bidQty?: string;
  askPrice: string;
  askQty?: string;
  time?: number;
}

interface BinanceDepthPayload {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

interface BinanceOpenInterestPayload {
  openInterest: string;
  symbol: string;
  time?: number;
}

interface BinancePremiumIndexPayload {
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface BinanceAggTradePayload {
  p: string;
  q: string;
  T: number;
  m: boolean;
}

interface BinanceFundingRate {
  fundingRate: string;
  fundingTime: number;
}

interface BinanceOpenInterestStat {
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

interface BinanceTakerRatio {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

interface BinanceLongShortRatio {
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

// Same payload shape as BinanceLongShortRatio; Binance's top-trader endpoints
// (topLongShortPositionRatio, topLongShortAccountRatio) return identical fields.
type BinanceTopTraderRatio = BinanceLongShortRatio;

export interface Ticker24hSnapshot {
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
}

export interface BookTickerSnapshot {
  bid: number | null;
  ask: number | null;
  absolute: number | null;
  percent: number | null;
}

export interface FuturesFlowSnapshot {
  fundingRate: number | null;
  openInterestChangePercent: number | null;
  takerBuySellRatio: number | null;
  longShortRatio: number | null;
}

// Separate from FuturesFlowSnapshot on purpose: FuturesFlowSnapshot already flows into
// whale.ts's generic Object.values(...).some(...) "hasRealData" availability check, which
// feeds live candidate scoring. Keeping the new top-trader fields on their own snapshot type
// means this addition can never change that (or any other) existing decision path's behavior.
export interface FuturesTopTraderRatioSnapshot {
  topTraderPositionRatio: number | null;
  topTraderAccountRatio: number | null;
}

export interface FuturesBookTickerSnapshot {
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  time?: number | null;
}

export interface FuturesPremiumIndexSnapshot {
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  basis: number | null;
  basisPct: number | null;
}

export interface FuturesAggTradeSnapshot {
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
  timestamp: number;
}

export type BinanceFailureType = "timeout" | "429" | "network" | "invalid_response" | "unsupported";
type FetchSourceMode = "LIVE" | "CACHE_FRESH";

interface CacheEntry<T> {
  cachedAt: number;
  value: T;
}

interface SymbolFetchSummary {
  mode: FetchSourceMode;
  stages: Record<string, FetchSourceMode>;
  providerWaitMs: number;
  binanceRetryMs: number;
  stageTimings: Record<string, { providerWaitMs: number; binanceRetryMs: number; requestCount: number; cacheHitCount: number }>;
}

export class BinanceRequestError extends Error {
  constructor(
    readonly failureType: BinanceFailureType,
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "BinanceRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Report-only derived metric (Tier 1 item 3): futures mark price vs spot-weighted
// index price. Positive basis ⇒ futures trading at a premium to index (bullish
// crowding); negative ⇒ discount. Not wired into any decision path — data collection only.
export function computeBasis(markPrice: number | null, indexPrice: number | null): { basis: number | null; basisPct: number | null } {
  if (markPrice === null || indexPrice === null) {
    return { basis: null, basisPct: null };
  }
  const basis = markPrice - indexPrice;
  const basisPct = indexPrice !== 0 ? (basis / indexPrice) * 100 : null;
  return { basis, basisPct };
}

function isRetryable(error: BinanceRequestError): boolean {
  return error.failureType === "timeout" || error.failureType === "429" || error.failureType === "network";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intervalMs(interval: string | undefined): number | null {
  if (!interval) return null;
  const match = interval.match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "d") return amount * 24 * 60 * 60_000;
  return null;
}

export class BinanceClient {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly symbolFetchSummary = new Map<string, SymbolFetchSummary>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = BINANCE_BASE_URL,
  ) {}

  resetFetchSummary(): void {
    this.symbolFetchSummary.clear();
  }

  getSymbolFetchSummary(symbol: string): SymbolFetchSummary {
    return this.symbolFetchSummary.get(symbol) ?? { mode: "LIVE", stages: {}, providerWaitMs: 0, binanceRetryMs: 0, stageTimings: {} };
  }

  private updateSymbolFetchSummary(symbol: string, stage: string, mode: FetchSourceMode): void {
    const current = this.getSymbolFetchSummary(symbol);
    current.stages[stage] = mode;
    if (mode === "CACHE_FRESH") {
      current.mode = "CACHE_FRESH";
    }
    this.symbolFetchSummary.set(symbol, current);
  }

  private recordSymbolFetchTiming(
    symbol: string,
    stage: string,
    values: { providerWaitMs?: number; binanceRetryMs?: number; requestCount?: number; cacheHitCount?: number },
  ): void {
    const current = this.getSymbolFetchSummary(symbol);
    const stageTiming = current.stageTimings[stage] ?? { providerWaitMs: 0, binanceRetryMs: 0, requestCount: 0, cacheHitCount: 0 };
    const providerWaitMs = Math.max(0, Math.round(values.providerWaitMs ?? 0));
    const binanceRetryMs = Math.max(0, Math.round(values.binanceRetryMs ?? 0));
    stageTiming.providerWaitMs += providerWaitMs;
    stageTiming.binanceRetryMs += binanceRetryMs;
    stageTiming.requestCount += values.requestCount ?? 0;
    stageTiming.cacheHitCount += values.cacheHitCount ?? 0;
    current.providerWaitMs += providerWaitMs;
    current.binanceRetryMs += binanceRetryMs;
    current.stageTimings[stage] = stageTiming;
    this.symbolFetchSummary.set(symbol, current);
  }

  private getCacheIdentityParams(path: string, params: Record<string, string>): Record<string, string> {
    if (path !== "/api/v3/klines") return params;
    const ms = intervalMs(params.interval);
    if (!ms) return params;
    const anchor = params.endTime ? Number(params.endTime) : Date.now();
    if (!Number.isFinite(anchor)) return params;
    return { ...params, cacheLatestOpenTime: String(Math.floor(anchor / ms) * ms) };
  }

  private getCacheKey(baseUrl: string, path: string, params: Record<string, string>): string {
    const url = new URL(path, baseUrl);
    Object.entries(this.getCacheIdentityParams(path, params)).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
  }

  private getSpotRequestBaseUrls(baseUrl: string): readonly string[] {
    return baseUrl === BINANCE_BASE_URL ? BINANCE_SPOT_BASE_URLS : [baseUrl];
  }

  private getCacheTtlMs(path: string, params: Record<string, string>): number {
    if (path === "/api/v3/klines") {
      return positiveEnvInt(process.env.SCAN_CANDLE_CACHE_TTL_MS, DEFAULT_KLINE_CACHE_TTL_MS);
    }
    if (path === "/api/v3/ticker/24hr") {
      return 60 * 1000;
    }
    if (path === "/api/v3/ticker/bookTicker") {
      return 20 * 1000;
    }
    if (path === "/fapi/v1/ticker/bookTicker") {
      return 10 * 1000;
    }
    if (path === "/fapi/v1/depth") {
      return 10 * 1000;
    }
    if (path === "/fapi/v1/openInterest") {
      return 30 * 1000;
    }
    if (path === "/fapi/v1/premiumIndex") {
      return 30 * 1000;
    }
    return 0;
  }

  private getFreshCache<T>(cacheKey: string, ttlMs: number): T | null {
    if (ttlMs <= 0) {
      return null;
    }
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.cachedAt > ttlMs) {
      return null;
    }
    return cached.value as T;
  }

  private setCache<T>(cacheKey: string, value: T): void {
    this.cache.set(cacheKey, {
      cachedAt: Date.now(),
      value,
    });
  }

  private async fetchWithTimeout(url: URL, stage: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new BinanceRequestError("timeout", stage, `timeout: Binance request timed out for ${url.host}${url.pathname}`);
      }
      throw new BinanceRequestError("network", stage, `network: Binance request failed for ${url.host}${url.pathname}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getJson<T>(
    symbol: string,
    stage: string,
    path: string,
    params: Record<string, string>,
    baseUrl = this.baseUrl,
    useCache = false,
  ): Promise<T> {
    const requestBaseUrls = this.getSpotRequestBaseUrls(baseUrl);
    const ttlMs = useCache ? this.getCacheTtlMs(path, params) : 0;
    const readThroughCache = useCache && path === "/api/v3/klines";

    let lastError: BinanceRequestError | null = null;

    if (readThroughCache) {
      for (const requestBaseUrl of requestBaseUrls) {
        const cacheKey = this.getCacheKey(requestBaseUrl, path, params);
        const cached = this.getFreshCache<T>(cacheKey, ttlMs);
        if (cached !== null) {
          this.updateSymbolFetchSummary(symbol, stage, "CACHE_FRESH");
          this.recordSymbolFetchTiming(symbol, stage, { cacheHitCount: 1 });
          return cached;
        }
      }
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      for (const requestBaseUrl of requestBaseUrls) {
        const url = new URL(path, requestBaseUrl);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
        const cacheKey = this.getCacheKey(requestBaseUrl, path, params);
        try {
          const providerStartedMs = Date.now();
          const response = await this.fetchWithTimeout(url, stage);
          this.recordSymbolFetchTiming(symbol, stage, { providerWaitMs: Date.now() - providerStartedMs, requestCount: 1 });
          if (!response.ok) {
            if (response.status === 429) {
              throw new BinanceRequestError("429", stage, `429: Binance rate limited ${symbol} on ${stage}`);
            }
            if (response.status === 400 || response.status === 404 || response.status === 451) {
              throw new BinanceRequestError("unsupported", stage, `unsupported: Binance returned ${response.status} for ${symbol} on ${stage}`);
            }
            throw new BinanceRequestError("network", stage, `network: Binance returned ${response.status} for ${symbol} on ${stage}`);
          }

          const payload = (await response.json()) as T;
          this.updateSymbolFetchSummary(symbol, stage, "LIVE");
          if (useCache) {
            this.setCache(cacheKey, payload);
          }
          return payload;
        } catch (error) {
          if (!(error instanceof BinanceRequestError && error.failureType === "timeout")) {
            this.recordSymbolFetchTiming(symbol, stage, { requestCount: 1 });
          }
          lastError =
            error instanceof BinanceRequestError
              ? error
              : new BinanceRequestError("invalid_response", stage, `invalid_response: Binance parsing failed for ${symbol} on ${stage}`);

          if (!isRetryable(lastError)) {
            break;
          }
        }
      }
      if (!lastError || !isRetryable(lastError) || attempt === MAX_RETRIES) {
        break;
      }
      const retryDelayMs = 150 * (attempt + 1);
      this.recordSymbolFetchTiming(symbol, stage, { binanceRetryMs: retryDelayMs });
      await delay(retryDelayMs);
    }

    for (const requestBaseUrl of requestBaseUrls) {
      const cacheKey = this.getCacheKey(requestBaseUrl, path, params);
      const fallback = this.getFreshCache<T>(cacheKey, ttlMs);
      if (fallback !== null) {
        this.updateSymbolFetchSummary(symbol, stage, "CACHE_FRESH");
        this.recordSymbolFetchTiming(symbol, stage, { cacheHitCount: 1 });
        return fallback;
      }
    }

    throw lastError ?? new BinanceRequestError("network", stage, `network: Binance request failed for ${symbol} on ${stage}`);
  }

  async getCandles(symbol: string, interval: string, limit: number, options?: { startTime?: number; endTime?: number }): Promise<Candle[]> {
    const payload = await this.getJson<BinanceKline[]>(
      symbol,
      `candles_${interval}`,
      "/api/v3/klines",
      {
        symbol,
        interval,
        limit: String(limit),
        ...(options?.startTime ? { startTime: String(options.startTime) } : {}),
        ...(options?.endTime ? { endTime: String(options.endTime) } : {}),
      },
      this.baseUrl,
      true,
    );

    if (!Array.isArray(payload) || payload.some((entry) => !Array.isArray(entry) || entry.length < 6)) {
      throw new BinanceRequestError("invalid_response", `candles_${interval}`, `invalid_response: Binance klines were malformed for ${symbol} ${interval}`);
    }

    return payload.map((entry) => ({
      openTime: entry[0],
      open: Number(entry[1]),
      high: Number(entry[2]),
      low: Number(entry[3]),
      close: Number(entry[4]),
      volume: Number(entry[5]),
    }));
  }

  async getTicker24h(symbol: string): Promise<Ticker24hSnapshot> {
    const payload = await this.getJson<BinanceTicker24h>(
      symbol,
      "ticker_24h",
      "/api/v3/ticker/24hr",
      { symbol },
      this.baseUrl,
      true,
    );
    if (!isRecord(payload)) {
      throw new BinanceRequestError("invalid_response", "ticker_24h", `invalid_response: Binance 24h ticker was malformed for ${symbol}`);
    }
    return {
      baseVolume24h: Number.isFinite(Number(payload.volume)) ? Number(payload.volume) : null,
      quoteVolume24h: Number.isFinite(Number(payload.quoteVolume)) ? Number(payload.quoteVolume) : null,
    };
  }

  async getBookTicker(symbol: string): Promise<BookTickerSnapshot> {
    const payload = await this.getJson<BinanceBookTicker>(
      symbol,
      "book_ticker",
      "/api/v3/ticker/bookTicker",
      { symbol },
      this.baseUrl,
      true,
    );
    if (!isRecord(payload)) {
      throw new BinanceRequestError("invalid_response", "book_ticker", `invalid_response: Binance book ticker was malformed for ${symbol}`);
    }
    const bid = Number(payload.bidPrice);
    const ask = Number(payload.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new BinanceRequestError("invalid_response", "book_ticker", `invalid_response: Binance bid/ask were invalid for ${symbol}`);
    }
    const mid = (bid + ask) / 2 || 1;
    const absolute = Math.max(ask - bid, 0);

    return {
      bid,
      ask,
      absolute,
      percent: Number((((absolute / mid) * 100) || 0).toFixed(4)),
    };
  }

  async getFuturesBookTicker(symbol: string): Promise<FuturesBookTickerSnapshot> {
    const payload = await this.getJson<BinanceBookTicker>(
      symbol,
      "futures_book_ticker",
      "/fapi/v1/ticker/bookTicker",
      { symbol },
      BINANCE_FUTURES_BASE_URL,
      true,
    );
    if (!isRecord(payload)) {
      throw new BinanceRequestError("invalid_response", "futures_book_ticker", `invalid_response: Binance futures book ticker was malformed for ${symbol}`);
    }
    const bid = finiteNumber(payload.bidPrice);
    const ask = finiteNumber(payload.askPrice);
    if (bid === null || ask === null) {
      throw new BinanceRequestError("invalid_response", "futures_book_ticker", `invalid_response: Binance futures bid/ask were invalid for ${symbol}`);
    }
    return {
      bid,
      ask,
      bidQty: finiteNumber(payload.bidQty),
      askQty: finiteNumber(payload.askQty),
      time: finiteNumber(payload.time),
    };
  }

  async getBookTickerWithQty(symbol: string): Promise<FuturesBookTickerSnapshot> {
    return this.getFuturesBookTicker(symbol);
  }

  async getFuturesDepth(symbol: string, limit = 5): Promise<BinanceDepthPayload> {
    const payload = await this.getJson<BinanceDepthPayload>(
      symbol,
      "futures_depth",
      "/fapi/v1/depth",
      { symbol, limit: String(limit) },
      BINANCE_FUTURES_BASE_URL,
      true,
    );
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.bids) ||
      !Array.isArray(payload.asks)
    ) {
      throw new BinanceRequestError("invalid_response", "futures_depth", `invalid_response: Binance futures depth was malformed for ${symbol}`);
    }
    return {
      bids: payload.bids,
      asks: payload.asks,
    };
  }

  async getDepth(symbol: string, limit = 5): Promise<BinanceDepthPayload> {
    return this.getFuturesDepth(symbol, limit);
  }

  async getFuturesOpenInterest(symbol: string): Promise<{ openInterest: number | null }> {
    const payload = await this.getJson<BinanceOpenInterestPayload>(
      symbol,
      "futures_open_interest_current",
      "/fapi/v1/openInterest",
      { symbol },
      BINANCE_FUTURES_BASE_URL,
      true,
    );
    if (!isRecord(payload)) {
      throw new BinanceRequestError("invalid_response", "futures_open_interest_current", `invalid_response: Binance futures open interest was malformed for ${symbol}`);
    }
    return {
      openInterest: finiteNumber(payload.openInterest),
    };
  }

  async getOpenInterest(symbol: string): Promise<{ openInterest: number | null }> {
    return this.getFuturesOpenInterest(symbol);
  }

  async getFuturesPremiumIndex(symbol: string): Promise<FuturesPremiumIndexSnapshot> {
    const payload = await this.getJson<BinancePremiumIndexPayload>(
      symbol,
      "futures_premium_index",
      "/fapi/v1/premiumIndex",
      { symbol },
      BINANCE_FUTURES_BASE_URL,
      true,
    );
    if (!isRecord(payload)) {
      throw new BinanceRequestError("invalid_response", "futures_premium_index", `invalid_response: Binance futures premium index was malformed for ${symbol}`);
    }
    const markPrice = finiteNumber(payload.markPrice);
    const indexPrice = finiteNumber(payload.indexPrice);
    const { basis, basisPct } = computeBasis(markPrice, indexPrice);
    return {
      markPrice,
      indexPrice,
      fundingRate: finiteNumber(payload.lastFundingRate),
      nextFundingTime: finiteNumber(payload.nextFundingTime),
      basis,
      basisPct,
    };
  }

  async getPremiumIndex(symbol: string): Promise<{ fundingRate: number | null; nextFundingTime: number | null }> {
    const payload = await this.getFuturesPremiumIndex(symbol);
    return {
      fundingRate: payload.fundingRate,
      nextFundingTime: payload.nextFundingTime,
    };
  }

  async getFuturesAggTrades(
    symbol: string,
    opts?: { startTime?: number; endTime?: number; limit?: number },
  ): Promise<FuturesAggTradeSnapshot[]> {
    const payload = await this.getJson<BinanceAggTradePayload[]>(
      symbol,
      "futures_agg_trades",
      "/fapi/v1/aggTrades",
      {
        symbol,
        limit: String(opts?.limit ?? 100),
        ...(opts?.startTime ? { startTime: String(opts.startTime) } : {}),
        ...(opts?.endTime ? { endTime: String(opts.endTime) } : {}),
      },
      BINANCE_FUTURES_BASE_URL,
      false,
    );
    if (!Array.isArray(payload)) {
      throw new BinanceRequestError("invalid_response", "futures_agg_trades", `invalid_response: Binance futures agg trades were malformed for ${symbol}`);
    }
    return payload
      .map((trade) => ({
        price: finiteNumber(trade.p),
        quantity: finiteNumber(trade.q),
        isBuyerMaker: Boolean(trade.m),
        timestamp: finiteNumber(trade.T),
      }))
      .filter((trade): trade is FuturesAggTradeSnapshot =>
        trade.price !== null &&
        trade.quantity !== null &&
        trade.timestamp !== null,
      );
  }

  async getAggTrades(
    symbol: string,
    opts: { startTime: number; endTime: number; limit: number },
  ): Promise<Array<{ price: number; quantity: number; isBuyerMaker: boolean }>> {
    return this.getFuturesAggTrades(symbol, opts);
  }

  async getFuturesFlow(symbol: string): Promise<FuturesFlowSnapshot> {
    const [fundingPayload, openInterestPayload, takerPayload, longShortPayload] = await Promise.all([
      this.getJson<BinanceFundingRate[]>(symbol, "futures_funding", "/fapi/v1/fundingRate", { symbol, limit: "2" }, BINANCE_FUTURES_BASE_URL),
      this.getJson<BinanceOpenInterestStat[]>(symbol, "futures_open_interest", "/futures/data/openInterestHist", { symbol, period: "5m", limit: "2" }, BINANCE_FUTURES_BASE_URL),
      this.getJson<BinanceTakerRatio[]>(symbol, "futures_taker_ratio", "/futures/data/takerlongshortRatio", { symbol, period: "5m", limit: "2" }, BINANCE_FUTURES_BASE_URL),
      this.getJson<BinanceLongShortRatio[]>(symbol, "futures_long_short", "/futures/data/globalLongShortAccountRatio", { symbol, period: "5m", limit: "2" }, BINANCE_FUTURES_BASE_URL),
    ]);

    const latestFunding = fundingPayload.at(-1);
    const latestOi = openInterestPayload.at(-1);
    const previousOi = openInterestPayload.at(-2);
    const latestTaker = takerPayload.at(-1);
    const latestLongShort = longShortPayload.at(-1);

    const latestOiValue = latestOi ? Number(latestOi.sumOpenInterestValue) : NaN;
    const previousOiValue = previousOi ? Number(previousOi.sumOpenInterestValue) : NaN;

    return {
      fundingRate: latestFunding ? Number(latestFunding.fundingRate) : null,
      openInterestChangePercent:
        Number.isFinite(latestOiValue) && Number.isFinite(previousOiValue) && previousOiValue !== 0
          ? Number((((latestOiValue - previousOiValue) / previousOiValue) * 100).toFixed(4))
          : null,
      takerBuySellRatio: latestTaker ? Number(latestTaker.buySellRatio) : null,
      longShortRatio: latestLongShort ? Number(latestLongShort.longShortRatio) : null,
    };
  }

  // Tier 1 item 3 (top-trader ratio): report-only data collection, deliberately kept
  // separate from getFuturesFlow()/FuturesFlowSnapshot — see FuturesTopTraderRatioSnapshot
  // comment above for why. Same getJson/plumbing/period/limit convention as getFuturesFlow.
  async getFuturesTopTraderRatio(symbol: string): Promise<FuturesTopTraderRatioSnapshot> {
    const [topTraderPositionPayload, topTraderAccountPayload] = await Promise.all([
      this.getJson<BinanceTopTraderRatio[]>(symbol, "futures_top_trader_position_ratio", "/futures/data/topLongShortPositionRatio", { symbol, period: "5m", limit: "2" }, BINANCE_FUTURES_BASE_URL),
      this.getJson<BinanceTopTraderRatio[]>(symbol, "futures_top_trader_account_ratio", "/futures/data/topLongShortAccountRatio", { symbol, period: "5m", limit: "2" }, BINANCE_FUTURES_BASE_URL),
    ]);

    const latestPosition = topTraderPositionPayload.at(-1);
    const latestAccount = topTraderAccountPayload.at(-1);

    return {
      topTraderPositionRatio: latestPosition ? Number(latestPosition.longShortRatio) : null,
      topTraderAccountRatio: latestAccount ? Number(latestAccount.longShortRatio) : null,
    };
  }
}

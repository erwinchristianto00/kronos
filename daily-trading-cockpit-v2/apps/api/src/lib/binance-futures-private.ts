/**
 * BINANCE USD-M FUTURES PRIVATE CLIENT (signed REST)
 *
 * The ONLY module that talks to Binance private endpoints. Used exclusively by the
 * live-execution engine (live-execution-engine.ts), which is dormant unless
 * LIVE_EXECUTION_ENABLED=1. Design rules:
 *
 *  - Keys come ONLY from the constructor (engine reads them from env). They are never
 *    logged, never echoed into errors, never persisted to any store.
 *  - testnet/mainnet is an explicit constructor choice (resolveLiveBinanceBaseUrl).
 *  - Server-time sync with a hard clock-skew guard: signed requests REFUSE to fire when
 *    |local+offset − server| was measured beyond MAX_CLOCK_SKEW_MS at last sync.
 *  - GET requests retry on timeout/429/network (idempotent). Order-mutating requests
 *    (POST/DELETE) NEVER auto-retry — double-submit is worse than a missed attempt; the
 *    engine passes newClientOrderId so a retry-by-engine is exchange-side idempotent.
 *  - This module performs NO strategy logic and NO sizing. It is a transport.
 */

import { createHmac } from "node:crypto";

// ─── env / base urls ─────────────────────────────────────────────────────────

export type LiveBinanceEnv = "testnet" | "mainnet";

const BASE_URLS: Record<LiveBinanceEnv, string> = {
  testnet: "https://testnet.binancefuture.com",
  mainnet: "https://fapi.binance.com",
};

export function resolveLiveBinanceEnv(raw: string | undefined): LiveBinanceEnv | null {
  if (raw === "testnet" || raw === "mainnet") return raw;
  return null;
}

export function resolveLiveBinanceBaseUrl(env: LiveBinanceEnv): string {
  return BASE_URLS[env];
}

// ─── constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 6_000;
const RECV_WINDOW_MS = 5_000;
// Guard stays below RECV_WINDOW_MS so offset-compensated timestamps still land inside Binance's window.
export const MAX_CLOCK_SKEW_MS = 4_000;
const GET_MAX_RETRIES = 2;
// Sync every 60 s so the offset stays fresh even on hosts with fast clock drift.
const TIME_SYNC_TTL_MS = 60_000;
// Re-fetch exchange filters (tickSize/stepSize/minQty/minNotional) periodically instead of caching
// them for the process lifetime. Binance occasionally updates a symbol's LOT_SIZE/PRICE_FILTER/
// MIN_NOTIONAL specs; without a TTL, a long-running process (days between restarts) would keep
// rounding orders to stale specs for that symbol until Binance rejects them. Fails safe either way
// (a stale filter causes an order rejection, not a silent wrong-size fill) — this just shrinks the
// window instead of leaving it open for the whole process lifetime.
const EXCHANGE_FILTERS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// ─── errors ──────────────────────────────────────────────────────────────────

export type LiveRequestFailureType =
  | "timeout"
  | "429"
  | "network"
  | "http_error"
  | "binance_error"
  | "invalid_response"
  | "clock_skew";

export class BinanceFuturesPrivateError extends Error {
  readonly failureType: LiveRequestFailureType;
  readonly httpStatus: number | null;
  /** Binance error code (e.g. -2019 margin insufficient), when present. */
  readonly binanceCode: number | null;

  constructor(
    failureType: LiveRequestFailureType,
    message: string,
    opts: { httpStatus?: number | null; binanceCode?: number | null } = {},
  ) {
    super(message);
    this.name = "BinanceFuturesPrivateError";
    this.failureType = failureType;
    this.httpStatus = opts.httpStatus ?? null;
    this.binanceCode = opts.binanceCode ?? null;
  }
}

const RETRYABLE_GET_FAILURES: ReadonlySet<LiveRequestFailureType> = new Set([
  "timeout",
  "429",
  "network",
]);

// ─── public shapes ───────────────────────────────────────────────────────────

export interface FuturesSymbolFilters {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export interface FuturesBalance {
  asset: string;
  balance: number;
  availableBalance: number;
}

export interface FuturesPosition {
  symbol: string;
  positionAmt: number; // signed: >0 long, <0 short
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unRealizedProfit: number;
  leverage: number;
  marginType: string;
}

export interface FuturesOrder {
  symbol: string;
  /** String, not number: Binance order IDs can exceed Number.MAX_SAFE_INTEGER (2^53-1) — a plain
   *  JS number silently loses precision for these, making the id permanently unrecoverable (a real
   *  incident: 2 live ETHUSDT positions' entryOrderId got rounded, so queryOrder(symbol, orderId)
   *  on that rounded value returned -2013 "order does not exist" hours later during reconciliation).
   *  See preserveOrderIdPrecision below for where this is protected at the JSON-parse boundary. */
  orderId: string;
  clientOrderId: string;
  status: string; // NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED | REJECTED
  type: string;
  side: "BUY" | "SELL";
  reduceOnly: boolean;
  price: number;
  stopPrice: number;
  origQty: number;
  executedQty: number;
  avgPrice: number;
  updateTime: number;
}

export interface FillPriceResolution {
  price: number;
  confirmed: boolean;
}

/**
 * A MARKET order's synchronous placeOrder response can come back with avgPrice=0 / status not
 * yet FILLED even though the order fills moments later — confirmed for real on testnet (a
 * cross-sectional executor basket where all 6 legs' placeOrder responses returned avgPrice=0, yet
 * queryOrder afterward showed status=FILLED with real, non-zero avgPrice for every one). Trusting
 * avgPrice=0 as "the fallback price is what actually happened" fabricates a fake result — for a
 * position's entry fill specifically, it can also re-derive stop/TP geometry from a stale
 * pre-trade reference price instead of the real fill, which is the exact failure mode that once
 * churned a symbol's stop placement 258× (Binance -2021 "would immediately trigger") because the
 * stop landed on the wrong side of where the position actually filled.
 *
 * Confirms via queryOrder before ever falling back, and when confirmation genuinely can't be
 * obtained, says so via `confirmed: false` instead of silently pretending the fallback is real.
 */
export async function resolveConfirmedFillPrice(
  client: Pick<BinanceFuturesPrivateClient, "queryOrder">,
  symbol: string,
  orderId: string,
  initialAvgPrice: number,
  fallbackPrice: number,
  opts: {
    retries?: number;
    retryDelayMs?: number;
    onUnconfirmed?: (symbol: string, orderId: string, fallbackPrice: number) => void;
  } = {},
): Promise<FillPriceResolution> {
  if (initialAvgPrice > 0) return { price: initialAvgPrice, confirmed: true };
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 400;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const queried = await client.queryOrder(symbol, orderId);
      if (queried.avgPrice > 0) return { price: queried.avgPrice, confirmed: true };
      if (queried.status !== "NEW" && queried.status !== "PARTIALLY_FILLED") break; // terminal, non-fillable
    } catch {
      // best-effort — fall through to the next attempt / final fallback
    }
  }
  if (opts.onUnconfirmed) {
    opts.onUnconfirmed(symbol, orderId, fallbackPrice);
  } else {
    console.error(
      `[binance-futures-private] UNCONFIRMED FILL PRICE: ${symbol} order ${orderId} never returned a ` +
        `real avgPrice after retries — recording ${fallbackPrice} as a fallback, but this is NOT a ` +
        `confirmed fill price.`,
    );
  }
  return { price: fallbackPrice, confirmed: false };
}

export interface FuturesAlgoOrder {
  symbol: string;
  /** String, not number — see FuturesOrder.orderId's doc comment. */
  algoId: string;
  clientAlgoId: string;
  algoStatus: string;
  orderType: string;
  side: "BUY" | "SELL";
  quantity: number;
  triggerPrice: number;
  actualOrderId: string | null;
}

export interface FuturesUserTrade {
  symbol: string;
  /** String, not number — see FuturesOrder.orderId's doc comment. */
  orderId: string;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number; // LIMIT
  stopPrice?: number; // STOP_MARKET / TAKE_PROFIT_MARKET
  reduceOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
  /** Engine-supplied idempotency key (derived from the paper order id). */
  newClientOrderId?: string;
  workingType?: "CONTRACT_PRICE" | "MARK_PRICE";
}

export interface PlaceAlgoOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  triggerPrice: number;
  reduceOnly?: boolean;
  clientAlgoId?: string;
  workingType?: "CONTRACT_PRICE" | "MARK_PRICE";
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toNum(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** For order/algo IDs specifically — NEVER route these through toNum, which would re-introduce the
 *  exact precision loss preserveOrderIdPrecision protects against. Accepts a string (the normal
 *  post-fix path) or, defensively, a number (e.g. a hand-built test fixture) — stringifies without
 *  re-parsing as a float. */
function toStrId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Guards against JavaScript's silent integer-precision loss for Binance's order/algo IDs, which
 * can exceed Number.MAX_SAFE_INTEGER (2^53-1 ≈ 9.007e15) — real incident: two live ETHUSDT
 * entryOrderId values got rounded during response parsing, and the rounded value no longer
 * matched any real order on Binance's side (queryOrder returned -2013 "order does not exist" when
 * reconciling hours later). Standard JSON.parse always converts numeric literals to JS `number`,
 * silently losing precision for anything beyond ~16 digits — there is no way to recover the true
 * value AFTER that conversion, so this must intercept the RAW response text before JSON.parse
 * ever sees it.
 *
 * Rewrites `"orderId":123456789012345678` → `"orderId":"123456789012345678"` (and the same for
 * algoId/actualOrderId) so these specific fields parse as exact strings instead of lossy numbers.
 * Scoped to these 3 known field names (not every large integer in the response) so it can never
 * accidentally stringify an unrelated numeric field like price/qty/time.
 */
function preserveOrderIdPrecision(bodyText: string): string {
  return bodyText.replace(/"(orderId|algoId|actualOrderId)":(-?\d+)/g, '"$1":"$2"');
}

function decimalsForStep(step: number, fallback: number): number {
  if (!(step > 0)) return Math.max(0, fallback);
  const text = step.toString().toLowerCase();
  const exponent = text.match(/e-(\d+)$/);
  if (exponent) return Math.min(12, Number(exponent[1]));
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(12, text.length - dot - 1);
}

function roundToStep(value: number, step: number, mode: "down" | "up"): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const rawSteps = value / step;
  const steps = mode === "up" ? Math.ceil(rawSteps - 1e-9) : Math.floor(rawSteps + 1e-9);
  const decimals = decimalsForStep(step, 8);
  return Number((steps * step).toFixed(decimals));
}

function formatToStep(value: number, step: number, mode: "down" | "up", precisionFallback: number): string | number {
  if (!Number.isFinite(value)) return value;
  const rounded = roundToStep(value, step, mode);
  const decimals = decimalsForStep(step, precisionFallback);
  const fixed = rounded.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : fixed;
}

function triggerRoundMode(type: PlaceOrderParams["type"] | PlaceAlgoOrderParams["type"], side: "BUY" | "SELL"): "down" | "up" {
  if (type === "STOP_MARKET") {
    return side === "BUY" ? "up" : "down";
  }
  if (type === "TAKE_PROFIT_MARKET") {
    return side === "BUY" ? "down" : "up";
  }
  return "down";
}

/**
 * Deterministic querystring: insertion order, URL-encoded. Exported for the signing
 * unit test (signature must be reproducible against a known HMAC vector).
 */
export function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/** HMAC-SHA256 hex signature of the querystring. Exported for unit tests only. */
export function signQueryString(queryString: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(queryString).digest("hex");
}

// ─── client ──────────────────────────────────────────────────────────────────

export interface BinanceFuturesPrivateClientOptions {
  apiKey: string;
  apiSecret: string;
  env: LiveBinanceEnv;
  fetchImpl?: typeof fetch;
  /** Test hook: deterministic clock. */
  nowMs?: () => number;
}

export class BinanceFuturesPrivateClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  readonly env: LiveBinanceEnv;

  private serverTimeOffsetMs = 0;
  private lastTimeSyncAtMs = 0;
  private lastMeasuredSkewMs = 0;
  private exchangeFiltersCache: Map<string, FuturesSymbolFilters> | null = null;
  private exchangeFiltersCacheAtMs = 0;

  constructor(options: BinanceFuturesPrivateClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.env = options.env;
    this.baseUrl = resolveLiveBinanceBaseUrl(options.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  // ── raw transport ──────────────────────────────────────────────────────────

  private async rawRequest(method: "GET" | "POST" | "DELETE", url: string, signed: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: signed ? { "X-MBX-APIKEY": this.apiKey } : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new BinanceFuturesPrivateError(
        aborted ? "timeout" : "network",
        aborted ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : `network failure: ${(error as Error)?.message ?? "unknown"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text().catch(() => "");
    if (response.status === 429 || response.status === 418) {
      throw new BinanceFuturesPrivateError("429", `rate limited (HTTP ${response.status})`, { httpStatus: response.status });
    }
    let parsed: unknown = null;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(preserveOrderIdPrecision(bodyText)) : null;
    } catch {
      throw new BinanceFuturesPrivateError("invalid_response", `non-JSON response (HTTP ${response.status})`, {
        httpStatus: response.status,
      });
    }
    if (!response.ok) {
      const binanceCode =
        parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "number"
          ? (parsed as { code: number }).code
          : null;
      const binanceMsg =
        parsed && typeof parsed === "object" && typeof (parsed as { msg?: unknown }).msg === "string"
          ? (parsed as { msg: string }).msg
          : "";
      throw new BinanceFuturesPrivateError(
        "binance_error",
        `Binance error HTTP ${response.status}${binanceCode !== null ? ` code ${binanceCode}` : ""}: ${binanceMsg}`,
        { httpStatus: response.status, binanceCode },
      );
    }
    return parsed;
  }

  /** GETs retry on transient failures; mutations never do. */
  private async requestPublic(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<unknown> {
    const qs = buildQueryString(params);
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= GET_MAX_RETRIES; attempt++) {
      try {
        return await this.rawRequest("GET", url, false);
      } catch (error) {
        lastError = error;
        const type = error instanceof BinanceFuturesPrivateError ? error.failureType : "network";
        if (!RETRYABLE_GET_FAILURES.has(type) || attempt === GET_MAX_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async requestSigned(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown> {
    await this.ensureTimeSync();
    this.assertClockSkewOk();
    const buildSignedUrl = (): string => {
      const qs = buildQueryString({
        ...params,
        recvWindow: RECV_WINDOW_MS,
        timestamp: Math.round(this.nowMs() + this.serverTimeOffsetMs),
      });
      return `${this.baseUrl}${path}?${qs}&signature=${signQueryString(qs, this.apiSecret)}`;
    };

    if (method === "GET") {
      let lastError: unknown;
      for (let attempt = 0; attempt <= GET_MAX_RETRIES; attempt++) {
        try {
          return await this.rawRequest("GET", buildSignedUrl(), true);
        } catch (error) {
          lastError = error;
          const type = error instanceof BinanceFuturesPrivateError ? error.failureType : "network";
          if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -1021 && attempt < GET_MAX_RETRIES) {
            await this.forceTimeSync();
            this.assertClockSkewOk();
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            continue;
          }
          if (!RETRYABLE_GET_FAILURES.has(type) || attempt === GET_MAX_RETRIES) throw error;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
      throw lastError;
    }
    // POST/DELETE: exactly one attempt — the engine owns retries via idempotent client ids.
    try {
      return await this.rawRequest(method, buildSignedUrl(), true);
    } catch (error) {
      if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -1021) {
        await this.forceTimeSync();
      }
      throw error;
    }
  }

  // ── time sync / skew guard ─────────────────────────────────────────────────

  async ensureTimeSync(): Promise<void> {
    if (this.nowMs() - this.lastTimeSyncAtMs < TIME_SYNC_TTL_MS) return;
    await this.forceTimeSync();
  }

  private async forceTimeSync(): Promise<void> {
    const before = this.nowMs();
    const parsed = await this.requestPublic("/fapi/v1/time");
    const after = this.nowMs();
    const serverTime = toNum((parsed as { serverTime?: unknown })?.serverTime);
    if (serverTime <= 0) {
      throw new BinanceFuturesPrivateError("invalid_response", "server time missing from /fapi/v1/time");
    }
    const midpoint = (before + after) / 2;
    this.serverTimeOffsetMs = serverTime - midpoint;
    this.lastMeasuredSkewMs = Math.abs(this.serverTimeOffsetMs);
    this.lastTimeSyncAtMs = this.nowMs();
  }

  private assertClockSkewOk(): void {
    if (this.lastMeasuredSkewMs > MAX_CLOCK_SKEW_MS) {
      throw new BinanceFuturesPrivateError(
        "clock_skew",
        `clock skew ${Math.round(this.lastMeasuredSkewMs)}ms exceeds ${MAX_CLOCK_SKEW_MS}ms — refusing signed request`,
      );
    }
  }

  getClockSkewMs(): number {
    return this.lastMeasuredSkewMs;
  }

  // ── public endpoints ───────────────────────────────────────────────────────

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    if (this.exchangeFiltersCache && this.nowMs() - this.exchangeFiltersCacheAtMs < EXCHANGE_FILTERS_TTL_MS) {
      return new Map(this.exchangeFiltersCache);
    }
    const parsed = await this.requestPublic("/fapi/v1/exchangeInfo");
    const symbols = (parsed as { symbols?: unknown })?.symbols;
    const out = new Map<string, FuturesSymbolFilters>();
    if (!Array.isArray(symbols)) return out;
    for (const s of symbols) {
      const sym = s as {
        symbol?: string;
        pricePrecision?: number;
        quantityPrecision?: number;
        filters?: Array<{ filterType?: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string }>;
      };
      if (!sym.symbol || !Array.isArray(sym.filters)) continue;
      const price = sym.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lot = sym.filters.find((f) => f.filterType === "LOT_SIZE");
      const notional = sym.filters.find((f) => f.filterType === "MIN_NOTIONAL");
      out.set(sym.symbol, {
        symbol: sym.symbol,
        tickSize: toNum(price?.tickSize),
        stepSize: toNum(lot?.stepSize),
        minQty: toNum(lot?.minQty),
        minNotional: toNum(notional?.notional),
        pricePrecision: sym.pricePrecision ?? 8,
        quantityPrecision: sym.quantityPrecision ?? 8,
      });
    }
    this.exchangeFiltersCache = out;
    this.exchangeFiltersCacheAtMs = this.nowMs();
    return new Map(out);
  }

  private async getSymbolFilters(symbol: string): Promise<FuturesSymbolFilters | null> {
    const filters = await this.getExchangeFilters();
    return filters.get(symbol) ?? null;
  }

  // ── signed endpoints ───────────────────────────────────────────────────────

  async getBalances(): Promise<FuturesBalance[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v2/balance");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((b) => ({
      asset: String((b as { asset?: unknown }).asset ?? ""),
      balance: toNum((b as { balance?: unknown }).balance),
      availableBalance: toNum((b as { availableBalance?: unknown }).availableBalance),
    }));
  }

  async getPositions(symbol?: string): Promise<FuturesPosition[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {});
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => ({
      symbol: String((p as { symbol?: unknown }).symbol ?? ""),
      positionAmt: toNum((p as { positionAmt?: unknown }).positionAmt),
      entryPrice: toNum((p as { entryPrice?: unknown }).entryPrice),
      markPrice: toNum((p as { markPrice?: unknown }).markPrice),
      liquidationPrice: toNum((p as { liquidationPrice?: unknown }).liquidationPrice),
      unRealizedProfit: toNum((p as { unRealizedProfit?: unknown }).unRealizedProfit),
      leverage: toNum((p as { leverage?: unknown }).leverage),
      marginType: String((p as { marginType?: unknown }).marginType ?? ""),
    }));
  }

  /** True when the account is in hedge (dual-side) mode — the engine refuses to arm. */
  async isHedgeMode(): Promise<boolean> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/positionSide/dual");
    return Boolean((parsed as { dualSidePosition?: unknown })?.dualSidePosition);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.requestSigned("POST", "/fapi/v1/leverage", { symbol, leverage: Math.max(1, Math.floor(leverage)) });
  }

  /** Best-effort ISOLATED margin; Binance code -4046 = "No need to change margin type". */
  async setIsolatedMargin(symbol: string): Promise<void> {
    try {
      await this.requestSigned("POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" });
    } catch (error) {
      if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -4046) return;
      throw error;
    }
  }

  async getOpenOrders(symbol?: string): Promise<FuturesOrder[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
    return Array.isArray(parsed) ? parsed.map((o) => this.mapOrder(o)) : [];
  }

  async getOpenAlgoOrders(symbol?: string): Promise<FuturesAlgoOrder[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/openAlgoOrders", symbol ? { symbol } : {});
    return Array.isArray(parsed) ? parsed.map((order) => this.mapAlgoOrder(order)) : [];
  }

  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/algoOrder", { algoId });
    return this.mapAlgoOrder(parsed);
  }

  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/order", { symbol, orderId });
    return this.mapOrder(parsed);
  }

  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    const filters = await this.getSymbolFilters(params.symbol);
    const quantity = filters
      ? formatToStep(params.quantity, filters.stepSize, "down", filters.quantityPrecision)
      : params.quantity;
    const price = filters && params.price !== undefined
      ? formatToStep(params.price, filters.tickSize, "down", filters.pricePrecision)
      : params.price;
    const stopPrice = filters && params.stopPrice !== undefined
      ? formatToStep(params.stopPrice, filters.tickSize, triggerRoundMode(params.type, params.side), filters.pricePrecision)
      : params.stopPrice;
    const parsed = await this.requestSigned("POST", "/fapi/v1/order", {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity,
      price,
      stopPrice,
      reduceOnly: params.reduceOnly,
      timeInForce: params.type === "LIMIT" ? params.timeInForce ?? "GTC" : undefined,
      newClientOrderId: params.newClientOrderId,
      workingType: params.workingType,
      newOrderRespType: "RESULT",
    });
    return this.mapOrder(parsed);
  }

  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    const filters = await this.getSymbolFilters(params.symbol);
    const quantity = filters
      ? formatToStep(params.quantity, filters.stepSize, "down", filters.quantityPrecision)
      : params.quantity;
    const triggerPrice = filters
      ? formatToStep(params.triggerPrice, filters.tickSize, triggerRoundMode(params.type, params.side), filters.pricePrecision)
      : params.triggerPrice;
    const parsed = await this.requestSigned("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity,
      triggerPrice,
      reduceOnly: params.reduceOnly,
      clientAlgoId: params.clientAlgoId,
      workingType: params.workingType,
    });
    return this.mapAlgoOrder(parsed);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.requestSigned("DELETE", "/fapi/v1/order", { symbol, orderId });
  }

  async cancelAlgoOrder(algoId: string): Promise<void> {
    await this.requestSigned("DELETE", "/fapi/v1/algoOrder", { algoId });
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await this.requestSigned("DELETE", "/fapi/v1/allOpenOrders", { symbol });
  }

  async cancelAllAlgoOrders(symbol: string): Promise<void> {
    await this.requestSigned("DELETE", "/fapi/v1/algoOpenOrders", { symbol });
  }

  async getUserTrades(symbol: string, opts: { startTime?: number; limit?: number } = {}): Promise<FuturesUserTrade[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/userTrades", {
      symbol,
      startTime: opts.startTime,
      limit: opts.limit ?? 100,
    });
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => ({
      symbol: String((t as { symbol?: unknown }).symbol ?? ""),
      orderId: toStrId((t as { orderId?: unknown }).orderId),
      price: toNum((t as { price?: unknown }).price),
      qty: toNum((t as { qty?: unknown }).qty),
      realizedPnl: toNum((t as { realizedPnl?: unknown }).realizedPnl),
      commission: toNum((t as { commission?: unknown }).commission),
      commissionAsset: String((t as { commissionAsset?: unknown }).commissionAsset ?? ""),
      time: toNum((t as { time?: unknown }).time),
    }));
  }

  private mapOrder(raw: unknown): FuturesOrder {
    const o = raw as Record<string, unknown>;
    return {
      symbol: String(o.symbol ?? ""),
      orderId: toStrId(o.orderId),
      clientOrderId: String(o.clientOrderId ?? o.newClientOrderId ?? ""),
      status: String(o.status ?? ""),
      type: String(o.type ?? o.origType ?? ""),
      side: (o.side === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
      reduceOnly: Boolean(o.reduceOnly),
      price: toNum(o.price),
      stopPrice: toNum(o.stopPrice),
      origQty: toNum(o.origQty),
      executedQty: toNum(o.executedQty),
      avgPrice: toNum(o.avgPrice),
      updateTime: toNum(o.updateTime),
    };
  }

  private mapAlgoOrder(raw: unknown): FuturesAlgoOrder {
    const order = raw as Record<string, unknown>;
    const actualOrderId = toStrId(order.actualOrderId);
    return {
      symbol: String(order.symbol ?? ""),
      algoId: toStrId(order.algoId),
      clientAlgoId: String(order.clientAlgoId ?? ""),
      algoStatus: String(order.algoStatus ?? order.status ?? ""),
      orderType: String(order.orderType ?? order.type ?? ""),
      side: order.side === "SELL" ? "SELL" : "BUY",
      quantity: toNum(order.quantity),
      triggerPrice: toNum(order.triggerPrice),
      actualOrderId: actualOrderId && actualOrderId !== "0" ? actualOrderId : null,
    };
  }
}

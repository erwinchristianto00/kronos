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
 *  - GET requests retry on timeout/429/network (idempotent), but never immediately retry an
 *    HTTP 418 IP ban: repeating that request only extends the ban. Order-mutating requests
 *    (POST/DELETE) NEVER auto-retry — double-submit is worse than a missed attempt; the
 *    engine passes newClientOrderId so a retry-by-engine is exchange-side idempotent.
 *  - This module performs NO strategy logic and NO sizing. It is a transport.
 */

import { createHmac } from "node:crypto";
import {
  BinanceUsdMTestnetCooldownError,
  BinanceUsdMTestnetLaneSaturatedError,
  weightPoolFor,
  BinanceUsdMTestnetReadCoordinator,
  estimateTestnetReadWeight,
  TESTNET_DISPATCH_BUDGET_WAIT_MS,
  type BinanceUsdMRequestKind,
  type BinanceUsdMTestnetRateLimitStatus,
} from "./binance-usdm-testnet-rate-limit.js";

// ─── env / base urls ─────────────────────────────────────────────────────────

export type LiveBinanceEnv = "testnet" | "mainnet";

const BASE_URLS: Record<LiveBinanceEnv, string> = {
  testnet: "https://demo-fapi.binance.com",
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

/**
 * 2026-08-18: raised from 6_000 after measuring Binance's own behaviour during a testnet backend
 * outage. Every authenticated endpoint (positionRisk, account, balance, openOrders) failed at a
 * consistent ~8.08s with HTTP 408 / -1007, while the gateway itself answered a deliberately bad key
 * in <100ms — so 8.08s is Binance's server-side ceiling, not network noise.
 *
 * A 6s client timeout sits BELOW that ceiling. During a degraded-but-alive period Binance would
 * answer at ~7-8s and we would abort first, turning a knowable outcome into an unknown one. That
 * matters most on POST: this timeout covers GET, POST and DELETE alike, and -1007 says outright
 * "Send status unknown; execution status unknown" — aborting early on an order placement is exactly
 * how this codebase's recurring "invisible naked position" class of bug starts.
 *
 * 10s clears the ceiling with margin. Safe against tick overrun: tick() runs every 25s behind an
 * `if (this.ticking) return` re-entrancy guard, so a slow tick skips the next one rather than
 * overlapping. During a FULL outage this changes nothing — the request fails either way, only the
 * error text differs ("timed out after 10000ms" vs the -1007 Binance returns at 8.08s).
 */
export const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Ceiling on waiting for the previous *transport* slot to release.
 *
 * A transport slot legitimately holds the queue for `paceQueuedRead` plus one
 * `dispatchRawRequest`, and that dispatch is bounded by REQUEST_TIMEOUT_MS with
 * the abort armed through body consumption. The host lease's 30s wait happens
 * OUTSIDE this queue, so it does not count here. GET retries take a fresh slot
 * each, which makes ~11s the honest worst case.
 *
 * It exists because the queue had no liveness guarantee: `await previous` on a
 * head that never released froze EVERY later read forever — public and signed
 * alike — and the engine then traded blind while still reporting errorStreak:0
 * and a null lastTickError. Both 3102 and 3103 sat that way on 2026-09-04, each
 * with zero established connections and no error anywhere. A fetch that ignores
 * its abort signal (a stalled response body is the usual way) is enough. Past
 * this bound the head has already broken its own timeout contract, so
 * proceeding is strictly safer than waiting forever; the host lease and
 * paceQueuedRead still limit the resulting request rate.
 */
export const TRANSPORT_SLOT_MAX_WAIT_MS = 30_000;
const RECV_WINDOW_MS = 5_000;
// Guard stays below RECV_WINDOW_MS so offset-compensated timestamps still land inside Binance's window.
export const MAX_CLOCK_SKEW_MS = 4_000;
const GET_MAX_RETRIES = 2;
// Sync every 60 s so the offset stays fresh even on hosts with fast clock drift.
const TIME_SYNC_TTL_MS = 60_000;
/**
 * HTTP 418 is an IP-ban response, not a hint to retry shortly.  Binance does not always send a
 * Retry-After header, so keep the transport quiet for a conservative two minutes when no explicit
 * expiry is supplied.  This protects the account-wide client shared by the engine, basket
 * executors, and dashboard from extending its own ban.
 */
const HTTP_418_FALLBACK_COOLDOWN_MS = 2 * 60_000;
/** A plain 429 may be a short endpoint throttle; honour it too, but do not turn it into a ban. */
const HTTP_429_FALLBACK_COOLDOWN_MS = 5_000;
/**
 * Requests were already serialized, but serial dispatch can still burst many public/signed USD-M
 * reads in a few seconds. Pacing both environments keeps a dashboard refresh, executor
 * reconciliation, and quote verification from recreating an IP-level spike. Risk-reducing
 * POST/DELETE traffic remains unqueued (see rawRequest()).
 */
/**
 * A process-local 125 ms queue did not protect the Testnet account: dashboard,
 * reconciliation, and lane monitors still created a host-level burst after a
 * restart/cutover.  Signed Testnet reads additionally use the durable
 * coordinator below; this local gap keeps public quote/data traffic civil
 * without putting a fresh execution quote behind the 30-second account lease.
 */
const TESTNET_GET_MIN_DISPATCH_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 1_250;
const MAINNET_GET_MIN_DISPATCH_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 125;
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
  /** ISO time at which the client may safely attempt the endpoint again, if rate-limited. */
  readonly retryAt: string | null;

  constructor(
    failureType: LiveRequestFailureType,
    message: string,
    opts: { httpStatus?: number | null; binanceCode?: number | null; retryAt?: string | null } = {},
  ) {
    super(message);
    this.name = "BinanceFuturesPrivateError";
    this.failureType = failureType;
    this.httpStatus = opts.httpStatus ?? null;
    this.binanceCode = opts.binanceCode ?? null;
    this.retryAt = opts.retryAt ?? null;
  }
}

const RETRYABLE_GET_FAILURES: ReadonlySet<LiveRequestFailureType> = new Set([
  "timeout",
  "429",
  "network",
]);

/**
 * A Binance 418 is an explicit IP-ban signal, not an ordinary transient 429.  The old generic
 * GET retry loop turned one rejected dashboard/account read into three immediate signed reads;
 * that is exactly the wrong response while Binance asks this IP to stop.  Keep ordinary 429
 * retries (they can be a short-lived per-endpoint throttle), but surface 418 to the caller so
 * the dashboard-level cooldown can serve its last verified snapshot instead.
 */
/**
 * A GET that has not settled long after every queue bound, pacing wait and the fetch abort should
 * have fired. 2026-09-18: one account read issued 2026-09-15 06:28Z was still pending three days
 * later; the dashboard coalescer and the engine tick both awaited it, so /api/live/account hung
 * forever and the engine disarmed itself as "tick stalled". Every stage in the path is nominally
 * bounded, so a still-pending read means one bound failed — abandon it loudly instead of letting
 * callers inherit an unbounded wait. Reads only: a mutation's outcome must never be guessed.
 */
export const GET_HARD_DEADLINE_MS = 10 * 60_000;
/** Report (once) which stage a read is stuck in, well before the hard deadline abandons it. */
export const GET_STALL_REPORT_MS = 2 * 60_000;

export class BinanceReadDeadlineError extends BinanceFuturesPrivateError {
  constructor(message: string) {
    super("timeout", message);
    this.name = "BinanceReadDeadlineError";
  }
}

function shouldRetryGet(error: unknown): boolean {
  // Retrying an abandoned read would only multiply the wait it was abandoned for.
  if (error instanceof BinanceReadDeadlineError) return false;
  if (!(error instanceof BinanceFuturesPrivateError)) return true;
  return RETRYABLE_GET_FAILURES.has(error.failureType) && error.httpStatus !== 418;
}

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

/** A USD-M futures candle from the same selected venue as private execution. */
export interface FuturesKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AstraTicker24h {
  symbol: string;
  priceChangePercent: number | null;
  quoteVolume: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  lastPrice: number | null;
  closeTime: number | null;
}

export interface AstraPremiumIndex {
  symbol: string;
  markPrice: number | null;
  indexPrice: number | null;
  lastFundingRate: number | null;
  nextFundingTime: number | null;
  time: number | null;
}

export interface AstraCommissionRate {
  symbol: string;
  makerCommissionRate: number;
  takerCommissionRate: number;
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
  /** Exact exchange update time for the confirmed fill, when Binance returned one.  This is
   * deliberately null rather than a local fallback: chart/audit consumers must never present a
   * submission timestamp as an exchange-confirmed fill timestamp. */
  filledAtMs: number | null;
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
    /** `placeOrder` can already carry a terminal fill and its exchange update time. */
    initialUpdateTime?: number | null;
    onUnconfirmed?: (symbol: string, orderId: string, fallbackPrice: number) => void;
  } = {},
): Promise<FillPriceResolution> {
  const validExchangeTime = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (initialAvgPrice > 0) {
    return { price: initialAvgPrice, confirmed: true, filledAtMs: validExchangeTime(opts.initialUpdateTime) };
  }
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 400;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const queried = await client.queryOrder(symbol, orderId);
      if (queried.avgPrice > 0) {
        return { price: queried.avgPrice, confirmed: true, filledAtMs: validExchangeTime(queried.updateTime) };
      }
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
  return { price: fallbackPrice, confirmed: false, filledAtMs: null };
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
  /**
   * Binance's own per-FILL trade id (`id` on /fapi/v1/userTrades), as a STRING for the same reason
   * orderId is one. RECORDING ONLY — nothing in this codebase queries, cancels, or matches an order
   * by it; it exists so execution-fill-recorder.ts can dedup a re-observed fill on the exchange's
   * OWN key instead of a (orderId, time, price, qty, commission) tuple heuristic.
   *
   * PRECISION CAVEAT, identical in kind and consequence to FuturesIncomeEntry.tranId's: `id` is NOT
   * run through preserveOrderIdPrecision (that guard is deliberately scoped to the 3 fields used to
   * ACT on an order — orderId/algoId/actualOrderId — precisely so it can never stringify an
   * unrelated numeric field, and `"id":` is far too generic a key to add to it safely). A value
   * beyond 2^53 would therefore already have been rounded by JSON.parse before this mapper sees it.
   * That is acceptable HERE and only here: a rounded trade id degrades dedup back to the tuple
   * fallback, whereas a rounded orderId caused the real -2013 incident.
   *
   * OPTIONAL, and `""`/absent means the exchange did not report one — never fabricated.
   */
  tradeId?: string;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
  /**
   * Binance's own liquidity flag for this fill (`maker` on /fapi/v1/userTrades): true = we provided
   * liquidity, false = we crossed the spread (taker). RECORDING ONLY — nothing in this codebase
   * branches on it, and nothing should: it exists so the "the live path is 100% taker" assumption
   * (only MARKET and STOP_MARKET are ever placed by single-symbol-lane-executor.ts and
   * cross-sectional-executor.ts, so the real cost is 5.0 bps/side taker commission) is VERIFIED per
   * fill instead of assumed.
   *
   * THAT ASSUMPTION IS NO LONGER UNIVERSAL (2026-08-16): cross-sectional-executor.ts can now place
   * post-only GTX entry legs when CROSS_SECTIONAL_MAKER_ENTRY_ENABLED=1, so this flag stopped being
   * a redundant confirmation and became the measurement — it is how the maker share and the real
   * blended cost are read back. Measured rates on this account: maker 2.00, taker 4.00 bps/side.
   *
   * OPTIONAL, and `undefined` means UNKNOWN — the exchange did not report a boolean for this row.
   * It is deliberately NOT defaulted to `false`: `false` is exactly the value we expect, so
   * defaulting would make "the field was missing" indistinguishable from "the exchange confirmed
   * taker", destroying the only thing this field is for. Consumers must treat `undefined` as
   * unmeasured and exclude it from any maker/taker ratio, never fold it into the taker bucket.
   */
  maker?: boolean;
}

/**
 * One row of Binance's /fapi/v1/income ledger (used by wallet-reconciliation.ts's report-only
 * income-vs-internal-ledger check — see that module's doc comment for the safety rationale).
 * incomeType is a known Binance vocabulary (REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER,
 * INSURANCE_CLEAR, …) but kept as `string` here rather than a closed union so an exchange-added
 * type we haven't seen yet still comes through instead of being dropped or throwing.
 *
 * tranId is NOT run through preserveOrderIdPrecision (that guard is intentionally scoped to the 3
 * fields actually used to act on an order/algo — orderId/algoId/actualOrderId). This client never
 * uses tranId to query, cancel, or match an order, and the reconciliation math never keys on it, so
 * a precision loss here has no SAFETY consequence (unlike the real orderId incident that guard
 * exists for).
 *
 * IT IS NO LONGER PURELY DIAGNOSTIC, THOUGH (2026-07-27). funding-fee-recorder.ts uses tranId as its
 * exact-once dedup key, so a value above 2^53 — already rounded by JSON.parse before this mapper's
 * toStrId ever sees it — could in principle collide with a neighbouring tranId and cause that store
 * to silently DROP a funding row (an under-count, never a double-count: the rounding is
 * deterministic, so re-fetches stay stable). Observed Binance income tranIds are ~10-13 digits, two
 * to three orders of magnitude below the danger zone, so the regex is deliberately NOT widened —
 * adding keys to a body-text regex that runs over every signed private response is the larger risk.
 * Recorded here so the next person does not read "diagnostic only" and assume no consumer exists.
 */
export interface FuturesIncomeEntry {
  symbol: string;
  incomeType: string;
  /** Signed USD-equivalent amount as Binance reports it (e.g. COMMISSION is typically negative). */
  income: number;
  asset: string;
  time: number;
  tranId: string;
  info: string;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number; // LIMIT
  stopPrice?: number; // STOP_MARKET / TAKE_PROFIT_MARKET
  reduceOnly?: boolean;
  /** GTX is Binance's post-only: the order is REJECTED outright if it would cross and take
   *  liquidity, so it can only ever fill as maker. Added 2026-08-16 — this account's measured
   *  rates are maker 2.00 bps vs taker 4.00 bps per side, i.e. exactly half. */
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  /** Engine-supplied idempotency key (derived from the paper order id). REQUIRED (2026-07-12 fix):
   *  this file's own top-of-file safety design ("POST/DELETE NEVER auto-retry... the engine passes
   *  newClientOrderId so a retry-by-engine is exchange-side idempotent") depended entirely on every
   *  caller supplying one, but nothing enforced it while this field was optional — every real call
   *  site already supplies it (grepped: zero omissions across src/ and test/), so this closes the
   *  gap with zero behavior change and makes a future omission a compile error instead of a silent
   *  non-idempotent retry risk. */
  newClientOrderId: string;
  workingType?: "CONTRACT_PRICE" | "MARK_PRICE";
  /**
   * Executor-owned abort boundary for a fresh basket entry. This is never sent
   * to Binance: it prevents a queued filter lookup or an in-flight POST from
   * turning into a new leg after the basket's hard entry deadline has elapsed.
   * Reduce-only exits intentionally omit it and remain able to flatten.
   */
  signal?: AbortSignal;
  /** Recording only; never serialized to Binance. */
  onDispatch?: (atMs: number) => void;
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

/** Astra context must distinguish unavailable numbers from verified zero values. */
function toAstraNumberOrNull(value: unknown): number | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    value = Number(text);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/**
 * Exported (2026-07-10, Task 1) purely so the offline exit-ablation harness
 * (current-guard-variant-matrix.ts's "production_breakeven_control" exitRule) can reuse the
 * EXACT SAME floor-to-stepSize quantity rounding that placeOrder() (below) applies to every real
 * reduce-only close order, instead of re-implementing the epsilon/floor logic a second time. Pure
 * visibility change only — the function body and every existing call site in this file are
 * unchanged, so this does not alter any live order-placement/close behavior.
 */
export function roundToStep(value: number, step: number, mode: "down" | "up"): number {
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
  /** Test hook: override the local (non-host-leased) GET pacing. */
  testReadDispatchGapMs?: number;
  /** Stable host directory shared by Testnet releases; never used on Mainnet. */
  testnetCoordinatorDir?: string | null;
  /** Host-wide signed Testnet GET gap. Defaults to the deployed env value or 30 seconds. */
  testnetGlobalReadGapMs?: number;
}

export interface FuturesExecutionBookTicker {
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  time: number | null;
}

/** Current local circuit state. Purely diagnostic; it never invents exchange health. */
export interface BinanceFuturesRateLimitStatus {
  dispatchGuard?: BinanceUsdMTestnetRateLimitStatus["dispatchGuard"] | null;
  dispatchWeightBudget?: number | null;
  dispatchHighWater?: { weight: number; atMs: number } | null;
  dispatchLocalWeight60s?: number | null;
  coolingDown: boolean;
  retryAt: string | null;
  lastHttpStatus: 418 | 429 | null;
  lastFailure: string | null;
  /** Present only for the durable Testnet transport. */
  coordination?: BinanceUsdMTestnetRateLimitStatus["coordination"] | null;
  globalReadGapMs?: number | null;
  signedReadGapMs?: number | null;
  /** What the venue itself says this IP has spent in the current weight minute. */
  venueWeightLimitPerMin?: number | null;
  venueUsedWeight1m?: number | null;
  venueWeightBand?: BinanceUsdMTestnetRateLimitStatus["venueWeightBand"] | null;
  /** Testnet meters bulky market data on its own counter; report it separately or it reads as noise. */
  marketDataReadGapMs?: number | null;
  venueUsedWeightMarketData?: number | null;
  venueWeightBandMarketData?: BinanceUsdMTestnetRateLimitStatus["venueWeightBand"] | null;
  venueUsedWeightSigned?: number | null;
  venueWeightBandSigned?: BinanceUsdMTestnetRateLimitStatus["venueWeightBand"] | null;
  lastEndpoint?: string | null;
  lastRequestKind?: BinanceUsdMRequestKind | null;
  lastRequestCaller?: string | null;
}

type BinanceTransportRequestProvenance = {
  endpoint: string;
  requestKind: BinanceUsdMRequestKind;
  requestCaller: string | null;
};

/**
 * Binance reports this IP's spend for the current weight minute on every response.
 *
 * This is the only honest measure of how close the transport is to a ban. Without it the host gap
 * was a constant guessed from the outside, and the guess was wrong by roughly two orders of
 * magnitude in the conservative direction.
 */
function parseUsedWeight1m(headers: Headers): number | null {
  const raw = headers.get("x-mbx-used-weight-1m") ?? headers.get("x-mbx-used-weight");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseRetryAfterMs(raw: string | null, nowMs: number): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const atMs = Date.parse(raw);
  return Number.isFinite(atMs) ? Math.max(0, atMs - nowMs) : null;
}

/** Binance -1003 bodies commonly say "IP banned until <unix-ms>". Parse that if present. */
function parseBanUntilMs(bodyText: string): number | null {
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { msg?: unknown; retryAfter?: unknown; retryAfterMs?: unknown };
    const explicit = Number(parsed.retryAfterMs ?? parsed.retryAfter);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit < 100_000_000_000 ? Math.round(explicit * 1_000) : Math.round(explicit);
    }
    if (typeof parsed.msg === "string") message = parsed.msg;
  } catch {
    // Keep the raw body as the best available message to inspect for a ban-until timestamp.
  }
  const match = message.match(/\b(?:ban(?:ned)?\s+until|until)\D*(\d{10,13})\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 100_000_000_000 ? Math.round(parsed * 1_000) : Math.round(parsed);
}

export class BinanceFuturesPrivateClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly readDispatchMinGapMs: number;
  private readonly testnetReadCoordinator: BinanceUsdMTestnetReadCoordinator | null;
  readonly env: LiveBinanceEnv;

  private serverTimeOffsetMs = 0;
  private lastTimeSyncAtMs = 0;
  private lastMeasuredSkewMs = 0;
  private exchangeFiltersCache: Map<string, FuturesSymbolFilters> | null = null;
  private exchangeFiltersCacheAtMs = 0;
  /**
   * Coalesce a cold exchangeInfo fetch. A multi-leg basket submits its maker
   * legs concurrently; without this, every leg observes the empty cache and
   * queues the same GET behind the shared transport limiter.
   */
  private exchangeFiltersInFlight: Promise<Map<string, FuturesSymbolFilters>> | null = null;
  /** Coalesces a cold-start time sync shared by concurrent signed reads. */
  private timeSyncInFlight: Promise<void> | null = null;
  /** Serialises actual HTTP dispatch, so a Promise.all cannot race several requests past a new 418. */
  private transportTail: Promise<void> = Promise.resolve();
  /**
   * Host-coordinated Testnet USD-M GETs wait here before entering the local
   * queue. Binance applies its Testnet ban at the source IP, so public/candle
   * reads must participate. The durable coordinator gives public and signed
   * reads separately paced lanes plus a cross-kind gap, preventing a passive
   * candle backlog from starving account reconciliation.
   *
   * One queue PER KIND, never one shared queue. A single FIFO here silently
   * undid the coordinator's lanes: each queued read holds the queue for its
   * whole 30s host slot, so a signed account read entering behind a passive
   * candle backlog never reached `reserveReadDispatch` at all. That starved
   * Testnet 3102 for 108 minutes on 2026-09-04 with `errorStreak:0` and
   * `lastTickError:null` — /api/live/account simply never answered and nothing
   * reported an error. Separate lanes here are what make the coordinator's
   * per-kind pacing reachable; the cross-kind gap still spaces the two.
   *
   * POST/DELETE risk-reducing exits remain outside this queue; they still
   * honour an already-open cooldown but never wait behind observability work.
   */
  private readonly testnetReadTails: Record<BinanceUsdMRequestKind, Promise<void>> = {
    SIGNED: Promise.resolve(),
    PUBLIC: Promise.resolve(),
  };
  /** Next permitted queued GET dispatch in the selected Binance environment. */
  private nextReadDispatchAtMs = 0;
  private rateLimitCooldownUntilMs = 0;
  private lastRateLimitHttpStatus: 418 | 429 | null = null;
  private lastRateLimitFailure: string | null = null;
  private lastRateLimitEndpoint: string | null = null;
  private lastRateLimitRequestKind: BinanceUsdMRequestKind | null = null;
  private lastRateLimitRequestCaller: string | null = null;

  constructor(options: BinanceFuturesPrivateClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.env = options.env;
    this.baseUrl = resolveLiveBinanceBaseUrl(options.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.readDispatchMinGapMs = Number.isFinite(options.testReadDispatchGapMs)
      ? Math.max(0, Math.round(options.testReadDispatchGapMs!))
      : options.env === "testnet"
        ? TESTNET_GET_MIN_DISPATCH_GAP_MS
        : MAINNET_GET_MIN_DISPATCH_GAP_MS;
    const testnetCoordinatorDir = options.env === "testnet"
      ? options.testnetCoordinatorDir
        ?? process.env.BINANCE_USDM_TESTNET_COORDINATION_DIR
        ?? (process.env.NODE_ENV === "test" ? null : "data/binance-usdm-testnet-transport")
      : null;
    const configuredTestnetGlobalGapMs = options.testnetGlobalReadGapMs
      ?? Number.parseInt(process.env.BINANCE_USDM_TESTNET_GLOBAL_READ_GAP_MS ?? "", 10);
    this.testnetReadCoordinator = testnetCoordinatorDir
      ? new BinanceUsdMTestnetReadCoordinator({
        directory: testnetCoordinatorDir,
        // Was hard-coded 30_000 here, which silently overrode the module default and made loosening
        // it a no-op. Pass through only an explicit override; otherwise let the module decide.
        globalReadGapMs: Number.isFinite(configuredTestnetGlobalGapMs) && configuredTestnetGlobalGapMs > 0
          ? configuredTestnetGlobalGapMs
          : undefined,
        nowMs: this.nowMs,
      })
      : null;
  }

  // ── raw transport ──────────────────────────────────────────────────────────

  /**
   * Keep only the first application frame. It identifies the subsystem that
   * triggered a venue throttle without ever persisting query strings,
   * signatures, credentials, or a full stack trace.
   */
  private captureRequestCaller(): string | null {
    const stack = new Error().stack;
    if (!stack) return null;
    for (const frame of stack.split("\n").slice(1)) {
      const sourceAt = frame.indexOf("/apps/api/src/");
      if (sourceAt < 0 || frame.includes("/binance-futures-private.")) continue;
      return frame.slice(sourceAt).trim().replace(/\)$/, "");
    }
    return null;
  }

  private requestProvenance(endpoint: string, signed: boolean): BinanceTransportRequestProvenance {
    return {
      endpoint,
      requestKind: signed ? "SIGNED" : "PUBLIC",
      requestCaller: this.captureRequestCaller(),
    };
  }

  private async rawRequest(
    method: "GET" | "POST" | "DELETE",
    url: string | (() => string),
    signed: boolean,
    signal: AbortSignal | undefined,
    provenance: BinanceTransportRequestProvenance,
    onDispatch?: () => void,
  ): Promise<unknown> {
    // Where this request currently waits. Only read by the stall report / hard deadline below.
    const stage = { name: "host read lane" };
    const dispatch = async (): Promise<unknown> => {
      if (method === "GET" && this.testnetReadCoordinator) {
        stage.name = "dispatch budget";
        const preview = new URL(typeof url === "function" ? url() : url);
        await this.testnetReadCoordinator.acquireDispatchBudget({
          method, endpoint: provenance.endpoint, requestCaller: provenance.requestCaller,
          estimatedWeight: estimateTestnetReadWeight(preview.pathname, preview.searchParams),
        }, () => this.assertRateLimitCircuitClosed(), signal);
        this.assertRateLimitCircuitClosed();
      }
      // Mint the signed URL AFTER the final budget wait, preserving recvWindow.
      stage.name = "network request";
      return this.dispatchRawRequest(
      method,
      typeof url === "function" ? url() : url,
      signed,
      provenance,
      signal,
      onDispatch,
      );
    };
    // Reads are the burst source (dashboard/account/reconcile snapshots) and are safe to queue.
    // Never queue a risk-reducing POST/DELETE behind a slow read: it still respects an already-open
    // 418 circuit, but an operator/engine close keeps its normal immediate dispatch priority.
    if (method === "GET") {
      const inTransportSlot = () => {
        stage.name = "transport queue";
        return this.withTransportSlot(dispatch, stage);
      };
      return this.withReadDeadline(
        this.testnetReadCoordinator
          ? this.withHostTestnetReadSlot(provenance, inTransportSlot, stage)
          : inTransportSlot(),
        provenance,
        stage,
      );
    }
    this.assertRateLimitCircuitClosed();
    return dispatch();
  }

  /**
   * Queue read dispatches, rather than merely retrying callers independently: a concurrent
   * balance/positions/orders snapshot must not send a second request while the first one is
   * learning that Binance has banned this IP. POST/DELETE intentionally bypass this queue so an
   * exit never waits behind a slow observability read.
   */
  private async withTransportSlot<T>(operation: () => Promise<T>, stage?: { name: string }): Promise<T> {
    const previous = this.transportTail;
    let release = (): void => {};
    this.transportTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await this.awaitQueueHead(previous, TRANSPORT_SLOT_MAX_WAIT_MS
      + (this.testnetReadCoordinator ? TESTNET_DISPATCH_BUDGET_WAIT_MS : 0), "transport queue");
    try {
      this.assertRateLimitCircuitClosed();
      if (stage) stage.name = "local read pacing";
      await this.paceQueuedRead();
      // A priority exit may have learnt of an exchange cooldown while this queued read waited.
      this.assertRateLimitCircuitClosed();
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Serialize Testnet USD-M GETs per request kind through the durable host
   * lease. The lease is taken before the process-local queue so independent Testnet
   * clients/releases cannot burst public candles or signed account reads past
   * the same VPS IP limit. Signed URLs are still minted only after both waits,
   * keeping Binance's five-second recvWindow valid.
   */
  private async withHostTestnetReadSlot<T>(
    provenance: BinanceTransportRequestProvenance,
    operation: () => Promise<T>,
    stage?: { name: string },
  ): Promise<T> {
    const requestKind = provenance.requestKind;
    const coordinator = this.testnetReadCoordinator;
    if (!coordinator) return operation();
    const previous = this.testnetReadTails[requestKind];
    let release = (): void => {};
    this.testnetReadTails[requestKind] = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This lane still needs a bound — a head stuck in a dispatch that never
    // settles holds it forever, and the transport bound below only lets OTHER
    // requests past that head, it does not free the head itself.
    //
    // But the bound cannot be a constant. A lane head legitimately sleeps
    // until its reserved slot, and under a passive-candle backlog that slot is
    // booked minutes ahead by design. A fixed 90s ceiling fired on ordinary
    // backlog instead of on deadlock, and every spurious bypass reserved
    // another slot, pushing the horizon further out — it made the starvation
    // worse. Derive it from what the lease has actually booked: however far
    // ahead the queue currently reaches, plus one more slot, plus the whole
    // transport ceiling. Only a head that outlives that is genuinely stuck.
    const bookedAheadMs = Math.max(0, coordinator.bookedThroughMs() - Date.now());
    await this.awaitQueueHead(
      previous,
      bookedAheadMs + coordinator.globalReadGapMs + TRANSPORT_SLOT_MAX_WAIT_MS + TESTNET_DISPATCH_BUDGET_WAIT_MS,
      `host ${requestKind} read lane`,
    );
    try {
      this.assertRateLimitCircuitClosed();
      if (stage) stage.name = "host dispatch reservation";
      try {
        await coordinator.reserveReadDispatch(
          requestKind,
          provenance.requestCaller,
          weightPoolFor(provenance.requestKind, provenance.endpoint),
        );
      } catch (error) {
        if (error instanceof BinanceUsdMTestnetCooldownError) {
          this.rateLimitCooldownUntilMs = Math.max(this.rateLimitCooldownUntilMs, error.retryAtMs);
          this.lastRateLimitHttpStatus = error.httpStatus;
          this.lastRateLimitFailure = error.failure;
          this.lastRateLimitEndpoint = error.endpoint;
          this.lastRateLimitRequestKind = error.requestKind;
          this.lastRateLimitRequestCaller = error.requestCaller;
          throw new BinanceFuturesPrivateError("429", error.message, {
            httpStatus: error.httpStatus,
            retryAt: new Date(error.retryAtMs).toISOString(),
          });
        }
        if (error instanceof BinanceUsdMTestnetLaneSaturatedError) {
          // Loud and immediate. The failure this replaces was a silent sleep well past every
          // client timeout, which is what let a wedged tick report errorStreak 0 for an hour.
          throw new BinanceFuturesPrivateError("timeout", error.message, { httpStatus: null });
        }
        throw error;
      }
      // Another worker can have learnt of a venue ban while this request waited
      // for its host slot. Re-read durable state before sending anything.
      this.assertRateLimitCircuitClosed();
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Wait for a queue head, then stop waiting. Every queue in this client is a
   * promise chain settled only by its own `release()`, so one operation that
   * never settles pins its queue — and everything behind it — permanently.
   * Breaking the chain is loud on purpose: this freeze was completely silent,
   * which is what let it run for the better part of an hour on two instances.
   */
  private async awaitQueueHead(previous: Promise<void>, maxWaitMs: number, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"ABANDONED">((resolve) => {
      timer = setTimeout(() => resolve("ABANDONED"), maxWaitMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([previous.then(() => "RELEASED" as const), abandoned]);
      if (outcome === "ABANDONED") {
        console.warn(
          `[binance-transport] ${label} head did not release within ${maxWaitMs}ms `
          + `(request timeout is ${REQUEST_TIMEOUT_MS}ms) — proceeding without it so exchange reads `
          + "cannot stall indefinitely. A stuck head means a dispatch ignored its own abort.",
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Bound a queued GET end to end. The abandoned operation keeps running (it is a read, so
   * nothing is left half-done); the caller simply stops inheriting its wait. The stall report
   * names the stage so the next occurrence identifies which bound failed.
   */
  private withReadDeadline<T>(
    run: Promise<T>,
    provenance: BinanceTransportRequestProvenance,
    stage: { name: string },
  ): Promise<T> {
    const label = `${provenance.requestKind} GET ${provenance.endpoint} (${provenance.requestCaller ?? "unattributed"})`;
    return new Promise<T>((resolve, reject) => {
      const report = setTimeout(() => {
        console.warn(
          `[binance-transport] ${label} still pending after ${GET_STALL_REPORT_MS}ms at stage "${stage.name}".`,
        );
      }, GET_STALL_REPORT_MS);
      const deadline = setTimeout(() => {
        const message = `${label} abandoned after ${GET_HARD_DEADLINE_MS}ms stuck at stage "${stage.name}"`;
        console.error(`[binance-transport] ${message} — a bound in the read path failed to fire.`);
        reject(new BinanceReadDeadlineError(message));
      }, GET_HARD_DEADLINE_MS);
      report.unref?.();
      deadline.unref?.();
      run.then(resolve, reject).finally(() => {
        clearTimeout(report);
        clearTimeout(deadline);
      });
    });
  }

  /** Pace queued GETs only; mutation paths retain immediate risk-reducing priority. */
  private async paceQueuedRead(): Promise<void> {
    const gapMs = this.readDispatchMinGapMs;
    if (gapMs <= 0) return;
    const now = this.nowMs();
    const dispatchAt = Math.max(now, this.nextReadDispatchAtMs);
    this.nextReadDispatchAtMs = dispatchAt + gapMs;
    const waitMs = dispatchAt - now;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  /** Adopt any ban recorded by a previous Testnet release before dispatching. */
  private adoptHostTestnetRateLimitState(): BinanceUsdMTestnetRateLimitStatus | null {
    const shared = this.testnetReadCoordinator?.status() ?? null;
    if (!shared) return null;
    if (shared.lastHttpStatus !== null) this.lastRateLimitHttpStatus = shared.lastHttpStatus;
    if (shared.lastFailure !== null) this.lastRateLimitFailure = shared.lastFailure;
    if (shared.lastEndpoint !== null) this.lastRateLimitEndpoint = shared.lastEndpoint;
    if (shared.lastRequestKind !== null) this.lastRateLimitRequestKind = shared.lastRequestKind;
    if (shared.lastRequestCaller !== null) this.lastRateLimitRequestCaller = shared.lastRequestCaller;
    const sharedRetryAtMs = Date.parse(shared.retryAt ?? "");
    if (Number.isFinite(sharedRetryAtMs)) {
      this.rateLimitCooldownUntilMs = Math.max(this.rateLimitCooldownUntilMs, sharedRetryAtMs);
    }
    return shared;
  }

  private assertRateLimitCircuitClosed(): void {
    this.adoptHostTestnetRateLimitState();
    const now = this.nowMs();
    if (this.rateLimitCooldownUntilMs <= now) return;
    const retryAt = new Date(this.rateLimitCooldownUntilMs).toISOString();
    throw new BinanceFuturesPrivateError(
      "429",
      `rate limited (HTTP ${this.lastRateLimitHttpStatus ?? 418}); transport cooldown until ${retryAt}`,
      { httpStatus: this.lastRateLimitHttpStatus ?? 418, retryAt },
    );
  }

  private async registerRateLimit(
    response: Response,
    bodyText: string,
    provenance: BinanceTransportRequestProvenance,
  ): Promise<BinanceFuturesPrivateError> {
    const now = this.nowMs();
    const status = response.status === 418 ? 418 : 429;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now);
    const banUntilMs = parseBanUntilMs(bodyText);
    const fallbackMs = status === 418 ? HTTP_418_FALLBACK_COOLDOWN_MS : HTTP_429_FALLBACK_COOLDOWN_MS;
    const retryUntilMs = Math.max(
      now + fallbackMs,
      retryAfterMs === null ? 0 : now + retryAfterMs,
      banUntilMs ?? 0,
    );
    this.rateLimitCooldownUntilMs = Math.max(this.rateLimitCooldownUntilMs, retryUntilMs);
    this.lastRateLimitHttpStatus = status;
    this.lastRateLimitFailure = `rate limited (HTTP ${status})`;
    this.lastRateLimitEndpoint = provenance.endpoint;
    this.lastRateLimitRequestKind = provenance.requestKind;
    this.lastRateLimitRequestCaller = provenance.requestCaller;
    // Persist the venue's actual expiry before returning the error. A guarded
    // restart/cutover therefore inherits the ban instead of immediately
    // re-probing Binance and extending it.
    try {
      await this.testnetReadCoordinator?.registerRateLimit({
        status,
        retryUntilMs,
        failure: this.lastRateLimitFailure,
        endpoint: provenance.endpoint,
        requestKind: provenance.requestKind,
        requestCaller: provenance.requestCaller,
      });
    } catch {
      // Keep the local fail-closed circuit and the original exchange error
      // authoritative even if the diagnostic state volume is temporarily bad.
    }
    const retryAt = new Date(this.rateLimitCooldownUntilMs).toISOString();
    return new BinanceFuturesPrivateError(
      "429",
      `rate limited (HTTP ${status}); transport cooldown until ${retryAt}`,
      { httpStatus: status, retryAt },
    );
  }

  private async dispatchRawRequest(
    method: "GET" | "POST" | "DELETE",
    url: string,
    signed: boolean,
    provenance: BinanceTransportRequestProvenance,
    externalSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) abortFromExternalSignal();
    else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let bodyText: string;
    try {
      // Time-sync samples must begin at the actual network dispatch, not at
      // the start of a potentially long host-wide Testnet queue. Otherwise a
      // healthy 30-second queue is misread as a 15-second host clock drift and
      // all subsequent signed reads fail closed for the wrong reason.
      onDispatch?.();
      response = await this.fetchImpl(url, {
        method,
        headers: signed ? { "X-MBX-APIKEY": this.apiKey } : undefined,
        signal: controller.signal,
      });
      // `fetch()` resolves on headers. Keep the abort armed through body
      // consumption so a stalled Binance stream cannot pin transportTail (and
      // the time-sync / entry paths queued behind it) forever.
      bodyText = await response.text();
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw new BinanceFuturesPrivateError(
        aborted ? "timeout" : "network",
        aborted
          ? externalSignal?.aborted
            ? "request aborted by executor entry-deadline watchdog"
            : `request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `network failure: ${(error as Error)?.message ?? "unknown"}`,
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }

    // Record a ban FIRST. Feedback must never hide the authoritative exchange cooldown.
    const usedWeight = parseUsedWeight1m(response.headers);
    const rateLimitError = response.status === 429 || response.status === 418
      ? await this.registerRateLimit(response, bodyText, provenance) : null;
    if (this.testnetReadCoordinator) {
      try {
        await this.testnetReadCoordinator.recordDispatchResponse({
          method, endpoint: provenance.endpoint, requestCaller: provenance.requestCaller,
          estimatedWeight: method === "GET" ? estimateTestnetReadWeight(new URL(url).pathname, new URL(url).searchParams) : 0,
          usedWeight1m: usedWeight, httpStatus: response.status, serverDate: response.headers.get("date"),
        });
      } catch (error) {
        // Preserve accepted mutation results (unknown order status must not provoke a resend).
        if (!rateLimitError && method === "GET") throw error;
        console.warn("[binance-transport] Testnet response evidence persistence failed");
      }
    }
    if (usedWeight !== null) {
      await this.testnetReadCoordinator
        ?.recordVenueWeight(
          weightPoolFor(provenance.requestKind, provenance.endpoint),
          usedWeight,
          this.nowMs(),
        );
    }
    if (rateLimitError) throw rateLimitError;
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
  private async requestPublic(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { onDispatch?: () => void } = {},
  ): Promise<unknown> {
    const qs = buildQueryString(params);
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= GET_MAX_RETRIES; attempt++) {
      try {
        return await this.rawRequest("GET", url, false, undefined, this.requestProvenance(path, false), options.onDispatch);
      } catch (error) {
        lastError = error;
        if (!shouldRetryGet(error) || attempt === GET_MAX_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async requestSigned(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { allowUnsyncedRiskReduction?: boolean; allowUnsyncedRead?: boolean; signal?: AbortSignal; onDispatch?: (atMs: number) => void } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      throw new BinanceFuturesPrivateError("timeout", "request aborted by executor entry-deadline watchdog");
    }
    // A durable Testnet ban must block before a cold /time sync too. Otherwise
    // a restart would correctly suppress the signed endpoint but still
    // repeatedly probe Binance while its IP cooldown is active.
    this.assertRateLimitCircuitClosed();
    // A cold worker normally proves its server-time offset before it sends any
    // signed request.  The sole exception is an operation Binance itself
    // guarantees cannot increase exposure: cancelling an order or a
    // reduce-only order.  During a Testnet GET backlog, waiting for /time here
    // used to leave an already-confirmed partial basket unprotected even
    // though the host clock is ordinarily NTP-synchronised.  Send the
    // risk-reducing request with the local clock instead; an inaccurate clock
    // is safely rejected by Binance (-1021), never turned into an entry.
    // This exemption applies even when an earlier background signed GET has
    // already started a *stale* /time refresh. Waiting on that in-flight GET
    // was enough to keep a newly discovered partial fill exposed.
    const mayUseLocalClock = options.allowUnsyncedRiskReduction || (method === "GET" && options.allowUnsyncedRead === true);
    if (!mayUseLocalClock) {
      await this.ensureTimeSync();
      this.assertClockSkewOk();
    }
    if (options.signal?.aborted) {
      throw new BinanceFuturesPrivateError("timeout", "request aborted by executor entry-deadline watchdog");
    }
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
          return await this.rawRequest("GET", buildSignedUrl, true, undefined, this.requestProvenance(path, true));
        } catch (error) {
          lastError = error;
          if (
            error instanceof BinanceFuturesPrivateError
            && error.binanceCode === -1021
            && !options.allowUnsyncedRead
            && attempt < GET_MAX_RETRIES
          ) {
            // 2026-07-12 fix: forceTimeSync() itself hits the network (/fapi/v1/time) and can throw —
            // previously that throw escaped this catch block uncaught, aborting the ENTIRE retry loop
            // (never reaching `throw lastError`) and replacing the meaningful original -1021 with an
            // unrelated network error. Best-effort only: worst case the stale offset still triggers
            // another -1021 next attempt, caught the same way, same as if this resync had never run.
            try {
              await this.forceTimeSync();
            } catch {
              /* best-effort re-sync — original -1021 still drives the retry below */
            }
            this.assertClockSkewOk();
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            continue;
          }
          if (!shouldRetryGet(error) || attempt === GET_MAX_RETRIES) throw error;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
      throw lastError;
    }
    // POST/DELETE: exactly one attempt — the engine owns retries via idempotent client ids.
    try {
      return await this.rawRequest(
        method,
        buildSignedUrl(),
        true,
        options.signal,
        this.requestProvenance(path, true),
        () => { try { options.onDispatch?.(this.nowMs()); } catch { /* Recording must not suppress an order. */ } },
      );
    } catch (error) {
      if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -1021) {
        // Best-effort resync for the NEXT signed call — this call is failing with -1021 regardless,
        // so a resync failure here must not replace the original error being rethrown below.
        if (options.allowUnsyncedRiskReduction) {
          // Do not turn a rejected *risk-reducing* request into an unbounded
          // wait behind a cold GET queue. The next attempt can use this
          // background resync once it finishes; this attempt stays a clean,
          // visible failure with no order submitted.
          void this.forceTimeSync().catch(() => { /* best-effort */ });
        } else {
          try {
            await this.forceTimeSync();
          } catch {
            /* best-effort — see GET branch above */
          }
        }
      }
      throw error;
    }
  }

  // ── time sync / skew guard ─────────────────────────────────────────────────

  async ensureTimeSync(): Promise<void> {
    if (this.nowMs() - this.lastTimeSyncAtMs < TIME_SYNC_TTL_MS) return;
    if (this.timeSyncInFlight) return this.timeSyncInFlight;
    const task = (async (): Promise<void> => {
      try {
        await this.forceTimeSync();
      } catch (error) {
        // 2026-07-12 fix: this ran unconditionally before EVERY signed request, uncaught — a single
        // transient hiccup hitting the public /fapi/v1/time endpoint aborted the request outright with
        // ZERO retry, even for the GET path which otherwise retries several times. Binance's own
        // recvWindow/signature check (and assertClockSkewOk below, using the LAST successfully measured
        // skew) are the actual safety net against a truly-drifted clock, so a periodic-refresh miss is
        // safe to ride out on the stale-but-recent offset. Only fail closed when there has NEVER been a
        // successful sync (lastTimeSyncAtMs still 0): lastMeasuredSkewMs's 0 default would otherwise
        // silently pass assertClockSkewOk() as if skew were known-good when it is actually unknown.
        if (this.lastTimeSyncAtMs === 0) throw error;
      }
    })();
    this.timeSyncInFlight = task;
    try {
      await task;
    } finally {
      if (this.timeSyncInFlight === task) {
        this.timeSyncInFlight = null;
      }
    }
  }

  getRateLimitStatus(): BinanceFuturesRateLimitStatus {
    const shared = this.adoptHostTestnetRateLimitState();
    const now = this.nowMs();
    return {
      coolingDown: this.rateLimitCooldownUntilMs > now,
      retryAt: this.rateLimitCooldownUntilMs > now ? new Date(this.rateLimitCooldownUntilMs).toISOString() : null,
      lastHttpStatus: this.lastRateLimitHttpStatus,
      lastFailure: this.lastRateLimitFailure,
      coordination: shared?.coordination ?? null,
      dispatchGuard: shared?.dispatchGuard ?? null,
      dispatchWeightBudget: shared?.dispatchWeightBudget ?? null,
      dispatchHighWater: shared?.dispatchHighWater ?? null,
      dispatchLocalWeight60s: shared?.dispatchLocalWeight60s ?? null,
      globalReadGapMs: shared?.globalReadGapMs ?? null,
      // Surfaced so an operator can see the pacing the transport is ACTUALLY using and what the
      // venue reports it has spent, instead of inferring either from latency.
      signedReadGapMs: shared?.signedReadGapMs ?? null,
      venueWeightLimitPerMin: shared?.venueWeightLimitPerMin ?? null,
      venueUsedWeight1m: shared?.venueUsedWeight1m ?? null,
      venueWeightBand: shared?.venueWeightBand ?? null,
      marketDataReadGapMs: shared?.marketDataReadGapMs ?? null,
      venueUsedWeightMarketData: shared?.venueUsedWeightMarketData ?? null,
      venueWeightBandMarketData: shared?.venueWeightBandMarketData ?? null,
      venueUsedWeightSigned: shared?.venueUsedWeightSigned ?? null,
      venueWeightBandSigned: shared?.venueWeightBandSigned ?? null,
      lastEndpoint: this.lastRateLimitEndpoint,
      lastRequestKind: this.lastRateLimitRequestKind,
      lastRequestCaller: this.lastRateLimitRequestCaller,
    };
  }

  private async forceTimeSync(): Promise<void> {
    let dispatchedAtMs = this.nowMs();
    const parsed = await this.requestPublic("/fapi/v1/time", {}, {
      onDispatch: () => {
        dispatchedAtMs = this.nowMs();
      },
    });
    const after = this.nowMs();
    const serverTime = toNum((parsed as { serverTime?: unknown })?.serverTime);
    if (serverTime <= 0) {
      throw new BinanceFuturesPrivateError("invalid_response", "server time missing from /fapi/v1/time");
    }
    const midpoint = (dispatchedAtMs + after) / 2;
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

  private assertAstraTestnet(): void {
    if (this.env !== "testnet") {
      throw new BinanceFuturesPrivateError("invalid_response", "Astra reads are TESTNET ONLY");
    }
  }

  /** One same-venue batch GET; no per-symbol fan-out or strategy filtering. */
  async getAstraTicker24h(): Promise<AstraTicker24h[]> {
    this.assertAstraTestnet();
    const parsed = await this.requestPublic("/fapi/v1/ticker/24hr");
    if (!Array.isArray(parsed)) {
      throw new BinanceFuturesPrivateError("invalid_response", "Astra 24h ticker batch response is not an array");
    }
    const result: AstraTicker24h[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.symbol !== "string" || !row.symbol.trim()) continue;
      result.push({
        symbol: row.symbol,
        priceChangePercent: toAstraNumberOrNull(row.priceChangePercent),
        quoteVolume: toAstraNumberOrNull(row.quoteVolume),
        highPrice: toAstraNumberOrNull(row.highPrice),
        lowPrice: toAstraNumberOrNull(row.lowPrice),
        lastPrice: toAstraNumberOrNull(row.lastPrice),
        closeTime: toAstraNumberOrNull(row.closeTime),
      });
    }
    return result;
  }

  /** Current mark/funding context, not settled account funding income. */
  async getAstraPremiumIndexes(): Promise<AstraPremiumIndex[]> {
    this.assertAstraTestnet();
    const parsed = await this.requestPublic("/fapi/v1/premiumIndex");
    if (!Array.isArray(parsed)) {
      throw new BinanceFuturesPrivateError("invalid_response", "Astra premium-index batch response is not an array");
    }
    const result: AstraPremiumIndex[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.symbol !== "string" || !row.symbol.trim()) continue;
      result.push({
        symbol: row.symbol,
        markPrice: toAstraNumberOrNull(row.markPrice),
        indexPrice: toAstraNumberOrNull(row.indexPrice),
        lastFundingRate: toAstraNumberOrNull(row.lastFundingRate),
        nextFundingTime: toAstraNumberOrNull(row.nextFundingTime),
        time: toAstraNumberOrNull(row.time),
      });
    }
    return result;
  }

  /** Account-specific fee rates through the existing signed GET queue. */
  async getAstraCommissionRate(symbol: string): Promise<AstraCommissionRate> {
    this.assertAstraTestnet();
    if (typeof symbol !== "string" || !symbol.trim() || /[\s\p{C}]/u.test(symbol)) {
      throw new BinanceFuturesPrivateError("invalid_response", "Astra commission rate requires an exact symbol");
    }
    const parsed = await this.requestSigned("GET", "/fapi/v1/commissionRate", { symbol });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BinanceFuturesPrivateError("invalid_response", `Astra commission rate missing for ${symbol}`);
    }
    const row = parsed as Record<string, unknown>;
    const makerCommissionRate = toAstraNumberOrNull(row.makerCommissionRate);
    const takerCommissionRate = toAstraNumberOrNull(row.takerCommissionRate);
    if (row.symbol !== symbol || makerCommissionRate === null || takerCommissionRate === null ||
        makerCommissionRate < 0 || takerCommissionRate < 0) {
      throw new BinanceFuturesPrivateError("invalid_response", `Astra commission rate invalid or mismatched for ${symbol}`);
    }
    return { symbol, makerCommissionRate, takerCommissionRate };
  }

  /** Public book from the SAME testnet/mainnet USD-M base selected for private execution. */
  async getBookTicker(symbol: string): Promise<FuturesExecutionBookTicker> {
    const parsed = await this.requestPublic("/fapi/v1/ticker/bookTicker", { symbol });
    const row = parsed as Record<string, unknown> | null;
    if (!row || typeof row !== "object") {
      throw new BinanceFuturesPrivateError("invalid_response", `book ticker missing for ${symbol}`);
    }
    const positiveOrNull = (value: unknown): number | null => {
      const parsedValue = toNum(value);
      return parsedValue > 0 ? parsedValue : null;
    };
    return {
      bid: positiveOrNull(row.bidPrice),
      ask: positiveOrNull(row.askPrice),
      bidQty: positiveOrNull(row.bidQty),
      askQty: positiveOrNull(row.askQty),
      time: toNum(row.time) > 0 ? toNum(row.time) : null,
    };
  }

  /**
   * Fetches the selected USD-M venue's complete top-of-book snapshot once, then
   * returns only the requested contracts.  Cross-sectional entry uses this
   * instead of six individually queued GETs: every leg is priced from the
   * same exchange response, and a slow request remains fail-closed upstream
   * rather than silently pricing only the early legs in the transport queue.
   */
  async getExecutionBookTickers(symbols: readonly string[]): Promise<Map<string, FuturesExecutionBookTicker>> {
    const requested = new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0),
    );
    const books = new Map<string, FuturesExecutionBookTicker>();
    if (requested.size === 0) return books;

    // Binance USD-M returns an array when `symbol` is omitted.  One request is
    // both lower-weight than per-leg fan-out and immune to this client's GET
    // serialization making later basket legs miss the old 750ms app deadline.
    const parsed = await this.requestPublic("/fapi/v1/ticker/bookTicker");
    if (!Array.isArray(parsed)) {
      throw new BinanceFuturesPrivateError("invalid_response", "execution book-ticker batch response is not an array");
    }
    const positiveOrNull = (value: unknown): number | null => {
      const parsedValue = toNum(value);
      return parsedValue > 0 ? parsedValue : null;
    };
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
      if (!requested.has(symbol)) continue;
      books.set(symbol, {
        bid: positiveOrNull(row.bidPrice),
        ask: positiveOrNull(row.askPrice),
        bidQty: positiveOrNull(row.bidQty),
        askQty: positiveOrNull(row.askQty),
        time: toNum(row.time) > 0 ? toNum(row.time) : null,
      });
    }
    return books;
  }

  /**
   * Public USD-M mark from the SAME selected execution environment.  This must
   * not be substituted with Binance spot's PEPEUSDT price for multiplier perps.
   */
  async getMarkPrice(symbol: string): Promise<number | null> {
    const parsed = await this.requestPublic("/fapi/v1/premiumIndex", { symbol });
    const row = parsed as Record<string, unknown> | null;
    if (!row || typeof row !== "object") {
      throw new BinanceFuturesPrivateError("invalid_response", `premium index missing for ${symbol}`);
    }
    const markPrice = toNum(row.markPrice);
    return markPrice > 0 ? markPrice : null;
  }

  /**
   * Read USD-M candles from the selected execution environment.  It never falls
   * back to spot data: range levels must be executable on the venue we trade.
   *
   * The Daily Range lane is a deliberate exception as of 2026-09-04 and reads mainnet candles even
   * on testnet -- see `readKlines` in daily-4h-range-acceptance-lane.ts. That is a wiring decision
   * made at construction, not a fallback inside this method: this method still only ever talks to
   * the environment its client was built for.
   */
  async getKlines(
    symbol: string,
    interval: "1m" | "5m" | "1h" | "4h" | "1d",
    opts: { startTime?: number; endTime?: number; limit?: number } = {},
  ): Promise<FuturesKline[]> {
    const parsed = await this.requestPublic("/fapi/v1/klines", {
      symbol,
      interval,
      startTime: opts.startTime,
      endTime: opts.endTime,
      limit: opts.limit,
    });
    if (!Array.isArray(parsed)) {
      throw new BinanceFuturesPrivateError("invalid_response", `klines response missing for ${symbol}/${interval}`);
    }
    const candles: FuturesKline[] = [];
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 7) continue;
      const openTime = toNum(row[0]);
      const open = toNum(row[1]);
      const high = toNum(row[2]);
      const low = toNum(row[3]);
      const close = toNum(row[4]);
      const volume = toNum(row[5]);
      const closeTime = toNum(row[6]);
      if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) {
        continue;
      }
      candles.push({ openTime, closeTime, open, high, low, close, volume });
    }
    return candles;
  }

  async getExchangeFilters(
    _priority: "EXECUTION" | "BACKGROUND" = "BACKGROUND",
  ): Promise<Map<string, FuturesSymbolFilters>> {
    if (this.exchangeFiltersCache && this.nowMs() - this.exchangeFiltersCacheAtMs < EXCHANGE_FILTERS_TTL_MS) {
      return new Map(this.exchangeFiltersCache);
    }
    if (this.exchangeFiltersInFlight) return new Map(await this.exchangeFiltersInFlight);

    const task = (async (): Promise<Map<string, FuturesSymbolFilters>> => {
      const parsed = await this.requestPublic("/fapi/v1/exchangeInfo");
      const symbols = (parsed as { symbols?: unknown })?.symbols;
      const out = new Map<string, FuturesSymbolFilters>();
      if (!Array.isArray(symbols)) return out;
      for (const s of symbols) {
        const sym = s as {
          symbol?: string;
          status?: string;
          contractType?: string;
          quoteAsset?: string;
          pricePrecision?: number;
          quantityPrecision?: number;
          filters?: Array<{ filterType?: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string }>;
        };
        // This cache gates executable USD-M symbols.  A symbol merely present in
        // exchangeInfo is not enough: delivery, settling, inactive, and non-USDT
        // contracts must be absent so every caller fails closed before sizing.
        if (
          !sym.symbol ||
          sym.status !== "TRADING" ||
          sym.contractType !== "PERPETUAL" ||
          sym.quoteAsset !== "USDT" ||
          !Array.isArray(sym.filters)
        ) continue;
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
      return out;
    })();
    this.exchangeFiltersInFlight = task;
    try {
      return new Map(await task);
    } finally {
      if (this.exchangeFiltersInFlight === task) this.exchangeFiltersInFlight = null;
    }
  }

  private async getSymbolFilters(
    symbol: string,
    priority: "EXECUTION" | "BACKGROUND" = "BACKGROUND",
  ): Promise<FuturesSymbolFilters | null> {
    const filters = await this.getExchangeFilters(priority);
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

  async getPositions(
    symbol?: string,
    options: { allowUnsyncedRead?: boolean } = {},
  ): Promise<FuturesPosition[]> {
    const parsed = await this.requestSigned(
      "GET",
      "/fapi/v2/positionRisk",
      symbol ? { symbol } : {},
      { allowUnsyncedRead: options.allowUnsyncedRead },
    );
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

  async getOpenOrders(
    symbol?: string,
    options: { allowUnsyncedRead?: boolean } = {},
  ): Promise<FuturesOrder[]> {
    const parsed = await this.requestSigned(
      "GET",
      "/fapi/v1/openOrders",
      symbol ? { symbol } : {},
      { allowUnsyncedRead: options.allowUnsyncedRead },
    );
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

  /**
   * Same endpoint as queryOrder, looked up by the client-supplied idempotency key instead of the
   * exchange-assigned orderId — Binance's /fapi/v1/order accepts EITHER as an alternative lookup key.
   * Added for account-exposure-coordinator.ts's restart/staleness reconciliation: a reservation
   * persisted before an order-placement attempt knows its own clientOrderId (it must, by
   * construction — see ExposureReservation.clientOrderId) but has no orderId to query by if the
   * process died before placeOrder()'s response (containing the exchange-assigned orderId) was ever
   * recorded. Reuses the exact same signed GET path queryOrder does (requestSigned, GET retries on
   * timeout/429/network, the clock-skew guard) — this file's own header comment states it is "the
   * ONLY module that talks to Binance private endpoints" for a reason; a second, hand-rolled request
   * path here would be a real regression risk, not just style.
   */
  async queryOrderByClientId(symbol: string, origClientOrderId: string): Promise<FuturesOrder> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/order", { symbol, origClientOrderId });
    return this.mapOrder(parsed);
  }

  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    const throwIfEntryDeadlineAborted = () => {
      if (params.signal?.aborted) {
        throw new BinanceFuturesPrivateError("timeout", "order suppressed by executor entry-deadline watchdog");
      }
    };
    throwIfEntryDeadlineAborted();
    // Order placement is execution-critical on both venues.  The Testnet
    // transport honours this priority; Mainnet keeps the same public contract.
    // A reduce-only MARKET quantity is an exchange-confirmed quantity from the
    // leg being flattened.  On a cold worker it is therefore safer to submit
    // that exact quantity than to block a rollback behind exchangeInfo.  Every
    // entry and every priced/conditional reduce-only order still refreshes the
    // normal exchange filter cache before it is sent.
    const canUseKnownReduceOnlyQty = params.reduceOnly === true && params.type === "MARKET";
    const cachedFilters = this.exchangeFiltersCache && this.nowMs() - this.exchangeFiltersCacheAtMs < EXCHANGE_FILTERS_TTL_MS
      ? this.exchangeFiltersCache.get(params.symbol) ?? null
      : null;
    const filters = canUseKnownReduceOnlyQty ? cachedFilters : await this.getSymbolFilters(params.symbol, "EXECUTION");
    throwIfEntryDeadlineAborted();
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
    }, {
      allowUnsyncedRiskReduction: canUseKnownReduceOnlyQty,
      onDispatch: params.onDispatch,
      ...(params.signal ? { signal: params.signal } : {}),
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
    await this.requestSigned("DELETE", "/fapi/v1/order", { symbol, orderId }, { allowUnsyncedRiskReduction: true });
  }

  /**
   * Returns Binance's terminal cancellation response so maker-entry recovery
   * can use its actual filled quantity without issuing a separate status GET.
   */
  async cancelOrderAndRead(symbol: string, orderId: string): Promise<FuturesOrder> {
    const parsed = await this.requestSigned(
      "DELETE",
      "/fapi/v1/order",
      { symbol, orderId },
      { allowUnsyncedRiskReduction: true },
    );
    return this.mapOrder(parsed);
  }

  /**
   * Cancels one order by its durable client-supplied id. This is the safe
   * recovery path when Binance accepted a POST but its response (and therefore
   * exchange orderId) was lost before the executor could persist it.
   */
  async cancelOrderByClientIdAndRead(symbol: string, origClientOrderId: string): Promise<FuturesOrder> {
    const parsed = await this.requestSigned(
      "DELETE",
      "/fapi/v1/order",
      { symbol, origClientOrderId },
      { allowUnsyncedRiskReduction: true },
    );
    return this.mapOrder(parsed);
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

  async getUserTrades(symbol: string, opts: { startTime?: number; limit?: number; fromId?: string } = {}): Promise<FuturesUserTrade[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/userTrades", {
      symbol,
      startTime: opts.startTime,
      fromId: opts.fromId,
      limit: opts.limit ?? 100,
    });
    if (!Array.isArray(parsed)) return [];
    // The `maker: boolean | undefined` / `tradeId: string` intersection is a deliberate
    // compile-time guard, not noise: both fields are OPTIONAL for consumers (so the many existing
    // hand-built test fakes stay valid), but requiring the KEYS here means deleting either line
    // below is a tsc error under `npx tsc --noEmit -p apps/api`. Without it, a future edit could
    // silently drop the field again exactly as the original mapper did, and nothing would complain
    // (this file's own tsconfig only includes src/**, so nothing in test/ can act as that guard).
    return parsed.map((t): FuturesUserTrade & { maker: boolean | undefined; tradeId: string } => ({
      symbol: String((t as { symbol?: unknown }).symbol ?? ""),
      orderId: toStrId((t as { orderId?: unknown }).orderId),
      // Binance calls the per-fill id `id` (orderId is the parent ORDER). Stringified via the same
      // helper as orderId so the persisted type is stable; see FuturesUserTrade.tradeId for why it
      // deliberately does NOT go through preserveOrderIdPrecision.
      tradeId: toStrId((t as { id?: unknown }).id),
      price: toNum((t as { price?: unknown }).price),
      qty: toNum((t as { qty?: unknown }).qty),
      realizedPnl: toNum((t as { realizedPnl?: unknown }).realizedPnl),
      commission: toNum((t as { commission?: unknown }).commission),
      commissionAsset: String((t as { commissionAsset?: unknown }).commissionAsset ?? ""),
      time: toNum((t as { time?: unknown }).time),
      // NOT `Boolean(t.maker)` — see the field's doc comment: coercing an absent/garbage value to
      // `false` would fabricate the exact "we were taker" confirmation this field exists to supply.
      maker: typeof (t as { maker?: unknown }).maker === "boolean" ? ((t as { maker: boolean }).maker) : undefined,
    }));
  }

  /**
   * Account income ledger (/fapi/v1/income) — realized PnL, funding fees, commission, and any
   * other exchange-side income/expense entries, account-wide (no symbol filter, matching how the
   * engine's own internal ledger accumulates across all symbols/lanes). READ-ONLY signed GET,
   * same requestSigned/retry path as every other GET here. Used exclusively by
   * wallet-reconciliation.ts to compare against the internal LiveDailyLedger — never by any
   * order-placement or risk-control path.
   */
  async getIncomeHistory(
    opts: { startTime?: number; endTime?: number; incomeType?: string; limit?: number } = {},
  ): Promise<FuturesIncomeEntry[]> {
    const parsed = await this.requestSigned("GET", "/fapi/v1/income", {
      startTime: opts.startTime,
      endTime: opts.endTime,
      incomeType: opts.incomeType,
      limit: opts.limit ?? 1000,
    });
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      symbol: String((entry as { symbol?: unknown }).symbol ?? ""),
      incomeType: String((entry as { incomeType?: unknown }).incomeType ?? ""),
      income: toNum((entry as { income?: unknown }).income),
      asset: String((entry as { asset?: unknown }).asset ?? ""),
      time: toNum((entry as { time?: unknown }).time),
      // Diagnostic id only — see FuturesIncomeEntry.tranId's doc comment for why this
      // deliberately does NOT go through preserveOrderIdPrecision.
      tranId: toStrId((entry as { tranId?: unknown }).tranId),
      info: String((entry as { info?: unknown }).info ?? ""),
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

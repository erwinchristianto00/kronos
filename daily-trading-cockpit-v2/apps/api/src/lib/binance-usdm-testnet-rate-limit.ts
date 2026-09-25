/**
 * Host-wide Testnet USD-M read coordinator.
 *
 * Binance applies request weight at the source IP, while a PM2 process-local
 * queue only sees its own requests.  This small durable lease is shared by
 * every current and future Testnet API release through a stable directory
 * outside the versioned release tree.  It never controls Mainnet and never
 * delays a POST/DELETE risk-reducing exit.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// 2026-09-04. The 30s figure (two reads a MINUTE, host-wide) was set after 418 bans at an earlier
// 10-second cap, and it was the wrong control entirely.
//
//  - Binance USD-M meters REQUEST WEIGHT, not request count: 2400 weight/min per IP. A markPrice
//    read is weight 1; /fapi/v1/klines with a large limit is weight 10. Pacing by count charged a
//    weight-1 read the same as a weight-10 one. The ban this cap was built for was on klines
//    (`lastEndpoint: /fapi/v1/klines`) -- a weight problem misdiagnosed as a frequency problem.
//  - Two reads a minute is roughly 2-20 weight/min: under one percent of the venue's allowance.
//    It could not run a 20-symbol strategy, and the queue it created wedged the instance for
//    hours (see the watermark ceiling below).
//  - The multi-worker contention that justified it is gone: the other testnet workers on this IP
//    (challengers, staging, collector, lifecycle) are all stopped.
//
// So pace fast by default and let the VENUE'S OWN accounting be the brake -- see
// recordVenueWeight() below, which reads X-MBX-USED-WEIGHT-1M off every response. A measured
// control loop beats any constant guessed from the outside.
// POST/DELETE protective exits remain immediate and are never delayed by this queue.
const DEFAULT_GLOBAL_READ_GAP_MS = 1_000;

/**
 * The venue's published per-IP allowance, and where we choose to stand off from it.
 *
 * SOFT is where pacing widens; HARD is where the lane waits out the current weight minute
 * altogether. Both are read from what Binance itself reports, so this self-corrects if the real
 * allowance differs from the documented one, or if another process on this IP is also spending it.
 */
/**
 * Historical observations: different endpoint classes returned different header values.
 *
 * Measured 2026-09-04 against testnet.binancefuture.com, one second apart:
 *   /fapi/v1/time                                 -> x-mbx-used-weight-1m: 1
 *   /fapi/v1/klines?limit=500                     -> x-mbx-used-weight-1m: 294
 *   /fapi/v1/time (immediately after)             -> x-mbx-used-weight-1m: 2
 *
 * These absolute readings do NOT establish separate venue allowances or per-call costs.
 * Retain the classes for queue fairness/diagnostics only. The final dispatch budget is shared
 * across classes and low headers cannot clear a same-minute high-water observation.
 */
export type BinanceUsdMWeightPool = "SIGNED" | "PUBLIC" | "MARKET_DATA";

const MARKET_DATA_ENDPOINT_PREFIXES = [
  "/fapi/v1/klines",
  "/fapi/v1/continuousKlines",
  "/fapi/v1/markPriceKlines",
  "/fapi/v1/indexPriceKlines",
  "/fapi/v1/depth",
  "/fapi/v1/aggTrades",
  "/fapi/v1/historicalTrades",
];

/**
 * Diagnostic class for this request; NOT an independent venue allowance.
 *
 * Measured 2026-09-04 from this VPS, at the same moment: the running process recorded
 * x-mbx-used-weight-1m of 465-3376 from its SIGNED reads while an unsigned curl from the same host
 * read 2-5. The prior inference of an account-based SIGNED weight budget was unsupported.
 * Request weight is documented per IP; divergent response values remain diagnostic evidence,
 * not permission to spend independently or a measurement of one request's weight.
 */
export function weightPoolFor(requestKind: BinanceUsdMRequestKind, endpoint: string): BinanceUsdMWeightPool {
  if (requestKind === "SIGNED") return "SIGNED";
  const path = endpoint.split("?")[0];
  return MARKET_DATA_ENDPOINT_PREFIXES.some((prefix) => path.startsWith(prefix)) ? "MARKET_DATA" : "PUBLIC";
}

/**
 * Market data gets its own, far wider slot: at ~294 weight a call, four a minute is already half
 * the allowance. Everything else shares the cheap general pool and is paced by globalReadGapMs.
 */
const MARKET_DATA_READ_GAP_MS = 20_000;
const VENUE_WEIGHT_LIMIT_PER_MIN = 2_400;
const VENUE_WEIGHT_SOFT_LIMIT = 1_200;
const VENUE_WEIGHT_HARD_LIMIT = 1_920;
const VENUE_WEIGHT_SOFT_GAP_MULTIPLIER = 4;
const VENUE_WEIGHT_HARD_GAP_MULTIPLIER = 8;
/** A weight reading older than this says nothing about the current minute. */
const VENUE_WEIGHT_FRESH_MS = 90_000;
/** recordVenueWeight() runs on EVERY response; do not take the file lock that often. */
const VENUE_WEIGHT_PERSIST_MIN_GAP_MS = 3_000;
// Public market data and signed account truth share the venue/IP ban, but a long passive candle
// backlog must not starve position reconciliation forever. Keep a small cross-kind spacing while
// independently pacing each class at its own interval.
//
// 2026-09-04: was 5_000, sized when a lane slot was 30s and 5s was therefore small change. Against
// a 1s lane gap it became the DOMINANT constraint -- an alternating signed/public pattern would be
// spaced by this, not by either lane's own pacing, so account reads would still wait seconds for no
// venue-side reason. Its job is only to avoid two kinds leaving back-to-back.
const CROSS_KIND_DISPATCH_GAP_MS = 250;
/**
 * Signed account reads get their own, much shorter gap than passive candles.
 *
 * The 30s figure above was chosen when every read shared one effective queue, so it had to be
 * sized for the bulky side: public candles. Signed traffic is nothing like that — positions,
 * orders and balances, roughly one request a minute in practice (measured 2026-09-04 from the
 * lease's own per-caller attribution: 9 SIGNED reservations in 10 minutes). Pacing that at 30s
 * bought no protection from the venue and cost latency exactly where it hurts: account
 * reconciliation, the live-engine tick, and /api/live/account, which is why a Testnet account read
 * took 75s cold and the engine tick lagged minutes behind.
 *
 * This lowers QUEUEING DELAY, not the request rate: the rate is set by demand, and signed demand
 * is ~1/min. The cross-kind gap still spaces a signed read from a public one, and the public lane
 * keeps the full conservative interval, so the candle pressure that actually earned the 418s is
 * unchanged. Override with BINANCE_USDM_TESTNET_SIGNED_READ_GAP_MS.
 */
const DEFAULT_SIGNED_READ_GAP_MS = 1_000;
/**
 * How far ahead a lane may book before it is SATURATED rather than merely paced.
 *
 * `nextPublicReadDispatchAtMs` is a monotonic watermark: every reservation sets it to
 * `max(now, watermark) + gap`. Nothing ever pulls it back toward now, so a period of demand above
 * one-per-gap leaves the watermark permanently ahead of wall-clock, and it is durable state shared
 * across processes - a restart does not clear it. Measured 2026-09-04 on Testnet: the watermark sat
 * 1320s ahead, so every public read, including the ones the engine tick and /api/live/account need,
 * was scheduled 22 minutes out. Nothing errored. The tick simply slept, `errorStreak` stayed 0, and
 * the account endpoint hung past every client timeout.
 *
 * Past this ceiling the reservation is REFUSED instead of booked. That keeps the pacing guarantee
 * intact - a refusal never dispatches early - while making saturation immediate and attributable
 * instead of silent and twenty minutes deep. It also bounds the watermark itself: a slot beyond the
 * ceiling is never written, so the runaway cannot recur. A read answered five minutes late is not
 * worth having on a trading path anyway.
 */
const MAX_QUEUE_AHEAD_MS = 300_000;
const MAX_TRACKED_CALLERS = 24;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
// Bound legitimate dispatch-budget waits separately from a wedged fetch/queue.
export const TESTNET_DISPATCH_BUDGET_WAIT_MS = 65_000;
const WEIGHT_WINDOW_MS = 60_000;
const WINDOW_SETTLE_MS = 2_000;
const MAX_DISPATCH_EVIDENCE = 256;

export interface TestnetDispatchEvidence {
  atMs: number;
  phase: "DISPATCH" | "RESPONSE";
  method: string;
  endpoint: string;
  requestCaller: string | null;
  estimatedWeight: number;
  usedWeight1m?: number | null;
  httpStatus?: number;
  serverDate?: string | null;
}

/** Conservative request cost, not an inference from an absolute response counter. */
export function estimateTestnetReadWeight(endpoint: string, query: URLSearchParams): number {
  // Binance USD-M REST docs: batch ticker 40, batch premium index 10, account fees 20.
  if (endpoint === "/fapi/v1/ticker/24hr") return query.has("symbol") ? 1 : 40;
  if (endpoint === "/fapi/v1/premiumIndex") return query.has("symbol") ? 1 : 10;
  if (endpoint === "/fapi/v1/commissionRate") return 20;
  if (/Klines$|\/klines$/.test(endpoint)) {
    const limit = Number(query.get("limit") ?? 500);
    return limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
  }
  if (endpoint.endsWith("/depth")) {
    const limit = Number(query.get("limit") ?? 500);
    return limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20;
  }
  if (/\/(time|exchangeInfo)$/.test(endpoint)) return 1;
  if (/\/(positionRisk|balance|account)$/.test(endpoint)) return 5;
  if (/\/(userTrades|historicalTrades)$/.test(endpoint)) return 20;
  if (endpoint.endsWith("/income")) return 30;
  if (/\/(openOrders|openAlgoOrders)$/.test(endpoint)) return query.has("symbol") ? 1 : 40;
  if (/\/(order|algoOrder|leverageBracket)$/.test(endpoint)) return 1;
  // Unmapped endpoints reserve headroom instead of silently costing one.
  return 50;
}

/** Distinguishes an account-truth request from a public USD-M market-data request. */
export type BinanceUsdMRequestKind = "SIGNED" | "PUBLIC";

export interface BinanceUsdMTestnetRateLimitState {
  schemaVersion: 1;
  /** Legacy conservative ceiling retained for releases that predate per-kind lanes. */
  nextReadDispatchAtMs: number;
  nextSignedReadDispatchAtMs: number;
  nextPublicReadDispatchAtMs: number;
  /** Last reserved physical slot, used only to space a request of the other kind. */
  lastReservedDispatchAtMs: number;
  lastReservedRequestKind: BinanceUsdMRequestKind | null;
  cooldownUntilMs: number;
  lastHttpStatus: 418 | 429 | null;
  lastFailure: string | null;
  lastEndpoint: string | null;
  /** Request class that received the last 418/429, never a query string or credential. */
  lastRequestKind: BinanceUsdMRequestKind | null;
  /** First non-transport application frame captured for the last 418/429. */
  lastRequestCaller: string | null;
  /**
   * Reservation counts per calling site, so the lane's actual consumer is
   * visible without a deploy. The 418 fields above only ever name whoever
   * happened to be unlucky when the venue pushed back — on 2026-09-04 that
   * made a long-idle code path look like the cause while the real consumer
   * stayed invisible. Bounded to MAX_TRACKED_CALLERS entries.
   */
  reservationsByCaller: Record<string, number>;
  reservationTrackingSinceMs: number;
  /** Newest X-MBX-USED-WEIGHT-1M per venue counter, keyed by pool. */
  venueUsedWeightByPool: Record<BinanceUsdMWeightPool, { weight: number | null; atMs: number }>;
  updatedAtMs: number;
  dispatchBudget?: {
    highWater: { weight: number; atMs: number };
    debits: Array<{ atMs: number; weight: number }>;
    nextDispatchAtMs: number;
    recent: TestnetDispatchEvidence[];
    lastBanEvidence: TestnetDispatchEvidence[];
  };
}

export interface BinanceUsdMTestnetRateLimitStatus {
  dispatchGuard: "TESTNET_IP_WEIGHT_DISPATCH_V1";
  dispatchWeightBudget: number;
  dispatchHighWater: { weight: number; atMs: number };
  dispatchLocalWeight60s: number;
  coordination: "HOST_TESTNET_FILE_LEASE";
  directory: string;
  globalReadGapMs: number;
  signedReadGapMs: number;
  coolingDown: boolean;
  retryAt: string | null;
  lastHttpStatus: 418 | 429 | null;
  lastFailure: string | null;
  lastEndpoint: string | null;
  lastRequestKind: BinanceUsdMRequestKind | null;
  lastRequestCaller: string | null;
  nextReadDispatchAt: string | null;
  venueWeightLimitPerMin: number;
  marketDataReadGapMs: number;
  venueUsedWeight1m: number | null;
  venueWeightBand: VenueWeightPressure["band"];
  venueUsedWeightMarketData: number | null;
  venueWeightBandMarketData: VenueWeightPressure["band"];
  /** Signed response counter, independently paced by the same operational budget. */
  venueUsedWeightSigned: number | null;
  venueWeightBandSigned: VenueWeightPressure["band"];
}

export class BinanceUsdMTestnetCooldownError extends Error {
  readonly retryAtMs: number;
  readonly httpStatus: 418 | 429;
  readonly failure: string;
  readonly endpoint: string | null;
  readonly requestKind: BinanceUsdMRequestKind | null;
  readonly requestCaller: string | null;

  constructor(state: BinanceUsdMTestnetRateLimitState) {
    const httpStatus = state.lastHttpStatus ?? 418;
    const retryAtMs = state.cooldownUntilMs;
    super(`rate limited (HTTP ${httpStatus}); host Testnet transport cooldown until ${new Date(retryAtMs).toISOString()}`);
    this.name = "BinanceUsdMTestnetCooldownError";
    this.retryAtMs = retryAtMs;
    this.httpStatus = httpStatus;
    this.failure = state.lastFailure ?? `rate limited (HTTP ${httpStatus})`;
    this.endpoint = state.lastEndpoint;
    this.requestKind = state.lastRequestKind;
    this.requestCaller = state.lastRequestCaller;
  }
}

/** A lane whose booking watermark has run past MAX_QUEUE_AHEAD_MS: refuse, never queue. */
export class BinanceUsdMTestnetLaneSaturatedError extends Error {
  readonly requestKind: BinanceUsdMRequestKind;
  readonly requestCaller: string | null;
  /** How far ahead the lane had already booked when this request arrived. */
  readonly queueAheadMs: number;
  readonly ceilingMs: number;

  constructor(input: {
    requestKind: BinanceUsdMRequestKind;
    requestCaller: string | null;
    queueAheadMs: number;
    ceilingMs: number;
  }) {
    super(
      `host Testnet ${input.requestKind} read lane saturated: already booked `
      + `${Math.round(input.queueAheadMs / 1000)}s ahead (ceiling ${Math.round(input.ceilingMs / 1000)}s). `
      + "Refusing rather than queueing, so a caller cannot sleep past its own usefulness.",
    );
    this.name = "BinanceUsdMTestnetLaneSaturatedError";
    this.requestKind = input.requestKind;
    this.requestCaller = input.requestCaller;
    this.queueAheadMs = input.queueAheadMs;
    this.ceilingMs = input.ceilingMs;
  }
}

function defaultState(nowMs: number): BinanceUsdMTestnetRateLimitState {
  return {
    schemaVersion: 1,
    nextReadDispatchAtMs: 0,
    nextSignedReadDispatchAtMs: 0,
    nextPublicReadDispatchAtMs: 0,
    lastReservedDispatchAtMs: 0,
    lastReservedRequestKind: null,
    cooldownUntilMs: 0,
    lastHttpStatus: null,
    lastFailure: null,
    lastEndpoint: null,
    lastRequestKind: null,
    lastRequestCaller: null,
    reservationsByCaller: {},
    reservationTrackingSinceMs: nowMs,
    venueUsedWeightByPool: {
      SIGNED: { weight: null, atMs: 0 },
      PUBLIC: { weight: null, atMs: 0 },
      MARKET_DATA: { weight: null, atMs: 0 },
    },
    updatedAtMs: nowMs,
  };
}

function validState(value: unknown, nowMs: number): BinanceUsdMTestnetRateLimitState {
  if (!value || typeof value !== "object") return defaultState(nowMs);
  const row = value as Partial<BinanceUsdMTestnetRateLimitState>;
  const legacyNextReadDispatchAtMs = Number.isFinite(row.nextReadDispatchAtMs)
    ? Math.max(0, Number(row.nextReadDispatchAtMs))
    : 0;
  const trackedCallers = row.reservationsByCaller && typeof row.reservationsByCaller === "object"
    ? Object.fromEntries(
      Object.entries(row.reservationsByCaller as Record<string, unknown>)
        .filter(([, count]) => Number.isFinite(count))
        .map(([caller, count]) => [caller, Math.max(0, Math.round(Number(count)))]),
    )
    : {};
  return {
    schemaVersion: 1,
    nextReadDispatchAtMs: legacyNextReadDispatchAtMs,
    // V1 state had one shared timestamp. Adopt it for every lane on the
    // first V2-aware read so a cutover can only slow an old release, never
    // create a fresh burst at the host boundary.
    nextSignedReadDispatchAtMs: Number.isFinite(row.nextSignedReadDispatchAtMs)
      ? Math.max(0, Number(row.nextSignedReadDispatchAtMs))
      : legacyNextReadDispatchAtMs,
    nextPublicReadDispatchAtMs: Number.isFinite(row.nextPublicReadDispatchAtMs)
      ? Math.max(0, Number(row.nextPublicReadDispatchAtMs))
      : legacyNextReadDispatchAtMs,
    lastReservedDispatchAtMs: Number.isFinite(row.lastReservedDispatchAtMs)
      ? Math.max(0, Number(row.lastReservedDispatchAtMs))
      : 0,
    lastReservedRequestKind: row.lastReservedRequestKind === "SIGNED" || row.lastReservedRequestKind === "PUBLIC"
      ? row.lastReservedRequestKind
      : null,
    cooldownUntilMs: Number.isFinite(row.cooldownUntilMs) ? Math.max(0, Number(row.cooldownUntilMs)) : 0,
    lastHttpStatus: row.lastHttpStatus === 418 || row.lastHttpStatus === 429 ? row.lastHttpStatus : null,
    lastFailure: typeof row.lastFailure === "string" ? row.lastFailure : null,
    lastEndpoint: typeof row.lastEndpoint === "string" ? row.lastEndpoint : null,
    lastRequestKind: row.lastRequestKind === "SIGNED" || row.lastRequestKind === "PUBLIC"
      ? row.lastRequestKind
      : null,
    lastRequestCaller: typeof row.lastRequestCaller === "string" ? row.lastRequestCaller : null,
    reservationsByCaller: trackedCallers,
    reservationTrackingSinceMs: Number.isFinite(row.reservationTrackingSinceMs)
      ? Number(row.reservationTrackingSinceMs)
      : nowMs,
    venueUsedWeightByPool: readWeightPools(row.venueUsedWeightByPool),
    dispatchBudget: row.dispatchBudget,
    updatedAtMs: Number.isFinite(row.updatedAtMs) ? Math.max(0, Number(row.updatedAtMs)) : nowMs,
  };
}

function readWeightPools(value: unknown): BinanceUsdMTestnetRateLimitState["venueUsedWeightByPool"] {
  const empty = { weight: null as number | null, atMs: 0 };
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const one = (key: string) => {
    const cell = row[key];
    if (!cell || typeof cell !== "object") return { ...empty };
    const c = cell as { weight?: unknown; atMs?: unknown };
    return {
      weight: Number.isFinite(c.weight) && Number(c.weight) >= 0 ? Number(c.weight) : null,
      atMs: Number.isFinite(c.atMs) ? Math.max(0, Number(c.atMs)) : 0,
    };
  };
  return { SIGNED: one("SIGNED"), PUBLIC: one("PUBLIC"), MARKET_DATA: one("MARKET_DATA") };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VenueWeightPressure {
  usedWeight1m: number | null;
  /** Multiplier applied to the lane's configured gap. */
  gapMultiplier: number;
  /** Earliest permissible dispatch, used to sit out a nearly-spent weight minute. */
  notBeforeMs: number;
  band: "UNKNOWN" | "CLEAR" | "SOFT" | "HARD";
}

/**
 * Translate the venue's own weight accounting into pacing pressure.
 *
 * A stale reading is treated as UNKNOWN rather than as CLEAR: it must not licence a burst, but it
 * also must not throttle forever after a quiet period, so it simply leaves the configured gap
 * alone. At HARD the lane waits for the next weight minute to start, because the counter Binance
 * enforces resets on the minute boundary; slowing down inside a minute that is already nearly
 * spent does not help.
 */
export function venueWeightPressure(
  usedWeight1m: number | null,
  reportedAtMs: number,
  nowMs: number,
): VenueWeightPressure {
  const fresh = usedWeight1m !== null && reportedAtMs > 0 && nowMs - reportedAtMs <= VENUE_WEIGHT_FRESH_MS;
  if (!fresh) return { usedWeight1m: null, gapMultiplier: 1, notBeforeMs: 0, band: "UNKNOWN" };
  const used = usedWeight1m as number;
  if (used >= VENUE_WEIGHT_HARD_LIMIT) {
    // Start of the weight minute AFTER the one this reading belongs to.
    const nextMinuteMs = Math.floor(reportedAtMs / 60_000) * 60_000 + 60_000;
    return {
      usedWeight1m: used,
      gapMultiplier: VENUE_WEIGHT_HARD_GAP_MULTIPLIER,
      notBeforeMs: nextMinuteMs,
      band: "HARD",
    };
  }
  if (used >= VENUE_WEIGHT_SOFT_LIMIT) {
    return {
      usedWeight1m: used,
      gapMultiplier: VENUE_WEIGHT_SOFT_GAP_MULTIPLIER,
      notBeforeMs: 0,
      band: "SOFT",
    };
  }
  return { usedWeight1m: used, gapMultiplier: 1, notBeforeMs: 0, band: "CLEAR" };
}

/**
 * The lock protects only a tiny state read/write, never a network request.
 * A caller reserves its future dispatch slot atomically, then waits outside
 * the lock.  A cooldown is checked again immediately before dispatch by the
 * private client, so a ban learned by another process while it waited wins.
 */
export class BinanceUsdMTestnetReadCoordinator {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private readonly nowMs: () => number;
  readonly directory: string;
  readonly globalReadGapMs: number;
  /** Pacing for SIGNED account truth; the public lane keeps `globalReadGapMs`. */
  readonly signedReadGapMs: number;
  private lastVenueWeightPersistAtMs = 0;

  constructor(options: {
    directory: string;
    globalReadGapMs?: number;
    signedReadGapMs?: number;
    nowMs?: () => number;
  }) {
    this.directory = options.directory;
    this.stateFile = join(options.directory, "usd-m-testnet-rate-limit.json");
    this.lockFile = join(options.directory, "usd-m-testnet-rate-limit.lock");
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.globalReadGapMs = Number.isFinite(options.globalReadGapMs)
      ? Math.max(250, Math.round(options.globalReadGapMs!))
      : DEFAULT_GLOBAL_READ_GAP_MS;
    const configuredSigned = Number.isFinite(options.signedReadGapMs)
      ? Math.max(250, Math.round(options.signedReadGapMs!))
      : Number.parseInt(process.env.BINANCE_USDM_TESTNET_SIGNED_READ_GAP_MS ?? "", 10);
    // Never SLOWER than the public lane, and never faster than the caller explicitly allowed by
    // configuring a tighter global gap for a test.
    this.signedReadGapMs = Number.isFinite(configuredSigned) && configuredSigned > 0
      ? Math.min(this.globalReadGapMs, Math.max(250, configuredSigned))
      : Math.min(this.globalReadGapMs, DEFAULT_SIGNED_READ_GAP_MS);
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true });
  }

  private readState(nowMs: number): BinanceUsdMTestnetRateLimitState {
    try {
      return validState(JSON.parse(readFileSync(this.stateFile, "utf8")), nowMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState(nowMs);
      throw new Error("Testnet transport state unreadable; refusing to erase durable cooldown/budget");
    }
  }

  private writeState(state: BinanceUsdMTestnetRateLimitState): void {
    this.ensureDirectory();
    const temporary = `${this.stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temporary, this.stateFile);
  }

  private releaseLock(fd: number): void {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(this.lockFile); } catch { /* best effort */ }
  }

  private async acquireLock(): Promise<number> {
    this.ensureDirectory();
    for (;;) {
      try {
        return openSync(this.lockFile, "wx");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const ageMs = this.nowMs() - statSync(this.lockFile).mtimeMs;
          if (ageMs > LOCK_STALE_MS) unlinkSync(this.lockFile);
        } catch {
          // Another process may have released/replaced the lock; retry below.
        }
        await wait(LOCK_RETRY_MS);
      }
    }
  }

  private async withLock<T>(operation: (state: BinanceUsdMTestnetRateLimitState, nowMs: number) => T): Promise<T> {
    const fd = await this.acquireLock();
    try {
      const nowMs = this.nowMs();
      const state = this.readState(nowMs);
      const result = operation(state, nowMs);
      this.writeState(state);
      return result;
    } finally {
      this.releaseLock(fd);
    }
  }

  private budget(state: BinanceUsdMTestnetRateLimitState) {
    if (!state.dispatchBudget) {
      // Adoption never erases pressure recorded by the previous release.
      const readings = Object.values(state.venueUsedWeightByPool);
      const latestMinute = Math.max(...readings.map(x => Math.floor(x.atMs / WEIGHT_WINDOW_MS)));
      const high = readings.filter(x => Math.floor(x.atMs / WEIGHT_WINDOW_MS) === latestMinute)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
      state.dispatchBudget = { highWater: { weight: high?.weight ?? 0, atMs: high?.atMs ?? 0 },
        debits: [], nextDispatchAtMs: 0, recent: [], lastBanEvidence: [] };
    }
    return state.dispatchBudget;
  }

  /** Final, atomic host budget check AFTER every queue/pacing wait. No future reservations. */
  async acquireDispatchBudget(input: Omit<TestnetDispatchEvidence, "atMs" | "phase">,
    assertAllowed: () => void, signal?: AbortSignal): Promise<void> {
    const started = this.nowMs();
    for (;;) {
      assertAllowed();
      if (signal?.aborted) throw new Error("Testnet dispatch aborted before network send");
      const delay = await this.withLock((state, now) => {
        if (state.cooldownUntilMs > now) throw new BinanceUsdMTestnetCooldownError(state);
        const b = this.budget(state);
        b.debits = b.debits.filter(d => d.atMs + WEIGHT_WINDOW_MS + WINDOW_SETTLE_MS > now);
        const highExpires = (Math.floor(b.highWater.atMs / WEIGHT_WINDOW_MS) + 1) * WEIGHT_WINDOW_MS + WINDOW_SETTLE_MS;
        const high = highExpires > now ? b.highWater.weight : 0;
        // Add requests dispatched since the observation; take max with locally charged rolling spend.
        const local = b.debits.reduce((n, d) => n + d.weight, 0);
        const unobserved = b.debits.filter(d => d.atMs >= b.highWater.atMs).reduce((n, d) => n + d.weight, 0);
        const projected = Math.max(local, high + (high ? unobserved : 0)) + input.estimatedWeight;
        if (projected > VENUE_WEIGHT_HARD_LIMIT || now < b.nextDispatchAtMs) return 250;
        b.debits.push({ atMs: now, weight: input.estimatedWeight });
        b.nextDispatchAtMs = now + CROSS_KIND_DISPATCH_GAP_MS;
        b.recent.push({ ...input, endpoint: input.endpoint.split("?")[0], atMs: now, phase: "DISPATCH" });
        b.recent = b.recent.slice(-MAX_DISPATCH_EVIDENCE);
        return 0;
      });
      if (!delay) return;
      if (this.nowMs() - started >= TESTNET_DISPATCH_BUDGET_WAIT_MS) {
        throw new BinanceUsdMTestnetLaneSaturatedError({ requestKind: "SIGNED", requestCaller: input.requestCaller,
          queueAheadMs: this.nowMs() - started, ceilingMs: TESTNET_DISPATCH_BUDGET_WAIT_MS });
      }
      await wait(delay);
    }
  }

  /** Persist feedback before the next queued read is released; retain pre-ban evidence. */
  async recordDispatchResponse(input: Omit<TestnetDispatchEvidence, "atMs" | "phase">): Promise<void> {
    await this.withLock((state, now) => {
      const b = this.budget(state);
      const weight = input.usedWeight1m;
      if (weight != null && Number.isFinite(weight) && weight >= 0) {
        const sameMinute = Math.floor(now / WEIGHT_WINDOW_MS) === Math.floor(b.highWater.atMs / WEIGHT_WINDOW_MS);
        if (!sameMinute || weight > b.highWater.weight) b.highWater = { weight, atMs: now };
      }
      b.recent.push({ ...input, endpoint: input.endpoint.split("?")[0], atMs: now, phase: "RESPONSE" });
      b.recent = b.recent.slice(-MAX_DISPATCH_EVIDENCE);
      if (input.httpStatus === 418 || input.httpStatus === 429) b.lastBanEvidence = [...b.recent];
    });
  }

  /** Atomically reserve one host-wide Testnet USD-M read dispatch slot. */
  async reserveReadDispatch(
    requestKind: BinanceUsdMRequestKind = "SIGNED",
    requestCaller: string | null = null,
    pool?: BinanceUsdMWeightPool,
  ): Promise<void> {
    // Derive rather than default to a constant: a caller that does not name a pool still gets the
    // one its request kind is metered on. Defaulting to a fixed value paced PUBLIC reads off the
    // signed gap.
    const effectivePool: BinanceUsdMWeightPool = pool ?? (requestKind === "SIGNED" ? "SIGNED" : "PUBLIC");
    const dispatchAtMs = await this.withLock((state, nowMs) => {
      if (state.cooldownUntilMs > nowMs) throw new BinanceUsdMTestnetCooldownError(state);
      const ownNext = requestKind === "SIGNED"
        ? state.nextSignedReadDispatchAtMs
        : state.nextPublicReadDispatchAtMs;
      // The cross-kind gap is LOCAL SPACING — "do not let a signed and a public request leave this
      // VPS within five seconds of each other" — not a queue position. Comparing against
      // `lastReservedDispatchAtMs` alone made a backlogged lane export its whole backlog onto the
      // other one: with the public lane booked four minutes out, every signed read was pushed to
      // the END of that queue, so account reconciliation, the engine tick and /api/live/account all
      // inherited the candle backlog. Measured 2026-09-04: signed dispatches roughly every 4-5
      // minutes while signed DEMAND was about one a minute.
      //
      // Cap the push at one gap beyond now. That keeps the guarantee in the case it was written for
      // (the other kind just went, or is about to), and stops a deep queue on one lane from
      // dictating the other lane's latency. Total request volume is unchanged — it is set by
      // demand, and each lane still enforces its own interval.
      const crossKindNotBefore = state.lastReservedRequestKind !== null && state.lastReservedRequestKind !== requestKind
        ? Math.min(
          state.lastReservedDispatchAtMs + CROSS_KIND_DISPATCH_GAP_MS,
          nowMs + CROSS_KIND_DISPATCH_GAP_MS,
        )
        : 0;
      // The venue's own accounting is the real brake; the configured gap is only the floor. Read
      // the counter for THIS request's pool -- klines pressure must not throttle account truth.
      const reading = state.venueUsedWeightByPool[effectivePool] ?? { weight: null, atMs: 0 };
      // Signed reads also receive 429/418. A low unsigned reading is not evidence that
      // signed capacity is free. Apply the existing conservative operational budget
      // to each observed pool independently; do not invent an unlimited signed quota.
      // This only paces GETs. Risk-reducing POST/DELETE and venue cooldown rules remain unchanged.
      const pressure = venueWeightPressure(reading.weight, reading.atMs, nowMs);
      const baseGapMs = effectivePool === "MARKET_DATA"
        ? Math.max(MARKET_DATA_READ_GAP_MS, this.globalReadGapMs)
        : effectivePool === "SIGNED" ? this.signedReadGapMs : this.globalReadGapMs;
      const ownGapMs = baseGapMs * pressure.gapMultiplier;
      const dispatchAt = Math.max(nowMs, ownNext, crossKindNotBefore, pressure.notBeforeMs);
      // Refuse BEFORE mutating anything: a refused request must not book the slot it was denied,
      // or the watermark would keep climbing on exactly the traffic the ceiling exists to shed.
      if (dispatchAt - nowMs > MAX_QUEUE_AHEAD_MS) {
        throw new BinanceUsdMTestnetLaneSaturatedError({
          requestKind,
          requestCaller,
          queueAheadMs: dispatchAt - nowMs,
          ceilingMs: MAX_QUEUE_AHEAD_MS,
        });
      }
      if (requestKind === "SIGNED") {
        state.nextSignedReadDispatchAtMs = dispatchAt + ownGapMs;
      } else {
        state.nextPublicReadDispatchAtMs = dispatchAt + ownGapMs;
      }
      state.lastReservedDispatchAtMs = dispatchAt;
      state.lastReservedRequestKind = requestKind;
      // Retain a conservative compatibility ceiling. A still-running old
      // release only understands this field, and will therefore yield rather
      // than cut in front of either lane during a guarded cutover.
      state.nextReadDispatchAtMs = Math.max(
        state.nextSignedReadDispatchAtMs,
        state.nextPublicReadDispatchAtMs,
      );
      const callerKey = `${requestKind} ${requestCaller ?? "unattributed"}`;
      const tracked = state.reservationsByCaller;
      if (tracked[callerKey] !== undefined || Object.keys(tracked).length < MAX_TRACKED_CALLERS) {
        tracked[callerKey] = (tracked[callerKey] ?? 0) + 1;
      }
      state.updatedAtMs = nowMs;
      return dispatchAt;
    });
    const waitMs = dispatchAtMs - this.nowMs();
    if (waitMs > 0) await wait(waitMs);
  }

  /**
   * Record what the venue says this IP has already spent this minute.
   *
   * Called from the transport on EVERY response, including error responses, because a 4xx still
   * carries the header and a ban is precisely when the number matters. Persistence is throttled --
   * this must not take the file lock once per request -- except when the reading crosses the soft
   * limit, which every worker on this IP needs to see immediately.
   */
  async recordVenueWeight(
    pool: BinanceUsdMWeightPool,
    usedWeight1m: number,
    atMs: number = this.nowMs(),
  ): Promise<void> {
    if (!Number.isFinite(usedWeight1m) || usedWeight1m < 0) return;
    const urgent = usedWeight1m >= VENUE_WEIGHT_SOFT_LIMIT;
    if (!urgent && atMs - this.lastVenueWeightPersistAtMs < VENUE_WEIGHT_PERSIST_MIN_GAP_MS) return;
    this.lastVenueWeightPersistAtMs = atMs;
    try {
      await this.withLock((state) => {
        // Never let a slow response overwrite a newer reading from another worker.
        const cell = state.venueUsedWeightByPool[pool];
        if (cell && atMs >= cell.atMs) {
          state.venueUsedWeightByPool[pool] = { weight: usedWeight1m, atMs };
          state.updatedAtMs = atMs;
        }
        return undefined;
      });
    } catch {
      // Diagnostic pacing input only: a bad state volume must never fail a live exchange read.
    }
  }

  /** Pacing pressure the venue's accounting currently implies for one pool. */
  venueWeightPressure(pool: BinanceUsdMWeightPool = "PUBLIC"): VenueWeightPressure {
    const nowMs = this.nowMs();
    const state = this.readState(nowMs);
    const reading = state.venueUsedWeightByPool[pool] ?? { weight: null, atMs: 0 };
    return venueWeightPressure(reading.weight, reading.atMs, nowMs);
  }

  /** Persist a venue rate limit so every participating Testnet worker stands down. */
  async registerRateLimit(input: {
    status: 418 | 429;
    retryUntilMs: number;
    failure: string;
    endpoint: string;
    requestKind: BinanceUsdMRequestKind;
    requestCaller: string | null;
  }): Promise<void> {
    await this.withLock((state, nowMs) => {
      state.cooldownUntilMs = Math.max(state.cooldownUntilMs, input.retryUntilMs);
      state.lastHttpStatus = input.status;
      state.lastFailure = input.failure;
      state.lastEndpoint = input.endpoint;
      state.lastRequestKind = input.requestKind;
      state.lastRequestCaller = input.requestCaller;
      state.updatedAtMs = nowMs;
    });
  }

  /**
   * How far ahead this host lease has already booked dispatch slots.
   *
   * A caller waiting behind a queued read needs to know what waiting is still
   * legitimate: under a backlog the head is simply asleep until its reserved
   * slot, which can be minutes out. Anything beyond this horizon is not
   * pacing, it is a stuck dispatch.
   */
  /** Reservation counts per calling site, for diagnosing who owns a lane. */
  reservationsByCaller(): Record<string, number> {
    return this.readState(this.nowMs()).reservationsByCaller;
  }

  bookedThroughMs(): number {
    const nowMs = this.nowMs();
    const state = this.readState(nowMs);
    return Math.max(
      nowMs,
      state.nextSignedReadDispatchAtMs,
      state.nextPublicReadDispatchAtMs,
    );
  }

  status(): BinanceUsdMTestnetRateLimitStatus {
    const nowMs = this.nowMs();
    const state = this.readState(nowMs);
    const market = state.venueUsedWeightByPool.MARKET_DATA ?? { weight: null, atMs: 0 };
    // Match the shared dispatch guard: a cheap PUBLIC/time response cannot hide
    // a higher SIGNED or MARKET_DATA counter from the operator.
    const highWater=this.budget(state).highWater;
    const readings=[...Object.values(state.venueUsedWeightByPool),highWater];
    const current=readings.filter(r=>r.weight!==null&&Math.floor(r.atMs/WEIGHT_WINDOW_MS)===Math.floor(nowMs/WEIGHT_WINDOW_MS));
    const overall=current.sort((a,b)=>(b.weight??0)-(a.weight??0))[0]??{weight:null,atMs:0};
    const pressure = venueWeightPressure(overall.weight, overall.atMs, nowMs);
    const marketPressure = venueWeightPressure(market.weight, market.atMs, nowMs);
    return {
      dispatchGuard: "TESTNET_IP_WEIGHT_DISPATCH_V1",
      dispatchWeightBudget: VENUE_WEIGHT_HARD_LIMIT,
      dispatchHighWater: this.budget(state).highWater,
      dispatchLocalWeight60s: this.budget(state).debits.filter(d => d.atMs + WEIGHT_WINDOW_MS + WINDOW_SETTLE_MS > nowMs)
        .reduce((n, d) => n + d.weight, 0),
      coordination: "HOST_TESTNET_FILE_LEASE",
      directory: this.directory,
      globalReadGapMs: this.globalReadGapMs,
      signedReadGapMs: this.signedReadGapMs,
      coolingDown: state.cooldownUntilMs > nowMs,
      retryAt: state.cooldownUntilMs > nowMs ? new Date(state.cooldownUntilMs).toISOString() : null,
      lastHttpStatus: state.lastHttpStatus,
      lastFailure: state.lastFailure,
      lastEndpoint: state.lastEndpoint,
      lastRequestKind: state.lastRequestKind,
      lastRequestCaller: state.lastRequestCaller,
      nextReadDispatchAt: state.nextReadDispatchAtMs > nowMs ? new Date(state.nextReadDispatchAtMs).toISOString() : null,
      venueWeightLimitPerMin: VENUE_WEIGHT_LIMIT_PER_MIN,
      marketDataReadGapMs: Math.max(MARKET_DATA_READ_GAP_MS, this.globalReadGapMs),
      venueUsedWeight1m: pressure.usedWeight1m,
      venueWeightBand: pressure.band,
      venueUsedWeightMarketData: marketPressure.usedWeight1m,
      venueWeightBandMarketData: marketPressure.band,
      venueUsedWeightSigned: (state.venueUsedWeightByPool.SIGNED ?? { weight: null }).weight,
      venueWeightBandSigned: this.venueWeightPressure("SIGNED").band,
    };
  }
}

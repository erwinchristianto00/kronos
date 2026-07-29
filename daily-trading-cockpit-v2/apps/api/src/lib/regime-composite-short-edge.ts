/**
 * Regime-composite SHORT confirmation (report-only measurement lane, 2026-07-12).
 *
 * The bearish-breadth mirror of regime-composite-edge.ts (RC, LONG-only). Built to close a specific
 * asymmetry surfaced while auditing the unified testnet "directional brain": RC gives the brain a
 * cheap LONG confirmation, but there was NO bearish-breadth counterpart, so SHORT postures rode
 * unconfirmed (and, before the app.ts fix, the long-only RC vote even one-sidedly penalized them).
 * This lane is that counterpart — a genuinely different, independent SHORT confirmation.
 *
 * The gate is the exact symmetric mirror of RC, because RC's two inputs decompose cleanly into
 * "direction" and "stability":
 *   1. Regime axis score (regime-axis-timeline.ts's computeRegimeAxisScore, symmetric -1..+1 breadth
 *      composite) <= RCS_AXIS_SCORE_MAX (a negative ceiling) — a breadth-composite read of how
 *      broadly BEARISH the market is right now. This is the directional half; RC uses >= +threshold.
 *   2. Per-symbol crowdingState (derivatives-crowding.ts) in {NEUTRAL, BUILDING} — i.e. NOT
 *      EXHAUSTING (fragile, late-stage) or UNWINDING (positions being flushed). crowdingState is a
 *      DIRECTION-AGNOSTIC positioning-phase read (funding magnitude × OI trend, see
 *      classifyCrowdingState), so the same "positioning is stable, not exhausted/flushing" filter
 *      applies symmetrically to a short entry: you don't want to short into a capitulation flush
 *      (UNWINDING) or an already-exhausted crowd (EXHAUSTING). This is the identical, unchanged
 *      stability half of RC's gate — funding/OI is an independent data source (derivatives) from the
 *      axis score (spot/breadth), so it stays a second, genuinely different confirmation.
 * Fixed small universe (BTC/ETH/SOL — high-liquidity majors), SHORT-only, standalone module (own
 * store/cycle/resolver/report), same "measure before it trades" discipline as every other lane.
 *
 * Its observation stream is also the sole source for the optional single-symbol executor. Entry is
 * intentionally stricter than the regime read: bearish breadth says which side has the wind, while
 * the local retest/rejection setup decides whether entering NOW is acceptable. A broad selloff is
 * therefore not itself a short trigger.
 *
 * FUTURE ENHANCEMENT (deliberately not baked in, to keep this a faithful/comparable mirror of RC):
 * a crowd-side-aware refinement could ADMIT an EXHAUSTING state when the exhausted crowd is LONG
 * (crowded longs about to unwind = a strong short setup). Left as a separate idea so RC and RCS stay
 * apples-to-apples during measurement.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { completedCandles, type Candle } from "@dtc/shared";
import { computeATR, computeEMA, computeRSI } from "./candle-indicators.js";
import { fetchCrowdingSnapshot, type CrowdingSnapshot, type CrowdingState } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import {
  makeMfeGivebackExitPolicy,
  type SingleSymbolExitPolicy,
  type SingleSymbolFreshSignal,
} from "./single-symbol-lane-executor.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const RCS_INTERVAL = process.env.REGIME_COMPOSITE_SHORT_INTERVAL || "1h";
/** Axis score CEILING (regime-axis-timeline.ts's -1..+1 breadth composite). Axis must be <= this
 *  (a negative number) to confirm bearish breadth — the symmetric mirror of RC_AXIS_SCORE_MIN. */
export const RCS_AXIS_SCORE_MAX = Number.isFinite(Number(process.env.REGIME_COMPOSITE_SHORT_AXIS_SCORE_MAX))
  ? Number(process.env.REGIME_COMPOSITE_SHORT_AXIS_SCORE_MAX)
  : -0.35;
/** crowdingState values that pass the confirmation gate (NOT the fragile/flushing states). Identical
 *  to RC — crowdingState is direction-agnostic, so the stability filter is shared verbatim. */
export const RCS_ALLOWED_CROWDING_STATES: ReadonlySet<CrowdingState> = new Set(["NEUTRAL", "BUILDING"]);
export const RCS_MAX_STORED_OBSERVATIONS = envNum("REGIME_COMPOSITE_SHORT_MAX_STORED_OBSERVATIONS", 500);
export const RCS_ATR_PERIOD = envNum("REGIME_COMPOSITE_SHORT_ATR_PERIOD", 14);
/** A bearish regime is not an entry license. Require a closed-candle retest of this EMA from below. */
export const RCS_RETEST_EMA_PERIOD = Math.max(2, Math.floor(envNum("REGIME_COMPOSITE_SHORT_RETEST_EMA_PERIOD", 20)));
/** The retest high may finish slightly below the EMA, but cannot be a distant waterfall candle. */
export const RCS_RETEST_EMA_TOUCH_ATR = Math.max(0, envNum("REGIME_COMPOSITE_SHORT_RETEST_EMA_TOUCH_ATR", 0.25));
/** Reject a late short when its close has already stretched too far below the retest mean. */
export const RCS_MAX_EXTENSION_BELOW_EMA_ATR = Math.max(0.1, envNum("REGIME_COMPOSITE_SHORT_MAX_EXTENSION_BELOW_EMA_ATR", 0.75));
/** A deeply oversold hourly RSI is a rebound-risk state, not a permission to chase the selloff. */
export const RCS_MIN_ENTRY_RSI = Math.max(0, Math.min(100, envNum("REGIME_COMPOSITE_SHORT_MIN_ENTRY_RSI", 32)));
/** Initial stop = entry + ATR × this (stop ABOVE for a short). Wide, matching RC's regime-read stop. */
export const RCS_ATR_STOP_MULT = Number(process.env.REGIME_COMPOSITE_SHORT_ATR_STOP_MULT) || 2;
export const RCS_MFE_ARM_R = Number(process.env.REGIME_COMPOSITE_SHORT_MFE_ARM_R) || 0.75;
export const RCS_MFE_GIVEBACK_FRAC = Number(process.env.REGIME_COMPOSITE_SHORT_MFE_GIVEBACK_FRAC) || 0.5;
export const RCS_MAX_HOLD_BARS = envNum("REGIME_COMPOSITE_SHORT_MAX_HOLD_BARS", 48);
export const RCS_MAX_CONCURRENT = envNum("REGIME_COMPOSITE_SHORT_MAX_CONCURRENT", 3);
export const RCS_PAPER_LANE_ID = "REGIME_COMPOSITE_CONFIRMATION_SHORT" as const;
/** Small, fixed, high-liquidity universe only — same as RC. */
export const RCS_UNIVERSE: readonly string[] = (
  process.env.REGIME_COMPOSITE_SHORT_UNIVERSE ?? "BTCUSDT,ETHUSDT,SOLUSDT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const TAKER_ROUNDTRIP_BPS = 8; // ~0.04% per side, taker in + taker out
const STOP_OUT_SLIPPAGE_BPS = 5; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface RegimeCompositeShortSignal {
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  atrAtEntry: number;
  axisScoreAtEntry: number;
  crowdingStateAtEntry: CrowdingState;
  fundingBpsAtEntry: number | null;
  entrySetup: "EMA20_RETEST_REJECTION";
  ema20AtEntry: number;
  extensionBelowEmaAtr: number;
}

export type RcsShortEntryRejection =
  | "AXIS_NOT_BEARISH"
  | "CROWDING_NOT_STABLE"
  | "INSUFFICIENT_CANDLES"
  | "ATR_UNAVAILABLE"
  | "EMA_UNAVAILABLE"
  | "RSI_OVERSOLD_WAIT_PULLBACK"
  | "NO_EMA20_RETEST"
  | "NO_BEARISH_REJECTION"
  | "LATE_EXTENSION_WAIT_PULLBACK"
  | "INVALID_STOP_GEOMETRY";

export interface RcsShortEntryEvaluation {
  signal: RegimeCompositeShortSignal | null;
  rejection: RcsShortEntryRejection | null;
}

function bearishRejectionOrBreakdown(last: Candle, previous: Candle, atr: number): boolean {
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const meaningfulBody = Math.max(body, atr * 0.05);
  const bearishClose = last.close < last.open;
  const wickRejects = upperWick >= meaningfulBody;
  const breakdownRejects = last.close < previous.low;
  return bearishClose && (wickRejects || breakdownRejects);
}

/**
 * Pure entry gate given an already-fetched axis score + crowding snapshot + closed-candle series
 * (last element = the just-closed bar). Bearish mirror of detectRegimeCompositeEntry: axis must be
 * <= RCS_AXIS_SCORE_MAX, crowding must be a stable state, ATR must be computable, stop sits ABOVE
 * entry. No lookahead — uses only closed bars.
 */
export function evaluateRegimeCompositeShortEntry(
  candles: Candle[],
  axisScore: number | null,
  crowding: CrowdingSnapshot | null,
): RcsShortEntryEvaluation {
  if (!finite(axisScore) || axisScore > RCS_AXIS_SCORE_MAX) return { signal: null, rejection: "AXIS_NOT_BEARISH" };
  if (!crowding || !RCS_ALLOWED_CROWDING_STATES.has(crowding.crowdingState)) return { signal: null, rejection: "CROWDING_NOT_STABLE" };

  const need = Math.max(RCS_ATR_PERIOD, RCS_RETEST_EMA_PERIOD) + 2;
  if (candles.length < need) return { signal: null, rejection: "INSUFFICIENT_CANDLES" };
  const last = candles[candles.length - 1]!;
  const previous = candles[candles.length - 2]!;
  const entryPrice = last.close;
  if (!(entryPrice > 0)) return { signal: null, rejection: "INVALID_STOP_GEOMETRY" };

  const atrSeries = computeATR(candles, RCS_ATR_PERIOD);
  const atr = atrSeries[atrSeries.length - 1];
  if (!finite(atr) || !(atr > 0)) return { signal: null, rejection: "ATR_UNAVAILABLE" };

  const ema20 = computeEMA(candles.map((c) => c.close), RCS_RETEST_EMA_PERIOD).at(-1);
  if (!finite(ema20) || !(ema20 > 0)) return { signal: null, rejection: "EMA_UNAVAILABLE" };
  const rsi = computeRSI(candles.map((c) => c.close), 14).at(-1);
  if (finite(rsi) && rsi <= RCS_MIN_ENTRY_RSI) return { signal: null, rejection: "RSI_OVERSOLD_WAIT_PULLBACK" };

  const touchedEmaFromBelow = last.high >= ema20 - RCS_RETEST_EMA_TOUCH_ATR * atr;
  const closedBelowEma = last.close < ema20;
  if (!touchedEmaFromBelow || !closedBelowEma) return { signal: null, rejection: "NO_EMA20_RETEST" };
  if (!bearishRejectionOrBreakdown(last, previous, atr)) return { signal: null, rejection: "NO_BEARISH_REJECTION" };

  const extensionBelowEmaAtr = (ema20 - last.close) / atr;
  if (extensionBelowEmaAtr > RCS_MAX_EXTENSION_BELOW_EMA_ATR) {
    return { signal: null, rejection: "LATE_EXTENSION_WAIT_PULLBACK" };
  }

  const initialStop = entryPrice + RCS_ATR_STOP_MULT * atr;
  if (!(initialStop > entryPrice)) return { signal: null, rejection: "INVALID_STOP_GEOMETRY" };
  const stopDistanceBps = ((initialStop - entryPrice) / entryPrice) * 10000;
  if (!(stopDistanceBps > 0)) return { signal: null, rejection: "INVALID_STOP_GEOMETRY" };

  return {
    signal: {
      entryPrice,
      initialStop,
      stopDistanceBps,
      atrAtEntry: atr,
      axisScoreAtEntry: axisScore,
      crowdingStateAtEntry: crowding.crowdingState,
      fundingBpsAtEntry: crowding.fundingBps,
      entrySetup: "EMA20_RETEST_REJECTION",
      ema20AtEntry: ema20,
      extensionBelowEmaAtr,
    },
    rejection: null,
  };
}

/** Backward-compatible nullable entry seam for callers that only need executable geometry. */
export function detectRegimeCompositeShortEntry(
  candles: Candle[],
  axisScore: number | null,
  crowding: CrowdingSnapshot | null,
): RegimeCompositeShortSignal | null {
  return evaluateRegimeCompositeShortEntry(candles, axisScore, crowding).signal;
}

export interface RegimeCompositeShortObservation extends RegimeCompositeShortSignal {
  observationId: string;
  symbol: string;
  direction: "SHORT";
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  maxFavorableR: number | null;
  exitReason: "MFE_GIVEBACK" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs with the SHORT MFE-giveback
 * exit — the mirror of resolveRegimeCompositeObservation: stop-first (conservative) on a bar HIGH
 * that touches the stop above, track peak favorable-R from bar LOWS (favorable = price falling), bank
 * on a close that has given back RCS_MFE_GIVEBACK_FRAC of the peak once armed, else mark-to-market at
 * RCS_MAX_HOLD_BARS. Favorable-R for a short = (entry - price) / risk.
 */
export function resolveRegimeCompositeShortObservation(
  obs: RegimeCompositeShortObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<RegimeCompositeShortObservation> | null {
  const fwd = completedCandles(forwardCandles, RCS_INTERVAL, nowMs)
    .filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.initialStop - obs.entryPrice;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<RegimeCompositeShortObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<RegimeCompositeShortObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return {
      status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR,
      costR,
      netR,
      exitReason,
      maxFavorableR,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };

  let peakR = 0;
  let armed = false;
  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i]!;
    if (c.high >= obs.initialStop) {
      const grossR = (obs.entryPrice - obs.initialStop) / risk; // = −1
      return finalize(grossR, c.openTime, "INITIAL_STOP", peakR);
    }
    const barPeakR = (obs.entryPrice - c.low) / risk;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= RCS_MFE_ARM_R) armed = true;
    if (armed) {
      const closeR = (obs.entryPrice - c.close) / risk;
      const givebackLine = peakR * (1 - RCS_MFE_GIVEBACK_FRAC);
      if (closeR <= givebackLine) {
        return finalize(closeR, c.openTime, "MFE_GIVEBACK", peakR);
      }
    }
    if (i + 1 >= RCS_MAX_HOLD_BARS) {
      const grossR = (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM", peakR);
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > RCS_MAX_HOLD_BARS * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
export interface RCSCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  axisGateFailTotal: number;
  crowdingGateFailTotal: number;
  entrySetupGateFailTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: RCSCycleMeta = {
  lastCycleAt: null, cycles: 0, axisGateFailTotal: 0, crowdingGateFailTotal: 0, entrySetupGateFailTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface RCSState {
  version: number;
  observations: RegimeCompositeShortObservation[];
  cycleMeta?: RCSCycleMeta;
}

export class RegimeCompositeShortStore {
  private state: RCSState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<RCSState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as RegimeCompositeShortObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): RegimeCompositeShortObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): RCSCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: RCSCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.axisGateFailTotal += result.axisGateFail;
      meta.crowdingGateFailTotal += result.crowdingGateFail;
      meta.entrySetupGateFailTotal += result.entrySetupGateFail;
      meta.recordedTotal += result.recorded;
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: RegimeCompositeShortObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<RegimeCompositeShortObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most RCS_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled dropped first once the cap is exceeded. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > RCS_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - RCS_MAX_STORED_OBSERVATIONS) : settled;
    this.state.observations = [...open, ...keepSettled];
  }
  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }
}

let singleton: RegimeCompositeShortStore | null = null;
export function getRegimeCompositeShortStore(dataDir = "data"): RegimeCompositeShortStore {
  if (!singleton) singleton = new RegimeCompositeShortStore(resolve(dataDir, "regime-composite-short-edge.json"));
  return singleton;
}

export function _resetRegimeCompositeShortStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface RCSCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  axisGateFail: number;
  crowdingGateFail: number;
  entrySetupGateFail: number;
}

export async function runRegimeCompositeShortCycle(opts: {
  store: RegimeCompositeShortStore;
  universe?: readonly string[];
  now: number;
  axisScore: number | null;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
  maxConcurrent?: number;
  dedupeWindowMs?: number;
}): Promise<RCSCycleResult> {
  const result: RCSCycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, axisGateFail: 0, crowdingGateFail: 0, entrySetupGateFail: 0 };
  const universe = opts.universe ?? RCS_UNIVERSE;
  const maxConcurrent = opts.maxConcurrent ?? RCS_MAX_CONCURRENT;
  const dedupeMs = opts.dedupeWindowMs ?? 3_600_000; // 1h (one signal per symbol per bar)
  const nowIso = new Date(opts.now).toISOString();

  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of universe) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* skip this symbol this cycle */
    }
  }

  // 1. resolve OPEN observations with forward candles.
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol);
    if (!candles) continue;
    const patch = resolveRegimeCompositeShortObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. axis gate first (cheap, one read) — bearish ceiling. If it fails, don't fetch crowding.
  if (!finite(opts.axisScore) || opts.axisScore > RCS_AXIS_SCORE_MAX) {
    result.axisGateFail = universe.length;
    opts.store.recordCycle(nowIso, result);
    opts.store.save();
    return result;
  }

  // 3. record new entries: per-symbol crowding confirmation, then the ATR/candle gate.
  for (const symbol of universe) {
    result.scanned += 1;
    const openNow = opts.store.all.filter((o) => o.status === "OPEN").length;
    if (openNow >= maxConcurrent) break;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;

    let crowding: CrowdingSnapshot | null = null;
    try {
      crowding = await fetchCrowdingSnapshot(opts.crowdingClient, symbol, nowIso);
    } catch {
      crowding = null;
    }
    if (!crowding || !RCS_ALLOWED_CROWDING_STATES.has(crowding.crowdingState)) {
      result.crowdingGateFail += 1;
      continue;
    }

    const evaluated = evaluateRegimeCompositeShortEntry(candles, opts.axisScore, crowding);
    if (!evaluated.signal) {
      result.entrySetupGateFail += 1;
      continue;
    }
    const signal = evaluated.signal;

    const observationId = `rcs:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...signal,
      observationId,
      symbol,
      direction: "SHORT",
      openedAt: nowIso,
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.recorded += 1;
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

export async function runRegimeCompositeShortCycleGuarded(
  opts: Parameters<typeof runRegimeCompositeShortCycle>[0],
): Promise<RCSCycleResult | null> {
  try {
    return await runRegimeCompositeShortCycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  }
}

// ── report ──────────────────────────────────────────────────────────────────
export interface RegimeCompositeShortReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  axisScoreMax: number;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  mfeGivebackShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string; axisScoreAtEntry: number; crowdingStateAtEntry: CrowdingState; entrySetup: string | null }>;
  cycleMeta: RCSCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildRegimeCompositeShortReport(
  observations: readonly RegimeCompositeShortObservation[],
  cycleMeta?: RCSCycleMeta,
): RegimeCompositeShortReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const mfeGiveback = resolved.filter((o) => o.exitReason === "MFE_GIVEBACK").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = mean(nets);
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({ symbol: o.symbol, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt, axisScoreAtEntry: o.axisScoreAtEntry, crowdingStateAtEntry: o.crowdingStateAtEntry, entrySetup: o.entrySetup ?? null }));

  return {
    laneId: RCS_PAPER_LANE_ID,
    interval: RCS_INTERVAL,
    universe: RCS_UNIVERSE,
    axisScoreMax: RCS_AXIS_SCORE_MAX,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    mfeGivebackShare: resolved.length ? mfeGiveback / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

// ── confirmation seam ────────────────────────────────────────────────────────
/** This lane's OPEN observations → the generic fresh-signal shape the unified brain reads for its
 *  SHORT confirmation vote. Mirror of regimeCompositeOpenSignals. Confirmation-only: there is no
 *  executor adapter — the brain never routes real orders through this lane. */
export function regimeCompositeShortOpenSignals(store: RegimeCompositeShortStore): SingleSymbolFreshSignal[] {
  return store.all
    .filter((o) => o.status === "OPEN")
    .map((o) => ({
      observationId: o.observationId,
      symbol: o.symbol,
      entryPrice: o.entryPrice,
      stopPrice: o.initialStop,
      openedAtMs: o.openedAtMs,
    }));
}

/** Exchange execution uses the exact MFE-giveback geometry measured by this lane. */
export function regimeCompositeShortExitPolicy(): SingleSymbolExitPolicy {
  return makeMfeGivebackExitPolicy({
    armR: RCS_MFE_ARM_R,
    givebackFrac: RCS_MFE_GIVEBACK_FRAC,
    maxHoldMs: RCS_MAX_HOLD_BARS * 3_600_000,
  });
}

/** Measurement is inert by default; real execution needs this explicit independent flag. */
export function isRegimeCompositeShortExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGIME_COMPOSITE_SHORT_EXEC_ENABLED === "1";
}

export const RCS_EXEC_LEG_USD = (): number => {
  const n = Number.parseFloat(process.env.REGIME_COMPOSITE_SHORT_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 130;
};
export const RCS_EXEC_LEVERAGE = (): number => {
  const n = Number.parseInt(process.env.REGIME_COMPOSITE_SHORT_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
export const RCS_EXEC_MAX_SIGNAL_AGE_MS = (): number =>
  Math.max(60_000, Math.floor(Number(process.env.REGIME_COMPOSITE_SHORT_EXEC_MAX_SIGNAL_AGE_MS) || 10 * 60_000));
export const RCS_EXEC_DAILY_MAX_LOSS_USD = (): number => {
  const n = Number.parseFloat(process.env.REGIME_COMPOSITE_SHORT_EXEC_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8;
};
export const RCS_EXEC_MAX_CONCURRENT = (): number => {
  const n = Number.parseInt(process.env.REGIME_COMPOSITE_SHORT_EXEC_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RCS_MAX_CONCURRENT;
};

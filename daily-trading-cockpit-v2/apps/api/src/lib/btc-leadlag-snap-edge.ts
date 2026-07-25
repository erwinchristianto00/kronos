/**
 * BTC LEAD-LAG RESIDUAL SNAP (report-only measurement lane).
 *
 * Thesis: BTC leads its correlated alts by minutes. When BTC makes a SHARP move (a "shock"),
 * high-beta alts reprice with a lag — the alts that have repriced LEAST relative to what their own
 * beta says they *should* have moved are candidates to snap toward the beta-implied level. This
 * lane shadow-enters the top laggards in the shock's direction and measures whether the residual
 * gap actually converges net of realistic costs.
 *
 *   shock:      |btcShockReturn| ≥ BLS_SHOCK_K × volBaseline, where btcShockReturn is BTC's return
 *               over the last BLS_SHOCK_WINDOW_BARS closed bars and volBaseline is the RMS of
 *               overlapping same-width returns over the trailing BLS_VOL_WINDOW_BARS ENDING BEFORE
 *               the shock window. Self-normalizing by construction — the threshold is k × BTC's own
 *               recent vol, never a fixed % magic number. (RMS around zero, not stddev: short-window
 *               crypto returns have ~zero mean; RMS is the standard scale estimate at this horizon
 *               and is slightly conservative when drift exists.)
 *   expected:   expectedMove = beta × btcShockReturn (per-symbol rolling OLS beta of 1-bar returns
 *               vs BTC over BLS_BETA_WINDOW_BARS — the SAME estimator residual-momentum-edge.ts
 *               uses; computeOlsBeta/computeSimpleReturns are imported from there rather than
 *               re-derived. The full residual-momentum ENGINE is NOT reused because its horizon is
 *               wrong for this lane: RM scores 24×1h formation windows — hours-scale — while this
 *               snap needs the same beta math applied to minutes-scale windows on a fast interval.)
 *   residual:   signedGap = (expectedMove − actualMove) × sign(btcShockReturn). Positive = the alt
 *               has repriced LESS than beta implies in the shock's direction (a laggard). An alt
 *               that already moved in line (signedGap ≈ 0) or overshot (signedGap < 0) is excluded
 *               — candidates need signedGap ≥ BLS_MIN_GAP_FRACTION × |expectedMove| (again
 *               normalized to the symbol's own expected repricing, no absolute % threshold).
 *   entry:      top BLS_TOP_N laggards by signedGap, direction = shock direction, entry = current
 *               close. Established correlated symbols ONLY: the OTHER cluster (correlation-
 *               clusters.ts's catch-all for unmapped symbols) is excluded — "expected co-movement"
 *               is meaningless for a symbol with no known cluster relationship.
 *   target:     entry moved BY the residual gap in the shock direction (the gap closes, assuming
 *               BTC holds its shock move). Convergence is measured in the ALT's own price space —
 *               if BTC reverses instead, the alt tends to fall back through the stop, which the
 *               thesis must absorb as a genuine loss (documented judgment call: it keeps resolution
 *               candle-walkable and exactly-once like every sibling lane, instead of requiring a
 *               joint BTC+alt re-evaluation at the slow cycle cadence).
 *   stop:       the residual WIDENING distance: BLS_STOP_GAP_MULTIPLE × gap (floored at
 *               BLS_STOP_FLOOR_BPS so microscopic gaps can't create degenerate stops). If the alt
 *               keeps underperforming past that, it was lagging for a REASON — cut. House style:
 *               R DENOMINATOR = this stop distance, frozen at entry. Stop fills are honest: a bar
 *               that OPENS through the stop books at its open, i.e. WORSE than −1R, never clamped.
 *   resolve:    first-touch candle walk strictly after entry (SL-first on an ambiguous same-candle
 *               touch, same convention as every sibling), max-hold mark-to-market after
 *               BLS_MAX_HOLD_BARS (hours-scale — this is a fast lane), stale-expiry fallback for
 *               symbols whose candle fetch fails persistently (same stuck-open fix as RM's 07-11).
 *
 * CADENCE CAVEAT (honest limitation, by design for now): this lane rides the shared shadow ticker
 * (~7 min), so a minutes-scale shock is DETECTED up to ~7 min + one bar-close late. Detection
 * latency (now − shock-window close) is recorded per entry and surfaced in the report so the decay
 * cost of the slow cadence is measured, not hidden. A dedicated faster ticker is a later upgrade
 * IF the lane shows edge despite the handicap — do not build it speculatively.
 *
 * Pure measurement: records and resolves shadow observations, exposes a report. NO orders, NO
 * execution-engine wiring, NOTHING trades until the book proves positive (house rule: every new
 * lane proves edge in shadow first). Independent module: own store, cycle, resolver, report.
 * edgeReady gate identical to every sibling: n≥30 && netAvgR≥0.05 && PF>1.1.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { clusterOf, OTHER_CLUSTER } from "./correlation-clusters.js";
import { computeOlsBeta, computeSimpleReturns } from "./residual-momentum-edge.js";
import { CROSS_SECTIONAL_UNIVERSE } from "./cross-sectional-edge.js";
import { REALISTIC_ROUND_TRIP_FEE_SLIP_BPS, REALISTIC_SLIPPAGE_BPS_PER_SIDE } from "./shadow-engine.js";

function envNumPos(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export const BLS_LANE_ID = "BTC_LEADLAG_RESIDUAL_SNAP" as const;
export const BLS_BENCHMARK_SYMBOL = "BTCUSDT";

/** Fast interval — the shock is a minutes-scale event. Same lookup convention as sibling lanes. */
export const BLS_INTERVAL = process.env.BTC_LEADLAG_INTERVAL || "5m";
const BLS_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
};
export const BLS_BAR_MS = BLS_INTERVAL_MS[BLS_INTERVAL] ?? BLS_INTERVAL_MS["5m"]!;

/** Shock window: BTC return measured over this many closed bars (3 × 5m = 15 minutes). */
export const BLS_SHOCK_WINDOW_BARS = envNumPos("BTC_LEADLAG_SHOCK_WINDOW_BARS", 3);
/** Vol baseline: trailing window (in bars) the RMS of shock-width returns is estimated over (8h of 5m). */
export const BLS_VOL_WINDOW_BARS = envNumPos("BTC_LEADLAG_VOL_WINDOW_BARS", 96);
export const BLS_MIN_VOL_SAMPLES = envNumPos("BTC_LEADLAG_MIN_VOL_SAMPLES", 30);
/** Shock threshold: |shock return| must be ≥ this multiple of BTC's own recent vol. */
export const BLS_SHOCK_K = envNumPos("BTC_LEADLAG_SHOCK_K", 3);
/** Beta estimation: rolling OLS of 1-bar returns vs BTC over this many bars (15h of 5m). */
export const BLS_BETA_WINDOW_BARS = envNumPos("BTC_LEADLAG_BETA_WINDOW_BARS", 180);
export const BLS_MIN_BETA_SAMPLES = envNumPos("BTC_LEADLAG_MIN_BETA_SAMPLES", 60);
/** Minimum (positive) beta for a candidate — below this the beta-implied "expected move" is too
 *  small/unreliable to define a meaningful residual gap; negative-beta symbols are excluded
 *  outright (the lead-lag thesis is about positively-correlated alts). */
export const BLS_MIN_BETA = envNumPos("BTC_LEADLAG_MIN_ABS_BETA", 0.5);
/** Laggards entered per shock (top-N by residual gap). */
export const BLS_TOP_N = envNumPos("BTC_LEADLAG_TOP_N", 3);
/** Candidate gate: signedGap must be ≥ this fraction of |expectedMove| (self-normalizing). */
export const BLS_MIN_GAP_FRACTION = envNumPos("BTC_LEADLAG_MIN_GAP_FRACTION", 0.25);
/** Stop distance = this multiple of the residual gap (the gap widening we tolerate)… */
export const BLS_STOP_GAP_MULTIPLE = envNumPos("BTC_LEADLAG_STOP_GAP_MULTIPLE", 1.5);
/** …floored here so a microscopic gap cannot create a degenerate stop where fees dwarf R. */
export const BLS_STOP_FLOOR_BPS = envNumPos("BTC_LEADLAG_STOP_FLOOR_BPS", 60);
/** Hard mark-to-market close after this many bars (36 × 5m = 3h — fast lane). */
export const BLS_MAX_HOLD_BARS = envNumPos("BTC_LEADLAG_MAX_HOLD_BARS", 36);
/** Bound on the concurrent OPEN shadow book. */
export const BLS_MAX_OPEN = envNumPos("BTC_LEADLAG_MAX_OPEN", 12);
/** Bounded retention: settled (non-OPEN) observations kept, oldest pruned first. */
export const BLS_MAX_STORED_OBSERVATIONS = envNumPos("BTC_LEADLAG_MAX_STORED_OBSERVATIONS", 500);
/** Candle fetch depth needed by the widest window (+ headroom for alignment gaps). */
export const BLS_CANDLE_FETCH_LIMIT = Math.max(BLS_BETA_WINDOW_BARS, BLS_VOL_WINDOW_BARS + BLS_SHOCK_WINDOW_BARS) + 10;

/** Universe: same symbol list the cross-sectional lanes use (env-overridable), MINUS the benchmark
 *  and MINUS anything in the OTHER cluster — candidates must be established correlated symbols
 *  with a known cluster relationship (correlation-clusters.ts), because "expected co-movement with
 *  BTC" carries no information for an unmapped grab-bag symbol. */
export const BLS_UNIVERSE: readonly string[] = (
  process.env.BTC_LEADLAG_UNIVERSE
    ? process.env.BTC_LEADLAG_UNIVERSE.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : CROSS_SECTIONAL_UNIVERSE
).filter((s) => s !== BLS_BENCHMARK_SYMBOL && clusterOf(s) !== OTHER_CLUSTER);

// ── shock detection (pure) ──────────────────────────────────────────────────

export interface BtcShockAssessment {
  /** BTC return over the last shockWindowBars closed bars. */
  shockReturn: number;
  /** RMS of overlapping shock-width returns over the trailing vol window (ends BEFORE the shock window). */
  volBaseline: number;
  /** shockReturn / volBaseline (signed). */
  zScore: number;
  isShock: boolean;
  /** Shock direction when isShock (LONG = up-shock), else null. */
  direction: "LONG" | "SHORT" | null;
  /** openTime of the LAST closed bar in the shock window — the shock's identity key. */
  shockBarOpenTime: number;
  /** Close time of that bar (openTime + bar width) — detection latency = now − this. */
  shockBarCloseTime: number;
  /** BTC close at the shock window end. */
  price: number;
}

function sortedValidCandles(candles: readonly Candle[]): Candle[] {
  return [...candles]
    .filter((c) => finite(c.close) && c.close > 0 && finite(c.openTime))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Assess whether BTC's latest short-window move is a shock relative to its OWN recent volatility.
 * Uses CLOSED candles only (the last element = the most recently closed bar — the live/partial bar
 * must not be in the input; the Binance client returns closed-bar-last series on fetch). Returns
 * null when there is not enough data to even estimate the baseline (insufficient bars, or a
 * zero-vol dead series where no scale is identifiable).
 */
export function detectBtcShock(
  btcCandles: readonly Candle[],
  opts: { shockWindowBars?: number; volWindowBars?: number; minVolSamples?: number; shockK?: number } = {},
): BtcShockAssessment | null {
  const shockWindowBars = opts.shockWindowBars ?? BLS_SHOCK_WINDOW_BARS;
  const volWindowBars = opts.volWindowBars ?? BLS_VOL_WINDOW_BARS;
  const minVolSamples = opts.minVolSamples ?? BLS_MIN_VOL_SAMPLES;
  const shockK = opts.shockK ?? BLS_SHOCK_K;

  const candles = sortedValidCandles(btcCandles);
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  if (n < shockWindowBars + minVolSamples + 1) return null;

  // Baseline region: everything strictly BEFORE the shock window (self-normalization must not let
  // the shock inflate its own yardstick). Overlapping shock-width returns, RMS around zero.
  const baselineCloses = closes.slice(0, n - shockWindowBars);
  const windowReturns: number[] = [];
  const firstIdx = Math.max(shockWindowBars, baselineCloses.length - volWindowBars);
  for (let i = firstIdx; i < baselineCloses.length; i++) {
    const past = baselineCloses[i - shockWindowBars]!;
    const cur = baselineCloses[i]!;
    if (past > 0) windowReturns.push((cur - past) / past);
  }
  if (windowReturns.length < minVolSamples) return null;
  const volBaseline = Math.sqrt(mean(windowReturns.map((r) => r * r)));
  if (!(volBaseline > 0)) return null;

  const past = closes[n - 1 - shockWindowBars]!;
  const last = closes[n - 1]!;
  if (!(past > 0)) return null;
  const shockReturn = (last - past) / past;
  const zScore = shockReturn / volBaseline;
  const isShock = Math.abs(zScore) >= shockK;
  const lastCandle = candles[candles.length - 1]!;
  return {
    shockReturn,
    volBaseline,
    zScore,
    isShock,
    direction: isShock ? (shockReturn > 0 ? "LONG" : "SHORT") : null,
    shockBarOpenTime: lastCandle.openTime,
    shockBarCloseTime: lastCandle.openTime + BLS_BAR_MS,
    price: last,
  };
}

// ── residual-gap scoring + ranking (pure) ───────────────────────────────────

export interface BtcLeadLagScore {
  symbol: string;
  cluster: string;
  price: number;
  beta: number;
  /** Alt's own return over the shock window. */
  actualMove: number;
  /** beta × btcShockReturn — what the alt "should" have moved. */
  expectedMove: number;
  /** (expectedMove − actualMove) × sign(shock): >0 = lagging in the shock's direction. */
  signedGap: number;
}

export type BtcLeadLagScoreOutcome =
  | { ok: true; score: BtcLeadLagScore }
  | { ok: false; reason: "NO_DATA" | "NO_BETA" | "LOW_BETA" };

/** Pairs alt/BTC closes on common openTimes (ascending) — real fetches can differ in coverage;
 *  aligning by timestamp avoids pairing an alt bar with the WRONG BTC bar (same rationale as
 *  residual-momentum-edge.ts's aligner). */
function alignClosesByOpenTime(
  symbolCandles: readonly Candle[],
  btcCandles: readonly Candle[],
): { symbolCloses: number[]; btcCloses: number[]; lastOpenTime: number | null } {
  const btcByTime = new Map<number, number>();
  for (const c of btcCandles) {
    if (finite(c.close) && c.close > 0) btcByTime.set(c.openTime, c.close);
  }
  const symbolCloses: number[] = [];
  const btcCloses: number[] = [];
  let lastOpenTime: number | null = null;
  for (const c of sortedValidCandles(symbolCandles)) {
    const btcClose = btcByTime.get(c.openTime);
    if (btcClose === undefined) continue;
    symbolCloses.push(c.close);
    btcCloses.push(btcClose);
    lastOpenTime = c.openTime;
  }
  return { symbolCloses, btcCloses, lastOpenTime };
}

/**
 * Score one alt against a detected BTC shock: rolling OLS beta over 1-bar aligned returns (math
 * imported from residual-momentum-edge.ts), actual vs beta-expected move over the shock window,
 * signed residual gap. Refuses to score (NO_DATA) when the alt's aligned series does not actually
 * END at the shock bar — a stale/missing latest candle would silently measure the gap over the
 * wrong window and fabricate a "laggard".
 *
 * Beta is estimated on the window ENDING BEFORE the shock bars. This is load-bearing, not a
 * nicety: the shock bars are enormous relative to quiet bars and dominate the OLS variance, so a
 * TRUE laggard (which by definition has NOT responded to those bars yet) would read as low-beta
 * and be skipped — the estimator would systematically discard exactly the candidates this lane
 * exists to find. Pre-shock beta measures the alt's NORMAL co-movement, which is what "expected
 * move" means.
 */
export function scoreLagCandidate(
  symbolCandles: readonly Candle[],
  btcCandles: readonly Candle[],
  shock: BtcShockAssessment,
  opts: { symbol: string; betaWindowBars?: number; minBetaSamples?: number; shockWindowBars?: number; minBeta?: number },
): BtcLeadLagScoreOutcome {
  const betaWindowBars = opts.betaWindowBars ?? BLS_BETA_WINDOW_BARS;
  const minBetaSamples = opts.minBetaSamples ?? BLS_MIN_BETA_SAMPLES;
  const shockWindowBars = opts.shockWindowBars ?? BLS_SHOCK_WINDOW_BARS;
  const minBeta = opts.minBeta ?? BLS_MIN_BETA;

  const { symbolCloses, btcCloses, lastOpenTime } = alignClosesByOpenTime(symbolCandles, btcCandles);
  if (lastOpenTime === null || lastOpenTime !== shock.shockBarOpenTime) return { ok: false, reason: "NO_DATA" };
  if (symbolCloses.length < shockWindowBars + 1) return { ok: false, reason: "NO_DATA" };

  // Pre-shock closes only for the beta estimate (see doc above — the shock must not contaminate
  // its own yardstick, same principle as the vol baseline in detectBtcShock).
  const preShockSymbolCloses = symbolCloses.slice(0, symbolCloses.length - shockWindowBars);
  const preShockBtcCloses = btcCloses.slice(0, btcCloses.length - shockWindowBars);
  const betaSymbolReturns = computeSimpleReturns(preShockSymbolCloses.slice(-(betaWindowBars + 1)));
  const betaBtcReturns = computeSimpleReturns(preShockBtcCloses.slice(-(betaWindowBars + 1)));
  if (betaSymbolReturns.length < minBetaSamples) return { ok: false, reason: "NO_BETA" };
  const beta = computeOlsBeta(betaSymbolReturns, betaBtcReturns);
  if (beta === null) return { ok: false, reason: "NO_BETA" };
  if (beta < minBeta) return { ok: false, reason: "LOW_BETA" };

  const past = symbolCloses[symbolCloses.length - 1 - shockWindowBars]!;
  const price = symbolCloses[symbolCloses.length - 1]!;
  if (!(past > 0 && price > 0)) return { ok: false, reason: "NO_DATA" };
  const actualMove = (price - past) / past;
  const expectedMove = beta * shock.shockReturn;
  const sign = shock.shockReturn >= 0 ? 1 : -1;
  const signedGap = (expectedMove - actualMove) * sign;
  if (!Number.isFinite(signedGap)) return { ok: false, reason: "NO_DATA" };

  return {
    ok: true,
    score: { symbol: opts.symbol, cluster: clusterOf(opts.symbol), price, beta, actualMove, expectedMove, signedGap },
  };
}

/**
 * Rank scored alts as snap candidates: keep only genuine laggards (signedGap positive AND at least
 * minGapFraction of the symbol's own |expectedMove| — self-normalizing, an alt that already moved
 * with BTC or overshot is dropped), sort by signedGap descending (most-lagging first), take topN.
 */
export function rankLaggards(
  scores: readonly BtcLeadLagScore[],
  opts: { topN?: number; minGapFraction?: number } = {},
): BtcLeadLagScore[] {
  const topN = opts.topN ?? BLS_TOP_N;
  const minGapFraction = opts.minGapFraction ?? BLS_MIN_GAP_FRACTION;
  return [...scores]
    .filter((s) => s.signedGap > 0 && Math.abs(s.expectedMove) > 0 && s.signedGap >= minGapFraction * Math.abs(s.expectedMove))
    .sort((a, b) => b.signedGap - a.signedGap)
    .slice(0, Math.max(0, topN));
}

/** True when a score would be dropped by rankLaggards' gap filter (used for skip accounting). */
export function isAlreadyMoved(score: BtcLeadLagScore, minGapFraction = BLS_MIN_GAP_FRACTION): boolean {
  return !(score.signedGap > 0 && Math.abs(score.expectedMove) > 0 && score.signedGap >= minGapFraction * Math.abs(score.expectedMove));
}

// ── geometry + resolution (pure) ────────────────────────────────────────────

export interface BtcLeadLagGeometry {
  entryPrice: number;
  /** Convergence target: entry moved BY the residual gap in the shock direction. */
  convergenceTarget: number;
  /** Residual-widening stop: gap × BLS_STOP_GAP_MULTIPLE against the trade, floored at BLS_STOP_FLOOR_BPS. */
  initialStop: number;
  /** R DENOMINATOR (house style): the stop distance, frozen at entry. */
  stopDistanceBps: number;
  targetDistanceBps: number;
}

export function buildBtcLeadLagGeometry(
  entryPrice: number,
  direction: "LONG" | "SHORT",
  gapReturn: number,
  opts: { stopGapMultiple?: number; stopFloorBps?: number } = {},
): BtcLeadLagGeometry | null {
  const stopGapMultiple = opts.stopGapMultiple ?? BLS_STOP_GAP_MULTIPLE;
  const stopFloorBps = opts.stopFloorBps ?? BLS_STOP_FLOOR_BPS;
  if (!(entryPrice > 0) || !(gapReturn > 0)) return null;
  const stopFraction = Math.max(stopGapMultiple * gapReturn, stopFloorBps / 10_000);
  const targetMove = entryPrice * gapReturn;
  const stopMove = entryPrice * stopFraction;
  const convergenceTarget = direction === "LONG" ? entryPrice + targetMove : entryPrice - targetMove;
  const initialStop = direction === "LONG" ? entryPrice - stopMove : entryPrice + stopMove;
  if (!(convergenceTarget > 0) || !(initialStop > 0)) return null;
  const risk = Math.abs(entryPrice - initialStop);
  if (!(risk > 0)) return null;
  return {
    entryPrice,
    convergenceTarget,
    initialStop,
    stopDistanceBps: (risk / entryPrice) * 10_000,
    targetDistanceBps: (targetMove / entryPrice) * 10_000,
  };
}

export interface BtcLeadLagObservation extends BtcLeadLagGeometry {
  observationId: string;
  symbol: string;
  cluster: string;
  direction: "LONG" | "SHORT";
  openedAt: string;
  openedAtMs: number;
  betaAtEntry: number;
  btcShockReturn: number;
  btcShockZScore: number;
  expectedMoveAtEntry: number;
  actualMoveAtEntry: number;
  /** The signed residual gap at entry (positive = lagging in the shock direction). */
  residualGapAtEntry: number;
  /** Identity of the shock bar this entry keyed off (exactly-once per shock bar per symbol). */
  shockBarOpenTime: number;
  /** now − shock-window close at detection — the slow-cadence handicap, measured not hidden. */
  detectionLatencyMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: "CONVERGED" | "RESIDUAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/** Realistic cost model reused verbatim from shadow-engine.ts's shared constants (same convention
 *  as residual-momentum-edge.ts): one round trip's fee+slippage in bps of notional, converted to R
 *  via the stop distance, plus an extra adverse-fill allowance on a loss. */
function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / stopDistanceBps + (isLoss ? REALISTIC_SLIPPAGE_BPS_PER_SIDE / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/**
 * Resolve an OPEN observation against forward candles strictly AFTER openedAtMs, ascending, first
 * touch wins, SL-first on an ambiguous same-candle touch (conservative, sibling convention). Once
 * an exit is decided no later candle can change it (appending candles after a decided exit is a
 * no-op — no lookahead). STOP HONESTY: if a bar OPENS beyond the stop (gapped through), the fill
 * is booked at that open — grossR comes out WORSE than −1R, never clamped to the stop. Max-hold
 * marks to market at the close of the BLS_MAX_HOLD_BARS-th forward bar. Stale-expiry fallback when
 * no forward candles ever arrive and the observation is long past its hold window (same stuck-open
 * protection as residual-momentum-edge.ts's 2026-07-11 fix).
 */
export function resolveBtcLeadLagObservation(
  obs: BtcLeadLagObservation,
  forwardCandles: readonly Candle[],
  nowMs: number,
  opts: { maxHoldBars?: number } = {},
): Partial<BtcLeadLagObservation> | null {
  const maxHoldBars = opts.maxHoldBars ?? BLS_MAX_HOLD_BARS;
  // sortedValidCandles only guarantees close/openTime (its other two call sites need nothing more)
  // — this walk also reads low/high/open for stop/target-touch and fill detection below, so a bar
  // with a non-finite low/high/open must be excluded here too, not silently treated as "no touch".
  const fwd = sortedValidCandles(forwardCandles)
    .filter((c) => c.openTime > obs.openedAtMs)
    .filter((c) => finite(c.low) && finite(c.high) && finite(c.open));
  const risk = Math.abs(obs.entryPrice - obs.initialStop);
  if (!(risk > 0)) return null;
  const isLong = obs.direction === "LONG";

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<BtcLeadLagObservation["exitReason"]>,
  ): Partial<BtcLeadLagObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return {
      status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR,
      costR,
      netR,
      exitReason,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };

  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i]!;
    const slHit = isLong ? c.low <= obs.initialStop : c.high >= obs.initialStop;
    const tpHit = isLong ? c.high >= obs.convergenceTarget : c.low <= obs.convergenceTarget;
    if (slHit) {
      // Honest stop fill: a bar that OPENED through the stop fills at its open (worse than −1R).
      const fill = isLong ? Math.min(c.open, obs.initialStop) : Math.max(c.open, obs.initialStop);
      const grossR = isLong ? (fill - obs.entryPrice) / risk : (obs.entryPrice - fill) / risk;
      return finalize(grossR, c.openTime, "RESIDUAL_STOP");
    }
    if (tpHit) {
      const grossR = isLong
        ? (obs.convergenceTarget - obs.entryPrice) / risk
        : (obs.entryPrice - obs.convergenceTarget) / risk;
      return finalize(grossR, c.openTime, "CONVERGED");
    }
    if (i + 1 >= maxHoldBars) {
      const grossR = isLong ? (c.close - obs.entryPrice) / risk : (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM");
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > maxHoldBars * BLS_BAR_MS * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ───────────────────────────────────────────────────────────────────

export interface BlsCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  /** Distinct shocks seen (deduped by shock bar — the ~7min cadence can observe one shock twice). */
  shocksDetectedTotal: number;
  candidatesRankedTotal: number;
  entriesRecordedTotal: number;
  skippedNoBetaTotal: number;
  skippedLowBetaTotal: number;
  skippedAlreadyMovedTotal: number;
  lastShockAt: string | null;
  lastShockBarOpenTime: number | null;
  lastShockZScore: number | null;
  lastShockDirection: "LONG" | "SHORT" | null;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: BlsCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  shocksDetectedTotal: 0,
  candidatesRankedTotal: 0,
  entriesRecordedTotal: 0,
  skippedNoBetaTotal: 0,
  skippedLowBetaTotal: 0,
  skippedAlreadyMovedTotal: 0,
  lastShockAt: null,
  lastShockBarOpenTime: null,
  lastShockZScore: null,
  lastShockDirection: null,
  lastCycleError: null,
};

interface BlsState {
  version: number;
  observations: BtcLeadLagObservation[];
  cycleMeta?: BlsCycleMeta;
}

export class BtcLeadLagSnapStore {
  private state: BlsState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<BlsState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as BtcLeadLagObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): BtcLeadLagObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): BlsCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: BtcLeadLagObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<BtcLeadLagObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  recordCycle(atIso: string, result: BlsCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      // Dedupe shock counting by shock-bar identity: the shared ticker (~7min) can observe the
      // SAME closed shock bar on consecutive cycles — one physical shock, one count.
      if (result.shockDetected && result.shockBarOpenTime !== null && result.shockBarOpenTime !== meta.lastShockBarOpenTime) {
        meta.shocksDetectedTotal += 1;
        meta.lastShockAt = atIso;
        meta.lastShockBarOpenTime = result.shockBarOpenTime;
        meta.lastShockZScore = result.zScore;
        meta.lastShockDirection = result.direction;
      }
      meta.candidatesRankedTotal += result.candidatesRanked;
      meta.entriesRecordedTotal += result.entriesRecorded;
      meta.skippedNoBetaTotal += result.skippedNoBeta;
      meta.skippedLowBetaTotal += result.skippedLowBeta;
      meta.skippedAlreadyMovedTotal += result.skippedAlreadyMoved;
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  /** Bounded retention: every OPEN observation is kept (must stay resolvable), plus at most
   *  BLS_MAX_STORED_OBSERVATIONS settled ones — oldest settled dropped first (repo convention). */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled = settled.length > BLS_MAX_STORED_OBSERVATIONS
      ? settled.slice(settled.length - BLS_MAX_STORED_OBSERVATIONS)
      : settled;
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

let singleton: BtcLeadLagSnapStore | null = null;
export function getBtcLeadLagSnapStore(dataDir = "data"): BtcLeadLagSnapStore {
  if (!singleton) singleton = new BtcLeadLagSnapStore(resolve(dataDir, "btc-leadlag-snap-edge.json"));
  return singleton;
}
export function _resetBtcLeadLagSnapStoreForTests(): void {
  singleton = null;
}

// ── cycle ───────────────────────────────────────────────────────────────────

export interface BlsCycleResult {
  /** false = BTC data was insufficient to even assess a shock (an honest "couldn't look", not "no shock"). */
  shockEvaluated: boolean;
  shockDetected: boolean;
  shockBarOpenTime: number | null;
  zScore: number | null;
  shockReturn: number | null;
  volBaseline: number | null;
  direction: "LONG" | "SHORT" | null;
  detectionLatencyMs: number | null;
  scanned: number;
  candidatesRanked: number;
  skippedNoData: number;
  skippedNoBeta: number;
  skippedLowBeta: number;
  skippedAlreadyMoved: number;
  skippedOpenCap: number;
  entriesRecorded: number;
  resolved: number;
  expired: number;
}

/**
 * One measurement cycle:
 *   1. fetch BTC, assess shock;
 *   2. fetch candles for symbols with OPEN observations (always — resolution must not wait for a
 *      shock) plus, ON a shock, the whole universe (fetch-budget decision: ~25 extra fetches only
 *      on shock cycles instead of every ~7 min);
 *   3. resolve OPEN observations (failed fetches pass [] so the stale-expiry fallback still runs —
 *      the RM stuck-open fix precedent);
 *   4. on a shock: score every universe symbol's beta/expected/actual/gap, rank laggards, open
 *      shadow entries in the shock direction (exactly-once per shock bar per symbol via the
 *      observation id; one OPEN observation per symbol+direction at a time; open book capped).
 * Every cycle records liveness meta — an empty book is distinguishable from a dead cycle.
 */
export async function runBtcLeadLagCycle(opts: {
  store: BtcLeadLagSnapStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
}): Promise<BlsCycleResult> {
  const result: BlsCycleResult = {
    shockEvaluated: false,
    shockDetected: false,
    shockBarOpenTime: null,
    zScore: null,
    shockReturn: null,
    volBaseline: null,
    direction: null,
    detectionLatencyMs: null,
    scanned: 0,
    candidatesRanked: 0,
    skippedNoData: 0,
    skippedNoBeta: 0,
    skippedLowBeta: 0,
    skippedAlreadyMoved: 0,
    skippedOpenCap: 0,
    entriesRecorded: 0,
    resolved: 0,
    expired: 0,
  };
  // Benchmark + OTHER-cluster exclusion enforced HERE (not only in the default universe): an
  // env-overridden universe must not smuggle unmapped symbols past the correlation premise.
  const universe = (opts.universe ?? BLS_UNIVERSE).filter(
    (s) => s.toUpperCase() !== BLS_BENCHMARK_SYMBOL && clusterOf(s) !== OTHER_CLUSTER,
  );
  const nowIso = new Date(opts.now).toISOString();

  let btcCandles: Candle[] = [];
  try {
    btcCandles = await opts.fetchCandles(BLS_BENCHMARK_SYMBOL);
  } catch {
    btcCandles = [];
  }
  const shock = btcCandles.length > 0 ? detectBtcShock(btcCandles) : null;
  if (shock) {
    result.shockEvaluated = true;
    result.zScore = shock.zScore;
    result.shockReturn = shock.shockReturn;
    result.volBaseline = shock.volBaseline;
    if (shock.isShock) {
      result.shockDetected = true;
      result.shockBarOpenTime = shock.shockBarOpenTime;
      result.direction = shock.direction;
      result.detectionLatencyMs = Math.max(0, opts.now - shock.shockBarCloseTime);
    }
  }

  // Fetch plan: open-observation symbols always (resolution), full universe only on a shock.
  const toFetch = new Set<string>(opts.store.all.filter((o) => o.status === "OPEN").map((o) => o.symbol));
  if (shock?.isShock) for (const s of universe) toFetch.add(s);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of toFetch) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* leave unset → resolution passes [] (stale-expiry fallback), scoring skips as NO_DATA */
    }
  }

  // Resolve OPEN observations first (exactly-once: only OPEN rows are ever patched).
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const patch = resolveBtcLeadLagObservation(obs, candlesBySymbol.get(obs.symbol) ?? [], opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // Shock → score, rank, enter.
  if (shock?.isShock && shock.direction) {
    const scores: BtcLeadLagScore[] = [];
    for (const symbol of universe) {
      result.scanned += 1;
      const candles = candlesBySymbol.get(symbol);
      if (!candles) {
        result.skippedNoData += 1;
        continue;
      }
      const outcome = scoreLagCandidate(candles, btcCandles, shock, { symbol });
      if (!outcome.ok) {
        if (outcome.reason === "NO_DATA") result.skippedNoData += 1;
        else if (outcome.reason === "NO_BETA") result.skippedNoBeta += 1;
        else result.skippedLowBeta += 1;
        continue;
      }
      if (isAlreadyMoved(outcome.score)) {
        result.skippedAlreadyMoved += 1;
        continue;
      }
      scores.push(outcome.score);
    }

    const laggards = rankLaggards(scores);
    result.candidatesRanked = laggards.length;
    const direction = shock.direction;
    const hasOpenSameSide = (symbol: string): boolean =>
      opts.store.all.some((o) => o.symbol === symbol && o.direction === direction && o.status === "OPEN");
    let openCount = opts.store.all.filter((o) => o.status === "OPEN").length;

    for (const lag of laggards) {
      if (openCount >= BLS_MAX_OPEN) {
        result.skippedOpenCap += 1;
        continue;
      }
      if (hasOpenSameSide(lag.symbol)) continue;
      const geometry = buildBtcLeadLagGeometry(lag.price, direction, lag.signedGap);
      if (!geometry) continue;
      const added = opts.store.add({
        ...geometry,
        observationId: `bls:${direction.toLowerCase()}:${lag.symbol}:${shock.shockBarOpenTime}`,
        symbol: lag.symbol,
        cluster: lag.cluster,
        direction,
        openedAt: nowIso,
        openedAtMs: opts.now,
        betaAtEntry: lag.beta,
        btcShockReturn: shock.shockReturn,
        btcShockZScore: shock.zScore,
        expectedMoveAtEntry: lag.expectedMove,
        actualMoveAtEntry: lag.actualMove,
        residualGapAtEntry: lag.signedGap,
        shockBarOpenTime: shock.shockBarOpenTime,
        detectionLatencyMs: result.detectionLatencyMs ?? 0,
        status: "OPEN",
        grossR: null,
        costR: null,
        netR: null,
        exitReason: null,
        resolvedAt: null,
      });
      if (added) {
        result.entriesRecorded += 1;
        openCount += 1;
      }
    }
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

/** 2026-07-21 review fix: single-flight — slow fetches can stretch a cycle past the 7-min ticker
 *  period; two interleaved cycles on the singleton store could double-enter the same shock's
 *  candidates. Same guard idiom as runExitBrainShadowCycleGuarded. */
let blsCycleInFlight = false;
export async function runBtcLeadLagCycleGuarded(
  opts: Parameters<typeof runBtcLeadLagCycle>[0],
): Promise<BlsCycleResult | null> {
  if (blsCycleInFlight) return null;
  blsCycleInFlight = true;
  try {
    return await runBtcLeadLagCycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    blsCycleInFlight = false;
  }
}

// ── report ──────────────────────────────────────────────────────────────────

export interface BtcLeadLagReport {
  laneId: string;
  interval: string;
  benchmarkSymbol: string;
  universe: readonly string[];
  params: {
    shockWindowBars: number;
    volWindowBars: number;
    shockK: number;
    betaWindowBars: number;
    minBeta: number;
    topN: number;
    minGapFraction: number;
    stopGapMultiple: number;
    stopFloorBps: number;
    maxHoldBars: number;
    maxOpen: number;
  };
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  convergedShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  byDirection: Array<{ direction: "LONG" | "SHORT"; resolvedCount: number; netAvgR: number | null; wr: number | null }>;
  /** Mean open→resolve time of CONVERGED wins — how long the snap actually takes. */
  avgLagToConvergenceMs: number | null;
  /** Mean shock-close→detection latency across all entries — the slow-ticker handicap, measured. */
  avgDetectionLatencyMs: number | null;
  avgAbsShockZAtEntry: number | null;
  topRecent: Array<{
    symbol: string;
    cluster: string;
    direction: "LONG" | "SHORT";
    netR: number | null;
    status: string;
    exitReason: string | null;
    openedAt: string;
    betaAtEntry: number;
    btcShockZScore: number;
    residualGapAtEntry: number;
    detectionLatencyMs: number;
  }>;
  cycleMeta: BlsCycleMeta | null;
}

export function buildBtcLeadLagReport(
  observations: readonly BtcLeadLagObservation[],
  cycleMeta?: BlsCycleMeta,
): BtcLeadLagReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const converged = resolved.filter((o) => o.exitReason === "CONVERGED");
  const stops = resolved.filter((o) => o.exitReason === "RESIDUAL_STOP").length;
  const netAvgR = nets.length ? mean(nets) : null;
  // Same edgeReady gate as every sibling measurement lane: n>=30, net-of-cost avg R >= 0.05, and a
  // real payoff (PF > 1.1).
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const byDirection = (["LONG", "SHORT"] as const).map((direction) => {
    const rows = resolved.filter((o) => o.direction === direction);
    const rowNets = rows.map((o) => o.netR as number);
    return {
      direction,
      resolvedCount: rows.length,
      netAvgR: rowNets.length ? mean(rowNets) : null,
      wr: rows.length ? rowNets.filter((r) => r > 0).length / rows.length : null,
    };
  });

  const convergenceLags = converged
    .filter((o) => o.resolvedAt !== null)
    .map((o) => new Date(o.resolvedAt as string).getTime() - o.openedAtMs)
    .filter((ms) => Number.isFinite(ms) && ms >= 0);

  const detectionLatencies = observations.map((o) => o.detectionLatencyMs).filter((ms) => finite(ms) && ms >= 0);

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      symbol: o.symbol,
      cluster: o.cluster,
      direction: o.direction,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
      betaAtEntry: o.betaAtEntry,
      btcShockZScore: o.btcShockZScore,
      residualGapAtEntry: o.residualGapAtEntry,
      detectionLatencyMs: o.detectionLatencyMs,
    }));

  return {
    laneId: BLS_LANE_ID,
    interval: BLS_INTERVAL,
    benchmarkSymbol: BLS_BENCHMARK_SYMBOL,
    universe: BLS_UNIVERSE,
    params: {
      shockWindowBars: BLS_SHOCK_WINDOW_BARS,
      volWindowBars: BLS_VOL_WINDOW_BARS,
      shockK: BLS_SHOCK_K,
      betaWindowBars: BLS_BETA_WINDOW_BARS,
      minBeta: BLS_MIN_BETA,
      topN: BLS_TOP_N,
      minGapFraction: BLS_MIN_GAP_FRACTION,
      stopGapMultiple: BLS_STOP_GAP_MULTIPLE,
      stopFloorBps: BLS_STOP_FLOOR_BPS,
      maxHoldBars: BLS_MAX_HOLD_BARS,
      maxOpen: BLS_MAX_OPEN,
    },
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: resolved.length ? mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))) : null,
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    convergedShare: resolved.length ? converged.length / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    byDirection,
    avgLagToConvergenceMs: convergenceLags.length ? mean(convergenceLags) : null,
    avgDetectionLatencyMs: detectionLatencies.length ? mean(detectionLatencies) : null,
    avgAbsShockZAtEntry: observations.length ? mean(observations.map((o) => Math.abs(o.btcShockZScore))) : null,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

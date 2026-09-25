/**
 * CANONICAL MARKET REGIME — calibration harness (2026-08, requirement from the canonical-market-regime
 * rollout that replaces the fixed-20 candidate LONG/SHORT vote — scan-service.ts's deriveMarketRegime —
 * as the production regime source). See canonical-market-regime-universe.ts (requirement #2, the
 * versioned dynamic universe) and canonical-market-regime-engine.ts (requirement #3, the live
 * snapshot/state-machine this harness calibrates) for the rest of the rollout.
 *
 * OFFLINE / REPORT TOOLING ONLY. This module is never on the hot path — it is run (as a script or an
 * admin route, outside this file's own scope) to FREEZE a calibration version that the LIVE engine
 * then references via its snapshot's `calibrationVersion` field. The live engine always runs with its
 * current default or last-frozen parameters regardless of whether a calibration run here is pending,
 * current, or BLOCKED (mirrors derivatives-crowding.ts's own precedent: shipped defaults stay exactly
 * where they are; a calibration pass reports on them, it does not gate whether the engine may run).
 *
 * ── WHY THIS FILE DOES NOT IMPORT canonical-market-regime-engine.ts ─────────────────────────────────
 * At the time this file was authored, canonical-market-regime-engine.ts (a separate stage of this
 * rollout) does not yet exist in this worktree. Rather than hard-depend on a module that may not be
 * built yet (or intentionally import a stub), this harness depends on the engine ONLY through a
 * narrow, STRUCTURALLY-TYPED interface: a snapshot shape (`CanonicalMarketRegimeSnapshotLike`, a
 * field-for-field mirror of the engine's own approved `CanonicalMarketRegimeSnapshot` interface) plus
 * an INJECTED pure compute function (`ComputeCanonicalMarketRegimeSnapshotFn`). This harness never
 * duplicates the engine's own state-machine/hysteresis/overlay LOGIC (that would violate "import its
 * types/snapshot shape, do not duplicate its logic") — it only duplicates the minimal TYPE SHAPE
 * needed to describe inputs/outputs, and does so structurally so that once the real engine file
 * lands, its exported snapshot type and `computeCanonicalMarketRegimeSnapshot` function can be passed
 * in directly wherever this harness expects `CanonicalMarketRegimeSnapshotLike` /
 * `ComputeCanonicalMarketRegimeSnapshotFn` with ZERO changes to this file (TypeScript structural
 * typing accepts a real `CanonicalMarketRegimeSnapshot` anywhere a structurally-identical
 * `CanonicalMarketRegimeSnapshotLike` is expected). This also means the harness is buildable and
 * testable in complete isolation, regardless of build/rollout order.
 *
 * The ONE piece of engine logic this file DOES duplicate, by necessity, is the liquidity-cap
 * weighting formula (`liquidityCappedWeights`) used solely for the CONCENTRATION metric below — see
 * that function's own doc for why, and the risk this creates (flagged in the implementation report).
 *
 * ── SPLIT MECHANIC ───────────────────────────────────────────────────────────────────────────────
 * Reuses (imports, does not reimplement) backfill-walkforward.ts's `planWalkForward`: expanding-window
 * folds over a "working" region, plus a FINAL time block reserved as an untouched holdout
 * (`holdoutFrac`, default 0.25). Chronological splits ONLY — never a random shuffle, which would leak
 * the future into the past. This harness only ever REPLAYS and SCORES the development (pre-holdout)
 * prefix; the holdout bars are surfaced in the report purely for window bookkeeping and are never fed
 * to `computeSnapshot`, never scored, never used to pick a threshold. `planWalkForward`'s own
 * per-fold output (`folds`) is surfaced on the report as `developmentFolds` for future finer-grained
 * analysis, but every metric below is computed over the WHOLE development window, not per-fold — this
 * mirrors the operator's own calibration spec ("BLOCKED if BULLISH/BEARISH/MIXED has fewer than 30
 * episodes IN THE DEVELOPMENT WINDOW"), which is a whole-window statement, not a per-fold one.
 * `planWalkForward`'s own METRICS (brierScore, decisionAlpha, maxDrawdownR, …) are outcome/PnL-shaped
 * and are deliberately NOT imported or used here — only the split mechanic is reused.
 *
 * ── SCOPE NOTE: requirement #4 (duplicate observation must not add confirmation) ────────────────────
 * This is the LIVE ENGINE's own concern (comparing `sourceObservationIds` cycle-to-cycle against a
 * 5-minute tick cadence over hourly candles) and is tested against that engine directly, not here. A
 * chronological replay over a PRE-BUILT bar sequence is, by construction, already deduplicated — each
 * row in `bars` is required to represent one distinct completed candle, so every replay step is a
 * genuinely new observation and there is nothing for this harness to deduplicate.
 *
 * ── CALIBRATION DISCIPLINE (mirrors apps/api/src/simulation/regime-conditioned-bootstrap.ts's
 * INSUFFICIENT_CALIBRATION_DATA idiom exactly) ──────────────────────────────────────────────────────
 * Every run returns a REPORT with an explicit, checkable `status`. A development window with too few
 * distinct state EPISODES (contiguous runs, never raw bar count — consecutive 5-minute/hourly-driven
 * bars in one persistent state are not independent draws) for BULLISH, BEARISH, or MIXED
 * (`MIN_CALIBRATION_STATE_EPISODES = 30`, mirroring regime-conditioned-bootstrap.ts's own
 * `MIN_EFFECTIVE_SAMPLE = 30`) returns `status: "BLOCKED_INSUFFICIENT_STATE_EPISODES"` with
 * `metrics: null` and `proposedCalibrationVersion: null` — never a silent proceed-anyway, never an
 * exception swallowed into a default. PANIC gets its OWN, separate, lower floor
 * (`MIN_PANIC_EPISODES = 8`) that affects only ONE metric's own status
 * ("EVALUATED" | "PANIC_UNEVALUATED"), never the whole run's BLOCKED verdict — panics are rare tail
 * events by design, so a calm historical window simply cannot sanity-check a tail-event trigger, which
 * is a data-availability fact, not a defect.
 *
 * ── VERSIONING ───────────────────────────────────────────────────────────────────────────────────
 * A successful (`"OK"`) report carries a deterministic `proposedCalibrationVersion`
 * (`YYYYMMDD-<devWindowStartMs>-<devWindowEndMs>-v1`). Actually FREEZING that version (add-only,
 * immutable — mirrors current-guard-variant-matrix.ts's `freezeStageCutIfAbsent` idiom exactly, right
 * down to the `hasOwnProperty`-not-truthiness presence test) is a separate, explicit call to
 * `CanonicalMarketRegimeCalibrationStore.freezeCalibrationRun`, which mints a collision-free `-vN`
 * suffix if that proposed id is already frozen (e.g. a re-run over the same window with different
 * params). The store's `activeCalibrationVersion` — the pointer the LIVE engine actually reads and
 * stamps onto every snapshot — defaults to the literal string `"v1-hand-set-defaults"` and is NEVER
 * null; it only changes via an explicit, separate `promoteActiveCalibrationVersion` operator action
 * that throws if the target version was never frozen. Running this harness NEVER auto-promotes.
 *
 * ── NO HMM / NEURAL CLASSIFIERS / LANE-PnL CALIBRATION ──────────────────────────────────────────────
 * Every metric below is computed against pure market-state/return distributions (forward CLOSE-price
 * returns, dwell times, transition counts, cross-sectional correlation, realized volatility) — never
 * realized trading PnL, netR, or any lane/strategy outcome. No hidden Markov model, no neural
 * classifier, and no combinatorial exact-context key appears anywhere in this file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { planWalkForward, type Timed, type WalkForwardFold } from "./backfill-walkforward.js";
import type { AxisRegimeFamily } from "./current-guard-variant-matrix.js";
import { createRng, type DeterministicRng } from "../simulation/deterministic-rng.js";

// ─── constants ─────────────────────────────────────────────────────────────────────────────────────

/** Mirrors regime-conditioned-bootstrap.ts's own MIN_EFFECTIVE_SAMPLE=30 for direct consistency with
 *  this codebase's existing calibration culture. Counted as DISTINCT CONTIGUOUS EPISODES, never raw
 *  bar count (see groupIntoEpisodes). Applies independently to BULLISH, BEARISH, and MIXED. */
export const MIN_CALIBRATION_STATE_EPISODES = 30;

/** PANIC's own, separate, LOWER floor — panics are rare tail events by design; demanding 30 would make
 *  BLOCKED nearly permanent. Below this floor, panicDetectionQuality.status becomes
 *  "PANIC_UNEVALUATED" (a data-availability fact, not a defect) WITHOUT blocking the rest of the run. */
export const MIN_PANIC_EPISODES = 8;

/** directionFast/directionSlow (per the engine's own design) are both derived from the SAME 1h-candle
 *  fetch per symbol: 6-bar (6h) fast return, 24-bar (24h) slow return. This harness's raw-feature
 *  builder mirrors that exactly so a replayed history means what the live engine's own hysteresis
 *  cadence assumes it means (see the loud warning in `runCanonicalMarketRegimeCalibration` below). */
export const DEFAULT_FAST_LOOKBACK_BARS = 6;
export const DEFAULT_SLOW_LOOKBACK_BARS = 24;

export const DEFAULT_WALKFORWARD_FOLDS = 3;
export const DEFAULT_HOLDOUT_FRACTION = 0.25;

/** Mirrors the engine's own liquidity-cap design (duplicated here of necessity — see file header). */
export const DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT = 0.15;

/** Mirrors the engine's own COHESION_THRESHOLD (the bar for ENTERING a directional state). Used here
 *  only to bucket bars into "cohesive" for the correlationByCohesion metric — read from
 *  `calibrationParams.cohesionEnterThreshold` when supplied, so this harness's bucket boundary can
 *  never silently drift from whatever threshold actually produced the replayed snapshots. */
export const DEFAULT_COHESIVE_BUCKET_THRESHOLD = 0.55;

/** Missing-data-robustness re-run: fraction of the (whole-history) symbol set dropped entirely before
 *  re-replaying. 20% is a reasoned v1 default — large enough to meaningfully stress the classifier,
 *  small enough that "did coverage correctly degrade" is still a meaningful question rather than a
 *  guaranteed LOW_COVERAGE on every bar. Read from `calibrationParams.missingDataDropFraction` /
 *  the function's own `missingDataDropFraction` argument when supplied. */
export const DEFAULT_MISSING_DATA_DROP_FRACTION = 0.2;

/** Required bar-level projection-agreement between the full-data replay and the masked replay, in
 *  PERCENT (0-100). Mirrors historical-block-bootstrap.ts's "seam/stitch tolerances, never smoothing
 *  discontinuities" discipline: a real robustness check, not a rubber stamp. */
export const MISSING_DATA_STATE_AGREEMENT_THRESHOLD_PCT = 90;

/** Rolling-window width (in bars) for the correlationByCohesion metric's pairwise-correlation
 *  computation. A reasoned v1 default (24h at an assumed 1h bar grid) — long enough for a
 *  correlation estimate to be minimally stable, short enough to track a regime that may itself be
 *  changing every few hours. */
export const CORRELATION_ROLLING_WINDOW_BARS = 24;

/** Hard cap on symbols sampled per correlation window, purely to bound compute cost
 *  (O(symbols^2 * windowBars) per bar otherwise) for an offline report tool run over potentially
 *  thousands of bars. Symbols are chosen deterministically (alphabetically first N of whichever
 *  symbols have complete data across the window) — never randomly — so repeated runs over the same
 *  data are byte-identical. */
export const MAX_CORRELATION_SAMPLE_SYMBOLS = 20;

/** What counts as a "proxy severe event" for the panicDetectionQuality recall/precision check: the
 *  operator's design does not pin an exact numeric definition (only "recall/precision against a
 *  labeled or proxy severe-event set") — this harness defines it as an equal-weighted, market-level
 *  1h forward return whose ABSOLUTE VALUE exceeds this threshold. Market-level (never per-candidate)
 *  and derived from REALIZED forward returns (never lane/strategy PnL), consistent with the
 *  "future market distributions only" constraint. Read from
 *  `calibrationParams.proxySevereEventAbsReturnThreshold` when supplied. */
export const DEFAULT_PROXY_SEVERE_EVENT_ABS_RETURN_THRESHOLD = 0.03;

export const CANONICAL_MARKET_REGIME_CALIBRATION_SCHEMA_VERSION = 1;

/** Never null/undefined — every snapshot is always traceable to exactly one calibration lineage, even
 *  before any real calibration run has ever been frozen and promoted. */
export const ACTIVE_CALIBRATION_VERSION_DEFAULT = "v1-hand-set-defaults";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ─── structural mirror of canonical-market-regime-engine.ts's snapshot shape ───────────────────────
// See the file-header note: this is NOT an import (that module does not exist in this worktree yet).
// Field-for-field mirror of the approved design's `CanonicalMarketRegimeSnapshot` interface.

export type CanonicalMarketRegimeProjection = "BULLISH" | "BEARISH" | "MIXED";
export type CanonicalMarketRegimeDataQuality = "OK" | "STALE" | "MISSING";
export type CanonicalMarketRegimeCoverageStatus = "VALID" | "DEGRADED" | "INVALID";
export type CanonicalMarketRegimeSnapshotStatusLike =
  | "VALID"
  | "DEGRADED_STALE_UNIVERSE"
  | "DEGRADED_INSUFFICIENT_SYMBOLS"
  | "ENGINE_DISABLED"
  | "COMPUTE_ERROR";

export interface CanonicalMarketRegimePerSymbolLike {
  symbol: string;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
  spreadBps: number | null;
  openInterestUsd: number | null;
  dataQuality: CanonicalMarketRegimeDataQuality;
}

export interface CanonicalMarketRegimeCoverageLike {
  validSymbolCount: number;
  requiredSymbolCount: number;
  coveragePct: number;
  status: CanonicalMarketRegimeCoverageStatus;
  reasons: string[];
}

export interface CanonicalMarketRegimeOverlaysLike {
  transition: boolean;
  highStress: boolean;
  panic: boolean;
  lowCoverage: boolean;
  rotational: boolean;
  fragmented: boolean;
}

export interface CanonicalMarketRegimeStateHistoryLike {
  projectionSinceMs: number;
  cyclesInProjection: number;
  lastFlipAtMs: number | null;
  panicSinceMs: number | null;
  panicCyclesSinceExitCandidate: number;
}

/**
 * Structural mirror of canonical-market-regime-engine.ts's `CanonicalMarketRegimeSnapshot` — see the
 * file-header note for why this is a locally-declared structural type rather than an import. A real
 * `CanonicalMarketRegimeSnapshot` (once that module exists) satisfies this type with zero adapter
 * code, and can be passed to every function in this file unmodified.
 */
export interface CanonicalMarketRegimeSnapshotLike {
  schemaVersion: 1;
  engineVersion: string;
  calibrationVersion: string;
  atMs: number;
  universeVersion: string;
  universeSize: number;
  perSymbol: CanonicalMarketRegimePerSymbolLike[];
  directionFast: number;
  directionSlow: number;
  breadth: number;
  cohesion: number;
  dispersion: number;
  riskStress: number;
  coverage: CanonicalMarketRegimeCoverageLike;
  projection: CanonicalMarketRegimeProjection;
  regimeFamily: AxisRegimeFamily;
  overlays: CanonicalMarketRegimeOverlaysLike;
  confidence: number;
  stateHistory: CanonicalMarketRegimeStateHistoryLike;
  status: CanonicalMarketRegimeSnapshotStatusLike;
}

/** The pure core's INPUT features for one bar — distinct from (and simpler than) the snapshot's own
 *  richer `perSymbol` bookkeeping above. Built from raw completed-candle data only; a symbol with
 *  insufficient lookback history or a missing candle gets `null`, NEVER a fabricated 0. */
export interface CanonicalMarketRegimeRawSymbolFeatureLike {
  symbol: string;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
}

export interface CanonicalMarketRegimeRawFeaturesLike {
  atMs: number;
  perSymbol: CanonicalMarketRegimeRawSymbolFeatureLike[];
}

/**
 * Structural mirror of the engine's own pure core signature:
 * `computeCanonicalMarketRegimeSnapshot(rawFeatures, priorSnapshot, calibrationParams, nowMs)`.
 * `calibrationParams` is typed as a plain named-threshold bag (`Record<string, number>`) rather than
 * a specific interface, since the engine module that would define the authoritative shape does not
 * exist in this worktree yet — this keeps the harness decoupled and simple at the cost of losing
 * compile-time key checking until that type can be imported directly (see implementation report).
 */
export type ComputeCanonicalMarketRegimeSnapshotFn = (
  rawFeatures: CanonicalMarketRegimeRawFeaturesLike,
  priorSnapshot: CanonicalMarketRegimeSnapshotLike | null,
  calibrationParams: Record<string, number>,
  nowMs: number,
) => CanonicalMarketRegimeSnapshotLike;

// ─── historical bar input ───────────────────────────────────────────────────────────────────────────

/**
 * One bar of historical, already-assembled market data. `tMs` is the bar's CLOSE time (the causal
 * "as-of" instant — matches `Timed`'s contract, which `planWalkForward` sorts/splits purely by
 * `tMs`). A symbol MISSING a candle at this bar is represented by its ABSENCE from `closesBySymbol`,
 * never a fabricated 0/null entry (mirrors replay-tier-a-core.ts's "missing inputs are {value:null},
 * never fabricated" discipline, applied at the map-membership level here).
 */
export interface CalibrationHistoricalBar extends Timed {
  tMs: number;
  closesBySymbol: Map<string, number>;
  /** Optional per-symbol 24h-quote-volume snapshot at this bar — used ONLY by the concentration
   *  metric's liquidity-cap weighting. Absent for a bar/symbol simply excludes that symbol from THAT
   *  bar's weight computation (never defaulted to 0, which would silently zero its weight rather than
   *  correctly excluding it). */
  quoteVolume24hUsdBySymbol?: Map<string, number>;
}

/** Default `universeAtBar`: whatever symbols this bar itself has a close for. Reconstructing a
 *  genuinely historical, point-in-time (accounting for delistings/new listings) universe is out of
 *  scope for this offline harness — callers with real point-in-time membership data should inject
 *  their own `universeAtBar` function instead. */
export function universeFromBarMembership(bar: CalibrationHistoricalBar): string[] {
  return [...bar.closesBySymbol.keys()].sort();
}

/**
 * Convenience bridge from PER-SYMBOL candle series (e.g. BinanceClient.getCandles output — anything
 * shaped `{ openTime, close }` satisfies this structurally, no adapter needed) to this harness's own
 * bar format. Bars are aligned by candle OPEN time, assuming every symbol shares the same fixed-
 * interval grid (this module is otherwise interval-agnostic, but DEFAULT_FAST_LOOKBACK_BARS=6 /
 * DEFAULT_SLOW_LOOKBACK_BARS=24 / the 1h/4h/24h forward-return horizons only mean what the engine's
 * own design intends if the caller does in fact pass 1h candles — see the loud runtime warning in
 * `runCanonicalMarketRegimeCalibration`). A symbol missing a candle at a given openTime is simply
 * ABSENT from that bar (never fabricated — see file header).
 */
export function buildCalibrationBarsFromCandles(
  candlesBySymbol: Record<string, Array<{ openTime: number; close: number }>>,
  quoteVolume24hUsdBySymbolAndTime?: Record<string, Record<number, number>>,
): CalibrationHistoricalBar[] {
  const byOpenTime = new Map<number, Map<string, number>>();
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    for (const c of candles) {
      if (!Number.isFinite(c.openTime) || !Number.isFinite(c.close) || c.close <= 0) continue;
      let row = byOpenTime.get(c.openTime);
      if (!row) {
        row = new Map<string, number>();
        byOpenTime.set(c.openTime, row);
      }
      row.set(symbol, c.close);
    }
  }
  const openTimes = [...byOpenTime.keys()].sort((a, b) => a - b);
  const bars: CalibrationHistoricalBar[] = [];
  for (const openTime of openTimes) {
    const closesBySymbol = byOpenTime.get(openTime)!;
    let quoteVolume24hUsdBySymbol: Map<string, number> | undefined;
    if (quoteVolume24hUsdBySymbolAndTime) {
      const row = new Map<string, number>();
      for (const symbol of closesBySymbol.keys()) {
        const v = quoteVolume24hUsdBySymbolAndTime[symbol]?.[openTime];
        if (typeof v === "number" && Number.isFinite(v)) row.set(symbol, v);
      }
      if (row.size > 0) quoteVolume24hUsdBySymbol = row;
    }
    bars.push({ tMs: openTime, closesBySymbol, quoteVolume24hUsdBySymbol });
  }
  return bars;
}

// ─── pure numeric helpers ───────────────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((a, v) => a + v, 0) / xs.length;
}

function stdevOf(xs: number[], m?: number): number | null {
  const u = xs.filter((v) => Number.isFinite(v));
  if (u.length < 2) return null;
  const mm = m ?? mean(u);
  const variance = u.reduce((a, v) => a + (v - mm) ** 2, 0) / (u.length - 1);
  return Math.sqrt(variance);
}

export interface ForwardReturnConditionalStats {
  n: number;
  mean: number | null;
  stdev: number | null;
  skew: number | null;
}

function forwardReturnStats(xs: number[]): ForwardReturnConditionalStats {
  const u = xs.filter((v) => Number.isFinite(v));
  if (u.length === 0) return { n: 0, mean: null, stdev: null, skew: null };
  const m = mean(u);
  const sd = u.length >= 2 ? stdevOf(u, m) : null;
  const skew = sd !== null && sd > 0 ? u.reduce((a, v) => a + ((v - m) / sd) ** 3, 0) / u.length : null;
  return { n: u.length, mean: m, stdev: sd, skew };
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ─── episode grouping (distinct contiguous runs — never raw bar count) ────────────────────────────

export interface StateEpisode {
  state: string;
  startIdx: number;
  endIdx: number;
  startMs: number;
  endMs: number;
  lengthBars: number;
}

/** Groups a chronological label sequence into DISTINCT CONTIGUOUS episodes. An "episode" is one
 *  uninterrupted stretch of the same state — consecutive bars in one persistent state are not
 *  independent draws (the same discipline this codebase applies to netR observations elsewhere,
 *  applied here to regime-state bars). `rows` must already be in chronological order. */
export function groupIntoEpisodes(rows: Array<{ tMs: number; state: string }>): StateEpisode[] {
  const episodes: StateEpisode[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i]!;
    const last = episodes.length > 0 ? episodes[episodes.length - 1] : undefined;
    if (last && last.state === cur.state) {
      last.endIdx = i;
      last.endMs = cur.tMs;
      last.lengthBars += 1;
    } else {
      episodes.push({ state: cur.state, startIdx: i, endIdx: i, startMs: cur.tMs, endMs: cur.tMs, lengthBars: 1 });
    }
  }
  return episodes;
}

// ─── liquidity-capped weighting (duplicated from the engine's own design — see file header) ───────

/**
 * Mirrors the engine's own liquidity-cap formula EXACTLY as specified in the approved design: raw
 * weight per symbol = sqrt(quoteVolume24hUsd) (compresses the BTC-vs-microcap tail before capping),
 * normalized to sum=1, then any symbol's share above `maxWeightPct` has the excess redistributed
 * proportionally among symbols STRICTLY below the cap (iterative water-filling; a capped symbol is
 * never re-credited with more of the excess, which would let it silently exceed the cap despite the
 * cap "appearing" to be applied). Duplicated here (not imported) because
 * canonical-market-regime-engine.ts does not exist in this worktree yet — see the file-header risk
 * note: once it lands, this calibration harness's concentration metric should import and reuse the
 * engine's own weight-computation function directly instead of this local copy, so the two can never
 * silently drift apart.
 *
 * Degenerate small-universe guarantee: the 15%-style cap is only mathematically satisfiable (every
 * symbol's weight <= cap, AND weights summing to 1) when there are at least `ceil(1/maxWeightPct)`
 * symbols with positive weight. Below that count, the cap is structurally unsatisfiable no matter the
 * algorithm — this function ALWAYS returns weights summing to 1 (renormalizing at the end if the
 * water-filling loop could not fully redistribute), but a returned weight MAY then exceed
 * `maxWeightPct` in that specific, documented, small-universe corner case. This is a report-only
 * metric on a near-empty universe, never a live gating decision.
 */
export function liquidityCappedWeights(volumesBySymbol: Record<string, number>, maxWeightPct: number): Record<string, number> {
  const symbols = Object.keys(volumesBySymbol);
  if (symbols.length === 0) return {};
  if (symbols.length === 1) return { [symbols[0]!]: 1 };

  const raw: Record<string, number> = {};
  let rawSum = 0;
  for (const s of symbols) {
    const v = volumesBySymbol[s]!;
    const w = Number.isFinite(v) && v > 0 ? Math.sqrt(v) : 0;
    raw[s] = w;
    rawSum += w;
  }

  const weights: Record<string, number> = {};
  if (rawSum <= 0) {
    // No usable volume anywhere — equal-weight fallback. This is a degenerate-input guard; the
    // calibration report's own coverage metric is what actually flags a bar this thin as a data
    // problem, not this weighting helper.
    const eq = 1 / symbols.length;
    for (const s of symbols) weights[s] = eq;
    return weights;
  }
  for (const s of symbols) weights[s] = raw[s]! / rawSum;

  for (let pass = 0; pass < 20; pass += 1) {
    const capped = symbols.filter((s) => weights[s]! > maxWeightPct);
    if (capped.length === 0) break;
    let excess = 0;
    for (const s of capped) {
      excess += weights[s]! - maxWeightPct;
      weights[s] = maxWeightPct;
    }
    const uncapped = symbols.filter((s) => weights[s]! < maxWeightPct);
    const uncappedSum = uncapped.reduce((a, s) => a + weights[s]!, 0);
    if (uncapped.length === 0 || uncappedSum <= 0) break; // structurally unsatisfiable — see doc above
    for (const s of uncapped) weights[s] = weights[s]! + excess * (weights[s]! / uncappedSum);
  }

  const total = symbols.reduce((a, s) => a + weights[s]!, 0);
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (const s of symbols) weights[s] = weights[s]! / total;
  }
  return weights;
}

// ─── raw-feature construction from historical bars ─────────────────────────────────────────────────

function returnOverLookback(sortedBars: CalibrationHistoricalBar[], index: number, lookbackBars: number, symbol: string): number | null {
  const prevIndex = index - lookbackBars;
  if (prevIndex < 0) return null; // not enough history yet — never fabricated
  const closeNow = sortedBars[index]!.closesBySymbol.get(symbol);
  const closePrev = sortedBars[prevIndex]!.closesBySymbol.get(symbol);
  if (closeNow === undefined || closePrev === undefined) return null;
  if (!Number.isFinite(closeNow) || !Number.isFinite(closePrev) || !(closePrev > 0)) return null;
  return closeNow / closePrev - 1;
}

/** Builds one bar's raw features (INPUT to `computeSnapshot`) from causal, already-completed candle
 *  history. A symbol absent from `universe`, or lacking enough lookback history, or missing a close at
 *  either endpoint, gets `null` fields — never a fabricated 0. */
export function computeRawFeaturesForBar(
  sortedBars: CalibrationHistoricalBar[],
  index: number,
  fastLookbackBars: number,
  slowLookbackBars: number,
  universe: string[],
): CanonicalMarketRegimeRawFeaturesLike {
  const bar = sortedBars[index]!;
  const perSymbol: CanonicalMarketRegimeRawSymbolFeatureLike[] = [];
  for (const symbol of universe) {
    const returnFastPct = returnOverLookback(sortedBars, index, fastLookbackBars, symbol);
    const returnSlowPct = returnOverLookback(sortedBars, index, slowLookbackBars, symbol);
    const vol = bar.quoteVolume24hUsdBySymbol?.get(symbol);
    const quoteVolume24hUsd = typeof vol === "number" && Number.isFinite(vol) ? vol : null;
    perSymbol.push({ symbol, returnFastPct, returnSlowPct, quoteVolume24hUsd });
  }
  return { atMs: bar.tMs, perSymbol };
}

// ─── chronological replay (the pure core most of the 11 adversarial tests call directly, but against
//     the REAL engine's computeCanonicalMarketRegimeSnapshot — this harness just drives it causally
//     over history) ──────────────────────────────────────────────────────────────────────────────────

export interface ReplayRow {
  tMs: number;
  rawFeatures: CanonicalMarketRegimeRawFeaturesLike;
  snapshot: CanonicalMarketRegimeSnapshotLike;
}

export interface ReplayResult {
  rows: ReplayRow[];
}

export interface ReplayCanonicalMarketRegimeHistoryArgs {
  bars: CalibrationHistoricalBar[];
  computeSnapshot: ComputeCanonicalMarketRegimeSnapshotFn;
  calibrationParams: Record<string, number>;
  universeAtBar?: (bar: CalibrationHistoricalBar) => string[];
  fastLookbackBars?: number;
  slowLookbackBars?: number;
}

/**
 * Chronologically replays `computeSnapshot` bar-by-bar over `bars` — mirrors replay-tier-a-core.ts's
 * frozen causal-replay discipline: each step only ever sees CLOSED candles up to and including that
 * bar, and the PRIOR snapshot fed to step i+1 is exactly the snapshot step i produced (`null` for the
 * very first bar — cold start). One row is emitted per input bar; `bars` need not be pre-sorted (this
 * function sorts a copy).
 */
export function replayCanonicalMarketRegimeHistory(args: ReplayCanonicalMarketRegimeHistoryArgs): ReplayResult {
  const sortedBars = [...args.bars].sort((a, b) => a.tMs - b.tMs);
  const fastLookbackBars = args.fastLookbackBars ?? DEFAULT_FAST_LOOKBACK_BARS;
  const slowLookbackBars = args.slowLookbackBars ?? DEFAULT_SLOW_LOOKBACK_BARS;
  const universeAtBar = args.universeAtBar ?? universeFromBarMembership;

  const rows: ReplayRow[] = [];
  let prior: CanonicalMarketRegimeSnapshotLike | null = null;
  for (let i = 0; i < sortedBars.length; i += 1) {
    const bar = sortedBars[i]!;
    const universe = universeAtBar(bar);
    const rawFeatures = computeRawFeaturesForBar(sortedBars, i, fastLookbackBars, slowLookbackBars, universe);
    const snapshot = args.computeSnapshot(rawFeatures, prior, args.calibrationParams, bar.tMs);
    rows.push({ tMs: bar.tMs, rawFeatures, snapshot });
    prior = snapshot;
  }
  return { rows };
}

// ─── forward returns (equal-weighted, market-level, zero PnL) ─────────────────────────────────────

function forwardReturnAtBar(sortedBars: CalibrationHistoricalBar[], index: number, horizonBars: number): number | null {
  const futureIndex = index + horizonBars;
  if (futureIndex >= sortedBars.length) return null;
  const now = sortedBars[index]!;
  const future = sortedBars[futureIndex]!;
  const rets: number[] = [];
  for (const [symbol, closeNow] of now.closesBySymbol) {
    if (!Number.isFinite(closeNow) || !(closeNow > 0)) continue;
    const closeFuture = future.closesBySymbol.get(symbol);
    if (closeFuture === undefined || !Number.isFinite(closeFuture)) continue;
    rets.push(closeFuture / closeNow - 1);
  }
  if (rets.length === 0) return null;
  return mean(rets);
}

// ─── correlation-by-cohesion (rolling, capped, deterministic) ──────────────────────────────────────

function avgPairwiseCorrelationAtBar(sortedBars: CalibrationHistoricalBar[], index: number, windowBars: number, maxSymbols: number): number | null {
  const start = index - windowBars + 1;
  if (start < 0) return null;
  let candidateSymbols: string[] | null = null;
  for (let i = start; i <= index; i += 1) {
    const present = sortedBars[i]!.closesBySymbol;
    const presentSymbols = new Set<string>();
    for (const [s, c] of present) if (Number.isFinite(c) && c > 0) presentSymbols.add(s);
    candidateSymbols = candidateSymbols === null ? [...presentSymbols] : candidateSymbols.filter((s) => presentSymbols.has(s));
  }
  if (!candidateSymbols || candidateSymbols.length < 3) return null;
  candidateSymbols = candidateSymbols.slice().sort().slice(0, maxSymbols); // deterministic cap, never random

  const series: Record<string, number[]> = {};
  for (const s of candidateSymbols) {
    const closes: number[] = [];
    for (let i = start; i <= index; i += 1) closes.push(sortedBars[i]!.closesBySymbol.get(s)!);
    const rets: number[] = [];
    for (let k = 1; k < closes.length; k += 1) rets.push(closes[k]! / closes[k - 1]! - 1);
    series[s] = rets;
  }
  const pairs: number[] = [];
  for (let a = 0; a < candidateSymbols.length; a += 1) {
    for (let b = a + 1; b < candidateSymbols.length; b += 1) {
      const r = pearsonCorrelation(series[candidateSymbols[a]!]!, series[candidateSymbols[b]!]!);
      if (r !== null) pairs.push(r);
    }
  }
  return pairs.length > 0 ? mean(pairs) : null;
}

interface CorrelationByCohesionResult {
  fragmentedMean: number | null;
  cohesiveMean: number | null;
  fragmentedLowerConfirmed: boolean | null;
  sampledBars: number;
}

function computeCorrelationByCohesion(
  devBars: CalibrationHistoricalBar[],
  replay: ReplayResult,
  cohesiveThreshold: number,
): CorrelationByCohesionResult {
  const fragmented: number[] = [];
  const cohesive: number[] = [];
  for (let i = 0; i < devBars.length; i += 1) {
    const row = replay.rows[i];
    if (!row) continue;
    const corr = avgPairwiseCorrelationAtBar(devBars, i, CORRELATION_ROLLING_WINDOW_BARS, MAX_CORRELATION_SAMPLE_SYMBOLS);
    if (corr === null) continue;
    if (row.snapshot.overlays.fragmented) fragmented.push(corr);
    else if (row.snapshot.cohesion >= cohesiveThreshold) cohesive.push(corr);
  }
  const fragmentedMean = fragmented.length > 0 ? mean(fragmented) : null;
  const cohesiveMean = cohesive.length > 0 ? mean(cohesive) : null;
  return {
    fragmentedMean,
    cohesiveMean,
    fragmentedLowerConfirmed: fragmentedMean !== null && cohesiveMean !== null ? fragmentedMean < cohesiveMean : null,
    sampledBars: fragmented.length + cohesive.length,
  };
}

// ─── concentration (empirical max realized single-symbol weight share) ────────────────────────────

interface ConcentrationResult {
  maxRealizedSingleSymbolWeightSharePct: number;
  withinCapConfirmed: boolean;
}

/** This is fundamentally a SELF-CONSISTENCY check on `liquidityCappedWeights`'s own cap enforcement
 *  (applied identically here and, once the real engine lands, inside its own weighting function) over
 *  REAL replayed history — not a market-data finding. A violation here (outside the documented
 *  degenerate small-universe corner case) would indicate a bug in the cap/redistribution algorithm
 *  itself, which is exactly the direct empirical check adversarial test B calls for. */
function computeConcentrationMetric(rows: ReplayRow[], maxWeightPct: number): ConcentrationResult {
  let maxShare = 0;
  for (const row of rows) {
    const volumes: Record<string, number> = {};
    for (const s of row.rawFeatures.perSymbol) {
      if (s.quoteVolume24hUsd !== null && s.quoteVolume24hUsd > 0) volumes[s.symbol] = s.quoteVolume24hUsd;
    }
    if (Object.keys(volumes).length === 0) continue;
    const weights = liquidityCappedWeights(volumes, maxWeightPct);
    for (const w of Object.values(weights)) if (w > maxShare) maxShare = w;
  }
  return { maxRealizedSingleSymbolWeightSharePct: maxShare * 100, withinCapConfirmed: maxShare <= maxWeightPct + 1e-9 };
}

// ─── missing-data robustness (re-run with symbols dropped, require high state agreement) ──────────

interface MissingDataRobustnessResult {
  droppedFraction: number;
  stateAgreementPct: number;
  robustnessConfirmed: boolean;
}

function computeMissingDataRobustness(args: {
  devBars: CalibrationHistoricalBar[];
  universeAtBar: (bar: CalibrationHistoricalBar) => string[];
  computeSnapshot: ComputeCanonicalMarketRegimeSnapshotFn;
  calibrationParams: Record<string, number>;
  fastLookbackBars: number;
  slowLookbackBars: number;
  fullRun: ReplayResult;
  dropFraction: number;
  rng: DeterministicRng;
}): MissingDataRobustnessResult | null {
  const allSymbols = new Set<string>();
  for (const b of args.devBars) for (const s of b.closesBySymbol.keys()) allSymbols.add(s);
  const symbolList = [...allSymbols].sort();
  if (symbolList.length < 4) return null; // too small a universe to meaningfully drop a fraction of it

  const dropCount = Math.max(1, Math.min(symbolList.length - 1, Math.round(symbolList.length * args.dropFraction)));
  const shuffled = args.rng.shuffle(symbolList);
  const dropped = new Set(shuffled.slice(0, dropCount));

  const maskedBars: CalibrationHistoricalBar[] = args.devBars.map((b) => {
    const closesBySymbol = new Map([...b.closesBySymbol].filter(([s]) => !dropped.has(s)));
    const quoteVolume24hUsdBySymbol = b.quoteVolume24hUsdBySymbol
      ? new Map([...b.quoteVolume24hUsdBySymbol].filter(([s]) => !dropped.has(s)))
      : undefined;
    return { tMs: b.tMs, closesBySymbol, quoteVolume24hUsdBySymbol };
  });
  const maskedUniverseAtBar = (bar: CalibrationHistoricalBar): string[] => args.universeAtBar(bar).filter((s) => !dropped.has(s));

  const maskedRun = replayCanonicalMarketRegimeHistory({
    bars: maskedBars,
    universeAtBar: maskedUniverseAtBar,
    computeSnapshot: args.computeSnapshot,
    calibrationParams: args.calibrationParams,
    fastLookbackBars: args.fastLookbackBars,
    slowLookbackBars: args.slowLookbackBars,
  });

  const n = Math.min(args.fullRun.rows.length, maskedRun.rows.length);
  let agree = 0;
  for (let i = 0; i < n; i += 1) {
    if (args.fullRun.rows[i]!.snapshot.projection === maskedRun.rows[i]!.snapshot.projection) agree += 1;
  }
  const stateAgreementPct = n > 0 ? (agree / n) * 100 : 0;
  return {
    droppedFraction: dropCount / symbolList.length,
    stateAgreementPct,
    robustnessConfirmed: stateAgreementPct >= MISSING_DATA_STATE_AGREEMENT_THRESHOLD_PCT,
  };
}

// ─── panic detection quality (episodes + recall/precision against a market-level proxy label) ─────

interface PanicDetectionQualityResult {
  episodes: number;
  status: "EVALUATED" | "PANIC_UNEVALUATED";
  proxySevereEventCount: number;
  recall: number | null;
  precision: number | null;
}

function computePanicDetectionQuality(
  devBars: CalibrationHistoricalBar[],
  replay: ReplayResult,
  panicEpisodes: StateEpisode[],
  proxySevereEventAbsReturnThreshold: number,
): PanicDetectionQualityResult {
  let proxySevereEventCount = 0;
  let truePositives = 0;
  let panicFlaggedCount = 0;
  for (let i = 0; i < devBars.length; i += 1) {
    const row = replay.rows[i];
    if (!row) continue;
    const fwd1h = forwardReturnAtBar(devBars, i, 1);
    const isProxySevere = fwd1h !== null && Math.abs(fwd1h) >= proxySevereEventAbsReturnThreshold;
    const isPanicFlagged = row.snapshot.overlays.panic;
    if (isProxySevere) proxySevereEventCount += 1;
    if (isPanicFlagged) panicFlaggedCount += 1;
    if (isProxySevere && isPanicFlagged) truePositives += 1;
  }
  return {
    episodes: panicEpisodes.length,
    status: panicEpisodes.length >= MIN_PANIC_EPISODES ? "EVALUATED" : "PANIC_UNEVALUATED",
    proxySevereEventCount,
    recall: proxySevereEventCount > 0 ? truePositives / proxySevereEventCount : null,
    precision: panicFlaggedCount > 0 ? truePositives / panicFlaggedCount : null,
  };
}

// ─── full metrics assembly ──────────────────────────────────────────────────────────────────────────

export type CalibrationHorizonKey = "1h" | "4h" | "24h";
const HORIZON_BARS: Record<CalibrationHorizonKey, number> = { "1h": 1, "4h": 4, "24h": 24 };

export interface CanonicalMarketRegimeCalibrationMetrics {
  stateEpisodes: { BULLISH: StateEpisode[]; BEARISH: StateEpisode[]; MIXED: StateEpisode[] };
  panicEpisodes: StateEpisode[];
  stateStabilityMeanDwellBars: { BULLISH: number | null; BEARISH: number | null; MIXED: number | null };
  /** Soft REPORT metric only — no hard gate. */
  flipRateTransitionsPerDay: number;
  forwardReturnsByState: Record<
    CalibrationHorizonKey,
    { BULLISH: ForwardReturnConditionalStats; BEARISH: ForwardReturnConditionalStats; MIXED: ForwardReturnConditionalStats }
  >;
  /** Sanity floor: BULLISH's conditional mean forward return must exceed BEARISH's, or the classifier
   *  is worse than a coin flip on its own core claim. `null` when either side has zero samples. */
  bullishBeatsBearishSanity: Record<CalibrationHorizonKey, boolean | null>;
  volatilityByStress: Record<CalibrationHorizonKey, { baselineStdev: number | null; stressedStdev: number | null; elevatedConfirmed: boolean | null }>;
  correlationByCohesion: CorrelationByCohesionResult;
  coveragePct: number;
  concentration: ConcentrationResult;
  /** `null` when the universe is too small (<4 symbols) to meaningfully drop a fraction of it. */
  missingDataRobustness: MissingDataRobustnessResult | null;
  panicDetectionQuality: PanicDetectionQualityResult;
}

function meanDwellBars(episodes: StateEpisode[]): number | null {
  if (episodes.length === 0) return null;
  return episodes.reduce((a, e) => a + e.lengthBars, 0) / episodes.length;
}

function computeCalibrationMetrics(args: {
  replay: ReplayResult;
  stateEpisodes: { BULLISH: StateEpisode[]; BEARISH: StateEpisode[]; MIXED: StateEpisode[] };
  panicEpisodes: StateEpisode[];
  developmentWindow: CanonicalMarketRegimeCalibrationWindow;
  devBars: CalibrationHistoricalBar[];
  universeAtBar: (bar: CalibrationHistoricalBar) => string[];
  computeSnapshot: ComputeCanonicalMarketRegimeSnapshotFn;
  calibrationParams: Record<string, number>;
  fastLookbackBars: number;
  slowLookbackBars: number;
  missingDataDropFraction: number;
  rng: DeterministicRng;
}): CanonicalMarketRegimeCalibrationMetrics {
  const { replay, stateEpisodes, panicEpisodes, developmentWindow, devBars, calibrationParams } = args;

  const stateStabilityMeanDwellBars = {
    BULLISH: meanDwellBars(stateEpisodes.BULLISH),
    BEARISH: meanDwellBars(stateEpisodes.BEARISH),
    MIXED: meanDwellBars(stateEpisodes.MIXED),
  };

  const allProjectionEpisodesCount = stateEpisodes.BULLISH.length + stateEpisodes.BEARISH.length + stateEpisodes.MIXED.length;
  const transitions = Math.max(0, allProjectionEpisodesCount - 1);
  const windowDays = Math.max(1e-9, (developmentWindow.endMs - developmentWindow.startMs) / DAY_MS);
  const flipRateTransitionsPerDay = transitions / windowDays;

  const forwardReturnsByState = {} as CanonicalMarketRegimeCalibrationMetrics["forwardReturnsByState"];
  const bullishBeatsBearishSanity = {} as CanonicalMarketRegimeCalibrationMetrics["bullishBeatsBearishSanity"];
  const volatilityByStress = {} as CanonicalMarketRegimeCalibrationMetrics["volatilityByStress"];

  for (const h of Object.keys(HORIZON_BARS) as CalibrationHorizonKey[]) {
    const horizonBars = HORIZON_BARS[h];
    const byState: Record<"BULLISH" | "BEARISH" | "MIXED", number[]> = { BULLISH: [], BEARISH: [], MIXED: [] };
    const baseline: number[] = [];
    const stressed: number[] = [];
    for (let i = 0; i < devBars.length; i += 1) {
      const fwd = forwardReturnAtBar(devBars, i, horizonBars);
      if (fwd === null) continue;
      const row = replay.rows[i];
      if (!row) continue;
      const proj = row.snapshot.projection;
      byState[proj].push(fwd);
      if (row.snapshot.overlays.highStress || row.snapshot.overlays.panic) stressed.push(fwd);
      else baseline.push(fwd);
    }
    const stateStats = { BULLISH: forwardReturnStats(byState.BULLISH), BEARISH: forwardReturnStats(byState.BEARISH), MIXED: forwardReturnStats(byState.MIXED) };
    forwardReturnsByState[h] = stateStats;
    const bMean = stateStats.BULLISH.mean;
    const rMean = stateStats.BEARISH.mean;
    bullishBeatsBearishSanity[h] = bMean !== null && rMean !== null ? bMean > rMean : null;
    const baselineStdev = stdevOf(baseline);
    const stressedStdev = stdevOf(stressed);
    volatilityByStress[h] = {
      baselineStdev,
      stressedStdev,
      elevatedConfirmed: baselineStdev !== null && stressedStdev !== null ? stressedStdev > baselineStdev : null,
    };
  }

  const cohesiveThreshold = calibrationParams.cohesionEnterThreshold ?? DEFAULT_COHESIVE_BUCKET_THRESHOLD;
  const correlationByCohesion = computeCorrelationByCohesion(devBars, replay, cohesiveThreshold);

  const coveragePct = replay.rows.length > 0 ? (replay.rows.filter((r) => r.snapshot.coverage.status === "VALID").length / replay.rows.length) * 100 : 0;

  const maxWeightPct = calibrationParams.maxSingleSymbolWeightPct ?? DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT;
  const concentration = computeConcentrationMetric(replay.rows, maxWeightPct);

  const missingDataRobustness = computeMissingDataRobustness({
    devBars,
    universeAtBar: args.universeAtBar,
    computeSnapshot: args.computeSnapshot,
    calibrationParams: args.calibrationParams,
    fastLookbackBars: args.fastLookbackBars,
    slowLookbackBars: args.slowLookbackBars,
    fullRun: replay,
    dropFraction: args.missingDataDropFraction,
    rng: args.rng,
  });

  const proxySevereEventAbsReturnThreshold =
    calibrationParams.proxySevereEventAbsReturnThreshold ?? DEFAULT_PROXY_SEVERE_EVENT_ABS_RETURN_THRESHOLD;
  const panicDetectionQuality = computePanicDetectionQuality(devBars, replay, panicEpisodes, proxySevereEventAbsReturnThreshold);

  return {
    stateEpisodes,
    panicEpisodes,
    stateStabilityMeanDwellBars,
    flipRateTransitionsPerDay,
    forwardReturnsByState,
    bullishBeatsBearishSanity,
    volatilityByStress,
    correlationByCohesion,
    coveragePct,
    concentration,
    missingDataRobustness,
    panicDetectionQuality,
  };
}

// ─── top-level orchestration ────────────────────────────────────────────────────────────────────────

export type CanonicalMarketRegimeCalibrationStatus = "OK" | "BLOCKED_NO_DEVELOPMENT_DATA" | "BLOCKED_INSUFFICIENT_STATE_EPISODES";

export interface CanonicalMarketRegimeCalibrationWindow {
  startMs: number;
  endMs: number;
  barCount: number;
}

export interface CanonicalMarketRegimeCalibrationReport {
  status: CanonicalMarketRegimeCalibrationStatus;
  /** Non-null iff status !== "OK" — a distinct, checkable BLOCKED reason, never an exception
   *  swallowed into a default and never a silent proceed-anyway (mirrors
   *  regime-conditioned-bootstrap.ts's INSUFFICIENT_CALIBRATION_DATA discipline exactly). */
  blockedReason: string | null;
  /** Non-null iff status === "OK". Freezing (see CanonicalMarketRegimeCalibrationStore) may mint a
   *  higher `-vN` suffix than this if the proposed id already exists. */
  proposedCalibrationVersion: string | null;
  generatedAtMs: number;
  developmentWindow: CanonicalMarketRegimeCalibrationWindow;
  /** The FINAL time block — reserved untouched. Never replayed, never scored, never used to pick a
   *  threshold. Present purely for window bookkeeping/transparency. */
  holdoutWindow: CanonicalMarketRegimeCalibrationWindow;
  /** Informational only — copied from `planWalkForward`'s own output. Every metric above is computed
   *  over the WHOLE development window, not per-fold; fold boundaries are surfaced for a future
   *  finer-grained analysis, not consumed by this version's BLOCKED/status decision. */
  developmentFolds: WalkForwardFold[];
  params: Record<string, number>;
  /** Null iff status !== "OK" — a BLOCKED report never exposes partially-computed metrics that could
   *  be misread as valid. */
  metrics: CanonicalMarketRegimeCalibrationMetrics | null;
}

function medianBarIntervalMs(sortedBars: CalibrationHistoricalBar[]): number | null {
  if (sortedBars.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < sortedBars.length; i += 1) deltas.push(sortedBars[i]!.tMs - sortedBars[i - 1]!.tMs);
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

function emptyWindowAt(ms: number): CanonicalMarketRegimeCalibrationWindow {
  return { startMs: ms, endMs: ms, barCount: 0 };
}

function blockedReport(
  status: Exclude<CanonicalMarketRegimeCalibrationStatus, "OK">,
  reason: string,
  generatedAtMs: number,
  params: Record<string, number>,
  developmentWindow: CanonicalMarketRegimeCalibrationWindow,
  holdoutWindow: CanonicalMarketRegimeCalibrationWindow,
  developmentFolds: WalkForwardFold[],
): CanonicalMarketRegimeCalibrationReport {
  return {
    status,
    blockedReason: reason,
    proposedCalibrationVersion: null,
    generatedAtMs,
    developmentWindow,
    holdoutWindow,
    developmentFolds,
    params: { ...params },
    metrics: null,
  };
}

/** `YYYYMMDD-<devWindowStartMs>-<devWindowEndMs>-v<seq>`, where YYYYMMDD is the (UTC) day this
 *  calibration was generated/frozen. Neither `devWindowStartMs` nor `devWindowEndMs` can contain a
 *  literal "-" (they are always non-negative ms-since-epoch integers), so this id round-trips cleanly
 *  through a plain `.split("-")` in `CanonicalMarketRegimeCalibrationStore.freezeCalibrationRun`. */
export function buildCalibrationVersionId(devWindowStartMs: number, devWindowEndMs: number, seq: number, nowMs: number): string {
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${devWindowStartMs}-${devWindowEndMs}-v${seq}`;
}

export interface RunCanonicalMarketRegimeCalibrationArgs {
  bars: CalibrationHistoricalBar[];
  computeSnapshot: ComputeCanonicalMarketRegimeSnapshotFn;
  calibrationParams: Record<string, number>;
  nowMs: number;
  universeAtBar?: (bar: CalibrationHistoricalBar) => string[];
  folds?: number;
  holdoutFrac?: number;
  fastLookbackBars?: number;
  slowLookbackBars?: number;
  missingDataDropFraction?: number;
  rng?: DeterministicRng;
}

/**
 * Runs one full calibration pass: chronological dev/holdout split (`planWalkForward`, holdout reserved
 * untouched) -> causal replay of the development prefix -> episode counting -> BLOCKED check -> (if
 * not blocked) full metrics assembly -> a proposed, not-yet-frozen calibration version id. Pure — no
 * disk I/O (freezing is a separate, explicit step via `CanonicalMarketRegimeCalibrationStore`).
 */
export function runCanonicalMarketRegimeCalibration(args: RunCanonicalMarketRegimeCalibrationArgs): CanonicalMarketRegimeCalibrationReport {
  const generatedAtMs = args.nowMs;
  const universeAtBar = args.universeAtBar ?? universeFromBarMembership;
  const fastLookbackBars = args.fastLookbackBars ?? DEFAULT_FAST_LOOKBACK_BARS;
  const slowLookbackBars = args.slowLookbackBars ?? DEFAULT_SLOW_LOOKBACK_BARS;
  const folds = args.folds ?? DEFAULT_WALKFORWARD_FOLDS;
  const holdoutFrac = args.holdoutFrac ?? DEFAULT_HOLDOUT_FRACTION;

  if (args.bars.length === 0) {
    const w = emptyWindowAt(generatedAtMs);
    return blockedReport("BLOCKED_NO_DEVELOPMENT_DATA", "no historical bars supplied", generatedAtMs, args.calibrationParams, w, w, []);
  }

  const plan = planWalkForward(args.bars, folds, holdoutFrac);
  const devBars = plan.sorted.filter((b) => b.tMs < plan.holdoutStartMs);
  const holdoutBars = plan.sorted.filter((b) => b.tMs >= plan.holdoutStartMs);

  if (devBars.length === 0) {
    const w = emptyWindowAt(generatedAtMs);
    return blockedReport(
      "BLOCKED_NO_DEVELOPMENT_DATA",
      `development window is empty after the ${(holdoutFrac * 100).toFixed(0)}% holdout split (${plan.sorted.length} total bar(s))`,
      generatedAtMs,
      args.calibrationParams,
      w,
      w,
      plan.folds,
    );
  }

  const medianIntervalMs = medianBarIntervalMs(devBars);
  if (medianIntervalMs !== null && Math.abs(medianIntervalMs - HOUR_MS) > HOUR_MS * 0.1) {
    // Non-blocking, advisory only (this is offline tooling). directionFast/directionSlow (6/24-bar
    // lookbacks) and the 1h/4h/24h forward-return horizons (1/4/24-bar) are calibrated against an
    // ASSUMED 1h candle grid — a different interval silently changes what these bar counts mean,
    // exactly the non-obvious coupling stateMachineDesign warns about for the live engine's own
    // hysteresis cycle counts. Surfacing it here rather than staying silent.
    console.warn(
      `[canonical-market-regime-calibration] median bar interval ${medianIntervalMs}ms deviates from the assumed 1h grid — ` +
        `fast/slow lookback bar counts (${fastLookbackBars}/${slowLookbackBars}) and forward-return horizons (1h/4h/24h => 1/4/24 bars) ` +
        `are calibrated against hourly candles; recalibrate these bar counts if the input candle interval differs.`,
    );
  }

  const developmentWindow: CanonicalMarketRegimeCalibrationWindow = {
    startMs: devBars[0]!.tMs,
    endMs: devBars[devBars.length - 1]!.tMs,
    barCount: devBars.length,
  };
  const holdoutWindow: CanonicalMarketRegimeCalibrationWindow =
    holdoutBars.length > 0
      ? { startMs: holdoutBars[0]!.tMs, endMs: holdoutBars[holdoutBars.length - 1]!.tMs, barCount: holdoutBars.length }
      : emptyWindowAt(developmentWindow.endMs);

  const replay = replayCanonicalMarketRegimeHistory({
    bars: devBars,
    universeAtBar,
    computeSnapshot: args.computeSnapshot,
    calibrationParams: args.calibrationParams,
    fastLookbackBars,
    slowLookbackBars,
  });

  const projectionRows = replay.rows.map((r) => ({ tMs: r.tMs, state: r.snapshot.projection as string }));
  const projectionEpisodes = groupIntoEpisodes(projectionRows);
  const stateEpisodes = {
    BULLISH: projectionEpisodes.filter((e) => e.state === "BULLISH"),
    BEARISH: projectionEpisodes.filter((e) => e.state === "BEARISH"),
    MIXED: projectionEpisodes.filter((e) => e.state === "MIXED"),
  };
  const panicRows = replay.rows.map((r) => ({ tMs: r.tMs, state: r.snapshot.overlays.panic ? "PANIC" : "NO_PANIC" }));
  const panicEpisodes = groupIntoEpisodes(panicRows).filter((e) => e.state === "PANIC");

  const shortfalls: string[] = [];
  for (const state of ["BULLISH", "BEARISH", "MIXED"] as const) {
    if (stateEpisodes[state].length < MIN_CALIBRATION_STATE_EPISODES) {
      shortfalls.push(`${state} has ${stateEpisodes[state].length} episode(s), needs >= ${MIN_CALIBRATION_STATE_EPISODES}`);
    }
  }
  if (shortfalls.length > 0) {
    return blockedReport(
      "BLOCKED_INSUFFICIENT_STATE_EPISODES",
      `insufficient distinct state episodes in the development window: ${shortfalls.join("; ")}`,
      generatedAtMs,
      args.calibrationParams,
      developmentWindow,
      holdoutWindow,
      plan.folds,
    );
  }

  const metrics = computeCalibrationMetrics({
    replay,
    stateEpisodes,
    panicEpisodes,
    developmentWindow,
    devBars,
    universeAtBar,
    computeSnapshot: args.computeSnapshot,
    calibrationParams: args.calibrationParams,
    fastLookbackBars,
    slowLookbackBars,
    missingDataDropFraction: args.missingDataDropFraction ?? DEFAULT_MISSING_DATA_DROP_FRACTION,
    rng: args.rng ?? createRng(0x5eed, "canonical-market-regime-calibration/missing-data"),
  });

  const proposedCalibrationVersion = buildCalibrationVersionId(developmentWindow.startMs, developmentWindow.endMs, 1, generatedAtMs);

  return {
    status: "OK",
    blockedReason: null,
    proposedCalibrationVersion,
    generatedAtMs,
    developmentWindow,
    holdoutWindow,
    developmentFolds: plan.folds,
    params: { ...args.calibrationParams },
    metrics,
  };
}

// ─── frozen calibration store (add-only freeze, tolerant discard-and-reseed load) ──────────────────
// Mirrors cortex-brain-store.ts's dual strict/tolerant discipline and
// current-guard-variant-matrix.ts's freezeStageCutIfAbsent add-only idiom (hasOwnProperty presence
// test, never truthiness) simultaneously: this store is both a "versioned snapshot" (schemaVersion)
// AND a "freeze-once ledger" (per-version add-only) at the same time.

export interface FrozenCanonicalMarketRegimeCalibrationRun {
  calibrationVersion: string;
  frozenAtMs: number;
  report: CanonicalMarketRegimeCalibrationReport;
}

interface CanonicalMarketRegimeCalibrationPersistedState {
  schemaVersion: 1;
  activeCalibrationVersion: string;
  runs: Record<string, FrozenCanonicalMarketRegimeCalibrationRun>;
}

function emptyPersistedState(): CanonicalMarketRegimeCalibrationPersistedState {
  return { schemaVersion: CANONICAL_MARKET_REGIME_CALIBRATION_SCHEMA_VERSION, activeCalibrationVersion: ACTIVE_CALIBRATION_VERSION_DEFAULT, runs: {} };
}

function isValidPersistedState(value: unknown): value is CanonicalMarketRegimeCalibrationPersistedState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== CANONICAL_MARKET_REGIME_CALIBRATION_SCHEMA_VERSION) return false;
  if (typeof v.activeCalibrationVersion !== "string" || v.activeCalibrationVersion.length === 0) return false;
  if (!v.runs || typeof v.runs !== "object" || Array.isArray(v.runs)) return false;
  return true;
}

export class CanonicalMarketRegimeCalibrationStore {
  private readonly file: string;
  private state: CanonicalMarketRegimeCalibrationPersistedState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "canonical-market-regime-calibration.json");
    this.state = this.load();
  }

  private load(): CanonicalMarketRegimeCalibrationPersistedState {
    try {
      if (!existsSync(this.file)) return emptyPersistedState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as unknown;
      // TOLERANT runtime loader: DISCARDS AND RE-SEEDS (never silently repairs) on any schema
      // mismatch or corruption — mirrors CortexBrainStore's own constructor discipline exactly. The
      // caller sees a fresh, honestly-empty state (activeCalibrationVersion falls back to the
      // un-promoted default, never null/undefined) rather than a patched-up guess.
      if (!isValidPersistedState(parsed)) return emptyPersistedState();
      return parsed;
    } catch {
      return emptyPersistedState();
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      /* best-effort persistence, mirrors the universe store's own discipline — the in-memory state
       *  is still updated even if the write itself failed (e.g. read-only disk). */
    }
  }

  /** Never null/undefined. */
  getActiveCalibrationVersion(): string {
    return this.state.activeCalibrationVersion;
  }

  listFrozenVersions(): string[] {
    return Object.keys(this.state.runs).sort();
  }

  getFrozenRun(version: string): FrozenCanonicalMarketRegimeCalibrationRun | null {
    return this.state.runs[version] ?? null;
  }

  hasVersion(version: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.runs, version);
  }

  /**
   * Mints a collision-free version id from `report.proposedCalibrationVersion` (bumping the trailing
   * `-v<n>` seq until the candidate id is not already frozen — e.g. a re-run over the same window
   * with newer/cherry-picked data mints "v2" rather than silently overwriting "v1"'s frozen record),
   * then freezes it ADD-ONLY: the presence test is `hasOwnProperty`, NOT truthiness, mirroring
   * current-guard-variant-matrix.ts's `freezeStageCutIfAbsent` exactly, for the same reason — a
   * present-but-falsy-looking record must never be silently re-frozen. By construction the minted
   * candidate cannot already exist (the loop below only stops once it doesn't), so this can never
   * actually hit its own "already frozen" branch; the check is kept as a second, defensive layer
   * rather than relied upon as the only guard. Throws (never silently no-ops) if
   * `report.status !== "OK"` — freezing a BLOCKED report would let the live engine reference a
   * calibration version that never actually validated, which is a caller programming error, not a
   * data condition this store should absorb quietly. Returns the version string actually frozen.
   */
  freezeCalibrationRun(report: CanonicalMarketRegimeCalibrationReport, nowMs: number): string {
    if (report.status !== "OK" || !report.metrics) {
      throw new Error(`refusing to freeze a non-OK calibration report (status=${report.status})`);
    }
    if (!report.proposedCalibrationVersion) {
      throw new Error("refusing to freeze a calibration report with no proposedCalibrationVersion");
    }
    const parts = report.proposedCalibrationVersion.split("-");
    const datePart = parts[0]!;
    const startPart = parts[1]!;
    const endPart = parts[2]!;
    let seq = 1;
    let candidate = report.proposedCalibrationVersion;
    while (this.hasVersion(candidate)) {
      seq += 1;
      candidate = `${datePart}-${startPart}-${endPart}-v${seq}`;
    }
    if (this.hasVersion(candidate)) return candidate; // defensive — see doc above; unreachable in practice
    this.state.runs[candidate] = { calibrationVersion: candidate, frozenAtMs: nowMs, report };
    this.save();
    return candidate;
  }

  /** Explicit operator action. Throws if `version` was never frozen — never silently promote an
   *  unknown/unvalidated version. */
  promoteActiveCalibrationVersion(version: string): void {
    if (!this.hasVersion(version)) {
      throw new Error(`cannot promote unknown calibration version "${version}" — freeze it first`);
    }
    this.state.activeCalibrationVersion = version;
    this.save();
  }
}

let storeSingleton: CanonicalMarketRegimeCalibrationStore | null = null;
export function getCanonicalMarketRegimeCalibrationStore(dataDir = "data"): CanonicalMarketRegimeCalibrationStore {
  if (!storeSingleton) storeSingleton = new CanonicalMarketRegimeCalibrationStore(dataDir);
  return storeSingleton;
}

export function _resetCanonicalMarketRegimeCalibrationStoreForTests(): void {
  storeSingleton = null;
}

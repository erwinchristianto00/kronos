/**
 * Residual Cross-Sectional Momentum with leader-laggard extension (report-only measurement lane).
 *
 * The existing cross-sectional lane (cross-sectional-edge.ts) ranks the universe by RAW N-bar ROC
 * and goes long-top-k/short-bottom-k. Raw ROC conflates two things: how much of a symbol's move is
 * just "the market went up/down" (its beta-implied co-movement with BTC) and how much is genuinely
 * IDIOSYNCRATIC to that symbol. A high-beta alt can top a raw-ROC ranking purely because BTC ripped —
 * that is not stock-picking, it is unhedged beta exposure mislabeled as alpha.
 *
 * This lane backs the beta-implied component out first:
 *   residualReturn = symbolReturn − beta × btcReturn
 * and ranks the universe by THAT instead. It is an ALTERNATIVE signal alongside the existing raw-ROC
 * lane (not a replacement) — both are measured independently so the operator can compare which
 * ranking method actually carries OOS edge.
 *
 * Two families of trade are generated per cycle, both as ordinary single-symbol Observations
 * (this repo's established measurement-lane shape — see short-fade-edge.ts /
 * panic-washout-reclaim-edge.ts / regime-composite-edge.ts / composite-estimator-edge.ts):
 *
 *  1. DISPERSION_LONG / DISPERSION_SHORT — top-K / bottom-K of the residual-return ranking, the
 *     residual-momentum analogue of the existing lane's long-top/short-bottom.
 *  2. CATCHUP_LONG / CATCHUP_SHORT — a "leader-laggard" trade: within a correlation cluster
 *     (correlation-clusters.ts's clusterOf()), when MOST members are showing a strong residual move
 *     in one direction but one member is still lagging, bet that the laggard catches up. Documented
 *     judgment call: this lane treats the catch-up thesis as symmetric (LONG when the cluster is
 *     strongly UP and one member hasn't followed; SHORT when the cluster is strongly DOWN and one
 *     member hasn't fallen yet) on the reasoning that correlated-cluster co-movement (the same
 *     mechanism the concentration cap in correlation-clusters.ts exists to respect) applies in both
 *     directions. Unproven either way — that is exactly what this shadow measurement is for.
 *
 * Windows (documented explicitly per the audit's ask):
 *   - Interval: 1h (RM_INTERVAL) — matches cross-sectional-edge.ts's own cadence, so both lanes are
 *     measured on the same clock and stay comparable.
 *   - Beta estimation window: RM_BETA_WINDOW_BARS (default 60, ~2.5 days of 1h bars) rolling OLS of
 *     symbol per-bar returns against BTC per-bar returns. 60 bars is small enough to track a beta
 *     that drifts with regime, large enough (>> RM_MIN_BETA_SAMPLES=30) to not be pure noise.
 *   - Formation window: RM_MOMENTUM_BARS (default 24, matches CROSS_SECTIONAL_MOMENTUM_BARS's own
 *     default) — the N-bar cumulative return used for BOTH symbolReturn and btcReturn when computing
 *     the residual. Kept equal to the sibling lane's momentum window on purpose, so a head-to-head
 *     "raw ROC rank vs residual rank" comparison isn't confounded by a different lookback.
 *
 * Pure measurement: NEVER executes a real order, NEVER wired into live-execution-engine.ts,
 * app.ts's executor wiring, or any lane allocation. Independent module: own store, own cycle, own
 * report. A route will be wired separately.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { clusterOf, OTHER_CLUSTER } from "./correlation-clusters.js";
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

export const RM_LANE_ID = "RESIDUAL_MOMENTUM_LEADER_LAGGARD" as const;
export const RM_INTERVAL = process.env.RESIDUAL_MOMENTUM_INTERVAL || "1h";
/** 2026-07-12 fix: the stale-expiry fallback below used to hardcode 3_600_000ms (1h) regardless of
 *  RM_INTERVAL — a symbol whose fetch fails forever on a non-default interval would either never
 *  expire (interval > 1h) or expire too early (interval < 1h). Same lookup convention as the
 *  sibling liquidation-recoil-cross-sectional.ts's own LRX_BAR_MS. */
const RM_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "6h": 6 * 3_600_000,
  "1d": 24 * 3_600_000,
};
const RM_BAR_MS = RM_INTERVAL_MS[RM_INTERVAL] ?? RM_INTERVAL_MS["1h"]!;
/** Benchmark symbol beta is estimated against. Excluded from the ranked/tradable universe below —
 *  regressing BTC on itself gives beta=1 / residual=0 trivially, no information content. */
export const RM_BENCHMARK_SYMBOL = "BTCUSDT";
export const RM_BETA_WINDOW_BARS = envNumPos("RESIDUAL_MOMENTUM_BETA_WINDOW_BARS", 60);
export const RM_MOMENTUM_BARS = envNumPos("RESIDUAL_MOMENTUM_FORMATION_BARS", 24);
export const RM_MIN_BETA_SAMPLES = envNumPos("RESIDUAL_MOMENTUM_MIN_BETA_SAMPLES", 30);
/** legs per side for the dispersion (top-K/bottom-K) signal. */
export const RM_K = envNumPos("RESIDUAL_MOMENTUM_K", 3);
/** bars of rank history retained per symbol for the persistence score (bounded ring buffer). */
export const RM_RANK_HISTORY_MAX = envNumPos("RESIDUAL_MOMENTUM_RANK_HISTORY_MAX", 20);
/** bounded retention: settled (non-OPEN) observations kept in the store, oldest pruned first. */
export const RM_MAX_STORED_OBSERVATIONS = envNumPos("RESIDUAL_MOMENTUM_MAX_STORED_OBSERVATIONS", 500);

// Trend-following exit geometry (both signal families bet on continuation, unlike the counter-trend
// short-fade lane) — a narrower stop than short-fade's 300bps counter-trend cushion, and a reward
// multiple > 1 to let a real continuation run, with a max-hold matched to the formation window's own
// timescale (the horizon this signal was measured over is the horizon it should be judged over).
export const RM_STOP_FLOOR_BPS = envNumPos("RESIDUAL_MOMENTUM_STOP_FLOOR_BPS", 150);
export const RM_TP_REWARD_MULTIPLE = Number(process.env.RESIDUAL_MOMENTUM_TP_REWARD_MULTIPLE) > 0
  ? Number(process.env.RESIDUAL_MOMENTUM_TP_REWARD_MULTIPLE)
  : 1.5;
export const RM_MAX_HOLD_BARS = envNumPos("RESIDUAL_MOMENTUM_MAX_HOLD_BARS", 24);

/** Leader-laggard cluster gate defaults — see detectLeaderLaggardCatchUp() doc for the full logic. */
export const RM_CLUSTER_MIN_SIZE = envNumPos("RESIDUAL_MOMENTUM_CLUSTER_MIN_SIZE", 3);
export const RM_CLUSTER_STRONG_THRESHOLD = Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_STRONG_THRESHOLD) > 0
  ? Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_STRONG_THRESHOLD)
  : 0.015; // 1.5% residual return counts as a "strong" idiosyncratic move
export const RM_CLUSTER_STRONG_FRACTION = Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_STRONG_FRACTION) > 0
  ? Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_STRONG_FRACTION)
  : 0.6; // "most members" = at least 60% of the cluster's present members
export const RM_CLUSTER_LAGGARD_FRACTION = Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_LAGGARD_FRACTION) > 0
  ? Number(process.env.RESIDUAL_MOMENTUM_CLUSTER_LAGGARD_FRACTION)
  : 0.34; // a member below 34% of the "strong" bar counts as still-lagging

/** Independent universe from the sibling lane's (env-overridable), defaulting to the SAME symbol
 *  list as cross-sectional-edge.ts's CROSS_SECTIONAL_UNIVERSE so a head-to-head raw-ROC vs
 *  residual-momentum comparison isn't confounded by a different symbol set. */
export const RM_UNIVERSE: readonly string[] = (
  process.env.RESIDUAL_MOMENTUM_UNIVERSE
    ? process.env.RESIDUAL_MOMENTUM_UNIVERSE.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : CROSS_SECTIONAL_UNIVERSE
);

// ── beta / residual return (pure) ───────────────────────────────────────────

/** Per-bar simple returns from a closes series: length = closes.length - 1. */
export function computeSimpleReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    out.push(prev > 0 ? (cur - prev) / prev : 0);
  }
  return out;
}

/**
 * Simple rolling-window OLS beta: slope of `symbolReturns ~ marketReturns` via
 * beta = Cov(market, symbol) / Var(market), using the trailing min(len) of both series.
 * Returns null if there isn't enough data or the market series has zero variance (can't identify
 * a slope against a constant regressor).
 */
export function computeOlsBeta(symbolReturns: readonly number[], marketReturns: readonly number[]): number | null {
  const n = Math.min(symbolReturns.length, marketReturns.length);
  if (n < 2) return null;
  const xs = marketReturns.slice(marketReturns.length - n);
  const ys = symbolReturns.slice(symbolReturns.length - n);
  const meanX = mean(xs as number[]);
  const meanY = mean(ys as number[]);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
  }
  if (!(varX > 0)) return null;
  const beta = cov / varX;
  return Number.isFinite(beta) ? beta : null;
}

/** Filters + sorts two candle series down to their common openTimes (ascending). Real fetches can
 *  return series with slightly different coverage (a newly-listed symbol, a gap) — aligning by
 *  timestamp rather than assuming equal-length/equal-index arrays avoids silently pairing a
 *  symbol's bar with the WRONG BTC bar. */
function alignedCloses(
  symbolCandles: readonly Candle[],
  btcCandles: readonly Candle[],
  minAlignedBars: number,
): { symbolCloses: number[]; btcCloses: number[] } | null {
  if (!Array.isArray(symbolCandles) || !Array.isArray(btcCandles)) return null;
  const btcByTime = new Map<number, number>();
  for (const c of btcCandles) {
    if (finite(c.close) && c.close > 0) btcByTime.set(c.openTime, c.close);
  }
  const symbolSorted = [...symbolCandles].sort((a, b) => a.openTime - b.openTime);
  const symbolCloses: number[] = [];
  const btcCloses: number[] = [];
  for (const c of symbolSorted) {
    if (!(finite(c.close) && c.close > 0)) continue;
    const btcClose = btcByTime.get(c.openTime);
    if (btcClose === undefined) continue;
    symbolCloses.push(c.close);
    btcCloses.push(btcClose);
  }
  if (symbolCloses.length < minAlignedBars + 1) return null;
  return {
    symbolCloses: symbolCloses.slice(-(minAlignedBars + 1)),
    btcCloses: btcCloses.slice(-(minAlignedBars + 1)),
  };
}

export interface ResidualMomentumScoreCore {
  price: number;
  beta: number;
  symbolReturn: number;
  btcReturn: number;
  residualReturn: number;
}

export interface ResidualMomentumSymbolScore extends ResidualMomentumScoreCore {
  symbol: string;
}

/**
 * Beta (rolling OLS over RM_BETA_WINDOW_BARS 1-bar returns) + residual return (RM_MOMENTUM_BARS
 * N-bar cumulative symbolReturn minus beta × the same-window btcReturn), from CLOSED candles only
 * (last element = the just-closed bar, no lookahead). Returns null on any insufficient/invalid data.
 */
export function computeResidualMomentumScore(
  symbolCandles: readonly Candle[],
  btcCandles: readonly Candle[],
  opts: { betaWindowBars?: number; momentumBars?: number; minBetaSamples?: number } = {},
): ResidualMomentumScoreCore | null {
  const betaWindowBars = opts.betaWindowBars ?? RM_BETA_WINDOW_BARS;
  const momentumBars = opts.momentumBars ?? RM_MOMENTUM_BARS;
  const minBetaSamples = opts.minBetaSamples ?? RM_MIN_BETA_SAMPLES;
  const neededBars = Math.max(betaWindowBars, momentumBars);
  const aligned = alignedCloses(symbolCandles, btcCandles, neededBars);
  if (!aligned) return null;
  const { symbolCloses, btcCloses } = aligned;

  const betaSymbolCloses = symbolCloses.slice(-(betaWindowBars + 1));
  const betaBtcCloses = btcCloses.slice(-(betaWindowBars + 1));
  const symbolReturnsForBeta = computeSimpleReturns(betaSymbolCloses);
  const btcReturnsForBeta = computeSimpleReturns(betaBtcCloses);
  if (symbolReturnsForBeta.length < minBetaSamples) return null;
  const beta = computeOlsBeta(symbolReturnsForBeta, btcReturnsForBeta);
  if (beta === null) return null;

  const momSymbolCloses = symbolCloses.slice(-(momentumBars + 1));
  const momBtcCloses = btcCloses.slice(-(momentumBars + 1));
  const priceNow = momSymbolCloses[momSymbolCloses.length - 1]!;
  const pricePast = momSymbolCloses[0]!;
  const btcNow = momBtcCloses[momBtcCloses.length - 1]!;
  const btcPast = momBtcCloses[0]!;
  if (!(priceNow > 0 && pricePast > 0 && btcNow > 0 && btcPast > 0)) return null;
  const symbolReturn = (priceNow - pricePast) / pricePast;
  const btcReturn = (btcNow - btcPast) / btcPast;
  const residualReturn = symbolReturn - beta * btcReturn;
  if (!Number.isFinite(residualReturn)) return null;

  return { price: priceNow, beta, symbolReturn, btcReturn, residualReturn };
}

// ── cross-sectional rank + persistence ──────────────────────────────────────

export interface RankedResidualMomentum extends ResidualMomentumSymbolScore {
  rank: number; // 1 = highest residualReturn
}

/** Ranks the universe by residualReturn descending (1 = highest). Pure — the sibling lane's raw-ROC
 *  equivalent is cross-sectional-edge.ts's sort by score; this is the residual-momentum analogue. */
export function rankResidualMomentum(scores: readonly ResidualMomentumSymbolScore[]): RankedResidualMomentum[] {
  return [...scores]
    .sort((a, b) => b.residualReturn - a.residualReturn)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * Simple rank-persistence score in [0, 1]: 1 minus the mean absolute rank change between
 * consecutive observations, normalized by the largest possible average change (universeSize − 1).
 * 1.0 = the symbol has held an identical rank across the whole history (maximally persistent);
 * 0.0 = it swung, on average, the entire width of the universe every observation (no persistence).
 * Deliberately simple/documented rather than a full rank-correlation model — see the audit's own
 * "keep it simple/documented" instruction. Needs >= 2 history points and a universe of >= 2 to be
 * meaningful; returns 0 (no evidence of persistence yet) otherwise.
 */
export function computeRankPersistence(rankHistory: readonly number[], universeSize: number): number {
  if (rankHistory.length < 2 || universeSize < 2) return 0;
  let totalDelta = 0;
  for (let i = 1; i < rankHistory.length; i++) {
    totalDelta += Math.abs(rankHistory[i]! - rankHistory[i - 1]!);
  }
  const avgDelta = totalDelta / (rankHistory.length - 1);
  const maxDelta = universeSize - 1;
  if (!(maxDelta > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - avgDelta / maxDelta));
}

// ── leader-laggard catch-up detector ─────────────────────────────────────────

export interface ClusterCatchUpCandidate {
  symbol: string;
  cluster: string;
  direction: "LONG" | "SHORT";
  laggardResidualReturn: number;
  clusterAvgResidualReturn: number;
  clusterStrongFraction: number;
  clusterMemberCount: number;
}

/**
 * Groups the scored universe by correlation cluster (clusterOf()) and flags a "catch-up" candidate
 * when a cluster is mostly moving strongly in one direction but one member hasn't followed yet:
 *
 *   - LONG catch-up: >= RM_CLUSTER_STRONG_FRACTION of the cluster's PRESENT members show
 *     residualReturn >= RM_CLUSTER_STRONG_THRESHOLD (a real idiosyncratic up-move, not just beta),
 *     AND this member's own residualReturn is still below RM_CLUSTER_STRONG_THRESHOLD ×
 *     RM_CLUSTER_LAGGARD_FRACTION (i.e. it hasn't meaningfully participated).
 *   - SHORT catch-up: the mirror image on the downside (most members <= -threshold, this member's
 *     residual still above -threshold × laggardFraction). Documented judgment call (see module
 *     header): treated as symmetric, unproven either way — that is what this shadow lane measures.
 *
 * The OTHER cluster (correlation-clusters.ts's catch-all for unmapped symbols) is EXCLUDED — it is
 * a heterogeneous grab-bag, not a real correlated group, so "most of OTHER moved together" carries
 * no co-movement information. Clusters with fewer than RM_CLUSTER_MIN_SIZE present members are also
 * skipped — "most of a 2-symbol cluster" is too thin a sample to call a cluster-wide move.
 */
export function detectLeaderLaggardCatchUp(
  scores: readonly ResidualMomentumSymbolScore[],
  opts: {
    minClusterSize?: number;
    strongThreshold?: number;
    strongFraction?: number;
    laggardFraction?: number;
  } = {},
): ClusterCatchUpCandidate[] {
  const minClusterSize = opts.minClusterSize ?? RM_CLUSTER_MIN_SIZE;
  const strongThreshold = opts.strongThreshold ?? RM_CLUSTER_STRONG_THRESHOLD;
  const strongFraction = opts.strongFraction ?? RM_CLUSTER_STRONG_FRACTION;
  const laggardFraction = opts.laggardFraction ?? RM_CLUSTER_LAGGARD_FRACTION;
  const laggardLongCeiling = strongThreshold * laggardFraction;
  const laggardShortFloor = -strongThreshold * laggardFraction;

  const byCluster = new Map<string, ResidualMomentumSymbolScore[]>();
  for (const s of scores) {
    const cluster = clusterOf(s.symbol);
    if (cluster === OTHER_CLUSTER) continue;
    byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), s]);
  }

  const out: ClusterCatchUpCandidate[] = [];
  for (const [cluster, members] of byCluster) {
    if (members.length < minClusterSize) continue;
    const strongLongCount = members.filter((m) => m.residualReturn >= strongThreshold).length;
    const strongShortCount = members.filter((m) => m.residualReturn <= -strongThreshold).length;
    const clusterAvgResidualReturn = mean(members.map((m) => m.residualReturn));
    const longFraction = strongLongCount / members.length;
    const shortFraction = strongShortCount / members.length;

    if (longFraction >= strongFraction) {
      for (const m of members) {
        if (m.residualReturn < laggardLongCeiling) {
          out.push({
            symbol: m.symbol,
            cluster,
            direction: "LONG",
            laggardResidualReturn: m.residualReturn,
            clusterAvgResidualReturn,
            clusterStrongFraction: longFraction,
            clusterMemberCount: members.length,
          });
        }
      }
    } else if (shortFraction >= strongFraction) {
      for (const m of members) {
        if (m.residualReturn > laggardShortFloor) {
          out.push({
            symbol: m.symbol,
            cluster,
            direction: "SHORT",
            laggardResidualReturn: m.residualReturn,
            clusterAvgResidualReturn,
            clusterStrongFraction: shortFraction,
            clusterMemberCount: members.length,
          });
        }
      }
    }
  }
  return out;
}

// ── geometry + resolution ────────────────────────────────────────────────────

export interface ResidualMomentumGeometry {
  entryPrice: number;
  initialStop: number;
  takeProfitPrice: number;
  stopDistanceBps: number;
}

/** Trend-following geometry (both directions): stop at RM_STOP_FLOOR_BPS against the trade, TP at
 *  RM_TP_REWARD_MULTIPLE × risk in favor — the continuation thesis gets room to pay off, unlike a
 *  counter-trend fade lane's fast-bank/wide-stop shape. */
export function buildResidualMomentumGeometry(entryPrice: number, direction: "LONG" | "SHORT"): ResidualMomentumGeometry | null {
  if (!(entryPrice > 0)) return null;
  const stopMove = entryPrice * (RM_STOP_FLOOR_BPS / 10_000);
  const initialStop = direction === "LONG" ? entryPrice - stopMove : entryPrice + stopMove;
  if (!(initialStop > 0)) return null;
  const risk = Math.abs(entryPrice - initialStop);
  if (!(risk > 0)) return null;
  const takeProfitPrice = direction === "LONG" ? entryPrice + RM_TP_REWARD_MULTIPLE * risk : entryPrice - RM_TP_REWARD_MULTIPLE * risk;
  if (!(takeProfitPrice > 0)) return null;
  const stopDistanceBps = (risk / entryPrice) * 10_000;
  return { entryPrice, initialStop, takeProfitPrice, stopDistanceBps };
}

export type ResidualMomentumKind = "DISPERSION_LONG" | "DISPERSION_SHORT" | "CATCHUP_LONG" | "CATCHUP_SHORT";

export interface ResidualMomentumObservation extends ResidualMomentumGeometry {
  observationId: string;
  symbol: string;
  kind: ResidualMomentumKind;
  direction: "LONG" | "SHORT";
  openedAt: string;
  openedAtMs: number;
  residualReturnAtEntry: number;
  betaAtEntry: number;
  /** Cross-sectional rank at entry (1 = highest residual return). Populated for DISPERSION_* kinds
   *  only — null for CATCHUP_* (which are cluster-relative, not universe-rank-relative). */
  rankAtEntry: number | null;
  /** Rank-persistence score ([0,1]) at entry, for every kind (a laggard's LOW persistence is itself
   *  informative — it means the laggard hasn't reliably been a laggard, it's fresh). */
  persistenceAtEntry: number | null;
  /** Correlation cluster — populated for CATCHUP_* kinds only. */
  cluster: string | null;
  clusterAvgResidualReturnAtEntry: number | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: "TP_HIT" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/** Realistic cost model reused verbatim from shadow-engine.ts (this repo's shared fee/slippage
 *  constants) rather than a new hardcoded figure — one round trip's fee+slippage in bps, plus an
 *  extra adverse-fill allowance on a stop-out (the same convention short-fade-edge.ts uses). */
function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / stopDistanceBps + (isLoss ? REALISTIC_SLIPPAGE_BPS_PER_SIDE / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/**
 * Resolve an OPEN observation by walking forward candles strictly AFTER openedAtMs, in ascending
 * time order, stopping at the FIRST candle that satisfies an exit condition — no lookahead: a
 * candle's data is never consulted before an earlier candle's exit decision is settled, and once an
 * exit is decided, no later candle can change it (appending more forward candles after a decided
 * exit is a no-op). SL-first on a same-candle ambiguous touch (conservative, matches every sibling
 * lane's convention). Mark-to-market at RM_MAX_HOLD_BARS if neither stop nor TP fires. Returns the
 * patch, or null if still open / not enough data yet.
 */
export function resolveResidualMomentumObservation(
  obs: ResidualMomentumObservation,
  forwardCandles: readonly Candle[],
  nowMs: number,
): Partial<ResidualMomentumObservation> | null {
  const fwd = [...forwardCandles].filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = Math.abs(obs.entryPrice - obs.initialStop);
  if (!(risk > 0)) return null;
  const isLong = obs.direction === "LONG";

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<ResidualMomentumObservation["exitReason"]>,
  ): Partial<ResidualMomentumObservation> => {
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
    const tpHit = isLong ? c.high >= obs.takeProfitPrice : c.low <= obs.takeProfitPrice;
    if (slHit) {
      // Ambiguous same-candle touch (both slHit and tpHit) — conservative SL-first, same as
      // short-fade-edge.ts / panic-washout-reclaim-edge.ts.
      return finalize(-1, c.openTime, "INITIAL_STOP");
    }
    if (tpHit) {
      const grossR = isLong ? (obs.takeProfitPrice - obs.entryPrice) / risk : (obs.entryPrice - obs.takeProfitPrice) / risk;
      return finalize(grossR, c.openTime, "TP_HIT");
    }
    if (i + 1 >= RM_MAX_HOLD_BARS) {
      const grossR = isLong ? (c.close - obs.entryPrice) / risk : (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM");
    }
  }
  // Not enough forward candles yet AND long past the hold window → expire (stale, un-resolvable).
  if (fwd.length === 0 && nowMs - obs.openedAtMs > RM_MAX_HOLD_BARS * RM_BAR_MS * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────

export interface RMCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  scoredTotal: number;
  dispersionRecordedTotal: number;
  catchupRecordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: RMCycleMeta = {
  lastCycleAt: null, cycles: 0, scoredTotal: 0, dispersionRecordedTotal: 0, catchupRecordedTotal: 0, lastCycleError: null,
};

interface RMState {
  version: number;
  observations: ResidualMomentumObservation[];
  rankHistory: Record<string, number[]>;
  cycleMeta?: RMCycleMeta;
}

export class ResidualMomentumStore {
  private state: RMState = { version: 1, observations: [], rankHistory: {}, cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<RMState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as ResidualMomentumObservation[];
        if (parsed.rankHistory && typeof parsed.rankHistory === "object") {
          this.state.rankHistory = parsed.rankHistory as Record<string, number[]>;
        }
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): ResidualMomentumObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): RMCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  rankHistoryFor(symbol: string): number[] {
    return this.state.rankHistory[symbol] ?? [];
  }
  /** Appends the latest rank for a symbol, pruning the ring buffer to RM_RANK_HISTORY_MAX (bounded
   *  retention — the persistence score only ever needs a short rolling window, not the full history). */
  pushRank(symbol: string, rank: number): void {
    const hist = [...(this.state.rankHistory[symbol] ?? []), rank];
    while (hist.length > RM_RANK_HISTORY_MAX) hist.shift();
    this.state.rankHistory[symbol] = hist;
  }
  recordCycle(atIso: string, result: RMCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.scoredTotal += result.scored;
      meta.dispersionRecordedTotal += result.dispersionRecorded;
      meta.catchupRecordedTotal += result.catchupRecorded;
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: ResidualMomentumObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<ResidualMomentumObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept (it must stay resolvable), plus at most
   *  RM_MAX_STORED_OBSERVATIONS settled (non-OPEN) ones — oldest settled observations are dropped
   *  first once that cap is exceeded, matching this repo's "bounded/pruned retention" convention. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled = settled.length > RM_MAX_STORED_OBSERVATIONS
      ? settled.slice(settled.length - RM_MAX_STORED_OBSERVATIONS)
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

let singleton: ResidualMomentumStore | null = null;
export function getResidualMomentumStore(dataDir = "data"): ResidualMomentumStore {
  if (!singleton) singleton = new ResidualMomentumStore(resolve(dataDir, "residual-momentum-edge.json"));
  return singleton;
}
export function _resetResidualMomentumStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────

export interface RMCycleResult {
  scanned: number;
  scored: number;
  dispersionRecorded: number;
  catchupRecorded: number;
  catchupCandidates: number;
  resolved: number;
  expired: number;
}

/**
 * One measurement cycle:
 *   1. resolve OPEN observations against forward candles already fetched for their symbol;
 *   2. score every universe symbol's beta + residual return against BTC;
 *   3. rank the scored universe, persist each symbol's rank into its rolling history;
 *   4. open DISPERSION_LONG/SHORT observations for the top-K / bottom-K of the residual ranking;
 *   5. run the leader-laggard cluster detector and open CATCHUP_LONG/SHORT observations.
 * Pure data accrual — report-only, exactly like every sibling lane's cycle.
 */
export async function runResidualMomentumCycle(opts: {
  store: ResidualMomentumStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  /** Don't record a second OPEN obs of the same kind for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<RMCycleResult> {
  const result: RMCycleResult = {
    scanned: 0, scored: 0, dispersionRecorded: 0, catchupRecorded: 0, catchupCandidates: 0, resolved: 0, expired: 0,
  };
  const universe = (opts.universe ?? RM_UNIVERSE).filter((s) => s.toUpperCase() !== RM_BENCHMARK_SYMBOL);
  const dedupeMs = opts.dedupeWindowMs ?? 3_600_000; // 1h — one signal per symbol per bar, matches RM_INTERVAL
  const nowIso = new Date(opts.now).toISOString();

  let btcCandles: Candle[] = [];
  try {
    btcCandles = await opts.fetchCandles(RM_BENCHMARK_SYMBOL);
  } catch {
    btcCandles = [];
  }

  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of universe) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* skip this symbol this cycle */
    }
  }

  // 1. resolve OPEN observations with forward candles.
  // 2026-07-11 fix: previously `continue`d entirely when this symbol's fetch failed/was skipped
  // this cycle, which meant resolveResidualMomentumObservation's own stale-expiry fallback (fires
  // when forwardCandles is empty AND the observation is long past RM_MAX_HOLD_BARS) never even got
  // a chance to run — an observation on a persistently-failing symbol (e.g. during this repo's
  // documented recurring Binance geo-block outages) stayed OPEN forever, inflating openCount and
  // biasing resolvedCount/netAvgR/edgeReady. Passing [] instead reuses that existing fallback
  // (confirmed safe: an empty forwardCandles array short-circuits the fill-check loop and falls
  // straight through to the same expiry check a genuinely-fetched-but-empty response would hit).
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol) ?? [];
    const patch = resolveResidualMomentumObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. score the universe (beta + residual return, once per symbol).
  const scores: ResidualMomentumSymbolScore[] = [];
  if (btcCandles.length > 0) {
    for (const symbol of universe) {
      result.scanned += 1;
      const candles = candlesBySymbol.get(symbol);
      if (!candles) continue;
      const core = computeResidualMomentumScore(candles, btcCandles);
      if (core) {
        result.scored += 1;
        scores.push({ ...core, symbol });
      }
    }
  }
  if (scores.length === 0) {
    opts.store.recordCycle(nowIso, result);
    opts.store.save();
    return result;
  }

  // 3. rank + persist rank history + persistence score.
  const ranked = rankResidualMomentum(scores);
  for (const r of ranked) opts.store.pushRank(r.symbol, r.rank);
  const persistenceBySymbol = new Map<string, number>();
  for (const r of ranked) {
    persistenceBySymbol.set(r.symbol, computeRankPersistence(opts.store.rankHistoryFor(r.symbol), ranked.length));
  }

  const recentlyOpen = (symbol: string, kind: ResidualMomentumKind): boolean =>
    opts.store.all.some((o) => o.symbol === symbol && o.kind === kind && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs);

  // 4. dispersion: top-K long / bottom-K short of the residual ranking. Guard against overlap when
  //    the universe is small (k capped at floor(length/2), same convention as cross-sectional-edge).
  const k = Math.min(RM_K, Math.floor(ranked.length / 2));
  const topK = k > 0 ? ranked.slice(0, k) : [];
  const bottomK = k > 0 ? ranked.slice(ranked.length - k) : [];
  for (const r of topK) {
    if (recentlyOpen(r.symbol, "DISPERSION_LONG")) continue;
    const geometry = buildResidualMomentumGeometry(r.price, "LONG");
    if (!geometry) continue;
    const added = opts.store.add({
      ...geometry,
      observationId: `rm:disp-long:${r.symbol}:${opts.now}`,
      symbol: r.symbol,
      kind: "DISPERSION_LONG",
      direction: "LONG",
      residualReturnAtEntry: r.residualReturn,
      betaAtEntry: r.beta,
      rankAtEntry: r.rank,
      persistenceAtEntry: persistenceBySymbol.get(r.symbol) ?? null,
      cluster: null,
      clusterAvgResidualReturnAtEntry: null,
      openedAt: nowIso,
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.dispersionRecorded += 1;
  }
  for (const r of bottomK) {
    if (recentlyOpen(r.symbol, "DISPERSION_SHORT")) continue;
    const geometry = buildResidualMomentumGeometry(r.price, "SHORT");
    if (!geometry) continue;
    const added = opts.store.add({
      ...geometry,
      observationId: `rm:disp-short:${r.symbol}:${opts.now}`,
      symbol: r.symbol,
      kind: "DISPERSION_SHORT",
      direction: "SHORT",
      residualReturnAtEntry: r.residualReturn,
      betaAtEntry: r.beta,
      rankAtEntry: r.rank,
      persistenceAtEntry: persistenceBySymbol.get(r.symbol) ?? null,
      cluster: null,
      clusterAvgResidualReturnAtEntry: null,
      openedAt: nowIso,
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.dispersionRecorded += 1;
  }

  // 5. leader-laggard catch-up.
  const catchups = detectLeaderLaggardCatchUp(scores);
  result.catchupCandidates = catchups.length;
  const scoreBySymbol = new Map(scores.map((s) => [s.symbol, s]));
  for (const cu of catchups) {
    const kind: ResidualMomentumKind = cu.direction === "LONG" ? "CATCHUP_LONG" : "CATCHUP_SHORT";
    if (recentlyOpen(cu.symbol, kind)) continue;
    const scoreEntry = scoreBySymbol.get(cu.symbol);
    if (!scoreEntry) continue;
    const geometry = buildResidualMomentumGeometry(scoreEntry.price, cu.direction);
    if (!geometry) continue;
    const added = opts.store.add({
      ...geometry,
      observationId: `rm:${kind.toLowerCase()}:${cu.symbol}:${opts.now}`,
      symbol: cu.symbol,
      kind,
      direction: cu.direction,
      residualReturnAtEntry: scoreEntry.residualReturn,
      betaAtEntry: scoreEntry.beta,
      rankAtEntry: null,
      persistenceAtEntry: persistenceBySymbol.get(cu.symbol) ?? null,
      cluster: cu.cluster,
      clusterAvgResidualReturnAtEntry: cu.clusterAvgResidualReturn,
      openedAt: nowIso,
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.catchupRecorded += 1;
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

export async function runResidualMomentumCycleGuarded(opts: Parameters<typeof runResidualMomentumCycle>[0]): Promise<RMCycleResult | null> {
  try {
    return await runResidualMomentumCycle(opts);
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

export interface ResidualMomentumReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  benchmarkSymbol: string;
  betaWindowBars: number;
  momentumBars: number;
  k: number;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  tpShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  byKind: Array<{ kind: ResidualMomentumKind; resolvedCount: number; netAvgR: number | null; wr: number | null }>;
  topRecent: Array<{
    symbol: string;
    kind: ResidualMomentumKind;
    direction: "LONG" | "SHORT";
    netR: number | null;
    status: string;
    exitReason: string | null;
    openedAt: string;
    residualReturnAtEntry: number;
    rankAtEntry: number | null;
    persistenceAtEntry: number | null;
  }>;
  cycleMeta: RMCycleMeta | null;
}

const RM_KINDS: readonly ResidualMomentumKind[] = ["DISPERSION_LONG", "DISPERSION_SHORT", "CATCHUP_LONG", "CATCHUP_SHORT"];

export function buildResidualMomentumReport(
  observations: readonly ResidualMomentumObservation[],
  cycleMeta?: RMCycleMeta,
): ResidualMomentumReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const tpHits = resolved.filter((o) => o.exitReason === "TP_HIT").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = nets.length ? mean(nets) : null;
  // Same edgeReady gate as every sibling measurement lane in this repo (short-fade-edge.ts,
  // panic-washout-reclaim-edge.ts, composite-estimator-edge.ts, regime-composite-edge.ts): n>=30,
  // net-of-cost avg R >= 0.05, and a real payoff (winners bigger than losers, PF > 1.1).
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const byKind = RM_KINDS.map((kind) => {
    const rows = resolved.filter((o) => o.kind === kind);
    const rowNets = rows.map((o) => o.netR as number);
    return {
      kind,
      resolvedCount: rows.length,
      netAvgR: rowNets.length ? mean(rowNets) : null,
      wr: rows.length ? rowNets.filter((r) => r > 0).length / rows.length : null,
    };
  });

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      symbol: o.symbol,
      kind: o.kind,
      direction: o.direction,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
      residualReturnAtEntry: o.residualReturnAtEntry,
      rankAtEntry: o.rankAtEntry,
      persistenceAtEntry: o.persistenceAtEntry,
    }));

  return {
    laneId: RM_LANE_ID,
    interval: RM_INTERVAL,
    universe: RM_UNIVERSE,
    benchmarkSymbol: RM_BENCHMARK_SYMBOL,
    betaWindowBars: RM_BETA_WINDOW_BARS,
    momentumBars: RM_MOMENTUM_BARS,
    k: RM_K,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: resolved.length ? mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))) : null,
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    tpShare: resolved.length ? tpHits / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    byKind,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

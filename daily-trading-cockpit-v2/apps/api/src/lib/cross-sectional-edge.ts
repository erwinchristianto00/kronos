/**
 * Cross-sectional market-neutral measurement lane (report-only).
 *
 * Each cycle ranks the scanner universe by a cross-sectional score and records report-only baskets.
 * Baseline variants measure equal-notional momentum dispersion; adaptive variants add side-specific
 * symbol eligibility, inverse-vol weighting, regime tags, and basket-level TP/SL/regime-flip exits.
 *
 * Report-only like fade-long / h6-trend: NEVER touches the allocator, paper book, or live engine.
 * Env-gated (CROSS_SECTIONAL_EDGE_DISABLED=1). It is a HYPOTHESIS — crypto is highly correlated, so
 * dispersion (the fuel) can collapse in risk-on/off; prove OOS across bull AND bear before any read.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { clusterOf, isMajorCluster } from "./correlation-clusters.js";

function envNumPos(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS = envNumPos(
  "CROSS_SECTIONAL_EDGE_MAX_STORED_OBSERVATIONS",
  5000,
);

function envNumNonNeg(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envSymbolSet(key: string, fallback: string): ReadonlySet<string> {
  const raw = process.env[key] ?? fallback;
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "6h": 6 * 60 * 60_000, "1d": 24 * 60 * 60_000,
};

export const CROSS_SECTIONAL_INTERVAL = process.env.CROSS_SECTIONAL_INTERVAL || "1h";
export const CROSS_SECTIONAL_MOMENTUM_BARS = envNumPos("CROSS_SECTIONAL_MOMENTUM_BARS", 24); // ROC lookback
export const CROSS_SECTIONAL_K = envNumPos("CROSS_SECTIONAL_K", 3); // legs per side (long-k / short-k)

// --- Regime-skewed composition (2026-07-08, operator-requested) ---
// Real data (99 closed FILTERED baskets): TREND_LONG-at-open baskets averaged +2.79% on the long leg
// vs -1.83% on the short leg; TREND_SHORT-at-open averaged +1.92% short vs +0.02% long — whichever
// side matches the regime carries the basket, the other is close to dead weight or a real drag. This
// tilts leg COUNT toward the regime-favored side when the regime-axis score (see
// regime-axis-timeline.ts) is outside its ±0.12 neutral boundary — the SAME boundary already proven
// out by the directional lane-switch guidance. Applied ONLY to the FILTERED (executed) variant; RAW
// stays unskewed as the enduring, unmodified OOS control. Env-gated + off by default.
export function isCrossSectionalRegimeSkewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_REGIME_SKEW_ENABLED === "1";
}
export const CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY = envNumPos("CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY", 0.12);
export const CROSS_SECTIONAL_REGIME_SKEW_DELTA = envNumPos("CROSS_SECTIONAL_REGIME_SKEW_DELTA", 1); // 3/3 -> 4/2

/** Pure: given the base per-side k and the current regime-axis score, returns the (possibly skewed)
 *  long/short leg counts. Null/non-finite/inside-neutral-zone score -> unchanged 3/3-style symmetry.
 *  The delta is capped so the disfavored side can never drop to 0 (a hedge, however small, survives). */
export function regimeSkewedK(
  baseK: number,
  axisScore: number | null,
  opts: { zoneBoundary?: number; delta?: number } = {},
): { longK: number; shortK: number } {
  const zoneBoundary = opts.zoneBoundary ?? CROSS_SECTIONAL_REGIME_SKEW_ZONE_BOUNDARY;
  if (axisScore === null || !Number.isFinite(axisScore) || Math.abs(axisScore) <= zoneBoundary) {
    return { longK: baseK, shortK: baseK };
  }
  const delta = Math.max(0, Math.min(baseK - 1, opts.delta ?? CROSS_SECTIONAL_REGIME_SKEW_DELTA));
  return axisScore > 0 ? { longK: baseK + delta, shortK: baseK - delta } : { longK: baseK - delta, shortK: baseK + delta };
}
/** 2026-07-12 (profitability Stage 3): report-only counterfactual measuring what the regime skew
 *  (CROSS_SECTIONAL_REGIME_SKEW_ENABLED, 3/3 → 4/2 in a bullish axis) actually costs or earns on
 *  REAL closed baskets. The adversarial diagnosis flagged that the skew turns the book's only
 *  genuine hedge into more same-direction beta precisely when a regime flip would hurt — this
 *  answers "is the tilt paying?" from real fills, not simulation. A basket is "skewed" when its
 *  long-leg count ≠ short-leg count. Reports each cohort's mean net return, and within skewed
 *  baskets the mean per-leg return on each side — if the LONG side (the one the skew over-weights
 *  in a bull axis) isn't out-returning the short side, the skew is adding directional risk for no
 *  edge and should be reconsidered. Pure function; caller supplies the closed baskets. */
export interface RegimeSkewCounterfactual {
  skewedCount: number;
  symmetricCount: number;
  skewedMeanNetUsd: number | null;
  symmetricMeanNetUsd: number | null;
  skewedLongLegMeanReturnPct: number | null;
  skewedShortLegMeanReturnPct: number | null;
  /** Positive ⇒ the over-weighted long side out-returned the short side on skewed baskets (skew
   *  paying); negative ⇒ the skew added long beta the dispersion didn't reward. Null until data. */
  skewLongMinusShortEdgePct: number | null;
  verdict: "SKEW_PAYING" | "SKEW_COSTING" | "INSUFFICIENT_DATA";
}
export function regimeSkewCounterfactual(
  closedBaskets: ReadonlyArray<{
    netPnlUsd: number | null;
    legs: ReadonlyArray<{ side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number | null }>;
  }>,
): RegimeSkewCounterfactual {
  const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const legReturnPct = (leg: { side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number | null }): number | null => {
    const exit = leg.exitPrice;
    if (exit === null || !(leg.entryPrice > 0) || !(exit > 0)) return null;
    return leg.side === "LONG" ? (exit - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - exit) / leg.entryPrice;
  };
  const skewedNet: number[] = [];
  const symmetricNet: number[] = [];
  const skewedLongLegReturns: number[] = [];
  const skewedShortLegReturns: number[] = [];
  for (const b of closedBaskets) {
    const longs = b.legs.filter((l) => l.side === "LONG").length;
    const shorts = b.legs.filter((l) => l.side === "SHORT").length;
    const isSkewed = longs !== shorts;
    if (typeof b.netPnlUsd === "number") (isSkewed ? skewedNet : symmetricNet).push(b.netPnlUsd);
    if (isSkewed) {
      for (const leg of b.legs) {
        const r = legReturnPct(leg);
        if (r === null) continue;
        (leg.side === "LONG" ? skewedLongLegReturns : skewedShortLegReturns).push(r);
      }
    }
  }
  const skewedLongMean = mean(skewedLongLegReturns);
  const skewedShortMean = mean(skewedShortLegReturns);
  const edge =
    skewedLongMean !== null && skewedShortMean !== null ? skewedLongMean - skewedShortMean : null;
  const verdict: RegimeSkewCounterfactual["verdict"] =
    edge === null || skewedNet.length < 5 ? "INSUFFICIENT_DATA" : edge >= 0 ? "SKEW_PAYING" : "SKEW_COSTING";
  return {
    skewedCount: skewedNet.length,
    symmetricCount: symmetricNet.length,
    skewedMeanNetUsd: mean(skewedNet),
    symmetricMeanNetUsd: mean(symmetricNet),
    skewedLongLegMeanReturnPct: skewedLongMean,
    skewedShortLegMeanReturnPct: skewedShortMean,
    skewLongMinusShortEdgePct: edge,
    verdict,
  };
}
export const CROSS_SECTIONAL_HORIZON_BARS = envNumPos("CROSS_SECTIONAL_HORIZON_BARS", 24); // forward hold (bars)
export const CROSS_SECTIONAL_ROUNDTRIP_BPS = Number(process.env.CROSS_SECTIONAL_ROUNDTRIP_BPS ?? 12); // per-position round-trip cost
export const CROSS_SECTIONAL_FILTERED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_FILTERED`;
export const CROSS_SECTIONAL_TREND_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_TREND_BETA_VOL`;
export const CROSS_SECTIONAL_MIXED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_MIXED_MR`;
export const CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP", 0.02); // 24h momentum spread floor
// 2026-07-08 (operator-requested): the universe was 40% L1 (SOL/AVAX/SUI/INJ/APT/SEI/NEAR/ADA),
// so a pure top-k/bottom-k score sort could fill an ENTIRE side with one correlated cluster —
// nominally "3 different symbols" but effectively one correlated bet, not the diversified hedge
// the basket is supposed to be. Caps how many of a side's selected legs may share a cluster
// (BTC/ETH majors exempt, same convention as the directional concentration cap). 0 disables.
export const CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER", 2);
export const CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS", 25); // proof target
export const CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS", 35); // safer proof target
export const CROSS_SECTIONAL_TREND_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_TREND_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS", 40);
export const CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS", 30);
export const CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT = Math.min(0.9, Math.max(0.1, Number(process.env.CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT ?? 0.35)));
// 2026-07-07: "PEPEUSDT" is not a real Binance futures symbol — the exchange lists it as
// "1000PEPEUSDT" (a 1000x-multiplier contract), confirmed against the real exchangeInfo/klines
// endpoints on both mainnet and testnet (both reject plain "PEPEUSDT" with "Invalid symbol").
// Any basket containing the wrong name as a leg silently failed at getExchangeFilters() inside
// cross-sectional-executor.ts's maybeOpenBasket() — no filter entry, no error, the whole basket
// just never opened. Fixed here at the source (env default + deployed .env values) rather than
// papering over it with a translation layer in the executor, per this module's own design
// constraint: "what executes is exactly what was measured — no separate signal path."
export const CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST",
  "ADAUSDT,BNBUSDT,ETHUSDT,OPUSDT,1000PEPEUSDT,SOLUSDT,SUIUSDT",
);
// 2026-07-09 (audit finding — live starvation): with CROSS_SECTIONAL_REGIME_SKEW_ENABLED=1, a
// deeply bearish axisScore pushes shortK to baseK+delta (e.g. 3->4). The prior 5-symbol allowlist
// had NO margin above that (2 of the 5 sit in CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST-adjacent
// demotion churn — SEIUSDT/WLDUSDT — leaving exactly 3 raw-eligible, below the skewed shortK of 4).
// buildCrossSectionalBasket() returns null whenever selectedShorts.length < shortK — this basket
// silently stopped opening for ~16-21h on live/testnet, in EXACTLY the bearish regime the skew
// exists to lean into. Widened with 5 more liquid symbols (none overlapping
// CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST, to avoid the same starvation via long/short exclusivity)
// so a handful of demotions can no longer drop the raw-eligible count below the skewed floor.
export const CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST",
  "DOGEUSDT,OPUSDT,1000PEPEUSDT,SEIUSDT,WLDUSDT,ARBUSDT,XRPUSDT,LINKUSDT,WIFUSDT,AAVEUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST",
  "APTUSDT,AVAXUSDT,FETUSDT,INJUSDT,NEARUSDT,RNDRUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_ALLOWLIST",
  "SOLUSDT,ETHUSDT,OPUSDT,1000PEPEUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_BLOCKLIST",
  "FETUSDT,INJUSDT,ARBUSDT,NEARUSDT,AVAXUSDT,BTCUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST",
  "WLDUSDT,SEIUSDT,DOGEUSDT,1000PEPEUSDT,APTUSDT,OPUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST",
  "AVAXUSDT,INJUSDT,FETUSDT,NEARUSDT,RNDRUSDT",
);
// 2026-07-08 (operator-requested widening): a dedicated universe for cross-sectional, separate
// from the main scanner's UNIVERSE (scan-service.ts) — widening THAT shared constant would also
// add these symbols to Kronos forecasting, directional lane candidates, etc., none of which were
// asked for or vetted here. The prior 20 were 40% L1 (SOL/AVAX/SUI/INJ/APT/SEI/NEAR/ADA), leaving
// MEME/AI/L2_DEFI too thin to ever fill a basket leg without repeating the same few names — these
// additions deepen those thin clusters specifically (see correlation-clusters.ts), not L1 further.
// "1000PEPEUSDT" (not the scanner's bare "PEPEUSDT") is the real Binance futures symbol — see
// spotSymbolForCandles usage at this universe's fetchCandles call site for the spot/futures split.
export const CROSS_SECTIONAL_UNIVERSE: readonly string[] = [
  ...envSymbolSet(
    "CROSS_SECTIONAL_UNIVERSE",
    "BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,SUIUSDT,1000PEPEUSDT,ARBUSDT,OPUSDT," +
      "INJUSDT,WLDUSDT,APTUSDT,SEIUSDT,NEARUSDT,BNBUSDT,XRPUSDT,ADAUSDT,FETUSDT,RNDRUSDT," +
      "WIFUSDT,TAOUSDT,ARKMUSDT,UNIUSDT,AAVEUSDT,LDOUSDT",
  ),
];
const BAR_MS = INTERVAL_MS[CROSS_SECTIONAL_INTERVAL] ?? INTERVAL_MS["1h"]!;
export const CROSS_SECTIONAL_HORIZON_MS = CROSS_SECTIONAL_HORIZON_BARS * BAR_MS;
const EXPIRY_MS = CROSS_SECTIONAL_HORIZON_MS * 3; // give up on a basket missing prices well past its horizon

export type CrossSectionalStatus = "OPEN" | "CLOSED" | "EXPIRED";
export type CrossSectionalVariant = "RAW" | "FILTERED" | "TREND_BETA_VOL" | "MIXED_MEAN_REVERSION";
export type CrossSectionalStrategyFamily = "MOMENTUM_DISPERSION" | "MEAN_REVERSION";
export type CrossSectionalRegimeClass = "TREND_LONG" | "TREND_SHORT" | "MIXED_CHOP" | "UNKNOWN";
export type CrossSectionalExitReason = "HORIZON" | "TAKE_PROFIT" | "STOP_LOSS" | "REGIME_FLIP" | "EXPIRED";

export interface CrossSectionalLeg {
  symbol: string;
  entryPrice: number;
  exitPrice: number | null;
  /** Fraction of total basket capital assigned to this leg. Missing means legacy equal-weight. */
  weight?: number | null;
}

export interface CrossSectionalRegimeContext {
  currentRegime: string | null;
  controllerMode: string | null;
  directionalBias: string | null;
  confidence: string | null;
  capturedAt: string | null;
  regimeClass: CrossSectionalRegimeClass;
}

export interface CrossSectionalObservation {
  observationId: string;
  openedAt: string;
  openedAtMs: number;
  horizonMs: number;
  signal: string;
  variant?: CrossSectionalVariant;
  strategyFamily?: CrossSectionalStrategyFamily;
  k: number;
  /** Actual per-side leg counts used (2026-07-08, regime-skewed composition) — equal to `k` on both
   *  sides unless the regime-axis score was outside the neutral zone at open. Recorded per basket
   *  so skewed vs. unskewed baskets stay auditable/comparable after the fact. */
  longK?: number;
  shortK?: number;
  longLeg: CrossSectionalLeg[];
  shortLeg: CrossSectionalLeg[];
  status: CrossSectionalStatus;
  scoreGap?: number | null;
  regimeContext?: CrossSectionalRegimeContext | null;
  regimeClassAtOpen?: CrossSectionalRegimeClass | null;
  longCapitalWeight?: number | null;
  shortCapitalWeight?: number | null;
  weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY" | null;
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  regimeFlipExit?: boolean | null;
  exitReason?: CrossSectionalExitReason | null;
  /** Return on deployed capital after market-beta cancels = the cross-sectional dispersion. */
  grossReturn: number | null;
  costReturn: number | null;
  netReturn: number | null;
  longLegReturn: number | null;
  shortLegReturn: number | null;
  resolvedAt: string | null;
}

export interface ScoredSymbol {
  symbol: string;
  score: number;
  price: number;
}

interface CrossSectionalBasketOpts {
  k: number;
  /** Per-side leg count overrides (2026-07-08, regime-skewed composition). Default to `k` when
   *  unset, so every existing caller is unaffected. */
  longK?: number;
  shortK?: number;
  signal: string;
  now: string;
  openedAtMs: number;
  horizonMs: number;
  variant?: CrossSectionalVariant;
  strategyFamily?: CrossSectionalStrategyFamily;
  selectionMode?: "MOMENTUM" | "MEAN_REVERSION";
  regimeContext?: CrossSectionalRegimeContext | null;
  longAllowlist?: ReadonlySet<string> | null;
  longBlocklist?: ReadonlySet<string> | null;
  shortAllowlist?: ReadonlySet<string> | null;
  shortBlocklist?: ReadonlySet<string> | null;
  minScoreGap?: number;
  /** Max legs per side allowed to share a correlation cluster (BTC/ETH majors exempt). Undefined/0
   *  disables — every existing caller (that never sets it) keeps today's pure top-k/bottom-k sort. */
  maxPerCluster?: number;
  longCapitalWeight?: number;
  shortCapitalWeight?: number;
  weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY";
  volBySymbol?: Record<string, number>;
  takeProfitReturn?: number | null;
  stopLossReturn?: number | null;
  regimeFlipExit?: boolean;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Walks the score-sorted pool taking the best k, but skips a candidate that would push its
 *  cluster's count on this side past maxPerCluster — so a heavily-populated cluster (e.g. L1)
 *  can't fill an entire side even when it dominates the universe. Majors (BTC/ETH) are exempt,
 *  matching the directional concentration cap's convention. Order-preserving: still best-score-
 *  first among whatever remains eligible, never reshuffles for "fairness" beyond the cap itself. */
function selectWithClusterCap(sorted: ScoredSymbol[], k: number, maxPerCluster?: number): ScoredSymbol[] {
  if (!maxPerCluster || maxPerCluster <= 0) return sorted.slice(0, k);
  const selected: ScoredSymbol[] = [];
  const clusterCounts = new Map<string, number>();
  for (const s of sorted) {
    if (selected.length >= k) break;
    const cluster = clusterOf(s.symbol);
    const count = clusterCounts.get(cluster) ?? 0;
    if (!isMajorCluster(cluster) && count >= maxPerCluster) continue;
    selected.push(s);
    clusterCounts.set(cluster, count + 1);
  }
  return selected;
}

function allowed(symbol: string, allowlist?: ReadonlySet<string> | null, blocklist?: ReadonlySet<string> | null): boolean {
  const s = symbol.toUpperCase();
  if (blocklist?.has(s)) return false;
  return !allowlist || allowlist.size === 0 || allowlist.has(s);
}

function clampWeight(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function scoreGapFor(longLeg: ScoredSymbol[], shortLeg: ScoredSymbol[]): number {
  return Math.abs(mean(longLeg.map((s) => s.score)) - mean(shortLeg.map((s) => s.score)));
}

function weightedLegs(
  legs: ScoredSymbol[],
  sideCapital: number,
  opts: { weightingModel?: "EQUAL_NOTIONAL" | "BETA_VOL_PROXY"; volBySymbol?: Record<string, number> },
): CrossSectionalLeg[] {
  if (legs.length === 0) return [];
  const equalWeight = sideCapital / legs.length;
  if (opts.weightingModel !== "BETA_VOL_PROXY") {
    return legs.map((s) => ({ symbol: s.symbol, entryPrice: s.price, exitPrice: null, weight: equalWeight }));
  }
  const raw = legs.map((s) => {
    const vol = opts.volBySymbol?.[s.symbol];
    return Number.isFinite(vol) && vol! > 0 ? 1 / vol! : 1;
  });
  const denom = raw.reduce((a, b) => a + b, 0) || legs.length;
  return legs.map((s, i) => ({
    symbol: s.symbol,
    entryPrice: s.price,
    exitPrice: null,
    weight: sideCapital * raw[i]! / denom,
  }));
}

function legReturnContribution(legs: CrossSectionalLeg[], direction: "LONG" | "SHORT"): { normalizedReturn: number; contribution: number; weightSum: number } {
  const returns = legs.map((l) => {
    if (!(l.exitPrice !== null && l.entryPrice > 0)) return 0;
    return direction === "LONG" ? (l.exitPrice - l.entryPrice) / l.entryPrice : (l.entryPrice - l.exitPrice) / l.entryPrice;
  });
  const hasWeights = legs.some((l) => Number.isFinite(l.weight ?? NaN));
  if (!hasWeights) {
    const normalizedReturn = mean(returns);
    return { normalizedReturn, contribution: normalizedReturn / 2, weightSum: 0.5 };
  }
  const weightSum = legs.reduce((sum, l) => sum + (Number.isFinite(l.weight ?? NaN) ? Math.max(0, l.weight!) : 0), 0);
  const contribution = legs.reduce((sum, l, i) => sum + (Number.isFinite(l.weight ?? NaN) ? Math.max(0, l.weight!) : 0) * returns[i]!, 0);
  return { normalizedReturn: weightSum > 0 ? contribution / weightSum : 0, contribution, weightSum };
}

function shouldCutForRegimeFlip(obs: CrossSectionalObservation, current?: CrossSectionalRegimeContext | null): boolean {
  if (!obs.regimeFlipExit) return false;
  const from = obs.regimeClassAtOpen ?? obs.regimeContext?.regimeClass ?? null;
  const to = current?.regimeClass ?? null;
  return from !== null && to !== null && from !== "UNKNOWN" && to !== "UNKNOWN" && from !== to;
}

/** N-bar return (ROC) from candles + the latest close. null if not enough history. */
export function crossSectionalMomentumScore(candles: Candle[], bars: number): { score: number; price: number } | null {
  if (!Array.isArray(candles) || candles.length < bars + 1) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - bars]!;
  if (!(price > 0) || !(past > 0)) return null;
  return { score: (price - past) / past, price };
}

/** Rank scored symbols and build an equal-notional long-top-k / short-bottom-k basket. */
export function buildCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: CrossSectionalBasketOpts,
): CrossSectionalObservation | null {
  const valid = scored.filter((s) => Number.isFinite(s.score) && Number.isFinite(s.price) && s.price > 0);
  const mode = opts.selectionMode ?? "MOMENTUM";
  const longK = opts.longK ?? opts.k;
  const shortK = opts.shortK ?? opts.k;
  const longPoolAll = valid.filter((s) => allowed(s.symbol, opts.longAllowlist, opts.longBlocklist));
  const longSortedAll = [...longPoolAll].sort((a, b) => mode === "MEAN_REVERSION" ? a.score - b.score : b.score - a.score);
  const shortPoolAll = valid.filter((s) => allowed(s.symbol, opts.shortAllowlist, opts.shortBlocklist));
  const shortSortedAll = [...shortPoolAll].sort((a, b) => mode === "MEAN_REVERSION" ? b.score - a.score : a.score - b.score);
  // A symbol eligible for BOTH sides (e.g. via CROSS_SECTIONAL_REGIME_SKEW's own allowlists) can
  // only ever fill one leg. Whichever side selects first claims it. Previously long always went
  // first, which starves short whenever a regime skew (see regimeSkewedK) raises shortK above
  // longK — the bearish-favored side needing MORE legs lost the shared symbols to the side needing
  // FEWER (2026-07-09 audit: BEAR skew needed 4 shorts / 2 longs, but long's greedy first pick took
  // both overlap-eligible symbols, leaving short one leg short). Select the side with the LARGER
  // requirement first so a regime-favored side is never starved by the other side's leftovers.
  // Ties (the common unskewed 3/3 case) keep the original long-first order unchanged.
  let selectedLongs: ScoredSymbol[];
  let selectedShorts: ScoredSymbol[];
  if (shortK > longK) {
    selectedShorts = selectWithClusterCap(shortSortedAll, shortK, opts.maxPerCluster);
    const shortSymbols = new Set(selectedShorts.map((s) => s.symbol));
    const longRemaining = longSortedAll.filter((s) => !shortSymbols.has(s.symbol));
    selectedLongs = selectWithClusterCap(longRemaining, longK, opts.maxPerCluster);
  } else {
    selectedLongs = selectWithClusterCap(longSortedAll, longK, opts.maxPerCluster);
    const longSymbols = new Set(selectedLongs.map((s) => s.symbol));
    const shortRemaining = shortSortedAll.filter((s) => !longSymbols.has(s.symbol));
    selectedShorts = selectWithClusterCap(shortRemaining, shortK, opts.maxPerCluster);
  }
  if (selectedLongs.length < longK || selectedShorts.length < shortK) return null;
  const scoreGap = scoreGapFor(selectedLongs, selectedShorts);
  if (opts.minScoreGap !== undefined && scoreGap < opts.minScoreGap) return null;
  const longCapitalWeight = clampWeight(opts.longCapitalWeight ?? 0.5, 0.5);
  const shortCapitalWeight = clampWeight(opts.shortCapitalWeight ?? (1 - longCapitalWeight), 1 - longCapitalWeight);
  const totalCapital = longCapitalWeight + shortCapitalWeight;
  const normalizedLongCapital = longCapitalWeight / totalCapital;
  const normalizedShortCapital = shortCapitalWeight / totalCapital;
  const weightingModel = opts.weightingModel ?? "EQUAL_NOTIONAL";
  return {
    observationId: `xsec:${opts.signal}:${opts.openedAtMs}`,
    openedAt: opts.now,
    openedAtMs: opts.openedAtMs,
    horizonMs: opts.horizonMs,
    signal: opts.signal,
    variant: opts.variant ?? "RAW",
    strategyFamily: opts.strategyFamily ?? (mode === "MEAN_REVERSION" ? "MEAN_REVERSION" : "MOMENTUM_DISPERSION"),
    k: opts.k,
    longK: selectedLongs.length,
    shortK: selectedShorts.length,
    longLeg: weightedLegs(selectedLongs, normalizedLongCapital, { weightingModel, volBySymbol: opts.volBySymbol }),
    shortLeg: weightedLegs(selectedShorts, normalizedShortCapital, { weightingModel, volBySymbol: opts.volBySymbol }),
    status: "OPEN",
    scoreGap,
    regimeContext: opts.regimeContext ?? null,
    regimeClassAtOpen: opts.regimeContext?.regimeClass ?? null,
    longCapitalWeight: normalizedLongCapital,
    shortCapitalWeight: normalizedShortCapital,
    weightingModel,
    takeProfitReturn: opts.takeProfitReturn ?? null,
    stopLossReturn: opts.stopLossReturn ?? null,
    regimeFlipExit: opts.regimeFlipExit ?? false,
    exitReason: null,
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: null,
  };
}

// ── Auto-updating symbol filters (operator: "ikutin filtered symbol, auto update
// terus blacklist dan whitelist nya") ────────────────────────────────────────
//
// Derives per-symbol allow/blocklists from the MEASURED per-leg performance in the
// store's CLOSED baskets, using the static env lists as the HARD operator ceiling:
//   • a symbol with ≥ minLegSamples measured legs on a side and NEGATIVE avg return
//     is DEMOTED (removed from that side's allowlist, added to its blocklist);
//   • positive out-of-list symbols are reported in provenance, but they are NOT
//     promoted into executable allowlists. Execution must never outrun the operator
//     allow/block filters shown on /research.
// Recomputed every cycle, so the lists can demote toxic names while staying inside
// the explicit filtered universe.

export interface AdaptiveSymbolFilters {
  longAllowlist: string[];
  shortAllowlist: string[];
  longBlocklist: string[];
  shortBlocklist: string[];
  provenance: {
    closedBaskets: number;
    minLegSamples: number;
    promotedLong: string[];
    promotedShort: string[];
    demotedLong: string[];
    demotedShort: string[];
    minEligiblePerSide: number;
    /** Per-side floors actually applied — can diverge from minEligiblePerSide when regime skew
     *  raises one side's required leg count above the base K (see regimeSkewedK). */
    minEligiblePerSideLong: number;
    minEligiblePerSideShort: number;
    /** True when demotions alone would have left this side below minEligiblePerSide, so the
     *  fallback below kicked in instead. See the floor comment at its computation site. */
    longFloorApplied: boolean;
    shortFloorApplied: boolean;
  };
}

export function deriveAdaptiveSymbolFilters(
  store: CrossSectionalStore,
  opts: {
    minLegSamples?: number;
    minEligiblePerSide?: number;
    /** Per-side overrides — thread the REGIME-SKEWED longK/shortK through here (not just the base
     *  CROSS_SECTIONAL_K) when regime skew is enabled. 2026-07-11: the floor below used to always
     *  check against the unskewed base K on both sides, so when skew raised e.g. shortK from 3 to
     *  4, a side sitting at exactly 3 eligible symbols looked "fine" (3 is not < 3) even though
     *  buildFilteredCrossSectionalBasket actually needs 4 and would silently return null — the
     *  floor's whole purpose (never let a side lock out from forming baskets at all) failed
     *  silently in exactly the skewed-bearish-regime case the skew exists to lean into. Falls back
     *  to minEligiblePerSide (then CROSS_SECTIONAL_K) when not provided, so unskewed callers are
     *  unaffected. */
    minEligiblePerSideLong?: number;
    minEligiblePerSideShort?: number;
  } = {},
): AdaptiveSymbolFilters {
  const minLegSamples = opts.minLegSamples ?? 3;
  const minEligiblePerSide = opts.minEligiblePerSide ?? CROSS_SECTIONAL_K;
  const minEligiblePerSideLong = opts.minEligiblePerSideLong ?? minEligiblePerSide;
  const minEligiblePerSideShort = opts.minEligiblePerSideShort ?? minEligiblePerSide;
  const perf = new Map<string, { longN: number; longSum: number; shortN: number; shortSum: number }>();
  const bump = (symbol: string, side: "long" | "short", ret: number) => {
    const row = perf.get(symbol) ?? { longN: 0, longSum: 0, shortN: 0, shortSum: 0 };
    if (side === "long") {
      row.longN += 1;
      row.longSum += ret;
    } else {
      row.shortN += 1;
      row.shortSum += ret;
    }
    perf.set(symbol, row);
  };

  let closedBaskets = 0;
  for (const obs of store.all) {
    if (obs.status !== "CLOSED") continue;
    closedBaskets += 1;
    for (const leg of obs.longLeg) {
      if (leg.exitPrice !== null && leg.entryPrice > 0) bump(leg.symbol, "long", leg.exitPrice / leg.entryPrice - 1);
    }
    for (const leg of obs.shortLeg) {
      if (leg.exitPrice !== null && leg.entryPrice > 0) bump(leg.symbol, "short", -(leg.exitPrice / leg.entryPrice - 1));
    }
  }

  const promotedLong: string[] = [];
  const promotedShort: string[] = [];
  const demotedLong: string[] = [];
  const demotedShort: string[] = [];
  for (const [symbol, row] of perf) {
    if (row.longN >= minLegSamples) {
      if (row.longSum / row.longN > 0) promotedLong.push(symbol);
      else demotedLong.push(symbol);
    }
    if (row.shortN >= minLegSamples) {
      if (row.shortSum / row.shortN > 0) promotedShort.push(symbol);
      else demotedShort.push(symbol);
    }
  }

  const longAllowRaw = new Set<string>([...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST]);
  for (const s of demotedLong) longAllowRaw.delete(s);
  const shortAllowRaw = new Set<string>([...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST]);
  for (const s of demotedShort) shortAllowRaw.delete(s);

  // Floor (2026-07-07 audit): demotion has no natural recovery path — a demoted symbol only
  // regains eligibility once NEW closed baskets remeasure it positive, but no new baskets can
  // form once a side drops below the k legs a basket needs. That is a PERMANENT lockout, not a
  // temporary one: live's entire cross-sectional allocation silently stopped opening SHORT-side
  // baskets for ~18h this way (all 5 configured short symbols demoted, effective allowlist 0).
  // If demotions would leave a side under minEligiblePerSide, fall back to the full configured
  // allowlist for that side THIS CYCLE ONLY — next cycle recomputes fresh from the same
  // closed-basket history, so a symbol gets a genuine chance to prove out again instead of
  // staying locked out forever with nothing left to remeasure it.
  const longFloorApplied = longAllowRaw.size < minEligiblePerSideLong;
  const shortFloorApplied = shortAllowRaw.size < minEligiblePerSideShort;
  const longAllow = longFloorApplied ? new Set(CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST) : longAllowRaw;
  const shortAllow = shortFloorApplied ? new Set(CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST) : shortAllowRaw;
  const shortBlock = new Set<string>([
    ...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
    ...(shortFloorApplied ? [] : demotedShort),
  ]);
  const longBlock = new Set<string>(longFloorApplied ? [] : demotedLong);

  return {
    longAllowlist: [...longAllow].sort(),
    shortAllowlist: [...shortAllow].sort(),
    longBlocklist: [...longBlock].sort(),
    shortBlocklist: [...shortBlock].sort(),
    provenance: {
      closedBaskets,
      minLegSamples,
      promotedLong: promotedLong.sort(),
      promotedShort: promotedShort.sort(),
      demotedLong: demotedLong.sort(),
      demotedShort: demotedShort.sort(),
      minEligiblePerSide,
      minEligiblePerSideLong,
      minEligiblePerSideShort,
      longFloorApplied,
      shortFloorApplied,
    },
  };
}

export function buildFilteredCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_FILTERED_SIGNAL,
    variant: "FILTERED",
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
    maxPerCluster: opts.maxPerCluster ?? CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER,
  });
}

export function buildTrendCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap" | "selectionMode" | "strategyFamily"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "longBlocklist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  const longCapital = CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT;
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_TREND_SIGNAL,
    variant: "TREND_BETA_VOL",
    strategyFamily: "MOMENTUM_DISPERSION",
    selectionMode: "MOMENTUM",
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
    longBlocklist: opts.longBlocklist ?? CROSS_SECTIONAL_TREND_LONG_BLOCKLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_TREND_MIN_SCORE_GAP,
    longCapitalWeight: opts.longCapitalWeight ?? longCapital,
    shortCapitalWeight: opts.shortCapitalWeight ?? (1 - longCapital),
    weightingModel: opts.weightingModel ?? "BETA_VOL_PROXY",
    takeProfitReturn: opts.takeProfitReturn ?? CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: opts.stopLossReturn ?? CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    regimeFlipExit: opts.regimeFlipExit ?? true,
  });
}

export function buildMixedCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap" | "selectionMode" | "strategyFamily"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "longBlocklist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_MIXED_SIGNAL,
    variant: "MIXED_MEAN_REVERSION",
    strategyFamily: "MEAN_REVERSION",
    selectionMode: "MEAN_REVERSION",
    // Mixed/chop reverses extremes, but keeps the same side-specific toxicity guardrails.
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_TREND_LONG_ALLOWLIST,
    longBlocklist: opts.longBlocklist ?? CROSS_SECTIONAL_TREND_LONG_BLOCKLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
    longCapitalWeight: opts.longCapitalWeight ?? 0.5,
    shortCapitalWeight: opts.shortCapitalWeight ?? 0.5,
    weightingModel: opts.weightingModel ?? "BETA_VOL_PROXY",
    takeProfitReturn: opts.takeProfitReturn ?? CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: opts.stopLossReturn ?? CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    regimeFlipExit: opts.regimeFlipExit ?? true,
  });
}

export function realizedVolatility(candles: Candle[], bars = CROSS_SECTIONAL_MOMENTUM_BARS): number | null {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const closes = candles.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);
  const start = Math.max(1, closes.length - Math.max(2, bars));
  const returns: number[] = [];
  for (let i = start; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    const next = closes[i]!;
    returns.push((next - prev) / prev);
  }
  if (returns.length < 2) return null;
  const m = mean(returns);
  return Math.sqrt(mean(returns.map((r) => (r - m) ** 2)));
}

export function classifyCrossSectionalRegime(
  input?: Partial<CrossSectionalRegimeContext> | null,
): CrossSectionalRegimeClass {
  const mode = (input?.controllerMode ?? "").toUpperCase();
  const bias = (input?.directionalBias ?? "").toUpperCase();
  const regime = (input?.currentRegime ?? "").toLowerCase();
  if (mode === "LONG_ONLY" || bias === "LONG" || regime.includes("bullish")) return "TREND_LONG";
  if (mode === "SHORT_ONLY" || bias === "SHORT" || regime.includes("bearish")) return "TREND_SHORT";
  if (
    mode === "NO_TRADE_CHOP" ||
    mode === "VALIDATION_ONLY" ||
    mode === "BOTH_ALLOWED" ||
    regime.includes("mixed") ||
    regime.includes("chop") ||
    regime.includes("range") ||
    regime.includes("rotation") ||
    regime.includes("consolidation")
  ) {
    return "MIXED_CHOP";
  }
  return "UNKNOWN";
}

export function buildCrossSectionalRegimeContext(
  input?: Partial<CrossSectionalRegimeContext> | null,
): CrossSectionalRegimeContext {
  const base = {
    currentRegime: input?.currentRegime ?? null,
    controllerMode: input?.controllerMode ?? null,
    directionalBias: input?.directionalBias ?? null,
    confidence: input?.confidence ?? null,
    capturedAt: input?.capturedAt ?? null,
  };
  return { ...base, regimeClass: input?.regimeClass ?? classifyCrossSectionalRegime(base) };
}

/**
 * Resolve a basket given current prices. Legacy equal-notional baskets close at horizon; adaptive
 * baskets can close early on TP/SL or regime flip. Weighted baskets sum per-leg return contribution.
 * Missing prices past EXPIRY_MS mark the observation EXPIRED instead of leaving it stuck open.
 */
export function resolveCrossSectional(
  obs: CrossSectionalObservation,
  pricesBySymbol: Record<string, number>,
  now: string,
  roundtripBps: number,
  opts: { regimeContext?: CrossSectionalRegimeContext | null } = {},
): CrossSectionalObservation {
  if (obs.status !== "OPEN") return obs;
  const ageMs = new Date(now).getTime() - obs.openedAtMs;

  const all = [...obs.longLeg, ...obs.shortLeg];
  const price = (s: string): number | null => {
    const p = pricesBySymbol[s];
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  if (!all.every((l) => price(l.symbol) !== null)) {
    return ageMs > EXPIRY_MS ? { ...obs, status: "EXPIRED", exitReason: "EXPIRED", resolvedAt: now } : obs;
  }

  const longLeg = obs.longLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const shortLeg = obs.shortLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const longResolved = legReturnContribution(longLeg, "LONG");
  const shortResolved = legReturnContribution(shortLeg, "SHORT");
  const longLegReturn = longResolved.normalizedReturn;
  const shortLegReturn = shortResolved.normalizedReturn;
  const grossReturn = longResolved.contribution + shortResolved.contribution;
  const costReturn = roundtripBps / 10_000;
  const netReturn = grossReturn - costReturn;
  const takeProfit = obs.takeProfitReturn ?? null;
  const stopLoss = obs.stopLossReturn ?? null;
  const exitReason: CrossSectionalExitReason | null =
    takeProfit !== null && netReturn >= takeProfit ? "TAKE_PROFIT"
      : stopLoss !== null && netReturn <= -stopLoss ? "STOP_LOSS"
        : shouldCutForRegimeFlip(obs, opts.regimeContext) ? "REGIME_FLIP"
          : ageMs >= obs.horizonMs ? "HORIZON"
            : null;
  if (exitReason === null) return obs;
  return {
    ...obs,
    longLeg,
    shortLeg,
    status: "CLOSED",
    exitReason,
    grossReturn,
    costReturn,
    netReturn,
    longLegReturn,
    shortLegReturn,
    resolvedAt: now,
  };
}

// ─── store ───────────────────────────────────────────────────────────────────

interface CrossSectionalState {
  version: number;
  observations: CrossSectionalObservation[];
  lastCycleAt: string | null;
}

export class CrossSectionalStore {
  private readonly file: string;
  private state: CrossSectionalState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cross-sectional-edge.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this.load();
  }

  private load(): CrossSectionalState {
    for (const path of [this.file, `${this.file}.bak`]) {
      try {
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CrossSectionalState>;
        if (Array.isArray(parsed.observations)) {
          return { version: parsed.version ?? 1, observations: parsed.observations, lastCycleAt: parsed.lastCycleAt ?? null };
        }
      } catch {
        // fall through to the next candidate / empty
      }
    }
    return { version: 1, observations: [], lastCycleAt: null };
  }

  get all(): CrossSectionalObservation[] {
    return this.state.observations;
  }

  get lastCycleAt(): string | null {
    return this.state.lastCycleAt;
  }

  markCycle(ts: string): void {
    this.state.lastCycleAt = ts;
  }

  add(obs: CrossSectionalObservation): void {
    this.state.observations.push(obs);
  }

  replace(observationId: string, next: CrossSectionalObservation): void {
    const idx = this.state.observations.findIndex((o) => o.observationId === observationId);
    if (idx >= 0) this.state.observations[idx] = next;
  }

  private prune(): void {
    if (this.state.observations.length <= CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS) return;
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, Math.max(0, CROSS_SECTIONAL_MAX_STORED_OBSERVATIONS - open.length));
    this.state.observations = [...open, ...settled];
  }

  save(): void {
    try {
      this.prune();
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          // best-effort backup
        }
      }
      renameSync(tmp, this.file);
    } catch {
      // report-only persistence failures must never affect the app
    }
  }
}

let singleton: CrossSectionalStore | null = null;
export function getCrossSectionalStore(dataDir = "data"): CrossSectionalStore {
  if (!singleton) singleton = new CrossSectionalStore(dataDir);
  return singleton;
}
export function _resetCrossSectionalStoreForTests(): void {
  singleton = null;
}

// ─── cycle ─────────────────────────────────────────────────────────────────

export interface CrossSectionalCycleResult {
  opened: number;
  openedRaw?: number;
  openedFiltered?: number;
  openedTrend?: number;
  openedMixed?: number;
  resolved: number;
  expired: number;
}

/**
 * One measurement cycle: fetch the universe once, resolve matured open baskets against the latest
 * closes, then open at most one new basket per interval bucket. Pure data accrual — report-only.
 */
export async function runCrossSectionalCycle(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  regimeContext?: CrossSectionalRegimeContext | null;
  /** Current regime-axis score (regime-axis-timeline.ts's current.score), used ONLY when
   *  CROSS_SECTIONAL_REGIME_SKEW_ENABLED=1 to tilt the FILTERED (executed) basket's leg counts
   *  toward the regime-favored side. Omit/null -> unskewed 3/3-style symmetry, same as before. */
  axisScore?: number | null;
}): Promise<CrossSectionalCycleResult> {
  const result: CrossSectionalCycleResult = { opened: 0, resolved: 0, expired: 0 };
  const nowIso = new Date(opts.now).toISOString();
  const regimeContext = opts.regimeContext ? buildCrossSectionalRegimeContext(opts.regimeContext) : null;

  const candlesBySymbol: Record<string, Candle[]> = {};
  await Promise.allSettled(
    opts.universe.map(async (s) => {
      try {
        candlesBySymbol[s] = await opts.fetchCandles(s);
      } catch {
        // a missing symbol just drops out of this cycle
      }
    }),
  );

  const pricesBySymbol: Record<string, number> = {};
  const volBySymbol: Record<string, number> = {};
  const scored: ScoredSymbol[] = [];
  for (const symbol of opts.universe) {
    const candles = candlesBySymbol[symbol];
    if (!candles?.length) continue;
    const last = candles[candles.length - 1]!;
    if (last.close > 0) pricesBySymbol[symbol] = last.close;
    const vol = realizedVolatility(candles);
    if (vol !== null && vol > 0) volBySymbol[symbol] = vol;
    const sc = crossSectionalMomentumScore(candles, CROSS_SECTIONAL_MOMENTUM_BARS);
    if (sc) scored.push({ symbol, score: sc.score, price: sc.price });
  }

  // 1. resolve matured open baskets against the latest closes
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const next = resolveCrossSectional(obs, pricesBySymbol, nowIso, CROSS_SECTIONAL_ROUNDTRIP_BPS, { regimeContext });
    if (next.status !== obs.status) {
      opts.store.replace(obs.observationId, next);
      if (next.status === "CLOSED") result.resolved += 1;
      else if (next.status === "EXPIRED") result.expired += 1;
    }
  }

  // 2. open at most ONE new basket per interval bucket (the 7-min ticker fires faster than the bars)
  const bucket = Math.floor(opts.now / BAR_MS);
  const alreadyThisBucket = (signal: string) => opts.store.all.some((o) => o.signal === signal && Math.floor(o.openedAtMs / BAR_MS) === bucket);
  const rawSignal = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`;
  if (!alreadyThisBucket(rawSignal)) {
    const basket = buildCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      signal: rawSignal,
      variant: "RAW",
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      regimeContext,
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedRaw = (result.openedRaw ?? 0) + 1;
    }
  }
  if (!isCrossSectionalFilteredDisabled() && !alreadyThisBucket(CROSS_SECTIONAL_FILTERED_SIGNAL)) {
    // Auto-updating lists: derived from the store's own measured per-leg performance
    // (env lists as the prior) — recomputed every cycle, never a frozen env var.
    // 2026-07-11: skew must be computed BEFORE deriveAdaptiveSymbolFilters, and threaded into its
    // per-side floor — the floor previously always checked the unskewed base K on both sides, so a
    // regime-skewed shortK (e.g. 3->4) could silently starve the short side one leg short of what
    // buildFilteredCrossSectionalBasket actually requires, with the floor never noticing (3
    // eligible symbols isn't "under 3", but it IS under a skewed requirement of 4).
    const skew = isCrossSectionalRegimeSkewEnabled() ? regimeSkewedK(CROSS_SECTIONAL_K, opts.axisScore ?? null) : null;
    const adaptive = deriveAdaptiveSymbolFilters(opts.store, {
      minEligiblePerSideLong: skew?.longK,
      minEligiblePerSideShort: skew?.shortK,
    });
    const basket = buildFilteredCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      longK: skew?.longK,
      shortK: skew?.shortK,
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      regimeContext,
      longAllowlist: new Set(adaptive.longAllowlist),
      shortAllowlist: new Set(adaptive.shortAllowlist),
      shortBlocklist: new Set(adaptive.shortBlocklist),
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedFiltered = (result.openedFiltered ?? 0) + 1;
    }
  }
  if (!isCrossSectionalAdaptiveDisabled() && regimeContext?.regimeClass && regimeContext.regimeClass !== "UNKNOWN") {
    if (
      (regimeContext.regimeClass === "TREND_LONG" || regimeContext.regimeClass === "TREND_SHORT") &&
      !alreadyThisBucket(CROSS_SECTIONAL_TREND_SIGNAL)
    ) {
      const basket = buildTrendCrossSectionalBasket(scored, {
        k: CROSS_SECTIONAL_K,
        now: nowIso,
        openedAtMs: opts.now,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        regimeContext,
        volBySymbol,
      });
      if (basket) {
        opts.store.add(basket);
        result.opened += 1;
        result.openedTrend = (result.openedTrend ?? 0) + 1;
      }
    }
    if (regimeContext.regimeClass === "MIXED_CHOP" && !alreadyThisBucket(CROSS_SECTIONAL_MIXED_SIGNAL)) {
      const basket = buildMixedCrossSectionalBasket(scored, {
        k: CROSS_SECTIONAL_K,
        now: nowIso,
        openedAtMs: opts.now,
        horizonMs: CROSS_SECTIONAL_HORIZON_MS,
        regimeContext,
        volBySymbol,
      });
      if (basket) {
        opts.store.add(basket);
        result.opened += 1;
        result.openedMixed = (result.openedMixed ?? 0) + 1;
      }
    }
  }

  opts.store.markCycle(nowIso);
  opts.store.save();
  return result;
}

let cycleRunning = false;
/** Overlap-guarded wrapper so the 7-min ticker can't stack two cycles on the singleton store. */
export async function runCrossSectionalCycleGuarded(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  regimeContext?: CrossSectionalRegimeContext | null;
  axisScore?: number | null;
}): Promise<CrossSectionalCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    return await runCrossSectionalCycle(opts);
  } finally {
    cycleRunning = false;
  }
}

// ─── report ────────────────────────────────────────────────────────────────

export interface CrossSectionalReport {
  signal: string;
  variant: CrossSectionalVariant;
  horizonBars: number;
  k: number;
  open: number;
  closed: number;
  expired: number;
  netAvgReturn: number;
  grossAvgReturn: number;
  winRate: number;
  totalNetReturn: number;
  sharpeLike: number | null; // mean/stdev of net returns (per-basket), not annualized
  longLegAvgReturn: number;
  shortLegAvgReturn: number;
  lastCycleAt: string | null;
  /** ms until the OLDEST open basket reaches its horizon (when the first "closed" appears). null if none open. */
  nextResolveInMs: number | null;
  /** the net returns of recent closed baskets, for a distribution sparkline. */
  recentNetReturns: number[];
  targetGrossReturn: number;
  edgeReady: boolean;
  byRegime: Array<{
    regimeClass: CrossSectionalRegimeClass;
    closed: number;
    netAvgReturn: number;
    grossAvgReturn: number;
    winRate: number;
  }>;
  exits: Array<{
    reason: CrossSectionalExitReason | "UNKNOWN";
    closed: number;
    netAvgReturn: number;
    winRate: number;
  }>;
}

function observationVariant(o: Pick<CrossSectionalObservation, "variant" | "signal">): CrossSectionalVariant {
  if (o.variant === "MIXED_MEAN_REVERSION" || o.signal === CROSS_SECTIONAL_MIXED_SIGNAL) return "MIXED_MEAN_REVERSION";
  if (o.variant === "TREND_BETA_VOL" || o.signal === CROSS_SECTIONAL_TREND_SIGNAL) return "TREND_BETA_VOL";
  return o.variant === "FILTERED" || o.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW";
}

function reportSignalFor(variant: CrossSectionalVariant): string {
  if (variant === "FILTERED") return CROSS_SECTIONAL_FILTERED_SIGNAL;
  if (variant === "TREND_BETA_VOL") return CROSS_SECTIONAL_TREND_SIGNAL;
  if (variant === "MIXED_MEAN_REVERSION") return CROSS_SECTIONAL_MIXED_SIGNAL;
  return `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`;
}

function targetGrossFor(variant: CrossSectionalVariant): number {
  if (variant === "RAW") return CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
  if (variant === "FILTERED") return CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS / 10_000;
  return CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS / 10_000;
}

function groupStats<T extends string>(
  closed: CrossSectionalObservation[],
  key: (obs: CrossSectionalObservation) => T,
): Array<{ key: T; closed: number; netAvgReturn: number; grossAvgReturn: number; winRate: number }> {
  const map = new Map<T, CrossSectionalObservation[]>();
  for (const obs of closed) {
    const k = key(obs);
    map.set(k, [...(map.get(k) ?? []), obs]);
  }
  return [...map.entries()].map(([k, rows]) => {
    const nets = rows.map((o) => o.netReturn ?? 0);
    const gross = rows.map((o) => o.grossReturn ?? 0);
    return {
      key: k,
      closed: rows.length,
      netAvgReturn: mean(nets),
      grossAvgReturn: mean(gross),
      winRate: rows.length ? rows.filter((o) => (o.netReturn ?? 0) > 0).length / rows.length : 0,
    };
  });
}

export function buildCrossSectionalReport(
  store: CrossSectionalStore,
  nowMs: number = Date.now(),
  opts: { variant?: CrossSectionalVariant; signal?: string } = {},
): CrossSectionalReport {
  const variant = opts.variant ?? (opts.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW");
  const all = store.all.filter((o) => opts.signal ? o.signal === opts.signal : observationVariant(o) === variant);
  const closed = all.filter((o) => o.status === "CLOSED" && o.netReturn !== null);
  const nets = closed.map((o) => o.netReturn!);
  const gross = closed.map((o) => o.grossReturn ?? 0);
  const m = mean(nets);
  const sd = nets.length > 1 ? Math.sqrt(mean(nets.map((x) => (x - m) ** 2))) : 0;
  const grossAvg = mean(gross);
  const targetGrossReturn = targetGrossFor(variant);
  const openRemaining = all
    .filter((o) => o.status === "OPEN")
    .map((o) => Math.max(0, o.openedAtMs + o.horizonMs - nowMs));
  const byRegime = groupStats(closed, (o) => o.regimeClassAtOpen ?? o.regimeContext?.regimeClass ?? "UNKNOWN")
    .map((r) => ({ regimeClass: r.key, closed: r.closed, netAvgReturn: r.netAvgReturn, grossAvgReturn: r.grossAvgReturn, winRate: r.winRate }));
  const exits = groupStats(closed, (o) => o.exitReason ?? "UNKNOWN")
    .map((r) => ({ reason: r.key, closed: r.closed, netAvgReturn: r.netAvgReturn, winRate: r.winRate }));
  return {
    lastCycleAt: store.lastCycleAt,
    nextResolveInMs: openRemaining.length ? Math.min(...openRemaining) : null,
    recentNetReturns: nets.slice(-30),
    signal: opts.signal ?? reportSignalFor(variant),
    variant,
    horizonBars: CROSS_SECTIONAL_HORIZON_BARS,
    k: CROSS_SECTIONAL_K,
    open: all.filter((o) => o.status === "OPEN").length,
    closed: closed.length,
    expired: all.filter((o) => o.status === "EXPIRED").length,
    netAvgReturn: m,
    grossAvgReturn: grossAvg,
    winRate: closed.length ? closed.filter((o) => o.netReturn! > 0).length / closed.length : 0,
    totalNetReturn: nets.reduce((a, b) => a + b, 0),
    sharpeLike: sd > 0 ? m / sd : null,
    longLegAvgReturn: mean(closed.map((o) => o.longLegReturn ?? 0)),
    shortLegAvgReturn: mean(closed.map((o) => o.shortLegReturn ?? 0)),
    targetGrossReturn,
    edgeReady: closed.length >= 20 && grossAvg >= targetGrossReturn && m > 0,
    byRegime,
    exits,
  };
}

export function isCrossSectionalEdgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EDGE_DISABLED === "1";
}

export function isCrossSectionalFilteredDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_FILTERED_DISABLED === "1";
}

export function isCrossSectionalAdaptiveDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_ADAPTIVE_DISABLED === "1";
}

export function getCrossSectionalFilteredConfig(): {
  signal: string;
  minScoreGap: number;
  targetGrossReturn: number;
  longAllowlist: string[];
  shortAllowlist: string[];
  shortBlocklist: string[];
} {
  return {
    signal: CROSS_SECTIONAL_FILTERED_SIGNAL,
    minScoreGap: CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
    targetGrossReturn: CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS / 10_000,
    longAllowlist: [...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].sort(),
    shortAllowlist: [...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST].sort(),
    shortBlocklist: [...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST].sort(),
  };
}

export function getCrossSectionalAdaptiveConfig(): {
  trendSignal: string;
  mixedSignal: string;
  targetGrossReturn: number;
  trendMinScoreGap: number;
  mixedMinScoreGap: number;
  takeProfitReturn: number;
  stopLossReturn: number;
  trendLongCapitalWeight: number;
  trendShortCapitalWeight: number;
  trendLongAllowlist: string[];
  trendLongBlocklist: string[];
  trendShortAllowlist: string[];
  trendShortBlocklist: string[];
} {
  return {
    trendSignal: CROSS_SECTIONAL_TREND_SIGNAL,
    mixedSignal: CROSS_SECTIONAL_MIXED_SIGNAL,
    targetGrossReturn: CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS / 10_000,
    trendMinScoreGap: CROSS_SECTIONAL_TREND_MIN_SCORE_GAP,
    mixedMinScoreGap: CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP,
    takeProfitReturn: CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS / 10_000,
    stopLossReturn: CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000,
    trendLongCapitalWeight: CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT,
    trendShortCapitalWeight: 1 - CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT,
    trendLongAllowlist: [...CROSS_SECTIONAL_TREND_LONG_ALLOWLIST].sort(),
    trendLongBlocklist: [...CROSS_SECTIONAL_TREND_LONG_BLOCKLIST].sort(),
    trendShortAllowlist: [...CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST].sort(),
    trendShortBlocklist: [...CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST].sort(),
  };
}

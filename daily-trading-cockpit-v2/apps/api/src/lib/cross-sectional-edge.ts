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

function envNumPos(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

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
export const CROSS_SECTIONAL_HORIZON_BARS = envNumPos("CROSS_SECTIONAL_HORIZON_BARS", 24); // forward hold (bars)
export const CROSS_SECTIONAL_ROUNDTRIP_BPS = Number(process.env.CROSS_SECTIONAL_ROUNDTRIP_BPS ?? 12); // per-position round-trip cost
export const CROSS_SECTIONAL_FILTERED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_FILTERED`;
export const CROSS_SECTIONAL_TREND_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_TREND_BETA_VOL`;
export const CROSS_SECTIONAL_MIXED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_MIXED_MR`;
export const CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP", 0.02); // 24h momentum spread floor
export const CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS", 25); // proof target
export const CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_ADAPTIVE_MIN_GROSS_BPS", 35); // safer proof target
export const CROSS_SECTIONAL_TREND_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_TREND_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_MIXED_MIN_SCORE_GAP", 0.035);
export const CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_TAKE_PROFIT_BPS", 40);
export const CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS = envNumNonNeg("CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS", 30);
export const CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT = Math.min(0.9, Math.max(0.1, Number(process.env.CROSS_SECTIONAL_TREND_LONG_CAPITAL_WEIGHT ?? 0.35)));
export const CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST",
  "SOLUSDT,AVAXUSDT,ETHUSDT,SUIUSDT,ADAUSDT,BNBUSDT,RNDRUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST",
  "WLDUSDT,DOGEUSDT,PEPEUSDT,APTUSDT,OPUSDT,SEIUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST",
  "FETUSDT,INJUSDT,NEARUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_ALLOWLIST",
  "SOLUSDT,ETHUSDT,OPUSDT,PEPEUSDT",
);
export const CROSS_SECTIONAL_TREND_LONG_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_LONG_BLOCKLIST",
  "FETUSDT,INJUSDT,ARBUSDT,NEARUSDT,AVAXUSDT,BTCUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_ALLOWLIST",
  "WLDUSDT,SEIUSDT,DOGEUSDT,PEPEUSDT,APTUSDT,OPUSDT",
);
export const CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_TREND_SHORT_BLOCKLIST",
  "AVAXUSDT,INJUSDT,FETUSDT,NEARUSDT,RNDRUSDT",
);
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
  const longPool = valid.filter((s) => allowed(s.symbol, opts.longAllowlist, opts.longBlocklist));
  const longSorted = [...longPool].sort((a, b) => mode === "MEAN_REVERSION" ? a.score - b.score : b.score - a.score);
  const selectedLongs = longSorted.slice(0, opts.k);
  const longSymbols = new Set(selectedLongs.map((s) => s.symbol));
  const shortPool = valid.filter((s) => !longSymbols.has(s.symbol) && allowed(s.symbol, opts.shortAllowlist, opts.shortBlocklist));
  const shortSorted = [...shortPool].sort((a, b) => mode === "MEAN_REVERSION" ? b.score - a.score : a.score - b.score);
  const selectedShorts = shortSorted.slice(0, opts.k);
  if (selectedLongs.length < opts.k || selectedShorts.length < opts.k) return null;
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

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
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
    const basket = buildFilteredCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
      regimeContext,
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

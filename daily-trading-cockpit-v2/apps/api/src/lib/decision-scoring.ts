/**
 * Composite 0-100 decision score across graded dimensions, instead of every signal living or dying
 * on a single boolean hard-gate. A weak dimension degrades the score; it does not by itself kill a
 * candidate the way a hard gate does — a strong-enough score elsewhere can still clear the bar.
 *
 * IMPORTANT — this is an ADDITIVE diagnostic layer, not a replacement for existing hard rails. The
 * kill-switch, cluster cap, cost gate, crowding veto, and stop/TP geometry all keep operating exactly
 * as they do today; nothing here weakens or bypasses them. Per this session's measure-first discipline,
 * this score should be attached to candidates as a REPORT-ONLY enrichment first (log score alongside
 * the eventual outcome) so we can prove score correlates with realized edge BEFORE it ever gates a
 * live order. Pure functions; no execution, no network calls.
 *
 * Dimensions (mirrors the ChatGPT-blueprint weighting, adapted to signals Kronos already measures):
 *   Regime quality        0-30  (regime engine's detected mode + confidence, matched to direction)
 *   Setup/momentum quality 0-25  (breakout/momentum strength: volume surge, ROC, anti-chase extension)
 *   Order-flow quality     0-20  (taker buy/sell pressure aligned with the trade direction)
 *   Liquidity quality      0-15  (spread + expected slippage vs the operator's own limits)
 *   Derivatives context    0-10  (funding crowding + OI-change consistency with continuation)
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type TradeDirection = "LONG" | "SHORT";

// ── Regime quality (0-30) ────────────────────────────────────────────────────

export interface RegimeQualityInputs {
  /** The direction-controller's mode, e.g. "LONG_ONLY" | "SHORT_ONLY" | "BOTH_ALLOWED" | "VALIDATION_ONLY" | "NO_TRADE_CHOP" | other block modes. */
  controllerMode: string | null;
  confidence: "LOW" | "MEDIUM" | "HIGH" | string | null;
  direction: TradeDirection;
}

const REGIME_QUALITY_MAX = 30;

/** 0 whenever the regime engine does not support new entries in this direction at all (should also be hard-gated elsewhere). */
export function scoreRegimeQuality(inputs: RegimeQualityInputs): number {
  const mode = (inputs.controllerMode ?? "").toUpperCase();
  const matchesTrend = (inputs.direction === "LONG" && mode === "LONG_ONLY") || (inputs.direction === "SHORT" && mode === "SHORT_ONLY");
  const opposesTrend = (inputs.direction === "LONG" && mode === "SHORT_ONLY") || (inputs.direction === "SHORT" && mode === "LONG_ONLY");
  if (opposesTrend || mode === "NO_TRADE_CHOP" || mode === "" || mode === "UNKNOWN") return 0;

  const confidenceBonus = inputs.confidence === "HIGH" ? 10 : inputs.confidence === "MEDIUM" ? 5 : 0;
  if (matchesTrend) return clamp(20 + confidenceBonus, 0, REGIME_QUALITY_MAX);
  if (mode === "BOTH_ALLOWED" || mode === "VALIDATION_ONLY") return clamp(10 + confidenceBonus * 0.5, 0, REGIME_QUALITY_MAX);
  return 0;
}

// ── Setup / momentum quality (0-25) ─────────────────────────────────────────

export interface SetupQualityInputs {
  /** Bar volume ÷ its moving average. 1.0 = average, higher = surge. */
  volumeRatio: number;
  /** % rate of change over the entry lookback. Sign should already match the trade direction. */
  rocPercent: number;
  /** Distance of entry from the trend EMA, in ATR units. Higher = more vertically extended (chase risk). */
  atrExtension: number;
  /** ATR extension above this is treated as a full chase — score collapses toward 0 past it. */
  maxHealthyAtrExtension?: number;
}

const SETUP_QUALITY_MAX = 25;

export function scoreSetupQuality(inputs: SetupQualityInputs): number {
  // 2026-07-12 fix: these 3 fields aren't typed nullable, but nothing upstream actually guarantees
  // a finite number (e.g. a 0/0 division producing NaN) — clamp()'s Math.max/min silently propagate
  // NaN through every downstream computation instead of surfacing it, corrupting totalScore (and
  // whatever report persists it) rather than just scoring this dimension 0 like every other
  // "missing/bad data" case in this file already does (see scoreOrderFlowQuality below).
  if (!Number.isFinite(inputs.volumeRatio) || !Number.isFinite(inputs.rocPercent) || !Number.isFinite(inputs.atrExtension)) {
    return 0;
  }
  const maxExt = inputs.maxHealthyAtrExtension ?? 3;
  // Volume: 1x=0 credit, 1.5x=half credit, 3x+=full credit for this half of the dimension.
  const volumeScore = clamp(((inputs.volumeRatio - 1) / (3 - 1)) * (SETUP_QUALITY_MAX / 2), 0, SETUP_QUALITY_MAX / 2);
  // Momentum: 0%=0 credit, 5%+=full credit for the other half.
  const momentumScore = clamp((inputs.rocPercent / 5) * (SETUP_QUALITY_MAX / 2), 0, SETUP_QUALITY_MAX / 2);
  const raw = volumeScore + momentumScore;
  // Anti-chase penalty: linearly collapse the score as extension approaches/exceeds the healthy max.
  const extensionPenalty = clamp(inputs.atrExtension / maxExt, 0, 1);
  return clamp(raw * (1 - extensionPenalty), 0, SETUP_QUALITY_MAX);
}

// ── Order-flow quality (0-20) ────────────────────────────────────────────────

export interface OrderFlowQualityInputs {
  /** Fraction of taker volume that was BUY-initiated, in [0, 1]. null = no data (no confirmation credit). */
  takerBuyRatio: number | null;
  direction: TradeDirection;
}

const ORDER_FLOW_QUALITY_MAX = 20;

/** Reward taker flow aligned with the trade direction; missing data earns 0 (never assumed favorable). */
export function scoreOrderFlowQuality(inputs: OrderFlowQualityInputs): number {
  if (inputs.takerBuyRatio === null || !Number.isFinite(inputs.takerBuyRatio)) return 0;
  // Directional pressure in [-0.5, 0.5]: +0.5 = all-buy, -0.5 = all-sell, 0 = neutral.
  const pressure = inputs.takerBuyRatio - 0.5;
  const aligned = inputs.direction === "LONG" ? pressure : -pressure;
  return clamp((aligned / 0.5) * ORDER_FLOW_QUALITY_MAX, 0, ORDER_FLOW_QUALITY_MAX);
}

// ── Liquidity quality (0-15) ─────────────────────────────────────────────────

export interface LiquidityQualityInputs {
  spreadBps: number | null;
  expectedSlippageBps: number | null;
  maxSpreadBps: number;
  maxSlippageBps: number;
}

const LIQUIDITY_QUALITY_MAX = 15;

/** Full score near 0 cost, degrading linearly to 0 at the operator's own max-acceptable thresholds. */
export function scoreLiquidityQuality(inputs: LiquidityQualityInputs): number {
  // 2026-07-12 fix: `=== null` doesn't catch NaN (e.g. a spread/slippage computed as 0/0 upstream)
  // — matches the same NaN-slips-through-the-null-check pattern already guarded against in
  // scoreOrderFlowQuality above via Number.isFinite.
  if (
    inputs.spreadBps === null || !Number.isFinite(inputs.spreadBps) ||
    inputs.expectedSlippageBps === null || !Number.isFinite(inputs.expectedSlippageBps)
  ) {
    return 0;
  }
  if (!(inputs.maxSpreadBps > 0) || !(inputs.maxSlippageBps > 0)) return 0;
  const spreadHealth = clamp(1 - inputs.spreadBps / inputs.maxSpreadBps, 0, 1);
  const slippageHealth = clamp(1 - inputs.expectedSlippageBps / inputs.maxSlippageBps, 0, 1);
  return clamp(((spreadHealth + slippageHealth) / 2) * LIQUIDITY_QUALITY_MAX, 0, LIQUIDITY_QUALITY_MAX);
}

// ── Derivatives context (0-10) ───────────────────────────────────────────────

export interface DerivativesQualityInputs {
  /** Funding rate expressed as a z-score vs its own recent history. Extreme same-side funding = crowded. */
  fundingZScore: number | null;
  /** % change in open interest over the recent window. */
  openInterestChangePercent: number | null;
  direction: TradeDirection;
}

const DERIVATIVES_QUALITY_MAX = 10;

/**
 * Rewards: funding NOT extreme in the direction's favor (crowded longs paying high funding is a
 * warning, not a confirmation), and open interest RISING (fresh positioning, more durable) rather
 * than falling (short-covering / long-liquidation driven moves tend to be less durable).
 */
export function scoreDerivativesQuality(inputs: DerivativesQualityInputs): number {
  let score = DERIVATIVES_QUALITY_MAX / 2; // neutral baseline when data is present but unremarkable
  if (inputs.fundingZScore !== null && Number.isFinite(inputs.fundingZScore)) {
    // Funding crowded IN FAVOR of this direction (e.g. very positive funding on a LONG) is a caution.
    const crowdedSameSide = inputs.direction === "LONG" ? inputs.fundingZScore > 1.5 : inputs.fundingZScore < -1.5;
    score += crowdedSameSide ? -2 : 1;
  } else {
    score -= 1; // missing data: mild caution, not a free pass
  }
  if (inputs.openInterestChangePercent !== null && Number.isFinite(inputs.openInterestChangePercent)) {
    score += inputs.openInterestChangePercent > 0 ? 1.5 : -1.5;
  } else {
    score -= 1;
  }
  return clamp(score, 0, DERIVATIVES_QUALITY_MAX);
}

// ── Composite ────────────────────────────────────────────────────────────────

export interface DecisionScoreInputs {
  regime: RegimeQualityInputs;
  setup: SetupQualityInputs;
  orderFlow: OrderFlowQualityInputs;
  liquidity: LiquidityQualityInputs;
  derivatives: DerivativesQualityInputs;
}

export type DecisionScoreVerdict = "ENTER" | "WATCH" | "NO_TRADE";

export interface DecisionScoreResult {
  regimeScore: number;
  setupScore: number;
  orderFlowScore: number;
  liquidityScore: number;
  derivativesScore: number;
  totalScore: number; // 0-100
  verdict: DecisionScoreVerdict;
}

export interface DecisionScoreOptions {
  /** Total score at/above this = ENTER. Default 75 (mirrors the blueprint's suggested bar). */
  enterThreshold?: number;
  /** Total score at/above this (but below enterThreshold) = WATCH (log it, don't trade it). Default 50. */
  watchThreshold?: number;
}

export function computeDecisionScore(inputs: DecisionScoreInputs, opts: DecisionScoreOptions = {}): DecisionScoreResult {
  const enterThreshold = opts.enterThreshold ?? 75;
  const watchThreshold = opts.watchThreshold ?? 50;
  const regimeScore = scoreRegimeQuality(inputs.regime);
  const setupScore = scoreSetupQuality(inputs.setup);
  const orderFlowScore = scoreOrderFlowQuality(inputs.orderFlow);
  const liquidityScore = scoreLiquidityQuality(inputs.liquidity);
  const derivativesScore = scoreDerivativesQuality(inputs.derivatives);
  const totalScore = regimeScore + setupScore + orderFlowScore + liquidityScore + derivativesScore;
  const verdict: DecisionScoreVerdict = totalScore >= enterThreshold ? "ENTER" : totalScore >= watchThreshold ? "WATCH" : "NO_TRADE";
  return { regimeScore, setupScore, orderFlowScore, liquidityScore, derivativesScore, totalScore, verdict };
}

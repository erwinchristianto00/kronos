/**
 * Daily Range V3 execution economics.
 *
 * This module deliberately contains no exchange I/O or mutable process state.
 * A lane freezes one returned model for a UTC decision day, persists it, and
 * passes the immutable model plus a causal BBO snapshot into these pure
 * functions before it allocates a scarce slot.  That keeps selection, sizing,
 * and later accounting explainable without allowing a later quote or a future
 * fill to rewrite the original decision.
 */
import { createHash } from "node:crypto";

import type { FuturesSymbolFilters } from "./binance-futures-private.js";

export const DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID = "daily-range-execution-economics-v1";
export const DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID = "daily-range-economic-quality-baseline-v1";
export const DAILY_RANGE_ALPHA_SELECTOR_POLICY_ID = "daily-range-route-selector-v1";
/**
 * Trade geometry is independent from execution friction.  A wide structural
 * stop can look cheaper as a percentage of R while still implying a target
 * that is not a reasonable 4h move, so it gets its own immutable policy.
 */
export const DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID = "daily-trade-geometry-v1";
export const DAILY_RANGE_MAX_STRUCTURAL_STOP_PCT = 0.03;
export const DAILY_RANGE_MAX_TARGET_DISTANCE_PCT = 0.06;
export const DAILY_RANGE_MAX_TARGET_ATR4H_MULTIPLE = 2;
export const DAILY_RANGE_ATR4H_PERIOD = 14;
const FOUR_HOURS_MS = 4 * 60 * 60_000;

export const DAILY_RANGE_MAX_NOTIONAL_USD = 25;
export const DAILY_RANGE_MAX_PLANNED_RISK_USD = 0.25;
export const DAILY_RANGE_MAX_COST_RATIO = 0.25;
export const DAILY_RANGE_SAFE_FRICTION_MULTIPLIER = 1.25;
export const DAILY_RANGE_MIN_EMPIRICAL_FRICTION_SAMPLES = 12;
/**
 * A loss-path price sample is one terminal loss's non-overlapping sum:
 * entry adverse execution + explicitly measured market-exit adverse execution
 * (when present) + native stop trigger-to-fill gap. Its percentile is already
 * end-to-end for that loss path; entryAdverseP95 must not be added again.
 */
export const DAILY_RANGE_FRICTION_DEFINITION_VERSION = "daily-loss-friction-decomposition-v1";
export const DAILY_RANGE_SAFE_LOSS_FORMULA = "ENTRY_FEE_P95 + EXIT_FEE_P95 + 1.25 * LOSS_PATH_ALL_IN_ADVERSE_P95";

export type DailyRangeEconomicsSide = "LONG" | "SHORT";
export type DailyRangeFrictionModelSource = "EMPIRICAL_LEDGER" | "CONSERVATIVE_FALLBACK";
export type DailyRangeFeeEvidence = "EXACT_FILL_COMMISSION" | "LEGACY_COMBINED_FEE_ALLOCATION" | "CONFIGURED_CONSERVATIVE";
export type DailyRangeFrictionEnvironment = "testnet" | "mainnet";
export type DailyRangeGeometryRejectReason =
  | "STRUCTURAL_STOP_TOO_WIDE"
  | "TARGET_DISTANCE_TOO_WIDE"
  | "TARGET_REACHABILITY_FAIL"
  | "TARGET_REACHABILITY_DATA_UNAVAILABLE";

/** The causal 4h feature supplied by the lane before allocation. */
export interface DailyRangeAtr4hFeature {
  atr4h: number;
  /** ISO close boundary of the latest completed 4h candle used by ATR. */
  atrSourceLastClosedAt: string;
  /** Original decision timestamp; no candle closed after this may contribute. */
  atrFeatureTimestamp: string;
}

/** Immutable entry-time geometry snapshot, retained for admitted and rejected candidates. */
export interface DailyRangeTradeGeometry {
  geometryPolicyId: typeof DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID;
  maxStopPct: number;
  maxTargetPct: number;
  maxTargetAtrMultiple: number;
  stopDistancePct: number | null;
  tpDistancePct: number | null;
  atr4h: number | null;
  atr4hPct: number | null;
  atrSourceLastClosedAt: string | null;
  atrFeatureTimestamp: string | null;
  targetAtrMultiple: number | null;
  geometryPass: boolean;
  geometryRejectReason: DailyRangeGeometryRejectReason | null;
}

export interface DailyRangeAtr4hCandle {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
}

export interface DailyRangeFrictionSample {
  tradeId: string;
  closedAt: string;
  entryFeeBps: number | null;
  exitFeeBps: number | null;
  entryAdverseBps: number | null;
  takeProfitExitAdverseBps: number | null;
  stopExitAdverseBps: number | null;
  stopGapBps: number | null;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "OTHER";
  feeEvidence: DailyRangeFeeEvidence;
  /**
   * Exact exchange fill count only when the terminal trade persisted its
   * per-order user-fill ledger. Legacy combined-fee rows leave this null
   * rather than inventing a count.
   */
  sourceFillCount?: number | null;
}

export interface DailyRangeFrictionModel {
  id: string;
  policyId: typeof DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID;
  definitionVersion: typeof DAILY_RANGE_FRICTION_DEFINITION_VERSION;
  safeLossFormula: typeof DAILY_RANGE_SAFE_LOSS_FORMULA;
  /** Environment provenance is part of the immutable artifact hash. */
  environment: DailyRangeFrictionEnvironment;
  source: DailyRangeFrictionModelSource;
  createdAt: string;
  cutoffAt: string;
  /** Alias retained explicitly for research/artifact manifests. */
  trainingCutoff: string;
  sampleCount: number;
  /** Terminal trade rows used to build this artifact. */
  sourceTradeCount: number;
  /** Exact exchange user fills represented by rows that persisted a count. */
  sourceFillCount: number;
  /** Number of source trades for which sourceFillCount is known. */
  sourceFillCountKnownTradeCount: number;
  /** SHA-256 over the canonical, cutoff-bounded source sample rows. */
  sourceSampleHash: string;
  exactFeeSampleCount: number;
  legacyFeeSampleCount: number;
  /** Median, observed/admitted entry adverse execution cost. */
  entryAdverseP50Bps: number;
  entryAdverseP95Bps: number;
  takeProfitExitAdverseP50Bps: number;
  takeProfitExitAdverseP95Bps: number;
  stopExitAdverseP50Bps: number;
  stopExitAdverseP95Bps: number;
  stopGapP50Bps: number;
  stopGapP95Bps: number;
  entryFeeP50Bps: number;
  entryFeeP95Bps: number;
  exitFeeP50Bps: number;
  exitFeeP95Bps: number;
  /** Empirical all-in adverse price friction, separated by terminal path. */
  winAdverseP50Bps: number;
  /**
   * Pointwise terminal-loss total. It already includes entry adverse execution,
   * any independently observed lane-originated market exit adverse execution,
   * and the native stop trigger-to-fill gap for the same loss row.
   */
  lossAdverseP50Bps: number;
  lossAdverseP95Bps: number;
  hash: string;
}

export interface DailyRangeEconomicsBbo {
  bid: number;
  ask: number;
  observedAt: string;
  sourceTime: number | null;
  receivedAt: string;
}

export interface DailyRangePreTradeEconomics {
  economicsPolicyId: typeof DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID;
  allocatorPolicyId: typeof DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID;
  frictionModelId: string;
  frictionModelSource: DailyRangeFrictionModelSource;
  frictionModelCutoffAt: string;
  decisionBid: number;
  decisionAsk: number;
  decisionSpreadBps: number;
  bboObservedAt: string;
  bboReceivedAt: string;
  bboSourceTime: number | null;
  expectedEntryPrice: number;
  expectedStopPrice: number;
  expectedTakeProfitPrice: number;
  rawStructuralStop: number;
  stopRiskPrice: number;
  stopRiskBps: number;
  requestedQty: number;
  plannedNotionalUsd: number;
  plannedRiskUsd: number;
  entryFeeBps: number;
  exitFeeBps: number;
  medianWinFrictionBps: number;
  medianLossFrictionBps: number;
  safeLossEntryFeeComponentBps: number;
  safeLossExitFeeComponentBps: number;
  safeLossPathAdverseComponentBps: number;
  safeLossDefinitionVersion: typeof DAILY_RANGE_FRICTION_DEFINITION_VERSION;
  safeLossFrictionBps: number;
  costRatio: number;
  netWinR: number;
  netLossR: number;
  breakEvenWinRate: number;
  qualityTieBreakHash: string;
  /** Frozen before allocation; never recomputed from a later quote or candle. */
  geometry: DailyRangeTradeGeometry;
}

export type DailyRangeEconomicsPreparation =
  | { ok: true; economics: DailyRangePreTradeEconomics }
  | {
    ok: false;
    reason:
      | "BBO_STALE"
      | "FRICTION_MODEL_UNAVAILABLE"
      | "STOP_ECONOMICS_FAIL"
      | "RISK_BUDGET_UNEXECUTABLE"
      | DailyRangeGeometryRejectReason;
    /** Present only after the execution-economics gate has passed. */
    geometry?: DailyRangeTradeGeometry | null;
  };

export interface DailyRangeActualFillEconomics {
  actualStopRiskPrice: number;
  actualStopRiskBps: number;
  actualInitialRiskUsd: number;
  actualCostRatio: number;
  violation: "POST_FILL_ECONOMICS_FAIL" | "POST_FILL_RISK_FAIL" | null;
  materialViolation: boolean;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function geometryBase(input: {
  expectedEntryPrice: number;
  expectedStopPrice: number;
  expectedTakeProfitPrice: number;
  atr4hFeature: DailyRangeAtr4hFeature | null;
}): Omit<DailyRangeTradeGeometry, "geometryPass" | "geometryRejectReason"> {
  const entry = input.expectedEntryPrice;
  const stopDistancePct = finitePositive(entry) && finite(input.expectedStopPrice)
    ? Math.abs(entry - input.expectedStopPrice) / entry
    : null;
  const tpDistancePct = finitePositive(entry) && finite(input.expectedTakeProfitPrice)
    ? Math.abs(input.expectedTakeProfitPrice - entry) / entry
    : null;
  const atr4h = finitePositive(input.atr4hFeature?.atr4h) ? input.atr4hFeature!.atr4h : null;
  const atr4hPct = atr4h !== null && finitePositive(entry) ? atr4h / entry : null;
  const targetAtrMultiple = tpDistancePct !== null && atr4hPct !== null && atr4hPct > 0
    ? tpDistancePct / atr4hPct
    : null;
  return {
    geometryPolicyId: DAILY_RANGE_TRADE_GEOMETRY_POLICY_ID,
    maxStopPct: DAILY_RANGE_MAX_STRUCTURAL_STOP_PCT,
    maxTargetPct: DAILY_RANGE_MAX_TARGET_DISTANCE_PCT,
    maxTargetAtrMultiple: DAILY_RANGE_MAX_TARGET_ATR4H_MULTIPLE,
    stopDistancePct,
    tpDistancePct,
    atr4h,
    atr4hPct,
    atrSourceLastClosedAt: input.atr4hFeature?.atrSourceLastClosedAt ?? null,
    atrFeatureTimestamp: input.atr4hFeature?.atrFeatureTimestamp ?? null,
    targetAtrMultiple,
  };
}

/**
 * Evaluate an already-formed structural stop and exact 2R target.  This does
 * not move either level: a bad geometry is rejected, never repaired by a
 * discretionary clamp.
 */
export function evaluateDailyRangeTradeGeometry(input: {
  expectedEntryPrice: number;
  expectedStopPrice: number;
  expectedTakeProfitPrice: number;
  atr4hFeature: DailyRangeAtr4hFeature | null;
}): DailyRangeTradeGeometry {
  const base = geometryBase(input);
  if (base.stopDistancePct === null || base.stopDistancePct > DAILY_RANGE_MAX_STRUCTURAL_STOP_PCT + 1e-12) {
    return { ...base, geometryPass: false, geometryRejectReason: "STRUCTURAL_STOP_TOO_WIDE" };
  }
  if (base.tpDistancePct === null || base.tpDistancePct > DAILY_RANGE_MAX_TARGET_DISTANCE_PCT + 1e-12) {
    return { ...base, geometryPass: false, geometryRejectReason: "TARGET_DISTANCE_TOO_WIDE" };
  }
  if (base.atr4h === null || base.atr4hPct === null || base.targetAtrMultiple === null) {
    return { ...base, geometryPass: false, geometryRejectReason: "TARGET_REACHABILITY_DATA_UNAVAILABLE" };
  }
  if (base.targetAtrMultiple > DAILY_RANGE_MAX_TARGET_ATR4H_MULTIPLE + 1e-12) {
    return { ...base, geometryPass: false, geometryRejectReason: "TARGET_REACHABILITY_FAIL" };
  }
  return { ...base, geometryPass: true, geometryRejectReason: null };
}

/**
 * Build a strictly causal Wilder ATR(14) from completed UTC-anchored 4h bars.
 * The latest source bar must have closed before the decision, and every bar in
 * the retained tail must be continuous.  A partial/gapped history returns
 * null; callers must fail closed for a fresh entry rather than interpolate it.
 */
export function calculateCausalAtr14(input: {
  candles: readonly DailyRangeAtr4hCandle[];
  decisionAtMs: number;
}): DailyRangeAtr4hFeature | null {
  if (!Number.isFinite(input.decisionAtMs) || input.decisionAtMs <= 0) return null;
  const expectedLastOpen = Math.floor((input.decisionAtMs - 1) / FOUR_HOURS_MS) * FOUR_HOURS_MS - FOUR_HOURS_MS;
  if (expectedLastOpen < 0) return null;
  const byOpen = new Map<number, DailyRangeAtr4hCandle>();
  for (const candle of input.candles) {
    if (!Number.isFinite(candle.openTime) || !Number.isFinite(candle.closeTime)
      || !finitePositive(candle.high) || !finitePositive(candle.low) || !finitePositive(candle.close)
      || candle.high < candle.low || candle.closeTime >= input.decisionAtMs
      || candle.closeTime !== candle.openTime + FOUR_HOURS_MS - 1) continue;
    byOpen.set(candle.openTime, candle);
  }
  const tail: DailyRangeAtr4hCandle[] = [];
  for (let openTime = expectedLastOpen; openTime >= 0; openTime -= FOUR_HOURS_MS) {
    const candle = byOpen.get(openTime);
    if (!candle) break;
    tail.unshift(candle);
  }
  if (tail.length < DAILY_RANGE_ATR4H_PERIOD + 1) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < tail.length; index++) {
    const candle = tail[index]!;
    const previousClose = tail[index - 1]!.close;
    trueRanges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    ));
  }
  if (trueRanges.length < DAILY_RANGE_ATR4H_PERIOD || trueRanges.some((value) => !finitePositive(value))) return null;
  let atr = trueRanges.slice(0, DAILY_RANGE_ATR4H_PERIOD).reduce((sum, value) => sum + value, 0) / DAILY_RANGE_ATR4H_PERIOD;
  for (let index = DAILY_RANGE_ATR4H_PERIOD; index < trueRanges.length; index++) {
    atr = ((atr * (DAILY_RANGE_ATR4H_PERIOD - 1)) + trueRanges[index]!) / DAILY_RANGE_ATR4H_PERIOD;
  }
  if (!finitePositive(atr)) return null;
  const last = tail.at(-1)!;
  return {
    atr4h: atr,
    atrSourceLastClosedAt: new Date(last.closeTime + 1).toISOString(),
    atrFeatureTimestamp: new Date(input.decisionAtMs).toISOString(),
  };
}

function nonNegative(value: number | null | undefined): number | null {
  return finite(value) && value >= 0 ? value : null;
}

function cleanValues(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((value): value is number => finite(value) && value >= 0).sort((left, right) => left - right);
}

export function percentile(values: readonly (number | null | undefined)[], p: number, fallback: number): number {
  const clean = cleanValues(values);
  if (clean.length === 0) return fallback;
  const clamped = Math.max(0, Math.min(1, p));
  const index = (clean.length - 1) * clamped;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return clean[low]!;
  return clean[low]! + (clean[high]! - clean[low]!) * (index - low);
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function modelHash(input: Omit<DailyRangeFrictionModel, "id" | "hash">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function modelId(createdAt: string, hash: string): string {
  return `daily-friction-v1-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${hash.slice(0, 12)}`;
}

function sourceSampleHash(samples: readonly DailyRangeFrictionSample[]): string {
  const canonical = [...samples]
    .map((sample) => ({
      tradeId: sample.tradeId,
      closedAt: sample.closedAt,
      entryFeeBps: nonNegative(sample.entryFeeBps),
      exitFeeBps: nonNegative(sample.exitFeeBps),
      entryAdverseBps: nonNegative(sample.entryAdverseBps),
      takeProfitExitAdverseBps: nonNegative(sample.takeProfitExitAdverseBps),
      stopExitAdverseBps: nonNegative(sample.stopExitAdverseBps),
      stopGapBps: nonNegative(sample.stopGapBps),
      exitReason: sample.exitReason,
      feeEvidence: sample.feeEvidence,
      sourceFillCount: nonNegative(sample.sourceFillCount),
    }))
    .sort((left, right) => left.closedAt.localeCompare(right.closedAt) || left.tradeId.localeCompare(right.tradeId));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function baseModel(input: {
  environment: DailyRangeFrictionEnvironment;
  source: DailyRangeFrictionModelSource;
  createdAt: string;
  cutoffAt: string;
  sampleCount: number;
  sourceTradeCount: number;
  sourceFillCount: number;
  sourceFillCountKnownTradeCount: number;
  sourceSampleHash: string;
  exactFeeSampleCount: number;
  legacyFeeSampleCount: number;
  entryAdverseP50Bps: number;
  entryAdverseP95Bps: number;
  takeProfitExitAdverseP50Bps: number;
  takeProfitExitAdverseP95Bps: number;
  stopExitAdverseP50Bps: number;
  stopExitAdverseP95Bps: number;
  stopGapP50Bps: number;
  stopGapP95Bps: number;
  entryFeeP50Bps: number;
  entryFeeP95Bps: number;
  exitFeeP50Bps: number;
  exitFeeP95Bps: number;
  winAdverseP50Bps: number;
  lossAdverseP50Bps: number;
  lossAdverseP95Bps: number;
}): DailyRangeFrictionModel {
  const canonical: Omit<DailyRangeFrictionModel, "id" | "hash"> = {
    policyId: DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID,
    definitionVersion: DAILY_RANGE_FRICTION_DEFINITION_VERSION,
    safeLossFormula: DAILY_RANGE_SAFE_LOSS_FORMULA,
    trainingCutoff: input.cutoffAt,
    ...input,
  };
  const hash = modelHash(canonical);
  return { id: modelId(input.createdAt, hash), ...canonical, hash };
}

/**
 * Testnet's fallback is intentionally non-zero and conservative.  It is a
 * safety observation baseline, not an implicit substitute for a Live model.
 */
export function conservativeFallbackFrictionModel(
  createdAt: string,
  cutoffAt = createdAt,
  environment: DailyRangeFrictionEnvironment = "testnet",
): DailyRangeFrictionModel {
  return baseModel({
    environment,
    source: "CONSERVATIVE_FALLBACK",
    createdAt,
    cutoffAt,
    sampleCount: 0,
    sourceTradeCount: 0,
    sourceFillCount: 0,
    sourceFillCountKnownTradeCount: 0,
    sourceSampleHash: sourceSampleHash([]),
    exactFeeSampleCount: 0,
    legacyFeeSampleCount: 0,
    entryAdverseP50Bps: 1.5,
    entryAdverseP95Bps: 4,
    takeProfitExitAdverseP50Bps: 1.5,
    takeProfitExitAdverseP95Bps: 4,
    stopExitAdverseP50Bps: 3,
    stopExitAdverseP95Bps: 8,
    stopGapP50Bps: 2,
    stopGapP95Bps: 8,
    entryFeeP50Bps: 4,
    entryFeeP95Bps: 4,
    exitFeeP50Bps: 4,
    exitFeeP95Bps: 4,
    winAdverseP50Bps: 3,
    lossAdverseP50Bps: 8,
    lossAdverseP95Bps: 20,
  });
}

/** Build one immutable model from terminal fills known before its cutoff. */
export function buildEmpiricalFrictionModel(input: {
  samples: readonly DailyRangeFrictionSample[];
  createdAt: string;
  cutoffAt: string;
  environment: DailyRangeFrictionEnvironment;
  minimumSamples?: number;
}): DailyRangeFrictionModel | null {
  const samples = input.samples.filter((sample) => Date.parse(sample.closedAt) <= Date.parse(input.cutoffAt));
  const minimum = input.minimumSamples ?? DAILY_RANGE_MIN_EMPIRICAL_FRICTION_SAMPLES;
  if (samples.length < minimum) return null;
  const exactFeeSampleCount = samples.filter((sample) => sample.feeEvidence === "EXACT_FILL_COMMISSION").length;
  const legacyFeeSampleCount = samples.filter((sample) => sample.feeEvidence === "LEGACY_COMBINED_FEE_ALLOCATION").length;
  const wins = samples.filter((sample) => sample.exitReason === "TAKE_PROFIT");
  const losses = samples.filter((sample) => sample.exitReason === "STOP_LOSS");
  const entryAdverse = samples.map((sample) => nonNegative(sample.entryAdverseBps));
  const tpExit = wins.map((sample) => nonNegative(sample.takeProfitExitAdverseBps));
  const stopExit = losses.map((sample) => nonNegative(sample.stopExitAdverseBps));
  const stopGap = losses.map((sample) => nonNegative(sample.stopGapBps));
  const entryFee = samples.map((sample) => nonNegative(sample.entryFeeBps));
  const exitFee = samples.map((sample) => nonNegative(sample.exitFeeBps));
  const winAdverse = wins.map((sample) => Math.max(0, (sample.entryAdverseBps ?? 0) + (sample.takeProfitExitAdverseBps ?? 0)));
  const lossAdverse = losses.map((sample) => Math.max(0, (sample.entryAdverseBps ?? 0) + (sample.stopExitAdverseBps ?? 0) + (sample.stopGapBps ?? 0)));

  // A missing category should not create a cost-free route.  Use the all-sample
  // distribution or the fixed conservative fallback for that one component.
  const fallback = conservativeFallbackFrictionModel(input.createdAt, input.cutoffAt, input.environment);
  const knownFillSamples = samples.filter((sample) => nonNegative(sample.sourceFillCount) !== null);
  const sourceFillCount = knownFillSamples.reduce((sum, sample) => sum + (nonNegative(sample.sourceFillCount) ?? 0), 0);
  return baseModel({
    environment: input.environment,
    source: "EMPIRICAL_LEDGER",
    createdAt: input.createdAt,
    cutoffAt: input.cutoffAt,
    sampleCount: samples.length,
    sourceTradeCount: samples.length,
    sourceFillCount,
    sourceFillCountKnownTradeCount: knownFillSamples.length,
    sourceSampleHash: sourceSampleHash(samples),
    exactFeeSampleCount,
    legacyFeeSampleCount,
    entryAdverseP50Bps: rounded(percentile(entryAdverse, 0.5, fallback.entryAdverseP50Bps)),
    entryAdverseP95Bps: rounded(percentile(entryAdverse, 0.95, fallback.entryAdverseP95Bps)),
    takeProfitExitAdverseP50Bps: rounded(percentile(tpExit, 0.5, fallback.takeProfitExitAdverseP50Bps)),
    takeProfitExitAdverseP95Bps: rounded(percentile(tpExit, 0.95, fallback.takeProfitExitAdverseP95Bps)),
    stopExitAdverseP50Bps: rounded(percentile(stopExit, 0.5, fallback.stopExitAdverseP50Bps)),
    stopExitAdverseP95Bps: rounded(percentile(stopExit, 0.95, fallback.stopExitAdverseP95Bps)),
    stopGapP50Bps: rounded(percentile(stopGap, 0.5, fallback.stopGapP50Bps)),
    stopGapP95Bps: rounded(percentile(stopGap, 0.95, fallback.stopGapP95Bps)),
    entryFeeP50Bps: rounded(percentile(entryFee, 0.5, fallback.entryFeeP50Bps)),
    entryFeeP95Bps: rounded(percentile(entryFee, 0.95, fallback.entryFeeP95Bps)),
    exitFeeP50Bps: rounded(percentile(exitFee, 0.5, fallback.exitFeeP50Bps)),
    exitFeeP95Bps: rounded(percentile(exitFee, 0.95, fallback.exitFeeP95Bps)),
    winAdverseP50Bps: rounded(percentile(winAdverse, 0.5, fallback.winAdverseP50Bps)),
    lossAdverseP50Bps: rounded(percentile(lossAdverse, 0.5, fallback.lossAdverseP50Bps)),
    lossAdverseP95Bps: rounded(percentile(lossAdverse, 0.95, fallback.lossAdverseP95Bps)),
  });
}

function roundToStep(value: number, step: number, mode: "down" | "up"): number {
  if (!finite(value) || !finite(step) || step <= 0) return value;
  const units = value / step;
  const raw = mode === "down" ? Math.floor(units + 1e-10) : Math.ceil(units - 1e-10);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  return Number((raw * step).toFixed(Math.min(14, decimals)));
}

function clampQtyDown(raw: number, filter: FuturesSymbolFilters): number | null {
  if (!finite(raw) || raw <= 0 || !finite(filter.stepSize) || filter.stepSize <= 0) return null;
  const qty = roundToStep(raw, filter.stepSize, "down");
  return qty + 1e-12 >= filter.minQty ? qty : null;
}

function bracket(input: { side: DailyRangeEconomicsSide; entry: number; rawStop: number; tickSize: number }): {
  stop: number;
  takeProfit: number;
  risk: number;
} | null {
  if (!finite(input.entry) || input.entry <= 0 || !finite(input.rawStop) || input.rawStop <= 0 || !finite(input.tickSize) || input.tickSize <= 0) return null;
  const stop = input.side === "LONG"
    ? roundToStep(input.rawStop, input.tickSize, "down")
    : roundToStep(input.rawStop, input.tickSize, "up");
  const risk = input.side === "LONG" ? input.entry - stop : stop - input.entry;
  if (!(risk > 1e-12)) return null;
  const rawTakeProfit = input.side === "LONG" ? input.entry + 2 * risk : input.entry - 2 * risk;
  const takeProfit = input.side === "LONG"
    ? roundToStep(rawTakeProfit, input.tickSize, "up")
    : roundToStep(rawTakeProfit, input.tickSize, "down");
  const reward = input.side === "LONG" ? takeProfit - input.entry : input.entry - takeProfit;
  return takeProfit > 0 && reward + 1e-12 >= 2 * risk ? { stop, takeProfit, risk } : null;
}

export function dailyRangeEconomicTieBreakHash(input: {
  strategyPolicyId: string;
  batchTimestampMs: number;
  symbol: string;
  side: DailyRangeEconomicsSide;
  route: string;
}): string {
  return createHash("sha256")
    .update(`${input.strategyPolicyId}\u0000${input.batchTimestampMs}\u0000${input.symbol.trim().toUpperCase()}\u0000${input.side}\u0000${input.route}`)
    .digest("hex");
}

export function prepareDailyRangeEconomics(input: {
  side: DailyRangeEconomicsSide;
  route: string;
  symbol: string;
  batchTimestampMs: number;
  rawStructuralStop: number;
  bbo: DailyRangeEconomicsBbo | null;
  filter: FuturesSymbolFilters | null;
  frictionModel: DailyRangeFrictionModel | null;
  bboMaxAgeMs: number;
  allocationAtMs: number;
  /** Null is an explicit fail-closed condition for a fresh entry. */
  atr4hFeature: DailyRangeAtr4hFeature | null;
}): DailyRangeEconomicsPreparation {
  if (!input.frictionModel) return { ok: false, reason: "FRICTION_MODEL_UNAVAILABLE" };
  if (!input.bbo || !finite(input.bbo.bid) || input.bbo.bid <= 0 || !finite(input.bbo.ask) || input.bbo.ask <= 0 || input.bbo.ask < input.bbo.bid) {
    return { ok: false, reason: "BBO_STALE" };
  }
  const observedAtMs = Date.parse(input.bbo.observedAt);
  if (!Number.isFinite(observedAtMs) || observedAtMs < input.batchTimestampMs || observedAtMs > input.allocationAtMs || input.allocationAtMs - observedAtMs > input.bboMaxAgeMs) {
    return { ok: false, reason: "BBO_STALE" };
  }
  if (!input.filter) return { ok: false, reason: "RISK_BUDGET_UNEXECUTABLE" };
  const model = input.frictionModel;
  const sideBook = input.side === "LONG" ? input.bbo.ask : input.bbo.bid;
  const expectedEntry = input.side === "LONG"
    ? sideBook * (1 + model.entryAdverseP95Bps / 10_000)
    : sideBook * (1 - model.entryAdverseP95Bps / 10_000);
  const roundedBracket = bracket({ side: input.side, entry: expectedEntry, rawStop: input.rawStructuralStop, tickSize: input.filter.tickSize });
  if (!roundedBracket) return { ok: false, reason: "STOP_ECONOMICS_FAIL" };
  const stopRiskBps = (roundedBracket.risk / expectedEntry) * 10_000;
  const medianWinFrictionBps = model.entryFeeP50Bps + model.exitFeeP50Bps + model.winAdverseP50Bps;
  const medianLossFrictionBps = model.entryFeeP50Bps + model.exitFeeP50Bps + model.lossAdverseP50Bps;
  const safeLossEntryFeeComponentBps = model.entryFeeP95Bps;
  const safeLossExitFeeComponentBps = model.exitFeeP95Bps;
  const safeLossPathAdverseComponentBps = DAILY_RANGE_SAFE_FRICTION_MULTIPLIER * model.lossAdverseP95Bps;
  const safeLossFrictionBps = safeLossEntryFeeComponentBps + safeLossExitFeeComponentBps + safeLossPathAdverseComponentBps;
  if (!(stopRiskBps > 0) || !finite(safeLossFrictionBps)) return { ok: false, reason: "STOP_ECONOMICS_FAIL" };
  const costRatio = safeLossFrictionBps / stopRiskBps;
  if (costRatio > DAILY_RANGE_MAX_COST_RATIO + 1e-12) return { ok: false, reason: "STOP_ECONOMICS_FAIL" };
  // Geometry is deliberately evaluated after the existing narrow-stop
  // economics check and before any quantity/rank/allocation work.  Both gates
  // are independent: a stop can be too narrow for friction or too wide for a
  // realistic 2R target.
  const geometry = evaluateDailyRangeTradeGeometry({
    expectedEntryPrice: expectedEntry,
    expectedStopPrice: roundedBracket.stop,
    expectedTakeProfitPrice: roundedBracket.takeProfit,
    atr4hFeature: input.atr4hFeature,
  });
  if (!geometry.geometryPass) {
    return { ok: false, reason: geometry.geometryRejectReason!, geometry };
  }
  const rawQty = Math.min(
    DAILY_RANGE_MAX_NOTIONAL_USD / expectedEntry,
    DAILY_RANGE_MAX_PLANNED_RISK_USD / roundedBracket.risk,
  );
  const qty = clampQtyDown(rawQty, input.filter);
  const plannedNotionalUsd = qty === null ? 0 : qty * expectedEntry;
  const plannedRiskUsd = qty === null ? 0 : qty * roundedBracket.risk;
  if (!qty || plannedNotionalUsd + 1e-12 < input.filter.minNotional || plannedRiskUsd > DAILY_RANGE_MAX_PLANNED_RISK_USD + 1e-9 || plannedNotionalUsd > DAILY_RANGE_MAX_NOTIONAL_USD + 1e-9) {
    return { ok: false, reason: "RISK_BUDGET_UNEXECUTABLE" };
  }
  const netWinR = 2 - medianWinFrictionBps / stopRiskBps;
  const netLossR = -1 - medianLossFrictionBps / stopRiskBps;
  const denominator = netWinR + Math.abs(netLossR);
  if (!(netWinR > 0) || !(denominator > 0)) return { ok: false, reason: "STOP_ECONOMICS_FAIL" };
  const breakEvenWinRate = Math.abs(netLossR) / denominator;
  const mid = (input.bbo.bid + input.bbo.ask) / 2;
  const decisionSpreadBps = mid > 0 ? ((input.bbo.ask - input.bbo.bid) / mid) * 10_000 : Number.POSITIVE_INFINITY;
  return {
    ok: true,
    economics: {
      economicsPolicyId: DAILY_RANGE_EXECUTION_ECONOMICS_POLICY_ID,
      allocatorPolicyId: DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID,
      frictionModelId: model.id,
      frictionModelSource: model.source,
      frictionModelCutoffAt: model.cutoffAt,
      decisionBid: input.bbo.bid,
      decisionAsk: input.bbo.ask,
      decisionSpreadBps,
      bboObservedAt: input.bbo.observedAt,
      bboReceivedAt: input.bbo.receivedAt,
      bboSourceTime: input.bbo.sourceTime,
      expectedEntryPrice: expectedEntry,
      expectedStopPrice: roundedBracket.stop,
      expectedTakeProfitPrice: roundedBracket.takeProfit,
      rawStructuralStop: input.rawStructuralStop,
      stopRiskPrice: roundedBracket.risk,
      stopRiskBps,
      requestedQty: qty,
      plannedNotionalUsd,
      plannedRiskUsd,
      entryFeeBps: model.entryFeeP50Bps,
      exitFeeBps: model.exitFeeP50Bps,
      medianWinFrictionBps,
      medianLossFrictionBps,
      safeLossEntryFeeComponentBps,
      safeLossExitFeeComponentBps,
      safeLossPathAdverseComponentBps,
      safeLossDefinitionVersion: DAILY_RANGE_FRICTION_DEFINITION_VERSION,
      safeLossFrictionBps,
      costRatio,
      netWinR,
      netLossR,
      breakEvenWinRate,
      qualityTieBreakHash: dailyRangeEconomicTieBreakHash({
        strategyPolicyId: DAILY_RANGE_ECONOMIC_ALLOCATOR_POLICY_ID,
        batchTimestampMs: input.batchTimestampMs,
        symbol: input.symbol,
        side: input.side,
        route: input.route,
      }),
      geometry,
    },
  };
}

/**
 * The fill check intentionally never changes the structural stop.  If a market
 * fill materially invalidates the safe decision, the only safe action is an
 * immediate exact reduce-only flatten by the caller.
 */
export function evaluateActualFillEconomics(input: {
  side: DailyRangeEconomicsSide;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  expectedCostRatio: number;
  expectedPlannedRiskUsd: number;
  safeLossFrictionBps: number;
}): DailyRangeActualFillEconomics | null {
  if (!finite(input.entryPrice) || input.entryPrice <= 0 || !finite(input.quantity) || input.quantity <= 0 || !finite(input.stopPrice) || input.stopPrice <= 0) return null;
  const risk = input.side === "LONG" ? input.entryPrice - input.stopPrice : input.stopPrice - input.entryPrice;
  if (!(risk > 0)) return null;
  const actualStopRiskBps = risk / input.entryPrice * 10_000;
  const actualInitialRiskUsd = risk * input.quantity;
  const actualCostRatio = input.safeLossFrictionBps / actualStopRiskBps;
  const economicsViolation = actualCostRatio > DAILY_RANGE_MAX_COST_RATIO + 1e-12
    || actualCostRatio > input.expectedCostRatio * 1.15 + 1e-12;
  const riskViolation = actualInitialRiskUsd > input.expectedPlannedRiskUsd * 1.15 + 1e-9;
  const violation = economicsViolation
    ? "POST_FILL_ECONOMICS_FAIL" as const
    : riskViolation
      ? "POST_FILL_RISK_FAIL" as const
      : null;
  return {
    actualStopRiskPrice: risk,
    actualStopRiskBps,
    actualInitialRiskUsd,
    actualCostRatio,
    violation,
    // The requested quantity is frozen before the POST, so a worse market
    // fill can only be tolerated within the same materiality band. This keeps
    // the $0.25 planned-risk cap meaningful without flattening for rounding
    // dust or a single normal execution tick.
    materialViolation: violation !== null,
  };
}

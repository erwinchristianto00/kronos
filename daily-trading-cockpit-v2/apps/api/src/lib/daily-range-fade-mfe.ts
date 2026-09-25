/**
 * Daily Range BREAKOUT FADE MFE 50/75 V1.
 *
 * Pure arithmetic only: the lane persists this snapshot and invokes its
 * existing ownership-checked safe flatten after a causal contract-price event.
 */
export const DAILY_RANGE_FADE_MFE_POLICY_ID = "daily-fade-mfe-50-75-v1" as const;
export const DAILY_RANGE_FADE_MFE_PRICE_SOURCE = "CONTRACT_AGG_TRADE" as const;

export type DailyRangeFadeMfeDirection = "LONG" | "SHORT";
export type DailyRangeFadeMfeExitReason =
  | "FADE_MFE_STAGE1_GIVEBACK_EXIT"
  | "FADE_MFE_STAGE2_GIVEBACK_EXIT";

export interface DailyRangeFadeMfeExitAttribution {
  highestArmedStage: 1 | 2;
  peakMfeProgress: number | null;
  peakMfePrice: number | null;
  peakMfeAt: string | null;
  floorProgressAtExit: number | null;
  floorPriceAtExit: number | null;
  triggerPrice: number;
  triggerAt: string;
  actualExitFill: number | null;
  exitSlippageBps: number | null;
  grossR: number | null;
  netR: number | null;
  originalStructuralSL: number | null;
  originalStructuralTP: number | null;
  terminalOutcome: "PENDING" | "MFE_EXIT" | "NATIVE_TP" | "NATIVE_SL" | "OTHER";
}

export interface DailyRangeFadeMfeState {
  mfePolicyId: typeof DAILY_RANGE_FADE_MFE_POLICY_ID;
  effectiveAt: string;
  mfePriceSource: typeof DAILY_RANGE_FADE_MFE_PRICE_SOURCE;
  entryPrice: number | null;
  structuralTakeProfit: number | null;
  stage1ArmProgress: number;
  stage1StaticFloor: number;
  stage1PeakRetention: number;
  stage2ArmProgress: number;
  stage2StaticFloor: number;
  stage2PeakRetention: number;
  currentProgress: number | null;
  peakMfeProgress: number | null;
  peakMfePrice: number | null;
  peakMfeAt: string | null;
  stage1Armed: boolean;
  stage1ArmedAt: string | null;
  stage2Armed: boolean;
  stage2ArmedAt: string | null;
  mfeExitFloorProgress: number | null;
  mfeExitFloorPrice: number | null;
  distanceToMfeFloor: number | null;
  lastMfeUpdateAt: string | null;
  health: "HEALTHY" | "DEGRADED";
  degradedReason: string | null;
  mfeExitIntentAt: string | null;
  mfeExitIntentReason: DailyRangeFadeMfeExitReason | null;
  exitAttribution: DailyRangeFadeMfeExitAttribution | null;
}

export interface DailyRangeFadeMfeAdvanceInput {
  state: DailyRangeFadeMfeState;
  direction: DailyRangeFadeMfeDirection;
  price: number;
  eventTimeMs: number;
  receivedAtMs: number;
}

export interface DailyRangeFadeMfeAdvanceResult {
  state: DailyRangeFadeMfeState;
  changed: boolean;
  floorChanged: boolean;
  shouldExit: boolean;
  exitReason: DailyRangeFadeMfeExitReason | null;
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteTime(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function equalNumber(left: number | null, right: number | null): boolean {
  return left === right || (left !== null && right !== null && Math.abs(left - right) <= 1e-12);
}

export function createDailyRangeFadeMfeState(effectiveAt: string): DailyRangeFadeMfeState {
  return {
    mfePolicyId: DAILY_RANGE_FADE_MFE_POLICY_ID,
    effectiveAt,
    mfePriceSource: DAILY_RANGE_FADE_MFE_PRICE_SOURCE,
    entryPrice: null,
    structuralTakeProfit: null,
    stage1ArmProgress: 0.5,
    stage1StaticFloor: 0.25,
    stage1PeakRetention: 0.5,
    stage2ArmProgress: 0.75,
    stage2StaticFloor: 0.5,
    stage2PeakRetention: 2 / 3,
    currentProgress: null,
    peakMfeProgress: null,
    peakMfePrice: null,
    peakMfeAt: null,
    stage1Armed: false,
    stage1ArmedAt: null,
    stage2Armed: false,
    stage2ArmedAt: null,
    mfeExitFloorProgress: null,
    mfeExitFloorPrice: null,
    distanceToMfeFloor: null,
    lastMfeUpdateAt: null,
    health: "DEGRADED",
    degradedReason: "awaiting actual fill and frozen structural TP",
    mfeExitIntentAt: null,
    mfeExitIntentReason: null,
    exitAttribution: null,
  };
}

/** Freeze actual fill and the already-rounded structural target exactly once. */
export function bindDailyRangeFadeMfeTarget(
  state: DailyRangeFadeMfeState,
  input: { entryPrice: number | null; structuralTakeProfit: number | null },
): DailyRangeFadeMfeState {
  if (!finitePositive(input.entryPrice) || !finitePositive(input.structuralTakeProfit)) return state;
  const entryPrice = state.entryPrice ?? input.entryPrice;
  const structuralTakeProfit = state.structuralTakeProfit ?? input.structuralTakeProfit;
  return {
    ...state,
    entryPrice,
    structuralTakeProfit,
    degradedReason: state.degradedReason === "awaiting actual fill and frozen structural TP"
      ? "awaiting continuous contract-price stream"
      : state.degradedReason,
  };
}

export function dailyRangeFadeMfeProgress(input: {
  direction: DailyRangeFadeMfeDirection;
  entryPrice: number | null;
  structuralTakeProfit: number | null;
  price: number;
}): number | null {
  const { direction, entryPrice, structuralTakeProfit, price } = input;
  if (!finitePositive(entryPrice) || !finitePositive(structuralTakeProfit) || !finitePositive(price)) return null;
  const distance = direction === "LONG" ? structuralTakeProfit - entryPrice : entryPrice - structuralTakeProfit;
  if (!(distance > 0)) return null;
  return direction === "LONG" ? (price - entryPrice) / distance : (entryPrice - price) / distance;
}

export function dailyRangeFadeMfeFloorPrice(input: {
  direction: DailyRangeFadeMfeDirection;
  entryPrice: number | null;
  structuralTakeProfit: number | null;
  floorProgress: number | null;
}): number | null {
  const { direction, entryPrice, structuralTakeProfit, floorProgress } = input;
  if (!finitePositive(entryPrice) || !finitePositive(structuralTakeProfit)
    || typeof floorProgress !== "number" || !Number.isFinite(floorProgress)) return null;
  const distance = direction === "LONG" ? structuralTakeProfit - entryPrice : entryPrice - structuralTakeProfit;
  if (!(distance > 0)) return null;
  return direction === "LONG" ? entryPrice + floorProgress * distance : entryPrice - floorProgress * distance;
}

export function markDailyRangeFadeMfeDegraded(
  state: DailyRangeFadeMfeState,
  reason: string,
  atMs: number,
): DailyRangeFadeMfeState {
  return {
    ...state,
    health: "DEGRADED",
    degradedReason: reason,
    lastMfeUpdateAt: finiteTime(atMs) ? iso(atMs) : state.lastMfeUpdateAt,
  };
}

/** Advance exactly one causal contract-price point. */
export function advanceDailyRangeFadeMfe(input: DailyRangeFadeMfeAdvanceInput): DailyRangeFadeMfeAdvanceResult {
  const prior = input.state;
  const progress = dailyRangeFadeMfeProgress({
    direction: input.direction,
    entryPrice: prior.entryPrice,
    structuralTakeProfit: prior.structuralTakeProfit,
    price: input.price,
  });
  if (progress === null || !finiteTime(input.eventTimeMs) || !finiteTime(input.receivedAtMs)) {
    return { state: prior, changed: false, floorChanged: false, shouldExit: false, exitReason: null };
  }
  const priorPeak = prior.peakMfeProgress;
  const newPeak = priorPeak === null ? progress : Math.max(priorPeak, progress);
  const peakAdvanced = priorPeak === null || newPeak > priorPeak + 1e-12;
  const stage1Armed = prior.stage1Armed || newPeak >= prior.stage1ArmProgress;
  const stage2Armed = prior.stage2Armed || newPeak >= prior.stage2ArmProgress;
  const stageFloor = stage2Armed
    ? Math.max(prior.stage2StaticFloor, prior.stage2PeakRetention * newPeak)
    : stage1Armed ? Math.max(prior.stage1StaticFloor, prior.stage1PeakRetention * newPeak) : null;
  const nextFloor = stageFloor === null
    ? prior.mfeExitFloorProgress
    : prior.mfeExitFloorProgress === null ? stageFloor : Math.max(prior.mfeExitFloorProgress, stageFloor);
  const floorChanged = !equalNumber(prior.mfeExitFloorProgress, nextFloor);
  const floorPrice = dailyRangeFadeMfeFloorPrice({
    direction: input.direction,
    entryPrice: prior.entryPrice,
    structuralTakeProfit: prior.structuralTakeProfit,
    floorProgress: nextFloor,
  });
  const distanceToMfeFloor = floorPrice === null
    ? null
    : input.direction === "LONG" ? input.price - floorPrice : floorPrice - input.price;
  const highestArmedStage = stage2Armed ? 2 : stage1Armed ? 1 : 0;
  const shouldExit = highestArmedStage > 0 && nextFloor !== null && progress <= nextFloor + 1e-12;
  const exitReason: DailyRangeFadeMfeExitReason | null = shouldExit
    ? highestArmedStage === 2 ? "FADE_MFE_STAGE2_GIVEBACK_EXIT" : "FADE_MFE_STAGE1_GIVEBACK_EXIT"
    : null;
  const state: DailyRangeFadeMfeState = {
    ...prior,
    currentProgress: progress,
    peakMfeProgress: newPeak,
    peakMfePrice: peakAdvanced ? input.price : prior.peakMfePrice,
    peakMfeAt: peakAdvanced ? iso(input.eventTimeMs) : prior.peakMfeAt,
    stage1Armed,
    stage1ArmedAt: !prior.stage1Armed && stage1Armed ? iso(input.eventTimeMs) : prior.stage1ArmedAt,
    stage2Armed,
    stage2ArmedAt: !prior.stage2Armed && stage2Armed ? iso(input.eventTimeMs) : prior.stage2ArmedAt,
    mfeExitFloorProgress: nextFloor,
    mfeExitFloorPrice: floorPrice,
    distanceToMfeFloor,
    lastMfeUpdateAt: iso(input.receivedAtMs),
    health: "HEALTHY",
    degradedReason: null,
  };
  const changed = peakAdvanced || floorChanged || !equalNumber(prior.currentProgress, state.currentProgress)
    || prior.stage1Armed !== state.stage1Armed || prior.stage2Armed !== state.stage2Armed
    || prior.health !== state.health || prior.degradedReason !== state.degradedReason
    || prior.lastMfeUpdateAt !== state.lastMfeUpdateAt;
  return { state, changed, floorChanged, shouldExit, exitReason };
}

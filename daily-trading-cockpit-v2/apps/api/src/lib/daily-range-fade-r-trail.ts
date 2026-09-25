/**
 * Daily Range BREAKOUT FADE R-based MFE trail V2.
 *
 * This deliberately lives beside, rather than replacing, the older 50/75
 * structural-target MFE machine.  A trade persists exactly one policy snapshot
 * at entry, so a release cannot reinterpret an already-open position.
 */
export const DAILY_RANGE_FADE_R_TRAIL_POLICY_ID = "daily-fade-r30-floor25-v2" as const;
export const DAILY_RANGE_FADE_R_TRAIL_PRICE_SOURCE = "CONTRACT_AGG_TRADE" as const;

export type DailyRangeFadeRTrailDirection = "LONG" | "SHORT";
export type DailyRangeFadeRTrailExitReason = "FADE_R30_GIVEBACK_EXIT";

export interface DailyRangeFadeRTrailExitAttribution {
  highestCheckpointR: 0.5 | 0.75 | 1 | 1.5;
  peakMfeR: number | null;
  peakMfePrice: number | null;
  peakMfeAt: string | null;
  allowedGivebackR: number | null;
  floorRAtExit: number | null;
  floorPriceAtExit: number | null;
  triggerPrice: number;
  triggerAt: string;
  actualExitFill: number | null;
  exitSlippageBps: number | null;
  grossR: number | null;
  netR: number | null;
  originalStructuralSL: number | null;
  originalNativeTP: number | null;
  terminalOutcome: "PENDING" | "MFE_EXIT" | "NATIVE_TP" | "NATIVE_SL" | "OTHER";
}

export interface DailyRangeFadeRTrailState {
  mfePolicyId: typeof DAILY_RANGE_FADE_R_TRAIL_POLICY_ID;
  effectiveAt: string;
  mfePriceSource: typeof DAILY_RANGE_FADE_R_TRAIL_PRICE_SOURCE;
  /** Frozen exactly once from the confirmed exchange entry fill. */
  entryPrice: number | null;
  /** Actual entry-to-native-stop distance, in price units. */
  initialRiskPrice: number | null;
  /** Conservative fee/slippage break-even expressed in the same R basis. */
  breakEvenFeeAndSlippageR: number | null;
  armThresholdR: number;
  checkpointThresholdsR: readonly [0.5, 0.75, 1, 1.5];
  givebackFraction: number;
  minimumGivebackR: number;
  currentR: number | null;
  peakMfeR: number | null;
  peakMfePrice: number | null;
  peakMfeAt: string | null;
  trailArmed: boolean;
  trailArmedAt: string | null;
  checkpoint50At: string | null;
  checkpoint75At: string | null;
  checkpoint100At: string | null;
  checkpoint150At: string | null;
  allowedGivebackR: number | null;
  mfeExitFloorR: number | null;
  mfeExitFloorPrice: number | null;
  distanceToMfeFloorR: number | null;
  lastMfeUpdateAt: string | null;
  health: "HEALTHY" | "DEGRADED";
  degradedReason: string | null;
  mfeExitIntentAt: string | null;
  mfeExitIntentReason: DailyRangeFadeRTrailExitReason | null;
  exitAttribution: DailyRangeFadeRTrailExitAttribution | null;
}

export interface DailyRangeFadeRTrailAdvanceInput {
  state: DailyRangeFadeRTrailState;
  direction: DailyRangeFadeRTrailDirection;
  price: number;
  eventTimeMs: number;
  receivedAtMs: number;
}

export interface DailyRangeFadeRTrailAdvanceResult {
  state: DailyRangeFadeRTrailState;
  changed: boolean;
  floorChanged: boolean;
  shouldExit: boolean;
  exitReason: DailyRangeFadeRTrailExitReason | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return finite(value) && value >= 0;
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

export function createDailyRangeFadeRTrailState(effectiveAt: string): DailyRangeFadeRTrailState {
  return {
    mfePolicyId: DAILY_RANGE_FADE_R_TRAIL_POLICY_ID,
    effectiveAt,
    mfePriceSource: DAILY_RANGE_FADE_R_TRAIL_PRICE_SOURCE,
    entryPrice: null,
    initialRiskPrice: null,
    breakEvenFeeAndSlippageR: null,
    armThresholdR: 0.5,
    checkpointThresholdsR: [0.5, 0.75, 1, 1.5],
    givebackFraction: 0.30,
    minimumGivebackR: 0.25,
    currentR: null,
    peakMfeR: null,
    peakMfePrice: null,
    peakMfeAt: null,
    trailArmed: false,
    trailArmedAt: null,
    checkpoint50At: null,
    checkpoint75At: null,
    checkpoint100At: null,
    checkpoint150At: null,
    allowedGivebackR: null,
    mfeExitFloorR: null,
    mfeExitFloorPrice: null,
    distanceToMfeFloorR: null,
    lastMfeUpdateAt: null,
    health: "DEGRADED",
    degradedReason: "awaiting actual fill, stop risk, and fee/slippage floor",
    mfeExitIntentAt: null,
    mfeExitIntentReason: null,
    exitAttribution: null,
  };
}

/** Freeze actual execution inputs once; later restarts can never rewrite them. */
export function bindDailyRangeFadeRTrail(
  state: DailyRangeFadeRTrailState,
  input: { entryPrice: number | null; initialRiskPrice: number | null; breakEvenFeeAndSlippageR: number | null },
): DailyRangeFadeRTrailState {
  if (!finitePositive(input.entryPrice) || !finitePositive(input.initialRiskPrice) || !finiteNonNegative(input.breakEvenFeeAndSlippageR)) {
    return state;
  }
  return {
    ...state,
    entryPrice: state.entryPrice ?? input.entryPrice,
    initialRiskPrice: state.initialRiskPrice ?? input.initialRiskPrice,
    breakEvenFeeAndSlippageR: state.breakEvenFeeAndSlippageR ?? input.breakEvenFeeAndSlippageR,
    degradedReason: state.degradedReason === "awaiting actual fill, stop risk, and fee/slippage floor"
      ? "awaiting continuous contract-price stream"
      : state.degradedReason,
  };
}

export function dailyRangeFadeRTrailR(input: {
  direction: DailyRangeFadeRTrailDirection;
  entryPrice: number | null;
  initialRiskPrice: number | null;
  price: number;
}): number | null {
  if (!finitePositive(input.entryPrice) || !finitePositive(input.initialRiskPrice) || !finitePositive(input.price)) return null;
  return input.direction === "LONG"
    ? (input.price - input.entryPrice) / input.initialRiskPrice
    : (input.entryPrice - input.price) / input.initialRiskPrice;
}

export function dailyRangeFadeRTrailFloorPrice(input: {
  direction: DailyRangeFadeRTrailDirection;
  entryPrice: number | null;
  initialRiskPrice: number | null;
  floorR: number | null;
}): number | null {
  if (!finitePositive(input.entryPrice) || !finitePositive(input.initialRiskPrice) || !finite(input.floorR)) return null;
  return input.direction === "LONG"
    ? input.entryPrice + input.floorR * input.initialRiskPrice
    : input.entryPrice - input.floorR * input.initialRiskPrice;
}

export function markDailyRangeFadeRTrailDegraded(
  state: DailyRangeFadeRTrailState,
  reason: string,
  atMs: number,
): DailyRangeFadeRTrailState {
  return {
    ...state,
    health: "DEGRADED",
    degradedReason: reason,
    lastMfeUpdateAt: finiteTime(atMs) ? iso(atMs) : state.lastMfeUpdateAt,
  };
}

/**
 * Advance one causal contract price.  The trigger compares against the prior
 * persisted floor; a new peak can only tighten protection for a later event.
 */
export function advanceDailyRangeFadeRTrail(input: DailyRangeFadeRTrailAdvanceInput): DailyRangeFadeRTrailAdvanceResult {
  const prior = input.state;
  const currentR = dailyRangeFadeRTrailR({
    direction: input.direction,
    entryPrice: prior.entryPrice,
    initialRiskPrice: prior.initialRiskPrice,
    price: input.price,
  });
  if (currentR === null || !finiteTime(input.eventTimeMs) || !finiteTime(input.receivedAtMs) || !finiteNonNegative(prior.breakEvenFeeAndSlippageR)) {
    return { state: prior, changed: false, floorChanged: false, shouldExit: false, exitReason: null };
  }

  const priorFloor = prior.trailArmed && finite(prior.mfeExitFloorR) ? prior.mfeExitFloorR : null;
  const shouldExit = priorFloor !== null && currentR <= priorFloor + 1e-12;
  const priorPeak = finite(prior.peakMfeR) ? prior.peakMfeR : 0;
  const peakMfeR = Math.max(0, priorPeak, currentR);
  const peakAdvanced = peakMfeR > priorPeak + 1e-12;
  const trailArmed = prior.trailArmed || peakMfeR >= prior.armThresholdR;
  const allowedGivebackR = trailArmed
    ? Math.max(prior.givebackFraction * peakMfeR, prior.minimumGivebackR)
    : null;
  const candidateFloorR = trailArmed && allowedGivebackR !== null
    ? Math.max(prior.breakEvenFeeAndSlippageR, peakMfeR - allowedGivebackR)
    : null;
  const nextFloorR = candidateFloorR === null
    ? prior.mfeExitFloorR
    : prior.mfeExitFloorR === null ? candidateFloorR : Math.max(prior.mfeExitFloorR, candidateFloorR);
  const floorChanged = !equalNumber(prior.mfeExitFloorR, nextFloorR);
  const floorPrice = dailyRangeFadeRTrailFloorPrice({
    direction: input.direction,
    entryPrice: prior.entryPrice,
    initialRiskPrice: prior.initialRiskPrice,
    floorR: nextFloorR,
  });
  const distanceToMfeFloorR = nextFloorR === null ? null : currentR - nextFloorR;
  const at = iso(input.eventTimeMs);
  const state: DailyRangeFadeRTrailState = {
    ...prior,
    currentR,
    peakMfeR,
    peakMfePrice: peakAdvanced ? input.price : prior.peakMfePrice,
    peakMfeAt: peakAdvanced ? at : prior.peakMfeAt,
    trailArmed,
    trailArmedAt: !prior.trailArmed && trailArmed ? at : prior.trailArmedAt,
    checkpoint50At: prior.checkpoint50At ?? (peakMfeR >= 0.5 ? at : null),
    checkpoint75At: prior.checkpoint75At ?? (peakMfeR >= 0.75 ? at : null),
    checkpoint100At: prior.checkpoint100At ?? (peakMfeR >= 1 ? at : null),
    checkpoint150At: prior.checkpoint150At ?? (peakMfeR >= 1.5 ? at : null),
    allowedGivebackR,
    mfeExitFloorR: nextFloorR,
    mfeExitFloorPrice: floorPrice,
    distanceToMfeFloorR,
    lastMfeUpdateAt: iso(input.receivedAtMs),
    health: "HEALTHY",
    degradedReason: null,
  };
  const changed = peakAdvanced || floorChanged || !equalNumber(prior.currentR, state.currentR)
    || prior.trailArmed !== state.trailArmed || prior.health !== state.health
    || prior.degradedReason !== state.degradedReason || prior.lastMfeUpdateAt !== state.lastMfeUpdateAt
    || prior.checkpoint50At !== state.checkpoint50At || prior.checkpoint75At !== state.checkpoint75At
    || prior.checkpoint100At !== state.checkpoint100At || prior.checkpoint150At !== state.checkpoint150At;
  return {
    state,
    changed,
    floorChanged,
    shouldExit,
    exitReason: shouldExit ? "FADE_R30_GIVEBACK_EXIT" : null,
  };
}

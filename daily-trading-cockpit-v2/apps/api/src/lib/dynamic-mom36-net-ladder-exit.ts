/**
 * Dynamic MOM36 net-profit ladder with a five-minute realised-observation
 * volatility floor.  It is pure and persisted by the executor before any
 * market close, so restarts cannot reinterpret an admitted basket.
 */
export const DYNAMIC_MOM36_NET_LADDER_EXIT_POLICY_ID = "dynamic-mom36-net-ladder-vol5m-v1" as const;
export const DYNAMIC_MOM36_NET_LADDER_HARD_CUT_LOSS = -0.02;
export const DYNAMIC_MOM36_NET_LADDER_ARM_NET_USD = 1.5;
export const DYNAMIC_MOM36_NET_LADDER_ARM_STEP_USD = 0.5;
export const DYNAMIC_MOM36_NET_LADDER_FULL_TP_CAPITAL_FRACTION = 0.05;
export const DYNAMIC_MOM36_NET_LADDER_GIVEBACK_FRACTION = 0.30;
export const DYNAMIC_MOM36_NET_LADDER_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const DYNAMIC_MOM36_NET_LADDER_VOLATILITY_LOOKBACK_CHANGES = 12;
export const DYNAMIC_MOM36_NET_LADDER_VOLATILITY_MIN_CHANGES = 4;
export const DYNAMIC_MOM36_NET_LADDER_VOLATILITY_MULTIPLIER = 1;

export type DynamicMom36NetLadderExitReason =
  | "HARD_CUT_LOSS_2"
  | "NET_LADDER_GIVEBACK_30"
  | "NET_LADDER_FULL_TP_5";

export type DynamicMom36NetLadderStoredExitReason = DynamicMom36NetLadderExitReason | "HORIZON_36H";

export interface DynamicMom36NetLadderSample {
  /** UTC five-minute bucket start. Missing buckets are never manufactured. */
  bucketStartMs: number;
  observedAt: string;
  netPnlUsd: number;
}

export interface DynamicMom36NetLadderExitState {
  version: "DYNAMIC_MOM36_NET_LADDER_VOL5M_EXIT_V1";
  policyId: typeof DYNAMIC_MOM36_NET_LADDER_EXIT_POLICY_ID;
  hardCutLossThreshold: number;
  armNetPnlUsd: number;
  armStepNetPnlUsd: number;
  fullTakeProfitCapitalFraction: number;
  givebackFraction: number;
  volatilitySampleIntervalMs: number;
  volatilityLookbackChanges: number;
  volatilityMinChanges: number;
  volatilityMultiplier: number;
  /** Set once after every leg has a real entry fill; null means protective profit exits stay off. */
  entryCapitalUsd: number | null;
  entryCapitalBoundAt: string | null;
  currentNetPnlUsd: number | null;
  currentNetReturn: number | null;
  peakNetPnlUsd: number | null;
  peakNetPnlAt: string | null;
  highestArmLevel: number;
  trailArmed: boolean;
  trailArmedAt: string | null;
  fiveMinuteNetPnlSamples: DynamicMom36NetLadderSample[];
  fiveMinuteVolatilityUsd: number | null;
  minimumAllowedGivebackUsd: number | null;
  allowedGivebackUsd: number | null;
  trailingFloorNetUsd: number | null;
  lastObservedAt: string | null;
  exitTrigger?: {
    reason: DynamicMom36NetLadderStoredExitReason;
    observedNetPnlUsd: number | null;
    observedNetReturn: number | null;
    observedAt: string;
    peakNetPnlUsd: number | null;
    trailingFloorNetUsd: number | null;
    fiveMinuteVolatilityUsd: number | null;
  } | null;
  realizedNetPnlUsd?: number | null;
  realizedNetReturn?: number | null;
  forwardCounterfactual?: {
    sourceObservationId: string;
    horizonAtMs: number | null;
    status: "PENDING_CANONICAL_36H" | "AVAILABLE_IN_CANONICAL_OBSERVATION";
  } | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function sampleStandardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const deviation = Math.sqrt(variance);
  return finite(deviation) ? deviation : null;
}

function sampleVolatility(state: DynamicMom36NetLadderExitState): number | null {
  const samples = state.fiveMinuteNetPnlSamples;
  const changes = samples.slice(1).map((sample, index) => sample.netPnlUsd - samples[index]!.netPnlUsd);
  if (changes.length < state.volatilityMinChanges) return null;
  return sampleStandardDeviation(changes);
}

function updateFiveMinuteSample(
  state: DynamicMom36NetLadderExitState,
  observedAt: string,
  netPnlUsd: number,
): void {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || state.volatilitySampleIntervalMs <= 0) return;
  const bucketStartMs = Math.floor(observedMs / state.volatilitySampleIntervalMs) * state.volatilitySampleIntervalMs;
  const samples = state.fiveMinuteNetPnlSamples;
  const last = samples.at(-1) ?? null;
  if (last && bucketStartMs < last.bucketStartMs) return; // never backfill/reorder a causal sample path
  const next: DynamicMom36NetLadderSample = { bucketStartMs, observedAt, netPnlUsd };
  if (last && bucketStartMs === last.bucketStartMs) {
    // Use the latest real mark observed in this bucket. This does not create a
    // second five-minute change and never interpolates a skipped bucket.
    samples[samples.length - 1] = next;
  } else {
    samples.push(next);
  }
  const maxSamples = state.volatilityLookbackChanges + 1;
  if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
}

export function createDynamicMom36NetLadderExitState(sourceObservationId: string): DynamicMom36NetLadderExitState {
  return {
    version: "DYNAMIC_MOM36_NET_LADDER_VOL5M_EXIT_V1",
    policyId: DYNAMIC_MOM36_NET_LADDER_EXIT_POLICY_ID,
    hardCutLossThreshold: DYNAMIC_MOM36_NET_LADDER_HARD_CUT_LOSS,
    armNetPnlUsd: DYNAMIC_MOM36_NET_LADDER_ARM_NET_USD,
    armStepNetPnlUsd: DYNAMIC_MOM36_NET_LADDER_ARM_STEP_USD,
    fullTakeProfitCapitalFraction: DYNAMIC_MOM36_NET_LADDER_FULL_TP_CAPITAL_FRACTION,
    givebackFraction: DYNAMIC_MOM36_NET_LADDER_GIVEBACK_FRACTION,
    volatilitySampleIntervalMs: DYNAMIC_MOM36_NET_LADDER_SAMPLE_INTERVAL_MS,
    volatilityLookbackChanges: DYNAMIC_MOM36_NET_LADDER_VOLATILITY_LOOKBACK_CHANGES,
    volatilityMinChanges: DYNAMIC_MOM36_NET_LADDER_VOLATILITY_MIN_CHANGES,
    volatilityMultiplier: DYNAMIC_MOM36_NET_LADDER_VOLATILITY_MULTIPLIER,
    entryCapitalUsd: null,
    entryCapitalBoundAt: null,
    currentNetPnlUsd: null,
    currentNetReturn: null,
    peakNetPnlUsd: null,
    peakNetPnlAt: null,
    highestArmLevel: 0,
    trailArmed: false,
    trailArmedAt: null,
    fiveMinuteNetPnlSamples: [],
    fiveMinuteVolatilityUsd: null,
    minimumAllowedGivebackUsd: null,
    allowedGivebackUsd: null,
    trailingFloorNetUsd: null,
    lastObservedAt: null,
    exitTrigger: null,
    realizedNetPnlUsd: null,
    realizedNetReturn: null,
    forwardCounterfactual: {
      sourceObservationId,
      horizonAtMs: null,
      status: "PENDING_CANONICAL_36H",
    },
  };
}

/** Bind once from actual fills; later partial recovery or a restart cannot resize the target. */
export function bindDynamicMom36NetLadderEntryCapital(
  state: DynamicMom36NetLadderExitState,
  entryCapitalUsd: number,
  boundAt: string,
): void {
  if (finitePositive(state.entryCapitalUsd) || !finitePositive(entryCapitalUsd)) return;
  state.entryCapitalUsd = entryCapitalUsd;
  state.entryCapitalBoundAt = boundAt;
}

/**
 * Causal protective state machine. Hard loss is intentionally checked first on
 * a gap; the prior ratcheted floor is checked before a new peak can tighten it.
 */
export function advanceDynamicMom36NetLadderExitState(
  state: DynamicMom36NetLadderExitState,
  input: { netPnlUsd: number; netReturn: number; observedAt: string },
): DynamicMom36NetLadderExitReason | null {
  if (!finite(input.netPnlUsd) || !finite(input.netReturn) || !input.observedAt) return null;
  state.currentNetPnlUsd = input.netPnlUsd;
  state.currentNetReturn = input.netReturn;
  state.lastObservedAt = input.observedAt;

  const setTrigger = (reason: DynamicMom36NetLadderExitReason): DynamicMom36NetLadderExitReason => {
    state.exitTrigger = {
      reason,
      observedNetPnlUsd: input.netPnlUsd,
      observedNetReturn: input.netReturn,
      observedAt: input.observedAt,
      peakNetPnlUsd: state.peakNetPnlUsd,
      trailingFloorNetUsd: state.trailingFloorNetUsd,
      fiveMinuteVolatilityUsd: state.fiveMinuteVolatilityUsd,
    };
    return reason;
  };

  if (input.netReturn <= state.hardCutLossThreshold + 1e-12) return setTrigger("HARD_CUT_LOSS_2");
  if (!finitePositive(state.entryCapitalUsd)) return null;
  const fullTakeProfitUsd = state.entryCapitalUsd * state.fullTakeProfitCapitalFraction;
  if (input.netPnlUsd >= fullTakeProfitUsd - 1e-12) return setTrigger("NET_LADDER_FULL_TP_5");

  const priorFloor = state.trailArmed && finite(state.trailingFloorNetUsd) ? state.trailingFloorNetUsd : null;
  if (priorFloor !== null && input.netPnlUsd <= priorFloor + 1e-12) return setTrigger("NET_LADDER_GIVEBACK_30");

  updateFiveMinuteSample(state, input.observedAt, input.netPnlUsd);
  state.fiveMinuteVolatilityUsd = sampleVolatility(state);
  const priorPeak = finite(state.peakNetPnlUsd) ? state.peakNetPnlUsd : 0;
  const peak = Math.max(0, priorPeak, input.netPnlUsd);
  if (peak > priorPeak + 1e-12) {
    state.peakNetPnlUsd = peak;
    state.peakNetPnlAt = input.observedAt;
  }
  if (peak >= state.armNetPnlUsd) {
    const wasArmed = state.trailArmed;
    state.trailArmed = true;
    if (!wasArmed) state.trailArmedAt = input.observedAt;
    state.highestArmLevel = Math.max(
      state.highestArmLevel,
      Math.floor((peak - state.armNetPnlUsd + 1e-12) / state.armStepNetPnlUsd) + 1,
    );
    const minVolatility = state.fiveMinuteVolatilityUsd === null
      ? 0
      : state.volatilityMultiplier * state.fiveMinuteVolatilityUsd;
    const allowedGiveback = Math.max(state.givebackFraction * peak, minVolatility);
    const candidateFloor = Math.max(0, peak - allowedGiveback);
    state.minimumAllowedGivebackUsd = minVolatility;
    state.allowedGivebackUsd = allowedGiveback;
    state.trailingFloorNetUsd = state.trailingFloorNetUsd === null
      ? candidateFloor
      : Math.max(state.trailingFloorNetUsd, candidateFloor);
  }
  return null;
}

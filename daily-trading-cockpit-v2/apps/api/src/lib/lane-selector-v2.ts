import {
  deriveVariantGeometry,
  VARIANT_MATRIX_DEFINITIONS,
  type VariantExitRule,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
  type VariantMatrixVariantId,
} from "./current-guard-variant-matrix.js";

type Direction = "LONG" | "SHORT";

export interface LaneSelectorV2BreakdownRow {
  key: string;
  n: number;
  netAvgR: number | null;
}

export interface LaneSelectorV2LaneState {
  variantId: string;
  status: string | null;
  freshValid?: number | null;
  netAvgR?: number | null;
  pf?: number | null;
  wr?: number | null;
  payoffRatio?: number | null;
  avgCostR?: number | null;
  costDragR?: number | null;
  approxMaxDrawdownR?: number | null;
  topSymbolPnlShare?: number | null;
  plus10bpsStillPositive?: boolean | null;
  byRegime?: LaneSelectorV2BreakdownRow[] | null;
  byDirection?: LaneSelectorV2BreakdownRow[] | null;
  byRegimeFamily?: LaneSelectorV2BreakdownRow[] | null;
  bySymbol?: LaneSelectorV2BreakdownRow[] | null;
}

export interface LaneSelectorV2Candidate {
  symbol: string;
  direction: Direction;
  currentPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps?: number | null;
}

export interface LaneSelectorV2LaneConfig {
  variantId: VariantMatrixVariantId;
  selectedLaneId: string;
  exitRule: VariantExitRule;
  definition: VariantMatrixVariantDefinition;
}

export interface LaneSelectorV2Geometry {
  lane: LaneSelectorV2LaneConfig;
  entry: number;
  stop: number;
  tp1: number;
  stopDistanceBps: number;
  score: number;
  scoreBreakdown: LaneSelectorV2ScoreBreakdown;
}

export interface LaneSelectorV2ScoreBreakdown {
  globalEdge: number;
  regimeEdge: number;
  symbolEdge: number;
  pfQuality: number;
  wrQuality: number;
  payoffQuality: number;
  confidence: number;
  drawdownPenalty: number;
  costPenalty: number;
  stressPenalty: number;
  concentrationPenalty: number;
  geometryPenalty: number;
  total: number;
}

export interface LaneSelectorV2EstimatedRegime {
  posture: "EXTENDED_TREND" | "TACTICAL_OR_MIXED";
  direction: Direction | "MIXED" | null;
  policy: "WIDE_TREND" | "TACTICAL_70_30";
  reason: string;
}

export interface LaneSelectorV2Inputs {
  candidate: LaneSelectorV2Candidate;
  laneStates: LaneSelectorV2LaneState[];
  regime: string | null;
  controllerMode: string | null;
  controllerConfidence?: string | null;
  estimatedRegime?: LaneSelectorV2EstimatedRegime | null;
  now: string;
  maxStopDistanceBps?: number;
}

export interface LaneSelectorV2Result {
  selected: LaneSelectorV2Geometry | null;
  rejected: string[];
  evaluated: Array<{
    variantId: VariantMatrixVariantId;
    selectedLaneId: string;
    score: number;
    scoreBreakdown: LaneSelectorV2ScoreBreakdown;
  }>;
}

const DEFAULT_MAX_STOP_DISTANCE_BPS = 1200;
const MIN_REGIME_SAMPLE = 10;
const MIN_SYMBOL_SAMPLE = 5;
// LONG extended-trend lane (operator 2026-06-29): fast 0.5R bank instead of the 1R wide. Fires only
// in a confident WIDE_TREND bull.
const LONG_LANE_VARIANT_ID: VariantMatrixVariantId = "CG_WIDE_FAST_LONG";
// SHORT lane — sole allocation since 2026-07-01 (CG_WIDE_STOP_TP_WIDE cut from the split; see
// policyPreferredVariants).
const SHORT_FAST_VARIANT_ID: VariantMatrixVariantId = "CG_WIDE_FAST_SHORT";
// LONG extended-trend lane: operator re-enabled CG_WIDE_STOP_TP_WIDE (1R wide) as the long lane
// (2026-06-29) to re-test it live against the rebuilt fresh / measurement. Longs fire only in a
// confident WIDE_TREND bull (policyBlockReason gates tactical longs off).
const MIXED_SYMBOL_BLOCKLIST = new Set(["NEARUSDT"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: unknown, fallback = 0): number {
  return isFiniteNumber(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function laneSelectorV2ControllerAllowsDirection(mode: string | null | undefined, direction: Direction): boolean {
  const m = (mode ?? "").toUpperCase();
  if (m === "BOTH_ALLOWED" || m === "VALIDATION_ONLY") return true;
  if (direction === "SHORT") return m === "SHORT_ONLY";
  return m === "LONG_ONLY";
}

export function isLaneSelectorV2LiveSupportedDefinition(def: VariantMatrixVariantDefinition): boolean {
  // A maker_limit edge cannot be mirrored through a MARKET executor without changing its economics.
  return def.fillMode === "taker";
}

const LANE_CONFIGS = new Map<VariantMatrixVariantId, LaneSelectorV2LaneConfig>(
  VARIANT_MATRIX_DEFINITIONS.filter(isLaneSelectorV2LiveSupportedDefinition).map((def) => [
    def.id,
    {
      variantId: def.id,
      selectedLaneId: `CG_VARIANT_MATRIX:${def.id}`,
      exitRule: def.exitRule,
      definition: def,
    },
  ]),
);

export const LANE_SELECTOR_V2_LIVE_SUPPORTED_VARIANT_IDS = Array.from(LANE_CONFIGS.keys());

export function isLaneSelectorV2SupportedVariantId(id: string | null | undefined): id is VariantMatrixVariantId {
  return LANE_CONFIGS.has(id as VariantMatrixVariantId);
}

export function laneSelectorV2LaneId(variantId: VariantMatrixVariantId): string {
  return LANE_CONFIGS.get(variantId)?.selectedLaneId ?? `CG_VARIANT_MATRIX:${variantId}`;
}

export function isLaneSelectorV2LongWideStopOverride(input: {
  variantId: string | null | undefined;
  direction: Direction;
  estimatedRegime: LaneSelectorV2EstimatedRegime;
}): boolean {
  return (
    input.variantId === LONG_LANE_VARIANT_ID &&
    input.direction === "LONG" &&
    input.estimatedRegime.policy === "WIDE_TREND" &&
    input.estimatedRegime.direction === "LONG"
  );
}

function variantSupportsDirection(def: VariantMatrixVariantDefinition, direction: Direction): boolean {
  if (def.longOnly && direction !== "LONG") return false;
  if (def.shortOnly && direction !== "SHORT") return false;
  return true;
}

function matchedCohortNet(rows: LaneSelectorV2BreakdownRow[] | null | undefined, key: string, minSample: number): number | null {
  const wanted = key.toLowerCase();
  const row = rows?.find((candidate) => {
    const candidateKey = candidate.key.toLowerCase();
    return candidateKey === wanted || wanted.includes(candidateKey) || candidateKey.includes(wanted);
  });
  if (!row || row.n < minSample || !isFiniteNumber(row.netAvgR)) return null;
  return row.netAvgR;
}

function scoreLane(
  state: LaneSelectorV2LaneState,
  geometry: { stopDistanceBps: number },
  candidate: LaneSelectorV2Candidate,
  regime: string | null,
): LaneSelectorV2ScoreBreakdown {
  const fresh = Math.max(0, numeric(state.freshValid));
  const confidence = clamp(Math.log10(fresh + 1) / Math.log10(250), 0, 1);
  const globalNet = numeric(state.netAvgR);
  const regimeNet = matchedCohortNet(state.byRegime, regime ?? "", MIN_REGIME_SAMPLE);
  const symbolNet = matchedCohortNet(state.bySymbol, candidate.symbol, MIN_SYMBOL_SAMPLE);

  const globalEdge = globalNet * (0.65 + confidence * 0.35);
  const regimeEdge = (regimeNet ?? 0) * 0.45;
  const symbolEdge = (symbolNet ?? 0) * 0.65;
  const pfQuality = clamp((numeric(state.pf, 1) - 1) * 0.08, -0.08, 0.22);
  const wrQuality = clamp((numeric(state.wr, 0.5) - 0.5) * 0.10, -0.05, 0.08);
  const payoffQuality = clamp((numeric(state.payoffRatio, 0.5) - 0.5) * 0.05, -0.04, 0.12);
  const drawdownPenalty = Math.max(0, numeric(state.approxMaxDrawdownR)) * 0.006;
  const costPenalty = Math.max(0, numeric(state.avgCostR) + numeric(state.costDragR) * 0.25);
  const stressPenalty = state.plus10bpsStillPositive === false ? 0.12 : 0;
  const concentration = numeric(state.topSymbolPnlShare);
  const concentrationPenalty = concentration > 0.4 ? (concentration - 0.4) * 0.35 : 0;
  const geometryPenalty = Math.max(0, geometry.stopDistanceBps - 600) / 10_000;

  const total =
    globalEdge +
    regimeEdge +
    symbolEdge +
    pfQuality +
    wrQuality +
    payoffQuality -
    drawdownPenalty -
    costPenalty -
    stressPenalty -
    concentrationPenalty -
    geometryPenalty;

  return {
    globalEdge,
    regimeEdge,
    symbolEdge,
    pfQuality,
    wrQuality,
    payoffQuality,
    confidence,
    drawdownPenalty,
    costPenalty,
    stressPenalty,
    concentrationPenalty,
    geometryPenalty,
    total,
  };
}

function buildSignal(candidate: LaneSelectorV2Candidate, regime: string | null, now: string): VariantMatrixSignal {
  return {
    sourceSignalId: `selector-v2:${candidate.symbol}:${now}`,
    symbol: candidate.symbol,
    direction: candidate.direction,
    entryPrice: candidate.currentPrice,
    stopLoss: candidate.stopLoss,
    tp1: candidate.takeProfitLevels[0] ?? 0,
    tp2: candidate.takeProfitLevels[1] ?? null,
    tp3: candidate.takeProfitLevels[2] ?? null,
    stopDistanceBps: candidate.stopDistanceBps ?? null,
    regime,
    entryVariant: null,
    openedAt: now,
    closedAt: null,
  };
}

export function estimateLaneSelectorV2Regime(input: {
  regime: string | null;
  controllerMode: string | null;
  confidence?: string | null;
}): LaneSelectorV2EstimatedRegime {
  const regime = (input.regime ?? "").toLowerCase();
  const mode = (input.controllerMode ?? "").toUpperCase();
  const confidence = (input.confidence ?? "").toUpperCase();
  const mixed =
    mode === "VALIDATION_ONLY" ||
    mode === "NO_TRADE_CHOP" ||
    mode === "BOTH_ALLOWED" ||
    /mixed|rotation|chop|range|sideways|neutral|unknown/.test(regime);
  const direction: Direction | "MIXED" | null =
    mixed
      ? "MIXED"
      : mode === "LONG_ONLY" || /bull|long/.test(regime)
        ? "LONG"
        : mode === "SHORT_ONLY" || /bear|short/.test(regime)
          ? "SHORT"
          : null;
  const trendLike = /trend|expansion|pressure|continuation|impulse|breakout|strong/.test(regime);
  const confidenceOk = confidence === "MEDIUM" || confidence === "HIGH";
  if (direction !== null && direction !== "MIXED" && trendLike && confidenceOk) {
    return {
      posture: "EXTENDED_TREND",
      direction,
      policy: "WIDE_TREND",
      reason: `${direction} extended: mode=${mode || "n/a"} confidence=${confidence || "n/a"} regime=${input.regime ?? "n/a"}`,
    };
  }
  return {
    posture: "TACTICAL_OR_MIXED",
    direction,
    policy: "TACTICAL_70_30",
    reason: `tactical: mode=${mode || "n/a"} confidence=${confidence || "n/a"} regime=${input.regime ?? "n/a"}`,
  };
}

function policyPreferredVariants(
  inputs: LaneSelectorV2Inputs,
  estimated: LaneSelectorV2EstimatedRegime,
): VariantMatrixVariantId[] {
  if (
    estimated.policy === "WIDE_TREND" &&
    estimated.direction === "LONG" &&
    inputs.candidate.direction === "LONG"
  ) {
    return [LONG_LANE_VARIANT_ID];
  }
  // 2026-07-01 (operator): CG_WIDE_STOP_TP_WIDE cut from the SHORT split — real-money data showed a
  // stark testnet-vs-live divergence (testnet +$60.55/459 closed historically, but live -$4.56/22
  // closed/13.6% WR). CG_WIDE_FAST_SHORT is the only lane confirmed positive on BOTH venues
  // (testnet +$25.12/87 closed, live +$4.61/7 closed) — 100% SHORT allocation until re-proven.
  if (inputs.candidate.direction === "SHORT") {
    return [SHORT_FAST_VARIANT_ID];
  }
  return [];
}

function policyBlockReason(inputs: LaneSelectorV2Inputs, estimated: LaneSelectorV2EstimatedRegime): string | null {
  if (estimated.direction === "MIXED" && MIXED_SYMBOL_BLOCKLIST.has(inputs.candidate.symbol.toUpperCase())) {
    return `mixed_symbol_blocked:${inputs.candidate.symbol}`;
  }
  if (inputs.candidate.direction === "LONG" && estimated.policy !== "WIDE_TREND") {
    // Longs fire ONLY in a confident WIDE_TREND bull (CG_WIDE_STOP_TP_WIDE lane); tactical/mixed
    // longs stay disabled. Re-enabled by operator 2026-06-29 to re-test against the fresh / feed.
    return "long_tactical_disabled";
  }
  return null;
}

export function selectLaneV2(inputs: LaneSelectorV2Inputs): LaneSelectorV2Result {
  const rejected: string[] = [];
  const evaluated: LaneSelectorV2Result["evaluated"] = [];
  const candidate = inputs.candidate;
  if (!laneSelectorV2ControllerAllowsDirection(inputs.controllerMode, candidate.direction)) {
    return { selected: null, rejected: [`controller_blocks_${candidate.direction}`], evaluated };
  }

  const maxStopDistanceBps = inputs.maxStopDistanceBps ?? DEFAULT_MAX_STOP_DISTANCE_BPS;
  const signal = buildSignal(candidate, inputs.regime, inputs.now);
  let best: LaneSelectorV2Geometry | null = null;
  const byVariant = new Map<VariantMatrixVariantId, LaneSelectorV2Geometry>();
  const estimated = inputs.estimatedRegime ?? estimateLaneSelectorV2Regime({
    regime: inputs.regime,
    controllerMode: inputs.controllerMode,
    confidence: inputs.controllerConfidence,
  });
  const blockReason = policyBlockReason(inputs, estimated);
  if (blockReason) {
    return { selected: null, rejected: [blockReason], evaluated };
  }

  for (const state of inputs.laneStates) {
    const statusAllowed =
      state.status === "STABLE_CANDIDATE" ||
      isLaneSelectorV2LongWideStopOverride({
        variantId: state.variantId,
        direction: candidate.direction,
        estimatedRegime: estimated,
      });
    if (!statusAllowed) {
      rejected.push(`${state.variantId}:status_${state.status ?? "unknown"}`);
      continue;
    }
    if (!isLaneSelectorV2SupportedVariantId(state.variantId)) {
      rejected.push(`${state.variantId}:unsupported_live_geometry`);
      continue;
    }
    const config = LANE_CONFIGS.get(state.variantId)!;
    if (!variantSupportsDirection(config.definition, candidate.direction)) {
      rejected.push(`${state.variantId}:direction_${candidate.direction}_unsupported`);
      continue;
    }
    const geometry = deriveVariantGeometry(signal, config.definition);
    if (geometry.kind !== "ok") {
      rejected.push(`${state.variantId}:geometry_${geometry.kind}`);
      continue;
    }
    const tp1 = geometry.takeProfitLevels[0];
    if (!isFiniteNumber(tp1) || tp1 <= 0) {
      rejected.push(`${state.variantId}:missing_tp`);
      continue;
    }
    if (!(geometry.stopDistanceBps > 0) || geometry.stopDistanceBps > maxStopDistanceBps) {
      rejected.push(`${state.variantId}:stop_distance_${geometry.stopDistanceBps.toFixed(1)}bps`);
      continue;
    }

    const scoreBreakdown = scoreLane(state, geometry, candidate, inputs.regime);
    const scored: LaneSelectorV2Geometry = {
      lane: config,
      entry: geometry.entryPrice,
      stop: geometry.stopLoss,
      tp1,
      stopDistanceBps: geometry.stopDistanceBps,
      score: scoreBreakdown.total,
      scoreBreakdown,
    };
    evaluated.push({
      variantId: config.variantId,
      selectedLaneId: config.selectedLaneId,
      score: scored.score,
      scoreBreakdown,
    });
    byVariant.set(config.variantId, scored);
    if (!best || scored.score > best.score) best = scored;
  }

  evaluated.sort((left, right) => right.score - left.score);
  const preferredVariants = policyPreferredVariants(inputs, estimated);
  for (const variantId of preferredVariants) {
    const policyPick = byVariant.get(variantId);
    if (policyPick) return { selected: policyPick, rejected, evaluated };
    rejected.push(`${variantId}:policy_target_unavailable`);
  }
  if (preferredVariants.length > 0) {
    return { selected: null, rejected, evaluated };
  }
  return { selected: best, rejected, evaluated };
}

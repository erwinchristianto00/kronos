import {
  deriveVariantGeometry,
  VARIANT_MATRIX_DEFINITIONS,
  type ExactLaneContext,
  type VariantContextEvidenceRow,
  type VariantExitRule,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
  type VariantMatrixVariantId,
} from "./current-guard-variant-matrix.js";
import {
  rotationLaneIdForVariant,
  rotationRegimeFamilyForLabel,
  rotationShortlistDecision,
  type RegimeRotationShortlistReport,
} from "./regime-rotation-shortlist.js";

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
  byAxisSymbol?: LaneSelectorV2BreakdownRow[] | null;
  bySymbol?: LaneSelectorV2BreakdownRow[] | null;
  /** Canonical proof rows supplied by the scan runtime. Generic `status` is diagnostic only there. */
  contextRows?: Partial<Record<ExactLaneContext, VariantContextEvidenceRow>>;
  /** Exact context resolved by the scan adapter for this candidate. */
  exactContext?: ExactLaneContext | null;
  /** When true, missing exact proof is a hard stop rather than a legacy direct-caller fallback. */
  exactContextResolved?: boolean;
  /** Explicit operator force. This bypasses maturity only; it never changes evidence status. */
  operatorForceEligible?: boolean;
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
  rotationShortlist?: RegimeRotationShortlistReport | null;
  /** Operator override (REALTIME_SHORT_FORCE_FAST_LONG, 2026-07-07 "gw mau trade di saat regime
   *  bullish"): lets LONG candidates through the tactical-longs policy block. The controller
   *  direction gate still runs FIRST — a forced long never fires in SHORT_ONLY/NO_TRADE. */
  allowTacticalLongs?: boolean;
  /** Variant ids the operator/regime-autopilot has EXPLICITLY allocated right now (2026-07-08:
   *  "wire lane baru ke allocation selection, jangan sampe ada blocker"). Non-empty ⇒ bypasses
   *  policyPreferredVariants' hardcoded single-variant-per-direction default, the SAME escape
   *  hatch the rotation-shortlist ALLOW verdict already uses — an explicit operator/preset
   *  allocation is a stronger signal than the bot's own historical-safety fallback. */
  manualEnabledVariantIds?: Set<string>;
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
      selectedLaneId: rotationLaneIdForVariant(def.id),
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

/** True when the given variant id is a LIVE-supported VM variant that can trade LONG (i.e. not
 *  shortOnly). Unknown/unsupported ids (including non-VM lane ids like CROSS_SECTIONAL_TREND or
 *  SHORT_FADE_EXHAUSTION_CROWDED) are NOT long-capable by this check — used to scope
 *  allowTacticalLongs to an allocation that actually contains a LONG-capable variant, instead of
 *  any non-empty allocation regardless of direction (see realtime-short-mirror.ts). */
export function isLaneSelectorV2LongCapableVariantId(id: string | null | undefined): boolean {
  const config = LANE_CONFIGS.get(id as VariantMatrixVariantId);
  return config !== undefined && !config.definition.shortOnly;
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

/** Per-symbol REAL-admission block (see excludedSymbols doc on VariantMatrixVariantDefinition).
 *  Measurement (current-guard-variant-matrix.ts) is untouched — only this live/testnet selection
 *  path is gated, so OOS proof keeps collecting on blocked symbols in case they recover. */
function variantSupportsSymbol(def: VariantMatrixVariantDefinition, symbol: string): boolean {
  if (!def.excludedSymbols || def.excludedSymbols.length === 0) return true;
  return !def.excludedSymbols.includes(symbol.toUpperCase());
}

// Exact match only. Substring containment previously used here (`wanted.includes(candidateKey) ||
// candidateKey.includes(wanted)`) silently matched an unrelated cohort whenever one key happened to
// be a substring of another — a real risk for ticker symbols (e.g. Binance's own "1000PEPEUSDT" vs
// a hypothetical "PEPEUSDT") and compound axis-symbol keys, not just a theoretical one. This value
// feeds directly into lane-selection scoring for the real-time short mirror (real order placement),
// so a wrong cohort match would silently misattribute another symbol/regime's historical edge.
function matchedCohortNet(rows: LaneSelectorV2BreakdownRow[] | null | undefined, key: string, minSample: number): number | null {
  const wanted = key.toLowerCase();
  const row = rows?.find((candidate) => candidate.key.toLowerCase() === wanted);
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
  const axisSymbolNet = matchedCohortNet(
    state.byAxisSymbol,
    `${candidate.direction}_${rotationRegimeFamilyForLabel(regime)}|${candidate.symbol}`,
    MIN_SYMBOL_SAMPLE,
  );

  const globalEdge = globalNet * (0.65 + confidence * 0.35);
  const regimeEdge = (regimeNet ?? 0) * 0.45;
  const symbolEdge = (axisSymbolNet ?? symbolNet ?? 0) * 0.65;
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
  shortlistEligibleVariantIds: Set<VariantMatrixVariantId>,
): VariantMatrixVariantId[] {
  if (shortlistEligibleVariantIds.size > 0) return [];
  // 2026-07-08 (operator: "wire lane baru ke allocation selection, jangan sampe ada blocker"): an
  // explicit operator/regime-autopilot allocation is a stronger, more current signal than the
  // hardcoded historical-safety default below — bypass it the SAME way the rotation-shortlist
  // ALLOW verdict already does, so a newly-allocated lane (e.g. CG_WIDE_LONG_RUNNER,
  // CG_MFE_GIVEBACK) can actually win selection on score instead of being silently overridden.
  if (inputs.manualEnabledVariantIds && inputs.manualEnabledVariantIds.size > 0) return [];
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
  if (inputs.candidate.direction === "LONG" && estimated.policy !== "WIDE_TREND" && !inputs.allowTacticalLongs) {
    // Longs fire ONLY in a confident WIDE_TREND bull (CG_WIDE_STOP_TP_WIDE lane); tactical/mixed
    // longs stay disabled. Re-enabled by operator 2026-06-29 to re-test against the fresh / feed.
    // 2026-07-07 operator override: allowTacticalLongs (REALTIME_SHORT_FORCE_FAST_LONG) opens this
    // for bullish-but-not-yet-extended regimes; the controller direction gate upstream still
    // blocks longs whenever the regime doesn't allow them.
    return "long_tactical_disabled";
  }
  return null;
}

function rotationShortlistAllowsState(
  inputs: LaneSelectorV2Inputs,
  state: LaneSelectorV2LaneState,
  estimated: LaneSelectorV2EstimatedRegime,
): boolean {
  const regimeFamily =
    estimated.direction === "LONG"
      ? "BULLISH"
      : estimated.direction === "SHORT"
        ? "BEARISH"
        : rotationRegimeFamilyForLabel(inputs.regime);
  return rotationShortlistDecision(inputs.rotationShortlist, {
    variantId: state.variantId,
    laneId: laneSelectorV2LaneId(state.variantId as VariantMatrixVariantId),
    symbol: inputs.candidate.symbol,
    direction: inputs.candidate.direction,
    regimeFamily,
  }).allowed;
}

function rotationShortlistGateActive(
  inputs: LaneSelectorV2Inputs,
  estimated: LaneSelectorV2EstimatedRegime,
): boolean {
  if (!inputs.rotationShortlist) return false;
  const regimeFamily = rotationRegimeFamilyForLabel(inputs.regime);
  return (
    (inputs.candidate.direction === "LONG" && estimated.direction === "LONG") ||
    (inputs.candidate.direction === "SHORT" && estimated.direction === "SHORT") ||
    (inputs.candidate.direction === "LONG" && regimeFamily === "BULLISH") ||
    (inputs.candidate.direction === "SHORT" && regimeFamily === "BEARISH") ||
    // 2026-07-08: when NEITHER the estimated regime direction nor the regime-label family can be
    // determined (estimated.direction === "MIXED" and the label matches none of the bull/bear/
    // chop keywords — always true in manual-selector-mode, since controllerMode BOTH_ALLOWED
    // forces estimated.direction to MIXED regardless of the real detected regime), do NOT
    // silently skip the shortlist-proof requirement. A genuinely undetermined regime is exactly
    // the case where proof-of-edge matters MOST, not least — without this, a manually-allocated
    // lane (manualEnabledVariantIds force-lift to STABLE_CANDIDATE) could trade any symbol with
    // zero per-symbol shortlist proof simply because the ambient regime label happened not to
    // contain a recognized keyword. Deliberately distinct from a genuinely CHOP-labeled regime
    // (regimeFamily === "MIXED"), where the gate staying inactive is the existing, intentional
    // behavior — this only closes the "unclassifiable" gap, not the "confirmed chop" case.
    (estimated.direction === "MIXED" && regimeFamily === "UNKNOWN")
  );
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
  const shortlistEligibleVariantIds = new Set<VariantMatrixVariantId>();
  const estimated = inputs.estimatedRegime ?? estimateLaneSelectorV2Regime({
    regime: inputs.regime,
    controllerMode: inputs.controllerMode,
    confidence: inputs.controllerConfidence,
  });
  const blockReason = policyBlockReason(inputs, estimated);
  if (blockReason) {
    return { selected: null, rejected: [blockReason], evaluated };
  }
  const shortlistGateActive = rotationShortlistGateActive(inputs, estimated);

  for (const state of inputs.laneStates) {
    if (state.exactContextResolved === false) {
      rejected.push(`${state.variantId}:missing_exact_context`);
      continue;
    }
    if (state.status === "NOT_APPLICABLE") {
      rejected.push(`${state.variantId}:context_not_applicable`);
      continue;
    }
    const shortlistAllowed = isLaneSelectorV2SupportedVariantId(state.variantId) &&
      rotationShortlistAllowsState(inputs, state, estimated);
    const forcedMaturityEligible = state.operatorForceEligible === true && state.exactContextResolved === true;
    const statusAllowed =
      shortlistGateActive
        ? shortlistAllowed
        : forcedMaturityEligible ||
          state.status === "STABLE_CANDIDATE" ||
          (!state.contextRows && isLaneSelectorV2LongWideStopOverride({
            variantId: state.variantId,
            direction: candidate.direction,
            estimatedRegime: estimated,
          }));
    if (!statusAllowed) {
      rejected.push(shortlistGateActive
        ? `${state.variantId}:rotation_shortlist_blocked`
        : `${state.variantId}:status_${state.status ?? "unknown"}`);
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
    if (!variantSupportsSymbol(config.definition, candidate.symbol)) {
      rejected.push(`${state.variantId}:symbol_excluded_${candidate.symbol}`);
      continue;
    }
    if (shortlistAllowed) shortlistEligibleVariantIds.add(config.variantId);
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
  const preferredVariants = policyPreferredVariants(inputs, estimated, shortlistEligibleVariantIds);
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

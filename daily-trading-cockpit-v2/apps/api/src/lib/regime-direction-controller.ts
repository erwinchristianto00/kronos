/**
 * Regime Direction Controller — Phase 1 (REPORT-ONLY).
 *
 * Names a directional posture (LONG_ONLY / SHORT_ONLY / NO_TRADE_CHOP /
 * WAIT_RETEST_AFTER_DUMP / WAIT_RETEST_AFTER_PUMP / VALIDATION_ONLY / UNKNOWN)
 * from the current scan regime label alone (label-based v1 — no panic/chop
 * detection until volatility data is wired).
 *
 * STRICTLY REPORT-ONLY:
 *  - No live trading behavior influence.
 *  - No route selection influence.
 *  - No shadow admission influence.
 *  - No Kronos / Whale / Fingerprint logic influence.
 *  - No adaptive-profit-policy ranking influence.
 *  - No micro-pilot readiness influence.
 *  - No exploit shadow collection priority influence.
 *  - No external overlay behavior influence.
 *
 * `reportOnly: true` is always set on the report so consumers can enforce
 * the contract.
 *
 * Pure module: no I/O, no side effects, deterministic for any given input.
 */

export type RegimeDirectionMode =
  | "LONG_ONLY"
  | "SHORT_ONLY"
  | "BOTH_ALLOWED"
  | "NO_TRADE_CHOP"
  | "NO_TRADE_NEGATIVE_EDGE"
  | "WAIT_RETEST_AFTER_DUMP"
  | "WAIT_RETEST_AFTER_PUMP"
  | "VALIDATION_ONLY"
  | "UNKNOWN";

export type RegimeDirectionAlignment = "MATCH" | "MISMATCH" | "UNKNOWN";

export type RegimeDirectionalBias = "LONG" | "SHORT" | "NEUTRAL" | "MIXED" | "UNKNOWN";

export type RegimeDirectionConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface RegimeDirectionControllerInputPrimaryLane {
  label: string;
  dominantRegime?: string | null;
  direction?: "LONG" | "SHORT" | null;
  microPilotReady?: boolean;
}

/**
 * Honest-edge gate dependency. Any object that can return a per-(regime ×
 * direction) verdict satisfies this — RegimeEdgeMemoryStore does structurally.
 * Kept as a narrow interface so the controller stays pure and testable and does
 * not import the persistent store.
 */
export interface DirectionEdgeGate {
  verdict(
    regimeRaw: string | null | undefined,
    direction: "LONG" | "SHORT",
  ): { allowed: boolean; reasonCode: string; stat: { n: number; avgNetR: number; winRate: number } };
  /**
   * Optional: true when some LANE in this regime×direction is proven-positive,
   * even if the direction aggregate is negative. When it returns true the
   * direction is NOT vetoed (a tradeable lane exists) — the allocator's
   * lane-level veto then admits only that positive lane.
   */
  hasPositiveLane?(regimeRaw: string | null | undefined, direction: "LONG" | "SHORT"): boolean;
}

export interface RegimeDirectionControllerInput {
  currentRegime?: string | null;
  adaptiveDirectionBias?: string | null;
  primaryValidationLane?: RegimeDirectionControllerInputPrimaryLane | null;
  /**
   * Optional honest-edge gate. When provided, a direction the regime mapping
   * would allow is HARD-VETOED if its proven historical edge is non-positive —
   * so the controller can never authorize a losing direction on a momentary
   * trend vote. Omitted → pure naive mapping (back-compat for report-only callers).
   */
  edgeGate?: DirectionEdgeGate | null;
  /**
   * Optional numeric strength signals for GRADUATED confidence (2026-07-12). The current
   * regime-axis breadth composite (buildRegimeAxisTimeline(...).current.score, symmetric −1..+1)
   * and its velocity (.slopePerHour). When present on a directional-trend mode, confidence is
   * graded from the actual evidence strength instead of a hardcoded MEDIUM. Absent → the many
   * report-only string-only callers keep today's behavior verbatim (see graduateConfidence Step 0).
   */
  axisScore?: number | null;
  axisSlopePerHour?: number | null;
}

export interface RegimeDirectionControllerReportPrimaryLane {
  label: string;
  direction: "LONG" | "SHORT" | null;
  regime: string | null;
  alignment: RegimeDirectionAlignment;
  note: string;
}

export interface RegimeDirectionControllerReport {
  currentRegime: string | null;
  controllerMode: RegimeDirectionMode;
  directionalBias: RegimeDirectionalBias;
  /**
   * LIVE-SAFE confidence tier. For a directional trend it is graded from numeric evidence but
   * FLOORED to ≥ MEDIUM (Phase 1): on live, admission gates only distinguish MEDIUM||HIGH
   * (estimateLaneSelectorV2Regime confidenceOk), so a MEDIUM→HIGH upgrade is invisible to real-money
   * behavior. This is the field every existing consumer reads.
   */
  confidence: RegimeDirectionConfidence;
  /** 0..1 continuous conviction underneath the tier (2026-07-12). Telemetry/shadow. */
  convictionScore: number;
  /**
   * Un-floored graded tier (may be LOW where `confidence` is floored to MEDIUM). Telemetry/shadow
   * ONLY — read by NO gate today. A future measure-first, env-gated Phase 2 would promote this to
   * drive live once the shadow proves the LOW bucket is a genuine loser.
   */
  gradedConfidence: RegimeDirectionConfidence;

  allowsLong: boolean;
  allowsShort: boolean;
  allowsNewEntries: boolean;
  requiresRetest: boolean;

  /** True when the honest-edge gate vetoed at least one regime-allowed direction. */
  edgeGated: boolean;

  reasonCodes: string[];
  warnings: string[];

  currentValidationPrimaryLane: RegimeDirectionControllerReportPrimaryLane | null;

  reportOnly: true;
}

const REPORT_ONLY_WARNING = "controller is report-only; no behavior influence";
const MIXED_WARNING = "mixed regime should not force directional conviction";
const EDGE_VETO_WARNING =
  "every regime-allowed direction has proven-negative honest edge — no new entries until a slice proves positive";
const MISMATCH_WARNING =
  "primary validation lane is cross-regime — collection only, not live execution";

interface ModeMapping {
  controllerMode: RegimeDirectionMode;
  directionalBias: RegimeDirectionalBias;
  confidence: RegimeDirectionConfidence;
  allowsLong: boolean;
  allowsShort: boolean;
  allowsNewEntries: boolean;
  requiresRetest: boolean;
  reasonCode: string;
  warning?: string;
}

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Pure regime-string → controller-mode mapping. The order matters: panic
 * patterns are tested before generic bullish/bearish so a "panic dump" regime
 * does not collapse into a SHORT_ONLY trend mode.
 */
function mapRegimeToMode(regimeRaw: string | null | undefined): ModeMapping {
  const regime = normalize(regimeRaw);

  if (regime.length === 0) {
    return {
      controllerMode: "UNKNOWN",
      directionalBias: "UNKNOWN",
      confidence: "LOW",
      allowsLong: false,
      allowsShort: false,
      allowsNewEntries: false,
      requiresRetest: false,
      reasonCode: "REGIME_UNKNOWN",
    };
  }

  // Panic patterns must be evaluated before generic bullish/bearish trends so
  // "panic dump" does not get misclassified as a SHORT_ONLY trend regime.
  if (contains(regime, "panic") && containsAny(regime, ["dump", "down"])) {
    return {
      controllerMode: "WAIT_RETEST_AFTER_DUMP",
      directionalBias: "SHORT",
      confidence: "MEDIUM",
      allowsLong: false,
      allowsShort: true,
      allowsNewEntries: false,
      requiresRetest: true,
      reasonCode: "REGIME_DUMP_RETEST_WAIT",
    };
  }
  if (contains(regime, "panic") && containsAny(regime, ["pump", "squeeze", "up"])) {
    return {
      controllerMode: "WAIT_RETEST_AFTER_PUMP",
      directionalBias: "LONG",
      confidence: "MEDIUM",
      allowsLong: true,
      allowsShort: false,
      allowsNewEntries: false,
      requiresRetest: true,
      reasonCode: "REGIME_PUMP_RETEST_WAIT",
    };
  }

  // Chop / range / consolidation — no directional conviction.
  if (containsAny(regime, ["chop", "range", "consolidation"])) {
    return {
      controllerMode: "NO_TRADE_CHOP",
      directionalBias: "NEUTRAL",
      confidence: "MEDIUM",
      allowsLong: false,
      allowsShort: false,
      allowsNewEntries: false,
      requiresRetest: false,
      reasonCode: "REGIME_CHOP_NO_TREND",
    };
  }

  // Mixed / rotation — directional collection allowed, but no new-entry conviction.
  if (containsAny(regime, ["mixed", "rotation"])) {
    return {
      controllerMode: "VALIDATION_ONLY",
      directionalBias: "MIXED",
      confidence: "LOW",
      allowsLong: true,
      allowsShort: true,
      allowsNewEntries: false,
      requiresRetest: false,
      reasonCode: "REGIME_MIXED_NO_CONVICTION",
      warning: MIXED_WARNING,
    };
  }

  if (
    contains(regime, "bullish") &&
    containsAny(regime, ["expansion", "pressure", "breakout"])
  ) {
    return {
      controllerMode: "LONG_ONLY",
      directionalBias: "LONG",
      confidence: "MEDIUM",
      allowsLong: true,
      allowsShort: false,
      allowsNewEntries: true,
      requiresRetest: false,
      reasonCode: "REGIME_LONG_TREND",
    };
  }

  if (
    contains(regime, "bearish") &&
    containsAny(regime, ["expansion", "pressure", "breakdown"])
  ) {
    return {
      controllerMode: "SHORT_ONLY",
      directionalBias: "SHORT",
      confidence: "MEDIUM",
      allowsLong: false,
      allowsShort: true,
      allowsNewEntries: true,
      requiresRetest: false,
      reasonCode: "REGIME_SHORT_TREND",
    };
  }

  return {
    controllerMode: "UNKNOWN",
    directionalBias: "UNKNOWN",
    confidence: "LOW",
    allowsLong: false,
    allowsShort: false,
    allowsNewEntries: false,
    requiresRetest: false,
    reasonCode: "REGIME_UNKNOWN",
  };
}

// ── Graduated confidence (2026-07-12) ────────────────────────────────────────
// Replaces the hardcoded MEDIUM on directional trends with a confidence graded from the actual
// numeric evidence strength: aligned axis-breadth magnitude, aligned axis velocity, and the proven
// regime×direction edge. Two output channels — a LIVE-SAFE `confidence` (floored ≥ MEDIUM so a
// directional trend never emits LOW to a live admission gate in Phase 1) and an un-floored
// `gradedConfidence` + continuous `convictionScore` for shadow/telemetry. Multiplicative "compounded
// evidence" spine (absent signal ⇒ factor 1.0 ⇒ conviction 0.50 = today's MEDIUM), with a structural
// HIGH gate (strong breadth AND agreeing velocity, OR a strong proven edge) so three lukewarm signals
// can't mint HIGH, and a proven-negative (lane-rescued) direction can never read HIGH.
const GRAD_BREADTH_FULL = 0.45; // BULL/BEAR trend-zone edge (REGIME_AXIS_ZONES)
const GRAD_VEL_FLAT = 0.005; // axis module's flat threshold (score-units/hr)
const GRAD_VEL_FULL = 0.03; // a strong slope: ~0.18 score over the 6h OLS window
const GRAD_EDGE_R_FULL = 0.2; // a strong honest avgNetR/trade
const GRAD_EDGE_N_MIN = 30; // = EDGE_MIN_SAMPLES
const GRAD_EDGE_N_FULL = 120; // full sample trust
const GRAD_HIGH_CONV = 0.75;
const GRAD_LOW_CONV = 0.45;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clampNum(v, 0, 1);
}
const CONFIDENCE_RANK: Record<RegimeDirectionConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
function maxConfidence(a: RegimeDirectionConfidence, b: RegimeDirectionConfidence): RegimeDirectionConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}
function minConfidence(a: RegimeDirectionConfidence, b: RegimeDirectionConfidence): RegimeDirectionConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}
/** Fixed conviction for the modes that keep their hardcoded confidence (non-directional-trend). */
const FIXED_CONVICTION: Record<RegimeDirectionConfidence, number> = { HIGH: 0.85, MEDIUM: 0.5, LOW: 0.2 };

export interface GraduatedConfidence {
  /** Live-safe tier: floored ≥ MEDIUM for a directional trend (Phase 1). */
  confidence: RegimeDirectionConfidence;
  /** Un-floored tier (may be LOW). Shadow/telemetry only. */
  gradedConfidence: RegimeDirectionConfidence;
  convictionScore: number;
}

/**
 * Pure graduated-confidence helper. Deterministic; no I/O. Only ever CALLED for a directional trend
 * (LONG_ONLY/SHORT_ONLY); for any other mode the caller keeps the hardcoded confidence.
 */
export function graduateConfidence(args: {
  dir: "LONG" | "SHORT";
  axisScore: number | null | undefined;
  axisSlopePerHour: number | null | undefined;
  edgeStat: { n: number; avgNetR: number } | null | undefined;
  mappingConfidence: RegimeDirectionConfidence;
}): GraduatedConfidence {
  const d = args.dir === "LONG" ? 1 : -1;
  const axisScore =
    typeof args.axisScore === "number" && Number.isFinite(args.axisScore) ? args.axisScore : null;
  const slope =
    typeof args.axisSlopePerHour === "number" && Number.isFinite(args.axisSlopePerHour)
      ? args.axisSlopePerHour
      : null;
  const stat =
    args.edgeStat && Number.isFinite(args.edgeStat.n) && Number.isFinite(args.edgeStat.avgNetR)
      ? args.edgeStat
      : null;

  // Step 0 — back-compat: no numeric evidence at all → today's behavior verbatim.
  if (axisScore === null && (stat === null || stat.n === 0)) {
    return { confidence: args.mappingConfidence, gradedConfidence: args.mappingConfidence, convictionScore: 0.5 };
  }

  // Step 1 — aligned breadth factor (1.0 when absent/neutral).
  const aB = axisScore === null ? 0 : clampNum((d * axisScore) / GRAD_BREADTH_FULL, -1, 1);
  const gBreadth = 1 + 0.4 * aB;

  // Step 2 — aligned velocity factor (1.0 when flat/absent).
  const V = slope === null || Math.abs(slope) < GRAD_VEL_FLAT ? 0 : clampNum((d * slope) / GRAD_VEL_FULL, -1, 1);
  const gVel = 1 + 0.4 * V;

  // Step 3 — edge class + sample-weighted magnitude.
  const provenPos = stat !== null && stat.n >= GRAD_EDGE_N_MIN && stat.avgNetR > 0;
  const provenNeg = stat !== null && stat.n >= GRAD_EDGE_N_MIN && stat.avgNetR <= 0;
  let E = 0;
  let gEdge = 1;
  if (provenPos && stat) {
    const rMag = clamp01(stat.avgNetR / GRAD_EDGE_R_FULL);
    const sConf = clamp01((stat.n - GRAD_EDGE_N_MIN) / (GRAD_EDGE_N_FULL - GRAD_EDGE_N_MIN));
    E = rMag * (0.6 + 0.4 * sConf); // a barely-30-sample slice is discounted ×0.60
    gEdge = 1 + 0.5 * E;
  }

  // Step 4 — conviction (baseline × compounded agreement factors).
  const convictionScore = clamp01(0.5 * gBreadth * gVel * gEdge);

  // Step 5 — tier. Structural HIGH gate: strong breadth IN the trend zone AND agreeing velocity,
  // OR a strong well-sampled proven edge. Proven-negative (lane-rescued) can never read HIGH.
  const momentumHigh = axisScore !== null && d * axisScore >= GRAD_BREADTH_FULL && V >= 0.34;
  const edgeHigh = provenPos && E >= 0.75;
  let candidate: RegimeDirectionConfidence =
    convictionScore >= GRAD_HIGH_CONV ? "HIGH" : convictionScore < GRAD_LOW_CONV ? "LOW" : "MEDIUM";
  if (candidate === "HIGH" && !(momentumHigh || edgeHigh)) candidate = "MEDIUM";
  if (provenNeg) candidate = minConfidence(candidate, "MEDIUM");

  return {
    confidence: maxConfidence(candidate, "MEDIUM"), // Phase-1 live-safe floor
    gradedConfidence: candidate,
    convictionScore,
  };
}

/**
 * True when a regime string maps to a confirmed strong directional trend — LONG_ONLY / SHORT_ONLY,
 * the only modes carrying directional conviction with allowsNewEntries=true. Chop, mixed/rotation,
 * panic-retest and unknown are NOT strong trends. Pure; reused by the report-only regime-adaptive
 * synthetic lane (full-exit in strong trend, scaleout otherwise).
 */
export function isStrongTrendRegime(regime: string | null | undefined): boolean {
  const mode = mapRegimeToMode(regime).controllerMode;
  return mode === "LONG_ONLY" || mode === "SHORT_ONLY";
}

/**
 * Classify a regime label into its directional family.
 *  - "BULLISH" for bullish-expansion / bullish-pressure / bullish-breakout / panic-pump / squeeze
 *  - "BEARISH" for bearish-expansion / bearish-pressure / bearish-breakdown / panic-dump
 *  - null otherwise (mixed, chop, unknown — cannot be MATCH/MISMATCH compared)
 */
function regimeFamily(regimeRaw: string | null | undefined): "BULLISH" | "BEARISH" | null {
  const regime = normalize(regimeRaw);
  if (regime.length === 0) return null;

  // Panic-pump and squeeze read as bullish family for alignment purposes.
  if (contains(regime, "panic") && containsAny(regime, ["pump", "squeeze", "up"])) {
    return "BULLISH";
  }
  if (contains(regime, "panic") && containsAny(regime, ["dump", "down"])) {
    return "BEARISH";
  }
  if (contains(regime, "bullish")) return "BULLISH";
  if (contains(regime, "bearish")) return "BEARISH";
  return null;
}

function buildPrimaryLaneReport(
  currentRegimeRaw: string | null | undefined,
  lane: RegimeDirectionControllerInputPrimaryLane | null | undefined,
): { report: RegimeDirectionControllerReportPrimaryLane | null; alignment: RegimeDirectionAlignment } {
  if (!lane) {
    return { report: null, alignment: "UNKNOWN" };
  }

  // Direction is passed through from input as-is — do NOT derive from label.
  const direction = lane.direction ?? null;
  const laneRegime = typeof lane.dominantRegime === "string" && lane.dominantRegime.trim().length > 0
    ? lane.dominantRegime.trim()
    : null;

  const currentFamily = regimeFamily(currentRegimeRaw);
  const laneFamily = regimeFamily(laneRegime);

  let alignment: RegimeDirectionAlignment = "UNKNOWN";
  let note: string;

  if (currentFamily === null || laneFamily === null) {
    alignment = "UNKNOWN";
    note = "current regime or lane regime cannot be classified into a directional family";
  } else if (currentFamily === laneFamily) {
    alignment = "MATCH";
    note = `lane regime family (${laneFamily}) matches current scan regime family`;
  } else {
    alignment = "MISMATCH";
    note = `lane regime family (${laneFamily}) does not match current scan regime family (${currentFamily})`;
  }

  return {
    report: {
      label: lane.label,
      direction,
      regime: laneRegime,
      alignment,
      note,
    },
    alignment,
  };
}

/**
 * Build the regime-direction controller report for the given inputs.
 * Pure: deterministic and side-effect free.
 */
export function buildRegimeDirectionControllerReport(
  input: RegimeDirectionControllerInput,
): RegimeDirectionControllerReport {
  const currentRegimeTrimmed =
    typeof input.currentRegime === "string" && input.currentRegime.trim().length > 0
      ? input.currentRegime.trim()
      : null;

  const mapping = mapRegimeToMode(currentRegimeTrimmed);

  const reasonCodes: string[] = [mapping.reasonCode];
  const warnings: string[] = [];
  if (mapping.warning) {
    warnings.push(mapping.warning);
  }

  // ── Honest-edge gate ────────────────────────────────────────────────────
  // Prune any regime-allowed direction whose proven historical edge is
  // non-positive. This is the smart layer: it stops the chain from authorizing
  // a direction that loses money just because the regime label points that way
  // (e.g. bullish-expansion LONG at −1.0R/trade). Cold-start slices (too few
  // samples) pass through per the no-shadow policy but are flagged.
  let controllerMode = mapping.controllerMode;
  let directionalBias = mapping.directionalBias;
  let allowsLong = mapping.allowsLong;
  let allowsShort = mapping.allowsShort;
  let allowsNewEntries = mapping.allowsNewEntries;
  let edgeGated = false;
  if (input.edgeGate && currentRegimeTrimmed) {
    const gate = input.edgeGate;
    // Veto a direction only when its aggregate edge is non-positive AND no lane
    // in that slice is proven-positive. A positive lane (e.g. tight-stop SHORT)
    // keeps the direction open even if the aggregate is dragged negative by a
    // losing lane — the allocator's lane-level veto then admits only that lane.
    const directionVetoed = (dir: "LONG" | "SHORT"): boolean => {
      const v = gate.verdict(currentRegimeTrimmed, dir);
      const rescuedByLane = !v.allowed && gate.hasPositiveLane?.(currentRegimeTrimmed, dir) === true;
      reasonCodes.push(rescuedByLane ? `EDGE_LANE_RESCUE_${dir}` : `${v.reasonCode}_${dir}`);
      return !v.allowed && !rescuedByLane;
    };
    if (allowsLong && directionVetoed("LONG")) {
      allowsLong = false;
      edgeGated = true;
    }
    if (allowsShort && directionVetoed("SHORT")) {
      allowsShort = false;
      edgeGated = true;
    }
    // A trend mode that would admit entries but just lost its only tradeable
    // direction collapses to a no-trade posture — nothing is admitted on a
    // proven-loser slice.
    if (allowsNewEntries && !allowsLong && !allowsShort) {
      controllerMode = "NO_TRADE_NEGATIVE_EDGE";
      directionalBias = "NEUTRAL";
      allowsNewEntries = false;
      warnings.push(EDGE_VETO_WARNING);
    }
  }

  // ── Graduated confidence ────────────────────────────────────────────────
  // Only for a resolved directional trend (post-veto LONG_ONLY/SHORT_ONLY). Every other mode
  // (panic-retest, chop, mixed, unknown, collapsed NO_TRADE_NEGATIVE_EDGE) keeps its hardcoded
  // confidence + a fixed conviction — so all report-only string-only callers are unchanged.
  let confidence = mapping.confidence;
  let gradedConfidence = mapping.confidence;
  let convictionScore = FIXED_CONVICTION[mapping.confidence];
  const isDirectionalTrend =
    (controllerMode === "LONG_ONLY" || controllerMode === "SHORT_ONLY") &&
    (directionalBias === "LONG" || directionalBias === "SHORT");
  if (isDirectionalTrend) {
    const dir = directionalBias as "LONG" | "SHORT";
    const edgeStat =
      input.edgeGate && currentRegimeTrimmed ? input.edgeGate.verdict(currentRegimeTrimmed, dir).stat : null;
    const graded = graduateConfidence({
      dir,
      axisScore: input.axisScore,
      axisSlopePerHour: input.axisSlopePerHour,
      edgeStat,
      mappingConfidence: mapping.confidence,
    });
    confidence = graded.confidence;
    gradedConfidence = graded.gradedConfidence;
    convictionScore = graded.convictionScore;
  }

  const { report: primaryLaneReport, alignment } = buildPrimaryLaneReport(
    currentRegimeTrimmed,
    input.primaryValidationLane ?? null,
  );

  if (alignment === "MISMATCH") {
    warnings.push(MISMATCH_WARNING);
  }

  // Always last so consumers see the report-only contract at the end.
  warnings.push(REPORT_ONLY_WARNING);

  return {
    currentRegime: currentRegimeTrimmed,
    controllerMode,
    directionalBias,
    confidence,
    convictionScore,
    gradedConfidence,
    allowsLong,
    allowsShort,
    allowsNewEntries,
    requiresRetest: mapping.requiresRetest,
    edgeGated,
    reasonCodes,
    warnings,
    currentValidationPrimaryLane: primaryLaneReport,
    reportOnly: true,
  };
}

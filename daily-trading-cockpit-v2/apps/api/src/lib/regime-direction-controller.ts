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
  confidence: RegimeDirectionConfidence;

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
    confidence: mapping.confidence,
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

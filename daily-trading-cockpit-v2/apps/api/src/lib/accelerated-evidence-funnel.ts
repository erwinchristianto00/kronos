/**
 * ACCELERATED EVIDENCE FUNNEL DIAGNOSTICS (REPORT-ONLY)
 *
 * Derives admission funnel counters from the shadow position tape to help
 * explain how quickly the controller-aligned shadow lane can accumulate
 * resolved evidence. No scan log is required — all derived from positions.
 *
 * STRICTLY REPORT-ONLY: no live behavior, no route selection changes.
 */

import type { ShadowPosition } from "@dtc/shared";

import { RISK_HYGIENE_GUARD_V1 } from "./shadow-engine.js";
import type { ControllerAlignedShadowPosition } from "./regime-controller-aligned-shadow.js";
import type { CandidateFunnelEntry } from "./accelerated-evidence-candidate-funnel-log.js";

// ─── Output interface ─────────────────────────────────────────────────────────

export interface AcceleratedEvidenceFunnelReport {
  reportOnly: true;
  era: string;
  currentControllerMode: string | null;
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  recentOpened24h: number;
  stop175Eligible: number;
  stop175RejectedEstimate: number | null; // null if can't derive from positions alone
  normalShadowOpened: number;
  controllerAlignedEligible: number;
  controllerAlignedOpened: number;
  byDirection: Array<{ direction: string; n: number; openN: number; closedN: number }>;
  topRejectionReason: string | null;
  dataSourceNote: string;
  // Optional fields — populated only by buildAcceleratedEvidenceFunnelReportFromLog
  rawCandidatesLogged?: number;
  longCandidates?: number;
  shortCandidates?: number;
  controllerAllowedCandidates?: number;
  controllerBlockedCandidates?: number;
  stop175RejectedFromLog?: number;
  sourceConflictRejected?: number;
  kronosDisagreementRejected?: number;
  topRejectionReasons?: Array<{ reason: string; count: number }>;
  // Phase 2Z.1: variant-adjusted guard diagnostics (optional)
  legacy175PassFromLog?: number;
  legacy175RejectedFromLog?: number;
  variantAdjustedPassFromLog?: number;
  variantAdjustedRejectedFromLog?: number;
  avgAtrBpsFromLog?: number | null;
  medianAdjustedThresholdFromLog?: number | null;
  /**
   * By-controller-mode breakdown. Populated from log entries when available.
   * Each row aggregates candidates that were seen under a given controllerMode
   * during the window, regardless of admission outcome.
   */
  byControllerMode?: Array<{
    controllerMode: string;
    rawCandidates: number;
    allowedCandidates: number;
    blockedCandidates: number;
    stop175Pass: number;
    variantAdjustedPass: number;
    controllerAlignedEligible: number;
    controllerAlignedOpened: number;
  }>;
  /**
   * The controllerMode of the most-recent funnel log entry in the window.
   * Distinguishes the "current" mode from historical modes in the 24h window.
   */
  latestScanCycleMode?: string | null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build the accelerated evidence funnel report from available position data.
 *
 * NOTE: exact scan-cycle rejection counts (positions that were rejected before
 * creating a ShadowPosition) cannot be reconstructed from positions alone.
 * stop175RejectedEstimate is therefore null. The report is transparent about
 * this limitation via dataSourceNote.
 */
export function buildAcceleratedEvidenceFunnelReport(
  positions: ShadowPosition[],
  controllerAlignedShadowPositions: ControllerAlignedShadowPosition[],
  opts: {
    controllerMode?: string | null;
    era?: string;
  } = {},
): AcceleratedEvidenceFunnelReport {
  const era = opts.era ?? "ALL_TIME";
  const currentControllerMode = opts.controllerMode ?? null;
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // ── Position counts ──────────────────────────────────────────────────────

  const totalPositions = positions.length;

  // Open = has at least one variant in OPEN or PARTIAL state
  const openPositions = positions.filter((p) =>
    Array.isArray(p.variants) &&
    p.variants.some((v) => v.state === "OPEN" || v.state === "PARTIAL"),
  ).length;

  // Closed = has at least one variant CLOSED (not NO_FILL)
  const closedPositions = positions.filter((p) =>
    Array.isArray(p.variants) &&
    p.variants.some((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL"),
  ).length;

  // Recently opened (last 24h)
  const recentOpened24h = positions.filter((p) => {
    if (!p.scannedAt) return false;
    try {
      return new Date(p.scannedAt) >= cutoff24h;
    } catch {
      return false;
    }
  }).length;

  // ── Stop-175 guard eligibility ───────────────────────────────────────────

  // Positions stamped with the risk hygiene guard version are stop-175-eligible
  const stop175Eligible = positions.filter(
    (p) => p.riskHygieneGuardVersion === RISK_HYGIENE_GUARD_V1,
  ).length;

  // We cannot count positions that were REJECTED before being created in
  // shadow-positions.json — that count requires the execution log or scan
  // cycle counters which are not available here.
  const stop175RejectedEstimate: number | null = null;

  // Normal shadow opened = same as stop175Eligible (positions admitted past the guard)
  const normalShadowOpened = stop175Eligible;

  // ── Controller-aligned shadow counts ────────────────────────────────────

  // Eligible = admitted to the aligned lane and not NO_FILL
  const controllerAlignedEligible = controllerAlignedShadowPositions.filter(
    (p) => p.status !== "NO_FILL",
  ).length;

  const controllerAlignedOpened = controllerAlignedShadowPositions.length;

  // ── By direction ─────────────────────────────────────────────────────────

  const directionCounts: Record<string, { n: number; openN: number; closedN: number }> = {};
  for (const p of positions) {
    const dir = p.direction ?? "UNKNOWN";
    if (!directionCounts[dir]) {
      directionCounts[dir] = { n: 0, openN: 0, closedN: 0 };
    }
    directionCounts[dir].n += 1;
    const isOpen = Array.isArray(p.variants) &&
      p.variants.some((v) => v.state === "OPEN" || v.state === "PARTIAL");
    const isClosed = Array.isArray(p.variants) &&
      p.variants.some((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
    if (isOpen) directionCounts[dir].openN += 1;
    if (isClosed) directionCounts[dir].closedN += 1;
  }

  const byDirection = Object.entries(directionCounts).map(([direction, counts]) => ({
    direction,
    ...counts,
  }));

  // ── Top rejection reason ─────────────────────────────────────────────────

  // Derive heuristic from controller mode + direction distribution
  let topRejectionReason: string | null = null;

  if (currentControllerMode === "LONG_ONLY") {
    const shortCount = directionCounts["SHORT"]?.n ?? 0;
    if (shortCount > 0) {
      topRejectionReason = "SHORT_BLOCKED_BY_CONTROLLER_LONG_ONLY";
    } else {
      topRejectionReason = "CONTROLLER_LONG_ONLY_MODE";
    }
  } else if (currentControllerMode === "SHORT_ONLY") {
    const longCount = directionCounts["LONG"]?.n ?? 0;
    if (longCount > 0) {
      topRejectionReason = "LONG_BLOCKED_BY_CONTROLLER_SHORT_ONLY";
    } else {
      topRejectionReason = "CONTROLLER_SHORT_ONLY_MODE";
    }
  } else if (currentControllerMode === "NO_TRADE_CHOP") {
    topRejectionReason = "ALL_BLOCKED_NO_TRADE_CHOP";
  } else if (
    currentControllerMode === "WAIT_RETEST_AFTER_DUMP" ||
    currentControllerMode === "WAIT_RETEST_AFTER_PUMP"
  ) {
    topRejectionReason = "ALL_BLOCKED_WAIT_RETEST";
  } else if (stop175Eligible < totalPositions && totalPositions > 0) {
    // Pre-guard positions dominate
    topRejectionReason = "STOP_DISTANCE_BELOW_175BPS_PRE_GUARD_ERA";
  } else if (totalPositions === 0) {
    topRejectionReason = "NO_POSITIONS_IN_TAPE";
  } else {
    topRejectionReason = "CONTROLLER_MODE_BLOCKS_BOTH_DIRECTIONS";
  }

  return {
    reportOnly: true,
    era,
    currentControllerMode,
    totalPositions,
    openPositions,
    closedPositions,
    recentOpened24h,
    stop175Eligible,
    stop175RejectedEstimate,
    normalShadowOpened,
    controllerAlignedEligible,
    controllerAlignedOpened,
    byDirection,
    topRejectionReason,
    dataSourceNote:
      "stop175RejectedEstimate is null because rejected-before-admission counts " +
      "are not stored in shadow-positions.json. Exact reject counts require the " +
      "execution log or scan-cycle counters. All other counters are derived from " +
      "the shadow position tape and controller-aligned shadow store.",
  };
}

// ─── Log-based funnel report ─────────────────────────────────────────────────

/**
 * Build the accelerated evidence funnel report from candidate-level log entries.
 *
 * Uses the CandidateFunnelLog data to provide exact per-candidate admission
 * diagnostics, including precise stop-175 rejection counts and direction
 * breakdowns that the position-tape-based function cannot compute.
 *
 * The position-based counts (totalPositions, openPositions, etc.) are derived
 * from the controllerAlignedObs array and set to 0 for fields that require the
 * full shadow tape (which is not passed to this function).
 */
export function buildAcceleratedEvidenceFunnelReportFromLog(
  entries: CandidateFunnelEntry[],
  controllerAlignedObs: { status: string }[],
  opts: {
    windowLabel?: string;
    currentControllerMode?: string | null;
  } = {},
): AcceleratedEvidenceFunnelReport {
  const era = opts.windowLabel ?? "LAST_24H_LOG";
  const currentControllerMode = opts.currentControllerMode ?? null;

  const rawCandidatesLogged = entries.length;
  const longCandidates = entries.filter((e) => e.direction === "LONG").length;
  const shortCandidates = entries.filter((e) => e.direction === "SHORT").length;
  const controllerAllowedCandidates = entries.filter((e) => e.controllerAllowsDirection).length;
  const controllerBlockedCandidates = entries.filter((e) => !e.controllerAllowsDirection).length;
  const stop175RejectedFromLog = entries.filter(
    (e) => e.rejectionReasons.includes("STOP_DISTANCE_BELOW_175"),
  ).length;
  const sourceConflictRejected = entries.filter(
    (e) =>
      e.rejectionReasons.includes("SOURCE_CONFLICT_TRUE") ||
      e.rejectionReasons.includes("LIVE_SOURCE_CONFLICT_TRUE"),
  ).length;
  const kronosDisagreementRejected = entries.filter(
    (e) => e.rejectionReasons.includes("KRONOS_DISAGREES"),
  ).length;

  // Aggregate rejection reason counts
  const reasonCounts: Record<string, number> = {};
  for (const entry of entries) {
    for (const reason of entry.rejectionReasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  const topRejectionReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // Top single rejection reason string
  const topRejectionReason = topRejectionReasons[0]?.reason ?? null;

  // Phase 2Z.1: variant-adjusted guard diagnostics from funnel log
  const legacy175PassFromLog = entries.filter((e) => e.legacyStop175Pass === true).length;
  const legacy175RejectedFromLog = entries.filter((e) => e.legacyStop175Pass === false).length;
  const variantAdjustedPassFromLog = entries.filter((e) => e.variantAdjustedStopPass === true).length;
  const variantAdjustedRejectedFromLog = entries.filter((e) => e.variantAdjustedStopPass === false).length;

  const atrBpsValues = entries
    .map((e) => e.atrBps)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgAtrBpsFromLog = atrBpsValues.length > 0
    ? atrBpsValues.reduce((s, v) => s + v, 0) / atrBpsValues.length
    : null;

  const thresholdValues = entries
    .map((e) => e.variantAdjustedGuardThresholdBps)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const medianAdjustedThresholdFromLog = thresholdValues.length > 0
    ? thresholdValues[Math.floor(thresholdValues.length / 2)] ?? null
    : null;

  // Controller-aligned counts from aligned obs (pass-through)
  const controllerAlignedEligible = controllerAlignedObs.filter(
    (p) => p.status !== "NO_FILL",
  ).length;
  const controllerAlignedOpened = controllerAlignedObs.length;

  // By-controller-mode breakdown
  const modeCountsMap: Record<string, {
    rawCandidates: number;
    allowedCandidates: number;
    blockedCandidates: number;
    stop175Pass: number;
    variantAdjustedPass: number;
    controllerAlignedEligible: number;
    controllerAlignedOpened: number;
  }> = {};
  for (const entry of entries) {
    const mode = entry.controllerMode ?? "UNKNOWN";
    if (!modeCountsMap[mode]) {
      modeCountsMap[mode] = {
        rawCandidates: 0,
        allowedCandidates: 0,
        blockedCandidates: 0,
        stop175Pass: 0,
        variantAdjustedPass: 0,
        controllerAlignedEligible: 0,
        controllerAlignedOpened: 0,
      };
    }
    const row = modeCountsMap[mode]!;
    row.rawCandidates += 1;
    if (entry.controllerAllowsDirection) row.allowedCandidates += 1;
    else row.blockedCandidates += 1;
    if (entry.legacyStop175Pass === true || entry.stop175Pass === true) row.stop175Pass += 1;
    if (entry.variantAdjustedStopPass === true) row.variantAdjustedPass += 1;
    if (entry.controllerAlignedEligible) row.controllerAlignedEligible += 1;
    if (entry.controllerAlignedOpened) row.controllerAlignedOpened += 1;
  }
  const byControllerMode = Object.entries(modeCountsMap).map(([controllerMode, counts]) => ({
    controllerMode,
    ...counts,
  }));

  // Latest scan-cycle mode (most recent entry's controllerMode)
  const latestScanCycleMode = entries.length > 0
    ? (entries[entries.length - 1]?.controllerMode ?? null)
    : null;

  // By-direction counts from entries
  const directionCounts: Record<string, { n: number; openN: number; closedN: number }> = {};
  for (const entry of entries) {
    const dir = entry.direction ?? "UNKNOWN";
    if (!directionCounts[dir]) {
      directionCounts[dir] = { n: 0, openN: 0, closedN: 0 };
    }
    directionCounts[dir].n += 1;
    if (entry.controllerAlignedOpened) {
      directionCounts[dir].openN += 1;
    }
  }
  const byDirection = Object.entries(directionCounts).map(([direction, counts]) => ({
    direction,
    ...counts,
  }));

  return {
    reportOnly: true,
    era,
    currentControllerMode,
    // Position-tape fields — set to 0 since we don't have the full tape here
    totalPositions: 0,
    openPositions: 0,
    closedPositions: 0,
    recentOpened24h: entries.filter((e) => e.normalShadowEligible).length,
    stop175Eligible: entries.filter((e) => e.stop175Pass === true).length,
    stop175RejectedEstimate: stop175RejectedFromLog,
    normalShadowOpened: entries.filter((e) => e.normalShadowEligible).length,
    controllerAlignedEligible,
    controllerAlignedOpened,
    byDirection,
    topRejectionReason,
    dataSourceNote:
      "Counts derived from candidate-level funnel log (accelerated-evidence-candidate-funnel.jsonl). " +
      "Exact per-candidate admission diagnostics are available; position-tape fields (totalPositions, " +
      "openPositions, closedPositions) are unavailable in this data source and set to 0.",
    // Log-specific fields
    rawCandidatesLogged,
    longCandidates,
    shortCandidates,
    controllerAllowedCandidates,
    controllerBlockedCandidates,
    stop175RejectedFromLog,
    sourceConflictRejected,
    kronosDisagreementRejected,
    topRejectionReasons,
    // Phase 2Z.1: variant-adjusted guard diagnostics
    legacy175PassFromLog,
    legacy175RejectedFromLog,
    variantAdjustedPassFromLog,
    variantAdjustedRejectedFromLog,
    avgAtrBpsFromLog,
    medianAdjustedThresholdFromLog,
    // By-controller-mode breakdown and latest mode
    byControllerMode,
    latestScanCycleMode,
  };
}

import {
  classifyEvidenceEra,
  type ShadowExecutionEvent,
  type ShadowPosition,
  type ShadowVariantPosition,
} from "@dtc/shared";

import { BASE_ROUTE_POLICY_VERSION_V2, MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT, RISK_HYGIENE_GUARD_V1, STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK } from "./shadow-engine.js";
import {
  buildBaseRouteCurrentGuardStabilityReport,
  type BaseRouteCurrentGuardStabilityReport,
  type CurrentGuardClosedPosition,
} from "./base-route-current-guard-stability-audit.js";

type EvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

const TIGHT_STOP_DISTANCE_BPS = 175;
const MIN_CLOSED_FOR_CURRENT_GUARD_JUDGMENT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BaseRouteRiskHygieneMonitorVerdict =
  | "TOO_EARLY"
  | "COLLECTING_CLEAN_TAPE"
  | "COLLECTING_CURRENT_GUARD_TAPE"
  | "CURRENT_GUARD_OUTCOME_NEGATIVE"
  | "RISK_HYGIENE_IMPROVING"
  | "GUARD_ACTIVE_BUT_CLEAN_TAPE_AMBIGUOUS"
  | "RISK_HYGIENE_NOT_CONFIRMED";

export interface BaseRouteRiskHygieneMonitor {
  guardReasonCode: typeof STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK;
  guardThresholdBps: number;
  guardActivatedAtRetainedLog: string | null;
  skippedUltraTightCandidates: {
    total: number;
    recent24h: number;
  };
  /** Current-guard tape: positions stamped with riskHygieneGuardMinStopDistanceBps === current threshold (175). */
  postGuardTape: {
    closedN: number;
    openN: number;
    avgCostR: number | null;
    grossAvgR: number | null;
    netAvgR: number | null;
    grossToNetDrag: number | null;
    ultraTightClosedN: number;
    below175ClosedN: number;
    below100ClosedN: number;
    anchorConsistentPositionCount: number;
    mixedOrLegacyPositionCount: number;
  };
  /** Previous hygiene tape: anchor-consistent V2 positions that predate the current guard version stamp. */
  previousHygieneTape: {
    closedN: number;
    avgCostR: number | null;
    netAvgR: number | null;
    below175ClosedN: number;
    note: string;
  };
  legacyOrMixedTape: {
    closedN: number;
    avgCostR: number | null;
    grossToNetDrag: number | null;
    note: string;
  };
  verdict: BaseRouteRiskHygieneMonitorVerdict;
  /**
   * Report-only structured lane summary derived from the current-guard tape.
   * Wired into the Shadow Lane Scoreboard, Live Trading Gate (candidate ranking),
   * and Strategic Roadmap (keep-testing list). Does NOT influence live behavior,
   * admission, route selection, or readiness gates.
   */
  currentGuardLaneSummary?: BaseRouteCurrentGuardLaneSummary;
  /**
   * Report-only: the current-guard closed positions used by the lane summary,
   * exposed so the F** stability audit and F*** frozen prospective tape can
   * consume the exact same set. Does NOT influence live behavior.
   */
  currentGuardClosedPositions?: CurrentGuardClosedPosition[];
  /**
   * Report-only: deep stability audit (F**) of the current-guard tape.
   * Does NOT influence live behavior, admission, or readiness.
   */
  stabilityReport?: BaseRouteCurrentGuardStabilityReport;
}

export interface BaseRouteCurrentGuardLaneSummary {
  reportOnly: true;
  laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD";
  source: "F*. Base Route Risk Hygiene Monitor";

  // counts
  closed: number;
  open: number;
  wins: number;
  losses: number;

  // economics
  grossAvgR: number | null;
  netAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  wr: number | null;
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;

  // breakdowns
  byRegime: Array<{ regime: string; n: number; netAvgR: number | null }>;
  symbolConcentration: Array<{ symbol: string; n: number; netAvgR: number | null; share: number }>;
  byRoute: Array<{ entryVariant: string; n: number; netAvgR: number | null }>;

  // recency split
  recencySplit: {
    earlyHalf: { n: number; netAvgR: number | null; pf: number | null } | null;
    lateHalf: { n: number; netAvgR: number | null; pf: number | null } | null;
    stable: boolean | null;
  };

  // gate
  status: "COLLECTING" | "WATCHABLE" | "PROMOTION_CANDIDATE" | "REJECT";
  statusReason: string;

  cautions: string[];
}

interface ClosedVariantSlice {
  stopDistanceBps: number | null;
  costR: number | null;
  realizedGrossR: number | null;
  realizedNetR: number | null;
}

function avg(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function isOpen(position: ShadowPosition): boolean {
  return (position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED");
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isClosedFilledVariant(variant: ShadowVariantPosition): boolean {
  return variant.state === "CLOSED" && variant.closeReason !== "NO_FILL";
}

function flattenClosedSlices(positions: ShadowPosition[]): ClosedVariantSlice[] {
  const slices: ClosedVariantSlice[] = [];
  for (const position of positions) {
    for (const variant of position.variants) {
      if (!isClosedFilledVariant(variant)) continue;
      slices.push({
        stopDistanceBps: position.stopDistanceBps ?? position.variantSelection?.stopDistanceBps ?? null,
        costR: position.costR ?? position.variantSelection?.costR ?? null,
        realizedGrossR: variant.realizedGrossR ?? null,
        realizedNetR: variant.realizedNetR ?? null,
      });
    }
  }
  return slices;
}

function buildCurrentGuardTapeSummary(positions: ShadowPosition[]): BaseRouteRiskHygieneMonitor["postGuardTape"] {
  const closed = flattenClosedSlices(positions);
  const grossAvgR = avg(closed.map((slice) => slice.realizedGrossR));
  const netAvgR = avg(closed.map((slice) => slice.realizedNetR));
  return {
    closedN: closed.length,
    openN: positions.filter((position) => isOpen(position)).length,
    avgCostR: avg(closed.map((slice) => slice.costR)),
    grossAvgR,
    netAvgR,
    grossToNetDrag:
      grossAvgR !== null && netAvgR !== null
        ? grossAvgR - netAvgR
        : null,
    ultraTightClosedN: closed.filter((slice) => slice.stopDistanceBps !== null && slice.stopDistanceBps < TIGHT_STOP_DISTANCE_BPS).length,
    below175ClosedN: closed.filter((slice) => slice.stopDistanceBps !== null && slice.stopDistanceBps < TIGHT_STOP_DISTANCE_BPS).length,
    below100ClosedN: closed.filter((slice) => slice.stopDistanceBps !== null && slice.stopDistanceBps < 100).length,
    anchorConsistentPositionCount: positions.filter((position) => position.policyVersion === BASE_ROUTE_POLICY_VERSION_V2).length,
    mixedOrLegacyPositionCount: positions.filter((position) => position.policyVersion !== BASE_ROUTE_POLICY_VERSION_V2).length,
  };
}

interface ClosedPositionRecord {
  symbol: string;
  regime: string;
  entryVariant: string;
  openedAtMs: number;
  grossR: number | null;
  netR: number | null;
  costR: number | null;
}

function flattenClosedPositionRecords(positions: ShadowPosition[]): ClosedPositionRecord[] {
  const records: ClosedPositionRecord[] = [];
  try {
    for (const position of positions) {
      for (const variant of position.variants) {
        if (!isClosedFilledVariant(variant)) continue;
        const openedAtMs = toMs(variant.openedAt) ?? toMs(position.scannedAt) ?? 0;
        records.push({
          symbol: position.symbol ?? "UNKNOWN",
          regime: position.marketRegime ?? "UNKNOWN",
          entryVariant: position.selectedEntryVariant ?? "unknown",
          openedAtMs,
          grossR: variant.realizedGrossR ?? null,
          netR: variant.realizedNetR ?? null,
          costR: position.costR ?? position.variantSelection?.costR ?? null,
        });
      }
    }
  } catch {
    // best-effort; never break the monitor
  }
  return records;
}

/**
 * Extract the richer current-guard closed positions consumed by the F**
 * stability audit and F*** frozen tape. Mirrors the same close-selection logic
 * as flattenClosedPositionRecords but carries direction / exitVariant /
 * policyVersion / closedAt. Report-only; never throws.
 */
function extractCurrentGuardClosedPositions(
  positions: ShadowPosition[],
): CurrentGuardClosedPosition[] {
  const out: CurrentGuardClosedPosition[] = [];
  try {
    for (const position of positions) {
      for (const variant of position.variants) {
        if (!isClosedFilledVariant(variant)) continue;
        const grossR = variant.realizedGrossR;
        const netR = variant.realizedNetR;
        if (typeof grossR !== "number" || typeof netR !== "number") continue;
        const openedAt = variant.openedAt ?? position.scannedAt ?? "";
        const closedAt = variant.closedAt ?? variant.lastUpdatedAt ?? openedAt;
        out.push({
          symbol: position.symbol ?? "UNKNOWN",
          direction: position.direction === "SHORT" ? "SHORT" : "LONG",
          grossR,
          netR,
          costR: position.costR ?? position.variantSelection?.costR ?? 0,
          regime: position.marketRegime ?? null,
          entryVariant: position.selectedEntryVariant ?? null,
          exitVariant: variant.variant ?? position.selectedExitVariant ?? null,
          policyVersion: position.policyVersion ?? null,
          openedAt,
          closedAt,
        });
      }
    }
  } catch {
    // best-effort; never break the monitor
  }
  return out;
}

function computeNetAvgR(records: ClosedPositionRecord[]): number | null {
  const finite = records
    .map((r) => r.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function computeProfitFactor(records: ClosedPositionRecord[]): number | null {
  let winSum = 0;
  let lossSum = 0;
  for (const r of records) {
    if (typeof r.grossR !== "number" || !Number.isFinite(r.grossR)) continue;
    if (r.grossR > 0) winSum += r.grossR;
    else if (r.grossR < 0) lossSum += Math.abs(r.grossR);
  }
  if (lossSum === 0) {
    return winSum > 0 ? Infinity : null;
  }
  return winSum / lossSum;
}

function buildCurrentGuardLaneSummary(
  currentGuardPositions: ShadowPosition[],
): BaseRouteCurrentGuardLaneSummary {
  const records = flattenClosedPositionRecords(currentGuardPositions);
  const closed = records.length;
  const openN = currentGuardPositions.filter((p) => isOpen(p)).length;
  const wins = records.filter((r) => typeof r.grossR === "number" && r.grossR > 0).length;
  const losses = records.filter((r) => typeof r.grossR === "number" && r.grossR < 0).length;
  const grossAvgR = (() => {
    const finite = records.map((r) => r.grossR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (finite.length === 0) return null;
    return finite.reduce((s, v) => s + v, 0) / finite.length;
  })();
  const netAvgR = computeNetAvgR(records);
  const avgCostR = (() => {
    const finite = records.map((r) => r.costR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (finite.length === 0) return null;
    return finite.reduce((s, v) => s + v, 0) / finite.length;
  })();
  const pf = computeProfitFactor(records);
  const wr = closed > 0 ? wins / closed : null;
  const winGrosses = records.filter((r) => typeof r.grossR === "number" && r.grossR > 0).map((r) => r.grossR as number);
  const lossGrosses = records.filter((r) => typeof r.grossR === "number" && r.grossR < 0).map((r) => r.grossR as number);
  const avgWinGrossR = winGrosses.length > 0 ? winGrosses.reduce((s, v) => s + v, 0) / winGrosses.length : null;
  const avgLossGrossR = lossGrosses.length > 0 ? lossGrosses.reduce((s, v) => s + v, 0) / lossGrosses.length : null;

  // byRegime
  const regimeMap = new Map<string, ClosedPositionRecord[]>();
  for (const r of records) {
    const arr = regimeMap.get(r.regime) ?? [];
    arr.push(r);
    regimeMap.set(r.regime, arr);
  }
  const byRegime = Array.from(regimeMap.entries())
    .map(([regime, arr]) => ({ regime, n: arr.length, netAvgR: computeNetAvgR(arr) }))
    .sort((a, b) => b.n - a.n);

  // symbol concentration by net contribution share
  const symbolMap = new Map<string, ClosedPositionRecord[]>();
  for (const r of records) {
    const arr = symbolMap.get(r.symbol) ?? [];
    arr.push(r);
    symbolMap.set(r.symbol, arr);
  }
  const symbolEntries = Array.from(symbolMap.entries()).map(([symbol, arr]) => {
    const netSum = arr
      .map((r) => r.netR)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .reduce((s, v) => s + Math.abs(v), 0);
    return { symbol, arr, netAbsSum: netSum };
  });
  const totalAbsNet = symbolEntries.reduce((s, e) => s + e.netAbsSum, 0);
  const symbolConcentration = symbolEntries
    .map((e) => ({
      symbol: e.symbol,
      n: e.arr.length,
      netAvgR: computeNetAvgR(e.arr),
      share: totalAbsNet > 0 ? e.netAbsSum / totalAbsNet : 0,
    }))
    .sort((a, b) => b.share - a.share);

  // byRoute (entryVariant)
  const routeMap = new Map<string, ClosedPositionRecord[]>();
  for (const r of records) {
    const arr = routeMap.get(r.entryVariant) ?? [];
    arr.push(r);
    routeMap.set(r.entryVariant, arr);
  }
  const byRoute = Array.from(routeMap.entries())
    .map(([entryVariant, arr]) => ({ entryVariant, n: arr.length, netAvgR: computeNetAvgR(arr) }))
    .sort((a, b) => b.n - a.n);

  // recency split
  const sorted = [...records].sort((a, b) => a.openedAtMs - b.openedAtMs);
  let earlyHalf: { n: number; netAvgR: number | null; pf: number | null } | null = null;
  let lateHalf: { n: number; netAvgR: number | null; pf: number | null } | null = null;
  let stable: boolean | null = null;
  if (sorted.length >= 2) {
    const mid = Math.floor(sorted.length / 2);
    const early = sorted.slice(0, mid);
    const late = sorted.slice(mid);
    if (early.length > 0) {
      earlyHalf = { n: early.length, netAvgR: computeNetAvgR(early), pf: computeProfitFactor(early) };
    }
    if (late.length > 0) {
      lateHalf = { n: late.length, netAvgR: computeNetAvgR(late), pf: computeProfitFactor(late) };
    }
    if (
      earlyHalf?.netAvgR !== null && earlyHalf?.netAvgR !== undefined &&
      lateHalf?.netAvgR !== null && lateHalf?.netAvgR !== undefined
    ) {
      stable = earlyHalf.netAvgR > 0 && lateHalf.netAvgR > 0;
    }
  }

  // status
  const maxSymbolShare = symbolConcentration[0]?.share ?? 0;
  let status: BaseRouteCurrentGuardLaneSummary["status"];
  let statusReason: string;
  const hasNet = typeof netAvgR === "number";
  const hasCost = typeof avgCostR === "number";
  if (hasNet && netAvgR! <= 0) {
    status = "REJECT";
    statusReason = `netAvgR=${netAvgR!.toFixed(4)} (≤0)`;
  } else if (hasCost && avgCostR! > 0.20) {
    status = "REJECT";
    statusReason = `avgCostR=${avgCostR!.toFixed(4)} exceeds 0.20`;
  } else if (
    closed >= 200 &&
    hasNet && netAvgR! > 0.05 &&
    typeof pf === "number" && pf > 1.20 &&
    stable === true &&
    maxSymbolShare <= 0.40
  ) {
    status = "PROMOTION_CANDIDATE";
    statusReason = `closed=${closed}, netAvgR=${netAvgR!.toFixed(4)}, PF=${pf.toFixed(2)}, recency stable, max symbol share=${(maxSymbolShare * 100).toFixed(1)}%`;
  } else if (
    closed >= 50 &&
    hasNet && netAvgR! > 0 &&
    hasCost && avgCostR! <= 0.15
  ) {
    status = "WATCHABLE";
    statusReason = `closed=${closed}, netAvgR=${netAvgR!.toFixed(4)}, avgCostR=${avgCostR!.toFixed(4)}`;
  } else {
    status = "COLLECTING";
    statusReason = `closed=${closed}${hasNet ? `, netAvgR=${netAvgR!.toFixed(4)}` : ""}`;
  }

  // cautions
  const cautions: string[] = [];
  cautions.push("This is not live approval. It is a candidate requiring deeper stability checks.");
  if (closed < 200) {
    cautions.push(`Insufficient sample for promotion (closed=${closed}, need ≥200)`);
  }
  if (maxSymbolShare > 0.40 && symbolConcentration[0]) {
    cautions.push(`Symbol concentration risk: ${symbolConcentration[0].symbol} at ${(maxSymbolShare * 100).toFixed(1)}% PnL`);
  }
  if (stable === false) {
    cautions.push("Stability unconfirmed: early/late halves diverge");
  }

  return {
    reportOnly: true,
    laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD",
    source: "F*. Base Route Risk Hygiene Monitor",
    closed,
    open: openN,
    wins,
    losses,
    grossAvgR,
    netAvgR,
    avgCostR,
    pf: pf === Infinity ? null : pf,
    wr,
    avgWinGrossR,
    avgLossGrossR,
    byRegime,
    symbolConcentration,
    byRoute,
    recencySplit: { earlyHalf, lateHalf, stable },
    status,
    statusReason,
    cautions,
  };
}

function buildPreviousHygieneTapeSummary(positions: ShadowPosition[]): BaseRouteRiskHygieneMonitor["previousHygieneTape"] {
  const closed = flattenClosedSlices(positions);
  const netAvgR = avg(closed.map((slice) => slice.realizedNetR));
  return {
    closedN: closed.length,
    avgCostR: avg(closed.map((slice) => slice.costR)),
    netAvgR,
    below175ClosedN: closed.filter((slice) => slice.stopDistanceBps !== null && slice.stopDistanceBps < TIGHT_STOP_DISTANCE_BPS).length,
    note: `Anchor-consistent V2 positions created before the current guard version stamp (stop175-v1). ${closed.length} closed in this tape. These should not be used to judge the current 175bps guard effectiveness.`,
  };
}

function isPostCalibrationPosition(position: ShadowPosition): boolean {
  if (position.variantSelection?.evidenceEra) {
    return position.variantSelection.evidenceEra === "POST_CALIBRATION";
  }

  if (
    position.variantSelection?.calibratedExpectedNetR !== undefined ||
    position.variantSelection?.calibrationVerdict !== undefined
  ) {
    return true;
  }

  return classifyEvidenceEra(position) === "POST_CALIBRATION";
}

export function buildBaseRouteRiskHygieneMonitor(
  positions: ShadowPosition[],
  executionLog: ShadowExecutionEvent[],
  opts: { era?: EvidenceEra } = {},
  now: Date = new Date(),
): BaseRouteRiskHygieneMonitor {
  const era = opts.era ?? "POST_CALIBRATION";
  const eraPositions = era === "ALL_TIME"
    ? positions
    : positions.filter((position) => isPostCalibrationPosition(position));
  const ultraTightSkips = executionLog
    .filter((event) => event.type === "ENTRY_SKIPPED" && event.message.includes(STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const guardActivatedAtRetainedLog = ultraTightSkips[0]?.createdAt ?? null;
  const guardActivatedMs = toMs(guardActivatedAtRetainedLog);
  const recent24hCutoff = now.getTime() - DAY_MS;
  const recent24h = ultraTightSkips.filter((event) => {
    const createdAtMs = toMs(event.createdAt);
    return createdAtMs !== null && createdAtMs >= recent24hCutoff;
  }).length;

  // Current-guard tape: positions stamped with the current guard generation (stop175-v1).
  const currentGuardPositions = eraPositions.filter((position) =>
    position.riskHygieneGuardMinStopDistanceBps === MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT &&
    position.policyVersion === BASE_ROUTE_POLICY_VERSION_V2,
  );
  const postGuardTape = buildCurrentGuardTapeSummary(currentGuardPositions);

  // Previous hygiene tape: anchor-consistent V2 positions that predate the stop175-v1 guard stamp.
  const previousHygienePositions = eraPositions.filter((position) =>
    position.policyVersion === BASE_ROUTE_POLICY_VERSION_V2 &&
    position.riskHygieneGuardVersion !== RISK_HYGIENE_GUARD_V1,
  );
  const previousHygieneTape = buildPreviousHygieneTapeSummary(previousHygienePositions);

  // Legacy/mixed tape: all non-V2 positions (pre-anchor-consistency fix).
  const legacyOrMixedPositions = eraPositions.filter((position) =>
    position.policyVersion !== BASE_ROUTE_POLICY_VERSION_V2,
  );
  const legacyClosed = flattenClosedSlices(legacyOrMixedPositions);
  const legacyGrossAvg = avg(legacyClosed.map((slice) => slice.realizedGrossR));
  const legacyNetAvg = avg(legacyClosed.map((slice) => slice.realizedNetR));
  const legacyDrag =
    legacyGrossAvg !== null && legacyNetAvg !== null
      ? legacyGrossAvg - legacyNetAvg
      : null;

  // Verdict is based ONLY on current-guard tape.
  let verdict: BaseRouteRiskHygieneMonitorVerdict = "TOO_EARLY";
  if (guardActivatedMs !== null || currentGuardPositions.length > 0) {
    if (postGuardTape.closedN < MIN_CLOSED_FOR_CURRENT_GUARD_JUDGMENT) {
      verdict = ultraTightSkips.length > 0 || postGuardTape.openN > 0 || currentGuardPositions.length > 0
        ? "COLLECTING_CURRENT_GUARD_TAPE"
        : "TOO_EARLY";
    } else if (postGuardTape.netAvgR !== null && postGuardTape.netAvgR < 0) {
      verdict = "CURRENT_GUARD_OUTCOME_NEGATIVE";
    } else if (
      postGuardTape.netAvgR !== null && postGuardTape.netAvgR >= 0 &&
      postGuardTape.below175ClosedN === 0
    ) {
      verdict = "RISK_HYGIENE_IMPROVING";
    } else {
      verdict = "GUARD_ACTIVE_BUT_CLEAN_TAPE_AMBIGUOUS";
    }
  }

  const legacyOrMixedTape = {
    closedN: legacyClosed.length,
    avgCostR: avg(legacyClosed.map((slice) => slice.costR)),
    grossToNetDrag: legacyDrag,
    note:
      guardActivatedAtRetainedLog === null
        ? "No retained ultra-tight skip event found yet, so post-guard tape cannot be separated from historical tape."
        : `Headline system and route stats still mix ${legacyClosed.length} pre-anchor-fix close(s) with ${postGuardTape.closedN} current-guard close(s); judge the guard from current-guard tape only.`,
  };

  let currentGuardLaneSummary: BaseRouteCurrentGuardLaneSummary | undefined;
  try {
    currentGuardLaneSummary = buildCurrentGuardLaneSummary(currentGuardPositions);
  } catch {
    currentGuardLaneSummary = undefined;
  }

  // Report-only: richer current-guard closed positions for F** stability audit + F*** frozen tape.
  let currentGuardClosedPositions: CurrentGuardClosedPosition[] | undefined;
  let stabilityReport: BaseRouteCurrentGuardStabilityReport | undefined;
  try {
    currentGuardClosedPositions = extractCurrentGuardClosedPositions(currentGuardPositions);
    stabilityReport = buildBaseRouteCurrentGuardStabilityReport(
      currentGuardClosedPositions,
      postGuardTape.openN,
      now.toISOString(),
    );
  } catch {
    currentGuardClosedPositions = currentGuardClosedPositions ?? [];
    stabilityReport = undefined;
  }

  return {
    guardReasonCode: STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK,
    guardThresholdBps: MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT,
    guardActivatedAtRetainedLog,
    skippedUltraTightCandidates: {
      total: ultraTightSkips.length,
      recent24h,
    },
    postGuardTape,
    previousHygieneTape,
    legacyOrMixedTape,
    verdict,
    currentGuardLaneSummary,
    currentGuardClosedPositions,
    stabilityReport,
  };
}

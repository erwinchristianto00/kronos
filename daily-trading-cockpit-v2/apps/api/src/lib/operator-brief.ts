/**
 * OPERATOR BRIEF (REPORT-ONLY)
 * Compact ~60-80 line terminal summary showing only the decision-relevant
 * information. No I/O, no side effects, no store writes. Pure formatter.
 *
 * Max target: OPERATOR_BRIEF_MAX_LINES lines (enforced by tests).
 */

import type { PostCutoverReport } from "./frozen-current-guard-post-cutover.js";
import type { CurrentGuardVariantMatrixReport } from "./current-guard-variant-matrix.js";
import type { LiveTradingGateReport } from "./live-trading-gate.js";
import type { RegimeDirectionControllerReport } from "./regime-direction-controller.js";
import type { CoreScanAutoRefreshStatus } from "./core-scan-auto-refresh.js";
import { buildAdaptiveLaneRouterReport, type AdaptiveLaneRouterReport } from "./adaptive-lane-router.js";
import {
  buildPaperExecutionRouterBriefLines,
  buildPaperProvenanceBriefLines,
  buildPaperLatencyBriefLines,
  type PaperPerformanceReport,
  type PaperOrder,
  type PaperProvenanceAudit,
  type ShadowLoserFingerprintGateReport,
  type PaperLatencyDiagnostics,
} from "./paper-execution-router.js";
import {
  buildPaperOpportunityAllocatorBriefLines,
  type PaperOpportunityAllocatorReport,
} from "./paper-opportunity-allocator.js";
import {
  formatAdmissionTimingBriefLine,
  formatScanTimingBriefLine,
  type ScanTimingDiagnostics,
} from "./scan-timing-diagnostics.js";
import {
  buildMixedRegimeBriefLines,
  type MixedBudgetForwardValidationReport,
  type MixedRegimeReport,
} from "./mixed-regime-router.js";

export const OPERATOR_BRIEF_MAX_LINES = 140;

const SEP = "═".repeat(60);

/** Variant IDs to show in the brief, in priority order. */
export const OPERATOR_BRIEF_TOP_VARIANTS = [
  "CG_WIDE_STOP_TP_WIDE",
  "CG_BASELINE_CURRENT",
  "CG_MAKER_LIMIT_SIM",
] as const;

export interface OperatorBriefInputs {
  generatedAt: string;
  era: string;
  scanStatus: CoreScanAutoRefreshStatus | null;
  regimeReport: RegimeDirectionControllerReport | null;
  postCutoverReport: PostCutoverReport | undefined;
  variantMatrixReport: CurrentGuardVariantMatrixReport | undefined;
  gateReport: LiveTradingGateReport;
  /** Optional paper-execution-router performance report — when present, renders section 10. */
  paperReport?: PaperPerformanceReport | null;
  /** Full paper book for adaptive LONG-lane maturity accounting. */
  paperOrders?: readonly PaperOrder[];
  /** Optional paper-opportunity-allocator report — when present, appends allocator diagnostics to section 10. */
  allocatorReport?: PaperOpportunityAllocatorReport | null;
  /** Optional provenance audit (Part 2) — when present with shadowGateReport, appends provenance/gate lines to section 10. */
  provenanceAudit?: PaperProvenanceAudit | null;
  /** Optional report-only loser-fingerprint gate simulation (Part 3), HEADLINE scope. */
  shadowGateReport?: ShadowLoserFingerprintGateReport | null;
  /** Optional DIAGNOSTIC_ONLY-scope gate simulation (Diagnostic Provenance V1) — forensic, never promotes. */
  diagnosticShadowGateReport?: ShadowLoserFingerprintGateReport | null;
  /** Optional E2E latency corridor (measurement-only; rules disabled). Appended to section 10. */
  latencyDiagnostics?: PaperLatencyDiagnostics | null;
  /** Optional Mixed-regime adaptive router (DIAGNOSTIC routing evidence; never a live gate). */
  mixedRegimeReport?: MixedRegimeReport | null;
  /** Optional active mixed-budget forward monitor (warning-level; report-only). */
  mixedBudgetForwardValidation?: MixedBudgetForwardValidationReport | null;
  /** Optional /api/scan stage timing diagnostics. Report-only formatter input. */
  scanTimingDiagnostics?: ScanTimingDiagnostics | null;
}

// ── tiny format helpers ──────────────────────────────────────────────────────

function r4(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${(v as number) >= 0 ? "+" : ""}${(v as number).toFixed(4)}`;
}
function p1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${((v as number) * 100).toFixed(1)}%`;
}
function d2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return (v as number).toFixed(2);
}
function yn(v: boolean | null | undefined): string {
  return v === true ? "YES" : v === false ? "NO" : "n/a";
}
function eta50(current: number, perDay: number | null | undefined): string {
  if (current >= 50) return "done";
  if (!perDay || !Number.isFinite(perDay) || perDay <= 0) return "n/a";
  return d2((50 - current) / perDay) + "d";
}

// ── dynamic section helpers ──────────────────────────────────────────────────

/** Compute a one-line ACTION string for section 2. */
function _buildActionLine(
  pc: PostCutoverReport | undefined,
  pcFv: number,
  vm: CurrentGuardVariantMatrixReport | undefined,
  router: AdaptiveLaneRouterReport,
): string {
  // Summarise primary state
  if (pc?.status === "REJECT") {
    return "F****** is REJECT — do NOT target it; collect variant matrix only";
  }
  if (pc && pcFv < 50) {
    return `COLLECT — wait F****** n≥50 and variant matrix n≥50`;
  }
  if (vm) {
    const wideRow = vm.rows.find((r) => r.variantId === "CG_WIDE_STOP_TP_WIDE");
    if (wideRow && wideRow.freshValid < 50) {
      return `COLLECT — wait CG_WIDE_STOP_TP_WIDE n≥50`;
    }
  }
  const selLane = router.selectedCurrentLane;
  if (selLane) {
    return `MONITOR — router selected ${selLane} (${router.selectedCurrentLaneMaturity})`;
  }
  return "COLLECT — accumulate shadow observations";
}

/** Build the dynamic bullet list for section 7. */
function _buildNextActionBullets(
  pc: PostCutoverReport | undefined,
  pcFv: number,
  vm: CurrentGuardVariantMatrixReport | undefined,
  router: AdaptiveLaneRouterReport,
): string[] {
  const bullets: string[] = [];

  // 1. F****** gating
  if (pc?.status === "REJECT") {
    bullets.push("• F****** POST-CUTOVER is REJECT — do NOT target it; it fails OOS/economics gates");
  } else if (pc && pcFv < 50) {
    bullets.push(`• Wait until F****** freshValid ≥ 50 (now=${pcFv}, ETA n=50: ${eta50(pcFv, pc.freshValidPerDay)})`);
  } else if (pc && pcFv >= 50 && !pc.allThreeSegmentsPositive) {
    bullets.push(`• Wait F****** OOS confirmation (now=${pcFv} trades, not all 3 OOS thirds positive)`);
  } else if (pc && pcFv >= 50 && pc.allThreeSegmentsPositive && pc.freshValid < 200) {
    bullets.push(`• F****** on track — wait freshValid ≥ 200 (now=${pcFv}, ETA n=200: ${d2(pc.etaToN200Days)}d)`);
  }

  // 2. CG_WIDE_STOP gate
  if (vm) {
    const wideRow = vm.rows.find((r) => r.variantId === "CG_WIDE_STOP_TP_WIDE");
    if (wideRow) {
      if (wideRow.status === "REJECT") {
        bullets.push(
          `• CG_WIDE_STOP_TP_WIDE: QUARANTINE new paper admission ` +
          `(n=${wideRow.freshValid}, net=${r4(wideRow.netAvgR)}, PF=${d2(wideRow.pf)}, status=REJECT)`,
        );
      } else if (wideRow.freshValid < 50) {
        bullets.push("• Wait until CG_WIDE_STOP_TP_WIDE freshValid ≥ 50");
      } else if (!wideRow.allThreeOosPositive) {
        bullets.push(`• CG_WIDE_STOP_TP_WIDE: wait OOS confirmation (n=${wideRow.freshValid}, not all OOS thirds positive)`);
      } else if (wideRow.freshValid < 100) {
        bullets.push("• CG_WIDE_STOP_TP_WIDE: OOS confirmed — wait freshValid ≥ 100 for STABLE_CANDIDATE");
      }
    }
  }

  // 3. Router-selected lane gate
  const selLaneId = router.selectedCurrentLane;
  if (selLaneId && selLaneId.startsWith("CG_VARIANT_MATRIX:")) {
    const selectedLaneVariantId = selLaneId.split(":")[1] as string;
    const selRow = vm?.rows.find((r) => r.variantId === selectedLaneVariantId);
    if (selRow && selRow.freshValid < 50) {
      bullets.push(`• Wait until router-selected lane ${selectedLaneVariantId} freshValid ≥ 50 (now=${selRow.freshValid})`);
    }
  }

  // 4. Always-present bullets
  bullets.push("• No real trading — liveBlocked=true and infra gates FAIL");
  bullets.push("• NO strategy mutation — frozen criteria untouched");
  bullets.push("• Paper execution router is active for eligible experimental lanes only");

  return bullets;
}

// ── main builder ─────────────────────────────────────────────────────────────

export function buildOperatorBrief(inputs: OperatorBriefInputs): string {
  const {
    generatedAt, era, scanStatus, regimeReport,
    postCutoverReport: pc, variantMatrixReport: vm, gateReport,
  } = inputs;
  const L: string[] = [];

  L.push(SEP);
  L.push(` OPERATOR BRIEF  ${generatedAt}  era=${era}`);
  L.push(SEP);
  L.push("");

  // ── 1. HEADER ────────────────────────────────────────────────────────────
  L.push("1. HEADER");
  const summary = scanStatus?.lastAutoRefreshResultSummary;
  L.push(
    `   scan: ${scanStatus?.lastAutoRefreshStatus ?? "UNKNOWN"}` +
    `  finished=${scanStatus?.lastAutoRefreshFinishedAt ?? "n/a"}` +
    `  symbols=${summary?.scannedSymbols ?? "n/a"}`,
  );
  L.push(`   ${formatScanTimingBriefLine(inputs.scanTimingDiagnostics)}`);
  L.push(
    `   regime: ${regimeReport?.currentRegime ?? "unknown"}` +
    `  mode=${regimeReport?.controllerMode ?? "UNKNOWN"}` +
    `  bias=${regimeReport?.directionalBias ?? "n/a"}` +
    `  conf=${regimeReport?.confidence ?? "n/a"}`,
  );
  L.push(
    `   liveBlocked=${gateReport.liveBlocked ? "TRUE" : "false"}` +
    `  microPilotAllowed=${gateReport.microPilotAllowed ? "true" : "FALSE"}`,
  );
  L.push("");

  // ── 2. CURRENT DECISION ──────────────────────────────────────────────────
  const router = buildAdaptiveLaneRouterReport({
    generatedAt,
    regimeReport,
    postCutoverReport: pc,
    variantMatrixReport: vm,
    gateReport,
    paperOrders: inputs.paperOrders,
  });

  L.push("2. CURRENT DECISION");
  L.push("   LIVE:        NO");
  L.push("   MICRO-PILOT: NO");
  L.push("");
  const pcFv = pc?.freshValid ?? 0;
  const bestVmRow = vm?.rows.find((r) => r.variantId === vm.bestVariantId);
  const vmFv = bestVmRow?.freshValid ?? 0;
  const candStr =
    pcFv > 0 || vmFv > 0
      ? pcFv >= vmFv
        ? `F****** POST-CUTOVER  n=${pcFv}  net=${r4(pc?.netAvgR)}  PF=${d2(pc?.pf)}`
        : `VARIANT_MATRIX:${vm?.bestVariantId ?? "?"}  n=${vmFv}  net=${r4(bestVmRow?.netAvgR)}`
      : "none (collecting)";
  L.push("   ECONOMIC LEAD:");
  L.push(`     BEST CANDIDATE: ${candStr}`);
  L.push("");

  // ROUTER SELECTED sub-section
  const selLane = router.selectedCurrentLane ?? "none";
  L.push("   ROUTER SELECTED:");
  L.push(`     ${selLane} (${router.selectedCurrentLaneMaturity})`);
  L.push(`     why: ${router.selectedCurrentLaneReason}`);
  L.push("");

  // ACTION: dynamic
  const actionBullets = _buildActionLine(pc, pcFv, vm, router);
  L.push(`   ACTION: ${actionBullets}`);
  L.push("");

  // ── 3. F****** POST-CUTOVER ──────────────────────────────────────────────
  L.push("3. F****** POST-CUTOVER");
  if (!pc) {
    L.push("   [unavailable]");
  } else {
    L.push(`   status=${pc.status}  freshValid=${pc.freshValid}  resolved=${pc.resolved}  open=${pc.open}`);
    L.push(`   net=${r4(pc.netAvgR)}  PF=${d2(pc.pf)}  WR=${p1(pc.wr)}`);
    L.push(`   OOS all positive: ${yn(pc.allThreeSegmentsPositive)}  |  +10bps: ${yn(pc.plus10bpsStillPositive)}`);
    L.push(`   drawdown: ${d2(pc.approxMaxDrawdownR)}R  |  topSymbol: ${p1(pc.topSymbolPnlShare)}`);
    L.push(`   ETA  n=50: ${eta50(pc.freshValid, pc.freshValidPerDay)}  n=100: ${d2(pc.etaToN100Days)}d  n=200: ${d2(pc.etaToN200Days)}d`);
    const bl = pc.blockers.slice(0, 3).join(" | ");
    L.push(`   blockers: ${bl || "none"}`);
  }
  L.push("");

  // ── 4. VARIANT MATRIX — TOP 3 ────────────────────────────────────────────
  L.push("4. VARIANT MATRIX — TOP 3: CG_WIDE_STOP / CG_BASELINE / CG_MAKER_LIMIT");
  if (!vm) {
    L.push("   [unavailable]");
  } else {
    for (const id of OPERATOR_BRIEF_TOP_VARIANTS) {
      const row = vm.rows.find((r) => r.variantId === id);
      if (!row) continue;
      const vmVel = row.calendarDays && row.calendarDays > 0 ? row.freshValid / row.calendarDays : null;
      L.push(`   ${id}:`);
      L.push(
        `     n=${row.freshValid}  ETA50=${eta50(row.freshValid, vmVel)}  net=${r4(row.netAvgR)}` +
        `  PF=${d2(row.pf)}  WR=${p1(row.wr)}  payoff=${d2(row.payoffRatio)}`,
      );
      L.push(
        `     +10bps=${yn(row.plus10bpsStillPositive)}  OOS+=${yn(row.allThreeOosPositive)}` +
        `  maxDD=${d2(row.approxMaxDrawdownR)}R  status=${row.status}`,
      );
      if (row.blockers.length > 0)
        L.push(`     blockers: ${row.blockers.slice(0, 2).join(" | ")}`);
    }
    const bId = vm.bestVariantId;
    const bFv = vm.rows.find((r) => r.variantId === bId)?.freshValid ?? 0;
    L.push(
      `   best: ${bId ?? "none"}` +
      `  beatsBaseline=${yn(vm.bestBeatsBaseline)}` +
      `  mature(n≥50)=${yn(bId !== null ? bFv >= 50 : false)}`,
    );

    // router-selected lane row — only when NOT already in the top-3 display loop
    const selLaneId = router.selectedCurrentLane;
    if (selLaneId && selLaneId.startsWith("CG_VARIANT_MATRIX:")) {
      const selVariantId = selLaneId.split(":")[1] as string;
      const alreadyShown = (OPERATOR_BRIEF_TOP_VARIANTS as readonly string[]).includes(selVariantId);
      if (!alreadyShown) {
        const selRow = vm.rows.find((r) => r.variantId === selVariantId);
        if (selRow) {
          const selVel = selRow.calendarDays && selRow.calendarDays > 0
            ? selRow.freshValid / selRow.calendarDays
            : null;
          L.push(`   router-selected: ${selVariantId}:`);
          L.push(
            `     n=${selRow.freshValid}  ETA50=${eta50(selRow.freshValid, selVel)}  net=${r4(selRow.netAvgR)}` +
            `  PF=${d2(selRow.pf)}  WR=${p1(selRow.wr)}  payoff=${d2(selRow.payoffRatio)}`,
          );
          L.push(
            `     +10bps=${yn(selRow.plus10bpsStillPositive)}  OOS+=${yn(selRow.allThreeOosPositive)}` +
            `  maxDD=${d2(selRow.approxMaxDrawdownR)}R  status=${selRow.status}`,
          );
        }
      }
    }

    const diag = vm.resolverDiagnostics;
    const lastShort = diag.lastRunAt ? diag.lastRunAt.slice(11, 19) + "Z" : "never";
    L.push(
      `   resolver: last=${lastShort}` +
      `  resolved=${diag.resolvedThisRun ?? "?"}` +
      `  expired=${diag.expiredThisRun ?? "?"}` +
      `  staleOpen=${diag.staleOpenCount}` +
      `  oldestOpen=${diag.oldestOpenAgeHours !== null ? Math.round(diag.oldestOpenAgeHours) + "h" : "n/a"}`,
    );
  }
  L.push("");

  // ── 5. REGIME ALIGNMENT ──────────────────────────────────────────────────
  L.push("5. REGIME ALIGNMENT");
  L.push(
    `   regime=${regimeReport?.currentRegime ?? "unknown"}` +
    `  mode=${regimeReport?.controllerMode ?? "UNKNOWN"}`,
  );
  const mismatch = regimeReport?.warnings?.some((w) => w.includes("cross-regime")) ?? false;
  L.push(
    `   status: ${mismatch ? "MISMATCH — shadow collection only, not live execution" : "OK — aligned for shadow collection"}`,
  );
  L.push("");

  // ── 6. INFRA READINESS ───────────────────────────────────────────────────
  L.push("6. INFRA READINESS");
  L.push(
    `   killSwitch=${yn(gateReport.killSwitchReady)}` +
    `  orderRecon=${yn(gateReport.orderReconciliationReady)}` +
    `  exchangeHealth=${yn(gateReport.exchangeHealthReady)}`,
  );
  const fundingGate = gateReport.blockers.find((b) => b.gate === "FUNDING_SLIPPAGE_MODELED");
  L.push(`   fundingSlippage=${fundingGate?.status === "PASS" ? "YES" : "NO"}`);
  const failGates = gateReport.blockers.filter((b) => b.status === "FAIL").map((b) => b.gate);
  L.push(`   failing (${failGates.length}): ${failGates.slice(0, 5).join(", ") || "none"}`);
  L.push("");

  // ── 7. NEXT ACTIONS ──────────────────────────────────────────────────────
  L.push("7. NEXT ACTIONS");
  const bullets = _buildNextActionBullets(pc, pcFv, vm, router);
  for (const b of bullets) {
    L.push(`   ${b}`);
  }
  L.push("");

  // ── 8. DO / DON'T ────────────────────────────────────────────────────────
  L.push("8. DO / DON'T");
  L.push("   DO:    collect F******* (variant matrix) | collect F****** (post-cutover)");
  const wideRow = vm?.rows.find((r) => r.variantId === "CG_WIDE_STOP_TP_WIDE");
  L.push(
    wideRow?.status === "REJECT"
      ? "          quarantine CG_WIDE_STOP_TP_WIDE | monitor CG_MAKER_LIMIT_SIM"
      : "          monitor CG_WIDE_STOP_TP_WIDE and CG_MAKER_LIMIT_SIM",
  );
  L.push("   DON'T: enable live | change frozen criteria | revive W** / W*** | optimize n<50");
  L.push("");

  // ── 9. ADAPTIVE LANE ROUTER ──────────────────────────────────────────────
  L.push("9. ADAPTIVE LANE ROUTER");
  L.push(
    `   regime=${router.currentRegime ?? "unknown"} (${router.regimeFamily})` +
    `  mode=${router.controllerMode}  permission=${router.currentPermission}`,
  );
  const selDisplay = router.selectedCurrentLane
    ? `${router.selectedCurrentLane}  maturity=${router.selectedCurrentLaneMaturity}`
    : router.collectionAction
    ? `— / ${router.collectionAction}`
    : "none";
  L.push(`   selected: ${selDisplay}`);
  L.push(`   why: ${router.selectedCurrentLaneReason}`);
  const top3Source =
    router.rankedCandidates.length > 0
      ? router.rankedCandidates
      : router.experimentalUpsideCandidates.length > 0
      ? router.experimentalUpsideCandidates
      : router.collectingWatchlist.length > 0
      ? router.collectingWatchlist
      : router.rejectedOrDeprioritizedLanes.filter((c) => c.maturity !== "REJECT");
  const top3Label =
    router.rankedCandidates.length > 0
      ? "top3"
      : router.experimentalUpsideCandidates.length > 0
      ? "top3 experimental"
      : router.collectingWatchlist.length > 0
      ? "top3 watchlist"
      : "top3 advisory (regime-incompatible)";
  const top3 = top3Source.slice(0, 3).map((c) => `${c.laneId}(${d2(c.score)})`).join(" | ");
  L.push(`   ${top3Label}: ${top3 || "none"}`);
  const rp = router.perRegimePolicy;
  L.push(
    `   regime-map: BEAR→${rp.BEARISH.recommendedLaneId ?? "—"}/${rp.BEARISH.permission}` +
    `  BULL→${rp.BULLISH.recommendedLaneId ?? "—"}/${rp.BULLISH.permission}`,
  );
  L.push(
    `               MIX→${rp.MIXED.recommendedLaneId ?? "—"}/${rp.MIXED.permission}` +
    `  CHOP→${rp.CHOP.permission}  UNK→${rp.UNKNOWN.permission}`,
  );
  if (router.experimentalUpsideCandidates.length > 0) {
    const expStr = router.experimentalUpsideCandidates
      .slice(0, 2)
      .map((c) => `${c.laneId}(${d2(c.score)})`)
      .join(" | ");
    L.push(`   experimental (OOS unconfirmed): ${expStr}`);
  }
  if (router.collectingWatchlist.length > 0) {
    const wlStr = router.collectingWatchlist
      .slice(0, 2)
      .map((c) => `${c.laneId}(n=${c.freshValid},net=${r4(c.netAvgR)})`)
      .join(" | ");
    L.push(`   watchlist (neg econ): ${wlStr}`);
  }
  L.push(`   blockers: ${router.blockers.slice(0, 2).join(" | ")}`);
  L.push(`   next: ${router.nextRequiredEvidence.slice(0, 2).join(" | ") || "none"}`);
  L.push("");

  // ── 10. PAPER EXECUTION ROUTER ───────────────────────────────────────────
  if (inputs.paperReport || inputs.allocatorReport) {
    if (inputs.paperReport) {
      const pLines = buildPaperExecutionRouterBriefLines(inputs.paperReport);
      for (const pl of pLines) L.push(pl);
    }
    if (inputs.latencyDiagnostics) {
      const latLines = buildPaperLatencyBriefLines(inputs.latencyDiagnostics);
      for (const ll of latLines) L.push(ll);
    }
    if (inputs.allocatorReport) {
      const aLines = buildPaperOpportunityAllocatorBriefLines(inputs.allocatorReport);
      for (const al of aLines) L.push(al);
    }
    if (inputs.mixedRegimeReport) {
      for (const ml of buildMixedRegimeBriefLines(inputs.mixedRegimeReport, inputs.mixedBudgetForwardValidation)) L.push(ml);
    }
    const admissionLine = formatAdmissionTimingBriefLine(inputs.scanTimingDiagnostics?.admissionTrace);
    if (admissionLine) L.push(`   ${admissionLine}`);
    if (inputs.provenanceAudit && inputs.shadowGateReport) {
      const provLines = buildPaperProvenanceBriefLines(
        inputs.provenanceAudit,
        inputs.shadowGateReport,
        inputs.diagnosticShadowGateReport,
      );
      for (const pl of provLines) L.push(pl);
    }
    L.push("");
  }

  L.push(SEP);

  return L.join("\n");
}

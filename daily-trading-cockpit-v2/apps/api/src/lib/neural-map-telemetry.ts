import type { CoreScanAutoRefreshStatus } from "./core-scan-auto-refresh.js";
import type { CurrentGuardVariantMatrixReport } from "./current-guard-variant-matrix.js";
import type { MixedBudgetForwardValidationReport, MixedRegimeReport, OpenOrderStaleAudit } from "./mixed-regime-router.js";
import type { PaperOrder, PaperPerformanceReport } from "./paper-execution-router.js";
import type { RegimeDirectionControllerReport } from "./regime-direction-controller.js";
import type { ScanTimingDiagnostics } from "./scan-timing-diagnostics.js";

export type NeuralHealth = "HEALTHY" | "ACTIVE" | "WARNING" | "CRITICAL" | "IDLE" | "COLLECTING" | "QUARANTINE";
export type NeuralNodeKind = "INPUT" | "PROCESS" | "CONTROLLER" | "LANE" | "OUTPUT" | "SAFETY";
export type NeuralDiagnosisCategory =
  | "HEALTHY_FLOW"
  | "COLLECTING_EVIDENCE"
  | "IDLE"
  | "LATENCY"
  | "DEGRADED_INPUT"
  | "CAPACITY_PRESSURE"
  | "QUARANTINE"
  | "HARD_FAIL"
  | "DESTRUCTIVE_ECONOMICS"
  | "BLOCKING_CONDITION";

export interface NeuralMapNode {
  id: string;
  label: string;
  kind: NeuralNodeKind;
  health: NeuralHealth;
  active: boolean;
  metric: string;
  diagnosisCategory: NeuralDiagnosisCategory;
  diagnosisSummary: string;
  diagnosisFacts: string[];
  detail: string[];
}

export interface NeuralMapLane {
  id: string;
  label: string;
  health: NeuralHealth;
  evidenceHealth: NeuralHealth;
  active: boolean;
  open: number;
  closed: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  /**
   * Where netAvgR/pf/wr/closed come from: "VM_SIM" = the variant-matrix simulation row,
   * "PAPER_BOOK" = realized paper orders. The two are DIFFERENT measurements — without this tag a
   * VM-sim netAvgR rendered next to paper PnL dollars reads as one dataset (audit finding).
   */
  statsSource: "VM_SIM" | "PAPER_BOOK";
  headlinePnl: number;
  diagnosticPnl: number;
  totalPnl: number;
  /** True when the lane's PnL comes ENTIRELY from DIAGNOSTIC_ONLY orders (zero headline closed). */
  pnlIsDiagnosticOnly: boolean;
  startingEquity: number;
  totalPnlPct: number | null;
  headlinePnlPct: number | null;
  status: string;
  reason: string;
}

export interface NeuralMapAlert {
  severity: "WARNING" | "CRITICAL";
  source: string;
  message: string;
}

export interface NeuralMapTelemetry {
  version: "neural-map-v1";
  generatedAt: string;
  staleAfterSec: number;
  controller: {
    regime: string | null;
    mode: string;
    bias: string;
    confidence: string;
    allowsLong: boolean;
    allowsShort: boolean;
    allowsNewEntries: boolean;
    reasons: string[];
  };
  safety: {
    liveBlocked: true;
    microPilotAllowed: false;
    paperOnly: true;
  };
  scan: {
    status: string;
    running: boolean;
    lastFinishedAt: string | null;
    totalMs: number | null;
    slowestStage: string | null;
    slowestStageMs: number | null;
    timeoutSymbols: number;
    degradedProviders: string[];
    backgroundLagSec: number | null;
  };
  paper: {
    total: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    headlinePnl: number;
    diagnosticPnl: number;
    totalPnl: number;
    todayPnl: number;
    headlineNetAvgR: number | null;
    headlinePF: number | null;
    headlineWR: number | null;
  };
  mixed: {
    activeLane: string | null;
    activeLanes: string[];
    tradingMode: string;
    admission: string;
    occupancyMode: string;
    stalePassHealth: string;
    budgetProfile: string;
    guardrailStatus: string;
    recommendedAction: string;
    waitForCapacity: number;
  };
  nodes: NeuralMapNode[];
  lanes: NeuralMapLane[];
  alerts: NeuralMapAlert[];
}

export interface NeuralMapTelemetryInput {
  generatedAt?: string;
  controller: RegimeDirectionControllerReport;
  scanStatus: CoreScanAutoRefreshStatus | null;
  scanTiming: ScanTimingDiagnostics | null;
  paper: PaperPerformanceReport;
  orders: PaperOrder[];
  variantMatrix: CurrentGuardVariantMatrixReport;
  mixed: MixedRegimeReport;
  mixedValidation: MixedBudgetForwardValidationReport;
  staleAudit: OpenOrderStaleAudit;
  /**
   * Lane ids that are quarantined (benched: no new admissions, still measured via the VM
   * simulation). Rendered with the distinct QUARANTINE color instead of red/green — green/red
   * are reserved for ACTIVE lanes only. The lane stays visible so its VM-sim trend remains
   * watchable and it can graduate back if its evidence turns healthy.
   */
  quarantinedLaneIds?: readonly string[];
}

const CLOSED = new Set(["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"]);
const OPEN = new Set(["CREATED", "PAPER_SUBMITTED"]);

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fmtMs(value: number | null | undefined): string {
  if (!finite(value)) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

function fmtR(value: number | null | undefined): string {
  return finite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(3)}R` : "n/a";
}

function fmtNtd(value: number | null | undefined): string {
  return finite(value) ? `NT$ ${value.toFixed(2)}` : "n/a";
}

function laneEconomics(orders: PaperOrder[], laneId: string) {
  const scoped = orders.filter((order) => order.selectedLaneId === laneId);
  const closed = scoped.filter((order) => CLOSED.has(order.paperStatus));
  const headline = closed.filter(
    (order) => order.paperOrderMode !== "DIAGNOSTIC_ONLY" && order.diagnosticLabel !== "BACKFILL_DIAGNOSTIC",
  );
  const diagnostic = closed.filter((order) => order.paperOrderMode === "DIAGNOSTIC_ONLY");
  const nets = closed.map((order) => order.netR).filter(finite);
  const positive = nets.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = nets.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  return {
    open: scoped.filter((order) => OPEN.has(order.paperStatus)).length,
    closed: closed.length,
    headlineClosed: headline.length,
    netAvgR: nets.length > 0 ? nets.reduce((sum, value) => sum + value, 0) / nets.length : null,
    pf: negative > 0 ? positive / negative : positive > 0 ? Infinity : null,
    wr: closed.length > 0 ? closed.filter((order) => order.paperStatus === "PAPER_CLOSED_WIN").length / closed.length : null,
    headlinePnl: headline.reduce((sum, order) => sum + (order.netPnlAmount ?? 0), 0),
    diagnosticPnl: diagnostic.reduce((sum, order) => sum + (order.netPnlAmount ?? 0), 0),
    totalPnl: closed.reduce((sum, order) => sum + (order.netPnlAmount ?? 0), 0),
  };
}

function laneLabel(id: string): string {
  if (id === "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE") return "CG_WIDE SHORT";
  if (id === "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE") return "CG_WIDE LONG";
  if (id === "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1") return "CG_TRAIL SHORT";
  if (id === "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT") return "CG_BASELINE SHORT";
  if (id === "CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL") return "CG_SCALEOUT SHORT";
  if (id === "CG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET") return "CG_NO_FIB500 SHORT";
  if (id === "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM") return "CG_MAKER SHORT";
  return id.replace("CG_VARIANT_MATRIX:", "").replaceAll("_", " ");
}

function healthFromLane(status: string, closed: number, netAvgR: number | null): NeuralHealth {
  if (status === "REJECT" || (closed >= 10 && finite(netAvgR) && netAvgR < 0)) return "CRITICAL";
  if (status === "PROMOTION_CANDIDATE" || status === "STABLE_CANDIDATE") return "HEALTHY";
  if (status === "WATCHABLE") return "ACTIVE";
  return closed > 0 ? "COLLECTING" : "IDLE";
}

function performanceHealthFromLane(totalPnl: number, closed: number, open: number): NeuralHealth {
  if (closed === 0 && open === 0) return "IDLE";
  if (totalPnl > 0) return open > 0 ? "ACTIVE" : "HEALTHY";
  if (totalPnl < 0) return "CRITICAL";
  return closed > 0 || open > 0 ? "COLLECTING" : "IDLE";
}

function pnlPct(pnl: number, startingEquity: number): number | null {
  if (!(Number.isFinite(startingEquity) && startingEquity > 0)) return null;
  return (pnl / startingEquity) * 100;
}

function latestOpenOrder(orders: PaperOrder[]): PaperOrder | null {
  const openOrders = orders.filter((order) => order.paperStatus === "CREATED" || order.paperStatus === "PAPER_SUBMITTED");
  if (openOrders.length === 0) return null;
  return openOrders
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null;
}

function diagnosisForNode(input: {
  id: string;
  health: NeuralHealth;
  detail: string[];
  scanFailed: boolean;
  hangMarkers: number;
  timeoutSymbols: number;
  degradedProviders: string[];
  providerFailures: number;
  candleFailures: number;
  backgroundError: string | null | undefined;
  backgroundLagSec: number | null | undefined;
  activeAdmission: string;
  activeOccupancyMode: string;
  mixedActive: boolean;
  capacityWaitCount: number;
  controllerMode: string;
  activeLaneReason: string | null | undefined;
  activeLaneStatus: string | null | undefined;
  activeLaneEvidenceHealth: NeuralHealth | null | undefined;
  noOrderReason: string | null | undefined;
  paperDataFailure: number;
  guardrailStatus: string;
  guardrailReasons: string[];
}): Pick<NeuralMapNode, "diagnosisCategory" | "diagnosisSummary" | "diagnosisFacts"> {
  const healthy = { diagnosisCategory: "HEALTHY_FLOW" as const, diagnosisSummary: "Healthy flow.", diagnosisFacts: input.detail };
  const collecting = { diagnosisCategory: "COLLECTING_EVIDENCE" as const, diagnosisSummary: "Collecting evidence; no stable fault is active.", diagnosisFacts: input.detail };
  const idle = { diagnosisCategory: "IDLE" as const, diagnosisSummary: "Intentionally idle under the current workflow.", diagnosisFacts: input.detail };

  switch (input.id) {
    case "binance":
      if (input.hangMarkers > 0 || input.timeoutSymbols > 0) {
        const summary =
          input.candleFailures > 0
            ? `Latency pressure in symbol fetch: ${input.timeoutSymbols} timeout symbol(s), ${input.hangMarkers} hang marker(s).`
            : `Symbol fetch latency is downstream of market data: ${input.timeoutSymbols} timeout symbol(s), ${input.hangMarkers} hang marker(s), ${input.candleFailures} candle failure(s).`;
        return {
          diagnosisCategory: "LATENCY",
          diagnosisSummary: summary,
          diagnosisFacts: [`candle failures ${input.candleFailures}`, ...input.detail],
        };
      }
      if (input.candleFailures > 0) {
        return {
          diagnosisCategory: "DEGRADED_INPUT",
          diagnosisSummary: `Degraded market input: ${input.candleFailures} candle fetch failure(s).`,
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "HEALTHY" ? healthy : collecting;
    case "kronos":
      if (input.degradedProviders.some((provider) => /kronos/i.test(provider))) {
        return {
          diagnosisCategory: "DEGRADED_INPUT",
          diagnosisSummary: "Kronos forecast input is degraded or circuit-broken.",
          diagnosisFacts: [`degraded providers ${input.degradedProviders.join(", ")}`, ...input.detail],
        };
      }
      return input.health === "HEALTHY" ? healthy : collecting;
    case "external":
      if (input.degradedProviders.length > 0 || input.providerFailures > 0) {
        return {
          diagnosisCategory: "DEGRADED_INPUT",
          diagnosisSummary: `External overlays degraded: ${input.providerFailures} provider failure(s).`,
          diagnosisFacts: [`degraded providers ${input.degradedProviders.join(", ") || "none"}`, ...input.detail],
        };
      }
      return input.health === "HEALTHY" ? healthy : collecting;
    case "scan":
      if (input.scanFailed) {
        return {
          diagnosisCategory: "HARD_FAIL",
          diagnosisSummary: "Core market scan failed in the latest cycle.",
          diagnosisFacts: input.detail,
        };
      }
      if (input.hangMarkers > 0 || input.timeoutSymbols > 0) {
        return {
          diagnosisCategory: "LATENCY",
          diagnosisSummary: `Core scan is degraded by latency: ${input.timeoutSymbols} timeout symbol(s), ${input.hangMarkers} hang marker(s).`,
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "HEALTHY" ? healthy : collecting;
    case "scoring":
      return input.health === "WARNING"
        ? {
            diagnosisCategory: "BLOCKING_CONDITION",
            diagnosisSummary: "Candidate scoring is degraded by an upstream failure or incomplete batch context.",
            diagnosisFacts: input.detail,
          }
        : healthy;
    case "controller":
      if (input.controllerMode === "UNKNOWN") {
        return {
          diagnosisCategory: "BLOCKING_CONDITION",
          diagnosisSummary: "Controller posture is unresolved, so decision flow is partially blocked.",
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "ACTIVE" ? healthy : collecting;
    case "lane-router":
      if (input.activeLaneEvidenceHealth === "CRITICAL" || input.activeLaneStatus === "REJECT") {
        return {
          diagnosisCategory: "DESTRUCTIVE_ECONOMICS",
          diagnosisSummary: "Router-selected lane is economically destructive in evidence, so routing context is unstable.",
          diagnosisFacts: [
            `lane status ${input.activeLaneStatus ?? "n/a"}`,
            input.activeLaneReason ?? "no explicit reason",
            ...input.detail,
          ],
        };
      }
      return input.health === "HEALTHY" || input.health === "ACTIVE" ? healthy : collecting;
    case "occupancy":
      if (!input.mixedActive) return idle;
      if (input.capacityWaitCount > 0 || input.activeOccupancyMode === "WAIT_FOR_CAPACITY") {
        return {
          diagnosisCategory: "CAPACITY_PRESSURE",
          diagnosisSummary: "Good signals are being delayed by occupancy and capacity pressure.",
          diagnosisFacts: input.detail,
        };
      }
      if (input.activeAdmission === "REJECT") {
        return {
          diagnosisCategory: "BLOCKING_CONDITION",
          diagnosisSummary: "Occupancy admission is blocked before order creation.",
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "ACTIVE" ? healthy : collecting;
    case "paper":
      if ((input.noOrderReason ?? "").includes("ACTIVE_LANE_DEGRADED")) {
        return {
          diagnosisCategory: "QUARANTINE",
          diagnosisSummary: "Paper order creation is quarantined by degraded lane performance.",
          diagnosisFacts: input.detail,
        };
      }
      if (input.paperDataFailure > 0) {
        return {
          diagnosisCategory: "HARD_FAIL",
          diagnosisSummary: `Paper execution has ${input.paperDataFailure} data failure(s).`,
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "ACTIVE" ? healthy : collecting;
    case "outcomes":
      if (input.backgroundError) {
        return {
          diagnosisCategory: "HARD_FAIL",
          diagnosisSummary: "Outcome resolver background queue has an active error.",
          diagnosisFacts: [`last error ${input.backgroundError}`, ...input.detail],
        };
      }
      if (finite(input.backgroundLagSec) && input.backgroundLagSec > 120) {
        return {
          diagnosisCategory: "LATENCY",
          diagnosisSummary: `Outcome resolver lag is elevated at ${input.backgroundLagSec.toFixed(0)}s.`,
          diagnosisFacts: input.detail,
        };
      }
      return input.health === "ACTIVE" || input.health === "HEALTHY" ? healthy : collecting;
    case "guardrail":
      if (input.guardrailStatus === "ROLLBACK_RECOMMENDED") {
        return {
          diagnosisCategory: "DESTRUCTIVE_ECONOMICS",
          diagnosisSummary: "Forward OOS says the active paper profile is economically unsafe.",
          diagnosisFacts: input.guardrailReasons.length > 0 ? input.guardrailReasons : input.detail,
        };
      }
      if (input.guardrailStatus === "WARNING") {
        return {
          diagnosisCategory: "CAPACITY_PRESSURE",
          diagnosisSummary: "Guardrail warning is active; OOS or capacity pressure needs review.",
          diagnosisFacts: input.guardrailReasons.length > 0 ? input.guardrailReasons : input.detail,
        };
      }
      return input.health === "COLLECTING" ? collecting : healthy;
    case "live-lock":
      return {
        diagnosisCategory: "BLOCKING_CONDITION",
        diagnosisSummary: "Live trading is intentionally blocked by safety policy.",
        diagnosisFacts: input.detail,
      };
    default:
      return healthy;
  }
}

export function buildNeuralMapTelemetry(input: NeuralMapTelemetryInput): NeuralMapTelemetry {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const timing = input.scanTiming;
  const scanFailed = input.scanStatus?.lastAutoRefreshStatus === "FAILED" || timing?.status === "FAILED";
  const hangMarkers = timing?.markers.filter((marker) => marker.severity === "HANG") ?? [];
  const timeoutSymbols = timing?.symbols.filter((symbol) => symbol.status === "FAILED").length ?? 0;
  const degradedProviders = Array.from(new Set((timing?.degradedProviders ?? []).map((item) => item.provider)));
  const providerFailures = timing?.symbols.filter((symbol) => symbol.failureStage?.includes("external")).length ?? 0;
  const candleFailures = timing?.symbols.filter((symbol) => symbol.failureStage?.includes("candle")).length ?? 0;
  const background = timing?.backgroundQueue;
  const guardrail = input.mixedValidation.guardrail;
  const mixedActive = input.mixed.regimeIsMixed;
  const activeAdmission = mixedActive ? input.mixed.admissionResult : "INACTIVE";
  const activeOccupancyMode = mixedActive ? input.mixed.occupancyMode : "INACTIVE";
  const capacityWaitStates = input.mixed.states.filter((state) => state.admissionResult === "WAIT_FOR_CAPACITY");
  const capacityWaitSummary = capacityWaitStates
    .slice(0, 4)
    .map((state) => `${state.symbol ?? "UNKNOWN"}:${state.occupancy.exceeded.join("+") || "CAPACITY"}`)
    .join(", ");
  const directionPressure = Array.from(new Map(
    input.mixed.states.map((state) => [
      state.direction ?? "UNKNOWN",
      `${state.direction ?? "UNKNOWN"} ${state.occupancy.perDirectionOpenCount}/${state.occupancy.budget.maxPerDirectionOpen}`,
    ]),
  ).values()).join(", ");

  const variantLaneIds = new Set(input.variantMatrix.rows.map((row) => `CG_VARIANT_MATRIX:${row.variantId}`));
  const orderLaneIds = new Set(input.orders.map((order) => order.selectedLaneId).filter(Boolean));
  const laneIds = Array.from(new Set([...variantLaneIds, ...orderLaneIds]));
  const rowsById = new Map(input.variantMatrix.rows.map((row) => [`CG_VARIANT_MATRIX:${row.variantId}`, row]));
  const activeLaneIds = new Set([
    ...input.mixed.activeMixedLanes,
    ...(input.paper.currentBatchActiveLane ? [input.paper.currentBatchActiveLane] : []),
    ...(input.paper.activeLane ? [input.paper.activeLane] : []),
  ]);
  const quarantinedLaneIds = new Set(input.quarantinedLaneIds ?? []);

  const lanes = laneIds.map((id): NeuralMapLane => {
    const row = rowsById.get(id);
    const economics = laneEconomics(input.orders, id);
    const netAvgR = row?.netAvgR ?? economics.netAvgR;
    // Per-field source honesty (audit finding): when a VM row exists, the stats block
    // (netAvgR/pf/wr/closed) is the SIMULATION row, not paper-realized — tag it so a sim netAvgR
    // rendered next to paper PnL dollars can never read as one dataset. Lanes without a VM row
    // (e.g. CG_LONG_VARIANT_MATRIX:*) show paper-realized stats under the same fields.
    const statsSource: "VM_SIM" | "PAPER_BOOK" = row ? "VM_SIM" : "PAPER_BOOK";
    const pnlIsDiagnosticOnly = economics.headlineClosed === 0 && economics.diagnosticPnl !== 0;
    const status = row?.status ?? (economics.closed > 0 ? "PAPER_EVIDENCE" : "COLLECTING");
    const evidenceHealth = healthFromLane(status, row?.freshValid ?? economics.closed, netAvgR);
    // Quarantined lanes are benched (no new admissions) but still measured via the VM sim, so
    // they bypass the red/green performance color (reserved for ACTIVE lanes) and show the
    // distinct QUARANTINE color. Their VM-sim evidenceHealth stays visible so improvement is
    // watchable; a HEALTHY/ACTIVE evidence verdict flags it as a graduation candidate.
    const quarantined = quarantinedLaneIds.has(id);
    const graduationReady = quarantined && (evidenceHealth === "HEALTHY" || evidenceHealth === "ACTIVE");
    // Performance color honesty (audit finding): headline PnL drives the color when headline
    // evidence exists; a diagnostic-only lane is colored from diagnostic PnL but its reason is
    // explicitly tagged — green must never imply headline performance that does not exist.
    const colorPnl = economics.headlineClosed > 0 ? economics.headlinePnl : economics.diagnosticPnl;
    const baseReason = quarantined
      ? (graduationReady
          ? `Quarantined (benched) — VM-sim improving to ${fmtR(netAvgR)}; graduation candidate, watch for promotion`
          : `Quarantined (benched, no new admissions) — still collecting VM-sim evidence (${fmtR(netAvgR)})`)
      : (row?.statusReason ?? (economics.open > 0 ? `${economics.open} paper order(s) open` : "paper evidence lane"));
    const sourceTag = statsSource === "VM_SIM" ? "[stats: VM-sim]" : "[stats: paper realized]";
    const diagTag = pnlIsDiagnosticOnly ? " [PnL: diagnostic-only — excluded from headline]" : "";
    return {
      id,
      label: laneLabel(id),
      health: quarantined
        ? "QUARANTINE"
        : performanceHealthFromLane(colorPnl, row?.freshValid ?? economics.closed, economics.open),
      evidenceHealth,
      active: !quarantined && (activeLaneIds.has(id) || economics.open > 0),
      open: economics.open,
      closed: row?.freshValid ?? economics.closed,
      netAvgR,
      pf: row?.pf ?? economics.pf,
      wr: row?.wr ?? economics.wr,
      statsSource,
      headlinePnl: economics.headlinePnl,
      diagnosticPnl: economics.diagnosticPnl,
      totalPnl: economics.totalPnl,
      pnlIsDiagnosticOnly,
      startingEquity: input.paper.startingEquity,
      totalPnlPct: pnlPct(economics.totalPnl, input.paper.startingEquity),
      headlinePnlPct: pnlPct(economics.headlinePnl, input.paper.startingEquity),
      status: quarantined ? "QUARANTINED" : status,
      reason: `${baseReason} ${sourceTag}${diagTag}`,
    };
  }).sort((a, b) => Number(b.active) - Number(a.active) || b.closed - a.closed);

  const inputHealth: NeuralHealth = scanFailed || hangMarkers.length > 0 ? "CRITICAL" : timeoutSymbols > 0 ? "WARNING" : "HEALTHY";
  const externalHealth: NeuralHealth = degradedProviders.length > 0 || providerFailures > 0 ? "WARNING" : "HEALTHY";
  const queueHealth: NeuralHealth =
    background?.lastError ? "CRITICAL" :
    finite(background?.maxLagSec) && background.maxLagSec > 120 ? "WARNING" :
    background?.trackerPersist === "running" || background?.shadowEngine === "running" ? "ACTIVE" : "HEALTHY";
  const admissionHealth: NeuralHealth =
    !mixedActive ? "IDLE" :
    capacityWaitStates.length > 0 ? "WARNING" :
    activeAdmission === "REJECT" ? "CRITICAL" :
    activeAdmission === "WAIT_FOR_CAPACITY" ? "WARNING" :
    activeAdmission === "ALLOW_REDUCED" ? "ACTIVE" : "HEALTHY";
  const guardrailHealth: NeuralHealth =
    guardrail.status === "ROLLBACK_RECOMMENDED" ? "CRITICAL" :
    guardrail.status === "WARNING" ? "WARNING" :
    guardrail.status === "HEALTHY" ? "HEALTHY" : "COLLECTING";
  const latestOpen = latestOpenOrder(input.orders);
  const inferredBatchLane = input.paper.currentBatchActiveLane ?? latestOpen?.selectedLaneId ?? null;
  const inferredBatchMode = input.paper.currentBatchOrderMode ?? latestOpen?.paperOrderMode ?? null;
  const activeLane =
    lanes.find((lane) => lane.id === (inferredBatchLane ?? input.paper.activeLane ?? input.mixed.activeMixedLane)) ?? null;
  const displayedRouterLane =
    inferredBatchLane ??
    (input.mixed.activeMixedLanes.join(", ") || input.paper.activeLane || "none");

  const makeNode = (node: Omit<NeuralMapNode, "diagnosisCategory" | "diagnosisSummary" | "diagnosisFacts">): NeuralMapNode => ({
    ...node,
    ...diagnosisForNode({
      id: node.id,
      health: node.health,
      detail: node.detail,
      scanFailed,
      hangMarkers: hangMarkers.length,
      timeoutSymbols,
      degradedProviders,
      providerFailures,
      candleFailures,
      backgroundError: background?.lastError,
      backgroundLagSec: background?.maxLagSec ?? null,
      activeAdmission,
      activeOccupancyMode,
      mixedActive,
      capacityWaitCount: capacityWaitStates.length,
      controllerMode: input.controller.controllerMode,
      activeLaneReason: activeLane?.reason,
      activeLaneStatus: activeLane?.status,
      activeLaneEvidenceHealth: activeLane?.evidenceHealth,
      noOrderReason: input.paper.noOrderReason,
      paperDataFailure: input.paper.dataFailure,
      guardrailStatus: guardrail.status,
      guardrailReasons: guardrail.reasons,
    }),
  });

  const nodes: NeuralMapNode[] = [
    makeNode({
      id: "binance",
      label: "Binance Market",
      kind: "INPUT",
      health: inputHealth,
      active: Boolean(input.scanStatus?.isRunning),
      metric: `${timing?.symbols.length ?? 0} symbols`,
      detail: [`candle failures ${candleFailures}`, `timeout symbols ${timeoutSymbols}`],
    }),
    makeNode({
      id: "kronos",
      label: "Kronos Forecast",
      kind: "INPUT",
      health: degradedProviders.some((provider) => /kronos/i.test(provider)) ? "WARNING" : "HEALTHY",
      active: Boolean(input.scanStatus?.isRunning),
      metric: fmtMs(timing?.totals.kronosForecastMs),
      detail: ["forecast enrichment", "paper decision input"],
    }),
    makeNode({
      id: "external",
      label: "External Signals",
      kind: "INPUT",
      health: externalHealth,
      active: Boolean(input.scanStatus?.isRunning),
      metric: fmtMs(timing?.totals.externalSignalFetchMs),
      detail: [`provider failures ${providerFailures}`, `degraded ${degradedProviders.join(", ") || "none"}`],
    }),
    makeNode({
      id: "scan",
      label: "Core Market Scan",
      kind: "PROCESS",
      health: inputHealth,
      active: Boolean(input.scanStatus?.isRunning),
      metric: fmtMs(timing?.totalScanMs),
      detail: [
        `status ${input.scanStatus?.lastAutoRefreshStatus ?? timing?.status ?? "UNKNOWN"}`,
        `slowest ${timing?.stageSummary.slowestStage?.name ?? "n/a"} ${fmtMs(timing?.stageSummary.slowestStage?.durationMs)}`,
      ],
    }),
    makeNode({
      id: "scoring",
      label: "Candidate Scoring",
      kind: "PROCESS",
      health: timing?.failureReason ? "WARNING" : "HEALTHY",
      active: timing?.activeStage === "candidateScoring",
      metric: fmtMs(timing?.totals.candidateScoringMs),
      detail: [`batch ${timing?.scanBatchId ?? "n/a"}`],
    }),
    makeNode({
      id: "controller",
      label: "Regime Controller",
      kind: "CONTROLLER",
      health: input.controller.controllerMode === "UNKNOWN" ? "WARNING" : "ACTIVE",
      active: true,
      metric: input.controller.controllerMode,
      detail: [
        `${input.controller.currentRegime ?? "Unknown"} / ${input.controller.directionalBias}`,
        `confidence ${input.controller.confidence}`,
      ],
    }),
    makeNode({
      id: "lane-router",
      label: "Adaptive Lane Router",
      kind: "CONTROLLER",
      health: input.mixed.regimeIsMixed ? "ACTIVE" : "HEALTHY",
      active: true,
      metric: input.mixed.mixedTradingMode,
      detail: [`active ${displayedRouterLane}`],
    }),
    makeNode({
      id: "occupancy",
      label: "Occupancy Allocator",
      kind: "PROCESS",
      health: admissionHealth,
      active: mixedActive,
      metric: capacityWaitStates.length > 0 ? `${activeAdmission} / ${capacityWaitStates.length} WAIT` : activeAdmission,
      detail: [
        mixedActive ? activeOccupancyMode : `hypothetical if Mixed: ${input.mixed.admissionResult}`,
        `capacity ${input.mixed.occupancy.wideOpenCount}/${input.mixed.occupancy.budget.maxWideOpen}` +
          ` (raw ${input.mixed.occupancy.rawWideOpenCount ?? input.mixed.occupancy.wideOpenCount},` +
          ` excluded diagnostic ${input.mixed.occupancy.excludedDiagnosticOpenCount ?? 0})`,
        `pressure ${input.mixed.occupancy.exceeded.join(", ") || input.mixed.occupancy.elevated.join(", ") || "none"}`,
        `candidate waits ${capacityWaitSummary || "none"}`,
        `direction pressure ${directionPressure || "none"}`,
        `global open ${input.staleAudit.openOrderCount}, stale ${input.staleAudit.staleWideHoldCount}`,
      ],
    }),
    makeNode({
      id: "paper",
      label: "Paper Execution",
      kind: "OUTPUT",
      health: input.paper.dataFailure > 0 ? "WARNING" : "ACTIVE",
      active: input.paper.open > 0,
      metric: `${input.paper.open} open / ${input.paper.closed} closed`,
      detail: [
        `headline ${input.paper.headlineClosed}`,
        `diagnostic ${input.paper.diagnosticOnlyClosed}`,
        ...(((input.paper.currentBatchCreatedCount ?? 0) > 0 && inferredBatchLane) || (inferredBatchLane && latestOpen)
          ? [`batch ${inferredBatchMode ?? "UNKNOWN"} ${inferredBatchLane}`]
          : []),
      ],
    }),
    makeNode({
      id: "outcomes",
      label: "Outcome Resolver",
      kind: "OUTPUT",
      health: queueHealth,
      active: background?.outcomeChecker === "running",
      metric: background?.outcomeChecker ?? "n/a",
      detail: [`queue lag ${finite(background?.maxLagSec) ? `${background.maxLagSec.toFixed(0)}s` : "n/a"}`],
    }),
    makeNode({
      id: "guardrail",
      label: "Mixed Guardrail",
      kind: "SAFETY",
      health: guardrailHealth,
      active: mixedActive,
      metric: guardrail.status,
      detail: [guardrail.recommendedAction, guardrail.reasons.join(", ") || "no warnings"],
    }),
    makeNode({
      id: "live-lock",
      label: "Live Safety Lock",
      kind: "SAFETY",
      health: "HEALTHY",
      active: true,
      metric: "LIVE BLOCKED",
      detail: ["paper only", "micro pilot disabled"],
    }),
  ];

  const alerts: NeuralMapAlert[] = [];
  if (scanFailed) alerts.push({ severity: "CRITICAL", source: "Core Market Scan", message: input.scanStatus?.lastAutoRefreshError ?? timing?.failureReason ?? "scan failed" });
  for (const marker of hangMarkers.slice(0, 3)) {
    alerts.push({ severity: "CRITICAL", source: marker.name, message: `hang marker at ${fmtMs(marker.elapsedMs)}` });
  }
  if (timeoutSymbols > 0) alerts.push({ severity: "WARNING", source: "Symbol Fetch", message: `${timeoutSymbols} symbol(s) failed in latest scan` });
  if (degradedProviders.length > 0) alerts.push({ severity: "WARNING", source: "Provider Circuit Breaker", message: degradedProviders.join(", ") });
  if (guardrail.status === "WARNING" || guardrail.status === "ROLLBACK_RECOMMENDED") {
    alerts.push({
      severity: guardrail.status === "ROLLBACK_RECOMMENDED" ? "CRITICAL" : "WARNING",
      source: "Mixed Budget Guardrail",
      message: `${guardrail.status}: ${guardrail.reasons.join(", ") || guardrail.recommendedAction}`,
    });
  }
  if (input.staleAudit.criticalCount > 0) {
    alerts.push({ severity: "CRITICAL", source: "Occupancy", message: `${input.staleAudit.criticalCount} critical stale order(s)` });
  }
  for (const lane of lanes.slice(0, 7)) {
    if (lane.evidenceHealth === "CRITICAL") {
      alerts.push({ severity: "CRITICAL", source: lane.label, message: lane.reason });
      continue;
    }
    if (lane.health === "CRITICAL" && lane.totalPnl < 0) {
      alerts.push({
        severity: "WARNING",
        source: lane.label,
        message: `negative realized paper PnL ${fmtNtd(lane.totalPnl)} while evidence=${lane.status}`,
      });
    }
  }

  return {
    version: "neural-map-v1",
    generatedAt,
    staleAfterSec: 30,
    controller: {
      regime: input.controller.currentRegime,
      mode: input.controller.controllerMode,
      bias: input.controller.directionalBias,
      confidence: input.controller.confidence,
      allowsLong: input.controller.allowsLong,
      allowsShort: input.controller.allowsShort,
      allowsNewEntries: input.controller.allowsNewEntries,
      reasons: input.controller.reasonCodes,
    },
    safety: { liveBlocked: true, microPilotAllowed: false, paperOnly: true },
    scan: {
      status: input.scanStatus?.lastAutoRefreshStatus ?? timing?.status ?? "UNKNOWN",
      running: Boolean(input.scanStatus?.isRunning),
      lastFinishedAt: input.scanStatus?.lastAutoRefreshFinishedAt ?? timing?.finishedAt ?? null,
      totalMs: timing?.totalScanMs ?? null,
      slowestStage: timing?.stageSummary.slowestStage?.name ?? null,
      slowestStageMs: timing?.stageSummary.slowestStage?.durationMs ?? null,
      timeoutSymbols,
      degradedProviders,
      backgroundLagSec: background?.maxLagSec ?? null,
    },
    paper: {
      total: input.paper.total,
      open: input.paper.open,
      closed: input.paper.closed,
      wins: input.paper.win,
      losses: input.paper.loss,
      headlinePnl: input.paper.realizedPaperPnl,
      diagnosticPnl: input.paper.diagnosticRealizedPaperPnl,
      totalPnl: input.paper.totalRealizedPaperPnl,
      todayPnl: input.paper.taipeiDailyTotalPnl,
      headlineNetAvgR: input.paper.headlineNetAvgR,
      headlinePF: input.paper.headlinePF,
      headlineWR: input.paper.headlineWR,
    },
    mixed: {
      activeLane: input.mixed.activeMixedLane,
      activeLanes: input.mixed.activeMixedLanes,
      tradingMode: input.mixed.mixedTradingMode,
      admission: activeAdmission,
      occupancyMode: activeOccupancyMode,
      stalePassHealth: input.mixed.stalePassHealth,
      budgetProfile: input.mixed.activeMixedBudgetProfile,
      guardrailStatus: guardrail.status,
      recommendedAction: guardrail.recommendedAction,
      waitForCapacity: mixedActive ? input.mixed.waitForCapacityCount : 0,
    },
    nodes,
    lanes,
    alerts,
  };
}

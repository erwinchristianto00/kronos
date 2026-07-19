import type { FastifyInstance } from "fastify";
import { buildVariantSelection, emptyCalibrationEvidence, type CalibrationEvidence } from "@dtc/shared";

import type { OutcomeChecker } from "../lib/outcome-checker.js";
import type { PerformanceStatsProvider } from "../lib/performance-cache.js";
import type { ScanService } from "../lib/scan-service.js";
import type { ShadowExecutionEngine } from "../lib/shadow-engine.js";
import type { SignalTracker } from "../lib/tracker.js";
import { getDecisionLedger } from "../lib/decision-ledger.js";
import { setLatestScanCandidates } from "../lib/latest-scan-candidates-cache.js";
import {
  ScanTimingCollector,
  type AsyncQueueDispatchTimingDiagnostics,
  type QueueTaskTimingDiagnostics,
} from "../lib/scan-timing-diagnostics.js";
import { buildCalibrationEvidenceFromPositions } from "../lib/expectation-calibration.js";
import {
  createCoreScanAutoRefreshController,
  type CoreScanAutoRefreshController,
} from "../lib/core-scan-auto-refresh.js";
import {
  JsonKronosCounterfactualStore,
  emitKronosCounterfactualObservations,
  type KronosCounterfactualStore,
} from "../lib/kronos-counterfactual-lane.js";
import {
  getRegimeDirectionControllerSnapshotStore,
  buildScanCycleSnapshot,
} from "../lib/regime-direction-controller-snapshot.js";
import { buildRegimeDirectionControllerReport } from "../lib/regime-direction-controller.js";
import { getRegimeEdgeMemory } from "../lib/regime-edge-memory.js";
import {
  buildCurrentGuardVariantMatrixReport,
  getCurrentGuardVariantMatrixStore,
} from "../lib/current-guard-variant-matrix.js";
import {
  isRealtimeShortMirrorEnabled,
  isRealtimeShortAllowedVariantId,
  isRealtimeShortSelectableVariantId,
  isProfitCoreShortEnabled,
  runRealtimeShortMirror,
} from "../lib/realtime-short-mirror.js";
import { fetchCrowdingSnapshot } from "../lib/derivatives-crowding.js";
import { estimateLaneSelectorV2Regime } from "../lib/lane-selector-v2.js";
import {
  buildRegimeRotationShortlistReport,
  rotationLaneIdForVariant,
} from "../lib/regime-rotation-shortlist.js";
import { buildPerSymbolLaneBookEdge } from "../lib/per-symbol-lane-book-edge.js";
import { applyBookEdgeToRotationShortlist } from "../lib/rotation-shortlist-book-overlay.js";
import type { SymbolRotationMode } from "../lib/per-symbol-rotation.js";
import { getPaperExecutionRouterStore } from "../lib/paper-execution-router.js";
import {
  RegimeControllerAlignedShadowStore,
  admitToControllerAlignedShadow,
  computeControllerAlignedGuardThreshold,
} from "../lib/regime-controller-aligned-shadow.js";
import {
  getFilteredEdgeShadowStore,
  admitToFilteredEdgeShadow,
  FILTERED_EDGE_SHADOW_LANE,
  FILTERED_EDGE_CHRONOLOGY_VERSION,
  FILTERED_EDGE_FORENSICS_VERSION,
  FILTERED_EDGE_PATH_METRIC_VERSION,
  type FilteredEdgeShadowPosition,
  type FilteredEdgeCandidate,
} from "../lib/regime-controller-filtered-edge-shadow.js";
import {
  admitToParallelShadowExperiments,
  buildParallelShadowExperimentObservation,
  collectParallelShadowExperimentMissingFields,
  deriveParallelExperimentRegimeFamily,
  getParallelShadowExperimentStore,
  type ParallelShadowExperimentCandidate,
  type ParallelShadowExperimentAdmissionDiagnostics,
  type ParallelShadowExperimentObservation,
} from "../lib/parallel-shadow-experiments.js";
import {
  admitToPortfolioTrendShadow,
  getPortfolioTrendShadowStore,
  type PortfolioTrendCandidate,
} from "../lib/portfolio-trend-shadow.js";
import type { BinanceClient } from "../lib/binance.js";
import { getRegimeEngineStore, isRegimeEngineEnabled, runRegimeEngineCycleGuarded } from "../lib/regime-engine-service.js";
import { buildRegimeAxisTimeline } from "../lib/regime-axis-timeline.js";
import { runFreshVariantMatrixFeed } from "../lib/fresh-variant-matrix-feed.js";
import {
  getCandidateFunnelLog,
  normalizeFunnelRegimeFamily,
  REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER,
  REJECTION_MISSING_EXECUTION_PLAN,
  REJECTION_STOP_DISTANCE_BELOW_175,
  REJECTION_SOURCE_CONFLICT_TRUE,
  REJECTION_LIVE_SOURCE_CONFLICT_TRUE,
  REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL,
  REJECTION_MISSING_REAL_ENTRY_GEOMETRY,
  REJECTION_MISSING_STOP_LOSS,
  REJECTION_MISSING_TAKE_PROFIT_LEVELS,
  type CandidateFunnelEntry,
} from "../lib/accelerated-evidence-candidate-funnel-log.js";

interface ScanQuery {}

function deriveTrendAlignedForDirection(candidate: {
  finalDirection?: string | null;
  indicators?: {
    fiveMinute?: { trend?: string | null };
    fifteenMinute?: { trend?: string | null };
    oneHour?: { trend?: string | null };
  };
}): boolean | null {
  const direction = candidate.finalDirection === "SHORT" ? "SHORT" : candidate.finalDirection === "LONG" ? "LONG" : null;
  if (!direction) return null;
  const labels = [
    candidate.indicators?.fiveMinute?.trend,
    candidate.indicators?.fifteenMinute?.trend,
    candidate.indicators?.oneHour?.trend,
  ].filter((trend): trend is string => typeof trend === "string" && trend.length > 0);
  if (labels.length === 0) return null;
  const alignedTrend = direction === "LONG" ? "BULLISH" : "BEARISH";
  return labels.every((label) => label === alignedTrend);
}

function deriveWhaleAgreementForDirection(
  direction: "LONG" | "SHORT",
  whale: { available?: boolean; signal?: string } | undefined,
): string {
  if (!whale || !whale.available) return "UNAVAILABLE";
  if (direction === "LONG" && whale.signal === "BULLISH") return "AGREES";
  if (direction === "SHORT" && whale.signal === "BEARISH") return "AGREES";
  if (direction === "LONG" && whale.signal === "BEARISH") return "DISAGREES";
  if (direction === "SHORT" && whale.signal === "BULLISH") return "DISAGREES";
  return "UNAVAILABLE";
}

function candidateCurrentPrice(candidate: {
  currentPrice?: number | null;
  indicators?: { fiveMinute?: { latestClose?: number | null } };
}): number | null {
  if (typeof candidate.currentPrice === "number" && Number.isFinite(candidate.currentPrice) && candidate.currentPrice > 0) {
    return candidate.currentPrice;
  }
  const latestClose = candidate.indicators?.fiveMinute?.latestClose;
  return typeof latestClose === "number" && Number.isFinite(latestClose) && latestClose > 0 ? latestClose : null;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "FALSE", "no", "NO"].includes(value);
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bumpCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function addMissingParallelExperimentFields(
  candidate: ParallelShadowExperimentCandidate,
  counts: Record<string, number>,
): void {
  for (const field of collectParallelShadowExperimentMissingFields(candidate)) bumpCount(counts, field);
}

function sortedReasonCounts(counts: Record<string, number>): Array<{ reason: string; count: number }> {
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface ManualEntryDecisionLiveEngine {
  isManualSelectorMode?: () => boolean;
  setManualEntryDecision?: (decision: {
    action: "NO_TRADE" | "WAIT_PULLBACK" | "WAIT_REJECTION";
    directionalBias: "LONG" | "SHORT" | null;
    reason: string;
    observedAt: string;
  } | null) => void;
}

/**
 * Refresh the manual-directional entry decision on the live engine every scan cycle whenever manual
 * selector mode is on. Extracted (2026-07-19 fix) so it can run INDEPENDENTLY of the mode-2
 * realtime-short-mirror env flag — LiveExecutionEngine.canOpenNewEntries() branches on
 * manualSelectorMode + manualDirectionalAllocations to isManualDirectionalEntryEnabled(), which reads
 * this.manualEntryDecision, an in-memory field with exactly one setter: setManualEntryDecision. That
 * setter used to be called ONLY inside the isRealtimeShortMirrorEnabled() block (an unrelated,
 * SHORT-only, testnet-only diagnostic flag, off by default and not even documented in .env.example).
 * On any instance where that flag was off, manualEntryDecision stayed null forever, so
 * canOpenNewEntries() stayed permanently false for every single-symbol lane whenever an operator
 * turned on manual mode + a directional allocation — regardless of what they actually allocated. The
 * dashboard showed this as a permanent "WAITING ENTRY DECISION" / "waiting for scanner" state.
 */
export function refreshManualEntryDecision(liveEngine: ManualEntryDecisionLiveEngine | null): {
  manualSelectorMode: boolean;
  manualEntryDecision: ReturnType<typeof buildRegimeAxisTimeline>["entryDecision"] | null;
} {
  const manualSelectorMode = liveEngine?.isManualSelectorMode?.() === true;
  const manualEntryDecision = manualSelectorMode
    ? buildRegimeAxisTimeline(getRegimeEngineStore().snapshots).entryDecision
    : null;
  liveEngine?.setManualEntryDecision?.(manualEntryDecision
    ? { ...manualEntryDecision, observedAt: new Date().toISOString() }
    : null);
  return { manualSelectorMode, manualEntryDecision };
}

export async function registerScanRoute(
  app: FastifyInstance,
  scanService: ScanService,
  tracker: SignalTracker | null,
  outcomeChecker: OutcomeChecker | null,
  shadowEngine: ShadowExecutionEngine | null,
  opts: {
    kronosCounterfactualStore?: KronosCounterfactualStore | null;
    binanceClient?: BinanceClient;
    performanceProvider?: PerformanceStatsProvider | null;
    liveEngineGetter?: (() => {
      laneSelectionAllowsLane(laneId: string): boolean;
      laneSelectionExplicitlyIncludesLane(laneId: string): boolean;
      isManualSelectorMode?: () => boolean;
      setManualEntryDecision?: (decision: {
        action: "NO_TRADE" | "WAIT_PULLBACK" | "WAIT_REJECTION";
        directionalBias: "LONG" | "SHORT" | null;
        reason: string;
        observedAt: string;
      } | null) => void;
    } | null);
  } = {},
): Promise<CoreScanAutoRefreshController> {
  // Lazy default — env-var-disabled and isolated from the live scan loop.
  // The store is the same JSON file the shadow-route resolver reads, so emit
  // and resolve share state without explicit handoff.
  const kronosCounterfactualDisabled = process.env.KRONOS_COUNTERFACTUAL_DISABLED === "1";
  const kronosCounterfactualStore: KronosCounterfactualStore | null =
    opts.kronosCounterfactualStore ?? (kronosCounterfactualDisabled ? null : new JsonKronosCounterfactualStore("data"));

  // Report-only controller-aligned shadow admission store.
  // Isolated file: data/regime-controller-aligned-shadow.json.
  // Disabled via CONTROLLER_ALIGNED_SHADOW_DISABLED=1.
  const controllerAlignedShadowDisabled = process.env.CONTROLLER_ALIGNED_SHADOW_DISABLED === "1";
  const controllerAlignedShadowStore: RegimeControllerAlignedShadowStore | null =
    controllerAlignedShadowDisabled ? null : new RegimeControllerAlignedShadowStore("data");

  // Report-only candidate funnel log. Disabled via CANDIDATE_FUNNEL_LOG_DISABLED=1.
  const candidateFunnelLogDisabled = process.env.CANDIDATE_FUNNEL_LOG_DISABLED === "1";

  const queuePercentiles = (values: Array<number | null>): { p50: number | null; p90: number | null; max: number | null } => {
    const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
    if (finite.length === 0) return { p50: null, p90: null, max: null };
    const at = (p: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * p) - 1))] ?? null;
    return { p50: at(0.5), p90: at(0.9), max: finite.at(-1) ?? null };
  };

  const buildAsyncQueueDiagnostics = (
    queueBuildMs: number,
    tasks: QueueTaskTimingDiagnostics[],
  ): AsyncQueueDispatchTimingDiagnostics => {
    const waits = queuePercentiles(tasks.map((task) => task.waitMs));
    const runs = queuePercentiles(tasks.map((task) => task.runMs));
    const started = tasks.map((task) => task.startedAt ? new Date(task.startedAt).getTime() : null).filter((v): v is number => v !== null && Number.isFinite(v));
    const finished = tasks.map((task) => task.finishedAt ? new Date(task.finishedAt).getTime() : null).filter((v): v is number => v !== null && Number.isFinite(v));
    const workerActiveMs = started.length > 0 && finished.length > 0 ? Math.max(0, Math.max(...finished) - Math.min(...started)) : null;
    return {
      queueBuildMs,
      queueWaitMs: waits.max,
      workerActiveMs,
      concurrencyUsed: tasks.filter((task) => task.status === "RUNNING" || task.status === "COMPLETED").length,
      taskCount: tasks.length,
      perTaskWaitMs: waits,
      perTaskRunMs: runs,
      slowestQueueTasks: [...tasks]
        .sort((a, b) => (b.runMs ?? b.waitMs ?? 0) - (a.runMs ?? a.waitMs ?? 0))
        .slice(0, 5),
      retryDelayMs: 0,
      artificialSleepMs: 0,
      rateLimitWaitMs: 0,
      tasks,
    };
  };

  // Returns a settlement promise (resolves once every dispatched task has finished/failed) — tasks
  // still start immediately via setImmediate, so no caller of scheduleAsyncQueueTasks itself waits
  // any longer than before. The settlement promise exists purely so a LATER cycle's dispatch can be
  // chained after it (see lastAsyncQueueSettled below), closing the lost-update race where two
  // cycles' background tasks (tracker/shadowEngine/outcomeChecker) concurrently read-mutate-write
  // the same JSON stores and whichever finishes last silently overwrites the other's work.
  const scheduleAsyncQueueTasks = (
    timing: ScanTimingCollector,
    queueBuildMs: number,
    tasks: Array<{ name: string; run: () => Promise<void> }>,
  ): Promise<void> => {
    const queuedAtMs = Date.now();
    const taskTimings: QueueTaskTimingDiagnostics[] = tasks.map((task) => ({
      name: task.name,
      status: "QUEUED",
      queuedAt: new Date(queuedAtMs).toISOString(),
      startedAt: null,
      finishedAt: null,
      waitMs: null,
      runMs: null,
    }));
    const update = () => timing.setAsyncQueueDispatchDiagnostics(buildAsyncQueueDiagnostics(queueBuildMs, taskTimings));
    update();
    const settlements = tasks.map((task, index) => new Promise<void>((resolve) => {
      setImmediate(() => {
        const item = taskTimings[index]!;
        const startedMs = Date.now();
        item.status = "RUNNING";
        item.startedAt = new Date(startedMs).toISOString();
        item.waitMs = Math.max(0, startedMs - queuedAtMs);
        update();
        task.run()
          .then(() => {
            item.status = "COMPLETED";
          })
          .catch((error) => {
            item.status = "FAILED";
            item.errorMessage = error instanceof Error ? error.message : "Async queue task failed.";
          })
          .finally(() => {
            const finishedMs = Date.now();
            item.finishedAt = new Date(finishedMs).toISOString();
            item.runMs = Math.max(0, finishedMs - startedMs);
            update();
            resolve();
          });
      });
    }));
    return Promise.all(settlements).then(() => undefined);
  };

  // Chains each cycle's background-task dispatch after the PREVIOUS cycle's settlement (see the
  // dispatch call site below). This must live outside runCoreScanCycle so it persists across calls.
  let lastAsyncQueueSettled: Promise<void> = Promise.resolve();

  async function runCoreScanCycle() {
    const timing = new ScanTimingCollector();
    try {
    timing.recordNotInvokedStage("externalOverlay");
    timing.recordNotInvokedStage("allocatorAdmission");
    const result = await timing.measureStage("coreMarketScan", () => scanService.scan({ timing }));
    timing.setScanBatchId(result.generatedAt);
    const performanceResult = timing.measureSyncStage(
      "analysisPerformance",
      () => (tracker && opts.performanceProvider ? opts.performanceProvider.getPerformance() : null),
    );
    if (performanceResult) {
      timing.setAnalysisPerformanceDiagnostics(performanceResult.timing);
    }
    const performance = performanceResult?.performance ?? null;
    let calibration: CalibrationEvidence | null = null;
    if (shadowEngine) {
      timing.startStage("calibrationEvidence");
      try {
        calibration = buildCalibrationEvidenceFromPositions(shadowEngine.getAllPositions());
      } catch {
        calibration = emptyCalibrationEvidence();
      } finally {
        timing.finishStage("calibrationEvidence");
      }
    } else {
      timing.recordNotInvokedStage("calibrationEvidence");
    }
    const top10WithPlan = timing.measureSyncStage("candidateScoringRouteSelection", () =>
      result.top10.map((candidate) => ({
        ...candidate,
        selectedExecutionPlan: buildVariantSelection(candidate, performance, calibration),
      })),
    );
    const ledgerEnabled = process.env.DECISION_LEDGER_DISABLED !== "1";
    if (ledgerEnabled) {
      timing.startStage("decisionLedger");
      try {
        const ledger = getDecisionLedger(process.env.DECISION_LEDGER_FILE ?? "data/decision-log.jsonl");
        const ts = new Date().toISOString();
        for (const candidate of top10WithPlan) {
          const plan = candidate.selectedExecutionPlan;
          const whaleAvail = candidate.whale.available;
          const whaleAgrees =
            (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
            (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
          const whaleDisagrees =
            (candidate.finalDirection === "LONG" && candidate.whale.signal === "BEARISH") ||
            (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BULLISH");
          const dir: "LONG" | "SHORT" = candidate.finalDirection === "SHORT" ? "SHORT" : "LONG";
          ledger.recordRouteAssigned({
            timestamp: ts,
            symbol: candidate.symbol,
            direction: dir,
            candidateId: `${candidate.symbol}-${candidate.finalDirection}-${ts}`,
            selectedExecutionPlan: plan ?? null,
            routeMode: plan?.routeMode ?? null,
            routeReasonCodes: plan?.routeReasonCodes ?? [],
            expectedNetR: plan?.expectedNetR ?? null,
            expectedGrossR: plan?.expectedGrossR ?? null,
            costR: plan?.costR ?? null,
            stopDistanceBps: plan?.stopDistanceBps ?? null,
            kronosBias: candidate.selectedKronosBias ?? candidate.kronosBias ?? null,
            kronosHorizonConflict: candidate.horizonConflict ?? false,
            liveSourceConflict: candidate.sourceConflict ?? null,
            whaleAgreement: !whaleAvail
              ? "UNAVAILABLE"
              : whaleAgrees
                ? "AGREES"
                : whaleDisagrees
                  ? "DISAGREES"
                  : "UNAVAILABLE",
          });
        }
      } catch {
        // ledger failures must never break the scan
      } finally {
        timing.finishStage("decisionLedger");
      }
    } else {
      timing.recordNotInvokedStage("decisionLedger");
    }
    if (kronosCounterfactualStore) {
      timing.startStage("kronosCounterfactual");
      try {
        // Report-only Kronos counterfactual lane emission. Isolated from live
        // scoring/ranking/readiness/route selection; only writes to its own
        // observation store. Resolution runs separately from shadow refresh.
        emitKronosCounterfactualObservations({
          candidates: top10WithPlan,
          store: kronosCounterfactualStore,
          triggerSource: "SCAN_CYCLE",
        });
      } catch {
        // counterfactual emission must never break the scan
      } finally {
        timing.finishStage("kronosCounterfactual");
      }
    } else {
      timing.recordNotInvokedStage("kronosCounterfactual");
    }
    // --- Manual-directional entry decision (2026-07-19 fix) ---
    // Must run every cycle whenever manual selector mode is on, independent of the mode-2 mirror
    // flag below — see refreshManualEntryDecision's doc comment for the incident this fixes.
    timing.startStage("manualEntryDecision");
    let liveLaneSelection: ReturnType<NonNullable<typeof opts.liveEngineGetter>> | null = null;
    let manualSelectorMode = false;
    let manualEntryDecision: ReturnType<typeof buildRegimeAxisTimeline>["entryDecision"] | null = null;
    try {
      liveLaneSelection = opts.liveEngineGetter?.() ?? null;
      ({ manualSelectorMode, manualEntryDecision } = refreshManualEntryDecision(liveLaneSelection));
    } catch {
      // manual entry decision refresh must never break the scan
    } finally {
      timing.finishStage("manualEntryDecision");
    }
    // --- Real-time short live-mirror ("mode 2") ---
    // Emits FRESH (openedAt = now) short HEADLINE orders into the dedicated mirror store so the
    // live engine can mirror the stable short edge to the exchange without the lagged
    // VM-observation staleness. Env-gated (REALTIME_SHORT_MIRROR_ENABLED=1), short-only,
    // stable-lane-only, capped per cycle. Wrapped so it can NEVER break the scan.
    if (isRealtimeShortMirrorEnabled()) {
      timing.startStage("realtimeShortMirror");
      try {
        const vmReport = buildCurrentGuardVariantMatrixReport(getCurrentGuardVariantMatrixStore());
        let rotationShortlist = buildRegimeRotationShortlistReport(vmReport, {
          generatedAt: new Date().toISOString(),
        });
        // manualSelectorMode/manualEntryDecision are now computed once above (independent of this
        // mirror flag) — reused here rather than recomputed. Manual selector is directional, not a
        // blanket BOTH_ALLOWED override: the scanner's current Entry Decision chooses which of the
        // operator's long/short lists is active. A NO_TRADE read removes all manual admission until
        // the next scan produces a directional bias.
        const manualDirection = manualEntryDecision?.action !== "NO_TRADE"
          ? manualEntryDecision?.directionalBias ?? null
          : null;
        // 2b: overlay the REALIZED per-symbol BOOK edge on the (sim-derived) rotation shortlist so
        // admission auto-rotates on real economics — book-negative symbols are vetoed (don't get stuck
        // on a bad symbol) and book-proven ones are admitted. Env-gated + OFF by default (opt-in per
        // instance: PER_SYMBOL_BOOK_ROTATION_MODE = TESTNET | LIVE_CONFIRMED | LIVE_CREDIBLE). Never
        // throws — a bad overlay must not break the scan. Skipped entirely in manual selector mode.
        if (!manualSelectorMode && process.env.PER_SYMBOL_BOOK_ROTATION_ENABLED === "1") {
          try {
            const mode = (process.env.PER_SYMBOL_BOOK_ROTATION_MODE as SymbolRotationMode) || "TESTNET";
            const bookReport = buildPerSymbolLaneBookEdge(getPaperExecutionRouterStore().getState().orders);
            rotationShortlist = applyBookEdgeToRotationShortlist(rotationShortlist, bookReport, { mode });
          } catch (err) {
            console.warn(`[scan] per-symbol book rotation overlay skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const manualEnabledVariantIds = new Set<string>();
        const liveLaneAllowsVariant = (variantId: string): boolean => {
          const laneId = rotationLaneIdForVariant(variantId);
          if (!liveLaneSelection) return true;
          if (liveLaneSelection.laneSelectionExplicitlyIncludesLane(laneId)) {
            manualEnabledVariantIds.add(variantId);
          }
          return liveLaneSelection.laneSelectionAllowsLane(laneId);
        };
        const stableShortLanes = vmReport.rows
          .filter((r) => {
            if (!liveLaneAllowsVariant(r.variantId)) return false;
            return isRealtimeShortAllowedVariantId(r.variantId) ||
              isRealtimeShortSelectableVariantId(r.variantId, manualEnabledVariantIds.has(r.variantId));
          })
          .map((r) => ({
            variantId: r.variantId,
            status: r.status,
            freshValid: r.freshValid,
            netAvgR: r.netAvgR,
            pf: r.pf,
            wr: r.wr,
            payoffRatio: r.payoffRatio,
            avgCostR: r.avgCostR,
            costDragR: r.costDragR,
            approxMaxDrawdownR: r.approxMaxDrawdownR,
            topSymbolPnlShare: r.topSymbolPnlShare,
            plus10bpsStillPositive: r.plus10bpsStillPositive,
            byRegime: r.byRegime,
            byDirection: r.byDirection,
            byRegimeFamily: r.byRegimeFamily,
            byAxisSymbol: r.byAxisSymbol,
            bySymbol: r.bySymbol,
          }));
        // Smart direction gate (2026-07-01): hard-veto a direction whose realized, honestly-accounted
        // edge (regimeFamily × direction) has proven non-positive at adequate sample (n>=30), unless a
        // specific lane within it is separately proven positive (hasPositiveLane rescue). Previously
        // this ran ONLY as a / diagnostic (buildRegimeDirectionControllerReport was called without
        // edgeGate here) — the mirror's live/testnet order admission was never actually protected by
        // it. Pure risk-reducer: can only narrow controllerMode (e.g. to NO_TRADE_NEGATIVE_EDGE), never
        // widen it, so this cannot ADD a trade that wasn't already regime-permitted.
        const baseControllerReport = buildRegimeDirectionControllerReport({
          currentRegime: result.marketRegime,
          edgeGate: getRegimeEdgeMemory(),
        });
        const controllerReport = !manualSelectorMode
          ? baseControllerReport
          : manualDirection === "LONG"
            ? {
                ...baseControllerReport,
                controllerMode: "LONG_ONLY" as const,
                directionalBias: "LONG" as const,
                allowsLong: true,
                allowsShort: false,
                allowsNewEntries: true,
                requiresRetest: true,
                edgeGated: false,
                reasonCodes: [...baseControllerReport.reasonCodes, "manual_entry_decision_long"],
              }
            : manualDirection === "SHORT"
              ? {
                  ...baseControllerReport,
                  controllerMode: "SHORT_ONLY" as const,
                  directionalBias: "SHORT" as const,
                  allowsLong: false,
                  allowsShort: true,
                  allowsNewEntries: true,
                  requiresRetest: true,
                  edgeGated: false,
                  reasonCodes: [...baseControllerReport.reasonCodes, "manual_entry_decision_short"],
                }
              : {
                  ...baseControllerReport,
                  controllerMode: "NO_TRADE_CHOP" as const,
                  directionalBias: "NEUTRAL" as const,
                  allowsLong: false,
                  allowsShort: false,
                  allowsNewEntries: false,
                  requiresRetest: true,
                  edgeGated: false,
                  reasonCodes: [...baseControllerReport.reasonCodes, "manual_entry_decision_no_trade"],
                };
        const profitCoreEstimatedRegime = estimateLaneSelectorV2Regime({
          regime: baseControllerReport.currentRegime,
          controllerMode: baseControllerReport.controllerMode,
          confidence: baseControllerReport.confidence,
        });
        const estimatedRegime = estimateLaneSelectorV2Regime({
          regime: controllerReport.currentRegime,
          controllerMode: controllerReport.controllerMode,
          confidence: controllerReport.confidence,
        });
        // Auto-wired crowding veto: fetch crowd state per candidate so the mirror can skip entries
        // into a same-side EXTREME crowd. Env-gated (CROWDING_VETO_ENABLED); best-effort.
        const crowdingVetoEnabled = process.env.CROWDING_VETO_ENABLED === "1";
        const crowdingBySymbol: Record<string, { crowdSide: string; crowdingLevel: string }> = {};
        if (crowdingVetoEnabled && opts.binanceClient) {
          const crowdClient = opts.binanceClient;
          const crowdNow = new Date().toISOString();
          const crowdSyms = [...new Set(top10WithPlan.map((c) => c.symbol))];
          const crowdSnaps = await Promise.all(
            crowdSyms.map((s) => fetchCrowdingSnapshot(crowdClient, s, crowdNow).catch(() => null)),
          );
          for (const snap of crowdSnaps) {
            if (snap) crowdingBySymbol[snap.symbol] = { crowdSide: snap.crowdSide, crowdingLevel: snap.crowdingLevel };
          }
        }
        runRealtimeShortMirror({
          candidates: top10WithPlan
            .filter((c) => !manualSelectorMode || (manualDirection !== null && c.finalDirection === manualDirection))
            .map((c) => ({
            symbol: c.symbol,
            direction: (c.finalDirection === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
            currentPrice: candidateCurrentPrice(c),
            stopLoss:
              typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0
                ? c.stopLoss
                : null,
            takeProfitLevels: [c.takeProfits?.tp1, c.takeProfits?.tp2, c.takeProfits?.tp3].filter(
              (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
            ),
            stopDistanceBps: c.selectedExecutionPlan?.stopDistanceBps ?? null,
            selectedEntryVariant: c.selectedExecutionPlan?.selectedEntryVariant ?? null,
            selectedExitVariant: c.selectedExecutionPlan?.selectedExitVariant ?? null,
            routeMode: c.selectedExecutionPlan?.routeMode ?? null,
            chaseRisk: c.selectedExecutionPlan?.chaseRisk ?? null,
            riskReward: c.riskReward ?? null,
            calibratedExpectedNetR: c.selectedExecutionPlan?.calibratedExpectedNetR ?? null,
            calibrationVerdict: c.selectedExecutionPlan?.calibrationVerdict ?? null,
            whaleSignal: c.whale.signal ?? null,
            sourceConflict: c.sourceConflict ?? null,
            horizonConflict: c.horizonConflict ?? null,
          })),
          regime: result.marketRegime,
          controllerMode: controllerReport.controllerMode,
          controllerConfidence: controllerReport.confidence,
          estimatedRegime,
          stableShortLanes,
          forceFastShort: process.env.REALTIME_SHORT_FORCE_FAST_SHORT === "1",
          forceFastLong: process.env.REALTIME_SHORT_FORCE_FAST_LONG === "1",
          crowdingVetoEnabled,
          crowdingBySymbol,
          rotationShortlist,
          manualEnabledVariantIds,
          profitCoreShortEnabled: isProfitCoreShortEnabled(),
          profitCoreControllerMode: baseControllerReport.controllerMode,
          profitCoreEstimatedRegime,
          now: new Date().toISOString(),
        });
      } catch {
        // mirror emission must never break the scan
      } finally {
        timing.finishStage("realtimeShortMirror");
      }
    } else {
      timing.recordNotInvokedStage("realtimeShortMirror");
    }

    // Fresh variant-matrix measurement feed — the live-honest replacement for the stale
    // shadow-position feed. Samples the scanner's FRESH candidates with openedAt=now,
    // posture tags, and the mirrored-opposite direction twin (50/50 mix under the same
    // cap). Env-gated: ONLY the "/" diagnostic instance sets FRESH_VM_FEED_ENABLED=1,
    // so live (3102/3103) lane-stability inputs are untouched.
    if (process.env.FRESH_VM_FEED_ENABLED === "1") {
      try {
        const freshController = buildRegimeDirectionControllerReport({ currentRegime: result.marketRegime });
        const freshStore = getCurrentGuardVariantMatrixStore();
        // Tag each obs with the derivatives crowding state at signal time (report-only, best-effort).
        const freshCrowdingBySymbol: Record<string, string | null> = {};
        if (opts.binanceClient) {
          const crowdClient = opts.binanceClient;
          const crowdNow = new Date().toISOString();
          const crowdSyms = [...new Set(top10WithPlan.map((c) => c.symbol))];
          const crowdSnaps = await Promise.all(
            crowdSyms.map((s) => fetchCrowdingSnapshot(crowdClient, s, crowdNow).catch(() => null)),
          );
          for (const snap of crowdSnaps) if (snap) freshCrowdingBySymbol[snap.symbol] = snap.crowdingState;
        }
        runFreshVariantMatrixFeed(
          {
            candidates: top10WithPlan.map((c) => ({
              symbol: c.symbol,
              direction: (c.finalDirection === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
              entryPrice: candidateCurrentPrice(c),
              stopLoss:
                typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0 ? c.stopLoss : null,
              takeProfitLevels: [c.takeProfits?.tp1, c.takeProfits?.tp2, c.takeProfits?.tp3].filter(
                (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
              ),
              stopDistanceBps: c.selectedExecutionPlan?.stopDistanceBps ?? null,
            })),
            regime: result.marketRegime,
            controllerMode: freshController.controllerMode,
            controllerConfidence: freshController.confidence,
            crowdingBySymbol: freshCrowdingBySymbol,
            now: new Date().toISOString(),
          },
          freshStore,
        );
      } catch {
        // measurement intake must never break the scan
      }
    }

    // --- Report-only: regime switching engine cycle (hypothesis framework) ---
    // Fire-and-forget: fetches BTC/ETH/universe candles + breadth from Binance,
    // runs contextFromCandles → buildTradingDecision, and RECORDS the decision.
    // Never places orders. Env-gated; internally single-flight + min-interval.
    if (isRegimeEngineEnabled() && opts.binanceClient) {
      runRegimeEngineCycleGuarded(opts.binanceClient, new Date().toISOString());
    }

    // --- Report-only: regime direction controller scan-cycle snapshot ---
    // Lightweight snapshot using only marketRegime (other inputs unavailable
    // at scan-cycle time). Full snapshots with all inputs are written by the
    // dashboard-audit-summary endpoint in shadow.ts.
    // Wrapped in try/catch — never throws into the scan cycle.
    timing.startStage("regimeSnapshot");
    try {
      const snapshotStore = getRegimeDirectionControllerSnapshotStore();
      const snapshot = buildScanCycleSnapshot(result.marketRegime);
      snapshotStore.append(snapshot);
    } catch {
      // persistence failures must never break the scan
    } finally {
      timing.finishStage("regimeSnapshot");
    }

    // --- Report-only: controller-aligned shadow admission ---
    // Emits to data/regime-controller-aligned-shadow.json only when the
    // controller is in LONG_ONLY or SHORT_ONLY mode and the candidate
    // direction matches. Does NOT touch data/shadow-positions.json.
    // Wrapped in try/catch — never throws into the scan cycle.
    if (controllerAlignedShadowStore) {
      timing.startStage("regimeController");
      try {
        const controllerReport = buildRegimeDirectionControllerReport({
          currentRegime: result.marketRegime,
        });
        // Build a price map from the same scan-time market price used by the
        // normal shadow engine: Kronos currentPrice if provided, otherwise the
        // latest completed 5m close.
        const priceMap = new Map<string, number>();
        for (const candidate of top10WithPlan) {
          const price = candidateCurrentPrice(candidate);
          if (price !== null) {
            priceMap.set(candidate.symbol, price);
          }
        }
        admitToControllerAlignedShadow(
          top10WithPlan.map((c) => {
            // Real geometry from the candidate:
            //   entryPrice: the selected entry variant anchor from VariantSelectionSnapshot,
            //               resolved by buildVariantSelection (stored as anchor; use currentPrice
            //               as fallback since anchor is not directly exposed on the snapshot — the
            //               priceMap already carries the live currentPrice at scan time).
            //   stopLoss:   candidate.stopLoss (from ScanCandidate, set by the scan engine)
            //   takeProfitLevels: candidate.takeProfits.tp1/tp2/tp3 (filtered non-null)
            const candidateStopLoss =
              typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0
                ? c.stopLoss
                : null;
            const tp1 =
              typeof c.takeProfits?.tp1 === "number" && Number.isFinite(c.takeProfits.tp1) && c.takeProfits.tp1 > 0
                ? c.takeProfits.tp1
                : null;
            const tp2 =
              typeof c.takeProfits?.tp2 === "number" && Number.isFinite(c.takeProfits.tp2) && c.takeProfits.tp2 > 0
                ? c.takeProfits.tp2
                : null;
            const tp3 =
              typeof c.takeProfits?.tp3 === "number" && Number.isFinite(c.takeProfits.tp3) && c.takeProfits.tp3 > 0
                ? c.takeProfits.tp3
                : null;
            const tpLevels: number[] = [tp1, tp2, tp3].filter((v): v is number => v !== null);
            return {
              symbol: c.symbol,
              direction: (c.finalDirection === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
              routeMode: c.selectedExecutionPlan?.routeMode ?? null,
              currentPrice: candidateCurrentPrice(c),
              // atrPercent from candidate.atr.atrPercent (percent-form: 0.69 = 0.69%)
              atrPercent: typeof c.atr?.atrPercent === "number" ? c.atr.atrPercent : null,
              selectedExecutionPlan: c.selectedExecutionPlan
                ? {
                    selectedEntryVariant: c.selectedExecutionPlan.selectedEntryVariant ?? null,
                    selectedExitVariant: c.selectedExecutionPlan.selectedExitVariant ?? null,
                    stopDistanceBps: c.selectedExecutionPlan.stopDistanceBps ?? null,
                    routeMode: c.selectedExecutionPlan.routeMode ?? null,
                  }
                : null,
              sourceConflict: c.sourceConflict ?? null,
              kronosBias:
                c.selectedKronosBias ?? (typeof c.kronosBias === "string" ? c.kronosBias : null),
              // Real geometry — replaces the old hardcoded placeholders (stopLoss=0, takeProfitLevels=[])
              stopLoss: candidateStopLoss,
              takeProfitLevels: tpLevels,
            };
          }),
          controllerAlignedShadowStore,
          { controllerReport, currentPrices: priceMap },
        );

        // --- Report-only: candidate-level funnel log emission ---
        // Records each candidate's admission decision for diagnostics.
        // Disabled via CANDIDATE_FUNNEL_LOG_DISABLED=1. Never throws.
        if (!candidateFunnelLogDisabled) {
          try {
            const funnelLog = getCandidateFunnelLog();
            const scanCycleId = new Date().toISOString();
            const mode = controllerReport.controllerMode;
            const controllerIsDirectional = mode === "LONG_ONLY" || mode === "SHORT_ONLY";

            for (const c of top10WithPlan) {
              const direction: "LONG" | "SHORT" = c.finalDirection === "SHORT" ? "SHORT" : "LONG";
              const controllerAllowsDirection =
                mode === "LONG_ONLY" ? direction === "LONG"
                : mode === "SHORT_ONLY" ? direction === "SHORT"
                : mode === "BOTH_ALLOWED" ? true
                : false;

              const hasSelectedExecutionPlan = Boolean(c.selectedExecutionPlan);
              const stopDistanceBps = c.selectedExecutionPlan?.stopDistanceBps ?? null;
              const stop175Pass = stopDistanceBps !== null ? stopDistanceBps >= 175 : null;

              // Phase 2Z.1: variant-adjusted guard diagnostics
              const candidateAtrPercent = typeof c.atr?.atrPercent === "number" ? c.atr.atrPercent : null;
              const funnelGuardResult = computeControllerAlignedGuardThreshold(candidateAtrPercent);
              const funnelAtrBps = funnelGuardResult.atrBps;
              const funnelVariantAdjustedGuardThresholdBps = funnelGuardResult.variantAdjustedGuardThresholdBps;
              const funnelLegacyStop175Pass = stopDistanceBps !== null ? stopDistanceBps >= 175 : null;
              const funnelVariantAdjustedStopPass =
                stopDistanceBps !== null
                  ? stopDistanceBps >= funnelVariantAdjustedGuardThresholdBps
                  : null;
              const funnelGuardPassedUnder: CandidateFunnelEntry["guardPassedUnder"] =
                stopDistanceBps === null
                  ? "UNKNOWN"
                  : stopDistanceBps >= 175
                  ? "LEGACY_175"
                  : funnelVariantAdjustedStopPass === true
                  ? "VARIANT_ADJUSTED"
                  : "FAILED_VARIANT_ADJUSTED";
              const sourceConflict = (c as { sourceConflict?: boolean | null }).sourceConflict ?? null;
              const liveSourceConflict = (c as { liveSourceConflict?: boolean | null }).liveSourceConflict ?? null;
              const kronosBias = c.selectedKronosBias ?? (typeof c.kronosBias === "string" ? c.kronosBias : null);

              // Derive whaleAgreement
              let whaleAgreement: string | null = null;
              const whaleField = (c as { whale?: { available?: boolean; signal?: string } }).whale;
              if (whaleField && typeof whaleField === "object") {
                if (!whaleField.available) {
                  whaleAgreement = "UNAVAILABLE";
                } else if (
                  (direction === "LONG" && whaleField.signal === "BULLISH") ||
                  (direction === "SHORT" && whaleField.signal === "BEARISH")
                ) {
                  whaleAgreement = "AGREES";
                } else if (
                  (direction === "LONG" && whaleField.signal === "BEARISH") ||
                  (direction === "SHORT" && whaleField.signal === "BULLISH")
                ) {
                  whaleAgreement = "DISAGREES";
                } else {
                  whaleAgreement = "UNAVAILABLE";
                }
              }

              // Build rejection reasons
              const rejectionReasons: string[] = [];
              if (!controllerIsDirectional) {
                rejectionReasons.push(REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL);
              } else if (!controllerAllowsDirection) {
                rejectionReasons.push(REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER);
              }
              if (!hasSelectedExecutionPlan) {
                rejectionReasons.push(REJECTION_MISSING_EXECUTION_PLAN);
              }
              if (stop175Pass === false) {
                rejectionReasons.push(REJECTION_STOP_DISTANCE_BELOW_175);
              }
              if (sourceConflict === true) {
                rejectionReasons.push(REJECTION_SOURCE_CONFLICT_TRUE);
              }
              if (liveSourceConflict === true) {
                rejectionReasons.push(REJECTION_LIVE_SOURCE_CONFLICT_TRUE);
              }

              // Geometry checks — mirrors the new admission validation in admitToControllerAlignedShadow
              const funnelEntryPrice = priceMap.get(c.symbol) ?? candidateCurrentPrice(c);
              const funnelStopLoss =
                typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0
                  ? c.stopLoss
                  : null;
              const funnelTp1 =
                typeof c.takeProfits?.tp1 === "number" && Number.isFinite(c.takeProfits.tp1) && c.takeProfits.tp1 > 0
                  ? c.takeProfits.tp1
                  : null;
              const hasValidEntryPrice = funnelEntryPrice !== null && funnelEntryPrice > 0;
              const hasValidStopLoss = funnelStopLoss !== null;
              const hasValidTpLevels = funnelTp1 !== null;

              if (!hasValidEntryPrice) {
                rejectionReasons.push(REJECTION_MISSING_REAL_ENTRY_GEOMETRY);
              }
              if (!hasValidStopLoss) {
                rejectionReasons.push(REJECTION_MISSING_STOP_LOSS);
              }
              if (!hasValidTpLevels) {
                rejectionReasons.push(REJECTION_MISSING_TAKE_PROFIT_LEVELS);
              }

              const normalShadowEligible =
                stop175Pass === true &&
                hasSelectedExecutionPlan &&
                sourceConflict !== true &&
                liveSourceConflict !== true;

              // controllerAlignedEligible now also requires valid geometry
              const controllerAlignedEligible =
                normalShadowEligible &&
                controllerAllowsDirection &&
                controllerIsDirectional &&
                hasValidEntryPrice &&
                hasValidStopLoss &&
                hasValidTpLevels;

              // Check if this candidate was actually admitted (OPEN status, requires all geometry)
              const routeMode = c.selectedExecutionPlan?.routeMode ?? null;
              const entryPrice = funnelEntryPrice;
              const controllerAlignedOpened =
                controllerAlignedEligible &&
                entryPrice !== null &&
                entryPrice !== 0;

              const rawCurrentRegime = result.marketRegime ?? null;
              const entry: CandidateFunnelEntry = {
                timestamp: scanCycleId,
                scanCycleId,
                source: "SCAN_CYCLE",
                symbol: c.symbol,
                direction,
                currentRegime: rawCurrentRegime,
                rawCurrentRegime,
                normalizedRegimeFamily: normalizeFunnelRegimeFamily(rawCurrentRegime),
                controllerMode: mode,
                controllerReasonCodes: controllerReport.reasonCodes,
                controllerSource: "SCAN_CYCLE",
                controllerAllowsDirection,
                selectedEntryVariant: c.selectedExecutionPlan?.selectedEntryVariant ?? null,
                selectedExitVariant: c.selectedExecutionPlan?.selectedExitVariant ?? null,
                routeMode,
                hasSelectedExecutionPlan,
                stopDistanceBps,
                stop175Pass,
                sourceConflict,
                liveSourceConflict,
                kronosBias: kronosBias ?? null,
                whaleAgreement,
                normalShadowEligible,
                controllerAlignedEligible,
                controllerAlignedOpened,
                rejectionReasons,
                // Phase 2Z.1: variant-adjusted guard diagnostics
                atrBps: funnelAtrBps,
                variantAdjustedGuardThresholdBps: funnelVariantAdjustedGuardThresholdBps,
                legacyStop175Pass: funnelLegacyStop175Pass,
                variantAdjustedStopPass: funnelVariantAdjustedStopPass,
                guardPassedUnder: funnelGuardPassedUnder,
              };
              funnelLog.append(entry);
            }
          } catch {
            // funnel log emission must never break the scan
          }
        }
      } catch {
        // controller-aligned admission must never break the scan
      } finally {
        timing.finishStage("regimeController");
      }
    } else {
      timing.recordNotInvokedStage("regimeController");
    }

    // --- Report-only: filtered edge shadow admission ---
    // Emits to data/regime-controller-filtered-edge-shadow.json only when both
    // controller-aligned base gates AND a cost/stop profile gate pass.
    // Excludes BTCUSDT and SEIUSDT. Does NOT touch data/shadow-positions.json.
    // Wrapped in try/catch — never throws into the scan cycle.
    timing.startStage("filteredEdgeAdmission");
    try {
      if (!process.env.FILTERED_EDGE_SHADOW_DISABLED) {
        const controllerReport = buildRegimeDirectionControllerReport({
          currentRegime: result.marketRegime,
        });
        const filteredStore = getFilteredEdgeShadowStore();

        for (const c of top10WithPlan) {
          try {
            const direction: "LONG" | "SHORT" = c.finalDirection === "SHORT" ? "SHORT" : "LONG";
            const candidateAtrPercent = typeof c.atr?.atrPercent === "number" ? c.atr.atrPercent : null;
            const guardResult = computeControllerAlignedGuardThreshold(candidateAtrPercent);

            const filteredCandidate: FilteredEdgeCandidate = {
              symbol: c.symbol,
              direction,
              controllerMode: controllerReport.controllerMode,
              currentRegime: controllerReport.currentRegime ?? null,
              marketRegimeAtOpen: (result.marketRegime ?? null) as string | null,
              entryPrice: candidateCurrentPrice(c) ?? 0,
              stopLoss:
                typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0
                  ? c.stopLoss
                  : 0,
              takeProfits: {
                tp1: typeof c.takeProfits?.tp1 === "number" && c.takeProfits.tp1 > 0 ? c.takeProfits.tp1 : undefined,
                tp2: typeof c.takeProfits?.tp2 === "number" && c.takeProfits.tp2 > 0 ? c.takeProfits.tp2 : undefined,
                tp3: typeof c.takeProfits?.tp3 === "number" && c.takeProfits.tp3 > 0 ? c.takeProfits.tp3 : undefined,
              },
              stopDistanceBps: c.selectedExecutionPlan?.stopDistanceBps ?? null,
              costR: c.selectedExecutionPlan?.costR ?? null,
              atrPercent: candidateAtrPercent,
              sourceConflict: (c as { sourceConflict?: boolean | null }).sourceConflict === true,
              liveSourceConflict: (c as { liveSourceConflict?: boolean | null }).liveSourceConflict ?? null,
              kronosBias: c.selectedKronosBias ?? (typeof c.kronosBias === "string" ? c.kronosBias : null),
              whaleAgreement: (() => {
                const wf = (c as { whale?: { available?: boolean; signal?: string } }).whale;
                if (!wf || !wf.available) return "UNAVAILABLE";
                if (direction === "LONG" && wf.signal === "BULLISH") return "AGREES";
                if (direction === "SHORT" && wf.signal === "BEARISH") return "AGREES";
                if (direction === "LONG" && wf.signal === "BEARISH") return "DISAGREES";
                if (direction === "SHORT" && wf.signal === "BULLISH") return "DISAGREES";
                return "UNAVAILABLE";
              })(),
              selectedEntryVariant: c.selectedExecutionPlan?.selectedEntryVariant ?? null,
              selectedExitVariant: c.selectedExecutionPlan?.selectedExitVariant ?? null,
              kronosHorizonConflict: (c as { horizonConflict?: boolean | null }).horizonConflict ?? null,
              selectedExecutionPlan: c.selectedExecutionPlan ?? null,
            };

            const filteredAdmission = admitToFilteredEdgeShadow(filteredCandidate, filteredStore);

            if (filteredAdmission.admitted && filteredAdmission.profile) {
              const tp1 = filteredCandidate.takeProfits.tp1 ?? 0;
              const tp2 = filteredCandidate.takeProfits.tp2 ?? 0;
              const tp3 = filteredCandidate.takeProfits.tp3 ?? 0;
              const nowIso = new Date().toISOString();
              const pos: FilteredEdgeShadowPosition = {
                id: `${c.symbol}-${filteredAdmission.profile}-${Date.now()}`,
                symbol: c.symbol,
                direction,
                profile: filteredAdmission.profile,
                controllerMode: controllerReport.controllerMode,
                currentRegime: controllerReport.currentRegime ?? null,
                marketRegimeAtOpen: (result.marketRegime ?? null) as string | null,
                openedAt: nowIso,
                createdAt: nowIso,
                entryPrice: filteredCandidate.entryPrice,
                stopLoss: filteredCandidate.stopLoss,
                takeProfitLevels: [tp1, tp2, tp3].filter((x) => x > 0),
                stopDistanceBps: filteredCandidate.stopDistanceBps ?? null,
                costR: filteredCandidate.costR ?? null,
                atrPercent: filteredCandidate.atrPercent ?? null,
                variantAdjustedGuardThresholdBps: guardResult.variantAdjustedGuardThresholdBps,
                guardPassedUnder: "VARIANT_ADJUSTED",
                sourceConflict: filteredCandidate.sourceConflict,
                liveSourceConflict: filteredCandidate.liveSourceConflict ?? null,
                kronosBias: filteredCandidate.kronosBias ?? null,
                whaleAgreement: filteredCandidate.whaleAgreement ?? null,
                selectedEntryVariant: filteredCandidate.selectedEntryVariant ?? null,
                selectedExitVariant: filteredCandidate.selectedExitVariant ?? null,
                kronosHorizonConflict: filteredCandidate.kronosHorizonConflict ?? null,
                status: "OPEN",
                closedAt: null,
                grossR: null,
                netR: null,
                resolutionSource: null,
                durationMinutes: null,
                reportOnly: true,
                laneVersion: FILTERED_EDGE_SHADOW_LANE,
                policyVersion: "filtered-edge-anchor-consistent-v1",
                analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
                pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
                chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
              };
              filteredStore.add(pos);
            }
          } catch {
            // per-candidate failures must never break the scan
          }
        }
      }
    } catch {
      // filtered edge shadow admission must never break the scan
    } finally {
      timing.finishStage("filteredEdgeAdmission");
    }

    // --- Report-only: parallel shadow experiment matrix admission ---
    // Emits to data/parallel-shadow-experiments.json only. A candidate can enter
    // multiple experiments; duplicate suppression is per experiment.
    // Wrapped in try/catch so this research tape can never affect the scan.
    timing.startStage("parallelShadowAdmission");
    try {
      const experimentStore = getParallelShadowExperimentStore();
      const matrixDisabled =
        parseBooleanEnv(process.env.PARALLEL_SHADOW_EXPERIMENTS_DISABLED, false) ||
        parseBooleanEnv(process.env.EXPERIMENT_MATRIX_DISABLED, false);
      const nowIso = new Date().toISOString();
      const scanBatchId = nowIso;
      const fieldMissingCounts: Record<string, number> = {};
      const rejectedReasonCounts: Record<string, number> = {};
      let candidatesSeen = 0;
      let candidatesEvaluated = 0;
      let observationsCreated = 0;
      let duplicateSuppressed = 0;

      if (!matrixDisabled) {
        const controllerReport = buildRegimeDirectionControllerReport({
          currentRegime: result.marketRegime,
        });
        const observationsToAdd: ParallelShadowExperimentObservation[] = [];
        const experimentCandidatesWithPlan = [
          ...top10WithPlan,
          ...result.diagnostics.hiddenSkips.map((candidate) => ({
            ...candidate,
            selectedExecutionPlan: buildVariantSelection(candidate, performance, calibration),
          })),
        ];
        candidatesSeen = experimentCandidatesWithPlan.length;

        for (const c of experimentCandidatesWithPlan) {
          try {
            const direction: "LONG" | "SHORT" = c.finalDirection === "SHORT" ? "SHORT" : "LONG";
            const whaleAgreement = deriveWhaleAgreementForDirection(
              direction,
              (c as { whale?: { available?: boolean; signal?: string } }).whale,
            );
            const kronosBias = c.selectedKronosBias ?? (typeof c.kronosBias === "string" ? c.kronosBias : null);
            const horizonConflict = (c as { horizonConflict?: boolean | null }).horizonConflict ?? null;
            const experimentCandidate: ParallelShadowExperimentCandidate = {
              symbol: c.symbol,
              direction,
              controllerMode: controllerReport.controllerMode,
              currentRegime: controllerReport.currentRegime ?? null,
              marketRegimeAtOpen: (result.marketRegime ?? null) as string | null,
              regimeFamily: deriveParallelExperimentRegimeFamily(result.marketRegime ?? null),
              entryPrice: candidateCurrentPrice(c) ?? 0,
              stopLoss:
                typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0
                  ? c.stopLoss
                  : 0,
              takeProfits: {
                tp1: typeof c.takeProfits?.tp1 === "number" && c.takeProfits.tp1 > 0 ? c.takeProfits.tp1 : undefined,
                tp2: typeof c.takeProfits?.tp2 === "number" && c.takeProfits.tp2 > 0 ? c.takeProfits.tp2 : undefined,
                tp3: typeof c.takeProfits?.tp3 === "number" && c.takeProfits.tp3 > 0 ? c.takeProfits.tp3 : undefined,
              },
              stopDistanceBps: c.selectedExecutionPlan?.stopDistanceBps ?? null,
              costR: c.selectedExecutionPlan?.costR ?? null,
              atrPercent: typeof c.atr?.atrPercent === "number" ? c.atr.atrPercent : null,
              sourceConflict: (c as { sourceConflict?: boolean | null }).sourceConflict === true,
              liveSourceConflict: (c as { liveSourceConflict?: boolean | null }).liveSourceConflict ?? null,
              kronosBias,
              kronosAgrees: kronosBias === "LONG" || kronosBias === "SHORT"
                ? kronosBias === direction && horizonConflict !== true
                : false,
              whaleAgreement,
              trendAligned: deriveTrendAlignedForDirection(c),
              selectedEntryVariant: c.selectedExecutionPlan?.selectedEntryVariant ?? null,
              selectedExitVariant: c.selectedExecutionPlan?.selectedExitVariant ?? null,
              kronosHorizonConflict: horizonConflict,
              selectedExecutionPlan: c.selectedExecutionPlan ?? null,
            };
            candidatesEvaluated += 1;
            addMissingParallelExperimentFields(experimentCandidate, fieldMissingCounts);

            const admission = admitToParallelShadowExperiments(experimentCandidate, experimentStore);
            for (const experimentId of admission.admittedExperimentIds) {
              observationsToAdd.push(buildParallelShadowExperimentObservation(experimentCandidate, experimentId, nowIso));
            }
            for (const reasons of Object.values(admission.rejectedByExperiment)) {
              for (const reason of reasons) {
                bumpCount(rejectedReasonCounts, reason);
                if (reason === "DUPLICATE_OPEN_OBSERVATION_FOR_EXPERIMENT") duplicateSuppressed += 1;
              }
            }
          } catch {
            // per-candidate failures must never break the scan
          }
        }
        observationsCreated = observationsToAdd.length;
        experimentStore.addMany(observationsToAdd);
      }
      const diagnostics: ParallelShadowExperimentAdmissionDiagnostics = {
        disabled: matrixDisabled,
        matrixAdmissionInvoked: true,
        lastAdmissionAt: nowIso,
        lastScanBatchId: scanBatchId,
        candidatesSeen,
        candidatesEvaluated,
        observationsCreated,
        duplicateSuppressed,
        rejectedTotal: Object.values(rejectedReasonCounts).reduce((sum, count) => sum + count, 0),
        rejectedByReason: sortedReasonCounts(rejectedReasonCounts),
        fieldMissingCounts,
        env: {
          PARALLEL_SHADOW_EXPERIMENTS_DISABLED: process.env.PARALLEL_SHADOW_EXPERIMENTS_DISABLED ?? null,
          EXPERIMENT_MATRIX_DISABLED: process.env.EXPERIMENT_MATRIX_DISABLED ?? null,
        },
      };
      experimentStore.recordAdmissionDiagnostics(diagnostics);
    } catch {
      // parallel shadow experiment admission must never break the scan
    } finally {
      timing.finishStage("parallelShadowAdmission");
    }

    // --- Report-only: Portfolio Trend Shadow V1 admission ---
    // Emits to data/portfolio-trend-shadow.json only. Does NOT touch
    // data/shadow-positions.json. Wrapped in try/catch; never throws.
    // Disabled via PORTFOLIO_TREND_SHADOW_DISABLED=1.
    timing.startStage("portfolioTrendAdmission");
    try {
      if (!process.env.PORTFOLIO_TREND_SHADOW_DISABLED) {
        const ptStore = getPortfolioTrendShadowStore();
        for (const c of top10WithPlan) {
          try {
            const direction: "LONG" | "SHORT" =
              c.finalDirection === "SHORT" ? "SHORT" : "LONG";
            const trendStrength =
              typeof c.opportunityScore === "number"
                ? Math.max(0, Math.min(1, c.opportunityScore / 100))
                : null;
            const ptCandidate: PortfolioTrendCandidate = {
              symbol: c.symbol,
              direction,
              marketRegime: result.marketRegime ?? null,
              trendStrength,
              atrPercent:
                typeof c.atr?.atrPercent === "number" ? c.atr.atrPercent : null,
              entryPrice: candidateCurrentPrice(c) ?? 0,
              liquidityTier: "TIER_1",
              costR: c.selectedExecutionPlan?.costR ?? null,
            };
            const ptResult = admitToPortfolioTrendShadow(ptCandidate, ptStore);
            if (ptResult.admitted && ptResult.position) {
              ptStore.add(ptResult.position);
            }
          } catch {
            // per-candidate failures must never break the scan
          }
        }
      }
    } catch {
      // portfolio trend admission must never break the scan
    } finally {
      timing.finishStage("portfolioTrendAdmission");
    }

    const hiddenSkipsWithPlan = timing.measureSyncStage("hiddenSkipScoring", () =>
      result.diagnostics.hiddenSkips.map((candidate) => ({
        ...candidate,
        selectedExecutionPlan: buildVariantSelection(candidate, performance, calibration),
      })),
    );
    timing.startStage("responseAssembly");
    const withExecutionPlan = {
      ...result,
      top10: top10WithPlan,
      diagnostics: {
        ...result.diagnostics,
        hiddenSkips: hiddenSkipsWithPlan,
        trackingQueued: Boolean(tracker),
        shadowQueued: Boolean(shadowEngine),
        outcomeCheckQueued: Boolean(outcomeChecker),
        trackerLastUpdatedAt: tracker?.getLastTrackerUpdateAt() ?? null,
      },
    };
    timing.finishStage("responseAssembly");
    timing.startStage("asyncQueueDispatch");
    const asyncQueueBuildStartedMs = Date.now();
    const asyncTasks: Array<{ name: string; run: () => Promise<void> }> = [];
    if (tracker) {
      asyncTasks.push({
        name: "tracker.persistScan",
        run: async () => {
          await tracker.persistScan(withExecutionPlan);
          opts.performanceProvider?.warm();
        },
      });
    }
    if (shadowEngine) {
      asyncTasks.push({
        name: "shadowEngine.processScan",
        run: () => shadowEngine.processScan(withExecutionPlan),
      });
    }
    if (outcomeChecker) {
      asyncTasks.push({
        name: "outcomeChecker.checkPending",
        run: async () => {
          await outcomeChecker.checkPending();
          opts.performanceProvider?.warm();
        },
      });
    }
    const queueBuildMs = Math.max(0, Date.now() - asyncQueueBuildStartedMs);
    // Chain (not await) this cycle's dispatch onto the previous cycle's settlement — two
    // overlapping cycles' background tasks must never run concurrently against the same JSON
    // stores. Chaining rather than awaiting keeps THIS request's own response time unaffected;
    // it only defers the actual start of this cycle's writes if the previous cycle's are still
    // in flight (rare in practice — background tasks normally finish well within the 7-min
    // auto-refresh interval — and closes the race window entirely when it does happen).
    lastAsyncQueueSettled = lastAsyncQueueSettled.catch(() => undefined).then(
      () => scheduleAsyncQueueTasks(timing, queueBuildMs, asyncTasks),
    );
    timing.finishStage("asyncQueueDispatch");
    // Report-only/paper-only: cache the FRESH scan candidates so the operator-brief
    // paper-opportunity allocator can evaluate them without re-scanning. The scan's
    // own generatedAt is carried as scanFinishedAt (anti-lookahead — the allocator
    // freshness window must anchor on the source scan time, never the brief request).
    timing.startStage("candidateCache");
    try {
      const candidatesCachedAt = new Date().toISOString();
      setLatestScanCandidates({
        scanBatchId: result.generatedAt,
        scanFinishedAt: result.generatedAt,
        candidatesCachedAt,
        marketRegime: result.marketRegime,
        candidates: top10WithPlan,
      });
    } catch {
      // cache population must never break the scan
    } finally {
      timing.finishStage("candidateCache");
    }
    const scanTiming = timing.finish();
    const withTimingDiagnostics = {
      ...withExecutionPlan,
      diagnostics: {
        ...withExecutionPlan.diagnostics,
        scanTiming,
      },
    };
    return {
      withExecutionPlan: withTimingDiagnostics,
      summary: {
        scannedSymbols: result.coverage.scannedSymbols,
        returnedSymbols: result.coverage.returnedSymbols,
        marketRegime: result.marketRegime,
      },
    };
    } catch (error) {
      timing.finish("FAILED", error instanceof Error ? error.message : "Scan failed unexpectedly.");
      throw error;
    }
  }

  let inFlightScanCycle: Promise<Awaited<ReturnType<typeof runCoreScanCycle>>> | null = null;

  function runSingleFlightScanCycle(): Promise<Awaited<ReturnType<typeof runCoreScanCycle>>> {
    if (inFlightScanCycle) return inFlightScanCycle;
    const promise = runCoreScanCycle();
    inFlightScanCycle = promise;
    promise.finally(() => {
      if (inFlightScanCycle === promise) {
        inFlightScanCycle = null;
      }
    }).catch(() => {
      // The original promise is still returned to callers; this only prevents
      // the cleanup promise from becoming an unhandled rejection.
    });
    return promise;
  }

  const autoRefreshEnabled = parseBooleanEnv(
    process.env.CORE_SCAN_AUTO_REFRESH_ENABLED,
    !Boolean(process.env.VITEST),
  );
  const autoRefreshIntervalMinutes = parsePositiveIntEnv(
    process.env.CORE_SCAN_AUTO_REFRESH_INTERVAL_MINUTES,
    7,
  );

  const coreScanAutoRefreshController = createCoreScanAutoRefreshController({
    enabled: autoRefreshEnabled,
    intervalMinutes: autoRefreshIntervalMinutes,
    runScanCycle: async () => {
      const { summary } = await runSingleFlightScanCycle();
      return summary;
    },
  });

  app.addHook("onReady", async () => {
    coreScanAutoRefreshController.start();
  });
  app.addHook("onClose", async () => {
    coreScanAutoRefreshController.stop();
  });

  app.get<{ Querystring: ScanQuery }>("/api/scan", async (_request, reply) => {
    try {
      const { withExecutionPlan } = await runSingleFlightScanCycle();
      return withExecutionPlan;
    } catch (error) {
      reply.code(503);
      return {
        error: "SCAN_UNAVAILABLE",
        message:
          error instanceof Error
            ? `Scan API failed: ${error.message}`
            : "Scan API failed unexpectedly.",
      };
    }
  });

  return coreScanAutoRefreshController;
}

/**
 * Four-Brain end-to-end learning watchdog.
 *
 * This is deliberately a read-only, fail-closed view.  A clean runtime error counter alone is
 * never treated as proof that the pipeline learns: each stage must expose a current heartbeat or
 * durable evidence.  "WAITING" is normal market lifecycle; "BLOCKED" means a concrete hand-off
 * failed or went stale and must be investigated.
 */
import type { FourBrainActualFillBindingStoreStatus } from "./four-brain-actual-fill-binding.js";
import type { FourBrainExecutionReinforcementStatus } from "./four-brain-execution-reinforcement.js";
import type { FourBrainMetricsSummary } from "./four-brain-metrics.js";
import type { DirectionEntryOutcomeReport } from "./direction-entry-outcome-store.js";
import type { ExitBrainShadowReport } from "./exit-brain-shadow.js";

export type FourBrainPipelineStatus = "HEALTHY" | "WAITING" | "DEGRADED" | "BLOCKED" | "DISABLED";

export interface FourBrainPipelineStage {
  id: "COLLECTOR" | "DECISION" | "FILL_BINDING" | "OUTCOME" | "EXIT_PATH" | "REINFORCEMENT";
  label: string;
  status: FourBrainPipelineStatus;
  detail: string;
  facts: string[];
  lastAtMs: number | null;
}

export interface FourBrainPipelineLane {
  id: "CROSS_HORIZON" | "DIRECTIONAL" | "CG_MFE_GIVEBACK";
  label: string;
  decisionCount: number;
  lastDecisionAtMs: number | null;
  state: "OBSERVED" | "NO_CANDIDATE";
}

export interface FourBrainLearningPipelineHealth {
  reportOnly: true;
  generatedAt: string;
  enabled: boolean;
  overall: FourBrainPipelineStatus;
  summary: string;
  blockers: string[];
  warnings: string[];
  stages: FourBrainPipelineStage[];
  lanes: FourBrainPipelineLane[];
}

export interface FourBrainLearningPipelineHealthInput {
  nowMs: number;
  enabled: boolean;
  health: FourBrainMetricsSummary | null;
  recentDecisions: Record<string, unknown>[];
  outcomeReport: DirectionEntryOutcomeReport | null;
  actualFillBindings: FourBrainActualFillBindingStoreStatus | null;
  exitReport: ExitBrainShadowReport | null;
  reinforcement: FourBrainExecutionReinforcementStatus | null;
}

const COLLECTOR_STALE_MS = 7 * 60_000; // scheduled 5m, plus a bounded grace window
const OUTCOME_STALE_MS = 22 * 60_000; // scheduled 15m, plus startup/network grace

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function isoToMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function laneFor(laneId: unknown): FourBrainPipelineLane["id"] | null {
  if (typeof laneId !== "string") return null;
  if (laneId.startsWith("CROSS_SECTIONAL_MARKET_NEUTRAL")) return "CROSS_HORIZON";
  if (laneId.startsWith("CROSS_SECTIONAL_DIRECTIONAL_")) return "DIRECTIONAL";
  if (laneId.includes("CG_MFE_GIVEBACK")) return "CG_MFE_GIVEBACK";
  return null;
}

function latestSnapshot(records: readonly Record<string, unknown>[]): {
  atMs: number | null;
  freshness: { fresh: number; stale: number; missing: number; error: number; sources: number };
  core: { fresh: number; nonFresh: number; sources: number };
} | null {
  let latest: Record<string, unknown> | null = null;
  let latestAt = -1;
  for (const row of records) {
    if (row.kind !== "MARKET_SNAPSHOT") continue;
    const atMs = finiteMs(row.asOfMs);
    if (atMs !== null && atMs > latestAt) {
      latestAt = atMs;
      latest = row;
    }
  }
  if (!latest) return null;
  const diagnostics = object(latest.diagnostics);
  const freshnessRows = object(diagnostics?.freshness);
  const freshness = { fresh: 0, stale: 0, missing: 0, error: 0, sources: 0 };
  for (const value of Object.values(freshnessRows ?? {})) {
    const row = object(value);
    if (!row) continue;
    freshness.sources += 1;
    for (const key of ["fresh", "stale", "missing", "error"] as const) {
      const n = typeof row[key] === "number" && Number.isFinite(row[key]) ? Math.max(0, row[key] as number) : 0;
      freshness[key] += n;
    }
  }
  const marketState = object(latest.marketState);
  const sourceStatuses = object(marketState?.sourceStatuses);
  const core = { fresh: 0, nonFresh: 0, sources: 0 };
  for (const value of Object.values(sourceStatuses ?? {})) {
    if (typeof value !== "string") continue;
    core.sources += 1;
    if (value === "FRESH") core.fresh += 1;
    else core.nonFresh += 1;
  }
  return { atMs: finiteMs(latest.asOfMs), freshness, core };
}

function stage(
  id: FourBrainPipelineStage["id"],
  label: string,
  status: FourBrainPipelineStatus,
  detail: string,
  facts: string[],
  lastAtMs: number | null,
): FourBrainPipelineStage {
  return { id, label, status, detail, facts, lastAtMs };
}

function worst(stages: readonly FourBrainPipelineStage[]): FourBrainPipelineStatus {
  if (stages.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  if (stages.some((item) => item.status === "DEGRADED")) return "DEGRADED";
  if (stages.some((item) => item.status === "WAITING")) return "WAITING";
  if (stages.some((item) => item.status === "DISABLED")) return "DISABLED";
  return "HEALTHY";
}

export function buildFourBrainLearningPipelineHealth(
  input: FourBrainLearningPipelineHealthInput,
): FourBrainLearningPipelineHealth {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const snapshot = latestSnapshot(input.recentDecisions);
  const heartbeat = input.health?.heartbeat;
  const lastSuccessAtMs = heartbeat?.lastCompletedAtMs ?? snapshot?.atMs ?? null;
  const lastFailureAtMs = heartbeat?.lastFailureAtMs ?? null;
  const failureAfterSuccess = lastFailureAtMs !== null && (lastSuccessAtMs === null || lastFailureAtMs > lastSuccessAtMs);

  const collector = (() => {
    if (!input.enabled || !input.health) {
      return stage("COLLECTOR", "Collector market", "DISABLED", "Shadow tick belum aktif di instance ini.", [], null);
    }
    if (lastSuccessAtMs === null) {
      return stage("COLLECTOR", "Collector market", "BLOCKED", "Belum ada snapshot sukses yang bisa membuktikan collector berjalan.", [], null);
    }
    if (nowMs - lastSuccessAtMs > COLLECTOR_STALE_MS) {
      return stage("COLLECTOR", "Collector market", "BLOCKED", "Snapshot terakhir melewati SLA 7 menit; cycle kemungkinan berhenti atau gagal.", [], lastSuccessAtMs);
    }
    if (failureAfterSuccess) {
      return stage(
        "COLLECTOR",
        "Collector market",
        "BLOCKED",
        "Cycle terakhir gagal setelah snapshot sukses terakhir.",
        [`reason: ${heartbeat?.lastFailureReason ?? "unknown"}`],
        lastFailureAtMs,
      );
    }
    const freshness = snapshot?.freshness;
    const core = snapshot?.core;
    if (!freshness || freshness.sources === 0) {
      return stage("COLLECTOR", "Collector market", "DEGRADED", "Snapshot ada, tetapi detail freshness input tidak tersedia.", [], lastSuccessAtMs);
    }
    const total = freshness.fresh + freshness.stale + freshness.missing + freshness.error;
    const facts = [
      core && core.sources > 0 ? `${core.fresh}/${core.sources} core input fresh` : "core input detail —",
      `${freshness.fresh}/${total} reading fresh`,
    ];
    // The market collector is healthy when its heartbeat and the canonical Market State inputs are
    // fresh.  The remaining tally includes deliberately optional evidence (unproven lane edge,
    // challenger forecasts, and entry-timing enrichments).  Those readings still fail closed on
    // the affected decision, but must not turn a healthy collector into a false red alert.
    if (freshness.missing > 0) facts.push(`${freshness.missing} supplementary input unavailable`);
    if (freshness.stale > 0 || freshness.error > 0) facts.push(`${freshness.stale} supplementary stale · ${freshness.error} error`);
    if (core != null && core.sources > 0 && core.nonFresh > 0) {
      return stage("COLLECTOR", "Collector market", "DEGRADED", "Cycle hidup, tetapi sebagian input inti Market State tidak fresh pada snapshot terakhir.", facts, lastSuccessAtMs);
    }
    return stage(
      "COLLECTOR",
      "Collector market",
      "HEALTHY",
      freshness.missing > 0 || freshness.stale > 0 || freshness.error > 0
        ? "Cycle dan input inti fresh. Input tambahan yang tidak lengkap dibuat fail-closed pada keputusan terkait, bukan dianggap sebagai blocker collector."
        : "Cycle dan input inti fresh; tidak ada reading yang tidak lengkap pada snapshot terakhir.",
      facts,
      lastSuccessAtMs,
    );
  })();

  const laneCounts: Record<FourBrainPipelineLane["id"], { count: number; latest: number | null }> = {
    CROSS_HORIZON: { count: 0, latest: null },
    DIRECTIONAL: { count: 0, latest: null },
    CG_MFE_GIVEBACK: { count: 0, latest: null },
  };
  for (const row of input.recentDecisions) {
    if (row.kind !== "EXECUTIVE_DECISION") continue;
    const lane = laneFor(row.laneId);
    const atMs = finiteMs(row.asOfMs);
    if (!lane) continue;
    laneCounts[lane].count += 1;
    laneCounts[lane].latest = Math.max(laneCounts[lane].latest ?? 0, atMs ?? 0) || null;
  }
  const lanes: FourBrainPipelineLane[] = [
    { id: "CROSS_HORIZON", label: "Cross horizon", decisionCount: laneCounts.CROSS_HORIZON.count, lastDecisionAtMs: laneCounts.CROSS_HORIZON.latest, state: laneCounts.CROSS_HORIZON.count > 0 ? "OBSERVED" : "NO_CANDIDATE" },
    { id: "DIRECTIONAL", label: "Directional", decisionCount: laneCounts.DIRECTIONAL.count, lastDecisionAtMs: laneCounts.DIRECTIONAL.latest, state: laneCounts.DIRECTIONAL.count > 0 ? "OBSERVED" : "NO_CANDIDATE" },
    { id: "CG_MFE_GIVEBACK", label: "CG MFE Giveback", decisionCount: laneCounts.CG_MFE_GIVEBACK.count, lastDecisionAtMs: laneCounts.CG_MFE_GIVEBACK.latest, state: laneCounts.CG_MFE_GIVEBACK.count > 0 ? "OBSERVED" : "NO_CANDIDATE" },
  ];
  const observedLanes = lanes.filter((item) => item.state === "OBSERVED");
  const decision = collector.status === "BLOCKED" || collector.status === "DISABLED"
    ? stage("DECISION", "Decision shadow", "BLOCKED", "Tidak bisa menilai keputusan sebelum collector kembali sehat.", [], lastSuccessAtMs)
    : observedLanes.length === 0
      ? stage("DECISION", "Decision shadow", "WAITING", "Cycle berjalan tetapi belum ada candidate pada tiga lane fokus. Ini bukan error.", ["0/3 lane memiliki candidate di buffer"], lastSuccessAtMs)
      : stage("DECISION", "Decision shadow", "HEALTHY", "Keputusan shadow tercatat untuk lane yang memang memiliki candidate.", [`${observedLanes.length}/3 lane memiliki candidate di buffer`], Math.max(...observedLanes.map((item) => item.lastDecisionAtMs ?? 0)) || lastSuccessAtMs);

  const bindings = input.actualFillBindings;
  const binding = (() => {
    if (!bindings) return stage("FILL_BINDING", "Exact actual-fill", "BLOCKED", "Store binding exact-fill tidak tersedia pada instance ini.", [], null);
    // The scheduled-shadow audit can be very large because it is intentionally sampled every
    // cycle. Readiness must only read the small causal funnel captured immediately before an
    // executor submit; otherwise historical re-evaluations look like real entry opportunities.
    const admission = bindings.preEntryAdmission ?? bindings.entryAdmission;
    const facts = [
      `${bindings.candidates} direct candidate`,
      `${bindings.open} open · ${bindings.measured} measured · ${bindings.unmeasured} unmeasured`,
      `${admission.observed} pre-entry executor observation`,
    ];
    if (bindings.auditOnlyBeforeCohort.unbound > 0) {
      facts.push(`${bindings.auditOnlyBeforeCohort.unbound} unbound lama tersimpan sebagai audit-only`);
    }
    if (bindings.unbound > 0) {
      return stage("FILL_BINDING", "Exact actual-fill", "BLOCKED", "Ada fill yang tidak memiliki attribution Four-Brain yang valid.", [...facts, `${bindings.unbound} unbound`], bindings.lifecycle.lastUnboundAtMs);
    }
    if (bindings.unmeasured > 0) {
      return stage("FILL_BINDING", "Exact actual-fill", "DEGRADED", "Ada close direct yang settlement/risk-nya belum terukur; tidak boleh dijadikan feedback.", facts, bindings.lifecycle.lastDirectUnmeasuredAtMs);
    }
    if (admission.missingSignalIdentity > 0 || admission.invalidCandidateMetadata > 0) {
      return stage("FILL_BINDING", "Exact actual-fill", "DEGRADED", "Sebagian kandidat pre-entry tidak memiliki metadata yang cukup untuk attribution exact-fill.", [...facts, `${admission.missingSignalIdentity} identity missing · ${admission.invalidCandidateMetadata} metadata invalid`], admission.lastAtMs);
    }
    if (bindings.candidates === 0) {
      return stage(
        "FILL_BINDING",
        "Exact actual-fill",
        "WAITING",
        admission.observed === 0
          ? "Belum ada kandidat baru yang benar-benar sampai ke jalur submit executor sejak cohort exact-fill dimulai."
          : "Kandidat pre-entry sudah dicatat, tetapi belum ada ENTER_NOW valid yang menjadi kandidat exact-fill.",
        facts,
        admission.lastAtMs,
      );
    }
    if (bindings.open > 0) {
      return stage("FILL_BINDING", "Exact actual-fill", "WAITING", "Attribution sudah terikat; menunggu posisi direct ditutup dan settle.", facts, bindings.lifecycle.lastDirectOpenAtMs);
    }
    return stage("FILL_BINDING", "Exact actual-fill", "HEALTHY", "Direct fill yang tercatat memiliki attribution dan economics terukur.", facts, bindings.lifecycle.lastDirectMeasuredAtMs);
  })();

  const outcome = (() => {
    const report = input.outcomeReport;
    if (!report) return stage("OUTCOME", "Outcome reconciler", "BLOCKED", "Report reconciler tidak tersedia; outcome tidak bisa dibuktikan diproses.", [], null);
    const lastRunAtMs = isoToMs(report.cycleMeta.lastRunAtIso);
    const pending = report.direction.coverage.pending + report.entry.coverage.pending;
    const missing = report.direction.coverage.instrumentDataMissing + report.entry.coverage.instrumentDataMissing;
    const tier2Deferred = report.entry.coverage.tier2Deferred ?? 0;
    const facts = [
      `${pending} pending`,
      `${report.direction.coverage.evaluated} direction resolved · ${report.entry.coverage.resolvedRealMatch} tier-1 audit`,
      `${tier2Deferred} tier-2 antre`,
    ];
    if (lastRunAtMs === null) return stage("OUTCOME", "Outcome reconciler", "BLOCKED", "Reconciler belum pernah mencatat cycle.", facts, null);
    if (nowMs - lastRunAtMs > OUTCOME_STALE_MS) return stage("OUTCOME", "Outcome reconciler", "BLOCKED", "Reconciler melewati SLA 22 menit.", facts, lastRunAtMs);
    if (report.cycleMeta.lastError) return stage("OUTCOME", "Outcome reconciler", "BLOCKED", "Cycle reconciler terakhir mencatat error.", [...facts, report.cycleMeta.lastError], lastRunAtMs);
    if (missing > 0) return stage("OUTCOME", "Outcome reconciler", "DEGRADED", "Sebagian fetch outcome yang benar-benar dicoba belum menghasilkan instrument data; akan di-retry.", [...facts, `${missing} source data missing`], lastRunAtMs);
    if (tier2Deferred > 0) return stage("OUTCOME", "Outcome reconciler", "WAITING", "Reconciler sehat; antrean Tier-2 sedang digilir oleh batas kerja per siklus, bukan data hilang.", facts, lastRunAtMs);
    if (pending > 0) return stage("OUTCOME", "Outcome reconciler", "WAITING", "Reconciler sehat; outcome masih menunggu horizon/close yang memang belum jatuh tempo.", facts, lastRunAtMs);
    return stage("OUTCOME", "Outcome reconciler", "HEALTHY", "Tidak ada backlog pending atau error pada cycle terakhir.", facts, lastRunAtMs);
  })();

  const exit = (() => {
    const report = input.exitReport;
    if (!report) return stage("EXIT_PATH", "Exit path", "BLOCKED", "Store path Exit Brain tidak tersedia.", [], null);
    const lastRunAtMs = isoToMs(report.cycleMeta.lastRunAtIso);
    const facts = [`${report.coverage.evaluated}/${report.coverage.processed} path terukur`, `${report.coverage.insufficientPathData} path kurang tick`];
    if (report.cycleMeta.lastError) return stage("EXIT_PATH", "Exit path", "BLOCKED", "Cycle Exit Brain terakhir mencatat error.", [...facts, report.cycleMeta.lastError], lastRunAtMs);
    if (report.coverage.processed === 0) return stage("EXIT_PATH", "Exit path", "WAITING", "Belum ada posisi closed yang cukup untuk mengukur path Exit Brain.", facts, lastRunAtMs);
    if (report.coverage.insufficientPathData > 0 && report.coverage.evaluated > 0) {
      return stage("EXIT_PATH", "Exit path", "WAITING", "Recorder terbukti bekerja; sebagian close terlalu singkat untuk mencapai minimum tick dan sengaja tidak dijadikan bukti Exit Brain.", facts, lastRunAtMs);
    }
    if (report.coverage.insufficientPathData > 0) return stage("EXIT_PATH", "Exit path", "DEGRADED", "Belum ada path close yang cukup padat untuk mengukur Exit Brain; recorder perlu diamati.", facts, lastRunAtMs);
    return stage("EXIT_PATH", "Exit path", "HEALTHY", "Path close yang diproses cukup padat untuk evaluasi Exit Brain.", facts, lastRunAtMs);
  })();

  const reinforcement = (() => {
    if (!input.reinforcement) return stage("REINFORCEMENT", "Feedback belajar", "BLOCKED", "Status reinforcement tidak tersedia; feedback tidak boleh dianggap tercatat.", [], null);
    const directMeasured = bindings?.measured ?? 0;
    const feedback = input.reinforcement;
    const lastCloseAtMs = bindings?.lifecycle.lastDirectMeasuredAtMs ?? null;
    const reconciledAtMs = isoToMs(input.outcomeReport?.cycleMeta.lastRunAtIso ?? null);
    const facts = [
      `${feedback.actualFillOutcomeRecords} feedback actual-fill persisted`,
      `${feedback.actualFillRankingRecords} siap untuk ranking shadow`,
    ];
    if (directMeasured > feedback.actualFillOutcomeRecords) {
      if (lastCloseAtMs !== null && reconciledAtMs !== null && reconciledAtMs >= lastCloseAtMs) {
        return stage("REINFORCEMENT", "Feedback belajar", "BLOCKED", "Close direct sudah melewati cycle reconciler, tetapi belum muncul sebagai feedback persisted.", facts, reconciledAtMs);
      }
      return stage("REINFORCEMENT", "Feedback belajar", "WAITING", "Close direct tercatat dan sedang menunggu cycle reconciler berikutnya.", facts, lastCloseAtMs);
    }
    if (feedback.actualFillOutcomeRecords === 0) {
      return stage("REINFORCEMENT", "Feedback belajar", "WAITING", "Belum ada closed actual-fill yang dapat menjadi feedback belajar.", facts, null);
    }
    if (feedback.actualFillRankingRecords < feedback.actualFillOutcomeRecords) {
      return stage("REINFORCEMENT", "Feedback belajar", "DEGRADED", "Ada feedback actual-fill yang tersimpan tetapi lineage-nya belum lengkap untuk ranking shadow.", facts, feedback.lastActualFillDecisionAtMs);
    }
    return stage("REINFORCEMENT", "Feedback belajar", "HEALTHY", "Feedback exact actual-fill sudah persisted dan terbaca oleh ranking shadow.", facts, feedback.lastActualFillDecisionAtMs);
  })();

  const stages = [collector, decision, binding, outcome, exit, reinforcement];
  const overall = worst(stages);
  const blockers = stages.filter((item) => item.status === "BLOCKED").map((item) => `${item.label}: ${item.detail}`);
  const warnings = stages.filter((item) => item.status === "DEGRADED").map((item) => `${item.label}: ${item.detail}`);
  const summary = overall === "HEALTHY"
    ? "Semua tahap aktif, fresh, dan tidak memiliki blocker saat ini."
    : overall === "WAITING"
      ? "Pipeline berjalan; sebagian tahap menunggu candidate, close, atau horizon normal."
      : overall === "DEGRADED"
        ? "Pipeline berjalan, tetapi ada data/path yang belum lengkap dan perlu dipantau."
        : overall === "BLOCKED"
          ? "Ada hand-off yang gagal atau melewati SLA; jangan anggap pembelajaran berjalan penuh."
          : "Shadow pipeline belum aktif pada instance ini.";
  return {
    reportOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    enabled: input.enabled,
    overall,
    summary,
    blockers,
    warnings,
    stages,
    lanes,
  };
}

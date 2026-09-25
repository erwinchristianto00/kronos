import { describe, expect, it } from "vitest";

import {
  buildFourBrainLearningPipelineHealth,
  type FourBrainLearningPipelineHealthInput,
} from "../src/lib/four-brain-learning-pipeline-health.js";

const NOW = 1_800_000_000_000;

function base(overrides: Partial<FourBrainLearningPipelineHealthInput> = {}): FourBrainLearningPipelineHealthInput {
  return {
    nowMs: NOW,
    enabled: true,
    health: {
      ticks: { attempted: 1, completed: 1, skippedSingleFlight: 0, gatherErrors: 0, exceptions: 0, wiringErrors: 0, journalErrors: 0, brainErrors: 0, invariantFailures: 0 },
      heartbeat: {
        lastAttemptAtMs: NOW - 60_000,
        lastCompletedAtMs: NOW - 60_000,
        lastFailureAtMs: null,
        lastCycleReason: "ok",
        lastFailureReason: null,
      },
      decisions: { total: 0, duplicateDecisionIds: 0, unknownLanes: 0, duplicateIdentities: 0 },
      coverage: { lastLaneCoverage: 0, maxLaneCoverage: 0, lastPositionCoverage: 0, maxPositionCoverage: 0 },
      sourceQuality: {},
      byCandidateStatus: {},
      byBrainAction: {},
      latencyMs: {
        gather: { p50: null, p90: null, p99: null, samples: 0 },
        inference: { p50: null, p90: null, p99: null, samples: 0 },
        journal: { p50: null, p90: null, p99: null, samples: 0 },
      },
    },
    recentDecisions: [{
      kind: "MARKET_SNAPSHOT",
      asOfMs: NOW - 60_000,
      diagnostics: { freshness: { candle: { fresh: 7, stale: 0, missing: 0, error: 0 } } },
    }],
    outcomeReport: {
      cycleMeta: { lastRunAtIso: new Date(NOW - 30_000).toISOString(), lastProcessed: 0, lastError: null },
      direction: { coverage: { pending: 0, evaluated: 0, instrumentDataMissing: 0, expiredUnresolvable: 0 } },
      entry: { coverage: { pending: 0, resolvedRealMatch: 0, resolvedSimulated: 0, instrumentDataMissing: 0, expiredUnresolvable: 0 } },
    } as FourBrainLearningPipelineHealthInput["outcomeReport"],
    actualFillBindings: {
      candidates: 0,
      open: 0,
      measured: 0,
      unmeasured: 0,
      unbound: 0,
      executorObserved: { candidates: 0, open: 0, measured: 0, unmeasured: 0, byEntryAction: {} },
      entryAdmission: {
        observed: 0, enterNow: 0, validEnterNow: 0, exactCandidatesRecorded: 0,
        waiting: 0, skipped: 0, other: 0, missingSignalIdentity: 0, invalidCandidateMetadata: 0,
        lastAtMs: null, lastAction: null, lastCandidateStatus: null,
      },
      preEntryAdmission: {
        observed: 0, enterNow: 0, validEnterNow: 0, exactCandidatesRecorded: 0,
        waiting: 0, skipped: 0, other: 0, missingSignalIdentity: 0, invalidCandidateMetadata: 0,
        lastAtMs: null, lastAction: null, lastCandidateStatus: null,
      },
      lifecycle: {
        lastDirectOpenAtMs: null, lastDirectMeasuredAtMs: null,
        lastDirectUnmeasuredAtMs: null, lastUnboundAtMs: null,
      },
      auditOnlyBeforeCohort: { bindings: 0, unbound: 0, lastUnboundAtMs: null },
      cohortSinceMs: null,
    },
    exitReport: {
      coverage: { processed: 0, evaluated: 0, insufficientPathData: 0 },
      cycleMeta: { lastRunAtIso: null, lastProcessed: 0, lastError: null },
    } as FourBrainLearningPipelineHealthInput["exitReport"],
    reinforcement: {
      actualFillOutcomeRecords: 0,
      actualFillRankingRecords: 0,
      rankingRecords: 0,
      bucketCount: 0,
      effectiveBucketCount: 0,
      lastActualFillDecisionAtMs: null,
    },
    ...overrides,
  };
}

describe("Four-Brain learning pipeline health", () => {
  it("labels no candidate / no closed fill as WAITING, not a blocker", () => {
    const report = buildFourBrainLearningPipelineHealth(base());
    expect(report.overall).toBe("WAITING");
    expect(report.blockers).toEqual([]);
    expect(report.stages.find((item) => item.id === "COLLECTOR")?.status).toBe("HEALTHY");
    expect(report.stages.find((item) => item.id === "FILL_BINDING")?.status).toBe("WAITING");
    expect(report.stages.find((item) => item.id === "REINFORCEMENT")?.status).toBe("WAITING");
  });

  it("does not mark the collector degraded when only supplemental candidate evidence is stale or unavailable", () => {
    const input = base({
      recentDecisions: [{
        kind: "MARKET_SNAPSHOT",
        asOfMs: NOW - 60_000,
        marketState: {
          sourceStatuses: {
            trend: "FRESH", volatility: "FRESH", liquidity: "FRESH", breadth: "FRESH",
            momentum: "FRESH", eventRisk: "FRESH", sentiment: "FRESH",
          },
        },
        diagnostics: {
          freshness: {
            regime: { fresh: 6, stale: 0, missing: 12, error: 0 },
            candle: { fresh: 13, stale: 0, missing: 6, error: 0 },
            derivatives: { fresh: 6, stale: 6, missing: 0, error: 0 },
          },
        },
      }],
    });
    const report = buildFourBrainLearningPipelineHealth(input);
    const collector = report.stages.find((item) => item.id === "COLLECTOR");
    expect(collector?.status).toBe("HEALTHY");
    expect(collector?.detail).toContain("bukan dianggap sebagai blocker collector");
    expect(collector?.facts).toContain("7/7 core input fresh");
    expect(collector?.facts).toContain("18 supplementary input unavailable");
    expect(collector?.facts).toContain("6 supplementary stale · 0 error");
  });

  it("still degrades the collector when a canonical Market State input is not fresh", () => {
    const input = base({
      recentDecisions: [{
        kind: "MARKET_SNAPSHOT",
        asOfMs: NOW - 60_000,
        marketState: { sourceStatuses: { trend: "STALE", volatility: "FRESH" } },
        diagnostics: { freshness: { regime: { fresh: 1, stale: 1, missing: 0, error: 0 } } },
      }],
    });
    const report = buildFourBrainLearningPipelineHealth(input);
    const collector = report.stages.find((item) => item.id === "COLLECTOR");
    expect(collector?.status).toBe("DEGRADED");
    expect(collector?.detail).toContain("input inti Market State");
  });

  it("does not let the legacy scheduled-shadow funnel masquerade as pre-submit exact-fill activity", () => {
    const input = base();
    input.actualFillBindings = {
      ...input.actualFillBindings!,
      entryAdmission: {
        ...input.actualFillBindings!.entryAdmission,
        observed: 5_941,
        validEnterNow: 317,
        exactCandidatesRecorded: 317,
        missingSignalIdentity: 28,
        invalidCandidateMetadata: 28,
        lastAtMs: NOW - 60_000,
      },
      preEntryAdmission: {
        ...input.actualFillBindings!.preEntryAdmission,
        observed: 0,
      },
    };
    const report = buildFourBrainLearningPipelineHealth(input);
    const stage = report.stages.find((item) => item.id === "FILL_BINDING");
    expect(stage?.status).toBe("WAITING");
    expect(stage?.detail).toContain("jalur submit executor");
    expect(stage?.facts).toContain("0 pre-entry executor observation");
  });

  it("keeps pre-repair unbound fills visible as audit-only without blocking the repaired cohort", () => {
    const input = base();
    input.actualFillBindings = {
      ...input.actualFillBindings!,
      auditOnlyBeforeCohort: { bindings: 6, unbound: 6, lastUnboundAtMs: NOW - 10_000 },
      cohortSinceMs: NOW,
    };
    const report = buildFourBrainLearningPipelineHealth(input);
    const stage = report.stages.find((item) => item.id === "FILL_BINDING");
    expect(stage?.status).toBe("WAITING");
    expect(stage?.facts).toContain("6 unbound lama tersimpan sebagai audit-only");
    expect(report.blockers).toEqual([]);
  });

  it("fails closed when a newer collector failure has no later successful snapshot", () => {
    const input = base();
    input.health!.heartbeat!.lastFailureAtMs = NOW - 30_000;
    input.health!.heartbeat!.lastFailureReason = "cycle-wiring-exception";
    const report = buildFourBrainLearningPipelineHealth(input);
    expect(report.overall).toBe("BLOCKED");
    expect(report.stages.find((item) => item.id === "COLLECTOR")?.status).toBe("BLOCKED");
  });

  it("catches an exact closed fill that a newer reconciliation did not persist as feedback", () => {
    const input = base();
    input.actualFillBindings = {
      ...input.actualFillBindings!,
      candidates: 1,
      measured: 1,
      lifecycle: { ...input.actualFillBindings!.lifecycle, lastDirectMeasuredAtMs: NOW - 60_000 },
    };
    input.outcomeReport = {
      ...input.outcomeReport!,
      cycleMeta: { lastRunAtIso: new Date(NOW - 30_000).toISOString(), lastProcessed: 0, lastError: null },
    };
    const report = buildFourBrainLearningPipelineHealth(input);
    expect(report.stages.find((item) => item.id === "REINFORCEMENT")?.status).toBe("BLOCKED");
    expect(report.blockers.some((item) => item.includes("Feedback belajar"))).toBe(true);
  });

  it("treats the bounded Tier-2 queue as waiting rather than missing instrument data", () => {
    const input = base();
    input.outcomeReport = {
      ...input.outcomeReport!,
      entry: {
        ...input.outcomeReport!.entry,
        coverage: {
          ...input.outcomeReport!.entry.coverage,
          pending: 12,
          tier2Deferred: 12,
        },
      },
    } as FourBrainLearningPipelineHealthInput["outcomeReport"];
    const report = buildFourBrainLearningPipelineHealth(input);
    const stage = report.stages.find((item) => item.id === "OUTCOME");
    expect(stage?.status).toBe("WAITING");
    expect(stage?.detail).toContain("bukan data hilang");
    expect(report.blockers).toEqual([]);
  });
});

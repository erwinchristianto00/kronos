/**
 * Explicit OFFLINE report orchestration for the Four-Brain economic-learning foundation. This is the
 * one place that proves the full pipeline end to end:
 *
 *   Tier-1 REAL executive review outcomes (which already carry the persisted decision snapshot —
 *   see FourBrainExecutiveIdentity in executive-review-store.ts)
 *     -> Four-Brain economic experiences (four-brain-economic-experience.ts)
 *     -> per-brain/per-lane shadow reports (four-brain-shadow-learning-report.ts)
 *
 * It is a pure function of its inputs: no scheduler, no cycle, no timer, and no caller anywhere in
 * this codebase invokes it today. It never selects a lane, changes an allocation, promotes anything,
 * or mutates a CORTEX coefficient — it only classifies and aggregates what has already resolved.
 * Wiring this into a real cycle is a deliberately separate, future, explicitly-approved step.
 */
import {
  buildFourBrainExecutiveExperiences,
  fourBrainExitAttributionStatus,
  type FourBrainEconomicRejectionReason,
  type FourBrainExitAttributionStatus,
  type FourBrainName,
  type FourBrainPolicyContext,
} from "./four-brain-economic-experience.js";
import {
  buildFourBrainShadowLaneReport,
  fourBrainEvaluationOnlyReport,
  type FourBrainOOSWindows,
  type FourBrainShadowLaneReport,
} from "./four-brain-shadow-learning-report.js";
import type { ExecutiveReviewOutcome } from "./executive-review-store.js";

export interface FourBrainOfflineReportInput {
  readonly outcomes: readonly ExecutiveReviewOutcome[];
  readonly expectedPolicy: FourBrainPolicyContext;
  readonly nowMs: number;
  /** Per-lane OOS windows, keyed `${brain}::${laneId}`. Omitted or missing for a given key ⇒ that
   *  lane's report computes without a true out-of-sample Sharpe (never a raw-Sharpe fallback). */
  readonly oosWindowsByBrainLane?: ReadonlyMap<string, FourBrainOOSWindows>;
}

export interface FourBrainOfflineReportResult {
  readonly rejected: Record<FourBrainEconomicRejectionReason, number>;
  readonly totalExperiences: number;
  readonly directLearningEligibleCount: number;
  readonly evaluationOnlyCount: number;
  readonly laneReports: readonly FourBrainShadowLaneReport[];
  readonly exitStatus: FourBrainExitAttributionStatus;
}

function laneKey(brain: FourBrainName, laneId: string): string {
  return `${brain}::${laneId}`;
}

/**
 * Runs the full offline pipeline once and returns every lane report observed, plus Exit's fixed
 * evaluation-only status for the same set of lanes (so the report's shape always shows all four
 * brains side by side, never silently omitting the one with no eligible path).
 */
export function runFourBrainOfflineEconomicReport(input: FourBrainOfflineReportInput): FourBrainOfflineReportResult {
  const { experiences, rejected } = buildFourBrainExecutiveExperiences(input.outcomes, input.expectedPolicy, input.nowMs);

  const byBrainLane = new Map<string, typeof experiences>();
  for (const experience of experiences) {
    const key = laneKey(experience.brain, experience.laneId);
    const group = byBrainLane.get(key);
    if (group) group.push(experience);
    else byBrainLane.set(key, [experience]);
  }

  const laneReports: FourBrainShadowLaneReport[] = [];
  const lanesObserved = new Set<string>();
  for (const [key, group] of byBrainLane) {
    const separatorIndex = key.indexOf("::");
    const brain = key.slice(0, separatorIndex) as FourBrainName;
    const laneId = key.slice(separatorIndex + 2);
    lanesObserved.add(laneId);
    const eligibleOnly = group.filter((e) => e.attributionEligibility === "DIRECT_LEARNING_ELIGIBLE");
    const windows = input.oosWindowsByBrainLane?.get(key) ?? null;
    laneReports.push(buildFourBrainShadowLaneReport(brain, laneId, eligibleOnly, rejected, windows));
  }
  for (const laneId of lanesObserved) laneReports.push(fourBrainEvaluationOnlyReport("EXIT", laneId));

  const directLearningEligibleCount = experiences.filter((e) => e.attributionEligibility === "DIRECT_LEARNING_ELIGIBLE").length;
  return {
    rejected,
    totalExperiences: experiences.length,
    directLearningEligibleCount,
    evaluationOnlyCount: experiences.length - directLearningEligibleCount,
    laneReports,
    exitStatus: fourBrainExitAttributionStatus(),
  };
}

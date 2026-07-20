/**
 * CORTEX #219 — shadow decision-alpha report. Read-only: reads the decision journal + each lane's own
 * resolved closes (the exact same inputs the nightly refit already reads) and reports how much R the
 * brain's shadow tilt would have added, realized, had it been operating on real capital all along. Never
 * writes anything, never touches CORTEX_LIVE_BETA, never influences allocation.
 *
 * staticWeightPctForLane is stubbed to 0 here deliberately: cortexShadowDecisionAlpha only reads each
 * attributed example's finalPct/evalFinalPct/netR (all carried per-example from the journal), never the
 * roster's staticWeightPct — that field only feeds cortexBlindCapitalPct/per-lane LEARNING_ACTIVE status,
 * which this report doesn't compute. No live engine dependency needed.
 */
import { attributeOutcomes, cortexShadowDecisionAlpha, type CortexShadowDecisionAlphaResult } from "./cortex-attribution.js";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "./cortex-brain.js";
import { gatherCortexRefitInputs } from "./cortex-refit-runner-bindings.js";

export interface CortexShadowDecisionAlphaReport {
  reportOnly: true;
  generatedAt: string;
  examplesConsidered: number;
  journalBadLines: number;
  decisionAlpha: CortexShadowDecisionAlphaResult;
}

export function buildCortexShadowDecisionAlphaReport(
  options: { dataDir?: string; journalFile?: string; nowMs?: number } = {},
): CortexShadowDecisionAlphaReport {
  const dataDir = options.dataDir ?? "data";
  const journalFile = options.journalFile ?? `${dataDir}/cortex-decision-journal.jsonl`;
  const nowMs = options.nowMs ?? Date.now();
  const input = gatherCortexRefitInputs({
    dataDir,
    journalFile,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    staticWeightPctForLane: () => 0,
  });
  const attributed = attributeOutcomes(input.decisions, input.outcomes, {
    currentSchemaVersion: input.currentSchemaVersion ?? CORTEX_FEATURE_SCHEMA_VERSION,
    ttlMsForLane: input.ttlMsForLane,
    roster: input.roster,
  });
  return {
    reportOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    examplesConsidered: attributed.examples.length,
    journalBadLines: input.journalBadLines,
    decisionAlpha: cortexShadowDecisionAlpha(attributed.examples),
  };
}

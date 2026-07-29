/**
 * Strict adapter from forward causal events to CORTEX training rows.
 *
 * It never performs a time-nearest join. Every emitted row has a persisted
 * paper decision/opportunity/outcome chain plus the exact CORTEX x that was
 * handed to paper admission. Any missing link is counted and rejected.
 */
import { CORTEX_FEATURE_DIM, CORTEX_FEATURE_SCHEMA_VERSION } from "../lib/cortex-brain.js";
import type { CortexDecisionRow, CortexLaneOutcome } from "../lib/cortex-attribution.js";
import { cortexOutcomeLaneMeta } from "../lib/cortex-outcome-source.js";
import { candidateLearningRows, normalizeExperience, type ExperienceRecord } from "./experience-engine.js";
import type { DecisionSnapshotEvent, ForwardEvent, OpportunityOpenEvent, OutcomeResolutionEvent } from "./forward-causal-collection.js";

export interface CortexExperienceBridgeResult {
  decisions: CortexDecisionRow[];
  outcomes: CortexLaneOutcome[];
  experiences: ExperienceRecord[];
  rejected: Record<string, number>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bump = (counts: Record<string, number>, reason: string): void => { counts[reason] = (counts[reason] ?? 0) + 1; };
const economicallyConsistent = (grossR: unknown, costR: unknown, netR: unknown): boolean =>
  finite(grossR) && finite(costR) && finite(netR) && Math.abs((grossR + costR) - netR) <= 1e-9;

export function buildCortexExperienceBridge(events: readonly ForwardEvent[]): CortexExperienceBridgeResult {
  const paperDecisions = new Map<string, DecisionSnapshotEvent>();
  const opportunities = new Map<string, OpportunityOpenEvent>();
  const outcomes: OutcomeResolutionEvent[] = [];
  for (const event of events) {
    if (event.eventType === "DECISION_SNAPSHOT" && !paperDecisions.has(event.identity.decisionId)) paperDecisions.set(event.identity.decisionId, event);
    if (event.eventType === "OPPORTUNITY_OPEN" && !opportunities.has(event.identity.opportunityId)) opportunities.set(event.identity.opportunityId, event);
    if (event.eventType === "OUTCOME_RESOLUTION") outcomes.push(event);
  }

  const decisionsByKey = new Map<string, CortexDecisionRow>();
  const cortexOutcomes: CortexLaneOutcome[] = [];
  const experiences: ExperienceRecord[] = [];
  const rejected: Record<string, number> = {};
  const consumedOutcomeIds = new Set<string>();

  for (const outcome of outcomes) {
    if (consumedOutcomeIds.has(outcome.outcomeId)) { bump(rejected, "duplicate_outcome"); continue; }
    consumedOutcomeIds.add(outcome.outcomeId);
    const opportunity = opportunities.get(outcome.opportunityId);
    const decision = paperDecisions.get(outcome.decisionId);
    if (!opportunity || !decision) { bump(rejected, "missing_direct_chain"); continue; }
    if (
      opportunity.decisionId !== decision.identity.decisionId ||
      outcome.decisionId !== decision.identity.decisionId ||
      outcome.opportunityId !== opportunity.identity.opportunityId ||
      outcome.identity.decisionId !== decision.identity.decisionId ||
      outcome.identity.opportunityId !== opportunity.identity.opportunityId
    ) { bump(rejected, "identity_mismatch"); continue; }
    // Pre-hardening journals do not carry a CORTEX snapshot. Treat them as
    // ineligible legacy evidence instead of allowing a malformed row to abort
    // an otherwise report-only refit pass.
    const cortex = decision.cortexTraining;
    if (
      !cortex || cortex.status !== "PRESENT" || !cortex.decisionId ||
      cortex.decisionId !== outcome.identity.cortexDecisionId ||
      cortex.featureSchemaVersion !== outcome.identity.cortexFeatureSchemaVersion ||
      cortex.featureSchemaVersion !== CORTEX_FEATURE_SCHEMA_VERSION ||
      !Array.isArray(cortex.featureVector) || cortex.featureVector.length !== CORTEX_FEATURE_DIM || !cortex.featureVector.every(finite)
    ) { bump(rejected, "missing_or_incompatible_cortex_snapshot"); continue; }
    if (
      !finite(decision.asOfMs) || decision.asOfMs > outcome.openedAtMs ||
      outcome.openedAtMs > outcome.closedAtMs || outcome.closedAtMs > outcome.resolvedAtMs ||
      outcome.outcomeQuality !== "RESOLVED_VALID" || !economicallyConsistent(outcome.grossR, outcome.costR, outcome.netR) ||
      Object.values(decision.features.sourceStatuses).some((status) => status === "ERROR")
    ) { bump(rejected, "causal_outcome_cost_or_quality_failure"); continue; }
    const meta = cortexOutcomeLaneMeta(outcome.identity.laneId);
    if (!meta || (meta.direction !== "NEUTRAL" && meta.direction !== outcome.identity.direction)) { bump(rejected, "lane_direction_mismatch"); continue; }

    const experience = normalizeExperience({
      experienceId: `cortex:${outcome.outcomeId}`,
      decisionId: cortex.decisionId,
      opportunityId: opportunity.identity.opportunityId,
      outcomeId: outcome.outcomeId,
      source: "OBSERVED_SHADOW_OUTCOME",
      provenance: "OBSERVED",
      decisionTimeMs: decision.asOfMs,
      openedTimeMs: outcome.openedAtMs,
      marketCloseTimeMs: outcome.closedAtMs,
      resolvedTimeMs: outcome.resolvedAtMs,
      laneId: outcome.identity.laneId,
      symbolOrBasketId: outcome.identity.symbolOrBasketId,
      direction: outcome.identity.direction === "LONG" || outcome.identity.direction === "SHORT"
        ? outcome.identity.direction
        : "FLAT",
      featureSchemaVersion: String(cortex.featureSchemaVersion),
      codeVersion: decision.codeVersion,
      featureVector: [...cortex.featureVector],
      sourceStatuses: decision.features.sourceStatuses,
      attributionStatus: "ATTRIBUTED",
      outcomeQuality: "RESOLVED_VALID",
      outcomeNetR: outcome.netR,
      labels: { entry: "ENTER_NOW", exit: "INCUMBENT_TP_SL", allocationMultiple: 1 },
      executionLabelKind: "PAPER_OUTCOME",
    });
    experiences.push(experience);
    if (candidateLearningRows([experience]).length === 0) { bump(rejected, "experience_ineligible"); continue; }

    const key = `${cortex.decisionId}\u001f${meta.laneId}`;
    if (!decisionsByKey.has(key)) {
      decisionsByKey.set(key, {
        decisionId: cortex.decisionId,
        atMs: decision.asOfMs,
        featureSchemaVersion: cortex.featureSchemaVersion,
        regimeFamily: cortex.regimeFamily ?? "UNKNOWN",
        lanes: new Map([[meta.laneId, {
          x: [...cortex.featureVector],
          eligible: cortex.eligible === true,
          direction: meta.direction,
          finalPct: finite(cortex.finalPct) ? cortex.finalPct : 0,
          evalFinalPct: finite(cortex.evalFinalPct) ? cortex.evalFinalPct : 0,
        }]]),
      });
    }
    cortexOutcomes.push({
      laneId: meta.laneId,
      archetype: meta.archetype,
      direction: meta.direction,
      observationId: outcome.outcomeId,
      openedAtMs: outcome.openedAtMs,
      resolvedAtMs: outcome.resolvedAtMs,
      netR: outcome.netR,
      decisionId: cortex.decisionId,
      opportunityId: outcome.opportunityId,
      outcomeId: outcome.outcomeId,
    });
  }
  return { decisions: [...decisionsByKey.values()], outcomes: cortexOutcomes, experiences, rejected };
}

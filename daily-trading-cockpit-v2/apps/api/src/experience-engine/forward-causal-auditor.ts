/** Forward-only audit adapter. It deliberately follows opportunityId -> decisionId and has no time-nearest path. */
import { createHash } from "node:crypto";

import { auditLineage, type DecisionSnapshot, type LineageAudit, type OpportunityOutcome } from "./lineage-auditor.js";
import type { CausalIdentity } from "./forward-causal-collection.js";

const auditorDirection = (direction: CausalIdentity["direction"]): "LONG" | "SHORT" | "FLAT" =>
  direction === "LONG" || direction === "SHORT" ? direction : "FLAT";

export interface ForwardDecisionEvent {
  eventType: "DECISION_SNAPSHOT";
  eventId: string;
  identity: CausalIdentity;
  asOfMs: number;
  codeVersion: string | null;
  features: { values: number[]; availableAtMs: number[]; sourceStatuses: Record<string, "FRESH" | "MISSING" | "STALE" | "ERROR"> };
}
export interface ForwardOpportunityEvent {
  eventType: "OPPORTUNITY_OPEN";
  eventId: string;
  identity: CausalIdentity;
  decisionId: string;
  openedAtMs: number;
}
export interface ForwardOutcomeEvent {
  eventType: "OUTCOME_RESOLUTION";
  eventId: string;
  identity: CausalIdentity;
  outcomeId: string;
  opportunityId: string;
  decisionId: string;
  openedAtMs: number;
  closedAtMs: number;
  resolvedAtMs: number;
  netR: number;
  outcomeQuality: "RESOLVED_VALID" | "UNSAFE_INTRABAR";
  directAttribution: "DIRECT_CAUSAL_LINK";
}
export type ForwardCausalEvent = ForwardDecisionEvent | ForwardOpportunityEvent | ForwardOutcomeEvent;

export interface ForwardAuditResult {
  audits: LineageAudit[];
  completeChains: number;
  directChains: number;
  auditHash: string;
}

/** Runs frozen eligibility rules through direct IDs only. An unlinked event cannot borrow a nearby decision. */
export function auditForwardCausalEvents(events: readonly ForwardCausalEvent[]): ForwardAuditResult {
  const decisions = new Map<string, ForwardDecisionEvent>();
  const opportunities = new Map<string, ForwardOpportunityEvent>();
  const outcomes: ForwardOutcomeEvent[] = [];
  for (const event of events) {
    if (event.eventType === "DECISION_SNAPSHOT" && !decisions.has(event.identity.decisionId)) decisions.set(event.identity.decisionId, event);
    if (event.eventType === "OPPORTUNITY_OPEN" && !opportunities.has(event.identity.opportunityId)) opportunities.set(event.identity.opportunityId, event);
    if (event.eventType === "OUTCOME_RESOLUTION") outcomes.push(event);
  }
  const consumed = new Set<string>();
  const audits = outcomes.map((outcome) => {
    const opportunity = opportunities.get(outcome.opportunityId);
    if (!opportunity || opportunity.decisionId !== outcome.decisionId || opportunity.identity.decisionId !== outcome.identity.decisionId) {
      return {
        outcomeId: outcome.outcomeId, selectedDecisionId: null, candidateDecisionCount: 0, attributionLagMs: null,
        identity: { lane: null, symbol: null, direction: null, schema: null }, ttlResult: "NOT_EVALUATED" as const,
        timestampOrdering: "INCOMPLETE" as const, rejectionReason: "MISSING_DECISION_SNAPSHOT" as const,
        sourcePointers: [outcome.eventId],
      };
    }
    const decision = decisions.get(opportunity.decisionId);
    const decisionRows: DecisionSnapshot[] = decision ? [{
      decisionId: decision.identity.decisionId, signalOrderId: decision.identity.decisionId, asOfMs: decision.asOfMs,
      laneId: decision.identity.laneId, symbolOrBasketId: decision.identity.symbolOrBasketId,
      direction: auditorDirection(decision.identity.direction), codeVersion: decision.codeVersion,
      features: {
        featureSchemaVersion: decision.identity.featureSchemaVersion, values: decision.features.values,
        availableAtMs: decision.features.availableAtMs, sourceStatuses: decision.features.sourceStatuses,
      }, sourcePointer: decision.eventId,
    }] : [];
    const normalized: OpportunityOutcome = {
      outcomeId: outcome.outcomeId, decisionLinkId: opportunity.decisionId,
      source: "OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME", openedAtMs: outcome.openedAtMs,
      closedAtMs: outcome.closedAtMs, resolvedAtMs: outcome.resolvedAtMs,
      laneId: outcome.identity.laneId, symbolOrBasketId: outcome.identity.symbolOrBasketId,
      direction: auditorDirection(outcome.identity.direction), featureSchemaVersion: outcome.identity.featureSchemaVersion,
      outcomeNetR: outcome.netR,
      outcomeQuality: outcome.outcomeQuality === "UNSAFE_INTRABAR" ? "UNSAFE_INTRABAR" : "RESOLVED_VALID",
      sourcePointer: outcome.eventId,
    };
    const audit = auditLineage(normalized, decisionRows, consumed);
    consumed.add(outcome.outcomeId);
    return audit;
  });
  const completeChains = audits.filter((audit) => audit.rejectionReason === "COMPLETE_CAUSAL_CHAIN").length;
  const directChains = outcomes.filter((outcome) => outcome.directAttribution === "DIRECT_CAUSAL_LINK" && opportunities.has(outcome.opportunityId)).length;
  return { audits, completeChains, directChains, auditHash: createHash("sha256").update(JSON.stringify(audits)).digest("hex") };
}

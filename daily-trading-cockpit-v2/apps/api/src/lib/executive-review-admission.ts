/** Exact review-to-paper admission bridge. It never selects, changes, or blocks an incumbent order. */
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
} from "@dtc/shared";

import { validMarketContextLineage } from "./authority-contract.js";
import {
  ExecutiveReviewStore,
  type ExecutiveReviewExecutionLink,
  type ExecutiveReviewRecord,
  type ExecutiveVerdict,
} from "./executive-review-store.js";
import type { ExecutiveDecision } from "./four-brain-types.js";
import type { PaperExecutionRouterStore, PaperOrder } from "./paper-execution-router.js";

export type ExecutiveReviewAdmissionResult =
  | "ATTACHED"
  | "NO_EXACT_CANDIDATE"
  | "MARKET_CONTEXT_UNAVAILABLE"
  | "ORDER_ALREADY_EXECUTING"
  | "ORDER_ALREADY_LINKED"
  | "AMBIGUOUS_PAPER_OWNERSHIP"
  | "POST_FIX_POLICY_MISSING"
  | "REVIEW_CONFLICT";

function actionFor(exec: ExecutiveDecision): "ENTER" | "WAIT" | "SKIP" {
  if (exec.entry?.action === "ENTER_NOW") return "ENTER";
  if (exec.entry?.action?.startsWith("WAIT")) return "WAIT";
  return "SKIP";
}

function verdictFor(exec: ExecutiveDecision): ExecutiveVerdict {
  if (exec.candidateStatus === "VALID") return "VALID";
  if (exec.candidateStatus === "WAIT") return "WAIT";
  if (exec.candidateStatus === "SKIP") return "SKIP";
  if (exec.candidateStatus === "FLAT") return "FLAT";
  if (exec.candidateStatus === "BLOCKED_BY_RISK") return "BLOCKED_BY_RISK";
  return "INCUMBENT_ONLY";
}

function hasCurrentPolicy(order: PaperOrder): boolean {
  return order.decisionPolicyVersion === CURRENT_DECISION_POLICY_VERSION
    && order.executionPolicyVersion === EXECUTION_POLICY_VERSION
    && order.evidencePolicyVersion === EVIDENCE_POLICY_VERSION
    && order.evidenceEra === CURRENT_EVIDENCE_ERA;
}

function sameReview(left: ExecutiveReviewRecord, right: ExecutiveReviewRecord): boolean {
  return left.executiveReviewId === right.executiveReviewId
    && left.candidateId === right.candidateId
    && left.opportunityId === right.opportunityId
    && left.laneId === right.laneId
    && left.marketContextSnapshotId === right.marketContextSnapshotId
    && left.decisionPipelinePolicyVersion === right.decisionPipelinePolicyVersion
    && left.executionPolicyVersion === right.executionPolicyVersion
    && left.evidencePolicyVersion === right.evidencePolicyVersion
    && left.fourBrainPolicyVersion === right.fourBrainPolicyVersion;
}

function linkFrom(record: ExecutiveReviewRecord): ExecutiveReviewExecutionLink {
  const {
    executiveReviewId,
    candidateId,
    opportunityId,
    laneId,
    marketContextSnapshotId,
    allocationSnapshotId,
    direction,
    marketState,
    evidenceEra,
    decisionPipelinePolicyVersion,
    executionPolicyVersion,
    evidencePolicyVersion,
    fourBrainPolicyVersion,
  } = record;
  return {
    executiveReviewId,
    candidateId,
    opportunityId,
    laneId,
    marketContextSnapshotId,
    allocationSnapshotId,
    direction,
    marketState,
    evidenceEra,
    decisionPipelinePolicyVersion,
    executionPolicyVersion,
    evidencePolicyVersion,
    fourBrainPolicyVersion,
  };
}

/**
 * Attach a review only where the candidate identity is an exact, persisted PaperOrder source ID.
 * The supplied `executingPaperOrderIds` guards the required ordering: review first, intent second.
 */
export function attachExecutiveReviewToExactPaperOrder(input: {
  reviewStore: ExecutiveReviewStore;
  paperStore: PaperExecutionRouterStore;
  executive: ExecutiveDecision;
  candidateId: string | null;
  executingPaperOrderIds: ReadonlySet<string>;
  /** The raw/normalized feature snapshot this tick's brains actually consumed, if the caller already
   *  has it in hand (e.g. the same gather-cycle state that feeds the four-brain journal). Omitted ⇒
   *  persisted as null — the economic-experience adapter must then treat this review as
   *  EVALUATION_ONLY on feature-snapshot grounds, never fabricate one. */
  brainFeatureSnapshot?: Record<string, unknown> | null;
}): ExecutiveReviewAdmissionResult {
  const { executive, candidateId } = input;
  if (!candidateId || !executive.entry || !executive.laneId || !executive.symbolOrBasketId) return "NO_EXACT_CANDIDATE";
  if (!validMarketContextLineage(executive.marketContext) || executive.marketContext.marketContextSnapshotId === null) return "MARKET_CONTEXT_UNAVAILABLE";

  const exactOrders = input.paperStore.all.filter((order) =>
    order.sourceObservationId === candidateId &&
    order.selectedLaneId === executive.laneId &&
    order.direction === executive.entry!.side &&
    (order.paperStatus === "CREATED" || order.paperStatus === "PAPER_SUBMITTED"),
  );
  if (exactOrders.length === 0) return "NO_EXACT_CANDIDATE";
  if (exactOrders.length !== 1) return "AMBIGUOUS_PAPER_OWNERSHIP";
  const order = exactOrders[0]!;
  if (input.executingPaperOrderIds.has(order.paperOrderId)) return "ORDER_ALREADY_EXECUTING";
  if (order.executiveReviewLink) return "ORDER_ALREADY_LINKED";
  if (!hasCurrentPolicy(order) || !order.causalIdentity?.opportunityId) return "POST_FIX_POLICY_MISSING";

  const record: ExecutiveReviewRecord = {
    executiveReviewId: `executive-review:${executive.decisionId}:${order.causalIdentity.opportunityId}`,
    candidateId,
    opportunityId: order.causalIdentity.opportunityId,
    laneId: executive.laneId,
    marketContextSnapshotId: executive.marketContext.marketContextSnapshotId,
    allocationSnapshotId: executive.allocationContext.snapshotId,
    strategyAction: actionFor(executive),
    direction: executive.entry.side,
    marketState: executive.marketState.family,
    evidenceEra: order.evidenceEra!,
    advisoryVerdict: verdictFor(executive),
    advisoryOnly: true,
    reviewedAtMs: executive.asOfMs,
    sourceCutoffMs: executive.marketContext.sourceCutoffMs!,
    decisionPipelinePolicyVersion: executive.marketContext.decisionPipelinePolicyVersion!,
    executionPolicyVersion: order.executionPolicyVersion!,
    evidencePolicyVersion: order.evidencePolicyVersion!,
    fourBrainPolicyVersion: executive.schemaVersion,
    state: "PENDING_EXECUTION_LINK",
    reasonCode: null,
    positionId: null,
    outcomeId: null,
    // Additive Four-Brain economic-learning identity — every value below is read straight off
    // `executive`/`order.causalIdentity`, both already exact and already validated by the checks
    // above (hasCurrentPolicy + opportunityId presence); none of it is parsed back out of a
    // composite id or rehydrated from later/current state.
    executiveDecisionId: executive.decisionId,
    instanceId: order.causalIdentity.instanceId,
    symbolOrBasketId: executive.symbolOrBasketId,
    policyDeploymentAt: order.causalIdentity.policyDeploymentAt,
    executiveDecisionTimeMs: executive.asOfMs,
    marketStateDecision: executive.marketState,
    directionDecision: executive.direction,
    entryDecision: executive.entry,
    brainFeatureSnapshot: input.brainFeatureSnapshot ?? null,
    brainFeatureSchemaVersions: {
      executive: executive.schemaVersion,
      marketState: executive.marketState.schemaVersion,
      direction: executive.direction?.schemaVersion ?? null,
      entry: executive.entry?.schemaVersion ?? null,
    },
    sourceStatuses: {
      ...executive.marketState.sourceStatuses,
      ...(executive.direction?.sourceStatuses ?? {}),
      ...(executive.entry?.sourceStatuses ?? {}),
    },
  };
  const existing = input.reviewStore.get().reviews.find((review) => review.executiveReviewId === record.executiveReviewId);
  if (existing && !sameReview(existing, record)) return "REVIEW_CONFLICT";
  if (!existing && !input.reviewStore.addReview(record)) return "REVIEW_CONFLICT";
  input.reviewStore.save();
  input.paperStore.update(order.paperOrderId, { executiveReviewLink: linkFrom(existing ?? record) });
  return "ATTACHED";
}

/** Exact review-to-paper admission bridge. It never selects, changes, or blocks an incumbent order. */
import { validMarketContextLineage } from "./authority-contract.js";
import {
  ExecutiveReviewStore,
  type ExecutiveReviewExecutionLink,
  type ExecutiveReviewRecord,
  type ExecutiveVerdict,
} from "./executive-review-store.js";
import type { ExecutiveDecision } from "./four-brain-types.js";
import type { PaperExecutionRouterStore, PaperOrder } from "./paper-execution-router.js";
import {
  isCausalIdentityCurrentlyValid,
  resolveCanonicalPolicyContext,
  resolveCausalCollectionActivation,
} from "../experience-engine/forward-causal-collection.js";

export type ExecutiveReviewAdmissionResult =
  | "ATTACHED"
  | "NO_EXACT_CANDIDATE"
  | "MARKET_CONTEXT_UNAVAILABLE"
  | "ORDER_ALREADY_EXECUTING"
  | "ORDER_ALREADY_LINKED"
  | "AMBIGUOUS_PAPER_OWNERSHIP"
  | "POST_FIX_POLICY_MISSING"
  | "STALE_CAUSAL_IDENTITY"
  | "CORTEX_ALLOCATION_LINK_MISSING"
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

function sameReview(left: ExecutiveReviewRecord, right: ExecutiveReviewRecord): boolean {
  return left.executiveReviewId === right.executiveReviewId
    && left.candidateId === right.candidateId
    && left.opportunityId === right.opportunityId
    && left.laneId === right.laneId
    && left.marketContextSnapshotId === right.marketContextSnapshotId
    && left.allocationSnapshotId === right.allocationSnapshotId
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
   *  EVALUATION_ONLY on feature-snapshot grounds, never fabricate one. Deep-cloned before persisting
   *  so a later mutation of the caller's own object can never alter the stored snapshot. */
  brainFeatureSnapshot?: Record<string, unknown> | null;
  /** Defaults to process.env, exactly like prepareForwardCausalIdentity's own default — tests pass a
   *  controlled object instead for deterministic activation/cutover resolution. */
  env?: NodeJS.ProcessEnv;
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

  // Exact current causal identity, reusing the SAME validator the paper-order causal system itself
  // uses (isCausalIdentityCurrentlyValid) — never a weaker, admission-local duplicate. A stale or
  // mismatched identity (wrong instance, wrong lane/symbol/direction, an earlier policy generation,
  // or a cutover that no longer matches) is never copied into an Executive Review record.
  const env = input.env ?? process.env;
  const causalActivation = resolveCausalCollectionActivation(env);
  const causalPolicyContext = resolveCanonicalPolicyContext(env);
  if (!causalPolicyContext || !order.causalIdentity) return "POST_FIX_POLICY_MISSING";
  if (!isCausalIdentityCurrentlyValid(order.causalIdentity, order, causalActivation, causalPolicyContext)) return "STALE_CAUSAL_IDENTITY";
  // Four-Brain's allocation context has its own snapshot namespace. An exact CORTEX-labelled
  // order may reach Tier 1 only if the producer carries an explicit bridge to the same immutable
  // CORTEX allocation identity; a matching lane/time is never a substitute.
  const cortexAllocationSnapshotId = order.causalIdentity.allocationSnapshotId;
  if (!cortexAllocationSnapshotId || executive.allocationContext.cortexAllocationSnapshotId !== cortexAllocationSnapshotId) {
    return "CORTEX_ALLOCATION_LINK_MISSING";
  }

  const record: ExecutiveReviewRecord = {
    executiveReviewId: `executive-review:${executive.decisionId}:${order.causalIdentity.opportunityId}`,
    candidateId,
    opportunityId: order.causalIdentity.opportunityId,
    laneId: executive.laneId,
    marketContextSnapshotId: executive.marketContext.marketContextSnapshotId,
    allocationSnapshotId: cortexAllocationSnapshotId,
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
    // Exact Entry-attribution ledger — convenience top-level fields mirroring executive.entry, so the
    // adapter can compare against the actual fill without reaching into the nested snapshot.
    entryDecisionId: executive.entry.decisionId,
    paperOrderId: order.paperOrderId,
    decidedSide: executive.entry.side,
    decidedTargetEntry: executive.entry.targetEntry,
    decidedInitialStop: executive.entry.initialStopPrice,
    // Deep-cloned (JSON round-trip — the snapshot is always plain, JSON-safe data) so a later
    // mutation of the caller's own gather-cycle object can never alter what was persisted here.
    brainFeatureSnapshot: input.brainFeatureSnapshot ? JSON.parse(JSON.stringify(input.brainFeatureSnapshot)) : null,
    brainFeatureSchemaVersions: {
      executive: executive.schemaVersion,
      marketState: executive.marketState.schemaVersion,
      direction: executive.direction?.schemaVersion ?? null,
      entry: executive.entry?.schemaVersion ?? null,
    },
    // Namespaced by brain — never a flat merge — so MARKET_STATE, DIRECTION, and ENTRY can each use
    // the same feature-source key name (e.g. "candle") without one brain's freshness silently
    // overwriting another's.
    sourceStatuses: {
      marketState: executive.marketState.sourceStatuses ?? {},
      direction: executive.direction?.sourceStatuses ?? {},
      entry: executive.entry?.sourceStatuses ?? {},
    },
  };
  const existing = input.reviewStore.get().reviews.find((review) => review.executiveReviewId === record.executiveReviewId);
  if (existing && !sameReview(existing, record)) return "REVIEW_CONFLICT";
  if (!existing && !input.reviewStore.addReview(record)) return "REVIEW_CONFLICT";
  input.reviewStore.save();
  input.paperStore.update(order.paperOrderId, { executiveReviewLink: linkFrom(existing ?? record) });
  return "ATTACHED";
}

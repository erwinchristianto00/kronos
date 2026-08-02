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
import { recordCortexProductionChainDiagnostic } from "./cortex-production-chain-diagnostics.js";
import { paperOrderOwnershipKey } from "./paper-order-ownership-index.js";
import type { LiveIntent } from "./live-execution-engine.js";

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
  | "REVIEW_CONFLICT"
  // Late-binding (point 2): the order already turned into a live execution intent BEFORE this
  // review ran. These are only reachable when the caller supplies BOTH
  // liveIntentIndexByPaperOrderId AND saveLiveIntents — otherwise the pre-existing
  // ORDER_ALREADY_EXECUTING short-circuit still fires exactly as before.
  | "INTENT_TERMINAL"
  | "INTENT_LINEAGE_MISSING"
  | "INTENT_LINEAGE_CONFLICT"
  | "INTENT_REVIEW_CONFLICT"
  | "INTENT_INDEX_MISS";

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
    && left.canonicalCortexLaneId === right.canonicalCortexLaneId
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
    canonicalCortexLaneId,
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
    canonicalCortexLaneId,
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
  /** THE canonical persisted ownership index (paper-order-ownership-index.ts), built once per tick
   *  by the caller from the SAME `paperStore` above (`buildPaperOrderOwnershipIndex`) and reused
   *  here instead of a fresh linear scan over the full order book. Keyed by
   *  `paperOrderOwnershipKey(sourceObservationId, selectedLaneId, direction)`; already pre-filtered
   *  to admissible statuses (CREATED/PAPER_SUBMITTED) by the index builder itself, so the lookup
   *  below reproduces the exact same match set the old `.filter(...)` scan produced. */
  paperOrderOwnershipIndex: ReadonlyMap<string, readonly PaperOrder[]>;
  /** The raw/normalized feature snapshot this tick's brains actually consumed, if the caller already
   *  has it in hand (e.g. the same gather-cycle state that feeds the four-brain journal). Omitted ⇒
   *  persisted as null — the economic-experience adapter must then treat this review as
   *  EVALUATION_ONLY on feature-snapshot grounds, never fabricate one. Deep-cloned before persisting
   *  so a later mutation of the caller's own object can never alter the stored snapshot. */
  brainFeatureSnapshot?: Record<string, unknown> | null;
  /** Defaults to process.env, exactly like prepareForwardCausalIdentity's own default — tests pass a
   *  controlled object instead for deterministic activation/cutover resolution. */
  env?: NodeJS.ProcessEnv;
  /** OPTIONAL late-binding support (point 2). THE per-tick live-intent index (live-intent-index.ts,
   *  buildLiveIntentIndexByPaperOrderId), built once by the caller from the SAME liveExecutionStore
   *  this tick — never a fresh linear scan. When supplied together with saveLiveIntents, an order
   *  already turned into a live execution intent is no longer an automatic ORDER_ALREADY_EXECUTING
   *  bail: the function looks the intent up here and attaches the review directly onto it. Omitted ⇒
   *  byte-identical to today — the executing-order case still returns ORDER_ALREADY_EXECUTING
   *  immediately. */
  liveIntentIndexByPaperOrderId?: ReadonlyMap<string, LiveIntent>;
  /** Required together with liveIntentIndexByPaperOrderId. Called exactly once, only immediately after
   *  a successful late-bind mutation of a LiveIntent object taken from that index, to persist it — same
   *  save-after-mutate contract as every other LiveExecutionStore mutator. */
  saveLiveIntents?: () => void;
}): ExecutiveReviewAdmissionResult {
  const { executive, candidateId } = input;
  if (!candidateId || !executive.entry || !executive.laneId || !executive.symbolOrBasketId) return "NO_EXACT_CANDIDATE";
  if (!validMarketContextLineage(executive.marketContext) || executive.marketContext.marketContextSnapshotId === null) return "MARKET_CONTEXT_UNAVAILABLE";

  // O(1)-ish lookup through the shared per-tick ownership index instead of a fresh linear scan over
  // the full order book — same ownership triple (sourceObservationId, selectedLaneId, direction),
  // same admissible-status prefilter (CREATED/PAPER_SUBMITTED), so this reproduces exactly the same
  // candidate set the old `.filter(...)` scan produced, never a looser or stricter one.
  const exactOrders = input.paperOrderOwnershipIndex.get(
    paperOrderOwnershipKey(candidateId, executive.laneId, executive.entry!.side),
  ) ?? [];
  // Point 11: report-only counters mirroring the same 0-match / >1-match distinction the shared
  // ownership index (paper-order-ownership-index.ts) makes elsewhere — purely additive, never read
  // by any branch below; the real admission outcome is still exactly NO_EXACT_CANDIDATE /
  // AMBIGUOUS_PAPER_OWNERSHIP as returned two lines down.
  if (exactOrders.length === 0) {
    recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_MISSING");
    return "NO_EXACT_CANDIDATE";
  }
  if (exactOrders.length !== 1) {
    recordCortexProductionChainDiagnostic("CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS");
    return "AMBIGUOUS_PAPER_OWNERSHIP";
  }
  const order = exactOrders[0]!;
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
  const canonicalCortexLaneId = order.causalIdentity.canonicalCortexLaneId;
  if (!cortexAllocationSnapshotId || !canonicalCortexLaneId ||
    order.canonicalCortexLaneId !== canonicalCortexLaneId ||
    order.cortexDecisionSnapshot?.laneId !== canonicalCortexLaneId ||
    order.cortexDecisionSnapshot?.allocationSnapshotId !== cortexAllocationSnapshotId ||
    order.cortexDecisionSnapshot?.decisionId !== order.causalIdentity.cortexDecisionId ||
    executive.allocationContext.cortexAllocationSnapshotId !== cortexAllocationSnapshotId) {
    recordCortexProductionChainDiagnostic("CORTEX_EXECUTIVE_ATTACHMENT_REJECTED");
    return "CORTEX_ALLOCATION_LINK_MISSING";
  }

  const record: ExecutiveReviewRecord = {
    executiveReviewId: `executive-review:${executive.decisionId}:${order.causalIdentity.opportunityId}`,
    candidateId,
    opportunityId: order.causalIdentity.opportunityId,
    laneId: executive.laneId,
    marketContextSnapshotId: executive.marketContext.marketContextSnapshotId,
    allocationSnapshotId: cortexAllocationSnapshotId,
    canonicalCortexLaneId,
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
    executionIntentId: null,
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

  // The executing-order bail moves to HERE — after `record` is fully built and validated — so both
  // the normal and late-binding paths below reuse the identical, already-validated `record` rather
  // than duplicating the construction/validation above.
  const executing = input.executingPaperOrderIds.has(order.paperOrderId);
  if (executing && (!input.liveIntentIndexByPaperOrderId || !input.saveLiveIntents)) {
    // No late-binding support supplied by this caller — today's exact behavior, unchanged.
    return "ORDER_ALREADY_EXECUTING";
  }

  if (executing) {
    // ── Late-binding path (point 2): the intent already exists; attach the review directly onto it,
    //    via the per-tick intent index (point 5) — never a fresh linear scan of the intent store. ──
    const intent = input.liveIntentIndexByPaperOrderId!.get(order.paperOrderId);
    // executingPaperOrderIds said this order is executing, but the index (built from the SAME
    // liveExecutionStore this tick) has no entry for it — the two inputs disagree. Fail closed:
    // never assume which one is stale.
    if (!intent) return "INTENT_INDEX_MISS";
    if (intent.state === "CLOSED" || intent.state === "ERROR" || intent.state === "KILLED") return "INTENT_TERMINAL";

    const primary = intent.paperOrderId === order.paperOrderId;
    const sourceEntry = intent.sourcePaperOrders?.find((s) => s.paperOrderId === order.paperOrderId);
    if (!primary && !sourceEntry) return "INTENT_INDEX_MISS";

    // Idempotent replay / conflicting-link detection, exactly mirroring order.executiveReviewLink's
    // own short-circuit above but read off the intent (or its matching source entry) instead — the
    // intent may already carry a link from an earlier late-bind attempt that never reached the
    // PaperOrder (e.g. a process restart between steps).
    const existingLink = primary ? intent.executiveReviewLink : sourceEntry?.executiveReviewLink;
    if (existingLink) {
      if (existingLink.executiveReviewId === record.executiveReviewId) return "ORDER_ALREADY_LINKED";
      return "INTENT_REVIEW_CONFLICT"; // never overwrite a DIFFERENT existing link
    }

    // Compare against the intent's OWN immutable lineage snapshot (captured once at open, see
    // LiveIntent.causalLineage) — never re-derive from the PaperOrder's current causalIdentity as
    // the source of truth, since that field can be reassigned after admission
    // (paper-execution-router.ts's re-price path).
    const intentLineage = primary ? intent.causalLineage : sourceEntry?.causalLineage;
    if (!intentLineage) return "INTENT_LINEAGE_MISSING";
    const identity = order.causalIdentity!; // already validated non-null/current by the STALE_CAUSAL_IDENTITY check above
    const lineageMatches =
      intentLineage.opportunityId === identity.opportunityId &&
      intentLineage.cortexDecisionId === identity.cortexDecisionId &&
      intentLineage.allocationSnapshotId === identity.allocationSnapshotId &&
      intentLineage.canonicalCortexLaneId === identity.canonicalCortexLaneId &&
      intentLineage.instanceId === identity.instanceId &&
      intentLineage.policyDeploymentAt === identity.policyDeploymentAt;
    if (!lineageMatches) return "INTENT_LINEAGE_CONFLICT";

    const existing = input.reviewStore.get().reviews.find((review) => review.executiveReviewId === record.executiveReviewId);
    if (existing && !sameReview(existing, record)) return "REVIEW_CONFLICT";
    if (!existing && !input.reviewStore.addReview(record)) return "REVIEW_CONFLICT";
    input.reviewStore.save();
    const link = linkFrom(existing ?? record);
    // Attach across all three: the intent (or its matching source entry), and the PaperOrder — kept
    // in sync exactly like the normal (non-late-binding) path below does.
    if (primary) intent.executiveReviewLink = link;
    if (sourceEntry) sourceEntry.executiveReviewLink = link;
    input.saveLiveIntents!();
    input.paperStore.update(order.paperOrderId, { executiveReviewLink: link });
    return "ATTACHED";
  }

  // ── Normal (non-executing) path — unchanged. ──
  const existing = input.reviewStore.get().reviews.find((review) => review.executiveReviewId === record.executiveReviewId);
  if (existing && !sameReview(existing, record)) return "REVIEW_CONFLICT";
  if (!existing && !input.reviewStore.addReview(record)) return "REVIEW_CONFLICT";
  input.reviewStore.save();
  input.paperStore.update(order.paperOrderId, { executiveReviewLink: linkFrom(existing ?? record) });
  return "ATTACHED";
}

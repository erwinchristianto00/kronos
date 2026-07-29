/**
 * Runtime bridge for Executive Review lineage. It deliberately accepts only persisted,
 * immutable IDs already carried by an incumbent intent. There is no symbol/time/price lookup.
 */
import type { LiveIntent } from "./live-execution-engine.js";
import type { PaperOrder } from "./paper-execution-router.js";
import {
  type ExecutiveReviewExecutionLink,
  type ExecutiveReviewOutcomeLink,
  type ExecutiveReviewPositionLink,
  type ExecutiveReviewReasonCode,
  ExecutiveReviewStore,
} from "./executive-review-store.js";

export interface ExecutiveReviewResolutionSummary {
  examined: number;
  linked: number;
  rejected: number;
  pending: number;
}

const COMPLETED_CANDLE_MS = 15 * 60_000;
const TERMINAL_INTENT_STATES = new Set(["CLOSED", "ERROR", "KILLED"]);

function dateOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface ExecutiveReviewTier2Summary {
  examined: number;
  markedTier2Only: number;
}

function exactLinks(intent: LiveIntent): ExecutiveReviewExecutionLink[] {
  const byReviewId = new Map<string, ExecutiveReviewExecutionLink>();
  if (intent.executiveReviewLink) byReviewId.set(intent.executiveReviewLink.executiveReviewId, intent.executiveReviewLink);
  for (const source of intent.sourcePaperOrders ?? []) {
    if (source.executiveReviewLink) byReviewId.set(source.executiveReviewLink.executiveReviewId, source.executiveReviewLink);
  }
  return [...byReviewId.values()];
}

function positionLink(
  intent: LiveIntent,
  link: ExecutiveReviewExecutionLink,
  ambiguousOwnership: boolean,
): ExecutiveReviewPositionLink | null {
  // An intent has not become an execution position until the incumbent persisted BOTH IDs.
  if (!intent.executionIntentId || !intent.positionId || !intent.entryOrderId) return null;
  const entryAtMs = Date.parse(intent.createdAt);
  return {
    executiveReviewId: link.executiveReviewId,
    candidateId: link.candidateId,
    opportunityId: link.opportunityId,
    executionIntentId: intent.executionIntentId,
    orderId: intent.entryOrderId,
    positionId: intent.positionId,
    laneId: link.laneId,
    marketContextSnapshotId: link.marketContextSnapshotId,
    entryAtMs: Number.isFinite(entryAtMs) ? entryAtMs : null,
    originalRisk: intent.originalRiskUsd ?? null,
    ambiguousOwnership,
    decisionPipelinePolicyVersion: link.decisionPipelinePolicyVersion,
    executionPolicyVersion: link.executionPolicyVersion,
    evidencePolicyVersion: link.evidencePolicyVersion,
    fourBrainPolicyVersion: link.fourBrainPolicyVersion,
  };
}

function outcomeLink(
  intent: LiveIntent,
  link: ExecutiveReviewExecutionLink,
  nowMs: number,
  ambiguousOwnership: boolean,
): ExecutiveReviewOutcomeLink | null {
  if (!TERMINAL_INTENT_STATES.has(intent.state)) return null;
  const closedAtMs = intent.closedAt ? Date.parse(intent.closedAt) : Number.NaN;
  // Canonical Four-Brain R uses the IMMUTABLE risk fixed at admission, never effectiveRiskUsd — that
  // field is documented R-clipping TELEMETRY (report-only) and can change after entry (pyramid/rescue
  // additions), which would make the same closed position's canonical R drift depending on when it
  // was read. originalRiskUsd is assigned exactly once, at intent creation, and never reassigned.
  const risk = intent.originalRiskUsd;
  const netUsd = intent.realizedPnlUsd;
  const feesUsd = intent.feesUsd;
  const closedCandleAtMs = Number.isFinite(closedAtMs)
    ? (Math.floor(closedAtMs / COMPLETED_CANDLE_MS) + 1) * COMPLETED_CANDLE_MS
    : Number.POSITIVE_INFINITY;
  const settlementComplete = intent.settlementFetchComplete === true &&
    Array.isArray(intent.missingRequiredOrderIds) && intent.missingRequiredOrderIds.length === 0;
  const costKnown = intent.feeSource === "EXCHANGE" && settlementComplete;
  const canCalculateR =
    typeof risk === "number" && Number.isFinite(risk) && risk > 0 &&
    typeof netUsd === "number" && Number.isFinite(netUsd) &&
    typeof feesUsd === "number" && Number.isFinite(feesUsd);
  const netR = canCalculateR ? netUsd / risk : null;
  const costR = canCalculateR ? feesUsd / risk : null;
  const grossR = canCalculateR && netR !== null && costR !== null ? netR + costR : null;
  return {
    executiveReviewId: link.executiveReviewId,
    opportunityId: link.opportunityId,
    positionId: intent.positionId ?? null,
    outcomeId: Number.isFinite(closedAtMs)
      ? `live-executive-outcome:${intent.executionIntentId ?? "missing"}:${closedAtMs}:${link.executionPolicyVersion}`
      : null,
    resolvedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : null,
    grossR,
    costR,
    executionCostKnown: costKnown,
    executionCostProvenance: costKnown ? "EXCHANGE_MEASURED" : null,
    netR,
    decisionPipelinePolicyVersion: link.decisionPipelinePolicyVersion,
    executionPolicyVersion: link.executionPolicyVersion,
    evidencePolicyVersion: link.evidencePolicyVersion,
    fourBrainPolicyVersion: link.fourBrainPolicyVersion,
    completedCandle: Number.isFinite(nowMs) && nowMs >= closedCandleAtMs,
    ambiguousOwnership,
    settlementFetchComplete: intent.settlementFetchComplete === true,
    requiredOrderIds: intent.requiredOrderIds?.slice() ?? [],
    matchedRequiredOrderIds: intent.matchedRequiredOrderIds?.slice() ?? [],
    missingRequiredOrderIds: intent.missingRequiredOrderIds?.slice() ?? [],
    // One dedicated field per clock — none of these substitutes for another, and each is null (not
    // backfilled from a different clock) when the exact source is unavailable.
    entryFilledAtMs: dateOrNull(intent.entryFilledAt),
    marketClosedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : null,
    settlementResolvedAtMs: dateOrNull(intent.settlementResolvedAt),
    actualEntryPrice: typeof intent.filledEntryPrice === "number" && Number.isFinite(intent.filledEntryPrice) ? intent.filledEntryPrice : null,
    entryFillOrderIds: intent.entryOrderIds?.length ? intent.entryOrderIds.slice() : intent.entryOrderId ? [intent.entryOrderId] : null,
  };
}

function stateFor(store: ExecutiveReviewStore, reviewId: string): string | null {
  return store.get().reviews.find((review) => review.executiveReviewId === reviewId)?.state ?? null;
}

/**
 * Resolves only the intent -> order -> position segment. A live USD P&L alone is NOT an R-labelled,
 * completed-candle outcome, so this bridge intentionally never fabricates a Tier 1 outcome.
 */
export function resolveExecutiveReviewPositions(
  store: ExecutiveReviewStore,
  intents: readonly LiveIntent[],
  nowMs: number = Date.now(),
): ExecutiveReviewResolutionSummary {
  const summary: ExecutiveReviewResolutionSummary = { examined: 0, linked: 0, rejected: 0, pending: 0 };
  let dirty = false;
  for (const intent of intents) {
    const links = exactLinks(intent);
    if (links.length === 0) continue;
    const ambiguousOwnership = links.length !== 1;
    for (const link of links) {
      summary.examined += 1;
      const position = positionLink(intent, link, ambiguousOwnership);
      if (!position) {
        summary.pending += 1;
        continue;
      }
      const before = stateFor(store, link.executiveReviewId);
      const reason = store.resolve(link.executiveReviewId, position, outcomeLink(intent, link, nowMs, ambiguousOwnership));
      const after = stateFor(store, link.executiveReviewId);
      if (before !== after) dirty = true;
      if (reason === null || (reason === "POSITION_NOT_RESOLVED" && before !== after && after === "PENDING_OUTCOME")) summary.linked += 1;
      else if (reason === "AMBIGUOUS_OWNERSHIP") summary.rejected += 1;
      else summary.pending += 1;
    }
  }
  if (dirty) store.save();
  return summary;
}

/** Exact terminal-paper classification. It never creates a counterfactual outcome. */
export function markTerminalExecutiveReviewsTier2Only(
  store: ExecutiveReviewStore,
  orders: readonly PaperOrder[],
  executingPaperOrderIds: ReadonlySet<string>,
): ExecutiveReviewTier2Summary {
  const terminalWithoutPosition = new Set([
    "PAPER_CANCELED",
    "PAPER_REJECTED",
    "PAPER_EXPIRED",
    "PAPER_NO_FILL",
    "PAPER_DATA_FAILURE",
  ]);
  const summary: ExecutiveReviewTier2Summary = { examined: 0, markedTier2Only: 0 };
  let dirty = false;
  for (const order of orders) {
    const link = order.executiveReviewLink;
    if (!link || !terminalWithoutPosition.has(order.paperStatus) || executingPaperOrderIds.has(order.paperOrderId)) continue;
    summary.examined += 1;
    const before = stateFor(store, link.executiveReviewId);
    const reason = store.markTier2Only(link.executiveReviewId, "NO_REAL_POSITION");
    const after = stateFor(store, link.executiveReviewId);
    if (before !== after) dirty = true;
    if (reason === null) summary.markedTier2Only += 1;
  }
  if (dirty) store.save();
  return summary;
}

/** Narrow helper for callers that need to expose a fail-closed resolver reason without interpreting it. */
export function isExecutiveReviewTerminalReason(reason: ExecutiveReviewReasonCode | null): boolean {
  return reason === "AMBIGUOUS_OWNERSHIP"
    || reason === "CANDIDATE_ID_MISMATCH"
    || reason === "OPPORTUNITY_ID_MISMATCH"
    || reason === "MARKET_SNAPSHOT_MISMATCH"
    || reason === "POLICY_VERSION_MISMATCH"
    || reason === "ORIGINAL_RISK_INVALID";
}

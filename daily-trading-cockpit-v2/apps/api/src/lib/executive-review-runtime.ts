/**
 * Runtime bridge for Executive Review lineage. It deliberately accepts only persisted,
 * immutable IDs already carried by an incumbent intent. There is no symbol/time/price lookup.
 */
import type { LiveIntent } from "./live-execution-engine.js";
import type { PaperOrder } from "./paper-execution-router.js";
import type { ExecutionFill } from "./execution-fill-recorder.js";
import {
  type ExecutiveReviewExecutionLink,
  type ExecutiveReviewOutcomeLink,
  type ExecutiveReviewPositionLink,
  type ExecutiveReviewReasonCode,
  ExecutiveReviewStore,
} from "./executive-review-store.js";

/** Deterministic quantity-weighted average price across real confirmed fills. `null` when there is
 *  nothing to weight (empty input or zero total quantity) — never a fabricated price. */
function weightedAverageEntryPrice(fills: readonly ExecutionFill[]): number | null {
  const totalQty = fills.reduce((sum, f) => sum + f.qty, 0);
  if (!(totalQty > 0)) return null;
  const totalNotional = fills.reduce((sum, f) => sum + f.price * f.qty, 0);
  return totalNotional / totalQty;
}

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
    allocationSnapshotId: link.allocationSnapshotId,
    canonicalCortexLaneId: link.canonicalCortexLaneId,
    // Legacy name, legacy meaning: intent-CREATION time, kept for backward compatibility and the
    // store's own structural sanity gate. Never the exact open clock for direct economic eligibility
    // — that is entryFilledAtMs below, sourced only from a confirmed fill.
    entryAtMs: Number.isFinite(entryAtMs) ? entryAtMs : null,
    // Honestly-named duplicate of the same intent.createdAt value, for any future reader that wants
    // "when was the intent created" without inheriting entryAtMs's misleading name.
    intentCreatedAtMs: Number.isFinite(entryAtMs) ? entryAtMs : null,
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
  // Real per-trade fill evidence only (see LiveIntent.confirmedEntryFills) — never derived from
  // acknowledged/submitted order ids and never fabricated when no confirmed fill exists yet.
  const confirmedFills = intent.confirmedEntryFills ?? [];
  const confirmedEntryFillOrderIds = confirmedFills.length > 0
    ? [...new Set(confirmedFills.map((f) => f.orderId))]
    : null;
  const confirmedEntryTradeIds = confirmedFills.length > 0
    ? [...new Set(confirmedFills.map((f) => f.tradeId).filter((id): id is string => typeof id === "string" && id.length > 0))]
    : null;
  const confirmedEntryFilledAtMs = confirmedFills.length > 0
    ? Math.min(...confirmedFills.map((f) => f.time))
    : null;
  const confirmedActualEntryPrice = weightedAverageEntryPrice(confirmedFills);
  return {
    executiveReviewId: link.executiveReviewId,
    opportunityId: link.opportunityId,
    positionId: intent.positionId ?? null,
    allocationSnapshotId: link.allocationSnapshotId,
    canonicalCortexLaneId: link.canonicalCortexLaneId,
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
    // confirmedEntryFills is real per-trade evidence (/userTrades rows matched to the singular,
    // never-reassigned entryOrderId — see live-execution-engine.ts). It is preferred over every
    // legacy derivation below; those remain only for records that predate this field.
    entryFilledAtMs: confirmedEntryFilledAtMs ?? dateOrNull(intent.entryFilledAt),
    marketClosedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : null,
    settlementResolvedAtMs: dateOrNull(intent.settlementResolvedAt),
    actualEntryPrice: confirmedActualEntryPrice ?? (
      intent.entryPriceConfirmed === true &&
        typeof intent.filledEntryPrice === "number" && Number.isFinite(intent.filledEntryPrice)
        ? intent.filledEntryPrice
        : null
    ),
    // LEGACY/COMPATIBILITY ONLY. entryOrderId/entryOrderIds are stamped at EXCHANGE_ACK (order
    // placement), BEFORE any fill is confirmed — this field never proves a fill happened, only that
    // entryPriceConfirmed was true when some order id was already on the intent. Direct-learning
    // eligibility must use confirmedEntryFillOrderIds instead; this stays only for older records and
    // diagnostics.
    entryFillOrderIds: intent.entryPriceConfirmed === true
      ? (intent.entryOrderIds?.length ? intent.entryOrderIds.slice() : intent.entryOrderId ? [intent.entryOrderId] : null)
      : null,
    // Exact confirmed-fill identity: order ids and trade ids that come ONLY from real per-trade
    // exchange records (LiveIntent.confirmedEntryFills), never from acknowledgment/submission alone.
    // null (not []) when no confirmed fill evidence exists yet.
    confirmedEntryFillOrderIds,
    confirmedEntryTradeIds,
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

import type { PaperOrder } from "./paper-execution-router.js";

/**
 * THE canonical persisted candidate-ownership identity, end to end: scanner candidate ->
 * allocator opportunity -> PaperOrder -> Four-Brain EntryCandidate -> ExecutiveDecision/Review.
 * It is the triple (order.sourceObservationId, order.selectedLaneId, order.direction) already
 * persisted on every PaperOrder — see the doc comments on those fields in
 * paper-execution-router.ts. Never introduce a second, competing ownership key: downstream,
 * `CausalIdentity.opportunityId` (forward-causal-collection.ts) is an OUTCOME-side identity
 * derived FROM a PaperOrder via this same triple, not an alternative to it.
 */
export function paperOrderOwnershipKey(
  sourceObservationId: string,
  selectedLaneId: string,
  direction: "LONG" | "SHORT",
): string {
  return `${sourceObservationId}\0${selectedLaneId}\0${direction}`;
}

/** Only currently-actionable orders can be the live owner of an open candidate. A terminal
 *  (closed/rejected/canceled) order is never eligible, no matter how exact its identity match. */
const ADMISSIBLE_OWNERSHIP_STATUSES: ReadonlySet<string> = new Set(["CREATED", "PAPER_SUBMITTED"]);

/**
 * Builds the ownership index once per tick — O(orders). Every subsequent lookup by
 * `paperOrderOwnershipKey(...)` is then O(1) amortized, replacing a per-candidate linear scan
 * over the full order book (which was O(orders * candidates)).
 *
 * Fails closed by construction: this index never picks a "best" match. A caller must inspect the
 * length of the returned bucket itself — 0 entries means MISSING, more than 1 means AMBIGUOUS/
 * duplicate ownership — and both are the caller's responsibility to reject, never this index's.
 */
export function buildPaperOrderOwnershipIndex(
  orders: readonly PaperOrder[],
): ReadonlyMap<string, readonly PaperOrder[]> {
  const index = new Map<string, PaperOrder[]>();
  for (const order of orders) {
    if (!ADMISSIBLE_OWNERSHIP_STATUSES.has(order.paperStatus)) continue;
    const key = paperOrderOwnershipKey(order.sourceObservationId, order.selectedLaneId, order.direction);
    const bucket = index.get(key);
    if (bucket) bucket.push(order);
    else index.set(key, [order]);
  }
  return index;
}

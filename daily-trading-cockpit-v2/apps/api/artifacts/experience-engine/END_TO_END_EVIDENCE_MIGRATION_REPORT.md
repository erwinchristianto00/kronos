# End-To-End Evidence Migration Report

## Scope

This report records the post-fix evidence boundary introduced after the
end-to-end audit. It is intentionally non-destructive: legacy rows are never
rewritten to look current and no runtime store is reset by this change.

## New eligibility boundary

Evidence is eligible for current expectancy, routing, Four-Brain evidence, or
CORTEX candidate learning only when all of the following are true:

1. It carries the exact current policy stamps and evidence era.
2. It has a completed, causal market path. Historical shadow catchup may use
   only immutable entry/SL/TP geometry; dynamic exits are evaluated only at the
   current scan timestamp.
3. Pending orders have a valid `firstSeenAt`; filled orders have a valid,
   explicit `entryFilledAt`.
4. Gross R, signed cost R, and net R satisfy `netR = grossR + costR`.
5. CORTEX has an exact persisted decision -> opportunity -> outcome chain.

## Contamination treatment

- Existing unstamped or legacy records remain audit-only.
- New policy-stamped rows lacking any boundary above fail closed and are
  diagnostic-only; they cannot be promoted into current evidence.
- This patch does not assert that pre-patch historical catchup outcomes are
  causally valid. They remain separated from current routing by the strict
  policy stamp gate.

## Reset decision

No destructive reset is included in this source change. A runtime reset is
required only if an operator needs the post-fix cohort count itself to begin at
zero. If performed, archive the affected runtime data first and retain this
report with the archive label. Static allocation, secrets, policy constants,
deployment manifests, and live-instance data are out of scope.

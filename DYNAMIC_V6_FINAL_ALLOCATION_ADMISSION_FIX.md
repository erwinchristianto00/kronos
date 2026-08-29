# Dynamic MOM36 V6.1 final-allocation-aware admission fix

## Policy identity

New strategy version:

`dynamic-mom36-cont-slowfast-feasibility-final-admission-sl2-mfe30-36h-v6.1`

V6.1 keeps the V6 strict directional-feasibility resolver. The semantic change is limited to admission: it may now approve a fully valid one-sided final allocation rather than rejecting it because an unrelated synthetic 3L/3S probe cannot be formed.

Pre-V6.1 identities retain their existing legacy admission path, so this is not a silent rewrite of prior baskets or historical evidence.

## Implementation

1. Formation creates one immutable `DynamicMom36FinalFormationPlan` containing the base/requested/final allocation, exact selected candidates, strict availability, and a deterministic `formationId` plus candidate hash.
2. V6.1 admission consumes that plan and never runs `buildFilteredCrossSectionalBasket`.
3. Two-sided score gap uses only the selected final legs. One-sided score gap is explicitly N/A, not a pass/fail numeric placeholder.
4. Formation snapshot logs base, requested, final allocation; strict counts; selected candidate trail; score-gap applicability; reason; and both identity values.
5. The executor checks the immutable formation/admission identity, exact execution legs, and score-gap value before it reserves or places an order. Any mismatch yields `FORMATION_ADMISSION_PLAN_MISMATCH` and zero orders.

## Explicit outcomes

| Condition | V6.1 result |
| --- | --- |
| valid 0L6S / valid 6L0S | admission may pass with score gap N/A |
| valid two-sided plan with score gap below floor | `ADMISSION_SCORE_GAP_FAIL` |
| fewer than six strict-valid selected legs | `ADMISSION_FINAL_ALLOCATION_INFEASIBLE` |
| cluster prevents completion | `ADMISSION_CLUSTER_GUARD` |
| selected leg invalid after plan freeze | `ADMISSION_SELECTED_LEG_INVALID` |
| external liquidity/stand-down guard | `ADMISSION_EXTERNAL_GUARD:<detail>` |
| formation/admission/execution mismatch | executor fails closed before orders |

## Non-goals

No new threshold, selection-margin gate, raw fallback, candidate hardcoding, universe change, side reversal, Daily Range change, frontend/dashboard change, or continuation model change is part of this release.

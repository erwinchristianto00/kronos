# Dynamic MOM36 V6 score-gap semantics audit

Status: pre-deployment audit for V6.1.

## Existing economic meaning

The generic cross-sectional score gap is:

`abs(mean(selected long scores) - mean(selected short scores))`

Source: `apps/api/src/lib/cross-sectional-edge.ts`, `scoreGapFor`.

The score is the existing adaptive-ranked MOM36 score used by the former admission probe. V6.1 preserves that score source; it changes only the symbol sets supplied to the statistic.

## Old assumption and its failure

The legacy Dynamic path supplied top-three long and top-three short candidates to the generic builder. That was valid only for a symmetric, independently reconstructed 3L/3S representation. It was not a property of a V6 final allocation.

For a valid `0L6S` or `6L0S` plan, a cross-side mean does not exist. Treating `null` as a score-gap failure was a category error, not a negative score gap.

## V6.1 semantics

| Final allocation | Input to score-gap calculation | Gate |
| --- | --- | --- |
| `5L1S`, `4L2S`, `3L3S`, `2L4S`, `1L5S` | exact selected final long set vs exact selected final short set | existing score gap floor applies |
| `6L0S`, `0L6S` | no cross-side statistic | `scoreGap=null`, `scoreGapApplicable=false`, `scoreGapReason=ONE_SIDED_FINAL_ALLOCATION`; only this gate is skipped |
| incomplete / invalid final plan | no admission score gap is trusted | reject with explicit plan/guard reason |

The symmetric `3L3S` formula is algebraically identical to the prior formula when the selected legs are the same. Regression coverage asserts this parity.

## What one-sided admission still checks

One-sided does not mean auto-pass. It still requires exact six selected legs, strict MOM36 and FAST4H signs, blocklist and current execution eligibility, cluster cap, loss/reentry guard, external admission guard, ownership/netting safety, fresh signal, reservation safety, and no incompatible open basket. The executor independently verifies formation/admission/execution identity immediately before any order.

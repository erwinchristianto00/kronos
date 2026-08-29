# Dynamic MOM36 V6 final-allocation admission audit

Status: pre-deployment audit for the V6.1 delta. This document describes the observed V6 runtime and the code path before the fix; it is not evidence of a live deployment.

## Runtime observation

At the audited bearish formation retained in both TESTNET and LIVE runtime logs:

| Evidence | Observed value |
| --- | --- |
| Active universe | 21 symbols |
| MOM36 breadth | 0 positive / 21 negative / 0 zero |
| Strict execution-eligible legs | 0 long / 12 short |
| V6 resolved allocation | `0L6S` |
| Selected strict shorts | `WIFUSDT, OPUSDT, TAOUSDT, 1000PEPEUSDT, ADAUSDT, SUIUSDT` |
| Selection result | complete; `REQUESTED_STRICT_FEASIBLE` |
| Legacy admission result | `scoreGap=null`, `passed=false`, `ADMISSION_NOT_PASSED` |

The selected symbols are observed evidence only; no policy path is keyed to these names.

## Confirmed root cause

The runtime correctly resolved the V6 final plan, but then the cycle independently constructed a synthetic balanced admission basket. That synthetic 3L/3S probe could not find a strict long leg, so its score gap was null and it vetoed the valid `0L6S` plan.

This violated the required authority order:

`breadth -> continuation -> strict feasibility -> final plan -> admission -> execution`.

## Code ownership before and after

| Responsibility | Source | Pre-fix behavior | V6.1 behavior |
| --- | --- | --- | --- |
| MOM36 breadth | `apps/api/src/lib/dynamic-mom36-shock-strategy.ts:608`, `baseDynamicMom36Allocation` | determines directional allocation prior | unchanged |
| V6 feasibility | `apps/api/src/lib/dynamic-mom36-shock-strategy.ts:888`, `resolveDirectionalFeasibility` | resolves only toward the pre-existing direction with strict legs | unchanged |
| Strict candidate selection | `apps/api/src/lib/dynamic-mom36-shock-strategy.ts:793`, `selectDynamicMom36Legs` | rank + Slow/Fast + execution + cluster guards | unchanged |
| Generic admission probe | `apps/api/src/lib/cross-sectional-edge.ts:3161`, legacy `buildFilteredCrossSectionalBasket` call | reconstructed 3L/3S for Dynamic V6 | retained only for pre-V6.1 identities |
| V6.1 final plan | `apps/api/src/lib/cross-sectional-edge.ts:1262`, `buildDynamicMom36FinalFormationPlan` | absent | exact allocation and selected-leg identity |
| V6.1 admission | `apps/api/src/lib/cross-sectional-edge.ts:1346`, `evaluateDynamicMom36FinalAdmission` | absent | evaluates immutable resolved plan only |
| Final basket creation | `apps/api/src/lib/cross-sectional-edge.ts:1627`, `evaluateDynamicMom36Formation` | coupled to prior generic probe | uses the plan and its admission result |
| Execution parity | `apps/api/src/lib/cross-sectional-executor.ts:5238`, `maybeOpenBasket` | no final-plan identity assertion | fail closed on formation/admission/execution mismatch |

## Preserved safety controls

This delta does not change MOM36, FAST4H, V6 directionality, exact-six rule, blocklists, loss/reentry, cluster capacity, ownership/netting, stale-signal handling, $25 leg sizing, leverage, max-open-baskets, or `-2% / +3% MFE arm / 30% giveback / 36h` exit semantics.

Existing baskets retain their frozen policy fingerprint and are never reselected, rebalanced, or closed by this change.

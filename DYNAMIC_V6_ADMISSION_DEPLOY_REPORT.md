# Dynamic MOM36 V6.1 Final-Allocation Admission Deployment Report

Date: 2026-08-29

## Scope and isolation

This is a narrow Dynamic MOM36 Cross-sectional admission fix.  The staged release
diff contains only the three admission/formation/executor files, six Dynamic test
files, and these audit documents.  No `apps/web` source or Daily Range source was
changed.  The candidate was copied from the then-active release and retained its
durable state directory; no state was reset or rebuilt.

## Versioned policy

Both lanes now run:

`dynamic-mom36-cont-slowfast-feasibility-final-admission-sl2-mfe30-36h-v6.1`

Implementation commit: `ddf829e5055dc21e7179d6e0779d26609e69738b`.

The V6.1 identity explicitly means that admission consumes the immutable final
strict Slow+Fast formation plan.  Pre-V6.1 identities retain their legacy
compatibility adapter, so historical basket semantics are not retroactively
changed.

## Testnet deployment

- Previous release: `manual-close-startup-priority-v1-20260829T073300Z`
- V6.1 release: `dynamic-v6-final-admission-v6.1-20260829T080747Z`
- First guarded attempt safely refused because the private-account cache was not
  fresh; it made no process or account change.
- Guarded cutover subsequently verified at `2026-08-29T08:16:20Z`.
- Post-start account fingerprint: 0 positions, 0 open orders.
- Post-start executor: V6.1, `DYNAMIC_MOM36_BREADTH`, `BREADTH_6_TOTAL`,
  `SLOW_AND_FAST`, zero open baskets, zero orphaned legs, no reservation.

## Live deployment

- Previous release: `fade-bracket-close-priority-v1-20260829T061000Z`
- V6.1 release: `dynamic-v6-final-admission-v6.1-20260829T081820Z`
- Guarded cutover began at `2026-08-29T08:24:01Z` and verified matching account
  fingerprint at `2026-08-29T08:24:15Z`.
- Post-start account fingerprint: 0 positions, 0 open orders.
- PM2 process: online, restart count 0, executing the V6.1 release path.
- Executor: V6.1, `DYNAMIC_MOM36_BREADTH`, `BREADTH_6_TOTAL`,
  `SLOW_AND_FAST`, zero open baskets, zero orphaned legs, no reservation.

There were no open Cross-sectional baskets at either cutover, so the open-basket
freeze invariant was preserved vacuously.  No manual order or canary basket was
created.

## Natural runtime evidence after deployment

Both lanes naturally evaluated the same current bearish breadth state:

| Field | Testnet | Live |
| --- | --- | --- |
| Base / requested / final allocation | 0L/6S | 0L/6S |
| Strict eligible LONG / SHORT | 0 / 10 | 0 / 10 |
| Selected SHORTs | WIF, WLD, 1000PEPE, OP, TAO, ADA | WIF, WLD, 1000PEPE, OP, TAO, ADA |
| Score gap | `null` / not applicable | `null` / not applicable |
| Score-gap reason | `ONE_SIDED_FINAL_ALLOCATION` | `ONE_SIDED_FINAL_ALLOCATION` |
| Admission | `ADMISSION_PASSED` | `ADMISSION_PASSED` |

In each lane, `formationId == admission.formationId` and the selected-candidate
hashes are identical.  This is the desired runtime proof that no synthetic 3L/3S
probe remains for a valid one-sided final allocation.

The normal executor then safely withheld an order because its USD-M two-sided
execution book check was unavailable (Testnet: all six selected symbols; Live:
TAO and ADA).  It created no partial basket, order, reservation, or orphan.  This
is an independent execution-data availability condition, not an admission failure;
no execution path was changed by this delta.

## Validation

- Shared build: passed.
- API build: passed.
- Pre-start required-env check: all 56 values correct in each candidate.
- Focused Dynamic suite: 6 files / 69 tests passed locally, in the Testnet
  candidate, and in the Live candidate.
- Coverage includes 0L6S, 6L0S, 5L1S, 4L2S, 3L3S parity, 2L4S, 1L5S,
  strict insufficiency, blocklist, cluster rejection, stale data, V6 fallback,
  candidate-order stability, formation/admission mutation fail-closed, and
  executor identity parity.
- The full API suite was not clean in the inherited snapshot: 379 files passed,
  1 skipped, 15 failed (14 tests), including AppleDouble metadata resources and
  unrelated Live/Four-Brain/paper-route suites.  None are modified Dynamic files;
  the focused suite is the release gate for this narrow delta.

## Rollback

The previous versioned releases remain intact.  Roll back only through the
corresponding guarded cutover script, after taking a fresh account snapshot:

- Testnet target: `manual-close-startup-priority-v1-20260829T073300Z`
- Live target: `fade-bracket-close-priority-v1-20260829T061000Z`

Do not copy files into an active release or reset the shared state directory.


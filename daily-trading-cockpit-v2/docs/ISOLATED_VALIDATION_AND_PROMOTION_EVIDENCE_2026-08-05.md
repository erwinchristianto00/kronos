# Isolated Runtime Validation & Staging-to-Active Promotion — Evidence Report

**Date:** 2026-08-05
**Branch:** `fix/cortex-four-brain-causal-runtime`
**Final commit under review at time of writing:** `bc3c586`
**Integration baseline:** `4e30d5f` (confirmed ancestor: `git merge-base --is-ancestor 4e30d5f HEAD` → true)

No secrets, credentials, or raw `.env` values appear anywhere in this document. Every environment
check below was performed with `grep -q`/boolean-shaped checks only — presence/absence, never content.

## 1. Commit lineage (4e30d5f..bc3c586, 20 commits)

```
bc3c586 fix(current-guard-variant-matrix): legacy-evidence reset for 3 lanes (72h->36h)
316b2fa fix(cortex-collection-status): delegate to the canonical activation function, don't reimplement it
f2fe6c3 fix(identity): replace staging FOUR_BRAIN_INSTANCE_ID override with explicit logical-role grants
b885a99 fix(current-guard-variant-matrix): pin maxHoldHours-at-open, close evidence-integrity gap
d55a335 test(current-guard-variant-matrix): prove Track C evidence-integrity gaps (maxHoldHours versioning)
66f8115 fix(canonical-market-regime): scheduler never registered on research (3101) — nested inside liveConfig.enabled
a4fe069 fix(execution): close infinite recursion between computeInnovationExposure and getStatus()
50bedb2 test: stop vitest re-executing live-execution-engine and causal-chain suites via cross-import
5350b9e fix(narrative-tags): exclude ACCOUNTING_INCOMPLETE baskets from the tilt report
500ffd1 fix(exposure): classify reconcileStaleReservations fills by executedQty first
4cf8beb test(cross-sectional): strengthen ACCOUNTING_INCOMPLETE coverage (no-false-positive + adversarial)
8745745 fix(cross-sectional): flag panic-flattened baskets ACCOUNTING_INCOMPLETE
b367210 fix(cross-sectional): classify reconcilePlannedLeg fills by executedQty first
6be71ae test(cross-sectional): add deferred live-tick reconciliation coverage
ddcc331 fix(cross-sectional): reconcile live-tick ambiguous leg failures before hedge/rollback
04e0f62 fix(execution): close innovation-campaign cap race with an atomic coordinator gate
4ef3ffb test(execution): cover regime escape-hatch hardening on the live instance (3103)
77e5ac3 fix(execution): hard-block regime escape hatches on the live instance (3103)
a01ac93 fix(execution): correct copyExternalIntent's reason string under a manual-mode regime block
ef221da test(execution): cover manual-directional canonical-regime enforcement fix
ed52073 fix(execution): close manual-directional canonical-regime bypass in canOpenNewEntries()
```

Six of these were found and fixed *during* this validation effort itself — real defects caught by
actually running the code and re-deriving claims from scratch, not by trusting prior doc comments:

1. **Infinite recursion** (`a4fe069`) between `computeInnovationExposure()` and `getStatus()` — broke
   `LiveExecutionEngine.reconcile()` on every tick by default on testnet. Confirmed live via a running
   staging instance's climbing `errorStreak`, reproduced with a stack trace, fixed with a non-recursive
   `getExposureSnapshot()` accessor.
2. **Canonical-regime scheduler silently never ran on research** (`66f8115`) — nested inside
   `if (liveConfig.enabled)`, false on research (3101) by design, despite its own doc comment claiming
   unconditional registration. Found by booting the real process and observing zero cycles over 25+
   real minutes; fixed by relocating the block.
3. **Evidence-integrity gap** (`d55a335` proves / `b885a99` fixes): no per-row pinning of
   `maxHoldHours`-at-open meant a config change silently re-clustered already-recorded rows' episode
   identity and never excluded transition-forced closes. Fixed with `openMaxHoldMs`, forward-only.
4. **Staging identity spoofing** (`f2fe6c3`): the only way to validate the causal pipeline on an
   isolated staging mirror was `FOUR_BRAIN_INSTANCE_ID=3101/3102` — making the resolver *lie* about
   which physical instance it was. Produced a real `data/lane-context/3101/` directory physically
   inside the 3111 deployment. Replaced with explicit `FOUR_BRAIN_LOGICAL_ROLE` grants; instanceId now
   always honest.
5. **Duplicate-logic drift** (`316b2fa`): `cortex-collection-status.ts` had its own independent
   reimplementation of the causal-activation gate, justified by a comment insisting "the two can never
   disagree" — they disagreed within the same session the moment (4) shipped. Deleted the duplicate;
   it now delegates to the canonical function.
6. **Legacy 72h→36h contamination** (`bc3c586`): 3 lanes changed `maxHoldHours` on 2026-08-04, before
   `openMaxHoldMs` existed — their entire pre-fix population would otherwise grandfather into current
   evidence forever. Added a narrow, named exclusion for exactly these 3 lanes.

## 2. Test commands and exact totals

Canonical command (repo root): `npm test`

| Run | Command | Result |
|---|---|---|
| Full suite, final | `npm test` | `@dtc/shared`: 101/101 passed. `@dtc/api`: **7356 passed, 3 skipped, 0 failed** (318/319 files; 1 skipped file pre-existing, unrelated) |
| Typecheck, every commit | `npx tsc --noEmit -p .` (in `apps/api`) | Clean, zero errors, at every commit above |

One transient failure (`paper-execution-router.test.ts`, a funding/candle-pagination cost assertion,
unrelated to any file touched this session) appeared once under full-suite load and passed cleanly
both standalone and on the very next full-suite re-run — treated as pre-existing environmental
flakiness, not a regression, and confirmed not to recur.

## 3. Mutation results

Every fix above was mutation-tested: the relevant guard condition was temporarily disabled/reverted
in place (never via `--no-verify` or similar), the intended test(s) confirmed to go red and *only*
those tests, then the source was restored and re-verified byte-identical against a pre-mutation backup
before the real commit was made. Summary:

| Fix | Mutation | Tests turned red | Other tests affected |
|---|---|---|---|
| Scheduler placement (`66f8115`) | Reproduced original `liveConfig.enabled` nesting | Exactly 1 new regression test | 0 of 20 others in file |
| Evidence-integrity / openMaxHoldMs (`b885a99`) | Disabled the new `isFreshValidObs` condition | Exactly 3 targeted tests | 0 of 154 others in file |
| Staging identity (`f2fe6c3`) | Disabled the role-grant branch in `resolveCausalCollectionActivation` | Exactly 3 authorization-dependent tests | 0 of 27 others in file |
| Legacy-evidence reset (`bc3c586`) | Emptied `EVIDENCE_RESET_CUTOVER_VARIANT_IDS` | Exactly 5 targeted tests | 0 of 161 others in file |

## 4. Staging instance identities

| Physical instance | Port | Logical role | PM2 name | Data directory |
|---|---|---|---|---|
| Research staging mirror | 3111 | `RESEARCH` (explicit `FOUR_BRAIN_LOGICAL_ROLE` grant) | `dtc-api-research-staging` | `/root/kronos-research-staging/` |
| Testnet staging mirror | 3112 | `TESTNET` (explicit `FOUR_BRAIN_LOGICAL_ROLE` grant) | `dtc-api-testnet-staging` | `/root/kronos-testnet-staging/` |

Both instances' `resolveFourBrainInstanceId()` reports their own honest physical port (`"3111"`,
`"3112"`) in every code path, every journal event, every provenance record — confirmed live via
`/api/shadow/cortex-collection-status` immediately after the `f2fe6c3`+`316b2fa` deploy:
```
3111: {"mode":"shadow","instanceId":"3111","logicalRole":"RESEARCH","status":"shadow-active", ...}
3112: {"mode":"shadow","instanceId":"3112","logicalRole":"TESTNET","status":"shadow-active", ...}
```
Two directories from the prior (spoofed-identity) period were archived, never deleted, for audit:
`data/lane-context/_archived-mislabeled-was-3101-actually-3111-2026-08-05/` (on 3111) and the parallel
`...-was-3102-actually-3112-...` (on 3112), plus the equivalent under `data/causal-experience/`.

## 5. Deployed RELEASE_SHA and file manifest

Both staging instances deployed at commit `316b2fa` (identity + duplicate-logic fixes) as of the last
verified restart; `bc3c586` (legacy-evidence reset) was validated locally with the full suite and is
ready for the same redeploy path before promotion. `RELEASE_SHA` on both instances confirmed via
direct `cat`, matching the intended commit exactly.

SHA256 file manifest (8 key files), computed independently from the git tree and both live staging
deployments — all three sources byte-identical for every file, at commit `b885a99` (re-verified after
each subsequent commit via the same procedure):

```
1f0b5e83704c6a4623d40bd2722690ff5ac9e6a74cde18df50c9295c0a9863da  apps/api/src/app.ts
93c559a8d44eafd94c68731ac691edbaccec267dd7a389d25e4176d22c2d4ac6  apps/api/src/lib/canonical-market-regime-scheduler.ts
1db97247d86b134b9efdd8ab6e46ac7a799beb537e870fb760dc4eb346e7a4d8  apps/api/src/lib/current-guard-variant-matrix.ts (pre-bc3c586 snapshot)
3db249b0936e08fe444f197c24134adc2693fa200944ee7b8f55ff7413f9f0cb  apps/api/src/lib/innovation-campaign.ts
7cdbe20ecca340dc217b91bba7cc15b45da20e5cc800cf4ff935af31e62c9028  apps/api/src/lib/single-symbol-lane-executor.ts
2f69710a364d91dab27656e1df01e94511a93c39a8742cef14a7da210043956e  apps/api/src/lib/cross-sectional-executor.ts
78cdb7576e5f71d97b265af21f4e1a83689a530b2d209f1fa9c6e88dbc2143c9  apps/api/src/experience-engine/forward-causal-collection.ts (pre-f2fe6c3 snapshot)
1b3ff8e19e3244e88708799b1267933afabd6542769295bbfa10c6ee7ccdfd83  apps/api/src/lib/account-exposure-coordinator.ts
```

## 6. Scheduler / causal / exposure health evidence

- **Canonical regime scheduler**: `data/canonical-market-regime-history.json` on both staging
  instances shows entries recorded on the documented 5-minute cadence, surviving multiple restarts
  (6 on 3111, 5 on 3112 across this session), `status: "VALID"`, `universeSize: 60` throughout.
- **Causal pipeline**: real (non-fabricated) `DECISION_SNAPSHOT`/`OPPORTUNITY_OPEN` pairs observed —
  85 total across both instances before the identity fix (archived), 16 new pairs on 3112 in the
  ~20 minutes since the identity-honest restart, 0 on 3111 (research places orders far less
  frequently). **Zero `OUTCOME_RESOLUTION` events on either instance** — no position has resolved
  within the observation window. Reported as-is; not fabricated, not forced. All real data validated
  against the actual compiled `readForwardCausalEventsStrict` reader: `status=VALID, malformed=0,
  duplicates=0` on every file checked.
- **Exposure coordinator**: `GET /api/live/status` on 3112 (the instance running a live engine):
  `health.errorStreak: 0, health.lastTickError: null`, `lastTickAt` current at every check —
  `reconcile()`, which calls into the exposure-coordinator-backed `computeExternalManagedNetQty`,
  ticking clean.
- **Campaign coordinator**: `GET /api/live/innovation-executors` on both: `configured: false, active:
  false` — safe default-off, HTTP 200, no crash.
- **CORTEX authority**: `CORTEX_LIVE_BETA` is a hardcoded source constant (`= 0`, not env-configurable
  — verified by reading `cortex-brain.ts:293`). `decideCortex`'s `blended = (1-beta)*staticPct +
  beta*learnedPct` algebraically zeroes the learned term at `beta=0`. Live `liveBeta: 0` confirmed on
  both staging instances via `/api/shadow/cortex-collection-status`.

## 7. Legacy-evidence reset — backup locations and counts

Immutable, read-only (`chmod 444`) backups taken from **active** 3101/3102 (`/root/kronos-releases/
72b9a1a/` and `/root/kronos-testnet-releases/72b9a1a/` respectively — both still on baseline commit
`72b9a1a` at backup time, not yet promoted) before any reset-related code reaches those instances:

- `/root/kronos-evidence-backups/2026-08-05-pre-legacy-reset/3101/current-guard-variant-matrix.json`
  — SHA256 `3de61bac281dea51a9f60396b194ad358173969bc182dec233c75b78a977016f`, byte-identical to the
  live source file at backup time (verified).
- `/root/kronos-evidence-backups/2026-08-05-pre-legacy-reset/3102/current-guard-variant-matrix.json`
  — SHA256 `33119d013c48c19d58144b36a31dc040ba9a9ad2a408b246689525b44928b82d`, byte-identical (verified).

Real, currently-contaminated row counts for the 3 reset lanes, read from these backups (never
estimated):

| Instance | Lane | Total rows | `isFreshValidObs`-eligible today (pre-reset) | Rows already carrying `openMaxHoldMs` |
|---|---|---|---|---|
| 3101 | CG_WIDE_FAST_LONG | 786 | 251 | 0 |
| 3101 | CG_BE_AFTER_05 | 758 | 524 | 0 |
| 3101 | BL_TREND_SCALEOUT_STOP200 | 809 | 270 | 0 |
| 3102 | CG_WIDE_FAST_LONG | 772 | 237 | 0 |
| 3102 | CG_BE_AFTER_05 | 742 | 499 | 0 |
| 3102 | BL_TREND_SCALEOUT_STOP200 | 800 | 261 | 0 |

`0` in the last column, universally, confirms these instances have never run any commit past
`72b9a1a` — none of this session's fixes (including `openMaxHoldMs` itself) have reached them yet. The
1045 (3101) / 997 (3102) currently-eligible rows above are exactly what `EVIDENCE_RESET_CUTOVER_
VARIANT_IDS` (`bc3c586`) will stop counting the moment that commit is promoted — none deleted, none
mutated, all still on disk for audit, simply excluded from current evidence until a genuinely new,
post-reset row (carrying a matching `openMaxHoldMs`) exists.

## 8. Active 3101/3102 state immediately before promotion

- Both running commit `72b9a1a` (`dtc-api` pid seen this session, `dtc-api-testnet` pid seen this
  session), restart counts stable (1 each) throughout this entire multi-session engagement — no
  crash-looping, no unexpected restarts.
- `LIVE_BINANCE_ENV=testnet` confirmed on both (boolean check only) — neither holds mainnet
  credentials.
- `current-guard-variant-matrix.json`: 17,621 observations (3101), 17,428 (3102) at backup time.

## 9. Confirmation: 3103 untouched

`dtc-api-live` PM2 restart count: **8378, unchanged**, checked repeatedly across this entire
engagement — first check through the most recent, immediately before this document was written.
Never restarted, never deployed to, never had its `.env`/config/data touched. No file under
`/root/kronos-live/` was written to at any point. Every deploy/redeploy/backup operation in this
document targeted only `/root/kronos-research-staging/`, `/root/kronos-testnet-staging/`, and (for
the read-only, immutable backups in §7) `/root/kronos-releases/` and `/root/kronos-testnet-releases/`.

## 10. Promotion execution (Task E) — completed

Commit `2c93a9c` (`bc3c586` + `docs` commit `2c93a9c` itself) promoted to both active instances via
new versioned release directories, mirroring the existing convention exactly:

- **3102 (testnet):** `/root/kronos-testnet-releases/2c93a9c/`. Structural diff against the prior
  active release (`72b9a1a`) showed only two differences, both benign: the new `RELEASE_SHA` marker
  file (intentional) and an absent `apps/api/dist/` (unused — the server runs via `tsx` directly
  against `src/`, never `dist/`, confirmed by `deploy/run-api.sh`'s own content). `.env` byte-identical
  (SHA256 match) to the prior release. Both `data` symlinks (top-level and `apps/api/data`) point to
  the exact same stable anchor (`128b09f`) the prior release used — verified via `readlink`, not
  assumed. `node_modules` entry count matches exactly (120=120); workspace symlinks inside it are
  relative (`../../packages/shared` etc.), so copying the directory into a new release path resolves
  correctly without edits. Typechecked clean in place (`npx tsc --noEmit`) before any restart.
  Promoted via `pm2 delete dtc-api-testnet && pm2 start <new-run-api.sh> --name dtc-api-testnet`.
- **3101 (research):** identical procedure, `/root/kronos-releases/2c93a9c/`. Same verification
  results (`.env` hash match, symlink match, node_modules 120=120, clean typecheck).

**Post-promotion verification, both instances:**
- Health: `GET /api/health` → 200 on both.
- No new error-log entries after restart (last pre-restart entries dated 2026-08-04).
- `GET /api/shadow/cortex-collection-status`: `instanceId` reports the instance's own honest physical
  port (`"3101"`/`"3102"`) with `logicalRole: null` (direct allowlist match, no role grant needed —
  correct for real production instances), `status: "shadow-active"`, existing journal found and
  validated clean (`journalBadLines: 0`).
- File hashes for 4 key files (`app.ts`, `current-guard-variant-matrix.ts`,
  `forward-causal-collection.ts`, `four-brain-live-gather-bindings.ts`) — byte-identical between the
  two promoted releases, and `RELEASE_SHA` on both reads `2c93a9cd226ad6834b9b55cf9434549d0daf0c59`.
  `app.ts`'s hash also matches the value recorded in §5 for the pre-promotion staging snapshot at
  `b885a99` — expected and correct, since no later commit touched that file.
- **Legacy-evidence reset verified against REAL production data, not a test fixture**: ran
  `buildCurrentGuardVariantMatrixReport` directly (via `tsx`, the exact code path the server itself
  uses) against the live store on each freshly-promoted instance.
  - `CG_WIDE_FAST_LONG`, `CG_BE_AFTER_05`, `BL_TREND_SCALEOUT_STOP200`: **freshValid = 0** on both
    3101 and 3102 — down from the pre-promotion contaminated counts in §7 (251/524/270 and
    237/499/261). Confirms the reset is genuinely active and reading real data, not a no-op.
  - Control (`CG_WIDE_STOP_TP_WIDE`, not in the reset set), checked on 3102: **freshValid = 16** —
    confirms the reset is narrowly scoped, not a blanket change to evidence handling.

`dtc-api-live` restart count throughout this entire promotion sequence: **8378, unchanged** (checked
immediately before and after each of the two restarts above).

## 11. Final audit (Task F)

Re-checked every consumer this session's commits touch against each named risk:

| Risk | Finding | Evidence |
|---|---|---|
| Legacy-row leakage | Closed | §10 — real 0-count confirmed on live production data for all 3 reset lanes |
| Identity confusion | Closed | §10 — `instanceId` honest on both promoted instances; the 3111/3112 spoofing that caused it is gone (§4) |
| Authority bypass | Closed | `CORTEX_LIVE_BETA` hardcoded `=0` (not env-configurable); campaigns confirmed `configured:false` live on all 4 instances checked this session |
| Episode inflation | Closed | The `openMaxHoldMs` mechanism (§1, commit `b885a99`) is the direct fix for this exact failure mode |
| ACCOUNTING_INCOMPLETE inclusion | Confirmed still excluded | `narrative-tags.ts:156` — `b.accountingStatus !== "ACCOUNTING_INCOMPLETE"`, unchanged by any commit this session |
| Stale reservations | Covered | `account-exposure-coordinator.test.ts` + integration suite, 78/78 passing fresh this session |
| Any 3103 path | No new bypass | Exhaustive grep for every literal `"3103"` across all 5 files this session modified — every occurrence is a blocking check, checked first/unconditionally; the one pre-existing narrow exception (`lane-context-journal-binding.ts`'s `COLLECT_ONLY` report-only carve-out) predates this session and grants no trading authority (`COLLECT_ONLY=true ⇒ REPORT_ONLY`, journaling only) |

## 12. Status at time of writing

All of A-F complete. Verdict: **`KRONOS_ACTIVE_RESEARCH_TESTNET_PROMOTION_READY`**.

# Daily Range V3 completion deployment report

Status: **PRE-DEPLOY — DO NOT TREAT AS CUTOVER EVIDENCE**  
Prepared: 2026-08-27 Asia/Taipei

## Release scope

This release is limited to completed V3 observability, immutable friction provenance, strict environment isolation, explicit post-fill error attribution, BBO/feature freshness metadata, selector-artifact lifecycle/gates, shadow-only reconstructed-candle research tooling, and contract-price MFE/MAE path measurement.

It does not change:

- `AUTO_ROUTE_NY_V2`, Continuation, Fade, structural stop, exact 2R TP, no-EOD behavior, or native brackets;
- Daily C1–C6 pool logic, cap, allocator semantics, or entry-time ownership;
- Cross MOM36, Cross universe, Cross sizing, Cross exits, or Cross continuation lifecycle.

## Pre-cutover runtime snapshot

| Environment | PM2 process | active release | entry state | Daily opens | reservations | allocator | alpha |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| Testnet | `dtc-api-testnet` | `daily-range-v3-econ-cohort-559224e-20260827T050952Z` | enabled | 2 | 0 | `ECONOMIC_QUALITY_BASELINE` | `SHADOW_ONLY` |
| Live | `dtc-api-live` | `daily-range-v3-econ-cohort-559224e-20260827T050952Z` | enabled | 0 | 0 | `ECONOMIC_QUALITY_BASELINE` | `SHADOW_ONLY` |

Testnet existing positions are `OPUSDT` legacy and `FILUSDT` V2, with durable quantity/entry/native stop/TP identities captured before cutover. Live had no Daily open positions at the snapshot. Required-env checks passed: 48 Testnet keys and 56 Live keys.

## Testnet cutover checklist

- [ ] Archive built from one committed source revision.
- [ ] Testnet shared `apps/api/data` symlink points to the canonical durable Testnet ledger.
- [ ] `.env` copied from incumbent and `apply-required-env.sh --check .env 3102` passes.
- [ ] `RUN_API_PRECHECK_ONLY=1` passes before PM2 replacement.
- [ ] Old/new Daily positions and native IDs reconcile exactly.
- [ ] API health, artifact fallback/status, MFE/MAE stream health, no reservations, and Cross fingerprints check clean.

## Live cutover checklist

- [ ] New Daily entries paused only; existing protection remains untouched.
- [ ] Live durable `apps/api/data` symlink and 3103 env check pass.
- [ ] Testnet post-cutover validation is clean.
- [ ] Existing Daily/Cross positions and native orders reconcile exactly.
- [ ] Previous Live entry-enabled state restored only after healthy reconciliation.
- [ ] Alpha remains `SHADOW_ONLY` / no execution authority.

## Rollback

The incumbent release directories remain intact. A rollback switches only the affected PM2 API process back to its previous `deploy/run-api.sh` after confirming the same durable data link and required environment. No position state, order, native bracket, or Cross configuration is rolled back by copying source code.

## Post-cutover evidence

To be filled after Testnet then Live deployment. This section must include exact release names/commit, PM2 process health, API status, old/new position/native-order comparison, artifact status, selector mode, and any rollback decision.

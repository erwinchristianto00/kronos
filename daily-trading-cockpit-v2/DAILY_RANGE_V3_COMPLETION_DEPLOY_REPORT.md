# Daily Range V3 completion deployment report

Status: **DEPLOYED — TESTNET AND LIVE VALIDATED**
Prepared and completed: 2026-08-27 Asia/Taipei

## Release scope

This release is limited to completed V3 observability, immutable friction provenance, strict environment isolation, explicit post-fill error attribution, BBO/feature freshness metadata, selector-artifact lifecycle/gates, shadow-only reconstructed-candle research tooling, and contract-price MFE/MAE path measurement.

It does not change:

- `AUTO_ROUTE_NY_V2`, Continuation, Fade, structural stop, exact 2R TP, no-EOD behavior, or native brackets;
- Daily C1–C6 pool logic, cap, allocator semantics, or entry-time ownership;
- Cross MOM36, Cross universe, Cross sizing, Cross exits, or Cross continuation lifecycle.

## Pre-cutover runtime snapshot

| Environment | PM2 process | active release | entry state | Daily opens | reservations | allocator | alpha |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| Testnet | `dtc-api-testnet` | `daily-range-v3-econ-cohort-559224e-20260827T050952Z` | enabled | 1 | 0 | `ECONOMIC_QUALITY_BASELINE` | `SHADOW_ONLY` |
| Live | `dtc-api-live` | `daily-range-v3-econ-cohort-559224e-20260827T050952Z` | enabled | 0 | 0 | `ECONOMIC_QUALITY_BASELINE` | `SHADOW_ONLY` |

Testnet had one Daily `OPUSDT` legacy position, with durable quantity/entry/native stop/TP identities captured before cutover. Live had no Daily open positions at the snapshot. Required-env checks passed: 48 Testnet keys and 56 Live keys.

## Testnet cutover checklist

- [x] Archive built from `b07dcd2` (source implementation `da3b6cc7c87281011e79ce0fb99c212db0cf864d`).
- [x] Testnet shared `apps/api/data` symlink points to the canonical durable Testnet ledger.
- [x] `.env` copied from incumbent and `apply-required-env.sh --check .env 3102` passes.
- [x] `RUN_API_PRECHECK_ONLY=1` passes before PM2 replacement.
- [x] Old/new Daily positions and native IDs reconcile exactly.
- [x] API health, artifact fallback/status, MFE/MAE stream health, no reservations, and Cross fingerprints check clean.

## Live cutover checklist

- [x] New Daily entries paused only; existing protection remains untouched.
- [x] Live durable `apps/api/data` symlink and 3103 env check pass.
- [x] Testnet post-cutover validation is clean.
- [x] Existing Daily/Cross positions and native orders reconcile exactly.
- [x] Previous Live entry-enabled state restored only after healthy reconciliation.
- [x] Alpha remains `SHADOW_ONLY` / no execution authority.

## Rollback

The incumbent release directories remain intact. A rollback switches only the affected PM2 API process back to its previous `deploy/run-api.sh` after confirming the same durable data link and required environment. No position state, order, native bracket, or Cross configuration is rolled back by copying source code.

## Post-cutover evidence

Both processes now run:

```text
daily-range-v3-completion-b07dcd2-20260827T072000Z
source implementation: da3b6cc7c87281011e79ce0fb99c212db0cf864d
```

The deployment used one PM2 process replacement per environment. Daily entries were briefly disarmed during each replacement and restored only after reconciliation; Cross was never paused, closed, resized, or reconfigured.

| Environment | Cutover / re-arm | PM2 post-check | Daily state after re-arm | Reservations | Effective allocator | Alpha authority |
| --- | --- | --- | --- | ---: | --- | --- |
| Testnet | disarm 15:28:49, re-arm 15:32:29 Taipei | `dtc-api-testnet` online, restart 0 | `ARMED`, entry enabled | 0 | `ECONOMIC_QUALITY_BASELINE` | `false` |
| Live | disarm 15:35:06, re-arm 15:37:55 Taipei | `dtc-api-live` online, restart 0 | `ARMED`, entry enabled | 0 | `ECONOMIC_QUALITY_BASELINE` | `false` |

### Position and order preservation

- Testnet's pre-existing Daily `OPUSDT` short remains `OPEN`, quantity `242.2`, entry `0.1032`. A direct authenticated exchange read confirmed its two original native algo orders are still `NEW`: TP `1000000181100801` (`TAKE_PROFIT_MARKET`, buy 242.2 at 0.0952) and SL `1000000181100800` (`STOP_MARKET`, buy 242.2 at 0.1072). There are no pending reservations or reconciliation error.
- Testnet Cross remains one complete six-leg basket: `WIFUSDT`/`SOLUSDT` long; `SUIUSDT`/`1000PEPEUSDT`/`ARBUSDT`/`XRPUSDT` short, with the same quantities and entry prices as before cutover.
- Live retains exactly one complete six-leg Cross basket: `WIFUSDT`, `SOLUSDT`, `WLDUSDT` long; `OPUSDT`, `SUIUSDT`, `LDOUSDT` short. Post-cutover exchange snapshot reports exactly these six Cross-owned positions, unchanged in direction, quantity, entry price, and ownership. Live Daily remains empty, with no reservation.

### Friction, path, and selector evidence

| Environment | New frozen friction artifact | Ledger N | Formula/version | Path stream | Selector registry |
| --- | --- | ---: | --- | --- | --- |
| Testnet | `daily-friction-v1-20260827072500-19663d6d340a` | 43 | `daily-loss-friction-decomposition-v1` | `DAILY_RANGE_PATH_STREAM_OPEN`, 50 subscribed symbols | `daily-range-rcpit-f84b16b3`, `REJECTED` |
| Live | `daily-friction-v1-20260827073500-70470f6332b9` | 28 | `daily-loss-friction-decomposition-v1` | `DAILY_RANGE_PATH_STREAM_OPEN`, 51 subscribed symbols | `daily-range-rcpit-f84b16b3`, `REJECTED` |

Both artifacts explicitly report `ENTRY_FEE_P95 + EXIT_FEE_P95 + 1.25 * LOSS_PATH_ALL_IN_ADVERSE_P95` and their own environment. The Testnet `OPUSDT` path is correctly labelled `INCOMPLETE`: its entry predates the newly started observer, while new post-cutover stream observations are arriving. It was not relabelled as an exact path.

The registry file is identical in content hash in the two environment-specific locations, but its status is `REJECTED`, historical gate is `FAIL`, Testnet parity and operator approval are pending/not approved, and `executionAuthority=false`. It is observability metadata only; it cannot change allocation.

### Validation and rollback

- Targeted Daily tests: 6 files / 61 tests passed. API and web production builds passed on both staged releases. The web bundle warning (>500 kB) is unchanged and non-blocking.
- Full API suite: 8,234 passed, 11 unrelated pre-existing failures, 3 skipped. Daily and Cross target suites passed; the source diff contains no Cross strategy/config file changes.
- One fully observed Live scheduler cycle after re-arm completed with `lastError: null`; no `TICK_FAILED`, pool-refresh failure, post-fill failure, orphan, Daily entry, or Cross change was observed.
- No rollback was required. The prior Testnet and Live release directories, previous PM2 scripts, and previous web targets remain available for a release-only rollback against the same durable ledger.

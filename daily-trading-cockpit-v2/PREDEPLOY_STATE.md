# Dynamic MOM36 Shock 36H — Pre-deploy state

Captured 2026-08-25 20:30 Asia/Taipei before the final architecture verification/cutover.
No API credentials, secrets, or private order identifiers are recorded here.

## Source and rollback baseline

- Worktree: `feat/dynamic-mom36-shock-36h-v1`
- Source commit: `933b3a08ae04474663a763723cb00ce6f0ce50cd`
- Worktree status at capture: clean
- Active TESTNET runner: `/root/kronos-testnet-releases/dynamic-mom36-shock-36h-v1-933b3a08ae04-20260825T121100Z/daily-trading-cockpit-v2/deploy/run-api.sh`
- Active LIVE runner: `/root/kronos-live-releases/dynamic-mom36-shock-36h-v1-933b3a08ae04-20260825T121500Z/daily-trading-cockpit-v2/deploy/run-api.sh`
- PM2: exactly one `dtc-api-testnet` and one `dtc-api-live`, both online, each with restart count `0`.

## Shared policy at capture

- Strategy: `dynamic-mom36-shock-36h-v1`
- Source/git hash: `933b3a08ae04474663a763723cb00ce6f0ce50cd`
- Config hash: `xsec-config-6900563a5fba8626`
- Model artifact: `NO_FROZEN_RUNTIME_SHOCK_MAPPING`
- Shock behavior: `NO_EDGE` fallback; optional overlay is not an admission blocker.
- Entry: six equal `$25` legs, `1x`, max one open basket.
- Exit: no ordinary TP, stop, MFE giveback, or context invalidation; 36-hour horizon and existing exceptional/manual safety paths only.

## TESTNET state

- Health: `200 { ok: true }`; signed USD-M account snapshot fresh and not stale.
- Dynamic runtime: `ARMED`; no Dynamic basket can form while the retained legacy basket occupies the single slot.
- Existing frozen basket: `xb-mt6yf1ze-ltered`, `FILTERED`, `COMPLETE`, six planned/six actual legs. It has no Dynamic policy fingerprint and must remain governed by its legacy contract.
- Exchange positions reconcile to its six legs: `TAOUSDT`, `SEIUSDT`, `SUIUSDT`, `INJUSDT`, `NEARUSDT`, `ARBUSDT`.
- Unresolved orphan legs: none. Pending cross-basket orders: none.

## LIVE state

- Health: `200 { ok: true }`; USD-M account snapshot fresh and not stale.
- Dynamic runtime: `ARMED`.
- Existing frozen basket: `xb-mt8m8mo7-6shock`, `DYNAMIC_MOM36_SHOCK`, `COMPLETE`, six planned/six actual legs.
- Frozen horizon: `1787789927972` ms.
- Frozen strategy fingerprint: `dynamic-mom36-shock-36h-v1`, source/git `933b3a08ae04474663a763723cb00ce6f0ce50cd`, config `xsec-config-6900563a5fba8626`, artifact `NO_FROZEN_RUNTIME_SHOCK_MAPPING`.
- Exchange positions reconcile one-for-one to its six legs: long `INJUSDT`, `SOLUSDT`, `FETUSDT`; short `AAVEUSDT`, `ARBUSDT`, `SUIUSDT`.
- Unresolved orphan legs: none. Pending cross-basket orders: none.

## Rollback invariant

Any rollback must leave the active Dynamic release code available until `xb-mt8m8mo7-6shock` is closed, or dispatch its already-frozen strategy version identically. No rollback may reclassify, resize, or change the exit contract of either open basket.

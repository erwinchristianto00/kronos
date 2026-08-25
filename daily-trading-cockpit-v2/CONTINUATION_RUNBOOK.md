# Continuation Lifecycle Runbook

## Normal health

Read-only views:

```text
/testnet/api/live/cross-sectional/continuation-lifecycle/status
/live/api/live/cross-sectional/continuation-lifecycle/status
/testnet/api/live/cross-sectional/continuation-lifecycle/model
/live/api/live/cross-sectional/continuation-lifecycle/model
```

Expected first deployment state is:

```text
runtime artifact: REGISTRY_CURRENT, matching pinned V4 SHA
collector: required Binance 1m/5m/1h healthy after first reconciliation
lifecycle: idle or waiting for the 7-day / 168-mature-row eligibility rule
last challenger: none or REJECTED
```

This is healthy. No scheduled promotion is required.

## Service management

Only one canonical service pair runs, from the dedicated continuation release:

```text
pm2 status kronos-continuation-collector kronos-continuation-lifecycle
pm2 logs kronos-continuation-collector --lines 100
pm2 logs kronos-continuation-lifecycle --lines 100
```

The collector is lower priority; the lifecycle is `nice 19` plus idle I/O priority and the trainer
uses two LightGBM threads. It checks one-minute load, free RAM and disk before work. If unsafe it
records `SKIPPED`; do not restart it merely to force a training run under pressure.

## Safe operator controls

The API control endpoint is loopback-only and only queues a command for the lifecycle owner. It
never trains or edits a pointer in the API request itself. Commands are `PAUSE_TRAINING`,
`RESUME_TRAINING`, `INTEGRITY_CHECK`, `TRAIN_CHALLENGER`, `DISABLE_AUTO_PROMOTION`,
`ENABLE_AUTO_PROMOTION` and `ROLLBACK_CHAMPION`.

`TRAIN_CHALLENGER` does **not** bypass data, cadence, resource or promotion gates. `ROLLBACK`
requires a valid immutable previous record and affects future formations only.

## Incident handling

| Condition | Expected automatic behavior | Operator action |
| --- | --- | --- |
| optional source outage | continue collector recovery; missing source stays explicit | inspect health, do not fabricate backfill |
| required source stale/gapped | skip training; base basket policy is unchanged | wait for REST repair, inspect collector logs |
| matrix/trainer crash | failed run, pointer unchanged | inspect run directory/log then fix code/data |
| current artifact corrupt | runtime reads previous; lifecycle performs operational rollback when possible | confirm status pointer and preserve corrupted bytes for audit |
| host under pressure | no training starts | free capacity; lifecycle retries next tick |
| rejected challenger | immutable rejected artifact + history retained | no action; this is normal |

Never reset cross-sectional executor state, close/open a basket, modify an exit, or alter strategy
environment flags as part of continuation service recovery.

## Deploy/cutover sequence

1. Create the canonical lifecycle release; do not touch an API process yet.
2. Run the explicit bootstrap with the verified active V4 artifact and legacy source root. It copies
   rather than moves data and aborts on a hash mismatch.
3. Start and verify the new collector. Confirm fresh required watermark health.
4. Start lifecycle service. Confirm registry current SHA and no immediate uncontrolled retrain.
5. Deploy the same API release to TESTNET and LIVE with
   `CONTINUATION_LIFECYCLE_ROOT=/root/kronos-continuation`; run required-env check on 3102/3103.
6. Confirm both runtime status endpoints report the same `REGISTRY_CURRENT` artifact.
7. Only then stop legacy `kronos-collector` / `kronos-lifecycle` shadow services.

Rollback is API release rollback plus retaining the shared registry. If a registry issue is
suspected, the runtime bootstrap SHA remains an independent safe fallback; do not delete registry
data or raw history.

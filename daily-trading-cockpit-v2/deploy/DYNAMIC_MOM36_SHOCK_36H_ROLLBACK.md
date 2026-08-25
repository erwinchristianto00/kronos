# Dynamic MOM36 Shock 36h — rollback contract

This release is strategy-versioned.  A basket whose `strategyVersion` is
`dynamic-mom36-shock-36h-v1` must remain on this release until it is closed:
the prior release does not own its safety-only/actual-fill 36-hour exit
contract.

## Pre-cutover rollback targets

- TESTNET: `/root/kronos-testnet-releases/mom36-side-trend-align-20260823T034343Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh`
- LIVE: `/root/kronos-live-releases/mom36-side-trend-align-20260823T032846Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh`

## Guard before rollback

Run the status endpoint on the target host.  If a Dynamic basket is open, do
not roll back that environment.  Keep the Dynamic release online until its
36-hour horizon or use the scoped operator close endpoint; it pauses new
admissions before closing only that basket.

```bash
curl -fsS http://127.0.0.1:3102/api/live/cross-sectional-executor
curl -fsS http://127.0.0.1:3103/api/live/cross-sectional-executor
```

Confirm that `dynamicMom36Status.openBasketId` is `null` before using either
command below.  The commands only replace the named PM2 process; they do not
touch the persistent `apps/api/data` symlink or exchange positions.

## Minimal rollback commands

```bash
pm2 delete dtc-api-testnet && pm2 start /root/kronos-testnet-releases/mom36-side-trend-align-20260823T034343Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh --name dtc-api-testnet --interpreter bash && pm2 save --force
```

```bash
pm2 delete dtc-api-live && pm2 start /root/kronos-live-releases/mom36-side-trend-align-20260823T032846Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh --name dtc-api-live --interpreter bash && pm2 save --force
```

After either rollback, verify exactly one named process is online and re-read
the executor status before allowing new entries.

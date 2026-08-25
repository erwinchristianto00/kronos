# Kronos Dynamic MOM36 Shock 36h — pre-deploy state

Captured at: `2026-08-25T09:52:22Z` (`2026-08-25 17:52:22 Asia/Taipei`)

This is a read-only snapshot taken before implementation or any TESTNET/LIVE cutover.

## Source / rollback baseline

- Local clean implementation worktree base: `7b454f640296b06bec2922dd0d2738eddc27eb0c` (`fix(xsec): prevent phantom maker entry fills`).
- Existing TESTNET release script: `/root/kronos-testnet-releases/mom36-side-trend-align-20260823T034343Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh`.
- Existing LIVE release script: `/root/kronos-live-releases/mom36-side-trend-align-20260823T032846Z/kronos/daily-trading-cockpit-v2/deploy/run-api.sh`.
- Existing strategy version: `full-tp6-entry-integrity-v1`.
- Existing source SHA reported by both executor APIs: `7b454f640296b06bec2922dd0d2738eddc27eb0c`.

## PM2/service state

| Environment | Process | Port | PID | Status | Restarts |
|---|---|---:|---:|---|---:|
| TESTNET | `dtc-api-testnet` | 3102 | 3391032 | online | 15 |
| LIVE | `dtc-api-live` | 3103 | 3391060 | online | 22 |

No duplicate named TESTNET/LIVE API process was present at capture time.

## Existing policy state

Both environments reported the old FILTERED / `PLAIN_MOM36` policy:

- `legUsd=25`, `leverage=3`, `maxOpenBaskets=1`, `maxHoldHours=36`.
- Ordinary TP enabled at `6%`; ordinary stop disabled; adaptive exit disabled.
- Policy IDs: TESTNET `xsec-b66fb26c1fef4916`; LIVE `xsec-6064cb8a6bac7ef4`.

## TESTNET exchange and basket state

- Account reconciliation: `ok=true`; 6 open positions; 0 open orders.
- Wallet `4990.18511582 USDT`; equity `4992.82418750 USDT`; available `4941.34423191 USDT`.
- Executor has one open basket: `xb-mt6yf1ze-ltered`, `FILTERED`, opened `2026-08-24T08:08:46.209Z`, old policy ID `xsec-b66fb26c1fef4916`.
- Existing frozen legs:
  - LONG `INJUSDT 6.4 @ 5.356`, `TAOUSDT 0.088 @ 234.9`, `NEARUSDT 11 @ 1.992`.
  - SHORT `SEIUSDT 620 @ 0.0466`, `SUIUSDT 35.4 @ 0.8168`, `ARBUSDT 174.3 @ 0.0989`.
- Orphaned legs: `0`; pending orders: `0`; executor `lastError=null`.
- Historical incident markers retained for audit: `2` accounting-incomplete baskets and `1` margin-call basket. They are not an open exposure.

## LIVE exchange and basket state

- Account reconciliation: `ok=true`; 0 open positions; 0 open orders; no open basket.
- Wallet/equity `281.75791144 USDT`; available `281.70156545 USDT`; unrealized PnL `0`.
- Orphaned legs: `0`; accounting-incomplete baskets: `0`; margin-call baskets: `0`; executor `lastError=null`.

## Deployment invariants derived from this snapshot

1. The TESTNET basket above must remain governed by its old frozen TP-enabled policy and keep its exact six legs.
2. The new policy may only govern baskets created after deployment and must use `25 USDT / leg`, `1x`, six legs, and `MAX_OPEN_BASKETS=1`.
3. Rollback must keep the new strategy-versioned exit dispatcher available until any new basket is closed.
4. The only intended PM2 replacements are `dtc-api-testnet` and `dtc-api-live`; staging and unrelated processes are out of scope.

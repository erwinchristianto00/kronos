# Daily Range 4H — Live pre-deploy audit

## Scope and non-goals

This prepares the existing `daily-4h-range-acceptance-2r-v1` lane for **future
Live signals only**. It does not copy, resize, reverse, or otherwise touch
open Testnet Daily Range trades. A position opened on Testnet has neither a
safe Live entry price nor a Live ownership record, so copying it mid-trade is
explicitly out of scope.

The strategy remains independent from Dynamic MOM36:

1. Freeze the completed 00:00–04:00 UTC 4H range.
2. Require two completed 5M closes outside that range (acceptance).
3. Enter 25 USDT notional at 1x only while the Daily Range entry window is
   open.
4. Install exchange-native structural stop and fixed 2R take-profit brackets.

## Live integration

Live has its own state and pool files:

- `daily-4h-range-acceptance-2r-v1-mainnet.json`
- `daily-range-auto-pool-mainnet.json`

They are deliberately separate from Testnet. The Live lane shares only the
public C1–C6 USD-M universe rules and retains its own daily frozen snapshot.

Before a Daily Range order is sent, all of the following must pass:

| Guard | What it protects |
| --- | --- |
| Dedicated execution flag + confirmation | The incumbent `LIVE_MAINNET_CONFIRM` cannot silently authorize this new lane. |
| Dedicated canary and arm flags | A real canary and later arming need separate operator actions. |
| Positive open-trade and gross-notional caps | The lane cannot use available balance as an implicit risk limit. |
| Account-health gate | Account disarm, kill switch, drain, or transport cooldown blocks the lane too. |
| Shared ownership/entry lease | It cannot net into an existing basket, single-symbol, or Daily Range claim. |
| One-way reconciliation | Hedge mode, uncertain ownership, or mismatched quantity fails closed. |
| Account kill switch | Uses only exact, lane-owned reduce-only exits; it never blanket-flattens symbols. |

The gross cap reserves the full 25 USDT before exchange submission, so two
same-tick confirmations cannot race past the selected cap.

## Initial deployment posture

The required Live environment is intentionally observation-only:

```ini
DAILY_RANGE_MAINNET_EXECUTION_ENABLED=0
DAILY_RANGE_MAINNET_CONFIRM=
DAILY_RANGE_MAINNET_CANARY_ENABLED=0
DAILY_RANGE_MAINNET_ARM_ENABLED=0
DAILY_RANGE_MAINNET_MAX_OPEN_TRADES=0
DAILY_RANGE_MAINNET_MAX_GROSS_NOTIONAL_USD=0
```

With these values the process may collect a pool snapshot and expose status,
but it cannot run a canary, arm, or submit a signal—even if a stale state file
claims `ARMED`.

## Explicit activation sequence (not performed by this preparation)

1. Re-snapshot Live positions, orders, algo orders, one-way mode, and account
   safety state.
2. Choose and deploy an explicit `maxOpenTrades` and
   `maxGrossNotionalUsd`; no cap is selected implicitly by this change.
3. Enable only the dedicated Daily Range execution, confirmation, cap, and
   canary controls.
4. Run one real 25-USDT Live canary and require proof of entry, native SL/TP,
   sibling cancellation, flat position, and no orphan order.
5. Enable the separate arm control and arm the lane through its local Live
   endpoint.
6. Verify the first production entry has a Daily Range ownership record,
   exact exchange quantity, and both native brackets.

At every step, existing Dynamic MOM36 baskets and positions must be identical
before and after the Daily Range operation. Any unexpected symbol, quantity,
or orphan order blocks activation and triggers rollback to observation-only.

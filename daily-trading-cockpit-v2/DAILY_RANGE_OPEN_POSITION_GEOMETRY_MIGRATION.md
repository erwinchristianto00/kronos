# Daily Range — Open Position Geometry Migration

## Scope

This one-time migration applies only to open `DAILY_4H_RANGE_ACCEPTANCE`
records.  It never changes Cross-sectional baskets, directional positions,
single-symbol positions, friction, allocator ranking, or native bracket levels
on a passing position.

## Evaluation

For each open Daily Range position, the migration uses frozen actual entry,
structural stop, and native 2R target.  It reconstructs ATR14 from the
completed 4h history available at the original decision timestamp.

| Result | Action |
| --- | --- |
| Absolute stop/target and ATR reachability pass | Keep exact entry, SL, TP and native order IDs. |
| Stop > 3% or target > 6% | Controlled owned flatten, even if historic ATR is unavailable. |
| Absolute pass but original ATR cannot be reconstructed | Keep the position and persist `OPEN_POSITION_ATR_MIGRATION_UNKNOWN`. |
| Foreign/Cross ownership is reported | Block the migration; never net or close another lane. |

## Controlled flatten contract

The lane first validates exchange quantity and direction against the durable
Daily ownership record.  It retains the native SL/TP while it submits an
exact-quantity reduce-only MARKET order, proves exchange flatness, cancels only
the two owned native siblings, settles the fill ledger, releases the Daily
lease/reservation, and then reconciles again.  An unknown or rejected close
retains protection and remains explicitly pending; it never retries blindly.

## Explicit Testnet OPUSDT action

The currently open Testnet `OPUSDT` Daily Range position is an explicit
operator-requested close with reason
`OPERATOR_REQUESTED_CLOSE_GEOMETRY_PATCH`.  It is attempted only after the
environment, Daily ownership, exact exchange quantity, and absence of foreign
Cross ownership have been verified.  A conflict records
`OPUSDT_OWNERSHIP_CONFLICT` and performs no close.

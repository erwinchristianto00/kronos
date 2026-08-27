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

## Executed result — 2026-08-27 UTC

Ownership was re-read immediately before the migration. Testnet `OPUSDT` was
solely `DAILY_4H_RANGE_ACCEPTANCE`, while Live `OPUSDT` was solely
`CROSS_SECTIONAL_MARKET_NEUTRAL`; the Live Cross position was not touched.

- Testnet `OPUSDT`: 242.2 short closed at 0.0974, fill `326369120`, reason
  `OPERATOR_REQUESTED_CLOSE_GEOMETRY_PATCH`; exchange position became zero.
- Testnet `BMTUSDT`: 238 long closed at 0.02152, fill `160269289`, because
  actual stop 4.948% and target 9.896% exceeded the absolute guards.
- Testnet `XMRUSDT`: retained unchanged; 0.546% stop, 1.092% target, 0.469 ×
  entry-time completed-4h ATR. Its unchanged native TP subsequently filled at
  453.71 (`TAKE_PROFIT`, `+1.939R`), after the migration had completed.
- Live `BMTUSDT`: 238 long closed at 0.02166, fill `1489879806`, because
  actual stop 4.825% and target 9.650% exceeded the absolute guards.
- Live `1000BONKUSDT` and `TRUMPUSDT`: retained unchanged with their original
  native bracket identifiers. Their target/ATR multiples were 1.040 and 0.757
  respectively.

Every retained row reports a clean post-migration reconciliation; both
environments finished with zero pending Daily reservations.

## Post-migration admission proof

After the one-time migration, both lanes accepted fresh Daily entries under the
same immutable gate. A later status check at `2026-08-27T11:11Z` found three
open passing rows in Testnet and three in Live, all with geometry snapshots and
both native bracket IDs. These are post-migration entries, not legacy rows;
they require no migration action and demonstrate that the new guard does not
block valid geometry.

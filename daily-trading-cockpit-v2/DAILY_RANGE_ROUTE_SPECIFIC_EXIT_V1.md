# Daily Range Route-Specific Exit V1

## Scope

`daily-route-exit-v1` is a narrow exit-policy delta on top of the deployed
Daily Range V3 + `daily-trade-geometry-v1` baseline. It applies only to a
new `AUTO_ROUTE_NY_V2` signal after its second, clean, completed five-minute
confirmation bar. It does not change the router, reference range, C1-C6
universe, structural-stop formula, geometry maxima, ATR reachability,
friction model, risk sizing, allocator, alpha authority, ownership, native
protection, or any Cross lane.

## Frozen policy at entry

Every new trade persists a `DailyRangeRouteExitPolicySnapshot` before entry:

| Route | Native TP | Hard protection | Logical invalidation |
| --- | --- | --- | --- |
| `CONTINUATION` | `1.0R` | Existing frozen structural stop | A completed 5m close is canonically `INSIDE` the frozen reference range. |
| `FADE` | `2.0R` | Existing frozen structural stop | A completed 5m close is back outside the frozen original-breakout boundary in the original breakout direction. |

The snapshot contains `exitPolicyId`, route, TP multiple, invalidation type,
effective timestamp, original breakout direction/boundary, and both reference
range boundaries. Equality at a boundary is `INSIDE`, by the same exported
helper used by `AUTO_ROUTE_NY_V2`; there is no second definition of range
membership.

Existing positions whose records lack this snapshot stay on their previous
bracket, order IDs, TP multiple, and no logical-exit watcher. No deployment
recreates or alters an old bracket.

## Exit order and race handling

Native Binance `STOP_MARKET` and `TAKE_PROFIT_MARKET` orders continue to use
`CONTRACT_PRICE` and remain primary intrabar protection. The watcher reads
only contiguous, completed five-minute candles after the real entry fill; it
never reacts to a mark, a wick, an incomplete bar, or a pre-fill/C2 bar.

On a logical invalidation, the lane first reconciles the owned exchange
position. If a native terminal fill has already won, no logical market order
is sent. Otherwise it invokes the existing exact-quantity reduce-only safe
flatten path: keep native siblings live until flatness is confirmed, cancel
only owned siblings, settle exact fill/fee data, release the ownership lease,
and re-reconcile. There is no auto-flip, re-entry, or stale-batch backfill.

## Route-aware decision geometry and economics

The candidate-time target and post-fill target are formed using the frozen
route multiplier. Consequently:

- Continuation geometry tests a 1R target distance and the same existing stop.
- Fade geometry tests a 2R target distance and the same existing stop.
- The 3% maximum structural-stop rule, 6% maximum target-distance rule,
  2x completed-4h ATR reachability rule, narrow-stop friction guard, sizing,
  and caps are unchanged.
- Economics records `grossWinR`, `netWinR`, and break-even win rate using 1R
  for Continuation and 2R for Fade. Alpha remains `SHADOW_ONLY` and receives
  those route-specific payoff facts only; it receives no allocation authority.

## Evidence and reporting

Logical exits retain their distinct reasons:

- `CONTINUATION_RANGE_REENTRY_EXIT`
- `FADE_BREAKOUT_REACCEPTANCE_EXIT`

Each captures the completed candle, boundary/distance, MFE/MAE at the event,
actual reduce-only fill and slippage, and a research-only old global-2R
counterfactual from the event onward. Future performance is partitioned by
immutable route/policy/TP cohort, so legacy 2R continuation outcomes cannot
blend into `daily-route-exit-v1:CONTINUATION:1R`.

The dashboard exposes route, policy ID, native TP multiple, structural hard
SL, and logical invalidation description for open and closed Daily trades.

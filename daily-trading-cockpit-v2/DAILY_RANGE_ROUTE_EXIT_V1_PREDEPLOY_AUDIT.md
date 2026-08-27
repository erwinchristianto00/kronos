# Daily Range Route-Specific Exit V1 — Predeploy Audit

## Baseline inspected

- Local baseline at audit: `02e76e8`, with runtime code from geometry release
  `c6e8134`.
- Fresh runtime snapshot: `2026-08-27T13:40:11Z` (21:40 Taipei). Testnet and
  Live Daily Range lanes were both `ARMED`, reconciled, and had no
  runtime/reconciliation error at that snapshot.
- `daily-trade-geometry-v1` was active in both environments: structural stop
  maximum 3%, target-distance maximum 6%, and completed-4h ATR14 target
  reachability maximum 2x.
- Allocator was `ECONOMIC_QUALITY_BASELINE`; alpha was `SHADOW_ONLY`.

## Existing-position freeze baseline

The patch must not mutate an already-open Daily position. All of the following
records predate `daily-route-exit-v1`, have `routeExitPolicy: null`, and must
retain their existing native structural stop, 2R TP, order IDs, and legacy
exit-policy lineage:

| Environment | Symbol / side | Stop | TP | Stop algo | TP algo |
| --- | --- | ---: | ---: | --- | --- |
| Testnet | `PENGUUSDT` LONG | 0.009372 | 0.009714 | `1000000183235833` | `1000000183235835` |
| Testnet | `CYSUSDT` SHORT | 0.771 | 0.7461 | `1000000183220294` | `1000000183220298` |
| Testnet | `AKEUSDT` SHORT | 0.0076088 | 0.0073034 | `1000000183169719` | `1000000183169722` |
| Live | `PYTHUSDT` LONG | 0.04787 | 0.05219 | `2000001390262467` | `2000001390262469` |
| Live | `TRUMPUSDT` LONG | 2.251 | 2.422 | `2000001389913907` | `2000001389913917` |
| Live | `1000BONKUSDT` LONG | 0.003024 | 0.003222 | `2000001389913890` | `2000001389913895` |

Each environment had one open Cross basket; Cross is outside this change.

## Global 2R assumptions found

1. `DAILY_RANGE_RR = 2` and `roundDailyRangeBracket()` formed every native TP
   at 2R after actual fill.
2. `prepareDailyRangeEconomics()` built hypothetical TP, geometry, net win R,
   and break-even win rate with a fixed 2R reward.
3. The post-fill geometry recheck used the same all-route 2R bracket.
4. The research counterfactual initialized and labelled every route as 2R.
5. Dashboard text and target labels described every Daily trade as `native
   SL / 2R TP`.

## Required delta

Only new `AUTO_ROUTE_NY_V2` trades receive `daily-route-exit-v1`:

- Continuation: 1R native TP plus completed-5m range-reentry thesis exit.
- Fade: 2R native TP plus completed-5m original-breakout reacceptance thesis
  exit.

The router, structural stop, geometry maximums, friction, risk sizing,
allocator, alpha authority, ownership, and Cross remain unchanged. Geometry,
economics, alpha shadow values, replay labels, and UI must consume the frozen
route-specific TP multiple.

As an additional cutover invariant, a V1 signal that predates a fresh Daily
arm epoch is explicitly marked `MISSED_SIGNAL_RECOVERY`; it cannot be filled
from a durable pre-arm batch. This leaves old records untouched while ensuring
the new policy starts only from fresh completed-candle observation.

# Daily Range V3 — Trade Geometry Audit

## Root cause

V3 previously validated only execution economics and the dollar-risk cap.  The
cost ratio is `safeLossFrictionBps / stopRiskBps`, so a wider structural stop
can look *cheaper* in cost-per-R.  Risk sizing then reduces quantity to keep
the planned loss below 0.25 USDT, but it cannot make a 2R price target nearer.

That let a BMT-like setup pass despite requiring a large underlying move:

| Field | BMT example |
| --- | ---: |
| Entry | 0.02114 |
| Structural stop | 0.02012 |
| Stop distance | 4.82% |
| Exact 2R target | 0.02318 |
| Target distance | 9.65% |

The stop economics can pass because the stop is wide, yet the position must
travel almost 10% before native take profit.  This is a trade-geometry problem,
not a sizing problem.

## Immutable policy

Policy ID: `daily-trade-geometry-v1`

1. Existing stop-economics gate remains first.
2. Rounded structural stop must be at most **3.00%** from expected executable
   entry.  Otherwise: `STRUCTURAL_STOP_TOO_WIDE`.
3. The exact existing 2R target must be at most **6.00%** from expected entry.
   Otherwise: `TARGET_DISTANCE_TOO_WIDE`.
4. Target must be no more than **2.00 × Wilder ATR14 on completed 4h USD-M
   candles**.  Otherwise: `TARGET_REACHABILITY_FAIL`.
5. A fresh entry with incomplete/gapped 4h history is fail-closed:
   `TARGET_REACHABILITY_DATA_UNAVAILABLE`.
6. Only after all three independent gates pass may the unchanged risk size
   `min(25 USDT notional, 0.25 USDT / structural stop distance)` reach the
   unchanged economic allocator.

No stop or target is clamped.  The exact structural SL and exact 2R TP remain
the native bracket for every admitted trade.

## Causal ATR definition

The feature uses only USD-M 4h bars whose close is strictly earlier than the
candidate decision timestamp.  It requires a continuous completed tail and
computes Wilder ATR(14); no current candle, later recovery read, interpolation,
or spot data is accepted.  The persisted candidate snapshot contains ATR,
source close timestamp, decision timestamp, stop/target percentages, target
ATR multiple, policy limits, and PASS/FAIL reason.

## Regression coverage

- 2.50% / 3.00% stops pass; 3.01% rejects.
- 5.90% / 6.00% targets pass; 6.01% rejects.
- 1.5× / 2.0× ATR targets pass; 2.1× rejects.
- A 0.4% stop still fails the pre-existing friction gate when cost/R exceeds
  25%.
- The BMT example rejects at `STRUCTURAL_STOP_TOO_WIDE` before sizing or
  allocation.

## Production regression confirmation

The Live BMT row precisely reproduced the intended generic guard: actual entry
`0.02114`, structural stop `0.02012` (4.825%), and exact 2R TP `0.02318`
(9.650%). It was rejected as `STRUCTURAL_STOP_TOO_WIDE` and safely flattened
through the existing owned reduce-only path. No BMT-specific blacklist or
change to route, friction, size, allocator, alpha mode, structural SL, or 2R
TP was introduced.

# LINKUSDT signal model

Ridge regression predicting the move over the next 15 minutes from trade flow.
Trained on 2026-08-12 to 2026-09-25 (45 days, 1,943,400 samples).
Trades only when the predicted move is at least 6 bps, holds 15 minutes.

## Walk-forward test (train 25 days, test the next 5 unseen days)

| test period | trades | hit rate | gross bps/trade | net after maker fees (4 bps) |
|---|---|---|---|---|
| 2026-09-06 to 2026-09-10 | 34 | 50% | +9.3 | +5.3 |
| 2026-09-11 to 2026-09-15 | 15 | 53% | +9.9 | +5.9 |
| 2026-09-16 to 2026-09-20 | 5 | 60% | +15.4 | +11.4 |
| 2026-09-21 to 2026-09-25 | 58 | 53% | +12.1 | +8.1 |

## Verdict

**Passes** the bar: positive after maker fees overall and in all but at most one test period, with at least 20 trades.
One window is not enough: rerunning this on a data window shifted by a day can change the verdict.

## All test periods together

- trades: 112 (about 5.6 a day)
- hit rate: 52.7%
- gross: +11.11 bps per trade (± 7.69 standard error)
- after maker fees: +7.11 bps per trade
- after taker fees: +1.11 bps per trade

## How to read this

- The edge is small and the uncertainty is about as big as the edge, so it may not be real.
- The 15-minute horizon and 6 bps threshold were picked after comparing a few settings on these
  same test periods, so these numbers are somewhat optimistic.
- It assumes post-only limit orders fill at the mid price. Real fills are often worse:
  a resting order tends to fill exactly when the price is moving against it.
- Past results don't guarantee future ones. Retrain regularly and judge it on live demo results.

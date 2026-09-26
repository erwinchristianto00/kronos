# SOLUSDT signal model

Ridge regression predicting the move over the next 15 minutes from trade flow.
Trained on 2026-08-11 to 2026-09-24 (45 days, 1,943,400 samples).
Trades only when the predicted move is at least 6 bps, holds 15 minutes.

## Walk-forward test (train 25 days, test the next 5 unseen days)

| test period | trades | hit rate | gross bps/trade | net after maker fees (4 bps) |
|---|---|---|---|---|
| 2026-09-05 to 2026-09-09 | 15 | 47% | +9.1 | +5.1 |
| 2026-09-10 to 2026-09-14 | 14 | 64% | +5.9 | +1.9 |
| 2026-09-15 to 2026-09-19 | 16 | 56% | +10.0 | +6.0 |
| 2026-09-20 to 2026-09-24 | 50 | 62% | +8.6 | +4.6 |

## All test periods together

- trades: 95 (about 4.75 a day)
- hit rate: 58.9%
- gross: +8.49 bps per trade (± 6.25 standard error)
- after maker fees: +4.49 bps per trade
- after taker fees: -1.51 bps per trade

## How to read this

- The edge is small and the uncertainty is about as big as the edge, so it may not be real.
- The 15-minute horizon and 6 bps threshold were picked after comparing a few settings on these
  same test periods, so these numbers are somewhat optimistic.
- It assumes post-only limit orders fill at the mid price. Real fills are often worse:
  a resting order tends to fill exactly when the price is moving against it.
- Past results don't guarantee future ones. Retrain regularly and judge it on live demo results.

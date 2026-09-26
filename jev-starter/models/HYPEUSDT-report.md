# HYPEUSDT signal model

Ridge regression predicting the move over the next 15 minutes from trade flow.
Trained on 2026-08-12 to 2026-09-25 (45 days, 1,943,400 samples).
Trades only when the predicted move is at least 6 bps, holds 15 minutes.

## Walk-forward test (train 25 days, test the next 5 unseen days)

| test period | trades | hit rate | gross bps/trade | net after maker fees (4 bps) |
|---|---|---|---|---|
| 2026-09-06 to 2026-09-10 | 10 | 40% | +1.2 | -2.8 |
| 2026-09-11 to 2026-09-15 | 3 | 67% | +94.7 | +90.7 |
| 2026-09-16 to 2026-09-20 | 5 | 80% | +84.4 | +80.4 |
| 2026-09-21 to 2026-09-25 | 32 | 50% | +1.0 | -3.0 |

## Verdict

**Does not pass** the bar: positive after maker fees overall and in all but at most one test period, with at least 20 trades. The bot won't run it with real money; on demo/testnet it runs as an experiment.
One window is not enough: rerunning this on a data window shifted by a day can change the verdict.

## All test periods together

- trades: 50 (about 2.5 a day)
- hit rate: 52.0%
- gross: +14.99 bps per trade (± 10.71 standard error)
- after maker fees: +10.99 bps per trade
- after taker fees: +4.99 bps per trade

## How to read this

- The edge is small and the uncertainty is about as big as the edge, so it may not be real.
- The 15-minute horizon and 6 bps threshold were picked after comparing a few settings on these
  same test periods, so these numbers are somewhat optimistic.
- It assumes post-only limit orders fill at the mid price. Real fills are often worse:
  a resting order tends to fill exactly when the price is moving against it.
- Past results don't guarantee future ones. Retrain regularly and judge it on live demo results.

# Daily Range Continuation selector research

Research date: 2026-08-27 Asia/Taipei  
Dataset: `RECONSTRUCTED_CANDLE_PIT`; market alpha only; no live authority.

## Preregistered specialist

The Continuation target is:

```text
pTP = P(native 2R TP before unchanged structural SL | completed-candle market features)
```

The first specialist is one deterministic L2 logistic regression. It is intentionally small and does not split Long/Short into sparse independent models.

Features are fixed before result review:

1. C2 extension/range width;
2. expansion delta/range width;
3. C2 extension/ATR;
4. C2 body fraction;
5. combined 5m relative volume;
6. side-aligned 1h return;
7. BTC side-aligned 1h return; and
8. range width/ATR.

Side remains embedded through aligned returns and is a diagnostic subgroup, not a tuned separate rule.

## Evaluation

Rows are batch-chronological: oldest 60% train, next 20% validation, newest 20% holdout, with three rolling walk-forward validation windows. Selection quality is judged against the economic baseline only on actual scarce-slot batches, with day/batch-aware bootstrap uncertainty. AUC alone is not a selector verdict.

## Final result: `REJECTED`

Run `rcpit-20260827-180d-v5` produced 7,916 complete labelled Continuation candidates: 4,801 train, 1,522 validation, and 1,593 newest holdout. No score threshold, route condition, Long/Short ban, or production ranking changed.

| Metric | Validation | Newest holdout |
| --- | ---: | ---: |
| Brier | 0.2211 | 0.2251 |
| Log loss | 0.6348 | 0.6426 |
| Rank correlation | -0.0117 | 0.0183 |
| Precision@1 | 33.21% (1,307 batches) | 33.19% (1,353 batches) |
| Precision@2 | 31.14% (175 batches) | 36.99% (196 batches) |
| Precision@3 | 24.00% (25 batches) | 30.30% (33 batches) |

Calibration is concentrated in the 20–40% predicted-probability bin: holdout mean pTP 31.11% versus realized 33.94% across 1,591 of 1,593 rows. The remaining two rows are insufficient to establish useful tail calibration. Walk-forward rank correlations were +0.0129, -0.0857, and +0.0305: no stable ranking signal.

On the 75 economically selected holdout rows, Economic baseline was -3.4313R / -0.8578 USD while alpha was -3.4468R / -0.8617 USD. Seeded random was -3.4590R. There was only one actual oversubscribed batch; alpha was -0.0155R below Economic, with an uninformative one-batch interval. The specialist fails both lift and scarcity evidence, so it remains `REJECTED` and shadow-only.

# Daily Range Fade selector research

Research date: 2026-08-27 Asia/Taipei  
Dataset: `RECONSTRUCTED_CANDLE_PIT`; market alpha only; no live authority.

## Preregistered specialist

The Fade target is also native `2R TP before unchanged structural SL`, but it has its own model and feature family because a failed breakout is not a continuation event.

One deterministic L2 logistic regression uses only:

1. maximum excursion/range width;
2. re-entry depth/range width;
3. maximum excursion/ATR;
4. C2 body fraction;
5. combined 5m relative volume;
6. side-aligned 1h return;
7. BTC side-aligned 1h return; and
8. range width/ATR.

No minimum reclaim, breakout extension, route switch, or symbol/side blacklist is fitted after observing recent losses.

## Evaluation

Chronological batch partitions and the oversubscribed slot replay match the Continuation specialist. The comparator is `ECONOMIC_QUALITY_BASELINE`, not loop order or seeded random. A result without enough mature and oversubscribed batches remains `REJECTED`, not a weak production claim.

## Final result: `REJECTED`

Run `rcpit-20260827-180d-v5` produced 5,843 complete labelled Fade candidates: 3,584 train, 1,175 validation, and 1,084 newest holdout. This study adds no new Fade policy or exit strategy.

| Metric | Validation | Newest holdout |
| --- | ---: | ---: |
| Brier | 0.2173 | 0.2231 |
| Log loss | 0.6263 | 0.6384 |
| Rank correlation | -0.0134 | 0.0151 |
| Precision@1 | 32.53% (1,033 batches) | 32.33% (968 batches) |
| Precision@2 | 32.66% (124 batches) | 39.39% (99 batches) |
| Precision@3 | 15.56% (15 batches) | 51.11% (15 batches) |

The holdout 20–40% bin is superficially calibrated (mean 33.46%, outcome 33.55% across 1,082 rows), but rank correlation and all three walk-forward rank correlations (-0.0150, -0.0165, +0.0197) are effectively zero. The isolated precision@3 result has only 15 batches and cannot support a rule.

No Fade batch survived the current-friction economic gate with more candidates than available slots. Therefore Economic, alpha, seeded random, and route-base selection were identical on 27 selected rows (-3.2939R / -0.8235 USD), and there is zero oversubscribed-batch evidence. The specialist is `REJECTED`, not weak shadow evidence.

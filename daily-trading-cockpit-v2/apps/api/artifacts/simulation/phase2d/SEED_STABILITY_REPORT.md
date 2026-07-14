# Seed Stability Report

## Result

`ROBUSTNESS_NOT_ESTABLISHED_FINAL`

Across the four supported rolling-origin folds, the overall deterministic 100-seed pass rate is `0.24`. Per-fold pass rates are:

```text
2026-03: 0.27
2026-04: 0.22
2026-05: 0.13
2026-06: 0.34
```

Every supported fold fails the required 0.80 threshold. No fold is close enough to treat this as sampling noise.

## Failure counts in 100-seed baseline runs

| Fold | Seam excess | Seam ratio | Seam classifier | Stylized facts | Insufficient |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-03 | 58 | 58 | 40 | 3 | 1 |
| 2026-04 | 27 | 27 | 71 | 12 | 0 |
| 2026-05 | 29 | 48 | 71 | 4 | 0 |
| 2026-06 | 21 | 21 | 53 | 9 | 0 |

The failure is over-determined: seams remain distinguishable and seam rejection remains excessive even where duplicate-sequence and month-concentration checks pass.

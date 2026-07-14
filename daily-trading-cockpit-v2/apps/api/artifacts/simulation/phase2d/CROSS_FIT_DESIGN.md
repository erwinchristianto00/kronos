# Phase 2D Cross-Fit Design

## Scope and freeze

This is the final, report-only robustness repair for the historical observed-successor family. It reads only the already-seen `2026-01` through `2026-06` corpus. The sealed `2025-07` through `2025-10` reserve and all 2024 data were not loaded, inspected, or scored.

Existing Phase 2C results, frozen gates, reconstruction, source-concentration cap, and classifier methodology remain unchanged. Cortex, deploy targets, and VPS runtime were outside this experiment.

## Rolling-origin protocol

Each supported fold fits its calibration volume baseline, compatibility normalizer, successor library, and transition statistics only from preceding 2026 months. The evaluation month is excluded from every fitting input and is used only as the scoring baseline.

| Evaluation | Training months | Status | Target |
| --- | --- | --- | --- |
| 2026-02 | 2026-01 | insufficient cross-fit support | 0h |
| 2026-03 | 2026-01, 2026-02 | evaluated | 576h |
| 2026-04 | 2026-01 to 2026-03 | evaluated | 624h |
| 2026-05 | 2026-01 to 2026-04 | evaluated | 624h |
| 2026-06 | 2026-01 to 2026-05 | evaluated | 624h |

February is not a realism failure: one training month cannot satisfy the frozen 50% maximum source-month concentration rule.

## Method B3

The cross-fitted implementation preserves real synchronized BTC/ETH successor candles and return-space reconstruction. It adds only the pre-approved dependence-reduction controls: deterministic top-K weighted sampling, reuse penalty, source-period balancing, candidate support floor, transition-key regularization, and entropy-floor support.

Stage A used only January and February calibration data. The frozen Stage B parameters were:

```text
topK = 12
reusePenalty = 0.5
entropyFloor = 0.0
candidateSupportFloor = 8
regularization = 0.1
balanceStrength = 1.0
```

Stage B ran 100 deterministic seeds per supported fold, all five unchanged-run caps, and the prescribed library perturbations. No Stage B result was used to tune the parameters.

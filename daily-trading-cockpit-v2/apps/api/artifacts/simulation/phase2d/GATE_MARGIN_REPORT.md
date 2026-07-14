# Gate Margin Report

| Readiness condition | Required | Observed | Status |
| --- | --- | --- | --- |
| Overall seed pass rate | >= 0.90 | 0.24 | fail |
| Every supported fold | >= 0.80 | 0.27, 0.22, 0.13, 0.34 | fail |
| Not one-month dependent | stable after source-month removal | Mar/Apr become 100% insufficient | fail |
| Cap <=96h viable or support-limited | pass or support-limited | 7-30%, mainly realism failures | fail |
| Duplicate sequence bound | below frozen threshold | p95 = 0 | pass |
| Seam classifier bound | below frozen threshold | p95 = 0.861-0.972 | fail |
| No concentration/memorization failure | frozen bounds hold | concentration <= 0.50, unique coverage >= 0.917 | pass |
| Perturbation resilience | no collapse | source-month and regime removals collapse | fail |
| No unresolved adversarial finding | mandatory review | see adversarial review | fail |
| Code/parameters frozen and committed | required only for readiness | not promoted; failed method remains uncommitted | not applicable to promotion |

Only the duplicate-sequence and baseline concentration/memoization conditions pass. These are necessary hygiene properties, not evidence that the generated seams are realistic.

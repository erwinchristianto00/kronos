# Cap Robustness Report

The historical-successor family must not rely exclusively on the permissive 144h unchanged-run cap. The table reports pass rates for 30 deterministic seeds per cap.

| Evaluation | 48h | 72h | 96h | 120h | 144h |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-03 | 10% | 10% | 27% | 27% | 27% |
| 2026-04 | 13% | 13% | 27% | 27% | 17% |
| 2026-05 | 7% | 7% | 7% | 7% | 13% |
| 2026-06 | 37% | 37% | 30% | 30% | 37% |

The strict-cap failures are not primarily support-limited. Insufficient rates are zero or near zero except March at 48h/72h (3%). The dominant failures remain the seam classifier and seam realism gates.

No fold has a passing cap at or below 96h, and 144h does not rescue the method. The cap-readiness criterion fails.

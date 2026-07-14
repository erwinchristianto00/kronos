# Rolling Period Results

All values below are frozen Stage B results from `results.json`. A pass requires every frozen realism gate to pass; no seed was removed.

| Evaluation month | Training | Target | Seed pass rate | Insufficient rate | Main failure pattern |
| --- | --- | ---: | ---: | ---: | --- |
| 2026-02 | Jan | 0h | n/a | n/a | support-limited by one-month training set |
| 2026-03 | Jan-Feb | 576h | 27% | 1% | seam excess/ratio, classifier |
| 2026-04 | Jan-Mar | 624h | 22% | 0% | classifier, then seam excess/ratio |
| 2026-05 | Jan-Apr | 624h | 13% | 0% | classifier, seam ratio/excess |
| 2026-06 | Jan-May | 624h | 34% | 0% | classifier, seam excess/ratio |

The supported-fold mean pass rate is 24%, versus the required 90% overall and 80% for every supported fold. The most complete training library, June evaluated from five months, still passes only 34%; more historical source supply does not repair the realism problem.

The result is therefore an out-of-period failure, not merely an inability to pack a target.

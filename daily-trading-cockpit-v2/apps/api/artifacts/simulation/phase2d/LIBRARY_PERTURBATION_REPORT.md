# Library Perturbation Report

All perturbations use 30 deterministic seeds per supported fold. The generator must remain viable when small parts of the historical successor library are removed.

## Key failures

- Removing the most-used source month makes March and April `100%` insufficient. This is direct one-month dependence, even though baseline month concentration stays within the mechanical 50% cap.
- Removing the `UPTREND` regime family causes 90-100% insufficiency in every evaluated fold. The library lacks regime-family redundancy.
- Rank-one exclusion, lower reuse, and higher entropy do not improve realism enough. Their pass rates remain 3-37%.

| Perturbation | Mar | Apr | May | Jun | Finding |
| --- | ---: | ---: | ---: | ---: | --- |
| remove top 1% successors | 37% | 17% | 10% | 50% | still fails realism |
| remove top source month | 0% / 100% insufficient | 0% / 100% insufficient | 7% | 40% | source-month dependency |
| exclude rank-one | 33% | 33% | 3% | 17% | not nearest-neighbour-only, still fails |
| cap reuse at 2 | 27% | 17% | 13% | 37% | reuse is not root cause |
| raise entropy floor | 20% | 20% | 10% | 33% | diversity alone does not fix seams |
| remove UPTREND | 3% / 93% insufficient | 0% / 97% insufficient | 3% / 90% insufficient | 0% / 100% insufficient | regime dependency |

The perturbation criterion fails. The source library is structurally too narrow for a stable out-of-period observed-successor generator.

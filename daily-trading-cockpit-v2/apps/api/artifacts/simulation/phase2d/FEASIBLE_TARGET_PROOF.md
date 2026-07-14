# Feasible Target Proof

The target is the largest block-aligned duration that can actually be packed under the frozen source-month and reuse caps. It is not a fixed-duration leave-one-period-out target.

```text
capacity(T) = sum over training months of
  min(floor(maxMonthFraction * T / blockLen), floor(monthAvailableHours / blockLen)) * blockLen

targetHours = largest T such that
  T <= excludedMonthHours,
  T <= maxSuccessorReuse * distinctSuccessors * blockLen,
  capacity(T) >= T
```

This direct test at each candidate `T` fixes the sawtooth packing error found during the Phase 2D smoke test. A self-consistent upper bound alone is not proof that the selected target packs.

| Evaluation | Training months | Excluded usable duration | Target | Month-cap slack | Binding constraint | Result |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 2026-02 | 1 | 576h | 0h | n/a | insufficient support | not evaluated |
| 2026-03 | 2 | 624h | 576h | 0h | month concentration | evaluated |
| 2026-04 | 3 | 624h | 624h | 240h | excluded duration | evaluated |
| 2026-05 | 4 | 624h | 624h | 528h | excluded duration | evaluated |
| 2026-06 | 5 | 624h | 624h | 816h | excluded duration | evaluated |

The February fold requires at least two training months under the frozen 50% month cap and is therefore explicitly support-limited. All four later folds are mathematically fillable before generation begins.

# Adversarial Review

## Scope integrity

Reviewed the runner inputs and output provenance. The runner explicitly loads only months `01` through `06` of 2026. No sealed 2025 reserve or 2024 input is referenced. No Cortex, deployment, VPS, or runtime configuration is touched.

## Confirmed negative findings

1. **Out-of-period realism does not hold.** Every supported fold fails well below the frozen 80% per-fold requirement. This is stronger evidence than the earlier in-sample 72% result.
2. **The seam problem is intrinsic, not a duplicate-sequence artifact.** Duplicate rate is zero and continuation coverage is high, while the seam classifier and seam rejection gates fail repeatedly.
3. **The library is not source-period robust.** March and April cannot generate after removing their top source month.
4. **The library is not regime robust.** Removing UPTREND makes nearly all runs support-insufficient. The cross-fit method cannot claim a general historical successor mechanism from that dependency.
5. **Strict caps reveal realism weakness rather than mere lack of supply.** Most 48-96h failures still have adequate support and fail seam realism/classification instead.

## Interpretation

These findings invalidate promotion of B3 even though its packing proof, provenance restriction, and duplicate/memoization controls work. The failures point to the observed-successor family itself: replaying contiguous successors selected from sparse historical state neighbours does not produce a stable out-of-period generator on this corpus.

No additional threshold or parameter tuning is justified. This review marks readiness condition 9 as failed for the generator family, not because of a missing test or implementation error.

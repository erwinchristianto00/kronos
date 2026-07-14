# Phase 2D Stop Report

## Final verdict

`ROBUSTNESS_NOT_ESTABLISHED_FINAL`

The final rolling-origin repair fails its pre-registered readiness gate. This closes the historical block-stitching and observed-successor generator line for production data generation.

## Required disposition

- Retain Methods B, B2, and B3 only as stress-test tools.
- Do not spend or inspect the sealed holdout on this generator family.
- Do not train Cortex from observed-successor synthetic output.
- Do not deploy or promote this family.
- Do not start another threshold-tuning loop for this family.

## Why the stop is final

The result is not a single unlucky seed or one infeasible fold. Four feasible out-of-period folds fail at 13-34%, strict caps fail mostly for realism reasons, and small library perturbations expose source-month and regime-family dependency. The only passing hygiene checks are duplicate control and baseline concentration.

## Alternative family recommendation only

If future work is authorized, start a separate pre-registered evaluation of a different historically grounded family rather than repairing observed-successor selection again. The best first candidate is a **multivariate return-residual bootstrap with synchronized BTC/ETH empirical residual vectors**, regime-conditioned and provenance-preserving. A state-space residual model is a second option. Neither is built or evaluated by Phase 2D.

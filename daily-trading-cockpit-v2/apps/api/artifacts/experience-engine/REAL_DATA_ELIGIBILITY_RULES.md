# Real-data eligibility rules

Only OBSERVED_SHADOW_OUTCOME, OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME, HISTORICAL_CAUSAL_REPLAY, and OBSERVED_PATH_COUNTERFACTUAL can be candidate inputs, and only after causal timestamp, feature snapshot, attribution, resolved outcome, and quality checks pass. SIMULATED_STRESS and ADVERSARIAL_SYNTHETIC are permanently INELIGIBLE_FOR_DIRECT_TRAINING. EXECUTION_CALIBRATION is evaluation-only.

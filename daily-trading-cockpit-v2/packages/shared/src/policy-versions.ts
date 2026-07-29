/**
 * Version stamps for the end-to-end correctness migration.  These are data
 * contracts, not tuning knobs: every persisted decision/evidence record must
 * say which semantics produced it.
 */
export const DECISION_PIPELINE_POLICY_VERSION = "end-to-end-correctness-v2";
export const EXECUTION_POLICY_VERSION = "execution-resolver-correctness-v2";
export const EVIDENCE_POLICY_VERSION = "evidence-correctness-v2";
export const CORTEX_MODEL_OBJECTIVE_VERSION = "cortex-net-r-objective-v1";
export const CORTEX_ALLOCATION_POLICY_VERSION = "cortex-allocation-safety-v1";

/**
 * Auditable cutover for the corrected decision/execution/evidence semantics.
 * A plan must carry this exact value before its outcomes can join the new
 * evidence cohort; version strings alone are not a deployment boundary.
 */
export const END_TO_END_CORRECTNESS_DEPLOYED_AT = "2026-07-29T19:50:00.000Z";

/** Existing scanner admission thresholds, named once so UI, scanner and tests cannot drift. */
export const MIN_STRUCTURAL_RR = 1.2;
export const MIN_EXECUTION_RR = 1.5;
export const MIN_RAW_QUOTE_VOLUME_24H = 10_000_000;
export const MAX_SCANNER_SPREAD_PERCENT = 0.12;

/**
 * Real-Data Experience Engine: a pure, offline-only firewall and normalized record contract.
 * It has no runtime imports, no executor authority, and no CORTEX store access. A record must prove causality,
 * identity, and outcome quality before it may be exported for candidate learning.
 */
export const EXPERIENCE_SCHEMA_VERSION: "experience-engine/1" = "experience-engine/1";

export type ExperienceSource =
  | "OBSERVED_SHADOW_OUTCOME"
  | "OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME"
  | "HISTORICAL_CAUSAL_REPLAY"
  | "OBSERVED_PATH_COUNTERFACTUAL"
  | "SIMULATED_STRESS"
  | "ADVERSARIAL_SYNTHETIC"
  | "EXECUTION_CALIBRATION";
export type ExperienceEligibility = "CANDIDATE_LEARNING_ELIGIBLE" | "EVALUATION_ONLY" | "INELIGIBLE_FOR_DIRECT_TRAINING";
export type AttributionStatus = "ATTRIBUTED" | "NATIVE_DIRECT" | "UNATTRIBUTED" | "IDENTITY_MISMATCH" | "MISSING_DECISION_SNAPSHOT" | "SCHEMA_MISMATCH" | "AMBIGUOUS";
export type OutcomeQuality = "RESOLVED_VALID" | "OPEN" | "NO_FILL" | "INVALID_GEOMETRY" | "MISSING_OUTCOME" | "AMBIGUOUS_INTRABAR" | "EXECUTION_ESTIMATE";
export type SourceStatus = "FRESH" | "STALE" | "MISSING" | "ERROR" | "UNSUPPORTED";

export interface ExperienceRecord {
  schemaVersion: typeof EXPERIENCE_SCHEMA_VERSION;
  experienceId: string;
  source: ExperienceSource;
  provenance: "OBSERVED" | "HISTORICAL_CAUSAL" | "OBSERVED_PATH_COUNTERFACTUAL" | "SIMULATED" | "ADVERSARIAL";
  decisionTimeMs: number | null;
  openedTimeMs: number | null;
  marketCloseTimeMs: number | null;
  resolvedTimeMs: number | null;
  laneId: string | null;
  symbolOrBasketId: string | null;
  direction: "LONG" | "SHORT" | "FLAT" | null;
  featureSchemaVersion: string | null;
  codeVersion: string | null;
  featureVector: number[] | null;
  sourceStatuses: Record<string, SourceStatus>;
  attributionStatus: AttributionStatus;
  outcomeQuality: OutcomeQuality;
  outcomeNetR: number | null;
  labels: {
    direction?: "LONG" | "SHORT" | "FLAT";
    entry?: "ENTER_NOW" | "WAIT_PULLBACK" | "WAIT_BREAKOUT" | "WAIT_CONFIRMATION" | "SKIP";
    exit?: "HOLD" | "EXIT_NOW" | "SCALE_OUT" | "TRAIL" | "INCUMBENT_TP_SL";
    allocationMultiple?: 0 | 0.5 | 1 | 1.5;
  };
  executionLabelKind: "NONE" | "PAPER_OUTCOME" | "HISTORICAL_REPLAY" | "CANDLE_APPROXIMATION" | "EXECUTION_MODEL_ESTIMATE";
  eligibility: ExperienceEligibility;
  eligibilityReasons: string[];
}

const LEARNING_SOURCES = new Set<ExperienceSource>(["OBSERVED_SHADOW_OUTCOME", "OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME", "HISTORICAL_CAUSAL_REPLAY", "OBSERVED_PATH_COUNTERFACTUAL"]);

export function assessExperienceEligibility(record: Omit<ExperienceRecord, "eligibility" | "eligibilityReasons">): Pick<ExperienceRecord, "eligibility" | "eligibilityReasons"> {
  const reasons: string[] = [];
  if (record.source === "EXECUTION_CALIBRATION") return { eligibility: "EVALUATION_ONLY", eligibilityReasons: ["execution_calibration_never_directional_alpha"] };
  if (!LEARNING_SOURCES.has(record.source)) return { eligibility: "INELIGIBLE_FOR_DIRECT_TRAINING", eligibilityReasons: ["synthetic_or_adversarial_source"] };
  if (record.decisionTimeMs == null) reasons.push("missing_decision_time");
  if (record.openedTimeMs != null && record.decisionTimeMs != null && record.decisionTimeMs > record.openedTimeMs) reasons.push("post_open_decision_leakage");
  if (record.marketCloseTimeMs == null || record.resolvedTimeMs == null) reasons.push("missing_market_close_or_resolution_time");
  if (record.marketCloseTimeMs != null && record.openedTimeMs != null && record.marketCloseTimeMs < record.openedTimeMs) reasons.push("close_before_open");
  if (record.featureSchemaVersion == null || record.featureVector == null) reasons.push("missing_feature_snapshot");
  if (record.attributionStatus !== "ATTRIBUTED" && record.attributionStatus !== "NATIVE_DIRECT") reasons.push(`attribution_${record.attributionStatus.toLowerCase()}`);
  if (record.outcomeQuality !== "RESOLVED_VALID") reasons.push(`outcome_${record.outcomeQuality.toLowerCase()}`);
  if (record.outcomeNetR == null || !Number.isFinite(record.outcomeNetR)) reasons.push("missing_valid_outcome_net_r");
  if (Object.values(record.sourceStatuses).some((status) => status === "ERROR")) reasons.push("source_error");
  return reasons.length ? { eligibility: "INELIGIBLE_FOR_DIRECT_TRAINING", eligibilityReasons: reasons } : { eligibility: "CANDIDATE_LEARNING_ELIGIBLE", eligibilityReasons: [] };
}

export function normalizeExperience(record: Omit<ExperienceRecord, "schemaVersion" | "eligibility" | "eligibilityReasons">): ExperienceRecord {
  const base = { ...record, schemaVersion: EXPERIENCE_SCHEMA_VERSION };
  return { ...base, ...assessExperienceEligibility(base) };
}

/** Strict candidate export: simulated and incomplete rows cannot escape by caller error. */
export function candidateLearningRows(records: readonly ExperienceRecord[]): ExperienceRecord[] {
  return records.filter((record) => record.eligibility === "CANDIDATE_LEARNING_ELIGIBLE");
}

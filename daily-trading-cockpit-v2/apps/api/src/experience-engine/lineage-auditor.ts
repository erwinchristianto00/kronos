/** Pure causal-lineage auditor. Exact stable identifiers only: no fuzzy time/text joins and no source mutation. */
import type { ExperienceSource, SourceStatus } from "./experience-engine.js";

export type LineageRejectionReason =
  | "COMPLETE_CAUSAL_CHAIN" | "MISSING_DECISION_SNAPSHOT" | "MISSING_PRE_OPEN_FEATURES" | "MISSING_OPEN_TIMESTAMP"
  | "MISSING_MARKET_CLOSE_TIMESTAMP" | "MISSING_RESOLVED_TIMESTAMP" | "MISSING_OUTCOME"
  | "NO_ELIGIBLE_PRE_OPEN_DECISION" | "IDENTITY_MISMATCH" | "LANE_MISMATCH" | "SYMBOL_OR_BASKET_MISMATCH"
  | "DIRECTION_MISMATCH" | "SCHEMA_MISMATCH" | "TTL_EXPIRED" | "FUTURE_FEATURE_LEAKAGE" | "NONFINITE_OUTCOME"
  | "UNSAFE_INTRABAR_LABEL" | "DUPLICATE_OUTCOME" | "SOURCE_NOT_LEARNING_ELIGIBLE" | "EXECUTION_ONLY_EVIDENCE" | "OTHER";
export type FieldAvailability = "PRESENT_BUT_NOT_IMPORTED" | "PRESENT_UNDER_DIFFERENT_SCHEMA" | "DERIVABLE_CAUSALLY" | "FORWARD_COLLECTION_REQUIRED" | "PERMANENTLY_UNAVAILABLE" | "UNSAFE_TO_RECONSTRUCT";

export interface PreOpenFeatureSnapshot { featureSchemaVersion: string; values: number[]; availableAtMs: number[]; sourceStatuses: Record<string, SourceStatus>; }
export interface DecisionSnapshot { decisionId: string; signalOrderId: string | null; asOfMs: number; laneId: string | null; symbolOrBasketId: string | null; direction: "LONG" | "SHORT" | "FLAT" | null; codeVersion: string | null; features: PreOpenFeatureSnapshot | null; sourcePointer: string; }
export interface OpportunityOutcome { outcomeId: string; decisionLinkId: string | null; source: ExperienceSource; openedAtMs: number | null; closedAtMs: number | null; resolvedAtMs: number | null; laneId: string | null; symbolOrBasketId: string | null; direction: "LONG" | "SHORT" | "FLAT" | null; featureSchemaVersion: string | null; outcomeNetR: number | null; outcomeQuality: "RESOLVED_VALID" | "OPEN" | "MISSING_OUTCOME" | "UNSAFE_INTRABAR" | "EXECUTION_ONLY"; sourcePointer: string; }
export interface LineageAudit { outcomeId: string; selectedDecisionId: string | null; candidateDecisionCount: number; attributionLagMs: number | null; identity: { lane: boolean | null; symbol: boolean | null; direction: boolean | null; schema: boolean | null }; ttlResult: "PASS" | "EXPIRED" | "NOT_EVALUATED"; timestampOrdering: "PASS" | "FAIL" | "INCOMPLETE"; rejectionReason: LineageRejectionReason; sourcePointers: string[]; }

const learningSources = new Set<ExperienceSource>(["OBSERVED_SHADOW_OUTCOME", "OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME", "HISTORICAL_CAUSAL_REPLAY", "OBSERVED_PATH_COUNTERFACTUAL"]);
const same = (a: string | null, b: string | null): boolean | null => a == null || b == null ? null : a === b;

/** Attempts exactly one causal chain. Candidate decisions are found only by explicit stable id, never display fields. */
export function auditLineage(outcome: OpportunityOutcome, decisions: readonly DecisionSnapshot[], consumedOutcomeIds: ReadonlySet<string>, ttlMs = 60 * 60_000): LineageAudit {
  const base = { outcomeId: outcome.outcomeId, selectedDecisionId: null as string | null, candidateDecisionCount: 0, attributionLagMs: null as number | null, identity: { lane: null as boolean | null, symbol: null as boolean | null, direction: null as boolean | null, schema: null as boolean | null }, ttlResult: "NOT_EVALUATED" as const, timestampOrdering: "INCOMPLETE" as const, sourcePointers: [outcome.sourcePointer] };
  const reject = (rejectionReason: LineageRejectionReason): LineageAudit => ({ ...base, rejectionReason });
  if (!learningSources.has(outcome.source)) return reject(outcome.source === "EXECUTION_CALIBRATION" ? "EXECUTION_ONLY_EVIDENCE" : "SOURCE_NOT_LEARNING_ELIGIBLE");
  if (consumedOutcomeIds.has(outcome.outcomeId)) return reject("DUPLICATE_OUTCOME");
  if (!outcome.decisionLinkId) return reject("MISSING_DECISION_SNAPSHOT");
  const candidates = decisions.filter((decision) => decision.decisionId === outcome.decisionLinkId || decision.signalOrderId === outcome.decisionLinkId);
  if (!candidates.length) return { ...base, candidateDecisionCount: 0, rejectionReason: "NO_ELIGIBLE_PRE_OPEN_DECISION" };
  const decision = candidates.sort((a, b) => b.asOfMs - a.asOfMs)[0]!;
  const identity = { lane: same(decision.laneId, outcome.laneId), symbol: same(decision.symbolOrBasketId, outcome.symbolOrBasketId), direction: same(decision.direction, outcome.direction), schema: decision.features == null || outcome.featureSchemaVersion == null ? null : decision.features.featureSchemaVersion === outcome.featureSchemaVersion };
  const withDecision = { ...base, selectedDecisionId: decision.decisionId, candidateDecisionCount: candidates.length, identity, sourcePointers: [decision.sourcePointer, outcome.sourcePointer] };
  if (identity.lane === false) return { ...withDecision, rejectionReason: "LANE_MISMATCH" };
  if (identity.symbol === false) return { ...withDecision, rejectionReason: "SYMBOL_OR_BASKET_MISMATCH" };
  if (identity.direction === false) return { ...withDecision, rejectionReason: "DIRECTION_MISMATCH" };
  if (identity.schema === false) return { ...withDecision, rejectionReason: "SCHEMA_MISMATCH" };
  if (outcome.openedAtMs == null) return { ...withDecision, rejectionReason: "MISSING_OPEN_TIMESTAMP" };
  const lag = outcome.openedAtMs - decision.asOfMs;
  if (lag < 0) return { ...withDecision, attributionLagMs: lag, ttlResult: "NOT_EVALUATED", rejectionReason: "FUTURE_FEATURE_LEAKAGE" };
  if (lag > ttlMs) return { ...withDecision, attributionLagMs: lag, ttlResult: "EXPIRED", rejectionReason: "TTL_EXPIRED" };
  if (!decision.features || !decision.features.values.length) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", rejectionReason: "MISSING_PRE_OPEN_FEATURES" };
  if (decision.features.availableAtMs.some((at) => !Number.isFinite(at) || at > decision.asOfMs)) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", rejectionReason: "FUTURE_FEATURE_LEAKAGE" };
  if (outcome.closedAtMs == null) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", rejectionReason: "MISSING_MARKET_CLOSE_TIMESTAMP" };
  if (outcome.resolvedAtMs == null) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", rejectionReason: "MISSING_RESOLVED_TIMESTAMP" };
  if (!(decision.asOfMs <= outcome.openedAtMs && outcome.openedAtMs <= outcome.closedAtMs && outcome.closedAtMs <= outcome.resolvedAtMs)) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "FAIL", rejectionReason: "OTHER" };
  if (outcome.outcomeQuality === "UNSAFE_INTRABAR") return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "PASS", rejectionReason: "UNSAFE_INTRABAR_LABEL" };
  if (outcome.outcomeQuality === "EXECUTION_ONLY") return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "PASS", rejectionReason: "EXECUTION_ONLY_EVIDENCE" };
  if (outcome.outcomeQuality !== "RESOLVED_VALID") return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "PASS", rejectionReason: "MISSING_OUTCOME" };
  if (outcome.outcomeNetR == null || !Number.isFinite(outcome.outcomeNetR)) return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "PASS", rejectionReason: "NONFINITE_OUTCOME" };
  return { ...withDecision, attributionLagMs: lag, ttlResult: "PASS", timestampOrdering: "PASS", rejectionReason: "COMPLETE_CAUSAL_CHAIN" };
}

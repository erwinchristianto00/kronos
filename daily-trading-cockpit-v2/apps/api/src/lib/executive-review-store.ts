/**
 * Canonical, append-only Four-Brain review outcome store. This is deliberately
 * separate from CORTEX attribution: review quality is measurement only and can
 * never become a learner feature under the current authority policy.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ExecutiveReviewTier = "TIER_1_REAL" | "TIER_2_COUNTERFACTUAL";
export type ExecutiveIncumbentAction = "ENTERED" | "SKIPPED" | "HELD" | "EXITED";
export type ExecutiveVerdict = "VALID" | "WAIT" | "REJECT" | "SKIP" | "FLAT" | "BLOCKED_BY_RISK" | "INCUMBENT_ONLY";
export type ExecutiveReviewStateCode = "PENDING_EXECUTION_LINK" | "PENDING_OUTCOME" | "TIER1_ELIGIBLE" | "TIER2_ONLY" | "REJECTED";
export type ExecutiveReviewReasonCode =
  | "MISSING_EXECUTIVE_REVIEW_ID" | "MISSING_CANDIDATE_ID" | "MISSING_OPPORTUNITY_ID" | "MISSING_EXECUTION_INTENT_ID" | "MISSING_ORDER_ID" | "MISSING_POSITION_ID" | "MISSING_OUTCOME_ID"
  | "POSITION_ID_MISMATCH" | "OPPORTUNITY_ID_MISMATCH" | "CANDIDATE_ID_MISMATCH" | "MARKET_SNAPSHOT_MISMATCH" | "AMBIGUOUS_OWNERSHIP"
  | "NO_REAL_POSITION" | "POSITION_NOT_RESOLVED" | "COUNTERFACTUAL_ONLY" | "POLICY_LINEAGE_INCOMPLETE" | "POLICY_VERSION_MISMATCH"
  | "ORIGINAL_RISK_MISSING" | "ORIGINAL_RISK_INVALID" | "GROSS_R_INVALID" | "EXECUTION_COST_MISSING" | "EXECUTION_COST_NONFINITE"
  | "EXECUTION_COST_INVALID" | "EXECUTION_COST_PROVENANCE_MISSING" | "SETTLEMENT_INCOMPLETE" | "NET_R_INVALID" | "OUTCOME_TIME_INVALID" | "OUTCOME_ALREADY_LINKED" | "EXECUTIVE_REVIEW_ALREADY_RESOLVED";

export type ExecutiveReviewDirection = "LONG" | "SHORT" | "NEUTRAL";
export type ExecutiveCostProvenance = "EXCHANGE_MEASURED" | "EXECUTION_MODEL_ESTIMATE";

/** Immutable reviewer metadata attached by an incumbent producer before it creates an intent. */
export interface ExecutiveReviewRecord {
  executiveReviewId: string;
  candidateId: string;
  opportunityId: string;
  laneId: string;
  marketContextSnapshotId: string;
  allocationSnapshotId: string | null;
  strategyAction: "ENTER" | "WAIT" | "SKIP";
  direction: ExecutiveReviewDirection;
  marketState: string;
  evidenceEra: string;
  advisoryVerdict: ExecutiveVerdict;
  advisoryOnly: true;
  reviewedAtMs: number;
  sourceCutoffMs: number;
  decisionPipelinePolicyVersion: string;
  executionPolicyVersion: string;
  evidencePolicyVersion: string;
  fourBrainPolicyVersion: string;
  state: ExecutiveReviewStateCode;
  reasonCode: ExecutiveReviewReasonCode | null;
  positionId: string | null;
  outcomeId: string | null;
}

/** The exact metadata that is allowed to cross incumbent execution boundaries. */
export type ExecutiveReviewExecutionLink = Pick<
  ExecutiveReviewRecord,
  | "executiveReviewId"
  | "candidateId"
  | "opportunityId"
  | "laneId"
  | "marketContextSnapshotId"
  | "allocationSnapshotId"
  | "direction"
  | "marketState"
  | "evidenceEra"
  | "decisionPipelinePolicyVersion"
  | "executionPolicyVersion"
  | "evidencePolicyVersion"
  | "fourBrainPolicyVersion"
>;

/** Exact fields supplied by the incumbent execution/outcome owner. No inference is permitted. */
export interface ExecutiveReviewPositionLink {
  executiveReviewId: string | null;
  candidateId: string | null;
  opportunityId: string | null;
  executionIntentId: string | null;
  orderId: string | null;
  positionId: string | null;
  laneId: string | null;
  marketContextSnapshotId: string | null;
  entryAtMs: number | null;
  originalRisk: number | null;
  ambiguousOwnership: boolean;
  decisionPipelinePolicyVersion: string | null;
  executionPolicyVersion: string | null;
  evidencePolicyVersion: string | null;
  fourBrainPolicyVersion: string | null;
}

export interface ExecutiveReviewOutcomeLink {
  executiveReviewId: string | null;
  opportunityId: string | null;
  positionId: string | null;
  outcomeId: string | null;
  resolvedAtMs: number | null;
  grossR: number | null;
  costR: number | null;
  /** `true` is required even when costR is exactly zero. */
  executionCostKnown: boolean;
  /** A known zero is valid only when its measurement/model source is explicit. */
  executionCostProvenance: ExecutiveCostProvenance | null;
  settlementFetchComplete: boolean;
  requiredOrderIds: string[];
  matchedRequiredOrderIds: string[];
  missingRequiredOrderIds: string[];
  netR: number | null;
  decisionPipelinePolicyVersion: string | null;
  executionPolicyVersion: string | null;
  evidencePolicyVersion: string | null;
  fourBrainPolicyVersion: string | null;
  completedCandle: boolean;
  ambiguousOwnership: boolean;
}

export interface ExecutiveReviewOutcome {
  executiveReviewOutcomeId: string;
  executiveReviewId: string;
  tier: ExecutiveReviewTier;
  candidateId: string;
  opportunityId: string;
  executionIntentId: string;
  orderId: string | null;
  positionId: string;
  outcomeId: string;
  marketContextSnapshotId: string;
  allocationSnapshotId: string | null;
  laneId: string;
  direction: ExecutiveReviewDirection;
  marketState: string;
  evidenceEra: string;
  strategyAction: "ENTER";
  advisoryVerdict: ExecutiveVerdict;
  incumbentAction: ExecutiveIncumbentAction;
  advisoryOnly: true;
  entryAtMs: number;
  resolvedAtMs: number;
  originalRisk: number;
  grossR: number;
  costR: number;
  executionCostProvenance: ExecutiveCostProvenance;
  settlementFetchComplete: true;
  requiredOrderIds: string[];
  matchedRequiredOrderIds: string[];
  missingRequiredOrderIds: [];
  netR: number;
  decisionPipelinePolicyVersion: string;
  executionPolicyVersion: string;
  evidencePolicyVersion: string;
  fourBrainPolicyVersion: string;
  eligibleForFourBrainEvaluation: true;
  eligibleForCortexLearning: false;
}

export interface ExecutiveReviewState {
  version: 1;
  reviews: ExecutiveReviewRecord[];
  tier1: ExecutiveReviewOutcome[];
  tier2: ExecutiveReviewOutcome[];
  processedIds: string[];
  rejected: ExecutiveReviewRecord[];
}

export interface ExecutiveReviewTier1Aggregate {
  dimension: "advisoryVerdict" | "laneId" | "direction" | "marketState" | "policy" | "evidenceEra";
  key: string;
  /** Observed resolved reviews only; this is deliberately not an alpha or promotion metric. */
  resolvedCount: number;
  averageNetR: number;
  positiveCount: number;
  negativeCount: number;
}

const empty = (): ExecutiveReviewState => ({ version: 1, reviews: [], tier1: [], tier2: [], processedIds: [], rejected: [] });
const MAX_ROWS = 5_000;
const MAX_IDS = 10_000;

/** A real matched review is not eligible without exact lineage, costs, policy stamps, and an outcome. */
export function eligibleTier1ExecutiveReview(row: ExecutiveReviewOutcome): boolean {
  return row.tier === "TIER_1_REAL"
    && row.advisoryOnly === true && row.eligibleForFourBrainEvaluation === true && row.eligibleForCortexLearning === false
    && [row.executiveReviewOutcomeId, row.executiveReviewId, row.candidateId, row.opportunityId, row.executionIntentId, row.positionId, row.outcomeId, row.laneId, row.marketContextSnapshotId, row.decisionPipelinePolicyVersion, row.executionPolicyVersion, row.evidencePolicyVersion, row.fourBrainPolicyVersion].every((v) => typeof v === "string" && v.length > 0)
    && [row.entryAtMs, row.resolvedAtMs, row.originalRisk, row.grossR, row.costR, row.netR].every((v) => typeof v === "number" && Number.isFinite(v))
    && row.originalRisk > 0 && row.costR >= 0 && row.resolvedAtMs >= row.entryAtMs
    && row.settlementFetchComplete === true && Array.isArray(row.missingRequiredOrderIds) && row.missingRequiredOrderIds.length === 0
    && (row.executionCostProvenance === "EXCHANGE_MEASURED" || row.executionCostProvenance === "EXECUTION_MODEL_ESTIMATE")
    && Math.abs((row.grossR - row.costR) - row.netR) <= 1e-9;
}

/** Tier 2 stays separately labelled and is never blended into real review evidence. */
export function eligibleTier2ExecutiveReview(_row: ExecutiveReviewOutcome): boolean { return false; }

/** Advisory counts only. This intentionally publishes no alpha, routing, or allocation claim. */
export function executiveReviewTier1Aggregates(state: Pick<ExecutiveReviewState, "tier1">): ExecutiveReviewTier1Aggregate[] {
  const dimensions: Array<ExecutiveReviewTier1Aggregate["dimension"]> = [
    "advisoryVerdict", "laneId", "direction", "marketState", "policy", "evidenceEra",
  ];
  const buckets = new Map<string, { resolvedCount: number; sumNetR: number; positiveCount: number; negativeCount: number }>();
  for (const row of state.tier1) {
    if (!eligibleTier1ExecutiveReview(row)) continue;
    const values: Record<ExecutiveReviewTier1Aggregate["dimension"], string> = {
      advisoryVerdict: row.advisoryVerdict,
      laneId: row.laneId,
      direction: row.direction,
      marketState: row.marketState,
      policy: `${row.decisionPipelinePolicyVersion}|${row.executionPolicyVersion}|${row.evidencePolicyVersion}|${row.fourBrainPolicyVersion}`,
      evidenceEra: row.evidenceEra,
    };
    for (const dimension of dimensions) {
      const key = `${dimension}:${values[dimension]}`;
      const bucket = buckets.get(key) ?? { resolvedCount: 0, sumNetR: 0, positiveCount: 0, negativeCount: 0 };
      bucket.resolvedCount += 1;
      bucket.sumNetR += row.netR;
      if (row.netR > 0) bucket.positiveCount += 1;
      if (row.netR < 0) bucket.negativeCount += 1;
      buckets.set(key, bucket);
    }
  }
  return [...buckets.entries()]
    .map(([compound, bucket]) => {
      const separator = compound.indexOf(":");
      return {
        dimension: compound.slice(0, separator) as ExecutiveReviewTier1Aggregate["dimension"],
        key: compound.slice(separator + 1),
        resolvedCount: bucket.resolvedCount,
        averageNetR: bucket.sumNetR / bucket.resolvedCount,
        positiveCount: bucket.positiveCount,
        negativeCount: bucket.negativeCount,
      };
    })
    .sort((left, right) => left.dimension.localeCompare(right.dimension) || left.key.localeCompare(right.key));
}

export class ExecutiveReviewStore {
  private state: ExecutiveReviewState = empty();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExecutiveReviewState>;
      if (parsed.version !== 1) return;
      const reviews = Array.isArray(parsed.reviews) ? parsed.reviews.filter(validReviewRecord).slice(-MAX_ROWS) : [];
      this.state = {
        version: 1,
        reviews,
        tier1: Array.isArray(parsed.tier1)
          ? parsed.tier1.filter(eligibleTier1ExecutiveReview).filter((row) => {
              const parent = reviews.find((review) => review.executiveReviewId === row.executiveReviewId);
              return parent?.state === "TIER1_ELIGIBLE" && parent.positionId === row.positionId && parent.outcomeId === row.outcomeId;
            }).slice(-MAX_ROWS)
          : [],
        tier2: [], // Tier 2 remains unavailable until a deterministic counterfactual resolver exists.
        processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds.filter((id): id is string => typeof id === "string").slice(-MAX_IDS) : [],
        rejected: Array.isArray(parsed.rejected) ? parsed.rejected.filter(validReviewRecord).slice(-MAX_ROWS) : [],
      };
    } catch {
      this.state = empty();
    }
  }

  get(): Readonly<ExecutiveReviewState> {
    return this.state;
  }

  addReview(record: ExecutiveReviewRecord): boolean {
    if (
      !validReviewRecord(record) ||
      record.state !== "PENDING_EXECUTION_LINK" ||
      record.reasonCode !== null ||
      record.positionId !== null ||
      record.outcomeId !== null ||
      this.state.reviews.some((r) => r.executiveReviewId === record.executiveReviewId)
    ) return false;
    this.state.reviews.push({ ...record });
    if (this.state.reviews.length > MAX_ROWS) this.state.reviews.splice(0, this.state.reviews.length - MAX_ROWS);
    return true;
  }

  /** A future deterministic counterfactual resolver may mark an unexecuted/expired review Tier 2 only. */
  markTier2Only(recordId: string, reason: "NO_REAL_POSITION" | "COUNTERFACTUAL_ONLY" = "COUNTERFACTUAL_ONLY"): ExecutiveReviewReasonCode | null {
    const review = this.state.reviews.find((r) => r.executiveReviewId === recordId);
    if (!review || review.state === "TIER1_ELIGIBLE" || review.state === "REJECTED") return review?.reasonCode ?? "EXECUTIVE_REVIEW_ALREADY_RESOLVED";
    review.state = "TIER2_ONLY";
    review.reasonCode = reason;
    return null;
  }

  /** Exact, forward-only state transition. No joins by lane, symbol, timestamp, or price exist here. */
  resolve(recordId: string, position: ExecutiveReviewPositionLink | null, outcome: ExecutiveReviewOutcomeLink | null): ExecutiveReviewReasonCode | null {
    const review = this.state.reviews.find((r) => r.executiveReviewId === recordId);
    if (!review) return "MISSING_EXECUTIVE_REVIEW_ID";
    if (review.state === "TIER1_ELIGIBLE" || review.state === "TIER2_ONLY" || review.state === "REJECTED") return review.reasonCode ?? "EXECUTIVE_REVIEW_ALREADY_RESOLVED";
    if (!position) return "NO_REAL_POSITION";
    const positionFailure = positionReason(review, position);
    if (positionFailure) return this.reject(review, positionFailure);
    review.positionId = position.positionId;
    review.state = "PENDING_OUTCOME";
    if (!outcome) return "POSITION_NOT_RESOLVED";
    const outcomeFailure = outcomeReason(review, position, outcome);
    // An active/incomplete candle is not a failure. Preserve the exact linked position and wait for
    // the final candle/outcome producer rather than freezing a mutable bar into Tier 1 evidence.
    if (outcomeFailure === "POSITION_NOT_RESOLVED") return outcomeFailure;
    if (outcomeFailure) return this.reject(review, outcomeFailure);
    const outcomeId = executiveReviewOutcomeId(review.executiveReviewId, position.positionId!, outcome.outcomeId!);
    if (this.state.processedIds.includes(outcomeId)) return "OUTCOME_ALREADY_LINKED";
    const tier1: ExecutiveReviewOutcome = {
      executiveReviewOutcomeId: outcomeId,
      executiveReviewId: review.executiveReviewId,
      tier: "TIER_1_REAL",
      candidateId: review.candidateId,
      opportunityId: review.opportunityId,
      executionIntentId: position.executionIntentId!,
      orderId: position.orderId,
      positionId: position.positionId!,
      outcomeId: outcome.outcomeId!,
      laneId: review.laneId,
      direction: review.direction,
      marketState: review.marketState,
      evidenceEra: review.evidenceEra,
      marketContextSnapshotId: review.marketContextSnapshotId,
      allocationSnapshotId: review.allocationSnapshotId,
      strategyAction: "ENTER",
      advisoryVerdict: review.advisoryVerdict,
      incumbentAction: "ENTERED",
      advisoryOnly: true,
      entryAtMs: position.entryAtMs!,
      resolvedAtMs: outcome.resolvedAtMs!,
      originalRisk: position.originalRisk!,
      grossR: outcome.grossR!,
      costR: outcome.costR!,
      executionCostProvenance: outcome.executionCostProvenance!,
      settlementFetchComplete: true,
      requiredOrderIds: outcome.requiredOrderIds.slice(),
      matchedRequiredOrderIds: outcome.matchedRequiredOrderIds.slice(),
      missingRequiredOrderIds: [],
      netR: outcome.netR!,
      decisionPipelinePolicyVersion: review.decisionPipelinePolicyVersion,
      executionPolicyVersion: review.executionPolicyVersion,
      evidencePolicyVersion: review.evidencePolicyVersion,
      fourBrainPolicyVersion: review.fourBrainPolicyVersion,
      eligibleForFourBrainEvaluation: true,
      eligibleForCortexLearning: false,
    };
    if (!eligibleTier1ExecutiveReview(tier1)) return this.reject(review, "NET_R_INVALID");
    review.state = "TIER1_ELIGIBLE";
    review.outcomeId = outcome.outcomeId;
    this.state.tier1.push(tier1);
    this.state.processedIds.push(outcomeId);
    if (this.state.processedIds.length > MAX_IDS) this.state.processedIds.splice(0, this.state.processedIds.length - MAX_IDS);
    return null;
  }

  private reject(review: ExecutiveReviewRecord, reason: ExecutiveReviewReasonCode): ExecutiveReviewReasonCode {
    review.state = "REJECTED";
    review.reasonCode = reason;
    if (!this.state.rejected.some((r) => r.executiveReviewId === review.executiveReviewId)) this.state.rejected.push({ ...review });
    return reason;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf8");
    renameSync(tmp, this.file);
  }
}

export function executiveReviewOutcomeId(executiveReviewId: string, positionId: string, outcomeId: string): string {
  return `executive-review-outcome:${executiveReviewId}:${positionId}:${outcomeId}`;
}

function validReviewRecord(value: ExecutiveReviewRecord): boolean {
  return value.advisoryOnly === true
    && [value.executiveReviewId, value.candidateId, value.opportunityId, value.laneId, value.marketContextSnapshotId, value.marketState, value.evidenceEra, value.decisionPipelinePolicyVersion, value.executionPolicyVersion, value.evidencePolicyVersion, value.fourBrainPolicyVersion].every((v) => typeof v === "string" && v.length > 0)
    && ["LONG", "SHORT", "NEUTRAL"].includes(value.direction)
    && ["PENDING_EXECUTION_LINK", "PENDING_OUTCOME", "TIER1_ELIGIBLE", "TIER2_ONLY", "REJECTED"].includes(value.state)
    && Number.isFinite(value.reviewedAtMs) && Number.isFinite(value.sourceCutoffMs) && value.sourceCutoffMs <= value.reviewedAtMs;
}

function positionReason(review: ExecutiveReviewRecord, position: ExecutiveReviewPositionLink): ExecutiveReviewReasonCode | null {
  if (!position.executiveReviewId) return "MISSING_EXECUTIVE_REVIEW_ID";
  if (!position.candidateId) return "MISSING_CANDIDATE_ID";
  if (!position.opportunityId) return "MISSING_OPPORTUNITY_ID";
  if (!position.executionIntentId) return "MISSING_EXECUTION_INTENT_ID";
  if (!position.orderId) return "MISSING_ORDER_ID";
  if (!position.positionId) return "MISSING_POSITION_ID";
  if (position.ambiguousOwnership) return "AMBIGUOUS_OWNERSHIP";
  if (position.executiveReviewId !== review.executiveReviewId) return "AMBIGUOUS_OWNERSHIP";
  if (position.candidateId !== review.candidateId) return "CANDIDATE_ID_MISMATCH";
  if (position.opportunityId !== review.opportunityId) return "OPPORTUNITY_ID_MISMATCH";
  if (position.laneId !== review.laneId) return "AMBIGUOUS_OWNERSHIP";
  if (position.marketContextSnapshotId !== review.marketContextSnapshotId) return "MARKET_SNAPSHOT_MISMATCH";
  const positionPolicy = [
    position.decisionPipelinePolicyVersion,
    position.executionPolicyVersion,
    position.evidencePolicyVersion,
    position.fourBrainPolicyVersion,
  ];
  if (positionPolicy.some((stamp) => !stamp)) return "POLICY_LINEAGE_INCOMPLETE";
  if (
    position.decisionPipelinePolicyVersion !== review.decisionPipelinePolicyVersion ||
    position.executionPolicyVersion !== review.executionPolicyVersion ||
    position.evidencePolicyVersion !== review.evidencePolicyVersion ||
    position.fourBrainPolicyVersion !== review.fourBrainPolicyVersion
  ) return "POLICY_VERSION_MISMATCH";
  if (position.entryAtMs == null || !Number.isFinite(position.entryAtMs)) return "ORIGINAL_RISK_MISSING";
  if (position.originalRisk == null) return "ORIGINAL_RISK_MISSING";
  if (!Number.isFinite(position.originalRisk) || position.originalRisk <= 0) return "ORIGINAL_RISK_INVALID";
  return null;
}

function outcomeReason(review: ExecutiveReviewRecord, position: ExecutiveReviewPositionLink, outcome: ExecutiveReviewOutcomeLink): ExecutiveReviewReasonCode | null {
  if (!outcome.executiveReviewId) return "MISSING_EXECUTIVE_REVIEW_ID";
  if (!outcome.opportunityId) return "MISSING_OPPORTUNITY_ID";
  if (!outcome.positionId) return "MISSING_POSITION_ID";
  if (!outcome.outcomeId) return "MISSING_OUTCOME_ID";
  if (outcome.executiveReviewId !== review.executiveReviewId || outcome.positionId !== position.positionId) return "POSITION_ID_MISMATCH";
  if (outcome.opportunityId !== review.opportunityId) return "OPPORTUNITY_ID_MISMATCH";
  if (outcome.ambiguousOwnership) return "AMBIGUOUS_OWNERSHIP";
  if (!outcome.completedCandle) return "POSITION_NOT_RESOLVED";
  const outcomePolicy = [
    outcome.decisionPipelinePolicyVersion,
    outcome.executionPolicyVersion,
    outcome.evidencePolicyVersion,
    outcome.fourBrainPolicyVersion,
  ];
  if (outcomePolicy.some((stamp) => !stamp)) return "POLICY_LINEAGE_INCOMPLETE";
  if (
    outcome.decisionPipelinePolicyVersion !== review.decisionPipelinePolicyVersion ||
    outcome.executionPolicyVersion !== review.executionPolicyVersion ||
    outcome.evidencePolicyVersion !== review.evidencePolicyVersion ||
    outcome.fourBrainPolicyVersion !== review.fourBrainPolicyVersion
  ) return "POLICY_VERSION_MISMATCH";
  if (outcome.resolvedAtMs == null || !Number.isFinite(outcome.resolvedAtMs)) return "POSITION_NOT_RESOLVED";
  if (outcome.resolvedAtMs < (position.entryAtMs ?? Infinity)) return "OUTCOME_TIME_INVALID";
  if (outcome.grossR == null || !Number.isFinite(outcome.grossR)) return "GROSS_R_INVALID";
  if (!outcome.settlementFetchComplete || outcome.missingRequiredOrderIds.length > 0) return "SETTLEMENT_INCOMPLETE";
  if (!outcome.executionCostKnown) return "EXECUTION_COST_MISSING";
  if (outcome.costR == null) return "EXECUTION_COST_MISSING";
  if (outcome.executionCostProvenance !== "EXCHANGE_MEASURED" && outcome.executionCostProvenance !== "EXECUTION_MODEL_ESTIMATE") return "EXECUTION_COST_PROVENANCE_MISSING";
  if (!Number.isFinite(outcome.costR)) return "EXECUTION_COST_NONFINITE";
  if (outcome.costR < 0) return "EXECUTION_COST_INVALID";
  if (outcome.netR == null || !Number.isFinite(outcome.netR)) return "NET_R_INVALID";
  if (Math.abs((outcome.grossR - outcome.costR) - outcome.netR) > 1e-9) return "NET_R_INVALID";
  return null;
}

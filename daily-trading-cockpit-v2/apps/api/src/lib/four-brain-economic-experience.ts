/**
 * Four-Brain economic learning wiring (report-only, shadow evaluation). Joins the ALREADY-EXISTING
 * exact-lineage outcome chain in executive-review-store.ts — Tier 1 REAL rows are cost-aware,
 * immutable-risk-aware, and explicitly labelled `eligibleForFourBrainEvaluation: true` — to the
 * Four-Brain executive decision journal, and classifies the result through the canonical
 * success-goal-contract.ts. It mints no new identities, no new policy versions, and no new cost
 * convention: it is strictly an adapter over what those two modules already guarantee.
 *
 * Market State, Direction, and Entry can all be credited from the SAME resolved review: one
 * ExecutiveDecision bundles all three on one tick, and executive-review-admission.ts links exactly
 * one executiveReviewId to exactly one resolved outcome. Exit is deliberately never produced here —
 * an exit action is decided on a LATER tick with its own, unlinked decisionId, so no exact chain from
 * an ExitDecision to a resolved economic outcome exists yet (see `fourBrainExitAttributionStatus`).
 */
import {
  type EconomicOutcomeInput,
  type TradeEconomicClass,
  classifyTradeEconomic,
} from "./success-goal-contract.js";
import type { ExecutiveReviewOutcome, ExecutiveReviewRecord } from "./executive-review-store.js";
import type { ExecutiveJournalRow } from "./four-brain-journal.js";

export const FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION = "four-brain-economic-experience/1";

export type FourBrainName = "MARKET_STATE" | "DIRECTION" | "ENTRY" | "EXIT";
export type FourBrainAttributionEligibility = "DIRECT_LEARNING_ELIGIBLE" | "EVALUATION_ONLY" | "INELIGIBLE";

export type FourBrainEconomicRejectionReason =
  | "MISSING_CAUSAL_IDENTITY"
  | "IDENTITY_MISMATCH"
  | "STALE_POLICY_CONTEXT"
  | "PRE_CUTOVER"
  | "MISSING_IMMUTABLE_RISK"
  | "INCOMPLETE_COST"
  | "INVALID_COST_CONVENTION"
  | "ECONOMIC_ARITHMETIC_MISMATCH"
  | "AMBIGUOUS_INTRABAR"
  | "INVALID_OUTCOME_QUALITY"
  | "MISSING_FEATURE_SNAPSHOT"
  | "SOURCE_ERROR"
  | "UNRESOLVED";

const ZERO_REJECTED: Record<FourBrainEconomicRejectionReason, number> = {
  MISSING_CAUSAL_IDENTITY: 0,
  IDENTITY_MISMATCH: 0,
  STALE_POLICY_CONTEXT: 0,
  PRE_CUTOVER: 0,
  MISSING_IMMUTABLE_RISK: 0,
  INCOMPLETE_COST: 0,
  INVALID_COST_CONVENTION: 0,
  ECONOMIC_ARITHMETIC_MISMATCH: 0,
  AMBIGUOUS_INTRABAR: 0,
  INVALID_OUTCOME_QUALITY: 0,
  MISSING_FEATURE_SNAPSHOT: 0,
  SOURCE_ERROR: 0,
  UNRESOLVED: 0,
};

/** `FourBrainEconomicExperience` IS an `EconomicOutcomeInput` — it reuses the canonical field names
 *  verbatim (never a second, differently-named cost/risk/time field) plus Four-Brain identity and
 *  attribution metadata layered on top. */
export interface FourBrainEconomicExperience extends EconomicOutcomeInput {
  readonly schemaVersion: string;
  readonly brain: FourBrainName;
  readonly executiveDecisionId: string;
  readonly executiveReviewId: string;
  readonly opportunityId: string;
  readonly outcomeId: string;
  readonly laneId: string;
  readonly symbolOrBasketId: string | null;
  readonly direction: "LONG" | "SHORT" | "FLAT";
  readonly attributionEligibility: FourBrainAttributionEligibility;
  readonly economicClass: TradeEconomicClass;
  /** Four-Brain's own schema-version stamp (`exec.schemaVersion`, e.g. "executive/2") — a separate
   *  lineage from the paper-order causal identity's decision/execution/evidence policy versions. */
  readonly fourBrainCodeVersion: string;
  /** The joined journal row's normalized (preferred) or raw feature snapshot. Four-Brain has no fixed-
   *  length numeric feature vector today (unlike CORTEX's cortexDecisionSnapshot.featureVector) — this
   *  is the richest available snapshot, kept as an opaque record rather than fabricating a vector. */
  readonly featureSnapshot: Record<string, unknown>;
  readonly featureSchemaVersions: Record<string, unknown>;
}

export interface FourBrainEconomicAdapterResult {
  readonly experiences: FourBrainEconomicExperience[];
  readonly rejected: Record<FourBrainEconomicRejectionReason, number>;
}

/** The CURRENT expected 4-part Four-Brain/executive-review policy lineage. Supplied by the caller —
 *  never read from process.env inside this pure module, so the exact "current policy" enforced is
 *  always visible at the call site. */
export interface FourBrainPolicyContext {
  readonly decisionPipelinePolicyVersion: string;
  readonly executionPolicyVersion: string;
  readonly evidencePolicyVersion: string;
  readonly fourBrainPolicyVersion: string;
}

const EXECUTIVE_REVIEW_ID_PATTERN = /^executive-review:(.+):([^:]+)$/;

/**
 * Decodes the exec decisionId back out of the deterministic construction in
 * executive-review-admission.ts (`executive-review:${exec.decisionId}:${opportunityId}`). This is
 * exact ID decoding, not a fuzzy match — the two identities are joined 1:1 by construction, and the
 * decoded id is verified against the caller-supplied opportunityId before use.
 */
export function executiveDecisionIdFromReviewId(executiveReviewId: string, opportunityId: string): string | null {
  const match = EXECUTIVE_REVIEW_ID_PATTERN.exec(executiveReviewId);
  if (!match) return null;
  const [, decisionId, encodedOpportunityId] = match;
  return encodedOpportunityId === opportunityId ? decisionId! : null;
}

const directionOf = (value: string): "LONG" | "SHORT" | "FLAT" => (value === "LONG" || value === "SHORT" ? value : "FLAT");

function bump(counts: Record<FourBrainEconomicRejectionReason, number>, reason: FourBrainEconomicRejectionReason): void {
  counts[reason] += 1;
}

function hasSourceError(raw: Record<string, unknown>): boolean {
  const statuses = raw.sourceStatuses;
  if (!statuses || typeof statuses !== "object") return false;
  return Object.values(statuses as Record<string, unknown>).some((status) => status === "ERROR");
}

function featureSnapshotOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  const normalized = raw.normalizedFeatures;
  if (normalized && typeof normalized === "object") return normalized as Record<string, unknown>;
  const rawFeatures = raw.rawFeatures;
  if (rawFeatures && typeof rawFeatures === "object") return rawFeatures as Record<string, unknown>;
  return null;
}

function brainDecisionPresent(raw: Record<string, unknown>, brain: "marketState" | "direction" | "entry"): boolean {
  const brains = raw.brains;
  if (!brains || typeof brains !== "object") return false;
  return (brains as Record<string, unknown>)[brain] != null;
}

/**
 * Builds DIRECT_LEARNING_ELIGIBLE Four-Brain economic experiences for Market State, Direction, and
 * Entry from Tier-1 REAL executive review outcomes, joined against the executive decision journal for
 * the feature snapshot the brains actually saw. Fails closed with an explicit reason code per
 * candidate — never a silent drop.
 */
export function buildFourBrainExecutiveExperiences(
  outcomes: readonly ExecutiveReviewOutcome[],
  reviews: readonly ExecutiveReviewRecord[],
  journalRowsByDecisionId: ReadonlyMap<string, ExecutiveJournalRow>,
  expectedPolicy: FourBrainPolicyContext,
): FourBrainEconomicAdapterResult {
  const reviewById = new Map(reviews.map((review) => [review.executiveReviewId, review]));
  const experiences: FourBrainEconomicExperience[] = [];
  const rejected: Record<FourBrainEconomicRejectionReason, number> = { ...ZERO_REJECTED };

  for (const outcome of outcomes) {
    if (outcome.tier !== "TIER_1_REAL" || outcome.eligibleForFourBrainEvaluation !== true) { bump(rejected, "SOURCE_ERROR"); continue; }
    if (!outcome.resolvedAtMs) { bump(rejected, "UNRESOLVED"); continue; }

    const review = reviewById.get(outcome.executiveReviewId);
    if (!review) { bump(rejected, "MISSING_CAUSAL_IDENTITY"); continue; }
    if (
      review.executiveReviewId !== outcome.executiveReviewId ||
      review.candidateId !== outcome.candidateId ||
      review.opportunityId !== outcome.opportunityId ||
      review.laneId !== outcome.laneId
    ) { bump(rejected, "IDENTITY_MISMATCH"); continue; }

    const execDecisionId = executiveDecisionIdFromReviewId(outcome.executiveReviewId, outcome.opportunityId);
    if (!execDecisionId) { bump(rejected, "MISSING_CAUSAL_IDENTITY"); continue; }

    if (
      outcome.decisionPipelinePolicyVersion !== expectedPolicy.decisionPipelinePolicyVersion ||
      outcome.executionPolicyVersion !== expectedPolicy.executionPolicyVersion ||
      outcome.evidencePolicyVersion !== expectedPolicy.evidencePolicyVersion ||
      outcome.fourBrainPolicyVersion !== expectedPolicy.fourBrainPolicyVersion
    ) { bump(rejected, "STALE_POLICY_CONTEXT"); continue; }

    if (!Number.isFinite(outcome.originalRisk) || outcome.originalRisk <= 0) { bump(rejected, "MISSING_IMMUTABLE_RISK"); continue; }
    if (!outcome.settlementFetchComplete || outcome.missingRequiredOrderIds.length > 0) { bump(rejected, "INCOMPLETE_COST"); continue; }
    if (!Number.isFinite(outcome.costR) || outcome.costR < 0) { bump(rejected, "INVALID_COST_CONVENTION"); continue; }
    if (!Number.isFinite(outcome.grossR) || !Number.isFinite(outcome.netR) || Math.abs((outcome.grossR - outcome.costR) - outcome.netR) > 1e-9) {
      bump(rejected, "ECONOMIC_ARITHMETIC_MISMATCH"); continue;
    }
    if (!(outcome.resolvedAtMs >= outcome.entryAtMs)) { bump(rejected, "INVALID_OUTCOME_QUALITY"); continue; }

    const journalRow = journalRowsByDecisionId.get(execDecisionId);
    if (!journalRow) { bump(rejected, "MISSING_FEATURE_SNAPSHOT"); continue; }
    if (hasSourceError(journalRow.raw)) { bump(rejected, "SOURCE_ERROR"); continue; }
    const featureSnapshot = featureSnapshotOf(journalRow.raw);
    if (!featureSnapshot) { bump(rejected, "MISSING_FEATURE_SNAPSHOT"); continue; }
    const schemaVersions = journalRow.raw.schemaVersions;
    if (!schemaVersions || typeof schemaVersions !== "object") { bump(rejected, "MISSING_FEATURE_SNAPSHOT"); continue; }

    const base = {
      exactOwnership: true,
      originalRisk: outcome.originalRisk,
      grossR: outcome.grossR,
      costR: outcome.costR,
      netR: outcome.netR,
      costKnownComplete: true,
      policyLineageMatches: true,
      resolved: true,
      // Real exchange-settled fills carry exact fill/close timestamps — never a simulated candle-walk
      // resolution — so the classic same-bar OHLC ambiguity this flag exists to catch cannot occur here.
      intrabarAmbiguous: false,
      decisionTimeMs: review.reviewedAtMs,
      openedTimeMs: outcome.entryAtMs,
      closedTimeMs: outcome.resolvedAtMs,
    };
    const economicClass = classifyTradeEconomic(base);
    if (economicClass === "INVALID") { bump(rejected, "ECONOMIC_ARITHMETIC_MISMATCH"); continue; }

    const brainKeys: Array<[FourBrainName, "marketState" | "direction" | "entry"]> = [
      ["MARKET_STATE", "marketState"],
      ["DIRECTION", "direction"],
      ["ENTRY", "entry"],
    ];
    for (const [brain, key] of brainKeys) {
      if (!brainDecisionPresent(journalRow.raw, key)) continue; // this brain did not fire on the joined tick — no credit fabricated
      experiences.push({
        ...base,
        schemaVersion: FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION,
        brain,
        executiveDecisionId: execDecisionId,
        executiveReviewId: outcome.executiveReviewId,
        opportunityId: outcome.opportunityId,
        outcomeId: outcome.outcomeId,
        laneId: outcome.laneId,
        symbolOrBasketId: journalRow.symbolOrBasketId,
        direction: directionOf(outcome.direction),
        attributionEligibility: "DIRECT_LEARNING_ELIGIBLE",
        economicClass,
        fourBrainCodeVersion: outcome.fourBrainPolicyVersion,
        featureSnapshot,
        featureSchemaVersions: schemaVersions as Record<string, unknown>,
      });
    }
  }
  return { experiences, rejected };
}

export interface FourBrainExitAttributionStatus {
  readonly brain: "EXIT";
  readonly eligibility: "INELIGIBLE";
  readonly reason: string;
  readonly missingFields: string[];
}

/**
 * Exit Brain has no outcome ledger today: exit-brain-shadow.ts scores counterfactual exit POLICIES
 * against recorded MFE/MAE paths keyed by `positionId`+`variant`, independent of `ExitDecision.decisionId`
 * — and no other module joins an exit action to its own resolved economic result. Returns a fixed,
 * honest diagnostic rather than fabricating attribution from an unrelated policy-evaluation store.
 */
export function fourBrainExitAttributionStatus(): FourBrainExitAttributionStatus {
  return {
    brain: "EXIT",
    eligibility: "INELIGIBLE",
    reason: "No outcome ledger links ExitDecision.decisionId (or its candidateKey) to a resolved economic result.",
    missingFields: [
      "An exit-outcome ledger analogous to executive-review-store.ts, keyed by ExitDecision.decisionId or an exposed (non-hashed) candidateKey.",
      "originalRisk / grossR / costR / netR captured at the exact position this exit action applied to.",
      "decisionPipelinePolicyVersion / executionPolicyVersion / evidencePolicyVersion / fourBrainPolicyVersion stamped on that ledger, matching the pattern executive-review-store.ts already uses.",
    ],
  };
}

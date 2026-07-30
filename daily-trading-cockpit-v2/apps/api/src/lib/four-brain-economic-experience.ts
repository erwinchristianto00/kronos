/**
 * Four-Brain economic learning wiring (report-only, shadow evaluation). Joins the ALREADY-EXISTING
 * exact-lineage outcome chain in executive-review-store.ts — Tier 1 REAL rows are cost-aware,
 * immutable-risk-aware, and explicitly labelled `eligibleForFourBrainEvaluation: true` — to the
 * additive Four-Brain identity/decision-snapshot fields persisted on that SAME outcome at admission
 * time (see FourBrainExecutiveIdentity in executive-review-store.ts), and classifies the result
 * through the canonical success-goal-contract.ts. It mints no new identities, no new policy versions,
 * and no new cost convention: it is strictly an adapter over what those two modules already
 * guarantee.
 *
 * Three-level eligibility, not two: an outcome that fails a hard gate (identity mismatch, incomplete
 * cost, bad arithmetic, wrong cohort) is INELIGIBLE and produces no experience at all. An outcome that
 * passes every hard gate but is missing one of the NEW exact fields this hardening added — a legacy
 * record from before this shipped, a missing persisted feature snapshot, a missing dedicated close
 * time, or a brain whose own decision object is absent/inexact — is DIRECT_LEARNING_ELIGIBLE for
 * nothing; it is EVALUATION_ONLY, with the specific reason(s) recorded, never silently dropped. Only
 * an outcome with every exact field present, verified, and internally consistent reaches
 * DIRECT_LEARNING_ELIGIBLE, and even then independently per brain — Market State, Direction, and
 * Entry each need their OWN exact match, not just "an object happened to be present."
 *
 * Market State, Direction, and Entry can all be credited from the SAME resolved outcome — one
 * ExecutiveDecision bundles all three on one tick, and executive-review-admission.ts links exactly
 * one review to exactly one resolved outcome. Exit is deliberately never produced here — an exit
 * action is decided on a LATER tick with its own, unlinked decisionId, so no exact chain from an
 * ExitDecision to a resolved economic outcome exists yet (see `fourBrainExitAttributionStatus`).
 */
import {
  type EconomicOutcomeInput,
  type TradeEconomicClass,
  classifyTradeEconomic,
} from "./success-goal-contract.js";
import type { ExecutiveReviewOutcome } from "./executive-review-store.js";
import type { DirectionDecision, MarketStateDecision } from "./four-brain-types.js";

export const FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION = "four-brain-economic-experience/2";

export type FourBrainName = "MARKET_STATE" | "DIRECTION" | "ENTRY" | "EXIT";
export type FourBrainAttributionEligibility = "DIRECT_LEARNING_ELIGIBLE" | "EVALUATION_ONLY" | "INELIGIBLE";

/** Hard failures: the outcome as a whole is unusable, no experience is produced for any brain. */
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

/** Soft caps: the outcome (or one specific brain) is real and usable, but not exact enough yet for
 *  direct learning. Never silently dropped — always recorded on the experience that carries them. */
export type FourBrainEvaluationOnlyReason =
  | "LEGACY_UNSTAMPED_RECORD"
  | "MISSING_FEATURE_SNAPSHOT"
  | "MISSING_ENTRY_FILL_TIME"
  | "MISSING_MARKET_CLOSE_TIME"
  | "MISSING_SETTLEMENT_RESOLUTION_TIME"
  | "BRAIN_DECISION_ABSENT"
  | "BRAIN_DECISION_INEXACT";

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
  /** Null only for a legacy (pre-hardening) outcome — such a record is always capped at
   *  EVALUATION_ONLY; see LEGACY_UNSTAMPED_RECORD. */
  readonly executiveDecisionId: string | null;
  readonly instanceId: string | null;
  readonly opportunityId: string;
  readonly outcomeId: string;
  readonly laneId: string;
  readonly symbolOrBasketId: string | null;
  readonly direction: "LONG" | "SHORT" | "FLAT";
  readonly attributionEligibility: FourBrainAttributionEligibility;
  readonly evaluationOnlyReasons: readonly FourBrainEvaluationOnlyReason[];
  readonly economicClass: TradeEconomicClass;
  readonly fourBrainCodeVersion: string;
  readonly featureSnapshot: Record<string, unknown> | null;
  readonly featureSchemaVersions: Record<string, unknown> | null;
}

export interface FourBrainEconomicAdapterResult {
  readonly experiences: FourBrainEconomicExperience[];
  readonly rejected: Record<FourBrainEconomicRejectionReason, number>;
}

/** The CURRENT expected exact policy/cohort context. Supplied by the caller — never read from
 *  process.env or derived from the data being classified, so the exact "current policy" enforced is
 *  always visible at the call site, and 3101/3102 can never be blended without the caller explicitly
 *  choosing to run this adapter twice with two different contexts. */
export interface FourBrainPolicyContext {
  readonly instanceId: "3101" | "3102";
  readonly decisionPipelinePolicyVersion: string;
  readonly executionPolicyVersion: string;
  readonly evidencePolicyVersion: string;
  readonly evidenceEra: string;
  readonly fourBrainPolicyVersion: string;
  readonly policyDeploymentAt: string;
}

const EXECUTIVE_REVIEW_ID_PATTERN = /^executive-review:(.+):([^:]+)$/;

/**
 * Decodes the exec decisionId out of the deterministic construction in executive-review-admission.ts
 * (`executive-review:${exec.decisionId}:${opportunityId}`) for DIAGNOSTIC use on legacy records only
 * (records predating the persisted `executiveDecisionId` field). The adapter itself never calls this
 * to determine eligibility — a decisionId recovered this way can only ever support EVALUATION_ONLY.
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

interface BrainCheck {
  readonly present: boolean;
  readonly exact: boolean;
  readonly reasons: readonly FourBrainEvaluationOnlyReason[];
}

function marketStateCheck(decision: MarketStateDecision | null | undefined): BrainCheck {
  if (!decision) return { present: false, exact: false, reasons: ["BRAIN_DECISION_ABSENT"] };
  return { present: true, exact: true, reasons: [] };
}

function directionCheck(decision: DirectionDecision | null | undefined, outcomeDirection: "LONG" | "SHORT" | "FLAT"): BrainCheck {
  if (!decision) return { present: false, exact: false, reasons: ["BRAIN_DECISION_ABSENT"] };
  if (decision.marketDirection !== outcomeDirection) return { present: true, exact: false, reasons: ["BRAIN_DECISION_INEXACT"] };
  return { present: true, exact: true, reasons: [] };
}

/**
 * Entry needs a genuinely exact chain, not just a present decision object and "some fill exists
 * somewhere": the persisted entryDecisionId must match the snapshot's own decisionId (never stamped
 * from a different tick), the persisted decided side/target/stop must exactly equal the immutable
 * nested Entry snapshot (not just independently look plausible), a real selected paper order AND its
 * exact exchange entry order id must both be identified, that SPECIFIC exact order id must be a
 * member of the CONFIRMED fill order ids (never merely "the array is non-empty" — a fill belonging to
 * a different order must not count), and the actual fill price/time must be present. The decided
 * target price is deliberately never required to equal the actual fill price: both are persisted so a
 * downstream consumer can judge execution slippage itself, not so this gate can reject on it.
 */
function entryCheck(outcome: ExecutiveReviewOutcome, outcomeDirection: "LONG" | "SHORT" | "FLAT"): BrainCheck {
  const decision = outcome.entryDecision;
  if (!decision) return { present: false, exact: false, reasons: ["BRAIN_DECISION_ABSENT"] };
  const decisionShapeValid =
    decision.action === "ENTER_NOW" &&
    decision.side === outcomeDirection &&
    Number.isFinite(decision.targetEntry) &&
    Number.isFinite(decision.initialStopPrice);
  const exactChainLinked =
    !!outcome.entryDecisionId && outcome.entryDecisionId === decision.decisionId &&
    outcome.decidedSide === decision.side &&
    outcome.decidedTargetEntry === decision.targetEntry &&
    outcome.decidedInitialStop === decision.initialStopPrice &&
    !!outcome.paperOrderId &&
    !!outcome.orderId &&
    Array.isArray(outcome.entryFillOrderIds) && outcome.entryFillOrderIds.includes(outcome.orderId) &&
    outcome.entryFilledAtMs != null &&
    typeof outcome.actualEntryPrice === "number" && Number.isFinite(outcome.actualEntryPrice);
  if (!decisionShapeValid || !exactChainLinked) return { present: true, exact: false, reasons: ["BRAIN_DECISION_INEXACT"] };
  return { present: true, exact: true, reasons: [] };
}

/**
 * Builds Four-Brain economic experiences for Market State, Direction, and Entry from Tier-1 REAL
 * executive review outcomes. `nowMs` is caller-supplied (never Date.now() internally) so the
 * "policyDeploymentAt is not in the future" check stays a pure function of its inputs. Fails closed
 * with an explicit reason code per candidate at the outcome level; never a silent drop. A record or
 * brain that is real but not yet exact enough is EVALUATION_ONLY with explicit reasons, never
 * DIRECT_LEARNING_ELIGIBLE and never simply omitted.
 */
export function buildFourBrainExecutiveExperiences(
  outcomes: readonly ExecutiveReviewOutcome[],
  expectedPolicy: FourBrainPolicyContext,
  nowMs: number,
): FourBrainEconomicAdapterResult {
  const experiences: FourBrainEconomicExperience[] = [];
  const rejected: Record<FourBrainEconomicRejectionReason, number> = { ...ZERO_REJECTED };

  for (const outcome of outcomes) {
    if (outcome.tier !== "TIER_1_REAL" || outcome.eligibleForFourBrainEvaluation !== true) { bump(rejected, "SOURCE_ERROR"); continue; }
    if (!outcome.resolvedAtMs) { bump(rejected, "UNRESOLVED"); continue; }
    if (!Number.isFinite(outcome.originalRisk) || outcome.originalRisk <= 0) { bump(rejected, "MISSING_IMMUTABLE_RISK"); continue; }
    if (!outcome.settlementFetchComplete || outcome.missingRequiredOrderIds.length > 0) { bump(rejected, "INCOMPLETE_COST"); continue; }
    if (!Number.isFinite(outcome.costR) || outcome.costR < 0) { bump(rejected, "INVALID_COST_CONVENTION"); continue; }
    if (!Number.isFinite(outcome.grossR) || !Number.isFinite(outcome.netR) || Math.abs((outcome.grossR - outcome.costR) - outcome.netR) > 1e-9) {
      bump(rejected, "ECONOMIC_ARITHMETIC_MISMATCH"); continue;
    }
    if (!(outcome.resolvedAtMs >= outcome.entryAtMs)) { bump(rejected, "INVALID_OUTCOME_QUALITY"); continue; }

    // ---- Exact policy/cohort context: hard-reject a WRONG cohort; soft-cap an ABSENT one. ----
    const baseReasons: FourBrainEvaluationOnlyReason[] = [];
    const hasStampedIdentity = outcome.executiveDecisionId != null && outcome.instanceId != null
      && outcome.policyDeploymentAt != null && outcome.executiveDecisionTimeMs != null;

    if (!hasStampedIdentity) {
      baseReasons.push("LEGACY_UNSTAMPED_RECORD");
    } else {
      if (outcome.instanceId !== expectedPolicy.instanceId) { bump(rejected, "IDENTITY_MISMATCH"); continue; }
      if (
        outcome.decisionPipelinePolicyVersion !== expectedPolicy.decisionPipelinePolicyVersion ||
        outcome.executionPolicyVersion !== expectedPolicy.executionPolicyVersion ||
        outcome.evidencePolicyVersion !== expectedPolicy.evidencePolicyVersion ||
        outcome.evidenceEra !== expectedPolicy.evidenceEra ||
        outcome.fourBrainPolicyVersion !== expectedPolicy.fourBrainPolicyVersion ||
        // Direct persisted-cutover equality — NOT inferred from decision/open-clock ordering below.
        // An outcome stamped under a different (even if earlier and internally-consistent) deployment
        // generation is a stale cohort, not merely a pre-cutover one.
        outcome.policyDeploymentAt !== expectedPolicy.policyDeploymentAt
      ) { bump(rejected, "STALE_POLICY_CONTEXT"); continue; }
      const deploymentMs = Date.parse(expectedPolicy.policyDeploymentAt);
      if (!Number.isFinite(deploymentMs) || deploymentMs > nowMs) { bump(rejected, "STALE_POLICY_CONTEXT"); continue; }
      // The exact entry-FILL clock decides pre-cutover status when it is known — never the intent-
      // creation clock (entryAtMs/intentCreatedAtMs). When the fill clock is not yet known this term
      // is simply skipped (never treated as pre-cutover on that basis alone); the record is already
      // soft-capped below via MISSING_ENTRY_FILL_TIME. A position whose INTENT predates cutover but
      // whose ACTUAL FILL lands after it is judged by the fill, not the intent.
      if (
        outcome.executiveDecisionTimeMs! < deploymentMs ||
        (outcome.entryFilledAtMs != null && outcome.entryFilledAtMs < deploymentMs)
      ) { bump(rejected, "PRE_CUTOVER"); continue; }
      // Only after every check above has genuinely passed — never set defensively/optimistically.
    }
    const policyLineageMatches = hasStampedIdentity;

    if (!outcome.brainFeatureSnapshot) baseReasons.push("MISSING_FEATURE_SNAPSHOT");
    // Shared by ALL brains, not just Entry: Market State and Direction are credited from the SAME
    // resolved outcome, so if the trade's own exact lifecycle clocks are unavailable none of the
    // three can honestly claim to be learning from an exactly-timed, fully-resolved example.
    if (outcome.entryFilledAtMs == null) baseReasons.push("MISSING_ENTRY_FILL_TIME");
    if (outcome.marketClosedAtMs == null) baseReasons.push("MISSING_MARKET_CLOSE_TIME");
    // settlementFetchComplete (hard-gated above) proves the COST is exact; it does not prove WHEN
    // settlement completeness was established — a record from before that capture existed can have
    // settlementFetchComplete:true yet no settlementResolvedAtMs. Soft-cap those, never hard-reject:
    // the economics are still usable, only this one clock is unavailable.
    if (outcome.settlementResolvedAtMs == null) baseReasons.push("MISSING_SETTLEMENT_RESOLUTION_TIME");

    // Exact clock chain — decision <= fill <= close <= settlement — checked ONLY among clocks that
    // are ALL present (an absent one is already soft-capped above via the MISSING_* reasons; a
    // comparison against a missing clock would be meaningless, not a violation). Equal timestamps are
    // valid. A PRESENT but non-monotonic chain is a genuine outcome-quality defect, hard-rejected —
    // never merely soft-capped.
    if (
      hasStampedIdentity &&
      outcome.entryFilledAtMs != null && outcome.marketClosedAtMs != null && outcome.settlementResolvedAtMs != null &&
      (
        outcome.executiveDecisionTimeMs! > outcome.entryFilledAtMs ||
        outcome.entryFilledAtMs > outcome.marketClosedAtMs ||
        outcome.marketClosedAtMs > outcome.settlementResolvedAtMs
      )
    ) { bump(rejected, "INVALID_OUTCOME_QUALITY"); continue; }

    // decisionTimeMs/openedTimeMs/closedTimeMs: the EXACT fields when present; a best-effort LEGACY
    // proxy only for an EVALUATION_ONLY record's economic classification — never presented as exact
    // and never a basis for DIRECT_LEARNING_ELIGIBLE (that is judged solely by evaluationOnlyReasons
    // and the hard gates above). entryAtMs/intentCreatedAtMs/resolvedAtMs/exactCloseTimeMs are
    // legacy/compatibility fields, read here only as this classification fallback.
    const decisionTimeMs = outcome.executiveDecisionTimeMs ?? outcome.entryAtMs;
    const openedTimeMs = outcome.entryFilledAtMs ?? outcome.entryAtMs;
    const closedTimeMs = outcome.marketClosedAtMs ?? outcome.resolvedAtMs;

    const base = {
      exactOwnership: true,
      originalRisk: outcome.originalRisk,
      grossR: outcome.grossR,
      costR: outcome.costR,
      netR: outcome.netR,
      costKnownComplete: true,
      policyLineageMatches,
      resolved: true,
      // Real exchange-settled fills carry exact fill/close timestamps — never a simulated candle-walk
      // resolution — so the classic same-bar OHLC ambiguity this flag exists to catch cannot occur here.
      intrabarAmbiguous: false,
      decisionTimeMs,
      openedTimeMs,
      closedTimeMs,
    };
    // Every condition classifyTradeEconomic checks other than policyLineageMatches has already been
    // hard-gated above, so the only way this can still read INVALID is an unverified (legacy) cohort
    // — an honest classification for that case, not a signal to drop the experience: attribution
    // eligibility is judged by evaluationOnlyReasons, not by this field.
    const economicClass = classifyTradeEconomic(base);

    const outcomeDirection = directionOf(outcome.direction);
    const brainChecks: Array<[FourBrainName, BrainCheck]> = [
      ["MARKET_STATE", marketStateCheck(outcome.marketStateDecision)],
      ["DIRECTION", directionCheck(outcome.directionDecision, outcomeDirection)],
      ["ENTRY", entryCheck(outcome, outcomeDirection)],
    ];

    for (const [brain, check] of brainChecks) {
      const evaluationOnlyReasons = [...baseReasons, ...check.reasons];
      const attributionEligibility: FourBrainAttributionEligibility =
        evaluationOnlyReasons.length === 0 ? "DIRECT_LEARNING_ELIGIBLE" : "EVALUATION_ONLY";
      experiences.push({
        ...base,
        schemaVersion: FOUR_BRAIN_ECONOMIC_SCHEMA_VERSION,
        brain,
        executiveDecisionId: outcome.executiveDecisionId ?? null,
        instanceId: outcome.instanceId ?? null,
        opportunityId: outcome.opportunityId,
        outcomeId: outcome.outcomeId,
        laneId: outcome.laneId,
        symbolOrBasketId: outcome.symbolOrBasketId ?? null,
        direction: outcomeDirection,
        attributionEligibility,
        evaluationOnlyReasons,
        economicClass,
        fourBrainCodeVersion: outcome.fourBrainPolicyVersion,
        featureSnapshot: outcome.brainFeatureSnapshot ?? null,
        featureSchemaVersions: outcome.brainFeatureSchemaVersions ?? null,
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
      "instanceId / decisionPipelinePolicyVersion / executionPolicyVersion / evidencePolicyVersion / evidenceEra / fourBrainPolicyVersion / policyDeploymentAt stamped on that ledger, matching the pattern executive-review-store.ts already uses.",
    ],
  };
}

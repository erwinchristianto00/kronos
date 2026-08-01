/**
 * CORTEX Shadow Refit/Learner v1.
 *
 * This module is deliberately an offline/report-only boundary. It consumes immutable
 * Executive Review outcomes plus their exact forward-causal CORTEX decision snapshot,
 * writes candidate coefficients to a separate registry, and has no dependency on an
 * allocator, execution engine, or mutable incumbent CORTEX store.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  CORTEX_FEATURE_DIM,
  CORTEX_FEATURE_SCHEMA_VERSION,
  cortexArchetypeForLane,
  type CortexArchetype,
  type CortexStoreState,
} from "./cortex-brain.js";
import { refitCortexEconomicModel, type CortexEconomicFit } from "./cortex-economic-model.js";
import {
  buildFourBrainExecutiveExperiences,
  type FourBrainPolicyContext,
} from "./four-brain-economic-experience.js";
import type { ExecutiveReviewOutcome } from "./executive-review-store.js";
import {
  buildCortexExperienceBridge,
  type CortexExperienceBridgeResult,
} from "../experience-engine/cortex-experience-bridge.js";
import type { CanonicalPolicyContext, ForwardEvent } from "../experience-engine/forward-causal-collection.js";

export const CORTEX_SHADOW_REFIT_SCHEMA_VERSION = "cortex-shadow-refit/3" as const;
export const CORTEX_SHADOW_REFIT_DEFAULT_EPOCH = "2026-08-01T07:19:35.000Z";
export const CORTEX_SHADOW_REFIT_REGISTRY_FILE = "cortex-shadow-refit-candidates.json";
export const CORTEX_SHADOW_REFIT_SCHEDULER_ENV = "CORTEX_SHADOW_REFIT_SCHEDULER_ENABLED";

export const CORTEX_SHADOW_REFIT_HYPERPARAMETERS = {
  halfLifeDays: 45,
  ridge: 1,
  huberK: 1.5,
  minEffectiveN: 20,
  maxJump: 8,
  minTrainExamples: 20,
  minOosExamples: 8,
  folds: 3,
  purgeMs: 0,
} as const;
export type CortexShadowRefitHyperparameters = typeof CORTEX_SHADOW_REFIT_HYPERPARAMETERS;

export type CortexShadowRejectionReason =
  | "DUPLICATE_OUTCOME"
  | "PRE_RESET_EPOCH"
  | "FOUR_BRAIN_NOT_DIRECT"
  | "FORWARD_CAUSAL_INELIGIBLE"
  | "MISSING_EXACT_CORTEX_SNAPSHOT"
  | "FEATURE_SCHEMA_MISMATCH"
  | "UNKNOWN_CONTEXT"
  | "LINEAGE_MISMATCH"
  | "INVALID_OR_INCOMPLETE_COST"
  | "INVALID_IMMUTABLE_RISK"
  | "CORTEX_SNAPSHOT_VECTOR_MISMATCH"
  | "CORTEX_DECISION_IDENTITY_MISMATCH"
  | "CORTEX_POLICY_LINEAGE_MISMATCH";

export type CortexShadowRunStatus = "CANDIDATE_CREATED" | "NO_NEW_ELIGIBLE_DATA" | "NO_REFIT" | "BLOCKED";

export interface CortexShadowTrainingExample {
  readonly exampleId: string;
  readonly decisionId: string;
  readonly opportunityId: string;
  readonly outcomeId: string;
  readonly laneId: string;
  readonly symbolOrBasketId: string;
  readonly direction: "LONG" | "SHORT";
  readonly archetype: CortexArchetype;
  readonly regimeFamily: string;
  readonly decisionTimeMs: number;
  readonly openedTimeMs: number;
  readonly closedTimeMs: number;
  readonly resolvedTimeMs: number;
  readonly x: readonly number[];
  readonly netR: number;
  readonly policyDeploymentAt: string;
}

export interface CortexShadowDataset {
  readonly resetEpoch: string;
  readonly examined: number;
  readonly examples: readonly CortexShadowTrainingExample[];
  readonly rejected: Readonly<Record<CortexShadowRejectionReason, number>>;
  readonly archivedPreEpoch: number;
  readonly datasetHash: string;
  readonly sourceLineage: { executiveOutcomeIds: readonly string[]; forwardEventCount: number };
}

export interface CortexShadowMetrics {
  readonly n: number;
  readonly netR: number;
  readonly averageNetR: number | null;
  readonly profitFactor: number | null;
  readonly winRate: number | null;
  readonly payoffRatio: number | null;
  readonly maxDrawdownR: number | null;
  readonly calibrationMae: number | null;
  readonly contextDistribution: Readonly<Record<string, number>>;
  readonly symbolConcentrationPct: number | null;
}

export interface CortexShadowFoldResult {
  readonly fold: number;
  readonly trainStartMs: number | null;
  readonly trainEndMs: number | null;
  /** The only recency-weighting clock allowed for this fold: the final resolved training row. */
  readonly trainingCutoffMs: number | null;
  readonly oosStartMs: number | null;
  readonly oosEndMs: number | null;
  readonly trainN: number;
  readonly oosN: number;
  /** Exact expanding-window membership, persisted to prove no held-out row trained its own fold. */
  readonly trainExampleIds: readonly string[];
  /** Exact held-out rows only. Aggregate OOS is built exclusively from these immutable snapshots. */
  readonly heldOut: readonly CortexShadowHeldOutPrediction[];
  readonly fitStatus: CortexEconomicFit["status"] | "NO_FOLD";
  readonly candidate: CortexShadowMetrics;
  readonly incumbent: CortexShadowMetrics;
  readonly expectedEconomicDeltaR: number | null;
}

export interface CortexShadowHeldOutPrediction {
  readonly exampleId: string;
  readonly opportunityId: string;
  readonly decisionTimeMs: number;
  readonly resolvedTimeMs: number;
  readonly netR: number;
  readonly regimeFamily: string;
  readonly symbolOrBasketId: string;
  readonly candidatePrediction: number | null;
  readonly incumbentPrediction: number | null;
}

export interface CortexShadowArchetypeCandidate {
  readonly archetype: CortexArchetype;
  readonly n: number;
  readonly nEff: number;
  readonly coefficients: readonly number[];
  readonly incumbentCoefficients: readonly number[];
  readonly fitStatus: CortexEconomicFit["status"] | "NO_REFIT";
  readonly folds: readonly CortexShadowFoldResult[];
  readonly train: CortexShadowMetrics;
  readonly oos: CortexShadowMetrics;
  readonly expectedEconomicDeltaR: number | null;
  readonly coefficientMaxDelta: number;
  readonly blockers: readonly string[];
  readonly cautions: readonly string[];
}

export interface CortexShadowCandidateGeneration {
  readonly generationId: string;
  readonly generationFingerprint: string;
  readonly integrityHash: string;
  readonly parentIncumbentGeneration: number;
  readonly incumbentCoefficientFingerprint: string;
  readonly createdAt: string;
  readonly resetEpoch: string;
  readonly trainingCutoffMs: number;
  readonly featureSchemaVersion: number;
  readonly datasetHash: string;
  readonly exampleIds: readonly string[];
  readonly sourceLineage: CortexShadowDataset["sourceLineage"];
  readonly hyperparameters: CortexShadowRefitHyperparameters;
  readonly archetypes: readonly CortexShadowArchetypeCandidate[];
  readonly shadowReady: false;
  readonly blockers: readonly string[];
  readonly cautions: readonly string[];
  readonly codeVersion: string;
}

export interface CortexShadowRefitRegistry {
  readonly schemaVersion: typeof CORTEX_SHADOW_REFIT_SCHEMA_VERSION;
  readonly integrityStatus: "HEALTHY" | "REGISTRY_CORRUPTED";
  readonly integrityError: string | null;
  /** Covers every persisted audit/readiness field as well as candidate content. */
  readonly registryIntegrityHash: string;
  readonly candidates: readonly CortexShadowCandidateGeneration[];
  readonly lastDatasetHash: string | null;
  readonly lastGenerationFingerprint: string | null;
  readonly lastAudit: CortexShadowRunReport | null;
}

export interface CortexShadowRunReport {
  readonly status: CortexShadowRunStatus;
  readonly generatedAt: string;
  readonly resetEpoch: string;
  readonly dataset: CortexShadowDataset;
  readonly candidate: CortexShadowCandidateGeneration | null;
  readonly beta: { evaluationBeta: 0; liveBeta: 0 };
  readonly blockers: readonly string[];
}

const ARCHETYPES: readonly CortexArchetype[] = ["BREADTH", "NEUTRAL", "TACTICAL"];
const emptyRejections = (): Record<CortexShadowRejectionReason, number> => ({
  DUPLICATE_OUTCOME: 0,
  PRE_RESET_EPOCH: 0,
  FOUR_BRAIN_NOT_DIRECT: 0,
  FORWARD_CAUSAL_INELIGIBLE: 0,
  MISSING_EXACT_CORTEX_SNAPSHOT: 0,
  FEATURE_SCHEMA_MISMATCH: 0,
  UNKNOWN_CONTEXT: 0,
  LINEAGE_MISMATCH: 0,
  INVALID_OR_INCOMPLETE_COST: 0,
  INVALID_IMMUTABLE_RISK: 0,
  CORTEX_SNAPSHOT_VECTOR_MISMATCH: 0,
  CORTEX_DECISION_IDENTITY_MISMATCH: 0,
  CORTEX_POLICY_LINEAGE_MISMATCH: 0,
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = <T>(items: readonly T[], compare: (a: T, b: T) => number): T[] => [...items].sort(compare);

function fourBrainDirectOutcomeIds(outcomes: readonly ExecutiveReviewOutcome[], policy: FourBrainPolicyContext, nowMs: number): Set<string> {
  const byOutcome = new Map<string, Set<string>>();
  for (const row of buildFourBrainExecutiveExperiences(outcomes, policy, nowMs).experiences) {
    if (row.attributionEligibility !== "DIRECT_LEARNING_ELIGIBLE") continue;
    const set = byOutcome.get(row.outcomeId) ?? new Set<string>();
    set.add(row.brain);
    byOutcome.set(row.outcomeId, set);
  }
  return new Set([...byOutcome].filter(([, brains]) => brains.has("MARKET_STATE") && brains.has("DIRECTION") && brains.has("ENTRY")).map(([id]) => id));
}

const equalVector = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

type ForwardDecision = Extract<ForwardEvent, { eventType: "DECISION_SNAPSHOT" }>;
type ForwardOpen = Extract<ForwardEvent, { eventType: "OPPORTUNITY_OPEN" }>;
type ForwardOutcome = Extract<ForwardEvent, { eventType: "OUTCOME_RESOLUTION" }>;

/** Every identity comparison is exact. This is intentionally stricter than the bridge: the bridge
 * proves its own causal chain, while this boundary proves that Executive Review, the raw decision
 * snapshot, the bridge representation, and the reconstructed lane slice are the SAME decision. */
function snapshotConsistencyReason(input: {
  outcome: ExecutiveReviewOutcome;
  experience: CortexExperienceBridgeResult["experiences"][number] | undefined;
  decision: CortexExperienceBridgeResult["decisions"][number] | undefined;
  forwardDecision: ForwardDecision | undefined;
  forwardOpen: ForwardOpen | undefined;
  forwardOutcome: ForwardOutcome | undefined;
  policy: CanonicalPolicyContext & { instanceId: "3101" | "3102"; fourBrainPolicyVersion: string };
}): CortexShadowRejectionReason | null {
  const { outcome, experience, decision, forwardDecision, forwardOpen, forwardOutcome, policy } = input;
  if (!forwardDecision || !forwardOpen || !forwardOutcome) return "FORWARD_CAUSAL_INELIGIBLE";
  const identities = [forwardDecision.identity, forwardOpen.identity, forwardOutcome.identity];
  const policyMatches = identities.every((identity) =>
    identity.instanceId === policy.instanceId &&
    identity.decisionPolicyVersion === policy.decisionPolicyVersion &&
    identity.executionPolicyVersion === policy.executionPolicyVersion &&
    identity.evidencePolicyVersion === policy.evidencePolicyVersion &&
    identity.evidenceEra === policy.evidenceEra &&
    identity.policyDeploymentAt === policy.policyDeploymentAt,
  ) && outcome.instanceId === policy.instanceId &&
    outcome.decisionPipelinePolicyVersion === policy.decisionPolicyVersion &&
    outcome.executionPolicyVersion === policy.executionPolicyVersion &&
    outcome.evidencePolicyVersion === policy.evidencePolicyVersion &&
    outcome.evidenceEra === policy.evidenceEra &&
    outcome.fourBrainPolicyVersion === policy.fourBrainPolicyVersion &&
    outcome.policyDeploymentAt === policy.policyDeploymentAt;
  if (!policyMatches) return "CORTEX_POLICY_LINEAGE_MISMATCH";
  if (!experience || !decision) return "FORWARD_CAUSAL_INELIGIBLE";
  const symbol = outcome.symbolOrBasketId;
  const identityMatches = !!symbol && identities.every((identity) =>
    identity.opportunityId === outcome.opportunityId && identity.outcomeId === outcome.outcomeId &&
    identity.laneId === outcome.laneId && identity.symbolOrBasketId === symbol &&
    identity.direction === outcome.direction && identity.allocationSnapshotId === outcome.allocationSnapshotId,
  ) && forwardDecision.identity.cortexDecisionId === forwardDecision.cortexTraining.decisionId &&
    forwardDecision.identity.cortexFeatureSchemaVersion === forwardDecision.cortexTraining.featureSchemaVersion &&
    forwardDecision.asOfMs === outcome.executiveDecisionTimeMs &&
    forwardOpen.decisionId === forwardDecision.identity.decisionId && forwardOutcome.decisionId === forwardDecision.identity.decisionId &&
    forwardOutcome.opportunityId === outcome.opportunityId && forwardOutcome.outcomeId === outcome.outcomeId &&
    experience.decisionId === forwardDecision.cortexTraining.decisionId && experience.opportunityId === outcome.opportunityId &&
    experience.outcomeId === outcome.outcomeId && experience.laneId === outcome.laneId &&
    experience.symbolOrBasketId === symbol && experience.direction === outcome.direction &&
    decision.decisionId === forwardDecision.cortexTraining.decisionId;
  if (!identityMatches) return "CORTEX_DECISION_IDENTITY_MISMATCH";
  const lane = decision.lanes.get(outcome.laneId);
  const raw = forwardDecision.cortexTraining;
  if (!lane || lane.direction !== outcome.direction || raw.featureSchemaVersion !== decision.featureSchemaVersion ||
    experience.featureSchemaVersion !== String(raw.featureSchemaVersion) || !raw.featureVector || !experience.featureVector ||
    !equalVector(raw.featureVector, experience.featureVector) || !equalVector(raw.featureVector, lane.x)) {
    return "CORTEX_SNAPSHOT_VECTOR_MISMATCH";
  }
  return null;
}

/** Canonical strict builder. It is intentionally an intersection, never a merge: the Four-Brain
 * economic outcome establishes exact settled economics, while the Forward-Causal chain supplies the
 * original CORTEX feature vector captured at decision time. */
export function buildCortexShadowTrainingDataset(input: {
  outcomes: readonly ExecutiveReviewOutcome[];
  forwardEvents: readonly ForwardEvent[];
  policy: CanonicalPolicyContext & { instanceId: "3101" | "3102"; fourBrainPolicyVersion: string };
  resetEpoch?: string;
  nowMs: number;
}): CortexShadowDataset {
  const resetEpoch = input.resetEpoch ?? CORTEX_SHADOW_REFIT_DEFAULT_EPOCH;
  const epochMs = Date.parse(resetEpoch);
  if (!Number.isFinite(epochMs)) throw new Error("invalid CORTEX shadow reset epoch");
  const rejected = emptyRejections();
  const directOutcomeIds = fourBrainDirectOutcomeIds(input.outcomes, {
    instanceId: input.policy.instanceId,
    decisionPipelinePolicyVersion: input.policy.decisionPolicyVersion,
    executionPolicyVersion: input.policy.executionPolicyVersion,
    evidencePolicyVersion: input.policy.evidencePolicyVersion,
    evidenceEra: input.policy.evidenceEra,
    fourBrainPolicyVersion: input.policy.fourBrainPolicyVersion,
    policyDeploymentAt: input.policy.policyDeploymentAt,
  }, input.nowMs);
  const bridge: CortexExperienceBridgeResult = buildCortexExperienceBridge(input.forwardEvents, input.policy);
  const bridgeByOutcome = new Map(bridge.experiences.map((row) => [row.outcomeId, row]));
  const decisionByCortexLane = new Map(bridge.decisions.map((row) => [`${row.decisionId ?? ""}\u001f${[...row.lanes.keys()][0] ?? ""}`, row]));
  const forwardDecisionByAllocation = new Map(input.forwardEvents
    .filter((event): event is Extract<ForwardEvent, { eventType: "DECISION_SNAPSHOT" }> => event.eventType === "DECISION_SNAPSHOT")
    .map((event) => [event.identity.allocationSnapshotId ?? "", event]));
  const forwardOpenByOpportunity = new Map(input.forwardEvents
    .filter((event): event is ForwardOpen => event.eventType === "OPPORTUNITY_OPEN")
    .map((event) => [event.identity.opportunityId, event]));
  const forwardOutcomeByOutcome = new Map(input.forwardEvents
    .filter((event): event is ForwardOutcome => event.eventType === "OUTCOME_RESOLUTION")
    .map((event) => [event.outcomeId, event]));
  const seen = new Set<string>();
  let archivedPreEpoch = 0;
  const examples: CortexShadowTrainingExample[] = [];

  for (const outcome of sorted(input.outcomes, (a, b) => a.resolvedAtMs - b.resolvedAtMs || a.executiveReviewOutcomeId.localeCompare(b.executiveReviewOutcomeId))) {
    if (seen.has(outcome.outcomeId)) { rejected.DUPLICATE_OUTCOME += 1; continue; }
    seen.add(outcome.outcomeId);
    if (outcome.executiveDecisionTimeMs == null || outcome.entryFilledAtMs == null || outcome.executiveDecisionTimeMs < epochMs || outcome.entryFilledAtMs < epochMs) {
      rejected.PRE_RESET_EPOCH += 1; archivedPreEpoch += 1; continue;
    }
    if (!finite(outcome.originalRisk) || outcome.originalRisk <= 0) { rejected.INVALID_IMMUTABLE_RISK += 1; continue; }
    if (!outcome.settlementFetchComplete || outcome.missingRequiredOrderIds.length > 0 || !finite(outcome.costR) || !finite(outcome.netR) || Math.abs((outcome.grossR - outcome.costR) - outcome.netR) > 1e-9) {
      rejected.INVALID_OR_INCOMPLETE_COST += 1; continue;
    }
    if (!directOutcomeIds.has(outcome.outcomeId)) { rejected.FOUR_BRAIN_NOT_DIRECT += 1; continue; }
    const experience = bridgeByOutcome.get(outcome.outcomeId);
    const forwardDecision = outcome.allocationSnapshotId ? forwardDecisionByAllocation.get(outcome.allocationSnapshotId) : undefined;
    const decision = forwardDecision?.cortexTraining.decisionId
      ? decisionByCortexLane.get(`${forwardDecision.cortexTraining.decisionId}\u001f${outcome.laneId}`)
      : undefined;
    const rawSnapshot = forwardDecision?.cortexTraining;
    if (!rawSnapshot || rawSnapshot.status !== "PRESENT" || !rawSnapshot.featureVector) {
      rejected.MISSING_EXACT_CORTEX_SNAPSHOT += 1; continue;
    }
    if (rawSnapshot.featureSchemaVersion !== CORTEX_FEATURE_SCHEMA_VERSION || rawSnapshot.featureVector.length !== CORTEX_FEATURE_DIM || !rawSnapshot.featureVector.every(finite)) {
      rejected.FEATURE_SCHEMA_MISMATCH += 1; continue;
    }
    if (!rawSnapshot.regimeFamily || rawSnapshot.regimeFamily.trim().toUpperCase() === "UNKNOWN" || rawSnapshot.regimeFamily.trim().toUpperCase() === "UNKNOWN_CONTEXT") {
      rejected.UNKNOWN_CONTEXT += 1; continue;
    }
    const consistency = snapshotConsistencyReason({
      outcome, experience, decision, forwardDecision,
      forwardOpen: forwardOpenByOpportunity.get(outcome.opportunityId),
      forwardOutcome: forwardOutcomeByOutcome.get(outcome.outcomeId), policy: input.policy,
    });
    if (consistency) { rejected[consistency] += 1; continue; }
    // snapshotConsistencyReason has just proven these exact representations exist; repeat the
    // guard so TypeScript also retains that fact rather than allowing an accidental future access.
    if (!experience || !experience.decisionId || !decision || !forwardDecision) { rejected.FORWARD_CAUSAL_INELIGIBLE += 1; continue; }
    if (!experience.featureVector || experience.featureSchemaVersion !== String(CORTEX_FEATURE_SCHEMA_VERSION)) { rejected.MISSING_EXACT_CORTEX_SNAPSHOT += 1; continue; }
    if (experience.featureVector.length !== CORTEX_FEATURE_DIM || !experience.featureVector.every(finite)) { rejected.FEATURE_SCHEMA_MISMATCH += 1; continue; }
    const lane = decision.lanes.get(outcome.laneId);
    if (!lane || lane.x.length !== CORTEX_FEATURE_DIM || !lane.x.every(finite)) { rejected.MISSING_EXACT_CORTEX_SNAPSHOT += 1; continue; }
    const regimeFamily = decision.regimeFamily.trim().toUpperCase();
    if (!regimeFamily || regimeFamily === "UNKNOWN" || regimeFamily === "UNKNOWN_CONTEXT") { rejected.UNKNOWN_CONTEXT += 1; continue; }
    if (outcome.direction !== "LONG" && outcome.direction !== "SHORT") { rejected.LINEAGE_MISMATCH += 1; continue; }
    examples.push({
      exampleId: `cortex-shadow:${outcome.executiveReviewOutcomeId}`,
      decisionId: experience.decisionId,
      opportunityId: outcome.opportunityId,
      outcomeId: outcome.outcomeId,
      laneId: outcome.laneId,
      symbolOrBasketId: outcome.symbolOrBasketId!,
      direction: outcome.direction,
      archetype: cortexArchetypeForLane(outcome.laneId),
      regimeFamily,
      decisionTimeMs: outcome.executiveDecisionTimeMs,
      openedTimeMs: outcome.entryFilledAtMs,
      closedTimeMs: outcome.marketClosedAtMs ?? outcome.resolvedAtMs,
      resolvedTimeMs: outcome.resolvedAtMs,
      x: [...experience.featureVector],
      netR: outcome.netR,
      policyDeploymentAt: outcome.policyDeploymentAt ?? "",
    });
  }
  const ordered = sorted(examples, (a, b) => a.resolvedTimeMs - b.resolvedTimeMs || a.exampleId.localeCompare(b.exampleId));
  return {
    resetEpoch: new Date(epochMs).toISOString(),
    examined: input.outcomes.length,
    examples: ordered,
    rejected,
    archivedPreEpoch,
    datasetHash: hash(ordered.map(({ x, ...row }) => ({ ...row, x: [...x] }))),
    sourceLineage: { executiveOutcomeIds: sorted(input.outcomes.map((o) => o.executiveReviewOutcomeId), (a, b) => a.localeCompare(b)), forwardEventCount: input.forwardEvents.length },
  };
}

function metrics(rows: readonly CortexShadowTrainingExample[], coefficients: readonly number[] | null): CortexShadowMetrics {
  const n = rows.length;
  const netR = rows.reduce((sum, row) => sum + row.netR, 0);
  const positive = rows.filter((row) => row.netR > 0);
  const negative = rows.filter((row) => row.netR < 0);
  const grossProfit = positive.reduce((sum, row) => sum + row.netR, 0);
  const grossLoss = Math.abs(negative.reduce((sum, row) => sum + row.netR, 0));
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const row of rows) { equity += row.netR; peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity - peak); }
  const contexts: Record<string, number> = {};
  const symbols: Record<string, number> = {};
  let absError = 0; let predictions = 0;
  for (const row of rows) {
    contexts[row.regimeFamily] = (contexts[row.regimeFamily] ?? 0) + 1;
    symbols[row.symbolOrBasketId] = (symbols[row.symbolOrBasketId] ?? 0) + 1;
    if (coefficients && coefficients.length === row.x.length) {
      const prediction = row.x.reduce((sum, x, index) => sum + x * coefficients[index]!, 0);
      if (finite(prediction)) { absError += Math.abs(prediction - row.netR); predictions += 1; }
    }
  }
  return {
    n, netR, averageNetR: n ? netR / n : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    winRate: n ? positive.length / n : null,
    payoffRatio: positive.length && negative.length ? (grossProfit / positive.length) / (grossLoss / negative.length) : null,
    maxDrawdownR: n ? drawdown : null,
    calibrationMae: predictions ? absError / predictions : null,
    contextDistribution: contexts,
    symbolConcentrationPct: n ? Math.max(0, ...Object.values(symbols)) / n * 100 : null,
  };
}

/** Prediction delta is intentionally evaluated on the same fixed OOS outcomes. It is a shadow
 * expectation comparison, not a replacement of the observed canonical netR label. */
function meanPredictionDelta(rows: readonly CortexShadowTrainingExample[], candidate: readonly number[], incumbent: readonly number[]): number | null {
  if (!rows.length || candidate.length !== incumbent.length) return null;
  let total = 0;
  for (const row of rows) {
    if (row.x.length !== candidate.length) return null;
    const candidatePrediction = row.x.reduce((sum, value, index) => sum + value * candidate[index]!, 0);
    const incumbentPrediction = row.x.reduce((sum, value, index) => sum + value * incumbent[index]!, 0);
    if (!finite(candidatePrediction) || !finite(incumbentPrediction)) return null;
    total += candidatePrediction - incumbentPrediction;
  }
  return total / rows.length;
}

function predict(coefficients: readonly number[], x: readonly number[]): number | null {
  if (coefficients.length !== x.length || !coefficients.every(finite) || !x.every(finite)) return null;
  const value = x.reduce((sum, feature, index) => sum + feature * coefficients[index]!, 0);
  return finite(value) ? value : null;
}

function metricsFromHeldOut(
  heldOut: readonly CortexShadowHeldOutPrediction[],
  kind: "candidate" | "incumbent",
): CortexShadowMetrics {
  const rows: CortexShadowTrainingExample[] = heldOut.map((row) => ({
    exampleId: row.exampleId, decisionId: row.exampleId, opportunityId: row.opportunityId, outcomeId: row.exampleId,
    laneId: "held-out", symbolOrBasketId: row.symbolOrBasketId, direction: "LONG", archetype: "BREADTH",
    regimeFamily: row.regimeFamily, decisionTimeMs: row.decisionTimeMs, openedTimeMs: row.decisionTimeMs,
    closedTimeMs: row.resolvedTimeMs, resolvedTimeMs: row.resolvedTimeMs, x: [], netR: row.netR, policyDeploymentAt: "held-out",
  }));
  const base = metrics(rows, null);
  const errors = heldOut.flatMap((row) => {
    const prediction = kind === "candidate" ? row.candidatePrediction : row.incumbentPrediction;
    return prediction == null ? [] : [Math.abs(prediction - row.netR)];
  });
  return { ...base, calibrationMae: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null };
}

function heldOutDelta(heldOut: readonly CortexShadowHeldOutPrediction[]): number | null {
  if (!heldOut.length || heldOut.some((row) => row.candidatePrediction == null || row.incumbentPrediction == null)) return null;
  return heldOut.reduce((sum, row) => sum + row.candidatePrediction! - row.incumbentPrediction!, 0) / heldOut.length;
}

function fitArchetype(
  rows: readonly CortexShadowTrainingExample[], prior: readonly number[], fitCutoffMs: number | null,
  hyperparameters: CortexShadowRefitHyperparameters,
): { fit: CortexEconomicFit; folds: CortexShadowFoldResult[]; blockers: string[]; cautions: string[] } {
  const ordered = sorted(rows, (a, b) => a.resolvedTimeMs - b.resolvedTimeMs || a.exampleId.localeCompare(b.exampleId));
  // A candidate must be a function of immutable evidence, not the operator's wall clock.
  const fullFit = fitCutoffMs == null
    ? { coefficients: [...prior], residualScale: null, effectiveSampleSize: 0, status: "INSUFFICIENT_DATA" as const }
    : refitCortexEconomicModel(ordered.map((row) => ({ x: [...row.x], realizedNetR: row.netR, tMs: row.resolvedTimeMs, schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION })), [...prior], { nowMs: fitCutoffMs, ...hyperparameters });
  const folds: CortexShadowFoldResult[] = [];
  const blockers: string[] = [];
  const cautions: string[] = [];
  if (ordered.length < hyperparameters.minTrainExamples + hyperparameters.minOosExamples) blockers.push("INSUFFICIENT_CHRONOLOGICAL_OOS_DATA");
  const foldSize = Math.floor((ordered.length - hyperparameters.minTrainExamples) / hyperparameters.folds);
  if (foldSize < hyperparameters.minOosExamples) blockers.push("OOS_FOLDS_BELOW_MINIMUM");
  else for (let fold = 0; fold < hyperparameters.folds; fold += 1) {
    const trainEnd = hyperparameters.minTrainExamples + fold * foldSize;
    const train = ordered.slice(0, trainEnd);
    const oos = ordered.slice(trainEnd, Math.min(ordered.length, trainEnd + foldSize));
    const opportunities = new Set(train.map((row) => row.opportunityId));
    const trainingCutoffMs = train.at(-1)?.resolvedTimeMs;
    const purgeBoundaryMs = (trainingCutoffMs ?? -Infinity) + hyperparameters.purgeMs;
    const safeOos = oos.filter((row) => !opportunities.has(row.opportunityId) && row.decisionTimeMs > purgeBoundaryMs);
    // OOS rows must never influence recency weights. The model's clock is frozen at the last
    // resolved training observation, even when the held-out period extends far into the future.
    const fit: CortexEconomicFit = trainingCutoffMs == null
      ? { coefficients: [...prior], residualScale: null, effectiveSampleSize: 0, status: "INSUFFICIENT_DATA" }
      : refitCortexEconomicModel(
        train.map((row) => ({ x: [...row.x], realizedNetR: row.netR, tMs: row.resolvedTimeMs, schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION })),
        [...prior],
        { nowMs: trainingCutoffMs, ...hyperparameters },
      );
    const heldOut = safeOos.map((row) => ({
      exampleId: row.exampleId, opportunityId: row.opportunityId, decisionTimeMs: row.decisionTimeMs,
      resolvedTimeMs: row.resolvedTimeMs, netR: row.netR, regimeFamily: row.regimeFamily, symbolOrBasketId: row.symbolOrBasketId,
      candidatePrediction: fit.status === "ACCEPTED" ? predict(fit.coefficients, row.x) : null,
      incumbentPrediction: predict(prior, row.x),
    }));
    const candidate = metricsFromHeldOut(heldOut, "candidate");
    const incumbent = metricsFromHeldOut(heldOut, "incumbent");
    const expectedEconomicDeltaR = heldOutDelta(heldOut);
    folds.push({
      fold: fold + 1,
      trainStartMs: train[0]?.decisionTimeMs ?? null, trainEndMs: trainingCutoffMs ?? null, trainingCutoffMs: trainingCutoffMs ?? null,
      oosStartMs: safeOos[0]?.decisionTimeMs ?? null, oosEndMs: safeOos.at(-1)?.resolvedTimeMs ?? null,
      trainN: train.length, oosN: safeOos.length, trainExampleIds: train.map((row) => row.exampleId), heldOut, fitStatus: fit.status,
      candidate, incumbent, expectedEconomicDeltaR,
    });
  }
  if (fullFit.status !== "ACCEPTED") blockers.push(`FIT_${fullFit.status}`);
  if (folds.some((fold) => fold.fitStatus !== "ACCEPTED" || fold.oosN < hyperparameters.minOosExamples)) blockers.push("INVALID_OOS_FOLD");
  if (metrics(ordered, null).symbolConcentrationPct != null && metrics(ordered, null).symbolConcentrationPct! > 60) cautions.push("SYMBOL_CONCENTRATION_ABOVE_60_PCT");
  return { fit: fullFit, folds, blockers: [...new Set(blockers)], cautions };
}

function emptyMetrics(): CortexShadowMetrics { return metrics([], null); }

function incumbentFingerprint(incumbent: CortexStoreState): string {
  return hash({ featureSchemaVersion: incumbent.featureSchemaVersion, archetypes: ARCHETYPES.map((archetype) => ({ archetype, w: incumbent.archetypes[archetype].w })) });
}

function generationFingerprint(input: {
  datasetHash: string;
  incumbentGeneration: number;
  incumbentCoefficientFingerprint: string;
  hyperparameters: CortexShadowRefitHyperparameters;
  codeVersion: string;
}): string {
  return hash({ learnerSchemaVersion: CORTEX_SHADOW_REFIT_SCHEMA_VERSION, featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, ...input });
}

function candidateIntegrityContent(candidate: Omit<CortexShadowCandidateGeneration, "integrityHash">): unknown {
  return candidate;
}

function candidateForDataset(
  dataset: CortexShadowDataset, incumbent: CortexStoreState, incumbentGeneration: number, generatedAtMs: number,
  codeVersion: string, hyperparameters: CortexShadowRefitHyperparameters,
): CortexShadowCandidateGeneration {
  const incumbentCoefficientFingerprint = incumbentFingerprint(incumbent);
  const fingerprint = generationFingerprint({ datasetHash: dataset.datasetHash, incumbentGeneration, incumbentCoefficientFingerprint, hyperparameters, codeVersion });
  const fitCutoffMs = dataset.examples.at(-1)?.resolvedTimeMs ?? null;
  const archetypes = ARCHETYPES.map((archetype) => {
    const rows = dataset.examples.filter((row) => row.archetype === archetype);
    const prior = incumbent.archetypes[archetype].w;
    const result = fitArchetype(rows, prior, fitCutoffMs, hyperparameters);
    const coefficients = result.fit.status === "ACCEPTED" ? result.fit.coefficients : [...prior];
    const train = metrics(rows, coefficients);
    const heldOut = result.folds.flatMap((fold) => fold.heldOut);
    const oos = metricsFromHeldOut(heldOut, "candidate");
    const expectedEconomicDeltaR = heldOutDelta(heldOut);
    const coefficientMaxDelta = Math.max(0, ...coefficients.map((value, index) => Math.abs(value - prior[index]!)));
    return {
      archetype, n: rows.length, nEff: result.fit.effectiveSampleSize, coefficients, incumbentCoefficients: [...prior],
      fitStatus: result.fit.status, folds: result.folds, train, oos, expectedEconomicDeltaR, coefficientMaxDelta,
      blockers: result.blockers, cautions: result.cautions,
    } satisfies CortexShadowArchetypeCandidate;
  });
  const blockers = archetypes.flatMap((row) => row.blockers.map((blocker) => `${row.archetype}:${blocker}`));
  const cautions = archetypes.flatMap((row) => row.cautions.map((caution) => `${row.archetype}:${caution}`));
  const unsigned = {
    generationId: `shadow-${fingerprint.slice(0, 20)}`,
    generationFingerprint: fingerprint,
    parentIncumbentGeneration: incumbentGeneration,
    incumbentCoefficientFingerprint,
    // Candidate identity/content is evidence-derived. The audit report retains invocation time.
    createdAt: new Date(fitCutoffMs ?? generatedAtMs).toISOString(), resetEpoch: dataset.resetEpoch,
    trainingCutoffMs: fitCutoffMs ?? generatedAtMs,
    featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, datasetHash: dataset.datasetHash,
    exampleIds: dataset.examples.map((row) => row.exampleId), sourceLineage: dataset.sourceLineage,
    hyperparameters, archetypes,
    shadowReady: false, blockers, cautions, codeVersion,
  } satisfies Omit<CortexShadowCandidateGeneration, "integrityHash">;
  return { ...unsigned, integrityHash: hash(candidateIntegrityContent(unsigned)) };
}

type UnsignedCortexShadowRefitRegistry = Omit<CortexShadowRefitRegistry, "registryIntegrityHash">;

/** Runtime corruption state is deliberately excluded. The on-disk signature covers every canonical
 * persisted field, including `lastAudit`, so readiness counters cannot be edited independently. */
function registryIntegrityContent(registry: UnsignedCortexShadowRefitRegistry | CortexShadowRefitRegistry): unknown {
  const {
    integrityStatus: _integrityStatus,
    integrityError: _integrityError,
    registryIntegrityHash: _registryIntegrityHash,
    ...content
  } = registry as CortexShadowRefitRegistry;
  return content;
}

function sealRegistry(registry: UnsignedCortexShadowRefitRegistry): CortexShadowRefitRegistry {
  return { ...registry, registryIntegrityHash: hash(registryIntegrityContent(registry)) };
}

function defaultRegistry(): CortexShadowRefitRegistry {
  return sealRegistry({
    schemaVersion: CORTEX_SHADOW_REFIT_SCHEMA_VERSION, integrityStatus: "HEALTHY", integrityError: null,
    candidates: [], lastDatasetHash: null, lastGenerationFingerprint: null, lastAudit: null,
  });
}

function validCandidate(candidate: CortexShadowCandidateGeneration): boolean {
  const { integrityHash: _integrityHash, ...unsigned } = candidate;
  const expectedGenerationFingerprint = generationFingerprint({
    datasetHash: candidate.datasetHash,
    incumbentGeneration: candidate.parentIncumbentGeneration,
    incumbentCoefficientFingerprint: candidate.incumbentCoefficientFingerprint,
    hyperparameters: candidate.hyperparameters,
    codeVersion: candidate.codeVersion,
  });
  return candidate.featureSchemaVersion === CORTEX_FEATURE_SCHEMA_VERSION &&
    Number.isInteger(candidate.parentIncumbentGeneration) && candidate.parentIncumbentGeneration >= 0 &&
    typeof candidate.incumbentCoefficientFingerprint === "string" && candidate.incumbentCoefficientFingerprint.length === 64 &&
    candidate.generationFingerprint === expectedGenerationFingerprint &&
    candidate.archetypes.length === ARCHETYPES.length &&
    candidate.archetypes.every((row) => row.coefficients.length === CORTEX_FEATURE_DIM && row.coefficients.every(finite)) &&
    candidate.generationId === `shadow-${candidate.generationFingerprint.slice(0, 20)}` &&
    candidate.integrityHash === hash(candidateIntegrityContent(unsigned));
}

export class CortexShadowRefitRegistryStore {
  private state: CortexShadowRefitRegistry = defaultRegistry();
  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const primary = this.readValid(file);
    if (primary) { this.state = primary; return; }
    // A complete previous registry is retained as a local last-known-good snapshot. Recovery is
    // report-only and visibly degraded: callers may inspect it but cannot overwrite the corrupt
    // primary state until an operator resolves the storage problem.
    const backup = this.readValid(`${file}.bak`);
    if (backup) {
      this.state = { ...backup, integrityStatus: "REGISTRY_CORRUPTED", integrityError: "primary registry failed schema or integrity validation; recovered last known valid backup" };
      return;
    }
    this.state = { ...defaultRegistry(), integrityStatus: "REGISTRY_CORRUPTED", integrityError: "registry failed schema or integrity validation; no safe backup available" };
  }
  get(): CortexShadowRefitRegistry { return this.state; }
  isCorrupted(): boolean { return this.state.integrityStatus === "REGISTRY_CORRUPTED"; }
  save(next: UnsignedCortexShadowRefitRegistry | CortexShadowRefitRegistry): void {
    if (this.isCorrupted()) throw new Error("refusing to overwrite a corrupted CORTEX shadow registry");
    const persisted = sealRegistry({ ...next, integrityStatus: "HEALTHY", integrityError: null });
    if (persisted.schemaVersion !== CORTEX_SHADOW_REFIT_SCHEMA_VERSION || !persisted.candidates.every(validCandidate)) {
      throw new Error("refusing to persist an invalid CORTEX shadow registry");
    }
    this.atomicWrite(this.file, JSON.stringify(persisted));
    // Keep a parseable last-known-good snapshot after the primary rename succeeds. It is only used
    // when a later crash/truncation corrupts the primary file, never as a normal alternate source.
    this.atomicWrite(`${this.file}.bak`, JSON.stringify(persisted));
    this.state = persisted;
  }
  private readValid(file: string): CortexShadowRefitRegistry | null {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CortexShadowRefitRegistry;
      if (
        parsed.schemaVersion !== CORTEX_SHADOW_REFIT_SCHEMA_VERSION || parsed.integrityStatus !== "HEALTHY" ||
        typeof parsed.registryIntegrityHash !== "string" || parsed.registryIntegrityHash.length !== 64 ||
        !Array.isArray(parsed.candidates) || !parsed.candidates.every(validCandidate) ||
        !(parsed.lastDatasetHash === null || typeof parsed.lastDatasetHash === "string") ||
        !(parsed.lastGenerationFingerprint === null || typeof parsed.lastGenerationFingerprint === "string") ||
        parsed.registryIntegrityHash !== hash(registryIntegrityContent(parsed))
      ) return null;
      return { ...parsed, candidates: [...parsed.candidates], integrityError: null };
    } catch { return null; }
  }
  private atomicWrite(file: string, contents: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, contents, "utf8");
      const fd = openSync(tmp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
      throw error;
    }
  }
}

export interface CortexShadowRefitPlan {
  readonly report: CortexShadowRunReport;
  /** Null means the registry was already corrupt and must remain untouched. */
  readonly nextRegistry: UnsignedCortexShadowRefitRegistry | null;
}

type CortexShadowRefitInput = {
  outcomes: readonly ExecutiveReviewOutcome[];
  forwardEvents: readonly ForwardEvent[];
  policy: CanonicalPolicyContext & { instanceId: "3101" | "3102"; fourBrainPolicyVersion: string };
  incumbent: CortexStoreState;
  registry: CortexShadowRefitRegistryStore;
  nowMs: number;
  resetEpoch?: string;
  codeVersion?: string;
  incumbentGeneration?: number;
  hyperparameters?: CortexShadowRefitHyperparameters;
};

/**
 * Pure planning half of the manual shadow refit. This deliberately shares every
 * dataset/fit calculation with the persistent path so an operator dry-run cannot
 * drift from the prospective commit for the same immutable input snapshot.
 */
export function planCortexShadowRefit(input: CortexShadowRefitInput): CortexShadowRefitPlan {
  const dataset = buildCortexShadowTrainingDataset(input);
  const previous = input.registry.get();
  const generatedAt = new Date(input.nowMs).toISOString();
  if (input.registry.isCorrupted()) {
    return { report: {
      status: "BLOCKED", generatedAt, resetEpoch: dataset.resetEpoch, dataset,
      candidate: previous.candidates.at(-1) ?? null, beta: { evaluationBeta: 0, liveBeta: 0 },
      blockers: ["REGISTRY_CORRUPTED", previous.integrityError ?? "unknown registry integrity error"],
    }, nextRegistry: null };
  }
  const codeVersion = input.codeVersion ?? "unknown";
  const hyperparameters = input.hyperparameters ?? CORTEX_SHADOW_REFIT_HYPERPARAMETERS;
  const incumbentGeneration = input.incumbentGeneration ?? 0;
  const nextFingerprint = generationFingerprint({
    datasetHash: dataset.datasetHash, incumbentGeneration,
    incumbentCoefficientFingerprint: incumbentFingerprint(input.incumbent), hyperparameters, codeVersion,
  });
  if (previous.lastGenerationFingerprint === nextFingerprint) {
    const candidate = previous.candidates.find((row) => row.generationFingerprint === nextFingerprint) ?? previous.candidates.at(-1) ?? null;
    const report: CortexShadowRunReport = { status: "NO_NEW_ELIGIBLE_DATA", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: [] };
    // Audit freshness is independent of candidate idempotence: a newly-arrived rejected outcome
    // changes examined/rejection counters even when the eligible dataset is byte-identical.
    return { report, nextRegistry: { ...previous, lastDatasetHash: dataset.datasetHash, lastGenerationFingerprint: nextFingerprint, lastAudit: report } };
  }
  if (dataset.examples.length === 0) {
    const report: CortexShadowRunReport = { status: "NO_REFIT", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate: null, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: ["NO_ELIGIBLE_EXAMPLES"] };
    return { report, nextRegistry: { ...previous, lastDatasetHash: dataset.datasetHash, lastGenerationFingerprint: nextFingerprint, lastAudit: report } };
  }
  const candidate = candidateForDataset(dataset, input.incumbent, incumbentGeneration, input.nowMs, codeVersion, hyperparameters);
  // Per-archetype failures remain explicit blockers on the persisted candidate. They must not erase
  // a valid BREADTH/NEUTRAL/Tactical fit merely because a different archetype has no observations.
  const hasAnyAcceptedFit = candidate.archetypes.some((row) => row.fitStatus === "ACCEPTED");
  const report: CortexShadowRunReport = { status: hasAnyAcceptedFit ? "CANDIDATE_CREATED" : "NO_REFIT", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: candidate.blockers };
  return { report, nextRegistry: {
    schemaVersion: CORTEX_SHADOW_REFIT_SCHEMA_VERSION, integrityStatus: "HEALTHY", integrityError: null,
    candidates: previous.candidates.some((row) => row.generationFingerprint === candidate.generationFingerprint) ? previous.candidates : [...previous.candidates, candidate],
    lastDatasetHash: dataset.datasetHash, lastGenerationFingerprint: nextFingerprint,
    lastAudit: report,
  } };
}

/** Manual-only entry point. No module registers this function with a scheduler. */
export function runCortexShadowRefit(input: CortexShadowRefitInput): CortexShadowRunReport {
  const plan = planCortexShadowRefit(input);
  if (plan.nextRegistry) input.registry.save(plan.nextRegistry);
  return plan.report;
}

export function cortexShadowRefitRegistryPath(dataDir = "data"): string {
  return resolve(dataDir, CORTEX_SHADOW_REFIT_REGISTRY_FILE);
}

export interface CortexShadowRefitReadiness {
  readonly resetEpoch: string | null;
  readonly totalExamined: number;
  readonly directLearningEligible: number;
  readonly rejected: Readonly<Record<string, number>>;
  readonly datasetHash: string | null;
  readonly latestStatus: CortexShadowRunStatus | null;
  readonly candidateGenerationId: string | null;
  readonly incumbentGeneration: number | null;
  readonly registryIntegrity: "HEALTHY" | "REGISTRY_CORRUPTED";
  readonly registryIntegrityError: string | null;
  readonly perArchetype: readonly {
    archetype: CortexArchetype;
    eligible: number;
    nEff: number;
    fitStatus: CortexEconomicFit["status"] | "NO_REFIT";
    coefficientMaxDelta: number;
    oosVerdict: "VALID" | "BLOCKED";
  }[];
  readonly beta: { evaluationBeta: 0; liveBeta: 0 };
  readonly promotion: "OFF";
}

/** A read-only comparison for a single immutable decision feature vector. Callers receive values
 * only; this helper deliberately has no route to allocation or execution objects. */
export function compareCortexShadowPrediction(input: {
  x: readonly number[];
  incumbent: readonly number[];
  candidate: readonly number[];
  context: string;
}): {
  incumbentPrediction: number | null;
  candidatePrediction: number | null;
  decisionDelta: number | null;
  expectedEconomicDeltaR: number | null;
  coefficientMaxDelta: number | null;
  context: string;
  reportOnly: true;
} {
  const predict = (coefficients: readonly number[]): number | null =>
    coefficients.length === input.x.length && input.x.every(finite) && coefficients.every(finite)
      ? input.x.reduce((sum, value, index) => sum + value * coefficients[index]!, 0) : null;
  const incumbentPrediction = predict(input.incumbent);
  const candidatePrediction = predict(input.candidate);
  const decisionDelta = incumbentPrediction != null && candidatePrediction != null ? candidatePrediction - incumbentPrediction : null;
  return {
    incumbentPrediction, candidatePrediction, decisionDelta, expectedEconomicDeltaR: decisionDelta,
    coefficientMaxDelta: input.incumbent.length === input.candidate.length
      ? Math.max(0, ...input.incumbent.map((value, index) => Math.abs(value - input.candidate[index]!))) : null,
    context: input.context, reportOnly: true,
  };
}

export function cortexShadowRefitReadiness(registry: CortexShadowRefitRegistry): CortexShadowRefitReadiness {
  const audit = registry.lastAudit;
  return {
    resetEpoch: audit?.resetEpoch ?? null,
    totalExamined: audit?.dataset.examined ?? 0,
    directLearningEligible: audit?.dataset.examples.length ?? 0,
    rejected: audit?.dataset.rejected ?? {}, datasetHash: audit?.dataset.datasetHash ?? null,
    latestStatus: audit?.status ?? null, candidateGenerationId: audit?.candidate?.generationId ?? null,
    incumbentGeneration: audit?.candidate?.parentIncumbentGeneration ?? null,
    registryIntegrity: registry.integrityStatus, registryIntegrityError: registry.integrityError,
    perArchetype: audit?.candidate?.archetypes.map((row) => ({
      archetype: row.archetype, eligible: row.n, nEff: row.nEff, fitStatus: row.fitStatus,
      coefficientMaxDelta: row.coefficientMaxDelta,
      oosVerdict: row.blockers.length === 0 ? "VALID" : "BLOCKED",
    })) ?? ARCHETYPES.map((archetype) => ({ archetype, eligible: 0, nEff: 0, fitStatus: "NO_REFIT" as const, coefficientMaxDelta: 0, oosVerdict: "BLOCKED" as const })),
    beta: { evaluationBeta: 0, liveBeta: 0 }, promotion: "OFF",
  };
}

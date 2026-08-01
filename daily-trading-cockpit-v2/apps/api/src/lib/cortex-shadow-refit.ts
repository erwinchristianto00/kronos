/**
 * CORTEX Shadow Refit/Learner v1.
 *
 * This module is deliberately an offline/report-only boundary. It consumes immutable
 * Executive Review outcomes plus their exact forward-causal CORTEX decision snapshot,
 * writes candidate coefficients to a separate registry, and has no dependency on an
 * allocator, execution engine, or mutable incumbent CORTEX store.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export const CORTEX_SHADOW_REFIT_SCHEMA_VERSION = "cortex-shadow-refit/1" as const;
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
  | "INVALID_IMMUTABLE_RISK";

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
  readonly oosStartMs: number | null;
  readonly oosEndMs: number | null;
  readonly trainN: number;
  readonly oosN: number;
  readonly fitStatus: CortexEconomicFit["status"] | "NO_FOLD";
  readonly candidate: CortexShadowMetrics;
  readonly incumbent: CortexShadowMetrics;
  readonly expectedEconomicDeltaR: number | null;
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
  readonly parentIncumbentGeneration: 0;
  readonly createdAt: string;
  readonly resetEpoch: string;
  readonly trainingCutoffMs: number;
  readonly featureSchemaVersion: number;
  readonly datasetHash: string;
  readonly exampleIds: readonly string[];
  readonly sourceLineage: CortexShadowDataset["sourceLineage"];
  readonly hyperparameters: typeof CORTEX_SHADOW_REFIT_HYPERPARAMETERS;
  readonly archetypes: readonly CortexShadowArchetypeCandidate[];
  readonly shadowReady: false;
  readonly blockers: readonly string[];
  readonly cautions: readonly string[];
  readonly codeVersion: string;
}

export interface CortexShadowRefitRegistry {
  readonly schemaVersion: typeof CORTEX_SHADOW_REFIT_SCHEMA_VERSION;
  readonly candidates: readonly CortexShadowCandidateGeneration[];
  readonly lastDatasetHash: string | null;
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
  const decisionByCortexId = new Map(bridge.decisions.map((row) => [row.decisionId ?? "", row]));
  const forwardDecisionByAllocation = new Map(input.forwardEvents
    .filter((event): event is Extract<ForwardEvent, { eventType: "DECISION_SNAPSHOT" }> => event.eventType === "DECISION_SNAPSHOT")
    .map((event) => [event.identity.allocationSnapshotId ?? "", event]));
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
    const decision = forwardDecision?.cortexTraining.decisionId ? decisionByCortexId.get(forwardDecision.cortexTraining.decisionId) : undefined;
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
    if (
      !experience || !decision || !forwardDecision || !experience.decisionId ||
      forwardDecision.identity.allocationSnapshotId !== outcome.allocationSnapshotId ||
      forwardDecision.asOfMs !== outcome.executiveDecisionTimeMs ||
      experience.opportunityId !== outcome.opportunityId || experience.laneId !== outcome.laneId
    ) {
      rejected.FORWARD_CAUSAL_INELIGIBLE += 1; continue;
    }
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
      symbolOrBasketId: outcome.symbolOrBasketId ?? "",
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

function fitArchetype(rows: readonly CortexShadowTrainingExample[], prior: readonly number[], nowMs: number): { fit: CortexEconomicFit; folds: CortexShadowFoldResult[]; blockers: string[]; cautions: string[] } {
  const ordered = sorted(rows, (a, b) => a.resolvedTimeMs - b.resolvedTimeMs || a.exampleId.localeCompare(b.exampleId));
  const fullFit = refitCortexEconomicModel(ordered.map((row) => ({ x: [...row.x], realizedNetR: row.netR, tMs: row.resolvedTimeMs, schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION })), [...prior], { nowMs, ...CORTEX_SHADOW_REFIT_HYPERPARAMETERS });
  const folds: CortexShadowFoldResult[] = [];
  const blockers: string[] = [];
  const cautions: string[] = [];
  if (ordered.length < CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minTrainExamples + CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minOosExamples) blockers.push("INSUFFICIENT_CHRONOLOGICAL_OOS_DATA");
  const foldSize = Math.floor((ordered.length - CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minTrainExamples) / CORTEX_SHADOW_REFIT_HYPERPARAMETERS.folds);
  if (foldSize < CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minOosExamples) blockers.push("OOS_FOLDS_BELOW_MINIMUM");
  else for (let fold = 0; fold < CORTEX_SHADOW_REFIT_HYPERPARAMETERS.folds; fold += 1) {
    const trainEnd = CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minTrainExamples + fold * foldSize;
    const train = ordered.slice(0, trainEnd);
    const oos = ordered.slice(trainEnd, Math.min(ordered.length, trainEnd + foldSize));
    const opportunities = new Set(train.map((row) => row.opportunityId));
    const safeOos = oos.filter((row) => !opportunities.has(row.opportunityId) && row.decisionTimeMs > (train.at(-1)?.resolvedTimeMs ?? -Infinity));
    const fit = refitCortexEconomicModel(train.map((row) => ({ x: [...row.x], realizedNetR: row.netR, tMs: row.resolvedTimeMs, schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION })), [...prior], { nowMs: safeOos.at(-1)?.resolvedTimeMs ?? nowMs, ...CORTEX_SHADOW_REFIT_HYPERPARAMETERS });
    const candidate = metrics(safeOos, fit.status === "ACCEPTED" ? fit.coefficients : null);
    const incumbent = metrics(safeOos, prior);
    const expectedEconomicDeltaR = fit.status === "ACCEPTED" ? meanPredictionDelta(safeOos, fit.coefficients, prior) : null;
    folds.push({
      fold: fold + 1,
      trainStartMs: train[0]?.decisionTimeMs ?? null, trainEndMs: train.at(-1)?.resolvedTimeMs ?? null,
      oosStartMs: safeOos[0]?.decisionTimeMs ?? null, oosEndMs: safeOos.at(-1)?.resolvedTimeMs ?? null,
      trainN: train.length, oosN: safeOos.length, fitStatus: fit.status,
      candidate, incumbent, expectedEconomicDeltaR,
    });
  }
  if (fullFit.status !== "ACCEPTED") blockers.push(`FIT_${fullFit.status}`);
  if (folds.some((fold) => fold.fitStatus !== "ACCEPTED" || fold.oosN < CORTEX_SHADOW_REFIT_HYPERPARAMETERS.minOosExamples)) blockers.push("INVALID_OOS_FOLD");
  if (metrics(ordered, null).symbolConcentrationPct != null && metrics(ordered, null).symbolConcentrationPct! > 60) cautions.push("SYMBOL_CONCENTRATION_ABOVE_60_PCT");
  return { fit: fullFit, folds, blockers: [...new Set(blockers)], cautions };
}

function emptyMetrics(): CortexShadowMetrics { return metrics([], null); }

function candidateForDataset(dataset: CortexShadowDataset, incumbent: CortexStoreState, nowMs: number, codeVersion: string): CortexShadowCandidateGeneration {
  const archetypes = ARCHETYPES.map((archetype) => {
    const rows = dataset.examples.filter((row) => row.archetype === archetype);
    const prior = incumbent.archetypes[archetype].w;
    const result = fitArchetype(rows, prior, nowMs);
    const coefficients = result.fit.status === "ACCEPTED" ? result.fit.coefficients : [...prior];
    const train = metrics(rows, coefficients);
    const oosRows = rows.filter((row) => result.folds.some((fold) =>
      fold.oosStartMs != null && fold.oosEndMs != null && row.decisionTimeMs >= fold.oosStartMs && row.resolvedTimeMs <= fold.oosEndMs,
    ));
    const oos = metrics(oosRows, coefficients);
    const incumbentOos = metrics(oosRows, prior);
    const expectedEconomicDeltaR = meanPredictionDelta(oosRows, coefficients, prior);
    const coefficientMaxDelta = Math.max(0, ...coefficients.map((value, index) => Math.abs(value - prior[index]!)));
    return {
      archetype, n: rows.length, nEff: result.fit.effectiveSampleSize, coefficients, incumbentCoefficients: [...prior],
      fitStatus: result.fit.status, folds: result.folds, train, oos, expectedEconomicDeltaR, coefficientMaxDelta,
      blockers: result.blockers, cautions: result.cautions,
    } satisfies CortexShadowArchetypeCandidate;
  });
  const blockers = archetypes.flatMap((row) => row.blockers.map((blocker) => `${row.archetype}:${blocker}`));
  const cautions = archetypes.flatMap((row) => row.cautions.map((caution) => `${row.archetype}:${caution}`));
  return {
    generationId: `shadow-${dataset.datasetHash.slice(0, 20)}`,
    parentIncumbentGeneration: 0,
    createdAt: new Date(nowMs).toISOString(), resetEpoch: dataset.resetEpoch,
    trainingCutoffMs: dataset.examples.at(-1)?.resolvedTimeMs ?? nowMs,
    featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, datasetHash: dataset.datasetHash,
    exampleIds: dataset.examples.map((row) => row.exampleId), sourceLineage: dataset.sourceLineage,
    hyperparameters: CORTEX_SHADOW_REFIT_HYPERPARAMETERS, archetypes,
    shadowReady: false, blockers, cautions, codeVersion,
  };
}

function defaultRegistry(): CortexShadowRefitRegistry {
  return { schemaVersion: CORTEX_SHADOW_REFIT_SCHEMA_VERSION, candidates: [], lastDatasetHash: null, lastAudit: null };
}

function validCandidate(candidate: CortexShadowCandidateGeneration): boolean {
  return candidate.featureSchemaVersion === CORTEX_FEATURE_SCHEMA_VERSION &&
    candidate.archetypes.length === ARCHETYPES.length &&
    candidate.archetypes.every((row) => row.coefficients.length === CORTEX_FEATURE_DIM && row.coefficients.every(finite)) &&
    candidate.generationId === `shadow-${candidate.datasetHash.slice(0, 20)}`;
}

export class CortexShadowRefitRegistryStore {
  private state: CortexShadowRefitRegistry = defaultRegistry();
  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CortexShadowRefitRegistry;
      if (parsed.schemaVersion !== CORTEX_SHADOW_REFIT_SCHEMA_VERSION || !Array.isArray(parsed.candidates) || !parsed.candidates.every(validCandidate)) return;
      this.state = { ...parsed, candidates: [...parsed.candidates] };
    } catch { this.state = defaultRegistry(); }
  }
  get(): CortexShadowRefitRegistry { return this.state; }
  save(next: CortexShadowRefitRegistry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, this.file);
    this.state = next;
  }
}

/** Manual-only entry point. No module registers this function with a scheduler. */
export function runCortexShadowRefit(input: {
  outcomes: readonly ExecutiveReviewOutcome[];
  forwardEvents: readonly ForwardEvent[];
  policy: CanonicalPolicyContext & { instanceId: "3101" | "3102"; fourBrainPolicyVersion: string };
  incumbent: CortexStoreState;
  registry: CortexShadowRefitRegistryStore;
  nowMs: number;
  resetEpoch?: string;
  codeVersion?: string;
}): CortexShadowRunReport {
  const dataset = buildCortexShadowTrainingDataset(input);
  const previous = input.registry.get();
  const generatedAt = new Date(input.nowMs).toISOString();
  if (previous.lastDatasetHash === dataset.datasetHash) {
    return { status: "NO_NEW_ELIGIBLE_DATA", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate: previous.candidates.at(-1) ?? null, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: [] };
  }
  if (dataset.examples.length === 0) {
    const report: CortexShadowRunReport = { status: "NO_REFIT", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate: null, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: ["NO_ELIGIBLE_EXAMPLES"] };
    input.registry.save({ ...previous, lastDatasetHash: dataset.datasetHash, lastAudit: report });
    return report;
  }
  const candidate = candidateForDataset(dataset, input.incumbent, input.nowMs, input.codeVersion ?? "unknown");
  // Per-archetype failures remain explicit blockers on the persisted candidate. They must not erase
  // a valid BREADTH/NEUTRAL/Tactical fit merely because a different archetype has no observations.
  const hasAnyAcceptedFit = candidate.archetypes.some((row) => row.fitStatus === "ACCEPTED");
  const report: CortexShadowRunReport = { status: hasAnyAcceptedFit ? "CANDIDATE_CREATED" : "NO_REFIT", generatedAt, resetEpoch: dataset.resetEpoch, dataset, candidate, beta: { evaluationBeta: 0, liveBeta: 0 }, blockers: candidate.blockers };
  input.registry.save({
    schemaVersion: CORTEX_SHADOW_REFIT_SCHEMA_VERSION,
    candidates: previous.candidates.some((row) => row.datasetHash === candidate.datasetHash) ? previous.candidates : [...previous.candidates, candidate],
    lastDatasetHash: dataset.datasetHash,
    lastAudit: report,
  });
  return report;
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
  readonly incumbentGeneration: 0;
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
    incumbentGeneration: 0,
    perArchetype: audit?.candidate?.archetypes.map((row) => ({
      archetype: row.archetype, eligible: row.n, nEff: row.nEff, fitStatus: row.fitStatus,
      coefficientMaxDelta: row.coefficientMaxDelta,
      oosVerdict: row.blockers.length === 0 ? "VALID" : "BLOCKED",
    })) ?? ARCHETYPES.map((archetype) => ({ archetype, eligible: 0, nEff: 0, fitStatus: "NO_REFIT" as const, coefficientMaxDelta: 0, oosVerdict: "BLOCKED" as const })),
    beta: { evaluationBeta: 0, liveBeta: 0 }, promotion: "OFF",
  };
}

/**
 * PARALLEL SHADOW EXPERIMENT MATRIX (REPORT-ONLY)
 *
 * Isolated, config-driven observation tape for evaluating multiple controller
 * aligned hypotheses in parallel. This module never touches normal shadow
 * positions, route selection, readiness, scoring, or live behavior.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  FILTERED_EDGE_CHRONOLOGY_VERSION,
  FILTERED_EDGE_FORENSICS_VERSION,
  FILTERED_EDGE_PATH_METRIC_VERSION,
  deriveChronologyStatus,
  deriveFreshValidStatus,
  deriveIntrabarResolutionStatus,
  derivePathMetric,
  type FilteredEdgeChronologyStatus,
  type FilteredEdgeIntrabarStatus,
  type FilteredEdgePathMetricStatus,
  type FilteredEdgeShadowPosition,
} from "./regime-controller-filtered-edge-shadow.js";
import { computeControllerAlignedGuardThreshold } from "./regime-controller-aligned-shadow.js";

export const PARALLEL_SHADOW_EXPERIMENT_LANE =
  "PARALLEL_SHADOW_EXPERIMENT_MATRIX_V1" as const;
export const PARALLEL_SHADOW_EXPERIMENT_POLICY_VERSION =
  "parallel-shadow-experiment-matrix-v1" as const;

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, file);
}

export type ParallelExperimentId =
  | "BASE_BROAD_COST20_STOP150"
  | "BASE_COST10_ONLY"
  | "BASE_COST15_STOP175"
  | "BASE_COST10_STOP175"
  | "INJ_ONLY_COST20_STOP150"
  | "INJ_ONLY_COST10"
  | "ARBUSDT_POLICY_SHORT"
  | "OPUSDT_POLICY_SHORT"
  | "FETUSDT_POLICY_SHORT"
  | "WLDUSDT_LOW_COST_SHORT"
  | "EXCLUDE_MAJOR_TOXIC_COST20_STOP150"
  | "EXCLUDE_BTC_LINK_AVAX_COST20_STOP150"
  | "EXCLUDE_NEAR_BTC_LINK_COST20_STOP150"
  | "EXCLUDE_HIGH_COST_TOXIC_SYMBOLS_COST10"
  | "TREND_ALIGNED_COST20_STOP150"
  | "SOURCE_FALSE_TREND_ALIGNED_COST20"
  | "KRONOS_AGREES_COST20_STOP150"
  | "WHALE_AGREES_COST20_STOP150"
  | "KRONOS_AND_WHALE_AGREE_COST20"
  | "NO_HORIZON_CONFLICT_TREND_ALIGNED_COST20";

export type ParallelExperimentStatus =
  | "COLLECTING"
  | "WATCHABLE"
  | "PROMOTION_CANDIDATE"
  | "KILL";

type Direction = "LONG" | "SHORT";
type RegimeFamily = "bearish" | "bullish" | "mixed" | "sideways" | "unknown";

export interface ParallelShadowExperimentDefinition {
  id: ParallelExperimentId;
  label: string;
  controllerAligned?: boolean;
  maxCostR?: number;
  minStopDistanceBps?: number;
  symbolInclude?: string[];
  symbolExclude?: string[];
  regimeFamily?: RegimeFamily;
  direction?: Direction;
  trendAligned?: boolean;
  sourceConflict?: boolean;
  kronosAgrees?: boolean;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE";
  horizonConflict?: boolean;
  exitPolicy: "tp1_full_exit";
}

export const PARALLEL_SHADOW_EXPERIMENTS: readonly ParallelShadowExperimentDefinition[] = [
  { id: "BASE_BROAD_COST20_STOP150", label: "Base broad cost20 stop150", controllerAligned: true, maxCostR: 0.20, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "BASE_COST10_ONLY", label: "Base cost10 only", controllerAligned: true, maxCostR: 0.10, exitPolicy: "tp1_full_exit" },
  { id: "BASE_COST15_STOP175", label: "Base cost15 stop175", controllerAligned: true, maxCostR: 0.15, minStopDistanceBps: 175, exitPolicy: "tp1_full_exit" },
  { id: "BASE_COST10_STOP175", label: "Base cost10 stop175", controllerAligned: true, maxCostR: 0.10, minStopDistanceBps: 175, exitPolicy: "tp1_full_exit" },
  { id: "INJ_ONLY_COST20_STOP150", label: "INJ only cost20 stop150", controllerAligned: true, symbolInclude: ["INJUSDT"], maxCostR: 0.20, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "INJ_ONLY_COST10", label: "INJ only cost10", controllerAligned: true, symbolInclude: ["INJUSDT"], maxCostR: 0.10, exitPolicy: "tp1_full_exit" },
  { id: "ARBUSDT_POLICY_SHORT", label: "ARBUSDT bearish short", symbolInclude: ["ARBUSDT"], regimeFamily: "bearish", direction: "SHORT", exitPolicy: "tp1_full_exit" },
  { id: "OPUSDT_POLICY_SHORT", label: "OPUSDT bearish short", symbolInclude: ["OPUSDT"], regimeFamily: "bearish", direction: "SHORT", exitPolicy: "tp1_full_exit" },
  { id: "FETUSDT_POLICY_SHORT", label: "FETUSDT bearish short", symbolInclude: ["FETUSDT"], regimeFamily: "bearish", direction: "SHORT", exitPolicy: "tp1_full_exit" },
  { id: "WLDUSDT_LOW_COST_SHORT", label: "WLDUSDT low cost short", symbolInclude: ["WLDUSDT"], direction: "SHORT", maxCostR: 0.15, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "EXCLUDE_MAJOR_TOXIC_COST20_STOP150", label: "Exclude major toxic cost20 stop150", controllerAligned: true, maxCostR: 0.20, minStopDistanceBps: 150, symbolExclude: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "LINKUSDT", "NEARUSDT", "AVAXUSDT"], exitPolicy: "tp1_full_exit" },
  { id: "EXCLUDE_BTC_LINK_AVAX_COST20_STOP150", label: "Exclude BTC LINK AVAX cost20 stop150", controllerAligned: true, maxCostR: 0.20, minStopDistanceBps: 150, symbolExclude: ["BTCUSDT", "LINKUSDT", "AVAXUSDT"], exitPolicy: "tp1_full_exit" },
  { id: "EXCLUDE_NEAR_BTC_LINK_COST20_STOP150", label: "Exclude NEAR BTC LINK cost20 stop150", controllerAligned: true, maxCostR: 0.20, minStopDistanceBps: 150, symbolExclude: ["NEARUSDT", "BTCUSDT", "LINKUSDT"], exitPolicy: "tp1_full_exit" },
  { id: "EXCLUDE_HIGH_COST_TOXIC_SYMBOLS_COST10", label: "Exclude high cost toxic cost10", controllerAligned: true, maxCostR: 0.10, symbolExclude: ["BTCUSDT", "LINKUSDT", "AVAXUSDT", "NEARUSDT"], exitPolicy: "tp1_full_exit" },
  { id: "TREND_ALIGNED_COST20_STOP150", label: "Trend aligned cost20 stop150", controllerAligned: true, trendAligned: true, maxCostR: 0.20, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "SOURCE_FALSE_TREND_ALIGNED_COST20", label: "Source false trend aligned cost20", controllerAligned: true, sourceConflict: false, trendAligned: true, maxCostR: 0.20, exitPolicy: "tp1_full_exit" },
  { id: "KRONOS_AGREES_COST20_STOP150", label: "Kronos agrees cost20 stop150", controllerAligned: true, kronosAgrees: true, maxCostR: 0.20, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "WHALE_AGREES_COST20_STOP150", label: "Whale agrees cost20 stop150", controllerAligned: true, whaleAgreement: "AGREES", maxCostR: 0.20, minStopDistanceBps: 150, exitPolicy: "tp1_full_exit" },
  { id: "KRONOS_AND_WHALE_AGREE_COST20", label: "Kronos and whale agree cost20", controllerAligned: true, kronosAgrees: true, whaleAgreement: "AGREES", maxCostR: 0.20, exitPolicy: "tp1_full_exit" },
  { id: "NO_HORIZON_CONFLICT_TREND_ALIGNED_COST20", label: "No horizon conflict trend aligned cost20", controllerAligned: true, horizonConflict: false, trendAligned: true, maxCostR: 0.20, exitPolicy: "tp1_full_exit" },
];

export interface ParallelShadowExperimentCandidate {
  symbol: string;
  direction: Direction;
  controllerMode: string;
  currentRegime: string | null;
  marketRegimeAtOpen?: string | null;
  regimeFamily: RegimeFamily;
  entryPrice: number;
  stopLoss: number;
  takeProfits: { tp1?: number; tp2?: number; tp3?: number };
  stopDistanceBps: number | null;
  costR: number | null;
  atrPercent: number | null;
  sourceConflict: boolean;
  liveSourceConflict?: boolean | null;
  kronosBias?: string | null;
  kronosAgrees?: boolean | null;
  whaleAgreement?: string | null;
  trendAligned?: boolean | null;
  selectedEntryVariant?: string | null;
  selectedExitVariant?: string | null;
  kronosHorizonConflict?: boolean | null;
  selectedExecutionPlan?: unknown;
}

export function collectParallelShadowExperimentMissingFields(
  candidate: ParallelShadowExperimentCandidate,
): string[] {
  const missing: string[] = [];
  if (!candidate.symbol) missing.push("symbol");
  if (candidate.direction !== "LONG" && candidate.direction !== "SHORT") missing.push("direction");
  if (!candidate.controllerMode) missing.push("controllerMode");
  if (!(typeof candidate.costR === "number" && Number.isFinite(candidate.costR))) missing.push("costR");
  if (!(typeof candidate.stopDistanceBps === "number" && Number.isFinite(candidate.stopDistanceBps))) {
    missing.push("stopDistanceBps");
  }
  if (!candidate.selectedEntryVariant) missing.push("entryVariant");
  if (!candidate.selectedExitVariant) missing.push("exitVariant");
  if (typeof candidate.sourceConflict !== "boolean") missing.push("sourceConflict");
  if (candidate.trendAligned === null || candidate.trendAligned === undefined) missing.push("trendAligned");
  if (candidate.kronosAgrees === null || candidate.kronosAgrees === undefined) missing.push("kronosAgrees");
  if (!candidate.whaleAgreement) missing.push("whaleAgreement");
  if (candidate.kronosHorizonConflict === null || candidate.kronosHorizonConflict === undefined) {
    missing.push("horizonConflict");
  }
  if (!(candidate.entryPrice > 0)) missing.push("currentPrice");
  if (!(candidate.stopLoss > 0)) missing.push("stopLoss");
  if (!(typeof candidate.takeProfits.tp1 === "number" && candidate.takeProfits.tp1 > 0)) {
    missing.push("takeProfitLevels");
  }
  return missing;
}

export interface ParallelShadowExperimentObservation {
  id: string;
  experimentId: ParallelExperimentId;
  experimentLabel: string;
  symbol: string;
  direction: Direction;
  controllerMode: string;
  currentRegime: string | null;
  marketRegimeAtOpen: string | null;
  regimeFamily: RegimeFamily;
  openedAt: string;
  createdAt: string;
  updatedAt?: string | null;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number | null;
  costR: number | null;
  atrPercent: number | null;
  variantAdjustedGuardThresholdBps: number | null;
  guardPassedUnder: "VARIANT_ADJUSTED" | "FALLBACK_FIXED_175" | "FAILED_VARIANT_ADJUSTED";
  sourceConflict: boolean;
  liveSourceConflict: boolean | null;
  kronosBias: string | null;
  kronosAgrees: boolean | null;
  whaleAgreement: string | null;
  trendAligned: boolean | null;
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  kronosHorizonConflict: boolean | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED" | "NO_FILL" | "AMBIGUOUS";
  closedAt: string | null;
  grossR: number | null;
  netR: number | null;
  resolutionSource: string | null;
  durationMinutes: number | null;
  chronologyStatus?: FilteredEdgeChronologyStatus | null;
  chronologyWarning?: string | null;
  maxMfeR?: number | null;
  minMaeR?: number | null;
  mfeBeforeCloseR?: number | null;
  maeBeforeCloseR?: number | null;
  pathMetricStatus?: FilteredEdgePathMetricStatus | null;
  pathMetricWarning?: string | null;
  immediateSl?: boolean;
  noMfeBeforeSl?: boolean;
  intrabarResolutionStatus?:
    | "VALID_5M_ORDERED"
    | "AMBIGUOUS_SAME_CANDLE"
    | "RESOLVED_BY_1M"
    | "INTRABAR_UNAVAILABLE"
    | null;
  fillCandleOpenTime?: number | null;
  fillCandleLow?: number | null;
  fillCandleHigh?: number | null;
  ambiguousLevelsTouched?: string[] | null;
  isFreshValid?: boolean | null;
  reportOnly: true;
  laneVersion: typeof PARALLEL_SHADOW_EXPERIMENT_LANE;
  policyVersion: typeof PARALLEL_SHADOW_EXPERIMENT_POLICY_VERSION;
  analyticsVersion?: typeof FILTERED_EDGE_FORENSICS_VERSION | null;
  pathMetricVersion?: typeof FILTERED_EDGE_PATH_METRIC_VERSION | null;
  chronologyVersion?: typeof FILTERED_EDGE_CHRONOLOGY_VERSION | null;
}

export interface ParallelShadowExperimentAdmissionDiagnostics {
  disabled: boolean;
  matrixAdmissionInvoked: boolean;
  lastAdmissionAt: string | null;
  lastScanBatchId: string | null;
  candidatesSeen: number;
  candidatesEvaluated: number;
  observationsCreated: number;
  duplicateSuppressed: number;
  rejectedTotal: number;
  rejectedByReason: Array<{ reason: string; count: number }>;
  fieldMissingCounts: Record<string, number>;
  env: {
    PARALLEL_SHADOW_EXPERIMENTS_DISABLED: string | null;
    EXPERIMENT_MATRIX_DISABLED: string | null;
  };
}

interface ParallelShadowExperimentStoreState {
  observations: ParallelShadowExperimentObservation[];
  latestAdmissionDiagnostics?: ParallelShadowExperimentAdmissionDiagnostics | null;
}

export class ParallelShadowExperimentStore {
  private readonly file: string;
  private observations: ParallelShadowExperimentObservation[];
  private latestDiagnostics: ParallelShadowExperimentAdmissionDiagnostics | null;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "parallel-shadow-experiments.json");
    mkdirSync(dirname(this.file), { recursive: true });
    const state = this._load();
    this.observations = state.observations;
    this.latestDiagnostics = state.latestAdmissionDiagnostics ?? null;
  }

  get path(): string {
    return this.file;
  }

  get all(): ParallelShadowExperimentObservation[] {
    return this.observations;
  }

  get latestAdmissionDiagnostics(): ParallelShadowExperimentAdmissionDiagnostics | null {
    return this.latestDiagnostics;
  }

  private _load(): ParallelShadowExperimentStoreState {
    try {
      if (!existsSync(this.file)) return { observations: [], latestAdmissionDiagnostics: null };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (Array.isArray(parsed)) {
        return { observations: parsed as ParallelShadowExperimentObservation[], latestAdmissionDiagnostics: null };
      }
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { observations?: unknown }).observations)) {
        return parsed as ParallelShadowExperimentStoreState;
      }
      return { observations: [], latestAdmissionDiagnostics: null };
    } catch {
      return { observations: [], latestAdmissionDiagnostics: null };
    }
  }

  save(): void {
    try {
      writeJsonAtomic(this.file, {
        observations: this.observations,
        latestAdmissionDiagnostics: this.latestDiagnostics,
      });
    } catch {
      // report-only storage failures must never affect the app
    }
  }

  add(observation: ParallelShadowExperimentObservation): void {
    this.observations.push(observation);
    this.save();
  }

  addMany(observations: ParallelShadowExperimentObservation[]): void {
    if (observations.length === 0) return;
    this.observations.push(...observations);
    this.save();
  }

  recordAdmissionDiagnostics(diagnostics: ParallelShadowExperimentAdmissionDiagnostics): void {
    this.latestDiagnostics = diagnostics;
    this.save();
  }

  update(id: string, patch: Partial<ParallelShadowExperimentObservation>): void {
    const idx = this.observations.findIndex((obs) => obs.id === id);
    if (idx < 0) return;
    this.observations[idx] = {
      ...this.observations[idx]!,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  isDuplicate(
    symbol: string,
    direction: string,
    experimentId: ParallelExperimentId,
    selectedEntryVariant: string | null,
    selectedExitVariant: string | null,
    windowMs = 4 * 60 * 60 * 1000,
  ): boolean {
    const now = Date.now();
    return this.observations.some((obs) => {
      const openedMs = new Date(obs.openedAt).getTime();
      return (
        obs.symbol === symbol &&
        obs.direction === direction &&
        obs.experimentId === experimentId &&
        obs.selectedEntryVariant === selectedEntryVariant &&
        obs.selectedExitVariant === selectedExitVariant &&
        (obs.status === "OPEN" || obs.status === "AMBIGUOUS") &&
        Number.isFinite(openedMs) &&
        now - openedMs < windowMs
      );
    });
  }
}

let singleton: ParallelShadowExperimentStore | null = null;

export function getParallelShadowExperimentStore(dataDir = "data"): ParallelShadowExperimentStore {
  if (!singleton) singleton = new ParallelShadowExperimentStore(dataDir);
  return singleton;
}

export function _resetParallelShadowExperimentStoreForTests(): void {
  singleton = null;
}

export interface ParallelExperimentAdmissionResult {
  admittedExperimentIds: ParallelExperimentId[];
  rejectedByExperiment: Record<ParallelExperimentId, string[]>;
}

function normalizeRegimeFamily(value: string | null | undefined): RegimeFamily {
  const upper = String(value ?? "").toUpperCase();
  if (upper.includes("BEAR")) return "bearish";
  if (upper.includes("BULL")) return "bullish";
  if (upper.includes("SIDE") || upper.includes("RANGE") || upper.includes("CHOP")) return "sideways";
  if (upper.includes("MIX") || upper.includes("ROTATION")) return "mixed";
  return "unknown";
}

export function deriveParallelExperimentRegimeFamily(value: string | null | undefined): RegimeFamily {
  return normalizeRegimeFamily(value);
}

function matchesController(candidate: ParallelShadowExperimentCandidate): boolean {
  if (candidate.controllerMode !== "LONG_ONLY" && candidate.controllerMode !== "SHORT_ONLY") return false;
  if (candidate.controllerMode === "LONG_ONLY") return candidate.direction === "LONG";
  return candidate.direction === "SHORT";
}

function evaluateExperiment(
  experiment: ParallelShadowExperimentDefinition,
  candidate: ParallelShadowExperimentCandidate,
): string[] {
  const reasons: string[] = [];
  if (candidate.selectedExecutionPlan == null) reasons.push("MISSING_EXECUTION_PLAN");
  if (!(candidate.entryPrice > 0)) reasons.push("MISSING_ENTRY_PRICE");
  if (!(candidate.stopLoss > 0)) reasons.push("MISSING_STOP_LOSS");
  if (!(typeof candidate.takeProfits.tp1 === "number" && candidate.takeProfits.tp1 > 0)) reasons.push("MISSING_TP1");
  if (candidate.selectedExitVariant !== experiment.exitPolicy) reasons.push("EXIT_POLICY_NOT_TP1_FULL");

  if (experiment.controllerAligned) {
    if (!matchesController(candidate)) reasons.push("NOT_CONTROLLER_ALIGNED");
    if (candidate.sourceConflict === true) reasons.push("SOURCE_CONFLICT_TRUE");
    const guard = computeControllerAlignedGuardThreshold(candidate.atrPercent);
    if (candidate.stopDistanceBps === null || candidate.stopDistanceBps < guard.variantAdjustedGuardThresholdBps) {
      reasons.push("STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD");
    }
  }
  if (experiment.maxCostR !== undefined && (candidate.costR === null || candidate.costR > experiment.maxCostR)) {
    reasons.push("COST_R_ABOVE_LIMIT");
  }
  if (
    experiment.minStopDistanceBps !== undefined &&
    (candidate.stopDistanceBps === null || candidate.stopDistanceBps < experiment.minStopDistanceBps)
  ) {
    reasons.push("STOP_DISTANCE_BELOW_LIMIT");
  }
  if (experiment.symbolInclude && !experiment.symbolInclude.includes(candidate.symbol)) {
    reasons.push("SYMBOL_NOT_INCLUDED");
  }
  if (experiment.symbolExclude && experiment.symbolExclude.includes(candidate.symbol)) {
    reasons.push("SYMBOL_EXCLUDED");
  }
  if (experiment.regimeFamily && candidate.regimeFamily !== experiment.regimeFamily) {
    reasons.push("REGIME_FAMILY_MISMATCH");
  }
  if (experiment.direction && candidate.direction !== experiment.direction) {
    reasons.push("DIRECTION_MISMATCH");
  }
  if (experiment.trendAligned !== undefined && candidate.trendAligned !== experiment.trendAligned) {
    reasons.push("TREND_ALIGNMENT_MISMATCH");
  }
  if (experiment.sourceConflict !== undefined && candidate.sourceConflict !== experiment.sourceConflict) {
    reasons.push("SOURCE_CONFLICT_MISMATCH");
  }
  if (experiment.kronosAgrees !== undefined && candidate.kronosAgrees !== experiment.kronosAgrees) {
    reasons.push("KRONOS_AGREEMENT_MISMATCH");
  }
  if (experiment.whaleAgreement !== undefined && candidate.whaleAgreement !== experiment.whaleAgreement) {
    reasons.push("WHALE_AGREEMENT_MISMATCH");
  }
  if (experiment.horizonConflict !== undefined && candidate.kronosHorizonConflict !== experiment.horizonConflict) {
    reasons.push("HORIZON_CONFLICT_MISMATCH");
  }
  return reasons;
}

export function admitToParallelShadowExperiments(
  candidate: ParallelShadowExperimentCandidate,
  store: ParallelShadowExperimentStore,
): ParallelExperimentAdmissionResult {
  const admittedExperimentIds: ParallelExperimentId[] = [];
  const rejectedByExperiment = {} as Record<ParallelExperimentId, string[]>;

  for (const experiment of PARALLEL_SHADOW_EXPERIMENTS) {
    const reasons = evaluateExperiment(experiment, candidate);
    if (reasons.length === 0 && store.isDuplicate(
      candidate.symbol,
      candidate.direction,
      experiment.id,
      candidate.selectedEntryVariant ?? null,
      candidate.selectedExitVariant ?? null,
    )) {
      reasons.push("DUPLICATE_OPEN_OBSERVATION_FOR_EXPERIMENT");
    }
    if (reasons.length === 0) {
      admittedExperimentIds.push(experiment.id);
    } else {
      rejectedByExperiment[experiment.id] = reasons;
    }
  }
  return { admittedExperimentIds, rejectedByExperiment };
}

export function buildParallelShadowExperimentObservation(
  candidate: ParallelShadowExperimentCandidate,
  experimentId: ParallelExperimentId,
  nowIso = new Date().toISOString(),
): ParallelShadowExperimentObservation {
  const experiment = PARALLEL_SHADOW_EXPERIMENTS.find((item) => item.id === experimentId);
  const guard = computeControllerAlignedGuardThreshold(candidate.atrPercent);
  const tp1 = candidate.takeProfits.tp1 ?? 0;
  const tp2 = candidate.takeProfits.tp2 ?? 0;
  const tp3 = candidate.takeProfits.tp3 ?? 0;
  return {
    id: `${candidate.symbol}-${experimentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    experimentId,
    experimentLabel: experiment?.label ?? experimentId,
    symbol: candidate.symbol,
    direction: candidate.direction,
    controllerMode: candidate.controllerMode,
    currentRegime: candidate.currentRegime ?? null,
    marketRegimeAtOpen: candidate.marketRegimeAtOpen ?? candidate.currentRegime ?? null,
    regimeFamily: candidate.regimeFamily,
    openedAt: nowIso,
    createdAt: nowIso,
    entryPrice: candidate.entryPrice,
    stopLoss: candidate.stopLoss,
    takeProfitLevels: [tp1, tp2, tp3].filter((value) => value > 0),
    stopDistanceBps: candidate.stopDistanceBps ?? null,
    costR: candidate.costR ?? null,
    atrPercent: candidate.atrPercent ?? null,
    variantAdjustedGuardThresholdBps: guard.variantAdjustedGuardThresholdBps,
    guardPassedUnder: "VARIANT_ADJUSTED",
    sourceConflict: candidate.sourceConflict,
    liveSourceConflict: candidate.liveSourceConflict ?? null,
    kronosBias: candidate.kronosBias ?? null,
    kronosAgrees: candidate.kronosAgrees ?? null,
    whaleAgreement: candidate.whaleAgreement ?? null,
    trendAligned: candidate.trendAligned ?? null,
    selectedEntryVariant: candidate.selectedEntryVariant ?? null,
    selectedExitVariant: candidate.selectedExitVariant ?? null,
    kronosHorizonConflict: candidate.kronosHorizonConflict ?? null,
    status: "OPEN",
    closedAt: null,
    grossR: null,
    netR: null,
    resolutionSource: null,
    durationMinutes: null,
    reportOnly: true,
    laneVersion: PARALLEL_SHADOW_EXPERIMENT_LANE,
    policyVersion: PARALLEL_SHADOW_EXPERIMENT_POLICY_VERSION,
    analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
    pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
    chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
  };
}

function asFilteredEdgeObservation(obs: ParallelShadowExperimentObservation): FilteredEdgeShadowPosition {
  return {
    ...obs,
    profile: "STRICT_COST10",
    laneVersion: "REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1",
    policyVersion: "filtered-edge-anchor-consistent-v1",
  } as FilteredEdgeShadowPosition;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function tryResolveIntrabarWith1m(
  obs: ParallelShadowExperimentObservation,
  binanceClient: {
    getKlines: (
      symbol: string,
      interval: string,
      opts: { startTime: number; endTime: number; limit: number },
    ) => Promise<Array<[number, string, string, string, string, string, number, ...unknown[]]>>;
  },
  fillCandleOpenTime: number,
  openedAtMs: number,
): Promise<{ resolved: boolean; status?: "CLOSED_WIN" | "CLOSED_LOSS"; resolutionSource?: string }> {
  try {
    const entry = obs.entryPrice;
    const stop = obs.stopLoss;
    const tp1 = obs.takeProfitLevels[0] ?? null;
    const dir = obs.direction;
    const raw1m = await binanceClient.getKlines(obs.symbol, "1m", {
      startTime: fillCandleOpenTime,
      endTime: fillCandleOpenTime + 5 * 60 * 1000,
      limit: 6,
    });
    for (const candle of raw1m) {
      const candleOpenMs = Number(candle[0]);
      if (candleOpenMs < openedAtMs) continue;
      const high = Number(candle[2]);
      const low = Number(candle[3]);
      const slHit = stop > 0 && (dir === "LONG" ? low <= stop : high >= stop);
      const tp1Hit = tp1 !== null && (dir === "LONG" ? high >= tp1 : low <= tp1);
      if (slHit) return { resolved: true, status: "CLOSED_LOSS", resolutionSource: "INTRABAR_1M_SL" };
      if (tp1Hit) return { resolved: true, status: "CLOSED_WIN", resolutionSource: "INTRABAR_1M_TP" };
    }
    return { resolved: false };
  } catch {
    return { resolved: false };
  }
}

export async function resolveParallelShadowExperimentObservations(
  store: ParallelShadowExperimentStore,
  binanceClient: {
    getKlines: (
      symbol: string,
      interval: string,
      opts: { startTime: number; endTime: number; limit: number },
    ) => Promise<Array<[number, string, string, string, string, string, number, ...unknown[]]>>;
  },
): Promise<{ resolved: number; errors: number }> {
  let resolved = 0;
  let errors = 0;
  try {
    const nowMs = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const candleMs = 5 * 60 * 1000;

    for (const obs of store.all) {
      if (obs.status !== "OPEN") continue;
      try {
        const createdAtMs = parseMs(obs.createdAt) ?? parseMs(obs.openedAt) ?? nowMs;
        const persistedOpenedAtMs = parseMs(obs.openedAt);
        const rawCandles = await binanceClient.getKlines(obs.symbol, "5m", {
          startTime: createdAtMs - candleMs,
          endTime: nowMs + twoHoursMs,
          limit: Math.min(Math.max(Math.ceil((nowMs + twoHoursMs - (createdAtMs - candleMs)) / candleMs) + 2, 12), 500),
        });

        const entry = obs.entryPrice;
        const stop = obs.stopLoss;
        const tp1 = obs.takeProfitLevels[0] ?? null;
        const dir = obs.direction;
        const risk = Math.abs(entry - stop);
        const ageMs = nowMs - createdAtMs;
        let filled = false;
        let effectiveOpenedAtMs: number | null =
          persistedOpenedAtMs !== null && persistedOpenedAtMs >= createdAtMs ? persistedOpenedAtMs : null;
        let closeStatus: ParallelShadowExperimentObservation["status"] | null = null;
        let closedAtMs: number | null = null;
        let grossR: number | null = null;
        let candlesWalked = 0;
        let runningMaxMfeR = 0;
        let runningMinMaeR = 0;
        let resolutionCandleIndex = -1;
        let pathMetricStatus: FilteredEdgePathMetricStatus | null = risk > 0 ? "VALID" : "PATH_METRIC_INVALID_RISK";
        let pathMetricWarning: string | null = risk > 0 ? null : "Risk must be positive to compute path metrics";
        let intrabarResolutionStatus: ParallelShadowExperimentObservation["intrabarResolutionStatus"] = null;
        let fillCandleOpenTime: number | null = null;
        let fillCandleLow: number | null = null;
        let fillCandleHigh: number | null = null;
        let ambiguousLevelsTouched: string[] | null = null;
        let isFreshValid: boolean | null = null;
        let ambiguityResolutionSource: string | null = null;
        let fillCandleIdx = -1;
        const openedAtForFillRef = persistedOpenedAtMs ?? createdAtMs;

        for (let i = 0; i < rawCandles.length; i += 1) {
          const candleTime = Number(rawCandles[i]![0]);
          if (candleTime <= openedAtForFillRef && openedAtForFillRef < candleTime + candleMs) {
            fillCandleIdx = i;
            break;
          }
        }

        for (let i = 0; i < rawCandles.length; i += 1) {
          const candle = rawCandles[i]!;
          const candleTime = Number(candle[0]);
          const high = Number(candle[2]);
          const low = Number(candle[3]);
          const closeTimeRaw = candle[6];
          const candleCloseTime = Number.isFinite(Number(closeTimeRaw)) ? Number(closeTimeRaw) : candleTime + candleMs;
          if (!filled) {
            const isFilled = dir === "LONG" ? low <= entry : high >= entry;
            if (!isFilled) continue;
            filled = true;
            effectiveOpenedAtMs = Math.max(createdAtMs, candleTime);
          }

          candlesWalked += 1;
          const isFillCandle = i === fillCandleIdx;

          if (risk > 0 && pathMetricStatus === "VALID") {
            const favorable = dir === "LONG" ? Math.max(high - entry, 0) : Math.max(entry - low, 0);
            const adverse = dir === "LONG" ? Math.min(low - entry, 0) : Math.min(entry - high, 0);
            const mfeR = favorable / risk;
            const maeR = adverse / risk;
            if (!Number.isFinite(mfeR) || !Number.isFinite(maeR) || mfeR < 0 || maeR > 0) {
              pathMetricStatus = "PATH_METRIC_INVALID_RISK";
              pathMetricWarning = "Derived non-finite or sign-invalid MFE/MAE";
            } else if (Math.abs(mfeR) > 20 || Math.abs(maeR) > 20) {
              pathMetricStatus = "PATH_METRIC_OUTLIER";
              pathMetricWarning = "Derived path metrics exceed 20R cap";
            } else {
              if (mfeR > runningMaxMfeR) runningMaxMfeR = mfeR;
              if (maeR < runningMinMaeR) runningMinMaeR = maeR;
            }
          }

          const slHit = stop > 0 && (dir === "LONG" ? low <= stop : high >= stop);
          const tp1Hit = tp1 !== null && (dir === "LONG" ? high >= tp1 : low <= tp1);
          if (isFillCandle && (slHit || tp1Hit)) {
            fillCandleOpenTime = candleTime;
            fillCandleLow = low;
            fillCandleHigh = high;
            ambiguousLevelsTouched = [];
            if (slHit) ambiguousLevelsTouched.push("SL");
            if (tp1Hit) ambiguousLevelsTouched.push("TP1");
            const oneMsRef = effectiveOpenedAtMs ?? createdAtMs;
            const oneM = await tryResolveIntrabarWith1m(obs, binanceClient, candleTime, oneMsRef);
            if (oneM.resolved && oneM.status) {
              closeStatus = oneM.status;
              closedAtMs = Math.max(oneMsRef, candleCloseTime);
              grossR = oneM.status === "CLOSED_WIN"
                ? risk > 0 ? (dir === "LONG" ? (tp1! - entry) / risk : (entry - tp1!) / risk) : 0
                : -1;
              intrabarResolutionStatus = "RESOLVED_BY_1M";
              isFreshValid = true;
              ambiguityResolutionSource = oneM.resolutionSource ?? null;
              resolutionCandleIndex = candlesWalked;
            } else {
              closeStatus = "AMBIGUOUS";
              intrabarResolutionStatus = "AMBIGUOUS_SAME_CANDLE";
              isFreshValid = false;
            }
            break;
          }

          if (!isFillCandle) {
            if (slHit) {
              closeStatus = "CLOSED_LOSS";
              closedAtMs = Math.max(effectiveOpenedAtMs ?? createdAtMs, candleCloseTime);
              grossR = -1;
              intrabarResolutionStatus = "VALID_5M_ORDERED";
              isFreshValid = true;
              resolutionCandleIndex = candlesWalked;
              break;
            }
            if (tp1Hit) {
              closeStatus = "CLOSED_WIN";
              closedAtMs = Math.max(effectiveOpenedAtMs ?? createdAtMs, candleCloseTime);
              grossR = risk > 0 ? (dir === "LONG" ? (tp1! - entry) / risk : (entry - tp1!) / risk) : 0;
              intrabarResolutionStatus = "VALID_5M_ORDERED";
              isFreshValid = true;
              resolutionCandleIndex = candlesWalked;
              break;
            }
          }
        }

        if ((closeStatus === "CLOSED_WIN" || closeStatus === "CLOSED_LOSS") && closedAtMs !== null) {
          const openedAtMs = effectiveOpenedAtMs ?? persistedOpenedAtMs ?? createdAtMs;
          const openedAt = new Date(openedAtMs).toISOString();
          const closedAt = new Date(closedAtMs).toISOString();
          const filteredLike = asFilteredEdgeObservation({
            ...obs,
            openedAt,
            closedAt,
            chronologyStatus: null,
            chronologyWarning: null,
          });
          const chronology = {
            status: deriveChronologyStatus(filteredLike),
            warning: deriveChronologyStatus(filteredLike) === "VALID" ? null : deriveChronologyStatus(filteredLike),
          };
          const durationMinutes = chronology.status === "VALID" ? Math.round((closedAtMs - openedAtMs) / 60000) : null;
          const maxMfeR = pathMetricStatus === "VALID" ? runningMaxMfeR : null;
          const minMaeR = pathMetricStatus === "VALID" ? runningMinMaeR : null;
          store.update(obs.id, {
            status: closeStatus,
            openedAt,
            closedAt,
            grossR,
            netR: grossR !== null ? grossR - (obs.costR ?? 0) : null,
            resolutionSource: ambiguityResolutionSource ?? (closeStatus === "CLOSED_WIN" ? "CANDLE_WALK_TP1" : "CANDLE_WALK_SL"),
            durationMinutes,
            chronologyStatus: chronology.status,
            chronologyWarning: chronology.warning,
            maxMfeR,
            minMaeR,
            mfeBeforeCloseR: maxMfeR,
            maeBeforeCloseR: minMaeR,
            pathMetricStatus,
            pathMetricWarning,
            immediateSl: chronology.status === "VALID" && pathMetricStatus === "VALID" && closeStatus === "CLOSED_LOSS" && resolutionCandleIndex >= 1 && resolutionCandleIndex <= 2,
            noMfeBeforeSl: chronology.status === "VALID" && pathMetricStatus === "VALID" && closeStatus === "CLOSED_LOSS" && maxMfeR !== null && maxMfeR < 0.1,
            intrabarResolutionStatus,
            fillCandleOpenTime,
            fillCandleLow,
            fillCandleHigh,
            ambiguousLevelsTouched,
            isFreshValid,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
          resolved += 1;
        } else if (closeStatus === "AMBIGUOUS") {
          store.update(obs.id, {
            status: "AMBIGUOUS",
            intrabarResolutionStatus,
            fillCandleOpenTime,
            fillCandleLow,
            fillCandleHigh,
            ambiguousLevelsTouched,
            isFreshValid: false,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
        } else if (filled && effectiveOpenedAtMs !== null) {
          store.update(obs.id, {
            openedAt: new Date(effectiveOpenedAtMs).toISOString(),
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
        } else if (ageMs > sevenDaysMs) {
          const openedAtMs = effectiveOpenedAtMs ?? persistedOpenedAtMs ?? createdAtMs;
          const openedAt = new Date(openedAtMs).toISOString();
          const closedAt = new Date(nowMs).toISOString();
          const filteredLike = asFilteredEdgeObservation({ ...obs, openedAt, closedAt });
          const chronologyStatus = deriveChronologyStatus(filteredLike);
          store.update(obs.id, {
            status: "EXPIRED",
            openedAt,
            closedAt,
            resolutionSource: filled ? "EXPIRED_AFTER_FILL" : "EXPIRED_NO_FILL",
            durationMinutes: chronologyStatus === "VALID" ? Math.round((nowMs - openedAtMs) / 60000) : null,
            chronologyStatus,
            chronologyWarning: chronologyStatus === "VALID" ? null : chronologyStatus,
            intrabarResolutionStatus: "INTRABAR_UNAVAILABLE",
            isFreshValid: null,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
          resolved += 1;
        }
      } catch {
        errors += 1;
      }
    }
  } catch {
    // report-only
  }
  return { resolved, errors };
}

export interface ParallelShadowExperimentRow {
  experimentId: ParallelExperimentId;
  label: string;
  total: number;
  open: number;
  resolved: number;
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgCostR: number | null;
  calendarDays: number | null;
  topSymbolShare: number | null;
  status: ParallelExperimentStatus;
  blockers: string[];
}

export interface ParallelShadowExperimentReport {
  reportOnly: true;
  laneVersion: typeof PARALLEL_SHADOW_EXPERIMENT_LANE;
  computedAt: string;
  experimentCount: number;
  rows: ParallelShadowExperimentRow[];
  baselineExperimentId: "BASE_BROAD_COST20_STOP150";
  latestAdmissionDiagnostics: ParallelShadowExperimentAdmissionDiagnostics | null;
}

function avg(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function pf(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const pos = finite.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const neg = finite.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  return pos > 0 && neg < 0 ? pos / Math.abs(neg) : null;
}

function calendarDays(observations: ParallelShadowExperimentObservation[]): number | null {
  if (observations.length === 0) return null;
  const times = observations.map((obs) => parseMs(obs.createdAt)).filter((value): value is number => value !== null);
  if (times.length === 0) return null;
  return Math.round(((Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000)) * 100) / 100;
}

function topSymbolShare(observations: ParallelShadowExperimentObservation[]): number | null {
  if (observations.length === 0) return null;
  const counts = new Map<string, number>();
  for (const obs of observations) counts.set(obs.symbol, (counts.get(obs.symbol) ?? 0) + 1);
  return Math.max(...counts.values()) / observations.length;
}

function deriveStatus(row: Omit<ParallelShadowExperimentRow, "status" | "blockers">, baselineNetAvgR: number | null): {
  status: ParallelExperimentStatus;
  blockers: string[];
} {
  const blockers: string[] = [];
  const beatsBaseline =
    row.experimentId === "BASE_BROAD_COST20_STOP150" ||
    (row.netAvgR !== null && baselineNetAvgR !== null && row.netAvgR > baselineNetAvgR);

  if (
    row.freshValid >= 30 &&
    row.netAvgR !== null &&
    row.netAvgR > 0.05 &&
    row.pf !== null &&
    row.pf > 1.2 &&
    row.calendarDays !== null &&
    row.calendarDays >= 3 &&
    row.topSymbolShare !== null &&
    row.topSymbolShare <= 0.6 &&
    beatsBaseline
  ) {
    return { status: "PROMOTION_CANDIDATE", blockers };
  }

  if ((row.freshValid >= 20 && row.netAvgR !== null && row.netAvgR < 0) || (row.freshValid >= 30 && (row.pf === null || row.pf < 1))) {
    return { status: "KILL", blockers: ["negative fresh-valid economics"] };
  }

  if (row.freshValid < 30) blockers.push("freshValidN < 30");
  if (row.netAvgR === null || row.netAvgR <= 0.05) blockers.push("netAvgR <= +0.05R");
  if (row.pf === null || row.pf <= 1.2) blockers.push("PF <= 1.20");
  if (row.calendarDays === null || row.calendarDays < 3) blockers.push("calendarDays < 3");
  if (row.topSymbolShare === null || row.topSymbolShare > 0.6) blockers.push("topSymbolShare > 60%");
  if (!beatsBaseline) blockers.push("does not beat BASE_BROAD_COST20_STOP150");

  if (row.freshValid >= 10 && row.netAvgR !== null && row.netAvgR > 0 && row.pf !== null && row.pf > 1) {
    return { status: "WATCHABLE", blockers };
  }
  return { status: "COLLECTING", blockers };
}

export function buildParallelShadowExperimentReport(
  store: ParallelShadowExperimentStore,
): ParallelShadowExperimentReport {
  const observations = store.all;
  const baselineFresh = observations.filter(
    (obs) => obs.experimentId === "BASE_BROAD_COST20_STOP150" && deriveFreshValidStatus(asFilteredEdgeObservation(obs)).freshValid,
  );
  const baselineNetAvgR = avg(baselineFresh.map((obs) => obs.netR));

  const rows = PARALLEL_SHADOW_EXPERIMENTS.map((experiment) => {
    const experimentObs = observations.filter((obs) => obs.experimentId === experiment.id);
    const resolved = experimentObs.filter((obs) => obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS");
    const fresh = resolved.filter((obs) => deriveFreshValidStatus(asFilteredEdgeObservation(obs)).freshValid);
    const wins = fresh.filter((obs) => obs.status === "CLOSED_WIN");
    const baseRow = {
      experimentId: experiment.id,
      label: experiment.label,
      total: experimentObs.length,
      open: experimentObs.filter((obs) => obs.status === "OPEN").length,
      resolved: resolved.length,
      freshValid: fresh.length,
      netAvgR: avg(fresh.map((obs) => obs.netR)),
      pf: pf(fresh.map((obs) => obs.netR)),
      wr: fresh.length > 0 ? wins.length / fresh.length : null,
      avgCostR: avg(fresh.map((obs) => obs.costR)),
      calendarDays: calendarDays(fresh),
      topSymbolShare: topSymbolShare(fresh),
    };
    return {
      ...baseRow,
      ...deriveStatus(baseRow, baselineNetAvgR),
    };
  });

  return {
    reportOnly: true,
    laneVersion: PARALLEL_SHADOW_EXPERIMENT_LANE,
    computedAt: new Date().toISOString(),
    experimentCount: PARALLEL_SHADOW_EXPERIMENTS.length,
    rows,
    baselineExperimentId: "BASE_BROAD_COST20_STOP150",
    latestAdmissionDiagnostics: store.latestAdmissionDiagnostics,
  };
}

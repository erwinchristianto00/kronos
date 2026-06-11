import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Candle, ExecutionEntryVariant, ShadowPositionVariant } from "@dtc/shared";

import type { BinanceClient } from "./binance.js";
import type { ExternalDiscoveryEvidenceEra } from "./external-candidate-discovery-intelligence.js";
import type {
  ExternalStrategyFitCandidateAssessment,
  ExternalStrategyFitEnrichmentReport,
  ExternalStrategyFitTier,
} from "./external-strategy-fit-enrichment.js";
import {
  assessExternalOverlayCandidateOperativePriority,
  type AdaptiveProfitPolicySynthesisReport,
  type OperativeAntiBiasRole,
  type OperativeCollectionPriority,
} from "./adaptive-profit-policy.js";
import type { CrossIntelligenceSupport } from "./lane-toxic-symbol-evaluator.js";

export type ExternalRotationOverlayGroup =
  | "STRATEGY_FIT_SHORTLIST"
  | "METADATA_DISCOVERY_BASELINE"
  | "LOW_FIT_CONTROL";

export type ExternalRotationOverlayStatus = "OPEN" | "RESOLVED" | "NO_FILL" | "EXPIRED" | "FAILED";
export type ExternalRotationOverlayWinnerLabel = "WIN" | "LOSS" | "BREAKEVEN";
export type ExternalRotationOverlayCloseReason = "TP1_FULL" | "TP2" | "TP3" | "SL" | "BREAKEVEN" | "TIME_EXPIRED" | "NO_FILL" | "FAILED";

export interface ExternalRotationOverlayDetachedCandidateSnapshot {
  direction: "LONG" | "SHORT" | "UNKNOWN";
  hypotheticalEntryVariant: ExecutionEntryVariant | string | null;
  hypotheticalExitVariant: ShadowPositionVariant | string | null;
  hypotheticalExpectedNetR: number | null;
  setupPlaybookLabel: string | null;
  stopDistanceBps: number | null;
  riskReward: number | null;
  marketRegime: string | null;
  plannedEntryPrice: number | null;
  /**
   * Variant-specific anchor entry (e.g., fib_500_retracement for fib_500_entry).
   * For V2 anchor-consistent observations this equals plannedEntryPrice and is
   * the basis under which costR / stopDistanceBps were computed. Undefined on
   * legacy V1 observations.
   */
  selectedEntryAnchorPrice?: number | null;
  /**
   * Marks whether plannedEntryPrice / resolverState.entryPrice are anchor-based
   * (VARIANT_ANCHOR, V2) or fell back to currentPrice (LEGACY_CURRENT_PRICE,
   * either V1 contaminated or V2 with unresolvable anchor). Undefined on legacy
   * V1 observations from before the patch.
   */
  entryBasis?: ExternalRotationOverlayEntryBasis;
  entryZone: [number, number] | null;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  costR: number | null;
  notes: string[];
}

export interface ExternalRotationOverlayOutcome {
  realizedGrossR: number | null;
  realizedNetR: number | null;
  winnerLabel: ExternalRotationOverlayWinnerLabel | null;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  closeReason: ExternalRotationOverlayCloseReason;
  openedAt: string | null;
  closedAt: string | null;
  durationMinutes: number | null;
  fillStatus: "FILLED" | "NO_FILL" | "FAILED";
}

export interface ExternalRotationOverlayObservation {
  observationId: string;
  createdAt: string;
  updatedAt: string;
  symbol: string;
  overlayGroups: ExternalRotationOverlayGroup[];
  evidenceEra: ExternalDiscoveryEvidenceEra;
  selectionBatchId: string;
  sourceDiscoveryScore: number;
  sourceStrategyFitScore: number | null;
  sourceStrategyFitTier: ExternalStrategyFitTier | null;
  operativeCollectionPriority?: OperativeCollectionPriority;
  matchedPolicyId?: string | null;
  matchedPolicyLabel?: string | null;
  antiBiasRole?: OperativeAntiBiasRole;
  collectionPriorityReason?: string | null;
  collectionPriorityScore?: number | null;
  // Lane toxicity suppression audit fields (Phase 2 Cross-Intelligence)
  excludedByLaneToxicity?: boolean;
  toxicLaneMatchPolicyId?: string | null;
  exclusionReason?: string | null;
  toxicityCrossIntelligenceSupports?: CrossIntelligenceSupport[];
  discoveryRank: number | null;
  strategyFitRank: number | null;
  lowFitRank: number | null;
  duplicateKey: string;
  detachedCandidateSnapshot: ExternalRotationOverlayDetachedCandidateSnapshot;
  observationStatus: ExternalRotationOverlayStatus;
  outcome?: ExternalRotationOverlayOutcome;
  resolverState?: {
    lastEvaluatedAt: string;
    openedAt: string | null;
    entryPrice: number | null;
    remainingSizePct: number;
    realizedGrossR: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    slMovedToBreakeven: boolean;
    stopPrice: number | null;
    currentPrice: number | null;
  };
  diagnostics: {
    createdByPolicyVersion: string;
    reasonCodes: string[];
    resolutionSemantics: string;
    resolutionErrorCount?: number;
    lastResolutionError?: string | null;
    lastResolutionErrorAt?: string | null;
  };
}

export interface ExternalRotationOverlayRefreshDiagnostics {
  generatedAt: string;
  triggerSource: "AUTO" | "MANUAL";
  selectionBatchId: string;
  observationsConsidered: number;
  observationsCreated: number;
  observationsSuppressedAsDuplicate: number;
  observationsSkippedForInsufficientState: number;
  rejectedForEconomicDistortionCount: number;
  observationsResolvedThisRefresh: number;
  observationsFailedResolution: number;
  strategyFitSelected: number;
  metadataBaselineSelected: number;
  lowFitControlSelected: number;
  notes: string[];
}

export interface ExternalRotationOverlayRefreshResult {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  diagnostics: ExternalRotationOverlayRefreshDiagnostics;
  observations: ExternalRotationOverlayObservation[];
}

export interface ExternalRotationOverlayStoreState {
  observations: ExternalRotationOverlayObservation[];
  latestRefreshDiagnostics?: ExternalRotationOverlayRefreshDiagnostics | null;
}

export interface ExternalRotationOverlayStore {
  readState(): ExternalRotationOverlayStoreState;
  writeState(state: ExternalRotationOverlayStoreState): void;
  readAll(): ExternalRotationOverlayObservation[];
  writeAll(observations: ExternalRotationOverlayObservation[]): void;
}

const DEFAULT_DATA_DIR = "data";
const STORE_FILE = "external-rotation-overlay-observations.json";
/**
 * Policy versions for the External Rotation Shadow Overlay.
 *
 * - V1 had a unit-mismatch bug: costR/stopDistanceBps were computed against the
 *   variant anchor (e.g., fib_500_retracement), but the resolver filled at
 *   candidate.currentPrice. realizedGrossR (currentPrice-risk units) was
 *   subtracted with costR (anchor-risk units), producing fabricated cost drag.
 * - V2 fixes this by setting plannedEntryPrice to the variant anchor (matching
 *   the basis under which costR and stopDistanceBps were computed) and labels
 *   the snapshot's entryBasis as VARIANT_ANCHOR. V1 observations are preserved
 *   for audit trail but excluded from operative interpretation.
 */
export const EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT =
  "external-rotation-overlay-anchor-consistent-v2";
export const LEGACY_EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V1_FILL_MISMATCH =
  "external-rotation-overlay-v1";
const POLICY_VERSION = EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT;
const DUPLICATE_SUPPRESSION_MS = 12 * 60 * 60 * 1000;
const OBSERVATION_MAX_MS = 24 * 60 * 60 * 1000;
const MIN_OBSERVATION_STOP_BPS = 10;
const MAX_OBSERVATION_COST_R = 2.0;

export type ExternalRotationOverlayDataValidityStatus =
  | "VALID"
  | "LEGACY_ENTRY_ANCHOR_FILL_MISMATCH";

export type ExternalRotationOverlayEntryBasis = "VARIANT_ANCHOR" | "LEGACY_CURRENT_PRICE";

/**
 * Returns the policy validity status for an observation. V2 anchor-consistent
 * observations are VALID; everything else (legacy v1, unversioned, or v2
 * observations that fell back to LEGACY_CURRENT_PRICE because anchor resolution
 * failed) is LEGACY_ENTRY_ANCHOR_FILL_MISMATCH.
 */
export function classifyExternalRotationOverlayValidity(
  obs: ExternalRotationOverlayObservation,
): ExternalRotationOverlayDataValidityStatus {
  const policy = obs.diagnostics?.createdByPolicyVersion ?? "";
  if (policy !== EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT) {
    return "LEGACY_ENTRY_ANCHOR_FILL_MISMATCH";
  }
  const basis = obs.detachedCandidateSnapshot?.entryBasis;
  if (basis !== "VARIANT_ANCHOR") {
    return "LEGACY_ENTRY_ANCHOR_FILL_MISMATCH";
  }
  return "VALID";
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class JsonExternalRotationOverlayStore implements ExternalRotationOverlayStore {
  private readonly file: string;

  constructor(dataDir = DEFAULT_DATA_DIR) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = resolve(dataDir, STORE_FILE);
  }

  readState(): ExternalRotationOverlayStoreState {
    if (!existsSync(this.file)) return { observations: [], latestRefreshDiagnostics: null };
    const raw = readFileSync(this.file, "utf-8").trim();
    if (!raw) return { observations: [], latestRefreshDiagnostics: null };
    const parsed = JSON.parse(raw) as ExternalRotationOverlayObservation[] | ExternalRotationOverlayStoreState;
    if (Array.isArray(parsed)) {
      return { observations: parsed, latestRefreshDiagnostics: null };
    }
    return {
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      latestRefreshDiagnostics: parsed.latestRefreshDiagnostics ?? null,
    };
  }

  writeState(state: ExternalRotationOverlayStoreState): void {
    writeFileSync(this.file, JSON.stringify(state, null, 2), "utf-8");
  }

  readAll(): ExternalRotationOverlayObservation[] {
    return this.readState().observations;
  }

  writeAll(observations: ExternalRotationOverlayObservation[]): void {
    const state = this.readState();
    this.writeState({
      observations,
      latestRefreshDiagnostics: state.latestRefreshDiagnostics ?? null,
    });
  }
}

function directionFromAssessment(candidate: ExternalStrategyFitCandidateAssessment): "LONG" | "SHORT" | "UNKNOWN" {
  if (candidate.directionalContext === "LONG_FAVORED") return "LONG";
  if (candidate.directionalContext === "SHORT_FAVORED") return "SHORT";
  return "UNKNOWN";
}

function routeKey(candidate: ExternalStrategyFitCandidateAssessment): string {
  const route = candidate.bestObservedExternalRouteHypothesis;
  return `${route.selectedEntryVariant ?? "unknown_entry"}:${route.selectedExitVariant ?? "unknown_exit"}`;
}

function duplicateKey(symbol: string, direction: string, route: string, groups: ExternalRotationOverlayGroup[]): string {
  // Policy version is part of the key so that legacy V1 observations do NOT
  // suppress creation of fresh V2 anchor-consistent observations for the same
  // symbol/direction/route/groups. The overlay can restart cleanly without
  // manual store deletion.
  return `${symbol}:${direction}:${route}:${[...groups].sort().join("+")}::${POLICY_VERSION}`;
}

function rankBySymbol(items: ExternalStrategyFitCandidateAssessment[]): Map<string, number> {
  return new Map(items.map((item, index) => [item.symbol, index + 1] as const));
}

function isUsableForObservation(candidate: ExternalStrategyFitCandidateAssessment): boolean {
  const route = candidate.bestObservedExternalRouteHypothesis;
  return (
    (candidate.technicalDataStatus === "HEALTHY" || candidate.technicalDataStatus === "PARTIAL") &&
    directionFromAssessment(candidate) !== "UNKNOWN" &&
    route.selectedEntryVariant !== null &&
    route.selectedExitVariant !== null &&
    route.stopDistanceBps !== null
  );
}

type ExternalRotationOverlayAdmissionDistortionReason =
  | "STOP_DISTANCE_BELOW_ABSURD_FLOOR"
  | "PREDICTED_COST_R_TOO_HIGH";

function economicDistortionAdmissionReason(
  candidate: ExternalStrategyFitCandidateAssessment,
): ExternalRotationOverlayAdmissionDistortionReason | null {
  const route = candidate.bestObservedExternalRouteHypothesis;
  const stopDistanceBps = route.stopDistanceBps;
  if (typeof stopDistanceBps === "number" && Number.isFinite(stopDistanceBps) && stopDistanceBps < MIN_OBSERVATION_STOP_BPS) {
    return "STOP_DISTANCE_BELOW_ABSURD_FLOOR";
  }
  const costR = route.costR;
  if (typeof costR === "number" && Number.isFinite(costR) && costR >= MAX_OBSERVATION_COST_R) {
    return "PREDICTED_COST_R_TOO_HIGH";
  }
  return null;
}

function plannedEntryPrice(candidate: ExternalStrategyFitCandidateAssessment): number | null {
  const direct = candidate.bestObservedExternalRouteHypothesis.plannedEntryPrice;
  if (direct !== null && direct !== undefined && Number.isFinite(direct)) return direct;
  const direction = directionFromAssessment(candidate);
  const directStop = candidate.bestObservedExternalRouteHypothesis.stopPrice;
  const stopBpsForDerive = candidate.bestObservedExternalRouteHypothesis.stopDistanceBps;
  if (direction !== "UNKNOWN" && directStop !== null && directStop !== undefined && stopBpsForDerive !== null && stopBpsForDerive > 0) {
    const riskPct = stopBpsForDerive / 10000;
    const derived = direction === "LONG" ? directStop / (1 - riskPct) : directStop / (1 + riskPct);
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  const stop = candidate.bestObservedExternalRouteHypothesis.stopDistanceBps;
  const rr = candidate.bestObservedExternalRouteHypothesis.riskReward;
  if (stop === null || rr === null) return null;
  const reasons = candidate.reasons.join(" ");
  const match = reasons.match(/current price ([0-9.]+)/i);
  return match ? Number(match[1]) : null;
}

function derivePlanPrices(candidate: ExternalStrategyFitCandidateAssessment) {
  const direction = directionFromAssessment(candidate);
  const entry = plannedEntryPrice(candidate);
  const stopBps = candidate.bestObservedExternalRouteHypothesis.stopDistanceBps;
  const rr = candidate.bestObservedExternalRouteHypothesis.riskReward;
  const directStop = candidate.bestObservedExternalRouteHypothesis.stopPrice;
  const directTp1 = candidate.bestObservedExternalRouteHypothesis.tp1Price;
  const directTp2 = candidate.bestObservedExternalRouteHypothesis.tp2Price;
  const directTp3 = candidate.bestObservedExternalRouteHypothesis.tp3Price;
  if (direction !== "UNKNOWN" && entry !== null && directStop !== null && directStop !== undefined && directTp1 !== null && directTp1 !== undefined) {
    return {
      entry: roundMetric(entry),
      stop: roundMetric(directStop),
      tp1: roundMetric(directTp1),
      tp2: roundMetric(directTp2),
      tp3: roundMetric(directTp3),
    };
  }
  if (direction === "UNKNOWN" || entry === null || stopBps === null || stopBps <= 0 || rr === null) {
    return { entry, stop: null, tp1: null, tp2: null, tp3: null };
  }
  const risk = entry * (stopBps / 10000);
  const stop = direction === "LONG" ? entry - risk : entry + risk;
  const tp1Distance = risk * Math.max(1, Math.min(rr, 1.6));
  const tp2Distance = risk * Math.max(1.5, Math.min(rr, 2.4));
  const tp3Distance = risk * Math.max(2, Math.min(rr, 3));
  return {
    entry: roundMetric(entry),
    stop: roundMetric(stop),
    tp1: roundMetric(direction === "LONG" ? entry + tp1Distance : entry - tp1Distance),
    tp2: roundMetric(direction === "LONG" ? entry + tp2Distance : entry - tp2Distance),
    tp3: roundMetric(direction === "LONG" ? entry + tp3Distance : entry - tp3Distance),
  };
}

function buildObservation(
  candidate: ExternalStrategyFitCandidateAssessment,
  groups: ExternalRotationOverlayGroup[],
  ranks: {
    discoveryRank: number | null;
    strategyFitRank: number | null;
    lowFitRank: number | null;
  },
  enrichment: ExternalStrategyFitEnrichmentReport,
  operativePriority: ReturnType<typeof assessExternalOverlayCandidateOperativePriority>,
  selectionBatchId: string,
  nowIso: string,
): ExternalRotationOverlayObservation | null {
  if (!isUsableForObservation(candidate)) return null;
  const direction = directionFromAssessment(candidate);
  const route = candidate.bestObservedExternalRouteHypothesis;
  const prices = derivePlanPrices(candidate);
  if (prices.entry === null || prices.stop === null || prices.tp1 === null) return null;
  const groupsSorted = [...new Set(groups)].sort() as ExternalRotationOverlayGroup[];
  const key = duplicateKey(candidate.symbol, direction, routeKey(candidate), groupsSorted);
  const reasonCodes = groupsSorted.map((group) => `SELECTED_${group}`);
  return {
    observationId: randomUUID(),
    createdAt: nowIso,
    updatedAt: nowIso,
    symbol: candidate.symbol,
    overlayGroups: groupsSorted,
    evidenceEra: enrichment.evidenceEra,
    selectionBatchId,
    sourceDiscoveryScore: candidate.discoveryScore,
    sourceStrategyFitScore: candidate.strategyFitScore,
    sourceStrategyFitTier: candidate.strategyFitTier,
    operativeCollectionPriority: operativePriority.operativeCollectionPriority,
    matchedPolicyId: operativePriority.matchedPolicyId,
    matchedPolicyLabel: operativePriority.matchedPolicyLabel,
    antiBiasRole: operativePriority.antiBiasRole,
    collectionPriorityReason: operativePriority.collectionPriorityReason,
    collectionPriorityScore: operativePriority.collectionPriorityScore,
    discoveryRank: ranks.discoveryRank,
    strategyFitRank: ranks.strategyFitRank,
    lowFitRank: ranks.lowFitRank,
    duplicateKey: key,
    detachedCandidateSnapshot: {
      direction,
      hypotheticalEntryVariant: route.selectedEntryVariant,
      hypotheticalExitVariant: route.selectedExitVariant,
      hypotheticalExpectedNetR: route.expectedNetR,
      setupPlaybookLabel: candidate.setupQuality,
      stopDistanceBps: route.stopDistanceBps,
      riskReward: route.riskReward,
      marketRegime: enrichment.globalMarketContext.inferredExternalShortlistRegime,
      plannedEntryPrice: prices.entry,
      // Anchor-consistent entry basis: plannedEntryPrice / resolverState.entryPrice
      // are now set to the variant anchor (e.g., fib_500_retracement). This
      // matches the basis under which the upstream costDiagnostics computed
      // costR and stopDistanceBps, so realizedGrossR, costR, and the net R
      // deduction now all share the same risk denominator.
      selectedEntryAnchorPrice: route.selectedEntryAnchorPrice ?? null,
      entryBasis:
        route.selectedEntryAnchorPrice !== null &&
        route.selectedEntryAnchorPrice !== undefined &&
        prices.entry === roundMetric(route.selectedEntryAnchorPrice)
          ? "VARIANT_ANCHOR"
          : "LEGACY_CURRENT_PRICE",
      entryZone: candidate.bestObservedExternalRouteHypothesis.entryZone ?? null,
      stopPrice: prices.stop,
      tp1Price: prices.tp1,
      tp2Price: prices.tp2,
      tp3Price: prices.tp3,
      costR: candidate.bestObservedExternalRouteHypothesis.costR ?? null,
      notes: candidate.reasons.slice(0, 4),
    },
    observationStatus: "OPEN",
    resolverState: {
      lastEvaluatedAt: nowIso,
      openedAt: null,
      entryPrice: prices.entry,
      remainingSizePct: 1,
      realizedGrossR: 0,
      tp1Hit: false,
      tp2Hit: false,
      slMovedToBreakeven: false,
      stopPrice: prices.stop,
      currentPrice: prices.entry,
    },
    diagnostics: {
      createdByPolicyVersion: POLICY_VERSION,
      reasonCodes,
      resolutionSemantics: "Research-only overlay resolver: 5m candle path, pending fill at detached entry, conservative stop-first same-candle handling, 24h expiry. It is isolated from active ShadowPosition execution.",
    },
  };
}

function priorityRank(priority: OperativeCollectionPriority): number {
  switch (priority) {
    case "PRIMARY_PROFIT_LANE": return 4;
    case "SECONDARY_VALIDATION_LANE": return 3;
    case "OBSERVE_ONLY": return 2;
    case "REJECTED_FOR_CURRENT_POLICY": return 1;
  }
}

function buildSelectedObservationInputs(
  enrichment: ExternalStrategyFitEnrichmentReport,
  synthesis?: AdaptiveProfitPolicySynthesisReport | null,
) {
  const strategyFitWithPriority = enrichment.topStrategyFitCandidates
    .map((candidate) => ({
      candidate,
      operativePriority: assessExternalOverlayCandidateOperativePriority(candidate, enrichment, synthesis),
    }))
    .sort((left, right) => {
      const priorityDelta = priorityRank(right.operativePriority.operativeCollectionPriority) - priorityRank(left.operativePriority.operativeCollectionPriority);
      if (priorityDelta !== 0) return priorityDelta;
      const scoreDelta = right.operativePriority.collectionPriorityScore - left.operativePriority.collectionPriorityScore;
      if (scoreDelta !== 0) return scoreDelta;
      return right.candidate.strategyFitScore - left.candidate.strategyFitScore;
    });
  const strategyFit = strategyFitWithPriority.slice(0, 5);
  const dominantBias = synthesis?.currentAdaptiveDirectionBias;
  if (dominantBias === "SHORT_BIAS" || dominantBias === "LONG_BIAS") {
    const oppositeDirectionCandidate = strategyFitWithPriority.find((item) => item.operativePriority.antiBiasRole === "OPPOSITE_DIRECTION_VALIDATION");
    const hasOppositeDirection = strategyFit.some((item) => item.operativePriority.antiBiasRole === "OPPOSITE_DIRECTION_VALIDATION");
    if (oppositeDirectionCandidate && !hasOppositeDirection && strategyFit.length >= 5) {
      strategyFit[strategyFit.length - 1] = oppositeDirectionCandidate;
    }
  }
  const metadata = [...enrichment.candidates]
    .filter((item) => item.strategyFitTier !== "NOT_EVALUABLE")
    .sort((a, b) => b.discoveryScore - a.discoveryScore)
    .slice(0, 5);
  const lowFit = enrichment.lowFitCandidates
    .filter((item) => item.strategyFitTier !== "NOT_EVALUABLE")
    .slice(0, 3);
  const strategyRanks = rankBySymbol(strategyFit.map((item) => item.candidate));
  const metadataRanks = rankBySymbol(metadata);
  const lowRanks = rankBySymbol(lowFit);
  const bySymbol = new Map<string, {
    candidate: ExternalStrategyFitCandidateAssessment;
    groups: Set<ExternalRotationOverlayGroup>;
    operativePriority: ReturnType<typeof assessExternalOverlayCandidateOperativePriority>;
  }>();

  for (const item of strategyFit) {
    const candidate = item.candidate;
    const entry = bySymbol.get(candidate.symbol) ?? { candidate, groups: new Set<ExternalRotationOverlayGroup>(), operativePriority: item.operativePriority };
    entry.groups.add("STRATEGY_FIT_SHORTLIST");
    entry.operativePriority = item.operativePriority;
    bySymbol.set(candidate.symbol, entry);
  }
  for (const candidate of metadata) {
    const entry = bySymbol.get(candidate.symbol) ?? {
      candidate,
      groups: new Set<ExternalRotationOverlayGroup>(),
      operativePriority: assessExternalOverlayCandidateOperativePriority(candidate, enrichment, synthesis),
    };
    entry.groups.add("METADATA_DISCOVERY_BASELINE");
    bySymbol.set(candidate.symbol, entry);
  }
  for (const candidate of lowFit) {
    const entry = bySymbol.get(candidate.symbol) ?? {
      candidate,
      groups: new Set<ExternalRotationOverlayGroup>(),
      operativePriority: assessExternalOverlayCandidateOperativePriority(candidate, enrichment, synthesis),
    };
    entry.groups.add("LOW_FIT_CONTROL");
    bySymbol.set(candidate.symbol, entry);
  }

  return [...bySymbol.values()].map((entry) => ({
    candidate: entry.candidate,
    groups: [...entry.groups] as ExternalRotationOverlayGroup[],
    ranks: {
      discoveryRank: metadataRanks.get(entry.candidate.symbol) ?? null,
      strategyFitRank: strategyRanks.get(entry.candidate.symbol) ?? null,
      lowFitRank: lowRanks.get(entry.candidate.symbol) ?? null,
    },
    operativePriority: entry.operativePriority,
  }));
}

function candleTouchesLevel(candle: Candle, level: number): boolean {
  return candle.low <= level && candle.high >= level;
}

function rAtPrice(direction: "LONG" | "SHORT", entry: number, stop: number | null, price: number): number {
  if (stop === null) return 0;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  return direction === "LONG" ? (price - entry) / risk : (entry - price) / risk;
}

function closeObservation(
  observation: ExternalRotationOverlayObservation,
  time: string,
  price: number,
  reason: ExternalRotationOverlayCloseReason,
) {
  const state = observation.resolverState;
  const snap = observation.detachedCandidateSnapshot;
  if (!state || snap.direction !== "LONG" && snap.direction !== "SHORT" || state.entryPrice === null) return;
  if (state.remainingSizePct > 0) {
    state.realizedGrossR += rAtPrice(snap.direction, state.entryPrice, state.stopPrice, price) * state.remainingSizePct;
    state.remainingSizePct = 0;
  }
  const gross = roundMetric(state.realizedGrossR) ?? 0;
  const net = roundMetric(gross - (snap.costR ?? 0)) ?? gross;
  observation.observationStatus = reason === "NO_FILL" ? "NO_FILL" : reason === "TIME_EXPIRED" ? "EXPIRED" : "RESOLVED";
  observation.updatedAt = time;
  observation.outcome = {
    realizedGrossR: gross,
    realizedNetR: net,
    winnerLabel: net > 0.05 ? "WIN" : net < -0.05 ? "LOSS" : "BREAKEVEN",
    tp1Hit: state.tp1Hit,
    tp2Hit: state.tp2Hit,
    slHit: reason === "SL",
    closeReason: reason,
    openedAt: state.openedAt,
    closedAt: time,
    durationMinutes: state.openedAt ? Math.round((new Date(time).getTime() - new Date(state.openedAt).getTime()) / 60000) : null,
    fillStatus: reason === "NO_FILL" ? "NO_FILL" : "FILLED",
  };
}

function updateObservationWithCandle(observation: ExternalRotationOverlayObservation, candle: Candle): void {
  if (observation.observationStatus !== "OPEN") return;
  const state = observation.resolverState;
  const snap = observation.detachedCandidateSnapshot;
  if (!state || snap.direction !== "LONG" && snap.direction !== "SHORT" || state.entryPrice === null) return;
  const time = new Date(candle.openTime).toISOString();
  state.lastEvaluatedAt = time;
  state.currentPrice = candle.close;
  if (!state.openedAt) {
    if (!candleTouchesLevel(candle, state.entryPrice)) return;
    state.openedAt = time;
    observation.updatedAt = time;
    return;
  }

  const hitStop = state.stopPrice !== null && (snap.direction === "LONG" ? candle.low <= state.stopPrice : candle.high >= state.stopPrice);
  const hitTp1 = !state.tp1Hit && snap.tp1Price !== null && (snap.direction === "LONG" ? candle.high >= snap.tp1Price : candle.low <= snap.tp1Price);
  if (hitStop) {
    closeObservation(observation, time, state.stopPrice!, state.slMovedToBreakeven ? "BREAKEVEN" : "SL");
    return;
  }
  if (hitTp1) {
    state.tp1Hit = true;
    const tp1Size = snap.hypotheticalExitVariant === "tp1_full_exit" ? 1 : snap.hypotheticalExitVariant === "tp1_70_runner30" ? 0.7 : 0.5;
    state.realizedGrossR += rAtPrice(snap.direction, state.entryPrice, state.stopPrice, snap.tp1Price!) * tp1Size;
    state.remainingSizePct = Math.max(0, state.remainingSizePct - tp1Size);
    if (state.remainingSizePct <= 0) {
      closeObservation(observation, time, snap.tp1Price!, "TP1_FULL");
      return;
    }
    state.stopPrice = state.entryPrice;
    state.slMovedToBreakeven = true;
  }
  const hitTp2 = state.tp1Hit && !state.tp2Hit && snap.tp2Price !== null && (snap.direction === "LONG" ? candle.high >= snap.tp2Price : candle.low <= snap.tp2Price);
  if (hitTp2 && (snap.hypotheticalExitVariant === "tp1_50_tp2_runner" || snap.hypotheticalExitVariant === "tp1_70_runner30")) {
    state.tp2Hit = true;
    closeObservation(observation, time, snap.tp2Price!, "TP2");
    return;
  }
  const hitTp3 = state.tp1Hit && snap.tp3Price !== null && (snap.direction === "LONG" ? candle.high >= snap.tp3Price : candle.low <= snap.tp3Price);
  if (hitTp3) {
    closeObservation(observation, time, snap.tp3Price!, "TP3");
  }
}

async function resolveOpenObservations(
  observations: ExternalRotationOverlayObservation[],
  binanceClient: BinanceClient,
  now: Date,
): Promise<{ resolved: number; failed: number }> {
  let resolved = 0;
  let failed = 0;
  const nowMs = now.getTime();
  for (const observation of observations) {
    if (observation.observationStatus !== "OPEN" && observation.observationStatus !== "FAILED") continue;
    if (observation.observationStatus === "FAILED") {
      observation.observationStatus = "OPEN";
      observation.outcome = undefined;
    }
    const before = observation.observationStatus;
    const lastEvaluatedAt = observation.resolverState?.lastEvaluatedAt ?? observation.createdAt;
    const startMs = new Date(lastEvaluatedAt).getTime();
    try {
      const candles = await binanceClient.getCandles(observation.symbol, "5m", Math.min(Math.max(Math.ceil((nowMs - startMs) / 300000) + 2, 12), 500), {
        startTime: startMs,
        endTime: nowMs,
      });
      for (const candle of candles.filter((item) => item.openTime > startMs && item.openTime <= nowMs)) {
        updateObservationWithCandle(observation, candle);
        if (observation.observationStatus !== "OPEN") break;
      }
      if (observation.observationStatus === "OPEN" && nowMs - new Date(observation.createdAt).getTime() >= OBSERVATION_MAX_MS) {
        const state = observation.resolverState;
        if (state?.openedAt) {
          closeObservation(observation, now.toISOString(), state.currentPrice ?? state.entryPrice ?? observation.detachedCandidateSnapshot.plannedEntryPrice ?? 0, "TIME_EXPIRED");
        } else {
          observation.observationStatus = "NO_FILL";
          observation.updatedAt = now.toISOString();
          observation.outcome = {
            realizedGrossR: null,
            realizedNetR: null,
            winnerLabel: null,
            tp1Hit: false,
            tp2Hit: false,
            slHit: false,
            closeReason: "NO_FILL",
            openedAt: null,
            closedAt: now.toISOString(),
            durationMinutes: null,
            fillStatus: "NO_FILL",
          };
        }
      }
      if (before === "OPEN" && observation.observationStatus !== "OPEN") resolved += 1;
      observation.diagnostics.lastResolutionError = null;
      observation.diagnostics.lastResolutionErrorAt = null;
    } catch (error) {
      observation.observationStatus = "OPEN";
      observation.updatedAt = now.toISOString();
      observation.diagnostics.resolutionErrorCount = (observation.diagnostics.resolutionErrorCount ?? 0) + 1;
      observation.diagnostics.lastResolutionError =
        error instanceof Error ? error.message : "Unknown resolution error";
      observation.diagnostics.lastResolutionErrorAt = now.toISOString();
      failed += 1;
    }
  }
  return { resolved, failed };
}

export async function refreshExternalRotationOverlayObservations(opts: {
  store: ExternalRotationOverlayStore;
  enrichmentReport: ExternalStrategyFitEnrichmentReport;
  binanceClient: BinanceClient;
  adaptiveProfitPolicySynthesis?: AdaptiveProfitPolicySynthesisReport | null;
  triggerSource?: "AUTO" | "MANUAL";
  now?: Date;
}): Promise<ExternalRotationOverlayRefreshResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const selectionBatchId = `external-rotation-overlay-${nowIso}`;
  const triggerSource = opts.triggerSource ?? "MANUAL";
  const state = opts.store.readState();
  const observations = state.observations;
  const resolution = await resolveOpenObservations(observations, opts.binanceClient, now);
  const selected = buildSelectedObservationInputs(opts.enrichmentReport, opts.adaptiveProfitPolicySynthesis);
  let created = 0;
  let suppressed = 0;
  let skipped = 0;
  let rejectedForEconomicDistortion = 0;

  // Build a lane-specific toxicity lookup from the synthesis report.
  // Maps "policyId" → Set of suppressed symbols (only for EX_TOXIC sibling candidates).
  // Suppression is LANE-SPECIFIC: same symbol in a different lane tuple is unaffected.
  interface ToxicLaneEntry {
    policyId: string;
    regime: string | null;
    direction: string;
    route: string | null;
    exitPolicy: string | null;
    tier1Symbols: Set<string>;
    crossIntelligenceSupports: CrossIntelligenceSupport[];
  }
  const toxicLaneEntries: ToxicLaneEntry[] = [];
  if (opts.adaptiveProfitPolicySynthesis) {
    for (const candidate of opts.adaptiveProfitPolicySynthesis.candidates) {
      if (
        candidate.symbolScope === "ALL_SYMBOLS_EX_TOXIC" &&
        candidate.excludedSymbols &&
        candidate.excludedSymbols.length > 0 &&
        candidate.toxicSymbolExclusionReason
      ) {
        // Find the parent policyId (strip _EX_TOXIC suffix)
        const parentPolicyId = candidate.policyId.replace(/_EX_TOXIC$/, "");
        toxicLaneEntries.push({
          policyId: parentPolicyId,
          regime: candidate.dominantRegime,
          direction: candidate.direction,
          route: candidate.route,
          exitPolicy: candidate.exitPolicy,
          tier1Symbols: new Set(candidate.excludedSymbols),
          // Derive cross-intelligence supports from symbol diagnostics (not available here),
          // so report SYMBOL_SENSITIVE_ROUTE if applicable
          crossIntelligenceSupports: ["SYMBOL_SENSITIVE_ROUTE"],
        });
      }
    }
  }

  function findToxicLaneSuppression(
    symbol: string,
    direction: string,
    regime: string | null,
    route: string | null,
    exitPolicy: string | null,
  ): ToxicLaneEntry | null {
    for (const entry of toxicLaneEntries) {
      if (
        entry.direction === direction &&
        entry.regime === regime &&
        entry.route === route &&
        entry.exitPolicy === exitPolicy &&
        entry.tier1Symbols.has(symbol)
      ) {
        return entry;
      }
    }
    return null;
  }

  let suppressedByToxicity = 0;
  const admissionDistortionReasonCounts: Partial<Record<ExternalRotationOverlayAdmissionDistortionReason, number>> = {};

  for (const item of selected) {
    const distortionReason = economicDistortionAdmissionReason(item.candidate);
    if (distortionReason) {
      rejectedForEconomicDistortion += 1;
      admissionDistortionReasonCounts[distortionReason] = (admissionDistortionReasonCounts[distortionReason] ?? 0) + 1;
      continue;
    }
    const draft = buildObservation(
      item.candidate,
      item.groups,
      item.ranks,
      opts.enrichmentReport,
      item.operativePriority,
      selectionBatchId,
      nowIso,
    );
    if (!draft) {
      skipped += 1;
      continue;
    }

    // Lane toxicity suppression check (Phase 2 Cross-Intelligence Influence Patch)
    // Suppression is LANE-SPECIFIC: same symbol in different (regime, direction, route, exit) is unaffected.
    const snap = draft.detachedCandidateSnapshot;
    const toxicEntry = findToxicLaneSuppression(
      draft.symbol,
      snap.direction,
      snap.marketRegime ?? null,
      snap.hypotheticalEntryVariant ?? null,
      snap.hypotheticalExitVariant ?? null,
    );
    if (toxicEntry) {
      // Persist audit metadata on the observation but do NOT add to active observations
      draft.excludedByLaneToxicity = true;
      draft.toxicLaneMatchPolicyId = toxicEntry.policyId;
      draft.exclusionReason = "LANE_SL_RATE_100PCT_AT_N_GTE_3_WITH_PHASE2_CROSS_SUPPORT";
      draft.toxicityCrossIntelligenceSupports = toxicEntry.crossIntelligenceSupports;
      // Observation is excluded from admission — not pushed to observations array.
      // Suppression is operative for shadow collection only; no live trading effect.
      suppressedByToxicity += 1;
      skipped += 1;
      continue;
    }

    const duplicate = observations.some((existing) =>
      existing.duplicateKey === draft.duplicateKey &&
      now.getTime() - new Date(existing.createdAt).getTime() <= DUPLICATE_SUPPRESSION_MS,
    );
    if (duplicate) {
      suppressed += 1;
      continue;
    }
    observations.push(draft);
    created += 1;
  }

  const diagnostics: ExternalRotationOverlayRefreshDiagnostics = {
    generatedAt: nowIso,
    triggerSource,
    selectionBatchId,
    observationsConsidered: selected.length,
    observationsCreated: created,
    observationsSuppressedAsDuplicate: suppressed,
    observationsSkippedForInsufficientState: skipped,
    rejectedForEconomicDistortionCount: rejectedForEconomicDistortion,
    observationsResolvedThisRefresh: resolution.resolved,
    observationsFailedResolution: resolution.failed,
    strategyFitSelected: selected.filter((item) => item.groups.includes("STRATEGY_FIT_SHORTLIST")).length,
    metadataBaselineSelected: selected.filter((item) => item.groups.includes("METADATA_DISCOVERY_BASELINE")).length,
    lowFitControlSelected: selected.filter((item) => item.groups.includes("LOW_FIT_CONTROL")).length,
    notes: [
      "Refresh is data-collection-only and writes only the isolated external rotation overlay store.",
      "No active scanner universe, route selection, live readiness, or normal shadow position data is modified.",
      ...(suppressedByToxicity > 0
        ? [`Lane-toxicity suppression (OPERATIVE_SHADOW_INFLUENCE): ${suppressedByToxicity} candidate(s) excluded from admission by tier-1 toxic lane match. Suppression is lane-specific only.`]
        : []),
      ...(rejectedForEconomicDistortion > 0
        ? [`Admission economic-distortion guard rejected ${rejectedForEconomicDistortion} candidate(s): ${Object.entries(admissionDistortionReasonCounts).map(([reason, count]) => `${reason}=${count}`).join(", ")}.`]
        : []),
    ],
  };
  opts.store.writeState({
    observations,
    latestRefreshDiagnostics: diagnostics,
  });
  return {
    generatedAt: nowIso,
    evidenceEra: opts.enrichmentReport.evidenceEra,
    diagnostics,
    observations,
  };
}

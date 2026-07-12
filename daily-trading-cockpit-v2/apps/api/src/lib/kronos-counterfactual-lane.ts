/**
 * KRONOS COUNTERFACTUAL SHADOW LANE (REPORT-ONLY)
 *
 * Collects prospective shadow observations for candidates that are filtered or
 * downgraded by Kronos-related logic, so a future audit can measure whether
 * Kronos is genuinely adding edge.
 *
 * Two lanes:
 *   - KRONOS_DISAGREEMENT_COUNTERFACTUAL: candidate is otherwise materially
 *     interesting (opportunityScore high enough) but Kronos actively disagrees
 *     with the trade direction (kronos.kronosBias is opposite to finalDirection).
 *   - LIVE_SOURCE_CONFLICT_COUNTERFACTUAL: candidate.sourceConflict === true
 *     (exact live scanner Kronos-vs-Whale direct opposition) AND the candidate
 *     is otherwise materially interesting.
 *
 * Does NOT change:
 *   - scanner outputs / TRADE_NOW logic / action statuses
 *   - readiness gates / adaptive policy ranking / dashboard headline policy
 *   - external rotation overlay logic
 *   - route selection / live trading behavior
 *
 * Storage is isolated in apps/api/data/kronos-counterfactual-observations.json.
 * Resolution is via 5m candle walk (modelled after external-rotation-overlay
 * resolver) and is invoked from the shadow refresh path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  Candidate,
  Candle,
  Direction,
  ExecutionEntryVariant,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import type { BinanceClient } from "./binance.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

const KRONOS_COUNTERFACTUAL_MAX_STORED_OBSERVATIONS = envNum(
  "KRONOS_COUNTERFACTUAL_MAX_STORED_OBSERVATIONS",
  500,
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type KronosCounterfactualLane =
  | "KRONOS_DISAGREEMENT_COUNTERFACTUAL"
  | "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL";

export type KronosCounterfactualStatus =
  | "OPEN"
  | "RESOLVED"
  | "NO_FILL"
  | "EXPIRED"
  | "FAILED";

export type KronosCounterfactualCloseReason =
  | "TP1_FULL"
  | "TP2"
  | "TP3"
  | "SL"
  | "BREAKEVEN"
  | "TIME_EXPIRED"
  | "NO_FILL"
  | "FAILED";

export type KronosCounterfactualWinnerLabel = "WIN" | "LOSS" | "BREAKEVEN";

export interface KronosCounterfactualOutcome {
  realizedGrossR: number | null;
  realizedNetR: number | null;
  winnerLabel: KronosCounterfactualWinnerLabel | null;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  closeReason: KronosCounterfactualCloseReason;
  openedAt: string | null;
  closedAt: string | null;
  durationMinutes: number | null;
  fillStatus: "FILLED" | "NO_FILL" | "FAILED";
}

export interface KronosCounterfactualSnapshot {
  direction: "LONG" | "SHORT";
  symbol: string;
  marketRegime: string | null;
  /** From candidate.kronosBias (may be UNAVAILABLE when kronos is offline) */
  kronosBias: Direction | "UNAVAILABLE" | null;
  kronosAgrees: boolean;
  liveSourceConflict: boolean | null;
  horizonConflict: boolean | null;
  whaleSignal: string | null;
  whaleAvailable: boolean | null;
  opportunityScore: number;
  finalStatusObserved: string | null;
  selectedEntryVariant: ExecutionEntryVariant | string | null;
  selectedExitVariant: ShadowPositionVariant | string | null;
  plannedEntryPrice: number | null;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  stopDistanceBps: number | null;
  costR: number | null;
  notes: string[];
}

export interface KronosCounterfactualResolverState {
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
}

export interface KronosCounterfactualObservation {
  observationId: string;
  createdAt: string;
  updatedAt: string;
  lane: KronosCounterfactualLane;
  symbol: string;
  selectionBatchId: string;
  duplicateKey: string;
  snapshot: KronosCounterfactualSnapshot;
  observationStatus: KronosCounterfactualStatus;
  outcome?: KronosCounterfactualOutcome;
  resolverState?: KronosCounterfactualResolverState;
  diagnostics: {
    createdByPolicyVersion: string;
    admissionReasonCodes: string[];
    resolutionSemantics: string;
    resolutionErrorCount?: number;
    lastResolutionError?: string | null;
    lastResolutionErrorAt?: string | null;
  };
}

export interface KronosCounterfactualRefreshDiagnostics {
  generatedAt: string;
  triggerSource: "AUTO" | "MANUAL" | "SCAN_CYCLE";
  selectionBatchId: string;
  candidatesConsidered: number;
  observationsCreated: number;
  observationsSuppressedAsDuplicate: number;
  observationsSkippedForInsufficientState: number;
  observationsResolvedThisRefresh: number;
  observationsFailedResolution: number;
  laneCreatedCounts: Record<KronosCounterfactualLane, number>;
  notes: string[];
}

export interface KronosCounterfactualStoreState {
  observations: KronosCounterfactualObservation[];
  latestRefreshDiagnostics?: KronosCounterfactualRefreshDiagnostics | null;
}

export interface KronosCounterfactualStore {
  readState(): KronosCounterfactualStoreState;
  writeState(state: KronosCounterfactualStoreState): void;
  readAll(): KronosCounterfactualObservation[];
  writeAll(observations: KronosCounterfactualObservation[]): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = "data";
const STORE_FILE = "kronos-counterfactual-observations.json";
export const KRONOS_COUNTERFACTUAL_POLICY_VERSION = "kronos-counterfactual-v1";

/** Minimum opportunity score for a candidate to qualify as "materially interesting". */
const MIN_OPPORTUNITY_SCORE = 60;
/** Duplicate-suppression window: candidate not re-admitted within 12 hours for same lane/key. */
const DUPLICATE_SUPPRESSION_MS = 12 * 60 * 60 * 1000;
/** Observation lifetime (24 hours) — same as external rotation overlay. */
const OBSERVATION_MAX_MS = 24 * 60 * 60 * 1000;
/** Hard floors / ceilings to reject economically degenerate setups. */
const MIN_OBSERVATION_STOP_BPS = 10;
const MAX_OBSERVATION_COST_R = 2.0;

/** Floor: minimum count of resolved observations per lane before publishing economics. */
export const KRONOS_COUNTERFACTUAL_MIN_RESOLVED_FOR_VERDICT = 20;

// Milestone thresholds
export const MILESTONE_RESOLVED_N_TARGET = 60;
export const MILESTONE_CALENDAR_DAYS_TARGET = 5;
const MILESTONE_EX_TOP2_NET_AVG_R_THRESHOLD = -0.10;
const MILESTONE_EX_TOP2_PF_THRESHOLD = 0.30;
const MILESTONE_MIN_RESOLVED_FOR_PROMISING = 20;

// ─── Store ────────────────────────────────────────────────────────────────────

function pruneCounterfactualObservations(
  observations: KronosCounterfactualObservation[],
): KronosCounterfactualObservation[] {
  if (observations.length <= KRONOS_COUNTERFACTUAL_MAX_STORED_OBSERVATIONS) return observations;
  const open = observations.filter((o) => o.observationStatus === "OPEN");
  const settled = observations
    .filter((o) => o.observationStatus !== "OPEN")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, Math.max(0, KRONOS_COUNTERFACTUAL_MAX_STORED_OBSERVATIONS - open.length));
  return [...open, ...settled];
}

export class JsonKronosCounterfactualStore implements KronosCounterfactualStore {
  private readonly file: string;

  constructor(dataDir = DEFAULT_DATA_DIR) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = resolve(dataDir, STORE_FILE);
  }

  readState(): KronosCounterfactualStoreState {
    if (!existsSync(this.file)) return { observations: [], latestRefreshDiagnostics: null };
    const raw = readFileSync(this.file, "utf-8").trim();
    if (!raw) return { observations: [], latestRefreshDiagnostics: null };
    const parsed = JSON.parse(raw) as
      | KronosCounterfactualObservation[]
      | KronosCounterfactualStoreState;
    if (Array.isArray(parsed)) {
      return { observations: parsed, latestRefreshDiagnostics: null };
    }
    return {
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      latestRefreshDiagnostics: parsed.latestRefreshDiagnostics ?? null,
    };
  }

  writeState(state: KronosCounterfactualStoreState): void {
    // Atomic write: was a direct writeFileSync on the main file with no tmp+rename, so a crash
    // mid-write could truncate/corrupt this ~2.4MB store. Matches the pattern used elsewhere
    // (paper-execution-router.ts, current-guard-variant-matrix.ts).
    const tmp = `${this.file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ...state, observations: pruneCounterfactualObservations(state.observations) }),
      "utf-8",
    );
    renameSync(tmp, this.file);
  }

  readAll(): KronosCounterfactualObservation[] {
    return this.readState().observations;
  }

  writeAll(observations: KronosCounterfactualObservation[]): void {
    const state = this.readState();
    this.writeState({
      observations,
      latestRefreshDiagnostics: state.latestRefreshDiagnostics ?? null,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function whaleSignalLabel(candidate: Candidate): string | null {
  if (!candidate.whale.available) return null;
  return candidate.whale.signal ?? null;
}

function computeKronosAgrees(candidate: Candidate): boolean {
  const bias = candidate.kronosBias;
  if (!bias || bias === "UNAVAILABLE") return false;
  return bias === candidate.finalDirection;
}

function duplicateKey(
  symbol: string,
  direction: string,
  lane: KronosCounterfactualLane,
  entryVariant: string | null,
  exitVariant: string | null,
  kronosBias: string | null,
): string {
  return `${symbol}:${direction}:${lane}:${entryVariant ?? "no_entry"}:${exitVariant ?? "no_exit"}:${kronosBias ?? "no_bias"}::${KRONOS_COUNTERFACTUAL_POLICY_VERSION}`;
}

// ─── Admission ────────────────────────────────────────────────────────────────

export interface KronosCounterfactualAdmissionDecision {
  admitted: boolean;
  lane: KronosCounterfactualLane | null;
  reasonCodes: string[];
  rejectionReason?: string;
}

/**
 * Classify whether a candidate qualifies for counterfactual admission, and into
 * which lane. Lane A (disagreement) takes precedence over Lane B (source-conflict)
 * when both apply, so each candidate produces at most one observation per cycle.
 *
 * Pure function — no side effects, no I/O.
 */
export function classifyKronosCounterfactualAdmission(
  candidate: Candidate,
): KronosCounterfactualAdmissionDecision {
  const plan = candidate.selectedExecutionPlan;
  const reasonCodes: string[] = [];

  // Quality gate: candidate must be materially interesting
  if (!isFiniteNumber(candidate.opportunityScore) || candidate.opportunityScore < MIN_OPPORTUNITY_SCORE) {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "OPPORTUNITY_SCORE_BELOW_THRESHOLD" };
  }
  if (candidate.finalDirection !== "LONG" && candidate.finalDirection !== "SHORT") {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "DIRECTION_UNUSABLE" };
  }
  if (!plan || !plan.selectedEntryVariant || !plan.selectedExitVariant) {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "EXECUTION_PLAN_MISSING" };
  }
  // Need at least entry, stop, tp1 to resolve outcomes
  if (
    !isFiniteNumber(candidate.indicators?.fiveMinute?.latestClose) ||
    !isFiniteNumber(candidate.stopLoss) ||
    !isFiniteNumber(candidate.takeProfits?.tp1)
  ) {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "PRICE_GEOMETRY_INCOMPLETE" };
  }
  // Reject economically degenerate setups (same floors as external-rotation-overlay)
  if (isFiniteNumber(plan.stopDistanceBps) && plan.stopDistanceBps < MIN_OBSERVATION_STOP_BPS) {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "STOP_DISTANCE_BELOW_ABSURD_FLOOR" };
  }
  if (isFiniteNumber(plan.costR) && plan.costR >= MAX_OBSERVATION_COST_R) {
    return { admitted: false, lane: null, reasonCodes, rejectionReason: "PREDICTED_COST_R_TOO_HIGH" };
  }

  // Lane B: live source conflict (Kronos LONG + Whale BEARISH or Kronos SHORT + Whale BULLISH).
  // Lane A: Kronos available and actively opposed to trade direction.
  const kronosBias = candidate.kronosBias;
  const kronosAgrees = computeKronosAgrees(candidate);
  const kronosActivelyDisagrees =
    !!kronosBias &&
    kronosBias !== "UNAVAILABLE" &&
    (kronosBias === "LONG" || kronosBias === "SHORT") &&
    kronosBias !== candidate.finalDirection;

  // Precedence: Lane A (active disagreement) > Lane B (source conflict).
  // A candidate that is BOTH actively disagreeing AND source-conflicted goes to Lane A
  // (the disagreement is the broader signal).
  if (kronosActivelyDisagrees) {
    reasonCodes.push("KRONOS_BIAS_OPPOSITE_TO_TRADE_DIRECTION");
    if (candidate.sourceConflict) reasonCodes.push("ALSO_LIVE_SOURCE_CONFLICT");
    return {
      admitted: true,
      lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
      reasonCodes,
    };
  }

  if (candidate.sourceConflict === true) {
    reasonCodes.push("LIVE_SOURCE_CONFLICT_TRUE");
    reasonCodes.push(`KRONOS_${kronosBias ?? "UNKNOWN"}_VS_WHALE_${whaleSignalLabel(candidate) ?? "UNKNOWN"}`);
    return {
      admitted: true,
      lane: "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL",
      reasonCodes,
    };
  }

  // No Kronos veto/downgrade reason → not a counterfactual case.
  return {
    admitted: false,
    lane: null,
    reasonCodes,
    rejectionReason: kronosAgrees ? "KRONOS_AGREES_NOT_A_COUNTERFACTUAL" : "NO_KRONOS_VETO_REASON",
  };
}

// ─── Observation builder ─────────────────────────────────────────────────────

function buildSnapshot(candidate: Candidate, plan: VariantSelectionSnapshot): KronosCounterfactualSnapshot {
  const direction = candidate.finalDirection === "SHORT" ? "SHORT" : "LONG";
  return {
    direction,
    symbol: candidate.symbol,
    marketRegime: (candidate.indicators?.fiveMinute as { regime?: string | null } | undefined)?.regime ?? null,
    kronosBias: candidate.kronosBias ?? null,
    kronosAgrees: computeKronosAgrees(candidate),
    liveSourceConflict: candidate.sourceConflict ?? null,
    horizonConflict: candidate.horizonConflict ?? null,
    whaleSignal: whaleSignalLabel(candidate),
    whaleAvailable: candidate.whale.available ?? null,
    opportunityScore: candidate.opportunityScore,
    finalStatusObserved: candidate.finalStatus ?? null,
    selectedEntryVariant: plan.selectedEntryVariant,
    selectedExitVariant: plan.selectedExitVariant,
    plannedEntryPrice: roundMetric(candidate.indicators?.fiveMinute?.latestClose),
    stopPrice: roundMetric(candidate.stopLoss),
    tp1Price: roundMetric(candidate.takeProfits?.tp1),
    tp2Price: roundMetric(candidate.takeProfits?.tp2),
    tp3Price: roundMetric(candidate.takeProfits?.tp3),
    stopDistanceBps: plan.stopDistanceBps ?? null,
    costR: plan.costR ?? null,
    notes: candidate.reason ? candidate.reason.slice(0, 4) : [],
  };
}

export function buildKronosCounterfactualObservation(
  candidate: Candidate,
  lane: KronosCounterfactualLane,
  reasonCodes: string[],
  selectionBatchId: string,
  nowIso: string,
): KronosCounterfactualObservation | null {
  const plan = candidate.selectedExecutionPlan;
  if (!plan) return null;
  const snapshot = buildSnapshot(candidate, plan);
  if (snapshot.plannedEntryPrice === null || snapshot.stopPrice === null || snapshot.tp1Price === null) return null;
  const kronosBiasKey = typeof snapshot.kronosBias === "string" ? snapshot.kronosBias : null;
  const key = duplicateKey(
    candidate.symbol,
    snapshot.direction,
    lane,
    typeof snapshot.selectedEntryVariant === "string" ? snapshot.selectedEntryVariant : null,
    typeof snapshot.selectedExitVariant === "string" ? snapshot.selectedExitVariant : null,
    kronosBiasKey,
  );
  return {
    observationId: randomUUID(),
    createdAt: nowIso,
    updatedAt: nowIso,
    lane,
    symbol: candidate.symbol,
    selectionBatchId,
    duplicateKey: key,
    snapshot,
    observationStatus: "OPEN",
    resolverState: {
      lastEvaluatedAt: nowIso,
      openedAt: null,
      entryPrice: snapshot.plannedEntryPrice,
      remainingSizePct: 1,
      realizedGrossR: 0,
      tp1Hit: false,
      tp2Hit: false,
      slMovedToBreakeven: false,
      stopPrice: snapshot.stopPrice,
      currentPrice: snapshot.plannedEntryPrice,
    },
    diagnostics: {
      createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
      admissionReasonCodes: reasonCodes,
      resolutionSemantics:
        "Report-only counterfactual: 5m candle path, pending fill at planned entry, conservative stop-first same-candle handling, 24h expiry. Isolated from live trading and external overlay tapes.",
    },
  };
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

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
  observation: KronosCounterfactualObservation,
  time: string,
  price: number,
  reason: KronosCounterfactualCloseReason,
): void {
  const state = observation.resolverState;
  const snap = observation.snapshot;
  if (!state || state.entryPrice === null) return;
  if (state.remainingSizePct > 0) {
    state.realizedGrossR += rAtPrice(snap.direction, state.entryPrice, state.stopPrice, price) * state.remainingSizePct;
    state.remainingSizePct = 0;
  }
  const gross = roundMetric(state.realizedGrossR) ?? 0;
  const net = roundMetric(gross - (snap.costR ?? 0)) ?? gross;
  observation.observationStatus =
    reason === "NO_FILL" ? "NO_FILL" : reason === "TIME_EXPIRED" ? "EXPIRED" : "RESOLVED";
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
    durationMinutes: state.openedAt
      ? Math.round((new Date(time).getTime() - new Date(state.openedAt).getTime()) / 60000)
      : null,
    fillStatus: reason === "NO_FILL" ? "NO_FILL" : "FILLED",
  };
}

function updateObservationWithCandle(observation: KronosCounterfactualObservation, candle: Candle): void {
  if (observation.observationStatus !== "OPEN") return;
  const state = observation.resolverState;
  const snap = observation.snapshot;
  if (!state || state.entryPrice === null) return;
  const time = new Date(candle.openTime).toISOString();
  state.lastEvaluatedAt = time;
  state.currentPrice = candle.close;
  if (!state.openedAt) {
    if (!candleTouchesLevel(candle, state.entryPrice)) return;
    state.openedAt = time;
    observation.updatedAt = time;
    return;
  }

  const hitStop =
    state.stopPrice !== null &&
    (snap.direction === "LONG" ? candle.low <= state.stopPrice : candle.high >= state.stopPrice);
  const hitTp1 =
    !state.tp1Hit &&
    snap.tp1Price !== null &&
    (snap.direction === "LONG" ? candle.high >= snap.tp1Price : candle.low <= snap.tp1Price);
  if (hitStop) {
    closeObservation(observation, time, state.stopPrice!, state.slMovedToBreakeven ? "BREAKEVEN" : "SL");
    return;
  }
  if (hitTp1) {
    state.tp1Hit = true;
    const tp1Size =
      snap.selectedExitVariant === "tp1_full_exit"
        ? 1
        : snap.selectedExitVariant === "tp1_70_runner30"
          ? 0.7
          : 0.5;
    state.realizedGrossR +=
      rAtPrice(snap.direction, state.entryPrice, state.stopPrice, snap.tp1Price!) * tp1Size;
    state.remainingSizePct = Math.max(0, state.remainingSizePct - tp1Size);
    if (state.remainingSizePct <= 0) {
      closeObservation(observation, time, snap.tp1Price!, "TP1_FULL");
      return;
    }
    state.stopPrice = state.entryPrice;
    state.slMovedToBreakeven = true;
  }
  const hitTp2 =
    state.tp1Hit &&
    !state.tp2Hit &&
    snap.tp2Price !== null &&
    (snap.direction === "LONG" ? candle.high >= snap.tp2Price : candle.low <= snap.tp2Price);
  if (
    hitTp2 &&
    (snap.selectedExitVariant === "tp1_50_tp2_runner" || snap.selectedExitVariant === "tp1_70_runner30")
  ) {
    state.tp2Hit = true;
    closeObservation(observation, time, snap.tp2Price!, "TP2");
    return;
  }
  const hitTp3 =
    state.tp1Hit &&
    snap.tp3Price !== null &&
    (snap.direction === "LONG" ? candle.high >= snap.tp3Price : candle.low <= snap.tp3Price);
  if (hitTp3) {
    closeObservation(observation, time, snap.tp3Price!, "TP3");
  }
}

async function resolveOpenObservations(
  observations: KronosCounterfactualObservation[],
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
      const candles = await binanceClient.getCandles(
        observation.symbol,
        "5m",
        Math.min(Math.max(Math.ceil((nowMs - startMs) / 300000) + 2, 12), 500),
        { startTime: startMs, endTime: nowMs },
      );
      for (const candle of candles.filter((item) => item.openTime > startMs && item.openTime <= nowMs)) {
        updateObservationWithCandle(observation, candle);
        if (observation.observationStatus !== "OPEN") break;
      }
      if (
        observation.observationStatus === "OPEN" &&
        nowMs - new Date(observation.createdAt).getTime() >= OBSERVATION_MAX_MS
      ) {
        const state = observation.resolverState;
        if (state?.openedAt) {
          closeObservation(
            observation,
            now.toISOString(),
            state.currentPrice ?? state.entryPrice ?? observation.snapshot.plannedEntryPrice ?? 0,
            "TIME_EXPIRED",
          );
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
      observation.diagnostics.resolutionErrorCount =
        (observation.diagnostics.resolutionErrorCount ?? 0) + 1;
      observation.diagnostics.lastResolutionError =
        error instanceof Error ? error.message : "Unknown resolution error";
      observation.diagnostics.lastResolutionErrorAt = now.toISOString();
      failed += 1;
    }
  }
  return { resolved, failed };
}

// ─── Public emission / refresh ────────────────────────────────────────────────

/**
 * Pure-data emission helper (no I/O of its own). For each candidate, classify
 * into a counterfactual lane (or reject) and return the freshly built drafts.
 * Caller is responsible for duplicate suppression against existing store.
 */
export function classifyAndDraftCounterfactualObservations(
  candidates: Candidate[],
  selectionBatchId: string,
  nowIso: string,
): { drafts: KronosCounterfactualObservation[]; skippedReasons: Record<string, number> } {
  const drafts: KronosCounterfactualObservation[] = [];
  const skippedReasons: Record<string, number> = {};
  for (const candidate of candidates) {
    const decision = classifyKronosCounterfactualAdmission(candidate);
    if (!decision.admitted || !decision.lane) {
      const reason = decision.rejectionReason ?? "UNKNOWN";
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
      continue;
    }
    const draft = buildKronosCounterfactualObservation(
      candidate,
      decision.lane,
      decision.reasonCodes,
      selectionBatchId,
      nowIso,
    );
    if (draft) drafts.push(draft);
    else {
      skippedReasons["DRAFT_BUILD_FAILED"] = (skippedReasons["DRAFT_BUILD_FAILED"] ?? 0) + 1;
    }
  }
  return { drafts, skippedReasons };
}

/**
 * Emit new counterfactual observations into the store. Pure storage path —
 * does not invoke any network or binance call. Safe to call from scan cycle.
 */
export function emitKronosCounterfactualObservations(opts: {
  candidates: Candidate[];
  store: KronosCounterfactualStore;
  now?: Date;
  triggerSource?: "AUTO" | "MANUAL" | "SCAN_CYCLE";
}): KronosCounterfactualRefreshDiagnostics {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const triggerSource = opts.triggerSource ?? "SCAN_CYCLE";
  const selectionBatchId = `kronos-counterfactual-${nowIso}`;
  const state = opts.store.readState();
  const observations = state.observations;
  const { drafts, skippedReasons } = classifyAndDraftCounterfactualObservations(
    opts.candidates,
    selectionBatchId,
    nowIso,
  );
  let created = 0;
  let suppressed = 0;
  let skipped = 0;
  const laneCreatedCounts: Record<KronosCounterfactualLane, number> = {
    KRONOS_DISAGREEMENT_COUNTERFACTUAL: 0,
    LIVE_SOURCE_CONFLICT_COUNTERFACTUAL: 0,
  };

  for (const draft of drafts) {
    const duplicate = observations.some(
      (existing) =>
        existing.duplicateKey === draft.duplicateKey &&
        now.getTime() - new Date(existing.createdAt).getTime() <= DUPLICATE_SUPPRESSION_MS,
    );
    if (duplicate) {
      suppressed += 1;
      continue;
    }
    observations.push(draft);
    laneCreatedCounts[draft.lane] += 1;
    created += 1;
  }
  // skippedReasons counts candidates rejected at classification; add to "skipped" total
  for (const count of Object.values(skippedReasons)) skipped += count;

  const diagnostics: KronosCounterfactualRefreshDiagnostics = {
    generatedAt: nowIso,
    triggerSource,
    selectionBatchId,
    candidatesConsidered: opts.candidates.length,
    observationsCreated: created,
    observationsSuppressedAsDuplicate: suppressed,
    observationsSkippedForInsufficientState: skipped,
    observationsResolvedThisRefresh: 0,
    observationsFailedResolution: 0,
    laneCreatedCounts,
    notes: [
      "Report-only Kronos counterfactual lane. Isolated from live trading, scoring, ranking, readiness, and external overlay tapes.",
    ],
  };
  opts.store.writeState({
    observations,
    latestRefreshDiagnostics: diagnostics,
  });
  return diagnostics;
}

/**
 * Resolve open counterfactual observations using a Binance client. Intended to
 * be invoked periodically (e.g. piggybacking the external rotation overlay
 * refresh cadence). Does not emit new observations.
 */
export async function resolveKronosCounterfactualObservations(opts: {
  store: KronosCounterfactualStore;
  binanceClient: BinanceClient;
  now?: Date;
  triggerSource?: "AUTO" | "MANUAL";
}): Promise<KronosCounterfactualRefreshDiagnostics> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const triggerSource = opts.triggerSource ?? "AUTO";
  const selectionBatchId = `kronos-counterfactual-resolve-${nowIso}`;
  const state = opts.store.readState();
  const observations = state.observations;
  const resolution = await resolveOpenObservations(observations, opts.binanceClient, now);
  const laneCreatedCounts: Record<KronosCounterfactualLane, number> = {
    KRONOS_DISAGREEMENT_COUNTERFACTUAL: 0,
    LIVE_SOURCE_CONFLICT_COUNTERFACTUAL: 0,
  };
  const diagnostics: KronosCounterfactualRefreshDiagnostics = {
    generatedAt: nowIso,
    triggerSource,
    selectionBatchId,
    candidatesConsidered: 0,
    observationsCreated: 0,
    observationsSuppressedAsDuplicate: 0,
    observationsSkippedForInsufficientState: 0,
    observationsResolvedThisRefresh: resolution.resolved,
    observationsFailedResolution: resolution.failed,
    laneCreatedCounts,
    notes: ["Resolution-only refresh: no new observations created. Report-only."],
  };
  opts.store.writeState({
    observations,
    latestRefreshDiagnostics: diagnostics,
  });
  return diagnostics;
}

// ─── Report builder ──────────────────────────────────────────────────────────

export interface KronosCounterfactualValidationMilestones {
  lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL" | "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL";
  resolvedN: number;
  resolvedNCleared: boolean;        // resolvedN >= 60
  distinctCalendarDays: number;
  calendarDaysCleared: boolean;     // distinctCalendarDays >= 5
  exTop2SymbolNetAvgR: number | null;
  exTop2SymbolProfitFactor: number | null;
  exTop2Cleared: boolean;           // exTop2NetAvgR <= -0.10 AND exTop2PF < 0.30
  longNetAvgR: number | null;
  shortNetAvgR: number | null;
  bothDirectionsNegative: boolean;  // longNetAvgR < 0 AND shortNetAvgR < 0
  costModelControlReady: boolean;   // always false for now
  costModelControlReason: string;
  overallStatus: "TOO_EARLY" | "PROMISING_BUT_CONCENTRATED" | "ROBUST_VALIDATION_CANDIDATE";
}

export interface KronosCounterfactualLaneEconomics {
  lane: KronosCounterfactualLane;
  total: number;
  open: number;
  resolved: number;
  noFill: number;
  expired: number;
  failed: number;
  resolvedNetAvgR: number | null;
  resolvedProfitFactor: number | null;
  resolvedWinRate: number | null;
  hasEnoughForVerdict: boolean;
  milestones: KronosCounterfactualValidationMilestones;
}

export interface KronosCounterfactualReport {
  generatedAt: string;
  observationsTotal: number;
  observationsOpen: number;
  observationsResolved: number;
  observationsNoFill: number;
  observationsExpired: number;
  observationsFailed: number;
  lanes: KronosCounterfactualLaneEconomics[];
  verdict: "TOO_EARLY" | "EVIDENCE_AVAILABLE";
  notes: string[];
}

export function computeValidationMilestones(
  lane: KronosCounterfactualLane,
  resolvedObs: KronosCounterfactualObservation[],
): KronosCounterfactualValidationMilestones {
  // Only operate on observations that are RESOLVED with finite realizedNetR
  const resolved = resolvedObs.filter(
    (obs) =>
      obs.observationStatus === "RESOLVED" &&
      obs.outcome !== undefined &&
      isFiniteNumber(obs.outcome.realizedNetR),
  );

  // resolvedN
  const resolvedN = resolved.length;
  const resolvedNCleared = resolvedN >= MILESTONE_RESOLVED_N_TARGET;

  // distinctCalendarDays — count distinct UTC date strings
  const daySet = new Set(resolved.map((obs) => obs.createdAt.slice(0, 10)));
  const distinctCalendarDays = daySet.size;
  const calendarDaysCleared = distinctCalendarDays >= MILESTONE_CALENDAR_DAYS_TARGET;

  // exTop2 logic
  // 1. Group by symbol, compute each symbol's netSumR
  const symbolNetSum = new Map<string, number>();
  for (const obs of resolved) {
    const sym = obs.snapshot.symbol;
    const netR = obs.outcome!.realizedNetR as number;
    symbolNetSum.set(sym, (symbolNetSum.get(sym) ?? 0) + netR);
  }
  // 2. Top-2 by most-negative netSumR (ascending sort, take first 2)
  const sortedSymbols = [...symbolNetSum.entries()].sort((a, b) => a[1] - b[1]);
  const top2Symbols = new Set(sortedSymbols.slice(0, 2).map((e) => e[0]));
  // 3. Remaining observations (excluding top-2 symbols)
  const remaining = resolved.filter((obs) => !top2Symbols.has(obs.snapshot.symbol));
  let exTop2SymbolNetAvgR: number | null = null;
  let exTop2SymbolProfitFactor: number | null = null;
  if (remaining.length > 0) {
    const nets = remaining.map((obs) => obs.outcome!.realizedNetR as number);
    exTop2SymbolNetAvgR = roundMetric(nets.reduce((s, v) => s + v, 0) / nets.length);
    const sumWins = nets.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const sumLossAbs = nets.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
    if (sumLossAbs > 0) {
      exTop2SymbolProfitFactor = roundMetric(sumWins / sumLossAbs, 2);
    } else if (nets.some((v) => v > 0)) {
      exTop2SymbolProfitFactor = null; // wins but no losses — PF undefined (null = no losses)
    } else {
      exTop2SymbolProfitFactor = 0; // losses but no wins
    }
  }
  const exTop2Cleared =
    exTop2SymbolNetAvgR !== null &&
    exTop2SymbolProfitFactor !== null &&
    exTop2SymbolNetAvgR <= MILESTONE_EX_TOP2_NET_AVG_R_THRESHOLD &&
    exTop2SymbolProfitFactor < MILESTONE_EX_TOP2_PF_THRESHOLD;

  // bothDirectionsNegative
  const longObs = resolved.filter((obs) => obs.snapshot.direction === "LONG");
  const shortObs = resolved.filter((obs) => obs.snapshot.direction === "SHORT");
  const longNets = longObs.map((obs) => obs.outcome!.realizedNetR as number);
  const shortNets = shortObs.map((obs) => obs.outcome!.realizedNetR as number);
  const longNetAvgR =
    longNets.length > 0
      ? roundMetric(longNets.reduce((s, v) => s + v, 0) / longNets.length)
      : null;
  const shortNetAvgR =
    shortNets.length > 0
      ? roundMetric(shortNets.reduce((s, v) => s + v, 0) / shortNets.length)
      : null;
  const bothDirectionsNegative =
    longNetAvgR !== null && shortNetAvgR !== null && longNetAvgR < 0 && shortNetAvgR < 0;

  // costModelControlReady: always false
  const costModelControlReady = false;
  const costModelControlReason =
    "per-leg cost model or paired Kronos-approved control cohort not yet available";

  // overallStatus
  let overallStatus: KronosCounterfactualValidationMilestones["overallStatus"];
  if (resolvedN < MILESTONE_MIN_RESOLVED_FOR_PROMISING) {
    overallStatus = "TOO_EARLY";
  } else if (resolvedNCleared && calendarDaysCleared && exTop2Cleared && bothDirectionsNegative) {
    overallStatus = "ROBUST_VALIDATION_CANDIDATE";
  } else {
    overallStatus = "PROMISING_BUT_CONCENTRATED";
  }

  return {
    lane,
    resolvedN,
    resolvedNCleared,
    distinctCalendarDays,
    calendarDaysCleared,
    exTop2SymbolNetAvgR,
    exTop2SymbolProfitFactor,
    exTop2Cleared,
    longNetAvgR,
    shortNetAvgR,
    bothDirectionsNegative,
    costModelControlReady,
    costModelControlReason,
    overallStatus,
  };
}

function summarizeLane(
  observations: KronosCounterfactualObservation[],
  lane: KronosCounterfactualLane,
): KronosCounterfactualLaneEconomics {
  const inLane = observations.filter((obs) => obs.lane === lane);
  const open = inLane.filter((o) => o.observationStatus === "OPEN").length;
  const resolved = inLane.filter((o) => o.observationStatus === "RESOLVED");
  const noFill = inLane.filter((o) => o.observationStatus === "NO_FILL").length;
  const expired = inLane.filter((o) => o.observationStatus === "EXPIRED").length;
  const failed = inLane.filter((o) => o.observationStatus === "FAILED").length;
  let resolvedNetAvgR: number | null = null;
  let pf: number | null = null;
  let winRate: number | null = null;
  if (resolved.length > 0) {
    const nets = resolved
      .map((o) => o.outcome?.realizedNetR)
      .filter((v): v is number => isFiniteNumber(v));
    if (nets.length > 0) {
      const sumNet = nets.reduce((s, v) => s + v, 0);
      resolvedNetAvgR = roundMetric(sumNet / nets.length);
      const sumWins = nets.filter((v) => v > 0).reduce((s, v) => s + v, 0);
      const sumLossAbs = nets.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
      pf = sumLossAbs > 0 ? roundMetric(sumWins / sumLossAbs, 2) : null;
      const wins = nets.filter((v) => v > 0).length;
      winRate = roundMetric(wins / nets.length, 4);
    }
  }
  return {
    lane,
    total: inLane.length,
    open,
    resolved: resolved.length,
    noFill,
    expired,
    failed,
    resolvedNetAvgR,
    resolvedProfitFactor: pf,
    resolvedWinRate: winRate,
    hasEnoughForVerdict: resolved.length >= KRONOS_COUNTERFACTUAL_MIN_RESOLVED_FOR_VERDICT,
    milestones: computeValidationMilestones(lane, resolved),
  };
}

export function buildKronosCounterfactualReport(
  observations: KronosCounterfactualObservation[],
  now: Date = new Date(),
): KronosCounterfactualReport {
  const open = observations.filter((o) => o.observationStatus === "OPEN").length;
  const resolved = observations.filter((o) => o.observationStatus === "RESOLVED").length;
  const noFill = observations.filter((o) => o.observationStatus === "NO_FILL").length;
  const expired = observations.filter((o) => o.observationStatus === "EXPIRED").length;
  const failed = observations.filter((o) => o.observationStatus === "FAILED").length;
  const lanes: KronosCounterfactualLane[] = [
    "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
    "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL",
  ];
  const laneEconomics = lanes.map((lane) => summarizeLane(observations, lane));
  const verdict: "TOO_EARLY" | "EVIDENCE_AVAILABLE" = laneEconomics.some((l) => l.hasEnoughForVerdict)
    ? "EVIDENCE_AVAILABLE"
    : "TOO_EARLY";
  return {
    generatedAt: now.toISOString(),
    observationsTotal: observations.length,
    observationsOpen: open,
    observationsResolved: resolved,
    observationsNoFill: noFill,
    observationsExpired: expired,
    observationsFailed: failed,
    lanes: laneEconomics,
    verdict,
    notes: [
      "Report-only counterfactual evidence. Has no effect on scoring, ranking, readiness, route selection, or live trading.",
      `Verdict requires ≥${KRONOS_COUNTERFACTUAL_MIN_RESOLVED_FOR_VERDICT} resolved observations in at least one lane.`,
    ],
  };
}

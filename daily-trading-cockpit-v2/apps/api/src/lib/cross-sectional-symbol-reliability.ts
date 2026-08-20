/**
 * Symbol Reliability V1
 *
 * A side-specific circuit breaker for the Plain MOM36 FILTERED basket.  This module never
 * modifies momentum scores, ranks, weights, or exits.  It only returns a deterministic list of
 * symbol+side pairs which have accumulated enough *actual, independent, exact Hold-36h* evidence
 * to be quarantined.  Everything else stays eligible.
 *
 * The evidence source is intentionally narrower than the historical measurement store:
 * completed executor baskets with frozen NoTP + 36h policy and HORIZON close.  A measurement path
 * with a different horizon, an operator close, a stop/TP, an adaptive exit, an aborted basket, or
 * incomplete accounting is not interchangeable with the policy this gate protects.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExecutorBasket, ExecutorLeg } from "./cross-sectional-executor.js";

export const SYMBOL_RELIABILITY_VERSION = "SYMBOL_RELIABILITY_V1" as const;
export const SYMBOL_RELIABILITY_EVIDENCE_CONTRACT = "ACTUAL_NO_TP_HOLD_36H_INDEPENDENT_EPISODES_V1" as const;

export type SymbolReliabilitySide = "LONG" | "SHORT";
export type SymbolReliabilityStatus = "HEALTHY" | "DEGRADED" | "INSUFFICIENT_DATA" | "QUARANTINED";
export type SymbolReliabilityWindowKey = "30D" | "60D" | "90D" | "CURRENT_QUARTER" | "2Y_REFERENCE";

export interface SymbolReliabilityWindowMetrics {
  key: SymbolReliabilityWindowKey;
  startAt: string;
  endAt: string;
  independentN: number;
  meanContribution: number | null;
  medianContribution: number | null;
  profitFactor: number | null;
  hitRate: number | null;
  cvar5: number | null;
  worstTail: number | null;
  meanMaeR: number | null;
  meanMfeR: number | null;
  winnerToLoserDamageRate: number | null;
}

export interface SymbolReliabilityStatusRow {
  symbol: string;
  side: SymbolReliabilitySide;
  status: SymbolReliabilityStatus;
  diagnosticScore: number | null;
  independentN: number;
  meanContribution: number | null;
  medianContribution: number | null;
  profitFactor: number | null;
  hitRate: number | null;
  cvar5: number | null;
  worstTail: number | null;
  meanMaeR: number | null;
  meanMfeR: number | null;
  winnerToLoserDamageRate: number | null;
  deteriorationWindows: SymbolReliabilityWindowKey[];
  peerBadnessPercentile: number | null;
  tailBadnessPercentile: number | null;
  damageBadnessPercentile: number | null;
  trend: "IMPROVING" | "STABLE" | "DETERIORATING" | "INSUFFICIENT";
  reason: string;
  windows: SymbolReliabilityWindowMetrics[];
  pendingDowngradeEvaluations: number;
  pendingRecoveryEvaluations: number;
}

export interface SymbolReliabilityFormationCandidate {
  symbol: string;
  side: SymbolReliabilitySide;
  score: number;
  status: SymbolReliabilityStatus;
  diagnosticScore: number | null;
  eligible: boolean;
  reason: string;
}

export interface SymbolReliabilityFormationDecision {
  version: typeof SYMBOL_RELIABILITY_VERSION;
  evaluatedAt: string;
  evaluationId: string;
  sourceObservationId: string;
  decision: "PASS" | "NO_TRADE_INSUFFICIENT_ELIGIBLE" | "NO_TRADE_SCORE_GAP" | "NO_TRADE_OTHER";
  candidateListBefore: Record<SymbolReliabilitySide, SymbolReliabilityFormationCandidate[]>;
  candidateListAfter: Record<SymbolReliabilitySide, SymbolReliabilityFormationCandidate[]>;
  quarantined: Array<{ symbol: string; side: SymbolReliabilitySide; reason: string }>;
  selectedBefore: Record<SymbolReliabilitySide, string[]>;
  selectedAfter: Record<SymbolReliabilitySide, string[]>;
  replacements: Array<{ side: SymbolReliabilitySide; removed: string; replacement: string | null }>;
  scoreGapBefore: number | null;
  scoreGapAfter: number | null;
  scoreGapFloor: number | null;
  diagnosticsBySymbolSide: Array<Pick<SymbolReliabilityStatusRow,
    "symbol" | "side" | "status" | "diagnosticScore" | "independentN" | "meanContribution" |
    "profitFactor" | "cvar5" | "winnerToLoserDamageRate" | "reason">>;
}

export interface SymbolReliabilitySnapshot {
  version: typeof SYMBOL_RELIABILITY_VERSION;
  enabled: boolean;
  evidenceContract: typeof SYMBOL_RELIABILITY_EVIDENCE_CONTRACT;
  evaluatedAt: string;
  evaluationId: string;
  evaluationCycle: number;
  evidenceChanged: boolean;
  independentEpisodes: number;
  eligibleBaskets: number;
  excludedBaskets: Record<string, number>;
  minimumIndependentEpisodes: number;
  statuses: SymbolReliabilityStatusRow[];
  quarantined: Array<{ symbol: string; side: SymbolReliabilitySide; reason: string }>;
  lastFormationDecision: SymbolReliabilityFormationDecision | null;
}

type StoredStatus = {
  status: SymbolReliabilityStatus;
  downgradeEvaluations: number;
  recoveryEvaluations: number;
  /** Hysteresis advances only when this exact symbol+side has new actual episode evidence. */
  evidenceFingerprint?: string;
};

type ReliabilityState = {
  version: 1;
  evaluationCycle: number;
  lastEvaluationDay: string | null;
  lastEvidenceFingerprint: string | null;
  statuses: Record<string, StoredStatus>;
  latest: SymbolReliabilitySnapshot | null;
  formationDecisions: SymbolReliabilityFormationDecision[];
};

type EligibleBasket = {
  basket: ExecutorBasket;
  openedAtMs: number;
  closedAtMs: number;
  entryNotionalUsd: number;
};

type EpisodeOutcome = {
  symbol: string;
  side: SymbolReliabilitySide;
  contribution: number;
  maeR: number | null;
  mfeR: number | null;
  winnerToLoser: boolean | null;
};

type IndependentEpisode = {
  id: string;
  openedAtMs: number;
  closedAtMs: number;
  outcomes: EpisodeOutcome[];
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MIN_INDEPENDENT_EPISODES = 8;
const REQUIRED_DETERIORATION_WINDOWS = 2;
const REQUIRED_CONSECUTIVE_EVALUATIONS = 2;
const POOR_PEER_PERCENTILE = 75;
const MAX_STORED_FORMATION_DECISIONS = 500;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numberOrNull = (value: unknown): number | null => finite(value) ? value : null;
const mean = (values: readonly number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const keyOf = (symbol: string, side: SymbolReliabilitySide): string => `${symbol.toUpperCase()}:${side}`;
const nowIso = (nowMs: number): string => new Date(nowMs).toISOString();

export function isCrossSectionalSymbolReliabilityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED === "1";
}

export function symbolReliabilityPolicyFingerprint(env: NodeJS.ProcessEnv = process.env): {
  version: typeof SYMBOL_RELIABILITY_VERSION;
  enabled: boolean;
  evidenceContract: typeof SYMBOL_RELIABILITY_EVIDENCE_CONTRACT;
  minimumIndependentEpisodes: number;
  requiredDeteriorationWindows: number;
  requiredConsecutiveEvaluations: number;
} {
  return {
    version: SYMBOL_RELIABILITY_VERSION,
    enabled: isCrossSectionalSymbolReliabilityEnabled(env),
    evidenceContract: SYMBOL_RELIABILITY_EVIDENCE_CONTRACT,
    minimumIndependentEpisodes: MIN_INDEPENDENT_EPISODES,
    requiredDeteriorationWindows: REQUIRED_DETERIORATION_WINDOWS,
    requiredConsecutiveEvaluations: REQUIRED_CONSECUTIVE_EVALUATIONS,
  };
}

function legEntryNotional(leg: ExecutorLeg): number | null {
  const value = Math.abs(leg.qty * leg.entryPrice);
  return finite(value) && value > 0 ? value : null;
}

/** Only a fully completed 3L/3S, exact no-TP, no-stop, no-adaptive 36h horizon basket is evidence. */
function reliabilityExclusionReason(basket: ExecutorBasket): string | null {
  if (basket.status !== "CLOSED") return "NOT_CLOSED";
  if (basket.variant !== "FILTERED") return "NOT_FILTERED";
  if (basket.accountingStatus === "ACCOUNTING_INCOMPLETE") return "ACCOUNTING_INCOMPLETE";
  if (!finite(basket.netPnlUsd) || !finite(basket.feeEstimateUsd)) return "MISSING_FINAL_ACCOUNTING";
  if (basket.closeReason !== "HORIZON") return "NOT_HORIZON";
  const execution = basket.policyFingerprint?.execution;
  if (!execution) return "LEGACY_NO_FROZEN_POLICY";
  if (execution.executionCapHours !== 36) return "NOT_HOLD_36H";
  if (execution.takeProfitEnabled || execution.stopLossEnabled || execution.adaptiveExitsEnabled) return "NOT_NOTP_POLICY";
  if (basket.legs.length !== 6) return "NOT_3L_3S";
  const longN = basket.legs.filter((leg) => leg.side === "LONG").length;
  const shortN = basket.legs.filter((leg) => leg.side === "SHORT").length;
  if (longN !== 3 || shortN !== 3) return "NOT_3L_3S";
  if (basket.legs.some((leg) => !legEntryNotional(leg) || !finite(leg.exitPrice) || leg.exitPrice! <= 0)) return "INCOMPLETE_LEG_ECONOMICS";
  if (!finite(Date.parse(basket.openedAt)) || !finite(Date.parse(basket.closedAt ?? ""))) return "INVALID_TIMESTAMPS";
  return null;
}

function collectEligibleBaskets(baskets: readonly ExecutorBasket[]): {
  eligible: EligibleBasket[];
  excluded: Record<string, number>;
} {
  const excluded: Record<string, number> = {};
  const eligible: EligibleBasket[] = [];
  for (const basket of baskets) {
    const reason = reliabilityExclusionReason(basket);
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    const entryNotionalUsd = basket.legs.reduce((sum, leg) => sum + (legEntryNotional(leg) ?? 0), 0);
    const openedAtMs = Date.parse(basket.openedAt);
    const closedAtMs = Date.parse(basket.closedAt!);
    if (!(entryNotionalUsd > 0) || !(closedAtMs >= openedAtMs)) {
      excluded.INVALID_ECONOMIC_WINDOW = (excluded.INVALID_ECONOMIC_WINDOW ?? 0) + 1;
      continue;
    }
    eligible.push({ basket, openedAtMs, closedAtMs, entryNotionalUsd });
  }
  return { eligible: eligible.sort((a, b) => a.openedAtMs - b.openedAtMs || a.basket.basketId.localeCompare(b.basket.basketId)), excluded };
}

/**
 * Every connected overlap component is one independent episode.  We aggregate concurrent baskets
 * inside it instead of pretending hourly entries exposed to the same move are independent samples.
 */
function independentEpisodes(eligible: readonly EligibleBasket[]): IndependentEpisode[] {
  const components: EligibleBasket[][] = [];
  let current: EligibleBasket[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;
  const flush = (): void => {
    if (current.length) components.push(current);
    current = [];
    currentEnd = Number.NEGATIVE_INFINITY;
  };
  for (const row of eligible) {
    if (!current.length || row.openedAtMs >= currentEnd) {
      flush();
      current = [row];
      currentEnd = row.closedAtMs;
      continue;
    }
    current.push(row);
    currentEnd = Math.max(currentEnd, row.closedAtMs);
  }
  flush();
  return components.map((component) => {
    const bySymbolSide = new Map<string, EpisodeOutcome[]>();
    for (const row of component) {
      const fee = row.basket.feeEstimateUsd ?? 0;
      for (const leg of row.basket.legs) {
        const notional = legEntryNotional(leg)!;
        const directionPnl = leg.side === "LONG"
          ? leg.qty * (leg.exitPrice! - leg.entryPrice)
          : leg.qty * (leg.entryPrice - leg.exitPrice!);
        const feeShare = fee * (notional / row.entryNotionalUsd);
        const contribution = (directionPnl - feeShare) / row.entryNotionalUsd;
        const finalReturn = contribution;
        const mfeR = numberOrNull(leg.maxFavorableR);
        const maeR = numberOrNull(leg.maxAdverseR);
        const winnerToLoser = mfeR !== null ? mfeR > 0 && finalReturn < 0 : null;
        const key = keyOf(leg.symbol, leg.side);
        const entries = bySymbolSide.get(key) ?? [];
        entries.push({ symbol: leg.symbol.toUpperCase(), side: leg.side, contribution, mfeR, maeR, winnerToLoser });
        bySymbolSide.set(key, entries);
      }
    }
    const outcomes: EpisodeOutcome[] = [];
    for (const entries of bySymbolSide.values()) {
      const template = entries[0]!;
      const damage = entries.map((entry) => entry.winnerToLoser).filter((value): value is boolean => typeof value === "boolean");
      outcomes.push({
        symbol: template.symbol,
        side: template.side,
        contribution: mean(entries.map((entry) => entry.contribution)) ?? 0,
        mfeR: mean(entries.map((entry) => entry.mfeR).filter((value): value is number => value !== null)),
        maeR: mean(entries.map((entry) => entry.maeR).filter((value): value is number => value !== null)),
        winnerToLoser: damage.length ? damage.some(Boolean) : null,
      });
    }
    const openedAtMs = Math.min(...component.map((row) => row.openedAtMs));
    const closedAtMs = Math.max(...component.map((row) => row.closedAtMs));
    return {
      id: createHash("sha256").update(component.map((row) => row.basket.basketId).sort().join("|")).digest("hex").slice(0, 16),
      openedAtMs,
      closedAtMs,
      outcomes,
    };
  });
}

function quarterStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1);
}

function windowsAt(nowMs: number): Array<{ key: SymbolReliabilityWindowKey; startMs: number }> {
  return [
    { key: "30D", startMs: nowMs - 30 * DAY_MS },
    { key: "60D", startMs: nowMs - 60 * DAY_MS },
    { key: "90D", startMs: nowMs - 90 * DAY_MS },
    { key: "CURRENT_QUARTER", startMs: quarterStartMs(nowMs) },
    { key: "2Y_REFERENCE", startMs: nowMs - 730 * DAY_MS },
  ];
}

function metricFor(key: SymbolReliabilityWindowKey, startMs: number, nowMs: number, outcomes: EpisodeOutcome[]): SymbolReliabilityWindowMetrics {
  const values = outcomes.map((outcome) => outcome.contribution);
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = values.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  const sorted = [...values].sort((a, b) => a - b);
  const cvarN = Math.max(1, Math.ceil(sorted.length * 0.05));
  const mae = outcomes.map((outcome) => outcome.maeR).filter((value): value is number => value !== null);
  const mfe = outcomes.map((outcome) => outcome.mfeR).filter((value): value is number => value !== null);
  const damage = outcomes.map((outcome) => outcome.winnerToLoser).filter((value): value is boolean => typeof value === "boolean");
  return {
    key,
    startAt: nowIso(startMs),
    endAt: nowIso(nowMs),
    independentN: values.length,
    meanContribution: mean(values),
    medianContribution: median(values),
    profitFactor: losses > 0 ? gains / losses : null,
    hitRate: values.length ? values.filter((value) => value > 0).length / values.length : null,
    cvar5: sorted.length ? mean(sorted.slice(0, cvarN)) : null,
    worstTail: sorted.length ? sorted[0]! : null,
    meanMaeR: mean(mae),
    meanMfeR: mean(mfe),
    winnerToLoserDamageRate: damage.length ? damage.filter(Boolean).length / damage.length : null,
  };
}

function percentileBadLow(value: number | null, values: Array<number | null>): number | null {
  if (value === null) return null;
  const sorted = values.filter((entry): entry is number => entry !== null).sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const index = sorted.findIndex((entry) => entry >= value - 1e-15);
  return 100 * (sorted.length - 1 - Math.max(0, index)) / (sorted.length - 1);
}

function percentileBadHigh(value: number | null, values: Array<number | null>): number | null {
  if (value === null) return null;
  const sorted = values.filter((entry): entry is number => entry !== null).sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const index = sorted.findIndex((entry) => entry >= value - 1e-15);
  return 100 * Math.max(0, index) / (sorted.length - 1);
}

function trendOf(recent: SymbolReliabilityWindowMetrics[]): SymbolReliabilityStatusRow["trend"] {
  const short = recent.find((window) => window.key === "30D")?.meanContribution ?? null;
  const long = recent.find((window) => window.key === "90D")?.meanContribution ?? null;
  if (short === null || long === null) return "INSUFFICIENT";
  if (short < long - 0.00025) return "DETERIORATING";
  if (short > long + 0.00025) return "IMPROVING";
  return "STABLE";
}

function symbolSideEvidenceFingerprint(outcomes: Array<EpisodeOutcome & { closedAtMs: number }>): string {
  return createHash("sha256").update(JSON.stringify(outcomes.map((outcome) => ({
    symbol: outcome.symbol,
    side: outcome.side,
    closedAtMs: outcome.closedAtMs,
    contribution: outcome.contribution,
    maeR: outcome.maeR,
    mfeR: outcome.mfeR,
    winnerToLoser: outcome.winnerToLoser,
  })))).digest("hex");
}

type EvaluatedStatusRow = {
  row: SymbolReliabilityStatusRow;
  evidenceFingerprint: string;
};

function compatibleStatusRows(
  episodes: readonly IndependentEpisode[],
  universe: readonly string[],
  nowMs: number,
  previous: Record<string, StoredStatus>,
): EvaluatedStatusRow[] {
  const windows = windowsAt(nowMs);
  const statusDrafts: Array<{
    symbol: string;
    side: SymbolReliabilitySide;
    perWindow: SymbolReliabilityWindowMetrics[];
    primary: SymbolReliabilityWindowMetrics;
    evidenceFingerprint: string;
  }> = [];
  for (const symbol of [...new Set(universe.map((value) => value.toUpperCase()))].sort()) {
    for (const side of ["LONG", "SHORT"] as const) {
      const all = episodes.flatMap((episode) => episode.outcomes.filter((outcome) => outcome.symbol === symbol && outcome.side === side).map((outcome) => ({ ...outcome, closedAtMs: episode.closedAtMs })));
      const perWindow = windows.map(({ key, startMs }) => metricFor(key, startMs, nowMs, all.filter((outcome) => outcome.closedAtMs >= startMs && outcome.closedAtMs <= nowMs)));
      const primary = perWindow.find((window) => window.key === "90D")!;
      statusDrafts.push({ symbol, side, perWindow, primary, evidenceFingerprint: symbolSideEvidenceFingerprint(all) });
    }
  }
  return statusDrafts.map((draft) => {
    const peer = statusDrafts.filter((candidate) => candidate.side === draft.side && candidate.primary.independentN >= MIN_INDEPENDENT_EPISODES).map((candidate) => candidate.primary);
    const meanBadness = percentileBadLow(draft.primary.meanContribution, peer.map((metric) => metric.meanContribution));
    const pfBadness = percentileBadLow(draft.primary.profitFactor, peer.map((metric) => metric.profitFactor));
    const tailBadness = percentileBadLow(draft.primary.cvar5, peer.map((metric) => metric.cvar5));
    const damageBadness = percentileBadHigh(draft.primary.winnerToLoserDamageRate, peer.map((metric) => metric.winnerToLoserDamageRate));
    const badnessParts = [meanBadness, pfBadness, tailBadness, damageBadness].filter((value): value is number => value !== null);
    const peerBadnessPercentile = badnessParts.length ? mean(badnessParts) : null;
    const diagnosticScore = peerBadnessPercentile === null ? null : Math.round(clamp(100 - peerBadnessPercentile, 0, 100));
    const recent = draft.perWindow.filter((window) => window.key !== "2Y_REFERENCE");
    const deteriorating = recent.filter((window) =>
      window.independentN >= MIN_INDEPENDENT_EPISODES &&
      window.meanContribution !== null && window.meanContribution < 0 &&
      window.profitFactor !== null && window.profitFactor < 1,
    );
    const primaryN = draft.primary.independentN;
    const sufficient = primaryN >= MIN_INDEPENDENT_EPISODES;
    const tailOrDamagePoor = (tailBadness !== null && tailBadness >= POOR_PEER_PERCENTILE) ||
      (damageBadness !== null && damageBadness >= POOR_PEER_PERCENTILE);
    const strictDeterioration = sufficient &&
      deteriorating.length >= REQUIRED_DETERIORATION_WINDOWS &&
      tailOrDamagePoor;
    const recoveryWindows = recent.filter((window) =>
      window.independentN >= MIN_INDEPENDENT_EPISODES &&
      window.meanContribution !== null && window.meanContribution >= 0 &&
      window.profitFactor !== null && window.profitFactor >= 1,
    );
    const recovery = sufficient && recoveryWindows.length >= REQUIRED_DETERIORATION_WINDOWS &&
      (tailBadness === null || tailBadness < POOR_PEER_PERCENTILE) &&
      (damageBadness === null || damageBadness < POOR_PEER_PERCENTILE);
    const key = keyOf(draft.symbol, draft.side);
    const prior = previous[key] ?? { status: "INSUFFICIENT_DATA" as const, downgradeEvaluations: 0, recoveryEvaluations: 0 };
    const symbolEvidenceChanged = prior.evidenceFingerprint !== draft.evidenceFingerprint;
    let status: SymbolReliabilityStatus;
    let downgradeEvaluations = prior.downgradeEvaluations;
    let recoveryEvaluations = prior.recoveryEvaluations;
    // A newly completed basket for ANOTHER symbol is not proof that this stale diagnostic
    // persisted. Daily refreshes and unrelated outcomes can update display metrics, but cannot
    // advance quarantine/recovery hysteresis for a symbol+side with no new own evidence.
    if (!symbolEvidenceChanged) {
      status = prior.status;
    } else if (prior.status === "QUARANTINED") {
      if (recovery) {
        recoveryEvaluations += 1;
        if (recoveryEvaluations >= REQUIRED_CONSECUTIVE_EVALUATIONS) {
          status = "HEALTHY";
          downgradeEvaluations = 0;
          recoveryEvaluations = 0;
        } else {
          status = "QUARANTINED";
        }
      } else {
        status = "QUARANTINED";
        recoveryEvaluations = 0;
      }
    } else if (!sufficient) {
      status = "INSUFFICIENT_DATA";
      downgradeEvaluations = 0;
      recoveryEvaluations = 0;
    } else if (strictDeterioration) {
      downgradeEvaluations += 1;
      recoveryEvaluations = 0;
      status = downgradeEvaluations >= REQUIRED_CONSECUTIVE_EVALUATIONS ? "QUARANTINED" : "DEGRADED";
    } else {
      downgradeEvaluations = 0;
      recoveryEvaluations = 0;
      status = deteriorating.length > 0 || (peerBadnessPercentile !== null && peerBadnessPercentile >= POOR_PEER_PERCENTILE)
        ? "DEGRADED"
        : "HEALTHY";
    }
    const reason = status === "INSUFFICIENT_DATA"
      ? `actual NoTP+36h independent N ${primaryN}/${MIN_INDEPENDENT_EPISODES}; no intervention`
      : status === "QUARANTINED"
        ? recovery && recoveryEvaluations > 0
          ? `recovery evidence ${recoveryEvaluations}/${REQUIRED_CONSECUTIVE_EVALUATIONS}; quarantine remains until confirmed`
          : `persistent deterioration: ${deteriorating.map((window) => window.key).join(", ")}; poor peer tail/damage`
        : status === "DEGRADED"
          ? strictDeterioration
            ? `strict deterioration pending ${downgradeEvaluations}/${REQUIRED_CONSECUTIVE_EVALUATIONS}; warning only`
            : `diagnostic deterioration; warning only, selection unchanged`
          : "sufficient evidence with no persistent multi-window failure";
    return {
      evidenceFingerprint: draft.evidenceFingerprint,
      row: {
        symbol: draft.symbol,
        side: draft.side,
        status,
        diagnosticScore,
        independentN: primaryN,
        meanContribution: draft.primary.meanContribution,
        medianContribution: draft.primary.medianContribution,
        profitFactor: draft.primary.profitFactor,
        hitRate: draft.primary.hitRate,
        cvar5: draft.primary.cvar5,
        worstTail: draft.primary.worstTail,
        meanMaeR: draft.primary.meanMaeR,
        meanMfeR: draft.primary.meanMfeR,
        winnerToLoserDamageRate: draft.primary.winnerToLoserDamageRate,
        deteriorationWindows: deteriorating.map((window) => window.key),
        peerBadnessPercentile,
        tailBadnessPercentile: tailBadness,
        damageBadnessPercentile: damageBadness,
        trend: trendOf(recent),
        reason,
        windows: draft.perWindow,
        pendingDowngradeEvaluations: downgradeEvaluations,
        pendingRecoveryEvaluations: recoveryEvaluations,
      },
    };
  });
}

function emptyState(): ReliabilityState {
  return { version: 1, evaluationCycle: 0, lastEvaluationDay: null, lastEvidenceFingerprint: null, statuses: {}, latest: null, formationDecisions: [] };
}

function stableEvidenceFingerprint(episodes: readonly IndependentEpisode[]): string {
  return createHash("sha256").update(JSON.stringify(episodes.map((episode) => ({
    id: episode.id,
    closedAtMs: episode.closedAtMs,
    outcomes: episode.outcomes.map((outcome) => [outcome.symbol, outcome.side, outcome.contribution]),
  })))).digest("hex");
}

export class CrossSectionalSymbolReliabilityStore {
  private readonly file: string;
  private state: ReliabilityState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cross-sectional-symbol-reliability-v1.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const parsed = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ReliabilityState> : null;
      this.state = parsed?.version === 1
        ? {
            version: 1,
            evaluationCycle: Number.isInteger(parsed.evaluationCycle) ? parsed.evaluationCycle! : 0,
            lastEvaluationDay: typeof parsed.lastEvaluationDay === "string" ? parsed.lastEvaluationDay : null,
            lastEvidenceFingerprint: typeof parsed.lastEvidenceFingerprint === "string" ? parsed.lastEvidenceFingerprint : null,
            statuses: parsed.statuses && typeof parsed.statuses === "object" ? parsed.statuses : {},
            latest: parsed.latest ?? null,
            formationDecisions: Array.isArray(parsed.formationDecisions) ? parsed.formationDecisions : [],
          }
        : emptyState();
    } catch {
      this.state = emptyState();
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // Observability persistence must never become an execution exception. The formation path
      // handles a missing snapshot as INSUFFICIENT_DATA and leaves baseline eligibility intact.
    }
  }

  evaluate(input: { baskets: readonly ExecutorBasket[]; universe: readonly string[]; nowMs?: number }): SymbolReliabilitySnapshot {
    const nowMs = input.nowMs ?? Date.now();
    const day = nowIso(nowMs).slice(0, 10);
    const population = collectEligibleBaskets(input.baskets);
    const episodes = independentEpisodes(population.eligible);
    const fingerprint = stableEvidenceFingerprint(episodes);
    const evidenceChanged = this.state.lastEvidenceFingerprint !== fingerprint;
    const scheduled = this.state.lastEvaluationDay !== day;
    if (!evidenceChanged && !scheduled && this.state.latest) return this.state.latest;
    const evaluatedRows = compatibleStatusRows(episodes, input.universe, nowMs, this.state.statuses);
    const rows = evaluatedRows.map((evaluated) => evaluated.row);
    const statuses: Record<string, StoredStatus> = {};
    for (const evaluated of evaluatedRows) {
      const row = evaluated.row;
      statuses[keyOf(row.symbol, row.side)] = {
        status: row.status,
        downgradeEvaluations: row.pendingDowngradeEvaluations,
        recoveryEvaluations: row.pendingRecoveryEvaluations,
        evidenceFingerprint: evaluated.evidenceFingerprint,
      };
    }
    this.state.evaluationCycle += 1;
    const snapshot: SymbolReliabilitySnapshot = {
      version: SYMBOL_RELIABILITY_VERSION,
      enabled: isCrossSectionalSymbolReliabilityEnabled(),
      evidenceContract: SYMBOL_RELIABILITY_EVIDENCE_CONTRACT,
      evaluatedAt: nowIso(nowMs),
      evaluationId: `sr-v1-${this.state.evaluationCycle}-${fingerprint.slice(0, 12)}`,
      evaluationCycle: this.state.evaluationCycle,
      evidenceChanged,
      independentEpisodes: episodes.length,
      eligibleBaskets: population.eligible.length,
      excludedBaskets: population.excluded,
      minimumIndependentEpisodes: MIN_INDEPENDENT_EPISODES,
      statuses: rows,
      quarantined: rows.filter((row) => row.status === "QUARANTINED").map((row) => ({ symbol: row.symbol, side: row.side, reason: row.reason })),
      lastFormationDecision: this.state.formationDecisions.at(-1) ?? null,
    };
    this.state.statuses = statuses;
    this.state.lastEvidenceFingerprint = fingerprint;
    this.state.lastEvaluationDay = day;
    this.state.latest = snapshot;
    this.save();
    return snapshot;
  }

  recordFormationDecision(decision: SymbolReliabilityFormationDecision): void {
    this.state.formationDecisions.push(decision);
    if (this.state.formationDecisions.length > MAX_STORED_FORMATION_DECISIONS) {
      this.state.formationDecisions = this.state.formationDecisions.slice(-MAX_STORED_FORMATION_DECISIONS);
    }
    if (this.state.latest) this.state.latest = { ...this.state.latest, lastFormationDecision: decision };
    this.save();
  }

  latest(): SymbolReliabilitySnapshot | null {
    return this.state.latest;
  }
}

export function reliabilityStatusFor(
  snapshot: SymbolReliabilitySnapshot | null | undefined,
  symbol: string,
  side: SymbolReliabilitySide,
): SymbolReliabilityStatusRow | null {
  return snapshot?.statuses.find((row) => row.symbol === symbol.toUpperCase() && row.side === side) ?? null;
}

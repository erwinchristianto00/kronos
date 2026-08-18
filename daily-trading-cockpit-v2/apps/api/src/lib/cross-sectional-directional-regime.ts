/**
 * Directional companion for the cross-sectional horizon lane.
 *
 * This is deliberately a selector, not a second scanner: it only converts a
 * fresh, already-scored core scan into one of four mutually-exclusive modes.
 * Ambiguous or incomplete evidence is NO_TRADE.  It is testnet-only even when
 * the feature flag is accidentally copied to another environment.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candidate } from "@dtc/shared";
import type { CachedScanCandidates } from "./latest-scan-candidates-cache.js";
import type { SingleSymbolFreshSignal } from "./single-symbol-lane-executor.js";

export const CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID = "CROSS_SECTIONAL_DIRECTIONAL_SHORT";
export const CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID = "CROSS_SECTIONAL_DIRECTIONAL_LONG";

export type CrossSectionalDirectionalMode = "BEAR_SHORT_3" | "BULL_LONG_3" | "BALANCED_3X3" | "NO_TRADE";

export interface DirectionalRegimePick {
  symbol: string;
  direction: "LONG" | "SHORT";
  sideScore: number;
  relativeEdge: number;
  confidence: number;
  candidate: Candidate;
}

export interface CrossSectionalDirectionalDecision {
  enabled: boolean;
  mode: CrossSectionalDirectionalMode;
  marketRegime: string | null;
  scanBatchId: string | null;
  scanFinishedAt: string | null;
  longPicks: DirectionalRegimePick[];
  shortPicks: DirectionalRegimePick[];
  longAverageScore: number | null;
  shortAverageScore: number | null;
  /** Independent, broader-market confirmation. Directional entry needs this to agree with scan. */
  canonicalRegimeFamily: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
  canonicalAllowed: boolean | null;
  canonicalReason: string | null;
  reason: string;
}

export interface CanonicalDirectionalConfirmation {
  allowed: boolean;
  requireRetest: boolean;
  regimeFamily: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
  reason: string | null;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export const DIRECTIONAL_REGIME_MIN_SCORE = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MIN_SCORE", 75);
export const DIRECTIONAL_REGIME_MIN_CONFIDENCE = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MIN_CONFIDENCE", 70);
export const DIRECTIONAL_REGIME_MIN_RELATIVE_EDGE = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MIN_RELATIVE_EDGE", 8);
export const DIRECTIONAL_REGIME_DOMINANCE_GAP = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_DOMINANCE_GAP", 5);
export const DIRECTIONAL_REGIME_LEG_USD = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_LEG_USD", 25);
export const DIRECTIONAL_REGIME_LEVERAGE = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_LEVERAGE", 3);
export const DIRECTIONAL_REGIME_MAX_OPEN_POSITIONS = (): number => Math.max(1, Math.floor(envNumber("CROSS_SECTIONAL_DIRECTIONAL_MAX_OPEN_POSITIONS", 3)));
export const DIRECTIONAL_REGIME_MAX_SIGNAL_AGE_MS = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MAX_SIGNAL_AGE_MS", 15 * 60_000);
export const DIRECTIONAL_REGIME_DAILY_MAX_LOSS_USD = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_DAILY_MAX_LOSS_USD", 15);
export const DIRECTIONAL_REGIME_MFE_ARM_R = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MFE_ARM_R", 1);
export const DIRECTIONAL_REGIME_MFE_GIVEBACK_FRACTION = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MFE_GIVEBACK_FRACTION", 0.5);
export const DIRECTIONAL_REGIME_MAX_HOLD_HOURS = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MAX_HOLD_HOURS", 24);

/** A reversal is only trusted after two different completed scanner batches agree.
 * The cooldown is deliberately shared between the long and short directional
 * executors, so a close cannot be immediately replaced by a flip that only
 * harvests taker fees in a choppy market. */
export const DIRECTIONAL_REVERSAL_CONFIRMATIONS_REQUIRED = 2;
export const DIRECTIONAL_REVERSAL_REENTRY_COOLDOWN_MS = 15 * 60_000;
export const DIRECTIONAL_REVERSAL_EXIT_COOLDOWN_MS = 2 * 60 * 60_000;

export interface DirectionalReversalSymbolState {
  activeMode: "BEAR_SHORT_3" | "BULL_LONG_3" | null;
  lastInvalidatingScanBatchId: string | null;
  invalidatingScanCount: number;
  lastExitAtMs: number | null;
  reentryBlockedUntilMs: number | null;
}

export interface DirectionalReversalEvaluation {
  next: DirectionalReversalSymbolState;
  shouldExit: boolean;
  reason: string | null;
}

const freshDirectionalReversalState = (): DirectionalReversalSymbolState => ({
  activeMode: null,
  lastInvalidatingScanBatchId: null,
  invalidatingScanCount: 0,
  lastExitAtMs: null,
  reentryBlockedUntilMs: null,
});

/** Pure two-scan reversal confirmation. A missing or repeated scanner batch
 * can never add a confirmation, so executor ticks alone cannot manufacture a
 * direction flip. */
export function evaluateDirectionalReversal(
  previous: DirectionalReversalSymbolState | null | undefined,
  activeMode: "BEAR_SHORT_3" | "BULL_LONG_3",
  decision: Pick<CrossSectionalDirectionalDecision, "mode" | "scanBatchId">,
  nowMs: number,
): DirectionalReversalEvaluation {
  const next = { ...(previous ?? freshDirectionalReversalState()) };
  if (decision.mode === activeMode) {
    next.activeMode = activeMode;
    next.lastInvalidatingScanBatchId = null;
    next.invalidatingScanCount = 0;
    return { next, shouldExit: false, reason: null };
  }
  if (!decision.scanBatchId) return { next, shouldExit: false, reason: null };

  if (next.activeMode !== activeMode) {
    next.activeMode = activeMode;
    next.lastInvalidatingScanBatchId = null;
    next.invalidatingScanCount = 0;
  }
  if (next.lastInvalidatingScanBatchId !== decision.scanBatchId) {
    next.lastInvalidatingScanBatchId = decision.scanBatchId;
    next.invalidatingScanCount += 1;
  }
  if (next.invalidatingScanCount < DIRECTIONAL_REVERSAL_CONFIRMATIONS_REQUIRED) {
    return { next, shouldExit: false, reason: null };
  }
  if (next.lastExitAtMs !== null && nowMs - next.lastExitAtMs < DIRECTIONAL_REVERSAL_EXIT_COOLDOWN_MS) {
    return { next, shouldExit: false, reason: null };
  }
  return {
    next,
    shouldExit: true,
    reason: `DIRECTIONAL_REVERSAL_CONFIRMED:${decision.mode}`,
  };
}

interface DirectionalReversalPersistedState {
  version: 1;
  symbols: Record<string, DirectionalReversalSymbolState>;
}

/** Small durable coordinator shared by the directional long/short executors. */
export class DirectionalReversalStateStore {
  private readonly file: string;
  private state: DirectionalReversalPersistedState;

  constructor(dataDir: string, fileName = "cross-sectional-directional-reversal.json") {
    this.file = resolve(dataDir, fileName);
    try { mkdirSync(dirname(this.file), { recursive: true }); } catch { /* best-effort */ }
    this.state = this.load();
  }

  private load(): DirectionalReversalPersistedState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && parsed.version === 1 && parsed.symbols && typeof parsed.symbols === "object") {
          return parsed as DirectionalReversalPersistedState;
        }
      }
    } catch { /* corrupt state is safer as a fresh confirmation sequence */ }
    return { version: 1, symbols: {} };
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch { /* persistence must never interrupt a live protective exit */ }
  }

  observe(symbol: string, activeMode: "BEAR_SHORT_3" | "BULL_LONG_3", decision: Pick<CrossSectionalDirectionalDecision, "mode" | "scanBatchId">, nowMs: number): DirectionalReversalEvaluation {
    const evaluation = evaluateDirectionalReversal(this.state.symbols[symbol], activeMode, decision, nowMs);
    this.state.symbols[symbol] = evaluation.next;
    this.save();
    return evaluation;
  }

  canOpen(symbol: string, nowMs: number): boolean {
    const blockedUntil = this.state.symbols[symbol]?.reentryBlockedUntilMs;
    return !(typeof blockedUntil === "number" && nowMs < blockedUntil);
  }

  /** Call only after Binance confirms the close. Failed close attempts must stay retryable. */
  recordConfirmedReversalExit(symbol: string, nowMs: number): void {
    const current = this.state.symbols[symbol] ?? freshDirectionalReversalState();
    current.lastExitAtMs = nowMs;
    current.reentryBlockedUntilMs = nowMs + DIRECTIONAL_REVERSAL_REENTRY_COOLDOWN_MS;
    current.lastInvalidatingScanBatchId = null;
    current.invalidatingScanCount = 0;
    this.state.symbols[symbol] = current;
    this.save();
  }
}

export function isCrossSectionalDirectionalRegimeExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_BINANCE_ENV === "testnet" && env.CROSS_SECTIONAL_DIRECTIONAL_REGIME_EXEC_ENABLED === "1";
}

const strongStatuses = new Set(["READY", "TRADE_NOW"]);

function sideScore(candidate: Candidate, direction: "LONG" | "SHORT"): number {
  return direction === "LONG" ? candidate.longScore : candidate.shortScore;
}

function relativeEdge(candidate: Candidate, direction: "LONG" | "SHORT"): number {
  return direction === "LONG"
    ? candidate.longScore - candidate.shortScore
    : candidate.shortScore - candidate.longScore;
}

function validStop(candidate: Candidate, direction: "LONG" | "SHORT"): boolean {
  const entry = candidate.currentPrice;
  const stop = candidate.stopLoss;
  if (!(typeof entry === "number" && entry > 0 && typeof stop === "number" && stop > 0)) return false;
  return direction === "LONG" ? stop < entry : stop > entry;
}

function eligible(candidate: Candidate, direction: "LONG" | "SHORT"): boolean {
  return candidate.finalDirection === direction
    && strongStatuses.has(candidate.finalStatus)
    && candidate.kronosBias === direction
    && !candidate.sourceConflict
    && !candidate.directionConflict
    && !candidate.horizonConflict
    && candidate.confidence >= DIRECTIONAL_REGIME_MIN_CONFIDENCE()
    && candidate.dataQualityScore >= 70
    && candidate.liquidityScore >= 70
    && sideScore(candidate, direction) >= DIRECTIONAL_REGIME_MIN_SCORE()
    && relativeEdge(candidate, direction) >= DIRECTIONAL_REGIME_MIN_RELATIVE_EDGE()
    && validStop(candidate, direction);
}

function picks(snapshot: CachedScanCandidates, direction: "LONG" | "SHORT"): DirectionalRegimePick[] {
  return snapshot.candidates
    .filter((candidate) => eligible(candidate, direction))
    .map((candidate) => ({
      symbol: candidate.symbol,
      direction,
      sideScore: sideScore(candidate, direction),
      relativeEdge: relativeEdge(candidate, direction),
      confidence: candidate.confidence,
      candidate,
    }))
    .sort((a, b) => b.sideScore - a.sideScore || b.relativeEdge - a.relativeEdge || b.confidence - a.confidence || a.symbol.localeCompare(b.symbol))
    .slice(0, 3);
}

function average(values: DirectionalRegimePick[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value.sideScore, 0) / values.length : null;
}

function emptyDecision(reason: string): CrossSectionalDirectionalDecision {
  return {
    enabled: isCrossSectionalDirectionalRegimeExecEnabled(),
    mode: "NO_TRADE",
    marketRegime: null,
    scanBatchId: null,
    scanFinishedAt: null,
    longPicks: [],
    shortPicks: [],
    longAverageScore: null,
    shortAverageScore: null,
    canonicalRegimeFamily: "UNKNOWN",
    canonicalAllowed: null,
    canonicalReason: null,
    reason,
  };
}

/**
 * A directional mode needs exactly three independently eligible symbols.  The
 * score lead only breaks a non-explicit regime tie; an explicitly bullish scan
 * may never produce shorts, and an explicitly bearish scan may never produce
 * longs.  This makes a conflicting evidence set fail closed rather than flip
 * its direction simply because one scalar happened to be higher.
 */
export function buildCrossSectionalDirectionalRegimeDecision(
  snapshot: CachedScanCandidates | null,
): CrossSectionalDirectionalDecision {
  if (!snapshot) return emptyDecision("Belum ada scan baru; tidak membuka posisi.");

  const longPicks = picks(snapshot, "LONG");
  const shortPicks = picks(snapshot, "SHORT");
  const longAverageScore = average(longPicks);
  const shortAverageScore = average(shortPicks);
  const regime = snapshot.marketRegime.trim();
  const normalized = regime.toLowerCase();
  const explicitBear = normalized.includes("bear");
  const explicitBull = normalized.includes("bull");
  const base = {
    enabled: isCrossSectionalDirectionalRegimeExecEnabled(),
    marketRegime: regime || null,
    scanBatchId: snapshot.scanBatchId,
    scanFinishedAt: snapshot.scanFinishedAt,
    longPicks,
    shortPicks,
    longAverageScore,
    shortAverageScore,
    canonicalRegimeFamily: "UNKNOWN" as const,
    canonicalAllowed: null,
    canonicalReason: null,
  };

  if (explicitBear) {
    return shortPicks.length === 3
      ? { ...base, mode: "BEAR_SHORT_3", reason: "Regime bearish eksplisit dan tiga short lolos skor, confidence, likuiditas, serta konfirmasi Kronos." }
      : { ...base, mode: "NO_TRADE", reason: `Regime bearish, tetapi hanya ${shortPicks.length}/3 short yang lolos semua guard.` };
  }
  if (explicitBull) {
    return longPicks.length === 3
      ? { ...base, mode: "BULL_LONG_3", reason: "Regime bullish eksplisit dan tiga long lolos skor, confidence, likuiditas, serta konfirmasi Kronos." }
      : { ...base, mode: "NO_TRADE", reason: `Regime bullish, tetapi hanya ${longPicks.length}/3 long yang lolos semua guard.` };
  }
  if (longPicks.length < 3 || shortPicks.length < 3 || longAverageScore === null || shortAverageScore === null) {
    return { ...base, mode: "NO_TRADE", reason: "Regime tidak eksplisit dan bukti dua sisi belum lengkap (masing-masing perlu tiga simbol)." };
  }

  const scoreLead = longAverageScore - shortAverageScore;
  if (scoreLead >= DIRECTIONAL_REGIME_DOMINANCE_GAP()) {
    return { ...base, mode: "BULL_LONG_3", reason: `Regime netral, tetapi rata-rata long unggul ${scoreLead.toFixed(1)} poin; hanya tiga long terkuat dibuka.` };
  }
  if (scoreLead <= -DIRECTIONAL_REGIME_DOMINANCE_GAP()) {
    return { ...base, mode: "BEAR_SHORT_3", reason: `Regime netral, tetapi rata-rata short unggul ${Math.abs(scoreLead).toFixed(1)} poin; hanya tiga short terlemah relatif-model dibuka.` };
  }
  return { ...base, mode: "BALANCED_3X3", reason: "Kekuatan long dan short seimbang; basket market-neutral 3 long × 3 short boleh membuka." };
}

/**
 * The scan's 20-symbol direction count is useful breadth evidence, but cannot
 * by itself certify a directional trade. A separate canonical market-regime
 * engine must be fresh, eligible, non-transitioning, and agree on direction.
 * This makes disagreement a NO_TRADE rather than silently trusting whichever
 * producer happened to be more aggressive.
 */
export function confirmCrossSectionalDirectionalRegime(
  decision: CrossSectionalDirectionalDecision,
  canonical: CanonicalDirectionalConfirmation,
): CrossSectionalDirectionalDecision {
  const stamped = {
    ...decision,
    canonicalRegimeFamily: canonical.regimeFamily,
    canonicalAllowed: canonical.allowed,
    canonicalReason: canonical.reason,
  };
  if (!canonical.allowed) {
    return { ...stamped, mode: "NO_TRADE", reason: `Canonical regime memblokir entry: ${canonical.reason ?? "data belum layak"}.` };
  }
  if (canonical.requireRetest) {
    return { ...stamped, mode: "NO_TRADE", reason: "Canonical regime sedang transisi; menunggu retest sebelum entry directional." };
  }
  if (decision.mode === "BEAR_SHORT_3" && canonical.regimeFamily !== "BEARISH") {
    return { ...stamped, mode: "NO_TRADE", reason: `Konflik arah: scan=${decision.marketRegime ?? "UNKNOWN"}, canonical=${canonical.regimeFamily}; tidak short.` };
  }
  if (decision.mode === "BULL_LONG_3" && canonical.regimeFamily !== "BULLISH") {
    return { ...stamped, mode: "NO_TRADE", reason: `Konflik arah: scan=${decision.marketRegime ?? "UNKNOWN"}, canonical=${canonical.regimeFamily}; tidak long.` };
  }
  if (decision.mode === "BALANCED_3X3" && canonical.regimeFamily !== "MIXED") {
    return { ...stamped, mode: "NO_TRADE", reason: `Scan seimbang tetapi canonical=${canonical.regimeFamily}; tidak membuka basket netral.` };
  }
  return stamped;
}

export function crossSectionalDirectionalOpenSignals(
  snapshot: CachedScanCandidates | null,
  direction: "LONG" | "SHORT",
): SingleSymbolFreshSignal[] {
  const decision = buildCrossSectionalDirectionalRegimeDecision(snapshot);
  const allowed = direction === "LONG" ? decision.mode === "BULL_LONG_3" : decision.mode === "BEAR_SHORT_3";
  if (!allowed || !snapshot) return [];
  const openedAtMs = Date.parse(snapshot.scanFinishedAt);
  if (!Number.isFinite(openedAtMs)) return [];
  const selected = direction === "LONG" ? decision.longPicks : decision.shortPicks;
  return selected.map((pick) => ({
    observationId: `xsec-directional:${snapshot.scanBatchId}:${direction}:${pick.symbol}:${pick.candidate.candidateFingerprint.value}`,
    symbol: pick.symbol,
    entryPrice: pick.candidate.currentPrice!,
    stopPrice: pick.candidate.stopLoss!,
    openedAtMs,
  }));
}

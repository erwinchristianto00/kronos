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
  /** Independent, broader-market context. It sizes a scanner-led entry and vetoes only an opposite regime. */
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
/** Profit is locked only after a runner has first earned this estimated-net return; it is not a full TP. */
export const DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_NET_RETURN = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MFE_PROFIT_LOCK_NET_RETURN", 0.005);
/** Profit-lock in R. Default 0 = unset, so the price-denominated lock above stays in force until an
 *  operator opts in. Set it and the lock becomes scale-free: 0.5R means 0.5R on every symbol,
 *  instead of 1.15R on ETH and 0.25R on SOL as the price-% form measurably did. Keep it BELOW
 *  DIRECTIONAL_REGIME_MFE_ARM_R so the two mechanisms tile rather than shadow each other — the lock
 *  catches peaks between itself and the arm, the giveback trails everything above the arm. */
export const DIRECTIONAL_REGIME_MFE_PROFIT_LOCK_R = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MFE_PROFIT_LOCK_R", 0);
/** Floor on how far the stop sits from entry, as a PERCENT of entry. 0 = off (scanner stop used
 *  verbatim, the behaviour every deployment had before 2026-08-16).
 *
 *  A FLOOR, not a multiplier, and that choice is the whole point. Commission is a fixed 8 bps round
 *  trip while 1R is the stop distance, so the fee's share of risk is 8bps/stopWidth — measured
 *  0.170R at the tightest scanner stop seen (0.47%) against 0.040R at 2%. A multiplier would also
 *  inflate the stops that are already wide enough, adding risk where there was no problem; a floor
 *  touches only the tight ones, which are exactly the ones where the fee is eating the trade.
 *
 *  RAISING THIS RAISES DOLLAR RISK unless the leg shrinks with it: this lane sizes by NOTIONAL
 *  (CROSS_SECTIONAL_DIRECTIONAL_LEG_USD), not by risk, so a 2x wider stop is a 2x bigger loss when
 *  it hits. Halve the leg when you double the floor and dollar risk is unchanged while the fee's
 *  share halves — that is the only version of this change that is free. */
export const DIRECTIONAL_REGIME_MIN_STOP_PCT = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MIN_STOP_PCT", 0);

/**
 * The stop this lane will actually use: the scanner's own, unless it sits closer than `minStopPct`.
 *
 * Only ever moves the stop FURTHER from entry, so a stop that was on the correct side stays on it
 * and validStop() cannot be broken by widening. Returns the scanner value untouched when the floor
 * is off, unusable, or already satisfied — no rounding, no drift, byte-identical to the old path.
 *
 * KNOWN SIDE EFFECT, not a bug and not avoidable: two entry gates in single-symbol-lane-executor.ts
 * measure drift in R against this same distance — the entry-chase limit and the stop-crossed
 * invalidation. A wider stop makes both more permissive, so widening admits trades that used to be
 * refused. The stop-width sweep that motivated this held entries FIXED and therefore says nothing
 * about those extra trades.
 */
export function effectiveDirectionalStop(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  scannerStop: number,
  minStopPct: number,
): number {
  const ok = (v: number) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!ok(entryPrice) || !ok(scannerStop) || !ok(minStopPct)) return scannerStop;
  const floor = entryPrice * (minStopPct / 100);
  return direction === "LONG"
    ? Math.min(scannerStop, entryPrice - floor)
    : Math.max(scannerStop, entryPrice + floor);
}
/** Ceiling for any future static default TP. The active directional policy remains MFE-managed. */
export const DIRECTIONAL_REGIME_STATIC_TP_MAX_NET_RETURN = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_STATIC_TP_MAX_NET_RETURN", 0.0065);
export const DIRECTIONAL_REGIME_MAX_HOLD_HOURS = (): number => envNumber("CROSS_SECTIONAL_DIRECTIONAL_MAX_HOLD_HOURS", 24);

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

/**
 * A protective directional exit is reserved for a confirmed *opposite* direction.
 *
 * NO_TRADE and BALANCED_3X3 deliberately stop new directional entries, but they are
 * not evidence that an already-open directional thesis reversed. Treating either as
 * a reversal made a temporary lack of candidates manufacture a close (and therefore
 * repeated fee churn) after two scanner batches. A repeated executor tick can never
 * manufacture a confirmation either.
 */
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
  const oppositeMode = activeMode === "BEAR_SHORT_3" ? "BULL_LONG_3" : "BEAR_SHORT_3";
  if (decision.mode !== oppositeMode) {
    // A neutral/missing/balanced decision blocks only fresh entries. It must also
    // break an in-progress opposite-direction confirmation sequence so the two
    // confirming scans are genuinely consecutive directional evidence.
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
  return { next, shouldExit: true, reason: `DIRECTIONAL_REVERSAL_CONFIRMED:${oppositeMode}` };
}

interface DirectionalReversalPersistedState {
  version: 1;
  symbols: Record<string, DirectionalReversalSymbolState>;
}

/** Durable and shared between the long and short directional executors. */
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
        if (parsed && parsed.version === 1 && parsed.symbols && typeof parsed.symbols === "object") return parsed as DirectionalReversalPersistedState;
      }
    } catch { /* corrupt state starts a fresh confirmation sequence */ }
    return { version: 1, symbols: {} };
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch { /* persistence never interrupts a protective exit */ }
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

  /** Only call after Binance confirms the close; failed close attempts stay retryable. */
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

/**
 * Explicit scanner regimes are a directional signal in their own right.  The
 * per-symbol `finalStatus` can be WAIT for a non-directional reason even
 * while breadth is explicit. This does NOT license an execution bypass: a
 * direction/source conflict or a research/data-collection route remains a
 * hard reject. The fallback exists only for a clean, profit-routable scanner
 * candidate, never as a way to trade through a warning the scanner emitted.
 */
function scannerLedEligible(candidate: Candidate, direction: "LONG" | "SHORT"): boolean {
  const plan = candidate.selectedExecutionPlan;
  return candidate.finalDirection === direction
    && candidate.direction === direction
    && !candidate.sourceConflict
    && !candidate.directionConflict
    && !candidate.horizonConflict
    && plan?.routeMode === "PROFIT_CANDIDATE"
    && plan.primaryProfitEligible === true
    && candidate.confidence >= DIRECTIONAL_REGIME_MIN_CONFIDENCE()
    && candidate.dataQualityScore >= 70
    && candidate.liquidityScore >= 70
    && sideScore(candidate, direction) >= DIRECTIONAL_REGIME_MIN_SCORE()
    && relativeEdge(candidate, direction) >= DIRECTIONAL_REGIME_MIN_RELATIVE_EDGE()
    && validStop(candidate, direction);
}

function picks(
  snapshot: CachedScanCandidates,
  direction: "LONG" | "SHORT",
  allowScannerLedFallback = false,
  excludedSymbols: ReadonlySet<string> = new Set(),
): DirectionalRegimePick[] {
  return snapshot.candidates
    .filter((candidate) =>
      !excludedSymbols.has(candidate.symbol) &&
      (eligible(candidate, direction) || (allowScannerLedFallback && scannerLedEligible(candidate, direction))),
    )
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
 * A directional mode needs one to three independently eligible symbols. The
 * score lead only breaks a non-explicit regime tie; an explicitly bullish scan
 * may never produce shorts, and an explicitly bearish scan may never produce
 * longs.  This makes a conflicting evidence set fail closed rather than flip
 * its direction simply because one scalar happened to be higher.
 */
export function buildCrossSectionalDirectionalRegimeDecision(
  snapshot: CachedScanCandidates | null,
  opts: {
    /** Legacy all-direction exclusion. Prefer the side-specific sets below. */
    excludedSymbols?: ReadonlySet<string>;
    /** Basket shorts: a directional long here would net/reverse one-way exposure. */
    excludedLongSymbols?: ReadonlySet<string>;
    /** Basket longs: a directional short here would net/reverse one-way exposure. */
    excludedShortSymbols?: ReadonlySet<string>;
  } = {},
): CrossSectionalDirectionalDecision {
  if (!snapshot) return emptyDecision("Belum ada scan baru; tidak membuka posisi.");

  const regime = snapshot.marketRegime.trim();
  const normalized = regime.toLowerCase();
  const explicitBear = normalized.includes("bear");
  const explicitBull = normalized.includes("bull");
  // A one-way account can never admit the direction opposite to a live basket
  // leg. Same-direction ownership stays visible: the executor then verifies
  // the basket leg is net-positive after close cost before adding exposure.
  const excludedSymbols = opts.excludedSymbols ?? new Set<string>();
  const excludedLongSymbolsSet = opts.excludedLongSymbols ?? excludedSymbols;
  const excludedShortSymbolsSet = opts.excludedShortSymbols ?? excludedSymbols;
  const longPicks = picks(snapshot, "LONG", explicitBull, excludedLongSymbolsSet);
  const shortPicks = picks(snapshot, "SHORT", explicitBear, excludedShortSymbolsSet);
  const excludedLongSymbols = explicitBull
    ? snapshot.candidates
      .filter((candidate) => excludedLongSymbolsSet.has(candidate.symbol) &&
        (eligible(candidate, "LONG") || scannerLedEligible(candidate, "LONG")))
      .map((candidate) => candidate.symbol)
      .sort()
    : [];
  const excludedShortSymbols = explicitBear
    ? snapshot.candidates
      .filter((candidate) => excludedShortSymbolsSet.has(candidate.symbol) &&
        (eligible(candidate, "SHORT") || scannerLedEligible(candidate, "SHORT")))
      .map((candidate) => candidate.symbol)
      .sort()
    : [];
  const longAverageScore = average(longPicks);
  const shortAverageScore = average(shortPicks);
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
    return shortPicks.length >= 1
      ? { ...base, mode: "BEAR_SHORT_3", reason: `Regime bearish eksplisit dan ${shortPicks.length} short lolos skor, confidence, likuiditas, serta konfirmasi Kronos.` }
      : { ...base, mode: "NO_TRADE", reason: excludedShortSymbols.length
        ? `Regime bearish, tetapi kandidat short yang lolos sedang dipakai basket (${excludedShortSymbols.join(", ")}); tidak boleh netting/reverse posisi hedge. Menunggu kandidat short bebas.`
        : `Regime bearish, tetapi hanya ${shortPicks.length}/3 short yang lolos semua guard.` };
  }
  if (explicitBull) {
    return longPicks.length >= 1
      ? { ...base, mode: "BULL_LONG_3", reason: `Regime bullish eksplisit dan ${longPicks.length} long lolos skor, confidence, likuiditas, serta konfirmasi Kronos.` }
      : { ...base, mode: "NO_TRADE", reason: excludedLongSymbols.length
        ? `Regime bullish, tetapi kandidat long yang lolos sedang dipakai basket (${excludedLongSymbols.join(", ")}); tidak boleh netting/reverse posisi hedge. Menunggu kandidat long bebas.`
        : `Regime bullish, tetapi hanya ${longPicks.length}/3 long yang lolos semua guard.` };
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
 * by itself determine size. Canonical market regime remains fresh and eligible,
 * but an explicitly scanner-led direction may take at most two reduced slots
 * while canonical is MIXED. Only an opposite canonical regime vetoes entry.
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
  if (decision.mode === "BEAR_SHORT_3" && canonical.regimeFamily === "BULLISH") {
    return { ...stamped, mode: "NO_TRADE", reason: `Konflik arah: scan=${decision.marketRegime ?? "UNKNOWN"}, canonical=${canonical.regimeFamily}; tidak short.` };
  }
  if (decision.mode === "BULL_LONG_3" && canonical.regimeFamily === "BEARISH") {
    return { ...stamped, mode: "NO_TRADE", reason: `Konflik arah: scan=${decision.marketRegime ?? "UNKNOWN"}, canonical=${canonical.regimeFamily}; tidak long.` };
  }
  if (decision.mode === "BEAR_SHORT_3" && canonical.regimeFamily === "MIXED") {
    const shortPicks = decision.shortPicks.slice(0, 2);
    return {
      ...stamped,
      shortPicks,
      longPicks: [],
      shortAverageScore: average(shortPicks),
      longAverageScore: null,
      reason: `Scanner bearish eksplisit; canonical MIXED membatasi eksekusi menjadi ${shortPicks.length} short dengan sizing tereduksi.`,
    };
  }
  if (decision.mode === "BULL_LONG_3" && canonical.regimeFamily === "MIXED") {
    const longPicks = decision.longPicks.slice(0, 2);
    return {
      ...stamped,
      longPicks,
      shortPicks: [],
      longAverageScore: average(longPicks),
      shortAverageScore: null,
      reason: `Scanner bullish eksplisit; canonical MIXED membatasi eksekusi menjadi ${longPicks.length} long dengan sizing tereduksi.`,
    };
  }
  if (decision.mode === "BALANCED_3X3" && canonical.regimeFamily !== "MIXED") {
    return { ...stamped, mode: "NO_TRADE", reason: `Scan seimbang tetapi canonical=${canonical.regimeFamily}; tidak membuka basket netral.` };
  }
  return stamped;
}

export function crossSectionalDirectionalOpenSignals(
  snapshot: CachedScanCandidates | null,
  direction: "LONG" | "SHORT",
  confirmedDecision: CrossSectionalDirectionalDecision | null = null,
): SingleSymbolFreshSignal[] {
  const decision = confirmedDecision ?? buildCrossSectionalDirectionalRegimeDecision(snapshot);
  const allowed = direction === "LONG" ? decision.mode === "BULL_LONG_3" : decision.mode === "BEAR_SHORT_3";
  if (!allowed || !snapshot) return [];
  const openedAtMs = Date.parse(snapshot.scanFinishedAt);
  if (!Number.isFinite(openedAtMs)) return [];
  const selected = direction === "LONG" ? decision.longPicks : decision.shortPicks;
  return selected.map((pick) => ({
    observationId: `xsec-directional:${snapshot.scanBatchId}:${direction}:${pick.symbol}:${pick.candidate.candidateFingerprint.value}`,
    symbol: pick.symbol,
    entryPrice: pick.candidate.currentPrice!,
    stopPrice: effectiveDirectionalStop(
      direction,
      pick.candidate.currentPrice!,
      pick.candidate.stopLoss!,
      DIRECTIONAL_REGIME_MIN_STOP_PCT(),
    ),
    openedAtMs,
  }));
}

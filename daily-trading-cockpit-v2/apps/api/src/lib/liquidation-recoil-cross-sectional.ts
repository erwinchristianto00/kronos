/**
 * LIQUIDATION RECOIL — CROSS-SECTIONAL extension (report-only measurement lane).
 *
 * panic-washout-reclaim-edge.ts ("PWR") already measures/executes the SINGLE-SYMBOL version of this
 * edge: PANIC bar -> RSI WASHOUT -> RECLAIM, on 6 majors, one symbol at a time. Per the 2026-07-10
 * engineering audit, this codebase has NOTHING that correlates panic events ACROSS symbols — a
 * genuine market-wide liquidation cascade (many symbols flushing together) is architecturally
 * invisible to every existing lane, including PWR itself (which only ever looks at one symbol's own
 * candles). This module is that missing cross-sectional layer:
 *
 *  1. BROAD EVENT DETECTION: run PWR's own PANIC+WASHOUT gate (stages 1-2 of its 3-stage detector,
 *     reused via its exported constants/building blocks below) across a WIDE universe
 *     (cross-sectional-edge.ts's CROSS_SECTIONAL_UNIVERSE, 26 symbols, not PWR_UNIVERSE's 6 majors).
 *     When >= LRX_MIN_PANIC_SYMBOLS symbols show a qualifying panic+washout bar within a shared
 *     LRX_EVENT_WINDOW_BARS-bar window, that cluster is classified as ONE broad liquidation event
 *     with its own eventId/eventStart/eventEnd (see detectBroadLiquidationEvent).
 *  2. PER-SYMBOL RECLAIM-STRENGTH SCORING: for every symbol inside a broad event, score how much of
 *     its OWN panic move has retraced, and how fast, over the following LRX_RETRACE_WINDOW_BARS bars
 *     (see computeReclaimStrength's doc comment for the exact formula). Rank symbols within the event
 *     by this score.
 *  3. SIGNAL GENERATION: the top LRX_TOP_K ranked symbols (fastest/strongest reclaim), gated by
 *     LRX_MIN_RECLAIM_STRENGTH (being merely "the best of a bad bunch" doesn't qualify) and by the
 *     SAME crowding UNWINDING confirmation PWR uses (reused directly, not reimplemented), become LONG
 *     candidates. Entry/stop geometry reuses PWR's own buildPanicWashoutGeometry — same wide-stop
 *     below-the-panic-low construction, same floor/ceiling.
 *
 *     BOTTOM-ranked ("failed to reclaim") symbols are NOT turned into a short signal here. A
 *     continuation/breakdown short is a different thesis than "low reclaimStrength" — it would need
 *     its own confirmation (e.g. still making lower lows, no bounce attempt, crowding still building
 *     on the short side) that this module does not measure and this codebase has not researched yet.
 *     Forcing a short off reclaim-quality alone would be exactly the kind of zero-measurement
 *     over-reach this repo's own conventions warn against. Documented follow-up, not built: a
 *     dedicated "failed-reclaim continuation short" measurement lane, symmetric to this one, once/if
 *     the operator wants to invest in that separate thesis.
 *  4. RESOLUTION: honest forward-candle walk (no lookahead — see resolveLiquidationRecoilXsObservation),
 *     MFE-giveback exit (same proven shape as PWR/intraday-momentum-edge), cost model derived from
 *     shadow-engine.ts's REALISTIC_FEE_BPS_PER_SIDE/REALISTIC_SLIPPAGE_BPS_PER_SIDE (imported, not
 *     re-guessed) rather than PWR's own private un-exported netOf().
 *
 * Pure measurement: records and resolves observations, exposes a report. NOTHING executes — no
 * route, no ticker wiring, no allocation. A separate task wires the report route afterward; see this
 * module's exported store getter / cycle runner / report builder for that wiring.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import { computeATR, computeRSI, computeSMA } from "./candle-indicators.js";
import { fetchCrowdingSnapshot, type CrowdingSnapshot } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import {
  PWR_ATR_PERIOD,
  PWR_PANIC_ATR_MULT,
  PWR_RSI_PERIOD,
  PWR_VOLUME_MA_PERIOD,
  PWR_PANIC_VOLUME_MULT,
  PWR_WASHOUT_RSI_MAX,
  buildPanicWashoutGeometry,
  passesPanicWashoutCrowdingGate,
} from "./panic-washout-reclaim-edge.js";
import { CROSS_SECTIONAL_UNIVERSE } from "./cross-sectional-edge.js";
import { REALISTIC_FEE_BPS_PER_SIDE, REALISTIC_SLIPPAGE_BPS_PER_SIDE } from "./shadow-engine.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "6h": 6 * 3_600_000,
  "1d": 24 * 3_600_000,
};

export const LRX_INTERVAL = process.env.LIQUIDATION_RECOIL_XS_INTERVAL || "1h";
const LRX_BAR_MS = INTERVAL_MS[LRX_INTERVAL] ?? INTERVAL_MS["1h"]!;

/** Broad universe — deliberately reuses cross-sectional-edge.ts's CROSS_SECTIONAL_UNIVERSE (26
 *  liquid symbols spanning majors/L1/L2/DeFi/meme clusters) rather than PWR_UNIVERSE's 6 majors: a
 *  "market-wide" cascade needs a wide net to correlate ACROSS, which is the entire point of this
 *  module. Its own env var so it can be tuned independently of both PWR and the basket lane. */
export const LRX_UNIVERSE: readonly string[] = (
  process.env.LIQUIDATION_RECOIL_XS_UNIVERSE ?? CROSS_SECTIONAL_UNIVERSE.join(",")
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** How far back (bars) to search, per symbol, for a still-fresh panic+washout bar — mirrors
 *  PWR_LOOKBACK_BARS's role in the single-symbol lane. */
export const LRX_LOOKBACK_BARS = envNum("LIQUIDATION_RECOIL_XS_LOOKBACK_BARS", 10);

/** "Within a short time window" (spec) operationalized as a handful of candles — at the default 1h
 *  interval, 3 bars = a 3h window. A genuine cascade clusters tightly; this is NOT "sometime this
 *  week". Env-tunable. */
export const LRX_EVENT_WINDOW_BARS = envNum("LIQUIDATION_RECOIL_XS_EVENT_WINDOW_BARS", 3);

/** Minimum distinct symbols panicking within the event window to call it a BROAD (market-wide) event
 *  rather than an isolated single-symbol blowoff (already covered by PWR itself). Documented example
 *  threshold from the spec. */
export const LRX_MIN_PANIC_SYMBOLS = envNum("LIQUIDATION_RECOIL_XS_MIN_PANIC_SYMBOLS", 4);

/** How many forward bars (after EACH symbol's own panic bar) to measure reclaim strength over. */
export const LRX_RETRACE_WINDOW_BARS = envNum("LIQUIDATION_RECOIL_XS_RETRACE_WINDOW_BARS", 12);

/** Weight of the "how fast" component in reclaimStrength — see computeReclaimStrength's doc comment. */
export const LRX_SPEED_WEIGHT = Number(process.env.LIQUIDATION_RECOIL_XS_SPEED_WEIGHT) || 0.5;

/** Top-K fastest/strongest reclaimers within a broad event become LONG candidates. */
export const LRX_TOP_K = envNum("LIQUIDATION_RECOIL_XS_TOP_K", 3);

/** A candidate must clear this reclaimStrength floor to qualify at all — being rank 1 among symbols
 *  that ALL failed to bounce is not a real reclaim signal. */
export const LRX_MIN_RECLAIM_STRENGTH = Number(process.env.LIQUIDATION_RECOIL_XS_MIN_RECLAIM_STRENGTH) || 0.4;

/** Same proven MFE-giveback exit shape as PWR/intraday-momentum-edge, own env-tunable knobs (this
 *  repo's established convention: every lane owns its own exit knobs even when the default values
 *  match a proven sibling). */
export const LRX_MFE_ARM_R = Number(process.env.LIQUIDATION_RECOIL_XS_MFE_ARM_R) || 0.75;
export const LRX_MFE_GIVEBACK_FRAC = Number(process.env.LIQUIDATION_RECOIL_XS_MFE_GIVEBACK_FRAC) || 0.5;
export const LRX_MAX_HOLD_BARS = envNum("LIQUIDATION_RECOIL_XS_MAX_HOLD_BARS", 48);

/** 2026-07-11 fix: bounded retention, matching residual-momentum-edge.ts's identical convention —
 *  every OPEN observation is kept (it must stay resolvable), plus at most this many settled
 *  (non-OPEN) ones, oldest dropped first. This store had no cap at all before (push/save with no
 *  prune step), the same unbounded-growth class already root-caused and fixed elsewhere this
 *  session, and runs on a live 7-min scan ticker in production. */
export const LRX_MAX_STORED_OBSERVATIONS = envNum("LIQUIDATION_RECOIL_XS_MAX_STORED_OBSERVATIONS", 500);

export const LRX_PAPER_LANE_ID = "LIQUIDATION_RECOIL_CROSS_SECTIONAL_LONG" as const;

// ── cost model ───────────────────────────────────────────────────────────────
// Derived from shadow-engine.ts's REALISTIC_* constants (imported, not re-guessed) rather than
// repeating PWR/short-fade/regime-composite/composite-estimator's own private un-exported magic
// numbers (each of those independently hardcodes ~8bps roundtrip + ~5bps stop-out slippage) — same
// shape (round-trip taker fee + extra adverse slippage on a stop-out), traceable constants.
const TAKER_ROUNDTRIP_BPS = REALISTIC_FEE_BPS_PER_SIDE * 2; // fee in + fee out
const STOP_OUT_SLIPPAGE_BPS = REALISTIC_SLIPPAGE_BPS_PER_SIDE; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

// ── stage 1+2: per-symbol panic+washout bar (reused from PWR, without requiring stage-3 reclaim) ──

export interface LrxPanicWashoutBar {
  /** Index of the qualifying bar within the candles array passed in. */
  index: number;
  openTime: number;
  open: number;
  high: number;
  low: number;
  rsiAtWashout: number;
  /** Bars between the qualifying panic bar and the LAST (most recent/closed) candle in the array. */
  barsSincePanic: number;
}

/**
 * Per-symbol PANIC + WASHOUT detector — stages 1-2 of panic-washout-reclaim-edge.ts's 3-stage gate,
 * deliberately WITHOUT stage 3 (reclaim): this module RANKS reclaim quality across symbols instead of
 * gating on it, so it must see a symbol whether or not it has reclaimed yet. Reuses PWR's own exported
 * thresholds (PWR_ATR_PERIOD/PWR_PANIC_ATR_MULT/PWR_VOLUME_MA_PERIOD/PWR_PANIC_VOLUME_MULT/
 * PWR_RSI_PERIOD/PWR_WASHOUT_RSI_MAX — imported directly, never redefined) and the same
 * computeATR/computeSMA/computeRSI building blocks PWR itself uses. detectPanicWashoutSignal from
 * that module can't be called directly for this purpose: it REQUIRES the last bar to BE the reclaim
 * bar, and its dedup rule discards a panic bar once any EARLIER bar already reclaimed it — both wrong
 * here, where we want the panic bar whether reclaim has started or not.
 *
 * Searches back up to `lookbackBars` bars from the last candle (inclusive of the last bar itself) for
 * the MOST RECENT bar that clears the panic gate AND has an RSI washout confirmation at or after it,
 * looking only as far forward as the last candle in the array ("now") — no lookahead.
 */
export function findRecentPanicWashoutBar(candles: Candle[], lookbackBars: number = LRX_LOOKBACK_BARS): LrxPanicWashoutBar | null {
  const need = Math.max(PWR_ATR_PERIOD, PWR_VOLUME_MA_PERIOD, PWR_RSI_PERIOD) + 2;
  if (candles.length < need) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const atr = computeATR(candles, PWR_ATR_PERIOD);
  const volSma = computeSMA(volumes, PWR_VOLUME_MA_PERIOD);
  const rsi = computeRSI(closes, PWR_RSI_PERIOD);
  const lastIdx = candles.length - 1;

  for (let back = 0; back <= lookbackBars; back++) {
    const idx = lastIdx - back;
    if (idx < 0) break;
    const bar = candles[idx]!;
    const barAtr = atr[idx];
    const barVolSma = volSma[idx];
    if (!finite(barAtr) || !finite(barVolSma) || !(barAtr > 0) || !(barVolSma > 0)) continue;

    const isDownBar = bar.close < bar.open;
    const range = Math.abs(bar.close - bar.open);
    const isPanic = isDownBar && range >= PWR_PANIC_ATR_MULT * barAtr && bar.volume >= PWR_PANIC_VOLUME_MULT * barVolSma;
    if (!isPanic) continue;

    let washoutRsi: number | null = finite(rsi[idx]) && (rsi[idx] as number) < PWR_WASHOUT_RSI_MAX ? (rsi[idx] as number) : null;
    if (washoutRsi === null) {
      for (let j = idx + 1; j <= lastIdx; j++) {
        const r = rsi[j];
        if (finite(r) && r < PWR_WASHOUT_RSI_MAX) {
          washoutRsi = r;
          break;
        }
      }
    }
    if (washoutRsi === null) continue;

    return { index: idx, openTime: bar.openTime, open: bar.open, high: bar.high, low: bar.low, rsiAtWashout: washoutRsi, barsSincePanic: back };
  }
  return null;
}

// ── broad-event clustering ───────────────────────────────────────────────────

export interface LrxPanicCandidate {
  symbol: string;
  panicBar: LrxPanicWashoutBar;
}

export interface BroadLiquidationEvent {
  eventId: string;
  eventStart: number; // ms — earliest panic bar openTime among the clustered symbols
  eventEnd: number; // ms — latest panic bar openTime among the clustered symbols
  /** Only the candidates that fall INSIDE the winning cluster window — symbols that panicked too far
   *  apart in time from the cluster are excluded from this event even if they panicked recently. */
  panicked: LrxPanicCandidate[];
}

/**
 * Clusters per-symbol panic+washout bars into a single "broad liquidation event" when >= minSymbols
 * of them occurred within a shared window of each other.
 *
 * Algorithm ("within a short time window", operationalized): sort all candidates by panic-bar
 * openTime. For every candidate's timestamp used as a window start, count how many candidates
 * (including itself) have a panic-bar openTime inside [start, start + windowMs]. Take the window with
 * the LARGEST membership count (deterministic tie-break: earliest start wins). If that count clears
 * minSymbols, THAT cluster is the broad event; eventStart/eventEnd = min/max openTime inside it.
 * Symbols whose panic bar sits outside the winning window are not part of this event, even if every
 * one of them individually panicked "recently" — a genuine cascade is a tight cluster, not a loose
 * scatter across the whole lookback range.
 */
export function detectBroadLiquidationEvent(
  candidates: readonly LrxPanicCandidate[],
  opts: { minSymbols?: number; windowBars?: number; barMs?: number } = {},
): BroadLiquidationEvent | null {
  const minSymbols = opts.minSymbols ?? LRX_MIN_PANIC_SYMBOLS;
  const barMs = opts.barMs ?? LRX_BAR_MS;
  const windowMs = (opts.windowBars ?? LRX_EVENT_WINDOW_BARS) * barMs;
  if (candidates.length < minSymbols) return null;

  const sorted = [...candidates].sort((a, b) => a.panicBar.openTime - b.panicBar.openTime);
  let best: LrxPanicCandidate[] = [];
  for (const anchor of sorted) {
    const start = anchor.panicBar.openTime;
    const members = sorted.filter((c) => c.panicBar.openTime >= start && c.panicBar.openTime <= start + windowMs);
    if (members.length > best.length) best = members;
  }
  if (best.length < minSymbols) return null;

  const eventStart = best[0]!.panicBar.openTime;
  const eventEnd = best[best.length - 1]!.panicBar.openTime;
  const eventId = `lrx:${eventStart}:${eventEnd}:${best.length}`;
  return { eventId, eventStart, eventEnd, panicked: best };
}

// ── per-symbol reclaim-strength scoring ──────────────────────────────────────

export interface ReclaimStrengthResult {
  /** (evalClose - panicBar.low) / (panicBar.open - panicBar.low). 0 = still at the panic low, 1 =
   *  fully back to the pre-panic open, >1 = overshot above it, <0 = made a new low below the panic
   *  bar's low. */
  retracedFraction: number;
  /** 1-based bar index (among the forward candles evaluated) of the first candle whose CLOSE reached
   *  the 50%-retracement level; null if the evaluated window never got there. */
  timeToHalfRetraceBars: number | null;
  /** How many forward candles were actually evaluated (<= windowBars; can be less if not enough time
   *  has passed yet — no lookahead). */
  barsEvaluated: number;
  /** retracedFraction + LRX_SPEED_WEIGHT * speedComponent (see doc comment on computeReclaimStrength
   *  below for the full formula). Higher = faster/stronger reclaim. */
  reclaimStrength: number;
}

/**
 * Reclaim-strength formula (documented explicitly, per spec):
 *
 *   retraceRange = panicBar.open - panicBar.low        (the panic bar's own down move)
 *   halfLevel    = panicBar.low + 0.5 * retraceRange
 *   evaluated    = forwardCandles, capped to the first `windowBars` entries
 *   evalClose    = evaluated[last].close                (price "as of now", or as of the window's end)
 *   retracedFraction = (evalClose - panicBar.low) / retraceRange
 *   timeToHalfRetraceBars = the (1-based) index of the FIRST evaluated candle whose CLOSE >= halfLevel;
 *                           null if none does within the window
 *   speedComponent = timeToHalfRetraceBars == null
 *                       ? 0
 *                       : (windowBars - timeToHalfRetraceBars + 1) / windowBars
 *                     (1.0 if the half-retrace happened on the very first bar, shrinking toward
 *                      ~1/windowBars if it only just made it inside the window, 0 if it never did)
 *   reclaimStrength = retracedFraction + LRX_SPEED_WEIGHT * speedComponent
 *
 * Both terms reward "reclaimed more, and faster": a symbol fully retracing on bar 1 scores highest: a
 * symbol barely limping to a partial retrace by the window's end scores near its bare retracedFraction
 * with almost no speed bonus; a symbol making new lows scores negative.
 *
 * No lookahead: this function itself only ever reads the first `windowBars` candles it is GIVEN — the
 * caller is responsible for only ever passing candles with openTime <= "now" (closed bars). Passing
 * fewer than windowBars candles (because not enough time has passed since the panic bar yet) is
 * handled honestly: barsEvaluated reflects however many were actually available.
 */
export function computeReclaimStrength(
  panicBar: { open: number; low: number },
  forwardCandles: readonly Candle[],
  windowBars: number = LRX_RETRACE_WINDOW_BARS,
): ReclaimStrengthResult | null {
  const retraceRange = panicBar.open - panicBar.low;
  if (!(retraceRange > 0)) return null;
  const evaluated = forwardCandles.slice(0, windowBars);
  if (evaluated.length === 0) return null;

  const halfLevel = panicBar.low + 0.5 * retraceRange;
  let timeToHalfRetraceBars: number | null = null;
  for (let i = 0; i < evaluated.length; i++) {
    if (evaluated[i]!.close >= halfLevel) {
      timeToHalfRetraceBars = i + 1;
      break;
    }
  }
  const evalClose = evaluated[evaluated.length - 1]!.close;
  const retracedFraction = (evalClose - panicBar.low) / retraceRange;
  const speedComponent = timeToHalfRetraceBars == null ? 0 : (windowBars - timeToHalfRetraceBars + 1) / windowBars;
  const reclaimStrength = retracedFraction + LRX_SPEED_WEIGHT * speedComponent;
  return { retracedFraction, timeToHalfRetraceBars, barsEvaluated: evaluated.length, reclaimStrength };
}

// ── observation ───────────────────────────────────────────────────────────────

export interface LiquidationRecoilXsObservation {
  observationId: string;
  symbol: string;
  direction: "LONG";
  eventId: string;
  eventStart: string;
  eventStartMs: number;
  eventEnd: string;
  eventEndMs: number;
  /** How many symbols were part of the broad event this candidate belongs to. */
  panickedSymbolCount: number;
  /** 1-based rank within the event by reclaimStrength (1 = strongest/fastest). */
  rank: number;
  reclaimStrength: number;
  retracedFraction: number;
  timeToHalfRetraceBars: number | null;
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  panicBarHigh: number;
  panicBarLow: number;
  rsiAtWashout: number;
  fundingBps: number | null;
  oiChangePercent: number | null;
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  maxFavorableR: number | null;
  exitReason: "MFE_GIVEBACK" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs with the same MFE-giveback
 * exit shape as panic-washout-reclaim-edge.ts / intraday-momentum-edge.ts: stop first (conservative),
 * track peak favorableR from bar highs, arm once peak >= LRX_MFE_ARM_R, bank once a later close gives
 * back LRX_MFE_GIVEBACK_FRAC of the peak, else mark-to-market at LRX_MAX_HOLD_BARS. No lookahead: only
 * candles strictly after obs.openedAtMs are considered, walked in chronological order, and resolution
 * stops at the FIRST bar that qualifies (stop touch / giveback / max-hold) — never at a more favorable
 * later bar.
 */
export function resolveLiquidationRecoilXsObservation(
  obs: LiquidationRecoilXsObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<LiquidationRecoilXsObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<LiquidationRecoilXsObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<LiquidationRecoilXsObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return {
      status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR,
      costR,
      netR,
      exitReason,
      maxFavorableR,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };

  let peakR = 0;
  let armed = false;
  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i]!;
    if (c.low <= obs.initialStop) {
      const grossR = (obs.initialStop - obs.entryPrice) / risk; // = -1
      return finalize(grossR, c.openTime, "INITIAL_STOP", peakR);
    }
    const barPeakR = (c.high - obs.entryPrice) / risk;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= LRX_MFE_ARM_R) armed = true;
    if (armed) {
      const closeR = (c.close - obs.entryPrice) / risk;
      const givebackLine = peakR * (1 - LRX_MFE_GIVEBACK_FRAC);
      if (closeR <= givebackLine) {
        return finalize(closeR, c.openTime, "MFE_GIVEBACK", peakR);
      }
    }
    if (i + 1 >= LRX_MAX_HOLD_BARS) {
      const grossR = (c.close - obs.entryPrice) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM", peakR);
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > LRX_MAX_HOLD_BARS * LRX_BAR_MS * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────────

export interface LrxCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  broadEventsDetectedTotal: number;
  panicCandidatesTotal: number;
  reclaimCandidatesTotal: number;
  crowdingRejectedTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: LrxCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  broadEventsDetectedTotal: 0,
  panicCandidatesTotal: 0,
  reclaimCandidatesTotal: 0,
  crowdingRejectedTotal: 0,
  recordedTotal: 0,
  lastCycleError: null,
};

interface LrxState {
  version: number;
  observations: LiquidationRecoilXsObservation[];
  cycleMeta?: LrxCycleMeta;
}

export class LiquidationRecoilXsStore {
  private state: LrxState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<LrxState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as LiquidationRecoilXsObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt -> start empty */
      }
    }
  }
  get all(): LiquidationRecoilXsObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): LrxCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: LrxCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.broadEventsDetectedTotal += result.broadEventsDetected;
      meta.panicCandidatesTotal += result.panicCandidates;
      meta.reclaimCandidatesTotal += result.reclaimCandidates;
      meta.crowdingRejectedTotal += result.crowdingRejected;
      meta.recordedTotal += result.recorded;
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: LiquidationRecoilXsObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<LiquidationRecoilXsObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept (it must stay resolvable), plus at most
   *  LRX_MAX_STORED_OBSERVATIONS settled (non-OPEN) ones — oldest settled observations are dropped
   *  first once that cap is exceeded, matching residual-momentum-edge.ts's identical convention. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled = settled.length > LRX_MAX_STORED_OBSERVATIONS
      ? settled.slice(settled.length - LRX_MAX_STORED_OBSERVATIONS)
      : settled;
    this.state.observations = [...open, ...keepSettled];
  }
  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }
}

let singleton: LiquidationRecoilXsStore | null = null;
export function getLiquidationRecoilXsStore(dataDir = "data"): LiquidationRecoilXsStore {
  if (!singleton) singleton = new LiquidationRecoilXsStore(resolve(dataDir, "liquidation-recoil-cross-sectional.json"));
  return singleton;
}

export function _resetLiquidationRecoilXsStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────────

export interface LrxCycleResult {
  scanned: number;
  broadEventsDetected: number;
  /** Total symbols found with a fresh panic+washout bar this cycle (whole universe, not just the
   *  clustered broad event, if any). */
  panicCandidates: number;
  /** Within the detected broad event (if any), how many ranked candidates cleared
   *  LRX_MIN_RECLAIM_STRENGTH and were within the top-K (i.e. were considered for recording). */
  reclaimCandidates: number;
  crowdingRejected: number;
  recorded: number;
  resolved: number;
  expired: number;
}

export async function runLiquidationRecoilXsCycle(opts: {
  store: LiquidationRecoilXsStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<LrxCycleResult> {
  const result: LrxCycleResult = {
    scanned: 0,
    broadEventsDetected: 0,
    panicCandidates: 0,
    reclaimCandidates: 0,
    crowdingRejected: 0,
    recorded: 0,
    resolved: 0,
    expired: 0,
  };
  const universe = opts.universe ?? LRX_UNIVERSE;
  const dedupeMs = opts.dedupeWindowMs ?? 3_600_000;
  const nowIso = new Date(opts.now).toISOString();

  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of universe) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* skip this symbol this cycle */
    }
  }

  // 1. resolve OPEN observations with forward candles (same convention as PWR).
  // 2026-07-12 fix: skipping entirely when this symbol's candle fetch fails this cycle (instead
  // of passing []) never gave resolveLiquidationRecoilXsObservation's own `fwd.length === 0` expiry
  // fallback a chance to run — an observation on a persistently-failing symbol stayed OPEN forever
  // (the same bug class already fixed in residual-momentum-edge.ts). Passing [] reuses that
  // existing fallback safely: an empty forwardCandles array short-circuits the fill-check loop and
  // falls straight through to the same expiry check a genuinely-fetched-but-empty response would.
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol) ?? [];
    const patch = resolveLiquidationRecoilXsObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. stage 1+2 scan: which symbols in the universe show a fresh panic+washout bar right now?
  const candidates: LrxPanicCandidate[] = [];
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const panicBar = findRecentPanicWashoutBar(candles);
    if (!panicBar) continue;
    candidates.push({ symbol, panicBar });
  }
  result.panicCandidates = candidates.length;

  // 3. cluster into a broad event; nothing else to do this cycle if none forms.
  const event = detectBroadLiquidationEvent(candidates);
  if (!event) {
    opts.store.recordCycle(nowIso, result);
    opts.store.save();
    return result;
  }
  result.broadEventsDetected = 1;

  // 4. rank event members by reclaim strength (using only candles up to "now" — no lookahead).
  type Ranked = { symbol: string; panicBar: LrxPanicWashoutBar; score: ReclaimStrengthResult };
  const ranked: Ranked[] = [];
  for (const candidate of event.panicked) {
    const candles = candlesBySymbol.get(candidate.symbol);
    if (!candles) continue;
    const forward = candles.filter((c) => c.openTime > candidate.panicBar.openTime).sort((a, b) => a.openTime - b.openTime);
    const score = computeReclaimStrength(candidate.panicBar, forward);
    if (!score) continue;
    ranked.push({ symbol: candidate.symbol, panicBar: candidate.panicBar, score });
  }
  ranked.sort((a, b) => b.score.reclaimStrength - a.score.reclaimStrength);

  // 5. top-K, min-strength-gated, crowding-confirmed candidates become LONG observations.
  for (let i = 0; i < ranked.length; i++) {
    const rank = i + 1;
    if (rank > LRX_TOP_K) break;
    const entry = ranked[i]!;
    if (entry.score.reclaimStrength < LRX_MIN_RECLAIM_STRENGTH) continue;
    result.reclaimCandidates += 1;

    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === entry.symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;

    let crowding: CrowdingSnapshot | null = null;
    try {
      crowding = await fetchCrowdingSnapshot(opts.crowdingClient, entry.symbol, nowIso);
    } catch {
      crowding = null;
    }
    if (!crowding || !passesPanicWashoutCrowdingGate(crowding)) {
      result.crowdingRejected += 1;
      continue;
    }

    const candles = candlesBySymbol.get(entry.symbol);
    if (!candles || candles.length === 0) continue;
    const entryPrice = candles[candles.length - 1]!.close;
    const geometry = buildPanicWashoutGeometry(entryPrice, entry.panicBar.low);
    if (!geometry) continue;

    const observationId = `lrx:${entry.symbol}:${event.eventId}:${opts.now}`;
    const added = opts.store.add({
      ...geometry,
      observationId,
      symbol: entry.symbol,
      direction: "LONG",
      eventId: event.eventId,
      eventStart: new Date(event.eventStart).toISOString(),
      eventStartMs: event.eventStart,
      eventEnd: new Date(event.eventEnd).toISOString(),
      eventEndMs: event.eventEnd,
      panickedSymbolCount: event.panicked.length,
      rank,
      reclaimStrength: entry.score.reclaimStrength,
      retracedFraction: entry.score.retracedFraction,
      timeToHalfRetraceBars: entry.score.timeToHalfRetraceBars,
      panicBarHigh: entry.panicBar.high,
      panicBarLow: entry.panicBar.low,
      rsiAtWashout: entry.panicBar.rsiAtWashout,
      fundingBps: crowding.fundingBps,
      oiChangePercent: crowding.oiChangePercent,
      openedAt: nowIso,
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.recorded += 1;
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

export async function runLiquidationRecoilXsCycleGuarded(
  opts: Parameters<typeof runLiquidationRecoilXsCycle>[0],
): Promise<LrxCycleResult | null> {
  try {
    return await runLiquidationRecoilXsCycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  }
}

// ── report ──────────────────────────────────────────────────────────────────

export interface LiquidationRecoilXsReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  minPanicSymbols: number;
  eventWindowBars: number;
  retraceWindowBars: number;
  topK: number;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  mfeGivebackShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{
    symbol: string;
    eventId: string;
    rank: number;
    reclaimStrength: number;
    netR: number | null;
    status: string;
    exitReason: string | null;
    openedAt: string;
  }>;
  cycleMeta: LrxCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildLiquidationRecoilXsReport(
  observations: readonly LiquidationRecoilXsObservation[],
  cycleMeta?: LrxCycleMeta,
): LiquidationRecoilXsReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const mfeGivebacks = resolved.filter((o) => o.exitReason === "MFE_GIVEBACK").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = mean(nets);
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      symbol: o.symbol,
      eventId: o.eventId,
      rank: o.rank,
      reclaimStrength: o.reclaimStrength,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
    }));

  return {
    laneId: LRX_PAPER_LANE_ID,
    interval: LRX_INTERVAL,
    universe: LRX_UNIVERSE,
    minPanicSymbols: LRX_MIN_PANIC_SYMBOLS,
    eventWindowBars: LRX_EVENT_WINDOW_BARS,
    retraceWindowBars: LRX_RETRACE_WINDOW_BARS,
    topK: LRX_TOP_K,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    mfeGivebackShare: resolved.length ? mfeGivebacks / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

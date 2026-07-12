/**
 * COMPRESSION -> IGNITION — volatility-compression entry for "CG Long Volatility Expansion"
 * (report-only measurement lane).
 *
 * Tier-3 audit finding (2026-07-10): this engine already has proven EXIT architecture live
 * (partial-TP+runner, MFE-giveback, and — as of earlier today — a continuous ATR-trail variant in
 * current-guard-variant-matrix.ts's walkVariantPath), but the ENTRY side — a volatility-compression
 * detector feeding an order-flow-confirmed ignition breakout trigger — was completely absent. No
 * Bollinger-band-width, ATR-percentile/rank, or compression/ignition concept existed anywhere in
 * this codebase before this module. This IS that entry side, built as its own independent
 * measurement lane (own store, cycle, resolver, report) per this repo's established convention (see
 * short-fade-edge.ts / panic-washout-reclaim-edge.ts).
 *
 * Two conjunctive stages, cheap-first (same discipline as every sibling lane's gate ordering):
 *
 *  1. COMPRESSION (candle-only, cheap): a symbol is "compressed" once BOTH its ATR-percentile
 *     (computeATRPercentile, candle-indicators.ts) AND its Bollinger-band-width-percentile
 *     (computeBollingerBandWidth, ranked by the SAME generic percentile function — not a second,
 *     duplicated one) sit in the bottom quartile of their own last CE_PERCENTILE_WINDOW bars,
 *     SUSTAINED for CE_COMPRESSION_SUSTAIN_BARS consecutive bars — a single quiet candle is noise,
 *     not a squeeze.
 *  2. IGNITION (candle-only breakout geometry, THEN an order-flow confirmation): once compressed,
 *     watch for a breakout candle whose CLOSE clears the compression range (high or low) on volume
 *     >= CE_IGNITION_VOLUME_MULT times the compression window's own average volume. That candle-only
 *     candidate is then confirmed (never assumed) by real taker-flow imbalance in the breakout
 *     direction, reusing order-flow-microstructure.ts's computeTakerFlowFeatures directly (not
 *     duplicated) — the same "cheap gate first, then the Binance-call confirmation only for
 *     pre-qualified candidates" discipline short-fade-edge.ts and panic-washout-reclaim-edge.ts use
 *     for their own second-stage gates (crowding fetch).
 *
 * Exit: REUSES current-guard-variant-matrix.ts's walkVariantPath (exitRule: "atr_trail") instead of
 * reimplementing exit simulation from scratch, per this module's own build instructions. atr_trail
 * (not mfe_giveback) is the deliberate choice here — this lane's whole thesis is capturing the START
 * of a volatility EXPANSION move; a giveback-and-bank exit is tuned to fade a spike, whereas a
 * ratcheting ATR trail is tuned to let a genuine expansion run while still protecting profit as
 * realized volatility rises. Cost model: REUSES shadow-engine.ts's REALISTIC_ROUND_TRIP_FEE_SLIP_BPS
 * (the shared, more-honest 22bps taker round-trip figure) rather than each sibling lane's own
 * locally-hardcoded ad hoc bps constants.
 *
 * Pure measurement: records and resolves observations, exposes a report. NOTHING trades until the
 * book proves positive. This module has NO execution-wiring adapters (unlike short-fade-edge.ts /
 * panic-washout-reclaim-edge.ts, which gained theirs only after separate, explicit operator
 * sign-off) — it is not wired into live-execution-engine.ts, app.ts's executor wiring, any lane
 * allocation, or any live executor of any kind. A dashboard route is wired up separately afterward.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import { computeATR, computeATRPercentile, computeBollingerBandWidth } from "./candle-indicators.js";
import { computeTakerFlowFeatures, type TakerFlowFeatures } from "./order-flow-microstructure.js";
import { walkVariantPath, type KlineTuple } from "./current-guard-variant-matrix.js";
import { REALISTIC_ROUND_TRIP_FEE_SLIP_BPS } from "./shadow-engine.js";
import type { BinanceClient, FuturesAggTradeSnapshot } from "./binance.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export type CompressionDirection = "LONG" | "SHORT";

export const CE_INTERVAL = process.env.COMPRESSION_EXPANSION_INTERVAL || "1h";
/** Fixed ms width matching CE_INTERVAL's default ("1h"). Kept as its own constant (not derived from
 *  the interval string) — same convention as current-guard-variant-matrix.ts's own CANDLE_MS. */
const CE_INTERVAL_MS = 3_600_000;

export const CE_MAX_STORED_OBSERVATIONS = envNum("COMPRESSION_EXPANSION_MAX_STORED_OBSERVATIONS", 500);
export const CE_ATR_PERIOD = envNum("COMPRESSION_EXPANSION_ATR_PERIOD", 14);
/** Rolling window (in bars) used to rank the CURRENT ATR and Bollinger-band-width readings against
 *  their own recent history. 100 bars @ 1h ~= 4.2 days: long enough for a stable percentile
 *  estimate, short enough to stay inside "this symbol's CURRENT volatility regime" rather than
 *  reaching back across a stale one. */
export const CE_PERCENTILE_WINDOW = envNum("COMPRESSION_EXPANSION_PERCENTILE_WINDOW", 100);
/** "Compressed" = both readings sit at/below this percentile (bottom quartile by default) of their
 *  own last CE_PERCENTILE_WINDOW bars. */
export const CE_ATR_PERCENTILE_MAX = envNum("COMPRESSION_EXPANSION_ATR_PERCENTILE_MAX", 25);
export const CE_BBW_PERCENTILE_MAX = envNum("COMPRESSION_EXPANSION_BBW_PERCENTILE_MAX", 25);
export const CE_BBW_PERIOD = envNum("COMPRESSION_EXPANSION_BBW_PERIOD", 20);
export const CE_BBW_STDDEV_MULTIPLE = Number(process.env.COMPRESSION_EXPANSION_BBW_STDDEV_MULTIPLE) || 2;
/** How many CONSECUTIVE bars, ending on the bar immediately before the breakout candle, must ALL
 *  read "compressed" before a breakout is even considered — filters a single quiet candle from a
 *  genuine squeeze. 6 bars @ 1h = 6h of sustained quiet. */
export const CE_COMPRESSION_SUSTAIN_BARS = envNum("COMPRESSION_EXPANSION_SUSTAIN_BARS", 6);
/** Breakout candle's volume must be at least this many times the compression window's OWN average
 *  volume — a genuine ignition should show materially more participation than the quiet regime it's
 *  breaking out of; anything less risks catching a random single-candle noise poke. */
export const CE_IGNITION_VOLUME_MULT = Number(process.env.COMPRESSION_EXPANSION_IGNITION_VOLUME_MULT) || 1.75;
/** Taker-buy-ratio confirmation threshold: the breakout direction's taker flow must be at least
 *  this lopsided (0.60 = 60/40) — reuses order-flow-microstructure.ts's computeTakerFlowFeatures. */
export const CE_TAKER_BUY_RATIO_MIN = Number(process.env.COMPRESSION_EXPANSION_TAKER_BUY_RATIO_MIN) || 0.6;
export const CE_AGGTRADES_LIMIT = envNum("COMPRESSION_EXPANSION_AGGTRADES_LIMIT", 1000);

/** Stop sits beyond the compression range's own opposite edge (structural), floored so an
 *  unrealistically tight range can't produce a stop tighter than this, and REJECTED (never
 *  clipped — same anti-fabrication convention as panic-washout-reclaim-edge.ts's
 *  PWR_STOP_CEILING_BPS) once the implied stop is wider than the ceiling. */
export const CE_STOP_FLOOR_BPS = envNum("COMPRESSION_EXPANSION_STOP_FLOOR_BPS", 150);
export const CE_STOP_CEILING_BPS = envNum("COMPRESSION_EXPANSION_STOP_CEILING_BPS", 600);
/** Hard far bound fed into walkVariantPath's `target` param — same role as atr_trail/mfe_giveback's
 *  own "target still bounds the trade" convention there. The REAL exit mechanism is the ATR trail;
 *  this multiple is deliberately wide so it essentially never binds. */
export const CE_FAR_TARGET_R_MULTIPLE = Number(process.env.COMPRESSION_EXPANSION_FAR_TARGET_R_MULTIPLE) || 8;

export const CE_ATR_TRAIL_PERIOD = envNum("COMPRESSION_EXPANSION_ATR_TRAIL_PERIOD", 14);
export const CE_ATR_TRAIL_MULTIPLE = Number(process.env.COMPRESSION_EXPANSION_ATR_TRAIL_MULTIPLE) || 2;
export const CE_ATR_TRAIL_ARM_R = Number(process.env.COMPRESSION_EXPANSION_ATR_TRAIL_ARM_R) || 0.5;
/** 72 bars @ 1h = 3 days — expansion moves are given more room to run than this repo's fixed-R fade
 *  lanes (short-fade-edge.ts/panic-washout-reclaim-edge.ts both use 48). */
export const CE_MAX_HOLD_BARS = envNum("COMPRESSION_EXPANSION_MAX_HOLD_BARS", 72);

export const CE_PAPER_LANE_ID = "COMPRESSION_EXPANSION_IGNITION" as const;
/** Majors/liquid tier — same universe as short-fade-edge.ts/panic-washout-reclaim-edge.ts, for the
 *  same reason (thin alts produce false breakout/volume signals). Env-overridable. */
export const CE_UNIVERSE: readonly string[] = (process.env.COMPRESSION_EXPANSION_UNIVERSE ?? "BTCUSDT,ETHUSDT,LINKUSDT,SEIUSDT,BNBUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Extra adverse fill on top of the shared round-trip figure when the ATR-trail STOP actually
 *  fires (vs a favorable TP/trail-based exit) — same role as current-guard-variant-matrix.ts's own
 *  env-tunable STOP_OUT_SLIPPAGE_BPS (default 12), kept as this lane's own constant rather than
 *  importing that one so the two lanes can be tuned independently. */
const CE_STOP_OUT_EXTRA_SLIPPAGE_BPS = envNum("COMPRESSION_EXPANSION_STOP_OUT_EXTRA_SLIPPAGE_BPS", 12);

/** Net-of-cost R conversion reusing shadow-engine.ts's REALISTIC_ROUND_TRIP_FEE_SLIP_BPS (fee +
 *  slippage, both sides, taker) instead of a locally-hardcoded ad hoc bps figure. */
function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / stopDistanceBps + (isLoss ? CE_STOP_OUT_EXTRA_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

// ── compression + ignition detector (candle-only, no lookahead) ────────────

export interface CompressionIgnitionSignal {
  direction: CompressionDirection;
  entryPrice: number;
  compressionRangeHigh: number;
  compressionRangeLow: number;
  atrAtBreakout: number;
  atrPercentileAtCompression: number;
  bbWidthPercentileAtCompression: number;
  breakoutVolume: number;
  compressionAvgVolume: number;
  volumeRatio: number;
  breakoutOpenMs: number;
}

/**
 * Pure compression -> ignition detector on a CLOSED-candle series (last element = the just-closed
 * candidate breakout bar). No lookahead: the compression range/average-volume baseline is built
 * ONLY from the CE_COMPRESSION_SUSTAIN_BARS bars strictly BEFORE the breakout bar, and the breakout
 * confirmation itself only reads that same already-closed last bar's own OHLCV — never a future one.
 *
 * Returns null unless: (a) there are enough candles, (b) the CE_COMPRESSION_SUSTAIN_BARS bars ending
 * immediately before the last bar are ALL "compressed" (ATR-percentile AND BBW-percentile both
 * <= their respective max), (c) the last bar's close clears that compression range on one side, and
 * (d) that bar's volume clears the ignition multiple of the compression window's own average volume.
 * Order-flow confirmation is NOT done here (see passesCompressionIgnitionTakerFlowGate) — this
 * function only ever needs candle data, so the cycle can call it for free before paying for a
 * Binance aggTrades fetch.
 */
export function detectCompressionIgnitionSignal(candles: Candle[]): CompressionIgnitionSignal | null {
  const need = CE_ATR_PERIOD + CE_PERCENTILE_WINDOW + CE_COMPRESSION_SUSTAIN_BARS + 2;
  if (candles.length < need) return null;

  const closes = candles.map((c) => c.close);
  const atrSeries = computeATR(candles, CE_ATR_PERIOD);
  const atrPctlSeries = computeATRPercentile(atrSeries, CE_PERCENTILE_WINDOW);
  const bbwSeries = computeBollingerBandWidth(closes, CE_BBW_PERIOD, CE_BBW_STDDEV_MULTIPLE);
  const bbwPctlSeries = computeATRPercentile(bbwSeries, CE_PERCENTILE_WINDOW); // generic percentile fn, reused (not duplicated)

  const lastIdx = candles.length - 1;
  const compressionWindowEnd = lastIdx - 1; // compression must be sustained strictly BEFORE the breakout bar
  const compressionWindowStart = compressionWindowEnd - CE_COMPRESSION_SUSTAIN_BARS + 1;
  if (compressionWindowStart < 0) return null;

  for (let idx = compressionWindowStart; idx <= compressionWindowEnd; idx++) {
    const atrPctl = atrPctlSeries[idx];
    const bbwPctl = bbwPctlSeries[idx];
    if (!finite(atrPctl) || !finite(bbwPctl)) return null;
    if (atrPctl > CE_ATR_PERCENTILE_MAX || bbwPctl > CE_BBW_PERCENTILE_MAX) return null;
  }

  let compressionRangeHigh = -Infinity;
  let compressionRangeLow = Infinity;
  let volumeSum = 0;
  for (let idx = compressionWindowStart; idx <= compressionWindowEnd; idx++) {
    const bar = candles[idx]!;
    if (bar.high > compressionRangeHigh) compressionRangeHigh = bar.high;
    if (bar.low < compressionRangeLow) compressionRangeLow = bar.low;
    volumeSum += bar.volume;
  }
  const compressionAvgVolume = volumeSum / CE_COMPRESSION_SUSTAIN_BARS;
  if (!(compressionAvgVolume > 0) || !(compressionRangeHigh > compressionRangeLow)) return null;

  const breakoutBar = candles[lastIdx]!;
  let direction: CompressionDirection;
  if (breakoutBar.close > compressionRangeHigh) direction = "LONG";
  else if (breakoutBar.close < compressionRangeLow) direction = "SHORT";
  else return null; // still inside the compression range — no breakout yet

  const volumeRatio = breakoutBar.volume / compressionAvgVolume;
  if (!(volumeRatio >= CE_IGNITION_VOLUME_MULT)) return null;

  const atrAtCompression = atrSeries[compressionWindowEnd]; // the QUIET regime's ATR, not the just-ignited bar's
  const atrPctlAtCompression = atrPctlSeries[compressionWindowEnd];
  const bbwPctlAtCompression = bbwPctlSeries[compressionWindowEnd];
  if (!finite(atrAtCompression) || !finite(atrPctlAtCompression) || !finite(bbwPctlAtCompression)) return null;
  if (!(breakoutBar.close > 0)) return null;

  return {
    direction,
    entryPrice: breakoutBar.close,
    compressionRangeHigh,
    compressionRangeLow,
    atrAtBreakout: atrAtCompression,
    atrPercentileAtCompression: atrPctlAtCompression,
    bbWidthPercentileAtCompression: bbwPctlAtCompression,
    breakoutVolume: breakoutBar.volume,
    compressionAvgVolume,
    volumeRatio,
    breakoutOpenMs: breakoutBar.openTime,
  };
}

/** Order-flow confirmation gate: the breakout direction's taker flow must be at least
 *  CE_TAKER_BUY_RATIO_MIN-lopsided in that direction. Reuses computeTakerFlowFeatures's output
 *  directly (never recomputes taker flow itself). */
export function passesCompressionIgnitionTakerFlowGate(direction: CompressionDirection, takerFlow: TakerFlowFeatures): boolean {
  if (takerFlow.takerBuyRatio === null) return false;
  return direction === "LONG"
    ? takerFlow.takerBuyRatio >= CE_TAKER_BUY_RATIO_MIN
    : takerFlow.takerBuyRatio <= 1 - CE_TAKER_BUY_RATIO_MIN;
}

// ── geometry ─────────────────────────────────────────────────────────────────

export interface CompressionExpansionGeometry {
  entryPrice: number;
  initialStop: number;
  targetPrice: number;
  stopDistanceBps: number;
}

/** Structural stop beyond the compression range's opposite edge, floored/ceilinged (rejected, never
 *  clipped, past the ceiling). Target is a wide, essentially-non-binding far bound for
 *  walkVariantPath's atr_trail exit rule (see CE_FAR_TARGET_R_MULTIPLE's doc comment). */
export function buildCompressionExpansionGeometry(
  direction: CompressionDirection,
  entryPrice: number,
  compressionRangeLow: number,
  compressionRangeHigh: number,
): CompressionExpansionGeometry | null {
  if (!(entryPrice > 0)) return null;
  const floorFrac = CE_STOP_FLOOR_BPS / 10000;
  let initialStop: number;
  if (direction === "LONG") {
    if (!(compressionRangeLow > 0) || !(compressionRangeLow < entryPrice)) return null;
    initialStop = Math.min(compressionRangeLow, entryPrice * (1 - floorFrac));
    if (!(initialStop > 0) || !(initialStop < entryPrice)) return null;
  } else {
    if (!(compressionRangeHigh > entryPrice)) return null;
    initialStop = Math.max(compressionRangeHigh, entryPrice * (1 + floorFrac));
  }
  const risk = direction === "LONG" ? entryPrice - initialStop : initialStop - entryPrice;
  if (!(risk > 0)) return null;
  const stopDistanceBps = (risk / entryPrice) * 10000;
  if (stopDistanceBps > CE_STOP_CEILING_BPS) return null; // reject rather than clip
  const targetPrice = direction === "LONG" ? entryPrice + CE_FAR_TARGET_R_MULTIPLE * risk : entryPrice - CE_FAR_TARGET_R_MULTIPLE * risk;
  if (!(targetPrice > 0)) return null;
  return { entryPrice, initialStop, targetPrice, stopDistanceBps };
}

// ── observation ──────────────────────────────────────────────────────────────

export interface CompressionExpansionObservation extends CompressionExpansionGeometry {
  observationId: string;
  symbol: string;
  direction: CompressionDirection;
  openedAt: string;
  openedAtMs: number;
  atrAtBreakout: number;
  atrPercentileAtCompression: number;
  bbWidthPercentileAtCompression: number;
  volumeRatio: number;
  takerBuyRatio: number | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  maxFavorableR: number | null;
  /** walkVariantPath's own resolutionSource string (e.g. "ATR_TRAIL_STOP", "CANDLE_WALK_TP",
   *  "MAX_HOLD_MTM", "AMBIGUOUS_SL_FIRST") — kept as the raw string rather than forced into a
   *  narrower enum, since walkVariantPath is reused rather than reimplemented. */
  exitReason: string | null;
  resolvedAt: string | null;
}

/** Candle -> KlineTuple adapter (the inverse of current-guard-variant-matrix.ts's own
 *  klineTupleToCandle) so this lane's real Candle[] history can be fed into walkVariantPath. Real
 *  open/volume values are carried through (walkVariantPath's atr_trail path only reads
 *  high/low/close/closeTime for the exit walk itself, but there is no reason to fabricate zeros
 *  when the real values are already on hand). */
function candleToKlineTuple(c: Candle): KlineTuple {
  return [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.openTime + CE_INTERVAL_MS];
}

/**
 * Resolve an OPEN observation by walking forward candles (STRICTLY AFTER the entry/breakout candle)
 * through walkVariantPath's atr_trail exit rule — no exit logic is reimplemented here. No
 * lookahead: only ever passes candles that are already closed by `nowMs`, and once
 * CE_MAX_HOLD_BARS worth of candles have actually elapsed, bounds the walk to exactly that window
 * (forceCloseAtEnd: true) so a mark-to-market close fires at the RIGHT candle rather than an
 * arbitrarily later one. Before that boundary is reached, forceCloseAtEnd stays false so an
 * unresolved walk correctly reports "still open" (this function returns null) instead of a
 * fabricated early close.
 *
 * 2026-07-12 fix: this used to include the entry candle itself (`c.openTime >= obs.openedAtMs`) as
 * bar 0 of the exit walk, even though obs.entryPrice IS that same candle's close — letting a
 * stop/target touch from that candle's own high/low (which happened at or before the close) book
 * a same-bar exit that couldn't have chronologically followed the entry. Sibling resolvers in this
 * same measurement-lane family (liquidation-recoil-cross-sectional.ts's
 * resolveLiquidationRecoilXsObservation) already exclude the entry candle via a strict `>` — this
 * file was the one inconsistent with that established convention.
 */
export async function resolveCompressionExpansionObservation(
  obs: CompressionExpansionObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Promise<Partial<CompressionExpansionObservation> | null> {
  const relevant = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  if (relevant.length === 0) {
    if (nowMs - obs.openedAtMs > CE_MAX_HOLD_BARS * CE_INTERVAL_MS * 3) {
      return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
    }
    return null;
  }

  const barsAvailable = relevant.length; // first bar AFTER the entry candle, never the entry candle itself
  const maxHoldReached = barsAvailable - 1 >= CE_MAX_HOLD_BARS;
  const windowed = maxHoldReached ? relevant.slice(0, CE_MAX_HOLD_BARS + 1) : relevant;
  const klineTuples = windowed.map(candleToKlineTuple);

  const walk = await walkVariantPath({
    direction: obs.direction,
    entryPrice: obs.entryPrice,
    stopLoss: obs.initialStop,
    target: obs.targetPrice,
    exitRule: "atr_trail",
    fillMode: "taker",
    openedAtMs: obs.openedAtMs,
    candles: klineTuples,
    atrPeriod: CE_ATR_TRAIL_PERIOD,
    atrMultiple: CE_ATR_TRAIL_MULTIPLE,
    atrTrailArmR: CE_ATR_TRAIL_ARM_R,
    forceCloseAtEnd: maxHoldReached,
  });

  if (walk.status === "UNRESOLVED" || walk.status === "NO_FILL") {
    if (nowMs - obs.openedAtMs > CE_MAX_HOLD_BARS * CE_INTERVAL_MS * 3) {
      return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
    }
    return null; // still open
  }

  const grossR = walk.grossR ?? 0;
  const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
  return {
    status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    grossR,
    costR,
    netR,
    maxFavorableR: walk.maxMfeR,
    exitReason: walk.resolutionSource,
    resolvedAt: walk.closedAtMs ? new Date(walk.closedAtMs).toISOString() : new Date(nowMs).toISOString(),
  };
}

// ── store ─────────────────────────────────────────────────────────────────
export interface CECycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  compressionIgnitionCandidatesTotal: number;
  takerFlowRejectedTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: CECycleMeta = {
  lastCycleAt: null, cycles: 0, compressionIgnitionCandidatesTotal: 0, takerFlowRejectedTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface CEState {
  version: number;
  observations: CompressionExpansionObservation[];
  cycleMeta?: CECycleMeta;
}

/** Atomic tmp+rename write, compact JSON — same persistence convention as every sibling lane's
 *  store (short-fade-edge.ts's ShortFadeStore, panic-washout-reclaim-edge.ts's PanicWashoutStore). */
export class CompressionExpansionStore {
  private state: CEState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CEState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as CompressionExpansionObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt -> start empty */
      }
    }
  }
  get all(): CompressionExpansionObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): CECycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: CECycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.compressionIgnitionCandidatesTotal += result.compressionIgnitionCandidates;
      meta.takerFlowRejectedTotal += result.takerFlowRejected;
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
  add(obs: CompressionExpansionObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<CompressionExpansionObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most CE_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled observations are dropped first once that cap is exceeded.
   *  2026-07-11 OOM audit fix. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > CE_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - CE_MAX_STORED_OBSERVATIONS) : settled;
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

let singleton: CompressionExpansionStore | null = null;
export function getCompressionExpansionStore(dataDir = "data"): CompressionExpansionStore {
  if (!singleton) singleton = new CompressionExpansionStore(resolve(dataDir, "compression-expansion-edge.json"));
  return singleton;
}

export function _resetCompressionExpansionStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface CECycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  compressionIgnitionCandidates: number;
  takerFlowRejected: number;
}

/**
 * 1. resolve OPEN observations against forward candles (walkVariantPath, reused).
 * 2. record new entries: cheap candle-only compression+ignition detection first, THEN the
 *    aggTrades fetch (Binance call) ONLY for symbols that already cleared it — same discipline as
 *    short-fade-edge.ts's cycle (RSI gate first, crowding fetch second).
 */
export async function runCompressionExpansionCycle(opts: {
  store: CompressionExpansionStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  client: Pick<BinanceClient, "getFuturesAggTrades">;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<CECycleResult> {
  const result: CECycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, compressionIgnitionCandidates: 0, takerFlowRejected: 0 };
  const universe = opts.universe ?? CE_UNIVERSE;
  const dedupeMs = opts.dedupeWindowMs ?? CE_INTERVAL_MS;
  const nowIso = new Date(opts.now).toISOString();

  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of universe) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* skip this symbol this cycle */
    }
  }

  // 1. resolve OPEN observations with forward candles.
  // 2026-07-12 fix: skipping entirely when this symbol's candle fetch fails this cycle (instead
  // of passing []) never gave the resolver's own `relevant.length === 0` expiry fallback a chance
  // to run — an observation on a persistently-failing symbol stayed OPEN forever (the same bug
  // class already fixed in residual-momentum-edge.ts / liquidation-recoil-cross-sectional.ts).
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol) ?? [];
    const patch = await resolveCompressionExpansionObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. record new entries.
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;
    const signal = detectCompressionIgnitionSignal(candles);
    if (!signal) continue;
    result.compressionIgnitionCandidates += 1;

    let takerFlow: TakerFlowFeatures | null = null;
    try {
      const trades = await opts.client.getFuturesAggTrades(symbol, {
        startTime: signal.breakoutOpenMs,
        endTime: signal.breakoutOpenMs + CE_INTERVAL_MS,
        limit: CE_AGGTRADES_LIMIT,
      });
      const windowed = (trades ?? []).filter(
        (t: FuturesAggTradeSnapshot) => t.timestamp >= signal.breakoutOpenMs && t.timestamp < signal.breakoutOpenMs + CE_INTERVAL_MS,
      );
      takerFlow = computeTakerFlowFeatures(windowed);
    } catch {
      takerFlow = null;
    }
    if (!takerFlow || !passesCompressionIgnitionTakerFlowGate(signal.direction, takerFlow)) {
      result.takerFlowRejected += 1;
      continue;
    }

    const geometry = buildCompressionExpansionGeometry(signal.direction, signal.entryPrice, signal.compressionRangeLow, signal.compressionRangeHigh);
    if (!geometry) continue;

    const observationId = `ce:${symbol}:${signal.breakoutOpenMs}`;
    const added = opts.store.add({
      ...geometry,
      observationId,
      symbol,
      direction: signal.direction,
      openedAt: new Date(signal.breakoutOpenMs).toISOString(),
      openedAtMs: signal.breakoutOpenMs,
      atrAtBreakout: signal.atrAtBreakout,
      atrPercentileAtCompression: signal.atrPercentileAtCompression,
      bbWidthPercentileAtCompression: signal.bbWidthPercentileAtCompression,
      volumeRatio: signal.volumeRatio,
      takerBuyRatio: takerFlow.takerBuyRatio,
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

export async function runCompressionExpansionCycleGuarded(opts: Parameters<typeof runCompressionExpansionCycle>[0]): Promise<CECycleResult | null> {
  try {
    return await runCompressionExpansionCycle(opts);
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
export interface CompressionExpansionReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  /** exitReason === "CANDLE_WALK_TP" — the wide, essentially-non-binding far target (see
   *  CE_FAR_TARGET_R_MULTIPLE) was hit before the ATR trail ever did; expected to be rare by
   *  design. */
  tpShare: number | null;
  /** exitReason === "ATR_TRAIL_STOP" (covers BOTH the still-at-original-level stop and any
   *  ratcheted trail level — walkVariantPath's atr_trail rule uses this ONE label for both, since
   *  the trailing stop starts at the original stop and only ever ratchets from there) OR
   *  "AMBIGUOUS_SL_FIRST" (same-candle SL+TP ambiguity, resolved conservatively SL-first). This is
   *  this lane's dominant exit path — it's the whole point of reusing atr_trail. */
  atrTrailStopShare: number | null;
  /** exitReason === "MAX_HOLD_MTM" — neither the ATR trail nor the far target fired within
   *  CE_MAX_HOLD_BARS; closed at mark-to-market. */
  maxHoldShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{
    symbol: string;
    direction: CompressionDirection;
    netR: number | null;
    status: string;
    exitReason: string | null;
    openedAt: string;
    volumeRatio: number;
    takerBuyRatio: number | null;
  }>;
  /** Liveness + gate funnel — distinguishes "alive but the market never qualified" from "silently
   *  dead" and from "erroring", same convention as every sibling lane's cycleMeta. */
  cycleMeta: CECycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** edgeReady gate matches this repo's established formula exactly: n>=30, netAvgR>=0.05, payoff>1.1. */
export function buildCompressionExpansionReport(
  observations: readonly CompressionExpansionObservation[],
  cycleMeta?: CECycleMeta,
): CompressionExpansionReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const tpHits = resolved.filter((o) => o.exitReason === "CANDLE_WALK_TP").length;
  const trailStops = resolved.filter((o) => o.exitReason === "ATR_TRAIL_STOP" || o.exitReason === "AMBIGUOUS_SL_FIRST").length;
  const maxHolds = resolved.filter((o) => o.exitReason === "MAX_HOLD_MTM").length;
  const netAvgR = mean(nets);
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      symbol: o.symbol,
      direction: o.direction,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
      volumeRatio: o.volumeRatio,
      takerBuyRatio: o.takerBuyRatio,
    }));

  return {
    laneId: CE_PAPER_LANE_ID,
    interval: CE_INTERVAL,
    universe: CE_UNIVERSE,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    tpShare: resolved.length ? tpHits / resolved.length : null,
    atrTrailStopShare: resolved.length ? trailStops / resolved.length : null,
    maxHoldShare: resolved.length ? maxHolds / resolved.length : null,
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

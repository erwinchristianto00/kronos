/**
 * Intraday momentum hunter (Sleeve 2, report-only measurement lane).
 *
 * The operator wants daily momentum profit. The regime engine shows the MACRO market is chop
 * (Bull=0/Bear=0/Neutral=598 of 704 snapshots), so a macro trend-follower sits idle. But every day
 * SOME coin breaks out on its own flow regardless of the macro tape. This lane hunts exactly that:
 * on 1h candles it records a paper LONG when a symbol breaks its recent high WITH a volume surge AND
 * confirmed momentum, then resolves it with the MFE-giveback exit (let the winner run, bank it on a
 * retrace from peak) — the same asymmetry fix the live autopsy demanded. Pure measurement: it records
 * and resolves observations and exposes a report; NOTHING trades until the book proves positive.
 *
 * Independent module: its own store, cycle, resolver, report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import { computeEMA, computeATR, computeSMA } from "./candle-indicators.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const IM_INTERVAL = process.env.INTRADAY_MOMENTUM_INTERVAL || "1h";
/** Breakout: close must exceed the highest HIGH of the prior N bars (the intraday range top). */
export const IM_BREAKOUT_LOOKBACK = envNum("INTRADAY_MOMENTUM_BREAKOUT_LOOKBACK", 20);
/** Volume surge: current bar volume must exceed volumeSMA(period) × this multiple. */
export const IM_VOLUME_MA_PERIOD = envNum("INTRADAY_MOMENTUM_VOLUME_MA_PERIOD", 20);
export const IM_VOLUME_MULT = Number(process.env.INTRADAY_MOMENTUM_VOLUME_MULT) || 1.5;
/** Momentum confirm: close above this EMA (trend up) and ROC over this lookback positive. */
export const IM_EMA_PERIOD = envNum("INTRADAY_MOMENTUM_EMA_PERIOD", 20);
export const IM_ROC_PERIOD = envNum("INTRADAY_MOMENTUM_ROC_PERIOD", 12);
/** Anti-chase: reject if the breakout close is more than this many ATRs above the EMA (vertical spike). */
export const IM_MAX_ATR_EXTENSION = Number(process.env.INTRADAY_MOMENTUM_MAX_ATR_EXTENSION) || 3;
export const IM_ATR_PERIOD = envNum("INTRADAY_MOMENTUM_ATR_PERIOD", 14);
/** Initial stop = entry − ATR × this. */
export const IM_ATR_STOP_MULT = Number(process.env.INTRADAY_MOMENTUM_ATR_STOP_MULT) || 1.5;
/** MFE-giveback exit: arm once peak favorableR ≥ this, then bank when it retraces by GIVEBACK_FRAC of the peak. */
export const IM_MFE_ARM_R = Number(process.env.INTRADAY_MOMENTUM_MFE_ARM_R) || 0.75;
export const IM_MFE_GIVEBACK_FRAC = Number(process.env.INTRADAY_MOMENTUM_MFE_GIVEBACK_FRAC) || 0.5;
/** Max hold in bars (1h) → mark-to-market if neither stop nor giveback fired. */
export const IM_MAX_HOLD_BARS = envNum("INTRADAY_MOMENTUM_MAX_HOLD_BARS", 24);
export const IM_PAPER_LANE_ID = "INTRADAY_MOMENTUM_BREAKOUT_LONG" as const;

const TAKER_ROUNDTRIP_BPS = 8; // ~0.04% per side, taker in + taker out
const STOP_OUT_SLIPPAGE_BPS = 5; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

export interface IntradayMomentumSignal {
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  atrAtEntry: number;
  rocAtEntry: number;
  breakoutHigh: number;
  volumeRatio: number;
  atrExtension: number;
}

export interface IntradayMomentumObservation extends IntradayMomentumSignal {
  observationId: string;
  symbol: string;
  direction: "LONG";
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  maxFavorableR: number | null;
  exitReason: "MFE_GIVEBACK" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
  /**
   * Order-flow + composite decision score read AT SIGNAL TIME (report-only enrichment; never used to
   * admit or reject the signal itself — that stays purely the breakout/volume/momentum gates above).
   * Recording this alongside the eventual realized outcome lets a future pass check whether the score
   * actually correlates with edge BEFORE it is ever wired into admission. null when the enrichment
   * fetch failed or was unavailable — absence must never be treated as a good or bad reading.
   */
  takerBuyRatioAtEntry?: number | null;
  spreadBpsAtEntry?: number | null;
  decisionScoreAtEntry?: number | null;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Pure entry signal on a CLOSED-candle series (last element = the just-closed bar). Returns a signal
 * when the last close breaks the prior-N-bar high with a volume surge + momentum, and is not a
 * vertical over-extension. Null when any gate fails. No lookahead — uses only closed bars.
 */
export function detectIntradayMomentumEntry(candles: Candle[]): IntradayMomentumSignal | null {
  const need = Math.max(IM_BREAKOUT_LOOKBACK + 2, IM_VOLUME_MA_PERIOD + 1, IM_EMA_PERIOD + 1, IM_ROC_PERIOD + 1, IM_ATR_PERIOD + 1);
  if (candles.length < need) return null;
  const last = candles[candles.length - 1]!;
  const closes = candles.map((c) => c.close);
  const entry = last.close;
  if (!(entry > 0)) return null;

  // 1. Breakout: close above the highest HIGH of the prior IM_BREAKOUT_LOOKBACK bars (excluding this one).
  const priorHighs = candles.slice(candles.length - 1 - IM_BREAKOUT_LOOKBACK, candles.length - 1).map((c) => c.high);
  const breakoutHigh = Math.max(...priorHighs);
  if (!(entry > breakoutHigh)) return null;

  // 2. Volume surge.
  const volSma = computeSMA(candles.map((c) => c.volume), IM_VOLUME_MA_PERIOD);
  const volAvg = volSma[volSma.length - 1];
  if (!finite(volAvg) || !(volAvg > 0)) return null;
  const volumeRatio = last.volume / volAvg;
  if (!(volumeRatio >= IM_VOLUME_MULT)) return null;

  // 3. Momentum confirm: close above EMA and positive ROC.
  const ema = computeEMA(closes, IM_EMA_PERIOD);
  const emaNow = ema[ema.length - 1];
  if (!finite(emaNow) || !(entry > emaNow)) return null;
  const rocRef = closes[closes.length - 1 - IM_ROC_PERIOD];
  if (!finite(rocRef) || !(rocRef > 0)) return null;
  const rocAtEntry = ((entry - rocRef) / rocRef) * 100;
  if (!(rocAtEntry > 0)) return null;

  // 4. ATR + anti-chase (reject a vertical spike far above the EMA).
  const atrSeries = computeATR(candles, IM_ATR_PERIOD);
  const atr = atrSeries[atrSeries.length - 1];
  if (!finite(atr) || !(atr > 0)) return null;
  const atrExtension = (entry - emaNow) / atr;
  if (atrExtension > IM_MAX_ATR_EXTENSION) return null;

  const initialStop = entry - IM_ATR_STOP_MULT * atr;
  if (!(initialStop > 0) || !(initialStop < entry)) return null;
  const stopDistanceBps = ((entry - initialStop) / entry) * 10000;
  if (!(stopDistanceBps > 0)) return null;

  return { entryPrice: entry, initialStop, stopDistanceBps, atrAtEntry: atr, rocAtEntry, breakoutHigh, volumeRatio, atrExtension };
}

/**
 * Resolve an OPEN observation by walking 1h candles AFTER openedAtMs with the MFE-giveback exit:
 *  - initial stop protects the position (hit low ≤ stop → CLOSED_LOSS at the stop);
 *  - track the peak favorableR from bar HIGHS; once peak ≥ IM_MFE_ARM_R, if a later bar's favorableR
 *    (from its close) falls to peak×(1−GIVEBACK_FRAC), bank at that level (MFE_GIVEBACK);
 *  - else at MAX_HOLD bars, mark-to-market on the last close.
 * No intrabar lookahead beyond the standard stop-before-peak convention. Returns the patch or null.
 */
export function resolveIntradayMomentum(
  obs: IntradayMomentumObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<IntradayMomentumObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<IntradayMomentumObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<IntradayMomentumObservation> => {
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
    // Stop first (conservative): if the bar's low pierced the initial stop, book the loss.
    if (c.low <= obs.initialStop) {
      const grossR = (obs.initialStop - obs.entryPrice) / risk; // = −1
      return finalize(grossR, c.openTime, "INITIAL_STOP", peakR);
    }
    // Update peak from the bar high (favorable excursion).
    const barPeakR = (c.high - obs.entryPrice) / risk;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= IM_MFE_ARM_R) armed = true;
    // Once armed, bank on a close that has given back GIVEBACK_FRAC of the peak.
    if (armed) {
      const closeR = (c.close - obs.entryPrice) / risk;
      const givebackLine = peakR * (1 - IM_MFE_GIVEBACK_FRAC);
      if (closeR <= givebackLine) {
        return finalize(closeR, c.openTime, "MFE_GIVEBACK", peakR);
      }
    }
    // Max hold → mark-to-market.
    if (i + 1 >= IM_MAX_HOLD_BARS) {
      const grossR = (c.close - obs.entryPrice) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM", peakR);
    }
  }
  // Not enough forward candles yet AND long past the hold window → expire (stale, un-resolvable).
  if (fwd.length === 0 && nowMs - obs.openedAtMs > IM_MAX_HOLD_BARS * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
interface IMState {
  version: number;
  observations: IntradayMomentumObservation[];
}

export class IntradayMomentumStore {
  private state: IMState = { version: 1, observations: [] };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<IMState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as IntradayMomentumObservation[];
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): IntradayMomentumObservation[] {
    return this.state.observations;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: IntradayMomentumObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<IntradayMomentumObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

let singleton: IntradayMomentumStore | null = null;
export function getIntradayMomentumStore(dataDir = "data"): IntradayMomentumStore {
  if (!singleton) singleton = new IntradayMomentumStore(resolve(dataDir, "intraday-momentum-edge.json"));
  return singleton;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface IMCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
}

export async function runIntradayMomentumCycle(opts: {
  store: IntradayMomentumStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this (one per bar). */
  dedupeWindowMs?: number;
  /**
   * Optional report-only enrichment, called ONLY for a symbol that just produced a signal (not the
   * whole universe every cycle — keeps API load bounded). Never affects whether the signal is
   * recorded; a throw or a null return just leaves the enrichment fields unset.
   */
  enrichSignal?: (symbol: string, signal: IntradayMomentumSignal) => Promise<{ takerBuyRatio?: number | null; spreadBps?: number | null; decisionScore?: number | null } | null>;
}): Promise<IMCycleResult> {
  const result: IMCycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0 };
  const dedupeMs = opts.dedupeWindowMs ?? 3_600_000; // 1h (one signal per symbol per bar)

  // 1. resolve OPEN observations with forward candles.
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of opts.universe) {
    try {
      const candles = await opts.fetchCandles(symbol);
      candlesBySymbol.set(symbol, candles);
    } catch {
      /* skip this symbol this cycle */
    }
  }
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol);
    if (!candles) continue;
    const patch = resolveIntradayMomentum(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. record new entries.
  for (const symbol of opts.universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;
    const signal = detectIntradayMomentumEntry(candles);
    if (!signal) continue;
    let enrichment: { takerBuyRatio?: number | null; spreadBps?: number | null; decisionScore?: number | null } | null = null;
    if (opts.enrichSignal) {
      try {
        enrichment = await opts.enrichSignal(symbol, signal);
      } catch {
        enrichment = null; // enrichment must never block or fail the recording itself
      }
    }
    const observationId = `im:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...signal,
      observationId,
      symbol,
      direction: "LONG",
      openedAt: new Date(opts.now).toISOString(),
      openedAtMs: opts.now,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
      takerBuyRatioAtEntry: enrichment?.takerBuyRatio ?? null,
      spreadBpsAtEntry: enrichment?.spreadBps ?? null,
      decisionScoreAtEntry: enrichment?.decisionScore ?? null,
    });
    if (added) result.recorded += 1;
  }

  opts.store.save();
  return result;
}

export async function runIntradayMomentumCycleGuarded(opts: Parameters<typeof runIntradayMomentumCycle>[0]): Promise<IMCycleResult | null> {
  try {
    return await runIntradayMomentumCycle(opts);
  } catch {
    return null;
  }
}

// ── report ──────────────────────────────────────────────────────────────────
export interface IntradayMomentumReport {
  laneId: string;
  interval: string;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  avgMaxFavorableR: number | null;
  mfeGivebackShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string }>;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildIntradayMomentumReport(observations: readonly IntradayMomentumObservation[]): IntradayMomentumReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const mfeGiveback = resolved.filter((o) => o.exitReason === "MFE_GIVEBACK").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = mean(nets);
  // edge-ready = enough sample AND positive net AND a real payoff (winners bigger than the cost).
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({ symbol: o.symbol, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt }));

  return {
    laneId: IM_PAPER_LANE_ID,
    interval: IM_INTERVAL,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    avgMaxFavorableR: mean(resolved.map((o) => o.maxFavorableR).filter(finite)),
    mfeGivebackShare: resolved.length ? mfeGiveback / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    topRecent,
  };
}

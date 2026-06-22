// Fade-long edge (mean-reversion BUY-THE-DIP) — a real signal lane, NOT a shadow validator.
//
// The 2026-06-22 audit proved the bot's LONG side has no edge because every long CHASES
// (entryDrift median +4 ATR, zero dips) in a mean-reverting market → 49% stop out, even
// when the market rises. The symmetric of the working short-fade (sell overbought, ~86% WR)
// is the LONG-FADE: BUY oversold dips. A non-overfit RSI backtest confirmed it: entries at
// RSI(14)<30 returned +0.41%/2h at 63% WR over n=1389, UNIVERSAL across symbols and STRONGEST
// on the very high-beta alts that bled as chase-longs (WLD +1.61%, FET +0.55%). So the alt-long
// bleed was a CHASE problem, not the alts.
//
// This module is the new entry signal the chase-based scanner can't produce. It records oversold
// fade-long observations on the universe each cycle and resolves them by candle-walk, accumulating
// OOS exactly like a variant lane. Geometry + cost mirror the variant matrix (honest costR =
// round-trip bps / stop bps, extra stop-out slippage on losers). All knobs env-tunable.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Candle } from "@dtc/shared";
import { TAKER_ROUNDTRIP_BPS, STOP_OUT_SLIPPAGE_BPS, WATCHABLE_MIN_FRESH } from "./current-guard-variant-matrix.js";

export const FADE_LONG_RSI_PERIOD = 14;
export const FADE_LONG_RSI_THRESHOLD = Number(process.env.FADE_LONG_RSI_THRESHOLD) || 30;
export const FADE_LONG_STOP_PCT = Number(process.env.FADE_LONG_STOP_PCT) || 0.015; // 1.5% stop below entry
export const FADE_LONG_TP_PCT = Number(process.env.FADE_LONG_TP_PCT) || 0.0075; // +0.75% mean-revert bounce target
export const FADE_LONG_MAX_HOLD_BARS = Number(process.env.FADE_LONG_MAX_HOLD_BARS) || 8; // 2h on 15m
const FADE_LONG_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Wilder RSI on close prices. Returns array aligned to closes (null until enough data). */
export function computeRSI(closes: number[], period = FADE_LONG_RSI_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface FadeLongObservation {
  observationId: string;
  symbol: string;
  rsiAtEntry: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  stopDistanceBps: number;
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  resolvedAt: string | null;
}

/** Detect a fresh oversold fade-long entry from a symbol's candles (RSI crosses DOWN < threshold
 *  on the latest closed bar). Returns null when not a fresh oversold cross. */
export function detectFadeLongEntry(symbol: string, candles: Candle[], nowMs: number): FadeLongObservation | null {
  if (candles.length < FADE_LONG_RSI_PERIOD + 2) return null;
  const closes = candles.map((c) => c.close);
  const rsi = computeRSI(closes);
  const i = closes.length - 1;
  const r = rsi[i];
  const rPrev = rsi[i - 1];
  if (r === null || r >= FADE_LONG_RSI_THRESHOLD) return null;
  // Fresh cross only (prev bar not already oversold) so we don't re-signal every bar of a deep dip.
  if (rPrev !== null && rPrev < FADE_LONG_RSI_THRESHOLD) return null;
  const entry = closes[i];
  if (!(entry > 0)) return null;
  return {
    observationId: `fadelong:${symbol}:${candles[i].openTime}`,
    symbol,
    rsiAtEntry: r,
    entryPrice: entry,
    stopLoss: entry * (1 - FADE_LONG_STOP_PCT),
    takeProfit: entry * (1 + FADE_LONG_TP_PCT),
    stopDistanceBps: FADE_LONG_STOP_PCT * 10000,
    openedAt: new Date(nowMs).toISOString(),
    openedAtMs: nowMs,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    resolvedAt: null,
  };
}

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/** Resolve an OPEN fade-long by walking candles AFTER openedAtMs: stop/TP first, else mark-to-market
 *  at FADE_LONG_MAX_HOLD_BARS. Returns the resolved patch, or null if still open (not enough candles). */
export function resolveFadeLong(
  obs: FadeLongObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<FadeLongObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.stopLoss;
  const reward = obs.takeProfit - obs.entryPrice;
  if (!(risk > 0)) return null;
  const finalize = (status: "CLOSED_WIN" | "CLOSED_LOSS", grossR: number, atMs: number): Partial<FadeLongObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return { status, grossR, costR, netR, resolvedAt: new Date(atMs).toISOString() };
  };
  for (let k = 0; k < Math.min(fwd.length, FADE_LONG_MAX_HOLD_BARS); k++) {
    const c = fwd[k];
    const hitStop = c.low <= obs.stopLoss;
    const hitTp = c.high >= obs.takeProfit;
    if (hitStop) return finalize("CLOSED_LOSS", -1, c.openTime); // ambiguous same-bar → stop first (conservative)
    if (hitTp) return finalize("CLOSED_WIN", reward / risk, c.openTime);
  }
  if (fwd.length >= FADE_LONG_MAX_HOLD_BARS) {
    const c = fwd[FADE_LONG_MAX_HOLD_BARS - 1];
    const grossR = (c.close - obs.entryPrice) / risk;
    return finalize(grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS", grossR, c.openTime);
  }
  // Stale OPEN past the expiry window with no resolution → EXPIRED (excluded from freshValid).
  if (nowMs - obs.openedAtMs > FADE_LONG_EXPIRY_MS) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null;
}

export interface FadeLongReport {
  freshValid: number;
  open: number;
  expired: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  watchableThreshold: number;
  status: "COLLECTING" | "WATCHABLE";
  totalNetR: number;
}

export function buildFadeLongReport(observations: readonly FadeLongObservation[]): FadeLongReport {
  const resolved = observations.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
  );
  const nets = resolved.map((o) => o.netR as number);
  const grosses = resolved.map((o) => (typeof o.grossR === "number" ? o.grossR : 0));
  const wins = nets.filter((r) => r > 0).length;
  const pfNum = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const pfDen = -nets.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const freshValid = resolved.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    freshValid,
    open: observations.filter((o) => o.status === "OPEN").length,
    expired: observations.filter((o) => o.status === "EXPIRED").length,
    netAvgR: mean(nets),
    grossAvgR: mean(grosses),
    pf: pfDen > 0 ? pfNum / pfDen : pfNum > 0 ? 999 : null,
    wr: freshValid ? wins / freshValid : null,
    watchableThreshold: WATCHABLE_MIN_FRESH,
    status: freshValid >= WATCHABLE_MIN_FRESH ? "WATCHABLE" : "COLLECTING",
    totalNetR: nets.reduce((a, b) => a + b, 0),
  };
}

interface FadeLongState {
  version: number;
  observations: FadeLongObservation[];
}

export class FadeLongStore {
  private state: FadeLongState = { version: 1, observations: [] };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<FadeLongState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as FadeLongObservation[];
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): FadeLongObservation[] {
    return this.state.observations;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: FadeLongObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<FadeLongObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

let singleton: FadeLongStore | null = null;
export function getFadeLongStore(dataDir = "data"): FadeLongStore {
  if (!singleton) singleton = new FadeLongStore(resolve(dataDir, "fade-long-edge.json"));
  return singleton;
}

export interface FadeLongCycleResult {
  scanned: number;
  newEntries: number;
  resolved: number;
  report: FadeLongReport;
}

/** One headless cycle: scan the universe for fresh oversold dips (record new fade-long observations)
 *  and resolve OPEN ones by candle-walk. A single per-symbol candle fetch (closed bars only) feeds both
 *  detection and resolution, so callers pass one `fetchCandles(symbol)`. Report-only — never touches the
 *  paper book, live engine, or any strategy gate; it is a measurement lane like the variant matrix.
 *  Resilient: a per-symbol fetch error skips that symbol; the whole cycle never throws. */
export async function runFadeLongCycle(opts: {
  store: FadeLongStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  now: number;
  maxSymbols?: number;
}): Promise<FadeLongCycleResult> {
  const { store, universe, fetchCandles, now } = opts;
  const symbols = opts.maxSymbols ? universe.slice(0, opts.maxSymbols) : universe;
  let scanned = 0;
  let newEntries = 0;
  let resolved = 0;
  for (const symbol of symbols) {
    let candles: Candle[];
    try {
      candles = await fetchCandles(symbol);
    } catch {
      continue;
    }
    if (!candles || candles.length === 0) continue;
    candles.sort((a, b) => a.openTime - b.openTime);
    // Drop the final (potentially in-progress) bar so detection and resolution use confirmed-closed bars only.
    const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
    if (closed.length === 0) continue;
    scanned++;
    const entry = detectFadeLongEntry(symbol, closed, now);
    if (entry && store.add(entry)) newEntries++;
    for (const obs of store.all) {
      if (obs.symbol !== symbol || obs.status !== "OPEN") continue;
      const patch = resolveFadeLong(obs, closed, now);
      if (patch) {
        store.update(obs.observationId, patch);
        if (patch.status !== "OPEN") resolved++;
      }
    }
  }
  store.save();
  return { scanned, newEntries, resolved, report: buildFadeLongReport(store.all) };
}

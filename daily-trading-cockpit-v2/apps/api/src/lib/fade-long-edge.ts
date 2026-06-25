// Fade-long edge (mean-reversion BUY-THE-DIP) — quarantined research lane, NOT a shadow validator.
//
// The 2026-06-22 audit proved the bot's LONG side has no edge because every long CHASES
// (entryDrift median +4 ATR, zero dips) in a mean-reverting market → 49% stop out, even
// when the market rises. The symmetric of the working short-fade (sell overbought, ~86% WR)
// is the LONG-FADE: BUY oversold dips. A non-overfit RSI backtest confirmed it: entries at
// RSI(14)<30 returned +0.41%/2h at 63% WR over n=1389, UNIVERSAL across symbols and STRONGEST
// on the very high-beta alts that bled as chase-longs (WLD +1.61%, FET +0.55%). So the alt-long
// bleed was a CHASE problem, not the alts.
//
// The follow-up audit concluded that generic RSI dip-buy is solving the wrong long problem: it
// needs panic/washout/reclaim structure, not naked oversold. Keep the module for historical OOS and
// future panic-reclaim research, but quarantine it by default so it no longer competes with H6.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Candle } from "@dtc/shared";
import { TAKER_ROUNDTRIP_BPS, STOP_OUT_SLIPPAGE_BPS, WATCHABLE_MIN_FRESH } from "./current-guard-variant-matrix.js";

export const FADE_LONG_RSI_PERIOD = 14;
export const FADE_LONG_RESEARCH_QUARANTINED = process.env.FADE_LONG_RESEARCH_QUARANTINED !== "0";
export const FADE_LONG_RSI_THRESHOLD = Number(process.env.FADE_LONG_RSI_THRESHOLD) || 30;
export const FADE_LONG_STOP_PCT = Number(process.env.FADE_LONG_STOP_PCT) || 0.015; // 1.5% stop below entry
export const FADE_LONG_TP_PCT = Number(process.env.FADE_LONG_TP_PCT) || 0.0075; // +0.75% mean-revert bounce target
export const FADE_LONG_MAX_HOLD_BARS = Number(process.env.FADE_LONG_MAX_HOLD_BARS) || 8; // 2h on 15m
// How many recent closed bars each cycle scans for fresh oversold crosses. The cycle runs every
// ~7min but a cross is only "fresh" on ONE bar; checking only the latest bar silently missed almost
// every cross (80 real crosses → 0 recorded). Scanning a lookback window means any successful run
// captures every cross in the window (deduped by bar), robust to cadence + intermittent fetch load.
export const FADE_LONG_LOOKBACK_BARS = Number(process.env.FADE_LONG_LOOKBACK_BARS) || 24; // ~6h on 15m
const FADE_LONG_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export const FADE_LONG_ANTI_CRASH_MIN_BREADTH_SYMBOLS = envNum("FADE_LONG_ANTI_CRASH_MIN_BREADTH_SYMBOLS", 8);
export const FADE_LONG_ANTI_CRASH_DOWN_1H_PCT = envNum("FADE_LONG_ANTI_CRASH_DOWN_1H_PCT", 70);
export const FADE_LONG_ANTI_CRASH_CLUSTER_DOWN_1H_PCT = envNum("FADE_LONG_ANTI_CRASH_CLUSTER_DOWN_1H_PCT", 60);
export const FADE_LONG_ANTI_CRASH_MEDIAN_1H_RETURN_PCT = envNum("FADE_LONG_ANTI_CRASH_MEDIAN_1H_RETURN_PCT", -0.5);
export const FADE_LONG_ANTI_CRASH_BTC_ETH_1H_RETURN_PCT = envNum("FADE_LONG_ANTI_CRASH_BTC_ETH_1H_RETURN_PCT", -0.5);
export const FADE_LONG_ANTI_CRASH_SIGNAL_CLUSTER_MIN = envNum("FADE_LONG_ANTI_CRASH_SIGNAL_CLUSTER_MIN", 6);

export interface FadeLongAntiCrashSnapshot {
  version: "fade-long-anti-crash-v1";
  capturedAt: string;
  universeCount: number;
  down15mPct: number | null;
  down1hPct: number | null;
  median15mReturnPct: number | null;
  median1hReturnPct: number | null;
  btc1hReturnPct: number | null;
  eth1hReturnPct: number | null;
  freshSignalCluster: number;
  wouldBlock: boolean;
  reasons: string[];
}

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
  /**
   * Measurement-only anti-crash/breadth label at the signal bar. This is NOT a
   * hard gate; it lets us compare "would have blocked" vs pass cohorts before
   * turning any crash filter into live behavior.
   */
  antiCrash?: FadeLongAntiCrashSnapshot | null;
}

/** Build a fade-long observation for the fresh oversold cross at bar index `i` (entry = that bar's
 *  close). openedAt is the BAR's time (not "now") so a cross detected from the lookback window
 *  resolves by walking the candles AFTER it — not from the cycle's wall-clock. */
function buildFadeLongObs(symbol: string, candles: Candle[], i: number, rsiAtEntry: number): FadeLongObservation {
  const entry = candles[i]!.close;
  const openedAtMs = candles[i]!.openTime;
  return {
    observationId: `fadelong:${symbol}:${openedAtMs}`,
    symbol,
    rsiAtEntry,
    entryPrice: entry,
    stopLoss: entry * (1 - FADE_LONG_STOP_PCT),
    takeProfit: entry * (1 + FADE_LONG_TP_PCT),
    stopDistanceBps: FADE_LONG_STOP_PCT * 10000,
    openedAt: new Date(openedAtMs).toISOString(),
    openedAtMs,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    resolvedAt: null,
  };
}

/** Is bar index `i` a FRESH oversold cross (RSI crosses DOWN < threshold; prev bar not already
 *  oversold, so a deep multi-bar dip yields one signal, not one per bar)? */
function isFreshOversoldCross(rsi: (number | null)[], closes: number[], i: number): boolean {
  const r = rsi[i];
  const rPrev = rsi[i - 1];
  if (r === null || r >= FADE_LONG_RSI_THRESHOLD) return false;
  if (rPrev === null || rPrev < FADE_LONG_RSI_THRESHOLD) return false;
  return closes[i]! > 0;
}

/** Detect a fresh oversold fade-long entry on the LATEST closed bar (or null). Kept for the unit
 *  tests / single-bar callers; the cycle uses {@link detectFadeLongEntries} over a lookback window. */
export function detectFadeLongEntry(symbol: string, candles: Candle[], _nowMs: number): FadeLongObservation | null {
  if (candles.length < FADE_LONG_RSI_PERIOD + 2) return null;
  const closes = candles.map((c) => c.close);
  const rsi = computeRSI(closes);
  const i = closes.length - 1;
  if (!isFreshOversoldCross(rsi, closes, i)) return null;
  return buildFadeLongObs(symbol, candles, i, rsi[i] as number);
}

/** Scan the last `lookbackBars` closed bars for fresh oversold crosses, returning one observation
 *  per cross. This is what the cycle uses: the old single-latest-bar check silently missed almost
 *  every transient cross (a cross is "fresh" on only one bar, caught only if a 7-min tick landed
 *  exactly while that bar was newest). Scanning the window makes each run catch every recent cross. */
export function detectFadeLongEntries(
  symbol: string,
  candles: Candle[],
  lookbackBars = FADE_LONG_LOOKBACK_BARS,
): FadeLongObservation[] {
  if (candles.length < FADE_LONG_RSI_PERIOD + 2) return [];
  const closes = candles.map((c) => c.close);
  const rsi = computeRSI(closes);
  const out: FadeLongObservation[] = [];
  const start = Math.max(FADE_LONG_RSI_PERIOD + 1, closes.length - Math.max(1, lookbackBars));
  for (let i = start; i < closes.length; i += 1) {
    if (isFreshOversoldCross(rsi, closes, i)) out.push(buildFadeLongObs(symbol, candles, i, rsi[i] as number));
  }
  return out;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function median(xs: number[]): number | null {
  const values = xs.filter(finite).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

function candleIndexAtOrBefore(candles: readonly Candle[], atMs: number): number {
  let out = -1;
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i]!.openTime <= atMs) out = i;
    else break;
  }
  return out;
}

function returnPct(candles: readonly Candle[], endIdx: number, lookbackBars: number): number | null {
  const startIdx = endIdx - lookbackBars;
  if (startIdx < 0) return null;
  const start = candles[startIdx]?.close;
  const end = candles[endIdx]?.close;
  if (!(finite(start) && start > 0 && finite(end))) return null;
  return ((end - start) / start) * 100;
}

export function buildFadeLongAntiCrashSnapshot(args: {
  candlesBySymbol: ReadonlyMap<string, readonly Candle[]>;
  atMs: number;
  freshSignalCluster: number;
}): FadeLongAntiCrashSnapshot {
  const oneBarReturns: number[] = [];
  const oneHourReturns: number[] = [];
  let btc1hReturnPct: number | null = null;
  let eth1hReturnPct: number | null = null;

  for (const [symbol, candles] of args.candlesBySymbol) {
    const idx = candleIndexAtOrBefore(candles, args.atMs);
    if (idx < 1) continue;
    const r15 = returnPct(candles, idx, 1);
    const r1h = returnPct(candles, idx, 4);
    if (r15 !== null) oneBarReturns.push(r15);
    if (r1h !== null) {
      oneHourReturns.push(r1h);
      if (symbol === "BTCUSDT") btc1hReturnPct = r1h;
      if (symbol === "ETHUSDT") eth1hReturnPct = r1h;
    }
  }

  const down15mPct = oneBarReturns.length
    ? (oneBarReturns.filter((r) => r < 0).length / oneBarReturns.length) * 100
    : null;
  const down1hPct = oneHourReturns.length
    ? (oneHourReturns.filter((r) => r < 0).length / oneHourReturns.length) * 100
    : null;
  const median15mReturnPct = median(oneBarReturns);
  const median1hReturnPct = median(oneHourReturns);
  const reasons: string[] = [];

  if (oneHourReturns.length < FADE_LONG_ANTI_CRASH_MIN_BREADTH_SYMBOLS) {
    reasons.push("BREADTH_SAMPLE_TOO_SMALL");
  } else {
    if (
      down1hPct !== null &&
      median1hReturnPct !== null &&
      down1hPct >= FADE_LONG_ANTI_CRASH_DOWN_1H_PCT &&
      median1hReturnPct <= FADE_LONG_ANTI_CRASH_MEDIAN_1H_RETURN_PCT
    ) {
      reasons.push("MARKET_WIDE_1H_DUMP");
    }
    if (
      btc1hReturnPct !== null &&
      eth1hReturnPct !== null &&
      median1hReturnPct !== null &&
      btc1hReturnPct <= FADE_LONG_ANTI_CRASH_BTC_ETH_1H_RETURN_PCT &&
      eth1hReturnPct <= FADE_LONG_ANTI_CRASH_BTC_ETH_1H_RETURN_PCT &&
      median1hReturnPct <= 0
    ) {
      reasons.push("BTC_ETH_BOTH_BREAKING_DOWN");
    }
    if (
      down1hPct !== null &&
      args.freshSignalCluster >= FADE_LONG_ANTI_CRASH_SIGNAL_CLUSTER_MIN &&
      down1hPct >= FADE_LONG_ANTI_CRASH_CLUSTER_DOWN_1H_PCT
    ) {
      reasons.push("OVERSOLD_SIGNAL_CLUSTER");
    }
  }

  return {
    version: "fade-long-anti-crash-v1",
    capturedAt: new Date(args.atMs).toISOString(),
    universeCount: oneHourReturns.length,
    down15mPct,
    down1hPct,
    median15mReturnPct,
    median1hReturnPct,
    btc1hReturnPct,
    eth1hReturnPct,
    freshSignalCluster: args.freshSignalCluster,
    wouldBlock: reasons.some((reason) => reason !== "BREADTH_SAMPLE_TOO_SMALL"),
    reasons,
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
  antiCrash: {
    tagged: number;
    wouldBlock: number;
    pass: number;
    blockedClosed: number;
    blockedNetAvgR: number | null;
    blockedWR: number | null;
    passClosed: number;
    passNetAvgR: number | null;
    passWR: number | null;
    latest: FadeLongAntiCrashSnapshot | null;
  };
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
  const cohortStats = (cohort: readonly FadeLongObservation[]) => {
    const closed = cohort.filter(
      (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
    );
    const rs = closed.map((o) => o.netR as number);
    return {
      closed: closed.length,
      netAvgR: mean(rs),
      wr: closed.length ? closed.filter((o) => (o.netR ?? 0) > 0).length / closed.length : null,
    };
  };
  const antiCrashTagged = observations.filter((o) => o.antiCrash);
  const antiCrashBlocked = antiCrashTagged.filter((o) => o.antiCrash?.wouldBlock);
  const antiCrashPass = antiCrashTagged.filter((o) => o.antiCrash && !o.antiCrash.wouldBlock);
  const blockedStats = cohortStats(antiCrashBlocked);
  const passStats = cohortStats(antiCrashPass);
  const latestAntiCrash = antiCrashTagged
    .slice()
    .sort((a, b) => b.openedAtMs - a.openedAtMs)[0]?.antiCrash ?? null;
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
    antiCrash: {
      tagged: antiCrashTagged.length,
      wouldBlock: antiCrashBlocked.length,
      pass: antiCrashPass.length,
      blockedClosed: blockedStats.closed,
      blockedNetAvgR: blockedStats.netAvgR,
      blockedWR: blockedStats.wr,
      passClosed: passStats.closed,
      passNetAvgR: passStats.netAvgR,
      passWR: passStats.wr,
      latest: latestAntiCrash,
    },
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
  /** When false (regime not bullish), do NOT open new dip-buys — only resolve open ones. The
   *  oversold dip-buy bleeds in choppy/bearish regimes (dips keep dipping); restrict it to bullish. */
  allowNewEntries?: boolean;
}): Promise<FadeLongCycleResult> {
  const { store, universe, fetchCandles, now } = opts;
  const symbols = opts.maxSymbols ? universe.slice(0, opts.maxSymbols) : universe;
  let scanned = 0;
  let newEntries = 0;
  let resolved = 0;
  const candlesBySymbol = new Map<string, Candle[]>();

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
    candlesBySymbol.set(symbol, closed);
  }

  // Open new dip-buys ONLY in a bullish regime (caller-gated). Resolution of OPEN obs always runs.
  if (opts.allowNewEntries !== false) {
    const detectedEntries: FadeLongObservation[] = [];
    for (const [symbol, closed] of candlesBySymbol) {
      // Scan the whole lookback window (not just the latest bar) so a single successful run captures
      // every recent fresh oversold cross — deduped by bar via the store. This is the fix for the
      // cycle silently recording 0 across 80 real crosses.
      detectedEntries.push(...detectFadeLongEntries(symbol, closed));
    }

    const signalClusterByBar = new Map<number, number>();
    for (const entry of detectedEntries) {
      signalClusterByBar.set(entry.openedAtMs, (signalClusterByBar.get(entry.openedAtMs) ?? 0) + 1);
    }

    for (const entry of detectedEntries) {
      const antiCrash = buildFadeLongAntiCrashSnapshot({
        candlesBySymbol,
        atMs: entry.openedAtMs,
        freshSignalCluster: signalClusterByBar.get(entry.openedAtMs) ?? 1,
      });
      const taggedEntry: FadeLongObservation = { ...entry, antiCrash };
      const added = store.add(taggedEntry);
      if (added) {
        newEntries++;
      } else {
        const existing = store.all.find((obs) => obs.observationId === entry.observationId);
        if (existing && !existing.antiCrash) store.update(existing.observationId, { antiCrash });
      }
    }
  }

  for (const [symbol, closed] of candlesBySymbol) {
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

let cycleInFlight = false;
export function isFadeLongCycleInFlight(): boolean {
  return cycleInFlight;
}

/** Overlap-guarded wrapper: returns null immediately if a cycle is already running. Lets the
 *  operator-brief fire the cycle fire-and-forget (it surfaces via the separate neural-map endpoint,
 *  so the brief must never block on it) without two cycles racing on the singleton store. */
export async function runFadeLongCycleGuarded(opts: {
  store: FadeLongStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  now: number;
  maxSymbols?: number;
  allowNewEntries?: boolean;
}): Promise<FadeLongCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runFadeLongCycle(opts);
  } finally {
    cycleInFlight = false;
  }
}

// H6 trend-following edge (LONG) — a real signal lane, NOT a shadow validator.
//
// The bot's LONG side bleeds because every long CHASES on a short horizon in a mean-reverting
// market (see fade-long-edge.ts). A GPT deep-research pass on crypto trend literature ranked an
// adaptive 6-hour trend lane as the closest thing to an all-weather long core: go long only when
// medium-horizon momentum is positive AND price is in an uptrend structure, then ride it with an
// ATR trailing stop. This is the bot-sized slice of that idea — it keeps the proven let-it-run
// exit (CG_WIDE_LONG_RUNNER) but adds the missing piece: a TREND GATE on entry, so it only longs
// names that are actually trending instead of every dip/chase.
//
// Like fade-long, this is the new entry signal the chase-based scanner can't produce. It records
// fresh-uptrend entries on the universe each cycle (6h candles) and resolves them by candle-walk
// with an ATR chandelier trail, accumulating OOS exactly like a variant lane. Honest cost model
// (round-trip bps / stop bps + stop-out slippage on losers). Report-only — never touches the
// allocator, paper book, live engine, or any strategy gate. All knobs env-tunable. PROVE OOS
// before any read — literature ≠ this bot's edge (the +0.178R bullish-long seed didn't hold).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Candle } from "@dtc/shared";
import { TAKER_ROUNDTRIP_BPS, STOP_OUT_SLIPPAGE_BPS, WATCHABLE_MIN_FRESH } from "./current-guard-variant-matrix.js";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const H6_TREND_INTERVAL = process.env.H6_TREND_INTERVAL || "6h";
export const H6_TREND_ROC_PERIOD = envNum("H6_TREND_ROC_PERIOD", 20); // momentum lookback (bars)
export const H6_TREND_EMA_FAST_PERIOD = envNum("H6_TREND_EMA_FAST_PERIOD", 30); // trend filter
export const H6_TREND_EMA_SLOW_PERIOD = envNum("H6_TREND_EMA_SLOW_PERIOD", 90); // trend-agreement filter
export const H6_TREND_ATR_PERIOD = envNum("H6_TREND_ATR_PERIOD", 14);
export const H6_TREND_ATR_TRAIL_MULT = Number(process.env.H6_TREND_ATR_TRAIL_MULT) || 2.5; // chandelier offset
// Research A/B: a tighter trail to bank more of the favorable move. The early read showed trades
// reach avg MFE ~+0.9R but net negative — the 2.5-ATR trail gives the move back. This variant runs
// the SAME entries through a tighter 1.5-ATR trail so, once n matures, we have the exit A/B ready.
export const H6_TREND_TIGHT_TRAIL_MULT = Number(process.env.H6_TREND_TIGHT_TRAIL_MULT) || 1.5;
export const H6_TREND_TRAIL_VARIANTS: ReadonlyArray<{ id: "std" | "tight"; mult: number }> = [
  { id: "std", mult: H6_TREND_ATR_TRAIL_MULT },
  { id: "tight", mult: H6_TREND_TIGHT_TRAIL_MULT },
];
// ROC threshold (percent). Default 0 = "momentum positive". Env-tunable to demand stronger momentum.
export const H6_TREND_ROC_THRESHOLD = Number(process.env.H6_TREND_ROC_THRESHOLD ?? 0);
// Max bars to hold before mark-to-market (56 bars ≈ 14 days on 6h) — bounds a trend that never trails out.
export const H6_TREND_MAX_HOLD_BARS = envNum("H6_TREND_MAX_HOLD_BARS", 56);
// Recent closed bars scanned each cycle for fresh trend entries (40 ≈ 10 days on 6h). A wide window
// bootstraps resolvable OOS (older entries already have forward bars to walk); deduped by bar.
export const H6_TREND_LOOKBACK_BARS = envNum("H6_TREND_LOOKBACK_BARS", 40);
const H6_TREND_EXPIRY_MS = 21 * 24 * 60 * 60 * 1000; // trends hold longer than fade-long's 7d

// ── indicators ─────────────────────────────────────────────────────────────
export function computeEMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const mult = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += closes[i];
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * mult + (out[i - 1] as number) * (1 - mult);
  }
  return out;
}

export function computeROC(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period];
    out[i] = prev !== 0 ? ((closes[i] - prev) / prev) * 100 : null;
  }
  return out;
}

export function computeATR(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ── observations ─────────────────────────────────────────────────────────────
export interface H6TrendObservation {
  observationId: string;
  symbol: string;
  direction: "LONG";
  /** Exit-geometry A/B on the SAME entry: "std" (2.5-ATR trail) vs "tight" (1.5-ATR). Older obs
   *  without this field are treated as "std". */
  variant?: "std" | "tight";
  /** ATR-trail multiple for this obs (= stopDistanceBps geometry). Resolution derives the trail
   *  offset from entry−initialStop, so this is informational; defaults to std for older obs. */
  trailMult?: number;
  rocAtEntry: number;
  atrAtEntry: number;
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  maxFavorableR: number | null;
  exitReason: "TRAIL_STOP" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/** Is bar `i` a FRESH uptrend entry — conditions satisfied at `i` but NOT at `i-1` (so a sustained
 *  trend yields one entry, not one per bar)? Conditions: close>EMA_fast, EMA_fast>EMA_slow (uptrend
 *  structure), ROC>threshold (positive momentum). */
function isFreshTrendEntry(
  closes: number[],
  emaFast: (number | null)[],
  emaSlow: (number | null)[],
  roc: (number | null)[],
  i: number,
): boolean {
  const ok = (j: number): boolean => {
    const ef = emaFast[j];
    const es = emaSlow[j];
    const r = roc[j];
    if (ef === null || es === null || r === null) return false;
    return closes[j] > ef && ef > es && r > H6_TREND_ROC_THRESHOLD;
  };
  return ok(i) && !ok(i - 1);
}

function buildH6TrendObs(
  symbol: string,
  candles: Candle[],
  i: number,
  roc: number,
  atr: number,
  variant: "std" | "tight",
  trailMult: number,
): H6TrendObservation {
  const entry = candles[i]!.close;
  const openedAtMs = candles[i]!.openTime;
  const initialStop = entry - trailMult * atr;
  // "std" keeps the original id (dedupes against pre-A/B obs → no double-count); "tight" is namespaced.
  const observationId = variant === "std" ? `h6trend:${symbol}:${openedAtMs}` : `h6trend:${variant}:${symbol}:${openedAtMs}`;
  return {
    observationId,
    symbol,
    direction: "LONG",
    variant,
    trailMult,
    rocAtEntry: roc,
    atrAtEntry: atr,
    entryPrice: entry,
    initialStop,
    stopDistanceBps: ((entry - initialStop) / entry) * 10000,
    openedAt: new Date(openedAtMs).toISOString(),
    openedAtMs,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    maxFavorableR: null,
    exitReason: null,
    resolvedAt: null,
  };
}

/** Scan the lookback window for fresh uptrend entries on confirmed-closed bars. */
export function detectH6TrendEntries(symbol: string, candles: Candle[]): H6TrendObservation[] {
  if (candles.length < H6_TREND_EMA_SLOW_PERIOD + 2) return [];
  const closes = candles.map((c) => c.close);
  const emaFast = computeEMA(closes, H6_TREND_EMA_FAST_PERIOD);
  const emaSlow = computeEMA(closes, H6_TREND_EMA_SLOW_PERIOD);
  const roc = computeROC(closes, H6_TREND_ROC_PERIOD);
  const atr = computeATR(candles, H6_TREND_ATR_PERIOD);
  const out: H6TrendObservation[] = [];
  const start = Math.max(1, candles.length - H6_TREND_LOOKBACK_BARS);
  for (let i = start; i < candles.length; i++) {
    const a = atr[i];
    if (a === null || !(a > 0)) continue;
    if (isFreshTrendEntry(closes, emaFast, emaSlow, roc, i)) {
      // Emit one obs per exit-trail A/B variant on this same entry (std + tight).
      for (const v of H6_TREND_TRAIL_VARIANTS) {
        out.push(buildH6TrendObs(symbol, candles, i, roc[i] as number, a, v.id, v.mult));
      }
    }
  }
  return out;
}

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/** Resolve an OPEN H6 trend by walking candles AFTER openedAtMs with an ATR chandelier trail:
 *  trailStop = highestHigh(before this bar) - mult*ATR_entry. Exit when a bar's low pierces the trail
 *  (no intrabar lookahead — the trail uses highs strictly BEFORE the current bar, so a bar can't stop
 *  off its own high). Else mark-to-market at MAX_HOLD. Returns the patch, or null if still open. */
export function resolveH6Trend(
  obs: H6TrendObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<H6TrendObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop; // = mult * ATR_entry
  if (!(risk > 0)) return null;
  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<H6TrendObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<H6TrendObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    const status = grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    return { status, grossR, costR, netR, exitReason, maxFavorableR, resolvedAt: new Date(atMs).toISOString() };
  };
  let highestHigh = obs.entryPrice;
  let maxFavorableR = 0;
  const bars = Math.min(fwd.length, H6_TREND_MAX_HOLD_BARS);
  for (let k = 0; k < bars; k++) {
    const c = fwd[k];
    // trail from highs strictly BEFORE this bar (no lookahead). Offset = the obs's own stop distance
    // (entry−initialStop = trailMult×ATR), so std (2.5) and tight (1.5) each trail by their own width.
    const trailStop = highestHigh - risk;
    if (c.low <= trailStop) {
      const grossR = (trailStop - obs.entryPrice) / risk;
      const reason = trailStop <= obs.initialStop ? "INITIAL_STOP" : "TRAIL_STOP";
      return finalize(grossR, c.openTime, reason, Math.max(maxFavorableR, grossR));
    }
    if (c.high > highestHigh) highestHigh = c.high;
    maxFavorableR = Math.max(maxFavorableR, (highestHigh - obs.entryPrice) / risk);
  }
  if (fwd.length >= H6_TREND_MAX_HOLD_BARS) {
    const c = fwd[H6_TREND_MAX_HOLD_BARS - 1];
    const grossR = (c.close - obs.entryPrice) / risk;
    return finalize(grossR, c.openTime, "MAX_HOLD_MTM", maxFavorableR);
  }
  if (nowMs - obs.openedAtMs > H6_TREND_EXPIRY_MS) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null;
}

// ── report ─────────────────────────────────────────────────────────────────
export interface H6TrendVariantStats {
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgMaxFavorableR: number | null;
}
export interface H6TrendReport {
  freshValid: number;
  open: number;
  expired: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgMaxFavorableR: number | null;
  watchableThreshold: number;
  status: "COLLECTING" | "WATCHABLE";
  totalNetR: number;
  /** Research A/B sibling: the tight-trail (1.5-ATR) variant on the SAME entries. The top-level
   *  fields above are the "std" (2.5-ATR) lane (so the dashboard tile shows the primary). */
  tight: H6TrendVariantStats;
}

const _mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function h6VariantStats(observations: readonly H6TrendObservation[]): H6TrendVariantStats {
  const resolved = observations.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
  );
  const nets = resolved.map((o) => o.netR as number);
  const mfes = resolved.map((o) => o.maxFavorableR).filter((r): r is number => typeof r === "number");
  const pfNum = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const pfDen = -nets.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  return {
    freshValid: resolved.length,
    netAvgR: _mean(nets),
    pf: pfDen > 0 ? pfNum / pfDen : pfNum > 0 ? Infinity : null,
    wr: resolved.length > 0 ? nets.filter((r) => r > 0).length / resolved.length : null,
    avgMaxFavorableR: _mean(mfes),
  };
}

export function buildH6TrendReport(observations: readonly H6TrendObservation[]): H6TrendReport {
  // Top-level = the "std" lane (obs with no variant predate the A/B → counted as std).
  const std = observations.filter((o) => (o.variant ?? "std") === "std");
  const tight = observations.filter((o) => o.variant === "tight");
  const s = h6VariantStats(std);
  const resolvedStd = std.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && typeof o.netR === "number",
  );
  return {
    freshValid: s.freshValid,
    open: std.filter((o) => o.status === "OPEN").length,
    expired: std.filter((o) => o.status === "EXPIRED").length,
    netAvgR: s.netAvgR,
    grossAvgR: _mean(resolvedStd.map((o) => (typeof o.grossR === "number" ? o.grossR : 0))),
    pf: s.pf,
    wr: s.wr,
    avgMaxFavorableR: s.avgMaxFavorableR,
    watchableThreshold: WATCHABLE_MIN_FRESH,
    status: s.freshValid >= WATCHABLE_MIN_FRESH ? "WATCHABLE" : "COLLECTING",
    totalNetR: resolvedStd.map((o) => o.netR as number).reduce((a, b) => a + b, 0),
    tight: h6VariantStats(tight),
  };
}

// ── store ─────────────────────────────────────────────────────────────────
interface H6TrendState {
  version: number;
  observations: H6TrendObservation[];
}

export class H6TrendStore {
  private state: H6TrendState = { version: 1, observations: [] };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<H6TrendState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as H6TrendObservation[];
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): H6TrendObservation[] {
    return this.state.observations;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: H6TrendObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<H6TrendObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

let singleton: H6TrendStore | null = null;
export function getH6TrendStore(dataDir = "data"): H6TrendStore {
  if (!singleton) singleton = new H6TrendStore(resolve(dataDir, "h6-trend-edge.json"));
  return singleton;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface H6TrendCycleResult {
  scanned: number;
  newEntries: number;
  resolved: number;
  report: H6TrendReport;
}

/** One headless cycle: scan the universe (6h candles) for fresh uptrend entries and resolve OPEN ones
 *  by candle-walk. Report-only — never touches the paper book, live engine, or any strategy gate.
 *  Resilient: a per-symbol fetch error skips that symbol; the whole cycle never throws. */
export async function runH6TrendCycle(opts: {
  store: H6TrendStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  now: number;
  maxSymbols?: number;
  /** When false (e.g. regime is not bullish), do NOT open new entries — only resolve open ones.
   *  Trend/dip longs only have an edge in a bullish regime; this gates new positions to that. */
  allowNewEntries?: boolean;
}): Promise<H6TrendCycleResult> {
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
    // Drop the final (potentially in-progress) bar so detection + resolution use closed bars only.
    const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
    if (closed.length === 0) continue;
    scanned++;
    candlesBySymbol.set(symbol, closed);
  }

  // Open new entries ONLY in a bullish regime (caller-gated). Resolution of OPEN obs always runs.
  if (opts.allowNewEntries !== false) {
    for (const [symbol, closed] of candlesBySymbol) {
      for (const entry of detectH6TrendEntries(symbol, closed)) {
        if (store.add(entry)) newEntries++;
      }
    }
  }

  for (const [symbol, closed] of candlesBySymbol) {
    for (const obs of store.all) {
      if (obs.symbol !== symbol || obs.status !== "OPEN") continue;
      const patch = resolveH6Trend(obs, closed, now);
      if (patch) {
        store.update(obs.observationId, patch);
        if (patch.status !== "OPEN") resolved++;
      }
    }
  }
  store.save();
  return { scanned, newEntries, resolved, report: buildH6TrendReport(store.all) };
}

let cycleInFlight = false;
export function isH6TrendCycleInFlight(): boolean {
  return cycleInFlight;
}

/** Overlap-guarded wrapper so the 7-min ticker can't stack two cycles on the singleton store. */
export async function runH6TrendCycleGuarded(opts: {
  store: H6TrendStore;
  universe: readonly string[];
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  now: number;
  maxSymbols?: number;
  allowNewEntries?: boolean;
}): Promise<H6TrendCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runH6TrendCycle(opts);
  } finally {
    cycleInFlight = false;
  }
}

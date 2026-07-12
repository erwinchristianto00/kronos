/**
 * Regime-composite confirmation (report-only measurement lane, live-wired 2026-07-09).
 *
 * Built for a specific gap: a broad-based bullish rally where (a) CROSS_SECTIONAL_TREND's
 * long/short relative-momentum basket can't fire (no long-vs-short dispersion — measured scoreGap
 * ~0.0016 vs its 0.035 requirement, because even the SHORT-side allowlist symbols are pumping),
 * and (b) the 3 currently-allocated directional LONG lanes (CG_WIDE_FAST_LONG,
 * CG_WIDE_LONG_RUNNER, CG_MFE_GIVEBACK) can't fire because rotationShortlistGateActive requires
 * per-symbol LONG track record (n>=10) that doesn't exist yet after a long bearish/mixed stretch.
 *
 * This lane sidesteps both gaps by gating on REGIME-LEVEL signals instead of (a) relative
 * cross-sectional dispersion or (b) per-symbol historical proof:
 *   1. Regime axis score (regime-axis-timeline.ts's computeRegimeAxisScore) >= threshold — a
 *      breadth-composite read of how broadly bullish the market is right now.
 *   2. Per-symbol crowdingState (derivatives-crowding.ts) in {NEUTRAL, BUILDING} — i.e. NOT
 *      EXHAUSTING (fragile, late-stage) or UNWINDING (positions being flushed) — funding/OI is an
 *      independent data source (derivatives) from the axis score (spot/breadth), so this is a
 *      second, genuinely different confirmation, not a restatement of the same fact.
 * Fixed small universe (BTC/ETH/SOL — high-liquidity majors only), LONG-only, standalone module
 * (own store/cycle/resolver/report), same "measure before it trades" discipline as every other
 * lane in this codebase.
 *
 * 2026-07-09: operator explicitly requested wiring this straight to LIVE execution with ZERO
 * prior measurement, after being told the gate thresholds (0.35, NEUTRAL/BUILDING) are unvalidated
 * design choices with no sample history behind them — an explicit, informed override of this
 * codebase's established discipline, not an oversight. The measurement/report machinery below
 * still runs in full (so real evidence starts accumulating from trade #1), it just isn't a
 * PRECONDITION for the exec-enable flag this time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import { computeATR } from "./candle-indicators.js";
import { fetchCrowdingSnapshot, type CrowdingSnapshot, type CrowdingState } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import {
  makeMfeGivebackExitPolicy,
  type SingleSymbolExitPolicy,
  type SingleSymbolFreshSignal,
} from "./single-symbol-lane-executor.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const RC_INTERVAL = process.env.REGIME_COMPOSITE_INTERVAL || "1h";
/** Axis score floor (regime-axis-timeline.ts's -1..+1 breadth composite). */
export const RC_AXIS_SCORE_MIN = Number(process.env.REGIME_COMPOSITE_AXIS_SCORE_MIN) || 0.35;
/** crowdingState values that pass the confirmation gate (NOT the fragile/flushing states). */
export const RC_ALLOWED_CROWDING_STATES: ReadonlySet<CrowdingState> = new Set(["NEUTRAL", "BUILDING"]);
export const RC_MAX_STORED_OBSERVATIONS = envNum("REGIME_COMPOSITE_MAX_STORED_OBSERVATIONS", 500);
export const RC_ATR_PERIOD = envNum("REGIME_COMPOSITE_ATR_PERIOD", 14);
/** Initial stop = entry − ATR × this. Wider than the breakout lane's 1.5 — this rides a broader
 *  regime read, not a tight structural level, matching this repo's own wide-stop-for-LONGs finding. */
export const RC_ATR_STOP_MULT = Number(process.env.REGIME_COMPOSITE_ATR_STOP_MULT) || 2;
export const RC_MFE_ARM_R = Number(process.env.REGIME_COMPOSITE_MFE_ARM_R) || 0.75;
export const RC_MFE_GIVEBACK_FRAC = Number(process.env.REGIME_COMPOSITE_MFE_GIVEBACK_FRAC) || 0.5;
export const RC_MAX_HOLD_BARS = envNum("REGIME_COMPOSITE_MAX_HOLD_BARS", 48);
export const RC_MAX_CONCURRENT = envNum("REGIME_COMPOSITE_MAX_CONCURRENT", 3);
export const RC_PAPER_LANE_ID = "REGIME_COMPOSITE_CONFIRMATION_LONG" as const;
/** Small, fixed, high-liquidity universe only — deliberately not the wide scanner universe. */
export const RC_UNIVERSE: readonly string[] = (process.env.REGIME_COMPOSITE_UNIVERSE ?? "BTCUSDT,ETHUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const TAKER_ROUNDTRIP_BPS = 8; // ~0.04% per side, taker in + taker out
const STOP_OUT_SLIPPAGE_BPS = 5; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface RegimeCompositeSignal {
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
  atrAtEntry: number;
  axisScoreAtEntry: number;
  crowdingStateAtEntry: CrowdingState;
  fundingBpsAtEntry: number | null;
}

/**
 * Pure entry gate given an already-fetched axis score + crowding snapshot + closed-candle series
 * (last element = the just-closed bar). Both confirmations must pass; ATR must be computable. No
 * lookahead — uses only closed bars.
 */
export function detectRegimeCompositeEntry(
  candles: Candle[],
  axisScore: number | null,
  crowding: CrowdingSnapshot | null,
): RegimeCompositeSignal | null {
  if (!finite(axisScore) || axisScore < RC_AXIS_SCORE_MIN) return null;
  if (!crowding || !RC_ALLOWED_CROWDING_STATES.has(crowding.crowdingState)) return null;

  const need = RC_ATR_PERIOD + 2;
  if (candles.length < need) return null;
  const last = candles[candles.length - 1]!;
  const entryPrice = last.close;
  if (!(entryPrice > 0)) return null;

  const atrSeries = computeATR(candles, RC_ATR_PERIOD);
  const atr = atrSeries[atrSeries.length - 1];
  if (!finite(atr) || !(atr > 0)) return null;

  const initialStop = entryPrice - RC_ATR_STOP_MULT * atr;
  if (!(initialStop > 0) || !(initialStop < entryPrice)) return null;
  const stopDistanceBps = ((entryPrice - initialStop) / entryPrice) * 10000;
  if (!(stopDistanceBps > 0)) return null;

  return {
    entryPrice,
    initialStop,
    stopDistanceBps,
    atrAtEntry: atr,
    axisScoreAtEntry: axisScore,
    crowdingStateAtEntry: crowding.crowdingState,
    fundingBpsAtEntry: crowding.fundingBps,
  };
}

export interface RegimeCompositeObservation extends RegimeCompositeSignal {
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
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs with the MFE-giveback
 * exit — identical convention to intraday-momentum-edge.ts's resolveIntradayMomentum: stop-first
 * (conservative), track peak favorable-R from bar highs, bank on a close that has given back
 * RC_MFE_GIVEBACK_FRAC of the peak once armed, else mark-to-market at RC_MAX_HOLD_BARS.
 */
export function resolveRegimeCompositeObservation(
  obs: RegimeCompositeObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<RegimeCompositeObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<RegimeCompositeObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<RegimeCompositeObservation> => {
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
      const grossR = (obs.initialStop - obs.entryPrice) / risk; // = −1
      return finalize(grossR, c.openTime, "INITIAL_STOP", peakR);
    }
    const barPeakR = (c.high - obs.entryPrice) / risk;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= RC_MFE_ARM_R) armed = true;
    if (armed) {
      const closeR = (c.close - obs.entryPrice) / risk;
      const givebackLine = peakR * (1 - RC_MFE_GIVEBACK_FRAC);
      if (closeR <= givebackLine) {
        return finalize(closeR, c.openTime, "MFE_GIVEBACK", peakR);
      }
    }
    if (i + 1 >= RC_MAX_HOLD_BARS) {
      const grossR = (c.close - obs.entryPrice) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM", peakR);
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > RC_MAX_HOLD_BARS * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
/** Liveness + funnel counters, same discipline as short-fade-edge.ts's SFCycleMeta — an empty
 *  book must be distinguishable from a dead cycle or a cycle that never sees axis/crowding pass. */
export interface RCCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  axisGateFailTotal: number;
  crowdingGateFailTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: RCCycleMeta = {
  lastCycleAt: null, cycles: 0, axisGateFailTotal: 0, crowdingGateFailTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface RCState {
  version: number;
  observations: RegimeCompositeObservation[];
  cycleMeta?: RCCycleMeta;
}

export class RegimeCompositeStore {
  private state: RCState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<RCState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as RegimeCompositeObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): RegimeCompositeObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): RCCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: RCCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.axisGateFailTotal += result.axisGateFail;
      meta.crowdingGateFailTotal += result.crowdingGateFail;
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
  add(obs: RegimeCompositeObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<RegimeCompositeObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most RC_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled observations are dropped first once that cap is exceeded.
   *  2026-07-11 OOM audit fix. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > RC_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - RC_MAX_STORED_OBSERVATIONS) : settled;
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

let singleton: RegimeCompositeStore | null = null;
export function getRegimeCompositeStore(dataDir = "data"): RegimeCompositeStore {
  if (!singleton) singleton = new RegimeCompositeStore(resolve(dataDir, "regime-composite-edge.json"));
  return singleton;
}

export function _resetRegimeCompositeStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface RCCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  axisGateFail: number;
  crowdingGateFail: number;
}

export async function runRegimeCompositeCycle(opts: {
  store: RegimeCompositeStore;
  universe?: readonly string[];
  now: number;
  axisScore: number | null;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
  maxConcurrent?: number;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<RCCycleResult> {
  const result: RCCycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, axisGateFail: 0, crowdingGateFail: 0 };
  const universe = opts.universe ?? RC_UNIVERSE;
  const maxConcurrent = opts.maxConcurrent ?? RC_MAX_CONCURRENT;
  const dedupeMs = opts.dedupeWindowMs ?? 3_600_000; // 1h (one signal per symbol per bar)
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
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol);
    if (!candles) continue;
    const patch = resolveRegimeCompositeObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. axis gate first (cheap, one read, applies to every symbol this cycle) — if it fails,
  //    don't even fetch crowding snapshots (bounds API load, same discipline as short-fade-edge's
  //    RSI-before-crowding ordering).
  if (!finite(opts.axisScore) || opts.axisScore < RC_AXIS_SCORE_MIN) {
    result.axisGateFail = universe.length;
    opts.store.recordCycle(nowIso, result);
    opts.store.save();
    return result;
  }

  // 3. record new entries: per-symbol crowding confirmation, then the ATR/candle gate.
  for (const symbol of universe) {
    result.scanned += 1;
    const openNow = opts.store.all.filter((o) => o.status === "OPEN").length;
    if (openNow >= maxConcurrent) break; // lane-local concurrency cap (own book, own universe)
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;

    let crowding: CrowdingSnapshot | null = null;
    try {
      crowding = await fetchCrowdingSnapshot(opts.crowdingClient, symbol, nowIso);
    } catch {
      crowding = null;
    }
    if (!crowding || !RC_ALLOWED_CROWDING_STATES.has(crowding.crowdingState)) {
      result.crowdingGateFail += 1;
      continue;
    }

    const signal = detectRegimeCompositeEntry(candles, opts.axisScore, crowding);
    if (!signal) continue;

    const observationId = `rc:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...signal,
      observationId,
      symbol,
      direction: "LONG",
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

export async function runRegimeCompositeCycleGuarded(opts: Parameters<typeof runRegimeCompositeCycle>[0]): Promise<RCCycleResult | null> {
  try {
    return await runRegimeCompositeCycle(opts);
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
export interface RegimeCompositeReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  axisScoreMin: number;
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
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string; axisScoreAtEntry: number; crowdingStateAtEntry: CrowdingState }>;
  cycleMeta: RCCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildRegimeCompositeReport(
  observations: readonly RegimeCompositeObservation[],
  cycleMeta?: RCCycleMeta,
): RegimeCompositeReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const mfeGiveback = resolved.filter((o) => o.exitReason === "MFE_GIVEBACK").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = mean(nets);
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({ symbol: o.symbol, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt, axisScoreAtEntry: o.axisScoreAtEntry, crowdingStateAtEntry: o.crowdingStateAtEntry }));

  return {
    laneId: RC_PAPER_LANE_ID,
    interval: RC_INTERVAL,
    universe: RC_UNIVERSE,
    axisScoreMin: RC_AXIS_SCORE_MIN,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    mfeGivebackShare: resolved.length ? mfeGiveback / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

// ── live execution wiring (2026-07-09) ──────────────────────────────────────
// Adapters for single-symbol-lane-executor.ts's generic executor. This lane stays a pure
// measurement module above this line — these two functions are the ONLY seam connecting it to
// real execution, and neither one changes what gets recorded/resolved for OOS measurement.

/** This lane's OPEN observations → the generic single-symbol executor's common signal shape. */
export function regimeCompositeOpenSignals(store: RegimeCompositeStore): SingleSymbolFreshSignal[] {
  return store.all
    .filter((o) => o.status === "OPEN")
    .map((o) => ({
      observationId: o.observationId,
      symbol: o.symbol,
      entryPrice: o.entryPrice,
      stopPrice: o.initialStop,
      openedAtMs: o.openedAtMs,
    }));
}

/** Same exit geometry as the paper measurement (resolveRegimeCompositeObservation): arm once peak
 *  favorable-R ≥ RC_MFE_ARM_R, bank on a retrace of RC_MFE_GIVEBACK_FRAC of the peak, stop at
 *  initialStop, RC_MAX_HOLD_BARS (@ 1h bars) mark-to-market fallback. */
export function regimeCompositeExitPolicy(): SingleSymbolExitPolicy {
  return makeMfeGivebackExitPolicy({
    armR: RC_MFE_ARM_R,
    givebackFrac: RC_MFE_GIVEBACK_FRAC,
    maxHoldMs: RC_MAX_HOLD_BARS * 3_600_000,
  });
}

/** Own enable flag (2026-07-09), independent of every other executor's flag — this lane never
 *  executed a real order before this date, so turning it on must be an explicit, separate act,
 *  same convention as every other executor in this codebase. */
export function isRegimeCompositeExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGIME_COMPOSITE_EXEC_ENABLED === "1";
}
/** 2026-07-09: raised twice today. First 40->60 for BTCUSDT's real $50 MIN_NOTIONAL. Still not
 *  enough: BTC's stepSize is 0.001 — at its real live price (~$62,840) ONE stepSize unit alone
 *  costs ~$63 notional, so $60 rawQty floors DOWN TO ZERO (qty < minQty) and the entry is silently
 *  skipped — confirmed live (BTC never opened while ETH/SOL did, same cycle, same legUsd). 130
 *  clears ~2 stepSize units at current price with headroom for further appreciation before this
 *  needs bumping again; ETH/SOL's much smaller stepSize/price ratio was never the constraint. A
 *  genuinely robust fix would size legUsd PER SYMBOL rather than flat across a universe with very
 *  different stepSize-to-price ratios — flagged as a follow-up, not done here to stay minimal. */
export const RC_EXEC_LEG_USD = (): number => {
  const n = Number.parseFloat(process.env.REGIME_COMPOSITE_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 130;
};
export const RC_EXEC_LEVERAGE = (): number => {
  const n = Number.parseInt(process.env.REGIME_COMPOSITE_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
export const RC_EXEC_MAX_SIGNAL_AGE_MS = (): number =>
  Math.max(60_000, Math.floor(Number(process.env.REGIME_COMPOSITE_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
export const RC_EXEC_DAILY_MAX_LOSS_USD = (): number => {
  const n = Number.parseFloat(process.env.REGIME_COMPOSITE_EXEC_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8;
};
export const RC_EXEC_MAX_CONCURRENT = (): number => {
  const n = Number.parseInt(process.env.REGIME_COMPOSITE_EXEC_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RC_MAX_CONCURRENT;
};

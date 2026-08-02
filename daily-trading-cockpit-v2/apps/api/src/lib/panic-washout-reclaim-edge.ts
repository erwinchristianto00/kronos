/**
 * PANIC / WASHOUT / RECLAIM — LONG-side capitulation-reversal fade (measurement + live-wired lane).
 *
 * Built 2026-07-09 from the operator's own idea ("look at indicators of a coin about to moon or
 * crash, enter there, once it bounces, TP"). This codebase already has the SHORT half of that idea
 * live (short-fade-edge.ts: fade a crowded-long pump top). The LONG half, in its naive form (RSI<30
 * dip-buy, no confirmation), was already built, deployed, measured on 61 real observations, and
 * found NET NEGATIVE (avgNetR -0.368, 51% win rate but losers bigger than winners — a falling-knife
 * problem: entering ON the panic bar with a sub-1:1 payoff) — see fade-long-edge.ts's git history
 * (removed 2026-07-06, commit 5b84247). That module's own retrospective comment diagnosed the fix:
 * "generic RSI dip-buy is solving the wrong long problem; it needs panic/washout/reclaim structure,
 * not naked oversold." This module IS that fix — three conjunctive stages instead of one indicator:
 *
 *  1. PANIC bar: a genuine capitulation/blowoff-down candle — range >= PANIC_ATR_MULT × ATR(14) AND
 *     volume >= PANIC_VOLUME_MULT × volumeSMA(20) on a down bar. Not just "RSI crossed a line."
 *  2. WASHOUT: RSI(14) drops below WASHOUT_RSI_MAX (deeper than the old lane's <30, filtering for
 *     real capitulation) at or shortly after the panic bar, AND derivatives-crowding.ts's
 *     classifyCrowdingState() reads UNWINDING (OI falling — leveraged positions being forced out,
 *     not just extended). Reuses fetchCrowdingSnapshot, no new Binance surface.
 *  3. RECLAIM: do NOT enter on the panic bar itself (that's catching the falling knife, exactly
 *     fade-long-edge.ts's old mistake). Enter only once price closes back ABOVE the panic bar's OWN
 *     high — confirmation the bounce has actually started, mirroring short-fade-edge.ts's own
 *     "confirmation not first-touch" philosophy applied to the long side.
 *
 * Exit reuses the already-proven MFE-giveback policy (intraday-momentum-edge.ts /
 * CG_MFE_GIVEBACK) instead of fade-long-edge.ts's old fixed 1.5%-stop/0.75%-TP geometry — that
 * sub-1:1 payoff is very likely why the old lane lost money despite a 51% win rate.
 *
 * Majors/liquid universe only (same as short-fade-edge.ts) — illiquid alts generate false
 * RSI/exhaustion signals and mean-revert unreadably, per this repo's own prior research.
 *
 * WIRED STRAIGHT TO LIVE EXECUTION on the operator's explicit 2026-07-09 request, with ZERO prior
 * measurement of this specific 3-stage signal (unlike regime-composite-edge.ts/composite-estimator-
 * edge.ts, which had at least some component-level report history before their own zero-measurement
 * live-wiring) — this exact 3-stage combination has never fired once, in any environment, before
 * today. Sized smaller than those precedents (see PWR_EXEC_LEG_USD) precisely because of that. Being
 * a 3-way conjunctive rare-event gate (like short-fade-edge, which has recorded ZERO signals in ~3
 * weeks/490 cycles), this lane may go a long time before producing its first observation.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { completedCandles, type Candle } from "@dtc/shared";
import { computeATR, computeRSI, computeSMA } from "./candle-indicators.js";
import { fetchCrowdingSnapshot, type CrowdingSnapshot } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import {
  makeMfeGivebackExitPolicy,
  type SingleSymbolExitPolicy,
  type SingleSymbolFreshSignal,
} from "./single-symbol-lane-executor.js";
import { EDGE_LANE_COST_MODEL_VERSION } from "./edge-lane-cost-model.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export const PWR_INTERVAL = process.env.PANIC_WASHOUT_INTERVAL || "1h";
export const PWR_MAX_STORED_OBSERVATIONS = envNum("PANIC_WASHOUT_MAX_STORED_OBSERVATIONS", 500);
export const PWR_ATR_PERIOD = envNum("PANIC_WASHOUT_ATR_PERIOD", 14);
/** Panic bar's |close-open| must be at least this many ATRs — a genuine blowoff, not routine noise. */
export const PWR_PANIC_ATR_MULT = Number(process.env.PANIC_WASHOUT_ATR_MULT) || 1.5;
export const PWR_VOLUME_MA_PERIOD = envNum("PANIC_WASHOUT_VOLUME_MA_PERIOD", 20);
/** Panic bar's volume must be at least this many times its own 20-bar SMA. */
export const PWR_PANIC_VOLUME_MULT = Number(process.env.PANIC_WASHOUT_VOLUME_MULT) || 2.5;
export const PWR_RSI_PERIOD = envNum("PANIC_WASHOUT_RSI_PERIOD", 14);
/** RSI must drop below this (at the panic bar or within the reclaim window) — deeper than the old
 *  fade-long-edge.ts's <30, filtering routine dips out of a "capitulation" gate. */
export const PWR_WASHOUT_RSI_MAX = envNum("PANIC_WASHOUT_RSI_MAX", 25);
/** How many bars back from "now" to search for a still-unreclaimed qualifying panic bar. */
export const PWR_LOOKBACK_BARS = envNum("PANIC_WASHOUT_LOOKBACK_BARS", 10);
/** Wide stop below the panic bar's low, floored at this distance so a very-close panic low can't
 *  produce an unreasonably tight stop. Same convention as short-fade-edge.ts's proven geometry. */
export const PWR_STOP_FLOOR_BPS = envNum("PANIC_WASHOUT_STOP_FLOOR_BPS", 300);
/** Reject the signal outright (never clip the stop tighter) once the panic bar's own low implies a
 *  stop wider than this — unlike every sibling lane's stop (fixed bps, or an ATR MULTIPLE bounded by
 *  construction), this lane's stop is derived from the panic bar's low, and the panic-bar gate
 *  REQUIRES an unusually large range (>= PWR_PANIC_ATR_MULT × ATR) by design — so on a truly extreme
 *  blowoff bar the implied stop distance has no natural ceiling. Clipping it tighter than the real
 *  panic low would trade a fabricated support level instead of the genuine structure; rejecting
 *  preserves the signal's meaning (same anti-extension philosophy as intraday-momentum-edge.ts's
 *  IM_MAX_ATR_EXTENSION reject-cap, applied here to stop width instead of chase distance). */
export const PWR_STOP_CEILING_BPS = envNum("PANIC_WASHOUT_STOP_CEILING_BPS", 800);
export const PWR_MFE_ARM_R = Number(process.env.PANIC_WASHOUT_MFE_ARM_R) || 0.75;
export const PWR_MFE_GIVEBACK_FRAC = Number(process.env.PANIC_WASHOUT_MFE_GIVEBACK_FRAC) || 0.5;
export const PWR_MAX_HOLD_BARS = envNum("PANIC_WASHOUT_MAX_HOLD_BARS", 48);
export const PWR_PAPER_LANE_ID = "PANIC_WASHOUT_RECLAIM_LONG" as const;
/** Majors/liquid tier — same universe as short-fade-edge.ts, for the same reason (thin alts produce
 *  false exhaustion signals). Env-overridable so it can be widened once this proves out. */
export const PWR_UNIVERSE: readonly string[] = (process.env.PANIC_WASHOUT_UNIVERSE ?? "BTCUSDT,ETHUSDT,LINKUSDT,SEIUSDT,BNBUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const TAKER_ROUNDTRIP_BPS = 8; // ~0.04% per side, taker in + taker out
const STOP_OUT_SLIPPAGE_BPS = 5; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

export interface PanicWashoutSignal {
  entryPrice: number;
  panicBarHigh: number;
  panicBarLow: number;
  rsiAtWashout: number;
  barsSincePanic: number;
}

/**
 * Pure panic/washout/reclaim detector on a CLOSED-candle series (last element = the just-closed
 * bar, which is evaluated as the potential RECLAIM bar). Searches backward up to
 * PWR_LOOKBACK_BARS for the most recent qualifying panic bar that has NOT already been reclaimed on
 * an earlier bar (dedup — a signal only fires on the FIRST bar that reclaims a given panic, never
 * re-fires every bar after). No lookahead — uses only closed bars.
 */
export function detectPanicWashoutSignal(candles: Candle[]): PanicWashoutSignal | null {
  const need = Math.max(PWR_ATR_PERIOD, PWR_VOLUME_MA_PERIOD, PWR_RSI_PERIOD) + PWR_LOOKBACK_BARS + 2;
  if (candles.length < need) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const atr = computeATR(candles, PWR_ATR_PERIOD);
  const volSma = computeSMA(volumes, PWR_VOLUME_MA_PERIOD);
  const rsi = computeRSI(closes, PWR_RSI_PERIOD);

  const lastIdx = candles.length - 1;
  const reclaimBar = candles[lastIdx]!;

  for (let back = 1; back <= PWR_LOOKBACK_BARS; back++) {
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

    // Washout: RSI must have dropped below the threshold at the panic bar itself, or on any bar
    // between the panic bar and the reclaim bar (capitulation can lag the blowoff candle by a bar).
    let washoutRsi: number | null = finite(rsi[idx]) && (rsi[idx] as number) < PWR_WASHOUT_RSI_MAX ? (rsi[idx] as number) : null;
    if (washoutRsi === null) {
      for (let j = idx + 1; j < lastIdx; j++) {
        const r = rsi[j];
        if (finite(r) && r < PWR_WASHOUT_RSI_MAX) {
          washoutRsi = r;
          break;
        }
      }
    }
    if (washoutRsi === null) continue;

    // Dedup: if any bar strictly between the panic bar and the reclaim bar already closed above the
    // panic bar's high, this panic was already reclaimed earlier — not a fresh signal today.
    const alreadyReclaimed = candles.slice(idx + 1, lastIdx).some((c) => c.close > bar.high);
    if (alreadyReclaimed) continue;

    // Reclaim trigger: THIS (the latest closed) bar closes back above the panic bar's high.
    if (!(reclaimBar.close > bar.high)) continue;
    if (!(reclaimBar.close > 0) || !(bar.low > 0)) continue;

    return { entryPrice: reclaimBar.close, panicBarHigh: bar.high, panicBarLow: bar.low, rsiAtWashout: washoutRsi, barsSincePanic: back };
  }
  return null;
}

/** Washout confirmation gate: OI FALLING (classifyCrowdingState → UNWINDING) — leveraged positions
 *  being forced out, not just extended. Direction-agnostic by design (a genuine flush can happen on
 *  either side); this lane only ever acts on the LONG (dip) side. */
export function passesPanicWashoutCrowdingGate(snapshot: CrowdingSnapshot): boolean {
  return snapshot.crowdingState === "UNWINDING";
}

export interface PanicWashoutGeometry {
  entryPrice: number;
  initialStop: number;
  stopDistanceBps: number;
}

/** LONG-only wide-stop geometry: stop below the panic bar's low, floored at PWR_STOP_FLOOR_BPS so a
 *  panic low very close to the reclaim entry can't produce an unreasonably tight stop, and REJECTED
 *  (returns null, never clipped) once the panic bar's own low implies a stop wider than
 *  PWR_STOP_CEILING_BPS — see that constant's doc comment for why this lane specifically needs a
 *  ceiling its siblings don't. */
export function buildPanicWashoutGeometry(entryPrice: number, panicBarLow: number): PanicWashoutGeometry | null {
  if (!(entryPrice > 0) || !(panicBarLow > 0) || !(panicBarLow < entryPrice)) return null;
  const floorStop = entryPrice * (1 - PWR_STOP_FLOOR_BPS / 10000);
  const initialStop = Math.min(panicBarLow, floorStop);
  if (!(initialStop > 0) || !(initialStop < entryPrice)) return null;
  const stopDistanceBps = ((entryPrice - initialStop) / entryPrice) * 10000;
  if (stopDistanceBps > PWR_STOP_CEILING_BPS) return null;
  if (!(stopDistanceBps > 0)) return null;
  return { entryPrice, initialStop, stopDistanceBps };
}

export interface PanicWashoutObservation extends PanicWashoutGeometry {
  observationId: string;
  symbol: string;
  direction: "LONG";
  openedAt: string;
  openedAtMs: number;
  rsiAtWashout: number;
  panicBarHigh: number;
  panicBarLow: number;
  fundingBps: number | null;
  oiChangePercent: number | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  maxFavorableR: number | null;
  exitReason: "MFE_GIVEBACK" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
  /** LIVE-LANE WIRING (2026-08-02) — see edge-lane-cost-model.ts / lane-edge-report-fields.ts.
   *  Stamped only by THIS module's own new-observation creation code, below — never backfilled. */
  postFixLineageV1?: boolean;
  costModelVersion?: number;
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs with the MFE-giveback
 * exit (same convention as intraday-momentum-edge.ts's resolveIntradayMomentum): stop first
 * (conservative), track peak favorableR from bar highs, arm once peak >= PWR_MFE_ARM_R, bank once a
 * later close gives back PWR_MFE_GIVEBACK_FRAC of the peak, else mark-to-market at PWR_MAX_HOLD_BARS.
 */
export function resolvePanicWashoutObservation(
  obs: PanicWashoutObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<PanicWashoutObservation> | null {
  const fwd = completedCandles(forwardCandles, PWR_INTERVAL, nowMs)
    .filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.entryPrice - obs.initialStop;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<PanicWashoutObservation["exitReason"]>,
    maxFavorableR: number,
  ): Partial<PanicWashoutObservation> => {
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
    if (peakR >= PWR_MFE_ARM_R) armed = true;
    if (armed) {
      const closeR = (c.close - obs.entryPrice) / risk;
      const givebackLine = peakR * (1 - PWR_MFE_GIVEBACK_FRAC);
      if (closeR <= givebackLine) {
        return finalize(closeR, c.openTime, "MFE_GIVEBACK", peakR);
      }
    }
    if (i + 1 >= PWR_MAX_HOLD_BARS) {
      const grossR = (c.close - obs.entryPrice) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM", peakR);
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > PWR_MAX_HOLD_BARS * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
export interface PWRCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  panicCandidatesTotal: number;
  crowdingRejectedTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: PWRCycleMeta = {
  lastCycleAt: null, cycles: 0, panicCandidatesTotal: 0, crowdingRejectedTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface PWRState {
  version: number;
  observations: PanicWashoutObservation[];
  cycleMeta?: PWRCycleMeta;
}

export class PanicWashoutStore {
  private state: PWRState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PWRState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as PanicWashoutObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): PanicWashoutObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): PWRCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: PWRCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.panicCandidatesTotal += result.panicCandidates;
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
  add(obs: PanicWashoutObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<PanicWashoutObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most PWR_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled observations are dropped first once that cap is exceeded.
   *  2026-07-11 OOM audit fix: this file had no cap at all despite being live-wired. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > PWR_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - PWR_MAX_STORED_OBSERVATIONS) : settled;
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

let singleton: PanicWashoutStore | null = null;
export function getPanicWashoutStore(dataDir = "data"): PanicWashoutStore {
  if (!singleton) singleton = new PanicWashoutStore(resolve(dataDir, "panic-washout-reclaim-edge.json"));
  return singleton;
}

export function _resetPanicWashoutStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface PWRCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  panicCandidates: number;
  crowdingRejected: number;
}

export async function runPanicWashoutCycle(opts: {
  store: PanicWashoutStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<PWRCycleResult> {
  const result: PWRCycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, panicCandidates: 0, crowdingRejected: 0 };
  const universe = opts.universe ?? PWR_UNIVERSE;
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
    const patch = resolvePanicWashoutObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. record new entries: panic/washout/reclaim gate first (cheap, candle-only), THEN the
  //    crowding fetch (Binance call) ONLY for symbols that already cleared it — same discipline as
  //    short-fade-edge.ts's cycle.
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;
    const signal = detectPanicWashoutSignal(candles);
    if (!signal) continue;
    result.panicCandidates += 1;

    let crowding: CrowdingSnapshot | null = null;
    try {
      crowding = await fetchCrowdingSnapshot(opts.crowdingClient, symbol, nowIso);
    } catch {
      crowding = null;
    }
    if (!crowding || !passesPanicWashoutCrowdingGate(crowding)) {
      result.crowdingRejected += 1;
      continue;
    }

    const geometry = buildPanicWashoutGeometry(signal.entryPrice, signal.panicBarLow);
    if (!geometry) continue;

    const observationId = `pwr:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...geometry,
      observationId,
      symbol,
      direction: "LONG",
      openedAt: nowIso,
      openedAtMs: opts.now,
      rsiAtWashout: signal.rsiAtWashout,
      panicBarHigh: signal.panicBarHigh,
      panicBarLow: signal.panicBarLow,
      fundingBps: crowding.fundingBps,
      oiChangePercent: crowding.oiChangePercent,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
      postFixLineageV1: true,
      costModelVersion: EDGE_LANE_COST_MODEL_VERSION,
    });
    if (added) result.recorded += 1;
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

export async function runPanicWashoutCycleGuarded(opts: Parameters<typeof runPanicWashoutCycle>[0]): Promise<PWRCycleResult | null> {
  try {
    return await runPanicWashoutCycle(opts);
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
export interface PanicWashoutReport {
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
  mfeGivebackShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string; rsiAtWashout: number; fundingBps: number | null }>;
  cycleMeta: PWRCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildPanicWashoutReport(
  observations: readonly PanicWashoutObservation[],
  cycleMeta?: PWRCycleMeta,
): PanicWashoutReport {
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
    .map((o) => ({ symbol: o.symbol, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt, rsiAtWashout: o.rsiAtWashout, fundingBps: o.fundingBps }));

  return {
    laneId: PWR_PAPER_LANE_ID,
    interval: PWR_INTERVAL,
    universe: PWR_UNIVERSE,
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

// ── live execution wiring (2026-07-09) ──────────────────────────────────────
// Adapters for single-symbol-lane-executor.ts's generic executor. This lane stays a pure
// measurement module above this line — these two functions are the ONLY seam connecting it to
// real execution, and neither one changes what gets recorded/resolved for OOS measurement.

/** This lane's OPEN observations → the generic single-symbol executor's common signal shape. */
export function panicWashoutOpenSignals(store: PanicWashoutStore): SingleSymbolFreshSignal[] {
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

/** Same MFE-giveback exit as the paper measurement (resolvePanicWashoutObservation): arm at
 *  PWR_MFE_ARM_R, bank on a PWR_MFE_GIVEBACK_FRAC retrace, PWR_MAX_HOLD_BARS (@ 1h bars) mark-to-
 *  market fallback. */
export function panicWashoutExitPolicy(): SingleSymbolExitPolicy {
  return makeMfeGivebackExitPolicy({ armR: PWR_MFE_ARM_R, givebackFrac: PWR_MFE_GIVEBACK_FRAC, maxHoldMs: PWR_MAX_HOLD_BARS * 3_600_000 });
}

/** Own enable flag, independent of every other lane's — this lane never executed a real order
 *  before this date, so turning it on must be an explicit, separate act, same convention as every
 *  other executor in this codebase. */
export function isPanicWashoutExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PANIC_WASHOUT_EXEC_ENABLED === "1";
}
/** Smaller than regime-composite/composite-estimator's $130/$150 defaults — this signal has ZERO
 *  prior measurement of any kind (those had at least some component-level report history before
 *  their own zero-measurement live-wiring); sizing down given the elevated unknown-edge risk. */
export const PWR_EXEC_LEG_USD = (): number => {
  const n = Number.parseFloat(process.env.PANIC_WASHOUT_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 50;
};
export const PWR_EXEC_LEVERAGE = (): number => {
  const n = Number.parseInt(process.env.PANIC_WASHOUT_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
export const PWR_EXEC_MAX_CONCURRENT = (): number => {
  const n = Number.parseInt(process.env.PANIC_WASHOUT_EXEC_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};
export const PWR_EXEC_MAX_SIGNAL_AGE_MS = (): number =>
  Math.max(60_000, Math.floor(Number(process.env.PANIC_WASHOUT_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
export const PWR_EXEC_DAILY_MAX_LOSS_USD = (): number => {
  const n = Number.parseFloat(process.env.PANIC_WASHOUT_EXEC_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};

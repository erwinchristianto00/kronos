/**
 * SHORT confirmed-exhaustion + crowded-funding fade (report-only measurement lane).
 *
 * Every existing SHORT lane in this codebase (CG_WIDE_FAST_SHORT and its siblings in
 * current-guard-variant-matrix.ts) varies the EXIT geometry (stop distance, TP multiple) on the
 * SAME entry population handed to it by the scanner. None of them vary the ENTRY signal itself.
 * This lane does — informed by 2026-07-06 research (see memory) cross-checked against this repo's
 * own data:
 *
 *  1. RSI exhaustion CONFIRMATION, not first touch: short only once RSI has crossed back DOWN
 *     through the overbought line (the reversal has started), never on the first overbought read
 *     (catching a falling knife). Research: "signals trigger when RSI re-enters the normal channel
 *     from an extreme zone, not when it first enters."
 *  2. Crowded-long funding/OI gate: only short when funding is EXTREME on the LONG side AND OI is
 *     still rising (classifyCrowdingState → "EXHAUSTING") — over-leveraged longs primed to unwind.
 *     Reuses derivatives-crowding.ts's existing fetchCrowdingSnapshot, no new Binance surface.
 *  3. Majors/liquid universe only: this repo's OWN per-symbol-lane-edge data shows BTC/LINK/SEI
 *     book-positive on wide-stop fast-TP shorts while thin alts are not — matches the research
 *     finding that illiquid alts trend through mean-reversion setups and generate false RSI signals.
 *  4. Exit: reuses CG_WIDE_FAST_SHORT's ALREADY-proven geometry (wide >=300bps stop, fast 0.5R TP,
 *     full exit) rather than inventing a new one — the short-squeeze-avoidance research explicitly
 *     validates "wide stop, bank fast, don't chase" as sound, so only the entry filter is new.
 *
 * Pure measurement: records and resolves observations, exposes a report. NOTHING trades until the
 * book proves positive. Independent module: its own store, cycle, resolver, report.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";
import { computeRSI } from "./candle-indicators.js";
import { fetchCrowdingSnapshot, type CrowdingSnapshot } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import {
  makeFixedRewardExitPolicy,
  type SingleSymbolExitPolicy,
  type SingleSymbolFreshSignal,
} from "./single-symbol-lane-executor.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const SF_INTERVAL = process.env.SHORT_FADE_INTERVAL || "1h";
export const SF_RSI_PERIOD = envNum("SHORT_FADE_RSI_PERIOD", 14);
/** Overbought line the RSI must have been AT/ABOVE on the prior bar, then crossed below on this bar. */
export const SF_RSI_OVERBOUGHT = envNum("SHORT_FADE_RSI_OVERBOUGHT", 75);
/** Same proven geometry as CG_WIDE_FAST_SHORT (current-guard-variant-matrix.ts). */
export const SF_STOP_FLOOR_BPS = envNum("SHORT_FADE_STOP_FLOOR_BPS", 300);
export const SF_TP_REWARD_MULTIPLE = Number(process.env.SHORT_FADE_TP_REWARD_MULTIPLE) || 0.5;
export const SF_MAX_HOLD_BARS = envNum("SHORT_FADE_MAX_HOLD_BARS", 48);
export const SF_PAPER_LANE_ID = "SHORT_FADE_EXHAUSTION_CROWDED" as const;
export const SF_MAX_STORED_OBSERVATIONS = envNum("SHORT_FADE_MAX_STORED_OBSERVATIONS", 500);
/** Majors/liquid tier — matches this repo's own per-symbol-lane-edge book-positive set for the same
 *  wide-stop/fast-TP short geometry, plus the research finding that thin alts trend through mean
 *  reversion. Env-overridable (comma-separated) so it can be widened once more symbols prove out. */
export const SF_UNIVERSE: readonly string[] = (process.env.SHORT_FADE_UNIVERSE ?? "BTCUSDT,ETHUSDT,LINKUSDT,SEIUSDT,BNBUSDT,SOLUSDT")
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

export interface ShortFadeRsiSignal {
  entryPrice: number;
  rsiNow: number;
  rsiPriorBar: number;
}

/**
 * Pure RSI exhaustion-confirmation signal on a CLOSED-candle series (last element = the just-closed
 * bar). Fires only when the PRIOR bar's RSI was at/above the overbought line and THIS bar's RSI has
 * crossed back below it — confirmation the reversal has started, not a first-touch chase. No
 * lookahead — uses only closed bars.
 */
export function detectShortFadeRsiSignal(candles: Candle[]): ShortFadeRsiSignal | null {
  const need = SF_RSI_PERIOD + 2;
  if (candles.length < need) return null;
  const closes = candles.map((c) => c.close);
  const rsi = computeRSI(closes, SF_RSI_PERIOD);
  const rsiNow = rsi[rsi.length - 1];
  const rsiPrior = rsi[rsi.length - 2];
  if (!finite(rsiNow) || !finite(rsiPrior)) return null;
  if (!(rsiPrior >= SF_RSI_OVERBOUGHT)) return null; // prior bar wasn't overbought
  if (!(rsiNow < SF_RSI_OVERBOUGHT)) return null; // hasn't crossed back down yet
  const entryPrice = candles[candles.length - 1]!.close;
  if (!(entryPrice > 0)) return null;
  return { entryPrice, rsiNow, rsiPriorBar: rsiPrior };
}

/** Crowded-long gate: funding EXTREME on the LONG side while OI still rises (classifyCrowdingState
 *  → EXHAUSTING) — over-leveraged longs primed to unwind. The short-side mirror is intentionally
 *  NOT accepted here (this lane only fades crowded longs, per the research finding). */
export function passesShortFadeCrowdingGate(snapshot: CrowdingSnapshot): boolean {
  return snapshot.crowdSide === "LONG" && snapshot.crowdingState === "EXHAUSTING";
}

export interface ShortFadeGeometry {
  entryPrice: number;
  initialStop: number;
  takeProfitPrice: number;
  stopDistanceBps: number;
}

/** SHORT-only wide-stop/fast-TP geometry — identical formula to CG_WIDE_FAST_SHORT. */
export function buildShortFadeGeometry(entryPrice: number): ShortFadeGeometry | null {
  if (!(entryPrice > 0)) return null;
  const initialStop = entryPrice * (1 + SF_STOP_FLOOR_BPS / 10000);
  const risk = initialStop - entryPrice;
  if (!(risk > 0)) return null;
  const takeProfitPrice = entryPrice - SF_TP_REWARD_MULTIPLE * risk;
  if (!(takeProfitPrice > 0)) return null;
  const stopDistanceBps = (risk / entryPrice) * 10000;
  return { entryPrice, initialStop, takeProfitPrice, stopDistanceBps };
}

export interface ShortFadeObservation extends ShortFadeGeometry {
  observationId: string;
  symbol: string;
  direction: "SHORT";
  openedAt: string;
  openedAtMs: number;
  rsiAtEntry: number;
  rsiPriorBar: number;
  fundingBps: number | null;
  oiChangePercent: number | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: "TP_HIT" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs. SHORT direction: stop is
 * ABOVE entry, TP is BELOW entry. Same-candle-ambiguous convention as the rest of this codebase:
 * SL-first (conservative, never assume the favorable touch happened first). Mark-to-market at
 * MAX_HOLD_BARS if neither fires. Returns the patch, or null if still open / not enough data yet.
 */
export function resolveShortFadeObservation(
  obs: ShortFadeObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<ShortFadeObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = obs.initialStop - obs.entryPrice;
  if (!(risk > 0)) return null;

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<ShortFadeObservation["exitReason"]>,
  ): Partial<ShortFadeObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return {
      status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR,
      costR,
      netR,
      exitReason,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };

  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i]!;
    const slHit = c.high >= obs.initialStop;
    const tpHit = c.low <= obs.takeProfitPrice;
    if (slHit && tpHit) {
      // Ambiguous same-candle touch — conservative SL-first.
      return finalize(-1, c.openTime, "INITIAL_STOP");
    }
    if (slHit) {
      return finalize(-1, c.openTime, "INITIAL_STOP");
    }
    if (tpHit) {
      const grossR = (obs.entryPrice - obs.takeProfitPrice) / risk;
      return finalize(grossR, c.openTime, "TP_HIT");
    }
    if (i + 1 >= SF_MAX_HOLD_BARS) {
      const grossR = (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM");
    }
  }
  // Not enough forward candles yet AND long past the hold window → expire (stale, un-resolvable).
  if (fwd.length === 0 && nowMs - obs.openedAtMs > SF_MAX_HOLD_BARS * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
/** Liveness + funnel counters, persisted so the report can PROVE the cycle is alive and show WHY
 *  the book is empty (2026-07-07 operator: "masih kosong sampe sekarang" — with no lastCycleAt or
 *  gate counters, an empty lane was indistinguishable from a dead one without SSHing to the box). */
export interface SFCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  rsiCandidatesTotal: number;
  crowdingRejectedTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: SFCycleMeta = {
  lastCycleAt: null, cycles: 0, rsiCandidatesTotal: 0, crowdingRejectedTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface SFState {
  version: number;
  observations: ShortFadeObservation[];
  cycleMeta?: SFCycleMeta;
}

export class ShortFadeStore {
  private state: SFState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<SFState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as ShortFadeObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): ShortFadeObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): SFCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: SFCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.rsiCandidatesTotal += result.rsiCandidates;
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
  add(obs: ShortFadeObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<ShortFadeObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most SF_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled observations are dropped first once that cap is exceeded.
   *  2026-07-11 OOM audit fix. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > SF_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - SF_MAX_STORED_OBSERVATIONS) : settled;
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

let singleton: ShortFadeStore | null = null;
export function getShortFadeStore(dataDir = "data"): ShortFadeStore {
  if (!singleton) singleton = new ShortFadeStore(resolve(dataDir, "short-fade-edge.json"));
  return singleton;
}

export function _resetShortFadeStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface SFCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  rsiCandidates: number;
  crowdingRejected: number;
}

export async function runShortFadeCycle(opts: {
  store: ShortFadeStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
  /** Don't record a second OPEN obs for a symbol whose prior one is younger than this. */
  dedupeWindowMs?: number;
}): Promise<SFCycleResult> {
  const result: SFCycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, rsiCandidates: 0, crowdingRejected: 0 };
  const universe = opts.universe ?? SF_UNIVERSE;
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
    const patch = resolveShortFadeObservation(obs, candles, opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 2. record new entries: RSI exhaustion-confirmation gate first (cheap, candle-only), THEN the
  //    crowding fetch (Binance call) ONLY for symbols that already cleared the RSI gate — bounds
  //    API load to real candidates, same discipline as intraday-momentum-edge's enrichSignal.
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;
    const rsiSignal = detectShortFadeRsiSignal(candles);
    if (!rsiSignal) continue;
    result.rsiCandidates += 1;

    let crowding: CrowdingSnapshot | null = null;
    try {
      crowding = await fetchCrowdingSnapshot(opts.crowdingClient, symbol, nowIso);
    } catch {
      crowding = null;
    }
    if (!crowding || !passesShortFadeCrowdingGate(crowding)) {
      result.crowdingRejected += 1;
      continue;
    }

    const geometry = buildShortFadeGeometry(rsiSignal.entryPrice);
    if (!geometry) continue;

    const observationId = `sf:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...geometry,
      observationId,
      symbol,
      direction: "SHORT",
      openedAt: nowIso,
      openedAtMs: opts.now,
      rsiAtEntry: rsiSignal.rsiNow,
      rsiPriorBar: rsiSignal.rsiPriorBar,
      fundingBps: crowding.fundingBps,
      oiChangePercent: crowding.oiChangePercent,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) result.recorded += 1;
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

export async function runShortFadeCycleGuarded(opts: Parameters<typeof runShortFadeCycle>[0]): Promise<SFCycleResult | null> {
  try {
    return await runShortFadeCycle(opts);
  } catch (error) {
    // Record the failure so the report shows "cycle ran and ERRORED" instead of silently
    // looking identical to "no signal yet" — best-effort, never rethrows.
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
export interface ShortFadeReport {
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
  tpShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string; rsiAtEntry: number; fundingBps: number | null }>;
  /** Liveness + gate funnel: distinguishes "alive but the market never qualified" (cycles ticking,
   *  rsiCandidatesTotal 0) from "silently dead" (stale lastCycleAt) and from "erroring"
   *  (lastCycleError set). Null only for callers that don't pass store meta. */
  cycleMeta: SFCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildShortFadeReport(
  observations: readonly ShortFadeObservation[],
  cycleMeta?: SFCycleMeta,
): ShortFadeReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const tpHits = resolved.filter((o) => o.exitReason === "TP_HIT").length;
  const stops = resolved.filter((o) => o.exitReason === "INITIAL_STOP").length;
  const netAvgR = mean(nets);
  // edge-ready = enough sample AND positive net AND a real payoff (winners bigger than the cost).
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({ symbol: o.symbol, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt, rsiAtEntry: o.rsiAtEntry, fundingBps: o.fundingBps }));

  return {
    laneId: SF_PAPER_LANE_ID,
    interval: SF_INTERVAL,
    universe: SF_UNIVERSE,
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))),
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    tpShare: resolved.length ? tpHits / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

// ── live execution wiring (2026-07-08) ──────────────────────────────────────
// Adapters for single-symbol-lane-executor.ts's generic executor. This lane stays a pure
// measurement module above this line — these two functions are the ONLY seam connecting it to
// real execution, and neither one changes what gets recorded/resolved for OOS measurement.

/** This lane's OPEN observations → the generic single-symbol executor's common signal shape. */
export function shortFadeOpenSignals(store: ShortFadeStore): SingleSymbolFreshSignal[] {
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

/** Same exit geometry as the paper measurement (buildShortFadeGeometry / resolveShortFadeObservation):
 *  fast SF_TP_REWARD_MULTIPLE-R bank, stop at the geometry's initialStop, SF_MAX_HOLD_BARS (@ 1h
 *  bars) mark-to-market fallback. */
export function shortFadeExitPolicy(): SingleSymbolExitPolicy {
  return makeFixedRewardExitPolicy({ rewardMultiple: SF_TP_REWARD_MULTIPLE, maxHoldMs: SF_MAX_HOLD_BARS * 3_600_000 });
}

/** Own enable flag (2026-07-08), independent of LIVE_EXECUTION_ENABLED/CROSS_SECTIONAL_EXEC_ENABLED
 *  — this lane never executed a real order before this date, so turning it on must be an explicit,
 *  separate act, same convention as every other executor in this codebase. */
export function isShortFadeExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHORT_FADE_EXEC_ENABLED === "1";
}
export const SF_EXEC_LEG_USD = (): number => {
  const n = Number.parseFloat(process.env.SHORT_FADE_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 25;
};
export const SF_EXEC_LEVERAGE = (): number => {
  const n = Number.parseInt(process.env.SHORT_FADE_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
export const SF_EXEC_MAX_SIGNAL_AGE_MS = (): number =>
  Math.max(60_000, Math.floor(Number(process.env.SHORT_FADE_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
export const SF_EXEC_DAILY_MAX_LOSS_USD = (): number => {
  const n = Number.parseFloat(process.env.SHORT_FADE_EXEC_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** 2026-07-10: was hardcoded to the SingleSymbolLaneExecutor default (1) — this executor never
 *  had its own concurrency knob, unlike every sibling lane (RC/CE/PWR _EXEC_MAX_CONCURRENT). A
 *  single open-position cap throttles testnet sample accumulation to one trade at a time
 *  regardless of how many fresh signals fire. Default preserves existing behavior exactly. */
export const SF_EXEC_MAX_CONCURRENT = (): number => {
  const n = Number.parseInt(process.env.SHORT_FADE_EXEC_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};

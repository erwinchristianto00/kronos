/**
 * Per-symbol volatility (ATR%) + fresh technical-confirmation cache for directional mirror
 * entries (2026-07-08, operator-requested).
 *
 * Two independent additions, sharing one candle fetch/cache since both need "this symbol's
 * recent price history":
 *
 * 1. Size multiplier ("source entries teradjust sesuai volatility dan performance simbol di
 *    whitelist"): scoped to the lane's tier-0 curated whitelist only — see
 *    directionalSymbolSizeMultiplier below.
 *
 * 2. Technical confirmation GATE ("jangan buka berdasarkan performance di whitelist, tapi
 *    berdasarkan analisis teknikal... supaya waktu buka fast short/long, pas dan sesuai dan
 *    candle dan data yang ada"): operator explicitly chose ADD-ON-TOP, not replace — whitelist
 *    still decides which symbols/priority are eligible; this additionally requires the symbol's
 *    OWN fresh candles to confirm the direction RIGHT NOW (trend structure + momentum + not
 *    already-overextended) before an entry actually fires. See
 *    evaluateDirectionalTechnicalConfirmation below.
 *
 * A missing/stale cache or fetch failure fails OPEN on the size multiplier (1x, today's
 * behavior) but fails CLOSED on the technical gate (unconfirmed) — the whole point of the gate
 * is "don't fire without fresh confirmation," so no-data must not silently bypass it.
 *
 * This STACKS WITH, not replaces, computeLiveOrderPlan's existing risk-based sizing
 * (riskUsdPerTrade / stopDistancePct), which already equalizes DOLLAR RISK per trade regardless
 * of a symbol's stop width. What that formula can't see is how a symbol's volatility compares to
 * its WHITELIST PEERS right now — a relative, cross-sectional signal computed here instead.
 *
 * 3. Decision-score quality tilt (2026-07-10, Tier-1 audit item, opt-in): a THIRD multiplicative
 *    factor derived from decision-scoring.ts's 0-100 composite score, stacked on top of the two
 *    above. Gated behind DECISION_SCORE_SIZE_MULT_ENABLED (default OFF) — see
 *    isDecisionScoreSizeMultEnabled below. That composite score is still a REPORT-ONLY measurement
 *    lane elsewhere in this codebase (never proven to correlate with realized edge yet), so this
 *    factor fails OPEN to neutral (1.0) whenever the flag is off OR the score is unavailable for a
 *    given candidate — with the flag off, directionalSymbolSizeMultiplier's output is byte-for-byte
 *    identical to its pre-2026-07-10 behavior.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle } from "@dtc/shared";

import { computeATR, computeEMA, computeROC, computeRSI } from "./candle-indicators.js";

const ATR_PERIOD = 14;
const CANDLE_INTERVAL = "1h";
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const ROC_PERIOD = 10;
const RSI_PERIOD = 14;
const CANDLES_NEEDED = Math.max(ATR_PERIOD, EMA_SLOW_PERIOD, ROC_PERIOD, RSI_PERIOD) + 10;

/** 2026-07-08, operator-requested ("analisis teknikal... gate tambahan, whitelist tetap"). Applies
 *  to EVERY directional mirror candidate regardless of whitelist tier — see live-execution-engine.ts's
 *  mirrorNewSignals. Off by default; each deployment opts in explicitly via env. */
export function isDirectionalTechnicalGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTIONAL_TECHNICAL_GATE_ENABLED === "1";
}

/** ATR% (ATR / last close) from the most recent candle. Null on insufficient/invalid data. */
export function computeAtrPctFromCandles(candles: Candle[], period = ATR_PERIOD): number | null {
  if (candles.length <= period) return null;
  const atrSeries = computeATR(candles, period);
  const lastAtr = atrSeries[atrSeries.length - 1];
  const lastClose = candles[candles.length - 1]?.close;
  if (typeof lastAtr !== "number" || !(lastAtr > 0)) return null;
  if (typeof lastClose !== "number" || !(lastClose > 0)) return null;
  return lastAtr / lastClose;
}

export interface DirectionalTechnicalSignal {
  direction: "LONG" | "SHORT";
  /** close vs EMA(fast) vs EMA(slow) in the trend-confirming order for this direction. */
  emaAligned: boolean;
  /** ROC(period) sign matches the direction (positive for LONG, negative for SHORT). */
  momentumAligned: boolean;
  /** RSI(period) hasn't already blown past a sane range in this direction's favor — a coarse
   *  anti-chase filter, NOT a mean-reversion trigger (that's short-fade-edge.ts's job). */
  notOverextended: boolean;
  /** ALL of the above. This is what callers gate on. */
  confirmed: boolean;
  emaFast: number | null;
  emaSlow: number | null;
  roc: number | null;
  rsi: number | null;
}

const RSI_LONG_CEILING = 80; // don't confirm a LONG chasing an already-blown-out overbought move
const RSI_SHORT_FLOOR = 20; // don't confirm a SHORT chasing an already-blown-out oversold move

/**
 * Fresh per-symbol technical confirmation for a directional entry: does the symbol's OWN recent
 * price action actually support this direction RIGHT NOW (trend structure + momentum), and is it
 * not already overextended in that direction. Deliberately reuses indicators/periods already
 * proven elsewhere in this codebase (candle-indicators.ts; H6 trend lane's EMA/ROC pattern) rather
 * than inventing new ones. Returns confirmed=false (fails CLOSED) on insufficient data — the whole
 * point of a confirmation gate is that missing data can't silently pass it.
 */
export function evaluateDirectionalTechnicalConfirmation(
  candles: Candle[],
  direction: "LONG" | "SHORT",
): DirectionalTechnicalSignal {
  const fail = (partial: Partial<DirectionalTechnicalSignal> = {}): DirectionalTechnicalSignal => ({
    direction,
    emaAligned: false,
    momentumAligned: false,
    notOverextended: false,
    confirmed: false,
    emaFast: null,
    emaSlow: null,
    roc: null,
    rsi: null,
    ...partial,
  });
  if (candles.length <= Math.max(EMA_SLOW_PERIOD, ROC_PERIOD, RSI_PERIOD)) return fail();

  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];
  const emaFast = computeEMA(closes, EMA_FAST_PERIOD).at(-1) ?? null;
  const emaSlow = computeEMA(closes, EMA_SLOW_PERIOD).at(-1) ?? null;
  const roc = computeROC(closes, ROC_PERIOD).at(-1) ?? null;
  const rsi = computeRSI(closes, RSI_PERIOD).at(-1) ?? null;
  if (
    typeof lastClose !== "number" ||
    !(lastClose > 0) ||
    typeof emaFast !== "number" ||
    typeof emaSlow !== "number" ||
    typeof roc !== "number" ||
    typeof rsi !== "number"
  ) {
    return fail();
  }

  const emaAligned = direction === "LONG" ? lastClose > emaFast && emaFast > emaSlow : lastClose < emaFast && emaFast < emaSlow;
  const momentumAligned = direction === "LONG" ? roc > 0 : roc < 0;
  const notOverextended = direction === "LONG" ? rsi < RSI_LONG_CEILING : rsi > RSI_SHORT_FLOOR;

  return {
    direction,
    emaAligned,
    momentumAligned,
    notOverextended,
    confirmed: emaAligned && momentumAligned && notOverextended,
    emaFast,
    emaSlow,
    roc,
    rsi,
  };
}

export interface SymbolTechnicalCacheEntry {
  LONG: DirectionalTechnicalSignal;
  SHORT: DirectionalTechnicalSignal;
  /** 2026-07-11: per-symbol timestamp of the last SUCCESSFUL fetch for this symbol specifically —
   *  the cache's single top-level computedAt gets re-stamped every refresh cycle regardless of
   *  whether any individual symbol's fetch actually succeeded (a persistently-failing symbol keeps
   *  its old LONG/SHORT verdict forever while looking fresh under the shared timestamp). Callers
   *  must check THIS field, not the top-level computedAt, before trusting `confirmed` — see
   *  isDirectionalTechnicalSignalFresh below. */
  computedAt: string;
}

/** 2026-07-11: a persistently-failing refresh (network/API issue lasting hours) must not let a
 *  stale confirmed/unconfirmed verdict from days ago keep silently gating real-money entries
 *  forever — the whole documented point of this gate is "fails CLOSED on no fresh data." 3x the
 *  20-min refresh cadence (SYMBOL_VOLATILITY_REFRESH_INTERVAL_MS in live-execution-engine.ts)
 *  tolerates a couple of missed/failed cycles (transient blips) without going stale, while still
 *  catching a genuinely broken refresh loop within about an hour. Env-tunable. */
export const TECHNICAL_SIGNAL_MAX_STALE_MS =
  Number(process.env.DIRECTIONAL_TECHNICAL_SIGNAL_MAX_STALE_MS) || 60 * 60_000;

/** Fails CLOSED (returns false) on a missing signal OR one whose OWN per-symbol computedAt has
 *  aged past TECHNICAL_SIGNAL_MAX_STALE_MS — a persistently-failing refresh must not let an old
 *  confirmed=true verdict keep passing the gate indefinitely under a fresh-looking cache-wide
 *  timestamp. */
export function isDirectionalTechnicalSignalFresh(
  entry: SymbolTechnicalCacheEntry | undefined,
  nowMs: number,
): boolean {
  if (!entry) return false;
  const computedAtMs = new Date(entry.computedAt).getTime();
  if (!Number.isFinite(computedAtMs)) return false;
  return nowMs - computedAtMs <= TECHNICAL_SIGNAL_MAX_STALE_MS;
}

export interface SymbolVolatilityCacheState {
  atrPctBySymbol: Record<string, number>;
  technicalBySymbol: Record<string, SymbolTechnicalCacheEntry>;
  computedAt: string | null;
  lastError: string | null;
}

const EMPTY_STATE: SymbolVolatilityCacheState = {
  atrPctBySymbol: {},
  technicalBySymbol: {},
  computedAt: null,
  lastError: null,
};

/** Self-computed (no cross-instance fetch needed — every instance has its own market-data
 *  client), atomic tmp+rename persistence matching lane-symbol-curation-cache.ts's convention. */
export class SymbolVolatilityCacheStore {
  private readonly file: string;
  private state: SymbolVolatilityCacheState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "directional-symbol-volatility-cache.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): SymbolVolatilityCacheState {
    try {
      if (!existsSync(this.file)) return { ...EMPTY_STATE };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object") {
        return {
          atrPctBySymbol: (parsed.atrPctBySymbol ?? {}) as Record<string, number>,
          technicalBySymbol: (parsed.technicalBySymbol ?? {}) as Record<string, SymbolTechnicalCacheEntry>,
          computedAt: typeof parsed.computedAt === "string" ? parsed.computedAt : null,
          lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
        };
      }
    } catch {
      // corrupt/partial file — fall through to empty (equivalent to "no cache yet")
    }
    return { ...EMPTY_STATE };
  }

  get(): SymbolVolatilityCacheState {
    return this.state;
  }

  set(
    atrPctBySymbol: Record<string, number>,
    technicalBySymbol: Record<string, SymbolTechnicalCacheEntry>,
    computedAt: string,
  ): void {
    this.state = { atrPctBySymbol, technicalBySymbol, computedAt, lastError: null };
    this._save();
  }

  setError(message: string): void {
    // Keep the last GOOD atrPctBySymbol/computedAt — only record the error for observability.
    this.state = { ...this.state, lastError: message };
    this._save();
  }

  private _save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // cache-persistence failures must never affect the app
    }
  }
}

let singleton: SymbolVolatilityCacheStore | null = null;
export function getSymbolVolatilityCacheStore(dataDir = "data"): SymbolVolatilityCacheStore {
  if (!singleton) singleton = new SymbolVolatilityCacheStore(dataDir);
  return singleton;
}

export function _resetSymbolVolatilityCacheStoreForTests(): void {
  singleton = null;
}

export type CandleFetcher = (symbol: string, interval: string, limit: number) => Promise<Candle[]>;

/**
 * Refreshes ATR% + fresh technical confirmation for the given symbols. Best-effort PER SYMBOL: a
 * single symbol's fetch/compute failure keeps its previous cached value (if any) rather than
 * dropping it or aborting the whole refresh — one bad symbol must never blank out the others.
 * Never throws.
 */
export async function refreshSymbolVolatilityCache(
  store: SymbolVolatilityCacheStore,
  symbols: string[],
  fetchCandles: CandleFetcher,
  opts: { nowIso?: () => string } = {},
): Promise<{ ok: boolean; refreshed: number; failed: number }> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const prior = store.get();
  const next: Record<string, number> = { ...prior.atrPctBySymbol };
  const nextTechnical: Record<string, SymbolTechnicalCacheEntry> = { ...prior.technicalBySymbol };
  let refreshed = 0;
  let failed = 0;
  for (const symbol of new Set(symbols)) {
    try {
      const candles = await fetchCandles(symbol, CANDLE_INTERVAL, CANDLES_NEEDED);
      const atrPct = computeAtrPctFromCandles(candles);
      const long = evaluateDirectionalTechnicalConfirmation(candles, "LONG");
      const short = evaluateDirectionalTechnicalConfirmation(candles, "SHORT");
      nextTechnical[symbol] = { LONG: long, SHORT: short, computedAt: nowIso() };
      if (atrPct !== null) {
        next[symbol] = atrPct;
        refreshed += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1; // keep the previous cached value for this symbol, if any
    }
  }
  store.set(next, nextTechnical, nowIso());
  return { ok: failed === 0, refreshed, failed };
}

// --- Combined performance + volatility size multiplier ---

const PERFORMANCE_SCALE = 1; // netAvgR is in R units (typically ~0.03-0.5) — used ~1:1 as a size tilt
const PERF_MULT_MIN = 0.7;
const PERF_MULT_MAX = 1.5;
const VOL_MULT_MIN = 0.6;
const VOL_MULT_MAX = 1.4;
const TOTAL_MULT_MIN = 0.5;
const TOTAL_MULT_MAX = 1.75;

// Decision-score quality tilt (opt-in — see isDecisionScoreSizeMultEnabled + the class-level doc
// comment's item 3). Linear, centered on decision-scoring.ts's own "neutral-ish" watchThreshold
// default of 50: a score of 50 resolves to exactly 1.0 (no tilt either way), 0 floors at 0.5x, 100
// ceilings at 1.5x. Chosen over e.g. a step function or a curve centered elsewhere because (a) it's
// the simplest monotonic mapping that a still-unproven report-only score deserves, (b) centering at
// 50 lines up with computeDecisionScore's own WATCH/NO_TRADE boundary rather than an arbitrary
// number, and (c) its +/-0.5 excursion roughly matches PERF_MULT/VOL_MULT's own scale above, so one
// quality factor can't dominate the other two once all three are stacked.
const QUALITY_MULT_MIN = 0.5;
const QUALITY_MULT_MAX = 1.5;
const QUALITY_MULT_BASE = 0.5; // score=0   -> 0.5x
const QUALITY_MULT_SCORE_DIVISOR = 100; // score=100 -> 1.5x, score=50 -> 1.0x (neutral)

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/** 2026-07-10, Tier-1 audit item ("sizing quality input"): gates the decision-score quality tilt
 *  in directionalSymbolSizeMultiplier. Off by default — the composite score it reads
 *  (decision-scoring.ts's computeDecisionScore) is still a REPORT-ONLY measurement lane elsewhere
 *  in this codebase, not yet proven to correlate with realized edge. Each deployment opts in
 *  explicitly via env, matching isDirectionalTechnicalGateEnabled's convention above. */
export function isDecisionScoreSizeMultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DECISION_SCORE_SIZE_MULT_ENABLED === "1";
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface DirectionalSizeMultiplierInputs {
  /** Scope guard: only tier-0 (curated whitelist) symbols get adjusted; everything else is 1x. */
  isWhitelisted: boolean;
  /** Realized book performance (netAvgR, in R units) for this symbol+direction+lane. Null = no data → neutral. */
  netAvgR: number | null;
  /** This symbol's current ATR% (ATR / price). Null = no data → volatility term stays neutral. */
  atrPct: number | null;
  /** ATR% of the OTHER whitelisted symbols right now, for relative comparison. */
  peerAtrPcts: number[];
  /** Optional 0-100 composite decision-quality score (decision-scoring.ts's computeDecisionScore
   *  totalScore) for this candidate, if one was cheaply available at the call site. This is a
   *  REPORT-ONLY measurement lane's output elsewhere in the codebase — NOT yet proven to correlate
   *  with realized edge. Only ever consulted when isDecisionScoreSizeMultEnabled() is true; even
   *  then, null/undefined/non-finite resolves to a neutral 1.0 (fail OPEN), same philosophy as
   *  netAvgR/atrPct above. Optional so every existing caller compiles unchanged. */
  decisionScore?: number | null;
}

/**
 * Directional mirror per-symbol size multiplier: reward proven performance, damp symbols that
 * are currently more volatile than their whitelist peers, scoped to the curated whitelist only.
 * Bounded on every factor AND the combined result so no data combination can runaway-size a
 * single-symbol bet — computeLiveOrderPlan's own maxNotionalPerTrade cap still applies on top.
 *
 * Optional third factor (2026-07-10): a decision-score quality tilt, stacked multiplicatively with
 * the perf/vol factors above. Strictly additive and opt-in — see isDecisionScoreSizeMultEnabled and
 * DirectionalSizeMultiplierInputs.decisionScore's doc comments. With DECISION_SCORE_SIZE_MULT_ENABLED
 * unset (today's default everywhere), this function's output is IDENTICAL to its pre-2026-07-10
 * behavior for every input combination.
 */
export function directionalSymbolSizeMultiplier(
  inputs: DirectionalSizeMultiplierInputs,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!inputs.isWhitelisted) return 1;

  const perfMult = clamp(1 + (inputs.netAvgR ?? 0) * PERFORMANCE_SCALE, PERF_MULT_MIN, PERF_MULT_MAX);

  const peerMedian = median(inputs.peerAtrPcts.filter((v) => Number.isFinite(v) && v > 0));
  const volMult =
    peerMedian !== null && inputs.atrPct !== null && inputs.atrPct > 0
      ? clamp(peerMedian / inputs.atrPct, VOL_MULT_MIN, VOL_MULT_MAX)
      : 1;

  const qualityScoreMult =
    isDecisionScoreSizeMultEnabled(env) && typeof inputs.decisionScore === "number" && Number.isFinite(inputs.decisionScore)
      ? clamp(QUALITY_MULT_BASE + inputs.decisionScore / QUALITY_MULT_SCORE_DIVISOR, QUALITY_MULT_MIN, QUALITY_MULT_MAX)
      : 1;

  return clamp(perfMult * volMult * qualityScoreMult, TOTAL_MULT_MIN, TOTAL_MULT_MAX);
}

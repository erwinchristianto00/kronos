/**
 * Bidirectional composite estimator (report-only measurement lane, live-wired 2026-07-09).
 *
 * Built at the operator's explicit request as a richer successor to REGIME_COMPOSITE_CONFIRMATION_LONG
 * (axis-level + crowding, LONG-only): "harus nya buka short/long itu ikutin hasil prediksi, semakin
 * curam prediksi nya, semakin buka yang TP WIDE, semakin landai, buka yang fast" — direction follows
 * the composite's SIGN; steepness (magnitude) picks WIDE (patient, let it run) vs FAST (quick scalp)
 * geometry. Three independent signals combine into the composite:
 *   1. Regime-axis LEVEL (regime-axis-timeline.ts's computeRegimeAxisScore, -1..+1 breadth composite)
 *   2. Regime-axis VELOCITY (that same timeline's OLS slopePerHour — "how fast is breadth moving",
 *      explicitly documented elsewhere as "an extrapolation, not a forecast")
 *   3. Kronos ML forecast (per-symbol expected-return + direction + confidence bucket; known
 *      reliability gap — historically 25-45% success rate, sometimes silently absent)
 *
 * Design spec finalized via a 3-lens adversarial design pass (2026-07-09) — key corrections from
 * that pass, all applied here:
 *   - A missing signal contributes a HARD ZERO to a FIXED-weight sum, never renormalized over the
 *     surviving weights. Renormalizing would let 1-of-3 signals swing the composite as far as all
 *     3 agreeing would, which silently amplifies confidence exactly when there's LESS evidence.
 *   - Kronos "unavailable" and Kronos "horizonConflict" both fold into the same excluded (zero)
 *     treatment — a raw disagreement is stronger evidence to distrust the signal than silence, but
 *     neither should be treated as "Kronos predicts flat/neutral" (that would be a fabricated read).
 *   - An axis level/velocity SIGN conflict (both signals live, both above a real-signal floor, but
 *     pointing opposite ways) hard-rejects the cycle for that symbol rather than letting them
 *     partially cancel into a falsely-calm composite.
 *   - WIDE+SHORT and FAST+LONG have ZERO measured edge anywhere in this codebase (only
 *     CG_WIDE_LONG_RUNNER/WIDE+LONG and CG_WIDE_FAST_SHORT/FAST+SHORT are backtested-positive) — a
 *     size multiplier (CE_UNPROVEN_QUADRANT_SIZE_MULT) is applied to those two quadrants' real
 *     execution instances (not to this measurement module, which records all 4 buckets identically
 *     so real evidence accrues for all of them).
 *
 * Pure measurement above the "live execution wiring" section: records and resolves observations,
 * exposes a report. Independent module: its own store, cycle, resolver, report — same discipline as
 * every other lane, though (per operator's explicit instruction) execution wiring skips the usual
 * "prove it first" gate, same override already applied to REGIME_COMPOSITE_CONFIRMATION_LONG.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Candle, KronosPrediction } from "@dtc/shared";
import type { KronosClient } from "./kronos.js";
import {
  makeFixedRewardExitPolicy,
  type SingleSymbolExitPolicy,
  type SingleSymbolFreshSignal,
} from "./single-symbol-lane-executor.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const CE_INTERVAL = process.env.COMPOSITE_ESTIMATOR_INTERVAL || "1h";
/** Small, fixed, high-liquidity universe only — same as REGIME_COMPOSITE_CONFIRMATION_LONG. */
export const CE_UNIVERSE: readonly string[] = (process.env.COMPOSITE_ESTIMATOR_UNIVERSE ?? "BTCUSDT,ETHUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ── signal normalization ────────────────────────────────────────────────────
export const CE_VELOCITY_SAT_PER_HR = Number(process.env.COMPOSITE_ESTIMATOR_VELOCITY_SAT_PER_HR) || 0.1;
export const CE_KRONOS_RETURN_SAT_PCT = Number(process.env.COMPOSITE_ESTIMATOR_KRONOS_RETURN_SAT_PCT) || 0.02;
export const CE_W_LEVEL = Number(process.env.COMPOSITE_ESTIMATOR_W_LEVEL) || 0.4;
export const CE_W_VELOCITY = Number(process.env.COMPOSITE_ESTIMATOR_W_VELOCITY) || 0.25;
export const CE_W_KRONOS = Number(process.env.COMPOSITE_ESTIMATOR_W_KRONOS) || 0.35;
/** Both level AND velocity must exceed this magnitude, with opposite signs, to hard-reject as an
 *  internal conflict rather than letting them partially cancel. */
export const CE_CONFLICT_MIN_MAGNITUDE = Number(process.env.COMPOSITE_ESTIMATOR_CONFLICT_MIN_MAGNITUDE) || 0.3;
/** |composite| below this (scaled up 1.5x when Kronos is unavailable, since there's less evidence
 *  behind the read) = no real signal, do nothing. */
export const CE_DEADZONE = Number(process.env.COMPOSITE_ESTIMATOR_DEADZONE) || 0.12;
/** |composite| at/above this -> WIDE geometry; below -> FAST. */
export const CE_STEEP_THRESHOLD = Number(process.env.COMPOSITE_ESTIMATOR_STEEP_THRESHOLD) || 0.45;

// ── geometry (reusing this repo's own proven parameters, not invented) ─────
/** Shared stop floor across both families — matches CG_WIDE_LONG_RUNNER and CG_WIDE_FAST_SHORT. */
export const CE_STOP_FLOOR_BPS = envNum("COMPOSITE_ESTIMATOR_STOP_FLOOR_BPS", 300);
/** WIDE: matches CG_WIDE_LONG_RUNNER (3R target, 144h/6d hold) — proven for LONG only. */
export const CE_WIDE_TP_REWARD_MULTIPLE = Number(process.env.COMPOSITE_ESTIMATOR_WIDE_TP_REWARD_MULTIPLE) || 3;
export const CE_WIDE_MAX_HOLD_HOURS = envNum("COMPOSITE_ESTIMATOR_WIDE_MAX_HOLD_HOURS", 144);
/** FAST: matches CG_WIDE_FAST_SHORT (0.5R target) — proven for SHORT only. The CG matrix variants
 *  carry no maxHoldHours of their own for this family; short-fade-edge.ts's 48h derivative is the
 *  precedent this borrows the SCALE from (not the value itself — this is its own constant). */
export const CE_FAST_TP_REWARD_MULTIPLE = Number(process.env.COMPOSITE_ESTIMATOR_FAST_TP_REWARD_MULTIPLE) || 0.5;
export const CE_FAST_MAX_HOLD_HOURS = envNum("COMPOSITE_ESTIMATOR_FAST_MAX_HOLD_HOURS", 48);

export const CE_MAX_CONCURRENT_PER_BUCKET = envNum("COMPOSITE_ESTIMATOR_MAX_CONCURRENT_PER_BUCKET", 3);

export type CEBucket = "WIDE_LONG" | "WIDE_SHORT" | "FAST_LONG" | "FAST_SHORT";
export const CE_PAPER_LANE_ID = "COMPOSITE_ESTIMATOR_BIDI" as const;
export const CE_MAX_STORED_OBSERVATIONS = envNum("COMPOSITE_ESTIMATOR_MAX_STORED_OBSERVATIONS", 500);
export function ceLaneIdForBucket(bucket: CEBucket): string {
  return `${CE_PAPER_LANE_ID}_${bucket}`;
}
/** Buckets with ZERO measured edge anywhere in this codebase (only WIDE+LONG/FAST+SHORT are
 *  backtested-positive) — real execution instances apply a size cut here, see the module header. */
export const CE_UNPROVEN_BUCKETS: ReadonlySet<CEBucket> = new Set(["WIDE_SHORT", "FAST_LONG"]);

const TAKER_ROUNDTRIP_BPS = 8; // ~0.04% per side, taker in + taker out
const STOP_OUT_SLIPPAGE_BPS = 5; // extra adverse fill on a stop-out

function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (isLoss ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── signal normalization ────────────────────────────────────────────────────
export function normalizeVelocity(slopePerHour: number | null): number | null {
  if (!finite(slopePerHour)) return null;
  return clamp(slopePerHour / CE_VELOCITY_SAT_PER_HR, -1, 1);
}

export interface NormalizedKronos {
  dir: number; // -1 | 0 | 1
  mag: number; // 0..1
  weight: number; // confidence weight, 0..1
  contribution: number; // dir * mag * weight, -1..1
}

const KRONOS_CONFIDENCE_WEIGHT: Record<"STRONG" | "MEDIUM" | "WEAK", number> = {
  STRONG: 1.0,
  MEDIUM: 0.6,
  WEAK: 0.3,
};

/** Extracts a normalized -1..1 contribution from a Kronos forecast, or null if unavailable/conflicted.
 *  horizonConflict is treated as unavailable (a raw disagreement is stronger reason to distrust the
 *  signal than silence, but must not be fabricated into a "neutral" reading either). */
export function normalizeKronos(kronos: KronosPrediction | null | undefined): NormalizedKronos | null {
  if (!kronos || kronos.available !== true) return null;
  if (kronos.horizonConflict === true) return null;
  const expectedReturn = kronos.expectedReturn1h ?? kronos.expectedReturn4h ?? kronos.expectedReturn3 ?? kronos.expectedReturn6;
  if (!finite(expectedReturn) || expectedReturn === 0) return null;
  const dir = Math.sign(expectedReturn);
  const mag = clamp(Math.abs(expectedReturn) / CE_KRONOS_RETURN_SAT_PCT, 0, 1);
  const bucket = kronos.kronosConfidenceBucket;
  const weight = bucket === "STRONG" || bucket === "MEDIUM" || bucket === "WEAK" ? KRONOS_CONFIDENCE_WEIGHT[bucket] : KRONOS_CONFIDENCE_WEIGHT.WEAK;
  return { dir, mag, weight, contribution: dir * mag * weight };
}

export type CERejectReason = "INSUFFICIENT_INPUTS" | "AXIS_INTERNAL_CONFLICT" | "AMBIGUOUS_NEAR_ZERO";

export interface CEClassification {
  composite: number;
  direction: "LONG" | "SHORT";
  bucket: CEBucket;
}

/**
 * The core composite + classification logic. level/velocity are the SAME for every symbol in a
 * cycle (market-wide breadth read); kronos is per-symbol. Returns a classification, or a reject
 * reason. Fixed-weight sum, never renormalized over surviving weights (see module header) — a
 * missing input can only shrink |composite|'s reachable range, never inflate it.
 */
export function classifyComposite(
  level: number | null,
  velocitySlopePerHour: number | null,
  kronos: KronosPrediction | null | undefined,
): CEClassification | { rejectReason: CERejectReason } {
  const velocity = normalizeVelocity(velocitySlopePerHour);
  const normKronos = normalizeKronos(kronos);

  if (velocity === null && normKronos === null) return { rejectReason: "INSUFFICIENT_INPUTS" };

  if (
    finite(level) &&
    velocity !== null &&
    Math.sign(level) !== Math.sign(velocity) &&
    Math.abs(level) > CE_CONFLICT_MIN_MAGNITUDE &&
    Math.abs(velocity) > CE_CONFLICT_MIN_MAGNITUDE
  ) {
    return { rejectReason: "AXIS_INTERNAL_CONFLICT" };
  }

  const composite =
    (finite(level) ? CE_W_LEVEL * level : 0) +
    (velocity !== null ? CE_W_VELOCITY * velocity : 0) +
    (normKronos !== null ? CE_W_KRONOS * normKronos.contribution : 0);

  const effectiveDeadzone = CE_DEADZONE * (normKronos !== null ? 1 : 1.5);
  if (Math.abs(composite) < effectiveDeadzone) return { rejectReason: "AMBIGUOUS_NEAR_ZERO" };

  const direction: "LONG" | "SHORT" = composite > 0 ? "LONG" : "SHORT";
  const steep = Math.abs(composite) >= CE_STEEP_THRESHOLD;
  const bucket: CEBucket = steep
    ? direction === "LONG"
      ? "WIDE_LONG"
      : "WIDE_SHORT"
    : direction === "LONG"
      ? "FAST_LONG"
      : "FAST_SHORT";

  return { composite, direction, bucket };
}

export interface CEGeometry {
  entryPrice: number;
  initialStop: number;
  takeProfitPrice: number;
  stopDistanceBps: number;
  tpRewardMultiple: number;
  maxHoldHours: number;
}

/** Direction-aware fixed-bps-stop / fixed-reward-multiple geometry — same formula as
 *  CG_WIDE_LONG_RUNNER (WIDE) / CG_WIDE_FAST_SHORT (FAST), generalized over direction. */
export function buildCompositeGeometry(entryPrice: number, direction: "LONG" | "SHORT", bucket: CEBucket): CEGeometry | null {
  if (!(entryPrice > 0)) return null;
  const isWide = bucket === "WIDE_LONG" || bucket === "WIDE_SHORT";
  const tpRewardMultiple = isWide ? CE_WIDE_TP_REWARD_MULTIPLE : CE_FAST_TP_REWARD_MULTIPLE;
  const maxHoldHours = isWide ? CE_WIDE_MAX_HOLD_HOURS : CE_FAST_MAX_HOLD_HOURS;
  const stopSign = direction === "LONG" ? -1 : 1;
  const initialStop = entryPrice * (1 + stopSign * (CE_STOP_FLOOR_BPS / 10000));
  const risk = Math.abs(entryPrice - initialStop);
  if (!(risk > 0)) return null;
  const tpSign = direction === "LONG" ? 1 : -1;
  const takeProfitPrice = entryPrice + tpSign * tpRewardMultiple * risk;
  if (!(takeProfitPrice > 0)) return null;
  const stopDistanceBps = (risk / entryPrice) * 10000;
  return { entryPrice, initialStop, takeProfitPrice, stopDistanceBps, tpRewardMultiple, maxHoldHours };
}

export interface CompositeEstimatorObservation extends CEGeometry {
  observationId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  bucket: CEBucket;
  compositeAtEntry: number;
  levelAtEntry: number | null;
  velocityAtEntry: number | null;
  kronosContributionAtEntry: number | null;
  openedAt: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: "TP_HIT" | "INITIAL_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/**
 * Resolve an OPEN observation by walking forward candles AFTER openedAtMs. Direction-aware
 * SL-first-conservative convention (same as every other lane in this codebase): on a
 * same-candle-ambiguous touch, the stop is assumed to have hit first.
 */
export function resolveCompositeObservation(
  obs: CompositeEstimatorObservation,
  forwardCandles: Candle[],
  nowMs: number,
): Partial<CompositeEstimatorObservation> | null {
  const fwd = forwardCandles.filter((c) => c.openTime > obs.openedAtMs).sort((a, b) => a.openTime - b.openTime);
  const risk = Math.abs(obs.entryPrice - obs.initialStop);
  if (!(risk > 0)) return null;
  const maxHoldBars = obs.maxHoldHours; // interval is 1h, so hours == bars

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<CompositeEstimatorObservation["exitReason"]>,
  ): Partial<CompositeEstimatorObservation> => {
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
    const slHit = obs.direction === "LONG" ? c.low <= obs.initialStop : c.high >= obs.initialStop;
    const tpHit = obs.direction === "LONG" ? c.high >= obs.takeProfitPrice : c.low <= obs.takeProfitPrice;
    if (slHit) {
      return finalize(-1, c.openTime, "INITIAL_STOP");
    }
    if (tpHit) {
      const grossR = obs.direction === "LONG"
        ? (obs.takeProfitPrice - obs.entryPrice) / risk
        : (obs.entryPrice - obs.takeProfitPrice) / risk;
      return finalize(grossR, c.openTime, "TP_HIT");
    }
    if (i + 1 >= maxHoldBars) {
      const grossR = obs.direction === "LONG" ? (c.close - obs.entryPrice) / risk : (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM");
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > maxHoldBars * 3_600_000 * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ─────────────────────────────────────────────────────────────────
export interface CECycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  insufficientInputsTotal: number;
  axisConflictTotal: number;
  ambiguousNearZeroTotal: number;
  recordedTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: CECycleMeta = {
  lastCycleAt: null, cycles: 0, insufficientInputsTotal: 0, axisConflictTotal: 0, ambiguousNearZeroTotal: 0, recordedTotal: 0, lastCycleError: null,
};

interface CEState {
  version: number;
  observations: CompositeEstimatorObservation[];
  cycleMeta?: CECycleMeta;
}

export class CompositeEstimatorStore {
  private state: CEState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CEState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as CompositeEstimatorObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): CompositeEstimatorObservation[] {
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
      meta.insufficientInputsTotal += result.insufficientInputs;
      meta.axisConflictTotal += result.axisConflict;
      meta.ambiguousNearZeroTotal += result.ambiguousNearZero;
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
  add(obs: CompositeEstimatorObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<CompositeEstimatorObservation>): void {
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

let singleton: CompositeEstimatorStore | null = null;
export function getCompositeEstimatorStore(dataDir = "data"): CompositeEstimatorStore {
  if (!singleton) singleton = new CompositeEstimatorStore(resolve(dataDir, "composite-estimator-edge.json"));
  return singleton;
}

export function _resetCompositeEstimatorStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────
export interface CECycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  insufficientInputs: number;
  axisConflict: number;
  ambiguousNearZero: number;
}

export async function runCompositeEstimatorCycle(opts: {
  store: CompositeEstimatorStore;
  universe?: readonly string[];
  now: number;
  axisLevel: number | null;
  axisVelocitySlopePerHour: number | null;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  fetchKronos: (symbol: string, candles: Candle[]) => Promise<KronosPrediction | null>;
  maxConcurrentPerBucket?: number;
  dedupeWindowMs?: number;
}): Promise<CECycleResult> {
  const result: CECycleResult = { scanned: 0, recorded: 0, resolved: 0, expired: 0, insufficientInputs: 0, axisConflict: 0, ambiguousNearZero: 0 };
  const universe = opts.universe ?? CE_UNIVERSE;
  const maxPerBucket = opts.maxConcurrentPerBucket ?? CE_MAX_CONCURRENT_PER_BUCKET;
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

  // 1. resolve OPEN observations with forward candles.
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const candles = candlesBySymbol.get(obs.symbol);
    if (!candles) continue;
    const patch = resolveCompositeObservation(obs, candles, opts.now);
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
    if (!candles || candles.length === 0) continue;
    const recentlyOpened = opts.store.all.some(
      (o) => o.symbol === symbol && o.status === "OPEN" && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentlyOpened) continue;

    let kronos: KronosPrediction | null = null;
    try {
      kronos = await opts.fetchKronos(symbol, candles);
    } catch {
      kronos = null;
    }

    const classification = classifyComposite(opts.axisLevel, opts.axisVelocitySlopePerHour, kronos);
    if ("rejectReason" in classification) {
      if (classification.rejectReason === "INSUFFICIENT_INPUTS") result.insufficientInputs += 1;
      else if (classification.rejectReason === "AXIS_INTERNAL_CONFLICT") result.axisConflict += 1;
      else result.ambiguousNearZero += 1;
      continue;
    }

    const openInBucket = opts.store.all.filter((o) => o.status === "OPEN" && o.bucket === classification.bucket).length;
    if (openInBucket >= maxPerBucket) continue;

    const entryPrice = candles[candles.length - 1]!.close;
    const geometry = buildCompositeGeometry(entryPrice, classification.direction, classification.bucket);
    if (!geometry) continue;

    const normVelocity = normalizeVelocity(opts.axisVelocitySlopePerHour);
    const normKronos = normalizeKronos(kronos);
    const observationId = `ce:${symbol}:${opts.now}`;
    const added = opts.store.add({
      ...geometry,
      observationId,
      symbol,
      direction: classification.direction,
      bucket: classification.bucket,
      compositeAtEntry: classification.composite,
      levelAtEntry: finite(opts.axisLevel) ? opts.axisLevel : null,
      velocityAtEntry: normVelocity,
      kronosContributionAtEntry: normKronos?.contribution ?? null,
      openedAt: nowIso,
      openedAtMs: opts.now,
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

export async function runCompositeEstimatorCycleGuarded(opts: Parameters<typeof runCompositeEstimatorCycle>[0]): Promise<CECycleResult | null> {
  try {
    return await runCompositeEstimatorCycle(opts);
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
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface CEBucketStats {
  bucket: CEBucket;
  proven: boolean;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  edgeReady: boolean;
}

function bucketStats(bucket: CEBucket, observations: readonly CompositeEstimatorObservation[]): CEBucketStats {
  const inBucket = observations.filter((o) => o.bucket === bucket);
  const open = inBucket.filter((o) => o.status === "OPEN");
  const resolved = inBucket.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const netAvgR = mean(nets);
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;
  return {
    bucket,
    proven: !CE_UNPROVEN_BUCKETS.has(bucket),
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    edgeReady,
  };
}

export interface CompositeEstimatorReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  deadzone: number;
  steepThreshold: number;
  buckets: CEBucketStats[];
  openCount: number;
  resolvedCount: number;
  topRecent: Array<{ symbol: string; bucket: CEBucket; netR: number | null; status: string; exitReason: string | null; openedAt: string; compositeAtEntry: number }>;
  cycleMeta: CECycleMeta | null;
}

export function buildCompositeEstimatorReport(
  observations: readonly CompositeEstimatorObservation[],
  cycleMeta?: CECycleMeta,
): CompositeEstimatorReport {
  const buckets: CEBucket[] = ["WIDE_LONG", "WIDE_SHORT", "FAST_LONG", "FAST_SHORT"];
  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 20)
    .map((o) => ({ symbol: o.symbol, bucket: o.bucket, netR: o.netR, status: o.status, exitReason: o.exitReason, openedAt: o.openedAt, compositeAtEntry: o.compositeAtEntry }));

  return {
    laneId: CE_PAPER_LANE_ID,
    interval: CE_INTERVAL,
    universe: CE_UNIVERSE,
    deadzone: CE_DEADZONE,
    steepThreshold: CE_STEEP_THRESHOLD,
    buckets: buckets.map((b) => bucketStats(b, observations)),
    openCount: observations.filter((o) => o.status === "OPEN").length,
    resolvedCount: observations.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS").length,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

// ── live execution wiring (2026-07-09) ──────────────────────────────────────
// Adapters for single-symbol-lane-executor.ts's generic executor. This lane stays a pure
// measurement module above this line — these functions are the ONLY seam connecting it to real
// execution, and none of them change what gets recorded/resolved for OOS measurement.

/** This bucket's OPEN observations → the generic single-symbol executor's common signal shape. */
export function compositeEstimatorOpenSignals(store: CompositeEstimatorStore, bucket: CEBucket): SingleSymbolFreshSignal[] {
  return store.all
    .filter((o) => o.status === "OPEN" && o.bucket === bucket)
    .map((o) => ({
      observationId: o.observationId,
      symbol: o.symbol,
      entryPrice: o.entryPrice,
      stopPrice: o.initialStop,
      openedAtMs: o.openedAtMs,
    }));
}

/** Same exit geometry as the paper measurement for this bucket. */
export function compositeEstimatorExitPolicy(bucket: CEBucket): SingleSymbolExitPolicy {
  const isWide = bucket === "WIDE_LONG" || bucket === "WIDE_SHORT";
  return makeFixedRewardExitPolicy({
    rewardMultiple: isWide ? CE_WIDE_TP_REWARD_MULTIPLE : CE_FAST_TP_REWARD_MULTIPLE,
    maxHoldMs: (isWide ? CE_WIDE_MAX_HOLD_HOURS : CE_FAST_MAX_HOLD_HOURS) * 3_600_000,
  });
}

/** Own enable flag (2026-07-09), independent of every other executor's flag — this lane never
 *  executed a real order before this date, so turning it on must be an explicit, separate act. */
export function isCompositeEstimatorExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPOSITE_ESTIMATOR_EXEC_ENABLED === "1";
}
/** Base per-position notional, BEFORE the unproven-quadrant size cut and allocation-weight scaling.
 *  150 (not 130 like REGIME_COMPOSITE_CONFIRMATION_LONG) so that even after the 0.5x unproven cut
 *  (75), BTCUSDT's real stepSize (0.001) still clears at its live price (~$62,840) — see that
 *  lane's own same-day incident for why this margin matters. */
export const CE_EXEC_LEG_USD = (): number => {
  const n = Number.parseFloat(process.env.COMPOSITE_ESTIMATOR_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 150;
};
export const CE_EXEC_LEVERAGE = (): number => {
  const n = Number.parseInt(process.env.COMPOSITE_ESTIMATOR_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
export const CE_EXEC_MAX_SIGNAL_AGE_MS = (): number =>
  Math.max(60_000, Math.floor(Number(process.env.COMPOSITE_ESTIMATOR_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
export const CE_EXEC_DAILY_MAX_LOSS_USD = (): number => {
  const n = Number.parseFloat(process.env.COMPOSITE_ESTIMATOR_EXEC_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8;
};
export const CE_EXEC_MAX_CONCURRENT = (): number => {
  const n = Number.parseInt(process.env.COMPOSITE_ESTIMATOR_EXEC_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : CE_MAX_CONCURRENT_PER_BUCKET;
};
/** Size multiplier applied to WIDE_SHORT/FAST_LONG (the unproven quadrants) real execution
 *  instances only — see module header. */
export const CE_UNPROVEN_QUADRANT_SIZE_MULT = (): number => {
  const n = Number.parseFloat(process.env.COMPOSITE_ESTIMATOR_UNPROVEN_QUADRANT_SIZE_MULT ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
};
/** Per-bucket effective leg USD: full CE_EXEC_LEG_USD for the proven buckets (WIDE_LONG,
 *  FAST_SHORT), cut by CE_UNPROVEN_QUADRANT_SIZE_MULT for the unproven ones (WIDE_SHORT, FAST_LONG). */
export function ceExecLegUsdForBucket(bucket: CEBucket): number {
  const base = CE_EXEC_LEG_USD();
  return CE_UNPROVEN_BUCKETS.has(bucket) ? base * CE_UNPROVEN_QUADRANT_SIZE_MULT() : base;
}

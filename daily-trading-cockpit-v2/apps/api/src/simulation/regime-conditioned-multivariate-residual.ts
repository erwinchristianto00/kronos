/**
 * Phase-3A: synchronized BTC/ETH empirical-residual generator.
 *
 * This deliberately does not join, stitch, interpolate, or replay historical blocks. Each generated hour samples
 * one synchronized residual vector, conditional on a state derived solely from calibration history, then advances a
 * continuous price path. If the requested conditional support is absent, generation fails closed rather than
 * silently falling back to an unconditional global residual pool.
 */
import { buildCommonMarketFrame } from "./common-market-frame.js";
import type { DeterministicRng } from "./deterministic-rng.js";
import type { CommonMarketFrame } from "./simulation-types.js";
import { mean, std } from "./calibration-metrics.js";

export type ResidualCandidate =
  | "EMPIRICAL_SYNC"
  | "REGIME_CONDITIONED"
  | "STATE_SPACE_EMPIRICAL"
  | "VAR_EMPIRICAL"
  | "ANCHORED_DIFFUSION_EMPIRICAL"
  | "GAUSSIAN_NEGATIVE_CONTROL";

export type ResidualRegime = "TREND_UP" | "TREND_DOWN" | "MIXED";
export type VolatilityBucket = "LOW" | "MEDIUM" | "HIGH";
export type DependenceBucket = "LOW" | "MEDIUM" | "HIGH";
export type ReturnDirection = "UP" | "DOWN" | "FLAT";
export type ConditionalSupportStatus = "SUPPORTED" | "INSUFFICIENT_CONDITIONAL_SUPPORT";
export type ConditionalFallbackLevel =
  | "EXACT_REGIME_VOL_DEPENDENCE"
  | "REGIME_VOL"
  | "VOL_RETURN_DIRECTION"
  | "BROAD_MARKET_STATE"
  | "INSUFFICIENT_CONDITIONAL_SUPPORT";

export interface ResidualState {
  regime: ResidualRegime;
  volatilityBucket: VolatilityBucket;
  dependenceBucket: DependenceBucket;
  returnDirection: ReturnDirection;
  rollingVolatility: number;
  rollingCorrelation: number | null;
}

export interface OhlcGeometry {
  btcUpperLogWick: number;
  btcLowerLogWick: number;
  ethUpperLogWick: number;
  ethLowerLogWick: number;
}

/** One observed BTC/ETH residual event. It is a vector, never an independently sampled per-asset return. */
export interface SynchronizedResidualVector {
  sourceIndex: number;
  timestampMs: number;
  month: string;
  hourOfDayUtc: number;
  dayOfWeekUtc: number;
  state: ResidualState;
  btcResidual: number;
  ethResidual: number;
  btcObservedReturn: number;
  ethObservedReturn: number;
  relativeVolatility: number | null;
  btcVolumeLogChange: number | null;
  ethVolumeLogChange: number | null;
  geometry: OhlcGeometry;
}

export interface CalibrationEstimate<T> {
  value: T | null;
  sampleSize: number;
  effectiveSampleSize: number;
  calibrationStartMs: number | null;
  calibrationEndMs: number | null;
  uncertainty: number | null;
  supportStatus: ConditionalSupportStatus;
}

export interface StateDynamics {
  regimeTransition: CalibrationEstimate<Record<ResidualRegime, Partial<Record<ResidualRegime, number>>>>;
  volatilityPersistence: CalibrationEstimate<number>;
  volatilityOfVolatility: CalibrationEstimate<number>;
  correlationPersistence: CalibrationEstimate<number>;
  volumePersistence: CalibrationEstimate<number>;
  fundingMeanReversion: CalibrationEstimate<null>;
  markBasisDynamics: CalibrationEstimate<null>;
}

export interface ResidualModel {
  version: "phase3a-residual-v1";
  btc: string;
  eth: string;
  calibrationStartMs: number;
  calibrationEndMs: number;
  records: SynchronizedResidualVector[];
  conditionalExpectedReturns: Map<string, { btc: number; eth: number; sampleSize: number }>;
  dynamics: StateDynamics;
  sourceDimensions: {
    candle: "PRESENT";
    volume: "PRESENT";
    funding: "UNSUPPORTED";
    markBasis: "UNSUPPORTED";
  };
  /** Derived cache; not calibration data and never serialized as evidence. */
  conditionalPoolCache: Map<string, ConditionalSelection>;
}

export interface ConditionalSelection {
  level: ConditionalFallbackLevel;
  candidates: readonly SynchronizedResidualVector[];
  supportStatus: ConditionalSupportStatus;
  estimate: CalibrationEstimate<number>;
}

export interface GenerationConfig {
  runId: string;
  candidate: ResidualCandidate;
  steps: number;
  startFrame: CommonMarketFrame;
  seed: number;
  minConditionalSupport?: number;
  state?: ResidualState;
}

export interface MemorizationMetrics {
  uniqueResidualCoverage: number;
  topResidualConcentration: number;
  longestCopiedResidualSequence: number;
  repeatedFingerprintRate: number;
  sourceMonthConcentration: Record<string, number>;
  effectiveSampleSize: number;
}

export interface ResidualGenerationResult {
  ok: boolean;
  reason: ConditionalSupportStatus | null;
  frames: CommonMarketFrame[];
  selections: Array<{ sourceIndex: number; level: ConditionalFallbackLevel; state: ResidualState }>;
  memorandum: MemorizationMetrics;
  provenance: "EMPIRICALLY_CALIBRATED";
}

const HOUR = 3_600_000;
const EPS = 1e-12;
const stateKey = (s: Pick<ResidualState, "regime" | "volatilityBucket" | "dependenceBucket" | "returnDirection">): string =>
  `${s.regime}|${s.volatilityBucket}|${s.dependenceBucket}|${s.returnDirection}`;
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  const ma = mean(a.slice(-n)); const mb = mean(b.slice(-n));
  if (ma == null || mb == null) return null;
  let numerator = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[a.length - n + i]! - ma; const xb = b[b.length - n + i]! - mb;
    numerator += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da > 0 && db > 0 ? numerator / Math.sqrt(da * db) : null;
}

function autocorrelation(values: readonly number[]): number | null {
  return values.length < 5 ? null : correlation(values.slice(1), values.slice(0, -1));
}

function bucket(value: number, p33: number, p66: number): VolatilityBucket | DependenceBucket {
  return value <= p33 ? "LOW" : value <= p66 ? "MEDIUM" : "HIGH";
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.floor(clamp(p, 0, 1) * (sorted.length - 1))]!;
}

function direction(value: number): ReturnDirection {
  return value > 0.0005 ? "UP" : value < -0.0005 ? "DOWN" : "FLAT";
}

function classifyRegime(trailingReturns: readonly number[], volatility: number): ResidualRegime {
  const drift = trailingReturns.reduce((sum, v) => sum + v, 0);
  const threshold = Math.max(0.002, volatility * Math.sqrt(Math.max(1, trailingReturns.length)) * 0.65);
  return drift > threshold ? "TREND_UP" : drift < -threshold ? "TREND_DOWN" : "MIXED";
}

function candleOf(frame: CommonMarketFrame, symbol: string) {
  return frame.symbols[symbol]?.candle.value ?? null;
}

function finiteLogRatio(numerator: number, denominator: number): number | null {
  return numerator > 0 && denominator > 0 ? Math.log(numerator / denominator) : null;
}

function unsupportedEstimate(start: number | null, end: number | null): CalibrationEstimate<null> {
  return { value: null, sampleSize: 0, effectiveSampleSize: 0, calibrationStartMs: start, calibrationEndMs: end, uncertainty: null, supportStatus: "INSUFFICIENT_CONDITIONAL_SUPPORT" };
}

/** Fits entirely on the supplied calibration frames. Callers must keep evaluation/holdout frames out of this input. */
export function fitRegimeConditionedResidualModel(frames: readonly CommonMarketFrame[], btc = "BTCUSDT", eth = "ETHUSDT", lookback = 24): ResidualModel {
  const btcCandles = frames.map((f) => candleOf(f, btc)); const ethCandles = frames.map((f) => candleOf(f, eth));
  const btcReturns: number[] = []; const ethReturns: number[] = []; const volumeBtc: number[] = []; const volumeEth: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const prevBtc = btcCandles[i - 1]; const nextBtc = btcCandles[i]; const prevEth = ethCandles[i - 1]; const nextEth = ethCandles[i];
    if (!prevBtc || !nextBtc || !prevEth || !nextEth) { btcReturns.push(NaN); ethReturns.push(NaN); volumeBtc.push(NaN); volumeEth.push(NaN); continue; }
    btcReturns.push(Math.log(nextBtc.close / prevBtc.close)); ethReturns.push(Math.log(nextEth.close / prevEth.close));
    volumeBtc.push(Math.log((nextBtc.volume + EPS) / (prevBtc.volume + EPS))); volumeEth.push(Math.log((nextEth.volume + EPS) / (prevEth.volume + EPS)));
  }
  const rollingVols: number[] = []; const rollingCorrs: number[] = [];
  for (let ri = 0; ri < btcReturns.length; ri += 1) {
    const b = btcReturns.slice(Math.max(0, ri - lookback), ri).filter(Number.isFinite);
    const e = ethReturns.slice(Math.max(0, ri - lookback), ri).filter(Number.isFinite);
    rollingVols.push(std(b) ?? 0); rollingCorrs.push(correlation(b, e) ?? 0);
  }
  const vol33 = percentile(rollingVols, 1 / 3); const vol66 = percentile(rollingVols, 2 / 3);
  const dep33 = percentile(rollingCorrs, 1 / 3); const dep66 = percentile(rollingCorrs, 2 / 3);
  const raw: Array<Omit<SynchronizedResidualVector, "btcResidual" | "ethResidual"> & { expectedStateKey: string }> = [];
  for (let ri = lookback; ri < btcReturns.length; ri += 1) {
    const frame = frames[ri + 1]!; const btcCandle = btcCandles[ri + 1]; const ethCandle = ethCandles[ri + 1];
    const bReturn = btcReturns[ri]; const eReturn = ethReturns[ri];
    if (!btcCandle || !ethCandle || !Number.isFinite(bReturn) || !Number.isFinite(eReturn)) continue;
    const bTrail = btcReturns.slice(ri - lookback, ri).filter(Number.isFinite);
    const eTrail = ethReturns.slice(ri - lookback, ri).filter(Number.isFinite);
    const rollingVolatility = std(bTrail) ?? 0; const rollingCorrelation = correlation(bTrail, eTrail);
    const state: ResidualState = {
      regime: classifyRegime(bTrail, rollingVolatility), volatilityBucket: bucket(rollingVolatility, vol33, vol66) as VolatilityBucket,
      dependenceBucket: bucket(rollingCorrelation ?? 0, dep33, dep66) as DependenceBucket,
      returnDirection: direction(bTrail.at(-1) ?? 0), rollingVolatility, rollingCorrelation,
    };
    const maxBtc = Math.max(btcCandle.open, btcCandle.close); const minBtc = Math.min(btcCandle.open, btcCandle.close);
    const maxEth = Math.max(ethCandle.open, ethCandle.close); const minEth = Math.min(ethCandle.open, ethCandle.close);
    raw.push({ sourceIndex: ri, timestampMs: frame.asOfMs, month: new Date(frame.asOfMs).toISOString().slice(0, 7), hourOfDayUtc: new Date(frame.asOfMs).getUTCHours(), dayOfWeekUtc: new Date(frame.asOfMs).getUTCDay(), state, expectedStateKey: stateKey(state), btcObservedReturn: bReturn, ethObservedReturn: eReturn, relativeVolatility: (std(eTrail) ?? 0) / Math.max(rollingVolatility, EPS), btcVolumeLogChange: volumeBtc[ri] ?? null, ethVolumeLogChange: volumeEth[ri] ?? null, geometry: { btcUpperLogWick: Math.max(0, Math.log(btcCandle.high / maxBtc)), btcLowerLogWick: Math.max(0, Math.log(minBtc / btcCandle.low)), ethUpperLogWick: Math.max(0, Math.log(ethCandle.high / maxEth)), ethLowerLogWick: Math.max(0, Math.log(minEth / ethCandle.low)) } });
  }
  const expected = new Map<string, { btc: number; eth: number; sampleSize: number }>();
  for (const record of raw) {
    const old = expected.get(record.expectedStateKey) ?? { btc: 0, eth: 0, sampleSize: 0 };
    old.btc += record.btcObservedReturn; old.eth += record.ethObservedReturn; old.sampleSize += 1; expected.set(record.expectedStateKey, old);
  }
  for (const value of expected.values()) { value.btc /= value.sampleSize; value.eth /= value.sampleSize; }
  const records = raw.map(({ expectedStateKey, ...record }) => {
    const mu = expected.get(expectedStateKey)!;
    return { ...record, btcResidual: record.btcObservedReturn - mu.btc, ethResidual: record.ethObservedReturn - mu.eth };
  });
  const start = frames.at(0)?.asOfMs ?? 0; const end = frames.at(-1)?.asOfMs ?? 0;
  const transitions: Record<ResidualRegime, Partial<Record<ResidualRegime, number>>> = { TREND_UP: {}, TREND_DOWN: {}, MIXED: {} };
  for (let i = 1; i < records.length; i += 1) { const from = records[i - 1]!.state.regime; const to = records[i]!.state.regime; transitions[from]![to] = (transitions[from]![to] ?? 0) + 1; }
  for (const row of Object.values(transitions)) { const total = Object.values(row).reduce((sum, v) => sum + v, 0); if (total) for (const key of Object.keys(row) as ResidualRegime[]) row[key] = row[key]! / total; }
  const volatilitySeries = records.map((r) => r.state.rollingVolatility); const corrSeries = records.map((r) => r.state.rollingCorrelation).filter((x): x is number => x != null); const volumeSeries = records.map((r) => r.btcVolumeLogChange).filter((x): x is number => x != null);
  const estimate = (value: number | null, values: readonly number[]): CalibrationEstimate<number> => ({ value, sampleSize: values.length, effectiveSampleSize: Math.max(0, Math.round(values.length * (1 - Math.abs(autocorrelation(values) ?? 0)))), calibrationStartMs: start || null, calibrationEndMs: end || null, uncertainty: std(values), supportStatus: values.length >= lookback ? "SUPPORTED" : "INSUFFICIENT_CONDITIONAL_SUPPORT" });
  return { version: "phase3a-residual-v1", btc, eth, calibrationStartMs: start, calibrationEndMs: end, records, conditionalExpectedReturns: expected, dynamics: { regimeTransition: { value: transitions, sampleSize: Math.max(0, records.length - 1), effectiveSampleSize: Math.max(0, records.length - 1), calibrationStartMs: start || null, calibrationEndMs: end || null, uncertainty: null, supportStatus: records.length >= lookback ? "SUPPORTED" : "INSUFFICIENT_CONDITIONAL_SUPPORT" }, volatilityPersistence: estimate(autocorrelation(volatilitySeries), volatilitySeries), volatilityOfVolatility: estimate(std(volatilitySeries.map((v, i) => i ? v - volatilitySeries[i - 1]! : NaN).filter(Number.isFinite)), volatilitySeries), correlationPersistence: estimate(autocorrelation(corrSeries), corrSeries), volumePersistence: estimate(autocorrelation(volumeSeries), volumeSeries), fundingMeanReversion: unsupportedEstimate(start || null, end || null), markBasisDynamics: unsupportedEstimate(start || null, end || null) }, sourceDimensions: { candle: "PRESENT", volume: "PRESENT", funding: "UNSUPPORTED", markBasis: "UNSUPPORTED" }, conditionalPoolCache: new Map() };
}

/** Exact mandatory hierarchy. Broad state still conditions on regime; there is intentionally no global fallback. */
export function selectConditionalResiduals(model: ResidualModel, state: ResidualState, minSupport = 8): ConditionalSelection {
  const cacheKey = `${stateKey(state)}|${minSupport}`;
  const cached = model.conditionalPoolCache.get(cacheKey);
  if (cached) return cached;
  const rules: Array<{ level: ConditionalFallbackLevel; match: (r: SynchronizedResidualVector) => boolean }> = [
    { level: "EXACT_REGIME_VOL_DEPENDENCE", match: (r) => r.state.regime === state.regime && r.state.volatilityBucket === state.volatilityBucket && r.state.dependenceBucket === state.dependenceBucket },
    { level: "REGIME_VOL", match: (r) => r.state.regime === state.regime && r.state.volatilityBucket === state.volatilityBucket },
    { level: "VOL_RETURN_DIRECTION", match: (r) => r.state.volatilityBucket === state.volatilityBucket && r.state.returnDirection === state.returnDirection },
    { level: "BROAD_MARKET_STATE", match: (r) => r.state.regime === state.regime },
  ];
  for (const rule of rules) {
    const candidates = model.records.filter(rule.match);
    if (candidates.length >= minSupport) {
      const selected = { level: rule.level, candidates, supportStatus: "SUPPORTED" as const, estimate: { value: candidates.length, sampleSize: candidates.length, effectiveSampleSize: candidates.length, calibrationStartMs: model.calibrationStartMs, calibrationEndMs: model.calibrationEndMs, uncertainty: null, supportStatus: "SUPPORTED" as const } };
      model.conditionalPoolCache.set(cacheKey, selected); return selected;
    }
  }
  const insufficient = { level: "INSUFFICIENT_CONDITIONAL_SUPPORT" as const, candidates: [], supportStatus: "INSUFFICIENT_CONDITIONAL_SUPPORT" as const, estimate: { value: null, sampleSize: 0, effectiveSampleSize: 0, calibrationStartMs: model.calibrationStartMs, calibrationEndMs: model.calibrationEndMs, uncertainty: null, supportStatus: "INSUFFICIENT_CONDITIONAL_SUPPORT" as const } };
  model.conditionalPoolCache.set(cacheKey, insufficient); return insufficient;
}

function updateState(model: ResidualModel, previous: ResidualState, chosen: SynchronizedResidualVector): ResidualState {
  // State evolves from observed calibration transition statistics plus the sampled residual event, never from future frames.
  const transition = model.dynamics.regimeTransition.value?.[previous.regime] ?? {}; const target = (Object.entries(transition).sort((a, b) => b[1]! - a[1]!)[0]?.[0] ?? previous.regime) as ResidualRegime;
  const nextVol = Math.max(EPS, previous.rollingVolatility * 0.75 + Math.abs(chosen.btcResidual) * 0.25);
  return { regime: target, volatilityBucket: chosen.state.volatilityBucket, dependenceBucket: chosen.state.dependenceBucket, returnDirection: direction(chosen.btcResidual), rollingVolatility: nextVol, rollingCorrelation: chosen.state.rollingCorrelation };
}

function expectedReturn(model: ResidualModel, state: ResidualState, candidate: ResidualCandidate): { btc: number; eth: number } {
  const base = model.conditionalExpectedReturns.get(stateKey(state)) ?? { btc: 0, eth: 0 };
  if (candidate === "EMPIRICAL_SYNC") return { btc: 0, eth: 0 };
  if (candidate === "ANCHORED_DIFFUSION_EMPIRICAL") return { btc: base.btc * 0.5, eth: base.eth * 0.5 };
  if (candidate === "VAR_EMPIRICAL") return { btc: base.btc * 0.75, eth: base.eth * 0.75 };
  return base;
}

function newMemorizationMetrics(records: readonly SynchronizedResidualVector[], chosen: readonly number[]): MemorizationMetrics {
  if (!chosen.length) return { uniqueResidualCoverage: 0, topResidualConcentration: 0, longestCopiedResidualSequence: 0, repeatedFingerprintRate: 0, sourceMonthConcentration: {}, effectiveSampleSize: 0 };
  const recordMonths = new Map(records.map((record) => [record.sourceIndex, record.month]));
  const counts = new Map<number, number>(); const months = new Map<string, number>(); let longest = 1; let current = 1;
  for (let i = 0; i < chosen.length; i += 1) { counts.set(chosen[i]!, (counts.get(chosen[i]!) ?? 0) + 1); const month = recordMonths.get(chosen[i]!) ?? "unknown"; months.set(month, (months.get(month) ?? 0) + 1); if (i && chosen[i] === chosen[i - 1]! + 1) { current += 1; longest = Math.max(longest, current); } else current = 1; }
  const fingerprintCounts = new Map<string, number>(); for (let i = 0; i + 2 < chosen.length; i += 1) { const fp = chosen.slice(i, i + 3).join(":"); fingerprintCounts.set(fp, (fingerprintCounts.get(fp) ?? 0) + 1); }
  const top = Math.max(...counts.values()); const repeated = [...fingerprintCounts.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
  return { uniqueResidualCoverage: counts.size / chosen.length, topResidualConcentration: top / chosen.length, longestCopiedResidualSequence: longest, repeatedFingerprintRate: chosen.length > 2 ? repeated / (chosen.length - 2) : 0, sourceMonthConcentration: Object.fromEntries([...months].map(([m, n]) => [m, n / chosen.length])), effectiveSampleSize: Math.round(chosen.length * (1 - top / chosen.length)) };
}

/** Produces a continuous 1h price path. No frame from history is inserted into the output. */
export function generateRegimeConditionedResidualPath(model: ResidualModel, config: GenerationConfig, rng: DeterministicRng): ResidualGenerationResult {
  const startBtc = candleOf(config.startFrame, model.btc); const startEth = candleOf(config.startFrame, model.eth);
  if (!startBtc || !startEth || config.steps < 1) return { ok: false, reason: "INSUFFICIENT_CONDITIONAL_SUPPORT", frames: [], selections: [], memorandum: newMemorizationMetrics(model.records, []), provenance: "EMPIRICALLY_CALIBRATED" };
  let btcPrice = startBtc.close; let ethPrice = startEth.close; let btcVolume = Math.max(startBtc.volume, EPS); let ethVolume = Math.max(startEth.volume, EPS);
  let state = config.state ?? model.records.at(-1)?.state;
  if (!state) return { ok: false, reason: "INSUFFICIENT_CONDITIONAL_SUPPORT", frames: [], selections: [], memorandum: newMemorizationMetrics(model.records, []), provenance: "EMPIRICALLY_CALIBRATED" };
  const frames: CommonMarketFrame[] = []; const selections: Array<{ sourceIndex: number; level: ConditionalFallbackLevel; state: ResidualState }> = []; const chosenIndices: number[] = [];
  // State selection depends only on its categorical key; cache pools so 100-seed research is linear in path length,
  // not in (path length × library size).
  for (let step = 0; step < config.steps; step += 1) {
    const selection = selectConditionalResiduals(model, state, config.minConditionalSupport);
    if (selection.supportStatus !== "SUPPORTED") return { ok: false, reason: "INSUFFICIENT_CONDITIONAL_SUPPORT", frames: [], selections, memorandum: newMemorizationMetrics(model.records, chosenIndices), provenance: "EMPIRICALLY_CALIBRATED" };
    const source = selection.candidates[rng.nextInt(0, selection.candidates.length)]!; const mu = expectedReturn(model, state, config.candidate);
    let btcResidual = source.btcResidual; let ethResidual = source.ethResidual;
    if (config.candidate === "GAUSSIAN_NEGATIVE_CONTROL") {
      // Deliberately weak negative control: normal residuals retain only conditional first/second moments. It is never
      // a primary candidate and cannot bypass the same fail-closed conditional-support hierarchy.
      const btcSigma = std(selection.candidates.map((r) => r.btcResidual)) ?? 0;
      const ethSigma = std(selection.candidates.map((r) => r.ethResidual)) ?? 0;
      const rho = clamp(correlation(selection.candidates.map((r) => r.btcResidual), selection.candidates.map((r) => r.ethResidual)) ?? 0, -0.99, 0.99);
      const z1 = rng.normal(0, 1); const z2 = rng.normal(0, 1);
      btcResidual = z1 * btcSigma;
      ethResidual = (rho * z1 + Math.sqrt(1 - rho * rho) * z2) * ethSigma;
    }
    const btcReturn = mu.btc + btcResidual; const ethReturn = mu.eth + ethResidual;
    const nextBtc = btcPrice * Math.exp(btcReturn); const nextEth = ethPrice * Math.exp(ethReturn);
    if (!(nextBtc > 0) || !(nextEth > 0) || !Number.isFinite(nextBtc) || !Number.isFinite(nextEth)) return { ok: false, reason: "INSUFFICIENT_CONDITIONAL_SUPPORT", frames: [], selections, memorandum: newMemorizationMetrics(model.records, chosenIndices), provenance: "EMPIRICALLY_CALIBRATED" };
    const btcHigh = Math.max(btcPrice, nextBtc) * Math.exp(source.geometry.btcUpperLogWick); const btcLow = Math.min(btcPrice, nextBtc) * Math.exp(-source.geometry.btcLowerLogWick);
    const ethHigh = Math.max(ethPrice, nextEth) * Math.exp(source.geometry.ethUpperLogWick); const ethLow = Math.min(ethPrice, nextEth) * Math.exp(-source.geometry.ethLowerLogWick);
    btcVolume *= Math.exp(source.btcVolumeLogChange ?? 0); ethVolume *= Math.exp(source.ethVolumeLogChange ?? 0);
    const openTimeMs = config.startFrame.asOfMs + step * HOUR; const closeTimeMs = openTimeMs + HOUR - 1;
    frames.push(buildCommonMarketFrame({ runId: config.runId, asOfMs: closeTimeMs, provenance: "EMPIRICALLY_CALIBRATED", symbols: { [model.btc]: { source: `phase3a:residual:${source.sourceIndex}`, candle: { openTimeMs, closeTimeMs, open: btcPrice, high: btcHigh, low: btcLow, close: nextBtc, volume: btcVolume } }, [model.eth]: { source: `phase3a:residual:${source.sourceIndex}`, candle: { openTimeMs, closeTimeMs, open: ethPrice, high: ethHigh, low: ethLow, close: nextEth, volume: ethVolume } } } }));
    selections.push({ sourceIndex: source.sourceIndex, level: selection.level, state }); chosenIndices.push(source.sourceIndex); btcPrice = nextBtc; ethPrice = nextEth; state = updateState(model, state, source);
  }
  return { ok: true, reason: null, frames, selections, memorandum: newMemorizationMetrics(model.records, chosenIndices), provenance: "EMPIRICALLY_CALIBRATED" };
}

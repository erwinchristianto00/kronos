/**
 * Regime-axis timeline (report-only visualization).
 *
 * Operator ask (2026-07-07): "I can see WHICH regime we're in, but not how long it will last or
 * how close it is to flipping — chart it, where touching the middle line means 'about to go
 * neutral'."
 *
 * The 5-regime detector emits a discrete label; for a timeline you need something CONTINUOUS.
 * This module derives a signed composite score in [-1, +1] from the SAME breadth inputs the
 * regime engine records with every snapshot (advancers %, % above EMA20, BTC 24h return):
 *   +1 = maximally bullish breadth, 0 = the neutral zone, -1 = maximally bearish breadth.
 *
 * HONESTY CONTRACT: this is a VISUAL COMPOSITE of the engine's inputs, not its decision logic —
 * the engine's actual regime label is carried alongside every point so the two can be compared.
 * The "ETA to neutral" is a straight-line extrapolation of the recent slope, labeled as such:
 * it says "at the current pace", never "will happen".
 */
import type { RegimeEngineSnapshot } from "./regime-engine-service.js";

/** Full-scale BTC 24h move for the score's third component: ±3% in 24h saturates that input. */
const BTC_RETURN_FULL_SCALE = 0.03;

/**
 * 2026-07-19 fix: `runRegimeEngineCycleGuarded` (regime-engine-service.ts) fires the collection
 * cycle fire-and-forget with `.catch(() => {})` — a silently-failing cycle (documented recurring
 * failure mode in this system: Binance geo-block, transient API errors) simply stops appending new
 * snapshots. Without an explicit staleness check, `current` below is just "the last element of the
 * array" regardless of age, so a stuck engine keeps returning its last directional read forever with
 * no signal anything is wrong.
 *
 * Threshold rationale: the regime engine cycle runs roughly every 7 minutes in steady state
 * (MAX_SNAPSHOTS's own "~2 weeks at 7-min cycles" comment in regime-engine-service.ts) with a
 * MIN_CYCLE_GAP_MS floor of 5 minutes. This mirrors the same "tolerate a couple of missed/failed
 * cycles, but catch a genuinely stuck loop" convention already used elsewhere in this codebase
 * (RC/RCS's ~10-minute REGIME_COMPOSITE_EXEC_MAX_SIGNAL_AGE_MS default; directional-symbol-sizing's
 * TECHNICAL_SIGNAL_MAX_STALE_MS = 3x its refresh cadence). At ~3x the regime engine's own cadence,
 * 20 minutes tolerates a couple of transient blips while still catching a stuck cycle promptly.
 * Env-tunable, like the other *_STALE_MS/*_MAX_SIGNAL_AGE_MS constants in this codebase.
 */
export const REGIME_AXIS_STALE_THRESHOLD_MS =
  Number(process.env.REGIME_AXIS_STALE_THRESHOLD_MS) || 20 * 60_000;

export interface RegimeAxisPoint {
  at: string;
  score: number;
  regime: string;
}

export interface RegimeAxisForecastHorizon {
  hours: 1 | 3 | 6;
  at: string;
  expectedScore: number;
  lowerScore: number;
  upperScore: number;
  bullProbability: number;
  neutralProbability: number;
  bearProbability: number;
  analogCount: number;
}

export interface RegimeAxisForecast {
  available: boolean;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  smoothedScore: number | null;
  consensusSlopePerHour: number | null;
  slopeAgreement: number | null;
  persistenceProbability: number | null;
  horizons: RegimeAxisForecastHorizon[];
  invalidation: string;
  reason: string;
}

export interface RegimeAxisZone {
  from: number;
  to: number;
  label: string;
  laneHint: string;
}

/**
 * A regime forecast is directional context, not an executable order. This second layer makes the
 * distinction explicit for an operator: a falling bear axis normally means wait for a rally to
 * fade, not sell a candle already extended into the lows. Symbol-level RC/RCS gates remain the
 * final authority for an entry.
 */
export interface RegimeAxisEntryDecision {
  action: "NO_TRADE" | "WAIT_PULLBACK" | "WAIT_REJECTION";
  directionalBias: "LONG" | "SHORT" | null;
  reason: string;
  requiredSetup: string;
  invalidation: string;
}

/** Lane-geometry guidance bands (2026-07-07 operator ask: "tandai di mana cocok fast vs wide").
 *  Anchored to the regime tree's own presets and the measured fast-vs-wide evidence (fast 0.5R TP
 *  lanes are the proven money-makers in extended-but-not-trending regimes; wide/runner geometry
 *  only earns in genuine trends; the neutral band is cross-sectional's home). Boundaries are
 *  GUIDANCE, not decision logic — the engine's own regime label stays authoritative, and
 *  perRegimeMedianScore in the timeline shows where each label empirically sits on this axis. */
// 2026-07-09: kept in sync with regime-autopilot.ts's REGIME_AUTOPILOT_PRESETS (rough analogy, not
// an identity — this axis's 5 zones come from a continuous score, the regime engine's 5 labels are
// discrete). Kept short on purpose — this renders as an SVG chart label, not a paragraph; the full
// per-lane weight breakdown lives in the dashboard's regime-tree table, not here.
export const REGIME_AXIS_ZONES: readonly RegimeAxisZone[] = [
  { from: 0.45, to: 1, label: "BULL TREND", laneHint: "LONG wide/runner + trend-follow" },
  { from: 0.12, to: 0.45, label: "BULL LEAN", laneHint: "LONG fast TP + momentum add-on" },
  { from: -0.12, to: 0.12, label: "NEUTRAL", laneHint: "cross-sectional only" },
  { from: -0.45, to: -0.12, label: "BEAR LEAN", laneHint: "SHORT fast TP + fade add-on" },
  { from: -1, to: -0.45, label: "BEAR TREND", laneHint: "SHORT wide/trend-follow" },
];

export interface RegimeAxisTimeline {
  points: RegimeAxisPoint[];
  /** Causal EWMA of the same points. It reduces single-snapshot breadth noise without seeing future rows. */
  smoothedPoints: Array<{ at: string; score: number }>;
  current: RegimeAxisPoint | null;
  /** Linear-fit slope of the score over the recent window, in score-units per hour. */
  slopePerHour: number | null;
  /** Hours until the straight-line extrapolation crosses 0 — null when moving AWAY from neutral,
   *  already at neutral, or the slope is too flat to say anything (|slope| < 0.005/h). */
  etaToNeutralHours: number | null;
  slopeWindowHours: number;
  zones: readonly RegimeAxisZone[];
  /** Empirical median score per engine regime label over this history — shows where each regime
   *  ACTUALLY sits on the axis, so the fixed zone bands can be sanity-checked against reality. */
  perRegimeMedianScore: Record<string, number>;
  /** Backward-compatible center line through the forecast horizons. Consumers should use `forecast`
   *  for uncertainty, probabilities, confidence, and analog sample counts. */
  projection: Array<{ at: string; score: number }>;
  /** Report-only regime forecast. Historical analogs use only observations whose future is already known;
   * current scoring never reads beyond the latest snapshot. This predicts regime-axis state, not price. */
  forecast: RegimeAxisForecast;
  /** Level×slope lane guidance (operator: "di titik mana gw masih pake FAST_SHORT, di titik mana
   *  change ke FAST_LONG"). Data-grounded: the switch point is the NEUTRAL BOUNDARY CROSSING, not
   *  the bottom of the bear zone — our own book (edge-memory + regime-gating report) shows
   *  counter-trend longs inside a bear zone lose even when the score is recovering toward neutral. */
  guidance: {
    zoneLabel: string;
    direction: "MENUJU_NETRAL" | "MENJAUH_NETRAL" | "FLAT";
    holdLane: string;
    switchToLane: string | null;
    /** Score that must be CROSSED before switching lanes (±0.12 = neutral boundary). */
    switchAtScore: number | null;
    etaToSwitchHours: number | null;
    note: string;
  } | null;
  /** Explicit separation between regime direction and entry timing. Never returns ENTER_NOW. */
  entryDecision: RegimeAxisEntryDecision;
  note: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const HOUR_MS = 3_600_000;
const FORECAST_HORIZONS = [1, 3, 6] as const;
const SLOPE_WINDOWS = [1, 3, 6] as const;

type ScoredPoint = RegimeAxisPoint & { atMs: number };

function causalEwma(points: readonly ScoredPoint[], halfLifeHours = 0.75): number[] {
  if (points.length === 0) return [];
  const out = [points[0]!.score];
  for (let i = 1; i < points.length; i += 1) {
    const dtHours = Math.max(0, (points[i]!.atMs - points[i - 1]!.atMs) / HOUR_MS);
    const alpha = 1 - Math.exp((-Math.LN2 * dtHours) / halfLifeHours);
    out.push(out[i - 1]! + clamp(alpha, 0, 1) * (points[i]!.score - out[i - 1]!));
  }
  return out;
}

function linearSlopeAt(points: readonly ScoredPoint[], values: readonly number[], endIndex: number, windowHours: number): number | null {
  const startMs = points[endIndex]!.atMs - windowHours * HOUR_MS;
  let startIndex = endIndex;
  while (startIndex > 0 && points[startIndex - 1]!.atMs >= startMs) startIndex -= 1;
  if (endIndex - startIndex + 1 < 3) return null;
  const baseMs = points[startIndex]!.atMs;
  const n = endIndex - startIndex + 1;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const x = (points[i]!.atMs - baseMs) / HOUR_MS;
    const y = values[i]!;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : null;
}

function recentVolatility(points: readonly ScoredPoint[], values: readonly number[], endIndex: number, windowHours = 3): number {
  const startMs = points[endIndex]!.atMs - windowHours * HOUR_MS;
  const deltas: number[] = [];
  for (let i = endIndex; i > 0 && points[i - 1]!.atMs >= startMs; i -= 1) deltas.push(values[i]! - values[i - 1]!);
  if (deltas.length < 2) return 0.08;
  const mean = deltas.reduce((sum, x) => sum + x, 0) / deltas.length;
  return Math.sqrt(deltas.reduce((sum, x) => sum + (x - mean) ** 2, 0) / deltas.length);
}

function weightedQuantile(rows: readonly { value: number; weight: number }[], q: number): number | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  const target = clamp(q, 0, 1) * total;
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= target) return row.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function nearestFutureIndex(points: readonly ScoredPoint[], fromIndex: number, hours: number): number | null {
  const target = points[fromIndex]!.atMs + hours * HOUR_MS;
  const tolerance = Math.max(45 * 60_000, hours * 0.25 * HOUR_MS);
  let best: { index: number; distance: number } | null = null;
  for (let i = fromIndex + 1; i < points.length; i += 1) {
    const distance = Math.abs(points[i]!.atMs - target);
    if (distance < (best?.distance ?? Number.POSITIVE_INFINITY)) best = { index: i, distance };
    if (points[i]!.atMs > target + tolerance) break;
  }
  return best && best.distance <= tolerance ? best.index : null;
}

function slopeConsensus(slopes: readonly (number | null)[]): { slope: number | null; agreement: number | null } {
  const weights = [0.35, 0.4, 0.25];
  const available = slopes.map((s, i) => ({ s, w: weights[i]! })).filter((x): x is { s: number; w: number } => x.s !== null);
  if (available.length === 0) return { slope: null, agreement: null };
  const totalWeight = available.reduce((sum, x) => sum + x.w, 0);
  const raw = available.reduce((sum, x) => sum + x.s * x.w, 0) / totalWeight;
  const sign = Math.abs(raw) < 0.005 ? 0 : Math.sign(raw);
  const agreeing = available.reduce((sum, x) => sum + (Math.abs(x.s) < 0.005 || Math.sign(x.s) === sign ? x.w : 0), 0);
  const agreement = agreeing / totalWeight;
  return { slope: raw * (0.35 + 0.65 * agreement), agreement };
}

function buildForecast(points: readonly ScoredPoint[], smoothed: readonly number[]): RegimeAxisForecast {
  const unavailable = (reason: string): RegimeAxisForecast => ({
    available: false,
    bias: "UNCERTAIN",
    confidence: "LOW",
    smoothedScore: smoothed[smoothed.length - 1] ?? null,
    consensusSlopePerHour: null,
    slopeAgreement: null,
    persistenceProbability: null,
    horizons: [],
    invalidation: "Belum ada forecast yang dapat divalidasi.",
    reason,
  });
  if (points.length < 6) return unavailable("Butuh sedikitnya 6 snapshot untuk membentuk momentum lintas-window.");

  const end = points.length - 1;
  const currentScore = smoothed[end]!;
  const currentSlopes = SLOPE_WINDOWS.map((hours) => linearSlopeAt(points, smoothed, end, hours));
  const consensus = slopeConsensus(currentSlopes);
  if (consensus.slope === null) return unavailable("Snapshot belum cukup rapat untuk menghitung slope 1/3/6 jam.");
  const currentVol = recentVolatility(points, smoothed, end);

  const candidates: Array<{ index: number; distance: number; slopes: Array<number | null> }> = [];
  const latestCandidateMs = points[end]!.atMs - 6 * HOUR_MS;
  for (let i = 5; i < end && points[i]!.atMs <= latestCandidateMs; i += 1) {
    const slopes = SLOPE_WINDOWS.map((hours) => linearSlopeAt(points, smoothed, i, hours));
    if (slopes.filter((x) => x !== null).length < 2) continue;
    const scoreDistance = Math.abs(smoothed[i]! - currentScore) / 0.3;
    let slopeDistance = 0;
    let slopePairs = 0;
    for (let j = 0; j < slopes.length; j += 1) {
      if (slopes[j] === null || currentSlopes[j] === null) continue;
      slopeDistance += Math.abs(slopes[j]! - currentSlopes[j]!) / 0.08;
      slopePairs += 1;
    }
    const volDistance = Math.abs(recentVolatility(points, smoothed, i) - currentVol) / 0.08;
    const zonePenalty = Math.sign(smoothed[i]!) === Math.sign(currentScore) || Math.abs(smoothed[i]!) < 0.12 ? 0 : 0.8;
    const distance = scoreDistance + slopeDistance / Math.max(1, slopePairs) + volDistance * 0.35 + zonePenalty;
    if (distance <= 4) candidates.push({ index: i, distance, slopes });
  }
  candidates.sort((a, b) => a.distance - b.distance);

  const horizons: RegimeAxisForecastHorizon[] = [];
  const confidenceScores: number[] = [];
  for (const hours of FORECAST_HORIZONS) {
    const analogRows: Array<{ value: number; weight: number }> = [];
    const selectedAnalogTimes: number[] = [];
    // Adjacent snapshots from one move are not independent evidence. Require at least one forecast
    // horizon between analog origins so a single episode cannot manufacture sample size/confidence.
    for (const candidate of candidates) {
      if (analogRows.length >= 40) break;
      const candidateAtMs = points[candidate.index]!.atMs;
      if (selectedAnalogTimes.some((atMs) => Math.abs(candidateAtMs - atMs) < hours * HOUR_MS)) continue;
      const futureIndex = nearestFutureIndex(points, candidate.index, hours);
      if (futureIndex === null) continue;
      analogRows.push({ value: smoothed[futureIndex]!, weight: 1 / (0.25 + candidate.distance) });
      selectedAnalogTimes.push(candidateAtMs);
    }
    const analogMedian = weightedQuantile(analogRows, 0.5);
    const trendScore = clamp(currentScore + consensus.slope * hours, -1, 1);
    const analogBlend = analogRows.length >= 8 && analogMedian !== null ? Math.min(0.7, 0.35 + analogRows.length / 100) : 0;
    const expectedScore = clamp(trendScore * (1 - analogBlend) + (analogMedian ?? trendScore) * analogBlend, -1, 1);
    const fallbackWidth = clamp(currentVol * Math.sqrt(hours) * 2.5 + 0.06, 0.08, 0.5);
    const lowerScore = clamp(weightedQuantile(analogRows, 0.25) ?? expectedScore - fallbackWidth, -1, 1);
    const upperScore = clamp(weightedQuantile(analogRows, 0.75) ?? expectedScore + fallbackWidth, -1, 1);
    // Sparse history must not produce fake 0%/100% probabilities. Fall back to a small symmetric
    // distribution around the trend estimate; confidence remains LOW until real analogs accumulate.
    const probabilityRows = analogRows.length >= 5
      ? analogRows
      : Array.from({ length: 21 }, (_, i) => {
          const normalized = (i - 10) / 10;
          return { value: clamp(expectedScore + normalized * fallbackWidth, -1, 1), weight: 1 - Math.abs(normalized) * 0.7 };
        });
    const totalWeight = probabilityRows.reduce((sum, row) => sum + row.weight, 0);
    const priorWeight = totalWeight / Math.max(1, probabilityRows.length);
    const probability = (predicate: (score: number) => boolean) =>
      (probabilityRows.reduce((sum, row) => sum + (predicate(row.value) ? row.weight : 0), 0) + priorWeight) /
      (totalWeight + 3 * priorWeight);
    const bullProbability = probability((score) => score > 0.12);
    const bearProbability = probability((score) => score < -0.12);
    const neutralProbability = probability((score) => score >= -0.12 && score <= 0.12);
    const intervalQuality = 1 - clamp((upperScore - lowerScore) / 0.8, 0, 1);
    confidenceScores.push(Math.min(1, analogRows.length / 24) * 0.45 + (consensus.agreement ?? 0) * 0.3 + intervalQuality * 0.25);
    horizons.push({
      hours,
      at: new Date(points[end]!.atMs + hours * HOUR_MS).toISOString(),
      expectedScore,
      lowerScore: Math.min(lowerScore, expectedScore),
      upperScore: Math.max(upperScore, expectedScore),
      bullProbability,
      neutralProbability,
      bearProbability,
      analogCount: analogRows.length,
    });
  }

  const anchor = horizons.find((h) => h.hours === 3) ?? horizons[0]!;
  const maxAnalogCount = Math.max(...horizons.map((h) => h.analogCount), 0);
  const topProbability = Math.max(anchor.bullProbability, anchor.neutralProbability, anchor.bearProbability);
  const bias: RegimeAxisForecast["bias"] =
    topProbability < 0.55
      ? "UNCERTAIN"
      : anchor.bullProbability === topProbability
        ? "BULLISH"
        : anchor.bearProbability === topProbability
          ? "BEARISH"
          : "NEUTRAL";
  const meanConfidence = confidenceScores.reduce((sum, x) => sum + x, 0) / Math.max(1, confidenceScores.length);
  const confidence: RegimeAxisForecast["confidence"] = maxAnalogCount < 8
    ? "LOW"
    : meanConfidence >= 0.72
      ? "HIGH"
      : meanConfidence >= 0.48
        ? "MEDIUM"
        : "LOW";
  // Must key off `bias` (the call already made from the 3h-ahead probability distribution), not off
  // currentScore's own ±0.12 zone: those are different quantities, and a trend that has just crossed
  // out of neutral routinely has bias=BULLISH/BEARISH (from the forward-looking horizon probabilities)
  // while the smoothed currentScore itself still sits inside the neutral band. Keying off currentScore
  // there silently substituted neutralProbability for the bull/bear probability that actually earned
  // the bias call, causing buildEntryDecision()'s persistence >= 0.55 check to reject valid signals.
  const persistenceProbability = bias === "BULLISH"
    ? anchor.bullProbability
    : bias === "BEARISH"
      ? anchor.bearProbability
      : anchor.neutralProbability;
  const invalidation = bias === "BULLISH"
    ? "Bias bull invalid jika EWMA menembus +0.12 ke bawah atau slope 1h dan 3h sama-sama negatif."
    : bias === "BEARISH"
      ? "Bias bear invalid jika EWMA menembus -0.12 ke atas atau slope 1h dan 3h sama-sama positif."
      : "Bias netral invalid setelah EWMA menembus ±0.12 dengan slope 1h dan 3h yang searah.";

  return {
    available: true,
    bias,
    confidence,
    smoothedScore: currentScore,
    consensusSlopePerHour: consensus.slope,
    slopeAgreement: consensus.agreement,
    persistenceProbability,
    horizons,
    invalidation,
    reason: `Forecast regime-axis memakai EWMA kausal, slope 1/3/6 jam, dan hingga ${maxAnalogCount} analog historis terdekat.`,
  };
}

function buildEntryDecision(
  current: ScoredPoint | null,
  forecast: RegimeAxisForecast,
  fallbackSlope: number | null,
): RegimeAxisEntryDecision {
  const noTrade = (reason: string): RegimeAxisEntryDecision => ({
    action: "NO_TRADE",
    directionalBias: null,
    reason,
    requiredSetup: "Tidak ada entry directional. Tunggu bias dan setup simbol menjadi jelas.",
    invalidation: forecast.invalidation,
  });
  if (!current || !forecast.available || forecast.bias === "UNCERTAIN" || forecast.bias === "NEUTRAL") {
    return noTrade("Forecast belum menunjukkan bias directional yang cukup jelas.");
  }
  const direction = forecast.bias === "BULLISH" ? "LONG" : "SHORT";
  const persistence = forecast.persistenceProbability ?? 0;
  if (forecast.confidence === "LOW" || persistence < 0.55) {
    return noTrade(`${direction} bias belum cukup reliabel (${Math.round(persistence * 100)}% persistence); jangan paksa entry.`);
  }

  const slope = forecast.consensusSlopePerHour ?? fallbackSlope ?? 0;
  const acceleratingWithBias = direction === "LONG" ? slope > 0.005 : slope < -0.005;
  const requiredSetup = direction === "LONG"
    ? "Tunggu pullback EMA20 dari atas lalu bullish rejection/close kembali di atas EMA20. Jangan chase candle hijau."
    : "Tunggu retest EMA20 dari bawah lalu bearish rejection/close kembali di bawah EMA20. Jangan chase candle merah.";
  return {
    action: acceleratingWithBias ? "WAIT_PULLBACK" : "WAIT_REJECTION",
    directionalBias: direction,
    reason: acceleratingWithBias
      ? `${direction} bias sedang menjauh dari netral; arah boleh benar tetapi entry sekarang berisiko mengejar harga.`
      : `${direction} bias masih ada, namun momentum tidak lagi mengakselerasi; tunggu rejection level sebelum entry.`,
    requiredSetup,
    invalidation: forecast.invalidation,
  };
}

/** Signed breadth composite in [-1, +1]; null when the snapshot carries no usable breadth. */
export function computeRegimeAxisScore(breadth: RegimeEngineSnapshot["breadth"]): number | null {
  const parts: number[] = [];
  if (typeof breadth.advancersPct === "number" && Number.isFinite(breadth.advancersPct)) {
    parts.push(clamp(breadth.advancersPct * 2 - 1, -1, 1));
  }
  if (typeof breadth.percentAboveEma20 === "number" && Number.isFinite(breadth.percentAboveEma20)) {
    parts.push(clamp(breadth.percentAboveEma20 * 2 - 1, -1, 1));
  }
  if (typeof breadth.btcReturn24h === "number" && Number.isFinite(breadth.btcReturn24h)) {
    parts.push(clamp(breadth.btcReturn24h / BTC_RETURN_FULL_SCALE, -1, 1));
  }
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function buildRegimeAxisTimeline(
  snapshots: readonly RegimeEngineSnapshot[],
  opts: { maxPoints?: number; slopeWindowHours?: number; nowMs?: number } = {},
): RegimeAxisTimeline {
  const maxPoints = opts.maxPoints ?? 200;
  const slopeWindowHours = opts.slopeWindowHours ?? 6;
  const nowMs = opts.nowMs ?? Date.now();

  const scored: ScoredPoint[] = [];
  for (const s of snapshots) {
    const score = computeRegimeAxisScore(s.breadth);
    if (score === null) continue;
    const atMs = Date.parse(s.at);
    if (!Number.isFinite(atMs)) continue;
    scored.push({ at: s.at, atMs, score, regime: s.regime });
  }
  scored.sort((a, b) => a.atMs - b.atMs);
  const smoothedScores = causalEwma(scored);

  // Downsample evenly, always keeping the newest point (the one the operator is asking about).
  let points: Array<RegimeAxisPoint & { atMs: number }> = scored;
  if (scored.length > maxPoints) {
    const step = (scored.length - 1) / (maxPoints - 1);
    points = Array.from({ length: maxPoints }, (_, i) => scored[Math.round(i * step)]!);
  }

  const current = scored.length > 0 ? scored[scored.length - 1]! : null;

  // Slope: least-squares fit over the recent window (hours → robust against uneven snapshot gaps).
  let slopePerHour: number | null = null;
  let etaToNeutralHours: number | null = null;
  if (current) {
    const windowStartMs = current.atMs - slopeWindowHours * 3_600_000;
    const win = scored.filter((p) => p.atMs >= windowStartMs);
    if (win.length >= 3) {
      const xs = win.map((p) => (p.atMs - win[0]!.atMs) / 3_600_000);
      const ys = win.map((p) => p.score);
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i += 1) {
        num += (xs[i]! - mx) * (ys[i]! - my);
        den += (xs[i]! - mx) ** 2;
      }
      if (den > 0) {
        slopePerHour = num / den;
        // Moving TOWARD zero = score and slope have opposite signs, with a meaningful pace.
        if (Math.abs(slopePerHour) >= 0.005 && current.score !== 0 && Math.sign(slopePerHour) === -Math.sign(current.score)) {
          etaToNeutralHours = Math.abs(current.score / slopePerHour);
        }
      }
    }
  }

  const byRegime = new Map<string, number[]>();
  for (const p of scored) {
    const arr = byRegime.get(p.regime) ?? [];
    arr.push(p.score);
    byRegime.set(p.regime, arr);
  }
  const perRegimeMedianScore: Record<string, number> = {};
  for (const [regime, scores] of byRegime) {
    const s = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    perRegimeMedianScore[regime] = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  // Predictive layer: unlike the former 12-hour straight-line extension, this combines causal
  // smoothing, multi-window momentum, and observed historical successors of similar states.
  const forecast = buildForecast(scored, smoothedScores);
  const projection = forecast.horizons.map((h) => ({ at: h.at, score: h.expectedScore }));
  const freshEntryDecision = buildEntryDecision(current, forecast, slopePerHour);
  // 2026-07-19 fix: fail SAFE, not open — a stuck regime-engine cycle (runRegimeEngineCycleGuarded
  // swallows its own failures) must never let an old directional read keep being served as if it
  // were current. See REGIME_AXIS_STALE_THRESHOLD_MS's doc comment for the threshold rationale.
  const staleByMs = current ? nowMs - current.atMs : null;
  const isStale = staleByMs !== null && staleByMs > REGIME_AXIS_STALE_THRESHOLD_MS;
  const entryDecision: RegimeAxisEntryDecision = isStale
    ? {
        action: "NO_TRADE",
        directionalBias: null,
        reason:
          `Regime-axis data STALE: latest snapshot is ${Math.round(staleByMs! / 60_000)}m old ` +
          `(threshold ${Math.round(REGIME_AXIS_STALE_THRESHOLD_MS / 60_000)}m) — the regime engine cycle ` +
          "appears stuck (no new snapshot appended). No directional entry authorized on stale data.",
        requiredSetup: "Tidak ada entry directional. Regime engine perlu jalan lagi sebelum entry directional bisa dievaluasi ulang.",
        invalidation: "Stale-data block clears automatically once a fresh regime-engine snapshot arrives within the threshold.",
      }
    : freshEntryDecision;

  // Lane guidance from LEVEL × SLOPE. The honest core: momentum lanes follow the LEVEL — a bear
  // score recovering toward neutral is still a bear regime, and the book's own measurements say
  // longs there lose. The switch happens at the ±0.12 neutral-boundary CROSS, not before.
  let guidance: RegimeAxisTimeline["guidance"] = null;
  if (current) {
    const sc = current.score;
    const m = forecast.consensusSlopePerHour ?? slopePerHour ?? 0;
    const dirLabel: "MENUJU_NETRAL" | "MENJAUH_NETRAL" | "FLAT" =
      Math.abs(m) < 0.005 ? "FLAT" : Math.sign(m) === -Math.sign(sc) && sc !== 0 ? "MENUJU_NETRAL" : "MENJAUH_NETRAL";
    const zone = REGIME_AXIS_ZONES.find((z) => sc >= z.from && sc <= z.to) ?? null;
    if (sc <= -0.12) {
      const switchAt = -0.12;
      const eta = dirLabel === "MENUJU_NETRAL" && m > 0 ? Math.abs((switchAt - sc) / m) : null;
      guidance = {
        zoneLabel: zone?.label ?? "BEAR",
        direction: dirLabel,
        holdLane: "CG_WIDE_FAST_SHORT",
        switchToLane: "CG_WIDE_FAST_LONG",
        switchAtScore: switchAt,
        etaToSwitchHours: eta !== null ? Math.round(eta * 10) / 10 : null,
        note:
          dirLabel === "MENUJU_NETRAL"
            ? "Masih zona bear: PEGANG FAST_SHORT selama skor < -0.12 — recovery di dalam zona bear BUKAN sinyal long (buku sendiri: long counter-regime rugi). Ganti ke FAST_LONG hanya SETELAH skor menembus -0.12 dan bertahan."
            : "Zona bear dan masih menjauh/flat dari netral: FAST_SHORT tetap lane-nya. Tidak ada titik switch selama arah belum berbalik.",
      };
    } else if (sc >= 0.12) {
      const switchAt = 0.12;
      const eta = dirLabel === "MENUJU_NETRAL" && m < 0 ? Math.abs((sc - switchAt) / m) : null;
      guidance = {
        zoneLabel: zone?.label ?? "BULL",
        direction: dirLabel,
        holdLane: "CG_WIDE_FAST_LONG",
        switchToLane: "CG_WIDE_FAST_SHORT",
        switchAtScore: switchAt,
        etaToSwitchHours: eta !== null ? Math.round(eta * 10) / 10 : null,
        note:
          dirLabel === "MENUJU_NETRAL"
            ? "Masih zona bull: PEGANG FAST_LONG selama skor > +0.12 — pelemahan di dalam zona bull bukan sinyal short. Ganti ke FAST_SHORT hanya SETELAH skor menembus +0.12 ke bawah dan bertahan."
            : "Zona bull dan masih menjauh/flat dari netral: FAST_LONG tetap lane-nya.",
      };
    } else {
      guidance = {
        zoneLabel: zone?.label ?? "NEUTRAL",
        direction: dirLabel,
        holdLane: "CROSS_SECTIONAL_MARKET_NEUTRAL",
        switchToLane: m > 0.005 ? "CG_WIDE_FAST_LONG" : m < -0.005 ? "CG_WIDE_FAST_SHORT" : null,
        switchAtScore: m > 0.005 ? 0.12 : m < -0.005 ? -0.12 : null,
        etaToSwitchHours: Math.abs(m) >= 0.005 ? Math.round((Math.abs(((m > 0 ? 0.12 : -0.12) - sc) / m)) * 10) / 10 : null,
        note:
          "Zona netral: directional edge belum terbukti di sini — cross-sectional yang bekerja. Lane directional baru relevan setelah skor menembus ±0.12 searah slope.",
      };
    }
  }

  return {
    points: points.map(({ at, score, regime }) => ({ at, score, regime })),
    smoothedPoints: points.map((point) => {
      const index = scored.findIndex((candidate) => candidate.atMs === point.atMs);
      return { at: point.at, score: index >= 0 ? smoothedScores[index]! : point.score };
    }),
    current: current ? { at: current.at, score: current.score, regime: current.regime } : null,
    slopePerHour,
    etaToNeutralHours,
    slopeWindowHours,
    zones: REGIME_AXIS_ZONES,
    perRegimeMedianScore,
    projection,
    forecast,
    guidance,
    entryDecision,
    note:
      "score = signed composite of the regime engine's own breadth inputs (advancers %, % above EMA20, BTC 24h return); " +
      "0 = neutral zone. Forecast predicts the regime-axis state, not asset price. Entry Decision is deliberately conservative: it never authorizes an order by itself; RC/RCS symbol setup remains required.",
  };
}

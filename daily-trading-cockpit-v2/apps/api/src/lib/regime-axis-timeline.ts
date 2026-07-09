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

export interface RegimeAxisPoint {
  at: string;
  score: number;
  regime: string;
}

export interface RegimeAxisZone {
  from: number;
  to: number;
  label: string;
  laneHint: string;
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
  /** Straight-line extrapolation of the recent slope for the next hours — EXPLICITLY labeled an
   *  extrapolation, never a forecast (2026-07-08 operator: "tambahin prediksi arah nya ke mana"). */
  projection: Array<{ at: string; score: number }>;
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
  note: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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

  const scored: Array<RegimeAxisPoint & { atMs: number }> = [];
  for (const s of snapshots) {
    const score = computeRegimeAxisScore(s.breadth);
    if (score === null) continue;
    const atMs = Date.parse(s.at);
    if (!Number.isFinite(atMs)) continue;
    scored.push({ at: s.at, atMs, score, regime: s.regime });
  }
  scored.sort((a, b) => a.atMs - b.atMs);

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

  // Projection: extrapolate the fitted slope over the next 12h (clamped to the axis range).
  const projection: Array<{ at: string; score: number }> = [];
  if (current && slopePerHour !== null) {
    for (let h = 1; h <= 12; h += 1) {
      projection.push({
        at: new Date(current.atMs + h * 3_600_000).toISOString(),
        score: clamp(current.score + slopePerHour * h, -1, 1),
      });
    }
  }

  // Lane guidance from LEVEL × SLOPE. The honest core: momentum lanes follow the LEVEL — a bear
  // score recovering toward neutral is still a bear regime, and the book's own measurements say
  // longs there lose. The switch happens at the ±0.12 neutral-boundary CROSS, not before.
  let guidance: RegimeAxisTimeline["guidance"] = null;
  if (current) {
    const sc = current.score;
    const m = slopePerHour ?? 0;
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
    current: current ? { at: current.at, score: current.score, regime: current.regime } : null,
    slopePerHour,
    etaToNeutralHours,
    slopeWindowHours,
    zones: REGIME_AXIS_ZONES,
    perRegimeMedianScore,
    projection,
    guidance,
    note:
      "score = signed composite of the regime engine's own breadth inputs (advancers %, % above EMA20, BTC 24h return); " +
      "0 = neutral zone. ETA is a straight-line extrapolation of the recent slope — 'at the current pace', not a forecast.",
  };
}

/**
 * SIMULATED Exit-Brain evidence tier (2026-07-26).
 *
 * Covers the five regression guarantees this feature rests on:
 *   (i)   walkVariantPath's default path is BYTE-IDENTICAL when collectRPath is off — this module is
 *         real-money-adjacent (VariantWalkResult drives lane maturity → STABLE_CANDIDATE → mainnet
 *         live eligibility), so the full result object is frozen against a pre-change expectation
 *         and the `rPath` key must not even exist.
 *   (ii)  the collected series provably uses the SAME R definition as the summary stats — folding it
 *         into a running peak/trough reproduces maxMfeR/minMaeR — including after thinning.
 *   (iii) the bounded store enforces its per-path thinning cap, its FIFO cap and its age prune.
 *   (iv)  MEASURED and SIMULATED aggregates never contaminate each other.
 *   (v)   a series from a REAL walk scores SANELY through the REAL counterfactual. (ii) alone is not
 *         enough: a fabricated series can reconcile with the summary stats perfectly and still be
 *         garbage as a path — which is exactly what happened. See that section's header.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VARIANT_R_PATH_MAX_POINTS,
  thinRPathPreservingExtremes,
  walkVariantPath,
  type KlineTuple,
  type VariantRPathPoint,
  type VariantWalkInput,
  type VariantWalkResult,
} from "../src/lib/current-guard-variant-matrix.js";
import {
  MAX_SIM_PATHS,
  MAX_TICKS_PER_SIM_PATH,
  SIM_PATH_RETENTION_MS,
  SimulatedPaperPathStore,
  resolvedTradesFromSimulatedPaperPaths,
  simulatedPaperPathDirFor,
} from "../src/lib/paper-simulated-path-store.js";
import {
  ExitBrainShadowStore,
  exitBrainTierOf,
  runExitBrainShadowCycle,
  type ExitBrainEvaluationRecord,
  type ExitBrainResolvedTrade,
} from "../src/lib/exit-brain-shadow.js";
import {
  DEFAULT_EXIT_BRAIN_PARAMS,
  evaluateExitBrainCounterfactual,
  type ExitBrainPathTick,
} from "../src/lib/exit-brain-policy.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-sim-tier-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CANDLE_MS = 300_000;
const SIGNAL_OPEN_MS = new Date("2026-05-20T00:00:00.000Z").getTime();

function candle(openMs: number, high: number, low: number, close: number): KlineTuple {
  return [openMs, "0", String(high), String(low), String(close), "0", openMs + CANDLE_MS];
}

// ── (i) frozen default-path shape ───────────────────────────────────────────
//
// These four expectations are the PRE-CHANGE result objects, written out in full (every key, every
// value). A toEqual against them fails if any field's value moves AND fails if any key is added —
// which is exactly the guarantee the real-money-adjacent contract needs.

interface FrozenCase {
  name: string;
  input: VariantWalkInput;
  expected: Record<string, unknown>;
}

const FROZEN_CASES: FrozenCase[] = [
  {
    name: "tp1_full LONG take-profit",
    input: {
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [candle(SIGNAL_OPEN_MS, 104.5, 100.5, 104)],
    },
    expected: {
      status: "CLOSED_WIN",
      grossR: 2,
      openedAtMs: SIGNAL_OPEN_MS,
      closedAtMs: SIGNAL_OPEN_MS + CANDLE_MS,
      maxMfeR: 2.25,
      minMaeR: 0,
      peakAtMs: SIGNAL_OPEN_MS,
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      isFreshValid: true,
      resolutionSource: "CANDLE_WALK_TP",
      productionBreakevenTriggerPrice: null,
      productionBreakevenModeledCloseQty: null,
    },
  },
  {
    name: "tp1_full LONG stop-loss",
    input: {
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [candle(SIGNAL_OPEN_MS, 100.5, 97.5, 98)],
    },
    expected: {
      status: "CLOSED_LOSS",
      grossR: -1,
      openedAtMs: SIGNAL_OPEN_MS,
      closedAtMs: SIGNAL_OPEN_MS + CANDLE_MS,
      maxMfeR: 0.25,
      minMaeR: -1.25,
      peakAtMs: SIGNAL_OPEN_MS,
      intrabarResolutionStatus: "VALID_5M_ORDERED",
      isFreshValid: true,
      resolutionSource: "CANDLE_WALK_SL",
      productionBreakevenTriggerPrice: null,
      productionBreakevenModeledCloseQty: null,
    },
  },
  {
    name: "maker post-only NO_FILL",
    input: {
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "maker_limit",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [candle(SIGNAL_OPEN_MS, 104.5, 100.5, 104)],
    },
    expected: {
      status: "NO_FILL",
      grossR: null,
      openedAtMs: null,
      closedAtMs: null,
      maxMfeR: null,
      minMaeR: null,
      peakAtMs: null,
      intrabarResolutionStatus: null,
      isFreshValid: null,
      resolutionSource: "MAKER_NO_FILL",
      productionBreakevenTriggerPrice: null,
      productionBreakevenModeledCloseQty: null,
    },
  },
  {
    name: "UNRESOLVED (neither stop nor target touched)",
    input: {
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [candle(SIGNAL_OPEN_MS, 101, 99.5, 100.2)],
    },
    expected: {
      status: "UNRESOLVED",
      grossR: null,
      openedAtMs: null,
      closedAtMs: null,
      maxMfeR: null,
      minMaeR: null,
      peakAtMs: null,
      intrabarResolutionStatus: null,
      isFreshValid: null,
      resolutionSource: null,
      productionBreakevenTriggerPrice: null,
      productionBreakevenModeledCloseQty: null,
    },
  },
];

describe("[i] walkVariantPath default path is untouched by the opt-in R-series", () => {
  for (const c of FROZEN_CASES) {
    it(`${c.name}: full result equals the pre-change expectation and carries NO rPath key`, async () => {
      const result = await walkVariantPath(c.input);
      // Full-object equality: catches a changed value AND a silently added field.
      expect(result).toEqual(c.expected);
      expect(Object.keys(result).sort()).toEqual(Object.keys(c.expected).sort());
      expect("rPath" in result).toBe(false);
      expect(result.rPath).toBeUndefined();
    });

    it(`${c.name}: enabling collectRPath adds ONLY rPath — every other field is identical`, async () => {
      const off = await walkVariantPath(c.input);
      const on = await walkVariantPath({ ...c.input, collectRPath: true });
      expect("rPath" in on).toBe(true);
      const { rPath: _dropped, ...onWithoutRPath } = on;
      expect(onWithoutRPath).toEqual(off);
    });
  }

  it("an explicit collectRPath:false behaves exactly like omitting it", async () => {
    const omitted = await walkVariantPath(FROZEN_CASES[0]!.input);
    const explicitFalse = await walkVariantPath({ ...FROZEN_CASES[0]!.input, collectRPath: false });
    expect(explicitFalse).toEqual(omitted);
    expect("rPath" in explicitFalse).toBe(false);
  });

  it("NO_FILL / UNRESOLVED return rPath null (never an array) — the series and the summary stats are valid-or-null together", async () => {
    for (const name of ["maker post-only NO_FILL", "UNRESOLVED (neither stop nor target touched)"]) {
      const c = FROZEN_CASES.find((f) => f.name === name)!;
      const on = await walkVariantPath({ ...c.input, collectRPath: true });
      expect(on.maxMfeR).toBeNull();
      expect(on.rPath).toBeNull();
    }
  });
});

// ── (ii) series ⇄ summary-stat consistency ──────────────────────────────────

/** Multi-candle path that never touches stop or target, closed by forceCloseAtEnd (MAX_HOLD_MTM):
 *  peak +1.5R on candle 1, trough −0.5R on candle 0. */
const CONSISTENCY_LONG: VariantWalkInput = {
  direction: "LONG",
  entryPrice: 100,
  stopLoss: 98, // risk 2
  target: 110, // far — never hit
  exitRule: "tp1_full",
  fillMode: "taker",
  openedAtMs: SIGNAL_OPEN_MS,
  candles: [
    candle(SIGNAL_OPEN_MS, 101, 99, 100.5),
    candle(SIGNAL_OPEN_MS + CANDLE_MS, 103, 100, 102),
    candle(SIGNAL_OPEN_MS + 2 * CANDLE_MS, 102, 101, 101.5),
  ],
  forceCloseAtEnd: true,
};

/** SHORT mirror of the same shape — proves the series follows the walk's own direction convention
 *  rather than a re-derived one. */
const CONSISTENCY_SHORT: VariantWalkInput = {
  direction: "SHORT",
  entryPrice: 100,
  stopLoss: 102, // risk 2
  target: 90, // far — never hit
  exitRule: "tp1_full",
  fillMode: "taker",
  openedAtMs: SIGNAL_OPEN_MS,
  candles: [
    candle(SIGNAL_OPEN_MS, 101, 99, 99.5),
    candle(SIGNAL_OPEN_MS + CANDLE_MS, 100, 97, 98),
    candle(SIGNAL_OPEN_MS + 2 * CANDLE_MS, 99, 98, 98.5),
  ],
  forceCloseAtEnd: true,
};

/** Folds a series into a running peak/trough EXACTLY the way evaluateExitBrainCounterfactual does
 *  (currentR plus the optional peakR/troughR refinements, both starting at 0). This — not
 *  max/min of currentR alone — is the quantity that has to reconcile with maxMfeR/minMaeR now that
 *  a point carries the candle's mark AND its extremes. */
function foldedExtremes(path: VariantRPathPoint[]): { peak: number; trough: number } {
  let peak = 0;
  let trough = 0;
  for (const p of path) {
    peak = Math.max(peak, p.currentR, Number.isFinite(p.peakR ?? Number.NaN) ? (p.peakR as number) : Number.NEGATIVE_INFINITY);
    trough = Math.min(trough, p.currentR, Number.isFinite(p.troughR ?? Number.NaN) ? (p.troughR as number) : Number.POSITIVE_INFINITY);
  }
  return { peak, trough };
}

describe("[ii] rPath uses the SAME R definition as maxMfeR / minMaeR", () => {
  for (const [label, input] of [
    ["LONG", CONSISTENCY_LONG],
    ["SHORT", CONSISTENCY_SHORT],
  ] as const) {
    it(`${label}: the folded series reproduces maxMfeR / minMaeR exactly`, async () => {
      const result = await walkVariantPath({ ...input, collectRPath: true });
      expect(result.status).toBe("CLOSED_WIN");
      expect(result.resolutionSource).toBe("MAX_HOLD_MTM");
      const path = result.rPath!;
      expect(path).not.toBeNull();
      // ONE point per walked candle — the last one being the terminating point at the real close.
      expect(path.length).toBe(input.candles.length);
      // MAX_HOLD_MTM is a CLOSE exit: the position was open for the whole final candle, so no
      // extreme is withheld and the fold is EXACT.
      const { peak, trough } = foldedExtremes(path);
      expect(peak).toBeCloseTo(result.maxMfeR!, 12);
      expect(trough).toBeCloseTo(result.minMaeR!, 12);
      expect(peak).toBeCloseTo(1.5, 12);
      expect(trough).toBeCloseTo(-0.5, 12);
      // And every point is BOUNDED by the summary stats — the series can never exceed the walk.
      for (const p of path) {
        expect(p.currentR).toBeLessThanOrEqual(result.maxMfeR! + 1e-12);
        expect(p.currentR).toBeGreaterThanOrEqual(result.minMaeR! - 1e-12);
      }
    });
  }

  it("is ONE mark-to-market point per candle: currentR is the CLOSE mark, extremes ride in peakR/troughR", async () => {
    const result = await walkVariantPath({ ...CONSISTENCY_LONG, collectRPath: true });
    const path = result.rPath!;
    // Strictly chronological, one point per candle, candle-OPEN stamped except the terminating
    // point which carries the trade's real closedAtMs.
    for (let i = 1; i < path.length; i += 1) expect(path[i]!.tsMs).toBeGreaterThan(path[i - 1]!.tsMs);
    expect(path[0]!.tsMs).toBe(SIGNAL_OPEN_MS);
    expect(path[1]!.tsMs).toBe(SIGNAL_OPEN_MS + CANDLE_MS);
    expect(path[path.length - 1]!.tsMs).toBe(result.closedAtMs);

    // CONSISTENCY_LONG: entry 100, risk 2. Candle 0 closes 100.5 (+0.25R) with high 101 (+0.5R) and
    // low 99 (−0.5R); candle 1 closes 102 (+1.0R) with high 103 (+1.5R). currentR is the CLOSE
    // mark — signed and unclamped — NOT an excursion statistic.
    expect(path[0]!.currentR).toBeCloseTo(0.25, 12);
    expect(path[0]!.peakR).toBeCloseTo(0.5, 12);
    expect(path[0]!.troughR).toBeCloseTo(-0.5, 12);
    expect(path[1]!.currentR).toBeCloseTo(1.0, 12);
    expect(path[1]!.peakR).toBeCloseTo(1.5, 12);
    // The terminating point IS the realized exit.
    expect(path[path.length - 1]!.currentR).toBeCloseTo(result.grossR!, 12);
  });

  it("a walk yields exactly one tick per candle, so ~6 candles clear the Exit Brain's evaluability floor", async () => {
    const three = await walkVariantPath({ ...CONSISTENCY_LONG, collectRPath: true });
    expect(three.rPath!.length).toBe(3); // one per candle — half the pre-fix density, and honest
    // The winner fixture below is 11 candles; density is what makes a path scoreable at all.
    const dense = await walkVariantPath(monotonicWinnerInput());
    expect(dense.rPath!.length).toBeGreaterThanOrEqual(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks);
  });

  it("THINNING preserves the fold: a tiny cap still reproduces maxMfeR / minMaeR", async () => {
    // 12 candles so the 4-point cap actually bites; the extremes live in peakR/troughR, which is
    // precisely what the thinner has to key on.
    const candles: KlineTuple[] = [];
    for (let i = 0; i < 12; i += 1) {
      const openMs = SIGNAL_OPEN_MS + i * CANDLE_MS;
      if (i === 3) candles.push(candle(openMs, 103, 99.9, 100)); // peak: mfeR 1.5
      else if (i === 8) candles.push(candle(openMs, 100.1, 98.5, 100)); // trough: maeR -0.75
      else candles.push(candle(openMs, 100.1, 99.9, 100));
    }
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 200,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      forceCloseAtEnd: true,
      collectRPath: true,
      rPathMaxPoints: 4,
    });
    const path = result.rPath!;
    expect(path.length).toBeLessThanOrEqual(4);
    const { peak, trough } = foldedExtremes(path);
    expect(peak).toBeCloseTo(result.maxMfeR!, 12);
    expect(trough).toBeCloseTo(result.minMaeR!, 12);
  });

  it("REPEATED in-flight thinning over a long walk still preserves the fold and the cap", async () => {
    // 200 candles: baseline noise, one deep trough at 120, one high peak at 180. With
    // rPathMaxPoints 8 the in-flight ceiling (4x) is crossed many times, so the thinner runs
    // repeatedly — the extremes must survive every pass.
    const candles: KlineTuple[] = [];
    for (let i = 0; i < 200; i += 1) {
      const openMs = SIGNAL_OPEN_MS + i * CANDLE_MS;
      if (i === 120) candles.push(candle(openMs, 100.1, 98.5, 99)); // trough: maeR -0.75
      else if (i === 180) candles.push(candle(openMs, 103, 99.9, 102)); // peak: mfeR 1.5
      else candles.push(candle(openMs, 100.1, 99.9, 100));
    }
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98, // never touched (lowest low is 98.5)
      target: 200, // never touched
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      forceCloseAtEnd: true,
      collectRPath: true,
      rPathMaxPoints: 8,
    });
    expect(result.maxMfeR).toBeCloseTo(1.5, 12);
    expect(result.minMaeR).toBeCloseTo(-0.75, 12);
    const path = result.rPath!;
    expect(path.length).toBeLessThanOrEqual(8);
    const { peak, trough } = foldedExtremes(path);
    expect(peak).toBeCloseTo(result.maxMfeR!, 12);
    expect(trough).toBeCloseTo(result.minMaeR!, 12);
    for (let i = 1; i < path.length; i += 1) expect(path[i]!.tsMs).toBeGreaterThanOrEqual(path[i - 1]!.tsMs);
  });

  it("defaults to the documented VARIANT_R_PATH_MAX_POINTS cap", async () => {
    const candles: KlineTuple[] = [];
    for (let i = 0; i < 800; i += 1) {
      candles.push(candle(SIGNAL_OPEN_MS + i * CANDLE_MS, 100.1, 99.9, 100));
    }
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 200,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      forceCloseAtEnd: true,
      collectRPath: true,
    });
    expect(result.rPath!.length).toBeLessThanOrEqual(VARIANT_R_PATH_MAX_POINTS);
  });
});

describe("thinRPathPreservingExtremes", () => {
  const series: VariantRPathPoint[] = Array.from({ length: 100 }, (_, i) => ({ tsMs: i, currentR: i === 77 ? 9 : i === 33 ? -9 : 0 }));

  it("keeps first, last, argmax and argmin, in chronological order, within the cap", () => {
    const thinned = thinRPathPreservingExtremes(series, 10);
    expect(thinned.length).toBeLessThanOrEqual(10);
    expect(thinned[0]).toEqual(series[0]);
    expect(thinned[thinned.length - 1]).toEqual(series[99]);
    expect(thinned.some((p) => p.currentR === 9)).toBe(true);
    expect(thinned.some((p) => p.currentR === -9)).toBe(true);
    for (let i = 1; i < thinned.length; i += 1) expect(thinned[i]!.tsMs).toBeGreaterThan(thinned[i - 1]!.tsMs);
  });

  it("is a no-op below the cap and never drops below its 4-point floor", () => {
    expect(thinRPathPreservingExtremes(series.slice(0, 5), 10)).toHaveLength(5);
    expect(thinRPathPreservingExtremes(series, 0).length).toBeLessThanOrEqual(4);
    expect(thinRPathPreservingExtremes(series, 0).some((p) => p.currentR === 9)).toBe(true);
  });

  it("keys on the FOLDED extremes, so a peak that lives in peakR/troughR still survives thinning", () => {
    // Flat close-marks; the whole excursion is in the refinements — the shape a one-point-per-candle
    // walk actually produces. Keying on currentR alone would silently drop both extremes here.
    const refined: VariantRPathPoint[] = Array.from({ length: 100 }, (_, i) => ({
      tsMs: i,
      currentR: 0,
      ...(i === 61 ? { peakR: 4 } : {}),
      ...(i === 12 ? { troughR: -4 } : {}),
    }));
    const thinned = thinRPathPreservingExtremes(refined, 6);
    expect(thinned.length).toBeLessThanOrEqual(6);
    expect(thinned.some((p) => p.peakR === 4)).toBe(true);
    expect(thinned.some((p) => p.troughR === -4)).toBe(true);
    expect(foldedExtremes(thinned)).toEqual(foldedExtremes(refined));
  });
});

// ── (iii) bounded store ─────────────────────────────────────────────────────

function simPath(n: number, overrides: Partial<Parameters<SimulatedPaperPathStore["recordResolvedPath"]>[0]> = {}) {
  const rPath: VariantRPathPoint[] = Array.from({ length: n }, (_, i) => ({
    tsMs: SIGNAL_OPEN_MS + i * CANDLE_MS,
    currentR: i === 1 ? -0.5 : i === n - 2 ? 1.5 : 0.1,
  }));
  return {
    key: `order-${Math.random().toString(36).slice(2, 10)}`,
    laneId: "CG_MFE_GIVEBACK",
    symbol: "ETHUSDT",
    direction: "LONG" as const,
    closedAtMs: SIGNAL_OPEN_MS + (n + 1) * CANDLE_MS,
    closeR: 0.75,
    rPath,
    ...overrides,
  };
}

describe("[iii] SimulatedPaperPathStore stays bounded", () => {
  it("thins each path to MAX_TICKS_PER_SIM_PATH (+ the terminal close point) and keeps the raw count honest", () => {
    const store = new SimulatedPaperPathStore(tmp());
    expect(store.recordResolvedPath(simPath(5000, { key: "big" }))).toBe(true);
    const path = store.getState().paths[0]!;
    expect(path.rawTickCount).toBe(5000);
    expect(path.ticks.length).toBeLessThanOrEqual(MAX_TICKS_PER_SIM_PATH + 1);
    // The thinner's extreme retention survives the store too.
    expect(Math.max(...path.ticks.map((t) => t.r))).toBeCloseTo(1.5, 6);
    expect(Math.min(...path.ticks.map((t) => t.r))).toBeCloseTo(-0.5, 6);
    // Terminal point at the actual close.
    expect(path.ticks[path.ticks.length - 1]!.t).toBe(path.closedAtMs);
  });

  it("caps retained paths at MAX_SIM_PATHS (FIFO, oldest evicted)", () => {
    const store = new SimulatedPaperPathStore(tmp());
    for (let i = 0; i < MAX_SIM_PATHS + 50; i += 1) {
      store.recordResolvedPath(simPath(6, { key: `k-${i}` }), { deferSave: true });
    }
    store.flush();
    expect(store.getState().paths.length).toBe(MAX_SIM_PATHS);
    expect(store.has("k-0")).toBe(false); // evicted
    expect(store.has(`k-${MAX_SIM_PATHS + 49}`)).toBe(true); // newest kept
  });

  it("age-prunes paths beyond the retention window", () => {
    const store = new SimulatedPaperPathStore(tmp());
    const now = Date.now();
    store.recordResolvedPath(simPath(6, { key: "old", closedAtMs: now - SIM_PATH_RETENTION_MS - 1 }));
    store.recordResolvedPath(simPath(6, { key: "fresh", closedAtMs: now - 1000 }));
    expect(store.pruneExpired(now).dropped).toBe(1);
    expect(store.has("old")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });

  it("is idempotent per key and refuses to fabricate a path it does not have", () => {
    const store = new SimulatedPaperPathStore(tmp());
    expect(store.recordResolvedPath(simPath(6, { key: "dup" }))).toBe(true);
    expect(store.recordResolvedPath(simPath(6, { key: "dup" }))).toBe(false);
    expect(store.recordResolvedPath(simPath(6, { key: "empty", rPath: [] }))).toBe(false);
    expect(store.recordResolvedPath(simPath(6, { key: "nullpath", rPath: null }))).toBe(false);
    expect(store.recordResolvedPath(simPath(6, { key: "nan", closeR: Number.NaN }))).toBe(false);
    expect(store.recordResolvedPath(simPath(6, { key: "", }))).toBe(false);
    expect(store.getState().paths.length).toBe(1);
  });

  it("writer and reader derive the SAME directory from the same paper store", () => {
    // Both call sites (paper-execution-router.ts + routes/shadow.ts) go through this one helper, so
    // a relocated paper store (e.g. data/realtime-short) can never split them across two files.
    expect(simulatedPaperPathDirFor("/srv/app/data/paper-execution-router.json")).toBe("/srv/app/data");
    expect(simulatedPaperPathDirFor("/srv/app/data/realtime-short/paper-execution-router.json")).toBe(
      "/srv/app/data/realtime-short",
    );
    expect(simulatedPaperPathDirFor("")).toBe("data"); // fail-safe default, never a throw
    expect(simulatedPaperPathDirFor(undefined as never)).toBe("data");
  });

  it("survives a reload and degrades to empty on a corrupt file", () => {
    const dir = tmp();
    const store = new SimulatedPaperPathStore(dir);
    store.recordResolvedPath(simPath(6, { key: "persist" }));
    expect(new SimulatedPaperPathStore(dir).has("persist")).toBe(true);
    writeFileSync(join(dir, "paper-simulated-paths.json"), "{not json", "utf-8");
    expect(new SimulatedPaperPathStore(dir).listPaths()).toHaveLength(0);
  });
});

describe("resolvedTradesFromSimulatedPaperPaths", () => {
  it("hardcodes tier SIMULATED on every row and namespaces the tradeId", () => {
    const store = new SimulatedPaperPathStore(tmp());
    store.recordResolvedPath(simPath(8, { key: "po-1" }));
    const rows = resolvedTradesFromSimulatedPaperPaths(store.listPaths());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("SIMULATED");
    expect(rows[0]!.tradeId).toBe("sim:po-1");
    expect(rows[0]!.laneId).toBe("CG_MFE_GIVEBACK");
    expect(rows[0]!.ticks.length).toBeGreaterThanOrEqual(6);
  });

  it("skips malformed rows rather than emitting a fabricated identity", () => {
    expect(resolvedTradesFromSimulatedPaperPaths([{ key: "x" } as never])).toHaveLength(0);
    expect(resolvedTradesFromSimulatedPaperPaths(null as never)).toHaveLength(0);
  });
});

// ── (iv) tier isolation ─────────────────────────────────────────────────────

function evalRecord(overrides: Partial<ExitBrainEvaluationRecord> = {}): ExitBrainEvaluationRecord {
  return {
    tradeId: `t-${Math.random().toString(36).slice(2, 10)}`,
    laneId: "LANE_M",
    symbol: "ETHUSDT",
    closedAtIso: "2026-07-26T10:00:00.000Z",
    status: "EVALUATED",
    tickCount: 8,
    actualExitR: 0.1,
    policyExitR: 0.5,
    deltaR: 0.4,
    bankedAt: "2026-07-26T08:00:00.000Z",
    bankReason: "R4_RETRACE_BANK: test",
    ...overrides,
  };
}

describe("[iv] MEASURED and SIMULATED aggregates never contaminate each other", () => {
  it("exitBrainTierOf treats an absent tier as MEASURED (legacy records ARE measured evidence)", () => {
    expect(exitBrainTierOf(undefined)).toBe("MEASURED");
    expect(exitBrainTierOf(null)).toBe("MEASURED");
    expect(exitBrainTierOf("MEASURED")).toBe("MEASURED");
    expect(exitBrainTierOf("SIMULATED")).toBe("SIMULATED");
  });

  it("each block counts only its own tier — and the legacy coverage/performance blocks stay MEASURED-only", () => {
    const store = new ExitBrainShadowStore(tmp());
    // MEASURED: one legacy (no tier), one explicit.
    store.recordEvaluation(evalRecord({ tradeId: "m-legacy", deltaR: 0.4, laneId: "LANE_M" }));
    store.recordEvaluation(evalRecord({ tradeId: "m-explicit", tier: "MEASURED", deltaR: -0.2, policyExitR: -0.1, laneId: "LANE_M" }));
    store.recordEvaluation(
      evalRecord({
        tradeId: "m-insufficient",
        status: "INSUFFICIENT_PATH_DATA",
        tickCount: 3,
        policyExitR: null,
        deltaR: null,
        bankedAt: null,
        bankReason: null,
      }),
    );
    // SIMULATED: deliberately larger numbers so any leak into the measured block is obvious.
    for (const [i, delta] of [5, 5, 5].entries()) {
      store.recordEvaluation(evalRecord({ tradeId: `s-${i}`, tier: "SIMULATED", deltaR: delta, laneId: "LANE_S", tickCount: 11 }));
    }
    store.recordEvaluation(
      evalRecord({
        tradeId: "s-insufficient",
        tier: "SIMULATED",
        status: "INSUFFICIENT_PATH_DATA",
        tickCount: 2,
        policyExitR: null,
        deltaR: null,
        bankedAt: null,
        bankReason: null,
      }),
    );

    const report = store.buildReport();

    // MEASURED block.
    expect(report.measured.tier).toBe("MEASURED");
    expect(report.measured.n).toBe(2);
    expect(report.measured.cumDeltaR).toBeCloseTo(0.2, 12);
    expect(report.measured.meanDeltaR).toBeCloseTo(0.1, 12);
    expect(report.measured.policyBetter).toBe(1);
    expect(report.measured.policyWorse).toBe(1);
    expect(report.measured.ties).toBe(0);
    expect(report.measured.banked).toBe(2);
    expect(report.measured.processed).toBe(3);
    expect(report.measured.insufficientPathData).toBe(1);
    expect(report.measured.tickHistogram["8"]).toBe(2);
    expect(report.measured.tickHistogram["11"]).toBeUndefined(); // simulated density never leaks in

    // SIMULATED block.
    expect(report.simulated.tier).toBe("SIMULATED");
    expect(report.simulated.n).toBe(3);
    expect(report.simulated.cumDeltaR).toBeCloseTo(15, 12);
    expect(report.simulated.policyBetter).toBe(3);
    expect(report.simulated.processed).toBe(4);
    expect(report.simulated.insufficientPathData).toBe(1);
    expect(report.simulated.tickHistogram["11"]).toBe(3);
    expect(report.simulated.tickHistogram["8"]).toBeUndefined();
    expect(report.simulated.note).toContain("SIMULATED");

    // The pre-existing (legacy) blocks are MEASURED-only and byte-identical to the measured block.
    expect(report.performance.n).toBe(report.measured.n);
    expect(report.performance.cumDeltaR).toBeCloseTo(report.measured.cumDeltaR, 12);
    expect(report.coverage.processed).toBe(report.measured.processed);
    expect(report.coverage.evaluated).toBe(report.measured.evaluated);
    expect(report.coverage.insufficientPathData).toBe(report.measured.insufficientPathData);
    expect(report.coverage.tickHistogram).toEqual(report.measured.tickHistogram);

    // perLane is MEASURED-only by contract.
    expect(report.perLane.map((l) => l.laneId)).toEqual(["LANE_M"]);
    expect(report.perLane[0]!.n).toBe(2);
  });

  it("persists the split across a reload, and a pre-split file loads with a zeroed SIMULATED block", () => {
    const dir = tmp();
    const store = new ExitBrainShadowStore(dir);
    store.recordEvaluation(evalRecord({ tradeId: "m1", deltaR: 0.4 }));
    store.recordEvaluation(evalRecord({ tradeId: "s1", tier: "SIMULATED", deltaR: 5 }));
    const reloaded = new ExitBrainShadowStore(dir).buildReport();
    expect(reloaded.measured.n).toBe(1);
    expect(reloaded.measured.cumDeltaR).toBeCloseTo(0.4, 12);
    expect(reloaded.simulated.n).toBe(1);
    expect(reloaded.simulated.cumDeltaR).toBeCloseTo(5, 12);

    // A file written before the tier split has no `simulated` key at all.
    const legacyDir = tmp();
    writeFileSync(
      join(legacyDir, "exit-brain-shadow.json"),
      JSON.stringify({
        version: 1,
        records: [],
        evaluated: { n: 7, cumDeltaR: 1.4, cumActualExitR: 0.7, cumPolicyExitR: 2.1, policyBetter: 5, policyWorse: 1, ties: 1, banked: 3 },
        insufficient: { n: 2 },
        tickHistogram: { "8": 7, "3": 2 },
        perLane: { LANE_M: { n: 7, cumDeltaR: 1.4, policyBetter: 5 } },
        processedTradeIds: [],
        cycleMeta: { lastRunAtIso: null, lastProcessed: 0, lastError: null },
      }),
      "utf-8",
    );
    const legacy = new ExitBrainShadowStore(legacyDir).buildReport();
    // Existing MEASURED numbers are untouched by the migration.
    expect(legacy.measured.n).toBe(7);
    expect(legacy.measured.cumDeltaR).toBeCloseTo(1.4, 12);
    expect(legacy.performance.n).toBe(7);
    expect(legacy.coverage.processed).toBe(9);
    // And the new tier starts empty rather than absorbing them.
    expect(legacy.simulated.n).toBe(0);
    expect(legacy.simulated.processed).toBe(0);
    expect(legacy.simulated.cumDeltaR).toBe(0);
  });

  it("the CYCLE keeps the tiers apart end to end (identical paths, two tiers, no double counting)", async () => {
    const store = new ExitBrainShadowStore(tmp());
    // Rises to +1.0R then fades to +0.3R (policy banks) before a real −1R exit.
    const ticks: ExitBrainPathTick[] = [0, 0.2, 0.5, 1.0, 0.8, 0.6, 0.3, -1.0].map((currentR, i) => ({
      tsMs: SIGNAL_OPEN_MS + i * CANDLE_MS,
      currentR,
    }));
    const base = {
      laneId: "LANE_X",
      symbol: "ETHUSDT",
      direction: "LONG" as const,
      closedAtIso: new Date(SIGNAL_OPEN_MS + 7 * CANDLE_MS).toISOString(),
      actualExitR: -1,
      ticks,
    };
    const trades: ExitBrainResolvedTrade[] = [
      { tradeId: "pp:real-1", ...base },
      { tradeId: "sim:paper-1", ...base, tier: "SIMULATED" },
    ];
    const res = await runExitBrainShadowCycle({ store, readResolvedTrades: () => trades, now: Date.now() });
    expect(res.ok).toBe(true);
    expect(res.processed).toBe(2);

    const report = store.buildReport();
    expect(report.measured.n).toBe(1);
    expect(report.simulated.n).toBe(1);
    // Identical inputs ⇒ identical per-tier delta. A leak would show up as 2x here (or n=2).
    expect(report.measured.cumDeltaR).toBeCloseTo(1.3, 6);
    expect(report.simulated.cumDeltaR).toBeCloseTo(1.3, 6);
    expect(report.performance.cumDeltaR).toBeCloseTo(1.3, 6);
    expect(report.perLane).toHaveLength(1);
    expect(report.perLane[0]!.n).toBe(1); // only the measured row
    expect(report.recent.map((r) => r.tier)).toEqual(["MEASURED", "SIMULATED"]);
  });

  it("a simulated paper walk flows store → reader → cycle into the SIMULATED block only", async () => {
    const walk = await walkVariantPath(monotonicWinnerInput());
    const pathStore = new SimulatedPaperPathStore(tmp());
    expect(
      pathStore.recordResolvedPath({
        key: "paper-e2e",
        laneId: "CG_MFE_GIVEBACK",
        symbol: "ETHUSDT",
        direction: "LONG",
        closedAtMs: walk.closedAtMs!,
        closeR: walk.grossR!,
        rPath: walk.rPath,
      }),
    ).toBe(true);

    const shadow = new ExitBrainShadowStore(tmp());
    const res = await runExitBrainShadowCycle({
      store: shadow,
      readResolvedTrades: () => resolvedTradesFromSimulatedPaperPaths(pathStore.listPaths()),
      now: Date.now(),
    });
    expect(res.ok).toBe(true);
    expect(res.processed).toBe(1);

    const report = shadow.buildReport();
    expect(report.simulated.processed).toBe(1);
    expect(report.measured.processed).toBe(0);
    expect(report.performance.n).toBe(0); // the legacy measured block never sees a simulated row
    expect(report.coverage.processed).toBe(0);
    expect(report.recent[0]!.tier).toBe("SIMULATED");
  });
});

// ── (v) REAL walk → REAL counterfactual ─────────────────────────────────────
//
// THE GAP THIS CLOSES (2026-07-26 review): nothing above ever asked what
// evaluateExitBrainCounterfactual makes of a series produced by an ACTUAL walkVariantPath run. [ii]
// only reconciled the series against the walk's own summary stats (a fabricated series reconciles
// with them perfectly), and [iv]'s end-to-end case only asserted which tier BLOCK a row landed in,
// never a value. Both cases below run a real walk, feed its real rPath to the real evaluator, and
// assert the resulting policyExitR/deltaR is SANE.
//
// These two tests are the regression guard for the two defects the original recording had:
//   #1 the series was not an unrealized-R path at all — it emitted two points per candle, both
//      CLAMPED AT ZERO relative to entry (max(high−E,0) and min(low−E,0)), so every candle forever
//      produced one point ≤ 0. Once the policy armed, the very next candle's clamped-at-zero adverse
//      point tripped R3_ROUND_TRIP_GUARD, banking a clean +5R runner at ~0 (deltaR −5).
//   #2 on the candle where the stop filled, the FAVORABLE extreme was recorded AFTER the adverse
//      one — i.e. after the position was already closed. That phantom post-exit point let a real
//      −1R loser book a POSITIVE deltaR in the policy's own favour.

/** LONG, entry 100, stop 98 (risk 2), target 200 (never reached). 11 candles climbing +0.5R each,
 *  no retrace, closed by forceCloseAtEnd at +5R (MAX_HOLD_MTM). The textbook winner a sane exit
 *  policy must simply ride. */
function monotonicWinnerInput(): VariantWalkInput {
  const candles: KlineTuple[] = [];
  for (let i = 0; i < 11; i += 1) {
    const close = 100 + i; // markR = i/2 → 0R … +5R
    candles.push(candle(SIGNAL_OPEN_MS + i * CANDLE_MS, close + 0.1, close - 0.1, close));
  }
  return {
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98,
    target: 200,
    exitRule: "tp1_full",
    fillMode: "taker",
    openedAtMs: SIGNAL_OPEN_MS,
    candles,
    forceCloseAtEnd: true,
    collectRPath: true,
  };
}

/** LONG, entry 100, stop 98 (risk 2), target 110. Sits at +0.5R (peak +0.6R — armed, never close to
 *  the retrace threshold) for six candles, then candle 6 collapses through the stop to 97.5 AND
 *  rebounds to 103 within that same candle. That 103 print is UNREACHABLE — the position was already
 *  stopped out — and is exactly the phantom defect #2 describes. */
function stopOutLoserInput(): VariantWalkInput {
  const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 100.2, 99.8, 100)];
  for (let i = 1; i <= 5; i += 1) candles.push(candle(SIGNAL_OPEN_MS + i * CANDLE_MS, 101.2, 100, 101));
  candles.push(candle(SIGNAL_OPEN_MS + 6 * CANDLE_MS, 103, 97.5, 100.5));
  return {
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98,
    target: 110,
    exitRule: "tp1_full",
    fillMode: "taker",
    openedAtMs: SIGNAL_OPEN_MS,
    candles,
    collectRPath: true,
  };
}

describe("[v] a REAL walk's series scores sanely through the REAL counterfactual", () => {
  it("a clean +5R monotonic winner is RIDDEN, not banked at ~0 by the round-trip guard", async () => {
    const walk = await walkVariantPath(monotonicWinnerInput());
    expect(walk.status).toBe("CLOSED_WIN");
    expect(walk.grossR).toBeCloseTo(5, 12);

    const path = walk.rPath!;
    expect(path.length).toBeGreaterThanOrEqual(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks);
    // A monotonic winner's recorded series must itself be monotonic. The pre-fix recording
    // interleaved a clamped-at-zero adverse point after every favorable one, so this alone fails.
    for (let i = 1; i < path.length; i += 1) {
      expect(path[i]!.currentR).toBeGreaterThanOrEqual(path[i - 1]!.currentR);
    }
    // Not one point of a trade that never traded below its entry may be negative-or-zero after the
    // first — the 48%-exactly-0.0 signature of the fabricated series.
    expect(path.filter((p) => p.currentR === 0).length).toBeLessThanOrEqual(1);

    const cf = evaluateExitBrainCounterfactual(path, { exitR: walk.grossR!, exitAtIso: new Date(walk.closedAtMs!).toISOString() });
    expect(cf.status).toBe("EVALUATED");
    // The policy has no reason to bank: the trade never gave anything back.
    expect(cf.bankedAt).toBeNull();
    expect(cf.policyExitR).toBeCloseTo(5, 6);
    expect(cf.deltaR).toBeCloseTo(0, 6);
    // Guard the specific defect: a +5R runner scored at ~0R.
    expect(cf.policyExitR!).toBeGreaterThan(4);
  });

  it("a stop-out loser can never book a POSITIVE deltaR off a post-exit print", async () => {
    const input = stopOutLoserInput();
    const walk = await walkVariantPath(input);
    expect(walk.status).toBe("CLOSED_LOSS");
    expect(walk.grossR).toBeCloseTo(-1, 12);
    // The SUMMARY stats deliberately still see the whole candle (real-money-critical fields are
    // untouched by this feature) — the exclusion below applies to the SERIES only.
    expect(walk.maxMfeR).toBeCloseTo(1.5, 12);
    expect(walk.minMaeR).toBeCloseTo(-1.25, 12);

    const path = walk.rPath!;
    expect(path.length).toBeGreaterThanOrEqual(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks);
    // #2: NOTHING in the series may postdate the close, and the exit candle's post-fill rebound to
    // 103 (+1.5R) must not appear anywhere in it — the honest reachable peak is the +0.6R the trade
    // actually printed while it was open.
    for (const p of path) expect(p.tsMs).toBeLessThanOrEqual(walk.closedAtMs!);
    expect(foldedExtremes(path).peak).toBeCloseTo(0.6, 6);
    // The withheld information is exactly the post-exit print — the fold is STRICTLY below maxMfeR,
    // and that gap is deliberate, not a disagreement between the series and the stats.
    expect(foldedExtremes(path).peak).toBeLessThan(walk.maxMfeR!);
    // The adverse extreme IS still carried (SL-first), so the trough still reconciles exactly.
    expect(foldedExtremes(path).trough).toBeCloseTo(walk.minMaeR!, 12);
    const last = path[path.length - 1]!;
    expect(last.tsMs).toBe(walk.closedAtMs);
    expect(last.currentR).toBeCloseTo(-1, 12);
    expect(last.peakR ?? null).toBeNull();

    const cf = evaluateExitBrainCounterfactual(path, { exitR: walk.grossR!, exitAtIso: new Date(walk.closedAtMs!).toISOString() });
    expect(cf.status).toBe("EVALUATED");
    // The core claim: the policy had no honest opportunity to escape this loser, so it inherits it.
    expect(cf.deltaR!).toBeLessThanOrEqual(0);
    expect(cf.deltaR).toBeCloseTo(0, 6);
    expect(cf.policyExitR).toBeCloseTo(-1, 6);
  });

  it("the same two verdicts survive the full store → reader → cycle round trip", async () => {
    const winner = await walkVariantPath(monotonicWinnerInput());
    const loser = await walkVariantPath(stopOutLoserInput());

    const pathStore = new SimulatedPaperPathStore(tmp());
    expect(
      pathStore.recordResolvedPath({
        key: "winner",
        laneId: "LANE_W",
        symbol: "ETHUSDT",
        direction: "LONG",
        closedAtMs: winner.closedAtMs!,
        closeR: winner.grossR!,
        rPath: winner.rPath,
      }),
    ).toBe(true);
    expect(
      pathStore.recordResolvedPath({
        key: "loser",
        laneId: "LANE_L",
        symbol: "ETHUSDT",
        direction: "LONG",
        closedAtMs: loser.closedAtMs!,
        closeR: loser.grossR!,
        rPath: loser.rPath,
      }),
    ).toBe(true);

    const rows = resolvedTradesFromSimulatedPaperPaths(pathStore.listPaths());
    expect(rows).toHaveLength(2);
    // The store must carry the per-candle extremes through to the evaluator — they are how MFE/MAE
    // information survives at one tick per candle.
    const winnerRow = rows.find((r) => r.tradeId === "sim:winner")!;
    expect(winnerRow.ticks.some((t) => Number.isFinite(t.peakR ?? Number.NaN))).toBe(true);

    const shadow = new ExitBrainShadowStore(tmp());
    const res = await runExitBrainShadowCycle({ store: shadow, readResolvedTrades: () => rows, now: Date.now() });
    expect(res.ok).toBe(true);
    expect(res.processed).toBe(2);

    const report = shadow.buildReport();
    expect(report.simulated.n).toBe(2);
    expect(report.simulated.insufficientPathData).toBe(0);
    // Neither trade may hand the policy a fabricated edge: the winner is ridden (0), the loser is
    // inherited (0). A single fabricated round-trip bank would show up here immediately.
    expect(report.simulated.cumDeltaR).toBeCloseTo(0, 6);
    expect(report.simulated.banked).toBe(0);
    expect(report.measured.n).toBe(0);
  });
});

// Guard against the walk's sibling helper silently opting in.
describe("no existing caller opts in by accident", () => {
  it("walkPyramidOnConfirmedWinner's legs carry no rPath", async () => {
    const { walkPyramidOnConfirmedWinner } = await import("../src/lib/current-guard-variant-matrix.js");
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [candle(SIGNAL_OPEN_MS, 104.5, 100.5, 104)],
    });
    const leg1: VariantWalkResult = result.leg1;
    expect("rPath" in leg1).toBe(false);
  });
});

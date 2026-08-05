import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

import type { ShadowPosition } from "@dtc/shared";

import {
  VARIANT_MATRIX_DEFINITIONS,
  BASELINE_VARIANT_ID,
  BULL_TREND_VARIANT_ID,
  CurrentGuardVariantMatrixStore,
  getCurrentGuardVariantMatrixStore,
  _resetCurrentGuardVariantMatrixStoreForTests,
  deriveVariantGeometry,
  deriveVariantStatus,
  walkVariantPath,
  walkPyramidOnConfirmedWinner,
  buildVariantMatrixObservationsForSignal,
  mirrorVariantMatrixSignals,
  selectVariantMatrixSignals,
  resolveVariantMatrixObservations,
  buildCurrentGuardVariantMatrixReport,
  exactLaneContextFor,
  exactLaneContextForObservation,
  laneStatusForContext,
  TAKER_ROUNDTRIP_BPS,
  MAKER_ROUNDTRIP_BPS,
  STRESS_EXTRA_BPS,
  WIDE_STOP_MIN_BPS,
  WATCHABLE_MIN_FRESH,
  STABLE_MIN_FRESH,
  PROMOTION_MIN_FRESH,
  STABLE_MIN_DISTINCT_SYMBOLS,
  PROMOTION_MIN_DISTINCT_SYMBOLS,
  // Point 4 — the eight stage floors that replaced the single-cut HOLDOUT_* machinery. Raw-row
  // floors and independent-episode floors are DELIBERATELY separate constants on ~1000:1 different
  // scales (~320 rows/day accrue against a hard ceiling of <=0.333 episodes/day at a 72h max hold),
  // so nothing below may ever compare a row count against an episode floor or vice versa.
  STABLE_MIN_DEV_ROWS,
  STABLE_MIN_EFFECTIVE_N,
  STABLE_MIN_HOLDOUT_ROWS,
  STABLE_MIN_HOLDOUT_EFFECTIVE_N,
  PROMOTION_MIN_DEV_ROWS,
  PROMOTION_MIN_EFFECTIVE_N,
  PROMOTION_MIN_HOLDOUT_ROWS,
  PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
  STAGE_SETTLEMENT_MS,
  NET_STRONG_R,
  PF_FLOOR,
  emptyVariantMatrixStageProof,
  stageSlicesForCut,
  PRODUCTION_BREAKEVEN_CONTROL_COST_PCT,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
  type VariantMatrixStageProof,
  type VariantMatrixStageCut,
  type VariantMatrixProofStage,
  type CurrentGuardVariantMatrixObservation,
  type KlineTuple,
} from "../src/lib/current-guard-variant-matrix.js";
import { buildShadowLaneScoreboard } from "../src/lib/shadow-lane-scoreboard.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

let tmpCounter = 0;
const dirs: string[] = [];

function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `current-guard-variant-matrix-${process.pid}-${++tmpCounter}`);
  dirs.push(dir);
  return dir;
}

function defOf(id: VariantMatrixVariantDefinition["id"]): VariantMatrixVariantDefinition {
  const def = VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`missing variant def ${id}`);
  return def;
}

function makeSignal(overrides: Partial<VariantMatrixSignal> = {}): VariantMatrixSignal {
  return {
    sourceSignalId: "sig-1",
    symbol: "ETHUSDT",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98,
    tp1: 104,
    tp2: null,
    tp3: null,
    stopDistanceBps: 200,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    openedAt: "2026-05-20T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function addResolvedContextCohort(
  store: CurrentGuardVariantMatrixStore,
  options: {
    variantId: VariantMatrixVariantDefinition["id"];
    direction: "LONG" | "SHORT";
    regime: string;
    count: number;
    netR: (index: number) => number;
    prefix: string;
    /** Point 3b axis-stamp control. Defaults to a genuine fresh-feed stamp (posture + regimeDirection
     *  set, matching the trade direction) so this cohort represents real exact-axis proof — the shape
     *  every pre-existing "exact context proof" fixture in this suite is meant to model. Pass
     *  `legacy: true` to build UN-stamped, legacy-shaped rows (posture/regimeDirection left null, the
     *  shape selectVariantMatrixSignals actually produces) for adversarial tests proving legacy data
     *  alone can never reach STABLE/PROMOTION context status, however large or profitable. */
    legacy?: boolean;
    /** Days between consecutive observations' resolvedAt (default 1). Widening this spreads a fixed
     *  `count` across MORE distinct effectiveN time-blocks per symbol; narrowing it (e.g. a fraction
     *  of a day, via a custom openedAt/resolvedAt spacing) clusters rows into FEWER blocks. Exposed so
     *  effectiveN tests can build genuinely-clustered vs genuinely-spread cohorts of the same size. */
    spacingDays?: number;
    /** Per-index regime string override (falls back to the constant `regime` when absent). Lets a
     *  test build a chronologically-drifting-label OR a genuinely-flipping-family cohort so
     *  distinctRegimes (episode) computation can be exercised end to end. */
    regimeFor?: (index: number) => string;
    /** Point 3a override. Defaults to `true` (genuinely fresh) like every pre-existing fixture in
     *  this suite. Pass `null` to build ambiguous-freshness rows (ends up isFreshValid:null on the
     *  observation) for adversarial tests proving ambiguous freshness never counts as proof. */
    isFreshValid?: boolean | null;
    /** Point 4: override the base openedAt/resolvedAt epoch-ms this cohort's timestamps are built
     *  from (default Date.UTC(2026,5,1)/Date.UTC(2026,6,1), same as every pre-existing fixture).
     *  Lets a test insert a SECOND, chronologically-earlier-or-later cohort into the SAME store —
     *  e.g. a "backfilled" batch dated well before an already-frozen holdout cut — without
     *  colliding with a first cohort's timestamps. */
    baseOpenedAtMs?: number;
    baseResolvedAtMs?: number;
    /** Point 3c: per-index symbol override. Defaults to the existing `CTX${index % 5}USDT` rotation
     *  (unchanged) so every pre-existing fixture keeps its symbol shape. Lets a test build cohorts
     *  with genuinely many distinct symbols (diversity/adversarial episode tests) or genuinely few
     *  (diversity-gate-fail tests). */
    symbolFor?: (index: number) => string;
    /** Point 3c: per-index shared-origin scan/episode identity. Defaults to `undefined` (no batch id
     *  → computeEffectiveN groups on the openedAt episode chain alone). Lets a test prove the
     *  batch-id MERGE relation directly, independent of time spacing. */
    scanBatchIdFor?: (index: number) => string | null;
    /** Point 4c: per-index ABSOLUTE openedAt epoch-ms, replacing the default linear
     *  `baseOpenedAtMs + index * spacingMs`. `spacingDays` can only express UNIFORM spacing and drags
     *  resolvedAt along with it, so it cannot build the shapes the episode-independence rule exists
     *  to distinguish: N scans bunched inside ONE max-hold window, N scans deliberately spaced just
     *  outside one, or a burst followed by a gap. Left unset, every pre-existing fixture keeps its
     *  exact timestamps. */
    openedAtMsFor?: (index: number) => number;
    /** Point 4c: per-index ABSOLUTE resolvedAt epoch-ms, replacing the default linear
     *  `baseResolvedAtMs + index * spacingMs`. Deliberately independent of `openedAtMsFor` so a test
     *  can drive origin time and resolve time APART and prove neither computeEffectiveN NOR stage
     *  membership ever consults resolvedAt.
     *
     *  Point 4 (stage model) CORRECTION to this comment's predecessor: resolvedAt no longer decides
     *  dev/holdout membership. There is exactly ONE proof clock now — `openedAt` — and it governs
     *  BOTH independence and stage membership, so a row can never be development for economics and
     *  holdout for counting. resolvedAt is retained on the observation as an outcome timestamp and
     *  is deliberately unreachable from the proof path. */
    resolvedAtMsFor?: (index: number) => number;
    /** Point 4: per-index persisted market-episode identity. Defaults to `undefined` (the shape
     *  every producer in the repo emits today — nothing writes this field yet), so the default path
     *  must behave byte-identically to pure openedAt chaining. When present it is a MERGE relation
     *  only: it may collapse rows the chain had separated, and may never split one window into more
     *  draws. */
    marketEpisodeIdFor?: (index: number) => string | null;
    /** Per-index stop distance in bps, or null for "uncomputable stress economics". Defaults to the
     *  signal's own 200bps. A null/zero stop distance makes `stressNetR` uncomputable for that row,
     *  which is what `holdout.stressableRows` exists to count. */
    stopDistanceBpsFor?: (index: number) => number | null;
  },
): void {
  const spacingMs = (options.spacingDays ?? 1) * 24 * 60 * 60 * 1000;
  const baseOpenedAtMs = options.baseOpenedAtMs ?? Date.UTC(2026, 5, 1);
  const baseResolvedAtMs = options.baseResolvedAtMs ?? Date.UTC(2026, 6, 1);
  const openedAtMsAt = (index: number): number =>
    options.openedAtMsFor ? options.openedAtMsFor(index) : baseOpenedAtMs + index * spacingMs;
  const resolvedAtMsAt = (index: number): number =>
    options.resolvedAtMsFor ? options.resolvedAtMsFor(index) : baseResolvedAtMs + index * spacingMs;
  const observations = Array.from({ length: options.count }, (_, index) => {
    const base = buildVariantMatrixObservationsForSignal(makeSignal({
      sourceSignalId: `${options.prefix}-${index}`,
      symbol: options.symbolFor ? options.symbolFor(index) : `CTX${index % 5}USDT`,
      direction: options.direction,
      regime: options.regimeFor ? options.regimeFor(index) : options.regime,
      openedAt: new Date(openedAtMsAt(index)).toISOString(),
      scanBatchId: options.scanBatchIdFor ? options.scanBatchIdFor(index) : undefined,
      marketEpisodeId: options.marketEpisodeIdFor ? options.marketEpisodeIdFor(index) : undefined,
      ...(options.legacy
        ? {}
        : { posture: "TACTICAL" as const, regimeDirection: options.direction }),
    })).find((candidate) => candidate.variantId === options.variantId)!;
    const netR = options.netR(index);
    return {
      ...base,
      observationId: `${options.prefix}-${index}`,
      sourceObservationKey: `${options.prefix}-${index}`,
      status: netR > 0 ? "CLOSED_WIN" as const : "CLOSED_LOSS" as const,
      grossR: netR + 0.12,
      netR,
      costR: 0.12,
      isFreshValid: options.isFreshValid === undefined ? true : options.isFreshValid,
      resolvedAt: new Date(resolvedAtMsAt(index)).toISOString(),
      ...(options.stopDistanceBpsFor ? { stopDistanceBps: options.stopDistanceBpsFor(index) } : {}),
    };
  });
  store.addMany(observations);
}

/**
 * Point 4 — a canonical PASSING stage proof for the hand-built `deriveVariantStatus` fixtures.
 *
 * `deriveVariantStatus` is exported and takes a plain struct, and ~10 fixtures in this file build
 * one by hand. Both stage proofs are REQUIRED members of that struct, so without a shared builder
 * every fixture would hand-roll one — and a fixture that accidentally hand-rolls a passing proof is
 * precisely the silent self-authorisation the gate exists to prevent. Starting from
 * `emptyVariantMatrixStageProof` (all-zero / all-null / all-false) and overriding only what a test
 * varies keeps every such fixture honest about what it is claiming.
 *
 * The default here is a proof that genuinely PASSES its stage, sized exactly at that stage's floors
 * with nothing to spare, so a negative case that lowers one field by one is attributable to that
 * field alone.
 */
function makeStageProof(
  stage: VariantMatrixProofStage,
  overrides: {
    ok?: boolean;
    frozen?: boolean;
    devEndMs?: number | null;
    holdoutEndMs?: number | null;
    dev?: Partial<VariantMatrixStageProof["dev"]>;
    holdout?: Partial<VariantMatrixStageProof["holdout"]>;
    blockers?: string[];
  } = {},
): VariantMatrixStageProof {
  const base = emptyVariantMatrixStageProof(stage);
  const isStable = stage === "stable";
  const minDevRows = isStable ? STABLE_MIN_DEV_ROWS : PROMOTION_MIN_DEV_ROWS;
  const minDevEffN = isStable ? STABLE_MIN_EFFECTIVE_N : PROMOTION_MIN_EFFECTIVE_N;
  const minHoldRows = isStable ? STABLE_MIN_HOLDOUT_ROWS : PROMOTION_MIN_HOLDOUT_ROWS;
  const minHoldEffN = isStable ? STABLE_MIN_HOLDOUT_EFFECTIVE_N : PROMOTION_MIN_HOLDOUT_EFFECTIVE_N;
  const symbols = isStable ? STABLE_MIN_DISTINCT_SYMBOLS : PROMOTION_MIN_DISTINCT_SYMBOLS;
  return {
    ...base,
    frozen: overrides.frozen ?? true,
    devEndMs: overrides.devEndMs === undefined ? Date.UTC(2026, 6, 1) : overrides.devEndMs,
    holdoutEndMs:
      overrides.holdoutEndMs === undefined ? (isStable ? Date.UTC(2026, 8, 1) : null) : overrides.holdoutEndMs,
    frozenAt: "2026-08-01T00:00:00.000Z",
    dev: {
      ...base.dev,
      rows: minDevRows,
      effectiveN: minDevEffN,
      distinctSymbolCount: symbols,
      distinctRegimes: 1,
      netAvgR: 0.15,
      pf: 1.8,
      payoffRatio: 0.4,
      stressNetAvgR: 0.1,
      approxMaxDrawdownR: 1,
      topSymbolPnlShare: 0.2,
      allThreeOosPositive: true,
      calendarDays: 30,
      ...overrides.dev,
    },
    holdout: {
      ...base.holdout,
      rows: minHoldRows,
      stressableRows: minHoldRows,
      effectiveN: minHoldEffN,
      distinctSymbolCount: symbols,
      netAvgR: 0.12,
      pf: 1.5,
      stressNetAvgR: 0.08,
      sufficient: true,
      negative: false,
      ...overrides.holdout,
    },
    ok: overrides.ok ?? true,
    blockers: overrides.blockers ?? [],
  };
}

// 5m candle: [openTimeMs, "0", high, low, close, "0", closeTimeMs]
function candle(openMs: number, high: number, low: number, close: number): KlineTuple {
  return [openMs, "0", String(high), String(low), String(close), "0", openMs + 300000];
}

const SIGNAL_OPEN_MS = new Date("2026-05-20T00:00:00.000Z").getTime();

beforeEach(() => {
  _resetCurrentGuardVariantMatrixStoreForTests();
});

afterEach(() => {
  _resetCurrentGuardVariantMatrixStoreForTests();
  for (const dir of dirs.splice(0)) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("current-guard-variant-matrix", () => {
  // 1. Baseline mirrors current geometry.
  it("[1] baseline mirrors the current geometry", () => {
    const signal = makeSignal();
    const geo = deriveVariantGeometry(signal, defOf(BASELINE_VARIANT_ID));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.entryPrice).toBe(100);
    expect(geo.stopLoss).toBe(98);
    expect(geo.takeProfitLevels[0]).toBe(104);
    expect(geo.stopDistanceBps).toBeCloseTo(200, 6);
    expect(geo.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / 200, 6); // 22/200 = 0.11
    expect(geo.costR).toBeCloseTo(0.11, 6);
  });

  // [LG-1] LG_R12_STOP250_FULL floors the stop at 250bps and places TP at 1.2R.
  it("[LG-1] LG_R12_STOP250_FULL: stop floor 250bps, TP at 1.2× risk", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("LG_R12_STOP250_FULL"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(250, 6); // floored up from raw 200
    expect(geo.stopLoss).toBeCloseTo(97.5, 6); // 100*(1-250/10000)
    expect(geo.takeProfitLevels[0]).toBeCloseTo(103, 6); // 100 + 1.2*2.5
    // TP distance / stop distance == reward multiple 1.2
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(1.2, 6);
    expect(geo.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / 250, 6); // 22/250 = 0.088
  });

  // [LG-2] LG_R12_STOP300_FULL: same 300bps breathing room as CG_WIDE but 1.2R TP.
  it("[LG-2] LG_R12_STOP300_FULL: stop floor 300bps, TP at 1.2× risk", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("LG_R12_STOP300_FULL"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo.takeProfitLevels[0]).toBeCloseTo(103.6, 6); // 100 + 1.2*3
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(1.2, 6);
  });

  // [CWLR] CG_WIDE_LONG_RUNNER: wide 300bps stop, far 3R TP, long-only.
  it("[CWLR] CG_WIDE_LONG_RUNNER floors stop at 300bps, places TP at 3R, long-only", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("CG_WIDE_LONG_RUNNER"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo.stopLoss).toBeCloseTo(97, 6); // 100*(1-300/10000)
    // TP at 3× the floored risk (far target — the let-it-run payoff)
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(3, 6);
    expect(geo.takeProfitLevels[0]).toBeCloseTo(109, 6); // 100 + 3*3
    // rejects SHORT
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    expect(deriveVariantGeometry(shortSig, defOf("CG_WIDE_LONG_RUNNER")).kind).toBe("rejected");
  });

  // [CWFS] CG_WIDE_FAST_SHORT: wide 300bps stop, near 0.5R TP, short-only.
  it("[CWFS] CG_WIDE_FAST_SHORT floors stop at 300bps, TP at 0.5R, short-only", () => {
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 101, tp1: 98 });
    const geo = deriveVariantGeometry(shortSig, defOf("CG_WIDE_FAST_SHORT"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo.stopLoss).toBeCloseTo(103, 6); // 100*(1+300/10000) — SHORT stop above entry
    // TP at 0.5× risk below entry (fast take)
    expect((100 - geo.takeProfitLevels[0]) / (geo.stopLoss - 100)).toBeCloseTo(0.5, 6);
    // rejects LONG
    expect(deriveVariantGeometry(makeSignal(), defOf("CG_WIDE_FAST_SHORT")).kind).toBe("rejected");
  });

  // [CWFL] CG_WIDE_FAST_LONG: the LONG mirror of CG_WIDE_FAST_SHORT (fast-exit disambiguation).
  it("[CWFL] CG_WIDE_FAST_LONG floors stop at 300bps, TP at 0.5R, long-only", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("CG_WIDE_FAST_LONG"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect(geo.stopLoss).toBeCloseTo(97, 6);
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(0.5, 6);
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    expect(deriveVariantGeometry(shortSig, defOf("CG_WIDE_FAST_LONG")).kind).toBe("rejected");
  });

  // [CTF] CG_TIGHT_FAST_05: native stop (floor 175 ≤ raw 200 → not widened), fast 0.5R TP, both directions.
  it("[CTF] CG_TIGHT_FAST_05 keeps the native stop (no widening) with a fast 0.5R TP", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("CG_TIGHT_FAST_05"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(200, 6); // floor 175 < raw 200 → native, not widened
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(0.5, 6);
    // direction-agnostic: SHORT also derives
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    expect(deriveVariantGeometry(shortSig, defOf("CG_TIGHT_FAST_05")).kind).toBe("ok");
  });

  it("[EXP10X] experimental fast lanes use smaller TP and 10x paper risk metadata", () => {
    const wideLongDef = defOf("CG_EXP_LONG_WIDE_FAST_10X");
    const tightLongDef = defOf("CG_EXP_LONG_TIGHT_FAST_10X");
    const mfeLongDef = defOf("CG_EXP_LONG_MFE_GIVEBACK_10X");
    const mfeShortDef = defOf("CG_EXP_SHORT_MFE_GIVEBACK_10X");
    const wideShortDef = defOf("CG_EXP_SHORT_WIDE_FAST_10X");

    const wideLong = deriveVariantGeometry(makeSignal(), wideLongDef);
    expect(wideLong.kind).toBe("ok");
    if (wideLong.kind !== "ok") throw new Error("expected ok");
    expect(wideLong.stopDistanceBps).toBeCloseTo(300, 6);
    expect((wideLong.takeProfitLevels[0] - 100) / (100 - wideLong.stopLoss)).toBeCloseTo(0.093333, 5);
    expect(wideLongDef.experimentalLeverage).toBe(10);
    expect(wideLongDef.paperRiskMultiplier).toBe(10);

    const tightLong = deriveVariantGeometry(makeSignal(), tightLongDef);
    expect(tightLong.kind).toBe("ok");
    if (tightLong.kind !== "ok") throw new Error("expected ok");
    expect(tightLong.stopDistanceBps).toBeCloseTo(200, 6);
    expect((tightLong.takeProfitLevels[0] - 100) / (100 - tightLong.stopLoss)).toBeCloseTo(0.13, 6);

    const mfeLong = deriveVariantGeometry(makeSignal(), mfeLongDef);
    expect(mfeLong.kind).toBe("ok");
    if (mfeLong.kind !== "ok") throw new Error("expected ok");
    expect(mfeLongDef.exitRule).toBe("mfe_giveback");
    expect((mfeLong.takeProfitLevels[0] - 100) / (100 - mfeLong.stopLoss)).toBeCloseTo(0.4, 6);
    expect(mfeLongDef.paperRiskMultiplier).toBe(10);

    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    const mfeShort = deriveVariantGeometry(shortSig, mfeShortDef);
    expect(mfeShort.kind).toBe("ok");
    if (mfeShort.kind !== "ok") throw new Error("expected ok");
    expect(mfeShortDef.exitRule).toBe("mfe_giveback");
    expect((100 - mfeShort.takeProfitLevels[0]) / (mfeShort.stopLoss - 100)).toBeCloseTo(0.4, 6);
    expect(mfeShortDef.paperRiskMultiplier).toBe(10);

    const wideShort = deriveVariantGeometry(shortSig, wideShortDef);
    expect(wideShort.kind).toBe("ok");
    if (wideShort.kind !== "ok") throw new Error("expected ok");
    expect((100 - wideShort.takeProfitLevels[0]) / (wideShort.stopLoss - 100)).toBeCloseTo(0.093333, 5);
    expect(deriveVariantGeometry(shortSig, wideLongDef).kind).toBe("rejected");
    expect(deriveVariantGeometry(shortSig, mfeLongDef).kind).toBe("rejected");
    expect(deriveVariantGeometry(makeSignal(), wideShortDef).kind).toBe("rejected");
    expect(deriveVariantGeometry(makeSignal(), mfeShortDef).kind).toBe("rejected");
  });

  // [CBE] CG_BE_AFTER_05: wide 300bps stop, 0.5R trigger, trail-after exit, both directions.
  it("[CBE] CG_BE_AFTER_05 floors stop at 300bps with a 0.5R trigger, both directions", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("CG_BE_AFTER_05"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 6);
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(0.5, 6);
    expect(defOf("CG_BE_AFTER_05").exitRule).toBe("trail_after_tp1");
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    expect(deriveVariantGeometry(shortSig, defOf("CG_BE_AFTER_05")).kind).toBe("ok");
  });

  // [SNTL] CG_BASELINE_FAST_05 / CG_MAKER_FAST_05: raw stop preserved (floor 1 never binds),
  // only the TP moves to 0.5R. Baseline=taker, maker=cheaper maker cost. Both direction-agnostic.
  it("[SNTL] baseline/maker sentil lanes keep the RAW stop and move only the TP to 0.5R", () => {
    const blFast = deriveVariantGeometry(makeSignal(), defOf("CG_BASELINE_FAST_05"));
    const baseline = deriveVariantGeometry(makeSignal(), defOf(BASELINE_VARIANT_ID));
    expect(blFast.kind).toBe("ok");
    expect(baseline.kind).toBe("ok");
    if (blFast.kind !== "ok" || baseline.kind !== "ok") throw new Error("expected ok");
    // raw stop is IDENTICAL to baseline (floor 1 is non-binding); only the TP changes.
    expect(blFast.stopLoss).toBe(baseline.stopLoss); // 98, unchanged
    expect(blFast.stopDistanceBps).toBeCloseTo(200, 6);
    expect((blFast.takeProfitLevels[0] - 100) / (100 - blFast.stopLoss)).toBeCloseTo(0.5, 6);
    expect(blFast.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / 200, 6); // same taker cost as baseline

    // maker sentil: same geometry, but the maker cost model is cheaper than taker.
    const mkFast = deriveVariantGeometry(makeSignal(), defOf("CG_MAKER_FAST_05"));
    expect(mkFast.kind).toBe("ok");
    if (mkFast.kind !== "ok") throw new Error("expected ok");
    expect(mkFast.stopLoss).toBe(baseline.stopLoss);
    expect((mkFast.takeProfitLevels[0] - 100) / (100 - mkFast.stopLoss)).toBeCloseTo(0.5, 6);
    expect(mkFast.costR).toBeLessThan(blFast.costR); // maker rebate < taker fee
    expect(defOf("CG_MAKER_FAST_05").fillMode).toBe("maker_limit");

    // direction-agnostic: SHORT also derives, raw stop preserved.
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    const blShort = deriveVariantGeometry(shortSig, defOf("CG_BASELINE_FAST_05"));
    expect(blShort.kind).toBe("ok");
    if (blShort.kind !== "ok") throw new Error("expected ok");
    expect(blShort.stopLoss).toBe(102); // raw short stop unchanged
    expect((100 - blShort.takeProfitLevels[0]) / (blShort.stopLoss - 100)).toBeCloseTo(0.5, 6);
  });

  // [LG-3] Long-only research lanes reject SHORT signals.
  it("[LG-3] LG_* lanes are long-only (rejected on SHORT)", () => {
    const shortSig = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 96 });
    expect(deriveVariantGeometry(shortSig, defOf("LG_R12_STOP250_FULL")).kind).toBe("rejected");
    expect(deriveVariantGeometry(shortSig, defOf("LG_R12_STOP300_FULL")).kind).toBe("rejected");
    // still derive fine on LONG
    expect(deriveVariantGeometry(makeSignal(), defOf("LG_R12_STOP250_FULL")).kind).toBe("ok");
  });

  it("[BL-1] pure bullish trend lane uses a 200bps stop floor and 1.5R target", () => {
    const geo = deriveVariantGeometry(makeSignal(), defOf("BL_TREND_R15_STOP200_FULL"));
    expect(geo.kind).toBe("ok");
    if (geo.kind !== "ok") throw new Error("expected ok");
    expect(geo.stopDistanceBps).toBeCloseTo(200, 6);
    expect(geo.stopLoss).toBeCloseTo(98, 6);
    expect(geo.takeProfitLevels[0]).toBeCloseTo(103, 6);
    expect((geo.takeProfitLevels[0] - 100) / (100 - geo.stopLoss)).toBeCloseTo(1.5, 6);
    expect(geo.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / 200, 6);
  });

  it("[BL-2] pure bullish trend lane rejects SHORT geometry", () => {
    const shortSignal = makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 97 });
    expect(deriveVariantGeometry(shortSignal, defOf("BL_TREND_R15_STOP200_FULL")).kind).toBe("rejected");
  });

  // 2. Wide stop + wide TP improves payoff geometry.
  it("[2] wide stop + wide TP widens stop, targets the 1.5R execution floor, and lowers cost-in-R", () => {
    const signal = makeSignal();
    const baseline = deriveVariantGeometry(signal, defOf(BASELINE_VARIANT_ID));
    const wide = deriveVariantGeometry(signal, defOf("CG_WIDE_STOP_TP_WIDE"));
    expect(baseline.kind).toBe("ok");
    expect(wide.kind).toBe("ok");
    if (baseline.kind !== "ok" || wide.kind !== "ok") throw new Error("expected ok");

    expect(wide.stopDistanceBps).toBeGreaterThanOrEqual(WIDE_STOP_MIN_BPS); // 300
    const payoff =
      (wide.takeProfitLevels[0]! - wide.entryPrice) / (wide.entryPrice - wide.stopLoss);
    expect(payoff).toBeCloseTo(1.5, 6);
    expect(wide.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / 300, 6); // 22/300 ~= 0.0733
    expect(wide.costR).toBeLessThan(baseline.costR);
  });

  it("[2b] trail challenger uses the same >=300bps stop and paired 1R target", () => {
    for (const signal of [
      makeSignal({ direction: "LONG", stopLoss: 99.5, tp1: 101, stopDistanceBps: 50 }),
      makeSignal({ direction: "SHORT", stopLoss: 100.5, tp1: 99, stopDistanceBps: 50 }),
    ]) {
      const trail = deriveVariantGeometry(signal, defOf("CG_TRAIL_AFTER_TP1"));
      expect(trail.kind).toBe("ok");
      if (trail.kind !== "ok") throw new Error("expected ok");

      expect(trail.stopDistanceBps).toBeGreaterThanOrEqual(WIDE_STOP_MIN_BPS);
      const risk = Math.abs(trail.entryPrice - trail.stopLoss);
      const reward = Math.abs(trail.takeProfitLevels[0]! - trail.entryPrice);
      expect(reward / risk).toBeCloseTo(1, 6);
      expect(trail.costR).toBeCloseTo(TAKER_ROUNDTRIP_BPS / WIDE_STOP_MIN_BPS, 6);
    }
  });

  // 3. Trail-after-TP1 uses the exact candle path.
  it("[3] trail-after-tp1 rides to breakeven after a TP1 touch", async () => {
    const candles: KlineTuple[] = [
      // signal candle: touches TP1 (high>=104) but stays above entry (low>100)
      candle(SIGNAL_OPEN_MS, 104.5, 100.5, 103),
      // later candle: pulls back to entry (low<=100) -> exit at breakeven
      candle(SIGNAL_OPEN_MS + 300000, 103, 99.5, 100),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "trail_after_tp1",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_LOSS"); // runnerR=0 -> grossR=0 -> not >0
    expect(result.grossR).toBe(0);
    expect(result.resolutionSource).toContain("TRAIL");
  });

  // 4. Scaleout TP1 + trail produces blended R.
  it("[4] scaleout tp1+trail produces a blended R of 1.0", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 104.5, 100.5, 103),
      candle(SIGNAL_OPEN_MS + 300000, 103, 99.5, 100),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104, // fullRewardR = (104-100)/2 = 2
      exitRule: "scaleout_tp1_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    // 0.5*2 + 0.5*0 = 1.0
    expect(result.grossR).toBeCloseTo(1.0, 6);
    expect(result.status).toBe("CLOSED_WIN");
  });

  // MFE-giveback exit (defaults: arm 0.75R, giveback 0.5 of peak). Entry 100 / stop 98 → risk 2 → 1R = 2 price.
  it("[MFEG1] arms after a 1.5R peak then banks 0.75R on the retrace (no intrabar lookahead)", async () => {
    const candles: KlineTuple[] = [
      // signal candle peaks at +1.5R (high 103) but giveback CANNOT trigger off this same candle's high
      candle(SIGNAL_OPEN_MS, 103, 100.5, 102),
      // next candle retraces to the giveback level 100 + 2*(1.5*0.5)=101.5 (low 101 <= 101.5), no stop/TP
      candle(SIGNAL_OPEN_MS + 300000, 102, 101, 101.5),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104, // far TP at 2R — not reached
      exitRule: "mfe_giveback",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(0.75, 6); // peak 1.5R * (1 - 0.5)
    expect(result.resolutionSource).toBe("MFE_GIVEBACK_EXIT");
  });

  it("[MFEG2] never arms (straight to stop) → CLOSED_LOSS -1, no giveback", async () => {
    const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 100.5, 97.5, 98)]; // +0.25R peak then stop
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "mfe_giveback",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.grossR).toBe(-1);
  });

  it("[MFEG3] a clean run to the far TP still takes full reward (giveback does not cap winners)", async () => {
    const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 104.5, 100.5, 104)]; // tags TP 104 on the signal candle
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104, // fullRewardR = (104-100)/2 = 2
      exitRule: "mfe_giveback",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(2, 6);
    expect(result.resolutionSource).toBe("CANDLE_WALK_TP");
  });

  it("[MFEG4] SHORT symmetry: arms after a 1.5R peak then banks 0.75R on the retrace up", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 99.5, 97, 98), // short entry 100/stop 102; favorable low 97 = +1.5R
      candle(SIGNAL_OPEN_MS + 300000, 99, 98, 98.5), // retrace up to level 100 - 2*0.75 = 98.5 (high 99 >= 98.5)
    ];
    const result = await walkVariantPath({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 102,
      target: 96, // far TP at 2R — not reached
      exitRule: "mfe_giveback",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(0.75, 6);
    expect(result.resolutionSource).toBe("MFE_GIVEBACK_EXIT");
  });

  it("[MAXHOLD-VM] marks unresolved paths to market when lane max-hold is reached", async () => {
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [
        candle(SIGNAL_OPEN_MS, 101, 99, 100.5),
        candle(SIGNAL_OPEN_MS + 300000, 101.5, 99.5, 101),
      ],
      forceCloseAtEnd: true,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(0.5, 6);
    expect(result.resolutionSource).toBe("MAX_HOLD_MTM");
  });

  // [PEAK] peakAtMs: additive field recording the open-time of the candle on which the
  // running MFE high-watermark last increased. Must point at the DELIBERATE peak candle,
  // not the last candle walked and not the candle where the trade eventually closed.
  it("[PEAK1] peakAtMs marks the candle where the MFE high-watermark was set, not the last candle", async () => {
    const peakCandleOpenMs = SIGNAL_OPEN_MS + 300000; // the 2nd candle — the deliberate peak
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110, // far away — never reached, so the walk runs to forceCloseAtEnd
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [
        candle(SIGNAL_OPEN_MS, 101, 99.5, 100.5), // favorable +1 -> mfeR 0.5 (first peak)
        candle(peakCandleOpenMs, 103, 100, 102), // favorable +3 -> mfeR 1.5 (NEW peak, deliberately placed here)
        candle(SIGNAL_OPEN_MS + 600000, 102, 99.6, 100), // favorable +2 -> mfeR 1.0, LOWER than the peak — must not move peakAtMs
      ],
      forceCloseAtEnd: true,
    });
    expect(result.maxMfeR).toBeCloseTo(1.5, 6);
    expect(result.peakAtMs).toBe(peakCandleOpenMs);
    // Sanity: the peak candle is neither the first nor the last walked, and not closedAtMs.
    expect(result.peakAtMs).not.toBe(SIGNAL_OPEN_MS);
    expect(result.peakAtMs).not.toBe(result.closedAtMs);
  });

  it("[PEAK2] peakAtMs stays null when price never moves favorably (no MFE above 0)", async () => {
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 95,
      target: 110,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [
        candle(SIGNAL_OPEN_MS, 100, 98, 99), // high==entry -> favorable 0
        candle(SIGNAL_OPEN_MS + 300000, 99.8, 97.5, 98.5), // stays below entry -> favorable 0
      ],
      forceCloseAtEnd: true,
    });
    expect(result.maxMfeR).toBe(0);
    expect(result.peakAtMs).toBeNull();
  });

  it("[PEAK3] SHORT symmetry: peakAtMs marks the candle with the deepest favorable low, not the last candle", async () => {
    const peakCandleOpenMs = SIGNAL_OPEN_MS + 300000;
    const result = await walkVariantPath({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 102,
      target: 90, // far away — never reached
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: [
        candle(SIGNAL_OPEN_MS, 100.5, 99, 99.5), // favorable +1 -> mfeR 0.5
        candle(peakCandleOpenMs, 99, 97, 98), // favorable +3 -> mfeR 1.5 (NEW peak)
        candle(SIGNAL_OPEN_MS + 600000, 100.4, 98, 99), // favorable +2 -> mfeR 1.0, must not move peakAtMs
      ],
      forceCloseAtEnd: true,
    });
    expect(result.maxMfeR).toBeCloseTo(1.5, 6);
    expect(result.peakAtMs).toBe(peakCandleOpenMs);
  });

  it("[MFEG5] CG_MFE_GIVEBACK uses FAR-TP geometry so the giveback can actually fire (not baseline)", () => {
    const def = defOf("CG_MFE_GIVEBACK");
    expect(def.exitRule).toBe("mfe_giveback");
    // Re-targeted to wide stop + far 3R TP: the baseline ~1R TP made the giveback inert (0 fires).
    expect(def.stopFloorBps).toBe(300);
    expect(def.tpRewardMultiple).toBe(3);
    // Geometry must place the TP far above the arm (0.75R) so an armed trade has room to fade.
    // entry 100 / stop 102 (200bps) → floored to 300bps stop, TP at 3R = 9 below entry (91).
    const geo = deriveVariantGeometry(makeSignal({ direction: "SHORT", stopLoss: 102, tp1: 99 }), def) as Extract<
      ReturnType<typeof deriveVariantGeometry>,
      { kind: "ok" }
    >;
    expect(geo.kind).toBe("ok");
    expect(geo.stopDistanceBps).toBeCloseTo(300, 0);
    const rewardR = Math.abs((geo.takeProfitLevels[0]! - 100) / (100 - geo.stopLoss));
    expect(rewardR).toBeCloseTo(3, 1); // far TP — the giveback now has room to operate
    // Direction-agnostic: it must derive far-TP on LONG signals too (not longOnly-rejected).
    const geoLong = deriveVariantGeometry(makeSignal({ direction: "LONG", stopLoss: 98, tp1: 101 }), def);
    expect(geoLong.kind).toBe("ok");
  });

  it("[PROMO] a proven high-WR low-payoff (~0.4) lane reaches STABLE; the 0.5 payoff floor used to bench it", () => {
    const row = {
      variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
      total: 130, open: 0, resolved: 130, freshValid: 110, effectiveN: 110, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
      netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
      payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
      noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
      topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
      calendarDays: 6, distinctRegimes: 2, distinctSymbolCount: 5, byRegime: [], byEntryVariant: [], oosThirds: null,
      allThreeOosPositive: true, rolling: [],
      // Point 4: this test isolates the payoff-floor gate, not the stage gate — give it a passing
      // STABLE proof so it reaches STABLE on payoff alone, same as before Point 4 existed.
      // Point 4 (stage model): "a passing holdout" is now the whole per-stage proof verdict —
      // deriveVariantStatus reads `stableProof.ok` / `promotionProof.ok` and NOTHING else about
      // development-vs-holdout evidence. No loose holdout counts are handed to it any more, so a
      // caller can no longer assemble a passing holdout out of individually-asserted fields.
      stableProof: makeStageProof("stable"), promotionProof: makeStageProof("promotion"),
    } as Parameters<typeof deriveVariantStatus>[0];
    const infra = { killSwitchReady: false, orderReconciliationReady: false, exchangeHealthReady: false };
    // payoff 0.4 (win ~0.5R / lose ~1R, 80% WR) clears net/PF/OOS/+10bps — must now reach STABLE.
    expect(deriveVariantStatus(row, infra).status).toBe("STABLE_CANDIDATE");
    // …but a genuinely degenerate payoff is still vetoed (isolates the floor at 0.3).
    expect(deriveVariantStatus({ ...row, payoffRatio: 0.2 }, infra).status).not.toBe("STABLE_CANDIDATE");
  });

  // [DDBLK] Scaled drawdown cap = max(5R, 0.3 × cumulative net R). A PROVEN lane (banked +36R)
  // tolerates a proportionally larger drawdown so it advances to STABLE; a lane that exceeds even the
  // scaled cap stays WATCHABLE *with the drawdown reason surfaced* (no silent stall, empty-blocker bug);
  // and the 5R floor still protects small/unproven lanes.
  it("[DDBLK] drawdown cap scales with cumulative R; blocker is surfaced when it still binds", () => {
    const row = {
      variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
      total: 134, open: 0, resolved: 134, freshValid: 134, effectiveN: 134, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
      netAvgR: 0.27, grossAvgR: 0.3, pf: 3.2, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
      payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
      noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 7.76, maxAdverseStreak: 1,
      topSymbolPnlShare: 0.18, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
      calendarDays: 3, distinctRegimes: 3, distinctSymbolCount: 5, byRegime: [], byEntryVariant: [], oosThirds: null,
      allThreeOosPositive: true, rolling: [],
      // Point 4: this test isolates the drawdown gate, not the stage gate — give it passing stage
      // proofs so it reaches STABLE on drawdown alone, same as before Point 4 existed. The drawdown
      // term asserted here is the HEADLINE one (full fresh population); each stage proof carries its
      // own dev-slice drawdown check independently.
      stableProof: makeStageProof("stable"), promotionProof: makeStageProof("promotion"),
    } as Parameters<typeof deriveVariantStatus>[0];
    const infra = { killSwitchReady: false, orderReconciliationReady: false, exchangeHealthReady: false };
    // cumulativeNetR = 0.27 × 134 = 36.2 → cap = max(5, 0.3×36.2) = 10.85R; dd 7.76 < 10.85 → STABLE.
    expect(deriveVariantStatus(row, infra).status).toBe("STABLE_CANDIDATE");
    // dd above even the scaled cap → WATCHABLE, and the drawdown blocker is surfaced (not empty).
    const blocked = deriveVariantStatus({ ...row, approxMaxDrawdownR: 15 }, infra);
    expect(blocked.status).toBe("WATCHABLE");
    expect(blocked.blockers.some((b) => b.toLowerCase().includes("drawdown"))).toBe(true);
    // 5R floor still binds for a marginal lane: cum = 0.06×100 = 6 → cap = max(5, 1.8) = 5; dd 6 > 5.
    const marginal = deriveVariantStatus({ ...row, netAvgR: 0.06, freshValid: 100, approxMaxDrawdownR: 6 }, infra);
    expect(marginal.status).toBe("WATCHABLE");
    expect(marginal.blockers.some((b) => b.toLowerCase().includes("drawdown"))).toBe(true);
  });

  // 5. No-fib500 rejects and counts.
  it("[5] no-fib500 variant rejects fib_500_entry signals (and accepts others)", () => {
    const fibSignal = makeSignal({ entryVariant: "fib_500_entry" });
    const noFib500Def = defOf("CG_NO_FIB500_ENTRYSET");
    const geo = deriveVariantGeometry(fibSignal, noFib500Def);
    expect(geo.kind).toBe("rejected");

    const observations = buildVariantMatrixObservationsForSignal(fibSignal);
    const obs = observations.find((o) => o.variantId === "CG_NO_FIB500_ENTRYSET");
    expect(obs).toBeDefined();
    expect(obs!.status).toBe("REJECTED");
    expect(obs!.resolutionSource).toBe("ENTRY_FILTER_FIB500_EXCLUDED");

    // A non-fib500 signal is NOT rejected by that variant.
    const okSignal = makeSignal({ entryVariant: "base_current_entry" });
    const okGeo = deriveVariantGeometry(okSignal, noFib500Def);
    expect(okGeo.kind).toBe("ok");
  });

  // 6. Maker-limit NO_FILL when price never returns to entry.
  it("[6] maker-limit yields NO_FILL when entry is never revisited, else fills", async () => {
    // Case A: after the signal candle, price gaps up and never dips to <=100.
    const noFillCandles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 102, 100.5, 101.5), // signal candle
      candle(SIGNAL_OPEN_MS + 300000, 105, 101, 104),
      candle(SIGNAL_OPEN_MS + 600000, 106, 102, 105),
    ];
    const noFill = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "maker_limit",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: noFillCandles,
    });
    expect(noFill.status).toBe("NO_FILL");
    expect(noFill.resolutionSource).toBe("MAKER_NO_FILL");

    // Case B: a later candle dips to entry (low<=100) then runs to TP.
    const fillCandles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 102, 100.5, 101.5), // signal candle (no fill here)
      candle(SIGNAL_OPEN_MS + 300000, 101, 99.5, 100.5), // dips to entry -> fills
      candle(SIGNAL_OPEN_MS + 600000, 105, 100.2, 104.5), // runs to TP
    ];
    const fill = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "maker_limit",
      openedAtMs: SIGNAL_OPEN_MS,
      candles: fillCandles,
    });
    expect(fill.status).toBe("CLOSED_WIN");
  });

  // Mock binance client producing a guaranteed WIN at the signal candle.
  function winningBinance(): { getKlines: (s: string, i: string, o: { startTime: number; endTime: number; limit: number }) => Promise<KlineTuple[]> } {
    return {
      getKlines: async (_symbol, interval) => {
        if (interval === "1m") return [];
        // Signal candle aligned to SIGNAL_OPEN_MS: high>=T (104), low>E (100) -> clean TP.
        return [
          candle(SIGNAL_OPEN_MS - 300000, 100.2, 99.9, 100), // pre-candle
          candle(SIGNAL_OPEN_MS, 104.5, 100.1, 104), // signal candle: TP, no SL
          candle(SIGNAL_OPEN_MS + 300000, 105, 103, 104.5),
        ];
      },
    };
  }

  // 7. OOS gates block small/unstable samples.
  it("[7] small samples stay COLLECTING and never reach WATCHABLE/promotion", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const signals = Array.from({ length: 3 }, (_, i) =>
      makeSignal({ sourceSignalId: `sig-${i}`, openedAt: "2026-05-20T00:00:00.000Z", symbol: `SYM${i}USDT` }),
    );
    mirrorVariantMatrixSignals(signals, store, "2026-05-20T00:00:00.000Z");
    await resolveVariantMatrixObservations(store, winningBinance());
    const report = buildCurrentGuardVariantMatrixReport(store);
    const baselineRow = report.rows.find((r) => r.variantId === BASELINE_VARIANT_ID)!;
    expect(baselineRow.freshValid).toBeLessThan(WATCHABLE_MIN_FRESH);
    expect(baselineRow.status).toBe("COLLECTING");
    expect(report.liveBlocked).toBe(true);
    expect(report.microPilotAllowed).toBe(false);
  });

  // 8. Scoreboard renders variant-matrix entries.
  it("[8] scoreboard surfaces CG_VARIANT_MATRIX lanes", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    mirrorVariantMatrixSignals([makeSignal()], store, "2026-05-20T00:00:00.000Z");
    await resolveVariantMatrixObservations(store, winningBinance());
    const report = buildCurrentGuardVariantMatrixReport(store);
    const scoreboard = buildShadowLaneScoreboard({ currentGuardVariantMatrixReport: report });
    const vmEntries = scoreboard.allEntries.filter((e) => e.laneId.startsWith("CG_VARIANT_MATRIX:"));
    expect(vmEntries.length).toBeGreaterThan(0);
  });

  // 9. AD live gate stays liveBlocked=true.
  it("[9] live gate stays liveBlocked=true and microPilotAllowed=false with the matrix", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    mirrorVariantMatrixSignals([makeSignal()], store, "2026-05-20T00:00:00.000Z");
    await resolveVariantMatrixObservations(store, winningBinance());
    const report = buildCurrentGuardVariantMatrixReport(store);
    const gate = buildLiveTradingGateReport({ currentGuardVariantMatrixReport: report });
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
    if (gate.bestVariantMatrixCandidate !== null) {
      expect(gate.bestVariantMatrixCandidate.liveBlocked).toBe(true);
    }
  });

  describe("exact lane-context proof", () => {
    function splitEvidenceReport() {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // LONG_BULLISH is independently strong while the aggregate is pulled negative by a separate
      // SHORT_BEARISH cohort. This is the regression shape the proof model must preserve.
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        // Point 4 (stage model): 143 rows at 4-day spacing is the smallest cohort in this file that
        // clears BOTH stage windows end to end — the STABLE window takes the first 40 rows as
        // development (40 independent episodes, past STABLE_MIN_EFFECTIVE_N=10) and the next 20 as a
        // BOUNDED holdout, and the PROMOTION window then freezes strictly later at 90 dev rows with
        // its own 53-row holdout. `freshValid` stays the FULL 143 throughout: the headline count is
        // deliberately the whole fresh-valid population, never a frozen slice.
        count: 143,
        netR: (index) => index % 5 === 0 ? -0.5 : 1,
        prefix: "lb",
        // Point 3c: spacingDays:4 (> this variant's 3-day/72h block width) keeps every row an
        // independent time-block draw under the new block-only key, same as [3C-PASS].
        spacingDays: 4,
      });
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "SHORT",
        regime: "Bearish pressure",
        count: 100,
        netR: () => -1,
        prefix: "sb",
        spacingDays: 4,
      });
      return buildCurrentGuardVariantMatrixReport(store);
    }

    it("[CTX-1] preserves a stable exact context when the aggregate diagnostic rejects", () => {
      const report = splitEvidenceReport();
      const row = report.rows.find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      expect(row.aggregateDiagnosticStatus).toBe("REJECT");
      expect(row.contextRows?.LONG_BULLISH?.status).toBe("STABLE_CANDIDATE");
      expect(row.contextRows?.SHORT_BEARISH?.status).toBe("REJECT");
      expect(row.contextSummary).toBe("CONTEXT_SPLIT");
    });

    it("[CTX-2] uses direct proof only and never falls back to aggregate/direction", () => {
      const report = splitEvidenceReport();
      expect(laneStatusForContext(report, "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", "LONG_BULLISH").status)
        .toBe("STABLE_CANDIDATE");
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "SHORT_BEARISH").status).toBe("REJECT");
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "LONG_MIXED").status).toBe("COLLECTING");
    });

    it("[CTX-3] returns NOT_APPLICABLE for an explicitly unsupported context", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const report = buildCurrentGuardVariantMatrixReport(store);
      const result = laneStatusForContext(report, BULL_TREND_VARIANT_ID, "SHORT_BEARISH");
      expect(result.status).toBe("NOT_APPLICABLE");
      expect(result.applicable).toBe(false);
      expect(result.direct).toBe(true);
    });

    it("[CTX-4] fails closed for unknown lane, missing exact context, and absent cohort", () => {
      const report = splitEvidenceReport();
      expect(laneStatusForContext(report, "NOT_A_LANE", "LONG_BULLISH").status).toBe("COLLECTING");
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", null).status).toBe("COLLECTING");
      expect(laneStatusForContext(report, BULL_TREND_VARIANT_ID, "LONG_BULLISH").status).toBe("COLLECTING");
    });

    it("[CTX-5] classifies only the four registered direction/regime contexts", () => {
      expect(exactLaneContextFor("LONG", "BULLISH")).toBe("LONG_BULLISH");
      expect(exactLaneContextFor("SHORT", "BEARISH")).toBe("SHORT_BEARISH");
      expect(exactLaneContextFor("LONG", "MIXED")).toBe("LONG_MIXED");
      expect(exactLaneContextFor("SHORT", "MIXED")).toBe("SHORT_MIXED");
      expect(exactLaneContextFor("LONG", "BEARISH")).toBeNull();
      expect(exactLaneContextFor("SHORT", "BULLISH")).toBeNull();
    });

    it("[CTX-6] keeps unresolved regime provenance aggregate-only", () => {
      const observation = buildVariantMatrixObservationsForSignal(makeSignal({ regime: "unclassified" }))[0]!;
      expect(exactLaneContextForObservation(observation)).toBe("UNKNOWN_CONTEXT");
    });

    it("[CTX-7] exposes exactly the definition-declared contexts and no inferred context", () => {
      const report = splitEvidenceReport();
      const wide = report.rows.find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const bull = report.rows.find((candidate) => candidate.variantId === BULL_TREND_VARIANT_ID)!;
      expect(Object.keys(wide.contextRows ?? []).sort()).toEqual([
        "LONG_BULLISH", "LONG_MIXED", "SHORT_BEARISH", "SHORT_MIXED",
      ]);
      expect(Object.keys(bull.contextRows ?? [])).toEqual(["LONG_BULLISH"]);
    });

    it("[CTX-8] recomputes chronological OOS thirds inside the exact cohort", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: (index) => index < 34 ? -0.1 : 1,
        prefix: "oos",
      });
      const exact = buildCurrentGuardVariantMatrixReport(store).rows
        .find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!.contextRows!.LONG_BULLISH!;
      expect(exact.oosThirds?.[0].netAvgR).toBeLessThan(0);
      expect(exact.allThreeOosPositive).toBe(false);
      expect(exact.status).toBe("WATCHABLE");
    });

    it("[CTX-9] applies stress and costs independently to the exact cohort", () => {
      const report = splitEvidenceReport();
      const exact = report.rows.find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!
        .contextRows!.LONG_BULLISH!;
      expect(exact.grossAvgR).toBeGreaterThan(exact.netAvgR!);
      expect(exact.plus10bpsNetAvgR).toBeGreaterThan(0);
      expect(exact.plus10bpsStillPositive).toBe(true);
    });

    it("[CTX-10] keeps aggregate accounting intact as a diagnostic-only population", () => {
      const report = splitEvidenceReport();
      const row = report.rows.find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      // Point 4 (stage model): the aggregate row's headline count is the FULL fresh-valid population
      // again — 243 rows (143 LONG_BULLISH + 100 SHORT_BEARISH) — and the aggregate's own frozen
      // STABLE window is a separate, much smaller slice reported alongside it. The invariant under
      // test (aggregate accounting stays internally consistent with the sum of its contexts) is
      // asserted on the population, and `freshValid !== devN` is asserted explicitly because the two
      // now MUST diverge: a headline count that tracked a frozen window is exactly the pinned-forever
      // behaviour this change removes.
      expect(row.freshValid).toBe(243);
      expect(row.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(row.freshValid).not.toBe(row.devN);
      expect(row.contextRows!.LONG_BULLISH!.freshValid + row.contextRows!.SHORT_BEARISH!.freshValid).toBe(243);
      expect(row.aggregateDiagnosticStatus).toBe(row.status);
      expect(row.aggregateDiagnosticStatusReason).toBe(row.statusReason);
    });

    it("[CTX-11] does not make an aggregate or exact status an authority grant", () => {
      const report = splitEvidenceReport();
      expect(report.liveBlocked).toBe(true);
      expect(report.microPilotAllowed).toBe(false);
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "LONG_BULLISH").status).toBe("STABLE_CANDIDATE");
    });

    it("[CTX-12] returns exact reasons and blockers instead of broad-row explanations", () => {
      const report = splitEvidenceReport();
      const positive = laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "LONG_BULLISH");
      const negative = laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "SHORT_BEARISH");
      expect(positive.statusReason).toContain("stable");
      expect(negative.blockers).toContain("negative fresh-valid economics at adequate sample");
    });

    it("[CTX-13] treats opposite trend-direction evidence as unknown rather than a promotable context", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bearish pressure",
        count: 30,
        netR: () => 1,
        prefix: "opposite",
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows
        .find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      // Point 4 (stage model): 30, not the old dev-scoped 21. No stage window can freeze at n=30
      // (STABLE alone needs >= 40 dev + >= 20 holdout rows), and the headline count is the full
      // fresh-valid population regardless of whether a window exists.
      expect(row.freshValid).toBe(30);
      expect(row.stableProof.frozen).toBe(false);
      expect(row.contextRows!.LONG_BULLISH!.freshValid).toBe(0);
      expect(row.contextRows!.LONG_MIXED!.freshValid).toBe(0);
    });
  });

  // Point 3 — tightened proof cohort: strict isFreshValid, explicit axis-stamp requirement,
  // effectiveN (independent time-block clustering) instead of raw freshValid, and distinctRegimes as
  // independent regime EPISODES instead of distinct string labels. Every gate below is proven with a
  // fail-without/pass-with pair over the SAME shape of cohort, differing only in the one dimension the
  // fix tightens — so a revert of any one fix turns exactly its own adversarial case red.
  describe("Point 3 — tightened proof cohort", () => {
    // Shared profitable-but-not-degenerate shape used by every cohort below (matches the existing
    // [CTX-1]/splitEvidenceReport pattern): 80% win rate, real losers so payoffRatio is defined.
    const bullishNetR = (index: number) => (index % 5 === 0 ? -0.5 : 1);

    it("[3A-FAIL] ambiguous freshness (isFreshValid=null) never counts as proof, however large or profitable", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: bullishNetR,
        prefix: "ambiguous",
        isFreshValid: null,
      });
      const report = buildCurrentGuardVariantMatrixReport(store);
      const row = report.rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      expect(row.freshValid).toBe(0);
      expect(row.contextRows!.LONG_BULLISH!.freshValid).toBe(0);
      expect(row.contextRows!.LONG_BULLISH!.status).toBe("COLLECTING");
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "LONG_BULLISH").status).toBe("COLLECTING");
    });

    it("[3A-PASS] the identical cohort with isFreshValid=true reaches STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        // Point 4 (stage model): 143 — see splitEvidenceReport's comment for why this size is what
        // freezes both stage windows.
        count: 143,
        netR: bullishNetR,
        prefix: "fresh",
        isFreshValid: true,
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      // Point 4 (stage model): 143, not the old dev-scoped 100. This is the fail-without half of
      // [3A-FAIL]'s pair: the SAME cohort with isFreshValid=true contributes its whole population.
      expect(row.contextRows!.LONG_BULLISH!.freshValid).toBe(143);
      expect(row.contextRows!.LONG_BULLISH!.status).toBe("STABLE_CANDIDATE");
    });

    it("[3B-FAIL] legacy/parsed regime data (no posture+regimeDirection axis stamp) can never stand alone as exact-context proof", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: bullishNetR,
        prefix: "legacy",
        legacy: true,
      });
      const report = buildCurrentGuardVariantMatrixReport(store);
      const row = report.rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      // Legacy rows still land in the AGGREGATE diagnostic (buildRow never filters on the axis stamp).
      // Point 4 (stage model): 143, not the old dev-scoped 100 — the headline count is the full
      // fresh-valid population and never a frozen window.
      expect(row.freshValid).toBe(143);
      // ...but the exact-context proof row must stay at COLLECTING: string-classified regime alone is
      // not exact-axis proof, so it may never stand in for a STABLE/PROMOTION verdict on its own.
      expect(row.contextRows!.LONG_BULLISH!.freshValid).toBe(0);
      expect(row.contextRows!.LONG_BULLISH!.status).toBe("COLLECTING");
      expect(laneStatusForContext(report, "CG_WIDE_STOP_TP_WIDE", "LONG_BULLISH").status).toBe("COLLECTING");
    });

    it("[3B-PASS] the identical cohort WITH the fresh-feed axis stamp reaches STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        // Point 4 (stage model): 143, not the old dev-scoped 100 — see [3A-PASS]'s comment.
        count: 143,
        netR: bullishNetR,
        prefix: "stamped",
        // legacy left unset -> default axis stamp applied
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      expect(row.contextRows!.LONG_BULLISH!.status).toBe("STABLE_CANDIDATE");
    });

    it("[3C-FAIL] rows clustered into one time block do not inflate effectiveN even though freshValid clears the bar", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: bullishNetR,
        prefix: "clustered",
        // 143 rows 43.2s apart: ~1h43m of total span, far inside this variant's 72h block width, so
        // every row lands in the SAME episode while keeping each timestamp distinct.
        //
        // Point 4 (stage model) removed the reason the previous version of this comment gave for the
        // nonzero spacing (a resolve-time `>= cutMs` tie collapsing devFresh to 0). Stage boundaries
        // are now tie-guarded — a boundary may only be placed after the LAST row of a timestamp group
        // — so exact ties would no longer misbehave. The nonzero spacing is retained only because it
        // is the shape a real hourly scanner produces.
        spacingDays: 0.0005,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // Point 4 (stage model): 143, not the old dev-scoped 100 — the raw row count is genuinely
      // large, which is exactly what makes the effectiveN collapse below the interesting fact.
      expect(ctx.freshValid).toBe(143);
      // Point 3c fix: symbol is NEVER crossed into the block key — 5 symbols sharing one instant is
      // ONE independent market draw, not 5. (Prior, backwards behavior crossed symbol in and read 5.)
      expect(ctx.effectiveN).toBe(1);
      // Point 4 (stage model): compared against the EPISODE floor, never against a raw-row floor.
      // The old assertion read `< STABLE_MIN_FRESH` (100 raw rows) — comparing an episode count to a
      // row-count constant is the exact scale confusion this change exists to remove.
      expect(ctx.effectiveN).toBeLessThan(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).toBe("WATCHABLE");
      // No STABLE window can freeze on one episode, so the blocker is the not-frozen line — and it
      // names the two independence floors that are unreachable here.
      expect(ctx.stableProof.frozen).toBe(false);
      expect(ctx.blockers.some((b) => b.includes("independent dev episodes"))).toBe(true);
    });

    it("[3C-PASS] a genuinely diverse, fresh, axis-stamped, well-attested cohort spread across distinct time blocks still reaches STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: bullishNetR,
        prefix: "diverse",
        // spacingDays=4: with the NEW block-only key (no scanBatchId), 4 days > this variant's 3-day
        // (72h) max-hold block width guarantees every successive row lands in a strictly later block
        // regardless of symbol -> all dev-side rows are independent draws.
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // Point 4 (stage model): 143, not the old dev-scoped 100 — every one of the 143 rows is its
      // own independent draw at 4-day spacing, and the headline reports the whole population.
      expect(ctx.effectiveN).toBe(143);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[3C-EPISODE] adversarial: 100 DISTINCT symbols all firing off ONE shared instant (no scanBatchId) must NOT produce effectiveN=100 — it collapses toward 1 independent market draw", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: bullishNetR,
        prefix: "episode",
        symbolFor: (index) => `SYM${index}USDT`, // genuinely distinct symbols
        // Near-tied (not exactly-tied) spacing — see [3C-FAIL]'s comment.
        spacingDays: 0.0005,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // Point 4 (stage model): the whole population, 143 rows on 143 genuinely distinct symbols.
      expect(ctx.freshValid).toBe(143);
      // Symbol diversity is real and reported separately...
      expect(ctx.distinctSymbolCount).toBe(143);
      // ...but it must never be conflated with independence: one shared instant is ONE market episode,
      // so effectiveN collapses to 1 — the exact backwards behavior the operator flagged (143 symbols
      // in one block would read effectiveN=143 if symbol were crossed into the key).
      expect(ctx.effectiveN).toBe(1);
      expect(ctx.effectiveN).not.toBe(143);
    });

    // Point 4c corrected this test's TITLE and comment, not its expectation. It used to say the
    // batch id "takes priority over time-blocking", which described the pre-4c rule where
    // scanBatchId was the PRIMARY grouping key. It is now a MERGE relation layered on top of the
    // openedAt episode chain: the 100 rows below chain into 34 episodes at 1-day spacing against a
    // 3-day window, and the shared batch id then merges all 34 into one component. Same answer (1),
    // different mechanism — and the merge-only form is the safe one, since a batch id can now only
    // ever LOWER effectiveN, never invent a draw.
    it("[3C-BATCH] a real scanBatchId MERGES episodes that chaining had separated — one shared batch across many days still collapses to effectiveN=1", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: bullishNetR,
        prefix: "batch",
        scanBatchIdFor: () => "batch-x", // one shared real batch id for every row
        // default spacingDays=1 spreads the 100 rows over 99 days, which chaining alone would read
        // as 34 separate episodes (a new one every 3 days) -> proves the shared batch id, not the
        // chain, is what collapses them.
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      expect(ctx.effectiveN).toBe(1);
    });

    it("[3C-MIXED] scanBatchId and time-block grouping coexist per-row without cross-contamination", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: bullishNetR,
        prefix: "mixed",
        // Half the rows share one real batch id (-> merged into 1 group); the other half carry no
        // batch id and are grouped by the openedAt episode chain alone, spaced (spacingDays:4 > the
        // 3-day max-hold width) so each of them opens its OWN episode.
        scanBatchIdFor: (index) => (index % 2 === 0 ? "batch-y" : null),
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // Point 4 (stage model): 51, not the old dev-scoped 36. effectiveN is computed over the FULL
      // 100-row population now, and index%2===0 splits it evenly: 50 rows share "batch-y" and merge
      // into 1 component + 50 rows each open their own episode (spacingDays:4 > the 3-day window
      // keeps each one separate) = 1 + 50 = 51. Same mechanism, same per-row independence, applied to
      // the whole population instead of a frozen prefix.
      expect(ctx.effectiveN).toBe(51);
    });

    // NOTE on isolation: topSymbolPnlShare (the pre-existing concentration gate) is computed as
    // max(|netR| per symbol) / total(|netR|). With ONLY 1-2 distinct symbols in an evenly-weighted
    // cohort that value is mathematically bounded BELOW by 1/(distinct symbol count) — 1.0 for one
    // symbol, >=0.5 for two — both already > MAX_TOP_SYMBOL_SHARE (0.4), so a synthetic 1-2-symbol
    // cohort built through addResolvedContextCohort would ALSO trip the concentration gate and never
    // even reach the WATCHABLE branch where the new distinctSymbolCount blocker is surfaced. That
    // coupling is real and desirable (the concentration gate already incidentally guards against
    // 1-2 symbol abuse at the STABLE tier) but it means isolating distinctSymbolCount as its OWN,
    // independently-failing gate needs topSymbolPnlShare held fixed at a passing value — done here via
    // a literal evidence row (same pattern as [PROMO]/[DDBLK]/[DIVERSITY-PROMOTION] above), not a
    // synthetic store cohort.
    it("[DIVERSITY-FAIL] distinctSymbolCount below STABLE_MIN_DISTINCT_SYMBOLS blocks STABLE_CANDIDATE even when every other gate (including concentration) independently passes", () => {
      const row = {
        variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 130, open: 0, resolved: 130, freshValid: 110, effectiveN: 110, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
        payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
        topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
        calendarDays: 6, distinctRegimes: 2, distinctSymbolCount: STABLE_MIN_DISTINCT_SYMBOLS - 1, // below the floor
        byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [],
        // Point 4 (stage model): both stage proofs PASS outright (ok:true, no blockers), so the ONLY
        // symbol-diversity shortfall in play is the HEADLINE population's — otherwise the
        // "distinctsymbolcount" blocker asserted below could be satisfied by a stage proof's own
        // `STABLE holdout distinctSymbolCount ...` message and this test would stop isolating its gate.
        stableProof: makeStageProof("stable"), promotionProof: makeStageProof("promotion"),
      } as Parameters<typeof deriveVariantStatus>[0];
      const infra = { killSwitchReady: false, orderReconciliationReady: false, exchangeHealthReady: false };
      const result = deriveVariantStatus(row, infra);
      expect(result.status).not.toBe("STABLE_CANDIDATE");
      expect(result.status).not.toBe("PROMOTION_CANDIDATE");
      expect(result.status).toBe("WATCHABLE");
      expect(result.blockers.some((b) => b.toLowerCase().includes("distinctsymbolcount"))).toBe(true);
      // Same row with enough distinct symbols reaches STABLE_CANDIDATE — proves the gate, not
      // something else, is what was blocking it.
      const passing = deriveVariantStatus({ ...row, distinctSymbolCount: STABLE_MIN_DISTINCT_SYMBOLS }, infra);
      expect(passing.status).toBe("STABLE_CANDIDATE");
    });

    it("[DIVERSITY-PASS] the identical shape with enough distinct symbols reaches STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: bullishNetR,
        prefix: "highdiv",
        symbolFor: (index) => `SYM${index % STABLE_MIN_DISTINCT_SYMBOLS}USDT`,
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      expect(ctx.distinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[DIVERSITY-PROMOTION] distinctSymbolCount gates PROMOTION_CANDIDATE with its OWN, higher floor — independent from STABLE's floor", () => {
      const row = {
        variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 260, open: 0, resolved: 260, freshValid: 220, effectiveN: 220, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
        payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
        topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
        calendarDays: 10, distinctRegimes: 3, distinctSymbolCount: STABLE_MIN_DISTINCT_SYMBOLS, // clears STABLE's floor (3), not PROMOTION's (5)
        byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [],
        // Point 4 (stage model): both stage proofs pass at their own tiers, so the tier being
        // isolated here is unambiguously the HEADLINE population's. (Each stage carries its own,
        // identically-tiered symbol floor on BOTH its dev and holdout sides — the
        // [4C-GATE-*] block covers those.)
        stableProof: makeStageProof("stable"), promotionProof: makeStageProof("promotion"),
      } as Parameters<typeof deriveVariantStatus>[0];
      const infra = { killSwitchReady: true, orderReconciliationReady: true, exchangeHealthReady: true };
      const belowPromotionFloor = deriveVariantStatus(row, infra);
      expect(belowPromotionFloor.status).toBe("STABLE_CANDIDATE");
      expect(belowPromotionFloor.blockers.some((b) => b.toLowerCase().includes("distinctsymbolcount"))).toBe(true);
      const atPromotionFloor = deriveVariantStatus({ ...row, distinctSymbolCount: PROMOTION_MIN_DISTINCT_SYMBOLS }, infra);
      expect(atPromotionFloor.status).toBe("PROMOTION_CANDIDATE");
    });

    it("[3D-FAIL] chronological label drift within the SAME regime family counts as ONE episode, not several", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: bullishNetR,
        prefix: "drift",
        // Label churns every row but never leaves the BULLISH family — a raw string Set would read 2.
        regimeFor: (index) => (index % 2 === 0 ? "Bullish expansion" : "Bullish pressure"),
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      expect(row.distinctRegimes).toBe(1);
      expect(row.contextRows!.LONG_BULLISH!.distinctRegimes).toBe(1);
    });

    it("[3D-PASS] a genuine chronological regime-family flip counts as 2 distinct episodes", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: bullishNetR,
        prefix: "flip",
        // First half BULLISH family, second half BEARISH family, in chronological (resolvedAt) order.
        regimeFor: (index) => (index < 50 ? "Bullish expansion" : "Bearish pressure"),
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      expect(row.distinctRegimes).toBe(2);
    });
  });

  // Point 4 — immutable chronological development/holdout split. A lane must not reach
  // STABLE/PROMOTION on development-cohort economics alone: a chronologically later, LOCKED slice
  // of the same fresh-valid population ("holdout") must independently also show non-negative
  // net/PF/stress, and must itself carry enough INDEPENDENT-EPISODE evidence (not merely enough
  // rows) before it counts.
  //
  // Point 4 (stage model) reshaped every cohort in this block. There are now TWO immutable windows
  // per proof unit, both defined on the openedAt proof clock, and STABLE's is
  //   dev     = the first STABLE_MIN_DEV_ROWS (40) rows carrying >= STABLE_MIN_EFFECTIVE_N (10) episodes
  //   holdout = the next STABLE_MIN_HOLDOUT_ROWS (20) rows carrying >= STABLE_MIN_HOLDOUT_EFFECTIVE_N (5)
  // at 4-day spacing. Fixtures that used to place their good/bad economics split at the old
  // floor(n*0.7) index therefore move it to index 40..60, which is where the holdout actually is.
  describe("Point 4 — development/holdout split", () => {
    it("[4-FAIL] a lane with excellent development-side economics but a genuinely negative holdout stays below STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        // Development window (rows 0..39): strong winners with real, periodic losers so PF/payoff
        // are genuinely well-defined ON THE DEV SLICE ALONE. STABLE holdout window (rows 40..59):
        // genuinely negative, with a real winner every 4th row so its PF is DEFINED and below the
        // floor rather than null — a null PF would fail for a second, uninteresting reason. Rows
        // 60+ return to the strong shape so the HEADLINE population stays comfortably positive and
        // the lane is not sent to REJECT before the stage gate is ever consulted.
        netR: (index) =>
          index >= 40 && index < 60 ? (index % 4 === 0 ? 0.4 : -0.3) : index % 5 === 0 ? -0.5 : 2,
        prefix: "holdout-neg",
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // Every non-holdout STABLE gate genuinely clears — proves this isn't accidentally blocked by
      // something else (episodes, OOS thirds, net/pf all pass on both the headline and the dev slice).
      expect(ctx.effectiveN).toBe(143);
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.devEffectiveN).toBeGreaterThanOrEqual(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.allThreeOosPositive).toBe(true);
      expect(ctx.netAvgR).toBeGreaterThan(0);
      expect(ctx.pf).toBeGreaterThan(1.2);
      expect(ctx.stableProof.dev.netAvgR).toBeGreaterThan(0);
      expect(ctx.stableProof.dev.pf).toBeGreaterThan(1.2);
      // The holdout is genuinely sufficient in SIZE and INDEPENDENCE — so this is NEGATIVITY blocking
      // it, not insufficiency. Point 4 (stage model): `holdoutSufficient` now means the FULL five-term
      // proof (rows AND episodes AND symbols AND computable stress AND non-negative economics), so it
      // is correctly false here; the two size terms are asserted directly to prove which one bites.
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBeGreaterThanOrEqual(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.holdoutDistinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(ctx.holdoutNegative).toBe(true);
      expect(ctx.holdoutSufficient).toBe(false);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).toBe("WATCHABLE");
      // Each failing economic term is named on its own, with the stage that owns it.
      expect(ctx.blockers).toContain("STABLE holdout netAvgR -0.125 — must be present and >= 0");
      expect(ctx.blockers.some((b) => b.startsWith("STABLE holdout PF"))).toBe(true);
      expect(ctx.blockers.some((b) => b.startsWith("STABLE holdout stressNetAvgR"))).toBe(true);
    });

    it("[4-PASS] the identical shape with a genuinely non-negative development AND holdout reaches STABLE_CANDIDATE", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        // The SAME shape as [4-FAIL] with the holdout window's negative patch removed: strong
        // winners with real, periodic losers everywhere, so both the development window and the
        // holdout window have well-defined, positive PF.
        netR: (index) => (index % 5 === 0 ? -0.5 : 2),
        prefix: "holdout-pos",
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.holdoutNegative).toBe(false);
      expect(ctx.holdoutNetAvgR).toBeGreaterThan(0);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[4-HOLDOUT-STRESS] a holdout with genuinely positive net AND an above-floor PF is still rejected when its +10bps stress economics go negative — stress is an INDEPENDENT term, not a restatement of net", () => {
      // Spec point 4 requires a holdout to prove FIVE things: enough rows, enough independent
      // episodes, enough symbols, COMPUTABLE cost/stress economics, and non-negative net/PF/STRESS.
      // Four of the five are pinned elsewhere in this file. The SIGN of the stress figure was not,
      // and nothing else implies it:
      //   * net and PF are mutually redundant at PF_FLOOR=1.0 — on any non-empty slice
      //     pf = wins/|losses| >= 1 exactly when the sum is >= 0 — so either one alone covers both;
      //   * [4C-GATE-HOLDOUT-STRESSABLE] covers whether a stress figure can be COMPUTED at all;
      //   * but stressNetR is strictly harsher than netR, by (roundTrip + STRESS_EXTRA_BPS)/stop
      //     minus the realised cost, so a thin-but-genuinely-profitable holdout clears net and PF
      //     and still fails the stress test. Before this test existed, deleting that term from
      //     `holdout.sufficient` left all 6,303 tests in the repo green.
      //
      // The cohort pins its stop distance so the stress penalty is a stated number rather than an
      // accident of the variant's geometry: stressNetR = grossR - (roundTrip + STRESS_EXTRA_BPS)/stop,
      // and this helper builds grossR = netR + 0.12 against a realised costR of 0.12, so the amount
      // by which stress is harsher than net is exactly (22 + 10)/100 - 0.12 = +0.20R. (At the
      // variant's own default 300bps stop that quantity is NEGATIVE, i.e. the stress figure is more
      // forgiving than the realised cost and no cohort could ever separate the two terms — which is
      // precisely why this gap survived unnoticed.)
      const HOLDOUT_STOP_BPS = 100;
      const stressPenaltyR = (TAKER_ROUNDTRIP_BPS + STRESS_EXTRA_BPS) / HOLDOUT_STOP_BPS - 0.12;
      const build = (bandWin: number) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        addResolvedContextCohort(store, {
          variantId: "CG_WIDE_STOP_TP_WIDE",
          direction: "LONG",
          regime: "Bullish expansion",
          count: 143,
          stopDistanceBpsFor: () => HOLDOUT_STOP_BPS,
          // [4-PASS]'s cohort everywhere EXCEPT the STABLE holdout window (rows 40..59), which
          // alternates one win and one loss so the window's PF is genuinely defined and above the
          // floor, while its MEAN is placed deliberately just below (fail arm) or just above (pass
          // arm) the stress penalty. Everything outside the window is untouched, so the headline
          // population stays strong and the lane is never sent to REJECT before the stage gate runs.
          netR: (index) =>
            index >= 40 && index < 60 ? (index % 2 === 0 ? bandWin : -0.2) : index % 5 === 0 ? -0.5 : 2,
          prefix: `holdout-stress-${bandWin}`,
          spacingDays: 4,
        });
        return buildCurrentGuardVariantMatrixReport(store)
          .rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!.contextRows!.LONG_BULLISH!;
      };

      // FAIL arm — band mean (0.30 - 0.20)/2 = +0.05R, comfortably below the 0.20R stress penalty.
      const failing = build(0.3);
      const h = failing.stableProof.holdout;
      // The other four holdout terms genuinely pass, so the stress SIGN is the only thing biting.
      expect(h.rows).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(h.effectiveN).toBeGreaterThanOrEqual(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(h.distinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(h.stressableRows).toBe(h.rows);
      expect(h.netAvgR!).toBeGreaterThan(0);
      expect(h.pf!).toBeGreaterThanOrEqual(PF_FLOOR);
      // The band sits inside the stress penalty — stated as a relation over the SHIPPED cost
      // constants so a future cost-model change fails here loudly instead of silently making the
      // fixture non-discriminating.
      expect(stressPenaltyR).toBeGreaterThan(h.netAvgR!);
      expect(h.stressNetAvgR!).toBeLessThan(0);
      expect(h.sufficient).toBe(false);
      expect(failing.stableProof.ok).toBe(false);
      expect(failing.status).not.toBe("STABLE_CANDIDATE");
      // Exactly ONE holdout blocker, and it names stress — not size, not episodes, not net, not PF.
      const holdoutBlockers = failing.stableProof.blockers.filter((b) => b.startsWith("STABLE holdout "));
      expect(holdoutBlockers).toHaveLength(1);
      expect(holdoutBlockers[0]!.startsWith("STABLE holdout stressNetAvgR")).toBe(true);
      expect(failing.stableProof.blockers.filter((b) => b.startsWith("STABLE dev "))).toEqual([]);

      // PASS arm — the identical cohort with the band's win raised to 0.80, i.e. mean +0.30R, above
      // the penalty. Same window, same rows, same episodes, same symbols, same stressable count: the
      // ONLY difference between the arms is the sign of the stress figure, so the fail arm is
      // attributable to that one term and to nothing else.
      const passing = build(0.8);
      expect(passing.stableProof.devEndMs).toBe(failing.stableProof.devEndMs);
      expect(passing.stableProof.holdoutEndMs).toBe(failing.stableProof.holdoutEndMs);
      expect(passing.stableProof.holdout.rows).toBe(h.rows);
      expect(passing.stableProof.holdout.effectiveN).toBe(h.effectiveN);
      expect(passing.stableProof.holdout.distinctSymbolCount).toBe(h.distinctSymbolCount);
      expect(passing.stableProof.holdout.netAvgR!).toBeGreaterThan(0);
      expect(passing.stableProof.holdout.stressNetAvgR!).toBeGreaterThan(0);
      expect(passing.stableProof.holdout.sufficient).toBe(true);
      expect(passing.status).toBe("STABLE_CANDIDATE");
    });

    it("[4-INSUFFICIENT / adversarial] an already-frozen holdout stays exactly as small as it was — backfilling more development-side data can never inflate it, retroactively satisfy the size floor, or move either boundary", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // Point 4 (stage model) reshaped step 1. The old version froze a cut at exactly
      // HOLDOUT_CUT_MIN_FRESH=20 rows — the single-point cut this change deletes. A stage WINDOW
      // needs >= STABLE_MIN_DEV_ROWS(40) development rows AND >= STABLE_MIN_HOLDOUT_ROWS(20) holdout
      // rows before anything freezes at all, so step 1 is now the smallest cohort that genuinely
      // freezes one. (The "too small to freeze" case the old step 1 also covered is now the first
      // wave of [STAGE-A] below, which asserts it directly.)
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: (index) => (index % 5 === 0 ? -0.5 : 1),
        prefix: "first-cohort",
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const firstReport = buildCurrentGuardVariantMatrixReport(store);
      const firstCtx = firstReport.rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!.contextRows!.LONG_BULLISH!;
      expect(firstCtx.holdoutCutMs).not.toBeNull();
      expect(firstCtx.holdoutEndMs).not.toBeNull();
      const frozenDevEndMs = firstCtx.holdoutCutMs;
      const frozenHoldoutEndMs = firstCtx.holdoutEndMs;
      const frozenDevCount = firstCtx.devN;
      const frozenHoldoutCount = firstCtx.holdoutN;
      expect(frozenDevCount).toBe(STABLE_MIN_DEV_ROWS);
      expect(frozenHoldoutCount).toBe(STABLE_MIN_HOLDOUT_ROWS);

      // Step 2: backfill 80 MORE fresh, well-attested, genuinely profitable rows — but dated well
      // BEFORE the frozen development boundary (a totally different, earlier year), so every one of
      // them lands on the development side. This is exactly the "changing only development-cohort
      // data" scenario, with NOTHING done to the holdout side at all.
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        count: 80,
        netR: () => 1, // uniform winners; the first cohort already supplies the population's losers
        prefix: "backfilled",
        baseOpenedAtMs: Date.UTC(2020, 0, 1),
        baseResolvedAtMs: Date.UTC(2020, 0, 1),
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const secondReport = buildCurrentGuardVariantMatrixReport(store);
      const secondCtx = secondReport.rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!.contextRows!.LONG_BULLISH!;

      // The headline population grows by exactly the 80 backfilled rows (143 + 80).
      expect(secondCtx.freshValid).toBe(223);
      expect(secondCtx.effectiveN).toBe(223);

      // BOTH frozen boundaries are byte-for-byte unchanged — no amount of development-side data,
      // however large or well-shaped, can move an already-frozen window.
      expect(secondCtx.holdoutCutMs).toBe(frozenDevEndMs);
      expect(secondCtx.holdoutEndMs).toBe(frozenHoldoutEndMs);
      // …and the holdout the pair defines is unchanged too: every backfilled row is dated before
      // `devEndMs`, so none of them can reach the holdout interval.
      expect(secondCtx.holdoutN).toBe(frozenHoldoutCount);
      expect(secondCtx.holdoutEffectiveN).toBe(firstCtx.holdoutEffectiveN);

      // HONEST LIMITATION, asserted rather than glossed: "immutable" is a claim about the
      // BOUNDARIES, not about the row set. A genuine historical backfill lands in whichever frozen
      // window its own openedAt selects, so the development slice's CONTENTS do grow — by exactly
      // the 80 rows dated before `devEndMs`. There is no ingest-timestamp field on the observation
      // that could distinguish "backfilled later" from "opened earlier", and adding one is out of
      // scope; this assertion exists so the property is visible and pinned rather than assumed away.
      expect(secondCtx.devN).toBe(frozenDevCount + 80);
      expect(secondCtx.stableProof.devEndMs).toBe(frozenDevEndMs);
    });

    it("[4-PROMOTION] PROMOTION_CANDIDATE inherits the holdout requirement — a lane clearing every OTHER promotion gate still cannot reach PROMOTION_CANDIDATE with a failing PROMOTION proof, but can with a passing one", () => {
      const base = {
        variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 260, open: 0, resolved: 260, freshValid: 220, effectiveN: 220, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
        payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
        topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
        calendarDays: 10, distinctRegimes: 3, distinctSymbolCount: 5, byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [],
        stableProof: makeStageProof("stable"),
      };
      const infra = { killSwitchReady: true, orderReconciliationReady: true, exchangeHealthReady: true };

      // A PROMOTION window that has not frozen at all: every promotion field is at its fail-closed
      // value and `ok` is false. STABLE is unaffected, which is the point — the two stages are
      // separate proofs over separate windows, so failing the higher one drops the lane to the
      // lower one rather than to WATCHABLE.
      const unfrozen = deriveVariantStatus(
        { ...base, promotionProof: emptyVariantMatrixStageProof("promotion", ["PROMOTION proof window not frozen"]) } as Parameters<typeof deriveVariantStatus>[0],
        infra,
      );
      expect(unfrozen.status).not.toBe("PROMOTION_CANDIDATE");
      expect(unfrozen.status).toBe("STABLE_CANDIDATE");
      expect(unfrozen.blockers).toContain("PROMOTION proof window not frozen");

      // Point 4 (stage model): a FROZEN promotion window whose holdout is one episode short is
      // likewise not promotable. `ok:false` is what the gate reads — the loose `holdoutSufficient`
      // flag a caller used to be able to assert its way past no longer exists on this interface at
      // all, which is a stronger guarantee than re-deriving it.
      const shortEpisodes = deriveVariantStatus(
        {
          ...base,
          promotionProof: makeStageProof("promotion", {
            ok: false,
            holdout: { effectiveN: PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - 1, sufficient: false },
            blockers: [
              `PROMOTION holdout effectiveN ${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - 1} < ${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N} independent episodes`,
            ],
          }),
        } as Parameters<typeof deriveVariantStatus>[0],
        infra,
      );
      expect(shortEpisodes.status).toBe("STABLE_CANDIDATE");
      expect(shortEpisodes.blockers).toContain(
        `PROMOTION holdout effectiveN ${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - 1} < ${PROMOTION_MIN_HOLDOUT_EFFECTIVE_N} independent episodes`,
      );

      const sufficient = deriveVariantStatus(
        { ...base, promotionProof: makeStageProof("promotion") } as Parameters<typeof deriveVariantStatus>[0],
        infra,
      );
      expect(sufficient.status).toBe("PROMOTION_CANDIDATE");
    });

    // [4-SYMMETRIC] — the operator explicitly requires BOTH directions of the mutation test.
    // [4-FAIL] above already proves direction (b): excellent development cannot rescue a genuinely
    // negative holdout. This proves direction (a): an excellent, sufficient holdout cannot rescue
    // genuinely bad development-side economics — the mirror image, and the one direction that was
    // NOT covered before true dev/holdout separation existed (before this fix, holdout rows leaked
    // into the "development" netAvgR/PF computation, so a strong post-cut holdout could numerically
    // drag a bad pre-cut population positive and slip through).
    it("[4-SYMMETRIC] a lane with genuinely bad development-side economics cannot be rescued into STABLE/PROMOTION by an excellent, sufficient holdout", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        direction: "LONG",
        regime: "Bullish expansion",
        // Point 4 (stage model): n=143 at 4-day spacing -> STABLE dev = rows 0..39,
        // STABLE holdout = rows 40..59, same windows as [4-FAIL]/[4-PASS].
        count: 143,
        // Development window (rows 0..39) AND the rest of the population: uniform, genuinely
        // value-destructive losers. STABLE holdout window (rows 40..59): strong winners with a real
        // loser every 5th row, so the holdout's PF is DEFINED and excellent — as good as
        // out-of-sample evidence ever gets, and comfortably past every holdout floor.
        netR: (index) => (index >= 40 && index < 60 ? (index % 5 === 0 ? -0.5 : 2) : -0.5),
        prefix: "symmetric",
        // Point 3c: keep every row independent under the new block-only key (see [3C-PASS]).
        spacingDays: 4,
      });
      const row = buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === "CG_WIDE_STOP_TP_WIDE")!;
      const ctx = row.contextRows!.LONG_BULLISH!;
      // The development side is genuinely bad (proves this isn't blocked by insufficient sample):
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.devEffectiveN).toBeGreaterThanOrEqual(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.stableProof.dev.netAvgR).toBeLessThan(0);
      expect(ctx.netAvgR).toBeLessThan(0);
      // The holdout is genuinely excellent and passes its full five-term proof — proves the holdout
      // side is NOT what's blocking this lane; only the bad development-side economics are.
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.holdoutNegative).toBe(false);
      expect(ctx.holdoutNetAvgR).toBeGreaterThan(0);
      // …and the STABLE proof still fails, on development terms alone.
      expect(ctx.stableProof.ok).toBe(false);
      expect(ctx.stableProof.blockers.every((b) => b.startsWith("STABLE dev "))).toBe(true);
      // Negative economics at adequate sample hits deriveVariantStatus's REJECT branch first,
      // regardless of how good the holdout looks.
      expect(ctx.status).toBe("REJECT");
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
    });
  });

  // Point 4c — the two halves of one change, tested together because they are one claim:
  //   (1) an EPISODE is a non-overlapping max-hold window keyed on the position's ORIGIN time, and
  //       a scan batch id may only ever MERGE rows into one episode, never split them into more; and
  //   (2) the holdout must clear an INDEPENDENCE floor of its own, not just a row-count floor.
  //
  // Every test below drives the real production path — addResolvedContextCohort ->
  // CurrentGuardVariantMatrixStore -> buildCurrentGuardVariantMatrixReport -> buildContextEvidenceRow
  // -> computeEffectiveN / computeHoldoutEvidence / deriveVariantStatus. computeEffectiveN is
  // module-private and is never reimplemented here; every number asserted is one the shipped report
  // actually produced.
  describe("Point 4c — independent-episode grouping + holdout independence gates", () => {
    // CG_WIDE_STOP_TP_WIDE carries no `maxHoldHours` override, so variantMaxHoldMs() gives it the
    // DEFAULT_MAX_HOLD_MS 72 h characteristic — the exact width computeEffectiveN chains at for this
    // variant. Every number in this block is derived from it rather than guessed.
    const EPISODE_VARIANT_ID = "CG_WIDE_STOP_TP_WIDE" as const;
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const MAX_HOLD_MS = 72 * HOUR_MS;
    const EPISODE_BASE_OPENED_MS = Date.UTC(2026, 5, 1);
    const EPISODE_BASE_RESOLVED_MS = Date.UTC(2026, 6, 1);
    // 80% winners at +1R, a real loser every 5th row at -0.5R: net 0.7R, PF 8, payoff 2 — clears
    // every non-holdout STABLE gate comfortably, and (unlike uniform winners) leaves PF/payoff
    // genuinely well-defined. Same shape the pre-existing Point 3/Point 4 fixtures use.
    const provenNetR = (index: number) => (index % 5 === 0 ? -0.5 : 1);
    const contextRowOf = (store: CurrentGuardVariantMatrixStore) =>
      buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === EPISODE_VARIANT_ID)!
        .contextRows!.LONG_BULLISH!;
    const INFRA_READY = { killSwitchReady: true, orderReconciliationReady: true, exchangeHealthReady: true };

    // [4C-HOLDOUT-BATCH] — the operator's headline abuse case. A LARGE (100-row), genuinely
    // PROFITABLE holdout that is nonetheless a single market episode must not satisfy the
    // out-of-sample requirement. This is the "n=201 that was one value repeated 201 times" failure
    // in holdout form: the row count says "well attested", the episode count says "one look".
    //
    // The two stores below are byte-identical except for ONE argument — whether the holdout rows
    // carry a shared scanBatchId — so the batch id is provably the sole cause of the difference.
    // Note this is the HARD form of the case: the 100 holdout rows are spaced 4 days apart, so
    // chaining alone would score them as 100 separate draws. Only the shared-origin identity
    // collapses them, which is exactly the "merge, never split" relation under test.
    const addHoldoutBatchCohort = (store: CurrentGuardVariantMatrixStore, prefix: string, shareOneBatch: boolean) => {
      addResolvedContextCohort(store, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        // Point 4 (stage model): n=333 at 4-day spacing. The STABLE development window is the first
        // STABLE_MIN_DEV_ROWS(40) rows — 40 independent episodes, four times STABLE_MIN_EFFECTIVE_N —
        // so the development side cannot be what blocks this lane. Everything from index 40 onward
        // (293 rows, i.e. every row the holdout search could ever reach) carries the shared batch id
        // in the collapsed arm, so no holdout window of ANY length can contain more than one episode.
        count: 333,
        netR: provenNetR,
        prefix,
        scanBatchIdFor: (index) =>
          index >= STABLE_MIN_DEV_ROWS && shareOneBatch ? `${prefix}-one-scan-cycle` : null,
        spacingDays: 4,
      });
    };

    it("[4C-HOLDOUT-BATCH] 293 profitable candidate-holdout rows sharing ONE scanBatchId are ONE episode — no STABLE window can freeze at all, and the blocker says exactly that", () => {
      const collapsedStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addHoldoutBatchCohort(collapsedStore, "hb-collapsed", true);
      const collapsed = contextRowOf(collapsedStore);

      // The population is LARGE and genuinely PROFITABLE — nothing about its economics is the
      // problem, and it is comfortably WATCHABLE.
      expect(collapsed.freshValid).toBe(333);
      expect(collapsed.netAvgR).toBeGreaterThan(0);
      expect(collapsed.distinctSymbolCount).toBe(5);
      expect(collapsed.status).toBe("WATCHABLE");

      // Point 4 (stage model): the outcome is now STRONGER than "a frozen holdout with
      // holdoutEffectiveN=1". The holdout floors are enforced during the FREEZE SEARCH, so a
      // population whose every candidate holdout window is one episode never gets a window at all —
      // the fail-closed state, with every stage-derived field at 0/null/false. That is the correct
      // behaviour: a window that cannot satisfy its own independence floor must not be frozen "to be
      // completed later", because a frozen boundary can never be redrawn.
      expect(collapsed.stableProof.frozen).toBe(false);
      expect(collapsed.promotionProof.frozen).toBe(false);
      expect(collapsed.devN).toBe(0);
      expect(collapsed.holdoutN).toBe(0);
      expect(collapsed.holdoutEffectiveN).toBe(0);
      expect(collapsed.holdoutSufficient).toBe(false);
      expect(collapsed.holdoutCutMs).toBeNull();
      expect(collapsed.holdoutEndMs).toBeNull();
      expect(collapsed.status).not.toBe("STABLE_CANDIDATE");
      expect(collapsed.status).not.toBe("PROMOTION_CANDIDATE");
      // The blocker list is asserted WHOLE, not by substring: the un-freezable window is the one and
      // only thing standing between this lane and STABLE, and the message names all four floors
      // (both raw-row and both independent-episode) with the exact numbers required.
      expect(collapsed.blockers).toEqual([
        `STABLE proof window not frozen: needs >= ${STABLE_MIN_DEV_ROWS} dev rows and ` +
          `>= ${STABLE_MIN_EFFECTIVE_N} independent dev episodes, then >= ${STABLE_MIN_HOLDOUT_ROWS} holdout rows ` +
          `and >= ${STABLE_MIN_HOLDOUT_EFFECTIVE_N} independent holdout episodes`,
      ]);

      // PROMOTION is a separate branch evaluated BEFORE stable and with its own gate set, so prove it
      // there too rather than inferring it. Only the headline breadth terms and infra readiness are
      // lifted to promotion grade (the report path can never reach PROMOTION on its own — infra
      // gates are always false there); the stage proofs are the ones the real pipeline just produced.
      const promotionAttempt = deriveVariantStatus({ ...collapsed, distinctRegimes: 2 }, INFRA_READY);
      expect(promotionAttempt.status).not.toBe("PROMOTION_CANDIDATE");
      expect(promotionAttempt.status).not.toBe("STABLE_CANDIDATE");
      expect(promotionAttempt.blockers).toEqual(collapsed.stableProof.blockers);

      // CONTROL: the identical cohort with the shared batch id removed. Same rows, same economics,
      // same symbols, same spacing — every row is now its own independent episode, both windows
      // freeze, and the lane reaches STABLE (and PROMOTION at promotion breadth). This is what proves
      // the refusal above was caused by the shared-origin identity and nothing else.
      const spreadStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addHoldoutBatchCohort(spreadStore, "hb-spread", false);
      const spread = contextRowOf(spreadStore);
      expect(spread.freshValid).toBe(333);
      expect(spread.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(spread.devEffectiveN).toBe(STABLE_MIN_DEV_ROWS);
      expect(spread.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(spread.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(spread.holdoutSufficient).toBe(true);
      expect(spread.status).toBe("STABLE_CANDIDATE");
      expect(deriveVariantStatus({ ...spread, distinctRegimes: 2 }, INFRA_READY).status).toBe("PROMOTION_CANDIDATE");
    });

    // [4C-EPISODE-OVERLAP], [4C-EPISODE-CONTROL] and [4C-EPISODE-CHAIN] are a controlled trio. All
    // three build their cohort through this one helper, with the SAME per-row DISTINCT scanBatchId,
    // the same symbols and the same economics. They vary exactly two numbers — the openedAt gap
    // between consecutive scans, and how many scans there are — so anything that differs between
    // their results is caused by those and nothing else.
    const addScanChainCohort = (
      store: CurrentGuardVariantMatrixStore,
      prefix: string,
      gapMs: number,
      count = 103,
    ) => {
      addResolvedContextCohort(store, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count,
        netR: provenNetR,
        prefix,
        // EVERY scan cycle gets its OWN, genuinely distinct batch id. Under the pre-fix rule
        // scanBatchId was the PRIMARY grouping key, so 72 distinct ids meant 72 independent draws by
        // construction. Now a batch id is a MERGE relation only: 72 unique ids cannot manufacture 72
        // draws out of one window, and cannot split one window into more than one.
        scanBatchIdFor: (index) => `${prefix}-scan-${index}`,
        openedAtMsFor: (index) => EPISODE_BASE_OPENED_MS + index * gapMs,
        resolvedAtMsFor: (index) => EPISODE_BASE_RESOLVED_MS + index * gapMs,
      });
    };

    it("[4C-EPISODE-OVERLAP] 72 DISTINCT hourly scan batches that all fall inside ONE 72h max-hold window are ONE episode — effectiveN=1, not 72", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // Point 4 (stage model): count=72, not 103. The headline `effectiveN` is now computed over the
      // FULL fresh population rather than a frozen development prefix, so the cohort must itself BE
      // the 72 hourly scans this test's claim is about. (At n=103 the population spans 102 h and
      // straddles TWO windows, which would measure a different thing — see [4C-EPISODE-CHAIN].)
      addScanChainCohort(store, "overlap", HOUR_MS, 72);
      const ctx = contextRowOf(store);
      // 72 rows = 72 separate scan cycles, each with its own scanBatchId, opened at +0h, +1h, ...
      // +71h. The last one opens 71 h after the first — still inside the 72 h window the first
      // position can remain in flight, so every one of them is the same market episode.
      expect(ctx.freshValid).toBe(72);
      expect(ctx.effectiveN).toBe(1);
      // Symbol breadth is untouched and reported separately — independence and breadth are never
      // conflated (5 rotating symbols across those 72 rows).
      expect(ctx.distinctSymbolCount).toBe(5);
      // 72 rows is well past STABLE_MIN_DEV_ROWS(40), so raw depth is not what blocks this lane —
      // one episode is. No window can freeze, and everything stage-derived stays fail-closed.
      expect(ctx.freshValid).toBeGreaterThan(STABLE_MIN_DEV_ROWS);
      expect(ctx.stableProof.frozen).toBe(false);
      expect(ctx.devN).toBe(0);
      expect(ctx.holdoutN).toBe(0);
      expect(ctx.holdoutSufficient).toBe(false);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
      expect(ctx.blockers.some((b) => b.includes(`>= ${STABLE_MIN_EFFECTIVE_N} independent dev episodes`))).toBe(true);
    });

    it("[4C-EPISODE-CONTROL] anti-degenerate control: the SAME scan batches spaced just past one max-hold window apart are all independent — effectiveN=103, so the rule does not simply collapse everything to 1", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // The single changed variable versus [4C-EPISODE-OVERLAP]: 73 h between scans instead of 1 h,
      // i.e. strictly more than this variant's 72 h max hold, so no position can still be in flight
      // when the next one is originated.
      addScanChainCohort(store, "control", MAX_HOLD_MS + HOUR_MS);
      const ctx = contextRowOf(store);
      // Point 4 (stage model): 103 (the full population), not the old dev-scoped 72.
      expect(ctx.freshValid).toBe(103);
      expect(ctx.effectiveN).toBe(103);
      // Genuinely separated draws are counted in full — the 103 distinct batch ids neither added to
      // nor subtracted from that (they merge only, and here each id appears exactly once).
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      // 20 independent holdout episodes is four times STABLE_MIN_HOLDOUT_EFFECTIVE_N, so this
      // cohort's holdout is accepted as proof where the overlapping one could not even be frozen.
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[4C-EPISODE-CHAIN] the chain re-anchors on each episode's OWN first row, so a continuously-trading lane keeps accruing episodes instead of collapsing forever", () => {
      // The third arm of the trio, and the one that pins the anchoring rule itself. A new episode
      // begins when a row opens >= one max-hold AFTER ITS EPISODE'S FIRST ROW — not after the row
      // immediately before it. The distinction is invisible on a cohort that fits inside one window
      // (both readings give 1) and decisive on a lane that never stops trading: measuring the gap to
      // the PREVIOUS ROW would mean an hourly-scanning lane never breaks its chain and reads
      // effectiveN=1 for the rest of its life, which would make every episode floor unreachable and
      // silently freeze every lane below STABLE forever.
      //
      // Point 4 (stage model): n=309 hourly rows span +0h..+308h over the FULL population, so
      // episode starts land at +0h, +72h, +144h, +216h and +288h -> 5. (The old dev-scoped reading
      // saw only the first 216 rows and therefore only 3.)
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addScanChainCohort(store, "chain", HOUR_MS, 309);
      const ctx = contextRowOf(store);
      expect(ctx.freshValid).toBe(309);
      expect(ctx.effectiveN).toBe(5);
      // 309 rows — nearly eight times STABLE_MIN_DEV_ROWS — and still nowhere near proof, because
      // five windows is half of STABLE_MIN_EFFECTIVE_N. This is the honest reading of a lane that
      // scans hourly and trades constantly, and it is the entire point of separating the raw-row
      // floors from the independent-episode floors.
      expect(ctx.freshValid).toBeGreaterThan(STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.effectiveN).toBeLessThan(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.stableProof.frozen).toBe(false);
      expect(ctx.holdoutSufficient).toBe(false);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
    });

    // 2026-08-05 evidence-integrity validation (isolated-runtime-validation goal, requirement C):
    // "36h lane versions are distinct from prior 72h evidence" and "changing maxHoldHours does not
    // change episode identity for identical market events". Both FAIL against the code as it stands
    // today. `variantMaxHoldMs(variantId)` (blockWidthMs's sole source, see the two call sites above
    // `buildContextEvidenceRow`) does a LIVE `.find()` against VARIANT_MATRIX_DEFINITIONS on every
    // read — no observation records what maxHoldHours was in effect when IT opened, so a later config
    // change re-chains every already-recorded row under the NEW width. This is not hypothetical: it
    // is exactly what shipped for CG_WIDE_FAST_LONG/CG_BE_AFTER_05/BL_TREND_SCALEOUT_STOP200 on
    // 2026-08-04 (72h -> 36h) — "episode count jumped same-second on both instances" for OLD rows
    // that had already resolved under the 72h regime, not just new ones.
    it("[EVIDENCE-INTEGRITY-A, FINDING — invariant does NOT hold] changing a variant's maxHoldHours retroactively changes episode identity for ALREADY-RECORDED rows of the SAME market events", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // Identical cohort to [4C-EPISODE-OVERLAP]: 72 hourly-spaced rows, all within the variant's
      // default 72h max-hold window -> one episode there.
      addScanChainCohort(store, "retro", HOUR_MS, 72);
      const before = contextRowOf(store);
      expect(before.freshValid).toBe(72);
      expect(before.effectiveN).toBe(1);

      // No new rows, no store mutation — ONLY the variant's own config changes, exactly like the
      // real 72h->36h deploy. CG_WIDE_STOP_TP_WIDE carries no maxHoldHours field today (relies on
      // the 72h default), so this both simulates a first-time override and is cleanly restorable by
      // deleting the field again.
      const def = VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === EPISODE_VARIANT_ID)!;
      expect(def.maxHoldHours).toBeUndefined();
      def.maxHoldHours = 36;
      try {
        const after = contextRowOf(store);
        // SAME 72 rows, SAME store, SAME market events — only the live config differs. A system that
        // pinned episode identity to the maxHoldHours in effect when each row opened would still
        // read 1 here. It reads 2: the chain re-anchors at the row opening +36h (rows 0-35 stay
        // episode 1, rows 36-71 become episode 2 — see the file's own re-anchoring rule, [4C-EPISODE-CHAIN]).
        expect(after.freshValid).toBe(72);
        expect(after.effectiveN).toBe(2);
        expect(after.effectiveN).not.toBe(before.effectiveN);
      } finally {
        delete def.maxHoldHours;
      }

      // Confirms this is a live, uncached recomputation on every single read (not a one-time
      // migration side effect) — restoring the config and reading the identical store again
      // reproduces the original count exactly.
      const restored = contextRowOf(store);
      expect(restored.effectiveN).toBe(1);
    });

    it("[EVIDENCE-INTEGRITY-B, FINDING — invariant does NOT hold] resolutionSource=MAX_HOLD_MTM rows (the tag produced when a position is force-closed at its hold ceiling, including a maxHoldHours-reduction-caused one) are counted IDENTICALLY to organically-resolved rows — nothing in this file's fresh/learning/STABLE/holdout/episode/promotion path filters on resolutionSource", () => {
      // Exhaustive source check (not just this test): resolutionSource is written in several places
      // (finalize(), the NO_FILL/EXPIRED_UNRESOLVED branches, the context-row builder copying
      // walk.resolutionSource through) but read as a filter/branch condition in exactly one place in
      // the whole file (a resolutionSource === "MFE_GIVEBACK_EXIT" check unrelated to population
      // membership). isFreshValidObs — the ONE gate that decides whether a row enters `fresh` (which
      // every stage/episode/promotion computation is built from) — checks only status/isFreshValid/
      // grossR/netR. It never references resolutionSource.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addScanChainCohort(store, "tag-control", HOUR_MS, 72);
      const control = contextRowOf(store);

      // Retag every row for this variant as MAX_HOLD_MTM — same netR/grossR/status/isFreshValid/
      // openedAt/symbol/scanBatchId, only resolutionSource changes. This is the exact shape the 183
      // real paper positions took on 2026-08-04 when the maxHoldHours reduction force-closed them.
      for (const obs of store.all) {
        if (obs.variantId === EPISODE_VARIANT_ID) {
          store.update(obs.observationId, { resolutionSource: "MAX_HOLD_MTM" });
        }
      }
      const tagged = contextRowOf(store);

      // If MAX_HOLD_MTM/transition rows were excluded from the learning population per requirement
      // C, every field below would drop (fewer fresh rows -> fewer episodes -> a worse-or-equal
      // status, never byte-identical). Nothing moves at all.
      expect(tagged.freshValid).toBe(control.freshValid);
      expect(tagged.effectiveN).toBe(control.effectiveN);
      expect(tagged.netAvgR).toBe(control.netAvgR);
      expect(tagged.status).toBe(control.status);
    });

    it("[4C-ORIGIN-CLOCK] resolvedAt is never consulted: positions ORIGINATED inside one episode stay one episode however far apart they resolve", () => {
      // The minimal, literal case the rule is about: two positions opened an hour apart — one look
      // at the market — that exit 20 days apart because their geometries fire on different
      // schedules. Exit timing is an artifact of each position, not a second reading of the market;
      // a resolve-time key scored these as TWO independent draws.
      const pairStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(pairStore, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 2,
        netR: () => 1,
        prefix: "origin-pair",
        openedAtMsFor: (index) => EPISODE_BASE_OPENED_MS + index * HOUR_MS,
        // 20 days apart — far more than this variant's 72 h window, and deliberately unrelated to
        // the 1 h origin spacing above.
        resolvedAtMsFor: (index) => EPISODE_BASE_RESOLVED_MS + index * 20 * DAY_MS,
      });
      const pair = contextRowOf(pairStore);
      // n=2 is far below any stage window's floors, so nothing freezes and effectiveN covers both rows.
      expect(pair.holdoutCutMs).toBeNull();
      expect(pair.holdoutEndMs).toBeNull();
      expect(pair.freshValid).toBe(2);
      expect(pair.effectiveN).toBe(1);

      // ...and it is not an artifact of n=2. A full production-shaped cohort: 100 positions all
      // originated inside a single 49.5 h burst, resolving 10 days apart so their resolve times
      // span ~1,000 days across ~330 wall-clock max-hold blocks. Origin time says one episode;
      // resolve time would have said ~70 on the dev side alone.
      const burstStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(burstStore, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 100,
        netR: provenNetR,
        prefix: "origin-burst",
        openedAtMsFor: (index) => EPISODE_BASE_OPENED_MS + index * 30 * 60 * 1000,
        resolvedAtMsFor: (index) => EPISODE_BASE_RESOLVED_MS + index * 10 * DAY_MS,
      });
      const burst = contextRowOf(burstStore);
      expect(burst.freshValid).toBe(100);
      expect(burst.effectiveN).toBe(1);
      // Point 4 (stage model) makes this arm STRICTLY STRONGER than it was. The resolve times span
      // ~1,000 days across ~330 max-hold blocks, so under a resolve-time clock this population would
      // comfortably clear every stage floor and freeze BOTH windows. Under the one true proof clock
      // (openedAt) it is a single 49.5 h look at the market: no window can freeze, and every
      // stage-derived field stays at its fail-closed value.
      expect(burst.stableProof.frozen).toBe(false);
      expect(burst.promotionProof.frozen).toBe(false);
      expect(burst.devN).toBe(0);
      expect(burst.holdoutN).toBe(0);
      expect(burst.holdoutCutMs).toBeNull();
      // 100 rows is 2.5x STABLE_MIN_DEV_ROWS — depth is not the shortfall, independence is.
      expect(burst.freshValid).toBeGreaterThan(STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS);
      expect(burst.holdoutSufficient).toBe(false);
      expect(burst.status).not.toBe("STABLE_CANDIDATE");
      expect(burst.status).not.toBe("PROMOTION_CANDIDATE");
    });

    it("[4C-CORRELATED-HOLDOUT] a large, spectacular, CORRELATED single-symbol holdout cannot carry a lane — neither when the whole population is one episode, nor when the holdout alone lacks breadth", () => {
      // ARM 1 (unchanged in shape from the original test): every row in the population originates
      // inside a single 71 h burst, so the population is ONE market episode however spectacular the
      // late rows look. Point 4 (stage model) makes the outcome fail-closed rather than
      // "frozen-with-a-bad-holdout": no window can freeze on one episode at all.
      const burstStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(burstStore, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        // Early rows: healthy economics (net 0.7R, PF 8, payoff 2) on 5 symbols. Late rows: +3R
        // every single one, i.e. as favourable as evidence ever gets, on one symbol and one scan.
        netR: (index) => (index < 100 ? provenNetR(index) : 3),
        prefix: "corr-holdout",
        symbolFor: (index) => (index < 100 ? `CTX${index % 5}USDT` : "SOLOUSDT"),
        scanBatchIdFor: (index) => (index < 100 ? null : "corr-holdout-one-scan"),
        openedAtMsFor: (index) => EPISODE_BASE_OPENED_MS + index * 30 * 60 * 1000,
        resolvedAtMsFor: (index) => EPISODE_BASE_RESOLVED_MS + index * 30 * 60 * 1000,
      });
      const burst = contextRowOf(burstStore);
      expect(burst.freshValid).toBe(143);
      expect(burst.effectiveN).toBe(1);
      expect(burst.effectiveN).toBeLessThan(STABLE_MIN_EFFECTIVE_N);
      expect(burst.stableProof.frozen).toBe(false);
      expect(burst.holdoutSufficient).toBe(false);
      expect(burst.status).not.toBe("STABLE_CANDIDATE");
      expect(burst.status).not.toBe("PROMOTION_CANDIDATE");
      // The stage's own reason is asserted on the PROOF, not on `row.blockers`: this cohort's 43
      // spectacular SOLOUSDT rows also blow the headline concentration cap, so the lane is
      // COLLECTING and `row.blockers` carries that headline shortfall instead of the stage lines.
      // The proof still records precisely why no window could freeze, which is the point.
      expect(burst.status).toBe("COLLECTING");
      expect(burst.blockers).toContain("top-symbol PnL share > 40%");
      expect(
        burst.stableProof.blockers.some((b) => b.includes(`>= ${STABLE_MIN_EFFECTIVE_N} independent dev episodes`)),
      ).toBe(true);

      // ARM 2 isolates the OTHER half of the original claim, which arm 1 can no longer reach now
      // that an un-freezable window fails closed: a window that DOES freeze, on a development side
      // that is genuinely strong and independent, whose holdout is nonetheless one instrument. The
      // holdout's economics are spectacular (+3R every row) and its independence is perfect (20
      // separate episodes at 4-day spacing) — breadth is the only thing it lacks, and that alone is
      // disqualifying, because a claim proven across five instruments has not been re-proven on one.
      const narrowStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(narrowStore, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: (index) => (index >= STABLE_MIN_DEV_ROWS && index < 60 ? 3 : provenNetR(index)),
        prefix: "corr-narrow",
        symbolFor: (index) =>
          index >= STABLE_MIN_DEV_ROWS && index < 60 ? "SOLOUSDT" : `CTX${index % 5}USDT`,
        spacingDays: 4,
      });
      const narrow = contextRowOf(narrowStore);
      // The development side passes its own gates outright.
      expect(narrow.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(narrow.devEffectiveN).toBe(STABLE_MIN_DEV_ROWS);
      expect(narrow.stableProof.dev.distinctSymbolCount).toBe(5);
      // The holdout is big enough, independent enough, and extraordinarily profitable...
      expect(narrow.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(narrow.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(narrow.holdoutNetAvgR).toBeCloseTo(3, 5);
      expect(narrow.holdoutNegative).toBe(false);
      // ...and it is still worth nothing, because it is one instrument.
      expect(narrow.holdoutDistinctSymbolCount).toBe(1);
      expect(narrow.holdoutSufficient).toBe(false);
      expect(narrow.status).toBe("WATCHABLE");
      expect(narrow.blockers).toContain(`STABLE holdout distinctSymbolCount 1 < ${STABLE_MIN_DISTINCT_SYMBOLS}`);

      // Promotion breadth on the headline changes nothing: the holdout still cannot carry it.
      const promotionAttempt = deriveVariantStatus({ ...narrow, distinctRegimes: 2 }, INFRA_READY);
      expect(promotionAttempt.status).not.toBe("PROMOTION_CANDIDATE");
      expect(promotionAttempt.status).not.toBe("STABLE_CANDIDATE");
    });

    it("[4C-UNDATED] rows whose openedAt will not parse FAIL CLOSED into ONE shared episode — a corrupt origin timestamp can never manufacture an independent draw", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // Built directly rather than through addResolvedContextCohort because the helper's timestamp
      // hooks take epoch-ms and cannot express an UNPARSEABLE openedAt — which is the whole point.
      // Everything else about these rows is a perfectly normal resolved, fresh-valid, axis-stamped
      // winner; only the ORIGIN clock is corrupt, exactly as a bad write or migration would leave it.
      const observations = Array.from({ length: 50 }, (_, index) => {
        const base = buildVariantMatrixObservationsForSignal(makeSignal({
          sourceSignalId: `undated-${index}`,
          symbol: `CTX${index % 5}USDT`,
          direction: "LONG",
          regime: "Bullish expansion",
          posture: "TACTICAL",
          regimeDirection: "LONG",
        })).find((candidate) => candidate.variantId === EPISODE_VARIANT_ID)!;
        return {
          ...base,
          observationId: `undated-${index}`,
          sourceObservationKey: `undated-${index}`,
          openedAt: "not-a-timestamp",
          status: "CLOSED_WIN" as const,
          grossR: 1.12,
          netR: 1,
          costR: 0.12,
          isFreshValid: true,
          // resolvedAt is valid and 10 days apart — maximally spread on the clock the pre-fix rule
          // keyed on, so a fallback to resolve time would read these as ~50 separate draws.
          resolvedAt: new Date(EPISODE_BASE_RESOLVED_MS + index * 10 * DAY_MS).toISOString(),
        };
      });
      store.addMany(observations);
      const ctx = contextRowOf(store);
      // The rows are counted (they are fresh-valid closes) but they carry no proof clock at all...
      expect(ctx.freshValid).toBe(50);
      // ...so they collapse into ONE shared fail-closed episode rather than the ~50 separate draws a
      // resolvedAt fallback would have manufactured out of their 10-day-apart resolve times.
      expect(ctx.effectiveN).toBe(1);
      // Point 4 (stage model): a row with no parseable openedAt cannot be attributed to a stage
      // window either, so it belongs to NEITHER side and no window can freeze from these rows.
      expect(ctx.stableProof.frozen).toBe(false);
      expect(ctx.devN).toBe(0);
      expect(ctx.holdoutN).toBe(0);
      expect(ctx.holdoutEffectiveN).toBe(0);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
    });

    // [4C-GATE-*] — added in the validation round after mutation testing found that ALL FOUR holdout
    // terms the status gate then re-derived from raw counts were untested AS GATES. Deleting any one
    // of them left the entire 6,168-test suite green, because every existing test reached the gate
    // with some OTHER term already blocking.
    //
    // Point 4 (stage model) PORTED this block rather than deleting it — it is the only per-term
    // coverage in the suite — but the terms moved, so the tests move with them. There are now two
    // distinct enforcement points and both need their own coverage:
    //
    //   (1) THE FREEZE SEARCH owns the two SIZE floors (rows, independent episodes) for each side of
    //       each stage. A population that cannot satisfy them produces NO WINDOW AT ALL — the
    //       fail-closed state — rather than a frozen window carrying a failing count. That is a
    //       strictly stronger guarantee than re-deriving the floors afterwards, and it is covered by
    //       [4C-HOLDOUT-BATCH] (holdout episodes), [4C-EPISODE-OVERLAP] / [4C-EPISODE-CHAIN] (dev
    //       episodes) and [STAGE-A] / [STAGE-E] below (rows).
    //   (2) buildStageProof owns the remaining five holdout terms — symbol breadth, computable
    //       cost/stress economics, and non-negative net / PF / stress — which the freeze search does
    //       not look at, so a frozen window CAN carry them failing. Those are the ones this block
    //       now varies, one at a time, through the REAL report pipeline.
    //
    // And the bypass the old re-derivation existed to close is now closed by construction:
    // `deriveVariantStatus` is exported and takes a plain struct, but no loose holdout count is a
    // member of that struct any more. It reads `stableProof.ok` / `promotionProof.ok` and nothing
    // else about development-vs-holdout evidence, so a caller has nothing left to assert its way
    // past. [4C-GATE-NO-BYPASS] pins exactly that.
    const promotionGradeEvidence = () =>
      ({
        variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 260, open: 0, resolved: 260, freshValid: 220, effectiveN: 220, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
        payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
        topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
        calendarDays: 10, distinctRegimes: 3, distinctSymbolCount: 5, byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [],
        // Both stage proofs sized exactly at their own floors with nothing to spare.
        stableProof: makeStageProof("stable"),
        promotionProof: makeStageProof("promotion"),
      }) as Parameters<typeof deriveVariantStatus>[0];

    it("[4C-GATE-BASE] positive control: the base evidence object reaches PROMOTION_CANDIDATE, so each negative case below is caused by the one field it varies and not by an already-broken base", () => {
      expect(deriveVariantStatus(promotionGradeEvidence(), INFRA_READY).status).toBe("PROMOTION_CANDIDATE");
    });

    it("[4C-GATE-STABLE-PROOF] a failing STABLE proof drops the lane to WATCHABLE and splices that stage's own blockers in verbatim", () => {
      const blockers = [`STABLE holdout distinctSymbolCount 1 < ${STABLE_MIN_DISTINCT_SYMBOLS}`];
      const status = deriveVariantStatus(
        { ...promotionGradeEvidence(), stableProof: makeStageProof("stable", { ok: false, blockers }) },
        INFRA_READY,
      );
      expect(status.status).not.toBe("PROMOTION_CANDIDATE");
      expect(status.status).not.toBe("STABLE_CANDIDATE");
      expect(status.status).toBe("WATCHABLE");
      expect(status.blockers).toContain(blockers[0]);
    });

    it("[4C-GATE-PROMOTION-PROOF] a failing PROMOTION proof stops the lane AT STABLE_CANDIDATE — the two stages are enforced separately, not collapsed into one", () => {
      const blockers = [
        `PROMOTION holdout distinctSymbolCount ${STABLE_MIN_DISTINCT_SYMBOLS} < ${PROMOTION_MIN_DISTINCT_SYMBOLS}`,
      ];
      const status = deriveVariantStatus(
        { ...promotionGradeEvidence(), promotionProof: makeStageProof("promotion", { ok: false, blockers }) },
        INFRA_READY,
      );
      expect(status.status).toBe("STABLE_CANDIDATE");
      expect(status.blockers).toContain(blockers[0]);
    });

    it("[4C-GATE-NO-BYPASS] a caller cannot assert its way past a failing stage proof — loose holdout counts are no longer part of the interface, and a MISSING proof fails closed with a blocker that names the omission", () => {
      // Every field the old bypass used, stated as favourably as possible, alongside a failing
      // STABLE proof. None of them is read: the verdict is the proof's.
      const asserted = {
        ...promotionGradeEvidence(),
        holdoutFreshValid: 10_000,
        holdoutEffectiveN: 10_000,
        holdoutDistinctSymbolCount: 50,
        holdoutSufficient: true,
        holdoutNegative: false,
        devN: 10_000,
        devEffectiveN: 10_000,
        stableProof: makeStageProof("stable", { ok: false, blockers: ["STABLE dev OOS thirds not all positive"] }),
      } as Parameters<typeof deriveVariantStatus>[0];
      expect(deriveVariantStatus(asserted, INFRA_READY).status).toBe("WATCHABLE");

      // A struct that omits a stage proof entirely (the type requires it, but this function is
      // exported and takes a plain object) fails closed rather than throwing or defaulting open, and
      // says WHICH proof was missing — distinctly from "the window has not frozen yet".
      const { stableProof: _dropped, ...withoutStable } = promotionGradeEvidence() as Record<string, unknown>;
      const missing = deriveVariantStatus(withoutStable as Parameters<typeof deriveVariantStatus>[0], INFRA_READY);
      expect(missing.status).toBe("WATCHABLE");
      expect(missing.blockers).toContain("STABLE proof missing from evidence object");
    });

    // ---- Producer-level per-term coverage (enforcement point 2 above). Each cohort below is
    // identical to a lane that reaches STABLE_CANDIDATE except for the ONE holdout property it
    // breaks, and every number asserted is one the shipped report actually produced.
    it("[4C-GATE-HOLDOUT-STRESSABLE] a holdout large enough on paper but with uncomputable cost/stress economics on half its rows fails the stress-validity term, and the blocker says so instead of claiming a size shortfall", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 143,
        netR: provenNetR,
        prefix: "stressable",
        spacingDays: 4,
        // Half the STABLE holdout window's rows (40..59) carry no usable stop distance, so their
        // +10bps stress figure is not computable at all. The stress MEAN over the remaining half is
        // still present and positive — this isolates the validity term from the sign term.
        stopDistanceBpsFor: (index) =>
          index >= STABLE_MIN_DEV_ROWS && index < 60 && index % 2 === 0 ? null : 200,
      });
      const ctx = contextRowOf(store);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutDistinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(ctx.holdoutNetAvgR).toBeGreaterThan(0);
      // The stress mean is present and non-negative — the SIGN term passes; only validity fails.
      expect(ctx.holdoutStressNetAvgR).not.toBeNull();
      expect(ctx.holdoutStressNetAvgR).toBeGreaterThan(0);
      expect(ctx.stableProof.holdout.stressableRows).toBe(STABLE_MIN_HOLDOUT_ROWS / 2);
      expect(ctx.holdoutSufficient).toBe(false);
      expect(ctx.status).toBe("WATCHABLE");
      expect(ctx.blockers).toContain(
        `STABLE holdout stressableRows ${STABLE_MIN_HOLDOUT_ROWS / 2} < ${STABLE_MIN_HOLDOUT_ROWS} ` +
          "(rows missing grossR/stopDistanceBps — stress economics not computable)",
      );
    });

    it("[4C-GATE-PROMOTION-HOLDOUT-SYMBOLS] a PROMOTION holdout that clears the STABLE symbol tier but not the PROMOTION tier stops the lane AT STABLE_CANDIDATE — each stage applies its OWN tier to its OWN window", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: EPISODE_VARIANT_ID,
        direction: "LONG",
        regime: "Bullish expansion",
        count: 200,
        netR: provenNetR,
        prefix: "promo-symbols",
        spacingDays: 4,
        // Rows before the PROMOTION development boundary rotate 5 symbols (so STABLE's whole window
        // and PROMOTION's development side both clear the 5-symbol tier); everything at or after it
        // — i.e. exactly PROMOTION's open-ended holdout — rotates only 4.
        symbolFor: (index) =>
          index < PROMOTION_MIN_DEV_ROWS
            ? `CTX${index % 5}USDT`
            : `CTX${index % (PROMOTION_MIN_DISTINCT_SYMBOLS - 1)}USDT`,
      });
      const ctx = contextRowOf(store);
      // STABLE's window is untouched and passes outright.
      expect(ctx.stableProof.ok).toBe(true);
      expect(ctx.holdoutDistinctSymbolCount).toBe(5);
      // PROMOTION's holdout is the ONLY thing lacking breadth.
      expect(ctx.promotionProof.frozen).toBe(true);
      expect(ctx.promotionProof.dev.distinctSymbolCount).toBe(5);
      expect(ctx.promotionProof.holdout.distinctSymbolCount).toBe(PROMOTION_MIN_DISTINCT_SYMBOLS - 1);
      expect(ctx.promotionProof.holdout.rows).toBeGreaterThanOrEqual(PROMOTION_MIN_HOLDOUT_ROWS);
      expect(ctx.promotionProof.holdout.effectiveN).toBeGreaterThanOrEqual(PROMOTION_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.promotionProof.ok).toBe(false);
      expect(ctx.promotionProof.blockers).toContain(
        `PROMOTION holdout distinctSymbolCount ${PROMOTION_MIN_DISTINCT_SYMBOLS - 1} < ${PROMOTION_MIN_DISTINCT_SYMBOLS}`,
      );
      // The headline population still carries 5 symbols, so this is the PROMOTION window's own tier
      // biting — not the headline breadth term.
      expect(ctx.distinctSymbolCount).toBe(5);
      const status = deriveVariantStatus({ ...ctx, distinctRegimes: 2 }, INFRA_READY);
      expect(status.status).toBe("STABLE_CANDIDATE");
      expect(status.blockers).toContain(
        `PROMOTION holdout distinctSymbolCount ${PROMOTION_MIN_DISTINCT_SYMBOLS - 1} < ${PROMOTION_MIN_DISTINCT_SYMBOLS}`,
      );
    });
  });

  // ===========================================================================================
  // Point 4 (stage model) — the two IMMUTABLE, STAGE-SPECIFIC proof windows.
  //
  // The confirmed critical bug this block regression-tests: a single cut frozen at the first ~20
  // rows pinned the development slice at 14 rows FOREVER, so every downstream count a lane reported
  // was a frozen artifact of its first day of trading and no lane could ever accumulate proof. The
  // replacement is two separate windows per proof unit, each frozen once, each with its OWN raw-row
  // AND independent-episode floors on BOTH its development and its holdout side, and with the two
  // holdout cohorts disjoint by construction.
  //
  // Every test here drives the REAL exported production path — addResolvedContextCohort ->
  // CurrentGuardVariantMatrixStore -> buildCurrentGuardVariantMatrixReport -> the module-private
  // freeze search / EpisodeAccumulator / buildStageProof -> deriveVariantStatus. None of the logic
  // under test is reimplemented here; every number asserted is one the shipped report produced.
  //
  // CG_WIDE_STOP_TP_WIDE carries no `maxHoldHours` override, so its episode width is the DEFAULT
  // 72 h. Every timing below is derived from that rather than guessed.
  // ===========================================================================================
  describe("Point 4 — stage-specific immutable proof windows", () => {
    const V = "CG_WIDE_STOP_TP_WIDE" as const;
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const MAX_HOLD_MS = 72 * HOUR_MS;
    const BASE_OPENED_MS = Date.UTC(2026, 5, 1);
    const BASE_RESOLVED_MS = Date.UTC(2026, 6, 1);
    // 80% winners at +1R with a real loser every 5th row: net 0.7R, PF 8, payoff 2 — clears every
    // headline and development-side economic gate comfortably, and (unlike uniform winners) leaves
    // PF/payoff genuinely well-defined on any contiguous slice of 5+ rows.
    const provenNetR = (index: number) => (index % 5 === 0 ? -0.5 : 1);
    const INFRA_READY = { killSwitchReady: true, orderReconciliationReady: true, exchangeHealthReady: true };
    const ctxOf = (store: CurrentGuardVariantMatrixStore) =>
      buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === V)!.contextRows!.LONG_BULLISH!;
    const aggOf = (store: CurrentGuardVariantMatrixStore, infra = false) =>
      buildCurrentGuardVariantMatrixReport(
        store,
        infra ? { killSwitchReady: true, orderReconciliationReady: true, exchangeHealthReady: true } : undefined,
      ).rows.find((c) => c.variantId === V)!;

    // ---------------------------------------------------------------------------------------
    // (a) THE REGRESSION TEST FOR THE CONFIRMED CRITICAL BUG.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-A] a report built at n=20 and then rebuilt at n=200 does NOT leave development pinned at the first cut — the old single-cut model froze dev at 14 rows forever", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // WAVE 1 — exactly the population size that used to freeze the old cut (HOLDOUT_CUT_MIN_FRESH
      // was 20, and the cut landed at index floor(20*0.7) = 14).
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 20, netR: provenNetR, prefix: "wave1", spacingDays: 4,
      });
      const wave1 = ctxOf(store);
      // Nothing freezes: a stage WINDOW needs >= STABLE_MIN_DEV_ROWS(40) development rows AND
      // >= STABLE_MIN_HOLDOUT_ROWS(20) holdout rows simultaneously, and 20 rows cannot supply both.
      // A partially-satisfiable split is never frozen "to be completed later" — a frozen boundary
      // can never be redrawn, so it must be right the first time.
      expect(wave1.freshValid).toBe(20);
      expect(wave1.stableProof.frozen).toBe(false);
      expect(wave1.promotionProof.frozen).toBe(false);
      expect(wave1.devN).toBe(0);
      expect(wave1.holdoutN).toBe(0);
      expect(wave1.holdoutCutMs).toBeNull();
      expect(wave1.status).toBe("WATCHABLE");

      // WAVE 2 — 180 more rows, chronologically AFTER wave 1, appended to the SAME store and the
      // report rebuilt. This is the exact production shape: the report is rebuilt on every scan.
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 180, netR: provenNetR, prefix: "wave2", spacingDays: 4,
        baseOpenedAtMs: BASE_OPENED_MS + 20 * 4 * DAY_MS,
        baseResolvedAtMs: BASE_RESOLVED_MS + 20 * 4 * DAY_MS,
      });
      const wave2 = ctxOf(store);

      // THE BUG, STATED AS AN ASSERTION. Under the single-cut model this lane's development slice
      // was 14 rows at n=20 and STILL 14 rows at n=200, and its headline `freshValid` reported 14.
      expect(wave2.freshValid).toBe(200);
      expect(wave2.freshValid).toBeGreaterThan(14);
      expect(wave2.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(wave2.devN).toBeGreaterThan(14);
      expect(wave2.stableProof.dev.rows).toBeGreaterThan(14);
      expect(wave2.stableProof.dev.rows).toBeGreaterThanOrEqual(STABLE_MIN_DEV_ROWS);
      expect(wave2.stableProof.dev.effectiveN).toBeGreaterThanOrEqual(STABLE_MIN_EFFECTIVE_N);
      // …and the window that finally froze carries a real, bounded holdout beside it.
      expect(wave2.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(wave2.holdoutEffectiveN).toBeGreaterThanOrEqual(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(wave2.stableProof.ok).toBe(true);
      expect(wave2.status).toBe("STABLE_CANDIDATE");

      // THE SCALE BUG, STATED AS AN ASSERTION. The outgoing gate required
      // `effectiveN >= STABLE_MIN_FRESH`, i.e. 100 INDEPENDENT EPISODES — which at the hard ceiling
      // of <=0.333 episodes/day for a 72 h max hold is 300 calendar days, and 600 for
      // PROMOTION_MIN_FRESH. Those two constants are RAW-ROW floors and are no longer read by the
      // status ladder at all: this lane is STABLE on 40 independent development episodes, an order of
      // magnitude below either of them.
      expect(wave2.stableProof.dev.effectiveN).toBeLessThan(STABLE_MIN_FRESH);
      expect(wave2.stableProof.dev.effectiveN).toBeLessThan(PROMOTION_MIN_FRESH);
      expect(STABLE_MIN_EFFECTIVE_N).toBeLessThan(STABLE_MIN_FRESH);
      expect(PROMOTION_MIN_EFFECTIVE_N).toBeLessThan(PROMOTION_MIN_FRESH);
    });

    // ---------------------------------------------------------------------------------------
    // (b) (c) (d) — episode identity. The abuse case, the harder abuse case, and the control that
    // proves the rule does not simply answer 1 to everything.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-B] 100 DISTINCT symbols emitted by ONE scan batch at ONE instant are ONE independent draw — effectiveN=1, never 100", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 100, netR: provenNetR, prefix: "onebatch",
        symbolFor: (index) => `SYM${index}USDT`,
        scanBatchIdFor: () => "one-scan-cycle",
        openedAtMsFor: () => BASE_OPENED_MS,
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.freshValid).toBe(100);
      // Symbol breadth is real, is large, and is reported SEPARATELY — the two are never conflated.
      expect(ctx.distinctSymbolCount).toBe(100);
      expect(ctx.effectiveN).toBe(1);
      expect(ctx.effectiveN).not.toBe(100);
      // A raw count 2.5x STABLE_MIN_DEV_ROWS backed by a single market episode proves nothing.
      expect(ctx.stableProof.frozen).toBe(false);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
    });

    it("[STAGE-C] 72 DISTINCT hourly scan batches that all fall inside ONE 72h max-hold window are ONE independent draw — a per-scan batch id can MERGE rows but can never SPLIT one window into more draws", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 72, netR: provenNetR, prefix: "hourly",
        // Every scan cycle gets its OWN genuinely distinct batch id. Under a rule that treated
        // scanBatchId as the PRIMARY grouping key this would be 72 independent draws by construction.
        scanBatchIdFor: (index) => `hourly-scan-${index}`,
        openedAtMsFor: (index) => BASE_OPENED_MS + index * HOUR_MS,
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * HOUR_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.freshValid).toBe(72);
      // The 72nd scan opens 71 h after the first — still inside the window the first position can
      // remain in flight, so all 72 overlap and are one look at the market.
      expect(ctx.effectiveN).toBe(1);
      expect(ctx.effectiveN).not.toBe(72);
      expect(ctx.stableProof.frozen).toBe(false);
    });

    it("[STAGE-D] anti-degenerate control: scans spaced just PAST one max-hold window apart are fully independent — effectiveN grows one-for-one, so the rule does not collapse everything to 1", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const N = 30;
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: N, netR: provenNetR, prefix: "spaced",
        // The single changed variable versus [STAGE-C]: 73 h between scans instead of 1 h, i.e.
        // strictly more than the 72 h max hold, so no position can still be in flight when the next
        // one is originated.
        openedAtMsFor: (index) => BASE_OPENED_MS + index * (MAX_HOLD_MS + HOUR_MS),
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * (MAX_HOLD_MS + HOUR_MS),
      });
      const ctx = ctxOf(store);
      expect(ctx.freshValid).toBe(N);
      expect(ctx.effectiveN).toBe(N);
      // This is the assertion that fails if computeEffectiveN were ever hardcoded (or degraded) to
      // return 1: N genuinely separated draws must be counted as N.
      expect(ctx.effectiveN).not.toBe(1);

      // THE BOUNDARY ITSELF, pinned separately. At a gap of EXACTLY one max-hold the first position
      // can no longer be in flight — max hold is when it is force-closed — so the next scan is a new
      // look at the market, not a continuation of the old one. An off-by-one here (`>` instead of
      // `>=`) silently halves every lane's independence count, which is the direction that inflates
      // nothing but stalls everything: it would make the episode floors twice as slow to reach.
      const exactStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(exactStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: N, netR: provenNetR, prefix: "exact-hold",
        openedAtMsFor: (index) => BASE_OPENED_MS + index * MAX_HOLD_MS,
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * MAX_HOLD_MS,
      });
      expect(ctxOf(exactStore).effectiveN).toBe(N);
      // …and one millisecond short of a full max hold they DO overlap, so the two sides of the
      // boundary are both asserted rather than only the permissive one.
      const justInsideStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(justInsideStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 3, netR: provenNetR, prefix: "just-inside",
        openedAtMsFor: (index) => BASE_OPENED_MS + index * (MAX_HOLD_MS - 1),
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * MAX_HOLD_MS,
      });
      // Rows at 0, 71h59m59.999s and 143h59m59.998s: the second is inside the first's window (one
      // episode), the third is outside the SECOND episode's start, so it opens a third... no — the
      // chain re-anchors on each episode's own first row, so rows 1 and 2 are 71h59m59.999s apart
      // and share an episode. Two episodes in total.
      expect(ctxOf(justInsideStore).effectiveN).toBe(2);
    });

    // ---------------------------------------------------------------------------------------
    // (e) — the holdout's OWN independence floor.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-E] 60 holdout-eligible rows that are ONE independent episode can never satisfy a holdout, however many rows they are — and the identical rows spread across episodes can", () => {
      // Development-eligible rows 0..39 are 4 days apart (40 independent episodes, four times
      // STABLE_MIN_EFFECTIVE_N), so the development side is never the shortfall. Rows 40..99 — 60
      // rows, THREE TIMES STABLE_MIN_HOLDOUT_ROWS — share one scan batch id, so every candidate
      // holdout window that could be drawn over them contains exactly one independent episode.
      const collapsedStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(collapsedStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 100, netR: provenNetR, prefix: "e-collapsed", spacingDays: 4,
        scanBatchIdFor: (index) => (index >= STABLE_MIN_DEV_ROWS ? "e-one-scan-cycle" : null),
      });
      const collapsed = ctxOf(collapsedStore);
      // Rows are abundant on both sides — this is not a size shortfall.
      expect(collapsed.freshValid).toBe(100);
      expect(100 - STABLE_MIN_DEV_ROWS).toBeGreaterThanOrEqual(30);
      expect(collapsed.netAvgR).toBeGreaterThan(0);
      // …and no STABLE window can be frozen at all, so every holdout-derived field fails closed.
      expect(collapsed.stableProof.frozen).toBe(false);
      expect(collapsed.holdoutN).toBe(0);
      expect(collapsed.holdoutEffectiveN).toBe(0);
      expect(collapsed.holdoutSufficient).toBe(false);
      expect(collapsed.status).not.toBe("STABLE_CANDIDATE");
      expect(collapsed.status).not.toBe("PROMOTION_CANDIDATE");
      expect(
        collapsed.blockers.some((b) =>
          b.includes(`>= ${STABLE_MIN_HOLDOUT_EFFECTIVE_N} independent holdout episodes`)),
      ).toBe(true);

      // CONTROL: byte-identical except that the shared batch id is removed. Same rows, same
      // economics, same symbols, same spacing — the holdout is now genuinely independent and the
      // window freezes. This is what proves the refusal above was caused by the shared-origin
      // identity and by nothing else.
      const spreadStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(spreadStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 100, netR: provenNetR, prefix: "e-spread", spacingDays: 4,
      });
      const spread = ctxOf(spreadStore);
      expect(spread.stableProof.frozen).toBe(true);
      expect(spread.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(spread.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(spread.holdoutSufficient).toBe(true);
      expect(spread.status).toBe("STABLE_CANDIDATE");
    });

    // ---------------------------------------------------------------------------------------
    // (f) — STABLE must be reachable strictly BEFORE PROMOTION, by arithmetic and not by luck.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-F] STABLE is reachable BEFORE PROMOTION: the same lane reaches STABLE_CANDIDATE with no PROMOTION window frozen, and only becomes PROMOTION_CANDIDATE after enough LATER evidence arrives", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // A genuine regime flip inside the cohort so the aggregate proof unit carries the two distinct
      // regime episodes PROMOTION additionally requires — otherwise this test would measure the
      // regime term instead of the stage term. (Exact-context rows are pinned to one regime family
      // by construction; see the note in [STAGE-F-CONTEXT-LIMIT] below.)
      const regimeFor = (index: number) => (index % 2 === 0 ? "Bullish expansion" : "Choppy range");
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 80, netR: provenNetR, prefix: "f-phase1", spacingDays: 4, regimeFor,
      });
      const phase1 = aggOf(store, true);
      // PHASE 1: the STABLE window has frozen and passes; the PROMOTION window does not exist yet.
      expect(phase1.stableProof.frozen).toBe(true);
      expect(phase1.stableProof.ok).toBe(true);
      expect(phase1.promotionProof.frozen).toBe(false);
      expect(phase1.promotionProof.ok).toBe(false);
      expect(phase1.status).toBe("STABLE_CANDIDATE");
      expect(phase1.status).not.toBe("PROMOTION_CANDIDATE");
      expect(
        phase1.blockers.some((b) => b.startsWith("PROMOTION proof window not frozen")),
      ).toBe(true);

      // PHASE 2: 120 more rows, all chronologically LATER. Nothing about the lane's economics
      // changes — only the amount of independent evidence available after STABLE's holdout ended.
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 120, netR: provenNetR, prefix: "f-phase2", spacingDays: 4, regimeFor,
        baseOpenedAtMs: BASE_OPENED_MS + 80 * 4 * DAY_MS,
        baseResolvedAtMs: BASE_RESOLVED_MS + 80 * 4 * DAY_MS,
      });
      const phase2 = aggOf(store, true);
      expect(phase2.promotionProof.frozen).toBe(true);
      expect(phase2.promotionProof.ok).toBe(true);
      expect(phase2.status).toBe("PROMOTION_CANDIDATE");
      // STABLE's window is untouched by PROMOTION freezing on top of it.
      expect(phase2.stableProof.devEndMs).toBe(phase1.stableProof.devEndMs);
      expect(phase2.stableProof.holdoutEndMs).toBe(phase1.stableProof.holdoutEndMs);
      // PROMOTION's development side deliberately SUBSUMES the whole of STABLE's window — earlier
      // validated evidence is legitimate development material for the next decision — and its
      // holdout begins at or after STABLE's holdout ended.
      expect(phase2.promotionProof.devEndMs!).toBeGreaterThanOrEqual(phase2.stableProof.holdoutEndMs!);
      expect(phase2.promotionProof.dev.rows).toBeGreaterThanOrEqual(
        STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS,
      );
    });

    it("[STAGE-F-INVARIANTS] the stage ladder cannot be inverted by arithmetic: PROMOTION's floors strictly dominate STABLE's whole window on every axis, and all eight are positive integers", () => {
      // These four inequalities are what make "STABLE before PROMOTION" a property of the constants
      // rather than of any particular cohort. The module asserts them at load time and throws on
      // violation; this test states them independently so a future retune that breaks the ladder is
      // caught by a named failure rather than by an import-time crash somewhere unrelated.
      expect(PROMOTION_MIN_EFFECTIVE_N).toBeGreaterThanOrEqual(
        STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N,
      );
      expect(PROMOTION_MIN_DEV_ROWS).toBeGreaterThanOrEqual(STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS);
      expect(PROMOTION_MIN_HOLDOUT_EFFECTIVE_N).toBeGreaterThan(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(PROMOTION_MIN_HOLDOUT_ROWS).toBeGreaterThan(STABLE_MIN_HOLDOUT_ROWS);
      for (const value of [
        STABLE_MIN_DEV_ROWS, STABLE_MIN_EFFECTIVE_N, STABLE_MIN_HOLDOUT_ROWS, STABLE_MIN_HOLDOUT_EFFECTIVE_N,
        PROMOTION_MIN_DEV_ROWS, PROMOTION_MIN_EFFECTIVE_N, PROMOTION_MIN_HOLDOUT_ROWS, PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
      ]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      // Raw-row floors and independent-episode floors live on ~1000:1 different scales (~320 rows
      // accrue per day against a hard ceiling of <=0.333 independent episodes per day at a 72 h max
      // hold). Sharing a constant between the two scales is the bug this whole change fixes, so the
      // two families must not collide.
      expect(STABLE_MIN_DEV_ROWS).not.toBe(STABLE_MIN_EFFECTIVE_N);
      expect(PROMOTION_MIN_DEV_ROWS).not.toBe(PROMOTION_MIN_EFFECTIVE_N);
      expect(STABLE_MIN_EFFECTIVE_N).toBeLessThan(STABLE_MIN_DEV_ROWS);
      expect(PROMOTION_MIN_EFFECTIVE_N).toBeLessThan(PROMOTION_MIN_DEV_ROWS);
    });

    // ---------------------------------------------------------------------------------------
    // (g) (h) — the two directions of the rescue test, on the SAME cohort shape.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-G] a glowing holdout cannot rescue a failing development window — the stage verdict is a flat AND, never a blend", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143,
        // Development window (rows 0..39): alternating +0.4 / -0.5 — a genuinely value-destructive
        // slice with a well-defined (sub-floor) PF. STABLE holdout window (rows 40..59) and the rest
        // of the population: the proven +2R shape, so the holdout is as good as evidence gets AND the
        // headline stays positive enough that the lane is WATCHABLE rather than REJECTed — otherwise
        // REJECT would fire first and this test would never reach the stage gate at all.
        netR: (index) =>
          index < STABLE_MIN_DEV_ROWS ? (index % 2 === 0 ? 0.4 : -0.5) : index % 5 === 0 ? -0.5 : 2,
        prefix: "g-rescue", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      // The holdout is everything a rescuer would need to be, on every one of its five terms.
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutDistinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(ctx.holdoutNetAvgR).toBeGreaterThan(0);
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.holdoutNegative).toBe(false);
      // The development window is genuinely bad…
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.stableProof.dev.netAvgR).toBeLessThan(0);
      // …and that alone is disqualifying. Every surviving blocker names the DEVELOPMENT side.
      expect(ctx.stableProof.ok).toBe(false);
      expect(ctx.stableProof.blockers.length).toBeGreaterThan(0);
      expect(ctx.stableProof.blockers.every((b) => b.startsWith("STABLE dev "))).toBe(true);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
      expect(deriveVariantStatus({ ...ctx, distinctRegimes: 2 }, INFRA_READY).status).not.toBe("STABLE_CANDIDATE");
    });

    it("[STAGE-H] a perfect development window cannot rescue a failing holdout — the mirror image of [STAGE-G], on the mirrored cohort", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143,
        // The EXACT mirror of [STAGE-G]: the bad patch moves from the development window to the
        // STABLE holdout window, and nothing else changes.
        netR: (index) =>
          index >= STABLE_MIN_DEV_ROWS && index < 60 ? (index % 2 === 0 ? 0.4 : -0.5) : index % 5 === 0 ? -0.5 : 2,
        prefix: "h-rescue", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      // The development window is everything a rescuer would need to be, on every one of its terms.
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.stableProof.dev.netAvgR).toBeGreaterThan(0);
      expect(ctx.stableProof.dev.pf!).toBeGreaterThan(1.2);
      expect(ctx.stableProof.dev.allThreeOosPositive).toBe(true);
      expect(ctx.stableProof.dev.distinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      // The holdout is genuinely negative, at full size and full independence…
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutNetAvgR!).toBeLessThan(0);
      expect(ctx.holdoutNegative).toBe(true);
      expect(ctx.holdoutSufficient).toBe(false);
      // …and that alone is disqualifying. Every surviving blocker names the HOLDOUT side.
      expect(ctx.stableProof.ok).toBe(false);
      expect(ctx.stableProof.blockers.length).toBeGreaterThan(0);
      expect(ctx.stableProof.blockers.every((b) => b.startsWith("STABLE holdout "))).toBe(true);
      expect(ctx.status).not.toBe("STABLE_CANDIDATE");
      expect(ctx.status).not.toBe("PROMOTION_CANDIDATE");
      expect(deriveVariantStatus({ ...ctx, distinctRegimes: 2 }, INFRA_READY).status).not.toBe("STABLE_CANDIDATE");
    });

    // ---------------------------------------------------------------------------------------
    // (i) — the two stages' holdout cohorts must be DISJOINT, not merely different sizes.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-I] PROMOTION's holdout is genuinely NEW evidence: no observationId appears in both stages' holdouts, because STABLE's is bounded and PROMOTION's starts at or after that bound", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 200, netR: provenNetR, prefix: "disjoint", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      expect(ctx.stableProof.frozen).toBe(true);
      expect(ctx.promotionProof.frozen).toBe(true);

      // The structural reason the cohorts are disjoint, asserted directly on the boundaries.
      expect(ctx.stableProof.holdoutEndMs).not.toBeNull();
      expect(ctx.promotionProof.holdoutEndMs).toBeNull(); // open-ended: permanent live verification
      expect(ctx.promotionProof.devEndMs!).toBeGreaterThanOrEqual(ctx.stableProof.holdoutEndMs!);

      // …and the consequence, computed with the SAME exported membership predicate the report uses,
      // over the SAME rows, as sets of observation ids. Disjointness is proven, not inferred from
      // the two row counts differing.
      const rows = store.all.filter(
        (o): o is CurrentGuardVariantMatrixObservation =>
          o.variantId === V && o.isFreshValid === true && o.status !== "OPEN",
      );
      const cutOf = (devEndMs: number, holdoutEndMs: number | null): VariantMatrixStageCut => ({
        v: 2, devEndMs, holdoutEndMs, frozenAt: "",
        devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
      });
      const stableSlices = stageSlicesForCut(
        rows,
        cutOf(ctx.stableProof.devEndMs!, ctx.stableProof.holdoutEndMs),
      );
      const promotionSlices = stageSlicesForCut(
        rows,
        cutOf(ctx.promotionProof.devEndMs!, ctx.promotionProof.holdoutEndMs),
      );
      const stableHoldoutIds = new Set(stableSlices.holdout.map((o) => o.observationId));
      const promotionHoldoutIds = new Set(promotionSlices.holdout.map((o) => o.observationId));
      expect(stableHoldoutIds.size).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(promotionHoldoutIds.size).toBeGreaterThanOrEqual(PROMOTION_MIN_HOLDOUT_ROWS);
      const shared = [...stableHoldoutIds].filter((id) => promotionHoldoutIds.has(id));
      expect(shared).toEqual([]);

      // PROMOTION's DEVELOPMENT side, by contrast, is deliberately a superset of STABLE's entire
      // window — that is the "earlier validated evidence may serve as later development material"
      // half of the rule, and it is what stops PROMOTION having to re-earn what STABLE already banked.
      const promotionDevIds = new Set(promotionSlices.dev.map((o) => o.observationId));
      for (const id of stableSlices.dev.map((o) => o.observationId)) expect(promotionDevIds.has(id)).toBe(true);
      for (const id of stableHoldoutIds) expect(promotionDevIds.has(id)).toBe(true);
    });

    // ---------------------------------------------------------------------------------------
    // The one-clock guarantee, the immutability guarantee, and the persisted-identity field.
    // ---------------------------------------------------------------------------------------
    it("[STAGE-CLOCK] resolvedAt is never consulted — reversing every resolve time while holding origin times fixed changes NOTHING about the windows, the slices or the episode count", () => {
      const build = (prefix: string, reverseResolve: boolean) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        addResolvedContextCohort(store, {
          variantId: V, direction: "LONG", regime: "Bullish expansion",
          count: 143, netR: provenNetR, prefix, spacingDays: 4,
          openedAtMsFor: (index) => BASE_OPENED_MS + index * 4 * DAY_MS,
          // Same origin sequence in both arms; the resolve sequence is REVERSED in the second, so a
          // resolve-time clock would sort, slice and chain the population in the opposite order.
          resolvedAtMsFor: (index) =>
            BASE_RESOLVED_MS + (reverseResolve ? 142 - index : index) * 4 * DAY_MS,
        });
        return ctxOf(store);
      };
      const forward = build("clock-fwd", false);
      const reversed = build("clock-rev", true);
      expect(forward.stableProof.frozen).toBe(true);
      expect(reversed.stableProof.devEndMs).toBe(forward.stableProof.devEndMs);
      expect(reversed.stableProof.holdoutEndMs).toBe(forward.stableProof.holdoutEndMs);
      expect(reversed.promotionProof.devEndMs).toBe(forward.promotionProof.devEndMs);
      expect(reversed.devN).toBe(forward.devN);
      expect(reversed.holdoutN).toBe(forward.holdoutN);
      expect(reversed.devEffectiveN).toBe(forward.devEffectiveN);
      expect(reversed.holdoutEffectiveN).toBe(forward.holdoutEffectiveN);
      expect(reversed.effectiveN).toBe(forward.effectiveN);
      expect(reversed.status).toBe(forward.status);
    });

    it("[STAGE-IMMUTABLE] a frozen window never moves: appending 500 later rows leaves both boundaries and both frozen slices byte-identical while the headline population grows", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "imm-1", spacingDays: 4,
      });
      const before = ctxOf(store);
      expect(before.stableProof.frozen).toBe(true);
      expect(before.promotionProof.frozen).toBe(true);

      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 500, netR: provenNetR, prefix: "imm-2", spacingDays: 4,
        baseOpenedAtMs: BASE_OPENED_MS + 143 * 4 * DAY_MS,
        baseResolvedAtMs: BASE_RESOLVED_MS + 143 * 4 * DAY_MS,
      });
      const after = ctxOf(store);
      expect(after.freshValid).toBe(643); // the headline is live and grows…
      expect(after.stableProof.devEndMs).toBe(before.stableProof.devEndMs); // …the windows do not.
      expect(after.stableProof.holdoutEndMs).toBe(before.stableProof.holdoutEndMs);
      expect(after.stableProof.frozenAt).toBe(before.stableProof.frozenAt);
      expect(after.promotionProof.devEndMs).toBe(before.promotionProof.devEndMs);
      expect(after.devN).toBe(before.devN);
      expect(after.holdoutN).toBe(before.holdoutN);
      expect(after.stableProof.dev.rows).toBe(before.stableProof.dev.rows);
      expect(after.stableProof.holdout.rows).toBe(before.stableProof.holdout.rows);
      expect(after.stableProof.holdout.netAvgR).toBe(before.stableProof.holdout.netAvgR);
      // PROMOTION's holdout is the ONE slice that is meant to grow — it is open-ended by design, so
      // an already-promoted lane stays under permanent live verification.
      expect(after.promotionProof.holdout.rows).toBeGreaterThan(before.promotionProof.holdout.rows);
    });

    it("[STAGE-QUARANTINE] boundaries may only be placed behind the settlement horizon, and are a pure function of the rows — two builds with different capturedAt produce identical windows", () => {
      // A population entirely inside the settlement quarantine cannot freeze anything: no position
      // opened that recently is guaranteed to have terminated, so a boundary placed there could
      // later acquire rows behind it.
      const recentStore = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(recentStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "quarantined",
        openedAtMsFor: (index) => BASE_OPENED_MS + index * HOUR_MS, // 142 h span < STAGE_SETTLEMENT_MS
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * HOUR_MS,
      });
      expect(142 * HOUR_MS).toBeLessThan(STAGE_SETTLEMENT_MS);
      expect(ctxOf(recentStore).stableProof.frozen).toBe(false);

      // On a population that DOES freeze, both boundaries sit at or behind the horizon, which is
      // computed from the data's own newest origin time and never from the wall clock.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "settled", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      const newestOpenedMs = BASE_OPENED_MS + 142 * 4 * DAY_MS;
      const settledMs = newestOpenedMs - STAGE_SETTLEMENT_MS;
      expect(ctx.stableProof.devEndMs!).toBeLessThanOrEqual(settledMs + 1);
      expect(ctx.stableProof.holdoutEndMs!).toBeLessThanOrEqual(settledMs + 1);
      expect(ctx.promotionProof.devEndMs!).toBeLessThanOrEqual(settledMs + 1);

      // Determinism: the same rows, two fresh stores, two different `capturedAt` values -> identical
      // windows. Nothing in the freeze path reads the clock, so the report is reproducible.
      const buildWith = (prefix: string, capturedAt: string) => {
        const s = new CurrentGuardVariantMatrixStore(tmpDir());
        addResolvedContextCohort(s, {
          variantId: V, direction: "LONG", regime: "Bullish expansion",
          count: 143, netR: provenNetR, prefix, spacingDays: 4,
        });
        return buildCurrentGuardVariantMatrixReport(s, { capturedAt }).rows
          .find((c) => c.variantId === V)!.contextRows!.LONG_BULLISH!;
      };
      const early = buildWith("det-a", "2026-01-01T00:00:00.000Z");
      const late = buildWith("det-b", "2030-12-31T00:00:00.000Z");
      expect(late.stableProof.devEndMs).toBe(early.stableProof.devEndMs);
      expect(late.stableProof.holdoutEndMs).toBe(early.stableProof.holdoutEndMs);
      expect(late.promotionProof.devEndMs).toBe(early.promotionProof.devEndMs);
    });

    it("[STAGE-PERSIST] frozen windows survive a store reload from disk unchanged, and the deleted single-cut key is never written", () => {
      const dir = tmpDir();
      const store = new CurrentGuardVariantMatrixStore(dir);
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "persist", spacingDays: 4,
      });
      const before = ctxOf(store);
      expect(before.stableProof.frozen).toBe(true);
      expect(before.promotionProof.frozen).toBe(true);

      const raw = JSON.parse(readFileSync(join(dir, "current-guard-variant-matrix.json"), "utf8")) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(raw, "stageCuts")).toBe(true);
      // The legacy single-point cut key is gone from disk entirely — it WAS the frozen-at-14
      // artifact, so leaving it behind for something to read later would be a hazard, not a courtesy.
      expect(Object.prototype.hasOwnProperty.call(raw, "developmentHoldoutCuts")).toBe(false);

      const reloaded = new CurrentGuardVariantMatrixStore(dir);
      const after = buildCurrentGuardVariantMatrixReport(reloaded).rows
        .find((c) => c.variantId === V)!.contextRows!.LONG_BULLISH!;
      expect(after.stableProof.devEndMs).toBe(before.stableProof.devEndMs);
      expect(after.stableProof.holdoutEndMs).toBe(before.stableProof.holdoutEndMs);
      expect(after.stableProof.frozenAt).toBe(before.stableProof.frozenAt);
      expect(after.promotionProof.devEndMs).toBe(before.promotionProof.devEndMs);
      expect(after.devN).toBe(before.devN);
      expect(after.holdoutN).toBe(before.holdoutN);
    });

    it("[STAGE-PERSIST-LEGACY] an on-disk stage cut of the wrong schema version is DROPPED and refrozen, not loaded into a window whose semantics nobody can vouch for", () => {
      // `_load` casts the parsed JSON without validation, so an older or hand-edited record can carry
      // exactly the right FIELD NAMES with different meanings. Accepting it would silently score the
      // lane against a window that never passed the freeze search; dropping it fails closed into a
      // clean refreeze, which is the only outcome that needs no trust in the file's provenance.
      const dir = tmpDir();
      const seedStore = new CurrentGuardVariantMatrixStore(dir);
      addResolvedContextCohort(seedStore, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "legacy-cut", spacingDays: 4,
      });
      const file = join(dir, "current-guard-variant-matrix.json");
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      // A structurally VALID record — finite boundaries, a real frozenAt, holdoutEndMs > devEndMs —
      // that differs from the current schema only in its version tag. Its window would be a
      // near-empty holdout, so if it were honoured the lane could never reach STABLE.
      raw.stageCuts = {
        "CG_WIDE_STOP_TP_WIDE::LONG_BULLISH": {
          stable: {
            v: 1,
            devEndMs: BASE_OPENED_MS + DAY_MS,
            holdoutEndMs: BASE_OPENED_MS + DAY_MS + 1,
            frozenAt: "2020-01-01T00:00:00.000Z",
            devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
          },
        },
      };
      writeFileSync(file, JSON.stringify(raw), "utf8");

      const reloaded = new CurrentGuardVariantMatrixStore(dir);
      const ctx = buildCurrentGuardVariantMatrixReport(reloaded).rows
        .find((c) => c.variantId === V)!.contextRows!.LONG_BULLISH!;
      // The bogus window is gone and a correct one froze in its place.
      expect(ctx.stableProof.frozenAt).not.toBe("2020-01-01T00:00:00.000Z");
      expect(ctx.stableProof.devEndMs).not.toBe(BASE_OPENED_MS + DAY_MS);
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[STAGE-EPISODE-ID] a persisted marketEpisodeId is MERGE-ONLY: absent it changes nothing, present it can only LOWER effectiveN, and it can never split one max-hold window into extra draws", () => {
      const build = (prefix: string, opts: Parameters<typeof addResolvedContextCohort>[1]["marketEpisodeIdFor"], spacingDays: number) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        addResolvedContextCohort(store, {
          variantId: V, direction: "LONG", regime: "Bullish expansion",
          count: 30, netR: provenNetR, prefix, spacingDays, marketEpisodeIdFor: opts,
        });
        return ctxOf(store);
      };
      // BASELINE: nothing in the repo writes this field today, so its absence must reproduce pure
      // openedAt chaining byte for byte. 30 rows 4 days apart against a 3-day window = 30 draws.
      expect(build("mid-absent", undefined, 4).effectiveN).toBe(30);
      // MERGE: a persisted id shared across rows the time chain had SEPARATED collapses them. Half
      // the rows (every other one, spread over 116 days) claim one episode -> 1 + 15 = 16.
      expect(build("mid-merge", (i) => (i % 2 === 0 ? "ep-shared" : null), 4).effectiveN).toBe(16);
      // NO SPLIT: 30 rows inside ONE 72 h window, each claiming its OWN persisted episode id. A
      // literal "prefer the persisted id" reading would report 30 independent draws out of a single
      // market look — the exact inflation this whole workstream exists to stop. Merge-only refuses
      // it, so the answer stays 1.
      expect(build("mid-split", (i) => `ep-${i}`, 0.05).effectiveN).toBe(1);
      // Monotonicity, stated directly: supplying MORE identity information can never raise the count.
      expect(build("mid-mono", (i) => `ep-${i}`, 4).effectiveN).toBe(30);
    });

    it("[STAGE-F-CONTEXT-LIMIT] KNOWN LIMITATION, pinned deliberately: an exact-context proof unit can never reach PROMOTION_CANDIDATE, because PROMOTION_MIN_DISTINCT_REGIMES=2 is unsatisfiable inside a single-regime context", () => {
      // This is NOT a defect introduced by the stage model, and it is NOT tuned around here — the
      // operator's spec forbids retuning a promotion gate to make a lane pass. It is pinned so the
      // fact is visible: `exactLaneContextFor` maps each context to exactly ONE regime family
      // (LONG_BULLISH <-> BULLISH), so `distinctRegimes` on a context row is ALWAYS 1 and the
      // >= 2 promotion term can never be true there. A context lane can therefore be fully proven —
      // both windows frozen, both `ok` — and still stop at STABLE_CANDIDATE.
      //
      // It needs an explicit operator decision: either drop the regime term for context rows (the
      // context already pins the regime), or replace it with something meaningful at that
      // granularity. Until then this test documents the ceiling instead of letting it look like a
      // stage-model shortfall.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 200, netR: provenNetR, prefix: "ctx-limit", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      expect(ctx.stableProof.ok).toBe(true);
      expect(ctx.promotionProof.frozen).toBe(true);
      expect(ctx.promotionProof.ok).toBe(true);
      expect(ctx.distinctRegimes).toBe(1);
      const status = deriveVariantStatus(ctx, INFRA_READY);
      expect(status.status).toBe("STABLE_CANDIDATE");
      expect(status.blockers).toContain("distinctRegimes 1 < 2 for promotion");
      // …and the same evidence with the regime term satisfied does promote, which is what proves the
      // regime term is the ONLY thing left blocking it.
      expect(deriveVariantStatus({ ...ctx, distinctRegimes: 2 }, INFRA_READY).status).toBe("PROMOTION_CANDIDATE");
    });

    // =========================================================================================
    // FLOOR-EXACTNESS. Every fixture above spaces rows 4 days apart, which makes each row its own
    // episode and therefore makes the RAW-ROW floors the binding constraint everywhere — so a
    // mutation to any of the four INDEPENDENT-EPISODE floors changed nothing observable. Mutation
    // testing found exactly that: STABLE_MIN_EFFECTIVE_N, STABLE_MIN_HOLDOUT_EFFECTIVE_N,
    // PROMOTION_MIN_EFFECTIVE_N and PROMOTION_MIN_HOLDOUT_EFFECTIVE_N could each be moved +/-1 with
    // the whole suite still green. The episode floors are the entire point of this change, so the
    // cohorts below are shaped so that EPISODES bind and the resulting boundary lands on an exact,
    // asserted number that moves the moment any of those constants does.
    // =========================================================================================
    /** `rowsPerEpisode` rows inside one max-hold window, then a 5-day jump to the next window. */
    const clusteredOpenedAt = (startMs: number, rowsPerEpisode: number, withinGapMs: number) =>
      (index: number): number =>
        startMs + Math.floor(index / rowsPerEpisode) * 5 * DAY_MS + (index % rowsPerEpisode) * withinGapMs;

    it("[STAGE-FLOOR-EPISODES] when episodes are scarcer than rows the INDEPENDENT-EPISODE floors are what decide every boundary — each window stops at exactly its own episode floor, not at its row floor", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // 5 closes per market episode: 30 episodes of 5 rows, each episode's rows 6 h apart inside one
      // 72 h window, consecutive episodes 5 days apart. This is what a real lane looks like — several
      // closes per market look — and it is the shape under which raw rows accumulate ~1000x faster
      // than independent episodes do.
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 150, netR: provenNetR, prefix: "floor-ep",
        openedAtMsFor: clusteredOpenedAt(BASE_OPENED_MS, 5, 6 * HOUR_MS),
        resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);

      // STABLE development: 40 rows arrive after 8 episodes, which is short of the floor, so the
      // window keeps extending — and because boundaries are EPISODE-ALIGNED it does not stop the
      // instant the tenth episode opens (46 rows, one row into episode 10, which used to split that
      // episode across the boundary). It runs to the end of episode 10 and stops where episode 11
      // begins: 50 rows, ten WHOLE episodes.
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_EFFECTIVE_N); // exactly at the episode floor
      expect(ctx.devN).toBe(50); // …and past the row floor, because episodes were the scarce thing
      expect(ctx.devN).toBeGreaterThan(STABLE_MIN_DEV_ROWS);
      expect(ctx.devN % 5).toBe(0); // whole episodes only — 5 closes per episode in this fixture

      // STABLE holdout: five WHOLE episodes, so 25 rows rather than a row-floor-exact 20. Both the
      // episode floor and the resulting row count are asserted so either constant moving is visible.
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.holdoutN).toBe(25);
      expect(ctx.holdoutN).toBeGreaterThan(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutN % 5).toBe(0);

      // PROMOTION development: likewise episode-bound and likewise episode-ALIGNED — 90 rows arrive
      // after 18 episodes, so the window extends through the twentieth WHOLE episode at 100 rows.
      expect(ctx.promotionProof.frozen).toBe(true);
      expect(ctx.promotionDevEffectiveN).toBe(PROMOTION_MIN_EFFECTIVE_N);
      expect(ctx.promotionDevN).toBe(100);
      expect(ctx.promotionDevN).toBeGreaterThan(PROMOTION_MIN_DEV_ROWS);
      // PROMOTION holdout: the open-ended remainder carries exactly the episode floor. One more
      // required episode and no boundary could satisfy both sides, so the window would not freeze —
      // which is the fail-closed behaviour, not a softer one.
      expect(ctx.promotionHoldoutEffectiveN).toBe(PROMOTION_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.promotionHoldoutN).toBe(50);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
      // The identity episode alignment buys: no episode is counted on both sides of either boundary.
      expect(ctx.devEffectiveN + ctx.holdoutEffectiveN).toBe(15);
      expect(ctx.promotionDevEffectiveN + ctx.promotionHoldoutEffectiveN).toBe(30);
    });

    it("[STAGE-FLOOR-HOLDOUT-EPISODES] a holdout keeps extending past its ROW floor until it has enough INDEPENDENT EPISODES — 20 rows are reached long before 5 separate market looks are", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // Two phases: the development region trades 5 closes per episode, the later region trades 10.
      // The holdout therefore reaches STABLE_MIN_HOLDOUT_ROWS(20) while still only 2 episodes deep,
      // and must keep going to 40 rows to reach the fifth WHOLE one.
      const openedAtMsFor = (index: number): number => {
        if (index < 60) return clusteredOpenedAt(BASE_OPENED_MS, 5, 6 * HOUR_MS)(index);
        return clusteredOpenedAt(BASE_OPENED_MS + 60 * DAY_MS, 10, 3 * HOUR_MS)(index - 60);
      };
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 180, netR: provenNetR, prefix: "floor-hold",
        openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.devN).toBe(50);
      // THE ASSERTION THIS FIXTURE EXISTS FOR: the holdout overshoots its row floor precisely because
      // the episode floor had not been met at 20 rows. Rows 50-59 are the 5-per-episode tail (2
      // episodes), then the 10-per-episode phase supplies episodes 3, 4 and 5 at ten rows each — so
      // the fifth WHOLE episode closes at 40 rows, double the row floor.
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.holdoutN).toBe(40);
      expect(ctx.holdoutN).toBeGreaterThan(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.status).toBe("STABLE_CANDIDATE");
    });

    it("[STAGE-FLOOR-PROMOTION-ROWS] PROMOTION's open-ended holdout must still carry its own RAW-ROW floor — a population with exactly PROMOTION_MIN_HOLDOUT_ROWS left after the development boundary freezes, one fewer would not", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      // 130 rows = PROMOTION_MIN_DEV_ROWS(90) + PROMOTION_MIN_HOLDOUT_ROWS(40) exactly. Every row is
      // its own episode at 4-day spacing, so the ROW floors are what bind here — the deliberate
      // mirror image of [STAGE-FLOOR-EPISODES].
      expect(PROMOTION_MIN_DEV_ROWS + PROMOTION_MIN_HOLDOUT_ROWS).toBe(130);
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 130, netR: provenNetR, prefix: "floor-prow", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      expect(ctx.promotionProof.frozen).toBe(true);
      expect(ctx.promotionDevN).toBe(PROMOTION_MIN_DEV_ROWS);
      expect(ctx.promotionHoldoutN).toBe(PROMOTION_MIN_HOLDOUT_ROWS);
      expect(ctx.promotionHoldoutEffectiveN).toBe(PROMOTION_MIN_HOLDOUT_ROWS); // every row its own draw
    });

    // =========================================================================================
    // THE SEAM. Every fixture above pins WHERE a boundary lands; this one pins the property that
    // makes a boundary legitimate at all — that dev and holdout are drawn from DISJOINT market
    // episodes. It is the regression test for a confirmed defect: the boundary search used to stop
    // the instant both floors were met, and whenever the effectiveN floor bound before the row floor
    // (i.e. whenever a lane averages MORE than STABLE_MIN_DEV_ROWS/STABLE_MIN_EFFECTIVE_N = 4.0
    // closes per max-hold window) that instant was the arrival of the FIRST ROW of the Nth episode.
    // A 1-row stub closed development and the REST OF THE SAME 72 h window opened the holdout —
    // one real market episode counted as an independent draw on both sides, which is exactly the
    // effectiveN=1-wearing-N-hats failure the whole stage design exists to stop, reintroduced at the
    // boundary. The file's own doc comment asserted the opposite ("one real episode can no longer be
    // counted once on each side of a boundary") and was false as written.
    //
    // Ground truth here is the FIXTURE, not the implementation: this cohort is built as explicit
    // blocks of `EPISODE_ROWS` rows, so every row's true episode is `floor(index / EPISODE_ROWS)`
    // and can be recovered from its observationId without asking the code under test anything.
    // =========================================================================================
    it("[STAGE-EPISODE-SEAM] a boundary never falls INSIDE a market episode: at 8 closes per max-hold window dev and holdout share ZERO real episodes, and devEffectiveN + holdoutEffectiveN equals the union's episode count exactly", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const EPISODE_ROWS = 8; // > 4.0 closes/window — the density at which the old code split one
      const EPISODES = 18;
      // 8 rows 6 h apart (spanning 42 h, comfortably inside the 72 h max hold ⇒ ONE episode), then a
      // 5-day jump to the next block (> 72 h ⇒ a genuinely new episode).
      const openedAtMsFor = (index: number): number =>
        BASE_OPENED_MS + Math.floor(index / EPISODE_ROWS) * 5 * DAY_MS + (index % EPISODE_ROWS) * 6 * HOUR_MS;
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: EPISODES * EPISODE_ROWS, netR: provenNetR, prefix: "seam",
        openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.stableProof.frozen).toBe(true);

      // The fixture's own episode structure, agreed by the machinery: 18 blocks, 18 draws.
      expect(ctx.effectiveN).toBe(EPISODES);

      // Re-slice the raw rows through the SAME exported membership predicate the report uses, then
      // map every row back to the episode the FIXTURE put it in.
      const rows = store.all.filter((o) => o.variantId === V && o.isFreshValid === true);
      expect(rows.length).toBe(EPISODES * EPISODE_ROWS);
      const cut: VariantMatrixStageCut = {
        v: 2, devEndMs: ctx.stableProof.devEndMs!, holdoutEndMs: ctx.stableProof.holdoutEndMs,
        frozenAt: "", devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
      };
      const slices = stageSlicesForCut(rows, cut);
      const trueEpisodeOf = (observationId: string): number =>
        Math.floor(Number(observationId.replace("seam-", "")) / EPISODE_ROWS);
      const devEpisodes = new Set(slices.dev.map((o) => trueEpisodeOf(o.observationId)));
      const holdoutEpisodes = new Set(slices.holdout.map((o) => trueEpisodeOf(o.observationId)));

      // (1) THE SEAM ASSERTION. Not "the counts look right" — the actual episode-id sets intersect
      //     in nothing. Against the pre-snap code this set is {9}: dev held row 72 (episode 9's
      //     first row) and the holdout held rows 73-79 (the rest of episode 9).
      const shared = [...devEpisodes].filter((e) => holdoutEpisodes.has(e));
      expect(shared).toEqual([]);
      expect(devEpisodes.size).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(holdoutEpisodes.size).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);

      // (2) THE ACCOUNTING IDENTITY. dev+holdout claim exactly as many independent draws as their
      //     union really contains. Pre-snap this read 15 claimed against 14 real — the seam, priced.
      const unionEpisodes = new Set([...devEpisodes, ...holdoutEpisodes]);
      expect(ctx.devEffectiveN + ctx.holdoutEffectiveN).toBe(unionEpisodes.size);
      expect(unionEpisodes.size).toBe(STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);

      // (3) …and both boundaries sit exactly ON an episode's first row, never one row into it.
      expect(ctx.stableProof.devEndMs).toBe(openedAtMsFor(STABLE_MIN_EFFECTIVE_N * EPISODE_ROWS));
      expect(ctx.stableProof.holdoutEndMs).toBe(
        openedAtMsFor((STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N) * EPISODE_ROWS),
      );
      // Whole episodes on both sides — 8 closes each, no stubs.
      expect(ctx.devN).toBe(STABLE_MIN_EFFECTIVE_N * EPISODE_ROWS);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N * EPISODE_ROWS);
    });

    it("[STAGE-EPISODE-SEAM-MERGED] an EPISODE is the merged partition, not the raw time chain: a scanBatchId that fuses two time-separated blocks into one draw also makes the boundary between them illegal, and the window extends past it", () => {
      // The seam test above only exercises the openedAt CHAIN. effectiveN's episodes are the chain
      // PLUS the marketEpisodeId/scanBatchId merges, and a boundary drawn on the raw chain alone
      // would happily cut a merged component in half — half counted in dev, half in the holdout, one
      // real draw scored twice. Mutation-tested: making the edge scan read the raw chain node instead
      // of the union-find root leaves every other test in this file green.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const EPISODE_ROWS = 5;
      const BLOCKS = 19;
      const openedAtMsFor = (index: number): number =>
        BASE_OPENED_MS + Math.floor(index / EPISODE_ROWS) * 5 * DAY_MS + (index % EPISODE_ROWS) * 6 * HOUR_MS;
      // ONE shared scan batch across the block-9/block-10 seam: row 49 is block 9's last close and
      // row 50 is block 10's first, four days apart, so the time chain calls them separate draws and
      // ONLY the batch id reveals they came off one market reading.
      const FUSED = new Set([49, 50]);
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: BLOCKS * EPISODE_ROWS, netR: provenNetR, prefix: "fused",
        openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
        scanBatchIdFor: (index) => (FUSED.has(index) ? "one-scan-cycle" : null),
      });
      const ctx = ctxOf(store);
      expect(ctx.stableProof.frozen).toBe(true);
      // 19 blocks, but blocks 9 and 10 are ONE draw ⇒ 18 independent episodes, not 19.
      expect(ctx.effectiveN).toBe(BLOCKS - 1);

      // The chain-only edge is row 50 (block 10's first close). It is NOT an episode edge here, so
      // development runs on to row 55 — block 11's first close, the next place no draw is split.
      expect(ctx.devN).toBe(55);
      expect(ctx.devN).not.toBe(50); // 50 is what a raw-time-chain edge scan would pick
      expect(ctx.devEffectiveN).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(ctx.stableProof.devEndMs).toBe(openedAtMsFor(55));

      const rows = store.all.filter((o) => o.variantId === V && o.isFreshValid === true);
      const cut: VariantMatrixStageCut = {
        v: 2, devEndMs: ctx.stableProof.devEndMs!, holdoutEndMs: ctx.stableProof.holdoutEndMs,
        frozenAt: "", devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
      };
      const slices = stageSlicesForCut(rows, cut);
      // Ground truth from the fixture: block index, with 10 folded into 9 by the shared batch id.
      const trueEpisodeOf = (observationId: string): number => {
        const block = Math.floor(Number(observationId.replace("fused-", "")) / EPISODE_ROWS);
        return block === 10 ? 9 : block;
      };
      const devEpisodes = new Set(slices.dev.map((o) => trueEpisodeOf(o.observationId)));
      const holdoutEpisodes = new Set(slices.holdout.map((o) => trueEpisodeOf(o.observationId)));
      expect([...devEpisodes].filter((e) => holdoutEpisodes.has(e))).toEqual([]);
      expect(devEpisodes.size).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(holdoutEpisodes.size).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.devEffectiveN + ctx.holdoutEffectiveN).toBe(new Set([...devEpisodes, ...holdoutEpisodes]).size);
    });

    it("[STAGE-BOUNDARY-TIE] rows sharing one openedAt instant are never split by a boundary — episode alignment fixes the boundary VALUE, and the explicit `opensGroup` tie-guard is what still makes the FLOORS bind at the group's first row", () => {
      // The pre-snap search needed a hand-written guard ("only place a boundary after the LAST row of
      // a timestamp group") because it emitted `episodeMs + 1` and would otherwise have swept up
      // whichever tied rows the sort's tiebreak happened to order first. Episode alignment subsumes
      // exactly that much and no more: two rows with the same openedAt always chain into the same
      // node, so an edge is always a component's FIRST instant and the frozen boundary VALUE can no
      // longer depend on the tiebreak.
      //
      // The guard itself is NOT gone, and an earlier version of this comment claiming it was is the
      // reason the claim is now stated with its evidence. `smallestPrefixBoundary` still carries an
      // explicit `opensGroup` term and it is load-bearing: an edge is a TIMESTAMP while a floor is
      // checked at a row INDEX, and inside a tie group the two disagree everywhere except the first
      // index. Mutation-tested — deleting `opensGroup` leaves the whole api suite green EXCEPT this
      // test (it froze STABLE at devEffectiveN 9 against a floor of 10), which is why the property is
      // pinned here rather than argued in a comment.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const TIED = 6; // six closes fired off ONE scan instant, per market episode
      const BLOCKS = 19;
      const openedAtMsFor = (index: number): number => BASE_OPENED_MS + Math.floor(index / TIED) * 5 * DAY_MS;
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: BLOCKS * TIED, netR: provenNetR, prefix: "tied",
        openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.stableProof.frozen).toBe(true);
      expect(ctx.effectiveN).toBe(BLOCKS); // one instant per block ⇒ one draw per block

      const rows = store.all.filter((o) => o.variantId === V && o.isFreshValid === true);
      const cut: VariantMatrixStageCut = {
        v: 2, devEndMs: ctx.stableProof.devEndMs!, holdoutEndMs: ctx.stableProof.holdoutEndMs,
        frozenAt: "", devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
      };
      const slices = stageSlicesForCut(rows, cut);
      const instantsOf = (side: typeof slices.dev) => new Set(side.map((o) => new Date(o.openedAt!).getTime()));
      const devInstants = instantsOf(slices.dev);
      const holdoutInstants = instantsOf(slices.holdout);
      // No instant appears on both sides — i.e. no timestamp group was cut in half.
      expect([...devInstants].filter((t) => holdoutInstants.has(t))).toEqual([]);
      // Every side is a whole number of 6-row groups, and the counts are the episode floors x 6.
      expect(ctx.devN).toBe(STABLE_MIN_EFFECTIVE_N * TIED);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N * TIED);
      expect(devInstants.size).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(holdoutInstants.size).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      // The boundary IS an instant, and `< b` puts the whole group that carries it in the holdout.
      expect(ctx.stableProof.devEndMs).toBe(openedAtMsFor(STABLE_MIN_EFFECTIVE_N * TIED));
      expect(devInstants.has(ctx.stableProof.devEndMs!)).toBe(false);
      expect(holdoutInstants.has(ctx.stableProof.devEndMs!)).toBe(true);
    });

    // =========================================================================================
    // REACHABILITY. The day counts in the source comment block are now EXECUTABLE. Episode
    // alignment made every BOUNDED window wait for its closing episode, so a stage costs E*W rather
    // than (E-1)*W per bounded boundary — STABLE went 46 -> 52 d at W=72h and PROMOTION's dev side
    // absorbed one more window. Pinning it here is what stops the comment drifting back to the
    // pre-snap arithmetic, and the `- 1 ms` half of each pair is what proves the bound is TIGHT
    // rather than merely sufficient.
    // =========================================================================================
    it("[STAGE-REACHABILITY] the published minimum calendar spans are exact: STABLE at (10+5)*W + settlement and PROMOTION at max(29*W, 20*W + settlement), and one millisecond less freezes nothing", () => {
      const EPISODE_ROWS = 5;
      // `episodes` whole episodes exactly W apart, plus ONE trailing row at `spanMs` which is the
      // newest row and therefore sets the settlement horizon by itself.
      const build = (
        variantId: VariantMatrixVariantDefinition["id"],
        widthMs: number,
        episodes: number,
        spanMs: number,
        prefix: string,
      ) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        const bodyRows = episodes * EPISODE_ROWS;
        addResolvedContextCohort(store, {
          variantId, direction: "LONG", regime: "Bullish expansion",
          count: bodyRows + 1, netR: provenNetR, prefix,
          openedAtMsFor: (index) =>
            index < bodyRows
              ? BASE_OPENED_MS + Math.floor(index / EPISODE_ROWS) * widthMs + (index % EPISODE_ROWS) * (widthMs / 10)
              : BASE_OPENED_MS + spanMs,
          resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
        });
        return buildCurrentGuardVariantMatrixReport(store).rows.find((c) => c.variantId === variantId)!
          .contextRows!.LONG_BULLISH!;
      };
      const families: Array<[VariantMatrixVariantDefinition["id"], number, number, number]> = [
        // variantId, max-hold hours, published days->STABLE, published days->PROMOTION
        ["CG_WIDE_STOP_TP_WIDE", 72, 52, 87],
        ["CG_EXP_LONG_WIDE_FAST_10X", 24, 22, 29],
        ["CG_WIDE_LONG_RUNNER", 144, 97, 174],
      ];
      for (const [variantId, hours, publishedStableDays, publishedPromotionDays] of families) {
        const W = hours * HOUR_MS;
        // STABLE: both boundaries are BOUNDED, so both wait for a closing episode — dev ends where
        // episode 11 opens (10*W) and the holdout where episode 16 opens (15*W). The quarantine then
        // requires the newest row to sit STAGE_SETTLEMENT_MS past that.
        const stableSpan = (STABLE_MIN_EFFECTIVE_N + STABLE_MIN_HOLDOUT_EFFECTIVE_N) * W + STAGE_SETTLEMENT_MS;
        expect(Math.round((stableSpan / DAY_MS) * 100) / 100).toBeCloseTo(publishedStableDays, 0);
        expect(build(variantId, W, 16, stableSpan - 1, `reach-s-lo-${variantId}`).stableProof.frozen).toBe(false);
        const stableOk = build(variantId, W, 16, stableSpan, `reach-s-hi-${variantId}`);
        expect(stableOk.stableProof.frozen).toBe(true);
        expect(stableOk.devEffectiveN).toBe(STABLE_MIN_EFFECTIVE_N);
        expect(stableOk.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);

        // PROMOTION: its dev boundary is bounded (20*W, since 20 > 10+5 the STABLE window is not what
        // binds) but its holdout is OPEN-ENDED and so needs no closing episode — (10-1)*W past the
        // boundary. The quarantine is not binding at any of these widths.
        const promotionSpan = Math.max(
          (PROMOTION_MIN_EFFECTIVE_N + PROMOTION_MIN_HOLDOUT_EFFECTIVE_N - 1) * W,
          PROMOTION_MIN_EFFECTIVE_N * W + STAGE_SETTLEMENT_MS,
        );
        expect(Math.round((promotionSpan / DAY_MS) * 100) / 100).toBeCloseTo(publishedPromotionDays, 0);
        expect(build(variantId, W, 29, promotionSpan - 1, `reach-p-lo-${variantId}`).promotionProof.frozen).toBe(false);
        const promotionOk = build(variantId, W, 29, promotionSpan, `reach-p-hi-${variantId}`);
        expect(promotionOk.promotionProof.frozen).toBe(true);
        expect(promotionOk.promotionDevEffectiveN).toBe(PROMOTION_MIN_EFFECTIVE_N);
        expect(promotionOk.promotionHoldoutEffectiveN).toBe(PROMOTION_MIN_HOLDOUT_EFFECTIVE_N);
      }
    });

    it("[STAGE-QUARANTINE-BINDS] the settlement quarantine is load-bearing: 62 rows cannot freeze a window whose holdout would have to reach into unsettled evidence, and 63 rows can", () => {
      const build = (count: number, prefix: string) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        addResolvedContextCohort(store, {
          variantId: V, direction: "LONG", regime: "Bullish expansion",
          count, netR: provenNetR, prefix, spacingDays: 4,
        });
        return ctxOf(store);
      };
      // 4-day spacing at W=72h makes every row its own episode, so the row floors bind and the two
      // boundaries want to sit at row 40 (dev = 40 rows / 40 episodes) and row 60 (holdout = 20 rows
      // / 20 episodes). Both are episode edges here — every row is an episode — so the ONLY thing
      // left to satisfy is the quarantine: the row carrying the holdout boundary opens at day 240,
      // and STAGE_SETTLEMENT_MS (7.0035 d) requires the newest row to be at least that much later,
      // i.e. day >= 247.0035, i.e. row index >= 61.75, i.e. 63 rows. At 62 rows the newest row opens
      // on day 244 and the boundary would sit on evidence whose positions may not have terminated —
      // a later close could then land BEHIND an already-frozen boundary.
      const short = build(62, "quar-62");
      expect(short.freshValid).toBe(62);
      expect(short.freshValid).toBeGreaterThanOrEqual(STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS);
      expect(short.stableProof.frozen).toBe(false);
      expect(short.devN).toBe(0);

      // One more row of settled evidence and the identical window becomes placeable.
      const ok = build(63, "quar-63");
      expect(ok.stableProof.frozen).toBe(true);
      expect(ok.devN).toBe(STABLE_MIN_DEV_ROWS);
      expect(ok.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
    });

    it("[STAGE-I-ORDERING] PROMOTION's boundary is FORCED to at-or-after STABLE's holdout end even when its own floors were satisfied much earlier — without that constraint the two holdouts would genuinely overlap", () => {
      // The fixture that makes the constraint BINDING. A long, episode-poor middle section drags
      // STABLE's holdout all the way to row 120 before it has 5 independent episodes, while
      // PROMOTION's development floors (90 rows / 20 episodes) are already satisfied at row 89. The
      // smallest boundary PROMOTION would pick on its own merits is therefore INSIDE STABLE's
      // holdout; only `p >= stable.holdoutEndMs` stops it re-scoring evidence STABLE already used as
      // its out-of-sample proof.
      const openedAtMsFor = (index: number): number => {
        if (index < 40) return BASE_OPENED_MS + index * 4 * DAY_MS;
        if (index < 140) {
          const group = Math.floor((index - 40) / 20);
          return BASE_OPENED_MS + 160 * DAY_MS + group * 5 * DAY_MS + ((index - 40) % 20) * 3 * HOUR_MS;
        }
        return BASE_OPENED_MS + 190 * DAY_MS + (index - 140) * 4 * DAY_MS;
      };
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 200, netR: provenNetR, prefix: "ordering",
        openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
      });
      const ctx = ctxOf(store);
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS);
      // STABLE's holdout had to swallow 100 rows to find its five independent looks — five WHOLE
      // 20-row bursts, because the boundary is episode-aligned and cannot stop one row into the
      // fifth burst the way it used to (81 rows).
      expect(ctx.holdoutN).toBe(100);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(ctx.promotionProof.frozen).toBe(true);
      // PROMOTION's development side is far past its own floors AT the forced boundary, which is the
      // signature of the constraint binding: it did not stop as soon as it could have.
      expect(ctx.promotionDevN).toBe(140);
      expect(ctx.promotionDevN).toBeGreaterThan(PROMOTION_MIN_DEV_ROWS);
      expect(ctx.promotionProof.devEndMs).toBe(ctx.stableProof.holdoutEndMs);

      // …and the holdout cohorts are consequently disjoint, computed as id sets, not inferred.
      const rows = store.all.filter((o) => o.variantId === V && o.isFreshValid === true);
      const cutOf = (devEndMs: number, holdoutEndMs: number | null): VariantMatrixStageCut => ({
        v: 2, devEndMs, holdoutEndMs, frozenAt: "",
        devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
      });
      const stableHoldoutIds = new Set(
        stageSlicesForCut(rows, cutOf(ctx.stableProof.devEndMs!, ctx.stableProof.holdoutEndMs))
          .holdout.map((o) => o.observationId),
      );
      const promotionHoldoutIds = new Set(
        stageSlicesForCut(rows, cutOf(ctx.promotionProof.devEndMs!, ctx.promotionProof.holdoutEndMs))
          .holdout.map((o) => o.observationId),
      );
      expect([...stableHoldoutIds].filter((id) => promotionHoldoutIds.has(id))).toEqual([]);
    });

    it("[STAGE-HEADLINE-TERMS] the stage proof ADDS an out-of-sample requirement, it does not REPLACE the live one — a lane whose FULL record has a negative OOS third or a decayed net cannot be STABLE on the strength of a frozen window", () => {
      // Both stage proofs pass outright, so the only thing varied is a headline term computed over
      // the full, live fresh population. This is the real-money hazard the stage model must not
      // create: the frozen development window can be a lane's first 40 closes from a year ago, and
      // STABLE_CANDIDATE is the live eligibility gate.
      const base = {
        variantId: "CG_WIDE_FAST_SHORT", label: "x", exitRule: "tp1_full", fillMode: "taker", costModel: "taker",
        total: 300, open: 0, resolved: 300, freshValid: 300, effectiveN: 60, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
        netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
        payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
        noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
        topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
        calendarDays: 40, distinctRegimes: 3, distinctSymbolCount: 5, byRegime: [], byEntryVariant: [], oosThirds: null,
        allThreeOosPositive: true, rolling: [],
        stableProof: makeStageProof("stable"),
        promotionProof: makeStageProof("promotion"),
      } as Parameters<typeof deriveVariantStatus>[0];
      const infra = { killSwitchReady: false, orderReconciliationReady: false, exchangeHealthReady: false };
      // Positive control.
      expect(deriveVariantStatus(base, infra).status).toBe("STABLE_CANDIDATE");

      // (1) A negative out-of-sample third anywhere in the live record.
      const oos = deriveVariantStatus({ ...base, allThreeOosPositive: false }, infra);
      expect(oos.status).toBe("WATCHABLE");
      expect(oos.blockers).toContain("OOS thirds not all positive (full fresh population)");

      // (2) A net that has decayed to positive-but-not-strong. `net > 0` still clears WATCHABLE, so
      // without the headline NET_STRONG_R term this lane would read STABLE on a frozen window's
      // long-past economics.
      const decayed = deriveVariantStatus({ ...base, netAvgR: NET_STRONG_R / 2 }, infra);
      expect(decayed.status).toBe("WATCHABLE");
      expect(decayed.blockers).toContain(
        `netAvgR ${(NET_STRONG_R / 2).toFixed(3)} <= ${NET_STRONG_R} (full fresh population)`,
      );

      // (3) Drawdown past the scaled cap on the live record — the term [DDBLK] pins from the other
      // direction, repeated here so all three headline terms are covered by one isolated triple.
      const drawdown = deriveVariantStatus({ ...base, approxMaxDrawdownR: 500 }, infra);
      expect(drawdown.status).toBe("WATCHABLE");
      expect(drawdown.blockers.some((b) => b.includes("(full fresh population)") && b.startsWith("drawdown"))).toBe(true);
    });

    it("[STAGE-DEV-NET-ONLY] a development window that fails exactly ONE term fails the whole stage — the verdict is never blended with the holdout's, however good the holdout is", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143,
        // Development window (rows 0..39): +0.05 / -0.1 — PF 2, payoff 0.5, all three dev OOS thirds
        // positive, drawdown tiny. EVERY development term passes except netAvgR, which lands at 0.020
        // against the NET_STRONG_R floor of 0.05. Everything from row 40 on is the proven +2R shape,
        // so the holdout passes all five of its terms and the headline is comfortably WATCHABLE.
        netR: (index) =>
          index < STABLE_MIN_DEV_ROWS ? (index % 5 === 0 ? -0.1 : 0.05) : index % 5 === 0 ? -0.5 : 2,
        prefix: "dev-net-only", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      expect(ctx.holdoutSufficient).toBe(true);
      expect(ctx.holdoutNetAvgR).toBeGreaterThan(0);
      expect(ctx.stableProof.dev.pf!).toBeGreaterThan(1.2);
      expect(ctx.stableProof.dev.allThreeOosPositive).toBe(true);
      // The blocker list is asserted WHOLE: exactly one term failed, and a stage `ok` that ORed the
      // holdout in anywhere would let this through.
      expect(ctx.stableProof.blockers).toEqual([`STABLE dev netAvgR 0.020 <= ${NET_STRONG_R}`]);
      expect(ctx.stableProof.ok).toBe(false);
      expect(ctx.status).toBe("WATCHABLE");
    });

    it("[STAGE-HOLDOUT-PF-UNDEFINED] a holdout of nothing but winners has an UNDEFINED profit factor and is rejected fail-closed — an absent economic reading must never authorise a stage", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143,
        // The STABLE holdout window (rows 40..59) contains no losing close at all, so its profit
        // factor is not computable (no denominator). Its MEAN is present and positive, so this
        // isolates the PF term from the net term — the two are otherwise co-extensive on real data
        // (netAvgR < 0 if and only if PF < 1).
        netR: (index) => (index >= STABLE_MIN_DEV_ROWS && index < 60 ? 1 : provenNetR(index)),
        prefix: "pf-undefined", spacingDays: 4,
      });
      const ctx = ctxOf(store);
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutEffectiveN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.holdoutNetAvgR).toBe(1); // present and positive
      expect(ctx.holdoutStressNetAvgR).not.toBeNull();
      expect(ctx.holdoutPf).toBeNull(); // …but PF is not computable
      expect(ctx.holdoutSufficient).toBe(false);
      expect(ctx.stableProof.blockers).toEqual([`STABLE holdout PF n/a — must be present and >= ${PF_FLOOR}`]);
      expect(ctx.status).toBe("WATCHABLE");
    });

    it("[STAGE-CORRUPT-CUT] a window that arrives from disk without having passed the freeze search is re-checked in full, and an existing window is never overwritten", () => {
      // WHY THIS PATH EXISTS. The freeze search enforces the four SIZE floors, so a window produced
      // by it always satisfies them — which makes the same floors inside the proof look redundant.
      // They are not: `freezeStageCutIfAbsent` is a public store method and `stageCuts` is loaded
      // from a JSON file that a reset script, a migration or a hand edit can write. A window that
      // never passed the search must not be trusted, so the proof re-derives every term.
      const KEY = "CG_WIDE_STOP_TP_WIDE::LONG_BULLISH";
      const CLUSTER_START = BASE_OPENED_MS + 200 * DAY_MS;
      const TAIL_START = BASE_OPENED_MS + 300 * DAY_MS;
      const openedAtMsFor = (index: number): number => {
        if (index < 40) return BASE_OPENED_MS + index * 4 * DAY_MS;
        if (index < 80) return CLUSTER_START + (index - 40) * HOUR_MS; // 40 rows inside one 72h window
        return TAIL_START + (index - 80) * 4 * DAY_MS;
      };
      const seed = (holdoutEndMs: number, prefix: string) => {
        const store = new CurrentGuardVariantMatrixStore(tmpDir());
        store.freezeStageCutIfAbsent(KEY, "stable", {
          v: 2, devEndMs: CLUSTER_START, holdoutEndMs, frozenAt: "2026-01-01T00:00:00.000Z",
          devRowsAtFreeze: 0, devEffectiveNAtFreeze: 0, holdoutRowsAtFreeze: 0, holdoutEffectiveNAtFreeze: 0,
        });
        addResolvedContextCohort(store, {
          variantId: V, direction: "LONG", regime: "Bullish expansion",
          count: 143, netR: provenNetR, prefix,
          openedAtMsFor, resolvedAtMsFor: (index) => BASE_RESOLVED_MS + index * DAY_MS,
        });
        return { store, ctx: ctxOf(store) };
      };

      // (1) A window whose holdout is 40 rows — twice the row floor, profitable, five symbols, every
      // row stressable — but ONE independent market episode. Only the episode term can fail here, so
      // it is isolated.
      const { ctx: oneEpisode } = seed(TAIL_START, "corrupt-ep");
      expect(oneEpisode.stableProof.frozen).toBe(true);
      expect(oneEpisode.holdoutN).toBe(40);
      expect(oneEpisode.holdoutN).toBeGreaterThanOrEqual(STABLE_MIN_HOLDOUT_ROWS);
      expect(oneEpisode.stableProof.holdout.stressableRows).toBe(40);
      expect(oneEpisode.holdoutDistinctSymbolCount).toBeGreaterThanOrEqual(STABLE_MIN_DISTINCT_SYMBOLS);
      expect(oneEpisode.holdoutNetAvgR).toBeGreaterThan(0);
      expect(oneEpisode.holdoutEffectiveN).toBe(1);
      expect(oneEpisode.holdoutSufficient).toBe(false);
      expect(oneEpisode.stableProof.blockers).toEqual([
        `STABLE holdout effectiveN 1 < ${STABLE_MIN_HOLDOUT_EFFECTIVE_N} independent episodes`,
      ]);
      expect(oneEpisode.status).toBe("WATCHABLE");

      // (2) A window narrow enough that the holdout is BELOW the row floor. Both size terms are
      // named separately, so an operator can tell "not enough closes" from "the stress figure is not
      // computable on enough of them" — they are different waits with different fixes.
      const { ctx: tooNarrow } = seed(CLUSTER_START + 10 * HOUR_MS, "corrupt-rows");
      expect(tooNarrow.holdoutN).toBe(10);
      expect(tooNarrow.holdoutSufficient).toBe(false);
      expect(tooNarrow.stableProof.blockers).toContain(`STABLE holdout rows 10 < ${STABLE_MIN_HOLDOUT_ROWS}`);
      expect(tooNarrow.stableProof.blockers).toContain(
        `STABLE holdout effectiveN 1 < ${STABLE_MIN_HOLDOUT_EFFECTIVE_N} independent episodes`,
      );
      expect(tooNarrow.stableProof.blockers).toContain(
        `STABLE holdout stressableRows 10 < ${STABLE_MIN_HOLDOUT_ROWS} ` +
          "(rows missing grossR/stopDistanceBps — stress economics not computable)",
      );

      // (3) ADD-ONLY, asserted directly on the store rather than inferred from a report. The report
      // path never re-attempts a frozen stage, so the store's own guard is the last line of defence
      // against a "refresh" that would let newer, possibly cherry-picked data redraw a boundary.
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      const first = {
        v: 2 as const, devEndMs: 1_000, holdoutEndMs: 2_000, frozenAt: "first",
        devRowsAtFreeze: 1, devEffectiveNAtFreeze: 1, holdoutRowsAtFreeze: 1, holdoutEffectiveNAtFreeze: 1,
      };
      store.freezeStageCutIfAbsent(KEY, "stable", first);
      store.freezeStageCutIfAbsent(KEY, "stable", { ...first, devEndMs: 9_999, holdoutEndMs: 99_999, frozenAt: "second" });
      expect(store.getStageCuts(KEY).stable).toEqual(first);
      // …and the returned record is a frozen clone, so a reader cannot edit an "immutable" boundary.
      expect(Object.isFrozen(store.getStageCuts(KEY).stable)).toBe(true);
    });

    it("[STAGE-UNDATED-MIX] rows with an unparseable origin time belong to NEITHER side of a frozen window — they are counted in the population and excluded from every proof slice", () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: V, direction: "LONG", regime: "Bullish expansion",
        count: 143, netR: provenNetR, prefix: "mix-dated", spacingDays: 4,
      });
      // Ten otherwise-perfect rows whose openedAt will not parse. Sweeping them into development
      // would inflate a frozen window with evidence that cannot be placed in time at all.
      const undated = Array.from({ length: 10 }, (_, index) => {
        const base = buildVariantMatrixObservationsForSignal(makeSignal({
          sourceSignalId: `mix-undated-${index}`,
          symbol: `CTX${index % 5}USDT`,
          direction: "LONG",
          regime: "Bullish expansion",
          posture: "TACTICAL",
          regimeDirection: "LONG",
        })).find((candidate) => candidate.variantId === V)!;
        return {
          ...base,
          observationId: `mix-undated-${index}`,
          sourceObservationKey: `mix-undated-${index}`,
          openedAt: "not-a-timestamp",
          status: "CLOSED_WIN" as const,
          grossR: 1.12,
          netR: 1,
          costR: 0.12,
          isFreshValid: true,
          resolvedAt: new Date(BASE_RESOLVED_MS + index * DAY_MS).toISOString(),
        };
      });
      store.addMany(undated);
      const ctx = ctxOf(store);
      expect(ctx.freshValid).toBe(153); // counted in the live population…
      expect(ctx.devN).toBe(STABLE_MIN_DEV_ROWS); // …and in neither frozen slice
      expect(ctx.holdoutN).toBe(STABLE_MIN_HOLDOUT_ROWS);
      expect(ctx.stableProof.dev.rows + ctx.stableProof.holdout.rows).toBe(
        STABLE_MIN_DEV_ROWS + STABLE_MIN_HOLDOUT_ROWS,
      );
    });
  });

  // 10. shadow-positions.json is never touched.
  it("[10] writes only current-guard-variant-matrix.json, never shadow-positions.json", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    mirrorVariantMatrixSignals([makeSignal()], store, "2026-05-20T00:00:00.000Z");
    await resolveVariantMatrixObservations(store, winningBinance());
    expect(store.path.endsWith("current-guard-variant-matrix.json")).toBe(true);
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
  });

  // [RESLV] Regression: the expiry backlog must NOT starve resolvable obs behind it.
  // Previously the resolver expired stale obs INSIDE the budgeted loop, so a front-loaded
  // backlog consumed every run's budget and nothing ever closed. Phase 1 now bulk-expires
  // stale obs for free, leaving the fetch budget for real resolution.
  it("[RESLV] drains the stale backlog AND resolves a young obs behind it under a tiny budget", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const staleIso = new Date(Date.now() - 40 * 86400000).toISOString(); // >7d → must expire
    const youngIso = new Date(Date.now() - 1 * 86400000).toISOString(); //  <7d → resolvable
    // 5 stale signals mirrored FIRST → their obs sit at the FRONT of the store.
    const stale = Array.from({ length: 5 }, (_, i) =>
      makeSignal({ sourceSignalId: `stale-${i}`, symbol: `STALE${i}USDT`, openedAt: staleIso }),
    );
    mirrorVariantMatrixSignals(stale, store, staleIso);
    // 1 young, resolvable signal mirrored AFTER → its obs sit BEHIND the backlog.
    mirrorVariantMatrixSignals(
      [makeSignal({ sourceSignalId: "young", symbol: "YOUNGUSDT", openedAt: youngIso })],
      store,
      youngIso,
    );
    const staleOpenBefore = store.all.filter((o) => o.status === "OPEN" && o.openedAt === staleIso).length;
    expect(staleOpenBefore).toBeGreaterThan(10);

    // Window-aware mock: clean TP at each obs's own signal candle (startTime + CANDLE_MS).
    const mock = {
      getKlines: async (
        _s: string,
        interval: string,
        o: { startTime: number; endTime: number; limit: number },
      ): Promise<KlineTuple[]> => {
        if (interval === "1m") return [];
        const open = o.startTime + 300000;
        return [
          candle(o.startTime, 100.2, 99.9, 100),
          candle(open, 104.5, 100.1, 104), // TP (T=104), no SL
          candle(open + 300000, 105, 103, 104.5),
        ];
      },
    };
    // Tiny budget: under the OLD code these 3 slots would be eaten by the front backlog and the
    // young obs would never resolve. Phase 1 frees the budget for real work.
    const r = await resolveVariantMatrixObservations(store, mock, { maxObservations: 3 });

    // Whole backlog expired in this one run (cheap bulk sweep, not budget-limited)…
    expect(store.all.filter((o) => o.status === "OPEN" && o.openedAt === staleIso).length).toBe(0);
    expect(r.expired).toBe(staleOpenBefore);
    // …AND the young obs actually closed despite sitting behind the backlog.
    const closed = store.all.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS");
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed.every((o) => o.openedAt === youngIso)).toBe(true);
  });

  it("[RESLV-MAXHOLD] closes >72h unresolved VM observations via MAX_HOLD_MTM instead of waiting for expiry", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const oldIso = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    mirrorVariantMatrixSignals([makeSignal({ sourceSignalId: "old-open", openedAt: oldIso })], store, oldIso);

    const mock = {
      getKlines: async (
        _s: string,
        interval: string,
        o: { startTime: number; endTime: number; limit: number },
      ): Promise<KlineTuple[]> => {
        if (interval === "1m") return [];
        const open = o.startTime + 300000;
        return [
          candle(o.startTime, 100.2, 99.8, 100),
          candle(open, 101, 99, 100.5),
          candle(open + 300000, 101.5, 99.5, 101),
        ];
      },
    };

    await resolveVariantMatrixObservations(store, mock, { maxObservations: 1 });
    const baseline = store.all.find((o) => o.variantId === BASELINE_VARIANT_ID);
    expect(baseline?.status).toBe("CLOSED_WIN");
    expect(baseline?.resolutionSource).toBe("MAX_HOLD_MTM");
    expect(baseline?.grossR).toBeCloseTo(0.5, 6);
  });

  it("[RESLV-MAXHOLD-PRIORITY] spends tiny budgets on max-hold observations before young backlog", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const oldIso = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const youngIso = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    mirrorVariantMatrixSignals(
      [makeSignal({ sourceSignalId: "old-priority", openedAt: oldIso })],
      store,
      oldIso,
    );
    mirrorVariantMatrixSignals(
      [makeSignal({ sourceSignalId: "young-priority", symbol: "YOUNGUSDT", openedAt: youngIso })],
      store,
      youngIso,
    );

    const mock = {
      getKlines: async (
        _s: string,
        interval: string,
        o: { startTime: number; endTime: number; limit: number },
      ): Promise<KlineTuple[]> => {
        if (interval === "1m") return [];
        const open = o.startTime + 300000;
        return [
          candle(o.startTime, 100.2, 99.8, 100),
          candle(open, 101, 99, 100.5),
          candle(open + 300000, 101.5, 99.5, 101),
        ];
      },
    };

    await resolveVariantMatrixObservations(store, mock, { maxObservations: 3 });
    const closed = store.all.filter((o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS");
    expect(closed.length).toBe(3);
    expect(closed.every((o) => o.openedAt === oldIso)).toBe(true);
  });

  // Bonus: selection filter (uses the documented ShadowPosition shape).
  it("selectVariantMatrixSignals keeps only stop175 + V2 closed-filled positions", () => {
    const ok = {
      id: "p1",
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      tp1: 104,
      tp2: null,
      tp3: null,
      stopDistanceBps: 200,
      policyVersion: "base-route-anchor-consistent-v2",
      riskHygieneGuardMinStopDistanceBps: 175,
      marketRegime: "BULLISH_EXPANSION",
      selectedEntryVariant: "base_current_entry",
      scannedAt: "2026-05-20T00:00:00.000Z",
      variants: [
        {
          state: "CLOSED",
          closeReason: "TP1",
          realizedGrossR: 0.5,
          realizedNetR: 0.4,
          openedAt: "2026-05-20T00:00:00.000Z",
          closedAt: "2026-05-20T00:30:00.000Z",
        },
      ],
    } as unknown as ShadowPosition;

    const wrongPolicy = { ...ok, id: "p2", policyVersion: "legacy-v1" } as unknown as ShadowPosition;
    const wrongStop = {
      ...ok,
      id: "p3",
      riskHygieneGuardMinStopDistanceBps: 150,
    } as unknown as ShadowPosition;

    const selected = selectVariantMatrixSignals([ok, wrongPolicy, wrongStop]);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.sourceSignalId).toBe("p1");
    expect(selected[0]!.entryPrice).toBe(100);
  });

  // Bonus: singleton reset works (documented helper coverage).
  it("singleton store is resettable", () => {
    const dir = tmpDir();
    const a = getCurrentGuardVariantMatrixStore(dir);
    const b = getCurrentGuardVariantMatrixStore(dir);
    expect(a).toBe(b);
    _resetCurrentGuardVariantMatrixStoreForTests();
    const c = getCurrentGuardVariantMatrixStore(dir);
    expect(c).not.toBe(a);
  });

  // ── Phase 3: stale-OPEN / resolver-ordering / diagnostics ──────────────────

  // [11] OPEN observation older than EXPIRY_MS is marked EXPIRED without calling candle fetch.
  it("[11] OPEN observation older than EXPIRY_MS is marked EXPIRED without calling candle fetch", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    // openedAt = 8 days ago, comfortably past the 7-day expiry window.
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const signal = makeSignal({ openedAt: new Date(oldMs).toISOString() });
    // Inject the aged obs directly (the mirror gate now skips born-stale signals at the source);
    // this simulates an obs created fresh that has since aged past EXPIRY — the case the Phase-1
    // sweep must still handle.
    store.addMany(buildVariantMatrixObservationsForSignal(signal));

    let klineCallCount = 0;
    const trackingBinance = {
      getKlines: async (): Promise<KlineTuple[]> => {
        klineCallCount += 1;
        return [];
      },
    };
    const result = await resolveVariantMatrixObservations(store, trackingBinance);

    // All OPEN observations must have been marked EXPIRED.
    const remaining = store.all.filter((o) => o.status === "OPEN");
    const expired = store.all.filter((o) => o.status === "EXPIRED");
    expect(expired.length).toBeGreaterThan(0);
    expect(remaining.length).toBe(0);
    // The expiry gate fires BEFORE the candle fetch — getKlines must not be called.
    expect(klineCallCount).toBe(0);
    // Return value must reflect the expired count.
    expect(result.expired).toBeGreaterThan(0);
    expect(result.resolved).toBe(result.expired); // expired are counted as resolved
  });

  // [12] Throwing candle fetch does not prevent expiry for old obs; fresh obs stays OPEN for retry.
  it("[12] throwing candle fetch: old obs expires, fresh obs stays OPEN for retry", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    // Old signal: 8 days ago (past expiry).
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldSignal = makeSignal({ sourceSignalId: "old-sig", openedAt: new Date(oldMs).toISOString() });
    // Fresh signal: 1 hour ago (well within expiry, will reach candle fetch).
    const freshMs = Date.now() - 60 * 60 * 1000;
    const freshSignal = makeSignal({
      sourceSignalId: "fresh-sig",
      symbol: "BTCUSDT",
      openedAt: new Date(freshMs).toISOString(),
    });
    // Old obs injected directly (mirror gate skips born-stale at the source); simulates an obs that
    // aged past EXPIRY while OPEN. Fresh obs goes through the normal mirror path (passes the gate).
    store.addMany(buildVariantMatrixObservationsForSignal(oldSignal));
    mirrorVariantMatrixSignals([freshSignal], store, new Date().toISOString());

    const throwingBinance = {
      getKlines: async (): Promise<KlineTuple[]> => {
        throw new Error("simulated network error");
      },
    };
    // Resolver must not propagate the error.
    const result = await resolveVariantMatrixObservations(store, throwingBinance);

    // Old obs: must be EXPIRED (expiry fires before candle fetch; throw is irrelevant).
    const expiredOld = store.all.filter((o) => o.status === "EXPIRED" && o.sourceSignalId === "old-sig");
    expect(expiredOld.length).toBeGreaterThan(0);
    // Fresh obs: must remain OPEN (throw → retry later; must not be permanently DATA_FAILURE).
    const openFresh = store.all.filter((o) => o.status === "OPEN" && o.sourceSignalId === "fresh-sig");
    expect(openFresh.length).toBeGreaterThan(0);
    // Both code paths must be reflected in the counters.
    expect(result.expired).toBeGreaterThan(0);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.dataFailures).toBeGreaterThan(0);
  });

  // [13] Non-expired candle fetch failure leaves obs OPEN; resolver returns without throwing.
  it("[13] non-expired candle-fetch failure does not crash resolver; obs stays OPEN", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    // Signal opened 1 hour ago — well within the 7-day expiry window.
    const freshMs = Date.now() - 60 * 60 * 1000;
    const signal = makeSignal({ openedAt: new Date(freshMs).toISOString() });
    mirrorVariantMatrixSignals([signal], store, new Date().toISOString());

    const throwingBinance = {
      getKlines: async (): Promise<KlineTuple[]> => {
        throw new Error("transient candle-fetch failure");
      },
    };
    // Resolver must not throw.
    const result = await resolveVariantMatrixObservations(store, throwingBinance);

    // All observations must remain OPEN for retry.
    const openObs = store.all.filter((o) => o.status === "OPEN");
    expect(openObs.length).toBeGreaterThan(0);
    // No observation must have been promoted to DATA_FAILURE (that would be permanent).
    const dataFailObs = store.all.filter((o) => o.status === "DATA_FAILURE");
    expect(dataFailObs.length).toBe(0);
    // Counters must reflect the errors.
    expect(result.errors).toBeGreaterThan(0);
    expect(result.dataFailures).toBeGreaterThan(0);
    // Nothing was resolved.
    expect(result.resolved).toBe(0);
  });

  // ── beginBatch/endBatch (2026-07-23 fix for the operator-brief?resolve=1 90-190s testnet freeze) ──
  // Spies on the store's own private `flush` (cast to any — Vitest cannot spy on a built-in ESM
  // module's named export like node:fs's writeFileSync, since the module namespace is non-configurable;
  // flush() is this store's own single choke point for an actual disk write, so spying on it directly
  // is both the only viable hook AND the more precise one — it tests the batching CONTRACT, not an
  // incidental implementation detail of how persistence happens to be implemented underneath it).

  // [13b] beginBatch/endBatch collapses N independent save-worthy mutations into ONE flush.
  it("[13b] beginBatch/endBatch collapses multiple mutations into a single flush", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const flushSpy = vi.spyOn(store as unknown as { flush: () => void }, "flush");

    // Without batching, add() + setResolverMeta() + update() would each flush independently (3 writes).
    store.beginBatch();
    store.add(buildVariantMatrixObservationsForSignal(makeSignal({ sourceSignalId: "b1" }))[0]!);
    store.setResolverMeta({ lastRunAt: new Date().toISOString(), resolvedCount: 0, expiredCount: 0, dataFailureCount: 0, errorCount: 0, walkCursor: 0 });
    store.update(store.all[0]!.observationId, { status: "EXPIRED" });
    store.endBatch();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    // The batched mutations must still have actually landed (batching only defers the disk flush).
    expect(store.all[0]!.status).toBe("EXPIRED");
    expect(store.getResolverMeta()?.resolvedCount).toBe(0);
    flushSpy.mockRestore();
  });

  // [13c] Nested beginBatch/endBatch only flushes once the OUTERMOST endBatch() runs.
  it("[13c] nested batches only flush on the outermost endBatch()", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const flushSpy = vi.spyOn(store as unknown as { flush: () => void }, "flush");

    store.beginBatch();
    store.add(buildVariantMatrixObservationsForSignal(makeSignal({ sourceSignalId: "n1" }))[0]!);
    store.beginBatch();
    store.add(buildVariantMatrixObservationsForSignal(makeSignal({ sourceSignalId: "n2" }))[0]!);
    store.endBatch(); // inner — must NOT flush yet
    expect(flushSpy).not.toHaveBeenCalled();
    store.endBatch(); // outer — flushes once

    expect(flushSpy).toHaveBeenCalledTimes(1);
    flushSpy.mockRestore();
  });

  // [13d] resolveVariantMatrixObservations flushes at most once per run — the actual bug this fix
  // targets: Phase 1's stale-expiry bulkUpdate and setResolverMeta (always saves, unconditionally,
  // every single run — see its own doc comment) used to each write the FULL store independently
  // (plus pruneExpired/pruneTerminal/Phase-2's own bulkUpdate whenever THEY have something to do), up
  // to 5 full-array JSON.stringify+writeFileSync passes in one run. On the production store (documented
  // elsewhere in this file's constructor comment as having reached 129k+ observations / ~200MB), that
  // is what actually starved operator-brief?resolve=1 for 90-190+s per cycle and froze the whole
  // process for every other concurrent request (writeFileSync blocks the single-threaded event loop).
  // This test only needs to prove TWO of those five independent call sites collapse to one flush —
  // Phase 1's stale-expiry bulkUpdate (which only fires when there is something to expire) plus the
  // always-fires setResolverMeta — reusing test [11]'s exact stale-OPEN setup (candle fetch is never
  // reached for an already-expired obs, so a plain empty-returning binance mock is enough here; a
  // full winning-candle-walk Phase-2 scenario is exercised separately by test [13b]'s unit-level check
  // on bulkUpdate/setResolverMeta directly and by every other resolver test in this file).
  it("[13d] resolveVariantMatrixObservations does exactly ONE flush even though 2+ mutation phases fire", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const signal = makeSignal({ openedAt: new Date(oldMs).toISOString() });
    store.addMany(buildVariantMatrixObservationsForSignal(signal));

    const flushSpy = vi.spyOn(store as unknown as { flush: () => void }, "flush");
    const trackingBinance = { getKlines: async (): Promise<KlineTuple[]> => [] };

    const result = await resolveVariantMatrixObservations(store, trackingBinance);

    // Sanity: the stale-expiry bulkUpdate path actually fired (otherwise this test would pass for the
    // wrong reason) — setResolverMeta always fires regardless, so this alone is already 2 save sites.
    expect(result.expired).toBeGreaterThan(0);
    // The actual regression check: ONE flush for the whole run, not one per phase.
    expect(flushSpy).toHaveBeenCalledTimes(1);
    flushSpy.mockRestore();
  });

  // [14] Resolver diagnostics surface max-hold-overdue observations, not merely >72h runner holds.
  it("[14] resolver diagnostics: staleOpenCount follows each lane max-hold", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);

    const runnerWithinHold = makeSignal({
      sourceSignalId: "runner-within-hold",
      openedAt: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    });
    const runnerPastHold = makeSignal({
      sourceSignalId: "runner-past-hold",
      openedAt: new Date(Date.now() - 145 * 60 * 60 * 1000).toISOString(),
    });
    store.addMany([
      buildVariantMatrixObservationsForSignal(runnerWithinHold).find((obs) => obs.variantId === "CG_WIDE_LONG_RUNNER")!,
      buildVariantMatrixObservationsForSignal(runnerPastHold).find((obs) => obs.variantId === "CG_WIDE_LONG_RUNNER")!,
    ]);

    const report = buildCurrentGuardVariantMatrixReport(store, { capturedAt: new Date().toISOString() });
    const runnerOpen = store.all.filter((obs) => obs.variantId === "CG_WIDE_LONG_RUNNER" && obs.status === "OPEN");

    expect(runnerOpen.length).toBe(2);
    expect(report.resolverDiagnostics.staleOpenCount).toBe(1);
    expect(report.resolverDiagnostics.oldestOpenAgeHours).not.toBeNull();
    expect(report.resolverDiagnostics.oldestOpenAgeHours!).toBeGreaterThan(100);
    // A nextAction hint must be provided when stale observations exist.
    expect(report.resolverDiagnostics.nextAction).not.toBeNull();
    expect(report.resolverDiagnostics.nextAction).toContain("past lane max-hold");
  });

  // [STALE-GATE] mirror SKIPS born-stale signals (openedAt past EXPIRY) — they'd only be
  // Phase-1-expired without ever resolving (pure churn). Fresh signals still mirror.
  it("[STALE-GATE] mirror skips born-stale signals (openedAt > EXPIRY), keeps fresh ones", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const now = new Date().toISOString();
    const stale = makeSignal({ sourceSignalId: "stale", symbol: "STALEUSDT", openedAt: new Date(Date.now() - 8 * 86400000).toISOString() });
    const fresh = makeSignal({ sourceSignalId: "fresh", symbol: "FRESHUSDT", openedAt: new Date(Date.now() - 3600000).toISOString() });
    const res = mirrorVariantMatrixSignals([stale, fresh], store, now);
    expect(res.skippedStale).toBeGreaterThan(0); // the stale signal was skipped
    expect(store.all.some((o) => o.symbol === "STALEUSDT")).toBe(false); // no born-stale obs created
    expect(store.all.some((o) => o.symbol === "FRESHUSDT")).toBe(true); // fresh obs created
  });

  // [PRUNE-EXP] pruneExpired bounds the store — drops oldest EXPIRED beyond the cap, never touches
  // OPEN / CLOSED (which feed the stats).
  it("[PRUNE-EXP] pruneExpired keeps newest N EXPIRED, drops older, preserves OPEN/CLOSED", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    const mk = (id: string, status: string, ts: string) =>
      ({ ...base, observationId: id, sourceObservationKey: id, status, resolvedAt: ts, openedAt: ts } as typeof base);
    store.addMany([
      mk("exp-old1", "EXPIRED", "2026-06-01T00:00:00.000Z"),
      mk("exp-old2", "EXPIRED", "2026-06-02T00:00:00.000Z"),
      mk("exp-new", "EXPIRED", "2026-06-20T00:00:00.000Z"),
      mk("win", "CLOSED_WIN", "2026-06-10T00:00:00.000Z"),
      mk("open", "OPEN", "2026-06-22T00:00:00.000Z"),
    ]);
    const pruned = store.pruneExpired(1); // keep only the newest 1 EXPIRED
    expect(pruned).toBe(2);
    const ids = store.all.map((o) => o.observationId);
    expect(ids).toContain("exp-new"); // newest EXPIRED kept
    expect(ids).not.toContain("exp-old1"); // older EXPIRED dropped
    expect(ids).toContain("win"); // CLOSED untouched
    expect(ids).toContain("open"); // OPEN untouched
    // The dedup index must drop the pruned entries' keys too, or a legitimate re-mirror of the same
    // (sourceObservationKey, variantId) would be silently blocked as a false "duplicate" forever.
    expect(store.hasObservation("exp-old1", base.variantId)).toBe(false);
    expect(store.hasObservation("exp-new", base.variantId)).toBe(true); // still present, still tracked
  });

  // [PRUNE-TERM] pruneTerminal bounds CLOSED_WIN/CLOSED_LOSS/REJECTED/NO_FILL independently per
  // status (2026-07-07 OOM audit: these fed no cap at all, unlike EXPIRED — main's store reached
  // 197MB/153k obs and crashed on heap limit ~19x more often than testnet/live's 27MB stores).
  // Unlike pruneExpired, dropped records must be ARCHIVED (these statuses feed real edge
  // measurement), never silently discarded.
  it("[PRUNE-TERM] pruneTerminal keeps newest N per status independently, preserves OPEN/EXPIRED", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    const mk = (id: string, status: string, ts: string) =>
      ({ ...base, observationId: id, sourceObservationKey: id, status, resolvedAt: ts, openedAt: ts } as typeof base);
    store.addMany([
      mk("win-old1", "CLOSED_WIN", "2026-06-01T00:00:00.000Z"),
      mk("win-old2", "CLOSED_WIN", "2026-06-02T00:00:00.000Z"),
      mk("win-new", "CLOSED_WIN", "2026-06-20T00:00:00.000Z"),
      mk("loss-only", "CLOSED_LOSS", "2026-06-10T00:00:00.000Z"), // under cap, must survive untouched
      mk("exp", "EXPIRED", "2026-06-15T00:00:00.000Z"),
      mk("open", "OPEN", "2026-06-22T00:00:00.000Z"),
    ]);
    const pruned = store.pruneTerminal(1); // keep only the newest 1 PER STATUS
    expect(pruned).toBe(2); // only the 2 excess CLOSED_WIN dropped; CLOSED_LOSS had just 1, untouched
    const ids = store.all.map((o) => o.observationId);
    expect(ids).toContain("win-new");
    expect(ids).not.toContain("win-old1");
    expect(ids).not.toContain("win-old2");
    expect(ids).toContain("loss-only"); // a status under its own cap is never touched
    expect(ids).toContain("exp"); // EXPIRED is pruneExpired's job, not pruneTerminal's
    expect(ids).toContain("open"); // OPEN must never be dropped
    // Dedup index must drop pruned keys, same reasoning as pruneExpired.
    expect(store.hasObservation("win-old1", base.variantId)).toBe(false);
    expect(store.hasObservation("win-new", base.variantId)).toBe(true);
  });

  // [PRUNE-TERM-ARCHIVE] dropped records must be archived (append-only JSONL next to the store),
  // never discarded outright — 22 files read these statuses for edge/PBO/backtest measurement.
  it("[PRUNE-TERM-ARCHIVE] pruneTerminal archives dropped records to an append-only JSONL file", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    const mk = (id: string, ts: string) =>
      ({ ...base, observationId: id, sourceObservationKey: id, status: "REJECTED", resolvedAt: ts, openedAt: ts } as typeof base);
    store.addMany([mk("rej-old", "2026-06-01T00:00:00.000Z"), mk("rej-new", "2026-06-20T00:00:00.000Z")]);
    store.pruneTerminal(1);
    const archivePath = join(dir, "current-guard-variant-matrix-archive.jsonl");
    expect(existsSync(archivePath)).toBe(true);
    const lines = readFileSync(archivePath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const archived = JSON.parse(lines[0]!);
    expect(archived.observationId).toBe("rej-old"); // the dropped one, not the kept one
  });

  // [PRUNE-TERM-DATA-FAILURE] 2026-07-08 second-pass OOM fix: DATA_FAILURE was the ONE terminal
  // status missing from VM_PRUNABLE_TERMINAL_STATUSES entirely — genuinely unbounded (not even a
  // generous cap like the others had). Empty in production so far, but the class of bug is
  // identical to every other unbounded-store incident this session — must be capped defensively.
  it("[PRUNE-TERM-DATA-FAILURE] DATA_FAILURE is bounded exactly like the other terminal statuses", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    const mk = (id: string, ts: string) =>
      ({ ...base, observationId: id, sourceObservationKey: id, status: "DATA_FAILURE", resolvedAt: ts, openedAt: ts } as typeof base);
    store.addMany([mk("df-old", "2026-06-01T00:00:00.000Z"), mk("df-new", "2026-06-20T00:00:00.000Z")]);
    const pruned = store.pruneTerminal(1);
    expect(pruned).toBe(1);
    const ids = store.all.map((o) => o.observationId);
    expect(ids).toContain("df-new");
    expect(ids).not.toContain("df-old");
  });

  // [PRUNE-TERM-NOOP] when nothing exceeds the cap, pruneTerminal must not write an archive file at
  // all (proves the archive write is gated on actual drops, not called unconditionally every cycle).
  it("[PRUNE-TERM-NOOP] pruneTerminal is a no-op (no archive file, no drops) when under cap", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    store.add({ ...base, observationId: "only-one", sourceObservationKey: "only-one", status: "NO_FILL" });
    const pruned = store.pruneTerminal(15000);
    expect(pruned).toBe(0);
    expect(existsSync(join(dir, "current-guard-variant-matrix-archive.jsonl"))).toBe(false);
  });

  // [HASOBS-O1] hasObservation must be an O(1) index lookup, not a linear scan — a `.some()` scan
  // over a large store (mirrorVariantMatrixSignals calls this once per candidate observation) was the
  // root cause of operator-brief?resolve=1 hanging 190-235s on a store that had grown past ~80k obs:
  // the synchronous scan work starved the event loop long enough that even an unrelated
  // `Promise.race([x, setTimeout(8000)])` a few lines later couldn't fire its own timer on schedule.
  it("[HASOBS-O1] hasObservation reflects add/addMany immediately and stays correct at scale", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const base = buildVariantMatrixObservationsForSignal(makeSignal())[0]!;
    // Seed a large store (representative of the production incident's scale) — the property under
    // test is CORRECTNESS at this scale, not a timing assertion (which would be flaky in CI).
    const bulk = Array.from({ length: 5000 }, (_, i) => ({
      ...base,
      observationId: `bulk-${i}`,
      sourceObservationKey: `bulk-src-${i}`,
    }));
    store.addMany(bulk);
    expect(store.hasObservation("bulk-src-2500", base.variantId)).toBe(true);
    expect(store.hasObservation("never-added", base.variantId)).toBe(false);
    expect(store.hasObservation("bulk-src-2500", "CG_WIDE_FAST_SHORT")).toBe(
      base.variantId === "CG_WIDE_FAST_SHORT",
    ); // wrong variantId for the same source key must not match
    store.add({ ...base, observationId: "single-add", sourceObservationKey: "single-src" });
    expect(store.hasObservation("single-src", base.variantId)).toBe(true);
  });

  // [15] Resolver meta is persisted after a run and readable from subsequent report diagnostics.
  it("[15] resolver meta is persisted after run and surfaces in resolverDiagnostics.lastRunAt", async () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);

    // Before any resolver run, lastRunAt must be null.
    const reportBefore = buildCurrentGuardVariantMatrixReport(store);
    expect(reportBefore.resolverDiagnostics.lastRunAt).toBeNull();
    expect(reportBefore.resolverDiagnostics.resolvedThisRun).toBeNull();

    // Run resolver — even with no OPEN obs, meta is saved.
    mirrorVariantMatrixSignals([makeSignal()], store, new Date().toISOString());
    await resolveVariantMatrixObservations(store, winningBinance());

    // A new report must reflect the persisted meta.
    const reportAfter = buildCurrentGuardVariantMatrixReport(store);
    expect(reportAfter.resolverDiagnostics.lastRunAt).not.toBeNull();
    expect(reportAfter.resolverDiagnostics.resolvedThisRun).not.toBeNull();
    expect(typeof reportAfter.resolverDiagnostics.resolvedThisRun).toBe("number");
  });

  // ── Regime-adaptive synthetic lane (report-only) ──────────────────────────
  function addPairedSignal(
    store: CurrentGuardVariantMatrixStore,
    id: string,
    regime: string,
    wideNetR: number,
    scaleoutNetR: number,
    resolvedAt: string,
  ): void {
    const obs = buildVariantMatrixObservationsForSignal(makeSignal({ sourceSignalId: id, symbol: id, regime }));
    for (const o of obs) {
      const isWide = o.variantId === "CG_WIDE_STOP_TP_WIDE";
      const isScale = o.variantId === "CG_SCALEOUT_TP1_TRAIL";
      if (!isWide && !isScale) continue;
      const netR = isWide ? wideNetR : scaleoutNetR;
      o.status = netR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
      o.grossR = netR;
      o.netR = netR;
      o.isFreshValid = true;
      o.resolvedAt = resolvedAt;
    }
    store.addMany(obs);
  }

  it("[16] regime-adaptive synthetic picks full-exit in strong trend, scaleout in chop; does not beat scaleout here", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addPairedSignal(store, "S1", "Bearish pressure", -1, 0.5, "2026-05-20T01:00:00.000Z");
    addPairedSignal(store, "S2", "Bearish pressure", -1, 0.5, "2026-05-20T02:00:00.000Z");
    addPairedSignal(store, "S3", "Mixed rotation", -1, 0.5, "2026-05-20T03:00:00.000Z");

    const r = buildCurrentGuardVariantMatrixReport(store).regimeAdaptiveSynthetic;
    expect(r.pairedSignals).toBe(3);
    expect(r.pickedFullExit).toBe(2); // 2 strong-trend signals → full-exit branch
    expect(r.pickedScaleout).toBe(1); // 1 chop/mixed signal → scaleout branch
    // adaptive = (-1, -1, +0.5)/3 = -0.5 ; scaleout (all) = +0.5 ; fullExit (all) = -1
    expect(r.netAvgR).toBeCloseTo(-0.5, 6);
    expect(r.scaleoutNetAvgR).toBeCloseTo(0.5, 6);
    expect(r.fullExitNetAvgR).toBeCloseTo(-1, 6);
    expect(r.beatsScaleout).toBe(false);
  });

  it("[17] regime-adaptive synthetic beatsScaleout when trend-picked full-exit wins big", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addPairedSignal(store, "S1", "Bearish pressure", 1, 0.1, "2026-05-20T01:00:00.000Z");
    addPairedSignal(store, "S2", "Bearish pressure", 1, 0.1, "2026-05-20T02:00:00.000Z");
    addPairedSignal(store, "S3", "Mixed rotation", -1, 0.2, "2026-05-20T03:00:00.000Z");

    const r = buildCurrentGuardVariantMatrixReport(store).regimeAdaptiveSynthetic;
    expect(r.pickedFullExit).toBe(2);
    expect(r.pickedScaleout).toBe(1);
    // adaptive = (1, 1, +0.2)/3 ≈ +0.733 ; scaleout = (0.1, 0.1, 0.2)/3 ≈ +0.133
    expect(r.netAvgR!).toBeCloseTo(0.7333, 3);
    expect(r.scaleoutNetAvgR!).toBeCloseTo(0.1333, 3);
    expect(r.beatsScaleout).toBe(true);
  });

  // ===========================================================================================
  // [ATR-TRAIL] New exitRule: continuous ATR-ratchet trailing stop (Tier 2 item 5, offline-only).
  // Ports the proven outcome-checker.ts mechanic (currentStop = Math.max(currentStop, close-ATR)
  // for LONG, Math.min symmetric for SHORT) into walkVariantPath. Small atrPeriod (2) used
  // throughout so the expected ATR values can be hand-computed exactly.
  // ===========================================================================================
  it("[ATR1] LONG: arms after a big favorable move, ratchets the stop up, banks a locked-in profit on the pullback", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 104, 99.5, 103), // big pop: mfeR so far after this candle = 2.0
      candle(SIGNAL_OPEN_MS + 300000, 105, 102.5, 104), // further favorable: mfeR = 2.5 (peak)
      // ATR now available (period=2 -> first ATR at index 2): tr1=max(105-102.5,|105-103|,|102.5-103|)=2.5;
      // tr2=max(104.5-102,|104.5-104|,|102-104|)=2.5; atr=(2.5+2.5)/2=2.5. trailLevel=close(103.5)-1*2.5=101.0.
      candle(SIGNAL_OPEN_MS + 600000, 104.5, 102, 103.5),
      // Pulls back through the ratcheted stop (101.0) — NOT the original stop (98).
      candle(SIGNAL_OPEN_MS + 900000, 101.5, 100, 100.5),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "atr_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      atrPeriod: 2,
      atrMultiple: 1,
      atrTrailArmR: 0.2,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(0.5, 6); // exits at ratcheted stop 101.0 -> (101-100)/2
    expect(result.resolutionSource).toBe("ATR_TRAIL_STOP");
    expect(result.maxMfeR).toBeCloseTo(2.5, 6); // ran up to +2.5R before being trailed out
  });

  it("[ATR2] LONG: never arms (favorable move stays below the arm threshold) -> degrades to a plain static stop (-1)", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 100.2, 99, 99.5), // mfeR only 0.1 -> never reaches default arm 0.5
      candle(SIGNAL_OPEN_MS + 300000, 99.8, 97.5, 98), // hits the ORIGINAL stop (98), never ratcheted
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "atr_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      atrPeriod: 2,
    });
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.grossR).toBe(-1);
    expect(result.resolutionSource).toBe("ATR_TRAIL_STOP");
  });

  it("[ATR3] SHORT symmetry: arms, ratchets the stop down, banks a locked-in profit on the bounce", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 100.5, 96, 97), // big favorable drop: mfeR after this candle = 2.0
      candle(SIGNAL_OPEN_MS + 300000, 99, 94.5, 95.5), // further favorable: mfeR = 2.75 (peak)
      // ATR now available: tr1=max(99-94.5,|99-97|,|94.5-97|)=4.5; tr2=max(98-95,|98-95.5|,|95-95.5|)=3;
      // atr=(4.5+3)/2=3.75. trailLevel=close(95)+1*3.75=98.75.
      candle(SIGNAL_OPEN_MS + 600000, 98, 95, 95),
      // Bounces back up through the ratcheted stop (98.75) — well short of the original stop (102).
      candle(SIGNAL_OPEN_MS + 900000, 99.5, 97, 98),
    ];
    const result = await walkVariantPath({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 102,
      target: 80,
      exitRule: "atr_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      atrPeriod: 2,
      atrMultiple: 1,
      atrTrailArmR: 0.2,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(0.625, 6); // exits at ratcheted stop 98.75 -> (100-98.75)/2
    expect(result.resolutionSource).toBe("ATR_TRAIL_STOP");
  });

  it("[ATR4] LONG: price keeps running without ever touching the ratcheted stop -> forceCloseAtEnd still MTMs cleanly", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 104, 99.5, 103),
      candle(SIGNAL_OPEN_MS + 300000, 105, 102.5, 104),
      candle(SIGNAL_OPEN_MS + 600000, 104.5, 102, 103.5), // ratchets to 101.0 (same math as ATR1)
      candle(SIGNAL_OPEN_MS + 900000, 104, 102, 103), // stays comfortably above 101.0 — no touch
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 1000, // unreachable — forces path-end handling
      exitRule: "atr_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      atrPeriod: 2,
      atrMultiple: 1,
      atrTrailArmR: 0.2,
      forceCloseAtEnd: true,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(1.5, 6); // MTM at last close 103 -> (103-100)/2
    expect(result.resolutionSource).toBe("MAX_HOLD_MTM");
  });

  // ===========================================================================================
  // [PYRAMID] New function: walkPyramidOnConfirmedWinner (Tier 2 item 5, offline-only). Reuses
  // walkVariantPath for BOTH legs' exit resolution; only the "when does leg 2 get added" crossing
  // scan and the size-weighted R blend are new. walkVariantPath's own single-entry behavior and
  // signature are completely untouched (proven by the unmodified tests above, all still passing).
  // ===========================================================================================
  it("[PYR1] adds a second entry on confirmed progress and blends both legs' R by size", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 100.4, 99.6, 100.1), // mfeR=0.2 -> below 0.3 threshold, no cross yet
      candle(SIGNAL_OPEN_MS + 300000, 100.8, 100.0, 100.6), // mfeR=0.4 -> CROSSES here; add @ close 100.6
      candle(SIGNAL_OPEN_MS + 600000, 104.5, 100.2, 104.2), // leg1 TP (104) touched here; leg2 TP (110.6? no)
      candle(SIGNAL_OPEN_MS + 900000, 101, 98.0, 98.5), // leg2's OWN stop (98.6) touched here
    ];
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      addFavorableR: 0.3,
      addSizeMultiple: 0.5,
    });
    expect(result.leg1.status).toBe("CLOSED_WIN");
    expect(result.leg1.grossR).toBeCloseTo(2.0, 6); // (104-100)/2
    expect(result.addedSecondEntry).toBe(true);
    expect(result.addOpenedAtMs).toBe(SIGNAL_OPEN_MS + 300000);
    expect(result.addEntryPrice).toBeCloseTo(100.6, 6);
    expect(result.leg2).not.toBeNull();
    expect(result.leg2!.status).toBe("CLOSED_LOSS");
    expect(result.leg2!.grossR).toBeCloseTo(-1.0, 6); // leg2 stop 98.6 -> (98.6-100.6)/2
    expect(result.totalSize).toBeCloseTo(1.5, 6);
    // combinedR = (2.0*1 + (-1.0)*0.5) / 1.5 = 1.5/1.5 = 1.0
    expect(result.combinedR).toBeCloseTo(1.0, 6);
    expect(result.status).toBe("CLOSED_WIN");
  });

  it("[PYR2] never confirms (favorable move stays below threshold) -> no add, combinedR is leg1 alone", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 100.2, 99.5, 99.8), // mfeR=0.1, below the 0.5 threshold
      candle(SIGNAL_OPEN_MS + 300000, 100.1, 97.5, 98), // hits the stop before ever confirming
    ];
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      addFavorableR: 0.5,
    });
    expect(result.leg1.status).toBe("CLOSED_LOSS");
    expect(result.leg1.grossR).toBe(-1);
    expect(result.addedSecondEntry).toBe(false);
    expect(result.addOpenedAtMs).toBeNull();
    expect(result.addEntryPrice).toBeNull();
    expect(result.leg2).toBeNull();
    expect(result.combinedR).toBe(-1);
    expect(result.status).toBe("CLOSED_LOSS");
  });

  it("[PYR3] leg 1 NO_FILL (maker never revisited) -> passthrough, no crossing scan, no add", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 102, 100.5, 101.5), // signal candle, no fill (maker_limit)
      candle(SIGNAL_OPEN_MS + 300000, 106, 103, 105), // price only ever runs away — never dips to 100
      candle(SIGNAL_OPEN_MS + 600000, 108, 105, 107),
    ];
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "tp1_full",
      fillMode: "maker_limit",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.leg1.status).toBe("NO_FILL");
    expect(result.status).toBe("NO_FILL");
    expect(result.addedSecondEntry).toBe(false);
    expect(result.leg2).toBeNull();
    expect(result.combinedR).toBeNull();
  });

  // ===========================================================================================
  // [PBC] New exitRule: production_breakeven_control (Task 1, 2026-07-10, offline-only). Models
  // live-execution-engine.ts's REAL maybeCloseLiveBreakevenLaneAfterCost() — the operator
  // emergency-exit gated on LIVE_BREAKEVEN_EXIT_LANE_IDS — as a validated control. Trigger price
  // (LONG) = entry / (1 - costPct); the position closes the first candle whose high/low range
  // crosses that fixed price, exactly like a TP-touch check elsewhere in this file.
  // ===========================================================================================
  it("[PBC1] LONG: arm threshold crossed -> closes at the modeled breakeven-after-cost price", async () => {
    // costPct=0.2 (round, hand-computable) => trigger = 100 / (1 - 0.2) = 125 exactly.
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 110, 95, 105), // favorable but below the 125 trigger; no SL either
      candle(SIGNAL_OPEN_MS + 300000, 130, 120, 128), // crosses 125 -> closes here
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 75,
      target: 200, // far away — never touched, isolates the trigger
      exitRule: "production_breakeven_control",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      productionBreakevenCostPct: 0.2,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.productionBreakevenTriggerPrice).toBeCloseTo(125, 9);
    expect(result.grossR).toBeCloseTo(1.0, 9); // (125-100)/25
    expect(result.resolutionSource).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(result.intrabarResolutionStatus).toBe("VALID_5M_ORDERED");
    expect(result.productionBreakevenModeledCloseQty).toBeNull(); // no qty/stepSize supplied
  });

  it("[PBC2] LONG: arm threshold never crossed -> falls through to the plain hard stop (-1), same as every other rule", async () => {
    // Same 125 trigger (costPct=0.2, entry=100) but price only ever moves adversely and hits the
    // hard stop at 75 — the trigger is never touched, so this degrades to a plain SL close,
    // exactly like tp1_full/atr_trail/mfe_giveback would in an identical never-favorable path.
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 105, 90, 95), // favorable move stays well below 125; stop (75) untouched
      candle(SIGNAL_OPEN_MS + 300000, 90, 70, 72), // hits the hard stop (75), trigger (125) untouched
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 75,
      target: 200,
      exitRule: "production_breakeven_control",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      productionBreakevenCostPct: 0.2,
    });
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.grossR).toBe(-1);
    expect(result.resolutionSource).toBe("CANDLE_WALK_SL");
    // The modeled trigger price is still surfaced as a diagnostic even though the trade never
    // reached it — see the VariantWalkResult field doc ("populated for EVERY outcome").
    expect(result.productionBreakevenTriggerPrice).toBeCloseTo(125, 9);
  });

  it("[PBC3] tick/step-size rounding: floors the diagnostic close quantity to stepSize WITHOUT changing grossR", async () => {
    // Identical geometry/candles to [PBC1] (same 1.0R win via the 125 trigger) — only the
    // quantity-rounding diagnostic inputs differ. 1.239 floored to a 0.01 step -> 1.23, NOT 1.24
    // (which naive Math.round — or a "round to nearest" implementation — would have produced) and
    // NOT the raw 1.239 (which is what you'd see if rounding were skipped entirely).
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 110, 95, 105),
      candle(SIGNAL_OPEN_MS + 300000, 130, 120, 128),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 75,
      target: 200,
      exitRule: "production_breakeven_control",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      productionBreakevenCostPct: 0.2,
      productionBreakevenCloseQty: 1.239,
      productionBreakevenQtyStepSize: 0.01,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(1.0, 9); // unchanged vs [PBC1] — rounding never feeds grossR
    expect(result.productionBreakevenModeledCloseQty).toBeCloseTo(1.23, 9);
    expect(result.productionBreakevenModeledCloseQty).not.toBeCloseTo(1.239, 9);
    expect(result.productionBreakevenModeledCloseQty).not.toBeCloseTo(1.24, 9);
  });

  it("[PBC4] pyramiding: a second entry at a DIFFERENT price gets its own independently-derived trigger price", async () => {
    // Reuses walkPyramidOnConfirmedWinner (existing sibling function, unmodified) with
    // exitRule: "production_breakeven_control" for BOTH legs — walkVariantPath itself only ever
    // replays one entry, so pyramiding is exercised at this level, exactly as the pyramid tests
    // above already do for tp1_full.
    //
    // addFavorableR=0.05 (small) is crossed on candle 0 itself (mfeR there = (110-100)/10 = 1.0
    // >> 0.05), well before leg 1's own production_breakeven_control trigger (which needs a MUCH
    // smaller relative move, ~0.2205R at the default cost pct) fires on candle 1 — so the add
    // happens first, at candle 0's CLOSE (100.05), a price DIFFERENT from leg 1's own entry (100).
    const risk = 10; // entry100/stop90
    const trigger1 = 100 / (1 - PRODUCTION_BREAKEVEN_CONTROL_COST_PCT);
    const addEntryPrice = 100.05; // candle 0's close — where walkPyramidOnConfirmedWinner adds leg 2
    const trigger2 = addEntryPrice / (1 - PRODUCTION_BREAKEVEN_CONTROL_COST_PCT);
    // Sanity: both triggers must land inside candle 1's [99.9, 100.3] high/low range for this
    // fixture to unambiguously close both legs on candle 1 (not before/after).
    expect(trigger1).toBeGreaterThan(100);
    expect(trigger1).toBeLessThan(100.3);
    expect(trigger2).toBeGreaterThan(100.05);
    expect(trigger2).toBeLessThan(100.3);

    const candles: KlineTuple[] = [
      // Signal/fill candle for BOTH legs (leg 2's add candle IS this same candle — the crossing
      // is found here). high=110 gives mfeR=1.0 (>> addFavorableR=0.05) but stays below either
      // trigger (~100.22/~100.27), so neither leg closes here yet.
      candle(SIGNAL_OPEN_MS, 110, 99.8, 100.05),
      // Both triggers (~100.2205 and ~100.2706) fall inside [99.9, 100.3] — both legs close here.
      candle(SIGNAL_OPEN_MS + 300000, 100.3, 99.9, 100.2),
    ];
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 90,
      target: 200,
      exitRule: "production_breakeven_control",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      addFavorableR: 0.05,
    });

    expect(result.addedSecondEntry).toBe(true);
    expect(result.addEntryPrice).toBeCloseTo(addEntryPrice, 6);
    expect(result.leg1.status).toBe("CLOSED_WIN");
    expect(result.leg1.resolutionSource).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(result.leg1.productionBreakevenTriggerPrice).toBeCloseTo(trigger1, 9);
    expect(result.leg1.grossR).toBeCloseTo((trigger1 - 100) / risk, 9);

    expect(result.leg2).not.toBeNull();
    expect(result.leg2!.status).toBe("CLOSED_WIN");
    expect(result.leg2!.resolutionSource).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    // Leg 2's trigger is DERIVED FROM ITS OWN entry price (100.05), not leg 1's (100) — the two
    // are close but genuinely different numbers, proving each leg's trigger is computed
    // independently rather than shared/inherited from leg 1.
    expect(result.leg2!.productionBreakevenTriggerPrice).toBeCloseTo(trigger2, 9);
    expect(result.leg2!.productionBreakevenTriggerPrice).not.toBeCloseTo(trigger1, 6);
    expect(result.leg2!.grossR).toBeCloseTo((trigger2 - addEntryPrice) / risk, 9);

    const expectedCombinedR = (result.leg1.grossR! * 1 + result.leg2!.grossR! * 1) / 2; // addSizeMultiple default = 1
    expect(result.combinedR).toBeCloseTo(expectedCombinedR, 9);
    expect(result.status).toBe("CLOSED_WIN");
  });

  it("[PBC5] SHORT symmetry: trigger = entry / (1 + costPct), below entry, crossed on a favorable drop", async () => {
    // costPct=0.2, entry=100 => trigger = 100 / 1.2 = 83.3333... (SHORT: favorable = price DOWN,
    // so the trigger sits BELOW entry, mirroring the LONG case's trigger sitting above entry).
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 105, 90, 95), // favorable but stays above the 83.333 trigger; stop (125) untouched
      candle(SIGNAL_OPEN_MS + 300000, 95, 80, 82), // crosses below 83.333 -> closes here
    ];
    const result = await walkVariantPath({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 125,
      target: 20, // far away — never touched, isolates the trigger
      exitRule: "production_breakeven_control",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      productionBreakevenCostPct: 0.2,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.productionBreakevenTriggerPrice).toBeCloseTo(100 / 1.2, 9);
    expect(result.grossR).toBeCloseTo((100 - 100 / 1.2) / 25, 9); // (100-83.333)/25
    expect(result.resolutionSource).toBe("LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST");
    expect(result.intrabarResolutionStatus).toBe("VALID_5M_ORDERED");
  });

  describe("[PBC-COST-FALLBACK] PRODUCTION_BREAKEVEN_CONTROL_COST_PCT env resolution (fidelity-review fix, 2026-07-10)", () => {
    // Guards against the exact drift risk an adversarial fidelity review flagged: the control's
    // cost constant must default to the SAME env var the real live engine reads
    // (LIVE_ESTIMATED_CLOSE_COST_PCT), not an independently-declared default that only matches by
    // coincidence. Uses vi.resetModules() + a fresh dynamic import since this is a module-level
    // constant resolved once from process.env at import time.
    const ENV_KEYS = ["PRODUCTION_BREAKEVEN_CONTROL_COST_PCT", "LIVE_ESTIMATED_CLOSE_COST_PCT"] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      vi.resetModules();
    });

    it("falls back to LIVE_ESTIMATED_CLOSE_COST_PCT when the control-specific override is unset", async () => {
      delete process.env.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT;
      process.env.LIVE_ESTIMATED_CLOSE_COST_PCT = "0.005";
      vi.resetModules();
      const fresh = await import("../src/lib/current-guard-variant-matrix.js");
      expect(fresh.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT).toBeCloseTo(0.005, 9);
    });

    it("the control-specific override still wins when explicitly set", async () => {
      process.env.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT = "0.01";
      process.env.LIVE_ESTIMATED_CLOSE_COST_PCT = "0.005";
      vi.resetModules();
      const fresh = await import("../src/lib/current-guard-variant-matrix.js");
      expect(fresh.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT).toBeCloseTo(0.01, 9);
    });

    it("defaults to 0.0022 when neither env var is set", async () => {
      delete process.env.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT;
      delete process.env.LIVE_ESTIMATED_CLOSE_COST_PCT;
      vi.resetModules();
      const fresh = await import("../src/lib/current-guard-variant-matrix.js");
      expect(fresh.PRODUCTION_BREAKEVEN_CONTROL_COST_PCT).toBeCloseTo(0.0022, 9);
    });
  });

  // ===========================================================================================
  // [PBC-REGRESSION] Sentinel regression tests (Task 1, 2026-07-10): each of the 6 PRE-EXISTING
  // ablation variants (5 walkVariantPath exitRule branches + the pyramid_confirmed_winner sibling
  // function) still produces its exact expected outcome after adding the new
  // production_breakeven_control branch/fields — and every one of them now carries the two new
  // VariantWalkResult fields as null (they are exitRule-gated, computed only for
  // production_breakeven_control). This is IN ADDITION to (not a replacement for) the full
  // pre-existing test suite above, which already exercises all 6 extensively and must also stay
  // green.
  // ===========================================================================================
  it("[PBC-REG1] tp1_full unchanged: TP hit -> CLOSED_WIN, new fields null", async () => {
    const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 105, 99, 104.5)];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 104,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_WIN");
    expect(result.grossR).toBeCloseTo(2, 9); // (104-100)/2
    expect(result.resolutionSource).toBe("CANDLE_WALK_TP");
    expect(result.productionBreakevenTriggerPrice).toBeNull();
    expect(result.productionBreakevenModeledCloseQty).toBeNull();
  });

  it("[PBC-REG2] trail_after_tp1 unchanged: TP1 touched then price returns to breakeven on a LATER candle", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 103, 100.5, 102.8), // TP1 (102) touched; stays above entry (100)
      candle(SIGNAL_OPEN_MS + 300000, 101, 99, 99.5), // returns to/through entry -> breakeven exit
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 102,
      exitRule: "trail_after_tp1",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_LOSS"); // runnerR=0, 0>0 is false
    expect(result.grossR).toBe(0);
    expect(result.resolutionSource).toBe("TRAIL_BREAKEVEN_EXIT");
    expect(result.productionBreakevenTriggerPrice).toBeNull();
    expect(result.productionBreakevenModeledCloseQty).toBeNull();
  });

  it("[PBC-REG3] scaleout_tp1_trail unchanged: same path as REG2 but blends 50% full-exit + 50% runner", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 103, 100.5, 102.8),
      candle(SIGNAL_OPEN_MS + 300000, 101, 99, 99.5),
    ];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 102,
      exitRule: "scaleout_tp1_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_WIN"); // 0.5*1 + 0.5*0 = 0.5 > 0
    expect(result.grossR).toBeCloseTo(0.5, 9);
    expect(result.resolutionSource).toBe("TRAIL_BREAKEVEN_EXIT");
    expect(result.productionBreakevenTriggerPrice).toBeNull();
    expect(result.productionBreakevenModeledCloseQty).toBeNull();
  });

  it("[PBC-REG4] mfe_giveback unchanged: hard stop hit directly (never arms) -> CLOSED_LOSS", async () => {
    const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 101, 97, 98)];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "mfe_giveback",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
    });
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.grossR).toBe(-1);
    expect(result.resolutionSource).toBe("CANDLE_WALK_SL");
    expect(result.productionBreakevenTriggerPrice).toBeNull();
    expect(result.productionBreakevenModeledCloseQty).toBeNull();
  });

  it("[PBC-REG5] atr_trail unchanged: hard stop hit directly (never arms) -> CLOSED_LOSS", async () => {
    const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 101, 97, 98)];
    const result = await walkVariantPath({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "atr_trail",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      atrPeriod: 2,
    });
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.grossR).toBe(-1);
    expect(result.resolutionSource).toBe("ATR_TRAIL_STOP");
    expect(result.productionBreakevenTriggerPrice).toBeNull();
    expect(result.productionBreakevenModeledCloseQty).toBeNull();
  });

  it("[PBC-REG6] pyramid_confirmed_winner(tp1_full) unchanged: never confirms -> single-leg outcome only", async () => {
    const candles: KlineTuple[] = [
      candle(SIGNAL_OPEN_MS, 100.2, 99.5, 99.8), // mfeR=0.1, below the 0.5 threshold
      candle(SIGNAL_OPEN_MS + 300000, 100.1, 97.5, 98), // hits the stop before ever confirming
    ];
    const result = await walkPyramidOnConfirmedWinner({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      exitRule: "tp1_full",
      fillMode: "taker",
      openedAtMs: SIGNAL_OPEN_MS,
      candles,
      addFavorableR: 0.5,
    });
    expect(result.leg1.status).toBe("CLOSED_LOSS");
    expect(result.leg1.grossR).toBe(-1);
    expect(result.addedSecondEntry).toBe(false);
    expect(result.leg2).toBeNull();
    expect(result.combinedR).toBe(-1);
    expect(result.status).toBe("CLOSED_LOSS");
    expect(result.leg1.productionBreakevenTriggerPrice).toBeNull();
    expect(result.leg1.productionBreakevenModeledCloseQty).toBeNull();
  });
});

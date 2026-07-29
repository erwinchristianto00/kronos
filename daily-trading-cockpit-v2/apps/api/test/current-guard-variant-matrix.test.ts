import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

import type { ShadowPosition } from "@dtc/shared";

import {
  VARIANT_MATRIX_DEFINITIONS,
  BASELINE_VARIANT_ID,
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
  TAKER_ROUNDTRIP_BPS,
  MAKER_ROUNDTRIP_BPS,
  WIDE_STOP_MIN_BPS,
  WATCHABLE_MIN_FRESH,
  PRODUCTION_BREAKEVEN_CONTROL_COST_PCT,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
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
      total: 130, open: 0, resolved: 130, freshValid: 110, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
      netAvgR: 0.15, grossAvgR: 0.2, pf: 1.8, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
      payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
      noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 1, maxAdverseStreak: 1,
      topSymbolPnlShare: 0.2, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
      calendarDays: 6, distinctRegimes: 2, byRegime: [], byEntryVariant: [], oosThirds: null,
      allThreeOosPositive: true, rolling: [],
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
      total: 134, open: 0, resolved: 134, freshValid: 134, rejected: 0, noFill: 0, expired: 0, dataFailure: 0,
      netAvgR: 0.27, grossAvgR: 0.3, pf: 3.2, wr: 0.8, avgWinR: 0.4, avgLossR: -1,
      payoffRatio: 0.4, breakEvenWR: 1 / 3, actualWR: 0.8, avgCostR: 0.1, costDragR: 0.1,
      noFillRate: 0, expiredRate: 0, avgHoldingMinutes: 60, approxMaxDrawdownR: 7.76, maxAdverseStreak: 1,
      topSymbolPnlShare: 0.18, plus10bpsNetAvgR: 0.1, plus10bpsStillPositive: true,
      calendarDays: 3, distinctRegimes: 3, byRegime: [], byEntryVariant: [], oosThirds: null,
      allThreeOosPositive: true, rolling: [],
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

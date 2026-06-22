import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
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
  walkVariantPath,
  buildVariantMatrixObservationsForSignal,
  mirrorVariantMatrixSignals,
  selectVariantMatrixSignals,
  resolveVariantMatrixObservations,
  buildCurrentGuardVariantMatrixReport,
  TAKER_ROUNDTRIP_BPS,
  MAKER_ROUNDTRIP_BPS,
  WIDE_STOP_MIN_BPS,
  WATCHABLE_MIN_FRESH,
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
  it("[2] wide stop + wide TP widens stop, targets ~1R, and lowers cost-in-R", () => {
    const signal = makeSignal();
    const baseline = deriveVariantGeometry(signal, defOf(BASELINE_VARIANT_ID));
    const wide = deriveVariantGeometry(signal, defOf("CG_WIDE_STOP_TP_WIDE"));
    expect(baseline.kind).toBe("ok");
    expect(wide.kind).toBe("ok");
    if (baseline.kind !== "ok" || wide.kind !== "ok") throw new Error("expected ok");

    expect(wide.stopDistanceBps).toBeGreaterThanOrEqual(WIDE_STOP_MIN_BPS); // 300
    const payoff =
      (wide.takeProfitLevels[0]! - wide.entryPrice) / (wide.entryPrice - wide.stopLoss);
    expect(payoff).toBeCloseTo(1.0, 6);
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
    mirrorVariantMatrixSignals([signal], store, new Date().toISOString());

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
    mirrorVariantMatrixSignals([oldSignal], store, new Date().toISOString());
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

  // [14] Resolver diagnostics surface staleOpenCount and oldestOpenAgeHours for aged observations.
  it("[14] resolver diagnostics: staleOpenCount > 0 and oldestOpenAgeHours > 72 for 4-day-old obs", () => {
    const dir = tmpDir();
    const store = new CurrentGuardVariantMatrixStore(dir);
    // Signal opened 4 days ago: older than the 72-h stale threshold, within the 7-day expiry.
    const staleMs = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const signal = makeSignal({ openedAt: new Date(staleMs).toISOString() });
    mirrorVariantMatrixSignals([signal], store, new Date().toISOString());

    const report = buildCurrentGuardVariantMatrixReport(store, { capturedAt: new Date().toISOString() });

    expect(report.resolverDiagnostics.staleOpenCount).toBeGreaterThan(0);
    expect(report.resolverDiagnostics.oldestOpenAgeHours).not.toBeNull();
    expect(report.resolverDiagnostics.oldestOpenAgeHours!).toBeGreaterThan(72);
    // A nextAction hint must be provided when stale observations exist.
    expect(report.resolverDiagnostics.nextAction).not.toBeNull();
    expect(report.resolverDiagnostics.nextAction).toContain("resolve=1");
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
});

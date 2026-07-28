import { describe, it, expect, vi } from "vitest";
import {
  walkVariantPath,
  walkPyramidOnConfirmedWinner,
  type KlineTuple,
} from "../src/lib/current-guard-variant-matrix.js";

// 5m candle: [openTimeMs, "0", high, low, close, "0", closeTimeMs] — same convention as
// current-guard-variant-matrix.test.ts.
function candle(openMs: number, high: number, low: number, close: number): KlineTuple {
  return [openMs, "0", String(high), String(low), String(close), "0", openMs + 300000];
}

const SIGNAL_OPEN_MS = new Date("2026-05-20T00:00:00.000Z").getTime();
const STEP = 300000;

describe("current-guard-variant-matrix — Tier-2 exit-ablation additions", () => {
  // ── Regression: pre-existing exitRule behaviors are byte-identical after the atr_trail /
  //    pyramid additions. These pin the SAME fixtures/expectations already exercised in
  //    current-guard-variant-matrix.test.ts so a regression here is caught even if only this
  //    file is run. ──
  describe("[REGRESSION] pre-existing exitRule behaviors unchanged", () => {
    it("tp1_full: SL and TP both resolve exactly as before", async () => {
      const win = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 104,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles: [candle(SIGNAL_OPEN_MS, 104.5, 100.5, 103)],
      });
      expect(win.status).toBe("CLOSED_WIN");
      expect(win.grossR).toBeCloseTo(2, 6); // (104-100)/2
      expect(win.resolutionSource).toBe("CANDLE_WALK_TP");

      const loss = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 104,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles: [candle(SIGNAL_OPEN_MS, 100.5, 97.5, 98)],
      });
      expect(loss.status).toBe("CLOSED_LOSS");
      expect(loss.grossR).toBe(-1);
      expect(loss.resolutionSource).toBe("CANDLE_WALK_SL");
    });

    it("trail_after_tp1: rides to breakeven after a TP1 touch (same fixture as [3])", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 104.5, 100.5, 103),
        candle(SIGNAL_OPEN_MS + STEP, 103, 99.5, 100),
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
      expect(result.status).toBe("CLOSED_LOSS");
      expect(result.grossR).toBe(0);
      expect(result.resolutionSource).toContain("TRAIL");
    });

    it("scaleout_tp1_trail: blended R of 1.0 (same fixture as [4])", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 104.5, 100.5, 103),
        candle(SIGNAL_OPEN_MS + STEP, 103, 99.5, 100),
      ];
      const result = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 104,
        exitRule: "scaleout_tp1_trail",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
      });
      expect(result.grossR).toBeCloseTo(1.0, 6);
      expect(result.status).toBe("CLOSED_WIN");
    });

    it("mfe_giveback: arms at 1.5R and banks 0.75R on the retrace (same fixture as [MFEG1])", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 103, 100.5, 102),
        candle(SIGNAL_OPEN_MS + STEP, 102, 101, 101.5),
      ];
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
      expect(result.status).toBe("CLOSED_WIN");
      expect(result.grossR).toBeCloseTo(0.75, 6);
      expect(result.resolutionSource).toBe("MFE_GIVEBACK_EXIT");
    });
  });

  // ── New: atr_trail ──
  describe("[ATR-TRAIL] new exitRule", () => {
    it("[ATR-1] never arms (straight to stop) -> CLOSED_LOSS -1, same as tp1_full's SL path", async () => {
      const result = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 104,
        exitRule: "atr_trail",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles: [candle(SIGNAL_OPEN_MS, 100.5, 97.5, 98)],
      });
      expect(result.status).toBe("CLOSED_LOSS");
      expect(result.grossR).toBe(-1);
      expect(result.resolutionSource).toBe("CANDLE_WALK_SL");
    });

    it("[ATR-2] arms on target touch AND retraces to entry within the SAME candle -> breakeven exit", async () => {
      const result = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "atr_trail",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        // touches target (high>=101) AND dips back to entry (low<=100) within the same candle
        candles: [candle(SIGNAL_OPEN_MS, 101.5, 99.5, 100.3)],
      });
      expect(result.status).toBe("CLOSED_LOSS");
      expect(result.grossR).toBe(0);
      expect(result.resolutionSource).toBe("ATR_TRAIL_BREAKEVEN_SAME_CANDLE");
    });

    it("[ATR-3] arms, then floors at breakeven while ATR data is unavailable (same protection as trail_after_tp1), and marks-to-market at path end if never re-touched", async () => {
      const candles: KlineTuple[] = [
        // arms (touches 101), stays above breakeven (low 100.5 > 100)
        candle(SIGNAL_OPEN_MS, 101.5, 100.5, 101),
        // final candle: only 2 candles total, so computeATR (period 14 default) is all-null —
        // the trail floors at breakeven the whole time. Never touches back to 100, so the path
        // ends armed -> mark-to-market at the last close.
        candle(SIGNAL_OPEN_MS + STEP, 103, 100.2, 102.8),
      ];
      const result = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "atr_trail",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
      });
      expect(result.status).toBe("CLOSED_WIN");
      expect(result.grossR).toBeCloseTo(1.4, 6); // (102.8-100)/2
      expect(result.resolutionSource).toBe("ATR_TRAIL_PATH_END");
    });

    it("[ATR-3b] the breakeven floor actually protects: a pullback to entry (before ATR data exists) exits at breakeven", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 101.5, 100.5, 101), // arms
        candle(SIGNAL_OPEN_MS + STEP, 100.8, 99.8, 100.3), // low 99.8 <= breakeven 100
      ];
      const result = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "atr_trail",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
      });
      expect(result.status).toBe("CLOSED_LOSS"); // exits exactly at breakeven -> grossR 0, not >0
      expect(result.grossR).toBe(0);
      expect(result.resolutionSource).toBe("ATR_TRAIL_EXIT");
    });

    // These two use a stubbed ATR_TRAIL_PERIOD/ATR_TRAIL_MULT (via a fresh module instance) so
    // the ATR arithmetic is small and fully hand-computable, while still exercising the REAL
    // production computeATR + ratchet wiring (not a re-implementation).
    describe("with a small ATR period (hand-computable ratchet)", () => {
      async function freshModule() {
        vi.resetModules();
        vi.stubEnv("ATR_TRAIL_PERIOD", "2");
        vi.stubEnv("ATR_TRAIL_MULT", "1");
        const mod = await import("../src/lib/current-guard-variant-matrix.js");
        vi.unstubAllEnvs();
        return mod;
      }

      it("[ATR-4] continuously ratchets the stop up as price extends, never loosens, and exits at the ratcheted level (LONG)", async () => {
        const { walkVariantPath: walk } = await freshModule();
        // E=100, S=98 (risk=2), T=101 (arm at a 0.5R touch).
        // TR[1]=2, TR[2]=3 -> atr[2]=2.5 -> rawTrail@2 = 104-2.5=101.5 -> stop ratchets 100->101.5
        // TR[3]=4 -> atr[3]=3.25 -> rawTrail@3 = 107-3.25=103.75 -> stop ratchets 101.5->103.75
        // TR[4]=7 -> atr[4]=5.125 -> rawTrail@4 = 102-5.125=96.875 (WORSE) -> stop stays 103.75
        //   -> candle4's low (100) pierces the UNCHANGED 103.75 level -> exit there.
        const candles: KlineTuple[] = [
          candle(SIGNAL_OPEN_MS, 101.5, 100.5, 101), // arm
          candle(SIGNAL_OPEN_MS + 1 * STEP, 103, 101, 102),
          candle(SIGNAL_OPEN_MS + 2 * STEP, 105, 103, 104),
          candle(SIGNAL_OPEN_MS + 3 * STEP, 108, 106, 107),
          candle(SIGNAL_OPEN_MS + 4 * STEP, 106, 100, 102), // sharp reversal
        ];
        const result = await walk({
          direction: "LONG",
          entryPrice: 100,
          stopLoss: 98,
          target: 101,
          exitRule: "atr_trail",
          fillMode: "taker",
          openedAtMs: SIGNAL_OPEN_MS,
          candles,
        });
        expect(result.status).toBe("CLOSED_WIN");
        expect(result.grossR).toBeCloseTo(1.875, 6); // (103.75-100)/2
        expect(result.resolutionSource).toBe("ATR_TRAIL_EXIT");
      });

      it("[ATR-5] SHORT symmetry: ratchets down, never loosens, exits at the ratcheted level", async () => {
        const { walkVariantPath: walk } = await freshModule();
        const candles: KlineTuple[] = [
          candle(SIGNAL_OPEN_MS, 99.5, 98.5, 99), // arm (touches T=99)
          candle(SIGNAL_OPEN_MS + 1 * STEP, 99, 97, 98),
          candle(SIGNAL_OPEN_MS + 2 * STEP, 97, 95, 96),
          candle(SIGNAL_OPEN_MS + 3 * STEP, 94, 92, 93),
          candle(SIGNAL_OPEN_MS + 4 * STEP, 100, 94, 98), // sharp reversal up
        ];
        const result = await walk({
          direction: "SHORT",
          entryPrice: 100,
          stopLoss: 102,
          target: 99,
          exitRule: "atr_trail",
          fillMode: "taker",
          openedAtMs: SIGNAL_OPEN_MS,
          candles,
        });
        expect(result.status).toBe("CLOSED_WIN");
        expect(result.grossR).toBeCloseTo(1.875, 6); // (100-96.25)/2
        expect(result.resolutionSource).toBe("ATR_TRAIL_EXIT");
      });
    });
  });

  // ── New: walkPyramidOnConfirmedWinner ──
  describe("[PYRAMID] walkPyramidOnConfirmedWinner", () => {
    it("[PYR-1] adds a second leg once leg 1 reaches the trigger R; combined R sums both legs in leg-1 risk units", async () => {
      // E=100, S=98 (risk=2), T=110 (far, shared by both legs). addTriggerR=1.0 -> addLevel=102.
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 101.5, 99.5, 101), // below addLevel(102), no touch yet
        candle(SIGNAL_OPEN_MS + 1 * STEP, 103, 100.5, 102.5), // touches addLevel(102) -> pyramid add triggers here
        candle(SIGNAL_OPEN_MS + 2 * STEP, 111, 109, 110.5), // both legs' shared TP(110) touched
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
        addTriggerR: 1.0,
        addSizeMultiple: 1.0,
      });
      expect(result.addTriggered).toBe(true);
      expect(result.addEntryPrice).toBeCloseTo(102, 6);
      expect(result.leg1.status).toBe("CLOSED_WIN");
      expect(result.leg1.grossR).toBeCloseTo(5, 6); // (110-100)/2
      expect(result.leg2?.status).toBe("CLOSED_WIN");
      expect(result.leg2?.grossR).toBeCloseTo(4, 6); // (110-102)/2
      expect(result.combinedGrossR).toBeCloseTo(9, 6); // 5 + 4*1.0
    });

    it("[PYR-2] leg 1 never reaches the trigger R before it exits -> no add, combinedGrossR equals leg 1 alone", async () => {
      // T=101 is only 0.5R -> tp1_full exits leg 1 before ever touching the 1.0R add level (102).
      const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 101.5, 99.5, 101)];
      const result = await walkPyramidOnConfirmedWinner({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
        addTriggerR: 1.0,
        addSizeMultiple: 1.0,
      });
      expect(result.addTriggered).toBe(false);
      expect(result.leg2).toBeNull();
      expect(result.leg1.grossR).toBeCloseTo(0.5, 6);
      expect(result.combinedGrossR).toBeCloseTo(0.5, 6);
    });

    it("[PYR-3] addSizeMultiple <= 0 disables the add entirely, even when the trigger level IS touched", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 101.5, 99.5, 101),
        candle(SIGNAL_OPEN_MS + 1 * STEP, 103, 100.5, 102.5), // would trigger, but disabled below
        candle(SIGNAL_OPEN_MS + 2 * STEP, 111, 109, 110.5),
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
        addTriggerR: 1.0,
        addSizeMultiple: 0,
      });
      expect(result.addTriggered).toBe(false);
      expect(result.leg2).toBeNull();
      expect(result.combinedGrossR).toBe(result.leg1.grossR);
    });

    it("[PYR-4] leg 1 already stopped out before the add level is ever touched in a later candle -> no add (can't pyramid a closed leg)", async () => {
      const candles: KlineTuple[] = [
        candle(SIGNAL_OPEN_MS, 100.5, 99.5, 100.2), // below addLevel(102), no stop yet
        candle(SIGNAL_OPEN_MS + 1 * STEP, 100.8, 97, 97.5), // stops out here (low<=98)
        // this candle touches the add level, but ONLY after leg 1 already closed above —
        // must NOT trigger an add.
        candle(SIGNAL_OPEN_MS + 2 * STEP, 105, 103, 104),
      ];
      const result = await walkPyramidOnConfirmedWinner({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 1000, // effectively unreachable -> leg 1 only ever exits via the stop
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
        addTriggerR: 1.0,
        addSizeMultiple: 1.0,
      });
      expect(result.leg1.status).toBe("CLOSED_LOSS");
      expect(result.leg1.grossR).toBe(-1);
      expect(result.addTriggered).toBe(false);
      expect(result.leg2).toBeNull();
      expect(result.combinedGrossR).toBe(-1);
    });

    it("[PYR-5] degenerates cleanly to the single-entry case when addTriggerR is unreachable", async () => {
      const candles: KlineTuple[] = [candle(SIGNAL_OPEN_MS, 101.5, 99.5, 101)];
      const single = await walkVariantPath({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
      });
      const pyramid = await walkPyramidOnConfirmedWinner({
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 98,
        target: 101,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: SIGNAL_OPEN_MS,
        candles,
        addTriggerR: 50, // never reachable
        addSizeMultiple: 1.0,
      });
      expect(pyramid.addTriggered).toBe(false);
      expect(pyramid.combinedGrossR).toBe(single.grossR);
      expect(pyramid.leg1).toEqual(single);
    });
  });
});

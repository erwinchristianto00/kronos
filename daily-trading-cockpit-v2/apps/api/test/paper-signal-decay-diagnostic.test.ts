import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  buildSignalDecayDiagnostic,
  buildSignalDecayDiagnosticBriefLines,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  PAPER_EXECUTION_MODEL_REALISTIC,
  type PaperResolverClient,
  type PaperKlineTuple,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

const CANDLE_MS = 5 * 60 * 1000;
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "signal-decay-test-"));
const OPENED = Date.now() - 6 * 3_600_000; // 6h ago — all offsets in the past
const COST = -(22 / 300); // _computePaperCostR for 300bps

// SHORT, entry 100 / stop 103 / wide tp 96 / 300bps.
function order(args: { symbol?: string; status?: PaperOrderStatus; netR?: number | null; id?: string } = {}): PaperOrder {
  return {
    paperOrderId: args.id ?? `d-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(OPENED).toISOString(),
    updatedAt: new Date(OPENED + 24 * 3_600_000).toISOString(),
    openedAt: new Date(OPENED).toISOString(),
    symbol: args.symbol ?? "ETHUSDT",
    direction: "SHORT",
    regime: "BEARISH_PRESSURE",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 300,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: args.status ?? "PAPER_CLOSED_WIN",
    grossR: null,
    costR: null,
    netR: args.netR ?? null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

type OHLC = { h: number; l: number; c: number };

/** Client: 5m path = fiveMFn(t); 1m = flat oneMClose (null ⇒ 1m empty). */
function decayClient(fiveMFn: (t: number) => OHLC, oneMClose: number | null): PaperResolverClient {
  return {
    getKlines: async (_sym, interval, o) => {
      const step = interval === "1m" ? 60_000 : CANDLE_MS;
      const out: PaperKlineTuple[] = [];
      for (let t = o.startTime; t <= o.endTime; t += step) {
        if (interval === "1m") {
          if (oneMClose == null) continue;
          out.push([t, "0", String(oneMClose + 0.2), String(oneMClose - 0.2), String(oneMClose), "0", t + step]);
        } else {
          const k = fiveMFn(t);
          out.push([t, "0", String(k.h), String(k.l), String(k.c), "0", t + step]);
        }
      }
      return out;
    },
  };
}

// All-TP path: every candle reaches a deep low (TP) without touching the stop.
const tpClient = decayClient(() => ({ h: 100.5, l: 93, c: 95 }), 98);
const O = { offsetsMinutes: [-5, -1, 0, 1, 5, 10], executionModel: PAPER_EXECUTION_MODEL_REALISTIC, horizonHours: 2, minSample: 1 };
const off = (r: Awaited<ReturnType<typeof buildSignalDecayDiagnostic>>, m: number) =>
  r.offsets.find((x) => x.offsetMinutes === m)!;

describe("signal-decay diagnostic V1 (DIAGNOSTIC-ONLY)", () => {
  // [1] ACTUAL matches the baseline TP-first resolution; no entry drift
  it("[1] ACTUAL offset reproduces the baseline result", async () => {
    const r = await buildSignalDecayDiagnostic([order()], tpClient, O);
    const a = off(r, 0);
    expect(a.label).toBe("ACTUAL");
    expect(a.netAvgR!).toBeCloseTo((99.98 - 96) / 3 + COST, 3); // TP @96 from slipped entry
    expect(a.avgPriceDriftBps!).toBeCloseTo(0, 6);
    expect(a.expectancyDeltaR!).toBeCloseTo(0, 6);
    expect(a.decayPerMinuteR).toBeNull(); // offset 0
  });

  // [2] an entry offset shifts only the entry price (geometry preserved)
  it("[2] LATE offset re-prices entry; stop/TP carried at same offsets", async () => {
    const r = await buildSignalDecayDiagnostic([order()], tpClient, O);
    const late = off(r, 5);
    expect(late.avgPriceDriftBps!).toBeCloseTo(-200, 1); // 98 vs 100 → −200bps
    // newEntry 98 → newTP 94; slipped entry 97.9804 → R≈ same geometry
    expect(late.netAvgR!).toBeCloseTo((97.9804 - 94) / 3 + COST, 3);
    expect(off(r, 0).avgPriceDriftBps!).toBeCloseTo(0, 6); // ACTUAL unchanged
  });

  // [3] a late offset walks the LATER candle path (different outcome than ACTUAL)
  it("[3] late offset uses the later price path", async () => {
    const fiveMFn = (t: number): OHLC => {
      const rel = Math.round((t - OPENED) / 60_000);
      if (rel === 0) return { h: 104, l: 101, c: 103 }; // ACTUAL entry candle → SL
      if (rel >= 10) return { h: 99, l: 90, c: 92 }; // later path → TP for a +10m entry
      return { h: 100.5, l: 99, c: 100 }; // neutral elsewhere
    };
    const r = await buildSignalDecayDiagnostic([order()], decayClient(fiveMFn, 98), O);
    expect(off(r, 0).netAvgR!).toBeLessThan(0); // ACTUAL hits the stop
    expect(off(r, 10).netAvgR!).toBeGreaterThan(0); // LATE_10M reaches the later TP
  });

  // [4] an offset with no price path is skipped (not counted)
  it("[4] early offset skips when no 1m price path exists", async () => {
    const noOneM = decayClient(() => ({ h: 100.5, l: 93, c: 95 }), null); // 1m empty
    const r = await buildSignalDecayDiagnostic([order()], noOneM, O);
    expect(off(r, -5).sampleSize).toBe(0);
    expect(off(r, -5).skipped).toBe(1);
    expect(off(r, 0).sampleSize).toBe(1); // ACTUAL uses stored entry, no 1m needed
  });

  // [5] same-candle stop+TP handled conservatively (stop-first, counted)
  it("[5] same-candle ambiguity resolves to the stop conservatively", async () => {
    const ambClient = decayClient(() => ({ h: 104, l: 95, c: 100 }), null); // SL(103)+TP(96) same candle
    const r = await buildSignalDecayDiagnostic([order()], ambClient, O);
    const a = off(r, 0);
    expect(a.sameCandleAmbiguityCount).toBe(1);
    expect(a.netAvgR!).toBeLessThan(0); // conservative → stop-first loss
  });

  // [6] ISOLATION: pure read — no store write, no headline/gate change
  it("[6] does not write store, headline metrics, liveBlocked, or microPilotAllowed", async () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "k1" }));
    store.add(order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, id: "k2" }));
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    await buildSignalDecayDiagnostic(store.all, tpClient, O);

    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(true);
    expect(gateAfter.microPilotAllowed).toBe(false);
  });

  // [7] brief lines render the decay table + offsets + verdict
  it("[7] brief lines render the decay table", async () => {
    const r = await buildSignalDecayDiagnostic([order(), order({ symbol: "BTCUSDT" })], tpClient, O);
    const text = buildSignalDecayDiagnosticBriefLines(r).join("\n");
    expect(text).toContain("SIGNAL-DECAY DIAGNOSTIC V1");
    expect(text).toContain("ACTUAL");
    expect(text).toContain("LATE_5M");
    expect(text).toContain("EARLY_5M");
    expect(text).toContain("decay/min");
    expect(text).toContain("latencyVerdict=");
    expect(text).toContain("capTier=");
  });

  // [8] verdict abstains below the minimum sample
  it("[8] verdict INSUFFICIENT_SAMPLE below the sample floor", async () => {
    const r = await buildSignalDecayDiagnostic([order()], tpClient, {
      ...O,
      minSample: 20, // 1 order < 20
    });
    expect(off(r, 5).verdict).toBe("INSUFFICIENT_SAMPLE");
  });
});

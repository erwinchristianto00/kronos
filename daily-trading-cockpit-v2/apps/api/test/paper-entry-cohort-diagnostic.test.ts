import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  buildEntryCohortDiagnostic,
  buildEntryCohortDiagnosticBriefLines,
  ENTRY_COHORT_DIMENSIONS,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

const HOUR = 3_600_000;
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "entry-cohort-test-"));

function order(args: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  regime?: string | null;
  status?: PaperOrderStatus;
  netR?: number | null;
  openedAtMs?: number;
  createdAtMs?: number;
  stopBps?: number;
  id?: string;
}): PaperOrder {
  const opened = args.openedAtMs ?? Date.parse("2026-06-03T08:00:00.000Z");
  return {
    paperOrderId: args.id ?? `c-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(args.createdAtMs ?? opened).toISOString(),
    updatedAt: new Date(opened + 24 * HOUR).toISOString(),
    openedAt: new Date(opened).toISOString(),
    symbol: args.symbol ?? "ETHUSDT",
    direction: args.direction ?? "SHORT",
    regime: args.regime ?? "BEARISH_PRESSURE",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: args.stopBps ?? 800,
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

describe("entry-quality / cohort diagnostic (DIAGNOSTIC-ONLY)", () => {
  // [1] symbol cohort economics: net/PF/WR/sumR per symbol, sorted worst-first
  it("[1] groups by symbol with correct economics", () => {
    const orders = [
      order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1 }),
      order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1 }),
      order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1 }),
      order({ symbol: "BTCUSDT", status: "PAPER_CLOSED_WIN", netR: 2 }),
      order({ symbol: "BTCUSDT", status: "PAPER_CLOSED_WIN", netR: 2 }),
    ];
    const r = buildEntryCohortDiagnostic(orders);
    const sym = r.dimensions.find((d) => d.dimension === "symbol")!;
    const sei = sym.cohorts.find((c) => c.key === "SEIUSDT")!;
    const btc = sym.cohorts.find((c) => c.key === "BTCUSDT")!;
    expect(sei.closed).toBe(3);
    expect(sei.netAvgR).toBeCloseTo(-1, 6);
    expect(sei.sumR).toBeCloseTo(-3, 6);
    expect(sei.wr).toBe(0);
    expect(btc.netAvgR).toBeCloseTo(2, 6);
    expect(btc.pf).toBe(Infinity); // no losses → Infinity PF (winSum>0, lossSum=0)
    expect(sym.cohorts[0]!.key).toBe("SEIUSDT"); // worst first
  });

  // [2] toxic flag: closed≥3 & netAvgR<-0.5, sorted by sumR (most damaging)
  it("[2] surfaces toxic cohorts across dimensions", () => {
    const orders = [
      ...Array.from({ length: 4 }, () => order({ symbol: "WLDUSDT", status: "PAPER_CLOSED_LOSS", netR: -1 })),
      ...Array.from({ length: 3 }, () => order({ symbol: "OPUSDT", status: "PAPER_CLOSED_LOSS", netR: -0.8 })),
      order({ symbol: "ETHUSDT", status: "PAPER_CLOSED_WIN", netR: 1.5 }),
      // only 2 closed, below minN → not toxic even if negative
      order({ symbol: "TINYUSDT", status: "PAPER_CLOSED_LOSS", netR: -2 }),
      order({ symbol: "TINYUSDT", status: "PAPER_CLOSED_LOSS", netR: -2 }),
    ];
    const r = buildEntryCohortDiagnostic(orders);
    const keys = r.toxicCohorts.filter((t) => t.dimension === "symbol").map((t) => t.key);
    expect(keys).toContain("WLDUSDT");
    expect(keys).toContain("OPUSDT");
    expect(keys).not.toContain("TINYUSDT"); // n=2 < 3
    // within the symbol dimension, most damaging (most negative sumR) first
    expect(keys[0]).toBe("WLDUSDT"); // sumR -4 < OP -2.4
    // toxicCohorts is global across dimensions; aggregate buckets can outrank a single toxic symbol.
    expect(r.toxicCohorts[0]!.dimension).toBe("capTier");
    expect(r.toxicCohorts[0]!.key).toBe("HIGH_BETA_ALT");
    expect(r.toxicCohorts[0]!.sumR).toBeLessThan(-4);
  });

  // [3] hour-of-day + day-of-week bucketed in UTC
  it("[3] buckets hour-of-day and day-of-week in UTC", () => {
    const ts = Date.parse("2026-06-03T14:30:00.000Z"); // Wed 14h UTC
    const r = buildEntryCohortDiagnostic([
      order({ openedAtMs: ts, status: "PAPER_CLOSED_WIN", netR: 1 }),
    ]);
    const hod = r.dimensions.find((d) => d.dimension === "hourOfDayUTC")!;
    const dow = r.dimensions.find((d) => d.dimension === "dayOfWeekUTC")!;
    expect(hod.cohorts[0]!.key).toBe("14h");
    expect(dow.cohorts[0]!.key).toBe("Wed");
  });

  // [4] admissionDelay bucket from createdAt − openedAt; capTier classification
  it("[4] buckets admission delay and classifies cap tier", () => {
    const opened = Date.parse("2026-06-03T08:00:00.000Z");
    const r = buildEntryCohortDiagnostic([
      order({ symbol: "BTCUSDT", openedAtMs: opened, createdAtMs: opened + 400_000, status: "PAPER_CLOSED_WIN", netR: 1 }),
      order({ symbol: "FETUSDT", openedAtMs: opened, createdAtMs: opened + 30_000, status: "PAPER_CLOSED_LOSS", netR: -1 }),
    ]);
    const delay = r.dimensions.find((d) => d.dimension === "admissionDelayBucket")!;
    expect(delay.cohorts.map((c) => c.key).sort()).toEqual(["300-600s", "<=60s"].sort());
    const cap = r.dimensions.find((d) => d.dimension === "capTier")!;
    expect(cap.cohorts.find((c) => c.key === "LARGE_CAP")!.closed).toBe(1); // BTC
    expect(cap.cohorts.find((c) => c.key === "HIGH_BETA_ALT")!.closed).toBe(1); // FET
  });

  // [5] open orders excluded from economics, counted as openCount
  it("[5] open orders contribute openCount but not economics", () => {
    const r = buildEntryCohortDiagnostic([
      order({ symbol: "ETHUSDT", status: "PAPER_CLOSED_WIN", netR: 1 }),
      order({ symbol: "ETHUSDT", status: "PAPER_SUBMITTED" }), // open
    ]);
    expect(r.totalClosed).toBe(1);
    expect(r.totalOpen).toBe(1);
    const eth = r.dimensions.find((d) => d.dimension === "symbol")!.cohorts[0]!;
    expect(eth.closed).toBe(1);
    expect(eth.openCount).toBe(1);
    expect(eth.netAvgR).toBeCloseTo(1, 6); // open didn't move economics
  });

  // [6] dimension list + custom dims selection
  it("[6] exposes the full dimension list and honors a custom subset", () => {
    expect(ENTRY_COHORT_DIMENSIONS).toContain("symbol");
    expect(ENTRY_COHORT_DIMENSIONS).toContain("regime");
    expect(ENTRY_COHORT_DIMENSIONS).toContain("chaseRisk");
    const r = buildEntryCohortDiagnostic([order({ status: "PAPER_CLOSED_WIN", netR: 1 })], {
      dimensions: ["symbol", "direction"],
    });
    expect(r.dimensions.map((d) => d.dimension)).toEqual(["symbol", "direction"]);
  });

  // [7] brief lines render baseline, dimensions, and toxic list
  it("[7] brief lines render baseline + toxic cohorts", () => {
    const orders = [
      ...Array.from({ length: 3 }, () => order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1 })),
      order({ symbol: "BTCUSDT", status: "PAPER_CLOSED_WIN", netR: 2 }),
    ];
    const text = buildEntryCohortDiagnosticBriefLines(buildEntryCohortDiagnostic(orders)).join("\n");
    expect(text).toContain("ENTRY-QUALITY / COHORT DIAGNOSTIC");
    expect(text).toContain("baseline:");
    expect(text).toContain("symbol");
    expect(text).toContain("toxicCohorts");
    expect(text).toContain("SEIUSDT");
  });

  // [8] ISOLATION: pure read — no store write, no headline/gate change
  it("[8] does not write store, headline metrics, liveBlocked, or microPilotAllowed", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ symbol: "ETHUSDT", status: "PAPER_CLOSED_WIN", netR: 1, id: "k1" }));
    store.add(order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, id: "k2" }));
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    buildEntryCohortDiagnostic(store.all);

    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(true);
    expect(gateAfter.microPilotAllowed).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  buildToxicSymbolGateDiagnostic,
  buildToxicSymbolGateDiagnosticBriefLines,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

const tmpDir = () => mkdtempSync(join(os.tmpdir(), "toxic-gate-test-"));

function order(args: {
  symbol: string;
  status?: PaperOrderStatus;
  netR?: number | null;
  id?: string;
}): PaperOrder {
  const opened = Date.parse("2026-06-03T08:00:00.000Z");
  return {
    paperOrderId: args.id ?? `t-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(opened).toISOString(),
    updatedAt: new Date(opened + 3_600_000).toISOString(),
    openedAt: new Date(opened).toISOString(),
    symbol: args.symbol,
    direction: "SHORT",
    regime: "BEARISH_PRESSURE",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 800,
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

const win = (symbol: string, r = 1, id?: string) =>
  order({ symbol, status: "PAPER_CLOSED_WIN", netR: r, id });
const loss = (symbol: string, r = -1, id?: string) =>
  order({ symbol, status: "PAPER_CLOSED_LOSS", netR: r, id });

const gate = (rep: ReturnType<typeof buildToxicSymbolGateDiagnostic>, id: string) =>
  rep.gates.find((g) => g.gateId === id)!;

describe("toxic-symbol gate simulation V1 (DIAGNOSTIC-ONLY)", () => {
  // A representative book: toxic alts bleed, large-caps clean.
  const book = (): PaperOrder[] => [
    ...Array.from({ length: 6 }, (_, i) => loss("SEIUSDT", -1, `sei${i}`)),
    ...Array.from({ length: 5 }, (_, i) => loss("WLDUSDT", -0.8, `wld${i}`)),
    win("SEIUSDT", 0.5, "seiwin"), // one SEI win to be sacrificed
    ...Array.from({ length: 10 }, (_, i) => win("BTCUSDT", 1, `btc${i}`)),
    ...Array.from({ length: 10 }, (_, i) => win("ETHUSDT", 1, `eth${i}`)),
    ...Array.from({ length: 6 }, (_, i) => win("ARBUSDT", 0.4, `arb${i}`)), // healthy alt
  ];

  // [1] exact toxic gate removes exactly SEI/WLD/OP/FET
  it("[1] EXCLUDE_EXACT_TOXIC_SYMBOLS removes the named symbols", () => {
    const r = buildToxicSymbolGateDiagnostic(book());
    const g = gate(r, "EXCLUDE_EXACT_TOXIC_SYMBOLS");
    expect(g.tradesRemoved).toBe(6 + 5 + 1); // SEI(6L+1W) + WLD(5L)
    expect(g.winsSacrificed).toBe(1); // the one SEI win
    expect(g.lossesAvoided).toBe(11); // 6 SEI losses + 5 WLD losses
    expect(g.netImprovementR).toBeGreaterThan(0);
    expect(g.topAvoidedLosers[0]!.symbol).toMatch(/SEIUSDT|WLDUSDT/);
  });

  // [2] net-negative gate honors n>=minSample & netAvgR<threshold
  it("[2] EXCLUDE_NET_NEG_SYMBOLS follows n / minAvgR thresholds", () => {
    // WLD avg -0.8 (n=5) qualifies; a 4-sample -1 symbol does NOT (n<5)
    const orders = [
      ...Array.from({ length: 5 }, (_, i) => loss("WLDUSDT", -0.8, `w${i}`)),
      ...Array.from({ length: 4 }, (_, i) => loss("TINYUSDT", -1, `t${i}`)), // n=4 < 5
      ...Array.from({ length: 20 }, (_, i) => win("BTCUSDT", 1, `b${i}`)),
    ];
    const g = gate(buildToxicSymbolGateDiagnostic(orders, { netNegMinSample: 5, netNegThreshold: -0.5 }), "EXCLUDE_NET_NEG_SYMBOLS");
    expect(g.tradesRemoved).toBe(5); // only WLD
    expect(g.topAvoidedLosers.every((x) => x.symbol === "WLDUSDT")).toBe(true);
    expect(g.overfitRisk).toBe("HIGH"); // in-sample fit
  });

  // [3] large-cap-only keeps only large-cap symbols
  it("[3] LARGE_CAP_ONLY retains only large-cap cohort", () => {
    const r = buildToxicSymbolGateDiagnostic(book());
    const g = gate(r, "LARGE_CAP_ONLY");
    expect(g.filteredClosed).toBe(20); // BTC10 + ETH10 only
    // EXCLUDE_HIGH_BETA_ALT is the same partition with binary capTier
    expect(gate(r, "EXCLUDE_HIGH_BETA_ALT").filteredClosed).toBe(20);
  });

  // [4] removed wins/losses counted correctly + improvement math
  it("[4] netImprovementR equals minus the removed sumR", () => {
    const r = buildToxicSymbolGateDiagnostic(book());
    const g = gate(r, "EXCLUDE_EXACT_TOXIC_SYMBOLS");
    // removed: SEI 6×-1 +1×0.5 = -5.5 ; WLD 5×-0.8 = -4.0 ; total removed -9.5
    expect(g.netImprovementR).toBeCloseTo(9.5, 6);
    expect(g.filteredSumR).toBeCloseTo(g.originalSumR + 9.5, 6);
    expect(g.avgRImprovement).toBeGreaterThan(0);
  });

  // [5] hybrid filter keeps large-cap + provenance-positive alts, drops exact toxic
  it("[5] HYBRID_SAFE_FILTER keeps large-cap and positive-provenance alts", () => {
    const posAlt = order({ symbol: "DOGEUSDT", status: "PAPER_CLOSED_WIN", netR: 1, id: "doge" });
    posAlt.provenance = { routeMode: "PROFIT_CANDIDATE" } as PaperOrder["provenance"];
    const orders = [
      win("BTCUSDT", 1, "b1"),
      loss("SEIUSDT", -1, "s1"), // exact toxic → dropped
      win("ARBUSDT", 0.4, "a1"), // alt, no provenance → dropped
      posAlt, // alt with positive provenance → kept
    ];
    const g = gate(buildToxicSymbolGateDiagnostic(orders), "HYBRID_SAFE_FILTER");
    expect(g.filteredClosed).toBe(2); // BTC + DOGE(positive)
    expect(g.tradesRemoved).toBe(2); // SEI + ARB
  });

  // [6] ISOLATION: pure read — no store write, no headline/gate change
  it("[6] does not write store, headline metrics, liveBlocked, or microPilotAllowed", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    for (const o of book()) store.add(o);
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    buildToxicSymbolGateDiagnostic(store.all);

    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(true);
    expect(gateAfter.microPilotAllowed).toBe(false);
  });

  // [7] endpoint-shape: ranked recommendations rendered in brief
  it("[7] renders ranked recommendations + in-sample warning", () => {
    const r = buildToxicSymbolGateDiagnostic(book());
    expect(r.bestByNetImprovement).not.toBeNull();
    expect(r.bestRecommendedGate).not.toBeNull();
    const text = buildToxicSymbolGateDiagnosticBriefLines(r).join("\n");
    expect(text).toContain("TOXIC-SYMBOL GATE SIM V1");
    expect(text).toContain("EXCLUDE_EXACT_TOXIC_SYMBOLS");
    expect(text).toContain("bestRecommendedGate=");
    expect(text).toContain("IN-SAMPLE");
  });

  // [8] a gate that doesn't help is not recommended
  it("[8] DO_NOT_USE when filtering removes net-positive trades", () => {
    // a book where exact-toxic symbols were actually fine here → removing them hurts
    const orders = [
      ...Array.from({ length: 20 }, (_, i) => win("SEIUSDT", 1, `s${i}`)), // SEI all wins
      ...Array.from({ length: 5 }, (_, i) => loss("BTCUSDT", -1, `b${i}`)),
    ];
    const g = gate(buildToxicSymbolGateDiagnostic(orders), "EXCLUDE_EXACT_TOXIC_SYMBOLS");
    expect(g.avgRImprovement).toBeLessThan(0);
    expect(g.recommendation).toBe("DO_NOT_USE");
  });
});

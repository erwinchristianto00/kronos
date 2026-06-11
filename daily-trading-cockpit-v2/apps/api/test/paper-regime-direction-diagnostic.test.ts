import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  buildRegimeDirectionDiagnostic,
  buildRegimeDirectionDiagnosticBriefLines,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

const tmpDir = () => mkdtempSync(join(os.tmpdir(), "regime-dir-test-"));

function order(args: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  regime?: string | null;
  status?: PaperOrderStatus;
  netR?: number | null;
  id?: string;
}): PaperOrder {
  const opened = Date.parse("2026-06-03T08:00:00.000Z");
  return {
    paperOrderId: args.id ?? `rd-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(opened).toISOString(),
    updatedAt: new Date(opened + 20 * 3_600_000).toISOString(), // 20h hold
    openedAt: new Date(opened).toISOString(),
    symbol: args.symbol ?? "BTCUSDT",
    direction: args.direction ?? "SHORT",
    regime: args.regime ?? "Bearish pressure",
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

// Representative book:
//  - 24 BTC SHORT wins  (large-cap, bearish) → strong
//  - 12 SEI SHORT losses (high-beta toxic, bearish) → toxic
//  - 2  ETH LONG wins   (tiny long sample) → insufficient
function book(): PaperOrder[] {
  return [
    ...Array.from({ length: 24 }, (_, i) => order({ symbol: "BTCUSDT", direction: "SHORT", status: "PAPER_CLOSED_WIN", netR: 1, id: `btc${i}` })),
    ...Array.from({ length: 12 }, (_, i) => order({ symbol: "SEIUSDT", direction: "SHORT", status: "PAPER_CLOSED_LOSS", netR: -0.7, id: `sei${i}` })),
    ...Array.from({ length: 2 }, (_, i) => order({ symbol: "ETHUSDT", direction: "LONG", status: "PAPER_CLOSED_WIN", netR: 1, id: `eth${i}` })),
  ];
}

const bd = (r: ReturnType<typeof buildRegimeDirectionDiagnostic>, name: string) =>
  r.breakdowns.find((b) => b.name === name)!;

describe("regime × direction diagnostic V1 (DIAGNOSTIC-ONLY)", () => {
  // [1] regime × direction grouping with correct economics
  it("[1] groups by regime × direction", () => {
    const r = buildRegimeDirectionDiagnostic(book());
    const c = bd(r, "regimeXdirection").cohorts.find((x) => x.key === "Bearish pressure|SHORT")!;
    expect(c.n).toBe(36); // 24 BTC + 12 SEI
    expect(c.netAvgR!).toBeCloseTo((24 * 1 - 12 * 0.7) / 36, 4); // +0.4333
    expect(c.lossesContributed).toBe(12);
    expect(bd(r, "regimeXdirection").cohorts.find((x) => x.key === "Bearish pressure|LONG")!.n).toBe(2);
  });

  // [2] tiny LONG cohort → INSUFFICIENT_SAMPLE + hiddenLongCandidate INSUFFICIENT
  it("[2] LONG cohort with tiny n returns INSUFFICIENT_SAMPLE", () => {
    const r = buildRegimeDirectionDiagnostic(book());
    const lng = bd(r, "longOnly").cohorts.find((x) => x.key === "LONG")!;
    expect(lng.n).toBe(2);
    expect(lng.confidence).toBe("INSUFFICIENT");
    expect(lng.recommendation).toBe("INSUFFICIENT_SAMPLE");
    expect(r.conclusions.hiddenLongCandidate).toBe("INSUFFICIENT");
  });

  // [3] toxic high-beta short cohort is identified
  it("[3] toxic high-beta short cohort flagged TOXIC / AVOID", () => {
    const r = buildRegimeDirectionDiagnostic(book());
    expect(r.conclusions.highBetaAltShortQuality).toBe("TOXIC");
    const tox = bd(r, "capTierByRegimeDirection").cohorts.find((x) =>
      x.key.startsWith("HIGH_BETA_ALT|"),
    )!;
    expect(tox.confidence).toBe("TOXIC");
    expect(tox.recommendation).toBe("AVOID");
  });

  // [4] large-cap short cohort reaches PROMISING_FORWARD_PAPER
  it("[4] large-cap short cohort can be STRONG / PROMISING_FORWARD_PAPER", () => {
    const r = buildRegimeDirectionDiagnostic(book());
    expect(r.conclusions.largeCapShortQuality).toBe("STRONG");
    const lc = bd(r, "capTierByRegimeDirection").cohorts.find((x) => x.key.startsWith("LARGE_CAP|"))!;
    expect(lc.confidence).toBe("STRONG");
    expect(lc.recommendation).toBe("PROMISING_FORWARD_PAPER");
    expect(r.conclusions.bestRegimeDirection).toBe("Bearish pressure|SHORT");
    expect(r.conclusions.suggestedForwardPaperGateCandidates.length).toBeGreaterThan(0);
  });

  // [5]/[6]/[7]/[8] ISOLATION: pure read — no store write, no headline/gate change
  it("[5-8] does not write store, headline metrics, liveBlocked, or microPilotAllowed", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    for (const o of book()) store.add(o);
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    buildRegimeDirectionDiagnostic(store.all);

    expect(readFileSync(store.path, "utf-8")).toBe(before); // [5] no store write
    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR); // [6]
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(true); // [7]
    expect(gateAfter.microPilotAllowed).toBe(false); // [8]
  });

  // [9] endpoint renders top-level conclusions
  it("[9] brief lines render the cohort table + conclusions", () => {
    const text = buildRegimeDirectionDiagnosticBriefLines(buildRegimeDirectionDiagnostic(book())).join("\n");
    expect(text).toContain("REGIME × DIRECTION DIAGNOSTIC V1");
    expect(text).toContain("regimeXdirection");
    expect(text).toContain("CONCLUSIONS");
    expect(text).toContain("bestRegimeDirection=");
    expect(text).toContain("hiddenLongCandidate=");
    expect(text).toContain("largeCapShortQuality=");
    expect(text).toContain("suggestedForwardPaperGateCandidates=");
  });
});

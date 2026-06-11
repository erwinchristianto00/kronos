import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  evaluateForwardGate,
  stampForwardGateMetadata,
  buildForwardGateValidation,
  buildForwardGateValidationBriefLines,
  FORWARD_GATE_ID,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  type PaperOrder,
  type PaperOrderStatus,
  type ForwardGateDecision,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";

const CG_WIDE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "fwd-gate-test-"));

function order(args: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  regime?: string | null;
  laneId?: string;
  status?: PaperOrderStatus;
  netR?: number | null;
  labeled?: ForwardGateDecision | null;
  id?: string;
}): PaperOrder {
  const opened = Date.parse("2026-06-03T08:00:00.000Z");
  const o: PaperOrder = {
    paperOrderId: args.id ?? `f-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(opened).toISOString(),
    updatedAt: new Date(opened + 20 * 3_600_000).toISOString(),
    openedAt: new Date(opened).toISOString(),
    symbol: args.symbol ?? "BTCUSDT",
    direction: args.direction ?? "SHORT",
    regime: args.regime ?? "Bearish pressure",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: args.laneId ?? CG_WIDE,
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
  if (args.labeled != null) {
    o.forwardGateId = FORWARD_GATE_ID;
    o.forwardGateVersion = 1;
    o.forwardGateDecision = args.labeled;
    o.forwardGateReasons = [];
    o.forwardGateEvaluatedAt = new Date(opened).toISOString();
  }
  return o;
}

describe("forward-paper gate validation harness V1 (SHADOW LABEL)", () => {
  // ── evaluator ──
  it("[1] PASS when non-toxic, bearish, SHORT, CG_WIDE", () => {
    const e = evaluateForwardGate({ laneId: CG_WIDE, regime: "Bearish pressure", direction: "SHORT", symbol: "BTCUSDT" });
    expect(e.forwardGateDecision).toBe("PASS");
    expect(e.forwardGateIsToxicSymbol).toBe(false);
    expect(e.forwardGateCapTier).toBe("LARGE_CAP");
  });

  it("[2] REJECT when symbol is toxic", () => {
    for (const sym of ["SEIUSDT", "WLDUSDT", "OPUSDT", "FETUSDT"]) {
      const e = evaluateForwardGate({ laneId: CG_WIDE, regime: "Bearish pressure", direction: "SHORT", symbol: sym });
      expect(e.forwardGateDecision).toBe("REJECT");
      expect(e.forwardGateReasons).toContain("TOXIC_SYMBOL");
    }
  });

  it("[3] REJECT when direction is LONG", () => {
    const e = evaluateForwardGate({ laneId: CG_WIDE, regime: "Bearish pressure", direction: "LONG", symbol: "BTCUSDT" });
    expect(e.forwardGateDecision).toBe("REJECT");
    expect(e.forwardGateReasons).toContain("DIRECTION_NOT_SHORT");
  });

  it("[4] REJECT when regime is not bearish", () => {
    const e = evaluateForwardGate({ laneId: CG_WIDE, regime: "Mixed rotation", direction: "SHORT", symbol: "BTCUSDT" });
    expect(e.forwardGateDecision).toBe("REJECT");
    expect(e.forwardGateReasons).toContain("REGIME_NOT_BEARISH");
  });

  it("[5] INSUFFICIENT_CONTEXT when required metadata missing", () => {
    const e = evaluateForwardGate({ laneId: CG_WIDE, regime: null, direction: "SHORT", symbol: "BTCUSDT" });
    expect(e.forwardGateDecision).toBe("INSUFFICIENT_CONTEXT");
    expect(e.forwardGateReasons).toContain("MISSING_METADATA");
  });

  // ── stamping (persistence onto new orders) ──
  it("[6] stamps forwardGate metadata on a new CG_WIDE order; skips non-CG_WIDE", () => {
    const now = new Date().toISOString();
    const cg = stampForwardGateMetadata(order({ symbol: "BTCUSDT" }), now);
    expect(cg.forwardGateId).toBe(FORWARD_GATE_ID);
    expect(cg.forwardGateDecision).toBe("PASS");
    expect(cg.forwardGateEvaluatedAt).toBe(now);
    expect(cg.forwardGateCapTier).toBe("LARGE_CAP");

    const other = stampForwardGateMetadata(order({ laneId: "SOME_OTHER_LANE" }), now);
    expect(other.forwardGateId).toBeUndefined(); // non-CG_WIDE untouched
  });

  // ── legacy reporting (no mutation) ──
  it("[7] legacy orders reported as LEGACY_UNLABELED without store mutation", () => {
    const legacy = [
      order({ symbol: "BTCUSDT", id: "L1" }),
      order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, id: "L2" }),
    ]; // no labeled flag → no forwardGateId
    const r = buildForwardGateValidation(legacy);
    expect(r.legacyUnlabeled).toBe(2);
    expect(r.totalLabeled).toBe(0);
    expect(legacy[0]!.forwardGateId).toBeUndefined(); // builder did not mutate
    expect(r.reconstructedInSample.closed).toBeGreaterThanOrEqual(1); // read-only reconstruction present
  });

  // ── cohort stats + simulated filtered book ──
  const labeledBook = (): PaperOrder[] => [
    order({ symbol: "BTCUSDT", status: "PAPER_CLOSED_WIN", netR: 1, labeled: "PASS", id: "p1" }),
    order({ symbol: "ETHUSDT", status: "PAPER_CLOSED_WIN", netR: 1, labeled: "PASS", id: "p2" }),
    order({ symbol: "SOLUSDT", status: "PAPER_CLOSED_WIN", netR: 1, labeled: "PASS", id: "p3" }),
    order({ symbol: "ADAUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, labeled: "PASS", id: "p4" }),
    order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, labeled: "REJECT", id: "r1" }),
    order({ symbol: "WLDUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, labeled: "REJECT", id: "r2" }),
    order({ symbol: "OPUSDT", status: "PAPER_CLOSED_WIN", netR: 0.5, labeled: "REJECT", id: "r3" }),
  ];

  it("[8] reports pass/reject cohort stats", () => {
    const r = buildForwardGateValidation(labeledBook());
    expect(r.pass.n).toBe(4);
    expect(r.pass.netAvgR!).toBeCloseTo((1 + 1 + 1 - 1) / 4, 6); // +0.5
    expect(r.reject.n).toBe(3);
    expect(r.reject.netAvgR!).toBeCloseTo((-1 - 1 + 0.5) / 3, 6); // -0.5
    expect(r.closedLabeled).toBe(7);
  });

  it("[9] simulated filtered book computes wins/losses/improvement correctly", () => {
    const s = buildForwardGateValidation(labeledBook()).simulated;
    expect(s.tradesRemoved).toBe(3); // the 3 rejects
    expect(s.winsSacrificed).toBe(1); // OP reject was a +0.5 winner
    expect(s.lossesAvoided).toBe(2); // SEI + WLD reject losers
    expect(s.passSumR).toBeCloseTo(2, 6); // +1+1+1-1
    expect(s.originalSumR).toBeCloseTo(0.5, 6); // 2 + (-1-1+0.5)
    expect(s.netImprovementR).toBeCloseTo(1.5, 6);
    expect(s.sampleRetentionPct).toBeCloseTo((4 / 7) * 100, 4);
  });

  it("[9b] verdict abstains below OOS sample floor", () => {
    const r = buildForwardGateValidation(labeledBook());
    expect(r.oosConfidence).toBe("INSUFFICIENT"); // <20 labeled
    expect(r.recommendation).toBe("KEEP_MEASURING");
    expect(r.activeGateChange).toBe("NO");
  });

  // ── isolation ──
  it("[10-13] no store write / headline / liveBlocked / microPilot change", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    for (const o of labeledBook()) store.add(o);
    store.add(order({ symbol: "BTCUSDT", id: "legacy1" })); // unlabeled legacy
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    buildForwardGateValidation(store.all); // [10/11] pure read

    expect(readFileSync(store.path, "utf-8")).toBe(before); // no store write
    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(true); // [12]
    expect(gateAfter.microPilotAllowed).toBe(false); // [13]
  });

  it("[14] brief lines render the shadow-label block with activeGateChange=NO", () => {
    const text = buildForwardGateValidationBriefLines(buildForwardGateValidation(labeledBook())).join("\n");
    expect(text).toContain(`forwardGate[${FORWARD_GATE_ID}]`);
    expect(text).toContain("SHADOW LABEL");
    expect(text).toContain("passNet=");
    expect(text).toContain("simulatedImprovement");
    expect(text).toContain("activeGateChange=NO");
  });
});

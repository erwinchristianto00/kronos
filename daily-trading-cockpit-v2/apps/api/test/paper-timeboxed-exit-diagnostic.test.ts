import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import Fastify from "fastify";
import { describe, it, expect } from "vitest";

import {
  buildTimeboxedExitDiagnostic,
  buildTimeboxedExitDiagnosticBriefLines,
  PAPER_EXECUTION_MODEL_IDEAL,
  getPaperExecutionRouterStore,
  _resetPaperExecutionRouterStoreForTests,
  type PaperResolverClient,
  type PaperKlineTuple,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const CANDLE_MS = 5 * 60 * 1000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** SHORT, entry 100 / stop 103 / tp 96 / 300bps. Behavior is driven by the symbol. */
function order(args: {
  symbol: string;
  openedAtMs: number;
  status?: PaperOrderStatus;
  netR?: number | null;
  id?: string;
}): PaperOrder {
  const opened = iso(args.openedAtMs);
  return {
    paperOrderId: args.id ?? `tb-${args.symbol}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: `${args.symbol}:lane`,
    createdAt: opened,
    updatedAt: iso(args.openedAtMs + 26 * HOUR), // real run-to-completion ~26h later
    openedAt: opened,
    symbol: args.symbol,
    direction: "SHORT",
    regime: "BULLISH_EXPANSION",
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
    paperStatus: args.status ?? "PAPER_SUBMITTED",
    grossR: null,
    costR: null,
    netR: args.netR ?? null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

/** Deterministic candle path keyed off the symbol name. 1m always returns []. */
const client: PaperResolverClient = {
  getKlines: async (symbol, interval, o) => {
    if (interval === "1m") return [];
    let h = 101,
      l = 99,
      c = 100; // neutral (no hit)
    if (symbol.includes("MTMLOSS")) [h, l, c] = [102, 99.5, 101]; // drift to a small loss
    else if (symbol.includes("MTM")) [h, l, c] = [102, 97, 98]; // drift to a small profit
    else if (symbol.includes("TP")) [h, l, c] = [100.5, 95, 96]; // SHORT TP hit (low ≤ 96)
    else if (symbol.includes("SL")) [h, l, c] = [104, 101, 103]; // SHORT SL hit (high ≥ 103)
    const out: PaperKlineTuple[] = [];
    for (let t = o.startTime; t <= o.endTime; t += CANDLE_MS) {
      out.push([t, "0", String(h), String(l), String(c), "0", t + CANDLE_MS]);
    }
    return out;
  },
};

const COST = -(22 / 300); // _computePaperCostR for 300bps
const cfg = (h: number) => ({ laneId: `CG_TIMEBOXED_EXIT_${h}H_DIAGNOSTIC`, timeboxHours: h, executionModel: PAPER_EXECUTION_MODEL_IDEAL });

describe("timeboxed-exit counterfactual diagnostic (DIAGNOSTIC-ONLY)", () => {
  // [1] mechanics: bins TP/SL-within-box, MTM, incomplete window; never touches reals
  it("[1] classifies outcomes and computes counterfactual economics", async () => {
    const now = Date.now();
    const old = now - 10 * HOUR; // 4h box fully elapsed
    const orders = [
      order({ symbol: "TPSYM", openedAtMs: old, status: "PAPER_CLOSED_WIN", netR: 1.26, id: "A" }),
      order({ symbol: "SLSYM", openedAtMs: old, status: "PAPER_CLOSED_LOSS", netR: -1.0733, id: "B" }),
      order({ symbol: "MTMSYM", openedAtMs: old, status: "PAPER_SUBMITTED", id: "C" }), // open
      order({ symbol: "TPSYM2", openedAtMs: now - 1 * HOUR, status: "PAPER_SUBMITTED", id: "D" }), // too young
    ];

    const r = await buildTimeboxedExitDiagnostic(orders, client, cfg(4));

    expect(r.diagnosticOnly).toBe(true);
    expect(r.sampleSize).toBe(3); // A, B, C (D incomplete)
    expect(r.resolvedWithinBox).toBe(2); // A(TP), B(SL)
    expect(r.timeboxedMtm).toBe(1); // C
    expect(r.incompleteWindow).toBe(1); // D
    expect(r.dataFailures).toBe(0);
    expect(r.closedSampleSize).toBe(2); // A, B
    expect(r.openWouldCloseCount).toBe(1); // C is open and would have exited
    // box economics: TP=+1.26, SL=-1.0733, MTM(close98)=(100-98)/3+COST
    const mtmNet = 2 / 3 + COST;
    expect(r.boxNetAvgR!).toBeCloseTo((1.26 - 1.0733 + mtmNet) / 3, 3);
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE"); // 2 < 20 closed
  });

  // [2] PRESERVES: box outcome == real outcome → delta ~0
  it("[2] verdict PRESERVES when timebox reproduces the real outcome", async () => {
    const old = Date.now() - 10 * HOUR;
    const realTpNet = 4 / 3 + COST; // TP within box and real both hit TP
    const orders = Array.from({ length: 25 }, (_, i) =>
      order({ symbol: `TP_${i}`, openedAtMs: old, status: "PAPER_CLOSED_WIN", netR: realTpNet, id: `p${i}` }),
    );
    const r = await buildTimeboxedExitDiagnostic(orders, client, cfg(4));
    expect(r.closedSampleSize).toBe(25);
    expect(r.expectancyDeltaR!).toBeCloseTo(0, 3);
    expect(r.verdict).toBe("TIMEBOX_PRESERVES_EXPECTANCY");
  });

  // [3] DEGRADES: real eventually won (+R) but at the 4h cap it was underwater
  it("[3] verdict DEGRADES when the box exits a would-be winner at a loss", async () => {
    const old = Date.now() - 10 * HOUR;
    const realWinNet = 4 / 3 + COST; // real run-to-completion won
    const orders = Array.from({ length: 25 }, (_, i) =>
      order({ symbol: `MTMLOSS_${i}`, openedAtMs: old, status: "PAPER_CLOSED_WIN", netR: realWinNet, id: `d${i}` }),
    );
    const r = await buildTimeboxedExitDiagnostic(orders, client, cfg(4));
    // box marks each to market at close=101 → (100-101)/3 + COST (a loss)
    expect(r.boxNetAvgROnClosed!).toBeCloseTo(-1 / 3 + COST, 3);
    expect(r.expectancyDeltaR!).toBeLessThan(-0.05);
    expect(r.verdict).toBe("TIMEBOX_DEGRADES_EXPECTANCY");
  });

  // [4] brief lines render the diagnostic label and stay clearly diagnostic-only
  it("[4] brief lines render the lane verdict + diagnostic framing", async () => {
    const old = Date.now() - 10 * HOUR;
    const r4 = await buildTimeboxedExitDiagnostic(
      [order({ symbol: "MTMSYM", openedAtMs: old })],
      client,
      cfg(4),
    );
    const r8 = await buildTimeboxedExitDiagnostic(
      [order({ symbol: "MTMSYM", openedAtMs: old })],
      client,
      cfg(8),
    );
    const text = buildTimeboxedExitDiagnosticBriefLines([r4, r8]).join("\n");
    expect(text).toContain("TIMEBOXED-EXIT DIAGNOSTIC");
    expect(text).toContain("excluded from headline");
    expect(text).toContain("CG_TIMEBOXED_EXIT_4H_DIAGNOSTIC");
    expect(text).toContain("CG_TIMEBOXED_EXIT_8H_DIAGNOSTIC");
    expect(text).toContain("ΔexpectancyR=");
    expect(text).toContain("real CG_WIDE exit untouched");
  });

  // [5] empty input → no crash, empty report
  it("[5] no source orders → zeroed report, verdict abstains", async () => {
    const r = await buildTimeboxedExitDiagnostic([], client, cfg(4));
    expect(r.sampleSize).toBe(0);
    expect(r.boxNetAvgR).toBeNull();
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE");
  });
});

// ── GET /api/shadow/timebox-exit-diagnostic endpoint ────────────────────────
describe("timebox-exit-diagnostic endpoint — repeated ?boxes querystring key", () => {
  // Fastify parses a repeated key (?boxes=4&boxes=8) as string[], not the string
  // the route's TS generic declares — .split(",") on that array throws uncaught.
  it("does not 500 when ?boxes is supplied twice", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(mkdtempSync(join(os.tmpdir(), "timebox-endpoint-test-")));
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null, {
      binanceClient: { getCandles: async () => [] },
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/shadow/timebox-exit-diagnostic?boxes=4&boxes=8",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reports.length).toBe(2);
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });
});

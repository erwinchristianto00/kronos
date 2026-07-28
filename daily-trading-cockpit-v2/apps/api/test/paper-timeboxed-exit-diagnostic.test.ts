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
import { STOP_OUT_SLIPPAGE_BPS, TAKER_ROUNDTRIP_BPS } from "../src/lib/current-guard-variant-matrix.js";
import { REALISTIC_FEE_BPS_PER_SIDE } from "../src/lib/shadow-engine.js";
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

/**
 * v2 exit-aware cost (PAPER_COST_MODEL_V2, ON by default since 9d2bf3d), mirroring
 * _computePaperExitCostR for these fixtures: taker fill, 300bps planned stop, priced through the
 * IDEAL model with viaWalk=false.
 *
 *   chargedBps = max(feeOnlyFloor, roundTrip + stopOutSurcharge − slipAlreadyInGross)
 *
 * Derived from the SAME exported constants the implementation reads, not copied as a literal — the
 * old `-(22 / 300)` silently encoded the v1 flat model and went stale the moment v2 became the
 * default. The counterfactual re-walk calls the cost fn WITHOUT an exit timestamp, so no funding
 * period is ever charged here (only resolvePaperOrders passes one).
 *
 * The only kind that moves vs v1 is STOP_LIKE, which now pays STOP_OUT_SLIPPAGE_BPS on top — the
 * asymmetry v1 lacked, and the whole reason a timebox that converts winners into stop-outs must not
 * be priced as if a stop cost the same as a take-profit.
 */
const STOP_BPS = 300;
const costR = (kind: "TP_LIKE" | "STOP_LIKE" | "MARK_TO_MARKET"): number => {
  const slipInGross =
    PAPER_EXECUTION_MODEL_IDEAL.entrySlippageBps +
    (kind === "TP_LIKE" ? PAPER_EXECUTION_MODEL_IDEAL.tpSlippageBps : PAPER_EXECUTION_MODEL_IDEAL.stopSlippageBps);
  const charged = Math.max(
    REALISTIC_FEE_BPS_PER_SIDE * 2,
    TAKER_ROUNDTRIP_BPS + (kind === "STOP_LIKE" ? STOP_OUT_SLIPPAGE_BPS : 0) - slipInGross,
  );
  return -(charged / STOP_BPS);
};
const COST_TP = costR("TP_LIKE");
const COST_STOP = costR("STOP_LIKE");
const COST_MTM = costR("MARK_TO_MARKET");
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
    // Box economics, priced per exit kind (the box re-walks each leg; it does NOT reuse the
    // order's stored netR). A(TP) and C(MTM) are unchanged from v1; B is a stop-out and now pays
    // the STOP_OUT_SLIPPAGE_BPS surcharge, which is exactly the cost a timebox forcing an exit
    // into a stop is supposed to be charged.
    const tpNet = 4 / 3 + COST_TP;
    const slNet = -1 + COST_STOP;
    const mtmNet = 2 / 3 + COST_MTM; // MTM at close=98 → (100−98)/3
    expect(r.boxNetAvgR!).toBeCloseTo((tpNet + slNet + mtmNet) / 3, 3);
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE"); // 2 < 20 closed
  });

  // [2] PRESERVES: box outcome == real outcome → delta ~0
  it("[2] verdict PRESERVES when timebox reproduces the real outcome", async () => {
    const old = Date.now() - 10 * HOUR;
    const realTpNet = 4 / 3 + COST_TP; // TP within box and real both hit TP
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
    const realWinNet = 4 / 3 + COST_TP; // real run-to-completion won
    const orders = Array.from({ length: 25 }, (_, i) =>
      order({ symbol: `MTMLOSS_${i}`, openedAtMs: old, status: "PAPER_CLOSED_WIN", netR: realWinNet, id: `d${i}` }),
    );
    const r = await buildTimeboxedExitDiagnostic(orders, client, cfg(4));
    // box marks each to market at close=101 → (100-101)/3 + COST_MTM (a loss)
    expect(r.boxNetAvgROnClosed!).toBeCloseTo(-1 / 3 + COST_MTM, 3);
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

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import Fastify from "fastify";

import {
  buildFastTpTightDiagnostic,
  buildFastTpTightDiagnosticBriefLines,
  buildFastTpVariants,
  buildFastTpTrailSweepVariants,
  buildFastTpTrailGridVariants,
  rankFastTpReports,
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  PAPER_EXECUTION_MODEL_IDEAL,
  PAPER_COST_MODEL_VERSION,
  getPaperExecutionRouterStore,
  _resetPaperExecutionRouterStoreForTests,
  type FastTpVariant,
  type PaperResolverClient,
  type PaperKlineTuple,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { STOP_OUT_SLIPPAGE_BPS, TAKER_ROUNDTRIP_BPS } from "../src/lib/current-guard-variant-matrix.js";
import { REALISTIC_FEE_BPS_PER_SIDE } from "../src/lib/shadow-engine.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const CANDLE_MS = 5 * 60 * 1000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
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
 * period is charged here (only resolvePaperOrders passes one).
 *
 * Which constant a case uses is NOT cosmetic: this diagnostic exists to compare a tight TP against
 * the original wide target, and the two policies differ in HOW they exit. Pricing a trail-stop exit
 * as if it were a resting take-profit is exactly the bias STOP_OUT_SLIPPAGE_BPS exists to remove,
 * and it flatters every policy that converts winners into stop-outs.
 */
const STOP_BPS = 300;
const costR = (kind: "TP_LIKE" | "STOP_LIKE" | "MARK_TO_MARKET"): number => {
  const m = PAPER_EXECUTION_MODEL_IDEAL;
  const slipInGross = m.entrySlippageBps + (kind === "TP_LIKE" ? m.tpSlippageBps : m.stopSlippageBps);
  const charged = Math.max(
    REALISTIC_FEE_BPS_PER_SIDE * 2,
    TAKER_ROUNDTRIP_BPS + (kind === "STOP_LIKE" ? STOP_OUT_SLIPPAGE_BPS : 0) - slipInGross,
  );
  return -(charged / STOP_BPS);
};
const COST_TP = costR("TP_LIKE");
const COST_STOP = costR("STOP_LIKE");
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "fast-tp-test-"));

// SHORT, entry 100 / stop 103 (risk 3) / wide tp 96 / 300bps.
function order(args: {
  symbol?: string;
  openedAtMs: number;
  status?: PaperOrderStatus;
  netR?: number | null;
  realHoldH?: number;
  id?: string;
}): PaperOrder {
  const opened = args.openedAtMs;
  return {
    paperOrderId: args.id ?? "ft-1",
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: iso(opened),
    updatedAt: iso(opened + (args.realHoldH ?? 26) * HOUR),
    openedAt: iso(opened),
    symbol: args.symbol ?? "ETHUSDT",
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
const NEUTRAL: OHLC = { h: 101, l: 99, c: 100 }; // no level touched

/** Client whose 5m path is an indexed sequence (index 0 = the pre-entry candle). 1m → []. */
function seqClient(seq: (i: number) => OHLC): PaperResolverClient {
  return {
    getKlines: async (_symbol, interval, o) => {
      if (interval === "1m") return []; // → _resolve1mForPaper null → conservative stop-first
      const out: PaperKlineTuple[] = [];
      let i = 0;
      for (let t = o.startTime; t <= o.endTime; t += CANDLE_MS) {
        const k = seq(i);
        out.push([t, "0", String(k.h), String(k.l), String(k.c), "0", t + CANDLE_MS]);
        i += 1;
      }
      return out;
    },
  };
}

const v = (id: string): FastTpVariant[] => {
  const all = buildFastTpVariants([0.25, 0.5, 0.75], true);
  return [all.find((x) => x.id === id)!];
};

describe("fast/tight-TP counterfactual diagnostic (DIAGNOSTIC-ONLY)", () => {
  const OLD = Date.now() - 48 * HOUR;

  // [1] full tight TP banks at +0.5R and closes earlier than the real run-to-completion
  it("[1] full tight TP closes earlier when the tight TP is hit", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 })); // 98.4 ≤ 98.5 (0.5R)
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26, realHoldH: 26 })];
    const [r] = await buildFastTpTightDiagnostic(orders, client, v("TP_0_50R_FULL"), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    expect(r.sampleSize).toBe(1);
    expect(r.netAvgR!).toBeCloseTo(0.5 + COST_TP, 4); // +0.5R − fees
    expect(r.wr).toBe(1);
    expect(r.winsAccelerated).toBe(1); // real winner, closed far earlier
    expect(r.originalWinnersCutTooEarly).toBe(1); // 0.43R < real 1.26R
    expect(r.p50HoldHours!).toBeLessThan(26); // earlier than the real 26h hold
  });

  // [2] the original stop still applies — a stop-first path is a full −1R loss
  it("[2] stop still applies (tight TP does not bypass the stop)", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 104, l: 99, c: 101 })); // high≥103 SL, low>98.5
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_LOSS", netR: -1.0733 })];
    const [r] = await buildFastTpTightDiagnostic(orders, client, v("TP_0_50R_FULL"), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    expect(r.netAvgR!).toBeCloseTo(-1 + COST_STOP, 4);
    expect(r.wr).toBe(0);
    expect(r.sameCandleAmbiguityCount).toBe(0);
  });

  // [3] same-candle tight-TP + stop is refined on 1m; no 1m data → conservative stop-first
  it("[3] same-candle ambiguity handled conservatively (counts + resolves to the stop)", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 104, l: 98, c: 101 })); // both 98.5 TP & 103 SL
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_LOSS", netR: -1.0733 })];
    const [r] = await buildFastTpTightDiagnostic(orders, client, v("TP_0_50R_FULL"), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    expect(r.sameCandleAmbiguityCount).toBe(1);
    expect(r.netAvgR!).toBeCloseTo(-1 + COST_STOP, 4); // conservative → stop-first loss
  });

  // [COST-MODEL] The counterfactuals must price a stop-out ABOVE a take-profit.
  //
  // WHY THIS EXISTS (2026-07-28): 9d2bf3d flipped PAPER_COST_MODEL_V2 from opt-in (=== "1") to
  // opt-out (!== "0") and added a funding term. These three diagnostic files priced their expected R
  // from a hardcoded `-(22 / 300)` — the v1 FLAT cost — so they broke, and the shape of the break was
  // the giveaway: exactly the stop-exit assertions moved, by exactly STOP_OUT_SLIPPAGE_BPS/stopBps.
  //
  // Asserting the numbers alone would go stale the same way. This asserts the CONTRACT through the
  // public diagnostic API instead: whatever the absolute costs are, a stop-like exit must cost the
  // stop-out surcharge MORE than a take-profit. Under the v1 flat model that gap is exactly 0, so
  // this test fails the moment the diagnostics silently fall back to it — which is the failure
  // nobody noticed for a full commit.
  //
  // It matters beyond bookkeeping: this diagnostic recommends tight-TP policies, and policies that
  // convert winners into stop-outs are precisely the ones a flat cost model flatters.
  it("[COST-MODEL] a stop exit costs the stop-out surcharge more than a TP exit", async () => {
    expect(PAPER_COST_MODEL_VERSION).toBe(2); // names the cause if the default is ever flipped back

    const tpClient = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 })); // tight TP, no stop
    const stopClient = seqClient((i) => (i === 0 ? NEUTRAL : { h: 104, l: 99, c: 101 })); // stop, no TP
    const opts = { executionModel: PAPER_EXECUTION_MODEL_IDEAL };
    const [tp] = await buildFastTpTightDiagnostic(
      [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26 })],
      tpClient,
      v("TP_0_50R_FULL"),
      opts,
    );
    const [stop] = await buildFastTpTightDiagnostic(
      [order({ openedAtMs: OLD, status: "PAPER_CLOSED_LOSS", netR: -1.0733 })],
      stopClient,
      v("TP_0_50R_FULL"),
      opts,
    );

    // Back out the cost each path was charged by removing its known gross R (+0.5R / −1R).
    const tpCost = tp.netAvgR! - 0.5;
    const stopCost = stop.netAvgR! - -1;
    expect(tpCost).toBeCloseTo(COST_TP, 6);
    expect(stopCost).toBeCloseTo(COST_STOP, 6);
    // The asymmetry itself — 0 under v1's flat cost, STOP_OUT_SLIPPAGE_BPS/stopBps under v2.
    expect(tpCost - stopCost).toBeCloseTo(STOP_OUT_SLIPPAGE_BPS / STOP_BPS, 6);
    expect(stopCost).toBeLessThan(tpCost);
  });

  // [4] partial runner math: 50% at +0.5R, 50% runs to the original wide TP (+1.33R)
  it("[4] partial KEEP_ORIGINAL_RUNNER blends the scaled-out leg and the runner", async () => {
    // i1: tight 0.5R hit (low 98.4, no SL); i2: wide TP hit (low 95.5 ≤ 96)
    const client = seqClient((i) =>
      i === 1 ? { h: 100, l: 98.4, c: 99 } : i === 2 ? { h: 99, l: 95.5, c: 96 } : NEUTRAL,
    );
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26 })];
    const [r] = await buildFastTpTightDiagnostic(
      orders,
      client,
      v("TP_0_50R_PARTIAL_50_KEEP_ORIGINAL_RUNNER"),
      { executionModel: PAPER_EXECUTION_MODEL_IDEAL },
    );
    // 0.5*0.5R + 0.5*1.3333R − fees
    expect(r.netAvgR!).toBeCloseTo(0.5 * 0.5 + 0.5 * (4 / 3) + COST_TP, 4);
    expect(r.wr).toBe(1);
  });

  // [4b] partial MOVE_STOP_TO_BE: runner stopped at break-even → only the scaled leg pays
  it("[4b] partial MOVE_STOP_TO_BE runner stopped at BE contributes 0R", async () => {
    const client = seqClient((i) =>
      i === 1 ? { h: 100, l: 98.4, c: 99 } : i === 2 ? { h: 100.5, l: 99, c: 100 } : NEUTRAL,
    ); // i2 high≥100 → BE stop
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26 })];
    const [r] = await buildFastTpTightDiagnostic(
      orders,
      client,
      v("TP_0_50R_PARTIAL_50_MOVE_STOP_TO_BE"),
      { executionModel: PAPER_EXECUTION_MODEL_IDEAL },
    );
    expect(r.netAvgR!).toBeCloseTo(0.5 * 0.5 + 0.5 * 0 + COST_STOP, 4); // 0.25R − fees
  });

  // [5] losersSaved: a real LOSS where the tight TP triggers before the stop flips to a win
  it("[5] a real loser rescued by the tight TP counts as originalLosersSaved", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 })); // tight first, no SL
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_LOSS", netR: -1.0733 })];
    const [r] = await buildFastTpTightDiagnostic(orders, client, v("TP_0_50R_FULL"), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    expect(r.originalLosersSaved).toBe(1);
    expect(r.netAvgR!).toBeCloseTo(0.5 + COST_TP, 4);
  });

  // [6] ISOLATION: the diagnostic writes nothing to the paper store
  it("[6] does not write the paper store", async () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26, id: "keep" }));
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 }));
    await buildFastTpTightDiagnostic(store.all, client, buildFastTpVariants([0.25, 0.5, 0.75], true), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    expect(readFileSync(store.path, "utf-8")).toBe(before); // byte-identical
  });

  // [7] ISOLATION: headline metrics + live gate are untouched by the diagnostic
  it("[7] does not affect headline metrics, liveBlocked, or microPilotAllowed", async () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26, id: "h1" }));
    store.add(order({ openedAtMs: OLD, status: "PAPER_CLOSED_LOSS", netR: -1.0733, id: "h2" }));

    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 }));
    await buildFastTpTightDiagnostic(store.all, client, buildFastTpVariants([0.25, 0.5, 0.75], true), {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });

    const perfAfter = buildPaperPerformanceReport(store);
    const gateAfter = buildLiveTradingGateReport({});

    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    expect(gateAfter.liveBlocked).toBe(gateBefore.liveBlocked);
    expect(gateAfter.microPilotAllowed).toBe(gateBefore.microPilotAllowed);
    expect(gateBefore.liveBlocked).toBe(true); // sanity: still blocked
    expect(gateBefore.microPilotAllowed).toBe(false);
  });

  // [8] brief lines render every variant with diagnostic framing
  it("[8] brief lines render variants + diagnostic-only framing", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 }));
    const reports = await buildFastTpTightDiagnostic(
      [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26 })],
      client,
      buildFastTpVariants([0.25, 0.5, 0.75], true),
      { executionModel: PAPER_EXECUTION_MODEL_IDEAL },
    );
    const text = buildFastTpTightDiagnosticBriefLines(reports).join("\n");
    expect(text).toContain("FAST/TIGHT-TP DIAGNOSTIC");
    expect(text).toContain("excluded from headline");
    expect(text).toContain("TP_0_25R_FULL");
    expect(text).toContain("TP_0_50R_PARTIAL_50_KEEP_ORIGINAL_RUNNER");
    expect(text).toContain("TP_0_75R_PARTIAL_50_TRAIL");
    expect(text).toContain("winsAccelerated=");
    expect(text).toContain("real CG_WIDE exit untouched");
  });

  // [9] verdict abstains below the minimum closed sample
  it("[9] verdict INSUFFICIENT_SAMPLE under the closed-sample floor", async () => {
    const client = seqClient((i) => (i === 0 ? NEUTRAL : { h: 100, l: 98.4, c: 99 }));
    const [r] = await buildFastTpTightDiagnostic(
      [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26 })],
      client,
      v("TP_0_50R_FULL"),
      { executionModel: PAPER_EXECUTION_MODEL_IDEAL },
    );
    expect(r.verdict).toBe("INSUFFICIENT_SAMPLE");
  });
});

describe("fast-TP trailing-stop sweep", () => {
  const OLD = Date.now() - 48 * HOUR;

  // [S1] sweep generates the 5 trail-distance variants (base 0.75R / 50% partial)
  it("[S1] buildFastTpTrailSweepVariants generates the trail-distance ladder", () => {
    const vs = buildFastTpTrailSweepVariants();
    expect(vs.map((x) => x.id)).toEqual([
      "TP_0_75R_PARTIAL_50_TRAIL_0_25R",
      "TP_0_75R_PARTIAL_50_TRAIL_0_50R",
      "TP_0_75R_PARTIAL_50_TRAIL_0_75R",
      "TP_0_75R_PARTIAL_50_TRAIL_1_00R",
      "TP_0_75R_PARTIAL_50_TRAIL_1_25R",
    ]);
    for (const x of vs) {
      expect(x.triggerR).toBe(0.75);
      expect(x.partialFraction).toBe(0.5);
      expect(x.runnerRule).toBe("TRAIL");
      expect(x.trailDistanceR).toBeGreaterThan(0);
    }
    // secondary grid: 3 firstTP × 3 partials × 3 trail = 27
    expect(buildFastTpTrailGridVariants().length).toBe(27);
  });

  // Scenario: 0.75R partial at i1; runner makes MFE then a bounce.
  // A tight trail exits on the bounce (earlier); a wide trail rides to the wide TP.
  const sweepClient = seqClient((i) =>
    i === 1
      ? { h: 99, l: 97.7, c: 98 } // tight 0.75R (97.75) hit, no SL
      : i === 2
        ? { h: 98, l: 96.8, c: 97.3 } // MFE deepens; tight trail stop grazed by the high
        : i === 3
          ? { h: 98.5, l: 96, c: 96.2 } // wide TP (96) touched, high below the wide trail
          : NEUTRAL,
  );

  // [S2]/[S3] tighter trail exits earlier; wider trail preserves more runner upside
  it("[S2/S3] tighter trail exits earlier, wider trail keeps more upside", async () => {
    const variants: FastTpVariant[] = buildFastTpTrailSweepVariants([0.25, 1.0]);
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26, realHoldH: 26 })];
    const reports = await buildFastTpTightDiagnostic(orders, sweepClient, variants, {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    const tight = reports.find((r) => r.trailDistanceR === 0.25)!;
    const wide = reports.find((r) => r.trailDistanceR === 1.0)!;

    // tighter trail exits on the bounce candle (earlier) via the trailing stop
    expect(tight.trailStopHitCount).toBe(1);
    expect(tight.runnerToOriginalTargetCount).toBe(0);
    // wider trail rides through the bounce to the original wide TP
    expect(wide.trailStopHitCount).toBe(0);
    expect(wide.runnerToOriginalTargetCount).toBe(1);
    // wider trail keeps more upside; tighter trail closes sooner
    expect(wide.netAvgR!).toBeGreaterThan(tight.netAvgR!);
    expect(tight.avgHoldHours!).toBeLessThan(wide.avgHoldHours!);
    // tight runner exit ≈ 0.375 (partial) + 0.5*0.8167 (stop@97.55) − fees
    expect(tight.netAvgR!).toBeCloseTo(0.5 * 0.75 + 0.5 * ((100 - 97.55) / 3) + COST_STOP, 3);
    // wide runner exit ≈ 0.375 + 0.5*1.3333 (wide TP) − fees
    expect(wide.netAvgR!).toBeCloseTo(0.5 * 0.75 + 0.5 * (4 / 3) + COST_TP, 3);
  });

  // [S4] ranking exposes bestBalancedTradeoff and the per-metric leaders
  it("[S4] rankFastTpReports returns ranked leaders incl. bestBalancedTradeoff", async () => {
    const variants = buildFastTpTrailSweepVariants([0.25, 1.0]);
    const orders = [order({ openedAtMs: OLD, status: "PAPER_CLOSED_WIN", netR: 1.26, realHoldH: 26 })];
    const reports = await buildFastTpTightDiagnostic(orders, sweepClient, variants, {
      executionModel: PAPER_EXECUTION_MODEL_IDEAL,
    });
    const ranking = rankFastTpReports(reports);
    expect(ranking.bestByNetAvgR).toBe("TP_0_75R_PARTIAL_50_TRAIL_1_00R"); // wider keeps more R
    expect(ranking.bestByHoldReduction).toBe("TP_0_75R_PARTIAL_50_TRAIL_0_25R"); // tighter exits sooner
    expect(ranking.bestBalancedTradeoff).not.toBeNull();
    expect(Object.keys(ranking.balancedScores).length).toBe(2);
  });
});

// ── GET /api/shadow/fast-tp-diagnostic endpoint ─────────────────────────────
describe("fast-tp-diagnostic endpoint — repeated ?variants querystring key", () => {
  // Fastify parses a repeated key (?variants=0.25&variants=0.5) as string[], not
  // the string the route's TS generic declares. Two call sites read this same
  // field (a .trim().toLowerCase() mode check, then a .split(",") level parse) —
  // both must survive a non-string value without throwing.
  it("does not 500 when ?variants is supplied twice", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(tmpDir());
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null, {
      binanceClient: { getCandles: async () => [] },
    } as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/shadow/fast-tp-diagnostic?variants=0.25&variants=0.5",
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().reports)).toBe(true);
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  PaperExecutionRouterStore,
  resolvePaperOrders,
  PAPER_EXECUTION_MODEL_IDEAL,
  PAPER_EXECUTION_MODEL_REALISTIC,
  type PaperResolverClient,
  type PaperKlineTuple,
  type PaperOrder,
} from "../src/lib/paper-execution-router.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "paper-exec-realism-test-"));
}

/** SHORT order: entry 100, stop 103 (above), tp 96 (below), risk distance 300bps. */
function shortOrder(openedAt: string, id = "o1"): PaperOrder {
  const now = new Date().toISOString();
  return {
    paperOrderId: id,
    sourceObservationId: `obs-${id}`,
    sourceSignalId: null,
    dedupeKey: `${id}:lane`,
    createdAt: now,
    updatedAt: now,
    openedAt,
    symbol: "ETHUSDT",
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
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

/** Two 5m candles: a neutral first bar, then a triggering second bar. 1m returns []. */
function klineClient(second: { high: number; low: number; close: number }): PaperResolverClient {
  return {
    getKlines: async (_s, interval, opts) => {
      if (interval === "1m") return [];
      const signalMs = opts.startTime + 300_000; // openedAt
      return [
        [signalMs - 300_000, "0", "100.4", "99.6", "100", "0", signalMs] as PaperKlineTuple,
        [
          signalMs,
          "0",
          String(second.high),
          String(second.low),
          String(second.close),
          "0",
          signalMs + 300_000,
        ] as PaperKlineTuple,
      ];
    },
  };
}

async function resolveWith(
  model: typeof PAPER_EXECUTION_MODEL_IDEAL,
  second: { high: number; low: number; close: number },
): Promise<PaperOrder> {
  const store = new PaperExecutionRouterStore(tmpDir());
  const openedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  store.add(shortOrder(openedAt));
  await resolvePaperOrders(store, klineClient(second), model);
  return store.all[0]!;
}

// SHORT: SL hit when high≥103; TP hit when low≤96.
const SL_BAR = { high: 104, low: 101, close: 103 };
const TP_BAR = { high: 100.5, low: 95.5, close: 96 };

describe("paper execution realism (live-preview slippage)", () => {
  // [1] IDEAL model preserves the legacy perfect-fill numbers
  it("[1] IDEAL: stop fills exactly at -1R, TP fills at nominal reward", async () => {
    const loss = await resolveWith(PAPER_EXECUTION_MODEL_IDEAL, SL_BAR);
    expect(loss.paperStatus).toBe("PAPER_CLOSED_LOSS");
    expect(loss.grossR).toBeCloseTo(-1, 6); // (100−103)/3

    const win = await resolveWith(PAPER_EXECUTION_MODEL_IDEAL, TP_BAR);
    expect(win.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(win.grossR).toBeCloseTo(4 / 3, 6); // (100−96)/3
  });

  // [2] REALISTIC: a stop-market exit fills PAST the stop → loss worse than −1R (telat-jual)
  it("[2] REALISTIC: stop slippage makes the loss exceed 1R", async () => {
    const loss = await resolveWith(PAPER_EXECUTION_MODEL_REALISTIC, SL_BAR);
    expect(loss.paperStatus).toBe("PAPER_CLOSED_LOSS");
    // SHORT: Ef=100*(1−2bps)=99.98, Sf=103*(1+5bps)=103.0515 → (99.98−103.0515)/3
    expect(loss.grossR!).toBeCloseTo((99.98 - 103.0515) / 3, 5);
    expect(loss.grossR!).toBeLessThan(-1); // strictly worse than the ideal stop
  });

  // [3] REALISTIC: entry slippage trims the win below nominal (telat-masuk)
  it("[3] REALISTIC: entry slippage reduces the realized win R", async () => {
    const win = await resolveWith(PAPER_EXECUTION_MODEL_REALISTIC, TP_BAR);
    expect(win.paperStatus).toBe("PAPER_CLOSED_WIN");
    // Ef=99.98, Tf=96 (tpSlip=0, resting limit) → (99.98−96)/3
    expect(win.grossR!).toBeCloseTo((99.98 - 96) / 3, 5);
    expect(win.grossR!).toBeLessThan(4 / 3); // below the ideal reward
    expect(win.grossR!).toBeGreaterThan(0);
  });

  // [4] netR still layers fees (costR) on top of the slipped grossR — no double count
  it("[4] netR = slipped grossR + fee costR", async () => {
    const loss = await resolveWith(PAPER_EXECUTION_MODEL_REALISTIC, SL_BAR);
    expect(loss.costR!).toBeLessThan(0); // taker fee
    expect(loss.netR!).toBeCloseTo(loss.grossR! + loss.costR!, 6);
    expect(loss.netR!).toBeLessThan(loss.grossR!); // fees make it worse still
  });

  // [5] zero stop-slippage override collapses the loss back to exactly −1R minus entry drift
  it("[5] stopSlip=0 override removes the past-the-stop penalty", async () => {
    const loss = await resolveWith(
      { entrySlippageBps: 0, stopSlippageBps: 0, tpSlippageBps: 0 },
      SL_BAR,
    );
    expect(loss.grossR).toBeCloseTo(-1, 6);
  });
});

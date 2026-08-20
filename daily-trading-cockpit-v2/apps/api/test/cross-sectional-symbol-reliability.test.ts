import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCurrentCrossSectionalPolicyFingerprint } from "../src/lib/cross-sectional-policy.js";
import type { ExecutorBasket, ExecutorLeg } from "../src/lib/cross-sectional-executor.js";
import {
  CrossSectionalSymbolReliabilityStore,
  SYMBOL_RELIABILITY_EVIDENCE_CONTRACT,
} from "../src/lib/cross-sectional-symbol-reliability.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2099-06-30T12:00:00.000Z");
const UNIVERSE = ["BADUSDT", "L1USDT", "L2USDT", "L3USDT", "L4USDT", "S1USDT", "S2USDT", "S3USDT"];

const exactHold36Policy = buildCurrentCrossSectionalPolicyFingerprint("2099-01-01T00:00:00.000Z", {
  CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "36",
  CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
  CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
  CROSS_SECTIONAL_EXEC_STOP_NET_RETURN: undefined,
} as NodeJS.ProcessEnv);

function leg(symbol: string, side: "LONG" | "SHORT", netMovePct: number, favorableR = 1): ExecutorLeg {
  const entryPrice = 100;
  const exitPrice = side === "LONG"
    ? entryPrice * (1 + netMovePct)
    : entryPrice * (1 - netMovePct);
  return {
    symbol,
    side,
    qty: 1,
    entryPrice,
    entryOrderId: `entry-${symbol}-${side}`,
    entryPriceConfirmed: true,
    exitPrice,
    exitOrderId: `exit-${symbol}-${side}`,
    exitPriceConfirmed: true,
    maxFavorableR: favorableR,
    maxAdverseR: -0.5,
  };
}

function exactBasket(
  id: string,
  openedAtMs: number,
  long: Array<[string, number]>,
  short: Array<[string, number]> = [["S1USDT", 0.02], ["S2USDT", 0.02], ["S3USDT", 0.02]],
): ExecutorBasket {
  const legs = [
    ...long.map(([symbol, move]) => leg(symbol, "LONG", move)),
    ...short.map(([symbol, move]) => leg(symbol, "SHORT", move)),
  ];
  const grossPnlUsd = legs.reduce((sum, item) => sum + (item.side === "LONG"
    ? item.qty * (item.exitPrice! - item.entryPrice)
    : item.qty * (item.entryPrice - item.exitPrice!)), 0);
  const feeEstimateUsd = 0.6;
  return {
    basketId: id,
    sourceObservationId: `obs-${id}`,
    signal: "MOM36_FILTERED",
    variant: "FILTERED",
    openedAt: new Date(openedAtMs).toISOString(),
    closesAtMs: openedAtMs + 36 * HOUR,
    policyFingerprint: exactHold36Policy,
    legs,
    status: "CLOSED",
    closedAt: new Date(openedAtMs + 36 * HOUR).toISOString(),
    closeReason: "HORIZON",
    grossPnlUsd,
    feeEstimateUsd,
    netPnlUsd: grossPnlUsd - feeEstimateUsd,
  } as ExecutorBasket;
}

/** Two concurrent 3L/3S baskets make one independent episode with five long-side peers. */
function deterioratingEpisodes(count: number): ExecutorBasket[] {
  const rows: ExecutorBasket[] = [];
  for (let index = 0; index < count; index++) {
    const openedAtMs = NOW - (26 - index * 2) * DAY;
    rows.push(exactBasket(`bad-${index}`, openedAtMs, [["BADUSDT", -0.04], ["L1USDT", 0.03], ["L2USDT", 0.025]]));
    rows.push(exactBasket(`peer-${index}`, openedAtMs, [["L3USDT", 0.03], ["L4USDT", 0.025], ["L1USDT", 0.02]]));
  }
  return rows;
}

function freshStore(): CrossSectionalSymbolReliabilityStore {
  return new CrossSectionalSymbolReliabilityStore(mkdtempSync(join(tmpdir(), "symbol-reliability-")));
}

describe("Symbol Reliability V1", () => {
  it("uses only exact actual NoTP + Hold36 HORIZON baskets and exposes every required diagnostic window", () => {
    const actual = deterioratingEpisodes(8);
    const wrongHorizon = exactBasket("wrong-horizon", NOW - 3 * DAY, [["BADUSDT", -0.04], ["L1USDT", 0.03], ["L2USDT", 0.025]]);
    wrongHorizon.policyFingerprint = buildCurrentCrossSectionalPolicyFingerprint("2099-01-01T00:00:00.000Z", {
      CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "24",
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
    } as NodeJS.ProcessEnv);
    const tp = exactBasket("tp", NOW - 4 * DAY, [["BADUSDT", -0.04], ["L1USDT", 0.03], ["L2USDT", 0.025]]);
    tp.policyFingerprint = buildCurrentCrossSectionalPolicyFingerprint("2099-01-01T00:00:00.000Z", {
      CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "36",
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "0",
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
    } as NodeJS.ProcessEnv);
    const notHorizon = exactBasket("operator-close", NOW - 5 * DAY, [["BADUSDT", -0.04], ["L1USDT", 0.03], ["L2USDT", 0.025]]);
    notHorizon.closeReason = "OPERATOR";

    const snapshot = freshStore().evaluate({ baskets: [...actual, wrongHorizon, tp, notHorizon], universe: UNIVERSE, nowMs: NOW });
    const bad = snapshot.statuses.find((row) => row.symbol === "BADUSDT" && row.side === "LONG")!;

    expect(snapshot.evidenceContract).toBe(SYMBOL_RELIABILITY_EVIDENCE_CONTRACT);
    expect(snapshot.eligibleBaskets).toBe(16);
    expect(snapshot.independentEpisodes).toBe(8); // concurrent baskets are one independent episode
    expect(snapshot.excludedBaskets).toMatchObject({ NOT_HOLD_36H: 1, NOT_NOTP_POLICY: 1, NOT_HORIZON: 1 });
    expect(bad.independentN).toBe(8);
    expect(bad.windows.map((window) => window.key)).toEqual(["30D", "60D", "90D", "CURRENT_QUARTER", "2Y_REFERENCE"]);
    expect(bad.windows.every((window) => window.independentN === 8)).toBe(true);
    expect(bad.meanContribution).toBeLessThan(0);
    expect(bad.profitFactor).toBe(0);
    expect(bad.cvar5).toBeLessThan(0);
    expect(bad.winnerToLoserDamageRate).toBe(1);
    expect(bad.status).toBe("DEGRADED"); // strict deterioration needs a second evidence cycle before quarantine
    expect(bad.pendingDowngradeEvaluations).toBe(1);
  });

  it("requires two distinct evidence cycles to quarantine, persists across restart, and never flips just because a day rolled", () => {
    const dir = mkdtempSync(join(tmpdir(), "symbol-reliability-restart-"));
    const firstStore = new CrossSectionalSymbolReliabilityStore(dir);
    const first = firstStore.evaluate({ baskets: deterioratingEpisodes(8), universe: UNIVERSE, nowMs: NOW });
    const firstBad = first.statuses.find((row) => row.symbol === "BADUSDT" && row.side === "LONG")!;
    expect(firstBad.status).toBe("DEGRADED");

    const afterDailySchedule = firstStore.evaluate({ baskets: deterioratingEpisodes(8), universe: UNIVERSE, nowMs: NOW + DAY });
    const scheduledBad = afterDailySchedule.statuses.find((row) => row.symbol === "BADUSDT" && row.side === "LONG")!;
    expect(afterDailySchedule.evidenceChanged).toBe(false);
    expect(scheduledBad.status).toBe("DEGRADED");
    expect(scheduledBad.pendingDowngradeEvaluations).toBe(1);

    // Global data changed, but BADUSDT itself did not. A peer's new outcome must not be used as
    // the second confirmation for BADUSDT's quarantine hysteresis.
    const unrelated = exactBasket("unrelated-peer", NOW - 3 * DAY, [["L1USDT", 0.02], ["L2USDT", 0.02], ["L3USDT", 0.02]]);
    const peerOnlyUpdate = firstStore.evaluate({ baskets: [...deterioratingEpisodes(8), unrelated], universe: UNIVERSE, nowMs: NOW + DAY });
    const peerOnlyBad = peerOnlyUpdate.statuses.find((row) => row.symbol === "BADUSDT" && row.side === "LONG")!;
    expect(peerOnlyUpdate.evidenceChanged).toBe(true);
    expect(peerOnlyBad.status).toBe("DEGRADED");
    expect(peerOnlyBad.pendingDowngradeEvaluations).toBe(1);

    const restarted = new CrossSectionalSymbolReliabilityStore(dir);
    const withNewEpisode = deterioratingEpisodes(9);
    const second = restarted.evaluate({ baskets: withNewEpisode, universe: UNIVERSE, nowMs: NOW + 2 * DAY });
    const bad = second.statuses.find((row) => row.symbol === "BADUSDT" && row.side === "LONG")!;
    expect(second.evidenceChanged).toBe(true);
    expect(bad.status).toBe("QUARANTINED");
    expect(second.quarantined).toContainEqual(expect.objectContaining({ symbol: "BADUSDT", side: "LONG" }));
  });

  it("persists no-trade formation provenance without becoming an execution dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "symbol-reliability-provenance-"));
    const store = new CrossSectionalSymbolReliabilityStore(dir);
    const snapshot = store.evaluate({ baskets: [], universe: UNIVERSE, nowMs: NOW });
    const decision = {
      version: "SYMBOL_RELIABILITY_V1" as const,
      evaluatedAt: snapshot.evaluatedAt,
      evaluationId: snapshot.evaluationId,
      sourceObservationId: "xsec:MOM36_FILTERED:1",
      decision: "NO_TRADE_INSUFFICIENT_ELIGIBLE" as const,
      candidateListBefore: { LONG: [], SHORT: [] },
      candidateListAfter: { LONG: [], SHORT: [] },
      quarantined: [{ symbol: "BADUSDT", side: "LONG" as const, reason: "test" }],
      selectedBefore: { LONG: ["BADUSDT"], SHORT: ["S1USDT"] },
      selectedAfter: { LONG: [], SHORT: ["S1USDT"] },
      replacements: [{ side: "LONG" as const, removed: "BADUSDT", replacement: null }],
      scoreGapBefore: 0.08,
      scoreGapAfter: null,
      scoreGapFloor: 0.058,
      diagnosticsBySymbolSide: [],
    };
    store.recordFormationDecision(decision);
    const replayed = new CrossSectionalSymbolReliabilityStore(dir);
    expect(replayed.latest()?.lastFormationDecision).toEqual(decision);
  });
});

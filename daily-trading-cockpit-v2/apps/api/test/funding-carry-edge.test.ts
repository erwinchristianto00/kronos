import { describe, it, expect } from "vitest";
import {
  evaluateFundingCarryBreakEven,
  fundingBoundaryAtOrBefore,
  selectFundingCarryCandidates,
  updateOpenFundingCarryObservation,
  buildFundingCarryReport,
  runFundingCarryCycle,
  runFundingCarryCycleGuarded,
  FundingCarryStore,
  FC_FUNDING_INTERVAL_MS,
  FC_PAIR_FEE_BPS,
  FC_FEE_SAFETY_MULTIPLE,
  FC_TARGET_HOLD_HOURS,
  FC_DIVERGENCE_STOP_BPS,
  FC_MAX_HOLD_HOURS,
  FC_MAX_STORED_OBSERVATIONS,
  type FundingCarryObservation,
  type FundingCarrySymbolSnapshot,
} from "../src/lib/funding-carry-edge.js";

/** Boundary-aligned base time for deterministic accrual tests. */
const BASE = fundingBoundaryAtOrBefore(1_000_000_000_000);
const HOUR = 3_600_000;

/** Defaults: 16 bps pair fees × 2 safety / 6 expected intervals (48h/8h) = 5.33 bps per 8h. */
const REQUIRED_DIFF = (FC_PAIR_FEE_BPS / 10_000) * FC_FEE_SAFETY_MULTIPLE / Math.floor(FC_TARGET_HOLD_HOURS / 8);

const STOP = FC_DIVERGENCE_STOP_BPS / 10_000;
const FEE_RETURN = FC_PAIR_FEE_BPS / 10_000;

function snap(symbol: string, fundingRate: number | null, markPrice: number | null = 100): FundingCarrySymbolSnapshot {
  return { symbol, fundingRate, markPrice };
}

/** Fixture cluster map — DI'd so tests never depend on env/the real cluster map. */
const CLUSTERS: Record<string, string> = {
  AAAUSDT: "L1",
  BBBUSDT: "L1",
  CCCUSDT: "L1",
  MMMUSDT: "MEME",
  NNNUSDT: "MEME",
};
const clusterOfFixture = (s: string): string => CLUSTERS[s] ?? "OTHER";

function obs(over: Partial<FundingCarryObservation> = {}): FundingCarryObservation {
  return {
    observationId: "fc:AAAUSDT|BBBUSDT:1",
    pairKey: "AAAUSDT|BBBUSDT",
    cluster: "L1",
    longSymbol: "AAAUSDT",
    shortSymbol: "BBBUSDT",
    openedAt: new Date(BASE + HOUR).toISOString(),
    openedAtMs: BASE + HOUR,
    longEntryPrice: 100,
    shortEntryPrice: 200,
    longFundingAtEntry: 0.0001,
    shortFundingAtEntry: 0.0007,
    diffAtEntry: 0.0006,
    notionalUsdPerLeg: 50,
    divergenceStopReturn: STOP,
    fundingAccruedReturn: 0,
    fundingIntervalsAccrued: 0,
    staleAccruals: 0,
    lastAccrualBoundaryMs: BASE,
    pendingLongRate: 0.0001,
    pendingShortRate: 0.0007,
    lastMarkSpreadReturn: 0,
    dataGapCycles: 0,
    status: "OPEN",
    exitReason: null,
    fundingR: null,
    divergenceR: null,
    costR: null,
    netR: null,
    holdHours: null,
    resolvedAt: null,
    ...over,
  };
}

/** Flat legs at entry prices (no divergence), rates as given. */
function legs(longRate: number | null, shortRate: number | null, longMark: number | null = 100, shortMark: number | null = 200) {
  return { longFundingRate: longRate, shortFundingRate: shortRate, longMarkPrice: longMark, shortMarkPrice: shortMark };
}

describe("funding-carry — break-even entry math", () => {
  it("computes the documented threshold: pairFees × safety / expectedIntervals", () => {
    const be = evaluateFundingCarryBreakEven(0);
    expect(be.feeReturn).toBeCloseTo(FEE_RETURN, 10);
    expect(be.expectedIntervals).toBe(Math.floor(FC_TARGET_HOLD_HOURS / 8));
    expect(be.requiredDiffPerInterval).toBeCloseTo(REQUIRED_DIFF, 10);
  });

  it("rejects a differential just below the threshold and accepts one at/above it", () => {
    expect(evaluateFundingCarryBreakEven(REQUIRED_DIFF * 0.99).passes).toBe(false);
    expect(evaluateFundingCarryBreakEven(REQUIRED_DIFF).passes).toBe(true);
    expect(evaluateFundingCarryBreakEven(REQUIRED_DIFF * 1.5).passes).toBe(true);
  });

  it("rejects garbage differentials", () => {
    expect(evaluateFundingCarryBreakEven(Number.NaN).passes).toBe(false);
    expect(evaluateFundingCarryBreakEven(-0.001).passes).toBe(false);
  });

  it("[cycle] a below-break-even differential NEVER opens a pair", async () => {
    const store = new FundingCarryStore(`/tmp/fc-be-${Date.now()}-${Math.random()}.json`);
    const rates: Record<string, number> = { AAAUSDT: 0.0001, BBBUSDT: 0.0001 + REQUIRED_DIFF * 0.5 };
    const result = await runFundingCarryCycle({
      store,
      universe: ["AAAUSDT", "BBBUSDT"],
      now: BASE + HOUR,
      fetchPremiumIndex: async (s) => ({ fundingRate: rates[s] ?? null, markPrice: 100 }),
      clusterOfFn: clusterOfFixture,
    });
    expect(result.pairsEvaluated).toBe(1);
    expect(result.belowBreakeven).toBe(1);
    expect(result.recorded).toBe(0);
    expect(store.all).toHaveLength(0);
  });
});

describe("funding-carry — same-cluster candidate selection", () => {
  it("orients the pair LONG the low-funding leg, SHORT the high-funding leg", () => {
    const scan = selectFundingCarryCandidates(
      [snap("AAAUSDT", -0.0005), snap("BBBUSDT", 0.0004)],
      clusterOfFixture,
    );
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]!.longSymbol).toBe("AAAUSDT"); // lower (negative) funding → LONG
    expect(scan.candidates[0]!.shortSymbol).toBe("BBBUSDT"); // higher funding → SHORT (receives)
    expect(scan.candidates[0]!.diffPerInterval).toBeCloseTo(0.0009, 10);
  });

  it("never pairs symbols from DIFFERENT clusters, however wide the differential", () => {
    // AAA (L1) vs MMM (MEME): 30bps apart — but the beta-cancel premise needs one cluster.
    const scan = selectFundingCarryCandidates(
      [snap("AAAUSDT", -0.001), snap("MMMUSDT", 0.002)],
      clusterOfFixture,
    );
    expect(scan.pairsEvaluated).toBe(0);
    expect(scan.candidates).toHaveLength(0);
  });

  it("excludes OTHER-cluster (unknown) symbols entirely — no fake correlation pairs", () => {
    const scan = selectFundingCarryCandidates(
      [snap("XXXUSDT", -0.001), snap("YYYUSDT", 0.002)],
      clusterOfFixture,
    );
    expect(scan.skippedOtherCluster).toBe(2);
    expect(scan.candidates).toHaveLength(0);
  });

  it("skips symbols with missing funding or mark data and counts them honestly", () => {
    const scan = selectFundingCarryCandidates(
      [snap("AAAUSDT", null), snap("BBBUSDT", 0.002), snap("CCCUSDT", 0.0001, null)],
      clusterOfFixture,
    );
    expect(scan.skippedMissingData).toBe(2);
    expect(scan.pairsEvaluated).toBe(0); // only BBB survived — nothing to pair with
  });

  it("ranks candidates by differential, widest first", () => {
    const scan = selectFundingCarryCandidates(
      [snap("AAAUSDT", 0), snap("BBBUSDT", 0.001), snap("CCCUSDT", 0.002)],
      clusterOfFixture,
    );
    expect(scan.candidates[0]!.diffPerInterval).toBeCloseTo(0.002, 10); // AAA vs CCC
  });
});

describe("funding-carry — accrual across 8h boundaries with CHANGING rates", () => {
  it("credits nothing before the first boundary, but tracks the current-period rates", () => {
    const o = obs();
    const patch = updateOpenFundingCarryObservation(o, legs(0.0002, 0.001), BASE + 7 * HOUR);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBeUndefined(); // still OPEN
    expect(patch!.fundingIntervalsAccrued).toBe(0);
    expect(patch!.fundingAccruedReturn).toBe(0);
    expect(patch!.pendingLongRate).toBeCloseTo(0.0002, 10);
    expect(patch!.pendingShortRate).toBeCloseTo(0.001, 10);
  });

  it("credits each boundary at the rate observed BEFORE it — NOT the entry snapshot", () => {
    // Entry diff was 6 bps. By the first boundary the observed diff has moved to 8 bps, and by
    // the second to 3 bps. Total must be 8+3=11 bps — not 2×6.
    let o = obs();
    // tick 1 (pre-boundary): rates moved to 2/10 bps → pending updated.
    let patch = updateOpenFundingCarryObservation(o, legs(0.0002, 0.001), BASE + 7 * HOUR)!;
    o = { ...o, ...patch };
    // tick 2 (just past boundary 1): credited with tick-1 pending (0.001−0.0002=0.0008).
    patch = updateOpenFundingCarryObservation(o, legs(0.0001, 0.0004), BASE + 8 * HOUR + 10 * 60_000)!;
    expect(patch.fundingIntervalsAccrued).toBe(1);
    expect(patch.fundingAccruedReturn).toBeCloseTo(0.0008, 10);
    expect(patch.staleAccruals).toBe(0);
    o = { ...o, ...patch };
    // tick 3 (just past boundary 2): credited with tick-2 pending (0.0004−0.0001=0.0003).
    patch = updateOpenFundingCarryObservation(o, legs(0.0001, 0.0004), BASE + 16 * HOUR + 10 * 60_000)!;
    expect(patch.fundingIntervalsAccrued).toBe(2);
    expect(patch.fundingAccruedReturn).toBeCloseTo(0.0011, 10); // 8bps + 3bps, rates moved
    expect(patch.lastAccrualBoundaryMs).toBe(BASE + 2 * FC_FUNDING_INTERVAL_MS);
  });

  it("credits boundaries missed entirely (process down) at the current rate, flagged stale", () => {
    // No tick between BASE and BASE+16h10m — two boundaries crossed at once. First one uses the
    // entry-time pending rates (observed pre-boundary), the second had NO observer → current rate,
    // counted in staleAccruals.
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0002, 0.0005), BASE + 16 * HOUR + 10 * 60_000)!;
    expect(patch.fundingIntervalsAccrued).toBe(2);
    // interval 1: pending 0.0007−0.0001=0.0006; interval 2: current 0.0005−0.0002=0.0003.
    expect(patch.fundingAccruedReturn).toBeCloseTo(0.0009, 10);
    expect(patch.staleAccruals).toBe(1);
  });

  it("defers (never silently drops) a boundary when no rate data exists to credit it", () => {
    const o = obs({ pendingLongRate: null, pendingShortRate: null });
    const patch = updateOpenFundingCarryObservation(o, legs(null, null), BASE + 9 * HOUR)!;
    expect(patch.fundingIntervalsAccrued).toBe(0);
    expect(patch.lastAccrualBoundaryMs).toBe(BASE); // NOT advanced — a later tick credits it
    expect(patch.dataGapCycles).toBe(1);
    // Later tick with data: boundary is credited (stale-flagged — observed after the fact).
    const later = updateOpenFundingCarryObservation({ ...o, ...patch }, legs(0.0001, 0.0006), BASE + 10 * HOUR)!;
    expect(later.fundingIntervalsAccrued).toBe(1);
    expect(later.fundingAccruedReturn).toBeCloseTo(0.0005, 10);
    expect(later.staleAccruals).toBe(1);
  });
});

describe("funding-carry — divergence stop honesty (the residual IS the risk)", () => {
  it("books the loss at the OBSERVED spread when the pair diverges hard — worse than −1R, never clamped", () => {
    // Long leg −5%, short leg +5% → spread −10% against us, far through the 1.5% stop.
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0001, 0.0007, 95, 210), BASE + 2 * HOUR)!;
    expect(patch.status).toBe("CLOSED_LOSS");
    expect(patch.exitReason).toBe("DIVERGENCE_STOP");
    const expectedSpread = 95 / 100 - 1 - (210 / 200 - 1); // −0.10
    expect(patch.divergenceR).toBeCloseTo(expectedSpread / STOP, 6); // ≈ −6.67R — not clamped to −1
    expect(patch.netR).toBeCloseTo((0 + expectedSpread - FEE_RETURN) / STOP, 6);
    expect(patch.netR!).toBeLessThan(-1);
  });

  it("triggers exactly at the stop distance", () => {
    // Spread exactly −stop: long leg fell by the whole stop distance, short flat.
    const longMark = 100 * (1 - STOP);
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0001, 0.0007, longMark, 200), BASE + 2 * HOUR)!;
    expect(patch.exitReason).toBe("DIVERGENCE_STOP");
    expect(patch.divergenceR).toBeCloseTo(-1, 6);
  });

  it("does NOT trigger on favorable or small adverse spread", () => {
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0001, 0.0007, 100.5, 200), BASE + 2 * HOUR)!;
    expect(patch.status).toBeUndefined(); // still OPEN
    expect(patch.lastMarkSpreadReturn).toBeCloseTo(0.005, 10);
  });
});

describe("funding-carry — collapse + max-hold exits", () => {
  it("closes when the differential collapses below the floor (carry gone → MTM out, fees still paid)", () => {
    // Rates converged to equal → diff 0 < floor. Marks flat → all that's left is the fee bill.
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0003, 0.0003), BASE + 3 * HOUR)!;
    expect(patch.exitReason).toBe("DIFF_COLLAPSED");
    expect(patch.status).toBe("CLOSED_LOSS"); // no funding accrued yet, fees make it a loss
    expect(patch.fundingR).toBeCloseTo(0, 10);
    expect(patch.costR).toBeCloseTo(FEE_RETURN / STOP, 6);
    expect(patch.netR).toBeCloseTo(-FEE_RETURN / STOP, 6);
  });

  it("marks to market at max hold and books accrued funding minus fees", () => {
    const nowMs = BASE + HOUR + FC_MAX_HOLD_HOURS * HOUR;
    // Healthy stable differential the whole way; flat marks.
    const patch = updateOpenFundingCarryObservation(obs(), legs(0.0001, 0.0007), nowMs)!;
    expect(patch.exitReason).toBe("MAX_HOLD_MTM");
    expect(patch.fundingIntervalsAccrued).toBeGreaterThan(0);
    const expectedFunding = patch.fundingAccruedReturn!;
    expect(patch.netR).toBeCloseTo((expectedFunding + 0 - FEE_RETURN) / STOP, 6);
    expect(patch.holdHours).toBeCloseTo(FC_MAX_HOLD_HOURS, 3);
  });

  it("expires a pair that never produced any observable spread long past max hold", () => {
    const o = obs({ pendingLongRate: null, pendingShortRate: null, lastMarkSpreadReturn: null });
    const nowMs = BASE + HOUR + FC_MAX_HOLD_HOURS * HOUR * 3 + HOUR;
    const patch = updateOpenFundingCarryObservation(o, legs(null, null, null, null), nowMs)!;
    expect(patch.status).toBe("EXPIRED");
    expect(patch.netR).toBeUndefined(); // never fabricates a P&L it can't compute
  });

  it("a REAL pair opened via runFundingCarryCycle (not a hand-built fixture) still expires honestly when its marks are never observable — 2026-07-22 fix: lastMarkSpreadReturn must be seeded null, not 0, at creation", async () => {
    const store = new FundingCarryStore(`/tmp/fc-expire-real-${Date.now()}-${Math.random()}.json`);
    const openedAt = BASE + HOUR;
    // Cycle 1: real candidate selection + store.add() opens the pair through the actual production
    // code path (not a manually-constructed obs() fixture) — this is what seeds lastMarkSpreadReturn.
    const opened = await runFundingCarryCycle({
      store,
      universe: ["AAAUSDT", "BBBUSDT"],
      now: openedAt,
      fetchPremiumIndex: async (s) => ({ fundingRate: s === "AAAUSDT" ? -0.0005 : 0.0007, markPrice: 100 }),
      clusterOfFn: clusterOfFixture,
    });
    expect(opened.recorded).toBe(1);
    const realObs = store.all[0]!;
    expect(realObs.lastMarkSpreadReturn).toBeNull(); // the fix: never a fabricated 0

    // From here on, BBBUSDT's marks are never observable again (persistent per-symbol failure).
    const nowMs = openedAt + FC_MAX_HOLD_HOURS * HOUR * 3 + HOUR;
    const patch = updateOpenFundingCarryObservation(
      realObs,
      { longFundingRate: null, shortFundingRate: null, longMarkPrice: null, shortMarkPrice: null },
      nowMs,
    )!;
    expect(patch.status).toBe("EXPIRED");
    expect(patch.netR).toBeUndefined();
    expect(patch.divergenceR).toBeUndefined(); // never a fabricated 0 divergence either
  });
});

describe("funding-carry — exactly-once resolution", () => {
  it("a resolved observation can never be resolved again", () => {
    const closed = obs({ status: "CLOSED_LOSS", netR: -2 });
    expect(updateOpenFundingCarryObservation(closed, legs(0.0001, 0.0007, 50, 400), BASE + 5 * HOUR)).toBeNull();
  });

  it("[cycle] a pair closed in one cycle is untouched by the next cycle with the same data", async () => {
    const store = new FundingCarryStore(`/tmp/fc-once-${Date.now()}-${Math.random()}.json`);
    const rates: Record<string, number> = { AAAUSDT: -0.0005, BBBUSDT: 0.0007 };
    let marks: Record<string, number> = { AAAUSDT: 100, BBBUSDT: 100 };
    const cycleOpts = {
      store,
      universe: ["AAAUSDT", "BBBUSDT"] as const,
      fetchPremiumIndex: async (s: string) => ({ fundingRate: rates[s] ?? null, markPrice: marks[s] ?? null }),
      clusterOfFn: clusterOfFixture,
    };
    const r1 = await runFundingCarryCycle({ ...cycleOpts, now: BASE + HOUR });
    expect(r1.recorded).toBe(1);
    // Pair diverges hard against us → divergence stop on cycle 2.
    marks = { AAAUSDT: 90, BBBUSDT: 110 };
    const r2 = await runFundingCarryCycle({ ...cycleOpts, now: BASE + 2 * HOUR });
    expect(r2.resolved).toBe(1);
    const settled = store.all.find((o) => o.status !== "OPEN")!;
    const netROnce = settled.netR;
    expect(netROnce).not.toBeNull();
    // Cycle 3, same data: nothing re-resolves, the booked netR is untouched, no duplicate obs.
    const r3 = await runFundingCarryCycle({ ...cycleOpts, now: BASE + 3 * HOUR });
    expect(r3.resolved).toBe(0);
    expect(store.all.filter((o) => o.pairKey === settled.pairKey && o.status !== "OPEN")).toHaveLength(1);
    expect(store.all.find((o) => o.observationId === settled.observationId)!.netR).toBe(netROnce);
  });

  it("store.add rejects a duplicate observationId", () => {
    const store = new FundingCarryStore(`/tmp/fc-dup-${Date.now()}-${Math.random()}.json`);
    expect(store.add(obs())).toBe(true);
    expect(store.add(obs())).toBe(false);
    expect(store.all).toHaveLength(1);
  });
});

describe("funding-carry — cycle recording behavior", () => {
  const goodRates: Record<string, number> = { AAAUSDT: -0.0005, BBBUSDT: 0.0007, CCCUSDT: 0.0001 };
  const fetchGood = async (s: string) => ({ fundingRate: goodRates[s] ?? null, markPrice: 100 });

  it("opens the widest-differential same-cluster pair with correct leg orientation and entry state", async () => {
    const store = new FundingCarryStore(`/tmp/fc-open-${Date.now()}-${Math.random()}.json`);
    const now = BASE + HOUR;
    const result = await runFundingCarryCycle({
      store,
      universe: ["AAAUSDT", "BBBUSDT", "CCCUSDT"],
      now,
      fetchPremiumIndex: fetchGood,
      clusterOfFn: clusterOfFixture,
      maxNewPairsPerCycle: 1,
    });
    expect(result.recorded).toBe(1);
    const o = store.all[0]!;
    expect(o.longSymbol).toBe("AAAUSDT"); // −5bps → LONG (we receive its negative funding)
    expect(o.shortSymbol).toBe("BBBUSDT"); // +7bps → SHORT (we receive)
    expect(o.diffAtEntry).toBeCloseTo(0.0012, 10);
    expect(o.lastAccrualBoundaryMs).toBe(fundingBoundaryAtOrBefore(now)); // no credit for the past boundary
    expect(o.pendingLongRate).toBeCloseTo(-0.0005, 10);
    expect(o.pendingShortRate).toBeCloseTo(0.0007, 10);
    expect(o.divergenceStopReturn).toBeCloseTo(STOP, 10);
  });

  it("one open pair per symbol: a busy leg blocks a second overlapping pair", async () => {
    const store = new FundingCarryStore(`/tmp/fc-busy-${Date.now()}-${Math.random()}.json`);
    const base = {
      store,
      universe: ["AAAUSDT", "BBBUSDT", "CCCUSDT"] as const,
      fetchPremiumIndex: fetchGood,
      clusterOfFn: clusterOfFixture,
    };
    await runFundingCarryCycle({ ...base, now: BASE + HOUR });
    // AAA|BBB (12bps) opened first; CCC|BBB (6bps) and AAA|CCC (6bps) share busy legs → blocked.
    const r2 = await runFundingCarryCycle({ ...base, now: BASE + 2 * HOUR });
    expect(r2.recorded).toBe(0);
    expect(store.all.filter((o) => o.status === "OPEN")).toHaveLength(1);
  });

  it("a failing premium-index fetch degrades to a counted skip, never a crash", async () => {
    const store = new FundingCarryStore(`/tmp/fc-fail-${Date.now()}-${Math.random()}.json`);
    const result = await runFundingCarryCycle({
      store,
      universe: ["AAAUSDT", "BBBUSDT"],
      now: BASE + HOUR,
      fetchPremiumIndex: async (s) => {
        if (s === "AAAUSDT") throw new Error("binance down");
        return { fundingRate: 0.0007, markPrice: 100 };
      },
      clusterOfFn: clusterOfFixture,
    });
    expect(result.skippedMissingData).toBe(1);
    expect(result.recorded).toBe(0);
  });

  it("[LIVENESS] persists cycle meta across reloads and records a crashing cycle's error", async () => {
    const file = `/tmp/fc-meta-${Date.now()}-${Math.random()}.json`;
    const store = new FundingCarryStore(file);
    const base = {
      store,
      universe: ["AAAUSDT", "BBBUSDT"] as const,
      fetchPremiumIndex: fetchGood,
      clusterOfFn: clusterOfFixture,
    };
    await runFundingCarryCycle({ ...base, now: BASE + HOUR });
    await runFundingCarryCycle({ ...base, now: BASE + 2 * HOUR });
    expect(store.cycleMeta.cycles).toBe(2);
    expect(store.cycleMeta.lastCycleAt).not.toBeNull();
    const reloaded = new FundingCarryStore(file);
    expect(reloaded.cycleMeta.cycles).toBe(2);

    // Guarded wrapper: a crash records lastCycleError instead of looking like "no signal".
    const orig = store.save.bind(store);
    let threw = false;
    store.save = () => {
      if (!threw) { threw = true; throw new Error("disk full"); }
      orig();
    };
    const crashed = await runFundingCarryCycleGuarded({ ...base, now: BASE + 3 * HOUR });
    expect(crashed).toBeNull();
    expect(store.cycleMeta.lastCycleError).toBe("disk full");
  });
});

describe("funding-carry — report + edgeReady thresholds", () => {
  function resolvedObs(i: number, netR: number, over: Partial<FundingCarryObservation> = {}): FundingCarryObservation {
    return obs({
      observationId: `fc:r${i}`,
      status: netR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      exitReason: netR >= 0 ? "MAX_HOLD_MTM" : "DIVERGENCE_STOP",
      fundingR: netR >= 0 ? netR + 0.11 : 0.05,
      divergenceR: netR >= 0 ? 0 : netR - 0.05 + 0.11,
      costR: 0.11,
      netR,
      holdHours: 48,
      fundingIntervalsAccrued: 6,
      resolvedAt: new Date(BASE + 49 * HOUR).toISOString(),
      ...over,
    });
  }

  it("is NOT edgeReady below the n=30 sample floor even if every pair won", () => {
    const wins = Array.from({ length: 29 }, (_, i) => resolvedObs(i, 0.2));
    expect(buildFundingCarryReport(wins).edgeReady).toBe(false);
  });

  it("is NOT edgeReady with enough sample but netAvgR below 0.05", () => {
    const mixed = [
      ...Array.from({ length: 30 }, (_, i) => resolvedObs(i, 0.02)),
      ...Array.from({ length: 5 }, (_, i) => resolvedObs(100 + i, -0.02)),
    ];
    const report = buildFundingCarryReport(mixed);
    expect(report.resolvedCount).toBe(35);
    expect(report.edgeReady).toBe(false);
  });

  it("is edgeReady with n≥30, netAvgR≥0.05, and PF>1.1 (the house standard)", () => {
    const wins = Array.from({ length: 32 }, (_, i) => resolvedObs(i, 0.15));
    const losses = Array.from({ length: 4 }, (_, i) => resolvedObs(100 + i, -0.5));
    const report = buildFundingCarryReport([...wins, ...losses]);
    expect(report.resolvedCount).toBe(36);
    expect(report.netAvgR!).toBeGreaterThanOrEqual(0.05);
    expect(report.pf!).toBeGreaterThan(1.1);
    expect(report.edgeReady).toBe(true);
  });

  it("decomposes honestly: avg funding captured vs avg divergence cost vs fees, plus exit mix", () => {
    const report = buildFundingCarryReport([
      resolvedObs(1, 0.2), // funding 0.31, divergence 0, cost 0.11
      resolvedObs(2, -1.2), // funding 0.05, divergence −1.14, cost 0.11
      obs({ observationId: "open1" }), // OPEN — excluded from resolved stats
    ]);
    expect(report.openCount).toBe(1);
    expect(report.resolvedCount).toBe(2);
    expect(report.avgFundingR).toBeCloseTo((0.31 + 0.05) / 2, 6);
    expect(report.avgDivergenceR).toBeCloseTo((0 + -1.2 - 0.05 + 0.11) / 2, 6);
    expect(report.avgCostR).toBeCloseTo(0.11, 6);
    expect(report.exitReasons.maxHold).toBe(1);
    expect(report.exitReasons.divergenceStop).toBe(1);
    expect(report.breakEven.requiredDiffBpsPer8h).toBeCloseTo(REQUIRED_DIFF * 10_000, 6);
  });

  it("EXPIRED observations are counted separately and never pollute the resolved stats", () => {
    const report = buildFundingCarryReport([
      resolvedObs(1, 0.2),
      obs({ observationId: "exp1", status: "EXPIRED", resolvedAt: new Date().toISOString() }),
    ]);
    expect(report.resolvedCount).toBe(1);
    expect(report.expiredCount).toBe(1);
    expect(report.netAvgR).toBeCloseTo(0.2, 6);
  });
});

describe("funding-carry — bounded store", () => {
  it("keeps every OPEN observation and at most FC_MAX_STORED_OBSERVATIONS settled ones (oldest dropped)", () => {
    const store = new FundingCarryStore(`/tmp/fc-bound-${Date.now()}-${Math.random()}.json`);
    const total = FC_MAX_STORED_OBSERVATIONS + 25;
    for (let i = 0; i < total; i++) {
      store.add(obs({
        observationId: `fc:settled:${i}`,
        openedAtMs: BASE + i * 1000,
        status: "CLOSED_WIN",
        netR: 0.1,
        resolvedAt: new Date().toISOString(),
      }));
    }
    for (let i = 0; i < 3; i++) {
      store.add(obs({ observationId: `fc:open:${i}`, openedAtMs: BASE, status: "OPEN" }));
    }
    store.save();
    const settled = store.all.filter((o) => o.status !== "OPEN");
    expect(settled).toHaveLength(FC_MAX_STORED_OBSERVATIONS);
    expect(store.all.filter((o) => o.status === "OPEN")).toHaveLength(3);
    // Oldest settled were dropped, newest kept.
    expect(settled.some((o) => o.observationId === "fc:settled:0")).toBe(false);
    expect(settled.some((o) => o.observationId === `fc:settled:${total - 1}`)).toBe(true);
  });
});

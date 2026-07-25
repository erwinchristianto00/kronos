/**
 * Exit Brain (policy + counterfactual + shadow store/cycle) tests.
 *
 * Named exit-brain-policy.test.ts because test/exit-brain.test.ts already covers the four-brain
 * layer's Exit core (decideExit) — a different module (see exit-brain-policy.ts's naming note).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShadowPosition } from "@dtc/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXIT_BRAIN_PARAMS,
  computeRetraceFromPeakFrac,
  effectiveRetraceThreshold,
  evaluateExitBrainCounterfactual,
  exitBrainDecision,
  type ExitBrainFeatures,
  type ExitBrainParams,
  type ExitBrainPathTick,
} from "../src/lib/exit-brain-policy.js";
import {
  ExitBrainShadowStore,
  resolvedTradesFromShadowPositions,
  runExitBrainShadowCycle,
  runExitBrainShadowCycleGuarded,
  type ExitBrainEvaluationRecord,
  type ExitBrainResolvedTrade,
} from "../src/lib/exit-brain-shadow.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-exit-brain-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const P = DEFAULT_EXIT_BRAIN_PARAMS;
const HOUR_MS = 3_600_000;

function features(overrides: Partial<ExitBrainFeatures>): ExitBrainFeatures {
  const currentR = overrides.currentR ?? 0;
  const peakR = overrides.peakR ?? Math.max(0, currentR);
  return {
    currentR,
    peakR,
    troughR: Math.min(0, currentR),
    ageHours: 1,
    retraceFromPeakFrac: computeRetraceFromPeakFrac(currentR, peakR),
    distToStopR: currentR + 1,
    distToTpR: null,
    ...overrides,
  };
}

// ── policy decision rules (every branch) ─────────────────────────────────────

describe("exitBrainDecision", () => {
  it("R0: non-finite features fail-open to HOLD", () => {
    const d = exitBrainDecision(features({ currentR: Number.NaN }));
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("R0_INVALID_FEATURES");
    expect(d.score).toBe(0);
  });

  it("R1: a stale winner banks even when it never armed", () => {
    const d = exitBrainDecision(features({ currentR: 0.2, peakR: 0.2, ageHours: P.staleWinnerMaxAgeHours + 2 }));
    expect(d.action).toBe("BANK");
    expect(d.reason).toContain("R1_STALE_WINNER");
  });

  it("R1 does NOT bank a stale loser (the incumbent stop owns losers)", () => {
    const d = exitBrainDecision(features({ currentR: -0.3, peakR: 0.1, ageHours: P.staleWinnerMaxAgeHours + 2 }));
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("R2_UNARMED");
  });

  it("R2: below the arm peak the policy holds", () => {
    const d = exitBrainDecision(features({ currentR: 0.1, peakR: P.armPeakR - 0.01 }));
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("R2_UNARMED");
    expect(d.score).toBe(0);
  });

  it("R3: an armed winner that round-trips to ~flat banks the scraps (precedence over R4)", () => {
    const d = exitBrainDecision(features({ currentR: P.roundTripGuardR - 0.01, peakR: 0.8 }));
    expect(d.action).toBe("BANK");
    // retrace here is ~95% >= any threshold too — R3 must win the precedence race.
    expect(d.reason).toContain("R3_ROUND_TRIP_GUARD");
  });

  it("R4: banks when the retrace reaches the peak-tightened threshold", () => {
    // peak 1.0, currentR 0.5 → retrace 0.5; threshold = 0.55 − 0.18×(1.0−0.35) = 0.433
    const d = exitBrainDecision(features({ currentR: 0.5, peakR: 1.0, ageHours: 1 }));
    expect(d.action).toBe("BANK");
    expect(d.reason).toContain("R4_RETRACE_BANK");
    expect(d.score).toBe(1);
  });

  it("R5: holds below the threshold with a progress score", () => {
    // peak 0.5, currentR 0.4 → retrace 0.2; threshold = 0.55 − 0.18×0.15 = 0.523
    const d = exitBrainDecision(features({ currentR: 0.4, peakR: 0.5, ageHours: 1 }));
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("R5_HOLD");
    expect(d.score).toBeCloseTo(0.2 / effectiveRetraceThreshold(0.5, 1, P), 6);
  });

  it("f(peakR) decreasing: the SAME 30% retrace banks a 2R winner but holds a 0.5R winner", () => {
    const big = exitBrainDecision(features({ currentR: 1.4, peakR: 2.0, ageHours: 1 })); // retrace 0.30
    const small = exitBrainDecision(features({ currentR: 0.35, peakR: 0.5, ageHours: 1 })); // retrace 0.30
    expect(big.action).toBe("BANK");
    expect(small.action).toBe("HOLD");
  });

  it("age tightening: the same retrace that a young trade holds through banks once old", () => {
    // peak 0.6 → base threshold 0.55 − 0.18×0.25 = 0.505. Retrace 0.40 (currentR 0.36).
    const young = exitBrainDecision(features({ currentR: 0.36, peakR: 0.6, ageHours: 1 }));
    // At age 12h: −0.015×(12−4) = −0.12 → threshold 0.385 ≤ 0.40 → BANK.
    const old = exitBrainDecision(features({ currentR: 0.36, peakR: 0.6, ageHours: 12 }));
    expect(young.action).toBe("HOLD");
    expect(old.action).toBe("BANK");
    expect(old.reason).toContain("R4_RETRACE_BANK");
  });
});

describe("effectiveRetraceThreshold", () => {
  it("equals the base at the arm point for a young trade and never exceeds it", () => {
    expect(effectiveRetraceThreshold(P.armPeakR, 0, P)).toBeCloseTo(P.baseRetraceFrac, 12);
    expect(effectiveRetraceThreshold(0.1, 0, P)).toBeCloseTo(P.baseRetraceFrac, 12);
  });
  it("decreases monotonically in peak and age, floored at minRetraceFrac", () => {
    expect(effectiveRetraceThreshold(1.0, 0, P)).toBeLessThan(effectiveRetraceThreshold(0.5, 0, P));
    expect(effectiveRetraceThreshold(0.5, 24, P)).toBeLessThan(effectiveRetraceThreshold(0.5, 1, P));
    expect(effectiveRetraceThreshold(10, 500, P)).toBeCloseTo(P.minRetraceFrac, 12);
  });
});

describe("computeRetraceFromPeakFrac", () => {
  it("is 0 with no positive peak, uncapped past 1 when underwater", () => {
    expect(computeRetraceFromPeakFrac(-0.2, 0)).toBe(0);
    expect(computeRetraceFromPeakFrac(0.5, 1)).toBeCloseTo(0.5, 12);
    expect(computeRetraceFromPeakFrac(-0.5, 1)).toBeCloseTo(1.5, 12);
  });
});

// ── counterfactual evaluation ────────────────────────────────────────────────

function tickAt(hours: number, currentR: number, extra: Partial<ExitBrainPathTick> = {}): ExitBrainPathTick {
  return { tsMs: Date.UTC(2026, 6, 20) + hours * HOUR_MS, currentR, ...extra };
}

describe("evaluateExitBrainCounterfactual", () => {
  it("banks mid-path at the retrace trigger and scores the delta vs the actual exit", () => {
    const ticks = [tickAt(0, 0), tickAt(1, 0.4), tickAt(2, 1.0), tickAt(3, 0.5), tickAt(4, 0.2), tickAt(5, 0.1)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.1, exitAtIso: new Date(tickAt(5, 0).tsMs).toISOString() });
    expect(r.status).toBe("EVALUATED");
    expect(r.bankedTickIndex).toBe(3);
    expect(r.policyExitR).toBeCloseTo(0.5, 12);
    expect(r.deltaR).toBeCloseTo(0.4, 12);
    expect(r.bankedAt).toBe(new Date(tickAt(3, 0).tsMs).toISOString());
    expect(r.bankReason).toContain("R4_RETRACE_BANK");
  });

  it("NO LOOKAHEAD: a peak printed AFTER the policy banks is never credited (delta goes honestly negative)", () => {
    const ticks = [tickAt(0, 0), tickAt(1, 0.5), tickAt(2, 1.0), tickAt(3, 0.5), tickAt(4, 3.0), tickAt(5, 2.5)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 2.5, exitAtIso: new Date(tickAt(5, 0).tsMs).toISOString() });
    expect(r.status).toBe("EVALUATED");
    expect(r.bankedTickIndex).toBe(3); // banked BEFORE the 3.0R peak existed
    expect(r.policyExitR).toBeCloseTo(0.5, 12);
    expect(r.deltaR).toBeCloseTo(-2.0, 12); // the policy LOST to the actual exit — reported honestly
  });

  it("a policy that holds throughout inherits the actual exit exactly (deltaR 0)", () => {
    const ticks = [tickAt(0, 0), tickAt(1, 0.1), tickAt(2, 0.2), tickAt(3, 0.25), tickAt(4, 0.3), tickAt(5, 0.32)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.32, exitAtIso: new Date(tickAt(5, 0).tsMs).toISOString() });
    expect(r.status).toBe("EVALUATED");
    expect(r.bankedAt).toBeNull();
    expect(r.policyExitR).toBeCloseTo(0.32, 12);
    expect(r.deltaR).toBe(0);
  });

  it("a sparse skeleton (open/peak/trough/close) is INSUFFICIENT_PATH_DATA, never a fabricated score", () => {
    const ticks = [tickAt(0, 0), tickAt(2, 1.2, { peakR: 1.2 }), tickAt(3, -0.2, { troughR: -0.2 }), tickAt(6, 0.1)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.1, exitAtIso: new Date(tickAt(6, 0).tsMs).toISOString() });
    expect(r.status).toBe("INSUFFICIENT_PATH_DATA");
    expect(r.tickCount).toBe(4);
    expect(r.policyExitR).toBeNull();
    expect(r.deltaR).toBeNull();
  });

  it("unsorted / garbage ticks are sorted + filtered; non-finite actual exit is INVALID_INPUT", () => {
    const shuffled = [tickAt(3, 0.5), tickAt(0, 0), tickAt(5, 0.1), tickAt(1, 0.4), { tsMs: Number.NaN, currentR: 9 }, tickAt(2, 1.0), tickAt(4, 0.2)];
    const r = evaluateExitBrainCounterfactual(shuffled, { exitR: 0.1, exitAtIso: "2026-07-20T05:00:00.000Z" });
    expect(r.status).toBe("EVALUATED");
    expect(r.bankedTickIndex).toBe(3); // same walk as the sorted case; NaN tick dropped
    expect(evaluateExitBrainCounterfactual([tickAt(0, 0)], { exitR: Number.NaN, exitAtIso: "x" }).status).toBe("INVALID_INPUT");
  });

  it("bankPenaltyR haircuts the policy's banked R (cost-charging hook)", () => {
    const params: ExitBrainParams = { ...P, bankPenaltyR: 0.05 };
    const ticks = [tickAt(0, 0), tickAt(1, 0.4), tickAt(2, 1.0), tickAt(3, 0.5), tickAt(4, 0.2), tickAt(5, 0.1)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.1, exitAtIso: "2026-07-20T05:00:00.000Z" }, params);
    expect(r.policyExitR).toBeCloseTo(0.45, 12);
    expect(r.deltaR).toBeCloseTo(0.35, 12);
  });

  it("a BANK firing on the TERMINAL tick is NOT penalized — it IS the real exit, not a hypothetical early one", () => {
    const params: ExitBrainParams = { ...P, bankPenaltyR: 0.05 };
    // Peak 1.0R at hour 2 (armed), holds inside tolerance through hour 4, then retraces past
    // threshold exactly on the LAST recorded tick (hour 5) — R4_RETRACE_BANK fires at i=5=last.
    const ticks = [tickAt(0, 0), tickAt(1, 0.4), tickAt(2, 1.0), tickAt(3, 0.6), tickAt(4, 0.6), tickAt(5, 0.55)];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.55, exitAtIso: new Date(tickAt(5, 0).tsMs).toISOString() }, params);
    expect(r.status).toBe("EVALUATED");
    // Without the terminal-tick guard this would be 0.55 - 0.05 = 0.5, deltaR -0.05.
    expect(r.policyExitR).toBeCloseTo(0.55, 12);
    expect(r.deltaR).toBe(0);
    // 2026-07-22 fix: a terminal-tick BANK is economically "held through" — it must NOT be counted
    // as an actual mid-path bank downstream (EvaluatedAggregate.banked), so all 3 banked-* fields
    // stay null here, identically to the "held through the whole path" case above.
    expect(r.bankedAt).toBeNull();
    expect(r.bankedTickIndex).toBeNull();
    expect(r.bankReason).toBeNull();
  });

  it("[REGRESSION 2026-07-22] a tick TIED on timestamp with the real close tick is treated as terminal even if it isn't the last array entry", () => {
    // A trough recorded at the EXACT same instant as the close (e.g. the tick that triggered a
    // stop-loss fill is itself the worst point ever recorded) can be inserted before the close tick
    // in the array despite sharing its tsMs. isTerminalTick must key off tsMs, not array index.
    const params: ExitBrainParams = { ...P, bankPenaltyR: 0.05 };
    const closeMs = tickAt(5, 0).tsMs;
    const ticks: ExitBrainPathTick[] = [
      tickAt(0, 0),
      tickAt(1, 0.4),
      tickAt(2, 1.0),
      tickAt(3, 0.6),
      tickAt(4, 0.6),
      { tsMs: closeMs, currentR: 0.55 }, // the tied, non-last-array-position tick — same instant as close
      { tsMs: closeMs, currentR: 0.55 }, // the literal last array entry, real close
    ];
    const r = evaluateExitBrainCounterfactual(ticks, { exitR: 0.55, exitAtIso: new Date(closeMs).toISOString() }, params);
    expect(r.status).toBe("EVALUATED");
    // Without the timestamp-based fix, the tied-but-not-last tick (index 5) would fire BANK and be
    // judged non-terminal (i !== ticks.length-1), wrongly charging bankPenaltyR (policyExitR 0.5).
    expect(r.policyExitR).toBeCloseTo(0.55, 12);
    expect(r.deltaR).toBe(0);
    expect(r.bankedAt).toBeNull();
    expect(r.bankedTickIndex).toBeNull();
    expect(r.bankReason).toBeNull();
  });
});

// ── shadow store ─────────────────────────────────────────────────────────────

function evalRecord(overrides: Partial<ExitBrainEvaluationRecord> = {}): ExitBrainEvaluationRecord {
  return {
    tradeId: `t-${Math.random().toString(36).slice(2, 10)}`,
    laneId: "tp1_full_exit",
    symbol: "ETHUSDT",
    closedAtIso: "2026-07-21T10:00:00.000Z",
    status: "EVALUATED",
    tickCount: 8,
    actualExitR: 0.1,
    policyExitR: 0.5,
    deltaR: 0.4,
    bankedAt: "2026-07-21T08:00:00.000Z",
    bankReason: "R4_RETRACE_BANK: test",
    ...overrides,
  };
}

describe("ExitBrainShadowStore", () => {
  it("books exactly once per tradeId (dedup) and aggregates honestly", () => {
    const store = new ExitBrainShadowStore(tmp());
    const rec = evalRecord({ tradeId: "dup-1" });
    expect(store.recordEvaluation(rec)).toBe(true);
    expect(store.recordEvaluation(rec)).toBe(false); // exactly-once
    expect(store.recordEvaluation({ ...rec })).toBe(false);
    const report = store.buildReport();
    expect(report.performance.n).toBe(1);
    expect(report.performance.cumDeltaR).toBeCloseTo(0.4, 12);
    expect(report.performance.policyBetter).toBe(1);
    expect(report.performance.banked).toBe(1);
    expect(report.coverage.processed).toBe(1);
  });

  it("counts INSUFFICIENT_PATH_DATA separately and reports the coverage ratio + tick histogram", () => {
    const store = new ExitBrainShadowStore(tmp());
    store.recordEvaluation(evalRecord({ tradeId: "a", deltaR: 0.2 }));
    store.recordEvaluation(
      evalRecord({ tradeId: "b", status: "INSUFFICIENT_PATH_DATA", tickCount: 4, policyExitR: null, deltaR: null, bankedAt: null, bankReason: null }),
    );
    store.recordEvaluation(
      evalRecord({ tradeId: "c", status: "INSUFFICIENT_PATH_DATA", tickCount: 2, policyExitR: null, deltaR: null, bankedAt: null, bankReason: null }),
    );
    const report = store.buildReport();
    expect(report.coverage.processed).toBe(3);
    expect(report.coverage.evaluated).toBe(1);
    expect(report.coverage.insufficientPathData).toBe(2);
    expect(report.coverage.coverageRatio).toBeCloseTo(1 / 3, 12);
    expect(report.coverage.tickHistogram["4"]).toBe(1);
    expect(report.coverage.tickHistogram["2"]).toBe(1);
    expect(report.coverage.tickHistogram["8"]).toBe(1);
  });

  it("keeps detail records bounded while running aggregates keep counting", () => {
    const store = new ExitBrainShadowStore(tmp());
    for (let i = 0; i < 1550; i += 1) store.recordEvaluation(evalRecord({ tradeId: `bound-${i}` }), { deferSave: true });
    store.flush();
    expect(store.getState().records.length).toBe(1500);
    expect(store.getState().evaluated.n).toBe(1550); // pruning never loses the aggregate
  });

  it("survives a reload (aggregates + dedup ledger persisted) and a corrupt file degrades to empty", () => {
    const dir = tmp();
    const store = new ExitBrainShadowStore(dir);
    store.recordEvaluation(evalRecord({ tradeId: "persist-1" }));
    const reloaded = new ExitBrainShadowStore(dir);
    expect(reloaded.hasProcessed("persist-1")).toBe(true);
    expect(reloaded.buildReport().performance.n).toBe(1);

    writeFileSync(join(dir, "exit-brain-shadow.json"), "{not json", "utf-8");
    const corrupt = new ExitBrainShadowStore(dir);
    expect(corrupt.buildReport().coverage.processed).toBe(0);
  });

  it("tracks per-lane breakdown with mean deltas", () => {
    const store = new ExitBrainShadowStore(tmp());
    store.recordEvaluation(evalRecord({ tradeId: "l1", laneId: "LANE_A", deltaR: 0.4 }));
    store.recordEvaluation(evalRecord({ tradeId: "l2", laneId: "LANE_A", deltaR: -0.2, policyExitR: -0.1 }));
    store.recordEvaluation(evalRecord({ tradeId: "l3", laneId: "LANE_B", deltaR: 0.1 }));
    const perLane = store.buildReport().perLane;
    const laneA = perLane.find((l) => l.laneId === "LANE_A")!;
    expect(laneA.n).toBe(2);
    expect(laneA.cumDeltaR).toBeCloseTo(0.2, 12);
    expect(laneA.meanDeltaR).toBeCloseTo(0.1, 12);
    expect(laneA.policyBetter).toBe(1);
    expect(perLane.find((l) => l.laneId === "LANE_B")!.n).toBe(1);
  });
});

// ── cycle ────────────────────────────────────────────────────────────────────

function denseTrade(tradeId: string, laneId = "LANE_A"): ExitBrainResolvedTrade {
  return {
    tradeId,
    laneId,
    symbol: "ETHUSDT",
    direction: "LONG",
    closedAtIso: new Date(tickAt(5, 0).tsMs).toISOString(),
    actualExitR: 0.1,
    ticks: [tickAt(0, 0), tickAt(1, 0.4), tickAt(2, 1.0), tickAt(3, 0.5), tickAt(4, 0.2), tickAt(5, 0.1)],
  };
}

function skeletonTrade(tradeId: string): ExitBrainResolvedTrade {
  return {
    tradeId,
    laneId: "LANE_S",
    symbol: "BTCUSDT",
    direction: "LONG",
    closedAtIso: new Date(tickAt(6, 0).tsMs).toISOString(),
    actualExitR: 0.05,
    ticks: [tickAt(0, 0), tickAt(2, 1.2, { peakR: 1.2 }), tickAt(3, -0.2, { troughR: -0.2 }), tickAt(6, 0.05)],
  };
}

describe("runExitBrainShadowCycle", () => {
  it("evaluates newly-resolved trades exactly once, degrading sparse ones honestly", async () => {
    const store = new ExitBrainShadowStore(tmp());
    const reader = () => [denseTrade("d1"), skeletonTrade("s1")];
    const first = await runExitBrainShadowCycle({ store, readResolvedTrades: reader, now: Date.UTC(2026, 6, 21) });
    expect(first).toMatchObject({ ok: true, processed: 2, evaluated: 1, insufficient: 1, skippedAlreadyProcessed: 0 });

    const second = await runExitBrainShadowCycle({ store, readResolvedTrades: reader, now: Date.UTC(2026, 6, 21, 1) });
    expect(second).toMatchObject({ ok: true, processed: 0, skippedAlreadyProcessed: 2 }); // dedup exactly-once

    const report = store.buildReport();
    expect(report.coverage.processed).toBe(2);
    expect(report.coverage.coverageRatio).toBeCloseTo(0.5, 12);
    expect(report.performance.n).toBe(1);
    expect(report.performance.cumDeltaR).toBeCloseTo(0.4, 12);
    expect(report.cycleMeta.lastError).toBeNull();
  });

  it("bounds work per cycle and finishes the backlog on the next pass", async () => {
    const store = new ExitBrainShadowStore(tmp());
    const reader = () => [denseTrade("m1"), denseTrade("m2"), denseTrade("m3")];
    const first = await runExitBrainShadowCycle({ store, readResolvedTrades: reader, maxTradesPerCycle: 2 });
    expect(first.processed).toBe(2);
    const second = await runExitBrainShadowCycle({ store, readResolvedTrades: reader, maxTradesPerCycle: 2 });
    expect(second.processed).toBe(1);
  });

  it("a throwing reader is captured (fail-open) into the result + cycleMeta, never rethrown", async () => {
    const store = new ExitBrainShadowStore(tmp());
    const result = await runExitBrainShadowCycle({
      store,
      readResolvedTrades: () => {
        throw new Error("reader exploded");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reader exploded");
    expect(store.buildReport().cycleMeta.lastError).toContain("reader exploded");
  });

  it("guarded wrapper runs and returns the same result shape", async () => {
    const store = new ExitBrainShadowStore(tmp());
    const result = await runExitBrainShadowCycleGuarded({ store, readResolvedTrades: () => [denseTrade("g1")] });
    expect(result?.ok).toBe(true);
    expect(result?.processed).toBe(1);
  });
});

// ── shadow-position adapter (the v1 recorded-path reality: a 4-point skeleton) ──

function shadowPositionFixture(overrides: Record<string, unknown> = {}): ShadowPosition {
  return {
    id: "pos-1",
    symbol: "ETHUSDT",
    direction: "LONG",
    selectedExitVariant: "tp1_full_exit",
    primaryVariant: "tp1_full_exit",
    variants: [
      {
        variant: "tp1_full_exit",
        state: "CLOSED",
        openedAt: "2026-07-20T00:00:00.000Z",
        closedAt: "2026-07-20T06:00:00.000Z",
        realizedNetR: 0.1,
        mfeR: 1.2,
        maeR: 0.2, // shadow-engine convention: POSITIVE magnitude
        maxFavorableAt: "2026-07-20T02:00:00.000Z",
        maxAdverseAt: "2026-07-20T03:00:00.000Z",
      },
    ],
    ...overrides,
  } as unknown as ShadowPosition;
}

describe("resolvedTradesFromShadowPositions", () => {
  it("maps a closed selected variant to a chronological 4-tick skeleton with a NEGATED trough", () => {
    const trades = resolvedTradesFromShadowPositions([shadowPositionFixture()]);
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.tradeId).toBe("sp:pos-1:tp1_full_exit");
    expect(t.actualExitR).toBeCloseTo(0.1, 12);
    expect(t.ticks.map((k) => k.currentR)).toEqual([0, 1.2, -0.2, 0.1]);
    expect(t.ticks.map((k) => k.tsMs)).toEqual([...t.ticks.map((k) => k.tsMs)].sort((a, b) => a - b));
  });

  it("skips open variants, missing closedAt, and non-finite realizedNetR — never fabricates", () => {
    const open = shadowPositionFixture({ id: "p-open" });
    (open.variants[0] as { state: string }).state = "OPEN";
    const noClose = shadowPositionFixture({ id: "p-noclose" });
    (noClose.variants[0] as { closedAt: string | null }).closedAt = null;
    const badR = shadowPositionFixture({ id: "p-badr" });
    (badR.variants[0] as { realizedNetR: number }).realizedNetR = Number.NaN;
    expect(resolvedTradesFromShadowPositions([open, noClose, badR])).toHaveLength(0);
  });

  it("omits (never invents) peak/trough ticks when their timestamps are missing", () => {
    const bare = shadowPositionFixture({ id: "p-bare" });
    const v = bare.variants[0] as { maxFavorableAt: string | null; maxAdverseAt: string | null };
    v.maxFavorableAt = null;
    v.maxAdverseAt = null;
    const trades = resolvedTradesFromShadowPositions([bare]);
    expect(trades[0]!.ticks).toHaveLength(2); // open + close only
  });

  it("END-TO-END coverage finding: today's skeleton records classify INSUFFICIENT_PATH_DATA", async () => {
    const store = new ExitBrainShadowStore(tmp());
    const result = await runExitBrainShadowCycle({
      store,
      readResolvedTrades: () => resolvedTradesFromShadowPositions([shadowPositionFixture()]),
    });
    expect(result).toMatchObject({ ok: true, processed: 1, evaluated: 0, insufficient: 1 });
    const report = store.buildReport();
    expect(report.coverage.coverageRatio).toBe(0);
    expect(report.coverage.note).toContain("dense");
    expect(report.coverage.tickHistogram["4"]).toBe(1);
  });
});

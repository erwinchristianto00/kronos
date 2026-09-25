import { describe, it, expect, beforeEach } from "vitest";
import { runFourBrainShadowCycle, _resetFourBrainCycleLatchForTests } from "../src/lib/four-brain-live-wiring.js";
import { _resetFourBrainSingleFlightForTests, type FourBrainShadowTickDeps } from "../src/lib/four-brain-shadow-tick.js";
import { FourBrainMetricsAggregator } from "../src/lib/four-brain-metrics.js";
import type { FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";
import type { Candle } from "@dtc/shared";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const TF_MS = 15 * MIN;

const edge = {
  lookup: (_r: string | null, d: "LONG" | "SHORT") => (d === "LONG" ? { avgNetR: 0.1, n: 120 } : { avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

function baseDeps(o: Partial<FourBrainBindingDeps> = {}): Omit<FourBrainBindingDeps, "entryMicrostructure"> {
  return {
    instanceId: "3101", nowMs: NOW,
    axisScore: 0.5, axisAtMs: NOW - 2 * MIN, axisSlopePerHour: 0.02,
    btcAtrPercentile: 45, atrAtMs: NOW - 8 * MIN,
    advancersPct: 0.65, breadthAtMs: NOW - 2 * MIN,
    sentiment: null, sentimentAtMs: null, safetyEvents: [],
    regimeRaw: "Bullish expansion", edgeMemory: edge,
    controllerBias: "LONG", convictionScore: 0.7, allowsLong: true, allowsShort: true,
    bestLaneReportForDirection: (d) => (d === "LONG" ? { netAvgR: 0.08, resolvedCount: 60 } : null),
    crowdAlignLong: 0.2, crowdAtMs: NOW - 3 * MIN, kronosAgree: null, kronosAtMs: null,
    openSignals: [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "s1", openedAtMs: NOW - 3 * MIN, entryPrice: 100, stopPrice: 97 }],
    maxSignalAgeMs: 50 * MIN, crowdingStateForSymbol: () => "NEUTRAL",
    openPositions: [], markPriceForSymbol: () => ({ price: 101, atMs: NOW - 30_000 }),
    cortexDecisionId: "X", cortexFinalPctForLane: () => 40, laneEligibleIncumbent: () => true,
    killLatched: false, killReason: null,
    ...o,
  } as Omit<FourBrainBindingDeps, "entryMicrostructure">;
}

function freshCandles(): Candle[] {
  const out: Candle[] = [];
  const end = NOW - 5 * MIN;
  const start = end - 59 * TF_MS;
  for (let i = 0; i < 60; i++) {
    const b = 100 + Math.sin(i / 5) * 2;
    out.push({ openTime: start + i * TF_MS, open: b, high: b + 1, low: b - 1, close: b, volume: 1000 });
  }
  return out;
}

function harness(over: Partial<Parameters<typeof runFourBrainShadowCycle>[0]> = {}) {
  const journal: Record<string, unknown>[] = [];
  const metrics = new FourBrainMetricsAggregator();
  let fetchCalls = 0;
  const deps: Parameters<typeof runFourBrainShadowCycle>[0] = {
    buildDeps: () => baseDeps(),
    fetchCandles: async () => { fetchCalls += 1; return freshCandles(); },
    activeAllocation: () => [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 100 }],
    journalAppend: (r) => void journal.push(r),
    metrics,
    now: () => NOW,
    env: { FOUR_BRAIN_MODE: "shadow", PORT: "3101" } as NodeJS.ProcessEnv,
    ...over,
  };
  return { deps, journal, metrics, fetchCalls: () => fetchCalls };
}

beforeEach(() => { _resetFourBrainSingleFlightForTests(); _resetFourBrainCycleLatchForTests(); });

describe("runFourBrainShadowCycle — gate + candle prewarm + report-only", () => {
  it("mode OFF ⇒ no-op (no journal, no fetch)", async () => {
    const h = harness({ env: { FOUR_BRAIN_MODE: "off", PORT: "3101" } as NodeJS.ProcessEnv });
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(false);
    expect(r.gateReason).toBe("mode-off");
    expect(h.journal).toHaveLength(0);
  });

  it("live instance 3103 is HARD-BLOCKED even with mode=shadow", async () => {
    const h = harness({ env: { FOUR_BRAIN_MODE: "shadow", PORT: "3103" } as NodeJS.ProcessEnv });
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(false);
    expect(r.gateReason).toBe("instance-blocked");
    expect(h.journal).toHaveLength(0);
  });

  it("shadow on 3101 ⇒ runs, prewarms candles, records metrics, journals a cycle-metrics record", async () => {
    const h = harness();
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(true);
    expect(r.gateReason).toBe("ran");
    expect(h.fetchCalls()).toBe(1); // one distinct symbol
    expect(h.metrics.summary().ticks.completed).toBe(1);
    // the market-state snapshot + at least the cycle-metrics record are journaled
    expect(h.journal.some((j) => j.kind === "FOUR_BRAIN_CYCLE_METRICS")).toBe(true);
    // incumbent coverage present and complete
    expect(r.coverage!.capitalCoveragePct).toBe(100);
    expect(r.coverage!.activeLaneCount).toBe(1);
  });

  it("a candle fetch that throws ⇒ still runs (micro MISSING), never throws into the caller", async () => {
    const h = harness({ fetchCandles: async () => { throw new Error("binance down"); } });
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(true); // fail-open: MISSING candles, cycle still completes
  });

  it("a hanging prewarm times out and cannot block future shadow cycles", async () => {
    const never = new Promise<Candle[] | null>(() => {});
    const h = harness({ fetchCandles: () => never, prewarmTimeoutMs: 1 });
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(true);
    expect(h.metrics.summary().ticks.completed).toBe(1);
  });

  it("kill latched ⇒ cycle still runs and every entry candidate is risk-blocked (mutates nothing)", async () => {
    const h = harness({ buildDeps: () => baseDeps({ killLatched: true, killReason: "daily loss" }) });
    const r = await runFourBrainShadowCycle(h.deps);
    expect(r.ran).toBe(true);
    expect(r.tick!.executiveDecisions.every((d) => d.candidateStatus === "BLOCKED_BY_RISK")).toBe(true);
  });

  it("cycle single-flight: a second cycle while the first's candle prewarm is in flight is SKIPPED", async () => {
    // Hold the candle fetch open so the first cycle is still inside its prewarm when the second starts.
    let release: (v: Candle[] | null) => void = () => {};
    const gate = new Promise<Candle[] | null>((res) => { release = res; });
    const h = harness({ fetchCandles: () => gate });
    const first = runFourBrainShadowCycle(h.deps);
    const second = await runFourBrainShadowCycle(h.deps); // first still awaiting the gated fetch
    expect(second.ran).toBe(false);
    expect(second.gateReason).toBe("cycle-in-flight");
    release(freshCandles());
    const firstResult = await first;
    expect(firstResult.ran).toBe(true);
    // latch released ⇒ a subsequent cycle runs again
    const third = await runFourBrainShadowCycle(h.deps);
    expect(third.ran).toBe(true);
  });
});

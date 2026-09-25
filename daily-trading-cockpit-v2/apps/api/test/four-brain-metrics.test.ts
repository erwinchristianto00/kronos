import { describe, it, expect } from "vitest";
import { FourBrainMetricsAggregator } from "../src/lib/four-brain-metrics.js";
import type { FourBrainTickMetrics } from "../src/lib/four-brain-shadow-tick.js";

function m(o: Partial<FourBrainTickMetrics> = {}): FourBrainTickMetrics {
  return {
    attempted: 1, completed: 0, skippedSingleFlight: 0, gatherErrors: 0, journalErrors: 0, invariantFailures: 0,
    decisions: 0, duplicateDecisionIds: 0, byCandidateStatus: {}, byBrainAction: {}, unknownLanes: 0,
    duplicateIdentities: 0, laneCoverage: 0, positionCoverage: 0, staleOrMissingByClass: {}, gatherMs: 0, inferenceMs: 0, journalMs: 0,
    ...o,
  };
}

describe("FourBrainMetricsAggregator", () => {
  it("counts completed / skipped / gather-error / exception ticks distinctly", () => {
    const agg = new FourBrainMetricsAggregator();
    agg.record(m({ decisions: 3, laneCoverage: 2 }), "ok");
    agg.record(m({ skippedSingleFlight: 1 }), "single-flight-skip");
    agg.record(m({ gatherErrors: 1 }), "gather-error");
    agg.record(m(), "exception");
    agg.record(m(), "mode-off"); // ignored — not an attempt
    const s = agg.summary();
    expect(s.ticks.completed).toBe(1);
    expect(s.ticks.skippedSingleFlight).toBe(1);
    expect(s.ticks.gatherErrors).toBe(1);
    expect(s.ticks.exceptions).toBe(1);
    expect(s.ticks.attempted).toBe(4); // mode-off excluded
    expect(s.decisions.total).toBe(3);
  });

  it("computes stale/missing source rates per freshness class", () => {
    const agg = new FourBrainMetricsAggregator();
    agg.record(m({ staleOrMissingByClass: { candle: { fresh: 3, stale: 1, missing: 0, error: 0 } } }), "ok");
    agg.record(m({ staleOrMissingByClass: { candle: { fresh: 1, stale: 0, missing: 4, error: 0 } } }), "ok");
    const q = agg.summary().sourceQuality.candle!;
    expect(q.total).toBe(9);
    expect(q.freshPct).toBeCloseTo((4 / 9) * 100);
    expect(q.missingPct).toBeCloseTo((4 / 9) * 100);
  });

  it("reports gather/inference/journal latency percentiles from bounded rings", () => {
    const agg = new FourBrainMetricsAggregator();
    for (let i = 1; i <= 10; i++) agg.record(m({ gatherMs: i, inferenceMs: i * 2, journalMs: i * 0.5 }), "ok");
    const l = agg.summary().latencyMs;
    expect(l.gather.samples).toBe(10);
    expect(l.gather.p50).toBeGreaterThan(0);
    expect(l.gather.p99).toBeGreaterThanOrEqual(l.gather.p50!);
    expect(l.inference.p90).toBeGreaterThanOrEqual(l.gather.p90!);
  });

  it("tracks max lane/position coverage across ticks", () => {
    const agg = new FourBrainMetricsAggregator();
    agg.record(m({ laneCoverage: 5, positionCoverage: 1 }), "ok");
    agg.record(m({ laneCoverage: 2, positionCoverage: 3 }), "ok");
    const s = agg.summary();
    expect(s.coverage.maxLaneCoverage).toBe(5);
    expect(s.coverage.lastLaneCoverage).toBe(2);
    expect(s.coverage.maxPositionCoverage).toBe(3);
  });

  it("keeps a current heartbeat and exposes a wiring failure instead of hiding it", () => {
    const agg = new FourBrainMetricsAggregator();
    agg.record(m(), "ok", 1_000);
    agg.recordWiringFailure(2_000);
    const s = agg.summary();
    expect(s.heartbeat).toMatchObject({
      lastCompletedAtMs: 1_000,
      lastFailureAtMs: 2_000,
      lastFailureReason: "cycle-wiring-exception",
    });
    expect(s.ticks.wiringErrors).toBe(1);
  });
});

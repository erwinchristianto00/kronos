import { describe, it, expect } from "vitest";
import {
  buildFourBrainGatherInput,
  type FourBrainBindingDeps,
  type LaneReportLike,
} from "../src/lib/four-brain-live-gather-bindings.js";
import { classifySource } from "../src/lib/four-brain-types.js";
import { auditReading, FRESHNESS_TTL_MS } from "../src/lib/four-brain-live-gather.js";

/**
 * 2026-07-26 PROVENANCE regression.
 *
 * All five Direction readings — longEdge, shortEdge, conviction, longLaneEdge, shortLaneEdge — were
 * stamped with `dep.axisAtMs`, the regime AXIS's clock, regardless of which producer the value came
 * from. Four unrelated sources reported one shared, borrowed age. Two consequences, both real:
 *
 *   • axis present  ⇒ every reading inherited a timestamp that was not its own, so a long-stale
 *     edge-memory could read FRESH purely because the axis had just ticked.
 *   • axis absent   ⇒ all five went untimed at once (observed on research/3101, where axisScore is
 *     MISSING so axisAtMs is null) and, before the classifySource fail-closed fix, read FRESH forever.
 *
 * Each now carries its producer's own clock. The timestamps already existed and were simply never
 * passed in: the edge-memory store's `liveUpdatedAt`, the scan/regime `scanFinishedAt` behind the
 * controller report, and the lane report's `lastCycleAt` (which liveLaneReport() always returned and
 * the narrowed four-brain LaneReportLike used to discard).
 */
describe("Direction readings carry their OWN timestamp, not the regime axis's", () => {
  const NOW = 1_700_000_000_000;
  const EDGE_TTL = FRESHNESS_TTL_MS.regime;

  const edge = {
    lookup: () => ({ avgNetR: 0.09, n: 40 }),
    verdict: () => ({ decision: "ALLOW_PROVEN" }),
    hasPositiveLane: () => true,
  };

  function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
    return {
      instanceId: "3101",
      nowMs: NOW,
      axisScore: null, axisAtMs: null, axisSlopePerHour: null,
      btcAtrPercentile: null, atrAtMs: null,
      advancersPct: null, breadthAtMs: null,
      sentiment: null, sentimentAtMs: null,
      safetyEvents: [],
      regimeRaw: "Bullish expansion", edgeMemory: edge,
      controllerBias: "LONG", convictionScore: 0.7, allowsLong: true, allowsShort: true,
      bestLaneReportForDirection: () => null,
      crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
      openSignals: [], maxSignalAgeMs: 50 * 60_000, crowdingStateForSymbol: () => null,
      openPositions: [], markPriceForSymbol: () => ({ price: null, atMs: null }),
      cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
      killLatched: false, killReason: null,
      ...o,
    } as FourBrainBindingDeps;
  }

  it("FAIL-WITHOUT: a fresh axis no longer makes a long-stale edge-memory look FRESH", () => {
    // The whole bug in one case: axis ticked one second ago, edge-memory has not been written in a
    // week. Pre-fix longEdge inherited axisAtMs ⇒ FRESH. It must now follow edge-memory's own clock.
    const deps = baseDeps({
      axisAtMs: NOW - 1_000, // axis: brand new
      edgeMemoryUpdatedAtMs: NOW - 7 * 24 * 60 * 60_000, // edge-memory: a week old
      controllerCapturedAtMs: NOW - 1_000,
    });
    const dir = buildFourBrainGatherInput(deps).directions[0]!;
    expect(dir.longEdge.observedAtMs).toBe(NOW - 7 * 24 * 60 * 60_000);
    expect(dir.longEdge.observedAtMs).not.toBe(deps.axisAtMs);
    expect(auditReading(dir.longEdge, NOW).status).toBe("STALE");
    // ...while the controller reading, which genuinely IS fresh, stays FRESH. One clock per producer.
    expect(auditReading(dir.conviction, NOW).status).toBe("FRESH");
  });

  it("each of the five readings takes its own source's clock", () => {
    const laneAt = new Date(NOW - 3 * 60_000).toISOString();
    const lane: LaneReportLike = { netAvgR: 0.05, resolvedCount: 42, lastCycleAt: laneAt };
    const deps = baseDeps({
      axisAtMs: NOW - 999_999, // deliberately unlike every other clock
      edgeMemoryUpdatedAtMs: NOW - 60_000,
      controllerCapturedAtMs: NOW - 120_000,
      bestLaneReportForDirection: () => lane,
    });
    const dir = buildFourBrainGatherInput(deps).directions[0]!;
    expect(dir.longEdge.observedAtMs).toBe(NOW - 60_000);
    expect(dir.shortEdge.observedAtMs).toBe(NOW - 60_000);
    expect(dir.conviction.observedAtMs).toBe(NOW - 120_000);
    expect(dir.longLaneEdge.observedAtMs).toBe(Date.parse(laneAt));
    expect(dir.shortLaneEdge.observedAtMs).toBe(Date.parse(laneAt));
    // None of them borrowed the axis clock.
    for (const r of [dir.longEdge, dir.shortEdge, dir.conviction, dir.longLaneEdge, dir.shortLaneEdge]) {
      expect(r.observedAtMs).not.toBe(deps.axisAtMs);
    }
  });

  it("a lane without post-fix qualified evidence stays MISSING, never borrowed or guessed", () => {
    const lane: LaneReportLike = { netAvgR: 0.05, resolvedCount: 42 }; // no lastCycleAt — the IM case
    const deps = baseDeps({ axisAtMs: NOW, bestLaneReportForDirection: () => lane });
    const dir = buildFourBrainGatherInput(deps).directions[0]!;
    expect(dir.longLaneEdge.observedAtMs).toBeNull(); // did NOT fall back to the fresh axis clock
    expect(auditReading(dir.longLaneEdge, NOW).status).toBe("MISSING");
  });

  it("an unparseable lastCycleAt is treated as untimed, not as NaN", () => {
    const lane: LaneReportLike = { netAvgR: 0.05, resolvedCount: 42, lastCycleAt: "not-a-date" };
    const deps = baseDeps({ bestLaneReportForDirection: () => lane });
    const dir = buildFourBrainGatherInput(deps).directions[0]!;
    expect(dir.longLaneEdge.observedAtMs).toBeNull();
    // NaN would classify ERROR; untimed-under-a-TTL is STALE. The distinction matters for triage.
    expect(classifySource({ value: 0.05, asOfMs: dir.longLaneEdge.observedAtMs }, NOW, EDGE_TTL)).toBe("STALE");
  });

  it("omitting the new deps entirely (older callers/tests) degrades to untimed, never to a wrong clock", () => {
    const deps = baseDeps({ axisAtMs: NOW }); // edgeMemoryUpdatedAtMs / controllerCapturedAtMs absent
    const dir = buildFourBrainGatherInput(deps).directions[0]!;
    expect(dir.longEdge.observedAtMs).toBeNull();
    expect(dir.conviction.observedAtMs).toBeNull();
  });
});

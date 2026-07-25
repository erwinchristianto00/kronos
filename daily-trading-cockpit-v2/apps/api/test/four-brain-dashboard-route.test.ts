import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerShadowRoutes } from "../src/routes/shadow.js";
import type { FourBrainMetricsSummary } from "../src/lib/four-brain-metrics.js";

function summary(overrides: Partial<FourBrainMetricsSummary> = {}): FourBrainMetricsSummary {
  return {
    ticks: { attempted: 3, completed: 2, skippedSingleFlight: 0, gatherErrors: 0, exceptions: 1, journalErrors: 0, brainErrors: 0, invariantFailures: 0 },
    decisions: { total: 5, duplicateDecisionIds: 0, unknownLanes: 0, duplicateIdentities: 0 },
    coverage: { lastLaneCoverage: 2, maxLaneCoverage: 3, lastPositionCoverage: 1, maxPositionCoverage: 1 },
    sourceQuality: {},
    byCandidateStatus: { VALID: 3 },
    byBrainAction: { "dir:LONG": 2 },
    latencyMs: {
      gather: { p50: 5, p90: 8, p99: 10, samples: 3 },
      inference: { p50: 1, p90: 2, p99: 3, samples: 3 },
      journal: { p50: 1, p90: 1, p99: 1, samples: 3 },
    },
    ...overrides,
  };
}

describe("GET /api/shadow/four-brain", () => {
  it("returns the live health summary + recent decisions when both getters are wired", async () => {
    const app = Fastify({ logger: false });
    const decisions = [
      { kind: "EXECUTIVE_DECISION", asOfMs: 2, laneId: "CG_WIDE_FAST_LONG" },
      { kind: "MARKET_SNAPSHOT", asOfMs: 1 },
    ];
    await registerShadowRoutes(app, null, {
      fourBrainMetricsGetter: () => summary(),
      fourBrainRecentDecisionsGetter: () => decisions,
    });

    const response = await app.inject({ method: "GET", url: "/api/shadow/four-brain" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(true);
    expect(body.health.ticks.completed).toBe(2);
    expect(body.health.decisions.total).toBe(5);
    expect(body.recentDecisions).toHaveLength(2);
    expect(body.recentDecisions[0].laneId).toBe("CG_WIDE_FAST_LONG");
    await app.close();
  });

  it("fails open to a clearly-empty/disabled shape (never a 500) when four-brain was never wired", async () => {
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null, {});

    const response = await app.inject({ method: "GET", url: "/api/shadow/four-brain" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(false);
    expect(body.recentDecisions).toEqual([]);
    expect(body.health.ticks.attempted).toBe(0);
    expect(body.health.ticks.completed).toBe(0);
    expect(body.health.decisions.total).toBe(0);
    await app.close();
  });

  it("caps recentDecisions at 50 even if the ring buffer getter returns more", async () => {
    const app = Fastify({ logger: false });
    const many = Array.from({ length: 80 }, (_, i) => ({ kind: "EXECUTIVE_DECISION", asOfMs: i }));
    await registerShadowRoutes(app, null, {
      fourBrainMetricsGetter: () => summary(),
      fourBrainRecentDecisionsGetter: () => many,
    });

    const response = await app.inject({ method: "GET", url: "/api/shadow/four-brain" });
    expect(response.statusCode).toBe(200);
    expect(response.json().recentDecisions).toHaveLength(50);
  });
});

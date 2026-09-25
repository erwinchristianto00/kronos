import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerLiveRoutes } from "../src/routes/live.js";
import {
  EXECUTABLE_INNOVATION_LANE_IDS,
  INNOVATION_POLICY_ONLY_IDS,
} from "../src/lib/innovation-testnet-execution.js";
import type { InnovationCampaignDiagnostics } from "../src/lib/innovation-campaign.js";
import type { CrossSectionalExecutor, ExecutorBasket } from "../src/lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";

/**
 * 2026-08-04 fail-closed innovation campaign control: /api/live/innovation-executors gained one
 * new sibling field, `campaign`, next to the pre-existing executableLaneIds/policyOnly/basket/
 * singleSymbol keys (see routes/live.ts, live.txt diff). This file proves the wiring end-to-end
 * through the REAL route handler (not just the pure diagnostics builder already covered by
 * innovation-campaign.test.ts) — the one place a "forgot to spread the new opts getter into the
 * handler" regression would actually surface, following the exact pattern already established by
 * live-account-route-wiring.test.ts for this same route file's other executor getters.
 */

function fakeDiagnostics(over: Partial<InnovationCampaignDiagnostics> = {}): InnovationCampaignDiagnostics {
  const laneAdmission: InnovationCampaignDiagnostics["laneAdmission"] = {};
  for (const laneId of EXECUTABLE_INNOVATION_LANE_IDS) {
    laneAdmission[laneId] = { allowed: false, reason: "no active innovation campaign" };
  }
  return {
    filePath: "/fake/data/innovation-campaign.json",
    configured: false,
    active: false,
    expired: false,
    statusReason: "no innovation campaign file present at /fake/data/innovation-campaign.json",
    campaignId: null,
    startsAt: null,
    expiresAt: null,
    allowedLaneIds: [],
    globalMaxPositions: null,
    globalNotionalCap: null,
    perLaneCaps: {},
    metadataReason: null,
    metadataOwner: null,
    exposure: { totalOpenPositions: 0, totalOpenNotionalUsd: 0, perLane: {} },
    laneAdmission,
    ...over,
  };
}

function fakeXsecExecutor(laneId: string, symbol: string): CrossSectionalExecutor {
  const basket: ExecutorBasket = {
    basketId: `b-${laneId}`, sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
    openedAt: "2026-08-01T00:00:00.000Z", closesAtMs: 0,
    legs: [{ symbol, side: "LONG", qty: 5, entryPrice: 1, entryOrderId: "1", entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null }],
    status: "OPEN", closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
  return { getStatus: () => ({ laneId, openBaskets: [basket] }) } as unknown as CrossSectionalExecutor;
}

function fakeSingleSymbolExecutor(laneId: string, symbol: string): SingleSymbolLaneExecutor {
  const pos: SingleSymbolPosition = {
    positionId: "p1", sourceObservationId: "o1", symbol, direction: "SHORT", qty: 3, entryPrice: 1,
    entryOrderId: "1", entryPriceConfirmed: true, stopPrice: 1.05, stopAlgoOrderId: "900", stopFailureCount: 0,
    stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0,
    openedAt: "2026-08-01T00:00:00.000Z", status: "OPEN", closedAt: null, closeReason: null, exitPrice: null,
    exitOrderId: null, exitPriceConfirmed: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
  return { getStatus: () => ({ laneId, openPositions: [pos] }) } as unknown as SingleSymbolLaneExecutor;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

describe("GET /api/live/innovation-executors — campaign diagnostics wiring", () => {
  it("returns the wired campaign diagnostics verbatim as a new sibling field", async () => {
    const diagnostics = fakeDiagnostics();
    app = Fastify();
    await registerLiveRoutes(app, null, {
      innovationCampaign: () => diagnostics,
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/live/innovation-executors" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaign).toEqual(diagnostics);
    // Unaffected pre-existing fields.
    expect(body.executableLaneIds).toEqual(EXECUTABLE_INNOVATION_LANE_IDS);
    expect(body.policyOnly).toEqual(INNOVATION_POLICY_ONLY_IDS);
  });

  it("defaults campaign to null when no getter is wired (older-deploy shape, matches every other optional getter in this route)", async () => {
    app = Fastify();
    await registerLiveRoutes(app, null, {});
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/live/innovation-executors" });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaign).toBeNull();
  });

  it("an active campaign's laneAdmission/exposure survive the real HTTP JSON round-trip (Map -> Record guard, end-to-end)", async () => {
    const diagnostics = fakeDiagnostics({
      configured: true,
      active: true,
      statusReason: null,
      campaignId: "camp-1",
      allowedLaneIds: [EXECUTABLE_INNOVATION_LANE_IDS[0]],
      globalMaxPositions: 5,
      globalNotionalCap: 1000,
      exposure: {
        totalOpenPositions: 1,
        totalOpenNotionalUsd: 25,
        perLane: { [EXECUTABLE_INNOVATION_LANE_IDS[0]]: { openPositions: 1, openNotionalUsd: 25 } },
      },
    });
    app = Fastify();
    await registerLiveRoutes(app, null, { innovationCampaign: () => diagnostics });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/live/innovation-executors" });
    const body = res.json();
    expect(body.campaign.exposure.perLane).toEqual({
      [EXECUTABLE_INNOVATION_LANE_IDS[0]]: { openPositions: 1, openNotionalUsd: 25 },
    });
    expect(Object.keys(body.campaign.laneAdmission).sort()).toEqual([...EXECUTABLE_INNOVATION_LANE_IDS].sort());
  });

  it("the new campaign field does not disturb the pre-existing basket/singleSymbol shapes", async () => {
    app = Fastify();
    await registerLiveRoutes(app, null, {
      innovationCampaign: () => fakeDiagnostics(),
      innovationBasketExecutors: () => [fakeXsecExecutor(EXECUTABLE_INNOVATION_LANE_IDS[0], "SOLUSDT")],
      innovationSingleSymbolExecutors: () => [fakeSingleSymbolExecutor(EXECUTABLE_INNOVATION_LANE_IDS[1], "BTCUSDT")],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/live/innovation-executors" });
    const body = res.json();
    expect(body.basket).toHaveLength(1);
    expect(body.basket[0].laneId).toBe(EXECUTABLE_INNOVATION_LANE_IDS[0]);
    expect(body.singleSymbol).toHaveLength(1);
    expect(body.singleSymbol[0].laneId).toBe(EXECUTABLE_INNOVATION_LANE_IDS[1]);
    expect(body.campaign).toEqual(fakeDiagnostics());
  });
});

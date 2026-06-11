import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ShadowPosition } from "@dtc/shared";

import { registerShadowRoutes } from "../src/routes/shadow.js";

let __metadataSnapshotTempDir: string;
let __originalSnapshotPath: string | undefined;

beforeAll(() => {
  __metadataSnapshotTempDir = mkdtempSync(join(tmpdir(), "ext-meta-test-"));
  __originalSnapshotPath = process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = join(__metadataSnapshotTempDir, "snapshot.json");
});

afterAll(() => {
  if (__originalSnapshotPath === undefined) {
    delete process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  } else {
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = __originalSnapshotPath;
  }
  rmSync(__metadataSnapshotTempDir, { recursive: true, force: true });
});

describe("strategy intelligence foundation route", () => {
  it("returns empty-safe analytical readiness without mutating shadow state", async () => {
    const app = Fastify({ logger: false });
    let getAllPositionsCalls = 0;
    const positions: ShadowPosition[] = [];
    await registerShadowRoutes(app, {
      getAllPositions() {
        getAllPositionsCalls += 1;
        return positions;
      },
    } as never);

    const response = await app.inject({ method: "GET", url: "/api/shadow/strategy-intelligence-foundation" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.contextSnapshotCount).toBe(0);
    expect(body.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(body.dataReadiness.readyForSymbolRouteEngine).toBe(false);
    expect(body.missingFieldAudit.completeness.maxFavorableExcursionR).toBe(0);
    expect(body.dataReadiness.technicalStopTpEngine.ready).toBe(false);
    expect(body.dataReadiness.technicalStopTpEngine.reasonsBlocking.length).toBeGreaterThan(0);
    expect(body.strategyEvidenceTable.topPromisingSymbolRoutePairs).toEqual([]);
    expect(body.routeMode).toBeUndefined();
    expect(body.tradeCaps).toBeUndefined();
    expect(positions).toEqual([]);
    expect(getAllPositionsCalls).toBe(1);
    await app.close();
  });

  it("returns adaptive gate intelligence as a read-only analytical endpoint with era support", async () => {
    const app = Fastify({ logger: false });
    let getAllPositionsCalls = 0;
    const positions: ShadowPosition[] = [];
    await registerShadowRoutes(app, {
      getAllPositions() {
        getAllPositionsCalls += 1;
        return positions;
      },
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/shadow/adaptive-gate-intelligence?era=ALL_TIME",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidenceEra).toBe("ALL_TIME");
    expect(body.totalResolvedExperienceRecords).toBe(0);
    expect(body.usableRecordsForGateAnalysis).toBe(0);
    expect(body.metadata.resolvedExperienceRecordCount).toBe(0);
    expect(body.readiness.advisoryEngineReady).toBe(true);
    expect(body.readiness.readyForGateInfluence).toBe(false);
    expect(body.contextCoverageSummary.marketRegimeCoverage).toBe(0);
    expect(body.coverageProvenance.totalResolvedRecords).toBe(0);
    expect(body.coverageProvenance.perField.length).toBeGreaterThan(0);
    expect(body.interactionAssessments).toEqual([]);
    expect(body.routeMode).toBeUndefined();
    expect(body.tradeCaps).toBeUndefined();
    expect(body.promotionThresholds).toBeUndefined();
    expect(positions).toEqual([]);
    expect(getAllPositionsCalls).toBe(1);
    await app.close();
  });

  it("returns regime policy counterfactual as a read-only analytical endpoint with era support", async () => {
    const app = Fastify({ logger: false });
    let getAllPositionsCalls = 0;
    const positions: ShadowPosition[] = [];
    await registerShadowRoutes(app, {
      getAllPositions() {
        getAllPositionsCalls += 1;
        return positions;
      },
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/shadow/regime-policy-counterfactual?era=ALL_TIME",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidenceEra).toBe("ALL_TIME");
    expect(body.totalResolvedExperienceRecords).toBe(0);
    expect(body.baseline.closedCount).toBe(0);
    expect(body.scenarios.length).toBeGreaterThan(0);
    expect(body.policyHypotheses.length).toBeGreaterThan(0);
    expect(body.routeMode).toBeUndefined();
    expect(body.tradeCaps).toBeUndefined();
    expect(body.promotionThresholds).toBeUndefined();
    expect(positions).toEqual([]);
    expect(getAllPositionsCalls).toBe(1);
    await app.close();
  });

  it("returns adaptive gate overlay performance as a read-only analytical endpoint with era support", async () => {
    const app = Fastify({ logger: false });
    let getAllPositionsCalls = 0;
    const positions: ShadowPosition[] = [];
    await registerShadowRoutes(app, {
      getAllPositions() {
        getAllPositionsCalls += 1;
        return positions;
      },
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/api/shadow/adaptive-gate-overlay-performance?era=ALL_TIME",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidenceEra).toBe("ALL_TIME");
    expect(body.totalResolvedExperienceRecords).toBe(0);
    expect(body.recordsWithPersistedOverlay).toBe(0);
    expect(body.policyPerformance.length).toBe(3);
    expect(body.overallReadiness.collectingForwardEvidence).toBe(true);
    expect(body.overallReadiness.readyForBehaviorInfluence).toBe(false);
    expect(body.routeMode).toBeUndefined();
    expect(body.tradeCaps).toBeUndefined();
    expect(body.promotionThresholds).toBeUndefined();
    expect(positions).toEqual([]);
    expect(getAllPositionsCalls).toBe(1);
    await app.close();
  });
});

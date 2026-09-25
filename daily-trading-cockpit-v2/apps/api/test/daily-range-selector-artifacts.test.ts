import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DailyRangeSelectorArtifactRegistry,
  hashDailyRangeSelectorModel,
} from "../src/lib/daily-range-selector-artifacts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const value = mkdtempSync(join(tmpdir(), "daily-range-artifacts-"));
  dirs.push(value);
  return value;
}

describe("Daily Range selector artifact registry", () => {
  it("uses the economic baseline as the only fallback when the registry is absent or corrupt", () => {
    const root = dir();
    const registry = new DailyRangeSelectorArtifactRegistry(root, "artifacts.json");
    expect(registry.status()).toMatchObject({ activeStatus: "MISSING", fallback: "ECONOMIC_QUALITY_BASELINE" });
    writeFileSync(join(root, "artifacts.json"), "not json", "utf8");
    expect(registry.status()).toMatchObject({ activeStatus: "CORRUPT", fallback: "ECONOMIC_QUALITY_BASELINE" });
  });

  it("persists a research artifact without granting any execution authority", () => {
    const root = dir();
    const registry = new DailyRangeSelectorArtifactRegistry(root, "artifacts.json");
    const model = { intercept: 0, weights: { c1ExtensionOfRange: 0.1 } };
    registry.saveArtifact({
      schemaVersion: 1,
      selectorId: "daily-range-research-test",
      routeSpecialists: ["CONTINUATION"],
      featureSchemaVersion: "reconstructed-candle-pit-v1",
      trainingCutoff: "2026-08-01T00:00:00.000Z",
      datasetClass: "RECONSTRUCTED_CANDLE_PIT",
      datasetManifest: { candidates: 100 },
      trainingPeriod: { from: "2026-01-01", to: "2026-06-01" },
      validationPeriod: { from: "2026-06-02", to: "2026-07-01" },
      holdoutPeriod: { from: "2026-07-02", to: "2026-08-01" },
      metrics: { verdict: "WEAK_SHADOW" },
      promotionGates: {
        historical: { status: "FAIL", datasetClass: "RECONSTRUCTED_CANDLE_PIT", reason: "no stable lift" },
        forwardFullPit: { status: "PENDING", matureOversubscribedBatches: 0, requiredMatureOversubscribedBatches: 20, reason: "forward collection pending" },
        testnetParity: { status: "PENDING", reason: "not deployed" },
        operatorApproval: { status: "NOT_APPROVED", reason: "not granted" },
        executionAuthority: false,
      },
      modelHash: hashDailyRangeSelectorModel(model),
      gitCommit: "test",
      status: "WEAK_SHADOW",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(registry.status()).toMatchObject({
      available: true,
      activeSelectorId: "daily-range-research-test",
      activeStatus: "WEAK_SHADOW",
      fallback: "ECONOMIC_QUALITY_BASELINE",
      promotionGates: { executionAuthority: false, forwardFullPit: { requiredMatureOversubscribedBatches: 20 } },
    });
  });
});

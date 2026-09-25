import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL("../../../../scripts/research/run-free-tier1-walk-forward.mjs", import.meta.url));
const runner = await import(pathToFileURL(runnerPath).href);
const roots: string[] = [];
const hash = (ordinal: number) => ordinal.toString(16).padStart(64, "0");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function realReport() {
  const artifacts = [
    "execution_candles",
    "funding_settlements",
    "listing_delisting_timeline",
    "futures_availability_timeline",
    "minimum_history_eligibility",
    "pit_liquidity_spread",
    "pit_portfolio_risk",
    "warmup_candles",
  ].map((name, index) => ({ name, semanticManifestHash: hash(index + 1), rowsHash: hash(index + 21), rowCount: 1 }));
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  return {
    schemaVersion: "KronosFreeTier1FoundryArtifacts/v2",
    status: runner.FREE_TIER1_REAL_FOUNDRY_REPORT_STATUS,
    empiricalExecutionForbidden: false,
    gcsVerifiedReload: true,
    realTier1Blockers: [],
    study: { startMs: Date.UTC(2023, 4, 16, 12), endMs: Date.UTC(2024, 3, 1), timeframeMs: 3_600_000, symbols: ["BTCUSDT", "ETHUSDT"] },
    generation: { generationSha: "a".repeat(40) },
    frozenBookTicker: { rawManifestBundleHash: hash(41), dailyRepairBundleHash: hash(42) },
    artifacts,
    realTier1WalkForwardAuthorization: {
      version: runner.FREE_TIER1_REAL_WALK_FORWARD_AUTHORIZATION_VERSION,
      scopeFreezeReportHash: hash(43),
      rawBookTickerBundleHash: hash(41),
      dailyRepairBundleHash: hash(42),
      listingSemanticManifestHash: byName.get("listing_delisting_timeline")!.semanticManifestHash,
      futuresAvailabilitySemanticManifestHash: byName.get("futures_availability_timeline")!.semanticManifestHash,
    },
  };
}

function artifactRoot(report: ReturnType<typeof realReport>) {
  const root = mkdtempSync(join(tmpdir(), "kronos-free-tier1-walk-forward-"));
  roots.push(root);
  for (const artifact of report.artifacts) mkdirSync(join(root, artifact.semanticManifestHash));
  return root;
}

describe("free Tier-1 walk-forward empirical admission", () => {
  it("accepts only a reload-verified final report whose lifecycle and raw identities bind the selected immutable artifacts", () => {
    const report = realReport();
    expect(() => runner.assertFoundryReport(report, artifactRoot(report))).not.toThrow();
  });

  it("rejects a pre-lifecycle or otherwise non-empirical report", () => {
    const report = realReport();
    report.empiricalExecutionForbidden = true;
    expect(() => runner.assertFoundryReport(report, artifactRoot(report))).toThrow("FREE_TIER1_WALK_FORWARD_FOUNDRY_REPORT_INVALID");
  });

  it("rejects a report whose authorization points to a different lifecycle artifact", () => {
    const report = realReport();
    report.realTier1WalkForwardAuthorization.listingSemanticManifestHash = hash(63);
    expect(() => runner.assertFoundryReport(report, artifactRoot(report))).toThrow("FREE_TIER1_WALK_FORWARD_AUTHORIZATION_BINDING_MISMATCH");
  });
});

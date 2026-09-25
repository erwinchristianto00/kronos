/**
 * Replays the narrow source-backed 2026-01-01 UTC USD-M Tier-1 baseline.
 *
 * Usage (from apps/api):
 *   npx tsx scripts/run-real-tier1-binance-usdm-2026-01-01.ts \
 *     /absolute/path/to/real-tier1-binance-usdm-2026-01-01-v1 1786028400000
 *
 * The timestamp is an explicit archival run timestamp. This script never uses
 * wall-clock state and cannot accept caller-supplied market payloads.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tournamentHash } from "../src/research/contract/tournament-contract.js";
import { assertTier1AssemblyCanRun, assembleTier1Baseline, loadTier1Artifacts, runRealTier1Conservative } from "../src/research/foundry/tier1-assembler.js";
import { persistTournamentRun } from "../src/research/reporting/artifacts.js";
import type { FoundryArtifactKind } from "../src/research/foundry/artifact-schema.js";
import type { TournamentExperimentSpec } from "../src/research/tournament-types.js";

const HOUR_MS = 3_600_000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const START_MS = 1_767_229_200_000; // 2026-01-01T01:00:00.000Z
const END_MS = 1_767_312_000_000; // 2026-01-02T00:00:00.000Z
const ARTIFACT_HASHES = [
  "53c99877f9d5efb3e2e7acaf6fc3752aed38a39cbef7acb3c728f5fd0cb3b988", // warm-up candles
  "e2b43d494d1f4b9dc27741ea4fec66c8bb30b384ca0d4ce09926829e85b8f1b4", // execution candles
  "ceab4895d46e28507aa86ea29cd9f48cd196b4262be29834816e1c7b0950070f", // funding
  "6d92558580c2ca7f35371ba0fb8ca41a1ad8a4ba387484add3d7e40208e981a7", // listing
  "da56eaa37863c378ee1ba0bb7334a3955519a99a304cac2209c1990aa6b0517f", // futures availability
  "74c89ce58e03a06a730ef6d7b65c3027680682f45099e86ab2fa6d4491d4a064", // minimum history
  "055ef411d9b890a5f683dda0cfa8fd8a6f074b875d8ed02027c9baa512d6a0c1", // BBO liquidity/spread
  "fc28b81e8a891e09740825d846aba722352151e1eeedb8a998d2d8a9b62970c3", // portfolio risk
] as const;

const archiveRoot = process.argv[2];
const createdAtMs = Number(process.argv[3]);
if (!archiveRoot || !Number.isInteger(createdAtMs) || createdAtMs <= 0) {
  throw new Error("USAGE: npx tsx scripts/run-real-tier1-binance-usdm-2026-01-01.ts <archive-root> <created-at-ms>");
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain", "--", "apps/api/src/research", "apps/api/scripts/run-real-tier1-binance-usdm-2026-01-01.ts"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(gitCommit) || sourceStatus) throw new Error("REAL_TIER1_SOURCE_COMMIT_NOT_CLEAN");

const root = resolve(archiveRoot);
const foundryRoot = resolve(root, "foundry-artifacts");
const artifacts = loadTier1Artifacts({ rootDir: foundryRoot, semanticManifestHashes: ARTIFACT_HASHES });
const liquidityPolicy = {
  version: "tier1-bbo-liquidity-policy-v1",
  minVolume: 1,
  minLiquidityNotional: 1,
  maxSpreadBps: 10,
  maxAgeMs: HOUR_MS,
} as const;
const archiveRoots: Partial<Record<FoundryArtifactKind, string>> = {
  COMPLETED_CANDLES: resolve(root, "all-candles"),
  FUNDING_SETTLEMENTS: resolve(root, "funding"),
  LISTING_DELISTING_TIMELINE: resolve(root, "raw", "binance-support-announcements"),
  FUTURES_AVAILABILITY_TIMELINE: resolve(root, "raw", "binance-support-announcements"),
  PIT_LIQUIDITY_SPREAD: resolve(root, "liquidity-inputs"),
};
const candidate = assembleTier1Baseline({
  artifacts,
  symbols: SYMBOLS,
  startMs: START_MS,
  endMs: END_MS,
  timeframeMs: HOUR_MS,
  liquidityPolicy,
  researchMode: "REAL_TIER1",
  archiveRoots,
});
assertTier1AssemblyCanRun(candidate);

const executionCandles = artifacts.find((artifact) => artifact.manifest.semanticManifestHash === "e2b43d494d1f4b9dc27741ea4fec66c8bb30b384ca0d4ce09926829e85b8f1b4");
const funding = artifacts.find((artifact) => artifact.manifest.artifactKind === "FUNDING_SETTLEMENTS");
if (!executionCandles || !funding) throw new Error("REAL_TIER1_EXECUTION_ARTIFACT_LOOKUP_FAILED");

const costs = {
  makerFeeBps: 0,
  takerFeeBps: 4,
  baseSlippageBps: 2,
  pessimisticSlippageMultiplier: 2,
  fundingEnabled: true,
  fillMode: "NEXT_OPEN" as const,
  intrabarAmbiguity: "STOP_FIRST" as const,
};
const spec: TournamentExperimentSpec = {
  tournamentVersion: "kronos-research-tournament-v1",
  gitCommit,
  strategyVersion: "tier1-baseline-public-bbo-day-v1",
  randomSeed: 20_260_101,
  capabilityTier: "TIER_1_BASELINE",
  researchMode: "REAL_TIER1",
  dataset: {
    provider: "Binance Vision + Binance Support CMS + Tardis",
    dataRange: { startMs: START_MS, endMs: END_MS },
    candlesHash: executionCandles.manifest.rowsHash,
    fundingHash: funding.manifest.rowsHash,
    executionInputsHash: tournamentHash({ version: "tier1-conservative-execution-v1", costs }),
    historicalUniverseHash: candidate.binding.universeSnapshotHash,
    canonicalEpisodeHash: candidate.binding.episodePolicyHash,
    portfolioRiskHash: candidate.binding.portfolioRiskIdentity,
    artifactSemanticManifestHashes: [...candidate.artifactSemanticHashes],
    artifactKinds: artifacts.map((artifact) => artifact.manifest.artifactKind),
    timeframe: "1h",
    timeframeMs: HOUR_MS,
    universeSnapshots: structuredClone(candidate.universeSnapshots),
    tier1AssemblyBinding: structuredClone(candidate.binding),
  },
  costs,
  portfolio: {
    startingCapital: 10_000,
    riskPerTradeFraction: 0.01,
    maxPositions: 2,
    maxGrossExposureFraction: 1,
    maxNetExposureFraction: 1,
    maxBtcBetaFraction: 1,
    maxCorrelationClusterFraction: 1,
    liquidationBufferFraction: 0.2,
    initialMarginFraction: 0.1,
    maxPortfolioRiskSnapshotAgeMs: HOUR_MS,
  },
  validation: {
    trainBars: 12,
    testBars: 6,
    stepBars: 6,
    purgeBars: 1,
    embargoBars: 1,
    sealedHoldoutStartMs: END_MS,
    minIndependentEpisodes: 1,
    minOosProfitabilityFraction: 0,
  },
  parameters: {
    scope: "BTCUSDT_ETHUSDT_2026-01-01_UTC",
    executionPolicyVersion: "tier1-conservative-execution-v1",
    liquidityPolicyVersion: liquidityPolicy.version,
  },
};

const run = runRealTier1Conservative({ assembly: candidate, spec, createdAtMs });
const persisted = run.result.runs.map((result) => persistTournamentRun(resolve(root, "tournament-runs"), result));

console.log(JSON.stringify({
  label: run.label,
  scope: { symbols: SYMBOLS, startMs: START_MS, endMs: END_MS, timeframeMs: HOUR_MS },
  tier1AssemblyHash: candidate.tier1AssemblyHash,
  artifactSemanticManifestHashes: candidate.artifactSemanticHashes,
  universeSnapshotHash: candidate.binding.universeSnapshotHash,
  randomControlIdentity: run.result.runs[0]?.manifest.spec.parameters.tier1RandomControlIdentity ?? null,
  fairnessHash: run.result.fairnessHashByMode.get("CONSERVATIVE"),
  runs: run.result.runs.map((result) => ({
    strategyId: result.manifest.strategyId,
    runId: result.manifest.runId,
    inputHash: result.manifest.inputHash,
    tradeCount: result.metrics.tradeCount,
    netPnl: result.metrics.netPnl,
    returnFraction: result.metrics.returnFraction,
    sharpe: result.metrics.sharpe,
    calmar: result.metrics.calmar,
    maxDrawdown: result.metrics.maxDrawdown,
    independentEpisodes: result.metrics.independentEpisodes,
    navPoints: result.navLedger.length,
    episodeAssignments: result.episodeLedger?.assignments.length ?? 0,
  })),
  persisted,
}, null, 2));

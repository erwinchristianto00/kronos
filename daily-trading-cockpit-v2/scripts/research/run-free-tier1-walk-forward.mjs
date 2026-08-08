#!/usr/bin/env node
/*
 * Cloud-only execution for the frozen free Binance Vision Tier-1 study.
 * It consumes verified Foundry artifacts and their source archives; it never
 * accepts caller-supplied candles, funding, universe, or random schedules.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { tournamentHash } from "../../apps/api/dist/research/contract/tournament-contract.js";
import { assembleTier1Baseline, assertTier1AssemblyCanRun, loadTier1Artifacts, runRealTier1SealedHoldoutConservative, runRealTier1WalkForwardConservative } from "../../apps/api/dist/research/foundry/tier1-assembler.js";
import { persistTournamentRun } from "../../apps/api/dist/research/reporting/artifacts.js";
import { FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN as PLAN } from "../../apps/api/dist/research/validation/free-binance-vision-2023-05-to-2024-03-plan.js";

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{7,64}$/;
const HOUR_MS = 3_600_000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const START_MS = Date.UTC(2023, 4, 16, 12);
const END_MS = Date.UTC(2024, 3, 1);

function required(name) { const value = process.env[name]; if (!value) throw new Error(`FREE_TIER1_WALK_FORWARD_ENV_REQUIRED_${name}`); return value; }
function integer(name) { const value = Number(required(name)); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`FREE_TIER1_WALK_FORWARD_ENV_INVALID_${name}`); return value; }
function json(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`FREE_TIER1_WALK_FORWARD_JSON_INVALID_${path}`); } }
function writeJson(path, value) { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function hashCheckedReport(path) {
  const value = json(path); const { reportHash, ...core } = value;
  if (!HASH.test(reportHash ?? "") || tournamentHash(core) !== reportHash) throw new Error("FREE_TIER1_WALK_FORWARD_REPORT_HASH_INVALID");
  return value;
}

function artifactByName(report, name) {
  const artifact = report.artifacts?.find((entry) => entry.name === name);
  if (!artifact || !HASH.test(artifact.semanticManifestHash ?? "") || !HASH.test(artifact.rowsHash ?? "")) throw new Error(`FREE_TIER1_WALK_FORWARD_ARTIFACT_MISSING_${name}`);
  return artifact;
}

function selectedArtifacts(report) {
  const names = ["execution_candles", "funding_settlements", "listing_delisting_timeline", "futures_availability_timeline", "minimum_history_eligibility", "pit_liquidity_spread", "pit_portfolio_risk"];
  return names.map((name) => artifactByName(report, name));
}

function assertFoundryReport(report, artifactRoot) {
  if (
    report.schemaVersion !== "KronosFreeTier1FoundryArtifacts/v2"
    || report.status !== "COMPLETE_TIER1_ARTIFACTS_READY_FOR_IMMUTABLE_ASSEMBLY"
    || report.empiricalExecutionForbidden !== true
    || JSON.stringify(report.realTier1Blockers) !== JSON.stringify([])
    || report.study?.startMs !== START_MS
    || report.study?.endMs !== END_MS
    || report.study?.timeframeMs !== HOUR_MS
    || JSON.stringify(report.study?.symbols) !== JSON.stringify(SYMBOLS)
    || report.generation?.generationSha === undefined
  ) throw new Error("FREE_TIER1_WALK_FORWARD_FOUNDRY_REPORT_INVALID");
  const entries = new Set(readdirSync(artifactRoot));
  for (const artifact of [...selectedArtifacts(report), artifactByName(report, "warmup_candles")]) {
    if (!entries.has(artifact.semanticManifestHash)) throw new Error(`FREE_TIER1_WALK_FORWARD_ARTIFACT_STORE_MISSING_${artifact.name}`);
  }
}

function summarize(runs) {
  const groups = new Map();
  for (const run of runs) groups.set(run.manifest.strategyId, [...(groups.get(run.manifest.strategyId) ?? []), run]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([strategyId, strategyRuns]) => {
    const trades = strategyRuns.flatMap((run) => run.trades);
    const episodes = new Set(strategyRuns.flatMap((run) => run.episodeLedger?.assignments.map((assignment) => assignment.episodeId) ?? []));
    const valid = strategyRuns.every((run) => run.valid && run.terminalOpenPositions.length === 0);
    const mean = (field) => strategyRuns.length ? strategyRuns.reduce((sum, run) => sum + (run.metrics[field] ?? 0), 0) / strategyRuns.length : null;
    const gates = [];
    if (strategyRuns.length < PLAN.evidenceGates.minimumOosWindows) gates.push(`OOS_WINDOWS_LT_${PLAN.evidenceGates.minimumOosWindows}`);
    if (trades.length < PLAN.evidenceGates.minimumCompletedTradesPerInterpretedStrategy) gates.push(`TRADES_LT_${PLAN.evidenceGates.minimumCompletedTradesPerInterpretedStrategy}`);
    if (episodes.size < PLAN.evidenceGates.minimumCanonicalIndependentEpisodes) gates.push(`EPISODES_LT_${PLAN.evidenceGates.minimumCanonicalIndependentEpisodes}`);
    if (!valid) gates.push("INVALID_OR_TERMINAL_RUN");
    return {
      strategyId,
      foldCount: strategyRuns.length,
      completedTrades: trades.length,
      independentEpisodes: episodes.size,
      totalNetPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
      meanFoldReturnFraction: mean("returnFraction"),
      meanFoldExpectancyAfterCost: mean("expectancyAfterCost"),
      profitableFoldFraction: strategyRuns.length ? strategyRuns.filter((run) => run.metrics.netPnl > 0).length / strategyRuns.length : null,
      verdict: gates.length ? "INCONCLUSIVE" : "EVIDENCE_GATE_MET",
      gateFailures: gates,
    };
  });
}

function prepare(input) {
  const foundryReport = hashCheckedReport(input.foundryReportPath);
  assertFoundryReport(foundryReport, input.artifactRoot);
  const execution = selectedArtifacts(foundryReport); const warmup = artifactByName(foundryReport, "warmup_candles");
  const artifacts = loadTier1Artifacts({ rootDir: input.artifactRoot, semanticManifestHashes: execution.map((artifact) => artifact.semanticManifestHash) });
  const parents = loadTier1Artifacts({ rootDir: input.artifactRoot, semanticManifestHashes: [warmup.semanticManifestHash] });
  const byHash = new Map([...artifacts, ...parents].map((artifact) => [artifact.manifest.semanticManifestHash, artifact]));
  for (const artifact of [...execution, warmup]) {
    const loaded = byHash.get(artifact.semanticManifestHash);
    if (!loaded || loaded.manifest.rowsHash !== artifact.rowsHash || loaded.manifest.rowCount !== artifact.rowCount) throw new Error(`FREE_TIER1_WALK_FORWARD_ARTIFACT_RELOAD_MISMATCH_${artifact.name}`);
  }
  const liquidityPolicy = {
    version: PLAN.tier1EligibilityPolicy.liquiditySpread.version,
    minVolume: PLAN.tier1EligibilityPolicy.liquiditySpread.minVolume,
    minLiquidityNotional: PLAN.tier1EligibilityPolicy.liquiditySpread.minLiquidityNotional,
    maxSpreadBps: PLAN.tier1EligibilityPolicy.liquiditySpread.maxSpreadBps,
    maxAgeMs: PLAN.tier1EligibilityPolicy.liquiditySpread.maxAgeMs,
  };
  const archiveRoots = {
    COMPLETED_CANDLES: resolve(input.rawRoot, "klines"),
    FUNDING_SETTLEMENTS: resolve(input.rawRoot, "fundingRate"),
    LISTING_DELISTING_TIMELINE: resolve(input.rawRoot, "lifecycle"),
    FUTURES_AVAILABILITY_TIMELINE: resolve(input.rawRoot, "lifecycle"),
    PIT_LIQUIDITY_SPREAD: input.rawRoot,
  };
  const assembly = assembleTier1Baseline({ artifacts, provenanceParents: parents, symbols: SYMBOLS, startMs: START_MS, endMs: END_MS, timeframeMs: HOUR_MS, liquidityPolicy, researchMode: "REAL_TIER1", archiveRoots });
  assertTier1AssemblyCanRun(assembly);
  const candles = byHash.get(artifactByName(foundryReport, "execution_candles").semanticManifestHash);
  const funding = byHash.get(artifactByName(foundryReport, "funding_settlements").semanticManifestHash);
  if (!candles || !funding) throw new Error("FREE_TIER1_WALK_FORWARD_EXECUTION_ARTIFACT_LOOKUP_FAILED");
  const costs = {
    makerFeeBps: PLAN.tier1ConservativeExecution.makerFeeBps,
    takerFeeBps: PLAN.tier1ConservativeExecution.takerFeeBps,
    baseSlippageBps: PLAN.tier1ConservativeExecution.baseSlippageBps,
    pessimisticSlippageMultiplier: PLAN.tier1ConservativeExecution.pessimisticSlippageMultiplier,
    fundingEnabled: PLAN.tier1ConservativeExecution.fundingEnabled,
    fillMode: PLAN.tier1ConservativeExecution.fillMode,
    intrabarAmbiguity: PLAN.tier1ConservativeExecution.intrabarAmbiguity,
  };
  const spec = {
    tournamentVersion: "kronos-research-tournament-v1",
    gitCommit: input.generationSha,
    strategyVersion: "free-binance-vision-baselines-fixed-defaults-v1",
    randomSeed: 20_230_516,
    capabilityTier: "TIER_1_BASELINE",
    researchMode: "REAL_TIER1",
    dataset: {
      provider: "Binance Vision + Binance CMS official exports",
      dataRange: { startMs: START_MS, endMs: END_MS },
      candlesHash: candles.manifest.rowsHash,
      fundingHash: funding.manifest.rowsHash,
      executionInputsHash: tournamentHash({ validationPlanHash: PLAN.artifactHash, costs }),
      historicalUniverseHash: assembly.binding.universeSnapshotHash,
      canonicalEpisodeHash: assembly.binding.episodePolicyHash,
      portfolioRiskHash: assembly.binding.portfolioRiskIdentity,
      artifactSemanticManifestHashes: [...assembly.artifactSemanticHashes],
      artifactKinds: artifacts.map((artifact) => artifact.manifest.artifactKind),
      timeframe: "1h",
      timeframeMs: HOUR_MS,
      universeSnapshots: structuredClone(assembly.universeSnapshots),
      tier1AssemblyBinding: structuredClone(assembly.binding),
    },
    costs,
    portfolio: { ...PLAN.tier1Portfolio },
    validation: { ...PLAN.validation },
    parameters: { validationPlanVersion: PLAN.planVersion, validationPlanHash: PLAN.artifactHash, studyScope: PLAN.studyId, fixedParametersOnly: true },
  };
  return { foundryReport, assembly, spec, artifacts, parents };
}

function persisted(runRoot, runs) {
  const entries = runs.map((run) => ({ runId: run.manifest.runId, inputHash: run.manifest.inputHash, strategyId: run.manifest.strategyId, persisted: persistTournamentRun(runRoot, run) }));
  return { entries, registryHash: entries.at(-1)?.persisted.registryHash ?? tournamentHash([]) };
}

function oos(input) {
  const prepared = prepare(input); const run = runRealTier1WalkForwardConservative({ assembly: prepared.assembly, spec: prepared.spec, createdAtMs: input.createdAtMs });
  const flattened = run.folds.flatMap((fold) => fold.result.runs); const persistedOutput = persisted(input.runRoot, flattened);
  const core = {
    schemaVersion: "KronosFreeTier1OosFreeze/v1",
    status: "OOS_FROZEN_PENDING_SEALED_HOLDOUT",
    empiricalClassification: "REAL_SOURCE_BACKED",
    label: run.label,
    createdAtMs: input.createdAtMs,
    generationSha: input.generationSha,
    validationPlan: { version: PLAN.planVersion, artifactHash: PLAN.artifactHash },
    foundryReportHash: prepared.foundryReport.reportHash,
    tier1AssemblyHash: prepared.assembly.tier1AssemblyHash,
    artifactSemanticManifestHashes: prepared.assembly.artifactSemanticHashes,
    folds: run.folds.map((fold) => ({ foldId: fold.fold.foldId, train: fold.fold.train, purge: fold.fold.purge, test: fold.fold.test, embargo: fold.fold.embargo, testRange: fold.testRange, fairnessHash: fold.fairnessHash, randomControlIdentity: fold.randomControlIdentity, runs: fold.result.runs.map((result) => ({ strategyId: result.manifest.strategyId, runId: result.manifest.runId, inputHash: result.manifest.inputHash, metrics: result.metrics, navPointCount: result.navLedger.length, episodeLedgerHash: result.episodeLedger?.outputHash ?? null })) })),
    oosSummary: summarize(flattened),
    registryHash: persistedOutput.registryHash,
    persistedRuns: persistedOutput.entries,
  };
  const report = { ...core, reportHash: tournamentHash(core) }; writeJson(input.reportPath, report); console.log(JSON.stringify({ status: report.status, reportHash: report.reportHash, foldCount: report.folds.length, assemblyHash: report.tier1AssemblyHash }, null, 2));
}

function holdout(input) {
  const frozenOos = hashCheckedReport(required("OOS_FREEZE_REPORT_PATH"));
  if (frozenOos.status !== "OOS_FROZEN_PENDING_SEALED_HOLDOUT" || frozenOos.empiricalClassification !== "REAL_SOURCE_BACKED" || !HASH.test(frozenOos.reportHash ?? "")) throw new Error("FREE_TIER1_WALK_FORWARD_OOS_FREEZE_INVALID");
  const prepared = prepare(input);
  if (frozenOos.foundryReportHash !== prepared.foundryReport.reportHash || frozenOos.tier1AssemblyHash !== prepared.assembly.tier1AssemblyHash || frozenOos.validationPlan?.artifactHash !== PLAN.artifactHash) throw new Error("FREE_TIER1_WALK_FORWARD_OOS_FREEZE_BINDING_MISMATCH");
  const run = runRealTier1SealedHoldoutConservative({ assembly: prepared.assembly, spec: prepared.spec, createdAtMs: input.createdAtMs, oosFreezeReportHash: frozenOos.reportHash });
  const persistedOutput = persisted(input.runRoot, run.result.runs);
  const core = {
    schemaVersion: "KronosFreeTier1SealedHoldout/v1",
    status: "SEALED_HOLDOUT_EVALUATED_NO_CANDIDATE_CLAIM",
    empiricalClassification: "REAL_SOURCE_BACKED",
    label: run.label,
    createdAtMs: input.createdAtMs,
    generationSha: input.generationSha,
    validationPlan: { version: PLAN.planVersion, artifactHash: PLAN.artifactHash },
    foundryReportHash: prepared.foundryReport.reportHash,
    oosFreezeReportHash: frozenOos.reportHash,
    tier1AssemblyHash: prepared.assembly.tier1AssemblyHash,
    artifactSemanticManifestHashes: prepared.assembly.artifactSemanticHashes,
    holdoutRange: run.holdoutRange,
    fairnessHash: run.fairnessHash,
    randomControlIdentity: run.randomControlIdentity,
    holdoutSummary: summarize(run.result.runs),
    runs: run.result.runs.map((result) => ({ strategyId: result.manifest.strategyId, runId: result.manifest.runId, inputHash: result.manifest.inputHash, metrics: result.metrics, navPointCount: result.navLedger.length, episodeLedgerHash: result.episodeLedger?.outputHash ?? null })),
    registryHash: persistedOutput.registryHash,
    persistedRuns: persistedOutput.entries,
    candidateEdgeVerdict: "NOT_YET_ASSESSED_REQUIRES_COST_FUNDING_STRESS_AND_PARAMETER_STABILITY",
  };
  const report = { ...core, reportHash: tournamentHash(core) }; writeJson(input.reportPath, report); console.log(JSON.stringify({ status: report.status, reportHash: report.reportHash, holdoutRange: report.holdoutRange, assemblyHash: report.tier1AssemblyHash }, null, 2));
}

const mode = process.argv[2];
const input = { rawRoot: required("RAW_ROOT"), artifactRoot: required("ARTIFACT_ROOT"), foundryReportPath: required("FOUNDRY_REPORT_PATH"), runRoot: required("RUN_ROOT"), reportPath: required("REPORT_PATH"), createdAtMs: integer("CREATED_AT_MS"), generationSha: required("GENERATION_SHA") };
if (!SHA.test(input.generationSha)) throw new Error("FREE_TIER1_WALK_FORWARD_GENERATION_SHA_INVALID");
if (mode === "oos") oos(input);
else if (mode === "holdout") holdout(input);
else throw new Error("FREE_TIER1_WALK_FORWARD_MODE_REQUIRED_oos_or_holdout");

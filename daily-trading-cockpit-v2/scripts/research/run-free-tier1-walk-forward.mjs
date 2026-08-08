#!/usr/bin/env node
/*
 * Cloud-only execution for the frozen free Binance Vision Tier-1 study.
 * It consumes verified Foundry artifacts and their source archives; it never
 * accepts caller-supplied candles, funding, universe, or random schedules.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { tournamentHash } from "../../apps/api/src/research/contract/tournament-contract.ts";
import { assembleTier1Baseline, assertTier1AssemblyCanRun, assertVerifiedRealTier1Assembly, bindRealTier1ExperimentSpec, deriveTier1RandomControl, loadTier1Artifacts, runRealTier1SealedHoldoutConservative, runRealTier1WalkForwardConservative } from "../../apps/api/src/research/foundry/tier1-assembler.ts";
import { persistTournamentRun } from "../../apps/api/src/research/reporting/artifacts.ts";
import { assessParameterPlateau } from "../../apps/api/src/research/reporting/governance.ts";
import { runTournamentMatrix } from "../../apps/api/src/research/tournament-runner.ts";
import { FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN as PLAN } from "../../apps/api/src/research/validation/free-binance-vision-2023-05-to-2024-03-plan.ts";
import { assertNoValidationLeakage, buildWalkForwardPlan } from "../../apps/api/src/research/validation/walk-forward.ts";
import { buyAndHoldStrategy, cashStrategy, donchianStrategy, emaCrossStrategy, equalWeightHoldStrategy, macdStrategy, randomTimingControl, rsiMeanReversionStrategy } from "../../apps/api/src/research/strategies/challengers.ts";

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

function summarize(runs, { requireOosWindows = true } = {}) {
  const groups = new Map();
  for (const run of runs) groups.set(run.manifest.strategyId, [...(groups.get(run.manifest.strategyId) ?? []), run]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([strategyId, strategyRuns]) => {
    const trades = strategyRuns.flatMap((run) => run.trades);
    const episodes = new Set(strategyRuns.flatMap((run) => run.episodeLedger?.assignments.map((assignment) => assignment.episodeId) ?? []));
    const invalidRunCount = strategyRuns.filter((run) => !run.valid).length;
    const terminalUnresolvedPositionCount = strategyRuns.reduce((sum, run) => sum + run.terminalOpenPositions.length, 0);
    const valid = invalidRunCount === 0 && terminalUnresolvedPositionCount === 0;
    const mean = (field) => {
      const values = strategyRuns.map((run) => run.metrics[field]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const gates = [];
    if (requireOosWindows && strategyRuns.length < PLAN.evidenceGates.minimumOosWindows) gates.push(`OOS_WINDOWS_LT_${PLAN.evidenceGates.minimumOosWindows}`);
    if (trades.length < PLAN.evidenceGates.minimumCompletedTradesPerInterpretedStrategy) gates.push(`TRADES_LT_${PLAN.evidenceGates.minimumCompletedTradesPerInterpretedStrategy}`);
    if (episodes.size < PLAN.evidenceGates.minimumCanonicalIndependentEpisodes) gates.push(`EPISODES_LT_${PLAN.evidenceGates.minimumCanonicalIndependentEpisodes}`);
    if (invalidRunCount > PLAN.evidenceGates.maximumInvalidFolds) gates.push(`INVALID_RUNS_GT_${PLAN.evidenceGates.maximumInvalidFolds}`);
    if (terminalUnresolvedPositionCount > PLAN.evidenceGates.maximumTerminalUnresolvedPositions) gates.push(`TERMINAL_POSITIONS_GT_${PLAN.evidenceGates.maximumTerminalUnresolvedPositions}`);
    return {
      strategyId,
      foldCount: strategyRuns.length,
      completedTrades: trades.length,
      independentEpisodes: episodes.size,
      validFoldCount: strategyRuns.length - invalidRunCount,
      invalidRunCount,
      terminalUnresolvedPositionCount,
      totalNetPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
      meanFoldReturnFraction: mean("returnFraction"),
      meanFoldExpectancyAfterCost: mean("expectancyAfterCost"),
      meanFoldSharpe: mean("sharpe"),
      meanFoldSortino: mean("sortino"),
      meanFoldCalmar: mean("calmar"),
      meanFoldMaxDrawdown: mean("maxDrawdown"),
      meanFoldProfitableAssetRatio: mean("profitableAssetRatio"),
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
    holdoutSummary: summarize(run.result.runs, { requireOosWindows: false }),
    runs: run.result.runs.map((result) => ({ strategyId: result.manifest.strategyId, runId: result.manifest.runId, inputHash: result.manifest.inputHash, metrics: result.metrics, navPointCount: result.navLedger.length, episodeLedgerHash: result.episodeLedger?.outputHash ?? null })),
    registryHash: persistedOutput.registryHash,
    persistedRuns: persistedOutput.entries,
    candidateEdgeVerdict: "NOT_YET_ASSESSED_REQUIRES_COST_FUNDING_STRESS_AND_PARAMETER_STABILITY",
  };
  const report = { ...core, reportHash: tournamentHash(core) }; writeJson(input.reportPath, report); console.log(JSON.stringify({ status: report.status, reportHash: report.reportHash, holdoutRange: report.holdoutRange, assemblyHash: report.tier1AssemblyHash }, null, 2));
}

function baselineStrategies(assembly, spec, range) {
  const random = deriveTier1RandomControl(assembly, spec.randomSeed, range);
  return {
    random,
    strategies: [cashStrategy(), buyAndHoldStrategy(), equalWeightHoldStrategy(), donchianStrategy(), macdStrategy(), emaCrossStrategy(), rsiMeanReversionStrategy(), randomTimingControl({ reference: random.reference, eligibleEntryTimesBySymbol: random.eligibleEntryTimesBySymbol, seed: spec.randomSeed })],
  };
}

function strategyForNeighborhood(strategyId, parameters) {
  if (strategyId === "DONCHIAN") return donchianStrategy(parameters);
  if (strategyId === "MACD") return macdStrategy(parameters);
  if (strategyId === "EMA_CROSS") return emaCrossStrategy(parameters);
  if (strategyId === "RSI_MEAN_REVERSION") return rsiMeanReversionStrategy(parameters);
  throw new Error(`FREE_TIER1_ROBUSTNESS_UNKNOWN_TACTICAL_STRATEGY_${strategyId}`);
}

function assertEmpiricalRuns(runs, expectedStrategyIds, context) {
  const actual = runs.map((run) => run.manifest.strategyId).sort(); const expected = [...expectedStrategyIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || runs.some((run) => run.manifest.executionMode !== "CONSERVATIVE" || run.manifest.strategyId === "KRONOS_CURRENT" || !run.valid || run.terminalOpenPositions.length || !run.episodeLedger || !run.metrics.canonicalEpisodeProvenanceComplete)) throw new Error(`FREE_TIER1_ROBUSTNESS_EMPIRICAL_RUN_INVALID_${context}`);
  return runs.map((run) => ({ ...run, manifest: { ...run.manifest, empiricalGatePassed: true } }));
}

function runRangeMatrix(input) {
  const snapshots = input.prepared.assembly.universeSnapshots.filter((snapshot) => snapshot.asOfMs >= input.range.startMs && snapshot.asOfMs < input.range.endMs);
  const candles = input.prepared.assembly.canonicalCandles.filter((candle) => candle.openTimeMs >= input.range.startMs && candle.openTimeMs < input.range.endMs);
  const historyCandles = input.prepared.assembly.canonicalCandles.filter((candle) => candle.closeTimeMs < input.range.startMs);
  if (!snapshots.length || !candles.length) throw new Error(`FREE_TIER1_ROBUSTNESS_RANGE_COVERAGE_MISSING_${input.context}`);
  const fundingMultiplier = input.fundingRateMultiplier ?? 1;
  if (!Number.isFinite(fundingMultiplier) || fundingMultiplier < 1) throw new Error("FREE_TIER1_ROBUSTNESS_FUNDING_MULTIPLIER_INVALID");
  const fundingSettlements = input.prepared.assembly.canonicalFundingSettlements.map((settlement) => ({ ...settlement, rate: settlement.rate * fundingMultiplier }));
  const scenario = {
    version: PLAN.robustness.version,
    context: input.context,
    range: input.range,
    fundingRateMultiplier: fundingMultiplier,
    policyHash: tournamentHash(PLAN.robustness),
    ...(input.scenario ?? {}),
  };
  const spec = {
    ...input.bound,
    strategyVersion: `${input.bound.strategyVersion}+${PLAN.robustness.version}`,
    dataset: {
      ...input.bound.dataset,
      dataRange: { ...input.range },
      universeSnapshots: structuredClone(snapshots),
      executionInputsHash: tournamentHash({ baseExecutionInputsHash: input.bound.dataset.executionInputsHash, costs: input.bound.costs, scenario }),
    },
    parameters: {
      ...input.bound.parameters,
      tier1AssemblyHash: input.prepared.assembly.tier1AssemblyHash,
      robustnessScenario: scenario,
      ...(input.extraParameters ?? {}),
    },
  };
  const matrix = runTournamentMatrix({
    spec,
    strategies: input.strategies,
    createdAtMs: input.createdAtMs,
    modes: ["CONSERVATIVE"],
    postTradeEpisodePolicy: input.prepared.assembly.postTradeEpisodePolicy,
    execution: {
      candles,
      historyCandles,
      universe: input.prepared.assembly.universe,
      portfolioRisk: input.prepared.assembly.portfolioRisk,
      fundingSettlements,
      fundingSettlementScheduleBySymbol: new Map(Object.entries(input.prepared.assembly.fundingScheduleBySymbol).map(([symbol, times]) => [symbol, [...times]])),
    },
  });
  return { runs: assertEmpiricalRuns(matrix.runs, input.strategies.map((strategy) => strategy.id), input.context), fairnessHash: matrix.fairnessHashByMode.get("CONSERVATIVE") ?? null };
}

function walkForwardRanges(assembly, bound) {
  const timestamps = [...new Set(assembly.canonicalCandles.map((candle) => candle.openTimeMs))].sort((left, right) => left - right);
  const plan = buildWalkForwardPlan(timestamps, bound.validation); assertNoValidationLeakage(plan);
  if (plan.folds.length < PLAN.evidenceGates.minimumOosWindows) throw new Error("FREE_TIER1_ROBUSTNESS_OOS_FOLD_GATE_UNMET");
  const folds = plan.folds.map((fold) => {
    const startMs = timestamps[fold.test.startIndex]; const lastOpenMs = timestamps[fold.test.endExclusive - 1];
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(lastOpenMs)) throw new Error(`FREE_TIER1_ROBUSTNESS_FOLD_CLOCK_INVALID_${fold.foldId}`);
    return { foldId: fold.foldId, range: { startMs, endMs: lastOpenMs + assembly.timeframeMs } };
  });
  const holdoutStartMs = timestamps[plan.sealedHoldout.startIndex];
  if (!Number.isSafeInteger(holdoutStartMs)) throw new Error("FREE_TIER1_ROBUSTNESS_HOLDOUT_CLOCK_INVALID");
  return { folds, holdout: { startMs: holdoutStartMs, endMs: assembly.range.endMs } };
}

function runCostFundingStress(prepared, bound, ranges, createdAtMs) {
  const policy = PLAN.robustness.costFundingStress;
  const stressBound = {
    ...bound,
    costs: {
      ...bound.costs,
      makerFeeBps: bound.costs.makerFeeBps,
      takerFeeBps: policy.takerFeeBps,
      baseSlippageBps: policy.baseSlippageBps,
      pessimisticSlippageMultiplier: policy.pessimisticSlippageMultiplier,
    },
  };
  const execute = (range, context) => {
    const { random, strategies } = baselineStrategies(prepared.assembly, stressBound, range);
    return runRangeMatrix({ prepared, bound: stressBound, range, strategies, createdAtMs, fundingRateMultiplier: policy.fundingRateMultiplier, context, scenario: { kind: "COST_FUNDING_STRESS", scenarioId: policy.scenarioId, policy }, extraParameters: { tier1RandomControlIdentity: random.identity, tier1RandomControlPolicyVersion: "tier1-random-control-from-donchian-v3" } });
  };
  return {
    policy,
    oos: ranges.folds.map((fold) => ({ foldId: fold.foldId, ...execute(fold.range, `cost-funding-stress:${fold.foldId}`) })),
    holdout: execute(ranges.holdout, "cost-funding-stress:sealed-holdout"),
  };
}

function runParameterNeighborhoods(prepared, bound, ranges, createdAtMs) {
  const policy = PLAN.robustness.parameterNeighborhoods;
  const entries = Object.entries(policy).filter(([strategyId]) => strategyId !== "policyVersion");
  return entries.map(([strategyId, parameterSets]) => {
    if (!Array.isArray(parameterSets)) throw new Error(`FREE_TIER1_ROBUSTNESS_NEIGHBORHOOD_INVALID_${strategyId}`);
    const variants = parameterSets.map((parameters, ordinal) => {
      const parameterHash = tournamentHash({ policyVersion: policy.policyVersion, strategyId, parameters });
      const execute = (range, context) => runRangeMatrix({
        prepared,
        bound,
        range,
        strategies: [strategyForNeighborhood(strategyId, parameters)],
        createdAtMs,
        context,
        scenario: { kind: "PARAMETER_NEIGHBORHOOD", policyVersion: policy.policyVersion, strategyId, parameterHash, ordinal },
        extraParameters: { tier1ParameterNeighborhood: { policyVersion: policy.policyVersion, strategyId, parameterHash, ordinal, parameters } },
      });
      const oos = ranges.folds.map((fold) => ({ foldId: fold.foldId, ...execute(fold.range, `parameter-neighborhood:${strategyId}:${ordinal}:${fold.foldId}`) }));
      const holdout = execute(ranges.holdout, `parameter-neighborhood:${strategyId}:${ordinal}:sealed-holdout`);
      return { ordinal, parameterHash, parameters, oos, holdout };
    });
    return { strategyId, policyVersion: policy.policyVersion, variants };
  });
}

/**
 * Scores only the frozen default against its one-axis OOS neighbours. The
 * sealed holdout is intentionally absent: it remains a final evaluation and
 * cannot influence the stability verdict or any parameter choice.
 */
function assessParameterNeighborhoodStability(neighborhood) {
  const policy = PLAN.robustness.parameterStability;
  const defaultParameters = strategyForNeighborhood(neighborhood.strategyId, {}).parameters;
  const variants = neighborhood.variants.map((variant) => ({
    ...variant,
    oosSummary: summarize(variant.oos.flatMap((fold) => fold.runs)),
  }));
  const selected = variants.find((variant) => tournamentHash(variant.parameters) === tournamentHash(defaultParameters));
  if (!selected) throw new Error(`FREE_TIER1_ROBUSTNESS_DEFAULT_NEIGHBORHOOD_MISSING_${neighborhood.strategyId}`);
  const points = variants.map((variant) => ({
    parameters: variant.parameters,
    oosExpectancy: variant.oosSummary.meanFoldExpectancyAfterCost ?? Number.NEGATIVE_INFINITY,
    conservativePass: variant.oosSummary.verdict === "EVIDENCE_GATE_MET",
    profitableWindowFraction: variant.oosSummary.profitableFoldFraction ?? 0,
    crossAssetRatio: variant.oosSummary.meanFoldProfitableAssetRatio,
  }));
  const plateau = assessParameterPlateau(points, selected.parameters);
  const failures = [];
  if (policy.decisionBasis !== "OOS_ONLY") failures.push("STABILITY_DECISION_BASIS_INVALID");
  if (policy.requiresSelectedConfigurationEvidenceGate && selected.oosSummary.verdict !== "EVIDENCE_GATE_MET") failures.push("SELECTED_OOS_EVIDENCE_GATE_UNMET");
  if (policy.requiresSelectedConfigurationPositiveExpectancy && !(selected.oosSummary.meanFoldExpectancyAfterCost > 0)) failures.push("SELECTED_OOS_EXPECTANCY_NON_POSITIVE");
  if (!plateau.plateauPass || plateau.stableNeighbourFraction < policy.minimumStableNeighbourFraction) failures.push("OOS_PARAMETER_PLATEAU_UNSTABLE");
  return {
    strategyId: neighborhood.strategyId,
    policy: { ...policy },
    selected: { ordinal: selected.ordinal, parameterHash: selected.parameterHash, parameters: selected.parameters, oosSummary: selected.oosSummary },
    plateau,
    verdict: failures.length ? policy.insufficientEvidenceVerdict : "OOS_PARAMETER_STABILITY_MET",
    gateFailures: failures,
  };
}

function runRefs(runs) {
  return runs.map((run) => ({ strategyId: run.manifest.strategyId, runId: run.manifest.runId, inputHash: run.manifest.inputHash, metrics: run.metrics, navPointCount: run.navLedger.length, episodeLedgerHash: run.episodeLedger?.outputHash ?? null }));
}

function robustness(input) {
  const frozenOos = hashCheckedReport(required("OOS_FREEZE_REPORT_PATH")); const sealedHoldout = hashCheckedReport(required("SEALED_HOLDOUT_REPORT_PATH"));
  if (frozenOos.status !== "OOS_FROZEN_PENDING_SEALED_HOLDOUT" || sealedHoldout.status !== "SEALED_HOLDOUT_EVALUATED_NO_CANDIDATE_CLAIM" || frozenOos.reportHash !== sealedHoldout.oosFreezeReportHash) throw new Error("FREE_TIER1_ROBUSTNESS_BASELINE_REPORT_INVALID");
  const prepared = prepare(input); assertVerifiedRealTier1Assembly(prepared.assembly);
  if (frozenOos.foundryReportHash !== prepared.foundryReport.reportHash || sealedHoldout.foundryReportHash !== prepared.foundryReport.reportHash || frozenOos.tier1AssemblyHash !== prepared.assembly.tier1AssemblyHash || sealedHoldout.tier1AssemblyHash !== prepared.assembly.tier1AssemblyHash || frozenOos.validationPlan?.artifactHash !== PLAN.artifactHash || sealedHoldout.validationPlan?.artifactHash !== PLAN.artifactHash) throw new Error("FREE_TIER1_ROBUSTNESS_BASELINE_BINDING_MISMATCH");
  const bound = bindRealTier1ExperimentSpec(prepared.assembly, prepared.spec); const ranges = walkForwardRanges(prepared.assembly, bound);
  const costFundingStress = runCostFundingStress(prepared, bound, ranges, input.createdAtMs); const parameterNeighborhoods = runParameterNeighborhoods(prepared, bound, ranges, input.createdAtMs);
  const parameterNeighborhoodStability = parameterNeighborhoods.map(assessParameterNeighborhoodStability);
  const stressOosRuns = costFundingStress.oos.flatMap((fold) => fold.runs); const stressHoldoutRuns = costFundingStress.holdout.runs;
  const neighborhoodRuns = parameterNeighborhoods.flatMap((neighborhood) => neighborhood.variants.flatMap((variant) => [...variant.oos.flatMap((fold) => fold.runs), ...variant.holdout.runs]));
  const persistedOutput = persisted(input.runRoot, [...stressOosRuns, ...stressHoldoutRuns, ...neighborhoodRuns]);
  const core = {
    schemaVersion: "KronosFreeTier1RobustnessAssessment/v2",
    status: "ROBUSTNESS_ASSESSED_NO_AUTOMATIC_CANDIDATE_CLAIM",
    empiricalClassification: "REAL_SOURCE_BACKED",
    label: prepared.assembly.label,
    createdAtMs: input.createdAtMs,
    generationSha: input.generationSha,
    validationPlan: { version: PLAN.planVersion, artifactHash: PLAN.artifactHash, robustnessPolicyHash: tournamentHash(PLAN.robustness) },
    foundryReportHash: prepared.foundryReport.reportHash,
    oosFreezeReportHash: frozenOos.reportHash,
    sealedHoldoutReportHash: sealedHoldout.reportHash,
    tier1AssemblyHash: prepared.assembly.tier1AssemblyHash,
    artifactSemanticManifestHashes: prepared.assembly.artifactSemanticHashes,
    baseEvidence: { oosSummary: frozenOos.oosSummary, holdoutSummary: sealedHoldout.holdoutSummary },
    costFundingStress: {
      policy: costFundingStress.policy,
      oos: costFundingStress.oos.map((fold) => ({ foldId: fold.foldId, fairnessHash: fold.fairnessHash, runs: runRefs(fold.runs) })),
      oosSummary: summarize(stressOosRuns),
      holdout: { fairnessHash: costFundingStress.holdout.fairnessHash, runs: runRefs(stressHoldoutRuns), summary: summarize(stressHoldoutRuns, { requireOosWindows: false }) },
    },
    parameterNeighborhoods: parameterNeighborhoods.map((neighborhood) => ({
      strategyId: neighborhood.strategyId,
      policyVersion: neighborhood.policyVersion,
      variants: neighborhood.variants.map((variant) => ({ ordinal: variant.ordinal, parameterHash: variant.parameterHash, parameters: variant.parameters, oos: variant.oos.map((fold) => ({ foldId: fold.foldId, fairnessHash: fold.fairnessHash, runs: runRefs(fold.runs) })), oosSummary: summarize(variant.oos.flatMap((fold) => fold.runs)), holdout: { fairnessHash: variant.holdout.fairnessHash, runs: runRefs(variant.holdout.runs), summary: summarize(variant.holdout.runs, { requireOosWindows: false }) } })),
    })),
    parameterNeighborhoodStability,
    registryHash: persistedOutput.registryHash,
    persistedRuns: persistedOutput.entries,
    candidateEdgeVerdict: "NO_AUTOMATIC_CANDIDATE_CLAIM_REQUIRES_SEPARATE_PREDECLARED_EVIDENCE_REVIEW",
  };
  const report = { ...core, reportHash: tournamentHash(core) }; writeJson(input.reportPath, report); console.log(JSON.stringify({ status: report.status, reportHash: report.reportHash, stressOosRunCount: stressOosRuns.length, stressHoldoutRunCount: stressHoldoutRuns.length, neighborhoodRunCount: neighborhoodRuns.length, assemblyHash: report.tier1AssemblyHash }, null, 2));
}

const mode = process.argv[2];
const input = { rawRoot: required("RAW_ROOT"), artifactRoot: required("ARTIFACT_ROOT"), foundryReportPath: required("FOUNDRY_REPORT_PATH"), runRoot: required("RUN_ROOT"), reportPath: required("REPORT_PATH"), createdAtMs: integer("CREATED_AT_MS"), generationSha: required("GENERATION_SHA") };
if (!SHA.test(input.generationSha)) throw new Error("FREE_TIER1_WALK_FORWARD_GENERATION_SHA_INVALID");
if (mode === "oos") oos(input);
else if (mode === "holdout") holdout(input);
else if (mode === "robustness") robustness(input);
else throw new Error("FREE_TIER1_WALK_FORWARD_MODE_REQUIRED_oos_holdout_or_robustness");

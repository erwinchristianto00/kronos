import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertValidTournamentDataset, buildRunManifest } from "../../src/research/contract/tournament-contract.js";
import { runTournament } from "../../src/research/execution/shared-executor.js";
import { assessParameterPlateau, rankTournamentCandidates } from "../../src/research/reporting/governance.js";
import { pairedAblation } from "../../src/research/reporting/ablations.js";
import { persistTournamentRun } from "../../src/research/reporting/artifacts.js";
import { assessCostSensitivity, summarizeOosWindows } from "../../src/research/reporting/oos.js";
import { assertRandomControlPlanParity, randomTimingControl, type TournamentStrategy } from "../../src/research/strategies/challengers.js";
import { runTournamentMatrix, runWalkForwardTournament } from "../../src/research/tournament-runner.js";
import type { TournamentCandle, TournamentExperimentSpec } from "../../src/research/tournament-types.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";
import { PointInTimePortfolioRisk } from "../../src/research/risk/point-in-time-portfolio-risk.js";
import { assertNoValidationLeakage, buildWalkForwardPlan, cartesianParameterGrid } from "../../src/research/validation/walk-forward.js";

const H = 3_600_000;
const snapshot = {
  asOfMs: 0,
  eligibleSymbols: ["BTCUSDT"],
  sourceHash: "universe-hash",
  evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true },
} as const;

function spec(endMs = 4 * H): TournamentExperimentSpec {
  return {
    tournamentVersion: "kronos-research-tournament-v1", gitCommit: "abc123", strategyVersion: "test-v1", randomSeed: 17, capabilityTier: "TIER_2_EXPECTED_EXECUTION", researchMode: "FIXTURE_SMOKE",
    dataset: { provider: "fixture", dataRange: { startMs: 0, endMs }, candlesHash: "candles", fundingHash: "funding", executionInputsHash: "execution-inputs", historicalUniverseHash: "universe", canonicalEpisodeHash: "episodes", portfolioRiskHash: "portfolio-risk", artifactSemanticManifestHashes: ["foundry-semantic-manifest"], artifactKinds: ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS", "PIT_LIQUIDITY_SPREAD", "FEE_ASSUMPTIONS"], timeframe: "1h", timeframeMs: H, universeSnapshots: [snapshot] },
    costs: { makerFeeBps: 0, takerFeeBps: 0, baseSlippageBps: 0, pessimisticSlippageMultiplier: 2, fundingEnabled: false, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" },
    portfolio: { startingCapital: 10_000, riskPerTradeFraction: 0.01, maxPositions: 2, maxGrossExposureFraction: 1, maxNetExposureFraction: 1, maxBtcBetaFraction: 1, maxCorrelationClusterFraction: 1, liquidationBufferFraction: 0.2, initialMarginFraction: 0.1, maxPortfolioRiskSnapshotAgeMs: 2 * H },
    validation: { trainBars: 10, testBars: 5, stepBars: 5, purgeBars: 1, embargoBars: 1, sealedHoldoutStartMs: 3 * H, minIndependentEpisodes: 2, minOosProfitabilityFraction: 0.5 },
    parameters: {},
  };
}

const portfolioRisk = new PointInTimePortfolioRisk([{ asOfMs: 0, validUntilMs: 100 * H, sourceHash: "risk", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 0.8 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "BTC" } }]);
function executionBase() { return { portfolioRisk }; }

function candle(index: number, values: Partial<Pick<TournamentCandle, "open" | "high" | "low" | "close">> = {}): TournamentCandle {
  const open = values.open ?? 100;
  return { symbol: "BTCUSDT", openTimeMs: index * H, closeTimeMs: (index + 1) * H - 1, open, high: values.high ?? open + 1, low: values.low ?? open - 1, close: values.close ?? open, volume: 1_000 };
}

describe("Kronos Research Tournament v1 contract", () => {
  it("fails closed when point-in-time survivorship evidence is incomplete", () => {
    const invalid = structuredClone(spec().dataset);
    invalid.universeSnapshots[0]!.evidence.delistingCheckedThen = false;
    expect(() => assertValidTournamentDataset(invalid)).toThrow("TOURNAMENT_UNIVERSE_SURVIVORSHIP_EVIDENCE_INCOMPLETE");
  });

  it("never resolves a future universe snapshot for an earlier decision", () => {
    const universe = new PointInTimeUniverse([{ ...snapshot, asOfMs: H }]);
    expect(() => universe.at(H - 1)).toThrow("TOURNAMENT_UNIVERSE_LOOKAHEAD_OR_MISSING_SNAPSHOT");
  });

  it("builds a byte-stable run identity from contract inputs rather than wall-clock state", () => {
    const first = buildRunManifest({ spec: spec(), strategyId: "CASH", executionMode: "CONSERVATIVE", parameterSet: { b: 2, a: 1 }, createdAtMs: 1 });
    const second = buildRunManifest({ spec: spec(), strategyId: "CASH", executionMode: "CONSERVATIVE", parameterSet: { a: 1, b: 2 }, createdAtMs: 999 });
    expect(first.runId).toBe(second.runId);
    expect(first.inputHash).toBe(second.inputHash);
  });

  it("random control changes timing only and preserves reference direction, exit and holding templates", () => {
    const strategy = randomTimingControl({
      reference: [
        { referenceId: "a", symbol: "BTCUSDT", referenceEntryTimeMs: H, side: "LONG", stopFraction: 0.02, targetFraction: 0.03, maxHoldBars: 12, exitTemplate: "SAME_EXIT", score: 7, metadata: { reference: "a" } },
        { referenceId: "b", symbol: "BTCUSDT", referenceEntryTimeMs: 15 * H, side: "SHORT", stopFraction: 0.04, targetFraction: 0.05, maxHoldBars: 7, exitTemplate: "SAME_EXIT", score: 3, metadata: { reference: "b" } },
      ], eligibleEntryTimesBySymbol: new Map([["BTCUSDT", Array.from({ length: 40 }, (_, index) => (index + 1) * H)]]), seed: 4,
    });
    const produced = Array.from({ length: 40 }, (_, index) => index).flatMap((index) => strategy.onCompletedBar({ symbol: "BTCUSDT", index, candle: candle(index), history: [], eligibleSymbols: new Set(["BTCUSDT"]), nextOpenTimeMs: (index + 1) * H }));
    expect(produced).toHaveLength(2);
    expect(produced.map((intent) => intent.side).sort()).toEqual(["LONG", "SHORT"]);
    expect(produced.map((intent) => intent.maxHoldBars).sort((a, b) => a - b)).toEqual([7, 12]);
    expect(produced.every((intent) => intent.exitTemplate === "SAME_EXIT" && intent.metadata.randomised === true)).toBe(true);
  });

  it("rejects a random-control plan that changes the concurrency distribution", () => {
    const result = assertRandomControlPlanParity({
      timeline: [H, 2 * H, 3 * H],
      reference: [
        { referenceId: "a", symbol: "BTCUSDT", referenceEntryTimeMs: H, side: "LONG", stopFraction: 0.01, targetFraction: 0.02, maxHoldBars: 2, exitTemplate: "A", score: 1, metadata: {} },
        { referenceId: "b", symbol: "ETHUSDT", referenceEntryTimeMs: 3 * H, side: "SHORT", stopFraction: 0.01, targetFraction: 0.02, maxHoldBars: 1, exitTemplate: "B", score: 1, metadata: {} },
      ],
      planned: [
        { referenceId: "a", symbol: "BTCUSDT", referenceEntryTimeMs: H, entryTimeMs: H, side: "LONG", stopFraction: 0.01, targetFraction: 0.02, maxHoldBars: 2, exitTemplate: "A", score: 1, metadata: {} },
        { referenceId: "b", symbol: "ETHUSDT", referenceEntryTimeMs: 3 * H, entryTimeMs: 2 * H, side: "SHORT", stopFraction: 0.01, targetFraction: 0.02, maxHoldBars: 1, exitTemplate: "B", score: 1, metadata: {} },
      ],
    });
    expect(result.passes).toBe(false);
    expect(result.failures).toContain("CONCURRENCY_PROFILE");
  });

  it("keeps the canonical reference timing when a short archive has no parity-safe shuffle", () => {
    const strategy = randomTimingControl({
      reference: [{ referenceId: "short", symbol: "BTCUSDT", referenceEntryTimeMs: H, side: "LONG", stopFraction: 0.01, targetFraction: 0.02, maxHoldBars: 48, exitTemplate: "SAME_EXIT", score: 1, metadata: {} }],
      eligibleEntryTimesBySymbol: new Map([["BTCUSDT", [H, 2 * H, 3 * H]]]),
      seed: 1_000_000,
    });
    const produced = [0, 1, 2].flatMap((index) => strategy.onCompletedBar({ symbol: "BTCUSDT", index, candle: candle(index), history: [], eligibleSymbols: new Set(["BTCUSDT"]), nextOpenTimeMs: (index + 1) * H }));
    expect(strategy.parameters.timingMode).toBe("PARITY_CONSTRAINED_REFERENCE_TIMING");
    expect(produced.map((intent) => intent.entryAtOpenTimeMs)).toEqual([H]);
  });

  it("uses next-open entry and stop-first ambiguity in CONSERVATIVE mode", () => {
    const strategy: TournamentStrategy = {
      id: "DONCHIAN", version: "fixture", parameters: {},
      onCompletedBar: (bar) => bar.index === 0 && bar.nextOpenTimeMs !== null ? [{ strategyId: "DONCHIAN", symbol: bar.symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: 0.01, targetFraction: 0.01, maxHoldBars: 9, exitTemplate: "FIXTURE", score: 1, metadata: {} }] : [],
    };
    const manifest = buildRunManifest({ spec: spec(3 * H), strategyId: "DONCHIAN", executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 0 });
    const result = runTournament({ manifest, strategy, universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1), candle(2, { high: 102, low: 98, close: 100 })], ...executionBase() });
    expect(result.valid).toBe(true);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTimeMs).toBe(H);
    expect(result.trades[0]!.exitReason).toBe("STOP");
  });

  it("fails EXPECTED execution closed without point-in-time fee and liquidity models", () => {
    const strategy: TournamentStrategy = { id: "CASH", version: "fixture", parameters: {}, onCompletedBar: () => [] };
    const manifest = buildRunManifest({ spec: spec(), strategyId: "CASH", executionMode: "EXPECTED", parameterSet: {}, createdAtMs: 0 });
    const result = runTournament({ manifest, strategy, universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], ...executionBase() });
    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("TOURNAMENT_EXPECTED_LIQUIDITY_EXECUTION_MISSING");
  });

  it("invalidates a run with a missing canonical-clock mark even when the strategy makes no trade", () => {
    const strategy: TournamentStrategy = { id: "CASH", version: "fixture", parameters: {}, onCompletedBar: () => [] };
    const manifest = buildRunManifest({ spec: spec(3 * H), strategyId: "CASH", executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 0 });
    const result = runTournament({ manifest, strategy, universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], ...executionBase() });
    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("FOUNDRY_CANONICAL_CLOCK_MARK_MISSING_BTCUSDT:7200000");
  });

  it("runs every matrix contender against one shared contract and persists an append-only artifact registry", () => {
    const strategy: TournamentStrategy = { id: "CASH", version: "fixture", parameters: {}, onCompletedBar: () => [] };
    const matrix = runTournamentMatrix({
      spec: spec(2 * H), strategies: [strategy], createdAtMs: 0, modes: ["CONSERVATIVE", "EXPECTED"],
      execution: { universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], expectedFeeBpsAt: () => 1, expectedSlippageBpsAt: () => 2, ...executionBase() },
    });
    expect(matrix.runs).toHaveLength(2);
    expect(matrix.runs.every((run) => run.valid)).toBe(true);
    expect(matrix.costSensitivity).toEqual([expect.objectContaining({ strategyId: "CASH", comparable: true })]);
    expect(matrix.runs[0]!.portfolioMetrics.liquidationBufferFraction).toBe(0.2);
    expect(matrix.fairnessHashByMode.get("CONSERVATIVE")).not.toBe(matrix.fairnessHashByMode.get("EXPECTED"));
    const root = mkdtempSync(join(tmpdir(), "krtv1-"));
    try {
      expect(() => persistTournamentRun(root, matrix.runs[0]!)).toThrow("TOURNAMENT_EMPIRICAL_REGISTRY_FIXTURE_FORBIDDEN");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a challenger that mutates the shared completed-candle input", () => {
    const mutator: TournamentStrategy = { id: "CASH", version: "bad", parameters: {}, onCompletedBar: (bar) => { bar.candle.close = 0; return []; } };
    expect(() => runTournamentMatrix({ spec: spec(2 * H), strategies: [mutator], createdAtMs: 0, modes: ["CONSERVATIVE"], execution: { universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], ...executionBase() } })).toThrow();
  });

  it("reports OOS degradation and cost sensitivity only from valid paired ledgers", () => {
    const strategy: TournamentStrategy = { id: "CASH", version: "fixture", parameters: {}, onCompletedBar: () => [] };
    const conservative = runTournament({ manifest: buildRunManifest({ spec: spec(2 * H), strategyId: "CASH", executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 0 }), strategy, universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], ...executionBase() });
    const expected = runTournament({ manifest: buildRunManifest({ spec: spec(2 * H), strategyId: "CASH", executionMode: "EXPECTED", parameterSet: {}, createdAtMs: 0 }), strategy, universe: new PointInTimeUniverse([snapshot]), candles: [candle(0), candle(1)], expectedFeeBpsAt: () => 1, expectedSlippageBpsAt: () => 1, ...executionBase() });
    const oos = summarizeOosWindows([{ foldId: "wf-1", inSampleExpectancyAfterCost: 0.5, result: conservative }]);
    expect(oos.profitableWindowRatio).toBe(0);
    expect(oos.oosExpectancyDegradation).toBe(-0.5);
    expect(assessCostSensitivity([conservative, expected])[0]).toMatchObject({ strategyId: "CASH", comparable: true, conservativeMinusExpected: 0 });
  });

  it("allows an ablation only when its fairness contract matches", () => {
    const metrics = { tradeCount: 1, independentEpisodes: 1, expectancyAfterCost: 1, profitFactor: 1, winRate: 1, payoffRatio: null, sharpe: null, sortino: null, calmar: null, maxDrawdown: 0, netPnl: 1, returnFraction: 0.01, profitableAssetRatio: 1, concentration: { topSymbolNetPnlShare: 1, topRegimeNetPnlShare: 1, topYearNetPnlShare: 1 }, canonicalEpisodeProvenanceComplete: true };
    expect(pairedAblation({ comparison: "regime", baselineFairnessHash: "fair", treatmentFairnessHash: "fair", sameDataExecutionRiskAndPortfolio: true, baseline: metrics, treatment: { ...metrics, netPnl: 2 } }).comparable).toBe(true);
    expect(pairedAblation({ comparison: "regime", baselineFairnessHash: "a", treatmentFairnessHash: "b", sameDataExecutionRiskAndPortfolio: true, baseline: metrics, treatment: metrics }).comparable).toBe(false);
  });

  it("keeps purge, embargo and sealed holdout out of every train/test fold", () => {
    const times = Array.from({ length: 100 }, (_, index) => index * H);
    const plan = buildWalkForwardPlan(times, { ...spec().validation, trainBars: 20, testBars: 10, stepBars: 10, purgeBars: 2, embargoBars: 2, sealedHoldoutStartMs: 80 * H });
    expect(plan.folds.length).toBeGreaterThan(1);
    expect(plan.sealedHoldout.startIndex).toBe(80);
    expect(() => assertNoValidationLeakage(plan)).not.toThrow();
    expect(() => assertNoValidationLeakage({
      ...plan,
      folds: [{ ...plan.folds[0]!, purge: { startIndex: 77, endExclusive: 79 }, test: { startIndex: 79, endExclusive: plan.sealedHoldout.startIndex + 1 }, embargo: { startIndex: plan.sealedHoldout.startIndex + 1, endExclusive: plan.sealedHoldout.startIndex + 2 } }],
    })).toThrow("TOURNAMENT_SEALED_HOLDOUT_LEAK");
  });

  it("runs every OOS fold on its own fixed clock with strictly prior indicator history", () => {
    const endMs = 20 * H; const walkSpec = spec(endMs);
    walkSpec.validation = { ...walkSpec.validation, trainBars: 5, testBars: 3, stepBars: 3, purgeBars: 0, embargoBars: 0, sealedHoldoutStartMs: 16 * H };
    walkSpec.portfolio = { ...walkSpec.portfolio, maxPortfolioRiskSnapshotAgeMs: 100 * H };
    walkSpec.dataset.universeSnapshots = Array.from({ length: 20 }, (_unused, index) => ({ ...snapshot, asOfMs: (index + 1) * H - 1 }));
    const candles = Array.from({ length: 20 }, (_unused, index) => candle(index)); const priorHistoryCounts: number[] = [];
    const output = runWalkForwardTournament({
      spec: walkSpec, candles, createdAtMs: 0, executionMode: "CONSERVATIVE", execution: { universe: new PointInTimeUniverse(walkSpec.dataset.universeSnapshots), ...executionBase() },
      chooseParameters: ({ trainCandles }) => ({ parameters: {}, inSampleExpectancyAfterCost: trainCandles.length }),
      buildStrategy: () => ({ id: "DONCHIAN", version: "walk-forward-fixture", parameters: {}, onCompletedBar: (bar) => {
        if (bar.index === 0) priorHistoryCounts.push(bar.history.length);
        return bar.index === 0 && bar.nextOpenTimeMs !== null ? [{ strategyId: "DONCHIAN", symbol: bar.symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: 0.01, targetFraction: 0.01, maxHoldBars: 1, exitTemplate: "FIXTURE", score: 1, metadata: {} }] : [];
      } }),
    });
    expect(output.folds).toHaveLength(3);
    expect(output.folds.map((fold) => ({ valid: fold.result.valid, invalidReasons: fold.result.invalidReasons }))).toEqual([
      { valid: true, invalidReasons: [] }, { valid: true, invalidReasons: [] }, { valid: true, invalidReasons: [] },
    ]);
    expect(output.folds.map((fold) => fold.result.navLedger.length)).toEqual([3, 3, 3]);
    expect(output.folds.map((fold) => fold.result.manifest.spec.dataset.dataRange)).toEqual([
      { startMs: 5 * H, endMs: 8 * H }, { startMs: 8 * H, endMs: 11 * H }, { startMs: 11 * H, endMs: 14 * H },
    ]);
    expect(priorHistoryCounts).toEqual([5, 8, 11]);
  });

  it("persists every parameter combination and rejects an isolated optimistic peak before ranking", () => {
    expect(cartesianParameterGrid({ fast: [8, 12], slow: [24, 48] })).toHaveLength(4);
    const plateau = assessParameterPlateau([
      { parameters: { fast: 8, slow: 24 }, oosExpectancy: -0.1, conservativePass: false, profitableWindowFraction: 0, crossAssetRatio: 0 },
      { parameters: { fast: 8, slow: 48 }, oosExpectancy: -0.1, conservativePass: false, profitableWindowFraction: 0, crossAssetRatio: 0 },
      { parameters: { fast: 12, slow: 24 }, oosExpectancy: -0.1, conservativePass: false, profitableWindowFraction: 0, crossAssetRatio: 0 },
      { parameters: { fast: 12, slow: 48 }, oosExpectancy: 0.2, conservativePass: true, profitableWindowFraction: 1, crossAssetRatio: 1 },
    ], { fast: 12, slow: 48 });
    expect(plateau.isolatedPeak).toBe(true);
    const ranked = rankTournamentCandidates([{ strategyId: "MACD", metrics: { tradeCount: 40, independentEpisodes: 40, expectancyAfterCost: 0.1, profitFactor: 1.5, winRate: 0.5, payoffRatio: 1.5, sharpe: 1, sortino: 1, calmar: 1, maxDrawdown: 0.1, netPnl: 100, returnFraction: 0.01, profitableAssetRatio: 1, concentration: { topSymbolNetPnlShare: 1, topRegimeNetPnlShare: 1, topYearNetPnlShare: 1 }, canonicalEpisodeProvenanceComplete: true }, researchMode: "REAL_TIER1", capabilityTier: "TIER_2_EXPECTED_EXECUTION", conservativePass: false, plateauPass: false, sealedHoldoutPass: false }]);
    expect(ranked[0]!.rankScore).toBeNull();
    expect(ranked[0]!.hardGate.failures).toContain("CONSERVATIVE_EXECUTION_FAIL");
  });
});

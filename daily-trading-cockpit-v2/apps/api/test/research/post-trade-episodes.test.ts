import { describe, expect, it } from "vitest";

import { hardGate } from "../../src/research/contract/tournament-contract.js";
import { assignCanonicalPostTradeEpisodes, canonicalPostTradeEpisodePolicy } from "../../src/research/post-trade-episodes.js";
import { runTournamentMatrix } from "../../src/research/tournament-runner.js";
import { PointInTimePortfolioRisk } from "../../src/research/risk/point-in-time-portfolio-risk.js";
import type { TournamentExperimentSpec, TournamentTrade } from "../../src/research/tournament-types.js";
import type { TournamentStrategy } from "../../src/research/strategies/challengers.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";

const H = 3_600_000;
const policy = canonicalPostTradeEpisodePolicy(H);

function trade(id: string, input: Partial<TournamentTrade> = {}): TournamentTrade {
  return {
    tradeId: id,
    strategyId: "DONCHIAN",
    symbol: "BTCUSDT",
    side: "LONG",
    decisionTimeMs: H - 1,
    entryTimeMs: H,
    exitTimeMs: 2 * H - 1,
    entryPrice: 100,
    exitPrice: 101,
    quantity: 1,
    notionalAtEntry: 100,
    grossPnl: 1,
    feeCost: 0,
    slippageCost: 0,
    fundingCost: 0,
    netPnl: 1,
    exitReason: "TIME",
    holdingBars: 1,
    canonicalCycleId: null,
    canonicalCycleSourceHash: null,
    persistedMarketCauseId: null,
    persistedMarketCauseSourceHash: null,
    marketEpisodeId: "POST_TRADE_PENDING",
    regime: null,
    ...input,
  };
}

describe("canonical post-trade episode assignment", () => {
  it("assigns baseline trades even when no historical Kronos decision ever occurred at their timestamps", () => {
    const ledger = assignCanonicalPostTradeEpisodes({
      policy,
      trades: [trade("baseline-at-unseen-time", { decisionTimeMs: 91 * H - 1, entryTimeMs: 91 * H, exitTimeMs: 92 * H - 1 })],
    });
    expect(ledger.assignments).toHaveLength(1);
    expect(ledger.assignments[0]!.episodeId).toMatch(/^kronos-episode-/);
    expect(ledger.policy).toEqual(policy);
  });

  it("collapses a sourced shared cause across symbols, while separate causes remain independent", () => {
    const shared = assignCanonicalPostTradeEpisodes({
      policy,
      trades: [
        trade("btc-shared", { persistedMarketCauseId: "cause-42", persistedMarketCauseSourceHash: "cause-export-a" }),
        trade("eth-shared", { symbol: "ETHUSDT", decisionTimeMs: 100 * H - 1, entryTimeMs: 100 * H, exitTimeMs: 101 * H - 1, persistedMarketCauseId: "cause-42", persistedMarketCauseSourceHash: "cause-export-a" }),
      ],
    });
    expect(new Set(shared.assignments.map((assignment) => assignment.episodeId)).size).toBe(1);
    const separate = assignCanonicalPostTradeEpisodes({
      policy,
      trades: [
        trade("btc-a", { persistedMarketCauseId: "cause-a", persistedMarketCauseSourceHash: "cause-export-a" }),
        trade("eth-b", { symbol: "ETHUSDT", decisionTimeMs: 100 * H - 1, entryTimeMs: 100 * H, exitTimeMs: 101 * H - 1, persistedMarketCauseId: "cause-b", persistedMarketCauseSourceHash: "cause-export-b" }),
      ],
    });
    expect(new Set(separate.assignments.map((assignment) => assignment.episodeId)).size).toBe(2);
  });

  it("does not derive a durable ID from calendar, strategy, symbol, or outcome", () => {
    const baseline = assignCanonicalPostTradeEpisodes({ policy, trades: [trade("first", { marketEpisodeId: "calendar-day:2026-01-01" })] });
    const changedNonIdentityFields = assignCanonicalPostTradeEpisodes({
      policy,
      trades: [trade("different-binding", { strategyId: "RSI_MEAN_REVERSION", symbol: "ETHUSDT", side: "SHORT", grossPnl: -999, netPnl: -999, marketEpisodeId: "strategy:RSI_MEAN_REVERSION" })],
    });
    expect(baseline.assignments[0]!.episodeId).toBe(changedNonIdentityFields.assignments[0]!.episodeId);
    expect(baseline.assignments[0]!.episodeId).not.toContain("calendar-day");
    expect(() => assignCanonicalPostTradeEpisodes({ policy, trades: [trade("partial-cause", { persistedMarketCauseId: "cause", persistedMarketCauseSourceHash: null })] })).toThrow("TOURNAMENT_POST_TRADE_EPISODE_MARKET_CAUSE_PROVENANCE_INCOMPLETE");
  });

  it("is deterministic and keeps independent-evidence gates conservative", () => {
    const trades = [
      trade("same-a", { persistedMarketCauseId: "same", persistedMarketCauseSourceHash: "source" }),
      trade("same-b", { symbol: "ETHUSDT", decisionTimeMs: 100 * H - 1, entryTimeMs: 100 * H, exitTimeMs: 101 * H - 1, persistedMarketCauseId: "same", persistedMarketCauseSourceHash: "source" }),
    ];
    const first = assignCanonicalPostTradeEpisodes({ policy, trades });
    const second = assignCanonicalPostTradeEpisodes({ policy, trades: [...trades].reverse() });
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.outputHash).toBe(second.outputHash);
    const episodes = new Set(first.assignments.map((assignment) => assignment.episodeId)).size;
    const verdict = hardGate({ tradeCount: 2, independentEpisodes: episodes, expectancyAfterCost: 1, profitFactor: 2, winRate: 1, payoffRatio: null, sharpe: null, calmar: null, maxDrawdown: 0, netPnl: 2, returnFraction: 0.01, profitableAssetRatio: 1, concentration: { topSymbolNetPnlShare: 0.5, topRegimeNetPnlShare: 1, topYearNetPnlShare: 1 }, canonicalEpisodeProvenanceComplete: true }, { minIndependentEpisodes: 2, minProfitFactor: 1, maxDrawdown: 1, minProfitableAssetRatio: 0, conservativePass: true, stablePlateau: true, sealedHoldoutPass: true, maxTopSymbolNetPnlShare: 1, maxTopRegimeNetPnlShare: 1, maxTopYearNetPnlShare: 1 });
    expect(verdict.failures).toContain("INDEPENDENT_EVIDENCE_INSUFFICIENT");
  });

  it("clusters actual baseline output after execution, without a pre-run episode map", () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const candles = symbols.flatMap((symbol) => [0, H, 2 * H].map((openTimeMs) => ({ symbol, openTimeMs, closeTimeMs: openTimeMs + H - 1, open: 100, high: 101, low: 99, close: 100, volume: 1 })));
    const strategy: TournamentStrategy = {
      id: "EQUAL_WEIGHT_HOLD", version: "baseline-fixture", parameters: {},
      onCompletedBar: (bar) => bar.index === 0 && bar.nextOpenTimeMs !== null ? [{ strategyId: "EQUAL_WEIGHT_HOLD", symbol: bar.symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: null, targetFraction: null, maxHoldBars: 1, exitTemplate: "FIXTURE", score: 1, metadata: { benchmark: true, equalWeight: true }, canonicalCycleId: "source-batch-1", canonicalCycleSourceHash: "batch-export-hash" }] : [],
    };
    const spec: TournamentExperimentSpec = {
      tournamentVersion: "kronos-research-tournament-v1", gitCommit: "fixture", strategyVersion: "baseline-fixture", randomSeed: 7, capabilityTier: "TIER_1_BASELINE", researchMode: "FIXTURE_SMOKE",
      dataset: { provider: "fixture", dataRange: { startMs: 0, endMs: 3 * H }, candlesHash: "candles", fundingHash: "funding", executionInputsHash: "conservative", historicalUniverseHash: "universe", canonicalEpisodeHash: "post-trade-policy", portfolioRiskHash: "risk", artifactSemanticManifestHashes: ["fixture-artifact"], artifactKinds: ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "PORTFOLIO_RISK_SNAPSHOTS"], timeframe: "1h", timeframeMs: H, universeSnapshots: [{ asOfMs: 0, eligibleSymbols: symbols, sourceHash: "universe", evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true } }] },
      costs: { makerFeeBps: 0, takerFeeBps: 0, baseSlippageBps: 0, pessimisticSlippageMultiplier: 2, fundingEnabled: false, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" },
      portfolio: { startingCapital: 10_000, riskPerTradeFraction: 0.01, maxPositions: 2, maxGrossExposureFraction: 1, maxNetExposureFraction: 1, maxBtcBetaFraction: 1, maxCorrelationClusterFraction: 1, liquidationBufferFraction: 0.1, initialMarginFraction: 0.1, maxPortfolioRiskSnapshotAgeMs: H },
      validation: { trainBars: 1, testBars: 1, stepBars: 1, purgeBars: 0, embargoBars: 0, sealedHoldoutStartMs: 2 * H, minIndependentEpisodes: 1, minOosProfitabilityFraction: 0 }, parameters: {},
    };
    const matrix = runTournamentMatrix({
      spec, strategies: [strategy], createdAtMs: 0, modes: ["CONSERVATIVE"], postTradeEpisodePolicy: policy,
      execution: { candles, universe: new PointInTimeUniverse(spec.dataset.universeSnapshots), portfolioRisk: new PointInTimePortfolioRisk([{ asOfMs: 0, validUntilMs: 3 * H, sourceHash: "risk", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 0.8 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "BTC" } }]) },
    });
    const run = matrix.runs[0]!;
    expect(run.trades).toHaveLength(2);
    expect(run.episodeLedger?.assignments).toHaveLength(2);
    expect(new Set(run.trades.map((trade) => trade.marketEpisodeId)).size).toBe(1);
    expect(run.metrics).toMatchObject({ canonicalEpisodeProvenanceComplete: true, independentEpisodes: 1 });
  });
});

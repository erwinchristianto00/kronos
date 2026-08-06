import { describe, expect, it } from "vitest";

import { assertTierAllowsRun, buildRunManifest, hardGate } from "../../src/research/contract/tournament-contract.js";
import { runTournament } from "../../src/research/execution/shared-executor.js";
import { assertCompleteFoundryArtifact, buildFoundryArtifactManifest } from "../../src/research/foundry/artifact-schema.js";
import { buildFoundryCoverageReport } from "../../src/research/foundry/coverage-report.js";
import { PointInTimePortfolioRisk } from "../../src/research/risk/point-in-time-portfolio-risk.js";
import type { TournamentCandle, TournamentExperimentSpec } from "../../src/research/tournament-types.js";
import type { TournamentStrategy } from "../../src/research/strategies/challengers.js";
import { PointInTimeUniverse } from "../../src/research/universe/point-in-time-universe.js";
import type { ValidatedAbsence } from "../../src/research/foundry/canonical-clock.js";
import { fixtureSourceProvenance } from "../../src/research/foundry/source-provenance.js";

const H = 3_600_000;
const symbols = ["BTCUSDT", "ETHUSDT"];
const universeSnapshot = { asOfMs: 0, eligibleSymbols: symbols, sourceHash: "universe", evidence: { listedThen: true, sufficientHistoryThen: true, liquidityVolumeEligibleThen: true, spreadEligibleThen: true, futuresAvailableThen: true, delistingCheckedThen: true } } as const;

function spec(overrides: Partial<TournamentExperimentSpec> = {}): TournamentExperimentSpec {
  return {
    tournamentVersion: "kronos-research-tournament-v1", gitCommit: "fixture", strategyVersion: "fixture", randomSeed: 1, capabilityTier: "TIER_2_EXPECTED_EXECUTION", researchMode: "FIXTURE_SMOKE",
    dataset: { provider: "fixture", dataRange: { startMs: 0, endMs: 4 * H }, candlesHash: "candles", fundingHash: "funding", executionInputsHash: "execution", historicalUniverseHash: "universe", canonicalEpisodeHash: "episodes", portfolioRiskHash: "risk", artifactSemanticManifestHashes: ["artifact"], artifactKinds: ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS", "PIT_LIQUIDITY_SPREAD", "FEE_ASSUMPTIONS"], timeframe: "1h", timeframeMs: H, universeSnapshots: [universeSnapshot] },
    costs: { makerFeeBps: 0, takerFeeBps: 0, baseSlippageBps: 0, pessimisticSlippageMultiplier: 2, fundingEnabled: false, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" },
    portfolio: { startingCapital: 10_000, riskPerTradeFraction: 0.01, maxPositions: 2, maxGrossExposureFraction: 1, maxNetExposureFraction: 1, maxBtcBetaFraction: 1, maxCorrelationClusterFraction: 1, liquidationBufferFraction: 0.2, initialMarginFraction: 0.1, maxPortfolioRiskSnapshotAgeMs: 10 * H },
    validation: { trainBars: 2, testBars: 2, stepBars: 1, purgeBars: 0, embargoBars: 0, sealedHoldoutStartMs: 6 * H, minIndependentEpisodes: 2, minOosProfitabilityFraction: 0.5 }, parameters: {}, ...overrides,
  };
}

function candles(symbol = "BTCUSDT", closes = [100, 100, 50, 100]): TournamentCandle[] {
  return closes.map((close, index) => ({ symbol, openTimeMs: index * H, closeTimeMs: (index + 1) * H - 1, open: index === 0 ? close : closes[index - 1]!, high: Math.max(close, index === 0 ? close : closes[index - 1]!) + 1, low: Math.min(close, index === 0 ? close : closes[index - 1]!) - 1, close, volume: 1_000 }));
}

const holdStrategy = (id: "BTC_BUY_AND_HOLD" | "EQUAL_WEIGHT_HOLD" = "BTC_BUY_AND_HOLD"): TournamentStrategy => ({
  id, version: "fixture", parameters: {},
  onCompletedBar: (bar) => bar.index === 0 && bar.nextOpenTimeMs !== null ? [{ strategyId: id, symbol: bar.symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: null, targetFraction: null, maxHoldBars: Number.MAX_SAFE_INTEGER, exitTemplate: "END", score: 1, metadata: { benchmark: true, equalWeight: id === "EQUAL_WEIGHT_HOLD" } }] : [],
});

function risk(snapshots = [{ asOfMs: 0, validUntilMs: 10 * H, sourceHash: "risk", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 0 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "ETH" } }]) { return new PointInTimePortfolioRisk(snapshots); }
function run(input: { strategy?: TournamentStrategy; candles?: TournamentCandle[]; experiment?: TournamentExperimentSpec; portfolioRisk?: PointInTimePortfolioRisk; fundingSettlements?: Parameters<typeof runTournament>[0]["fundingSettlements"]; fundingSettlementScheduleBySymbol?: Parameters<typeof runTournament>[0]["fundingSettlementScheduleBySymbol"]; absences?: readonly ValidatedAbsence[] }) {
  const experiment = input.experiment ?? spec(); const strategy = input.strategy ?? holdStrategy(); const rows = input.candles ?? candles(); const eligibleSymbols = [...new Set(rows.map((row) => row.symbol))];
  return runTournament({ manifest: buildRunManifest({ spec: experiment, strategyId: strategy.id, executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 0 }), strategy, candles: rows, universe: new PointInTimeUniverse([{ ...universeSnapshot, eligibleSymbols }]), portfolioRisk: input.portfolioRisk ?? risk(), fundingSettlements: input.fundingSettlements, fundingSettlementScheduleBySymbol: input.fundingSettlementScheduleBySymbol, validatedAbsences: input.absences });
}

describe("Dataset Foundry and methodology hardening", () => {
  it("uses interval NAV returns rather than a single trade-close pseudo-Sharpe and sees drawdown before exit", () => {
    const result = run({ candles: candles("BTCUSDT", [100, 100, 50, 100]) });
    expect(result.valid).toBe(true);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.netPnl).toBe(0);
    expect(result.metrics.sharpe).not.toBeNull();
    expect(result.metrics.maxDrawdown).toBeGreaterThan(0.35);
    expect(result.navLedger.some((point) => point.unrealizedPnl < -3_000)).toBe(true);
    expect(result.navLedger.slice(1).every((point, index) => point.timestampMs - result.navLedger[index]!.timestampMs === H)).toBe(true);
  });

  it("records exactly one NAV point for every canonical tick, including sourced HALTED marks", () => {
    const all = candles("BTCUSDT", [100, 100, 50, 100]); const withoutThird = all.filter((row) => row.openTimeMs !== 2 * H);
    const result = run({ candles: withoutThird, absences: [{ symbol: "BTCUSDT", openTimeMs: 2 * H, reason: "HALTED", sourceHash: "halt-evidence", markPrice: 50, markPolicy: "OFFICIAL_HALT_MARK" }] });
    expect(result.valid).toBe(true);
    expect(result.navLedger).toHaveLength(4);
    expect(result.navLedger.map((point) => point.timestampMs)).toEqual([0, H, 2 * H, 3 * H]);
    expect(result.navLedger[2]!.unrealizedPnl).toBeLessThan(-3_000);
    expect(run({ candles: withoutThird, absences: [{ symbol: "BTCUSDT", openTimeMs: 2 * H, reason: "DATA_UNAVAILABLE", sourceHash: "no-data" }] }).valid).toBe(false);
  });

  it("does not invent an END_OF_DATA fill from a final HALTED mark", () => {
    const all = candles("BTCUSDT", [100, 100, 75, 50]); const withoutHalts = all.filter((row) => row.openTimeMs < 2 * H);
    const result = run({ candles: withoutHalts, absences: [
      { symbol: "BTCUSDT", openTimeMs: 2 * H, reason: "HALTED", sourceHash: "halt-2", markPrice: 75, markPolicy: "OFFICIAL_HALT_MARK" },
      { symbol: "BTCUSDT", openTimeMs: 3 * H, reason: "HALTED", sourceHash: "halt-3", markPrice: 50, markPolicy: "OFFICIAL_HALT_MARK" },
    ] });
    expect(result.valid).toBe(false); expect(result.invalidReasons).toContain("TERMINAL_POSITION_UNRESOLVED");
    expect(result.terminalOpenPositions).toMatchObject([{ symbol: "BTCUSDT", blocker: "TERMINAL_POSITION_UNRESOLVED" }]);
    expect(result.trades).toHaveLength(0); expect(result.navLedger).toHaveLength(4);
    expect(result.terminalOpenPositions[0]!.unrealizedPnl).toBe(result.navLedger.at(-1)!.unrealizedPnl);
    expect(result.metrics.terminalPositionsResolved).toBe(false);
    expect(hardGate(result.metrics, { minIndependentEpisodes: 0, minProfitFactor: 0, maxDrawdown: 1, minProfitableAssetRatio: 0, conservativePass: true, stablePlateau: true, sealedHoldoutPass: true, maxTopSymbolNetPnlShare: 1, maxTopRegimeNetPnlShare: 1, maxTopYearNetPnlShare: 1 }).failures).toContain("TERMINAL_POSITION_UNRESOLVED");
  });

  it("leaves direct execution provisional until the canonical post-trade ledger is attached", () => {
    const result = run({});
    expect(result.valid).toBe(true);
    expect(result.metrics.canonicalEpisodeProvenanceComplete).toBe(false);
    expect(result.metrics.independentEpisodes).toBe(0);
    expect(result.trades[0]!.marketEpisodeId).toBe("POST_TRADE_PENDING");
    expect(hardGate(result.metrics, { minIndependentEpisodes: 1, minProfitFactor: 0, maxDrawdown: 1, minProfitableAssetRatio: 0, conservativePass: true, stablePlateau: true, sealedHoldoutPass: true, maxTopSymbolNetPnlShare: 1, maxTopRegimeNetPnlShare: 1, maxTopYearNetPnlShare: 1 }).failures).toContain("CANONICAL_EPISODE_PROVENANCE_MISSING");
  });

  it("accrues exactly the actual funding settlements and invalidates a missing required one", () => {
    const experiment = spec({ costs: { ...spec().costs, fundingEnabled: true } });
    const settlement = (canonicalSettlementTimeMs: number, rate: number, observedSettlementTimeMs = canonicalSettlementTimeMs) => ({ symbol: "BTCUSDT", canonicalSettlementTimeMs, observedSettlementTimeMs, alignmentOffsetMs: observedSettlementTimeMs - canonicalSettlementTimeMs, scheduleSourceHash: "schedule", rate, sourceHash: "funding" });
    const settled = run({ experiment, fundingSettlements: [settlement(2 * H, 0.01, 2 * H + 8), settlement(3 * H, 0.02)], fundingSettlementScheduleBySymbol: new Map([["BTCUSDT", [2 * H, 3 * H]]]) });
    expect(settled.valid).toBe(true);
    expect(settled.trades[0]!.fundingCost).toBeCloseTo(240);
    const missing = run({ experiment, fundingSettlements: [settlement(2 * H, 0.01)], fundingSettlementScheduleBySymbol: new Map([["BTCUSDT", [2 * H, 3 * H]]]) });
    expect(missing.valid).toBe(false);
    expect(missing.invalidReasons).toContain("TOURNAMENT_FUNDING_SETTLEMENT_MISSING_BTCUSDT_10800000");
  });

  it("uses as-of beta/cluster snapshots for admission and rejects future or stale risk", () => {
    const twoSymbolCandles = [...candles("BTCUSDT"), ...candles("ETHUSDT")];
    const twoSymbol = holdStrategy("EQUAL_WEIGHT_HOLD");
    const portfolio = { ...spec().portfolio, maxBtcBetaFraction: 0.6 };
    const earlyEthZero = risk([{ asOfMs: 0, validUntilMs: 10 * H, sourceHash: "risk-a", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 0 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "ETH" } }]);
    const atFillEthOne = risk([{ asOfMs: 0, validUntilMs: H - 1, sourceHash: "risk-a", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 0 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "ETH" } }, { asOfMs: H, validUntilMs: 10 * H, sourceHash: "risk-b", btcBetaBySymbol: { BTCUSDT: 1, ETHUSDT: 1 }, correlationClusterBySymbol: { BTCUSDT: "BTC", ETHUSDT: "ETH" } }]);
    expect(run({ strategy: twoSymbol, candles: twoSymbolCandles, experiment: spec({ portfolio }), portfolioRisk: earlyEthZero }).trades).toHaveLength(2);
    expect(run({ strategy: twoSymbol, candles: twoSymbolCandles, experiment: spec({ portfolio }), portfolioRisk: atFillEthOne }).trades).toHaveLength(1);
    expect(() => risk([{ asOfMs: H, validUntilMs: 2 * H, sourceHash: "future", btcBetaBySymbol: { BTCUSDT: 1 }, correlationClusterBySymbol: { BTCUSDT: "BTC" } }]).at("BTCUSDT", 0, H)).toThrow("TOURNAMENT_PORTFOLIO_RISK_FUTURE_OR_MISSING");
    expect(() => risk([{ asOfMs: 0, validUntilMs: H, sourceHash: "stale", btcBetaBySymbol: { BTCUSDT: 1 }, correlationClusterBySymbol: { BTCUSDT: "BTC" } }]).at("BTCUSDT", 2 * H, H)).toThrow("TOURNAMENT_PORTFOLIO_RISK_STALE");
  });

  it("prevents tier overclaiming and creates deterministic complete Foundry artifacts", () => {
    expect(() => assertTierAllowsRun({ tier: "TIER_1_BASELINE", strategyId: "CASH", executionMode: "EXPECTED" })).toThrow("TOURNAMENT_TIER_1_CONSERVATIVE_ONLY");
    expect(() => assertTierAllowsRun({ tier: "TIER_2_EXPECTED_EXECUTION", strategyId: "KRONOS_CURRENT", executionMode: "CONSERVATIVE" })).toThrow("TOURNAMENT_TIER_EXACT_KRONOS_LEDGER_REQUIRED");
    const base = { artifactKind: "COMPLETED_CANDLES" as const, schemaVersion: "v1" as const, source: "fixture", sourceProvenance: fixtureSourceProvenance("fixture", "0000000"), units: { price: "USDT", volume: "BTC" }, generatedAtMs: 1, generationSha: "abc", expectedCoverage: { startMs: 0, endMs: H, symbols: ["BTCUSDT"], cadenceMs: H }, rows: [{ symbol: "BTCUSDT", openTimeMs: 0, closeTimeMs: H - 1, open: 1, high: 2, low: 1, close: 2, volume: 1, sourceHash: "source" }] };
    const first = buildFoundryArtifactManifest(base); const second = buildFoundryArtifactManifest({ ...base, rows: [{ ...base.rows[0] }] });
    expect(first.semanticManifestHash).toBe(second.semanticManifestHash); expect(() => assertCompleteFoundryArtifact(first)).not.toThrow();
    expect(buildFoundryCoverageReport([first])).toMatchObject({ complete: true, artifactCount: 1 });
    expect(() => assertCompleteFoundryArtifact({ ...first, missingDataReport: ["missing"] })).toThrow("FOUNDRY_ARTIFACT_COVERAGE_INCOMPLETE");
    expect(() => buildRunManifest({ spec: { ...spec(), capabilityTier: "TIER_3_EXACT_KRONOS" }, strategyId: "KRONOS_CURRENT", executionMode: "CONSERVATIVE", parameterSet: {}, createdAtMs: 0 })).toThrow("TOURNAMENT_TIER_ARTIFACT_MISSING_KRONOS_DECISION_LEDGER");
  });
});

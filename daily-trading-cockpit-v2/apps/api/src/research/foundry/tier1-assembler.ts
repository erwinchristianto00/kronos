import { tournamentHash } from "../contract/tournament-contract.js";
import { PointInTimePortfolioRisk } from "../risk/point-in-time-portfolio-risk.js";
import { PointInTimeUniverse } from "../universe/point-in-time-universe.js";
import { buildCanonicalClock } from "./canonical-clock.js";
import { assertCompleteFoundryArtifact, type FoundryArtifactKind, type FoundryArtifactManifest } from "./artifact-schema.js";
import { loadFoundryArtifact } from "./artifact-store.js";
import { assertEligibilityTimelineConsistency } from "./cross-artifact-validator.js";
import { futuresTimeline, listingTimeline, minimumHistoryTimeline } from "./stateful-timeline.js";
import { buildTier1CapabilityReport, type Tier1CapabilityReport } from "./tier1-capability.js";
import { riskSnapshotsFromArtifactRows } from "./tier1-pit-artifacts.js";
import type { ValidatedFoundryRow } from "./semantic-validators.js";
import { PointInTimeLiquiditySpread, type Tier1LiquiditySpreadPolicy } from "./liquidity-eligibility.js";
import { runTournamentMatrix, type TournamentMatrixResult } from "../tournament-runner.js";
import type { FundingSettlement, PointInTimeUniverseSnapshot, TournamentCandle, TournamentExperimentSpec } from "../tournament-types.js";
import { buyAndHoldStrategy, cashStrategy, donchianStrategy, emaCrossStrategy, equalWeightHoldStrategy, macdStrategy, randomTimingControl, rsiMeanReversionStrategy, type RandomControlReference } from "../strategies/challengers.js";

const REQUIRED = ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS"] as const;
type RequiredKind = typeof REQUIRED[number];
export interface Tier1LoadedArtifact { manifest: FoundryArtifactManifest; rows: ValidatedFoundryRow[]; }
export interface Tier1Assembly {
  label: "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS";
  capability: Tier1CapabilityReport;
  universe: PointInTimeUniverse;
  universeSnapshots: PointInTimeUniverseSnapshot[];
  fundingSettlementScheduleBySymbol: ReadonlyMap<string, readonly number[]>;
  canonicalEpisodeIdAt: (symbol: string, decisionTimeMs: number) => string | null;
  portfolioRisk: PointInTimePortfolioRisk;
  artifactSemanticHashes: string[];
}

function byKind(artifacts: readonly Tier1LoadedArtifact[]): Map<FoundryArtifactKind, Tier1LoadedArtifact> { return new Map(artifacts.map((artifact) => [artifact.manifest.artifactKind, artifact])); }

/** Immutable-store entry point. It verifies reload before any Tier-1 input is constructed. */
export function loadTier1Artifacts(input: { rootDir: string; semanticManifestHashes: readonly string[] }): Tier1LoadedArtifact[] {
  return input.semanticManifestHashes.map((semanticManifestHash) => { const loaded = loadFoundryArtifact({ rootDir: input.rootDir, semanticManifestHash }); return { manifest: loaded.manifest, rows: loaded.rows as ValidatedFoundryRow[] }; });
}

/** Builds Tier-1 execution adapters only if every source-backed artifact is complete and coherent. */
export function assembleTier1Baseline(input: { artifacts: readonly Tier1LoadedArtifact[]; symbols: readonly string[]; startMs: number; endMs: number; timeframeMs: number; liquidityPolicy: Tier1LiquiditySpreadPolicy }): Tier1Assembly | { label: "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS"; capability: Tier1CapabilityReport } {
  const capability = buildTier1CapabilityReport(input.artifacts.map((artifact) => artifact.manifest)); const label = "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS" as const;
  if (!capability.canRun) return { label, capability };
  const indexed = byKind(input.artifacts);
  for (const kind of REQUIRED) {
    const artifact = indexed.get(kind)!; assertCompleteFoundryArtifact(artifact.manifest);
    if (artifact.manifest.timeRange.startMs !== input.startMs || artifact.manifest.timeRange.endMs !== input.endMs || JSON.stringify([...artifact.manifest.expectedCoverage.symbols].sort()) !== JSON.stringify([...input.symbols].sort())) throw new Error(`FOUNDRY_TIER1_ARTIFACT_RANGE_OR_SYMBOL_MISMATCH_${kind}`);
  }
  const listing = indexed.get("LISTING_DELISTING_TIMELINE")!; const futures = indexed.get("FUTURES_AVAILABILITY_TIMELINE")!; const eligibility = indexed.get("MINIMUM_HISTORY_ELIGIBILITY")!; const liquidityArtifact = indexed.get("PIT_LIQUIDITY_SPREAD")!;
  assertEligibilityTimelineConsistency({ listingRows: listing.rows, futuresRows: futures.rows, minimumHistoryRows: eligibility.rows });
  const listings = listingTimeline(listing.rows); const future = futuresTimeline(futures.rows); const history = minimumHistoryTimeline(eligibility.rows); const liquidity = new PointInTimeLiquiditySpread(liquidityArtifact.rows, input.liquidityPolicy); const clock = buildCanonicalClock(input);
  const universeSnapshots = clock.timestamps.map((openTimeMs) => {
    const asOfMs = openTimeMs + input.timeframeMs - 1;
    const symbolEvidence = input.symbols.slice().sort().map((symbol) => {
      const listingState = listings.at(symbol, asOfMs); const futuresState = future.at(symbol, asOfMs); const historyState = history.at(symbol, asOfMs); const liquidityState = liquidity.at(symbol, asOfMs);
      const reason = listingState.value !== "LISTED" ? "NOT_LISTED" : !futuresState.value ? "FUTURES_UNAVAILABLE" : !historyState.value ? "MINIMUM_HISTORY_INSUFFICIENT" : liquidityState.reason;
      return { symbol, eligible: reason === "ELIGIBLE", reason, listingState: listingState.value, listingSourceHash: listingState.sourceHash, futuresAvailable: futuresState.value, futuresSourceHash: futuresState.sourceHash, minimumHistoryEligible: historyState.value, minimumHistorySourceHash: historyState.sourceHash, liquidityReason: liquidityState.reason, liquiditySourceHash: liquidityState.sourceHash };
    });
    const eligibleSymbols = symbolEvidence.filter((state) => state.eligible).map((state) => state.symbol);
    if (!eligibleSymbols.length) throw new Error(`FOUNDRY_TIER1_UNIVERSE_EMPTY_${asOfMs}`);
    const universeProvenance = { decisionTimeMs: asOfMs, policyVersion: input.liquidityPolicy.version, thresholds: { minVolume: input.liquidityPolicy.minVolume, minLiquidityNotional: input.liquidityPolicy.minLiquidityNotional, maxSpreadBps: input.liquidityPolicy.maxSpreadBps, maxAgeMs: input.liquidityPolicy.maxAgeMs }, symbols: symbolEvidence };
    return { asOfMs, eligibleSymbols, sourceHash: tournamentHash(universeProvenance), universeProvenance, evidence: { listedThen: true as const, sufficientHistoryThen: true as const, liquidityVolumeEligibleThen: true as const, spreadEligibleThen: true as const, futuresAvailableThen: true as const, delistingCheckedThen: true as const } };
  });
  const funding = indexed.get("FUNDING_SETTLEMENTS")!; const fundingSettlementScheduleBySymbol = new Map(input.symbols.map((symbol) => [symbol, funding.rows.filter((row) => row.symbol === symbol).map((row) => row.canonicalSettlementTimeMs as number).sort((a, b) => a - b)]));
  const episodes = indexed.get("CANONICAL_EPISODES")!; const episodeByKey = new Map(episodes.rows.map((row) => [`${row.symbol}:${row.decisionTimeMs}`, row.episodeId as string]));
  const risk = indexed.get("PORTFOLIO_RISK_SNAPSHOTS")!;
  return { label, capability, universe: new PointInTimeUniverse(universeSnapshots), universeSnapshots, fundingSettlementScheduleBySymbol, canonicalEpisodeIdAt: (symbol, decisionTimeMs) => episodeByKey.get(`${symbol}:${decisionTimeMs}`) ?? null, portfolioRisk: new PointInTimePortfolioRisk(riskSnapshotsFromArtifactRows(risk.rows, input.symbols)), artifactSemanticHashes: capability.artifactSemanticHashes };
}

/** Ranking is forbidden for an incomplete Tier-1 assembly. */
export function assertTier1AssemblyCanRun(value: ReturnType<typeof assembleTier1Baseline>): asserts value is Tier1Assembly {
  if (!value.capability.canRun || !("universe" in value)) throw new Error("FOUNDRY_TIER1_INCOMPLETE_CANNOT_RUN_OR_RANK");
}

function fundingSettlementsFromRows(rows: readonly ValidatedFoundryRow[]): FundingSettlement[] {
  return rows.map((row) => ({ symbol: row.symbol!, canonicalSettlementTimeMs: row.canonicalSettlementTimeMs as number, observedSettlementTimeMs: row.observedSettlementTimeMs as number, alignmentOffsetMs: row.alignmentOffsetMs as number, scheduleSourceHash: row.scheduleSourceHash as string, rate: row.rate as number, sourceHash: row.sourceHash }));
}

/** Conservative-only baseline smoke; never includes Kronos or produces a rank/winner. */
export function runTier1BaselineSmoke(input: {
  assembly: ReturnType<typeof assembleTier1Baseline>;
  spec: TournamentExperimentSpec;
  candles: readonly TournamentCandle[];
  fundingRows: readonly ValidatedFoundryRow[];
  createdAtMs: number;
  randomReference: readonly RandomControlReference[];
  eligibleEntryTimesBySymbol: ReadonlyMap<string, readonly number[]>;
}): { label: Tier1Assembly["label"]; result: TournamentMatrixResult } {
  assertTier1AssemblyCanRun(input.assembly);
  if (input.spec.capabilityTier !== "TIER_1_BASELINE") throw new Error("FOUNDRY_TIER1_SMOKE_TIER_INVALID");
  const strategies = [cashStrategy(), buyAndHoldStrategy(), equalWeightHoldStrategy(), donchianStrategy(), macdStrategy(), emaCrossStrategy(), rsiMeanReversionStrategy(), randomTimingControl({ reference: input.randomReference, eligibleEntryTimesBySymbol: input.eligibleEntryTimesBySymbol, seed: input.spec.randomSeed })];
  const result = runTournamentMatrix({ spec: input.spec, strategies, createdAtMs: input.createdAtMs, modes: ["CONSERVATIVE"], execution: { candles: input.candles, universe: input.assembly.universe, portfolioRisk: input.assembly.portfolioRisk, canonicalEpisodeIdAt: input.assembly.canonicalEpisodeIdAt, fundingSettlements: fundingSettlementsFromRows(input.fundingRows), fundingSettlementScheduleBySymbol: input.assembly.fundingSettlementScheduleBySymbol } });
  if (result.runs.some((run) => run.manifest.strategyId === "KRONOS_CURRENT")) throw new Error("FOUNDRY_TIER1_SMOKE_KRONOS_FORBIDDEN");
  return { label: input.assembly.label, result };
}

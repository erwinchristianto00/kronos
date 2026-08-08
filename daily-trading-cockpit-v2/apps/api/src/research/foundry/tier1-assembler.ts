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
import { FOUNDRY_SCHEMA_V2 } from "./semantic-validators.js";
import { PointInTimeLiquiditySpread, type Tier1LiquiditySpreadPolicy } from "./liquidity-eligibility.js";
import { verifyArchiveBundle } from "./archive-bundle.js";
import { runTournamentMatrix, type TournamentMatrixResult } from "../tournament-runner.js";
import { canonicalPostTradeEpisodePolicy } from "../post-trade-episodes.js";
import { assertNoValidationLeakage, buildWalkForwardPlan, type WalkForwardFold } from "../validation/walk-forward.js";
import type { FundingSettlement, PointInTimeUniverseSnapshot, TournamentCandle, TournamentEpisodePolicy, TournamentExperimentSpec, TournamentResearchMode } from "../tournament-types.js";
import { buyAndHoldStrategy, cashStrategy, donchianStrategy, emaCrossStrategy, equalWeightHoldStrategy, macdStrategy, randomTimingControl, rsiMeanReversionStrategy, type RandomControlReference } from "../strategies/challengers.js";

const REQUIRED = ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "PORTFOLIO_RISK_SNAPSHOTS"] as const;
export const TIER1_ASSEMBLY_VERSION = "kronos-tier1-assembly-v2" as const;
type RequiredKind = typeof REQUIRED[number];
export interface Tier1LoadedArtifact { manifest: FoundryArtifactManifest; rows: ValidatedFoundryRow[]; }
const verifiedReloadArtifacts = new WeakSet<Tier1LoadedArtifact>();
const verifiedArtifactStoreRoots = new WeakMap<Tier1LoadedArtifact, string>();
const verifiedRealAssemblies = new WeakSet<Tier1Assembly>();
const verifiedRealAssemblyInputs = new WeakMap<Tier1Assembly, {
  readonly foundryArtifacts: readonly { rootDir: string; semanticManifestHash: string }[];
  readonly provenanceArtifacts: readonly Tier1LoadedArtifact[];
  readonly archiveRoots: Partial<Record<FoundryArtifactKind, string>>;
}>();
export interface Tier1Assembly {
  label: "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS";
  researchMode: TournamentResearchMode;
  assemblyVersion: typeof TIER1_ASSEMBLY_VERSION;
  tier1AssemblyHash: string;
  binding: NonNullable<TournamentExperimentSpec["dataset"]["tier1AssemblyBinding"]>;
  capability: Tier1CapabilityReport;
  universe: PointInTimeUniverse;
  universeSnapshots: readonly PointInTimeUniverseSnapshot[];
  canonicalCandles: readonly TournamentCandle[];
  canonicalFundingSettlements: readonly FundingSettlement[];
  fundingScheduleBySymbol: Readonly<Record<string, readonly number[]>>;
  postTradeEpisodePolicy: Readonly<TournamentEpisodePolicy>;
  portfolioRisk: PointInTimePortfolioRisk;
  liquidityPolicy: Readonly<Tier1LiquiditySpreadPolicy>;
  archiveBundleIdentities: Readonly<Record<string, unknown>>;
  artifactSemanticHashes: readonly string[];
  range: Readonly<{ startMs: number; endMs: number }>;
  timeframeMs: number;
}

function byKind(artifacts: readonly Tier1LoadedArtifact[]): Map<FoundryArtifactKind, Tier1LoadedArtifact> { return new Map(artifacts.map((artifact) => [artifact.manifest.artifactKind, artifact])); }
function immutable<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) immutable(child); } return value; }
function immutableSchedule(rows: readonly ValidatedFoundryRow[], symbols: readonly string[]): Readonly<Record<string, readonly number[]>> { return immutable(Object.fromEntries(symbols.slice().sort().map((symbol) => [symbol, rows.filter((row) => row.symbol === symbol).map((row) => row.canonicalSettlementTimeMs as number).sort((a, b) => a - b)]))); }
function scheduleMap(schedule: Readonly<Record<string, readonly number[]>>): ReadonlyMap<string, readonly number[]> { return new Map(Object.entries(schedule).map(([symbol, times]) => [symbol, [...times]])); }

/** Real runs require replayable archive roots; fixture and synthetic identities never cross this boundary. */
export function assertRealTier1ArtifactProvenance(artifacts: readonly Tier1LoadedArtifact[], archiveRoots: Partial<Record<FoundryArtifactKind, string>>): void {
  const hashes = new Set(artifacts.map((artifact) => artifact.manifest.semanticManifestHash));
  for (const artifact of artifacts) {
    const manifest = artifact.manifest; const provenance = manifest.sourceProvenance;
    if ((manifest.artifactKind === "LISTING_DELISTING_TIMELINE" || manifest.artifactKind === "FUTURES_AVAILABILITY_TIMELINE") && manifest.schemaVersion !== FOUNDRY_SCHEMA_V2) throw new Error(`FOUNDRY_REAL_TIER1_BOUNDED_TIMELINE_SCHEMA_REQUIRED_${manifest.artifactKind}`);
    if (provenance.provenanceType === "FIXTURE" || provenance.provenanceType === "SYNTHETIC" || provenance.provider === "test-fixture" || provenance.exchange === "TEST" || provenance.rawFileHash === "0".repeat(64)) throw new Error(`FOUNDRY_REAL_TIER1_FIXTURE_OR_PLACEHOLDER_${manifest.artifactKind}`);
    if (provenance.provenanceType === "DERIVED_FROM_FOUNDRY_ARTIFACTS") {
      if (manifest.archiveBundle || !manifest.derivation || manifest.derivation.parentSemanticManifestHashes.some((hash) => !hashes.has(hash))) throw new Error(`FOUNDRY_REAL_TIER1_DERIVATION_INVALID_${manifest.artifactKind}`);
      continue;
    }
    if (!manifest.archiveBundle) throw new Error(`FOUNDRY_REAL_TIER1_ARCHIVE_BUNDLE_MISSING_${manifest.artifactKind}`);
    const root = archiveRoots[manifest.artifactKind]; if (!root) throw new Error(`FOUNDRY_REAL_TIER1_ARCHIVE_ROOT_MISSING_${manifest.artifactKind}`);
    verifyArchiveBundle({ root, include: (relativePath) => relativePath.endsWith(".csv") || manifest.archiveBundle!.files.some((file) => file.relativePath === relativePath), expected: manifest.archiveBundle });
  }
}

/** Immutable-store entry point. It verifies reload before any Tier-1 input is constructed. */
export function loadTier1Artifacts(input: { rootDir: string; semanticManifestHashes: readonly string[] }): Tier1LoadedArtifact[] {
  return input.semanticManifestHashes.map((semanticManifestHash) => {
    const loaded = loadFoundryArtifact({ rootDir: input.rootDir, semanticManifestHash });
    const artifact = { manifest: loaded.manifest, rows: loaded.rows as ValidatedFoundryRow[] };
    verifiedReloadArtifacts.add(artifact);
    verifiedArtifactStoreRoots.set(artifact, input.rootDir);
    return artifact;
  });
}

/** Builds Tier-1 execution adapters only if every source-backed artifact is complete and coherent. */
export function assembleTier1Baseline(input: { artifacts: readonly Tier1LoadedArtifact[]; provenanceParents?: readonly Tier1LoadedArtifact[]; symbols: readonly string[]; startMs: number; endMs: number; timeframeMs: number; liquidityPolicy: Tier1LiquiditySpreadPolicy; researchMode?: TournamentResearchMode; archiveRoots?: Partial<Record<FoundryArtifactKind, string>> }): Tier1Assembly | { label: "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS"; capability: Tier1CapabilityReport } {
  const capability = buildTier1CapabilityReport(input.artifacts.map((artifact) => artifact.manifest)); const label = "TIER_1_BASELINE — NOT COMPARABLE TO EXACT KRONOS" as const;
  if (!capability.canRun) return { label, capability };
  const provenanceParents = input.provenanceParents ?? [];
  const executionHashes = new Set(input.artifacts.map((artifact) => artifact.manifest.semanticManifestHash));
  if (provenanceParents.some((artifact) => executionHashes.has(artifact.manifest.semanticManifestHash))) throw new Error("FOUNDRY_TIER1_PROVENANCE_PARENT_DUPLICATE");
  const provenanceArtifacts = [...input.artifacts, ...provenanceParents];
  const provenanceHashes = new Set(provenanceArtifacts.map((artifact) => artifact.manifest.semanticManifestHash));
  if (provenanceHashes.size !== provenanceArtifacts.length) throw new Error("FOUNDRY_TIER1_PROVENANCE_ARTIFACT_DUPLICATE");
  const referencedParents = new Set(provenanceArtifacts.flatMap((artifact) => artifact.manifest.derivation?.parentSemanticManifestHashes ?? []));
  if (provenanceParents.some((artifact) => !referencedParents.has(artifact.manifest.semanticManifestHash))) throw new Error("FOUNDRY_TIER1_PROVENANCE_PARENT_UNUSED");
  if (input.researchMode === "REAL_TIER1") {
    if (provenanceArtifacts.some((artifact) => !verifiedReloadArtifacts.has(artifact))) throw new Error("FOUNDRY_REAL_TIER1_VERIFIED_RELOAD_REQUIRED");
    assertRealTier1ArtifactProvenance(provenanceArtifacts, input.archiveRoots ?? {});
  }
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
  const funding = indexed.get("FUNDING_SETTLEMENTS")!; const fundingScheduleBySymbol = immutableSchedule(funding.rows, input.symbols); const canonicalFundingSettlements = immutable(fundingSettlementsFromRows(funding.rows).map((row) => ({ ...row })));
  const risk = indexed.get("PORTFOLIO_RISK_SNAPSHOTS")!; const candles = indexed.get("COMPLETED_CANDLES")!;
  const canonicalCandles = immutable(candles.rows.map((row) => ({ symbol: row.symbol!, openTimeMs: row.openTimeMs as number, closeTimeMs: row.closeTimeMs as number, open: row.open as number, high: row.high as number, low: row.low as number, close: row.close as number, volume: row.volume as number })));
  const immutableSnapshots = immutable(universeSnapshots.map((snapshot) => structuredClone(snapshot))); const immutablePolicy = immutable({ ...input.liquidityPolicy }); const artifactSemanticHashes = immutable([...provenanceHashes].sort());
  const archiveBundleIdentities = immutable(Object.fromEntries(provenanceArtifacts.map((artifact) => [artifact.manifest.semanticManifestHash, artifact.manifest.archiveBundle ?? null])));
  const universeSnapshotHash = tournamentHash(immutableSnapshots); const fundingScheduleIdentity = tournamentHash(fundingScheduleBySymbol); const postTradeEpisodePolicy = immutable(canonicalPostTradeEpisodePolicy(input.timeframeMs)); const episodePolicyHash = tournamentHash(postTradeEpisodePolicy); const portfolioRiskIdentity = risk.manifest.semanticManifestHash; const liquidityPolicyHash = tournamentHash(immutablePolicy);
  const bindingCore = { assemblyVersion: TIER1_ASSEMBLY_VERSION, artifactSemanticHashes, universeSnapshotHash, liquidityPolicyHash, fundingScheduleIdentity, episodePolicyHash, portfolioRiskIdentity };
  const tier1AssemblyHash = tournamentHash({ ...bindingCore, range: { startMs: input.startMs, endMs: input.endMs }, timeframeMs: input.timeframeMs, archiveBundleIdentities }); const binding = immutable({ ...bindingCore, tier1AssemblyHash });
  const assembly = immutable({ label, researchMode: input.researchMode ?? "FIXTURE_SMOKE", assemblyVersion: TIER1_ASSEMBLY_VERSION, tier1AssemblyHash, binding, capability, universe: new PointInTimeUniverse(immutableSnapshots.map((snapshot) => structuredClone(snapshot))), universeSnapshots: immutableSnapshots, canonicalCandles, canonicalFundingSettlements, fundingScheduleBySymbol, postTradeEpisodePolicy, portfolioRisk: new PointInTimePortfolioRisk(riskSnapshotsFromArtifactRows(risk.rows, input.symbols)), liquidityPolicy: immutablePolicy, archiveBundleIdentities, artifactSemanticHashes, range: immutable({ startMs: input.startMs, endMs: input.endMs }), timeframeMs: input.timeframeMs });
  if (input.researchMode === "REAL_TIER1") {
    verifiedRealAssemblies.add(assembly);
    verifiedRealAssemblyInputs.set(assembly, {
      foundryArtifacts: immutable(provenanceArtifacts.map((artifact) => ({ rootDir: verifiedArtifactStoreRoots.get(artifact)!, semanticManifestHash: artifact.manifest.semanticManifestHash }))),
      provenanceArtifacts: immutable(provenanceArtifacts.map((artifact) => ({ manifest: structuredClone(artifact.manifest), rows: [] }))),
      archiveRoots: immutable({ ...(input.archiveRoots ?? {}) }),
    });
  }
  return assembly;
}

/** Ranking is forbidden for an incomplete Tier-1 assembly. */
export function assertTier1AssemblyCanRun(value: ReturnType<typeof assembleTier1Baseline>): asserts value is Tier1Assembly {
  if (!value.capability.canRun || !("universe" in value)) throw new Error("FOUNDRY_TIER1_INCOMPLETE_CANNOT_RUN_OR_RANK");
}

function fundingSettlementsFromRows(rows: readonly ValidatedFoundryRow[]): FundingSettlement[] {
  return rows.map((row) => ({ symbol: row.symbol!, canonicalSettlementTimeMs: row.canonicalSettlementTimeMs as number, observedSettlementTimeMs: row.observedSettlementTimeMs as number, alignmentOffsetMs: row.alignmentOffsetMs as number, scheduleSourceHash: row.scheduleSourceHash as string, rate: row.rate as number, sourceHash: row.sourceHash }));
}

function assertVerifiedRealAssembly(assembly: Tier1Assembly): void {
  const verifiedInputs = verifiedRealAssemblyInputs.get(assembly);
  if (assembly.researchMode !== "REAL_TIER1" || !verifiedRealAssemblies.has(assembly) || !verifiedInputs) throw new Error("FOUNDRY_REAL_TIER1_ASSEMBLY_NOT_PROVENANCE_VERIFIED");
  for (const artifact of verifiedInputs.foundryArtifacts) loadFoundryArtifact(artifact);
  assertRealTier1ArtifactProvenance(verifiedInputs.provenanceArtifacts, verifiedInputs.archiveRoots);
  assertTier1AssemblyCanRun(assembly);
}

function baselineStrategies(assembly: Tier1Assembly, spec: TournamentExperimentSpec, range?: { startMs: number; endMs: number }) {
  const random = deriveTier1RandomControl(assembly, spec.randomSeed, range);
  return {
    random,
    strategies: [cashStrategy(), buyAndHoldStrategy(), equalWeightHoldStrategy(), donchianStrategy(), macdStrategy(), emaCrossStrategy(), rsiMeanReversionStrategy(), randomTimingControl({ reference: random.reference, eligibleEntryTimesBySymbol: random.eligibleEntryTimesBySymbol, seed: spec.randomSeed })],
  };
}

function assertConservativeBaselineRuns(runs: TournamentMatrixResult["runs"]): void {
  const expected = ["BTC_BUY_AND_HOLD", "CASH", "DONCHIAN", "EMA_CROSS", "EQUAL_WEIGHT_HOLD", "MACD", "RANDOM_CONTROL", "RSI_MEAN_REVERSION"];
  const actual = runs.map((run) => run.manifest.strategyId).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || runs.some((run) => run.manifest.executionMode !== "CONSERVATIVE" || run.manifest.strategyId === "KRONOS_CURRENT")) throw new Error("FOUNDRY_REAL_TIER1_BASELINE_CONTRACT_BREACH");
  if (runs.some((run) => !run.valid || run.terminalOpenPositions.length || !run.episodeLedger || !run.metrics.canonicalEpisodeProvenanceComplete)) throw new Error("FOUNDRY_REAL_TIER1_EMPIRICAL_GATE_INVALID_RUN");
}

/** Ensures an empirical spec names this exact immutable assembly before any run manifest is built. */
export function bindRealTier1ExperimentSpec(assembly: Tier1Assembly, spec: TournamentExperimentSpec): TournamentExperimentSpec {
  if (spec.researchMode !== "REAL_TIER1" || spec.capabilityTier !== "TIER_1_BASELINE") throw new Error("FOUNDRY_REAL_TIER1_MODE_REQUIRED");
  const supplied = spec.dataset.tier1AssemblyBinding;
  if (!supplied || tournamentHash({ ...supplied, artifactSemanticHashes: [...supplied.artifactSemanticHashes].sort() }) !== tournamentHash(assembly.binding)) throw new Error("FOUNDRY_REAL_TIER1_ASSEMBLY_BINDING_MISMATCH");
  if (spec.dataset.dataRange.startMs !== assembly.range.startMs || spec.dataset.dataRange.endMs !== assembly.range.endMs || spec.dataset.timeframeMs !== assembly.timeframeMs || JSON.stringify([...spec.dataset.artifactSemanticManifestHashes].sort()) !== JSON.stringify([...assembly.artifactSemanticHashes])) throw new Error("FOUNDRY_REAL_TIER1_SPEC_ASSEMBLY_DATASET_MISMATCH");
  if (spec.dataset.historicalUniverseHash !== assembly.binding.universeSnapshotHash || tournamentHash(spec.dataset.universeSnapshots) !== assembly.binding.universeSnapshotHash || spec.dataset.canonicalEpisodeHash !== assembly.binding.episodePolicyHash || spec.dataset.portfolioRiskHash !== assembly.binding.portfolioRiskIdentity) throw new Error("FOUNDRY_REAL_TIER1_SPEC_ASSEMBLY_IDENTITY_MISMATCH");
  return structuredClone(spec);
}

export interface Tier1RandomControlPlan {
  readonly reference: readonly RandomControlReference[];
  readonly eligibleEntryTimesBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly identity: string;
  readonly entryRange: Readonly<{ startMs: number; endMs: number }>;
}

/**
 * Derives the control exclusively from immutable assembly candles and PIT
 * universe state. A bounded range is used only for walk-forward OOS folds;
 * prior candles seed Donchian history but cannot become reference or random
 * entry candidates. No caller can submit a favorable schedule.
 */
export function deriveTier1RandomControl(assembly: Tier1Assembly, seed: number, range: { startMs: number; endMs: number } = assembly.range): Tier1RandomControlPlan {
  if (!Number.isInteger(range.startMs) || !Number.isInteger(range.endMs) || range.startMs < assembly.range.startMs || range.endMs > assembly.range.endMs || range.startMs >= range.endMs || range.startMs % assembly.timeframeMs !== 0 || range.endMs % assembly.timeframeMs !== 0) throw new Error("FOUNDRY_TIER1_RANDOM_CONTROL_RANGE_INVALID");
  const bySymbol = new Map<string, TournamentCandle[]>(); for (const candle of assembly.canonicalCandles) bySymbol.set(candle.symbol, [...(bySymbol.get(candle.symbol) ?? []), candle]);
  const eligible = new Map<string, number[]>(); const reference: RandomControlReference[] = []; const donor = donchianStrategy();
  for (const [symbol, candles] of [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const history: TournamentCandle[] = []; const entries: number[] = [];
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index]!; const next = candles[index + 1] ?? null; const eligibleSymbols = assembly.universe.at(candle.closeTimeMs); const entryTimeMs = next?.openTimeMs ?? null;
      const inRange = entryTimeMs !== null && candle.openTimeMs >= range.startMs && entryTimeMs < range.endMs;
      if (inRange && eligibleSymbols.has(symbol)) entries.push(entryTimeMs);
      for (const intent of donor.onCompletedBar({ symbol, index, candle, history, eligibleSymbols, nextOpenTimeMs: entryTimeMs })) if (inRange) reference.push({ referenceId: `donchian:${symbol}:${intent.decisionTimeMs}`, symbol, referenceEntryTimeMs: intent.entryAtOpenTimeMs, side: intent.side, stopFraction: intent.stopFraction, targetFraction: intent.targetFraction, maxHoldBars: intent.maxHoldBars, exitTemplate: intent.exitTemplate, score: intent.score, metadata: { ...intent.metadata } });
      history.push(candle); if (candle.openTimeMs >= range.endMs) break;
    }
    eligible.set(symbol, entries);
  }
  const frozenReference = immutable(reference.map((entry) => ({ ...entry, metadata: { ...entry.metadata } }))); const frozenEligible = new Map([...eligible.entries()].map(([symbol, times]) => [symbol, immutable([...times])])); const entryRange = immutable({ ...range }); const identity = tournamentHash({ policyVersion: "tier1-random-control-from-donchian-v3", tier1AssemblyHash: assembly.tier1AssemblyHash, seed, entryRange, reference: frozenReference, eligibleEntryTimesBySymbol: [...frozenEligible.entries()] });
  return { reference: frozenReference, eligibleEntryTimesBySymbol: frozenEligible, identity, entryRange };
}

/** Stable audit identity for the assembly-derived random-control schedule. */
export function deriveTier1RandomControlIdentity(assembly: Tier1Assembly, seed: number): string {
  return deriveTier1RandomControl(assembly, seed).identity;
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
  if (input.spec.capabilityTier !== "TIER_1_BASELINE" || input.spec.researchMode !== "FIXTURE_SMOKE") throw new Error("FOUNDRY_TIER1_SMOKE_FIXTURE_MODE_REQUIRED");
  const strategies = [cashStrategy(), buyAndHoldStrategy(), equalWeightHoldStrategy(), donchianStrategy(), macdStrategy(), emaCrossStrategy(), rsiMeanReversionStrategy(), randomTimingControl({ reference: input.randomReference, eligibleEntryTimesBySymbol: input.eligibleEntryTimesBySymbol, seed: input.spec.randomSeed })];
  const result = runTournamentMatrix({ spec: input.spec, strategies, createdAtMs: input.createdAtMs, modes: ["CONSERVATIVE"], postTradeEpisodePolicy: input.assembly.postTradeEpisodePolicy, execution: { candles: input.candles, universe: input.assembly.universe, portfolioRisk: input.assembly.portfolioRisk, fundingSettlements: fundingSettlementsFromRows(input.fundingRows), fundingSettlementScheduleBySymbol: scheduleMap(input.assembly.fundingScheduleBySymbol) } });
  if (result.runs.some((run) => run.manifest.strategyId === "KRONOS_CURRENT")) throw new Error("FOUNDRY_TIER1_SMOKE_KRONOS_FORBIDDEN");
  return { label: input.assembly.label, result };
}

/** The only executable empirical entry point. It is Conservative-only and still produces no ranking. */
export function runRealTier1Conservative(input: { assembly: Tier1Assembly; spec: TournamentExperimentSpec; createdAtMs: number }): { label: Tier1Assembly["label"]; result: TournamentMatrixResult } {
  assertVerifiedRealAssembly(input.assembly);
  const random = deriveTier1RandomControl(input.assembly, input.spec.randomSeed); if (input.spec.parameters.tier1RandomControlIdentity !== undefined && input.spec.parameters.tier1RandomControlIdentity !== random.identity) throw new Error("FOUNDRY_REAL_TIER1_RANDOM_CONTROL_IDENTITY_MISMATCH");
  const bound = bindRealTier1ExperimentSpec(input.assembly, input.spec); const spec = { ...bound, parameters: { ...bound.parameters, tier1AssemblyHash: input.assembly.tier1AssemblyHash, tier1RandomControlIdentity: random.identity, tier1RandomControlPolicyVersion: "tier1-random-control-from-donchian-v3" } };
  const { strategies } = baselineStrategies(input.assembly, spec);
  const result = runTournamentMatrix({ spec, strategies, createdAtMs: input.createdAtMs, modes: ["CONSERVATIVE"], postTradeEpisodePolicy: input.assembly.postTradeEpisodePolicy, execution: { candles: input.assembly.canonicalCandles, universe: input.assembly.universe, portfolioRisk: input.assembly.portfolioRisk, fundingSettlements: input.assembly.canonicalFundingSettlements, fundingSettlementScheduleBySymbol: scheduleMap(input.assembly.fundingScheduleBySymbol) } });
  assertConservativeBaselineRuns(result.runs);
  return { label: input.assembly.label, result: { ...result, runs: result.runs.map((run) => ({ ...run, manifest: { ...run.manifest, empiricalGatePassed: true } })) } };
}

export interface RealTier1WalkForwardFoldResult {
  fold: WalkForwardFold;
  testRange: Readonly<{ startMs: number; endMs: number }>;
  randomControlIdentity: string;
  fairnessHash: string;
  result: TournamentMatrixResult;
}

/**
 * The only empirical walk-forward entry point.  It binds the full immutable
 * assembly first, then derives every OOS fold, warm-up slice, universe slice,
 * funding schedule, and random-control schedule from that assembly.  It has
 * no caller-provided market payload or tuning input.
 */
export function runRealTier1WalkForwardConservative(input: { assembly: Tier1Assembly; spec: TournamentExperimentSpec; createdAtMs: number }): { label: Tier1Assembly["label"]; folds: readonly RealTier1WalkForwardFoldResult[] } {
  assertVerifiedRealAssembly(input.assembly);
  if (input.spec.parameters.tier1RandomControlIdentity !== undefined) throw new Error("FOUNDRY_REAL_TIER1_WALK_FORWARD_CALLER_RANDOM_IDENTITY_FORBIDDEN");
  const bound = bindRealTier1ExperimentSpec(input.assembly, input.spec);
  const timestamps = [...new Set(input.assembly.canonicalCandles.map((candle) => candle.openTimeMs))].sort((left, right) => left - right);
  const plan = buildWalkForwardPlan(timestamps, bound.validation); assertNoValidationLeakage(plan);
  if (plan.folds.length < 3) throw new Error("FOUNDRY_REAL_TIER1_WALK_FORWARD_MINIMUM_OOS_FOLDS_UNMET");
  const folds = plan.folds.map((fold) => {
    const testStartMs = timestamps[fold.test.startIndex]!; const testEndMs = timestamps[fold.test.endExclusive - 1]! + input.assembly.timeframeMs;
    const testRange = Object.freeze({ startMs: testStartMs, endMs: testEndMs });
    const snapshots = input.assembly.universeSnapshots.filter((snapshot) => snapshot.asOfMs >= testStartMs && snapshot.asOfMs < testEndMs);
    const candles = input.assembly.canonicalCandles.filter((candle) => candle.openTimeMs >= testStartMs && candle.openTimeMs < testEndMs);
    const historyCandles = input.assembly.canonicalCandles.filter((candle) => candle.closeTimeMs < testStartMs);
    if (!snapshots.length || !candles.length) throw new Error(`FOUNDRY_REAL_TIER1_WALK_FORWARD_COVERAGE_MISSING_${fold.foldId}`);
    const { random, strategies } = baselineStrategies(input.assembly, bound, testRange);
    const foldSpec: TournamentExperimentSpec = {
      ...bound,
      dataset: { ...bound.dataset, dataRange: testRange, universeSnapshots: structuredClone(snapshots) },
      parameters: {
        ...bound.parameters,
        tier1AssemblyHash: input.assembly.tier1AssemblyHash,
        walkForwardFoldId: fold.foldId,
        walkForwardParentDataRange: structuredClone(bound.dataset.dataRange),
        tier1RandomControlIdentity: random.identity,
        tier1RandomControlPolicyVersion: "tier1-random-control-from-donchian-v3",
      },
    };
    const result = runTournamentMatrix({
      spec: foldSpec,
      strategies,
      createdAtMs: input.createdAtMs,
      modes: ["CONSERVATIVE"],
      postTradeEpisodePolicy: input.assembly.postTradeEpisodePolicy,
      execution: { candles, historyCandles, universe: input.assembly.universe, portfolioRisk: input.assembly.portfolioRisk, fundingSettlements: input.assembly.canonicalFundingSettlements, fundingSettlementScheduleBySymbol: scheduleMap(input.assembly.fundingScheduleBySymbol) },
    });
    assertConservativeBaselineRuns(result.runs);
    const fairnessHash = result.fairnessHashByMode.get("CONSERVATIVE"); if (!fairnessHash) throw new Error(`FOUNDRY_REAL_TIER1_WALK_FORWARD_FAIRNESS_MISSING_${fold.foldId}`);
    return Object.freeze({ fold: structuredClone(fold), testRange, randomControlIdentity: random.identity, fairnessHash, result: { ...result, runs: result.runs.map((run) => ({ ...run, manifest: { ...run.manifest, empiricalGatePassed: true } })) } });
  });
  return { label: input.assembly.label, folds: Object.freeze(folds) };
}

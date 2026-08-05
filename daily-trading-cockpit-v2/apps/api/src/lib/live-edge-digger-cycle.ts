/**
 * LIVE EDGE DIGGER — the cycle runner and its report-only store.
 *
 * This is the ONLY file in the engine that touches the network or the disk. Everything it feeds is
 * pure (features, grammar, evaluation, resolution), so the science is testable from fixtures and
 * this layer stays thin enough to audit by reading.
 *
 * IT CANNOT TRADE. No executor, no allocator, no order client, no write path to any execution store.
 * It is registered exactly like every other shadow cycle: fire-and-forget, single-flighted, wrapped
 * so a failure records `lastCycleError` and returns null rather than propagating into the caller.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import type { Candle } from "@dtc/shared";

import {
  buildLiveEdgeDiggerReport,
  emitShadowSignals,
  resolveShadowObservation,
  type AttemptRegistryEntry,
  type LiveEdgeDiggerReport,
  type ShadowObservation,
} from "./live-edge-digger.js";
import { buildMarketFeatures, type SymbolCycleInput } from "./live-edge-digger-features.js";
import type { RegimeFamily } from "./live-edge-digger-types.js";
import { EDGE_RULE_FRONTIER, ruleContentHash, type EdgeRule } from "./live-edge-digger-grammar.js";
import { generateHypotheses, type GeneratedRuleRecord } from "./live-edge-digger-hypotheses.js";

/** Bounds the per-cycle API cost. The universe resolver returns up to 60 symbols; ranking quality
 *  barely improves past ~30 and every extra symbol is another premium-index call every 7 minutes. */
export const LIVE_EDGE_DIGGER_MAX_SYMBOLS = Number(process.env.LIVE_EDGE_DIGGER_MAX_SYMBOLS) || 30;
export const LIVE_EDGE_DIGGER_INTERVAL = "1h" as const;
export const LIVE_EDGE_DIGGER_SHOCK_INTERVAL = "15m" as const;
/** Enough 1h bars for a 72-bar beta window plus the 24-bar return and ATR burn-in. */
const HOURLY_CANDLES_NEEDED = 200;
const BENCHMARK_SYMBOL = "BTCUSDT";

// ---------------------------------------------------------------------------
// Store — report-only, atomic write, corrupt file starts empty.
// ---------------------------------------------------------------------------

/**
 * Per-cycle coverage accounting.
 *
 * WHY IT IS SEPARATE FROM `lastUniverseSize`. That field is the count of symbols the cycle actually
 * BUILT FEATURES FOR, and it was being reported to the dashboard as "universeSize" — so a run that
 * scanned 21 of several hundred tradable symbols presented as if it had covered the market. A
 * discovery engine that silently searches 7% of the universe and reports full coverage is making a
 * claim it did not test. Every number below is recorded so the gap is visible rather than implied.
 */
interface CoverageMeta {
  /** Symbols the universe resolver returned BEFORE this engine's own cap was applied. */
  canonicalUniverseSize: number | null;
  /** Symbols features were successfully built for — the real search width. */
  scannedSymbols: number | null;
  /** canonicalUniverseSize - scannedSymbols, itemised below. */
  excludedSymbols: number | null;
  /** Exclusion counts by cause, so "we only scanned 21" is always attributable. */
  exclusionReasons: { reason: string; count: number }[];
  /** Symbols dropped for missing/stale inputs, by feature. */
  featureGaps: { feature: string; missing: number }[];
  /** Wall-clock cost of the cycle. A scanner that silently got slower is a scanner covering less. */
  cycleMs: number | null;
  /** Newest CLOSED candle any symbol contributed — the decision-time watermark. */
  completedCandleWatermark: string | null;
}

interface StoreState {
  version: 1;
  observations: ShadowObservation[];
  attempts: Record<string, AttemptRegistryEntry>;
  /** Generated hypotheses, persisted so they survive restart and keep their freeze anchors. */
  generated: GeneratedRuleRecord[];
  /** Proposals refused by caps/dedup this cycle — reported, never silently dropped. */
  lastSuppressed: { reason: string; detail: string }[];
  cycleMeta: {
    lastCycleAt: string | null;
    cycles: number;
    recordedTotal: number;
    resolvedTotal: number;
    lastCycleError: string | null;
    lastUniverseSize: number | null;
    lastRegime: string | null;
    lastRegimeFamily: string | null;
    lastBreadth: number | null;
    lastCohesion: number | null;
    lastDispersion: number | null;
    coverage: CoverageMeta;
  };
}

const emptyCoverage = (): CoverageMeta => ({
  canonicalUniverseSize: null, scannedSymbols: null, excludedSymbols: null,
  exclusionReasons: [], featureGaps: [], cycleMs: null, completedCandleWatermark: null,
});

const emptyState = (): StoreState => ({
  version: 1,
  observations: [],
  attempts: {},
  generated: [],
  lastSuppressed: [],
  cycleMeta: {
    lastCycleAt: null, cycles: 0, recordedTotal: 0, resolvedTotal: 0, lastCycleError: null,
    lastUniverseSize: null, lastRegime: null, lastRegimeFamily: null,
    lastBreadth: null, lastCohesion: null, lastDispersion: null,
    coverage: emptyCoverage(),
  },
});

/**
 * Reads the persisted attempt map, tolerating the shape written before the registry was keyed by
 * candidateId and before `firstEvaluatedAt` existed.
 *
 * Two rules here, both learned the hard way in this repo. A field that PREDATES its own existence is
 * absent, not null, so the check must treat `undefined` and `null` alike. And a missing freeze
 * anchor is left as null rather than back-filled with load time — inventing a timestamp would
 * manufacture exactly the proof this field exists to supply, and it would look identical to a real
 * one. Those entries surface as UNKNOWN_PRE_MIGRATION and fail the freeze-integrity check closed.
 */
function migrateAttempts(raw: unknown): Record<string, AttemptRegistryEntry> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AttemptRegistryEntry> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Partial<AttemptRegistryEntry>;
    if (typeof e.candidateId !== "string" || typeof e.ruleId !== "string") continue;
    out[e.candidateId] = {
      ruleId: e.ruleId,
      candidateId: e.candidateId,
      cyclesEvaluated: typeof e.cyclesEvaluated === "number" ? e.cyclesEvaluated : 0,
      cyclesFired: typeof e.cyclesFired === "number" ? e.cyclesFired : 0,
      observationsEmitted: typeof e.observationsEmitted === "number" ? e.observationsEmitted : 0,
      firstEvaluatedAt: typeof e.firstEvaluatedAt === "string" ? e.firstEvaluatedAt : null,
    };
  }
  return out;
}

export class LiveEdgeDiggerStore {
  private state: StoreState = emptyState();

  constructor(private readonly file: string, private readonly maxObservations = 5000) {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreState>;
        this.state = {
          version: 1,
          observations: Array.isArray(parsed.observations) ? parsed.observations : [],
          attempts: migrateAttempts(parsed.attempts),
          // Generated rules survive restart with their identities intact; a store written before
          // generation existed simply has none, which is the correct empty state, not a migration.
          generated: Array.isArray(parsed.generated) ? parsed.generated : [],
          lastSuppressed: Array.isArray(parsed.lastSuppressed) ? parsed.lastSuppressed : [],
          cycleMeta: {
            ...emptyState().cycleMeta,
            ...(parsed.cycleMeta ?? {}),
            coverage: { ...emptyCoverage(), ...(parsed.cycleMeta?.coverage ?? {}) },
          },
        };
      }
    } catch {
      // Corrupt research telemetry starts empty. It must never affect an execution path, and it
      // must never throw on a path that a live cycle calls.
      this.state = emptyState();
    }
  }

  get all(): readonly ShadowObservation[] { return this.state.observations; }
  get attempts(): readonly AttemptRegistryEntry[] { return Object.values(this.state.attempts); }
  get cycleMeta(): StoreState["cycleMeta"] { return this.state.cycleMeta; }
  get generated(): readonly GeneratedRuleRecord[] { return this.state.generated; }
  get lastSuppressed(): readonly { reason: string; detail: string }[] { return this.state.lastSuppressed; }

  /** Appends newly generated hypotheses. Append-only by content hash: a rule already present is
   *  never re-added, so its freeze anchor and attempt history cannot be restarted. */
  addGenerated(records: readonly GeneratedRuleRecord[]): number {
    const known = new Set(this.state.generated.map((g) => g.candidateId));
    let added = 0;
    for (const r of records) {
      if (known.has(r.candidateId)) continue;
      known.add(r.candidateId);
      this.state.generated.push(r);
      added += 1;
    }
    return added;
  }

  recordSuppressed(entries: readonly { reason: string; detail: string }[]): void {
    this.state.lastSuppressed = [...entries];
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }

  add(observation: ShadowObservation): boolean {
    if (this.has(observation.observationId)) return false;
    this.state.observations.push(observation);
    this.state.cycleMeta.recordedTotal += 1;
    return true;
  }

  replace(observationId: string, next: ShadowObservation): void {
    const idx = this.state.observations.findIndex((o) => o.observationId === observationId);
    if (idx >= 0) this.state.observations[idx] = next;
  }

  /**
   * Accumulates the attempt registry across cycles — the multiple-testing record AND the freeze
   * anchor.
   *
   * Keyed by candidateId, NOT ruleId. The candidateId carries the rule's content hash, so editing
   * any threshold, direction or geometry starts a genuinely new entry. Keying by ruleId would let a
   * re-tuned rule silently inherit the old rule's evaluation count and freeze time — the count
   * would understate how many tests had really been run, and the freeze anchor would vouch for
   * content that never existed at that instant.
   *
   * `firstEvaluatedAt` is written once and never rewritten: it is only a valid lower bound on the
   * freeze time if it cannot move.
   */
  recordAttempts(
    entries: readonly { ruleId: string; candidateId: string; matched: number; emitted: number }[],
    atIso: string,
  ): void {
    for (const e of entries) {
      const prior = this.state.attempts[e.candidateId];
      this.state.attempts[e.candidateId] = {
        ruleId: e.ruleId,
        candidateId: e.candidateId,
        cyclesEvaluated: (prior?.cyclesEvaluated ?? 0) + 1,
        cyclesFired: (prior?.cyclesFired ?? 0) + (e.emitted > 0 ? 1 : 0),
        observationsEmitted: (prior?.observationsEmitted ?? 0) + e.emitted,
        firstEvaluatedAt: prior?.firstEvaluatedAt ?? atIso,
      };
    }
  }

  recordCycle(atIso: string, meta: Partial<StoreState["cycleMeta"]>, error: string | null): void {
    this.state.cycleMeta = {
      ...this.state.cycleMeta, ...meta,
      lastCycleAt: atIso,
      cycles: this.state.cycleMeta.cycles + 1,
      lastCycleError: error,
    };
  }

  save(): void {
    // Prune oldest SETTLED rows only — an open position is never dropped, or its outcome would
    // silently vanish from the record rather than being counted.
    if (this.state.observations.length > this.maxObservations) {
      const open = this.state.observations.filter((o) => o.status === "OPEN");
      const settled = this.state.observations
        .filter((o) => o.status !== "OPEN")
        .sort((a, b) => a.openedAtMs - b.openedAtMs);
      const keep = Math.max(0, this.maxObservations - open.length);
      this.state.observations = [...settled.slice(-keep), ...open];
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}

let singleton: LiveEdgeDiggerStore | null = null;
export function getLiveEdgeDiggerStore(dataDir = "data"): LiveEdgeDiggerStore {
  if (!singleton) singleton = new LiveEdgeDiggerStore(resolvePath(dataDir, "live-edge-digger.json"));
  return singleton;
}
export function _resetLiveEdgeDiggerStoreForTests(): void { singleton = null; }

// ---------------------------------------------------------------------------
// Cycle.
// ---------------------------------------------------------------------------

/** Everything the cycle needs from the outside world, injected so tests never touch a network. */
export interface LiveEdgeDiggerDeps {
  readonly store: LiveEdgeDiggerStore;
  readonly now: number;
  /** Resolved, liquidity-filtered universe plus the free per-symbol metadata that comes with it. */
  readonly resolveUniverse: () => Promise<{
    symbols: readonly string[];
    perSymbolMeta: Record<string, { quoteVolume24hUsd?: number | null; spreadBps?: number | null; openInterestUsd?: number | null }>;
  }>;
  readonly getRegime: () => Promise<{ regime: string | null; regimeFamily: RegimeFamily }>;
  readonly fetchCandles: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  /** Funding in bps and basis in bps; null when unavailable — rules needing them then fail closed. */
  readonly fetchFunding: (symbol: string) => Promise<{ fundingBps: number | null; basisBps: number | null }>;
}

export interface LiveEdgeDiggerCycleResult {
  readonly scanned: number;
  readonly emitted: number;
  readonly resolved: number;
  readonly stillOpen: number;
  /** New hypotheses generated this cycle (0 on most cycles — the caps make that the normal case). */
  readonly generated: number;
}

export async function runLiveEdgeDiggerCycle(deps: LiveEdgeDiggerDeps): Promise<LiveEdgeDiggerCycleResult> {
  const atIso = new Date(deps.now).toISOString();

  // ---- 1. RESOLVE OPEN POSITIONS FIRST, before any new signal is emitted. Same ordering every
  // existing shadow lane uses: an observation can never be opened and resolved in one tick, which
  // would let a single cycle both create and score its own evidence.
  let resolvedCount = 0;
  const openRows = deps.store.all.filter((o) => o.status === "OPEN");
  const openSymbols = [...new Set(openRows.map((o) => o.symbol))];
  const resolutionCandles = new Map<string, Candle[]>();
  for (const symbol of openSymbols) {
    try {
      resolutionCandles.set(symbol, await deps.fetchCandles(symbol, LIVE_EDGE_DIGGER_INTERVAL, HOURLY_CANDLES_NEEDED));
    } catch {
      // A symbol that cannot be fetched this cycle simply stays open — never force-closed at a
      // guessed price.
    }
  }
  for (const row of openRows) {
    const candles = resolutionCandles.get(row.symbol);
    if (!candles || candles.length === 0) continue;
    const next = resolveShadowObservation(row, candles);
    if (next.status !== "OPEN") {
      deps.store.replace(row.observationId, next);
      resolvedCount += 1;
    }
  }

  // ---- 2. SCAN.
  const cycleStartedMs = Date.now();
  const universe = await deps.resolveUniverse();
  const canonicalUniverseSize = universe.symbols.length;
  const working = universe.symbols.slice(0, LIVE_EDGE_DIGGER_MAX_SYMBOLS);
  // Coverage accounting starts here, at the FIRST place symbols are dropped. Counted rather than
  // described, so the report can never imply a search width the cycle did not have.
  const exclusionCounts = new Map<string, number>();
  const bumpExclusion = (reason: string, n = 1): void => {
    if (n > 0) exclusionCounts.set(reason, (exclusionCounts.get(reason) ?? 0) + n);
  };
  bumpExclusion(
    `beyond LIVE_EDGE_DIGGER_MAX_SYMBOLS (${LIVE_EDGE_DIGGER_MAX_SYMBOLS}) — engine cap, not a market fact`,
    Math.max(0, canonicalUniverseSize - working.length),
  );
  const symbolSet = new Set<string>([...working, BENCHMARK_SYMBOL]);
  const { regime, regimeFamily } = await deps.getRegime();

  // Memoize the PROMISE, not the value, so concurrent reads share one in-flight fetch — the same
  // pattern the residual-momentum and compression lanes use.
  const hourlyCache = new Map<string, Promise<Candle[]>>();
  const fetchHourly = (symbol: string): Promise<Candle[]> => {
    let p = hourlyCache.get(symbol);
    if (!p) {
      p = deps.fetchCandles(symbol, LIVE_EDGE_DIGGER_INTERVAL, HOURLY_CANDLES_NEEDED).catch(() => []);
      hourlyCache.set(symbol, p);
    }
    return p;
  };

  const inputs: SymbolCycleInput[] = [];
  const featureGapCounts = new Map<string, number>();
  const bumpGap = (feature: string): void => {
    featureGapCounts.set(feature, (featureGapCounts.get(feature) ?? 0) + 1);
  };
  let watermarkMs: number | null = null;
  for (const symbol of symbolSet) {
    const hourly = await fetchHourly(symbol);
    if (hourly.length < 30) {
      // fail closed: too little history to compute anything honest — and now counted, because a
      // symbol silently skipped here is a symbol the search never actually covered.
      bumpExclusion("insufficient hourly history (<30 closed bars)");
      continue;
    }
    const newestClose = hourly[hourly.length - 1]?.openTime ?? null;
    if (newestClose !== null && (watermarkMs === null || newestClose > watermarkMs)) watermarkMs = newestClose;
    let fifteenMin: Candle[] = [];
    try {
      fifteenMin = await deps.fetchCandles(symbol, LIVE_EDGE_DIGGER_SHOCK_INTERVAL, 8);
    } catch { /* shock proxy simply unavailable for this symbol */ }
    if (fifteenMin.length === 0) bumpGap("shockAtrUnits (15m candles unavailable)");
    let funding: { fundingBps: number | null; basisBps: number | null } = { fundingBps: null, basisBps: null };
    try {
      funding = await deps.fetchFunding(symbol);
    } catch { /* rules requiring funding fail closed on null */ }
    if (funding.fundingBps === null) bumpGap("fundingBps");
    if (funding.basisBps === null) bumpGap("basisBps");
    const meta = universe.perSymbolMeta[symbol] ?? {};
    if ((meta.quoteVolume24hUsd ?? null) === null) bumpGap("quoteVolume24hUsd");
    if ((meta.spreadBps ?? null) === null) bumpGap("spreadBps");
    inputs.push({
      symbol,
      hourly,
      fifteenMin,
      snapshot: {
        quoteVolume24hUsd: meta.quoteVolume24hUsd ?? null,
        spreadBps: meta.spreadBps ?? null,
        topDepthUsd: null, // not fetched per-cycle; the universe filter already bounds spread
        fundingBps: funding.fundingBps,
        basisBps: funding.basisBps,
        openInterestUsd: meta.openInterestUsd ?? null,
      },
    });
  }

  const market = buildMarketFeatures({
    asOfMs: deps.now,
    regime,
    regimeFamily,
    benchmarkSymbol: BENCHMARK_SYMBOL,
    symbols: inputs,
  });

  // ---- 3. GENERATE. Strictly BEFORE emission, and from `market` alone — the decision-time
  // cross-section. A rule proposed now is frozen by the same recordAttempts call that anchors the
  // seeds, so it is frozen before it can possibly produce an observation of its own.
  const knownRules: EdgeRule[] = [...EDGE_RULE_FRONTIER, ...deps.store.generated.map((g) => g.rule)];
  const { generated, suppressed } = generateHypotheses({
    market,
    cycleId: `cycle-${deps.now}`,
    atIso,
    existingContentHashes: new Set(knownRules.map(ruleContentHash)),
    existingGenerated: deps.store.generated,
  });
  const newlyGenerated = deps.store.addGenerated(generated);
  deps.store.recordSuppressed(suppressed);

  // ---- 4. EMIT. cycleId is the shared-cause key: one market look, one episode, however many
  // symbols or rules it triggers. Generated rules are evaluated alongside the seeds from the very
  // cycle they are born in — their first evaluation IS their freeze anchor.
  const cycleId = `cycle-${deps.now}`;
  const activeRules: EdgeRule[] = [...EDGE_RULE_FRONTIER, ...deps.store.generated.map((g) => g.rule)];
  const { observations, attempts } = emitShadowSignals(market, cycleId, atIso, activeRules);
  let emitted = 0;
  for (const obs of observations) {
    if (deps.store.add(obs)) emitted += 1;
  }
  // `atIso` is the DECISION instant of this cycle, so a candidate first evaluated now is anchored
  // at or before every observation this same cycle emits.
  deps.store.recordAttempts(attempts, atIso);

  const scannedSymbols = market.universeSize;
  deps.store.recordCycle(atIso, {
    resolvedTotal: deps.store.cycleMeta.resolvedTotal + resolvedCount,
    lastUniverseSize: scannedSymbols,
    lastRegime: market.regime,
    lastRegimeFamily: market.regimeFamily,
    lastBreadth: market.breadth,
    lastCohesion: market.cohesion,
    lastDispersion: market.dispersion,
    coverage: {
      canonicalUniverseSize,
      scannedSymbols,
      excludedSymbols: Math.max(0, canonicalUniverseSize - scannedSymbols),
      exclusionReasons: [...exclusionCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      featureGaps: [...featureGapCounts.entries()]
        .map(([feature, missing]) => ({ feature, missing }))
        .sort((a, b) => b.missing - a.missing),
      cycleMs: Date.now() - cycleStartedMs,
      completedCandleWatermark: watermarkMs !== null ? new Date(watermarkMs).toISOString() : null,
    },
  }, null);
  deps.store.save();

  return {
    scanned: scannedSymbols,
    emitted,
    resolved: resolvedCount,
    stillOpen: deps.store.all.filter((o) => o.status === "OPEN").length,
    generated: newlyGenerated,
  };
}

/** Module-level single-flight latch, deliberately not per-app-instance — see the identical note on
 *  the canonical regime scheduler. A failure still records liveness, so a dead cycle is visible
 *  rather than silently absent. */
let cycleInFlight = false;

export async function runLiveEdgeDiggerCycleGuarded(
  deps: LiveEdgeDiggerDeps,
): Promise<LiveEdgeDiggerCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runLiveEdgeDiggerCycle(deps);
  } catch (error) {
    try {
      deps.store.recordCycle(new Date(deps.now).toISOString(), {}, (error as Error).message);
      deps.store.save();
    } catch { /* best effort — telemetry must never mask the original failure */ }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function _resetLiveEdgeDiggerCycleLatchForTests(): void { cycleInFlight = false; }

/** Report entry point for the API route. */
export function buildLiveEdgeDiggerReportFromStore(
  store: LiveEdgeDiggerStore,
  generatedAt = new Date().toISOString(),
): LiveEdgeDiggerReport {
  const meta = store.cycleMeta;
  return buildLiveEdgeDiggerReport({
    generatedAt,
    observations: store.all,
    attempts: store.attempts,
    scanner: {
      cyclesRun: meta.cycles,
      lastCycleAt: meta.lastCycleAt,
      lastError: meta.lastCycleError,
      universeSize: meta.lastUniverseSize,
      regime: meta.lastRegime,
      regimeFamily: meta.lastRegimeFamily,
      breadth: meta.lastBreadth,
      cohesion: meta.lastCohesion,
      dispersion: meta.lastDispersion,
    },
    coverage: meta.coverage,
    // Seeds first, then generated — so the report reads as "the frozen frontier, plus what the
    // engine proposed", and a generated rule can never be mistaken for one a human wrote.
    frontier: [...EDGE_RULE_FRONTIER, ...store.generated.map((g) => g.rule)],
    generatedRules: store.generated,
    suppressedProposals: store.lastSuppressed,
  });
}

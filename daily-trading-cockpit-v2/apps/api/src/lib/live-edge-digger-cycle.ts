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

interface StoreState {
  version: 1;
  observations: ShadowObservation[];
  attempts: Record<string, AttemptRegistryEntry>;
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
  };
}

const emptyState = (): StoreState => ({
  version: 1,
  observations: [],
  attempts: {},
  cycleMeta: {
    lastCycleAt: null, cycles: 0, recordedTotal: 0, resolvedTotal: 0, lastCycleError: null,
    lastUniverseSize: null, lastRegime: null, lastRegimeFamily: null,
    lastBreadth: null, lastCohesion: null, lastDispersion: null,
  },
});

export class LiveEdgeDiggerStore {
  private state: StoreState = emptyState();

  constructor(private readonly file: string, private readonly maxObservations = 5000) {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreState>;
        this.state = {
          version: 1,
          observations: Array.isArray(parsed.observations) ? parsed.observations : [],
          attempts: parsed.attempts && typeof parsed.attempts === "object" ? parsed.attempts : {},
          cycleMeta: { ...emptyState().cycleMeta, ...(parsed.cycleMeta ?? {}) },
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

  /** Accumulates the attempt registry across cycles — the multiple-testing record. */
  recordAttempts(entries: readonly { ruleId: string; candidateId: string; matched: number; emitted: number }[]): void {
    for (const e of entries) {
      const prior = this.state.attempts[e.ruleId] ?? {
        ruleId: e.ruleId, candidateId: e.candidateId, cyclesEvaluated: 0, cyclesFired: 0, observationsEmitted: 0,
      };
      this.state.attempts[e.ruleId] = {
        ruleId: e.ruleId,
        candidateId: e.candidateId,
        cyclesEvaluated: prior.cyclesEvaluated + 1,
        cyclesFired: prior.cyclesFired + (e.emitted > 0 ? 1 : 0),
        observationsEmitted: prior.observationsEmitted + e.emitted,
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
  const universe = await deps.resolveUniverse();
  const working = universe.symbols.slice(0, LIVE_EDGE_DIGGER_MAX_SYMBOLS);
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
  for (const symbol of symbolSet) {
    const hourly = await fetchHourly(symbol);
    if (hourly.length < 30) continue; // fail closed: too little history to compute anything honest
    let fifteenMin: Candle[] = [];
    try {
      fifteenMin = await deps.fetchCandles(symbol, LIVE_EDGE_DIGGER_SHOCK_INTERVAL, 8);
    } catch { /* shock proxy simply unavailable for this symbol */ }
    let funding: { fundingBps: number | null; basisBps: number | null } = { fundingBps: null, basisBps: null };
    try {
      funding = await deps.fetchFunding(symbol);
    } catch { /* rules requiring funding fail closed on null */ }
    const meta = universe.perSymbolMeta[symbol] ?? {};
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

  // ---- 3. EMIT. cycleId is the shared-cause key: one market look, one episode, however many
  // symbols or rules it triggers.
  const cycleId = `cycle-${deps.now}`;
  const { observations, attempts } = emitShadowSignals(market, cycleId, atIso);
  let emitted = 0;
  for (const obs of observations) {
    if (deps.store.add(obs)) emitted += 1;
  }
  deps.store.recordAttempts(attempts);

  deps.store.recordCycle(atIso, {
    resolvedTotal: deps.store.cycleMeta.resolvedTotal + resolvedCount,
    lastUniverseSize: market.universeSize,
    lastRegime: market.regime,
    lastRegimeFamily: market.regimeFamily,
    lastBreadth: market.breadth,
    lastCohesion: market.cohesion,
    lastDispersion: market.dispersion,
  }, null);
  deps.store.save();

  return {
    scanned: market.universeSize,
    emitted,
    resolved: resolvedCount,
    stillOpen: deps.store.all.filter((o) => o.status === "OPEN").length,
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
  });
}

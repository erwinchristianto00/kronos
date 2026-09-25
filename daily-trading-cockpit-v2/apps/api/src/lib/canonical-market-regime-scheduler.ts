/**
 * CANONICAL MARKET REGIME — scheduler (2026-08). This is the "later, genuinely separate wiring stage"
 * both canonical-market-regime-engine.ts's file header (STAGE 4 SCOPE: "Deliberately NOT in this
 * stage... resolving the dynamic universe, the impure fetch shell that actually calls BinanceClient for
 * the long BTC candle series + per-symbol getFuturesFlow, cadence scheduling, and any app.ts wiring")
 * and canonical-market-regime-universe.ts's own header ("OUT OF SCOPE HERE... the 48h staleness CEILING
 * ... belongs to the canonical engine... a later orchestration stage") explicitly deferred to.
 *
 * FINDING this file fixes (2026-08, HIGH deployment-scope gap): nothing in the codebase ever called
 * ingestCanonicalMarketRegimeRawObservations / computeCanonicalMarketRegimeSnapshot /
 * recordCanonicalMarketRegimeSnapshot on any cadence, so getCanonicalMarketRegimeSnapshot() could only
 * ever resolve to its cold-start degraded snapshot. This file supplies the missing orchestration cycle;
 * app.ts registers it on a setInterval (see that file's own call site, near liveEngine.start()).
 *
 * CADENCE: 5 minutes (CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS). Not invented here — the engine
 * file's own header and its CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY doc comment both already state
 * "this engine's own faster 5-minute tick cadence" as the intended production cadence (distinct from
 * the ~hourly rate history actually grows at, since a duplicate 1h-candle cycle is a no-op).
 *
 * OVERLAP GUARD: a MODULE-LEVEL `cycleInFlight` boolean (declared at file scope, never inside a
 * function/closure) — mirrors direction-entry-reconciler.ts's runDirectionEntryReconciliationCycleGuarded
 * exactly, which itself documents mirroring exit-brain-shadow.ts/four-brain-live-wiring.ts's same idiom.
 * Being module-level (not re-created per buildApp() call) is deliberate, not incidental: it is what
 * keeps two ticks of this cycle from ever running concurrently even if buildApp() were somehow invoked
 * twice in one process — two independently-registered setIntervals would still call this same exported
 * function and therefore still share this one flag, unlike a `let running = false` declared inside a
 * buildApp()-local closure (which a second buildApp() call would silently re-initialize, defeating the
 * guard). See runCanonicalMarketRegimeEngineCycleGuarded's own doc comment.
 *
 * KILL SWITCH: reuses canonical-market-regime-engine.ts's own already-established
 * CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY rather than inventing a second flag. That module's
 * getCanonicalMarketRegimeSnapshot() already fails closed to a degraded snapshot when this is set
 * (checked BEFORE touching its store, so a disabled engine performs no disk I/O) — this scheduler now
 * extends that same "no I/O while disabled" discipline to the ingestion tick itself, so a disabled
 * engine performs no Binance network I/O either, not just no disk I/O.
 *
 * DEPENDENCY-INJECTED (mirrors DirectionEntryReconcilerDeps in direction-entry-reconciler.ts): every
 * network call is a caller-supplied function, so the ordering/guard/error-handling here are unit
 * testable with zero real network access. app.ts supplies real binanceClient-backed closures at the one
 * registration call site; CanonicalMarketRegimeUniverseFetchCtx-shaped values (getFuturesBookTicker /
 * getFuturesOpenInterest) are passed straight through inside resolveUniverse's own caller, matching that
 * module's own "structurally satisfied by a real BinanceClient instance, no adapter code" convention.
 */

import type { Candle } from "@dtc/shared";
import {
  CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY,
  buildCanonicalMarketRegimeEngineSymbolStats,
  computeCanonicalMarketRegimeSnapshot,
  type CanonicalMarketRegimeEngineRawIngestionCycle,
  type CanonicalMarketRegimeRawFeatures,
  type CanonicalMarketRegimeSnapshot,
  type CanonicalMarketRegimeSnapshotStatus,
} from "./canonical-market-regime-engine.js";
import type { CanonicalMarketRegimeUniverseSnapshot } from "./canonical-market-regime-universe.js";

/** See file header CADENCE note — matches the engine's own already-documented 5-minute tick cadence. */
export const CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS = 5 * 60_000;

/** The universe module's own bounded-staleness ceiling, explicitly deferred by both
 *  canonical-market-regime-universe.ts's header ("OUT OF SCOPE HERE... belongs to the canonical
 *  engine... a later orchestration stage") and canonical-market-regime-engine.ts's own
 *  `rawFeatures.universeStale` doc comment ("a later orchestration stage's concern to compute") — this
 *  file is that stage. 48h is both headers' own already-agreed number, not invented here. */
export const CANONICAL_MARKET_REGIME_UNIVERSE_STALE_CEILING_MS = 48 * 3_600_000;

export interface CanonicalMarketRegimeSchedulerFuturesFlow {
  fundingRate: number | null;
  openInterestChangePercent: number | null;
}

/** Every field a plain injectable async function — see file header's DEPENDENCY-INJECTED note. A real
 *  BinanceClient instance's own .getCandles/.getFuturesFlow satisfy fetchBtcCandles/fetchFuturesFlow
 *  with a trivial arrow-wrapper at the app.ts call site (matching argument order, no adapter class). */
export interface CanonicalMarketRegimeSchedulerDeps {
  resolveUniverse: (nowMs: number) => Promise<CanonicalMarketRegimeUniverseSnapshot>;
  ingestRawObservations: (symbols: string[], nowMs: number) => Promise<CanonicalMarketRegimeEngineRawIngestionCycle>;
  fetchBtcCandles: () => Promise<Candle[]>;
  fetchFuturesFlow: (symbol: string) => Promise<CanonicalMarketRegimeSchedulerFuturesFlow>;
  getPriorSnapshot: () => CanonicalMarketRegimeSnapshot | null;
  recordSnapshot: (snapshot: CanonicalMarketRegimeSnapshot) => boolean;
  /** Defaults to Date.now — injectable for deterministic tests. */
  now?: () => number;
  /** Defaults to process.env — injectable for deterministic tests. */
  env?: NodeJS.ProcessEnv;
}

export interface CanonicalMarketRegimeEngineCycleResult {
  ok: boolean;
  skipped?: "DISABLED";
  changed?: boolean;
  validSymbolCount?: number;
  requiredSymbolCount?: number;
  status?: CanonicalMarketRegimeSnapshotStatus;
  error?: string;
}

/**
 * One orchestration cycle, in order: resolveUniverse -> ingestRawObservations -> (in parallel) fetch
 * the risk-stress raw ingredients (BTC candles; per-symbol funding/OI, best-effort per symbol —
 * mirrors regime-engine-service.ts's own "breadth sweep over the liquid universe" Promise.all+try/catch
 * idiom so one bad symbol never fails the cycle) -> assemble CanonicalMarketRegimeRawFeatures ->
 * computeCanonicalMarketRegimeSnapshot -> recordSnapshot.
 *
 * Never throws: every failure — including resolveCanonicalMarketRegimeUniverse's own documented
 * cold-start throw ("Throws only when there is truly no prior resolution... AND the fresh attempt also
 * fails") — is caught and returned as `{ ok: false, error }`, mirroring
 * direction-entry-reconciler.ts's runDirectionEntryReconciliationCycle's own catch-and-report
 * discipline. The kill switch is checked FIRST, before any dependency is called, so a disabled engine
 * performs zero I/O this cycle (see file header KILL SWITCH note).
 */
export async function runCanonicalMarketRegimeEngineCycle(
  deps: CanonicalMarketRegimeSchedulerDeps,
): Promise<CanonicalMarketRegimeEngineCycleResult> {
  const env = deps.env ?? process.env;
  if (env[CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY] === "1") {
    return { ok: true, skipped: "DISABLED" };
  }
  const nowMs = deps.now ? deps.now() : Date.now();
  try {
    const universe = await deps.resolveUniverse(nowMs);
    const universeStale = nowMs - universe.resolvedAtMs > CANONICAL_MARKET_REGIME_UNIVERSE_STALE_CEILING_MS;

    const cycle = await deps.ingestRawObservations(universe.symbols, nowMs);

    const quoteVolume24hUsdBySymbol: Record<string, number | null | undefined> = {};
    for (const symbol of universe.symbols) {
      quoteVolume24hUsdBySymbol[symbol] = universe.perSymbolMeta[symbol]?.quoteVolume24hUsd ?? null;
    }
    const symbolStats = buildCanonicalMarketRegimeEngineSymbolStats(cycle, quoteVolume24hUsdBySymbol);

    const [btcCandles, flowEntries] = await Promise.all([
      deps.fetchBtcCandles().catch(() => [] as Candle[]),
      Promise.all(
        universe.symbols.map(async (symbol) => {
          try {
            return [symbol, await deps.fetchFuturesFlow(symbol)] as const;
          } catch {
            return [symbol, null] as const;
          }
        }),
      ),
    ]);

    const fundingRateBySymbol: Record<string, number | null | undefined> = {};
    const openInterestChangePercentBySymbol: Record<string, number | null | undefined> = {};
    for (const [symbol, flow] of flowEntries) {
      fundingRateBySymbol[symbol] = flow?.fundingRate ?? null;
      openInterestChangePercentBySymbol[symbol] = flow?.openInterestChangePercent ?? null;
    }

    const rawFeatures: CanonicalMarketRegimeRawFeatures = {
      atMs: nowMs,
      perSymbol: symbolStats.map((stat) => ({
        ...stat,
        spreadBps: universe.perSymbolMeta[stat.symbol]?.spreadBps ?? null,
        openInterestUsd: universe.perSymbolMeta[stat.symbol]?.openInterestUsd ?? null,
        sourceObservationId: cycle.sourceObservationIds[stat.symbol],
      })),
      requiredSymbolCount: cycle.requiredSymbolCount,
      universeSize: universe.symbols.length,
      universeStale,
      btcCandles,
      fundingRateBySymbol,
      openInterestChangePercentBySymbol,
    };

    // computeCanonicalMarketRegimeSnapshot's own calibrationParams param intentionally stays {} (its
    // built-in per-key `?? DEFAULT_X` fallbacks then apply) — canonical-market-regime-calibration.ts's
    // own header states the live engine "always runs with its current default or last-frozen
    // parameters regardless of whether a calibration run here is pending" (OFFLINE/REPORT TOOLING
    // ONLY, "never on the hot path"); wiring a live calibration-store read here would contradict that
    // file's own documented design, not complete it.
    const priorSnapshot = deps.getPriorSnapshot();
    const snapshot = computeCanonicalMarketRegimeSnapshot(rawFeatures, priorSnapshot, {}, nowMs);
    const changed = deps.recordSnapshot(snapshot);

    return {
      ok: true,
      changed,
      validSymbolCount: cycle.validSymbolCount,
      requiredSymbolCount: cycle.requiredSymbolCount,
      status: snapshot.status,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Cycle-level single-flight guard — see file header OVERLAP GUARD note for why this flag must stay
 *  module-level. Returns null when a prior cycle is still in flight (never overlaps, never throws). */
let cycleInFlight = false;
export async function runCanonicalMarketRegimeEngineCycleGuarded(
  deps: CanonicalMarketRegimeSchedulerDeps,
): Promise<CanonicalMarketRegimeEngineCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runCanonicalMarketRegimeEngineCycle(deps);
  } finally {
    cycleInFlight = false;
  }
}

/** Test hook: reset the single-flight latch. */
export function _resetCanonicalMarketRegimeEngineSchedulerLatchForTests(): void {
  cycleInFlight = false;
}

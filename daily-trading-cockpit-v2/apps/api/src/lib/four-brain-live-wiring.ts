/**
 * Four-Brain SHADOW cycle wiring glue (Phase 2 testnet wiring). Runs ONE report-only shadow cycle:
 *   1. build the gather deps (injected — every live read is a dep, no singleton/binance import here),
 *   2. pre-warm candles for the open-signal symbols (async, injected fetch) → a SYNC candlesFor map, so the
 *      Entry microstructure adapter can run inside the synchronous gather (adapter B),
 *   3. run runFourBrainShadowTick (gated + single-flight + fail-open + journal-only) — DRIVES NOTHING,
 *   4. fold the tick metrics into the aggregator + classify incumbent lanes for the operator report.
 *
 * This module imports NO executor / order-placement / allocation module and calls no mutation — it only
 * READS injected accessors and APPENDS report records. The async candle fetch is INJECTED (never a direct
 * binance import) so the execution-boundary test still holds. Failure anywhere fails OPEN (the incumbent
 * cycle is untouched); the whole cycle is a no-op unless mode==="shadow" AND the instance is allowlisted.
 */
import type { Candle } from "@dtc/shared";
import {
  buildFourBrainGatherInput,
  makeEntryMicrostructureAccessor,
  fourBrainInstanceAllowed,
  type FourBrainBindingDeps,
  type EntryOrderflowSnapshot,
} from "./four-brain-live-gather-bindings.js";
import { assembleFourBrainTick } from "./four-brain-live-gather.js";
import { runFourBrainShadowTick, type FourBrainTickResult } from "./four-brain-shadow-tick.js";
import { fourBrainMode } from "./four-brain-types.js";
import { classifyIncumbentLanes, type IncumbentCoverageReport } from "./four-brain-lane-support.js";
import type { FourBrainMetricsAggregator } from "./four-brain-metrics.js";

export interface FourBrainShadowCycleDeps {
  /** Resolve the current gather deps EXCEPT the candle adapter (which this module wires from fetchCandles). */
  buildDeps: (nowMs: number) => Omit<FourBrainBindingDeps, "entryMicrostructure">;
  /** Async candle fetch for one symbol (injected — usually a binance testnet client). null ⇒ micro MISSING. */
  fetchCandles: (symbol: string) => Promise<Candle[] | null>;
  /** Async USD-M futures order-book fetch, prewarmed beside candles. Optional and report-only. */
  fetchOrderflow?: (symbol: string) => Promise<EntryOrderflowSnapshot | null>;
  candleTimeframe?: "5m" | "15m" | "1h";
  /** The current incumbent active lane allocation, for the capital-coverage report. */
  activeAllocation: () => { laneId: string; weightPct: number }[];
  journalAppend: (record: Record<string, unknown>) => void;
  metrics: FourBrainMetricsAggregator;
  /** Impure clock — the wiring layer is allowed a real clock; it is passed as the single asOfMs per tick. */
  now: () => number;
  perfNow?: () => number;
  /** Optional extra journal context. */
  journalContext?: (nowMs: number) => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

export interface FourBrainShadowCycleResult {
  ran: boolean;
  gateReason: "mode-off" | "instance-blocked" | "cycle-in-flight" | "ran";
  tick: FourBrainTickResult | null;
  coverage: IncumbentCoverageReport | null;
}

// Cycle-level single-flight: the async candle prewarm can outlast the 5-min interval on a slow Binance
// response; without this, cycles would pile up and issue redundant concurrent fetches. The inner tick has
// its OWN synchronous latch too — this guards the async wrapper around it.
let cycleInFlight = false;
/** Test hook: reset the cycle-level latch. */
export function _resetFourBrainCycleLatchForTests(): void {
  cycleInFlight = false;
}

/**
 * Run one gated four-brain shadow cycle. Returns immediately (no-op) unless mode is "shadow" AND the instance
 * is allowlisted (3101/3102, never 3103). Never throws — any error fails open to a no-op result.
 */
export async function runFourBrainShadowCycle(deps: FourBrainShadowCycleDeps): Promise<FourBrainShadowCycleResult> {
  const env = deps.env ?? process.env;
  // ── Gate 1: mode. ──
  if (fourBrainMode(env) !== "shadow") return { ran: false, gateReason: "mode-off", tick: null, coverage: null };
  // ── Gate 2: instance allowlist (hard-blocks live 3103). ──
  if (!fourBrainInstanceAllowed(env)) return { ran: false, gateReason: "instance-blocked", tick: null, coverage: null };
  // ── Gate 3: cycle single-flight — a prior cycle's async candle prewarm may still be running. ──
  if (cycleInFlight) return { ran: false, gateReason: "cycle-in-flight", tick: null, coverage: null };
  cycleInFlight = true;

  try {
    const nowMs = deps.now();
    const base = deps.buildDeps(nowMs);

    // Pre-warm candles for the DISTINCT open-signal symbols (async), then expose a SYNC read for the gather.
    const symbols = Array.from(new Set(base.openSignals.map((s) => s.symbol)));
    const candleCache = new Map<string, Candle[] | null>();
    const orderflowCache = new Map<string, EntryOrderflowSnapshot | null>();
    await Promise.all(
      symbols.flatMap((sym) => [
        (async () => {
          try {
            candleCache.set(sym, await deps.fetchCandles(sym));
          } catch {
            candleCache.set(sym, null);
          }
        })(),
        (async () => {
          if (!deps.fetchOrderflow) {
            orderflowCache.set(sym, null);
            return;
          }
          try {
            orderflowCache.set(sym, await deps.fetchOrderflow(sym));
          } catch {
            orderflowCache.set(sym, null);
          }
        })(),
      ]),
    );
    const entryMicrostructure = makeEntryMicrostructureAccessor({
      candlesFor: (sym) => candleCache.get(sym) ?? null,
      orderflowFor: (sym) => orderflowCache.get(sym) ?? null,
      timeframe: deps.candleTimeframe ?? "15m",
      nowMs,
    });

    const gatherDeps: FourBrainBindingDeps = { ...base, entryMicrostructure };

    const tick = runFourBrainShadowTick({
      mode: "shadow",
      nowMs,
      gather: (n) => assembleFourBrainTick(buildFourBrainGatherInput({ ...gatherDeps, nowMs: n })),
      journalAppend: deps.journalAppend,
      journalContext: () => (deps.journalContext ? deps.journalContext(nowMs) : {}),
      perfNow: deps.perfNow,
      tickId: `four-brain-tick:${nowMs}`,
    });

    deps.metrics.record(tick.metrics, tick.reason);

    // Incumbent coverage (report-only): every active lane SUPPORTED-once or UNSUPPORTED_WITH_REASON.
    let coverage: IncumbentCoverageReport | null = null;
    try {
      coverage = classifyIncumbentLanes(deps.activeAllocation());
    } catch {
      coverage = null;
    }

    // Journal a compact per-cycle metrics + coverage record (rotation-bounded) for the operator report.
    try {
      deps.journalAppend({
        kind: "FOUR_BRAIN_CYCLE_METRICS",
        asOfMs: nowMs,
        instanceId: base.instanceId,
        reason: tick.reason,
        metrics: tick.metrics,
        coverage: coverage
          ? { activeLaneCount: coverage.activeLaneCount, supportedCount: coverage.supportedCount, unsupportedCount: coverage.unsupportedCount, capitalCoveragePct: coverage.capitalCoveragePct }
          : null,
        reportOnly: true,
      });
    } catch {
      /* journal is best-effort; a failure must never escape into the incumbent cycle */
    }

    return { ran: true, gateReason: "ran", tick, coverage };
  } catch {
    // Fail OPEN: the whole four-brain path is report-only; any error is swallowed so the incumbent is untouched.
    return { ran: false, gateReason: "ran", tick: null, coverage: null };
  } finally {
    cycleInFlight = false; // always release the cycle latch, even on a thrown/early path
  }
}

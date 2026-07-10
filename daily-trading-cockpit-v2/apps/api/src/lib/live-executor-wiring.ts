/**
 * Pure, testable helpers extracted from app.ts's executor-wiring closures (2026-07-08 audit
 * fix) — app.ts itself has no test file, so this logic was previously entirely unverified by any
 * automated test despite gating real-money exposure and reconcile-safety for 5 executor instances.
 */
import type { CrossSectionalExecutor } from "./cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor } from "./single-symbol-lane-executor.js";

/** Minimal slice of LiveExecutionEngine this module needs — kept narrow so tests can fake it. */
export interface LiveExecutorGateEngine {
  isArmed(): boolean;
  canOpenNewEntries(): boolean;
  laneSelectionExplicitlyIncludesLane(laneId: string): boolean;
  laneSelectionAllowsLane(laneId: string): boolean;
}

/**
 * Master permission gate for a newly-wired executor instance (cross-sectional TREND/MIXED, or a
 * SingleSymbolLaneExecutor). Requires, in order: armed (bypassed on testnet), EXPLICIT allocation
 * inclusion (never true just because "no allocation is currently restricting anything" — that's
 * the ALL_LANES default every established lane relies on, which would otherwise let a
 * never-before-executed lane fire at full size before the operator has ever actually picked it),
 * and the plain allow-lane check (redundant once explicit inclusion is true, kept as a defensive
 * second check in case the two functions' semantics ever diverge).
 */
export function isNewExecutorLaneAllowed(
  laneId: string,
  env: "testnet" | "mainnet",
  engine: LiveExecutorGateEngine | null,
  opts: { mainnetEntryEligible?: boolean } = {},
): boolean {
  if (!engine?.isArmed() || !engine.canOpenNewEntries()) return false;
  if (
    env === "mainnet" &&
    opts.mainnetEntryEligible === false &&
    process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE !== "1"
  ) return false;
  const explicit = engine?.laneSelectionExplicitlyIncludesLane(laneId) ?? false;
  if (!explicit) return false;
  return engine?.laneSelectionAllowsLane(laneId) ?? true;
}

export function rollingNetEntryHealth(
  recentNetReturns: readonly number[],
  opts: { shortWindow?: number; longWindow?: number } = {},
): { allowed: boolean; reason: string | null; shortAvg: number | null; longAvg: number | null } {
  const shortWindow = Math.max(1, opts.shortWindow ?? 8);
  const longWindow = Math.max(shortWindow, opts.longWindow ?? 30);
  const finite = recentNetReturns.filter((value) => Number.isFinite(value));
  const avg = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (finite.length < shortWindow) {
    return {
      allowed: false,
      reason: `rolling evidence incomplete: ${finite.length}/${shortWindow} recent closes`,
      shortAvg: null,
      longAvg: null,
    };
  }
  const shortRows = finite.slice(-shortWindow);
  const longRows = finite.slice(-Math.min(longWindow, finite.length));
  const shortAvg = avg(shortRows);
  const longAvg = avg(longRows);
  const allowed = shortAvg > 0 && longAvg > 0;
  return {
    allowed,
    reason: allowed
      ? null
      : `rolling edge negative: last${shortRows.length}=${(shortAvg * 100).toFixed(3)}%, last${longRows.length}=${(longAvg * 100).toFixed(3)}%`,
    shortAvg,
    longAvg,
  };
}

/**
 * Sums open legs/positions across every cross-sectional + single-symbol executor instance into
 * ONE net-qty-per-symbol map, for LiveExecutionEngine's externalManagedNetQty — reconcile must
 * know about every one of these or it flags a real exchange position as an orphan and force
 * -disarms the engine (this exact bug class has hit this codebase before). LONG legs/positions
 * contribute positive qty, SHORT contribute negative; a leg/position with exitOrderId already set
 * is excluded (the exit is already in flight, no longer a claim on the symbol).
 */
export function computeExternalManagedNetQty(
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const exec of crossSectionalExecutors) {
    if (!exec) continue;
    for (const basket of exec.getStatus().openBaskets) {
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null) continue;
        net.set(leg.symbol, (net.get(leg.symbol) ?? 0) + (leg.side === "LONG" ? leg.qty : -leg.qty));
      }
    }
  }
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const pos of exec.getStatus().openPositions) {
      if (pos.exitOrderId !== null) continue;
      net.set(pos.symbol, (net.get(pos.symbol) ?? 0) + (pos.direction === "LONG" ? pos.qty : -pos.qty));
    }
  }
  return net;
}

/**
 * Sums CURRENT notional (USD, qty*entryPrice, UNSIGNED — same-direction stacking is exactly what
 * this exists to catch, so long+long must ADD not cancel) per symbol across the given
 * single-symbol executors' OPEN positions (a leg with exitOrderId already set is excluded — its
 * exit is already in flight, no longer a live claim on the symbol).
 *
 * 2026-07-09 audit finding: independently-admitted SingleSymbolLaneExecutor instances (now 7 live:
 * SHORT_FADE_EXHAUSTION, INTRADAY_MOMENTUM_BREAKOUT, REGIME_COMPOSITE_CONFIRMATION_LONG, and
 * COMPOSITE_ESTIMATOR_BIDI's 4 buckets) each size a fresh entry purely from their OWN legUsd, with
 * zero awareness of what OTHER lanes already committed to the same symbol — confirmed live,
 * REGIME_COMPOSITE_CONFIRMATION_LONG and COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG/FAST_LONG all went
 * LONG on the same BTC/ETH/SOL universe simultaneously. live-execution-engine.ts's own
 * correlated-alt/cluster caps don't help here — those only see the "intents" mirror pipeline, never
 * imported by this executor class. Caller passes the RESULT of this (excluding the querying
 * instance's own positions — see SingleSymbolLaneExecutorOptions.existingNotionalForSymbol's doc
 * comment) into each executor's admission gate.
 */
export function computeNotionalPerSymbol(
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): Map<string, number> {
  const notional = new Map<string, number>();
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const pos of exec.getStatus().openPositions) {
      if (pos.exitOrderId !== null) continue;
      notional.set(pos.symbol, (notional.get(pos.symbol) ?? 0) + Math.abs(pos.qty * pos.entryPrice));
    }
  }
  return notional;
}

/** 2026-07-09 fix: shared default ceiling for computeNotionalPerSymbol-based admission gates.
 *  250 permits the two legitimate lanes already stacking on one symbol today (up to ~$150 WIDE +
 *  ~$91 REGIME_COMPOSITE per symbol, observed live) while stopping a 3rd/4th lane from piling on
 *  further once that's already committed. Env-overridable, matching every other risk constant in
 *  this codebase. */
export function maxNotionalPerSymbolAcrossLanes(): number {
  const n = Number.parseFloat(process.env.LIVE_MAX_NOTIONAL_PER_SYMBOL_ACROSS_LANES ?? "");
  return Number.isFinite(n) && n > 0 ? n : 250;
}

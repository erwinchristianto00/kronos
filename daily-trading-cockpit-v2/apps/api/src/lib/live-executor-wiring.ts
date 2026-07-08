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
): boolean {
  const armedOk = env === "testnet" || (engine !== null && engine.isArmed());
  if (!armedOk) return false;
  const explicit = engine?.laneSelectionExplicitlyIncludesLane(laneId) ?? false;
  if (!explicit) return false;
  return engine?.laneSelectionAllowsLane(laneId) ?? true;
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

/**
 * Simulation safety boundary (Market Digital Twin, Phase-1 foundation). The simulator is a controlled market
 * laboratory with ZERO reach into production trading authority. This module encodes the mode contract + a
 * fail-closed validator. A structural import-scan test (see test/simulation-safety.test.ts) proves the whole
 * `src/simulation/` package imports none of: authenticated exchange clients, the live execution engine, order/algo
 * placement, cancel/close, allocation/stop/position/edge-memory/beta/kill mutation, or ssh/rsync/pm2 deploy utils.
 */
import type { SimulationSafetyConfig } from "./simulation-types.js";

/** The ONLY valid simulation safety configuration. Any deviation ⇒ fail closed. */
export const SIMULATION_SAFETY_CONFIG: SimulationSafetyConfig = {
  simulationOnly: true,
  reportOnly: true,
  privateExchangeAccess: false,
  orderPlacementDisabled: true,
  productionStoreWritesDisabled: true,
};

/** The exact identifier denylist the structural test scans the simulation package for (must NEVER appear). */
export const FORBIDDEN_AUTHORITY_SYMBOLS: readonly string[] = [
  "placeOrder", "placeAlgoOrder", "cancelOrder", "cancelAllOrders", "cancelAlgoOrder", "closePosition",
  "setAllocation", "setLaneAllocations", "applyRegimeAutopilot", "setLeverage", "setIsolatedMargin",
  "updateFromClosedOrders", "resetKill", "engageKill", "rampBeta", "CORTEX_LIVE_BETA",
];

/** Module specifiers the simulation package must NOT import (live engine / authenticated exchange / deploy). */
export const FORBIDDEN_IMPORTS: readonly string[] = [
  "live-execution-engine", "binance-futures-private", "regime-edge-memory", "lane-context-journal-runtime",
  "cortex-refit-runner", "cortex-brain-store", "child_process",
];

/** Fail-closed validator: returns the config ONLY when it is exactly the frozen contract; otherwise throws. */
export function requireSimulationSafety(config: Partial<SimulationSafetyConfig> | null | undefined): SimulationSafetyConfig {
  if (
    !config ||
    config.simulationOnly !== true ||
    config.reportOnly !== true ||
    config.privateExchangeAccess !== false ||
    config.orderPlacementDisabled !== true ||
    config.productionStoreWritesDisabled !== true
  ) {
    throw new Error("simulation safety config invalid — FAIL CLOSED (simulationOnly/reportOnly/orderPlacementDisabled/productionStoreWritesDisabled must be set, privateExchangeAccess must be false)");
  }
  return SIMULATION_SAFETY_CONFIG;
}

/** True iff the config is exactly the safe contract (non-throwing check for report surfaces). */
export function isSimulationSafe(config: Partial<SimulationSafetyConfig> | null | undefined): boolean {
  try { requireSimulationSafety(config); return true; } catch { return false; }
}

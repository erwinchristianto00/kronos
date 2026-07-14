/**
 * Core simulation contracts (Market Digital Twin, Phase-1 foundation). Pure types + tiny pure helpers. The design
 * rule is absolute: an unavailable field is MISSING / GAP / STALE / UNSUPPORTED / INSUFFICIENT_CALIBRATION_DATA —
 * NEVER a fabricated value produced merely because a downstream model expects the field.
 */
import type { SimulationProvenance } from "./simulation-provenance.js";

export const SIMULATOR_VERSION = "sim-foundation-1";
export const SCENARIO_SCHEMA_VERSION = "sim-scenario-1";
export const FEATURE_SCHEMA_VERSION = "sim-feature-1";

export type MarketFieldStatus =
  | "PRESENT"
  | "MISSING"
  | "GAP"
  | "STALE"
  | "UNSUPPORTED"
  | "INSUFFICIENT_CALIBRATION_DATA";

/** A single observed/derived market field with FULL provenance + availability metadata. `value` is null unless
 *  status === "PRESENT". `availableAtMs` (when the system could SEE it) ≥ `observedAtMs` (when it happened) — the
 *  gap models feed latency; decision features may only use fields whose `availableAtMs` ≤ the decision `asOfMs`. */
export interface MarketObservation<T> {
  value: T | null;
  status: MarketFieldStatus;
  provenance: SimulationProvenance | "OBSERVED";
  observedAtMs: number | null;
  availableAtMs: number | null;
  source: string;
  confidence: number | null;
  sampleSize: number | null;
  withinHistoricalSupport: boolean | null;
}

export interface Candle {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolFrame {
  candle: MarketObservation<Candle>;
  markPrice: MarketObservation<number>;
  fundingRate: MarketObservation<number>;
  spreadBps: MarketObservation<number>;
  liquidity: MarketObservation<number>;
  openInterest: MarketObservation<number>;
  liquidationFlow: MarketObservation<number>;
  orderFlow: MarketObservation<number>;
}

/** The provenance-preserving frame every path (replay / bootstrap / calibrated / stress) MUST be able to produce. */
export interface CommonMarketFrame {
  frameId: string;
  runId: string;
  asOfMs: number;
  symbols: Record<string, SymbolFrame>;
  hiddenStateRef: string | null;
  observedViewRef: string;
  provenance: SimulationProvenance;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** Report-only, simulation-only, no exchange/order/store authority. Missing/invalid ⇒ callers MUST fail closed. */
export interface SimulationSafetyConfig {
  simulationOnly: true;
  reportOnly: true;
  privateExchangeAccess: false;
  orderPlacementDisabled: true;
  productionStoreWritesDisabled: true;
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────────────────────
/** An UNSUPPORTED observation — the honest default for a dimension the source never observed (e.g. L2 depth). */
export function unsupported<T>(source: string): MarketObservation<T> {
  return { value: null, status: "UNSUPPORTED", provenance: "OBSERVED", observedAtMs: null, availableAtMs: null, source, confidence: null, sampleSize: null, withinHistoricalSupport: null };
}

/** A MISSING observation (field is supported in principle but absent in this frame). */
export function missing<T>(source: string, status: Extract<MarketFieldStatus, "MISSING" | "GAP" | "STALE" | "INSUFFICIENT_CALIBRATION_DATA"> = "MISSING"): MarketObservation<T> {
  return { value: null, status, provenance: "OBSERVED", observedAtMs: null, availableAtMs: null, source, confidence: null, sampleSize: null, withinHistoricalSupport: null };
}

/** A PRESENT, genuinely-observed value with explicit observed + available timestamps (available ≥ observed). */
export function observed<T>(value: T, observedAtMs: number, availableAtMs: number, source: string, provenance: SimulationProvenance | "OBSERVED" = "OBSERVED"): MarketObservation<T> {
  return { value, status: "PRESENT", provenance, observedAtMs, availableAtMs: Math.max(availableAtMs, observedAtMs), source, confidence: 1, sampleSize: null, withinHistoricalSupport: true };
}

/** True iff the observation is PRESENT AND was available at-or-before the decision time (no look-ahead). */
export function visibleAt<T>(o: MarketObservation<T>, asOfMs: number): boolean {
  return o.status === "PRESENT" && o.availableAtMs != null && o.availableAtMs <= asOfMs;
}

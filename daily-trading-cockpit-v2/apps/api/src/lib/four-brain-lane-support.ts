/**
 * Four-Brain lane support registry (Phase 2 wiring). The EXPLICIT map of which incumbent lanes the four
 * brains support — so an incumbent active lane is NEVER silently excluded from the shadow. Every incumbent
 * active lane must resolve to exactly one of: SUPPORTED (its candidates are gathered) or UNSUPPORTED_WITH_
 * REASON (surfaced, with a reason). A lane in neither the roster nor this registry is UNSUPPORTED with the
 * default reason "not in four-brain support registry" — never dropped quietly.
 *
 * PROFIT_CORE_SHORT_TRAIL resolution (operator ask A): it is a REAL SHORT lane (realtime-short-mirror.ts,
 * BTC/INJ/DOGE, wide stop, RR 5-8x) that rides paper→live with no dedicated measurement report. It is added
 * here as a SUPPORTED SHORT lane so its open positions are gathered for the Exit Brain; its entry signals
 * ride the realtime-short-mirror (no single-symbol signal builder), so entrySignalsWired=false is recorded
 * as a documented gap — supported, not silently excluded.
 */
import { CORTEX_LANE_ROSTER, type CortexLaneDirection } from "./cortex-live-gather.js";
import {
  CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
  CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
} from "./cross-sectional-directional-regime.js";

export const PROFIT_CORE_SHORT_TRAIL_LANE_ID = "PROFIT_CORE_SHORT_TRAIL";

export interface FourBrainLaneSupport {
  laneId: string;
  direction: CortexLaneDirection;
  /** True ⇒ a single-symbol open-signal builder feeds the Entry Brain for this lane. */
  entrySignalsWired: boolean;
  /** True ⇒ open positions are enumerable for the Exit Brain (any real trading lane). */
  exitPositionsWired: boolean;
  note?: string;
}

/** Lanes whose ENTRY signals come from a wired single-symbol open-signal builder. */
const ENTRY_SIGNAL_BUILDER_LANES = new Set([
  "REGIME_COMPOSITE_CONFIRMATION_LONG",
  "REGIME_COMPOSITE_CONFIRMATION_SHORT",
  "SHORT_FADE_EXHAUSTION_CROWDED",
  "INTRADAY_MOMENTUM_BREAKOUT_LONG",
  "PANIC_WASHOUT_RECLAIM_LONG",
  "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG",
  "COMPOSITE_ESTIMATOR_BIDI_WIDE_SHORT",
  "COMPOSITE_ESTIMATOR_BIDI_FAST_LONG",
  "COMPOSITE_ESTIMATOR_BIDI_FAST_SHORT",
]);

export const FOUR_BRAIN_LANE_SUPPORT: readonly FourBrainLaneSupport[] = [
  ...CORTEX_LANE_ROSTER.map((e) => ({
    laneId: e.laneId,
    direction: e.direction,
    entrySignalsWired: ENTRY_SIGNAL_BUILDER_LANES.has(e.laneId),
    exitPositionsWired: true,
    note: ENTRY_SIGNAL_BUILDER_LANES.has(e.laneId) ? undefined : "entry via preset/basket pipeline (no single-symbol signal builder)",
  })),
  // Testnet directional cross-sectional is a real single-symbol executor pair,
  // not a neutral basket. Keep LONG/SHORT as independent Four-Brain cohorts.
  {
    laneId: CROSS_SECTIONAL_DIRECTIONAL_LONG_LANE_ID,
    direction: "LONG",
    entrySignalsWired: true,
    exitPositionsWired: true,
    note: "testnet directional sectional long cohort",
  },
  {
    laneId: CROSS_SECTIONAL_DIRECTIONAL_SHORT_LANE_ID,
    direction: "SHORT",
    entrySignalsWired: true,
    exitPositionsWired: true,
    note: "testnet directional sectional short cohort",
  },
  {
    laneId: PROFIT_CORE_SHORT_TRAIL_LANE_ID,
    direction: "SHORT",
    entrySignalsWired: false,
    exitPositionsWired: true,
    note: "real SHORT lane; positions gathered for Exit; entry rides realtime-short-mirror (no signal builder wired)",
  },
];

const SUPPORT_BY_LANE = new Map(FOUR_BRAIN_LANE_SUPPORT.map((s) => [s.laneId, s]));
/** Every lane the four-brain layer supports (roster + PROFIT_CORE_SHORT_TRAIL). */
export const FOUR_BRAIN_SUPPORTED_LANES: ReadonlySet<string> = new Set(FOUR_BRAIN_LANE_SUPPORT.map((s) => s.laneId));

export function fourBrainLaneSupport(laneId: string): FourBrainLaneSupport | null {
  return SUPPORT_BY_LANE.get(laneId) ?? null;
}

export interface IncumbentLaneClassification {
  laneId: string;
  weightPct: number;
  status: "SUPPORTED" | "UNSUPPORTED_WITH_REASON";
  direction: CortexLaneDirection | null;
  reason: string | null;
}

export interface IncumbentCoverageReport {
  activeLaneCount: number;
  supportedCount: number;
  unsupportedCount: number;
  /** Σ weightPct of SUPPORTED lanes ÷ Σ weightPct of all active lanes, ×100. */
  capitalCoveragePct: number;
  lanes: IncumbentLaneClassification[];
}

/**
 * Classify every incumbent ACTIVE lane (from the live allocation table) as SUPPORTED or
 * UNSUPPORTED_WITH_REASON — exactly once each, never silently excluded — and compute capital coverage.
 */
export function classifyIncumbentLanes(active: { laneId: string; weightPct: number }[]): IncumbentCoverageReport {
  const seen = new Set<string>();
  const lanes: IncumbentLaneClassification[] = [];
  let supportedWeight = 0;
  let totalWeight = 0;
  for (const a of active) {
    if (seen.has(a.laneId)) continue; // classify each lane exactly once
    seen.add(a.laneId);
    const w = Number.isFinite(a.weightPct) ? Math.max(0, a.weightPct) : 0;
    totalWeight += w;
    const support = SUPPORT_BY_LANE.get(a.laneId);
    if (support) {
      supportedWeight += w;
      lanes.push({ laneId: a.laneId, weightPct: w, status: "SUPPORTED", direction: support.direction, reason: support.note ?? null });
    } else {
      lanes.push({ laneId: a.laneId, weightPct: w, status: "UNSUPPORTED_WITH_REASON", direction: null, reason: "not in four-brain support registry (unknown lane)" });
    }
  }
  return {
    activeLaneCount: lanes.length,
    supportedCount: lanes.filter((l) => l.status === "SUPPORTED").length,
    unsupportedCount: lanes.filter((l) => l.status === "UNSUPPORTED_WITH_REASON").length,
    capitalCoveragePct: totalWeight > 0 ? (supportedWeight / totalWeight) * 100 : 100,
    lanes,
  };
}

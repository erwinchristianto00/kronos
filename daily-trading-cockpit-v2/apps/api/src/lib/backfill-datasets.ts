/**
 * Historical backfill — dataset shaping (Phase 6 / requirement #6). Four SEPARATE dataset families, each with
 * its own supervised target. Nothing unavailable is fabricated — a target/column with no historical support is
 * recorded in `unsupported` and its rows are not invented. Pure.
 *
 *   CORTEX_ALLOCATION — y = win label under the 0.03R hurdle (per-lane allocation edge).
 *   DIRECTION         — y ∈ {LONG, SHORT, FLAT}; reward = netR (null for FLAT decisions).
 *   ENTRY             — y ∈ {ENTER_NOW, WAIT, SKIP}; reward = netR (null for WAIT/SKIP decisions).
 *   EXIT              — y ∈ {HOLD, TRAIL, SCALE_OUT, EXIT} from resolver tp/BE state.
 *                       MFE/MAE-conditioned exit variants are UNSUPPORTED (no historical MFE/MAE — see audit).
 */
import type { HistoricalOutcome, Side, TrainingClass } from "./backfill-schema.js";
import { tallyClasses } from "./backfill-classify.js";

export type DatasetName = "CORTEX_ALLOCATION" | "DIRECTION" | "ENTRY" | "EXIT";
export type DirectionTarget = "LONG" | "SHORT" | "FLAT";
export type EntryTarget = "ENTER_NOW" | "WAIT" | "SKIP";
export type ExitTarget = "HOLD" | "TRAIL" | "SCALE_OUT" | "EXIT";

export interface DatasetRow {
  tMs: number; // resolvedAt (outcome rows) or decisionAt (decision-only rows) — chronological key for walk-forward
  laneId: string;
  symbolOrBasket: string | null;
  side: Side | null;
  x: number[];
  netR: number | null;
  /** Supervised target, encoded per family (see encoders below). */
  y: number | string | null;
  klass: TrainingClass;
}

export interface DatasetFamily {
  name: DatasetName;
  featureKeys: readonly string[];
  targetSpace: readonly string[];
  rows: DatasetRow[];
  /** Honest record of anything this family CANNOT support from the historical data (never fabricated). */
  unsupported: string[];
  classCounts: Record<TrainingClass, number>;
  trainableRows: number;
}

export function assembleFamily(
  name: DatasetName,
  featureKeys: readonly string[],
  targetSpace: readonly string[],
  rows: DatasetRow[],
  unsupported: string[],
): DatasetFamily {
  return {
    name,
    featureKeys,
    targetSpace,
    rows,
    unsupported,
    classCounts: tallyClasses(rows.map((r) => r.klass)),
    trainableRows: rows.filter((r) => r.klass === "VALID_FOR_TRAINING").length,
  };
}

// ── Target encoders ─────────────────────────────────────────────────────────────────────────────
export function directionTarget(side: Side | null, action: "LONG" | "SHORT" | "FLAT" | null | undefined): DirectionTarget {
  return action ?? (side === "LONG" || side === "SHORT" ? side : "FLAT");
}

export function entryTarget(action: "ENTER_NOW" | "WAIT" | "SKIP" | null | undefined, opened: boolean): EntryTarget {
  if (action) return action;
  return opened ? "ENTER_NOW" : "SKIP"; // an outcome exists ⇒ a position opened ⇒ ENTER_NOW was chosen
}

/**
 * Map an outcome's resolver state to an EXIT target. HOLD = ran to natural resolution with no partial/BE/trail;
 * SCALE_OUT = tp1 hit (partial taken); TRAIL = stop moved to breakeven / trailed after tp1; EXIT = closed by a
 * hard/adverse reason (stop, kill, whale-conflict, time). MFE/MAE-conditioned refinements are NOT derivable
 * historically (no MFE/MAE) → the caller marks those variants unsupported. Returns null when the source has no
 * resolver-state at all (⇒ not an Exit-trainable row).
 */
export function exitTarget(o: HistoricalOutcome): ExitTarget | null {
  const hasState = o.tp1Hit != null || o.tp2Hit != null || o.slToBreakeven != null || o.exitReason != null;
  if (!hasState) return null;
  const reason = (o.exitReason ?? "").toLowerCase();
  if (/stop|sl_hit|kill|whale|conflict|time|max.?hold|adverse/.test(reason)) return "EXIT";
  if (o.slToBreakeven === true) return "TRAIL";
  if (o.tp2Hit === true) return "TRAIL"; // rode past tp1 with protection ⇒ trailing
  if (o.tp1Hit === true) return "SCALE_OUT";
  return "HOLD";
}

/** The MFE/MAE-dependent exit refinements that history cannot support (recorded, never fabricated). */
export const EXIT_UNSUPPORTED_MFE_MAE = [
  "MFE-giveback exit threshold (needs per-observation maxFavorableR — absent in history)",
  "MAE-based early-cut labels (needs maxAdverseR — absent in history)",
];

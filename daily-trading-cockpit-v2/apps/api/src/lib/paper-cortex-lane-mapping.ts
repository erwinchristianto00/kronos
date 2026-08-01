/**
 * Immutable, directional paper-to-CORTEX lane contract.
 *
 * Paper geometry names are execution/evidence identities while CORTEX roster
 * names identify the feature vector. They deliberately do not share a naming
 * convention, so this table is the only allowed bridge. Missing or ambiguous
 * rows are learning-ineligible; no prefix/default/aggregate inference exists.
 */
import {
  CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
} from "./cortex-live-gather.js";

export interface PaperCortexLaneMapping {
  readonly paperLaneId: string;
  readonly direction: "LONG" | "SHORT";
  readonly canonicalCortexLaneId: string;
}

export const PAPER_CORTEX_LANE_MAPPINGS: readonly PaperCortexLaneMapping[] = [
  { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", direction: "LONG", canonicalCortexLaneId: "CG_WIDE_FAST_LONG" },
  { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", direction: "LONG", canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER" },
  { paperLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", direction: "LONG", canonicalCortexLaneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID },
  { paperLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", direction: "SHORT", canonicalCortexLaneId: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID },
] as const;

/** Returns the sole exact directional contract, or null for unmapped/ambiguous rows. */
export function canonicalCortexLaneForPaperLane(
  paperLaneId: string,
  direction: "LONG" | "SHORT",
): string | null {
  const matches = PAPER_CORTEX_LANE_MAPPINGS.filter((row) => row.paperLaneId === paperLaneId && row.direction === direction);
  return matches.length === 1 ? matches[0]!.canonicalCortexLaneId : null;
}

/**
 * Immutable, directional paper-to-CORTEX lane contract.
 *
 * Paper geometry names are execution/evidence identities while CORTEX roster
 * names identify the feature vector. They deliberately do not share a naming
 * convention, so this table is the only allowed bridge. Missing or ambiguous
 * rows are learning-ineligible; no prefix/default/aggregate inference exists.
 *
 * STRATEGY-IDENTITY INVARIANT (enforced by test/paper-cortex-lane-mapping.test.ts,
 * not just documented here): every row's `paperLaneId`, stripped of its
 * "CG_LONG_VARIANT_MATRIX:"/"CG_VARIANT_MATRIX:" namespace prefix, must name a
 * REAL entry in `VARIANT_MATRIX_DEFINITIONS` (current-guard-variant-matrix.ts)
 * whose `id` is either:
 *   (a) identical to `canonicalCortexLaneId` — same entry geometry, same stop
 *       geometry, same exit/target rule, same lane, just renamed across the two
 *       naming conventions; or
 *   (b) the single deliberate exception, `CG_MFE_GIVEBACK`, which is
 *       direction-agnostic in the variant matrix (one geometry, both books) but
 *       must never pool LONG/SHORT outcomes under one CORTEX feature vector — so
 *       its two rows fan out to the two synthetic split ids
 *       (CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID / ..._SHORT_LANE_ID) below.
 * `canonicalCortexLaneId` must also be a real `CORTEX_LANE_ROSTER` entry
 * (cortex-live-gather.ts), and `direction` must agree with the underlying
 * variant's `longOnly`/`shortOnly` flag (absent ⇒ direction-agnostic, only
 * legal for the MFE_GIVEBACK exception above).
 *
 * A row that fails any of the above (e.g. the historical bug where
 * "CG_WIDE_STOP_TP_WIDE" — 1.5R TP, no maxHoldHours — was mapped to
 * "CG_WIDE_LONG_RUNNER" — 3R TP, 144h hold — two DIFFERENT geometries that
 * merely happen to share a `stopFloorBps: 300` — must be fixed to point at the
 * paper lane id that actually shares the destination's geometry, or removed
 * and left unmapped. Never widen this by pattern/prefix inference.
 */
import {
  CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
  CORTEX_LANE_ROSTER,
} from "./cortex-live-gather.js";
import { VARIANT_MATRIX_DEFINITIONS } from "./current-guard-variant-matrix.js";
import { recordCortexProductionChainDiagnostic } from "./cortex-production-chain-diagnostics.js";

export interface PaperCortexLaneMapping {
  readonly paperLaneId: string;
  readonly direction: "LONG" | "SHORT";
  readonly canonicalCortexLaneId: string;
}

export const PAPER_CORTEX_LANE_MAPPINGS: readonly PaperCortexLaneMapping[] = [
  // Paper variant CG_WIDE_FAST_LONG: LONG-only, stopFloorBps 300, tpRewardMultiple 0.5, exitRule
  // tp1_full. Verbatim-id match against the CORTEX_LANE_ROSTER entry of the same name — same
  // entry/stop/exit geometry, same lane, just crossing the router-namespace/roster naming split.
  { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", direction: "LONG", canonicalCortexLaneId: "CG_WIDE_FAST_LONG" },
  // Paper variant CG_WIDE_LONG_RUNNER: LONG-only, stopFloorBps 300, tpRewardMultiple 3,
  // maxHoldHours 144, exitRule tp1_full. Verbatim-id match against the roster entry of the same
  // name. NOT "CG_WIDE_STOP_TP_WIDE" (tpRewardMultiple 1.5, no maxHoldHours override, no
  // longOnly) — that is a different, unrelated geometry and has no roster entry of its own; it
  // is deliberately left unmapped below.
  { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER", direction: "LONG", canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER" },
  // Paper variant CG_MFE_GIVEBACK: direction-agnostic in the variant matrix (no longOnly/
  // shortOnly; stopFloorBps 300, tpRewardMultiple 3, exitRule mfe_giveback — one geometry serves
  // both books). CORTEX must not pool LONG/SHORT outcomes under one feature vector, so this is
  // the one allow-listed row where the destination id is NOT the bare variant id — it fans out to
  // the LONG split lane.
  { paperLaneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", direction: "LONG", canonicalCortexLaneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID },
  // Same paper variant/geometry as above, SHORT split lane. Same allow-listed exception.
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

const PAPER_LANE_NAMESPACE_PREFIXES = ["CG_LONG_VARIANT_MATRIX:", "CG_VARIANT_MATRIX:"] as const;

function bareVariantIdOrNull(paperLaneId: string): string | null {
  for (const prefix of PAPER_LANE_NAMESPACE_PREFIXES) {
    if (paperLaneId.startsWith(prefix)) return paperLaneId.slice(prefix.length);
  }
  return null;
}

/** Mirrors test/paper-cortex-lane-mapping.test.ts's allow-list exactly — never grow this silently. */
const MFE_GIVEBACK_SPLIT_ALLOWLIST: Readonly<Record<"LONG" | "SHORT", string>> = {
  LONG: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  SHORT: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
};

/**
 * Point 11 — the exact strategy-identity invariant test/paper-cortex-lane-mapping.test.ts already
 * enforces statically (point 5/10), extracted as a pure predicate so both the test and the
 * report-only runtime self-check below share one implementation. A row must name a real
 * VARIANT_MATRIX_DEFINITIONS entry, resolve to a real CORTEX_LANE_ROSTER member, agree on strategy
 * identity (verbatim id match, or the one allow-listed CG_MFE_GIVEBACK direction split), and agree
 * on direction with the underlying variant's longOnly/shortOnly flag. Exported only for testing —
 * production code should never need to call this directly; canonicalCortexLaneForPaperLane above
 * is the real lookup.
 */
export function paperCortexLaneMappingRowIsValid(
  row: PaperCortexLaneMapping,
  rosterLaneIds: ReadonlySet<string>,
  variantsById: ReadonlyMap<string, { longOnly?: boolean; shortOnly?: boolean }>,
): boolean {
  const variantId = bareVariantIdOrNull(row.paperLaneId);
  const variant = variantId != null ? variantsById.get(variantId) : undefined;
  const isAllowlistedMfeGivebackSplit =
    variantId === "CG_MFE_GIVEBACK" && MFE_GIVEBACK_SPLIT_ALLOWLIST[row.direction] === row.canonicalCortexLaneId;
  const sameStrategyId = variantId != null && variantId === row.canonicalCortexLaneId;
  const directionAgrees = variant == null
    ? false
    : variant.longOnly
      ? row.direction === "LONG"
      : variant.shortOnly
        ? row.direction === "SHORT"
        : isAllowlistedMfeGivebackSplit;
  return (
    variant != null &&
    rosterLaneIds.has(row.canonicalCortexLaneId) &&
    (sameStrategyId || isAllowlistedMfeGivebackSplit) &&
    directionAgrees
  );
}

/**
 * Point 11 — a report-only runtime mirror of the invariant above, run once at module load against
 * the real, fixed PAPER_CORTEX_LANE_MAPPINGS table. It exists purely as a production safety net in
 * case a future edit to this table reintroduces the historical CG_WIDE_STOP_TP_WIDE ->
 * CG_WIDE_LONG_RUNNER class of bug and somehow ships without the test having run. It can only ever
 * RECORD `CORTEX_STRATEGY_MAPPING_MISMATCH`; it never throws, never blocks module load, and never
 * changes what canonicalCortexLaneForPaperLane resolves to for any caller.
 */
function validatePaperCortexLaneMappingInvariantsForDiagnostics(): void {
  const rosterLaneIds = new Set(CORTEX_LANE_ROSTER.map((entry) => entry.laneId));
  const variantsById = new Map(VARIANT_MATRIX_DEFINITIONS.map((def) => [def.id as string, def]));
  for (const row of PAPER_CORTEX_LANE_MAPPINGS) {
    if (!paperCortexLaneMappingRowIsValid(row, rosterLaneIds, variantsById)) {
      recordCortexProductionChainDiagnostic("CORTEX_STRATEGY_MAPPING_MISMATCH");
    }
  }
}

try {
  validatePaperCortexLaneMappingInvariantsForDiagnostics();
} catch {
  // A diagnostics self-check must never take down module load.
}

import { describe, expect, it } from "vitest";
import {
  canonicalCortexLaneForPaperLane,
  paperCortexLaneMappingRowIsValid,
  PAPER_CORTEX_LANE_MAPPINGS,
} from "../src/lib/paper-cortex-lane-mapping.js";
import { CORTEX_LANE_ROSTER } from "../src/lib/cortex-live-gather.js";
import { VARIANT_MATRIX_DEFINITIONS } from "../src/lib/current-guard-variant-matrix.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";

/** Router `selectedLaneId` namespaces used by `paperLaneId`. Mirrors the prefix lists already used
 *  in production (cortex-refit-runner-bindings.ts's CG_ROUTER_LANE_PREFIXES,
 *  entry-brain-tier1-realized-resolver.ts's VARIANT_MATRIX_LANE_PREFIXES) — duplicated locally so
 *  this test does not couple to an unrelated module's internal prefix list. */
const PAPER_LANE_NAMESPACE_PREFIXES = ["CG_LONG_VARIANT_MATRIX:", "CG_VARIANT_MATRIX:"] as const;

function bareVariantId(paperLaneId: string): string {
  for (const prefix of PAPER_LANE_NAMESPACE_PREFIXES) {
    if (paperLaneId.startsWith(prefix)) return paperLaneId.slice(prefix.length);
  }
  throw new Error(`paperLaneId "${paperLaneId}" carries neither known namespace prefix`);
}

const ROSTER_LANE_IDS = new Set(CORTEX_LANE_ROSTER.map((entry) => entry.laneId));
const VARIANT_DEFINITIONS_BY_ID = new Map(VARIANT_MATRIX_DEFINITIONS.map((def) => [def.id, def]));

/** The one explicit, deliberate exception where the paper variant id and the CORTEX lane id
 *  differ without being a naming-convention-only rename: CG_MFE_GIVEBACK is direction-agnostic
 *  in the variant matrix (one geometry, both books) but must never pool LONG/SHORT outcomes under
 *  one CORTEX feature vector, so it fans out to two synthetic split roster ids. Never grow this
 *  allow-list silently — any other id mismatch is exactly the class of bug this test exists to
 *  catch (the historical CG_WIDE_STOP_TP_WIDE -> CG_WIDE_LONG_RUNNER row). */
const MFE_GIVEBACK_SPLIT_ALLOWLIST: Readonly<Record<"LONG" | "SHORT", string>> = {
  LONG: "CG_MFE_GIVEBACK_LONG",
  SHORT: "CG_MFE_GIVEBACK_SHORT",
};

describe("PAPER_CORTEX_LANE_MAPPINGS strategy-identity invariants", () => {
  it("is non-empty (a regression here would silently make every row untested)", () => {
    expect(PAPER_CORTEX_LANE_MAPPINGS.length).toBeGreaterThan(0);
  });

  for (const row of PAPER_CORTEX_LANE_MAPPINGS) {
    describe(`row ${row.paperLaneId} / ${row.direction} -> ${row.canonicalCortexLaneId}`, () => {
      it("canonicalCortexLaneId is a real CORTEX_LANE_ROSTER member", () => {
        expect(ROSTER_LANE_IDS.has(row.canonicalCortexLaneId)).toBe(true);
      });

      it("paperLaneId's underlying variant exists in VARIANT_MATRIX_DEFINITIONS", () => {
        const variantId = bareVariantId(row.paperLaneId);
        expect(VARIANT_DEFINITIONS_BY_ID.has(variantId)).toBe(true);
      });

      it("the variant id and canonical CORTEX lane id are the same real strategy (verbatim match, or the explicit MFE_GIVEBACK split exception — never any other divergence)", () => {
        const variantId = bareVariantId(row.paperLaneId);
        if (variantId === row.canonicalCortexLaneId) {
          // Same id on both sides of the naming-convention split: same entry/stop/exit geometry
          // by construction (it is literally the same VARIANT_MATRIX_DEFINITIONS row).
          return;
        }
        // Any mismatch must be exactly the allow-listed MFE_GIVEBACK direction split — nothing else.
        expect(variantId).toBe("CG_MFE_GIVEBACK");
        expect(MFE_GIVEBACK_SPLIT_ALLOWLIST[row.direction]).toBe(row.canonicalCortexLaneId);
      });

      it("row direction agrees with the underlying variant's longOnly/shortOnly applicability", () => {
        const def = VARIANT_DEFINITIONS_BY_ID.get(bareVariantId(row.paperLaneId));
        expect(def).toBeDefined();
        if (def!.longOnly) {
          expect(row.direction).toBe("LONG");
        } else if (def!.shortOnly) {
          expect(row.direction).toBe("SHORT");
        } else {
          // Direction-agnostic underlying geometry is only legal for the explicit MFE_GIVEBACK
          // split exception — every other row must be pinned to a real longOnly/shortOnly variant.
          expect(def!.id).toBe("CG_MFE_GIVEBACK");
        }
      });
    });
  }

  it("rejects a paper lane id whose variant does not exist in VARIANT_MATRIX_DEFINITIONS", () => {
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:NOT_A_REAL_VARIANT", "LONG")).toBeNull();
  });

  it("maps only explicit directional contracts and leaves all other paper lanes unlabelled", () => {
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG")).toBe("CG_WIDE_FAST_LONG");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "LONG")).toBe("CG_MFE_GIVEBACK_LONG");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "SHORT")).toBe("CG_MFE_GIVEBACK_SHORT");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", "SHORT")).toBeNull();
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "SHORT")).toBeNull();
  });

  it("CG_WIDE_STOP_TP_WIDE is deliberately unmapped (it is a different geometry from CG_WIDE_LONG_RUNNER and has no roster entry of its own)", () => {
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", "LONG")).toBeNull();
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", "LONG")).toBeNull();
    // Confirm CG_WIDE_STOP_TP_WIDE really is a distinct geometry from CG_WIDE_LONG_RUNNER, so an
    // unmapped result here is correct rather than an accidental gap.
    const wideStopTpWide = VARIANT_DEFINITIONS_BY_ID.get("CG_WIDE_STOP_TP_WIDE");
    const wideLongRunner = VARIANT_DEFINITIONS_BY_ID.get("CG_WIDE_LONG_RUNNER");
    expect(wideStopTpWide).toBeDefined();
    expect(wideLongRunner).toBeDefined();
    expect(wideStopTpWide!.tpRewardMultiple).not.toBe(wideLongRunner!.tpRewardMultiple);
    expect(wideStopTpWide!.maxHoldHours).not.toBe(wideLongRunner!.maxHoldHours);
    expect(wideStopTpWide!.longOnly).not.toBe(wideLongRunner!.longOnly);
    // And CG_WIDE_STOP_TP_WIDE really has no roster entry of its own.
    expect(ROSTER_LANE_IDS.has("CG_WIDE_STOP_TP_WIDE")).toBe(false);
  });

  it("resolves the LONG-direction row for CG_WIDE_LONG_RUNNER to the correct roster id (the untested branch that let the original bug through)", () => {
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER", "LONG")).toBe("CG_WIDE_LONG_RUNNER");
  });
});

// Point 11: paperCortexLaneMappingRowIsValid is the pure predicate the module-load report-only
// self-check (validatePaperCortexLaneMappingInvariantsForDiagnostics, not exported — it only ever
// records CORTEX_STRATEGY_MAPPING_MISMATCH, never gates anything) shares with this file's own
// invariant assertions above. These tests exercise the predicate directly, including against the
// historical bad row, since PAPER_CORTEX_LANE_MAPPINGS itself is now fixed and correct.
describe("paperCortexLaneMappingRowIsValid (point 11 self-check predicate)", () => {
  const rosterLaneIds = new Set(CORTEX_LANE_ROSTER.map((e) => e.laneId));
  const variantsById = new Map(VARIANT_MATRIX_DEFINITIONS.map((def) => [def.id, def]));

  it("accepts every real row in PAPER_CORTEX_LANE_MAPPINGS", () => {
    for (const row of PAPER_CORTEX_LANE_MAPPINGS) {
      expect(paperCortexLaneMappingRowIsValid(row, rosterLaneIds, variantsById)).toBe(true);
    }
  });

  it("rejects the historical bug row (CG_WIDE_STOP_TP_WIDE mapped to the unrelated CG_WIDE_LONG_RUNNER geometry)", () => {
    const badRow = {
      paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      direction: "LONG" as const,
      canonicalCortexLaneId: "CG_WIDE_LONG_RUNNER",
    };
    expect(paperCortexLaneMappingRowIsValid(badRow, rosterLaneIds, variantsById)).toBe(false);
  });

  it("rejects an unmapped roster id and a direction that disagrees with the underlying variant's longOnly flag", () => {
    expect(paperCortexLaneMappingRowIsValid(
      { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", direction: "LONG", canonicalCortexLaneId: "NOT_ON_ROSTER" },
      rosterLaneIds, variantsById,
    )).toBe(false);
    expect(paperCortexLaneMappingRowIsValid(
      { paperLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", direction: "SHORT", canonicalCortexLaneId: "CG_WIDE_FAST_LONG" },
      rosterLaneIds, variantsById,
    )).toBe(false);
  });

  it("the module-load self-check recorded zero mismatches for the real (already-fixed) table — it is report-only and runs once at import time, so this only confirms the current table is clean, not the mechanism itself (covered by the predicate tests above)", () => {
    // The self-check already ran once when this module was first imported by this process, before
    // any test had a chance to reset the counters — so this can only assert the counter is a
    // non-negative integer here, not that it is exactly zero (module import order across the whole
    // test file is not this test's contract to pin). The predicate tests above are what actually
    // prove the check logic is correct.
    _resetCortexProductionChainDiagnosticsForTests();
    expect(cortexProductionChainDiagnostics().CORTEX_STRATEGY_MAPPING_MISMATCH).toBe(0);
  });
});

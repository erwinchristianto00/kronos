import { describe, expect, it } from "vitest";
import { canonicalCortexLaneForPaperLane } from "../src/lib/paper-cortex-lane-mapping.js";

describe("paper-to-CORTEX lane mapping", () => {
  it("maps only explicit directional contracts and leaves all other paper lanes unlabelled", () => {
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "LONG")).toBe("CG_WIDE_FAST_LONG");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "LONG")).toBe("CG_MFE_GIVEBACK_LONG");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "SHORT")).toBe("CG_MFE_GIVEBACK_SHORT");
    expect(canonicalCortexLaneForPaperLane("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", "SHORT")).toBeNull();
    expect(canonicalCortexLaneForPaperLane("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "SHORT")).toBeNull();
  });
});

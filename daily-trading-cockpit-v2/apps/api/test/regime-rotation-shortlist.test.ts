import { describe, expect, it } from "vitest";

import { buildRegimeRotationShortlistReport } from "../src/lib/regime-rotation-shortlist.js";
import type { CurrentGuardVariantMatrixReport, VariantBreakdownRow } from "../src/lib/current-guard-variant-matrix.js";

// Point 2 (regime-rotation-shortlist.ts): a row with pf: null and otherwise-qualifying n/net must
// BLOCK, never ALLOW/WATCH — a null PF is missing proof, not a free pass. `verdictFor()` used to
// treat `pf === null || pf === undefined` as "the PF bar doesn't apply" in BOTH the ALLOW and WATCH
// branches, so an axis-symbol row with a real, qualifying sample size and net R but no resolvable
// profit factor could still reach ALLOW.

function axisRow(overrides: Partial<VariantBreakdownRow> = {}): VariantBreakdownRow {
  return {
    key: "SHORT_BEARISH|INJUSDT",
    n: 18,
    netAvgR: 0.22,
    pf: 2.1,
    wr: 0.78,
    ...overrides,
  };
}

function reportWithAxisRow(byAxisSymbol: VariantBreakdownRow[]): CurrentGuardVariantMatrixReport {
  return {
    computedAt: "2026-08-02T00:00:00.000Z",
    rows: [
      {
        variantId: "CG_WIDE_STOP_TP_WIDE",
        label: "Wide",
        byAxisSymbol,
      } as never,
    ],
  } as unknown as CurrentGuardVariantMatrixReport;
}

function bearishVerdictFor(byAxisSymbol: VariantBreakdownRow[]) {
  const report = buildRegimeRotationShortlistReport(reportWithAxisRow(byAxisSymbol));
  const lane = report.lanes.find((candidate) => candidate.variantId === "CG_WIDE_STOP_TP_WIDE");
  return lane?.bearish.find((symbol) => symbol.symbol === "INJUSDT") ?? null;
}

describe("regime-rotation-shortlist verdictFor — null PF must block", () => {
  it("[ADVERSARIAL] a row with pf: null and otherwise-qualifying n/net does not reach ALLOW", () => {
    const symbol = bearishVerdictFor([axisRow({ pf: null })]);
    expect(symbol?.verdict).toBe("BLOCK");
    expect(symbol?.reason).toContain("PF unresolved");
  });

  it("[ADVERSARIAL] a row with pf: undefined and otherwise-qualifying n/net does not reach WATCH either", () => {
    // n below the ALLOW bar but above WATCH, net positive but small — would have hit the WATCH
    // branch's null-PF exception before the fix.
    const symbol = bearishVerdictFor([axisRow({ n: 6, netAvgR: 0.01, pf: undefined })]);
    expect(symbol?.verdict).toBe("BLOCK");
  });

  it("[PASS-WITH] an identical row with a real, qualifying PF still reaches ALLOW", () => {
    const symbol = bearishVerdictFor([axisRow({ pf: 2.1 })]);
    expect(symbol?.verdict).toBe("ALLOW");
  });

  it("[PASS-WITH] an identical row with a real PF below the allow bar still reaches WATCH via sample/net alone", () => {
    const symbol = bearishVerdictFor([axisRow({ n: 6, netAvgR: 0.01, pf: 1.05 })]);
    expect(symbol?.verdict).toBe("WATCH");
  });

  it("[MUTATION-DOCUMENTATION] a low-PF row (present but below the allow bar) still blocks ALLOW, proving the bar itself, not just presence, is enforced", () => {
    const symbol = bearishVerdictFor([axisRow({ pf: 1.0 })]);
    expect(symbol?.verdict).not.toBe("ALLOW");
  });
});

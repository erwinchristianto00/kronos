import { describe, expect, it } from "vitest";

import {
  buildDynamicMom36Formation as buildBaseline,
  applyDynamicMom36Preference,
  canonicalMom36Ranks,
  selectPreferredDynamicMom36Combination,
  type DynamicMom36RankedSymbol,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

// Selector-level fixture. Full admission and executor-path regressions live separately.
function buildDynamicMom36Formation(input: Parameters<typeof buildBaseline>[0]) {
  return applyDynamicMom36Preference(buildBaseline(input), { maxPerCluster: input.maxPerCluster, admit: () => true });
}

function row(
  symbol: string,
  mom36: number,
  opts: Partial<DynamicMom36RankedSymbol> = {},
): DynamicMom36RankedSymbol {
  return {
    symbol,
    mom36,
    price: 100,
    volatility: 0.01,
    fastReturn: 0,
    extensionVol: 0,
    longEligible: true,
    shortEligible: true,
    shortBlocked: false,
    ...opts,
  };
}

/** Longs ranked A..E strongest-first; shorts V..Z most-negative-first. */
function universe(overrides: Record<string, Partial<DynamicMom36RankedSymbol>> = {}) {
  const rows = [
    row("AAA", 0.10, { fastReturn: 0.01, oneHourReturn: 0.02 }),
    row("BBB", 0.09, { fastReturn: 0.02, oneHourReturn: 0.02 }),
    row("CCC", 0.08, { fastReturn: 0.02, oneHourReturn: 0.02 }),
    row("DDD", 0.07, { fastReturn: 0.02, oneHourReturn: 0.02 }),
    row("EEE", 0.06, { fastReturn: 0.02, oneHourReturn: 0.02 }),
    row("VVV", -0.10, { fastReturn: -0.02, oneHourReturn: -0.02 }),
    row("WWW", -0.09, { fastReturn: -0.02, oneHourReturn: -0.02 }),
    row("XXX", -0.08, { fastReturn: -0.02, oneHourReturn: -0.02 }),
    row("YYY", -0.07, { fastReturn: -0.02, oneHourReturn: -0.02 }),
    row("ZZZ", -0.06, { fastReturn: -0.02, oneHourReturn: -0.02 }),
  ];
  return rows.map((r) => (overrides[r.symbol] ? { ...r, ...overrides[r.symbol] } : r));
}

const shock = () => ({ state: "NO_EDGE", confidence: null, reason: "test" }) as never;

describe("preference formation — canonical rank is independent of traversal", () => {
  it("reports the same mom36Rank regardless of input array order", () => {
    const rows = universe();
    const mirrored = [...rows].reverse();
    const a = canonicalMom36Ranks(rows, "LONG");
    const b = canonicalMom36Ranks(mirrored, "LONG");
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("AAA")).toBe(1);
    expect(a.get("EEE")).toBe(5);
  });

  it("the preference objective is invariant to input order (it ranks canonically, not by traversal)", () => {
    // Pins order-invariance of the end-to-end result. NOTE: this does NOT prove the rank/traversal
    // separation is load-bearing today — the search pool is built from rank() and is therefore
    // already canonically sorted, so an objective keyed on enumeration position would currently
    // give the same answer. The separation is kept as a guard for the day the pool order changes;
    // two attempts to build a failing mutation for it both passed, and that is recorded here rather
    // than dressed up as proof.
    const rows = universe({ AAA: { oneHourReturn: -0.20 } });
    const shuffled = [...rows].reverse();
    const a = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    const b = buildDynamicMom36Formation({ activeUniverse: shuffled, maxPerCluster: 0, shock: shock() });
    expect(a.preference?.selection).toBe("PREFERRED");
    expect(b.preference?.selection).toBe("PREFERRED");
    expect(a.selection.selectedLongs.map((r) => r.symbol))
      .toEqual(b.selection.selectedLongs.map((r) => r.symbol));
    expect(a.selection.selectedShorts.map((r) => r.symbol))
      .toEqual(b.selection.selectedShorts.map((r) => r.symbol));
  });

  it("the audit's mom36Rank follows MOM36 order, not the order legs were admitted", () => {
    const formation = buildDynamicMom36Formation({
      activeUniverse: universe(), maxPerCluster: 0, shock: shock(),
    });
    for (const entry of formation.selection.candidateAudit.long) {
      const expected = canonicalMom36Ranks(universe(), "LONG").get(entry.symbol);
      expect(entry.mom36Rank).toBe(expected);
    }
  });
});

describe("preference formation — selector mechanics", () => {
  it("keeps the EXACT baseline when recent-strength data is missing", () => {
    // No oneHourReturn anywhere: S_1h is unknowable, so the preference must abstain entirely.
    const rows = universe().map((r) => ({ ...r, oneHourReturn: null }));
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    expect(formation.preference?.selection).toBe("BASELINE");
    expect(formation.preference?.reason).toBe("RECENT_STRENGTH_UNAVAILABLE");
    expect(formation.selection.selectedLongs.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("keeps the baseline when the baseline is already the best qualifying basket", () => {
    const formation = buildDynamicMom36Formation({ activeUniverse: universe(), maxPerCluster: 0, shock: shock() });
    expect(formation.preference?.selection).toBe("BASELINE");
    expect(formation.preference?.reason).toBe("BASELINE_ALREADY_BEST");
    expect(formation.selection.selectedLongs.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("SWAPS the actual selection when the top-ranked basket's recent strength has turned", () => {
    // AAA still ranks first on MOM36, but its last hour is deeply negative, dragging the baseline
    // basket's S_1h below zero. A lower-ranked but aligned combination should win.
    const rows = universe({ AAA: { oneHourReturn: -0.20 } });
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    expect(formation.preference?.selection).toBe("PREFERRED");
    expect(formation.preference?.reason).toBe("PREFERRED_RECENT_STRENGTH_ALIGNED");
    const chosen = formation.selection.selectedLongs.map((r) => r.symbol);
    expect(chosen).not.toContain("AAA");
    expect(chosen).toEqual(["BBB", "CCC", "DDD"]);
    // Canonical rank is untouched by the swap.
    expect(canonicalMom36Ranks(rows, "LONG").get("AAA")).toBe(1);
  });

  it("requires BOTH horizons: a basket good at 1h but bad at 4h cannot be preferred", () => {
    // Baseline S_1h is dragged negative, and every alternative long is negative at 4h, so no
    // combination qualifies and the baseline stands.
    const rows = universe({
      AAA: { oneHourReturn: -0.20 },
      BBB: { fastReturn: -0.05 },
      CCC: { fastReturn: -0.05 },
      DDD: { fastReturn: -0.05 },
      EEE: { fastReturn: -0.05 },
    });
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    expect(formation.preference?.selection).toBe("BASELINE");
    expect(formation.preference?.reason).toBe("RECENT_STRENGTH_MIXED");
    expect(formation.selection.selectedLongs.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("never revives an invalid baseline", () => {
    // Only four symbols are usable at all, so a six-leg basket cannot form. The preference must not
    // run, and must not resurrect the basket from the remaining names.
    const off = { longEligible: false, shortEligible: false };
    const rows = universe({
      AAA: off, BBB: off, CCC: off, DDD: off, EEE: off, VVV: off,
    });
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    expect(formation.preference).toBeNull();
    expect(formation.selection.selectedLongs.length + formation.selection.selectedShorts.length).toBeLessThan(6);
  });

  it("still refuses a combination that violates the cluster cap", () => {
    // maxPerCluster 1 with every symbol in one cluster would make any 3-leg side inadmissible; the
    // shared guard is the same one the baseline walk uses, so the preference cannot bypass it.
    const rows = universe({ AAA: { oneHourReturn: -0.20 } });
    const outcome = selectPreferredDynamicMom36Combination({
      rows,
      baselineLongs: [rows[0]!, rows[1]!, rows[2]!],
      baselineShorts: [rows[5]!, rows[6]!, rows[7]!],
      finalAllocation: { longCount: 3, shortCount: 3, label: "3L3S" },
      maxPerCluster: 1,
      slowFastApplied: false,
    });
    // With a cap of one per cluster no 3-leg side can validate, so nothing qualifies.
    expect(outcome.selection).toBe("BASELINE");
  });

  it("never puts the same symbol on both sides", () => {
    const rows = universe({ AAA: { oneHourReturn: -0.20 } });
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock() });
    const longs = new Set(formation.selection.selectedLongs.map((r) => r.symbol));
    for (const short of formation.selection.selectedShorts) {
      expect(longs.has(short.symbol)).toBe(false);
    }
  });

  it("abstains rather than searching without bound", () => {
    const rows = universe({ AAA: { oneHourReturn: -0.20 } });
    const outcome = selectPreferredDynamicMom36Combination({
      rows,
      baselineLongs: [rows[0]!, rows[1]!, rows[2]!],
      baselineShorts: [rows[5]!, rows[6]!, rows[7]!],
      finalAllocation: { longCount: 3, shortCount: 3, label: "3L3S" },
      maxPerCluster: 0,
      slowFastApplied: false,
      maxCombinations: 1,
    });
    expect(outcome.selection).toBe("BASELINE");
    expect(outcome.reason).toBe("SEARCH_EXHAUSTED");
    expect(outcome.searchExhausted).toBe(true);
  });
});

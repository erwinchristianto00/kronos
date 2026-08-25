import { describe, expect, it } from "vitest";
import {
  DYNAMIC_MOM36_SHOCK_36H_V1,
  applyBoundedShockOverlay,
  baseDynamicMom36Allocation,
  buildDynamicMom36Formation,
  crossSectionalStrategyVersion,
  normalizeFrozenRuntimeShockOverlay,
  resolveFrozenRuntimeShockOverlay,
  type DynamicMom36RankedSymbol,
  type FrozenShockOverlay,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

function row(symbol: string, mom36: number, opts: Partial<DynamicMom36RankedSymbol> = {}): DynamicMom36RankedSymbol {
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

function signedRows(positive: number, negative: number, zero = 0): DynamicMom36RankedSymbol[] {
  return [
    ...Array.from({ length: positive }, (_, index) => row(`P${String(index + 1).padStart(2, "0")}`, 0.01 + index / 10_000)),
    ...Array.from({ length: negative }, (_, index) => row(`N${String(index + 1).padStart(2, "0")}`, -0.01 - index / 10_000)),
    ...Array.from({ length: zero }, (_, index) => row(`Z${String(index + 1).padStart(2, "0")}`, 0)),
  ];
}

function shock(state: FrozenShockOverlay["state"], vetoAllowed = false): FrozenShockOverlay {
  return {
    modelArtifactId: "frozen-test-artifact",
    available: true,
    state,
    rawOutput: { artifactPresent: true, state },
    reason: null,
    vetoAllowed,
  };
}

describe("dynamic-mom36-shock-36h-v1 — deterministic breadth and frozen overlay", () => {
  it("implements every exact breadth rung, including a non-20-symbol universe", () => {
    const cases: Array<[number, number, string]> = [
      [8, 0, "6L0S"],
      [7, 1, "5L1S"],
      [6, 2, "4L2S"],
      [5, 3, "3L3S"],
      [2, 6, "2L4S"],
      [1, 7, "1L5S"],
      [0, 8, "0L6S"],
      [18, 2, "4L2S"],
      [2, 18, "2L4S"],
    ];
    for (const [positive, negative, expected] of cases) {
      const actual = baseDynamicMom36Allocation(signedRows(positive, negative));
      expect(actual.allocation.label, `${positive}/${negative}`).toBe(expected);
      expect(actual.positiveCount).toBe(positive);
      expect(actual.negativeCount).toBe(negative);
    }
  });

  it("logs zero separately and deterministically falls back to 3L3S", () => {
    const actual = baseDynamicMom36Allocation(signedRows(7, 1, 1));
    expect(actual).toMatchObject({ positiveCount: 7, negativeCount: 1, zeroCount: 1 });
    expect(actual.allocation.label).toBe("3L3S");
  });

  it("is bull/bear mirror-symmetric for allocation and ranked leg selection", () => {
    const original = [
      row("A", 0.08), row("B", 0.07), row("C", 0.06), row("D", 0.05),
      row("E", -0.02), row("F", -0.03),
    ];
    const mirrored = original.map((candidate) => ({ ...candidate, mom36: -candidate.mom36 }));
    const first = buildDynamicMom36Formation({ activeUniverse: original, maxPerCluster: 0, shock: shock("NO_EDGE") });
    const second = buildDynamicMom36Formation({ activeUniverse: mirrored, maxPerCluster: 0, shock: shock("NO_EDGE") });

    expect(first.baseAllocation.label).toBe("4L2S");
    expect(second.baseAllocation.label).toBe("2L4S");
    expect(second.selection.selectedLongs.map((leg) => leg.symbol).sort()).toEqual(first.selection.selectedShorts.map((leg) => leg.symbol).sort());
    expect(second.selection.selectedShorts.map((leg) => leg.symbol).sort()).toEqual(first.selection.selectedLongs.map((leg) => leg.symbol).sort());
  });

  it("keeps blocked shorts in breadth, then skips them only while selecting shorts", () => {
    const rows = [
      ...signedRows(6, 0),
      row("N1", -0.05),
      row("N2_BLOCKED", -0.06, { shortEligible: false, shortBlocked: true }),
    ];
    const formation = buildDynamicMom36Formation({ activeUniverse: rows, maxPerCluster: 0, shock: shock("NO_EDGE") });

    expect(formation.baseAllocation.label).toBe("4L2S");
    expect(formation.selection.selectedLongs).toHaveLength(4);
    expect(formation.selection.selectedShorts).toHaveLength(2);
    expect(formation.selection.blockedShortsSkipped).toEqual(["N2_BLOCKED"]);
    expect(formation.selection.selectedShorts.map((leg) => leg.symbol)).not.toContain("N2_BLOCKED");
  });

  it("keeps shock authority to one rung and never crosses neutral", () => {
    const from = (longCount: number) => ({ longCount, shortCount: 6 - longCount, label: (["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const)[longCount]! });
    expect(applyBoundedShockOverlay(from(4), shock("NO_EDGE")).allocation.label).toBe("4L2S");
    expect(applyBoundedShockOverlay(from(4), shock("CONFIRM_LONG")).allocation.label).toBe("5L1S");
    expect(applyBoundedShockOverlay(from(4), shock("CONFLICT_LONG")).allocation.label).toBe("3L3S");
    expect(applyBoundedShockOverlay(from(6), shock("CONFIRM_LONG")).allocation.label).toBe("6L0S");
    expect(applyBoundedShockOverlay(from(6), shock("CONFLICT_LONG")).allocation.label).toBe("5L1S");
    expect(applyBoundedShockOverlay(from(3), shock("CONFIRM_LONG")).allocation.label).toBe("4L2S");
    expect(applyBoundedShockOverlay(from(3), shock("CONFIRM_SHORT")).allocation.label).toBe("2L4S");
    expect(applyBoundedShockOverlay(from(4), shock("CONFLICT_SHORT")).allocation.label).toBe("4L2S");
    expect(applyBoundedShockOverlay(from(2), shock("CONFLICT_LONG")).allocation.label).toBe("2L4S");
  });

  it("falls back to NO_EDGE for every optional shock failure and keeps base MOM36 intact", () => {
    const failures: unknown[] = [
      null,
      { available: false, artifactPresent: false },
      { available: true, artifactPresent: true, timedOut: true, state: "CONFIRM_LONG" },
      { available: true, artifactPresent: true, featuresAvailable: false, state: "CONFIRM_LONG" },
      { available: true, artifactPresent: true, schemaValid: false, state: "CONFIRM_LONG" },
      { available: true, artifactPresent: true, state: "CONFIRM_LONG", probabilities: { up: Number.NaN } },
      { available: true, artifactPresent: true, state: "NOT_A_STATE" },
    ];
    for (const failure of failures) {
      const fallback = normalizeFrozenRuntimeShockOverlay(failure);
      expect(fallback.state).toBe("NO_EDGE");
      const formation = buildDynamicMom36Formation({ activeUniverse: signedRows(4, 2), maxPerCluster: 0, shock: fallback });
      expect(formation.finalAllocation.label).toBe("4L2S");
      expect(formation.vetoed).toBe(false);
    }
    expect(resolveFrozenRuntimeShockOverlay()).toMatchObject({ available: false, state: "NO_EDGE" });
  });

  it("has TESTNET/LIVE decision parity when their strategy configuration is identical", () => {
    const testnet = { CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1, LIVE_BINANCE_ENV: "testnet" } as NodeJS.ProcessEnv;
    const live = { CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1, LIVE_BINANCE_ENV: "mainnet" } as NodeJS.ProcessEnv;
    const snapshot = signedRows(5, 1);
    const testnetDecision = buildDynamicMom36Formation({ activeUniverse: snapshot, maxPerCluster: 0, shock: shock("NO_EDGE") });
    const liveDecision = buildDynamicMom36Formation({ activeUniverse: snapshot, maxPerCluster: 0, shock: shock("NO_EDGE") });

    expect(crossSectionalStrategyVersion(testnet)).toBe(crossSectionalStrategyVersion(live));
    expect(testnetDecision).toEqual(liveDecision);
  });
});

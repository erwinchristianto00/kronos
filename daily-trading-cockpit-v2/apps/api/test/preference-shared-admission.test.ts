import { describe, expect, it } from "vitest";
import { evaluateDynamicMom36Formation, type DynamicMom36FormationInput } from "../src/lib/cross-sectional-edge.js";
import {
  applyDynamicMom36Preference, buildDynamicMom36Formation, canonicalMom36Ranks,
  validateDynamicMom36SideCombination,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4,
  type DynamicMom36RankedSymbol,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const cut = Date.parse("2026-09-05T12:00:00Z");
function row(symbol: string, mom36: number, extra: Partial<DynamicMom36RankedSymbol> = {}): DynamicMom36RankedSymbol {
  return { symbol, mom36, price: 100, volatility: .01, extensionVol: 0,
    fastReturn: Math.sign(mom36) * .02, oneHourReturn: Math.sign(mom36) * .02,
    longEligible: true, shortEligible: true, shortBlocked: false,
    slowSourceTimestampMs: cut, slowStartTimestampMs: cut - 36 * 3600_000,
    fastSourceTimestampMs: cut, fastStartTimestampMs: cut - 4 * 3600_000,
    oneHourStartTimestampMs: cut - 3600_000, slowFastDataValid: true, ...extra };
}
function input(): DynamicMom36FormationInput {
  return { activeUniverse: [
    row("AAA", .10, { oneHourReturn: -.20 }), row("BBB", .09), row("CCC", .08), row("DDD", .07), row("EEE", .06),
    row("VVV", -.10), row("WWW", -.09), row("XXX", -.08), row("YYY", -.07), row("ZZZ", -.06),
  ], now: new Date(cut).toISOString(), openedAtMs: cut, horizonMs: 36 * 3600_000,
  featureTimestampMs: cut, decisionInformationCutoffMs: cut, maxPerCluster: 0,
  allowedLongCounts: [3], admissionScoreGapFloor: .058,
  strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4,
  continuationRuntime: null };
}
const legs = (result: ReturnType<typeof evaluateDynamicMom36Formation>) =>
  [result.basket?.longLeg, result.basket?.shortLeg];

describe("preference shared admission — production formation", () => {
  it("keeps an admitted baseline when every strength-qualified alternative fails scoreGap", () => {
    const request = { ...input(), admissionScoreGapFloor: .175 };
    const baseline = evaluateDynamicMom36Formation({ ...request,
      activeUniverse: request.activeUniverse.map(r => ({ ...r, oneHourReturn: null })) });
    const result = evaluateDynamicMom36Formation(request);
    expect(result.noEntryReason).toBeNull();
    expect(result.basket?.scoreGap).toBeCloseTo(.18);
    expect(legs(result)).toEqual(legs(baseline));
    expect(result.snapshot?.recentStrengthPreference).toMatchObject({ selectionMode: "BASELINE" });
  });
  it("does not resurrect a baseline rejected by scoreGap even if an alternative passes", () => {
    const result = evaluateDynamicMom36Formation({ ...input(), admissionScoreGapFloor: .5,
      admissionScoreBySymbol: { AAA: 0, BBB: 0, CCC: 0, VVV: 0, WWW: 0, XXX: 0, DDD: 3, EEE: 3 } });
    expect(result.noEntryReason).toBe("ADMISSION_SCORE_GAP_FAIL");
    expect(result.snapshot?.recentStrengthPreference).toBeNull();
    expect(result.basket).toBeNull();
  });
  it("external guard still rejects before preference", () => {
    const result = evaluateDynamicMom36Formation({ ...input(), admissionExternalReason: "OPERATOR_PAUSE" });
    expect(result.basket).toBeNull();
    expect(result.snapshot?.recentStrengthPreference).toBeNull();
    expect(result.noEntryReason).toContain("ADMISSION_EXTERNAL_GUARD");
  });
  it("deepens top-5 under the SAME per-side cluster cap, then evaluates the full weighted basket", () => {
    const request = { ...input(), maxPerCluster: 1, activeUniverse: [
      row("SOLUSDT", .10, { oneHourReturn: -.20 }), row("AVAXUSDT", .09), row("NEARUSDT", .08),
      row("SUIUSDT", .07), row("SEIUSDT", .06), row("LINKUSDT", .05), row("DOGEUSDT", .04),
      row("BTCUSDT", -.10), row("ETHUSDT", -.09), row("WLDUSDT", -.08),
    ] };
    const result = evaluateDynamicMom36Formation(request);
    expect(result.noEntryReason).toBeNull();
    expect(result.snapshot?.selectedLongs).toEqual(["AVAXUSDT", "LINKUSDT", "DOGEUSDT"]);
    expect(result.snapshot?.recentStrengthPreference).toMatchObject({
      baselineLongs: ["SOLUSDT", "LINKUSDT", "DOGEUSDT"], selectionMode: "PREFERRED", s1h: .04, s4h: .04,
      poolLongs: ["SOLUSDT", "AVAXUSDT", "NEARUSDT", "SUIUSDT", "SEIUSDT", "LINKUSDT", "DOGEUSDT"],
      actualSelection: { longs: [
        { symbol: "AVAXUSDT", canonicalRank: 2, weight: 1 / 6, sideWeight: 1 / 3 },
        { symbol: "LINKUSDT", canonicalRank: 6, weight: 1 / 6, sideWeight: 1 / 3 },
        { symbol: "DOGEUSDT", canonicalRank: 7, weight: 1 / 6, sideWeight: 1 / 3 },
      ] },
    });
  });
  it("does not borrow an ineligible or blocked alternative", () => {
    const request = input();
    request.activeUniverse = request.activeUniverse.map(r => r.symbol === "DDD" || r.symbol === "EEE"
      ? { ...r, longEligible: false } : r);
    const result = evaluateDynamicMom36Formation(request);
    expect(result.noEntryReason).toBeNull();
    expect(result.snapshot?.selectedLongs).toEqual(["AAA", "BBB", "CCC"]);
  });
  it("preserves exact baseline on missing strength, mixed strength, or search exhaustion", () => {
    for (const mode of ["missing", "mixed", "budget"] as const) {
      const request = input();
      request.activeUniverse = request.activeUniverse.map(r => ({ ...r,
        oneHourReturn: mode === "missing" ? null : mode === "mixed" ? -r.mom36 : r.oneHourReturn }));
      const baseline = buildDynamicMom36Formation({ activeUniverse: request.activeUniverse,
        maxPerCluster: 0, continuationOnly: true, slowFastMode: "STRICT", allowedLongCounts: [3] });
      const result = applyDynamicMom36Preference(baseline, { maxPerCluster: 0, admit: () => true,
        maxCombinations: mode === "budget" ? 1 : undefined });
      expect(result.preference?.selection).toBe("BASELINE");
      expect(result.selection.selectedLongs).toEqual(baseline.selection.selectedLongs);
      expect(result.selection.selectedShorts).toEqual(baseline.selection.selectedShorts);
      expect(result.preference?.reason).toBe(mode === "budget" ? "SEARCH_EXHAUSTED"
        : mode === "missing" ? "RECENT_STRENGTH_UNAVAILABLE" : "RECENT_STRENGTH_MIXED");
    }
  });
  it("guards reject quota, overlap, duplicate and cluster violations without changing canonical ranks", () => {
    const members = [row("SOLUSDT", .10), row("AVAXUSDT", .09), row("LINKUSDT", .08)];
    const args = { members, side: "LONG" as const, excluded: new Set<string>(), maxPerCluster: 0,
      slowFastApplied: true, requiredCount: 3 };
    expect(validateDynamicMom36SideCombination(args)).toEqual(members);
    expect(validateDynamicMom36SideCombination({ ...args, requiredCount: 2 })).toBeNull();
    expect(validateDynamicMom36SideCombination({ ...args, excluded: new Set(["SOLUSDT"]) })).toBeNull();
    expect(validateDynamicMom36SideCombination({ ...args, members: [members[0]!, members[0]!, members[2]!] })).toBeNull();
    expect(validateDynamicMom36SideCombination({ ...args, maxPerCluster: 1 })).toBeNull();
    const ranks = canonicalMom36Ranks(members, "LONG");
    expect([...members].reverse().map(r => ranks.get(r.symbol))).toEqual([3, 2, 1]);
  });
});

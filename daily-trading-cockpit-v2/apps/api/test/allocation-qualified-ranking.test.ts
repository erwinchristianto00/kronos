import { describe, it, expect } from "vitest";
import { evaluateDynamicMom36Formation, validateDynamicMom36FormationAdmissionParity, type DynamicMom36FormationInput } from "../src/lib/cross-sectional-edge.js";
import { crossSectionalSelectionRuntime } from "../src/lib/cross-sectional-policy.js";
import { dynamicAllocationSelectionMode } from "../src/lib/dynamic-mom36-allocation-ranking.js";
import { dynamicMom36BasketReturn, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 as version, type DynamicMom36RankedSymbol } from "../src/lib/dynamic-mom36-shock-strategy.js";
const cut = Date.parse("2026-09-06T05:00:00Z");
function row(symbol: string, mom36: number): DynamicMom36RankedSymbol {
  return { symbol, mom36, price: 100, volatility: .01, extensionVol: 0,
    oneHourReturn: Math.sign(mom36) * .02, fastReturn: Math.sign(mom36) * .04,
    longEligible: true, shortEligible: true, shortBlocked: false,
    slowSourceTimestampMs: cut, slowStartTimestampMs: cut - 36 * 3600_000,
    fastSourceTimestampMs: cut, fastStartTimestampMs: cut - 4 * 3600_000,
    oneHourStartTimestampMs: cut - 3600_000, slowFastDataValid: true };
}
function input(nl = 5, ns = 5): DynamicMom36FormationInput {
  return { activeUniverse: [
    ...Array.from({ length: nl }, (_, i) => row(`L${i}`, .10 - i * .01)),
    ...Array.from({ length: ns }, (_, i) => row(`S${i}`, -.10 + i * .01)),
  ], now: new Date(cut).toISOString(), openedAtMs: cut, horizonMs: 36 * 3600_000,
    featureTimestampMs: cut, decisionInformationCutoffMs: cut, maxPerCluster: 0,
    allowedLongCounts: [2,3,4], allocationSelectionMode: "RANK_ALL_QUALIFIED",
    admissionScoreGapFloor: .058, strategyVersion: version, continuationRuntime: null };
}
describe("qualified ranking across complete 2/4, 4/2 and 3/3 baskets", () => {
  it("compares all three and allows 3/3 to win on a better rank", () => {
    const r = evaluateDynamicMom36Formation(input());
    expect(r.snapshot?.allocationRanking?.candidates).toHaveLength(3);
    expect(r.snapshot?.allocationRanking?.candidates.every(c => c.qualified)).toBe(true);
    expect(r.snapshot?.finalAllocation.label).toBe("3L3S");
    expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
  });
  it("breaks an equal cross-geometry rank in favor of skew", () => {
    const request = input(); request.activeUniverse[5]!.shortBlocked = true; request.activeUniverse[5]!.shortEligible = false;
    const r = evaluateDynamicMom36Formation(request), cs = r.snapshot!.allocationRanking!.candidates;
    expect(cs.find(c => c.allocation.longCount === 4)?.rank).toBe(cs.find(c => c.allocation.longCount === 3)?.rank);
    expect(r.snapshot?.finalAllocation.label).toBe("4L2S");
  });
  it("does not label an equal-side-positive but capital-negative 2/4 basket qualified", () => {
    const request = input(); request.activeUniverse.forEach(r => { r.oneHourReturn = r.mom36 > 0 ? .03 : .02; });
    const r = evaluateDynamicMom36Formation(request);
    const candidate = r.snapshot!.allocationRanking!.candidates.find(c => c.allocation.longCount === 2)!;
    expect(candidate.basketReturn1h).toBeLessThan(0);
    expect(candidate.qualified).toBe(false);
  });
  it("supports strict skew priority independently of rank-first selection", () => {
    const r = evaluateDynamicMom36Formation({ ...input(), allocationSelectionMode: "SKEW_FIRST_QUALIFIED" });
    expect(r.snapshot?.finalAllocation.label).toBe("2L4S");
  });
  it.each([2,4])("opens complete qualified %i-long geometry when 3/3 cannot fill", longCount => {
    const r = evaluateDynamicMom36Formation(input(longCount === 2 ? 2 : 5, longCount === 4 ? 2 : 5));
    expect(r.noEntryReason).toBeNull();
    expect(r.basket?.longK).toBe(longCount);
    expect(r.basket?.shortK).toBe(6 - longCount);
    expect(r.snapshot?.allocationRanking?.outcome).toBe("QUALIFIED_WINNER");
    expect(r.snapshot?.recentStrengthPreference).not.toBeNull();
    expect([...r.basket!.longLeg, ...r.basket!.shortLeg].every(l => l.weight === 1/6)).toBe(true);
    expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
  });
  it.each([2,4])("finds a qualified alternative with %i longs through shared admission", longCount => {
    const request = { ...input(), allowedLongCounts: [longCount] };
    request.activeUniverse[0]!.oneHourReturn = -1;
    request.activeUniverse[5]!.oneHourReturn = 1;
    const r = evaluateDynamicMom36Formation(request);
    expect(r.noEntryReason).toBeNull();
    expect(r.snapshot?.recentStrengthPreference).toMatchObject({ selectionMode: "PREFERRED" });
    expect(r.snapshot?.selectedLongs).not.toContain("L0");
    expect(r.snapshot?.selectedShorts).not.toContain("S0");
    expect(r.snapshot?.selectedLongs).toHaveLength(longCount);
    expect(r.snapshot?.selectedShorts).toHaveLength(6 - longCount);
    expect(validateDynamicMom36FormationAdmissionParity(r.snapshot).valid).toBe(true);
  });
  it("records capital-weighted qualification for asymmetric candidates", () => {
    const request = input();
    request.activeUniverse.forEach(r => { r.oneHourReturn = r.mom36 > 0 ? .01 : .011; });
    // Four longs include a stronger last-hour return; two shorts retain the valid slow/fast sign.
    request.activeUniverse[3]!.oneHourReturn = .02;
    request.activeUniverse[4]!.oneHourReturn = .02;
    const r = evaluateDynamicMom36Formation(request);
    expect(r.snapshot?.allocationRanking?.candidates.find(c => c.allocation.longCount === 4)?.qualified).toBe(true);
    expect(r.noEntryReason).toBeNull();
  });
  it("shortage of shorts holds instead of borrowing rising coins", () => {
    const r = evaluateDynamicMom36Formation(input(10,0));
    expect(r.basket).toBeNull();
    expect(r.snapshot?.allocationRanking?.candidates.every(c => !c.qualified)).toBe(true);
  });
  it("keeps continuation confirmation on both skew directions", () => {
    const r = evaluateDynamicMom36Formation({ ...input(), requireSkewContinuationConfirmation: true });
    const candidates = r.snapshot!.allocationRanking!.candidates;
    expect(candidates.filter(c => c.allocation.longCount !== 3).map(c => c.admissionReason))
      .toEqual(["ADMISSION_SKEW_CONTINUATION_UNCONFIRMED", "ADMISSION_SKEW_CONTINUATION_UNCONFIRMED"]);
    expect(r.snapshot?.finalAllocation.label).toBe("3L3S");
  });
  it.each([2,4])("admits %i-long ranked alternatives with real continuation normalization and confirmation", longCount => {
    const request = input(longCount === 2 ? 2 : 5, longCount === 4 ? 2 : 5);
    const bullish = longCount === 4;
    request.requireSkewContinuationConfirmation = true;
    request.continuationRuntime = {
      available: true, artifactId: "dm-36h-v4-20260824T153338Z:sha256:test", artifactSha256: "test", schemaVersion: 4,
      featureVersion: "direction-model-features-v4-975c996", calibrationVersion: "temperature-1.1",
      runtimeFunction: "DirectionModelService.evaluate -> DirectionTrajectory.predict", featureAtMs: cut,
      fallbackReason: null, rawOutput: { test: true },
      trajectory: {
        pathProbabilities: { PERSISTENT_UP: bullish ? .6 : .1, PERSISTENT_DOWN: bullish ? .1 : .6,
          UP_THEN_REVERSAL: .05, DOWN_THEN_REVERSAL: .05, EARLY_UP_THEN_FLAT: .05, EARLY_DOWN_THEN_FLAT: .05, CHOP: .05, TRANSITION: .05 },
        topPath: bullish ? "PERSISTENT_UP" : "PERSISTENT_DOWN", topPathProbability: .6,
        persistenceScore: bullish ? .5 : -.5, reversalRisk: .1,
        horizons: [6,12,24,36].map(horizon => ({ horizon, pStrongUp: bullish ? .6 : .2,
          pNeutral: .2, pStrongDown: bullish ? .2 : .6, expectedReturn: 0, q10: -.01, q50: 0, q90: .01, expectedVol: .01 })),
        earlyLean: 0, lateLean: 0, reversalAxis: 0, expectedReturn: 0, q10: -.01, q50: 0, q90: .01,
        expectedVol: .01, confidence: .5, horizonAgreement: 1, modelVersion: "dm-36h-v4-20260824T153338Z", schemaVersion: 4,
      } as never,
    };
    const r = evaluateDynamicMom36Formation(request);
    expect(r.snapshot?.continuation?.decision).toBe(bullish ? "CONFIRM_LONG" : "CONFIRM_SHORT");
    expect(r.noEntryReason).toBeNull();
    expect(r.basket?.longK).toBe(longCount);
    expect(r.snapshot?.allocationRanking?.outcome).toBe("QUALIFIED_WINNER");
  });
  it.each(["external", "gap", "stale", "blocked", "cluster"])("all geometries retain the %s guard", guard => {
    const request = input();
    if (guard === "external") request.admissionExternalReason = "OPERATOR_PAUSE";
    if (guard === "gap") request.admissionScoreGapFloor = 9;
    if (guard === "stale") request.activeUniverse.forEach(r => { r.fastSourceTimestampMs = cut - 1; });
    if (guard === "blocked") request.activeUniverse.forEach(r => { r.shortBlocked = true; r.shortEligible = false; });
    if (guard === "cluster") request.maxPerCluster = 1;
    const r = evaluateDynamicMom36Formation(request);
    expect(r.basket).toBeNull();
    expect(r.snapshot?.allocationRanking?.candidates.every(c => !c.qualified)).toBe(true);
  });
  it("missing recent strength preserves the original admitted baseline exactly", () => {
    const request = input(); request.activeUniverse.forEach(r => { r.oneHourReturn = null; });
    const old = evaluateDynamicMom36Formation({ ...request, allocationSelectionMode: "BREADTH" });
    const r = evaluateDynamicMom36Formation(request);
    expect(r.basket?.longLeg).toEqual(old.basket?.longLeg);
    expect(r.basket?.shortLeg).toEqual(old.basket?.shortLeg);
    expect(r.snapshot?.selectedCandidateHash).toBe(old.snapshot?.selectedCandidateHash);
    expect(r.snapshot?.allocationRanking?.outcome).toBe("NO_QUALIFIED_KEEP_BASELINE");
  });
  it("uses signed actual 1/6 capital weights instead of equal side weights for skew", () => {
    const l = [row("L0",.1), row("L1",.09)];
    const s = [row("S0",-.1),row("S1",-.09),row("S2",-.08),row("S3",-.07)];
    l.forEach(r => r.oneHourReturn = .03); s.forEach(r => r.oneHourReturn = .02);
    expect(dynamicMom36BasketReturn(l,s,"1h")).toBeCloseTo((2*.03-4*.02)/6);
    expect(dynamicMom36BasketReturn(l,s,"1h")).toBeLessThan(0);
  });
  it("deterministically ranks the same candidates under reordered input", () => {
    const request = input(); request.activeUniverse[0]!.oneHourReturn = -.20;
    const a = evaluateDynamicMom36Formation(request);
    const b = evaluateDynamicMom36Formation({ ...request, activeUniverse: [...request.activeUniverse].reverse() });
    expect(a.snapshot?.allocationRanking).toEqual(b.snapshot?.allocationRanking);
    expect(a.snapshot?.selectedCandidateHash).toBe(b.snapshot?.selectedCandidateHash);
  });
  it("exposes the effective mode and rejects invalid modes", () => {
    expect(dynamicAllocationSelectionMode(undefined)).toBe("BREADTH");
    expect(dynamicAllocationSelectionMode("typo")).toBeNull();
    const env = { CROSS_SECTIONAL_STRATEGY_VERSION: version, CROSS_SECTIONAL_EXEC_VARIANT: "DYNAMIC_MOM36_SHOCK",
      CROSS_SECTIONAL_DYNAMIC_ALLOWED_ALLOCATIONS: "2L4S,3L3S,4L2S", CROSS_SECTIONAL_DYNAMIC_ALLOCATION_SELECTION_MODE: "RANK_ALL_QUALIFIED" };
    expect(crossSectionalSelectionRuntime(env).allocationPolicy).toMatchObject({ selectionMode: "RANK_ALL_QUALIFIED",
      qualifiedAlternativeAllocations: ["2L4S","3L3S","4L2S"] });
    expect(crossSectionalSelectionRuntime({ ...env, CROSS_SECTIONAL_DYNAMIC_ALLOCATION_SELECTION_MODE: "bad" }).state).toBe("CONFIG_INEFFECTIVE");
  });
});

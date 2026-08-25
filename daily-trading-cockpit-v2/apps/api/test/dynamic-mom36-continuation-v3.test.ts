import { describe, expect, it } from "vitest";
import type { DynamicMom36ContinuationRuntimeResult } from "../src/lib/dynamic-mom36-continuation-runtime.js";
import { buildDynamicMom36ShockBasket } from "../src/lib/cross-sectional-edge.js";
import {
  DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3,
  applyBoundedContinuationOverlay,
  buildDynamicMom36Formation,
  normalizeFrozenRuntimeShockOverlay,
  normalizeFrozenV4ContinuationOverlay,
  type DynamicMom36Allocation,
  type DynamicMom36RankedSymbol,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function allocation(longCount: number): DynamicMom36Allocation {
  const labels = ["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const;
  return { longCount, shortCount: 6 - longCount, label: labels[longCount]! };
}

type Vote = "BULL" | "BEAR" | "NEUTRAL";

function runtime(input: {
  votes: readonly Vote[];
  persistenceScore: number;
  topPath: string;
  reversalRisk: number;
  featureAtMs?: number | null;
  pathProbabilities?: Record<string, number>;
  schemaVersion?: number;
}): DynamicMom36ContinuationRuntimeResult {
  const probability = (vote: Vote) => vote === "BULL"
    ? { pStrongUp: 0.60, pNeutral: 0.20, pStrongDown: 0.20 }
    : vote === "BEAR"
      ? { pStrongUp: 0.20, pNeutral: 0.20, pStrongDown: 0.60 }
      : { pStrongUp: 0.40, pNeutral: 0.20, pStrongDown: 0.40 };
  const horizons = [6, 12, 24, 36].map((horizon, index) => ({
    horizon,
    ...probability(input.votes[index] ?? "NEUTRAL"),
    expectedReturn: 0,
    q10: -0.01,
    q50: 0,
    q90: 0.01,
    expectedVol: 0.01,
  }));
  return {
    available: true,
    artifactId: "dm-36h-v4-20260824T153338Z:sha256:test",
    artifactSha256: "test",
    schemaVersion: input.schemaVersion ?? 4,
    featureVersion: "direction-model-features-v4-975c996",
    calibrationVersion: "temperature-1.1",
    runtimeFunction: "DirectionModelService.evaluate -> DirectionTrajectory.predict",
    featureAtMs: input.featureAtMs === undefined ? NOW : input.featureAtMs,
    fallbackReason: null,
    trajectory: {
      pathProbabilities: input.pathProbabilities ?? {
        PERSISTENT_UP: 0.45,
        PERSISTENT_DOWN: 0.10,
        UP_THEN_REVERSAL: 0.05,
        DOWN_THEN_REVERSAL: 0.05,
        EARLY_UP_THEN_FLAT: 0.05,
        EARLY_DOWN_THEN_FLAT: 0.05,
        CHOP: 0.20,
        TRANSITION: 0.15,
      },
      topPath: input.topPath as never,
      topPathProbability: 0.45,
      persistenceScore: input.persistenceScore,
      reversalRisk: input.reversalRisk,
      horizons,
      earlyLean: 0,
      lateLean: 0,
      reversalAxis: 0,
      expectedReturn: 0,
      q10: -0.01,
      q50: 0,
      q90: 0.01,
      expectedVol: 0.01,
      confidence: 0.5,
      horizonAgreement: 0.5,
      modelVersion: "dm-36h-v4-20260824T153338Z",
      schemaVersion: input.schemaVersion ?? 4,
    },
    rawOutput: { test: true },
  };
}

function rows(): DynamicMom36RankedSymbol[] {
  return [
    ["A", 0.08], ["B", 0.07], ["C", 0.06], ["D", 0.05], ["E", -0.02], ["F", -0.03],
  ].map(([symbol, mom36]) => ({
    symbol: String(symbol), mom36: Number(mom36), price: 100, volatility: 0.01,
    fastReturn: 0, extensionVol: 0, longEligible: true, shortEligible: true, shortBlocked: false,
  }));
}

describe("Dynamic MOM36 continuation v3 — frozen V4 formation-only overlay", () => {
  it("confirms a bullish 4L2S base by exactly one rung from 3/4 bullish horizons", () => {
    const overlay = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BULL", "BULL", "BULL", "NEUTRAL"],
      persistenceScore: 0.10,
      topPath: "PERSISTENT_UP",
      reversalRisk: 0.10,
    }), allocation(4));
    expect(overlay).toMatchObject({
      available: true,
      bullVotes: 3,
      bearVotes: 0,
      neutralVotes: 1,
      agreementScore: 0.75,
      persistenceDirection: "PERSIST_UP",
      decision: "CONFIRM_LONG",
    });
    expect(applyBoundedContinuationOverlay(allocation(4), overlay)).toMatchObject({ label: "5L1S" });
  });

  it("does not overrule mixed evidence, then applies conflict and neutral mappings exactly once", () => {
    const mixed = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BULL", "BEAR", "BULL", "BEAR"], persistenceScore: 0.10,
      topPath: "PERSISTENT_UP", reversalRisk: 0.10,
    }), allocation(5));
    expect(mixed.decision).toBe("NO_EDGE");
    expect(applyBoundedContinuationOverlay(allocation(5), mixed).label).toBe("5L1S");

    const conflict = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BEAR", "BEAR", "BEAR", "NEUTRAL"], persistenceScore: -0.10,
      topPath: "PERSISTENT_DOWN", reversalRisk: 0.10,
    }), allocation(5));
    expect(conflict.decision).toBe("CONFLICT_LONG");
    expect(applyBoundedContinuationOverlay(allocation(5), conflict).label).toBe("4L2S");

    const neutralBase = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BULL", "BULL", "BULL", "NEUTRAL"], persistenceScore: 0.10,
      topPath: "EARLY_UP_THEN_FLAT", reversalRisk: 0.10,
    }), allocation(3));
    expect(neutralBase.decision).toBe("CONFIRM_LONG");
    expect(applyBoundedContinuationOverlay(allocation(3), neutralBase).label).toBe("4L2S");
  });

  it("is mirror-symmetric on the bearish side and never crosses neutral", () => {
    const confirmShort = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BEAR", "BEAR", "BEAR", "NEUTRAL"], persistenceScore: -0.10,
      topPath: "EARLY_DOWN_THEN_FLAT", reversalRisk: 0.10,
    }), allocation(2));
    expect(confirmShort.decision).toBe("CONFIRM_SHORT");
    expect(applyBoundedContinuationOverlay(allocation(2), confirmShort).label).toBe("1L5S");

    const conflictShort = normalizeFrozenV4ContinuationOverlay(runtime({
      votes: ["BULL", "BULL", "BULL", "NEUTRAL"], persistenceScore: 0.10,
      topPath: "PERSISTENT_UP", reversalRisk: 0.10,
    }), allocation(1));
    expect(conflictShort.decision).toBe("CONFLICT_SHORT");
    expect(applyBoundedContinuationOverlay(allocation(1), conflictShort).label).toBe("2L4S");
    expect(applyBoundedContinuationOverlay(allocation(2), { decision: "CONFIRM_LONG" }).label).toBe("2L4S");
  });

  it("falls back to NO_EDGE for artifact/runtime/schema/stale/path failures without vetoing MOM36", () => {
    const failures: unknown[] = [
      null,
      { available: false, artifactId: "missing", fallbackReason: "artifact_missing" },
      { ...runtime({ votes: ["BULL", "BULL", "BULL", "BULL"], persistenceScore: 0.1, topPath: "PERSISTENT_UP", reversalRisk: 0.1 }), schemaVersion: 3 },
      runtime({ votes: ["BULL", "BULL", "BULL", "BULL"], persistenceScore: Number.NaN, topPath: "PERSISTENT_UP", reversalRisk: 0.1 }),
      runtime({ votes: ["BULL", "BULL", "BULL", "BULL"], persistenceScore: 0.1, topPath: "PERSISTENT_UP", reversalRisk: 0.1, featureAtMs: null }),
      runtime({ votes: ["BULL", "BULL", "BULL", "BULL"], persistenceScore: 0.1, topPath: "PERSISTENT_UP", reversalRisk: 0.1, pathProbabilities: {} }),
      { available: false, artifactId: "pinned", fallbackReason: "stale_features_240m" },
      { available: false, artifactId: "pinned", fallbackReason: "timeout" },
    ];
    for (const failure of failures) {
      const overlay = normalizeFrozenV4ContinuationOverlay(failure, allocation(4));
      expect(overlay.decision).toBe("NO_EDGE");
      expect(applyBoundedContinuationOverlay(allocation(4), overlay).label).toBe("4L2S");
    }
  });

  it("uses BASE exactly when v3 continuation is unavailable, even if a legacy shock mapping would veto", () => {
    const legacyVeto = normalizeFrozenRuntimeShockOverlay({
      available: true,
      artifactPresent: true,
      state: "VETO",
      vetoAllowed: true,
    });
    const formation = buildDynamicMom36Formation({
      activeUniverse: rows(),
      maxPerCluster: 0,
      shock: legacyVeto,
      continuationRuntime: null,
      continuationOnly: true,
    });
    expect(formation.vetoed).toBe(false);
    expect(formation).toMatchObject({
      baseAllocation: { label: "4L2S" },
      finalAllocation: { label: "4L2S" },
      continuation: { available: false, decision: "NO_EDGE" },
    });
  });

  it("wires an unavailable V3 runtime into an executable BASE basket rather than blocking admission", () => {
    const basket = buildDynamicMom36ShockBasket({
      activeUniverse: rows(),
      now: new Date(NOW).toISOString(),
      openedAtMs: NOW,
      horizonMs: 36 * 3_600_000,
      featureTimestampMs: NOW,
      decisionInformationCutoffMs: NOW,
      maxPerCluster: 0,
      admissionScoreGap: 0.10,
      admissionScoreGapFloor: 0.058,
      admissionPassed: true,
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3,
      continuationRuntime: null,
    });
    expect(basket).not.toBeNull();
    expect(basket?.dynamicMom36).toMatchObject({
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3,
      baseAllocation: { label: "4L2S" },
      finalAllocation: { label: "4L2S" },
      continuation: { available: false, decision: "NO_EDGE" },
    });
  });

  it("freezes the exact V3 formation evidence while leaving MOM36 ranking responsible for symbols", () => {
    const continuationRuntime = runtime({
      votes: ["BULL", "BULL", "BULL", "NEUTRAL"], persistenceScore: 0.10,
      topPath: "PERSISTENT_UP", reversalRisk: 0.10,
    });
    const testnet = buildDynamicMom36Formation({ activeUniverse: rows(), maxPerCluster: 0, continuationRuntime });
    const live = buildDynamicMom36Formation({ activeUniverse: rows(), maxPerCluster: 0, continuationRuntime });
    expect(testnet).toEqual(live);
    expect(testnet).toMatchObject({
      baseAllocation: { label: "4L2S" }, finalAllocation: { label: "5L1S" },
      continuation: { continuationArtifactId: "dm-36h-v4-20260824T153338Z:sha256:test", decision: "CONFIRM_LONG" },
    });
    expect(testnet.selection.selectedLongs.map((row) => row.symbol)).toEqual(["A", "B", "C", "D", "E"]);
    expect(DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3).toBe("dynamic-mom36-continuation-sl2-mfe30-36h-v3");
  });
});

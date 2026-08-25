import { describe, expect, it } from "vitest";
import {
  compareContinuationArtifacts,
  evaluateContinuationArtifact,
  newestPurgedHoldout,
  type ContinuationMatrixRow,
} from "../src/lib/continuation-evaluation.js";

function leaf(value = 0) {
  return { featureIdx: [-1], threshold: [0], missingGoToLeft: [0], left: [0], right: [0], isLeaf: [1], value: [value] };
}

function artifact(version: string) {
  const scalar = () => ({ kind: "identity", baseline: 0, trees: [leaf()] });
  const specialist = () => ({
    cls: { kind: "softmax", classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"], perClass: [0, 1, 2].map(() => ({ baseline: 0, trees: [leaf()] })) },
    mean: scalar(), q10: scalar(), q50: scalar(), q90: scalar(), vol: scalar(),
  });
  return {
    version, schemaVersion: 4, trainedAt: "2026-08-26T00:00:00.000Z", horizonBars: 36, horizons: [6, 12, 24, 36],
    featureNames: ["feature_a"], trajectoryFeatureNames: Array.from({ length: 40 }, (_, i) => `t${i}`),
    classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"],
    pathClasses: ["PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL", "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION"],
    zBoundary: 0.5, calibrationTemperature: 1.1, trainRows: 1000, trainSpan: { fromMs: 1, toMs: 2 },
    specialists: { "6": specialist(), "12": specialist(), "24": specialist(), "36": specialist() },
    trajectory: { cls: { kind: "softmax", classes: ["PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL", "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION"], perClass: Array.from({ length: 8 }, () => ({ baseline: 0, trees: [leaf()] })) } },
  };
}

function row(index: number): ContinuationMatrixRow {
  const formationTimestampMs = 1_770_000_000_000 + index * 3_600_000;
  return {
    formationTimestampMs,
    maxFeatureSourceTimestampMs: formationTimestampMs,
    baseLongCount: index % 2 ? 4 : 2,
    features: { feature_a: index },
    labels: {
      6: { r: 0.01, vol: 0.01, z: 1, cls: "STRONG_UP" },
      12: { r: 0.01, vol: 0.01, z: 1, cls: "STRONG_UP" },
      24: { r: 0.01, vol: 0.01, z: 1, cls: "STRONG_UP" },
      36: { r: 0.01, vol: 0.01, z: 1, cls: "STRONG_UP" },
    },
  };
}

describe("continuation artifact evaluator", () => {
  it("uses the runtime tree parser and exact bounded decision mapping on PIT-safe rows", () => {
    const evaluated = evaluateContinuationArtifact(artifact("dm-eval") as never, Array.from({ length: 100 }, (_, i) => row(i)));
    expect(evaluated.observations).toHaveLength(100);
    expect(evaluated.metrics.trajectory.logLoss).toBeCloseTo(Math.log(8), 8);
    expect(evaluated.metrics.decisions.noEdgePct).toBe(1);
    expect(evaluated.metrics.horizons["36"]?.logLoss).toBeCloseTo(Math.log(3), 8);
  });

  it("calculates a purged newest chronological holdout and time-aware comparison fields", () => {
    // Keep more than one full 36-hour block after the purge so the time-aware
    // bootstrap has a valid resampling unit.
    const rows = Array.from({ length: 400 }, (_, i) => row(i));
    const holdout = newestPurgedHoldout(rows);
    expect(holdout).toHaveLength(44);
    const champion = evaluateContinuationArtifact(artifact("dm-one") as never, holdout);
    const challenger = evaluateContinuationArtifact(artifact("dm-two") as never, holdout);
    const compared = compareContinuationArtifacts(champion, challenger);
    expect(compared.bootstrap.deltaLogLossCiLow).toBe(0);
    expect(compared.bootstrap.deltaLogLossCiHigh).toBe(0);
  });

  it("refuses any matrix row whose feature timestamp is after formation", () => {
    const bad = row(0);
    bad.maxFeatureSourceTimestampMs += 1;
    expect(() => evaluateContinuationArtifact(artifact("dm-bad") as never, [bad])).toThrow(/PIT/);
  });
});

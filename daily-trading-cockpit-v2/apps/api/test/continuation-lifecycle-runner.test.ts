import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectionTrajectory } from "../src/lib/direction-model-runtime.js";
import {
  continuationCollectorIntegrityGate,
  continuationResourceSnapshot,
  deriveContinuationLabelMaturation,
  evaluateContinuationPromotionGates,
  verifyPythonRuntimeParity,
} from "../src/lib/continuation-lifecycle-runner.js";
import { acquireContinuationLock, continuationLifecyclePaths, type ContinuationArtifactMetrics, type ContinuationCollectorHealth } from "../src/lib/continuation-lifecycle.js";

function metrics(overrides: Partial<ContinuationArtifactMetrics["trajectory"]> = {}, decisionTilt = 0.1): ContinuationArtifactMetrics {
  return {
    trajectory: {
      logLoss: 1,
      baseRateLogLoss: 1.2,
      balancedAccuracy: 0.5,
      brier: 0.2,
      expectedReturnCorrelation: 0.1,
      calibrationEce: 0.05,
      ...overrides,
    },
    horizons: {},
    decisions: {
      observations: 600,
      noEdgePct: 0.8,
      tiltPct: decisionTilt,
      confirmationCount: 50,
      conflictCount: 10,
      confirmationSignedMeanReturn: 0.01,
      conflictSignedMeanReturn: 0.003,
    },
    temporal: { buckets: 4, nonRegressingBuckets: 4, worstDeltaLogLoss: -0.002, medianDeltaLogLoss: -0.01 },
    bootstrap: { deltaLogLossCiLow: -0.02, deltaLogLossCiHigh: -0.001 },
  };
}

function healthyCollector(now: number): ContinuationCollectorHealth {
  const source = { required: true, freshness: "HEALTHY" as const, ageMs: 1, eventsToday: 10, lastError: null };
  return {
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    collectorId: "test",
    running: true,
    watermarks: {},
    sourceSummary: {
      "binance-usdm:kline_1m": source,
      "binance-usdm:kline_5m": source,
      "binance-usdm:kline_1h": source,
    },
  };
}

function leaf(value = 0) {
  return { featureIdx: [-1], threshold: [0], missingGoToLeft: [0], left: [0], right: [0], isLeaf: [1], value: [value] };
}

function parityArtifact() {
  const scalar = () => ({ kind: "identity", baseline: 0, trees: [leaf()] });
  const specialist = () => ({
    cls: { kind: "softmax", classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"], perClass: [0, 1, 2].map(() => ({ baseline: 0, trees: [leaf()] })) },
    mean: scalar(), q10: scalar(), q50: scalar(), q90: scalar(), vol: scalar(),
  });
  return {
    version: "dm-parity-fixture", schemaVersion: 4, trainedAt: "2026-08-26T00:00:00.000Z", horizonBars: 36, horizons: [6, 12, 24, 36],
    featureNames: ["feature_a"], trajectoryFeatureNames: Array.from({ length: 40 }, (_, index) => `trajectory_${index}`),
    classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"],
    pathClasses: ["PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL", "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION"],
    zBoundary: 0.5, calibrationTemperature: 1.1, trainRows: 1000, trainSpan: { fromMs: 1, toMs: 2 },
    specialists: { "6": specialist(), "12": specialist(), "24": specialist(), "36": specialist() },
    trajectory: { cls: { kind: "softmax", classes: ["PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL", "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION"], perClass: Array.from({ length: 8 }, () => ({ baseline: 0, trees: [leaf()] })) } },
  };
}

describe("continuation lifecycle promotion policy", () => {
  it("requires every strict gate before a pointer can advance", () => {
    const champion = metrics();
    const challenger = metrics({ logLoss: 0.99, calibrationEce: 0.055 });
    const gates = evaluateContinuationPromotionGates({
      dataIntegrity: true,
      featureParity: true,
      noLeakage: true,
      sufficientSamples: true,
      runtimeDryLoad: true,
      trainerFidelity: 0,
      pythonRuntimeParity: true,
      champion,
      challenger,
    });
    expect(gates.every((gate) => gate.passed)).toBe(true);
  });

  it("rejects a numerical tie/worse challenger even if plumbing is valid", () => {
    const champion = metrics();
    const challenger = metrics({ logLoss: 1.0001, calibrationEce: 0.051 }, 0.9);
    challenger.temporal = { buckets: 4, nonRegressingBuckets: 1, worstDeltaLogLoss: 0.2, medianDeltaLogLoss: 0.1 };
    challenger.bootstrap = { deltaLogLossCiLow: -0.1, deltaLogLossCiHigh: 0.1 };
    const gates = evaluateContinuationPromotionGates({
      dataIntegrity: true,
      featureParity: true,
      noLeakage: true,
      sufficientSamples: true,
      runtimeDryLoad: true,
      trainerFidelity: 0,
      pythonRuntimeParity: true,
      champion,
      challenger,
    });
    expect(gates.find((gate) => gate.id === "PRIMARY_IMPROVEMENT")?.passed).toBe(false);
    expect(gates.find((gate) => gate.id === "DECISION_LEVEL")?.passed).toBe(false);
    expect(gates.find((gate) => gate.id === "BOOTSTRAP_UNCERTAINTY")?.passed).toBe(false);
  });

  it("fails the feature-parity gate when the Python reference and served runtime disagree", () => {
    const gates = evaluateContinuationPromotionGates({
      dataIntegrity: true,
      featureParity: true,
      pythonRuntimeParity: false,
      noLeakage: true,
      sufficientSamples: true,
      runtimeDryLoad: true,
      trainerFidelity: 0,
      champion: metrics(),
      challenger: metrics({ logLoss: 0.99 }),
    });
    expect(gates.find((gate) => gate.id === "FEATURE_PARITY")?.passed).toBe(false);
  });

  it("requires the serialized Python reference to match TypeScript tree inference exactly", () => {
    const artifact = parityArtifact();
    const prediction = DirectionTrajectory.fromJson(artifact as never).predict({ feature_a: null });
    const directory = mkdtempSync(join(tmpdir(), "continuation-parity-"));
    const fixture = join(directory, "python-runtime-parity.json");
    try {
      writeFileSync(fixture, JSON.stringify({
        schemaVersion: 1,
        artifactVersion: artifact.version,
        featureNames: artifact.featureNames,
        samples: [{ formationTimestampMs: 1, features: { feature_a: null }, prediction }],
      }));
      expect(verifyPythonRuntimeParity(artifact, fixture)).toBe(true);

      const tampered = JSON.parse(JSON.stringify(prediction)) as typeof prediction;
      tampered.pathProbabilities.PERSISTENT_UP += 0.01;
      writeFileSync(fixture, JSON.stringify({
        schemaVersion: 1,
        artifactVersion: artifact.version,
        featureNames: artifact.featureNames,
        samples: [{ formationTimestampMs: 1, features: { feature_a: null }, prediction: tampered }],
      }));
      expect(verifyPythonRuntimeParity(artifact, fixture)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires fresh completed price watermarks but treats future optional sources as optional", () => {
    const now = 1_770_000_000_000;
    expect(continuationCollectorIntegrityGate(healthyCollector(now), now).passed).toBe(true);
    const stale = healthyCollector(now);
    stale.sourceSummary["binance-usdm:kline_5m"]!.freshness = "GAPPED";
    expect(continuationCollectorIntegrityGate(stale, now).passed).toBe(false);
  });

  it("keeps the newest 36-hour outcome window in PENDING_LABEL and never marks it mature", () => {
    const now = 1_770_000_000_000;
    const commonCompleted = now - 3_600_000;
    const maturation = deriveContinuationLabelMaturation(commonCompleted, now);
    expect(maturation.state).toBe("PENDING_LABEL");
    expect(maturation.latestMatureFormationTimestampMs).toBe(now - 37 * 3_600_000);
    expect(maturation.pendingLabelFromTimestampMs).toBe((maturation.latestMatureFormationTimestampMs ?? 0) + 3_600_000);
    expect(deriveContinuationLabelMaturation(null, now).state).toBe("UNAVAILABLE");
  });

  it("allows exactly one training authority at a time", () => {
    const directory = mkdtempSync(join(tmpdir(), "continuation-lock-"));
    try {
      const paths = continuationLifecyclePaths(directory);
      const first = acquireContinuationLock("training", paths, 1_770_000_000_000);
      expect(first).not.toBeNull();
      expect(acquireContinuationLock("training", paths, 1_770_000_000_001)).toBeNull();
      first?.release();
      const replacement = acquireContinuationLock("training", paths, 1_770_000_000_002);
      expect(replacement).not.toBeNull();
      replacement?.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a bounded resource snapshot without changing any trading state", () => {
    const resource = continuationResourceSnapshot(continuationLifecyclePaths(process.cwd()), Date.now());
    expect(resource.threads).toBe(2);
    expect(resource.processId).toBe(process.pid);
    expect(typeof resource.safe).toBe("boolean");
  });
});

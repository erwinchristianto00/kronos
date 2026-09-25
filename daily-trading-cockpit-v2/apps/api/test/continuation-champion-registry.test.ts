import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapChampion,
  promoteChampion,
  readApprovedChampionArtifact,
  readChampionPointer,
  rollbackChampion,
} from "../src/lib/continuation-champion-registry.js";
import { continuationLifecyclePaths } from "../src/lib/continuation-lifecycle.js";
import { dynamicMom36ContinuationArtifactStatus } from "../src/lib/dynamic-mom36-continuation-runtime.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leaf(value = 0) {
  return {
    featureIdx: [-1], threshold: [0], missingGoToLeft: [0], left: [0], right: [0], isLeaf: [1], value: [value],
  };
}

function artifact(version: string, trainedAt = "2026-08-26T00:00:00.000Z") {
  const scalar = () => ({ kind: "identity", baseline: 0, trees: [leaf()] });
  const specialist = () => ({
    cls: {
      kind: "softmax",
      classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"],
      perClass: [0, 1, 2].map(() => ({ baseline: 0, trees: [leaf()] })),
    },
    mean: scalar(), q10: scalar(), q50: scalar(), q90: scalar(), vol: scalar(),
  });
  return {
    version,
    schemaVersion: 4,
    trainedAt,
    horizonBars: 36,
    horizons: [6, 12, 24, 36],
    trainingPopulation: "ADMISSION_CONDITIONED",
    featureNames: ["feature_a"],
    trajectoryFeatureNames: Array.from({ length: 40 }, (_, index) => `trajectory_${index}`),
    classes: ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"],
    pathClasses: [
      "PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL",
      "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION",
    ],
    zBoundary: 0.5,
    calibrationTemperature: 1.1,
    trainRows: 1000,
    trainSpan: { fromMs: 1_700_000_000_000, toMs: 1_700_100_000_000 },
    specialists: { "6": specialist(), "12": specialist(), "24": specialist(), "36": specialist() },
    trajectory: {
      cls: {
        kind: "softmax",
        classes: [
          "PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL",
          "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION",
        ],
        perClass: Array.from({ length: 8 }, () => ({ baseline: 0, trees: [leaf()] })),
      },
    },
  };
}

function fixture(name: string, body: unknown): { root: string; paths: ReturnType<typeof continuationLifecyclePaths>; file: string } {
  const root = mkdtempSync(join(tmpdir(), `continuation-registry-${name}-`));
  dirs.push(root);
  const paths = continuationLifecyclePaths(root);
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return { root, paths, file };
}

describe("continuation champion registry", () => {
  it("bootstraps one immutable V4 champion and exposes it to the runtime pointer reader", () => {
    const f = fixture("bootstrap", artifact("dm-test-bootstrap"));
    const pointer = bootstrapChampion({ file: f.file, nowMs: 1_770_000_000_000 }, f.paths);
    const loaded = readApprovedChampionArtifact(f.paths);

    expect(pointer.current.version).toBe("dm-test-bootstrap");
    expect(pointer.previous).toBeNull();
    expect(loaded.artifact?.source).toBe("REGISTRY_CURRENT");
    expect(loaded.artifact?.record.artifactId).toBe(pointer.current.artifactId);

    const status = dynamicMom36ContinuationArtifactStatus({ CONTINUATION_LIFECYCLE_ROOT: f.root });
    expect(status).toMatchObject({ available: true, source: "REGISTRY_CURRENT", artifactId: pointer.current.artifactId });
  });

  it("publishes a promotion atomically and retains the complete previous champion", () => {
    const first = fixture("first", artifact("dm-test-one"));
    const second = join(first.root, "second.json");
    writeFileSync(second, JSON.stringify(artifact("dm-test-two", "2026-08-27T00:00:00.000Z")));
    const initial = bootstrapChampion({ file: first.file, nowMs: 1_770_000_000_000 }, first.paths);
    const promoted = promoteChampion({ file: second, nowMs: 1_770_010_000_000 }, "test_promotion", first.paths);

    expect(promoted.current.version).toBe("dm-test-two");
    expect(promoted.previous?.artifactId).toBe(initial.current.artifactId);
    expect(readApprovedChampionArtifact(first.paths).artifact?.record.version).toBe("dm-test-two");
  });

  it("fails over read-only to previous champion when a promoted artifact becomes corrupt", () => {
    const f = fixture("corrupt", artifact("dm-test-one"));
    const candidate = join(f.root, "candidate.json");
    writeFileSync(candidate, JSON.stringify(artifact("dm-test-two", "2026-08-27T00:00:00.000Z")));
    const initial = bootstrapChampion({ file: f.file }, f.paths);
    const promoted = promoteChampion({ file: candidate }, "test_promotion", f.paths);
    writeFileSync(join(f.paths.registry, promoted.current.relativePath), "{broken");

    const loaded = readApprovedChampionArtifact(f.paths);
    expect(loaded.artifact?.source).toBe("REGISTRY_PREVIOUS");
    expect(loaded.artifact?.record.artifactId).toBe(initial.current.artifactId);
    expect(loaded.reason).toContain("current_unavailable");
  });

  it("refuses a registry artifact whose frozen label semantics do not match V4", () => {
    const f = fixture("label-schema", artifact("dm-test-label"));
    bootstrapChampion({ file: f.file, labelVersion: "different-label-contract" }, f.paths);

    const status = dynamicMom36ContinuationArtifactStatus({ CONTINUATION_LIFECYCLE_ROOT: f.root });
    expect(status).toMatchObject({ available: false, source: "BOOTSTRAP_PINNED" });
    expect(status.warning).toContain("registry_schema_incompatible");
  });

  it("rollback swaps only the pointer, never rewrites historic artifacts", () => {
    const f = fixture("rollback", artifact("dm-test-one"));
    const candidate = join(f.root, "candidate.json");
    writeFileSync(candidate, JSON.stringify(artifact("dm-test-two", "2026-08-27T00:00:00.000Z")));
    const initial = bootstrapChampion({ file: f.file }, f.paths);
    promoteChampion({ file: candidate }, "test_promotion", f.paths);
    const rolledBack = rollbackChampion("test_rollback", f.paths);

    expect(rolledBack?.current.artifactId).toBe(initial.current.artifactId);
    expect(rolledBack?.previous?.version).toBe("dm-test-two");
    expect(readChampionPointer(f.paths)?.updateReason).toBe("test_rollback");
    expect(readApprovedChampionArtifact(f.paths).artifact?.record.version).toBe("dm-test-one");
  });
});

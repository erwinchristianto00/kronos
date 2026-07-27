import { describe, expect, it } from "vitest";
import {
  cortexLearningEpoch,
  filterCortexLearningEpochRows,
} from "../src/lib/cortex-learning-epoch.js";

describe("cortexLearningEpoch", () => {
  it("is disabled when the env is absent or invalid", () => {
    expect(cortexLearningEpoch({})).toBeNull();
    expect(cortexLearningEpoch({ CORTEX_LEARNING_EPOCH_START_ISO: "invalid" })).toBeNull();
  });

  it("normalizes a valid boundary to UTC", () => {
    expect(
      cortexLearningEpoch({
        CORTEX_LEARNING_EPOCH_START_ISO: "2026-07-27T13:02:54+08:00",
      }),
    ).toEqual({
      id: "POST_LINEAGE_V2",
      startIso: "2026-07-27T05:02:54.000Z",
      startMs: Date.parse("2026-07-27T05:02:54.000Z"),
    });
  });

  it("keeps only decisions and positions whose causal start is on/after the epoch", () => {
    const startMs = Date.parse("2026-07-27T05:02:54.000Z");
    const epoch = cortexLearningEpoch({
      CORTEX_LEARNING_EPOCH_START_ISO: "2026-07-27T05:02:54.000Z",
    });
    const result = filterCortexLearningEpochRows(
      [{ id: "old", atMs: startMs - 1 }, { id: "new", atMs: startMs }],
      [
        { id: "transition", openedAtMs: startMs - 1, resolvedAtMs: startMs + 10 },
        { id: "new", openedAtMs: startMs, resolvedAtMs: startMs + 10 },
      ],
      epoch,
    );
    expect(result.decisions.map((row) => row.id)).toEqual(["new"]);
    expect(result.outcomes.map((row) => row.id)).toEqual(["new"]);
    expect(result.decisionRowsExcluded).toBe(1);
    expect(result.transitionalOutcomesExcluded).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  cortexLearningEpoch,
  filterCortexLearningEpochRows,
  resolveCortexLearningEpoch,
} from "../src/lib/cortex-learning-epoch.js";

/** Every case pins `nowMs` explicitly. The two pre-existing cases below used a 2026-07-27T05:02:54Z
 *  boundary and no clock, so once the future-boundary guard exists their result depends on when the
 *  suite happens to run — passing before that instant and failing after. A test whose verdict turns
 *  on the wall clock cannot pin the guard it is meant to pin. */
const NOW = Date.parse("2026-07-27T03:47:00.000Z");

describe("cortexLearningEpoch", () => {
  it("is disabled when the env is absent or invalid", () => {
    expect(cortexLearningEpoch({}, NOW)).toBeNull();
    expect(cortexLearningEpoch({ CORTEX_LEARNING_EPOCH_START_ISO: "invalid" }, NOW)).toBeNull();
  });

  it("normalizes a valid boundary to UTC", () => {
    expect(
      cortexLearningEpoch({ CORTEX_LEARNING_EPOCH_START_ISO: "2026-07-27T11:02:54+08:00" }, NOW),
    ).toEqual({
      id: "POST_LINEAGE_V2",
      startIso: "2026-07-27T03:02:54.000Z",
      startMs: Date.parse("2026-07-27T03:02:54.000Z"),
    });
  });

  it("keeps only decisions and positions whose causal start is on/after the epoch", () => {
    const startMs = Date.parse("2026-07-27T03:02:54.000Z");
    const epoch = cortexLearningEpoch(
      { CORTEX_LEARNING_EPOCH_START_ISO: "2026-07-27T03:02:54.000Z" },
      NOW,
    );
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

describe("cortexLearningEpoch — future-boundary guard (2026-07-27 incident)", () => {
  /** The real incident: the boundary was written from a 13:02:54+08:00 wall clock (→ 05:02:54Z)
   *  while the deploy it was meant to mark happened at 03:02:54Z. Both 3101 and 3102 ran ~75
   *  minutes with a boundary ahead of their own clock. */
  const FUTURE_ENV = { CORTEX_LEARNING_EPOCH_START_ISO: "2026-07-27T05:02:54.000Z" };

  it("refuses a boundary ahead of the clock and reports how far ahead", () => {
    const { epoch, rejection } = resolveCortexLearningEpoch(FUTURE_ENV, NOW);
    expect(epoch).toBeNull();
    expect(rejection).toEqual({
      reason: "IN_FUTURE",
      raw: "2026-07-27T05:02:54.000Z",
      startMs: Date.parse("2026-07-27T05:02:54.000Z"),
      nowMs: NOW,
      aheadMs: Date.parse("2026-07-27T05:02:54.000Z") - NOW,
    });
    expect(rejection?.aheadMs).toBe(75 * 60_000 + 54_000);
  });

  /** FAILS WITHOUT THE FIX — the whole point of the guard.
   *
   *  Before it, the future boundary was applied and `startMs > every row`, so BOTH lists came back
   *  empty and CORTEX trained on nothing while readiness showed a plausible 0%. This asserts the
   *  opposite failure mode: refusing the boundary filters NOTHING, so the meter keeps its historical
   *  value and the discrepancy is visible instead of silent. */
  it("filters nothing when the boundary is refused, so the failure is loud rather than silent", () => {
    const epoch = cortexLearningEpoch(FUTURE_ENV, NOW);
    const decisions = [{ id: "a", atMs: NOW - 10_000 }, { id: "b", atMs: NOW - 1 }];
    const outcomes = [{ id: "a", openedAtMs: NOW - 10_000, resolvedAtMs: NOW - 5_000 }];

    const result = filterCortexLearningEpochRows(decisions, outcomes, epoch);

    expect(result.decisions.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.outcomes.map((r) => r.id)).toEqual(["a"]);
    expect(result.decisionRowsExcluded).toBe(0);
    expect(result.transitionalOutcomesExcluded).toBe(0);
  });

  it("accepts a boundary exactly at the clock — the guard is strictly-ahead, not ahead-or-equal", () => {
    const at = "2026-07-27T03:47:00.000Z";
    const { epoch, rejection } = resolveCortexLearningEpoch(
      { CORTEX_LEARNING_EPOCH_START_ISO: at },
      NOW,
    );
    expect(rejection).toBeNull();
    expect(epoch?.startMs).toBe(NOW);
  });

  it("accepts a boundary one millisecond in the past", () => {
    const { epoch, rejection } = resolveCortexLearningEpoch(
      { CORTEX_LEARNING_EPOCH_START_ISO: new Date(NOW - 1).toISOString() },
      NOW,
    );
    expect(rejection).toBeNull();
    expect(epoch?.startMs).toBe(NOW - 1);
  });

  it("separates MALFORMED from IN_FUTURE, and both from 'no boundary configured'", () => {
    expect(resolveCortexLearningEpoch({}, NOW)).toEqual({ epoch: null, rejection: null });

    const malformed = resolveCortexLearningEpoch(
      { CORTEX_LEARNING_EPOCH_START_ISO: "not-a-date" },
      NOW,
    );
    expect(malformed.epoch).toBeNull();
    expect(malformed.rejection).toEqual({
      reason: "MALFORMED",
      raw: "not-a-date",
      startMs: null,
      nowMs: NOW,
      aheadMs: null,
    });
  });

  /** An unset boundary and a refused one both yield `epoch: null`, so the meter looks identical.
   *  Only `rejection` tells them apart, which is why it is carried into the readiness payload
   *  rather than written to a log nobody reads. */
  it("makes 'unset' and 'refused' distinguishable despite both disabling the filter", () => {
    const unset = resolveCortexLearningEpoch({}, NOW);
    const refused = resolveCortexLearningEpoch(FUTURE_ENV, NOW);
    expect(unset.epoch).toBeNull();
    expect(refused.epoch).toBeNull();
    expect(unset.rejection).toBeNull();
    expect(refused.rejection).not.toBeNull();
  });
});

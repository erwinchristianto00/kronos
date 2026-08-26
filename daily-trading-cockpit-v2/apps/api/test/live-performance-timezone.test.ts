import { describe, expect, it } from "vitest";

import { performanceWindow } from "../src/lib/live-execution-engine.js";
import { mergeDailyRangeIntoLaneSeries } from "../src/routes/live.js";
import type { DailyRangeAcceptanceLane } from "../src/lib/daily-4h-range-acceptance-lane.js";

describe("performanceWindow — Asia/Taipei", () => {
  it("maps a selected Taipei day to its true UTC boundary without changing the UTC default", () => {
    const taipei = performanceWindow({
      view: "hourly",
      anchor: "2026-08-27",
      nowMs: Date.parse("2026-08-27T03:00:00.000Z"),
      timeZone: "Asia/Taipei",
    });
    const utc = performanceWindow({
      view: "hourly",
      anchor: "2026-08-27",
      nowMs: Date.parse("2026-08-27T03:00:00.000Z"),
      timeZone: "UTC",
    });

    expect(new Date(taipei.sinceMs).toISOString()).toBe("2026-08-26T16:00:00.000Z");
    expect(new Date(taipei.untilMs).toISOString()).toBe("2026-08-27T16:00:00.000Z");
    expect(new Date(taipei.bucketStartsMs[0]!).toISOString()).toBe("2026-08-26T16:00:00.000Z");
    expect(new Date(utc.sinceMs).toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });
});

describe("mergeDailyRangeIntoLaneSeries", () => {
  it("adds Daily Range closed fills to the same selected performance timeline", () => {
    const report = {
      view: "hourly",
      period: "fixed",
      viewLabel: "Hourly",
      periodLabel: "2026-08-27",
      bucketLabel: "24 hourly buckets",
      bucketMs: 3_600_000,
      since: "2026-08-26T16:00:00.000Z",
      until: "2026-08-27T16:00:00.000Z",
      anchor: "2026-08-27",
      timeZone: "Asia/Taipei",
      regimeFilter: "all",
      regimeOptions: [],
      bucketStarts: ["2026-08-26T16:00:00.000Z", "2026-08-26T17:00:00.000Z"],
      lanes: [],
    } as never;
    const lane = {
      history: () => [{
        status: "CLOSED",
        symbol: "OPUSDT",
        exitTimestamp: "2026-08-26T16:05:00.000Z",
        netPnlUsd: 0.25,
        feesUsd: 0.02,
      }],
    } as unknown as DailyRangeAcceptanceLane;

    const merged = mergeDailyRangeIntoLaneSeries(report, lane) as {
      lanes: Array<{
        laneId: string;
        realizedPnlUsd: number;
        feesUsd: number;
        closedCount: number;
        lastClosedAt: string | null;
        points: Array<{ bucketStart: string; realizedPnlUsd: number; cumulativePnlUsd: number }>;
      }>;
    };
    const daily = merged.lanes.find((row) => row.laneId === "DAILY_4H_RANGE_ACCEPTANCE");

    expect(daily).toMatchObject({
      realizedPnlUsd: 0.25,
      feesUsd: 0.02,
      closedCount: 1,
      lastClosedAt: "2026-08-26T16:05:00.000Z",
    });
    expect(daily?.points).toMatchObject([
      { bucketStart: "2026-08-26T16:00:00.000Z", realizedPnlUsd: 0.25, cumulativePnlUsd: 0.25 },
      { bucketStart: "2026-08-26T17:00:00.000Z", realizedPnlUsd: 0, cumulativePnlUsd: 0.25 },
    ]);
  });
});

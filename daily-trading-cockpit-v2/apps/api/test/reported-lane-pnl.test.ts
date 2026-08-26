import { describe, expect, it } from "vitest";

import { summarizeReportedLanePnl } from "../src/lib/reported-lane-pnl.js";

describe("summarizeReportedLanePnl", () => {
  it("uses the same actual Taipei close day for basket, Daily Range, and single-symbol books", () => {
    const summary = summarizeReportedLanePnl([
      // 23:57 Taipei on 26 Aug: all-time only when the dashboard is viewed on 27 Aug.
      { category: "BASKETS", closedAt: "2026-08-26T15:57:00.000Z", netPnlUsd: 0.114 },
      // 00:05 Taipei on 27 Aug: this is today, despite still being 26 Aug in UTC.
      { category: "DAILY_RANGE", closedAt: "2026-08-26T16:05:00.000Z", netPnlUsd: -0.1 },
      { category: "SINGLE_SYMBOL", closedAt: "2026-08-27T00:00:00.000Z", netPnlUsd: 0.2 },
    ], Date.parse("2026-08-27T03:00:00.000Z"));

    expect(summary).toMatchObject({
      timeZone: "Asia/Taipei",
      closeDateTaipei: "2026-08-27",
      today: {
        baskets: 0,
        dailyRange: -0.1,
        singleSymbol: 0.2,
        total: 0.1,
        closedCount: 2,
      },
      allTime: {
        baskets: 0.114,
        dailyRange: -0.1,
        singleSymbol: 0.2,
        closedCount: 3,
      },
    });
    expect(summary?.allTime.total).toBeCloseTo(0.214, 12);
  });

  it("does not turn an unavailable close timestamp or P&L into a zero result", () => {
    const summary = summarizeReportedLanePnl([
      { category: "DAILY_RANGE", closedAt: null, netPnlUsd: 7 },
      { category: "BASKETS", closedAt: "not-a-date", netPnlUsd: 8 },
      { category: "SINGLE_SYMBOL", closedAt: "2026-08-27T00:00:00.000Z", netPnlUsd: null },
    ], Date.parse("2026-08-27T03:00:00.000Z"));

    expect(summary?.today).toEqual({ baskets: 0, dailyRange: 0, singleSymbol: 0, total: 0, closedCount: 0 });
    expect(summary?.allTime).toEqual({ baskets: 0, dailyRange: 0, singleSymbol: 0, total: 0, closedCount: 0 });
  });
});

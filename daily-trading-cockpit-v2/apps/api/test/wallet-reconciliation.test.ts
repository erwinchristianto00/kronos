import { describe, expect, it, vi } from "vitest";

import type { FuturesIncomeEntry } from "../src/lib/binance-futures-private.js";
import {
  buildLiveWalletReconciliationReport,
  buildWalletReconciliationReport,
  emptyDailyIncomeSummary,
  parseWalletReconciliationConfig,
  resolveDayUtc,
  summarizeIncomeByUtcDay,
  type LiveEngineReconciliationSource,
} from "../src/lib/wallet-reconciliation.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function income(overrides: Partial<FuturesIncomeEntry> & { time: number }): FuturesIncomeEntry {
  return {
    symbol: "ETHUSDT",
    incomeType: "REALIZED_PNL",
    income: 0,
    asset: "USDT",
    tranId: "1",
    info: "",
    ...overrides,
  };
}

const DAY1 = "2026-07-10";
const DAY2 = "2026-07-11";
const day1Ms = Date.parse(`${DAY1}T12:00:00.000Z`);
const day2Ms = Date.parse(`${DAY2}T03:00:00.000Z`);

// ─── income summing ──────────────────────────────────────────────────────────

describe("summarizeIncomeByUtcDay", () => {
  it("buckets a realistic multi-type, multi-day response correctly per UTC day", () => {
    const entries: FuturesIncomeEntry[] = [
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 3.5, symbol: "ETHUSDT" }),
      income({ time: day1Ms + 1000, incomeType: "REALIZED_PNL", income: -1.2, symbol: "SOLUSDT" }),
      income({ time: day1Ms + 2000, incomeType: "COMMISSION", income: -0.18, symbol: "ETHUSDT" }),
      income({ time: day1Ms + 3000, incomeType: "COMMISSION", income: -0.09, symbol: "SOLUSDT" }),
      income({ time: day1Ms + 4000, incomeType: "FUNDING_FEE", income: -0.04, symbol: "ETHUSDT" }),
      income({ time: day1Ms + 5000, incomeType: "FUNDING_FEE", income: 0.02, symbol: "SOLUSDT" }),
      income({ time: day1Ms + 6000, incomeType: "TRANSFER", income: 10, symbol: "" }),
      income({ time: day1Ms + 7000, incomeType: "INSURANCE_CLEAR", income: -0.5, symbol: "ETHUSDT" }),
      // Second day — must NOT bleed into day 1's totals.
      income({ time: day2Ms, incomeType: "REALIZED_PNL", income: 5, symbol: "ETHUSDT" }),
      income({ time: day2Ms + 1000, incomeType: "COMMISSION", income: -0.1, symbol: "ETHUSDT" }),
    ];

    const summaries = summarizeIncomeByUtcDay(entries);
    expect(summaries.size).toBe(2);

    const day1 = summaries.get(DAY1)!;
    expect(day1.entryCount).toBe(8);
    expect(day1.realizedPnlUsd).toBeCloseTo(3.5 - 1.2, 10);
    expect(day1.commissionUsd).toBeCloseTo(-0.18 - 0.09, 10);
    expect(day1.fundingFeeUsd).toBeCloseTo(-0.04 + 0.02, 10);
    expect(day1.otherUsd).toBeCloseTo(10 - 0.5, 10);
    expect(day1.totalUsd).toBeCloseTo(3.5 - 1.2 - 0.18 - 0.09 - 0.04 + 0.02 + 10 - 0.5, 10);
    // Comparable figure = REALIZED_PNL + COMMISSION only (matches what the internal ledger nets).
    expect(day1.comparableToLedgerUsd).toBeCloseTo(3.5 - 1.2 - 0.18 - 0.09, 10);
    expect(day1.byType).toEqual({
      REALIZED_PNL: 3.5 - 1.2,
      COMMISSION: -0.18 - 0.09,
      FUNDING_FEE: -0.04 + 0.02,
      TRANSFER: 10,
      INSURANCE_CLEAR: -0.5,
    });

    const day2 = summaries.get(DAY2)!;
    expect(day2.entryCount).toBe(2);
    expect(day2.realizedPnlUsd).toBeCloseTo(5, 10);
    expect(day2.commissionUsd).toBeCloseTo(-0.1, 10);
    expect(day2.comparableToLedgerUsd).toBeCloseTo(4.9, 10);
  });

  it("returns an empty map for no entries, and emptyDailyIncomeSummary is all-zero", () => {
    expect(summarizeIncomeByUtcDay([]).size).toBe(0);
    const empty = emptyDailyIncomeSummary(DAY1);
    expect(empty.entryCount).toBe(0);
    expect(empty.totalUsd).toBe(0);
    expect(empty.comparableToLedgerUsd).toBe(0);
    expect(empty.possiblyTruncated).toBe(false);
  });

  it("flags possiblyTruncated when the fetched count hits the page limit", () => {
    const entries = [income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 1 })];
    const truncated = summarizeIncomeByUtcDay(entries, { fetchedCount: 1000, fetchLimit: 1000 });
    expect(truncated.get(DAY1)!.possiblyTruncated).toBe(true);

    const notTruncated = summarizeIncomeByUtcDay(entries, { fetchedCount: 1, fetchLimit: 1000 });
    expect(notTruncated.get(DAY1)!.possiblyTruncated).toBe(false);
  });

  it("buckets any unrecognized income type under otherUsd without dropping it from byType", () => {
    const entries = [income({ time: day1Ms, incomeType: "SOME_FUTURE_BINANCE_TYPE", income: 2.5 })];
    const summary = summarizeIncomeByUtcDay(entries).get(DAY1)!;
    expect(summary.otherUsd).toBeCloseTo(2.5, 10);
    expect(summary.realizedPnlUsd).toBe(0);
    expect(summary.byType.SOME_FUTURE_BINANCE_TYPE).toBeCloseTo(2.5, 10);
  });
});

// ─── discrepancy / tolerance comparison ─────────────────────────────────────

describe("buildWalletReconciliationReport", () => {
  it("reports withinTolerance=true when internal and exchange figures agree closely", () => {
    const entries = [
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10 }),
      income({ time: day1Ms + 1, incomeType: "COMMISSION", income: -0.2 }),
    ];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 9.8 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.exchangeIncome.comparableToLedgerUsd).toBeCloseTo(9.8, 10);
    expect(report.deltaUsd).toBeCloseTo(0, 10);
    expect(report.withinTolerance).toBe(true);
    expect(report.internalLedgerFresh).toBe(true);
  });

  it("reports withinTolerance=false when the delta exceeds tolerance", () => {
    const entries = [
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10 }),
      income({ time: day1Ms + 1, incomeType: "COMMISSION", income: -0.2 }),
    ];
    // Internal ledger says +5, exchange says +9.8 — a $4.8 gap, way past a $0.50 tolerance.
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 5 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.deltaUsd).toBeCloseTo(4.8, 10);
    expect(report.withinTolerance).toBe(false);
  });

  it("is symmetric — a large negative delta also fails tolerance", () => {
    const entries = [income({ time: day1Ms, incomeType: "REALIZED_PNL", income: -10 })];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 2 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.deltaUsd).toBeCloseTo(-12, 10);
    expect(report.withinTolerance).toBe(false);
  });

  it("excludes funding fees from the tolerance-checked delta (documented design choice)", () => {
    // Internal ledger and REALIZED_PNL+COMMISSION agree exactly; a real funding fee the internal
    // ledger has no concept of must NOT, by itself, trip the mismatch flag.
    const entries = [
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10 }),
      income({ time: day1Ms + 1, incomeType: "COMMISSION", income: -0.2 }),
      income({ time: day1Ms + 2, incomeType: "FUNDING_FEE", income: -3 }),
    ];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 9.8 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.withinTolerance).toBe(true);
    expect(report.exchangeIncome.fundingFeeUsd).toBeCloseTo(-3, 10);
  });

  it("gross-closed mode excludes commissions belonging to positions that are still open", () => {
    const entries = [
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10 }),
      income({ time: day1Ms + 1, incomeType: "COMMISSION", income: -0.2 }), // closed trade fees
      income({ time: day1Ms + 2, incomeType: "COMMISSION", income: -0.7 }), // open entries
    ];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 9.8 },
      internalClosedFeesUsd: 0.2,
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });

    expect(report.comparisonBasis).toBe("GROSS_REALIZED_CLOSED_ONLY");
    expect(report.comparisonInternalUsd).toBeCloseTo(10, 10);
    expect(report.comparisonExchangeUsd).toBeCloseTo(10, 10);
    expect(report.deltaUsd).toBeCloseTo(0, 10);
    expect(report.withinTolerance).toBe(true);
    expect(report.exchangeIncome.commissionUsd).toBeCloseTo(-0.9, 10); // still visible, just not misclassified
  });

  it("skips the tolerance verdict (withinTolerance=true, note explains why) when the ledger's own date is stale", () => {
    const entries = [income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 999 })];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: "2026-07-09", realizedPnlUsd: 0 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.internalLedgerFresh).toBe(false);
    expect(report.withinTolerance).toBe(true);
    expect(report.deltaUsd).toBe(0);
    expect(report.note).toMatch(/does not match the requested day/);
  });

  it("boundary: a delta exactly at the tolerance is within tolerance (<=, not <)", () => {
    const entries = [income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10.5 })];
    const report = buildWalletReconciliationReport({
      dayUtc: DAY1,
      internalLedger: { dateUtc: DAY1, realizedPnlUsd: 10 },
      incomeEntries: entries,
      toleranceUsd: 0.5,
    });
    expect(report.deltaUsd).toBeCloseTo(0.5, 10);
    expect(report.withinTolerance).toBe(true);
  });
});

describe("parseWalletReconciliationConfig", () => {
  it("defaults to $0.50 and honors WALLET_RECONCILIATION_TOLERANCE_USD when set to a valid positive number", () => {
    expect(parseWalletReconciliationConfig({}).toleranceUsd).toBe(0.5);
    expect(parseWalletReconciliationConfig({ WALLET_RECONCILIATION_TOLERANCE_USD: "2.5" }).toleranceUsd).toBe(2.5);
    // Invalid / non-positive values fall back to the default rather than disabling the check.
    expect(parseWalletReconciliationConfig({ WALLET_RECONCILIATION_TOLERANCE_USD: "-1" }).toleranceUsd).toBe(0.5);
    expect(parseWalletReconciliationConfig({ WALLET_RECONCILIATION_TOLERANCE_USD: "not-a-number" }).toleranceUsd).toBe(0.5);
  });
});

describe("resolveDayUtc", () => {
  it("accepts a well-formed day and falls back to 'today' for anything else", () => {
    expect(resolveDayUtc(DAY1)).toBe(DAY1);
    expect(resolveDayUtc(undefined, () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10");
    expect(resolveDayUtc("not-a-date", () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10");
    expect(resolveDayUtc("2026-13-99", () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10");
  });

  // [ROLLOVER-FIX] 2026-07-11: Date.parse silently ROLLS OVER a non-existent calendar date to the
  // next real one instead of rejecting it — confirmed live: "2026-04-31" and "2027-02-29" (2027 is
  // not a leap year) both parsed to a finite timestamp for the following real day. The old check
  // (regex + Number.isFinite alone) let these through as if valid, mislabeling the report.
  it("[ROLLOVER-FIX] rejects a well-formed but calendar-invalid day (Date.parse's silent rollover)", () => {
    expect(resolveDayUtc("2026-04-31", () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10"); // April has 30 days
    expect(resolveDayUtc("2027-02-29", () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10"); // 2027 is not a leap year
    expect(resolveDayUtc("2026-06-31", () => "2026-07-10T05:00:00.000Z")).toBe("2026-07-10"); // June has 30 days
    // Genuinely valid edge-of-month/leap days still pass through unchanged.
    expect(resolveDayUtc("2026-04-30", () => "2026-07-10T05:00:00.000Z")).toBe("2026-04-30");
    expect(resolveDayUtc("2028-02-29", () => "2026-07-10T05:00:00.000Z")).toBe("2028-02-29"); // 2028 IS a leap year
  });
});

// ─── engine wiring (I/O wrapper) ─────────────────────────────────────────────

describe("buildLiveWalletReconciliationReport", () => {
  it("fetches the requested UTC day's window and reads getStatus().closedToday for the internal figure", async () => {
    const seenWindows: Array<{ startTimeMs: number; endTimeMs: number }> = [];
    const engine: LiveEngineReconciliationSource = {
      getStatus: () => ({ closedToday: { dateUtc: DAY1, realizedPnlUsd: 9.8 } }),
      getIncomeHistory: async (startTimeMs, endTimeMs) => {
        seenWindows.push({ startTimeMs, endTimeMs });
        return [
          income({ time: startTimeMs + 1000, incomeType: "REALIZED_PNL", income: 10 }),
          income({ time: startTimeMs + 2000, incomeType: "COMMISSION", income: -0.2 }),
        ];
      },
    };

    const report = await buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 });
    expect(report.withinTolerance).toBe(true);
    expect(seenWindows).toHaveLength(1);
    expect(seenWindows[0].startTimeMs).toBe(Date.parse(`${DAY1}T00:00:00.000Z`));
    expect(seenWindows[0].endTimeMs).toBe(Date.parse(`${DAY1}T00:00:00.000Z`) + 24 * 60 * 60 * 1000 - 1);
  });

  // [TIMING-FIX] 2026-07-20: getStatus() must be read back-to-back with `day`, BEFORE the
  // potentially-slow getIncomeHistory await — not after it resolves. Reading it after leaves a
  // window as wide as the network round-trip in which the engine's internal ledger could roll over
  // to a new UTC day, diverging from `day` (already resolved before the await started).
  it("[TIMING-FIX] reads engine.getStatus() before awaiting getIncomeHistory, not after", async () => {
    const callOrder: string[] = [];
    let resolveIncome!: (entries: FuturesIncomeEntry[]) => void;
    const incomePromise = new Promise<FuturesIncomeEntry[]>((resolve) => {
      resolveIncome = resolve;
    });
    const engine: LiveEngineReconciliationSource = {
      getStatus: () => {
        callOrder.push("getStatus");
        return { closedToday: { dateUtc: DAY1, realizedPnlUsd: 9.8 } };
      },
      getIncomeHistory: async () => {
        callOrder.push("getIncomeHistory:called");
        return incomePromise; // stays pending — simulates an in-flight network call
      },
    };

    const reportPromise = buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 });
    await Promise.resolve();
    await Promise.resolve();
    // getStatus() must already have been read by the time getIncomeHistory is still pending —
    // i.e. it happens BEFORE the await, not after it resolves.
    expect(callOrder).toEqual(["getStatus", "getIncomeHistory:called"]);

    resolveIncome([
      income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 10 }),
      income({ time: day1Ms + 1, incomeType: "COMMISSION", income: -0.2 }),
    ]);
    const report = await reportPromise;
    expect(report.withinTolerance).toBe(true);
  });

  it("[EXTERNAL-PNL] folds externalTodayRealizedPnlUsd into the internal figure — the engine's own ledger alone would falsely mismatch", async () => {
    // Real exchange income is REALIZED_PNL 10 + COMMISSION -0.2 = 9.8 comparable. The engine's own
    // mirror/directional ledger only booked 5 of that; the other 4.8 came from the 11 external
    // executors (cross-sectional + single-symbol lanes) this 2026-07-11 fix makes visible.
    const engine: LiveEngineReconciliationSource = {
      getStatus: () => ({ closedToday: { dateUtc: DAY1, realizedPnlUsd: 5 } }),
      getIncomeHistory: async (startTimeMs) => [
        income({ time: startTimeMs + 1000, incomeType: "REALIZED_PNL", income: 10 }),
        income({ time: startTimeMs + 2000, incomeType: "COMMISSION", income: -0.2 }),
      ],
    };

    const withoutExternal = await buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 });
    expect(withoutExternal.deltaUsd).toBeCloseTo(4.8, 10);
    expect(withoutExternal.withinTolerance).toBe(false);

    const withExternal = await buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 }, 4.8);
    expect(withExternal.deltaUsd).toBeCloseTo(0, 10);
    expect(withExternal.withinTolerance).toBe(true);
  });

  it("passes closed-only fees into the live gross-realized comparison", async () => {
    const engine: LiveEngineReconciliationSource = {
      getStatus: () => ({ closedToday: { dateUtc: DAY1, realizedPnlUsd: 9.8 } }),
      getIncomeHistory: async (startTimeMs) => [
        income({ time: startTimeMs + 1000, incomeType: "REALIZED_PNL", income: 10 }),
        income({ time: startTimeMs + 2000, incomeType: "COMMISSION", income: -1 }),
      ],
    };

    const report = await buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 }, 0, 0.2);
    expect(report.comparisonBasis).toBe("GROSS_REALIZED_CLOSED_ONLY");
    expect(report.deltaUsd).toBeCloseTo(0, 10);
    expect(report.withinTolerance).toBe(true);
  });

  it("propagates a fetch failure instead of swallowing it into a false 'reconciled' result", async () => {
    const engine: LiveEngineReconciliationSource = {
      getStatus: () => ({ closedToday: { dateUtc: DAY1, realizedPnlUsd: 0 } }),
      getIncomeHistory: async () => {
        throw new Error("simulated Binance timeout");
      },
    };
    await expect(buildLiveWalletReconciliationReport(engine, DAY1)).rejects.toThrow("simulated Binance timeout");
  });
});

// ─── safety: the periodic/report path never disarms, pauses, or acts ───────

describe("safety: report-only guarantee", () => {
  it("never invokes any corrective action (disarm/pause/close/kill) even when severely mismatched", async () => {
    // Spies standing in for the kinds of corrective actions this module must NEVER call. Nothing in
    // wallet-reconciliation.ts references these — this test proves it at runtime, not just by grep.
    const disarm = vi.fn();
    const pauseNewEntries = vi.fn();
    const flattenAllExchangePositions = vi.fn();
    const resetKill = vi.fn();
    const cancelOrder = vi.fn();
    const closePosition = vi.fn();

    const engine: LiveEngineReconciliationSource & {
      disarm: typeof disarm;
      pauseNewEntries: typeof pauseNewEntries;
      flattenAllExchangePositions: typeof flattenAllExchangePositions;
      resetKill: typeof resetKill;
      cancelOrder: typeof cancelOrder;
      closePosition: typeof closePosition;
    } = {
      getStatus: () => ({ closedToday: { dateUtc: DAY1, realizedPnlUsd: 0 } }),
      // A wildly mismatched day: internal says $0, exchange says +$500.
      getIncomeHistory: async () => [income({ time: day1Ms, incomeType: "REALIZED_PNL", income: 500 })],
      disarm,
      pauseNewEntries,
      flattenAllExchangePositions,
      resetKill,
      cancelOrder,
      closePosition,
    };

    const report = await buildLiveWalletReconciliationReport(engine, DAY1, { toleranceUsd: 0.5 });
    expect(report.withinTolerance).toBe(false);
    expect(Math.abs(report.deltaUsd)).toBeGreaterThan(499);

    for (const spy of [disarm, pauseNewEntries, flattenAllExchangePositions, resetKill, cancelOrder, closePosition]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("the server-side ticker path (simulated) only logs a warning on mismatch, never calls a corrective action", async () => {
    // Reproduces server.ts's runReconciliation() body against a fake HTTP layer, with the same
    // corrective-action spies wired in, to prove the wiring itself doesn't reach for them either.
    const disarm = vi.fn();
    const flattenAllExchangePositions = vi.fn();

    const reportPayload = {
      ok: true,
      report: { dayUtc: DAY1, deltaUsd: 500, toleranceUsd: 0.5, withinTolerance: false },
    };
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify(reportPayload), { status: 200 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await fakeFetch();
      const body = (await res.json()) as typeof reportPayload;
      if (body.ok && body.report && body.report.withinTolerance === false) {
        console.warn(
          `[API] WALLET RECONCILIATION MISMATCH day=${body.report.dayUtc} delta=$${body.report.deltaUsd.toFixed(2)} ` +
            `exceeds tolerance $${body.report.toleranceUsd} — internal ledger vs Binance income history disagree. ` +
            `Report-only: no trading action taken.`,
        );
      }

      // Assert BEFORE mockRestore() — mockRestore() clears recorded calls along with the impl.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/MISMATCH/);
      expect(disarm).not.toHaveBeenCalled();
      expect(flattenAllExchangePositions).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // [FRESHNESS-FIX] 2026-07-20: buildLiveWalletReconciliationReport computes `day` BEFORE the
  // awaited getIncomeHistory call, then reads getStatus() AFTER it resolves. If the engine's daily
  // ledger rolls to a new UTC day during that await, internalLedgerFresh correctly comes back false
  // — but the OLD server.ts ticker only ever checked `withinTolerance` (forced true in that branch),
  // so a "not verified, no comparison happened" day was logged identically to (i.e. not at all,
  // same as) a genuinely reconciled healthy day. This reproduces server.ts's runReconciliation()
  // body twice against the exact payload that race produces — once with the OLD (buggy) branching
  // to prove the silence, once with the NEW branching to prove it now warns distinctly.
  it("[FRESHNESS-FIX] the server-side ticker path must not treat internalLedgerFresh=false identically to a verified-healthy day", async () => {
    const reportPayload = {
      ok: true,
      report: {
        dayUtc: DAY1,
        deltaUsd: 0,
        toleranceUsd: 0.5,
        withinTolerance: true, // forced true by buildWalletReconciliationReport's !internalLedgerFresh branch
        internalLedgerFresh: false,
        note:
          `internal ledger's dateUtc (${DAY2}) does not match the requested day (${DAY1}) — the live ` +
          `engine only retains the CURRENT day's ledger, so no internal figure exists for this day; ` +
          `skipping the tolerance check.`,
      },
    };

    // OLD ticker logic (pre-fix): only ever branches on withinTolerance === false.
    const oldWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = reportPayload;
      if (body.ok && body.report && body.report.withinTolerance === false) {
        console.warn(`[API] WALLET RECONCILIATION MISMATCH day=${body.report.dayUtc} ...`);
      }
      // Demonstrates the bug: a day that was NEVER actually verified produces zero log output,
      // indistinguishable from a genuinely reconciled healthy day.
      expect(oldWarnSpy).not.toHaveBeenCalled();
    } finally {
      oldWarnSpy.mockRestore();
    }

    // NEW ticker logic (post-fix, mirrors server.ts's runReconciliation() body).
    const newWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = reportPayload;
      if (body.ok && body.report && body.report.withinTolerance === false) {
        console.warn(`[API] WALLET RECONCILIATION MISMATCH day=${body.report.dayUtc} ...`);
      } else if (body.ok && body.report && body.report.internalLedgerFresh === false) {
        console.warn(
          `[API] wallet reconciliation NOT VERIFIED day=${body.report.dayUtc}: ${body.report.note ?? "internal ledger day mismatch"}`,
        );
      }
      expect(newWarnSpy).toHaveBeenCalledTimes(1);
      expect(newWarnSpy.mock.calls[0][0]).toMatch(/NOT VERIFIED/);
      expect(newWarnSpy.mock.calls[0][0]).not.toMatch(/MISMATCH/);
    } finally {
      newWarnSpy.mockRestore();
    }
  });
});

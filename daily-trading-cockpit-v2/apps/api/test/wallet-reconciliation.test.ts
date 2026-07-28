import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { FuturesIncomeEntry } from "../src/lib/binance-futures-private.js";
import {
  DEFAULT_TOLERANCE_USD,
  buildWalletReconciliationReport,
  fetchIncomeSummaryForWindow,
  resolveReconciliationToleranceUsd,
  runWalletReconciliationCheck,
  utcDayWindowMs,
  type WalletReconciliationClient,
  type WalletReconciliationLedgerSource,
} from "../src/lib/wallet-reconciliation.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function income(
  incomeType: string,
  income: number,
  time: number,
  overrides: Partial<FuturesIncomeEntry> = {},
): FuturesIncomeEntry {
  return {
    symbol: "ETHUSDT",
    incomeType,
    income,
    asset: "USDT",
    time,
    tranId: Math.floor(Math.random() * 1e9),
    ...overrides,
  };
}

const DAY = "2026-07-09";
const { startMs: DAY_START, endMs: DAY_END } = utcDayWindowMs(DAY);
const PREV_DAY_MS = DAY_START - 60_000; // just before the window — must be excluded
const NEXT_DAY_MS = DAY_END + 60_000; // just after the window — must be excluded

/** A fake client that behaves like real Binance /fapi/v1/income: time-filtered, ascending, limit-capped. */
function fakeClient(all: FuturesIncomeEntry[]): WalletReconciliationClient & { calls: number } {
  const client: WalletReconciliationClient & { calls: number } = {
    calls: 0,
    async getIncomeHistory(opts) {
      client.calls += 1;
      const start = opts.startTime ?? -Infinity;
      const end = opts.endTime ?? Infinity;
      const filtered = all
        .filter((e) => e.time >= start && e.time <= end)
        .sort((a, b) => a.time - b.time);
      return filtered.slice(0, opts.limit ?? 1000);
    },
  };
  return client;
}

function ledgerSource(dateUtc: string, realizedPnlUsd: number, wins = 1, losses = 0): WalletReconciliationLedgerSource {
  return {
    getStatus: () => ({ closedToday: { dateUtc, realizedPnlUsd, wins, losses } }),
  };
}

// ── income summing correctness ────────────────────────────────────────────────

describe("fetchIncomeSummaryForWindow", () => {
  it("buckets a realistic mixed-type response correctly and excludes entries outside the day window", async () => {
    const entries: FuturesIncomeEntry[] = [
      // realistic mixed types for the target day
      income("REALIZED_PNL", 12.34, DAY_START + 1_000),
      income("REALIZED_PNL", -3.1, DAY_START + 2_000),
      income("COMMISSION", -0.42, DAY_START + 1_000),
      income("COMMISSION", -0.11, DAY_START + 2_000),
      income("FUNDING_FEE", -0.87, DAY_START + 3_000),
      income("FUNDING_FEE", 0.05, DAY_START + 4_000),
      income("TRANSFER", 100, DAY_START + 5_000), // operator deposit — not trading income
      income("WELCOME_BONUS", 1, DAY_START + 6_000),
      // adjacent days — must NOT be counted
      income("REALIZED_PNL", 999, PREV_DAY_MS),
      income("REALIZED_PNL", 999, NEXT_DAY_MS),
    ];
    const client = fakeClient(entries);

    const summary = await fetchIncomeSummaryForWindow(client, DAY, DAY_START, DAY_END);

    expect(summary.dateUtc).toBe(DAY);
    expect(summary.entryCount).toBe(8); // the 10 minus the 2 out-of-window
    expect(summary.realizedPnlUsd).toBeCloseTo(12.34 - 3.1, 5);
    expect(summary.commissionUsd).toBeCloseTo(-0.42 - 0.11, 5);
    expect(summary.fundingFeeUsd).toBeCloseTo(-0.87 + 0.05, 5);
    expect(summary.otherUsd).toBeCloseTo(100 + 1, 5);
    expect(summary.otherTypes).toEqual(["TRANSFER", "WELCOME_BONUS"]);
    expect(summary.totalIncomeUsd).toBeCloseTo(12.34 - 3.1 - 0.42 - 0.11 - 0.87 + 0.05 + 100 + 1, 5);
    expect(summary.truncated).toBe(false);
  });

  it("pages forward on time when a page comes back full, and sums every entry across pages", async () => {
    // 1500 REALIZED_PNL rows of $1 each inside the window — forces 2 pages at the 1000 cap.
    const entries: FuturesIncomeEntry[] = Array.from({ length: 1500 }, (_, i) =>
      income("REALIZED_PNL", 1, DAY_START + 1_000 + i, { tranId: i }),
    );
    const client = fakeClient(entries);

    const summary = await fetchIncomeSummaryForWindow(client, DAY, DAY_START, DAY_END);

    expect(summary.entryCount).toBe(1500);
    expect(summary.realizedPnlUsd).toBeCloseTo(1500, 5);
    expect(summary.truncated).toBe(false);
    expect(client.calls).toBe(2);
  });

  it("marks the summary truncated when even the page cap is exhausted (never silently under-reports without a flag)", async () => {
    // 10,001 rows — one more than MAX_INCOME_PAGES(10) * INCOME_PAGE_LIMIT(1000).
    const entries: FuturesIncomeEntry[] = Array.from({ length: 10_001 }, (_, i) =>
      income("REALIZED_PNL", 1, DAY_START + 1_000 + i, { tranId: i }),
    );
    const client = fakeClient(entries);

    const summary = await fetchIncomeSummaryForWindow(client, DAY, DAY_START, DAY_END);

    expect(summary.truncated).toBe(true);
    expect(summary.entryCount).toBe(10_000);
  });

  it("buckets distinct days independently (same feed, two different day windows)", async () => {
    const dayA = "2026-07-08";
    const dayB = "2026-07-09";
    const winA = utcDayWindowMs(dayA);
    const winB = utcDayWindowMs(dayB);
    const entries: FuturesIncomeEntry[] = [
      income("REALIZED_PNL", 10, winA.startMs + 1_000),
      income("REALIZED_PNL", 20, winB.startMs + 1_000),
      income("FUNDING_FEE", -1, winB.startMs + 2_000),
    ];
    const client = fakeClient(entries);

    const summaryA = await fetchIncomeSummaryForWindow(client, dayA, winA.startMs, winA.endMs);
    const summaryB = await fetchIncomeSummaryForWindow(client, dayB, winB.startMs, winB.endMs);

    expect(summaryA.realizedPnlUsd).toBeCloseTo(10, 5);
    expect(summaryA.entryCount).toBe(1);
    expect(summaryB.realizedPnlUsd).toBeCloseTo(20, 5);
    expect(summaryB.fundingFeeUsd).toBeCloseTo(-1, 5);
    expect(summaryB.entryCount).toBe(2);
  });
});

// ── discrepancy / tolerance comparison ────────────────────────────────────────

describe("buildWalletReconciliationReport", () => {
  it("reports withinTolerance=true when internal and exchange net-realized agree within the default tolerance", async () => {
    const entries = [
      income("REALIZED_PNL", 10, DAY_START + 1_000),
      income("COMMISSION", -0.2, DAY_START + 1_000),
      income("FUNDING_FEE", -5, DAY_START + 2_000), // large funding — must NOT count against tolerance
    ];
    const client = fakeClient(entries);
    // exchange net-realized = 10 + (-0.2) = 9.80; internal matches within a cent.
    const ledger = ledgerSource(DAY, 9.8);

    const report = await buildWalletReconciliationReport({ client, ledgerSource: ledger, dateUtc: DAY });

    expect(report.internal.available).toBe(true);
    expect(report.comparison.exchangeNetRealizedUsd).toBeCloseTo(9.8, 5);
    expect(report.comparison.deltaUsd).toBeCloseTo(0, 5);
    expect(report.comparison.toleranceUsd).toBe(DEFAULT_TOLERANCE_USD);
    expect(report.comparison.withinTolerance).toBe(true);
    // funding is fully reported, just not folded into the tolerance-checked delta
    expect(report.exchange.fundingFeeUsd).toBeCloseTo(-5, 5);
  });

  it("reports withinTolerance=false when the internal ledger diverges from exchange net-realized beyond tolerance", async () => {
    const entries = [income("REALIZED_PNL", 10, DAY_START + 1_000), income("COMMISSION", -0.2, DAY_START + 1_000)];
    const client = fakeClient(entries);
    // internal believes it made $15 net, but the exchange only posted $9.80 — a real $5.20 gap
    // (e.g. a missed/mis-tracked trade), far beyond the $0.50 default tolerance.
    const ledger = ledgerSource(DAY, 15);

    const report = await buildWalletReconciliationReport({ client, ledgerSource: ledger, dateUtc: DAY });

    expect(report.comparison.deltaUsd).toBeCloseTo(15 - 9.8, 5);
    expect(report.comparison.withinTolerance).toBe(false);
  });

  it("honors a custom toleranceUsd override", async () => {
    const entries = [income("REALIZED_PNL", 10, DAY_START + 1_000)];
    const client = fakeClient(entries);
    const ledger = ledgerSource(DAY, 10.3); // 30-cent gap

    const tight = await buildWalletReconciliationReport({ client, ledgerSource: ledger, dateUtc: DAY, toleranceUsd: 0.1 });
    const loose = await buildWalletReconciliationReport({ client, ledgerSource: ledger, dateUtc: DAY, toleranceUsd: 1 });

    expect(tight.comparison.withinTolerance).toBe(false);
    expect(loose.comparison.withinTolerance).toBe(true);
  });

  it("never fabricates an internal figure once LiveDailyLedger has rolled to a different UTC day", async () => {
    const entries = [income("REALIZED_PNL", 10, DAY_START + 1_000)];
    const client = fakeClient(entries);
    // ledger has already rolled over to the next day by the time this report is requested for DAY.
    const ledger = ledgerSource("2026-07-10", 0);

    const report = await buildWalletReconciliationReport({ client, ledgerSource: ledger, dateUtc: DAY });

    expect(report.internal.available).toBe(false);
    expect(report.internal.realizedPnlUsd).toBeNull();
    expect(report.internal.note).toMatch(/rolled/);
    expect(report.comparison.deltaUsd).toBeNull();
    expect(report.comparison.withinTolerance).toBeNull();
    // exchange-side figures are still fully computed even though internal is unavailable.
    expect(report.exchange.realizedPnlUsd).toBeCloseTo(10, 5);
  });
});

describe("resolveReconciliationToleranceUsd", () => {
  it("falls back to the documented default when unset or invalid", () => {
    expect(resolveReconciliationToleranceUsd({})).toBe(DEFAULT_TOLERANCE_USD);
    expect(resolveReconciliationToleranceUsd({ WALLET_RECONCILIATION_TOLERANCE_USD: "not-a-number" })).toBe(
      DEFAULT_TOLERANCE_USD,
    );
    expect(resolveReconciliationToleranceUsd({ WALLET_RECONCILIATION_TOLERANCE_USD: "-1" })).toBe(DEFAULT_TOLERANCE_USD);
  });

  it("honors a valid env override, including 0", () => {
    expect(resolveReconciliationToleranceUsd({ WALLET_RECONCILIATION_TOLERANCE_USD: "2.5" })).toBe(2.5);
    expect(resolveReconciliationToleranceUsd({ WALLET_RECONCILIATION_TOLERANCE_USD: "0" })).toBe(0);
  });
});

// ── periodic check: logs on mismatch, never mutates anything ─────────────────

describe("runWalletReconciliationCheck", () => {
  it("logs exactly one warning when over tolerance, and none when within tolerance", async () => {
    const overEntries = [income("REALIZED_PNL", 10, DAY_START + 1_000)];
    const overClient = fakeClient(overEntries);
    const overWarn = vi.fn();
    const overResult = await runWalletReconciliationCheck({
      client: overClient,
      ledgerSource: ledgerSource(DAY, 999),
      dateUtc: DAY,
      warn: overWarn,
    });
    expect(overResult.warned).toBe(true);
    expect(overWarn).toHaveBeenCalledTimes(1);
    expect(overWarn.mock.calls[0][0]).toMatch(/MISMATCH/);
    expect(overWarn.mock.calls[0][0]).toMatch(/REPORT-ONLY/);

    const okEntries = [income("REALIZED_PNL", 10, DAY_START + 1_000)];
    const okClient = fakeClient(okEntries);
    const okWarn = vi.fn();
    const okResult = await runWalletReconciliationCheck({
      client: okClient,
      ledgerSource: ledgerSource(DAY, 10),
      dateUtc: DAY,
      warn: okWarn,
    });
    expect(okResult.warned).toBe(false);
    expect(okWarn).not.toHaveBeenCalled();
  });

  it("never calls any mutating method beyond the two narrow read-only interfaces, in either outcome", async () => {
    // Beyond the interface's one required method, attach spies for every dangerous operation
    // this module must never reach. If runWalletReconciliationCheck (or anything it calls)
    // ever grows a code path to one of these, this test fails.
    const dangerousSpies = {
      disarm: vi.fn(),
      kill: vi.fn(),
      arm: vi.fn(),
      resetKill: vi.fn(),
      flattenAllExchangePositions: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      cancelAlgoOrder: vi.fn(),
      cancelAllAlgoOrders: vi.fn(),
      placeOrder: vi.fn(),
      placeAlgoOrder: vi.fn(),
      setLeverage: vi.fn(),
      setIsolatedMargin: vi.fn(),
    };
    const entries = [income("REALIZED_PNL", 10, DAY_START + 1_000)];
    const client = { ...fakeClient(entries), ...dangerousSpies };
    const ledger = { ...ledgerSource(DAY, 999), ...dangerousSpies }; // 999 forces a mismatch (worst case for side effects)

    await runWalletReconciliationCheck({ client, ledgerSource: ledger, dateUtc: DAY, warn: () => {} });

    for (const [name, spy] of Object.entries(dangerousSpies)) {
      expect(spy, `${name} must never be called by wallet-reconciliation`).not.toHaveBeenCalled();
    }
  });

  it("statically contains no reference to any mutating/trading operation (grep-based proof)", () => {
    const modulePath = fileURLToPath(new URL("../src/lib/wallet-reconciliation.ts", import.meta.url));
    const source = readFileSync(modulePath, "utf-8");
    const forbidden = [
      "disarm(",
      "engageKillSwitch",
      ".kill(",
      "cancelOrder(",
      "cancelAllOrders(",
      "cancelAlgoOrder(",
      "cancelAllAlgoOrders(",
      "placeOrder(",
      "placeAlgoOrder(",
      "closePosition(",
      "flattenAllExchangePositions(",
      "setLeverage(",
      "setIsolatedMargin(",
      ".arm(",
      "resetKill(",
    ];
    for (const needle of forbidden) {
      expect(source.includes(needle), `wallet-reconciliation.ts must not reference "${needle}"`).toBe(false);
    }
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import type { FuturesIncomeEntry } from "../src/lib/binance-futures-private.js";
import {
  FundingFeeRecorder,
  INCOME_PAGE_LIMIT,
  MAX_FUNDING_ROWS,
  RETENTION_MS,
  attributeFundingToIntervals,
  fundingFeeRecordingEnabled,
  withFundingFeeRecording,
  type FundingFeeRow,
} from "../src/lib/funding-fee-recorder.js";
import {
  buildLiveWalletReconciliationReport,
  type LiveEngineReconciliationSource,
} from "../src/lib/wallet-reconciliation.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const dirs: string[] = [];
let seq = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `ffr-${process.pid}-${++seq}`);
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

const DAY = "2026-07-26";
const dayMs = Date.parse(`${DAY}T08:00:00.000Z`);

function income(over: Partial<FuturesIncomeEntry> = {}): FuturesIncomeEntry {
  return {
    symbol: "BTCUSDT",
    incomeType: "FUNDING_FEE",
    income: -0.0123,
    asset: "USDT",
    time: dayMs,
    tranId: "9876543210123456789",
    info: "",
    ...over,
  };
}

// ─── recordIncomeEntries ─────────────────────────────────────────────────────

describe("FundingFeeRecorder.recordIncomeEntries", () => {
  it("stores only FUNDING_FEE rows, keeping Binance's own sign, and ignores other income types", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const added = rec.recordIncomeEntries([
      income({ tranId: "1", income: -0.05 }),
      income({ tranId: "2", incomeType: "REALIZED_PNL", income: 3.5 }),
      income({ tranId: "3", incomeType: "COMMISSION", income: -0.18 }),
      income({ tranId: "4", income: 0.02 }), // funding RECEIVED — positive, must not be flipped
    ], dayMs);

    expect(added).toBe(2);
    const rows = rec.listFundingRows();
    expect(rows.map((r) => r.tranId)).toEqual(["1", "4"]);
    expect(rows[0]!.income).toBe(-0.05);
    expect(rows[1]!.income).toBe(0.02);
    // Signed sum: paid 0.05, received 0.02 => net -0.03 paid. A recorder that abs()'d or flipped
    // the sign would report -0.07 or +0.03 here.
    expect(rec.sumFundingUsd()).toBeCloseTo(-0.03, 12);
  });

  it("dedupes by tranId across repeated observations of the same UTC day", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const page = [income({ tranId: "A", income: -0.01 }), income({ tranId: "B", income: -0.02 })];

    expect(rec.recordIncomeEntries(page, dayMs)).toBe(2);
    // The live reconciliation ticker re-fetches the SAME UTC day every 30 minutes forever.
    expect(rec.recordIncomeEntries(page, dayMs + 1_800_000)).toBe(0);
    expect(rec.recordIncomeEntries([...page, income({ tranId: "C", income: -0.03 })], dayMs + 3_600_000)).toBe(1);

    expect(rec.listFundingRows()).toHaveLength(3);
    expect(rec.sumFundingUsd()).toBeCloseTo(-0.06, 12);
  });

  it("drops a row with no usable tranId rather than double-booking it on the next overlapping fetch", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const bad = income({ tranId: "" as unknown as string, income: -0.99 });

    expect(rec.recordIncomeEntries([bad], dayMs)).toBe(0);
    expect(rec.recordIncomeEntries([bad], dayMs + 1_800_000)).toBe(0);
    // Under-counting is visible against the exchange's income ledger; a double-count is not.
    expect(rec.listFundingRows()).toHaveLength(0);
    expect(rec.sumFundingUsd()).toBe(0);
  });

  it("stores a tranId it was GIVEN as a string byte-exactly (this store's own typing guarantee, NOT end-to-end precision)", () => {
    // NAME CORRECTED 2026-07-27. This proves the recorder does not re-parse or round what it is
    // handed. It does NOT prove end-to-end precision: binance-futures-private.ts maps tranId with
    // toStrId over an ALREADY-JSON.parse'd value and deliberately keeps it out of
    // preserveOrderIdPrecision, so a >2^53 tranId would arrive here already rounded. See
    // FundingFeeRow.tranId's doc comment. Asserted below so the two cannot silently diverge.
    const rec = new FundingFeeRecorder(tmpDir());
    rec.recordIncomeEntries([income({ tranId: "9876543210123456789" })], dayMs);
    const row = rec.listFundingRows()[0]!;
    expect(typeof row.tranId).toBe("string");
    expect(row.tranId).toBe("9876543210123456789");

    // The honest boundary: a tranId that reached the client as a NUMBER above 2^53 was already
    // rounded before this store ever saw it, and the store faithfully preserves the rounded value.
    // This is an under-count risk (two rounded-equal ids collapse to one key), never a
    // double-count, because the rounding is deterministic across re-fetches.
    const rounded = new FundingFeeRecorder(tmpDir());
    rounded.recordIncomeEntries(
      [income({ tranId: String(9_876_543_210_123_456_789), time: dayMs + 1 })],
      dayMs,
    );
    expect(rounded.listFundingRows()[0]!.tranId).toBe("9876543210123457000"); // NOT ...6789
  });

  it("survives a reload from disk with rows, coverage and the dedup index intact", () => {
    const dir = tmpDir();
    const first = new FundingFeeRecorder(dir);
    first.recordIncomeEntries([income({ tranId: "A", income: -0.01 })], dayMs);

    const second = new FundingFeeRecorder(dir);
    expect(second.listFundingRows().map((r) => r.tranId)).toEqual(["A"]);
    expect(second.getDayCoverage().map((c) => c.dayUtc)).toEqual([DAY]);
    // The dedup index must be rebuilt on load, or a restart would re-book every row it already has.
    expect(second.recordIncomeEntries([income({ tranId: "A", income: -0.01 })], dayMs)).toBe(0);
  });

  it("degrades to an empty store (never throws) when the persisted JSON is corrupt", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, "funding-fees.json"), "{ this is not json", "utf-8");
    const rec = new FundingFeeRecorder(dir);
    expect(rec.listFundingRows()).toEqual([]);
    expect(() => rec.recordIncomeEntries([income({ tranId: "A" })], dayMs)).not.toThrow();
    expect(rec.listFundingRows()).toHaveLength(1);
  });
});

// ─── coverage ────────────────────────────────────────────────────────────────

describe("FundingFeeRecorder day coverage", () => {
  it("distinguishes a day we never looked at from a day with zero funding", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    rec.recordIncomeEntries([income({ tranId: "A", income: -0.01 })], dayMs);

    const covered = rec.getDayCoverage();
    expect(covered.map((c) => c.dayUtc)).toEqual([DAY]);
    // A different day has no coverage row at all, so a 0 sum for it is "unobserved", not "free".
    expect(covered.some((c) => c.dayUtc === "2026-07-25")).toBe(false);
    expect(rec.sumFundingUsd({ fromMs: Date.parse("2026-07-25T00:00:00.000Z"), toMs: Date.parse("2026-07-26T00:00:00.000Z") })).toBe(0);
  });

  it("[2026-07-27] flags a day observed through a SATURATED income page — a false-complete total is the failure this store exists to prevent", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    // The observed /fapi/v1/income page is UNFILTERED by incomeType, so COMMISSION and REALIZED_PNL
    // rows compete for the same 1000 slots; on a heavy day the 16:00 UTC funding rows fall off the
    // edge. Without this flag the coverage row reads as a normal, healthy observation while a third
    // of the day's funding is permanently absent.
    rec.recordIncomeEntries([income({ tranId: "T1" })], dayMs, { pageSaturated: true });
    expect(rec.getDayCoverage()[0]!.possiblyTruncated).toBe(true);

    // LATCHED: a later clean observation does NOT clear it — a non-saturated page only proves
    // completeness for the window THAT call used, and this module is not told the window.
    rec.recordIncomeEntries([income({ tranId: "T2", time: dayMs + 1 })], dayMs + 1000, { pageSaturated: false });
    expect(rec.getDayCoverage()[0]!.possiblyTruncated).toBe(true);
    expect(rec.getDayCoverage()[0]!.observations).toBe(2);
  });

  it("[2026-07-27] a day observed through a NON-saturated page carries no truncation flag at all (absent, not false)", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    rec.recordIncomeEntries([income({ tranId: "T1" })], dayMs, { pageSaturated: false });
    expect(rec.getDayCoverage()[0]!.possiblyTruncated).toBeUndefined();
    // And the flag survives a reload rather than being invented on the way back in.
    rec.recordIncomeEntries([income({ tranId: "T2", time: dayMs + 1 })], dayMs, { pageSaturated: true });
    expect(rec.getDayCoverage()[0]!.possiblyTruncated).toBe(true);
  });

  it("never rewrites the observation window narrower when the local clock steps backwards", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    rec.recordIncomeEntries([income({ tranId: "A" })], 5_000_000);
    rec.recordIncomeEntries([income({ tranId: "B", income: -0.02 })], 9_000_000);
    rec.recordIncomeEntries([income({ tranId: "C", income: -0.03 })], 1_000_000); // clock step back

    const c = rec.getDayCoverage()[0]!;
    expect(c.firstObservedAtMs).toBe(1_000_000);
    expect(c.lastObservedAtMs).toBe(9_000_000);
    expect(c.observations).toBe(3);
  });
});

// ─── bounds ──────────────────────────────────────────────────────────────────

describe("FundingFeeRecorder bounds", () => {
  it("caps retained rows at MAX_FUNDING_ROWS, dropping the oldest first", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const entries: FuturesIncomeEntry[] = [];
    for (let i = 0; i < MAX_FUNDING_ROWS + 25; i += 1) {
      entries.push(income({ tranId: `t${i}`, time: dayMs + i * 1000, income: -0.001 }));
    }
    rec.recordIncomeEntries(entries, dayMs);
    const rows = rec.listFundingRows();
    expect(rows).toHaveLength(MAX_FUNDING_ROWS);
    expect(rows[0]!.tranId).toBe("t25"); // the 25 oldest were dropped
  });

  it("pruneExpired drops rows past the retention horizon and their coverage days", () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const nowMs = dayMs;
    rec.recordIncomeEntries([
      income({ tranId: "old", time: nowMs - RETENTION_MS - 86_400_000 }),
      income({ tranId: "new", time: nowMs }),
    ], nowMs);

    const { droppedRows, droppedDays } = rec.pruneExpired(nowMs);
    expect(droppedRows).toBe(1);
    expect(droppedDays).toBe(1);
    expect(rec.listFundingRows().map((r) => r.tranId)).toEqual(["new"]);
    // The dedup index must release a pruned tranId, otherwise the row could never be re-recorded.
    expect(rec.recordIncomeEntries([income({ tranId: "old", time: nowMs - RETENTION_MS - 86_400_000 })], nowMs)).toBe(1);
  });
});

// ─── withFundingFeeRecording (read-through observer) ─────────────────────────

/** Stand-in for LiveExecutionEngine: getStatus/getIncomeHistory are PROTOTYPE methods and the
 *  private state they need lives on the instance — exactly like the real engine. A decorator that
 *  shallow-spreads the source loses both. */
class FakeEngine implements LiveEngineReconciliationSource {
  calls: Array<[number, number]> = [];
  /** Instance state a prototype method must be able to reach — so the test also proves `this` is
   *  still bound to the real source when the method is pulled off the decorated object. */
  private readonly ledgerDay = DAY;
  constructor(private readonly entries: FuturesIncomeEntry[]) {}
  getStatus(): { closedToday: { dateUtc: string; realizedPnlUsd: number; trades: number; wins: number; losses: number } } {
    return { closedToday: { dateUtc: this.ledgerDay, realizedPnlUsd: 0, trades: 0, wins: 0, losses: 0 } };
  }
  async getIncomeHistory(startTimeMs: number, endTimeMs: number): Promise<FuturesIncomeEntry[]> {
    this.calls.push([startTimeMs, endTimeMs]);
    return this.entries;
  }
}

describe("withFundingFeeRecording", () => {
  it("forwards arguments and the returned rows verbatim, and records the funding rows", async () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const entries = [income({ tranId: "A", income: -0.01 }), income({ tranId: "B", incomeType: "REALIZED_PNL", income: 2 })];
    const engine = new FakeEngine(entries);

    const decorated = withFundingFeeRecording(engine, { recorder: rec, enabled: true, nowMs: () => dayMs });
    const out = await decorated.getIncomeHistory(1, 2);

    expect(engine.calls).toEqual([[1, 2]]);
    expect(out).toBe(entries); // same array reference — nothing copied, filtered or reordered
    expect(rec.listFundingRows().map((r) => r.tranId)).toEqual(["A"]);
  });

  it("[2026-07-27] propagates page SATURATION from the observed fetch into the day's coverage row", async () => {
    const rec = new FundingFeeRecorder(tmpDir());
    // A full INCOME_PAGE_LIMIT-row page. Only the first row is FUNDING_FEE; the rest are the
    // COMMISSION/REALIZED_PNL traffic that competes for the same 1000 slots on a heavy day.
    const entries: FuturesIncomeEntry[] = [income({ tranId: "F1" })];
    while (entries.length < INCOME_PAGE_LIMIT) {
      entries.push(income({ tranId: `C${entries.length}`, incomeType: "COMMISSION", income: -0.05 }));
    }
    const engine = new FakeEngine(entries);
    const decorated = withFundingFeeRecording(engine, { recorder: rec, enabled: true, nowMs: () => dayMs });
    const out = await decorated.getIncomeHistory(1, 2);

    expect(out).toBe(entries); // still byte-for-byte pass-through
    expect(rec.getDayCoverage()[0]!.possiblyTruncated).toBe(true);

    // A short page must NOT be flagged.
    const rec2 = new FundingFeeRecorder(tmpDir());
    const decorated2 = withFundingFeeRecording(new FakeEngine([income({ tranId: "F2" })]), {
      recorder: rec2, enabled: true, nowMs: () => dayMs,
    });
    await decorated2.getIncomeHistory(1, 2);
    expect(rec2.getDayCoverage()[0]!.possiblyTruncated).toBeUndefined();
  });

  it("PRESERVES every other method on the source — a shallow spread of a class instance drops them", async () => {
    // REGRESSION: `{...source}` copies OWN ENUMERABLE properties only. LiveExecutionEngine defines
    // getStatus()/getIncomeHistory() on its PROTOTYPE, so a spread-based decorator returns an
    // object with NO getStatus at all — buildLiveWalletReconciliationReport then throws
    // "engine.getStatus is not a function" and the wallet-reconciliation route 502s forever.
    const rec = new FundingFeeRecorder(tmpDir());
    const engine = new FakeEngine([income({ tranId: "A", income: -0.01 })]);
    const decorated = withFundingFeeRecording(engine, { recorder: rec, enabled: true, nowMs: () => dayMs });

    expect(typeof decorated.getStatus).toBe("function");
    expect(decorated.getStatus().closedToday.dateUtc).toBe(DAY);

    // End-to-end through the real report builder, which is the actual production caller.
    const report = await buildLiveWalletReconciliationReport(decorated, DAY);
    expect(report.dayUtc).toBe(DAY);
    expect(rec.listFundingRows().map((r) => r.tranId)).toEqual(["A"]);
  });

  it("returns the source's rows unchanged even when the recorder throws on every call", async () => {
    const entries = [income({ tranId: "A", income: -0.01 })];
    const engine = new FakeEngine(entries);
    const exploding = {
      recordIncomeEntries: () => {
        throw new Error("recorder is on fire");
      },
    };
    const decorated = withFundingFeeRecording(engine, { recorder: exploding, enabled: true });
    await expect(decorated.getIncomeHistory(1, 2)).resolves.toBe(entries);
  });

  it("is a pass-through when disabled", async () => {
    const rec = new FundingFeeRecorder(tmpDir());
    const engine = new FakeEngine([income({ tranId: "A" })]);
    const decorated = withFundingFeeRecording(engine, { recorder: rec, enabled: false });
    expect(decorated).toBe(engine);
    await decorated.getIncomeHistory(1, 2);
    expect(rec.listFundingRows()).toHaveLength(0);
  });
});

describe("fundingFeeRecordingEnabled", () => {
  it("defaults ON and is switched off only by the explicit FUNDING_FEE_RECORDING=0 kill switch", () => {
    expect(fundingFeeRecordingEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(fundingFeeRecordingEnabled({ FUNDING_FEE_RECORDING: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fundingFeeRecordingEnabled({ FUNDING_FEE_RECORDING: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ─── attribution (pure derivation) ───────────────────────────────────────────

function row(over: Partial<FundingFeeRow> = {}): FundingFeeRow {
  return { tranId: "t", symbol: "BTCUSDT", income: -0.01, asset: "USDT", time: dayMs, ...over };
}

describe("attributeFundingToIntervals", () => {
  it("assigns a charge to the single position open on that symbol at that instant", () => {
    const res = attributeFundingToIntervals(
      [row({ tranId: "1", income: -0.04 })],
      [{ key: "pos-1", symbol: "BTCUSDT", fromMs: dayMs - 3_600_000, toMs: dayMs + 3_600_000 }],
    );
    expect(res.byKey.get("pos-1")).toBeCloseTo(-0.04, 12);
    expect(res.unattributedUsd).toBe(0);
    expect(res.attributedRows).toBe(1);
  });

  it("REPORTS what it could not attribute instead of spreading it over unrelated positions", () => {
    const res = attributeFundingToIntervals(
      [row({ tranId: "1", income: -0.04, symbol: "SOLUSDT" })],
      [{ key: "pos-1", symbol: "BTCUSDT", fromMs: dayMs - 3_600_000, toMs: dayMs + 3_600_000 }],
    );
    expect(res.byKey.size).toBe(0);
    expect(res.unattributedUsd).toBeCloseTo(-0.04, 12);
    expect(res.unattributedRows).toBe(1);
  });

  it("splits by weight across simultaneously-open positions, and equally when weights are absent", () => {
    const intervals = [
      { key: "a", symbol: "BTCUSDT", fromMs: dayMs - 1000, toMs: null, weight: 75 },
      { key: "b", symbol: "BTCUSDT", fromMs: dayMs - 1000, toMs: null, weight: 25 },
    ];
    const weighted = attributeFundingToIntervals([row({ income: -0.04 })], intervals);
    expect(weighted.byKey.get("a")).toBeCloseTo(-0.03, 12);
    expect(weighted.byKey.get("b")).toBeCloseTo(-0.01, 12);

    const unweighted = attributeFundingToIntervals([row({ income: -0.04 })], [
      { key: "a", symbol: "BTCUSDT", fromMs: dayMs - 1000, toMs: null },
      { key: "b", symbol: "BTCUSDT", fromMs: dayMs - 1000, toMs: null },
    ]);
    expect(unweighted.byKey.get("a")).toBeCloseTo(-0.02, 12);
    expect(unweighted.byKey.get("b")).toBeCloseTo(-0.02, 12);
  });

  it("counts a charge landing exactly on an open or close timestamp (inclusive both ends)", () => {
    const onOpen = attributeFundingToIntervals([row({ income: -0.04 })], [
      { key: "a", symbol: "BTCUSDT", fromMs: dayMs, toMs: dayMs + 1000 },
    ]);
    expect(onOpen.byKey.get("a")).toBeCloseTo(-0.04, 12);

    const onClose = attributeFundingToIntervals([row({ income: -0.04 })], [
      { key: "a", symbol: "BTCUSDT", fromMs: dayMs - 1000, toMs: dayMs },
    ]);
    expect(onClose.byKey.get("a")).toBeCloseTo(-0.04, 12);
  });
});

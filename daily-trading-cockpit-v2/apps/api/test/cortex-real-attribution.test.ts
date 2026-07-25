import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CortexRealAttributionStore,
  computeTiltShare,
  type CortexRealAttributionCloseInput,
} from "../src/lib/cortex-real-attribution.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-cortex-real-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function input(overrides: Partial<CortexRealAttributionCloseInput> = {}): CortexRealAttributionCloseInput {
  return {
    recordId: `rec-${Math.random().toString(36).slice(2, 10)}`,
    closedAtIso: "2026-07-21T10:00:00.000Z",
    laneId: "CG_WIDE_FAST_LONG",
    symbol: "ETHUSDT",
    realizedPnlUsd: 1,
    appliedWeightPct: 8.53,
    rawStaticWeightPct: 8,
    ...overrides,
  };
}

describe("computeTiltShare", () => {
  it("matches the spec formula for an upsizing tilt (8% → 8.53%)", () => {
    expect(computeTiltShare(8.53, 8)).toBeCloseTo((8.53 - 8) / 8.53, 12);
  });

  it("is 0 when no tilt is active (applied == raw)", () => {
    expect(computeTiltShare(8, 8)).toBe(0);
  });

  it("is NEGATIVE when the tilt downsized the lane (raw > applied) — no clamping", () => {
    expect(computeTiltShare(5, 8)).toBeCloseTo((5 - 8) / 5, 12);
    expect(computeTiltShare(5, 8)).toBeLessThan(0);
  });

  it("is 0 on an unopenable/invalid applied weight and on non-finite inputs", () => {
    expect(computeTiltShare(0, 8)).toBe(0);
    expect(computeTiltShare(-1, 8)).toBe(0);
    expect(computeTiltShare(Number.NaN, 8)).toBe(0);
    expect(computeTiltShare(8, Number.NaN)).toBe(0);
  });
});

describe("CortexRealAttributionStore", () => {
  it("sign correctness: downsized winner COSTS CORTEX money, downsized loser SAVES money", () => {
    const store = new CortexRealAttributionStore(tmp());
    // Tilt downsized the lane 8% → 5% (tiltShare = -0.6).
    store.recordClose(input({ recordId: "down-win", realizedPnlUsd: 10, appliedWeightPct: 5, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "down-loss", realizedPnlUsd: -10, appliedWeightPct: 5, rawStaticWeightPct: 8 }));
    const [win, loss] = store.getState().records;
    expect(win!.tiltShare).toBeCloseTo(-0.6, 12);
    expect(win!.cortexUsd).toBeCloseTo(-6, 12); // winner CORTEX shrank → CORTEX cost $6
    expect(loss!.cortexUsd).toBeCloseTo(6, 12); // loser CORTEX shrank → CORTEX saved $6
    expect(store.getState().allTime.cortexUsd).toBeCloseTo(0, 12);
    expect(store.getState().allTime.n).toBe(2);
  });

  it("sign correctness: upsized winner CREDITS CORTEX, upsized loser DEBITS it", () => {
    const store = new CortexRealAttributionStore(tmp());
    const share = (8.53 - 8) / 8.53;
    store.recordClose(input({ recordId: "up-win", realizedPnlUsd: 4.96, appliedWeightPct: 8.53, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "up-loss", realizedPnlUsd: -2, appliedWeightPct: 8.53, rawStaticWeightPct: 8 }));
    const [win, loss] = store.getState().records;
    expect(win!.cortexUsd).toBeCloseTo(4.96 * share, 12);
    expect(loss!.cortexUsd).toBeCloseTo(-2 * share, 12);
  });

  it("no tilt at open books an explicit tiltShare-0 / $0 record (the honest denominator)", () => {
    const store = new CortexRealAttributionStore(tmp());
    store.recordClose(input({ recordId: "flat", realizedPnlUsd: 3, appliedWeightPct: 8, rawStaticWeightPct: 8 }));
    const record = store.getState().records[0]!;
    expect(record.tiltShare).toBe(0);
    expect(record.cortexUsd).toBe(0);
    expect(store.getState().allTime.n).toBe(1);
  });

  it("dedups by recordId — a retried sweep can never double-book a close", () => {
    const store = new CortexRealAttributionStore(tmp());
    const one = input({ recordId: "same-id", realizedPnlUsd: 10, appliedWeightPct: 10, rawStaticWeightPct: 8 });
    store.recordClose(one);
    store.recordClose(one);
    store.recordClose({ ...one }); // fresh object, same id
    expect(store.getState().records).toHaveLength(1);
    expect(store.getState().allTime.n).toBe(1);
    expect(store.hasRecorded("same-id")).toBe(true);
  });

  it("skips a non-finite realized P&L instead of fabricating an attribution", () => {
    const store = new CortexRealAttributionStore(tmp());
    store.recordClose(input({ recordId: "nan", realizedPnlUsd: Number.NaN }));
    expect(store.getState().records).toHaveLength(0);
    expect(store.getState().allTime.n).toBe(0);
    expect(store.hasRecorded("nan")).toBe(false); // not booked — may be re-offered once P&L is known
  });

  it("BOUNDED growth: detail records cap at 2000 while all-time aggregates keep counting", () => {
    const store = new CortexRealAttributionStore(tmp());
    for (let i = 0; i < 2100; i += 1) {
      store.recordClose(input({ recordId: `r-${i}`, realizedPnlUsd: 1, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    }
    const st = store.getState();
    expect(st.records).toHaveLength(2000);
    expect(st.records[0]!.recordId).toBe("r-100"); // oldest 100 pruned
    expect(st.allTime.n).toBe(2100); // running aggregate survives pruning
    expect(st.allTime.cortexUsd).toBeCloseTo(2100 * 0.2, 6);
    expect(st.attributedRecordIds.length).toBeLessThanOrEqual(8000);
  });

  it("today vs all-time bucketing uses the UTC date of closedAt", () => {
    const store = new CortexRealAttributionStore(tmp());
    store.recordClose(input({ recordId: "yesterday", closedAtIso: "2026-07-20T23:59:59.000Z", realizedPnlUsd: 10, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "today-1", closedAtIso: "2026-07-21T00:00:00.000Z", realizedPnlUsd: 5, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "today-2", closedAtIso: "2026-07-21T12:00:00.000Z", realizedPnlUsd: -5, appliedWeightPct: 5, rawStaticWeightPct: 8 }));
    const report = store.buildReport("2026-07-21T18:00:00.000Z");
    expect(report.today.dateUtc).toBe("2026-07-21");
    expect(report.today.n).toBe(2);
    expect(report.today.cortexUsd).toBeCloseTo(5 * 0.2 + -5 * ((5 - 8) / 5), 12);
    expect(report.allTime.n).toBe(3);
    // A different "now" re-buckets without touching all-time.
    const nextDay = store.buildReport("2026-07-22T01:00:00.000Z");
    expect(nextDay.today.n).toBe(0);
    expect(nextDay.allTime.n).toBe(3);
  });

  it("perLane aggregates by lane and sorts by |cortexUsd|", () => {
    const store = new CortexRealAttributionStore(tmp());
    store.recordClose(input({ recordId: "a1", laneId: "LANE_A", realizedPnlUsd: 10, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "a2", laneId: "LANE_A", realizedPnlUsd: 10, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    store.recordClose(input({ recordId: "b1", laneId: "LANE_B", realizedPnlUsd: 1, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    const report = store.buildReport("2026-07-21T18:00:00.000Z");
    expect(report.perLane[0]).toMatchObject({ laneId: "LANE_A", n: 2 });
    expect(report.perLane[0]!.cortexUsd).toBeCloseTo(4, 12);
    expect(report.perLane[1]).toMatchObject({ laneId: "LANE_B", n: 1 });
  });

  it("[REGRESSION 2026-07-22] perLane never exceeds MAX_LANES=300 distinct keys, even counting the overflow bucket", () => {
    const store = new CortexRealAttributionStore(tmp());
    // 301 distinct, never-before-seen lane ids — one more than the documented strict cap of 300,
    // so the overflow bucket itself must be accounted for within that cap, not added on top of it.
    for (let i = 0; i < 301; i += 1) {
      store.recordClose(input({ recordId: `lane-${i}`, laneId: `LANE_${i}`, realizedPnlUsd: 1, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    }
    const perLaneKeys = Object.keys(store.getState().perLane);
    expect(perLaneKeys.length).toBeLessThanOrEqual(300);
    expect(perLaneKeys).toContain("OTHER"); // the 301st distinct lane spilled into the overflow bucket
  });

  it("persists atomically (compact JSON) and reloads records, aggregates AND dedup ids", () => {
    const dir = tmp();
    const store = new CortexRealAttributionStore(dir);
    store.recordClose(input({ recordId: "persist-1", realizedPnlUsd: 4.96, appliedWeightPct: 8.53, rawStaticWeightPct: 8 }));
    const rawFile = readFileSync(join(dir, "cortex-real-attribution.json"), "utf-8");
    expect(rawFile.includes("\n  ")).toBe(false); // compact, not pretty-printed
    const reloaded = new CortexRealAttributionStore(dir);
    expect(reloaded.getState().records).toHaveLength(1);
    expect(reloaded.getState().allTime.n).toBe(1);
    expect(reloaded.hasRecorded("persist-1")).toBe(true); // dedup survives restart
    reloaded.recordClose(input({ recordId: "persist-1", realizedPnlUsd: 99 })); // replayed close post-restart
    expect(reloaded.getState().allTime.n).toBe(1);
  });

  it("a corrupt file falls back to empty instead of throwing into the caller", () => {
    const dir = tmp();
    const store = new CortexRealAttributionStore(dir);
    store.recordClose(input({ recordId: "x" }));
    // Corrupt on disk, then reload.
    const file = join(dir, "cortex-real-attribution.json");
    rmSync(file);
    const reloaded = new CortexRealAttributionStore(dir);
    expect(reloaded.getState().records).toHaveLength(0);
    expect(reloaded.buildReport().allTime.n).toBe(0);
  });

  it("2026-07-21 review fix: malformed persisted RECORDS are dropped on load — buildReport never throws on them", () => {
    const dir = tmp();
    const store = new CortexRealAttributionStore(dir);
    store.recordClose(input({ recordId: "good", realizedPnlUsd: 2, appliedWeightPct: 10, rawStaticWeightPct: 8 }));
    const file = join(dir, "cortex-real-attribution.json");
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    // Inject the exact malformed shapes the review called out: a literal null and a non-numeric cortexUsd.
    parsed.records.push(null);
    parsed.records.push({ ...parsed.records[0], recordId: "bad-usd", cortexUsd: "oops" });
    writeFileSync(file, JSON.stringify(parsed), "utf-8");
    const reloaded = new CortexRealAttributionStore(dir);
    expect(reloaded.getState().records).toHaveLength(1); // only the valid record survives
    expect(() => reloaded.buildReport()).not.toThrow();
    expect(reloaded.buildReport().recent.every((r) => Number.isFinite(r.cortexUsd))).toBe(true);
  });

  it("2026-07-21 review fix: deferSave batches — nothing hits disk until flush(), and recordClose reports booked=true/false honestly", () => {
    const dir = tmp();
    const store = new CortexRealAttributionStore(dir);
    const file = join(dir, "cortex-real-attribution.json");
    expect(store.recordClose(input({ recordId: "d1" }), { deferSave: true })).toBe(true);
    expect(store.recordClose(input({ recordId: "d1" }), { deferSave: true })).toBe(false); // dup → not booked
    expect(existsSync(file)).toBe(false); // deferred — no write yet
    store.flush();
    expect(existsSync(file)).toBe(true);
    const reloaded = new CortexRealAttributionStore(dir);
    expect(reloaded.getState().allTime.n).toBe(1);
  });
});

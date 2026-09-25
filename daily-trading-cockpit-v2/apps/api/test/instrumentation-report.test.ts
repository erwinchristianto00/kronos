import { describe, it, expect } from "vitest";
import { buildInstrumentationReport, parseJsonl } from "../src/lib/instrumentation-report.js";

const H = 48 * 3_600_000;
const NOW = Date.UTC(2026, 7, 20, 0, 0, 0);

const rejection = (openedAtMs: number, scoreGap: number, minScoreGap = 0.02) =>
  JSON.stringify({
    openedAtMs, signal: "MOM36_FILTERED", scoreGap, minScoreGap,
    longs: [{ symbol: "NEARUSDT", score: 0.026 }],
    shorts: [{ symbol: "ADAUSDT", score: -0.012 }],
  });

const micro = (t: number, sym: string, oi: number | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ t, sym, oi, ...extra });

describe("parseJsonl", () => {
  it("survives a partial trailing line — an append-only file can be read mid-write", () => {
    const rows = parseJsonl<{ a: number }>('{"a":1}\n{"a":2}\n{"a":3');
    expect(rows.map((r) => r.a)).toEqual([1, 2]);
  });

  it("ignores blank lines and returns [] for empty input", () => {
    expect(parseJsonl('\n\n{"a":1}\n\n')).toHaveLength(1);
    expect(parseJsonl("")).toEqual([]);
  });
});

describe("buildInstrumentationReport — rejected baskets", () => {
  it("reports the SHORTFALL in pp, which the raw log does not carry", () => {
    // 0.0195 against a 0.02 floor is a 0.05pp miss; 0.005 is a 1.5pp miss. Very different facts.
    const text = [rejection(NOW - H * 2, 0.0195), rejection(NOW - H * 3, 0.005)].join("\n");
    const r = buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H });
    const byGap = new Map(r.rejected.rows.map((x) => [x.scoreGap, x.shortfallPp]));
    expect(byGap.get(0.0195)!).toBeCloseTo(0.05, 9);
    expect(byGap.get(0.005)!).toBeCloseTo(1.5, 9);
  });

  it("counts only near-misses (<=0.5pp) — those are the ones the exact level decided", () => {
    // Bucket jam harus berbeda: dedupe sengaja meruntuhkan penolakan dalam satu jam yang sama.
    const text = [rejection(NOW - H, 0.0195), rejection(NOW - H - 3_600_000, 0.018), rejection(NOW - H - 7_200_000, 0.005)].join("\n");
    const r = buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H });
    expect(r.rejected.count).toBe(3);
    expect(r.rejected.nearMisses).toBe(2);
  });

  it("marks a refusal evaluable only once its 48h horizon has actually elapsed", () => {
    const text = [rejection(NOW - H - 1, 0.019), rejection(NOW - 1_000, 0.019)].join("\n");
    const r = buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H });
    const sorted = r.rejected.rows.slice().sort((a, b) => a.openedAtMs - b.openedAtMs);
    expect(sorted[0]!.horizonElapsed).toBe(true);
    expect(sorted[1]!.horizonElapsed).toBe(false);
  });

  it("collapses repeats inside ONE hourly bucket — the scanner cycles several times an hour", () => {
    // The very first live rejection was logged TWICE with identical composition, because the
    // `alreadyThisBucket` guard only covers the success path. Counting both would weight one
    // refusal like two independent observations.
    const base = Date.UTC(2026, 7, 17, 14, 32, 45);
    const text = [rejection(base, 0.0195), rejection(base + 5 * 60_000, 0.0195), rejection(base + 20 * 60_000, 0.0195)].join("\n");
    const r = buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H });
    expect(r.rejected.count).toBe(1);
  });

  it("keeps refusals in DIFFERENT buckets as separate rows", () => {
    const base = Date.UTC(2026, 7, 17, 14, 32, 45);
    const text = [rejection(base, 0.0195), rejection(base + 2 * 3_600_000, 0.019)].join("\n");
    expect(buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H }).rejected.count).toBe(2);
  });

  it("newest first, and tolerates a totally empty log", () => {
    const text = [rejection(NOW - H * 3, 0.01), rejection(NOW - H, 0.015)].join("\n");
    const r = buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H });
    expect(r.rejected.rows[0]!.openedAtMs).toBeGreaterThan(r.rejected.rows[1]!.openedAtMs);
    expect(buildInstrumentationReport("", "", { nowMs: NOW, horizonMs: H }).rejected.count).toBe(0);
  });

  it("drops malformed rows instead of reporting NaN shortfalls", () => {
    const text = ['{"openedAtMs":"nope","scoreGap":0.01}', rejection(NOW - H, 0.015)].join("\n");
    expect(buildInstrumentationReport(text, "", { nowMs: NOW, horizonMs: H }).rejected.count).toBe(1);
  });
});

describe("buildInstrumentationReport — microstructure", () => {
  it("counts 48h blocks from elapsed coverage, not from snapshot count", () => {
    // 200 snapshots inside a single hour is still ZERO blocks — otherwise the page would imply
    // statistical power it does not have.
    const dense = Array.from({ length: 200 }, (_, i) => micro(NOW - i * 1_000, "SOLUSDT", 1)).join("\n");
    const r = buildInstrumentationReport("", dense, { nowMs: NOW, horizonMs: H });
    expect(r.micro.snapshots).toBe(200);
    expect(r.micro.blocks).toBe(0);

    const spread = [micro(NOW - 100 * 3_600_000, "SOLUSDT", 1), micro(NOW, "SOLUSDT", 1)].join("\n");
    expect(buildInstrumentationReport("", spread, { nowMs: NOW, horizonMs: H }).micro.blocks).toBe(2);
  });

  it("shows only the LATEST snapshot round, sorted by symbol", () => {
    const text = [
      micro(NOW - 3_600_000, "SOLUSDT", 1), micro(NOW - 3_600_000, "BNBUSDT", 2),
      micro(NOW, "SOLUSDT", 3), micro(NOW, "BNBUSDT", 4), micro(NOW, "ADAUSDT", 5),
    ].join("\n");
    const r = buildInstrumentationReport("", text, { nowMs: NOW, horizonMs: H });
    expect(r.micro.latest.map((m) => m.sym)).toEqual(["ADAUSDT", "BNBUSDT", "SOLUSDT"]);
    expect(r.micro.symbols).toBe(3);
  });

  it("carries depth fields through when present and tolerates them missing", () => {
    const text = [
      micro(NOW, "SOLUSDT", 10, { bid: 75.5, ask: 75.51, spreadBps: 1.32, imb20: 0.046, bidUsd20: 7_258_455 }),
      micro(NOW, "BNBUSDT", null),
    ].join("\n");
    const r = buildInstrumentationReport("", text, { nowMs: NOW, horizonMs: H });
    const sol = r.micro.latest.find((m) => m.sym === "SOLUSDT")!;
    expect(sol.imb20).toBeCloseTo(0.046, 9);
    expect(sol.bidUsd20).toBe(7_258_455);
    expect(r.micro.latest.find((m) => m.sym === "BNBUSDT")!.oi).toBeNull();
  });

  it("an empty micro log reports zeros and nulls, never a crash", () => {
    const r = buildInstrumentationReport("", "", { nowMs: NOW, horizonMs: H });
    expect(r.micro).toMatchObject({ symbols: 0, snapshots: 0, firstAt: null, lastAt: null, blocks: 0 });
    expect(r.micro.latest).toEqual([]);
  });
});

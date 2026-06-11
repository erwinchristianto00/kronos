import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FROZEN_LANE,
  FrozenCurrentGuardStore,
  buildFrozenCurrentGuardReport,
  getFrozenCurrentGuardStore,
  toFrozenObservations,
  _resetFrozenCurrentGuardStoreForTests,
  type FrozenCurrentGuardObservation,
} from "../src/lib/base-route-current-guard-frozen.js";
import type { CurrentGuardClosedPosition } from "../src/lib/base-route-current-guard-stability-audit.js";

let tmp: string;
let seq = 0;

function pos(override: Partial<CurrentGuardClosedPosition> = {}): CurrentGuardClosedPosition {
  seq += 1;
  const base = new Date("2026-05-10T00:00:00.000Z").getTime();
  const ms = base + seq * 60 * 60 * 1000;
  return {
    symbol: "ETHUSDT",
    direction: "LONG",
    grossR: 0.4,
    netR: 0.2,
    costR: 0.2,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    policyVersion: "base-route-anchor-consistent-v2",
    openedAt: new Date(ms).toISOString(),
    closedAt: new Date(ms + 30 * 60 * 1000).toISOString(),
    ...override,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "frozen-cg-"));
  _resetFrozenCurrentGuardStoreForTests();
});
afterEach(() => {
  _resetFrozenCurrentGuardStoreForTests();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("base route current-guard frozen prospective tape (F***)", () => {
  it("test 11: mirrors qualifying observations and dedupes by observationKey", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const obs = toFrozenObservations([pos({ symbol: "ETHUSDT" }), pos({ symbol: "SOLUSDT" })]);
    const r1 = store.mirror(obs);
    expect(r1.added).toBe(2);
    // re-mirror the SAME observations → no new additions
    const r2 = store.mirror(obs);
    expect(r2.added).toBe(0);
    expect(store.all.length).toBe(2);
  });

  it("test 12: re-mirror updates OPEN → CLOSED status without changing criteria", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const openObs: FrozenCurrentGuardObservation = {
      reportOnly: true,
      laneVersion: FROZEN_LANE,
      observationKey: "ETHUSDT|LONG|2026-05-10T01:00:00.000Z",
      symbol: "ETHUSDT",
      direction: "LONG",
      openedAt: "2026-05-10T01:00:00.000Z",
      closedAt: null,
      status: "OPEN",
      grossR: null,
      netR: null,
      costR: null,
      regime: "BULLISH_EXPANSION",
      entryVariant: "base_current_entry",
      exitVariant: "tp1_full_exit",
      policyVersion: "base-route-anchor-consistent-v2",
      mirroredAt: new Date().toISOString(),
    };
    store.mirror([openObs]);
    const criteriaBefore = store.getCriteria();
    const closedObs: FrozenCurrentGuardObservation = {
      ...openObs,
      closedAt: "2026-05-10T02:00:00.000Z",
      status: "CLOSED_WIN",
      grossR: 0.5,
      netR: 0.3,
      costR: 0.2,
    };
    const r = store.mirror([closedObs]);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    expect(store.all[0]!.status).toBe("CLOSED_WIN");
    expect(store.all[0]!.grossR).toBe(0.5);
    // criteria unchanged
    expect(store.getCriteria()).toEqual(criteriaBefore);
  });

  it("test 13: criteria snapshot stored once and immutable", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    store.mirror(toFrozenObservations([pos()]));
    const c1 = store.getCriteria();
    expect(c1).not.toBeNull();
    expect(c1!.version).toBe(FROZEN_LANE);
    expect(c1!.criteria.minStopDistanceBps).toBe(175);
    store.mirror(toFrozenObservations([pos({ symbol: "SOLUSDT" })]));
    expect(store.getCriteria()!.frozenAt).toBe(c1!.frozenAt);
  });

  it("test 14: report status COLLECTING when resolved < 50", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    store.mirror(toFrozenObservations(Array.from({ length: 10 }, () => pos())));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.resolved).toBe(10);
    expect(report.status).toBe("COLLECTING");
  });

  it("test 15: report status WATCHABLE when resolved ≥ 50 and net > 0", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];
    const positions = Array.from({ length: 60 }, (_, i) =>
      pos({ grossR: 0.3, netR: 0.1, costR: 0.2, symbol: symbols[i % symbols.length]! }),
    );
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.resolved).toBe(60);
    expect(report.netAvgR!).toBeGreaterThan(0);
    expect(report.status).toBe("WATCHABLE");
  });

  it("test 16: store path is base-route-current-guard-frozen.json, NOT shadow-positions.json (isolation)", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    expect(store.path.endsWith("base-route-current-guard-frozen.json")).toBe(true);
    expect(store.path.includes("shadow-positions.json")).toBe(false);
  });

  it("test 17: store never throws on write failure", () => {
    // Point the store at a path that is a directory collision to force write failure.
    const store = new FrozenCurrentGuardStore(tmp);
    // Replace the file path with a directory to make writeFileSync throw.
    // @ts-expect-error — accessing private for fault injection
    store.file = tmp; // tmp is a directory → writeFileSync will throw, caught internally
    expect(() => store.mirror(toFrozenObservations([pos()]))).not.toThrow();
    expect(() => store.save()).not.toThrow();
  });

  it("singleton getter returns same instance and reset clears it", () => {
    const a = getFrozenCurrentGuardStore(tmp);
    const b = getFrozenCurrentGuardStore(tmp);
    expect(a).toBe(b);
    _resetFrozenCurrentGuardStoreForTests();
    const c = getFrozenCurrentGuardStore(tmp);
    expect(c).not.toBe(a);
  });

  it("test 7: ETA calculation — freshValid=50 over 4 days → eta to n=100 ≈ 4 days, n=200 ≈ 12 days", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];
    // 50 observations spread across exactly 4 distinct days → freshValidPerDay = 12.5
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    const positions = Array.from({ length: 50 }, (_, i) => {
      const day = i % 4; // 4 distinct days
      const ms = dayBase + day * 86400000 + Math.floor(i / 4) * 60 * 1000;
      return pos({
        grossR: 0.3,
        netR: 0.1,
        costR: 0.2,
        symbol: symbols[i % symbols.length]!,
        openedAt: new Date(ms).toISOString(),
        closedAt: new Date(ms + 30000).toISOString(),
      });
    });
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.freshValid).toBe(50);
    expect(report.daysCovered).toBe(4);
    expect(report.velocity.freshValidPerDay).toBeCloseTo(12.5, 5);
    expect(report.velocity.etaToN100Days).toBeCloseTo((100 - 50) / 12.5, 5); // 4
    expect(report.velocity.etaToN200Days).toBeCloseTo((200 - 50) / 12.5, 5); // 12
    expect(report.velocity.etaToN100Date).not.toBeNull();
    expect(report.velocity.etaToN200Date).not.toBeNull();
  });

  it("test 8: ETA null when velocity is 0 (no fresh-valid observations)", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    // OPEN observations only → resolved=0, freshValid=0
    const openObs: FrozenCurrentGuardObservation = {
      reportOnly: true,
      laneVersion: FROZEN_LANE,
      observationKey: "ETHUSDT|LONG|2026-05-10T01:00:00.000Z",
      symbol: "ETHUSDT",
      direction: "LONG",
      openedAt: "2026-05-10T01:00:00.000Z",
      closedAt: null,
      status: "OPEN",
      grossR: null,
      netR: null,
      costR: null,
      regime: "BULLISH_EXPANSION",
      entryVariant: "base_current_entry",
      exitVariant: "tp1_full_exit",
      policyVersion: "base-route-anchor-consistent-v2",
      mirroredAt: new Date().toISOString(),
    };
    store.mirror([openObs]);
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.freshValid).toBe(0);
    expect(report.velocity.freshValidPerDay).toBe(0);
    expect(report.velocity.etaToN100Days).toBeNull();
    expect(report.velocity.etaToN200Days).toBeNull();
    expect(report.velocity.etaToN100Date).toBeNull();
  });

  it("test 9: OOS watch — seg1 negative → STABILITY_BLOCKED, positiveSegmentCount=2, weakest=segment_1", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    // 9 time-ordered observations: first third negative, middle + last thirds positive.
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    const mk = (i: number, grossR: number, netR: number) =>
      pos({
        grossR,
        netR,
        costR: 0.2,
        symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT"][i % 3]!,
        openedAt: new Date(dayBase + i * 3600000).toISOString(),
        closedAt: new Date(dayBase + i * 3600000 + 60000).toISOString(),
      });
    const positions = [
      mk(0, -0.3, -0.32),
      mk(1, -0.4, -0.42),
      mk(2, -0.2, -0.22),
      mk(3, 0.3, 0.12),
      mk(4, 0.3, 0.12),
      mk(5, 0.3, 0.12),
      mk(6, 0.6, 0.48),
      mk(7, 0.6, 0.48),
      mk(8, 0.6, 0.48),
    ];
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.oosWatch.stabilityStatus).toBe("STABILITY_BLOCKED");
    expect(report.oosWatch.positiveSegmentCount).toBe(2);
    expect(report.oosWatch.allSegmentsPositive).toBe(false);
    expect(report.oosWatch.weakestSegment?.label).toBe("segment_1");
    expect(report.oosWatch.requiredFuturePositiveSegments).toBe(1);
    expect(report.oosWatch.note).toContain("STABILITY_BLOCKED");
  });

  it("test 10: OOS watch — all 3 segments positive → STABILITY_OK", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    const positions = Array.from({ length: 9 }, (_, i) =>
      pos({
        grossR: 0.4,
        netR: 0.2,
        costR: 0.2,
        symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT"][i % 3]!,
        openedAt: new Date(dayBase + i * 3600000).toISOString(),
        closedAt: new Date(dayBase + i * 3600000 + 60000).toISOString(),
      }),
    );
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.oosWatch.allSegmentsPositive).toBe(true);
    expect(report.oosWatch.positiveSegmentCount).toBe(3);
    expect(report.oosWatch.stabilityStatus).toBe("STABILITY_OK");
    expect(report.oosWatch.requiredFuturePositiveSegments).toBe(0);
  });

  it("loads existing observations and criteria from disk", () => {
    const filePath = join(tmp, "base-route-current-guard-frozen.json");
    const payload = {
      criteria: {
        version: FROZEN_LANE,
        frozenAt: "2026-05-01T00:00:00.000Z",
        criteria: {
          guardEra: "RISK_HYGIENE_GUARD_V1",
          minStopDistanceBps: 175,
          policyVersion: "base-route-anchor-consistent-v2",
          description: "test",
        },
      },
      observations: toFrozenObservations([pos()]),
    };
    writeFileSync(filePath, JSON.stringify(payload), "utf-8");
    const store = new FrozenCurrentGuardStore(tmp);
    expect(store.all.length).toBe(1);
    expect(store.getCriteria()!.frozenAt).toBe("2026-05-01T00:00:00.000Z");
  });

  // ── OOS Segment Forensics tests ────────────────────────────────────────────

  it("F*** forensics: oosSegmentForensics null when fewer than 3 observations", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    store.mirror(toFrozenObservations([pos(), pos()]));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.oosSegmentForensics).toBeNull();
  });

  it("F*** forensics: produces 3 segments with correct structure when ≥3 obs", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    const positions = Array.from({ length: 9 }, (_, i) =>
      pos({
        grossR: i < 3 ? -0.3 : 0.4,
        netR: i < 3 ? -0.35 : 0.22,
        costR: 0.05,
        symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT"][i % 3]!,
        entryVariant: i < 3 ? "breakout_entry" : "base_current_entry",
        regime: i < 3 ? "RANGING" : "BULLISH_EXPANSION",
        openedAt: new Date(dayBase + i * 3600000).toISOString(),
        closedAt: new Date(dayBase + i * 3600000 + 60000).toISOString(),
      }),
    );
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    expect(report.oosSegmentForensics).not.toBeNull();
    const [f1, f2, f3] = report.oosSegmentForensics!;

    // segment 1 (losing)
    expect(f1.segmentLabel).toBe("segment_1");
    expect(f1.n).toBe(3);
    expect(f1.netAvgR).toBeLessThan(0);
    expect(f1.avgCostR).toBeCloseTo(0.05, 4);
    expect(f1.bySymbol.length).toBeGreaterThan(0);
    expect(f1.byEntryVariant.length).toBeGreaterThan(0);
    expect(f1.byRegime.length).toBeGreaterThan(0);
    // worst-first sort — segment 1 entries are all RANGING / breakout_entry (all losing)
    expect(f1.losingTrades.length).toBe(3);
    expect(f1.topLossContributors.length).toBe(3); // only 3 total

    // segment 2 and 3 are all wins → no losing trades
    expect(f2.losingTrades.length).toBe(0);
    expect(f3.losingTrades.length).toBe(0);
  });

  it("F*** forensics: bySymbol sorted worst-first", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    // 6 observations split into 3 segments of 2:
    // seg1: ETHUSDT loss, SOLUSDT loss
    // seg2: ETHUSDT win, SOLUSDT win
    // seg3: ETHUSDT win, SOLUSDT win
    const positions = [
      pos({ symbol: "ETHUSDT", grossR: -0.5, netR: -0.55, costR: 0.05, openedAt: new Date(dayBase).toISOString(), closedAt: new Date(dayBase + 60000).toISOString() }),
      pos({ symbol: "SOLUSDT", grossR: -0.2, netR: -0.25, costR: 0.05, openedAt: new Date(dayBase + 3600000).toISOString(), closedAt: new Date(dayBase + 3660000).toISOString() }),
      pos({ symbol: "ETHUSDT", grossR: 0.4, netR: 0.35, costR: 0.05, openedAt: new Date(dayBase + 7200000).toISOString(), closedAt: new Date(dayBase + 7260000).toISOString() }),
      pos({ symbol: "SOLUSDT", grossR: 0.4, netR: 0.35, costR: 0.05, openedAt: new Date(dayBase + 10800000).toISOString(), closedAt: new Date(dayBase + 10860000).toISOString() }),
      pos({ symbol: "ETHUSDT", grossR: 0.6, netR: 0.55, costR: 0.05, openedAt: new Date(dayBase + 14400000).toISOString(), closedAt: new Date(dayBase + 14460000).toISOString() }),
      pos({ symbol: "SOLUSDT", grossR: 0.6, netR: 0.55, costR: 0.05, openedAt: new Date(dayBase + 18000000).toISOString(), closedAt: new Date(dayBase + 18060000).toISOString() }),
    ];
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    const [f1] = report.oosSegmentForensics!;
    // both symbols appear, ETHUSDT worse (net=-0.55) than SOLUSDT (net=-0.25) → ETHUSDT first
    expect(f1.bySymbol[0]!.key).toBe("ETHUSDT");
    expect(f1.bySymbol[0]!.netAvgR).toBeLessThan(f1.bySymbol[1]!.netAvgR!);
  });

  it("F*** forensics: stop bucket label UNKNOWN when stopDistanceBps absent", () => {
    const store = new FrozenCurrentGuardStore(tmp);
    const dayBase = new Date("2026-05-10T00:00:00.000Z").getTime();
    const positions = Array.from({ length: 3 }, (_, i) =>
      pos({
        grossR: 0.3,
        netR: 0.1,
        openedAt: new Date(dayBase + i * 3600000).toISOString(),
        closedAt: new Date(dayBase + i * 3600000 + 60000).toISOString(),
      }),
    );
    store.mirror(toFrozenObservations(positions));
    const report = buildFrozenCurrentGuardReport(store);
    const [f1] = report.oosSegmentForensics!;
    // no stopDistanceBps supplied → all fall into UNKNOWN bucket
    expect(f1.byStopBucket.some((b) => b.key === "UNKNOWN")).toBe(true);
    expect(f1.byStopBucket.find((b) => b.key === "UNKNOWN")!.n).toBe(f1.n);
  });

  it("F*** forensics: stopDistanceBps mirrored from CurrentGuardClosedPosition", () => {
    const p = pos({ stopDistanceBps: 210 });
    const obs = toFrozenObservations([p]);
    expect(obs[0]!.stopDistanceBps).toBe(210);
  });
});

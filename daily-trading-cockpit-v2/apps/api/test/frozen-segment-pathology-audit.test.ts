import { describe, it, expect } from "vitest";

import {
  buildFrozenSegmentPathologyAudit,
  type FrozenSegmentPathologyAudit,
} from "../src/lib/frozen-segment-pathology-audit.js";
import type { FrozenCurrentGuardObservation } from "../src/lib/base-route-current-guard-frozen.js";

const FROZEN_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;
let seq = 0;

function obs(
  i: number,
  override: Partial<FrozenCurrentGuardObservation> = {},
): FrozenCurrentGuardObservation {
  seq += 1;
  const base = new Date("2026-05-01T00:00:00.000Z").getTime();
  const ms = base + i * 3_600_000;
  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    observationKey: `SYM|LONG|${new Date(ms).toISOString()}`,
    symbol: "ETHUSDT",
    direction: "LONG",
    openedAt: new Date(ms).toISOString(),
    closedAt: new Date(ms + 1_800_000).toISOString(),
    status: "CLOSED_WIN",
    grossR: 0.4,
    netR: 0.22,
    costR: 0.18,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    policyVersion: "base-route-anchor-consistent-v2",
    mirroredAt: new Date(ms + 3_600_000).toISOString(),
    ...override,
  } as FrozenCurrentGuardObservation;
}

/** Build a 9-observation tape: seg 1 (0-2) losing, seg 2 (3-5) and seg 3 (6-8) winning. */
function buildTape9(seg1Loser = true): FrozenCurrentGuardObservation[] {
  return Array.from({ length: 9 }, (_, i) => {
    const losing = seg1Loser && i < 3;
    return obs(i, {
      symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT"][i % 3]!,
      observationKey: `SYM${i}|LONG|${i}`,
      grossR: losing ? -0.3 : 0.4,
      netR: losing ? -0.35 : 0.22,
      entryVariant: i < 3 ? "fib_500_entry" : "base_current_entry",
      regime: i < 3 ? "RANGING" : "BULLISH_EXPANSION",
    });
  });
}

describe("F***** frozen segment pathology audit", () => {
  it("returns INSUFFICIENT_DATA when <9 observations", () => {
    const tape = Array.from({ length: 5 }, (_, i) =>
      obs(i, { observationKey: `K${i}|LONG|${i}`, grossR: 0.2, netR: 0.1 }),
    );
    const r = buildFrozenSegmentPathologyAudit(tape);
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.reportOnly).toBe(true);
  });

  it("reportOnly is always true", () => {
    const r = buildFrozenSegmentPathologyAudit([]);
    expect(r.reportOnly).toBe(true);
  });

  it("seg1Stats matches oldest-third stats", () => {
    const tape = buildTape9();
    const r = buildFrozenSegmentPathologyAudit(tape);
    // seg 1 = first 3 obs → all losing
    expect(r.seg1N).toBe(3);
    expect(r.seg1Stats.netAvgR).toBeLessThan(0);
  });

  it("[1] withoutTop4: removing 3 worst losses from a 3-loss seg-1 → n=0 remaining", () => {
    const tape = buildTape9();
    const r = buildFrozenSegmentPathologyAudit(tape);
    // seg-1 has exactly 3 losing trades; top-4 removes all 3 (capped at existing)
    expect(r.withoutTop4.excludedCount).toBe(3);
    expect(r.withoutTop4.stats.n).toBe(0);
  });

  it("[1] withoutTop4 note signals tail-concentration when result turns positive", () => {
    // seg-1: 3 trades — 2 small wins, 1 big loss
    const tape = [
      obs(0, { observationKey: "A|LONG|0", grossR: 0.2, netR: 0.1 }),
      obs(1, { observationKey: "B|LONG|1", grossR: 0.2, netR: 0.1 }),
      obs(2, { observationKey: "C|LONG|2", grossR: -2.0, netR: -2.1 }),
      obs(3, { observationKey: "D|LONG|3", grossR: 0.4, netR: 0.3 }),
      obs(4, { observationKey: "E|LONG|4", grossR: 0.4, netR: 0.3 }),
      obs(5, { observationKey: "F|LONG|5", grossR: 0.4, netR: 0.3 }),
      obs(6, { observationKey: "G|LONG|6", grossR: 0.4, netR: 0.3 }),
      obs(7, { observationKey: "H|LONG|7", grossR: 0.4, netR: 0.3 }),
      obs(8, { observationKey: "I|LONG|8", grossR: 0.4, netR: 0.3 }),
    ];
    const r = buildFrozenSegmentPathologyAudit(tape);
    // Without the 1 big loss, seg-1 has 2 winners → netAvgR > 0
    expect(r.withoutTop4.stats.netAvgR).toBeGreaterThan(0);
    expect(r.withoutTop4.note).toContain("Turns POSITIVE");
  });

  it("[2] excludingBadActors: no SEI/LINK/OP in seg-1 → excludedCount=0", () => {
    const tape = buildTape9();
    const r = buildFrozenSegmentPathologyAudit(tape);
    expect(r.excludingBadActors.excludedCount).toBe(0);
    // ETHUSDT/SOLUSDT/ADAUSDT — none are SEI/LINK/OP
    expect(r.excludingBadActors.stats.n).toBe(r.seg1N);
  });

  it("[2] excludingBadActors: SEIUSDT/LINKUSDT/OPUSDT excluded from seg-1", () => {
    const tape = [
      obs(0, { observationKey: "S|LONG|0", symbol: "SEIUSDT", grossR: -0.8, netR: -0.85 }),
      obs(1, { observationKey: "L|LONG|1", symbol: "LINKUSDT", grossR: -0.5, netR: -0.55 }),
      obs(2, { observationKey: "O|LONG|2", symbol: "OPUSDT", grossR: -0.4, netR: -0.45 }),
      obs(3, { observationKey: "A|LONG|3", grossR: 0.4, netR: 0.3 }),
      obs(4, { observationKey: "B|LONG|4", grossR: 0.4, netR: 0.3 }),
      obs(5, { observationKey: "C|LONG|5", grossR: 0.4, netR: 0.3 }),
      obs(6, { observationKey: "D|LONG|6", grossR: 0.4, netR: 0.3 }),
      obs(7, { observationKey: "E|LONG|7", grossR: 0.4, netR: 0.3 }),
      obs(8, { observationKey: "F|LONG|8", grossR: 0.4, netR: 0.3 }),
    ];
    const r = buildFrozenSegmentPathologyAudit(tape);
    // seg-1 = first 3 = all SEI/LINK/OP
    expect(r.excludingBadActors.excludedCount).toBe(3);
    expect(r.excludingBadActors.stats.n).toBe(0);
    expect(r.excludingBadActors.note).toContain("old-batch signal");
  });

  it("[3] seg1ByDateBatch: groups by week, or falls back to 3 chunks when 1 week", () => {
    const tape = buildTape9(); // all within first week of May 2026
    const r = buildFrozenSegmentPathologyAudit(tape);
    // 3 observations all close in time → likely 1 week → chunk fallback
    expect(r.seg1ByDateBatch.length).toBeGreaterThanOrEqual(1);
    const totalN = r.seg1ByDateBatch.reduce((s, b) => s + b.n, 0);
    expect(totalN).toBe(r.seg1N);
  });

  it("[4] fib500Comparison: INSUFFICIENT_DATA when seg-1 has <3 fib_500 trades", () => {
    // seg-1: only 1 fib_500 trade
    const tape = [
      obs(0, { observationKey: "A|LONG|0", entryVariant: "fib_500_entry", grossR: -0.3, netR: -0.35 }),
      obs(1, { observationKey: "B|LONG|1", entryVariant: "base_current_entry", grossR: -0.3, netR: -0.35 }),
      obs(2, { observationKey: "C|LONG|2", entryVariant: "base_current_entry", grossR: -0.3, netR: -0.35 }),
      obs(3, { observationKey: "D|LONG|3", grossR: 0.4, netR: 0.3 }),
      obs(4, { observationKey: "E|LONG|4", grossR: 0.4, netR: 0.3 }),
      obs(5, { observationKey: "F|LONG|5", grossR: 0.4, netR: 0.3 }),
      obs(6, { observationKey: "G|LONG|6", grossR: 0.4, netR: 0.3 }),
      obs(7, { observationKey: "H|LONG|7", grossR: 0.4, netR: 0.3 }),
      obs(8, { observationKey: "I|LONG|8", grossR: 0.4, netR: 0.3 }),
    ];
    const r = buildFrozenSegmentPathologyAudit(tape);
    expect(r.fib500Comparison.signal).toBe("INSUFFICIENT_DATA");
  });

  it("[4] fib500Comparison: IMPROVED when post-seg-1 fib_500 net is materially higher", () => {
    // seg-1: 3 fib_500 trades all losing; post-seg-1: 6 fib_500 trades all winning
    const tape = Array.from({ length: 9 }, (_, i) =>
      obs(i, {
        observationKey: `K${i}|LONG|${i}`,
        entryVariant: "fib_500_entry",
        grossR: i < 3 ? -0.3 : 0.5,
        netR: i < 3 ? -0.35 : 0.42,
      }),
    );
    const r = buildFrozenSegmentPathologyAudit(tape);
    expect(r.fib500Comparison.signal).toBe("IMPROVED");
  });

  it("[5] postSeg1Tape stats cover seg 2+3 combined", () => {
    const tape = buildTape9();
    const r = buildFrozenSegmentPathologyAudit(tape);
    // 9 obs, seg-1 = 3, post = 6
    expect(r.postSeg1Tape.stats.n).toBe(6);
    expect(r.postSeg1Tape.stats.netAvgR).toBeGreaterThan(0);
  });

  it("[6] entryMixTransition: mix rows sum to 100%", () => {
    const tape = buildTape9();
    const r = buildFrozenSegmentPathologyAudit(tape);
    const seg1Total = r.entryMixTransition.seg1Mix.reduce((s, x) => s + x.sharePct, 0);
    expect(Math.round(seg1Total)).toBe(100);
  });

  it("[6] entryMixTransition: mixDrifted when fib_500 usage drops >15pp", () => {
    // seg-1: all fib_500; post-seg-1: all base_current_entry
    const tape = Array.from({ length: 9 }, (_, i) =>
      obs(i, {
        observationKey: `K${i}|LONG|${i}`,
        entryVariant: i < 3 ? "fib_500_entry" : "base_current_entry",
        grossR: i < 3 ? -0.3 : 0.4,
        netR: i < 3 ? -0.35 : 0.3,
      }),
    );
    const r = buildFrozenSegmentPathologyAudit(tape);
    expect(r.entryMixTransition.mixDrifted).toBe(true);
    expect(r.entryMixTransition.fib500ShareSeg1).toBeCloseTo(1.0, 2);
    expect(r.entryMixTransition.fib500SharePostSeg1).toBeCloseTo(0.0, 2);
  });

  it("verdict OLD_BATCH: ≥3 old-batch signals trigger OLD_BATCH verdict", () => {
    // seg-1 bad actors + fib_500 improves + tail-concentrated
    // Construct: seg-1 = 3 SEI/LINK/OP losses, post-seg-1 = 6 wins with fib_500 improvement
    const tape = [
      obs(0, { observationKey: "S|LONG|0", symbol: "SEIUSDT", entryVariant: "fib_500_entry", grossR: -0.6, netR: -0.65 }),
      obs(1, { observationKey: "L|LONG|1", symbol: "LINKUSDT", entryVariant: "fib_500_entry", grossR: -0.5, netR: -0.55 }),
      obs(2, { observationKey: "O|LONG|2", symbol: "OPUSDT", entryVariant: "fib_500_entry", grossR: -0.4, netR: -0.45 }),
      obs(3, { observationKey: "D|LONG|3", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(4, { observationKey: "E|LONG|4", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(5, { observationKey: "F|LONG|5", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(6, { observationKey: "G|LONG|6", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(7, { observationKey: "H|LONG|7", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(8, { observationKey: "I|LONG|8", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
    ];
    const r = buildFrozenSegmentPathologyAudit(tape);
    // excl bad actors → n=0, turns positive (trivially); fib_500 improves; excl removes all losses
    expect(r.verdict).toBe("OLD_BATCH");
  });
});

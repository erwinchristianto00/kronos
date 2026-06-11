import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FrozenCurrentGuardStore,
  buildFrozenCurrentGuardReport,
  type FrozenCurrentGuardObservation,
} from "../src/lib/base-route-current-guard-frozen.js";
import {
  PostCutoverStore,
  buildPostCutoverReport,
  POST_CUTOVER_LANE,
  POST_CUTOVER_REASON,
} from "../src/lib/frozen-current-guard-post-cutover.js";
import { buildFrozenSegmentPathologyAudit } from "../src/lib/frozen-segment-pathology-audit.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import type { FrozenSegmentPathologyAudit } from "../src/lib/frozen-segment-pathology-audit.js";

const FROZEN_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;
const FROZEN_FULL_TAPE_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1";

/** OLD_BATCH verdict stub — ensureBoundary only reads `verdict`. */
const OLD_BATCH_STUB = { verdict: "OLD_BATCH" } as unknown as FrozenSegmentPathologyAudit;

function obs(
  i: number,
  override: Partial<FrozenCurrentGuardObservation> = {},
): FrozenCurrentGuardObservation {
  const base = new Date("2026-05-01T00:00:00.000Z").getTime();
  const ms = base + i * 3_600_000;
  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    observationKey: `K${i}|LONG|${i}`,
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
    stopDistanceBps: 210,
    mirroredAt: new Date(ms + 3_600_000).toISOString(),
    ...override,
  } as FrozenCurrentGuardObservation;
}

/**
 * Build a tape where the first `seg1Size` (oldest, by time) trades are heavy
 * losses and the rest are wins. With n=12, seg1 (first third) is 4 losers.
 */
function buildSplitTape(n: number, seg1Size: number): FrozenCurrentGuardObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const losing = i < seg1Size;
    return obs(i, {
      symbol: ["ETHUSDT", "SOLUSDT", "ADAUSDT", "BNBUSDT"][i % 4]!,
      grossR: losing ? -0.5 : 0.4,
      netR: losing ? -0.5 : 0.22,
      status: losing ? "CLOSED_LOSS" : "CLOSED_WIN",
      entryVariant: losing ? "fib_500_entry" : "base_current_entry",
    });
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pc-test-"));
}

function makeFrozen(tape: FrozenCurrentGuardObservation[]) {
  const store = new FrozenCurrentGuardStore(tmp());
  store.mirror(tape);
  return { store, report: buildFrozenCurrentGuardReport(store) };
}

describe("F****** frozen current-guard post-cutover tape", () => {
  it("reportOnly is always true", () => {
    const { report } = makeFrozen(buildSplitTape(12, 4));
    const pc = buildPostCutoverReport(report, null, null);
    expect(pc.reportOnly).toBe(true);
    expect(pc.laneId).toBe(POST_CUTOVER_LANE);
  });

  it("AWAITING_CUTOVER when no boundary is locked", () => {
    const { report } = makeFrozen(buildSplitTape(12, 4));
    const pc = buildPostCutoverReport(report, null, null);
    expect(pc.status).toBe("AWAITING_CUTOVER");
    expect(pc.cutoverActive).toBe(false);
    expect(pc.freshValid).toBe(0);
  });

  it("ensureBoundary does NOT lock unless verdict is OLD_BATCH", () => {
    const { report } = makeFrozen(buildSplitTape(12, 4));
    const pcStore = new PostCutoverStore(tmp());
    const b = pcStore.ensureBoundary(report, {
      verdict: "MIXED",
    } as unknown as FrozenSegmentPathologyAudit);
    expect(b).toBeNull();
    expect(pcStore.getBoundary()).toBeNull();
  });

  it("ensureBoundary does NOT lock with <9 fresh-valid observations", () => {
    const { report } = makeFrozen(buildSplitTape(6, 2));
    const pcStore = new PostCutoverStore(tmp());
    const b = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    expect(b).toBeNull();
  });

  it("ensureBoundary locks at end of Segment 1 with the correct reason", () => {
    const { report } = makeFrozen(buildSplitTape(12, 4));
    const pcStore = new PostCutoverStore(tmp());
    const b = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe(POST_CUTOVER_REASON);
    // n=12 → third=4 → cutover is the 4th (index 3) time-ordered observation.
    const sorted = report.resolvedObservations;
    expect(b!.cutoverTimestamp).toBe(sorted[3]!.closedAt);
    expect(b!.derivedFrom.seg1NAtLock).toBe(4);
  });

  // ── Test 1: Segment 1 (OLD_BATCH) does NOT get deleted ──────────────────────
  it("[1] Segment 1 is NOT deleted from the frozen tape", () => {
    const tape = buildSplitTape(12, 4);
    const { store, report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    // Frozen store still holds all 12 observations including Segment 1.
    expect(store.all.length).toBe(12);
    expect(report.resolvedObservations.length).toBe(12);
    // Segment-1 losing observations are still present.
    const losers = store.all.filter((o) => (o.netR ?? 0) < 0);
    expect(losers.length).toBe(4);
  });

  // ── Test 2: post-cutover tape excludes the old-batch segment from math ──────
  it("[2] post-cutover tape excludes the old-batch segment from promotion math", () => {
    const tape = buildSplitTape(12, 4);
    const { report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    // 12 total, seg1=4 → post-cutover keeps the 8 winners.
    expect(pc.freshValid).toBe(8);
    expect(pc.netAvgR).not.toBeNull();
    expect(pc.netAvgR!).toBeCloseTo(0.22, 5);
    // None of the post-cutover observations are losers.
    expect(pc.bySymbol.every((r) => (r.netAvgR ?? 0) > 0)).toBe(true);
  });

  // ── R-sanity quarantine: fabricated R from the pre-fix denominator bug ──────
  it("[2b] physically implausible |R| (>20R) is quarantined from both tapes and surfaced, never silent", () => {
    const tape = buildSplitTape(12, 4);
    // The audit's real-world case: a trail runner mirrored at +201R on a signal whose honest
    // outcome was ≈0..1R (R divided by the moved stop). It must not feed any economics.
    tape.push(obs(12, {
      grossR: 221.77,
      netR: 201.23,
      status: "CLOSED_WIN",
      exitVariant: "trail_after_tp1",
    }));
    const { report } = makeFrozen(tape);

    // Frozen full tape: outlier excluded + counted; economics unchanged by the fabrication.
    expect(report.rSanityExcludedCount).toBe(1);
    expect(report.freshValid).toBe(12);
    expect(report.netAvgR!).toBeCloseTo((4 * -0.5 + 8 * 0.22) / 12, 5);

    // Post-cutover tape: the lane dashboards surface must not be inflated either, and the
    // upstream exclusion must propagate so the data-quality caution is visible HERE.
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    expect(pc.freshValid).toBe(8);
    expect(pc.netAvgR!).toBeCloseTo(0.22, 5);
    expect(pc.rSanityExcludedCount).toBe(1);
    expect(pc.cautions.some((c) => c.includes("DATA QUALITY"))).toBe(true);
  });

  // ── Test 3: post-cutover status independent from full-tape status ───────────
  it("[3] post-cutover metrics are independent from the full-tape metrics", () => {
    const tape = buildSplitTape(12, 4);
    const { report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    // Full frozen tape is net-negative (heavy seg-1 losses drag it under).
    expect(report.netAvgR).not.toBeNull();
    expect(report.netAvgR!).toBeLessThan(0);
    // Post-cutover tape is net-positive — a different sample, different verdict.
    expect(pc.netAvgR!).toBeGreaterThan(0);
    expect(pc.freshValid).not.toBe(report.freshValid);
  });

  // ── Test 4: AD nearest candidate prefers post-cutover when stronger ─────────
  it("[4] AD nearest candidate prefers post-cutover once n>=50", () => {
    // 75 obs → third=25 seg1; post-cutover = 50 obs (>=50 preference threshold).
    const tape = buildSplitTape(75, 25);
    const { report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    expect(pc.freshValid).toBeGreaterThanOrEqual(50);

    const gate = buildLiveTradingGateReport({
      frozenCurrentGuardReport: report,
      postCutoverReport: pc,
    });
    expect(gate.nearestCandidateLane).not.toBeNull();
    expect(gate.nearestCandidateLane!.lane).toBe(POST_CUTOVER_LANE);
    expect(gate.nearestCandidateLane!.provenance).toBe("prospective");
  });

  it("[4b] full frozen tape still surfaced when post-cutover has <50 (no regression)", () => {
    const tape = buildSplitTape(30, 10); // post-cutover = 20 (<50), frozen resolved=30 (>=20)
    const { report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    const gate = buildLiveTradingGateReport({
      frozenCurrentGuardReport: report,
      postCutoverReport: pc,
    });
    expect(gate.nearestCandidateLane!.lane).toBe(FROZEN_FULL_TAPE_LANE);
  });

  // ── Test 5: liveBlocked remains true ────────────────────────────────────────
  it("[5] liveBlocked remains true and microPilotAllowed false with a strong post-cutover tape", () => {
    const tape = buildSplitTape(75, 25);
    const { report } = makeFrozen(tape);
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    const pc = buildPostCutoverReport(report, boundary, null);
    const gate = buildLiveTradingGateReport({
      frozenCurrentGuardReport: report,
      postCutoverReport: pc,
    });
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
    // Even when infra flags are forced ready, status can't reach PROMOTION_CANDIDATE
    // because freshValid<200 — so liveBlocked stays true.
    const pcInfra = buildPostCutoverReport(report, boundary, null, {
      killSwitchReady: true,
      orderReconciliationReady: true,
      exchangeHealthReady: true,
    });
    expect(pcInfra.status).not.toBe("PROMOTION_CANDIDATE");
  });

  // ── Test 6: no behavior changes ─────────────────────────────────────────────
  it("[6] store persists ONLY boundary metadata (no duplicated observations)", () => {
    const tape = buildSplitTape(12, 4);
    const { report } = makeFrozen(tape);
    const dir = tmp();
    const pcStore = new PostCutoverStore(dir);
    pcStore.ensureBoundary(report, OLD_BATCH_STUB);
    expect(existsSync(pcStore.path)).toBe(true);
    const parsed = JSON.parse(readFileSync(pcStore.path, "utf-8"));
    expect(Object.keys(parsed)).toEqual(["boundary"]);
    expect(parsed.boundary.observations).toBeUndefined();
  });

  it("[6b] cutover boundary is immutable once locked", () => {
    const dir = tmp();
    const { report: report12 } = makeFrozen(buildSplitTape(12, 4));
    const pcStore = new PostCutoverStore(dir);
    const first = pcStore.ensureBoundary(report12, OLD_BATCH_STUB);
    expect(first).not.toBeNull();
    // A later, larger tape would imply a different cutover — but the boundary is locked.
    const { report: report30 } = makeFrozen(buildSplitTape(30, 10));
    const second = pcStore.ensureBoundary(report30, OLD_BATCH_STUB);
    expect(second!.cutoverTimestamp).toBe(first!.cutoverTimestamp);
    // Reloading from disk yields the same locked boundary.
    const reloaded = new PostCutoverStore(dir);
    expect(reloaded.getBoundary()!.cutoverTimestamp).toBe(first!.cutoverTimestamp);
  });

  it("[6c] integration: a real OLD_BATCH pathology audit locks the cutover", () => {
    // Mirror the canonical OLD_BATCH shape (SEI/LINK/OP seg-1 losses, fib_500 wins after).
    const tape = [
      obs(0, { observationKey: "S|LONG|0", symbol: "SEIUSDT", entryVariant: "fib_500_entry", grossR: -0.6, netR: -0.65, status: "CLOSED_LOSS" }),
      obs(1, { observationKey: "L|LONG|1", symbol: "LINKUSDT", entryVariant: "fib_500_entry", grossR: -0.5, netR: -0.55, status: "CLOSED_LOSS" }),
      obs(2, { observationKey: "O|LONG|2", symbol: "OPUSDT", entryVariant: "fib_500_entry", grossR: -0.4, netR: -0.45, status: "CLOSED_LOSS" }),
      obs(3, { observationKey: "D|LONG|3", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(4, { observationKey: "E|LONG|4", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(5, { observationKey: "F|LONG|5", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(6, { observationKey: "G|LONG|6", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(7, { observationKey: "H|LONG|7", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
      obs(8, { observationKey: "I|LONG|8", entryVariant: "fib_500_entry", grossR: 0.5, netR: 0.45 }),
    ];
    const { report } = makeFrozen(tape);
    const pathology = buildFrozenSegmentPathologyAudit(report.resolvedObservations);
    expect(pathology.verdict).toBe("OLD_BATCH");
    const pcStore = new PostCutoverStore(tmp());
    const boundary = pcStore.ensureBoundary(report, pathology);
    expect(boundary).not.toBeNull();
    const pc = buildPostCutoverReport(report, boundary, null);
    // seg1 = 3 losers excluded; post-cutover = 6 winners.
    expect(pc.freshValid).toBe(6);
    expect(pc.netAvgR!).toBeGreaterThan(0);
  });
});

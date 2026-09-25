/**
 * LIVE-LANE WIRING (2026-08-02) — end-to-end tests through a REAL edge-lane store, proving:
 *  (a) liveLaneReport() genuinely, fail-closedly populates conservativeNetR/postFixExactLineage/
 *      costValid/fresh — never defaulting any of them to true;
 *  (b) a lane with real, valid evidence across all four fields CAN be selected by
 *      selectBestLaneReportForDirection/buildLiveBestLaneReportForDirection (previously
 *      structurally impossible, since liveLaneReport() never populated any of the four fields);
 *  (c) a lane whose evidence fails any ONE of the four fields is still rejected — tested
 *      individually, not just all four failing together.
 *
 * Uses the REGIME_COMPOSITE_CONFIRMATION_LONG (RC) lane store directly (RegimeCompositeStore),
 * the same store liveLaneReport() reads via getRegimeCompositeStore/_resetRegimeCompositeStoreForTests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RegimeCompositeStore,
  getRegimeCompositeStore,
  _resetRegimeCompositeStoreForTests,
  RC_PAPER_LANE_ID,
  RC_ATR_STOP_MULT,
  RC_MAX_HOLD_BARS,
  type RegimeCompositeObservation,
} from "../src/lib/regime-composite-edge.js";
import { EDGE_LANE_COST_MODEL_VERSION } from "../src/lib/edge-lane-cost-model.js";
import { liveLaneReport, LANE_REPORT_FRESHNESS_TTL_MS } from "../src/lib/cortex-live-gather-bindings.js";
import { selectBestLaneReportForDirection, buildLiveBestLaneReportForDirection } from "../src/lib/four-brain-best-lane-report.js";
import { FOUR_BRAIN_LANE_SUPPORT } from "../src/lib/four-brain-lane-support.js";
import { IM_PAPER_LANE_ID } from "../src/lib/intraday-momentum-edge.js";

const NOW = 1_800_000_000_000;
const DATA_DIR = `/tmp/cortex-live-gather-bindings-test-${Date.now()}-${Math.random()}`;
const HOUR_MS = 3_600_000;

function rcObs(over: Partial<RegimeCompositeObservation> = {}): RegimeCompositeObservation {
  const entryPrice = 100;
  const initialStop = entryPrice - RC_ATR_STOP_MULT * 4;
  return {
    observationId: `rc:TEST:${Math.random()}`,
    symbol: "TESTUSDT",
    direction: "LONG",
    entryPrice,
    initialStop,
    stopDistanceBps: ((entryPrice - initialStop) / entryPrice) * 10000,
    atrAtEntry: 4,
    axisScoreAtEntry: 0.5,
    crowdingStateAtEntry: "NEUTRAL",
    fundingBpsAtEntry: 0,
    entrySetup: "EMA20_RETEST_REJECTION",
    ema20AtEntry: 100,
    extensionAboveEmaAtr: 0.075,
    openedAt: new Date(NOW - HOUR_MS).toISOString(),
    openedAtMs: NOW - HOUR_MS,
    status: "CLOSED_WIN",
    grossR: 0.35,
    costR: 0.05,
    netR: 0.3,
    maxFavorableR: 0.5,
    exitReason: "MFE_GIVEBACK",
    resolvedAt: new Date(NOW - 30 * 60_000).toISOString(),
    postFixLineageV1: true,
    costModelVersion: EDGE_LANE_COST_MODEL_VERSION,
    ...over,
  };
}

/** 30 resolved observations across 30 distinct symbols (⇒ effectiveN=30, well clear of clustering),
 *  24 wins @ +0.35R and 6 losses @ -0.15R (mean 0.25R, real variance, a comfortably positive
 *  conservative lower bound — computed and asserted below, never assumed). Every one genuinely
 *  post-fix-stamped and on the current cost-model generation. */
function seedGenuinelyValidRcStore(store: RegimeCompositeStore): void {
  for (let i = 0; i < 30; i++) {
    const isLoss = i % 5 === 0; // 6 of 30
    store.add(
      rcObs({
        observationId: `rc:VALID:${i}`,
        symbol: `SYM${i}USDT`, // distinct symbol per row ⇒ distinct effectiveN block per row
        openedAtMs: NOW - (i + 2) * 10 * 60_000,
        status: isLoss ? "CLOSED_LOSS" : "CLOSED_WIN",
        grossR: isLoss ? -0.1 : 0.4,
        netR: isLoss ? -0.15 : 0.35,
      }),
    );
  }
}

describe("liveLaneReport() — real RC store, genuinely valid evidence (pass-with)", () => {
  beforeEach(() => {
    _resetRegimeCompositeStoreForTests();
  });

  it("populates all four fields as real, positive/true evidence — never a default", () => {
    const store = getRegimeCompositeStore(DATA_DIR + "-valid");
    seedGenuinelyValidRcStore(store);
    store.recordCycle(new Date(NOW - 5 * 60_000).toISOString(), null);

    const report = liveLaneReport(RC_PAPER_LANE_ID, DATA_DIR + "-valid", () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.fresh).toBe(true);
    expect(report!.postFixExactLineage).toBe(true);
    expect(report!.costValid).toBe(true);
    expect(report!.conservativeNetR).not.toBeNull();
    expect(report!.conservativeNetR as number).toBeGreaterThan(0);
    // and it must be a genuine LOWER BOUND, not the raw pre-aggregated mean the report also carries
    expect(report!.conservativeNetR as number).toBeLessThan(report!.netAvgR as number);
  });

  it("a lane with this real, valid evidence CAN now be selected by selectBestLaneReportForDirection (previously structurally impossible)", () => {
    const store = getRegimeCompositeStore(DATA_DIR + "-selectable");
    seedGenuinelyValidRcStore(store);
    store.recordCycle(new Date(NOW - 5 * 60_000).toISOString(), null);

    const accessor = buildLiveBestLaneReportForDirection(DATA_DIR + "-selectable", () => [], NOW);
    const result = accessor("LONG");
    expect(result).not.toBeNull();
    expect(result!.conservativeNetR).toBeGreaterThan(0);

    // Direct confirmation via the pure selector too, against the full real roster.
    const viaSelector = selectBestLaneReportForDirection(
      "LONG",
      FOUR_BRAIN_LANE_SUPPORT,
      (laneId) => liveLaneReport(laneId, DATA_DIR + "-selectable", () => [], NOW),
    );
    expect(viaSelector).not.toBeNull();
  });
});

describe("liveLaneReport() — a lane failing any ONE of the four fields is still rejected (fail-without, isolated)", () => {
  beforeEach(() => {
    _resetRegimeCompositeStoreForTests();
  });

  it("fresh=false (stale/dead cycle) ⇒ excluded from selection even though the other 3 fields are genuinely valid", () => {
    const dir = DATA_DIR + "-stale";
    const store = getRegimeCompositeStore(dir);
    seedGenuinelyValidRcStore(store);
    // Cycle last ran well outside the freshness TTL — a frozen/dead lane.
    store.recordCycle(new Date(NOW - LANE_REPORT_FRESHNESS_TTL_MS - HOUR_MS).toISOString(), null);

    const report = liveLaneReport(RC_PAPER_LANE_ID, dir, () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.fresh).toBe(false);
    expect(report!.postFixExactLineage).toBe(true);
    expect(report!.costValid).toBe(true);
    expect(report!.conservativeNetR as number).toBeGreaterThan(0);

    const selected = selectBestLaneReportForDirection("LONG", [{ laneId: RC_PAPER_LANE_ID, direction: "LONG" }], () => report);
    expect(selected).toBeNull();
  });

  it("postFixExactLineage=false (legacy/unstamped rows) ⇒ excluded from selection", () => {
    const dir = DATA_DIR + "-legacy-lineage";
    const store = getRegimeCompositeStore(dir);
    for (let i = 0; i < 30; i++) {
      const isLoss = i % 5 === 0;
      store.add(
        rcObs({
          observationId: `rc:LEGACY:${i}`,
          symbol: `SYM${i}USDT`,
          openedAtMs: NOW - (i + 2) * 10 * 60_000,
          status: isLoss ? "CLOSED_LOSS" : "CLOSED_WIN",
          netR: isLoss ? -0.15 : 0.35,
          postFixLineageV1: undefined, // pre-fix legacy row — never true, never backfilled
        }),
      );
    }
    store.recordCycle(new Date(NOW - 5 * 60_000).toISOString(), null);

    const report = liveLaneReport(RC_PAPER_LANE_ID, dir, () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.postFixExactLineage).toBe(false);
    expect(report!.fresh).toBe(true);
    expect(report!.costValid).toBe(true);

    const selected = selectBestLaneReportForDirection("LONG", [{ laneId: RC_PAPER_LANE_ID, direction: "LONG" }], () => report);
    expect(selected).toBeNull();
  });

  it("costValid=false (mixed cost-model generations) ⇒ excluded from selection", () => {
    const dir = DATA_DIR + "-mixed-cohort";
    const store = getRegimeCompositeStore(dir);
    for (let i = 0; i < 30; i++) {
      const isLoss = i % 5 === 0;
      store.add(
        rcObs({
          observationId: `rc:MIXED:${i}`,
          symbol: `SYM${i}USDT`,
          openedAtMs: NOW - (i + 2) * 10 * 60_000,
          status: isLoss ? "CLOSED_LOSS" : "CLOSED_WIN",
          netR: isLoss ? -0.15 : 0.35,
          costModelVersion: i % 2 === 0 ? EDGE_LANE_COST_MODEL_VERSION + 1 : EDGE_LANE_COST_MODEL_VERSION,
        }),
      );
    }
    store.recordCycle(new Date(NOW - 5 * 60_000).toISOString(), null);

    const report = liveLaneReport(RC_PAPER_LANE_ID, dir, () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.costValid).toBe(false);
    expect(report!.fresh).toBe(true);
    expect(report!.postFixExactLineage).toBe(true);

    const selected = selectBestLaneReportForDirection("LONG", [{ laneId: RC_PAPER_LANE_ID, direction: "LONG" }], () => report);
    expect(selected).toBeNull();
  });

  it("conservativeNetR null (all evidence clustered into one time block, effectiveN=1) ⇒ excluded from selection", () => {
    const dir = DATA_DIR + "-clustered";
    const store = getRegimeCompositeStore(dir);
    for (let i = 0; i < 30; i++) {
      const isLoss = i % 5 === 0;
      store.add(
        rcObs({
          observationId: `rc:CLUSTER:${i}`,
          symbol: "BTCUSDT", // SAME symbol every time ⇒ one effective block
          openedAtMs: NOW - 60_000 - i * 1000, // all inside the same hold-period block
          status: isLoss ? "CLOSED_LOSS" : "CLOSED_WIN",
          netR: isLoss ? -0.15 : 0.35,
        }),
      );
    }
    store.recordCycle(new Date(NOW - 5 * 60_000).toISOString(), null);

    const report = liveLaneReport(RC_PAPER_LANE_ID, dir, () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.conservativeNetR).toBeNull();
    expect(report!.fresh).toBe(true);
    expect(report!.postFixExactLineage).toBe(true);
    expect(report!.costValid).toBe(true);

    const selected = selectBestLaneReportForDirection("LONG", [{ laneId: RC_PAPER_LANE_ID, direction: "LONG" }], () => report);
    expect(selected).toBeNull();
  });

  it("an empty store (no evidence at all) never fabricates any of the four fields", () => {
    const dir = DATA_DIR + "-empty";
    getRegimeCompositeStore(dir); // touch the singleton, no observations added

    const report = liveLaneReport(RC_PAPER_LANE_ID, dir, () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.resolvedCount).toBe(0);
    expect(report!.fresh).toBe(false); // no cycle has run
    expect(report!.postFixExactLineage).toBe(false);
    expect(report!.costValid).toBe(false);
    expect(report!.conservativeNetR).toBeNull();
  });
});

describe("IM lane (no lastCycleAt at all) — fresh stays permanently false even with otherwise-valid evidence", () => {
  it("liveLaneReport for the IM lane never returns fresh:true (documented gap, not a defect)", () => {
    // IM's own store tracks no cycleMeta.lastCycleAt — even an empty/never-called store must read
    // fresh:false, never an accidental true from an undefined/omitted TTL comparison.
    const report = liveLaneReport(IM_PAPER_LANE_ID, DATA_DIR + "-im-empty", () => [], NOW);
    expect(report).not.toBeNull();
    expect(report!.fresh).toBe(false);
  });
});

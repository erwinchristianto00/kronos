/**
 * T1-b — retroactive exclusion of sub-admission-floor paper-router rows.
 *
 * EVERY fixture here is hand-built. NOTHING reads the live store. That is deliberate: the testnet
 * diagnostic pool turns over ~12 rows per 15 minutes per lane (pruneClosedDiagnostic keeps the
 * newest 200 per selectedLaneId), so a test asserting anything about real counts would be green
 * today and red tomorrow — the "passes both ways / passes neither way" defect this codebase keeps
 * producing.
 *
 * No threshold below was chosen from data. WIDE_STOP_MIN_BPS (300), NON_BINDING_STOP_FLOOR_MAX_BPS
 * (1), AUTO_QUARANTINE_MIN_CLOSED (40) and AUTO_QUARANTINE_MAX_NETAVGR (-0.03) are all pre-existing
 * source constants.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  isSubAdmissionFloorPaperRow,
  partitionSubFloorPaperRows,
  summariseSubFloorPaperRows,
  excludeSubFloorRowsForReport,
  applySubFloorExclusionForDecisions,
  variantIdFromSelectedLaneId,
  admissionFloorBpsForStoredRow,
  PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV,
  subFloorExclusionEnabledForDecisions,
} from "../src/lib/paper-subfloor-exclusion.js";
import { buildPerSymbolLaneBookEdge, toPsleOrder } from "../src/lib/per-symbol-lane-book-edge.js";
import { RECIPE_BY_DIRECTION } from "../src/lib/unified-testnet-proposal-source.js";
import {
  admissionStopFloorBpsForVariant,
  NON_BINDING_STOP_FLOOR_MAX_BPS,
  VARIANT_MATRIX_DEFINITIONS,
  WIDE_STOP_MIN_BPS,
} from "../src/lib/current-guard-variant-matrix.js";
import {
  PaperExecutionRouterStore,
  buildPaperPerformanceReport,
  buildPaperPerformanceBreakdown,
  buildPaperExecutionRouterBriefLines,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { computeAutoQuarantinedVariantLanes } from "../src/lib/paper-opportunity-allocator.js";
import {
  collectCortexCgRouterObs,
  CORTEX_CG_ROUTER_ALLOWED_LANE_IDS,
  type CortexCgRouterOrderLike,
} from "../src/lib/cortex-refit-runner-bindings.js";

const HOUR = 3_600_000;
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "subfloor-test-"));

/** The two NON-BINDING-sentinel variants (`stopFloorBps: 1`) at the centre of this fix. */
const SENTINEL_LONG_LANE = "CG_LONG_VARIANT_MATRIX:CG_BASELINE_FAST_05";
const SENTINEL_SHORT_LANE = "CG_VARIANT_MATRIX:CG_MAKER_FAST_05";

function order(args: {
  id?: string;
  laneId?: string;
  stopBps?: number;
  sourceType?: string | null;
  status?: PaperOrderStatus;
  netR?: number | null;
  netPnlAmount?: number | null;
  mode?: "HEADLINE" | "DIAGNOSTIC_ONLY";
  diagnosticLabel?: PaperOrder["diagnosticLabel"];
  symbol?: string;
  direction?: "LONG" | "SHORT";
  openedAtMs?: number;
}): PaperOrder {
  const opened = args.openedAtMs ?? Date.parse("2026-07-20T08:00:00.000Z");
  const netR = args.netR ?? null;
  return {
    paperOrderId: args.id ?? `o-${Math.random().toString(36).slice(2)}`,
    sourceType: (args.sourceType === undefined
      ? "SCAN_CANDIDATE_LANE_ALLOCATOR"
      : args.sourceType) as PaperOrder["sourceType"],
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: `obs:${args.laneId ?? SENTINEL_LONG_LANE}`,
    createdAt: new Date(opened).toISOString(),
    updatedAt: new Date(opened + 24 * HOUR).toISOString(),
    openedAt: new Date(opened).toISOString(),
    symbol: args.symbol ?? "ETHUSDT",
    direction: args.direction ?? "LONG",
    regime: "Bullish expansion",
    controllerMode: "LONG_ONLY",
    selectedLaneId: args.laneId ?? SENTINEL_LONG_LANE,
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 97,
    takeProfitLevels: [104],
    plannedStopDistanceBps: args.stopBps ?? 350,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    paperOrderMode: args.mode ?? "HEADLINE",
    operationalSafetyStatus: "OK",
    diagnosticLabel: args.diagnosticLabel ?? null,
    paperStatus: args.status ?? (netR !== null && netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS"),
    grossR: null,
    costR: null,
    netR,
    netPnlAmount: args.netPnlAmount ?? null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

afterEach(() => {
  delete process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV];
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[T1-b/1] sub-admission-floor predicate — precision", () => {
  // Each row kills a specific WRONG implementation. Row 2 is the one that fails if someone writes
  // this as a lane blocklist; row 5 is the one that fails if someone reads `def.stopFloorBps`
  // directly instead of admissionStopFloorBpsForVariant.
  it("excludes a stored row only when it is below ITS OWN variant's current admission floor", () => {
    // 1 — sentinel lane below its (restored) 300bps floor ⇒ EXCLUDED
    expect(isSubAdmissionFloorPaperRow(order({ laneId: SENTINEL_LONG_LANE, stopBps: 20 }))).toBe(true);
    // 2 — SAME LANE, at 350bps ⇒ KEPT. Kills the lane-blocklist implementation.
    expect(isSubAdmissionFloorPaperRow(order({ laneId: SENTINEL_LONG_LANE, stopBps: 350 }))).toBe(false);
    // 3 — a genuinely-binding 175bps floor, exactly at it ⇒ KEPT. Kills a hardcoded `< 300`.
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: "CG_VARIANT_MATRIX:CG_TIGHT_FAST_05", stopBps: 175 })),
    ).toBe(false);
    // 4 — one bps under that same floor ⇒ EXCLUDED. Kills an off-by-one on `>=`.
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: "CG_VARIANT_MATRIX:CG_TIGHT_FAST_05", stopBps: 174 })),
    ).toBe(true);
    // 5 — a variant with NO stopFloorBps at all admits at WIDE_STOP_MIN_BPS ⇒ 250 is EXCLUDED.
    //     Kills reading `def.stopFloorBps ?? 0` / treating "no floor" as "any stop is fine".
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT", stopBps: 250 })),
    ).toBe(true);
    // 6 — the mirror source never ran the stop-floor gate, so its rows are NOT rows that "could not
    //     exist under the fix". Kills a missing sourceType scope.
    expect(
      isSubAdmissionFloorPaperRow(
        order({ laneId: "CG_VARIANT_MATRIX:CG_BASELINE_FAST_05", stopBps: 20, sourceType: "REALTIME_SHORT_MIRROR" }),
      ),
    ).toBe(false);
  });

  it("never excludes a non-terminal row, an unknown variant id, or a non-variant lane", () => {
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: SENTINEL_LONG_LANE, stopBps: 20, status: "CREATED" })),
    ).toBe(false);
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: SENTINEL_LONG_LANE, stopBps: 20, status: "PAPER_NO_FILL" })),
    ).toBe(false);
    // Unknown variant id under a known prefix: unknown != bad.
    expect(
      isSubAdmissionFloorPaperRow(order({ laneId: "CG_VARIANT_MATRIX:CG_NOT_A_REAL_VARIANT", stopBps: 1 })),
    ).toBe(false);
    expect(admissionFloorBpsForStoredRow(order({ laneId: "SOME_OTHER_LANE", stopBps: 1 }))).toBeNull();
    expect(isSubAdmissionFloorPaperRow(order({ laneId: "SOME_OTHER_LANE", stopBps: 1 }))).toBe(false);
    expect(variantIdFromSelectedLaneId("CG_LONG_VARIANT_MATRIX:")).toBeNull();
    expect(variantIdFromSelectedLaneId(null)).toBeNull();
  });

  // Mirrors the existing [5c] discipline in paper-opportunity-allocator.test.ts: the genuinely
  // binding floors (175/200/250/300) must never be reclassified as sentinels by accident.
  it("keeps a row sitting exactly on every genuinely-binding declared floor", () => {
    let checked = 0;
    for (const def of VARIANT_MATRIX_DEFINITIONS) {
      const floor = def.stopFloorBps;
      if (floor == null || floor <= NON_BINDING_STOP_FLOOR_MAX_BPS) continue;
      expect(admissionStopFloorBpsForVariant(def)).toBe(floor);
      expect(isSubAdmissionFloorPaperRow(order({ laneId: `CG_VARIANT_MATRIX:${def.id}`, stopBps: floor }))).toBe(false);
      expect(isSubAdmissionFloorPaperRow(order({ laneId: `CG_VARIANT_MATRIX:${def.id}`, stopBps: floor - 1 }))).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    // And the two sentinels admit at the WIDE floor, not at 1.
    for (const id of ["CG_BASELINE_FAST_05", "CG_MAKER_FAST_05"] as const) {
      const def = VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === id)!;
      expect(def.stopFloorBps).toBe(NON_BINDING_STOP_FLOOR_MAX_BPS);
      expect(admissionStopFloorBpsForVariant(def)).toBe(WIDE_STOP_MIN_BPS);
    }
  });

  // The property that separates this from the survivorship bugs: the rule cannot see the outcome.
  it("is blind to the outcome column — a big winner and a big loser at the same bps get the same verdict", () => {
    const winner = order({ laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: 2.5, status: "PAPER_CLOSED_WIN" });
    const loser = order({ laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -5.46, status: "PAPER_CLOSED_LOSS" });
    expect(isSubAdmissionFloorPaperRow(winner)).toBe(true);
    expect(isSubAdmissionFloorPaperRow(loser)).toBe(true);
    const keptWinner = order({ laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 2.5, status: "PAPER_CLOSED_WIN" });
    const keptLoser = order({ laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: -1.0, status: "PAPER_CLOSED_LOSS" });
    expect(isSubAdmissionFloorPaperRow(keptWinner)).toBe(false);
    expect(isSubAdmissionFloorPaperRow(keptLoser)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[T1-b/2] report-only aggregates exclude AND surface", () => {
  // (a) sub-floor row excluded from the report-only aggregate
  // (b) at-or-above-floor row on the SAME lane retained  ← proves it is not a lane blocklist
  it("drops sub-floor closes from headline metrics, keeps same-lane >=floor closes, and reports both", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    // 3 sub-floor rows on the sentinel lane at -1.2R each (could not exist under the fixed gate)
    for (let i = 0; i < 3; i += 1) {
      store.add(order({ id: `sub-${i}`, laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2, netPnlAmount: -24 }));
    }
    // 1 VALID paired row on the SAME lane at 350bps, +0.6R
    store.add(order({ id: "ok-0", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6, netPnlAmount: 12 }));

    const report = buildPaperPerformanceReport(store);

    // (a) the three sub-floor rows are gone from every aggregate
    expect(report.headlineClosed).toBe(1);
    expect(report.closed).toBe(1);
    // (b) the same-lane >=floor row survived, and it is the one that sets the mean
    expect(report.headlineNetAvgR).toBeCloseTo(0.6, 10);
    expect(report.headlineWR).toBe(1);
    expect(report.realizedPaperPnl).toBeCloseTo(12, 10);

    // SURFACED, not silent — and sufficient to reconstruct the pre-exclusion number.
    const x = report.subFloorExclusion;
    expect(x.applied).toBe(true);
    expect(x.excludedCount).toBe(3);
    expect(x.excludedNetAvgR).toBeCloseTo(-1.2, 10);
    expect(x.excludedNetRSum).toBeCloseTo(-3.6, 10);
    expect(x.excludedNetPnlAmount).toBeCloseTo(-72, 10);
    expect(x.excludedHeadlineCount).toBe(3);
    expect(x.retainedClosedCount).toBe(1);
    expect(x.byLane).toHaveLength(1);
    expect(x.byLane[0]!.laneId).toBe(SENTINEL_LONG_LANE);
    expect(x.byLane[0]!.admissionStopFloorBps).toBe(WIDE_STOP_MIN_BPS);
    expect(x.byLane[0]!.maxStopDistanceBps).toBe(20);

    // Reconstruction of the pre-exclusion aggregate from the surfaced fields alone.
    const preClosed = x.retainedClosedCount + x.excludedCount;
    const preNetAvgR = (x.retainedNetRSum + x.excludedNetRSum) / preClosed;
    expect(preClosed).toBe(4);
    expect(preNetAvgR).toBeCloseTo((-3.6 + 0.6) / 4, 10);
  });

  // REVIEW FIX 2026-07-27. The reconstruction above uses the ALL-CLOSED sums on a fixture where
  // every row is HEADLINE, so the two bases coincide and it passes whether or not the general claim
  // holds — a "passes both ways" assertion. The report's printed metrics (headlineNetAvgR,
  // realizedPaperPnl, headlinePF, headlineWR) are HEADLINE-scoped and the report exposes NO
  // all-closed mean at all, so on the real store (~4 of ~599 excluded rows are HEADLINE) the
  // all-closed formula reconstructs a number that is never printed.
  //
  // This fixture DELIBERATELY mixes HEADLINE / DIAGNOSTIC_ONLY / BACKFILL_DIAGNOSTIC so the two
  // bases cannot coincide, and asserts that fact directly before asserting the reconstruction.
  it("[T1-b/2b] headline reconstruction is exact on a mixed book, and the all-closed basis is NOT", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    // sub-floor, HEADLINE (the only ones that move headline metrics)
    store.add(order({ id: "h1", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2, netPnlAmount: -24 }));
    store.add(order({ id: "h2", laneId: SENTINEL_LONG_LANE, stopBps: 4.03, netR: -5.46, netPnlAmount: -109.2 }));
    // sub-floor, DIAGNOSTIC_ONLY — dominates the all-closed sums, contributes nothing to headline
    for (let i = 0; i < 6; i += 1) {
      store.add(
        order({ id: `d${i}`, laneId: SENTINEL_SHORT_LANE, stopBps: 50, netR: -3, netPnlAmount: -60, mode: "DIAGNOSTIC_ONLY", direction: "SHORT" }),
      );
    }
    // sub-floor, BACKFILL_DIAGNOSTIC at HEADLINE accounting mode — in NEITHER bucket, exactly as
    // buildPaperPerformanceReport treats it. Kills a headline test that keys on paperOrderMode only.
    store.add(
      order({ id: "b1", laneId: SENTINEL_LONG_LANE, stopBps: 30, netR: -9, netPnlAmount: -180, diagnosticLabel: "BACKFILL_DIAGNOSTIC" }),
    );
    // at-or-above floor, retained
    store.add(order({ id: "k1", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6, netPnlAmount: 12 }));
    store.add(order({ id: "k2", laneId: SENTINEL_LONG_LANE, stopBps: 400, netR: -0.2, netPnlAmount: -4 }));
    store.add(
      order({ id: "k3", laneId: SENTINEL_SHORT_LANE, stopBps: 350, netR: 0.1, netPnlAmount: 2, mode: "DIAGNOSTIC_ONLY", direction: "SHORT" }),
    );

    const pre = buildPaperPerformanceReport(store, { applySubFloorExclusion: false });
    const post = buildPaperPerformanceReport(store);
    const x = post.subFloorExclusion;

    // The exclusion set is NOT all-headline — this is what makes the assertion below non-vacuous.
    expect(x.excludedCount).toBe(9);
    expect(x.excludedHeadlineCount).toBe(2);
    expect(x.excludedDiagnosticOnlyCount).toBe(6);
    // BACKFILL_DIAGNOSTIC at HEADLINE mode is in neither bucket:
    expect(x.excludedHeadlineCount + x.excludedDiagnosticOnlyCount).toBe(x.excludedCount - 1);

    // HEADLINE reconstruction — exact against the pre-exclusion report.
    const preHeadlineClosed = x.retainedHeadlineClosedCount + x.excludedHeadlineCount;
    const preHeadlineNetAvgR = (x.retainedHeadlineNetRSum + x.excludedHeadlineNetRSum) / preHeadlineClosed;
    const preHeadlinePnl = x.retainedHeadlineNetPnlAmount + x.excludedHeadlineNetPnlAmount;
    expect(preHeadlineClosed).toBe(pre.headlineClosed);
    expect(preHeadlineNetAvgR).toBeCloseTo(pre.headlineNetAvgR!, 10);
    expect(preHeadlinePnl).toBeCloseTo(pre.realizedPaperPnl, 10);

    // …and the post-exclusion side reconstructs the number the report now prints.
    expect(x.retainedHeadlineClosedCount).toBe(post.headlineClosed);
    expect(x.retainedHeadlineNetAvgR).toBeCloseTo(post.headlineNetAvgR!, 10);
    expect(x.retainedHeadlineNetPnlAmount).toBeCloseTo(post.realizedPaperPnl, 10);

    // NEGATIVE CONTROL: the documented-before formula (all-closed sums) reconstructs something else
    // entirely. If this ever becomes equal, the fixture has gone degenerate and the test above is
    // no longer proving anything.
    const allClosedMean =
      (x.retainedNetRSum + x.excludedNetRSum) / (x.retainedClosedCount + x.excludedCount);
    expect(Math.abs(allClosedMean - pre.headlineNetAvgR!)).toBeGreaterThan(0.5);
  });

  it("breakdown rows drop sub-floor closes and surface the same summary", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "s1", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2, symbol: "SOLUSDT" }));
    store.add(order({ id: "s2", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6, symbol: "SOLUSDT" }));
    const bd = buildPaperPerformanceBreakdown(store);
    expect(bd.headlineClosed).toBe(1);
    expect(bd.byLane).toHaveLength(1);
    expect(bd.byLane[0]!.closed).toBe(1);
    expect(bd.byLane[0]!.netSumR).toBeCloseTo(0.6, 10);
    expect(bd.subFloorExclusion.applied).toBe(true);
    expect(bd.subFloorExclusion.excludedCount).toBe(1);
  });

  it("does not mutate or rewrite any stored row — read-time filter only", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "s1", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 }));
    store.add(order({ id: "s2", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6 }));
    const before = JSON.stringify(store.getState().orders);
    buildPaperPerformanceReport(store);
    buildPaperPerformanceBreakdown(store);
    expect(JSON.stringify(store.getState().orders)).toBe(before);
    expect(store.all).toHaveLength(2);
  });

  it("leaves a clean book byte-identical and reports a zero-count summary", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "a", laneId: SENTINEL_LONG_LANE, stopBps: 400, netR: 0.5 }));
    store.add(order({ id: "b", laneId: "CG_VARIANT_MATRIX:CG_TIGHT_FAST_05", stopBps: 180, netR: -0.4 }));
    const report = buildPaperPerformanceReport(store);
    expect(report.subFloorExclusion.excludedCount).toBe(0);
    expect(report.subFloorExclusion.byLane).toEqual([]);
    expect(report.headlineClosed).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[T1-b/3] decision path is gated and DEFAULT OFF", () => {
  it("the flag is off unless explicitly set to 1", () => {
    expect(subFloorExclusionEnabledForDecisions()).toBe(false);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "0";
    expect(subFloorExclusionEnabledForDecisions()).toBe(false);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "true";
    expect(subFloorExclusionEnabledForDecisions()).toBe(false);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    expect(subFloorExclusionEnabledForDecisions()).toBe(true);
  });

  it("with the flag off, applySubFloorExclusionForDecisions returns the caller's own array reference", () => {
    const rows = [order({ laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 })];
    expect(applySubFloorExclusionForDecisions(rows)).toBe(rows); // identity, not a copy
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    const filtered = applySubFloorExclusionForDecisions(rows);
    expect(filtered).not.toBe(rows);
    expect(filtered).toHaveLength(0);
  });

  // (c) with the decision-path flag off, the decision-path aggregate is unchanged.
  //
  // (a) MEAN FLIP WITH SAMPLE SIZE HELD CONSTANT — the load-bearing case.
  //     45 sub-floor @ -1.2 + 45 valid @ +0.45 ⇒ pre-fix mean -0.375 (<= -0.03, n=90 >= 40)
  //                                          ⇒ post-fix mean +0.45 at n=45 >= 40.
  it("auto-quarantine: unchanged with the flag off; un-benches the sentinel lane with it on", () => {
    const orders = [
      ...Array.from({ length: 45 }, (_, i) =>
        order({ id: `q-sub-${i}`, laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 }),
      ),
      ...Array.from({ length: 45 }, (_, i) =>
        order({ id: `q-ok-${i}`, laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.45 }),
      ),
    ];

    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([SENTINEL_LONG_LANE]);

    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([]);
  });

  // (b) SAMPLE-SIZE COLLAPSE: enough evidence pre-fix, not enough post-fix ⇒ correctly not benched.
  it("auto-quarantine: a lane whose sample collapses below MIN_CLOSED after exclusion is not benched", () => {
    const orders = [
      ...Array.from({ length: 30 }, (_, i) =>
        order({ id: `c-sub-${i}`, laneId: SENTINEL_SHORT_LANE, stopBps: 20, netR: -1.2, direction: "SHORT" }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        order({ id: `c-ok-${i}`, laneId: SENTINEL_SHORT_LANE, stopBps: 350, netR: 0.45, direction: "SHORT" }),
      ),
    ];
    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([SENTINEL_SHORT_LANE]);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([]);
  });

  // (c) NEGATIVE CONTROL: a genuine loser with zero sub-floor rows stays benched BOTH ways.
  //     This is what fails if someone implements the predicate as a lane blocklist, and it is what
  //     proves the fix cannot launder a real loser.
  it("auto-quarantine: a genuine loser with no sub-floor rows stays benched with the flag ON", () => {
    const orders = Array.from({ length: 60 }, (_, i) =>
      order({ id: `n-${i}`, laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: -0.9 }),
    );
    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([SENTINEL_LONG_LANE]);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    expect(computeAutoQuarantinedVariantLanes(orders)).toEqual([SENTINEL_LONG_LANE]);
    // and nothing was removed
    expect(partitionSubFloorPaperRows(orders).excluded).toHaveLength(0);
  });

  it("the report builders' DECISION invocation is byte-identical with the flag off", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    for (let i = 0; i < 3; i += 1) {
      store.add(order({ id: `d-${i}`, laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 }));
    }
    store.add(order({ id: "d-ok", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6 }));

    // This is exactly how routes/shadow.ts builds the AllocatorLaneState inputs.
    const decision = buildPaperPerformanceReport(store, {
      applySubFloorExclusion: subFloorExclusionEnabledForDecisions(),
    });
    expect(decision.subFloorExclusion.applied).toBe(false);
    expect(decision.headlineClosed).toBe(4); // unchanged: all four rows counted
    expect(decision.headlineNetAvgR).toBeCloseTo((-3.6 + 0.6) / 4, 10);
    // …but the operator can still SEE what would go.
    expect(decision.subFloorExclusion.excludedCount).toBe(3);

    const display = buildPaperPerformanceReport(store);
    expect(display.subFloorExclusion.applied).toBe(true);
    expect(display.headlineClosed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[T1-b/4] CORTEX exposure is structurally zero — enforced, not remembered", () => {
  const cortexOrder = (args: {
    id: string;
    laneId: string;
    stopBps: number;
    netR: number;
    direction?: "LONG" | "SHORT";
  }): CortexCgRouterOrderLike => ({
    paperOrderId: args.id,
    selectedLaneId: args.laneId,
    direction: args.direction ?? "LONG",
    openedAt: "2026-07-20T08:00:00.000Z",
    paperStatus: args.netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
    netR: args.netR,
    closedAtMs: Date.parse("2026-07-20T20:00:00.000Z"),
    closeReason: "TP1_HIT",
    sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
    plannedStopDistanceBps: args.stopBps,
  });

  // The measured claim (testnet store 2026-07-26): the three-lane allowlist holds 408 closed
  // non-MTM LONG router rows and ZERO of them are sub-floor, because the contaminated variants are
  // not on the allowlist. Encoded structurally: sub-floor rows on the sentinel variants are already
  // invisible to CORTEX with the flag OFF, so turning it on changes nothing.
  it("sentinel-variant sub-floor rows never reach CORTEX, flag on or off", () => {
    const orders = [
      cortexOrder({ id: "w1", laneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", stopBps: 500, netR: 0.4 }),
      cortexOrder({ id: "w2", laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER", stopBps: 800, netR: -0.9 }),
      // contamination: sentinel variants at sub-floor geometry, NOT on the allowlist
      cortexOrder({ id: "x1", laneId: SENTINEL_LONG_LANE, stopBps: 4.03, netR: -5.46 }),
      cortexOrder({ id: "x2", laneId: SENTINEL_SHORT_LANE, stopBps: 20, netR: -1.2 }),
    ];
    const off = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: false });
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    const on = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: false });

    // ZERO DELTA — this is the claim the staging plan rests on.
    expect(JSON.stringify([...on.byLane])).toBe(JSON.stringify([...off.byLane]));
    expect(on.byLaneCounts).toEqual(off.byLaneCounts);
    for (const laneId of CORTEX_CG_ROUTER_ALLOWED_LANE_IDS) {
      expect(off.byLane.get(laneId)!.every((o) => !o.observationId.includes("x1"))).toBe(true);
    }
    expect(off.byLaneCounts["CG_WIDE_FAST_LONG"]!.admitted).toBe(1);
  });

  // The guard is nevertheless LIVE: if the hand-maintained allowlist ever grows to include a
  // contaminated variant, the flag actually removes those rows. Without this the wiring above
  // would be indistinguishable from dead code.
  it("the guard is live: a sub-floor row ON an allowlisted lane is removed when the flag is on", () => {
    const orders = [
      cortexOrder({ id: "ok", laneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", stopBps: 500, netR: 0.4 }),
      // CG_WIDE_FAST_LONG carries no stopFloorBps ⇒ admits at WIDE_STOP_MIN_BPS; 120 is below it.
      cortexOrder({ id: "bad", laneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", stopBps: 120, netR: -3.1 }),
    ];
    const off = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: false });
    expect(off.byLaneCounts["CG_WIDE_FAST_LONG"]!.admitted).toBe(2);

    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    const on = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: false });
    expect(on.byLaneCounts["CG_WIDE_FAST_LONG"]!.admitted).toBe(1);
    expect(on.byLane.get("CG_WIDE_FAST_LONG")!.map((o) => o.observationId)).toEqual(["router:ok"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("[T1-b/5] summary arithmetic", () => {
  it("splits win/loss, HEADLINE/DIAGNOSTIC_ONLY and per-lane bps range correctly", () => {
    const rows = [
      order({ id: "1", laneId: SENTINEL_LONG_LANE, stopBps: 4.03, netR: -5.46, mode: "HEADLINE" }),
      order({ id: "2", laneId: SENTINEL_LONG_LANE, stopBps: 284.89, netR: 0.4, mode: "DIAGNOSTIC_ONLY" }),
      order({ id: "3", laneId: SENTINEL_SHORT_LANE, stopBps: 50, netR: -1.0, mode: "DIAGNOSTIC_ONLY" }),
      order({ id: "4", laneId: SENTINEL_LONG_LANE, stopBps: 343.63, netR: 0.9, mode: "HEADLINE" }),
    ];
    const { retained, excluded, summary } = partitionSubFloorPaperRows(rows);
    expect(excluded.map((r) => r.paperOrderId)).toEqual(["1", "2", "3"]);
    expect(retained.map((r) => r.paperOrderId)).toEqual(["4"]);
    expect(summary.excludedWin).toBe(1);
    expect(summary.excludedLoss).toBe(2);
    expect(summary.excludedHeadlineCount).toBe(1);
    expect(summary.excludedDiagnosticOnlyCount).toBe(2);
    expect(summary.excludedNetRSum).toBeCloseTo(-6.06, 10);
    expect(summary.retainedClosedCount).toBe(1);
    expect(summary.retainedNetAvgR).toBeCloseTo(0.9, 10);
    const longLane = summary.byLane.find((l) => l.laneId === SENTINEL_LONG_LANE)!;
    expect(longLane.excludedCount).toBe(2);
    expect(longLane.minStopDistanceBps).toBeCloseTo(4.03, 10);
    expect(longLane.maxStopDistanceBps).toBeCloseTo(284.89, 10);
  });

  it("excludeSubFloorRowsForReport(rows, false) returns the input array untouched but still counts", () => {
    const rows = [order({ id: "1", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 })];
    const res = excludeSubFloorRowsForReport(rows, false);
    expect(res.rows).toBe(rows);
    expect(res.exclusion.applied).toBe(false);
    expect(res.exclusion.excludedCount).toBe(1);
  });

  // REVIEW FIX 2026-07-27 (allocation shape). `excludeSubFloorRowsForReport` used to build a
  // near-full `retained` copy on EVERY call — including `apply:false` and a clean book, where it was
  // then discarded — on the instance that has already OOM'd from exactly this shape. It now counts
  // first (summariseSubFloorPaperRows allocates no copy) and filters only when something leaves.
  //
  // HONESTY NOTE: the identity assertions below ALSO held on the pre-fix implementation (it returned
  // `rows` while discarding the copy), so they do not by themselves prove the allocation went away —
  // transient allocation is not observable from outside. What they DO pin is the returned-reference
  // contract, and `summariseSubFloorPaperRows` is the counting-only entry point the fix introduced.
  it("returns the caller's own array on every non-excluding path, and counts without partitioning", () => {
    const dirty = [order({ id: "1", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2 })];
    expect(excludeSubFloorRowsForReport(dirty, false).rows).toBe(dirty); // no copy: identity
    const clean = [order({ id: "2", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6 })];
    expect(excludeSubFloorRowsForReport(clean, true).rows).toBe(clean); // no copy: identity
    // …and the copy IS made when something actually leaves.
    const mixed = [...dirty, ...clean];
    const applied = excludeSubFloorRowsForReport(mixed, true);
    expect(applied.rows).not.toBe(mixed);
    expect(applied.rows.map((r) => r.paperOrderId)).toEqual(["2"]);
    // summariseSubFloorPaperRows is the counting-only entry point: same numbers, no arrays.
    expect(summariseSubFloorPaperRows(mixed).excludedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW FIX 2026-07-27 — the predicate is scoped on `sourceType ===
// "SCAN_CANDIDATE_LANE_ALLOCATOR"` because ONLY the allocator path runs
// paperOpportunityStopFloorRejection. unified-testnet-proposal-source.ts stamps that SAME sourceType
// with a real plannedStopDistanceBps and never runs that gate. Today it cannot emit a sub-floor row
// only because every recipe it uses carries a BINDING stopFloorBps, which deriveVariantGeometry's
// wide branch then floors the geometry at. Nothing asserted that. Now it does.
describe("[T1-b/6] unified-testnet-proposal recipes cannot emit a sub-floor row", () => {
  it("every RECIPE_BY_DIRECTION variant declares a BINDING stop floor", () => {
    const recipes = Object.values(RECIPE_BY_DIRECTION).flatMap((byPosture) => Object.values(byPosture));
    expect(recipes.length).toBeGreaterThan(0);
    for (const id of recipes) {
      const def = VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === id);
      expect(def, `RECIPE_BY_DIRECTION references unknown variant ${id}`).toBeDefined();
      // A binding floor (> the non-binding sentinel) means deriveVariantGeometry floors the emitted
      // stopDistanceBps at it, so `plannedStopDistanceBps >= admissionStopFloorBpsForVariant(def)`
      // holds by construction and the predicate can never fire on these rows.
      expect(
        def!.stopFloorBps,
        `${id} has no binding stopFloorBps — a unified-testnet proposal on it would be stamped ` +
          `SCAN_CANDIDATE_LANE_ALLOCATOR at geometry that never passed the stop-floor gate, and the ` +
          `sub-admission-floor predicate would delete real testnet-executed trades from every aggregate`,
      ).toBeGreaterThan(NON_BINDING_STOP_FLOOR_MAX_BPS);
      expect(admissionStopFloorBpsForVariant(def!)).toBe(def!.stopFloorBps);
      // A row emitted at exactly that floor is retained.
      expect(
        isSubAdmissionFloorPaperRow(order({ laneId: `CG_VARIANT_MATRIX:${id}`, stopBps: def!.stopFloorBps! })),
      ).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW FIX 2026-07-27 — /api/shadow/headline-closed-orders projects local orders down to PsleOrder
// before shipping them to peers; peer rows from testnet 3102 and live 3103 are then MERGED with the
// local book and fed to buildPerSymbolLaneBookEdge, whose promotable/testnetCandidate verdicts live
// fetches and applies as SYMBOL_NOT_CURATED on real money. The projection used to drop `sourceType`
// and `plannedStopDistanceBps`, so with the decision flag ON local sub-floor closes left a cell while
// the peers' identically-contaminated closes stayed in it — a half-cleaned population.
describe("[T1-b/7] peer projection carries every field the predicate reads", () => {
  it("toPsleOrder preserves the exclusion verdict across the wire shape", () => {
    const sub = order({ laneId: SENTINEL_LONG_LANE, stopBps: 4.03, netR: -5.46 });
    const ok = order({ laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6 });
    // The load-bearing property: projecting must not change the verdict. The OLD literal dropped
    // both fields, so the projected sub-floor row read as `false` while the local one read `true`.
    expect(isSubAdmissionFloorPaperRow(toPsleOrder({ ...sub, selectedLaneId: sub.selectedLaneId! }))).toBe(
      isSubAdmissionFloorPaperRow(sub),
    );
    expect(isSubAdmissionFloorPaperRow(toPsleOrder({ ...sub, selectedLaneId: sub.selectedLaneId! }))).toBe(true);
    expect(isSubAdmissionFloorPaperRow(toPsleOrder({ ...ok, selectedLaneId: ok.selectedLaneId! }))).toBe(false);
    const projected = toPsleOrder({ ...sub, selectedLaneId: sub.selectedLaneId! });
    expect(projected.sourceType).toBe("SCAN_CANDIDATE_LANE_ALLOCATOR");
    expect(projected.plannedStopDistanceBps).toBeCloseTo(4.03, 10);
  });

  it("a peer-shaped sub-floor cell is emptied by the flag exactly like a local one", () => {
    const cellRows = (n: number, stopBps: number) =>
      Array.from({ length: n }, (_, i) => {
        const o = order({ id: `p-${stopBps}-${i}`, laneId: SENTINEL_LONG_LANE, stopBps, netR: -1.2, symbol: "SUIUSDT" });
        return toPsleOrder({ ...o, selectedLaneId: o.selectedLaneId! });
      });
    // 12 peer-shaped sub-floor closes on one lane×symbol cell, above the default displayFloor of 10.
    const peers = cellRows(12, 4.03);
    const cellOf = () =>
      buildPerSymbolLaneBookEdge(peers, { displayFloor: 10 }).cells.find(
        (c) => c.laneId === SENTINEL_LONG_LANE && c.symbol === "SUIUSDT",
      );
    expect(cellOf()?.closed).toBe(12);
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    expect(cellOf()).toBeUndefined(); // cell drops below displayFloor — no half-cleaned verdict
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW FIX 2026-07-27 — the summary existed only in the JSON payload: `grep -rn subFloorExclusion`
// found zero consumers on any rendered surface. Section 10's headlineClosed / headlineNet /
// headlinePnl are all post-exclusion when applied, and nothing said so.
describe("[T1-b/8] the exclusion is rendered, not just serialized", () => {
  const seeded = () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "s1", laneId: SENTINEL_LONG_LANE, stopBps: 4.03, netR: -5.46, netPnlAmount: -109.2 }));
    store.add(order({ id: "s2", laneId: SENTINEL_LONG_LANE, stopBps: 20, netR: -1.2, netPnlAmount: -24 }));
    store.add(order({ id: "k1", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6, netPnlAmount: 12 }));
    return store;
  };

  it("brief section 10 always prints the exclusion, its basis, and BOTH reconstructions", () => {
    const lines = buildPaperExecutionRouterBriefLines(buildPaperPerformanceReport(seeded()));
    const head = lines.find((l) => l.includes("subFloorExcluded="));
    expect(head, "section 10 renders no sub-floor line at all").toBeDefined();
    expect(head).toContain("subFloorExcluded=2");
    expect(head).toContain("reportsApplied=YES");
    expect(head).toContain("decisionsApplied=NO");
    // Both bases side by side, so the operator never has to know which way to reconstruct.
    const recon = lines.find((l) => l.includes("headline WITH subFloor:"));
    expect(recon).toBeDefined();
    expect(recon).toContain("closed=3");   // WITH
    expect(recon).toContain("closed=1");   // WITHOUT
    // The per-lane detail names the lane and the floor that was violated.
    const byLane = lines.find((l) => l.includes("subFloorByLane:"));
    expect(byLane).toContain(SENTINEL_LONG_LANE);
    expect(byLane).toContain(`floor=${WIDE_STOP_MIN_BPS}bps`);
    // The PROVENANCE V1 block below section 10 counts the FULL book on purpose; say so.
    expect(lines.some((l) => l.includes("provenance/audit blocks below intentionally count the FULL book"))).toBe(true);
  });

  it("a clean book still prints the line (absence must never be ambiguous)", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ id: "c1", laneId: SENTINEL_LONG_LANE, stopBps: 350, netR: 0.6 }));
    const lines = buildPaperExecutionRouterBriefLines(buildPaperPerformanceReport(store));
    expect(lines.some((l) => l.includes("subFloorExcluded=0"))).toBe(true);
  });

  it("reportsApplied/decisionsApplied track the flag, and the line never fakes laneConfidence=HIGH", () => {
    process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] = "1";
    const lines = buildPaperExecutionRouterBriefLines(
      buildPaperPerformanceReport(seeded(), { applySubFloorExclusion: subFloorExclusionEnabledForDecisions() }),
    );
    const head = lines.find((l) => l.includes("subFloorExcluded="))!;
    expect(head).toContain("reportsApplied=YES");
    expect(head).toContain("decisionsApplied=YES");
    // Guards the pre-existing [SQ-1] assertion in paper-opportunity-allocator.test.ts.
    expect(lines.every((l) => !l.includes("laneConfidence=HIGH"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW FIX 2026-07-27 — WIRING CONTRACT for routes/shadow.ts.
//
// The post-resolve reconciliation at ~:3049 built its report UNGATED (so it always excluded) and
// then overwrote allocatorReport.activeLaneClosed/NetAvgR/PF/WR and recomputed paperLaneConfidence —
// i.e. it rendered a lane verdict the allocator never made — while the neural-map build at ~:1855
// put the global tiles on a different population than the per-lane rows underneath them.
//
// No unit test can reach inside that route body, and there is precedent in this suite for pinning a
// wiring invariant by inspecting the source (lane-context-journal-binding.test.ts:173). This is that:
// EVERY buildPaperPerformanceReport / buildPaperPerformanceBreakdown call in routes/shadow.ts must
// pass applySubFloorExclusion explicitly. It fails on the reviewed tree.
describe("[T1-b/9] routes/shadow.ts builds every paper report on ONE population", () => {
  it("no buildPaperPerformance* call site in routes/shadow.ts is left ungated", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/routes/shadow.ts", import.meta.url)), "utf8");
    const calls = [...src.matchAll(/buildPaperPerformance(?:Report|Breakdown)\s*\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    const ungated: string[] = [];
    for (const m of calls) {
      // Scan forward to the matching close paren of THIS call and require the option inside it.
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i += 1) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const args = src.slice(m.index! + m[0].length, i);
      if (!args.includes("applySubFloorExclusion")) {
        ungated.push(`line ${src.slice(0, m.index!).split("\n").length}: ${m[0]}`);
      }
    }
    expect(
      ungated,
      `ungated buildPaperPerformance* call(s) in routes/shadow.ts — a report on a different ` +
        `population than the decisions it explains cannot be reconciled:\n${ungated.join("\n")}`,
    ).toEqual([]);
  });
});

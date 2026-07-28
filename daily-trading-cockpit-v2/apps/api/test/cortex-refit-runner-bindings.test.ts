import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cortexWiredOutcomeSourceLaneIds,
  gatherCortexRefitInputs,
  startOfUtcDayMs,
  CORTEX_LANE_ROSTER,
  cortexCgRouterVariantId,
  cortexCgRouterOutcomesEnabled,
  cortexCgRouterIncludeMaxHoldMtm,
  collectCortexCgRouterObs,
  gatherCortexCgRouterOutcomes,
  formatCortexCgRouterOutcomeSummary,
  CORTEX_CG_ROUTER_ALLOWED_LANE_IDS,
  type CortexCgRouterOrderLike,
} from "../src/lib/cortex-refit-runner-bindings.js";
import { buildCortexAttrRoster, cortexLaneTtlMs } from "../src/lib/cortex-outcome-source.js";
import { attributeOutcomes } from "../src/lib/cortex-attribution.js";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";
import {
  peekPaperExecutionRouterStore,
  _resetPaperExecutionRouterStoreForTests,
} from "../src/lib/paper-execution-router.js";
import { _resetCrossSectionalStoreForTests } from "../src/lib/cross-sectional-edge.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-refit-bindings-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  _resetCrossSectionalStoreForTests();
});

const obs1 = [{}] as const; // a single opaque observation — only the LENGTH matters here

describe("cortexWiredOutcomeSourceLaneIds — the NO_OUTCOME_SOURCE safety net", () => {
  it("reports a lane covered by the directional array as wired", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "A", obs: obs1 }, { laneId: "B", obs: obs1 }], []);
    expect(wired.has("A")).toBe(true);
    expect(wired.has("B")).toBe(true);
  });

  it("reports a lane covered by the xsec array as wired", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([], [{ laneId: "X", obs: obs1 }]);
    expect(wired.has("X")).toBe(true);
  });

  it("reports a lane NOT present in either array as unwired — the exact bug this guards against", () => {
    // Simulates a FUTURE CORTEX_LANE_ROSTER lane added without a matching push into the directional/xsec
    // reader arrays: it must be excluded from the wired set, never optimistically assumed present.
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "A", obs: obs1 }], [{ laneId: "X", obs: obs1 }]);
    expect(wired.has("SOME_NEW_LANE_NOBODY_WIRED_YET")).toBe(false);
  });

  it("[REGRESSION 2026-07-26] a source entry pushed with an EMPTY observation array is NOT a wired source", () => {
    // This is the whole bug: the CG block pushes one entry per CG lane unconditionally, empty or not, so a
    // membership-only test reported a structurally dead source as wired (⇒ INSUFFICIENT_DATA, "just needs
    // more time") instead of NO_OUTCOME_SOURCE. Zero observations is the ABSENCE of a source.
    const wired = cortexWiredOutcomeSourceLaneIds(
      [
        { laneId: "HAS_ROWS", obs: obs1 },
        { laneId: "DEAD_SOURCE", obs: [] },
      ],
      [{ laneId: "DEAD_XSEC", obs: [] }],
    );
    expect(wired.has("HAS_ROWS")).toBe(true);
    expect(wired.has("DEAD_SOURCE")).toBe(false);
    expect(wired.has("DEAD_XSEC")).toBe(false);
  });

  it("a lane fed by TWO source entries is wired when EITHER is non-empty (never 'last entry wins')", () => {
    // The real shape once the paper-router source is on: a CG LONG lane has a (dead) variant-matrix entry
    // AND a (live) router entry. Order must not matter.
    const emptyFirst = cortexWiredOutcomeSourceLaneIds(
      [
        { laneId: "CG_WIDE_FAST_LONG", obs: [] },
        { laneId: "CG_WIDE_FAST_LONG", obs: obs1 },
      ],
      [],
    );
    const emptyLast = cortexWiredOutcomeSourceLaneIds(
      [
        { laneId: "CG_WIDE_FAST_LONG", obs: obs1 },
        { laneId: "CG_WIDE_FAST_LONG", obs: [] },
      ],
      [],
    );
    expect(emptyFirst.has("CG_WIDE_FAST_LONG")).toBe(true);
    expect(emptyLast.has("CG_WIDE_FAST_LONG")).toBe(true);
  });

  it("feeding the derived predicate into buildCortexAttrRoster correctly marks an unwired lane as hasOutcomeSource=false", () => {
    const wired = cortexWiredOutcomeSourceLaneIds([{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", obs: obs1 }], []);
    const roster = buildCortexAttrRoster(
      () => 10,
      (laneId) => wired.has(laneId),
    );
    expect(roster.find((r) => r.laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG")!.hasOutcomeSource).toBe(true);
    // Any other real roster lane not in the fabricated `wired` set must NOT be reported as having a source —
    // proving the check is a real membership test, not the old hardcoded `() => true`.
    const other = roster.find((r) => r.laneId !== "REGIME_COMPOSITE_CONFIRMATION_LONG");
    expect(other).toBeDefined();
    expect(other!.hasOutcomeSource).toBe(false);
  });

  it("[REGRESSION 2026-07-26] an empty-source lane comes out of attributeOutcomes as NO_OUTCOME_SOURCE, not INSUFFICIENT_DATA", () => {
    // End-to-end with the REAL status assignment in cortex-attribution.ts — proving this fix feeds that
    // single definition an honest input rather than inventing a second parallel one.
    const directional = [
      { laneId: "CG_WIDE_FAST_LONG", obs: [] },
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", obs: obs1 },
    ];
    const wired = cortexWiredOutcomeSourceLaneIds(directional, []);
    const roster = buildCortexAttrRoster(
      () => 10,
      (laneId) => wired.has(laneId),
    );
    const result = attributeOutcomes([], [], { currentSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, roster });
    const dead = result.perLane.find((l) => l.laneId === "CG_WIDE_FAST_LONG")!;
    const alive = result.perLane.find((l) => l.laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG")!;
    expect(dead.status).toBe("NO_OUTCOME_SOURCE");
    expect(alive.status).toBe("INSUFFICIENT_DATA"); // wired, simply nothing attributed yet — the honest label
  });
});

describe("startOfUtcDayMs — the boundary the #219 'today' decision-alpha slice is built on", () => {
  it("mid-day timestamp floors to that day's UTC midnight", () => {
    expect(startOfUtcDayMs(Date.parse("2026-07-21T15:43:07.512Z"))).toBe(Date.parse("2026-07-21T00:00:00.000Z"));
  });

  it("exactly at midnight is its own boundary (not the previous day)", () => {
    const midnight = Date.parse("2026-07-21T00:00:00.000Z");
    expect(startOfUtcDayMs(midnight)).toBe(midnight);
  });

  it("one millisecond before midnight belongs to the PREVIOUS day", () => {
    expect(startOfUtcDayMs(Date.parse("2026-07-21T00:00:00.000Z") - 1)).toBe(Date.parse("2026-07-20T00:00:00.000Z"));
  });

  it("is stable across a full day: every ms in [start, start+86400000) maps to the same boundary", () => {
    const start = startOfUtcDayMs(Date.parse("2026-07-21T09:00:00.000Z"));
    expect(startOfUtcDayMs(start)).toBe(start);
    expect(startOfUtcDayMs(start + 86_400_000 - 1)).toBe(start);
    expect(startOfUtcDayMs(start + 86_400_000)).toBe(start + 86_400_000); // rolls into the NEXT day
  });
});

describe("gatherCortexRefitInputs — end-to-end roster wiring sanity", () => {
  it("[REGRESSION 2026-07-26] with EVERY store empty, every roster lane reports hasOutcomeSource=false", () => {
    // Before the fix this asserted the exact opposite (all 15 "wired") on this very same empty dataDir —
    // which was the bug in miniature: readers that yield nothing were being reported as live sources.
    const dataDir = tmp();
    const nowMs = Date.parse("2026-07-19T00:00:00Z");
    const blocked = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"),
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      staticWeightPctForLane: () => 0,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(blocked.outcomes).toHaveLength(0);
    expect(blocked.roster.every((lane) => lane.hasOutcomeSource === false)).toBe(true);

    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"), // nonexistent — journal reads must tolerate this
      nowMs: Date.parse("2026-07-19T00:00:00Z"),
      nowIso: "2026-07-19T00:00:00Z",
      staticWeightPctForLane: () => 0,
    });
    expect(input.roster).toHaveLength(CORTEX_LANE_ROSTER.length);
    for (const entry of input.roster) {
      expect(entry.hasOutcomeSource).toBe(false);
    }
  });

  it("[REGRESSION 2026-07-22] a real CLOSED cross-sectional observation on disk is actually read into outcomes — the store constructor path bug made this always empty", () => {
    const dataDir = tmp();
    const nowMs = Date.parse("2026-07-22T00:00:00Z");
    // Written at the exact real on-disk shape CrossSectionalStore persists (cross-sectional-edge.ts's
    // CrossSectionalState), directly to `${dataDir}/cross-sectional-edge.json` — the real file path,
    // not a hand-built fixture passed straight into the function under test.
    writeFileSync(
      join(dataDir, "cross-sectional-edge.json"),
      JSON.stringify({
        version: 1,
        lastCycleAt: "2026-07-21T23:00:00.000Z",
        observations: [
          {
            observationId: "xsec:MOM24_FILTERED:1",
            openedAt: "2026-07-20T00:00:00.000Z",
            openedAtMs: Date.parse("2026-07-20T00:00:00.000Z"),
            horizonMs: 24 * 3_600_000,
            signal: "MOM24_FILTERED",
            variant: "FILTERED", // maps to CROSS_SECTIONAL_MARKET_NEUTRAL, see XSEC_STORE_VARIANTS
            k: 1,
            longLeg: [{ symbol: "SOLUSDT", entryPrice: 100, exitPrice: 101 }],
            shortLeg: [{ symbol: "DOGEUSDT", entryPrice: 0.1, exitPrice: 0.099 }],
            status: "CLOSED",
            grossReturn: 0.02,
            costReturn: -0.003,
            netReturn: 0.017,
            longLegReturn: 0.01,
            shortLegReturn: 0.007,
            resolvedAt: "2026-07-21T00:00:00.000Z",
            riskDistanceAtOpen: 0.01,
          },
        ],
      }),
    );

    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"),
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      staticWeightPctForLane: () => 0,
      env: { CORTEX_ALLOW_RAW_STORE_TRAINING: "1" } as NodeJS.ProcessEnv,
    });

    const xsecOutcome = input.outcomes.find((o) => o.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL");
    expect(xsecOutcome).toBeDefined();
    expect(xsecOutcome!.observationId).toBe("xsec:MOM24_FILTERED:1");
    expect(xsecOutcome!.netR).toBeCloseTo(0.017 / 0.01, 10);

    // …and ONLY that lane is reported as having a source: the other two xsec variants share the same
    // (now non-empty) store file yet have zero rows of their own, so they must stay NO_OUTCOME_SOURCE.
    const byLane = new Map(input.roster.map((r) => [r.laneId, r.hasOutcomeSource]));
    expect(byLane.get("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(true);
    expect(byLane.get("CROSS_SECTIONAL_TREND")).toBe(false);
    expect(byLane.get("CROSS_SECTIONAL_MIXED")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// CG paper-execution-router outcome source (2026-07-26) — env-gated, DEFAULT OFF.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const CG_LONG_PREFIX = "CG_LONG_VARIANT_MATRIX:";
const CG_PREFIX = "CG_VARIANT_MATRIX:";
const OPEN_ISO = "2026-07-22T10:00:00.000Z";
const CLOSED_MS = Date.parse("2026-07-22T14:00:00.000Z");

function order(over: Partial<CortexCgRouterOrderLike> & { selectedLaneId: string }): CortexCgRouterOrderLike {
  return {
    paperOrderId: "po-1",
    direction: "LONG",
    openedAt: OPEN_ISO,
    paperStatus: "PAPER_CLOSED_WIN",
    netR: 0.5,
    closedAtMs: CLOSED_MS,
    closeReason: "TP1",
    ...over,
  };
}

describe("cortexCgRouterVariantId — (b) BOTH router namespaces strip, and only those", () => {
  it("strips CG_VARIANT_MATRIX:", () => {
    expect(cortexCgRouterVariantId(`${CG_PREFIX}CG_MFE_GIVEBACK`)).toBe("CG_MFE_GIVEBACK");
  });
  it("strips CG_LONG_VARIANT_MATRIX: (which does NOT start with the other prefix, so no ambiguity)", () => {
    expect(cortexCgRouterVariantId(`${CG_LONG_PREFIX}CG_MFE_GIVEBACK`)).toBe("CG_MFE_GIVEBACK");
  });
  it("returns null for a lane id carrying neither prefix — this source must ignore it entirely", () => {
    expect(cortexCgRouterVariantId("SCAN_ALLOCATOR:CG_MFE_GIVEBACK")).toBeNull();
    expect(cortexCgRouterVariantId("CG_MFE_GIVEBACK")).toBeNull();
    expect(cortexCgRouterVariantId("")).toBeNull();
    expect(cortexCgRouterVariantId(null)).toBeNull();
  });
  it("returns null for a bare prefix with no variant id after it", () => {
    expect(cortexCgRouterVariantId(CG_PREFIX)).toBeNull();
    expect(cortexCgRouterVariantId(CG_LONG_PREFIX)).toBeNull();
  });
});

describe("collectCortexCgRouterObs — (a) the three-lane allowlist", () => {
  it("routes each of the three dead LONG lanes to its CORTEX lane id", () => {
    const { byLane } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "a", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG` }),
        order({ paperOrderId: "b", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_LONG_RUNNER` }),
        order({ paperOrderId: "c", selectedLaneId: `${CG_LONG_PREFIX}CG_MFE_GIVEBACK` }),
      ],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.get("CG_WIDE_FAST_LONG")!.map((o) => o.observationId)).toEqual(["router:a"]);
    expect(byLane.get("CG_WIDE_LONG_RUNNER")!.map((o) => o.observationId)).toEqual(["router:b"]);
    expect(byLane.get("CG_MFE_GIVEBACK_LONG")!.map((o) => o.observationId)).toEqual(["router:c"]);
  });

  it("[REGRESSION] a SHORT CG_MFE_GIVEBACK router order NEVER reaches CG_MFE_GIVEBACK_SHORT", () => {
    // The naive `CG_ROSTER.find(l => l.variantId === v && l.direction === ord.direction)` form would have
    // matched this and taken that already-healthy 81-example VM-sourced lane to 281 by blending a second
    // data-generating process into it mid-flight. The allowlist is LONG-only, by construction.
    const { byLane, byLaneCounts } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "s1", selectedLaneId: `${CG_PREFIX}CG_MFE_GIVEBACK`, direction: "SHORT" }),
        order({ paperOrderId: "s2", selectedLaneId: `${CG_LONG_PREFIX}CG_MFE_GIVEBACK`, direction: "SHORT" }),
      ],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.has("CG_MFE_GIVEBACK_SHORT")).toBe(false);
    expect(byLaneCounts.CG_MFE_GIVEBACK_SHORT).toBeUndefined();
    // …and the SHORT orders were not smuggled into the LONG book either.
    for (const rows of byLane.values()) expect(rows).toHaveLength(0);
    expect(CORTEX_CG_ROUTER_ALLOWED_LANE_IDS).toEqual(["CG_WIDE_FAST_LONG", "CG_WIDE_LONG_RUNNER", "CG_MFE_GIVEBACK_LONG"]);
    expect(CORTEX_CG_ROUTER_ALLOWED_LANE_IDS).not.toContain("CG_MFE_GIVEBACK_SHORT");
  });

  it("ignores variant-matrix lanes that are not on the allowlist (e.g. CG_WIDE_STOP_TP_WIDE)", () => {
    const { byLane } = collectCortexCgRouterObs(
      [order({ paperOrderId: "x", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_STOP_TP_WIDE` })],
      { includeMaxHoldMtm: false },
    );
    for (const rows of byLane.values()) expect(rows).toHaveLength(0);
  });
});

describe("collectCortexCgRouterObs — (b) direction comes from the ORDER, never from the prefix", () => {
  it("BOTH prefixes map a LONG order to the same LONG lane", () => {
    const { byLane } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "p1", selectedLaneId: `${CG_PREFIX}CG_MFE_GIVEBACK`, direction: "LONG" }),
        order({ paperOrderId: "p2", selectedLaneId: `${CG_LONG_PREFIX}CG_MFE_GIVEBACK`, direction: "LONG" }),
      ],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.get("CG_MFE_GIVEBACK_LONG")!.map((o) => o.observationId)).toEqual(["router:p1", "router:p2"]);
  });

  it("a CG_LONG_-prefixed order whose own direction is SHORT is DROPPED — the prefix is not a direction label", () => {
    const { byLane } = collectCortexCgRouterObs(
      [order({ paperOrderId: "liar", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, direction: "SHORT" })],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.get("CG_WIDE_FAST_LONG")).toHaveLength(0);
  });
});

describe("collectCortexCgRouterObs — (d) MAX_HOLD_MTM honesty guard", () => {
  const orders = [
    order({ paperOrderId: "real", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_LONG_RUNNER`, closeReason: "TP1" }),
    order({ paperOrderId: "mtm", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_LONG_RUNNER`, closeReason: "MAX_HOLD_MTM", netR: 3.2 }),
  ];

  it("EXCLUDES mark-to-market closes by default, and COUNTS the exclusion (never a silent drop)", () => {
    const { byLane, byLaneCounts } = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: false });
    expect(byLane.get("CG_WIDE_LONG_RUNNER")!.map((o) => o.observationId)).toEqual(["router:real"]);
    expect(byLaneCounts.CG_WIDE_LONG_RUNNER).toMatchObject({ admitted: 1, maxHoldMtmExcluded: 1, maxHoldMtmIncluded: 0 });
  });

  it("admits them ONLY under the dedicated flag, and namespaces them router-mtm: so provenance is permanent", () => {
    const { byLane, byLaneCounts } = collectCortexCgRouterObs(orders, { includeMaxHoldMtm: true });
    expect(byLane.get("CG_WIDE_LONG_RUNNER")!.map((o) => o.observationId)).toEqual(["router:real", "router-mtm:mtm"]);
    expect(byLaneCounts.CG_WIDE_LONG_RUNNER).toMatchObject({ admitted: 2, maxHoldMtmExcluded: 0, maxHoldMtmIncluded: 1 });
  });

  it("turning the router source on does NOT turn MTM on — they are separate flags", () => {
    expect(cortexCgRouterIncludeMaxHoldMtm({ CORTEX_CG_ROUTER_OUTCOMES: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(cortexCgRouterIncludeMaxHoldMtm({ CORTEX_CG_ROUTER_INCLUDE_MTM: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("the operator-facing log line SHOUTS when MTM marks were admitted, and stays quiet when they were not", () => {
    const on = gatherCgRouterWith({ CORTEX_CG_ROUTER_OUTCOMES: "1", CORTEX_CG_ROUTER_INCLUDE_MTM: "1" }, orders);
    const off = gatherCgRouterWith({ CORTEX_CG_ROUTER_OUTCOMES: "1" }, orders);
    expect(on.summary.maxHoldMtmIncludedTotal).toBe(1);
    expect(formatCortexCgRouterOutcomeSummary(on.summary)).toContain("NOT-REALIZED");
    expect(formatCortexCgRouterOutcomeSummary(on.summary)).toContain("MAX_HOLD_MTM");
    expect(off.summary.maxHoldMtmIncludedTotal).toBe(0);
    expect(formatCortexCgRouterOutcomeSummary(off.summary)).not.toContain("NOT-REALIZED");
    expect(formatCortexCgRouterOutcomeSummary(off.summary)).toContain("mtmExcluded=1");
  });
});

function gatherCgRouterWith(env: Record<string, string>, orders: readonly CortexCgRouterOrderLike[]) {
  return gatherCortexCgRouterOutcomes({ env: env as NodeJS.ProcessEnv, readOrders: () => orders });
}

describe("collectCortexCgRouterObs — corrupt/non-closed rows are surfaced, never silent", () => {
  it("non-WIN/LOSS statuses are skipped and counted per lane", () => {
    const { byLane, byLaneCounts } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "open", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, paperStatus: "PAPER_FILLED" }),
        order({ paperOrderId: "rej", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, paperStatus: "PAPER_REJECTED" }),
      ],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.get("CG_WIDE_FAST_LONG")).toHaveLength(0);
    expect(byLaneCounts.CG_WIDE_FAST_LONG).toMatchObject({ admitted: 0, nonClosedSkipped: 2 });
  });

  it("a corrupt openedAt becomes NaN and a missing closedAtMs becomes resolvedAt=null — both tally as BAD_TIMESTAMP downstream", () => {
    const { byLane } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "bad-open", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, openedAt: "not-a-date" }),
        order({ paperOrderId: "no-close", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, closedAtMs: null }),
      ],
      { includeMaxHoldMtm: false },
    );
    const rows = byLane.get("CG_WIDE_FAST_LONG")!;
    expect(Number.isNaN(rows[0]!.openedAtMs)).toBe(true);
    expect(rows[1]!.resolvedAt).toBeNull();
  });

  it("an out-of-Date-range closedAtMs degrades to resolvedAt=null instead of throwing RangeError", () => {
    // toISOString() throws beyond ±8.64e15. This code runs inside the real-money mainnet process, so one
    // corrupt row must never take down the whole nightly refit.
    expect(() =>
      collectCortexCgRouterObs(
        [order({ paperOrderId: "huge", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, closedAtMs: 1e20 })],
        { includeMaxHoldMtm: false },
      ),
    ).not.toThrow();
    const { byLane } = collectCortexCgRouterObs(
      [order({ paperOrderId: "huge", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, closedAtMs: 1e20 })],
      { includeMaxHoldMtm: false },
    );
    expect(byLane.get("CG_WIDE_FAST_LONG")![0]!.resolvedAt).toBeNull();
  });

  it("uses closedAtMs (the MARKET close), and maps WIN/LOSS to the normalizer's status vocabulary", () => {
    const { byLane } = collectCortexCgRouterObs(
      [
        order({ paperOrderId: "w", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, paperStatus: "PAPER_CLOSED_WIN" }),
        order({ paperOrderId: "l", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG`, paperStatus: "PAPER_CLOSED_LOSS", netR: -1 }),
      ],
      { includeMaxHoldMtm: false },
    );
    const rows = byLane.get("CG_WIDE_FAST_LONG")!;
    expect(rows.map((r) => r.status)).toEqual(["CLOSED_WIN", "CLOSED_LOSS"]);
    expect(rows[0]!.resolvedAt).toBe(new Date(CLOSED_MS).toISOString());
  });
});

describe("CG router source — (c) cold-parse guard + default-OFF flag", () => {
  it("the flag defaults OFF and only exact \"1\" enables it", () => {
    expect(cortexCgRouterOutcomesEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(cortexCgRouterOutcomesEnabled({ CORTEX_CG_ROUTER_OUTCOMES: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(cortexCgRouterOutcomesEnabled({ CORTEX_CG_ROUTER_OUTCOMES: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(cortexCgRouterOutcomesEnabled({ CORTEX_CG_ROUTER_OUTCOMES: "1" } as NodeJS.ProcessEnv)).toBe(true);
    // …and nothing in this repo's default environment turns it on.
    expect(cortexCgRouterOutcomesEnabled()).toBe(false);
  });

  it("[DEFAULT-OFF] with the flag unset the order reader is NEVER CALLED — no store touched at all", () => {
    let calls = 0;
    const dataDir = tmp();
    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile: join(dataDir, "cortex-decisions.jsonl"),
      nowMs: Date.parse("2026-07-26T00:00:00Z"),
      nowIso: "2026-07-26T00:00:00Z",
      staticWeightPctForLane: () => 0,
      env: {} as NodeJS.ProcessEnv,
      readCgRouterOrders: () => {
        calls += 1;
        return [order({ selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG` })];
      },
    });
    expect(calls).toBe(0);
    expect(input.outcomes).toHaveLength(0);
    expect(input.cgRouterOutcomes).toMatchObject({ enabled: false, storeResident: false, ordersScanned: 0 });
    expect(input.roster.find((r) => r.laneId === "CG_WIDE_FAST_LONG")!.hasOutcomeSource).toBe(false);
  });

  it("[COLD-PARSE GUARD] the default reader peeks and NEVER constructs the 107MB paper-router store", () => {
    _resetPaperExecutionRouterStoreForTests();
    expect(peekPaperExecutionRouterStore()).toBeNull();
    const { byLane, summary } = gatherCortexCgRouterOutcomes({
      env: { CORTEX_CG_ROUTER_OUTCOMES: "1" } as NodeJS.ProcessEnv,
    });
    expect(byLane.size).toBe(0);
    expect(summary).toMatchObject({ enabled: true, storeResident: false, ordersScanned: 0 });
    // The peek must not have created it as a side effect — that is the whole point of the guard.
    expect(peekPaperExecutionRouterStore()).toBeNull();
    expect(formatCortexCgRouterOutcomeSummary(summary)).toContain("NOT resident");
  });

  it("a disabled source emits NO log line (a default-off feature must not add noise to every refit)", () => {
    expect(formatCortexCgRouterOutcomeSummary(gatherCgRouterWith({}, []).summary)).toBeNull();
  });
});

describe("[PASS-WITH] flag ON: the three dead LONG CG lanes reach LEARNING_ACTIVE, CG_MFE_GIVEBACK_SHORT is untouched", () => {
  const nowMs = Date.parse("2026-07-26T00:00:00Z");
  const baseMs = Date.parse("2026-07-24T00:00:00Z");
  const LANES = [
    { laneId: "CG_WIDE_FAST_LONG", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_FAST_LONG` },
    { laneId: "CG_WIDE_LONG_RUNNER", selectedLaneId: `${CG_LONG_PREFIX}CG_WIDE_LONG_RUNNER` },
    { laneId: "CG_MFE_GIVEBACK_LONG", selectedLaneId: `${CG_PREFIX}CG_MFE_GIVEBACK` }, // the OTHER prefix, on purpose
  ] as const;

  function buildOrders(): CortexCgRouterOrderLike[] {
    const out: CortexCgRouterOrderLike[] = [];
    for (const lane of LANES) {
      for (let i = 0; i < 22; i += 1) {
        const openMs = baseMs + i * 3_600_000;
        out.push(
          order({
            paperOrderId: `${lane.laneId}-${i}`,
            selectedLaneId: lane.selectedLaneId,
            openedAt: new Date(openMs).toISOString(),
            closedAtMs: openMs + 30 * 60_000,
            paperStatus: i % 2 === 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
            netR: i % 2 === 0 ? 0.8 : -1,
          }),
        );
      }
    }
    // A SHORT CG_MFE_GIVEBACK book that must remain invisible to this source.
    for (let i = 0; i < 30; i += 1) {
      const openMs = baseMs + i * 3_600_000;
      out.push(
        order({
          paperOrderId: `short-${i}`,
          selectedLaneId: `${CG_PREFIX}CG_MFE_GIVEBACK`,
          direction: "SHORT",
          openedAt: new Date(openMs).toISOString(),
          closedAtMs: openMs + 30 * 60_000,
        }),
      );
    }
    return out;
  }

  /** A journal with one BRAIN_DECISION 10 minutes before every order open — inside the 50-min TTL. */
  function writeJournal(file: string): void {
    const lines: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const atMs = baseMs + i * 3_600_000 - 10 * 60_000;
      lines.push(
        JSON.stringify({
          kind: "BRAIN_DECISION",
          at: new Date(atMs).toISOString(),
          featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
          regimeFamily: "BULLISH",
          lanes: [
            ...LANES.map((l) => ({ laneId: l.laneId, x: [0.1, 0.2], eligible: true, direction: "LONG", finalPct: 5, evalFinalPct: 5 })),
            { laneId: "CG_MFE_GIVEBACK_SHORT", x: [0.1, 0.2], eligible: true, direction: "SHORT", finalPct: 5, evalFinalPct: 5 },
          ],
        }),
      );
    }
    writeFileSync(file, lines.join("\n") + "\n");
  }

  function statuses(env: Record<string, string>) {
    const dataDir = tmp();
    const journalFile = join(dataDir, "cortex-decision-journal.jsonl");
    writeJournal(journalFile);
    const input = gatherCortexRefitInputs({
      dataDir,
      journalFile,
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      staticWeightPctForLane: () => 0,
      env: env as NodeJS.ProcessEnv,
      readCgRouterOrders: buildOrders,
    });
    const attr = attributeOutcomes(input.decisions, input.outcomes, {
      currentSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
      roster: input.roster,
      ttlMsForLane: cortexLaneTtlMs,
    });
    return { input, byLane: new Map(attr.perLane.map((l) => [l.laneId, l])) };
  }

  it("[FAIL-WITHOUT] flag OFF: all three stay NO_OUTCOME_SOURCE with zero examples", () => {
    const { byLane, input } = statuses({});
    expect(input.outcomes).toHaveLength(0);
    for (const lane of LANES) {
      expect(byLane.get(lane.laneId)!.status).toBe("NO_OUTCOME_SOURCE");
      expect(byLane.get(lane.laneId)!.attributed).toBe(0);
    }
  });

  it("[PASS-WITH] flag ON: all three flip to LEARNING_ACTIVE on router-sourced examples", () => {
    const { byLane, input } = statuses({ CORTEX_CG_ROUTER_OUTCOMES: "1", CORTEX_ALLOW_RAW_STORE_TRAINING: "1" });
    for (const lane of LANES) {
      const l = byLane.get(lane.laneId)!;
      expect(l.status).toBe("LEARNING_ACTIVE");
      expect(l.attributed).toBe(22);
    }
    expect(input.cgRouterOutcomes).toMatchObject({ enabled: true, storeResident: true, ordersScanned: 96 });
    // Every admitted observationId is router-namespaced, so it can never collide with a variant-matrix id.
    for (const o of input.outcomes) expect(o.observationId.startsWith("router:")).toBe(true);
  });

  it("[PASS-WITH] CG_MFE_GIVEBACK_SHORT gains NOTHING — its 30 SHORT router orders are invisible to this source", () => {
    const { byLane } = statuses({ CORTEX_CG_ROUTER_OUTCOMES: "1", CORTEX_ALLOW_RAW_STORE_TRAINING: "1" });
    const short = byLane.get("CG_MFE_GIVEBACK_SHORT")!;
    expect(short.outcomesSeen).toBe(0);
    expect(short.attributed).toBe(0);
    expect(short.status).toBe("NO_OUTCOME_SOURCE"); // its own VM store is empty in this fixture — unchanged
  });
});

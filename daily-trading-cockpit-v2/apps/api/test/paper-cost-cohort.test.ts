import { describe, it, expect } from "vitest";
import {
  costModelGenerationOf,
  partitionByCostModelGeneration,
  selectNewestCostCohort,
  LEGACY_COST_MODEL_GENERATION,
} from "../src/lib/paper-cost-cohort.js";
import { computeAutoQuarantinedVariantLanes } from "../src/lib/paper-opportunity-allocator.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";

/**
 * COST-MODEL COHORT SELECTION (2026-07-28).
 *
 * paper-execution-router.ts stamps `costModelVersion` on every close and states the rule outright —
 * "Two generations are NOT comparable and must never be pooled silently" — then concedes in the same
 * comment that the stamp had ZERO readers. Auto-quarantine, the promotion telemetry, the CORTEX
 * router outcome source and the meta-label cohort table all averaged netR straight across
 * generations. That matters because a generation change moves netR with NO edge change (v1->v2 alone
 * moved maker lanes up to +16bps/stopBps and taker stop-heavy lanes -5bps), and auto-quarantine
 * HALTS a lane's paper admission with no human in the loop.
 */

describe("cost-model generation identity", () => {
  it("treats an absent stamp as the legacy generation, never as the current one", () => {
    // The router documents an absent field as "a legacy row written before stamping existed — also
    // v1, but unverified". Silently folding those in with today's rows is the pooling this prevents.
    expect(costModelGenerationOf({})).toBe(LEGACY_COST_MODEL_GENERATION);
    expect(costModelGenerationOf({ costModelVersion: null })).toBe(LEGACY_COST_MODEL_GENERATION);
    expect(costModelGenerationOf({ costModelVersion: Number.NaN })).toBe(LEGACY_COST_MODEL_GENERATION);
    expect(costModelGenerationOf({ costModelVersion: 2 })).toBe(2);
  });

  it("partitions without losing or duplicating a row", () => {
    const rows = [{ costModelVersion: 1 }, { costModelVersion: 2 }, {}, { costModelVersion: 2 }];
    const parts = partitionByCostModelGeneration(rows);
    expect(parts.get(1)).toHaveLength(2); // the unstamped row joins generation 1
    expect(parts.get(2)).toHaveLength(2);
    expect([...parts.values()].flat()).toHaveLength(rows.length);
  });
});

describe("selecting a comparable cohort", () => {
  const gen = (v: number | null, n: number) => Array.from({ length: n }, () => ({ costModelVersion: v }));

  it("returns the NEWEST generation and names what it left out", () => {
    const cohort = selectNewestCostCohort([...gen(1, 5), ...gen(2, 3)])!;
    expect(cohort.generation).toBe(2);
    expect(cohort.rows).toHaveLength(3);
    expect(cohort.excludedGenerations).toEqual([1]);
    expect(cohort.totalRows).toBe(8);
  });

  /**
   * The reason this selects "newest with enough evidence" instead of "current generation only".
   * On the day a generation changes, the new cohort is tiny; hard-filtering to it would drop every
   * lane to "no evidence" at once and release anything currently quarantined. Falling back to the
   * newest generation that still carries a full sample keeps the decision stable through a cutover
   * while never averaging the two together.
   */
  it("falls back to an older generation that still carries the required sample", () => {
    const cohort = selectNewestCostCohort([...gen(1, 40), ...gen(2, 2)], 40)!;
    expect(cohort.generation).toBe(1);
    expect(cohort.rows).toHaveLength(40);
  });

  it("returns null when no single generation meets the bar, rather than pooling to reach it", () => {
    // 25 + 25 would clear a 40-row gate ONLY by pooling. That is the bug, not the fallback.
    expect(selectNewestCostCohort([...gen(1, 25), ...gen(2, 25)], 40)).toBeNull();
    expect(selectNewestCostCohort([], 0)).toBeNull();
  });
});

// ── the consequential consumer ───────────────────────────────────────────────

const CLOSED_LOSS = "PAPER_CLOSED_LOSS";
// Must be a real VARIANT_MATRIX_DIAGNOSTIC_IDS member — computeAutoQuarantinedVariantLanes only
// considers those suffixes, so an invented lane id silently matches nothing and every
// assertion below would pass vacuously.
const LANE = "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT";

function order(netR: number, costModelVersion: number | null, i: number): PaperOrder {
  return {
    paperOrderId: `q-${costModelVersion}-${i}`,
    selectedLaneId: LANE,
    paperStatus: CLOSED_LOSS,
    netR,
    costModelVersion,
    symbol: "ETHUSDT",
    direction: "LONG",
  } as unknown as PaperOrder;
}

describe("[QUARANTINE] auto-quarantine never pools two cost generations", () => {
  /**
   * Auto-quarantine halts a lane's paper admission with no human review. Pooling lets a cost-model
   * changeover flip that decision on or off with nothing in any store recording that bookkeeping,
   * not edge, was the cause.
   */
  it("judges on the newest generation carrying a full sample, ignoring the older one", () => {
    // Old generation is clearly negative and would quarantine on its own; the new one is healthy.
    const rows = [
      ...Array.from({ length: 45 }, (_, i) => order(-0.5, 1, i)),
      ...Array.from({ length: 45 }, (_, i) => order(+0.5, 2, i)),
    ];
    // Pooled, the mean is 0.0 -> above the -0.03 bar either way, so use a sharper case below.
    expect(computeAutoQuarantinedVariantLanes(rows)).not.toContain(LANE);

    // Newest generation is the negative one: it must quarantine even though pooling would rescue it.
    const flipped = [
      ...Array.from({ length: 45 }, (_, i) => order(+0.5, 1, i)),
      ...Array.from({ length: 45 }, (_, i) => order(-0.5, 2, i)),
    ];
    expect(computeAutoQuarantinedVariantLanes(flipped)).toContain(LANE);
  });

  it("does not quarantine when only a pooled population could reach the sample gate", () => {
    // 25 + 25 clears the 40-row minimum only by pooling incomparable rows. "Not enough comparable
    // evidence" is the same answer AUTO_QUARANTINE_MIN_CLOSED already gives, and it fails toward
    // NOT halting a lane.
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => order(-0.9, 1, i)),
      ...Array.from({ length: 25 }, (_, i) => order(-0.9, 2, i)),
    ];
    expect(computeAutoQuarantinedVariantLanes(rows)).not.toContain(LANE);
  });

  it("still quarantines a genuinely negative single-generation lane (the feature must survive)", () => {
    const rows = Array.from({ length: 45 }, (_, i) => order(-0.4, 2, i));
    expect(computeAutoQuarantinedVariantLanes(rows)).toContain(LANE);
  });
});

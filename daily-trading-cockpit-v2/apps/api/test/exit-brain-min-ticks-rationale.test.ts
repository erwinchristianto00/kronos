import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXIT_BRAIN_PARAMS } from "../src/lib/exit-brain-policy.js";
import { resolvedTradesFromShadowPositions } from "../src/lib/exit-brain-shadow.js";

/**
 * The Exit Brain scores ~12% of resolved trades and the excluded ones sit at exactly 4 ticks — two
 * short of minEvaluableTicks. That reads like a threshold set just above its own population, and it
 * is not: those 4-tick entries are shadow-position SKELETONS, four synthetic points rebuilt from
 * aggregates (open at R=0, the MFE stamp, the MAE stamp, the close). The policy is retrace-based, so
 * scoring it against the very extremes it exists to detect would be circular — coverage would jump
 * to ~90% and the number would stop meaning anything.
 *
 * These tests exist so that reasoning survives the next person who sees 12% and reaches for the knob.
 */
const POLICY_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/exit-brain-policy.ts"), "utf-8");

const position = (o: Record<string, unknown> = {}) => ({
  primaryVariant: "V", selectedExitVariant: "V",
  variants: [{
    variant: "V", state: "CLOSED",
    openedAt: new Date(1_800_000_000_000).toISOString(),
    closedAt: new Date(1_800_000_000_000 + 4 * 3_600_000).toISOString(),
    maxFavorableAt: new Date(1_800_000_000_000 + 1 * 3_600_000).toISOString(),
    maxAdverseAt: new Date(1_800_000_000_000 + 2 * 3_600_000).toISOString(),
    mfeR: 0.8, maeR: 0.3, realizedNetR: 0.2,
    ...o,
  }],
}) as never;

describe("the excluded population really is a skeleton, not a path", () => {
  it("a shadow position yields exactly four synthetic points", () => {
    const [trade] = resolvedTradesFromShadowPositions([position()]);
    expect(trade).toBeDefined();
    expect(trade!.ticks).toHaveLength(4);
  });

  /** Those points ARE the extremes the retrace policy is supposed to discover — open, MFE, MAE,
   *  close. Nothing between them exists, so a giveback fraction has nothing to measure against. */
  it("its points are the aggregates themselves, with no intra-trade movement", () => {
    const [trade] = resolvedTradesFromShadowPositions([position()]);
    const rs = trade!.ticks.map((p) => p.currentR);
    expect(rs[0]).toBe(0);
    expect(rs[1]).toBe(0.8);   // the MFE it is meant to detect
    expect(rs[2]).toBe(-0.3);  // the MAE
    expect(rs[3]).toBe(0.2);   // the realized close
  });

  /** Missing extreme stamps degrade to 2 points — the other excluded bucket. */
  it("degrades to two points when the extremes carry no timestamp", () => {
    const [trade] = resolvedTradesFromShadowPositions([position({ maxFavorableAt: null, maxAdverseAt: null })]);
    expect(trade!.ticks).toHaveLength(2);
  });

  /** THE GUARD: 6 keeps every skeleton out. Lowering to 4 admits all of them. */
  it("the threshold sits above the skeleton size, deliberately", () => {
    const [skeleton] = resolvedTradesFromShadowPositions([position()]);
    expect(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks).toBeGreaterThan(skeleton!.ticks.length);
    expect(DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks).toBe(6);
  });

  it("the reasoning is recorded where the knob is, not only in a commit message", () => {
    expect(POLICY_SRC).toContain("DO NOT LOWER THIS TO RAISE COVERAGE");
    expect(POLICY_SRC).toContain("SHADOW-POSITION SKELETONS");
  });
});

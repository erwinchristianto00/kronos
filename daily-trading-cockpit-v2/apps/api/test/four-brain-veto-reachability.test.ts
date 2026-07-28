import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SAMPLES } from "../src/lib/four-brain-edge-memory.js";
import { maxDirectionRecords } from "../src/lib/direction-entry-outcome-store.js";

/**
 * The four-brain has exactly ONE wire into a decision: direction-brain.ts halves the LONG/SHORT
 * score on a VETO_NEGATIVE verdict. That verdict needs `effectiveN >= MIN_SAMPLES` DISTINCT
 * horizon blocks, so the retention cap on the backing store decides whether the wire can ever
 * carry current. At 800 records (~53h observed) it could not: INTRADAY needs 120h, SWING 720h.
 * The system measured LONG/INTRADAY at -0.475R over n=305 and reported "insufficient evidence".
 *
 * These tests pin the ARITHMETIC RELATIONSHIP, not the constant — so lowering retention, or
 * raising MIN_SAMPLES, fails here with the reason attached rather than silently re-severing it.
 */
const HOUR_MS = 3_600_000;
const HORIZON_MS = { SCALP: 1 * HOUR_MS, INTRADAY: 4 * HOUR_MS, SWING: 24 * HOUR_MS };
/** Decisions per hour measured on the research/testnet stores (800 records spanned ~53h). */
const OBSERVED_RECORDS_PER_HOUR = 800 / 53;

const STORE_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/direction-entry-outcome-store.ts"),
  "utf-8",
);

/** The REAL cap, read from the module — not a local copy of the formula. A reimplementation here
 *  would keep passing if someone set the constant back to 800, which is the whole failure this
 *  file exists to prevent. */
const capFor = maxDirectionRecords;

describe("the four-brain veto must be arithmetically reachable", () => {
  it("INTRADAY: retention covers the horizon-blocks MIN_SAMPLES demands", () => {
    const hoursNeeded = (MIN_SAMPLES * HORIZON_MS.INTRADAY) / HOUR_MS;
    const recordsNeeded = hoursNeeded * OBSERVED_RECORDS_PER_HOUR;
    expect(hoursNeeded).toBe(120);
    expect(capFor({} as NodeJS.ProcessEnv)).toBeGreaterThanOrEqual(recordsNeeded);
  });

  /** FAILS WITHOUT THE FIX — 800 records is ~53h against the 120h INTRADAY needs. */
  it("the OLD cap of 800 was unreachable, and by roughly 2.3x", () => {
    const hoursAt800 = 800 / OBSERVED_RECORDS_PER_HOUR;
    const hoursNeeded = (MIN_SAMPLES * HORIZON_MS.INTRADAY) / HOUR_MS;
    expect(hoursAt800).toBeLessThan(hoursNeeded);
    expect(hoursNeeded / hoursAt800).toBeGreaterThan(2);
  });

  /** SWING is knowingly still out of reach; pinned so it is a decision, not an oversight. */
  it("SWING remains unreachable, deliberately, and the doc says so", () => {
    const hoursNeeded = (MIN_SAMPLES * HORIZON_MS.SWING) / HOUR_MS;
    expect(hoursNeeded).toBe(720);
    expect(capFor({} as NodeJS.ProcessEnv)).toBeLessThan(hoursNeeded * OBSERVED_RECORDS_PER_HOUR);
    expect(STORE_SRC).toContain("SWING stays out of reach on purpose");
  });

  it("the direction side is no longer starved relative to the entry side", () => {
    // The wired-to-a-decision side had 800 while the unwired entry side had 2500. Nothing
    // documented that, and it is what made the veto impossible.
    const entryCap = Number(/const MAX_ENTRY_RECORDS = (\d+)/.exec(STORE_SRC)?.[1]);
    expect(entryCap).toBe(2500);
    expect(capFor({} as NodeJS.ProcessEnv)).toBeGreaterThanOrEqual(entryCap * 0.75);
  });

  it("is env-tunable upward but can never be set below the old floor", () => {
    expect(capFor({ FOUR_BRAIN_MAX_DIRECTION_RECORDS: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
    expect(capFor({ FOUR_BRAIN_MAX_DIRECTION_RECORDS: "100" } as NodeJS.ProcessEnv)).toBe(800);
    expect(capFor({ FOUR_BRAIN_MAX_DIRECTION_RECORDS: "nonsense" } as NodeJS.ProcessEnv)).toBe(2000);
  });

  /** Raising retention must not be mistaken for wiring the brains to execution. */
  it("does not connect the four-brain to execution — it only makes the gate observable", () => {
    expect(STORE_SRC).toContain("does NOT connect the brains to execution");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pureGeometryLaneIds } from "../src/lib/live-execution-engine.js";

/**
 * The lanes in this cohort are left to their OWN declared exit geometry — every engine overlay
 * skips them. It exists because an audit measured that POSITION_FLAT (a lane's own TP/stop firing)
 * produced only 116 of 800 live closes = 14.5%; the other 85.5% were overlays that appear in no
 * lane definition. Live maxFavorableR p50 was 0.0736R against lanes declaring 0.5R take-profits.
 *
 * Two of the four biggest overlays — REGIME_OPPOSITION_* (199 closes) and REGIME_CHANGE_HARVEST_*
 * (127) — had NO env key and NO per-lane scope before this change. That is the specific reason no
 * lane could ever be run as designed, and it is why the guard must be present at ALL FOUR sites:
 * three of four is not a cohort, it is a slower preemption.
 */
const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/live-execution-engine.ts");

describe("pureGeometryLaneIds — parsing", () => {
  it("is EMPTY by default, so an unset env is byte-for-byte today's behaviour", () => {
    expect(pureGeometryLaneIds({}).size).toBe(0);
    expect(pureGeometryLaneIds({ LIVE_PURE_GEOMETRY_LANE_IDS: "" }).size).toBe(0);
    expect(pureGeometryLaneIds({ LIVE_PURE_GEOMETRY_LANE_IDS: "   " }).size).toBe(0);
  });

  it("parses a comma list, trimming and dropping empties", () => {
    const ids = pureGeometryLaneIds({
      LIVE_PURE_GEOMETRY_LANE_IDS: " CG_WIDE_FAST_LONG , ,CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1 ,",
    });
    expect(ids.size).toBe(2);
    expect(ids.has("CG_WIDE_FAST_LONG")).toBe(true);
    expect(ids.has("CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1")).toBe(true);
    expect(ids.has("")).toBe(false);
  });

  it("does not read process.env when an explicit env is supplied (keeps tests hermetic)", () => {
    const before = process.env.LIVE_PURE_GEOMETRY_LANE_IDS;
    process.env.LIVE_PURE_GEOMETRY_LANE_IDS = "SHOULD_NOT_LEAK";
    try {
      expect(pureGeometryLaneIds({}).size).toBe(0);
    } finally {
      if (before === undefined) delete process.env.LIVE_PURE_GEOMETRY_LANE_IDS;
      else process.env.LIVE_PURE_GEOMETRY_LANE_IDS = before;
    }
  });
});

describe("every overlay actually consults the cohort (source-level guard)", () => {
  const src = readFileSync(ENGINE, "utf-8");

  /** Bound a search to one method's own body by brace-matching from its signature, so these stay
   *  exact as the file grows. A fixed-window scan silently went red elsewhere in this repo when an
   *  unrelated field was added to the same literal — see four-brain-journal-context.test.ts. */
  function methodBody(signature: string): string {
    const at = src.indexOf(signature);
    expect(at, `method not found: ${signature}`).toBeGreaterThanOrEqual(0);
    // The BODY brace, not the first brace. Three of these four methods return
    // `Promise<{ changed: boolean; closed: boolean }>`, so `indexOf("{")` lands inside the return
    // TYPE and brace-matching closes immediately on a body of "{ changed…; closed… }" — which
    // contains no guard and fails while the guard is present and correct. The body brace is the
    // one that opens a line, so anchor on `{\n`.
    const open = src.indexOf("{\n", at);
    expect(open, `could not find a body brace for ${signature}`).toBeGreaterThan(at);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    throw new Error(`could not brace-match ${signature}`);
  }

  /** FAILS WITHOUT THE FIX — before 2026-07-27 none of these four contained the guard, which is
   *  exactly why 85.5% of closes were overlay-produced. */
  it.each([
    ["private async maybeCloseTestnetRegimeHarvest(", "REGIME_OPPOSITION_* / REGIME_CHANGE_HARVEST_* (326/800 closes, previously unscopeable)"],
    ["private async maybeCloseOnTestnetUsdTakeProfit(", "PROFIT_BANK_NET_* (87 closes)"],
    ["private async maybeCutLosingMaxHold(", "LOSING_MAX_HOLD_CUT_* (172 closes)"],
    ["private async maybeCloseLiveBreakevenLaneAfterCost(", "breakeven-after-cost (40 closes)"],
  ])("%s skips cohort intents — %s", (signature) => {
    expect(methodBody(signature)).toContain("isPureGeometryIntent");
  });

  it("the predicate matches on the variant suffix as well as the full laneId", () => {
    const body = methodBody("private isPureGeometryIntent(");
    expect(body).toContain('laneId.split(":").pop()');
    expect(body).toContain("ids.has(laneId) || ids.has(variantId)");
  });

  it("short-circuits before touching intent sources when the cohort is empty", () => {
    // Guards a per-tick, per-intent hot path: with the feature off this must not walk sources.
    const body = methodBody("private isPureGeometryIntent(");
    const sizeCheck = body.indexOf("ids.size === 0");
    const sourcesCall = body.indexOf("this.intentSources(");
    expect(sizeCheck).toBeGreaterThanOrEqual(0);
    expect(sourcesCall).toBeGreaterThan(sizeCheck);
  });

  /** The cohort deliberately removes regime protection too. If someone later "fixes" that by
   *  exempting the hard cuts, the experiment silently stops being a pure-geometry test — so the
   *  intent is pinned in the comment and asserted here. */
  it("documents that a cohort lane keeps NO regime protection", () => {
    const body = methodBody("private async maybeCloseTestnetRegimeHarvest(");
    expect(body).toContain("NO regime protection at all");
  });
});

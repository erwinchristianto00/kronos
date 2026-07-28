import { describe, it, expect } from "vitest";
import { evaluateEntryActions, type PathCandle, type EntryParams } from "../src/lib/entry-exit-counterfactual.js";

/**
 * SKIP is 97% of every Entry Brain decision (14,000 of 14,498 on testnet) and was the ONE action
 * that could never be judged: its own realizedNetR is null by design (NOT_ENTERED — no position, so
 * no R), so "was the caution right?" had no number anywhere on the panel.
 *
 * The number existed the whole time. evaluateEntryActions has always attached `opportunityCostR:
 * now.netR` to the SKIP result — the netR an immediate entry would have earned on the same path —
 * and every consumer dropped it. These tests pin that it is produced, that it means what the sign
 * says, and that carrying it never turns SKIP into a fake realized trade.
 */
const bar = (o: number, h: number, l: number, c: number): PathCandle => ({ open: o, high: h, low: l, close: c });
const params = (dir: "LONG" | "SHORT"): EntryParams => ({
  direction: dir, riskDistance: 10, stopDistance: 10, targetR: 2,
  waitWindowBars: 4, pullbackFrac: 0.3, breakoutFrac: 0.3, confirmBars: 2,
  horizonBars: 6, costRoundTripR: 0,
});
const skipOf = (path: PathCandle[], dir: "LONG" | "SHORT" = "LONG") =>
  evaluateEntryActions(path, params(dir)).find((r) => r.action === "SKIP")!;

describe("SKIP carries the cost of the caution", () => {
  /** A market that ran away from a declined LONG: skipping cost real R. */
  it("is POSITIVE when declining cost money", () => {
    const up = [bar(100, 101, 99, 100), bar(100, 112, 100, 111), bar(111, 122, 110, 121), bar(121, 125, 120, 124)];
    const skip = skipOf(up);
    expect(skip.opportunityCostR).not.toBeNull();
    expect(skip.opportunityCostR!).toBeGreaterThan(0);
  });

  /** A market that fell away from a declined LONG: skipping saved money. */
  it("is NEGATIVE when declining saved money", () => {
    const down = [bar(100, 101, 99, 100), bar(100, 100, 88, 89), bar(89, 90, 80, 81), bar(81, 82, 75, 76)];
    expect(skipOf(down).opportunityCostR!).toBeLessThan(0);
  });

  it("mirrors correctly for SHORT", () => {
    const down = [bar(100, 101, 99, 100), bar(100, 100, 88, 89), bar(89, 90, 80, 81), bar(81, 82, 75, 76)];
    expect(skipOf(down, "SHORT").opportunityCostR!).toBeGreaterThan(0);
  });

  /** It must equal ENTER_NOW's own netR — it IS that counterfactual, not a second model. */
  it("equals what ENTER_NOW would have realized on the same path", () => {
    const up = [bar(100, 101, 99, 100), bar(100, 112, 100, 111), bar(111, 122, 110, 121), bar(121, 125, 120, 124)];
    const rs = evaluateEntryActions(up, params("LONG"));
    const now = rs.find((r) => r.action === "ENTER_NOW")!;
    expect(rs.find((r) => r.action === "SKIP")!.opportunityCostR).toBe(now.outcome.netR);
  });

  /** THE LINE THAT MUST NOT MOVE: an opportunity cost is not a realized trade. SKIP still has no
   *  position, so netR stays null and it can never be averaged into a realized mean. */
  it("never turns SKIP into a realized fill", () => {
    const up = [bar(100, 101, 99, 100), bar(100, 112, 100, 111), bar(111, 122, 110, 121), bar(121, 125, 120, 124)];
    const skip = skipOf(up);
    expect(skip.outcome.entered).toBe(false);
    expect(skip.outcome.netR).toBeNull();
    expect(skip.chaseCostR).toBeNull();
  });

  /** Only SKIP supplies it — otherwise the store's counter-gated mean would report a fake 0R. */
  it("is absent on every other action", () => {
    const up = [bar(100, 101, 99, 100), bar(100, 112, 100, 111), bar(111, 122, 110, 121), bar(121, 125, 120, 124)];
    for (const r of evaluateEntryActions(up, params("LONG"))) {
      if (r.action !== "SKIP") expect(r.opportunityCostR ?? null).toBeNull();
    }
  });
});

describe("the store aggregates it without faking anything", () => {
  it("reports null until a SKIP row supplies one, then the mean of those rows only", async () => {
    const { _resetDirectionEntryOutcomeStoreForTests, getDirectionEntryOutcomeStore } = await import(
      "../src/lib/direction-entry-outcome-store.js"
    );
    _resetDirectionEntryOutcomeStoreForTests?.();
    const store = getDirectionEntryOutcomeStore();
    const base = {
      tier: "TIER2_SIMULATED" as const, laneId: "L", symbolOrBasketId: "BTCUSDT", side: "LONG" as const,
      confidence: "EXPERIMENTAL_COST_OF_CAUTION" as const, status: "RESOLVED" as const,
      expectedNetR: null, realizedNetR: null, realizedRSource: null, horizonTruncated: false, matchedCloseKey: null,
    };
    for (let i = 0; i < 25; i += 1) {
      store.recordEntryOutcome({ ...base, decisionId: `skip-${i}`, action: "SKIP", asOfMs: 1_800_000_000_000 + i, opportunityCostR: i < 20 ? 0.5 : null }, { deferSave: true });
    }
    const skipRow = store.buildReport().entry.perAction.find((r) => r.action === "SKIP" && r.tier === "TIER2_SIMULATED" && r.confidence === "EXPERIMENTAL_COST_OF_CAUTION");
    expect(skipRow).toBeDefined();
    // netR stays null — SKIP never entered anything...
    expect(skipRow!.meanNetR).toBeNull();
    // ...while the opportunity cost averages ONLY the rows that supplied one (20 of 25), not all 25.
    expect(skipRow!.meanOpportunityCostR).toBe(0.5);
  });
});

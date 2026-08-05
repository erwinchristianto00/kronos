import { describe, it, expect } from "vitest";
import type { CrossSectionalObservation } from "../src/lib/cross-sectional-edge.js";
import type { ExecutorBasket } from "../src/lib/cross-sectional-executor.js";
import { narrativesFor, buildNarrativeTiltReport } from "../src/lib/narrative-tags.js";

const NOW = "2026-07-07T12:00:00.000Z";

function obs(id: string, longs: Array<[string, number, number | null]>, shorts: Array<[string, number, number | null]>, status: "OPEN" | "CLOSED" = "CLOSED"): CrossSectionalObservation {
  return {
    observationId: id,
    openedAt: NOW,
    openedAtMs: new Date(NOW).getTime(),
    horizonMs: 24 * 3_600_000,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    k: longs.length,
    longLeg: longs.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
    shortLeg: shorts.map(([symbol, entryPrice, exitPrice]) => ({ symbol, entryPrice, exitPrice })),
    status,
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: status === "CLOSED" ? NOW : null,
  };
}

function basket(id: string, legs: Array<{ symbol: string; side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number | null }>, status: "OPEN" | "CLOSED" | "ABORTED" = "CLOSED", accountingStatus?: "ACCOUNTING_INCOMPLETE"): ExecutorBasket {
  return {
    basketId: id,
    sourceObservationId: `src-${id}`,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    openedAt: NOW,
    closesAtMs: new Date(NOW).getTime() + 24 * 3_600_000,
    legs: legs.map((l) => ({
      symbol: l.symbol, side: l.side, qty: 1, entryPrice: l.entryPrice,
      entryOrderId: 1, entryPriceConfirmed: true,
      exitPrice: l.exitPrice, exitOrderId: l.exitPrice !== null ? 2 : null, exitPriceConfirmed: l.exitPrice !== null ? true : null,
    })),
    status,
    closedAt: status === "CLOSED" ? NOW : null,
    closeReason: status === "CLOSED" ? "HORIZON" : null,
    grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    accountingStatus,
  };
}

describe("narrative tags", () => {
  it("resolves the 1000x futures alias to the underlying symbol's tags", () => {
    expect(narrativesFor("1000PEPEUSDT")).toEqual(["MEME"]);
    expect(narrativesFor("PEPEUSDT")).toEqual(["MEME"]);
  });

  it("returns [] for unknown symbols — never guesses", () => {
    expect(narrativesFor("FOOUSDT")).toEqual([]);
  });

  it("computes direction-adjusted per-narrative edge from resolved legs (SHORT flipped)", () => {
    const report = buildNarrativeTiltReport({
      measuredObservations: [
        // FET (AI) long +10%; DOGE (MEME) short with price −5% ⇒ short leg adj +5%.
        obs("a", [["FETUSDT", 100, 110]], [["DOGEUSDT", 0.1, 0.095]]),
      ],
      executedBaskets: [],
      nowIso: NOW,
    });
    const ai = report.measured.edge.find((r) => r.narrative === "AI")!;
    expect(ai.long.meanAdjReturn).toBeCloseTo(0.1, 9);
    expect(ai.long.winRate).toBe(1);
    const meme = report.measured.edge.find((r) => r.narrative === "MEME")!;
    expect(meme.short.meanAdjReturn).toBeCloseTo(0.05, 9);
  });

  it("never fabricates a mean from an unresolved sample (null, not 0)", () => {
    const report = buildNarrativeTiltReport({
      measuredObservations: [obs("a", [["FETUSDT", 100, null]], [], "OPEN")],
      executedBaskets: [],
      nowIso: NOW,
    });
    const ai = report.measured.edge.find((r) => r.narrative === "AI")!;
    expect(ai.long.legs).toBe(1);
    expect(ai.long.resolvedLegs).toBe(0);
    expect(ai.long.meanAdjReturn).toBeNull();
    expect(ai.long.winRate).toBeNull();
  });

  it("tilt prefers EXECUTED baskets and flags the dominant long/short narratives", () => {
    const report = buildNarrativeTiltReport({
      measuredObservations: [obs("m", [["ADAUSDT", 1, null]], [["XRPUSDT", 1, null]], "OPEN")],
      executedBaskets: [
        basket("x1", [
          { symbol: "FETUSDT", side: "LONG", entryPrice: 100, exitPrice: null },
          { symbol: "WLDUSDT", side: "LONG", entryPrice: 2, exitPrice: null },
          { symbol: "DOGEUSDT", side: "SHORT", entryPrice: 0.1, exitPrice: null },
        ], "OPEN"),
      ],
      nowIso: NOW,
    });
    expect(report.tilt.windowBaskets).toBe(1);
    expect(report.tilt.dominantLong).toBe("AI"); // 2 AI longs vs 0 shorts
    expect(report.tilt.dominantShort).toBe("MEME");
    // The measured obs (ADA/XRP) must NOT leak into tilt when executed baskets exist.
    expect(report.tilt.rows.find((r) => r.narrative === "PAYMENTS")).toBeUndefined();
  });

  it("excludes ABORTED baskets and untagged symbols land in UNTAGGED, not a guessed narrative", () => {
    const report = buildNarrativeTiltReport({
      measuredObservations: [],
      executedBaskets: [
        basket("dead", [{ symbol: "FETUSDT", side: "LONG", entryPrice: 100, exitPrice: 90 }], "ABORTED"),
        basket("ok", [{ symbol: "FOOUSDT", side: "LONG", entryPrice: 10, exitPrice: 11 }]),
      ],
      nowIso: NOW,
    });
    expect(report.executed.baskets).toBe(1);
    const untagged = report.executed.edge.find((r) => r.narrative === "UNTAGGED")!;
    expect(untagged.long.meanAdjReturn).toBeCloseTo(0.1, 9);
    expect(report.executed.edge.find((r) => r.narrative === "AI")).toBeUndefined();
  });

  it("[2026-08-05 second-audit finding] excludes an ACCOUNTING_INCOMPLETE basket even when status is not ABORTED — defensive, in case that coupling is ever loosened", () => {
    const report = buildNarrativeTiltReport({
      measuredObservations: [],
      executedBaskets: [
        // status:"CLOSED" (NOT "ABORTED") deliberately, to prove this exclusion is not just a
        // side effect of the pre-existing status!=="ABORTED" filter — accountingStatus alone
        // must be sufficient to exclude a basket whose real close price is unknown.
        basket("flattened", [{ symbol: "FETUSDT", side: "LONG", entryPrice: 100, exitPrice: 90 }], "CLOSED", "ACCOUNTING_INCOMPLETE"),
        basket("ok", [{ symbol: "FOOUSDT", side: "LONG", entryPrice: 10, exitPrice: 11 }]),
      ],
      nowIso: NOW,
    });
    expect(report.executed.baskets).toBe(1);
    expect(report.executed.edge.find((r) => r.narrative === "AI")).toBeUndefined();
  });
});

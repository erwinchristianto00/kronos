import { describe, it, expect } from "vitest";
import { buildSymbolRotationSet, rotationAllows } from "../src/lib/per-symbol-rotation.js";
import type { PerSymbolLaneBookEdgeReport, PsleBestLane } from "../src/lib/per-symbol-lane-book-edge.js";

function best(
  symbol: string,
  direction: "LONG" | "SHORT",
  stage: PsleBestLane["stage"],
  netAvgR: number,
  laneId = "CG_WIDE_FAST_SHORT",
): PsleBestLane {
  return {
    symbol,
    direction,
    bucket: symbol === "BTCUSDT" || symbol === "ETHUSDT" ? "MAJOR" : "ALT",
    bestLaneId: stage === "NONE" ? null : laneId,
    bestNetAvgR: stage === "NONE" ? null : netAvgR,
    bestClosed: 100,
    stage,
    positiveLaneCount: stage === "NONE" ? 0 : 1,
    measuredLaneCount: 1,
  };
}

function report(bestLanePerSymbol: PsleBestLane[]): PerSymbolLaneBookEdgeReport {
  return {
    minClosed: 40, minHeadlineClosed: 20, posMinAvgR: 0.03, negMaxAvgR: -0.03,
    cells: [], bestLanePerSymbol,
    summary: {
      measuredCells: 0, bookPositiveCells: 0, promotableCells: 0, testnetCandidateCells: 0,
      byDirection: { LONG: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 }, SHORT: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 }, MIXED: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 } },
      symbolsMeasured: 0, symbolsTestnetCandidate: 0, symbolsPromotable: 0,
    },
  };
}

describe("per-symbol auto-rotation allow-set", () => {
  const r = report([
    best("LINKUSDT", "SHORT", "TESTNET_CANDIDATE", 0.198),
    best("BTCUSDT", "SHORT", "PROMOTABLE", 0.086),
    best("XRPUSDT", "SHORT", "NONE", 0),
  ]);

  it("TESTNET mode admits both testnet-candidate and promotable", () => {
    const set = buildSymbolRotationSet(r, { mode: "TESTNET" });
    expect(rotationAllows(set, "LINKUSDT", "SHORT")).toBe(true);
    expect(rotationAllows(set, "BTCUSDT", "SHORT")).toBe(true);
    expect(rotationAllows(set, "XRPUSDT", "SHORT")).toBe(false); // NONE
  });

  it("LIVE_CONFIRMED mode admits ONLY promotable (safe live default)", () => {
    const set = buildSymbolRotationSet(r, { mode: "LIVE_CONFIRMED" });
    expect(rotationAllows(set, "BTCUSDT", "SHORT")).toBe(true); // promotable
    expect(rotationAllows(set, "LINKUSDT", "SHORT")).toBe(false); // only testnet-candidate → blocked
  });

  it("LIVE_CREDIBLE mode admits testnet-candidate on live too (operator's aggressive choice)", () => {
    const set = buildSymbolRotationSet(r, { mode: "LIVE_CREDIBLE" });
    expect(rotationAllows(set, "LINKUSDT", "SHORT")).toBe(true);
    expect(rotationAllows(set, "BTCUSDT", "SHORT")).toBe(true);
  });

  it("routes each admitted pair to its best proven lane", () => {
    const set = buildSymbolRotationSet(
      report([best("SUIUSDT", "SHORT", "TESTNET_CANDIDATE", 0.09, "CG_EXP_SHORT_MFE_GIVEBACK_10X")]),
      { mode: "TESTNET" },
    );
    expect(set.laneBySymbolDirection.get("SUIUSDT:SHORT")).toBe("CG_EXP_SHORT_MFE_GIVEBACK_10X");
  });

  it("caps admissions to the top maxSymbols by netAvgR (can't flood past the position caps)", () => {
    const set = buildSymbolRotationSet(
      report([
        best("A_USDT", "SHORT", "TESTNET_CANDIDATE", 0.05),
        best("B_USDT", "SHORT", "TESTNET_CANDIDATE", 0.20),
        best("C_USDT", "SHORT", "TESTNET_CANDIDATE", 0.12),
      ]),
      { mode: "TESTNET", maxSymbols: 2 },
    );
    expect(set.entries.map((e) => e.symbol)).toEqual(["B_USDT", "C_USDT"]); // top 2 by R
    expect(rotationAllows(set, "A_USDT", "SHORT")).toBe(false);
  });

  it("AUTO-ROTATES: a symbol that decays out of the report leaves the set on the next recompute", () => {
    const before = buildSymbolRotationSet(
      report([best("SEIUSDT", "SHORT", "TESTNET_CANDIDATE", 0.08)]),
      { mode: "TESTNET" },
    );
    expect(rotationAllows(before, "SEIUSDT", "SHORT")).toBe(true);
    // book decayed → SEI is no longer a candidate in the fresh report
    const after = buildSymbolRotationSet(report([best("SEIUSDT", "SHORT", "NONE", 0)]), { mode: "TESTNET" });
    expect(rotationAllows(after, "SEIUSDT", "SHORT")).toBe(false);
  });
});

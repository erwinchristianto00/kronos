import { describe, it, expect } from "vitest";
import { applyBookEdgeToRotationShortlist } from "../src/lib/rotation-shortlist-book-overlay.js";
import type { RegimeRotationShortlistReport, RotationShortlistSymbol } from "../src/lib/regime-rotation-shortlist.js";
import type { PerSymbolLaneBookEdgeReport, PsleCell } from "../src/lib/per-symbol-lane-book-edge.js";

const LANE = "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT";

function simSymbol(symbol: string, verdict: RotationShortlistSymbol["verdict"]): RotationShortlistSymbol {
  return { symbol, n: 50, netAvgR: 0.1, pf: 2, wr: 0.7, score: 1, verdict, reason: "sim" };
}

function shortlist(bearish: RotationShortlistSymbol[]): RegimeRotationShortlistReport {
  return {
    generatedAt: "2099-01-01T00:00:00.000Z", minAllowSample: 10, minWatchSample: 5,
    lanes: [{ laneId: LANE, variantId: "CG_WIDE_FAST_SHORT" as never, label: "Fast Short", bearish, bullish: [] }],
    bearishGlobal: [], bullishGlobal: [],
  };
}

function cell(symbol: string, over: Partial<PsleCell>): PsleCell {
  return {
    laneId: LANE, symbol, direction: "SHORT", bucket: "ALT",
    closed: 60, headlineClosed: 0, netAvgR: 0.1, pf: 2, wr: 0.7, totalR: 6,
    headlineNetAvgR: null, headlinePf: null, executable: true, suspiciousFill: false,
    verdict: "BOOK_POSITIVE", confirmation: "DIAGNOSTIC_ONLY", promotable: false, testnetCandidate: true,
    ...over,
  };
}

function bookReport(cells: PsleCell[]): PerSymbolLaneBookEdgeReport {
  return {
    minClosed: 40, minHeadlineClosed: 20, posMinAvgR: 0.03, negMaxAvgR: -0.03, cells, bestLanePerSymbol: [],
    summary: { measuredCells: 0, bookPositiveCells: 0, promotableCells: 0, testnetCandidateCells: 0,
      byDirection: { LONG: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 }, SHORT: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 }, MIXED: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 } },
      symbolsMeasured: 0, symbolsTestnetCandidate: 0, symbolsPromotable: 0 },
  };
}

describe("rotation shortlist BOOK overlay (2b)", () => {
  it("VETOES a sim-ALLOW symbol whose realized book is negative (don't get stuck on a bad symbol)", () => {
    const out = applyBookEdgeToRotationShortlist(
      shortlist([simSymbol("DOGEUSDT", "ALLOW")]),
      bookReport([cell("DOGEUSDT", { verdict: "BOOK_NEGATIVE", netAvgR: -0.2, testnetCandidate: false })]),
      { mode: "LIVE_CREDIBLE" },
    );
    const doge = out.lanes[0]!.bearish.find((s) => s.symbol === "DOGEUSDT")!;
    expect(doge.verdict).toBe("BLOCK");
    expect(doge.reason).toMatch(/book-veto/);
  });

  it("VETOES on headline-negative even if the all-closed book looks positive", () => {
    const out = applyBookEdgeToRotationShortlist(
      shortlist([simSymbol("XRPUSDT", "ALLOW")]),
      bookReport([cell("XRPUSDT", { confirmation: "HEADLINE_NEGATIVE", testnetCandidate: false })]),
      { mode: "LIVE_CREDIBLE" },
    );
    expect(out.lanes[0]!.bearish[0]!.verdict).toBe("BLOCK");
  });

  it("INJECTS a book-proven symbol the sim shortlist never listed (auto-rotate IN)", () => {
    const out = applyBookEdgeToRotationShortlist(
      shortlist([]), // sim listed nobody
      bookReport([cell("LINKUSDT", { testnetCandidate: true, netAvgR: 0.198 })]),
      { mode: "LIVE_CREDIBLE" },
    );
    const link = out.lanes[0]!.bearish.find((s) => s.symbol === "LINKUSDT");
    expect(link?.verdict).toBe("ALLOW");
    expect(link?.reason).toMatch(/book-proven injected/);
  });

  it("LIVE_CONFIRMED admits only headline-confirmed (promotable) cells, not diagnostic-only", () => {
    const diagOnly = bookReport([cell("LINKUSDT", { testnetCandidate: true, promotable: false, confirmation: "DIAGNOSTIC_ONLY" })]);
    const out = applyBookEdgeToRotationShortlist(shortlist([]), diagOnly, { mode: "LIVE_CONFIRMED" });
    expect(out.lanes[0]!.bearish.find((s) => s.symbol === "LINKUSDT")).toBeUndefined(); // not injected

    const confirmed = bookReport([cell("LINKUSDT", { testnetCandidate: true, promotable: true, confirmation: "HEADLINE_CONFIRMED" })]);
    const out2 = applyBookEdgeToRotationShortlist(shortlist([]), confirmed, { mode: "LIVE_CONFIRMED" });
    expect(out2.lanes[0]!.bearish.find((s) => s.symbol === "LINKUSDT")?.verdict).toBe("ALLOW");
  });

  it("leaves a symbol at its sim verdict when there is no adequate book judgment", () => {
    const out = applyBookEdgeToRotationShortlist(
      shortlist([simSymbol("SEIUSDT", "WATCH")]),
      bookReport([cell("SEIUSDT", { verdict: "INSUFFICIENT", testnetCandidate: false })]),
      { mode: "LIVE_CREDIBLE" },
    );
    expect(out.lanes[0]!.bearish[0]!.verdict).toBe("WATCH"); // unchanged
  });

  it("does not inject a non-executable (MAKER) or suspicious cell even if book-positive", () => {
    const out = applyBookEdgeToRotationShortlist(
      shortlist([]),
      bookReport([cell("WLDUSDT", { executable: false, testnetCandidate: false, verdict: "BOOK_POSITIVE" })]),
      { mode: "LIVE_CREDIBLE" },
    );
    expect(out.lanes[0]!.bearish.find((s) => s.symbol === "WLDUSDT")).toBeUndefined();
  });
});

// 2026-07-08: live opened ZERO trades under FAST_SHORT 100% because its LOCAL VM book is empty →
// shortlist structurally empty → every candidate vetoed. app.ts now falls back to the /research
// curation whitelist when the family has NO symbols at all — this helper is that emptiness test.
describe("rotationShortlistFamilyHasSymbols (empty-by-no-data detection)", () => {
  const empty = {
    generatedAt: "2026-07-08T00:00:00.000Z", minAllowSample: 5, minWatchSample: 3,
    lanes: [{ laneId: "L", variantId: "CG_WIDE_FAST_SHORT", label: "l", bearish: [], bullish: [] }],
    bearishGlobal: [], bullishGlobal: [],
  };
  it("empty family ⇒ false; any lane or global entry ⇒ true", async () => {
    const { rotationShortlistFamilyHasSymbols } = await import("../src/lib/regime-rotation-shortlist.js");
    expect(rotationShortlistFamilyHasSymbols(empty as never, "BEARISH")).toBe(false);
    expect(rotationShortlistFamilyHasSymbols(empty as never, "BULLISH")).toBe(false);
    const withLane = { ...empty, lanes: [{ ...empty.lanes[0]!, bearish: [{ symbol: "BTCUSDT" }] }] };
    expect(rotationShortlistFamilyHasSymbols(withLane as never, "BEARISH")).toBe(true);
    const withGlobal = { ...empty, bullishGlobal: [{ symbol: "ETHUSDT" }] };
    expect(rotationShortlistFamilyHasSymbols(withGlobal as never, "BULLISH")).toBe(true);
  });
});

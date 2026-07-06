import { describe, it, expect } from "vitest";
import {
  buildPerSymbolLaneBookEdge,
  getCuratedSymbolsForLane,
  type PsleOrder,
} from "../src/lib/per-symbol-lane-book-edge.js";

/** Uniform closed orders (all the same netR → all win or all loss). Used for edge/suspicious cases. */
function orders(
  laneId: string,
  symbol: string,
  netR: number,
  n: number,
  opts: { direction?: "LONG" | "SHORT"; headline?: boolean } = {},
): PsleOrder[] {
  return Array.from({ length: n }, () => ({
    symbol,
    selectedLaneId: laneId,
    direction: opts.direction ?? "SHORT",
    paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
    netR,
    ...(opts.headline ? {} : { paperOrderMode: "DIAGNOSTIC_ONLY" }),
  }));
}

/** Realistic win/loss mix (wr<0.98, pf<10 → book-positive WITHOUT tripping the suspicious-fill flag). */
function wl(
  laneId: string,
  symbol: string,
  nWin: number,
  w: number,
  nLoss: number,
  l: number,
  opts: { direction?: "LONG" | "SHORT"; headline?: boolean } = {},
): PsleOrder[] {
  return [...orders(laneId, symbol, w, nWin, opts), ...orders(laneId, symbol, -l, nLoss, opts)];
}

describe("per-symbol × lane BOOK edge", () => {
  it("diagnostic-only book-positive edge is a TESTNET_CANDIDATE, not promotable (headline unconfirmed)", () => {
    const r = buildPerSymbolLaneBookEdge(wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 40, 0.2, 15, 0.15)); // all diagnostic
    const c = r.cells.find((x) => x.symbol === "LINKUSDT")!;
    expect(c.verdict).toBe("BOOK_POSITIVE");
    expect(c.suspiciousFill).toBe(false);
    expect(c.confirmation).toBe("DIAGNOSTIC_ONLY");
    expect(c.testnetCandidate).toBe(true);
    expect(c.promotable).toBe(false);
    expect(r.summary.testnetCandidateCells).toBe(1);
    expect(r.summary.promotableCells).toBe(0);
  });

  it("headline-confirmed book-positive edge IS promotable", () => {
    const r = buildPerSymbolLaneBookEdge([
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15, { headline: true }),
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15), // + diagnostic
    ]);
    const c = r.cells.find((x) => x.symbol === "LINKUSDT")!;
    expect(c.headlineClosed).toBe(40);
    expect(c.confirmation).toBe("HEADLINE_CONFIRMED");
    expect(c.promotable).toBe(true);
    expect(r.summary.symbolsPromotable).toBe(1);
  });

  it("headline that CONTRADICTS a positive all-closed read blocks the testnet candidate", () => {
    const r = buildPerSymbolLaneBookEdge([
      ...wl("CG_WIDE_FAST_SHORT", "DOGEUSDT", 45, 0.2, 15, 0.1), // diagnostic looks great
      ...orders("CG_WIDE_FAST_SHORT", "DOGEUSDT", -0.2, 25, { headline: true }), // but real headline loses
    ]);
    const c = r.cells.find((x) => x.symbol === "DOGEUSDT")!;
    expect(c.confirmation).toBe("HEADLINE_NEGATIVE");
    expect(c.testnetCandidate).toBe(false);
    expect(c.promotable).toBe(false);
  });

  it("MAKER lanes are non-executable and can never be testnet candidates", () => {
    const r = buildPerSymbolLaneBookEdge(wl("CG_MAKER_LIMIT_SIM", "WLDUSDT", 40, 0.2, 15, 0.1));
    const c = r.cells.find((x) => x.symbol === "WLDUSDT")!;
    expect(c.executable).toBe(false);
    expect(c.testnetCandidate).toBe(false);
    expect(c.verdict).toBe("BOOK_POSITIVE"); // book positive, but not tradeable
  });

  it("flags too-good-to-be-true PF/WR as fill-model artifacts (not tradeable)", () => {
    const r = buildPerSymbolLaneBookEdge(orders("CG_NO_FIB500_ENTRYSET", "WLDUSDT", 0.07, 146)); // all wins → wr 100%, pf ∞
    const c = r.cells.find((x) => x.symbol === "WLDUSDT")!;
    expect(c.suspiciousFill).toBe(true);
    expect(c.testnetCandidate).toBe(false);
  });

  it("covers LONG, SHORT and MIXED directions and breaks them out in the summary", () => {
    const r = buildPerSymbolLaneBookEdge([
      ...wl("CG_WIDE_FAST_LONG", "ETHUSDT", 40, 0.2, 15, 0.15, { direction: "LONG" }),
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 40, 0.2, 15, 0.15, { direction: "SHORT" }),
    ]);
    expect(r.summary.byDirection.LONG.testnetCandidate).toBe(1);
    expect(r.summary.byDirection.SHORT.testnetCandidate).toBe(1);
    expect(r.cells.find((c) => c.symbol === "ETHUSDT")!.direction).toBe("LONG");
  });

  it("routes each symbol to its best tradeable lane (promotable > testnet-candidate > none)", () => {
    const r = buildPerSymbolLaneBookEdge([
      ...wl("CG_WIDE_FAST_SHORT", "NEARUSDT", 40, 0.1, 15, 0.1), // diagnostic-credible, modest
      ...wl("CG_BASELINE_CURRENT", "NEARUSDT", 30, 0.25, 10, 0.15, { headline: true }), // headline-confirmed, better
      ...wl("CG_BASELINE_CURRENT", "NEARUSDT", 30, 0.25, 10, 0.15),
    ]);
    const near = r.bestLanePerSymbol.find((s) => s.symbol === "NEARUSDT")!;
    expect(near.stage).toBe("PROMOTABLE");
    expect(near.bestLaneId).toBe("CG_BASELINE_CURRENT");
  });

  it("marks a positive-but-thin cell INSUFFICIENT below minClosed", () => {
    const r = buildPerSymbolLaneBookEdge(wl("LANE_C", "NEARUSDT", 15, 0.3, 5, 0.1)); // n=20 < 40
    expect(r.cells.find((x) => x.symbol === "NEARUSDT")!.verdict).toBe("INSUFFICIENT");
  });

  it("ignores OPEN / non-closed orders (book = realized only)", () => {
    const os: PsleOrder[] = [
      ...wl("CG_WIDE_FAST_SHORT", "SEIUSDT", 35, 0.1, 10, 0.1),
      { symbol: "SEIUSDT", selectedLaneId: "CG_WIDE_FAST_SHORT", direction: "SHORT", paperStatus: "PAPER_SUBMITTED", netR: 5 },
    ];
    expect(buildPerSymbolLaneBookEdge(os).cells.find((x) => x.symbol === "SEIUSDT")!.closed).toBe(45);
  });

  it("tags BTC/ETH as MAJOR and the rest as the correlated ALT basket", () => {
    const r = buildPerSymbolLaneBookEdge([
      ...wl("CG_WIDE_FAST_SHORT", "BTCUSDT", 35, 0.1, 10, 0.1),
      ...wl("CG_WIDE_FAST_SHORT", "SUIUSDT", 35, 0.1, 10, 0.1),
    ]);
    expect(r.cells.find((c) => c.symbol === "BTCUSDT")!.bucket).toBe("MAJOR");
    expect(r.cells.find((c) => c.symbol === "SUIUSDT")!.bucket).toBe("ALT");
  });
});

describe("getCuratedSymbolsForLane", () => {
  const NOW = new Date("2026-07-06T12:00:00.000Z").getTime();
  const FRESH_AT = new Date(NOW - 30 * 60_000).toISOString(); // 30min old
  const STALE_AT = new Date(NOW - 3 * 60 * 60_000).toISOString(); // 3h old
  const MAX_STALENESS_MS = 2 * 60 * 60 * 1000; // 2h

  function reportFor(orders: PsleOrder[]) {
    return buildPerSymbolLaneBookEdge(orders);
  }

  it("returns null (STALE_OR_MISSING) when the report is missing", () => {
    const d = getCuratedSymbolsForLane(null, null, "CG_WIDE_FAST_SHORT", "testnet", MAX_STALENESS_MS, NOW);
    expect(d.curated).toBeNull();
    expect(d.reason).toBe("STALE_OR_MISSING");
  });

  it("returns null (STALE_OR_MISSING) when the cached report is older than maxStalenessMs", () => {
    const r = reportFor(wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15));
    const d = getCuratedSymbolsForLane(r, STALE_AT, "CG_WIDE_FAST_SHORT", "testnet", MAX_STALENESS_MS, NOW);
    expect(d.curated).toBeNull();
    expect(d.reason).toBe("STALE_OR_MISSING");
  });

  it("returns null (NO_DATA_FOR_LANE) when the lane has zero measured cells", () => {
    const r = reportFor(wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15));
    const d = getCuratedSymbolsForLane(r, FRESH_AT, "CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER", "testnet", MAX_STALENESS_MS, NOW);
    expect(d.curated).toBeNull();
    expect(d.reason).toBe("NO_DATA_FOR_LANE");
  });

  it("testnet tier admits testnetCandidate (diagnostic-proven) symbols even without headline confirmation", () => {
    const r = reportFor([
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15), // diagnostic book-positive
      ...wl("CG_WIDE_FAST_SHORT", "SUIUSDT", 10, 0.1, 30, 0.2), // book-negative
    ]);
    const d = getCuratedSymbolsForLane(r, FRESH_AT, "CG_WIDE_FAST_SHORT", "testnet", MAX_STALENESS_MS, NOW);
    expect(d.reason).toBe("OK");
    expect(d.curated).toEqual(["LINKUSDT"]);
  });

  it("live tier requires headline confirmation — a diagnostic-only positive is NOT enough", () => {
    const r = reportFor(wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15)); // all diagnostic
    const d = getCuratedSymbolsForLane(r, FRESH_AT, "CG_WIDE_FAST_SHORT", "live", MAX_STALENESS_MS, NOW);
    expect(d.reason).toBe("OK");
    expect(d.curated).toEqual([]); // lane HAS data, but nothing qualifies for live yet
  });

  it("live tier admits a symbol once headline-confirmed", () => {
    const r = reportFor([
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15, { headline: true }),
      ...wl("CG_WIDE_FAST_SHORT", "LINKUSDT", 30, 0.2, 10, 0.15),
    ]);
    const d = getCuratedSymbolsForLane(r, FRESH_AT, "CG_WIDE_FAST_SHORT", "live", MAX_STALENESS_MS, NOW);
    expect(d.curated).toEqual(["LINKUSDT"]);
  });
});

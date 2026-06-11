import { describe, expect, it } from "vitest";

import type { StrategyExperienceRecord } from "@dtc/shared";

import {
  evaluateLaneToxicSymbols,
  type LaneToxicSymbolLane,
  type LaneToxicSymbolCrossIntelligenceContext,
} from "../src/lib/lane-toxic-symbol-evaluator.js";

let counter = 0;

function record(opts: {
  symbol: string;
  regime: string;
  direction: "LONG" | "SHORT";
  entry?: string;
  exit?: string;
  slHit: boolean;
  netR?: number;
  grossR?: number;
}): StrategyExperienceRecord {
  const netR = opts.netR ?? (opts.slHit ? -1 : 1);
  return {
    context: {
      schemaVersion: 1,
      symbol: opts.symbol,
      direction: opts.direction,
      scanTimestamp: null,
      evidenceEra: "POST_CALIBRATION",
      marketRegime: opts.regime,
      selectedEntryVariant: opts.entry ?? "vwap_retest_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
    } as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${++counter}`,
      symbol: opts.symbol,
      direction: opts.direction,
      evidenceEra: "POST_CALIBRATION",
      selectedEntryVariant: opts.entry ?? "vwap_retest_entry",
      selectedExitVariant: opts.exit ?? "tp1_full_exit",
      realizedNetR: netR,
      realizedGrossR: opts.grossR ?? (opts.slHit ? -0.95 : 1.05),
      winnerLabel: netR > 0 ? "WIN" : "LOSS",
      tp1Hit: !opts.slHit,
      slHit: opts.slHit,
      closeReason: opts.slHit ? "SL" : "TP1",
    } as StrategyExperienceRecord["outcome"],
  };
}

function sl(symbol: string): StrategyExperienceRecord {
  return record({ symbol, regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true });
}

function win(symbol: string): StrategyExperienceRecord {
  return record({ symbol, regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false });
}

const DEFAULT_LANE: LaneToxicSymbolLane = {
  regime: "BEARISH_EXPANSION",
  direction: "SHORT",
  entryVariant: "vwap_retest_entry",
  exitVariant: "tp1_full_exit",
};

const WITH_ROTATION_PRESSURE = (symbol: string): LaneToxicSymbolCrossIntelligenceContext => ({
  universeRotationPressureSymbols: new Set([symbol]),
  symbolSensitiveLaneSignal: false,
});

const WITH_SYMBOL_SENSITIVE: LaneToxicSymbolCrossIntelligenceContext = {
  universeRotationPressureSymbols: new Set(),
  symbolSensitiveLaneSignal: true,
};

const NO_CROSS_INTEL: LaneToxicSymbolCrossIntelligenceContext = {
  universeRotationPressureSymbols: new Set(),
  symbolSensitiveLaneSignal: false,
};

// ─── Case a: Tier-1 requires n≥3 AND slRate===1.0 AND ≥1 cross-intelligence support ───

describe("Tier-1 rule: n>=3, slRate===1.0, cross-intel required", () => {
  it("does NOT promote to tier-1 without cross-intelligence support even with n=4 all-SL", () => {
    const records = [sl("XYZUSDT"), sl("XYZUSDT"), sl("XYZUSDT"), sl("XYZUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).toHaveLength(0);
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "XYZUSDT")!;
    expect(diag.tier).toBe("NORMAL");
  });

  it("does NOT promote to tier-1 if n<3 even with cross-intelligence support and slRate=1.0", () => {
    const records = [sl("XYZUSDT"), sl("XYZUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("XYZUSDT"));
    expect(result.tier1ToxicSymbols).toHaveLength(0);
    // n=2 slRate=1.0 → tier-2
    expect(result.tier2ToxicWatchlistSymbols).toContain("XYZUSDT");
  });

  it("does NOT promote to tier-1 if slRate < 1.0 even with n>=3 and cross-intel", () => {
    const records = [sl("XYZUSDT"), sl("XYZUSDT"), win("XYZUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("XYZUSDT"));
    expect(result.tier1ToxicSymbols).toHaveLength(0);
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "XYZUSDT")!;
    expect(diag.tier).toBe("NORMAL");
  });
});

// ─── Case b: BNB-like fixture (n=4, all SL, universe-rotation-pressure support) → tier-1 ───

describe("BNB-like fixture qualifies tier-1", () => {
  it("symbol with n=4, slRate=1.0, UNIVERSE_ROTATION_PRESSURE → tier-1", () => {
    const records = [sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("BNBUSDT"));
    expect(result.tier1ToxicSymbols).toContain("BNBUSDT");
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "BNBUSDT")!;
    expect(diag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
    expect(diag.crossIntelligenceSupports).toContain("UNIVERSE_ROTATION_PRESSURE");
    expect(diag.n).toBe(4);
    expect(diag.slRate).toBe(1);
  });

  it("symbol with n=4, slRate=1.0, SYMBOL_SENSITIVE_ROUTE → tier-1", () => {
    const records = [sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_SYMBOL_SENSITIVE);
    expect(result.tier1ToxicSymbols).toContain("BNBUSDT");
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "BNBUSDT")!;
    expect(diag.crossIntelligenceSupports).toContain("SYMBOL_SENSITIVE_ROUTE");
  });

  it("symbol with n=3, slRate=1.0 + rotation pressure → tier-1", () => {
    const records = [sl("TOKENUSDT"), sl("TOKENUSDT"), sl("TOKENUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("TOKENUSDT"));
    expect(result.tier1ToxicSymbols).toContain("TOKENUSDT");
  });
});

// ─── Case c: DOGE-like fixture (n=2, all SL) → tier-2 only ───

describe("DOGE-like fixture qualifies tier-2 only", () => {
  it("symbol with n=2, slRate=1.0, no cross-intel → tier-2 (not tier-1)", () => {
    const records = [sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).toHaveLength(0);
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "DOGEUSDT")!;
    expect(diag.tier).toBe("TIER_2_WATCHLIST");
  });

  it("n=2, slRate=1.0 WITH cross-intel → still tier-2 (n<3 bars tier-1)", () => {
    const records = [sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("DOGEUSDT"));
    expect(result.tier1ToxicSymbols).toHaveLength(0);
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("LINKUSDT n=2 all SL → tier-2", () => {
    const records = [sl("LINKUSDT"), sl("LINKUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier2ToxicWatchlistSymbols).toContain("LINKUSDT");
  });
});

// ─── Mixed lane with multiple symbols ───

describe("Mixed lane: BNB tier-1, DOGE tier-2, others normal", () => {
  it("correctly classifies all symbols in a realistic lane", () => {
    const records = [
      // BNB: n=4, all SL
      sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"),
      // DOGE: n=2, all SL
      sl("DOGEUSDT"), sl("DOGEUSDT"),
      // NEARUSDT: n=5, 3 SL
      sl("NEARUSDT"), sl("NEARUSDT"), sl("NEARUSDT"), win("NEARUSDT"), win("NEARUSDT"),
      // BTC: n=10, 3 SL
      sl("BTCUSDT"), sl("BTCUSDT"), sl("BTCUSDT"), win("BTCUSDT"), win("BTCUSDT"),
      win("BTCUSDT"), win("BTCUSDT"), win("BTCUSDT"), win("BTCUSDT"), win("BTCUSDT"),
    ];
    const ctx: LaneToxicSymbolCrossIntelligenceContext = {
      universeRotationPressureSymbols: new Set(["BNBUSDT"]),
      symbolSensitiveLaneSignal: true,
    };
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, ctx);
    expect(result.tier1ToxicSymbols).toContain("BNBUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier1ToxicSymbols).not.toContain("NEARUSDT");
    expect(result.tier1ToxicSymbols).not.toContain("BTCUSDT");
    const bnbDiag = result.perSymbolDiagnostics.find((d) => d.symbol === "BNBUSDT")!;
    expect(bnbDiag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
    const btcDiag = result.perSymbolDiagnostics.find((d) => d.symbol === "BTCUSDT")!;
    expect(btcDiag.tier).toBe("NORMAL");
  });
});

// ─── Lane filtering: records outside the lane tuple must be excluded ───

describe("Lane filtering: only lane-matching records counted", () => {
  it("does NOT count records from different regime, direction, entry, or exit", () => {
    const inLane = [sl("ABCUSDT"), sl("ABCUSDT"), sl("ABCUSDT")];
    // These should NOT be counted: different regime, direction, entry, exit
    const outOfLane = [
      record({ symbol: "ABCUSDT", regime: "BULLISH_EXPANSION", direction: "SHORT", slHit: false }),
      record({ symbol: "ABCUSDT", regime: "BEARISH_EXPANSION", direction: "LONG", slHit: false }),
      record({ symbol: "ABCUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", entry: "limit_entry", slHit: false }),
    ];
    const result = evaluateLaneToxicSymbols([...inLane, ...outOfLane], DEFAULT_LANE, WITH_ROTATION_PRESSURE("ABCUSDT"));
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "ABCUSDT")!;
    // Only 3 in-lane records counted, n=3, slRate=1.0 → tier-1
    expect(diag.n).toBe(3);
    expect(diag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
  });
});

// ─── No hardcoded tickers ───

describe("Pure function — no hardcoded tickers", () => {
  it("works for any arbitrary ticker", () => {
    const ticker = "RANDOMCOIN999USDT";
    const records = [sl(ticker), sl(ticker), sl(ticker)];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE(ticker));
    expect(result.tier1ToxicSymbols).toContain(ticker);
  });
});

// ─── Load-bearing contaminant promotion: Tier-1 via LOAD_BEARING_CONTAMINANT_V1 ───
// Fixture: 30 background records (18 wins @ netR=+0.1, 12 losses @ netR=-0.1 → bgNetSum=0.6)
// + 2 SL records for contaminating symbol (netR=-1.0, grossR=-0.95 → symbolNetSum=-2.0)
// → laneN=32, laneConsNetAvgR=-1.4/32≈-0.0438, excludingSymbol=0.6/30=+0.02, delta≈+0.064

describe("Load-bearing contaminant promotion (LOAD_BEARING_CONTAMINANT_V1)", () => {
  function makeBg30(): StrategyExperienceRecord[] {
    return [
      ...Array.from({ length: 18 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false, netR: 0.1, grossR: 0.2 }),
      ),
      ...Array.from({ length: 12 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true, netR: -0.1, grossR: -0.15 }),
      ),
    ];
  }

  it("promotes n=2 slRate=1.0 symbol when all guards pass (DOGE-like fixture)", () => {
    const records = [...makeBg30(), sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).not.toContain("DOGEUSDT");
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "DOGEUSDT")!;
    expect(diag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
    expect(diag.promotionBranch).toBe("LOAD_BEARING_CONTAMINANT_V1");
  });

  it("promotion works for any arbitrary ticker (no hardcoded symbols)", () => {
    const ticker = "ANYCOIN999USDT";
    const records = [...makeBg30(), sl(ticker), sl(ticker)];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).toContain(ticker);
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === ticker)!;
    expect(diag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
    expect(diag.promotionBranch).toBe("LOAD_BEARING_CONTAMINANT_V1");
  });

  it("does NOT promote if grossAvgR > -0.95 (gross damage guard)", () => {
    // grossR=-0.90 is above the -0.95 threshold
    const contaminant = () =>
      record({ symbol: "DOGEUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true, netR: -1.0, grossR: -0.90 });
    const records = [...makeBg30(), contaminant(), contaminant()];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("does NOT promote if |netSumConservative| < 1.5 (damage magnitude guard)", () => {
    // netR=-0.6 each → netSumCons=-1.2 < 1.5
    const contaminant = () =>
      record({ symbol: "DOGEUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true, netR: -0.6, grossR: -0.97 });
    const records = [...makeBg30(), contaminant(), contaminant()];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("does NOT promote if laneN < 30 (sample size guard)", () => {
    // Only 10 background + 2 symbol = laneN=12
    const bg10 = Array.from({ length: 10 }, () =>
      record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false, netR: 0.1, grossR: 0.2 }),
    );
    const records = [...bg10, sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("does NOT promote if excluding symbol does not flip lane to positive (sign-flip guard)", () => {
    // Background net-negative: 12 wins @ +0.1, 18 losses @ -0.1 → bgNetSum=-0.6
    // Excluding DOGE: -0.6/30 = -0.02 < 0, no flip
    const negBg = [
      ...Array.from({ length: 12 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false, netR: 0.1, grossR: 0.2 }),
      ),
      ...Array.from({ length: 18 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true, netR: -0.1, grossR: -0.15 }),
      ),
    ];
    const records = [...negBg, sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("does NOT promote if deltaConsNetAvgR < 0.05 even when sign flips (delta guard)", () => {
    // 60-record bg (33 wins + 27 losses @ ±0.1 → bgNetSum=0.6) + 2 DOGE SL
    // laneN=62, laneConsNetAvgR=-1.4/62≈-0.023, excludingDOGE=0.6/60=+0.01, delta≈+0.033 < 0.05
    const bg60 = [
      ...Array.from({ length: 33 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false, netR: 0.1, grossR: 0.2 }),
      ),
      ...Array.from({ length: 27 }, () =>
        record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: true, netR: -0.1, grossR: -0.15 }),
      ),
    ];
    const records = [...bg60, sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    expect(result.tier1ToxicSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).toContain("DOGEUSDT");
  });

  it("promotes DOGE and LINK in the same lane; BNB via cross-intel path; BGUSDT normal", () => {
    // Two-pass semantics: BNB excluded from cleaned lane first (cross-intel Tier-1, n=4).
    // Cleaned lane = 30 bg @ +0.1 (bgNetSum=3.0) + DOGE(-2.0) + LINK(-2.0) = -1.0 total,
    // cleanedLaneN=34, cleanedLaneConsNetAvgR=-1.0/34≈-0.029 < 0.
    // Excluding DOGE from cleaned: (3.0-2.0)/32=+0.031 > 0, delta≈+0.060 >= 0.05.
    // Excluding LINK from cleaned: same by symmetry.
    const bg30 = Array.from({ length: 30 }, () =>
      record({ symbol: "BGUSDT", regime: "BEARISH_EXPANSION", direction: "SHORT", slHit: false, netR: 0.1, grossR: 0.2 }),
    );
    const allRecords = [
      ...bg30,
      sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"),
      sl("DOGEUSDT"), sl("DOGEUSDT"),
      sl("LINKUSDT"), sl("LINKUSDT"),
    ];
    const ctx: LaneToxicSymbolCrossIntelligenceContext = {
      universeRotationPressureSymbols: new Set(["BNBUSDT"]),
      symbolSensitiveLaneSignal: false,
    };
    const result = evaluateLaneToxicSymbols(allRecords, DEFAULT_LANE, ctx);
    // DOGE and LINK promoted via load-bearing path against cleaned lane
    expect(result.tier1ToxicSymbols).toContain("DOGEUSDT");
    expect(result.tier1ToxicSymbols).toContain("LINKUSDT");
    expect(result.tier1ToxicSymbols).toContain("BNBUSDT");
    expect(result.tier2ToxicWatchlistSymbols).not.toContain("DOGEUSDT");
    expect(result.tier2ToxicWatchlistSymbols).not.toContain("LINKUSDT");
    // BNB via cross-intel path, not load-bearing
    const bnbDiag = result.perSymbolDiagnostics.find((d) => d.symbol === "BNBUSDT")!;
    expect(bnbDiag.promotionBranch).toBeUndefined();
    // BGUSDT is normal
    const bgDiag = result.perSymbolDiagnostics.find((d) => d.symbol === "BGUSDT")!;
    expect(bgDiag.tier).toBe("NORMAL");
  });

  it("original cross-intel Tier-1 path does not set promotionBranch", () => {
    const records = [sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT"), sl("BNBUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, WITH_ROTATION_PRESSURE("BNBUSDT"));
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "BNBUSDT")!;
    expect(diag.tier).toBe("TIER_1_OPERATIVE_SUPPRESSED");
    expect(diag.promotionBranch).toBeUndefined();
  });

  it("diagnostic fields are populated correctly on a promoted symbol", () => {
    const records = [...makeBg30(), sl("DOGEUSDT"), sl("DOGEUSDT")];
    const result = evaluateLaneToxicSymbols(records, DEFAULT_LANE, NO_CROSS_INTEL);
    const diag = result.perSymbolDiagnostics.find((d) => d.symbol === "DOGEUSDT")!;
    expect(diag.laneN).toBe(32); // 30 bg + 2 DOGE
    expect(diag.netSumConservative).toBeCloseTo(-2.0, 4);
    expect(diag.laneConsNetAvgR).not.toBeNull();
    expect(diag.laneConsNetAvgR!).toBeLessThan(0);
    expect(diag.laneConsNetAvgRExcludingSymbol).not.toBeNull();
    expect(diag.laneConsNetAvgRExcludingSymbol!).toBeGreaterThan(0);
    expect(diag.deltaConsNetAvgR).not.toBeNull();
    expect(diag.deltaConsNetAvgR!).toBeGreaterThanOrEqual(0.05);
    expect(diag.promotionBranch).toBe("LOAD_BEARING_CONTAMINANT_V1");
  });
});

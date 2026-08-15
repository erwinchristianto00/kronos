import { describe, it, expect } from "vitest";
import {
  evaluateSymbolEligibility, oneLotNotionalUsd, diffPool, DEFAULT_ELIGIBILITY,
  type SymbolEligibilityInput,
} from "../src/lib/symbol-eligibility.js";

const NOW = Date.parse("2026-08-16T00:00:00Z");
const OK = (o: Partial<SymbolEligibilityInput> = {}): SymbolEligibilityInput => ({
  symbol: "TESTUSDT",
  quoteVolume24hUsd: 24 * 1_000_000,        // $1M/jam
  price: 10,
  minNotionalUsd: 5,
  stepSize: 0.1,
  minQty: 0.1,
  listedAtMs: NOW - 300 * 86_400_000,
  medianAbsFundingRatePerPeriod: 0.00005,   // 3 bps / 6 periode
  maxCorrelationToAccepted: 0.5,
  ...o,
});
const codes = (i: SymbolEligibilityInput) => evaluateSymbolEligibility(i, NOW).failures.map(f => f.code);

describe("acuan", () => {
  it("simbol yang sehat LOLOS", () => {
    const v = evaluateSymbolEligibility(OK(), NOW);
    expect(v.eligible).toBe(true);
    expect(v.failures).toEqual([]);
  });
});

describe("[JAMINAN] tidak ada masukan kinerja", () => {
  it("bentuk input tidak punya medan P&L / return / winrate", () => {
    const keys = Object.keys(OK());
    for (const forbidden of ["pnl", "return", "netR", "winRate", "dispersion", "profit"]) {
      expect(keys.some(k => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });
});

describe("C1 likuiditas", () => {
  it("di bawah lantai GAGAL", () => {
    expect(codes(OK({ quoteVolume24hUsd: 24 * 100_000 }))).toContain("C1_LIQUIDITY");
  });
  it("[INTI] volume tidak terukur = GAGAL, bukan lolos", () => {
    expect(codes(OK({ quoteVolume24hUsd: null }))).toContain("C1_LIQUIDITY");
    expect(codes(OK({ quoteVolume24hUsd: Number.NaN }))).toContain("C1_LIQUIDITY");
  });
  it("tepat di lantai LOLOS", () => {
    expect(codes(OK({ quoteVolume24hUsd: 24 * 200_000 }))).not.toContain("C1_LIQUIDITY");
  });
});

describe("C2 ukuran lot", () => {
  it("[ANGKA NYATA] BTC $63 lot pada leg $26 GAGAL", () => {
    expect(codes(OK({ price: 63000, stepSize: 0.001, minQty: 0.001 }))).toContain("C2_LOT_TOO_LARGE");
  });
  it("[ANGKA NYATA] BTC LOLOS pada leg $130", () => {
    const v = evaluateSymbolEligibility(OK({ price: 63000, stepSize: 0.001, minQty: 0.001 }), NOW,
      { ...DEFAULT_ELIGIBILITY, targetLegUsd: 130 });
    expect(v.failures.map(f => f.code)).not.toContain("C2_LOT_TOO_LARGE");
  });
  it("minNotional besar juga menggagalkan, bukan cuma stepSize", () => {
    expect(codes(OK({ minNotionalUsd: 20 }))).toContain("C2_LOT_TOO_LARGE");
  });
  it("filter tidak terbaca = GAGAL", () => {
    expect(codes(OK({ stepSize: null, minQty: null }))).toContain("C2_LOT_TOO_LARGE");
    expect(codes(OK({ price: null }))).toContain("C2_LOT_TOO_LARGE");
  });
  it("oneLotNotionalUsd mengambil yang TERBESAR dari qty vs minNotional", () => {
    expect(oneLotNotionalUsd({ price: 10, stepSize: 0.1, minQty: 0.1, minNotionalUsd: 5 })).toBe(5);
    expect(oneLotNotionalUsd({ price: 10, stepSize: 2, minQty: 0.1, minNotionalUsd: 5 })).toBe(20);
  });
});

describe("C3 umur listing", () => {
  it("terlalu baru GAGAL", () => {
    expect(codes(OK({ listedAtMs: NOW - 60 * 86_400_000 }))).toContain("C3_TOO_NEW");
  });
  it("[INTI] tanggal listing tidak diketahui = GAGAL", () => {
    expect(codes(OK({ listedAtMs: null }))).toContain("C3_TOO_NEW");
  });
});

describe("C4 carry funding", () => {
  it("[ANGKA NYATA] 6,0 bps/hold LOLOS, 9 bps GAGAL", () => {
    expect(codes(OK({ medianAbsFundingRatePerPeriod: 0.0001 }))).not.toContain("C4_FUNDING_CARRY");   // 6 bps
    expect(codes(OK({ medianAbsFundingRatePerPeriod: 0.00015 }))).toContain("C4_FUNDING_CARRY");      // 9 bps
  });
  it("funding NEGATIF dinilai dari besarannya", () => {
    expect(codes(OK({ medianAbsFundingRatePerPeriod: -0.00015 }))).toContain("C4_FUNDING_CARRY");
  });
  it("[INTI] funding tidak terukur = GAGAL", () => {
    expect(codes(OK({ medianAbsFundingRatePerPeriod: null }))).toContain("C4_FUNDING_CARRY");
  });
});

describe("C5 redundansi", () => {
  it("korelasi di atas ambang GAGAL", () => {
    expect(codes(OK({ maxCorrelationToAccepted: 0.97 }))).toContain("C5_REDUNDANT");
  });
  it("[INTI] TIDAK ADA pembanding = LOLOS (simbol pertama tidak bisa redundan)", () => {
    expect(codes(OK({ maxCorrelationToAccepted: null }))).not.toContain("C5_REDUNDANT");
  });
});

describe("verdict membawa angka terukur untuk audit", () => {
  it("mencatat apa yang diukur, bukan cuma lolos/gagal", () => {
    const v = evaluateSymbolEligibility(OK({ price: 63000, stepSize: 0.001, minQty: 0.001 }), NOW);
    expect(v.measured.oneLotUsd).toBeCloseTo(63, 0);
    expect(v.measured.liquidityUsdPerHour).toBeCloseTo(1_000_000, 0);
    expect(v.measured.fundingCarryBps).toBeCloseTo(3, 1);
    expect(v.failures[0]!.detail).toContain("63.00");
  });
});

describe("diffPool", () => {
  const vs = [
    evaluateSymbolEligibility(OK({ symbol: "AUSDT" }), NOW),
    evaluateSymbolEligibility(OK({ symbol: "BUSDT", quoteVolume24hUsd: 0 }), NOW),
    evaluateSymbolEligibility(OK({ symbol: "CUSDT" }), NOW),
  ];
  it("membagi masuk / keluar / tetap", () => {
    const d = diffPool(vs, ["BUSDT", "CUSDT"]);
    expect(d.eligible.sort()).toEqual(["AUSDT", "CUSDT"]);
    expect(d.added).toEqual(["AUSDT"]);
    expect(d.removed).toEqual(["BUSDT"]);
    expect(d.unchanged).toEqual(["CUSDT"]);
  });
  it("[INTI] setiap pengeluaran membawa ALASAN — rotasi tidak boleh senyap", () => {
    const d = diffPool(vs, ["BUSDT", "CUSDT"]);
    expect(d.removalReasons["BUSDT"]).toContain("C1_LIQUIDITY");
  });
  it("simbol yang tidak ada di pool sekarang tidak muncul sebagai alasan pengeluaran", () => {
    expect(Object.keys(diffPool(vs, ["CUSDT"]).removalReasons)).toEqual([]);
  });
});

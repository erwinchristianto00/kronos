import { describe, it, expect } from "vitest";
import {
  isOverlayClose, positionCostR, realisedNetR, replayOwnExit, countIndependentEpisodes,
  summariseCounterfactual, ownExitParamsFromEnv, DEFAULT_OWN_EXIT, type Bar,
} from "../src/lib/directional-overlay-counterfactual.js";

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ openTimeMs: t, open: o, high: h, low: l, close: c });
const P = { armR: 0.2, givebackFraction: 0.3, profitLockNetReturn: 0.005, staticTpMaxNetReturn: 0.0065, maxHoldHours: 24 };
// SHORT dari 100, stop 104 -> risk 4
const SHORT = { direction: "SHORT" as const, entryPrice: 100, stopPrice: 104 };

describe("isOverlayClose", () => {
  it("hanya menganggap penutupan overlay", () => {
    expect(isOverlayClose("DIRECTIONAL_REVERSAL_CONFIRMED:NO_TRADE")).toBe(true);
    expect(isOverlayClose("MFE_PROFIT_LOCK")).toBe(false);
    expect(isOverlayClose(null)).toBe(false);
    expect(isOverlayClose(undefined)).toBe(false);
  });
});

describe("positionCostR", () => {
  it("mengubah bps notional jadi R", () => {
    // notional 100*1=100, risk 4 -> 7.99bps*100/4 = 0.19975 R
    expect(positionCostR({ qty: 1, entryPrice: 100, stopPrice: 104 }, 7.99)).toBeCloseTo(0.019975, 6);
  });
  it("null kalau risk nol (entry == stop)", () => {
    expect(positionCostR({ qty: 1, entryPrice: 100, stopPrice: 100 }, 7.99)).toBeNull();
  });
});

describe("realisedNetR — koreksi ongkos kurang hitung", () => {
  const base = { positionId: "x", symbol: "S", direction: "SHORT" as const, qty: 1, entryPrice: 100,
                 stopPrice: 104, openedAt: "2026-08-13T00:00:00Z", closedAt: "2026-08-13T01:00:00Z",
                 closeReason: "DIRECTIONAL_REVERSAL_CONFIRMED:NO_TRADE", netPnlUsd: 0.4 };
  it("[INTI] mengurangkan komisi entry ketika BELUM dilipat ke P&L", () => {
    expect(realisedNetR({ ...base, entryCommissionUsd: 0.1, entryLegFoldedIntoPnl: false })).toBeCloseTo((0.4 - 0.1) / 4, 10);
  });
  it("TIDAK mengurangkan dua kali kalau sudah dilipat", () => {
    expect(realisedNetR({ ...base, entryCommissionUsd: 0.1, entryLegFoldedIntoPnl: true })).toBeCloseTo(0.4 / 4, 10);
  });
  it("aman kalau komisinya tidak tercatat", () => {
    expect(realisedNetR({ ...base })).toBeCloseTo(0.4 / 4, 10);
  });
  it("null kalau risk nol", () => {
    expect(realisedNetR({ ...base, stopPrice: 100 })).toBeNull();
  });
});

describe("replayOwnExit", () => {
  it("STOP kena pada wick — resting order, dicek PALING DULU", () => {
    const bars = [bar(0, 100, 105, 99, 99)];   // high 105 >= stop 104, tapi close menguntungkan
    const r = replayOwnExit(bars, SHORT, P, 0)!;
    expect(r.exitReason).toBe("STOP");
    expect(r.stopHit).toBe(true);
    expect(r.grossR).toBeCloseTo(-1, 10);
  });

  it("[INTI] exit lane TIDAK terpicu wick — hanya close", () => {
    // low 99.0 (=1% menguntungkan, di atas static TP) tapi close 100 -> tidak ada exit
    const bars = [bar(0, 100, 100.5, 99.0, 100), bar(300e3, 100, 100.2, 99.9, 100)];
    const r = replayOwnExit(bars, SHORT, P, 0)!;
    expect(r.exitReason).toBe("MAX_HOLD");
  });

  it("STATIC_TP saat close melewati 0.65%", () => {
    const r = replayOwnExit([bar(0, 100, 100.1, 99.2, 99.3)], SHORT, P, 0)!;
    expect(r.exitReason).toBe("STATIC_TP");
  });

  it("PROFIT_LOCK saat close melewati 0.5% tapi belum 0.65%", () => {
    const r = replayOwnExit([bar(0, 100, 100.1, 99.4, 99.45)], SHORT, P, 0)!;
    expect(r.exitReason).toBe("PROFIT_LOCK");
  });

  it("MFE_GIVEBACK setelah armed di 0.2R lalu balik ke bawah trail", () => {
    // risk 4: close 98.8 -> +0.3R (armed). trail = 0.3*0.7 = 0.21R -> harga 99.16
    // MFE hanya bisa armed sebelum STATIC_TP kalau risk/entry kecil (armR*risk/entry < staticTP).
    // entry 100 / stop 102 -> risk 2. bar1 close 99.6 = 0.2R (ret 0.4% < profit lock 0.5%) -> armed.
    // trail = 0.2*0.7 = 0.14R. bar2 close 99.8 = 0.1R <= 0.14R -> GIVEBACK.
    const SHALLOW = { direction: "SHORT" as const, entryPrice: 100, stopPrice: 102 };
    const bars = [bar(0, 100, 100, 99.6, 99.6), bar(300e3, 99.6, 99.9, 99.6, 99.8)];
    const r = replayOwnExit(bars, SHALLOW, P, 0)!;
    expect(r.exitReason).toBe("MFE_GIVEBACK");
  });

  it("MAX_HOLD memotong pada batas jam", () => {
    const bars = [bar(0, 100, 100.1, 99.9, 100), bar(25 * 3600e3, 100, 100.1, 99.9, 99.99)];
    const r = replayOwnExit(bars, SHORT, { ...P, maxHoldHours: 24 }, 0)!;
    expect(r.exitReason).toBe("MAX_HOLD");
    expect(r.holdHours).toBeLessThanOrEqual(24);
  });

  it("costR dikurangkan dari netR, gross tidak tersentuh", () => {
    const r = replayOwnExit([bar(0, 100, 100.1, 99.2, 99.3)], SHORT, P, 0.2)!;
    expect(r.netR).toBeCloseTo(r.grossR - 0.2, 10);
  });

  it("null pada bar kosong atau risk nol", () => {
    expect(replayOwnExit([], SHORT, P, 0)).toBeNull();
    expect(replayOwnExit([bar(0, 100, 100, 100, 100)], { ...SHORT, stopPrice: 100 }, P, 0)).toBeNull();
  });
});

describe("countIndependentEpisodes", () => {
  it("[INTI] jendela tumpang tindih runtuh jadi SATU episode", () => {
    expect(countIndependentEpisodes([
      { openedAt: "2026-08-13T16:13:00Z", closedAt: "2026-08-14T10:00:00Z" },
      { openedAt: "2026-08-13T16:18:00Z", closedAt: "2026-08-14T10:00:00Z" },
      { openedAt: "2026-08-13T17:03:00Z", closedAt: "2026-08-14T10:00:00Z" },
    ])).toBe(1);
  });
  it("jendela terpisah dihitung sendiri-sendiri", () => {
    expect(countIndependentEpisodes([
      { openedAt: "2026-08-13T00:00:00Z", closedAt: "2026-08-13T01:00:00Z" },
      { openedAt: "2026-08-13T05:00:00Z", closedAt: "2026-08-13T06:00:00Z" },
    ])).toBe(2);
  });
});

describe("summariseCounterfactual — vonisnya harus jujur", () => {
  const row = (i: number, stopHit = false) => ({
    positionId: `p${i}`, symbol: "S", direction: "SHORT" as const,
    openedAt: `2026-08-${13 + (i % 2)}T0${i % 9}:00:00Z`, closedAt: `2026-08-${13 + (i % 2)}T0${i % 9}:30:00Z`,
    actualNetR: -0.06, counterfactualNetR: 0.22, deltaR: 0.28,
    counterfactualExit: "PROFIT_LOCK" as const, counterfactualHoldHours: 5, stopHit,
  });
  it("[INTI] menolak menyimpulkan pada sampel kecil", () => {
    expect(summariseCounterfactual([row(1), row(2)]).verdict).toContain("NOT DECIDABLE");
  });
  it("[INTI] menandai NOL stop sebagai sampel tanpa pembalikan sungguhan", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...row(i), openedAt: `2026-08-${String(1 + i).padStart(2, "0")}T00:00:00Z`, closedAt: `2026-08-${String(1 + i).padStart(2, "0")}T01:00:00Z` }));
    expect(summariseCounterfactual(many).verdict).toContain("ZERO stops");
  });
  it("baru menyatakan cukup ketika episode banyak, hari banyak, dan ada stop kena", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...row(i), openedAt: `2026-08-${String(1 + i).padStart(2, "0")}T00:00:00Z`, closedAt: `2026-08-${String(1 + i).padStart(2, "0")}T01:00:00Z`, stopHit: i < 5 }));
    expect(summariseCounterfactual(many).verdict).toContain("broad enough");
  });
  it("kosong = tidak mengarang apa-apa", () => {
    const s = summariseCounterfactual([]);
    expect(s.n).toBe(0); expect(s.actualMeanR).toBeNull(); expect(s.verdict).toContain("no overlay-closed");
  });
});

describe("ownExitParamsFromEnv", () => {
  it("memakai default kalau tidak diset", () => {
    expect(ownExitParamsFromEnv({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_OWN_EXIT);
  });
  it("membaca env produksi", () => {
    const p = ownExitParamsFromEnv({ CROSS_SECTIONAL_DIRECTIONAL_MFE_ARM_R: "0.20", CROSS_SECTIONAL_DIRECTIONAL_MAX_HOLD_HOURS: "24" } as NodeJS.ProcessEnv);
    expect(p.armR).toBe(0.2); expect(p.maxHoldHours).toBe(24);
  });
  it("nilai tak sah jatuh ke default, bukan NaN", () => {
    expect(ownExitParamsFromEnv({ CROSS_SECTIONAL_DIRECTIONAL_MFE_ARM_R: "abc" } as NodeJS.ProcessEnv).armR).toBe(0.2);
  });
});

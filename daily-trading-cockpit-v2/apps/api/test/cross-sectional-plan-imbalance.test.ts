import { describe, it, expect } from "vitest";
import {
  crossSectionalPlanNotionalImbalance,
  crossSectionalMaxPlanImbalance,
  crossSectionalPlanImbalanceExceeded,
  sizeCrossSectionalLeg,
} from "../src/lib/cross-sectional-executor.js";

// Basket nyata xb-mstx1llv-ltered (15 Agt 2026), notional per kaki apa adanya.
const REAL = [
  { side: "LONG" as const, requestedQty: 1, refPrice: 11.95 },  // DOGE
  { side: "LONG" as const, requestedQty: 1, refPrice: 7.23 },   // LINK
  { side: "LONG" as const, requestedQty: 1, refPrice: 13.44 },  // AVAX
  { side: "SHORT" as const, requestedQty: 1, refPrice: 9.83 },  // UNI
  { side: "SHORT" as const, requestedQty: 1, refPrice: 11.00 }, // ADA
  { side: "SHORT" as const, requestedQty: 1, refPrice: 8.74 },  // TAO
];

describe("[SEBAB] pembulatan lot yang hanya bisa naik", () => {
  it("meniup kaki $7.16 jadi $13.44 pada koin stepSize=1 — inilah asal ketimpangannya", () => {
    const qty = sizeCrossSectionalLeg(7.16, 13.44, { stepSize: 1, minQty: 1, minNotional: 5 });
    expect(qty).toBe(1);
    expect(qty! * 13.44).toBeCloseTo(13.44, 2);   // 88% di atas target $7.16
  });
});

describe("crossSectionalPlanNotionalImbalance", () => {
  it("mengukur basket nyata pada 4.90%", () => {
    expect(crossSectionalPlanNotionalImbalance(REAL) * 100).toBeCloseTo(4.90, 1);
  });

  it("[CELAH-MUTASI] besaran sama ketika yang berat justru sisi SHORT", () => {
    // cermin dari REAL: long $29.56 / short $32.62 -> tetap 4.90%, bukan -4.90%
    expect(crossSectionalPlanNotionalImbalance([
      { side: "LONG", requestedQty: 1, refPrice: 29.56 },
      { side: "SHORT", requestedQty: 1, refPrice: 32.62 },
    ]) * 100).toBeCloseTo(4.90, 1);
  });

  it("[CELAH-MUTASI] ambang 3% juga MENOLAK basket yang berat di sisi short", () => {
    expect(crossSectionalPlanImbalanceExceeded([
      { side: "LONG", requestedQty: 1, refPrice: 29.56 },
      { side: "SHORT", requestedQty: 1, refPrice: 32.62 },
    ], 0.03)).toBe(true);
  });

  it("nol untuk basket yang benar-benar seimbang", () => {
    expect(crossSectionalPlanNotionalImbalance([
      { side: "LONG", requestedQty: 2, refPrice: 10 },
      { side: "SHORT", requestedQty: 1, refPrice: 20 },
    ])).toBe(0);
  });

  it("100% ketika satu sisi saja yang terisi (abort separuh terbuka)", () => {
    expect(crossSectionalPlanNotionalImbalance([{ side: "LONG", requestedQty: 1, refPrice: 26.30 }])).toBe(1);
  });

  it("tidak membagi nol pada daftar kosong / notional nol", () => {
    expect(crossSectionalPlanNotionalImbalance([])).toBe(0);
    expect(crossSectionalPlanNotionalImbalance([{ side: "LONG", requestedQty: 0, refPrice: 0 }])).toBe(0);
  });

  it("mengabaikan kaki yang notionalnya bukan angka, bukan ikut merusak total", () => {
    expect(crossSectionalPlanNotionalImbalance([
      { side: "LONG", requestedQty: Number.NaN, refPrice: 10 },
      { side: "LONG", requestedQty: 1, refPrice: 10 },
      { side: "SHORT", requestedQty: 1, refPrice: 10 },
    ])).toBe(0);
  });
});

describe("crossSectionalMaxPlanImbalance", () => {
  it("nol (mati) kalau tidak diset", () => {
    expect(crossSectionalMaxPlanImbalance({} as NodeJS.ProcessEnv)).toBe(0);
  });
  it("membaca persen jadi pecahan", () => {
    expect(crossSectionalMaxPlanImbalance({ CROSS_SECTIONAL_MAX_PLAN_IMBALANCE_PCT: "3" } as NodeJS.ProcessEnv))
      .toBeCloseTo(0.03, 10);
  });
  it("nilai tak sah atau negatif = mati, bukan melempar", () => {
    expect(crossSectionalMaxPlanImbalance({ CROSS_SECTIONAL_MAX_PLAN_IMBALANCE_PCT: "abc" } as NodeJS.ProcessEnv)).toBe(0);
    expect(crossSectionalMaxPlanImbalance({ CROSS_SECTIONAL_MAX_PLAN_IMBALANCE_PCT: "-5" } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("crossSectionalPlanImbalanceExceeded", () => {
  it("[INTI] ambang 3% MENOLAK basket nyata 4.90%", () => {
    expect(crossSectionalPlanImbalanceExceeded(REAL, 0.03)).toBe(true);
  });

  it("ambang 6% MELOLOSKAN basket nyata yang sama", () => {
    expect(crossSectionalPlanImbalanceExceeded(REAL, 0.06)).toBe(false);
  });

  it("ambang 3% MELOLOSKAN basket ukuran penuh (2.18% — msqa0qpb)", () => {
    expect(crossSectionalPlanImbalanceExceeded([
      { side: "LONG", requestedQty: 1, refPrice: 81.62 },
      { side: "SHORT", requestedQty: 1, refPrice: 78.13 },
    ], 0.03)).toBe(false);
  });

  it("ambang 0 = penjaga MATI, apa pun basketnya", () => {
    expect(crossSectionalPlanImbalanceExceeded(REAL, 0)).toBe(false);
    expect(crossSectionalPlanImbalanceExceeded([{ side: "LONG", requestedQty: 1, refPrice: 99 }], 0)).toBe(false);
  });
});

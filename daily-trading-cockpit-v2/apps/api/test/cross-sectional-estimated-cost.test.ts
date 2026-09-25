import { describe, it, expect } from "vitest";
import { crossSectionalEstimatedCostPct } from "../src/lib/cross-sectional-executor.js";

describe("crossSectionalEstimatedCostPct", () => {
  it("[INTI] default 13 bps — bukan 22 bps global", () => {
    expect(crossSectionalEstimatedCostPct({} as NodeJS.ProcessEnv)).toBeCloseTo(0.0013, 10);
  });

  it("[INTI] TIDAK ikut LIVE_ESTIMATED_CLOSE_COST_PCT", () => {
    const env = { LIVE_ESTIMATED_CLOSE_COST_PCT: "0.0022" } as unknown as NodeJS.ProcessEnv;
    expect(crossSectionalEstimatedCostPct(env)).toBeCloseTo(0.0013, 10);
  });

  it("membaca kunci sendiri kalau diset", () => {
    const env = { CROSS_SECTIONAL_ESTIMATED_COST_PCT: "0.0008" } as unknown as NodeJS.ProcessEnv;
    expect(crossSectionalEstimatedCostPct(env)).toBeCloseTo(0.0008, 10);
  });

  it("nol sah — artinya ongkos diabaikan, bukan jatuh ke default", () => {
    const env = { CROSS_SECTIONAL_ESTIMATED_COST_PCT: "0" } as unknown as NodeJS.ProcessEnv;
    expect(crossSectionalEstimatedCostPct(env)).toBe(0);
  });

  it("nilai tak sah / negatif jatuh ke default, tidak melempar", () => {
    for (const v of ["abc", "-0.001", "", "NaN"]) {
      const env = { CROSS_SECTIONAL_ESTIMATED_COST_PCT: v } as unknown as NodeJS.ProcessEnv;
      expect(crossSectionalEstimatedCostPct(env)).toBeCloseTo(0.0013, 10);
    }
  });

  it("[ANGKA TERUKUR] 13 bps di atas total terukur 11.79, di bawah global 22", () => {
    const v = crossSectionalEstimatedCostPct({} as NodeJS.ProcessEnv) * 10000;
    expect(v).toBeGreaterThan(11.79);
    expect(v).toBeLessThan(22);
  });
});

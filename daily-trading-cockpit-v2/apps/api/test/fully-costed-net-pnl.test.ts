import { describe, it, expect } from "vitest";
import {
  fullyCostedNetPnlUsd, fullyCostedFeeUsd, isEntryLegRecoverable, summariseCostedPositions,
} from "../src/lib/fully-costed-net-pnl.js";

const P = (o: Partial<Parameters<typeof fullyCostedNetPnlUsd>[0]> = {}) => ({
  netPnlUsd: 0.4, feeEstimateUsd: 0.1, entryCommissionUsd: 0.1, entryRealizedPnlUsd: 0,
  entryLegFoldedIntoPnl: false as boolean | null | undefined, ...o,
});

describe("kontrak tiga-nilai entryLegFoldedIntoPnl", () => {
  it("[INTI] false -> komisi entry DIKURANGKAN", () => {
    expect(fullyCostedNetPnlUsd(P())).toBeCloseTo(0.3, 10);
    expect(fullyCostedFeeUsd(P())).toBeCloseTo(0.2, 10);
  });

  it("[INTI] true -> TIDAK dikurangkan (sudah termasuk, menghindari hitung ganda)", () => {
    expect(fullyCostedNetPnlUsd(P({ entryLegFoldedIntoPnl: true }))).toBeCloseTo(0.4, 10);
    expect(fullyCostedFeeUsd(P({ entryLegFoldedIntoPnl: true }))).toBeCloseTo(0.1, 10);
  });

  it("[INTI] undefined -> TIDAK direkonstruksi (arm estimasi sudah memodelkan kedua sisi)", () => {
    expect(fullyCostedNetPnlUsd(P({ entryLegFoldedIntoPnl: undefined }))).toBeCloseTo(0.4, 10);
    expect(fullyCostedNetPnlUsd(P({ entryLegFoldedIntoPnl: null }))).toBeCloseTo(0.4, 10);
  });

  it("false tapi komisi tidak tercatat -> lewati, jangan mengarang", () => {
    expect(fullyCostedNetPnlUsd(P({ entryCommissionUsd: undefined }))).toBeCloseTo(0.4, 10);
    expect(fullyCostedNetPnlUsd(P({ entryCommissionUsd: Number.NaN }))).toBeCloseTo(0.4, 10);
    expect(fullyCostedNetPnlUsd(P({ entryRealizedPnlUsd: undefined }))).toBeCloseTo(0.4, 10);
  });
});

describe("entryRealizedPnlUsd", () => {
  it("nonzero ikut dihitung — entry yang mengurangi posisi lawan di akun netted", () => {
    expect(fullyCostedNetPnlUsd(P({ entryRealizedPnlUsd: 0.05 }))).toBeCloseTo(0.35, 10);
  });
});

describe("isEntryLegRecoverable", () => {
  it("hanya benar saat flag false DAN kedua angka ada", () => {
    expect(isEntryLegRecoverable(P())).toBe(true);
    expect(isEntryLegRecoverable(P({ entryLegFoldedIntoPnl: true }))).toBe(false);
    expect(isEntryLegRecoverable(P({ entryLegFoldedIntoPnl: undefined }))).toBe(false);
    expect(isEntryLegRecoverable(P({ entryCommissionUsd: null }))).toBe(false);
  });
});

describe("nilai hilang", () => {
  it("netPnlUsd null -> null, tidak melempar", () => {
    expect(fullyCostedNetPnlUsd(P({ netPnlUsd: null }))).toBeNull();
  });
  it("feeEstimateUsd hilang -> null", () => {
    expect(fullyCostedFeeUsd(P({ feeEstimateUsd: null }))).toBeNull();
  });
});

describe("summariseCostedPositions", () => {
  it("[ANGKA NYATA] mereproduksi lane SHORT: 12 posisi, delta −0.1185", () => {
    const rows = Array.from({ length: 12 }, () => P({ netPnlUsd: 0.5248 / 12, entryCommissionUsd: 0.1185 / 12 }));
    const s = summariseCostedPositions(rows);
    expect(s.n).toBe(12);
    expect(s.corrected).toBe(12);
    expect(s.uncorrected).toBe(0);
    expect(s.recordedNetUsd).toBeCloseTo(0.5248, 6);
    expect(s.fullyCostedNetUsd).toBeCloseTo(0.4063, 6);
    expect(s.deltaUsd).toBeCloseTo(-0.1185, 6);
  });

  it("[INTI] delta tidak pernah positif — komisi hanya bisa mengurangi", () => {
    expect(summariseCostedPositions([P(), P(), P()]).deltaUsd).toBeLessThanOrEqual(0);
  });

  it("menghitung baris yang TIDAK bisa dikoreksi, bukan menyembunyikannya", () => {
    const s = summariseCostedPositions([P(), P({ entryLegFoldedIntoPnl: undefined }), P({ entryLegFoldedIntoPnl: true })]);
    expect(s.n).toBe(3);
    expect(s.corrected).toBe(1);
    expect(s.uncorrected).toBe(2);
  });

  it("baris tanpa netPnlUsd tidak dihitung sama sekali", () => {
    expect(summariseCostedPositions([P({ netPnlUsd: null }), P()]).n).toBe(1);
  });

  it("daftar kosong aman", () => {
    const s = summariseCostedPositions([]);
    expect(s.n).toBe(0); expect(s.deltaUsd).toBe(0);
  });
});

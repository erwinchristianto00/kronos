import { describe, it, expect } from "vitest";
import {
  buildSubmitRefBase, stampSubmitRef, decomposeFillCost, EXECUTION_VENUES,
} from "../src/lib/submit-reference-quote.js";

const Q = (o: Partial<Parameters<typeof buildSubmitRefBase>[0]> = {}) => ({
  bid: 99.9, ask: 100.1, mid: 100, atMs: 1000, venue: "BINANCE_USDM_BOOK_TICKER", ...o,
} as NonNullable<Parameters<typeof buildSubmitRefBase>[0]>);

describe("buildSubmitRefBase — kesegaran", () => {
  it("[INTI] MENOLAK kuotasi yang lebih tua dari awal pengamatan", () => {
    expect(buildSubmitRefBase(Q({ atMs: 999 }), 1000, "LONG")).toBeNull();
  });
  it("menerima kuotasi tepat di batas", () => {
    expect(buildSubmitRefBase(Q({ atMs: 1000 }), 1000, "LONG")).not.toBeNull();
  });
  it("null untuk kuotasi kosong / mid tidak sah", () => {
    expect(buildSubmitRefBase(null, 0, "LONG")).toBeNull();
    expect(buildSubmitRefBase(Q({ mid: 0 }), 0, "LONG")).toBeNull();
    expect(buildSubmitRefBase(Q({ mid: Number.NaN }), 0, "LONG")).toBeNull();
    expect(buildSubmitRefBase(Q({ atMs: Number.NaN }), 0, "LONG")).toBeNull();
  });
});

describe("buildSubmitRefBase — bentuk", () => {
  it("[INTI] touch = ASK untuk LONG, BID untuk SHORT", () => {
    expect(buildSubmitRefBase(Q(), 0, "LONG")!.touch).toBe(100.1);
    expect(buildSubmitRefBase(Q(), 0, "SHORT")!.touch).toBe(99.9);
  });
  it("dua sisi = BOOK_TICKER, satu sisi = MID_ONLY", () => {
    expect(buildSubmitRefBase(Q(), 0, "LONG")!.source).toBe("BOOK_TICKER");
    expect(buildSubmitRefBase(Q({ ask: null }), 0, "LONG")!.source).toBe("MID_ONLY");
    expect(buildSubmitRefBase(Q({ bid: null }), 0, "SHORT")!.source).toBe("MID_ONLY");
  });
  it("satu sisi -> touch null di arah yang tidak punya harga", () => {
    expect(buildSubmitRefBase(Q({ ask: null }), 0, "LONG")!.touch).toBeNull();
  });
  it("[INTI] venue tak dikenal / kosong TIDAK dianggap cocok", () => {
    expect(buildSubmitRefBase(Q({ venue: "BINANCE_SPOT_BOOK_TICKER" }), 0, "LONG")!.venueMatchesExecution).toBe(false);
    expect(buildSubmitRefBase(Q({ venue: undefined }), 0, "LONG")!.venueMatchesExecution).toBe(false);
    expect(buildSubmitRefBase(Q({ venue: "" }), 0, "LONG")!.venue).toBe("UNKNOWN");
    expect(buildSubmitRefBase(Q(), 0, "LONG")!.venueMatchesExecution).toBe(true);
  });
  it("harga negatif/nol diperlakukan tidak ada, bukan dipakai", () => {
    const b = buildSubmitRefBase(Q({ bid: -1, ask: 0 }), 0, "LONG")!;
    expect(b.bid).toBeNull(); expect(b.ask).toBeNull(); expect(b.source).toBe("MID_ONLY");
  });
});

describe("stampSubmitRef", () => {
  it("umur = now − atMs", () => {
    expect(stampSubmitRef(buildSubmitRefBase(Q(), 0, "LONG"), 1376)!.ageAtSubmitMs).toBe(376);
  });
  it("[INTI] umur negatif dilantai 0 TAPI ditandai clockAnomaly", () => {
    const s = stampSubmitRef(buildSubmitRefBase(Q(), 0, "LONG"), 900)!;
    expect(s.ageAtSubmitMs).toBe(0);
    expect(s.clockAnomaly).toBe(true);
  });
  it("umur normal TIDAK menandai anomali", () => {
    expect(stampSubmitRef(buildSubmitRefBase(Q(), 0, "LONG"), 1376)!.clockAnomaly).toBeUndefined();
  });
  it("null masuk = null keluar, tidak melempar", () => {
    expect(stampSubmitRef(null, 1000)).toBeNull();
    expect(stampSubmitRef(buildSubmitRefBase(Q(), 0, "LONG"), Number.NaN)).toBeNull();
  });
});

describe("decomposeFillCost — memisah spread dari slippage", () => {
  const ref = (side: "LONG" | "SHORT") => stampSubmitRef(buildSubmitRefBase(Q(), 0, side), 1000)!;

  it("[INTI] LONG: fill di ask = spread saja, slippage NOL", () => {
    const d = decomposeFillCost(100.1, ref("LONG"), "LONG")!;
    expect(d.spreadBps).toBeCloseTo(10, 6);      // (100.1-100)/100 = 10bps
    expect(d.slippageBps).toBeCloseTo(0, 6);
    expect(d.totalBps).toBeCloseTo(10, 6);
  });
  it("[INTI] LONG: fill DI ATAS ask = slippage positif (merugikan)", () => {
    const d = decomposeFillCost(100.2, ref("LONG"), "LONG")!;
    expect(d.slippageBps).toBeCloseTo(10, 6);
  });
  it("[INTI] SHORT: fill di bid = spread saja; fill DI BAWAH bid = slippage merugikan", () => {
    expect(decomposeFillCost(99.9, ref("SHORT"), "SHORT")!.slippageBps).toBeCloseTo(0, 6);
    expect(decomposeFillCost(99.8, ref("SHORT"), "SHORT")!.slippageBps).toBeCloseTo(10, 6);
    expect(decomposeFillCost(99.9, ref("SHORT"), "SHORT")!.spreadBps).toBeCloseTo(10, 6);
  });
  it("fill LEBIH BAIK dari touch = slippage negatif (menguntungkan)", () => {
    expect(decomposeFillCost(100.05, ref("LONG"), "LONG")!.slippageBps).toBeCloseTo(-5, 6);
  });

  it("[INTI] MENOLAK kuotasi satu sisi — spread tidak bisa dipisah", () => {
    const oneSided = stampSubmitRef(buildSubmitRefBase(Q({ ask: null }), 0, "LONG"), 1000);
    expect(decomposeFillCost(100.1, oneSided, "LONG")).toBeNull();
  });
  it("[INTI] MENOLAK venue yang bukan tempat eksekusi — itu basis, bukan slippage", () => {
    const spot = stampSubmitRef(buildSubmitRefBase(Q({ venue: "BINANCE_SPOT_BOOK_TICKER" }), 0, "LONG"), 1000);
    expect(decomposeFillCost(100.1, spot, "LONG")).toBeNull();
  });
  it("null / fill tidak sah = null", () => {
    expect(decomposeFillCost(100, null, "LONG")).toBeNull();
    expect(decomposeFillCost(0, ref("LONG"), "LONG")).toBeNull();
    expect(decomposeFillCost(Number.NaN, ref("LONG"), "LONG")).toBeNull();
  });
});

describe("EXECUTION_VENUES", () => {
  it("hanya book USD-M yang dihitung sebagai tempat eksekusi", () => {
    expect(EXECUTION_VENUES.has("BINANCE_USDM_BOOK_TICKER")).toBe(true);
    expect(EXECUTION_VENUES.has("BINANCE_SPOT_BOOK_TICKER")).toBe(false);
    expect(EXECUTION_VENUES.has("UNKNOWN")).toBe(false);
  });
});

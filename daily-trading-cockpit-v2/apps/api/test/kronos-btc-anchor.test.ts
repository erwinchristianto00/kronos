import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { Candle, KronosPrediction } from "@dtc/shared";
import { kronosAgreeFromScan, kronosAgreeFromPrediction, KRONOS_CONFIDENCE_SCALE_MAX } from "../src/lib/kronos-agree-reading.js";
import { KronosBtcAnchorCache, refreshKronosBtcAnchor, _resetKronosBtcAnchorCacheForTests } from "../src/lib/kronos-btc-anchor-cache.js";

/**
 * kronosAgree read MISSING on 100% of Direction decisions on both instances while the data sat in
 * plain sight. kronosAgreeFromScan needs BTCUSDT inside the scan's `top10`, and `top10` is an
 * OPPORTUNITY ranking — measured 2026-07-28 it held SEI, SUI, WLD, NEAR, BNB, SOL, all six carrying a
 * usable Kronos bias, and no BTC. BTC is the calmest large-cap there is; it rarely earns a slot.
 */
const CANDLE = { openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 2 } as unknown as Candle;
const pred = (o: Partial<KronosPrediction> = {}): KronosPrediction =>
  ({ available: true, selectedKronosBias: "LONG", kronosConfidence: 100, ...o }) as KronosPrediction;

beforeEach(() => { _resetKronosBtcAnchorCacheForTests(); });

describe("confidence is 0-100, and clamping it to 1 saturated every opinion", () => {
  /** tracker.ts's own buckets settle the scale beyond argument: <45 WEAK, <70 MEDIUM, >=70 STRONG. */
  it("uses a 0-100 scale", () => {
    expect(KRONOS_CONFIDENCE_SCALE_MAX).toBe(100);
  });

  /** FAILS WITHOUT THE FIX — Math.min(1, confidence) made 46 and 99 push identically hard, defeating
   *  the one thing the magnitude exists to do. */
  it("a hesitant call really does push less hard than a certain one", () => {
    const weak = kronosAgreeFromPrediction(pred({ kronosConfidence: 46 }), 1_000)!.agree!;
    const strong = kronosAgreeFromPrediction(pred({ kronosConfidence: 99 }), 1_000)!.agree!;
    expect(weak).toBeCloseTo(0.46, 6);
    expect(strong).toBeCloseTo(0.99, 6);
    expect(weak).toBeLessThan(strong);
  });

  it("the same fix applies to the scan reader, which had the identical bug", () => {
    const row = { symbol: "BTCUSDT", selectedKronosBias: "SHORT", kronosConfidence: 60 } as never;
    expect(kronosAgreeFromScan([row], "BTCUSDT", 1_000).agree).toBeCloseTo(-0.6, 6);
  });

  it("still refuses a zero-confidence opinion rather than reporting it as neutral", () => {
    expect(kronosAgreeFromPrediction(pred({ kronosConfidence: 0 }), 1_000).agree).toBeNull();
  });

  it("SHORT is the mirror of LONG", () => {
    expect(kronosAgreeFromPrediction(pred({ selectedKronosBias: "SHORT", kronosConfidence: 80 }), 1_000).agree).toBeCloseTo(-0.8, 6);
  });

  it("an unavailable prediction is absent, never zero", () => {
    expect(kronosAgreeFromPrediction(pred({ available: false }), 1_000).agree).toBeNull();
    expect(kronosAgreeFromPrediction(null, 1_000).agree).toBeNull();
    expect(kronosAgreeFromPrediction(pred({ selectedKronosBias: undefined, kronosBias: undefined }), 1_000).agree).toBeNull();
  });

  it("refuses to stamp a reading with no producer clock", () => {
    expect(kronosAgreeFromPrediction(pred(), null).agree).toBeNull();
  });
});

describe("the anchor produces a reading without BTC entering the opportunity list", () => {
  const okFetch = async () => [CANDLE];

  it("caches a usable reading with the producer's own clock", async () => {
    const c = new KronosBtcAnchorCache();
    await refreshKronosBtcAnchor(c, okFetch, async () => pred({ kronosConfidence: 70 }), 5_000);
    expect(c.get()).toEqual({ agree: 0.7, atMs: 5_000, lastSkipReason: null });
  });

  it("records why it produced nothing instead of failing silently", async () => {
    const c = new KronosBtcAnchorCache();
    await refreshKronosBtcAnchor(c, okFetch, async () => pred({ available: false, reason: "model cold" }), 5_000);
    expect(c.get().agree).toBeNull();
    expect(c.get().lastSkipReason).toBe("model cold");
  });

  /** THE GUARD: a transient failure must not wipe a good reading into a permanent MISSING for the
   *  whole interval — it ages out through atMs instead. */
  it("keeps the last good reading when a refresh fails", async () => {
    const c = new KronosBtcAnchorCache();
    await refreshKronosBtcAnchor(c, okFetch, async () => pred({ kronosConfidence: 90 }), 5_000);
    await refreshKronosBtcAnchor(c, async () => { throw new Error("boom"); }, async () => pred(), 9_000);
    expect(c.get().agree).toBeCloseTo(0.9, 6);
    expect(c.get().atMs).toBe(5_000);
    expect(c.get().lastSkipReason).toContain("candle fetch failed");
  });

  it("never throws — a producer must not be able to break the interval that calls it", async () => {
    const c = new KronosBtcAnchorCache();
    await expect(refreshKronosBtcAnchor(c, async () => { throw new Error("x"); }, async () => pred(), 1)).resolves.toBeUndefined();
    await expect(refreshKronosBtcAnchor(c, okFetch, async () => { throw new Error("y"); }, 1)).resolves.toBeUndefined();
    await expect(refreshKronosBtcAnchor(c, async () => [], async () => pred(), 1)).resolves.toBeUndefined();
    expect(c.get().lastSkipReason).toBe("candle fetch returned nothing");
  });
});

describe("the wiring keeps the scan as the preferred source (source-level guard)", () => {
  const APP = readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");
  /** The scan reading is free and freshest; the anchor costs an inference. Order matters. */
  it("falls back to the anchor only when the scan has no opinion", () => {
    const at = APP.indexOf("const fromScan = kronosAgreeFromScan(");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = APP.slice(at, at + 420);
    expect(body).toContain("if (fromScan.agree !== null) return");
    expect(body.indexOf("fromScan")).toBeLessThan(body.indexOf("kronosBtcAnchorCache.get()"));
  });

  /** kronos.ts serialises inference through one global slot — a 5-minute consumer would contend
   *  with the scanner for it. THE GUARD against someone moving this onto the four-brain tick. */
  it("refreshes on a 15-minute interval, not per four-brain tick", () => {
    const at = APP.indexOf("setInterval(runKronosBtcAnchorRefresh,");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(APP.slice(at, at + 60)).toContain("15 * 60_000");
  });
});

import { describe, it, expect } from "vitest";
import {
  microstructureFromIndicators,
  makeEntryMicrostructureAccessor,
  type TimeframeIndicatorLike,
} from "../src/lib/four-brain-live-gather-bindings.js";
import { FRESHNESS_TTL_MS } from "../src/lib/four-brain-live-gather.js";
import type { Candle } from "@dtc/shared";

const TF_MS = 15 * 60_000;
const NOW = 1_800_000_000_000;

/** 60 gently-oscillating candles ending at `endOpenTime` (nonzero ATR/VWAP). Last candle customizable. */
function makeCandles(count: number, endOpenTime: number, last?: Partial<Candle>): Candle[] {
  const candles: Candle[] = [];
  const start = endOpenTime - (count - 1) * TF_MS;
  for (let i = 0; i < count; i++) {
    const base = 100 + Math.sin(i / 5) * 2;
    candles.push({ openTime: start + i * TF_MS, open: base, high: base + 1, low: base - 1, close: base, volume: 1000 });
  }
  if (last) Object.assign(candles[candles.length - 1], last);
  return candles;
}

const baseInd: TimeframeIndicatorLike = {
  vwap: 100, distanceFromVwap: 1, volumeRatio: 1.5, breakoutHigh: true, breakoutLow: false, atr: 2, isFresh: true, lastOpenTime: NOW,
};

describe("Adapter B — microstructureFromIndicators (pure)", () => {
  it("derives signed VWAP distance + abs extension in ATR units", () => {
    const m = microstructureFromIndicators(baseInd, "LONG", 104);
    expect(m.distanceFromVwapAtr).toBeCloseTo(2); // (104-100)/2
    expect(m.candleExtensionAtr).toBeCloseTo(2); // |dist|
  });

  it("LONG uses breakoutHigh, SHORT uses breakoutLow (never cross-wired)", () => {
    expect(microstructureFromIndicators(baseInd, "LONG", 104).breakoutConfirmed).toBe(true);
    expect(microstructureFromIndicators(baseInd, "SHORT", 104).breakoutConfirmed).toBe(false);
  });

  it("volume confirmation is threshold-gated; null ratio ⇒ null (never fabricated)", () => {
    expect(microstructureFromIndicators(baseInd, "LONG", 104).volumeConfirmed).toBe(true); // 1.5 ≥ 1.2
    expect(microstructureFromIndicators({ ...baseInd, volumeRatio: 1.0 }, "LONG", 104).volumeConfirmed).toBe(false);
    expect(microstructureFromIndicators({ ...baseInd, volumeRatio: null }, "LONG", 104).volumeConfirmed).toBeNull();
  });

  it("null / zero ATR ⇒ distance + extension null (no divide-by-zero fabrication)", () => {
    expect(microstructureFromIndicators({ ...baseInd, atr: null }, "LONG", 104).distanceFromVwapAtr).toBeNull();
    expect(microstructureFromIndicators({ ...baseInd, atr: 0 }, "LONG", 104).candleExtensionAtr).toBeNull();
  });

  it("threads candleFresh + observedAtMs straight through", () => {
    const m = microstructureFromIndicators({ ...baseInd, isFresh: false, lastOpenTime: NOW - MinutesMs(30) }, "LONG", 104);
    expect(m.candleFresh).toBe(false);
    expect(m.observedAtMs).toBe(NOW - MinutesMs(30));
  });
});

function MinutesMs(m: number): number { return m * 60_000; }

describe("Adapter B — makeEntryMicrostructureAccessor (TTL + robustness)", () => {
  it("fresh candles ⇒ candleFresh=true, finite VWAP distance, observedAt = last open", () => {
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(60, NOW - MinutesMs(5)), nowMs: NOW, timeframe: "15m" });
    const m = acc("BTCUSDT", "LONG");
    expect(m).not.toBeNull();
    expect(m!.candleFresh).toBe(true);
    expect(m!.observedAtMs).toBe(NOW - MinutesMs(5));
    expect(typeof m!.distanceFromVwapAtr === "number" || m!.distanceFromVwapAtr === null).toBe(true);
  });

  it("candle older than the four-brain candle TTL ⇒ candleFresh=false (stale ⇒ no ENTER_NOW upstream)", () => {
    const staleAge = FRESHNESS_TTL_MS.candle + MinutesMs(30);
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(60, NOW - staleAge), nowMs: NOW });
    expect(acc("X", "LONG")!.candleFresh).toBe(false);
  });

  it("a FUTURE-dated candle is not treated as fresh (causal check)", () => {
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(60, NOW + MinutesMs(10)), nowMs: NOW });
    expect(acc("X", "LONG")!.candleFresh).toBe(false);
  });

  it("timeframe-aware grace: a 15m candle 60min old is STALE (within the 90min ceiling but past the 45min grace)", () => {
    // The fixed candle-TTL ceiling alone (90min) would wrongly call this fresh; the shared indicator's
    // timeframe grace (15m×3 = 45min) makes 60min stale ⇒ candleFresh=false (no ENTER_NOW on stale bars).
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(60, NOW - MinutesMs(60)), nowMs: NOW, timeframe: "15m" });
    expect(acc("X", "LONG")!.candleFresh).toBe(false);
  });

  it("fewer than 30 candles ⇒ null (MISSING, never fabricated)", () => {
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(10, NOW), nowMs: NOW });
    expect(acc("X", "LONG")).toBeNull();
  });

  it("provider that throws / returns null ⇒ null (MISSING, never fabricated)", () => {
    expect(makeEntryMicrostructureAccessor({ candlesFor: () => { throw new Error("boom"); }, nowMs: NOW })("X", "LONG")).toBeNull();
    expect(makeEntryMicrostructureAccessor({ candlesFor: () => null, nowMs: NOW })("X", "LONG")).toBeNull();
  });

  it("EntryMicrostructure carries NO order-book fields — spread/slippage stay MISSING structurally", () => {
    const acc = makeEntryMicrostructureAccessor({ candlesFor: () => makeCandles(60, NOW - MinutesMs(5)), nowMs: NOW });
    const m = acc("X", "LONG")!;
    expect(m).not.toHaveProperty("spreadBps");
    expect(m).not.toHaveProperty("expectedSlippageBps");
  });
});

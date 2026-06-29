import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  moonshotPrefilter,
  extractMoonshotFeatures,
  runMoonshotCycle,
  MoonshotStore,
  type MoonshotExtractionCtx,
} from "../src/lib/moonshot-lottery-cycle.js";

const c = (close: number, volume: number) => ({ close, volume });
// A strong-burst 1m series: steady then a violent last-minute thrust on huge volume.
const burstCandles = [c(100, 100), c(100.5, 100), c(101, 100), c(101.5, 100), c(102, 100), c(104.5, 800)];
const deadCandles = [c(100, 100), c(100, 100), c(100, 100), c(100, 100), c(100, 100), c(100, 100)];

function ctx(over: Partial<MoonshotExtractionCtx> = {}): MoonshotExtractionCtx {
  return {
    getCandles1m: async (sym) => (sym === "BTCUSDT" ? [c(50_000, 1), c(50_050, 1), c(50_055, 1)] : burstCandles),
    getFlow: async () => ({ fundingRate: 0.0003, openInterestChangePercent: 3.7, takerBuySellRatio: 2.4 }),
    getDepth: async () => ({
      bids: [[104.48, 300], [104.0, 300]],
      asks: [[104.52, 300], [105.0, 300]],
    }),
    getMarkPrice: async () => 104.5,
    minNotionalUsd: () => 5,
    maxLeverage: () => 50,
    ...over,
  };
}
const freshStore = () => new MoonshotStore(mkdtempSync(join(tmpdir(), "moon-")));

describe("moonshot-lottery-cycle — extraction + demo cycle", () => {
  it("[PREFILTER] passes a burst, rejects a dead tape", () => {
    expect(moonshotPrefilter(burstCandles).pass).toBe(true);
    expect(moonshotPrefilter(deadCandles).pass).toBe(false);
  });

  it("[EXTRACT] computes coherent features from market data", async () => {
    const f = await extractMoonshotFeatures("WIFUSDT", burstCandles, 0.1, ctx());
    expect(f).not.toBeNull();
    expect(f!.priceChange1mPct).toBeCloseTo(2.45, 1);
    expect(f!.volumeRatio1m).toBeCloseTo(8, 1);
    expect(f!.takerBuySellRatio).toBe(2.4);
    expect(f!.oiDelta3mPct).toBe(3.7);
    expect(f!.spreadBps).toBeLessThan(8); // tight
    expect(f!.depth05PctUsd).toBeGreaterThan(20_000); // deep
    expect(f!.btc1mPct).toBe(0.1);
  });

  it("[EXTRACT] returns null when the order book is empty", async () => {
    const f = await extractMoonshotFeatures("X", burstCandles, 0, ctx({ getDepth: async () => ({ bids: [], asks: [] }) }));
    expect(f).toBeNull();
  });

  it("[CYCLE] prefilters, deep-extracts movers, emits + logs a signal, and increments the daily counter", async () => {
    const store = freshStore();
    const r = await runMoonshotCycle({
      universe: ["WIFUSDT", "DEADUSDT", "BTCUSDT"],
      ctx: ctx({ getCandles1m: async (sym) => (sym === "BTCUSDT" ? [c(50_000, 1), c(50_050, 1)] : sym === "DEADUSDT" ? deadCandles : burstCandles) }),
      store,
      now: Date.UTC(2099, 0, 2, 12, 0, 0),
    });
    expect(r.scanned).toBe(2); // BTCUSDT skipped from scoring
    expect(r.prefiltered).toBe(1); // only WIF passes the prefilter (DEAD filtered out)
    expect(r.signals).toBe(1);
    expect(store.daily.tradesToday).toBe(1);
    expect(store.daily.trades50xPlusToday).toBe(1); // 50x
    const sig = store.log.find((e) => e.decision === "SIGNAL");
    expect(sig!.symbol).toBe("WIFUSDT");
    expect(sig!.finalLeverage).toBe(50); // capped by the default symbol max
  });

  it("[CYCLE] the daily trade cap stops further signals", async () => {
    const store = freshStore();
    store.rollDaily("2099-01-02");
    // pre-load the day at the cap
    for (let i = 0; i < 10; i++) store.recordSignalTaken(false, 50);
    const r = await runMoonshotCycle({
      universe: ["WIFUSDT"],
      ctx: ctx(),
      store,
      now: Date.UTC(2099, 0, 2, 12, 0, 0),
    });
    expect(r.signals).toBe(0); // gated by trades-today >= 10
  });

  it("[STORE] rolls the daily counters on a new UTC date", () => {
    const store = freshStore();
    store.rollDaily("2099-01-02");
    store.recordSignalTaken(true, 100);
    expect(store.daily.tradesToday).toBe(1);
    store.rollDaily("2099-01-03");
    expect(store.daily.tradesToday).toBe(0);
    expect(store.daily.trades100xToday).toBe(0);
  });
});

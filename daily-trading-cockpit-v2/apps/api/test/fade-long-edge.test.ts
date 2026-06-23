import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import {
  computeRSI,
  detectFadeLongEntry,
  detectFadeLongEntries,
  buildFadeLongAntiCrashSnapshot,
  resolveFadeLong,
  buildFadeLongReport,
  runFadeLongCycle,
  runFadeLongCycleGuarded,
  FadeLongStore,
  FADE_LONG_RSI_THRESHOLD,
  type FadeLongObservation,
} from "../src/lib/fade-long-edge.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkCandle(openTime: number, close: number, high?: number, low?: number): Candle {
  return { openTime, open: close, high: high ?? close, low: low ?? close, close, volume: 1 };
}

/** Build a closes series that rises (RSI high) then sells off hard so RSI dips below the threshold. */
function oversoldCloses(): number[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 20; i++) {
    p *= 1.005; // 20 rising bars → RSI well above 30
    closes.push(p);
  }
  for (let i = 0; i < 12; i++) {
    p *= 0.978; // sharp sell-off → RSI crosses below 30
    closes.push(p);
  }
  return closes;
}

describe("computeRSI", () => {
  it("returns null until the period is filled, then values in [0,100]", () => {
    const closes = oversoldCloses();
    const rsi = computeRSI(closes, 14);
    expect(rsi.slice(0, 14).every((v) => v === null)).toBe(true);
    for (let i = 14; i < rsi.length; i++) {
      expect(rsi[i]).not.toBeNull();
      expect(rsi[i] as number).toBeGreaterThanOrEqual(0);
      expect(rsi[i] as number).toBeLessThanOrEqual(100);
    }
  });

  it("drives RSI below the oversold threshold after a sharp sell-off", () => {
    const rsi = computeRSI(oversoldCloses(), 14);
    expect(Math.min(...(rsi.filter((v) => v !== null) as number[]))).toBeLessThan(FADE_LONG_RSI_THRESHOLD);
  });
});

describe("detectFadeLongEntry", () => {
  const closes = oversoldCloses();
  const rsi = computeRSI(closes, 14);
  // first index where RSI freshly crosses below the threshold
  const crossIdx = rsi.findIndex(
    (v, i) => v !== null && v < FADE_LONG_RSI_THRESHOLD && rsi[i - 1] !== null && (rsi[i - 1] as number) >= FADE_LONG_RSI_THRESHOLD,
  );
  const candles = closes.map((c, i) => mkCandle(1000 + i, c));

  it("has a fresh oversold cross to test against", () => {
    expect(crossIdx).toBeGreaterThan(14);
  });

  it("emits a fade-long observation on the fresh oversold cross bar", () => {
    const obs = detectFadeLongEntry("WLDUSDT", candles.slice(0, crossIdx + 1), 5_000);
    expect(obs).not.toBeNull();
    expect(obs!.symbol).toBe("WLDUSDT");
    expect(obs!.rsiAtEntry).toBeLessThan(FADE_LONG_RSI_THRESHOLD);
    expect(obs!.stopLoss).toBeLessThan(obs!.entryPrice);
    expect(obs!.takeProfit).toBeGreaterThan(obs!.entryPrice);
    expect(obs!.status).toBe("OPEN");
    expect(obs!.observationId).toContain("WLDUSDT");
  });

  it("returns null when the latest bar is not yet oversold", () => {
    expect(detectFadeLongEntry("WLDUSDT", candles.slice(0, crossIdx), 5_000)).toBeNull();
  });

  it("returns null when the prior bar was already oversold (no fresh cross)", () => {
    expect(detectFadeLongEntry("WLDUSDT", candles.slice(0, crossIdx + 2), 5_000)).toBeNull();
  });
});

describe("detectFadeLongEntries (lookback scanner — the cycle's detector)", () => {
  // rise → dip below 30 (cross #1) → recover above 30 → dip below 30 again (cross #2)
  function twoCrossCloses(): number[] {
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 20; i++) { p *= 1.005; closes.push(p); } // RSI high
    for (let i = 0; i < 12; i++) { p *= 0.975; closes.push(p); } // cross #1 (<30)
    for (let i = 0; i < 16; i++) { p *= 1.013; closes.push(p); } // recover (>30)
    for (let i = 0; i < 12; i++) { p *= 0.975; closes.push(p); } // cross #2 (<30)
    return closes;
  }

  it("[FLSCAN] catches EVERY fresh cross in the window, not just the latest bar", () => {
    const closes = twoCrossCloses();
    const candles = closes.map((c, i) => mkCandle(1000 + i * 900_000, c)); // 15m bars
    const rsi = computeRSI(closes, 14);
    let expected = 0;
    for (let i = 1; i < rsi.length; i++) {
      if (rsi[i] !== null && rsi[i - 1] !== null && (rsi[i - 1] as number) >= FADE_LONG_RSI_THRESHOLD && (rsi[i] as number) < FADE_LONG_RSI_THRESHOLD) expected++;
    }
    expect(expected).toBeGreaterThanOrEqual(2); // the series genuinely has multiple crosses

    const entries = detectFadeLongEntries("XUSDT", candles, candles.length);
    expect(entries.length).toBe(expected); // scanner finds ALL of them…
    // …each tagged to its own bar (distinct ids) with that bar's close as entry.
    expect(new Set(entries.map((e) => e.observationId)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.openedAtMs).toBeGreaterThan(0);
      expect(e.stopLoss).toBeLessThan(e.entryPrice);
      expect(e.rsiAtEntry).toBeLessThan(FADE_LONG_RSI_THRESHOLD);
    }
  });

  it("[FLSCAN] returns [] when no bar in the window is a fresh cross", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i); // strictly up → RSI ~100, never <30
    const candles = rising.map((c, i) => mkCandle(1000 + i * 900_000, c));
    expect(detectFadeLongEntries("XUSDT", candles, candles.length)).toEqual([]);
  });
});

describe("buildFadeLongAntiCrashSnapshot", () => {
  it("flags market-wide dump breadth as would-block measurement metadata", () => {
    const candlesBySymbol = new Map<string, Candle[]>();
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "WLDUSDT", "INJUSDT", "DOGEUSDT", "OPUSDT", "NEARUSDT"];
    for (const symbol of symbols) {
      candlesBySymbol.set(symbol, [100, 99.8, 99.5, 99.1, 98.7].map((close, i) => mkCandle(1000 + i * 900_000, close)));
    }

    const snapshot = buildFadeLongAntiCrashSnapshot({
      candlesBySymbol,
      atMs: 1000 + 4 * 900_000,
      freshSignalCluster: 7,
    });

    expect(snapshot.wouldBlock).toBe(true);
    expect(snapshot.down1hPct).toBe(100);
    expect(snapshot.median1hReturnPct).toBeLessThan(-0.5);
    expect(snapshot.reasons).toContain("MARKET_WIDE_1H_DUMP");
    expect(snapshot.reasons).toContain("BTC_ETH_BOTH_BREAKING_DOWN");
    expect(snapshot.reasons).toContain("OVERSOLD_SIGNAL_CLUSTER");
  });

  it("does not block when breadth sample is too small", () => {
    const candlesBySymbol = new Map<string, Candle[]>([
      ["BTCUSDT", [100, 99, 98, 97, 96].map((close, i) => mkCandle(1000 + i * 900_000, close))],
    ]);

    const snapshot = buildFadeLongAntiCrashSnapshot({
      candlesBySymbol,
      atMs: 1000 + 4 * 900_000,
      freshSignalCluster: 1,
    });

    expect(snapshot.wouldBlock).toBe(false);
    expect(snapshot.reasons).toContain("BREADTH_SAMPLE_TOO_SMALL");
  });
});

function openObs(): FadeLongObservation {
  const entry = 100;
  return {
    observationId: "fadelong:TST:1000",
    symbol: "TSTUSDT",
    rsiAtEntry: 25,
    entryPrice: entry,
    stopLoss: entry * (1 - 0.015), // 98.5, risk = 1.5
    takeProfit: entry * (1 + 0.0075), // 100.75, reward = 0.75 → 0.5R
    stopDistanceBps: 150,
    openedAt: new Date(1000).toISOString(),
    openedAtMs: 1000,
    status: "OPEN",
    grossR: null,
    netR: null,
    costR: null,
    resolvedAt: null,
  };
}

describe("resolveFadeLong", () => {
  it("closes a WIN when a forward bar tags the take-profit", () => {
    const patch = resolveFadeLong(openObs(), [mkCandle(2000, 100.8, 100.9, 99.9)], 9_999);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("CLOSED_WIN");
    expect(patch!.grossR).toBeCloseTo(0.5, 5);
    expect(patch!.netR! < patch!.grossR!).toBe(true); // cost deducted
  });

  it("closes a LOSS when a forward bar tags the stop", () => {
    const patch = resolveFadeLong(openObs(), [mkCandle(2000, 99, 99.2, 98.0)], 9_999);
    expect(patch!.status).toBe("CLOSED_LOSS");
    expect(patch!.grossR).toBe(-1);
    expect(patch!.netR! < -1).toBe(true); // extra stop-out slippage on losers
  });

  it("takes the stop first on an ambiguous same-bar (conservative)", () => {
    const patch = resolveFadeLong(openObs(), [mkCandle(2000, 100, 101, 98.0)], 9_999);
    expect(patch!.status).toBe("CLOSED_LOSS");
  });

  it("marks-to-market at max-hold when neither stop nor TP is hit", () => {
    const fwd: Candle[] = [];
    for (let k = 0; k < 8; k++) fwd.push(mkCandle(2000 + k, 100.3, 100.5, 99.6)); // never tags 100.75 / 98.5
    const patch = resolveFadeLong(openObs(), fwd, 9_999);
    expect(patch).not.toBeNull();
    expect(patch!.status).toBe("CLOSED_WIN"); // close 100.3 > entry → +0.2R gross
    expect(patch!.grossR).toBeCloseTo(0.2, 5);
  });

  it("stays OPEN (null) when not enough forward candles and not expired", () => {
    expect(resolveFadeLong(openObs(), [mkCandle(2000, 100.3, 100.5, 99.6)], 9_999)).toBeNull();
  });

  it("EXPIRES a stale OPEN past the expiry window", () => {
    const eightDays = 1000 + 8 * 24 * 60 * 60 * 1000;
    const patch = resolveFadeLong(openObs(), [], eightDays);
    expect(patch!.status).toBe("EXPIRED");
  });
});

describe("buildFadeLongReport", () => {
  it("aggregates freshValid / WR / PF / netAvgR and gates WATCHABLE on threshold", () => {
    const base = openObs();
    const obs: FadeLongObservation[] = [
      { ...base, observationId: "a", status: "CLOSED_WIN", grossR: 0.5, netR: 0.35, costR: 0.15 },
      { ...base, observationId: "b", status: "CLOSED_WIN", grossR: 0.5, netR: 0.35, costR: 0.15 },
      { ...base, observationId: "c", status: "CLOSED_LOSS", grossR: -1, netR: -1.23, costR: 0.23 },
      { ...base, observationId: "d", status: "OPEN" },
      { ...base, observationId: "e", status: "EXPIRED" },
    ];
    const r = buildFadeLongReport(obs);
    expect(r.freshValid).toBe(3);
    expect(r.open).toBe(1);
    expect(r.expired).toBe(1);
    expect(r.wr).toBeCloseTo(2 / 3, 5);
    expect(r.netAvgR).toBeCloseTo((0.35 + 0.35 - 1.23) / 3, 5);
    expect(r.pf).toBeCloseTo(0.7 / 1.23, 5);
    expect(r.status).toBe("COLLECTING"); // 3 < WATCHABLE threshold
    expect(r.antiCrash.tagged).toBe(0);
  });
});

describe("runFadeLongCycle", () => {
  it("records a fresh oversold entry, is idempotent, and persists across store reloads", async () => {
    // A symbol that just crossed oversold, plus 8 flat-up forward bars so it resolves next pass.
    const closes = oversoldCloses();
    const crossIdx = computeRSI(closes, 14).findIndex(
      (v, i) =>
        v !== null &&
        v < FADE_LONG_RSI_THRESHOLD &&
        computeRSI(closes, 14)[i - 1] !== null &&
        (computeRSI(closes, 14)[i - 1] as number) >= FADE_LONG_RSI_THRESHOLD,
    );
    const upToCross = closes.slice(0, crossIdx + 1);
    // Cycle 1: latest closed bar is the cross bar. The cycle drops the final bar as "in-progress",
    // so we append one extra bar to make the cross bar the last CLOSED one.
    const cycle1Candles = [...upToCross, upToCross[upToCross.length - 1]].map((c, i) => mkCandle(1000 + i * 60000, c));

    const file = join(tmpdir(), `fade-long-test-${process.pid}-${cycle1Candles.length}.json`);
    const store = new FadeLongStore(file);
    const r1 = await runFadeLongCycle({
      store,
      universe: ["WLDUSDT"],
      fetchCandles: async () => cycle1Candles,
      now: 1000 + 100 * 60000,
    });
    expect(r1.scanned).toBe(1);
    expect(r1.newEntries).toBe(1);
    expect(store.all.length).toBe(1);
    expect(store.all[0].status).toBe("OPEN");
    expect(store.all[0].antiCrash).toBeTruthy();
    expect(store.all[0].antiCrash?.wouldBlock).toBe(false);

    // Re-running the same candles must NOT create a duplicate observation.
    const r2 = await runFadeLongCycle({
      store,
      universe: ["WLDUSDT"],
      fetchCandles: async () => cycle1Candles,
      now: 1000 + 101 * 60000,
    });
    expect(r2.newEntries).toBe(0);
    expect(store.all.length).toBe(1);

    // Reload from disk → observation persisted.
    const reloaded = new FadeLongStore(file);
    expect(reloaded.all.length).toBe(1);
    expect(reloaded.all[0].symbol).toBe("WLDUSDT");
  });

  it("runs via the overlap-guarded wrapper and returns a result when free", async () => {
    const store = new FadeLongStore(join(tmpdir(), `fade-long-test-guard-${process.pid}.json`));
    const r = await runFadeLongCycleGuarded({
      store,
      universe: ["XXXUSDT"],
      fetchCandles: async () => [],
      now: 5_000,
    });
    expect(r).not.toBeNull();
    expect(r!.scanned).toBe(0);
  });

  it("skips symbols whose candle fetch throws without aborting the cycle", async () => {
    const store = new FadeLongStore(join(tmpdir(), `fade-long-test-err-${process.pid}.json`));
    const r = await runFadeLongCycle({
      store,
      universe: ["AAAUSDT", "BBBUSDT"],
      fetchCandles: async (s) => {
        if (s === "AAAUSDT") throw new Error("network");
        return [];
      },
      now: 5_000,
    });
    expect(r.scanned).toBe(0); // AAA threw, BBB returned empty
    expect(store.all.length).toBe(0);
  });
});

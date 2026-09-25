import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BinanceUsdMTestnetCooldownError,
  BinanceUsdMTestnetLaneSaturatedError,
  BinanceUsdMTestnetReadCoordinator,
  venueWeightPressure,
  weightPoolFor,
} from "../src/lib/binance-usdm-testnet-rate-limit.js";

const CROSS_KIND_GAP_FOR_TEST = 250;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-testnet-usdm-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("host-wide Testnet USD-M rate-limit coordinator", () => {
  it("paces from the venue's published weight allowance, not from a guessed request count", () => {
    const coordinator = new BinanceUsdMTestnetReadCoordinator({ directory: tempDir() });
    // Was 30_000 -- two reads a MINUTE host-wide, under 1% of Binance's 2400 weight/min per IP.
    // It could not run a 20-symbol strategy and the queue it created wedged the instance for hours.
    expect(coordinator.status().globalReadGapMs).toBe(1_000);
  });

  it("shares dispatch reservations between independently constructed clients", async () => {
    let now = 1_700_000_000_000;
    const directory = tempDir();
    const first = new BinanceUsdMTestnetReadCoordinator({ directory, globalReadGapMs: 250, nowMs: () => now });
    const second = new BinanceUsdMTestnetReadCoordinator({ directory, globalReadGapMs: 250, nowMs: () => now });

    await first.reserveReadDispatch();
    now += 250;
    await second.reserveReadDispatch();

    const status = first.status();
    expect(status.coordination).toBe("HOST_TESTNET_FILE_LEASE");
    expect(status.globalReadGapMs).toBe(250);
    expect(status.nextReadDispatchAt).toBe(new Date(now + 250).toISOString());
  });

  it("paces public candles and signed account reads independently while retaining a safe cross-kind gap", async () => {
    let now = 1_700_000_000_000;
    const coordinator = new BinanceUsdMTestnetReadCoordinator({ directory: tempDir(), globalReadGapMs: 250, nowMs: () => now });

    await coordinator.reserveReadDispatch("PUBLIC");
    // A signed account read may follow after the small cross-kind gap instead
    // of waiting for the full passive-candle cadence.
    now += 5_000;
    await coordinator.reserveReadDispatch("SIGNED");

    // The compatibility field is intentionally the conservative ceiling seen
    // by any older release still sharing this host state.
    expect(coordinator.status().nextReadDispatchAt).toBe(new Date(now + 250).toISOString());
  });

  it("attributes every reservation to its calling site, not only the unlucky 418 victim", async () => {
    // The 418 fields name whoever happened to be in flight when the venue
    // pushed back. On 2026-09-04 that pointed at a code path holding 0 pending
    // work while the real consumer of the lane stayed invisible, and the wrong
    // constant was blamed for hours. Count reservations per caller instead.
    let now = 1_700_000_000_000;
    const coordinator = new BinanceUsdMTestnetReadCoordinator({
      directory: tempDir(), globalReadGapMs: 250, nowMs: () => now,
    });

    await coordinator.reserveReadDispatch("PUBLIC", "/apps/api/src/lib/candle-sweep.ts:10:1");
    now += 250;
    await coordinator.reserveReadDispatch("PUBLIC", "/apps/api/src/lib/candle-sweep.ts:10:1");
    now += 250;
    await coordinator.reserveReadDispatch("SIGNED", "/apps/api/src/lib/reconciler.ts:20:2");
    now += 250;
    await coordinator.reserveReadDispatch("PUBLIC", null);

    expect(coordinator.reservationsByCaller()).toEqual({
      "PUBLIC /apps/api/src/lib/candle-sweep.ts:10:1": 2,
      "SIGNED /apps/api/src/lib/reconciler.ts:20:2": 1,
      "PUBLIC unattributed": 1,
    });
  });

  it("reports how far ahead the lease is already booked", async () => {
    // A caller waiting behind a queued read needs to tell legitimate pacing
    // apart from a stuck dispatch; a fixed ceiling cannot, and firing on
    // ordinary backlog made the starvation worse.
    let now = 1_700_000_000_000;
    const coordinator = new BinanceUsdMTestnetReadCoordinator({
      directory: tempDir(), globalReadGapMs: 30_000, nowMs: () => now,
    });
    expect(coordinator.bookedThroughMs()).toBe(now);

    await coordinator.reserveReadDispatch("PUBLIC", null);
    expect(coordinator.bookedThroughMs()).toBe(now + 30_000);
  });

  it("paces signed account truth faster than passive candles, without touching the public lane", async () => {
    // The 30s interval was sized for the bulky side. Signed traffic is ~1/min in practice, and
    // pacing it at 30s bought nothing from the venue while account reconciliation, the engine tick
    // and /api/live/account all queued behind it. Lower the DELAY, not the public request rate.
    let now = 1_700_000_000_000;
    const coordinator = new BinanceUsdMTestnetReadCoordinator({
      directory: tempDir(), globalReadGapMs: 30_000, signedReadGapMs: 10_000, nowMs: () => now,
    });
    expect(coordinator.status().globalReadGapMs).toBe(30_000);
    expect(coordinator.status().signedReadGapMs).toBe(10_000);

    await coordinator.reserveReadDispatch("SIGNED", null);
    // The signed lane reopens after its own shorter gap...
    expect(coordinator.bookedThroughMs()).toBe(now + 10_000);
    await coordinator.reserveReadDispatch("PUBLIC", null);
    // ...while a public reservation still books the full conservative interval.
    expect(coordinator.bookedThroughMs()).toBe(now + CROSS_KIND_GAP_FOR_TEST + 30_000);
  });

  it("never lets the signed lane be slower than the public one", async () => {
    const coordinator = new BinanceUsdMTestnetReadCoordinator({
      directory: tempDir(), globalReadGapMs: 5_000, signedReadGapMs: 60_000,
    });
    expect(coordinator.status().signedReadGapMs).toBe(5_000);
  });

  it("does not let a backlogged public lane dictate when a signed read may go", async () => {
    // 2026-09-04: with the public lane booked minutes out, every signed read was pushed past the
    // END of that queue by the cross-kind gap, so account truth, the engine tick and
    // /api/live/account all inherited the candle backlog. Signed dispatches were landing every
    // 4-5 minutes while signed DEMAND was about one a minute.
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;   // frozen: the lease books into the future, the clock does not
      const directory = tempDir();
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 30_000, signedReadGapMs: 10_000, nowMs: () => now,
      });

      // A genuine public backlog: eight queued candle reads book four minutes ahead.
      const backlog = Promise.all(
        Array.from({ length: 8 }, () => coordinator.reserveReadDispatch("PUBLIC", null)),
      );
      await vi.advanceTimersByTimeAsync(8 * 30_000);
      await backlog;
      expect(coordinator.bookedThroughMs() - now).toBeGreaterThan(3 * 60_000);

      // A signed read arriving now waits the LOCAL spacing only.
      const signed = coordinator.reserveReadDispatch("SIGNED", null);
      await vi.advanceTimersByTimeAsync(30_000);
      await signed;

      const state = JSON.parse(
        readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"),
      ) as { nextSignedReadDispatchAtMs: number };
      // Dispatched within one cross-kind gap of now, so its lane reopens at +5s +10s. Before this
      // fix the same call landed past the whole public queue, at roughly +250s.
      expect(state.nextSignedReadDispatchAtMs - now).toBeLessThanOrEqual(15_000);
      // The public lane keeps its own conservative booking — this decouples, it does not speed
      // candles up.
      expect(coordinator.bookedThroughMs() - now).toBeGreaterThan(3 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an exchange 418 cooldown to every Testnet worker", async () => {
    let now = 1_700_000_000_000;
    const directory = tempDir();
    const writer = new BinanceUsdMTestnetReadCoordinator({ directory, nowMs: () => now });
    const reader = new BinanceUsdMTestnetReadCoordinator({ directory, nowMs: () => now });
    const retryUntilMs = now + 120_000;

    await writer.registerRateLimit({
      status: 418,
      retryUntilMs,
      failure: "rate limited (HTTP 418)",
      endpoint: "/fapi/v2/balance",
    });

    await expect(reader.reserveReadDispatch()).rejects.toBeInstanceOf(BinanceUsdMTestnetCooldownError);
    expect(reader.status()).toMatchObject({
      coolingDown: true,
      retryAt: new Date(retryUntilMs).toISOString(),
      lastEndpoint: "/fapi/v2/balance",
    });

    now = retryUntilMs;
    await expect(reader.reserveReadDispatch()).resolves.toBeUndefined();
  });

  it("refuses a read once its lane is booked past the ceiling, rather than sleeping behind it", async () => {
    const now = 1_700_000_000_000;
    const directory = tempDir();
    const stateFile = join(directory, "usd-m-testnet-rate-limit.json");
    // The watermark measured on Testnet 2026-09-04: 1320s ahead of wall-clock. Every public read,
    // including the engine tick's and /api/live/account's, was scheduled 22 minutes out and simply
    // slept there. Nothing errored, so errorStreak stayed 0 while the instance was blind.
    const runawayWatermark = now + 1_320_000;
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      nextPublicReadDispatchAtMs: runawayWatermark,
      nextSignedReadDispatchAtMs: 0,
      lastReservedDispatchAtMs: 0,
      lastReservedRequestKind: null,
      cooldownUntilMs: 0,
      updatedAtMs: now,
    }));
    const coordinator = new BinanceUsdMTestnetReadCoordinator({ directory, nowMs: () => now });

    await expect(coordinator.reserveReadDispatch("PUBLIC", "probe"))
      .rejects.toBeInstanceOf(BinanceUsdMTestnetLaneSaturatedError);

    // A refused request must not book the slot it was denied, or the ceiling would feed the runaway.
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { nextPublicReadDispatchAtMs: number };
    expect(state.nextPublicReadDispatchAtMs).toBe(runawayWatermark);

    // The ceiling is per lane: signed account truth stays reachable while public is saturated.
    await expect(coordinator.reserveReadDispatch("SIGNED", "account")).resolves.toBeUndefined();
  });

  it("bounds the booking watermark so a burst cannot mortgage the next twenty minutes", async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const directory = tempDir();
      // Pin the gap: this test is about the ceiling, not about whatever the default happens to be.
      // At the shipped 1s default forty reads book only 40s ahead and never reach the ceiling.
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 30_000, nowMs: () => now,
      });

      let refused = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const reservation = coordinator.reserveReadDispatch("PUBLIC", `caller-${attempt}`)
          .catch((error) => {
            if (error instanceof BinanceUsdMTestnetLaneSaturatedError) refused += 1;
            else throw error;
          });
        await vi.advanceTimersByTimeAsync(400_000);
        await reservation;
      }

      expect(refused).toBeGreaterThan(0);
      // Ceiling plus at most the one slot the last admitted request booked. Without the ceiling
      // forty reads at a 30s gap leave the watermark 1200s ahead, and it never decays.
      expect(coordinator.bookedThroughMs() - now).toBeLessThanOrEqual(300_000 + 30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("venue weight governor", () => {
    const now = 1_700_000_000_000;

    it("leaves pacing alone when the venue has not reported recently", () => {
      // UNKNOWN must not licence a burst, but must not throttle forever after a quiet spell either.
      expect(venueWeightPressure(null, 0, now)).toMatchObject({ band: "UNKNOWN", gapMultiplier: 1 });
      expect(venueWeightPressure(2_300, now - 120_000, now)).toMatchObject({
        band: "UNKNOWN",
        gapMultiplier: 1,
        notBeforeMs: 0,
      });
    });

    it("widens pacing past the soft limit and sits out the minute past the hard limit", () => {
      expect(venueWeightPressure(300, now, now)).toMatchObject({ band: "CLEAR", gapMultiplier: 1 });
      expect(venueWeightPressure(1_500, now, now)).toMatchObject({ band: "SOFT", gapMultiplier: 4, notBeforeMs: 0 });
      const hard = venueWeightPressure(2_000, now, now);
      expect(hard.band).toBe("HARD");
      // Binance resets the counter on the minute boundary, so slowing down inside a minute that is
      // already spent achieves nothing -- wait for the next one to start.
      expect(hard.notBeforeMs).toBe(1_700_000_040_000);
    });

    it("applies the venue's reading to the lane it actually paces", async () => {
      const directory = tempDir();
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 1_000, signedReadGapMs: 500, nowMs: () => now,
      });

      await coordinator.recordVenueWeight("PUBLIC", 1_500, now);
      expect(coordinator.venueWeightPressure("PUBLIC")).toMatchObject({ band: "SOFT", usedWeight1m: 1_500 });
      expect(coordinator.status()).toMatchObject({ venueUsedWeight1m: 1_500, venueWeightBand: "SOFT" });

      await coordinator.reserveReadDispatch("PUBLIC", "governed", "PUBLIC");
      const state = JSON.parse(
        readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"),
      ) as { nextPublicReadDispatchAtMs: number };
      // 1000ms base widened 4x by the venue's own accounting, not by a constant chosen here.
      expect(state.nextPublicReadDispatchAtMs - now).toBe(4_000);
    });


    it("keeps klines pressure off the pool that carries account truth", async () => {
      const directory = tempDir();
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 1_000, signedReadGapMs: 500, nowMs: () => now,
      });

      // Measured on testnet: one klines call reports ~294 while the very next request reports 2.
      // The two numbers are different counters; conflating them throttled account reads on candle
      // pressure, which is how a 5-requests-a-minute instance ended up pacing like a saturated one.
      await coordinator.recordVenueWeight("MARKET_DATA", 2_000, now);
      expect(coordinator.venueWeightPressure("MARKET_DATA").band).toBe("HARD");
      expect(coordinator.venueWeightPressure("PUBLIC").band).toBe("UNKNOWN");

      await coordinator.reserveReadDispatch("SIGNED", "account", "SIGNED");
      const state = JSON.parse(
        readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"),
      ) as { nextSignedReadDispatchAtMs: number };
      // Unthrottled: the signed lane's own 500ms, not klines' 8x hard-band multiplier.
      expect(state.nextSignedReadDispatchAtMs - now).toBe(500);
    });

    it("routes each request to the counter that actually meters it", () => {
      // Unsigned market data and unsigned general data are both IP-scoped but metered separately;
      // anything carrying X-MBX-APIKEY is metered against the ACCOUNT instead.
      expect(weightPoolFor("PUBLIC", "/fapi/v1/klines")).toBe("MARKET_DATA");
      expect(weightPoolFor("PUBLIC", "/fapi/v1/klines?symbol=BTCUSDT&limit=500")).toBe("MARKET_DATA");
      expect(weightPoolFor("PUBLIC", "/fapi/v1/depth")).toBe("MARKET_DATA");
      expect(weightPoolFor("PUBLIC", "/fapi/v1/premiumIndex")).toBe("PUBLIC");
      expect(weightPoolFor("SIGNED", "/fapi/v2/account")).toBe("SIGNED");
      expect(weightPoolFor("SIGNED", "/fapi/v2/positionRisk")).toBe("SIGNED");
      // Same path, different metering, purely because one is signed.
      expect(weightPoolFor("SIGNED", "/fapi/v1/klines")).toBe("SIGNED");
    });

    it("paces signed pressure even when the unsigned pool is empty, surviving coordinator restart", async () => {
      vi.useFakeTimers();
      try {
      const directory = tempDir();
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 1_000, signedReadGapMs: 1_000, nowMs: () => now,
      });
      // A number that would be deep in HARD on an IP-scoped counter.
      await coordinator.recordVenueWeight("SIGNED", 3_376, now);
      const restarted = new BinanceUsdMTestnetReadCoordinator({ directory, globalReadGapMs: 1_000, nowMs: () => now });
      let dispatched = false;
      const reservation = restarted.reserveReadDispatch("SIGNED", "account", "SIGNED").then(() => { dispatched = true; });
      const untilNextMinute = Math.floor(now / 60_000) * 60_000 + 60_000 - now;
      await vi.advanceTimersByTimeAsync(untilNextMinute - 1);
      expect(dispatched).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await reservation;
      const state = JSON.parse(
        readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"),
      ) as { nextSignedReadDispatchAtMs: number };
      expect(state.nextSignedReadDispatchAtMs - now).toBe(untilNextMinute + 8_000);
      expect(coordinator.status().venueUsedWeightSigned).toBe(3_376);
      } finally { vi.useRealTimers(); }
    });

    it("gives bulky market data a far wider slot than the cheap general pool", async () => {
      const directory = tempDir();
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory, globalReadGapMs: 1_000, nowMs: () => now,
      });
      await coordinator.reserveReadDispatch("PUBLIC", "candles", "MARKET_DATA");
      const state = JSON.parse(
        readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"),
      ) as { nextPublicReadDispatchAtMs: number };
      // At ~294 weight a call, the 1s general pacing would spend the whole allowance in seconds.
      expect(state.nextPublicReadDispatchAtMs - now).toBe(20_000);
    });

    it("never lets a stale reading from a slow response overwrite a newer one", async () => {
      const directory = tempDir();
      let clock = now;
      const coordinator = new BinanceUsdMTestnetReadCoordinator({ directory, nowMs: () => clock });
      await coordinator.recordVenueWeight("PUBLIC", 1_500, now);
      // A response that left earlier but landed later must not resurrect an older number.
      clock = now + 10_000;
      await coordinator.recordVenueWeight("PUBLIC", 200, now - 5_000);
      expect(coordinator.status().venueUsedWeight1m).toBe(1_500);
    });
  });
});

it('reports shared high water even after a cheap public response',async()=>{
 const now=1_700_000_000_000;const directory=mkdtempSync(join(tmpdir(),'shared-weight-status-'));
 try{
  const c=new BinanceUsdMTestnetReadCoordinator({directory,nowMs:()=>now});
  await c.recordDispatchResponse({method:'GET',endpoint:'/fapi/v2/positionRisk',requestCaller:'test',estimatedWeight:5,usedWeight1m:2876,httpStatus:200});
  await c.recordVenueWeight('PUBLIC',1,now);
  expect(c.status()).toMatchObject({venueUsedWeight1m:2876,venueWeightBand:'HARD',dispatchHighWater:{weight:2876}});
 }finally{rmSync(directory,{recursive:true,force:true});}
});

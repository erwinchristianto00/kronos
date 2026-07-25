/**
 * Regression tests for the real markPriceForSymbol producer that replaced app.ts's permanent
 * `markPriceForSymbol: () => ({ price: null, atMs: null })` stub in buildFourBrainDeps — item 3 of the
 * 3 permanent-null four-brain data gaps (see btc-atr-percentile-cache.test.ts for item 1 and
 * four-brain-best-lane-report.test.ts for item 2's identical shape of test).
 *
 * Four things are verified, matching this repo's fail-without/pass-with discipline:
 *  (a) extractMarkPrices — pure function correctness: mirrors the exact
 *      `Number.isFinite(p.markPrice) && p.markPrice > 0` field-access pattern already proven at
 *      cross-sectional-executor.ts's closeBasketsHittingProfitTarget and
 *      single-symbol-lane-executor.ts's monitorOpenPositions, and skips non-finite/zero/missing
 *      markPrice or empty symbol without throwing.
 *  (b) LiveMarkPriceCacheStore + refreshLiveMarkPriceCache — fail-open cache behavior: an unknown
 *      symbol returns {price:null, atMs:null}; a throwing/rejecting getPositions() never throws out of
 *      refresh and never fabricates a number; a successful refresh populates the cache; a later
 *      failing refresh keeps the previous good values untouched.
 *  (c) A populated cache value flows all the way through four-brain-live-gather-bindings.ts's
 *      `buildFourBrainGatherInput` as a genuinely-usable currentPrice for a position WITHIN
 *      FRESHNESS_TTL_MS.position, and is classified STALE/unusable (currentPrice -> null) OUTSIDE it —
 *      the exact consumer contract that was permanently broken (always null) before this fix.
 *  (d) refreshLiveMarkPriceCache's own error handling can never produce an unhandled rejection or a
 *      synchronous throw — a rejecting getPositions() promise resolves refreshLiveMarkPriceCache's
 *      own returned promise to `{ ok: false }` rather than propagating.
 *  (e) 2026-07-23 fix — atMs reflects the ACTUAL fetch time, not the time refresh happened to run: a
 *      `getPositions()` accessor whose `fetchedAtMs` is far in the past (simulating an already-resolved,
 *      reused `sharedGetPositions` promise from a prior 30s cache window) must stamp the cache with
 *      THAT older timestamp, never with "now".
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  extractMarkPrices,
  LiveMarkPriceCacheStore,
  refreshLiveMarkPriceCache,
  getLiveMarkPriceCacheStore,
  _resetLiveMarkPriceCacheStoreForTests,
  type LiveGetPositionsFn,
  type LivePositionsList,
} from "../src/lib/live-mark-price-cache.js";
import { FRESHNESS_TTL_MS } from "../src/lib/four-brain-live-gather.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";

const NOW = 1_800_000_000_000;

describe("extractMarkPrices — pure function", () => {
  it("extracts {symbol, price} for every position with a finite, positive markPrice", () => {
    const positions = [
      { symbol: "BTCUSDT", markPrice: 65000.5 },
      { symbol: "ETHUSDT", markPrice: 3200 },
    ];
    expect(extractMarkPrices(positions)).toEqual([
      { symbol: "BTCUSDT", price: 65000.5 },
      { symbol: "ETHUSDT", price: 3200 },
    ]);
  });

  it("skips a position with markPrice === 0 (no real mark reported), mirroring the exact `> 0` guard used at cross-sectional-executor.ts/single-symbol-lane-executor.ts", () => {
    const positions = [{ symbol: "SOLUSDT", markPrice: 0 }];
    expect(extractMarkPrices(positions)).toEqual([]);
  });

  it("skips non-finite markPrice (NaN, Infinity) without throwing", () => {
    const positions = [
      { symbol: "AAA", markPrice: NaN },
      { symbol: "BBB", markPrice: Infinity },
      { symbol: "CCC", markPrice: -Infinity },
    ];
    expect(extractMarkPrices(positions)).toEqual([]);
  });

  it("skips a negative markPrice", () => {
    expect(extractMarkPrices([{ symbol: "XYZ", markPrice: -100 }])).toEqual([]);
  });

  it("skips an empty/missing symbol", () => {
    // @ts-expect-error deliberately malformed input to prove fail-open behavior
    expect(extractMarkPrices([{ symbol: "", markPrice: 100 }, { markPrice: 200 }])).toEqual([]);
  });

  it("empty input ⇒ empty output, never throws", () => {
    expect(extractMarkPrices([])).toEqual([]);
  });

  it("mixed good/bad entries: only the good ones survive, in order", () => {
    const positions = [
      { symbol: "BTCUSDT", markPrice: 65000 },
      { symbol: "DEADUSDT", markPrice: 0 },
      { symbol: "ETHUSDT", markPrice: 3200 },
      { symbol: "BADUSDT", markPrice: NaN },
    ];
    expect(extractMarkPrices(positions)).toEqual([
      { symbol: "BTCUSDT", price: 65000 },
      { symbol: "ETHUSDT", price: 3200 },
    ]);
  });
});

describe("LiveMarkPriceCacheStore — fail-open cache", () => {
  let store: LiveMarkPriceCacheStore;

  beforeEach(() => {
    store = new LiveMarkPriceCacheStore();
  });

  it("starts empty: get() on any symbol returns {price:null, atMs:null}", () => {
    expect(store.get("BTCUSDT")).toEqual({ price: null, atMs: null });
  });

  it("set() then get() round-trips a valid reading", () => {
    store.set("BTCUSDT", 65000, NOW);
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
  });

  it("set() rejects a non-finite/non-positive price without throwing and without touching the store", () => {
    store.set("BTCUSDT", 65000, NOW);
    store.set("BTCUSDT", NaN, NOW + 1000);
    store.set("BTCUSDT", 0, NOW + 2000);
    store.set("BTCUSDT", -5, NOW + 3000);
    // still the original good value — a bad set() never overwrites with garbage
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
  });

  it("set() rejects a non-finite atMs without throwing", () => {
    store.set("BTCUSDT", 65000, NaN);
    expect(store.get("BTCUSDT")).toEqual({ price: null, atMs: null });
  });

  it("set() rejects an empty symbol without throwing", () => {
    expect(() => store.set("", 100, NOW)).not.toThrow();
    expect(store.get("")).toEqual({ price: null, atMs: null });
  });

  it("setAll() applies a batch of readings all stamped with the same atMs, skipping bad entries individually", () => {
    store.setAll(
      [
        { symbol: "BTCUSDT", price: 65000 },
        { symbol: "ETHUSDT", price: 3200 },
      ],
      NOW,
    );
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
    expect(store.get("ETHUSDT")).toEqual({ price: 3200, atMs: NOW });
    expect(store.get("SOLUSDT")).toEqual({ price: null, atMs: null }); // never populated ⇒ still empty
  });

  it("a symbol never present in any refresh stays permanently {price:null, atMs:null} (never fabricated)", () => {
    store.setAll([{ symbol: "BTCUSDT", price: 65000 }], NOW);
    expect(store.get("NEVERUSDT")).toEqual({ price: null, atMs: null });
  });

  it("singleton getter returns the same instance until reset", () => {
    _resetLiveMarkPriceCacheStoreForTests();
    const a = getLiveMarkPriceCacheStore();
    const b = getLiveMarkPriceCacheStore();
    expect(a).toBe(b);
    _resetLiveMarkPriceCacheStoreForTests();
    const c = getLiveMarkPriceCacheStore();
    expect(c).not.toBe(a);
  });
});

describe("refreshLiveMarkPriceCache — fail-open refresh + non-interference contract", () => {
  let store: LiveMarkPriceCacheStore;

  beforeEach(() => {
    store = new LiveMarkPriceCacheStore();
  });

  it("a successful getPositions() populates the cache from the resolved positions, filtered exactly like extractMarkPrices, stamped with fetchedAtMs", async () => {
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.resolve([
        { symbol: "BTCUSDT", markPrice: 65000 },
        { symbol: "ZEROUSDT", markPrice: 0 },
        { symbol: "ETHUSDT", markPrice: 3200 },
      ]),
      fetchedAtMs: NOW,
    });
    const res = await refreshLiveMarkPriceCache(store, getPositions);
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2);
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
    expect(store.get("ETHUSDT")).toEqual({ price: 3200, atMs: NOW });
    expect(store.get("ZEROUSDT")).toEqual({ price: null, atMs: null });
  });

  it("(e) [regression] stamps atMs with the ACTUAL fetch time (fetchedAtMs), not the time refresh happened to run — reproduces + closes the ~30s-hidden-staleness bug from reusing sharedGetPositions's already-resolved promise", async () => {
    // Simulates the steady-state race: this refresh cycle runs "now" (REFRESH_RUN_AT), but
    // sharedGetPositions's own 30s de-dup window means the promise it hands back actually resolves
    // to data fetched 28s earlier (REAL_FETCH_AT). The accessor honestly reports fetchedAtMs =
    // REAL_FETCH_AT — refreshLiveMarkPriceCache must use THAT, never Date.now()-at-call-time.
    const REAL_FETCH_AT = NOW;
    const REFRESH_RUN_AT = NOW + 28_000; // this refresh cycle's own wall-clock time, well after the fetch
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.resolve([{ symbol: "BTCUSDT", markPrice: 65000 }]),
      fetchedAtMs: REAL_FETCH_AT, // the age of the reused promise, NOT REFRESH_RUN_AT
    });
    const res = await refreshLiveMarkPriceCache(store, getPositions);
    expect(res.ok).toBe(true);
    // Before the fix, this stamped Date.now() (≈REFRESH_RUN_AT) — silently hiding 28s of real staleness.
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: REAL_FETCH_AT });
    expect(store.get("BTCUSDT").atMs).not.toBe(REFRESH_RUN_AT);
  });

  it("(d) a rejecting getPositions() promise never throws out of refresh and never produces an unhandled rejection — the returned promise resolves to {ok:false}", async () => {
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.reject(new Error("signed call failed: -1021 timestamp")),
      fetchedAtMs: NOW,
    });
    await expect(refreshLiveMarkPriceCache(store, getPositions)).resolves.toEqual({ ok: false, updated: 0 });
  });

  it("(d) a synchronously-throwing getPositions() function is still caught (never a synchronous throw out of refresh)", async () => {
    const getPositions: LiveGetPositionsFn = (() => {
      throw new Error("boom");
    }) as unknown as LiveGetPositionsFn;
    await expect(refreshLiveMarkPriceCache(store, getPositions)).resolves.toEqual({ ok: false, updated: 0 });
  });

  it("fail-open: a later failing refresh KEEPS the previously-cached good values untouched", async () => {
    const good: LiveGetPositionsFn = () => ({
      promise: Promise.resolve([{ symbol: "BTCUSDT", markPrice: 65000 }]),
      fetchedAtMs: NOW,
    });
    await refreshLiveMarkPriceCache(store, good);
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });

    const bad: LiveGetPositionsFn = () => ({
      promise: Promise.reject(new Error("transient blip")),
      fetchedAtMs: NOW + 25_000,
    });
    const res = await refreshLiveMarkPriceCache(store, bad);
    expect(res.ok).toBe(false);
    // unchanged — not re-stamped to the failed refresh's time, not cleared
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
  });

  it("a non-array resolved value fails open instead of throwing", async () => {
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.resolve(null) as unknown as Promise<LivePositionsList>,
      fetchedAtMs: NOW,
    });
    const res = await refreshLiveMarkPriceCache(store, getPositions);
    expect(res.ok).toBe(false);
    expect(res.updated).toBe(0);
  });

  it("non-interference: refreshLiveMarkPriceCache never mutates the getPositions accessor's underlying promise — calling it twice independently still returns two fully independent, unaffected settlements", async () => {
    let callCount = 0;
    const sharedPositions = [{ symbol: "BTCUSDT", markPrice: 65000 }];
    // Simulates app.ts's ensureCachedPositions()-backed accessor: a de-duped, cached {at, promise}
    // pair reused across callers within the same window.
    let cached: { at: number; promise: Promise<typeof sharedPositions> } | null = null;
    const sharedGetPositions: LiveGetPositionsFn = () => {
      callCount += 1;
      if (!cached) cached = { at: NOW, promise: Promise.resolve(sharedPositions) };
      return { promise: cached.promise, fetchedAtMs: cached.at };
    };

    // A second, independent "executor-like" caller of the exact same shared accessor.
    const otherCallerResult = await sharedGetPositions().promise;
    await refreshLiveMarkPriceCache(store, sharedGetPositions);

    // The other caller's already-resolved value is untouched by the refresh function's own read.
    expect(otherCallerResult).toEqual(sharedPositions);
    expect(store.get("BTCUSDT")).toEqual({ price: 65000, atMs: NOW });
    // sharedGetPositions's own de-dup contract (same promise reused) is unaffected — refresh calling
    // it does not force a second underlying fetch.
    expect(callCount).toBe(2); // one from otherCallerResult, one from refresh — both hit the same cached promise, no extra network call implied
  });
});

describe("(c) populated cache → four-brain gather input (end-to-end consumer contract)", () => {
  const edge = {
    lookup: (_r: string | null, _d: "LONG" | "SHORT") => ({ avgNetR: 0, n: 0 }),
    verdict: () => ({ decision: "ALLOW_PROVEN" }),
    hasPositiveLane: () => true,
  };

  function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
    return {
      instanceId: "3102",
      nowMs: NOW,
      axisScore: null, axisAtMs: null, axisSlopePerHour: null,
      btcAtrPercentile: null, atrAtMs: null,
      advancersPct: null, breadthAtMs: null,
      sentiment: null, sentimentAtMs: null,
      safetyEvents: [],
      regimeRaw: null, edgeMemory: edge,
      controllerBias: "UNKNOWN", convictionScore: null, allowsLong: true, allowsShort: true,
      bestLaneReportForDirection: () => null,
      crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
      openSignals: [], maxSignalAgeMs: 50 * 60_000, crowdingStateForSymbol: () => null,
      openPositions: [], markPriceForSymbol: () => ({ price: null, atMs: null }),
      cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
      killLatched: false, killReason: null,
      ...o,
    } as FourBrainBindingDeps;
  }

  const OPEN_POSITION = {
    paperOrderId: "po-1",
    laneId: "RC_LONG",
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    entryPrice: 64000,
    stopPrice: 63000,
    mfeR: 0.2,
    maeR: -0.1,
    createdAtMs: NOW - 3_600_000,
  };

  it("the OLD permanent stub ⇒ currentPrice/currentAtMs always null, unrealizedR null — reproduces the exact bug this fix closes", () => {
    const input = buildFourBrainGatherInput(
      baseDeps({ openPositions: [OPEN_POSITION], markPriceForSymbol: () => ({ price: null, atMs: null }) }),
    );
    const exit = input.exitCandidatesRaw[0]!;
    expect(exit.currentPrice).toBeNull();
    expect(exit.currentAtMs).toBeNull();
    expect(exit.unrealizedR).toBeNull();
  });

  it("a mark WITHIN FRESHNESS_TTL_MS.position flows through as a genuine, usable currentPrice + non-null unrealizedR", async () => {
    const store = new LiveMarkPriceCacheStore();
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.resolve([{ symbol: "BTCUSDT", markPrice: 64650 }]),
      fetchedAtMs: NOW - 1000, // 1s old, well inside the 60s TTL
    });
    await refreshLiveMarkPriceCache(store, getPositions);

    const deps = baseDeps({ openPositions: [OPEN_POSITION], markPriceForSymbol: (symbol) => store.get(symbol) });
    const input = buildFourBrainGatherInput(deps);
    const exit = input.exitCandidatesRaw[0]!;

    expect(exit.currentPrice).toBe(64650);
    expect(exit.currentAtMs).toBe(NOW - 1000);
    // unrealizedRFromPosition: LONG ⇒ (mark - entry) / |entry - stop| = (64650-64000)/1000 = 0.65R
    expect(exit.unrealizedR).toBeCloseTo(0.65, 10);
  });

  it("a mark OUTSIDE FRESHNESS_TTL_MS.position is classified STALE/unusable ⇒ currentPrice/currentAtMs null again, exactly like the permanent stub", async () => {
    const store = new LiveMarkPriceCacheStore();
    const staleAtMs = NOW - (FRESHNESS_TTL_MS.position + 5_000); // just past the 60s TTL
    const getPositions: LiveGetPositionsFn = () => ({
      promise: Promise.resolve([{ symbol: "BTCUSDT", markPrice: 64650 }]),
      fetchedAtMs: staleAtMs,
    });
    await refreshLiveMarkPriceCache(store, getPositions);

    const deps = baseDeps({ openPositions: [OPEN_POSITION], markPriceForSymbol: (symbol) => store.get(symbol) });
    const input = buildFourBrainGatherInput(deps);
    const exit = input.exitCandidatesRaw[0]!;

    expect(exit.currentPrice).toBeNull();
    expect(exit.currentAtMs).toBeNull();
    expect(exit.unrealizedR).toBeNull();
  });

  it("a FUTURE mark (atMs > nowMs + 60s tolerance) is also rejected as unusable, never used as fresh", async () => {
    const store = new LiveMarkPriceCacheStore();
    store.set("BTCUSDT", 64650, NOW + 120_000); // 2 minutes in the future
    const deps = baseDeps({ openPositions: [OPEN_POSITION], markPriceForSymbol: (symbol) => store.get(symbol) });
    const input = buildFourBrainGatherInput(deps);
    const exit = input.exitCandidatesRaw[0]!;
    expect(exit.currentPrice).toBeNull();
  });

  it("a symbol never populated in the cache (no matching live position) yields the same null/null the stub always gave", () => {
    const store = new LiveMarkPriceCacheStore();
    const deps = baseDeps({ openPositions: [OPEN_POSITION], markPriceForSymbol: (symbol) => store.get(symbol) });
    const input = buildFourBrainGatherInput(deps);
    const exit = input.exitCandidatesRaw[0]!;
    expect(exit.currentPrice).toBeNull();
    expect(exit.currentAtMs).toBeNull();
  });
});

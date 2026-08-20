import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { FuturesReferenceHealthTracker } from "../src/lib/futures-reference-health.js";
import { registerLiveRoutes } from "../src/routes/live.js";

describe("FuturesReferenceHealthTracker", () => {
  it("reports exact USD-M eligibility and source diagnostics without inventing a bare-spot alias", () => {
    let now = 1_000;
    const health = new FuturesReferenceHealthTracker({ nowMs: () => now });

    health.recordEligibility("1000PEPEUSDT", true);
    health.recordReferenceUsed({
      symbol: "1000PEPEUSDT",
      price: 0.0031,
      atMs: now,
      source: "USD_M_MARK_PRICE",
    });
    now += 1;
    health.recordEligibility("SOLUSDT", true);
    health.recordReferenceUsed({
      symbol: "SOLUSDT",
      price: 150,
      atMs: now,
      source: "USD_M_MARK_PRICE",
    });
    health.recordEligibility("PEPEUSDT", false, "not an active USD-M USDT perpetual in exchangeInfo");

    const snapshot = health.snapshot(["1000PEPEUSDT", "SOLUSDT", "PEPEUSDT"]);

    expect(snapshot.counters.usdMMarkUsed).toBe(2);
    expect(snapshot.counters.bookFallback).toBe(0);
    expect(snapshot.counters.positionRiskFallback).toBe(0);
    expect(snapshot.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: "1000PEPEUSDT",
        eligible: true,
        reference: "USD_M_MARK_PRICE",
        price: 0.0031,
        status: "HEALTHY",
      }),
      expect.objectContaining({
        symbol: "SOLUSDT",
        eligible: true,
        reference: "USD_M_MARK_PRICE",
        status: "HEALTHY",
      }),
      expect.objectContaining({
        symbol: "PEPEUSDT",
        eligible: false,
        reference: "NONE",
        status: "NOT_ELIGIBLE",
      }),
    ]));
  });

  it("counts cache miss/book fallback, stale rejection, scale guard and final fail-closed separately", () => {
    let now = 2_000;
    const health = new FuturesReferenceHealthTracker({ nowMs: () => now });

    health.recordCacheEvent({ type: "CACHE_MISS", symbol: "1000PEPEUSDT", atMs: now });
    health.recordReferenceUsed({
      symbol: "1000PEPEUSDT",
      price: 0.0032,
      atMs: now,
      source: "USD_M_BOOK_TICKER",
    });
    now += 20;
    health.recordCacheEvent({
      type: "STALE_CACHE_REJECTED",
      symbol: "SOLUSDT",
      atMs: now,
      ageMs: 10_020,
    });
    health.recordScaleGuardRejected("1000PEPEUSDT", "spot-scale source rejected");
    health.recordReferenceUnavailable("MISSINGUSDT", "no USD-M mark/book/positionRisk");
    health.recordMarkBookComparison("SOLUSDT", 100, 101);

    const snapshot = health.snapshot(["MISSINGUSDT"]);

    expect(snapshot.counters).toMatchObject({
      cacheMiss: 1,
      bookFallback: 1,
      staleCacheRejected: 1,
      scaleGuardRejected: 1,
      referenceUnavailable: 1,
      abnormalMarkBookDivergence: 1,
    });
    expect(snapshot.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
      "REFERENCE_UNAVAILABLE",
      "SCALE_ANOMALY",
      "MARK_BOOK_DIVERGENCE",
    ]));
    expect(snapshot.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "MISSINGUSDT", status: "UNAVAILABLE" }),
    ]));
  });
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("GET /api/live/futures-reference-health", () => {
  it("uses the bounded watch list and returns only the injected read-only USD-M report", async () => {
    const health = new FuturesReferenceHealthTracker();
    app = Fastify();
    await registerLiveRoutes(app, null, {
      probeFuturesReferenceHealth: async (symbols) => {
        expect(symbols).toEqual(["1000PEPEUSDT", "SOLUSDT", "PEPEUSDT"]);
        health.recordEligibility("1000PEPEUSDT", true);
        health.recordReferenceUsed({
          symbol: "1000PEPEUSDT",
          price: 0.0031,
          atMs: Date.now(),
          source: "USD_M_MARK_PRICE",
        });
        health.recordEligibility("SOLUSDT", true);
        health.recordReferenceUsed({
          symbol: "SOLUSDT",
          price: 150,
          atMs: Date.now(),
          source: "USD_M_MARK_PRICE",
        });
        health.recordEligibility("PEPEUSDT", false, "not an active USD-M USDT perpetual in exchangeInfo");
        return health.snapshot(symbols);
      },
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/live/futures-reference-health?symbols=1000pepeusdt,SOLUSDT,PEPEUSDT",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      sourceChain: ["USD_M_MARK_PRICE", "USD_M_BOOK_TICKER", "POSITION_RISK", "FAIL_CLOSED"],
      symbols: expect.arrayContaining([
        expect.objectContaining({ symbol: "1000PEPEUSDT", eligible: true, status: "HEALTHY" }),
        expect.objectContaining({ symbol: "SOLUSDT", eligible: true, status: "HEALTHY" }),
        expect.objectContaining({ symbol: "PEPEUSDT", eligible: false, status: "NOT_ELIGIBLE" }),
      ]),
    });
  });

  it("fails closed when no USD-M runtime health source is wired", async () => {
    app = Fastify();
    await registerLiveRoutes(app, null, {});
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/live/futures-reference-health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      enabled: false,
      sourceChain: ["USD_M_MARK_PRICE", "USD_M_BOOK_TICKER", "POSITION_RISK", "FAIL_CLOSED"],
    });
  });
});

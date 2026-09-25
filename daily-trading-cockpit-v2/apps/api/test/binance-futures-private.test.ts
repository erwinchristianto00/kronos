import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BinanceFuturesPrivateClient,
  BinanceFuturesPrivateError,
  BinanceReadDeadlineError,
  GET_HARD_DEADLINE_MS,
  GET_STALL_REPORT_MS,
  REQUEST_TIMEOUT_MS,
  TRANSPORT_SLOT_MAX_WAIT_MS,
  buildQueryString,
  resolveLiveBinanceBaseUrl,
  resolveLiveBinanceEnv,
  signQueryString,
} from "../src/lib/binance-futures-private.js";
import { BinanceUsdMTestnetReadCoordinator, TESTNET_DISPATCH_BUDGET_WAIT_MS } from "../src/lib/binance-usdm-testnet-rate-limit.js";
import { fillFromUserTrade } from "../src/lib/execution-fill-recorder.js";

describe("Astra Testnet-only context reads", () => {
  const now = 1_800_000_000_000;
  function setup(payload: unknown, env: "testnet" | "mainnet" = "testnet") {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(new URL(String(url)).pathname === "/fapi/v1/time"
        ? { serverTime: now } : payload), { status: 200 }));
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k", apiSecret: "s", env, fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => now, testReadDispatchGapMs: 0, testnetCoordinatorDir: null,
    });
    return { client, fetchImpl };
  }
  const batches = [
    { method: "getAstraTicker24h", path: "/fapi/v1/ticker/24hr",
      fields: ["priceChangePercent", "quoteVolume", "highPrice", "lowPrice", "lastPrice", "closeTime"] },
    { method: "getAstraPremiumIndexes", path: "/fapi/v1/premiumIndex",
      fields: ["markPrice", "indexPrice", "lastFundingRate", "nextFundingTime", "time"] },
  ] as const;

  for (const { method, path, fields } of batches) {
    it(`${method} reads one unsigned Testnet batch and preserves exact symbols`, async () => {
      const symbols = ["BTCUSDT", "1000PEPEUSDT", "TUSDT", "币安人生USDT"];
      const input = symbols.map(symbol => ({ symbol, ...Object.fromEntries(fields.map((key, i) => [key, String(i + 0.5)])) }));
      const { client, fetchImpl } = setup(input);
      expect(await client[method]()).toEqual(symbols.map(symbol => ({
        symbol, ...Object.fromEntries(fields.map((key, i) => [key, i + 0.5])),
      })));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe(`https://demo-fapi.binance.com${path}`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).has("X-MBX-APIKEY")).toBe(false);
    });

    it(`${method} maps every unavailable or malformed numeric field to null`, async () => {
      const invalid = [undefined, null, "", "  ", "NaN", "Infinity", "-Infinity", "1oops", "0x10", "1e999", true, false, [], [1], {}];
      const { client } = setup(invalid.map(value => ({
        symbol: "BTCUSDT", ...Object.fromEntries(fields.map(key => [key, value])),
      })));
      expect(await client[method]()).toEqual(invalid.map(() => ({
        symbol: "BTCUSDT", ...Object.fromEntries(fields.map(key => [key, null])),
      })));
    });

    it(`${method} retains verified zero and signed finite decimal numbers`, async () => {
      const values = [0, "0.0000", -0.0001, "-0.0001", " 2.5 ", "1e-4"];
      const { client } = setup(values.map(value => ({
        symbol: "BTCUSDT", ...Object.fromEntries(fields.map(key => [key, value])),
      })));
      expect(await client[method]()).toEqual(values.map(value => ({
        symbol: "BTCUSDT", ...Object.fromEntries(fields.map(key => [key, Number(value)])),
      })));
    });

    it(`${method} skips rows without symbol identity and accepts an empty batch`, async () => {
      const { client } = setup([null, [], 1, "BTCUSDT", {}, { symbol: 1 }, { symbol: "" }, { symbol: " " }, { symbol: "BTCUSDT" }]);
      expect(await client[method]()).toEqual([{ symbol: "BTCUSDT", ...Object.fromEntries(fields.map(key => [key, null])) }]);
      await expect(setup([]).client[method]()).resolves.toEqual([]);
    });

    it.each([null, {}, { symbol: "BTCUSDT" }])(`${method} rejects a non-array batch: %j`, async payload => {
      await expect(setup(payload).client[method]()).rejects.toMatchObject({ failureType: "invalid_response" });
    });
  }

  it.each(["getAstraTicker24h", "getAstraPremiumIndexes", "getAstraCommissionRate"] as const)(
    "%s refuses mainnet before any network or time-sync request", async method => {
      const { client, fetchImpl } = setup([], "mainnet");
      await expect(client[method]("BTCUSDT")).rejects.toThrow("TESTNET ONLY");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

  it.each(["BTCUSDT", "币安人生USDT"])("reads exact %s commission with signed GET and no mutation", async symbol => {
    const { client, fetchImpl } = setup({ symbol, makerCommissionRate: "0.0002", takerCommissionRate: "0.0004" });
    await expect(client.getAstraCommissionRate(symbol)).resolves.toEqual({ symbol, makerCommissionRate: 0.0002, takerCommissionRate: 0.0004 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [rawUrl, init] = fetchImpl.mock.calls[1];
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe("https://demo-fapi.binance.com/fapi/v1/commissionRate");
    expect(url.searchParams.get("symbol")).toBe(symbol);
    expect(url.searchParams.get("timestamp")).toBe(String(now));
    expect(url.searchParams.get("recvWindow")).toBe("5000");
    const signature = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    expect(signature).toBe(signQueryString(url.searchParams.toString(), "s"));
    expect(new Headers(init?.headers).get("X-MBX-APIKEY")).toBe("k");
    expect(fetchImpl.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("accepts numeric and string zero commission without inventing a fallback fee", async () => {
    const { client } = setup({ symbol: "BTCUSDT", makerCommissionRate: 0, takerCommissionRate: "0" });
    await expect(client.getAstraCommissionRate("BTCUSDT")).resolves.toEqual({ symbol: "BTCUSDT", makerCommissionRate: 0, takerCommissionRate: 0 });
  });

  it.each([null, [], {}, { makerCommissionRate: "0", takerCommissionRate: "0" },
    { symbol: "ETHUSDT", makerCommissionRate: "0", takerCommissionRate: "0" }])(
    "rejects missing or mismatched commission identity: %j", async payload => {
      await expect(setup(payload).client.getAstraCommissionRate("BTCUSDT")).rejects.toMatchObject({ failureType: "invalid_response" });
    });

  for (const field of ["makerCommissionRate", "takerCommissionRate"] as const) {
    it.each([undefined, null, "", " ", "NaN", "Infinity", "1oops", "0x10", true, [], {}, -0.0001, "-0.0001"])(
      `rejects invalid ${field}: %j`, async value => {
        const { client, fetchImpl } = setup({ symbol: "BTCUSDT", makerCommissionRate: "0.0002", takerCommissionRate: "0.0004", [field]: value });
        await expect(client.getAstraCommissionRate("BTCUSDT")).rejects.toMatchObject({ failureType: "invalid_response" });
        expect(fetchImpl).toHaveBeenCalledTimes(2); // time + one GET, no parsing retry/mutation
      });
  }

  it.each(["", " ", "BTC USDT"])("rejects invalid commission request symbol %j before dispatch", async symbol => {
    const { client, fetchImpl } = setup({});
    await expect(client.getAstraCommissionRate(symbol)).rejects.toMatchObject({ failureType: "invalid_response" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serializes concurrent Astra batches and commission reads through the existing transport", async () => {
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async (rawUrl: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === "/fapi/v1/ticker/24hr") await gate;
      return new Response(JSON.stringify(path === "/fapi/v1/time" ? { serverTime: now }
        : path === "/fapi/v1/commissionRate" ? { symbol: "BTCUSDT", makerCommissionRate: "0", takerCommissionRate: "0" } : []));
    });
    const client = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: "k", apiSecret: "s", nowMs: () => now,
      fetchImpl: fetchImpl as typeof fetch, testReadDispatchGapMs: 0, testnetCoordinatorDir: null });
    const ticker = client.getAstraTicker24h();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const remaining = Promise.all([client.getAstraPremiumIndexes(), client.getAstraCommissionRate("BTCUSDT")]);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { release(); }
    await ticker; await remaining;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});

describe("binance-futures-private signing", () => {
  it("uses no /time probe for an explicitly read-only local-clock fingerprint", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/fapi/v2/positionRisk")) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected URL ${value}`);
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
      nowMs: () => 1_700_000_000_000,
      testReadDispatchGapMs: 0,
      testnetCoordinatorDir: null,
    });

    await expect(client.getPositions(undefined, { allowUnsyncedRead: true })).resolves.toEqual([]);
    expect(urls.filter((url) => url.includes("/fapi/v1/time"))).toHaveLength(0);
    expect(urls.filter((url) => url.includes("/fapi/v2/positionRisk"))).toHaveLength(1);
  });

  it("measures Testnet server time at network dispatch rather than before a host queue wait", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-time-dispatch-"));
    const baseMs = 1_700_000_000_000;
    try {
      vi.useFakeTimers();
      vi.setSystemTime(baseMs);
      const coordinator = new BinanceUsdMTestnetReadCoordinator({
        directory,
        globalReadGapMs: 10_000,
        nowMs: () => Date.now(),
      });
      // Reserve a slot owned by another Testnet worker. The client below must
      // wait ten seconds before its /time call, but that queue duration is not
      // host clock skew.
      await coordinator.reserveReadDispatch();
      const urls: string[] = [];
      const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/fapi/v1/time")) {
          return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
        }
        if (value.includes("/fapi/v2/positionRisk")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`unexpected URL ${value}`);
      }) as typeof fetch;
      const client = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        fetchImpl,
        nowMs: () => Date.now(),
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 10_000,
      });

      const pending = client.getPositions();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual([]);
      expect(client.getClockSkewMs()).toBeLessThanOrEqual(1);
      expect(urls.filter((url) => url.includes("/fapi/v1/time"))).toHaveLength(1);
      expect(urls.filter((url) => url.includes("/fapi/v2/positionRisk"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cannot be frozen forever by a queue head whose dispatch ignores its abort", async () => {
    // 2026-09-04, second failure on the same day: splitting the host lane per
    // request kind was necessary but not sufficient. The shared transport queue
    // underneath it jammed on a dispatch that never settled, so /api/live/account
    // stopped answering again (HTTP 000 at 100s) with zero established
    // connections, errorStreak:0 and lastTickError:null. Both queues in this
    // client are promise chains released only by their own slot, so neither may
    // be waited on without a bound.
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-queue-head-"));
    const baseMs = 1_700_000_000_000;
    try {
      vi.useFakeTimers();
      vi.setSystemTime(baseMs);
      const urls: string[] = [];
      let pinned = false;
      const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
        urls.push(String(url));
        if (!pinned) {
          pinned = true;
          // Never settles, and never honours the abort signal.
          return new Promise<Response>(() => {});
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const client = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        fetchImpl,
        nowMs: () => Date.now(),
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 1_000,
      });

      const stuck = client.getKlines("SOLUSDT", "1m", { limit: 2 });
      stuck.catch(() => { /* intentionally never settles */ });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(urls).toHaveLength(1);

      // Same lane as the pinned head, so it waits out BOTH bounds in sequence:
      // the host read lane first, then the transport queue underneath it. The
      // lane bound tracks what the lease has booked (here: one 1s slot ahead)
      // plus one more slot plus the transport ceiling, so it scales with a real
      // backlog instead of firing on one.
      // klines is metered on testnet's MARKET_DATA counter (~294 weight a call), so it books that
      // pool's 20s slot rather than the 1s general one -- the lane bound tracks what the lease has
      // actually booked, so it scales with that, not with a constant.
      const hostLaneBoundMs = 20_000 + 1_000 + TRANSPORT_SLOT_MAX_WAIT_MS;
      const rescued = client.getKlines("ETHUSDT", "1m", { limit: 2 });
      await vi.advanceTimersByTimeAsync(hostLaneBoundMs + TRANSPORT_SLOT_MAX_WAIT_MS + 2 * TESTNET_DISPATCH_BUDGET_WAIT_MS + 5_000);
      await expect(rescued).resolves.toEqual([]);
      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain("symbol=ETHUSDT");
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not queue a signed account read behind a passive Testnet candle backlog", async () => {
    // 2026-09-04: one shared process-local FIFO in front of the host lease made
    // this impossible. Each queued candle read held that single queue for its
    // whole 30s host slot, so a signed account read entering behind a passive
    // sweep never reached the coordinator at all: /api/live/account stopped
    // answering and the live engine went 108 minutes without a tick while still
    // reporting errorStreak:0. The coordinator's per-kind lanes were correct all
    // along, merely unreachable. Pin that the lanes are independent in practice.
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-per-kind-fifo-"));
    const baseMs = 1_700_000_000_000;
    try {
      vi.useFakeTimers();
      vi.setSystemTime(baseMs);
      const dispatched: Array<"PUBLIC" | "SIGNED"> = [];
      const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
        const value = String(url);
        if (value.includes("/fapi/v1/klines")) {
          dispatched.push("PUBLIC");
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (value.includes("/fapi/v2/positionRisk")) {
          dispatched.push("SIGNED");
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`unexpected URL ${value}`);
      }) as typeof fetch;
      const client = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        fetchImpl,
        nowMs: () => Date.now(),
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 30_000,
      });

      // A passive candle sweep claims the public lane first, exactly as the
      // daily-range lane does in production.
      const candles = Array.from({ length: 5 }, (_unused, index) =>
        client.getKlines(`SYM${index}USDT`, "1m", { limit: 2 }));
      // allowUnsyncedRead keeps this to the single signed GET under test.
      const positions = client.getPositions(undefined, { allowUnsyncedRead: true });

      // Far less than the five host slots the candle sweep needs to drain.
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(positions).resolves.toEqual([]);
      expect(dispatched).toContain("SIGNED");
      // The account read overtook a backlog that is still draining. Under one
      // shared queue it was strictly last, and in production never arrived.
      expect(dispatched.filter((kind) => kind === "PUBLIC").length).toBeLessThan(5);

      // The candle lane itself is still paced one read per host slot.
      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.all(candles);
      expect(dispatched.filter((kind) => kind === "PUBLIC")).toHaveLength(5);
      expect(dispatched[dispatched.length - 1]).toBe("PUBLIC");
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a Testnet public-candle 418 and blocks a fresh client before any later probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-public-cooldown-"));
    const nowMs = 1_700_000_000_000;
    try {
      const firstFetch = vi.fn(async () => new Response(JSON.stringify({
        code: -1003,
        msg: "IP banned until " + String(nowMs + 60_000),
      }), { status: 418 })) as typeof fetch;
      const first = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        nowMs: () => nowMs,
        fetchImpl: firstFetch,
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 250,
      });

      await expect(first.getKlines("SOLUSDT", "1m", { limit: 2 })).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
      expect(first.getRateLimitStatus()).toMatchObject({
        coolingDown: true,
        coordination: "HOST_TESTNET_FILE_LEASE",
        lastEndpoint: "/fapi/v1/klines",
        lastRequestKind: "PUBLIC",
      });

      const afterRestartFetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;
      const afterRestart = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        nowMs: () => nowMs,
        fetchImpl: afterRestartFetch,
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 250,
      });

      await expect(afterRestart.getKlines("SOLUSDT", "1m", { limit: 2 })).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
      await expect(afterRestart.getPositions()).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
      expect(afterRestartFetch).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a Testnet 418 across a fresh client and sends no probe during that inherited cooldown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-cooldown-"));
    const nowMs = 1_700_000_000_000;
    try {
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);
      const firstFetch = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/fapi/v1/time")) {
          return new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 });
        }
        return new Response(JSON.stringify({
          code: -1003,
          msg: "IP banned until " + String(nowMs + 60_000),
        }), { status: 418 });
      }) as typeof fetch;
      const first = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        nowMs: () => Date.now(),
        fetchImpl: firstFetch,
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 250,
      });

      const rejected = expect(first.getPositions()).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(first.getRateLimitStatus()).toMatchObject({
        coolingDown: true,
        coordination: "HOST_TESTNET_FILE_LEASE",
        lastEndpoint: "/fapi/v2/positionRisk",
        lastRequestKind: "SIGNED",
      });

      const inheritedFetch = vi.fn(async () => new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 })) as typeof fetch;
      const afterRestart = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        nowMs: () => nowMs,
        fetchImpl: inheritedFetch,
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 250,
      });

      await expect(afterRestart.getPositions()).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
      expect(inheritedFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the transport timeout armed until a response body is consumed", async () => {
    vi.useFakeTimers();
    try {
      const nowMs = 1_700_000_000_000;
      let bodyAbortObserved = false;
      const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/fapi/v1/time")) {
          return new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 });
        }
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              bodyAbortObserved = true;
              reject(Object.assign(new Error("response body aborted"), { name: "AbortError" }));
            }, { once: true });
          }),
        } as Response;
      }) as typeof fetch;
      const client = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        nowMs: () => nowMs,
        fetchImpl,
      });

      const placing = client.setLeverage("BTCUSDT", 3);
      const rejected = expect(placing).rejects.toMatchObject({ failureType: "timeout" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

      await rejected;
      expect(bodyAbortObserved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs the official Binance documentation HMAC vector", () => {
    // Vector from Binance API docs (signed endpoint example).
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const query =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(signQueryString(query, secret)).toBe(
      "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
    );
  });

  it("buildQueryString preserves insertion order, url-encodes, and drops undefined", () => {
    expect(
      buildQueryString({ symbol: "BTCUSDT", side: "BUY", price: undefined, qty: 1.5, flag: true }),
    ).toBe("symbol=BTCUSDT&side=BUY&qty=1.5&flag=true");
  });

  it("resolves env names and base urls (testnet never mainnet)", () => {
    expect(resolveLiveBinanceEnv("testnet")).toBe("testnet");
    expect(resolveLiveBinanceEnv("mainnet")).toBe("mainnet");
    expect(resolveLiveBinanceEnv("prod")).toBeNull();
    expect(resolveLiveBinanceEnv(undefined)).toBeNull();
    expect(resolveLiveBinanceBaseUrl("testnet")).toContain("demo-fapi.binance.com");
    expect(resolveLiveBinanceBaseUrl("mainnet")).toContain("fapi.binance.com");
  });

  it("reads the public book ticker from the same selected execution base", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        bidPrice: "64100.5",
        askPrice: "64101.0",
        bidQty: "2.5",
        askQty: "3.5",
        time: 1_700_000_000_000,
      }), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
    });
    const book = await client.getBookTicker("BTCUSDT");
    expect(book.bid).toBe(64100.5);
    expect(book.ask).toBe(64101);
    expect(urls[0]).toContain("demo-fapi.binance.com/fapi/v1/ticker/bookTicker");
  });

  it("reads requested execution books from one same-venue batch response", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify([
        { symbol: "SOLUSDT", bidPrice: "99.9", askPrice: "100.1", bidQty: "12", askQty: "13" },
        { symbol: "DOGEUSDT", bidPrice: "0.099", askPrice: "0.101", bidQty: "1200", askQty: "1300" },
        { symbol: "UNRELATEDUSDT", bidPrice: "1", askPrice: "1.1", bidQty: "1", askQty: "1" },
      ]), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
    });

    const books = await client.getExecutionBookTickers(["solusdt", "DOGEUSDT", "MISSINGUSDT"]);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("demo-fapi.binance.com/fapi/v1/ticker/bookTicker");
    expect(urls[0]).not.toContain("symbol=");
    expect([...books.keys()]).toEqual(["SOLUSDT", "DOGEUSDT"]);
    expect(books.get("SOLUSDT")).toMatchObject({ bid: 99.9, ask: 100.1, bidQty: 12, askQty: 13 });
  });

  it("reads the public premium-index mark from the same selected execution base", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ symbol: "1000PEPEUSDT", markPrice: "0.00319802" }), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
    });

    await expect(client.getMarkPrice("1000PEPEUSDT")).resolves.toBeCloseTo(0.00319802, 10);
    expect(urls[0]).toContain("demo-fapi.binance.com/fapi/v1/premiumIndex?symbol=1000PEPEUSDT");
  });

  it("reads completed USD-M klines from the selected execution base without a spot fallback", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify([[
        1_700_000_000_000, "100", "103", "99", "102", "12.5", 1_700_000_299_999,
      ]]), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const rows = await client.getKlines("SOLUSDT", "5m", { startTime: 1_700_000_000_000, limit: 1 });
    expect(rows).toEqual([{
      openTime: 1_700_000_000_000, closeTime: 1_700_000_299_999,
      open: 100, high: 103, low: 99, close: 102, volume: 12.5,
    }]);
    expect(urls[0]).toContain("demo-fapi.binance.com/fapi/v1/klines?symbol=SOLUSDT&interval=5m");
  });

  it("does not amplify an HTTP 418 IP ban with immediate signed GET retries", async () => {
    const urls: string[] = [];
    const nowMs = 1_700_000_000_000;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), { status: 418 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "mainnet",
      fetchImpl,
      nowMs: () => nowMs,
    });

    await expect(client.getBalances()).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
    expect(urls.filter((url) => url.includes("/fapi/v2/balance"))).toHaveLength(1);
  });

  it("opens one client-wide 418 circuit, coalesces cold-start time sync, and resumes only after its expiry", async () => {
    const urls: string[] = [];
    let nowMs = 1_700_000_000_000;
    const bannedUntilMs = nowMs + 5 * 60_000;
    let balanceAttempts = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 });
      }
      if (value.includes("/fapi/v2/balance")) {
        balanceAttempts += 1;
        return new Response(JSON.stringify({ code: -1003, msg: `Way too much request weight used; IP banned until ${bannedUntilMs}.` }), { status: 418 });
      }
      if (value.includes("/fapi/v2/positionRisk")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (value.includes("/fapi/v1/openOrders")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected URL ${value}`);
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "mainnet",
      fetchImpl,
      nowMs: () => nowMs,
    });

    // All three signed reads start from a cold clock. They share one /time request and the
    // transport queues the remaining physical dispatches behind the balance response.
    const [balance, positions, openOrders] = await Promise.allSettled([
      client.getBalances(),
      client.getPositions(),
      client.getOpenOrders(),
    ]);
    expect(balance.status).toBe("rejected");
    expect(positions.status).toBe("rejected");
    expect(openOrders.status).toBe("rejected");
    expect(balanceAttempts).toBe(1);
    expect(urls.filter((url) => url.includes("/fapi/v1/time"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("/fapi/v2/positionRisk"))).toHaveLength(0);
    expect(urls.filter((url) => url.includes("/fapi/v1/openOrders"))).toHaveLength(0);
    expect(client.getRateLimitStatus()).toMatchObject({
      coolingDown: true,
      lastHttpStatus: 418,
      retryAt: new Date(bannedUntilMs).toISOString(),
    });

    // The client must not probe Binance during the ban, even for a different endpoint.
    await expect(client.getPositions()).rejects.toMatchObject({ failureType: "429", httpStatus: 418 });
    expect(urls.filter((url) => url.includes("/fapi/v2/positionRisk"))).toHaveLength(0);

    nowMs = bannedUntilMs;
    await expect(client.getPositions()).resolves.toEqual([]);
    expect(urls.filter((url) => url.includes("/fapi/v2/positionRisk"))).toHaveLength(1);
    expect(client.getRateLimitStatus().coolingDown).toBe(false);
  });

  it("accepts only actively trading USD-M perpetual filters", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain("/fapi/v1/exchangeInfo");
      return new Response(JSON.stringify({
        symbols: [
          {
            symbol: "1000PEPEUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT",
            pricePrecision: 7, quantityPrecision: 0,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.0000001" },
              { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          },
          {
            symbol: "SOLUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT",
            pricePrecision: 2, quantityPrecision: 2,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          },
          {
            symbol: "SPOTONLYUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "BUSD",
            filters: [],
          },
          {
            symbol: "DELISTEDUSDT", status: "SETTLING", contractType: "PERPETUAL", quoteAsset: "USDT",
            filters: [],
          },
          {
            symbol: "DELIVERYUSDT", status: "TRADING", contractType: "CURRENT_MONTH", quoteAsset: "USDT",
            filters: [],
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "mainnet", fetchImpl });

    const filters = await client.getExchangeFilters();

    expect([...filters.keys()]).toEqual(["1000PEPEUSDT", "SOLUSDT"]);
    expect(filters.get("1000PEPEUSDT")).toMatchObject({ stepSize: 1, minQty: 1, minNotional: 5 });
  });

  it("refuses signed requests when measured clock skew exceeds the guard", async () => {
    // Fake fetch: /fapi/v1/time replies with a server time 10s ahead of local.
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() + 10_000 }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
    });

    await expect(client.getBalances()).rejects.toMatchObject({
      name: "BinanceFuturesPrivateError",
      failureType: "clock_skew",
    });
    expect(client.getClockSkewMs()).toBeGreaterThan(1_000);
  });

  it("preserves full precision on Binance order/algo IDs that exceed Number.MAX_SAFE_INTEGER", async () => {
    // Real observed live order id (19 digits) — native JSON.parse silently rounds this, which is
    // exactly the bug that made queryOrder(symbol, orderId) fail with -2013 "order does not exist"
    // for 2 real ETHUSDT positions (the rounded id no longer matched Binance's true internal id).
    const bigOrderId = "8389766229891298477";
    const bigAlgoId = "8389766229916336219";
    const rawOrderBody = `{"symbol":"ETHUSDT","orderId":${bigOrderId},"clientOrderId":"c","status":"FILLED","type":"MARKET","side":"BUY","reduceOnly":false,"price":"0","stopPrice":"0","origQty":"1","executedQty":"1","avgPrice":"1750.5","updateTime":1}`;
    const rawAlgoBody = `{"symbol":"ETHUSDT","algoId":${bigAlgoId},"clientAlgoId":"a","algoStatus":"NEW","orderType":"STOP_MARKET","side":"SELL","quantity":"1","triggerPrice":"1700","actualOrderId":${bigOrderId}}`;

    // Sanity check: confirm native JSON.parse actually DOES lose precision on this input — proves
    // the regex guard is solving a real problem, not a hypothetical one.
    expect(String(JSON.parse(rawOrderBody).orderId)).not.toBe(bigOrderId);

    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      if (u.includes("/fapi/v1/algoOrder")) {
        return new Response(rawAlgoBody, { status: 200 });
      }
      return new Response(rawOrderBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const order = await client.queryOrder("ETHUSDT", bigOrderId);
    expect(order.orderId).toBe(bigOrderId);

    const algo = await client.queryAlgoOrder(bigAlgoId);
    expect(algo.algoId).toBe(bigAlgoId);
    expect(algo.actualOrderId).toBe(bigOrderId);
  });

  it("[USER-TRADES] parses Binance's maker liquidity flag, and leaves it UNKNOWN when absent", async () => {
    // Real /fapi/v1/userTrades shape. Row 1 is a taker fill (maker:false) — what the live path
    // should ALWAYS produce, since single-symbol-lane-executor.ts and cross-sectional-executor.ts
    // only ever place MARKET / STOP_MARKET. Row 2 is maker:true, which must NOT be silently
    // flattened. Row 3 omits the field entirely and must stay `undefined`, NOT become `false` —
    // `false` is the value we expect, so defaulting to it would fabricate the very confirmation
    // this field exists to provide.
    const rawTradesBody = JSON.stringify([
      { symbol: "BTCUSDT", id: 991, orderId: "8389766229891298477", price: "61800.5", qty: "0.001", realizedPnl: "-1.8", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_000, maker: false },
      { symbol: "BTCUSDT", id: 992, orderId: "8389766229891298478", price: "61801.0", qty: "0.001", realizedPnl: "0", commission: "0.0123", commissionAsset: "USDT", time: 1_700_000_000_001, maker: true },
      { symbol: "BTCUSDT", id: 993, orderId: "8389766229891298479", price: "61802.0", qty: "0.001", realizedPnl: "0", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_002 },
    ]);

    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawTradesBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const trades = await client.getUserTrades("BTCUSDT", { startTime: 1, limit: 1000 });

    expect(trades).toHaveLength(3);
    expect(trades[0]!.maker).toBe(false);
    expect(trades[1]!.maker).toBe(true);
    // The honesty assertion: absent must survive as unknown, and must be DISTINGUISHABLE from a
    // genuine taker fill. `toBeUndefined()` alone would also pass a `Boolean(undefined) === false`
    // implementation under a loose matcher, so assert the distinction explicitly.
    expect(trades[2]!.maker).toBeUndefined();
    expect(trades[2]!.maker).not.toBe(false);

    // Guard the existing fields at the same time: the mapper is the only place these are read off
    // the raw row, and orderId must stay an exact string (19-digit precision incident).
    expect(trades[0]!.orderId).toBe("8389766229891298477");
    expect(typeof trades[0]!.orderId).toBe("string");
    expect(trades[0]!.commission).toBeCloseTo(0.0309, 6);
    expect(trades[0]!.price).toBeCloseTo(61800.5, 6);
  });

  it("[USER-TRADES] the parsed maker flag survives into the persisted fill shape, unknown != taker", async () => {
    // The parse above is only half the item: the flag is worthless if it is dropped at the boundary
    // where fills are actually persisted. fillFromUserTrade() is that boundary (single-symbol-lane-
    // executor.ts:1105/1116 hands it the whole trade row), so assert the whole client -> persisted
    // path in one go rather than trusting the two halves separately.
    //
    // Row 3's `maker: "false"` is the nastiest case and the reason the mapper must use a `typeof`
    // guard rather than `Boolean(...)`: the STRING "false" is truthy, so a naive coercion would
    // persist `true` — i.e. it would claim Binance confirmed we PROVIDED liquidity on a MARKET
    // order. That is worse than no data. It must land as `null` (unmeasured).
    const rawTradesBody = JSON.stringify([
      { symbol: "BTCUSDT", id: 991, orderId: "8389766229891298477", price: "61800.5", qty: "0.001", realizedPnl: "-1.8", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_000, maker: false },
      { symbol: "BTCUSDT", id: 992, orderId: "8389766229891298478", price: "61801.0", qty: "0.001", realizedPnl: "0", commission: "0.0123", commissionAsset: "USDT", time: 1_700_000_000_001, maker: true },
      { symbol: "BTCUSDT", id: 993, orderId: "8389766229891298479", price: "61802.0", qty: "0.001", realizedPnl: "0", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_002, maker: "false" },
      { symbol: "BTCUSDT", id: 994, orderId: "8389766229891298480", price: "61803.0", qty: "0.001", realizedPnl: "0", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_003 },
    ]);

    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawTradesBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const trades = await client.getUserTrades("BTCUSDT", { startTime: 1, limit: 1000 });
    const fills = trades.map((t) => fillFromUserTrade(t, "EXIT"));

    expect(fills).toHaveLength(4);
    // A confirmed taker fill — the value the 5.0 bps/side cost model assumes and this field exists
    // to verify rather than assume.
    expect(fills[0]!.maker).toBe(false);
    // A maker fill must NOT be flattened into the taker bucket on the way to disk.
    expect(fills[1]!.maker).toBe(true);
    // Garbage and absent both mean UNMEASURED, and neither may masquerade as a measurement.
    expect(fills[2]!.maker).toBeNull();
    expect(fills[2]!.maker).not.toBe(true);
    expect(fills[2]!.maker).not.toBe(false);
    expect(fills[3]!.maker).toBeNull();
    expect(fills[3]!.maker).not.toBe(false);

    // The persisted fill must also carry the raw price and the exact-string orderId, since the
    // whole point of recording fills is that nothing upstream keeps them.
    expect(fills[0]!.price).toBeCloseTo(61800.5, 6);
    expect(fills[0]!.orderId).toBe("8389766229891298477");
    expect(typeof fills[0]!.orderId).toBe("string");
  });

  it("maps Binance error payloads to typed errors with the binance code", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: -2019, msg: "Margin is insufficient." }), { status: 400 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    try {
      await client.getBalances();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BinanceFuturesPrivateError);
      expect((error as BinanceFuturesPrivateError).failureType).toBe("binance_error");
      expect((error as BinanceFuturesPrivateError).binanceCode).toBe(-2019);
    }
  });

  it("normalizes mutable order quantity and price params to exchange filters before signing", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      if (u.includes("/fapi/v1/exchangeInfo")) {
        return new Response(JSON.stringify({
          symbols: [{
            symbol: "DOGEUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            quoteAsset: "USDT",
            pricePrecision: 5,
            quantityPrecision: 0,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.0000100" },
              { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          }],
        }), { status: 200 });
      }
      if (u.includes("/fapi/v1/algoOrder")) {
        return new Response(JSON.stringify({
          symbol: "DOGEUSDT",
          algoId: 2,
          clientAlgoId: "algo",
          algoStatus: "NEW",
          orderType: "STOP_MARKET",
          side: "BUY",
          quantity: "12",
          triggerPrice: "0.12346",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        symbol: "DOGEUSDT",
        orderId: 1,
        clientOrderId: "limit",
        status: "NEW",
        type: "LIMIT",
        side: "BUY",
        reduceOnly: false,
        price: "0.12345",
        stopPrice: "0",
        origQty: "12",
        executedQty: "0",
        avgPrice: "0",
        updateTime: 0,
      }), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    await client.placeOrder({
      symbol: "DOGEUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 12.345678,
      price: 0.123456789,
      timeInForce: "GTC",
      newClientOrderId: "limit",
    });
    await client.placeAlgoOrder({
      symbol: "DOGEUSDT",
      side: "BUY",
      type: "STOP_MARKET",
      quantity: 12.345678,
      triggerPrice: 0.123456789,
      reduceOnly: true,
      clientAlgoId: "algo",
    });

    const orderUrl = urls.find((u) => u.includes("/fapi/v1/order?")) ?? "";
    const algoUrl = urls.find((u) => u.includes("/fapi/v1/algoOrder?")) ?? "";
    expect(orderUrl).toContain("quantity=12");
    expect(orderUrl).toContain("price=0.12345");
    expect(algoUrl).toContain("quantity=12");
    expect(algoUrl).toContain("triggerPrice=0.12346");
    expect(urls.filter((u) => u.includes("/fapi/v1/exchangeInfo"))).toHaveLength(1);
  });

  it("suppresses a fresh entry when the basket watchdog aborts during a cold filter lookup", async () => {
    const urls: string[] = [];
    let releaseExchangeInfo: (() => void) | null = null;
    const exchangeInfo = new Promise<Response>((resolve) => {
      releaseExchangeInfo = () => resolve(new Response(JSON.stringify({
        symbols: [{
          symbol: "DOGEUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT",
          pricePrecision: 5, quantityPrecision: 0,
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.00001" },
            { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
          ],
        }],
      }), { status: 200 }));
    });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/fapi/v1/exchangeInfo")) return exchangeInfo;
      throw new Error(`a stale entry must not dispatch ${value}`);
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl,
    });
    const controller = new AbortController();
    const placing = client.placeOrder({
      symbol: "DOGEUSDT", side: "BUY", type: "MARKET", quantity: 5,
      newClientOrderId: "stale-entry-must-not-dispatch", signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();
    releaseExchangeInfo?.();

    await expect(placing).rejects.toMatchObject({ failureType: "timeout" });
    expect(urls.filter((url) => url.includes("/fapi/v1/order"))).toHaveLength(0);
  });

  it("re-fetches exchange filters after the TTL instead of caching them for the process lifetime", async () => {
    let exchangeInfoCalls = 0;
    let simulatedNowMs = 1_000_000_000_000;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: simulatedNowMs }), { status: 200 });
      }
      if (u.includes("/fapi/v1/exchangeInfo")) {
        exchangeInfoCalls += 1;
        return new Response(JSON.stringify({
          symbols: [{
            symbol: "DOGEUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            quoteAsset: "USDT",
            pricePrecision: 5,
            quantityPrecision: 0,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.0000100" },
              { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({
      apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl,
      nowMs: () => simulatedNowMs,
    });

    await client.getExchangeFilters();
    expect(exchangeInfoCalls).toBe(1);

    // Well within the 6h TTL — must reuse the cached filters, not re-fetch.
    simulatedNowMs += 60 * 60 * 1000; // +1h
    await client.getExchangeFilters();
    expect(exchangeInfoCalls).toBe(1);

    // Past the 6h TTL — must re-fetch rather than keep serving stale specs.
    simulatedNowMs += 6 * 60 * 60 * 1000; // +6h more (total +7h)
    await client.getExchangeFilters();
    expect(exchangeInfoCalls).toBe(2);
  });

  it("coalesces concurrent cold exchange-filter reads into one request", async () => {
    let exchangeInfoCalls = 0;
    let releaseExchangeInfo: (() => void) | null = null;
    const exchangeInfo = new Promise<Response>((resolve) => {
      releaseExchangeInfo = () => resolve(new Response(JSON.stringify({
        symbols: [{
          symbol: "DOGEUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT",
          pricePrecision: 5, quantityPrecision: 0,
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.0000100" },
            { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
            { filterType: "MIN_NOTIONAL", notional: "5" },
          ],
        }],
      }), { status: 200 }));
    });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/fapi/v1/exchangeInfo")) {
        exchangeInfoCalls += 1;
        return exchangeInfo;
      }
      throw new Error(`unexpected URL ${String(url)}`);
    }) as typeof fetch;
    const client = new BinanceFuturesPrivateClient({
      apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl,
    });

    const reads = Array.from({ length: 6 }, () => client.getExchangeFilters("EXECUTION"));
    // Drain the microtask queue with one real macrotask turn rather than
    // counting `await Promise.resolve()` hops. The count is an artifact of how
    // many awaits the transport happens to have between here and the fetch —
    // adding the queue-head deadlock guard changed it and broke this test even
    // though coalescing itself was untouched. What matters is that six
    // concurrent cold reads produce exactly one request, asserted here and
    // again after they all resolve.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(exchangeInfoCalls).toBe(1);
    releaseExchangeInfo?.();

    const results = await Promise.all(reads);
    expect(results.every((filters) => filters.get("DOGEUSDT")?.stepSize === 1)).toBe(true);
    expect(exchangeInfoCalls).toBe(1);
  });

  it("getIncomeHistory signs a GET to /fapi/v1/income and maps a realistic multi-type response", async () => {
    const urls: string[] = [];
    const rawIncomeBody = JSON.stringify([
      { symbol: "ETHUSDT", incomeType: "REALIZED_PNL", income: "3.50000000", asset: "USDT", time: 1720000000000, tranId: "9689322392", info: "" },
      { symbol: "ETHUSDT", incomeType: "COMMISSION", income: "-0.18000000", asset: "USDT", time: 1720000000500, tranId: "9689322393", info: "" },
      { symbol: "ETHUSDT", incomeType: "FUNDING_FEE", income: "-0.04120000", asset: "USDT", time: 1720000001000, tranId: "9689322394", info: "" },
      { symbol: "", incomeType: "TRANSFER", income: "10.00000000", asset: "USDT", time: 1720000001500, tranId: "9689322395", info: "" },
    ]);
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawIncomeBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const entries = await client.getIncomeHistory({ startTime: 1720000000000, endTime: 1720000086399999 });

    const incomeUrl = urls.find((u) => u.includes("/fapi/v1/income"));
    expect(incomeUrl).toBeDefined();
    expect(incomeUrl).toContain("startTime=1720000000000");
    expect(incomeUrl).toContain("endTime=1720000086399999");
    expect(incomeUrl).toContain("signature=");
    // Signed GET: must carry the API key header path (same convention as every other signed call) —
    // verified indirectly via a successful round trip rather than inspecting private fetch options.

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      symbol: "ETHUSDT",
      incomeType: "REALIZED_PNL",
      income: 3.5,
      asset: "USDT",
      time: 1720000000000,
      tranId: "9689322392",
      info: "",
    });
    expect(entries[1].incomeType).toBe("COMMISSION");
    expect(entries[1].income).toBeCloseTo(-0.18, 10);
    expect(entries[2].incomeType).toBe("FUNDING_FEE");
    expect(entries[3].incomeType).toBe("TRANSFER");
    expect(entries[3].symbol).toBe("");
  });

  it("getIncomeHistory defaults to limit=1000 and returns [] for a non-array response", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, msg: "unexpected shape" }), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const entries = await client.getIncomeHistory();
    expect(entries).toEqual([]);
    const incomeUrl = urls.find((u) => u.includes("/fapi/v1/income"));
    expect(incomeUrl).toContain("limit=1000");
  });

  // [TIME-SYNC-RESILIENCE, 2026-07-12 fix]: ensureTimeSync() ran forceTimeSync() uncaught before
  // every signed request — a single transient hiccup hitting /fapi/v1/time aborted the request
  // outright with zero retry, even though a prior successful sync (now merely past its TTL) is a
  // perfectly safe fallback (Binance's own recvWindow/signature check plus assertClockSkewOk still
  // guard against a truly-drifted clock).
  it("survives a periodic time-resync failure by riding out the stale-but-recent offset", async () => {
    let nowMs = 1_700_000_000_000;
    let timeCalls = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) {
        timeCalls += 1;
        if (timeCalls === 1) {
          return new Response(JSON.stringify({ serverTime: nowMs }), { status: 200 });
        }
        throw new Error("simulated network failure hitting /fapi/v1/time");
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({
      apiKey: "k",
      apiSecret: "s",
      env: "testnet",
      fetchImpl,
      nowMs: () => nowMs,
    });

    // First call: real sync succeeds, request goes through.
    await expect(client.getBalances()).resolves.toEqual([]);
    expect(timeCalls).toBe(1);

    // Advance well past the periodic TTL so the next call attempts (and exhausts retries on) a
    // resync that now fails outright — the signed request itself must still succeed, riding out
    // on the stale-but-recent offset from the first sync instead of aborting.
    nowMs += 120_000;
    await expect(client.getBalances()).resolves.toEqual([]);
    expect(timeCalls).toBeGreaterThan(1);
  });

  it("queryOrderByClientId signs a GET to /fapi/v1/order keyed by origClientOrderId, not orderId", async () => {
    // Same 19-digit precision fixture as the queryOrder(orderId) test above — this method must go
    // through the exact same mapOrder() precision-preserving path, not a hand-rolled parse.
    const bigOrderId = "8389766229891298477";
    const rawOrderBody = `{"symbol":"BTCUSDT","orderId":${bigOrderId},"clientOrderId":"my-client-id","status":"FILLED","type":"MARKET","side":"BUY","reduceOnly":false,"price":"0","stopPrice":"0","origQty":"1","executedQty":"1","avgPrice":"61800.5","updateTime":1}`;
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawOrderBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const order = await client.queryOrderByClientId("BTCUSDT", "my-client-id");

    const orderUrl = urls.find((u) => u.includes("/fapi/v1/order?"));
    expect(orderUrl).toBeDefined();
    expect(orderUrl).toContain("origClientOrderId=my-client-id");
    // Must NOT also (accidentally) send a bare `orderId=` param — this is a lookup BY client id, the
    // whole point being that no exchange-assigned orderId is known yet.
    expect(orderUrl).not.toMatch(/[?&]orderId=/);
    expect(order.orderId).toBe(bigOrderId);
    expect(typeof order.orderId).toBe("string");
    expect(order.status).toBe("FILLED");
    expect(order.executedQty).toBe(1);
    expect(order.avgPrice).toBeCloseTo(61800.5, 6);
  });

  it("cancels one order by origClientOrderId and returns Binance's terminal response", async () => {
    const bigOrderId = "8389766229891298477";
    const rawOrderBody = `{"symbol":"BTCUSDT","orderId":${bigOrderId},"clientOrderId":"lost-placement-response","status":"CANCELED","type":"LIMIT","side":"BUY","reduceOnly":false,"price":"61800.5","stopPrice":"0","origQty":"1","executedQty":"0","avgPrice":"0","updateTime":1}`;
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: String(url), method: init?.method ?? "GET" };
      requests.push(request);
      if (request.url.includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawOrderBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const order = await client.cancelOrderByClientIdAndRead("BTCUSDT", "lost-placement-response");

    const cancelRequest = requests.find((request) => request.url.includes("/fapi/v1/order?"));
    expect(cancelRequest).toBeDefined();
    expect(cancelRequest?.method).toBe("DELETE");
    expect(cancelRequest?.url).toContain("origClientOrderId=lost-placement-response");
    expect(cancelRequest?.url).not.toMatch(/[?&]orderId=/);
    expect(order.orderId).toBe(bigOrderId);
    expect(order.clientOrderId).toBe("lost-placement-response");
    expect(order.status).toBe("CANCELED");
  });

  it("still fails closed when the very first time-sync attempt never succeeds", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/fapi/v1/time")) throw new Error("simulated network failure hitting /fapi/v1/time");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    await expect(client.getBalances()).rejects.toThrow(/simulated network failure/);
  });
});

describe("binance-futures-private read deadline", () => {
  it("abandons a GET stuck past the hard deadline instead of pinning its caller forever", async () => {
    // 2026-09-18: one account read issued 2026-09-15 was still pending three days later; the
    // engine tick and the dashboard both awaited it. Whatever bound failed, the caller must not.
    const directory = mkdtempSync(join(tmpdir(), "kronos-usdm-read-deadline-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      let fetches = 0;
      const fetchImpl = vi.fn(() => {
        fetches += 1;
        return new Promise<Response>(() => {}); // never settles, ignores the abort
      }) as unknown as typeof fetch;
      const client = new BinanceFuturesPrivateClient({
        apiKey: "k",
        apiSecret: "s",
        env: "testnet",
        fetchImpl,
        nowMs: () => Date.now(),
        testReadDispatchGapMs: 0,
        testnetCoordinatorDir: directory,
        testnetGlobalReadGapMs: 1_000,
      });
      const read = client.getKlines("SOLUSDT", "1m", { limit: 2 });
      const outcome = read.then(() => "RESOLVED", (e: unknown) => e);

      await vi.advanceTimersByTimeAsync(GET_STALL_REPORT_MS + 1);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/still pending .* at stage "network request"/);

      await vi.advanceTimersByTimeAsync(GET_HARD_DEADLINE_MS);
      const settled = await outcome;
      expect(settled).toBeInstanceOf(BinanceReadDeadlineError);
      expect((settled as BinanceReadDeadlineError).failureType).toBe("timeout");
      expect((settled as Error).message).toMatch(/abandoned after 600000ms stuck at stage "network request"/);
      // Not retried: a retry would only multiply the wait it was abandoned for.
      expect(fetches).toBe(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

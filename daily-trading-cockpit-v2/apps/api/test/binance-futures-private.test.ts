import { describe, expect, it } from "vitest";

import {
  BinanceFuturesPrivateClient,
  BinanceFuturesPrivateError,
  buildQueryString,
  resolveLiveBinanceBaseUrl,
  resolveLiveBinanceEnv,
  signQueryString,
} from "../src/lib/binance-futures-private.js";
import { fillFromUserTrade } from "../src/lib/execution-fill-recorder.js";

describe("binance-futures-private signing", () => {
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
    expect(resolveLiveBinanceBaseUrl("testnet")).toContain("testnet.binancefuture.com");
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
    expect(urls[0]).toContain("testnet.binancefuture.com/fapi/v1/ticker/bookTicker");
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

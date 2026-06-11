import { describe, expect, it } from "vitest";

import {
  BinanceFuturesPrivateClient,
  BinanceFuturesPrivateError,
  buildQueryString,
  resolveLiveBinanceBaseUrl,
  resolveLiveBinanceEnv,
  signQueryString,
} from "../src/lib/binance-futures-private.js";

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
});

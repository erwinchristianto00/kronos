import { describe, expect, it } from "vitest";

import { HttpSocialClient } from "../src/lib/social.js";

describe("HttpSocialClient", () => {
  it("uses custom sentiment when a valid response is returned", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          signal: "BULLISH",
          score: 72,
          confidence: 68,
          scope: "SYMBOL",
          source: "custom",
          reason: "Custom desk is net positive.",
        }),
        { status: 200 },
      );

    const client = new HttpSocialClient({
      provider: "custom",
      baseUrl: "https://example.com/sentiment",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const signal = await client.getSignal("BTCUSDT");

    expect(signal.available).toBe(true);
    expect(signal.signal).toBe("BULLISH");
    expect(signal.score).toBe(72);
    expect(signal.scope).toBe("SYMBOL");
  });

  it("keeps sentiment weightless when disabled", async () => {
    const client = new HttpSocialClient({
      provider: "none",
      baseUrl: undefined,
      fetchImpl: fetch,
    });
    const signal = await client.getSignal("BTCUSDT");

    expect(signal.available).toBe(false);
    expect(signal.signal).toBe("UNAVAILABLE");
    expect(signal.score).toBe(0);
  });

  it("feargreed returns market scope only", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: [{ value: "68", value_classification: "Greed" }],
        }),
        { status: 200 },
      );

    const client = new HttpSocialClient({
      provider: "feargreed",
      baseUrl: undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const signal = await client.getSignal("BTCUSDT");

    expect(signal.available).toBe(true);
    expect(signal.scope).toBe("MARKET");
    expect(signal.source).toBe("feargreed");
  });

  it("reddit active affects per-symbol sentiment", async () => {
    let call = 0;
    const fetchImpl = async (input: string | URL) => {
      call += 1;
      const url = input.toString();
      if (url.includes("/api/v1/access_token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            data: {
              children: [
                { data: { title: "BTC breakout looks bullish", selftext: "buy btc", ups: 20, num_comments: 10, created_utc: Math.floor(Date.now() / 1000) } },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            children: [
              { data: { body: "btc still bullish here", ups: 5, num_comments: 2, created_utc: Math.floor(Date.now() / 1000) } },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const client = new HttpSocialClient({
      provider: "reddit",
      baseUrl: undefined,
      redditClientId: "id",
      redditClientSecret: "secret",
      redditSubreddits: "CryptoCurrency",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const signal = await client.getSignal("BTCUSDT");

    expect(signal.available).toBe(true);
    expect(signal.scope).toBe("SYMBOL");
    expect(signal.source).toBe("reddit");
    expect(signal.signal).toBe("BULLISH");
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it("reddit rate limit or OAuth error is safe", async () => {
    const fetchImpl = async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/api/v1/access_token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    };
    const client = new HttpSocialClient({
      provider: "reddit",
      baseUrl: undefined,
      redditClientId: "id",
      redditClientSecret: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const signal = await client.getSignal("BTCUSDT");

    expect(signal.available).toBe(false);
    expect(signal.signal).toBe("UNAVAILABLE");
    expect(signal.reason).toContain("rate limited");
  });
});

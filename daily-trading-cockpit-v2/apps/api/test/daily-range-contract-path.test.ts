import { describe, expect, it } from "vitest";

import {
  DailyRangeContractPathSupervisor,
  parseDailyRangeContractAggTrade,
  parseDailyRangeExecutableBookTicker,
} from "../src/lib/daily-range-contract-path.js";

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closeCalls = 0;

  constructor(readonly url: string) {}

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(): void {
    this.closeCalls++;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromExchange(): void {
    this.onclose?.();
  }
}

describe("Daily Range contract-price path parser", () => {
  it("accepts a Binance combined aggTrade envelope with contract event time", () => {
    expect(parseDailyRangeContractAggTrade({
      stream: "btcusdt@aggTrade",
      data: { s: "BTCUSDT", p: "100000.25", T: 1_000 },
    }, 1_005, 900)).toEqual({
      symbol: "BTCUSDT",
      price: 100000.25,
      eventTimeMs: 1_000,
      receivedAtMs: 1_005,
      source: "CONTRACT_AGG_TRADE",
      streamStartedAtMs: 900,
    });
  });

  it("rejects a malformed or non-causal path event instead of inventing an extrema point", () => {
    expect(parseDailyRangeContractAggTrade({ data: { s: "BTCUSDT", p: "NaN", T: 1_000 } }, 1_005, 900)).toBeNull();
    expect(parseDailyRangeContractAggTrade({ data: { s: "", p: "100", T: 1_000 } }, 1_005, 900)).toBeNull();
    expect(parseDailyRangeContractAggTrade({ data: { s: "BTCUSDT", p: "100", T: 1_000 } }, 0, 900)).toBeNull();
  });

  it("accepts only a complete, executable USD-M bookTicker quote", () => {
    expect(parseDailyRangeExecutableBookTicker({
      stream: "btcusdt@bookTicker",
      data: { s: "BTCUSDT", b: "100.10", a: "100.20", u: 55, T: 1_000 },
    }, 1_010)).toEqual({
      symbol: "BTCUSDT",
      bestBid: 100.1,
      bestAsk: 100.2,
      eventTimeMs: 1_000,
      receivedAtMs: 1_010,
      updateId: 55,
    });
    expect(parseDailyRangeExecutableBookTicker({ data: { s: "BTCUSDT", b: "100.20", a: "100.10", u: 56, T: 1_000 } }, 1_010)).toBeNull();
    expect(parseDailyRangeExecutableBookTicker({ data: { s: "BTCUSDT", b: "100.10", a: "100.20", T: 1_000 } }, 1_010)).toBeNull();
  });

  it("updates a rotating pool through live subscriptions without breaking an existing trade path", () => {
    let nowMs = 1_000;
    const sockets: FakeWebSocket[] = [];
    const events: ReturnType<typeof parseDailyRangeContractAggTrade>[] = [];
    const bookEvents: ReturnType<typeof parseDailyRangeExecutableBookTicker>[] = [];
    const interruptions: string[] = [];
    const supervisor = new DailyRangeContractPathSupervisor({
      environment: "mainnet",
      nowMs: () => nowMs,
      onEvent: (event) => events.push(event),
      onBookTickerEvent: (event) => bookEvents.push(event),
      onStreamInterrupted: (reason) => interruptions.push(reason),
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    supervisor.refresh(["BTCUSDT", "ETHUSDT"]);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://fstream.binance.com/market/ws");
    socket.open();
    expect(socket.sent).toEqual([
      { method: "SUBSCRIBE", params: ["btcusdt@aggTrade", "btcusdt@bookTicker", "ethusdt@aggTrade", "ethusdt@bookTicker"], id: 1 },
    ]);
    nowMs = 1_010;
    socket.receive({ result: null, id: 1 });
    socket.receive({ data: { s: "BTCUSDT", p: "100", T: 1_020 } });
    expect(events).toEqual([{
      symbol: "BTCUSDT",
      price: 100,
      eventTimeMs: 1_020,
      receivedAtMs: 1_010,
      source: "CONTRACT_AGG_TRADE",
      streamStartedAtMs: 1_010,
    }]);
    socket.receive({ data: { s: "BTCUSDT", b: "99.9", a: "100.1", u: 10, T: 1_021 } });
    expect(bookEvents).toEqual([{
      symbol: "BTCUSDT", bestBid: 99.9, bestAsk: 100.1, updateId: 10, eventTimeMs: 1_021, receivedAtMs: 1_010,
    }]);

    nowMs = 1_030;
    supervisor.refresh(["BTCUSDT", "SOLUSDT"]);
    expect(sockets).toHaveLength(1);
    expect(socket.closeCalls).toBe(0);
    expect(socket.sent.slice(1)).toEqual([
      { method: "SUBSCRIBE", params: ["solusdt@aggTrade", "solusdt@bookTicker"], id: 2 },
      { method: "UNSUBSCRIBE", params: ["ethusdt@aggTrade", "ethusdt@bookTicker"], id: 3 },
    ]);
    nowMs = 1_040;
    socket.receive({ result: null, id: 2 });
    socket.receive({ result: null, id: 3 });
    socket.receive({ data: { s: "BTCUSDT", p: "101", T: 1_050 } });

    expect(events.at(-1)?.streamStartedAtMs).toBe(1_010);
    expect(interruptions).toEqual([]);
    expect(supervisor.getStatus()).toMatchObject({
      desiredSymbols: 2,
      subscribedSymbols: 2,
      pendingSubscriptions: 0,
      connected: true,
    });
  });

  it("still marks a real exchange socket close as a path interruption", () => {
    const sockets: FakeWebSocket[] = [];
    const interruptions: string[] = [];
    const supervisor = new DailyRangeContractPathSupervisor({
      environment: "testnet",
      nowMs: () => 2_000,
      onEvent: () => undefined,
      onStreamInterrupted: (reason) => interruptions.push(reason),
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    supervisor.refresh(["SOLUSDT"]);
    const socket = sockets[0]!;
    socket.open();
    // LIVE/observation construction has no BBO callback, so it retains the
    // historical aggTrade-only subscription surface.
    expect(socket.sent).toEqual([{ method: "SUBSCRIBE", params: ["solusdt@aggTrade"], id: 1 }]);
    socket.closeFromExchange();

    expect(interruptions).toEqual(["contract-price websocket closed"]);
    expect(supervisor.getStatus()).toMatchObject({ connected: false, subscribedSymbols: 0 });
  });
});

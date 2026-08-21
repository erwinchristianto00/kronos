import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  COPY_LEADER_DESTINATION_ENDPOINT,
  CopyLeaderExecutor,
  CopyLeaderStore,
  deriveCopySleeveSnapshot,
  parseCopyLeaderRuntimeConfig,
  sourceOrderIdentity,
  type CopyLeaderDefinition,
  type CopyLeaderExecutorOptions,
} from "../src/lib/copy-leader-executor.js";
import type { FuturesOrder, FuturesPosition, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";

const START = Date.UTC(2026, 7, 21, 0, 0, 0);
const LEADER: CopyLeaderDefinition = {
  id: "leader-test",
  name: "Test Leader",
  tier: "B-Low",
  sleeveShare: 1,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "copy-leader-test-"));
  dirs.push(dir);
  return dir;
}

function sourceOrder(opts: {
  symbol?: string;
  side: "BUY" | "SELL";
  positionSide?: string;
  at: number;
  qty?: number;
}): Record<string, unknown> {
  return {
    symbol: opts.symbol ?? "ETHUSDT",
    side: opts.side,
    positionSide: opts.positionSide ?? "SHORT",
    type: "MARKET",
    executedQty: String(opts.qty ?? 1),
    avgPrice: "100",
    totalPnl: "0",
    orderTime: opts.at,
    orderUpdateTime: opts.at,
  };
}

function filters(): Map<string, FuturesSymbolFilters> {
  return new Map([["ETHUSDT", {
    symbol: "ETHUSDT",
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
    pricePrecision: 2,
    quantityPrecision: 3,
  }]]);
}

function makeClient(now: () => number) {
  const positions: FuturesPosition[] = [];
  const submitted: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly?: boolean; newClientOrderId: string }> = [];
  const leverageUpdates: Array<{ symbol: string; leverage: number }> = [];
  const orders = new Map<string, FuturesOrder>();
  let serial = 0;
  const client = {
    getBalances: async () => [{ asset: "USDT", balance: 1_000, availableBalance: 1_000 }],
    getPositions: async () => positions.map((position) => ({ ...position })),
    getExchangeFilters: async () => filters(),
    getMarkPrice: async () => 100,
    setLeverage: async (symbol: string, leverage: number) => { leverageUpdates.push({ symbol, leverage }); },
    placeOrder: async (params: { symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly?: boolean; newClientOrderId: string }) => {
      submitted.push({ ...params });
      const existing = positions.find((position) => position.symbol === params.symbol);
      const position = existing ?? {
        symbol: params.symbol,
        positionAmt: 0,
        entryPrice: 100,
        markPrice: 100,
        liquidationPrice: 0,
        unRealizedProfit: 0,
        leverage: 1,
        marginType: "ISOLATED",
      };
      if (!existing) positions.push(position);
      const signedQty = params.side === "BUY" ? params.quantity : -params.quantity;
      position.positionAmt += signedQty;
      const order: FuturesOrder = {
        symbol: params.symbol,
        orderId: String(++serial),
        clientOrderId: params.newClientOrderId,
        status: "FILLED",
        type: "MARKET",
        side: params.side,
        reduceOnly: params.reduceOnly === true,
        price: 0,
        stopPrice: 0,
        origQty: params.quantity,
        executedQty: params.quantity,
        avgPrice: 100,
        updateTime: now(),
      };
      orders.set(order.orderId, order);
      return order;
    },
    queryOrder: async (_symbol: string, orderId: string) => orders.get(orderId)!,
    queryOrderByClientId: async (_symbol: string, clientOrderId: string) =>
      Array.from(orders.values()).find((order) => order.clientOrderId === clientOrderId)!,
    getUserTrades: async () => [],
  };
  return { client: client as unknown as CopyLeaderExecutorOptions["client"], positions, submitted, leverageUpdates };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("CopyLeaderExecutor", () => {
  it("hard-fails a non-Testnet destination configuration", () => {
    const config = parseCopyLeaderRuntimeConfig({
      COPY_LEADER_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      COPY_LEADER_DESTINATION_ENDPOINT: "https://fapi.binance.com",
    });
    expect(config.enabled).toBe(false);
    expect(config.configErrors).toHaveLength(1);
    expect(COPY_LEADER_DESTINATION_ENDPOINT).toBe("https://testnet.binancefuture.com");
  });

  it("uses our capped 3x Testnet leverage and derives gross from the small margin sleeve", () => {
    const config = parseCopyLeaderRuntimeConfig({
      COPY_LEADER_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      COPY_LEADER_EXEC_LEVERAGE: "3",
      COPY_LEADER_SOURCE_POLL_MS: "5000",
    });
    expect(config.leverage).toBe(3);
    expect(config.pollMs).toBe(5_000);
    expect(parseCopyLeaderRuntimeConfig({
      COPY_LEADER_ENABLED: "1",
      LIVE_BINANCE_ENV: "testnet",
      COPY_LEADER_EXEC_LEVERAGE: "99",
    }).leverage).toBe(3);

    expect(deriveCopySleeveSnapshot({
      checkedAt: "2026-08-21T00:00:00.000Z",
      availableBalanceUsd: 1_000,
      equityUsd: 1_000,
      executionLeverage: config.leverage,
    })).toMatchObject({
      sleeveMarginBudgetUsd: 100,
      executionLeverage: 3,
      totalGrossCapUsd: 300,
      perSymbolGrossCapUsd: 100,
    });
  });

  it("uses a stable canonical identity even when source-object keys arrive in another order", () => {
    const first = sourceOrder({ side: "SELL", at: START });
    const reordered = {
      avgPrice: "100",
      executedQty: "1",
      orderUpdateTime: START,
      symbol: "ETHUSDT",
      type: "MARKET",
      positionSide: "SHORT",
      totalPnl: "0",
      side: "SELL",
      orderTime: START,
    };
    expect(sourceOrderIdentity(LEADER.id, first)).toEqual(sourceOrderIdentity(LEADER.id, reordered));
  });

  it("seeds a durable cursor without replay, then mirrors exactly one fresh explicit entry and reduce-only exit", async () => {
    let now = START;
    const old = sourceOrder({ side: "SELL", at: START - 60_000 });
    const entry = sourceOrder({ side: "SELL", at: START + 500 });
    const exit = sourceOrder({ side: "BUY", at: START + 1_500 });
    const { client, submitted, positions, leverageUpdates } = makeClient(() => now);
    const calls = { reserve: 0, commit: 0, releaseCommitted: 0 };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/detail")) return response({ code: "000000", data: { marginBalance: "1000" } });
      const request = JSON.parse(String(init?.body ?? "{}")) as { startTime?: number };
      const rows = (request.startTime ?? 0) <= START - 5 * 60_000
        ? [old]
        : now < START + 1_000
          ? [old]
          : now < START + 2_000
            ? [entry]
            : [entry, exit];
      return response({ code: "000000", data: { list: rows, total: rows.length } });
    }) as typeof fetch;
    const executor = new CopyLeaderExecutor({
      client,
      store: new CopyLeaderStore(tempDir()),
      fetchImpl,
      env: { COPY_LEADER_ENABLED: "1", LIVE_BINANCE_ENV: "testnet", COPY_LEADER_EXEC_LEVERAGE: "3" },
      leaders: [LEADER],
      nowMs: () => now,
      getKronosUniverse: () => new Set(),
      canOpenNewEntries: () => true,
      exposure: {
        reserve: () => {
          calls.reserve += 1;
          return { ok: true, reservationId: "reservation-1" };
        },
        commitReservation: () => { calls.commit += 1; },
        releaseReservation: () => undefined,
        releaseCommittedReservation: () => { calls.releaseCommitted += 1; },
      },
    });

    await executor.tick();
    expect(submitted).toHaveLength(0);
    expect((executor.getStatus().eventLedger as Array<{ status: string }>)[0]!.status).toBe("CURSOR_SEEDED");

    now = START + 1_000;
    await executor.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ symbol: "ETHUSDT", side: "SELL" });
    expect(leverageUpdates).toEqual([{ symbol: "ETHUSDT", leverage: 3 }]);
    expect(submitted[0]!.reduceOnly).not.toBe(true);
    expect(positions.find((position) => position.symbol === "ETHUSDT")?.positionAmt).toBeLessThan(0);
    expect(calls).toMatchObject({ reserve: 1, commit: 1 });
    const [open] = executor.getOpenPositionReports();
    expect(open).toMatchObject({
      leaderName: "Test Leader",
      symbol: "ETHUSDT",
      direction: "SHORT",
      sourceEntry: { sourceReferencePrice: 100, testnetFillPrice: 100 },
    });

    await executor.tick();
    expect(submitted).toHaveLength(1); // same canonical source entry is idempotent

    now = START + 2_000;
    await executor.tick();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toMatchObject({ symbol: "ETHUSDT", side: "BUY", reduceOnly: true });
    expect(positions.find((position) => position.symbol === "ETHUSDT")?.positionAmt).toBeCloseTo(0);
    expect(calls.releaseCommitted).toBe(1);
    const [closed] = executor.getClosedTrades();
    expect(closed).toMatchObject({
      leaderName: "Test Leader",
      symbol: "ETHUSDT",
      direction: "SHORT",
      closeKind: "SOURCE_EXIT",
      comparable: true,
      netRealizedPnlUsd: 0,
      sourceEntry: { sourceReferencePrice: 100, testnetFillPrice: 100 },
      sourceExit: { sourceReferencePrice: 100, testnetFillPrice: 100 },
    });
    const latency = (executor.getStatus().leaders as Array<{
      sourceLatency: {
        classification: string;
        measuredEventCount: number;
        freshEventCount: number;
        staleEventCount: number;
        latestObservationLatencyMs: number | null;
        lastSourceFetchKind: string | null;
        lastSourceFetchOk: boolean | null;
      };
    }>)[0]!.sourceLatency;
    expect(latency).toMatchObject({
      classification: "FRESH",
      measuredEventCount: 2,
      freshEventCount: 2,
      staleEventCount: 0,
      latestObservationLatencyMs: 500,
      lastSourceFetchKind: "EVENT_POLL",
      lastSourceFetchOk: true,
    });
  });

  it("records stale events and never submits them", async () => {
    let now = START;
    const old = sourceOrder({ side: "SELL", at: START - 10_000 });
    const stale = sourceOrder({ side: "SELL", at: START + 1 });
    const { client, submitted } = makeClient(() => now);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/detail")) return response({ code: "000000", data: { marginBalance: "1000" } });
      const request = JSON.parse(String(init?.body ?? "{}")) as { startTime?: number };
      const rows = (request.startTime ?? 0) <= START - 5 * 60_000 ? [old] : now === START ? [old] : [stale];
      return response({ code: "000000", data: { list: rows, total: rows.length } });
    }) as typeof fetch;
    const executor = new CopyLeaderExecutor({
      client,
      store: new CopyLeaderStore(tempDir()),
      fetchImpl,
      env: { COPY_LEADER_ENABLED: "1", LIVE_BINANCE_ENV: "testnet", COPY_LEADER_SOURCE_STALENESS_MS: "120000" },
      leaders: [LEADER],
      nowMs: () => now,
      getKronosUniverse: () => new Set(),
      canOpenNewEntries: () => true,
      exposure: { reserve: () => ({ ok: true, reservationId: "r" }), commitReservation: () => undefined, releaseReservation: () => undefined },
    });
    await executor.tick();
    now = START + 130_000;
    await executor.tick();
    expect(submitted).toHaveLength(0);
    const status = executor.getStatus();
    const staleRow = (status.eventLedger as Array<{
      status: string;
      sourceTimestampMs: number;
      firstObservedAt: string | null;
      sourceObservationLatencyMs: number | null;
    }>).find((row) => row.status === "SKIPPED_STALE_SOURCE_EVENT");
    expect(staleRow).toMatchObject({
      sourceTimestampMs: START + 1,
      firstObservedAt: new Date(now).toISOString(),
      sourceObservationLatencyMs: 129_999,
    });
    const latency = (status.leaders as Array<{
      sourceLatency: {
        classification: string;
        measuredEventCount: number;
        freshEventCount: number;
        staleEventCount: number;
        latestObservationLatencyMs: number | null;
      };
    }>)[0]!.sourceLatency;
    expect(latency).toMatchObject({
      classification: "DELAYED",
      measuredEventCount: 1,
      freshEventCount: 0,
      staleEventCount: 1,
      latestObservationLatencyMs: 129_999,
    });
  });

  it("blocks a leader below the 60% Testnet source-event coverage threshold", async () => {
    const unsupported = Array.from({ length: 9 }, (_, index) => sourceOrder({ symbol: `NOPE${index}USDT`, side: "SELL", at: START - 60_000 - index }));
    const covered = sourceOrder({ side: "SELL", at: START - 61_000 });
    const { client, submitted } = makeClient(() => START);
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("/detail")) return response({ code: "000000", data: { marginBalance: "1000" } });
      const rows = [covered, ...unsupported];
      return response({ code: "000000", data: { list: rows, total: rows.length } });
    }) as typeof fetch;
    const executor = new CopyLeaderExecutor({
      client,
      store: new CopyLeaderStore(tempDir()),
      fetchImpl,
      env: { COPY_LEADER_ENABLED: "1", LIVE_BINANCE_ENV: "testnet" },
      leaders: [LEADER],
      nowMs: () => START,
      getKronosUniverse: () => new Set(),
      canOpenNewEntries: () => true,
      exposure: { reserve: () => ({ ok: true, reservationId: "r" }), commitReservation: () => undefined, releaseReservation: () => undefined },
    });
    await executor.tick();
    const leaders = executor.getStatus().leaders as Array<{ state: string; coverage: { coveragePct: number } | null }>;
    expect(leaders[0]!.state).toBe("BLOCKED_TESTNET_SYMBOL_COVERAGE");
    expect(leaders[0]!.coverage?.coveragePct).toBe(10);
    expect(submitted).toHaveLength(0);
  });

  it("follows Binance indexValue pagination and keeps a complete source coverage", async () => {
    const first = sourceOrder({ side: "SELL", at: START - 60_000 });
    const second = sourceOrder({ side: "BUY", at: START - 59_000 });
    const { client, submitted } = makeClient(() => START);
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/detail")) return response({ code: "000000", data: { marginBalance: "1000" } });
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(payload);
      if (payload.indexValue === undefined) {
        return response({ code: "000000", data: { list: [first], total: 2, indexValue: "cursor-1" } });
      }
      expect(payload.indexValue).toBe("cursor-1");
      return response({ code: "000000", data: { list: [second], total: 2, indexValue: null } });
    }) as typeof fetch;
    const executor = new CopyLeaderExecutor({
      client,
      store: new CopyLeaderStore(tempDir()),
      fetchImpl,
      env: { COPY_LEADER_ENABLED: "1", LIVE_BINANCE_ENV: "testnet" },
      leaders: [LEADER],
      nowMs: () => START,
      getKronosUniverse: () => new Set(),
      canOpenNewEntries: () => true,
      exposure: { reserve: () => ({ ok: true, reservationId: "r" }), commitReservation: () => undefined, releaseReservation: () => undefined },
    });

    await executor.tick();
    const leader = (executor.getStatus().leaders as Array<{ coverage: { sourceEventCount: number } | null; state: string }>)[0]!;
    expect(requests).toHaveLength(4); // two coverage pages plus two cursor-seed pages
    expect(leader.coverage?.sourceEventCount).toBe(2);
    expect(leader.state).toBe("ARMED_WAITING_SIGNAL");
    expect(submitted).toHaveLength(0);
  });
});

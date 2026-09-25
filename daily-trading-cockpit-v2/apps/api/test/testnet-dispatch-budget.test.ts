import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BinanceUsdMTestnetReadCoordinator, estimateTestnetReadWeight } from "../src/lib/binance-usdm-testnet-rate-limit.js";
import { BinanceFuturesPrivateClient } from "../src/lib/binance-futures-private.js";

let directory: string;
const start = Date.parse("2026-09-06T05:22:10Z");
const request = { method: "GET", endpoint: "/fapi/v2/positionRisk", requestCaller: "test", estimatedWeight: 5 };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "dispatch-budget-")); vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
const make = () => new BinanceUsdMTestnetReadCoordinator({ directory });
const state = () => JSON.parse(readFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "utf8"));

it("lower response from a different endpoint cannot erase same-minute high water, including restart", async () => {
  await make().recordDispatchResponse({ ...request, usedWeight1m: 2100, httpStatus: 200 });
  await make().recordDispatchResponse({ ...request, endpoint: "/fapi/v1/time", usedWeight1m: 1, httpStatus: 200 });
  let sent = false;
  const pending = make().acquireDispatchBudget(request, () => {}).then(() => { sent = true; });
  await vi.advanceTimersByTimeAsync(49_999);
  expect(sent).toBe(false);
  await vi.advanceTimersByTimeAsync(2_001);
  await pending;
  expect(sent).toBe(true);
});

it("charges a shared weighted budget atomically across independently constructed clients", async () => {
  await make().acquireDispatchBudget({ ...request, estimatedWeight: 1918 }, () => {});
  let sent = false;
  const pending = make().acquireDispatchBudget(request, () => {}).then(() => { sent = true; });
  await vi.advanceTimersByTimeAsync(61_999);
  expect(sent).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(state().dispatchBudget.debits).toHaveLength(1);
});

it("detects pressure learned after reserving a lane, and a ban learned during the budget wait", async () => {
  const c = make();
  await c.reserveReadDispatch("SIGNED");
  await make().recordDispatchResponse({ ...request, usedWeight1m: 2200, httpStatus: 200 });
  const pending = c.acquireDispatchBudget(request, () => {}).catch(e => e);
  await vi.advanceTimersByTimeAsync(500);
  await make().registerRateLimit({ status: 418, retryUntilMs: start + 120000, failure: "418",
    endpoint: request.endpoint, requestKind: "SIGNED", requestCaller: "test" });
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending).httpStatus).toBe(418);
  expect(state().dispatchBudget.debits).toEqual([]);
});

it("retains bounded sanitized pre-ban evidence separately from subsequent successful reads", async () => {
  const c = make();
  await c.recordDispatchResponse({ ...request, endpoint: "/fapi/v2/positionRisk?signature=secret", usedWeight1m: 1999, httpStatus: 418 });
  for (let i = 0; i < 260; i++) await c.recordDispatchResponse({ ...request, httpStatus: 200 });
  expect(state().dispatchBudget.recent).toHaveLength(256);
  expect(state().dispatchBudget.lastBanEvidence.at(-1).httpStatus).toBe(418);
  expect(JSON.stringify(state())).not.toContain("secret");
});

it("estimates multi-symbol and heavy requests without treating their cost as one", () => {
  expect(estimateTestnetReadWeight("/fapi/v1/openOrders", new URLSearchParams())).toBe(40);
  expect(estimateTestnetReadWeight("/fapi/v1/klines", new URLSearchParams("limit=1500"))).toBe(10);
  expect(estimateTestnetReadWeight("/fapi/v1/income", new URLSearchParams())).toBe(30);
  expect(estimateTestnetReadWeight("/unknown", new URLSearchParams())).toBe(50);
});

it.each([
  ["/fapi/v1/ticker/24hr", "", 40],
  ["/fapi/v1/ticker/24hr", "symbol=BTCUSDT", 1],
  ["/fapi/v1/premiumIndex", "", 10],
  ["/fapi/v1/premiumIndex", "symbol=BTCUSDT", 1],
  ["/fapi/v1/commissionRate", "symbol=BTCUSDT", 20],
] as const)("uses documented request weight for %s?%s", (endpoint, query, weight) => {
  expect(estimateTestnetReadWeight(endpoint, new URLSearchParams(query))).toBe(weight);
});

it("charges Astra reads to the shared Testnet dispatch budget through the production transport", async () => {
  const fetchImpl = vi.fn(async (rawUrl: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(rawUrl)).pathname;
    return new Response(JSON.stringify(path === "/fapi/v1/time" ? { serverTime: Date.now() }
      : path === "/fapi/v1/commissionRate" ? { symbol: "BTCUSDT", makerCommissionRate: "0", takerCommissionRate: "0.0004" } : []));
  });
  const client = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: "k", apiSecret: "s",
    testnetCoordinatorDir: directory, testReadDispatchGapMs: 0, fetchImpl: fetchImpl as typeof fetch });
  for (const read of [() => client.getAstraTicker24h(), () => client.getAstraPremiumIndexes(), () => client.getAstraCommissionRate("BTCUSDT")]) {
    const pending = read();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  }
  expect(state().dispatchBudget.recent.filter((row: { phase: string }) => row.phase === "DISPATCH")
    .map((row: { endpoint: string; estimatedWeight: number }) => [row.endpoint, row.estimatedWeight])).toEqual([
      ["/fapi/v1/ticker/24hr", 40], ["/fapi/v1/premiumIndex", 10], ["/fapi/v1/time", 1], ["/fapi/v1/commissionRate", 20],
    ]);
  expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it("production GET waits for final budget and mints a fresh signed timestamp AFTER the wait", async () => {
  await make().recordDispatchResponse({ ...request, usedWeight1m: 2200, httpStatus: 200 });
  const urls: string[] = [];
  const client = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: "k", apiSecret: "s",
    testnetCoordinatorDir: directory, testReadDispatchGapMs: 0,
    fetchImpl: vi.fn(async url => { urls.push(String(url)); return new Response("[]", {status:200}); }) as typeof fetch });
  const pending = client.getPositions(undefined, { allowUnsyncedRead: true });
  await vi.advanceTimersByTimeAsync(49_000);
  expect(urls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(3_000);
  await pending;
  expect(urls).toHaveLength(1);
  expect(Number(new URL(urls[0]).searchParams.get("timestamp"))).toBe(start + 52000);
});

it("aborted reads never dispatch", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(make().acquireDispatchBudget(request, () => {}, controller.signal)).rejects.toThrow("aborted");
});

it("does not silently reset a corrupt durable cooldown", async () => {
  writeFileSync(join(directory, "usd-m-testnet-rate-limit.json"), "{broken");
  await expect(make().acquireDispatchBudget(request, () => {})).rejects.toThrow("refusing to erase");
});

it("production reduce-only MARKET bypasses weight wait, but not a venue ban", async () => {
  await make().recordDispatchResponse({ ...request, usedWeight1m: 2300, httpStatus: 200 });
  const calls: string[] = [];
  const client = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: "k", apiSecret: "s",
    testnetCoordinatorDir: directory, testReadDispatchGapMs: 0,
    fetchImpl: vi.fn(async url => { calls.push(String(url)); return new Response('{"orderId":1,"status":"FILLED"}', {status:200}); }) as typeof fetch });
  const order = { symbol: "ARBUSDT", side: "SELL" as const, type: "MARKET" as const, quantity: 1, reduceOnly: true,
    newClientOrderId: "offline-budget-test" };
  await client.placeOrder(order);
  expect(calls).toHaveLength(1);
  expect(Date.now()).toBe(start);
  await make().registerRateLimit({ status: 418, retryUntilMs: start + 120000, failure: "418",
    endpoint: request.endpoint, requestKind: "SIGNED", requestCaller: "test" });
  await expect(client.placeOrder(order)).rejects.toMatchObject({httpStatus:418});
  expect(calls).toHaveLength(1);
});

it("mainnet does not join the Testnet budget or cooldown", async () => {
  await make().registerRateLimit({ status: 418, retryUntilMs: start + 120000, failure: "418",
    endpoint: request.endpoint, requestKind: "SIGNED", requestCaller: "test" });
  const fetchImpl = vi.fn(async () => new Response("[]", {status:200})) as typeof fetch;
  const client = new BinanceFuturesPrivateClient({ env: "mainnet", apiKey: "k", apiSecret: "s",
    testnetCoordinatorDir: directory, testReadDispatchGapMs: 0, fetchImpl });
  await expect(client.getPositions(undefined, {allowUnsyncedRead:true})).resolves.toEqual([]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

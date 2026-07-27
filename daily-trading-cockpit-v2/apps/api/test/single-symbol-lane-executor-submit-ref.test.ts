/**
 * SUBMIT-TIME REFERENCE QUOTE (SingleSymbolPosition.submitRef) — 2026-07-27, recording only.
 *
 * Deliberately a SEPARATE file from single-symbol-lane-executor.test.ts: that file's shared
 * FakeClient is on a frozen clock (`nowIso: () => NOW`), which makes every ageAtSubmitMs
 * identically 0 and therefore makes the one number this feature exists to qualify untestable
 * there. Every fixture here is driven by an ADVANCING injected clock instead.
 *
 * What each case is actually protecting (all four fail against the pre-fix tree, where
 * stampSubmitRef() was defined but never called and `submitRef` was never in the position
 * literal — `pos.submitRef` comes back `undefined`):
 *   1. the age is MEASURED at submit, not assumed and not stamped after the fill;
 *   2. a quote left in the cache by an earlier tick is REJECTED, not passed off as this
 *      submission's benchmark;
 *   3. a throwing quote reader cannot touch the order (same qty/entryPrice/entryOrderId);
 *   4. the reference is never back-filled from the (up to 50-minute-stale) signal price;
 *   5. `venue` is carried through verbatim, never defaulted to something friendlier.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import type {
  FuturesAlgoOrder,
  FuturesOrder,
  FuturesPosition,
  FuturesSymbolFilters,
  FuturesUserTrade,
  PlaceAlgoOrderParams,
  PlaceOrderParams,
} from "../src/lib/binance-futures-private.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type PublicQuoteSnapshot,
  type SingleSymbolExecClient,
  type SingleSymbolFreshSignal,
} from "../src/lib/single-symbol-lane-executor.js";

const T0 = Date.parse("2026-07-27T04:00:00.000Z");

const dirs: string[] = [];
let n = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `ssle-ref-${process.pid}-${++n}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

/** Every awaited exchange call advances the injected clock by a fixed amount, so the wall-clock
 *  gap between the entry-quality gate's quote and the actual placeOrder is REAL in the fixture
 *  rather than assumed — that gap is exactly what ageAtSubmitMs has to capture. */
const ROUND_TRIP_MS = 300;
/** placeOrder→position-literal latency (resolveFillPrice can retry 4x400ms plus 4 queryOrder
 *  round-trips in production). Made deliberately large so a stamp taken in the position literal
 *  instead of before placeOrder produces an obviously different number. */
const POST_SUBMIT_MS = 5_000;

class ClockedFakeClient implements SingleSymbolExecClient {
  clockMs = T0;
  placed: PlaceOrderParams[] = [];
  /** Clock reading at the instant placeOrder was entered — i.e. true submit time. */
  clockAtSubmitMs: number | null = null;

  private orderSeq = 100;
  private algoSeq = 900;

  nowIso = (): string => new Date(this.clockMs).toISOString();

  async getExchangeFilters(): Promise<Map<string, FuturesSymbolFilters>> {
    this.clockMs += ROUND_TRIP_MS;
    return new Map<string, FuturesSymbolFilters>([
      ["BTCUSDT", { symbol: "BTCUSDT", stepSize: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5, pricePrecision: 2, quantityPrecision: 3 }],
    ]);
  }
  async setLeverage(): Promise<void> {
    this.clockMs += ROUND_TRIP_MS;
  }
  async getPositions(): Promise<FuturesPosition[]> {
    this.clockMs += ROUND_TRIP_MS;
    return [];
  }
  async placeOrder(params: PlaceOrderParams): Promise<FuturesOrder> {
    this.clockAtSubmitMs = this.clockMs;
    this.placed.push(params);
    this.clockMs += POST_SUBMIT_MS;
    return {
      symbol: params.symbol, orderId: String(this.orderSeq++), clientOrderId: "", status: "FILLED",
      type: "MARKET", side: params.side, reduceOnly: Boolean(params.reduceOnly), price: 0, stopPrice: 0,
      origQty: params.quantity, executedQty: params.quantity, avgPrice: 59_950, updateTime: 0,
    };
  }
  async queryOrder(symbol: string, orderId: string): Promise<FuturesOrder> {
    this.clockMs += ROUND_TRIP_MS;
    return {
      symbol, orderId, clientOrderId: "", status: "FILLED", type: "MARKET", side: "BUY",
      reduceOnly: false, price: 0, stopPrice: 0, origQty: 0, executedQty: 0, avgPrice: 59_950, updateTime: 0,
    };
  }
  async placeAlgoOrder(params: PlaceAlgoOrderParams): Promise<FuturesAlgoOrder> {
    this.clockMs += ROUND_TRIP_MS;
    return {
      symbol: params.symbol, algoId: String(this.algoSeq++), clientAlgoId: "", algoStatus: "WORKING",
      orderType: params.type, side: params.side, quantity: params.quantity, triggerPrice: params.triggerPrice, actualOrderId: null,
    };
  }
  async queryAlgoOrder(algoId: string): Promise<FuturesAlgoOrder> {
    return {
      symbol: "BTCUSDT", algoId, clientAlgoId: "", algoStatus: "WORKING",
      orderType: "STOP_MARKET", side: "BUY", quantity: 0, triggerPrice: 0, actualOrderId: null,
    };
  }
  async cancelAlgoOrder(): Promise<void> {}
  async getUserTrades(): Promise<FuturesUserTrade[]> {
    return [];
  }
}

function longSignal(over: Partial<SingleSymbolFreshSignal> = {}): SingleSymbolFreshSignal {
  return {
    observationId: "ref:BTCUSDT:1",
    symbol: "BTCUSDT",
    entryPrice: 60_000,
    stopPrice: 58_200, // LONG: stop below entry
    openedAtMs: T0 - 5 * 60_000,
    ...over,
  };
}

function build(opts: {
  client: ClockedFakeClient;
  /** Runs INSIDE the awaited currentPrice call, i.e. between the executor's observeStart clock
   *  read and its use of the returned price — the exact window a real book fetch occupies. */
  currentPrice?: (symbol: string) => Promise<number | null>;
  readPublicQuote?: (symbol: string) => PublicQuoteSnapshot | null;
}) {
  const store = new SingleSymbolLaneExecutorStore(tmpDir(), "test.json");
  const executor = new SingleSymbolLaneExecutor({
    client: opts.client,
    store,
    laneId: "REF_TEST_LANE",
    direction: "LONG",
    getOpenSignals: () => [longSignal()],
    exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => true,
    laneWeightPct: () => 100,
    legUsd: () => 100,
    leverage: () => 3,
    maxOpenPositions: () => 1,
    nowIso: opts.client.nowIso,
    fillConfirmRetryDelayMs: 0,
    ...(opts.currentPrice ? { currentPrice: opts.currentPrice } : {}),
    ...(opts.readPublicQuote ? { readPublicQuote: opts.readPublicQuote } : {}),
  });
  return { executor, store };
}

describe("SingleSymbolPosition.submitRef — submit-time reference quote (recording only)", () => {
  it("[AGE] measures the reference's age AT SUBMIT — not at capture, and not after fill confirmation", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => {
        // A real book fetch costs a round trip; the quote is observed when it RETURNS.
        client.clockMs += ROUND_TRIP_MS;
        quoteAtMs = client.clockMs;
        return 60_050;
      },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("OPEN");
    const ref = pos.submitRef;
    // Fails outright on the pre-fix tree: stampSubmitRef() was never called and `submitRef` was
    // never in the position literal, so this is `undefined`.
    expect(ref).toBeTruthy();
    expect(ref!.source).toBe("BOOK_TICKER");
    expect(ref!.atMs).toBe(quoteAtMs);

    const clockAtSubmit = client.clockAtSubmitMs!;
    // (a) EXACT: the age is the real gap between observing the quote and handing the order to the
    //     exchange. Asserted as a relation rather than a hardcoded constant so it stays honest if
    //     the number of pre-submit round trips changes.
    expect(ref!.ageAtSubmitMs).toBe(clockAtSubmit - quoteAtMs);
    // (b) The gap is NOT zero — a stamp taken at capture time (the tempting simplification) would
    //     report 0 here and silently claim every sample was measured against a live quote.
    expect(ref!.ageAtSubmitMs).toBeGreaterThan(0);
    // (c) ...and NOT inflated by fill confirmation. Stamping in the position literal (which is
    //     built after placeOrder AND after resolveFillPrice) would add POST_SUBMIT_MS.
    expect(ref!.ageAtSubmitMs).toBeLessThan(POST_SUBMIT_MS);
    expect(ref!.ageAtSubmitMs).not.toBe(client.clockMs - quoteAtMs);
  });

  it("[VENUE] carries the producer's venue label verbatim — never defaulted to a friendlier one", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "SOME_OTHER_BOOK" }),
    });

    await executor.tick();

    // The whole point of persisting `venue`: app.ts wires this from Binance SPOT while the orders
    // execute on USD-M perps, so a consumer that cannot see WHICH book a reference came from
    // cannot tell execution slippage from perp/spot basis.
    expect(store.getState().positions[0]!.submitRef!.venue).toBe("SOME_OTHER_BOOK");
  });

  it("[STALE] rejects a quote observed BEFORE this submission's own price fetch started", async () => {
    const client = new ClockedFakeClient();
    // The executor reads its observe-start clock immediately before awaiting currentPrice, so the
    // clock on entry to currentPrice IS observeStartMs.
    let observeStartMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { observeStartMs = client.clockMs; client.clockMs += ROUND_TRIP_MS; return 60_050; },
      // Left behind by an earlier tick: observed one ms before this executor began observing.
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: observeStartMs - 1, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const ref = store.getState().positions[0]!.submitRef!;
    expect(ref.source).toBe("MID_ONLY");
    expect(ref.bid).toBeNull();
    expect(ref.ask).toBeNull();
    // Falls back to the mid currentPrice itself returned, dated at the instant observation STARTED
    // — i.e. the age is deliberately over-stated, never flattered.
    expect(ref.mid).toBe(60_050);
    expect(ref.atMs).toBe(observeStartMs);
    expect(ref.venue).toBe("UNKNOWN");
  });

  it("[STALE-BOUNDARY] a quote observed at EXACTLY observeStart is accepted", async () => {
    const client = new ClockedFakeClient();
    let observeStartMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { observeStartMs = client.clockMs; client.clockMs += ROUND_TRIP_MS; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: observeStartMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    // Pins the guard at `>=`, not `>`: a quote observed in the same millisecond the fetch started
    // is genuinely this submission's, and dropping it would silently thin the dataset.
    const ref = store.getState().positions[0]!.submitRef!;
    expect(ref.source).toBe("BOOK_TICKER");
    expect(ref.atMs).toBe(observeStartMs);
  });

  it("[ONE-SIDED] a book missing one side is MID_ONLY, not BOOK_TICKER", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_040; },
      readPublicQuote: () => ({ bid: 60_040, ask: null, mid: 60_040, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const ref = store.getState().positions[0]!.submitRef!;
    // A one-sided book has no touch price for one of the two directions; calling it BOOK_TICKER
    // would overstate what the record can answer.
    expect(ref.source).toBe("MID_ONLY");
    expect(ref.bid).toBe(60_040);
    expect(ref.ask).toBeNull();
  });

  it("[FAIL-OPEN] a throwing readPublicQuote leaves the order byte-identical and records null", async () => {
    const control = new ClockedFakeClient();
    const c = build({
      client: control,
      currentPrice: async () => { control.clockMs += ROUND_TRIP_MS; return 60_050; },
    });
    await c.executor.tick();
    const good = c.store.getState().positions[0]!;

    const client = new ClockedFakeClient();
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; return 60_050; },
      readPublicQuote: () => { throw new Error("quote cache exploded"); },
    });
    await executor.tick();
    const pos = store.getState().positions[0]!;

    expect(pos.status).toBe("OPEN");
    expect(pos.submitRef).toBeNull();
    // The order itself is unaffected in every dimension the exchange saw.
    expect(pos.qty).toBe(good.qty);
    expect(pos.entryPrice).toBe(good.entryPrice);
    expect(pos.entryOrderId).toBe(good.entryOrderId);
    expect(pos.stopPrice).toBe(good.stopPrice);
    expect(client.placed).toEqual(control.placed);
  });

  it("[NEVER-BACKFILLED] with no price source wired, submitRef is null — not the stale signal price", async () => {
    const client = new ClockedFakeClient();
    // No currentPrice at all: the entry-quality gate is skipped entirely, so this submission has
    // no live reference. signal.entryPrice is up to maxSignalAgeMs (default 50 min) old and must
    // never be dressed up as one.
    const { executor, store } = build({ client });

    await executor.tick();

    const pos = store.getState().positions[0]!;
    expect(pos.status).toBe("OPEN");
    expect(pos.submitRef ?? null).toBeNull();
    expect(JSON.stringify(pos)).not.toContain('"submitRef":{');
  });

  it("[NO-PRICE] currentPrice returning null skips the entry entirely and records nothing", async () => {
    const client = new ClockedFakeClient();
    const { executor, store } = build({
      client,
      currentPrice: async () => null,
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: T0 + 10_000, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    // Pre-existing gate behaviour, asserted here so this feature can never be the reason a
    // no-live-price candidate starts opening: no position, and therefore no reference.
    expect(store.getState().positions).toHaveLength(0);
    expect(client.placed).toHaveLength(0);
  });

  it("[2026-07-27 CROSS-VENUE] a SPOT reference records venueMatchesExecution=false — the caveat is a boolean, not prose in a string", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const ref = store.getState().positions[0]!.submitRef!;
    // This is what app.ts actually wires today. `fill - mid` on these samples contains perp/spot
    // BASIS — routinely tens of bps, an order of magnitude above the 5.0 bps/side commission — so
    // any slippage report must filter on this flag rather than parse the venue string.
    expect(ref.venue).toBe("BINANCE_SPOT_BOOK_TICKER");
    expect(ref.venueMatchesExecution).toBe(false);
  });

  it("[2026-07-27 CROSS-VENUE] the USD-M perp book is the ONLY thing that counts as matching; an unknown label does not", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "BINANCE_FUTURES_BOOK_TICKER" }),
    });
    await executor.tick();
    expect(store.getState().positions[0]!.submitRef!.venueMatchesExecution).toBe(true);

    // No usable cached quote at all ⇒ the mid the gate saw is recorded, but with NO venue label,
    // and an unlabelled book must never claim to be the execution book.
    const client2 = new ClockedFakeClient();
    const h2 = build({
      client: client2,
      currentPrice: async () => { client2.clockMs += ROUND_TRIP_MS; return 60_050; },
      readPublicQuote: () => null,
    });
    await h2.executor.tick();
    const ref2 = h2.store.getState().positions[0]!.submitRef!;
    expect(ref2.venue).toBe("UNKNOWN");
    expect(ref2.source).toBe("MID_ONLY");
    expect(ref2.venueMatchesExecution).toBe(false);
  });

  it("[2026-07-27 CLOCK] a quote stamped AFTER the submit instant is marked, not silently floored to a credible 0", async () => {
    const client = new ClockedFakeClient();
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; return 60_050; },
      // The producer's clock (app.ts's Date.now()) is AHEAD of this executor's injected clock — an
      // NTP step backwards between the book fetch and placeOrder does exactly this.
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: client.clockMs + 60_000, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const ref = store.getState().positions[0]!.submitRef!;
    // Still floored — the field never goes negative.
    expect(ref.ageAtSubmitMs).toBe(0);
    // …but 0 is the single most trustworthy-looking value the field can hold, so a report that
    // correctly keeps only low-age samples would otherwise preferentially retain the corrupt ones.
    expect(ref.clockAnomaly).toBe(true);
  });

  it("[2026-07-27 CLOCK] a normal, positive age carries NO anomaly marker", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });
    await executor.tick();
    const ref = store.getState().positions[0]!.submitRef!;
    expect(ref.ageAtSubmitMs).toBeGreaterThan(0);
    expect(ref.clockAnomaly).toBeUndefined();
  });

  it("[2026-07-27 SHARED-CACHE] a quote whose mid differs from the one the gate evaluated is MARKED as substituted", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      // The gate evaluates 59_950…
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 59_950; },
      // …but the process-wide per-symbol cache has since been overwritten by a SIBLING lane
      // executor's fetch for the same symbol. Its atMs is newer, so the freshness guard accepts it.
      readPublicQuote: () => ({ bid: 59_975, ask: 59_995, mid: 59_985, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });

    await executor.tick();

    const ref = store.getState().positions[0]!.submitRef!;
    expect(ref.mid).toBe(59_985);
    // ~6 bps of pure substitution, otherwise indistinguishable from real slippage in any report.
    expect(ref.midDiffersFromGateMid).toBe(true);
  });

  it("[2026-07-27 SHARED-CACHE] the ordinary case — cache mid === gate mid — carries no substitution marker", async () => {
    const client = new ClockedFakeClient();
    let quoteAtMs = 0;
    const { executor, store } = build({
      client,
      currentPrice: async () => { client.clockMs += ROUND_TRIP_MS; quoteAtMs = client.clockMs; return 60_050; },
      readPublicQuote: () => ({ bid: 60_040, ask: 60_060, mid: 60_050, atMs: quoteAtMs, venue: "BINANCE_SPOT_BOOK_TICKER" }),
    });
    await executor.tick();
    expect(store.getState().positions[0]!.submitRef!.midDiffersFromGateMid).toBeUndefined();
  });
});

/**
 * PER-FILL EXECUTION RECORDER — store unit tests + the client-mapper boundary that feeds it.
 *
 * The whole point of this store is that /fapi/v1/userTrades already tells us the exact price, qty,
 * commission, exchange timestamp, liquidity flag and trade id of every real fill, and all three
 * settlement paths kept two summed scalars and threw the rest away. These tests pin the properties
 * that make the record trustworthy: strings stay strings, "unknown" stays distinguishable from a
 * plausible default, a re-observed fill is not double-booked, and a corrupt file degrades to empty
 * instead of throwing into a caller that is settling a real position.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BinanceFuturesPrivateClient } from "../src/lib/binance-futures-private.js";
import {
  ExecutionFillRecorder,
  FILL_RETENTION_MS,
  MAX_FILLS_PER_RECORD,
  fillDedupKey,
  fillFromUserTrade,
  type ExecutionFill,
  type UserTradeLike,
} from "../src/lib/execution-fill-recorder.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-fills-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function trade(overrides: Partial<UserTradeLike> = {}): UserTradeLike {
  return {
    symbol: "BTCUSDT",
    orderId: "8389766229891298477",
    price: 61800.5,
    qty: 0.001,
    realizedPnl: -1.8,
    commission: 0.0309,
    commissionAsset: "USDT",
    time: 1_700_000_000_000,
    ...overrides,
  };
}

function fill(overrides: Partial<ExecutionFill> = {}): ExecutionFill {
  return { ...fillFromUserTrade(trade(), "EXIT"), ...overrides };
}

describe("fillFromUserTrade (raw row → persisted fill)", () => {
  it("keeps every field the settlement paths used to discard", () => {
    const f = fillFromUserTrade(
      trade({ tradeId: "4021291234", maker: false }),
      "EXIT",
    );
    expect(f).toEqual({
      orderId: "8389766229891298477",
      tradeId: "4021291234",
      symbol: "BTCUSDT",
      role: "EXIT",
      price: 61800.5,
      qty: 0.001,
      commission: 0.0309,
      commissionAsset: "USDT",
      realizedPnl: -1.8,
      time: 1_700_000_000_000,
      maker: false,
    });
  });

  it("orderId and tradeId are STRINGS, byte-exact, for 19-digit input", () => {
    // The -2013 incident: JSON.parse rounds ids of this magnitude. Anything that reaches this
    // function as a string must survive as the SAME string, never round-tripped through Number.
    const big = "8389766229891298477";
    const f = fillFromUserTrade(trade({ orderId: big, tradeId: big }), "ENTRY");
    expect(f.orderId).toBe(big);
    expect(f.tradeId).toBe(big);
    expect(typeof f.orderId).toBe("string");
    expect(typeof f.tradeId).toBe("string");
    // Sanity: prove the rounding this guards against is real for this input.
    expect(String(Number(big))).not.toBe(big);
  });

  it("an absent maker stays null and is DISTINGUISHABLE from a confirmed taker fill", () => {
    // `false` is exactly the value the live path expects (MARKET/STOP_MARKET only), so coercing an
    // absent field to false would fabricate the confirmation the field exists to supply.
    expect(fillFromUserTrade(trade(), "EXIT").maker).toBeNull();
    expect(fillFromUserTrade(trade(), "EXIT").maker).not.toBe(false);
    expect(fillFromUserTrade(trade({ maker: false }), "EXIT").maker).toBe(false);
    expect(fillFromUserTrade(trade({ maker: true }), "EXIT").maker).toBe(true);
    // Non-boolean garbage is unknown, not truthy.
    expect(fillFromUserTrade(trade({ maker: "true" }), "EXIT").maker).toBeNull();
  });

  it("an absent or empty tradeId is null (never \"\"), and a numeric one is stringified", () => {
    expect(fillFromUserTrade(trade(), "EXIT").tradeId).toBeNull();
    // toStrId() in the client yields "" when the exchange reported nothing — that must NOT become
    // a dedup key, or every keyless fill would collapse onto one identity.
    expect(fillFromUserTrade(trade({ tradeId: "" }), "EXIT").tradeId).toBeNull();
    expect(fillFromUserTrade(trade({ tradeId: 4021291234 }), "EXIT").tradeId).toBe("4021291234");
  });

  it("a malformed row degrades to zeros instead of throwing into a settling caller", () => {
    const f = fillFromUserTrade(
      { ...trade(), price: Number.NaN, qty: undefined as unknown as number, commission: "x" as unknown as number },
      "UNKNOWN",
    );
    expect(f.price).toBe(0);
    expect(f.qty).toBe(0);
    expect(f.commission).toBe(0);
    expect(f.role).toBe("UNKNOWN");
  });
});

describe("fillDedupKey", () => {
  it("prefers the exchange's own trade id, and falls back to the tuple when it is missing", () => {
    expect(fillDedupKey(fill({ tradeId: "991" }))).toBe("t:BTCUSDT|991");
    const tupleKey = fillDedupKey(fill({ tradeId: null }));
    expect(tupleKey.startsWith("o:")).toBe(true);
    // Two fills of the SAME order at different prices are distinct under the fallback.
    expect(fillDedupKey(fill({ tradeId: null, price: 1 }))).not.toBe(fillDedupKey(fill({ tradeId: null, price: 2 })));
  });

  it("[2026-07-27] is SYMBOL-SCOPED — Binance's userTrades `id` is a per-symbol counter, not a global one", () => {
    // Two different symbols legitimately carrying the same trade id must NOT collapse to one key.
    expect(fillDedupKey(fill({ symbol: "ADAUSDT", tradeId: "412300551" })))
      .not.toBe(fillDedupKey(fill({ symbol: "AVAXUSDT", tradeId: "412300551" })));
    // The tuple fallback is scoped identically (orderId already implied the symbol, but uniformly).
    expect(fillDedupKey(fill({ symbol: "ADAUSDT", tradeId: null })))
      .not.toBe(fillDedupKey(fill({ symbol: "AVAXUSDT", tradeId: null })));
  });

  it("[2026-07-27] a MULTI-SYMBOL record keeps both colliding-id fills instead of silently dropping one", () => {
    // This is the xsec writer's shape: ONE record spanning a whole basket, each fill carrying its
    // own symbol. Before symbol-scoping, the second fill hit `seen.has(key)` in recordFills and was
    // discarded WITHOUT setting `truncated` — an 11-of-12 fill list that reads as complete.
    const r = new ExecutionFillRecorder(tmp());
    r.recordFills({
      recordId: "xsec:LANE:basket-1",
      source: "xsec",
      laneId: "LANE",
      symbol: "ADAUSDT+AVAXUSDT",
      closedAtMs: 1_700_000_000_000,
      fetchComplete: true,
      fills: [
        fill({ symbol: "ADAUSDT", orderId: "1", tradeId: "412300551", commission: 0.011 }),
        fill({ symbol: "AVAXUSDT", orderId: "2", tradeId: "412300551", commission: 0.022 }),
      ],
    });
    const rec = r.getRecord("xsec:LANE:basket-1");
    expect(rec?.fills.length).toBe(2);
    expect(rec?.truncated).toBe(false);
    expect(rec?.fills.map((f) => f.symbol).sort()).toEqual(["ADAUSDT", "AVAXUSDT"]);
    // And the basket's commission sum is whole, not one leg short.
    expect(rec?.fills.reduce((s, f) => s + f.commission, 0)).toBeCloseTo(0.033, 10);
  });
});

describe("ExecutionFillRecorder", () => {
  it("records a close and returns it by recordId", () => {
    const r = new ExecutionFillRecorder(tmp());
    expect(
      r.recordFills({
        recordId: "ssle:LANE:pos-1",
        source: "ssle",
        laneId: "LANE",
        symbol: "BTCUSDT",
        closedAtMs: 1_700_000_000_000,
        fetchComplete: true,
        fills: [fillFromUserTrade(trade({ tradeId: "1" }), "ENTRY"), fillFromUserTrade(trade({ tradeId: "2", price: 61999 }), "EXIT")],
      }),
    ).toBe(true);
    const rec = r.getRecord("ssle:LANE:pos-1")!;
    expect(rec.fills.map((f) => f.role)).toEqual(["ENTRY", "EXIT"]);
    expect(rec.fills.find((f) => f.role === "EXIT")!.price).toBe(61999);
    expect(rec.fetchComplete).toBe(true);
    expect(rec.truncated).toBe(false);
  });

  it("an EMPTY fill list records nothing — 'no record' is honest, an empty record reads as 'no fills'", () => {
    const r = new ExecutionFillRecorder(tmp());
    expect(
      r.recordFills({ recordId: "x", source: "engine", laneId: "L", symbol: "S", closedAtMs: 1, fetchComplete: true, fills: [] }),
    ).toBe(false);
    expect(r.getRecord("x")).toBeNull();
    expect(r.hasRecorded("x")).toBe(false);
  });

  it("is IDEMPOTENT across repeated observations of the same close (a partial-fill cycle re-queries the same rows)", () => {
    const r = new ExecutionFillRecorder(tmp());
    const rows = [fillFromUserTrade(trade({ tradeId: "1" }), "ENTRY"), fillFromUserTrade(trade({ tradeId: "2" }), "EXIT")];
    const input = { recordId: "k", source: "ssle" as const, laneId: "L", symbol: "BTCUSDT", closedAtMs: 10, fetchComplete: true };
    r.recordFills({ ...input, fills: rows });
    r.recordFills({ ...input, fills: rows });
    r.recordFills({ ...input, fills: [...rows, fillFromUserTrade(trade({ tradeId: "3" }), "EXIT")] });
    // Without fillDedupKey this would be 2 + 2 + 3 = 7.
    expect(r.getRecord("k")!.fills.length).toBe(3);
  });

  it("dedups on the TUPLE when the exchange supplied no trade id", () => {
    const r = new ExecutionFillRecorder(tmp());
    const row = fillFromUserTrade(trade(), "EXIT"); // tradeId → null
    const input = { recordId: "k", source: "engine" as const, laneId: "L", symbol: "BTCUSDT", closedAtMs: 10, fetchComplete: true };
    r.recordFills({ ...input, fills: [row] });
    r.recordFills({ ...input, fills: [row] });
    expect(r.getRecord("k")!.fills.length).toBe(1);
  });

  it("MAX_FILLS_PER_RECORD truncates LOUDLY (truncated flag), never silently", () => {
    const r = new ExecutionFillRecorder(tmp());
    const many = Array.from({ length: MAX_FILLS_PER_RECORD + 5 }, (_, i) =>
      fillFromUserTrade(trade({ tradeId: String(i) }), "EXIT"),
    );
    r.recordFills({ recordId: "k", source: "xsec", laneId: "L", symbol: "S", closedAtMs: 1, fetchComplete: true, fills: many });
    const rec = r.getRecord("k")!;
    expect(rec.fills.length).toBe(MAX_FILLS_PER_RECORD);
    expect(rec.truncated).toBe(true);
  });

  it("fetchComplete LATCHES true — a later partial re-observation cannot un-mark a complete list", () => {
    const r = new ExecutionFillRecorder(tmp());
    const base = { recordId: "k", source: "engine" as const, laneId: "L", symbol: "S", closedAtMs: 1 };
    r.recordFills({ ...base, fetchComplete: false, fills: [fillFromUserTrade(trade({ tradeId: "1" }), "ENTRY")] });
    expect(r.getRecord("k")!.fetchComplete).toBe(false);
    r.recordFills({ ...base, fetchComplete: true, fills: [fillFromUserTrade(trade({ tradeId: "2" }), "EXIT")] });
    expect(r.getRecord("k")!.fetchComplete).toBe(true);
    r.recordFills({ ...base, fetchComplete: false, fills: [fillFromUserTrade(trade({ tradeId: "3" }), "EXIT")] });
    expect(r.getRecord("k")!.fetchComplete).toBe(true);
  });

  it("persists to disk and reloads with strings intact", () => {
    const dir = tmp();
    const big = "8389766229891298477";
    const r1 = new ExecutionFillRecorder(dir);
    r1.recordFills({
      recordId: "k",
      source: "engine",
      laneId: "L",
      symbol: "BTCUSDT",
      closedAtMs: 1_700_000_000_000,
      fetchComplete: true,
      fills: [fillFromUserTrade(trade({ orderId: big, tradeId: big, price: 61999.25 }), "EXIT")],
    });
    // The persisted JSON itself must carry them as quoted strings, not numbers.
    const raw = readFileSync(resolve(dir, "execution-fills.json"), "utf-8");
    expect(raw).toContain(`"orderId":"${big}"`);
    expect(raw).toContain(`"tradeId":"${big}"`);

    const r2 = new ExecutionFillRecorder(dir);
    const f = r2.getRecord("k")!.fills[0]!;
    expect(f.orderId).toBe(big);
    expect(f.tradeId).toBe(big);
    expect(f.price).toBe(61999.25);
  });

  it("a corrupt store file degrades to empty and never throws (bookkeeping restarts; trading unaffected)", () => {
    const dir = tmp();
    writeFileSync(resolve(dir, "execution-fills.json"), "{not json", "utf-8");
    let r: ExecutionFillRecorder | null = null;
    expect(() => {
      r = new ExecutionFillRecorder(dir);
    }).not.toThrow();
    expect(r!.listRecords()).toEqual([]);
    // …and it is still usable afterwards.
    expect(
      r!.recordFills({ recordId: "k", source: "ssle", laneId: "L", symbol: "S", closedAtMs: 1, fetchComplete: true, fills: [fill()] }),
    ).toBe(true);
  });

  it("pruneExpired drops records past the retention horizon and keeps the rest", () => {
    const r = new ExecutionFillRecorder(tmp());
    const now = 1_800_000_000_000;
    r.recordFills({ recordId: "old", source: "ssle", laneId: "L", symbol: "S", closedAtMs: now - FILL_RETENTION_MS - 1, fetchComplete: true, fills: [fill({ tradeId: "a" })] });
    r.recordFills({ recordId: "new", source: "ssle", laneId: "L", symbol: "S", closedAtMs: now - 1000, fetchComplete: true, fills: [fill({ tradeId: "b" })] });
    expect(r.pruneExpired(now)).toBe(1);
    expect(r.listRecords().map((x) => x.recordId)).toEqual(["new"]);
    expect(r.hasRecorded("old")).toBe(false);
  });
});

describe("[USER-TRADES] the client mapper supplies tradeId (Binance's per-fill `id`)", () => {
  it("maps `id` to a STRING tradeId, and leaves it empty when the exchange omitted it", async () => {
    // Real /fapi/v1/userTrades shape. Row 1 carries the per-fill id; row 2 omits it entirely.
    // Without the mapper change, tradeId is `undefined` on BOTH rows and fillDedupKey falls back
    // to the tuple heuristic for every fill the account ever makes.
    const rawTradesBody = JSON.stringify([
      { symbol: "BTCUSDT", id: 4021291234, orderId: "8389766229891298477", price: "61800.5", qty: "0.001", realizedPnl: "-1.8", commission: "0.0309", commissionAsset: "USDT", time: 1_700_000_000_000, maker: false },
      { symbol: "BTCUSDT", orderId: "8389766229891298478", price: "61801.0", qty: "0.001", realizedPnl: "0", commission: "0.0123", commissionAsset: "USDT", time: 1_700_000_000_001, maker: false },
    ]);
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/fapi/v1/time")) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      }
      return new Response(rawTradesBody, { status: 200 });
    }) as typeof fetch;

    const client = new BinanceFuturesPrivateClient({ apiKey: "k", apiSecret: "s", env: "testnet", fetchImpl });
    const trades = await client.getUserTrades("BTCUSDT", { startTime: 1, limit: 1000 });

    expect(trades[0]!.tradeId).toBe("4021291234");
    expect(typeof trades[0]!.tradeId).toBe("string");
    expect(trades[1]!.tradeId).toBe(""); // absent — toStrId's honest empty, never a fabricated id

    // …and the whole client → persisted-fill boundary carries it through, with the empty one
    // becoming null so it cannot be used as a dedup key.
    expect(fillFromUserTrade(trades[0]!, "EXIT").tradeId).toBe("4021291234");
    expect(fillFromUserTrade(trades[1]!, "EXIT").tradeId).toBeNull();
    // Symbol-scoped: the exchange id is only unique WITHIN a symbol (2026-07-27).
    expect(fillDedupKey(fillFromUserTrade(trades[0]!, "EXIT"))).toBe("t:BTCUSDT|4021291234");
  });
});

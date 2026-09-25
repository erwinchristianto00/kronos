import { describe, it, expect } from "vitest";
import { entryExecutionQuoteReason } from "../src/lib/cross-entry-execution-quote.js";
const good = { bid: 99.99, ask: 100.01, mid: 100, atMs: 10000, venue: "BINANCE_USDM_BOOK_TICKER" };
describe("entry quote validity", () => {
  it("accepts fresh execution quotes", () => expect(entryExecutionQuoteReason(good, 10000)).toBeNull());
  it.each([{atMs: 10001}, {atMs: 0}, {bid: NaN}, {ask: Infinity}, {bid: 101}, {mid: 105}, {venue: "BINANCE_SPOT_BOOK_TICKER"}])("fails closed on invalid book %j", patch => {
    expect(entryExecutionQuoteReason({...good, ...patch}, 10000)).toBe("ENTRY_EXECUTION_QUOTE_UNAVAILABLE");
  });
  it("rejects an expensive valid book", () => expect(entryExecutionQuoteReason({...good,bid:99,ask:101},10000)).toBe("ENTRY_EXECUTION_SPREAD_TOO_WIDE"));
});

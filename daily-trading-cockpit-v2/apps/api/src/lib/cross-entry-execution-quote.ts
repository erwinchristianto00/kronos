import type { PublicQuoteLike } from "./submit-reference-quote.js";
import { THREE_LEG_QUALITY_LIMITS } from "./three-leg-symbol-quality.js";

export const ENTRY_EXECUTION_QUOTE_POLICY = "testnet-cross-entry-quote-v1";

// Reuse the existing Testnet three-leg execution limits (5s, 10bps), not a
// fitted prediction of profit. This controls execution quality, not strategy alpha.
export function entryExecutionQuoteReason(quote: PublicQuoteLike | null, nowMs: number): string | null {
  if (!quote || !Number.isFinite(nowMs) || !Number.isFinite(quote.atMs)
    || quote.atMs > nowMs || nowMs - quote.atMs > THREE_LEG_QUALITY_LIMITS.maxQuoteAgeMs
    || quote.venue !== "BINANCE_USDM_BOOK_TICKER"
    || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || !Number.isFinite(quote.mid)
    || !(quote.bid! > 0) || !(quote.ask! >= quote.bid!)
    || quote.mid < quote.bid! || quote.mid > quote.ask!) return "ENTRY_EXECUTION_QUOTE_UNAVAILABLE";
  return (quote.ask! - quote.bid!) / quote.bid! * 10_000 > THREE_LEG_QUALITY_LIMITS.maxSpreadBps
    ? "ENTRY_EXECUTION_SPREAD_TOO_WIDE" : null;
}

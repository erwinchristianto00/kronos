/**
 * Submit-time reference quote — the ONE thing whose absence makes execution slippage undefinable.
 *
 * 2026-07-27 established that this system could not measure slippage at all: no submit-time
 * reference quote existed anywhere, `ExecutionLifecycleEvent` carries no price field, and for a
 * MARKET order "intended price" therefore does not exist. The single-symbol executor has since
 * grown its own `submitRef`; the cross-sectional executor has not, so its legs could only ever be
 * compared against `plan.refPrice`, which is Binance's MARK price taken from getPositions().
 *
 * Mark is not the book. A market BUY lifts the ask, so `fill - mark` contains half the spread as
 * well as any real slippage, and the two cannot be separated after the fact. Measured on the
 * cross-sectional legs, that composite is +4.14 bps on LONG and -6.47 bps on SHORT — opposite-
 * signed, which is the signature of genuinely crossing a spread rather than of decision-latency
 * drift (the test that showed the single-symbol lane's `plannedEntryPrice` comparison was drift:
 * LONG -1.59 and SHORT -27.14, same sign on both).
 *
 * With a two-sided book quote captured at submit, the two become separable:
 *     spread cost = |touch - mid|      (unavoidable, taker)
 *     slippage    = |fill  - touch|    (what execution quality actually controls)
 *
 * Pure and import-free on purpose: the executor patch is then one call, and every branch here is
 * testable without an exchange.
 */

export interface PublicQuoteLike {
  bid: number | null;
  ask: number | null;
  mid: number;
  atMs: number;
  venue?: string;
}

export interface SubmitRef {
  mid: number;
  bid: number | null;
  ask: number | null;
  atMs: number;
  /** Sampled immediately before placeOrder, minus atMs. Floored at 0 — see `clockAnomaly`. */
  ageAtSubmitMs: number;
  venue: string;
  source: "BOOK_TICKER" | "MID_ONLY";
  /** False ⇒ the reference book is NOT the book this order executes on (e.g. SPOT vs USD-M perp),
   *  so `fill - mid` contains basis — routinely tens of bps on a mid-cap alt, an order of magnitude
   *  larger than the 4 bps/side commission. Any slippage report MUST filter on this or model the
   *  basis; it must never average across both. An unlabelled venue is treated as NOT matching. */
  venueMatchesExecution: boolean;
  /** Present and true ONLY when the raw age was NEGATIVE. `ageAtSubmitMs` is then 0, which is the
   *  most trustworthy-looking value the field can hold, so without this marker a report that keeps
   *  only low-age samples would preferentially retain exactly the corrupted ones. */
  clockAnomaly?: true;
  /** The touch price this order actually crosses: ask for a BUY, bid for a SELL. Null when the
   *  quote is one-sided. Recording it here means a later report never has to re-derive the side. */
  touch: number | null;
}

/** Books this order can actually execute against. An unlabelled venue is NOT one of them. */
export const EXECUTION_VENUES: ReadonlySet<string> = new Set(["BINANCE_USDM_BOOK_TICKER"]);

/**
 * Build the side-independent part of the reference.
 *
 * `observeStartMs` is the instant this submission began looking for a price. A quote older than
 * that belongs to some earlier submission (the cache is shared process-wide) and is rejected
 * rather than recorded — a stale reference that LOOKS live is worse than no reference, because it
 * silently biases every slippage number computed from it.
 */
export function buildSubmitRefBase(
  quote: PublicQuoteLike | null | undefined,
  observeStartMs: number,
  side: "LONG" | "SHORT",
): Omit<SubmitRef, "ageAtSubmitMs"> | null {
  try {
    if (!quote) return null;
    if (!Number.isFinite(quote.atMs) || quote.atMs < observeStartMs) return null;
    if (!(typeof quote.mid === "number" && Number.isFinite(quote.mid) && quote.mid > 0)) return null;
    const bid = typeof quote.bid === "number" && Number.isFinite(quote.bid) && quote.bid > 0 ? quote.bid : null;
    const ask = typeof quote.ask === "number" && Number.isFinite(quote.ask) && quote.ask > 0 ? quote.ask : null;
    const venue = typeof quote.venue === "string" && quote.venue.length > 0 ? quote.venue : "UNKNOWN";
    // Only a genuinely TWO-SIDED quote earns BOOK_TICKER: a one-sided book gives no touch price for
    // one of the two directions, so calling it a book quote would overstate what the record answers.
    const twoSided = bid !== null && ask !== null;
    return {
      mid: quote.mid,
      bid,
      ask,
      atMs: quote.atMs,
      venue,
      source: twoSided ? "BOOK_TICKER" : "MID_ONLY",
      venueMatchesExecution: EXECUTION_VENUES.has(venue),
      touch: side === "LONG" ? ask : bid,
    };
  } catch {
    return null;
  }
}

/** Stamp the age at the actual submit instant. Never throws; a failure records nothing. */
export function stampSubmitRef(
  base: Omit<SubmitRef, "ageAtSubmitMs"> | null,
  nowMs: number,
): SubmitRef | null {
  try {
    if (!base) return null;
    if (!Number.isFinite(nowMs)) return null;
    const rawAgeMs = nowMs - base.atMs;
    return {
      ...base,
      ageAtSubmitMs: Math.max(0, rawAgeMs),
      ...(rawAgeMs < 0 ? { clockAnomaly: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Decompose a fill against its reference into the two costs that behave differently.
 *
 * Returns null unless the reference is a two-sided quote from the EXECUTION venue — anything else
 * cannot separate spread from slippage, and returning a number anyway is how a basis or a
 * one-sided book ends up averaged into a "slippage" figure.
 *
 * Both components are ADVERSE-POSITIVE: paying more to buy, or receiving less to sell.
 */
export function decomposeFillCost(
  fillPrice: number,
  ref: SubmitRef | null | undefined,
  side: "LONG" | "SHORT",
): { spreadBps: number; slippageBps: number; totalBps: number } | null {
  if (!ref || ref.source !== "BOOK_TICKER" || !ref.venueMatchesExecution) return null;
  if (!(Number.isFinite(fillPrice) && fillPrice > 0)) return null;
  if (ref.touch === null || !(ref.mid > 0)) return null;
  const sgn = side === "LONG" ? 1 : -1;
  const spreadBps = (sgn * (ref.touch - ref.mid) / ref.mid) * 10000;
  const slippageBps = (sgn * (fillPrice - ref.touch) / ref.mid) * 10000;
  return { spreadBps, slippageBps, totalBps: spreadBps + slippageBps };
}

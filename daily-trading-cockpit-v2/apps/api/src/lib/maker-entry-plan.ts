/**
 * Rules for filling a basket leg as MAKER instead of crossing the spread.
 *
 * WHY THIS EXISTS. Every fill this account has ever made is taker: 231 recorded fills, all with
 * Binance's own `maker: false`, at a flat 4.00 bps/side — 8.08 bps round trip on the cross-basket
 * lane. The lane's measured gross edge is ~11 bps. Commission alone eats most of it, so the
 * cheapest available improvement is not a better signal, it is not paying the taker side.
 *
 * WHY IT IS A SEPARATE, IMPORT-FREE MODULE. The dangerous part of maker execution is not the
 * order — it is deciding what to do when a post-only order half-fills and then has to be cancelled.
 * Guessing wrong in either direction is a real-money error: guess "nothing filled" and the taker
 * fallback DOUBLES the position; guess "everything filled" and the basket silently carries a short
 * leg, which for a market-neutral basket means naked directional exposure. Those rules are pure
 * functions of (requested, status, executed), so they are decided here, under test, rather than
 * inline in an executor whose I/O cannot be exercised.
 *
 * THE THREE-VALUED RESULT IS THE POINT. `UNKNOWN_REQUERY` is not a failure mode, it is the honest
 * third answer: a CANCELED order whose executedQty the exchange did not report tells us nothing,
 * and the only safe move is to ask again rather than to pick the convenient assumption. If it is
 * still unknown after re-querying, the caller must place NO fallback — an unfilled leg costs a
 * missed basket, a double-filled one costs real money.
 */

/** What the caller should do with a post-only leg once it has stopped resting. */
export interface MakerLegResolution {
  action: "DONE" | "FALLBACK_TAKER" | "UNKNOWN_REQUERY";
  /** Maker-filled quantity to book. Only meaningful for DONE and FALLBACK_TAKER. */
  filledQty: number;
  /** Quantity the caller must still cross the spread for. Zero unless FALLBACK_TAKER. */
  fallbackQty: number;
  /** Short, human-readable reason — carried into logs and the basket record, never inferred later. */
  reason: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Terminal statuses: the order is no longer resting and its executedQty is final. */
const TERMINAL_FILLED = new Set(["FILLED"]);
const TERMINAL_DEAD = new Set(["CANCELED", "EXPIRED", "REJECTED"]);

/**
 * Price to post so the order ADDS liquidity rather than crossing.
 *
 * Joins the near touch: a BUY rests at the bid, a SELL at the ask. Neither crosses, so Binance's
 * GTX (post-only) accepts them; anything more aggressive would be rejected outright, and anything
 * less aggressive trades queue position for a worse price with no fee benefit.
 *
 * Returns null when the book is unusable — a missing side, a non-positive price, or a crossed book
 * (bid >= ask, which real feeds do produce transiently). The caller must then place its normal
 * taker order rather than invent a price: a limit derived from a broken book is how an order ends
 * up resting far from the market and never filling.
 */
export function makerLimitPrice(
  side: "LONG" | "SHORT",
  bid: number | null | undefined,
  ask: number | null | undefined,
): number | null {
  if (!isNum(bid) || !isNum(ask) || bid <= 0 || ask <= 0) return null;
  if (bid >= ask) return null;
  return side === "LONG" ? bid : ask;
}

/**
 * What to do with a post-only leg that is no longer resting.
 *
 * `executedQty` is what the exchange reported AFTER the cancel round-trip — never the value read
 * before it. An order can fill in the window between the timeout expiring and the cancel landing,
 * and sizing a fallback from the pre-cancel figure is exactly how that race turns into a double
 * position.
 *
 * `tolerance` absorbs lot-step float noise only. It must stay far below one lot step; it is not a
 * "close enough" allowance for a genuinely short fill.
 */
export function resolveMakerLeg(
  requestedQty: number,
  status: string | null | undefined,
  executedQty: number | null | undefined,
  tolerance = 1e-9,
): MakerLegResolution {
  if (!isNum(requestedQty) || requestedQty <= 0) {
    return { action: "UNKNOWN_REQUERY", filledQty: 0, fallbackQty: 0, reason: "requested qty unusable" };
  }
  const st = typeof status === "string" ? status.toUpperCase() : "";
  const known = isNum(executedQty) && executedQty >= 0;

  // A FILLED status is authoritative even when executedQty comes back 0 — Binance's ACK does that,
  // and this file's sibling executors already work around the same quirk for avgPrice.
  if (TERMINAL_FILLED.has(st)) {
    return { action: "DONE", filledQty: known && executedQty! > 0 ? executedQty! : requestedQty, fallbackQty: 0, reason: "maker filled in full" };
  }

  if (TERMINAL_DEAD.has(st)) {
    if (!known) {
      return { action: "UNKNOWN_REQUERY", filledQty: 0, fallbackQty: 0, reason: `${st} without an executedQty — cannot size a fallback` };
    }
    const remainder = requestedQty - executedQty!;
    if (remainder <= tolerance) {
      return { action: "DONE", filledQty: requestedQty, fallbackQty: 0, reason: `${st} after filling in full` };
    }
    if (executedQty! <= tolerance) {
      return { action: "FALLBACK_TAKER", filledQty: 0, fallbackQty: requestedQty, reason: `${st} unfilled — crossing for the whole leg` };
    }
    return { action: "FALLBACK_TAKER", filledQty: executedQty!, fallbackQty: remainder, reason: `${st} partially filled — crossing for the remainder` };
  }

  // NEW / PARTIALLY_FILLED / anything unrecognised: still live, or a status this code has never
  // seen. Either way the quantity is not final, so no fallback may be sized from it.
  return { action: "UNKNOWN_REQUERY", filledQty: 0, fallbackQty: 0, reason: st ? `non-terminal status ${st}` : "no status reported" };
}

/**
 * Realised commission in basis points of notional, for the before/after this change exists to
 * settle. `maker === undefined` means the exchange did not report a liquidity flag; such fills are
 * EXCLUDED from the ratio rather than bucketed as taker, because `false` is the value we expect and
 * folding unknowns into it would destroy the only thing the flag is for.
 */
export function commissionBpsByLiquidity(
  fills: ReadonlyArray<{ price: number; qty: number; commission: number; maker?: boolean }>,
): { maker: { n: number; bps: number | null }; taker: { n: number; bps: number | null }; unreported: number } {
  const bucket = (want: boolean) => {
    const rows = fills.filter(
      (f) => f.maker === want && isNum(f.price) && isNum(f.qty) && isNum(f.commission) && f.price > 0 && f.qty > 0,
    );
    const notional = rows.reduce((s, f) => s + f.price * f.qty, 0);
    return { n: rows.length, bps: notional > 0 ? (rows.reduce((s, f) => s + f.commission, 0) / notional) * 10_000 : null };
  };
  return { maker: bucket(true), taker: bucket(false), unreported: fills.filter((f) => f.maker === undefined).length };
}

/**
 * Nets in-flight post-only ENTRY orders into a signed per-symbol claim: LONG positive, SHORT
 * negative — the same convention positions and basket legs use, because reconcile() compares this
 * against `positionAmt` straight off the exchange.
 *
 * 2026-08-17. Pure and exported for one reason: when this lived inline in the executor its only
 * test faked the whole method, so a mutation that dropped the SHORT negation survived untouched.
 * A resting SHORT counted as +qty makes reconcile explain a position on the WRONG SIDE of the book,
 * which is the exact class of foreign position the orphan check exists to catch.
 */
export function signedMakerEntryQtyBySymbol(
  entries: Iterable<{ symbol: string; direction: "LONG" | "SHORT"; qty: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of entries) {
    const signed = entry.direction === "LONG" ? entry.qty : -entry.qty;
    out.set(entry.symbol, (out.get(entry.symbol) ?? 0) + signed);
  }
  return out;
}

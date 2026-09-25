/**
 * Controlled, temporary Daily Range access to the unused part of MOM36.
 *
 * Binance USD-M is one-way/netted.  This policy never lends an active basket
 * leg (including a planned-but-not-yet-filled leg), and it returns every MOM36
 * symbol to Cross-Sectional one hour before the earliest active basket's
 * scheduled exit.  It only controls NEW Daily Range entries; a pre-existing
 * Daily trade keeps its own exchange-native protection and is never flattened
 * just because the symbol is returned to Cross-Sectional.
 */

export const DAILY_RANGE_CROSS_SECTIONAL_BORROW_POLICY_ID = "DAILY_RANGE_MOM36_UNUSED_BORROW_V1" as const;
export const DAILY_RANGE_CROSS_SECTIONAL_RETURN_LEAD_MS = 60 * 60_000;

export interface DailyRangeCrossSectionalBorrowBasket {
  basketId: string;
  /** The frozen execution horizon / displayed basket deadline. */
  closesAtMs: number | null;
  /** Filled, planned, and orphaned legs are all reserved from Daily Range. */
  symbols: readonly string[];
}

export type DailyRangeCrossSectionalBorrowState =
  | "NO_ACTIVE_CROSS_SECTIONAL_BASKET"
  | "BORROWING_ACTIVE"
  | "RETURNED_TO_CROSS_SECTIONAL";

export interface DailyRangeCrossSectionalBorrowDecision {
  policyId: typeof DAILY_RANGE_CROSS_SECTIONAL_BORROW_POLICY_ID;
  state: DailyRangeCrossSectionalBorrowState;
  /** Full normalized MOM36 universe, retained for the entry-time gate. */
  crossSectionalSymbols: string[];
  /** Symbols that Daily Range must present to its C6 overlap guard. */
  reservedCrossSectionalSymbols: string[];
  /** The only MOM36 symbols that may be added to the Daily Range candidates. */
  borrowableSymbols: string[];
  activeBasketCount: number;
  earliestBasketCloseAtMs: number | null;
  returnAtMs: number | null;
  reason: string;
}

export interface DailyRangeSymbolEntryGateDecision {
  allowed: boolean;
  reason: string | null;
}

function normalizeSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();
}

/**
 * Resolve the exact borrow set from live, persisted Cross-Sectional exposure.
 * An unparseable basket deadline fails closed: the whole MOM36 universe is
 * returned instead of guessing whether an overlap is about to occur.
 */
export function resolveDailyRangeCrossSectionalBorrowing(input: {
  crossSectionalUniverse: readonly string[];
  activeBaskets: readonly DailyRangeCrossSectionalBorrowBasket[];
  nowMs: number;
}): DailyRangeCrossSectionalBorrowDecision {
  const crossSectionalSymbols = normalizeSymbols(input.crossSectionalUniverse);
  const crossSet = new Set(crossSectionalSymbols);
  const activeBaskets = input.activeBaskets;
  if (activeBaskets.length === 0) {
    return {
      policyId: DAILY_RANGE_CROSS_SECTIONAL_BORROW_POLICY_ID,
      state: "NO_ACTIVE_CROSS_SECTIONAL_BASKET",
      crossSectionalSymbols,
      reservedCrossSectionalSymbols: crossSectionalSymbols,
      borrowableSymbols: [],
      activeBasketCount: 0,
      earliestBasketCloseAtMs: null,
      returnAtMs: null,
      reason: "no active Cross-Sectional basket; MOM36 remains reserved for its own lane",
    };
  }

  const reservedFromBaskets = new Set<string>();
  let earliestBasketCloseAtMs = Number.POSITIVE_INFINITY;
  let hasUnknownDeadline = false;
  for (const basket of activeBaskets) {
    for (const symbol of normalizeSymbols(basket.symbols)) {
      if (crossSet.has(symbol)) reservedFromBaskets.add(symbol);
    }
    if (basket.closesAtMs === null || !Number.isFinite(basket.closesAtMs) || basket.closesAtMs <= 0) {
      hasUnknownDeadline = true;
    } else {
      earliestBasketCloseAtMs = Math.min(earliestBasketCloseAtMs, basket.closesAtMs);
    }
  }

  const returnAtMs = Number.isFinite(earliestBasketCloseAtMs)
    ? earliestBasketCloseAtMs - DAILY_RANGE_CROSS_SECTIONAL_RETURN_LEAD_MS
    : null;
  const returnToCrossSectional = hasUnknownDeadline || returnAtMs === null || input.nowMs >= returnAtMs;
  if (returnToCrossSectional) {
    return {
      policyId: DAILY_RANGE_CROSS_SECTIONAL_BORROW_POLICY_ID,
      state: "RETURNED_TO_CROSS_SECTIONAL",
      crossSectionalSymbols,
      reservedCrossSectionalSymbols: crossSectionalSymbols,
      borrowableSymbols: [],
      activeBasketCount: activeBaskets.length,
      earliestBasketCloseAtMs: Number.isFinite(earliestBasketCloseAtMs) ? earliestBasketCloseAtMs : null,
      returnAtMs,
      reason: hasUnknownDeadline
        ? "active Cross-Sectional basket has no trustworthy deadline; MOM36 returned fail-closed"
        : "within one hour of the earliest active Cross-Sectional basket deadline; MOM36 returned",
    };
  }

  const reservedCrossSectionalSymbols = [...reservedFromBaskets].sort();
  return {
    policyId: DAILY_RANGE_CROSS_SECTIONAL_BORROW_POLICY_ID,
    state: "BORROWING_ACTIVE",
    crossSectionalSymbols,
    reservedCrossSectionalSymbols,
    borrowableSymbols: crossSectionalSymbols.filter((symbol) => !reservedFromBaskets.has(symbol)),
    activeBasketCount: activeBaskets.length,
    earliestBasketCloseAtMs,
    returnAtMs,
    reason: "active Cross-Sectional basket has more than one hour remaining; only unused MOM36 symbols are borrowable",
  };
}

/**
 * Rechecked immediately before Daily Range entry.  A frozen Daily session
 * cannot bypass the one-hour return simply because it was initialized earlier.
 */
export function dailyRangeCrossSectionalBorrowEntryGate(
  symbol: string,
  decision: DailyRangeCrossSectionalBorrowDecision,
): DailyRangeSymbolEntryGateDecision {
  const normalized = symbol.trim().toUpperCase();
  if (!decision.crossSectionalSymbols.includes(normalized)) return { allowed: true, reason: null };
  if (decision.state === "BORROWING_ACTIVE" && decision.borrowableSymbols.includes(normalized)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: decision.reason,
  };
}

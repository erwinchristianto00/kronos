/** Shared economic ledger. Quantities are never reduced in the original entry record. */
export interface AccountedLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number | null;
  exitFills?: readonly { orderId: string; qty: number; price: number; priceConfirmed?: boolean }[];
}

export function accountLegSlices(leg: AccountedLeg): {
  initialNotionalUsd: number; realizedPnlUsd: number; filledQty: number; remainingQty: number;
} | null {
  if (![leg.qty, leg.entryPrice].every(n => Number.isFinite(n) && n > 0)) return null;
  const sign = leg.side === "LONG" ? 1 : -1;
  let filledQty = 0, realizedPnlUsd = 0;
  const ids = new Set<string>();
  if (leg.exitFills?.length) {
    for (const fill of leg.exitFills) {
      if (!fill.orderId || ids.has(fill.orderId) || fill.priceConfirmed === false ||
          ![fill.qty, fill.price].every(n => Number.isFinite(n) && n > 0)) return null;
      ids.add(fill.orderId);
      filledQty += fill.qty;
      realizedPnlUsd += sign * (fill.price - leg.entryPrice) * fill.qty;
    }
    if (filledQty > leg.qty + 1e-8 ||
        (leg.exitPrice !== null && Math.abs(filledQty - leg.qty) > 1e-8)) return null;
  } else if (leg.exitPrice !== null) {
    if (!Number.isFinite(leg.exitPrice) || leg.exitPrice <= 0) return null;
    filledQty = leg.qty;
    realizedPnlUsd = sign * (leg.exitPrice - leg.entryPrice) * leg.qty;
  }
  return { initialNotionalUsd: leg.entryPrice * leg.qty, realizedPnlUsd, filledQty,
    remainingQty: Math.max(0, leg.qty - filledQty) };
}

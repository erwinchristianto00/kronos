import { accountLegSlices, type AccountedLeg } from "./basket-fill-accounting.js";
import type { FuturesUserTrade, FuturesIncomeEntry } from "./binance-futures-private.js";

export const BASKET_ACCOUNTING_V2 = "fill-slices-actual-costs-v2";
export const COST_REFRESH_MS = 60_000;
export interface BasketCostSnapshot {
  version: typeof BASKET_ACCOUNTING_V2;
  revision: string;
  observedAtMs: number;
  complete: boolean;
  reasons: string[];
  feesUsd: number | null;
  fundingUsd: number | null;
  trades: FuturesUserTrade[];
  funding: FuturesIncomeEntry[];
  ownership: { symbol: string; expectedQty: number; exchangeQty: number }[];
}
export type CostLeg = AccountedLeg & { entryOrderId: string; entryOrderIds?: string[]; exitOrderIds?: string[]; exitOrderId: string | null };
export function costRevision(legs: readonly CostLeg[]): string {
  return JSON.stringify(legs.map(l => [l.symbol, l.side, l.qty, l.entryPrice,
    l.entryOrderIds ?? [l.entryOrderId], l.exitOrderIds ?? [l.exitOrderId], l.exitFills ?? []]));
}

/** Exact symbol/order coverage, no non-USDT conversion guesses, and no account-funding allocation
 * to a basket that shared a symbol. A full page is incomplete, never silently truncated. */
export function reconcileBasketCosts(input: {
  legs: readonly CostLeg[]; trades: ReadonlyMap<string, readonly FuturesUserTrade[]>;
  income: readonly FuturesIncomeEntry[]; positions: ReadonlyMap<string, number>;
  openedAtMs: number; cutoffMs: number; exclusive: boolean;
}): BasketCostSnapshot {
  const reasons: string[] = [], trades: FuturesUserTrade[] = [], funding: FuturesIncomeEntry[] = [];
  const ownership: BasketCostSnapshot["ownership"] = [];
  let feesUsd = 0, fundingUsd = 0;
  if (!input.exclusive) reasons.push("SHARED_OWNERSHIP");
  if (input.income.length >= 1000) reasons.push("FUNDING_PAGE_SATURATED");
  for (const leg of input.legs) {
    const a = accountLegSlices(leg);
    if (!a) { reasons.push(`${leg.symbol}:INVALID_SLICES`); continue; }
    const expectedQty = (leg.side === "LONG" ? 1 : -1) * a.remainingQty;
    const exchangeQty = input.positions.get(leg.symbol) ?? 0;
    ownership.push({ symbol: leg.symbol, expectedQty, exchangeQty });
    if (!Number.isFinite(exchangeQty) || Math.abs(exchangeQty - expectedQty) > 1e-8)
      reasons.push(`${leg.symbol}:OWNERSHIP_MISMATCH`);
    const entryIds = new Set(leg.entryOrderIds?.length ? leg.entryOrderIds : [leg.entryOrderId]);
    const exitIds = new Set([...(leg.exitOrderIds ?? []), ...(leg.exitFills ?? []).map(f => f.orderId), ...(leg.exitOrderId ? [leg.exitOrderId] : [])]);
    const rows = input.trades.get(leg.symbol);
    if (!rows || rows.length >= 1000) reasons.push(`${leg.symbol}:TRADE_COVERAGE_INCOMPLETE`);
    let entryQty = 0, exitQty = 0, entryValue = 0;
    const seen = new Set<string>(), seenOrders = new Set<string>();
    for (const row of rows ?? []) {
      const key = `${row.symbol}:${row.tradeId}`;
      if (seen.has(key)) { reasons.push(`${leg.symbol}:DUPLICATE_TRADE`); continue; }
      seen.add(key);
      if (row.symbol !== leg.symbol || !row.tradeId || !Number.isFinite(row.time) || row.time < input.openedAtMs || row.time > input.cutoffMs ||
          !Number.isFinite(row.qty) || row.qty <= 0 || !Number.isFinite(row.price) || row.price <= 0 || !Number.isFinite(row.commission) || row.commissionAsset !== "USDT") {
        reasons.push(`${leg.symbol}:INVALID_TRADE`); continue;
      }
      if (!entryIds.has(row.orderId) && !exitIds.has(row.orderId)) {
        reasons.push(`${leg.symbol}:EXTERNAL_TRADE_IN_HOLD_WINDOW`); continue;
      }
      if (entryIds.has(row.orderId) && exitIds.has(row.orderId)) reasons.push(`${leg.symbol}:AMBIGUOUS_ORDER_ROLE`);
      if (entryIds.has(row.orderId)) { entryQty += row.qty; entryValue += row.qty * row.price; } else exitQty += row.qty;
      seenOrders.add(row.orderId); trades.push(row); feesUsd += row.commission;
    }
    if (Math.abs(entryQty - leg.qty) > 1e-8 || Math.abs(exitQty - a.filledQty) > 1e-8 ||
        [...entryIds, ...exitIds].some(id => !seenOrders.has(id))) reasons.push(`${leg.symbol}:FILL_COVERAGE_INCOMPLETE`);
    if (Math.abs(entryValue - leg.qty * leg.entryPrice) > Math.max(1e-7, leg.qty * leg.entryPrice * 1e-7))
      reasons.push(`${leg.symbol}:ENTRY_PRICE_MISMATCH`);
    for (const fill of leg.exitFills ?? []) {
      const matched = (rows ?? []).filter(r => r.symbol === leg.symbol && r.orderId === fill.orderId);
      if (Math.abs(matched.reduce((s, r) => s + r.qty, 0) - fill.qty) > 1e-8 ||
          Math.abs(matched.reduce((s, r) => s + r.qty * r.price, 0) - fill.qty * fill.price) > Math.max(1e-7, fill.qty * fill.price * 1e-7))
        reasons.push(`${leg.symbol}:EXIT_SLICE_MISMATCH`);
    }
    const fundIds = new Set<string>();
    for (const row of input.income.filter(r => r.symbol === leg.symbol)) {
      if (row.incomeType !== "FUNDING_FEE" || row.asset !== "USDT" || !Number.isFinite(row.income) ||
          !Number.isFinite(row.time) || row.time < input.openedAtMs || row.time > input.cutoffMs || !row.tranId || fundIds.has(row.tranId)) {
        reasons.push(`${leg.symbol}:INVALID_FUNDING`); continue;
      }
      fundIds.add(row.tranId); funding.push(row); fundingUsd += row.income;
    }
  }
  const complete = reasons.length === 0;
  return { version: BASKET_ACCOUNTING_V2, revision: costRevision(input.legs), observedAtMs: input.cutoffMs,
    complete, reasons, feesUsd: complete ? feesUsd : null, fundingUsd: complete ? fundingUsd : null,
    trades, funding, ownership };
}

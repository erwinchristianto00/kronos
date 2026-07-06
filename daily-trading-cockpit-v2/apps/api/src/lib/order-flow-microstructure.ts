/**
 * Order-flow microstructure features (taker buy ratio, signed volume, depth imbalance, spread,
 * expected slippage). Pure feature functions over Binance aggTrades + depth REST snapshots — no
 * websocket rewrite: this reuses the existing polling architecture (getFuturesAggTrades /
 * getFuturesDepth), read at decision time, the same way funding/OI/crowding are already read.
 *
 * Binance aggTrade semantics: `isBuyerMaker=true` means the BUYER posted the resting order, i.e.
 * the trade was initiated by an aggressive SELLER (a sell taker hit the bid) — so it counts as SELL
 * volume. `isBuyerMaker=false` means the taker was a BUYER (a buy taker hit the ask) — BUY volume.
 *
 * These are report-only measurement building blocks (used by decision-scoring.ts and the intraday
 * momentum lane as an enrichment); nothing here gates a live order by itself.
 */

import type { FuturesAggTradeSnapshot } from "./binance.js";

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthSnapshot {
  bids: DepthLevel[]; // best (highest) bid first
  asks: DepthLevel[]; // best (lowest) ask first
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse Binance's raw [priceStr, qtyStr] depth payload into typed levels. */
export function parseDepthPayload(payload: { bids: Array<[string, string]>; asks: Array<[string, string]> }): DepthSnapshot {
  const toLevel = ([p, q]: [string, string]): DepthLevel => ({ price: Number(p), qty: Number(q) });
  return {
    bids: payload.bids.map(toLevel).filter((l) => finite(l.price) && finite(l.qty) && l.qty > 0),
    asks: payload.asks.map(toLevel).filter((l) => finite(l.price) && finite(l.qty) && l.qty > 0),
  };
}

export interface TakerFlowFeatures {
  /** Fraction of taker volume that was BUY-initiated, in [0, 1]. 0.5 = neutral. null if no trades. */
  takerBuyRatio: number | null;
  /** buyVolume − sellVolume, in base-asset units. Sign matches direction of aggression. */
  signedVolume: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  tradeCount: number;
  /** trades per second over the observed window (requires >=2 trades to have a span). */
  tradeIntensityPerSec: number | null;
}

/** Aggregate taker buy/sell flow over a list of trades (already time-windowed by the caller). */
export function computeTakerFlowFeatures(trades: FuturesAggTradeSnapshot[]): TakerFlowFeatures {
  let buyVolume = 0;
  let sellVolume = 0;
  for (const t of trades) {
    if (!finite(t.quantity) || !(t.quantity > 0)) continue;
    // isBuyerMaker=true -> the taker was the SELLER (hit the bid) -> sell volume.
    if (t.isBuyerMaker) sellVolume += t.quantity;
    else buyVolume += t.quantity;
  }
  const totalVolume = buyVolume + sellVolume;
  const timestamps = trades.map((t) => t.timestamp).filter(finite);
  const spanMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  return {
    takerBuyRatio: totalVolume > 0 ? buyVolume / totalVolume : null,
    signedVolume: buyVolume - sellVolume,
    buyVolume,
    sellVolume,
    totalVolume,
    tradeCount: trades.length,
    tradeIntensityPerSec: spanMs > 0 ? trades.length / (spanMs / 1000) : null,
  };
}

export interface DepthImbalanceResult {
  /** (bidDepth − askDepth) / (bidDepth + askDepth) within the bps window, in [-1, 1]. +1 = all bid. */
  imbalance: number | null;
  bidDepthWithinWindow: number;
  askDepthWithinWindow: number;
  midPrice: number;
}

/**
 * Depth imbalance within `bpsWindow` of mid price. Resting orders can be pulled/spoofed, so this is
 * a CONFIRMATION signal (weight it below realized taker flow), never treated as certain intent.
 */
export function computeDepthImbalance(depth: DepthSnapshot, bestBid: number, bestAsk: number, bpsWindow: number): DepthImbalanceResult {
  const midPrice = (bestBid + bestAsk) / 2;
  const lowerBound = midPrice * (1 - bpsWindow / 10_000);
  const upperBound = midPrice * (1 + bpsWindow / 10_000);
  const bidDepthWithinWindow = depth.bids.filter((l) => l.price >= lowerBound).reduce((sum, l) => sum + l.qty, 0);
  const askDepthWithinWindow = depth.asks.filter((l) => l.price <= upperBound).reduce((sum, l) => sum + l.qty, 0);
  const total = bidDepthWithinWindow + askDepthWithinWindow;
  return {
    imbalance: total > 0 ? (bidDepthWithinWindow - askDepthWithinWindow) / total : null,
    bidDepthWithinWindow,
    askDepthWithinWindow,
    midPrice,
  };
}

/** Bid-ask spread in basis points of mid price. */
export function computeSpreadBps(bestBid: number, bestAsk: number): number | null {
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  return ((bestAsk - bestBid) / mid) * 10_000;
}

/**
 * Expected slippage (bps vs best price) to fill `notionalUsd` by walking the book on the side the
 * order would execute against (asks for a BUY, bids for a SELL). Returns null if depth is too thin
 * to fill the full size (the caller should treat that as "liquidity unhealthy", not extrapolate).
 */
export function computeExpectedSlippageBps(
  depth: DepthSnapshot,
  side: "BUY" | "SELL",
  notionalUsd: number,
): number | null {
  const levels = side === "BUY" ? depth.asks : depth.bids;
  if (levels.length === 0 || !(notionalUsd > 0)) return null;
  const bestPrice = levels[0]!.price;
  if (!(bestPrice > 0)) return null;

  let remainingUsd = notionalUsd;
  let totalQtyFilled = 0;
  let costUsd = 0; // sum(price * qtyFilledAtThatLevel)
  for (const level of levels) {
    if (remainingUsd <= 0) break;
    const levelUsd = level.price * level.qty;
    const takeUsd = Math.min(levelUsd, remainingUsd);
    const takeQty = takeUsd / level.price;
    costUsd += takeQty * level.price;
    totalQtyFilled += takeQty;
    remainingUsd -= takeUsd;
  }
  if (remainingUsd > 1e-9 || totalQtyFilled <= 0) return null; // book too thin to fill the requested notional
  const avgFillPrice = costUsd / totalQtyFilled;
  return Math.abs((avgFillPrice - bestPrice) / bestPrice) * 10_000;
}

export interface MicrostructureSnapshot {
  symbol: string;
  capturedAtMs: number;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  depthImbalance: DepthImbalanceResult | null;
  takerFlow: TakerFlowFeatures;
  expectedSlippageBpsBuy: number | null;
  expectedSlippageBpsSell: number | null;
}

/**
 * Build a full microstructure snapshot for a symbol from already-fetched raw data (pure — the
 * caller does the REST calls via the existing binance client, exactly like the funding/OI/crowding
 * fetches already do). depthBpsWindow default 10bps; sizeNotionalUsd is the trade size to estimate
 * slippage for (pass the actual planned notional for an accurate cost-gate read).
 */
export function buildMicrostructureSnapshot(opts: {
  symbol: string;
  capturedAtMs: number;
  trades: FuturesAggTradeSnapshot[];
  depthPayload: { bids: Array<[string, string]>; asks: Array<[string, string]> };
  bestBid: number | null;
  bestAsk: number | null;
  depthBpsWindow?: number;
  sizeNotionalUsd?: number;
}): MicrostructureSnapshot {
  const depth = parseDepthPayload(opts.depthPayload);
  const takerFlow = computeTakerFlowFeatures(opts.trades);
  const bpsWindow = opts.depthBpsWindow ?? 10;
  const sizeUsd = opts.sizeNotionalUsd ?? 0;
  const spreadBps = finite(opts.bestBid) && finite(opts.bestAsk) ? computeSpreadBps(opts.bestBid, opts.bestAsk) : null;
  const depthImbalance = finite(opts.bestBid) && finite(opts.bestAsk) ? computeDepthImbalance(depth, opts.bestBid, opts.bestAsk, bpsWindow) : null;
  return {
    symbol: opts.symbol,
    capturedAtMs: opts.capturedAtMs,
    bestBid: opts.bestBid,
    bestAsk: opts.bestAsk,
    spreadBps,
    depthImbalance,
    takerFlow,
    expectedSlippageBpsBuy: sizeUsd > 0 ? computeExpectedSlippageBps(depth, "BUY", sizeUsd) : null,
    expectedSlippageBpsSell: sizeUsd > 0 ? computeExpectedSlippageBps(depth, "SELL", sizeUsd) : null,
  };
}

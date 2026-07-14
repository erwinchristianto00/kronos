/**
 * Observed market view (Market Digital Twin, Phase-1 foundation). This is the ONLY market information a decision
 * function may see. It carries per-feed status so a stale/failed feed is explicit — a decision made under a mark
 * feed outage sees STALE, not a silently-forward-filled fresh value. Pure types + a causal visibility filter.
 */
import type { CommonMarketFrame, MarketFieldStatus, MarketObservation } from "./simulation-types.js";
import { visibleAt } from "./simulation-types.js";

export interface ObservedMarketView {
  asOfMs: number;
  frames: CommonMarketFrame;
  /** Per "symbol:field" feed status the decision layer can branch on (e.g. "BTCUSDT:markPrice" -> "STALE"). */
  feedStatus: Record<string, MarketFieldStatus>;
}

/** Build the observed view from a frame; a field observed AFTER `asOfMs` (availableAtMs > asOfMs) is downgraded to
 *  its availability status so no look-ahead can leak into decisions. Pure — never mutates the input frame. */
export function buildObservedView(frame: CommonMarketFrame, asOfMs: number): ObservedMarketView {
  const feedStatus: Record<string, MarketFieldStatus> = {};
  for (const [symbol, sf] of Object.entries(frame.symbols)) {
    const fields: Array<[string, MarketObservation<unknown>]> = [
      ["candle", sf.candle], ["markPrice", sf.markPrice], ["fundingRate", sf.fundingRate], ["spreadBps", sf.spreadBps],
      ["liquidity", sf.liquidity], ["openInterest", sf.openInterest], ["liquidationFlow", sf.liquidationFlow], ["orderFlow", sf.orderFlow],
    ];
    for (const [name, obs] of fields) {
      // A PRESENT field not yet available at asOfMs is reported STALE (it exists but the bot cannot see it yet).
      feedStatus[`${symbol}:${name}`] = obs.status === "PRESENT" && !visibleAt(obs, asOfMs) ? "STALE" : obs.status;
    }
  }
  return { asOfMs, frames: frame, feedStatus };
}

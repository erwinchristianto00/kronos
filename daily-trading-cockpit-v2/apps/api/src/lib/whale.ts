import type { WhaleSignal } from "@dtc/shared";

import { BinanceClient, type FuturesFlowSnapshot } from "./binance.js";

export interface WhaleAvailability {
  available: boolean;
  message: string;
}

export interface WhaleClient {
  availability(): Promise<WhaleAvailability>;
  getSignal(symbol: string, volumeRatio5m: number | null): Promise<WhaleSignal>;
}

function classifyWhaleSignal(flow: FuturesFlowSnapshot, volumeRatio5m: number | null): WhaleSignal {
  const fundingRate = flow.fundingRate ?? 0;
  const oiChange = flow.openInterestChangePercent ?? 0;
  const takerRatio = flow.takerBuySellRatio ?? 1;
  const longShortRatio = flow.longShortRatio ?? 1;
  const volumeSpike = volumeRatio5m ?? 1;

  const bullishScore =
    (oiChange > 1 ? 22 : oiChange > 0.25 ? 14 : 6) +
    (fundingRate > 0 ? 12 : 4) +
    (takerRatio > 1.08 ? 28 : takerRatio > 1.01 ? 14 : 4) +
    (longShortRatio > 1.05 ? 18 : longShortRatio > 0.98 ? 10 : 4) +
    (volumeSpike > 1.2 ? 20 : volumeSpike > 1 ? 10 : 4);
  const bearishScore =
    (oiChange > 1 ? 22 : oiChange > 0.25 ? 14 : 6) +
    (fundingRate < 0 ? 12 : 4) +
    (takerRatio < 0.92 ? 28 : takerRatio < 0.99 ? 14 : 4) +
    (longShortRatio < 0.95 ? 18 : longShortRatio < 1.02 ? 10 : 4) +
    (volumeSpike > 1.2 ? 20 : volumeSpike > 1 ? 10 : 4);

  if (Math.abs(bullishScore - bearishScore) < 8) {
    return {
      available: true,
      signal: "NEUTRAL",
      score: 50,
      reason: `Whale flow is mixed: funding ${fundingRate.toFixed(4)}, taker ratio ${takerRatio.toFixed(2)}, OI change ${oiChange.toFixed(2)}%.`,
    };
  }

  const bullish = bullishScore > bearishScore;
  const score = Math.min(100, Math.max(55, bullish ? bullishScore : bearishScore));
  return {
    available: true,
    signal: bullish ? "BULLISH" : "BEARISH",
    score,
    reason: `${bullish ? "Bullish" : "Bearish"} futures flow from funding ${fundingRate.toFixed(4)}, taker ratio ${takerRatio.toFixed(2)}, OI change ${oiChange.toFixed(2)}%, long/short ${longShortRatio.toFixed(2)}.`,
  };
}

export class BinanceWhaleClient implements WhaleClient {
  constructor(private readonly binanceClient: BinanceClient) {}

  async availability(): Promise<WhaleAvailability> {
    return {
      available: true,
      message: "Binance futures-flow adapter is active.",
    };
  }

  async getSignal(symbol: string, volumeRatio5m: number | null): Promise<WhaleSignal> {
    try {
      const flow = await this.binanceClient.getFuturesFlow(symbol);
      const hasRealData = Object.values(flow).some((value) => value !== null && Number.isFinite(value));
      if (!hasRealData) {
        return {
          available: false,
          signal: "UNAVAILABLE",
          score: 0,
          reason: "Binance futures-flow data is unavailable for this symbol.",
        };
      }
      return classifyWhaleSignal(flow, volumeRatio5m);
    } catch (error) {
      return {
        available: false,
        signal: "UNAVAILABLE",
        score: 0,
        reason: error instanceof Error ? error.message : "Binance futures-flow adapter failed.",
      };
    }
  }
}

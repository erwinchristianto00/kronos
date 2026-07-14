/**
 * Historical event-template contract (Market Digital Twin, Phase-1 foundation), priority #4. A template is EXTRACTED
 * from an observed episode — never invented. It preserves the real normalized return/volatility/volume/funding paths
 * + drawdown depth + recovery duration + cross-asset correlation of that episode. Dimensions the source did NOT
 * observe (liquidation flow, OI, spread, L2 depth, news) are stored UNSUPPORTED — never fabricated. This phase
 * defines the contract + a deterministic detector skeleton; it does NOT yet generate arbitrary stress variants.
 */
import type { MarketObservation } from "./simulation-types.js";
import { unsupported } from "./simulation-types.js";

export type EventFamily =
  | "FLASH_CRASH"
  | "V_RECOVERY"
  | "BREAKOUT"
  | "FALSE_BREAKOUT"
  | "SHORT_SQUEEZE"
  | "LONG_LIQUIDATION_CASCADE"
  | "VOLATILITY_EXPANSION"
  | "LIQUIDITY_COLLAPSE"
  | "CORRELATION_BREAKDOWN"
  | "FUNDING_EXTREME"
  | "EXCHANGE_DEGRADATION";

export interface HistoricalEventTemplate {
  family: EventFamily;
  sourceDateRangeMs: { startMs: number; endMs: number };
  sourceSymbols: string[];
  detectionRule: string;
  /** Normalized (return-space, anchored at 0) real path — the core preserved geometry. */
  normalizedReturnPath: number[];
  volatilityPath: number[];
  volumeMultiplierPath: number[];
  /** UNSUPPORTED in the candle-only corpus unless the source genuinely observed it. */
  fundingPath: MarketObservation<number[]>;
  markPriceBasisPath: MarketObservation<number[]>;
  crossAssetCorrelationPath: MarketObservation<number[]>;
  liquidationFlowPath: MarketObservation<number[]>;
  openInterestPath: MarketObservation<number[]>;
  spreadPath: MarketObservation<number[]>;
  recoveryDurationBars: number | null;
  drawdownDepth: number | null;
  /** How many independent observed episodes support this template (1 ⇒ single-instance, weak support). */
  historicalSupportCount: number;
}

export interface EpisodeCandle { openTimeMs: number; open: number; high: number; low: number; close: number; volume: number; }

/**
 * Extract a template from ONE observed episode's candle window (single symbol). Returns null if the window is too
 * short. All unsupported dimensions are UNSUPPORTED. `historicalSupportCount` starts at 1 (this single episode);
 * merging multiple episodes into a stronger template is a later-phase operation.
 */
export function extractEventTemplate(family: EventFamily, symbol: string, window: EpisodeCandle[], detectionRule: string): HistoricalEventTemplate | null {
  if (window.length < 3) return null;
  const closes = window.map((c) => c.close);
  const anchor = closes[0]!;
  const normalizedReturnPath: number[] = [];
  for (let i = 1; i < closes.length; i += 1) if (closes[i - 1]! > 0 && closes[i]! > 0) normalizedReturnPath.push(Math.log(closes[i]! / closes[i - 1]!));
  const volatilityPath = window.map((c) => (c.open > 0 ? (c.high - c.low) / c.open : 0));
  const meanVol = window.reduce((a, c) => a + c.volume, 0) / window.length || 1;
  const volumeMultiplierPath = window.map((c) => c.volume / meanVol);
  // drawdown depth over the anchored path
  let logCum = 0; let peak = 0; let maxDd = 0;
  for (const r of normalizedReturnPath) { logCum += r; peak = Math.max(peak, logCum); maxDd = Math.max(maxDd, 1 - Math.exp(logCum - peak)); }
  const src = `event:${symbol}`;
  return {
    family,
    sourceDateRangeMs: { startMs: window[0]!.openTimeMs, endMs: window.at(-1)!.openTimeMs },
    sourceSymbols: [symbol],
    detectionRule,
    normalizedReturnPath,
    volatilityPath,
    volumeMultiplierPath,
    fundingPath: unsupported<number[]>(src),
    markPriceBasisPath: unsupported<number[]>(src),
    crossAssetCorrelationPath: unsupported<number[]>(src),
    liquidationFlowPath: unsupported<number[]>(src),
    openInterestPath: unsupported<number[]>(src),
    spreadPath: unsupported<number[]>(src),
    recoveryDurationBars: null,
    drawdownDepth: maxDd,
    historicalSupportCount: 1,
  };
}

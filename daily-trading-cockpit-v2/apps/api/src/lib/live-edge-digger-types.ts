/**
 * LIVE EDGE DIGGER — shared types and the leakage boundary.
 *
 * Split out from the engine so the type surface (and, more importantly, the DECISION-TIME contract)
 * can be read and tested on its own.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO ENCODE. A feature is anything the engine is allowed to
 * CONDITION ON when it decides to open a shadow position. An outcome is anything that can only be
 * known afterwards. The two must never mix, and the boundary is not a convention here — it is a
 * type split (`SymbolFeatures`/`MarketFeatures` vs `ShadowOutcome`) plus a runtime assertion
 * (`assertDecisionTimeSafe`) that fails closed.
 *
 * WHY THAT MATTERS MORE THAN USUAL IN THIS REPO. Kronos already contains a live example of the
 * failure: `costR` on a variant-matrix row is written at decision time from the cost model, then
 * OVERWRITTEN at resolution to fold in stop-out slippage and funding — both functions of the
 * outcome. A pipeline that treated it as a feature would be conditioning on the answer. Binance's
 * kline endpoint has the same shape of trap: its final element is the CURRENTLY FORMING bar, whose
 * high/low/close are not yet knowable. `BinanceClient.getCandles` already routes through
 * `completedCandles()` from @dtc/shared (keeps only `openTime + intervalMs <= now`), and this engine
 * additionally re-asserts that every candle it reads is closed as of the decision instant.
 */

export type RegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
export type Direction = "LONG" | "SHORT";

/** Field names that can only be known AFTER an outcome. Never valid as a rule input. */
export const OUTCOME_ONLY_FIELDS: readonly string[] = [
  "grossR", "netR", "costR", "resolvedCostR", "status", "resolvedAt", "resolvedAtMs",
  "exitReason", "exitPrice", "maxFavorableR", "maxAdverseR", "mfe", "mae",
  "durationMinutes", "holdBars", "pnl", "realizedPnl", "outcome", "win", "loss",
];

/**
 * Per-symbol decision-time features. EVERY field here is computed from candles that had already
 * CLOSED at `asOfMs`, or from a point-in-time snapshot (depth/funding/OI) read at `asOfMs`.
 *
 * `lastClosedCandleOpenMs`/`lastClosedCandleCloseMs` are carried deliberately: they are the
 * provenance that makes the decision-time claim auditable rather than asserted. A reader (or a
 * test) can check `lastClosedCandleCloseMs <= asOfMs` and know no forming bar leaked in.
 */
export interface SymbolFeatures {
  readonly symbol: string;
  readonly asOfMs: number;
  readonly lastClosedCandleOpenMs: number;
  readonly lastClosedCandleCloseMs: number;
  readonly close: number;

  /** Trailing returns over COMPLETED bars only. */
  readonly ret1h: number | null;
  readonly ret4h: number | null;
  readonly ret24h: number | null;

  /** Rolling OLS beta to BTC and the residual (idiosyncratic) 24h return after removing it. */
  readonly betaBtc: number | null;
  readonly residualRet24h: number | null;

  /** Cross-sectional percentile ranks within the SAME cycle's universe, 0..1. */
  readonly residualRank: number | null;
  readonly momentumRank: number | null;
  /** 24h return minus the universe median 24h return. */
  readonly relativeStrength: number | null;

  /** Volatility state. atrPct = ATR/close. Percentiles are within this cycle's universe. */
  readonly atrPct: number | null;
  readonly atrPercentile: number | null;
  readonly rangeCompressionPercentile: number | null;

  /** Liquidity / microstructure, from the point-in-time snapshot. */
  readonly quoteVolume24hUsd: number | null;
  readonly spreadBps: number | null;
  readonly topDepthUsd: number | null;

  /** Derivatives context. */
  readonly fundingBps: number | null;
  readonly basisBps: number | null;
  readonly openInterestUsd: number | null;

  /** Shock proxy: most recent 15m move measured in ATR units. A stand-in for a liquidation cascade
   *  when a true forceOrder feed is not being persisted. Null when ATR is unavailable. */
  readonly shockAtrUnits: number | null;
}

/** Market-wide decision-time aggregates for one cycle. */
export interface MarketFeatures {
  readonly asOfMs: number;
  readonly regime: string | null;
  readonly regimeFamily: RegimeFamily;
  readonly universeSize: number;
  /** Fraction of the universe with a positive 24h return. */
  readonly breadth: number | null;
  /** Fraction moving in the same 24h direction as BTC — how "one-way" the tape is. */
  readonly cohesion: number | null;
  /** Cross-sectional standard deviation of 24h returns. High = stock-pickers' tape. */
  readonly dispersion: number | null;
  /** Median absolute 24h return — the scale dispersion should be read against. */
  readonly medianAbsRet24h: number | null;
  readonly symbols: readonly SymbolFeatures[];
}

/**
 * Runtime leakage guard. Throws on any attempt to hand an outcome-derived field to rule evaluation.
 * Deliberately a throw, not a filter: silently dropping a leaked field would let a rule that depends
 * on it keep running with a subtly different meaning.
 */
export function assertDecisionTimeSafe(featureNames: readonly string[], context: string): void {
  const leaked = featureNames.filter((f) => OUTCOME_ONLY_FIELDS.includes(f));
  if (leaked.length > 0) {
    throw new Error(`live-edge-digger: ${context} referenced outcome-only field(s): ${leaked.join(", ")}`);
  }
}

/** Proves every candle used was closed at the decision instant. Fails closed. */
export function assertCandlesClosedAsOf(
  candles: readonly { openTime: number; closeTime?: number }[],
  intervalMs: number,
  asOfMs: number,
  context: string,
): void {
  for (const candle of candles) {
    const closesAt = candle.openTime + intervalMs;
    if (closesAt > asOfMs) {
      throw new Error(
        `live-edge-digger: ${context} used a candle that had not closed at the decision instant ` +
        `(openTime=${candle.openTime}, closesAt=${closesAt}, asOf=${asOfMs})`,
      );
    }
  }
}

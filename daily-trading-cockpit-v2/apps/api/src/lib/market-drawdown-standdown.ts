/**
 * Stand-down gate: skip opening a cross-sectional basket while the universe is deep in a multi-week
 * drawdown.
 *
 * Measured 2026-08-18 on 2 years of hourly klines (5,705 baskets, non-overlapping 48h blocks). The
 * lane's return conditioned on the universe's TRAILING 14-day mean return:
 *
 *   bottom decile of 14d return   -0.7111%/basket   blocked t = -4.09
 *   everything else               +0.2151%/basket   blocked t = +2.30
 *   no gate at all                +0.1415%/basket   blocked t = +1.54
 *
 * This is the only regime finding in the whole sweep whose SIGN held in every year — 2024 -1.13%,
 * 2025 -0.75%, 2026 -0.30%. Both alternatives to standing down flipped sign in 2026 (full-long
 * +1.56/+2.71/-1.47, full-short -3.81/-4.11/+0.66), which is why this gate stands DOWN rather than
 * switching direction: the failure mode is a missed basket, never a new position.
 *
 * The threshold is a plateau, not a knife edge — every cut from -10% to -20% roughly doubles
 * expectancy and lifts t from 1.54 to 2.2-2.8 — so an absolute level can be fixed in advance
 * instead of being fitted to a percentile of this sample:
 *
 *   <= -10%   keeps 75% of baskets   +0.2852%/basket  t=2.76   per year +0.62 / -0.10 / +0.58
 *   <= -15%   keeps 85%              +0.2430%         t=2.49            +0.61 / -0.06 / +0.52
 *   <= -20%   keeps 92%              +0.2036%         t=2.17            +0.44 / -0.11 / +0.48
 *
 * Honest limits: it does NOT rescue 2025 (-0.13% -> -0.10%), it only sharpens the good years; and
 * -10% was still chosen with hindsight over this sample, however broad the plateau around it.
 *
 * 7 days is NOT a substitute: at that window the same decile is only -0.40% (t=-1.50).
 */

/** Bars of 1h history the gate needs. The scanner must fetch at least this many, or the mean is
 *  computed from whatever short history happens to be present and the gate silently mis-fires —
 *  the exact starvation cross-sectional-edge.ts's CROSS_SECTIONAL_LIQUIDITY_LOOKBACK_BARS comment
 *  records happening on 2026-08-12. */
export const STAND_DOWN_LOOKBACK_BARS = 336;

export interface StandDownVerdict {
  /** True only when the threshold is enabled AND the measurement is trustworthy AND it is breached. */
  standDown: boolean;
  /** Mean trailing 14d return across the measured universe, or null when it could not be measured. */
  marketReturn: number | null;
  thresholdPct: number;
  measuredSymbols: number;
  reason: string | null;
}

/**
 * Reads the threshold as a PERCENT (e.g. "-10"), because an operator setting a fraction by mistake
 * (-0.10) would otherwise arm a far stricter gate than intended. Absent/zero/unparseable = disabled,
 * which keeps the lane's behaviour exactly as it was.
 */
export function standDownThresholdPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.CROSS_SECTIONAL_STAND_DOWN_14D_PCT ?? "");
  return Number.isFinite(raw) && raw < 0 ? raw : 0;
}

/**
 * @param closesBySymbol full 1h close series per symbol, oldest first.
 * @param minSymbols     below this many measurable symbols the mean is not representative, so the
 *                       gate returns standDown:false — FAIL OPEN. A measurement problem must not
 *                       silently halt the lane; that failure would look identical to a calm market.
 */
export function evaluateMarketStandDown(
  closesBySymbol: Record<string, number[]>,
  thresholdPct: number,
  opts: { lookbackBars?: number; minSymbols?: number } = {},
): StandDownVerdict {
  const lookback = opts.lookbackBars ?? STAND_DOWN_LOOKBACK_BARS;
  const minSymbols = opts.minSymbols ?? 10;
  if (!(thresholdPct < 0)) {
    return { standDown: false, marketReturn: null, thresholdPct, measuredSymbols: 0, reason: null };
  }

  const returns: number[] = [];
  for (const closes of Object.values(closesBySymbol)) {
    if (!Array.isArray(closes) || closes.length < lookback + 1) continue;
    const now = closes[closes.length - 1];
    const past = closes[closes.length - 1 - lookback];
    if (!(typeof now === "number" && typeof past === "number" && now > 0 && past > 0)) continue;
    returns.push((now - past) / past);
  }

  if (returns.length < minSymbols) {
    return {
      standDown: false,
      marketReturn: null,
      thresholdPct,
      measuredSymbols: returns.length,
      reason: `only ${returns.length} symbol(s) had ${lookback} bars of history — gate FAILS OPEN rather than halting the lane on a data problem`,
    };
  }

  const marketReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const breached = marketReturn * 100 <= thresholdPct;
  return {
    standDown: breached,
    marketReturn,
    thresholdPct,
    measuredSymbols: returns.length,
    reason: breached
      ? `universe down ${(marketReturn * 100).toFixed(2)}% over ${lookback}h (threshold ${thresholdPct}%) — measured -0.71%/basket in this regime across all three years`
      : null,
  };
}

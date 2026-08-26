/**
 * Display-only chart overlays for the open-basket review.  They deliberately
 * operate only on the completed public USD-M candles supplied to the UI; no
 * value from here is fed back into formation, entry, sizing, or exit logic.
 */

export type OverlayCandle = Readonly<{
  openTime: number;
  high: number;
  low: number;
  close: number;
}>;

export type OverlayPoint = Readonly<{
  openTime: number;
  value: number;
}>;

export type StructuralTrendline = Readonly<{
  kind: "RESISTANCE" | "SUPPORT";
  /** The two confirmed swing pivots which anchor this line. */
  anchors: readonly [OverlayPoint, OverlayPoint];
  /** Anchor one, anchor two, then the display-only extension to the latest bar. */
  points: readonly OverlayPoint[];
}>;

function hasFinitePrice(candle: OverlayCandle): boolean {
  return Number.isFinite(candle.openTime)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close);
}

/**
 * Uses the same standard EMA seed as the shared indicator code: the first
 * full-period SMA, then the usual recursive EMA.  Unlike a shortened EMA,
 * it intentionally stays absent until a complete period exists.
 */
export function calculateEmaSeries(candles: readonly OverlayCandle[], period: number): OverlayPoint[] {
  if (!Number.isInteger(period) || period <= 0 || candles.length < period || candles.some((candle) => !hasFinitePrice(candle))) {
    return [];
  }
  const seed = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const multiplier = 2 / (period + 1);
  let value = seed;
  const series: OverlayPoint[] = [{ openTime: candles[period - 1]!.openTime, value }];
  for (let index = period; index < candles.length; index += 1) {
    value = (candles[index]!.close - value) * multiplier + value;
    series.push({ openTime: candles[index]!.openTime, value });
  }
  return series;
}

function confirmedPivots(
  candles: readonly OverlayCandle[],
  kind: StructuralTrendline["kind"],
  radius: number,
): OverlayPoint[] {
  const pivots: OverlayPoint[] = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candidate = candles[index]!;
    const candidateValue = kind === "RESISTANCE" ? candidate.high : candidate.low;
    let confirmed = true;
    for (let offset = 1; offset <= radius; offset += 1) {
      const before = candles[index - offset]!;
      const after = candles[index + offset]!;
      const beforeValue = kind === "RESISTANCE" ? before.high : before.low;
      const afterValue = kind === "RESISTANCE" ? after.high : after.low;
      // Strict extrema avoid ambiguous flat tops/bottoms.  A pivot only becomes
      // visible once the candles on its right have completed.
      if (kind === "RESISTANCE"
        ? candidateValue <= beforeValue || candidateValue <= afterValue
        : candidateValue >= beforeValue || candidateValue >= afterValue) {
        confirmed = false;
        break;
      }
    }
    if (confirmed) pivots.push({ openTime: candidate.openTime, value: candidateValue });
  }
  return pivots;
}

function trendlineFromLatestPivots(
  kind: StructuralTrendline["kind"],
  pivots: readonly OverlayPoint[],
  latestOpenTime: number,
): StructuralTrendline | null {
  if (pivots.length < 2) return null;
  const first = pivots[pivots.length - 2]!;
  const second = pivots[pivots.length - 1]!;
  const elapsed = second.openTime - first.openTime;
  if (elapsed <= 0) return null;
  const slopePerMs = (second.value - first.value) / elapsed;
  const points: OverlayPoint[] = [first, second];
  if (latestOpenTime > second.openTime) {
    points.push({
      openTime: latestOpenTime,
      value: second.value + slopePerMs * (latestOpenTime - second.openTime),
    });
  }
  return { kind, anchors: [first, second], points };
}

/**
 * One resistance line joins the two newest confirmed pivot highs and one
 * support line joins the two newest confirmed pivot lows.  They are visual
 * market-structure guides, not the fixed 4H execution range levels.
 */
export function calculateStructuralTrendlines(
  candles: readonly OverlayCandle[],
  pivotRadius = 2,
): StructuralTrendline[] {
  if (!Number.isInteger(pivotRadius) || pivotRadius < 1 || candles.length < pivotRadius * 2 + 1 || candles.some((candle) => !hasFinitePrice(candle))) {
    return [];
  }
  const latestOpenTime = candles.at(-1)!.openTime;
  const resistance = trendlineFromLatestPivots("RESISTANCE", confirmedPivots(candles, "RESISTANCE", pivotRadius), latestOpenTime);
  const support = trendlineFromLatestPivots("SUPPORT", confirmedPivots(candles, "SUPPORT", pivotRadius), latestOpenTime);
  return [resistance, support].filter((line): line is StructuralTrendline => line !== null);
}

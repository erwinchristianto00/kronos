import { describe, expect, it } from "vitest";
import { calculateEmaSeries, calculateStructuralTrendlines, type OverlayCandle } from "./openBasketChartOverlays";

function candle(index: number, high: number, low: number, close: number): OverlayCandle {
  return { openTime: index * 60_000, high, low, close };
}

describe("open basket chart overlays", () => {
  it("draws a full-period EMA with the shared-indicator SMA seed", () => {
    const series = calculateEmaSeries([
      candle(0, 1, 1, 1),
      candle(1, 2, 2, 2),
      candle(2, 3, 3, 3),
      candle(3, 4, 4, 4),
      candle(4, 5, 5, 5),
    ], 3);

    expect(series).toEqual([
      { openTime: 2 * 60_000, value: 2 },
      { openTime: 3 * 60_000, value: 3 },
      { openTime: 4 * 60_000, value: 4 },
    ]);
  });

  it("does not synthesize a shortened EMA when there are too few completed candles", () => {
    expect(calculateEmaSeries([candle(0, 1, 1, 1), candle(1, 2, 2, 2)], 3)).toEqual([]);
  });

  it("joins the two latest confirmed pivot peaks and troughs, then extends them to the latest candle", () => {
    const candles = [
      candle(0, 3, 1, 2),
      candle(1, 4, 0, 3),
      candle(2, 8, -1, 5),
      candle(3, 4, 0, 3),
      candle(4, 3, 1, 2),
      candle(5, 5, 0, 3),
      candle(6, 9, -2, 5),
      candle(7, 5, 0, 3),
      candle(8, 4, 1, 2),
      candle(9, 6, 2, 4),
    ];

    const lines = calculateStructuralTrendlines(candles);
    const resistance = lines.find((line) => line.kind === "RESISTANCE");
    const support = lines.find((line) => line.kind === "SUPPORT");

    expect(resistance?.anchors).toEqual([
      { openTime: 2 * 60_000, value: 8 },
      { openTime: 6 * 60_000, value: 9 },
    ]);
    expect(resistance?.points.at(-1)).toEqual({ openTime: 9 * 60_000, value: 9.75 });
    expect(support?.anchors).toEqual([
      { openTime: 2 * 60_000, value: -1 },
      { openTime: 6 * 60_000, value: -2 },
    ]);
    expect(support?.points.at(-1)).toEqual({ openTime: 9 * 60_000, value: -2.75 });
  });
});

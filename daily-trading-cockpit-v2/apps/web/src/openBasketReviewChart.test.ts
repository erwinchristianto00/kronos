import { describe, expect, it } from 'vitest';

import { eventMarkerForCompletedCandle } from './OpenBasketReviewChart.js';

describe('eventMarkerForCompletedCandle', () => {
  const candles = [
    { openTime: 1_000, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { openTime: 301_000, open: 11, high: 13, low: 10, close: 12, volume: 1 },
  ];

  it('pins a white ARM event to the exact containing 5m candle', () => {
    const marker = eventMarkerForCompletedCandle(candles, {
      at: new Date(301_001).toISOString(), label: 'MFE ARM +0.50R', position: 'aboveBar',
    }, 300_000);
    expect(marker).toMatchObject({ time: 301, color: '#FFFFFF', position: 'aboveBar', shape: 'circle' });
  });

  it('does not move an ARM event to a nearest candle', () => {
    expect(eventMarkerForCompletedCandle(candles, {
      at: new Date(901_000).toISOString(), label: 'MFE ARM', position: 'aboveBar',
    }, 300_000)).toBeNull();
  });
});

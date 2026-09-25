import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import MarketRegimeCard, { type MarketRegimeDisplay } from './MarketRegimeCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });
function snapshot(): MarketRegimeDisplay {
  return { source: 'CANONICAL_MARKET_REGIME', capturedAt: new Date(Date.now() - 60_000).toISOString(),
    maxAgeMs: 20 * 60_000, freshness: 'FRESH', projection: 'MIXED', confidence: 1,
    validSymbolCount: 60, requiredSymbolCount: 60, reason: null };
}
it('shows the observed regime, source, coverage and timestamp', () => {
  const value = snapshot();
  const { container } = render(<MarketRegimeCard snapshot={value} />);
  expect(screen.getByText('Mixed')).toBeTruthy();
  expect(screen.getByText('Market engine · Fresh')).toBeTruthy();
  expect(screen.getByText('60/60 symbols · 100% confidence')).toBeTruthy();
  expect(container.querySelector('time')?.getAttribute('datetime')).toBe(value.capturedAt);
});
it('expires the display even when API updates stop', () => {
  vi.useFakeTimers();
  render(<MarketRegimeCard snapshot={snapshot()} />);
  act(() => vi.advanceTimersByTime(20 * 60_000));
  expect(screen.getByText('Stale market data')).toBeTruthy();
  expect(screen.queryByText('Mixed')).toBeNull();
  expect(screen.queryByText(/100% confidence/)).toBeNull();
});
it.each(['missing', 'unavailable', 'future'])('does not use legacy scanner defaults for %s data', (kind) => {
  const value = snapshot();
  if (kind === 'unavailable') value.freshness = 'UNAVAILABLE';
  if (kind === 'future') value.capturedAt = new Date(Date.now() + 60_000).toISOString();
  render(<MarketRegimeCard snapshot={kind === 'missing' ? undefined : value} />);
  expect(screen.getByText('Market data unavailable')).toBeTruthy();
  expect(screen.queryByText('Mixed')).toBeNull();
});

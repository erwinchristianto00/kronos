import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import BasketSelectionBadge from './BasketSelectionBadge';

afterEach(cleanup);
it.each([
  ['BASELINE', 'BASELINE_ALREADY_BEST', 'Baseline'],
  ['BASELINE', 'RECENT_STRENGTH_MIXED', 'Baseline'],
  ['BASELINE', 'RECENT_STRENGTH_UNAVAILABLE', 'Baseline'],
  ['BASELINE', 'SEARCH_EXHAUSTED', 'Baseline'],
  ['PREFERRED', 'PREFERRED_RECENT_STRENGTH_ALIGNED', 'Qualified alternative'],
])('renders frozen %s selection (%s)', (selectionMode, reason, label) => {
  render(<BasketSelectionBadge preference={{ policyId: 'cross-preference-formation-v1', selectionMode, reason }} />);
  expect(screen.getByText(label).getAttribute('title')).toBeTruthy();
});
it.each([undefined, null, {}, { selectionMode: 'BASELINE' }, { policyId: 'cross-preference-formation-v1', selectionMode: 'UNKNOWN' }])('does not guess missing or unsupported evidence: %j', (preference) => {
  render(<BasketSelectionBadge preference={preference} />);
  expect(screen.getByText('Pilihan tidak terekam')).toBeTruthy();
  expect(screen.queryByText('Baseline')).toBeNull();
});

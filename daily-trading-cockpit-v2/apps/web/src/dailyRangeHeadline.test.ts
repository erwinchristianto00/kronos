import { describe, expect, it } from 'vitest';
import { summarizeDailyRangeHeadline, taipeiCloseDateKey } from './dailyRangeHeadline';

describe('Daily Range headline realized P&L', () => {
  it('buckets the actual exit fill by the Taiwan close date, not the UTC signal date', () => {
    const result = summarizeDailyRangeHeadline([
      {
        status: 'CLOSED',
        // 00:49 on 26 Aug in Taipei, despite the signal/range belonging to 25 Aug UTC.
        exitTimestamp: '2026-08-25T16:49:48.827Z',
        netPnlUsd: -0.07485968,
      },
      {
        status: 'CLOSED',
        exitTimestamp: '2026-08-25T20:39:47.619Z',
        netPnlUsd: 0.59357437,
      },
      {
        status: 'CLOSED',
        exitTimestamp: '2026-08-24T16:01:00.000Z',
        netPnlUsd: 0.25,
      },
    ], new Date('2026-08-26T05:30:00.000Z'));

    expect(taipeiCloseDateKey('2026-08-25T16:49:48.827Z')).toBe('2026-08-26');
    expect(result).toEqual({
      closeDateTaipei: '2026-08-26',
      todayNetPnlUsd: 0.51871469,
      todayClosedCount: 2,
      allTimeNetPnlUsd: 0.76871469,
      allTimeClosedCount: 3,
    });
  });

  it('fails closed when a purported closed trade lacks final economics', () => {
    expect(summarizeDailyRangeHeadline([
      { status: 'CLOSED', exitTimestamp: '2026-08-25T16:49:48.827Z', netPnlUsd: null },
    ], new Date('2026-08-26T05:30:00.000Z'))).toBeNull();
  });

  it('includes a fully settled post-fill safety unwind but excludes an unfilled abort', () => {
    expect(summarizeDailyRangeHeadline([
      { status: 'CLOSED', exitTimestamp: '2026-08-25T16:49:48.827Z', netPnlUsd: 0.5 },
      { status: 'ENTRY_ABORT_POST_FILL_ECONOMICS_FAIL', exitTimestamp: '2026-08-25T17:49:48.827Z', netPnlUsd: -0.2 },
      { status: 'ENTRY_ABORT_EXECUTION_FAILED', exitTimestamp: null, netPnlUsd: null },
    ], new Date('2026-08-26T05:30:00.000Z'))).toMatchObject({
      allTimeClosedCount: 2,
      allTimeNetPnlUsd: 0.3,
      todayClosedCount: 2,
      todayNetPnlUsd: 0.3,
    });
  });
});

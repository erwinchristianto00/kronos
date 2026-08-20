import { describe, expect, it } from 'vitest';
import { basketHorizonSchedule, taipeiDateTime } from '../src/TestnetExchangeDashboard';

describe('basket horizon display', () => {
  it('renders the frozen 36-hour execution close, not the later 48-hour measurement timestamp', () => {
    const openedAt = '2026-08-20T10:07:57.889Z';
    const schedule = basketHorizonSchedule({
      basketId: 'xb-live-fixture',
      openedAt,
      // This mirrors the persisted research measurement timestamp from the live executor.
      closesAtMs: Date.parse(openedAt) + 48 * 3_600_000,
      policyFingerprint: { execution: { executionCapHours: 36 } },
      legs: [],
    }, {
      enabled: true,
      maxHoldHours: 36,
      legacyExitPolicy: { executionCapHours: 36 },
    });

    expect(schedule.closeAtMs).toBe(Date.parse(openedAt) + 36 * 3_600_000);
    expect(schedule.source).toBe('basket fingerprint');
    expect(taipeiDateTime(schedule.closeAtMs)).toBe('22/08/2026 06:07');
  });

  it('uses the legacy contract for an older basket and never invents a timestamp', () => {
    const openedAt = '2026-08-19T06:06:23.713Z';
    const schedule = basketHorizonSchedule({
      basketId: 'xb-testnet-fixture',
      openedAt,
      closesAtMs: Date.parse(openedAt) + 48 * 3_600_000,
      legs: [],
    }, {
      enabled: true,
      maxHoldHours: 36,
      legacyExitPolicy: { executionCapHours: 36, takeProfitEnabled: true },
    });

    expect(schedule.closeAtMs).toBe(Date.parse(openedAt) + 36 * 3_600_000);
    expect(schedule.source).toBe('legacy basket contract');
    expect(schedule.earlyExitPossible).toBe(true);
    expect(taipeiDateTime('not-a-date')).toBeNull();
  });
});

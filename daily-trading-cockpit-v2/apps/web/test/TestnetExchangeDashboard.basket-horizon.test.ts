import { describe, expect, it } from 'vitest';
import { basketExitPlan, basketHorizonSchedule, taipeiDateTime } from '../src/TestnetExchangeDashboard';

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

  it('shows the frozen Dynamic MOM36 hard cut and MFE giveback as real exits, not disabled TP/SL', () => {
    const basket = {
      basketId: 'xb-dynamic-v3-fixture',
      openedAt: '2026-08-27T02:44:34.852Z',
      closesAtMs: Date.parse('2026-08-27T02:44:34.852Z') + 48 * 3_600_000,
      policyFingerprint: {
        execution: {
          executionCapHours: 36,
          takeProfitEnabled: false,
          stopLossEnabled: false,
          dynamicV3Exit: {
            hardCutLossNetReturn: -0.02,
            mfeArmNetReturn: 0.03,
            mfeGivebackFraction: 0.3,
          },
        },
      },
      dynamicMom36V3Exit: {
        hardCutLossThreshold: -0.02,
        mfeArmThreshold: 0.03,
        mfeGivebackFraction: 0.3,
        peakMfeReturn: 0.004,
        mfeTrailArmed: false,
      },
      legs: [],
    };
    const executor = { enabled: true, tpDisabled: true, stopNetReturnPct: null, maxHoldHours: 36 };
    const exit = basketExitPlan(basket, executor);
    const schedule = basketHorizonSchedule(basket, executor);

    expect(exit.fixedTakeProfitNetReturn).toBeNull();
    expect(exit.dynamicHardCutNetReturn).toBe(-0.02);
    expect(exit.stopNetReturn).toBe(-0.02);
    expect(exit.hasMfeGiveback).toBe(true);
    expect(exit.mfeArmNetReturn).toBe(0.03);
    expect(exit.mfeGivebackFraction).toBe(0.3);
    expect(exit.peakMfeReturn).toBe(0.004);
    expect(schedule.earlyExitPossible).toBe(true);
  });
});

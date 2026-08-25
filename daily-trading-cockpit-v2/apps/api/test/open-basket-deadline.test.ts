import { describe, expect, it } from 'vitest';
import { scheduledOpenBasketDeadline } from '../src/routes/live.js';

const openedAt = '2026-08-20T10:07:57.889Z';
const measurementCloseAtMs = Date.parse(openedAt) + 48 * 3_600_000;

describe('scheduledOpenBasketDeadline', () => {
  it('uses the frozen 36-hour policy deadline instead of exposing the later 48-hour measurement horizon', () => {
    const deadline = scheduledOpenBasketDeadline({
      openedAt,
      closesAtMs: measurementCloseAtMs,
      policyFingerprint: {
        execution: { executionCapHours: 36, takeProfitEnabled: false, stopLossEnabled: false, adaptiveExitsEnabled: false },
      },
    }, { executionCapHours: 48 });

    expect(deadline).toEqual({
      scheduledCloseAtMs: Date.parse(openedAt) + 36 * 3_600_000,
      executionCapHours: 36,
      deadlineSource: 'BASKET_POLICY_FINGERPRINT',
      mayExitEarlier: false,
    });
  });

  it('uses the frozen legacy contract and labels an earlier TP/SL-capable exit honestly', () => {
    const deadline = scheduledOpenBasketDeadline({ openedAt, closesAtMs: measurementCloseAtMs }, {
      executionCapHours: 36,
      takeProfitEnabled: true,
      stopLossEnabled: true,
    });

    expect(deadline.scheduledCloseAtMs).toBe(Date.parse(openedAt) + 36 * 3_600_000);
    expect(deadline.deadlineSource).toBe('LEGACY_BASKET_CONTRACT');
    expect(deadline.mayExitEarlier).toBe(true);
  });

  it('never moves an execution deadline past the measurement horizon or invents a policy', () => {
    const cappedLate = scheduledOpenBasketDeadline({
      openedAt,
      closesAtMs: measurementCloseAtMs,
      policyFingerprint: { execution: { executionCapHours: 72 } },
    }, { executionCapHours: 36 });
    const noPolicy = scheduledOpenBasketDeadline({ openedAt, closesAtMs: measurementCloseAtMs }, null);

    expect(cappedLate.scheduledCloseAtMs).toBe(measurementCloseAtMs);
    expect(noPolicy).toMatchObject({
      scheduledCloseAtMs: measurementCloseAtMs,
      executionCapHours: null,
      deadlineSource: 'MEASUREMENT_HORIZON',
      mayExitEarlier: false,
    });
  });

  it('uses a Dynamic basket\'s persisted actual-fill deadline rather than recomputing from scan time', () => {
    const actualFillDeadline = Date.parse(openedAt) + 36 * 3_600_000 + 47_000;
    const deadline = scheduledOpenBasketDeadline({
      openedAt,
      closesAtMs: measurementCloseAtMs,
      horizonExitAtMs: actualFillDeadline,
      policyFingerprint: { execution: { executionCapHours: 36 } },
    }, null);
    expect(deadline.scheduledCloseAtMs).toBe(actualFillDeadline);
  });
});

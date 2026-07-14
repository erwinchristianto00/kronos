/**
 * Causal simulation clock (Market Digital Twin, Phase-1 foundation). Market time comes ONLY from the replay path or
 * this clock — NEVER Date.now(). Time cannot move backward. Processing (wall-clock) time is tracked SEPARATELY and
 * must never leak into market features. Pure, deterministic, no I/O.
 */

export interface SimulationClock {
  /** Current MARKET time (ms). */
  nowMs(): number;
  /** Jump market time to an absolute timestamp (must be ≥ current). */
  advanceTo(timestampMs: number): void;
  /** Advance market time by a non-negative duration. */
  advanceBy(durationMs: number): void;
}

class MonotonicSimulationClock implements SimulationClock {
  private t: number;
  constructor(startMs: number) {
    if (!Number.isFinite(startMs)) throw new Error("clock start must be finite");
    this.t = startMs;
  }
  nowMs(): number { return this.t; }
  advanceTo(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) throw new Error("advanceTo non-finite");
    if (timestampMs < this.t) throw new Error(`clock cannot move backward: ${timestampMs} < ${this.t}`);
    this.t = timestampMs;
  }
  advanceBy(durationMs: number): void {
    if (!(durationMs >= 0) || !Number.isFinite(durationMs)) throw new Error(`advanceBy must be finite ≥ 0, got ${durationMs}`);
    this.t += durationMs;
  }
}

export function createSimulationClock(startMs: number): SimulationClock {
  return new MonotonicSimulationClock(startMs);
}

/**
 * Assert that an event's declared causal time is not in the future relative to `nowMs` when it is APPLIED. Event
 * application must occur exactly at or after the event's causal time — never before (that would be look-ahead).
 */
export function assertCausalApplication(eventCausalMs: number, appliedAtMarketMs: number, label: string): void {
  if (appliedAtMarketMs < eventCausalMs) {
    throw new Error(`causality violation: event "${label}" causal@${eventCausalMs} applied@${appliedAtMarketMs} (before it happened)`);
  }
}

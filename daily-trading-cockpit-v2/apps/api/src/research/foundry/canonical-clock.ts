import type { TournamentCandle } from "../tournament-types.js";
import { PointInTimeUniverse } from "../universe/point-in-time-universe.js";

export interface CanonicalClock { startMs: number; endMs: number; timeframeMs: number; timestamps: number[]; }
export interface ValidatedAbsence { symbol: string; openTimeMs: number; reason: "NOT_LISTED" | "HALTED" | "DATA_UNAVAILABLE"; sourceHash: string; }

export function buildCanonicalClock(input: { startMs: number; endMs: number; timeframeMs: number }): CanonicalClock {
  if (!Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) || !Number.isInteger(input.timeframeMs) || input.startMs < 0 || input.endMs <= input.startMs || input.timeframeMs <= 0 || input.startMs % input.timeframeMs !== 0 || input.endMs % input.timeframeMs !== 0) throw new Error("FOUNDRY_CANONICAL_CLOCK_INVALID");
  return { ...input, timestamps: Array.from({ length: (input.endMs - input.startMs) / input.timeframeMs }, (_, index) => input.startMs + index * input.timeframeMs) };
}

/** Every eligible symbol has one completed candle or an explicit sourced absence at every clock tick. */
export function assertCandlesCoverCanonicalClock(input: { clock: CanonicalClock; candles: readonly TournamentCandle[]; universe: PointInTimeUniverse; absences?: readonly ValidatedAbsence[] }): void {
  const candleByKey = new Map<string, TournamentCandle>();
  for (const candle of input.candles) {
    if (!input.clock.timestamps.includes(candle.openTimeMs) || candle.closeTimeMs !== candle.openTimeMs + input.clock.timeframeMs - 1) throw new Error(`FOUNDRY_CANONICAL_CLOCK_CANDLE_IRREGULAR_${candle.symbol}_${candle.openTimeMs}`);
    const key = `${candle.symbol}:${candle.openTimeMs}`; if (candleByKey.has(key)) throw new Error(`FOUNDRY_CANONICAL_CLOCK_DUPLICATE_${key}`); candleByKey.set(key, candle);
  }
  const absenceByKey = new Map((input.absences ?? []).map((absence) => {
    if (!absence.sourceHash || !input.clock.timestamps.includes(absence.openTimeMs)) throw new Error("FOUNDRY_CANONICAL_CLOCK_ABSENCE_INVALID");
    return [`${absence.symbol}:${absence.openTimeMs}`, absence];
  }));
  for (const openTimeMs of input.clock.timestamps) for (const symbol of input.universe.at(openTimeMs + input.clock.timeframeMs - 1)) {
    const key = `${symbol}:${openTimeMs}`; if (!candleByKey.has(key) && !absenceByKey.has(key)) throw new Error(`FOUNDRY_CANONICAL_CLOCK_MARK_MISSING_${key}`);
  }
}

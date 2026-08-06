import type { TournamentCandle } from "../tournament-types.js";
import { PointInTimeUniverse } from "../universe/point-in-time-universe.js";

export interface CanonicalClock { startMs: number; endMs: number; timeframeMs: number; timestamps: number[]; }
export interface ValidatedAbsence {
  symbol: string;
  openTimeMs: number;
  reason: "NOT_LISTED" | "HALTED" | "DATA_UNAVAILABLE";
  sourceHash: string;
  /** HALTED marks are sourced, explicit, and may be used for NAV only. */
  markPrice?: number;
  markPolicy?: "LAST_VALID_CLOSE" | "OFFICIAL_HALT_MARK";
}

export function buildCanonicalClock(input: { startMs: number; endMs: number; timeframeMs: number }): CanonicalClock {
  if (!Number.isInteger(input.startMs) || !Number.isInteger(input.endMs) || !Number.isInteger(input.timeframeMs) || input.startMs < 0 || input.endMs <= input.startMs || input.timeframeMs <= 0 || input.startMs % input.timeframeMs !== 0 || input.endMs % input.timeframeMs !== 0) throw new Error("FOUNDRY_CANONICAL_CLOCK_INVALID");
  return { ...input, timestamps: Array.from({ length: (input.endMs - input.startMs) / input.timeframeMs }, (_, index) => input.startMs + index * input.timeframeMs) };
}

/** Every eligible symbol has one completed candle or an explicit sourced absence at every clock tick. */
export function canonicalMarks(input: { clock: CanonicalClock; candles: readonly TournamentCandle[]; universe: PointInTimeUniverse; absences?: readonly ValidatedAbsence[] }): Map<string, number> {
  const candleByKey = new Map<string, TournamentCandle>();
  for (const candle of input.candles) {
    if (!input.clock.timestamps.includes(candle.openTimeMs) || candle.closeTimeMs !== candle.openTimeMs + input.clock.timeframeMs - 1) throw new Error(`FOUNDRY_CANONICAL_CLOCK_CANDLE_IRREGULAR_${candle.symbol}_${candle.openTimeMs}`);
    const key = `${candle.symbol}:${candle.openTimeMs}`; if (candleByKey.has(key)) throw new Error(`FOUNDRY_CANONICAL_CLOCK_DUPLICATE_${key}`); candleByKey.set(key, candle);
  }
  const absenceByKey = new Map<string, ValidatedAbsence>();
  for (const absence of input.absences ?? []) {
    if (!absence.sourceHash || !input.clock.timestamps.includes(absence.openTimeMs)) throw new Error("FOUNDRY_CANONICAL_CLOCK_ABSENCE_INVALID");
    const key = `${absence.symbol}:${absence.openTimeMs}`;
    if (absenceByKey.has(key) || candleByKey.has(key)) throw new Error(`FOUNDRY_CANONICAL_CLOCK_CANDLE_ABSENCE_CONFLICT_${key}`);
    if (absence.reason === "DATA_UNAVAILABLE") throw new Error(`FOUNDRY_CANONICAL_CLOCK_DATA_UNAVAILABLE_${key}`);
    if (absence.reason === "HALTED" && (!Number.isFinite(absence.markPrice) || absence.markPrice! <= 0 || !absence.markPolicy)) throw new Error(`FOUNDRY_CANONICAL_CLOCK_HALT_MARK_INVALID_${key}`);
    absenceByKey.set(key, absence);
  }
  const marks = new Map<string, number>();
  for (const [key, candle] of candleByKey) marks.set(key, candle.close);
  for (const openTimeMs of input.clock.timestamps) {
    const eligible = new Set(input.universe.at(openTimeMs + input.clock.timeframeMs - 1));
    for (const [key, absence] of absenceByKey) if (absence.openTimeMs === openTimeMs) {
      const isEligible = eligible.has(absence.symbol);
      if (absence.reason === "NOT_LISTED" && isEligible) throw new Error(`FOUNDRY_CANONICAL_CLOCK_NOT_LISTED_CONTRADICTS_UNIVERSE_${key}`);
      if (absence.reason === "HALTED" && !isEligible) throw new Error(`FOUNDRY_CANONICAL_CLOCK_HALT_NOT_ELIGIBLE_${key}`);
      if (absence.reason === "HALTED") marks.set(key, absence.markPrice!);
    }
    for (const symbol of eligible) {
      const key = `${symbol}:${openTimeMs}`; const absence = absenceByKey.get(key);
      if (!candleByKey.has(key) && (!absence || absence.reason !== "HALTED")) throw new Error(`FOUNDRY_CANONICAL_CLOCK_MARK_MISSING_${key}`);
    }
  }
  return marks;
}

/** Every eligible symbol has one completed candle or a sourced halt mark at every canonical tick. */
export function assertCandlesCoverCanonicalClock(input: { clock: CanonicalClock; candles: readonly TournamentCandle[]; universe: PointInTimeUniverse; absences?: readonly ValidatedAbsence[] }): void { canonicalMarks(input); }

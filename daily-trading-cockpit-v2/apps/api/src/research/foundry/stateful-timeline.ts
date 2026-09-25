import type { ValidatedFoundryRow } from "./semantic-validators.js";

export interface EffectiveState<T extends string | boolean> { symbol: string; effectiveTimeMs: number; validUntilMs?: number; value: T; sourceHash: string; }

/** State-transition timelines are sparse evidence, reconstructed at decision time. */
export class EffectiveStateTimeline<T extends string | boolean> {
  private readonly bySymbol = new Map<string, EffectiveState<T>[]>();

  constructor(rows: readonly EffectiveState<T>[]) {
    for (const row of rows) {
      if (!row.symbol || !row.sourceHash || !Number.isInteger(row.effectiveTimeMs) || row.effectiveTimeMs < 0 || (row.validUntilMs !== undefined && (!Number.isInteger(row.validUntilMs) || row.validUntilMs < row.effectiveTimeMs))) throw new Error("FOUNDRY_TIMELINE_ROW_INVALID");
      const prior = this.bySymbol.get(row.symbol) ?? [];
      const last = prior.at(-1);
      if (last && row.effectiveTimeMs <= last.effectiveTimeMs) throw new Error(`FOUNDRY_TIMELINE_CONTRADICTORY_TRANSITION_${row.symbol}_${row.effectiveTimeMs}`);
      if (last && row.value === last.value) throw new Error(`FOUNDRY_TIMELINE_REDUNDANT_TRANSITION_${row.symbol}_${row.effectiveTimeMs}`);
      prior.push(row); this.bySymbol.set(row.symbol, prior);
    }
  }

  at(symbol: string, timestampMs: number): EffectiveState<T> {
    const row = [...(this.bySymbol.get(symbol) ?? [])].reverse().find((candidate) => candidate.effectiveTimeMs <= timestampMs);
    if (!row) throw new Error(`FOUNDRY_TIMELINE_INITIAL_STATE_MISSING_${symbol}_${timestampMs}`);
    if (row.validUntilMs !== undefined && timestampMs > row.validUntilMs) throw new Error(`FOUNDRY_TIMELINE_STATE_PROVENANCE_EXPIRED_${symbol}_${timestampMs}`);
    return row;
  }

  assertCoverage(symbols: readonly string[], timestamps: readonly number[]): void {
    for (const symbol of symbols) for (const timestampMs of timestamps) this.at(symbol, timestampMs);
  }
}

export function listingTimeline(rows: readonly ValidatedFoundryRow[]): EffectiveStateTimeline<"LISTED" | "DELISTED"> {
  return new EffectiveStateTimeline(rows.map((row) => ({ symbol: row.symbol!, effectiveTimeMs: row.timestampMs, validUntilMs: row.validUntilMs as number, value: row.status as "LISTED" | "DELISTED", sourceHash: row.sourceHash })));
}

export function futuresTimeline(rows: readonly ValidatedFoundryRow[]): EffectiveStateTimeline<boolean> {
  return new EffectiveStateTimeline(rows.map((row) => ({ symbol: row.symbol!, effectiveTimeMs: row.timestampMs, validUntilMs: row.validUntilMs as number, value: row.available as boolean, sourceHash: row.sourceHash })));
}

export function minimumHistoryTimeline(rows: readonly ValidatedFoundryRow[]): EffectiveStateTimeline<boolean> {
  return new EffectiveStateTimeline(rows.map((row) => ({ symbol: row.symbol!, effectiveTimeMs: row.timestampMs, value: row.eligible as boolean, sourceHash: row.sourceHash })));
}

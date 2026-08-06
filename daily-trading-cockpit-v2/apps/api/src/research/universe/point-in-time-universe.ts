import type { PointInTimeUniverseSnapshot, TournamentCandle } from "../tournament-types.js";

/**
 * Resolves only from snapshots whose timestamp is no later than the decision
 * time.  There is deliberately no "latest snapshot" fallback: that would turn
 * delisted/newly listed assets into historical survivors.
 */
export class PointInTimeUniverse {
  private readonly snapshots: PointInTimeUniverseSnapshot[];

  constructor(snapshots: PointInTimeUniverseSnapshot[]) {
    if (snapshots.length === 0) throw new Error("TOURNAMENT_POINT_IN_TIME_UNIVERSE_MISSING");
    this.snapshots = snapshots.map((snapshot) => ({
      ...snapshot,
      eligibleSymbols: [...snapshot.eligibleSymbols].sort(),
      evidence: { ...snapshot.evidence },
    })).sort((a, b) => a.asOfMs - b.asOfMs);
  }

  at(asOfMs: number): ReadonlySet<string> {
    let selected: PointInTimeUniverseSnapshot | undefined;
    for (const snapshot of this.snapshots) {
      if (snapshot.asOfMs > asOfMs) break;
      selected = snapshot;
    }
    if (!selected) throw new Error("TOURNAMENT_UNIVERSE_LOOKAHEAD_OR_MISSING_SNAPSHOT");
    if (!Object.values(selected.evidence).every(Boolean)) {
      throw new Error("TOURNAMENT_UNIVERSE_SURVIVORSHIP_EVIDENCE_INCOMPLETE");
    }
    return new Set(selected.eligibleSymbols);
  }

  /** Ensures every decision candle is covered by an as-of snapshot and membership. */
  assertCoverage(candles: TournamentCandle[]): void {
    for (const candle of candles) {
      if (!this.at(candle.closeTimeMs).has(candle.symbol)) {
        throw new Error(`TOURNAMENT_SYMBOL_NOT_ELIGIBLE_AT_${candle.symbol}_${candle.closeTimeMs}`);
      }
    }
  }
}

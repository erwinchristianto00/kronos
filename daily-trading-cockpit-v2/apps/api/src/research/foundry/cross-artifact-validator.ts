import type { ValidatedFoundryRow } from "./semantic-validators.js";

function stateAt(rows: readonly ValidatedFoundryRow[], symbol: string, timestampMs: number, key: string): unknown {
  return [...rows].filter((row) => row.symbol === symbol && row.timestampMs <= timestampMs).sort((a, b) => b.timestampMs - a.timestampMs)[0]?.[key];
}

/** Eligibility cannot claim tradeability while listing/futures histories say otherwise. */
export function assertEligibilityTimelineConsistency(input: { listingRows: readonly ValidatedFoundryRow[]; futuresRows: readonly ValidatedFoundryRow[]; minimumHistoryRows: readonly ValidatedFoundryRow[] }): void {
  for (const row of input.minimumHistoryRows) {
    if (row.eligible !== true || !row.symbol) continue;
    const listed = stateAt(input.listingRows, row.symbol, row.timestampMs, "status"); const futuresAvailable = stateAt(input.futuresRows, row.symbol, row.timestampMs, "available");
    if (listed !== "LISTED" || futuresAvailable !== true) throw new Error(`FOUNDRY_ELIGIBILITY_TIMELINE_CONFLICT_${row.symbol}_${row.timestampMs}`);
  }
}

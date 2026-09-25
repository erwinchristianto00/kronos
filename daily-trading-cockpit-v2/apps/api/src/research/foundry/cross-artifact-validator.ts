import type { ValidatedFoundryRow } from "./semantic-validators.js";
import { futuresTimeline, listingTimeline, minimumHistoryTimeline } from "./stateful-timeline.js";

/** Eligibility cannot claim tradeability while listing/futures histories say otherwise. */
export function assertEligibilityTimelineConsistency(input: { listingRows: readonly ValidatedFoundryRow[]; futuresRows: readonly ValidatedFoundryRow[]; minimumHistoryRows: readonly ValidatedFoundryRow[] }): void {
  const listings = listingTimeline(input.listingRows); const futures = futuresTimeline(input.futuresRows); const minimumHistory = minimumHistoryTimeline(input.minimumHistoryRows);
  for (const row of input.minimumHistoryRows) {
    if (!row.symbol) continue;
    const listed = listings.at(row.symbol, row.timestampMs).value; const futuresAvailable = futures.at(row.symbol, row.timestampMs).value; const eligible = minimumHistory.at(row.symbol, row.timestampMs).value;
    if (eligible && (listed !== "LISTED" || futuresAvailable !== true)) throw new Error(`FOUNDRY_ELIGIBILITY_TIMELINE_CONFLICT_${row.symbol}_${row.timestampMs}`);
  }
}

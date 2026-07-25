import { resolve } from "node:path";

import { DirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";
import {
  FourBrainOutcomeLedger,
  rehydrateFourBrainOutcomeLedgerFromJournals,
} from "../src/lib/four-brain-outcome-ledger.js";

const dataDir = resolve(process.argv[2] ?? "data");
const store = new DirectionEntryOutcomeStore(dataDir);
const ledger = new FourBrainOutcomeLedger();
const report = rehydrateFourBrainOutcomeLedgerFromJournals({
  ledger,
  journalFiles: [
    resolve(dataDir, "four-brain-decision-journal.jsonl.1"),
    resolve(dataDir, "four-brain-decision-journal.jsonl"),
  ],
  hasProcessedDirection: (decisionId) => store.hasProcessedDirection(decisionId),
  hasProcessedEntry: (decisionId) => store.hasProcessedEntry(decisionId),
});

const safeToRestart =
  report.filesRead > 0 &&
  report.badLines === 0 &&
  report.directionEvictedDuringRehydrate === 0 &&
  report.entryEvictedDuringRehydrate === 0 &&
  report.directionEligibleUnprocessed === report.directionPendingRestored &&
  report.entryEligibleUnprocessed === report.entryPendingRestored;

console.log(JSON.stringify({ dataDir, safeToRestart, report }, null, 2));
if (!safeToRestart) process.exitCode = 2;

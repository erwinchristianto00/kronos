/**
 * Read-only tail reader for the CORTEX decision journal (`cortex-decision-journal.jsonl`, written by
 * `CortexDecisionJournal.append` in cortex-brain-store.ts — that class exposes no read method). Mirrors its own
 * rotation scheme (main file + a single `.1` backup once `CORTEX_JOURNAL_MAX_BYTES` is exceeded) and its
 * line-resilient parsing (skip any line that fails JSON.parse rather than aborting the whole read — a torn last
 * line from a concurrent append must never take down the reader). Read-only: never writes, truncates, or renames
 * anything. Pure w.r.t. its inputs beyond the filesystem read itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CortexJournalEntry {
  kind: string;
  at: string;
  mode: string;
  regimeFamily: string;
  posture: string;
  directionStance: string;
  grossG: number;
  beta: number;
  liveBeta: number;
  evaluationBeta: number;
  rationale: string;
  lanes: Array<{
    laneId: string;
    eligible: boolean;
    pWin: number;
    allocationMagnitude: number;
    finalPct: number;
    evalFinalPct: number;
    direction: string | null;
    reason: string;
  }>;
}

function parseLines(text: string): CortexJournalEntry[] {
  const out: CortexJournalEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CortexJournalEntry;
      if (parsed && parsed.kind === "BRAIN_DECISION") out.push(parsed);
    } catch {
      // torn/corrupt line — skip, never abort the read
    }
  }
  return out;
}

/** Read up to `maxEntries` most-recent journal entries (main file, falling back to the `.1` rotation if needed). */
export function readCortexJournalTail(dataDir = "data", maxEntries = 20): CortexJournalEntry[] {
  const mainPath = resolve(dataDir, "cortex-decision-journal.jsonl");
  const backupPath = `${mainPath}.1`;
  let entries: CortexJournalEntry[] = [];
  if (existsSync(mainPath)) {
    try {
      entries = parseLines(readFileSync(mainPath, "utf8"));
    } catch {
      entries = [];
    }
  }
  if (entries.length < maxEntries && existsSync(backupPath)) {
    try {
      const backupEntries = parseLines(readFileSync(backupPath, "utf8"));
      entries = [...backupEntries, ...entries];
    } catch {
      // ignore — main-file entries (if any) still stand
    }
  }
  return entries.slice(-maxEntries);
}

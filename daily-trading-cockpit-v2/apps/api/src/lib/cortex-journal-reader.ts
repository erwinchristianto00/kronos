/**
 * Read-only tail reader for the CORTEX decision journal (`cortex-decision-journal.jsonl`, written by
 * `CortexDecisionJournal.append` in cortex-brain-store.ts — that class exposes no read method). Mirrors its own
 * rotation scheme (main file + a single `.1` backup once `CORTEX_JOURNAL_MAX_BYTES` is exceeded) and its
 * line-resilient parsing (skip any line that fails JSON.parse rather than aborting the whole read — a torn last
 * line from a concurrent append must never take down the reader). Read-only: never writes, truncates, or renames
 * anything. Pure w.r.t. its inputs beyond the filesystem read itself.
 *
 * 2026-07-20 incident fix: this used to readFileSync the ENTIRE journal (main + .1 backup, tens of MB combined
 * once the journal has been running a while) just to return the last 1-20 entries — callers on a frequent poll
 * (dashboard, trading-assistant context) were doing this full-file read every few seconds, which was a real
 * contributing factor to the event-loop starvation behind that day's "clock skew" false alarm. Now reads only
 * a tail BYTE WINDOW via a file descriptor, growing the window (never shrinking correctness) until it has
 * enough parsed entries or has covered the whole file.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
      // torn/corrupt line (including a partial first line from a tail-window read) — skip, never abort
    }
  }
  return out;
}

/** Read the last `maxBytes` of `path` (the whole file if it's smaller). A tail window can start mid-line —
 *  the leading partial line is left for parseLines' existing torn-line tolerance to discard. */
function readTailBytes(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Parse `path` into entries, starting from a small tail window and quadrupling it until either enough
 *  entries are found or the window has grown to cover the whole file — so a short-entry-count run never
 *  reads more than it needs, while a file with very few/large entries still falls back to a full read. */
function readEntriesWithGrowingWindow(path: string, maxEntries: number): CortexJournalEntry[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  let windowBytes = 64 * 1024;
  for (;;) {
    let text: string;
    try {
      text = readTailBytes(path, windowBytes);
    } catch {
      return [];
    }
    const entries = parseLines(text);
    if (entries.length >= maxEntries || windowBytes >= size) return entries;
    windowBytes *= 4;
  }
}

/** Read up to `maxEntries` most-recent journal entries (main file, falling back to the `.1` rotation if needed). */
export function readCortexJournalTail(dataDir = "data", maxEntries = 20): CortexJournalEntry[] {
  const mainPath = resolve(dataDir, "cortex-decision-journal.jsonl");
  const backupPath = `${mainPath}.1`;
  let entries = readEntriesWithGrowingWindow(mainPath, maxEntries);
  if (entries.length < maxEntries && existsSync(backupPath)) {
    try {
      const backupEntries = readEntriesWithGrowingWindow(backupPath, maxEntries - entries.length);
      entries = [...backupEntries, ...entries];
    } catch {
      // ignore — main-file entries (if any) still stand
    }
  }
  return entries.slice(-maxEntries);
}

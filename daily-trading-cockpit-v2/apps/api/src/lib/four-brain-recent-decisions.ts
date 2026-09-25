/**
 * Four-Brain RECENT DECISIONS ring buffer (operator dashboard, 2026-07-23). Bounded in-memory ring holding
 * the most recent MARKET_SNAPSHOT + EXECUTIVE_DECISION journal records so a dashboard route can show
 * "what did four-brain just decide" WITHOUT ever re-reading the (potentially multi-MB, growing) journal
 * file on an HTTP request path. See cortex-decision-alpha-report.ts / cortex-journal-reader.ts's own doc
 * comments for the exact production incident (event-loop starvation from a full-file readFileSync +
 * JSON.parse on every dashboard poll) this buffer exists to avoid repeating on the four-brain journal too.
 *
 * Fed at journal-APPEND time (in-process, synchronous, zero extra I/O) via
 * wrapFourBrainJournalAppendForRecentDecisions, which sits IN FRONT of the real file-append call. The real
 * append is unconditional and never skipped/altered/suppressed by this wrapper — mirroring into the ring
 * is best-effort only (defensively try/catch'd) and can never affect the actual journal write.
 *
 * Pure + independently unit-testable: push/evict/order have no dependency on the journal file, the shadow
 * tick, or any live state.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

export interface FourBrainRecentDecisionsBufferOptions {
  /** Max records retained. Oldest is evicted (FIFO) once exceeded. Defaults to 100. */
  capacity?: number;
}

const DEFAULT_CAPACITY = 100;

/** Bounded ring buffer: push() evicts the OLDEST record once `capacity` is exceeded (FIFO eviction).
 *  getAll() returns everything currently held, MOST-RECENT-FIRST (reverse chronological — the natural
 *  order for a dashboard's "recent decisions" table). */
export class FourBrainRecentDecisionsBuffer {
  private readonly capacity: number;
  private buf: Record<string, unknown>[] = [];

  constructor(options: FourBrainRecentDecisionsBufferOptions = {}) {
    const cap = options.capacity;
    this.capacity = Number.isFinite(cap) && (cap as number) > 0 ? Math.floor(cap as number) : DEFAULT_CAPACITY;
  }

  push(record: Record<string, unknown>): void {
    this.buf.push(record);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  /** Most-recent-first. Returns a fresh array — callers cannot mutate internal buffer state through it. */
  getAll(): Record<string, unknown>[] {
    return [...this.buf].reverse();
  }

  get size(): number {
    return this.buf.length;
  }
}

/** Only these journal kinds are dashboard-relevant "decisions" — FOUR_BRAIN_CYCLE_METRICS (a per-cycle
 *  aggregate journaled separately by four-brain-live-wiring.ts) and any future kind are deliberately left
 *  out of this buffer so the recent-decisions table stays exactly what its name says. */
const RELEVANT_KINDS = new Set(["MARKET_SNAPSHOT", "EXECUTIVE_DECISION"]);

/**
 * Rehydrates the dashboard ring once at process boot. HTTP reads remain strictly
 * memory-only; this bounded tail read prevents a routine API restart from
 * turning a healthy Four-Brain card into a misleading empty state until the
 * next five-minute shadow cycle completes.
 */
export function hydrateFourBrainRecentDecisionsBuffer(
  buffer: FourBrainRecentDecisionsBuffer,
  journalPath: string,
  maxRecords = 100,
): number {
  if (!existsSync(journalPath)) return 0;
  const fd = openSync(journalPath, "r");
  try {
    const size = fstatSync(fd).size;
    // 2 MB is ample for the last 100 verbose journal records while avoiding a
    // full 8 MB rotated journal read on every boot.
    const bytes = Math.min(size, 2 * 1024 * 1024);
    const start = Math.max(0, size - bytes);
    const chunk = Buffer.alloc(bytes);
    readSync(fd, chunk, 0, bytes, start);
    const lines = chunk.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first fragment began before this tail window
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && RELEVANT_KINDS.has((parsed as { kind?: unknown }).kind as string)) {
          records.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A partial final line or a malformed historical record must never
        // prevent the live shadow layer from starting.
      }
    }
    for (const record of records.slice(-Math.max(1, maxRecords))) buffer.push(record);
    return Math.min(records.length, Math.max(1, maxRecords));
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * Wrap an existing journalAppend so it ALSO mirrors relevant records into the ring buffer, in addition to
 * the real append. Ordering: buffer mirror happens first, then the real (unconditional, unaltered) append —
 * either way, a throw from the buffer mirror is swallowed (best-effort) while a throw from the real append
 * propagates exactly as it did before this wrapper existed (its caller already handles that — see
 * four-brain-shadow-tick.ts's own try/catch around journalAppend).
 */
export function wrapFourBrainJournalAppendForRecentDecisions(
  journalAppend: (record: Record<string, unknown>) => void,
  buffer: FourBrainRecentDecisionsBuffer,
): (record: Record<string, unknown>) => void {
  return (record: Record<string, unknown>) => {
    try {
      if (RELEVANT_KINDS.has(record.kind as string)) buffer.push(record);
    } catch {
      /* buffer mirroring is best-effort observability only; must never affect the real append below */
    }
    journalAppend(record);
  };
}

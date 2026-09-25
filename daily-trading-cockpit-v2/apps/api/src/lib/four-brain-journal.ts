/**
 * Four-Brain report journal (Phase 1). Append-only jsonl of executive decisions — the auditable trace of
 * what all four brains + the incumbent thought, and whether it WOULD conceptually act. Drives nothing.
 *
 * Reuses the battle-tested CortexDecisionJournal for the write side (append-only, size rotation → single
 * .1 backup, endsWithNewline self-heal after a truncated write, never throws through the trading cycle) so
 * the "never crash / append-only / atomic-safe / bounded" journal contract is not re-implemented. The
 * reader tolerates malformed historical lines (per-line try/catch), reads both .jsonl and .jsonl.1, and
 * dedupes by decisionId so a rotation overlap can't double-count. Path is instance-relative (data/…),
 * matching every other store, so no cross-instance collision.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CortexDecisionJournal } from "./cortex-brain-store.js";
import type { ExecutiveDecision } from "./four-brain-types.js";

export const FOUR_BRAIN_JOURNAL_FILE = "four-brain-executive-journal.jsonl";

let journalSingleton: CortexDecisionJournal | null = null;
export function getFourBrainJournal(dataDir = "data"): CortexDecisionJournal {
  if (!journalSingleton) journalSingleton = new CortexDecisionJournal(resolve(dataDir, FOUR_BRAIN_JOURNAL_FILE));
  return journalSingleton;
}
export function _resetFourBrainJournalForTests(): void {
  journalSingleton = null;
}

/** Optional provenance folded into the report record so the shadow data is self-describing + trainable
 *  later (a future learning phase joins outcomes to THIS snapshot, exactly like CORTEX #218). */
export interface ExecutiveJournalContext {
  /** Runtime instance id (PORT: 3101/3102/3103) — so records stay distinguishable even if data dirs ever
   *  shared a path. Journal FILES are already instance-isolated via each process's own data dir. */
  instanceId?: string | null;
  horizon?: string | null;
  /** The RAW feature snapshot the brains consumed (pre-normalization), for audit. */
  rawFeatures?: Record<string, unknown>;
  /** The NORMALIZED feature snapshot (post freshness/clamp), for audit + future training. */
  normalizedFeatures?: Record<string, unknown>;
  /** Merged per-source freshness across all brains. */
  sourceStatuses?: Record<string, string>;
  /** Why each missing/null source is missing (never a silent gap). */
  missingReasons?: Record<string, string>;
  /** The INCUMBENT decision (what the existing system would do) — the fail-open baseline. */
  incumbent?: Record<string, unknown> | null;
  /** Invariant violations found this cycle (surfaced, not hidden). */
  invariantViolations?: string[];
  /** Stable candidate identity copied from FourBrainIdentity. Optional for legacy records. */
  signalId?: string | null;
  /** Stable open-position identity copied from FourBrainIdentity. Optional for legacy records. */
  positionId?: string | null;
}

/** Build the append-only report record. Carries schema versions, decision ids, validity, lane/symbol/
 *  horizon, raw + normalized snapshots, freshness, missing reasons, incumbent vs new-brain decisions,
 *  disagreements, whether it WOULD conceptually act, and reportOnly=true. */
export function buildExecutiveDecisionRecord(exec: ExecutiveDecision, ctx: ExecutiveJournalContext = {}): Record<string, unknown> {
  const wouldAct = exec.candidateStatus === "VALID";
  return {
    kind: "EXECUTIVE_DECISION",
    reportOnly: true,
    instanceId: ctx.instanceId ?? null,
    at: new Date(exec.asOfMs).toISOString(),
    asOfMs: exec.asOfMs,
    validUntilMs: exec.marketState.validUntilMs,
    schemaVersions: {
      executive: exec.schemaVersion,
      marketState: exec.marketState.schemaVersion,
      direction: exec.direction?.schemaVersion ?? null,
      entry: exec.entry?.schemaVersion ?? null,
      exit: exec.exit?.schemaVersion ?? null,
    },
    decisionIds: {
      executive: exec.decisionId,
      marketState: exec.marketState.decisionId,
      direction: exec.direction?.decisionId ?? null,
      entry: exec.entry?.decisionId ?? null,
      exit: exec.exit?.decisionId ?? null,
      allocationSnapshot: exec.allocationContext.snapshotId,
    },
    laneId: exec.laneId,
    symbolOrBasketId: exec.symbolOrBasketId,
    executionReinforcement: exec.executionReinforcement ?? null,
    shadowRanking: exec.shadowRanking ?? null,
    signalId: ctx.signalId ?? null,
    positionId: ctx.positionId ?? null,
    horizon: ctx.horizon ?? exec.direction?.horizon ?? null,
    candidateStatus: exec.candidateStatus,
    wouldAct,
    advisoryOnly: exec.advisoryOnly,
    allocationContext: exec.allocationContext,
    marketContext: exec.marketContext,
    disagreements: exec.disagreements,
    reasons: exec.reasons,
    brains: {
      marketState: exec.marketState,
      direction: exec.direction,
      entry: exec.entry,
      exit: exec.exit,
    },
    incumbent: ctx.incumbent ?? null,
    rawFeatures: ctx.rawFeatures ?? null,
    normalizedFeatures: ctx.normalizedFeatures ?? null,
    sourceStatuses: ctx.sourceStatuses ?? null,
    missingReasons: ctx.missingReasons ?? null,
    invariantViolations: ctx.invariantViolations ?? [],
  };
}

export interface ExecutiveJournalRow {
  decisionId: string;
  asOfMs: number;
  candidateStatus: string;
  wouldAct: boolean;
  laneId: string | null;
  symbolOrBasketId: string | null;
  disagreements: string[];
  raw: Record<string, unknown>;
}

/**
 * Read the executive journal (both the live .jsonl and the rotated .jsonl.1). Line-resilient: a truncated
 * or malformed line is skipped + counted, never aborts the read. Dedupes by executive decisionId (rotation
 * overlap / re-append can't double-count). Unknown lanes are surfaced (laneId kept as-is), never dropped.
 */
export function readExecutiveDecisionRows(files: string[]): { rows: ExecutiveJournalRow[]; badLines: number } {
  const byId = new Map<string, ExecutiveJournalRow>();
  let badLines = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        badLines += 1;
        continue;
      }
      if (rec.kind !== "EXECUTIVE_DECISION") continue;
      const ids = rec.decisionIds as Record<string, unknown> | undefined;
      const decisionId = typeof ids?.executive === "string" ? ids.executive : null;
      if (!decisionId || byId.has(decisionId)) continue; // missing/dup id — skip (dedupe)
      byId.set(decisionId, {
        decisionId,
        asOfMs: typeof rec.asOfMs === "number" ? rec.asOfMs : Number.NaN,
        candidateStatus: typeof rec.candidateStatus === "string" ? rec.candidateStatus : "UNKNOWN",
        wouldAct: rec.wouldAct === true,
        laneId: typeof rec.laneId === "string" ? rec.laneId : null,
        symbolOrBasketId: typeof rec.symbolOrBasketId === "string" ? rec.symbolOrBasketId : null,
        disagreements: Array.isArray(rec.disagreements) ? (rec.disagreements as string[]) : [],
        raw: rec,
      });
    }
  }
  return { rows: [...byId.values()].sort((a, b) => a.asOfMs - b.asOfMs), badLines };
}

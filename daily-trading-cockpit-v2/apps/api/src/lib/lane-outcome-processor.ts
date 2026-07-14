/**
 * Lane-outcome resolution processor (Track 1, Stage 2). PURE core: given the current closed paper outcomes, a
 * decision-snapshot provider, and the durable checkpoint, it plans which outcomes are NEWLY resolved, attributes
 * each to the latest eligible pre-open lane-context snapshot, and produces append-ready resolution records + the
 * next checkpoint. The impure binding (reading paper outcomes, journal append, atomic checkpoint write, single-
 * flight) lives in a thin adapter; ALL correctness (dedup / watermark / crash-recovery / attribution) is here and
 * fully testable.
 *
 * Safety: this module NEVER mutates a paper order, edge-memory, allocation, beta, or the kill switch, and makes no
 * execution call. It only reads outcomes + snapshots and emits report-only records.
 *
 * "Newly resolved" ⇔ terminal CLOSED_* AND `resolvedAtMs != null` (stamped only by the new close code on a genuine
 * non-terminal → terminal transition) AND not already consumed. A LEGACY order closed before this feature has
 * `resolvedAtMs == null` ⇒ it is NEVER emitted, even when read/updated.
 */
import { stableHash } from "./replay-provenance.js";
import { attributeOutcome, LANE_ATTRIBUTION_RULE_VERSION, type LaneContextSnapshot, type LaneOutcomeResolution } from "./lane-context-journal.js";

export const RESOLUTION_CHECKPOINT_SCHEMA = "lane-resolution-ckpt-2"; // v2: time-bounded consumed set (was count-FIFO)

/** A consumed outcome retained WITH its resolvedAtMs, so pruning is TIME-based (by the floor), never count-based.
 *  A count-bounded FIFO could evict an id still inside the reprocess window and re-emit it — this fixes that. */
export interface ConsumedEntry { id: string; r: number; }

export interface ResolutionCheckpoint {
  schemaVersion: string;
  instanceId: string;
  lastScanMs: number;
  /** Max resolvedAtMs ever processed. Outcomes older than this minus the reprocess window are never re-emitted. */
  highWatermarkResolvedAtMs: number;
  /** Consumed outcomes retained by resolvedAtMs — EVERYTHING in [watermark − reprocessWindow, watermark] is kept
   *  (never evicted by count). Naturally bounded by the trading rate × window; `maxConsumed` is a surfaced
   *  tripwire, not a silent evictor. */
  consumed: ConsumedEntry[];
  /** Count of resolution records appended to the journal (audit + a coarse recovery pointer). */
  journalPosition: number;
  updatedAtMs: number;
}

export function emptyCheckpoint(instanceId: string): ResolutionCheckpoint {
  return { schemaVersion: RESOLUTION_CHECKPOINT_SCHEMA, instanceId, lastScanMs: 0, highWatermarkResolvedAtMs: 0, consumed: [], journalPosition: 0, updatedAtMs: 0 };
}

/** Parse a persisted checkpoint; FAIL OPEN to an empty checkpoint (and flag it) on corruption / schema mismatch. */
export function parseCheckpoint(raw: string | null | undefined, instanceId: string): { checkpoint: ResolutionCheckpoint; corrupt: boolean } {
  if (!raw) return { checkpoint: emptyCheckpoint(instanceId), corrupt: false };
  try {
    const c = JSON.parse(raw) as ResolutionCheckpoint;
    if (c?.schemaVersion !== RESOLUTION_CHECKPOINT_SCHEMA || c.instanceId !== instanceId || !Array.isArray(c.consumed) || typeof c.highWatermarkResolvedAtMs !== "number") {
      return { checkpoint: emptyCheckpoint(instanceId), corrupt: true };
    }
    return { checkpoint: c, corrupt: false };
  } catch {
    return { checkpoint: emptyCheckpoint(instanceId), corrupt: true }; // fail open, surfaced
  }
}

export interface ClosedOutcomeInput {
  outcomeId: string;
  laneId: string;
  symbolOrBasketId: string;
  direction: string;
  openedAtMs: number;
  closedAtMs: number | null;
  resolvedAtMs: number | null;
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  closeReason: string | null;
  closeIntrabarAmbiguous?: boolean;
  featureSchemaVersion: string;
  terminal: boolean;
}

export interface ResolutionRecord extends LaneOutcomeResolution {
  /** DETERMINISTIC — hash(outcomeId, resolvedAtMs, rule). A retried append yields the SAME id ⇒ dedupable. */
  resolutionId: string;
  resolvedAtMs: number;
  closeReason: string | null;
  closeIntrabarAmbiguous: boolean;
  attributionLagMs: number | null;
  instanceId: string;
}

/** Deterministic resolution id — stable for the same (outcome, resolve-time). Truncated hash. */
export function resolutionIdFor(outcomeId: string, resolvedAtMs: number): string {
  return stableHash([outcomeId, resolvedAtMs, LANE_ATTRIBUTION_RULE_VERSION]).slice(0, 32);
}

export interface PlanOpts {
  ttlMs: number;
  /** How far below the watermark an outcome may still be considered (bounds the scan; must exceed a scan interval). */
  reprocessWindowMs: number;
  maxConsumed: number;
  instanceId: string;
  nowMs: number;
  expectedSchemaVersion?: string;
}

export interface PlanMetrics {
  scanned: number; emitted: number;
  skippedLegacyNoResolvedAt: number; skippedAlreadyConsumed: number; skippedBelowWatermarkWindow: number; skippedNonTerminal: number;
  byStatus: Record<string, number>;
  /** Retained consumed-window size after prune, and whether it exceeded maxConsumed (a SURFACED tripwire — the
   *  window population is larger than budgeted; we do NOT evict in-window ids to preserve exactly-once). */
  consumedRetained: number; consumedOverflow: boolean;
}

export interface PlanResult { emit: ResolutionRecord[]; nextCheckpoint: ResolutionCheckpoint; metrics: PlanMetrics; }

/**
 * Plan the newly-resolved outcomes. Pure — no I/O, no Date.now (uses opts.nowMs). The caller appends `emit` to the
 * journal FIRST, then persists `nextCheckpoint` (append-then-checkpoint). A crash between the two is recovered by
 * rebuilding the consumed set from the journal tail (see rebuildConsumedFromRecords) so nothing re-emits.
 */
export function planResolutions(
  outcomes: ClosedOutcomeInput[],
  decisionsFor: (o: ClosedOutcomeInput) => LaneContextSnapshot[],
  checkpoint: ResolutionCheckpoint,
  opts: PlanOpts,
): PlanResult {
  const consumed = new Set(checkpoint.consumed.map((c) => c.id));
  const watermark = checkpoint.highWatermarkResolvedAtMs;
  const floor = watermark - Math.max(0, opts.reprocessWindowMs);
  const metrics: PlanMetrics = { scanned: outcomes.length, emitted: 0, skippedLegacyNoResolvedAt: 0, skippedAlreadyConsumed: 0, skippedBelowWatermarkWindow: 0, skippedNonTerminal: 0, byStatus: {}, consumedRetained: 0, consumedOverflow: false };
  const emit: ResolutionRecord[] = [];
  let maxResolved = watermark;

  // Deterministic order: by resolvedAtMs then outcomeId, so re-runs plan identically.
  const sorted = [...outcomes].sort((a, b) => (a.resolvedAtMs ?? 0) - (b.resolvedAtMs ?? 0) || a.outcomeId.localeCompare(b.outcomeId));
  for (const o of sorted) {
    if (!o.terminal) { metrics.skippedNonTerminal += 1; continue; }
    if (o.resolvedAtMs == null) { metrics.skippedLegacyNoResolvedAt += 1; continue; } // legacy pre-feature close — never emitted
    if (consumed.has(o.outcomeId)) { metrics.skippedAlreadyConsumed += 1; continue; }
    if (o.resolvedAtMs < floor) { metrics.skippedBelowWatermarkWindow += 1; continue; } // older than the guarded window

    const decisions = decisionsFor(o);
    const res = attributeOutcome(
      { outcomeId: o.outcomeId, laneId: o.laneId, symbolOrBasketId: o.symbolOrBasketId, direction: o.direction, lifecycle: { openedAtMs: o.openedAtMs, closedAtMs: o.closedAtMs, resolvedAtMs: o.resolvedAtMs }, netR: o.netR, grossR: o.grossR, costR: o.costR, featureSchemaVersion: o.featureSchemaVersion },
      decisions,
      { ttlMs: opts.ttlMs, expectedSchemaVersion: opts.expectedSchemaVersion },
    );
    const chosen = res.attributedDecisionId != null ? decisions.find((d) => d.decisionId === res.attributedDecisionId) : undefined;
    const rec: ResolutionRecord = {
      ...res,
      resolutionId: resolutionIdFor(o.outcomeId, o.resolvedAtMs),
      resolvedAtMs: o.resolvedAtMs,
      closeReason: o.closeReason,
      closeIntrabarAmbiguous: o.closeIntrabarAmbiguous ?? false,
      attributionLagMs: chosen ? o.openedAtMs - chosen.asOfMs : null,
      instanceId: opts.instanceId,
    };
    emit.push(rec);
    consumed.add(o.outcomeId);
    metrics.emitted += 1;
    metrics.byStatus[res.attributionStatus] = (metrics.byStatus[res.attributionStatus] ?? 0) + 1;
    if (o.resolvedAtMs > maxResolved) maxResolved = o.resolvedAtMs;
  }

  // TIME-BOUNDED consumed set: retain EVERY entry whose resolvedAtMs is still inside the reprocess window of the
  // NEW watermark. Nothing in [floor2, watermark] is ever evicted (exactly-once), so a count cap can't drop an
  // in-window id. maxConsumed is only a surfaced tripwire if the window population is unexpectedly large.
  const floor2 = maxResolved - Math.max(0, opts.reprocessWindowMs);
  const byId = new Map<string, number>();
  for (const c of checkpoint.consumed) byId.set(c.id, c.r);
  for (const r of emit) byId.set(r.outcomeId, r.resolvedAtMs);
  const retained: ConsumedEntry[] = [...byId.entries()].map(([id, r]) => ({ id, r })).filter((c) => c.r >= floor2);
  metrics.consumedRetained = retained.length;
  metrics.consumedOverflow = retained.length > opts.maxConsumed; // SURFACED, but we do NOT drop in-window ids
  const nextCheckpoint: ResolutionCheckpoint = {
    schemaVersion: RESOLUTION_CHECKPOINT_SCHEMA, instanceId: opts.instanceId,
    lastScanMs: opts.nowMs, highWatermarkResolvedAtMs: maxResolved,
    consumed: retained, journalPosition: checkpoint.journalPosition + emit.length, updatedAtMs: opts.nowMs,
  };
  return { emit, nextCheckpoint, metrics };
}

/** Recovery: rebuild the consumed set from the journal tail so a crash AFTER append but BEFORE checkpoint update
 *  does not re-emit. Retains records by resolvedAtMs ≥ floor (NOT a count truncation), covering the whole reprocess
 *  window. Merge the result into the loaded checkpoint's consumed set before the first scan. */
export function rebuildConsumedFromRecords(records: Array<{ outcomeId: string; resolvedAtMs: number }>, floorMs: number): ConsumedEntry[] {
  return records.filter((r) => Number.isFinite(r.resolvedAtMs) && r.resolvedAtMs >= floorMs).map((r) => ({ id: r.outcomeId, r: r.resolvedAtMs }));
}

/** Single-flight guard: a trivial re-entrancy lock so overlapping resolution scans cannot run concurrently. */
export class SingleFlight {
  private running = false;
  async run<T>(fn: () => Promise<T> | T): Promise<T | null> {
    if (this.running) return null; // a scan is already in flight — skip this tick
    this.running = true;
    try { return await fn(); } finally { this.running = false; }
  }
  get inFlight(): boolean { return this.running; }
}

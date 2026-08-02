/**
 * Exact, in-process hand-off from a CORTEX decision to a paper opportunity.
 *
 * This is intentionally not a time-window matcher: an admission receives the
 * snapshot object that was current at the instant it was created and persists
 * its immutable id with the opportunity. Missing snapshots stay missing and
 * are ineligible for learning.
 */
import { createHash } from "node:crypto";
import type { CortexLaneDir } from "./cortex-attribution.js";

export interface CortexDecisionSnapshot {
  decisionId: string;
  /** Immutable allocation payload identity, captured with the CORTEX decision. */
  allocationSnapshotId: string;
  atMs: number;
  laneId: string;
  direction: CortexLaneDir | null;
  featureSchemaVersion: number;
  featureVector: number[];
  regimeFamily: string;
  eligible: boolean;
  finalPct: number;
  evalFinalPct: number;
  /** Assigned only when this snapshot is published against the exact scanner batch. */
  scanBatchId?: string | null;
  /** Immutable scanner batch seen by the CORTEX tick that created this snapshot. */
  sourceScanBatchId?: string | null;
}

const latestByLane = new Map<string, CortexDecisionSnapshot>();
const byScanBatch = new Map<string, readonly CortexDecisionSnapshot[]>();
/** Content fingerprint of the array first accepted for a given scanBatchId — the basis for the
 * idempotent-replay vs. conflicting-republish distinction below. */
const byScanBatchHash = new Map<string, string>();
/** scanBatchIds that received a byte-different republish. Poisoned: every downstream reader must
 * refuse these, even though the original (first-write) content is technically still sitting in
 * byScanBatch — a conflicted batch is wholly unusable, not "still fine except for the second call". */
const conflictedScanBatchIds = new Set<string>();
const MAX_SCAN_BATCH_HANDOFFS = 32;

/** Result of a publish attempt. PUBLISHED = first write for this scanBatchId accepted.
 * IDEMPOTENT = byte-identical replay of the content already published for this scanBatchId, a no-op.
 * CONFLICT = a second, content-different publish for a scanBatchId already published — refused;
 * the batch is poisoned and all downstream readers now see nothing for it. INVALID = malformed input. */
export type CortexScanPublicationResult = "PUBLISHED" | "IDEMPOTENT" | "CONFLICT" | "INVALID";

const validSnapshot = (snapshot: CortexDecisionSnapshot): boolean =>
  Boolean(snapshot.decisionId && snapshot.allocationSnapshotId && snapshot.laneId) &&
  Number.isFinite(snapshot.atMs) && Number.isInteger(snapshot.featureSchemaVersion) &&
  Array.isArray(snapshot.featureVector) && snapshot.featureVector.length > 0 && snapshot.featureVector.every(Number.isFinite) &&
  Number.isFinite(snapshot.finalPct) && Number.isFinite(snapshot.evalFinalPct);
const copySnapshot = (snapshot: CortexDecisionSnapshot): CortexDecisionSnapshot => ({ ...snapshot, featureVector: [...snapshot.featureVector] });

/** Stable content fingerprint over exactly the fields that define a snapshot's meaning, independent
 * of array order — so re-publishing the same decisions in a different array order is still IDEMPOTENT,
 * not a spurious CONFLICT. */
function scanBatchContentFingerprint(snapshots: readonly CortexDecisionSnapshot[]): string {
  const sortKey = (s: CortexDecisionSnapshot): string => `${s.laneId}\0${s.direction ?? ""}\0${s.decisionId}`;
  const projected = [...snapshots]
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
    .map((s) => ({
      decisionId: s.decisionId,
      allocationSnapshotId: s.allocationSnapshotId,
      sourceScanBatchId: s.sourceScanBatchId ?? null,
      laneId: s.laneId,
      direction: s.direction,
      featureSchemaVersion: s.featureSchemaVersion,
      featureVector: s.featureVector,
      atMs: s.atMs,
      regimeFamily: s.regimeFamily,
      eligible: s.eligible,
      finalPct: s.finalPct,
      evalFinalPct: s.evalFinalPct,
    }));
  return createHash("sha256").update(JSON.stringify(projected)).digest("hex");
}

export function cortexDecisionId(atMs: number, laneId: string, featureSchemaVersion: number): string {
  return `cortex-decision:${atMs}:${featureSchemaVersion}:${laneId}`;
}

export function cortexAllocationSnapshotId(decisionId: string): string {
  return `cortex-allocation:${decisionId}`;
}

export function publishCortexDecisionSnapshots(snapshots: readonly CortexDecisionSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (!validSnapshot(snapshot)) continue;
    latestByLane.set(snapshot.laneId, copySnapshot(snapshot));
  }
}

/** Captures a CORTEX allocation result under the immutable scan batch that supplied the candidates.
 * Consumers must request the full scan identity plus lane/direction; this is intentionally not a
 * lane-only or nearest-time lookup.
 *
 * Immutable per scanBatchId: the first valid publish for a given scanBatchId wins. A later publish
 * for the same scanBatchId with byte-identical content is a no-op (IDEMPOTENT) — safe to call on
 * every retry/replay of the same cycle. A later publish with different content is refused
 * (CONFLICT) and never silently overwrites the first-write array; the batch is also poisoned so
 * downstream readers stop serving even the original content for it — a scanBatchId that produced
 * two different answers cannot be trusted for either answer. */
export function publishCortexDecisionSnapshotsForScan(
  scanBatchId: string,
  snapshots: readonly CortexDecisionSnapshot[],
): CortexScanPublicationResult {
  if (!scanBatchId || !snapshots.length || snapshots.some((snapshot) =>
    !validSnapshot(snapshot) || snapshot.sourceScanBatchId !== scanBatchId,
  )) return "INVALID";
  const stamped = snapshots.map((snapshot) => copySnapshot({ ...snapshot, scanBatchId }));
  const fingerprint = scanBatchContentFingerprint(stamped);
  if (!byScanBatch.has(scanBatchId)) {
    byScanBatch.set(scanBatchId, stamped);
    byScanBatchHash.set(scanBatchId, fingerprint);
    while (byScanBatch.size > MAX_SCAN_BATCH_HANDOFFS) {
      const oldest = byScanBatch.keys().next().value!;
      byScanBatch.delete(oldest);
      byScanBatchHash.delete(oldest);
      conflictedScanBatchIds.delete(oldest);
    }
    return "PUBLISHED";
  }
  if (byScanBatchHash.get(scanBatchId) === fingerprint) return "IDEMPOTENT";
  conflictedScanBatchIds.add(scanBatchId);
  return "CONFLICT";
}

/** Returns only an exact scan-cycle/lane/direction handoff. No latest, nearest, or timestamp fallback
 * exists. A scanBatchId that has received a conflicting republish is refused here (returns []) — a
 * conflicted batch's content is never served, even though the first-write array is still retained
 * internally. */
export function cortexDecisionSnapshotsForScan(scanBatchId: string): readonly CortexDecisionSnapshot[] {
  if (conflictedScanBatchIds.has(scanBatchId)) return [];
  return (byScanBatch.get(scanBatchId) ?? []).map(copySnapshot);
}

/**
 * Returns a snapshot only when one immutable CORTEX allocation row belongs to
 * the exact scanner batch and canonical lane.  This deliberately treats
 * duplicate hand-offs as ambiguous rather than accepting the first row.
 */
export function exactCortexDecisionSnapshotForScan(input: {
  scanBatchId: string;
  canonicalCortexLaneId: string;
  direction: CortexLaneDir;
  snapshots: readonly CortexDecisionSnapshot[] | undefined;
}): CortexDecisionSnapshot | null {
  // Fail closed even if a caller sourced `snapshots` from somewhere other than
  // cortexDecisionSnapshotsForScan() (which already refuses conflicted batches) — a conflicted
  // scanBatchId must never resolve an exact match through any path.
  if (conflictedScanBatchIds.has(input.scanBatchId)) return null;
  const matches = (input.snapshots ?? []).filter((snapshot) =>
    snapshot.scanBatchId === input.scanBatchId &&
    snapshot.sourceScanBatchId === input.scanBatchId &&
    snapshot.laneId === input.canonicalCortexLaneId &&
    snapshot.direction === input.direction &&
    validSnapshot(snapshot),
  );
  return matches.length === 1 ? copySnapshot(matches[0]!) : null;
}

/** Returns a defensive copy so a caller cannot mutate the published decision. */
export function latestCortexDecisionSnapshotForLane(laneId: string): CortexDecisionSnapshot | null {
  const snapshot = latestByLane.get(laneId);
  return snapshot ? { ...snapshot, featureVector: [...snapshot.featureVector] } : null;
}

export function _resetCortexDecisionSnapshotsForTests(): void {
  latestByLane.clear();
  byScanBatch.clear();
  byScanBatchHash.clear();
  conflictedScanBatchIds.clear();
}

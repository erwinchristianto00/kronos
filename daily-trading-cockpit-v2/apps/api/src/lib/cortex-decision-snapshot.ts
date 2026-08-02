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
import { CORTEX_FEATURE_DIM, CORTEX_FEATURE_SCHEMA_VERSION } from "./cortex-brain.js";

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

/** The three real CortexLaneDir values. `null` is a value the producer can legitimately emit
 * (cortex-brain-store.ts, when deps.context.lanes has no matching entry for a lane), but such a
 * snapshot is already functionally dead — exactCortexDecisionSnapshotForScan's `direction` input is
 * typed non-null CortexLaneDir, so a null-direction snapshot can never match there. Rejecting it here
 * makes that dead-on-arrival state explicit at publish time instead of silently storing an unusable row. */
const VALID_DIRECTIONS: ReadonlySet<CortexLaneDir> = new Set(["LONG", "SHORT", "NEUTRAL"]);

/** Exhaustive, pre-write gate: every field is checked against the real canonical shape the one true
 * producer (runCortexShadowTick, cortex-brain-store.ts) emits, not just "present" or "some integer".
 * decisionId/allocationSnapshotId must exactly match what the canonical derivation functions below
 * would produce from the snapshot's own atMs/laneId/featureSchemaVersion/decisionId — a snapshot
 * whose id doesn't match its own content is malformed, not merely "different", so it is INVALID here
 * rather than reaching the CONFLICT path with a mismatched identity. */
const validSnapshot = (snapshot: CortexDecisionSnapshot): boolean =>
  Boolean(snapshot.decisionId && snapshot.allocationSnapshotId && snapshot.laneId) &&
  Number.isFinite(snapshot.atMs) &&
  snapshot.featureSchemaVersion === CORTEX_FEATURE_SCHEMA_VERSION &&
  snapshot.decisionId === cortexDecisionId(snapshot.atMs, snapshot.laneId, snapshot.featureSchemaVersion) &&
  snapshot.allocationSnapshotId === cortexAllocationSnapshotId(snapshot.decisionId) &&
  Array.isArray(snapshot.featureVector) &&
  snapshot.featureVector.length === CORTEX_FEATURE_DIM &&
  snapshot.featureVector.every(Number.isFinite) &&
  snapshot.direction !== null && VALID_DIRECTIONS.has(snapshot.direction) &&
  (snapshot.sourceScanBatchId === undefined || snapshot.sourceScanBatchId === null ||
    (typeof snapshot.sourceScanBatchId === "string" && snapshot.sourceScanBatchId.length > 0)) &&
  typeof snapshot.regimeFamily === "string" && snapshot.regimeFamily.length > 0 &&
  typeof snapshot.eligible === "boolean" &&
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
  // A single scanBatchId publication is only ever supposed to carry one snapshot per lane+direction
  // combination — reject the whole call before any write if two snapshots in this same array share
  // the same (laneId, direction) pair.
  const seenLaneDirection = new Set<string>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.laneId}\0${snapshot.direction ?? ""}`;
    if (seenLaneDirection.has(key)) return "INVALID";
    seenLaneDirection.add(key);
  }
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

/** Read-only: true once ANY content has been accepted (PUBLISHED) for this scanBatchId, whether or
 *  not it was later conflicted. Lets a periodic re-firing caller (the ONLY realistic source of a
 *  same-scanBatchId republish today — app.ts's two CORTEX ticks, 5-min cadence vs a 7-min scan
 *  cache) skip attempting a fresh publish of its own routine repeat entirely, so its own wall-clock
 *  re-fire never reaches the CONFLICT-detection path. A genuine different-content publish from any
 *  OTHER source under the same scanBatchId is unaffected: publishCortexDecisionSnapshotsForScan
 *  itself is unchanged and still fails closed to CONFLICT exactly as before. */
export function isScanBatchPublished(scanBatchId: string): boolean {
  return byScanBatch.has(scanBatchId);
}

/** Decision returned by scanBatchTickBinding — see that function's doc. A discriminated union so
 * callers get compile-time narrowing: shouldPublish===true guarantees tickScanBatchId is the real
 * (non-null) scanBatchId, shouldPublish===false guarantees it is null. */
export type ScanBatchTickBinding =
  | { shouldPublish: true; tickScanBatchId: string }
  | { shouldPublish: false; tickScanBatchId: null };

/** Pure, single source of truth for the scanBatchId-binding decision every periodic CORTEX tick must
 * make (app.ts's cortexShadowTick and cortexStandaloneShadowTick, and any test that exercises the
 * same "two real periodic ticks" scenario) — do not re-derive this conditional inline anywhere else.
 *
 * Given the scanBatchId currently cached for this cycle (or null/undefined when nothing is cached
 * yet), decides both:
 *  - what scanBatchId the tick itself should run WITH (`tickScanBatchId`): the real id when this
 *    batch has not yet been published, so the tick's output snapshots are correctly tagged with it;
 *    null (unbound/report-only) once the batch is already published, so a routine re-fire on the
 *    same cadence never re-tags with a stale-but-real id it must not attempt to publish again.
 *  - whether the caller should attempt a publish after the tick runs (`shouldPublish`) — exactly
 *    when tickScanBatchId is the real id.
 *
 * See isScanBatchPublished's doc for why a repeat tick against an already-published batch must run
 * fully unbound rather than being silently skipped while still tagged with the real id. */
export function scanBatchTickBinding(scanBatchId: string | null | undefined): ScanBatchTickBinding {
  if (scanBatchId && !isScanBatchPublished(scanBatchId)) {
    return { shouldPublish: true, tickScanBatchId: scanBatchId };
  }
  return { shouldPublish: false, tickScanBatchId: null };
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

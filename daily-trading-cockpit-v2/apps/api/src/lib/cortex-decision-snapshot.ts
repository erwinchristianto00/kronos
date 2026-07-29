/**
 * Exact, in-process hand-off from a CORTEX decision to a paper opportunity.
 *
 * This is intentionally not a time-window matcher: an admission receives the
 * snapshot object that was current at the instant it was created and persists
 * its immutable id with the opportunity. Missing snapshots stay missing and
 * are ineligible for learning.
 */
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
}

const latestByLane = new Map<string, CortexDecisionSnapshot>();

export function cortexDecisionId(atMs: number, laneId: string, featureSchemaVersion: number): string {
  return `cortex-decision:${atMs}:${featureSchemaVersion}:${laneId}`;
}

export function cortexAllocationSnapshotId(decisionId: string): string {
  return `cortex-allocation:${decisionId}`;
}

export function publishCortexDecisionSnapshots(snapshots: readonly CortexDecisionSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (
      !snapshot.decisionId || !snapshot.allocationSnapshotId || !snapshot.laneId || !Number.isFinite(snapshot.atMs) ||
      !Number.isInteger(snapshot.featureSchemaVersion) ||
      !Array.isArray(snapshot.featureVector) || !snapshot.featureVector.every(Number.isFinite) ||
      !Number.isFinite(snapshot.finalPct) || !Number.isFinite(snapshot.evalFinalPct)
    ) continue;
    latestByLane.set(snapshot.laneId, {
      ...snapshot,
      featureVector: [...snapshot.featureVector],
    });
  }
}

/** Returns a defensive copy so a caller cannot mutate the published decision. */
export function latestCortexDecisionSnapshotForLane(laneId: string): CortexDecisionSnapshot | null {
  const snapshot = latestByLane.get(laneId);
  return snapshot ? { ...snapshot, featureVector: [...snapshot.featureVector] } : null;
}

export function _resetCortexDecisionSnapshotsForTests(): void {
  latestByLane.clear();
}

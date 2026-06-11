/**
 * LATEST SCAN CANDIDATES CACHE (REPORT-ONLY, IN-MEMORY)
 *
 * A tiny process-local cache that holds the most recent core-scan-cycle
 * candidates so the operator-brief paper-opportunity allocator can evaluate
 * FRESH /api/scan candidates without triggering an expensive re-scan inside
 * the brief request handler.
 *
 * HARD INVARIANTS:
 *  - In-memory only. Never persisted. Never touches data/shadow-positions.json
 *    or any other store.
 *  - Carries the scan's own generatedAt as scanFinishedAt (anti-lookahead:
 *    the allocator must use the source scan timestamp, never the brief request
 *    time, for its freshness window).
 *  - Read-only consumers; writers are the scan cycle only.
 */

import type { Candidate } from "@dtc/shared";

export interface CachedScanCandidates {
  /** Stable id for this scan batch — the scan's generatedAt ISO string. */
  scanBatchId: string;
  /** ISO timestamp the source scan finished (its generatedAt). */
  scanFinishedAt: string;
  /** ISO timestamp this process cached the scan candidates for allocator reads. */
  candidatesCachedAt?: string;
  marketRegime: string;
  candidates: Candidate[];
}

let _cache: CachedScanCandidates | null = null;

export function setLatestScanCandidates(snapshot: CachedScanCandidates): void {
  _cache = snapshot;
}

export function getLatestScanCandidates(): CachedScanCandidates | null {
  return _cache;
}

export function _resetLatestScanCandidatesForTests(): void {
  _cache = null;
}

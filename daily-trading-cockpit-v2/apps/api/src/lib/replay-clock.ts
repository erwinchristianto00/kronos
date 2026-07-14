/**
 * Historical replay — causal clock + snapshot audit (Phase 4). The replay must preserve causality: at a
 * decision instant `asOfMs` no component may see a future candle value, a candle's final high/low before its
 * close, a future trade/funding/book, or a future MFE/MAE. This module is the causality backbone: it merges
 * time-ordered event streams, gates candle availability on close, rejects future/stale sources, and records the
 * snapshot-skew audit. Pure + deterministic (no Date.now).
 */

export interface ReplayEvent<T = unknown> { ts: number; kind: string; payload: T; }

/** A candle is AVAILABLE for a decision only after its close: openTime + intervalMs ≤ asOfMs. Using it earlier
 *  would leak the candle's final high/low/close. */
export function candleAvailableAt(openTimeMs: number, intervalMs: number, asOfMs: number): boolean {
  return Number.isFinite(openTimeMs) && Number.isFinite(intervalMs) && openTimeMs + intervalMs <= asOfMs;
}

/** Filter a candle series to only the candles CLOSED at/before asOfMs (the as-of window). Input may be unsorted;
 *  output is ascending by openTime. Never exposes a still-forming candle. */
export function closedCandlesAsOf<T extends { openTime: number }>(candles: T[], intervalMs: number, asOfMs: number): T[] {
  return candles.filter((c) => candleAvailableAt(c.openTime, intervalMs, asOfMs)).sort((a, b) => a.openTime - b.openTime);
}

/** K-way merge of pre-sorted event streams into one globally time-ordered stream. Stable on ties by stream
 *  index so replay is deterministic. Bounded to the sum of inputs (arrays); for true streaming use the async
 *  variant at the call site. */
export function mergeSortedEvents(streams: ReplayEvent[][]): ReplayEvent[] {
  const cursors = streams.map(() => 0);
  const out: ReplayEvent[] = [];
  const total = streams.reduce((a, s) => a + s.length, 0);
  for (let n = 0; n < total; n += 1) {
    let best = -1;
    for (let i = 0; i < streams.length; i += 1) {
      if (cursors[i]! >= streams[i]!.length) continue;
      if (best === -1 || streams[i]![cursors[i]!]!.ts < streams[best]![cursors[best]!]!.ts) best = i;
    }
    if (best === -1) break;
    out.push(streams[best]![cursors[best]!]!);
    cursors[best]! += 1;
  }
  return out;
}

export interface SourceReadingAt { name: string; ts: number | null; }

export interface ReplaySnapshotAudit {
  decisionAtMs: number;
  oldestSourceAtMs: number | null;
  newestSourceAtMs: number | null;
  snapshotSkewMs: number | null;
  staleSources: string[];
  missingSources: string[];
  /** A source whose timestamp is AFTER the decision — a hard causality violation (must poison the row). */
  futureSources: string[];
}

/**
 * Build the snapshot audit + detect causality violations. `ttlMsFor(name)` gives the per-source staleness
 * budget (a reading older than asOf−ttl is stale but not fatal); a reading NEWER than asOf is a future leak
 * (fatal — the row must be classified TIMESTAMP_UNSAFE). A missing (null-ts) source is recorded, not fabricated.
 */
export function buildSnapshotAudit(decisionAtMs: number, sources: SourceReadingAt[], ttlMsFor: (name: string) => number): ReplaySnapshotAudit {
  let oldest: number | null = null;
  let newest: number | null = null;
  const stale: string[] = [];
  const missing: string[] = [];
  const future: string[] = [];
  for (const s of sources) {
    if (s.ts == null || !Number.isFinite(s.ts)) { missing.push(s.name); continue; }
    if (s.ts > decisionAtMs) future.push(s.name);
    if (oldest === null || s.ts < oldest) oldest = s.ts;
    if (newest === null || s.ts > newest) newest = s.ts;
    const ttl = Math.max(0, ttlMsFor(s.name));
    if (decisionAtMs - s.ts > ttl) stale.push(s.name);
  }
  return {
    decisionAtMs,
    oldestSourceAtMs: oldest,
    newestSourceAtMs: newest,
    snapshotSkewMs: oldest !== null && newest !== null ? newest - oldest : null,
    staleSources: stale,
    missingSources: missing,
    futureSources: future,
  };
}

/** True iff the snapshot has NO future-leaking source — the causal gate the row's quality status depends on. */
export function isCausal(audit: ReplaySnapshotAudit): boolean {
  return audit.futureSources.length === 0;
}

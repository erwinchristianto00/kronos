/**
 * ENTRY BRAIN TIER 1 (REALIZED) outcome resolver (2026-07-23, PURE).
 *
 * WHY: part of the four-brain Direction/Entry counterfactual measurement design. When the incumbent
 * lane or executor independently opened the EXACT same signal Entry Brain evaluated as a real
 * position, Tier 1 joins Entry Brain's pending decision straight to that already-recorded real R-path
 * (position-path-recorder.ts) rather than simulating anything — the cheapest, most trustworthy
 * evidence tier. A decision with no matching real close simply stays PENDING here; falling through to
 * a simulated/estimated outcome is Tier 2, a separate resolver, and is explicitly out of scope for
 * this file.
 *
 * THE MATCH mirrors cortex-attribution.ts's own proven strict one-owning-decision windowed-match
 * contract (see that file's header for the original, adversarially-hardened algorithm this is a
 * SEPARATE, independent mirror of — this file never imports from or modifies cortex-attribution.ts;
 * a second key shape there is out of scope and risky per the 2026-07-22 CORTEX hardening work),
 * adapted to a different pair of inputs:
 *   - "decisions" here are PendingEntryRow (four-brain-outcome-ledger.ts) — Entry Brain's own
 *     journaled evaluations, keyed by decisionId, carrying asOfMs/laneId/symbolOrBasketId/side.
 *   - "outcomes" here are closed PositionPath records (position-path-recorder.ts) — the incumbent
 *     lane/executor's own REAL recorded R-path for a position that has actually closed.
 *
 * Rules (identical in spirit to CORTEX's contract, renamed to this domain):
 *  • Iterate CLOSES, not decisions. For each closed real position path, find THE ONE owning pending
 *    Entry decision = the LATEST pending row with asOfMs in [openedAtMs − ttl, openedAtMs], matching
 *    laneId + symbolOrBasketId + side. (Decision→next-close would let every stale decision before one
 *    close claim it → one close would mislabel many rows; picking the latest keeps the freshest
 *    signal as the honest cause of that specific position.)
 *  • Bounded window (ttl): no pending decision in range ⇒ the close simply has no Entry Brain
 *    counterfactual to join to at all (never a forced stale match).
 *  • One close claimed once, one decision claimed once: a decisionId consumed as an owner can never
 *    be reused by a later close — a single Entry Brain decision can never be double-counted as the
 *    cause of two different real positions it didn't actually open.
 *  • openedAtMs is approximated as the closed path's OWN earliest recorded tick (the first
 *    observation its real writer ever recorded for that position) — never the decision's own asOfMs
 *    (that would be circular), and never fabricated when ticks are empty (falls back to closedAtMs,
 *    which only narrows the window to zero-width, never widens it into a false match).
 *  • realizedR is the writer-supplied closeR, falling back to the last recorded tick's r — the SAME
 *    real number position-path-recorder.ts itself already stores. Never re-derived, never simulated.
 *  • realizedR is NOT one single unit across all resolved rows: position-path-recorder.ts's two real
 *    writers use genuinely different R conventions, documented on PositionPathMeta.source there —
 *    live-execution-engine.ts ("engine") writes NET realized R (realizedPnlUsd/effectiveRiskUsd,
 *    after fees/slippage); single-symbol-lane-executor.ts ("executor") writes RAW mark-R at exit
 *    (no cost netting). This resolver passes meta.source through verbatim as realizedRSource on
 *    every resolved row specifically so a caller aggregating/averaging realizedR (e.g. against the
 *    decision's own NET expectedNetR) can group or normalize by convention instead of silently
 *    mixing RAW and NET R as if they were the same unit.
 *  • No fabrication: a pending Entry row with no matching real close simply stays PENDING — this
 *    resolver returns pending for it; it does NOT fall through to any simulation (that is Tier 2).
 *  • Every resolved row is tagged confidence "MEASURED" — Tier 1 evidence is always a real recorded
 *    close, never experimental/simulated.
 *
 * Pure: no I/O, no singletons, no mutation of inputs. Deterministic given the same inputs (closed
 * paths are processed oldest-real-open-first, ties broken by path key), so calling this repeatedly
 * over the same (or a growing) snapshot always reproduces the same resolution — no accumulation, no
 * double-count across calls.
 */
import type { FourBrainOutcomeEntrySide, PendingEntryRow } from "./four-brain-outcome-ledger.js";
import type { PositionPath } from "./position-path-recorder.js";

/** Default bounded validity window if the caller doesn't specify one — mirrors CORTEX's own default
 *  directional exec signal TTL (cortex-attribution.ts's CORTEX_ATTR_DEFAULT_TTL_MS), not imported
 *  from there (this module is deliberately independent) but deliberately kept numerically identical. */
export const ENTRY_BRAIN_TIER1_DEFAULT_TTL_MS = 50 * 60_000;

export interface EntryBrainTier1ResolveOpts {
  /** Bounded validity window per lane (ms). Defaults to ENTRY_BRAIN_TIER1_DEFAULT_TTL_MS. */
  ttlMsForLane?: (laneId: string) => number;
}

/** A pending Entry Brain decision with no matching real close (yet, or ever) — never a fabricated
 *  value, just an honest "still pending". */
export interface EntryBrainTier1PendingRow {
  decisionId: string;
  status: "PENDING";
  laneId: string | null;
  symbolOrBasketId: string | null;
  side: FourBrainOutcomeEntrySide;
  decisionAsOfMs: number;
  expectedNetR: number | null;
}

/** An Entry Brain decision joined to the real closed position it caused. confidence is always
 *  "MEASURED" — Tier 1 is real evidence only. */
export interface EntryBrainTier1ResolvedRow {
  decisionId: string;
  status: "RESOLVED";
  confidence: "MEASURED";
  laneId: string;
  symbolOrBasketId: string;
  side: FourBrainOutcomeEntrySide;
  decisionAsOfMs: number;
  expectedNetR: number | null;
  targetEntry: number | null;
  initialStopPrice: number | null;
  /** The PositionPath.key of the real close this decision was joined to. */
  matchedCloseKey: string;
  /** The real close's own earliest recorded tick — the open-time proxy used for the windowed match. */
  openedAtMs: number;
  closedAtMs: number;
  /** The real, already-recorded R this position closed at (PositionPath.closeR, or its last tick's r
   *  when closeR itself is unset) — NEVER simulated, NEVER re-derived. */
  realizedR: number;
  /** Verbatim copy of the matched close's PositionPathMeta.source — documents which R convention
   *  realizedR is in ("engine" = NET realized R after fees/slippage; "executor" = RAW mark-R at
   *  exit, no cost netting). Callers MUST NOT average/aggregate realizedR across mixed sources
   *  without accounting for this — see this file's header for the full convention note. */
  realizedRSource: "engine" | "executor";
}

export type EntryBrainTier1Row = EntryBrainTier1PendingRow | EntryBrainTier1ResolvedRow;

export type EntryBrainTier1RejectionReason =
  | "MISSING_IDENTITY"
  | "NO_EXACT_LANE_SYMBOL_SIDE_CLOSE"
  | "SIGNAL_ID_MISMATCH"
  | "DECISION_AFTER_OPEN"
  | "OUTSIDE_TTL"
  | "COMPETING_DECISION";

export interface EntryBrainTier1Diagnostics {
  pendingRows: number;
  validPendingRows: number;
  closedPaths: number;
  matchableClosedPaths: number;
  unusableClosedPaths: number;
  matchedRows: number;
  /** Resolved joins where the journal and position path used different representations of the same
   * canonical lane (for example CG_WIDE_FAST_LONG vs CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG). */
  namespaceNormalizedMatches: number;
  /** Resolved joins owned by the exact stable signal id rather than the legacy time-window fallback. */
  signalIdentityMatches: number;
  rejectedRows: number;
  rejectionReasons: Record<EntryBrainTier1RejectionReason, number>;
}

export interface EntryBrainTier1ResolveResult {
  rows: EntryBrainTier1Row[];
  diagnostics: EntryBrainTier1Diagnostics;
}

function emptyRejectionReasons(): Record<EntryBrainTier1RejectionReason, number> {
  return {
    MISSING_IDENTITY: 0,
    NO_EXACT_LANE_SYMBOL_SIDE_CLOSE: 0,
    SIGNAL_ID_MISMATCH: 0,
    DECISION_AFTER_OPEN: 0,
    OUTSIDE_TTL: 0,
    COMPETING_DECISION: 0,
  };
}

const VARIANT_MATRIX_LANE_PREFIXES = ["CG_VARIANT_MATRIX:", "CG_LONG_VARIANT_MATRIX:"] as const;

/**
 * Normalize only the storage namespace around a variant id. Historical records keep their original
 * laneId; this value is used solely for the Tier-1 join key. Both matrix writers describe the same
 * canonical geometry id after the prefix, while side remains an independent join axis below.
 */
export function normalizeEntryTier1LaneNamespace(laneId: string): string {
  const normalized = laneId.trim().toUpperCase();
  for (const prefix of VARIANT_MATRIX_LANE_PREFIXES) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

function matchKey(laneId: string, symbolOrBasketId: string, side: string): string {
  return `${normalizeEntryTier1LaneNamespace(laneId)}::${symbolOrBasketId.trim().toUpperCase()}::${side}`;
}

function signalMatchKey(laneId: string, symbolOrBasketId: string, side: string, signalId: string): string {
  return `${matchKey(laneId, symbolOrBasketId, side)}::${signalId}`;
}

/** The real open-time proxy for a closed path: its own earliest recorded tick. Falls back to
 *  closedAtMs (narrows the window to zero-width, never widens it into a false match) when the path
 *  has no ticks at all — never fabricated. */
function pathOpenedAtMs(path: PositionPath): number {
  const first = path.ticks[0];
  if (first && Number.isFinite(first.t)) return first.t;
  return Number.isFinite(path.closedAtMs) ? (path.closedAtMs as number) : NaN;
}

/** The real realized R the path closed at: writer-supplied closeR, else the last recorded tick's r.
 *  null (never fabricated) when neither is a finite number. */
function pathRealizedR(path: PositionPath): number | null {
  if (Number.isFinite(path.closeR)) return path.closeR as number;
  const last = path.ticks[path.ticks.length - 1];
  return last && Number.isFinite(last.r) ? last.r : null;
}

interface MatchableClose {
  path: PositionPath;
  openedAtMs: number;
  closedAtMs: number;
  realizedR: number;
  realizedRSource: "engine" | "executor";
  signalId: string | null;
}

/** Defensive extraction of the joinable closed paths: meta-less, not-actually-closed, or
 *  no-honest-R paths are simply excluded from matching (never fabricate identity or R). */
function toMatchableCloses(paths: PositionPath[]): MatchableClose[] {
  const out: MatchableClose[] = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (!path || !path.meta || typeof path.key !== "string" || path.key.length === 0) continue;
    if (!Number.isFinite(path.closedAtMs)) continue; // not actually closed — never join an open path
    const openedAtMs = pathOpenedAtMs(path);
    if (!Number.isFinite(openedAtMs)) continue;
    const realizedR = pathRealizedR(path);
    if (realizedR === null) continue; // no honest R to join — never fabricate one
    out.push({
      path,
      openedAtMs,
      closedAtMs: path.closedAtMs as number,
      realizedR,
      realizedRSource: path.meta.source,
      signalId:
        typeof path.meta.signalId === "string" && path.meta.signalId.length > 0
          ? path.meta.signalId
          : null,
    });
  }
  return out;
}

/**
 * Resolve pending Entry Brain decisions against already-recorded REAL closed position paths, joining
 * on the strict one-owning-decision windowed match described in this file's header. Pure; safe to
 * call repeatedly over the same (or a growing) snapshot of inputs — never mutates them, never
 * accumulates any state across calls. Returns one row per input pending Entry row (same order is not
 * guaranteed to be preserved; callers needing display order should sort the result themselves).
 */
export function resolveEntryBrainTier1RealizedWithDiagnostics(
  pendingEntryRows: PendingEntryRow[],
  closedPaths: PositionPath[],
  opts: EntryBrainTier1ResolveOpts = {},
): EntryBrainTier1ResolveResult {
  const ttlFor = opts.ttlMsForLane ?? (() => ENTRY_BRAIN_TIER1_DEFAULT_TTL_MS);
  const rows = (Array.isArray(pendingEntryRows) ? pendingEntryRows : []).filter(
    (row): row is PendingEntryRow => !!row && typeof row.decisionId === "string" && row.decisionId.length > 0,
  );

  // Index pending rows by (laneId, symbolOrBasketId, side), ascending by asOfMs, so the windowed walk
  // below can find "the latest candidate at or before the close's own open" by scanning from the end.
  // Rows with no lane/symbol identity (null laneId or symbolOrBasketId) can never be joined — they are
  // simply never inserted into the index, so they always fall through to PENDING below. No identity is
  // ever fabricated for them.
  const byKey = new Map<string, PendingEntryRow[]>();
  const bySignalKey = new Map<string, PendingEntryRow[]>();
  for (const row of rows) {
    if (!row.laneId || !row.symbolOrBasketId) continue;
    if (!Number.isFinite(row.asOfMs)) continue;
    const key = matchKey(row.laneId, row.symbolOrBasketId, row.side);
    let arr = byKey.get(key);
    if (!arr) byKey.set(key, (arr = []));
    arr.push(row);
    if (typeof row.signalId === "string" && row.signalId.length > 0) {
      const exactKey = signalMatchKey(row.laneId, row.symbolOrBasketId, row.side, row.signalId);
      let exact = bySignalKey.get(exactKey);
      if (!exact) bySignalKey.set(exactKey, (exact = []));
      exact.push(row);
    }
  }
  for (const arr of byKey.values()) arr.sort((a, b) => a.asOfMs - b.asOfMs);
  for (const arr of bySignalKey.values()) arr.sort((a, b) => a.asOfMs - b.asOfMs);

  // Deterministic order: oldest real open first (ties broken by path key), mirroring
  // cortex-attribution's own "oldest resolved first" determinism note.
  const closes = toMatchableCloses(closedPaths).sort(
    (a, b) => a.openedAtMs - b.openedAtMs || a.path.key.localeCompare(b.path.key),
  );

  const consumedDecisionIds = new Set<string>(); // a decision, once it owns a close, can never own another
  const resolvedByDecisionId = new Map<string, EntryBrainTier1ResolvedRow>();
  let namespaceNormalizedMatches = 0;
  let signalIdentityMatches = 0;

  for (const close of closes) {
    const meta = close.path.meta!;
    const key = matchKey(meta.laneId, meta.symbol, meta.direction);
    const exactCandidates = close.signalId
      ? bySignalKey.get(signalMatchKey(meta.laneId, meta.symbol, meta.direction, close.signalId))
      : undefined;
    // Exact identity is authoritative when both sides carry it. The legacy fallback remains only
    // for historical rows where at least one side predates signal-id persistence; a different
    // non-null signal id can never claim this close merely because lane/symbol/side happen to match.
    const candidates =
      exactCandidates && exactCandidates.length > 0
        ? exactCandidates
        : (byKey.get(key) ?? []).filter(
            (candidate) => close.signalId === null || !candidate.signalId,
          );
    if (candidates.length === 0) continue;
    const ttl = Math.max(0, ttlFor(meta.laneId));
    const lo = close.openedAtMs - ttl;

    // Latest not-yet-consumed candidate with asOfMs in [lo, openedAtMs]. Candidates are ascending, so
    // walking from the end finds the latest eligible one first — exactly cortex-attribution's walk.
    let owner: PendingEntryRow | null = null;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]!;
      if (candidate.asOfMs > close.openedAtMs) continue; // decision after the open cannot own it
      if (candidate.asOfMs < lo) break; // past the TTL window; everything earlier is older still
      if (consumedDecisionIds.has(candidate.decisionId)) continue; // already claimed a different close
      owner = candidate;
      break;
    }
    if (!owner) continue;

    consumedDecisionIds.add(owner.decisionId);
    if (owner.laneId !== meta.laneId) namespaceNormalizedMatches += 1;
    if (close.signalId && owner.signalId === close.signalId) signalIdentityMatches += 1;
    resolvedByDecisionId.set(owner.decisionId, {
      decisionId: owner.decisionId,
      status: "RESOLVED",
      confidence: "MEASURED",
      laneId: owner.laneId as string,
      symbolOrBasketId: owner.symbolOrBasketId as string,
      side: owner.side,
      decisionAsOfMs: owner.asOfMs,
      expectedNetR: owner.expectedNetR,
      targetEntry: owner.targetEntry,
      initialStopPrice: owner.initialStopPrice,
      matchedCloseKey: close.path.key,
      openedAtMs: close.openedAtMs,
      closedAtMs: close.closedAtMs,
      realizedR: close.realizedR,
      realizedRSource: close.realizedRSource,
    });
  }

  const outputRows = rows.map((row): EntryBrainTier1Row => {
    const resolved = resolvedByDecisionId.get(row.decisionId);
    if (resolved) return resolved;
    return {
      decisionId: row.decisionId,
      status: "PENDING",
      laneId: row.laneId,
      symbolOrBasketId: row.symbolOrBasketId,
      side: row.side,
      decisionAsOfMs: row.asOfMs,
      expectedNetR: row.expectedNetR,
    };
  });

  const rejectionReasons = emptyRejectionReasons();
  const closesByIdentity = new Map<string, typeof closes>();
  const closesBySignalIdentity = new Map<string, typeof closes>();
  for (const close of closes) {
    const meta = close.path.meta!;
    const key = matchKey(meta.laneId, meta.symbol, meta.direction);
    const existing = closesByIdentity.get(key);
    if (existing) existing.push(close);
    else closesByIdentity.set(key, [close]);
    if (close.signalId) {
      const exactKey = signalMatchKey(meta.laneId, meta.symbol, meta.direction, close.signalId);
      const exact = closesBySignalIdentity.get(exactKey);
      if (exact) exact.push(close);
      else closesBySignalIdentity.set(exactKey, [close]);
    }
  }
  for (const row of outputRows) {
    if (row.status === "RESOLVED") continue;
    const source = rows.find((candidate) => candidate.decisionId === row.decisionId);
    if (!source?.laneId || !source.symbolOrBasketId || !Number.isFinite(source.asOfMs)) {
      rejectionReasons.MISSING_IDENTITY += 1;
      continue;
    }
    const key = matchKey(source.laneId, source.symbolOrBasketId, source.side);
    const laneCloses = closesByIdentity.get(key) ?? [];
    const exactSignalCloses =
      typeof source.signalId === "string" && source.signalId.length > 0
        ? closesBySignalIdentity.get(
            signalMatchKey(source.laneId, source.symbolOrBasketId, source.side, source.signalId),
          ) ?? []
        : [];
    const legacyCloses = laneCloses.filter((close) => close.signalId === null);
    const identityCloses =
      exactSignalCloses.length > 0
        ? exactSignalCloses
        : typeof source.signalId === "string" && source.signalId.length > 0
          ? legacyCloses
          : laneCloses;
    if (identityCloses.length === 0) {
      if (
        typeof source.signalId === "string"
        && source.signalId.length > 0
        && laneCloses.some((close) => close.signalId !== null)
      ) {
        rejectionReasons.SIGNAL_ID_MISMATCH += 1;
      } else {
        rejectionReasons.NO_EXACT_LANE_SYMBOL_SIDE_CLOSE += 1;
      }
      continue;
    }
    const ttl = Math.max(0, ttlFor(source.laneId));
    const eligible = identityCloses.filter(
      (close) =>
        source.asOfMs <= close.openedAtMs &&
        source.asOfMs >= close.openedAtMs - ttl,
    );
    if (eligible.length > 0) {
      rejectionReasons.COMPETING_DECISION += 1;
    } else if (identityCloses.every((close) => source.asOfMs > close.openedAtMs)) {
      rejectionReasons.DECISION_AFTER_OPEN += 1;
    } else {
      rejectionReasons.OUTSIDE_TTL += 1;
    }
  }

  return {
    rows: outputRows,
    diagnostics: {
      pendingRows: rows.length,
      validPendingRows: byKey.size === 0
        ? 0
        : rows.filter((row) => !!row.laneId && !!row.symbolOrBasketId && Number.isFinite(row.asOfMs)).length,
      closedPaths: Array.isArray(closedPaths) ? closedPaths.length : 0,
      matchableClosedPaths: closes.length,
      unusableClosedPaths: Math.max(0, (Array.isArray(closedPaths) ? closedPaths.length : 0) - closes.length),
      matchedRows: resolvedByDecisionId.size,
      namespaceNormalizedMatches,
      signalIdentityMatches,
      rejectedRows: outputRows.length - resolvedByDecisionId.size,
      rejectionReasons,
    },
  };
}

export function resolveEntryBrainTier1Realized(
  pendingEntryRows: PendingEntryRow[],
  closedPaths: PositionPath[],
  opts: EntryBrainTier1ResolveOpts = {},
): EntryBrainTier1Row[] {
  return resolveEntryBrainTier1RealizedWithDiagnostics(pendingEntryRows, closedPaths, opts).rows;
}

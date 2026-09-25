/**
 * Four-Brain OUTCOME LEDGER (Direction + Entry counterfactual measurement FOUNDATION, 2026-07-23). Bounded
 * in-memory FIFO ledger holding just enough of each journaled DIRECTION and ENTRY decision to resolve its
 * outcome LATER (a follow-up phase, not built here) — WITHOUT ever re-reading the (potentially multi-MB,
 * growing) four-brain journal file on that later resolution path. See cortex-journal-reader.ts /
 * cortex-decision-alpha-report.ts's own doc comments for the exact production incident (event-loop
 * starvation from a full-file readFileSync + JSON.parse on every poll) this ledger exists to avoid
 * repeating a third time.
 *
 * Fed at journal-APPEND time (in-process, synchronous, zero extra I/O) via
 * wrapFourBrainJournalAppendForOutcomeLedger, mirroring four-brain-recent-decisions.ts's own wrapping
 * contract exactly: it sits IN FRONT of the real file-append call, the real append is unconditional and
 * never skipped/altered/suppressed by this wrapper, and mirroring into the ledger is best-effort only
 * (defensively try/catch'd) so a bug here can never affect the actual journal write.
 *
 * DELIBERATELY SEPARATE from FourBrainRecentDecisionsBuffer (the existing 100-slot dashboard ring) — that
 * ring is far too small to survive a 24h SWING decision's own resolution horizon, and widening it would
 * blur a dashboard-freshness buffer with a resolution-input ledger that has a completely different
 * capacity/eviction contract. This module owns its own, larger, per-kind capacities instead.
 *
 * Bounded FIFO: push() evicts the OLDEST row once its kind's capacity is exceeded, exactly like
 * FourBrainRecentDecisionsBuffer's ring — but ALSO increments an honest per-kind
 * droppedPendingBeforeResolution counter on every eviction (mirroring PositionPathRecorder's "never grow
 * unboundedly AND never drop silently" idiom). An evicted row here is a genuine, permanent loss of future
 * resolution coverage (that decision can never be joined to its realized outcome again) — not merely
 * dashboard staleness — so it is counted, never silently dropped.
 *
 * DIRECTION DEDUP (2026-07-24 fix): a Direction Brain decision is computed ONCE per horizon per shadow
 * tick (see four-brain-shadow-tick.ts's directionByHorizon map) but is embedded, byte-identical
 * decisionId included, into EVERY entry-candidate's EXECUTIVE_DECISION journal record that shares that
 * horizon (~14-25 candidates/tick observed) — each of those records independently calls pushDirection()
 * with what is genuinely the SAME decision, not N distinct ones. Left unguarded this amplified real pushes
 * ~7x over distinct decisionIds, flooding this FIFO ledger and evicting genuinely-distinct pending rows
 * (via droppedDirection above) long before they could reach their own resolution horizon — permanently
 * freezing Direction's "evaluated" counter. pushDirection() now dedupes by decisionId via a bounded FIFO
 * "seen" set (seenDirectionIds, capacity directionSeenCapacity, default 8000 — sized well above this
 * ledger's own 2000-row directionCapacity, mirroring direction-entry-outcome-store.ts's own
 * processedDecisionIds idiom exactly) so that for any given Direction decisionId, at most one row is ever
 * admitted to directionRows, for the lifetime of that id's presence in the seen set — regardless of how
 * many EXECUTIVE_DECISION records reference it in one tick or across ticks, and regardless of whether an
 * earlier row for that id has since been FIFO-evicted or removed via removeDirectionByIds (the seen set is
 * independent of, and outlives, directionRows' own membership — re-admitting a resolved/evicted id would
 * silently re-inflate the pending count for a decision that already has, or already had its chance at, an
 * outcome). A duplicate push is a silent-but-COUNTED no-op (deduplicatedDirectionPushes below) — never a
 * fabricated second row, never a thrown error. Entry deliberately gets NO analogous guard: unlike
 * Direction, decideEntry() runs ONCE PER CANDIDATE with genuinely distinct content per row (targetEntry,
 * initialStopPrice, symbolOrBasketId, laneId all vary candidate-to-candidate) even though
 * fourBrainDecisionId's weak (nowMs, side, action) key can coincidentally collide across two DIFFERENT
 * candidates in the same tick — deduping pushEntry the same way would silently DROP a legitimately
 * distinct entry decision, trading one bug for a worse one. Verified: no such collision-dedup guard exists
 * for Entry today, coincidental or otherwise; pushEntry's only protection remains its own FIFO capacity.
 *
 * Pure + independently unit-testable: push/evict/dedup/order/extraction have no dependency on the journal
 * file, the shadow tick, or any live state.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type FourBrainOutcomeHorizon = "SCALP" | "INTRADAY" | "SWING";
export type FourBrainOutcomeDirectionAction = "LONG" | "SHORT" | "FLAT" | "BOTH";
export type FourBrainOutcomeEntrySide = "LONG" | "SHORT";
export type FourBrainOutcomeCanonicalRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
export type FourBrainOutcomeEntryAction =
  | "ENTER_NOW"
  | "WAIT_PULLBACK"
  | "WAIT_BREAKOUT"
  | "WAIT_CONFIRMATION"
  | "SKIP";

/** Just enough of a journaled Direction Brain decision to resolve its counterfactual outcome later. */
export interface PendingDirectionRow {
  decisionId: string;
  asOfMs: number;
  horizon: FourBrainOutcomeHorizon;
  action: FourBrainOutcomeDirectionAction;
  /** R (net of cost), from proven edge-memory; null if unknown at decision time — never fabricated. */
  expectedDirectionalR: number | null;
  /** Captured from the same Executive record, never inferred at resolve time. */
  canonicalRegimeFamily?: FourBrainOutcomeCanonicalRegimeFamily | null;
  scannerRegime?: string | null;
  marketContextSnapshotId?: string | null;
}

/** Just enough of a journaled Entry Brain decision to resolve its counterfactual outcome later. */
export interface PendingEntryRow {
  decisionId: string;
  asOfMs: number;
  /** Stable candidate identity when emitted by the current journal schema; absent on legacy rows. */
  signalId?: string | null;
  symbolOrBasketId: string | null;
  laneId: string | null;
  side: FourBrainOutcomeEntrySide;
  action: FourBrainOutcomeEntryAction;
  targetEntry: number | null;
  initialStopPrice: number | null;
  /** R after est. fees + slippage; null if unknown at decision time — never fabricated. */
  expectedNetR: number | null;
  /** Captured at decision time for exact testnet-fill reinforcement; legacy rows stay null/absent. */
  canonicalRegimeFamily?: FourBrainOutcomeCanonicalRegimeFamily | null;
  scannerRegime?: string | null;
  marketContextSnapshotId?: string | null;
}

export interface FourBrainOutcomeLedgerOptions {
  /** Max Direction rows retained. Oldest is evicted (FIFO) once exceeded. Defaults to 2000. */
  directionCapacity?: number;
  /** Max Entry rows retained. Oldest is evicted (FIFO) once exceeded. Defaults to 10000. */
  entryCapacity?: number;
  /** Max Direction decisionIds remembered for dedup (FIFO — oldest id forgotten once exceeded). Defaults
   *  to 8000. Sized well above directionCapacity so a duplicate can never slip through within (or across)
   *  the handful of ticks it takes for legitimately-new decisionIds to displace it — see the module doc's
   *  DIRECTION DEDUP section. */
  directionSeenCapacity?: number;
}

const DEFAULT_DIRECTION_CAPACITY = 2000;
/**
 * 2026-07-28 — INTERIM, sized from measured hold time. Entry Tier 1 had resolved 0 of 10,000 rows,
 * ever (`claimedTier1CloseKeys` = 0 across all cycles).
 *
 * A pending decision must survive from the moment it is made until the position it caused CLOSES,
 * because the match is only attempted against CLOSED paths. The match rule itself
 * (entry-brain-tier1-realized-resolver.ts) requires `decision.asOfMs ∈ [openedAtMs − TTL, openedAtMs]`
 * with TTL = 50 min, so decision and open are near-simultaneous; it is the close that arrives hours
 * later. Rate measured on the running testnet instance: 10,310 rows spanning 1.75 h ≈ 5,900
 * decisions/hour, so a 10,000-row FIFO retained only ~1.7 h.
 *
 * Measured hold time over testnet's 300 recorded position paths (2026-07-28):
 *     p50 2.41 h · p75 4.00 h · p95 4.13 h · max 8.18 h
 *     ≤1.7 h: 117/300 (39%)   ≤4 h: 255 (85%)   ≤7 h: 298 (99%)   ≤12 h: 300 (100%)
 * So the old cap could not even see 61% of closes — not a matcher bug, an arithmetic one. The join
 * itself is sound: replaying it over the real stores, 120 of 121 distinct close keys have a matching
 * decision key. Lane namespace, symbol and side all line up; only the time axis failed.
 *
 * 64,000 ≈ 10.9 h at that rate. What has to fit is decision → close, i.e. hold (≤ 8.18 h) plus the
 * 50-min TTL ≈ 9.0 h worst case, leaving ~1.9 h of margin. It also sits just past
 * ENTRY_TIER2_ELIGIBLE_AFTER_MS (10 h, direction-entry-reconciler.ts): rows are drained on Tier-2
 * resolve anyway, so beyond that point the FIFO stops being the binding constraint and the natural
 * lifecycle takes over. Cost is ~13 MB resident (the row is a handful of primitives).
 *
 * This only fixes matching GOING FORWARD. position-paths.json retains closes for 129.6 h (5.4 days)
 * and the resolver retries all of them every run, but the decisions behind the older ones were
 * evicted days ago and are not recoverable from any store — 298 of the 300 currently-retained closes
 * are permanently unmatchable. Expect matchedRows to climb from 0 as new closes land, not to
 * back-fill. Do not read a low matchedRows in the first few hours as the fix having failed.
 *
 * THIS IS A STOPGAP, and it is O(decisions) — it retains ~64k rows to catch a few hundred closes,
 * because every candidate is kept on the chance it becomes a position. The correct fix is O(open
 * positions): bind pathKey → decisionId when the position OPENS (the match rule only needs 50 min of
 * retention for that) and resolve through the persisted binding at close. Once that lands this cap
 * should come back down — see the note in direction-entry-reconciler.ts.
 */
const DEFAULT_ENTRY_CAPACITY = 64_000;
const DEFAULT_DIRECTION_SEEN_CAPACITY = 8000;

function resolveCapacity(cap: number | undefined, fallback: number): number {
  return Number.isFinite(cap) && (cap as number) > 0 ? Math.floor(cap as number) : fallback;
}

/**
 * Bounded FIFO ledger for pending (not-yet-resolved) Direction + Entry decisions. push*() evicts the
 * OLDEST row of that kind once its capacity is exceeded (FIFO eviction) and increments that kind's
 * droppedPendingBeforeResolution counter — an honest admission that the evicted row's realized outcome can
 * never be attributed. get*() accessors return defensive copies so callers cannot mutate ledger state.
 */
export class FourBrainOutcomeLedger {
  private readonly directionCapacity: number;
  private readonly entryCapacity: number;
  private readonly directionSeenCapacity: number;
  private directionRows: PendingDirectionRow[] = [];
  private entryRows: PendingEntryRow[] = [];
  private droppedDirection = 0;
  private droppedEntry = 0;
  /** FIFO-ordered ids ever admitted via pushDirection (see class doc's DIRECTION DEDUP section) —
   *  independent of, and outlives, directionRows' own membership. seenDirectionIdSet mirrors this array
   *  for O(1) membership checks; the two are always kept in sync. */
  private seenDirectionIds: string[] = [];
  private seenDirectionIdSet: Set<string> = new Set();
  private dedupedDirectionPushes = 0;

  constructor(options: FourBrainOutcomeLedgerOptions = {}) {
    this.directionCapacity = resolveCapacity(options.directionCapacity, DEFAULT_DIRECTION_CAPACITY);
    this.entryCapacity = resolveCapacity(options.entryCapacity, DEFAULT_ENTRY_CAPACITY);
    this.directionSeenCapacity = resolveCapacity(options.directionSeenCapacity, DEFAULT_DIRECTION_SEEN_CAPACITY);
  }

  /** Idempotent per decisionId (see class doc's DIRECTION DEDUP section): a decisionId already admitted
   *  — whether its row is still pending, already FIFO-evicted, or already removed via
   *  removeDirectionByIds — is never pushed a second time; the call is a counted (dedupedDirectionPushes)
   *  no-op instead. */
  pushDirection(row: PendingDirectionRow): void {
    if (this.seenDirectionIdSet.has(row.decisionId)) {
      this.dedupedDirectionPushes += 1;
      return;
    }
    this.seenDirectionIdSet.add(row.decisionId);
    this.seenDirectionIds.push(row.decisionId);
    if (this.seenDirectionIds.length > this.directionSeenCapacity) {
      const evicted = this.seenDirectionIds.splice(0, this.seenDirectionIds.length - this.directionSeenCapacity);
      for (const id of evicted) this.seenDirectionIdSet.delete(id);
    }

    this.directionRows.push(row);
    if (this.directionRows.length > this.directionCapacity) {
      this.directionRows.shift();
      this.droppedDirection += 1;
    }
  }

  pushEntry(row: PendingEntryRow): void {
    this.entryRows.push(row);
    if (this.entryRows.length > this.entryCapacity) {
      this.entryRows.shift();
      this.droppedEntry += 1;
    }
  }

  /** Oldest-first. Returns a fresh array of fresh row objects — callers cannot mutate internal ledger
   *  state (neither the array nor any individual row's fields) through it. Every row field is a primitive
   *  (string | number | null), so a shallow per-row copy is sufficient to fully sever the reference. */
  getPendingDirectionRows(): PendingDirectionRow[] {
    return this.directionRows.map((row) => ({ ...row }));
  }

  /** Oldest-first. Returns a fresh array of fresh row objects — callers cannot mutate internal ledger
   *  state (neither the array nor any individual row's fields) through it. Every row field is a primitive
   *  (string | number | null), so a shallow per-row copy is sufficient to fully sever the reference. */
  getPendingEntryRows(): PendingEntryRow[] {
    return this.entryRows.map((row) => ({ ...row }));
  }

  /** Remove specific DIRECTION rows by decisionId (e.g. once a resolution phase has terminally resolved
   *  or expired them) — a no-op for any id not currently present. Never throws; a bad/empty set simply
   *  removes nothing. This is the ONLY way rows leave the ledger other than FIFO capacity eviction. */
  removeDirectionByIds(decisionIds: ReadonlySet<string>): void {
    if (!decisionIds || decisionIds.size === 0) return;
    this.directionRows = this.directionRows.filter((row) => !decisionIds.has(row.decisionId));
  }

  /** Remove specific ENTRY rows by decisionId. See removeDirectionByIds — same contract. */
  removeEntryByIds(decisionIds: ReadonlySet<string>): void {
    if (!decisionIds || decisionIds.size === 0) return;
    this.entryRows = this.entryRows.filter((row) => !decisionIds.has(row.decisionId));
  }

  /** Honest count of rows evicted (FIFO, capacity exceeded) before any future resolution phase could have
   *  read them — per kind, since Direction and Entry have independent capacities and eviction rates. */
  get droppedPendingBeforeResolution(): { direction: number; entry: number } {
    return { direction: this.droppedDirection, entry: this.droppedEntry };
  }

  /** Honest count of pushDirection() calls that were skipped as duplicates of an already-admitted
   *  decisionId (see class doc's DIRECTION DEDUP section) — never a silent drop, always counted here. */
  get deduplicatedDirectionPushes(): number {
    return this.dedupedDirectionPushes;
  }

  get directionSize(): number {
    return this.directionRows.length;
  }

  get entrySize(): number {
    return this.entryRows.length;
  }
}

// ── Defensive extraction from a raw EXECUTIVE_DECISION journal record ──────────────────────────────────
// The record arg is typed Record<string, unknown> (journalAppend's own contract — see
// four-brain-recent-decisions.ts), so nothing here trusts shape blindly: every field is runtime-checked,
// exactly like readExecutiveDecisionRows in four-brain-journal.ts. A missing/malformed brain slice (e.g.
// direction/entry null on a MISSING-input cycle) yields null — never a fabricated row.

function isHorizon(v: unknown): v is FourBrainOutcomeHorizon {
  return v === "SCALP" || v === "INTRADAY" || v === "SWING";
}

function isDirectionAction(v: unknown): v is FourBrainOutcomeDirectionAction {
  return v === "LONG" || v === "SHORT" || v === "FLAT" || v === "BOTH";
}

function isEntrySide(v: unknown): v is FourBrainOutcomeEntrySide {
  return v === "LONG" || v === "SHORT";
}

function isEntryAction(v: unknown): v is FourBrainOutcomeEntryAction {
  return (
    v === "ENTER_NOW" || v === "WAIT_PULLBACK" || v === "WAIT_BREAKOUT" || v === "WAIT_CONFIRMATION" || v === "SKIP"
  );
}

function finiteNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function canonicalRegimeOrNull(v: unknown): FourBrainOutcomeCanonicalRegimeFamily | null {
  return v === "BULLISH" || v === "BEARISH" || v === "MIXED" || v === "UNKNOWN" ? v : null;
}

/**
 * Pull only immutable, already-journaled market lineage from an executive
 * record.  Do not fall back to a later/live regime: that would leak future
 * state into the outcome label.
 */
function marketLineageFromExecutiveRecord(record: Record<string, unknown>): Partial<Pick<
  PendingEntryRow,
  "canonicalRegimeFamily" | "scannerRegime" | "marketContextSnapshotId"
>> {
  const brains = record.brains as Record<string, unknown> | null | undefined;
  const marketState = brains?.marketState as Record<string, unknown> | null | undefined;
  const authority = marketState?.authority as Record<string, unknown> | null | undefined;
  const marketContext = record.marketContext as Record<string, unknown> | null | undefined;
  const canonicalRegimeFamily = canonicalRegimeOrNull(authority?.canonicalRegimeFamily);
  const scannerRegime = stringOrNull(authority?.scannerRegime);
  const marketContextSnapshotId = stringOrNull(marketContext?.marketContextSnapshotId);
  return {
    ...(canonicalRegimeFamily !== null ? { canonicalRegimeFamily } : {}),
    ...(scannerRegime !== null ? { scannerRegime } : {}),
    ...(marketContextSnapshotId !== null ? { marketContextSnapshotId } : {}),
  };
}

/** Extract a PendingDirectionRow from a raw EXECUTIVE_DECISION record's brains.direction slice (see
 *  buildExecutiveDecisionRecord in four-brain-journal.ts). Returns null when the slice is absent or any
 *  required field fails its runtime check — never a partially-fabricated row. */
export function extractPendingDirectionRow(record: Record<string, unknown>): PendingDirectionRow | null {
  const brains = record.brains as Record<string, unknown> | null | undefined;
  const direction = brains?.direction as Record<string, unknown> | null | undefined;
  if (!direction || typeof direction !== "object") return null;
  const { decisionId, asOfMs, horizon, action, expectedDirectionalR } = direction as Record<string, unknown>;
  if (typeof decisionId !== "string" || decisionId.length === 0) return null;
  if (typeof asOfMs !== "number" || !Number.isFinite(asOfMs)) return null;
  if (!isHorizon(horizon) || !isDirectionAction(action)) return null;
  const lineage = marketLineageFromExecutiveRecord(record);
  return {
    decisionId,
    asOfMs,
    horizon,
    action,
    expectedDirectionalR: finiteNumberOrNull(expectedDirectionalR),
    ...lineage,
  };
}

/** Extract a PendingEntryRow from a raw EXECUTIVE_DECISION record's brains.entry slice (see
 *  buildExecutiveDecisionRecord in four-brain-journal.ts). symbolOrBasketId/laneId come from the executive
 *  record itself (the Entry Brain decision has no lane/symbol field of its own). Returns null when the
 *  slice is absent or any required field fails its runtime check — never a partially-fabricated row. */
export function extractPendingEntryRow(record: Record<string, unknown>): PendingEntryRow | null {
  const brains = record.brains as Record<string, unknown> | null | undefined;
  const entry = brains?.entry as Record<string, unknown> | null | undefined;
  if (!entry || typeof entry !== "object") return null;
  const { decisionId, asOfMs, side, action, targetEntry, initialStopPrice, expectedNetR } = entry as Record<
    string,
    unknown
  >;
  if (typeof decisionId !== "string" || decisionId.length === 0) return null;
  if (typeof asOfMs !== "number" || !Number.isFinite(asOfMs)) return null;
  if (!isEntrySide(side) || !isEntryAction(action)) return null;
  const lineage = marketLineageFromExecutiveRecord(record);
  return {
    decisionId,
    asOfMs,
    ...(stringOrNull(record.signalId) ? { signalId: stringOrNull(record.signalId) } : {}),
    symbolOrBasketId: stringOrNull(record.symbolOrBasketId),
    laneId: stringOrNull(record.laneId),
    side,
    action,
    targetEntry: finiteNumberOrNull(targetEntry),
    initialStopPrice: finiteNumberOrNull(initialStopPrice),
    expectedNetR: finiteNumberOrNull(expectedNetR),
    ...lineage,
  };
}

/** Only EXECUTIVE_DECISION records carry brains.direction/brains.entry — every other journal kind
 *  (MARKET_SNAPSHOT, FOUR_BRAIN_CYCLE_METRICS, …) is irrelevant to this ledger and left untouched. */
const RELEVANT_KIND = "EXECUTIVE_DECISION";

/**
 * Wrap an existing journalAppend so it ALSO mirrors DIRECTION and ENTRY decision slices into the outcome
 * ledger, in addition to the real append. Mirrors wrapFourBrainJournalAppendForRecentDecisions's contract
 * exactly: ledger mirroring happens first, then the real (unconditional, unaltered) append — a throw from
 * ledger mirroring is swallowed (best-effort observability only) while a throw from the real append
 * propagates exactly as it did before this wrapper existed.
 */
export function wrapFourBrainJournalAppendForOutcomeLedger(
  journalAppend: (record: Record<string, unknown>) => void,
  ledger: FourBrainOutcomeLedger,
): (record: Record<string, unknown>) => void {
  return (record: Record<string, unknown>) => {
    try {
      if (record.kind === RELEVANT_KIND) {
        const directionRow = extractPendingDirectionRow(record);
        if (directionRow) ledger.pushDirection(directionRow);
        const entryRow = extractPendingEntryRow(record);
        if (entryRow) ledger.pushEntry(entryRow);
      }
    } catch {
      /* ledger mirroring is best-effort observability only; must never affect the real append below */
    }
    journalAppend(record);
  };
}

export interface FourBrainOutcomeLedgerRehydrateResult {
  filesRead: number;
  linesRead: number;
  badLines: number;
  executiveRecords: number;
  directionEligibleUnprocessed: number;
  entryEligibleUnprocessed: number;
  directionRehydrated: number;
  entryRehydrated: number;
  directionPendingRestored: number;
  entryPendingRestored: number;
  directionEvictedDuringRehydrate: number;
  entryEvictedDuringRehydrate: number;
  directionSkippedProcessed: number;
  entrySkippedProcessed: number;
  duplicateDirectionRowsSkipped: number;
  duplicateEntryRowsSkipped: number;
  entryDecisionIdsMigrated: number;
}

function rehydratedEntryDecisionId(entry: PendingEntryRow, fingerprint: string): string {
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `${entry.decisionId}:journal:${digest}`;
}

/**
 * Rebuild pending rows once at process boot from the durable decision journal. Processed decisions are
 * excluded using the persisted outcome store, so a restart cannot re-score an already terminal row.
 * Rotated files must be supplied oldest-first. This is intentionally not used by request or interval
 * paths; a bounded synchronous read at boot avoids the event-loop starvation failure of repeated reads.
 */
export function rehydrateFourBrainOutcomeLedgerFromJournals(args: {
  ledger: FourBrainOutcomeLedger;
  journalFiles: string[];
  hasProcessedDirection: (decisionId: string) => boolean;
  hasProcessedEntry: (decisionId: string) => boolean;
}): FourBrainOutcomeLedgerRehydrateResult {
  const result: FourBrainOutcomeLedgerRehydrateResult = {
    filesRead: 0,
    linesRead: 0,
    badLines: 0,
    executiveRecords: 0,
    directionEligibleUnprocessed: 0,
    entryEligibleUnprocessed: 0,
    directionRehydrated: 0,
    entryRehydrated: 0,
    directionPendingRestored: 0,
    entryPendingRestored: 0,
    directionEvictedDuringRehydrate: 0,
    entryEvictedDuringRehydrate: 0,
    directionSkippedProcessed: 0,
    entrySkippedProcessed: 0,
    duplicateDirectionRowsSkipped: 0,
    duplicateEntryRowsSkipped: 0,
    entryDecisionIdsMigrated: 0,
  };
  const seenDirectionIds = new Set<string>();
  const seenEntryRows = new Set<string>();

  for (const file of args.journalFiles) {
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
      result.filesRead += 1;
    } catch {
      result.badLines += 1;
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      result.linesRead += 1;
      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid record");
        record = parsed as Record<string, unknown>;
      } catch {
        result.badLines += 1;
        continue;
      }
      if (record.kind !== RELEVANT_KIND) continue;
      result.executiveRecords += 1;

      const direction = extractPendingDirectionRow(record);
      if (direction) {
        if (args.hasProcessedDirection(direction.decisionId)) result.directionSkippedProcessed += 1;
        else if (seenDirectionIds.has(direction.decisionId)) result.duplicateDirectionRowsSkipped += 1;
        else {
          seenDirectionIds.add(direction.decisionId);
          result.directionEligibleUnprocessed += 1;
          args.ledger.pushDirection(direction);
          result.directionRehydrated += 1;
        }
      }

      const entry = extractPendingEntryRow(record);
      if (entry) {
        const fingerprint = JSON.stringify(entry);
        const effectiveDecisionId = rehydratedEntryDecisionId(entry, fingerprint);
        if (args.hasProcessedEntry(entry.decisionId) || args.hasProcessedEntry(effectiveDecisionId)) {
          result.entrySkippedProcessed += 1;
        } else if (seenEntryRows.has(fingerprint)) {
          result.duplicateEntryRowsSkipped += 1;
        } else {
          seenEntryRows.add(fingerprint);
          result.entryEligibleUnprocessed += 1;
          result.entryDecisionIdsMigrated += 1;
          args.ledger.pushEntry({ ...entry, decisionId: effectiveDecisionId });
          result.entryRehydrated += 1;
        }
      }
    }
  }
  result.directionPendingRestored = args.ledger.directionSize;
  result.entryPendingRestored = args.ledger.entrySize;
  const dropped = args.ledger.droppedPendingBeforeResolution;
  result.directionEvictedDuringRehydrate = dropped.direction;
  result.entryEvictedDuringRehydrate = dropped.entry;
  return result;
}

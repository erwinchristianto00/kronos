/**
 * Four-Brain HISTORICAL BACKFILL warm-start harness (Track 1 of the "Four-Brain Learning Feedback Loop"
 * spec, 2026-07-23, REPORT-ONLY). Turns already-journaled EXECUTIVE_DECISION rows (data/four-brain-
 * decision-journal.jsonl + its rotated .jsonl.1 — the only two generations CortexDecisionJournal keeps,
 * see cortex-brain-store.ts's CortexDecisionJournal) into the SAME terminal Direction/Entry outcome
 * records the live direction-entry-reconciler.ts produces, so decisions the journal already carries but
 * the live reconciler never got to (or wasn't running for) can still warm-start
 * direction-entry-outcome-store.ts before the live reconciler catches up.
 *
 * Pure-ish harness: every I/O (journal file contents, archived candle CSVs, the store, the position-path
 * recorder's closed paths) is INJECTED by the caller (see scripts/four-brain-historical-backfill-run.ts,
 * the only place that actually touches the filesystem). Nothing here reads a file, calls Date.now(), or
 * talks to the network — every function takes its inputs (lines, candles, nowMs) explicitly, exactly like
 * direction-brain-resolver.ts's own resolveDirectionOutcome, which this module wraps unchanged.
 *
 * REUSE, NOT REDERIVATION — every actual resolution rule is the SAME already-tested pure function the live
 * reconciler uses, imported verbatim, never copy-pasted or re-implemented:
 *   - extractPendingDirectionRow / extractPendingEntryRow (four-brain-outcome-ledger.ts) — the exact
 *     EXECUTIVE_DECISION → pending-row extraction the live journal-append wrapper uses.
 *   - resolveDirectionOutcome (direction-brain-resolver.ts) — BTC-proxy Direction resolution.
 *   - resolveEntryBrainTier1Realized (entry-brain-tier1-realized-resolver.ts) — real-fill join against
 *     position-path-recorder.ts's already-persisted closed paths (no historical replay needed there).
 *   - resolveEntryTier2Row (entry-brain-tier2-simulated-resolver.ts) — forward-candle-walk simulation.
 *   - ENTRY_TIER2_ELIGIBLE_AFTER_MS (direction-entry-reconciler.ts) — the SAME Tier1→Tier2 handoff
 *     deadline the live reconciler uses, imported (read-only), never re-derived.
 *   - MAX_UNRESOLVABLE_STALENESS_MS (direction-brain-resolver.ts) — the SAME terminal-give-up cutoff.
 *   - store.recordDirectionOutcome / store.recordEntryOutcome (direction-entry-outcome-store.ts) —
 *     identical persisted shape, identical per-decisionId idempotent dedup as the live path, so results
 *     surface in the SAME /api/shadow/direction-entry-outcomes report, and re-running this script (or a
 *     decision the live reconciler already resolved first) can never double-book it.
 *
 * KNOWN SCOPE LIMITS (honest, not papered over — see the design spec):
 *   - The only archived candle corpus available (artifacts/simulation/data/extracted/klines_*) is Jan–Jun
 *     2026 BTC/ETH only. Entry Tier 2 backfill therefore only ever resolves BTCUSDT/ETHUSDT rows; every
 *     other symbol's Entry row falls through to INSTRUMENT_DATA_MISSING → (once stale) EXPIRED_UNRESOLVABLE
 *     — NEVER a fabricated outcome for a symbol this archive has no data for.
 *   - Direction resolution is the BTC-proxy the live resolver already uses regardless of symbol, so it is
 *     unaffected by this limit.
 *   - Journal retention (~35MB + one .1 backup, ~26 days at the measured growth rate) bounds how far back
 *     a journaled decision can exist at all — this harness cannot resurrect a row already rotated out.
 *
 * INSTANCE SAFETY: this harness itself has no notion of "instance" (it is pure, deals only in rows/
 * candles/paths handed to it) — the CLI entry point (scripts/four-brain-historical-backfill-run.ts) is
 * where the fourBrainInstanceAllowed(process.env) gate lives, so the live (3103) instance's data can never
 * be targeted even by a copy-pasted invocation. See that script's own doc comment.
 */
import type { Candle } from "@dtc/shared";
import type { PathCandle } from "./entry-exit-counterfactual.js";
import {
  extractPendingDirectionRow,
  extractPendingEntryRow,
  type PendingDirectionRow,
  type PendingEntryRow,
} from "./four-brain-outcome-ledger.js";
import {
  resolveDirectionOutcome,
  HORIZON_MS,
  MAX_UNRESOLVABLE_STALENESS_MS,
  type ResolvedDirectionOutcome,
} from "./direction-brain-resolver.js";
import { resolveEntryBrainTier1Realized, type EntryBrainTier1Row } from "./entry-brain-tier1-realized-resolver.js";
import { resolveEntryTier2Row, type EntryTier2ResolvedRow } from "./entry-brain-tier2-simulated-resolver.js";
import { ENTRY_TIER2_ELIGIBLE_AFTER_MS } from "./direction-entry-reconciler.js";
import type { PositionPath } from "./position-path-recorder.js";
import type {
  DirectionEntryOutcomeStore,
  DirectionOutcomeRecord,
  EntryOutcomeRecord,
} from "./direction-entry-outcome-store.js";

/** The journal filename this harness reads — matches app.ts's own hardcoded literal
 *  (`new CortexDecisionJournal("data/four-brain-decision-journal.jsonl")`) verbatim. NOT
 *  four-brain-journal.ts's FOUR_BRAIN_JOURNAL_FILE constant ("four-brain-executive-journal.jsonl") — that
 *  constant is dead code (unused anywhere else in this codebase); the real, actually-written journal file
 *  is the one named here. */
export const FOUR_BRAIN_DECISION_JOURNAL_FILE = "four-brain-decision-journal.jsonl";

/** Only EXECUTIVE_DECISION records carry brains.direction/brains.entry — mirrors
 *  four-brain-outcome-ledger.ts's own RELEVANT_KIND. */
const RELEVANT_KIND = "EXECUTIVE_DECISION";

export interface BackfillJournalScanResult {
  directionRows: PendingDirectionRow[];
  entryRows: PendingEntryRow[];
  scannedLines: number;
  parsedRecords: number;
  badLines: number;
  skippedNonExecutiveDecision: number;
}

/**
 * Parse raw JSONL lines (the caller's concatenation of the current + rotated journal file — see module
 * doc) into pending Direction/Entry rows, using the SAME unchanged extraction the live journal-append
 * wrapper uses. Line-resilient (per-line try/catch — a truncated/malformed line is counted and skipped,
 * never aborts the scan), and dedupes by decisionId (the current file and its rotated .1 backup never
 * overlap in time by construction — CortexDecisionJournal's rotation renames the whole prior file to .1
 * and starts fresh — but dedup is applied anyway as cheap defense-in-depth, mirroring
 * four-brain-journal.ts's readExecutiveDecisionRows own dedup discipline).
 */
export function scanJournalForBackfillRows(lines: string[]): BackfillJournalScanResult {
  const directionById = new Map<string, PendingDirectionRow>();
  const entryById = new Map<string, PendingEntryRow>();
  let parsedRecords = 0;
  let badLines = 0;
  let skippedNonExecutiveDecision = 0;

  for (const rawLine of Array.isArray(lines) ? lines : []) {
    if (!rawLine || !rawLine.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      badLines += 1;
      continue;
    }
    parsedRecords += 1;
    if (rec.kind !== RELEVANT_KIND) {
      skippedNonExecutiveDecision += 1;
      continue;
    }
    try {
      const directionRow = extractPendingDirectionRow(rec);
      if (directionRow && !directionById.has(directionRow.decisionId)) {
        directionById.set(directionRow.decisionId, directionRow);
      }
    } catch {
      badLines += 1;
    }
    try {
      const entryRow = extractPendingEntryRow(rec);
      if (entryRow && !entryById.has(entryRow.decisionId)) {
        entryById.set(entryRow.decisionId, entryRow);
      }
    } catch {
      badLines += 1;
    }
  }

  return {
    directionRows: [...directionById.values()].sort((a, b) => a.asOfMs - b.asOfMs),
    entryRows: [...entryById.values()].sort((a, b) => a.asOfMs - b.asOfMs),
    scannedLines: Array.isArray(lines) ? lines.length : 0,
    parsedRecords,
    badLines,
    skippedNonExecutiveDecision,
  };
}

/**
 * Thin pass-through to the UNCHANGED resolveDirectionOutcome (direction-brain-resolver.ts) — gives the
 * backfill CLI + its tests one obvious, harness-local name for "resolve a Direction row against the
 * archived BTC candle series" without duplicating any resolution logic.
 */
export function resolveBackfillDirectionRow(
  row: PendingDirectionRow,
  btcCandles: Candle[],
  nowMs: number,
): ResolvedDirectionOutcome {
  return resolveDirectionOutcome(row, btcCandles, nowMs);
}

export type BackfillEntryResolutionStatus = "RESOLVED" | "INSTRUMENT_DATA_MISSING" | "EXPIRED_UNRESOLVABLE" | "PENDING";

export interface BackfillEntryResolution {
  status: BackfillEntryResolutionStatus;
  /** Non-null ONLY for a TERMINAL status (RESOLVED or EXPIRED_UNRESOLVABLE) — mirrors the reconciler's
   *  own terminal-vs-transient split (direction-entry-reconciler.ts's module doc). writeBackfillResults
   *  below only ever books a non-null record. */
  record: EntryOutcomeRecord | null;
}

/** The same EXPIRED_UNRESOLVABLE record shape direction-entry-reconciler.ts builds for a row that has run
 *  out the staleness clock with no usable tier — reproduced here (not imported; the reconciler does not
 *  export a builder for it) but field-for-field identical. */
function expiredEntryRecord(row: PendingEntryRow): EntryOutcomeRecord {
  return {
    decisionId: row.decisionId,
    tier: null,
    laneId: row.laneId,
    symbolOrBasketId: row.symbolOrBasketId,
    side: row.side,
    action: row.action,
    confidence: "EXPERIMENTAL_COST_OF_CAUTION",
    asOfMs: row.asOfMs,
    status: "EXPIRED_UNRESOLVABLE",
    expectedNetR: row.expectedNetR,
    realizedNetR: null,
    realizedRSource: null,
    horizonTruncated: null,
    matchedCloseKey: null,
  };
}

/**
 * Resolve one pending Entry Brain row's counterfactual outcome, Tier 1 (real fill) first then Tier 2
 * (simulated) fallback — the EXACT SAME order/timing rules as direction-entry-reconciler.ts's own ENTRY
 * loop (ENTRY_TIER2_ELIGIBLE_AFTER_MS / MAX_UNRESOLVABLE_STALENESS_MS, both imported verbatim, never
 * re-derived), reimplemented per-row here (no interval/ledger/single-flight machinery — this is a one-shot
 * batch, not a recurring cycle).
 *
 * `tier1Row` MUST come from a SINGLE whole-batch call to the UNCHANGED
 * resolveEntryBrainTier1Realized(allEntryRows, closedPaths) (see runHistoricalBackfillOverRows below,
 * which makes that call exactly once) — never a per-row call with `[row]`, which would silently break the
 * "one close claimed once" invariant (each call resets its own internal consumedDecisionIds set, so two
 * independent single-row calls could each claim the SAME close).
 *
 * `tier2Candles` is the (possibly null/short) archived 15m candle path for this row's own symbol, already
 * sliced to start at-or-after row.asOfMs by the caller — null whenever the archive has no coverage for
 * that symbol/date (see module doc's known scope limits), which resolveEntryTier2Row's own null-safe
 * contract turns into an honest INSTRUMENT_DATA_MISSING/EXPIRED_UNRESOLVABLE below, never a fabricated
 * result.
 */
export function resolveBackfillEntryRow(
  row: PendingEntryRow,
  tier1Row: EntryBrainTier1Row | undefined,
  tier2Candles: PathCandle[] | null,
  nowMs: number,
): BackfillEntryResolution {
  if (tier1Row && tier1Row.status === "RESOLVED") {
    return {
      status: "RESOLVED",
      record: {
        decisionId: row.decisionId,
        tier: "TIER1_REALIZED",
        laneId: tier1Row.laneId,
        symbolOrBasketId: tier1Row.symbolOrBasketId,
        side: tier1Row.side,
        action: row.action,
        confidence: "MEASURED",
        asOfMs: row.asOfMs,
        status: "RESOLVED",
        expectedNetR: tier1Row.expectedNetR,
        realizedNetR: tier1Row.realizedR,
        realizedRSource: tier1Row.realizedRSource,
        horizonTruncated: null,
        matchedCloseKey: tier1Row.matchedCloseKey,
      },
    };
  }

  const tier2EligibleAtMs = row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS;
  if (nowMs < tier2EligibleAtMs) return { status: "PENDING", record: null };

  const staleness = nowMs - row.asOfMs;
  const expireNow = staleness > MAX_UNRESOLVABLE_STALENESS_MS;

  if (!row.symbolOrBasketId) {
    // No symbol identity — can never fetch candles or simulate (never fabricate one).
    return expireNow
      ? { status: "EXPIRED_UNRESOLVABLE", record: expiredEntryRecord(row) }
      : { status: "INSTRUMENT_DATA_MISSING", record: null };
  }

  let tier2Result: EntryTier2ResolvedRow | null = null;
  if (tier2Candles && tier2Candles.length > 0) {
    try {
      tier2Result = resolveEntryTier2Row(row, tier2Candles);
    } catch {
      tier2Result = null;
    }
  }

  if (tier2Result) {
    return {
      status: "RESOLVED",
      record: {
        decisionId: row.decisionId,
        tier: "TIER2_SIMULATED",
        laneId: row.laneId,
        symbolOrBasketId: row.symbolOrBasketId,
        side: row.side,
        action: row.action,
        confidence: tier2Result.confidence,
        asOfMs: row.asOfMs,
        status: "RESOLVED",
        expectedNetR: row.expectedNetR,
        realizedNetR: tier2Result.result.outcome.netR,
        realizedRSource: null,
        horizonTruncated: tier2Result.horizonTruncated,
        matchedCloseKey: null,
      },
    };
  }

  return expireNow
    ? { status: "EXPIRED_UNRESOLVABLE", record: expiredEntryRecord(row) }
    : { status: "INSTRUMENT_DATA_MISSING", record: null };
}

export interface BackfillResults {
  direction: Array<{ row: PendingDirectionRow; outcome: ResolvedDirectionOutcome }>;
  entry: Array<{ row: PendingEntryRow; resolution: BackfillEntryResolution }>;
}

export interface RunHistoricalBackfillDeps {
  /** BTCUSDT 1h candles spanning the archived corpus (see replay-tier-a-core.ts's parseKlines). */
  btcCandles: Candle[];
  /** position-path-recorder.ts's already-real closed paths — no historical replay needed, fills are
   *  already persisted (see module doc). */
  closedPositionPaths: PositionPath[];
  /** Per-symbol archived 15m candle lookup, already sliced to start at-or-after `asOfMs` — null when the
   *  archive has no coverage for that symbol/date (see module doc's known scope limits). Pure/synchronous:
   *  the caller has already loaded every candle this harness could possibly need into memory. */
  fetchTier2Candles: (symbolOrBasketId: string, asOfMs: number) => PathCandle[] | null;
  /** True for a PositionPath.key already claimed by a PRIOR (e.g. live) Tier 1 resolution — excluded from
   *  this batch's own Tier 1 matching so a close the live reconciler already booked against one decision
   *  can never be re-claimed here against a different one (mirrors direction-entry-reconciler.ts's own
   *  claimableClosedPaths filter, using the store's hasClaimedTier1CloseKey verbatim). */
  isCloseAlreadyClaimed: (closeKey: string) => boolean;
  nowMs: number;
}

/**
 * Resolve every row from one scanJournalForBackfillRows() result. Direction rows resolve independently
 * (one shared BTC candle series). Entry rows resolve Tier 1 first via a SINGLE whole-batch call to
 * resolveEntryBrainTier1Realized (preserving its "one close claimed once" contract across the ENTIRE
 * batch — not per-row), then Tier 2 per-row for whatever Tier 1 left pending. Pure given its deps (every
 * dep is either already-loaded data or a synchronous, side-effect-free lookup) — no I/O of its own.
 */
export function runHistoricalBackfillOverRows(
  scan: BackfillJournalScanResult,
  deps: RunHistoricalBackfillDeps,
): BackfillResults {
  const direction = scan.directionRows.map((row) => ({
    row,
    outcome: resolveBackfillDirectionRow(row, deps.btcCandles, deps.nowMs),
  }));

  const claimableClosedPaths = deps.closedPositionPaths.filter(
    (p) => !(p && typeof p.key === "string" && deps.isCloseAlreadyClaimed(p.key)),
  );
  const tier1Rows = resolveEntryBrainTier1Realized(scan.entryRows, claimableClosedPaths);
  const tier1ByDecisionId = new Map(tier1Rows.map((r) => [r.decisionId, r]));

  const entry = scan.entryRows.map((row) => {
    const tier1Row = tier1ByDecisionId.get(row.decisionId);
    const alreadyTier1Resolved = !!tier1Row && tier1Row.status === "RESOLVED";
    const tier2Candles =
      !alreadyTier1Resolved && row.symbolOrBasketId ? deps.fetchTier2Candles(row.symbolOrBasketId, row.asOfMs) : null;
    return { row, resolution: resolveBackfillEntryRow(row, tier1Row, tier2Candles, deps.nowMs) };
  });

  return { direction, entry };
}

export interface BackfillWriteSummary {
  directionBooked: number;
  directionSkippedAlreadyProcessed: number;
  directionNotTerminal: number;
  entryBooked: number;
  entrySkippedAlreadyProcessed: number;
  entryNotTerminal: number;
}

/**
 * Persist every TERMINAL (RESOLVED/EXPIRED_UNRESOLVABLE) resolved row via the store's OWN existing
 * recordDirectionOutcome/recordEntryOutcome (direction-entry-outcome-store.ts:604,661) — identical
 * persisted shape, identical idempotent per-decisionId dedup as the live reconciler, so results surface in
 * the SAME /api/shadow/direction-entry-outcomes report unchanged, and re-running this exact script (or a
 * decision the live reconciler already resolved first) simply no-ops rather than double-booking. PENDING/
 * INSTRUMENT_DATA_MISSING rows are NEVER written (transient — never a terminal record for a row this
 * archive genuinely could not resolve). Batches every write with deferSave + a single flush() at the end
 * (mirrors the reconciler's own batching), so a large historical run does not fsync per-row.
 */
export function writeBackfillResults(store: DirectionEntryOutcomeStore, results: BackfillResults): BackfillWriteSummary {
  let directionBooked = 0;
  let directionSkippedAlreadyProcessed = 0;
  let directionNotTerminal = 0;
  let entryBooked = 0;
  let entrySkippedAlreadyProcessed = 0;
  let entryNotTerminal = 0;

  for (const { row, outcome } of results.direction) {
    if (outcome.status !== "EVALUATED" && outcome.status !== "EXPIRED_UNRESOLVABLE") {
      directionNotTerminal += 1;
      continue;
    }
    const record: DirectionOutcomeRecord = {
      decisionId: row.decisionId,
      horizon: row.horizon,
      action: row.action,
      asOfMs: row.asOfMs,
      status: outcome.status === "EVALUATED" ? "RESOLVED" : "EXPIRED_UNRESOLVABLE",
      chosenNetR: outcome.chosenNetR,
      win: outcome.win,
      regretR: outcome.regretR,
      calibrationGapR: outcome.calibrationGapR,
    };
    const booked = store.recordDirectionOutcome(record, HORIZON_MS[row.horizon], { deferSave: true });
    if (booked) directionBooked += 1;
    else directionSkippedAlreadyProcessed += 1;
  }

  for (const { resolution } of results.entry) {
    if (!resolution.record) {
      entryNotTerminal += 1;
      continue;
    }
    const booked = store.recordEntryOutcome(resolution.record, { deferSave: true });
    if (booked) entryBooked += 1;
    else entrySkippedAlreadyProcessed += 1;
  }

  store.flush();
  return {
    directionBooked,
    directionSkippedAlreadyProcessed,
    directionNotTerminal,
    entryBooked,
    entrySkippedAlreadyProcessed,
    entryNotTerminal,
  };
}

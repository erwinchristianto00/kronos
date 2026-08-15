/**
 * DIRECTION + ENTRY BRAIN OUTCOME RECONCILER (2026-07-23, REPORT-ONLY). The periodic job that turns
 * four-brain-outcome-ledger.ts's pending rows into direction-entry-outcome-store.ts's terminal outcome
 * records, by calling the 3 pure resolvers (direction-brain-resolver.ts,
 * entry-brain-tier1-realized-resolver.ts, entry-brain-tier2-simulated-resolver.ts). Mirrors
 * exit-brain-shadow.ts's own cycle/guarded-cycle shape: a pure-ish core function taking every I/O as an
 * injected dep, wrapped by a single-flight guard so a slow candle fetch can never stack two cycles.
 *
 * FULLY INDEPENDENT of the four-brain shadow tick's own interval/exception handling (per design intent):
 * this module imports NOTHING from four-brain-shadow-tick.ts / four-brain-live-wiring.ts, and its own
 * try/catch means a bug here can never affect that tick, or vice versa. The two are wired as two
 * separate setInterval registrations in app.ts.
 *
 * ── DIRECTION: due / resolve / terminal ──────────────────────────────────────────────────────────────
 * A pending Direction row is "due" once its own horizon window has elapsed (asOfMs + HORIZON_MS[horizon]
 * <= now) — exactly resolveDirectionOutcome's own PENDING gate, applied here first so a non-due row's
 * candle needs are never even considered. Due rows are resolved against ONE shared BTCUSDT 1h candle
 * fetch per cycle (fetchDirectionCandles — bounded, deduped-within-cycle, reused across every due row):
 *   - EVALUATED  → terminal RESOLVED: store it, remove the row from the ledger, advance.
 *   - EXPIRED_UNRESOLVABLE → terminal: store it, remove the row from the ledger, advance.
 *   - INSTRUMENT_DATA_MISSING → TRANSIENT: the row stays in the ledger (retried next cycle); counted
 *     into a current-cycle GAUGE only (see direction-entry-outcome-store.ts's doc for why this must
 *     never be a cumulative counter).
 *   - PENDING (should not occur post-filter, but resolveDirectionOutcome is re-checked defensively) →
 *     left untouched.
 *
 * ── ENTRY: Tier 1 first, Tier 2 fallback, terminal ──────────────────────────────────────────────────
 * EVERY pending Entry row is re-checked EVERY cycle against Tier 1 (resolveEntryBrainTier1Realized, one
 * batch call against position-path-recorder.ts's current closed paths) — unconditionally, because a stop
 * can trigger before a row's own 8h Tier 2 horizon cap, and Tier 1 (a real recorded fill) is always
 * preferred evidence over a simulation. Rows Tier 1 resolves are booked as TIER1_REALIZED and removed.
 *
 * Rows Tier 1 does NOT resolve are left alone UNTIL enough time has passed that continuing to wait for a
 * real fill stops being useful: `asOfMs + ENTRY_TIER2_HORIZON_MS + ENTRY_TIER2_WAIT_WINDOW_BARS *
 * ENTRY_TIER2_BAR_MS` (entry-brain-tier2-simulated-resolver.ts's own forward-walk + wait-window budget —
 * the same deadline that resolver's own simulation horizon is built around). Past that deadline, Tier 2
 * (resolveEntryTier2Row) is attempted with a small, bounded, per-row candle fetch (fetchEntryTier2Candles
 * — deduped within the cycle by `${symbol}:${asOfMs}`, since two lanes can share a signal). An empty/
 * transient fetch receives one immediate retry before it is reported as unavailable, capped at
 * maxEntryTier2AttemptsPerCycle so a large backlog can never stall the 15-min cycle:
 *   - Tier 2 succeeds → terminal RESOLVED (TIER2_SIMULATED): store it, remove, advance.
 *   - Tier 2 fails (no candles, or the row's own geometry is unusable) → TRANSIENT
 *     INSTRUMENT_DATA_MISSING UNLESS the row has now been stuck past MAX_UNRESOLVABLE_STALENESS_MS since
 *     its own asOfMs (direction-brain-resolver.ts's own 7-day constant, reused verbatim — the same
 *     "past this point it will never resolve" cutoff, applied to Entry for the same reason), in which
 *     case it is terminal EXPIRED_UNRESOLVABLE: store it, remove, advance.
 *   - A row with no symbolOrBasketId can never be fetched/simulated at all; it follows the same
 *     staleness-capped INSTRUMENT_DATA_MISSING → EXPIRED_UNRESOLVABLE path without ever attempting a
 *     fetch.
 *
 * Never throws to its caller: every resolver call is individually try/catch'd (one bad row's exception
 * is skipped, not fatal — mirrors runFourBrainShadowTick's own per-candidate isolation lesson), and the
 * whole cycle has an outer catch that still records cycleMeta.lastError so a broken cycle is visibly
 * "ran and errored," never silently frozen (see four-brain-shadow-tick's own doc for the SAME lesson
 * learned the hard way there).
 */
import type { Candle } from "@dtc/shared";
import type { PathCandle } from "./entry-exit-counterfactual.js";
import type { PendingDirectionRow, PendingEntryRow, FourBrainOutcomeHorizon } from "./four-brain-outcome-ledger.js";
import type { PositionPath } from "./position-path-recorder.js";
import { resolveDirectionOutcome, HORIZON_MS, MAX_UNRESOLVABLE_STALENESS_MS } from "./direction-brain-resolver.js";
import {
  resolveEntryBrainTier1RealizedWithDiagnostics,
  type EntryBrainTier1Diagnostics,
  type EntryBrainTier1Row,
} from "./entry-brain-tier1-realized-resolver.js";
import {
  resolveEntryTier2Row,
  ENTRY_TIER2_HORIZON_MS,
  ENTRY_TIER2_WAIT_WINDOW_BARS,
  ENTRY_TIER2_BAR_MS,
} from "./entry-brain-tier2-simulated-resolver.js";
import { DirectionEntryOutcomeStore, type DirectionOutcomeRecord, type EntryOutcomeRecord } from "./direction-entry-outcome-store.js";
import { fourBrainInstanceAllowed, fourBrainShadowActive } from "./four-brain-live-gather-bindings.js";
import type { FourBrainActualFillBindingStore } from "./four-brain-actual-fill-binding.js";

// ── Gating (3 layers, ALL required — see module doc / task design) ─────────────────────────────────
// (a) a brand-new, SEPARATE env flag: enabling four-brain shadow mode alone must NOT turn this job on.
// (b)+(c) fourBrainInstanceAllowed / fourBrainShadowActive, reused by DIRECT function reference (never
// reimplemented) — this is what keeps 3103 (live, real money) permanently excluded even if this new
// reconciler code has a bug, exactly like every other four-brain-only interval in app.ts.

/** Brand-new, separate env flag — default OFF. Must be explicitly "shadow" to activate; the four-brain
 *  shadow tick's own FOUR_BRAIN_MODE="shadow" has NO effect on this flag (deliberately independent). */
export function fourBrainOutcomeModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FOUR_BRAIN_OUTCOME_MODE ?? "").toString().trim().toLowerCase() === "shadow";
}

/** The single composed gate app.ts uses to arm the reconciler's own setInterval. ALL THREE layers
 *  required: the new env flag, the instance allowlist (hard-blocks 3103 regardless of env), AND the
 *  four-brain shadow tick actually being active on this instance (so the outcome ledger this reconciler
 *  reads is actually being fed). Reused by direct reference wherever this gate needs to be checked —
 *  never reimplemented at the call site. */
export function directionEntryReconcilerActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return fourBrainOutcomeModeEnabled(env) && fourBrainInstanceAllowed(env) && fourBrainShadowActive(env);
}

/** The deadline (ms after asOfMs) past which Tier 1 is no longer worth waiting for and Tier 2 simulation
 *  is attempted instead. Derived from the Tier 2 resolver's own forward-walk + wait-window budget —
 *  never hand-tuned separately. */
export const ENTRY_TIER2_ELIGIBLE_AFTER_MS = ENTRY_TIER2_HORIZON_MS + ENTRY_TIER2_WAIT_WINDOW_BARS * ENTRY_TIER2_BAR_MS;

/** Per-cycle work bounds — a large backlog must never stall the 15-min cycle.  The entry ceiling is
 * deliberately above the observed 5-minute shadow-decision ingress on the focused testnet lanes, so
 * normal traffic drains instead of accumulating permanently. Mirrors exit-brain-shadow.ts's
 * DEFAULT_MAX_TRADES_PER_CYCLE idiom. */
export const DEFAULT_MAX_DIRECTION_PER_CYCLE = 500;
export const DEFAULT_MAX_ENTRY_TIER2_ATTEMPTS_PER_CYCLE = 400;
export const DEFAULT_ENTRY_TIER2_FETCH_CONCURRENCY = 4;

/** Tier 2 remains report-only, but its backlog should resolve the choices closest to a possible
 * executable action first.  Exact actual-fill binding still wins before this queue is considered. */
const ENTRY_TIER2_ACTION_PRIORITY: Record<PendingEntryRow["action"], number> = {
  ENTER_NOW: 0,
  WAIT_PULLBACK: 1,
  WAIT_BREAKOUT: 1,
  WAIT_CONFIRMATION: 1,
  SKIP: 2,
};

function tier2PriorityOrder(a: PendingEntryRow, b: PendingEntryRow): number {
  const actionDelta = ENTRY_TIER2_ACTION_PRIORITY[a.action] - ENTRY_TIER2_ACTION_PRIORITY[b.action];
  if (actionDelta !== 0) return actionDelta;
  const timeDelta = a.asOfMs - b.asOfMs;
  if (timeDelta !== 0) return timeDelta;
  return a.decisionId.localeCompare(b.decisionId);
}

export interface OutcomeLedgerLike {
  getPendingDirectionRows(): PendingDirectionRow[];
  getPendingEntryRows(): PendingEntryRow[];
  removeDirectionByIds(ids: ReadonlySet<string>): void;
  removeEntryByIds(ids: ReadonlySet<string>): void;
}

export interface DirectionEntryReconcilerDeps {
  ledger: OutcomeLedgerLike;
  store: DirectionEntryOutcomeStore;
  /** Current closed real position paths (position-path-recorder.ts). MAY throw — caught, treated as
   *  "no closes available this cycle" (Tier 1 simply resolves nothing, never a fabricated match). */
  listClosedPositionPaths: () => PositionPath[];
  /** ONE shared BTCUSDT 1h candle fetch per cycle, reused across every due Direction row. Only called
   *  when at least one Direction row is actually due (never an unconditional fetch). */
  fetchDirectionCandles: () => Promise<Candle[] | null>;
  /** Per-row Tier 2 candle fetch (15m bars from the row's own asOfMs). Deduped within the cycle by
   *  `${symbol}:${asOfMs}`. */
  fetchEntryTier2Candles: (symbolOrBasketId: string, sinceMs: number) => Promise<PathCandle[] | null>;
  /** Exact executor-fill binding. It wins over the legacy time-window path matcher. */
  actualFillBindings?: FourBrainActualFillBindingStore;
  now?: () => number;
  maxDirectionPerCycle?: number;
  maxEntryTier2AttemptsPerCycle?: number;
  entryTier2FetchConcurrency?: number;
}

export interface DirectionEntryReconcilerResult {
  ok: boolean;
  directionProcessed: number;
  entryProcessed: number;
  directionSkippedNotDue: number;
  entrySkippedNotDue: number;
  directActualFillProcessed: number;
  tier1Diagnostics: EntryBrainTier1Diagnostics | null;
  error: string | null;
}

async function prefetchEntryTier2Candles(args: {
  requests: Array<{ cacheKey: string; symbolOrBasketId: string; sinceMs: number; decisionId: string }>;
  cache: Map<string, PathCandle[] | null>;
  fetch: (symbolOrBasketId: string, sinceMs: number) => Promise<PathCandle[] | null>;
  errors: string[];
  concurrency: number;
}): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < args.requests.length) {
      const request = args.requests[cursor++]!;
      let candles: PathCandle[] | null = null;
      let lastError: unknown = null;
      // A single public-candle miss is often transport/rate jitter. Retry once in the same bounded
      // worker before labelling this decision's source unavailable; the retry count never changes the
      // number of scheduled decisions or any trading path.
      for (let attempt = 0; attempt < 2 && !candles; attempt += 1) {
        try {
          const fetched = await args.fetch(request.symbolOrBasketId, request.sinceMs);
          if (Array.isArray(fetched) && fetched.length > 0) candles = fetched;
        } catch (err) {
          lastError = err;
        }
      }
      if (!candles && lastError !== null) {
        args.errors.push(
          `entry-tier2-candles:${request.decisionId}:${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }
      args.cache.set(request.cacheKey, candles);
    }
  };
  const workerCount = Math.min(
    args.requests.length,
    Math.max(1, Math.floor(args.concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Run one reconciliation cycle. Never throws — any error is captured into the store's cycleMeta and
 * returned, never propagated. Safe to call repeatedly / concurrently on the SAME due rows: every booking
 * is idempotent per decisionId via the store's own processed-id dedup (see
 * direction-entry-outcome-store.ts), so a crash-and-restart mid-cycle (or a caller accidentally invoking
 * this twice before the ledger removal lands) can never double-score a decision.
 */
export async function runDirectionEntryReconciliationCycle(
  deps: DirectionEntryReconcilerDeps,
): Promise<DirectionEntryReconcilerResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const maxDirection = deps.maxDirectionPerCycle ?? DEFAULT_MAX_DIRECTION_PER_CYCLE;
  const maxEntryTier2 = deps.maxEntryTier2AttemptsPerCycle ?? DEFAULT_MAX_ENTRY_TIER2_ATTEMPTS_PER_CYCLE;
  const entryTier2FetchConcurrency =
    deps.entryTier2FetchConcurrency ?? DEFAULT_ENTRY_TIER2_FETCH_CONCURRENCY;
  const errors: string[] = [];
  let directionProcessed = 0;
  let entryProcessed = 0;
  let directionSkippedNotDue = 0;
  let entrySkippedNotDue = 0;
  let directActualFillProcessed = 0;
  let tier1Diagnostics: EntryBrainTier1Diagnostics | null = null;

  try {
    // ── DIRECTION ──────────────────────────────────────────────────────────────────────────────────
    const pendingDirection = deps.ledger.getPendingDirectionRows();
    const dueDirection: PendingDirectionRow[] = [];
    for (const row of pendingDirection) {
      const horizonMs = HORIZON_MS[row.horizon];
      if (Number.isFinite(horizonMs) && row.asOfMs + horizonMs <= nowMs) dueDirection.push(row);
      else directionSkippedNotDue += 1;
    }
    const cappedDirection = dueDirection.slice(0, maxDirection);

    let btcCandles: Candle[] | null = null;
    if (cappedDirection.length > 0) {
      try {
        btcCandles = await deps.fetchDirectionCandles();
      } catch (err) {
        errors.push(`direction-candles:${err instanceof Error ? err.message : String(err)}`);
        btcCandles = null;
      }
    }

    const toRemoveDirection = new Set<string>();
    const missingByHorizon: Partial<Record<FourBrainOutcomeHorizon, number>> = {};
    for (const row of cappedDirection) {
      try {
        const outcome = resolveDirectionOutcome(row, btcCandles ?? [], nowMs);
        if (outcome.status === "EVALUATED" || outcome.status === "EXPIRED_UNRESOLVABLE") {
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
            canonicalRegimeFamily: row.canonicalRegimeFamily ?? null,
            scannerRegime: row.scannerRegime ?? null,
            marketContextSnapshotId: row.marketContextSnapshotId ?? null,
          };
          const booked = deps.store.recordDirectionOutcome(record, HORIZON_MS[row.horizon], { deferSave: true });
          toRemoveDirection.add(row.decisionId);
          if (booked) directionProcessed += 1;
        } else if (outcome.status === "INSTRUMENT_DATA_MISSING") {
          missingByHorizon[row.horizon] = (missingByHorizon[row.horizon] ?? 0) + 1;
        }
        // PENDING: left untouched (should not occur post-filter; defensive only).
      } catch (err) {
        errors.push(`direction:${row.decisionId}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
    deps.store.setCurrentDirectionInstrumentDataMissing(missingByHorizon, { deferSave: true });
    deps.ledger.removeDirectionByIds(toRemoveDirection);

    // ── ENTRY ──────────────────────────────────────────────────────────────────────────────────────
    const pendingEntry = deps.ledger.getPendingEntryRows(); // unconditional re-check, every cycle
    let closedPaths: PositionPath[] = [];
    try {
      closedPaths = deps.listClosedPositionPaths();
    } catch (err) {
      errors.push(`entry-closed-paths:${err instanceof Error ? err.message : String(err)}`);
      closedPaths = [];
    }

    // A direct binding is causal: it was captured from the exact same signal identity at the
    // moment a real executor fill landed.  It takes precedence over the older window matcher;
    // an OPEN binding also suppresses Tier 2 so a real position is never relabelled by candles.
    const directMeasuredByDecisionId = new Map(
      (deps.actualFillBindings?.listClosedMeasuredOutcomes() ?? []).map((outcome) => [outcome.decisionId, outcome]),
    );
    const directUnmeasuredByDecisionId = new Map(
      (deps.actualFillBindings?.listClosedUnmeasuredOutcomes() ?? []).map((outcome) => [outcome.decisionId, outcome]),
    );
    const hasOpenDirectBinding = (decisionId: string): boolean =>
      deps.actualFillBindings?.hasOpenBindingForDecisionId(decisionId) === true;

    // Exclude any close already claimed by a PRIOR cycle's Tier 1 match (store.hasClaimedTier1CloseKey —
    // persisted cross-cycle memory). listClosedPositionPaths() is a rolling window (position-path-
    // recorder.ts's own MAX_CLOSED_PATHS=300) that keeps re-offering the same real close across many
    // reconciliation cycles; the resolver's own consumedDecisionIds set only prevents a decision from
    // claiming two closes WITHIN one call, not the same close being re-matched to a DIFFERENT pending
    // decision in a LATER call. Without this filter, two pending decisions for the same lane/symbol/side
    // falling inside one real close's TTL window would both eventually get booked against that single
    // close (one this cycle, the other next cycle once the first is removed from `pendingEntry`) —
    // violating the resolver's own "one close claimed once" invariant across cycles.
    const claimableClosedPaths = closedPaths.filter(
      (p) => !(p && typeof p.key === "string" && deps.store.hasClaimedTier1CloseKey(p.key)),
    );

    let tier1Rows: EntryBrainTier1Row[] = [];
    try {
      const legacyPending = pendingEntry.filter(
        (row) =>
          !directMeasuredByDecisionId.has(row.decisionId) &&
          !directUnmeasuredByDecisionId.has(row.decisionId) &&
          !hasOpenDirectBinding(row.decisionId),
      );
      const tier1Result = resolveEntryBrainTier1RealizedWithDiagnostics(legacyPending, claimableClosedPaths);
      tier1Rows = tier1Result.rows;
      tier1Diagnostics = tier1Result.diagnostics;
      deps.store.setTier1Diagnostics(tier1Diagnostics, { deferSave: true });
    } catch (err) {
      errors.push(`entry-tier1:${err instanceof Error ? err.message : String(err)}`);
      tier1Rows = [];
    }
    const tier1ByDecisionId = new Map(tier1Rows.map((r) => [r.decisionId, r]));

    const toRemoveEntry = new Set<string>();
    let entryMissingCount = 0;
    const tier2CandleCache = new Map<string, PathCandle[] | null>();
    const tier2PrefetchRequests = new Map<
      string,
      { cacheKey: string; symbolOrBasketId: string; sinceMs: number; decisionId: string }
    >();
    const tier2EligibleRows = pendingEntry
      .filter((row) => {
        if (directMeasuredByDecisionId.has(row.decisionId) || directUnmeasuredByDecisionId.has(row.decisionId) || hasOpenDirectBinding(row.decisionId)) return false;
        if (tier1ByDecisionId.get(row.decisionId)?.status === "RESOLVED") return false;
        return nowMs >= row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS && Boolean(row.symbolOrBasketId);
      })
      .sort(tier2PriorityOrder);
    const tier2ScheduledRows = tier2EligibleRows.slice(0, Math.max(0, maxEntryTier2));
    const tier2ScheduledIds = new Set(tier2ScheduledRows.map((row) => row.decisionId));
    const entryTier2DeferredCount = Math.max(0, tier2EligibleRows.length - tier2ScheduledRows.length);
    for (const row of tier2ScheduledRows) {
      // `tier2EligibleRows` filters these out, but keep the local guard so this boundary remains
      // type-safe and resilient if the predicate is ever changed.
      const symbolOrBasketId = row.symbolOrBasketId;
      if (!symbolOrBasketId) continue;
      const cacheKey = `${symbolOrBasketId}:${row.asOfMs}`;
      if (!tier2PrefetchRequests.has(cacheKey)) {
        tier2PrefetchRequests.set(cacheKey, {
          cacheKey,
          symbolOrBasketId,
          sinceMs: row.asOfMs,
          decisionId: row.decisionId,
        });
      }
    }
    await prefetchEntryTier2Candles({
      requests: [...tier2PrefetchRequests.values()],
      cache: tier2CandleCache,
      fetch: deps.fetchEntryTier2Candles,
      errors,
      concurrency: entryTier2FetchConcurrency,
    });

    for (const row of pendingEntry) {
      const direct = directMeasuredByDecisionId.get(row.decisionId);
      if (direct) {
        const record: EntryOutcomeRecord = {
          decisionId: row.decisionId,
          tier: "TIER1_REALIZED",
          laneId: direct.laneId,
          symbolOrBasketId: direct.symbolOrBasketId,
          side: direct.side,
          action: row.action,
          confidence: "MEASURED",
          asOfMs: direct.asOfMs,
          status: "RESOLVED",
          expectedNetR: direct.expectedNetR,
          realizedNetR: direct.realizedNetR,
          realizedRSource: "actual_fill_binding",
          horizonTruncated: null,
          matchedCloseKey: direct.matchedCloseKey,
          canonicalRegimeFamily: direct.canonicalRegimeFamily,
          scannerRegime: direct.scannerRegime,
          marketContextSnapshotId: direct.marketContextSnapshotId,
        };
        const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
        toRemoveEntry.add(row.decisionId);
        if (booked) {
          entryProcessed += 1;
          directActualFillProcessed += 1;
        }
        continue;
      }
      const directUnmeasured = directUnmeasuredByDecisionId.get(row.decisionId);
      if (directUnmeasured) {
        // An actual fill existed, but its close economics could not be verified.  Do not let a
        // later simulated candle outcome overwrite that honest limitation.
        const record: EntryOutcomeRecord = {
          decisionId: row.decisionId,
          tier: null,
          laneId: directUnmeasured.laneId,
          symbolOrBasketId: directUnmeasured.symbolOrBasketId,
          side: directUnmeasured.side,
          action: row.action,
          confidence: "EXPERIMENTAL_COST_OF_CAUTION",
          asOfMs: directUnmeasured.asOfMs,
          status: "EXPIRED_UNRESOLVABLE",
          expectedNetR: directUnmeasured.expectedNetR,
          realizedNetR: null,
          realizedRSource: null,
          horizonTruncated: null,
          matchedCloseKey: null,
          canonicalRegimeFamily: directUnmeasured.canonicalRegimeFamily,
          scannerRegime: directUnmeasured.scannerRegime,
          marketContextSnapshotId: directUnmeasured.marketContextSnapshotId,
        };
        const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
        toRemoveEntry.add(row.decisionId);
        if (booked) entryProcessed += 1;
        continue;
      }
      if (hasOpenDirectBinding(row.decisionId)) {
        entrySkippedNotDue += 1;
        continue;
      }
      const t1 = tier1ByDecisionId.get(row.decisionId);
      if (t1 && t1.status === "RESOLVED") {
        const record: EntryOutcomeRecord = {
          decisionId: row.decisionId,
          tier: "TIER1_REALIZED",
          laneId: t1.laneId,
          symbolOrBasketId: t1.symbolOrBasketId,
          side: t1.side,
          action: row.action,
          confidence: "MEASURED",
          asOfMs: row.asOfMs,
          status: "RESOLVED",
          expectedNetR: t1.expectedNetR,
          realizedNetR: t1.realizedR,
          realizedRSource: t1.realizedRSource,
          horizonTruncated: null,
          matchedCloseKey: t1.matchedCloseKey,
          canonicalRegimeFamily: row.canonicalRegimeFamily ?? null,
          scannerRegime: row.scannerRegime ?? null,
          marketContextSnapshotId: row.marketContextSnapshotId ?? null,
        };
        const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
        toRemoveEntry.add(row.decisionId);
        if (booked) entryProcessed += 1;
        continue;
      }

      const tier2EligibleAtMs = row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS;
      if (nowMs < tier2EligibleAtMs) {
        entrySkippedNotDue += 1;
        continue; // still might get a real Tier 1 close later — leave PENDING, retried next cycle
      }

      const staleness = nowMs - row.asOfMs;
      const expireNow = staleness > MAX_UNRESOLVABLE_STALENESS_MS;

      if (!row.symbolOrBasketId) {
        // No symbol identity — can never fetch candles or simulate. Wait out the same staleness cap
        // before giving up permanently (never fabricate an outcome for it).
        if (expireNow) {
          const record: EntryOutcomeRecord = {
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
            canonicalRegimeFamily: row.canonicalRegimeFamily ?? null,
            scannerRegime: row.scannerRegime ?? null,
            marketContextSnapshotId: row.marketContextSnapshotId ?? null,
          };
          const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
          toRemoveEntry.add(row.decisionId);
          if (booked) entryProcessed += 1;
        } else {
          entryMissingCount += 1;
        }
        continue;
      }

      if (!tier2ScheduledIds.has(row.decisionId)) {
        // The bounded scheduler intentionally left this due row in the queue.  It was not fetched,
        // so reporting it as an instrument-data failure would turn healthy backlog into a false red
        // health signal.  The aggregate deferred gauge is set once after the loop.
        continue;
      }

      const cacheKey = `${row.symbolOrBasketId}:${row.asOfMs}`;
      const candles = tier2CandleCache.get(cacheKey) ?? null;

      let tier2Result: ReturnType<typeof resolveEntryTier2Row> = null;
      if (candles && candles.length > 0) {
        try {
          tier2Result = resolveEntryTier2Row(row, candles);
        } catch (err) {
          errors.push(`entry-tier2:${row.decisionId}:${err instanceof Error ? err.message : String(err)}`);
          tier2Result = null;
        }
      }

      if (tier2Result) {
        const record: EntryOutcomeRecord = {
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
          // SKIP's real cost of caution — computed by evaluateEntryActions all along and dropped here
          // until 2026-07-28, which is why SKIP could never be judged despite being 97% of decisions.
          opportunityCostR: tier2Result.result.opportunityCostR ?? null,
          matchedCloseKey: null,
          canonicalRegimeFamily: row.canonicalRegimeFamily ?? null,
          scannerRegime: row.scannerRegime ?? null,
          marketContextSnapshotId: row.marketContextSnapshotId ?? null,
        };
        const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
        toRemoveEntry.add(row.decisionId);
        if (booked) entryProcessed += 1;
      } else if (expireNow) {
        const record: EntryOutcomeRecord = {
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
          canonicalRegimeFamily: row.canonicalRegimeFamily ?? null,
          scannerRegime: row.scannerRegime ?? null,
          marketContextSnapshotId: row.marketContextSnapshotId ?? null,
        };
        const booked = deps.store.recordEntryOutcome(record, { deferSave: true });
        toRemoveEntry.add(row.decisionId);
        if (booked) entryProcessed += 1;
      } else {
        entryMissingCount += 1;
      }
    }
    deps.store.setCurrentEntryInstrumentDataMissing(entryMissingCount, { deferSave: true });
    deps.store.setCurrentEntryTier2Deferred(entryTier2DeferredCount, { deferSave: true });
    deps.ledger.removeEntryByIds(toRemoveEntry);

    const lastError = errors.length > 0 ? errors.join("; ").slice(0, 4000) : null;
    deps.store.recordCycle(new Date(nowMs).toISOString(), directionProcessed + entryProcessed, lastError, { deferSave: true });
    deps.store.flush();

    return {
      ok: errors.length === 0,
      directionProcessed,
      entryProcessed,
      directionSkippedNotDue,
      entrySkippedNotDue,
      directActualFillProcessed,
      tier1Diagnostics,
      error: lastError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      deps.store.recordCycle(new Date(nowMs).toISOString(), directionProcessed + entryProcessed, message, { deferSave: true });
      deps.store.flush();
    } catch {
      // never let liveness bookkeeping break the caller
    }
    return {
      ok: false,
      directionProcessed,
      entryProcessed,
      directionSkippedNotDue,
      entrySkippedNotDue,
      directActualFillProcessed,
      tier1Diagnostics,
      error: message,
    };
  }
}

/** Cycle-level single-flight guard — the async candle fetches can outlast the 15-min interval on a slow
 *  Binance response; without this, cycles would pile up. Mirrors
 *  exit-brain-shadow.ts/four-brain-live-wiring.ts's own guard idiom. Returns null when a prior cycle is
 *  still in flight (never overlaps). Never throws. */
let cycleInFlight = false;
export async function runDirectionEntryReconciliationCycleGuarded(
  deps: DirectionEntryReconcilerDeps,
): Promise<DirectionEntryReconcilerResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runDirectionEntryReconciliationCycle(deps);
  } finally {
    cycleInFlight = false;
  }
}
/** Test hook: reset the single-flight latch. */
export function _resetDirectionEntryReconcilerLatchForTests(): void {
  cycleInFlight = false;
}

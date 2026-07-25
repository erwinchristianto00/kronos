/**
 * DIRECTION + ENTRY BRAIN OUTCOME STORE (2026-07-23, REPORT-ONLY). Bounded, persisted store for the
 * counterfactual outcomes produced by the 3 pure resolvers (direction-brain-resolver.ts,
 * entry-brain-tier1-realized-resolver.ts, entry-brain-tier2-simulated-resolver.ts) once
 * direction-entry-reconciler.ts's periodic job resolves rows pulled from the Foundation pending ledger
 * (four-brain-outcome-ledger.ts). Persistence idiom mirrors exit-brain-shadow.ts's ExitBrainShadowStore
 * exactly: compact JSON, atomic tmp+rename, bounded detail records + running aggregates that survive
 * pruning, bounded FIFO processed-decisionId dedup sets (idempotent — a decision can only ever be
 * booked once, even across a crash-and-restart mid-cycle).
 *
 * TWO INDEPENDENT SECTIONS, NEVER BLENDED:
 *   - direction: Direction Brain regime-level LONG/SHORT/FLAT/BOTH outcomes (BTCUSDT proxy).
 *   - entry: Entry Brain per-candidate outcomes, split Tier 1 (REAL recorded fill — "MEASURED"
 *     confidence, resolved against position-path-recorder.ts's closed paths) vs Tier 2 (SIMULATED
 *     forward candle walk — confidence per entry-brain-tier2-simulated-resolver.ts's permanent
 *     ENTER_NOW→MEASURED / WAIT|SKIP→EXPERIMENTAL_COST_OF_CAUTION tag). Tier 1 and Tier 2 evidence is
 *     NEVER merged into one blended field anywhere in this store or its report — every aggregate that
 *     touches Entry evidence carries an explicit tier (or confidence) key.
 *
 * TERMINAL vs TRANSIENT STATUS (both sections): a row leaves the pending ledger and gets a permanent
 * bounded detail record ONLY on a TERMINAL status — RESOLVED (Direction: EVALUATED; Entry: matched
 * Tier 1 or simulated Tier 2) or EXPIRED_UNRESOLVABLE (past MAX_UNRESOLVABLE_STALENESS_MS with still no
 * usable data/geometry — direction-brain-resolver.ts's own constant, reused verbatim for Entry too).
 * INSTRUMENT_DATA_MISSING is TRANSIENT: the row stays in the pending ledger and is retried next cycle,
 * so it is tracked as a CURRENT-CYCLE GAUGE (overwritten every reconciliation pass), never a cumulative
 * counter — accumulating it would double-count the same still-open row every 15 minutes it stays stuck,
 * which would be a fabricated precision claim. This gauge/counter split is the one deliberate asymmetry
 * versus ExitBrainShadowStore's simpler two-bucket (evaluated/insufficient) design; documented here so
 * a future reader doesn't "fix" it into a cumulative counter and reintroduce the double-count.
 *
 * EFFECTIVE SAMPLE SIZE (Direction only): direction-brain-resolver.ts's own
 * computeDirectionEffectiveSampleSize clusters overlapping horizon windows into non-overlapping BLOCKS
 * (floor(asOfMs / horizonMs)) — the true, non-overlapping "independent draws" count, always <= raw n.
 * Recomputing this from full history at report time would require storing every asOfMs forever
 * (unbounded). Instead this store tracks ONE running counter per horizon (effectiveN) plus the last
 * block key seen for that horizon, and increments effectiveN only when a newly-resolved row's block key
 * differs from the last one recorded — valid because rows are resolved in non-decreasing asOfMs order
 * (the ledger is FIFO oldest-first and the reconciler processes it in that order), so block keys are
 * seen in non-decreasing order too. O(1) state, exact result, no unbounded history required. The
 * perAction breakdown reuses its horizon's shared effectiveN for the insufficientEffectiveSampleSize gate
 * (action-level raw n would understate the true overlap risk — two different actions in the same
 * overlapping window are still correlated, not independent).
 *
 * INSUFFICIENT_DATA floor: CORTEX_ATTR_MIN_EXAMPLES_ACTIVE (20, cortex-attribution.ts's own small-n
 * idiom) gates every rate/mean field in this report — any bucket below the floor reports
 * insufficientData: true and null numbers, never a naked misleadingly-precise percentage.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CORTEX_ATTR_MIN_EXAMPLES_ACTIVE } from "./cortex-attribution.js";
import type { EntryBrainTier1Diagnostics } from "./entry-brain-tier1-realized-resolver.js";
import type {
  FourBrainOutcomeDirectionAction,
  FourBrainOutcomeEntryAction,
  FourBrainOutcomeEntrySide,
  FourBrainOutcomeHorizon,
} from "./four-brain-outcome-ledger.js";

/** Newest-N detail records kept on disk per section (aggregates keep counting past this). */
const MAX_DIRECTION_RECORDS = 800;
const MAX_ENTRY_RECORDS = 2500;
/** Dedup ids retained (FIFO), sized well above the ledger's own capacities (500 direction / 2000 entry)
 *  so a resolved id cannot be re-offered and double-booked for a long horizon. */
const MAX_PROCESSED_DIRECTION_IDS = 4000;
const MAX_PROCESSED_ENTRY_IDS = 10_000;
/** Tier-1 "one close claimed once" cross-cycle memory (FIFO), sized well above
 *  position-path-recorder.ts's own MAX_CLOSED_PATHS (300) rolling window so a real close still visible
 *  in that window can never be evicted here first and re-claimed by a second pending decision in a
 *  later cycle. See recordEntryOutcome / hasClaimedTier1CloseKey. */
const MAX_CLAIMED_TIER1_CLOSE_KEYS = 4000;
/** perLane / perSymbol rows strictly bounded; overflow folds into OTHER (mirrors exit-brain-shadow.ts). */
const MAX_LANES = 200;
const MAX_SYMBOLS = 200;
const OVERFLOW_ID = "OTHER";
/** How many rows the "recent" list in the report keeps, per section. */
const RECENT_ROWS = 25;
/** Small-n floor — reused verbatim from cortex-attribution.ts, not re-derived. */
export const DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE = CORTEX_ATTR_MIN_EXAMPLES_ACTIVE;

const DIRECTION_HORIZONS: FourBrainOutcomeHorizon[] = ["SCALP", "INTRADAY", "SWING"];
const DIRECTION_ACTIONS: FourBrainOutcomeDirectionAction[] = ["LONG", "SHORT", "FLAT", "BOTH"];
const ENTRY_ACTIONS: FourBrainOutcomeEntryAction[] = [
  "ENTER_NOW",
  "WAIT_PULLBACK",
  "WAIT_BREAKOUT",
  "WAIT_CONFIRMATION",
  "SKIP",
];

export type TerminalOutcomeStatus = "RESOLVED" | "EXPIRED_UNRESOLVABLE";
export type EntryTier = "TIER1_REALIZED" | "TIER2_SIMULATED";
export type EntryConfidence = "MEASURED" | "EXPERIMENTAL_COST_OF_CAUTION";

export interface DirectionOutcomeRecord {
  decisionId: string;
  horizon: FourBrainOutcomeHorizon;
  action: FourBrainOutcomeDirectionAction;
  asOfMs: number;
  status: TerminalOutcomeStatus;
  chosenNetR: number | null;
  win: 0 | 1 | null;
  regretR: number | null;
  calibrationGapR: number | null;
}

export interface EntryOutcomeRecord {
  decisionId: string;
  tier: EntryTier | null; // null only for a no-symbol row that expired without ever reaching a tier
  laneId: string | null;
  symbolOrBasketId: string | null;
  side: FourBrainOutcomeEntrySide;
  action: FourBrainOutcomeEntryAction;
  confidence: EntryConfidence;
  asOfMs: number;
  status: TerminalOutcomeStatus;
  expectedNetR: number | null;
  realizedNetR: number | null;
  /** Tier 1 only: "engine" (NET) vs "executor" (RAW) — see entry-brain-tier1-realized-resolver.ts. Null
   *  for Tier 2 (simulated netR already nets ENTRY_ROUNDTRIP_COST_BPS, a third, separate convention). */
  realizedRSource: "engine" | "executor" | null;
  /** Tier 2 only — see entry-brain-tier2-simulated-resolver.ts's own doc. Null for Tier 1 (n/a) and for
   *  EXPIRED_UNRESOLVABLE rows that never reached a tier. */
  horizonTruncated: boolean | null;
  /** Tier 1 only — the PositionPath.key of the real close this row was joined to (verbatim from
   *  EntryBrainTier1ResolvedRow.matchedCloseKey). Recorded here (and in the store's own persisted
   *  claimed-key set — see hasClaimedTier1CloseKey) so the reconciler can exclude an already-claimed
   *  close from matching a SECOND pending decision in a later cycle — position-path-recorder.ts's
   *  listClosedPositionPaths() is a rolling 300-slot window that keeps offering the same close across
   *  many cycles, and the Tier 1 resolver's own consumedDecisionIds set is local to one call, so without
   *  this cross-cycle memory the same real close could be double-booked against two different decisions.
   *  Null for Tier 2 and for EXPIRED_UNRESOLVABLE rows that never reached a tier. */
  matchedCloseKey: string | null;
}

interface RateAggregate {
  n: number;
  wins: number;
  /** Count of rows for which `win` was actually supplied (non-null) — the true denominator for
   *  winRate. A row whose `win` is null (e.g. a calibration row, where "win" isn't a meaningful concept)
   *  must NEVER be treated as a loss: without this counter, `wins/n` would silently report a fabricated
   *  0% win rate for a bucket that never tracked wins at all. See rateView. */
  winTrackedN: number;
  cumNetR: number;
  /** Count of rows for which `netR` was actually supplied (non-null) — the true denominator for
   *  meanNetR. A row whose netR is null (Entry Tier 2: SKIP always resolves NOT_ENTERED, and a
   *  WAIT_PULLBACK/WAIT_BREAKOUT/WAIT_CONFIRMATION row whose trigger never fires in-window resolves the
   *  same way — see entry-exit-counterfactual.ts's NOT_ENTERED) must NEVER be treated as a realized 0R:
   *  without this counter, `cumNetR/n` would silently report a fabricated "+0.000R" for a bucket that
   *  never observed a single real/simulated fill, or dilute a triggered-subset's true mean toward zero
   *  with untriggered rows that have no R to contribute. Same bug class as winTrackedN above; see
   *  rateView. Direction's own chosenNetR is always finite for a RESOLVED row, so this is a no-op there
   *  (netRTrackedN == n always) — the gap was Entry-only. */
  netRTrackedN: number;
  cumRegretR: number; // direction only; 0 for entry
  /** Count of rows for which `regretR` was actually supplied (non-null) — direction-only concept
   *  (EntryOutcomeRecord carries no regretR field; every Entry call site passes regretR: null). Without
   *  this counter, meanRegretR would silently report a fabricated "+0.000R" on every well-populated Entry
   *  bucket (cumRegretR stays exactly 0, divided by n once n clears the floor) even though "regret" isn't
   *  a measured quantity for Entry at all. Stays 0 for every Entry aggregate ⇒ meanRegretR correctly null
   *  there; equals n for Direction (regretR always finite) ⇒ unchanged behavior there. See rateView. */
  regretTrackedN: number;
  cumCalibrationGapR: number;
  calibrationN: number; // count of rows with a non-null calibrationGapR — direction only
}

function emptyRateAggregate(): RateAggregate {
  return {
    n: 0,
    wins: 0,
    winTrackedN: 0,
    cumNetR: 0,
    netRTrackedN: 0,
    cumRegretR: 0,
    regretTrackedN: 0,
    cumCalibrationGapR: 0,
    calibrationN: 0,
  };
}

interface DirectionHorizonAggregate {
  n: number;
  effectiveN: number;
  lastBlockKey: number | null;
  perAction: Record<string, RateAggregate>;
}

interface EntryActionConfidenceAggregate extends RateAggregate {
  tier: EntryTier;
  action: FourBrainOutcomeEntryAction;
  confidence: EntryConfidence;
}

/** perLane / perSymbol rows now carry an explicit tier so Tier 1 (real) and Tier 2 (simulated) evidence
 *  for the SAME lane/symbol are never folded into one bucket (see module doc's "NEVER BLENDED"
 *  guarantee) — keyed internally as `${tier}|${id}`. */
interface EntryLaneAggregate extends RateAggregate {
  tier: EntryTier;
  laneId: string;
}
interface EntrySymbolAggregate extends RateAggregate {
  tier: EntryTier;
  symbolOrBasketId: string;
}

interface CycleMeta {
  lastRunAtIso: string | null;
  lastProcessed: number;
  lastError: string | null;
}

interface DirectionSectionState {
  records: DirectionOutcomeRecord[];
  perHorizon: Record<string, DirectionHorizonAggregate>;
  evaluatedCount: number;
  expiredUnresolvableCount: number;
  /** Current-cycle GAUGE (see module doc) — overwritten wholesale every reconciliation pass, never
   *  accumulated. Key: horizon. */
  currentInstrumentDataMissingByHorizon: Record<string, number>;
  processedDecisionIds: string[];
}

interface EntrySectionState {
  records: EntryOutcomeRecord[];
  perActionConfidence: Record<string, EntryActionConfidenceAggregate>;
  perLane: Record<string, EntryLaneAggregate>;
  perSymbol: Record<string, EntrySymbolAggregate>;
  /** Running per-tier calibration counters — a TRUE cumulative counter (like resolvedRealMatchCount /
   *  resolvedSimulatedCount) that survives `records` pruning past MAX_ENTRY_RECORDS, unlike deriving
   *  calibration from the bounded records array (which would silently stop growing once cumulative
   *  resolved Entry decisions exceed MAX_ENTRY_RECORDS while the coverage counters keep counting
   *  forever). Updated by recordEntryOutcome directly, never re-derived from `records`. */
  calibrationByTier: Record<EntryTier, RateAggregate>;
  resolvedRealMatchCount: number; // Tier 1 cumulative
  resolvedSimulatedCount: number; // Tier 2 cumulative
  expiredUnresolvableCount: number;
  /** Current-cycle GAUGE — see DirectionSectionState.currentInstrumentDataMissingByHorizon. */
  currentInstrumentDataMissing: number;
  /** Latest reconciliation-cycle Tier-1 join diagnostics. This is a gauge, not a cumulative counter. */
  tier1Diagnostics: EntryBrainTier1Diagnostics | null;
  processedDecisionIds: string[];
  /** Tier 1 "one close claimed once" cross-cycle memory (FIFO, bounded) — see
   *  DirectionEntryOutcomeStore.hasClaimedTier1CloseKey. */
  claimedTier1CloseKeys: string[];
}

interface DirectionEntryOutcomeState {
  version: number;
  direction: DirectionSectionState;
  entry: EntrySectionState;
  cycleMeta: CycleMeta;
}

function emptyDirectionHorizonAggregate(): DirectionHorizonAggregate {
  const perAction: Record<string, RateAggregate> = {};
  for (const a of DIRECTION_ACTIONS) perAction[a] = emptyRateAggregate();
  return { n: 0, effectiveN: 0, lastBlockKey: null, perAction };
}

function emptyDirectionSection(): DirectionSectionState {
  const perHorizon: Record<string, DirectionHorizonAggregate> = {};
  for (const h of DIRECTION_HORIZONS) perHorizon[h] = emptyDirectionHorizonAggregate();
  return {
    records: [],
    perHorizon,
    evaluatedCount: 0,
    expiredUnresolvableCount: 0,
    currentInstrumentDataMissingByHorizon: {},
    processedDecisionIds: [],
  };
}

function emptyCalibrationByTier(): Record<EntryTier, RateAggregate> {
  return { TIER1_REALIZED: emptyRateAggregate(), TIER2_SIMULATED: emptyRateAggregate() };
}

function emptyEntrySection(): EntrySectionState {
  return {
    records: [],
    perActionConfidence: {},
    perLane: {},
    perSymbol: {},
    calibrationByTier: emptyCalibrationByTier(),
    resolvedRealMatchCount: 0,
    resolvedSimulatedCount: 0,
    expiredUnresolvableCount: 0,
    currentInstrumentDataMissing: 0,
    tier1Diagnostics: null,
    processedDecisionIds: [],
    claimedTier1CloseKeys: [],
  };
}

function emptyState(): DirectionEntryOutcomeState {
  return {
    version: 1,
    direction: emptyDirectionSection(),
    entry: emptyEntrySection(),
    cycleMeta: { lastRunAtIso: null, lastProcessed: 0, lastError: null },
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function nonNegInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.floor(finiteOr(value, fallback)));
}

function sanitizeTier1Diagnostics(raw: unknown): EntryBrainTier1Diagnostics | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<EntryBrainTier1Diagnostics>;
  const reasons = (source.rejectionReasons ?? {}) as Partial<EntryBrainTier1Diagnostics["rejectionReasons"]>;
  return {
    pendingRows: nonNegInt(source.pendingRows),
    validPendingRows: nonNegInt(source.validPendingRows),
    closedPaths: nonNegInt(source.closedPaths),
    matchableClosedPaths: nonNegInt(source.matchableClosedPaths),
    unusableClosedPaths: nonNegInt(source.unusableClosedPaths),
    matchedRows: nonNegInt(source.matchedRows),
    namespaceNormalizedMatches: nonNegInt(source.namespaceNormalizedMatches),
    rejectedRows: nonNegInt(source.rejectedRows),
    rejectionReasons: {
      MISSING_IDENTITY: nonNegInt(reasons.MISSING_IDENTITY),
      NO_EXACT_LANE_SYMBOL_SIDE_CLOSE: nonNegInt(reasons.NO_EXACT_LANE_SYMBOL_SIDE_CLOSE),
      DECISION_AFTER_OPEN: nonNegInt(reasons.DECISION_AFTER_OPEN),
      OUTSIDE_TTL: nonNegInt(reasons.OUTSIDE_TTL),
      COMPETING_DECISION: nonNegInt(reasons.COMPETING_DECISION),
    },
  };
}

function sanitizeRateAggregate(raw: unknown): RateAggregate {
  const c = (raw ?? {}) as Partial<RateAggregate>;
  return {
    n: nonNegInt(c.n),
    wins: nonNegInt(c.wins),
    // Fallback to n for pre-existing persisted state written before winTrackedN existed: those rows
    // always supplied a real win (direction/entry perAction never passed win:null before this fix), so
    // n is the correct historical denominator; new state always has its own explicit winTrackedN.
    winTrackedN: c.winTrackedN === undefined ? nonNegInt(c.n) : nonNegInt(c.winTrackedN),
    cumNetR: finiteOr(c.cumNetR, 0),
    // Fallback to n for pre-existing persisted state written before netRTrackedN existed: this is a
    // known-imperfect migration (some of those historical rows may in fact have had a null netR — see
    // RateAggregate.netRTrackedN's own doc — but which ones is not recoverable from persisted cumNetR/n
    // alone), same best-effort idiom as winTrackedN above. New state always has its own explicit
    // netRTrackedN, tracked correctly going forward.
    netRTrackedN: c.netRTrackedN === undefined ? nonNegInt(c.n) : nonNegInt(c.netRTrackedN),
    cumRegretR: finiteOr(c.cumRegretR, 0),
    // Deliberately NOT defaulted to n on migration (unlike winTrackedN/netRTrackedN above): a pre-existing
    // Entry aggregate's cumRegretR is always exactly 0 (regretR was always passed null there), so falling
    // back to n would reproduce 0/n=0 — the very fabricated "regret +0.000R" this fix exists to remove.
    // Falling back to 0 costs a pre-existing Direction aggregate one cycle of (harmless) null instead of
    // an already-correct 0.000R, until it next books a fresh row and stamps a real regretTrackedN — a fair
    // trade for permanently fixing Entry. New state always has its own explicit regretTrackedN.
    regretTrackedN: nonNegInt(c.regretTrackedN),
    cumCalibrationGapR: finiteOr(c.cumCalibrationGapR, 0),
    calibrationN: nonNegInt(c.calibrationN),
  };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Report view of one rate aggregate, gated by DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE. `sampleSizeForGate`
 *  lets Direction gate on the horizon's shared effectiveN instead of the bucket's own raw n (see module
 *  doc); defaults to the aggregate's own n. */
interface RateView {
  n: number;
  insufficientData: boolean;
  winRate: number | null;
  meanNetR: number | null;
  cumNetR: number;
  meanRegretR: number | null;
  meanCalibrationGapR: number | null;
}
function rateView(agg: RateAggregate, sampleSizeForGate?: number): RateView {
  const gateSize = sampleSizeForGate ?? agg.n;
  const insufficientData = gateSize < DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE;
  return {
    n: agg.n,
    insufficientData,
    // Gated on winTrackedN (count of rows that actually supplied a win), NOT agg.n: a bucket whose rows
    // never carry a meaningful win concept (e.g. a calibration row) must report null, never a fabricated
    // "0% win rate" from wins/n when wins never had a chance to increment. See RateAggregate.winTrackedN.
    winRate: !insufficientData && agg.winTrackedN > 0 ? round4(agg.wins / agg.winTrackedN) : null,
    // Gated on netRTrackedN (count of rows that actually supplied a non-null netR), NOT agg.n: Entry Tier
    // 2's SKIP action (and an untriggered WAIT_PULLBACK/WAIT_BREAKOUT/WAIT_CONFIRMATION) always/sometimes
    // resolves with netR: null (NOT_ENTERED — see entry-exit-counterfactual.ts). Dividing by n there would
    // report a fabricated "+0.000R" for a bucket with zero real observations, or dilute a triggered
    // subset's true mean toward zero with rows that never had any R to contribute. See
    // RateAggregate.netRTrackedN.
    meanNetR: !insufficientData && agg.netRTrackedN > 0 ? round4(agg.cumNetR / agg.netRTrackedN) : null,
    cumNetR: round4(agg.cumNetR),
    // Gated on regretTrackedN (direction-only; always 0 for Entry, since regretR is always passed null for
    // Entry — see RateAggregate.regretTrackedN) — NOT agg.n: without this gate, cumRegretR/n would report
    // a fabricated "+0.000R" on every well-populated Entry bucket for a concept ("regret") Entry doesn't
    // even track.
    meanRegretR: !insufficientData && agg.regretTrackedN > 0 ? round4(agg.cumRegretR / agg.regretTrackedN) : null,
    meanCalibrationGapR: !insufficientData && agg.calibrationN > 0 ? round4(agg.cumCalibrationGapR / agg.calibrationN) : null,
  };
}

function addToRateAggregate(agg: RateAggregate, win: 0 | 1 | null, netR: number | null, regretR: number | null, calibrationGapR: number | null): void {
  agg.n += 1;
  if (win !== null) {
    agg.winTrackedN += 1;
    if (win === 1) agg.wins += 1;
  }
  if (netR != null && Number.isFinite(netR)) {
    agg.cumNetR += netR;
    agg.netRTrackedN += 1;
  }
  if (regretR != null && Number.isFinite(regretR)) {
    agg.cumRegretR += regretR;
    agg.regretTrackedN += 1;
  }
  if (calibrationGapR != null && Number.isFinite(calibrationGapR)) {
    agg.cumCalibrationGapR += calibrationGapR;
    agg.calibrationN += 1;
  }
}

/** Non-overlapping horizon-window block key — identical formula to
 *  direction-brain-resolver.ts's computeDirectionEffectiveSampleSize (not imported: that function
 *  operates over a full array; this store needs the same single-key formula applied incrementally). */
function horizonBlockKey(asOfMs: number, horizonMs: number): number {
  return horizonMs > 0 ? Math.floor(asOfMs / horizonMs) : 0;
}

export class DirectionEntryOutcomeStore {
  private readonly file: string;
  private state: DirectionEntryOutcomeState;
  private directionProcessedSet: Set<string>;
  private entryProcessedSet: Set<string>;
  private claimedTier1CloseKeySet: Set<string>;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "direction-entry-outcomes.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    this.directionProcessedSet = new Set(this.state.direction.processedDecisionIds);
    this.entryProcessedSet = new Set(this.state.entry.processedDecisionIds);
    this.claimedTier1CloseKeySet = new Set(this.state.entry.claimedTier1CloseKeys);
  }

  get path(): string {
    return this.file;
  }

  /** Visible for tests. */
  getState(): DirectionEntryOutcomeState {
    return this.state;
  }

  hasProcessedDirection(decisionId: string): boolean {
    return this.directionProcessedSet.has(decisionId);
  }
  hasProcessedEntry(decisionId: string): boolean {
    return this.entryProcessedSet.has(decisionId);
  }

  /** True once a Tier 1 real close (keyed by PositionPath.key) has already been joined to a decision —
   *  callers (the reconciler) must exclude an already-claimed close from a fresh Tier 1 match attempt,
   *  since position-path-recorder.ts's listClosedPositionPaths() is a rolling window that keeps
   *  re-offering the same close across many cycles and the resolver's own consumedDecisionIds set has
   *  no memory beyond a single call. See EntryOutcomeRecord.matchedCloseKey. */
  hasClaimedTier1CloseKey(closeKey: string): boolean {
    return this.claimedTier1CloseKeySet.has(closeKey);
  }

  private _load(): DirectionEntryOutcomeState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (!parsed || typeof parsed !== "object") return emptyState();
      const raw = parsed as Partial<DirectionEntryOutcomeState>;

      // ── direction ──
      const rd = (raw.direction ?? {}) as Partial<DirectionSectionState>;
      const perHorizon: Record<string, DirectionHorizonAggregate> = {};
      for (const h of DIRECTION_HORIZONS) {
        const src = (rd.perHorizon ?? {})[h] as Partial<DirectionHorizonAggregate> | undefined;
        const perAction: Record<string, RateAggregate> = {};
        for (const a of DIRECTION_ACTIONS) perAction[a] = sanitizeRateAggregate((src?.perAction ?? {})[a]);
        perHorizon[h] = {
          n: nonNegInt(src?.n),
          effectiveN: nonNegInt(src?.effectiveN),
          lastBlockKey: typeof src?.lastBlockKey === "number" && Number.isFinite(src.lastBlockKey) ? src.lastBlockKey : null,
          perAction,
        };
      }
      const directionRecords = (Array.isArray(rd.records) ? rd.records : [])
        .filter((r): r is DirectionOutcomeRecord => {
          if (!r || typeof r !== "object") return false;
          const rec = r as Partial<DirectionOutcomeRecord>;
          return typeof rec.decisionId === "string" && (rec.status === "RESOLVED" || rec.status === "EXPIRED_UNRESOLVABLE");
        })
        .slice(-MAX_DIRECTION_RECORDS);
      const currentInstrumentDataMissingByHorizon: Record<string, number> = {};
      for (const [k, v] of Object.entries(rd.currentInstrumentDataMissingByHorizon ?? {})) {
        if (Number.isFinite(v)) currentInstrumentDataMissingByHorizon[k] = nonNegInt(v);
      }

      // ── entry ──
      const re = (raw.entry ?? {}) as Partial<EntrySectionState>;
      const isEntryTier = (t: unknown): t is EntryTier => t === "TIER1_REALIZED" || t === "TIER2_SIMULATED";
      const perActionConfidence: Record<string, EntryActionConfidenceAggregate> = {};
      for (const [k, v] of Object.entries(re.perActionConfidence ?? {})) {
        const c = (v ?? {}) as Partial<EntryActionConfidenceAggregate>;
        if (!ENTRY_ACTIONS.includes(c.action as FourBrainOutcomeEntryAction)) continue;
        if (c.confidence !== "MEASURED" && c.confidence !== "EXPERIMENTAL_COST_OF_CAUTION") continue;
        // Pre-tier-split persisted state has no `tier` field — such a row predates this fix and could
        // only have existed under the (undiscovered) blended scheme, so it cannot be honestly assigned
        // to either tier; drop it rather than guess. Fresh state (post-fix) always carries a real tier.
        if (!isEntryTier(c.tier)) continue;
        perActionConfidence[k] = {
          ...sanitizeRateAggregate(c),
          tier: c.tier,
          action: c.action as FourBrainOutcomeEntryAction,
          confidence: c.confidence,
        };
      }
      const perLane: Record<string, EntryLaneAggregate> = {};
      for (const [k, v] of Object.entries(re.perLane ?? {})) {
        const c = (v ?? {}) as Partial<EntryLaneAggregate>;
        if (!isEntryTier(c.tier)) continue;
        if (typeof c.laneId !== "string" || c.laneId.length === 0) continue;
        perLane[k] = { ...sanitizeRateAggregate(c), tier: c.tier, laneId: c.laneId };
      }
      const perSymbol: Record<string, EntrySymbolAggregate> = {};
      for (const [k, v] of Object.entries(re.perSymbol ?? {})) {
        const c = (v ?? {}) as Partial<EntrySymbolAggregate>;
        if (!isEntryTier(c.tier)) continue;
        if (typeof c.symbolOrBasketId !== "string" || c.symbolOrBasketId.length === 0) continue;
        perSymbol[k] = { ...sanitizeRateAggregate(c), tier: c.tier, symbolOrBasketId: c.symbolOrBasketId };
      }
      const calibrationByTier = emptyCalibrationByTier();
      const rawCalibrationByTier = (re.calibrationByTier ?? {}) as Partial<Record<EntryTier, unknown>>;
      for (const tier of ["TIER1_REALIZED", "TIER2_SIMULATED"] as const) {
        calibrationByTier[tier] = sanitizeRateAggregate(rawCalibrationByTier[tier]);
      }
      const entryRecords = (Array.isArray(re.records) ? re.records : [])
        .filter((r): r is EntryOutcomeRecord => {
          if (!r || typeof r !== "object") return false;
          const rec = r as Partial<EntryOutcomeRecord>;
          return typeof rec.decisionId === "string" && (rec.status === "RESOLVED" || rec.status === "EXPIRED_UNRESOLVABLE");
        })
        .slice(-MAX_ENTRY_RECORDS)
        // backfill for pre-fix persisted rows lacking the field (typeof undefined, not a real string key)
        .map((r) => ({ ...r, matchedCloseKey: typeof r.matchedCloseKey === "string" ? r.matchedCloseKey : null }));

      // Claimed Tier-1 close keys: union of the persisted FIFO list AND any matchedCloseKey still visible
      // in the (possibly truncated) records array — belt-and-suspenders so a close already joined to a
      // decision can never be re-claimed after a reload, even if the two lists ever drifted apart.
      const claimedFromRecords = entryRecords
        .filter((r) => r.tier === "TIER1_REALIZED" && typeof r.matchedCloseKey === "string" && r.matchedCloseKey.length > 0)
        .map((r) => r.matchedCloseKey as string);
      const claimedFromPersisted = Array.isArray(re.claimedTier1CloseKeys)
        ? re.claimedTier1CloseKeys.filter((k): k is string => typeof k === "string")
        : [];
      const claimedTier1CloseKeys = Array.from(new Set([...claimedFromPersisted, ...claimedFromRecords])).slice(
        -MAX_CLAIMED_TIER1_CLOSE_KEYS,
      );

      const rawMeta = (raw.cycleMeta ?? {}) as Partial<CycleMeta>;
      return {
        version: 1,
        direction: {
          records: directionRecords,
          perHorizon,
          evaluatedCount: nonNegInt(rd.evaluatedCount),
          expiredUnresolvableCount: nonNegInt(rd.expiredUnresolvableCount),
          currentInstrumentDataMissingByHorizon,
          processedDecisionIds: Array.isArray(rd.processedDecisionIds)
            ? rd.processedDecisionIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_DIRECTION_IDS)
            : [],
        },
        entry: {
          records: entryRecords,
          perActionConfidence,
          perLane,
          perSymbol,
          calibrationByTier,
          resolvedRealMatchCount: nonNegInt(re.resolvedRealMatchCount),
          resolvedSimulatedCount: nonNegInt(re.resolvedSimulatedCount),
          expiredUnresolvableCount: nonNegInt(re.expiredUnresolvableCount),
          currentInstrumentDataMissing: nonNegInt(re.currentInstrumentDataMissing),
          tier1Diagnostics: sanitizeTier1Diagnostics(re.tier1Diagnostics),
          processedDecisionIds: Array.isArray(re.processedDecisionIds)
            ? re.processedDecisionIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_ENTRY_IDS)
            : [],
          claimedTier1CloseKeys,
        },
        cycleMeta: {
          lastRunAtIso: typeof rawMeta.lastRunAtIso === "string" ? rawMeta.lastRunAtIso : null,
          lastProcessed: nonNegInt(rawMeta.lastProcessed),
          lastError: typeof rawMeta.lastError === "string" ? rawMeta.lastError : null,
        },
      };
    } catch {
      // corrupt/partial — restart from empty; this store is bookkeeping-only, never a trading path
    }
    return emptyState();
  }

  private _save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // persistence failures must never break the caller
    }
  }

  /** Persist now (for batch writers using deferSave). Never throws. */
  flush(): void {
    this._save();
  }

  // ── Direction ────────────────────────────────────────────────────────────────

  /** Book one terminal Direction outcome. Idempotent per decisionId (silent no-op on re-offer, e.g. a
   *  crash-and-restart mid-cycle re-processing the same due row). Returns true only when actually
   *  booked THIS call. horizonMs is needed for the effective-sample-size block key. */
  recordDirectionOutcome(record: DirectionOutcomeRecord, horizonMs: number, opts?: { deferSave?: boolean }): boolean {
    try {
      if (this.directionProcessedSet.has(record.decisionId)) return false;
      if (!DIRECTION_HORIZONS.includes(record.horizon) || !DIRECTION_ACTIONS.includes(record.action)) return false;

      const d = this.state.direction;
      d.records.push(record);
      if (d.records.length > MAX_DIRECTION_RECORDS) d.records = d.records.slice(-MAX_DIRECTION_RECORDS);

      if (record.status === "RESOLVED") {
        d.evaluatedCount += 1;
        const horizonAgg = d.perHorizon[record.horizon] ?? emptyDirectionHorizonAggregate();
        horizonAgg.n += 1;
        const blockKey = horizonBlockKey(record.asOfMs, horizonMs);
        if (horizonAgg.lastBlockKey === null || blockKey !== horizonAgg.lastBlockKey) {
          horizonAgg.effectiveN += 1;
          horizonAgg.lastBlockKey = blockKey;
        }
        const actionAgg = horizonAgg.perAction[record.action] ?? emptyRateAggregate();
        addToRateAggregate(actionAgg, record.win, record.chosenNetR, record.regretR, record.calibrationGapR);
        horizonAgg.perAction[record.action] = actionAgg;
        d.perHorizon[record.horizon] = horizonAgg;
      } else {
        d.expiredUnresolvableCount += 1;
      }

      this.directionProcessedSet.add(record.decisionId);
      d.processedDecisionIds.push(record.decisionId);
      if (d.processedDecisionIds.length > MAX_PROCESSED_DIRECTION_IDS) {
        const evicted = d.processedDecisionIds.splice(0, d.processedDecisionIds.length - MAX_PROCESSED_DIRECTION_IDS);
        for (const id of evicted) this.directionProcessedSet.delete(id);
      }

      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false;
    }
  }

  /** Overwrite the current-cycle Direction instrument-data-missing GAUGE (see module doc — never
   *  accumulated). Callers should pass a full replacement map (missing horizons default to 0). */
  setCurrentDirectionInstrumentDataMissing(byHorizon: Partial<Record<FourBrainOutcomeHorizon, number>>, opts?: { deferSave?: boolean }): void {
    try {
      const next: Record<string, number> = {};
      for (const h of DIRECTION_HORIZONS) next[h] = nonNegInt(byHorizon[h] ?? 0);
      this.state.direction.currentInstrumentDataMissingByHorizon = next;
      if (!opts?.deferSave) this._save();
    } catch {
      /* gauge bookkeeping never throws */
    }
  }

  // ── Entry ────────────────────────────────────────────────────────────────────

  /** Book one terminal Entry outcome. Idempotent per decisionId. Returns true only when actually
   *  booked THIS call. */
  recordEntryOutcome(record: EntryOutcomeRecord, opts?: { deferSave?: boolean }): boolean {
    try {
      if (this.entryProcessedSet.has(record.decisionId)) return false;

      const e = this.state.entry;
      e.records.push(record);
      if (e.records.length > MAX_ENTRY_RECORDS) e.records = e.records.slice(-MAX_ENTRY_RECORDS);

      if (record.status === "RESOLVED") {
        // A RESOLVED row always carries a real tier per every current call site (direction-entry-
        // reconciler.ts) — defensive-only guard; a tier-less RESOLVED row is counted as resolved
        // (never miscounted as expired-unresolvable) but, honestly, cannot be attributed to either
        // tier's buckets since doing so would fabricate which tier produced it.
        if (record.tier === "TIER1_REALIZED") e.resolvedRealMatchCount += 1;
        else if (record.tier === "TIER2_SIMULATED") e.resolvedSimulatedCount += 1;
      }
      if (record.status === "RESOLVED" && (record.tier === "TIER1_REALIZED" || record.tier === "TIER2_SIMULATED")) {
        const tier = record.tier;

        const win =
          record.realizedNetR != null && Number.isFinite(record.realizedNetR) ? (record.realizedNetR > 0 ? 1 : 0) : null;

        // perAction / perLane / perSymbol are keyed WITH the tier so Tier 1 (real) and Tier 2 (simulated)
        // evidence for the same action/lane/symbol are never folded into one bucket (see module doc).
        const actionKey = `${tier}|${record.action}|${record.confidence}`;
        const actionAgg =
          e.perActionConfidence[actionKey] ?? { ...emptyRateAggregate(), tier, action: record.action, confidence: record.confidence };
        addToRateAggregate(actionAgg, win, record.realizedNetR, null, null);
        e.perActionConfidence[actionKey] = actionAgg;

        const rawLaneKey = record.laneId ? `${tier}|${record.laneId}` : `${tier}|${OVERFLOW_ID}`;
        const laneKey =
          record.laneId && (rawLaneKey in e.perLane || Object.keys(e.perLane).length < MAX_LANES) ? rawLaneKey : `${tier}|${OVERFLOW_ID}`;
        const laneAgg = e.perLane[laneKey] ?? { ...emptyRateAggregate(), tier, laneId: record.laneId ?? OVERFLOW_ID };
        addToRateAggregate(laneAgg, win, record.realizedNetR, null, null);
        e.perLane[laneKey] = laneAgg;

        const rawSymKey = record.symbolOrBasketId ? `${tier}|${record.symbolOrBasketId}` : `${tier}|${OVERFLOW_ID}`;
        const symKey =
          record.symbolOrBasketId && (rawSymKey in e.perSymbol || Object.keys(e.perSymbol).length < MAX_SYMBOLS)
            ? rawSymKey
            : `${tier}|${OVERFLOW_ID}`;
        const symAgg = e.perSymbol[symKey] ?? { ...emptyRateAggregate(), tier, symbolOrBasketId: record.symbolOrBasketId ?? OVERFLOW_ID };
        addToRateAggregate(symAgg, win, record.realizedNetR, null, null);
        e.perSymbol[symKey] = symAgg;

        // Running per-tier calibration counter — a TRUE cumulative counter, never derived from the
        // bounded `records` array (see EntrySectionState.calibrationByTier doc). win is null: "win" is
        // not a meaningful concept for a calibration row (it reports an expected-vs-realized gap, not a
        // hit rate) — never fabricate a 0% win rate for it (see RateAggregate.winTrackedN / rateView).
        const calibrationGapR =
          record.expectedNetR != null && record.realizedNetR != null && Number.isFinite(record.expectedNetR) && Number.isFinite(record.realizedNetR)
            ? record.expectedNetR - record.realizedNetR
            : null;
        addToRateAggregate(e.calibrationByTier[tier], null, record.realizedNetR, null, calibrationGapR);

        // Tier 1 "one close claimed once" cross-cycle memory (see hasClaimedTier1CloseKey doc).
        if (tier === "TIER1_REALIZED" && typeof record.matchedCloseKey === "string" && record.matchedCloseKey.length > 0) {
          if (!this.claimedTier1CloseKeySet.has(record.matchedCloseKey)) {
            this.claimedTier1CloseKeySet.add(record.matchedCloseKey);
            e.claimedTier1CloseKeys.push(record.matchedCloseKey);
            if (e.claimedTier1CloseKeys.length > MAX_CLAIMED_TIER1_CLOSE_KEYS) {
              const evicted = e.claimedTier1CloseKeys.splice(0, e.claimedTier1CloseKeys.length - MAX_CLAIMED_TIER1_CLOSE_KEYS);
              for (const key of evicted) this.claimedTier1CloseKeySet.delete(key);
            }
          }
        }
      } else if (record.status !== "RESOLVED") {
        e.expiredUnresolvableCount += 1;
      }

      this.entryProcessedSet.add(record.decisionId);
      e.processedDecisionIds.push(record.decisionId);
      if (e.processedDecisionIds.length > MAX_PROCESSED_ENTRY_IDS) {
        const evicted = e.processedDecisionIds.splice(0, e.processedDecisionIds.length - MAX_PROCESSED_ENTRY_IDS);
        for (const id of evicted) this.entryProcessedSet.delete(id);
      }

      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false;
    }
  }

  /** Overwrite the current-cycle Entry instrument-data-missing GAUGE (see module doc). */
  setCurrentEntryInstrumentDataMissing(count: number, opts?: { deferSave?: boolean }): void {
    try {
      this.state.entry.currentInstrumentDataMissing = nonNegInt(count);
      if (!opts?.deferSave) this._save();
    } catch {
      /* gauge bookkeeping never throws */
    }
  }

  setTier1Diagnostics(diagnostics: EntryBrainTier1Diagnostics, opts?: { deferSave?: boolean }): void {
    try {
      this.state.entry.tier1Diagnostics = sanitizeTier1Diagnostics(diagnostics);
      if (!opts?.deferSave) this._save();
    } catch {
      /* report-only diagnostics never affect reconciliation */
    }
  }

  recordCycle(lastRunAtIso: string, processed: number, error: string | null, opts?: { deferSave?: boolean }): void {
    this.state.cycleMeta = { lastRunAtIso, lastProcessed: Math.max(0, Math.floor(processed)), lastError: error };
    if (!opts?.deferSave) this._save();
  }

  buildReport(): DirectionEntryOutcomeReport {
    return buildDirectionEntryOutcomeReport(this.state);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface DirectionEntryOutcomeReport {
  generatedAt: string;
  reportOnly: true;
  direction: {
    coverage: {
      pending: number;
      evaluated: number;
      instrumentDataMissing: number;
      expiredUnresolvable: number;
      perHorizon: Array<{
        horizon: FourBrainOutcomeHorizon;
        pending: number;
        evaluated: number;
        instrumentDataMissing: number;
        expiredUnresolvable: number;
      }>;
      note: string;
    };
    perHorizon: Array<{
      horizon: FourBrainOutcomeHorizon;
      n: number;
      effectiveN: number;
      insufficientEffectiveSampleSize: boolean;
      perAction: Array<{ action: FourBrainOutcomeDirectionAction } & RateView>;
    }>;
    calibration: Array<{ horizon: FourBrainOutcomeHorizon; action: "LONG" | "SHORT" } & RateView>;
    recent: DirectionOutcomeRecord[];
  };
  entry: {
    coverage: {
      pending: number;
      resolvedRealMatch: number;
      resolvedSimulated: number;
      instrumentDataMissing: number;
      expiredUnresolvable: number;
      note: string;
    };
    tier1Diagnostics: EntryBrainTier1Diagnostics | null;
    /** tier-scoped: Tier 1 (real) and Tier 2 (simulated) rows for the SAME action/confidence are always
     *  two separate rows here, never blended into one bucket. */
    perAction: Array<{ tier: EntryTier; action: FourBrainOutcomeEntryAction; confidence: EntryConfidence } & RateView>;
    calibration: Array<{ tier: EntryTier } & RateView>;
    /** tier-scoped: a lane/symbol that has both real Tier 1 fills and Tier 2 simulations appears as TWO
     *  rows (one per tier), never one blended row. */
    perLane: Array<{ tier: EntryTier; laneId: string } & RateView>;
    perSymbol: Array<{ tier: EntryTier; symbolOrBasketId: string } & RateView>;
    recent: EntryOutcomeRecord[];
  };
  cycleMeta: CycleMeta;
}

/** Pure builder — takes the store's persisted state PLUS live pending counts from the ledger (pending
 *  is inherently a live number: it is whatever is STILL in the ledger right now, not something this
 *  store itself tracks, since a pending row hasn't been booked here yet). Exported for tests. */
export function buildDirectionEntryOutcomeReport(
  state: DirectionEntryOutcomeState,
  pendingCounts?: { directionByHorizon?: Partial<Record<FourBrainOutcomeHorizon, number>>; entry?: number },
): DirectionEntryOutcomeReport {
  const d = state.direction;
  const e = state.entry;
  const pendingDirByHorizon = pendingCounts?.directionByHorizon ?? {};
  const pendingEntry = pendingCounts?.entry ?? 0;

  // ── Direction ──
  const perHorizonCoverage = DIRECTION_HORIZONS.map((horizon) => {
    const agg = d.perHorizon[horizon] ?? emptyDirectionHorizonAggregate();
    const evaluated = Object.values(agg.perAction).reduce((s, a) => s + a.n, 0);
    return {
      horizon,
      pending: nonNegInt(pendingDirByHorizon[horizon] ?? 0),
      evaluated,
      instrumentDataMissing: nonNegInt(d.currentInstrumentDataMissingByHorizon[horizon] ?? 0),
      expiredUnresolvable: 0, // per-horizon expired split not separately tracked; see section total below
    };
  });
  const totalPendingDir = DIRECTION_HORIZONS.reduce((s, h) => s + nonNegInt(pendingDirByHorizon[h] ?? 0), 0);
  const totalMissingDir = DIRECTION_HORIZONS.reduce((s, h) => s + nonNegInt(d.currentInstrumentDataMissingByHorizon[h] ?? 0), 0);

  // Gate size = min(bucket's OWN n, the horizon's shared effectiveN). Gating on effectiveN alone (the
  // pre-fix behavior) lets a bucket with as few as n=1 of its OWN observations report insufficientData:
  // false the moment the horizon's COMBINED effective sample size crosses the floor — e.g. 19 LONG + 1
  // SHORT resolution would show the n=1 SHORT bucket as a "precise" 100% win rate / naked 5.0 mean R,
  // exactly the misleadingly-precise percentage this module's own INSUFFICIENT_DATA floor doc says must
  // never happen. Requiring the bucket's own n to ALSO clear the floor (via Math.min) keeps the
  // overlap-correction intent (effectiveN still gates the overall horizon) while never letting a
  // practically-unobserved action/horizon-pair masquerade as reliable.
  const directionPerHorizon = DIRECTION_HORIZONS.map((horizon) => {
    const agg = d.perHorizon[horizon] ?? emptyDirectionHorizonAggregate();
    const insufficientEffectiveSampleSize = agg.effectiveN < DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE;
    return {
      horizon,
      n: agg.n,
      effectiveN: agg.effectiveN,
      insufficientEffectiveSampleSize,
      perAction: DIRECTION_ACTIONS.map((action) => {
        const bucketAgg = agg.perAction[action] ?? emptyRateAggregate();
        return { action, ...rateView(bucketAgg, Math.min(bucketAgg.n, agg.effectiveN)) };
      }),
    };
  });

  const calibration: DirectionEntryOutcomeReport["direction"]["calibration"] = [];
  for (const horizon of DIRECTION_HORIZONS) {
    const agg = d.perHorizon[horizon] ?? emptyDirectionHorizonAggregate();
    for (const action of ["LONG", "SHORT"] as const) {
      const bucketAgg = agg.perAction[action] ?? emptyRateAggregate();
      calibration.push({ horizon, action, ...rateView(bucketAgg, Math.min(bucketAgg.n, agg.effectiveN)) });
    }
  }

  const directionNote =
    d.evaluatedCount + d.expiredUnresolvableCount === 0
      ? "No Direction decisions resolved yet."
      : `${d.evaluatedCount} evaluated, ${d.expiredUnresolvableCount} expired unresolvable across all horizons (cumulative).`;

  // ── Entry ──
  // Every (tier, action, confidence) combo is emitted, even n=0 (mirrors Direction's always-emit-4-
  // actions shape) — a reader must be able to see "this combo has never been observed" as an honest 0,
  // not a missing row that looks like an oversight. tier is included so Tier 1 (real) and Tier 2
  // (simulated) evidence for the SAME action/confidence are always two separate rows, never one blended
  // bucket (see module doc's "NEVER BLENDED" guarantee).
  const perAction: DirectionEntryOutcomeReport["entry"]["perAction"] = [];
  for (const tier of ["TIER1_REALIZED", "TIER2_SIMULATED"] as const) {
    for (const action of ENTRY_ACTIONS) {
      for (const confidence of ["MEASURED", "EXPERIMENTAL_COST_OF_CAUTION"] as const) {
        const key = `${tier}|${action}|${confidence}`;
        const agg = e.perActionConfidence[key];
        perAction.push({ tier, action, confidence, ...rateView(agg ?? emptyRateAggregate()) });
      }
    }
  }

  // Tier split calibration — a TRUE running counter (calibrationByTier), never re-derived from the
  // bounded `records` array (see EntrySectionState.calibrationByTier doc — deriving from `records` would
  // silently stop growing once cumulative resolved Entry decisions exceed MAX_ENTRY_RECORDS while
  // resolvedRealMatchCount/resolvedSimulatedCount keep counting forever, making the two diverge).
  const entryCalibration: DirectionEntryOutcomeReport["entry"]["calibration"] = [
    { tier: "TIER1_REALIZED", ...rateView(e.calibrationByTier.TIER1_REALIZED) },
    { tier: "TIER2_SIMULATED", ...rateView(e.calibrationByTier.TIER2_SIMULATED) },
  ];

  const perLane = Object.values(e.perLane)
    .map((agg) => ({ tier: agg.tier, laneId: agg.laneId, ...rateView(agg) }))
    .sort((a, b) => b.n - a.n);
  const perSymbol = Object.values(e.perSymbol)
    .map((agg) => ({ tier: agg.tier, symbolOrBasketId: agg.symbolOrBasketId, ...rateView(agg) }))
    .sort((a, b) => b.n - a.n);

  const entryNote =
    e.resolvedRealMatchCount + e.resolvedSimulatedCount + e.expiredUnresolvableCount === 0
      ? "No Entry decisions resolved yet."
      : `${e.resolvedRealMatchCount} Tier-1 real-match, ${e.resolvedSimulatedCount} Tier-2 simulated, ${e.expiredUnresolvableCount} expired unresolvable (cumulative). Tier 1 and Tier 2 are never blended.`;

  return {
    generatedAt: new Date().toISOString(),
    reportOnly: true,
    direction: {
      coverage: {
        pending: totalPendingDir,
        evaluated: d.evaluatedCount,
        instrumentDataMissing: totalMissingDir,
        expiredUnresolvable: d.expiredUnresolvableCount,
        perHorizon: perHorizonCoverage,
        note: directionNote,
      },
      perHorizon: directionPerHorizon,
      calibration,
      recent: d.records.slice(-RECENT_ROWS),
    },
    entry: {
      coverage: {
        pending: pendingEntry,
        resolvedRealMatch: e.resolvedRealMatchCount,
        resolvedSimulated: e.resolvedSimulatedCount,
        instrumentDataMissing: e.currentInstrumentDataMissing,
        expiredUnresolvable: e.expiredUnresolvableCount,
        note: entryNote,
      },
      tier1Diagnostics: e.tier1Diagnostics,
      perAction,
      calibration: entryCalibration,
      perLane,
      perSymbol,
      recent: e.records.slice(-RECENT_ROWS),
    },
    cycleMeta: { ...state.cycleMeta },
  };
}

let singleton: DirectionEntryOutcomeStore | null = null;
export function getDirectionEntryOutcomeStore(dataDir = "data"): DirectionEntryOutcomeStore {
  if (!singleton) singleton = new DirectionEntryOutcomeStore(dataDir);
  return singleton;
}
export function _resetDirectionEntryOutcomeStoreForTests(): void {
  singleton = null;
}

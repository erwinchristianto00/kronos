/**
 * EXIT BRAIN shadow scorer — bounded persisted store + cycle (2026-07-21, REPORT-ONLY).
 *
 * Runs exit-brain-policy.ts's counterfactual over every NEWLY-RESOLVED trade exactly once (dedup
 * ledger) and accumulates policy-vs-actual aggregates. Nothing here can affect trading: the cycle
 * is fail-open (never throws to its caller), the store is its own isolated JSON file, and the
 * policy itself only ever scores recorded history.
 *
 * ── WHAT PATH DATA ACTUALLY EXISTS ON DISK (2026-07-21 inventory — the coverage answer) ─────────
 * NO store in this codebase persists a dense per-tick R path for any trade. What exists:
 *   1. LiveIntent (data/live-execution.json, REAL money): maxFavorableR/maxAdverseR running peaks
 *      WITHOUT timestamps + open/close → 2 usable path points. Worst source.
 *   2. PaperOrder (data/paper-execution-router.json): grossR/netR/closedAtMs only — NO MFE/MAE at
 *      all → open/close only.
 *   3. ShadowPosition variants (data/shadow-positions.json): mfeR/maeR WITH maxFavorableAt /
 *      maxAdverseAt timestamps + openedAt/closedAt → the richest recorded path: a 4-point
 *      skeleton (open, MFE-peak@ts, MAE-trough@ts, close). Chosen as the v1 reader source.
 *   4. Variant-matrix observations: simulated candle-walks (maxMfeR/minMaeR/peakAtMs + compact
 *      path summary, explicitly "no raw candle arrays") — and Task 1 (2026-07-10) already proved
 *      the candle-walk exit methodology diverges badly from real fills (−193%), so re-simulating
 *      dense paths from candles is NOT an honest substitute for recorded ones.
 * A 4-point skeleton cannot be walked honestly by a retrace policy (every intermediate retrace the
 * policy triggers on is missing — "policy never fired" would be a data artifact), so today's
 * trades will overwhelmingly classify INSUFFICIENT_PATH_DATA. That is the point: the report's
 * coverage block makes the "we must record denser paths before an exit policy can be shadow-
 * proven" finding impossible to miss, and the moment a dense recorder lands, this same cycle
 * starts scoring for real with zero changes (the reader interface already accepts dense ticks).
 *
 * Store idiom follows cortex-real-attribution.ts: compact JSON, atomic tmp+rename, bounded detail
 * records + running aggregates that survive pruning + bounded FIFO dedup ledger.
 *
 * ── EVIDENCE TIERS (2026-07-26) ─────────────────────────────────────────────────────────────────
 * Every scored trade is booked under exactly one ExitBrainEvidenceTier — MEASURED (a real recorded
 * path) or SIMULATED (a candle-walk reconstruction of a paper order, see paper-simulated-path-
 * store.ts). The two tiers keep completely independent aggregates and are NEVER blended into one
 * number, mirroring the Entry Brain's Tier 1 (realized) vs Tier 2 (simulated) discipline. Records
 * written before the tier split carry no tier and are MEASURED — which is what they are, since the
 * only readers that existed then produced recorded real paths and recorded shadow-position outcomes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ShadowPosition } from "@dtc/shared";

import {
  DEFAULT_EXIT_BRAIN_PARAMS,
  evaluateExitBrainCounterfactual,
  type ExitBrainParams,
  type ExitBrainPathTick,
} from "./exit-brain-policy.js";
import {
  resolveFourBrainTestnetCohort,
  scopeExitTradeToFourBrainTestnetCohort,
  type FourBrainTestnetCohort,
} from "./four-brain-testnet-cohort.js";

/** Newest-N detail records kept on disk (aggregates keep counting past this). */
const MAX_RECORDS = 1500;
/** Dedup trade ids retained (FIFO). Sized well above MAX_RECORDS so pruned records cannot be
 *  re-booked for a long horizon; a re-offer after eviction is still harmless double-COUNTING
 *  risk only for aggregates, and resolved-trade ids stop being offered once their source records
 *  age out of the shadow store anyway. */
const MAX_PROCESSED_IDS = 8000;
/** perLane rows strictly bounded; overflow folds into OTHER (lane ids are a small finite set). */
const MAX_LANES = 200;
const OVERFLOW_LANE_ID = "OTHER";
/** Tick-count histogram keys are capped: counts above this bucket into "N+". */
const TICK_HISTOGRAM_MAX_KEY = 12;
/** Per-cycle work bound — a first run over a large backlog must not stall the shadow tick. */
const DEFAULT_MAX_TRADES_PER_CYCLE = 500;

// ── evidence tier ────────────────────────────────────────────────────────────

/**
 * WHICH KIND OF EVIDENCE a scored trade rests on. This is a PERMANENT schema discriminator, not a
 * migration flag — mirroring the Entry Brain's own Tier 1 (entry-brain-tier1-realized-resolver.ts,
 * MEASURED) vs Tier 2 (entry-brain-tier2-simulated-resolver.ts, EXPERIMENTAL_COST_OF_CAUTION)
 * discipline, which likewise keeps two independent aggregates and never sums them.
 *
 *  - MEASURED  : the path points came from something that actually happened and was RECORDED —
 *                position-path-recorder.ts's real per-tick R samples (live engine + single-symbol
 *                executors), or a closed shadow position's own recorded MFE/MAE skeleton.
 *  - SIMULATED : the path points were RECONSTRUCTED from candles by walkVariantPath (paper orders).
 *                Real market data, but a modeled fill/exit path — Task 1 (2026-07-10) measured the
 *                candle-walk exit methodology diverging from real fills by −193%, so a SIMULATED
 *                number is never interchangeable with a MEASURED one.
 *
 * HARD RULE: the two tiers are accumulated into SEPARATE aggregates and are NEVER blended into one
 * number — not in this store, not in buildReport(), not on the dashboard. A caller that wants "all
 * trades" must show two numbers.
 */
export type ExitBrainEvidenceTier = "MEASURED" | "SIMULATED";

/** Absent tier ⇒ MEASURED. Every row and every stored record written before the tier discriminator
 *  existed came from a recorded real path or a recorded shadow-position outcome — i.e. it IS
 *  measured evidence — so defaulting is a correct classification, not a lossy fallback. */
export function exitBrainTierOf(tier: ExitBrainEvidenceTier | undefined | null): ExitBrainEvidenceTier {
  return tier === "SIMULATED" ? "SIMULATED" : "MEASURED";
}

// ── reader contract (DI) ─────────────────────────────────────────────────────

/** One resolved trade with whatever recorded path points exist for it. */
export interface ExitBrainResolvedTrade {
  /** Stable unique id — the dedup key (evaluated exactly once ever). */
  tradeId: string;
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  closedAtIso: string;
  /** The R the actual exit realized, as recorded by the source store (shadow variants:
   *  realizedNetR — net of modeled costs; the policy side is raw mark-R unless
   *  params.bankPenaltyR charges it a close cost). */
  actualExitR: number;
  /** Chronological recorded path observations (however many actually exist). */
  ticks: ExitBrainPathTick[];
  /** Evidence tier. Omitted ⇒ MEASURED (see exitBrainTierOf). */
  tier?: ExitBrainEvidenceTier;
}

export type ExitBrainTradeReader = () => ExitBrainResolvedTrade[] | Promise<ExitBrainResolvedTrade[]>;

// ── store ────────────────────────────────────────────────────────────────────

export interface ExitBrainEvaluationRecord {
  tradeId: string;
  laneId: string;
  symbol: string;
  closedAtIso: string;
  status: "EVALUATED" | "INSUFFICIENT_PATH_DATA";
  tickCount: number;
  actualExitR: number;
  policyExitR: number | null;
  deltaR: number | null;
  bankedAt: string | null;
  bankReason: string | null;
  /** Evidence tier this record was booked under. Omitted on records written before the
   *  discriminator existed — those are MEASURED (see exitBrainTierOf), which is what they are. */
  tier?: ExitBrainEvidenceTier;
}

interface EvaluatedAggregate {
  n: number;
  cumDeltaR: number;
  cumActualExitR: number;
  cumPolicyExitR: number;
  /** deltaR > 0 / < 0 / == 0 counts. */
  policyBetter: number;
  policyWorse: number;
  ties: number;
  /** Trades where the policy actually banked mid-path (vs held through). */
  banked: number;
}

interface LaneAggregate {
  n: number;
  cumDeltaR: number;
  policyBetter: number;
}

interface CycleMeta {
  lastRunAtIso: string | null;
  lastProcessed: number;
  lastError: string | null;
}

/** The SIMULATED tier's own, completely independent copies of the MEASURED counters. Deliberately a
 *  nested object rather than extra sibling fields: it is structurally impossible to accidentally
 *  `+=` a simulated result into a measured counter when the two live in different objects, and a
 *  reader that forgets the tier split gets the MEASURED numbers (the conservative default), never a
 *  silently blended one. */
interface SimulatedTierState {
  evaluated: EvaluatedAggregate;
  insufficient: { n: number };
  tickHistogram: Record<string, number>;
}

interface ExitBrainShadowState {
  version: number;
  records: ExitBrainEvaluationRecord[];
  /** MEASURED tier only (see ExitBrainEvidenceTier). Never includes a SIMULATED result. */
  evaluated: EvaluatedAggregate;
  /** MEASURED tier only. */
  insufficient: { n: number };
  /** Histogram of recorded tick counts over every processed MEASURED trade (evaluated +
   *  insufficient) — the direct "how dense are today's RECORDED paths" evidence. Keys "0".."12" and
   *  "13+". Simulated candle-walk series are counted in `simulated.tickHistogram` instead: folding
   *  them in here would inflate the very coverage number that exists to prove whether real recorded
   *  paths are dense enough. */
  tickHistogram: Record<string, number>;
  /** MEASURED tier only — a per-lane mean that was part measured and part simulated would be
   *  uninterpretable. The SIMULATED tier's lane detail is available through `records` (each carries
   *  laneId + tier); it deliberately has no blended per-lane aggregate. */
  perLane: Record<string, LaneAggregate>;
  /** SIMULATED tier's independent counters. Absent on files written before the tier split ⇒ zeroed
   *  (there were no simulated results then, by construction). */
  simulated: SimulatedTierState;
  processedTradeIds: string[];
  cycleMeta: CycleMeta;
}

/** One evidence tier's complete, self-contained block. MEASURED and SIMULATED are reported as two
 *  of these and are NEVER added together — see ExitBrainEvidenceTier's hard rule. */
export interface ExitBrainTierBlock {
  tier: ExitBrainEvidenceTier;
  /** Human-readable statement of what this tier's numbers are (and are not). Rendered verbatim so
   *  an operator cannot read a simulated number as a measured one. */
  note: string;
  processed: number;
  evaluated: number;
  insufficientPathData: number;
  coverageRatio: number | null;
  tickHistogram: Record<string, number>;
  n: number;
  meanDeltaR: number | null;
  cumDeltaR: number;
  meanActualExitR: number | null;
  meanPolicyExitR: number | null;
  policyBetterShare: number | null;
  policyBetter: number;
  policyWorse: number;
  ties: number;
  banked: number;
}

/** What universe is allowed to contribute to this Exit Brain report. */
export interface ExitBrainReportScope {
  mode: "GLOBAL" | "FOUR_BRAIN_TESTNET_COHORT";
  label: string;
  sinceIso: string | null;
  laneIds: string[];
}

export interface ExitBrainShadowReport {
  reportOnly: true;
  /** Explicitly states whether historical/global paths were excluded. */
  scope: ExitBrainReportScope;
  coverage: {
    processed: number;
    evaluated: number;
    insufficientPathData: number;
    /** evaluated / processed; null before anything was processed. */
    coverageRatio: number | null;
    tickHistogram: Record<string, number>;
    /** Blunt honest statement for the dashboard/operator. */
    note: string;
  };
  performance: {
    n: number;
    meanDeltaR: number | null;
    cumDeltaR: number;
    meanActualExitR: number | null;
    meanPolicyExitR: number | null;
    policyBetterShare: number | null;
    policyBetter: number;
    policyWorse: number;
    ties: number;
    banked: number;
  };
  perLane: Array<{ laneId: string } & LaneAggregate & { meanDeltaR: number | null }>;
  recent: ExitBrainEvaluationRecord[];
  cycleMeta: CycleMeta;
  /** MEASURED evidence — identical content to `coverage`/`performance` above, which have ALWAYS
   *  been measured-only and stay byte-identical for existing data. Exposed as a tier block too so a
   *  consumer can render the two tiers symmetrically without special-casing one of them. */
  measured: ExitBrainTierBlock;
  /** SIMULATED evidence — candle-walk reconstructions of paper orders. Structurally independent of
   *  every other number in this report; never added to the measured block. */
  simulated: ExitBrainTierBlock;
}

function emptyEvaluated(): EvaluatedAggregate {
  return { n: 0, cumDeltaR: 0, cumActualExitR: 0, cumPolicyExitR: 0, policyBetter: 0, policyWorse: 0, ties: 0, banked: 0 };
}

function emptySimulatedTier(): SimulatedTierState {
  return { evaluated: emptyEvaluated(), insufficient: { n: 0 }, tickHistogram: {} };
}

function emptyState(): ExitBrainShadowState {
  return {
    version: 1,
    records: [],
    evaluated: emptyEvaluated(),
    insufficient: { n: 0 },
    tickHistogram: {},
    perLane: {},
    simulated: emptySimulatedTier(),
    processedTradeIds: [],
    cycleMeta: { lastRunAtIso: null, lastProcessed: 0, lastError: null },
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeEvaluated(raw: unknown): EvaluatedAggregate {
  const c = (raw ?? {}) as Partial<EvaluatedAggregate>;
  return {
    n: Math.max(0, Math.floor(finiteOr(c.n, 0))),
    cumDeltaR: finiteOr(c.cumDeltaR, 0),
    cumActualExitR: finiteOr(c.cumActualExitR, 0),
    cumPolicyExitR: finiteOr(c.cumPolicyExitR, 0),
    policyBetter: Math.max(0, Math.floor(finiteOr(c.policyBetter, 0))),
    policyWorse: Math.max(0, Math.floor(finiteOr(c.policyWorse, 0))),
    ties: Math.max(0, Math.floor(finiteOr(c.ties, 0))),
    banked: Math.max(0, Math.floor(finiteOr(c.banked, 0))),
  };
}

export class ExitBrainShadowStore {
  private readonly file: string;
  private state: ExitBrainShadowState;
  private processedIdSet: Set<string>;
  /** Null on every normal/global instance; immutable for this store's lifetime. */
  readonly cohort: FourBrainTestnetCohort | null;

  constructor(dataDir = "data", cohort: FourBrainTestnetCohort | null = null) {
    this.cohort = cohort;
    this.file = resolve(dataDir, "exit-brain-shadow.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    this.processedIdSet = new Set(this.state.processedTradeIds);
  }

  get path(): string {
    return this.file;
  }

  private _load(): ExitBrainShadowState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) {
        const raw = parsed as Partial<ExitBrainShadowState>;
        const perLane: Record<string, LaneAggregate> = {};
        for (const [laneId, agg] of Object.entries(raw.perLane ?? {})) {
          const c = (agg ?? {}) as Partial<LaneAggregate>;
          perLane[laneId] = {
            n: Math.max(0, Math.floor(finiteOr(c.n, 0))),
            cumDeltaR: finiteOr(c.cumDeltaR, 0),
            policyBetter: Math.max(0, Math.floor(finiteOr(c.policyBetter, 0))),
          };
        }
        const sanitizeHistogram = (rawHist: unknown): Record<string, number> => {
          const out: Record<string, number> = {};
          for (const [k, v] of Object.entries((rawHist ?? {}) as Record<string, unknown>)) {
            if (typeof k === "string" && Number.isFinite(v)) out[k] = Math.max(0, Math.floor(v as number));
          }
          return out;
        };
        const tickHistogram = sanitizeHistogram(raw.tickHistogram);
        // Absent on files written before the tier split — zeroed, which is exactly right: no
        // simulated result had ever been booked then, so nothing is lost and no MEASURED number moves.
        const rawSimulated = (raw.simulated ?? {}) as Partial<SimulatedTierState>;
        const simulated: SimulatedTierState = {
          evaluated: sanitizeEvaluated(rawSimulated.evaluated),
          insufficient: { n: Math.max(0, Math.floor(finiteOr((rawSimulated.insufficient ?? {}).n, 0))) },
          tickHistogram: sanitizeHistogram(rawSimulated.tickHistogram),
        };
        const records = (raw.records as unknown[]).filter((r): r is ExitBrainEvaluationRecord => {
          if (!r || typeof r !== "object") return false;
          const rec = r as Partial<ExitBrainEvaluationRecord>;
          return (
            typeof rec.tradeId === "string" &&
            typeof rec.laneId === "string" &&
            typeof rec.closedAtIso === "string" &&
            (rec.status === "EVALUATED" || rec.status === "INSUFFICIENT_PATH_DATA") &&
            Number.isFinite(rec.tickCount) &&
            Number.isFinite(rec.actualExitR)
          );
        });
        const rawMeta = (raw.cycleMeta ?? {}) as Partial<CycleMeta>;
        return {
          version: 1,
          records: records.slice(-MAX_RECORDS),
          evaluated: sanitizeEvaluated(raw.evaluated),
          insufficient: { n: Math.max(0, Math.floor(finiteOr((raw.insufficient ?? {}).n, 0))) },
          tickHistogram,
          perLane,
          simulated,
          processedTradeIds: Array.isArray(raw.processedTradeIds)
            ? raw.processedTradeIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_IDS)
            : [],
          cycleMeta: {
            lastRunAtIso: typeof rawMeta.lastRunAtIso === "string" ? rawMeta.lastRunAtIso : null,
            lastProcessed: Math.max(0, Math.floor(finiteOr(rawMeta.lastProcessed, 0))),
            lastError: typeof rawMeta.lastError === "string" ? rawMeta.lastError : null,
          },
        };
      }
    } catch {
      // corrupt/partial — restart from empty; shadow scoring restarts, trading unaffected
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): ExitBrainShadowState {
    return this.state;
  }

  hasProcessed(tradeId: string): boolean {
    return this.processedIdSet.has(tradeId);
  }

  /** Book one trade's counterfactual result. Idempotent per tradeId (silent no-op on re-offer).
   *  Never throws. Returns true only when actually booked THIS call. */
  recordEvaluation(record: ExitBrainEvaluationRecord, opts?: { deferSave?: boolean }): boolean {
    try {
      if (this.processedIdSet.has(record.tradeId)) return false;
      if (!Number.isFinite(record.actualExitR) || !Number.isFinite(record.tickCount)) return false;

      this.state.records.push(record);
      if (this.state.records.length > MAX_RECORDS) this.state.records = this.state.records.slice(-MAX_RECORDS);

      // TIER ROUTING (the only place a result is attributed to a tier). Every counter touched below
      // belongs to exactly ONE tier's object; a simulated result can never reach a measured counter,
      // and vice versa. Absent tier ⇒ MEASURED (see exitBrainTierOf).
      const isSimulated = exitBrainTierOf(record.tier) === "SIMULATED";
      const tierEvaluated = isSimulated ? this.state.simulated.evaluated : this.state.evaluated;
      const tierInsufficient = isSimulated ? this.state.simulated.insufficient : this.state.insufficient;
      const tierHistogram = isSimulated ? this.state.simulated.tickHistogram : this.state.tickHistogram;

      const histKey = record.tickCount > TICK_HISTOGRAM_MAX_KEY ? `${TICK_HISTOGRAM_MAX_KEY + 1}+` : String(Math.max(0, Math.floor(record.tickCount)));
      tierHistogram[histKey] = (tierHistogram[histKey] ?? 0) + 1;

      if (record.status === "EVALUATED" && record.policyExitR !== null && record.deltaR !== null) {
        const agg = tierEvaluated;
        agg.n += 1;
        agg.cumDeltaR += record.deltaR;
        agg.cumActualExitR += record.actualExitR;
        agg.cumPolicyExitR += record.policyExitR;
        if (record.deltaR > 0) agg.policyBetter += 1;
        else if (record.deltaR < 0) agg.policyWorse += 1;
        else agg.ties += 1;
        if (record.bankedAt !== null) agg.banked += 1;

        // perLane is MEASURED-ONLY by contract (see the field's doc on ExitBrainShadowState): a lane
        // mean that silently mixed measured and simulated rows would be uninterpretable, and there
        // is no honest way to present one blended per-lane number.
        if (!isSimulated) {
          const laneKey =
            record.laneId in this.state.perLane || Object.keys(this.state.perLane).length < MAX_LANES ? record.laneId : OVERFLOW_LANE_ID;
          const lane = this.state.perLane[laneKey] ?? { n: 0, cumDeltaR: 0, policyBetter: 0 };
          lane.n += 1;
          lane.cumDeltaR += record.deltaR;
          if (record.deltaR > 0) lane.policyBetter += 1;
          this.state.perLane[laneKey] = lane;
        }
      } else {
        tierInsufficient.n += 1;
      }

      this.processedIdSet.add(record.tradeId);
      this.state.processedTradeIds.push(record.tradeId);
      if (this.state.processedTradeIds.length > MAX_PROCESSED_IDS) {
        const evicted = this.state.processedTradeIds.splice(0, this.state.processedTradeIds.length - MAX_PROCESSED_IDS);
        for (const id of evicted) this.processedIdSet.delete(id);
      }

      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false; // report-only bookkeeping never throws into a caller
    }
  }

  recordCycle(lastRunAtIso: string, processed: number, error: string | null, opts?: { deferSave?: boolean }): void {
    this.state.cycleMeta = { lastRunAtIso, lastProcessed: Math.max(0, Math.floor(processed)), lastError: error };
    if (!opts?.deferSave) this._save();
  }

  /** Persist now (for batch writers using deferSave). Never throws. */
  flush(): void {
    this._save();
  }

  /** Folds ONE tier's counters into its self-contained block. Reads only the objects it is handed —
   *  it cannot reach across tiers, which is what makes cross-contamination impossible here too. */
  private buildTierBlock(
    tier: ExitBrainEvidenceTier,
    ev: EvaluatedAggregate,
    insufficientN: number,
    tickHistogram: Record<string, number>,
  ): ExitBrainTierBlock {
    const processed = ev.n + insufficientN;
    const coverageRatio = processed > 0 ? ev.n / processed : null;
    const scope =
      tier === "SIMULATED"
        ? "SIMULATED (candle-walk reconstruction of paper orders — modeled, NOT measured; never add to the MEASURED block)"
        : "MEASURED (real recorded paths)";
    const note =
      processed === 0
        ? `${scope}: no resolved trades processed yet.`
        : coverageRatio === 0
          ? `${scope}: 0% of resolved trades carry enough recorded path ticks to score the exit policy (min ${DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks} ticks).`
          : `${scope}: ${(coverageRatio! * 100).toFixed(1)}% of resolved trades were dense enough to score (min ${DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks} ticks).`;
    return {
      tier,
      note,
      processed,
      evaluated: ev.n,
      insufficientPathData: insufficientN,
      coverageRatio,
      tickHistogram: { ...tickHistogram },
      n: ev.n,
      meanDeltaR: ev.n > 0 ? ev.cumDeltaR / ev.n : null,
      cumDeltaR: ev.cumDeltaR,
      meanActualExitR: ev.n > 0 ? ev.cumActualExitR / ev.n : null,
      meanPolicyExitR: ev.n > 0 ? ev.cumPolicyExitR / ev.n : null,
      policyBetterShare: ev.n > 0 ? ev.policyBetter / ev.n : null,
      policyBetter: ev.policyBetter,
      policyWorse: ev.policyWorse,
      ties: ev.ties,
      banked: ev.banked,
    };
  }

  buildReport(): ExitBrainShadowReport {
    const ev = this.state.evaluated;
    const processed = ev.n + this.state.insufficient.n;
    const coverageRatio = processed > 0 ? ev.n / processed : null;
    const note =
      processed === 0
        ? "No resolved trades processed yet."
        : coverageRatio === 0
          ? "0% of resolved trades carry a recorded path. The dense recorder EXISTS (position-path-recorder.ts) — it is simply not attached to whatever executed these trades. Only two writers call recordTick: live-execution-engine.ts and single-symbol-lane-executor.ts. An instance running neither (research) can only ever hold 4-point skeletons rebuilt from aggregates, and this reads 0% by construction, not by defect. Do NOT respond by lowering minEvaluableTicks — see the DO-NOT-LOWER note in exit-brain-policy.ts."
          : `${(coverageRatio! * 100).toFixed(1)}% of resolved trades were dense enough to score (min ${DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks} ticks). The rest are 4-point skeletons from executors that write no ticks — coverage is bounded by which executor ran the trade, never by the threshold.`;
    return {
      reportOnly: true,
      scope: this.cohort === null
        ? { mode: "GLOBAL", label: "all available exit paths", sinceIso: null, laneIds: [] }
        : {
            mode: "FOUR_BRAIN_TESTNET_COHORT",
            label: this.cohort.label,
            sinceIso: this.cohort.sinceIso,
            laneIds: [...this.cohort.laneIds],
          },
      coverage: {
        processed,
        evaluated: ev.n,
        insufficientPathData: this.state.insufficient.n,
        coverageRatio,
        tickHistogram: { ...this.state.tickHistogram },
        note,
      },
      performance: {
        n: ev.n,
        meanDeltaR: ev.n > 0 ? ev.cumDeltaR / ev.n : null,
        cumDeltaR: ev.cumDeltaR,
        meanActualExitR: ev.n > 0 ? ev.cumActualExitR / ev.n : null,
        meanPolicyExitR: ev.n > 0 ? ev.cumPolicyExitR / ev.n : null,
        policyBetterShare: ev.n > 0 ? ev.policyBetter / ev.n : null,
        policyBetter: ev.policyBetter,
        policyWorse: ev.policyWorse,
        ties: ev.ties,
        banked: ev.banked,
      },
      perLane: Object.entries(this.state.perLane)
        .map(([laneId, agg]) => ({ laneId, ...agg, meanDeltaR: agg.n > 0 ? agg.cumDeltaR / agg.n : null }))
        .sort((a, b) => Math.abs(b.cumDeltaR) - Math.abs(a.cumDeltaR)),
      recent: this.state.records.slice(-20),
      cycleMeta: { ...this.state.cycleMeta },
      // Two INDEPENDENT blocks. `measured` restates exactly the coverage/performance numbers above
      // (both have always been measured-only); `simulated` is built from its own separate counters
      // and is never summed with them anywhere in this report.
      measured: this.buildTierBlock("MEASURED", ev, this.state.insufficient.n, this.state.tickHistogram),
      simulated: this.buildTierBlock(
        "SIMULATED",
        this.state.simulated.evaluated,
        this.state.simulated.insufficient.n,
        this.state.simulated.tickHistogram,
      ),
    };
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
}

let singleton: ExitBrainShadowStore | null = null;
let singletonKey: string | null = null;

/**
 * Focused testnet evidence is persisted separately from the historic/global
 * Exit ledger. That lets the report re-read valid post-cutoff paths without
 * deleting the old audit trail or mixing it into the new cohort's verdict.
 */
export function exitBrainShadowDataDirForCohort(
  dataDir = "data",
  cohort: FourBrainTestnetCohort | null = resolveFourBrainTestnetCohort(),
): string {
  return cohort === null ? dataDir : resolve(dataDir, "four-brain-testnet-focus");
}

export function getExitBrainShadowStore(
  dataDir = "data",
  env: NodeJS.ProcessEnv = process.env,
): ExitBrainShadowStore {
  const cohort = resolveFourBrainTestnetCohort(env);
  const scopedDataDir = exitBrainShadowDataDirForCohort(dataDir, cohort);
  const key = scopedDataDir + "|" + (cohort?.sinceMs ?? "GLOBAL");
  if (!singleton || singletonKey !== key) {
    singleton = new ExitBrainShadowStore(scopedDataDir, cohort);
    singletonKey = key;
  }
  return singleton;
}
export function _resetExitBrainShadowStoreForTests(): void {
  singleton = null;
  singletonKey = null;
}

// ── shadow-position adapter (v1 production reader source) ────────────────────

/**
 * Maps closed shadow positions to ExitBrainResolvedTrade, building the best path each record can
 * honestly support from what shadow-engine.ts actually persists per SELECTED variant: openedAt
 * (0R), mfeR@maxFavorableAt, maeR@maxAdverseAt, realizedNetR@closedAt — i.e. AT MOST 4 ticks.
 * Sign note: shadow-engine stores maeR as a POSITIVE magnitude (Math.max(0, adverseAbs)/risk);
 * the path tick needs the signed unrealized R at the trough, so it is negated here. Ticks with
 * missing timestamps are simply omitted (never fabricated). Pure; exported for tests.
 *
 * TIER: rows carry no `tier`, i.e. MEASURED — these are a real closed position's own recorded
 * MFE/MAE observations, not a reconstruction. (Sparse, so most classify INSUFFICIENT_PATH_DATA —
 * that is a density problem, not an evidence-quality one.)
 */
export function resolvedTradesFromShadowPositions(positions: ShadowPosition[]): ExitBrainResolvedTrade[] {
  const out: ExitBrainResolvedTrade[] = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!position || !Array.isArray(position.variants)) continue;
    // The trade that ACTUALLY happened is the selected exit variant (fallback: primaryVariant).
    const wantedVariant = position.selectedExitVariant ?? position.primaryVariant;
    const variant = position.variants.find((v) => v && v.variant === wantedVariant && v.state === "CLOSED");
    if (!variant) continue;
    if (typeof variant.closedAt !== "string" || !Number.isFinite(variant.realizedNetR)) continue;

    const openMs = Date.parse(variant.openedAt ?? "");
    const closeMs = Date.parse(variant.closedAt);
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs < openMs) continue;

    const ticks: ExitBrainPathTick[] = [{ tsMs: openMs, currentR: 0 }];
    const peakMs = Date.parse(variant.maxFavorableAt ?? "");
    if (Number.isFinite(peakMs) && Number.isFinite(variant.mfeR ?? Number.NaN) && peakMs >= openMs && peakMs <= closeMs) {
      ticks.push({ tsMs: peakMs, currentR: Math.max(0, variant.mfeR as number), peakR: Math.max(0, variant.mfeR as number) });
    }
    const troughMs = Date.parse(variant.maxAdverseAt ?? "");
    if (Number.isFinite(troughMs) && Number.isFinite(variant.maeR ?? Number.NaN) && troughMs >= openMs && troughMs <= closeMs) {
      const signedTrough = -Math.abs(variant.maeR as number);
      ticks.push({ tsMs: troughMs, currentR: signedTrough, troughR: signedTrough });
    }
    ticks.push({ tsMs: closeMs, currentR: variant.realizedNetR });
    ticks.sort((a, b) => a.tsMs - b.tsMs);

    out.push({
      tradeId: `sp:${position.id}:${variant.variant}`,
      laneId: String(wantedVariant ?? "UNKNOWN"),
      symbol: position.symbol,
      direction: position.direction,
      closedAtIso: variant.closedAt,
      actualExitR: variant.realizedNetR,
      ticks,
    });
  }
  return out;
}

// ── cycle ────────────────────────────────────────────────────────────────────

export interface ExitBrainShadowCycleDeps {
  store: ExitBrainShadowStore;
  readResolvedTrades: ExitBrainTradeReader;
  /** Override only for a deterministic test; omitted uses the store's immutable scope. */
  cohort?: FourBrainTestnetCohort | null;
  now?: number;
  params?: ExitBrainParams;
  maxTradesPerCycle?: number;
}

export interface ExitBrainShadowCycleResult {
  ok: boolean;
  processed: number;
  evaluated: number;
  insufficient: number;
  skippedAlreadyProcessed: number;
  error: string | null;
}

/**
 * One shadow pass: pull resolved trades from the injected reader, counterfactually score each
 * trade not yet in the dedup ledger (exactly once ever), book the results, persist ONCE. Errors
 * are captured into cycleMeta (so the report shows "ran and errored", never silently frozen) and
 * returned — never thrown.
 */
export async function runExitBrainShadowCycle(deps: ExitBrainShadowCycleDeps): Promise<ExitBrainShadowCycleResult> {
  const now = deps.now ?? Date.now();
  const params = deps.params ?? DEFAULT_EXIT_BRAIN_PARAMS;
  const maxPerCycle = deps.maxTradesPerCycle ?? DEFAULT_MAX_TRADES_PER_CYCLE;
  const cohort = deps.cohort === undefined ? deps.store.cohort : deps.cohort;
  const result: ExitBrainShadowCycleResult = { ok: true, processed: 0, evaluated: 0, insufficient: 0, skippedAlreadyProcessed: 0, error: null };
  try {
    const trades = await deps.readResolvedTrades();
    for (const rawTrade of Array.isArray(trades) ? trades : []) {
      if (result.processed >= maxPerCycle) break;
      if (!rawTrade) continue;
      // The focused testnet can only learn from its five canonical lane ids
      // and its declared deployment boundary. Global data remains on disk for
      // audit but is never admitted to this separate store.
      const trade = scopeExitTradeToFourBrainTestnetCohort(rawTrade, cohort);
      if (trade === null) continue;
      if (!trade || typeof trade.tradeId !== "string" || trade.tradeId.length === 0) continue;
      if (deps.store.hasProcessed(trade.tradeId)) {
        result.skippedAlreadyProcessed += 1;
        continue;
      }
      const cf = evaluateExitBrainCounterfactual(trade.ticks, { exitR: trade.actualExitR, exitAtIso: trade.closedAtIso }, params);
      if (cf.status === "INVALID_INPUT") continue; // unusable source row — not booked, not counted
      const booked = deps.store.recordEvaluation(
        {
          tradeId: trade.tradeId,
          laneId: trade.laneId || "UNKNOWN",
          symbol: trade.symbol,
          closedAtIso: trade.closedAtIso,
          status: cf.status,
          tickCount: cf.tickCount,
          actualExitR: trade.actualExitR,
          policyExitR: cf.policyExitR,
          deltaR: cf.deltaR,
          bankedAt: cf.bankedAt,
          bankReason: cf.bankReason,
          // Carried verbatim from the reader that produced this trade — the reader is the ONLY
          // authority on what kind of evidence its rows are. Absent ⇒ MEASURED (exitBrainTierOf).
          tier: exitBrainTierOf(trade.tier),
        },
        { deferSave: true },
      );
      if (booked) {
        result.processed += 1;
        if (cf.status === "EVALUATED") result.evaluated += 1;
        else result.insufficient += 1;
      }
    }
    deps.store.recordCycle(new Date(now).toISOString(), result.processed, null, { deferSave: true });
    deps.store.flush();
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    try {
      deps.store.recordCycle(new Date(now).toISOString(), result.processed, result.error, { deferSave: true });
      deps.store.flush();
    } catch {
      // never let liveness bookkeeping break the caller
    }
  }
  return result;
}

/** Overlap guard: the 7-min shadow ticker must never stack two cycles on the singleton store.
 *  Returns null when a previous cycle is still in flight. Never throws. */
let cycleInFlight = false;
export async function runExitBrainShadowCycleGuarded(deps: ExitBrainShadowCycleDeps): Promise<ExitBrainShadowCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runExitBrainShadowCycle(deps);
  } finally {
    cycleInFlight = false;
  }
}

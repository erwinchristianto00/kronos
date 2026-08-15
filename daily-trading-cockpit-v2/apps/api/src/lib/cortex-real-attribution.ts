/**
 * CORTEX REAL-USDT attribution (2026-07-21) — answers the operator's question "how much actual
 * USDT has CORTEX's promoted weight tilt made or lost?" in realized dollars, not counterfactual R.
 *
 * Definition (per closed trade):
 *   tiltShare = (appliedWeightPct − rawStaticWeightPct) / appliedWeightPct   [0 when no tilt]
 *   cortexUsd = realizedPnlUsd × tiltShare
 * where BOTH weights are captured AT OPEN time (the moment the weight actually sized the entry):
 * appliedWeightPct is what the sizing path really used (laneSelectionWeightPctForLane — includes
 * any active CORTEX promoted override) and rawStaticWeightPct is the operator's untouched static
 * table weight for the same lane (rawLaneAllocationWeightPctForLane). The sign math is honest by
 * construction: an UPSIZED winner credits CORTEX, an upsized loser debits it; a DOWNSIZED winner
 * means CORTEX cost money (negative tiltShare × positive P&L), a downsized loser means CORTEX
 * saved money (negative × negative = positive).
 *
 * Report-only, engine-agnostic bookkeeping: writers (live-execution-engine.ts's close sweep +
 * SingleSymbolLaneExecutor's close finalization) wrap every call in try/catch so a failure here
 * can NEVER affect trading. Persistence follows the repo's hardened store idiom (compact JSON,
 * atomic tmp+rename, BOUNDED: last MAX_RECORDS close records + running all-time aggregates that
 * survive record pruning, plus a bounded dedup id set so a retried sweep can never double-book).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Newest-N detail records kept on disk (aggregates below keep counting past this). */
const MAX_RECORDS = 2000;
/** Dedup ids retained. 2026-07-21 review fix: this FIFO is no longer the PRIMARY dedup for the
 *  engine sweep — booked intents are flagged `cortexAttributed` on the intent record itself
 *  (persisted with the intent, dies with it), so FIFO eviction can never re-book an engine intent
 *  regardless of LIVE_MAX_STORED_INTENTS or how many single-symbol closes share this set. The
 *  FIFO remains as the primary dedup for single-symbol-executor writers (which record exactly
 *  once at close finalization, no re-offer) and as a second layer for the sweep. */
const MAX_ATTRIBUTED_IDS = 8000;
/** perLane aggregate rows kept strictly bounded — lane ids are a small finite set in practice
 *  (~dozens); anything beyond the cap folds into "OTHER" instead of growing without bound. */
const MAX_LANES = 300;
const OVERFLOW_LANE_ID = "OTHER";

export interface CortexRealAttributionCloseInput {
  /** Unique per close (writer-scoped, e.g. `intent:<paperOrderId>:<createdAt>`), used as the
   *  persisted dedup key — recording the same id twice is a silent no-op. */
  recordId: string;
  closedAtIso: string;
  laneId: string;
  symbol: string;
  realizedPnlUsd: number;
  appliedWeightPct: number;
  rawStaticWeightPct: number;
}

export interface CortexRealAttributionRecord {
  recordId: string;
  closedAtIso: string;
  laneId: string;
  symbol: string;
  realizedPnlUsd: number;
  appliedWeightPct: number;
  rawStaticWeightPct: number;
  tiltShare: number;
  cortexUsd: number;
}

/**
 * One deliberate reporting exclusion. The original record stays immutable in `records`; these
 * frozen contribution values let buildReport subtract it from rolling all-time aggregates even
 * after the detail list has pruned older rows.
 */
interface CortexRealAttributionReportingExclusion {
  recordId: string;
  laneId: string;
  aggregateLaneId: string;
  closedAtIso: string;
  realizedPnlUsd: number;
  cortexUsd: number;
  excludedAt: string;
  reason: string;
}

interface CortexRealAttributionAggregate {
  n: number;
  cortexUsd: number;
  realizedPnlUsd: number;
}

interface CortexRealAttributionState {
  version: number;
  /** Newest-last, bounded to MAX_RECORDS. */
  records: CortexRealAttributionRecord[];
  /** Running totals over EVERY record ever booked — never lose history to record pruning. */
  allTime: CortexRealAttributionAggregate;
  perLane: Record<string, CortexRealAttributionAggregate>;
  /** Bounded FIFO of already-booked recordIds (dedup for retried sweeps / restarts). */
  attributedRecordIds: string[];
  /** Manual report/learning voids. Raw records and exchange fills are intentionally retained. */
  reportingExclusions?: Record<string, CortexRealAttributionReportingExclusion>;
}

export interface CortexRealAttributionReport {
  /** UTC calendar day (of `nowIso`) bucket, computed from the bounded detail records. */
  today: { dateUtc: string; n: number; cortexUsd: number; realizedPnlUsd: number };
  allTime: CortexRealAttributionAggregate;
  perLane: Array<{ laneId: string } & CortexRealAttributionAggregate>;
  recent: CortexRealAttributionRecord[];
}

/** Spec formula, guarded: 0 whenever it cannot be computed honestly (applied ≤ 0 — a lane that
 *  sized to nothing never opened anything to attribute — or a non-finite input). NOT clamped:
 *  a downsizing tilt legitimately produces a negative share. */
export function computeTiltShare(appliedWeightPct: number, rawStaticWeightPct: number): number {
  if (!Number.isFinite(appliedWeightPct) || !Number.isFinite(rawStaticWeightPct)) return 0;
  if (!(appliedWeightPct > 0)) return 0;
  return (appliedWeightPct - rawStaticWeightPct) / appliedWeightPct;
}

function emptyAggregate(): CortexRealAttributionAggregate {
  return { n: 0, cortexUsd: 0, realizedPnlUsd: 0 };
}

function emptyState(): CortexRealAttributionState {
  return { version: 1, records: [], allTime: emptyAggregate(), perLane: {}, attributedRecordIds: [], reportingExclusions: {} };
}

function sanitizeAggregate(raw: unknown): CortexRealAttributionAggregate {
  const candidate = (raw ?? {}) as Partial<CortexRealAttributionAggregate>;
  return {
    n: Number.isFinite(candidate.n) ? Math.max(0, Math.floor(candidate.n as number)) : 0,
    cortexUsd: Number.isFinite(candidate.cortexUsd) ? (candidate.cortexUsd as number) : 0,
    realizedPnlUsd: Number.isFinite(candidate.realizedPnlUsd) ? (candidate.realizedPnlUsd as number) : 0,
  };
}

function sanitizeReportingExclusions(raw: unknown): Record<string, CortexRealAttributionReportingExclusion> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, CortexRealAttributionReportingExclusion> = {};
  for (const [recordId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Partial<CortexRealAttributionReportingExclusion>;
    if (
      candidate.recordId !== recordId ||
      typeof candidate.laneId !== "string" ||
      typeof candidate.aggregateLaneId !== "string" ||
      typeof candidate.closedAtIso !== "string" ||
      typeof candidate.excludedAt !== "string" ||
      typeof candidate.reason !== "string" ||
      !Number.isFinite(candidate.realizedPnlUsd) ||
      !Number.isFinite(candidate.cortexUsd)
    ) continue;
    out[recordId] = {
      recordId,
      laneId: candidate.laneId,
      aggregateLaneId: candidate.aggregateLaneId,
      closedAtIso: candidate.closedAtIso,
      realizedPnlUsd: candidate.realizedPnlUsd as number,
      cortexUsd: candidate.cortexUsd as number,
      excludedAt: candidate.excludedAt,
      reason: candidate.reason,
    };
  }
  return out;
}

export class CortexRealAttributionStore {
  private readonly file: string;
  private state: CortexRealAttributionState;
  private attributedIdSet: Set<string>;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cortex-real-attribution.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    this.attributedIdSet = new Set(this.state.attributedRecordIds);
  }

  get path(): string {
    return this.file;
  }

  private _load(): CortexRealAttributionState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) {
        const raw = parsed as Partial<CortexRealAttributionState>;
        const perLane: Record<string, CortexRealAttributionAggregate> = {};
        for (const [laneId, agg] of Object.entries(raw.perLane ?? {})) perLane[laneId] = sanitizeAggregate(agg);
        // 2026-07-21 review fix: sanitize the records themselves too — a malformed persisted entry
        // (a literal null, or non-numeric cortexUsd) must degrade to "that record is dropped", never
        // to buildReport()/the dashboard render throwing on it.
        const records = (raw.records as unknown[]).filter((r): r is CortexRealAttributionRecord => {
          if (!r || typeof r !== "object") return false;
          const rec = r as Partial<CortexRealAttributionRecord>;
          return (
            typeof rec.recordId === "string" &&
            typeof rec.closedAtIso === "string" &&
            typeof rec.laneId === "string" &&
            Number.isFinite(rec.realizedPnlUsd) &&
            Number.isFinite(rec.tiltShare) &&
            Number.isFinite(rec.cortexUsd)
          );
        });
        return {
          version: 1,
          records: records.slice(-MAX_RECORDS),
          allTime: sanitizeAggregate(raw.allTime),
          perLane,
          attributedRecordIds: Array.isArray(raw.attributedRecordIds)
            ? raw.attributedRecordIds.filter((id): id is string => typeof id === "string").slice(-MAX_ATTRIBUTED_IDS)
            : [],
          reportingExclusions: sanitizeReportingExclusions(raw.reportingExclusions),
        };
      }
    } catch {
      // corrupt/partial — fall through to empty (attribution restarts from zero, trading unaffected)
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): CortexRealAttributionState {
    return this.state;
  }

  hasRecorded(recordId: string): boolean {
    return this.attributedIdSet.has(recordId);
  }

  /**
   * Remove one known record from normal attribution output while retaining the raw record and its
   * dedup identity. This is intentionally an explicit operator correction, never an automatic
   * trading outcome rule.
   */
  excludeRecordForReporting(
    recordId: string,
    opts: { reason: string; excludedAt?: string },
  ): { ok: true; alreadyExcluded: boolean } | { ok: false; reason: string } {
    const normalizedRecordId = recordId.trim();
    const reason = opts.reason.trim();
    if (!normalizedRecordId) return { ok: false, reason: "recordId is required" };
    if (!reason) return { ok: false, reason: "exclusion reason is required" };
    const exclusions = (this.state.reportingExclusions ??= {});
    if (exclusions[normalizedRecordId]) return { ok: true, alreadyExcluded: true };
    const record = this.state.records.find((candidate) => candidate.recordId === normalizedRecordId);
    if (!record) return { ok: false, reason: `record ${normalizedRecordId} is not retained for a safe reporting exclusion` };
    // `record.laneId` is the normal bucket. A legacy record could have been folded into OTHER at
    // write time, in which case subtract from the same aggregate bucket instead of inventing one.
    const aggregateLaneId = record.laneId in this.state.perLane ? record.laneId : OVERFLOW_LANE_ID;
    exclusions[record.recordId] = {
      recordId: record.recordId,
      laneId: record.laneId,
      aggregateLaneId,
      closedAtIso: record.closedAtIso,
      realizedPnlUsd: record.realizedPnlUsd,
      cortexUsd: record.cortexUsd,
      excludedAt: opts.excludedAt ?? new Date().toISOString(),
      reason,
    };
    this._save();
    return { ok: true, alreadyExcluded: false };
  }

  /** Book one closed trade's CORTEX share. Idempotent per recordId; silently skips non-finite
   *  inputs (an unknown P&L must never fabricate an attribution). Never throws — a persistence
   *  failure only loses this report's durability, never the caller's trading tick. Returns true
   *  ONLY when the record was actually booked this call (callers use this to set their own durable
   *  dedup marker, e.g. the engine sweep's per-intent `cortexAttributed` flag).
   *  2026-07-21 review fix: `deferSave` lets a bulk writer (the engine's per-tick sweep) batch
   *  many bookings into ONE disk write via flush() — a re-book burst must never turn into an
   *  O(N) sync-write storm inside a trading tick. */
  recordClose(input: CortexRealAttributionCloseInput, opts?: { deferSave?: boolean }): boolean {
    try {
      if (this.attributedIdSet.has(input.recordId)) return false;
      if (!Number.isFinite(input.realizedPnlUsd)) return false;
      const tiltShare = computeTiltShare(input.appliedWeightPct, input.rawStaticWeightPct);
      const cortexUsd = input.realizedPnlUsd * tiltShare;
      const record: CortexRealAttributionRecord = {
        recordId: input.recordId,
        closedAtIso: input.closedAtIso,
        laneId: input.laneId || "UNKNOWN",
        symbol: input.symbol,
        realizedPnlUsd: input.realizedPnlUsd,
        appliedWeightPct: input.appliedWeightPct,
        rawStaticWeightPct: input.rawStaticWeightPct,
        tiltShare,
        cortexUsd,
      };
      this.state.records.push(record);
      if (this.state.records.length > MAX_RECORDS) {
        this.state.records = this.state.records.slice(-MAX_RECORDS);
      }
      this.state.allTime.n += 1;
      this.state.allTime.cortexUsd += cortexUsd;
      this.state.allTime.realizedPnlUsd += input.realizedPnlUsd;
      // Reserve one of the MAX_LANES slots for OVERFLOW_LANE_ID itself: before it's ever needed, only
      // MAX_LANES-1 distinct real lanes are allowed in, so the eventual overflow key doesn't become a
      // 301st entry. Once OVERFLOW_LANE_ID exists, it already occupies that reserved slot.
      const hasOverflowLane = OVERFLOW_LANE_ID in this.state.perLane;
      const effectiveCap = hasOverflowLane ? MAX_LANES : MAX_LANES - 1;
      const laneKey =
        record.laneId in this.state.perLane || Object.keys(this.state.perLane).length < effectiveCap
          ? record.laneId
          : OVERFLOW_LANE_ID;
      const lane = this.state.perLane[laneKey] ?? emptyAggregate();
      lane.n += 1;
      lane.cortexUsd += cortexUsd;
      lane.realizedPnlUsd += input.realizedPnlUsd;
      this.state.perLane[laneKey] = lane;
      this.attributedIdSet.add(input.recordId);
      this.state.attributedRecordIds.push(input.recordId);
      if (this.state.attributedRecordIds.length > MAX_ATTRIBUTED_IDS) {
        const evicted = this.state.attributedRecordIds.splice(0, this.state.attributedRecordIds.length - MAX_ATTRIBUTED_IDS);
        for (const id of evicted) this.attributedIdSet.delete(id);
      }
      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      // report-only bookkeeping — never let it throw into a trading path
      return false;
    }
  }

  /** Persist now. For batch writers using recordClose's deferSave. Never throws. */
  flush(): void {
    this._save();
  }

  buildReport(nowIso = new Date().toISOString()): CortexRealAttributionReport {
    const dateUtc = nowIso.slice(0, 10);
    const today = emptyAggregate();
    const exclusions = Object.values(this.state.reportingExclusions ?? {});
    const excludedIds = new Set(exclusions.map((exclusion) => exclusion.recordId));
    for (const record of this.state.records) {
      if (excludedIds.has(record.recordId)) continue;
      if (typeof record.closedAtIso === "string" && record.closedAtIso.slice(0, 10) === dateUtc) {
        today.n += 1;
        today.cortexUsd += record.cortexUsd;
        today.realizedPnlUsd += record.realizedPnlUsd;
      }
    }
    // allTime/perLane deliberately remain running raw aggregates on disk, so history that has
    // fallen out of the bounded detail list is not lost. Subtract explicit void contributions at
    // read time instead of mutating/deleting that raw bookkeeping.
    const allTime = { ...this.state.allTime };
    const perLane = Object.fromEntries(
      Object.entries(this.state.perLane).map(([laneId, aggregate]) => [laneId, { ...aggregate }]),
    ) as Record<string, CortexRealAttributionAggregate>;
    for (const exclusion of exclusions) {
      allTime.n = Math.max(0, allTime.n - 1);
      allTime.cortexUsd -= exclusion.cortexUsd;
      allTime.realizedPnlUsd -= exclusion.realizedPnlUsd;
      const lane = perLane[exclusion.aggregateLaneId];
      if (lane) {
        lane.n = Math.max(0, lane.n - 1);
        lane.cortexUsd -= exclusion.cortexUsd;
        lane.realizedPnlUsd -= exclusion.realizedPnlUsd;
      }
    }
    return {
      today: { dateUtc, ...today },
      allTime,
      perLane: Object.entries(perLane)
        .filter(([, aggregate]) => aggregate.n > 0)
        .map(([laneId, aggregate]) => ({ laneId, ...aggregate }))
        .sort((a, b) => Math.abs(b.cortexUsd) - Math.abs(a.cortexUsd)),
      recent: this.state.records.filter((record) => !excludedIds.has(record.recordId)).slice(-20),
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

let singleton: CortexRealAttributionStore | null = null;
export function getCortexRealAttributionStore(dataDir = "data"): CortexRealAttributionStore {
  if (!singleton) singleton = new CortexRealAttributionStore(dataDir);
  return singleton;
}

export function _resetCortexRealAttributionStoreForTests(): void {
  singleton = null;
}

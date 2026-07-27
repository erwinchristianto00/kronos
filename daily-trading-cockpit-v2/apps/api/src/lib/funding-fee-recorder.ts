/**
 * FUNDING-FEE RECORDER (2026-07-26, REPORT-ONLY).
 *
 * WHY: funding is a real, recurring cash cost on every perp position this account holds — charged
 * every 8h — and as of 2026-07-26 it is persisted NOWHERE. The only code that ever looks at
 * FUNDING_FEE is wallet-reconciliation.ts, which sums it into a per-day report object and then
 * throws the rows away; that module has zero write calls by design and says so in its own header.
 * Every per-position and per-lane P&L figure in this system is therefore funding-blind, and there
 * is no historical record from which that could ever be corrected after the fact.
 *
 * THIS MODULE ADDS NO EXCHANGE INTERACTION. It does not fetch anything and owns no timer. The
 * live instance ALREADY pulls /fapi/v1/income for the current UTC day every 30 minutes — see
 * server.ts's WALLET_RECONCILIATION_ENABLED ticker (verified enabled on the mainnet /live process,
 * interval 30min) hitting /api/live/wallet-reconciliation, which calls
 * buildLiveWalletReconciliationReport → engine.getIncomeHistory. Those responses already contain
 * every FUNDING_FEE row for the day and are discarded after the summary is built. This module is
 * a READ-THROUGH OBSERVER on that existing call (see withFundingFeeRecording): the rows are
 * already in memory, the recorder just stops deleting them.
 *
 * WIRING (routes/live.ts): the recorder is attached by DECORATING the engine handed to
 * buildLiveWalletReconciliationReport, not by editing wallet-reconciliation.ts. That module's
 * "never mutates, never writes" contract is a stated safety property other reviewers rely on, and
 * it stays literally true — the write happens in the route, where side effects already live.
 *
 * RECORD, DON'T ATTRIBUTE. FuturesIncomeEntry carries symbol/income/asset/time/tranId and NO
 * position or order id. Assigning a funding charge to a position requires intersecting
 * (symbol, time) against open-position intervals spread across three separate stores — that is an
 * INFERENCE, and doing it at write time would bake a guess into the permanent record. The rows are
 * persisted verbatim; attributeFundingToIntervals() below is the (pure, offline, caller-supplied)
 * derivation, and it reports what it could NOT attribute rather than silently spreading it.
 *
 * HARD SAFETY RULE (same as position-path-recorder.ts / cortex-real-attribution.ts): this is
 * bookkeeping about trading, never part of it. Every public method is wrapped so it can never
 * throw into a caller; a corrupt or unwritable store degrades to "funding recording restarts",
 * never to a trading effect. Nothing here places, modifies, or cancels an order, and nothing reads
 * this store to make a decision.
 *
 * COVERAGE IS BEST-EFFORT AND SAYS SO. Rows are only seen for UTC days the reconciliation ticker
 * actually ran on. A process restart, a disabled ticker, or a day nobody queried leaves a hole —
 * so every observation stamps a per-UTC-day coverage row (first/last observed, count). A consumer
 * that finds no funding for a day must be able to tell "none was charged" from "we never looked",
 * and getDayCoverage() is what makes that distinguishable. Never present a sum over this store as
 * complete without checking it.
 *
 * COVERAGE ALSO KNOWS ABOUT PAGE TRUNCATION (2026-07-27 review fix). The observed fetch is
 * /fapi/v1/income with NO incomeType filter and limit 1000, so the page carries every COMMISSION
 * and REALIZED_PNL row for the window too — on a heavy trading day the 16:00 UTC funding rows can
 * be pushed off the page edge before we ever see them. A coverage row that reads as a normal
 * healthy observation while a third of the day's funding is permanently missing is precisely the
 * false-complete total this store exists to prevent, so `possiblyTruncated` records it. It LATCHES
 * true and is never cleared: a later non-saturated page only proves completeness for the window
 * THAT call used, and this module is not told the window.
 *
 * SIZING (deliberate — this repo has a 234MB-unrotated-journal incident on record). Funding is
 * charged 3×/day per open symbol; at 2-4 concurrently open symbols that is ~10 rows/day at ~110
 * bytes each, i.e. ~33 KB/month. Caps: MAX_FUNDING_ROWS = 5000 (≈16 months at that rate, ~550 KB)
 * FIFO by time, plus RETENTION_MS = 180d in pruneExpired(). Hard ceiling well under 1 MB.
 *
 * WRITE PROFILE, CORRECTED (2026-07-27 review). An earlier version of this note claimed tranId
 * dedup reduced the ~48 daily reconciliation ticks to ~3 file writes. That was WRONG: _noteCoverage
 * bumps `observations` and `lastObservedAtMs` on every observation that returns at least one
 * funding row, so `coverageChanged` is true and _save() runs on essentially EVERY tick that sees
 * funding — ~48 whole-file writes/day, not ~3. Kept as-is rather than "optimised" away, because the
 * counter and lastObservedAtMs ARE the coverage evidence and deferring them would lose up to 8h of
 * "we looked" proof across a restart. The real cost is a synchronous JSON.stringify + writeFileSync
 * of ≤ ~550 KB (single-digit ms) ~48×/day, inside a route handler that is not on the order path —
 * far below LiveExecutionStore.save(), which rewrites ~425 KB many times per minute. Stated
 * precisely so nobody signs this off against a figure that is 16× optimistic.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { FuturesIncomeEntry } from "./binance-futures-private.js";

/** Binance's income-ledger type string for a funding payment/charge. Same literal as
 *  wallet-reconciliation.ts's FUNDING_FEE_INCOME_TYPE; duplicated rather than imported so this
 *  module has no dependency on the reconciliation report path it observes. */
export const FUNDING_FEE_INCOME_TYPE = "FUNDING_FEE";

/** FIFO cap on persisted rows (oldest dropped first). See the header's sizing note. */
export const MAX_FUNDING_ROWS = 5000;
/** Rows older than this are dropped by pruneExpired() even below the FIFO cap. */
export const RETENTION_MS = 180 * 24 * 3_600_000;
/** Cap on retained per-UTC-day coverage rows (oldest day dropped first). */
export const MAX_COVERAGE_DAYS = 400;
/** The `limit` the observed /fapi/v1/income call actually uses, and therefore the row count at which
 *  its page is SATURATED. binance-futures-private.ts's getIncomeHistory defaults `limit` to 1000 and
 *  LiveExecutionEngine.getIncomeHistory passes none, so 1000 is the effective value; it is the same
 *  number wallet-reconciliation.ts already calls INCOME_FETCH_LIMIT for its own possiblyTruncated
 *  flag. Restated here rather than imported so this module keeps its zero-dependency stance on the
 *  report path it observes — if the client default ever moves, BOTH must move. */
export const INCOME_PAGE_LIMIT = 1000;

/**
 * One funding charge exactly as Binance reported it. Nothing derived, nothing rounded.
 * `income` keeps Binance's own SIGN convention: negative = we paid funding, positive = we received
 * it. Do not flip it on the way in — a stored figure that disagrees with /fapi/v1/income in sign
 * is worse than no figure at all.
 */
export interface FundingFeeRow {
  /** Binance transaction id, TYPED AND STORED as a string, and the exact-once dedup key for this
   *  store.
   *
   *  READ THE PRECISION CAVEAT (corrected 2026-07-27): the string type is this store's guarantee,
   *  NOT an end-to-end one. binance-futures-private.ts maps tranId with toStrId over an
   *  ALREADY-JSON.parse'd value and deliberately does NOT route it through preserveOrderIdPrecision
   *  (see FuturesIncomeEntry's doc comment for why), so a tranId above 2^53 would arrive here having
   *  already been rounded. The consequence is bounded and one-directional: two rounded-equal tranIds
   *  would collapse to one key and this store would UNDER-count by a row, never double-count — the
   *  rounding is deterministic, so dedup stays stable across re-fetches. Observed income tranIds are
   *  ~10-13 digits, far below the threshold. Do not read this field as proof of exchange-exact
   *  precision; it is proof of stable typing. */
  tranId: string;
  symbol: string;
  income: number;
  asset: string;
  /** Exchange-stamped epoch ms of the charge. */
  time: number;
}

/** Proof of what this store actually LOOKED at, per UTC day — the difference between "no funding
 *  was charged" and "we never observed that day". See the header's coverage note. */
export interface FundingDayCoverage {
  dayUtc: string;
  /** Local epoch ms of the first/last observation that reported rows for this day. */
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  /** How many separate observations touched this day. */
  observations: number;
  /** True when at least ONE observation of this day came from a SATURATED income page (rows ===
   *  INCOME_PAGE_LIMIT), so funding rows may have been cut off the page edge and are permanently
   *  absent from this store. LATCHED — never cleared by a later clean observation, because a
   *  non-saturated page only proves completeness for the window that call used and this module is
   *  not told the window. Absent/undefined = no saturated page was ever observed for this day
   *  (including days recorded before this field existed, which is why it is optional rather than
   *  defaulted to false — `false` would assert a check that never ran). */
  possiblyTruncated?: boolean;
}

interface FundingFeeRecorderState {
  version: number;
  /** Ascending by `time`, bounded to MAX_FUNDING_ROWS. */
  rows: FundingFeeRow[];
  /** Ascending by dayUtc, bounded to MAX_COVERAGE_DAYS. */
  coverage: FundingDayCoverage[];
}

function emptyState(): FundingFeeRecorderState {
  return { version: 1, rows: [], coverage: [] };
}

function utcDayOf(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function sanitizeRow(raw: unknown): FundingFeeRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<FundingFeeRow>;
  if (typeof r.tranId !== "string" || r.tranId.length === 0) return null;
  if (typeof r.symbol !== "string") return null;
  if (!Number.isFinite(r.income) || !Number.isFinite(r.time)) return null;
  return {
    tranId: r.tranId,
    symbol: r.symbol,
    income: r.income as number,
    asset: typeof r.asset === "string" ? r.asset : "",
    time: r.time as number,
  };
}

function sanitizeCoverage(raw: unknown): FundingDayCoverage | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<FundingDayCoverage>;
  if (typeof c.dayUtc !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.dayUtc)) return null;
  if (!Number.isFinite(c.firstObservedAtMs) || !Number.isFinite(c.lastObservedAtMs)) return null;
  return {
    dayUtc: c.dayUtc,
    firstObservedAtMs: c.firstObservedAtMs as number,
    lastObservedAtMs: c.lastObservedAtMs as number,
    observations: Number.isFinite(c.observations) ? Math.max(1, Math.floor(c.observations as number)) : 1,
    // Only ever carried forward when explicitly true — an absent flag stays absent (see the field
    // doc: `false` would assert a truncation check that never ran on that day's record).
    ...(c.possiblyTruncated === true ? { possiblyTruncated: true as const } : {}),
  };
}

export class FundingFeeRecorder {
  private readonly file: string;
  private state: FundingFeeRecorderState;
  /** O(1) dedup index over state.rows' tranIds, rebuilt on load and maintained on insert. */
  private seenTranIds: Set<string>;
  private dirty = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "funding-fees.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    this.seenTranIds = new Set(this.state.rows.map((r) => r.tranId));
  }

  get path(): string {
    return this.file;
  }

  private _load(): FundingFeeRecorderState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const raw = parsed as Partial<FundingFeeRecorderState>;
        const seen = new Set<string>();
        const rows = (Array.isArray(raw.rows) ? raw.rows : [])
          .map(sanitizeRow)
          .filter((r): r is FundingFeeRow => {
            if (r === null || seen.has(r.tranId)) return false;
            seen.add(r.tranId);
            return true;
          })
          .sort((a, b) => a.time - b.time)
          .slice(-MAX_FUNDING_ROWS);
        const coverage = (Array.isArray(raw.coverage) ? raw.coverage : [])
          .map(sanitizeCoverage)
          .filter((c): c is FundingDayCoverage => c !== null)
          .sort((a, b) => (a.dayUtc < b.dayUtc ? -1 : a.dayUtc > b.dayUtc ? 1 : 0))
          .slice(-MAX_COVERAGE_DAYS);
        return { version: 1, rows, coverage };
      }
    } catch {
      // corrupt/partial — restart from empty; funding recording restarts, trading unaffected
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): FundingFeeRecorderState {
    return this.state;
  }

  /**
   * Record every FUNDING_FEE row in an ALREADY-FETCHED income page. Non-funding income types are
   * ignored (REALIZED_PNL/COMMISSION are already covered per-trade by the executors' own
   * getUserTrades settlement, and mixing account-level rows in here would double-count them).
   * Idempotent by tranId, so the same UTC day can be re-observed every 30 minutes forever without
   * double-booking a single charge. Never throws; never performs I/O against the exchange.
   *
   * `observedAtMs` is the LOCAL clock (when we looked), deliberately distinct from a row's `time`
   * (the exchange clock, when the charge happened) — the coverage map is a statement about our
   * observation, not about the exchange.
   *
   * `opts.pageSaturated` is the CALLER's statement that the income page it observed came back full
   * (rows === INCOME_PAGE_LIMIT), i.e. rows may have been cut off its edge. It is latched onto every
   * UTC day this call touched, so a consumer can tell a healthy observation from one that could not
   * have seen the whole day. Omitted = unknown, which leaves the flag alone rather than asserting
   * completeness.
   *
   * Returns the count of genuinely-new rows stored (0 on any failure and on the already-seen case).
   * NOTE it does NOT follow that a 0 return skipped the file write: the coverage counter and
   * lastObservedAtMs move on every observation that saw funding, so the write happens then too —
   * see the header's WRITE PROFILE, CORRECTED note.
   */
  recordIncomeEntries(
    entries: readonly FuturesIncomeEntry[],
    observedAtMs: number = Date.now(),
    opts: { pageSaturated?: boolean } = {},
  ): number {
    try {
      if (!Array.isArray(entries)) return 0;
      const now = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
      let added = 0;
      const touchedDays = new Set<string>();
      for (const entry of entries) {
        if (!entry || entry.incomeType !== FUNDING_FEE_INCOME_TYPE) continue;
        const row = sanitizeRow({
          tranId: entry.tranId,
          symbol: entry.symbol,
          income: entry.income,
          asset: entry.asset,
          time: entry.time,
        });
        // A funding row with no tranId or a non-finite time cannot be deduped or ordered, and a
        // store that silently accepted it would double-book it on the next overlapping fetch.
        // Dropping is the honest failure: an under-count is visible against the exchange's own
        // income ledger, a double-count is not.
        if (row === null) continue;
        touchedDays.add(utcDayOf(row.time));
        if (this.seenTranIds.has(row.tranId)) continue;
        this.seenTranIds.add(row.tranId);
        this.state.rows.push(row);
        added += 1;
      }
      if (added > 0) {
        this.state.rows.sort((a, b) => a.time - b.time);
        if (this.state.rows.length > MAX_FUNDING_ROWS) {
          const dropped = this.state.rows.slice(0, this.state.rows.length - MAX_FUNDING_ROWS);
          this.state.rows = this.state.rows.slice(-MAX_FUNDING_ROWS);
          for (const d of dropped) this.seenTranIds.delete(d.tranId);
        }
      }
      const coverageChanged = this._noteCoverage(touchedDays, now, opts.pageSaturated === true);
      if (added > 0 || coverageChanged) {
        this.dirty = true;
        this._save();
      }
      return added;
    } catch {
      return 0; // report-only bookkeeping never throws into a caller
    }
  }

  /** Stamp/refresh the per-UTC-day observation record. Returns whether anything changed.
   *  `pageSaturated` LATCHES possiblyTruncated true on every day this observation touched and never
   *  clears it — see FundingDayCoverage.possiblyTruncated. */
  private _noteCoverage(days: ReadonlySet<string>, observedAtMs: number, pageSaturated: boolean): boolean {
    let changed = false;
    for (const dayUtc of days) {
      const existing = this.state.coverage.find((c) => c.dayUtc === dayUtc);
      if (existing) {
        // Only a genuinely LATER observation moves lastObservedAtMs — a clock step backwards must
        // not rewrite history into a narrower window than we actually covered.
        if (observedAtMs > existing.lastObservedAtMs) existing.lastObservedAtMs = observedAtMs;
        if (observedAtMs < existing.firstObservedAtMs) existing.firstObservedAtMs = observedAtMs;
        existing.observations += 1;
        if (pageSaturated) existing.possiblyTruncated = true;
        changed = true;
      } else {
        this.state.coverage.push({
          dayUtc,
          firstObservedAtMs: observedAtMs,
          lastObservedAtMs: observedAtMs,
          observations: 1,
          ...(pageSaturated ? { possiblyTruncated: true as const } : {}),
        });
        changed = true;
      }
    }
    if (changed) {
      this.state.coverage.sort((a, b) => (a.dayUtc < b.dayUtc ? -1 : a.dayUtc > b.dayUtc ? 1 : 0));
      if (this.state.coverage.length > MAX_COVERAGE_DAYS) {
        this.state.coverage = this.state.coverage.slice(-MAX_COVERAGE_DAYS);
      }
    }
    return changed;
  }

  /** All persisted funding rows, oldest-first. Optional symbol / [fromMs, toMs) filters. Never
   *  throws. The result is a copy — callers cannot mutate the store through it. */
  listFundingRows(opts: { symbol?: string; fromMs?: number; toMs?: number } = {}): FundingFeeRow[] {
    try {
      return this.state.rows.filter((r) => {
        if (opts.symbol !== undefined && r.symbol !== opts.symbol) return false;
        if (opts.fromMs !== undefined && r.time < opts.fromMs) return false;
        if (opts.toMs !== undefined && r.time >= opts.toMs) return false;
        return true;
      }).map((r) => ({ ...r }));
    } catch {
      return [];
    }
  }

  /** Signed USD-equivalent funding total over the same filters (negative = net paid). Never
   *  throws. ALWAYS pair this with getDayCoverage() before presenting it — an unobserved day
   *  contributes 0 here and is indistinguishable from a zero-funding day without it. */
  sumFundingUsd(opts: { symbol?: string; fromMs?: number; toMs?: number } = {}): number {
    try {
      return this.listFundingRows(opts).reduce((sum, r) => sum + r.income, 0);
    } catch {
      return 0;
    }
  }

  /** Per-UTC-day observation record, oldest-first. Never throws. */
  getDayCoverage(): FundingDayCoverage[] {
    try {
      return this.state.coverage.map((c) => ({ ...c }));
    } catch {
      return [];
    }
  }

  /** Drop rows past RETENTION_MS (and coverage rows for days entirely outside it). Never throws. */
  pruneExpired(nowMs = Date.now()): { droppedRows: number; droppedDays: number } {
    try {
      const cutoff = nowMs - RETENTION_MS;
      const beforeRows = this.state.rows.length;
      const kept = this.state.rows.filter((r) => r.time >= cutoff);
      const droppedRows = beforeRows - kept.length;
      if (droppedRows > 0) {
        for (const r of this.state.rows) if (r.time < cutoff) this.seenTranIds.delete(r.tranId);
        this.state.rows = kept;
      }
      const cutoffDay = utcDayOf(cutoff);
      const beforeDays = this.state.coverage.length;
      this.state.coverage = this.state.coverage.filter((c) => c.dayUtc >= cutoffDay);
      const droppedDays = beforeDays - this.state.coverage.length;
      if (droppedRows > 0 || droppedDays > 0) {
        this.dirty = true;
        this._save();
      }
      return { droppedRows, droppedDays };
    } catch {
      return { droppedRows: 0, droppedDays: 0 };
    }
  }

  /** Persist now if anything changed since the last write. A no-op while clean. Never throws. */
  flush(): void {
    if (this.dirty) this._save();
  }

  private _save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // persistence failures must never break the caller
    }
  }
}

let singleton: FundingFeeRecorder | null = null;
export function getFundingFeeRecorder(dataDir = "data"): FundingFeeRecorder {
  if (!singleton) singleton = new FundingFeeRecorder(dataDir);
  return singleton;
}
export function _resetFundingFeeRecorderForTests(): void {
  singleton = null;
}

/**
 * Whether funding recording is enabled for this process.
 *
 * DEFAULT ON, opt-OUT via FUNDING_FEE_RECORDING=0. This deviates from the usual default-off
 * posture for anything near the live path, deliberately and on narrow grounds: this feature adds
 * NO exchange interaction (it observes a fetch that already happens), never touches the order
 * path, is fail-open at every call, and is hard-bounded under 1 MB. A default-off recorder would
 * simply continue the status quo — funding persisted nowhere — until somebody remembered to set a
 * flag, which is the exact "measurement blocked by its own params" failure this codebase has been
 * bitten by before. The operator keeps a one-variable kill switch.
 */
export function fundingFeeRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FUNDING_FEE_RECORDING !== "0";
}

/** Minimal shape withFundingFeeRecording needs — structurally identical to
 *  wallet-reconciliation.ts's LiveEngineReconciliationSource, restated here so this module does not
 *  import from the report path it observes. */
export interface IncomeHistorySource {
  getIncomeHistory(startTimeMs: number, endTimeMs: number): Promise<FuturesIncomeEntry[]>;
}

/**
 * READ-THROUGH OBSERVER. Returns a decorated view of `source` whose getIncomeHistory forwards
 * verbatim and, on the way back, hands the rows it already fetched to the recorder.
 *
 * WHAT THIS DOES NOT DO: it does not fetch, retry, widen a window, or alter a single argument or
 * return value. The caller sees byte-for-byte what the undecorated source returned, on the same
 * promise, and would see it even if the recorder threw on every call (the record step is wrapped
 * AND the recorder's own methods are individually wrapped — belt and braces, because this sits on
 * a route the live instance polls).
 *
 * EVERY OTHER MEMBER IS PRESERVED, INCLUDING PROTOTYPE METHODS. This is done with a Proxy, not an
 * object spread, and the distinction is not stylistic — it was a real defect caught by
 * test/funding-fee-recorder.test.ts's "PRESERVES every other method" case:
 *
 *   `{ ...source }` copies OWN ENUMERABLE properties only. The one production source is
 *   LiveExecutionEngine, a class whose getStatus()/getIncomeHistory() live on the PROTOTYPE, so the
 *   spread produced an object with NO getStatus at all (and with every private instance field —
 *   `client`, `store` — shallow-copied loose, detached from the methods that own them). The very
 *   next thing buildLiveWalletReconciliationReport does is call engine.getStatus(), so wiring the
 *   spread version in would have thrown "engine.getStatus is not a function" on the FIRST
 *   reconciliation tick and left GET /api/live/wallet-reconciliation returning 502 forever, on the
 *   real-money instance. Report-only in the sense that trading is unaffected — but it would have
 *   silently destroyed the very report this recorder is meant to piggyback on.
 *
 * The Proxy forwards every other property to the target with `this` bound to the ORIGINAL source,
 * so private-field access inside those methods keeps working.
 */
export function withFundingFeeRecording<T extends IncomeHistorySource>(
  source: T,
  opts: { recorder?: Pick<FundingFeeRecorder, "recordIncomeEntries">; enabled?: boolean; nowMs?: () => number } = {},
): T {
  try {
    if (opts.enabled === false || (opts.enabled === undefined && !fundingFeeRecordingEnabled())) return source;
    const recorder = opts.recorder ?? getFundingFeeRecorder();
    const nowMs = opts.nowMs ?? (() => Date.now());
    const observed = async (startTimeMs: number, endTimeMs: number) => {
      const entries = await source.getIncomeHistory(startTimeMs, endTimeMs);
      try {
        // A FULL page means Binance may have cut rows off its edge — and this page is UNFILTERED
        // by incomeType, so COMMISSION/REALIZED_PNL rows compete for the same 1000 slots and can
        // push a late funding charge out on a heavy trading day. Passed through so the coverage row
        // records it instead of reading as a healthy, complete observation (2026-07-27 review).
        const pageSaturated = Array.isArray(entries) && entries.length >= INCOME_PAGE_LIMIT;
        recorder.recordIncomeEntries(entries, nowMs(), { pageSaturated });
      } catch {
        // unreachable in practice (recordIncomeEntries is itself wrapped) — kept so a future
        // recorder implementation can never leak an exception into a live route handler.
      }
      return entries;
    };
    return new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === "getIncomeHistory") return observed;
        // `target` (not the proxy) is the receiver on purpose: a prototype GETTER would otherwise
        // run with `this` === the proxy, and a #private-field read inside it would throw. Methods
        // are bound to the source for exactly the same reason.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  } catch {
    return source; // wiring failure must degrade to "no recording", never to a broken report
  }
}

// ── attribution (PURE DERIVATION — not a recording) ──────────────────────────

/** One position's open interval, as the caller understands it. `toMs` may be null for a still-open
 *  position (treated as "open through the end of time"). `weight` is an optional relative share
 *  (normally notional) used to split a charge across positions that overlapped the same instant on
 *  the same symbol; omitted/non-positive weights fall back to an equal split. */
export interface FundingAttributionInterval {
  key: string;
  symbol: string;
  fromMs: number;
  toMs: number | null;
  weight?: number;
}

export interface FundingAttributionResult {
  /** Signed USD funding assigned to each interval key (negative = paid). */
  byKey: Map<string, number>;
  /** Signed USD funding that matched NO interval — reported, never spread. A large value here
   *  means the interval set is incomplete, not that funding was free. */
  unattributedUsd: number;
  /** Row counts behind the two figures above, so a caller can tell one huge orphan charge from
   *  many small ones. */
  attributedRows: number;
  unattributedRows: number;
}

/**
 * Split funding rows across the position intervals that were open on the same symbol at the
 * charge instant.
 *
 * THIS IS A DERIVATION, NOT A MEASUREMENT. Binance's income ledger carries no position or order
 * id (see FuturesIncomeEntry), so a charge on a symbol held by two lanes simultaneously genuinely
 * cannot be assigned from exchange data alone — the split below is a MODEL. Never persist its
 * output back into a position record as though it were observed. Pure and I/O-free by design so
 * the modelling choice stays visible, testable and replaceable.
 *
 * Interval membership is [fromMs, toMs] INCLUSIVE at both ends: a funding charge landing exactly
 * on an open or close timestamp belongs to that position, and excluding it would silently drop
 * real cost at precisely the 8-hourly boundaries funding lands on.
 */
export function attributeFundingToIntervals(
  rows: readonly FundingFeeRow[],
  intervals: readonly FundingAttributionInterval[],
): FundingAttributionResult {
  const byKey = new Map<string, number>();
  let unattributedUsd = 0;
  let attributedRows = 0;
  let unattributedRows = 0;
  for (const row of rows) {
    const overlapping = intervals.filter(
      (iv) => iv.symbol === row.symbol && row.time >= iv.fromMs && (iv.toMs === null || row.time <= iv.toMs),
    );
    if (overlapping.length === 0) {
      unattributedUsd += row.income;
      unattributedRows += 1;
      continue;
    }
    attributedRows += 1;
    const weights = overlapping.map((iv) => (Number.isFinite(iv.weight) && (iv.weight as number) > 0 ? (iv.weight as number) : 0));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    overlapping.forEach((iv, i) => {
      const share = totalWeight > 0 ? weights[i]! / totalWeight : 1 / overlapping.length;
      byKey.set(iv.key, (byKey.get(iv.key) ?? 0) + row.income * share);
    });
  }
  return { byKey, unattributedUsd, attributedRows, unattributedRows };
}

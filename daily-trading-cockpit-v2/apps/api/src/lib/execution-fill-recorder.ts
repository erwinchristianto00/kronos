/**
 * PER-FILL EXECUTION RECORDER (2026-07-26, REPORT-ONLY).
 *
 * WHY: Binance's /fapi/v1/userTrades returns, per fill, `price`, `qty`, `commission`,
 * `commissionAsset`, `realizedPnl`, `time` and `orderId` — and all three consumers in this repo
 * keep exactly TWO of them:
 *   - single-symbol-lane-executor.ts sumOwnRealizedTrades()  → realizedPnl + commission
 *     (price×qty is collapsed into ONE qty-weighted average exit price and the per-fill rows are
 *     discarded);
 *   - live-execution-engine.ts realizedFromTrades()          → realizedPnl + commission only —
 *     every price is thrown away;
 *   - cross-sectional-executor.ts closeBasket()              → commission only.
 * The consequence, measured on the live store: across every closed intent there is NO exit fill
 * price recorded anywhere, so no fill can ever be compared against what the book was showing, no
 * partial fill can be reconstructed, and the exchange's own per-fill commission cannot be audited
 * after the fact — only the summed scalar we chose to keep.
 *
 * WHY A NEW STORE RATHER THAN EXTENDING AN EXISTING ONE: there is no single store to extend —
 * three divergent shapes across ten files (LiveIntent in data/live-execution.json,
 * SingleSymbolPosition in the per-lane files, ExecutorBasket in the xsec files). More decisively,
 * data/live-execution.json is ~425 KB today and is rewritten IN FULL by store.save() on
 * essentially every intent mutation, many times per minute; adding a per-fill array to it would
 * inflate that hot synchronous rewrite. This store is written once per CLOSE (~7×/day live).
 *
 * HARD SAFETY RULE (same as cortex-real-attribution.ts / position-path-recorder.ts): this is
 * bookkeeping ABOUT trading, never part of it. Every public method is wrapped so it can never
 * throw into a caller; a corrupt or unwritable store degrades to "fill recording restarts", never
 * to a trading effect. Every writer injects it optionally — absent, the caller is byte-for-byte
 * unchanged.
 *
 * FIELD AVAILABILITY (deliberate, do not fabricate):
 *   - `maker` IS now mapped (2026-07-26): binance-futures-private.ts's userTrades mapper parses it
 *     as `typeof raw === "boolean" ? raw : undefined`, so it arrives here as a real boolean and is
 *     persisted verbatim. It is the exchange's own confirmation that a fill was taker, which is the
 *     assumption the 5.0 bps/side cost model rests on — the live path only ever places MARKET and
 *     STOP_MARKET. `null` here therefore means UNMEASURED (the exchange did not report a boolean
 *     for that row), NOT "taker": it is never coerced to `false`, because a fabricated `false` is
 *     indistinguishable from a verified taker fill and would destroy the only thing the field is
 *     for. Any maker/taker ratio computed downstream must EXCLUDE `null`, not bucket it as taker.
 *   - `tradeId` IS now mapped too (2026-07-27): the mapper reads Binance's per-fill `id` through
 *     the same toStrId helper as orderId and pins the key with an intersection return type, so it
 *     arrives here as a string and upgrades fillDedupKey from a 5-tuple heuristic to the exchange's
 *     own key. Still read DEFENSIVELY and persisted as `null` when absent or empty — an empty id
 *     must fall back to the tuple key, never collapse every keyless fill onto one identity. Typed
 *     and stored as a STRING: large ids hit the same JSON.parse rounding that caused the -2013
 *     order-id incident. NOTE the mapper's own caveat: `id` is deliberately NOT covered by
 *     preserveOrderIdPrecision (`"id":` is far too generic a key to add to a body-text regex), so a
 *     hypothetical >2^53 id would arrive already rounded — which degrades dedup back to the tuple
 *     fallback and nothing more, because nothing in this repo ever ACTS on a trade id.
 *   - BUY/SELL `side` is still unmapped, as are `quoteQty`, `buyer`, `positionSide`, `marginAsset`.
 *     `role` ("ENTRY"/"EXIT") is recorded instead — it is what the caller actually knows (it
 *     matched the row by orderId) and is the more useful key.
 *
 * BOUNDS (deliberate — the 234 MB unrotated-journal incident is the precedent):
 *   - ≤ MAX_FILL_RECORDS (3000) close records, FIFO by insertion (oldest dropped first).
 *   - ≤ MAX_FILLS_PER_RECORD (40) fills per record; excess is dropped and `truncated` set true —
 *     never silently.
 *   - pruneExpired() drops records older than FILL_RETENTION_MS (90d).
 * Measured live volume is ~7.4 closes/day (182 engine + 25 executor closes in ~28 days), 2 fills
 * per single-symbol close and up to 12 for a 6-leg xsec basket close, so the steady state is
 * ~670 records / ~250 KB and the hard ceiling is ~2 MB. Read once at startup, never per-poll.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Hard cap on retained close records (FIFO, oldest dropped first). */
export const MAX_FILL_RECORDS = 3000;
/** Hard cap on fills retained per close record — excess sets `truncated`. */
export const MAX_FILLS_PER_RECORD = 40;
/** Records older than this are dropped by pruneExpired() even below the FIFO cap. */
export const FILL_RETENTION_MS = 90 * 24 * 3_600_000;

/** Which order of the position this fill belongs to, as determined by the CALLER's own orderId
 *  match. "UNKNOWN" is honest for a matched row whose order id the caller could not classify. */
export type ExecutionFillRole = "ENTRY" | "EXIT" | "UNKNOWN";

/** Which writer produced the record. */
export type ExecutionFillSource = "ssle" | "xsec" | "engine";

/** One exchange fill, persisted verbatim (no rounding — the raw price is the entire point). */
export interface ExecutionFill {
  /** Binance order id. ALWAYS a string (19-digit precision). */
  orderId: string;
  /** Binance trade id as a STRING, or null when the exchange row carried no usable id.
   *  NOTE: Binance's userTrades `id` is a PER-SYMBOL sequence, not an account-global one, so it is
   *  only unique when paired with `symbol` — see fillDedupKey. */
  tradeId: string | null;
  symbol: string;
  role: ExecutionFillRole;
  price: number;
  qty: number;
  /** Positive cost as Binance reports it. */
  commission: number;
  commissionAsset: string;
  /** Binance's own GROSS per-trade realized figure (entry rows are 0). */
  realizedPnl: number;
  /** EXCHANGE-stamped epoch ms for this fill — not our local clock. */
  time: number;
  /** Binance's own liquidity flag for this fill (true = we provided liquidity, false = we crossed
   *  the spread / taker). `null` means UNMEASURED — the exchange reported no boolean for this row —
   *  and must NOT be read as taker. See the header's FIELD AVAILABILITY note. */
  maker: boolean | null;
}

export interface ExecutionFillRecord {
  /** Stable identity — the SAME scheme cortex-real-attribution.ts uses per writer
   *  (`ssle:<laneId>:<positionId>`, `xsec:<laneId>:<basketId>`, `intent:<paperOrderId>:<createdAt>`). */
  recordId: string;
  source: ExecutionFillSource;
  laneId: string;
  symbol: string;
  closedAtMs: number;
  /** False when the caller's trade fetch failed or was cut short, so the fill list is known to be
   *  incomplete. Absent completeness evidence is worse than none — a partial record that looks
   *  whole would be read as "these were all the fills". */
  fetchComplete: boolean;
  /** True when MAX_FILLS_PER_RECORD dropped fills. */
  truncated: boolean;
  fills: ExecutionFill[];
}

interface ExecutionFillRecorderState {
  version: number;
  /** Newest-last, bounded to MAX_FILL_RECORDS. */
  records: ExecutionFillRecord[];
}

function emptyState(): ExecutionFillRecorderState {
  return { version: 1, records: [] };
}

/**
 * Structural shape of one /fapi/v1/userTrades row as this repo's client currently maps it.
 * `tradeId`/`maker` stay `unknown` ON PURPOSE and must not be narrowed: `unknown` accepts both the
 * mapped and the not-yet-mapped state, so this interface needs no edit as the client mapper catches
 * up field by field. BOTH are now supplied by binance-futures-private.ts's userTrades mapper —
 * `maker` as `boolean | undefined` (2026-07-26) and `tradeId` as a string (2026-07-27) — and both
 * satisfy `unknown` unchanged. See the header's FIELD AVAILABILITY block for the authoritative
 * statement; do NOT narrow these two, the whole point is that the mapper can change without this
 * interface changing.
 */
export interface UserTradeLike {
  symbol: string;
  orderId: string;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
  tradeId?: unknown;
  maker?: unknown;
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Map one exchange trade row to a persisted fill. Pure; exported for tests. Never throws for a
 *  malformed row — non-finite numbers degrade to 0 and unmapped optional fields stay null. */
export function fillFromUserTrade(trade: UserTradeLike, role: ExecutionFillRole): ExecutionFill {
  const rawTradeId = (trade as { tradeId?: unknown }).tradeId;
  const rawMaker = (trade as { maker?: unknown }).maker;
  return {
    orderId: String(trade?.orderId ?? ""),
    // A number here would already have been rounded by JSON.parse before we saw it; stringify it
    // anyway so the persisted type is stable once the mapper starts supplying a string.
    tradeId:
      typeof rawTradeId === "string" && rawTradeId.length > 0
        ? rawTradeId
        : typeof rawTradeId === "number" && Number.isFinite(rawTradeId)
          ? String(rawTradeId)
          : null,
    symbol: String(trade?.symbol ?? ""),
    role,
    price: finite(trade?.price),
    qty: finite(trade?.qty),
    commission: finite(trade?.commission),
    commissionAsset: String(trade?.commissionAsset ?? ""),
    realizedPnl: finite(trade?.realizedPnl),
    time: finite(trade?.time),
    maker: typeof rawMaker === "boolean" ? rawMaker : null,
  };
}

/** Exact-once key for one fill. Prefers the exchange's own trade id; falls back to the tuple that
 *  uniquely identifies a fill of one order when no id is present (same order, same exchange
 *  millisecond, same price, same qty, same commission — two DISTINCT fills matching all five would
 *  be byte-identical rows anyway, so collapsing them loses nothing recoverable).
 *
 *  SYMBOL-SCOPED ON PURPOSE (2026-07-27). Binance's /fapi/v1/userTrades `id` is a PER-SYMBOL
 *  counter, NOT an account-global one, and one ExecutionFillRecord can span many symbols — the xsec
 *  writer joins a whole basket's legs into a single record. A bare `t:<id>` therefore lets two
 *  different symbols' fills collide, and recordFills' `seen` set would silently DROP the second one
 *  without setting `truncated`, i.e. a short fill list that reads as complete. The tuple fallback
 *  never had this problem (orderId already implies the symbol) but is prefixed identically for
 *  uniformity. */
export function fillDedupKey(fill: ExecutionFill): string {
  const sym = fill.symbol ?? "";
  if (fill.tradeId !== null && fill.tradeId.length > 0) return `t:${sym}|${fill.tradeId}`;
  return `o:${sym}|${fill.orderId}|${fill.time}|${fill.price}|${fill.qty}|${fill.commission}`;
}

function sanitizeFill(raw: unknown): ExecutionFill | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Partial<ExecutionFill>;
  if (typeof f.orderId !== "string" || f.orderId.length === 0) return null;
  const role: ExecutionFillRole = f.role === "ENTRY" || f.role === "EXIT" ? f.role : "UNKNOWN";
  return {
    orderId: f.orderId,
    tradeId: typeof f.tradeId === "string" && f.tradeId.length > 0 ? f.tradeId : null,
    symbol: typeof f.symbol === "string" ? f.symbol : "",
    role,
    price: finite(f.price),
    qty: finite(f.qty),
    commission: finite(f.commission),
    commissionAsset: typeof f.commissionAsset === "string" ? f.commissionAsset : "",
    realizedPnl: finite(f.realizedPnl),
    time: finite(f.time),
    maker: typeof f.maker === "boolean" ? f.maker : null,
  };
}

function sanitizeRecord(raw: unknown): ExecutionFillRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ExecutionFillRecord>;
  if (typeof r.recordId !== "string" || r.recordId.length === 0) return null;
  const source: ExecutionFillSource =
    r.source === "ssle" || r.source === "xsec" || r.source === "engine" ? r.source : "engine";
  const fills = (Array.isArray(r.fills) ? r.fills : [])
    .map(sanitizeFill)
    .filter((f): f is ExecutionFill => f !== null)
    .slice(0, MAX_FILLS_PER_RECORD);
  return {
    recordId: r.recordId,
    source,
    laneId: typeof r.laneId === "string" ? r.laneId : "UNKNOWN",
    symbol: typeof r.symbol === "string" ? r.symbol : "",
    closedAtMs: finite(r.closedAtMs),
    fetchComplete: r.fetchComplete === true,
    truncated: r.truncated === true,
    fills,
  };
}

export class ExecutionFillRecorder {
  private readonly file: string;
  private state: ExecutionFillRecorderState;
  private readonly index = new Map<string, ExecutionFillRecord>();
  private dirty = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "execution-fills.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    for (const record of this.state.records) this.index.set(record.recordId, record);
  }

  get path(): string {
    return this.file;
  }

  private _load(): ExecutionFillRecorderState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) {
        const records = ((parsed as { records: unknown[] }).records)
          .map(sanitizeRecord)
          .filter((r): r is ExecutionFillRecord => r !== null)
          .slice(-MAX_FILL_RECORDS);
        // A duplicated recordId in a hand-edited/partially-written file must not produce two index
        // entries pointing at different objects — keep the newest.
        const deduped = new Map<string, ExecutionFillRecord>();
        for (const record of records) deduped.set(record.recordId, record);
        return { version: 1, records: [...deduped.values()] };
      }
    } catch {
      // corrupt/partial — restart from empty; fill recording restarts, trading unaffected
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): ExecutionFillRecorderState {
    return this.state;
  }

  hasRecorded(recordId: string): boolean {
    try {
      return typeof recordId === "string" && this.index.has(recordId);
    } catch {
      return false;
    }
  }

  /**
   * Record (or merge into) one close's fills. Never throws. Returns true when anything was stored.
   *
   * Idempotent by construction: a repeat call with the same recordId merges only fills whose
   * dedup key is not already present, so a caller may record the same close more than once (a
   * partial-fill cycle re-queries the SAME entry rows on every settle) without double-booking.
   * `fetchComplete` is latched true — one complete observation is enough to mark the fill list
   * whole, and a later partial re-observation must not un-mark it.
   */
  recordFills(
    input: {
      recordId: string;
      source: ExecutionFillSource;
      laneId: string;
      symbol: string;
      closedAtMs: number;
      fetchComplete: boolean;
      fills: ExecutionFill[];
    },
    opts?: { deferSave?: boolean },
  ): boolean {
    try {
      if (!input || typeof input.recordId !== "string" || input.recordId.length === 0) return false;
      const incoming = (Array.isArray(input.fills) ? input.fills : [])
        .map((f) => sanitizeFill(f))
        .filter((f): f is ExecutionFill => f !== null);
      if (incoming.length === 0) return false; // nothing observed — record nothing, invent nothing

      let record = this.index.get(input.recordId);
      if (!record) {
        record = {
          recordId: input.recordId,
          source: input.source === "ssle" || input.source === "xsec" || input.source === "engine" ? input.source : "engine",
          laneId: typeof input.laneId === "string" ? input.laneId : "UNKNOWN",
          symbol: typeof input.symbol === "string" ? input.symbol : "",
          closedAtMs: Number.isFinite(input.closedAtMs) ? input.closedAtMs : Date.now(),
          fetchComplete: input.fetchComplete === true,
          truncated: false,
          fills: [],
        };
        this.index.set(record.recordId, record);
        this.state.records.push(record);
        if (this.state.records.length > MAX_FILL_RECORDS) {
          const dropped = this.state.records.splice(0, this.state.records.length - MAX_FILL_RECORDS);
          for (const d of dropped) this.index.delete(d.recordId);
        }
      } else {
        // Merge into an existing record. `fetchComplete` is LATCHED true — one complete
        // observation is enough; a later partial re-observation must not un-mark it.
        if (input.fetchComplete === true) record.fetchComplete = true;
        // closedAtMs advances to the newest observation: a partial-fill cycle records mid-life
        // (position still OPEN) and the full close records afterwards, and the close time is the
        // one retention and any report should key on.
        if (Number.isFinite(input.closedAtMs) && input.closedAtMs > record.closedAtMs) {
          record.closedAtMs = input.closedAtMs;
        }
      }

      const seen = new Set(record.fills.map(fillDedupKey));
      let added = 0;
      for (const fill of incoming) {
        const key = fillDedupKey(fill);
        if (seen.has(key)) continue;
        if (record.fills.length >= MAX_FILLS_PER_RECORD) {
          record.truncated = true;
          break;
        }
        seen.add(key);
        record.fills.push(fill);
        added += 1;
      }
      // Sort by exchange time so a merged record still reads chronologically (stable for equal ts).
      if (added > 0) record.fills.sort((a, b) => a.time - b.time);

      this.dirty = true;
      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false; // report-only bookkeeping never throws into a trading path
    }
  }

  getRecord(recordId: string): ExecutionFillRecord | null {
    try {
      return this.index.get(recordId) ?? null;
    } catch {
      return null;
    }
  }

  /** Oldest-first. Never throws. */
  listRecords(): ExecutionFillRecord[] {
    try {
      return [...this.state.records];
    } catch {
      return [];
    }
  }

  /** Drop records older than FILL_RETENTION_MS. Never throws. */
  pruneExpired(nowMs = Date.now(), opts?: { deferSave?: boolean }): number {
    try {
      const before = this.state.records.length;
      const kept = this.state.records.filter((r) => nowMs - r.closedAtMs <= FILL_RETENTION_MS);
      const dropped = before - kept.length;
      if (dropped > 0) {
        this.state.records = kept;
        this.index.clear();
        for (const r of kept) this.index.set(r.recordId, r);
        this.dirty = true;
        if (!opts?.deferSave) this._save();
      }
      return dropped;
    } catch {
      return 0;
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

let singleton: ExecutionFillRecorder | null = null;
export function getExecutionFillRecorder(dataDir = "data"): ExecutionFillRecorder {
  if (!singleton) singleton = new ExecutionFillRecorder(dataDir);
  return singleton;
}
export function _resetExecutionFillRecorderForTests(): void {
  singleton = null;
}

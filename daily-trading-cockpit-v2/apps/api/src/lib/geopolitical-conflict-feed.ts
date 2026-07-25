/**
 * GEOPOLITICAL CONFLICT-ESCALATION FEED (pure data-collection module, report-only).
 *
 * WHAT THIS IS: a quantitative, non-LLM, non-fuzzy conflict-escalation signal sourced from GDELT
 * (the free, keyless Global Database of Events, Language, and Tone — https://www.gdeltproject.org):
 *
 *   - GDELT DOC 2.0 API (https://api.gdeltproject.org/api/v2/doc/doc?query=...&mode=artlist&format=json)
 *     — free-text news-article search, useful for headline-level context.
 *   - GDELT Event Database (https://api.gdeltproject.org/api/v2/events/events?query=...&format=json)
 *     — the QUANTITATIVE leg this module actually scores: every event carries a CAMEO event code
 *     and a Goldstein Scale score (−10 fully cooperative .. +10 fully cooperative — actually the
 *     scale runs −10 fully conflictual/cooperative-hostile to +10 fully cooperative; see below) —
 *     numbers, not headline vibes.
 *
 * GOLDSTEIN SCALE: a fixed, CAMEO-code-indexed weight from −10 (most conflictual, e.g. "engage in
 * mass killings") to +10 (most cooperative, e.g. "engage in diplomatic cooperation"). It is a
 * LOOKUP TABLE keyed by event type, not a sentiment model — the same event code always gets the
 * same Goldstein value. That is what makes it usable as a hard signal instead of an LLM's fuzzy
 * read of a headline.
 *
 * CAMEO TAXONOMY (the event-code reference table GDELT publishes, derived from the CAMEO codebook —
 * Gerner/Schrodt/Yilmaz/Abu-Jabr): 20 root categories grouped into 4 "quad classes":
 *   01-05  Verbal Cooperation      06-08  Material Cooperation
 *   09-16  Verbal Conflict         17-20  Material Conflict
 * Root 19 = FIGHT (use of conventional military force — codes 190 "use conventional military force,
 * not specified below" through ~196 "violate ceasefire") and root 20 = USE UNCONVENTIONAL MASS
 * VIOLENCE (codes 200 "use unconventional violence, not specified below" through 204+ "use weapons
 * of mass destruction"). THAT is the "codes in the 190-200 range" this module was asked to key off:
 * roots 19-20, i.e. events coded as actual force/mass-violence rather than posture or coercion.
 * "High severity" for computeConflictIntensity below is the wider VERBAL_CONFLICT ∪ MATERIAL_CONFLICT
 * band (roots 09-20) — everything that is not simple cooperation/statement — with the narrower
 * 19-20 "mass violence" band exposed separately (isMassViolenceCameo, buildConflictFeedReport) for
 * anyone who wants the stricter signal.
 *
 * SCOPE / KEYWORD FILTER: this module targets Iran/Israel/US military-conflict escalation
 * specifically (see DEFAULT_CONFLICT_KEYWORDS) — not general geopolitics. It is NOT a general
 * newsfeed and does not attempt sentiment analysis; every number it reports traces back to a GDELT
 * event id + CAMEO code + Goldstein score, inspectable by anyone (house rule: no black-box scores).
 *
 * PURE vs I/O split (house convention):
 *   - computeConflictIntensity: pure aggregation over an array of already-fetched GdeltEvent — no
 *     fetch, no clock reads beyond the caller-supplied nowMs.
 *   - fetchRecentConflictEvents: the only I/O. Bounded-timeout fetch (AbortController, same idiom
 *     as nvidia-chat-client.ts's requestModelTurn), fetchImpl-injected for testability, and
 *     FAIL-OPEN ON ANY FAILURE: bad JSON, non-2xx, timeout, thrown network error, or an
 *     unrecognized response shape all degrade to { events: [], error: <reason> } — it NEVER throws
 *     uncaught and NEVER fabricates events. Empty/no-signal is the safe direction for a module that
 *     only measures; a false "no escalation" is far less dangerous downstream than a fabricated one.
 *   - GeopoliticalConflictFeedStore: bounded, atomic-write (tmp+rename, same idiom as
 *     liq-recoil-edge.ts / funding-carry-edge.ts), deduplicated-by-id persistence. Despite the
 *     informal "JSONL" framing in the spec, every *-edge.ts store in this codebase persists ONE
 *     atomic JSON document (not line-delimited JSON) — mirrored here for consistency rather than
 *     inventing a new on-disk format.
 *
 * KILL SWITCH: GEOPOLITICAL_FEED_DISABLED. Default is ENABLED (feed runs) — unlike execution-facing
 * lanes in this repo, this module only collects/aggregates public news-event data; it places no
 * orders, sizes no positions, and gates no trading decision by itself, so a default-off action-gate
 * is not required. Set GEOPOLITICAL_FEED_DISABLED=1 to stop the collection cycle from fetching
 * (existing stored data and the pure aggregation functions are unaffected — this only gates the I/O
 * cycle's network call).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function envNumPos(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ── CAMEO taxonomy (pure) ────────────────────────────────────────────────────

/** Verbal-conflict quad class: CAMEO root categories 09-16 (Disapprove .. Reduce relations). */
export const CAMEO_VERBAL_CONFLICT_ROOT_MIN = 9;
export const CAMEO_VERBAL_CONFLICT_ROOT_MAX = 16;
/** Material-conflict quad class: CAMEO root categories 17-20 (Coerce, Assault, Fight, Unconventional
 *  mass violence) — the broader "high severity" band used by computeConflictIntensity. */
export const CAMEO_MATERIAL_CONFLICT_ROOT_MIN = 17;
export const CAMEO_MATERIAL_CONFLICT_ROOT_MAX = 20;
/** The narrower "actual force" band cited in the task spec as "codes in the 190-200 range": CAMEO
 *  root 19 (FIGHT — use of conventional military force) and root 20 (USE UNCONVENTIONAL MASS
 *  VIOLENCE). Exposed separately via isMassViolenceCameo / massViolenceCount for callers who want
 *  the stricter signal instead of the full verbal+material conflict band. */
export const CAMEO_MASS_VIOLENCE_ROOT_MIN = 19;
export const CAMEO_MASS_VIOLENCE_ROOT_MAX = 20;

/** CAMEO event codes are 2-4 digit strings (optionally zero-padded); the ROOT category is always
 *  the first two digits (e.g. "193" → root 19, "010" → root 01, "2041" → root 20). Returns null for
 *  anything that doesn't parse as a CAMEO code — callers must treat that as "unclassifiable", never
 *  as a default severity. */
export function cameoRoot(code: string): number | null {
  const trimmed = code.trim();
  if (!/^\d{2,4}$/.test(trimmed)) return null;
  const root = Number(trimmed.slice(0, 2));
  return Number.isFinite(root) ? root : null;
}

/** High severity = Verbal Conflict ∪ Material Conflict (CAMEO roots 09-20) — see module header for
 *  the taxonomy citation. */
export function isHighSeverityCameo(code: string): boolean {
  const root = cameoRoot(code);
  return root !== null && root >= CAMEO_VERBAL_CONFLICT_ROOT_MIN && root <= CAMEO_MATERIAL_CONFLICT_ROOT_MAX;
}

/** The narrower "actual force / mass violence" band (CAMEO roots 19-20 — the "190-200 range"). */
export function isMassViolenceCameo(code: string): boolean {
  const root = cameoRoot(code);
  return root !== null && root >= CAMEO_MASS_VIOLENCE_ROOT_MIN && root <= CAMEO_MASS_VIOLENCE_ROOT_MAX;
}

// ── event type + intensity aggregation (pure) ────────────────────────────────

export interface GdeltEvent {
  /** GDELT GLOBALEVENTID (or the DOC API's article-level id) — the stable dedup key. */
  id: string;
  /** Event/publish date, epoch ms. */
  dateMs: number;
  /** Raw CAMEO event code, e.g. "190". */
  cameoCode: string;
  /** GDELT's fixed CAMEO-indexed Goldstein Scale weight (−10..+10), null when the source omitted it
   *  — NEVER defaulted to 0 (0 is a real, cooperative-neutral value, not "unknown"). */
  goldsteinScale: number | null;
  actor1: string | null;
  actor2: string | null;
  sourceUrl: string | null;
  /** Headline text when the source provided one (DOC-API-style records); null for pure Event-DB rows. */
  title: string | null;
  numMentions: number | null;
  /** Precomputed at parse time from cameoCode — see isHighSeverityCameo. */
  isHighSeverity: boolean;
}

export interface ConflictIntensity {
  /** Count of events with dateMs inside [nowMs − windowMs, nowMs] (both ends inclusive). */
  eventCount: number;
  /** Mean Goldstein Scale over in-window events that carried one; null when zero such events —
   *  NEVER fabricated as 0 (0 is a valid cooperative-neutral score). */
  meanGoldstein: number | null;
  /** Count of in-window events whose CAMEO root falls in the Verbal+Material Conflict band (09-20). */
  highSeverityCount: number;
  windowMs: number;
}

/**
 * Pure aggregation over already-fetched events: trailing-window event count, mean Goldstein Scale
 * (null — not 0 — when no in-window event carried one), and a high-severity CAMEO count. Window is
 * [nowMs − windowMs, nowMs], both boundaries inclusive (same convention as
 * evaluateLiquidationFlowGate's windowStartMs/nowMs bounds in liq-recoil-edge.ts).
 */
export function computeConflictIntensity(events: readonly GdeltEvent[], nowMs: number, windowMs: number): ConflictIntensity {
  const windowStartMs = nowMs - windowMs;
  const inWindow = events.filter((e) => finite(e.dateMs) && e.dateMs >= windowStartMs && e.dateMs <= nowMs);
  const withGoldstein = inWindow.filter((e) => finite(e.goldsteinScale));
  return {
    eventCount: inWindow.length,
    meanGoldstein: withGoldstein.length ? mean(withGoldstein.map((e) => e.goldsteinScale as number)) : null,
    highSeverityCount: inWindow.filter((e) => e.isHighSeverity).length,
    windowMs,
  };
}

// ── keyword scope filter (pure) ──────────────────────────────────────────────

/** Iran/Israel/US military-conflict escalation scope (see module header — this is deliberately
 *  narrow, not a general newsfeed filter). Env-overridable via fetch opts.keywords. */
export const DEFAULT_CONFLICT_KEYWORDS: readonly string[] = [
  "iran",
  "israel",
  "idf",
  "irgc",
  "hezbollah",
  "houthi",
  "gaza",
  "tehran",
  "tel aviv",
  "us military",
  "u.s. military",
  "pentagon",
  "centcom",
  "strike",
  "missile",
  "airstrike",
  "drone attack",
  "warship",
  "nuclear facility",
];

/** Keeps only events whose actor names / headline / source URL mention at least one scope keyword
 *  (case-insensitive substring match). Pure — applied client-side even though the fetch already
 *  sent a server-side query, as a defensive second filter per the task spec. */
export function filterToConflictKeywords(
  events: readonly GdeltEvent[],
  keywords: readonly string[] = DEFAULT_CONFLICT_KEYWORDS,
): GdeltEvent[] {
  const lowered = keywords.map((k) => k.toLowerCase());
  return events.filter((e) => {
    const haystack = [e.actor1, e.actor2, e.title, e.sourceUrl]
      .filter((v): v is string => v !== null)
      .join(" ")
      .toLowerCase();
    return lowered.some((k) => haystack.includes(k));
  });
}

// ── raw-response parsing (pure helpers used by the I/O function) ────────────

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** CAMEO codes are canonically transmitted as (possibly zero-padded) strings — String(10) loses
 *  the leading zero a "010" (root 01, verbal cooperation) code needs, and cameoRoot() would then
 *  read the wrong root (10, inside the 09-20 conflict band) from an otherwise-cooperative event.
 *  Unlike the generic str() above, a numeric EventCode is never trustworthy here: treat it as
 *  unclassifiable (dropped by mapRawRecordToGdeltEvent's required-field check) rather than guess. */
function cameoCodeStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** GDELT Event DB dates arrive as DATEADDED (YYYYMMDDHHMMSS) or SQLDATE (YYYYMMDD); the DOC API
 *  uses "seendate" (ISO-ish). Accepts any of those, plus a raw numeric epoch-ms field as a defensive
 *  fallback for non-standard payload shapes. Returns null (never a fabricated "now") when nothing
 *  parses — the caller drops the record rather than guessing a date. */
function parseGdeltDateMs(raw: Record<string, unknown>): number | null {
  const dateAdded = str(raw.DATEADDED ?? raw.dateAdded);
  const sqlDate = str(raw.SQLDATE ?? raw.sqlDate);
  for (const c of [dateAdded, sqlDate]) {
    if (c === null) continue;
    if (/^\d{14}$/.test(c)) {
      const ms = Date.UTC(+c.slice(0, 4), +c.slice(4, 6) - 1, +c.slice(6, 8), +c.slice(8, 10), +c.slice(10, 12), +c.slice(12, 14));
      if (Number.isFinite(ms)) return ms;
    } else if (/^\d{8}$/.test(c)) {
      const ms = Date.UTC(+c.slice(0, 4), +c.slice(4, 6) - 1, +c.slice(6, 8));
      if (Number.isFinite(ms)) return ms;
    }
  }
  const seenDate = str(raw.seendate ?? raw.SeenDate);
  if (seenDate !== null) {
    const ms = Date.parse(seenDate);
    if (Number.isFinite(ms)) return ms;
  }
  const epoch = num(raw.dateMs ?? raw.eventDateMs);
  if (epoch !== null) return epoch;
  return null;
}

/** Maps one raw GDELT record to a GdeltEvent, or null when a required field (id / CAMEO code /
 *  date) is missing or unparseable — records that can't be safely classified are DROPPED, never
 *  fabricated with placeholder values. */
function mapRawRecordToGdeltEvent(raw: Record<string, unknown>): GdeltEvent | null {
  const id = str(raw.GLOBALEVENTID ?? raw.globalEventId ?? raw.id);
  if (id === null) return null;
  const cameoCode = cameoCodeStr(raw.EventCode ?? raw.eventCode ?? raw.cameoCode);
  if (cameoCode === null) return null;
  const dateMs = parseGdeltDateMs(raw);
  if (dateMs === null) return null;
  return {
    id,
    dateMs,
    cameoCode,
    goldsteinScale: num(raw.GoldsteinScale ?? raw.goldsteinScale),
    actor1: str(raw.Actor1Name ?? raw.actor1Name),
    actor2: str(raw.Actor2Name ?? raw.actor2Name),
    sourceUrl: str(raw.SOURCEURL ?? raw.sourceUrl ?? raw.url),
    title: str(raw.title ?? raw.Title),
    numMentions: num(raw.NumMentions ?? raw.numMentions),
    isHighSeverity: isHighSeverityCameo(cameoCode),
  };
}

/** Accepts a bare array of records, or an object with the records under a common wrapper key
 *  ("events" / "results" / "articles" / "data" — GDELT's own endpoints are inconsistent about this
 *  across DOC vs Event APIs). Returns null when nothing recognizable is found. */
function extractRawRecords(json: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(json)) return json.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
  if (json != null && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of ["events", "results", "articles", "data"]) {
      const val = obj[key];
      if (Array.isArray(val)) return val.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
    }
  }
  return null;
}

// ── fetch (the only I/O in this module) ──────────────────────────────────────

export const GDELT_EVENTS_BASE_URL = "https://api.gdeltproject.org/api/v2/events/events";
export const DEFAULT_GDELT_QUERY = process.env.GEOPOLITICAL_FEED_QUERY || "Iran Israel military conflict";
export const GEOPOLITICAL_FEED_TIMEOUT_MS = envNumPos("GEOPOLITICAL_FEED_TIMEOUT_MS", 8_000);
export const GEOPOLITICAL_FEED_MAX_RECORDS = envNumPos("GEOPOLITICAL_FEED_MAX_RECORDS", 75);

function buildGdeltEventsUrl(baseUrl: string, query: string, maxRecords: number): string {
  const params = new URLSearchParams({ query, format: "json", maxrecords: String(maxRecords) });
  return `${baseUrl}?${params.toString()}`;
}

export interface FetchConflictEventsOptions {
  query?: string;
  keywords?: readonly string[];
  timeoutMs?: number;
  maxRecords?: number;
  baseUrl?: string;
  /** Injected fetch implementation — mirrors nvidia-chat-client.ts's requestModelTurn convention so
   *  tests never touch the real network. */
  fetchImpl?: typeof fetch;
}

export interface FetchConflictEventsResult {
  events: GdeltEvent[];
  /** Structured failure reason; null on success (including the "zero events found" success case —
   *  an empty result and a failed fetch must stay distinguishable). */
  error: string | null;
}

/**
 * The sole I/O in this module. Calls the GDELT Event Database with a bounded timeout
 * (AbortController, same idiom as nvidia-chat-client.ts), parses the JSON, maps to GdeltEvent,
 * and filters to the Iran/Israel/US conflict keyword scope. FAIL-OPEN ON ANY FAILURE: non-2xx
 * status, invalid JSON, an unrecognized response shape, a thrown fetch error, or a timeout all
 * degrade to { events: [], error: <reason> } — this function NEVER throws, and "no events" is
 * always the safe/inert direction for a pure-measurement feed (house convention: fail toward
 * inactive, never toward a fabricated escalation).
 */
export async function fetchRecentConflictEvents(opts: FetchConflictEventsOptions = {}): Promise<FetchConflictEventsResult> {
  const query = opts.query ?? DEFAULT_GDELT_QUERY;
  const keywords = opts.keywords ?? DEFAULT_CONFLICT_KEYWORDS;
  const timeoutMs = opts.timeoutMs ?? GEOPOLITICAL_FEED_TIMEOUT_MS;
  const maxRecords = opts.maxRecords ?? GEOPOLITICAL_FEED_MAX_RECORDS;
  const baseUrl = opts.baseUrl ?? GDELT_EVENTS_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = buildGdeltEventsUrl(baseUrl, query, maxRecords);
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { events: [], error: `gdelt api returned HTTP ${res.status}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { events: [], error: "invalid JSON response" };
    }
    const rawRecords = extractRawRecords(json);
    if (rawRecords === null) return { events: [], error: "unrecognized response shape" };
    const parsed = rawRecords.map(mapRawRecordToGdeltEvent).filter((e): e is GdeltEvent => e !== null);
    return { events: filterToConflictKeywords(parsed, keywords), error: null };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "gdelt api request timed out" : "gdelt api request failed";
    return { events: [], error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── store ─────────────────────────────────────────────────────────────────

/** Bounded retention: keep at most this many events... */
export const GEOPOLITICAL_FEED_MAX_STORED_EVENTS = envNumPos("GEOPOLITICAL_FEED_MAX_STORED_EVENTS", 500);
/** ...or events newer than this many ms (14 days), WHICHEVER IS SMALLER (both caps are applied). */
export const GEOPOLITICAL_FEED_MAX_AGE_MS = envNumPos("GEOPOLITICAL_FEED_MAX_AGE_MS", 14 * 24 * 3_600_000);

export interface GeopoliticalFeedCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  disabledCycles: number;
  fetchedTotal: number;
  addedTotal: number;
  skippedDuplicateTotal: number;
  lastFetchCount: number;
  lastError: string | null;
}

const EMPTY_CYCLE_META: GeopoliticalFeedCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  disabledCycles: 0,
  fetchedTotal: 0,
  addedTotal: 0,
  skippedDuplicateTotal: 0,
  lastFetchCount: 0,
  lastError: null,
};

interface GeopoliticalFeedState {
  version: number;
  events: GdeltEvent[];
  cycleMeta?: GeopoliticalFeedCycleMeta;
}

/**
 * Bounded, atomic-write, deduplicated-by-id store for fetched conflict events. Mirrors the exact
 * idiom of LiqRecoilStore / FundingCarryStore: an in-memory state object, loaded defensively (a
 * corrupt or missing file starts empty, never throws), saved via tmp-write + rename (atomic on
 * POSIX — no torn reads for concurrent readers).
 */
export class GeopoliticalConflictFeedStore {
  private state: GeopoliticalFeedState = { version: 1, events: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<GeopoliticalFeedState>;
        if (Array.isArray(parsed.events)) this.state.events = parsed.events as GdeltEvent[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty, never throw */
      }
    }
  }

  get all(): GdeltEvent[] {
    return this.state.events;
  }

  get cycleMeta(): GeopoliticalFeedCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }

  has(id: string): boolean {
    return this.state.events.some((e) => e.id === id);
  }

  /** Adds the event if its id isn't already present; returns whether it was added (dedup by id). */
  add(event: GdeltEvent): boolean {
    if (this.has(event.id)) return false;
    this.state.events.push(event);
    return true;
  }

  recordCycle(atIso: string, delta: { fetched: number; added: number; skippedDuplicate: number; error: string | null }, disabled: boolean): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (disabled) {
      meta.disabledCycles += 1;
    } else {
      meta.fetchedTotal += delta.fetched;
      meta.addedTotal += delta.added;
      meta.skippedDuplicateTotal += delta.skippedDuplicate;
      meta.lastFetchCount = delta.fetched;
    }
    meta.lastError = delta.error;
    this.state.cycleMeta = meta;
  }

  /** Bounded retention: keep at most GEOPOLITICAL_FEED_MAX_STORED_EVENTS events, AND drop anything
   *  older than GEOPOLITICAL_FEED_MAX_AGE_MS relative to the NEWEST stored event's dateMs (same
   *  "age relative to newest-in-store" convention as LiqRecoilStore's flow-history pruning —
   *  deterministic, no wall-clock read inside the store). Both caps are applied — "whichever is
   *  smaller" — newest-first. */
  private prune(): void {
    if (this.state.events.length === 0) return;
    const newest = this.state.events.reduce((max, e) => (finite(e.dateMs) && e.dateMs > max ? e.dateMs : max), -Infinity);
    const cutoff = newest - GEOPOLITICAL_FEED_MAX_AGE_MS;
    const byAge = this.state.events
      .filter((e) => finite(e.dateMs) && e.dateMs >= cutoff)
      .sort((a, b) => b.dateMs - a.dateMs);
    this.state.events = byAge.slice(0, GEOPOLITICAL_FEED_MAX_STORED_EVENTS);
  }

  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file); // atomic on POSIX — no torn reads
  }
}

let singleton: GeopoliticalConflictFeedStore | null = null;
export function getGeopoliticalConflictFeedStore(dataDir = "data"): GeopoliticalConflictFeedStore {
  if (!singleton) singleton = new GeopoliticalConflictFeedStore(resolve(dataDir, "geopolitical-conflict-feed.json"));
  return singleton;
}
export function _resetGeopoliticalConflictFeedStoreForTests(): void {
  singleton = null;
}

// ── cycle ─────────────────────────────────────────────────────────────────

export interface GeopoliticalFeedCycleResult {
  /** true when GEOPOLITICAL_FEED_DISABLED=1 short-circuited the cycle (no fetch attempted). */
  disabled: boolean;
  fetched: number;
  added: number;
  skippedDuplicate: number;
  error: string | null;
}

/**
 * One collection cycle: honors the GEOPOLITICAL_FEED_DISABLED kill switch (default OFF — the feed
 * runs), then fetches (fail-open, see fetchRecentConflictEvents), dedups new events into the
 * store by id, and persists. Every cycle records liveness meta so a disabled/erroring feed is
 * distinguishable from a healthy "no new events" cycle.
 */
export async function runGeopoliticalConflictFeedCycle(opts: {
  store: GeopoliticalConflictFeedStore;
  now: number;
  fetchOpts?: FetchConflictEventsOptions;
}): Promise<GeopoliticalFeedCycleResult> {
  const nowIso = new Date(opts.now).toISOString();
  if (process.env.GEOPOLITICAL_FEED_DISABLED === "1") {
    opts.store.recordCycle(nowIso, { fetched: 0, added: 0, skippedDuplicate: 0, error: null }, true);
    opts.store.save();
    return { disabled: true, fetched: 0, added: 0, skippedDuplicate: 0, error: null };
  }

  const { events, error } = await fetchRecentConflictEvents(opts.fetchOpts);
  let added = 0;
  let skippedDuplicate = 0;
  for (const event of events) {
    if (opts.store.add(event)) added += 1;
    else skippedDuplicate += 1;
  }
  opts.store.recordCycle(nowIso, { fetched: events.length, added, skippedDuplicate, error }, false);
  opts.store.save();
  return { disabled: false, fetched: events.length, added, skippedDuplicate, error };
}

/** Single-flight guard — same idiom as runLiqRecoilCycleGuarded / runExitBrainShadowCycleGuarded:
 *  overlapping ticks (a slow fetch stretching past the ticker period) must never double-fire. */
let geopoliticalFeedCycleInFlight = false;
export async function runGeopoliticalConflictFeedCycleGuarded(
  opts: Parameters<typeof runGeopoliticalConflictFeedCycle>[0],
): Promise<GeopoliticalFeedCycleResult | null> {
  if (geopoliticalFeedCycleInFlight) return null;
  geopoliticalFeedCycleInFlight = true;
  try {
    return await runGeopoliticalConflictFeedCycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(
        new Date(opts.now).toISOString(),
        { fetched: 0, added: 0, skippedDuplicate: 0, error: (error as Error).message },
        false,
      );
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    geopoliticalFeedCycleInFlight = false;
  }
}

// ── report ────────────────────────────────────────────────────────────────

export interface GeopoliticalFeedReport {
  signalSource: "GDELT_EVENT_DATABASE";
  keywords: readonly string[];
  intensity: ConflictIntensity;
  /** The narrower "actual force" count (CAMEO roots 19-20) within the same window as `intensity`. */
  massViolenceCount: number;
  storedEventCount: number;
  topRecent: Array<{
    id: string;
    dateMs: number;
    cameoCode: string;
    goldsteinScale: number | null;
    isHighSeverity: boolean;
    isMassViolence: boolean;
    actor1: string | null;
    actor2: string | null;
    sourceUrl: string | null;
  }>;
  cycleMeta: GeopoliticalFeedCycleMeta | null;
}

/**
 * Fully transparent report: every number traces back to inspectable evidence (event id, CAMEO
 * code, Goldstein score) — no black-box aggregate score, per house convention.
 */
export function buildConflictFeedReport(
  events: readonly GdeltEvent[],
  nowMs: number,
  windowMs: number,
  cycleMeta?: GeopoliticalFeedCycleMeta,
): GeopoliticalFeedReport {
  const windowStartMs = nowMs - windowMs;
  const inWindow = events.filter((e) => finite(e.dateMs) && e.dateMs >= windowStartMs && e.dateMs <= nowMs);
  const intensity = computeConflictIntensity(events, nowMs, windowMs);
  const topRecent = [...inWindow]
    .sort((a, b) => b.dateMs - a.dateMs)
    .slice(0, 20)
    .map((e) => ({
      id: e.id,
      dateMs: e.dateMs,
      cameoCode: e.cameoCode,
      goldsteinScale: e.goldsteinScale,
      isHighSeverity: e.isHighSeverity,
      isMassViolence: isMassViolenceCameo(e.cameoCode),
      actor1: e.actor1,
      actor2: e.actor2,
      sourceUrl: e.sourceUrl,
    }));
  return {
    signalSource: "GDELT_EVENT_DATABASE",
    keywords: DEFAULT_CONFLICT_KEYWORDS,
    intensity,
    massViolenceCount: inWindow.filter((e) => isMassViolenceCameo(e.cameoCode)).length,
    storedEventCount: events.length,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

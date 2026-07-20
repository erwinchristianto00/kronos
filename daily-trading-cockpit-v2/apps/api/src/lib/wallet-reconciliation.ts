import type { FuturesIncomeEntry } from "./binance-futures-private.js";

/**
 * WALLET RECONCILIATION (report-only)
 *
 * Compares the live-execution engine's internal LiveDailyLedger.realizedPnlUsd (accumulated
 * incrementally, in-process, as each position close resolves — see live-execution-engine.ts's
 * rollDailyLedger/realizedFromTrades) against Binance's OWN account income ledger
 * (/fapi/v1/income) for the same UTC day. The two are computed by completely independent code
 * paths — one derived from local intent bookkeeping, one read straight from the exchange — so a
 * quiet bug in the internal accumulation (a missed close, a double-counted pyramid leg, a wrong
 * sign) would otherwise only surface once the displayed wallet balance visibly disagrees with
 * "what the dashboard says we made," which could be days later. This module exists purely to
 * surface that drift early, as a log line — nothing else.
 *
 * WHY the comparison is REALIZED_PNL + COMMISSION, not every income type:
 *   The internal ledger's realizedPnlUsd already nets trade commission (realizedFromTrades sums
 *   `realizedPnl - commission` per trade). It has NO concept of funding fees, transfers, rebates,
 *   or other account-level income — those simply never flow through the paper-order → intent →
 *   ledger path at all. So the fair, apples-to-apples comparator is
 *   `REALIZED_PNL + COMMISSION` from Binance's income ledger, not the grand total of every income
 *   type. FUNDING_FEE and any other income types are still summed and reported (for visibility —
 *   an operator may well want to see funding drag) but are deliberately EXCLUDED from the
 *   tolerance-checked delta so a perfectly healthy day doesn't get flagged as "mismatched" purely
 *   because the account paid/received routine funding on an open position.
 *
 * HARD SAFETY RULE: this module is diagnostic-only.
 *   - It never calls placeOrder / cancelOrder / closePosition / disarm / arm / kill / setLeverage /
 *     flattenAllExchangePositions, and never will — it has no reference to anything that could.
 *   - It never mutates LiveDailyLedger or any other engine state — it only READS a snapshot handed
 *     to it and a freshly-fetched income list, and returns a plain report object.
 *   - The periodic check wired in server.ts only console.warn()s when a mismatch exceeds
 *     tolerance. It does not pause trading, disarm, or take any corrective action of any kind.
 */

// ─── config ──────────────────────────────────────────────────────────────────

export interface WalletReconciliationConfig {
  /** Absolute USD delta above which a day is flagged as a mismatch. */
  toleranceUsd: number;
}

function envPositiveNum(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Default tolerance: $0.50. This system's default per-trade risk is $5 (LIVE_RISK_USD_PER_TRADE)
 * and its "scratch" noise floor is ~$0.10–0.15 (LIVE_SCRATCH_EPSILON_USD, itself derived as 2% of
 * risk-per-trade) — see live-execution-engine.ts's parseLiveExecutionConfig. $0.50 sits comfortably
 * above ordinary commission-rounding noise across a handful of trades a day, while still being
 * small enough (well under one scratch-sized close, let alone a real trade) to catch a
 * materially wrong day — e.g. one missed or double-counted close. Env-tunable because the right
 * value scales with whatever risk-per-trade / trade frequency the operator is actually running.
 */
const DEFAULT_TOLERANCE_USD = 0.5;

export function parseWalletReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): WalletReconciliationConfig {
  return {
    toleranceUsd: envPositiveNum(env.WALLET_RECONCILIATION_TOLERANCE_USD, DEFAULT_TOLERANCE_USD),
  };
}

// ─── income summarization ───────────────────────────────────────────────────

export const REALIZED_PNL_INCOME_TYPE = "REALIZED_PNL";
export const FUNDING_FEE_INCOME_TYPE = "FUNDING_FEE";
export const COMMISSION_INCOME_TYPE = "COMMISSION";

export interface DailyIncomeSummary {
  dayUtc: string;
  /** Every incomeType Binance returned for this day, summed verbatim (raw, unfiltered). */
  byType: Record<string, number>;
  realizedPnlUsd: number;
  fundingFeeUsd: number;
  commissionUsd: number;
  /** Sum of every OTHER income type (transfers, rebates, insurance clear, welcome bonus, …). */
  otherUsd: number;
  /** Sum of every entry regardless of type — the true total cash impact for the day. */
  totalUsd: number;
  /** REALIZED_PNL + COMMISSION — the subset comparable to the internal ledger's realizedPnlUsd.
   *  See this module's doc comment for why funding/other are excluded here. */
  comparableToLedgerUsd: number;
  entryCount: number;
  /** True when the fetch returned exactly the page limit — the day's true total may be
   *  undercounted (defensive; this bot's daily volume is expected to stay far below Binance's
   *  income page size). Informational only, never actioned. */
  possiblyTruncated: boolean;
}

export function emptyDailyIncomeSummary(dayUtc: string): DailyIncomeSummary {
  return {
    dayUtc,
    byType: {},
    realizedPnlUsd: 0,
    fundingFeeUsd: 0,
    commissionUsd: 0,
    otherUsd: 0,
    totalUsd: 0,
    comparableToLedgerUsd: 0,
    entryCount: 0,
    possiblyTruncated: false,
  };
}

/** UTC calendar day ("YYYY-MM-DD") an income entry's epoch-ms timestamp falls on. */
function utcDayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Buckets a (possibly multi-day) list of income entries by the UTC day each entry's OWN
 * timestamp falls on — not by any query window — so entries near a fetch boundary land on the
 * correct day regardless of how the caller chose startTime/endTime.
 *
 * `fetchLimit` should be the `limit` the caller passed to getIncomeHistory (default 1000); it is
 * used only to set `possiblyTruncated` when a day's entries could have been cut off by the page
 * size (best detected by the caller passing the raw fetched array length, so this stays a pure
 * function testable without any network mock).
 */
export function summarizeIncomeByUtcDay(
  entries: FuturesIncomeEntry[],
  opts: { fetchedCount?: number; fetchLimit?: number } = {},
): Map<string, DailyIncomeSummary> {
  const out = new Map<string, DailyIncomeSummary>();
  const possiblyTruncated =
    opts.fetchedCount !== undefined && opts.fetchLimit !== undefined && opts.fetchedCount >= opts.fetchLimit;
  for (const entry of entries) {
    const day = utcDayOf(entry.time);
    const row = out.get(day) ?? emptyDailyIncomeSummary(day);
    row.byType[entry.incomeType] = (row.byType[entry.incomeType] ?? 0) + entry.income;
    row.totalUsd += entry.income;
    row.entryCount += 1;
    if (entry.incomeType === REALIZED_PNL_INCOME_TYPE) {
      row.realizedPnlUsd += entry.income;
    } else if (entry.incomeType === FUNDING_FEE_INCOME_TYPE) {
      row.fundingFeeUsd += entry.income;
    } else if (entry.incomeType === COMMISSION_INCOME_TYPE) {
      row.commissionUsd += entry.income;
    } else {
      row.otherUsd += entry.income;
    }
    row.possiblyTruncated = row.possiblyTruncated || possiblyTruncated;
    out.set(day, row);
  }
  for (const row of out.values()) {
    row.comparableToLedgerUsd = row.realizedPnlUsd + row.commissionUsd;
  }
  return out;
}

// ─── comparison / report ────────────────────────────────────────────────────

export interface InternalLedgerSnapshot {
  /** UTC day ("YYYY-MM-DD") the ledger's accumulator currently reflects. */
  dateUtc: string;
  realizedPnlUsd: number;
}

export interface WalletReconciliationReport {
  dayUtc: string;
  generatedAt: string;
  internalRealizedPnlUsd: number;
  /** False when the internal ledger's own dateUtc does not match dayUtc — the live engine only
   *  ever retains the CURRENT UTC day's accumulator (see LiveDailyLedger), so there is no internal
   *  figure at all for any other day. When false, withinTolerance is forced true (no verdict can
   *  honestly be rendered) and `note` explains why. */
  internalLedgerFresh: boolean;
  comparisonBasis: "NET_REALIZED_WITH_ALL_COMMISSION" | "GROSS_REALIZED_CLOSED_ONLY";
  internalClosedFeesUsd: number | null;
  comparisonInternalUsd: number;
  comparisonExchangeUsd: number;
  exchangeIncome: DailyIncomeSummary;
  /** exchangeIncome.comparableToLedgerUsd − internalRealizedPnlUsd. */
  deltaUsd: number;
  toleranceUsd: number;
  withinTolerance: boolean;
  note: string | null;
}

/**
 * Pure comparison — no I/O. Takes an already-fetched income list and an already-read ledger
 * snapshot and produces the report object. Kept separate from any fetch/engine wiring so it is
 * trivially unit-testable with fixtures.
 */
export function buildWalletReconciliationReport(opts: {
  dayUtc: string;
  internalLedger: InternalLedgerSnapshot;
  incomeEntries: FuturesIncomeEntry[];
  toleranceUsd: number;
  fetchedCount?: number;
  fetchLimit?: number;
  nowIso?: () => string;
  /** When supplied, compare exchange gross REALIZED_PNL against internal net closed PnL plus only
   * closed-position fees. This excludes commissions paid to enter positions that remain OPEN. */
  internalClosedFeesUsd?: number;
}): WalletReconciliationReport {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const summaries = summarizeIncomeByUtcDay(opts.incomeEntries, {
    fetchedCount: opts.fetchedCount,
    fetchLimit: opts.fetchLimit,
  });
  const exchangeIncome = summaries.get(opts.dayUtc) ?? emptyDailyIncomeSummary(opts.dayUtc);
  const internalLedgerFresh = opts.internalLedger.dateUtc === opts.dayUtc;
  const internalRealizedPnlUsd = internalLedgerFresh ? opts.internalLedger.realizedPnlUsd : 0;
  const grossClosedMode = typeof opts.internalClosedFeesUsd === "number" && Number.isFinite(opts.internalClosedFeesUsd);
  const internalClosedFeesUsd = grossClosedMode ? Math.max(0, opts.internalClosedFeesUsd!) : null;
  const comparisonBasis = grossClosedMode
    ? "GROSS_REALIZED_CLOSED_ONLY" as const
    : "NET_REALIZED_WITH_ALL_COMMISSION" as const;
  const comparisonInternalUsd = grossClosedMode
    ? internalRealizedPnlUsd + (internalClosedFeesUsd ?? 0)
    : internalRealizedPnlUsd;
  const comparisonExchangeUsd = grossClosedMode
    ? exchangeIncome.realizedPnlUsd
    : exchangeIncome.comparableToLedgerUsd;

  if (!internalLedgerFresh) {
    return {
      dayUtc: opts.dayUtc,
      generatedAt: nowIso(),
      internalRealizedPnlUsd,
      internalLedgerFresh,
      comparisonBasis,
      internalClosedFeesUsd,
      comparisonInternalUsd,
      comparisonExchangeUsd,
      exchangeIncome,
      deltaUsd: 0,
      toleranceUsd: opts.toleranceUsd,
      withinTolerance: true,
      note:
        `internal ledger's dateUtc (${opts.internalLedger.dateUtc}) does not match the requested ` +
        `day (${opts.dayUtc}) — the live engine only retains the CURRENT day's ledger, so no ` +
        `internal figure exists for this day; skipping the tolerance check.`,
    };
  }

  const deltaUsd = comparisonExchangeUsd - comparisonInternalUsd;
  const withinTolerance = Math.abs(deltaUsd) <= opts.toleranceUsd;
  return {
    dayUtc: opts.dayUtc,
    generatedAt: nowIso(),
    internalRealizedPnlUsd,
    internalLedgerFresh,
    comparisonBasis,
    internalClosedFeesUsd,
    comparisonInternalUsd,
    comparisonExchangeUsd,
    exchangeIncome,
    deltaUsd,
    toleranceUsd: opts.toleranceUsd,
    withinTolerance,
    note: exchangeIncome.possiblyTruncated
      ? "exchange income fetch may be truncated by the page limit — totals could be understated."
      : null,
  };
}

// ─── engine wiring (thin I/O wrapper) ───────────────────────────────────────

/** Narrow surface this module needs from LiveExecutionEngine — kept minimal and duck-typed so
 *  tests can inject a fake without touching the real engine or its private client. */
export interface LiveEngineReconciliationSource {
  getStatus(): { closedToday: InternalLedgerSnapshot };
  getIncomeHistory(startTimeMs: number, endTimeMs: number): Promise<FuturesIncomeEntry[]>;
}

const INCOME_FETCH_LIMIT = 1000;

/** Inclusive [startMs, endMs] millisecond bounds of a UTC calendar day. */
function utcDayBoundsMs(dayUtc: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 - 1 };
}

const DAY_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a caller-supplied "YYYY-MM-DD" day; falls back to the current UTC day for anything
 *  malformed or missing rather than passing a bad string through to Date.parse.
 *
 *  2026-07-11 fix: Date.parse silently ROLLS OVER a non-existent calendar date instead of
 *  rejecting it (confirmed: "2026-04-31" and "2027-02-29" both parse to a finite timestamp — for
 *  the NEXT real day, May 1 / March 1 — while "2026-13-13" correctly yields NaN). The old
 *  Number.isFinite check alone let a request for an invalid day silently return a report labeled
 *  with the fake date but built from the real following day's income, plus a spurious ledger-
 *  mismatch note. Round-tripping the parsed timestamp back through toISOString and comparing
 *  against the original string catches any rollover: a genuinely valid day is unchanged by the
 *  round trip, a rolled-over one isn't. */
export function resolveDayUtc(raw: string | undefined, nowIso: () => string = () => new Date().toISOString()): string {
  if (raw && DAY_UTC_PATTERN.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00.000Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === raw) return raw;
  }
  return nowIso().slice(0, 10);
}

/**
 * Fetches Binance's income history for the given UTC day and compares it against the engine's
 * internal dailyLedger. This is the only function in this module that performs any I/O, and the
 * only call it makes is the read-only engine.getIncomeHistory()/getStatus() pair — both already
 * proven side-effect-free by their own doc comments in live-execution-engine.ts.
 *
 * 2026-07-11 fix: `engine.getStatus().closedToday` is the ENGINE-NATIVE ledger only (the CG_VARIANT_
 * MATRIX mirror/directional-slot intents) — it never saw a single close from the 3 CrossSectional
 * Executor or 8 SingleSymbolLaneExecutor instances, which are separate classes with their own
 * stores. This was the confirmed root cause of a recurring real mismatch (e.g. 2026-07-10's
 * $1.25→$1.19→$1.46 drift, which matched exactly the real RC/CE closes that day dollar-for-dollar).
 * `externalTodayRealizedPnlUsd` (from live-executor-wiring.ts's sumExternalRealizedPnlUsd, same
 * source the dashboard headline and kill-switch now use) is folded in before the comparison — this
 * only affects the check when internalLedgerFresh is true (i.e. only ever for TODAY, since the
 * ledger itself only retains the current UTC day; a past-day query already short-circuits to
 * skipped regardless of this value).
 */
export async function buildLiveWalletReconciliationReport(
  engine: LiveEngineReconciliationSource,
  dayUtc?: string,
  config: WalletReconciliationConfig = parseWalletReconciliationConfig(),
  externalTodayRealizedPnlUsd = 0,
  internalTodayClosedFeesUsd?: number,
): Promise<WalletReconciliationReport> {
  const day = resolveDayUtc(dayUtc);
  // 2026-07-20 fix: read closedToday HERE, back-to-back with `day` above, rather than after the
  // awaited getIncomeHistory call below. getIncomeHistory can take an arbitrary amount of wall-clock
  // time (network round-trip); if the engine's internal daily ledger rolls over to a new UTC day
  // while it's in flight, a POST-await getStatus() read would see the NEW day while `day` (and the
  // fetched income window) still reflect the OLD one — shrinking that window from "however long the
  // network call takes" to "two synchronous statements" makes the rollover race about as narrow as
  // it can get without coordinating with the engine's own clock.
  const { closedToday } = engine.getStatus();
  const { startMs, endMs } = utcDayBoundsMs(day);
  const incomeEntries = await engine.getIncomeHistory(startMs, endMs);
  return buildWalletReconciliationReport({
    dayUtc: day,
    internalLedger: {
      ...closedToday,
      realizedPnlUsd: closedToday.realizedPnlUsd + externalTodayRealizedPnlUsd,
    },
    incomeEntries,
    toleranceUsd: config.toleranceUsd,
    fetchedCount: incomeEntries.length,
    fetchLimit: INCOME_FETCH_LIMIT,
    internalClosedFeesUsd: internalTodayClosedFeesUsd,
  });
}

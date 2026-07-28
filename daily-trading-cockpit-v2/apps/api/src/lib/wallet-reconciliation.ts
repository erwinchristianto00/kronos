/**
 * WALLET RECONCILIATION (report-only) — cross-checks the live-execution engine's internal
 * LiveDailyLedger.realizedPnlUsd against Binance's own GET /fapi/v1/income history for the
 * same UTC day.
 *
 * WHY THIS EXISTS: LiveDailyLedger.realizedPnlUsd is accumulated in live-execution-engine.ts's
 * settleClosedIntent()/applyRealizedToLedger() purely from getUserTrades() rows matched back
 * against order ids the engine itself placed (entry/tp1/stop/be-stop). That match set is a
 * HYPOTHESIS about what happened on the exchange — a missed order id, an ADL/liquidation event,
 * a manual operator action taken directly on the exchange, or a bug in the matching logic would
 * all silently understate or overstate what the engine believes it made. Binance's own income
 * ledger (/fapi/v1/income) is ground truth: every entry is something that actually posted to the
 * wallet. This module fetches that ground truth and diffs it against the internal figure.
 *
 * HARD RULE — REPORT-ONLY: this module NEVER arms/disarms/kills/flattens/cancels/places
 * anything. It only READS (a) the existing internal ledger via a narrow getStatus() surface and
 * (b) a new read-only Binance income call, computes a comparison, and returns/logs it. It must
 * not gain any additional dependency on the engine or the private client beyond the two narrow
 * interfaces below. Do not add a corrective/mutating call here — ever.
 */

import type { FuturesIncomeEntry } from "./binance-futures-private.js";

// ─── narrow surfaces (kept minimal so tests can fake them trivially) ──────────

/** Only the one read-only Binance call this module needs — nothing mutating is reachable through it. */
export interface WalletReconciliationClient {
  getIncomeHistory(opts: {
    symbol?: string;
    incomeType?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<FuturesIncomeEntry[]>;
}

/** Only the existing read-only status snapshot — no arm/disarm/kill/order method is reachable through it. */
export interface WalletReconciliationLedgerSource {
  getStatus(): {
    closedToday: { dateUtc: string; realizedPnlUsd: number; wins: number; losses: number };
  };
}

// ─── tolerance ─────────────────────────────────────────────────────────────────

/**
 * Default tolerance: $0.50/day. This engine's typical trade economics (see
 * live-execution-engine.ts parseLiveExecutionConfig): LIVE_RISK_USD_PER_TRADE defaults to $5
 * risked per trade, LIVE_DAILY_MAX_LOSS_USD to $15/day. $0.50 is small enough relative to those
 * (~10% of a single trade's risk) to catch a fully missed or mis-attributed close — which would
 * be off by dollars, not cents — while staying loose enough to absorb float/rounding noise
 * across the handful of closes this bot produces per day. Operators running larger size can
 * raise it via WALLET_RECONCILIATION_TOLERANCE_USD.
 */
export const DEFAULT_TOLERANCE_USD = 0.5;

export function resolveReconciliationToleranceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALLET_RECONCILIATION_TOLERANCE_USD;
  const n = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOLERANCE_USD;
}

// ─── income window fetch + bucketing ──────────────────────────────────────────
// The three income types bucketed explicitly below (REALIZED_PNL, FUNDING_FEE, COMMISSION) are
// the ones this bot's live trading actually produces, per the audit that requested this module;
// everything else observed in a real response falls into the `otherUsd`/`otherTypes` bucket.

export interface WalletIncomeSummary {
  dateUtc: string;
  windowStartMs: number;
  windowEndMs: number;
  realizedPnlUsd: number;
  fundingFeeUsd: number;
  commissionUsd: number;
  /** Any income type outside the three core ones (TRANSFER, WELCOME_BONUS, INSURANCE_CLEAR, ...) — informational only. */
  otherUsd: number;
  otherTypes: string[];
  /** Sum of every entry in the window — the literal "actual wallet-affecting income" for the day. */
  totalIncomeUsd: number;
  entryCount: number;
  /** True if MAX_INCOME_PAGES was hit while paging — the sum may be incomplete; surfaced, never hidden. */
  truncated: boolean;
}

/** Binance's /fapi/v1/income hard per-call cap. */
const INCOME_PAGE_LIMIT = 1000;
/** 10 pages = 10,000 entries/day — far beyond this bot's realistic daily income-row volume; guards a runaway loop. */
const MAX_INCOME_PAGES = 10;

/** UTC calendar-day boundaries (inclusive) in epoch ms for a "YYYY-MM-DD" string. */
export function utcDayWindowMs(dateUtc: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${dateUtc}T00:00:00.000Z`);
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 - 1 };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Fetch every income entry in [startMs, endMs] and bucket it by type. Pages forward on time
 * when a page comes back full (possible truncation at the 1000-row cap), capped at
 * MAX_INCOME_PAGES so a pathological response can never spin this forever.
 */
export async function fetchIncomeSummaryForWindow(
  client: WalletReconciliationClient,
  dateUtc: string,
  startMs: number,
  endMs: number,
): Promise<WalletIncomeSummary> {
  const entries: FuturesIncomeEntry[] = [];
  let cursorStart = startMs;
  let truncated = false;

  for (let page = 0; page < MAX_INCOME_PAGES; page++) {
    const batch = await client.getIncomeHistory({ startTime: cursorStart, endTime: endMs, limit: INCOME_PAGE_LIMIT });
    entries.push(...batch);
    if (batch.length < INCOME_PAGE_LIMIT) break;
    const lastTime = batch[batch.length - 1]?.time ?? cursorStart;
    if (!(lastTime > cursorStart)) break; // non-advancing cursor — stop rather than loop forever
    cursorStart = lastTime + 1;
    if (page === MAX_INCOME_PAGES - 1) truncated = true;
  }

  let realizedPnlUsd = 0;
  let fundingFeeUsd = 0;
  let commissionUsd = 0;
  let otherUsd = 0;
  const otherTypes = new Set<string>();

  for (const entry of entries) {
    if (entry.incomeType === "REALIZED_PNL") realizedPnlUsd += entry.income;
    else if (entry.incomeType === "FUNDING_FEE") fundingFeeUsd += entry.income;
    else if (entry.incomeType === "COMMISSION") commissionUsd += entry.income;
    else {
      otherUsd += entry.income;
      otherTypes.add(entry.incomeType || "UNKNOWN");
    }
  }

  return {
    dateUtc,
    windowStartMs: startMs,
    windowEndMs: endMs,
    realizedPnlUsd: round2(realizedPnlUsd),
    fundingFeeUsd: round2(fundingFeeUsd),
    commissionUsd: round2(commissionUsd),
    otherUsd: round2(otherUsd),
    otherTypes: Array.from(otherTypes).sort(),
    totalIncomeUsd: round2(realizedPnlUsd + fundingFeeUsd + commissionUsd + otherUsd),
    entryCount: entries.length,
    truncated,
  };
}

// ─── report ────────────────────────────────────────────────────────────────────

export interface WalletReconciliationReport {
  dateUtc: string;
  fetchedAt: string;
  internal: {
    available: boolean;
    /** Populated only when `available` is false — LiveDailyLedger keeps no history across a UTC rollover. */
    note: string | null;
    realizedPnlUsd: number | null;
    wins: number | null;
    losses: number | null;
  };
  exchange: WalletIncomeSummary;
  comparison: {
    /**
     * Exchange's own net-of-commission realized result (REALIZED_PNL + COMMISSION income
     * entries) — the true apples-to-apples counterpart to LiveDailyLedger.realizedPnlUsd, which
     * is also trade-realized-PnL net of commission. FUNDING_FEE and any "other" income are
     * intentionally excluded from this figure (and so from the tolerance check): the internal
     * ledger structurally never tracks funding, so folding it in would make every single day
     * "mismatch" by the funding total and drown out genuine bugs. Funding/other are still fully
     * reported below (see `exchange`) for visibility — nothing is hidden, just not conflated
     * with the bug-detection signal.
     */
    exchangeNetRealizedUsd: number;
    /** internal.realizedPnlUsd - exchangeNetRealizedUsd; null when internal is unavailable (never fabricated). */
    deltaUsd: number | null;
    toleranceUsd: number;
    /** null when internal is unavailable — never fabricate a verdict from a missing figure. */
    withinTolerance: boolean | null;
  };
}

export interface BuildWalletReconciliationReportOptions {
  client: WalletReconciliationClient;
  ledgerSource: WalletReconciliationLedgerSource;
  /** UTC "YYYY-MM-DD"; defaults to the current UTC day. */
  dateUtc?: string;
  toleranceUsd?: number;
  nowIso?: () => string;
}

export async function buildWalletReconciliationReport(
  opts: BuildWalletReconciliationReportOptions,
): Promise<WalletReconciliationReport> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const fetchedAt = nowIso();
  const dateUtc = opts.dateUtc ?? fetchedAt.slice(0, 10);
  const toleranceUsd = opts.toleranceUsd ?? resolveReconciliationToleranceUsd();

  const { startMs, endMs } = utcDayWindowMs(dateUtc);
  // Never request a window that reaches into the future — "today so far" for the current day.
  const cappedEndMs = Math.min(endMs, Date.parse(fetchedAt));
  const exchange = await fetchIncomeSummaryForWindow(opts.client, dateUtc, startMs, cappedEndMs);

  const ledger = opts.ledgerSource.getStatus().closedToday;
  const internalAvailable = ledger.dateUtc === dateUtc;

  const exchangeNetRealizedUsd = round2(exchange.realizedPnlUsd + exchange.commissionUsd);

  const internal = internalAvailable
    ? { available: true, note: null, realizedPnlUsd: ledger.realizedPnlUsd, wins: ledger.wins, losses: ledger.losses }
    : {
        available: false,
        note:
          `LiveDailyLedger has already rolled to ${ledger.dateUtc} (or never reached ${dateUtc}); ` +
          `it keeps no history across a UTC-day boundary, so ${dateUtc}'s internal figure cannot be ` +
          `reconstructed. The exchange-side figures above are still accurate for ${dateUtc}.`,
        realizedPnlUsd: null,
        wins: null,
        losses: null,
      };

  const deltaUsd = internalAvailable ? round2((ledger.realizedPnlUsd as number) - exchangeNetRealizedUsd) : null;
  const withinTolerance = deltaUsd === null ? null : Math.abs(deltaUsd) <= toleranceUsd;

  return {
    dateUtc,
    fetchedAt,
    internal,
    exchange,
    comparison: { exchangeNetRealizedUsd, deltaUsd, toleranceUsd, withinTolerance },
  };
}

// ─── report-only check (compute + log) ───────────────────────────────────────

export interface WalletReconciliationCheckResult {
  report: WalletReconciliationReport;
  /** True iff a mismatch beyond tolerance was found and a warning was logged. */
  warned: boolean;
}

/**
 * Build the report and, if (and only if) the comparison is over tolerance, log a warning.
 * This is the ONLY place in this module that produces a side effect, and that side effect is
 * exactly one thing: a log line via `warn` (default console.warn). It never disarms, kills,
 * pauses, cancels, or closes anything — there is no code path here that could, since the two
 * dependencies (WalletReconciliationClient, WalletReconciliationLedgerSource) do not expose any
 * mutating method to reach.
 */
export async function runWalletReconciliationCheck(
  opts: BuildWalletReconciliationReportOptions & { warn?: (message: string) => void },
): Promise<WalletReconciliationCheckResult> {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const report = await buildWalletReconciliationReport(opts);

  let warned = false;
  if (report.comparison.withinTolerance === false) {
    warned = true;
    warn(
      `[wallet-reconciliation] MISMATCH on ${report.dateUtc}: internal realizedPnlUsd=` +
        `${report.internal.realizedPnlUsd} vs exchange net-realized (REALIZED_PNL+COMMISSION)=` +
        `${report.comparison.exchangeNetRealizedUsd} — delta=${report.comparison.deltaUsd} ` +
        `exceeds tolerance=${report.comparison.toleranceUsd}. funding=${report.exchange.fundingFeeUsd} ` +
        `other=${report.exchange.otherUsd} (${report.exchange.otherTypes.join(",") || "none"}). ` +
        `REPORT-ONLY: no trading action taken — investigate the ledger/order-id match manually.`,
    );
  }
  return { report, warned };
}

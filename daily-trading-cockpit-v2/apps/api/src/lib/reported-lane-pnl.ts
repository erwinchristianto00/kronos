/**
 * Read-model accounting for the dashboard's three operator-facing books.
 *
 * The dashboard is operated in Asia/Taipei.  Do not combine a UTC "today"
 * from one executor with a Taipei-close date from Daily Range: a close between
 * 00:00 and 08:00 Taipei is otherwise assigned to different calendar days in
 * the same headline.  Taipei has no DST, so an explicit fixed offset keeps
 * the classification deterministic and dependency-free.
 */

export type ReportedLanePnlCategory = "BASKETS" | "DAILY_RANGE" | "SINGLE_SYMBOL";

export interface ReportedLanePnlRecord {
  category: ReportedLanePnlCategory;
  closedAt: string | null | undefined;
  netPnlUsd: number | null | undefined;
}

export interface ReportedLanePnlBreakdown {
  baskets: number;
  dailyRange: number;
  singleSymbol: number;
  total: number;
  closedCount: number;
}

export interface ReportedLanePnlSummary {
  timeZone: "Asia/Taipei";
  closeDateTaipei: string;
  today: ReportedLanePnlBreakdown;
  allTime: ReportedLanePnlBreakdown;
}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function emptyBreakdown(): ReportedLanePnlBreakdown {
  return { baskets: 0, dailyRange: 0, singleSymbol: 0, total: 0, closedCount: 0 };
}

function add(breakdown: ReportedLanePnlBreakdown, category: ReportedLanePnlCategory, netPnlUsd: number): void {
  if (category === "BASKETS") breakdown.baskets += netPnlUsd;
  if (category === "DAILY_RANGE") breakdown.dailyRange += netPnlUsd;
  if (category === "SINGLE_SYMBOL") breakdown.singleSymbol += netPnlUsd;
  breakdown.total += netPnlUsd;
  breakdown.closedCount += 1;
}

/** Stable YYYY-MM-DD key for the operator-facing Taipei close date. */
export function taipeiCloseDateKey(value: string | number | Date): string | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Aggregate only proven, timestamped closed results.  A missing timestamp or
 * P&L is unavailable evidence, never a synthetic zero.
 */
export function summarizeReportedLanePnl(
  records: readonly ReportedLanePnlRecord[],
  now: Date | number = Date.now(),
): ReportedLanePnlSummary | null {
  const closeDateTaipei = taipeiCloseDateKey(now);
  if (closeDateTaipei == null) return null;

  const today = emptyBreakdown();
  const allTime = emptyBreakdown();
  for (const record of records) {
    if (!finite(record.netPnlUsd) || !record.closedAt) continue;
    const date = taipeiCloseDateKey(record.closedAt);
    if (date == null) continue;
    add(allTime, record.category, record.netPnlUsd);
    if (date === closeDateTaipei) add(today, record.category, record.netPnlUsd);
  }
  return { timeZone: "Asia/Taipei", closeDateTaipei, today, allTime };
}

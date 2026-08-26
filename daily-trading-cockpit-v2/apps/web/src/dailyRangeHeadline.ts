export type DailyRangeHeadlineTrade = {
  status: string;
  exitTimestamp: string | null;
  netPnlUsd: number | null;
};

export type DailyRangeHeadlineSummary = {
  /** Calendar day of the exit fill in the operator-facing timezone. */
  closeDateTaipei: string;
  todayNetPnlUsd: number;
  todayClosedCount: number;
  allTimeNetPnlUsd: number;
  allTimeClosedCount: number;
};

const TAIPEI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/** A stable YYYY-MM-DD calendar key without depending on the browser's local timezone. */
export function taipeiCloseDateKey(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    TAIPEI_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const { year, month, day } = parts;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/**
 * Uses the actual exit-fill timestamp, deliberately not Daily Range's `dateUtc` signal/range day.
 * Returning null makes callers show an unavailable state rather than silently treating incomplete
 * history as zero realized P&L.
 */
export function summarizeDailyRangeHeadline(
  trades: readonly DailyRangeHeadlineTrade[],
  now: Date = new Date(),
): DailyRangeHeadlineSummary | null {
  const closeDateTaipei = taipeiCloseDateKey(now);
  if (closeDateTaipei == null) return null;

  const closed = trades.filter((trade) => trade.status === 'CLOSED');
  const normalized: Array<{ netPnlUsd: number; closeDateTaipei: string }> = [];
  for (const trade of closed) {
    const tradeCloseDateTaipei = trade.exitTimestamp == null ? null : taipeiCloseDateKey(trade.exitTimestamp);
    if (!finite(trade.netPnlUsd) || tradeCloseDateTaipei == null) return null;
    normalized.push({ netPnlUsd: trade.netPnlUsd, closeDateTaipei: tradeCloseDateTaipei });
  }

  const today = normalized.filter((trade) => trade.closeDateTaipei === closeDateTaipei);
  return {
    closeDateTaipei,
    todayNetPnlUsd: today.reduce((sum, trade) => sum + trade.netPnlUsd, 0),
    todayClosedCount: today.length,
    allTimeNetPnlUsd: normalized.reduce((sum, trade) => sum + trade.netPnlUsd, 0),
    allTimeClosedCount: normalized.length,
  };
}

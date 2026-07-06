/**
 * EXCHANGE HEALTH READINESS — REPORT-ONLY SPEC
 *
 * Describes the FUTURE exchange-health monitoring that would have to exist
 * BEFORE any micro-pilot could be discussed. `ready` is ALWAYS false unless
 * `live` inputs are supplied (clock skew, reachability, data freshness) — this
 * remains a forward-looking spec, not a live monitor.
 *
 * Pure module: zero I/O, no side effects, never throws.
 */

export const EXCHANGE_HEALTH_READINESS_MODULE = "EXCHANGE_HEALTH_READINESS" as const;

export type ExchangeHealthSource = "LIVE_INPUT" | "NOT_AVAILABLE" | "FUTURE";

export interface ExchangeHealthCheck {
  name: string;
  description: string;
  available: boolean;
  source: ExchangeHealthSource;
  currentValue?: string;
}

/** v1 live inputs — the CRITICAL real-time health signals computed each operator-brief (≈7-min
 *  cadence = the monitoring loop). Optional: when omitted the report behaves like the original spec
 *  (ready stays false). All fields cheaply derivable from data already in hand (no new hot-path I/O). */
export interface ExchangeHealthLiveInputs {
  reachable: boolean; // exchange responding (recent scan/candle data flowed)
  marketDataAgeMs: number | null; // now − latest scan finish; null if unknown
  clockSkewMs: number | null; // |server−local| from the signed client; null if unmeasured (advisory)
}
export const EXCHANGE_HEALTH_MAX_DATA_AGE_MS = Number(process.env.EXCHANGE_HEALTH_MAX_DATA_AGE_MS) || 15 * 60 * 1000;
export const EXCHANGE_HEALTH_MAX_CLOCK_SKEW_MS = Number(process.env.EXCHANGE_HEALTH_MAX_CLOCK_SKEW_MS) || 1500;

export interface ExchangeHealthReadinessReport {
  reportOnly: true;
  module: typeof EXCHANGE_HEALTH_READINESS_MODULE;
  computedAt: string;
  implemented: boolean; // partial — true only if ALL 12 spec checks have data
  /** v1 gate: true only when the CRITICAL real-time checks pass (reachable + fresh market data +
   *  feeds present + clock OK). Still ANDed with killSwitch + orderReconciliation in infraReady, so
   *  this alone can never enable live. false whenever live inputs are absent. */
  ready: boolean;
  readyReasons: string[]; // why not ready (empty when ready)
  checks: ExchangeHealthCheck[];
  availableCount: number;
  missingChecks: string[];
  summary: string;
}

export function buildExchangeHealthReadinessReport(
  capturedAt?: string,
  live?: ExchangeHealthLiveInputs,
): ExchangeHealthReadinessReport {
  const computedAt = capturedAt ?? new Date().toISOString();

  const checks: ExchangeHealthCheck[] = [
    {
      name: "rest_latency",
      description: "REST round-trip latency monitoring (place/cancel/query).",
      available: false,
      source: "FUTURE",
    },
    {
      name: "websocket_freshness",
      description: "Age of the most recent websocket market-data message.",
      available: false,
      source: "FUTURE",
    },
    {
      name: "bookticker_freshness",
      description: "Best bid/ask freshness from the book ticker feed.",
      available: false,
      source: "NOT_AVAILABLE",
    },
    {
      name: "depth_freshness",
      description: "Top-of-book depth freshness from the depth feed.",
      available: false,
      source: "NOT_AVAILABLE",
    },
    {
      name: "funding_freshness",
      description: "Funding-rate freshness from the premium-index feed.",
      available: false,
      source: "NOT_AVAILABLE",
    },
    {
      name: "openinterest_freshness",
      description: "Open-interest freshness.",
      available: false,
      source: "NOT_AVAILABLE",
    },
    {
      name: "error_rate",
      description: "Rolling exchange API error rate.",
      available: false,
      source: "FUTURE",
    },
    {
      name: "rate_limit_pressure",
      description: "Proximity to exchange rate limits / weight budget.",
      available: false,
      source: "FUTURE",
    },
    {
      name: "stale_price_detection",
      description: "Detect a price feed that has stopped updating.",
      available: false,
      source: "FUTURE",
    },
    {
      name: "abnormal_spread_detection",
      description:
        "Reference threshold for abnormal spread (e.g. p99 from the observed distribution).",
      available: false,
      source: "NOT_AVAILABLE",
    },
    {
      name: "symbol_trading_status",
      description: "Per-symbol trading status (TRADING / HALT / BREAK).",
      available: false,
      source: "FUTURE",
    },
    {
      name: "exchange_maintenance_flag",
      description: "Exchange-wide maintenance / system-status flag.",
      available: false,
      source: "FUTURE",
    },
  ];

  // ── v1 live CRITICAL checks (computed each brief = the ≈7-min monitoring cadence) ──────────────
  const marketDataFresh =
    !!live && live.marketDataAgeMs != null && live.marketDataAgeMs >= 0 && live.marketDataAgeMs <= EXCHANGE_HEALTH_MAX_DATA_AGE_MS;
  const feedsPresent = false; // book-ticker/depth feed collection is not implemented (spec-only)
  const reachable = !!live && live.reachable;
  // clock skew is advisory: only blocks when it has been MEASURED and is out of tolerance.
  const clockMeasured = !!live && live.clockSkewMs != null;
  const clockOk = !clockMeasured || (live!.clockSkewMs as number) <= EXCHANGE_HEALTH_MAX_CLOCK_SKEW_MS;
  if (live) {
    checks.push(
      {
        name: "exchange_reachable",
        description: "Exchange responded with fresh market data this cycle.",
        available: reachable,
        source: "LIVE_INPUT",
        currentValue: reachable ? "reachable" : "no recent data",
      },
      {
        name: "market_data_freshness",
        description: "Age of the latest scan/candle close vs the staleness ceiling.",
        available: marketDataFresh,
        source: "LIVE_INPUT",
        currentValue:
          live.marketDataAgeMs != null ? `${Math.round(live.marketDataAgeMs / 1000)}s old` : "unknown",
      },
      {
        name: "clock_sync",
        description: "Signed-client clock skew vs server time (advisory until measured).",
        available: clockOk,
        source: clockMeasured ? "LIVE_INPUT" : "NOT_AVAILABLE",
        currentValue: clockMeasured ? `${Math.round(live.clockSkewMs as number)}ms skew` : "not measured",
      },
    );
  }

  const availableCount = checks.filter((c) => c.available).length;
  const missingChecks = checks.filter((c) => !c.available).map((c) => c.name);
  const implemented = checks.every((c) => c.available);

  // v1 readiness: the CRITICAL real-time checks. ANDed with killSwitch + orderReconciliation in
  // infraReady, so this alone can NEVER enable live trading.
  const readyReasons: string[] = [];
  if (!live) readyReasons.push("no live inputs (report-only spec mode)");
  else {
    if (!reachable) readyReasons.push("exchange not reachable / no recent data");
    if (!marketDataFresh) readyReasons.push("market data stale or unknown");
    if (!feedsPresent) readyReasons.push("book/depth feeds not implemented");
    if (clockMeasured && !clockOk) readyReasons.push(`clock skew ${Math.round(live.clockSkewMs as number)}ms over tolerance`);
  }
  const ready = readyReasons.length === 0 && !!live;

  const summary = ready
    ? `Exchange health v1 READY: reachable + market data fresh + feeds present + clock ok (${availableCount}/${checks.length} checks have data).`
    : `Exchange health NOT ready: ${readyReasons.join("; ") || `${missingChecks.length} checks missing`}.`;

  return {
    reportOnly: true,
    module: EXCHANGE_HEALTH_READINESS_MODULE,
    computedAt,
    implemented,
    ready,
    readyReasons,
    checks,
    availableCount,
    missingChecks,
    summary,
  };
}

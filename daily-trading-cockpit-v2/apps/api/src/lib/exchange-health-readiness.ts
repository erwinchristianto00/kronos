/**
 * AG. EXCHANGE HEALTH READINESS — REPORT-ONLY SPEC (PARTIAL DATA AVAILABILITY)
 *
 * Describes the FUTURE exchange-health monitoring that would have to exist
 * BEFORE any micro-pilot could be discussed. Some checks can already report
 * data AVAILABILITY from the AC microstructure collector (book ticker / depth /
 * funding / open interest / spread distribution), but data availability is NOT
 * the same as a live monitoring + alerting loop — so `ready` is ALWAYS false.
 *
 * Pure module: zero I/O, no side effects, never throws. Reads only the already
 * built microstructure report.
 */

import type { MicrostructureCollectorReport } from "./microstructure-feature-collector.js";

export const EXCHANGE_HEALTH_READINESS_MODULE = "EXCHANGE_HEALTH_READINESS" as const;

export type ExchangeHealthSource = "AC_MICROSTRUCTURE" | "NOT_AVAILABLE" | "FUTURE";

export interface ExchangeHealthCheck {
  name: string;
  description: string;
  available: boolean; // some may be true from AC microstructure
  source: ExchangeHealthSource;
  currentValue?: string;
}

export interface ExchangeHealthReadinessReport {
  reportOnly: true;
  module: typeof EXCHANGE_HEALTH_READINESS_MODULE;
  computedAt: string;
  implemented: boolean; // partial — true only if ALL checks available
  ready: false; // always false (need ALL + monitoring loop)
  checks: ExchangeHealthCheck[];
  availableCount: number;
  missingChecks: string[];
  summary: string;
}

function pct(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}

export function buildExchangeHealthReadinessReport(
  microstructure: MicrostructureCollectorReport | undefined,
  capturedAt?: string,
): ExchangeHealthReadinessReport {
  const computedAt = capturedAt ?? new Date().toISOString();

  const ms = microstructure;
  const bookTickerAvail = ms?.bookTickerQtyAvailability ?? 0;
  const depthAvail = ms?.depthAvailability ?? 0;
  const fundingAvail = ms?.fundingRateAvailability ?? 0;
  const oiAvail = ms?.openInterestAvailability ?? 0;
  const spread = ms?.latestSpreadDistribution;
  const spreadPresent =
    !!spread &&
    [spread.p50, spread.p90, spread.p99].some(
      (v) => typeof v === "number" && Number.isFinite(v),
    );

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
      available: bookTickerAvail > 0,
      source: bookTickerAvail > 0 ? "AC_MICROSTRUCTURE" : "NOT_AVAILABLE",
      currentValue: `bookTickerQtyAvailability=${pct(bookTickerAvail)}`,
    },
    {
      name: "depth_freshness",
      description: "Top-of-book depth freshness from the depth feed.",
      available: depthAvail > 0,
      source: depthAvail > 0 ? "AC_MICROSTRUCTURE" : "NOT_AVAILABLE",
      currentValue: `depthAvailability=${pct(depthAvail)}`,
    },
    {
      name: "funding_freshness",
      description: "Funding-rate freshness from the premium-index feed.",
      available: fundingAvail > 0,
      source: fundingAvail > 0 ? "AC_MICROSTRUCTURE" : "NOT_AVAILABLE",
      currentValue: `fundingRateAvailability=${pct(fundingAvail)}`,
    },
    {
      name: "openinterest_freshness",
      description: "Open-interest freshness.",
      available: oiAvail > 0,
      source: oiAvail > 0 ? "AC_MICROSTRUCTURE" : "NOT_AVAILABLE",
      currentValue: `openInterestAvailability=${pct(oiAvail)}`,
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
      available: spreadPresent,
      source: spreadPresent ? "AC_MICROSTRUCTURE" : "NOT_AVAILABLE",
      currentValue: spreadPresent
        ? `spread p99 reference=${typeof spread?.p99 === "number" ? spread!.p99.toFixed(1) + "bps" : "n/a"}`
        : "spread distribution unavailable",
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

  const availableCount = checks.filter((c) => c.available).length;
  const missingChecks = checks.filter((c) => !c.available).map((c) => c.name);
  const implemented = checks.every((c) => c.available);

  const summary =
    `Exchange health PARTIAL: ${availableCount}/${checks.length} checks have data from AC microstructure; ` +
    `${missingChecks.length} missing. No monitoring/alerting loop. NOT ready.`;

  return {
    reportOnly: true,
    module: EXCHANGE_HEALTH_READINESS_MODULE,
    computedAt,
    implemented,
    ready: false,
    checks,
    availableCount,
    missingChecks,
    summary,
  };
}

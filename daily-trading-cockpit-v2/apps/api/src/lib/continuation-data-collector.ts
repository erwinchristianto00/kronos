/**
 * Independent public-market collector for continuation research.
 *
 * It is intentionally separate from the trading API: failure affects only data freshness and
 * future challenger eligibility. Existing champion inference has documented missing-data routes;
 * no collector path can place, close or resize an order.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CROSS_SECTIONAL_UNIVERSE } from "./cross-sectional-edge.js";
import {
  CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
  CONTINUATION_RAW_SCHEMA_VERSION,
  appendRawEvent,
  collectorHealthFile,
  continuationLifecyclePaths,
  continuationNowIso,
  ensureContinuationLifecycleDirectories,
  readCollectorHealth,
  type ContinuationCollectorHealth,
  type ContinuationLifecyclePaths,
  type ContinuationRawEvent,
  type ContinuationWatermark,
  validateRawEvent,
  writeCollectorHealth,
  writeJsonAtomic,
} from "./continuation-lifecycle.js";

export const CONTINUATION_BINANCE_INTERVALS = ["1m", "5m", "1h"] as const;
export type ContinuationBinanceInterval = (typeof CONTINUATION_BINANCE_INTERVALS)[number];

export const CONTINUATION_INTERVAL_MS: Record<ContinuationBinanceInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "1h": 3_600_000,
};

export const CONTINUATION_COLLECTOR_SYMBOLS = Array.from(new Set([
  ...CROSS_SECTIONAL_UNIVERSE,
  "BTCUSDT",
  "ETHUSDT",
])).sort();

// These six were already supported by the legacy collector. They remain diagnostic inputs until
// an explicitly versioned feature-set challenger earns them; collecting them is not a model change.
const CROSS_VENUE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"] as const;
const OKX_LIQUIDATION_UNDERLYINGS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"] as const;
const BINANCE_PUBLIC_BASE = "https://fapi.binance.com";

type JsonFetcher = (url: string) => Promise<unknown>;

export type ContinuationKline = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  trades: number | null;
  takerBuyBase: number | null;
  takerBuyQuote: number | null;
  interval: ContinuationBinanceInterval;
};

export type ContinuationDataCollectorOptions = {
  paths?: ContinuationLifecyclePaths;
  symbols?: readonly string[];
  nowMs?: () => number;
  fetchJson?: JsonFetcher;
  logger?: (event: string, details: Record<string, unknown>) => void;
  binanceBaseUrl?: string;
};

function finite(value: unknown): number | null {
  const out = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(out) ? out : null;
}

function positive(value: unknown): number | null {
  const out = finite(value);
  return out !== null && out > 0 ? out : null;
}

function asTime(value: unknown): number | null {
  const out = finite(value);
  return out !== null && out > 946684800000 && out < 4102444800000 ? Math.trunc(out) : null;
}

function normalizedSymbol(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9]{4,30}$/.test(value) ? value : null;
}

function markerKey(source: string, dataType: string, symbol: string | null): string {
  return `${source}:${dataType}:${symbol ?? "MARKET"}`;
}

function emptyWatermark(source: string, dataType: string, symbol: string | null, nowMs: number): ContinuationWatermark {
  return {
    source,
    dataType,
    symbol,
    lastEventTimestampMs: null,
    lastReceivedTimestampMs: null,
    lastValidatedTimestampMs: null,
    gapCount: 0,
    unresolvedGapCount: 0,
    earliestUnresolvedGapTimestampMs: null,
    duplicateCount: 0,
    invalidCount: 0,
    freshness: "UNKNOWN",
    updatedAt: continuationNowIso(nowMs),
    lastError: null,
  };
}

function freshnessFor(watermark: ContinuationWatermark, nowMs: number): ContinuationWatermark["freshness"] {
  if (watermark.lastReceivedTimestampMs === null) return "UNKNOWN";
  if (watermark.unresolvedGapCount > 0) return "GAPPED";
  const dataType = watermark.dataType;
  const maxAge = dataType.includes("kline_1m") ? 5 * 60_000
    : dataType.includes("kline_5m") ? 20 * 60_000
      : dataType.includes("kline_1h") ? 2 * 3_600_000
        : dataType.includes("funding") ? 12 * 3_600_000
          : 6 * 3_600_000;
  return nowMs - watermark.lastReceivedTimestampMs <= maxAge ? "HEALTHY" : "STALE";
}

function isRequiredWatermark(watermark: ContinuationWatermark): boolean {
  // Price is mandatory for a meaningful continuation reading. Everything else is optional and
  // becomes an explicit missing feature, never a fabricated zero.
  return watermark.source === "binance-usdm" &&
    ["kline_1m", "kline_5m", "kline_1h"].includes(watermark.dataType) &&
    watermark.symbol !== null;
}

function mergeFreshness(values: ContinuationWatermark["freshness"][]): ContinuationWatermark["freshness"] {
  if (!values.length) return "UNKNOWN";
  if (values.includes("GAPPED")) return "GAPPED";
  if (values.includes("STALE")) return "STALE";
  if (values.includes("UNKNOWN")) return "UNKNOWN";
  return "HEALTHY";
}

function parseArrayKline(row: unknown, interval: ContinuationBinanceInterval): ContinuationKline | null {
  if (!Array.isArray(row)) return null;
  const openTime = asTime(row[0]);
  const open = positive(row[1]);
  const high = positive(row[2]);
  const low = positive(row[3]);
  const close = positive(row[4]);
  const volume = finite(row[5]);
  const closeTime = asTime(row[6]);
  if (
    openTime === null || closeTime === null || open === null || high === null || low === null || close === null ||
    volume === null || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low
  ) return null;
  return {
    openTime, closeTime, open, high, low, close, volume,
    quoteVolume: finite(row[7]), trades: finite(row[8]), takerBuyBase: finite(row[9]), takerBuyQuote: finite(row[10]), interval,
  };
}

export function parseBinanceKlineRows(
  value: unknown,
  symbol: string,
  interval: ContinuationBinanceInterval,
  receivedTimestampMs: number,
  completedBeforeMs: number,
): ContinuationRawEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const kline = parseArrayKline(row, interval);
    if (!kline || kline.closeTime >= completedBeforeMs) return [];
    return [{
      schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
      source: "binance-usdm",
      symbol,
      dataType: `kline_${interval}`,
      eventTimestampMs: kline.openTime,
      receivedTimestampMs,
      sourceRecordId: `${symbol}:${interval}:${kline.openTime}`,
      payload: kline,
    }];
  });
}

/** Parser for the Binance combined-stream kline message. Only a completed candle is persisted. */
export function parseBinanceWsKline(
  value: unknown,
  receivedTimestampMs: number,
): ContinuationRawEvent | null {
  const outer = value as { data?: unknown } | null;
  const raw = (outer?.data ?? outer) as {
    e?: unknown; s?: unknown; k?: {
      t?: unknown; T?: unknown; i?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown;
      v?: unknown; q?: unknown; n?: unknown; V?: unknown; Q?: unknown; x?: unknown;
    };
  } | null;
  if (raw?.e !== "kline" || raw.k?.x !== true) return null;
  const symbol = normalizedSymbol(raw.s);
  const interval = raw.k.i;
  if (!symbol || !CONTINUATION_BINANCE_INTERVALS.includes(interval as ContinuationBinanceInterval)) return null;
  const kline = parseArrayKline([
    raw.k.t, raw.k.o, raw.k.h, raw.k.l, raw.k.c, raw.k.v, raw.k.T, raw.k.q, raw.k.n, raw.k.V, raw.k.Q,
  ], interval as ContinuationBinanceInterval);
  if (!kline) return null;
  return {
    schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
    source: "binance-usdm",
    symbol,
    dataType: `kline_${interval}`,
    eventTimestampMs: kline.openTime,
    receivedTimestampMs,
    sourceRecordId: `${symbol}:${interval}:${kline.openTime}`,
    payload: kline,
  };
}

function readRows(path: string): unknown[][] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((row): row is unknown[] => Array.isArray(row)) : [];
  } catch {
    return [];
  }
}

function upsertRows(path: string, rows: readonly unknown[][]): void {
  if (!rows.length) return;
  const byTimestamp = new Map<number, unknown[]>();
  for (const row of readRows(path)) {
    const timestamp = asTime(row[0]);
    if (timestamp !== null) byTimestamp.set(timestamp, row);
  }
  for (const row of rows) {
    const timestamp = asTime(row[0]);
    if (timestamp !== null) byTimestamp.set(timestamp, row);
  }
  writeJsonAtomic(path, [...byTimestamp.entries()].sort(([a], [b]) => a - b).map(([, row]) => row));
}

function materializedKlinePath(paths: ContinuationLifecyclePaths, symbol: string, interval: ContinuationBinanceInterval): string {
  // The matrix/runtime consume complete 1h bars. Lower intervals remain in raw storage and become
  // available for an explicitly versioned future feature-set challenger, not a silent V4 change.
  return interval === "1h"
    ? resolve(paths.materialized, "ohlcv", `${symbol}.json`)
    : resolve(paths.materialized, "binance", "klines", interval, `${symbol}.json`);
}

function klineMaterializedRow(event: ContinuationRawEvent): { symbol: string; interval: ContinuationBinanceInterval; row: unknown[] } | null {
  const payload = event.payload as Partial<ContinuationKline>;
  const interval = payload.interval;
  if (!event.symbol || !CONTINUATION_BINANCE_INTERVALS.includes(interval as ContinuationBinanceInterval)) return null;
  const kline = payload as ContinuationKline;
  return {
    symbol: event.symbol,
    interval: interval as ContinuationBinanceInterval,
    row: [
    kline.openTime, kline.open, kline.high, kline.low, kline.close, kline.volume,
    kline.closeTime, kline.quoteVolume ?? 0, kline.trades ?? 0, kline.takerBuyBase ?? null, kline.takerBuyQuote ?? null,
    ],
  };
}

function materializeKline(event: ContinuationRawEvent, paths: ContinuationLifecyclePaths): void {
  const value = klineMaterializedRow(event);
  if (value) upsertRows(materializedKlinePath(paths, value.symbol, value.interval), [value.row]);
}

function fundingMaterializedRow(event: ContinuationRawEvent): { symbol: string; row: unknown[] } | null {
  const rate = finite(event.payload.fundingRate);
  return event.symbol && rate !== null ? { symbol: event.symbol, row: [event.eventTimestampMs, rate] } : null;
}

function materializeFunding(event: ContinuationRawEvent, paths: ContinuationLifecyclePaths): void {
  const value = fundingMaterializedRow(event);
  if (value) upsertRows(resolve(paths.materialized, "funding", `${value.symbol}.json`), [value.row]);
}

function venueMaterializedRow(event: ContinuationRawEvent): { venue: string; symbol: string; row: unknown[] } | null {
  const close = positive(event.payload.close);
  const volume = finite(event.payload.volume);
  if (!event.symbol || close === null || volume === null) return null;
  const venue = event.source.replace("-public", "");
  return ["bybit", "okx", "coinbase"].includes(venue) ? { venue, symbol: event.symbol, row: [event.eventTimestampMs, close, volume] } : null;
}

function materializeVenueKline(event: ContinuationRawEvent, paths: ContinuationLifecyclePaths): void {
  const value = venueMaterializedRow(event);
  if (value) upsertRows(resolve(paths.materialized, "raw", value.venue, `${value.symbol}.json`), [value.row]);
}

function dvolMaterializedRow(event: ContinuationRawEvent): { currency: string; row: unknown[] } | null {
  const value = positive(event.payload.value);
  const currency = typeof event.payload.currency === "string" ? event.payload.currency : null;
  return currency && value !== null && ["BTC", "ETH"].includes(currency)
    ? { currency, row: [event.eventTimestampMs, value] }
    : null;
}

function materializeDvol(event: ContinuationRawEvent, paths: ContinuationLifecyclePaths): void {
  const value = dvolMaterializedRow(event);
  if (value) upsertRows(resolve(paths.materialized, "raw", "options", `DVOL_${value.currency}.json`), [value.row]);
}

export class ContinuationDataCollector {
  readonly paths: ContinuationLifecyclePaths;
  readonly symbols: readonly string[];
  private readonly now: () => number;
  private readonly fetchJson: JsonFetcher;
  private readonly logger: (event: string, details: Record<string, unknown>) => void;
  private readonly binanceBaseUrl: string;
  private watermarks: Record<string, ContinuationWatermark>;
  private eventsToday: Record<string, number> = {};

  constructor(options: ContinuationDataCollectorOptions = {}) {
    this.paths = ensureContinuationLifecycleDirectories(options.paths ?? continuationLifecyclePaths());
    this.symbols = Array.from(new Set((options.symbols ?? CONTINUATION_COLLECTOR_SYMBOLS).map((symbol) => symbol.toUpperCase()))).sort();
    this.now = options.nowMs ?? (() => Date.now());
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.logger = options.logger ?? (() => undefined);
    this.binanceBaseUrl = (options.binanceBaseUrl ?? BINANCE_PUBLIC_BASE).replace(/\/$/, "");
    this.watermarks = readCollectorHealth(this.paths)?.watermarks ?? {};
    // Health files are durable across releases.  A pre-field file has no known
    // unresolved gap, so retain its historical counter but do not permanently
    // poison freshness solely because an older collector once saw a gap.
    for (const watermark of Object.values(this.watermarks)) {
      watermark.unresolvedGapCount = Number.isFinite(watermark.unresolvedGapCount)
        ? Math.max(0, watermark.unresolvedGapCount)
        : 0;
      watermark.earliestUnresolvedGapTimestampMs = Number.isFinite(watermark.earliestUnresolvedGapTimestampMs)
        ? Math.trunc(watermark.earliestUnresolvedGapTimestampMs!)
        : null;
    }
  }

  private watermark(source: string, dataType: string, symbol: string | null, nowMs: number): ContinuationWatermark {
    const key = markerKey(source, dataType, symbol);
    return this.watermarks[key] ?? (this.watermarks[key] = emptyWatermark(source, dataType, symbol, nowMs));
  }

  private touchError(source: string, dataType: string, symbol: string | null, error: unknown, nowMs: number): void {
    const watermark = this.watermark(source, dataType, symbol, nowMs);
    watermark.updatedAt = continuationNowIso(nowMs);
    watermark.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    watermark.freshness = freshnessFor(watermark, nowMs);
  }

  private record(event: ContinuationRawEvent, intervalMs: number | null = null, materialize = true): boolean {
    const nowMs = event.receivedTimestampMs;
    // `event` is statically constructed by adapters, but still validate the emitted wire form
    // before persistence. Cast through unknown so the type guard does not narrow a known object to
    // `never` in its diagnostic branch.
    if (!validateRawEvent(event as unknown)) {
      const watermark = this.watermark(event.source, event.dataType, event.symbol, nowMs);
      watermark.invalidCount += 1;
      watermark.updatedAt = continuationNowIso(nowMs);
      watermark.lastError = "invalid_event_contract";
      return false;
    }
    const watermark = this.watermark(event.source, event.dataType, event.symbol, nowMs);
    const prior = watermark.lastEventTimestampMs;
    if (prior !== null && event.eventTimestampMs === prior) {
      watermark.duplicateCount += 1;
      watermark.lastReceivedTimestampMs = nowMs;
      watermark.updatedAt = continuationNowIso(nowMs);
      watermark.freshness = freshnessFor(watermark, nowMs);
      return false;
    }
    if (prior !== null && intervalMs !== null && event.eventTimestampMs > prior + intervalMs) {
      watermark.gapCount += 1;
      watermark.unresolvedGapCount += 1;
      const firstMissing = prior + intervalMs;
      watermark.earliestUnresolvedGapTimestampMs = watermark.earliestUnresolvedGapTimestampMs === null
        ? firstMissing
        : Math.min(watermark.earliestUnresolvedGapTimestampMs, firstMissing);
    }
    try {
      appendRawEvent(event, this.paths);
    } catch (error) {
      watermark.invalidCount += 1;
      watermark.lastError = error instanceof Error ? error.message : "raw_append_failed";
      watermark.updatedAt = continuationNowIso(nowMs);
      return false;
    }
    watermark.lastEventTimestampMs = Math.max(prior ?? event.eventTimestampMs, event.eventTimestampMs);
    watermark.lastReceivedTimestampMs = nowMs;
    watermark.lastValidatedTimestampMs = event.eventTimestampMs;
    watermark.updatedAt = continuationNowIso(nowMs);
    watermark.lastError = null;
    watermark.freshness = freshnessFor(watermark, nowMs);
    this.eventsToday[`${event.source}:${event.dataType}`] = (this.eventsToday[`${event.source}:${event.dataType}`] ?? 0) + 1;
    if (materialize) {
      if (event.source === "binance-usdm" && event.dataType.startsWith("kline_")) materializeKline(event, this.paths);
      else if (event.source === "binance-usdm" && event.dataType === "funding_rate") materializeFunding(event, this.paths);
      else if (["bybit-public", "okx-public", "coinbase-public"].includes(event.source)) materializeVenueKline(event, this.paths);
      else if (event.source === "deribit" && event.dataType === "dvol") materializeDvol(event, this.paths);
    }
    return true;
  }

  ingestWebsocketMessage(value: unknown, receivedTimestampMs = this.now()): boolean {
    const event = parseBinanceWsKline(value, receivedTimestampMs);
    if (!event) return false;
    const interval = (event.payload.interval ?? null) as ContinuationBinanceInterval | null;
    return this.record(event, interval ? CONTINUATION_INTERVAL_MS[interval] : null);
  }

  private async collectBinanceKline(symbol: string, interval: ContinuationBinanceInterval, nowMs: number): Promise<number> {
    const watermark = this.watermark("binance-usdm", `kline_${interval}`, symbol, nowMs);
    const intervalMs = CONTINUATION_INTERVAL_MS[interval];
    const repairingGap = watermark.earliestUnresolvedGapTimestampMs !== null;
    let startTime = watermark.earliestUnresolvedGapTimestampMs
      ?? (watermark.lastEventTimestampMs !== null
        ? watermark.lastEventTimestampMs + intervalMs
        : nowMs - 1_500 * intervalMs);
    try {
      let recorded = 0;
      const materialized: unknown[][] = [];
      let pages = 0;
      let repairComplete = !repairingGap;
      // A normal cycle needs one incremental request. A detected WebSocket gap
      // is paged from its first missing candle, bounded to prevent a bad source
      // from monopolising the host. A partial repair remains visibly GAPPED.
      while (pages < (repairingGap ? 16 : 1) && startTime < nowMs) {
        const url = new URL(`${this.binanceBaseUrl}/fapi/v1/klines`);
        url.searchParams.set("symbol", symbol);
        url.searchParams.set("interval", interval);
        url.searchParams.set("startTime", String(startTime));
        url.searchParams.set("endTime", String(nowMs));
        url.searchParams.set("limit", "1500");
        const rows = await this.fetchJson(url.toString());
        if (!Array.isArray(rows)) throw new Error("kline response is not an array");
        const events = parseBinanceKlineRows(rows, symbol, interval, nowMs, nowMs);
        for (const event of events) {
          if (this.record(event, intervalMs, false)) {
            recorded += 1;
            const row = klineMaterializedRow(event);
            if (row) materialized.push(row.row);
          }
        }
        pages += 1;
        const lastTimestamp = events.at(-1)?.eventTimestampMs ?? null;
        const completeThrough = nowMs - intervalMs;
        if (lastTimestamp !== null && lastTimestamp >= completeThrough - intervalMs) {
          repairComplete = true;
          break;
        }
        if (events.length < 1_500 || lastTimestamp === null) break;
        startTime = lastTimestamp + intervalMs;
      }
      upsertRows(materializedKlinePath(this.paths, symbol, interval), materialized);
      // REST is the repair authority only after the response reaches the most
      // recent complete candle. The cumulative counter remains auditable.
      if (repairingGap && repairComplete) {
        watermark.unresolvedGapCount = 0;
        watermark.earliestUnresolvedGapTimestampMs = null;
      }
      watermark.freshness = freshnessFor(watermark, nowMs);
      return recorded;
    } catch (error) {
      this.touchError("binance-usdm", `kline_${interval}`, symbol, error, nowMs);
      throw error;
    }
  }

  private async collectFunding(symbol: string, nowMs: number): Promise<number> {
    const watermark = this.watermark("binance-usdm", "funding_rate", symbol, nowMs);
    const url = new URL(`${this.binanceBaseUrl}/fapi/v1/fundingRate`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("limit", "1000");
    if (watermark.lastEventTimestampMs !== null) url.searchParams.set("startTime", String(watermark.lastEventTimestampMs + 1));
    try {
      const rows = await this.fetchJson(url.toString());
      if (!Array.isArray(rows)) throw new Error("funding response is not an array");
      let recorded = 0;
      const materialized: unknown[][] = [];
      for (const row of rows) {
        const item = row as { fundingTime?: unknown; fundingRate?: unknown };
        const timestamp = asTime(item.fundingTime);
        const rate = finite(item.fundingRate);
        if (timestamp === null || rate === null) continue;
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source: "binance-usdm",
          symbol,
          dataType: "funding_rate",
          eventTimestampMs: timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `${symbol}:funding:${timestamp}`,
          payload: { fundingRate: rate },
        };
        if (this.record(event, null, false)) {
          recorded += 1;
          const row = fundingMaterializedRow(event);
          if (row) materialized.push(row.row);
        }
      }
      upsertRows(resolve(this.paths.materialized, "funding", `${symbol}.json`), materialized);
      return recorded;
    } catch (error) {
      this.touchError("binance-usdm", "funding_rate", symbol, error, nowMs);
      throw error;
    }
  }

  private async collectPremium(symbol: string, nowMs: number): Promise<number> {
    const url = new URL(`${this.binanceBaseUrl}/fapi/v1/premiumIndex`);
    url.searchParams.set("symbol", symbol);
    try {
      const row = await this.fetchJson(url.toString()) as {
        time?: unknown; markPrice?: unknown; indexPrice?: unknown; lastFundingRate?: unknown; nextFundingTime?: unknown;
      };
      const timestamp = asTime(row.time) ?? nowMs;
      const markPrice = positive(row.markPrice);
      const indexPrice = positive(row.indexPrice);
      const fundingRate = finite(row.lastFundingRate);
      if (markPrice === null || indexPrice === null || fundingRate === null) throw new Error("premium response missing finite mark/index/funding");
      const event: ContinuationRawEvent = {
        schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
        source: "binance-usdm",
        symbol,
        dataType: "premium_index",
        eventTimestampMs: timestamp,
        receivedTimestampMs: nowMs,
        sourceRecordId: `${symbol}:premium:${timestamp}`,
        payload: { markPrice, indexPrice, fundingRate, nextFundingTime: asTime(row.nextFundingTime) },
      };
      return this.record(event, null) ? 1 : 0;
    } catch (error) {
      this.touchError("binance-usdm", "premium_index", symbol, error, nowMs);
      throw error;
    }
  }

  private async collectOpenInterest(symbol: string, nowMs: number): Promise<number> {
    const watermark = this.watermark("binance-usdm", "open_interest_1h", symbol, nowMs);
    const url = new URL(`${this.binanceBaseUrl}/futures/data/openInterestHist`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("period", "1h");
    url.searchParams.set("limit", "500");
    if (watermark.lastEventTimestampMs !== null) url.searchParams.set("startTime", String(watermark.lastEventTimestampMs + 1));
    try {
      const rows = await this.fetchJson(url.toString());
      if (!Array.isArray(rows)) throw new Error("open interest response is not an array");
      let recorded = 0;
      for (const row of rows) {
        const item = row as { timestamp?: unknown; sumOpenInterest?: unknown; sumOpenInterestValue?: unknown };
        const timestamp = asTime(item.timestamp);
        const contracts = finite(item.sumOpenInterest);
        const valueUsd = finite(item.sumOpenInterestValue);
        if (timestamp === null || contracts === null || valueUsd === null) continue;
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source: "binance-usdm",
          symbol,
          dataType: "open_interest_1h",
          eventTimestampMs: timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `${symbol}:oi:${timestamp}`,
          payload: { contracts, valueUsd },
        };
        if (this.record(event, 3_600_000)) recorded += 1;
      }
      return recorded;
    } catch (error) {
      this.touchError("binance-usdm", "open_interest_1h", symbol, error, nowMs);
      throw error;
    }
  }

  private async collectTakerRatio(symbol: string, nowMs: number): Promise<number> {
    const watermark = this.watermark("binance-usdm", "taker_ratio_1h", symbol, nowMs);
    const url = new URL(`${this.binanceBaseUrl}/futures/data/takerlongshortRatio`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("period", "1h");
    url.searchParams.set("limit", "500");
    if (watermark.lastEventTimestampMs !== null) url.searchParams.set("startTime", String(watermark.lastEventTimestampMs + 1));
    try {
      const rows = await this.fetchJson(url.toString());
      if (!Array.isArray(rows)) throw new Error("taker ratio response is not an array");
      let recorded = 0;
      for (const row of rows) {
        const item = row as { timestamp?: unknown; buySellRatio?: unknown; buyVol?: unknown; sellVol?: unknown };
        const timestamp = asTime(item.timestamp);
        const ratio = finite(item.buySellRatio);
        if (timestamp === null || ratio === null || ratio < 0) continue;
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source: "binance-usdm",
          symbol,
          dataType: "taker_ratio_1h",
          eventTimestampMs: timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `${symbol}:taker:${timestamp}`,
          payload: { buySellRatio: ratio, buyVolume: finite(item.buyVol), sellVolume: finite(item.sellVol) },
        };
        if (this.record(event, 3_600_000)) recorded += 1;
      }
      return recorded;
    } catch (error) {
      this.touchError("binance-usdm", "taker_ratio_1h", symbol, error, nowMs);
      throw error;
    }
  }

  private async collectVenueKline(venue: "bybit" | "okx" | "coinbase", symbol: string, nowMs: number): Promise<number> {
    const source = `${venue}-public`;
    const dataType = "venue_kline_1h";
    const watermark = this.watermark(source, dataType, symbol, nowMs);
    try {
      const rows = await this.fetchVenueRows(venue, symbol);
      let recorded = 0;
      const materialized: unknown[][] = [];
      for (const row of rows.sort((a, b) => (finite(a.timestamp) ?? 0) - (finite(b.timestamp) ?? 0))) {
        const timestamp = asTime(row.timestamp);
        const close = positive(row.close);
        const volume = finite(row.volume);
        if (timestamp === null || close === null || volume === null || volume < 0) continue;
        // Venue endpoints return a rolling history on every poll. Their older rows are already
        // materialized; suppressing them here preserves immutable raw source identity without
        // blocking the ordered, forward-only current candle.
        if (watermark.lastEventTimestampMs !== null && timestamp <= watermark.lastEventTimestampMs) {
          watermark.duplicateCount += 1;
          continue;
        }
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source,
          symbol,
          dataType,
          eventTimestampMs: timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `${venue}:${symbol}:${timestamp}`,
          payload: { close, volume },
        };
        if (this.record(event, 3_600_000, false)) {
          recorded += 1;
          const row = venueMaterializedRow(event);
          if (row) materialized.push(row.row);
        }
      }
      upsertRows(resolve(this.paths.materialized, "raw", venue, `${symbol}.json`), materialized);
      return recorded;
    } catch (error) {
      this.touchError(source, dataType, symbol, error, nowMs);
      throw error;
    }
  }

  private async collectLiquidations(underlying: (typeof OKX_LIQUIDATION_UNDERLYINGS)[number], nowMs: number): Promise<number> {
    const symbol = `${underlying.split("-")[0]}USDT`;
    const source = "okx-public";
    const dataType = "liquidation";
    const watermark = this.watermark(source, dataType, symbol, nowMs);
    const url = new URL("https://www.okx.com/api/v5/public/liquidation-orders");
    url.searchParams.set("instType", "SWAP");
    url.searchParams.set("state", "filled");
    url.searchParams.set("uly", underlying);
    url.searchParams.set("limit", "100");
    try {
      const payload = await this.fetchJson(url.toString()) as { data?: unknown[] };
      const rows: Array<{ timestamp: number; posSide: string; size: number; price: number }> = [];
      for (const block of payload.data ?? []) {
        const details = (block as { details?: unknown }).details;
        if (!Array.isArray(details)) continue;
        for (const detail of details) {
          const item = detail as { ts?: unknown; posSide?: unknown; sz?: unknown; bkPx?: unknown };
          const timestamp = asTime(item.ts);
          const posSide = item.posSide === "long" || item.posSide === "short" ? item.posSide : null;
          const size = positive(item.sz);
          const price = positive(item.bkPx);
          if (timestamp !== null && posSide && size !== null && price !== null) rows.push({ timestamp, posSide, size, price });
        }
      }
      let recorded = 0;
      for (const row of rows.sort((a, b) => a.timestamp - b.timestamp)) {
        if (watermark.lastEventTimestampMs !== null && row.timestamp <= watermark.lastEventTimestampMs) {
          watermark.duplicateCount += 1;
          continue;
        }
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source,
          symbol,
          dataType,
          eventTimestampMs: row.timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `okx-liquidation:${underlying}:${row.timestamp}:${row.posSide}:${row.size}:${row.price}`,
          payload: {
            underlying,
            liquidatedPositionSide: row.posSide,
            forcedDirection: row.posSide === "long" ? "SELL" : "BUY",
            size: row.size,
            price: row.price,
          },
        };
        if (this.record(event, null)) recorded += 1;
      }
      return recorded;
    } catch (error) {
      this.touchError(source, dataType, symbol, error, nowMs);
      throw error;
    }
  }

  private async fetchVenueRows(venue: "bybit" | "okx" | "coinbase", symbol: string): Promise<Array<{ timestamp: unknown; close: unknown; volume: unknown }>> {
    if (venue === "bybit") {
      const url = new URL("https://api.bybit.com/v5/market/kline");
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", "60");
      url.searchParams.set("limit", "200");
      const payload = await this.fetchJson(url.toString()) as { result?: { list?: unknown[] } };
      return (payload.result?.list ?? []).flatMap((row) => Array.isArray(row)
        ? [{ timestamp: row[0], close: row[4], volume: row[5] }]
        : []);
    }
    if (venue === "okx") {
      const base = symbol.replace("USDT", "-USDT-SWAP");
      const url = new URL("https://www.okx.com/api/v5/market/candles");
      url.searchParams.set("instId", base);
      url.searchParams.set("bar", "1H");
      url.searchParams.set("limit", "100");
      const payload = await this.fetchJson(url.toString()) as { data?: unknown[] };
      return (payload.data ?? []).flatMap((row) => Array.isArray(row)
        ? [{ timestamp: row[0], close: row[4], volume: row[5] }]
        : []);
    }
    const product = symbol === "BTCUSDT" ? "BTC-USD" : symbol === "ETHUSDT" ? "ETH-USD" : null;
    if (!product) return [];
    const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
    url.searchParams.set("granularity", "3600");
    const payload = await this.fetchJson(url.toString());
    return Array.isArray(payload) ? payload.flatMap((row) => Array.isArray(row)
      ? [{ timestamp: typeof row[0] === "number" ? row[0] * 1000 : row[0], close: row[4], volume: row[5] }]
      : []) : [];
  }

  private async collectDvol(currency: "BTC" | "ETH", nowMs: number): Promise<number> {
    const url = new URL("https://www.deribit.com/api/v2/public/get_volatility_index_data");
    url.searchParams.set("currency", currency);
    url.searchParams.set("resolution", "3600");
    url.searchParams.set("start_timestamp", String(nowMs - 7 * 24 * 3_600_000));
    url.searchParams.set("end_timestamp", String(nowMs));
    try {
      const payload = await this.fetchJson(url.toString()) as { result?: { data?: unknown[] } };
      let recorded = 0;
      const materialized: unknown[][] = [];
      for (const row of payload.result?.data ?? []) {
        if (!Array.isArray(row)) continue;
        const timestamp = asTime(row[0]);
        // Deribit returns [timestamp, open, high, low, close] in its documented response.
        const value = positive(row[4] ?? row[1]);
        if (timestamp === null || value === null) continue;
        const event: ContinuationRawEvent = {
          schemaVersion: CONTINUATION_RAW_SCHEMA_VERSION,
          source: "deribit",
          symbol: null,
          dataType: "dvol",
          eventTimestampMs: timestamp,
          receivedTimestampMs: nowMs,
          sourceRecordId: `DVOL_${currency}:${timestamp}`,
          payload: { currency, value },
        };
        if (this.record(event, 3_600_000, false)) {
          recorded += 1;
          const row = dvolMaterializedRow(event);
          if (row) materialized.push(row.row);
        }
      }
      upsertRows(resolve(this.paths.materialized, "raw", "options", `DVOL_${currency}.json`), materialized);
      return recorded;
    } catch (error) {
      this.touchError("deribit", "dvol", null, error, nowMs);
      throw error;
    }
  }

  /** One REST pass performs startup backfill and reconciles any WebSocket gap. */
  async reconcileOnce(nowMs = this.now()): Promise<{ recorded: number; failed: number }> {
    let recorded = 0;
    let failed = 0;
    const run = async (task: () => Promise<number>): Promise<void> => {
      try { recorded += await task(); } catch (error) { failed += 1; this.logger("CONT_COLLECTOR_SOURCE_ERROR", { error: error instanceof Error ? error.message : String(error) }); }
    };
    // Keep public endpoint pressure bounded. Sequential per symbol is slower only during startup;
    // it avoids turning a reconnection into a source-wide rate-limit storm.
    for (const symbol of this.symbols) {
      for (const interval of CONTINUATION_BINANCE_INTERVALS) await run(() => this.collectBinanceKline(symbol, interval, nowMs));
      await run(() => this.collectFunding(symbol, nowMs));
      await run(() => this.collectPremium(symbol, nowMs));
      await run(() => this.collectOpenInterest(symbol, nowMs));
      await run(() => this.collectTakerRatio(symbol, nowMs));
    }
    for (const symbol of CROSS_VENUE_SYMBOLS) {
      for (const venue of ["bybit", "okx", "coinbase"] as const) await run(() => this.collectVenueKline(venue, symbol, nowMs));
    }
    for (const underlying of OKX_LIQUIDATION_UNDERLYINGS) await run(() => this.collectLiquidations(underlying, nowMs));
    for (const currency of ["BTC", "ETH"] as const) await run(() => this.collectDvol(currency, nowMs));
    this.writeHealth(nowMs);
    return { recorded, failed };
  }

  writeHealth(nowMs = this.now()): ContinuationCollectorHealth {
    for (const watermark of Object.values(this.watermarks)) watermark.freshness = freshnessFor(watermark, nowMs);
    const grouped = new Map<string, ContinuationWatermark[]>();
    for (const watermark of Object.values(this.watermarks)) {
      const key = `${watermark.source}:${watermark.dataType}`;
      const rows = grouped.get(key) ?? [];
      rows.push(watermark);
      grouped.set(key, rows);
    }
    const sourceSummary: ContinuationCollectorHealth["sourceSummary"] = {};
    for (const [key, rows] of grouped) {
      const last = rows.map((row) => row.lastReceivedTimestampMs).filter((value): value is number => value !== null);
      const ageMs = last.length ? nowMs - Math.min(...last) : null;
      sourceSummary[key] = {
        required: rows.some(isRequiredWatermark),
        freshness: mergeFreshness(rows.map((row) => row.freshness)),
        ageMs,
        eventsToday: this.eventsToday[key] ?? 0,
        lastError: rows.map((row) => row.lastError).find((value) => value !== null) ?? null,
      };
    }
    const health: ContinuationCollectorHealth = {
      schemaVersion: CONTINUATION_LIFECYCLE_SCHEMA_VERSION,
      updatedAt: continuationNowIso(nowMs),
      collectorId: `continuation-collector:${process.pid}`,
      running: true,
      watermarks: this.watermarks,
      sourceSummary,
    };
    writeCollectorHealth(health, this.paths);
    return health;
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.json() as Promise<unknown>;
}

/**
 * WebSocket-primary fast path for completed Binance candles. REST reconciliation remains required
 * on startup/reconnect and is what repairs a genuine interval gap.
 */
export class BinanceKlineWebsocketSupervisor {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    private readonly collector: ContinuationDataCollector,
    private readonly symbols: readonly string[] = CONTINUATION_COLLECTOR_SYMBOLS,
    private readonly now: () => number = () => Date.now(),
    private readonly logger: (event: string, details: Record<string, unknown>) => void = () => undefined,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch { /* no active socket */ }
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof WebSocket === "undefined") {
      this.logger("CONT_WS_UNAVAILABLE", { reason: "global WebSocket unavailable; REST reconciliation remains active" });
      return;
    }
    const streams = this.symbols.flatMap((symbol) => CONTINUATION_BINANCE_INTERVALS.map((interval) => `${symbol.toLowerCase()}@kline_${interval}`));
    const url = `wss://fstream.binance.com/stream?streams=${streams.join("/")}`;
    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.logger("CONT_WS_CONNECTED", { streams: streams.length });
      });
      socket.addEventListener("message", (event) => { void this.handleMessage(event.data); });
      socket.addEventListener("error", () => this.logger("CONT_WS_ERROR", { streams: streams.length }));
      socket.addEventListener("close", () => this.scheduleReconnect());
    } catch (error) {
      this.logger("CONT_WS_CONNECT_FAILED", { error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text = typeof data === "string" ? data
        : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8")
          : typeof (data as { text?: unknown })?.text === "function" ? await (data as Blob).text()
            : Buffer.from(data as ArrayBuffer).toString("utf8");
      this.collector.ingestWebsocketMessage(JSON.parse(text), this.now());
      this.collector.writeHealth(this.now());
    } catch (error) {
      this.logger("CONT_WS_MESSAGE_INVALID", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}

export function continuationCollectorHealthPath(paths = continuationLifecyclePaths()): string {
  return collectorHealthFile(paths);
}

export function continuationMaterializedRawExists(paths = continuationLifecyclePaths()): boolean {
  return existsSync(resolve(paths.materialized, "raw"));
}

export function continuationCollectorDataDir(paths = continuationLifecyclePaths()): string {
  return dirname(continuationCollectorHealthPath(paths));
}

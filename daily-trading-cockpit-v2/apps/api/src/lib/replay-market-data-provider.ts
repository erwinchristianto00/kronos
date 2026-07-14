/**
 * Historical replay — provider-neutral acquisition interfaces + stream verification (Phase 3). NO vendor is
 * hardwired and NO data is downloaded here: this defines the interface a provider must satisfy and the
 * bounded-memory verification every stream must pass (chronological ordering, gap detection, duplicate
 * detection, running checksum, no silent row loss). Actual acquisition is a mandatory-stop item and happens
 * only after the coverage + storage plan is reviewed. Pure.
 */
import { createHash } from "node:crypto";
import type { Candle } from "@dtc/shared";
import type { DataTier } from "./replay-data-tiers.js";

// ── Domain records (exchange + provider timestamps BOTH preserved) ────────────────────────────────
export interface Trade { ts: number; providerTs: number | null; price: number; qty: number; aggressorSide: "BUY" | "SELL" | null; }
export interface FundingPoint { ts: number; rate: number; }
export interface OpenInterestPoint { ts: number; openInterest: number; }
export interface Liquidation { ts: number; side: "LONG" | "SHORT"; qty: number; price: number; }
export interface OrderBookLevel { price: number; qty: number; }
export interface OrderBookSnapshot { ts: number; providerTs: number | null; bids: OrderBookLevel[]; asks: OrderBookLevel[]; }

export interface CoverageRequest { symbols: string[]; startMs: number; endMs: number; kinds: Array<"candles" | "trades" | "funding" | "openInterest" | "liquidations" | "orderBook">; }
export interface CoverageReport {
  provider: string;
  perSymbol: Array<{ symbol: string; kind: string; availableFromMs: number | null; availableToMs: number | null; tier: DataTier; paid: boolean; estBytes: number | null; note?: string }>;
}
export interface CandleRequest { symbol: string; interval: "1m" | "5m" | "15m" | "1h"; startMs: number; endMs: number; }
export interface TradeRequest { symbol: string; startMs: number; endMs: number; }
export interface FundingRequest { symbol: string; startMs: number; endMs: number; }
export interface OIRequest { symbol: string; startMs: number; endMs: number; }
export interface LiquidationRequest { symbol: string; startMs: number; endMs: number; }
export interface OrderBookRequest { symbol: string; startMs: number; endMs: number; }

/** The interface any historical provider must satisfy. Streaming (not full in-memory), resumable at the caller. */
export interface HistoricalMarketDataProvider {
  name: string;
  listCoverage(request: CoverageRequest): Promise<CoverageReport>;
  streamCandles(request: CandleRequest): AsyncIterable<Candle>;
  streamTrades(request: TradeRequest): AsyncIterable<Trade>;
  streamFunding(request: FundingRequest): AsyncIterable<FundingPoint>;
  streamOpenInterest(request: OIRequest): AsyncIterable<OpenInterestPoint>;
  streamLiquidations(request: LiquidationRequest): AsyncIterable<Liquidation>;
  streamOrderBook(request: OrderBookRequest): AsyncIterable<OrderBookSnapshot>;
}

// ── Bounded-memory stream verifier ───────────────────────────────────────────────────────────────
export interface StreamVerifierOpts {
  /** Expected cadence (ms) — a consecutive Δt beyond `gapFactor`× this is a gap. Omit to skip gap detection. */
  expectedIntervalMs?: number;
  gapFactor?: number;
  /** Reject (throw) on the first out-of-order event instead of just counting it. */
  strictOrder?: boolean;
}
export interface StreamVerifySummary {
  count: number;
  firstTs: number | null;
  lastTs: number | null;
  outOfOrder: number;
  duplicates: number;
  gaps: number;
  gapTotalMs: number;
  /** Rolling checksum over (ts,key) in stream order — pins the exact sequence for the manifest. */
  checksum: string;
  reconciles: boolean;
}

/** Stateful, O(1)-memory verifier. Feed events in stream order; it never holds the whole stream. Duplicate
 *  detection is over the immediately-preceding key (bounded); full-corpus dedup is the manifest checksum's job. */
export function createStreamVerifier(opts: StreamVerifierOpts = {}) {
  const gapFactor = opts.gapFactor ?? 1.5;
  let count = 0, outOfOrder = 0, duplicates = 0, gaps = 0, gapTotalMs = 0;
  let firstTs: number | null = null, lastTs: number | null = null, lastKey: string | null = null;
  const hash = createHash("sha256");
  return {
    feed(ts: number, key?: string): void {
      if (!Number.isFinite(ts)) throw new Error("non-finite timestamp in stream");
      const k = key ?? String(ts);
      hash.update(`${ts}|${k}\n`);
      if (firstTs === null) firstTs = ts;
      if (lastTs !== null) {
        if (ts < lastTs) { outOfOrder += 1; if (opts.strictOrder) throw new Error(`out-of-order event at ${ts} < ${lastTs}`); }
        else if (ts === lastTs && k === lastKey) { duplicates += 1; }
        else if (opts.expectedIntervalMs && ts - lastTs > gapFactor * opts.expectedIntervalMs) { gaps += 1; gapTotalMs += ts - lastTs - opts.expectedIntervalMs; }
      }
      lastTs = ts; lastKey = k; count += 1;
    },
    summary(): StreamVerifySummary {
      return { count, firstTs, lastTs, outOfOrder, duplicates, gaps, gapTotalMs, checksum: hash.copy().digest("hex"), reconciles: outOfOrder === 0 };
    },
  };
}

export interface DataManifestEntry { symbol: string; kind: string; tier: DataTier; startMs: number; endMs: number; count: number; checksum: string; bytes: number | null; }
export interface DataManifest { provider: string; marketDataVersion: string; createdAtMs: number; entries: DataManifestEntry[]; manifestHash: string; }

/** Build an immutable manifest from verified stream summaries — the marketDataManifestHash the provenance pins. */
export function buildManifest(provider: string, marketDataVersion: string, createdAtMs: number, entries: DataManifestEntry[]): DataManifest {
  const hash = createHash("sha256");
  for (const e of entries) hash.update(`${e.symbol}|${e.kind}|${e.tier}|${e.startMs}|${e.endMs}|${e.count}|${e.checksum}\n`);
  return { provider, marketDataVersion, createdAtMs, entries, manifestHash: hash.digest("hex") };
}

/**
 * Provider-neutral historical market source (Market Digital Twin, Phase-1 foundation). Priority #1 of the
 * historical-first hierarchy: UNCHANGED historical replay. Reuses the repo's `parseKlines` (replay-tier-a-core,
 * SAFE_REUSE) to ingest the Tier-A Binance-vision 1h kline corpus, then emits synchronized BTCUSDT/ETHUSDT
 * `CommonMarketFrame`s in strict chronological order with EXPLICIT gap reporting and NO silent forward-fill and NO
 * future-data access. File I/O is INJECTED (a `readFile` fn) so the source is pure + testable with fixtures and the
 * safety import-scan stays clean.
 *
 * KNOWN LIMITS (declared, not hidden): NO_ORDER_BOOK_QUEUE_MODEL · NO_LEVEL_2_DEPTH · NO_QUEUE_POSITION. Spread,
 * liquidity, open interest, liquidation flow, and order flow are UNSUPPORTED in this corpus (candle-only) — every
 * frame marks them UNSUPPORTED rather than fabricating them.
 */
import { stableHash } from "../lib/replay-provenance.js";
import { parseKlines, type Candle as ReplayCandle } from "../lib/replay-tier-a-core.js";
import type { Candle, CommonMarketFrame, TimeRange } from "./simulation-types.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "./common-market-frame.js";

export interface HistoricalSourceMetadata {
  provider: string;
  symbols: string[];
  timeframe: string;
  timeframeMs: number;
  dateRangeMs: TimeRange | null;
  fileCount: number;
  rowCount: number;
  gaps: number;
  unsupportedDimensions: string[];
  limits: string[]; // e.g. NO_LEVEL_2_DEPTH
}

export interface HistoricalMarketSource {
  describe(): HistoricalSourceMetadata;
  iterateFrames(range: TimeRange): AsyncIterable<CommonMarketFrame>;
  checksum(): Promise<string>;
}

const HOUR_MS = 60 * 60 * 1000;
export const HISTORICAL_LIMITS = ["NO_ORDER_BOOK_QUEUE_MODEL", "NO_LEVEL_2_DEPTH", "NO_QUEUE_POSITION"] as const;
export const HISTORICAL_UNSUPPORTED_DIMENSIONS = ["spreadBps", "liquidity", "openInterest", "liquidationFlow", "orderFlow"] as const;

function toSimCandle(c: ReplayCandle): Candle {
  return { openTimeMs: c.openTime, closeTimeMs: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

export interface CsvKlinesSourceConfig {
  runId: string;
  symbols: string[]; // e.g. ["BTCUSDT","ETHUSDT"]
  months: string[]; // e.g. ["01".."06"]
  year: string; // e.g. "2026"
  dir: string; // corpus root: `${dir}/${symbol}-1h-${year}-${mm}/${symbol}-1h-${year}-${mm}.csv`
  /** Injected reader — returns file text, or null if the file is absent (a GAP, never fabricated). */
  readFile: (path: string) => string | null;
}

/**
 * The concrete 1h CSV corpus source. Loads eagerly (bounded corpus ~4.3k rows/symbol/6mo), de-dupes + sorts by
 * openTime per symbol, and emits a frame ONLY at timestamps where EVERY symbol has a candle for that exact hour
 * (synchronized). Hours where a symbol is missing are surfaced as gaps and no frame is emitted for that hour (no
 * partial fabrication). Deterministic ordering.
 */
export class CsvKlinesHistoricalSource implements HistoricalMarketSource {
  private readonly bySymbol = new Map<string, Map<number, Candle>>();
  private readonly rawTexts: string[] = [];
  private loadedGaps = 0;
  private rowCount = 0;

  constructor(private readonly cfg: CsvKlinesSourceConfig) {
    for (const symbol of cfg.symbols) {
      const perHour = new Map<number, Candle>();
      const seen = new Set<number>();
      const sorted: Candle[] = [];
      for (const mm of cfg.months) {
        const path = `${cfg.dir}/${symbol}-1h-${cfg.year}-${mm}/${symbol}-1h-${cfg.year}-${mm}.csv`;
        const text = cfg.readFile(path);
        if (text == null) { this.loadedGaps += 1; continue; } // whole-month absence is a coarse gap
        this.rawTexts.push(`${symbol}:${mm}\n${text}`);
        for (const rc of parseKlines(text)) {
          if (seen.has(rc.openTime)) continue; // de-dupe
          seen.add(rc.openTime);
          sorted.push(toSimCandle(rc));
        }
      }
      sorted.sort((a, b) => a.openTimeMs - b.openTimeMs);
      for (const c of sorted) perHour.set(c.openTimeMs, c);
      this.rowCount += sorted.length;
      this.bySymbol.set(symbol, perHour);
    }
  }

  describe(): HistoricalSourceMetadata {
    const allHours = [...new Set(this.cfg.symbols.flatMap((s) => [...(this.bySymbol.get(s)?.keys() ?? [])]))].sort((a, b) => a - b);
    const dateRangeMs = allHours.length ? { startMs: allHours[0]!, endMs: allHours.at(-1)! + HOUR_MS } : null;
    // Per-hour gaps = union hours where not every symbol has a candle.
    let intraGaps = 0;
    for (const h of allHours) if (!this.cfg.symbols.every((s) => this.bySymbol.get(s)?.has(h))) intraGaps += 1;
    return {
      provider: "data.binance.vision (Tier-A 1h klines, offline corpus)",
      symbols: this.cfg.symbols.slice(),
      timeframe: "1h",
      timeframeMs: HOUR_MS,
      dateRangeMs,
      fileCount: this.rawTexts.length,
      rowCount: this.rowCount,
      gaps: this.loadedGaps + intraGaps,
      unsupportedDimensions: [...HISTORICAL_UNSUPPORTED_DIMENSIONS],
      limits: [...HISTORICAL_LIMITS],
    };
  }

  /** Chronological synchronized frames within [startMs, endMs). Only hours where ALL symbols have a candle. */
  async *iterateFrames(range: TimeRange): AsyncIterable<CommonMarketFrame> {
    const hours = [...new Set(this.cfg.symbols.flatMap((s) => [...(this.bySymbol.get(s)?.keys() ?? [])]))]
      .filter((h) => h >= range.startMs && h < range.endMs)
      .sort((a, b) => a - b);
    for (const h of hours) {
      if (!this.cfg.symbols.every((s) => this.bySymbol.get(s)?.has(h))) continue; // gap — skip, never fabricate
      const symbols: Record<string, SymbolFrameInput> = {};
      for (const s of this.cfg.symbols) {
        const c = this.bySymbol.get(s)!.get(h)!;
        symbols[s] = { candle: c, source: `historical:${s}:1h` };
      }
      // asOf = candle close (the frame is knowable only once the bar closes) — strict no-lookahead.
      const asOfMs = this.cfg.symbols.reduce((m, s) => Math.max(m, this.bySymbol.get(s)!.get(h)!.closeTimeMs), 0);
      yield buildCommonMarketFrame({ runId: this.cfg.runId, asOfMs, symbols, provenance: "OBSERVED_HISTORICAL" });
    }
  }

  async checksum(): Promise<string> {
    // Deterministic content checksum of the exact raw corpus consumed (order-normalized).
    return stableHash(this.rawTexts.slice().sort());
  }
}

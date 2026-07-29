/**
 * TLOB dataset collector.
 *
 * This is intentionally data-only: it records a compact, causally timestamped
 * Binance USD-M top-of-book snapshot and never produces a trading decision.
 * A TLOB checkpoint is not valid until it has been trained on this venue's own
 * L2 data and labels, so the collector is the safe first production step.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { BinanceClient } from "./binance.js";

export interface TlobCollectionReport {
  captured: number;
  skipped: number;
  failed: number;
}

export class TlobCollector {
  private readonly lastCapturedAtBySymbol = new Map<string, number>();

  constructor(
    private readonly dataDir = process.env.TLOB_DATA_DIR ?? "data/tlob",
    private readonly minIntervalMs = Math.max(15_000, Number(process.env.TLOB_COLLECT_INTERVAL_MS) || 60_000),
    private readonly depthLevels = Math.max(10, Math.min(100, Number(process.env.TLOB_DEPTH_LEVELS) || 20)),
  ) {}

  async collect(client: Pick<BinanceClient, "getFuturesDepth" | "getFuturesBookTicker">, symbols: readonly string[]): Promise<TlobCollectionReport> {
    const now = Date.now();
    let captured = 0;
    let skipped = 0;
    let failed = 0;
    await Promise.all(symbols.map(async (symbol) => {
      const last = this.lastCapturedAtBySymbol.get(symbol) ?? 0;
      if (now - last < this.minIntervalMs) {
        skipped += 1;
        return;
      }
      try {
        const [depth, book] = await Promise.all([
          client.getFuturesDepth(symbol, this.depthLevels),
          client.getFuturesBookTicker(symbol),
        ]);
        const capturedAtMs = Date.now();
        const day = new Date(capturedAtMs).toISOString().slice(0, 10);
        const destination = resolve(this.dataDir, symbol, `${day}.jsonl`);
        await mkdir(resolve(this.dataDir, symbol), { recursive: true });
        await appendFile(destination, `${JSON.stringify({
          schemaVersion: 1,
          venue: "binance-usdm",
          symbol,
          capturedAtMs,
          bids: depth.bids.slice(0, this.depthLevels),
          asks: depth.asks.slice(0, this.depthLevels),
          bestBid: book.bid,
          bestAsk: book.ask,
        })}\n`, "utf8");
        this.lastCapturedAtBySymbol.set(symbol, capturedAtMs);
        captured += 1;
      } catch {
        failed += 1;
      }
    }));
    return { captured, skipped, failed };
  }

  outputPathFor(symbol: string, day = new Date().toISOString().slice(0, 10)): string {
    return join(this.dataDir, symbol, `${day}.jsonl`);
  }
}

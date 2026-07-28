import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "@dtc/shared";
import { BinanceClient } from "../src/lib/binance.js";
import { UNIVERSE as CURRENT_SCANNER_UNIVERSE } from "../src/lib/scan-service.js";
import { breadthFromCandles } from "../src/trading/features/breadthFromCandles.js";
import { buildHistoricalValidationReport, type ValidationTimeframe } from "../src/trading/validation/historicalValidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const TF_MS: Record<ValidationTimeframe, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function intArg(name: string, fallback: number): number {
  const parsed = Number.parseInt(arg(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDateArg(name: string): number | undefined {
  const value = arg(name);
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid --${name} date: ${value}`);
  return ms;
}

function defaultOut(symbol: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(repoRoot, `apps/api/data/regime-engine-validation/${symbol}-${stamp}.json`);
}

function dedupe(candles: Candle[]): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const candle of candles) byOpen.set(candle.openTime, candle);
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

async function fetchHistoricalCandles(
  client: BinanceClient,
  symbol: string,
  interval: ValidationTimeframe,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  const step = TF_MS[interval];
  while (cursor < endMs) {
    const batch = await client.getCandles(symbol, interval, 1000, { startTime: cursor, endTime: endMs });
    if (batch.length === 0) break;
    out.push(...batch);
    const last = batch.at(-1)!;
    const next = last.openTime + step;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < 1000) break;
  }
  return dedupe(out).filter((candle) => candle.openTime >= startMs && candle.openTime < endMs);
}

async function main(): Promise<void> {
  const symbol = (arg("symbol") ?? "BTCUSDT").toUpperCase();
  const days = intArg("days", 90);
  const endMs = parseDateArg("end") ?? Date.now();
  const startMs = parseDateArg("start") ?? endMs - days * 24 * 60 * 60_000;
  const outPath = resolve(repoRoot, arg("out") ?? defaultOut(symbol));
  const startingEquity = intArg("starting-equity", 10_000);

  console.log(`validation-only=true symbol=${symbol} start=${new Date(startMs).toISOString()} end=${new Date(endMs).toISOString()}`);
  console.log("fetching public spot candles only; no live engine, no private keys, no orders");

  const client = new BinanceClient();
  const [m15, h1, h4, d1] = await Promise.all([
    fetchHistoricalCandles(client, symbol, "15m", startMs, endMs),
    fetchHistoricalCandles(client, symbol, "1h", startMs, endMs),
    fetchHistoricalCandles(client, symbol, "4h", startMs, endMs),
    fetchHistoricalCandles(client, symbol, "1d", startMs, endMs),
  ]);
  // 2026-07-12 fix: buildHistoricalValidationReport never received ETH candles, so ethConfirms was
  // permanently undefined — TREND_RECOVERY/NEUTRAL_RECOVERY (and their 3 gated long lanes) were
  // structurally unreachable in every report this script ever produced, regardless of real price
  // action. Skip the redundant self-fetch when validating ETHUSDT itself (h1 already IS the ETH series).
  const ethH1 = symbol === "ETHUSDT" ? h1 : await fetchHistoricalCandles(client, "ETHUSDT", "1h", startMs, endMs);

  const breadthSymbols = [...new Set(CURRENT_SCANNER_UNIVERSE)].filter((item) => item !== symbol);
  console.log(`fetching breadth h1 candles universeKind=CURRENT_LIQUID_UNIVERSE symbols=${breadthSymbols.length}`);
  const breadthCandles = await Promise.all(
    breadthSymbols.map(async (breadthSymbol) => {
      try {
        return {
          symbol: breadthSymbol,
          h1: await fetchHistoricalCandles(client, breadthSymbol, "1h", startMs, endMs),
        };
      } catch (error: unknown) {
        console.warn(`breadth_symbol_unavailable=${breadthSymbol} reason=${error instanceof Error ? error.message : String(error)}`);
        return { symbol: breadthSymbol, h1: [] };
      }
    }),
  );
  const breadthByTimestamp = new Map<number, NonNullable<Parameters<typeof buildHistoricalValidationReport>[0]["breadth"]>>();
  let breadthUnavailableCount = 0;
  let breadthMetricsSample: Record<string, unknown> | undefined;
  for (const bar of h1) {
    const asOf = bar.openTime + TF_MS["1h"];
    const result = breadthFromCandles({
      asOf,
      btc: h1,
      universe: breadthCandles,
      universeKind: "CURRENT_LIQUID_UNIVERSE",
      universeDescription:
        "Current VPS scan universe from apps/api/src/lib/scan-service.ts; not a point-in-time historical universe snapshot.",
    });
    if (result.breadth) {
      breadthByTimestamp.set(asOf, result.breadth);
      if (result.metrics) breadthMetricsSample = result.metrics as unknown as Record<string, unknown>;
    } else {
      breadthUnavailableCount += 1;
    }
  }

  const report = buildHistoricalValidationReport({
    symbol,
    candles: { m15, h1, h4, d1 },
    ethCandles: { h1: ethH1 },
    startingEquity,
    breadthByTimestamp,
    breadthUnavailableCount,
    breadthMetricsSample,
    breadthUniverseSymbols: breadthSymbols,
    microstructure: {
      spreadBps: Number(arg("spread-bps") ?? 2),
      slippageBps: Number(arg("slippage-bps") ?? 2),
      assumeFundingBaseline: true,
    },
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report=${outPath}`);
  console.log(`decisions=${report.decisionDistribution.totalDecisions} trades=${report.decisionDistribution.totalTrades}`);
  console.log(`pessimistic_pf=${report.tradingPerformance.pessimistic.profitFactor}`);
  console.log(`reject_baseline=${report.strategyRejection.baseline.rejected} reasons=${report.strategyRejection.exactRejectionReasons.join("|") || "none"}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

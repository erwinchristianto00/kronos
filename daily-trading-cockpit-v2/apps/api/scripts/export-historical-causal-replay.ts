/**
 * Export the sealed, non-holdout Tier-A candle corpus to row-level Experience records.
 * Usage: npx tsx scripts/export-historical-causal-replay.ts <klinesDir> <outputFile>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { exportHistoricalCausalReplay } from "../src/experience-engine/historical-causal-replay-export.js";
import { parseKlines, reconstructSymbol, type TADirRow } from "../src/lib/replay-tier-a-core.js";
import { stableHash } from "../src/lib/replay-provenance.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
const MONTHS = ["01", "02", "03", "04", "05", "06"] as const;

function csvFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? csvFiles(join(root, entry.name)) : entry.name.endsWith(".csv") ? [join(root, entry.name)] : [],
  );
}

function main(): void {
  const klinesDir = process.argv[2];
  const outputFile = process.argv[3];
  if (!klinesDir || !outputFile) throw new Error("usage: export-historical-causal-replay.ts <klinesDir> <outputFile>");
  if (/holdout/i.test(klinesDir)) throw new Error("refusing to open a sealed holdout corpus");
  if (!existsSync(klinesDir)) throw new Error(`missing kline directory: ${klinesDir}`);

  const files = csvFiles(klinesDir).sort();
  const manifest = files.map((file) => ({
    file: file.slice(klinesDir.length + 1),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
  const manifestHash = stableHash(manifest);
  const rows: TADirRow[] = [];
  for (const symbol of SYMBOLS) {
    const candles = MONTHS.flatMap((month) => {
      const name = `${symbol}-1h-2026-${month}.csv`;
      // Accept both the frozen proof layout and Binance Vision's nested extraction layout.
      const candidates = [
        join(klinesDir, `${symbol}-1h-2026-${month}`, name),
        join(klinesDir, symbol, "1h", `${symbol}-1h-2026-${month}`, name),
      ];
      const file = candidates.find(existsSync);
      return file ? parseKlines(readFileSync(file, "utf8")) : [];
    }).sort((a, b) => a.openTime - b.openTime);
    rows.push(...reconstructSymbol(symbol, candles).dirRows);
  }

  const experiences = exportHistoricalCausalReplay(rows, { manifestHash });
  const actionCounts = experiences.reduce<Record<string, number>>((counts, row) => {
    counts[row.direction ?? "UNKNOWN"] = (counts[row.direction ?? "UNKNOWN"] ?? 0) + 1;
    return counts;
  }, {});
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify({
    schema: "historical-causal-replay-export/1",
    corpus: { symbols: SYMBOLS, months: MONTHS, manifestHash, files: manifest },
    records: experiences,
  }, null, 2));
  console.log(JSON.stringify({ outputFile, manifestHash, replayRows: experiences.length, actionCounts, eligible: experiences.filter((row) => row.eligibility === "CANDIDATE_LEARNING_ELIGIBLE").length }, null, 2));
}

main();

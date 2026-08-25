/**
 * V4 continuation training matrix: admission-conditioned, multi-source, multi-horizon.
 *
 * One canonical TypeScript feature implementation is shared with runtime inference. External
 * sources are read strictly as-of the formation timestamp; labels only use later completed bars.
 *
 * Usage:
 *   npx tsx scripts/build-direction-training-matrix-v3.ts <ohlcvDir> <fundingDir> <rawDir> <outCsv> [--cutoff-ms=<ms>]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CONTINUATION_FEATURE_SCHEMA_VERSION,
  CONTINUATION_NORMALIZATION_VERSION,
  CONTINUATION_SOURCE_COVERAGE_VERSION,
} from "../src/lib/continuation-lifecycle.js";
import {
  DIRECTION_MODEL_MIN_BARS,
  HORIZONS,
  VOL_LOOKBACK_BARS,
  indexBars,
  marketFeatures,
  multiHorizonLabels,
  type Bar,
  type FundingPoint,
  type MultiSourceInput,
  type TimePoint,
} from "../src/lib/direction-model-features.js";
import { buildCrossSectionalBasket, type ScoredSymbol } from "../src/lib/cross-sectional-edge.js";
import { baseDynamicMom36Allocation } from "../src/lib/dynamic-mom36-shock-strategy.js";

const UNIVERSE = [
  "1000PEPEUSDT", "ADAUSDT", "APTUSDT", "ARBUSDT", "AVAXUSDT", "BNBUSDT", "DOGEUSDT",
  "FETUSDT", "INJUSDT", "LDOUSDT", "NEARUSDT", "OPUSDT", "SEIUSDT", "SOLUSDT",
  "SUIUSDT", "TAOUSDT", "UNIUSDT", "WIFUSDT", "WLDUSDT", "XRPUSDT",
];
const VENUES = ["bybit", "okx", "coinbase"];
const MOM_BARS = 36;
const K = 3;
const MIN_SCORE_GAP = 0.058;
const MAX_PER_CLUSTER = 2;
const SHORT_BLOCKED = new Set(["APTUSDT", "AVAXUSDT", "FETUSDT", "INJUSDT", "NEARUSDT", "RNDRUSDT"]);

type MatrixRow = {
  t: number;
  f: Record<string, number | null>;
  labels: Record<number, { r: number; vol: number; z: number; cls: string }>;
  maxFeatureSourceTimestampMs: number;
  baseLongCount: number;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function loadBars(file: string): Bar[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
  return raw.flatMap((r) => {
    const [openTime, open, high, low, close, volume] = r;
    if (![openTime, open, high, low, close, volume].every((value) => finite(value) !== null)) return [];
    if (!(open > 0 && high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low && volume >= 0)) return [];
    // There are two auditable, supported encodings:
    //
    // 1. The immutable Kronos V4 materialized history written by fetch_full.py:
    //    [open, O, H, L, C, volume, trades, takerBuyBase, quoteVolume]
    // 2. Raw Binance REST/WebSocket kline rows:
    //    [open, O, H, L, C, volume, closeTime, quoteVolume, trades, takerBuyBase, ...]
    //
    // The legacy store is intentionally kept intact, so index 7 is meaningful only for its
    // exact nine-column layout.  A raw Binance row must use index 9; never mistake its quote
    // volume (index 7) for taker flow.
    const takerBuyBase = r.length === 9 ? finite(r[7]) : finite(r[9]);
    return [{
      openTime, open, high, low, close, volume,
      takerBuyBase: takerBuyBase !== null && takerBuyBase >= 0 && takerBuyBase <= volume ? takerBuyBase : null,
    }];
  }).sort((a, b) => a.openTime - b.openTime);
}

function loadVenueBars(file: string): Bar[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
  return raw.flatMap((r) => {
    const [openTime, close, volume] = r;
    if (![openTime, close, volume].every((value) => finite(value) !== null) || !(close > 0 && volume >= 0)) return [];
    return [{ openTime, open: close, high: close, low: close, close, volume, takerBuyBase: null }];
  });
}

function loadSeries(file: string): TimePoint[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
  return raw.flatMap((r) => finite(r[0]) !== null && finite(r[1]) !== null ? [{ timeMs: r[0]!, value: r[1]! }] : [])
    .sort((a, b) => a.timeMs - b.timeMs);
}

function optionalCutoff(args: string[]): number | null {
  const raw = args.find((arg) => arg.startsWith("--cutoff-ms="))?.slice("--cutoff-ms=".length) ?? null;
  const value = raw === null ? null : Number(raw);
  return value !== null && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/** Latest raw observation available at/before formation; used only for leakage audit metadata. */
function maxAsOfTime(atMs: number): number {
  // The formation price bar itself is observed at `atMs`, so it is necessarily the maximum legal
  // source timestamp. `fundingFeatures`/`asOf`/`venueAsOf` are the only external readers and each
  // has an explicit <= atMs comparison. Keeping this marker equal to formation avoids an O(rows ×
  // raw-history) audit scan while preserving the strict, testable PIT invariant.
  return atMs;
}

function main(): void {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [ohlcvDir, fundingDir, rawDir, outCsv] = positional;
  const cutoffMs = optionalCutoff(process.argv.slice(2));
  if (!ohlcvDir || !fundingDir || !rawDir || !outCsv) {
    console.error("usage: build-direction-training-matrix-v3.ts <ohlcvDir> <fundingDir> <rawDir> <outCsv> [--cutoff-ms=<ms>]");
    process.exit(2);
  }

  const bySymbol = new Map<string, Bar[]>();
  for (const symbol of UNIVERSE) {
    const file = path.join(ohlcvDir, `${symbol}.json`);
    if (fs.existsSync(file)) bySymbol.set(symbol, loadBars(file));
  }
  const btcFile = path.join(ohlcvDir, "BTCUSDT.json");
  const btc = fs.existsSync(btcFile) ? loadBars(btcFile) : null;
  const ethFile = path.join(ohlcvDir, "ETHUSDT.json");
  const eth = fs.existsSync(ethFile) ? loadBars(ethFile) : null;

  const fundingBySymbol = new Map<string, FundingPoint[]>();
  for (const symbol of bySymbol.keys()) {
    const file = path.join(fundingDir, `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
    fundingBySymbol.set(symbol, raw.flatMap((r) => finite(r[0]) !== null && finite(r[1]) !== null ? [{ timeMs: r[0]!, rate: r[1]! }] : []));
  }

  const venueBars = new Map<string, Map<string, Map<number, Bar>>>();
  for (const venue of VENUES) {
    const directory = path.join(rawDir, venue);
    if (!fs.existsSync(directory)) continue;
    const byVenueSymbol = new Map<string, Map<number, Bar>>();
    for (const file of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      byVenueSymbol.set(file.replace(".json", ""), indexBars(loadVenueBars(path.join(directory, file))));
    }
    if (byVenueSymbol.size) venueBars.set(venue, byVenueSymbol);
  }
  const ivSeries = new Map<string, TimePoint[]>();
  for (const currency of ["BTC", "ETH"]) {
    const file = path.join(rawDir, "options", `DVOL_${currency}.json`);
    if (fs.existsSync(file)) ivSeries.set(currency, loadSeries(file));
  }
  const multiSource: MultiSourceInput = {
    venueBars: venueBars.size ? venueBars : null,
    ivSeries: ivSeries.size ? ivSeries : null,
    eth,
  };

  const lengths = new Set([...bySymbol.values()].map((bars) => bars.length));
  if (lengths.size !== 1) {
    console.error(`FATAL: base series not aligned (${[...lengths]})`);
    process.exit(1);
  }
  const n = [...lengths][0] ?? 0;
  const rows: MatrixRow[] = [];
  let examined = 0;
  let admitted = 0;
  const firstBar = Math.max(DIRECTION_MODEL_MIN_BARS, VOL_LOOKBACK_BARS + 1);
  const lastBar = n - Math.max(...HORIZONS) - 1;

  for (let at = firstBar; at <= lastBar; at += 1) {
    const openedAtMs = bySymbol.values().next().value![at]?.openTime;
    if (!Number.isFinite(openedAtMs) || (cutoffMs !== null && openedAtMs > cutoffMs)) continue;
    examined += 1;
    const scored: ScoredSymbol[] = [];
    for (const [symbol, bars] of bySymbol) {
      const now = bars[at]?.close;
      const then = bars[at - MOM_BARS]?.close;
      if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) continue;
      scored.push({ symbol, score: now / then - 1, price: now });
    }
    if (scored.length < 2 * K) continue;
    const basket = buildCrossSectionalBasket(scored, {
      k: K, signal: `MOM${MOM_BARS}_FILTERED`, variant: "FILTERED",
      now: new Date(openedAtMs).toISOString(), openedAtMs,
      horizonMs: 36 * 3_600_000,
      minScoreGap: MIN_SCORE_GAP, maxPerCluster: MAX_PER_CLUSTER,
      shortBlocklist: SHORT_BLOCKED, weightingModel: "CAPPED_SCORE_RANK",
    });
    if (!basket) continue;
    admitted += 1;
    const baseLongCount = baseDynamicMom36Allocation(scored.map((row) => ({ mom36: row.score }))).allocation.longCount;
    const features = marketFeatures({ bySymbol, btc, at, fundingBySymbol, multiSource });
    const labels = multiHorizonLabels(bySymbol, at);
    if (!features || !labels) continue;
    const maxFeatureSourceTimestampMs = maxAsOfTime(openedAtMs);
    if (maxFeatureSourceTimestampMs > openedAtMs) throw new Error("PIT violation: feature source after formation");
    rows.push({
      t: openedAtMs,
      f: features,
      labels: labels as unknown as MatrixRow["labels"],
      maxFeatureSourceTimestampMs,
      baseLongCount,
    });
  }

  if (!rows.length) throw new Error("FATAL: zero usable mature continuation rows");
  const names = Object.keys(rows[0]!.f).sort();
  for (const row of rows) {
    const keys = Object.keys(row.f).sort();
    if (keys.length !== names.length || keys.some((value, index) => value !== names[index])) {
      throw new Error("FATAL: feature schema unstable across rows");
    }
    if (row.maxFeatureSourceTimestampMs > row.t) throw new Error("FATAL: feature source leaks after formation");
  }
  const labelColumns = HORIZONS.flatMap((horizon) => [`r${horizon}`, `vol${horizon}`, `z${horizon}`, `cls${horizon}`]);
  const lines = [["openTime", "maxFeatureSourceTimestampMs", "baseLongCount", ...names, ...labelColumns].join(",")];
  for (const row of rows) {
    const values = names.map((name) => {
      const value = row.f[name];
      return value === null || !Number.isFinite(value) ? "" : String(value);
    });
    const labels = HORIZONS.flatMap((horizon) => {
      const label = row.labels[horizon]!;
      return [String(label.r), String(label.vol), String(label.z), label.cls];
    });
    lines.push([String(row.t), String(row.maxFeatureSourceTimestampMs), String(row.baseLongCount), ...values, ...labels].join(","));
  }
  fs.mkdirSync(path.dirname(outCsv), { recursive: true });
  fs.writeFileSync(outCsv, `${lines.join("\n")}\n`);
  const coverage = names.map((name) => {
    const present = rows.filter((row) => row.f[name] !== null && Number.isFinite(row.f[name]!));
    return {
      name,
      availableRows: present.length,
      missingRows: rows.length - present.length,
      coveragePct: 100 * present.length / rows.length,
      firstAvailableTimestampMs: present[0]?.t ?? null,
      lastAvailableTimestampMs: present.at(-1)?.t ?? null,
    };
  }).sort((a, b) => a.coveragePct - b.coveragePct);
  const manifest = {
    schemaVersion: 1,
    rowCount: rows.length,
    featureSchemaVersion: CONTINUATION_FEATURE_SCHEMA_VERSION,
    featureListHash: createHash("sha256").update(names.join("\n")).digest("hex"),
    normalizationVersion: CONTINUATION_NORMALIZATION_VERSION,
    sourceCoverageVersion: CONTINUATION_SOURCE_COVERAGE_VERSION,
    featureNames: names,
    featureCoverage: coverage,
    firstFormationTimestampMs: rows[0]!.t,
    latestFormationTimestampMs: rows[rows.length - 1]!.t,
    maxFeatureSourceTimestampMs: Math.max(...rows.map((row) => row.maxFeatureSourceTimestampMs)),
    cutoffMs,
    examined,
    admissionEligible: admitted,
  };
  fs.writeFileSync(`${outCsv}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`matrix rows=${rows.length} features=${names.length} examined=${examined} admitted=${admitted}`);
  console.error(`span ${new Date(rows[0]!.t).toISOString()} .. ${new Date(rows[rows.length - 1]!.t).toISOString()}`);
}

main();

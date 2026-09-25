#!/usr/bin/env npx tsx
/**
 * Daily Range market-alpha research runner.
 *
 * Data class: RECONSTRUCTED_CANDLE_PIT. It downloads only Binance USD-M
 * MAINNET public candles. It never reads Testnet prices, live orders, private
 * BBO, current ownership, or historical C1-C6 snapshots. Consequently its
 * output is research-only and may only create REJECTED/WEAK_SHADOW artifacts
 * outside runtime data; it cannot arm an alpha selector.
 *
 * Usage:
 *   npx tsx apps/api/scripts/run-daily-range-reconstructed-candle-pit.ts \
 *     --days 180 --out artifacts/daily-range-research/rcpit-YYYYMMDD
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

import { newYorkDailyRangeWindow } from "../src/lib/daily-4h-range-acceptance-lane.js";
import {
  DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS,
  replayReconstructedDailyRangeAutoRoute,
  resolveReconstructedDailyRangeOutcome,
  type DailyRangeReconstructedCandidate,
  type DailyRangeReconstructedResolvedCandidate,
} from "../src/lib/daily-range-reconstructed-candle-pit.js";
import {
  DailyRangeSelectorArtifactRegistry,
  hashDailyRangeSelectorModel,
  type DailyRangeSelectorArtifactStatus,
} from "../src/lib/daily-range-selector-artifacts.js";

type Interval = "1m" | "5m" | "1h" | "4h";
type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type CandidateRow = DailyRangeReconstructedResolvedCandidate & {
  batchKey: string;
  riskBps: number;
  economicProxy: {
    safeLossFrictionBps: number;
    costRatio: number;
    plannedRiskUsd: number;
    plannedNotionalUsd: number;
    score: number;
    quality: "CURRENT_FRICTION_PROXY_NOT_HISTORICAL_EXECUTION";
  };
  labelQuality: "COMPLETE_1M_WINDOW" | "CAPPED_25H_UNRESOLVED" | "GAPPED_1M" | "NO_1M_DATA";
};

type LogisticModel = {
  featureKeys: string[];
  means: number[];
  stds: number[];
  intercept: number;
  weights: number[];
  trainCount: number;
};

const MINUTE = 60_000;
const FIVE_MIN = 5 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_SYMBOLS = [
  "1000SHIBUSDT", "ACEUSDT", "BCHUSDT", "DASHUSDT", "DOTUSDT", "ETCUSDT",
  "FILUSDT", "HBARUSDT", "LTCUSDT", "ONDOUSDT", "TRXUSDT", "XLMUSDT",
] as const;
const DEFAULT_SAFE_LOSS_BPS = 33.48327299;
const DEFAULT_SLOT_COUNT = 2;
const MAX_MINUTE_OUTCOME_WINDOW_MS = 25 * 60 * MINUTE;
const REQUEST_SPACING_MS = 280;
const FAPI = "https://fapi.binance.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index++;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function positiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function numberArg(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function utcDate(ms: number): string {
  return iso(ms).slice(0, 10);
}

function currentGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "UNKNOWN";
  }
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

class MainnetCandleClient {
  private nextRequestAt = 0;
  private readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    mkdirSync(cacheDir, { recursive: true });
  }

  async serverTime(): Promise<number> {
    const response = await fetch(`${FAPI}/fapi/v1/time`);
    if (!response.ok) throw new Error(`Binance server time HTTP ${response.status}`);
    const body = await response.json() as { serverTime?: unknown };
    const time = Number(body.serverTime);
    if (!finite(time) || time <= 0) throw new Error("Binance server time response is invalid");
    return time;
  }

  private cacheFile(symbol: string, interval: Interval, startTime: number, endTime: number): string {
    return join(this.cacheDir, `${symbol}-${interval}-${startTime}-${endTime}.json`);
  }

  private async request(url: URL): Promise<unknown> {
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait > 0) await sleep(wait);
    this.nextRequestAt = Date.now() + REQUEST_SPACING_MS;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) return await response.json();
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : (attempt + 1) * 1_500;
        lastError = new Error(`Binance ${url.pathname} HTTP ${response.status}`);
        if (response.status !== 418 && response.status !== 429 && response.status < 500) throw lastError;
        await sleep(delay);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 4) break;
        await sleep((attempt + 1) * 1_000);
      }
    }
    throw lastError ?? new Error("Binance request failed");
  }

  async klines(symbol: string, interval: Interval, startTime: number, endTime: number, limit = 1_500): Promise<Candle[]> {
    const file = this.cacheFile(symbol, interval, startTime, endTime);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Candle[];
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // A partial cache is never trusted. Fetch and atomically rewrite it below.
      }
    }
    const url = new URL(`${FAPI}/fapi/v1/klines`);
    url.search = new URLSearchParams({
      symbol,
      interval,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: String(limit),
    }).toString();
    const payload = await this.request(url);
    if (!Array.isArray(payload)) throw new Error(`invalid kline payload ${symbol}/${interval}`);
    const rows: Candle[] = [];
    for (const raw of payload) {
      if (!Array.isArray(raw) || raw.length < 7) continue;
      const values = [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3]), Number(raw[4]), Number(raw[5]), Number(raw[6])];
      if (!values.every(Number.isFinite)) continue;
      const [openTime, open, high, low, close, volume, closeTime] = values;
      if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) continue;
      rows.push({ openTime, open, high, low, close, volume, closeTime });
    }
    rows.sort((a, b) => a.openTime - b.openTime);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows), "utf8");
    renameSync(tmp, file);
    return rows;
  }

  async panel(symbol: string, interval: Interval, startTime: number, endTime: number): Promise<Candle[]> {
    const intervalMs = interval === "1m" ? MINUTE : interval === "5m" ? FIVE_MIN : interval === "1h" ? 60 * MINUTE : 4 * 60 * MINUTE;
    const output: Candle[] = [];
    let cursor = startTime;
    while (cursor <= endTime) {
      const chunkEnd = Math.min(endTime, cursor + (1_500 - 1) * intervalMs + intervalMs - 1);
      const rows = await this.klines(symbol, interval, cursor, chunkEnd);
      output.push(...rows.filter((row) => row.openTime >= cursor && row.openTime <= chunkEnd));
      cursor = chunkEnd + 1;
    }
    const unique = new Map<number, Candle>();
    for (const row of output) unique.set(row.openTime, row);
    return [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  }
}

function contiguous(rows: readonly Candle[], intervalMs: number): boolean {
  return rows.length > 0 && rows.every((row, index) => index === 0 || row.openTime === (rows[index - 1]?.openTime ?? row.openTime) + intervalMs);
}

function sliceToDecision(rows: readonly Candle[], decisionMs: number, lookback = 100): Candle[] {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((rows[mid]?.closeTime ?? Number.POSITIVE_INFINITY) < decisionMs) low = mid + 1;
    else high = mid;
  }
  return rows.slice(Math.max(0, low - lookback), low);
}

function returnOneHour(rows: readonly Candle[], decisionMs: number): number | null {
  const panel = sliceToDecision(rows, decisionMs, 13);
  if (panel.length < 13 || !contiguous(panel.slice(-13), FIVE_MIN)) return null;
  const start = panel.at(-13);
  const end = panel.at(-1);
  return start && end && start.close > 0 ? end.close / start.close - 1 : null;
}

function sessionDates(startMs: number, endMs: number): Array<{ dateUtc: string; rangeOpenTime: number; rangeCloseTime: number; entryWindowCloseTime: number }> {
  const cursor = new Date(startMs);
  const startNoon = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 12);
  const dates: Array<{ dateUtc: string; rangeOpenTime: number; rangeCloseTime: number; entryWindowCloseTime: number }> = [];
  for (let noon = startNoon - DAY; noon <= endMs + DAY; noon += DAY) {
    const window = newYorkDailyRangeWindow(noon);
    if (window.rangeOpenTime < startMs || window.entryWindowCloseTime > endMs) continue;
    dates.push({ dateUtc: window.date, rangeOpenTime: window.rangeOpenTime, rangeCloseTime: window.rangeCloseTime, entryWindowCloseTime: window.entryWindowCloseTime });
  }
  return [...new Map(dates.map((row) => [row.dateUtc, row])).values()].sort((a, b) => a.rangeOpenTime - b.rangeOpenTime);
}

/**
 * Resolve from the one-minute panel already fetched for this symbol. This
 * keeps the same no-interpolation label contract as the first runner design,
 * but avoids repeatedly downloading the same 25-hour path for overlapping
 * candidates. The panel is fetched one symbol at a time and discarded.
 */
function resolveOutcomeFromMinutePanel(
  candidate: DailyRangeReconstructedCandidate,
  minutePanel: readonly Candle[],
  serverCompletedAt: number,
): { result: DailyRangeReconstructedResolvedCandidate; labelQuality: CandidateRow["labelQuality"] } {
  const start = candidate.decisionTimestampMs;
  const end = Math.min(serverCompletedAt, start + MAX_MINUTE_OUTCOME_WINDOW_MS - 1);
  if (end < start) return { result: resolveReconstructedDailyRangeOutcome(candidate, []), labelQuality: "NO_1M_DATA" };
  let low = 0;
  let high = minutePanel.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((minutePanel[middle]?.openTime ?? Number.POSITIVE_INFINITY) < start) low = middle + 1;
    else high = middle;
  }
  const ordered = minutePanel.slice(low).filter((row) => row.openTime <= end && row.closeTime <= serverCompletedAt);
  const usable: Candle[] = [];
  let expected = start;
  for (const row of ordered) {
    if (row.openTime !== expected) break;
    usable.push(row);
    expected += MINUTE;
  }
  if (usable.length === 0) return { result: resolveReconstructedDailyRangeOutcome(candidate, []), labelQuality: "NO_1M_DATA" };
  const result = resolveReconstructedDailyRangeOutcome(candidate, usable);
  if (result.outcome === "TP" || result.outcome === "SL" || result.outcome === "OUTCOME_AMBIGUOUS") {
    return { result, labelQuality: "COMPLETE_1M_WINDOW" };
  }
  const completeTarget = end >= start + MAX_MINUTE_OUTCOME_WINDOW_MS - 1;
  return { result, labelQuality: usable.length === Math.floor((end - start + 1) / MINUTE) ? (completeTarget ? "CAPPED_25H_UNRESOLVED" : "CAPPED_25H_UNRESOLVED") : "GAPPED_1M" };
}

function candidateEconomicProxy(candidate: DailyRangeReconstructedCandidate, safeLossFrictionBps: number): CandidateRow["economicProxy"] {
  const entry = candidate.decision.confirmationBar2.close;
  const riskPrice = Math.abs(entry - candidate.structuralStop);
  const riskBps = entry > 0 ? riskPrice / entry * 10_000 : Number.POSITIVE_INFINITY;
  const plannedNotionalUsd = riskPrice > 0 ? Math.min(25, 0.25 / (riskPrice / entry)) : 0;
  const plannedRiskUsd = entry > 0 ? plannedNotionalUsd * riskPrice / entry : 0;
  const costRatio = riskBps > 0 ? safeLossFrictionBps / riskBps : Number.POSITIVE_INFINITY;
  return {
    safeLossFrictionBps,
    costRatio,
    plannedRiskUsd,
    plannedNotionalUsd,
    score: -costRatio,
    quality: "CURRENT_FRICTION_PROXY_NOT_HISTORICAL_EXECUTION",
  };
}

function usableRows(rows: readonly CandidateRow[], featureKeys: readonly string[]): CandidateRow[] {
  return rows.filter((row) => (row.outcome === "TP" || row.outcome === "SL") && featureKeys.every((key) => finite(row.features[key])));
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-Math.min(35, value))) : Math.exp(Math.max(-35, value)) / (1 + Math.exp(Math.max(-35, value)));
}

function trainLogistic(rows: readonly CandidateRow[], featureKeys: string[]): LogisticModel | null {
  const usable = usableRows(rows, featureKeys);
  if (usable.length < 40) return null;
  const means = featureKeys.map((key) => usable.reduce((sum, row) => sum + Number(row.features[key]), 0) / usable.length);
  const stds = featureKeys.map((key, index) => {
    const variance = usable.reduce((sum, row) => sum + (Number(row.features[key]) - means[index]!) ** 2, 0) / usable.length;
    return Math.max(1e-9, Math.sqrt(variance));
  });
  const weights = featureKeys.map(() => 0);
  let intercept = 0;
  const l2 = 0.15;
  const learningRate = 0.08;
  for (let step = 0; step < 900; step++) {
    let gradIntercept = 0;
    const gradients = featureKeys.map(() => 0);
    for (const row of usable) {
      const x = featureKeys.map((key, index) => (Number(row.features[key]) - means[index]!) / stds[index]!);
      const y = row.outcome === "TP" ? 1 : 0;
      const p = sigmoid(intercept + x.reduce((sum, value, index) => sum + value * weights[index]!, 0));
      const residual = p - y;
      gradIntercept += residual;
      for (let index = 0; index < gradients.length; index++) gradients[index] += residual * x[index]!;
    }
    intercept -= learningRate * gradIntercept / usable.length;
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= learningRate * (gradients[index]! / usable.length + l2 * weights[index]!);
    }
  }
  return { featureKeys, means, stds, intercept, weights, trainCount: usable.length };
}

function predict(model: LogisticModel | null, row: CandidateRow): number | null {
  if (!model || !model.featureKeys.every((key) => finite(row.features[key]))) return null;
  const score = model.intercept + model.featureKeys.reduce((sum, key, index) =>
    sum + ((Number(row.features[key]) - model.means[index]!) / model.stds[index]!) * model.weights[index]!, 0);
  return sigmoid(score);
}

function brier(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): number | null {
  const evaluated = rows.filter((row) => scores.has(row.batchKey + "|" + row.symbol));
  if (!evaluated.length) return null;
  return evaluated.reduce((sum, row) => {
    const p = scores.get(row.batchKey + "|" + row.symbol)!;
    return sum + (p - (row.outcome === "TP" ? 1 : 0)) ** 2;
  }, 0) / evaluated.length;
}

function logLoss(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): number | null {
  const evaluated = rows.filter((row) => scores.has(row.batchKey + "|" + row.symbol));
  if (!evaluated.length) return null;
  return evaluated.reduce((sum, row) => {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, scores.get(row.batchKey + "|" + row.symbol)!));
    return sum - ((row.outcome === "TP" ? Math.log(p) : Math.log(1 - p)));
  }, 0) / evaluated.length;
}

function rankCorrelation(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): number | null {
  const values = rows.flatMap((row) => {
    const score = scores.get(row.batchKey + "|" + row.symbol);
    return score === undefined ? [] : [{ score, label: row.outcome === "TP" ? 1 : 0 }];
  });
  if (values.length < 3) return null;
  const rank = (source: number[]) => source.map((value) => 1 + source.filter((other) => other > value).length);
  const a = rank(values.map((value) => value.score));
  const b = rank(values.map((value) => value.label));
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  const numerator = a.reduce((sum, value, index) => sum + (value - meanA) * (b[index]! - meanB), 0);
  const denominator = Math.sqrt(a.reduce((sum, value) => sum + (value - meanA) ** 2, 0) * b.reduce((sum, value) => sum + (value - meanB) ** 2, 0));
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Calibration stays descriptive: we report the observed hit rate in fixed
 * probability bins rather than fitting another model after seeing holdout.
 */
function calibrationBins(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): Array<{
  lowerInclusive: number;
  upperExclusive: number;
  count: number;
  meanPredicted: number | null;
  observedTpRate: number | null;
}> {
  return Array.from({ length: 5 }, (_, index) => {
    const lowerInclusive = index / 5;
    const upperExclusive = index === 4 ? 1 : (index + 1) / 5;
    const values = rows.flatMap((row) => {
      const score = scores.get(row.batchKey + "|" + row.symbol);
      if (score === undefined) return [];
      const belongs = index === 4
        ? score >= lowerInclusive && score <= upperExclusive
        : score >= lowerInclusive && score < upperExclusive;
      return belongs ? [{ score, label: row.outcome === "TP" ? 1 : 0 }] : [];
    });
    return {
      lowerInclusive,
      upperExclusive,
      count: values.length,
      meanPredicted: values.length ? values.reduce((sum, value) => sum + value.score, 0) / values.length : null,
      observedTpRate: values.length ? values.reduce((sum, value) => sum + value.label, 0) / values.length : null,
    };
  });
}

/** Precision@K is computed within each same-timestamp candidate batch. */
function precisionAt(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): Record<"1" | "2" | "3", {
  precision: number | null;
  batches: number;
  selected: number;
}> {
  const byBatch = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (!scores.has(row.batchKey + "|" + row.symbol)) continue;
    const batch = byBatch.get(row.batchKey) ?? [];
    batch.push(row);
    byBatch.set(row.batchKey, batch);
  }
  const result = {} as Record<"1" | "2" | "3", { precision: number | null; batches: number; selected: number }>;
  for (const k of [1, 2, 3] as const) {
    let tp = 0;
    let selected = 0;
    let batches = 0;
    for (const [batchKey, batch] of byBatch) {
      if (batch.length < k) continue;
      const ranked = [...batch].sort((left, right) => {
        const leftScore = scores.get(left.batchKey + "|" + left.symbol)!;
        const rightScore = scores.get(right.batchKey + "|" + right.symbol)!;
        return rightScore - leftScore || stableHash(`${batchKey}|${left.symbol}`).localeCompare(stableHash(`${batchKey}|${right.symbol}`));
      }).slice(0, k);
      tp += ranked.filter((row) => row.outcome === "TP").length;
      selected += ranked.length;
      batches++;
    }
    result[String(k) as "1" | "2" | "3"] = { precision: selected ? tp / selected : null, batches, selected };
  }
  return result;
}

function scoreMetrics(rows: readonly CandidateRow[], scores: ReadonlyMap<string, number>): {
  brier: number | null;
  logloss: number | null;
  rankCorrelation: number | null;
  calibration: ReturnType<typeof calibrationBins>;
  precisionAt: ReturnType<typeof precisionAt>;
} {
  return {
    brier: brier(rows, scores),
    logloss: logLoss(rows, scores),
    rankCorrelation: rankCorrelation(rows, scores),
    calibration: calibrationBins(rows, scores),
    precisionAt: precisionAt(rows, scores),
  };
}

function metricNetR(row: CandidateRow): number {
  const riskBps = row.riskBps;
  if (!(riskBps > 0) || !finite(riskBps)) return Number.NaN;
  return row.outcome === "TP" ? 2 - 10 / riskBps : -1 - row.economicProxy.safeLossFrictionBps / riskBps;
}

function summarizeSelection(rows: readonly CandidateRow[]): Record<string, number | null> {
  const netRs = rows.map(metricNetR).filter(Number.isFinite);
  if (!netRs.length) return { selected: 0, netR: null, netModeledUsd: null, winRate: null, profitFactor: null, maxDrawdownR: null, cvar5R: null };
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of netRs) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const losses = netRs.filter((value) => value < 0);
  const profit = netRs.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const tailCount = Math.max(1, Math.ceil(netRs.length * 0.05));
  const cvar = [...netRs].sort((a, b) => a - b).slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount;
  return {
    selected: netRs.length,
    netR: netRs.reduce((sum, value) => sum + value, 0),
    netModeledUsd: rows.reduce((sum, row) => sum + metricNetR(row) * row.economicProxy.plannedRiskUsd, 0),
    winRate: netRs.filter((value) => value > 0).length / netRs.length,
    profitFactor: loss > 0 ? profit / loss : null,
    maxDrawdownR: maxDrawdown,
    cvar5R: cvar,
  };
}

function selectionReplay(input: {
  rows: readonly CandidateRow[];
  scores: ReadonlyMap<string, number>;
  slots: number;
  mode: "ECONOMIC" | "ALPHA" | "SEEDED_RANDOM" | "ROUTE_BASE_RATE";
}): { selected: CandidateRow[]; oversubscribedBatches: number; selectedOversubscribed: CandidateRow[] } {
  const batches = new Map<string, CandidateRow[]>();
  for (const row of input.rows) {
    if (row.outcome !== "TP" && row.outcome !== "SL") continue;
    const rows = batches.get(row.batchKey) ?? [];
    rows.push(row);
    batches.set(row.batchKey, rows);
  }
  const selected: CandidateRow[] = [];
  const selectedOversubscribed: CandidateRow[] = [];
  let oversubscribedBatches = 0;
  for (const [batchKey, rows] of [...batches].sort(([left], [right]) => left.localeCompare(right))) {
    const eligible = rows.filter((row) => row.economicProxy.costRatio <= 0.25 && row.economicProxy.plannedRiskUsd > 0);
    const oversubscribed = eligible.length > input.slots;
    if (oversubscribed) oversubscribedBatches++;
    const ordered = [...eligible].sort((left, right) => {
      if (input.mode === "ALPHA") {
        const ls = input.scores.get(left.batchKey + "|" + left.symbol) ?? Number.NEGATIVE_INFINITY;
        const rs = input.scores.get(right.batchKey + "|" + right.symbol) ?? Number.NEGATIVE_INFINITY;
        if (rs !== ls) return rs - ls;
      }
      if (input.mode === "SEEDED_RANDOM") {
        const ls = Number.parseInt(stableHash(`daily-range-reconstructed-seed-v1|${batchKey}|${left.symbol}`).slice(0, 8), 16);
        const rs = Number.parseInt(stableHash(`daily-range-reconstructed-seed-v1|${batchKey}|${right.symbol}`).slice(0, 8), 16);
        if (rs !== ls) return rs - ls;
      }
      // A route base-rate is constant within a route. It intentionally has no
      // candidate-level authority, so the economic baseline remains its stable
      // tie-breaker rather than inventing a nonexistent ranking edge.
      if (left.economicProxy.score !== right.economicProxy.score) return right.economicProxy.score - left.economicProxy.score;
      return stableHash(`${batchKey}|${left.symbol}`).localeCompare(stableHash(`${batchKey}|${right.symbol}`));
    }).slice(0, input.slots);
    selected.push(...ordered);
    if (oversubscribed) selectedOversubscribed.push(...ordered);
  }
  return { selected, oversubscribedBatches, selectedOversubscribed };
}

function batchBootstrapDelta(input: {
  economic: readonly CandidateRow[];
  alpha: readonly CandidateRow[];
  iterations?: number;
}): { point: number | null; ci95: [number, number] | null; batches: number } {
  const byBatch = new Map<string, { economic: number; alpha: number }>();
  for (const row of input.economic) {
    const state = byBatch.get(row.batchKey) ?? { economic: 0, alpha: 0 };
    state.economic += metricNetR(row);
    byBatch.set(row.batchKey, state);
  }
  for (const row of input.alpha) {
    const state = byBatch.get(row.batchKey) ?? { economic: 0, alpha: 0 };
    state.alpha += metricNetR(row);
    byBatch.set(row.batchKey, state);
  }
  const values = [...byBatch.values()].map((value) => value.alpha - value.economic);
  if (!values.length) return { point: null, ci95: null, batches: 0 };
  const point = values.reduce((sum, value) => sum + value, 0);
  let rngState = 0xD41A7E >>> 0;
  const rng = (): number => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 0x1_0000_0000;
  };
  const draws: number[] = [];
  const iterations = input.iterations ?? 1_000;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) sum += values[Math.floor(rng() * values.length)]!;
    draws.push(sum);
  }
  draws.sort((a, b) => a - b);
  return { point, ci95: [draws[Math.floor(iterations * 0.025)]!, draws[Math.floor(iterations * 0.975)]!], batches: values.length };
}

type BatchPartitionPlan = {
  trainKeys: Set<string>;
  validationKeys: Set<string>;
  holdoutKeys: Set<string>;
  periods: { train: { from: string; to: string }; validation: { from: string; to: string }; holdout: { from: string; to: string } };
};

function batchPeriodForKeys(keys: readonly string[]): { from: string; to: string } {
  const timestamps = keys.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return timestamps.length
    ? { from: iso(timestamps[0]!), to: iso(timestamps.at(-1)!) }
    : { from: "NO_BATCH", to: "NO_BATCH" };
}

function createBatchPartitionPlan(rows: readonly CandidateRow[]): BatchPartitionPlan {
  const keys = [...new Set(rows.map((row) => row.batchKey))].sort();
  const trainEnd = Math.max(1, Math.floor(keys.length * 0.6));
  const validationEnd = Math.max(trainEnd + 1, Math.floor(keys.length * 0.8));
  const train = keys.slice(0, trainEnd);
  const validation = keys.slice(trainEnd, validationEnd);
  const holdout = keys.slice(validationEnd);
  return {
    trainKeys: new Set(train),
    validationKeys: new Set(validation),
    holdoutKeys: new Set(holdout),
    periods: { train: batchPeriodForKeys(train), validation: batchPeriodForKeys(validation), holdout: batchPeriodForKeys(holdout) },
  };
}

function partitionByBatch(rows: readonly CandidateRow[], plan = createBatchPartitionPlan(rows)): { train: CandidateRow[]; validation: CandidateRow[]; holdout: CandidateRow[] } {
  return {
    train: rows.filter((row) => plan.trainKeys.has(row.batchKey)),
    validation: rows.filter((row) => plan.validationKeys.has(row.batchKey)),
    holdout: rows.filter((row) => plan.holdoutKeys.has(row.batchKey)),
  };
}

function rollingWalkForward(rows: readonly CandidateRow[], featureKeys: string[]): Array<Record<string, number | null>> {
  const keys = [...new Set(rows.map((row) => row.batchKey))].sort();
  const folds: Array<Record<string, number | null>> = [];
  for (const fraction of [0.5, 0.6, 0.7]) {
    const trainEnd = Math.floor(keys.length * fraction);
    const validationEnd = Math.min(keys.length, trainEnd + Math.max(1, Math.floor(keys.length * 0.1)));
    const trainKeys = new Set(keys.slice(0, trainEnd));
    const validationKeys = new Set(keys.slice(trainEnd, validationEnd));
    const model = trainLogistic(rows.filter((row) => trainKeys.has(row.batchKey)), featureKeys);
    const validation = rows.filter((row) => validationKeys.has(row.batchKey));
    const scores = new Map(validation.flatMap((row) => {
      const score = predict(model, row);
      return score === null ? [] : [[row.batchKey + "|" + row.symbol, score] as const];
    }));
    folds.push({ trainBatches: trainKeys.size, validationBatches: validationKeys.size, ...scoreMetrics(validation, scores) });
  }
  return folds;
}

function modelReport(route: "CONTINUATION" | "FADE", rows: readonly CandidateRow[], slots: number, partitionPlan: BatchPartitionPlan): {
  report: Record<string, unknown>;
  model: LogisticModel | null;
  scores: Map<string, number>;
  holdout: CandidateRow[];
  periods: { train: { from: string; to: string }; validation: { from: string; to: string }; holdout: { from: string; to: string } };
} {
  const featureKeys = route === "CONTINUATION"
    ? ["c2ExtensionOfRange", "expansionDeltaOfRange", "c2ExtensionOfAtr", "c2BodyFraction", "combinedRvol24", "sideAlignedReturn1h", "btcSideAlignedReturn1h", "rangeWidthOfAtr"]
    : ["maxExcursionOfRange", "reentryDepthOfRange", "maxExcursionOfAtr", "c2BodyFraction", "combinedRvol24", "sideAlignedReturn1h", "btcSideAlignedReturn1h", "rangeWidthOfAtr"];
  const labelled = usableRows(rows, featureKeys);
  const partitions = partitionByBatch(labelled, partitionPlan);
  const model = trainLogistic(partitions.train, featureKeys);
  const validationScores = new Map(partitions.validation.flatMap((row) => {
    const score = predict(model, row);
    return score === null ? [] : [[row.batchKey + "|" + row.symbol, score] as const];
  }));
  const holdoutScores = new Map(partitions.holdout.flatMap((row) => {
    const score = predict(model, row);
    return score === null ? [] : [[row.batchKey + "|" + row.symbol, score] as const];
  }));
  const economic = selectionReplay({ rows: partitions.holdout, scores: holdoutScores, slots, mode: "ECONOMIC" });
  const alpha = selectionReplay({ rows: partitions.holdout, scores: holdoutScores, slots, mode: "ALPHA" });
  const seededRandom = selectionReplay({ rows: partitions.holdout, scores: holdoutScores, slots, mode: "SEEDED_RANDOM" });
  const routeBaseRate = selectionReplay({ rows: partitions.holdout, scores: holdoutScores, slots, mode: "ROUTE_BASE_RATE" });
  const lift = batchBootstrapDelta({ economic: economic.selectedOversubscribed, alpha: alpha.selectedOversubscribed });
  const holdoutDelta = (summarizeSelection(alpha.selected).netR ?? 0) - (summarizeSelection(economic.selected).netR ?? 0);
  const adequate = labelled.length >= 150 && alpha.oversubscribedBatches >= 20 && partitions.holdout.length >= 30;
  const positive = holdoutDelta > 0 && (lift.ci95?.[0] ?? Number.NEGATIVE_INFINITY) > 0;
  // A score with no scarce-slot evidence is not even a weak selector claim.
  // WEAK_SHADOW requires a directional holdout lift over at least five actual
  // oversubscribed reconstructed batches, but still lacks the full gate.
  const weakEvidence = labelled.length >= 150 && alpha.oversubscribedBatches >= 5 && holdoutDelta > 0;
  const verdict: DailyRangeSelectorArtifactStatus = adequate && positive
    ? "HISTORICALLY_VALIDATED"
    : weakEvidence ? "WEAK_SHADOW" : "REJECTED";
  return {
    report: {
      route,
      preregisteredFeatures: featureKeys,
      labelledCandidates: labelled.length,
      partitionCounts: { train: partitions.train.length, validation: partitions.validation.length, holdout: partitions.holdout.length },
      periods: partitionPlan.periods,
      model: model ? { type: "L2_LOGISTIC_REGRESSION", trainCount: model.trainCount, modelHash: hashDailyRangeSelectorModel(model) } : null,
      validation: scoreMetrics(partitions.validation, validationScores),
      holdout: scoreMetrics(partitions.holdout, holdoutScores),
      rollingWalkForward: rollingWalkForward(labelled, featureKeys),
      seededRandomBaseline: summarizeSelection(seededRandom.selected),
      routeBaseRateBaseline: {
        ...summarizeSelection(routeBaseRate.selected),
        note: "constant route pTP has no candidate-level rank; economic tie-break retains baseline selection",
      },
      economicBaseline: summarizeSelection(economic.selected),
      alphaSelector: summarizeSelection(alpha.selected),
      oversubscribed: {
        economic: summarizeSelection(economic.selectedOversubscribed),
        alpha: summarizeSelection(alpha.selectedOversubscribed),
        batches: alpha.oversubscribedBatches,
        deltaNetR: (summarizeSelection(alpha.selectedOversubscribed).netR ?? 0) - (summarizeSelection(economic.selectedOversubscribed).netR ?? 0),
        bootstrap: lift,
      },
      historicalVerdict: verdict,
      promotionBlocked: true,
      promotionBlockReason: "RECONSTRUCTED_CANDLE_PIT cannot replace >=20 mature forward FULL_PIT oversubscribed batches, Testnet parity, and explicit operator approval",
    },
    model,
    scores: holdoutScores,
    holdout: partitions.holdout,
    periods: partitionPlan.periods,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const days = positiveInteger(args.days, 180, 30, 180);
  const slots = positiveInteger(args.slots, DEFAULT_SLOT_COUNT, 1, 5);
  const safeLossBps = numberArg(args["safe-loss-bps"], DEFAULT_SAFE_LOSS_BPS, 0.01, 500);
  const symbols = (args.symbols ?? DEFAULT_SYMBOLS.join(",")).split(",").map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z0-9]+USDT$/.test(value));
  const outputRoot = resolve(args.out ?? `artifacts/daily-range-research/rcpit-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`);
  const cacheDir = join(outputRoot, "cache");
  mkdirSync(outputRoot, { recursive: true });
  const client = new MainnetCandleClient(cacheDir);
  const serverTime = await client.serverTime();
  const completedAt = Math.floor(serverTime / FIVE_MIN) * FIVE_MIN - 1;
  const researchStart = Math.floor((completedAt - days * DAY - 2 * DAY) / FIVE_MIN) * FIVE_MIN;
  const researchWindowStart = Math.floor((completedAt - days * DAY) / FIVE_MIN) * FIVE_MIN;
  const requestedSymbols = [...new Set([...symbols, "BTCUSDT", "ETHUSDT"])];
  console.log(`[rcpit] source=BINANCE_USDM_MAINNET_PUBLIC days=${days} symbols=${symbols.length} start=${iso(researchWindowStart)} end=${iso(completedAt)}`);

  const fiveMinuteBySymbol = new Map<string, Candle[]>();
  const highTimeframeCoverage: Record<string, Record<string, number>> = {};
  for (const symbol of requestedSymbols) {
    const rows = await client.panel(symbol, "5m", researchStart, completedAt);
    fiveMinuteBySymbol.set(symbol, rows);
    // Explicit interval audit: 1H and 4H are fetched from the same USD-M
    // canonical source even though the conservative feature builder derives
    // its PIT returns from completed 5m bars.
    const [oneHour, fourHour] = await Promise.all([
      client.panel(symbol, "1h", researchStart, completedAt),
      client.panel(symbol, "4h", researchStart, completedAt),
    ]);
    highTimeframeCoverage[symbol] = { fiveMinute: rows.length, oneHour: oneHour.length, fourHour: fourHour.length };
    console.log(`[rcpit] panel ${symbol} 5m=${rows.length} 1h=${oneHour.length} 4h=${fourHour.length}`);
  }

  const candidates: DailyRangeReconstructedCandidate[] = [];
  const skippedDays: Array<{ symbol: string; dateUtc: string; reason: string }> = [];
  const dates = sessionDates(researchWindowStart, completedAt);
  for (const session of dates) {
    for (const symbol of symbols) {
      const panel = fiveMinuteBySymbol.get(symbol) ?? [];
      const range = panel.filter((row) => row.openTime >= session.rangeOpenTime && row.closeTime < session.rangeCloseTime);
      const event = panel.filter((row) => row.openTime >= session.rangeCloseTime && row.closeTime < session.entryWindowCloseTime);
      const expectedRangeBars = Math.round((session.rangeCloseTime - session.rangeOpenTime) / FIVE_MIN);
      const expectedEventBars = Math.round((session.entryWindowCloseTime - session.rangeCloseTime) / FIVE_MIN);
      if (range.length !== expectedRangeBars || !contiguous(range, FIVE_MIN) || event.length !== expectedEventBars || !contiguous(event, FIVE_MIN)) {
        skippedDays.push({ symbol, dateUtc: session.dateUtc, reason: "missing_or_gapped_5m_state" });
        continue;
      }
      const rangeHigh = Math.max(...range.map((row) => row.high));
      const rangeLow = Math.min(...range.map((row) => row.low));
      if (!(rangeHigh > rangeLow)) {
        skippedDays.push({ symbol, dateUtc: session.dateUtc, reason: "invalid_range" });
        continue;
      }
      const newRows = replayReconstructedDailyRangeAutoRoute({
        dateUtc: session.dateUtc,
        symbol,
        rangeHigh,
        rangeLow,
        candles: event,
        featurePanel: {
          symbolCandles: panel,
          btcCandles: fiveMinuteBySymbol.get("BTCUSDT") ?? [],
          ethCandles: fiveMinuteBySymbol.get("ETHUSDT") ?? [],
          universeReturns1hAtDecision: (decisionTimestampMs) => symbols
            .map((candidateSymbol) => returnOneHour(fiveMinuteBySymbol.get(candidateSymbol) ?? [], decisionTimestampMs))
            .filter((value): value is number => value !== null),
        },
      });
      candidates.push(...newRows);
    }
  }
  console.log(`[rcpit] candidate replay complete candidates=${candidates.length} skipped_symbol_days=${skippedDays.length}`);

  const resolvedRows: CandidateRow[] = [];
  const candidatesBySymbol = new Map(symbols.map((symbol) => [symbol, candidates.filter((candidate) => candidate.symbol === symbol)]));
  let resolvedCount = 0;
  for (const symbol of symbols) {
    const symbolCandidates = candidatesBySymbol.get(symbol) ?? [];
    if (symbolCandidates.length === 0) continue;
    // 1m is fetched as a canonical USD-M panel, once per symbol. It is never
    // interpolated; missing paths remain missing/gapped at outcome resolution.
    const minutePanel = await client.panel(symbol, "1m", researchStart, completedAt);
    for (const candidate of symbolCandidates) {
      const { result, labelQuality } = resolveOutcomeFromMinutePanel(candidate, minutePanel, completedAt);
      const entry = candidate.decision.confirmationBar2.close;
      const riskBps = entry > 0 ? Math.abs(entry - candidate.structuralStop) / entry * 10_000 : Number.NaN;
      resolvedRows.push({
        ...result,
        batchKey: String(candidate.decisionTimestampMs),
        riskBps,
        economicProxy: candidateEconomicProxy(candidate, safeLossBps),
        labelQuality,
      });
      resolvedCount++;
    }
    console.log(`[rcpit] 1m panel ${symbol} bars=${minutePanel.length} resolved=${resolvedCount}/${candidates.length}`);
  }

  const byRoute = {
    CONTINUATION: resolvedRows.filter((row) => row.decision.entryPolicy === "CONTINUATION"),
    FADE: resolvedRows.filter((row) => row.decision.entryPolicy === "FADE"),
  };
  const chronologicalPartition = createBatchPartitionPlan(resolvedRows);
  const continuation = modelReport("CONTINUATION", byRoute.CONTINUATION, slots, chronologicalPartition);
  const fade = modelReport("FADE", byRoute.FADE, slots, chronologicalPartition);
  const allHoldout = [...continuation.holdout, ...fade.holdout];
  const allScores = new Map([...continuation.scores, ...fade.scores]);
  const allEconomic = selectionReplay({ rows: allHoldout, scores: allScores, slots, mode: "ECONOMIC" });
  const allAlpha = selectionReplay({ rows: allHoldout, scores: allScores, slots, mode: "ALPHA" });
  const allSeededRandom = selectionReplay({ rows: allHoldout, scores: allScores, slots, mode: "SEEDED_RANDOM" });
  const allRouteBaseRate = selectionReplay({ rows: allHoldout, scores: allScores, slots, mode: "ROUTE_BASE_RATE" });
  const allLift = batchBootstrapDelta({ economic: allEconomic.selectedOversubscribed, alpha: allAlpha.selectedOversubscribed });
  const specialistVerdicts = [continuation.report, fade.report].map((report) => report.historicalVerdict);
  const historicalVerdict: DailyRangeSelectorArtifactStatus = specialistVerdicts.every((verdict) => verdict === "HISTORICALLY_VALIDATED")
    ? "HISTORICALLY_VALIDATED"
    : specialistVerdicts.some((verdict) => verdict === "HISTORICALLY_VALIDATED" || verdict === "WEAK_SHADOW")
      ? "WEAK_SHADOW"
      : "REJECTED";
  // A reconstructed-only historical result may be labelled historically
  // validated, but has no execution authority until the independent forward
  // Full-PIT, Testnet parity, and operator-approval gates pass.
  const manifest = {
    datasetClass: DAILY_RANGE_RECONSTRUCTED_CANDLE_PIT_DATASET_CLASS,
    source: "BINANCE_USDM_MAINNET_PUBLIC",
    serverTime: iso(serverTime),
    dataRange: { requestedStart: iso(researchWindowStart), fetchedStart: iso(researchStart), completedEnd: iso(completedAt), days },
    symbols,
    auxiliarySymbols: ["BTCUSDT", "ETHUSDT"],
    historicalUniverse: {
      quality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      exactC1C6: "UNKNOWN_NOT_RECONSTRUCTED",
      historicalLiquiditySpreadOwnership: "UNKNOWN_NOT_RECONSTRUCTED",
      survivorship: "CURRENTLY_LISTED_SYMBOL_SNAPSHOT_ONLY; delisted contracts are not represented",
    },
    intervals: { oneMinute: "per-symbol canonical panel for barrier/MFE-MAE approximation", fiveMinute: "canonical route state", oneHour: "fetched coverage; completed-5m PIT derived features", fourHour: "fetched coverage; completed-5m PIT derived features" },
    highTimeframeCoverage,
    routeImplementation: "shared advanceDailyRangeAutoRoute pure function",
    executionEconomics: { quality: "CURRENT_FRICTION_PROXY_NOT_HISTORICAL_EXECUTION", safeLossFrictionBps: safeLossBps, maxCostRatio: 0.25, maxNotionalUsd: 25, maxPlannedRiskUsd: 0.25 },
    scarceSlotReplay: { slots, quality: "batch-local counterfactual; historical owned-slot state not reconstructable" },
    gitCommit: currentGitCommit(),
  };
  const summary = {
    generatedAt: iso(Date.now()),
    manifest,
    counts: {
      candidates: resolvedRows.length,
      continuation: byRoute.CONTINUATION.length,
      fade: byRoute.FADE.length,
      tp: resolvedRows.filter((row) => row.outcome === "TP").length,
      sl: resolvedRows.filter((row) => row.outcome === "SL").length,
      ambiguous: resolvedRows.filter((row) => row.outcome === "OUTCOME_AMBIGUOUS").length,
      unresolved: resolvedRows.filter((row) => row.outcome === "UNRESOLVED").length,
      labelComplete: resolvedRows.filter((row) => row.labelQuality === "COMPLETE_1M_WINDOW").length,
      skippedSymbolDays: skippedDays.length,
    },
    continuation: continuation.report,
    fade: fade.report,
    combinedHoldoutSelection: {
      seededRandomBaseline: summarizeSelection(allSeededRandom.selected),
      routeBaseRateBaseline: {
        ...summarizeSelection(allRouteBaseRate.selected),
        note: "constant route pTP has no candidate-level rank; economic tie-break retains baseline selection",
      },
      economicBaseline: summarizeSelection(allEconomic.selected),
      alphaSelector: summarizeSelection(allAlpha.selected),
      oversubscribedBatches: allAlpha.oversubscribedBatches,
      oversubscribedEconomic: summarizeSelection(allEconomic.selectedOversubscribed),
      oversubscribedAlpha: summarizeSelection(allAlpha.selectedOversubscribed),
      oversubscribedBootstrapDelta: allLift,
    },
    historicalVerdict,
    productionAuthority: false,
    promotionBlocked: "RECONSTRUCTED_CANDLE_PIT is not forward FULL_PIT and cannot satisfy the promotion gate alone",
  };
  writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(outputRoot, "candidates.jsonl"), resolvedRows.map((row) => JSON.stringify(row)).join("\n") + (resolvedRows.length ? "\n" : ""), "utf8");
  writeFileSync(join(outputRoot, "skipped-symbol-days.json"), JSON.stringify(skippedDays, null, 2), "utf8");

  const registry = new DailyRangeSelectorArtifactRegistry(outputRoot, "selector-artifacts.json");
  const modelBundle = { continuation: continuation.model, fade: fade.model };
  registry.saveArtifact({
    schemaVersion: 1,
    selectorId: `daily-range-rcpit-${stableHash(JSON.stringify({ range: manifest.dataRange, symbols, verdict: historicalVerdict }))}`,
    routeSpecialists: ["CONTINUATION", "FADE"],
    featureSchemaVersion: "daily-range-reconstructed-candle-pit-v1",
    trainingCutoff: iso(completedAt),
    datasetClass: "RECONSTRUCTED_CANDLE_PIT",
    datasetManifest: manifest,
    trainingPeriod: chronologicalPartition.periods.train,
    validationPeriod: chronologicalPartition.periods.validation,
    holdoutPeriod: chronologicalPartition.periods.holdout,
    metrics: summary,
    promotionGates: {
      historical: {
        status: historicalVerdict === "HISTORICALLY_VALIDATED" ? "PASS" : "FAIL",
        datasetClass: "RECONSTRUCTED_CANDLE_PIT",
        reason: historicalVerdict === "HISTORICALLY_VALIDATED"
          ? "Historical reconstructed-candle gate passed; it is still insufficient for production authority."
          : `Historical reconstructed-candle verdict is ${historicalVerdict}.`,
      },
      forwardFullPit: {
        status: "PENDING",
        matureOversubscribedBatches: 0,
        requiredMatureOversubscribedBatches: 20,
        reason: "Research runner has no forward Full-PIT authority or forward batch evidence.",
      },
      testnetParity: {
        status: "PENDING",
        reason: "Testnet runtime parity is an independent forward deployment gate.",
      },
      operatorApproval: {
        status: "NOT_APPROVED",
        reason: "Research execution does not constitute operator approval.",
      },
      executionAuthority: false,
    },
    modelHash: hashDailyRangeSelectorModel(modelBundle),
    gitCommit: currentGitCommit(),
    status: historicalVerdict,
    createdAt: iso(Date.now()),
    notes: "Research-only reconstructed-candle artifact. Runtime registry is intentionally separate and remains absent/shadow.",
  });
  console.log(`[rcpit] complete out=${outputRoot} verdict=${historicalVerdict} candidates=${resolvedRows.length}`);
}

void main().catch((error) => {
  console.error("[rcpit] FAILED", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

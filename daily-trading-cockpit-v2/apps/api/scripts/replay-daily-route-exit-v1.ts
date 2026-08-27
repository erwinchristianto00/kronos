/**
 * Read-only diagnostic for DAILY_ROUTE_EXIT_V1.
 *
 * Input: JSON from /api/live/daily-range-lane/history?kind=signals&limit=10000
 * Output: one JSON summary to stdout. It never writes lane state, places an
 * order, or searches target parameters. The only public-data request is the
 * causal one-minute USD-M path between C2 and the already-recorded legacy
 * terminal label.
 */
import {
  replayRouteSpecificExitDiagnostic,
  type DailyRangeReconstructedCandidate,
} from "../src/lib/daily-range-reconstructed-candle-pit.js";
import { dailyRangeRouteExitPolicyForSignal } from "../src/lib/daily-range-route-exit.js";

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const MAX_ONE_MINUTE_WINDOW_MS = 1_500 * MINUTE_MS;
const MAX_CANDIDATES = Math.max(1, Math.min(500, Number(process.env.DAILY_ROUTE_REPLAY_LIMIT ?? "250")));
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.DAILY_ROUTE_REPLAY_CONCURRENCY ?? "3")));
const MIN_REQUEST_GAP_MS = Math.max(0, Math.min(5_000, Number(process.env.DAILY_ROUTE_REPLAY_MIN_REQUEST_GAP_MS ?? "0")));
const RETRY_COUNT = Math.max(0, Math.min(2, Number(process.env.DAILY_ROUTE_REPLAY_RETRY_COUNT ?? "1")));
const MARKET_DATA_BASE_URL = (() => {
  const raw = process.env.DAILY_ROUTE_REPLAY_BASE_URL ?? "https://fapi.binance.com";
  const url = new URL(raw);
  if (url.origin !== "https://fapi.binance.com" && url.origin !== "https://testnet.binancefuture.com") {
    throw new Error("DAILY_ROUTE_REPLAY_BASE_URL must be Binance USD-M mainnet or testnet");
  }
  return url.origin;
})();
let lastRequestStartedAt = 0;
let paceQueue: Promise<void> = Promise.resolve();

type StoredSignal = {
  signalId?: string;
  strategyVersion?: string;
  symbol?: string;
  entryPolicy?: "CONTINUATION" | "FADE" | string;
  direction?: "LONG" | "SHORT" | string;
  breakoutDirection?: "UP" | "DOWN" | string | null;
  rangeHigh?: number;
  rangeLow?: number;
  dateUtc?: string;
  signalTimestampMs?: number;
  confirmationBar1?: Candle;
  confirmationBar2?: Candle;
  research?: {
    counterfactual?: {
      status?: string;
      entryPrice?: number;
      structuralStop?: number;
      takeProfit?: number;
      tickSize?: number | null;
      maturedAt?: string | null;
    } | null;
  } | null;
};

type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStdIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pacePublicRequest(): Promise<void> {
  let release: (() => void) | null = null;
  const previous = paceQueue;
  paceQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(0, lastRequestStartedAt + MIN_REQUEST_GAP_MS - Date.now());
    if (waitMs > 0) await delay(waitMs);
    lastRequestStartedAt = Date.now();
  } finally {
    release?.();
  }
}

function roundToStep(value: number, step: number, direction: "LONG" | "SHORT"): number {
  if (!(value > 0) || !(step > 0)) return value;
  const units = value / step;
  const rounded = direction === "LONG" ? Math.ceil(units - 1e-10) : Math.floor(units + 1e-10);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  return Number((rounded * step).toFixed(Math.min(14, decimals)));
}

function asCandle(row: unknown, intervalMs: number): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const openTime = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const closeTime = Number(row[6]);
  if (![openTime, closeTime, open, high, low, close, volume].every(Number.isFinite)
    || closeTime !== openTime + intervalMs - 1) return null;
  return { openTime, closeTime, open, high, low, close, volume };
}

function aggregateCompletedFiveMinute(minuteCandles: readonly Candle[]): Candle[] {
  const byOpen = new Map<number, Candle[]>();
  for (const candle of minuteCandles) {
    const openTime = Math.floor(candle.openTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const rows = byOpen.get(openTime) ?? [];
    rows.push(candle);
    byOpen.set(openTime, rows);
  }
  return [...byOpen.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([openTime, rows]) => {
      const ordered = rows.sort((left, right) => left.openTime - right.openTime);
      if (ordered.length !== 5 || ordered.some((row, index) => row.openTime !== openTime + index * MINUTE_MS)) return [];
      return [{
        openTime,
        closeTime: openTime + FIVE_MINUTES_MS - 1,
        open: ordered[0]!.open,
        high: Math.max(...ordered.map((row) => row.high)),
        low: Math.min(...ordered.map((row) => row.low)),
        close: ordered.at(-1)!.close,
        volume: ordered.reduce((sum, row) => sum + row.volume, 0),
      }];
    });
}

function candidateFromSignal(signal: StoredSignal): { signalId: string | null; candidate: DailyRangeReconstructedCandidate; replayEndTime: number; legacyTakeProfit: number; oldOutcome: "TAKE_PROFIT" | "STOP_LOSS" } | null {
  const counterfactual = signal.research?.counterfactual;
  if (signal.strategyVersion !== "daily-4h-range-auto-route-ny-2r-v2"
    || !signal.symbol
    || (signal.entryPolicy !== "CONTINUATION" && signal.entryPolicy !== "FADE")
    || (signal.direction !== "LONG" && signal.direction !== "SHORT")
    || (signal.breakoutDirection !== "UP" && signal.breakoutDirection !== "DOWN")
    || !finite(signal.rangeHigh) || !finite(signal.rangeLow)
    || !signal.confirmationBar1 || !signal.confirmationBar2
    || !counterfactual || (counterfactual.status !== "MATURE_TP" && counterfactual.status !== "MATURE_SL")
    || !finite(counterfactual.entryPrice) || !finite(counterfactual.structuralStop) || !finite(counterfactual.takeProfit)
    || !counterfactual.maturedAt) return null;
  const decisionTimestampMs = finite(signal.signalTimestampMs) ? signal.signalTimestampMs : signal.confirmationBar2.closeTime + 1;
  const endTime = Date.parse(counterfactual.maturedAt);
  if (!Number.isFinite(endTime) || endTime <= decisionTimestampMs || endTime - decisionTimestampMs > MAX_ONE_MINUTE_WINDOW_MS) return null;
  const policy = dailyRangeRouteExitPolicyForSignal({
    route: signal.entryPolicy,
    originalBreakoutDirection: signal.breakoutDirection,
    rangeHigh: signal.rangeHigh,
    rangeLow: signal.rangeLow,
    effectiveAt: new Date(decisionTimestampMs).toISOString(),
  });
  if (!policy) return null;
  const risk = Math.abs(counterfactual.entryPrice - counterfactual.structuralStop);
  if (!(risk > 0)) return null;
  const rawNewTarget = signal.direction === "LONG"
    ? counterfactual.entryPrice + policy.tpMultipleR * risk
    : counterfactual.entryPrice - policy.tpMultipleR * risk;
  const takeProfit = policy.tpMultipleR === 2
    ? counterfactual.takeProfit
    : roundToStep(rawNewTarget, counterfactual.tickSize ?? 1e-12, signal.direction);
  return {
    signalId: typeof signal.signalId === "string" ? signal.signalId : null,
    candidate: {
      datasetClass: "RECONSTRUCTED_CANDLE_PIT",
      researchEligibilityQuality: "CANDLE_ELIGIBLE_CURRENT_UNIVERSE",
      dateUtc: signal.dateUtc ?? new Date(decisionTimestampMs).toISOString().slice(0, 10),
      symbol: signal.symbol!,
      decision: {
        entryPolicy: signal.entryPolicy,
        breakoutDirection: signal.breakoutDirection,
        direction: signal.direction,
        breakoutId: "historical-route-exit-replay",
        breakoutExtreme: signal.entryPolicy === "FADE"
          ? counterfactual.structuralStop
          : signal.breakoutDirection === "UP" ? signal.confirmationBar2.high : signal.confirmationBar2.low,
        confirmationBar1: signal.confirmationBar1,
        confirmationBar2: signal.confirmationBar2,
      },
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      decisionTimestampMs,
      structuralStop: counterfactual.structuralStop,
      takeProfit,
      exitPolicyId: policy.exitPolicyId,
      tpMultipleR: policy.tpMultipleR,
      thesisInvalidationType: policy.thesisInvalidationType,
      originalBreakoutDirection: policy.originalBreakoutDirection,
      originalBreakoutBoundary: policy.originalBreakoutBoundary,
      features: {},
    },
    // Both policies receive the same fixed causal window. Stopping at the
    // legacy terminal bar would truncate a new policy that is still open.
    replayEndTime: decisionTimestampMs + MAX_ONE_MINUTE_WINDOW_MS - 1,
    legacyTakeProfit: counterfactual.takeProfit,
    oldOutcome: counterfactual.status === "MATURE_TP" ? "TAKE_PROFIT" : "STOP_LOSS",
  };
}

async function fetchMinutePath(symbol: string, startTime: number, endTime: number): Promise<Candle[]> {
  const url = new URL("/fapi/v1/klines", MARKET_DATA_BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("endTime", String(endTime));
  url.searchParams.set("limit", "1500");
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    await pacePublicRequest();
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("Binance payload is not an array");
      return payload.map((row) => asCandle(row, MINUTE_MS)).filter((row): row is Candle => row !== null);
    }
    if ((response.status === 418 || response.status === 429) && attempt < RETRY_COUNT) {
      // Do not hammer a transport that explicitly asks us to slow down. The
      // retry remains read-only and bounded; a persistent limit is reported.
      await delay(response.status === 418 ? 30_000 : 5_000);
      continue;
    }
    throw new Error(`Binance ${response.status}`);
  }
  throw new Error("Binance replay fetch exhausted unexpectedly");
}

async function concurrentMap<T, U>(rows: readonly T[], worker: (row: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(rows.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= rows.length) return;
      result[current] = await worker(rows[current]!);
    }
  }));
  return result;
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  const raw = await readStdIn();
  const parsed: unknown = JSON.parse(raw);
  const allRows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { rows?: unknown[] }).rows) ? (parsed as { rows: unknown[] }).rows : [];
  const eligible = allRows
    .map((row) => candidateFromSignal(row as StoredSignal))
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => left.candidate.decisionTimestampMs - right.candidate.decisionTimestampMs)
    .slice(0, MAX_CANDIDATES);
  const results = await concurrentMap(eligible, async (row) => {
    try {
      const oneMinute = await fetchMinutePath(row.candidate.symbol, row.candidate.decisionTimestampMs, row.replayEndTime);
      const fiveMinute = aggregateCompletedFiveMinute(oneMinute);
      const diagnostic = replayRouteSpecificExitDiagnostic({
        candidate: row.candidate,
        completedFiveMinuteCandles: fiveMinute,
        completedOneMinuteCandles: oneMinute,
        legacyTakeProfit: row.legacyTakeProfit,
      });
      return { ok: true as const, signalId: row.signalId, route: row.candidate.decision.entryPolicy, expectedLegacy: row.oldOutcome, diagnostic };
    } catch (error) {
      return { ok: false as const, signalId: row.signalId, route: row.candidate.decision.entryPolicy, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const byRoute: Record<string, { eligible: number; replayed: number; unavailable: number; newOutcomes: Record<string, number>; oldOutcomes: Record<string, number>; legacyMatches: number; legacyMismatches: number }> = {};
  const sample: unknown[] = [];
  const legacyMismatchSamples: unknown[] = [];
  const unavailableSamples: unknown[] = [];
  for (const result of results) {
    const bucket = byRoute[result.route] ?? { eligible: 0, replayed: 0, unavailable: 0, newOutcomes: {}, oldOutcomes: {}, legacyMatches: 0, legacyMismatches: 0 };
    bucket.eligible += 1;
    if (!result.ok) {
      bucket.unavailable += 1;
      if (unavailableSamples.length < 32) unavailableSamples.push({ signalId: result.signalId, route: result.route, error: result.error });
      byRoute[result.route] = bucket;
      continue;
    }
    bucket.replayed += 1;
    addCount(bucket.newOutcomes, result.diagnostic.newPolicy.outcome);
    addCount(bucket.oldOutcomes, result.diagnostic.legacyGlobal2R.outcome);
    const legacyMatches = result.diagnostic.legacyGlobal2R.outcome === result.expectedLegacy;
    if (legacyMatches) bucket.legacyMatches += 1;
    else {
      bucket.legacyMismatches += 1;
      if (legacyMismatchSamples.length < 32) legacyMismatchSamples.push({
        signalId: result.signalId,
        symbol: result.diagnostic.symbol,
        route: result.route,
        expectedLegacy: result.expectedLegacy,
        legacyGlobal2R: result.diagnostic.legacyGlobal2R,
        newPolicy: result.diagnostic.newPolicy,
      });
    }
    if (sample.length < 12) sample.push({
      signalId: result.signalId,
      symbol: result.diagnostic.symbol,
      route: result.route,
      expectedLegacy: result.expectedLegacy,
      newPolicy: result.diagnostic.newPolicy,
      legacyGlobal2R: result.diagnostic.legacyGlobal2R,
    });
    byRoute[result.route] = bucket;
  }
  console.log(JSON.stringify({
    policyId: "daily-route-exit-v1",
    diagnosticOnly: true,
    targetSweep: false,
    marketDataBaseUrl: MARKET_DATA_BASE_URL,
    inputSignals: allRows.length,
    matureEligibleSignals: eligible.length,
    replayed: results.filter((row) => row.ok).length,
    unavailable: results.filter((row) => !row.ok).length,
    byRoute,
    legacyMismatchSamples,
    unavailableSamples,
    sample,
    limitations: [
      "Both policies use the same fixed 1,500-minute causal candle horizon; stored legacy labels are independently reconciled rather than assumed correct.",
      "New logical exits use completed 5m close as a diagnostic price proxy; production records actual reduce-only fill and slippage.",
      "Only mature historical episodes with a source-compatible Binance USD-M data path are comparable; testnet and mainnet candles must not be blended.",
    ],
  }, null, 2));
}

await main();

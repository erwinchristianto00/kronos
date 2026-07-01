import { buildCandidate, round, type Candidate, type ScanResult, type SentimentSignal, type WhaleSignal } from "@dtc/shared";

import { BinanceClient, BinanceRequestError } from "./binance.js";
import type { KronosAvailability, KronosClient } from "./kronos.js";
import type { ScanTimingObserver } from "./scan-timing-diagnostics.js";
import type { SocialClient } from "./social.js";
import type { WhaleClient } from "./whale.js";

export const UNIVERSE = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "PEPEUSDT",
  "ARBUSDT",
  "OPUSDT",
  "INJUSDT",
  "WLDUSDT",
  "APTUSDT",
  "SEIUSDT",
  "NEARUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "FETUSDT",
  "RNDRUSDT",
] as const;
const SYMBOL_FETCH_CONCURRENCY = 5;
const DEFAULT_CANDLE_FETCH_TIMEOUT_MS = 10_000;
// Per-provider external-signal fetch timeout. 2.5s was too tight for the occasional
// cold-TLS / transient spike on feargreed (normally ~1s from the VPS), which tripped
// the circuit breaker and degraded the "External Signals" node. 4s tolerates the spike
// without meaningfully slowing the scan (the fetch is cached for 30 min anyway). Env-tunable.
const DEFAULT_EXTERNAL_SIGNAL_FETCH_TIMEOUT_MS = Number(process.env.EXTERNAL_SIGNAL_FETCH_TIMEOUT_MS) || 4_000;
// 2026-07-01: raised 15s -> 24s. Root-caused Kronos's 25% success rate (5/20 forecasts, 15 timeout):
// a single real inference measured ~7.4s on the VPS, the Kronos client serializes ALL requests
// through one global concurrency slot (KRONOS_CONCURRENCY=1 in kronos.ts — verified the model server
// itself cannot parallelize; 3 concurrent /predict calls returned in 6.35s/12.27s/18.89s, i.e. fully
// serial), yet queueTimeoutMs was capped at 3s — far too short for the 2nd+ symbol in the race to ever
// get a turn. Raising the total budget gives queueTimeoutMs (below) room to cover a real ~7-8s wait.
const DEFAULT_TOTAL_SYMBOL_FETCH_TIMEOUT_MS = 24_000;
const DEFAULT_SYMBOL_FAILURE_RATE_THRESHOLD = 0.8;
const DEFAULT_PROVIDER_TIMEOUT_STREAK_THRESHOLD = 2;
const DEFAULT_PROVIDER_CIRCUIT_SKIP_SCANS = 3;

type ExternalProviderName = "whale" | "sentiment";

interface ProviderCircuitState {
  consecutiveTimeouts: number;
  skipRemainingScans: number;
  lastReason: string | null;
  lastTriggeredAt: string | null;
}

const providerCircuits: Record<ExternalProviderName, ProviderCircuitState> = {
  whale: { consecutiveTimeouts: 0, skipRemainingScans: 0, lastReason: null, lastTriggeredAt: null },
  sentiment: { consecutiveTimeouts: 0, skipRemainingScans: 0, lastReason: null, lastTriggeredAt: null },
};

class StageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
    message: string,
  ) {
    super(message);
    this.name = "StageTimeoutError";
  }
}

function positiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveEnvFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout<T>(promise: Promise<T>, stage: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StageTimeoutError(stage, timeoutMs, `timeout: ${stage} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function timeLeft(deadlineMs: number, fallbackMs: number): number {
  return Math.max(1, Math.min(fallbackMs, deadlineMs - Date.now()));
}

function beginProviderCircuitScan(): Record<ExternalProviderName, boolean> {
  const skipped: Record<ExternalProviderName, boolean> = { whale: false, sentiment: false };
  for (const provider of Object.keys(providerCircuits) as ExternalProviderName[]) {
    const state = providerCircuits[provider];
    if (state.skipRemainingScans > 0) {
      skipped[provider] = true;
      state.skipRemainingScans -= 1;
    }
  }
  return skipped;
}

function markProviderSuccess(provider: ExternalProviderName): void {
  providerCircuits[provider].consecutiveTimeouts = 0;
}

function markProviderTimeout(provider: ExternalProviderName, reason: string): ProviderCircuitState {
  const threshold = positiveEnvInt(process.env.SCAN_PROVIDER_TIMEOUT_STREAK_THRESHOLD, DEFAULT_PROVIDER_TIMEOUT_STREAK_THRESHOLD);
  const skipScans = positiveEnvInt(process.env.SCAN_PROVIDER_CIRCUIT_SKIP_SCANS, DEFAULT_PROVIDER_CIRCUIT_SKIP_SCANS);
  const state = providerCircuits[provider];
  state.consecutiveTimeouts += 1;
  state.lastReason = reason;
  state.lastTriggeredAt = new Date().toISOString();
  if (state.consecutiveTimeouts >= threshold) {
    state.skipRemainingScans = Math.max(state.skipRemainingScans, skipScans);
    state.consecutiveTimeouts = 0;
  }
  return state;
}

function circuitOpen(provider: ExternalProviderName): boolean {
  return providerCircuits[provider].skipRemainingScans > 0;
}

export function _resetScanProviderCircuitsForTests(): void {
  for (const provider of Object.keys(providerCircuits) as ExternalProviderName[]) {
    providerCircuits[provider] = { consecutiveTimeouts: 0, skipRemainingScans: 0, lastReason: null, lastTriggeredAt: null };
  }
}

function unavailableWhaleSignal(): WhaleSignal {
  return {
    available: false,
    signal: "UNAVAILABLE",
    score: 0,
    reason: "Whale source is unavailable, so whale weight stays at zero.",
  };
}

function unavailableSentimentSignal(): SentimentSignal {
  return {
    available: false,
    signal: "UNAVAILABLE",
    score: 0,
    confidence: 0,
    source: "none",
    reason: "Sentiment source is unavailable, so sentiment weight stays at zero.",
  };
}

function calculateVolumeRatio5m(candles5m: Awaited<ReturnType<BinanceClient["getCandles"]>>): number | null {
  if (candles5m.length < 22) {
    return null;
  }
  const completedCandle = candles5m.at(-2);
  const baselineWindow = candles5m.slice(-22, -2);
  if (!completedCandle || baselineWindow.length === 0) {
    return null;
  }
  const baseline = baselineWindow.reduce((sum, candle) => sum + candle.volume, 0) / baselineWindow.length;
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return null;
  }
  return round(completedCandle.volume / baseline, 4);
}

function deriveMarketRegime(candidates: Candidate[]): string {
  if (candidates.length === 0) {
    return "No usable market regime because all symbols were skipped.";
  }

  const bullish = candidates.filter((candidate) => candidate.finalDirection === "LONG").length;
  const bearish = candidates.filter((candidate) => candidate.finalDirection === "SHORT").length;

  if (bullish >= bearish + 4) {
    return "Bullish expansion";
  }
  if (bearish >= bullish + 4) {
    return "Bearish pressure";
  }
  return "Mixed rotation";
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  worker: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function safeKronosPrediction(
  kronosClient: KronosClient,
  availability: KronosAvailability,
  symbol: string,
  candles1h: Awaited<ReturnType<BinanceClient["getCandles"]>>,
  symbolBudgetMs: number,
) {
  const classify = (message: string) => {
    const text = message.toLowerCase();
    if (text.includes("timeout") || text.includes("timed out") || text.includes("abort")) {
      return { available: false, reason: "timeout", availabilityReasonCode: "TIMEOUT" as const };
    }
    if (text.includes("unsupported")) {
      return { available: false, reason: "unsupported symbol", availabilityReasonCode: "UNSUPPORTED_SYMBOL" as const };
    }
    if (text.includes("at least") || text.includes("not enough candle") || text.includes("insufficient")) {
      return { available: false, reason: "not enough candles", availabilityReasonCode: "NOT_ENOUGH_CANDLES" as const };
    }
    if (text.includes("invalid") || text.includes("nan") || text.includes("duplicate timestamp") || text.includes("negative volume")) {
      return { available: false, reason: "invalid input", availabilityReasonCode: "INVALID_INPUT" as const };
    }
    if (text.includes("busy") || text.includes("overload")) {
      return { available: false, reason: "model busy", availabilityReasonCode: "MODEL_BUSY" as const };
    }
    if (text.includes("unavailable") || text.includes("not configured") || text.includes("not connected")) {
      return { available: false, reason: "unavailable", availabilityReasonCode: "UNAVAILABLE" as const };
    }
    return { available: false, reason: "prediction failed", availabilityReasonCode: "PREDICTION_FAILED" as const };
  };

  if (!availability.reachable) {
    return classify(availability.message);
  }

  try {
    // requestTimeoutMs: real inference measured ~7.4s; 9.5s ceiling covers it with margin.
    const requestTimeoutMs = Math.max(1_000, Math.min(9_500, Math.floor(symbolBudgetMs * 0.55)));
    // queueTimeoutMs: with KRONOS_CONCURRENCY=1, a symbol 2nd-in-line must wait out the ~7.4s
    // inference ahead of it before its own turn even starts. The old 3s ceiling killed it before
    // that wait ever completed, regardless of budget. 10s covers one ahead-of-you inference + margin.
    const queueTimeoutMs = Math.max(250, Math.min(10_000, Math.floor(symbolBudgetMs * 0.4)));
    return await kronosClient.predict(symbol, "1h", candles1h, {
      requestTimeoutMs,
      queueTimeoutMs,
      preferStaleOnTimeout: true,
    });
  } catch (error) {
    return classify(error instanceof Error ? error.message : "Kronos prediction failed.");
  }
}

function summarizeKronosScanStatus(
  base: KronosAvailability,
  stats: {
    attempted: number;
    succeeded: number;
    failed: number;
    timeout: number;
    invalidInput: number;
    predictionFailed: number;
    modelBusy: number;
  },
): KronosAvailability {
  const successRate = stats.attempted > 0 ? round(stats.succeeded / stats.attempted, 4) : 0;
  const dominantFailures = [
    ["timeout", stats.timeout],
    ["invalid input", stats.invalidInput],
    ["model busy", stats.modelBusy],
    ["prediction failed", stats.predictionFailed],
  ]
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");

  if (!base.configured || !base.reachable) {
    return {
      ...base,
      available: false,
      state: "OFFLINE",
      reachable: false,
      forecastHealthy: false,
      degraded: false,
      attempted: stats.attempted,
      succeeded: stats.succeeded,
      failed: stats.failed,
      timeout: stats.timeout,
      invalidInput: stats.invalidInput,
      predictionFailed: stats.predictionFailed,
      modelBusy: stats.modelBusy,
      successRate,
    };
  }

  if (stats.attempted === 0) {
    return {
      ...base,
      available: false,
      state: "REACHABLE",
      reachable: true,
      forecastHealthy: false,
      degraded: false,
      message: "Kronos reachable; no symbol forecasts were attempted on this scan.",
      attempted: 0,
      succeeded: 0,
      failed: 0,
      timeout: 0,
      invalidInput: 0,
      predictionFailed: 0,
      modelBusy: 0,
      successRate: 0,
    };
  }

  if (successRate >= 0.6) {
    return {
      ...base,
      available: true,
      state: "FORECAST_HEALTHY",
      reachable: true,
      forecastHealthy: true,
      degraded: false,
      message: `Kronos active (${stats.succeeded}/${stats.attempted} symbol forecasts succeeded).`,
      attempted: stats.attempted,
      succeeded: stats.succeeded,
      failed: stats.failed,
      timeout: stats.timeout,
      invalidInput: stats.invalidInput,
      predictionFailed: stats.predictionFailed,
      modelBusy: stats.modelBusy,
      successRate,
    };
  }

  return {
    ...base,
    available: false,
    state: "DEGRADED",
    reachable: true,
    forecastHealthy: false,
    degraded: true,
    message: `Kronos degraded: ${stats.succeeded}/${stats.attempted} symbol forecasts succeeded${dominantFailures ? `, ${dominantFailures}` : ""}`,
    attempted: stats.attempted,
    succeeded: stats.succeeded,
    failed: stats.failed,
    timeout: stats.timeout,
    invalidInput: stats.invalidInput,
    predictionFailed: stats.predictionFailed,
    modelBusy: stats.modelBusy,
    successRate,
  };
}

export class ScanService {
  constructor(
    private readonly binanceClient: BinanceClient,
    private readonly kronosClient: KronosClient,
    private readonly whaleClient: WhaleClient,
    private readonly socialClient: SocialClient,
  ) {}

  async scan(options: { timing?: ScanTimingObserver } = {}): Promise<ScanResult> {
    const timing = options.timing;
    const top = 10;
    timing?.startStage("sourceAvailability");
    const availability = await this.kronosClient.availability();
    const whaleAvailability = await this.whaleClient.availability();
    const socialAvailability = await this.socialClient.availability();
    timing?.finishStage("sourceAvailability");
    this.binanceClient.resetFetchSummary();
    const candleFetchTimeoutMs = positiveEnvInt(process.env.SCAN_CANDLE_FETCH_TIMEOUT_MS, DEFAULT_CANDLE_FETCH_TIMEOUT_MS);
    const externalSignalFetchTimeoutMs = positiveEnvInt(process.env.SCAN_EXTERNAL_SIGNAL_FETCH_TIMEOUT_MS, DEFAULT_EXTERNAL_SIGNAL_FETCH_TIMEOUT_MS);
    const totalSymbolFetchTimeoutMs = positiveEnvInt(process.env.SCAN_TOTAL_SYMBOL_FETCH_TIMEOUT_MS, DEFAULT_TOTAL_SYMBOL_FETCH_TIMEOUT_MS);
    const failureRateThreshold = positiveEnvFloat(process.env.SCAN_SYMBOL_FAILURE_RATE_THRESHOLD, DEFAULT_SYMBOL_FAILURE_RATE_THRESHOLD);
    const providerSkippedAtScanStart = beginProviderCircuitScan();
    const recordProviderDegraded = (provider: ExternalProviderName, reason: string, timeoutMs: number | null) => {
      const state = providerCircuits[provider];
      timing?.recordDegradedProvider?.({
        provider,
        reason,
        timeoutMs,
        remainingScanSkips: state.skipRemainingScans,
        triggeredAt: state.lastTriggeredAt ?? new Date().toISOString(),
      });
    };
    for (const provider of Object.keys(providerSkippedAtScanStart) as ExternalProviderName[]) {
      if (providerSkippedAtScanStart[provider]) {
        recordProviderDegraded(provider, providerCircuits[provider].lastReason ?? "provider circuit breaker open", null);
      }
    }
    const symbolFailures: ScanResult["diagnostics"]["symbolFailures"] = [];
    const kronosStats = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      timeout: 0,
      invalidInput: 0,
      predictionFailed: 0,
      modelBusy: 0,
    };
    const candidates = await mapWithConcurrency(
      UNIVERSE,
      SYMBOL_FETCH_CONCURRENCY,
      async (symbol) => {
        const symbolStartedMs = Date.now();
        const symbolDeadlineMs = symbolStartedMs + totalSymbolFetchTimeoutMs;
        let activeSymbolStage: string | null = null;
        let candleFetchMs: number | null = null;
        let kronosForecastMs: number | null = null;
        let externalSignalFetchMs: number | null = null;
        let candidateScoringMs: number | null = null;
        let binanceRetryMs: number | null = null;
        let providerWaitMs: number | null = null;
        const recordSymbol = (
          status: "COMPLETED" | "FAILED",
          failureStage?: string | null,
          failureReason?: string | null,
        ) => {
          const fetchSummary = this.binanceClient.getSymbolFetchSummary(symbol);
          binanceRetryMs = fetchSummary.binanceRetryMs;
          providerWaitMs = fetchSummary.providerWaitMs;
          timing?.recordSymbolTiming({
            symbol,
            status,
            totalMs: Date.now() - symbolStartedMs,
            candleFetchMs,
            kronosForecastMs,
            externalSignalFetchMs,
            binanceRetryMs,
            providerWaitMs,
            totalSymbolFetchMs: Date.now() - symbolStartedMs,
            candidateScoringMs,
            failureStage,
            failureReason,
          });
        };
        try {
          activeSymbolStage = "candleFetch";
          timing?.markSymbolStage(symbol, activeSymbolStage);
          const candleStartedMs = Date.now();
          const [candles5m, candles15m, candles1h, ticker24h, bookTicker] = await withTimeout(
            Promise.all([
              this.binanceClient.getCandles(symbol, "5m", 150),
              this.binanceClient.getCandles(symbol, "15m", 150),
              this.binanceClient.getCandles(symbol, "1h", 150),
              this.binanceClient.getTicker24h(symbol),
              this.binanceClient.getBookTicker(symbol),
            ]),
            "candleFetch",
            timeLeft(symbolDeadlineMs, candleFetchTimeoutMs),
          );
          candleFetchMs = Date.now() - candleStartedMs;
          activeSymbolStage = "kronosForecast";
          timing?.markSymbolStage(symbol, activeSymbolStage);
          const kronosStartedMs = Date.now();
          const kronosBudgetMs = timeLeft(symbolDeadlineMs, totalSymbolFetchTimeoutMs);
          const kronos = await withTimeout(
            safeKronosPrediction(this.kronosClient, availability, symbol, candles1h, kronosBudgetMs),
            "kronosForecast",
            kronosBudgetMs,
          );
          kronosForecastMs = Date.now() - kronosStartedMs;
          if (availability.reachable) {
            kronosStats.attempted += 1;
            if (kronos.available && !("degradedSampling" in kronos && kronos.degradedSampling)) {
              kronosStats.succeeded += 1;
            } else {
              kronosStats.failed += 1;
              switch (kronos.availabilityReasonCode) {
                case "TIMEOUT":
                  kronosStats.timeout += 1;
                  break;
                case "INVALID_INPUT":
                case "NOT_ENOUGH_CANDLES":
                  kronosStats.invalidInput += 1;
                  break;
                case "MODEL_BUSY":
                  kronosStats.modelBusy += 1;
                  break;
                case "PREDICTION_FAILED":
                  kronosStats.predictionFailed += 1;
                  break;
                default:
                  break;
              }
            }
          }
          const volumeRatio5m = calculateVolumeRatio5m(candles5m);
          activeSymbolStage = "externalSignalFetch";
          timing?.markSymbolStage(symbol, activeSymbolStage);
          const signalStartedMs = Date.now();
          const fetchWhaleSignal = async (): Promise<WhaleSignal> => {
            if (!whaleAvailability.available) return unavailableWhaleSignal();
            if (providerSkippedAtScanStart.whale || circuitOpen("whale")) {
              recordProviderDegraded("whale", providerCircuits.whale.lastReason ?? "provider circuit breaker open", null);
              return { ...unavailableWhaleSignal(), reason: "Whale provider degraded by scan-time circuit breaker." };
            }
            try {
              const signal = await withTimeout(
                this.whaleClient.getSignal(symbol, volumeRatio5m),
                "externalSignalFetch:whale",
                timeLeft(symbolDeadlineMs, externalSignalFetchTimeoutMs),
              );
              markProviderSuccess("whale");
              return signal;
            } catch (error) {
              if (error instanceof StageTimeoutError) {
                const state = markProviderTimeout("whale", error.message);
                if (state.skipRemainingScans > 0) recordProviderDegraded("whale", error.message, error.timeoutMs);
                return { ...unavailableWhaleSignal(), reason: error.message };
              }
              return { ...unavailableWhaleSignal(), reason: error instanceof Error ? error.message : "Whale provider failed." };
            }
          };
          const fetchSentimentSignal = async (): Promise<SentimentSignal> => {
            if (!socialAvailability.available) return unavailableSentimentSignal();
            if (providerSkippedAtScanStart.sentiment || circuitOpen("sentiment")) {
              recordProviderDegraded("sentiment", providerCircuits.sentiment.lastReason ?? "provider circuit breaker open", null);
              return { ...unavailableSentimentSignal(), reason: "Sentiment provider degraded by scan-time circuit breaker." };
            }
            try {
              const signal = await withTimeout(
                this.socialClient.getSignal(symbol),
                "externalSignalFetch:sentiment",
                timeLeft(symbolDeadlineMs, externalSignalFetchTimeoutMs),
              );
              markProviderSuccess("sentiment");
              return signal;
            } catch (error) {
              if (error instanceof StageTimeoutError) {
                const state = markProviderTimeout("sentiment", error.message);
                if (state.skipRemainingScans > 0) recordProviderDegraded("sentiment", error.message, error.timeoutMs);
                return { ...unavailableSentimentSignal(), reason: error.message };
              }
              return { ...unavailableSentimentSignal(), reason: error instanceof Error ? error.message : "Sentiment provider failed." };
            }
          };
          const [whale, sentiment] = await Promise.all([fetchWhaleSignal(), fetchSentimentSignal()]);
          externalSignalFetchMs = Date.now() - signalStartedMs;

          activeSymbolStage = "candidateScoring";
          timing?.markSymbolStage(symbol, activeSymbolStage);
          const scoringStartedMs = Date.now();
          const candidate = buildCandidate({
            symbol,
            candles5m,
            candles15m,
            candles1h,
            spread: bookTicker,
            volume: {
              ...ticker24h,
              volumeRatio5m,
            },
            kronos,
            whale,
            sentiment,
          });
          candidateScoringMs = Date.now() - scoringStartedMs;
          recordSymbol("COMPLETED");
          return candidate;
        } catch (error) {
          const typedError =
            error instanceof BinanceRequestError
              ? error
              : error instanceof StageTimeoutError
                ? new BinanceRequestError("timeout", error.stage, error.message)
              : new BinanceRequestError("network", "symbol_scan", error instanceof Error ? error.message : "Symbol scan failed.");
          symbolFailures.push({
            symbol,
            stage: typedError.stage,
            failureType: typedError.failureType,
            reason: typedError.message,
          });
          recordSymbol("FAILED", activeSymbolStage ?? typedError.stage, typedError.message);
          return null;
        }
      },
    );

    const builtCandidates = candidates.filter((candidate): candidate is Candidate => candidate !== null);
    const symbolFailureRate = symbolFailures.length / UNIVERSE.length;
    if (symbolFailures.length > 0 && symbolFailureRate > failureRateThreshold) {
      throw new BinanceRequestError(
        "network",
        "coreMarketScan",
        `partial scan failure rate ${(symbolFailureRate * 100).toFixed(1)}% exceeded threshold ${(failureRateThreshold * 100).toFixed(1)}%`,
      );
    }
    const liveSymbols = builtCandidates.filter((candidate) => this.binanceClient.getSymbolFetchSummary(candidate.symbol).mode === "LIVE").length;
    const cacheFreshSymbols = builtCandidates.filter((candidate) => this.binanceClient.getSymbolFetchSummary(candidate.symbol).mode === "CACHE_FRESH").length;
    timing?.startStage("candidateRanking");
    const sorted = builtCandidates.sort((left, right) => {
      if (right.opportunityScore !== left.opportunityScore) {
        return right.opportunityScore - left.opportunityScore;
      }
      return right.confidence - left.confidence;
    });
    const mainCandidates = sorted
      .filter((candidate) => candidate.status !== "SKIP")
      .slice(0, top)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    const hiddenSkips = sorted
      .filter((candidate) => candidate.status === "SKIP")
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    timing?.finishStage("candidateRanking");

    timing?.startStage("marketRegime");
    const marketRegime = deriveMarketRegime(mainCandidates.length ? mainCandidates : builtCandidates);
    timing?.finishStage("marketRegime");
    const addMarketRegimeCaution = (candidate: Candidate): Candidate => {
      const regimeMismatch =
        (marketRegime === "Bullish expansion" && candidate.finalDirection === "SHORT") ||
        (marketRegime === "Bearish pressure" && candidate.finalDirection === "LONG");
      if (!regimeMismatch) {
        return candidate;
      }
      return {
        ...candidate,
        reason: [...candidate.reason, `Caution: ${marketRegime} conflicts with this ${candidate.finalDirection.toLowerCase()} setup.`],
      };
    };

    const kronosDiagnostics = summarizeKronosScanStatus(availability, kronosStats);

    return {
      generatedAt: new Date().toISOString(),
      coverage: {
        totalSymbols: UNIVERSE.length,
        scannedSymbols: builtCandidates.length,
        returnedSymbols: mainCandidates.length,
        skippedSymbols: symbolFailures.length + hiddenSkips.length,
        percent: round((builtCandidates.length / UNIVERSE.length) * 100, 2),
        liveSymbols,
        cacheFreshSymbols,
      },
      marketRegime,
      top10: mainCandidates.map(addMarketRegimeCaution),
      diagnostics: {
        universe: [...UNIVERSE],
        skippedSymbols: symbolFailures.map((failure) => failure.symbol),
        symbolFailures,
        hiddenSkips: hiddenSkips.map(addMarketRegimeCaution),
        kronos: kronosDiagnostics,
        whale: whaleAvailability,
        sentiment: socialAvailability,
      },
    };
  }
}

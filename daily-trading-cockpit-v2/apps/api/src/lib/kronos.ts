import type { Candle, KronosAvailabilityReasonCode, KronosPrediction, KronosServiceState } from "@dtc/shared";

const HEALTHY_SUCCESS_RATE = 0.6;
const PREDICT_TIMEOUT_MS = Number.isFinite(Number(process.env.KRONOS_PREDICT_TIMEOUT_MS))
  ? Math.max(1_000, Number(process.env.KRONOS_PREDICT_TIMEOUT_MS))
  : 45_000;
const MAX_RECENT_ATTEMPTS = 20;
// RotaryPositionalEmbedding in the Kronos model has a shared mutable seq_len cache that is
// not thread-safe. Concurrent predictions at different auto-regressive steps corrupt each
// other's rotary cache, producing "tensor a (N) must match tensor b (M)" RuntimeErrors.
// Serialising requests (concurrency=1) eliminates the race until the sidecar is patched.
const KRONOS_CONCURRENCY = 1;
const FORECAST_CACHE_TTL_MS = 10 * 60 * 1000;
// On the real trading path this cache is naturally bounded (fixed ~20-symbol UNIVERSE x a
// handful of timeframes — well under 100 keys). But /api/kronos/test-symbol accepts an arbitrary,
// unvalidated symbol string and writes through this same cache (see debugPredict's cacheKey),
// so repeated calls with distinct real symbols outside the fixed universe could otherwise mint
// permanent entries with no cap. This bound only bites on that abuse path; the normal universe
// never gets close to it.
const MAX_FORECAST_CACHE_ENTRIES = 200;
const LAST_FORECAST_HEALTH_TTL_MS = Number.isFinite(Number(process.env.KRONOS_LAST_FORECAST_HEALTH_TTL_MS))
  ? Math.max(60_000, Number(process.env.KRONOS_LAST_FORECAST_HEALTH_TTL_MS))
  : 30 * 60 * 1000;

// Transient failure codes where a stale cached forecast is acceptable as fallback.
const TRANSIENT_FAILURE_CODES = new Set<KronosAvailabilityReasonCode>(["TIMEOUT", "MODEL_BUSY", "PREDICTION_FAILED"]);

class Semaphore {
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.running += 1;
  }

  async acquireWithTimeout(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return false;
    }
    if (this.running < this.limit) {
      this.running += 1;
      return true;
    }
    let settled = false;
    let granted = false;
    await new Promise<void>((resolve) => {
      let grant: () => void = () => {};
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.queue.indexOf(grant);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        resolve();
      }, timeoutMs);
      grant = () => {
        if (settled) return;
        settled = true;
        granted = true;
        clearTimeout(timeout);
        resolve();
      };
      this.queue.push(grant);
    });
    if (granted) {
      this.running += 1;
      return true;
    }
    return false;
  }

  release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

interface CachedForecast {
  prediction: KronosDebugPrediction;
  expiresAt: number;
}

export interface KronosPredictOptions {
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
  preferStaleOnTimeout?: boolean;
}

export interface KronosAvailability {
  configured: boolean;
  available: boolean;
  message: string;
  state: KronosServiceState;
  reachable: boolean;
  forecastHealthy: boolean;
  degraded: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  timeout: number;
  invalidInput: number;
  predictionFailed: number;
  modelBusy: number;
  successRate: number;
  /** Last few failed attempts with raw error text — surfaces what the sidecar actually said. */
  recentFailures?: KronosRecentFailureSample[];
}

export interface KronosDebugDetails {
  debugSymbol?: string;
  debugTimeframe?: string;
  debugCandleCount?: number;
  debugFirstTimestamp?: number;
  debugLastTimestamp?: number;
  debugLastClose?: number;
  debugRequestShape?: string;
  debugCandleSource?: string;
  debugLast3Closes?: number[];
  debugFailureCode?: KronosAvailabilityReasonCode;
  rawErrorMessage?: string;
  tracebackSummary?: string;
  degradedSampling?: boolean;
}

export interface KronosDebugPrediction extends KronosPrediction, KronosDebugDetails {}

export interface KronosTestSymbolReport {
  symbol: string;
  timeframe: string;
  inputValidation: {
    valid: boolean;
    candleCount: number;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    lastClose: number | null;
    requestShape: string;
    candleSource: string;
    last3Closes: number[];
  };
  modelCall: {
    available: boolean;
    degradedSampling: boolean;
    failureCode: KronosAvailabilityReasonCode | null;
    rawErrorMessage: string | null;
    tracebackSummary: string | null;
  };
  forecastShape: {
    bias: KronosPrediction["selectedKronosBias"] | "UNAVAILABLE";
    bias1h: KronosPrediction["kronosBias1h"] | "UNAVAILABLE";
    bias4h: KronosPrediction["kronosBias4h"] | "UNAVAILABLE";
    probabilityUp: number | null;
    probabilityDown: number | null;
    forecastMedianClose: number | null;
    forecastP25Close: number | null;
    forecastP75Close: number | null;
    forecastMaxHigh: number | null;
    forecastMinLow: number | null;
  };
  derivedDiagnostics: {
    confidence: number | null;
    confidenceBucket: KronosPrediction["kronosConfidenceBucket"] | null;
    expectedReturn1h: number | null;
    expectedReturn4h: number | null;
    risk: number | null;
    horizonConflict: boolean;
  };
}

export interface KronosClient {
  warmUp(): Promise<void>;
  availability(): Promise<KronosAvailability>;
  predict(symbol: string, timeframe: string, candles: Candle[], options?: KronosPredictOptions): Promise<KronosPrediction>;
}

interface KronosHealthResponse {
  ok?: boolean;
  modelConnected?: boolean;
  message?: string;
}

interface KronosPredictResponse {
  available?: boolean;
  reason?: string;
  availabilityReasonCode?: KronosAvailabilityReasonCode;
  longProbability?: number;
  shortProbability?: number;
  confidence?: number;
  expectedReturn?: number;
  expectedReturn3?: number;
  expectedReturn6?: number;
  volatility?: number;
  expectedVolatility?: number;
  risk?: number;
  kronosRisk?: number;
  kronosLongProbability?: number;
  kronosShortProbability?: number;
  kronosConfidence?: number;
  kronosBias?: string;
  kronosBias1h?: string;
  kronosBias4h?: string;
  selectedKronosBias?: string;
  currentPrice?: number;
  forecastMedianClose?: number;
  forecastP25Close?: number;
  forecastP75Close?: number;
  forecastMaxHigh?: number;
  forecastMinLow?: number;
  expectedReturn15m?: number;
  expectedReturn1h?: number;
  expectedReturn4h?: number;
  probabilityUp?: number;
  probabilityDown?: number;
  kronosConfidenceBucket?: string;
  horizonConflict?: boolean;
  degradedSampling?: boolean;
  debugSymbol?: string;
  debugTimeframe?: string;
  debugCandleCount?: number;
  debugFirstTimestamp?: number;
  debugLastTimestamp?: number;
  debugLastClose?: number;
  debugRequestShape?: string;
  debugCandleSource?: string;
  debugLast3Closes?: number[];
  debugFailureCode?: KronosAvailabilityReasonCode;
  rawErrorMessage?: string;
  tracebackSummary?: string;
}

interface KronosAttemptRecord {
  succeeded: boolean;
  code: KronosAvailabilityReasonCode | null;
  recordedAt: number;
  /** Optional debugging metadata captured at attempt time. */
  symbol?: string;
  timeframe?: string;
  rawErrorMessage?: string | null;
}

export interface KronosRecentFailureSample {
  symbol: string | null;
  timeframe: string | null;
  code: KronosAvailabilityReasonCode | null;
  rawErrorMessage: string | null;
  recordedAt: number;
}

/**
 * Kronos sidecars have emitted both probability conventions over time: fractions
 * (0..1) and percentages (0..100). Normalize once at the boundary so every
 * downstream scorer continues to consume the shared 0..100 contract.
 */
function normalizePercentage(value: number): number {
  const scaled = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, scaled));
}

function parseNumeric(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function recentAttemptWindowMs(): number {
  return Number.isFinite(Number(process.env.KRONOS_HEALTH_WINDOW_MS))
    ? Math.max(60_000, Number(process.env.KRONOS_HEALTH_WINDOW_MS))
    : 5 * 60 * 1000;
}

function normalizeBias(value: unknown): KronosPrediction["kronosBias"] | null {
  return value === "LONG" || value === "SHORT" || value === "NEUTRAL" ? value : null;
}

function last3Closes(candles: Candle[]): number[] {
  return candles.slice(-3).map((candle) => candle.close);
}

function validateCandlesForKronos(
  candles: Candle[],
  candleSource = "binance.getCandles",
): {
  valid: boolean;
  reasonCode: KronosAvailabilityReasonCode | null;
  reason: string | null;
  debugLastClose: number | null;
  debugLast3Closes: number[];
  debugRequestShape: string;
  debugCandleSource: string;
} {
  const debugLastClose = candles.at(-1)?.close ?? null;
  const debugLast3 = last3Closes(candles);

  if (candles.length === 0) {
    return {
      valid: false,
      reasonCode: "INVALID_INPUT",
      reason: "Kronos candles are empty.",
      debugLastClose,
      debugLast3Closes: debugLast3,
      debugRequestShape: "0x5",
      debugCandleSource: candleSource,
    };
  }

  const hasInvalidOhlc = candles.some((candle) =>
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    candle.open <= 0 ||
    candle.high <= 0 ||
    candle.low <= 0 ||
    candle.close <= 0,
  );
  if (hasInvalidOhlc) {
    return {
      valid: false,
      reasonCode: "INVALID_INPUT",
      reason: "Kronos candles must have positive OHLC values.",
      debugLastClose,
      debugLast3Closes: debugLast3,
      debugRequestShape: `${candles.length}x5`,
      debugCandleSource: candleSource,
    };
  }

  if (!Number.isFinite(debugLastClose) || (debugLastClose ?? 0) <= 0) {
    return {
      valid: false,
      reasonCode: "INVALID_INPUT",
      reason: "Current close must be positive for Kronos scoring.",
      debugLastClose,
      debugLast3Closes: debugLast3,
      debugRequestShape: `${candles.length}x5`,
      debugCandleSource: candleSource,
    };
  }

  if (candles.every((candle) => candle.close === 0)) {
    return {
      valid: false,
      reasonCode: "INVALID_INPUT",
      reason: "Kronos candles contain all-zero close values, which usually indicates a feed bug.",
      debugLastClose,
      debugLast3Closes: debugLast3,
      debugRequestShape: `${candles.length}x5`,
      debugCandleSource: candleSource,
    };
  }

  if (candles.every((candle) => candle.volume === 0)) {
    return {
      valid: false,
      reasonCode: "INVALID_INPUT",
      reason: "Kronos candles contain all-zero volume, which usually indicates a feed bug.",
      debugLastClose,
      debugLast3Closes: debugLast3,
      debugRequestShape: `${candles.length}x5`,
      debugCandleSource: candleSource,
    };
  }

  return {
    valid: true,
    reasonCode: null,
    reason: null,
    debugLastClose,
    debugLast3Closes: debugLast3,
    debugRequestShape: `${candles.length}x5`,
    debugCandleSource: candleSource,
  };
}

function classifyKronosFailure(
  reason: string | undefined,
  status?: number,
  explicitCode?: KronosAvailabilityReasonCode | null,
): { code: KronosAvailabilityReasonCode; reason: string } {
  if (explicitCode) {
    switch (explicitCode) {
      case "TIMEOUT":
        return { code: "TIMEOUT", reason: "timeout" };
      case "UNSUPPORTED_SYMBOL":
        return { code: "UNSUPPORTED_SYMBOL", reason: "unsupported symbol" };
      case "NOT_ENOUGH_CANDLES":
        return { code: "NOT_ENOUGH_CANDLES", reason: "not enough candles" };
      case "INVALID_INPUT":
        return { code: "INVALID_INPUT", reason: "invalid input" };
      case "MODEL_BUSY":
        return { code: "MODEL_BUSY", reason: "model busy" };
      case "UNAVAILABLE":
        return { code: "UNAVAILABLE", reason: "unavailable" };
      default:
        return { code: "PREDICTION_FAILED", reason: "prediction failed" };
    }
  }

  const text = (reason ?? "").toLowerCase();
  if (status === 429 || status === 503 || text.includes("busy") || text.includes("overload")) {
    return { code: "MODEL_BUSY", reason: "model busy" };
  }
  if (text.includes("timeout") || text.includes("timed out") || text.includes("abort")) {
    return { code: "TIMEOUT", reason: "timeout" };
  }
  if (text.includes("unsupported")) {
    return { code: "UNSUPPORTED_SYMBOL", reason: "unsupported symbol" };
  }
  if (text.includes("at least") || text.includes("not enough candle") || text.includes("insufficient")) {
    return { code: "NOT_ENOUGH_CANDLES", reason: "not enough candles" };
  }
  if (
    text.includes("invalid") ||
    text.includes("nan") ||
    text.includes("duplicate timestamp") ||
    text.includes("positive ohlc") ||
    text.includes("negative volume") ||
    text.includes("aligned to the declared")
  ) {
    return { code: "INVALID_INPUT", reason: "invalid input" };
  }
  if (
    text.includes("not configured") ||
    text.includes("not connected") ||
    text.includes("unavailable") ||
    text.includes("health check failed") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("getaddrinfo")
  ) {
    return { code: "UNAVAILABLE", reason: "unavailable" };
  }
  return { code: "PREDICTION_FAILED", reason: "prediction failed" };
}

function errorMessageWithCause(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  if (isRecord(cause)) {
    const code = typeof cause.code === "string" ? cause.code : null;
    const address = typeof cause.address === "string" ? cause.address : null;
    const port = typeof cause.port === "number" || typeof cause.port === "string" ? String(cause.port) : null;
    const detail = [code, address, port].filter(Boolean).join(" ");
    if (detail) return `${error.message}: ${detail}`;
  }
  return error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeAttempts(attempts: readonly KronosAttemptRecord[]) {
  const summary = {
    attempted: attempts.length,
    succeeded: attempts.filter((attempt) => attempt.succeeded).length,
    failed: attempts.filter((attempt) => !attempt.succeeded).length,
    timeout: 0,
    invalidInput: 0,
    predictionFailed: 0,
    modelBusy: 0,
    successRate: 0,
  };

  for (const attempt of attempts) {
    if (attempt.succeeded) {
      continue;
    }
    switch (attempt.code) {
      case "TIMEOUT":
        summary.timeout += 1;
        break;
      case "INVALID_INPUT":
      case "NOT_ENOUGH_CANDLES":
        summary.invalidInput += 1;
        break;
      case "MODEL_BUSY":
        summary.modelBusy += 1;
        break;
      case "PREDICTION_FAILED":
        summary.predictionFailed += 1;
        break;
      default:
        break;
    }
  }

  summary.successRate = summary.attempted > 0 ? Number((summary.succeeded / summary.attempted).toFixed(4)) : 0;
  return summary;
}

function dominantFailureSummary(stats: ReturnType<typeof summarizeAttempts>): string {
  const failures = [
    ["timeout", stats.timeout],
    ["invalid input", stats.invalidInput],
    ["model busy", stats.modelBusy],
    ["prediction failed", stats.predictionFailed],
  ]
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  return failures.length > 0 ? `, ${failures.map(([label, count]) => `${count} ${label}`).join(", ")}` : "";
}

function clonePublicPrediction(prediction: KronosDebugPrediction): KronosPrediction {
  return {
    available: prediction.available,
    reason: prediction.reason,
    availabilityReasonCode: prediction.availabilityReasonCode,
    degradedSampling: prediction.degradedSampling,
    kronosLongProbability: prediction.kronosLongProbability,
    kronosShortProbability: prediction.kronosShortProbability,
    kronosBias: prediction.kronosBias,
    kronosBias1h: prediction.kronosBias1h,
    kronosBias4h: prediction.kronosBias4h,
    selectedKronosBias: prediction.selectedKronosBias,
    expectedReturn3: prediction.expectedReturn3,
    expectedReturn6: prediction.expectedReturn6,
    expectedVolatility: prediction.expectedVolatility,
    kronosConfidence: prediction.kronosConfidence,
    kronosRisk: prediction.kronosRisk,
    currentPrice: prediction.currentPrice,
    forecastMedianClose: prediction.forecastMedianClose,
    forecastP25Close: prediction.forecastP25Close,
    forecastP75Close: prediction.forecastP75Close,
    forecastMaxHigh: prediction.forecastMaxHigh,
    forecastMinLow: prediction.forecastMinLow,
    expectedReturn15m: prediction.expectedReturn15m,
    expectedReturn1h: prediction.expectedReturn1h,
    expectedReturn4h: prediction.expectedReturn4h,
    probabilityUp: prediction.probabilityUp,
    probabilityDown: prediction.probabilityDown,
    kronosConfidenceBucket: prediction.kronosConfidenceBucket,
    horizonConflict: prediction.horizonConflict,
  };
}

export class HttpKronosClient implements KronosClient {
  private readonly recentAttempts: KronosAttemptRecord[] = [];
  private readonly semaphore = new Semaphore(KRONOS_CONCURRENCY);
  private readonly forecastCache = new Map<string, CachedForecast>();
  private readonly inFlightPredictions = new Map<string, Promise<KronosDebugPrediction>>();
  private lastSuccessfulForecastAt: number | null = null;
  private lastForecastCacheHitAt: number | null = null;

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async warmUp(): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await this.fetchWithTimeout(new URL("/health", this.baseUrl));
    } catch {
      // best-effort
    }
  }

  private recordAttempt(prediction: KronosDebugPrediction): void {
    const now = Date.now();
    if (prediction.available && !(prediction.degradedSampling ?? false)) {
      this.lastSuccessfulForecastAt = now;
    }
    this.recentAttempts.push({
      succeeded: prediction.available,
      code: prediction.available ? null : prediction.availabilityReasonCode ?? "PREDICTION_FAILED",
      recordedAt: now,
      symbol: prediction.debugSymbol,
      timeframe: prediction.debugTimeframe,
      rawErrorMessage: prediction.rawErrorMessage ?? null,
    });
    this.pruneAttempts(now);
  }

  private pruneAttempts(now = Date.now()): void {
    const earliestAllowed = now - recentAttemptWindowMs();
    while (this.recentAttempts.length > 0 && this.recentAttempts[0]!.recordedAt < earliestAllowed) {
      this.recentAttempts.shift();
    }
    if (this.recentAttempts.length > MAX_RECENT_ATTEMPTS) {
      this.recentAttempts.splice(0, this.recentAttempts.length - MAX_RECENT_ATTEMPTS);
    }
  }

  /** Bounds forecastCache — see MAX_FORECAST_CACHE_ENTRIES's comment for why this exists. First
   *  drops anything already TTL-expired, then (only if still over the cap) evicts the
   *  least-recently-written entries first. Real universe symbols get re-set on every scan cycle,
   *  which bumps their expiresAt forward, so they naturally sort to the "keep" side; one-off
   *  symbols from /api/kronos/test-symbol don't get refreshed and sort to the "evict" side. */
  private pruneForecastCache(now: number): void {
    for (const [key, entry] of this.forecastCache) {
      if (entry.expiresAt <= now) {
        this.forecastCache.delete(key);
      }
    }
    if (this.forecastCache.size > MAX_FORECAST_CACHE_ENTRIES) {
      const oldestFirst = [...this.forecastCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const excess = this.forecastCache.size - MAX_FORECAST_CACHE_ENTRIES;
      for (let i = 0; i < excess; i += 1) {
        this.forecastCache.delete(oldestFirst[i]![0]);
      }
    }
  }

  /** Test-only introspection hook (mirrors BinanceClient's _getCacheSizeForTests convention). */
  _getForecastCacheSizeForTests(): number {
    return this.forecastCache.size;
  }

  private buildAvailability(base: {
    configured: boolean;
    reachable: boolean;
    message: string;
  }): KronosAvailability {
    this.pruneAttempts();
    const stats = summarizeAttempts(this.recentAttempts);
    let state: KronosServiceState = "OFFLINE";
    let available = false;
    let forecastHealthy = false;
    let degraded = false;
    let message = base.message;

    if (!base.configured || !base.reachable) {
      state = "OFFLINE";
      message = base.message;
    } else if (stats.attempted === 0) {
      const now = Date.now();
      const lastSuccessAgeMs =
        this.lastSuccessfulForecastAt !== null ? now - this.lastSuccessfulForecastAt : null;
      const lastCacheHitAgeMs =
        this.lastForecastCacheHitAt !== null ? now - this.lastForecastCacheHitAt : null;
      const recentRealForecast = lastSuccessAgeMs !== null && lastSuccessAgeMs <= LAST_FORECAST_HEALTH_TTL_MS;
      const recentCachedForecast = lastCacheHitAgeMs !== null && lastCacheHitAgeMs <= LAST_FORECAST_HEALTH_TTL_MS;
      if (recentRealForecast || recentCachedForecast) {
        state = "FORECAST_HEALTHY";
        available = true;
        forecastHealthy = true;
        const ageSec = Math.round(((recentRealForecast ? lastSuccessAgeMs : lastCacheHitAgeMs) ?? 0) / 1000);
        message = recentRealForecast
          ? `Kronos active; last successful forecast ${ageSec}s ago.`
          : `Kronos active from forecast cache; last cache hit ${ageSec}s ago.`;
      } else {
        state = "REACHABLE";
        message = "Kronos reachable; no recent forecast sample yet.";
      }
    } else {
      // Health = model behavior on calls where the input was valid. Scanner-side
      // input issues (INVALID_INPUT, NOT_ENOUGH_CANDLES — e.g. new listings,
      // tiny history) are not model degradation. Compute a model-only success
      // rate and use that for the DEGRADED decision. Total successRate is still
      // surfaced in the response for transparency.
      const modelAttempts = stats.attempted - stats.invalidInput;
      const modelSuccessRate = modelAttempts > 0 ? stats.succeeded / modelAttempts : 1;
      const modelHealthy = modelAttempts === 0 || modelSuccessRate >= HEALTHY_SUCCESS_RATE;
      if (modelHealthy) {
        state = "FORECAST_HEALTHY";
        available = true;
        forecastHealthy = true;
        const inputSkipped = stats.invalidInput > 0 ? ` | ${stats.invalidInput} skipped on input validation` : "";
        message = `Kronos active (${stats.succeeded}/${modelAttempts} model forecasts succeeded${inputSkipped}).`;
      } else {
        state = "DEGRADED";
        degraded = true;
        message = `Kronos degraded: ${stats.succeeded}/${modelAttempts} model forecasts succeeded${dominantFailureSummary(stats)}`;
      }
    }

    // Surface up to 5 most-recent failures (newest first) so the operator can
    // see exactly what the sidecar said — much faster diagnosis than reading
    // logs. Read-only; no behavior change.
    const recentFailures: KronosRecentFailureSample[] = this.recentAttempts
      .filter((a) => !a.succeeded)
      .slice(-5)
      .reverse()
      .map((a) => ({
        symbol: a.symbol ?? null,
        timeframe: a.timeframe ?? null,
        code: a.code,
        rawErrorMessage: a.rawErrorMessage ?? null,
        recordedAt: a.recordedAt,
      }));

    return {
      configured: base.configured,
      available,
      message,
      state,
      reachable: base.reachable,
      forecastHealthy,
      degraded,
      attempted: stats.attempted,
      succeeded: stats.succeeded,
      failed: stats.failed,
      timeout: stats.timeout,
      invalidInput: stats.invalidInput,
      predictionFailed: stats.predictionFailed,
      modelBusy: stats.modelBusy,
      successRate: stats.successRate,
      recentFailures,
    };
  }

  private async fetchWithTimeout(url: URL, init?: RequestInit, timeoutMs = PREDICT_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async safeParseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private failureResult(
    failure: { code: KronosAvailabilityReasonCode; reason: string },
    debug?: Partial<KronosDebugDetails>,
  ): KronosDebugPrediction {
    return {
      available: false,
      reason: failure.reason,
      availabilityReasonCode: failure.code,
      debugSymbol: debug?.debugSymbol,
      debugTimeframe: debug?.debugTimeframe,
      debugCandleCount: debug?.debugCandleCount,
      debugFirstTimestamp: debug?.debugFirstTimestamp,
      debugLastTimestamp: debug?.debugLastTimestamp,
      debugLastClose: debug?.debugLastClose,
      debugRequestShape: debug?.debugRequestShape,
      debugCandleSource: debug?.debugCandleSource,
      debugLast3Closes: debug?.debugLast3Closes,
      debugFailureCode: debug?.debugFailureCode ?? failure.code,
      rawErrorMessage: debug?.rawErrorMessage,
      tracebackSummary: debug?.tracebackSummary,
      degradedSampling: debug?.degradedSampling,
    };
  }

  private normalizeDebugPrediction(payload: KronosPredictResponse): KronosDebugPrediction {
    const longProbability = parseNumeric(payload.kronosLongProbability ?? payload.longProbability);
    const shortProbability = parseNumeric(payload.kronosShortProbability ?? payload.shortProbability);
    const confidence = parseNumeric(payload.kronosConfidence ?? payload.confidence);
    const expectedReturn3 = parseNumeric(payload.expectedReturn3 ?? payload.expectedReturn);
    const expectedReturn6 = parseNumeric(payload.expectedReturn6);
    const expectedVolatility = parseNumeric(payload.expectedVolatility ?? payload.volatility);
    const risk = parseNumeric(payload.kronosRisk ?? payload.risk);
    const currentPrice = parseNumeric(payload.currentPrice);
    const forecastMedianClose = parseNumeric(payload.forecastMedianClose);
    const forecastP25Close = parseNumeric(payload.forecastP25Close);
    const forecastP75Close = parseNumeric(payload.forecastP75Close);
    const forecastMaxHigh = parseNumeric(payload.forecastMaxHigh);
    const forecastMinLow = parseNumeric(payload.forecastMinLow);
    const expectedReturn15m = parseNumeric(payload.expectedReturn15m);
    const expectedReturn1h = parseNumeric(payload.expectedReturn1h);
    const expectedReturn4h = parseNumeric(payload.expectedReturn4h);
    const probabilityUp = parseNumeric(payload.probabilityUp);
    const probabilityDown = parseNumeric(payload.probabilityDown);
    const bias = normalizeBias(payload.kronosBias);
    const bias1h = normalizeBias(payload.kronosBias1h);
    const bias4h = normalizeBias(payload.kronosBias4h);
    const selectedBias = normalizeBias(payload.selectedKronosBias) ?? bias ?? bias1h ?? bias4h;
    const confidenceBucket =
      payload.kronosConfidenceBucket === "STRONG" ||
      payload.kronosConfidenceBucket === "MEDIUM" ||
      payload.kronosConfidenceBucket === "WEAK"
        ? payload.kronosConfidenceBucket
        : undefined;

    if (payload.available === false) {
      const failure = classifyKronosFailure(payload.reason, undefined, payload.availabilityReasonCode ?? payload.debugFailureCode);
      return this.failureResult(failure, {
        debugSymbol: payload.debugSymbol,
        debugTimeframe: payload.debugTimeframe,
        debugCandleCount: payload.debugCandleCount,
        debugFirstTimestamp: payload.debugFirstTimestamp,
        debugLastTimestamp: payload.debugLastTimestamp,
        debugLastClose: payload.debugLastClose ?? currentPrice ?? undefined,
        debugRequestShape: payload.debugRequestShape,
        debugCandleSource: payload.debugCandleSource,
        debugLast3Closes: payload.debugLast3Closes,
        debugFailureCode: payload.debugFailureCode ?? failure.code,
        rawErrorMessage: payload.rawErrorMessage,
        tracebackSummary: payload.tracebackSummary,
        degradedSampling: payload.degradedSampling,
      });
    }

    const hasRequiredFields =
      longProbability !== null &&
      shortProbability !== null &&
      confidence !== null &&
      expectedVolatility !== null &&
      risk !== null;

    if (!hasRequiredFields) {
      const failure = classifyKronosFailure(payload.reason ?? "Kronos response is missing required numeric fields.");
      return this.failureResult(failure, {
        debugSymbol: payload.debugSymbol,
        debugTimeframe: payload.debugTimeframe,
        debugCandleCount: payload.debugCandleCount,
        debugFirstTimestamp: payload.debugFirstTimestamp,
        debugLastTimestamp: payload.debugLastTimestamp,
        debugLastClose: payload.debugLastClose ?? undefined,
        debugRequestShape: payload.debugRequestShape,
        debugCandleSource: payload.debugCandleSource,
        debugLast3Closes: payload.debugLast3Closes,
        rawErrorMessage: payload.rawErrorMessage ?? "Kronos response is missing required numeric fields.",
        tracebackSummary: payload.tracebackSummary,
      });
    }

    const normalizedLong = normalizePercentage(longProbability);
    const normalizedShort = normalizePercentage(shortProbability);
    const normalizedConfidence = normalizePercentage(confidence);
    const normalizedRisk = normalizePercentage(risk);
    const normalizedBias =
      selectedBias ??
      (payload.kronosBias === "LONG" || payload.kronosBias === "SHORT" || payload.kronosBias === "NEUTRAL"
        ? payload.kronosBias
        : normalizedLong > normalizedShort
          ? "LONG"
          : normalizedShort > normalizedLong
            ? "SHORT"
            : "NEUTRAL");

    return {
      available: true,
      kronosLongProbability: normalizedLong,
      kronosShortProbability: normalizedShort,
      kronosBias: normalizedBias,
      kronosBias1h: bias1h ?? undefined,
      kronosBias4h: bias4h ?? undefined,
      selectedKronosBias: selectedBias ?? normalizedBias,
      expectedReturn3: expectedReturn3 ?? undefined,
      expectedReturn6: expectedReturn6 ?? undefined,
      expectedVolatility: expectedVolatility ?? undefined,
      kronosConfidence: normalizedConfidence,
      kronosRisk: normalizedRisk,
      currentPrice: currentPrice ?? undefined,
      forecastMedianClose: forecastMedianClose ?? undefined,
      forecastP25Close: forecastP25Close ?? undefined,
      forecastP75Close: forecastP75Close ?? undefined,
      forecastMaxHigh: forecastMaxHigh ?? undefined,
      forecastMinLow: forecastMinLow ?? undefined,
      expectedReturn15m: expectedReturn15m ?? undefined,
      expectedReturn1h: expectedReturn1h ?? undefined,
      expectedReturn4h: expectedReturn4h ?? undefined,
      probabilityUp: probabilityUp !== null ? normalizePercentage(probabilityUp) : undefined,
      probabilityDown: probabilityDown !== null ? normalizePercentage(probabilityDown) : undefined,
      kronosConfidenceBucket: confidenceBucket,
      horizonConflict: payload.horizonConflict ?? false,
      debugSymbol: payload.debugSymbol,
      debugTimeframe: payload.debugTimeframe,
      debugCandleCount: payload.debugCandleCount,
      debugFirstTimestamp: payload.debugFirstTimestamp,
      debugLastTimestamp: payload.debugLastTimestamp,
      debugLastClose: payload.debugLastClose ?? undefined,
      debugRequestShape: payload.debugRequestShape,
      debugCandleSource: payload.debugCandleSource,
      debugLast3Closes: payload.debugLast3Closes,
      degradedSampling: payload.degradedSampling,
    };
  }

  async availability(): Promise<KronosAvailability> {
    if (!this.baseUrl) {
      return this.buildAvailability({
        configured: false,
        reachable: false,
        message: "KRONOS_BASE_URL missing from environment",
      });
    }

    try {
      const response = await this.fetchWithTimeout(new URL("/health", this.baseUrl));
      if (!response.ok) {
        return this.buildAvailability({
          configured: true,
          reachable: false,
          message: `Kronos health check failed with ${response.status}.`,
        });
      }

      const payload = (await response.json()) as KronosHealthResponse;
      if (!payload.modelConnected) {
        return this.buildAvailability({
          configured: true,
          reachable: false,
          message: "Kronos adapter is reachable but the real model is not connected.",
        });
      }

      return this.buildAvailability({
        configured: true,
        reachable: true,
        message: payload.message ?? "Kronos model is reachable.",
      });
    } catch (error) {
      const message = errorMessageWithCause(error, "Kronos health check failed.");
      // Add root cause classification
      let rootCause = message;
      if (message.includes("ECONNREFUSED")) {
        rootCause = "Kronos service not running on " + this.baseUrl;
      } else if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
        rootCause = "KRONOS_BASE_URL host unreachable: " + this.baseUrl;
      } else if (message.includes("aborted") || message.includes("timeout")) {
        rootCause = "Kronos service timeout on " + this.baseUrl;
      }
      return this.buildAvailability({
        configured: true,
        reachable: false,
        message: rootCause,
      });
    }
  }

  async debugPredict(
    symbol: string,
    timeframe: string,
    candles: Candle[],
    options: KronosPredictOptions = {},
  ): Promise<KronosDebugPrediction> {
    const validation = validateCandlesForKronos(candles);
    const baseDebug = {
      debugSymbol: symbol,
      debugTimeframe: timeframe,
      debugCandleCount: candles.length,
      debugFirstTimestamp: candles[0]?.openTime,
      debugLastTimestamp: candles.at(-1)?.openTime,
      debugLastClose: validation.debugLastClose ?? undefined,
      debugRequestShape: validation.debugRequestShape,
      debugCandleSource: validation.debugCandleSource,
      debugLast3Closes: validation.debugLast3Closes,
    };
    const cacheKey = `${symbol}:${timeframe}`;
    const now = Date.now();
    const cached = this.forecastCache.get(cacheKey);
    const requestFingerprint = `${cacheKey}:${candles.length}:${candles[0]?.openTime ?? "none"}:${candles.at(-1)?.openTime ?? "none"}:${candles.at(-1)?.close ?? "none"}`;

    if (!validation.valid) {
      const prediction = this.failureResult(
        {
          code: validation.reasonCode ?? "INVALID_INPUT",
          reason: validation.reason ?? "invalid input",
        },
        {
          ...baseDebug,
          rawErrorMessage: validation.reason ?? "Kronos candles failed validation.",
        },
      );
      this.recordAttempt(prediction);
      return prediction;
    }

    if (cached && cached.expiresAt > now) {
      this.lastForecastCacheHitAt = now;
      return cached.prediction;
    }

    const inFlight = this.inFlightPredictions.get(requestFingerprint);
    if (inFlight) {
      return inFlight;
    }

    if (!this.baseUrl) {
      const failure = classifyKronosFailure("KRONOS_BASE_URL is not configured.");
      const prediction = this.failureResult(failure, {
        ...baseDebug,
        rawErrorMessage: "KRONOS_BASE_URL is not configured.",
      });
      this.recordAttempt(prediction);
      return prediction;
    }

    const predictionPromise = (async () => {
      let acquired = false;
      try {
        if (typeof options.queueTimeoutMs === "number") {
          acquired = await this.semaphore.acquireWithTimeout(options.queueTimeoutMs);
          if (!acquired) {
            const failure = classifyKronosFailure("Kronos forecast queue timeout.");
            if (cached && options.preferStaleOnTimeout && TRANSIENT_FAILURE_CODES.has(failure.code)) {
              return {
                ...cached.prediction,
                degradedSampling: true,
                availabilityReasonCode: failure.code,
                debugFailureCode: failure.code,
                rawErrorMessage: "Kronos forecast queue timeout.",
                reason: `stale cached forecast after ${failure.reason}`,
              };
            }
            const prediction = this.failureResult(failure, {
              ...baseDebug,
              rawErrorMessage: "Kronos forecast queue timeout.",
            });
            this.recordAttempt(prediction);
            return prediction;
          }
        } else {
          await this.semaphore.acquire();
          acquired = true;
        }

        const response = await this.fetchWithTimeout(new URL("/predict", this.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            symbol,
            timeframe,
            candles,
          }),
        }, options.requestTimeoutMs);

        const body = await this.safeParseBody(response);
        if (!response.ok) {
          const text = typeof body === "string" ? body : JSON.stringify(body);
          const failure = classifyKronosFailure(text, response.status);
          const prediction = this.failureResult(failure, {
            ...baseDebug,
            rawErrorMessage: text,
          });
          this.recordAttempt(prediction);
          if (cached && TRANSIENT_FAILURE_CODES.has(failure.code)) {
            return { ...cached.prediction, degradedSampling: true, availabilityReasonCode: failure.code, debugFailureCode: failure.code, rawErrorMessage: text, reason: `stale cached forecast after ${failure.reason}` };
          }
          return prediction;
        }

        if (!isRecord(body)) {
          const failure = classifyKronosFailure("Kronos returned a non-object response.");
          const prediction = this.failureResult(failure, {
            ...baseDebug,
            rawErrorMessage: "Kronos returned a non-object response.",
          });
          this.recordAttempt(prediction);
          return prediction;
        }

        const prediction = this.normalizeDebugPrediction(body as KronosPredictResponse);
        this.recordAttempt(prediction);
        if (prediction.available) {
          this.forecastCache.set(cacheKey, { prediction, expiresAt: now + FORECAST_CACHE_TTL_MS });
          this.pruneForecastCache(now);
        }
        return prediction;
      } catch (error) {
        const originalMessage = errorMessageWithCause(error, "Kronos prediction failed.");
        const message = originalMessage.includes("ECONNREFUSED")
          ? `Kronos service not running on ${this.baseUrl}: ${originalMessage}`
          : originalMessage.includes("ENOTFOUND") || originalMessage.includes("getaddrinfo")
            ? `KRONOS_BASE_URL host unreachable ${this.baseUrl}: ${originalMessage}`
            : originalMessage;
        const failure = classifyKronosFailure(message);
        const prediction = this.failureResult(failure, {
          ...baseDebug,
          rawErrorMessage: message,
        });
        this.recordAttempt(prediction);
        if (cached && TRANSIENT_FAILURE_CODES.has(failure.code)) {
          return { ...cached.prediction, degradedSampling: true, availabilityReasonCode: failure.code, debugFailureCode: failure.code, rawErrorMessage: message, reason: `stale cached forecast after ${failure.reason}` };
        }
        return prediction;
      } finally {
        if (acquired) {
          this.semaphore.release();
        }
        this.inFlightPredictions.delete(requestFingerprint);
      }
    })();

    this.inFlightPredictions.set(requestFingerprint, predictionPromise);
    return predictionPromise;
  }

  async predict(
    symbol: string,
    timeframe: string,
    candles: Candle[],
    options: KronosPredictOptions = {},
  ): Promise<KronosPrediction> {
    const prediction = await this.debugPredict(symbol, timeframe, candles, options);
    return clonePublicPrediction(prediction);
  }

  async testSymbol(symbol: string, timeframe: string, candles: Candle[]): Promise<KronosTestSymbolReport> {
    const prediction = await this.debugPredict(symbol, timeframe, candles);
    return {
      symbol,
      timeframe,
      inputValidation: {
        valid: prediction.availabilityReasonCode !== "INVALID_INPUT",
        candleCount: prediction.debugCandleCount ?? candles.length,
        firstTimestamp: prediction.debugFirstTimestamp ?? candles[0]?.openTime ?? null,
        lastTimestamp: prediction.debugLastTimestamp ?? candles.at(-1)?.openTime ?? null,
        lastClose: prediction.debugLastClose ?? candles.at(-1)?.close ?? null,
        requestShape: prediction.debugRequestShape ?? `${candles.length}x5`,
        candleSource: prediction.debugCandleSource ?? "binance.getCandles",
        last3Closes: prediction.debugLast3Closes ?? last3Closes(candles),
      },
      modelCall: {
        available: prediction.available && !(prediction.degradedSampling ?? false),
        degradedSampling: prediction.degradedSampling ?? false,
        failureCode: prediction.available && !(prediction.degradedSampling ?? false) ? null : prediction.availabilityReasonCode ?? null,
        rawErrorMessage: prediction.rawErrorMessage ?? null,
        tracebackSummary: prediction.tracebackSummary ?? null,
      },
      forecastShape: {
        bias: prediction.available ? prediction.selectedKronosBias ?? prediction.kronosBias ?? "NEUTRAL" : "UNAVAILABLE",
        bias1h: prediction.available ? prediction.kronosBias1h ?? "NEUTRAL" : "UNAVAILABLE",
        bias4h: prediction.available ? prediction.kronosBias4h ?? "NEUTRAL" : "UNAVAILABLE",
        probabilityUp: prediction.probabilityUp ?? null,
        probabilityDown: prediction.probabilityDown ?? null,
        forecastMedianClose: prediction.forecastMedianClose ?? null,
        forecastP25Close: prediction.forecastP25Close ?? null,
        forecastP75Close: prediction.forecastP75Close ?? null,
        forecastMaxHigh: prediction.forecastMaxHigh ?? null,
        forecastMinLow: prediction.forecastMinLow ?? null,
      },
      derivedDiagnostics: {
        confidence: prediction.kronosConfidence ?? null,
        confidenceBucket: prediction.kronosConfidenceBucket ?? null,
        expectedReturn1h: prediction.expectedReturn1h ?? null,
        expectedReturn4h: prediction.expectedReturn4h ?? null,
        risk: prediction.kronosRisk ?? null,
        horizonConflict: prediction.horizonConflict ?? false,
      },
    };
  }
}

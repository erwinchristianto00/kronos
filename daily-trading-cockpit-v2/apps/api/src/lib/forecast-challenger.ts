/**
 * Forecast challenger client.
 *
 * Chronos-2 and TimesFM live in a separate Python sidecar so their heavyweight
 * dependencies and model memory cannot block the Node/CORTEX event loop. This
 * client is deliberately advisory-only: an unavailable, stale, busy, or failed
 * model returns no opinion; it can never manufacture a neutral/zero signal.
 */
import type { Candle } from "@dtc/shared";

export type ForecastChallengerId = "chronos2" | "timesfm";
export type ForecastChallengerBias = "LONG" | "SHORT" | "NEUTRAL";

export interface ForecastChallengerPrediction {
  available: boolean;
  model: ForecastChallengerId;
  bias: ForecastChallengerBias | null;
  confidence: number | null; // 0..100
  expectedReturn: number | null; // decimal return, e.g. 0.01 = 1%
  volatility: number | null;
  probabilityUp: number | null; // 0..100
  probabilityDown: number | null; // 0..100
  generatedAtMs: number | null;
  reason: string | null;
}

interface ChallengerHealthResponse {
  ok?: boolean;
  models?: Record<string, { connected?: boolean; message?: string }>;
}

interface ChallengerPredictResponse {
  available?: unknown;
  model?: unknown;
  bias?: unknown;
  confidence?: unknown;
  expectedReturn?: unknown;
  volatility?: unknown;
  probabilityUp?: unknown;
  probabilityDown?: unknown;
  generatedAtMs?: unknown;
  reason?: unknown;
}

const DEFAULT_TIMEOUT_MS = 50_000;

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: unknown): number | null {
  const n = finite(value);
  if (n === null) return null;
  const normalized = Math.abs(n) <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, normalized));
}

function bias(value: unknown): ForecastChallengerBias | null {
  return value === "LONG" || value === "SHORT" || value === "NEUTRAL" ? value : null;
}

function unavailable(model: ForecastChallengerId, reason: string): ForecastChallengerPrediction {
  return {
    available: false,
    model,
    bias: null,
    confidence: null,
    expectedReturn: null,
    volatility: null,
    probabilityUp: null,
    probabilityDown: null,
    generatedAtMs: null,
    reason,
  };
}

/** A signed, confidence-scaled opinion for Direction Brain. Null means unavailable, never neutral. */
export function challengerAgree(prediction: ForecastChallengerPrediction): number | null {
  if (!prediction.available || prediction.bias === null || prediction.bias === "NEUTRAL") return null;
  if (prediction.confidence === null || !(prediction.confidence > 0)) return null;
  const magnitude = Math.max(0, Math.min(1, prediction.confidence / 100));
  return prediction.bias === "LONG" ? magnitude : -magnitude;
}

export class HttpForecastChallengerClient {
  constructor(
    private readonly baseUrl: string | undefined,
    readonly model: ForecastChallengerId,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = Math.max(5_000, Number(process.env.CHALLENGER_PREDICT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  ) {}

  configured(): boolean {
    return Boolean(this.baseUrl);
  }

  async availability(): Promise<{ configured: boolean; reachable: boolean; connected: boolean; message: string }> {
    if (!this.baseUrl) return { configured: false, reachable: false, connected: false, message: "challenger sidecar not configured" };
    try {
      const response = await this.fetchWithTimeout(new URL("/health", this.baseUrl));
      if (!response.ok) return { configured: true, reachable: false, connected: false, message: `health HTTP ${response.status}` };
      const body = (await response.json()) as ChallengerHealthResponse;
      const status = body.models?.[this.model];
      return {
        configured: true,
        reachable: true,
        connected: status?.connected === true,
        message: typeof status?.message === "string" ? status.message : "challenger sidecar reachable",
      };
    } catch (error) {
      return { configured: true, reachable: false, connected: false, message: error instanceof Error ? error.message : "health request failed" };
    }
  }

  async predict(symbol: string, timeframe: string, candles: Candle[]): Promise<ForecastChallengerPrediction> {
    if (!this.baseUrl) return unavailable(this.model, "challenger sidecar not configured");
    if (!Array.isArray(candles) || candles.length < 32) return unavailable(this.model, "at least 32 candles required");
    try {
      const response = await this.fetchWithTimeout(new URL(`/${this.model}/predict`, this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, candles }),
      });
      const body = (await response.json().catch(() => ({}))) as ChallengerPredictResponse;
      if (!response.ok || body.available !== true) {
        return unavailable(this.model, typeof body.reason === "string" ? body.reason : `prediction HTTP ${response.status}`);
      }
      const parsedBias = bias(body.bias);
      const confidence = percent(body.confidence);
      const generatedAtMs = finite(body.generatedAtMs);
      if (parsedBias === null || confidence === null || generatedAtMs === null) {
        return unavailable(this.model, "sidecar returned incomplete prediction");
      }
      return {
        available: true,
        model: this.model,
        bias: parsedBias,
        confidence,
        expectedReturn: finite(body.expectedReturn),
        volatility: finite(body.volatility),
        probabilityUp: percent(body.probabilityUp),
        probabilityDown: percent(body.probabilityDown),
        generatedAtMs,
        reason: typeof body.reason === "string" ? body.reason : null,
      };
    } catch (error) {
      return unavailable(this.model, error instanceof Error ? error.message : "prediction request failed");
    }
  }

  private async fetchWithTimeout(url: URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

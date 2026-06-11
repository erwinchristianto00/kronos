import type { Candle } from "@dtc/shared";
import type { FastifyInstance } from "fastify";

import { BinanceClient, BinanceRequestError } from "../lib/binance.js";
import { HttpKronosClient } from "../lib/kronos.js";

interface KronosTestBody {
  symbol?: string;
  timeframe?: "5m" | "15m" | "1h";
}

function invalidRequestShape(symbol: string, timeframe: string, rawErrorMessage: string) {
  return {
    symbol,
    timeframe,
    inputValidation: {
      valid: false,
      candleCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      lastClose: null,
      requestShape: "0x0",
      candleSource: "binance.getCandles",
      last3Closes: [],
    },
    modelCall: {
      available: false,
      degradedSampling: false,
      failureCode: "INVALID_INPUT" as const,
      rawErrorMessage,
      tracebackSummary: null,
    },
    forecastShape: {
      bias: "UNAVAILABLE" as const,
      bias1h: "UNAVAILABLE" as const,
      bias4h: "UNAVAILABLE" as const,
      probabilityUp: null,
      probabilityDown: null,
      forecastMedianClose: null,
      forecastP25Close: null,
      forecastP75Close: null,
      forecastMaxHigh: null,
      forecastMinLow: null,
    },
    derivedDiagnostics: {
      confidence: null,
      confidenceBucket: null,
      expectedReturn1h: null,
      expectedReturn4h: null,
      risk: null,
      horizonConflict: false,
    },
  };
}

async function loadKronosCandles(
  binanceClient: BinanceClient,
  symbol: string,
  timeframe: "5m" | "15m" | "1h",
): Promise<Candle[]> {
  return binanceClient.getCandles(symbol, timeframe, 150);
}

async function testOneSymbol(
  kronosClient: HttpKronosClient,
  binanceClient: BinanceClient,
  symbol: string,
  timeframe: "5m" | "15m" | "1h",
) {
  try {
    const candles: Candle[] = await loadKronosCandles(binanceClient, symbol, timeframe);
    return await kronosClient.testSymbol(symbol, timeframe, candles);
  } catch (error) {
    const message =
      error instanceof BinanceRequestError
        ? `${error.failureType}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unable to fetch Binance candles for Kronos test.";
    return invalidRequestShape(symbol, timeframe, message);
  }
}

export async function registerKronosRoutes(
  app: FastifyInstance,
  kronosClient: HttpKronosClient,
  binanceClient: BinanceClient,
): Promise<void> {
  app.get("/api/kronos/health", async () => {
    return kronosClient.availability();
  });

  app.post<{ Body: KronosTestBody }>("/api/kronos/test-symbol", async (request) => {
    const requestedSymbol = request.body?.symbol?.trim() || "BTCUSDT";
    const timeframe = request.body?.timeframe ?? "1h";
    const [baseline, requested] = await Promise.all([
      testOneSymbol(kronosClient, binanceClient, "BTCUSDT", timeframe),
      testOneSymbol(kronosClient, binanceClient, requestedSymbol, timeframe),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      service: await kronosClient.availability(),
      baseline,
      requested,
    };
  });
}

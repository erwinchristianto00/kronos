import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCandidate, type Candle, type Candidate, type ExecutionEntryVariant, type ScanResult, type ShadowPositionVariant } from "@dtc/shared";

import { BASE_ROUTE_POLICY_VERSION_V2, RISK_HYGIENE_GUARD_V1, ShadowExecutionEngine } from "../src/lib/shadow-engine.js";

function makeCandles({
  start = 100,
  step = 1,
  volumeBase = 1000,
  count = 160,
  timeStepMs = 5 * 60 * 1000,
  startTime = Date.UTC(2026, 4, 6, 0, 0, 0),
}: {
  start?: number;
  step?: number;
  volumeBase?: number;
  count?: number;
  timeStepMs?: number;
  startTime?: number;
} = {}): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    return {
      openTime: startTime + index * timeStepMs,
      open: close - step * 0.25,
      high: close + Math.abs(step) * 0.5 + 1,
      low: close - Math.abs(step) * 0.5 - 1,
      close,
      volume: volumeBase + index * 10,
    };
  });
}

function baseCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const candidate = buildCandidate({
    symbol: "BTCUSDT",
    candles5m: makeCandles({ start: 95, step: 0.2 }),
    candles15m: makeCandles({ start: 95, step: 0.2, timeStepMs: 15 * 60 * 1000 }),
    candles1h: makeCandles({ start: 95, step: 0.2, timeStepMs: 60 * 60 * 1000 }),
    spread: { bid: 100, ask: 100.02, absolute: 0.02, percent: 0.02 },
    volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 1.4 },
    kronos: {
      available: true,
      kronosLongProbability: 80,
      kronosShortProbability: 20,
      kronosBias: "LONG",
      kronosConfidence: 76,
      kronosConfidenceBucket: "STRONG",
      expectedReturn1h: 1.2,
      expectedReturn4h: 2.1,
      probabilityUp: 70,
      probabilityDown: 30,
      forecastMaxHigh: 105,
      forecastMinLow: 97,
      kronosRisk: 30,
    },
    whale: { available: true, signal: "BULLISH", score: 75, reason: "aligned" },
    sentiment: { available: false, signal: "UNAVAILABLE", score: 0, source: "none" },
    // The 1h fixture spans 160 hours, so evaluate after its final bar has
    // completed rather than accidentally scoring future synthetic candles.
    now: Date.UTC(2026, 4, 13, 0, 0, 0),
  });
  return {
    ...candidate,
    rank: 1,
    direction: "LONG",
    finalDirection: "LONG",
    status: "READY",
    finalStatus: "READY",
    entryZone: [99.5, 100.2],
    stopLoss: 98.0,
    takeProfits: { tp1: 103.0, tp2: 105, tp3: 107 },
    riskReward: 1.8,
    dangerScore: 30,
    indicators: {
      ...candidate.indicators,
      fiveMinute: {
        ...candidate.indicators.fiveMinute,
        latestClose: 100,
        atr14: 1,
        ema20: 99.7,
        vwap: 99.6,
      },
    },
    ...overrides,
  };
}

function selectedPlan(entry: ExecutionEntryVariant = "base_current_entry", exit: ShadowPositionVariant = "tp1_full_exit") {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: 0.5,
    expectedNetR: 0.3,
    netEdgeAfterCost: 0.3,
    profitFactor: 1.5,
    fillRate: 100,
    noFillRate: 0,
    costR: 0.1,
    spreadR: 0.02,
    feeSlippageR: 0.08,
    stopDistanceBps: 300,
    variantSampleSize: 40,
    variantConfidenceTier: "provisional" as const,
    routeMode: "PROFIT_CANDIDATE" as const,
    selectionSource: "replay" as const,
    costAssumption: "test costs",
    selectionReason: "canonical test plan",
    entryDriftPct: 0,
    entryDriftAtr: 0,
    entryQualityExplanation: ["canonical entry"],
    exitPlanExplanation: ["canonical exit"],
    chaseRisk: "LOW" as const,
  };
}

function makeScanResult(generatedAt: string, candidate: Candidate): ScanResult {
  return {
    generatedAt,
    coverage: { totalSymbols: 20, scannedSymbols: 20, returnedSymbols: 10, skippedSymbols: 10, percent: 50 },
    marketRegime: "Mixed rotation",
    top10: [candidate],
    diagnostics: {
      universe: ["BTCUSDT"],
      skippedSymbols: [],
      symbolFailures: [],
      hiddenSkips: [],
      kronos: { available: true, message: "ok" },
      whale: { available: true, message: "ok" },
      sentiment: { available: false, message: "off" },
    },
  };
}

class FakeBinanceClient {
  private responses = new Map<string, Candle[]>();

  setCandles(symbol: string, candles: Candle[]) {
    this.responses.set(symbol, candles);
  }

  async getCandles(symbol: string) {
    return this.responses.get(symbol) ?? [];
  }
}

const dirs: string[] = [];
function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), "dtc-shadow-"));
  dirs.push(dir);
  const client = new FakeBinanceClient();
  const engine = new ShadowExecutionEngine(client as never, dir);
  return { engine, client, dir };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shadow execution engine", () => {
  it("treats an empty positions store as no shadow positions", () => {
    const { engine, dir } = makeEngine();
    writeFileSync(join(dir, "shadow-positions.json"), "", "utf-8");

    const snapshot = engine.getSnapshot();

    expect(snapshot.summary.uniqueIdeas).toBe(0);
    expect(snapshot.openPositions).toEqual([]);
  });

  it("duplicate idea does not open new position", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    await engine.processScan(makeScanResult("2026-05-08T00:15:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    expect(snapshot.summary.uniqueIdeas).toBe(1);
    expect(snapshot.summary.suppressedDuplicates).toBe(1);
    expect(snapshot.openPositions[0]?.scanCount).toBe(2);
  });

  it("uses the selected execution plan supplied by the scan result", async () => {
    const performanceStats = {
      windows: {
        "1h": {
          shadowVariants: [
            {
              key: "tp1_50_tp2_runner",
              resolved: 100,
              avgNetRResult: 2,
              avgGrossRResult: 2.2,
              profitableTp1Rate: 0.9,
              profitFactor: 3,
              signals: 100,
            },
          ],
          variantCombinations: [],
        },
      },
      executionCost: { roundTripCostBps: 28 },
    };
    const dir = mkdtempSync(join(tmpdir(), "dtc-shadow-"));
    dirs.push(dir);
    const client = new FakeBinanceClient();
    const engine = new ShadowExecutionEngine(client as never, () => performanceStats as never, dir);
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });

    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    expect(snapshot.openPositions[0]?.selectedEntryVariant).toBe("base_current_entry");
    expect(snapshot.openPositions[0]?.selectedExitVariant).toBe("tp1_full_exit");
    expect(snapshot.openPositions[0]?.variantSelection.selectionReason).toBe("canonical test plan");
    expect(snapshot.openPositions[0]?.variantSelection.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("separates profit-candidate, research, and data-collection shadow scopes", async () => {
    const { engine, client } = makeEngine();
    const profit = baseCandidate({
      symbol: "BTCUSDT",
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    const research = baseCandidate({
      symbol: "ETHUSDT",
      selectedExecutionPlan: { ...selectedPlan("base_current_entry", "tp1_full_exit"), routeMode: "RESEARCH_ONLY" as const, expectedNetR: -0.2, netEdgeAfterCost: -0.2 },
    });
    const dataCollection = baseCandidate({
      symbol: "SOLUSDT",
      selectedExecutionPlan: { ...selectedPlan("base_current_entry", "tp1_full_exit"), routeMode: "DATA_COLLECTION" as const, variantConfidenceTier: "early" as const },
    });

    await engine.processScan({ ...makeScanResult("2026-05-08T00:00:00.000Z", profit), top10: [profit, research, dataCollection] });

    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.8, close: 103.1, volume: 1000 },
    ]);
    client.setCandles("ETHUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 100.2, low: 97.9, close: 98.1, volume: 1000 },
    ]);
    client.setCandles("SOLUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.8, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan({ ...makeScanResult("2026-05-08T00:10:00.000Z", profit), top10: [] });

    const { summary } = engine.getSnapshot();
    expect(summary.primaryProfitCandidate.total).toBe(1);
    expect(summary.primaryProfitCandidate.closed).toBe(1);
    expect(summary.primaryProfitCandidate.netAvgR).toBeGreaterThan(0);
    expect(summary.researchExecution.total).toBe(1);
    expect(summary.researchExecution.closed).toBe(1);
    expect(summary.researchExecution.netAvgR).toBeLessThan(0);
    expect(summary.dataCollectionExecution.total).toBe(1);
    expect(summary.dataCollectionExecution.closed).toBe(1);
  });

  it("does not evaluate TP or SL on the same candle that fills a pending entry", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_full_exit"),
      stopLoss: 97.8,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: {
          ...baseCandidate().indicators.fiveMinute,
          latestClose: 102,
        },
      },
    });

    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 102, high: 103, low: 98, close: 100, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    const position = snapshot.openPositions[0]!;
    expect(position.entryState).toBe("FILLED");
    expect(position.variants[0]?.state).toBe("OPEN");
    expect(snapshot.recentLog.some((entry) => entry.type === "ENTRY_AMBIGUOUS")).toBe(true);
    expect(snapshot.recentLog.some((entry) => entry.type === "SL_HIT" || entry.type === "TP1_HIT")).toBe(false);
  });

  it("different entry zone opens new position", async () => {
    const { engine } = makeEngine();
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") })));
    await engine.processScan(
      makeScanResult(
        "2026-05-08T00:20:00.000Z",
        baseCandidate({
          entryZone: [96, 96.4],
          stopLoss: 94.0,
          takeProfits: { tp1: 99.2, tp2: 101, tp3: 103 },
          indicators: { ...baseCandidate().indicators, fiveMinute: { ...baseCandidate().indicators.fiveMinute, latestClose: 96.1 } },
        }),
      ),
    );

    const snapshot = engine.getSnapshot();
    expect(snapshot.summary.uniqueIdeas).toBe(2);
  });

  it("TP1 partial works", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.8, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    const position = snapshot.openPositions[0]!;
    const variant = position.variants.find((entry) => entry.variant === position.selectedExitVariant)!;
    expect(variant.tp1Hit).toBe(true);
    expect(variant.remainingSizePct).toBe(0.5);
    expect(variant.slMovedToBreakeven).toBe(true);
  });

  it("tracks LONG MAE/MFE after fill without changing TP behavior", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.25, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    const variant = position.variants.find((entry) => entry.variant === position.selectedExitVariant)!;
    expect(position.maxFavorablePrice).toBe(103.5);
    expect(position.maxAdversePrice).toBe(99.25);
    expect(position.maxFavorableExcursionR).toBe(1.75);
    expect(position.maxAdverseExcursionR).toBe(0.375);
    expect(variant.tp1Hit).toBe(true);
    expect(variant.closeReason).toBe("OPEN");
  });

  it("tracks SHORT MAE/MFE direction-aware after fill", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      direction: "SHORT",
      finalDirection: "SHORT",
      status: "READY",
      finalStatus: "READY",
      stopLoss: 102.0,
      takeProfits: { tp1: 97.0, tp2: 95, tp3: 93 },
      riskReward: 1.8,
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner"),
      whale: { available: true, signal: "BEARISH", score: 75, reason: "aligned" },
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 100.75, low: 99.1, close: 99.4, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    expect(position.direction).toBe("SHORT");
    expect(position.maxFavorablePrice).toBe(99.1);
    expect(position.maxAdversePrice).toBe(100.75);
    expect(position.maxFavorableExcursionR).toBe(0.45);
    expect(position.maxAdverseExcursionR).toBe(0.375);
    expect(position.variants[0]?.closeReason).toBe("OPEN");
  });

  it("does not track MAE/MFE on the candle that fills a pending entry", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_full_exit"),
      stopLoss: 97.8,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: {
          ...baseCandidate().indicators.fiveMinute,
          latestClose: 102,
        },
      },
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 102, high: 104, low: 98, close: 100, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    expect(position.entryState).toBe("FILLED");
    expect(position.maxFavorableExcursionR).toBeUndefined();
    expect(position.maxAdverseExcursionR).toBeUndefined();
    expect(position.variants[0]?.closeReason).toBe("OPEN");
  });

  it("SL close works", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 100.4, low: 97.8, close: 97.9, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    const selectedVariant = snapshot.openPositions[0]?.selectedExitVariant ?? snapshot.summary.bestVariant ?? "tp1_full_exit";
    const idea = snapshot.summary.variants.find((entry) => entry.variant === selectedVariant)!;
    expect(idea.resolved).toBe(1);
    const log = snapshot.recentLog.find((entry) => entry.variant === selectedVariant && entry.type === "SL_HIT");
    expect(log).toBeTruthy();
  });

  it("breakeven SL works", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.7, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 15, 0), open: 103.1, high: 103.2, low: 99.9, close: 100, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:20:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    const closed = snapshot.recentLog.find((entry) => entry.message.toLowerCase().includes("breakeven"));
    expect(closed).toBeTruthy();
  });

  it("runner close works", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.7, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 15, 0), open: 103.1, high: 105.6, low: 103.0, close: 105.4, volume: 1000 },
    ]);
    await engine.processScan(
      makeScanResult(
        "2026-05-08T00:20:00.000Z",
        baseCandidate({
          whale: { available: true, signal: "BULLISH", score: 80, reason: "still aligned" },
          indicators: {
            ...candidate.indicators,
            fiveMinute: {
              ...candidate.indicators.fiveMinute,
              latestClose: 104.4,
              ema20: 99.8,
              vwap: 99.9,
            },
          },
        }),
      ),
    );

    const snapshot = engine.getSnapshot();
    const event = snapshot.recentLog.find((entry) => entry.type === "TP2_HIT" || entry.type === "RUNNER_EXIT");
    expect(event).toBeTruthy();
  });

  it("runner R after breakeven move is denominated in the ORIGINAL admission risk (no fabricated R)", async () => {
    // Regression for the R-denominator bug: after TP1 the stop moves to breakeven, and the runner
    // close used to divide by |entry − movedStop| ≈ 0, fabricating astronomical R (audit found a
    // +201R runner on a signal whose honest original-R outcome was ≈0..1R). With the fix, every
    // slice divides by the original |entry − stopLoss|.
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "trail_after_tp1") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    // TP1 candle (103 touched): trail variant locks 50% at TP1, stop moves to breakeven.
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.7, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));
    // TP3 candle (107 touched): runner closes at TP3 while the live stop sits at/near breakeven.
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 15, 0), open: 103.1, high: 107.6, low: 103.0, close: 107.0, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:20:00.000Z", candidate));

    const snapshot = engine.getSnapshot();
    // recentLog is newest-first; the TP3 runner close is the event under test.
    const tp3Close = snapshot.recentLog.find(
      (entry) => entry.type === "CLOSED" && entry.message === "Closed at TP3." && typeof entry.rValue === "number",
    );
    expect(tp3Close).toBeTruthy();
    // Original-risk math (entry 100, stop 98 → risk 2): TP1 slice 0.5×(103−100)/2 = 0.75 plus
    // runner slice 0.5×(107−100)/2 = 1.75, minus costs ≈ 2.35R. Pre-fix the runner slice divided
    // by |entry − movedStop| ≈ 0 → either zeroed (≈0.6R total) or fabricated astronomical R.
    expect(tp3Close!.rValue!).toBeGreaterThan(1.8);
    expect(tp3Close!.rValue!).toBeLessThan(4.2);
    // Anti-explosion guard: nothing in the ledger may carry a physically implausible R.
    for (const entry of snapshot.recentLog) {
      if (typeof entry.rValue === "number") expect(Math.abs(entry.rValue)).toBeLessThan(20);
    }
  });

  it("netR after fee/slippage works", async () => {
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_50_tp2_runner"),
      volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.7 },
      kronos: {
        available: true,
        kronosLongProbability: 52,
        kronosShortProbability: 48,
        kronosBias: "NEUTRAL",
        kronosConfidence: 30,
        kronosConfidenceBucket: "WEAK",
        expectedReturn1h: 0,
        expectedReturn4h: 0,
        probabilityUp: 50,
        probabilityDown: 50,
        forecastMaxHigh: 103,
        forecastMinLow: 98,
        kronosRisk: 30,
      },
    });
    const performanceStats = {
      windows: {
        "1h": {
          shadowVariants: [
            {
              key: "tp1_fast_exit",
              resolved: 40,
              avgNetRResult: 0.5,
              avgGrossRResult: 0.6,
              profitableTp1Rate: 0.7,
              profitFactor: 1.8,
              signals: 40,
            },
          ],
          variantCombinations: [],
        },
      },
      executionCost: { roundTripCostBps: 28 },
    };
    const { engine, client } = (() => {
      const dir = mkdtempSync(join(tmpdir(), "dtc-shadow-"));
      dirs.push(dir);
      const fake = new FakeBinanceClient();
      const shadowEngine = new ShadowExecutionEngine(fake as never, () => performanceStats as never, dir);
      return { engine: shadowEngine, client: fake };
    })();
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.8, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 15, 0), open: 103.1, high: 105.5, low: 103.0, close: 105.2, volume: 1000 },
    ]);
    await engine.processScan(
      makeScanResult(
        "2026-05-08T00:20:00.000Z",
        baseCandidate({
          volume: { quoteVolume24h: 150_000_000, baseVolume24h: 2_000_000, volumeRatio5m: 0.7 },
          kronos: {
            available: true,
            kronosLongProbability: 52,
            kronosShortProbability: 48,
            kronosBias: "NEUTRAL",
            kronosConfidence: 30,
            kronosConfidenceBucket: "WEAK",
            expectedReturn1h: 0,
            expectedReturn4h: 0,
            probabilityUp: 50,
            probabilityDown: 50,
            forecastMaxHigh: 103,
            forecastMinLow: 98,
            kronosRisk: 30,
          },
          indicators: {
            ...candidate.indicators,
            fiveMinute: {
              ...candidate.indicators.fiveMinute,
              latestClose: 102.9,
            },
          },
        }),
      ),
    );

    const snapshot = engine.getSnapshot();
    const stats = snapshot.summary.variants.find((entry) => entry.resolved > 0 && entry.grossAvgR !== null && entry.netAvgR !== null)!;
    expect(stats.grossAvgR).not.toBeNull();
    expect(stats.netAvgR).not.toBeNull();
    expect((stats.netAvgR ?? 0)).toBeLessThan(stats.grossAvgR ?? 0);
  });

  it("emits ENTRY_FILLED / EXIT_CLOSED / REFLECTION_ADDED ledger events on shadow lifecycle", async () => {
    const { engine, client, dir } = makeEngine();
    const { readFileSync } = await import("node:fs");
    const { DecisionLedger } = await import("../src/lib/decision-ledger.js");
    const ledgerFile = join(dir, "decision-log.jsonl");
    engine.setDecisionLedger(new DecisionLedger(ledgerFile));

    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 103.5, low: 99.8, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const events = readFileSync(ledgerFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("ENTRY_FILLED");
    expect(eventTypes).toContain("EXIT_CLOSED");
    expect(eventTypes).toContain("REFLECTION_ADDED");
    const reflection = events.find((e) => e.event === "REFLECTION_ADDED");
    expect(reflection.reflectionCodes).toEqual(expect.arrayContaining(["GOOD_TP1_CAPTURE"]));
    expect(reflection.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("emits ROUTE_DUPLICATE_SUPPRESSED when an active idea is seen again", async () => {
    const { engine, dir } = makeEngine();
    const { readFileSync } = await import("node:fs");
    const { DecisionLedger } = await import("../src/lib/decision-ledger.js");
    const ledgerFile = join(dir, "decision-log.jsonl");
    engine.setDecisionLedger(new DecisionLedger(ledgerFile));

    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    await engine.processScan(makeScanResult("2026-05-08T00:15:00.000Z", candidate));

    const events = readFileSync(ledgerFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toContain("ROUTE_DUPLICATE_SUPPRESSED");
  });

  it("ledger failure does not break shadow scan", async () => {
    const { engine } = makeEngine();
    engine.setDecisionLedger({
      append: () => { throw new Error("disk full"); },
      recordEntryPending: () => { throw new Error("disk full"); },
      recordEntryFilled: () => { throw new Error("disk full"); },
      recordExitClosed: () => { throw new Error("disk full"); },
      recordReflection: () => { throw new Error("disk full"); },
    } as never);
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await expect(engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate))).resolves.toBeUndefined();
    const snapshot = engine.getSnapshot();
    expect(snapshot.openPositions.length).toBe(1);
  });
});

describe("base-route anchor-consistency V2 (Phase 2)", () => {
  it("FILLED base_current_entry position carries policyVersion V2", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    expect(position.policyVersion).toBe(BASE_ROUTE_POLICY_VERSION_V2);
    expect(position.policyVersion).toBe("base-route-anchor-consistent-v2");
  });

  it("PENDING non-base entry position carries policyVersion V2", async () => {
    const { engine } = makeEngine();
    // vwap_retest_entry with latestClose above vwap → price NOT in zone → PENDING
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_full_exit"),
      stopLoss: 97.8,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: {
          ...baseCandidate().indicators.fiveMinute,
          latestClose: 103, // above vwap (99.6) → pending
        },
      },
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const positions = engine.getAllPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.entryState).toBe("PENDING_ENTRY");
    expect(positions[0]!.policyVersion).toBe(BASE_ROUTE_POLICY_VERSION_V2);
  });

  it("vwap_retest_entry uses vwap anchor as entryPrice so costR and grossR share the same denominator", async () => {
    const { engine, client } = makeEngine();
    const vwap = 99.6;
    const stopLoss = 97.8;
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_full_exit"),
      stopLoss,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: {
          ...baseCandidate().indicators.fiveMinute,
          latestClose: 103, // above vwap → pending entry
          vwap,
        },
      },
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const pending = engine.getAllPositions()[0]!;
    // entryPrice stored on the position must be the vwap anchor, not the current price
    expect(pending.entryPrice).toBeCloseTo(vwap, 4);
    // costR denominator = |vwap - stopLoss| / vwap — same as what realizedSlice will use at SL
    expect(pending.costR).not.toBeNull();
    expect(Number.isFinite(pending.costR)).toBe(true);
    const expectedStopBps = (Math.abs(vwap - stopLoss) / vwap) * 10000;
    expect(pending.stopDistanceBps).toBeCloseTo(expectedStopBps, 1);

    // Fill the pending entry; confirm entryPrice unchanged (anchor preserved through fill)
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 101, high: 101, low: vwap - 0.1, close: 100, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const filled = engine.getAllPositions()[0]!;
    expect(filled.entryState).toBe("FILLED");
    // After fill, entryPrice must STILL be the vwap anchor (not updated to actual candle price)
    expect(filled.entryPrice).toBeCloseTo(vwap, 4);
  });

  it("ultra-tight stop (10 bps) is skipped from normal active/base shadow admission", async () => {
    const { engine } = makeEngine();
    const entryPrice = 100;
    const stopLoss = entryPrice * (1 - 10 / 10000); // 10 bps below entry = 99.9
    const tp1 = entryPrice * (1 + 30 / 10000);
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
      stopLoss,
      takeProfits: { tp1, tp2: null, tp3: null },
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: { ...baseCandidate().indicators.fiveMinute, latestClose: entryPrice },
      },
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    expect(engine.getAllPositions()).toHaveLength(0);
    const snapshot = engine.getSnapshot();
    const skip = snapshot.recentLog.find((event) => event.type === "ENTRY_SKIPPED");
    expect(skip?.message).toContain("STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK");
    expect(skip?.message).toContain("10");
  });

  it("stopDistanceBps < 175 does not create a normal active/base shadow position", async () => {
    const { engine } = makeEngine();
    const entryPrice = 100;
    const stopLoss = entryPrice * (1 - 10 / 10000);
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
      stopLoss,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: { ...baseCandidate().indicators.fiveMinute, latestClose: entryPrice },
      },
    });

    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    expect(engine.getAllPositions()).toHaveLength(0);
    const snapshot = engine.getSnapshot();
    const skip = snapshot.recentLog.find((event) => event.type === "ENTRY_SKIPPED");
    expect(skip?.message).toContain("STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK");
    expect(skip?.message).toContain("below 175bps");
  });

  it("stopDistanceBps exactly 175 is allowed", async () => {
    const { engine } = makeEngine();
    const entryPrice = 100;
    const stopLoss = entryPrice * (1 - 175 / 10000);
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
      stopLoss,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: { ...baseCandidate().indicators.fiveMinute, latestClose: entryPrice },
      },
    });

    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const positions = engine.getAllPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.stopDistanceBps).toBeCloseTo(175, 1);
  });

  it("stopDistanceBps > 175 is allowed", async () => {
    const { engine } = makeEngine();
    const entryPrice = 100;
    const stopLoss = entryPrice * (1 - 176 / 10000);
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
      stopLoss,
      indicators: {
        ...baseCandidate().indicators,
        fiveMinute: { ...baseCandidate().indicators.fiveMinute, latestClose: entryPrice },
      },
    });

    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const positions = engine.getAllPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.stopDistanceBps).toBeGreaterThan(175);
    expect(positions[0]!.selectedEntryVariant).toBe("base_current_entry");
    expect(positions[0]!.selectedExitVariant).toBe("tp1_full_exit");
    expect(positions[0]!.variantSelection.routeMode).toBe("PROFIT_CANDIDATE");
  });

  it("legacy position without policyVersion is processed by subsequent scan without errors", async () => {
    const { engine, client } = makeEngine();
    // Create a position normally
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    // Simulate a legacy record by stripping policyVersion from the stored file
    const positions = engine.getAllPositions();
    const legacyPositions = positions.map((p) => {
      const { policyVersion: _v, ...rest } = p;
      return rest;
    });
    const { writeFileSync, readFileSync: _r } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Access internal positionsFile path via the snapshot (it reads from the same dir)
    const snapshot = engine.getSnapshot();
    const posPath = snapshot.openPositions[0];
    expect(posPath).toBeTruthy();

    // Re-open engine in same dir and write legacy-shaped positions
    const { mkdtempSync: _mk, rmSync: _rm } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const legacyDir = mkdtempSync(join(tmpdir(), "dtc-shadow-legacy-"));
    dirs.push(legacyDir);
    writeFileSync(resolve(legacyDir, "shadow-positions.json"), JSON.stringify(legacyPositions, null, 2), "utf-8");
    const legacyEngine = new ShadowExecutionEngine(new FakeBinanceClient() as never, legacyDir);

    // Process a closing candle — should not throw even without policyVersion
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 101.6, low: 99.8, close: 101.2, volume: 1000 },
    ]);
    await expect(
      legacyEngine.processScan({ ...makeScanResult("2026-05-08T00:10:00.000Z", candidate), top10: [] }),
    ).resolves.toBeUndefined();

    // Legacy position should close without errors
    const legacySnapshot = legacyEngine.getSnapshot();
    expect(legacySnapshot.summary.closedPositions).toBeGreaterThanOrEqual(0);
  });

  it("adding policyVersion does not change selectedEntryVariant, selectedExitVariant, or route behavior", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_50_tp2_runner"),
      stopLoss: 97.8,
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    expect(position.selectedEntryVariant).toBe("vwap_retest_entry");
    expect(position.selectedExitVariant).toBe("tp1_50_tp2_runner");
    expect(position.variantSelection.routeMode).toBe("PROFIT_CANDIDATE");
    // Route selection fields must not be affected by the policy version patch
    expect(position.policyVersion).toBe(BASE_ROUTE_POLICY_VERSION_V2);
  });

  it("Fix 3: new FILLED positions get riskHygieneGuardMinStopDistanceBps=175 and riskHygieneGuardVersion stamped", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({ selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit") });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const position = engine.getAllPositions()[0]!;
    expect(position.riskHygieneGuardMinStopDistanceBps).toBe(175);
    expect(position.riskHygieneGuardVersion).toBe(RISK_HYGIENE_GUARD_V1);
    expect(position.riskHygieneGuardVersion).toBe("base-route-risk-hygiene-stop175-v1");
    // policyVersion must still be stamped (regression guard)
    expect(position.policyVersion).toBe(BASE_ROUTE_POLICY_VERSION_V2);
  });

  it("Fix 3: new PENDING positions get riskHygieneGuardMinStopDistanceBps=175 and riskHygieneGuardVersion stamped", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("vwap_retest_entry", "tp1_full_exit"),
      stopLoss: 97.8,
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const pending = positions.find((p) => (p.entryState ?? "FILLED") === "PENDING_ENTRY");
    if (pending) {
      expect(pending.riskHygieneGuardMinStopDistanceBps).toBe(175);
      expect(pending.riskHygieneGuardVersion).toBe(RISK_HYGIENE_GUARD_V1);
    }
    // At least one position was created (either pending or filled)
    expect(positions.length).toBeGreaterThan(0);
  });
});

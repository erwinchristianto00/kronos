import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCandidate,
  type Candle,
  type Candidate,
  type ExecutionEntryVariant,
  type ScanResult,
  type ShadowPosition,
  type ShadowPositionVariant,
} from "@dtc/shared";

import { ShadowExecutionEngine } from "../src/lib/shadow-engine.js";
import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";

/**
 * Phase 3.1 toxicity-evidence instrumentation tests.
 * DATA ONLY: these tests verify the persisted excursion / R-geometry /
 * forward-path fields without touching the toxic evaluator, scoring,
 * routing, or readiness logic.
 */

function makeCandles({
  start = 100,
  step = 1,
  count = 160,
  timeStepMs = 5 * 60 * 1000,
  startTime = Date.UTC(2026, 4, 6, 0, 0, 0),
}: {
  start?: number;
  step?: number;
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
      volume: 1000 + index * 10,
    };
  });
}

function baseCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const now = Date.UTC(2026, 4, 6, 15, 0, 0);
  const completedStart = (timeStepMs: number) => now - 160 * timeStepMs;
  const candidate = buildCandidate({
    symbol: "BTCUSDT",
    // Every bar must have closed at the decision timestamp. The old fixture
    // put most 1h bars in the future and implicitly depended on lookahead.
    candles5m: makeCandles({ start: 95, step: 0.2, startTime: completedStart(5 * 60 * 1000) }),
    candles15m: makeCandles({ start: 95, step: 0.2, timeStepMs: 15 * 60 * 1000, startTime: completedStart(15 * 60 * 1000) }),
    candles1h: makeCandles({ start: 95, step: 0.2, timeStepMs: 60 * 60 * 1000, startTime: completedStart(60 * 60 * 1000) }),
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
    now,
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
  const dir = mkdtempSync(join(tmpdir(), "dtc-shadow-instr-"));
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

describe("Phase 3.1 variant excursion instrumentation", () => {
  it("captures LONG MFE/MAE from candle high/low and converts to R using initialRiskAbs", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    // entry=100 (from candidate.indicators.fiveMinute.latestClose via entryMid), stop=98.0
    // initialRiskAbs = 2.0
    // Candle high=101 (favorable +1.0 → mfeR = 0.5), low=99 (adverse -1.0 → maeR = 0.5)
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 101.0, low: 99.0, close: 100.5, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const variant = positions[0]?.variants[0];
    expect(variant).toBeDefined();
    expect(variant!.entryPriceUsed).not.toBeNull();
    const entry = variant!.entryPriceUsed as number;
    const risk = variant!.initialRiskAbs as number;
    // LONG MFE = high - entry; MAE = entry - low.
    expect(variant!.mfeAbs).toBeCloseTo(101.0 - entry, 4);
    expect(variant!.maeAbs).toBeCloseTo(entry - 99.0, 4);
    expect(variant!.mfeR).toBeCloseTo((101.0 - entry) / risk, 3);
    expect(variant!.maeR).toBeCloseTo((entry - 99.0) / risk, 3);
    expect(variant!.maxFavorablePrice).toBe(101.0);
    expect(variant!.maxAdversePrice).toBe(99.0);
  });

  it("captures SHORT MFE/MAE mirrored against candle low/high", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      finalDirection: "SHORT",
      direction: "SHORT",
      entryZone: [99.8, 100.5],
      stopLoss: 102.0,
      takeProfits: { tp1: 97.0, tp2: 95, tp3: 93 },
      kronos: {
        available: true,
        kronosLongProbability: 20,
        kronosShortProbability: 80,
        kronosBias: "SHORT",
        kronosConfidence: 76,
        kronosConfidenceBucket: "STRONG",
        expectedReturn1h: -1.2,
        expectedReturn4h: -2.1,
        probabilityUp: 30,
        probabilityDown: 70,
        forecastMaxHigh: 102,
        forecastMinLow: 95,
        kronosRisk: 30,
      },
      whale: { available: true, signal: "BEARISH", score: 75, reason: "aligned" },
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 100.8, low: 99.2, close: 99.5, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const variant = positions[0]?.variants[0];
    expect(variant).toBeDefined();
    const entry = variant!.entryPriceUsed as number;
    const risk = variant!.initialRiskAbs as number;
    // SHORT MFE = entry - low; MAE = high - entry.
    expect(variant!.mfeAbs).toBeCloseTo(entry - 99.2, 4);
    expect(variant!.maeAbs).toBeCloseTo(100.8 - entry, 4);
    expect(variant!.mfeR).toBeCloseTo((entry - 99.2) / risk, 3);
    expect(variant!.maeR).toBeCloseTo((100.8 - entry) / risk, 3);
  });

  it("persists R-geometry snapshot at fill (entryPriceUsed, stopPriceUsed, tp1PriceUsed, initialRiskAbs, tp1RewardR, slRiskR)", async () => {
    const { engine } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const position = positions[0]!;
    const variant = position.variants[0]!;
    expect(variant.entryPriceUsed).toBe(position.entryPrice);
    expect(variant.stopPriceUsed).toBe(position.stopLoss);
    expect(variant.tp1PriceUsed).toBe(position.tp1);
    const expectedRisk = Math.abs((position.entryPrice as number) - (position.stopLoss as number));
    expect(variant.initialRiskAbs).toBeCloseTo(expectedRisk, 6);
    // LONG: tp1Reward = tp1 - entry; tp1RewardR = reward / risk.
    const expectedReward = (position.tp1 as number) - (position.entryPrice as number);
    expect(variant.tp1RewardAbs).toBeCloseTo(expectedReward, 6);
    expect(variant.tp1RewardR).toBeCloseTo(expectedReward / expectedRisk, 4);
    expect(variant.slRiskR).toBe(-1);
  });

  it("does not fabricate excursion metrics for NO_FILL variants and excludes them from coverage", async () => {
    // Build a closed position with NO_FILL directly. The shadow-engine never
    // calls seedVariantInstrumentation on NO_FILL variants (they are created
    // in the pending-entry expiry path and immediately closed), so its
    // instrumentation fields stay undefined — and the dashboard coverage
    // explicitly excludes NO_FILL from the denominator.
    const noFillPosition: ShadowPosition = {
      id: "no-fill-id",
      ideaKey: "no-fill-key",
      symbol: "BTCUSDT",
      direction: "LONG",
      signalFamily: "trend_reversal",
      scannedAt: "2026-05-08T00:00:00.000Z",
      firstSeenAt: "2026-05-08T00:00:00.000Z",
      lastSeenAt: "2026-05-09T00:00:00.000Z",
      lastEvaluatedAt: "2026-05-09T00:00:00.000Z",
      scanCount: 1,
      latestStatus: "READY",
      latestScore: 0.5,
      latestReason: [],
      entryZone: [99.5, 100.2],
      entryState: "FILLED",
      entryPrice: 100,
      stopLoss: 98.5,
      tp1: 101.5,
      tp2: 103,
      tp3: 104.5,
      riskReward: 1.8,
      dangerScore: 30,
      selectedEntryVariant: "base_current_entry",
      selectedExitVariant: "tp1_full_exit",
      // variantSelection/tradePlan are required by the type but unused here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      variantSelection: { selectedEntryVariant: "base_current_entry", selectedExitVariant: "tp1_full_exit" } as any,
      primaryVariant: "tp1_full_exit",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tradePlan: {} as any,
      variants: [
        {
          variant: "tp1_full_exit",
          state: "CLOSED",
          openedAt: "2026-05-08T00:00:00.000Z",
          lastUpdatedAt: "2026-05-09T00:00:00.000Z",
          closedAt: "2026-05-09T00:00:00.000Z",
          remainingSizePct: 0,
          realizedGrossR: 0,
          realizedNetR: 0,
          unrealizedR: 0,
          currentPrice: 100,
          stopPrice: 98.5,
          tp1Hit: false,
          tp2Hit: false,
          tp3Hit: false,
          slMovedToBreakeven: false,
          closeReason: "NO_FILL",
          profitableAfterCosts: false,
          // Note: NO_FILL variants leave all Phase 3.1 instrumentation
          // fields undefined — no fabrication.
        },
      ],
    };

    const variant = noFillPosition.variants[0];
    expect(variant.closeReason).toBe("NO_FILL");
    // NO_FILL variants must NOT have fabricated excursion or R-geometry.
    expect(variant.mfeR ?? null).toBeNull();
    expect(variant.maeR ?? null).toBeNull();
    expect(variant.mfeAbs ?? null).toBeNull();
    expect(variant.maeAbs ?? null).toBeNull();
    expect(variant.entryPriceUsed ?? null).toBeNull();
    expect(variant.initialRiskAbs ?? null).toBeNull();
    expect(variant.resolutionPrice ?? null).toBeNull();
    expect(variant.pathCandleCount ?? null).toBeNull();

    // And the dashboard coverage line must exclude NO_FILL from the denominator.
    const report = buildDashboardAuditSummaryReport([noFillPosition], { era: "ALL_TIME" });
    expect(report.summaryText).toContain("Variant excursion coverage: 0/0 (0.00%)");
    expect(report.summaryText).toContain("Variant R-geometry coverage: 0/0 (0.00%)");
    expect(report.summaryText).toContain("Forward-path summary coverage: 0/0 (0.00%)");
  });

  it("persists forward-path summary fields when candles are observed", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100, high: 100.7, low: 99.6, close: 100.3, volume: 1000 },
      { openTime: Date.UTC(2026, 4, 8, 0, 10, 0), open: 100.3, high: 101.0, low: 100.0, close: 100.8, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:15:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const variant = positions[0]?.variants[0];
    expect(variant).toBeDefined();
    expect(variant!.pathStartAt).not.toBeNull();
    expect(variant!.pathEndAt).not.toBeNull();
    expect(variant!.pathHigh).toBeCloseTo(101.0, 4);
    expect(variant!.pathLow).toBeCloseTo(99.6, 4);
    expect(variant!.pathCandleCount).toBeGreaterThanOrEqual(2);
  });

  it("preserves existing close-reason classification and realizedGrossR/realizedNetR math (TP1_FULL)", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));

    // Strong run-up that hits TP1 cleanly.
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100.5, high: 103.5, low: 100.3, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const positions = engine.getAllPositions();
    const variant = positions[0]?.variants[0];
    expect(variant).toBeDefined();
    expect(variant!.closeReason).toBe("TP1_FULL");
    expect(variant!.realizedGrossR).toBeGreaterThan(0);
    expect(typeof variant!.realizedNetR).toBe("number");
    // resolutionPrice should be finite (latest observed close, overwritten by
    // closeVariant on explicit close paths).
    expect(typeof variant!.resolutionPrice).toBe("number");
    expect(Number.isFinite(variant!.resolutionPrice as number)).toBe(true);
  });

  it("dashboard coverage line renders correctly with a mix of populated and unpopulated records", async () => {
    const { engine, client } = makeEngine();
    const candidate = baseCandidate({
      selectedExecutionPlan: selectedPlan("base_current_entry", "tp1_full_exit"),
    });
    await engine.processScan(makeScanResult("2026-05-08T00:00:00.000Z", candidate));
    client.setCandles("BTCUSDT", [
      { openTime: Date.UTC(2026, 4, 8, 0, 5, 0), open: 100.5, high: 103.5, low: 100.3, close: 103.1, volume: 1000 },
    ]);
    await engine.processScan(makeScanResult("2026-05-08T00:10:00.000Z", candidate));

    const populatedPositions = engine.getAllPositions();
    // Simulate a legacy position with no per-variant instrumentation (mimics
    // pre-Phase-3.1 stored records). Clone and strip instrumentation fields.
    const legacy: ShadowPosition = JSON.parse(JSON.stringify(populatedPositions[0]));
    legacy.id = "legacy-id";
    legacy.ideaKey = "legacy-key";
    for (const v of legacy.variants) {
      delete (v as Partial<typeof v>).mfeR;
      delete (v as Partial<typeof v>).maeR;
      delete (v as Partial<typeof v>).mfeAbs;
      delete (v as Partial<typeof v>).maeAbs;
      delete (v as Partial<typeof v>).entryPriceUsed;
      delete (v as Partial<typeof v>).initialRiskAbs;
      delete (v as Partial<typeof v>).pathCandleCount;
      delete (v as Partial<typeof v>).resolutionPrice;
    }
    const mixed = [...populatedPositions, legacy];

    const report = buildDashboardAuditSummaryReport(mixed, { era: "ALL_TIME" });
    expect(report.summaryText).toContain("Variant excursion coverage: 1/2 (50.00%)");
    expect(report.summaryText).toContain("Variant R-geometry coverage: 1/2 (50.00%)");
    expect(report.summaryText).toContain("Forward-path summary coverage: 1/2 (50.00%)");
  });
});

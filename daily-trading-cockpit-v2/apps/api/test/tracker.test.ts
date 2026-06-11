import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Direction, ExecutionEntryVariant, FinalStatus, ScanResult, ShadowPositionVariant, TrackedSignal } from "@dtc/shared";

import { SignalTracker } from "../src/lib/tracker.js";

const tempDirs: string[] = [];

function selectedPlan(entry: ExecutionEntryVariant = "fib_382_entry", exit: ShadowPositionVariant = "tp1_full_exit") {
  return {
    selectedEntryVariant: entry,
    selectedExitVariant: exit,
    expectedGrossR: 0.4,
    expectedNetR: 0.2,
    netEdgeAfterCost: 0.2,
    profitFactor: 1.4,
    fillRate: 25,
    noFillRate: 75,
    costR: 0.1,
    spreadR: 0.02,
    feeSlippageR: 0.08,
    stopDistanceBps: 300,
    variantSampleSize: 42,
    variantConfidenceTier: "provisional" as const,
    routeMode: "PROFIT_CANDIDATE" as const,
    selectionSource: "replay" as const,
    costAssumption: "test costs",
    selectionReason: "test selected plan",
    entryDriftPct: 0.1,
    entryDriftAtr: 0.2,
    entryQualityExplanation: ["test entry"],
    exitPlanExplanation: ["test exit"],
    chaseRisk: "LOW" as const,
  };
}

function makeScanResult(
  generatedAt: string,
  options: {
    status?: "TRADE_NOW" | "READY" | "WAIT" | "WATCH";
    direction?: Direction;
    entryZone?: [number, number] | null;
  } = {},
): ScanResult {
  const status = options.status ?? "READY";
  const direction = options.direction ?? "LONG";
  const entryZone = options.entryZone ?? [99, 100.5];
  return {
    generatedAt,
    coverage: {
      totalSymbols: 20,
      scannedSymbols: 20,
      returnedSymbols: 1,
      skippedSymbols: 19,
      percent: 100,
      liveSymbols: 20,
      cacheFreshSymbols: 0,
    },
    marketRegime: "Mixed rotation",
    top10: [
      {
        rank: 1,
        symbol: "BTCUSDT",
        direction,
        status,
        longScore: 61,
        shortScore: 39,
        opportunityScore: 73,
        dangerScore: 22,
        confidence: 70,
        dataQualityScore: 100,
        liquidityScore: 100,
        volatilityScore: 65,
        trendScore: 71,
        volumeScore: 88,
        kronosScore: 0,
        finalDirection: direction,
        finalStatus: status,
        directionConflict: false,
        sourceConflict: false,
        kronosBias: "UNAVAILABLE",
        kronosConfidence: null,
        expectedReturn3: null,
        expectedReturn6: null,
        indicators: {
          fiveMinute: {
            timeframe: "5m",
            latestClose: 100,
            ema20: 99,
            ema50: 98,
            ema200: 95,
            sma20: 99,
            rsi14: 55,
            macd: { macd: 1, signal: 0.5, histogram: 0.5 },
            bollingerBands20: { upper: 102, middle: 99, lower: 96 },
            atr14: 1,
            atrPercent: 1,
            vwap: 99.5,
            volumeRatio: 1.2,
            bodyWickRatio: 1.1,
            support: 97,
            resistance: 103,
            recentSwingHigh: 103,
            recentSwingLow: 97,
            distanceFromEma20: 1,
            distanceFromVwap: 0.5,
            breakoutHigh: false,
            breakoutLow: false,
            trend: "BULLISH",
            isFresh: true,
            lastOpenTime: Date.parse(generatedAt),
          },
          fifteenMinute: {
            timeframe: "15m",
            latestClose: 100,
            ema20: 99,
            ema50: 98,
            ema200: 95,
            sma20: 99,
            rsi14: 55,
            macd: { macd: 1, signal: 0.5, histogram: 0.5 },
            bollingerBands20: { upper: 102, middle: 99, lower: 96 },
            atr14: 1,
            atrPercent: 1,
            vwap: 99.5,
            volumeRatio: 1.2,
            bodyWickRatio: 1.1,
            support: 97,
            resistance: 103,
            recentSwingHigh: 103,
            recentSwingLow: 97,
            distanceFromEma20: 1,
            distanceFromVwap: 0.5,
            breakoutHigh: false,
            breakoutLow: false,
            trend: "BULLISH",
            isFresh: true,
            lastOpenTime: Date.parse(generatedAt),
          },
          oneHour: {
            timeframe: "1h",
            latestClose: 100,
            ema20: 99,
            ema50: 98,
            ema200: 95,
            sma20: 99,
            rsi14: 55,
            macd: { macd: 1, signal: 0.5, histogram: 0.5 },
            bollingerBands20: { upper: 102, middle: 99, lower: 96 },
            atr14: 1,
            atrPercent: 1,
            vwap: 99.5,
            volumeRatio: 1.2,
            bodyWickRatio: 1.1,
            support: 97,
            resistance: 103,
            recentSwingHigh: 103,
            recentSwingLow: 97,
            distanceFromEma20: 1,
            distanceFromVwap: 0.5,
            breakoutHigh: false,
            breakoutLow: false,
            trend: "BULLISH",
            isFresh: true,
            lastOpenTime: Date.parse(generatedAt),
          },
          fibonacci: {
            recentHigh: 103,
            recentLow: 97,
            retracement236: 101.5,
            retracement382: 100.7,
            retracement500: 100,
            retracement618: 99.3,
            retracement786: 98.3,
            extension1272: 104.6,
            extension1618: 106.7,
          },
          atr: {
            atr14: 1,
            atrPercent: 1,
            entryZoneLow: 99,
            entryZoneHigh: 100.5,
            stopLoss: 97,
            takeProfit1: 103,
            takeProfit2: 104.6,
            takeProfit3: 106.7,
            riskReward: 2,
          },
        },
        fibonacci: {
          recentHigh: 103,
          recentLow: 97,
          retracement236: 101.5,
          retracement382: 100.7,
          retracement500: 100,
          retracement618: 99.3,
          retracement786: 98.3,
          extension1272: 104.6,
          extension1618: 106.7,
        },
        atr: {
          atr14: 1,
          atrPercent: 1,
          entryZoneLow: 99,
          entryZoneHigh: 100.5,
          stopLoss: 97,
          takeProfit1: 103,
          takeProfit2: 104.6,
          takeProfit3: 106.7,
          riskReward: 2,
        },
        volume: {
          baseVolume24h: 1_000_000,
          quoteVolume24h: 100_000_000,
          volumeRatio5m: 1.2,
        },
        spread: {
          bid: 100,
          ask: 100.02,
          absolute: 0.02,
          percent: 0.02,
        },
        whale: {
          available: true,
          signal: "BULLISH",
          score: 62,
          reason: "Bullish futures flow.",
        },
        sentiment: {
          available: false,
          signal: "UNAVAILABLE",
          score: 0,
          reason: "Unavailable.",
        },
        entryZone,
        stopLoss: 97,
        takeProfits: { tp1: 103, tp2: 104.6, tp3: 106.7 },
        riskReward: 2,
        reason: ["Test signal"],
        blockers: [],
        chart: [{ time: Math.floor(Date.parse(generatedAt) / 1000), value: 100 }],
        selectedExecutionPlan: selectedPlan(),
      },
    ],
    diagnostics: {
      universe: ["BTCUSDT"],
      skippedSymbols: [],
      hiddenSkips: [],
      symbolFailures: [],
      kronos: { configured: false, available: false, message: "Unavailable." },
      whale: { available: true, message: "Available." },
      sentiment: { available: false, configured: false, provider: "none", message: "Disabled." },
    },
  };
}

function resolvePrimaryOutcome(signal: TrackedSignal): TrackedSignal {
  return {
    ...signal,
    outcomes: {
      ...signal.outcomes,
      "4h": {
        checkedAt: "2026-05-07T04:00:00.000Z",
        priceAtCheck: 103,
        priceChangePct: 3,
        maxFavorableExcursionPct: 4,
        maxAdverseExcursionPct: 1,
        rResult: 1,
        grossRResult: 1,
        netRResult: 0.94,
        outcomeQuality: "VALID_RISK",
        profitableAfterCosts: true,
        slHit: false,
        tp1Hit: true,
        tp2Hit: false,
        tp3Hit: false,
        result: "TP1",
      },
    },
  };
}

describe("SignalTracker dedupe", () => {
  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same signal repeated within cooldown is not duplicated and scanCount increments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    await tracker.persistScan(makeScanResult("2026-05-07T00:10:00.000Z", { status: "READY" }));

    const [signal] = tracker.readAll();
    expect(tracker.readAll()).toHaveLength(1);
    expect(signal.scanCount).toBe(2);
    expect(signal.isDuplicateSuppressed).toBe(true);
    expect(signal.lastSeenAt).toBe("2026-05-07T00:10:00.000Z");
  });

  it("persists selected execution plan and preserves it across duplicate scans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    const second = makeScanResult("2026-05-07T00:10:00.000Z", { status: "READY" });
    second.top10[0]!.selectedExecutionPlan = selectedPlan("vwap_retest_entry", "tp1_50_tp2_runner");
    await tracker.persistScan(second);

    const [signal] = tracker.readAll();
    const [rawFirst, rawSecond] = tracker.readAllRaw();
    expect(rawFirst.selectedExecutionPlan?.selectedEntryVariant).toBe("fib_382_entry");
    expect(rawSecond.selectedExecutionPlan?.selectedEntryVariant).toBe("vwap_retest_entry");
    expect(signal.selectedExecutionPlan?.selectedEntryVariant).toBe("fib_382_entry");
    expect(signal.selectedExecutionPlan?.selectedExitVariant).toBe("tp1_full_exit");
  });

  it("changed direction creates new signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY", direction: "LONG" }));
    await tracker.persistScan(makeScanResult("2026-05-07T00:10:00.000Z", { status: "READY", direction: "SHORT" }));

    expect(tracker.readAll()).toHaveLength(2);
  });

  it("resolved signal can create new signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    const resolved = tracker.readAll().map((signal) => resolvePrimaryOutcome(signal));
    tracker.writeAll(resolved);

    await tracker.persistScan(makeScanResult("2026-05-07T00:20:00.000Z", { status: "READY" }));

    expect(tracker.readAll()).toHaveLength(2);
  });

  it("cooldown expiry or status change creates a new signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    await tracker.persistScan(makeScanResult("2026-05-07T01:05:00.000Z", { status: "READY" }));
    await tracker.persistScan(makeScanResult("2026-05-07T01:20:00.000Z", { status: "WAIT" }));

    expect(tracker.readAll()).toHaveLength(3);
  });

  it("rebuild preserves safely matched resolved legacy outcomes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    const canonicalResolved = tracker.readAll().map((signal) => resolvePrimaryOutcome(signal));
    tracker.writeAll(canonicalResolved);

    const rebuilt = tracker.rebuildFromRaw();
    const [signal] = rebuilt.signals;

    expect(signal.outcomes["4h"]?.result).toBe("TP1");
    expect(rebuilt.audit.migratedResolvedOutcomes).toBe(1);
    expect(rebuilt.audit.archivedPreDedupeSample).toBe(0);
  });

  it("archives unmatched legacy resolved outcomes during rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtc-tracker-"));
    tempDirs.push(dir);
    const tracker = new SignalTracker(dir);

    await tracker.persistScan(makeScanResult("2026-05-07T00:00:00.000Z", { status: "READY" }));
    const canonicalResolved = tracker.readAll().map((signal) =>
      resolvePrimaryOutcome({
        ...signal,
        normalizedSignalKey: "OTHER|LONG|INTRADAY_5M_15M_1H|1.00000000:2.00000000|BREAKOUT",
      }),
    );
    tracker.writeAll(canonicalResolved);

    const rebuilt = tracker.rebuildFromRaw();

    expect(rebuilt.audit.archivedPreDedupeSample).toBe(1);
    expect(tracker.readArchive()).toHaveLength(1);
    expect(rebuilt.audit.skippedLegacyReasons).toContain("legacy resolved record could not be safely matched and was archived");
  });
});

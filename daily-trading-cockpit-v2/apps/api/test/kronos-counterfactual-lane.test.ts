import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Candidate, Candle } from "@dtc/shared";

import { buildDashboardAuditSummaryReport } from "../src/lib/dashboard-audit-summary.js";
import {
  buildKronosCounterfactualObservation,
  buildKronosCounterfactualReport,
  classifyAndDraftCounterfactualObservations,
  classifyKronosCounterfactualAdmission,
  computeValidationMilestones,
  emitKronosCounterfactualObservations,
  JsonKronosCounterfactualStore,
  resolveKronosCounterfactualObservations,
  KRONOS_COUNTERFACTUAL_POLICY_VERSION,
  type KronosCounterfactualLane,
  type KronosCounterfactualObservation,
  type KronosCounterfactualRefreshDiagnostics,
  type KronosCounterfactualStore,
  type KronosCounterfactualStoreState,
} from "../src/lib/kronos-counterfactual-lane.js";

// ─── In-memory store ──────────────────────────────────────────────────────────

class MemoryStore implements KronosCounterfactualStore {
  constructor(
    public rows: KronosCounterfactualObservation[] = [],
    public latestDiagnostics: KronosCounterfactualRefreshDiagnostics | null = null,
  ) {}
  readState(): KronosCounterfactualStoreState {
    return { observations: this.rows, latestRefreshDiagnostics: this.latestDiagnostics };
  }
  writeState(state: KronosCounterfactualStoreState): void {
    this.rows = state.observations;
    this.latestDiagnostics = state.latestRefreshDiagnostics ?? null;
  }
  readAll(): KronosCounterfactualObservation[] {
    return this.rows;
  }
  writeAll(observations: KronosCounterfactualObservation[]): void {
    this.rows = observations;
  }
}

// ─── Candidate fixture ────────────────────────────────────────────────────────

interface MakeCandidateOpts {
  symbol?: string;
  finalDirection?: "LONG" | "SHORT";
  opportunityScore?: number;
  kronosBias?: "LONG" | "SHORT" | "UNAVAILABLE";
  sourceConflict?: boolean;
  horizonConflict?: boolean;
  whaleSignal?: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  whaleAvailable?: boolean;
  currentPrice?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number | null;
  tp3?: number | null;
  finalStatus?: string;
  selectedEntryVariant?: string;
  selectedExitVariant?: string;
  stopDistanceBps?: number;
  costR?: number;
  noPlan?: boolean;
}

function makeCandidate(opts: MakeCandidateOpts = {}): Candidate {
  const finalDirection = opts.finalDirection ?? "SHORT";
  const currentPrice = opts.currentPrice ?? 100;
  // For SHORT: stop above entry, TPs below entry. For LONG: opposite.
  const stopLoss = opts.stopLoss ?? (finalDirection === "SHORT" ? 102 : 98);
  const tp1 = opts.tp1 ?? (finalDirection === "SHORT" ? 97 : 103);
  const candidate: Candidate = {
    rank: 1,
    symbol: opts.symbol ?? "BTCUSDT",
    direction: finalDirection,
    finalDirection,
    status: (opts.finalStatus as Candidate["status"]) ?? "WATCH",
    finalStatus: (opts.finalStatus as Candidate["finalStatus"]) ?? "WATCH",
    longScore: 50,
    shortScore: 80,
    opportunityScore: opts.opportunityScore ?? 75,
    dangerScore: 30,
    confidence: 65,
    dataQualityScore: 80,
    liquidityScore: 75,
    volatilityScore: 60,
    trendScore: 70,
    volumeScore: 65,
    kronosScore: 60,
    sourceConflict: opts.sourceConflict ?? false,
    directionConflict: false,
    kronosBias: opts.kronosBias ?? "UNAVAILABLE",
    kronosConfidence: 70,
    expectedReturn3: null,
    expectedReturn6: null,
    horizonConflict: opts.horizonConflict ?? false,
    indicators: {
      fiveMinute: { latestClose: currentPrice, trend: "BEARISH", vwap: currentPrice, ema20: currentPrice, support: 95, resistance: 105, recentSwingHigh: 105, recentSwingLow: 95, volumeRatio: 1, atrPercent: 1 } as Candidate["indicators"]["fiveMinute"],
      fifteenMinute: { trend: "BEARISH" } as Candidate["indicators"]["fifteenMinute"],
      oneHour: { trend: "BEARISH" } as Candidate["indicators"]["oneHour"],
    },
    fibonacci: { recentHigh: 105, recentLow: 95, retracement236: 102.6, retracement382: 101.2, retracement500: 100, retracement618: 98.8, retracement786: 97.1, extension1272: 107.7, extension1618: 111.2 },
    atr: { stopLoss, takeProfit1: tp1, takeProfit2: opts.tp2 ?? null, takeProfit3: opts.tp3 ?? null } as Candidate["atr"],
    volume: { volumeRatio5m: 1.2 } as Candidate["volume"],
    spread: { percent: 0.02 } as Candidate["spread"],
    whale: {
      available: opts.whaleAvailable ?? true,
      signal: opts.whaleSignal ?? "BULLISH",
      score: 60,
    } as Candidate["whale"],
    sentiment: { available: true, signal: "NEUTRAL", score: 50 } as Candidate["sentiment"],
    entryZone: null,
    stopLoss,
    takeProfits: {
      tp1,
      tp2: opts.tp2 ?? null,
      tp3: opts.tp3 ?? null,
    },
    riskReward: 1.5,
    reason: ["test reason"],
    blockers: [],
    chart: [],
    selectedExecutionPlan: opts.noPlan
      ? null
      : ({
          selectedEntryVariant: opts.selectedEntryVariant ?? "vwap_retest_entry",
          selectedExitVariant: opts.selectedExitVariant ?? "tp1_full_exit",
          expectedGrossR: 0.8,
          expectedNetR: 0.55,
          netEdgeAfterCost: 0.55,
          profitFactor: 1.4,
          fillRate: null,
          noFillRate: null,
          costR: opts.costR ?? 0.1,
          spreadR: 0.02,
          feeSlippageR: 0.08,
          stopDistanceBps: opts.stopDistanceBps ?? 200,
          variantSampleSize: 20,
          variantConfidenceTier: "provisional",
          routeMode: "DATA_COLLECTION",
          routeScore: 20,
          routeReasonCodes: [],
        } as Candidate["selectedExecutionPlan"]),
  };
  return candidate;
}

// ─── Synthetic candles for the resolver ───────────────────────────────────────

function buildCandles(opts: {
  start?: number;
  count?: number;
  entryHit?: boolean;
  hitTp1?: boolean;
  hitSl?: boolean;
  direction?: "LONG" | "SHORT";
  entry: number;
  stop: number;
  tp1: number;
}): Candle[] {
  const start = opts.start ?? Date.parse("2026-05-20T00:00:00.000Z");
  const count = opts.count ?? 20;
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = start + i * 300_000;
    const closeTime = openTime + 299_999;
    let open = opts.entry;
    let close = opts.entry;
    let low = opts.entry - 0.2;
    let high = opts.entry + 0.2;
    if (opts.entryHit !== false && i === 0) {
      // Touch entry
      low = Math.min(opts.entry, opts.entry - 0.5);
      high = Math.max(opts.entry, opts.entry + 0.5);
    }
    if (opts.hitTp1 && i === 3) {
      // SHORT: low goes below tp1; LONG: high goes above tp1
      if (opts.direction === "SHORT") {
        low = opts.tp1 - 0.5;
        close = opts.tp1 - 0.2;
      } else {
        high = opts.tp1 + 0.5;
        close = opts.tp1 + 0.2;
      }
    }
    if (opts.hitSl && i === 3) {
      if (opts.direction === "SHORT") {
        high = opts.stop + 0.5;
        close = opts.stop + 0.2;
      } else {
        low = opts.stop - 0.5;
        close = opts.stop - 0.2;
      }
    }
    candles.push({
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 100000,
      trades: 50,
    } as Candle);
  }
  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("classifyKronosCounterfactualAdmission", () => {
  it("treats an empty JSON store file as an empty counterfactual state", () => {
    const dir = mkdtempSync(join(tmpdir(), "kronos-cf-empty-"));
    try {
      writeFileSync(join(dir, "kronos-counterfactual-observations.json"), "", "utf-8");
      const store = new JsonKronosCounterfactualStore(dir);

      expect(store.readState()).toEqual({
        observations: [],
        latestRefreshDiagnostics: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits a SHORT candidate where Kronos says LONG (active disagreement, Lane A)", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      opportunityScore: 80,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(true);
    expect(decision.lane).toBe("KRONOS_DISAGREEMENT_COUNTERFACTUAL");
    expect(decision.reasonCodes).toContain("KRONOS_BIAS_OPPOSITE_TO_TRADE_DIRECTION");
  });

  it("admits a candidate with liveSourceConflict=true (Lane B)", () => {
    // Kronos UNAVAILABLE but live scanner determined sourceConflict separately
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "UNAVAILABLE",
      sourceConflict: true,
      whaleSignal: "BEARISH",
      opportunityScore: 75,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(true);
    expect(decision.lane).toBe("LIVE_SOURCE_CONFLICT_COUNTERFACTUAL");
    expect(decision.reasonCodes).toContain("LIVE_SOURCE_CONFLICT_TRUE");
  });

  it("prefers Lane A (disagreement) over Lane B when both apply", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      sourceConflict: true,
      whaleSignal: "BEARISH",
      opportunityScore: 80,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.lane).toBe("KRONOS_DISAGREEMENT_COUNTERFACTUAL");
    expect(decision.reasonCodes).toContain("ALSO_LIVE_SOURCE_CONFLICT");
  });

  it("rejects a weak candidate even when Kronos disagrees", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      opportunityScore: 30, // below threshold
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(false);
    expect(decision.rejectionReason).toBe("OPPORTUNITY_SCORE_BELOW_THRESHOLD");
  });

  it("rejects a candidate where Kronos AGREES (not a counterfactual case)", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "SHORT", // agrees
      sourceConflict: false,
      opportunityScore: 80,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(false);
    expect(decision.rejectionReason).toBe("KRONOS_AGREES_NOT_A_COUNTERFACTUAL");
  });

  it("rejects when execution plan is missing", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      opportunityScore: 80,
      noPlan: true,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(false);
    expect(decision.rejectionReason).toBe("EXECUTION_PLAN_MISSING");
  });

  it("rejects when stopDistanceBps is below absurd floor", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      opportunityScore: 80,
      stopDistanceBps: 5,
    });
    const decision = classifyKronosCounterfactualAdmission(c);
    expect(decision.admitted).toBe(false);
    expect(decision.rejectionReason).toBe("STOP_DISTANCE_BELOW_ABSURD_FLOOR");
  });
});

describe("buildKronosCounterfactualObservation", () => {
  it("builds a well-formed observation for an admitted Lane A candidate", () => {
    const c = makeCandidate({
      finalDirection: "SHORT",
      kronosBias: "LONG",
      opportunityScore: 80,
    });
    const obs = buildKronosCounterfactualObservation(
      c,
      "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
      ["KRONOS_BIAS_OPPOSITE_TO_TRADE_DIRECTION"],
      "batch-1",
      "2026-05-20T00:00:00.000Z",
    );
    expect(obs).not.toBeNull();
    expect(obs!.lane).toBe("KRONOS_DISAGREEMENT_COUNTERFACTUAL");
    expect(obs!.observationStatus).toBe("OPEN");
    expect(obs!.snapshot.direction).toBe("SHORT");
    expect(obs!.snapshot.kronosBias).toBe("LONG");
    expect(obs!.snapshot.kronosAgrees).toBe(false);
    expect(obs!.resolverState?.entryPrice).toBe(100);
    expect(obs!.resolverState?.stopPrice).toBe(102);
    expect(obs!.diagnostics.createdByPolicyVersion).toBe(KRONOS_COUNTERFACTUAL_POLICY_VERSION);
  });
});

describe("emitKronosCounterfactualObservations + duplicate suppression", () => {
  it("admits qualifying candidates and creates observations", () => {
    const store = new MemoryStore();
    const candidates = [
      makeCandidate({ symbol: "AAAUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 80 }),
      makeCandidate({ symbol: "BBBUSDT", finalDirection: "SHORT", kronosBias: "UNAVAILABLE", sourceConflict: true, whaleSignal: "BEARISH", opportunityScore: 75 }),
    ];
    const diag = emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(diag.observationsCreated).toBe(2);
    expect(store.rows.length).toBe(2);
    expect(diag.laneCreatedCounts.KRONOS_DISAGREEMENT_COUNTERFACTUAL).toBe(1);
    expect(diag.laneCreatedCounts.LIVE_SOURCE_CONFLICT_COUNTERFACTUAL).toBe(1);
  });

  it("suppresses duplicates within the 12h window", () => {
    const store = new MemoryStore();
    const candidates = [
      makeCandidate({ symbol: "AAAUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 80 }),
    ];
    emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(store.rows.length).toBe(1);
    // Re-emit 1 hour later — should suppress
    const diag2 = emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T01:00:00.000Z"),
    });
    expect(diag2.observationsCreated).toBe(0);
    expect(diag2.observationsSuppressedAsDuplicate).toBe(1);
    expect(store.rows.length).toBe(1);
  });

  it("allows re-admission after the 12h window expires", () => {
    const store = new MemoryStore();
    const candidates = [
      makeCandidate({ symbol: "AAAUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 80 }),
    ];
    emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    const diag2 = emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T13:00:00.000Z"), // 13h later
    });
    expect(diag2.observationsCreated).toBe(1);
    expect(store.rows.length).toBe(2);
  });

  it("does NOT admit weak candidates just because Kronos disagrees", () => {
    const store = new MemoryStore();
    const candidates = [
      makeCandidate({ symbol: "WEAKUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 30 }),
    ];
    const diag = emitKronosCounterfactualObservations({
      candidates,
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(diag.observationsCreated).toBe(0);
    expect(store.rows.length).toBe(0);
  });
});

describe("classifyAndDraftCounterfactualObservations", () => {
  it("groups skip reasons and returns drafts in stable order", () => {
    const candidates = [
      makeCandidate({ symbol: "OKUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 80 }),
      makeCandidate({ symbol: "WEAKUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 30 }),
      makeCandidate({ symbol: "AGREEUSDT", finalDirection: "SHORT", kronosBias: "SHORT", opportunityScore: 80 }),
    ];
    const { drafts, skippedReasons } = classifyAndDraftCounterfactualObservations(candidates, "batch-x", "2026-05-20T00:00:00.000Z");
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.symbol).toBe("OKUSDT");
    expect(skippedReasons.OPPORTUNITY_SCORE_BELOW_THRESHOLD).toBe(1);
    expect(skippedReasons.KRONOS_AGREES_NOT_A_COUNTERFACTUAL).toBe(1);
  });
});

describe("resolveKronosCounterfactualObservations (using a stub binance client)", () => {
  it("resolves an OPEN observation that hits TP1 with positive netR", async () => {
    const store = new MemoryStore();
    emitKronosCounterfactualObservations({
      candidates: [
        makeCandidate({
          symbol: "RESOLVEUSDT",
          finalDirection: "SHORT",
          kronosBias: "LONG",
          opportunityScore: 80,
          currentPrice: 100,
          stopLoss: 102,
          tp1: 97,
        }),
      ],
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(store.rows.length).toBe(1);

    // SHORT @ entry 100, stop 102, tp1 97 — candles hit entry first, then tp1
    const candles = buildCandles({
      start: Date.parse("2026-05-20T00:01:00.000Z"),
      direction: "SHORT",
      entry: 100,
      stop: 102,
      tp1: 97,
      entryHit: true,
      hitTp1: true,
    });

    const stubBinance = {
      getCandles: async () => candles,
    } as unknown as Parameters<typeof resolveKronosCounterfactualObservations>[0]["binanceClient"];

    const diag = await resolveKronosCounterfactualObservations({
      store,
      binanceClient: stubBinance,
      now: new Date("2026-05-20T02:00:00.000Z"),
    });

    expect(diag.observationsResolvedThisRefresh).toBe(1);
    expect(store.rows[0]!.observationStatus).toBe("RESOLVED");
    expect(store.rows[0]!.outcome?.closeReason).toBe("TP1_FULL");
    expect(store.rows[0]!.outcome?.realizedNetR).toBeGreaterThan(0);
    expect(store.rows[0]!.outcome?.winnerLabel).toBe("WIN");
  });

  it("resolves an OPEN observation that hits SL with negative netR", async () => {
    const store = new MemoryStore();
    emitKronosCounterfactualObservations({
      candidates: [
        makeCandidate({
          symbol: "SLUSDT",
          finalDirection: "SHORT",
          kronosBias: "LONG",
          opportunityScore: 80,
          currentPrice: 100,
          stopLoss: 102,
          tp1: 97,
        }),
      ],
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const candles = buildCandles({
      start: Date.parse("2026-05-20T00:01:00.000Z"),
      direction: "SHORT",
      entry: 100,
      stop: 102,
      tp1: 97,
      entryHit: true,
      hitSl: true,
    });

    const stubBinance = {
      getCandles: async () => candles,
    } as unknown as Parameters<typeof resolveKronosCounterfactualObservations>[0]["binanceClient"];

    await resolveKronosCounterfactualObservations({
      store,
      binanceClient: stubBinance,
      now: new Date("2026-05-20T02:00:00.000Z"),
    });

    expect(store.rows[0]!.observationStatus).toBe("RESOLVED");
    expect(store.rows[0]!.outcome?.closeReason).toBe("SL");
    expect(store.rows[0]!.outcome?.realizedNetR).toBeLessThan(0);
    expect(store.rows[0]!.outcome?.winnerLabel).toBe("LOSS");
    expect(store.rows[0]!.outcome?.slHit).toBe(true);
  });

  it("marks observation as NO_FILL when entry never reached within 24h", async () => {
    const store = new MemoryStore();
    emitKronosCounterfactualObservations({
      candidates: [
        makeCandidate({
          symbol: "NOFILLUSDT",
          finalDirection: "SHORT",
          kronosBias: "LONG",
          opportunityScore: 80,
          currentPrice: 100,
          stopLoss: 102,
          tp1: 97,
        }),
      ],
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    // Candles that never touch 100 (all stay around 95 — for SHORT, this would never reach the entry at 100 because price needs to bounce up TO 100)
    const start = Date.parse("2026-05-20T00:01:00.000Z");
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: start + i * 300_000,
      closeTime: start + i * 300_000 + 299_999,
      open: 95,
      high: 95.5,
      low: 94.5,
      close: 95,
      volume: 1000,
      quoteVolume: 100000,
      trades: 50,
    } as Candle));

    const stubBinance = {
      getCandles: async () => candles,
    } as unknown as Parameters<typeof resolveKronosCounterfactualObservations>[0]["binanceClient"];

    await resolveKronosCounterfactualObservations({
      store,
      binanceClient: stubBinance,
      now: new Date("2026-05-21T01:00:00.000Z"), // >24h later
    });
    expect(store.rows[0]!.observationStatus).toBe("NO_FILL");
    expect(store.rows[0]!.outcome?.closeReason).toBe("NO_FILL");
    expect(store.rows[0]!.outcome?.fillStatus).toBe("NO_FILL");
  });

  it("records failure when the binance client throws and does not lose the observation", async () => {
    const store = new MemoryStore();
    emitKronosCounterfactualObservations({
      candidates: [
        makeCandidate({ symbol: "FAILUSDT", finalDirection: "SHORT", kronosBias: "LONG", opportunityScore: 80 }),
      ],
      store,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const stubBinance = {
      getCandles: async () => {
        throw new Error("Binance offline");
      },
    } as unknown as Parameters<typeof resolveKronosCounterfactualObservations>[0]["binanceClient"];

    const diag = await resolveKronosCounterfactualObservations({
      store,
      binanceClient: stubBinance,
      now: new Date("2026-05-20T02:00:00.000Z"),
    });
    expect(diag.observationsFailedResolution).toBe(1);
    expect(store.rows[0]!.observationStatus).toBe("OPEN");
    expect(store.rows[0]!.diagnostics.lastResolutionError).toMatch(/Binance offline/);
  });
});

describe("buildKronosCounterfactualReport", () => {
  it("returns TOO_EARLY on empty data and renders cleanly", () => {
    const report = buildKronosCounterfactualReport([], new Date("2026-05-20T00:00:00.000Z"));
    expect(report.verdict).toBe("TOO_EARLY");
    expect(report.observationsTotal).toBe(0);
    expect(report.lanes).toHaveLength(2);
    expect(report.lanes.every((l) => !l.hasEnoughForVerdict)).toBe(true);
  });

  it("computes per-lane economics for resolved observations", () => {
    const obs: KronosCounterfactualObservation[] = [
      // Lane A: 1 win
      {
        observationId: "A1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T01:00:00.000Z",
        lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
        symbol: "AAAUSDT",
        selectionBatchId: "batch-A",
        duplicateKey: "key-A1",
        snapshot: {
          direction: "SHORT",
          symbol: "AAAUSDT",
          marketRegime: null,
          kronosBias: "LONG",
          kronosAgrees: false,
          liveSourceConflict: false,
          horizonConflict: false,
          whaleSignal: "BEARISH",
          whaleAvailable: true,
          opportunityScore: 80,
          finalStatusObserved: "WATCH",
          selectedEntryVariant: "vwap_retest_entry",
          selectedExitVariant: "tp1_full_exit",
          plannedEntryPrice: 100,
          stopPrice: 102,
          tp1Price: 97,
          tp2Price: null,
          tp3Price: null,
          stopDistanceBps: 200,
          costR: 0.1,
          notes: [],
        },
        observationStatus: "RESOLVED",
        outcome: {
          realizedGrossR: 1.5,
          realizedNetR: 1.4,
          winnerLabel: "WIN",
          tp1Hit: true,
          tp2Hit: false,
          slHit: false,
          closeReason: "TP1_FULL",
          openedAt: "2026-05-20T00:05:00.000Z",
          closedAt: "2026-05-20T01:00:00.000Z",
          durationMinutes: 55,
          fillStatus: "FILLED",
        },
        diagnostics: {
          createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
          admissionReasonCodes: ["KRONOS_BIAS_OPPOSITE_TO_TRADE_DIRECTION"],
          resolutionSemantics: "test",
        },
      },
      // Lane B: 1 loss
      {
        observationId: "B1",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T01:00:00.000Z",
        lane: "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL",
        symbol: "BBBUSDT",
        selectionBatchId: "batch-B",
        duplicateKey: "key-B1",
        snapshot: {
          direction: "SHORT",
          symbol: "BBBUSDT",
          marketRegime: null,
          kronosBias: "UNAVAILABLE",
          kronosAgrees: false,
          liveSourceConflict: true,
          horizonConflict: false,
          whaleSignal: "BULLISH",
          whaleAvailable: true,
          opportunityScore: 75,
          finalStatusObserved: "WATCH",
          selectedEntryVariant: "vwap_retest_entry",
          selectedExitVariant: "tp1_full_exit",
          plannedEntryPrice: 100,
          stopPrice: 102,
          tp1Price: 97,
          tp2Price: null,
          tp3Price: null,
          stopDistanceBps: 200,
          costR: 0.1,
          notes: [],
        },
        observationStatus: "RESOLVED",
        outcome: {
          realizedGrossR: -0.9,
          realizedNetR: -1.0,
          winnerLabel: "LOSS",
          tp1Hit: false,
          tp2Hit: false,
          slHit: true,
          closeReason: "SL",
          openedAt: "2026-05-20T00:05:00.000Z",
          closedAt: "2026-05-20T01:00:00.000Z",
          durationMinutes: 55,
          fillStatus: "FILLED",
        },
        diagnostics: {
          createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
          admissionReasonCodes: ["LIVE_SOURCE_CONFLICT_TRUE"],
          resolutionSemantics: "test",
        },
      },
    ];
    const report = buildKronosCounterfactualReport(obs, new Date("2026-05-20T02:00:00.000Z"));
    expect(report.observationsTotal).toBe(2);
    expect(report.observationsResolved).toBe(2);
    const laneA = report.lanes.find((l) => l.lane === "KRONOS_DISAGREEMENT_COUNTERFACTUAL")!;
    expect(laneA.resolved).toBe(1);
    expect(laneA.resolvedNetAvgR).toBe(1.4);
    expect(laneA.resolvedWinRate).toBe(1);
    const laneB = report.lanes.find((l) => l.lane === "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL")!;
    expect(laneB.resolved).toBe(1);
    expect(laneB.resolvedNetAvgR).toBe(-1);
    expect(laneB.resolvedWinRate).toBe(0);
    // Both lanes still below the verdict floor (≥20)
    expect(report.verdict).toBe("TOO_EARLY");
  });
});

describe("dashboard rendering integration", () => {
  it("renders the J* counterfactual section honestly when no report is supplied", () => {
    const dash = buildDashboardAuditSummaryReport([]);
    expect(dash.summaryText).toContain("J*. KRONOS COUNTERFACTUAL EVIDENCE (REPORT-ONLY)");
    expect(dash.summaryText).toContain("Kronos counterfactual report not supplied");
    expect(dash.summaryText).toContain("report-only, no behavior influence");
  });

  it("renders TOO_EARLY for empty observations and surfaces both lanes", () => {
    const report = buildKronosCounterfactualReport([], new Date("2026-05-20T00:00:00.000Z"));
    const dash = buildDashboardAuditSummaryReport([], { kronosCounterfactual: report });
    expect(dash.summaryText).toContain("J*. KRONOS COUNTERFACTUAL EVIDENCE (REPORT-ONLY)");
    expect(dash.summaryText).toContain("observations: total=0");
    expect(dash.summaryText).toContain("disagreement lane: total=0");
    expect(dash.summaryText).toContain("live-source-conflict lane: total=0");
    expect(dash.summaryText).toContain("verdict: TOO_EARLY");
    expect(dash.summaryText).toContain("report-only, no behavior influence");
  });

  it("renders resolved economics with sign and PF formatting", () => {
    const obs: KronosCounterfactualObservation = {
      observationId: "X1",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T01:00:00.000Z",
      lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
      symbol: "TESTUSDT",
      selectionBatchId: "batch-x",
      duplicateKey: "k",
      snapshot: {
        direction: "SHORT", symbol: "TESTUSDT", marketRegime: null,
        kronosBias: "LONG", kronosAgrees: false, liveSourceConflict: false,
        horizonConflict: false, whaleSignal: "BEARISH", whaleAvailable: true,
        opportunityScore: 80, finalStatusObserved: "WATCH",
        selectedEntryVariant: "vwap_retest_entry", selectedExitVariant: "tp1_full_exit",
        plannedEntryPrice: 100, stopPrice: 102, tp1Price: 97, tp2Price: null, tp3Price: null,
        stopDistanceBps: 200, costR: 0.1, notes: [],
      },
      observationStatus: "RESOLVED",
      outcome: {
        realizedGrossR: -0.5, realizedNetR: -0.6, winnerLabel: "LOSS",
        tp1Hit: false, tp2Hit: false, slHit: true, closeReason: "SL",
        openedAt: "2026-05-20T00:05:00.000Z", closedAt: "2026-05-20T01:00:00.000Z",
        durationMinutes: 55, fillStatus: "FILLED",
      },
      diagnostics: {
        createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
        admissionReasonCodes: [], resolutionSemantics: "test",
      },
    };
    const report = buildKronosCounterfactualReport([obs], new Date("2026-05-20T02:00:00.000Z"));
    const dash = buildDashboardAuditSummaryReport([], { kronosCounterfactual: report });
    expect(dash.summaryText).toMatch(/disagreement lane: total=1 \| open=0 \| resolved=1 \| netAvgR=-0\.6000R \| PF=0\.00 \| WR=0%/);
  });
});

describe("no live behavior impact", () => {
  it("dashboard summary text contains all standard sections unchanged when counterfactual is empty", () => {
    const dash = buildDashboardAuditSummaryReport([]);
    // Existing landmark sections still present
    expect(dash.summaryText).toContain("J*. KRONOS COUNTERFACTUAL EVIDENCE");
    expect(dash.summaryText).toContain("K. REGIME POLICY COUNTERFACTUAL");
    expect(dash.summaryText).toContain("L. FORWARD REGIME OVERLAY");
  });
});

// ─── Milestone observation builder helper ────────────────────────────────────

interface MakeMilestoneObsOpts {
  lane?: KronosCounterfactualLane;
  realizedNetR: number;
  direction?: "LONG" | "SHORT";
  symbol?: string;
  createdAt?: string;
}

function makeMilestoneObs(opts: MakeMilestoneObsOpts): KronosCounterfactualObservation {
  return {
    observationId: Math.random().toString(36).slice(2),
    createdAt: opts.createdAt ?? "2026-05-20T00:00:00.000Z",
    updatedAt: opts.createdAt ?? "2026-05-20T01:00:00.000Z",
    lane: opts.lane ?? "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
    symbol: opts.symbol ?? "BTCUSDT",
    selectionBatchId: "batch-milestone",
    duplicateKey: Math.random().toString(36).slice(2),
    snapshot: {
      direction: opts.direction ?? "SHORT",
      symbol: opts.symbol ?? "BTCUSDT",
      marketRegime: null,
      kronosBias: "LONG",
      kronosAgrees: false,
      liveSourceConflict: false,
      horizonConflict: false,
      whaleSignal: null,
      whaleAvailable: false,
      opportunityScore: 75,
      finalStatusObserved: "WATCH",
      selectedEntryVariant: "vwap_retest_entry",
      selectedExitVariant: "tp1_full_exit",
      plannedEntryPrice: 100,
      stopPrice: 102,
      tp1Price: 97,
      tp2Price: null,
      tp3Price: null,
      stopDistanceBps: 200,
      costR: 0.1,
      notes: [],
    },
    observationStatus: "RESOLVED",
    outcome: {
      realizedGrossR: opts.realizedNetR + 0.1,
      realizedNetR: opts.realizedNetR,
      winnerLabel: opts.realizedNetR > 0.05 ? "WIN" : opts.realizedNetR < -0.05 ? "LOSS" : "BREAKEVEN",
      tp1Hit: opts.realizedNetR > 0,
      tp2Hit: false,
      slHit: opts.realizedNetR < 0,
      closeReason: opts.realizedNetR > 0 ? "TP1_FULL" : "SL",
      openedAt: opts.createdAt ?? "2026-05-20T00:05:00.000Z",
      closedAt: opts.createdAt ?? "2026-05-20T01:00:00.000Z",
      durationMinutes: 55,
      fillStatus: "FILLED",
    },
    diagnostics: {
      createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
      admissionReasonCodes: ["KRONOS_BIAS_OPPOSITE_TO_TRADE_DIRECTION"],
      resolutionSemantics: "test",
    },
  };
}

describe("KronosCounterfactualValidationMilestones", () => {
  const LANE: KronosCounterfactualLane = "KRONOS_DISAGREEMENT_COUNTERFACTUAL";

  // Test A: TOO_EARLY when n=5
  it("A: overallStatus === TOO_EARLY when resolved n=5", () => {
    const obs = Array.from({ length: 5 }, (_, i) =>
      makeMilestoneObs({ realizedNetR: -0.8, direction: "SHORT", symbol: `SYM${i}USDT` }),
    );
    const result = computeValidationMilestones(LANE, obs);
    expect(result.resolvedN).toBe(5);
    expect(result.overallStatus).toBe("TOO_EARLY");
  });

  // Test B: PROMISING_BUT_CONCENTRATED when n=25, days=3
  it("B: overallStatus === PROMISING_BUT_CONCENTRATED when n=25, days=3", () => {
    const dates = ["2026-05-18", "2026-05-19", "2026-05-20"];
    const obs = Array.from({ length: 25 }, (_, i) =>
      makeMilestoneObs({
        realizedNetR: -0.5,
        direction: "SHORT",
        symbol: `SYM${i % 5}USDT`,
        createdAt: `${dates[i % 3]}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const result = computeValidationMilestones(LANE, obs);
    expect(result.resolvedN).toBe(25);
    expect(result.distinctCalendarDays).toBe(3);
    expect(result.overallStatus).toBe("PROMISING_BUT_CONCENTRATED");
  });

  // Test C: ROBUST_VALIDATION_CANDIDATE when all milestones clear
  it("C: overallStatus === ROBUST_VALIDATION_CANDIDATE when all milestones clear", () => {
    // 60 obs, 6+ distinct dates, both directions negative,
    // at least 6 symbols so ex-top-2 still has enough obs with negative economics
    const dates = ["2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19"];
    // Use 6 symbols: sym0..sym5; each with some observations.
    // sym0 and sym1 get the most-negative netSumR (10 obs each at -2.0)
    // sym2..sym5 get remaining obs at -0.5 each (guaranteed ex-top2 avg < -0.10)
    const obs: KronosCounterfactualObservation[] = [];
    // 10 obs for sym0 (top-loss symbol A)
    for (let i = 0; i < 10; i++) {
      obs.push(makeMilestoneObs({
        realizedNetR: -2.0,
        direction: i % 2 === 0 ? "LONG" : "SHORT",
        symbol: "SYM0USDT",
        createdAt: `${dates[i % dates.length]}T00:00:00.000Z`,
      }));
    }
    // 10 obs for sym1 (top-loss symbol B)
    for (let i = 0; i < 10; i++) {
      obs.push(makeMilestoneObs({
        realizedNetR: -1.5,
        direction: i % 2 === 0 ? "LONG" : "SHORT",
        symbol: "SYM1USDT",
        createdAt: `${dates[i % dates.length]}T01:00:00.000Z`,
      }));
    }
    // 40 obs for sym2..sym5, equally split LONG/SHORT, all negative
    for (let i = 0; i < 40; i++) {
      obs.push(makeMilestoneObs({
        realizedNetR: -0.5,
        direction: i % 2 === 0 ? "LONG" : "SHORT",
        symbol: `SYM${(i % 4) + 2}USDT`,
        createdAt: `${dates[i % dates.length]}T02:00:00.000Z`,
      }));
    }
    expect(obs.length).toBe(60);
    const result = computeValidationMilestones(LANE, obs);
    expect(result.resolvedN).toBe(60);
    expect(result.resolvedNCleared).toBe(true);
    expect(result.distinctCalendarDays).toBeGreaterThanOrEqual(5);
    expect(result.calendarDaysCleared).toBe(true);
    expect(result.exTop2SymbolNetAvgR).not.toBeNull();
    expect(result.exTop2SymbolNetAvgR!).toBeLessThanOrEqual(-0.10);
    expect(result.exTop2SymbolProfitFactor).not.toBeNull();
    expect(result.exTop2SymbolProfitFactor!).toBeLessThan(0.30);
    expect(result.exTop2Cleared).toBe(true);
    expect(result.longNetAvgR).not.toBeNull();
    expect(result.shortNetAvgR).not.toBeNull();
    expect(result.longNetAvgR!).toBeLessThan(0);
    expect(result.shortNetAvgR!).toBeLessThan(0);
    expect(result.bothDirectionsNegative).toBe(true);
    expect(result.overallStatus).toBe("ROBUST_VALIDATION_CANDIDATE");
  });

  // Test D: exTop2 correctly excludes top-2 loss symbols
  it("D: exTop2 computes from remaining symbols after excluding the 2 worst", () => {
    // 4 symbols: sym1 netSum=-10, sym2 netSum=-8, sym3 netSum=-0.5, sym4 netSum=0.2
    // top-2 by most-negative: sym1, sym2 — excluded
    // remaining: sym3 (-0.5) and sym4 (+0.2) across 10 obs total
    const obs: KronosCounterfactualObservation[] = [
      // sym1: 2 obs at -5 each
      makeMilestoneObs({ realizedNetR: -5, symbol: "SYM1USDT" }),
      makeMilestoneObs({ realizedNetR: -5, symbol: "SYM1USDT" }),
      // sym2: 2 obs at -4 each
      makeMilestoneObs({ realizedNetR: -4, symbol: "SYM2USDT" }),
      makeMilestoneObs({ realizedNetR: -4, symbol: "SYM2USDT" }),
      // sym3: 3 obs at -0.5 (known remaining bad)
      makeMilestoneObs({ realizedNetR: -0.5, symbol: "SYM3USDT" }),
      makeMilestoneObs({ realizedNetR: -0.5, symbol: "SYM3USDT" }),
      makeMilestoneObs({ realizedNetR: -0.5, symbol: "SYM3USDT" }),
      // sym4: 3 obs at +0.2 (known remaining good)
      makeMilestoneObs({ realizedNetR: 0.2, symbol: "SYM4USDT" }),
      makeMilestoneObs({ realizedNetR: 0.2, symbol: "SYM4USDT" }),
      makeMilestoneObs({ realizedNetR: 0.2, symbol: "SYM4USDT" }),
    ];
    const result = computeValidationMilestones(LANE, obs);
    // ex-top2 should be computed from sym3 + sym4 only
    // sym3 sum = -1.5, sym4 sum = +0.6; 6 obs total
    // expected avg = (-1.5 + 0.6) / 6 = -0.15
    expect(result.exTop2SymbolNetAvgR).not.toBeNull();
    // Confirm the value is from sym3+sym4 only (not polluted by sym1/sym2)
    // If sym1+sym2 were included: (-10-8-1.5+0.6)/10 = -1.89; clearly different
    const expectedAvg = (-0.5 * 3 + 0.2 * 3) / 6;
    expect(result.exTop2SymbolNetAvgR).toBeCloseTo(expectedAvg, 3);
  });

  // Test E: bothDirectionsNegative === false when SHORT obs missing
  it("E: bothDirectionsNegative === false when only LONG observations present", () => {
    const obs = Array.from({ length: 10 }, () =>
      makeMilestoneObs({ realizedNetR: -0.8, direction: "LONG" }),
    );
    const result = computeValidationMilestones(LANE, obs);
    expect(result.shortNetAvgR).toBeNull();
    expect(result.bothDirectionsNegative).toBe(false);
  });

  // Test F: Dashboard text contains "validation milestones:" when counterfactual data is passed
  it("F: dashboard text contains 'validation milestones:' when counterfactual report is supplied", () => {
    const report = buildKronosCounterfactualReport([], new Date("2026-05-20T00:00:00.000Z"));
    const dash = buildDashboardAuditSummaryReport([], { kronosCounterfactual: report });
    expect(dash.summaryText).toContain("validation milestones:");
    expect(dash.summaryText).toContain("- disagreement: n=0/60");
    expect(dash.summaryText).toContain("- live-source-conflict: n=0/60");
  });

  // Test G: Existing economics lines still render (regression check)
  it("G: existing economics lines still render in J* section (no regression)", () => {
    const obs: KronosCounterfactualObservation = {
      observationId: "G1",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T01:00:00.000Z",
      lane: "KRONOS_DISAGREEMENT_COUNTERFACTUAL",
      symbol: "TESTUSDT",
      selectionBatchId: "batch-g",
      duplicateKey: "kg1",
      snapshot: {
        direction: "SHORT", symbol: "TESTUSDT", marketRegime: null,
        kronosBias: "LONG", kronosAgrees: false, liveSourceConflict: false,
        horizonConflict: false, whaleSignal: "BEARISH", whaleAvailable: true,
        opportunityScore: 80, finalStatusObserved: "WATCH",
        selectedEntryVariant: "vwap_retest_entry", selectedExitVariant: "tp1_full_exit",
        plannedEntryPrice: 100, stopPrice: 102, tp1Price: 97, tp2Price: null, tp3Price: null,
        stopDistanceBps: 200, costR: 0.1, notes: [],
      },
      observationStatus: "RESOLVED",
      outcome: {
        realizedGrossR: -0.5, realizedNetR: -0.6, winnerLabel: "LOSS",
        tp1Hit: false, tp2Hit: false, slHit: true, closeReason: "SL",
        openedAt: "2026-05-20T00:05:00.000Z", closedAt: "2026-05-20T01:00:00.000Z",
        durationMinutes: 55, fillStatus: "FILLED",
      },
      diagnostics: {
        createdByPolicyVersion: KRONOS_COUNTERFACTUAL_POLICY_VERSION,
        admissionReasonCodes: [], resolutionSemantics: "test",
      },
    };
    const report = buildKronosCounterfactualReport([obs], new Date("2026-05-20T02:00:00.000Z"));
    const dash = buildDashboardAuditSummaryReport([], { kronosCounterfactual: report });
    // Original economics line still present
    expect(dash.summaryText).toMatch(/disagreement lane: total=1 \| open=0 \| resolved=1 \| netAvgR=-0\.6000R \| PF=0\.00 \| WR=0%/);
    // Milestone line also present
    expect(dash.summaryText).toContain("validation milestones:");
    expect(dash.summaryText).toContain("- disagreement: n=1/60");
    // Verdict still present
    expect(dash.summaryText).toContain("verdict: TOO_EARLY");
    expect(dash.summaryText).toContain("report-only, no behavior influence");
  });
});

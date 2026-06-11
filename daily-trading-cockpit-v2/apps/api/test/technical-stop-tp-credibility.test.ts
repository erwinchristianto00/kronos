import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import Fastify from "fastify";

import type { StrategyExperienceRecord } from "@dtc/shared";
import type { ShadowPosition } from "@dtc/shared";

import {
  buildTechnicalStopTpCredibilityReport,
} from "../src/lib/technical-stop-tp-credibility.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

let __metadataSnapshotTempDir: string;
let __originalSnapshotPath: string | undefined;

beforeAll(() => {
  __metadataSnapshotTempDir = mkdtempSync(join(tmpdir(), "ext-meta-test-"));
  __originalSnapshotPath = process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = join(__metadataSnapshotTempDir, "snapshot.json");
});

afterAll(() => {
  if (__originalSnapshotPath === undefined) {
    delete process.env.EXTERNAL_METADATA_SNAPSHOT_PATH;
  } else {
    process.env.EXTERNAL_METADATA_SNAPSHOT_PATH = __originalSnapshotPath;
  }
  rmSync(__metadataSnapshotTempDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: {
  winnerLabel?: "WIN" | "LOSS" | "BREAKEVEN";
  maeR?: number | null;
  mfeR?: number | null;
  realizedPathAvailable?: boolean;
  realizedGrossR?: number | null;
  realizedNetR?: number | null;
  entryVariant?: string;
  exitVariant?: string;
  symbol?: string;
  direction?: "LONG" | "SHORT";
  evidenceEra?: string;
  closeReason?: string;
} = {}): StrategyExperienceRecord {
  const {
    winnerLabel = "WIN",
    maeR = 0.3,
    mfeR = 0.8,
    realizedPathAvailable = true,
    realizedGrossR = 0.5,
    realizedNetR = 0.45,
    entryVariant = "vwap_retest_entry",
    exitVariant = "tp1_full_exit",
    symbol = "BTCUSDT",
    direction = "LONG",
    evidenceEra = "POST_CALIBRATION",
    closeReason = "TP1_FULL",
  } = overrides;

  return {
    context: {
      schemaVersion: 1,
      symbol,
      direction,
      evidenceEra: evidenceEra as "POST_CALIBRATION" | "POST_ROUTING_PRE_CALIBRATION" | "LEGACY_PRE_ROUTING" | undefined,
      selectedEntryVariant: entryVariant as never,
      selectedExitVariant: exitVariant as never,
      routeMode: "PROFIT_CANDIDATE",
    } as unknown as StrategyExperienceRecord["context"],
    outcome: {
      schemaVersion: 1,
      positionId: `pos-${Math.random().toString(36).slice(2)}`,
      symbol,
      direction,
      winnerLabel,
      maeR: maeR ?? undefined,
      mfeR: mfeR ?? undefined,
      realizedPathAvailable,
      realizedGrossR: realizedGrossR ?? undefined,
      realizedNetR: realizedNetR ?? undefined,
      closeReason: closeReason as never,
      selectedEntryVariant: entryVariant as never,
      selectedExitVariant: exitVariant as never,
      evidenceEra: evidenceEra as never,
    } as unknown as StrategyExperienceRecord["outcome"],
  };
}

function makeLoser(overrides: Parameters<typeof makeRecord>[0] = {}): StrategyExperienceRecord {
  return makeRecord({
    winnerLabel: "LOSS",
    maeR: 1.0,
    mfeR: 0.2,
    realizedGrossR: -0.9,
    realizedNetR: -0.95,
    closeReason: "SL",
    ...overrides,
  });
}

function makeWinner(overrides: Parameters<typeof makeRecord>[0] = {}): StrategyExperienceRecord {
  return makeRecord({
    winnerLabel: "WIN",
    maeR: 0.3,
    mfeR: 0.8,
    realizedGrossR: 0.5,
    realizedNetR: 0.45,
    closeReason: "TP1_FULL",
    ...overrides,
  });
}

// ─── 1. Safe empty report ─────────────────────────────────────────────────────

describe("buildTechnicalStopTpCredibilityReport — empty input", () => {
  it("returns a safe report with zero path data without throwing", () => {
    const r = buildTechnicalStopTpCredibilityReport([]);
    expect(r.totalResolvedExperienceRecords).toBe(0);
    expect(r.recordsWithRealizedPath).toBe(0);
    expect(r.recordsWithoutRealizedPath).toBe(0);
    expect(r.realizedPathCoveragePct).toBe(0);
    expect(r.baselinePathMetrics).toBeNull();
    expect(r.readiness.advisoryEngineReady).toBe(false);
    expect(r.readiness.readyForBehaviorInfluence).toBe(false);
    expect(r.readiness.reasons.length).toBeGreaterThan(0);
    expect(r.stopSurvivalProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
    expect(r.favorableExcursionProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
    expect(r.captureEfficiencyProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
    expect(r.routeAssessments).toEqual([]);
    expect(r.symbolDirectionAssessments).toEqual([]);
    expect(r.patchHypotheses.length).toBeGreaterThan(0);
    expect(r.answerCards.length).toBe(5);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.generatedAt).toBeTruthy();
    expect(r.evidenceEra).toBe("POST_CALIBRATION");
  });

  it("path hypothesis doesNotImplementNow is always true", () => {
    const r = buildTechnicalStopTpCredibilityReport([]);
    for (const h of r.patchHypotheses) {
      expect(h.doesNotImplementNow).toBe(true);
    }
  });
});

// ─── 2. Path eligibility ──────────────────────────────────────────────────────

describe("path eligibility", () => {
  it("counts records with realizedPathAvailable=true", () => {
    const records = [
      makeWinner({ realizedPathAvailable: true }),
      makeWinner({ realizedPathAvailable: false, maeR: null, mfeR: null }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.recordsWithRealizedPath).toBe(1);
    expect(r.recordsWithoutRealizedPath).toBe(1);
    expect(r.realizedPathCoveragePct).toBeCloseTo(0.5, 3);
  });

  it("counts records with both maeR and mfeR present as path-available even without explicit flag", () => {
    const records = [
      makeRecord({ realizedPathAvailable: false, maeR: 0.3, mfeR: 0.8 }),
      makeRecord({ realizedPathAvailable: false, maeR: null, mfeR: null }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.recordsWithRealizedPath).toBe(1);
  });

  it("excludes records missing MAE/MFE from path metrics", () => {
    const records = [
      makeWinner({ realizedPathAvailable: false, maeR: null, mfeR: null }),
      makeWinner({ realizedPathAvailable: false, maeR: null, mfeR: null }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.recordsWithRealizedPath).toBe(0);
    expect(r.baselinePathMetrics).toBeNull();
    expect(r.stopSurvivalProfile.winnerPathCount).toBe(0);
  });

  it("filters by POST_CALIBRATION era by default", () => {
    const records = [
      makeWinner({ evidenceEra: "POST_CALIBRATION" }),
      makeWinner({ evidenceEra: "LEGACY_PRE_ROUTING" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.totalResolvedExperienceRecords).toBe(1);
  });

  it("includes all eras when evidenceEra=ALL_TIME", () => {
    const records = [
      makeWinner({ evidenceEra: "POST_CALIBRATION" }),
      makeWinner({ evidenceEra: "LEGACY_PRE_ROUTING" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records, { evidenceEra: "ALL_TIME" });
    expect(r.totalResolvedExperienceRecords).toBe(2);
  });
});

// ─── 3. Stop survival profile ─────────────────────────────────────────────────

describe("stop survival profile", () => {
  it("computes avg winner MAE and threshold percentages correctly", () => {
    // 3 winners with MAE = 0.1, 0.6, 0.8
    const records = [
      makeWinner({ maeR: 0.1, mfeR: 0.5 }),
      makeWinner({ maeR: 0.6, mfeR: 1.2 }),
      makeWinner({ maeR: 0.8, mfeR: 1.5 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const profile = r.stopSurvivalProfile;
    expect(profile.winnerPathCount).toBe(3);
    expect(profile.avgWinnerMaeR).toBeCloseTo((0.1 + 0.6 + 0.8) / 3, 3);
    // pct >= 0.25: all 3 (0.6, 0.8 are >=0.25, 0.1 is not) → 2/3
    expect(profile.pctWinnersMaeGte0_25R).toBeCloseTo(2 / 3, 3);
    // pct >= 0.50: 2/3 (0.6, 0.8)
    expect(profile.pctWinnersMaeGte0_50R).toBeCloseTo(2 / 3, 3);
    // pct >= 0.75: 1/3 (only 0.8)
    expect(profile.pctWinnersMaeGte0_75R).toBeCloseTo(1 / 3, 3);
    // pct >= 0.90: 0/3
    expect(profile.pctWinnersMaeGte0_90R).toBe(0);
  });

  it("returns INSUFFICIENT_PATH_DATA when fewer than 3 winners", () => {
    const records = [makeWinner(), makeWinner()];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.stopSurvivalProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
  });

  it("classifies WINNERS_REQUIRE_BREATHING_ROOM when >25% survive >0.50R", () => {
    // 4 winners, 2 with MAE > 0.5
    const records = [
      makeWinner({ maeR: 0.6 }),
      makeWinner({ maeR: 0.8 }),
      makeWinner({ maeR: 0.1 }),
      makeWinner({ maeR: 0.2 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.stopSurvivalProfile.verdict).toBe("WINNERS_REQUIRE_BREATHING_ROOM");
  });

  it("classifies WINNERS_SHOW_LOW_ADVERSE_STRESS when avg MAE is low", () => {
    const records = [
      makeWinner({ maeR: 0.05 }),
      makeWinner({ maeR: 0.08 }),
      makeWinner({ maeR: 0.10 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.stopSurvivalProfile.verdict).toBe("WINNERS_SHOW_LOW_ADVERSE_STRESS");
  });
});

// ─── 4. Favorable excursion profile ──────────────────────────────────────────

describe("favorable excursion profile", () => {
  it("computes avg loser MFE and threshold percentages correctly", () => {
    // 3 losers with MFE = 0.1, 0.6, 0.8
    const records = [
      makeLoser({ mfeR: 0.1, maeR: 1.0 }),
      makeLoser({ mfeR: 0.6, maeR: 1.0 }),
      makeLoser({ mfeR: 0.8, maeR: 1.0 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const profile = r.favorableExcursionProfile;
    expect(profile.loserPathCount).toBe(3);
    expect(profile.avgLoserMfeR).toBeCloseTo((0.1 + 0.6 + 0.8) / 3, 3);
    // pct >= 0.25: 2/3 (0.6, 0.8)
    expect(profile.pctLosersMfeGte0_25R).toBeCloseTo(2 / 3, 3);
    // pct >= 0.50: 2/3 (0.6, 0.8)
    expect(profile.pctLosersMfeGte0_50R).toBeCloseTo(2 / 3, 3);
    // pct >= 0.75: 1/3 (0.8)
    expect(profile.pctLosersMfeGte0_75R).toBeCloseTo(1 / 3, 3);
    // pct >= 1.00: 0/3
    expect(profile.pctLosersMfeGte1_00R).toBe(0);
  });

  it("returns INSUFFICIENT_PATH_DATA when fewer than 3 losers", () => {
    const records = [makeLoser(), makeLoser()];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.favorableExcursionProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
  });

  it("classifies LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION when >25% of losers have MFE >0.50R", () => {
    const records = [
      makeLoser({ mfeR: 0.7 }),
      makeLoser({ mfeR: 0.9 }),
      makeLoser({ mfeR: 0.0 }),
      makeLoser({ mfeR: 0.1 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.favorableExcursionProfile.verdict).toBe("LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION");
  });

  it("classifies LOSERS_SHOW_LITTLE_FAVORABLE_EXCURSION when avg loser MFE is very low", () => {
    const records = [
      makeLoser({ mfeR: 0.05 }),
      makeLoser({ mfeR: 0.07 }),
      makeLoser({ mfeR: 0.10 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.favorableExcursionProfile.verdict).toBe("LOSERS_SHOW_LITTLE_FAVORABLE_EXCURSION");
  });
});

// ─── 5. TP capture efficiency profile ────────────────────────────────────────

describe("TP capture efficiency profile", () => {
  it("computes capture metrics for winners with both MFE and realized R", () => {
    // winners: MFE=1.2 vs grossR=0.5 → ratio 2.4× (conservative)
    const records = [
      makeWinner({ mfeR: 1.2, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 1.5, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 0.9, realizedGrossR: 0.5 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const profile = r.captureEfficiencyProfile;
    expect(profile.winnerPathCount).toBe(3);
    expect(profile.avgWinnerMfeR).toBeCloseTo((1.2 + 1.5 + 0.9) / 3, 3);
    expect(profile.avgWinnerGrossRealizedR).toBeCloseTo(0.5, 3);
    // capture ratios: 0.5/1.2, 0.5/1.5, 0.5/0.9
    const expectedCapture = ((0.5 / 1.2 + 0.5 / 1.5 + 0.5 / 0.9) / 3);
    expect(profile.avgGrossCapturePctOfMfe).toBeCloseTo(expectedCapture, 2);
    // pct MFE >= 1.5× gross: all 3 have MFE >= 0.75 (0.5 * 1.5)
    expect(profile.pctWinnersMfeAtLeast1_5xRealizedGrossR).toBeCloseTo(1.0, 2);
    // pct MFE >= 2.0× gross: MFE >= 1.0 → 1.2 and 1.5 qualify (not 0.9) → 2/3
    expect(profile.pctWinnersMfeAtLeast2_0xRealizedGrossR).toBeCloseTo(2 / 3, 2);
  });

  it("returns INSUFFICIENT_PATH_DATA when fewer than 3 winners", () => {
    const records = [makeWinner(), makeWinner()];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.captureEfficiencyProfile.verdict).toBe("INSUFFICIENT_PATH_DATA");
  });

  it("classifies TP_CAPTURE_LOOKS_CONSERVATIVE when capture pct is low and MFE is wide", () => {
    // MFE = 2× gross → capture ratio ~0.5, pct1.5× = 100%
    const records = [
      makeWinner({ mfeR: 2.0, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 2.0, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 2.0, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 2.0, realizedGrossR: 0.5 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.captureEfficiencyProfile.verdict).toBe("TP_CAPTURE_LOOKS_CONSERVATIVE");
  });

  it("classifies TP_CAPTURE_LOOKS_REASONABLE when capture pct is high", () => {
    // MFE = 0.6, gross = 0.5 → capture ratio ~0.83
    const records = [
      makeWinner({ mfeR: 0.6, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 0.55, realizedGrossR: 0.5 }),
      makeWinner({ mfeR: 0.65, realizedGrossR: 0.5 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.captureEfficiencyProfile.verdict).toBe("TP_CAPTURE_LOOKS_REASONABLE");
  });
});

// ─── 6. Route-level assessment ────────────────────────────────────────────────

describe("route-level assessments", () => {
  it("groups records by entryVariant + exitVariant", () => {
    const records = [
      makeWinner({ entryVariant: "entry_a", exitVariant: "exit_x" }),
      makeWinner({ entryVariant: "entry_a", exitVariant: "exit_x" }),
      makeLoser({ entryVariant: "entry_b", exitVariant: "exit_y" }),
      makeLoser({ entryVariant: "entry_b", exitVariant: "exit_y" }),
      makeLoser({ entryVariant: "entry_b", exitVariant: "exit_y" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.routeAssessments.length).toBe(2);
    const routeA = r.routeAssessments.find((ra) => ra.routeLabel === "entry_a + exit_x")!;
    const routeB = r.routeAssessments.find((ra) => ra.routeLabel === "entry_b + exit_y")!;
    expect(routeA).toBeTruthy();
    expect(routeB).toBeTruthy();
    expect(routeA.winCountWithPath).toBe(2);
    expect(routeA.lossCountWithPath).toBe(0);
    expect(routeB.lossCountWithPath).toBe(3);
  });

  it("assigns correct sample tiers", () => {
    const records = [
      makeWinner({ entryVariant: "a", exitVariant: "x" }),
      makeWinner({ entryVariant: "a", exitVariant: "x" }),
    ]; // 2 records → TOO_EARLY
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.routeAssessments[0]!.pathSampleTier).toBe("TOO_EARLY");
  });

  it("does not emit strong verdicts for TOO_EARLY or EMPTY tier", () => {
    const records = [
      makeWinner({ maeR: 0.9, entryVariant: "a", exitVariant: "x" }),
      makeLoser({ mfeR: 0.9, entryVariant: "a", exitVariant: "x" }),
    ]; // 2 → TOO_EARLY
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.routeAssessments[0]!.routeVerdict).toBe("INSUFFICIENT_PATH_DATA");
  });

  it("emits STOP_STRESS_ELEVATED for routes where many winners absorb >0.5R MAE", () => {
    // Need >= EARLY (3+) records with >= 3 winners to trigger stop stress verdict
    const records = [
      makeWinner({ maeR: 0.7, mfeR: 1.0, entryVariant: "a", exitVariant: "x" }),
      makeWinner({ maeR: 0.8, mfeR: 1.0, entryVariant: "a", exitVariant: "x" }),
      makeWinner({ maeR: 0.6, mfeR: 1.0, entryVariant: "a", exitVariant: "x" }),
      makeLoser({ maeR: 1.0, mfeR: 0.1, entryVariant: "a", exitVariant: "x" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.routeAssessments[0]!.routeVerdict).toBe("STOP_STRESS_ELEVATED");
  });
});

// ─── 7. Symbol-direction-route assessment ────────────────────────────────────

describe("symbol-direction-route assessments", () => {
  it("groups by symbol + direction + routeLabel", () => {
    const records = [
      makeWinner({ symbol: "BTCUSDT", direction: "LONG", entryVariant: "a", exitVariant: "x" }),
      makeWinner({ symbol: "BTCUSDT", direction: "LONG", entryVariant: "a", exitVariant: "x" }),
      makeWinner({ symbol: "ETHUSDT", direction: "SHORT", entryVariant: "a", exitVariant: "x" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    expect(r.symbolDirectionAssessments.length).toBe(2);
    const btcSlice = r.symbolDirectionAssessments.find((s) => s.symbol === "BTCUSDT" && s.direction === "LONG");
    expect(btcSlice).toBeTruthy();
    expect(btcSlice!.closedWithPathCount).toBe(2);
  });

  it("does not overstate verdicts on tiny n", () => {
    const records = [
      makeWinner({ symbol: "BTCUSDT", direction: "LONG", maeR: 0.9 }),
    ]; // 1 record
    const r = buildTechnicalStopTpCredibilityReport(records);
    const slice = r.symbolDirectionAssessments[0]!;
    expect(slice.localVerdict).toBe("INSUFFICIENT_PATH_DATA");
  });

  it("assigns EARLY_STOP_STRESS for slice with high winner MAE", () => {
    // 3+ records, winners with high MAE
    const records = [
      makeWinner({ symbol: "BTCUSDT", direction: "LONG", maeR: 0.8, entryVariant: "a", exitVariant: "x" }),
      makeWinner({ symbol: "BTCUSDT", direction: "LONG", maeR: 0.9, entryVariant: "a", exitVariant: "x" }),
      makeLoser({ symbol: "BTCUSDT", direction: "LONG", mfeR: 0.1, entryVariant: "a", exitVariant: "x" }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const slice = r.symbolDirectionAssessments.find(
      (s) => s.symbol === "BTCUSDT" && s.direction === "LONG",
    )!;
    expect(slice.localVerdict).toBe("EARLY_STOP_STRESS");
  });
});

// ─── 8. Patch hypotheses ──────────────────────────────────────────────────────

describe("patch hypotheses", () => {
  it("are conservative — no tiny sample should reach READY_FOR_PATCH_DISCUSSION", () => {
    const records = [makeWinner(), makeWinner(), makeLoser()];
    const r = buildTechnicalStopTpCredibilityReport(records);
    for (const h of r.patchHypotheses) {
      expect(h.patchStatus).not.toBe("READY_FOR_PATCH_DISCUSSION");
      expect(h.doesNotImplementNow).toBe(true);
    }
  });

  it("never reach READY_FOR_PATCH_DISCUSSION regardless of path sample size", () => {
    // Even with 100 clear records, patch status should remain WATCH or AUDIT_DEEPER
    const records: StrategyExperienceRecord[] = [];
    for (let i = 0; i < 50; i++) records.push(makeWinner({ maeR: 0.8, mfeR: 2.0 }));
    for (let i = 0; i < 50; i++) records.push(makeLoser({ mfeR: 0.9, maeR: 1.0 }));
    const r = buildTechnicalStopTpCredibilityReport(records);
    for (const h of r.patchHypotheses) {
      expect(h.patchStatus).not.toBe("READY_FOR_PATCH_DISCUSSION");
    }
  });

  it("generates stop stress hypothesis when winners show high MAE", () => {
    const records = [
      makeWinner({ maeR: 0.7 }), makeWinner({ maeR: 0.8 }), makeWinner({ maeR: 0.6 }),
      makeLoser(), makeLoser(), makeLoser(),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const hypothesis = r.patchHypotheses.find(
      (h) => h.likelyFutureAction === "AUDIT_WIDER_TECHNICAL_INVALIDATION",
    );
    expect(hypothesis).toBeTruthy();
  });
});

// ─── 9. Endpoint ──────────────────────────────────────────────────────────────

describe("GET /api/shadow/technical-stop-tp-credibility endpoint", () => {
  async function buildApp(positions: ShadowPosition[] = []) {
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, {
      getAllPositions() { return positions; },
    } as never);
    return app;
  }

  it("responds 200 with default POST_CALIBRATION era", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/shadow/technical-stop-tp-credibility" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidenceEra).toBe("POST_CALIBRATION");
    expect(body.generatedAt).toBeTruthy();
    expect(body.readiness).toBeTruthy();
    expect(body.readiness.readyForBehaviorInfluence).toBe(false);
  });

  it("responds 200 with ALL_TIME era", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/shadow/technical-stop-tp-credibility?era=ALL_TIME",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().evidenceEra).toBe("ALL_TIME");
  });

  it("ignores unknown era param and defaults to POST_CALIBRATION", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/shadow/technical-stop-tp-credibility?era=INVALID",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().evidenceEra).toBe("POST_CALIBRATION");
  });

  it("is read-only — does not expose routeMode, tradeCaps, or promotionThresholds", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/shadow/technical-stop-tp-credibility" });
    const body = res.json();
    expect(body.routeMode).toBeUndefined();
    expect(body.tradeCaps).toBeUndefined();
    expect(body.promotionThresholds).toBeUndefined();
  });

  it("returns 503 when shadowEngine is null", async () => {
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null);
    const res = await app.inject({ method: "GET", url: "/api/shadow/technical-stop-tp-credibility" });
    expect(res.statusCode).toBe(503);
  });
});

// ─── 10. Dashboard Audit Summary update ──────────────────────────────────────

describe("dashboard audit summary — technicalStopTpCredibility section", () => {
  it("includes the new section label N in summaryText", async () => {
    const { buildDashboardAuditSummaryReport } = await import("../src/lib/dashboard-audit-summary.js");
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("N. TECHNICAL STOP/TP CREDIBILITY");
  });

  it("includes technicalStopTpCredibility in highlights", async () => {
    const { buildDashboardAuditSummaryReport } = await import("../src/lib/dashboard-audit-summary.js");
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.highlights.technicalStopTpCredibility).toBeTruthy();
  });

  it("highlights show readyForBehaviorInfluence=false", async () => {
    const { buildDashboardAuditSummaryReport } = await import("../src/lib/dashboard-audit-summary.js");
    const report = buildDashboardAuditSummaryReport([]);
    const hl = report.highlights.technicalStopTpCredibility as Record<string, unknown>;
    expect(hl.readyForBehaviorInfluence).toBe(false);
  });

  it("summary stays safe when report has zero path data (no crash)", async () => {
    const { buildDashboardAuditSummaryReport } = await import("../src/lib/dashboard-audit-summary.js");
    expect(() => buildDashboardAuditSummaryReport([])).not.toThrow();
  });

  it("preserves all existing sections A through M", async () => {
    const { buildDashboardAuditSummaryReport } = await import("../src/lib/dashboard-audit-summary.js");
    const report = buildDashboardAuditSummaryReport([]);
    expect(report.summaryText).toContain("A. BOT STATE");
    expect(report.summaryText).toContain("M. ONE-LINE EXECUTIVE TAKEAWAY");
  });
});

// ─── 11. Baseline path metrics ────────────────────────────────────────────────

describe("baseline path metrics", () => {
  it("returns null when no path records exist", () => {
    const r = buildTechnicalStopTpCredibilityReport([]);
    expect(r.baselinePathMetrics).toBeNull();
  });

  it("computes correct baseline stats for mixed path records", () => {
    const records = [
      makeWinner({ realizedNetR: 0.4, realizedGrossR: 0.45, maeR: 0.2, mfeR: 0.8 }),
      makeWinner({ realizedNetR: 0.6, realizedGrossR: 0.65, maeR: 0.3, mfeR: 1.0 }),
      makeLoser({ realizedNetR: -0.9, realizedGrossR: -0.85, maeR: 1.0, mfeR: 0.1 }),
    ];
    const r = buildTechnicalStopTpCredibilityReport(records);
    const bm = r.baselinePathMetrics!;
    expect(bm.closedCount).toBe(3);
    expect(bm.netAvgR).toBeCloseTo((0.4 + 0.6 - 0.9) / 3, 3);
    expect(bm.winRate).toBeCloseTo(2 / 3, 3);
    expect(bm.avgWinnerMaeR).toBeCloseTo((0.2 + 0.3) / 2, 3);
    expect(bm.avgLoserMfeR).toBeCloseTo(0.1, 3);
  });
});

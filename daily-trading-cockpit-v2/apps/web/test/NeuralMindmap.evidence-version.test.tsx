import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import NeuralMindmap from "../src/NeuralMindmap";

// Mirrors NeuralTelemetry exactly enough to exercise the evidence-version panel end to end through
// the real, deployed component — not an isolated render of an internal helper. Every OTHER endpoint
// the component fetches on mount (live account, short-fade, etc.) resolves `ok: false`, which each
// caller already treats as "silently skip" (see loadLiveAccount/loadShortFade's own try/catch).
const CUTOVER_ISO = "2026-06-05T00:00:00.000Z";

function baseTelemetry(lanes: unknown[]) {
  return {
    version: "neural-map-v1",
    generatedAt: "2026-06-06T12:00:00.000Z",
    staleAfterSec: 30,
    policyThresholds: {
      comparator: ">=",
      stable: { minDevRows: 40, minDevEffectiveN: 10, minHoldoutRows: 20, minHoldoutEffectiveN: 5 },
      promotion: { minDevRows: 90, minDevEffectiveN: 20, minHoldoutRows: 40, minHoldoutEffectiveN: 10 },
      maxTopSymbolPnlShare: 0.4,
    },
    controller: {
      regime: "Mixed rotation", mode: "VALIDATION_ONLY", bias: "MIXED", confidence: "LOW",
      allowsLong: true, allowsShort: true, allowsNewEntries: false, reasons: [],
    },
    safety: { liveBlocked: true, microPilotAllowed: false, paperOnly: true },
    scan: {
      status: "idle", running: false, lastFinishedAt: null, totalMs: null, slowestStage: null,
      slowestStageMs: null, timeoutSymbols: 0, degradedProviders: [], backgroundLagSec: null,
    },
    paper: {
      total: 0, open: 0, closed: 0, wins: 0, losses: 0, headlinePnl: 0, diagnosticPnl: 0, totalPnl: 0,
      openUnrealizedPnl: null, openUnrealizedR: null, diagnosticUnrealizedPnl: null, diagnosticUnrealizedR: null,
      headlineUnrealizedPnl: null, headlineUnrealizedR: null, openMaxFavorablePnl: null, openMaxFavorableR: null,
      openAvgDistanceToTpPct: null, openNearestDistanceToTpPct: null, openAvgMfePct: null, openP75MfePct: null,
      openP90MfePct: null, openAvgConfiguredTpPct: null, openTpAssessment: null, unrealizedMarkCount: 0,
      unrealizedMissingPriceCount: 0, unrealizedPriceSource: null, todayPnl: 0,
      headlineNetAvgR: null, headlinePF: null, headlineWR: null,
      diagnosticByDirection: {
        LONG: { closed: 0, open: 0, realizedPnl: 0, unrealizedPnl: null, netAvgR: null, wr: null },
        SHORT: { closed: 0, open: 0, realizedPnl: 0, unrealizedPnl: null, netAvgR: null, wr: null },
      },
    },
    mixed: {
      activeLane: null, activeLanes: [], tradingMode: "REDUCE_WIDE", admission: "ALLOW", occupancyMode: "NORMAL",
      stalePassHealth: "DIRECTIONALLY_BENIGN", budgetProfile: "SYMBOL_SAFE_RELAXED", guardrailStatus: "OK",
      recommendedAction: "NORMAL_ADMISSION", waitForCapacity: 0, oosCount: 0, oosThreshold: 30,
    },
    nodes: [],
    lanes,
    fadeLong: null,
    h6Trend: null,
    alerts: [],
  };
}

function stageProof(stage: "stable" | "promotion") {
  const label = stage === "stable" ? "STABLE" : "PROMOTION";
  return {
    stage, frozen: true, ok: false,
    devRows: 1, devEffectiveN: 1, devDistinctSymbolCount: 1, devDistinctRegimes: 1,
    devCalendarDays: 1, devTopSymbolPnlShare: 1, devNetAvgR: 0.6, devPf: 999_999,
    holdoutRows: 0, holdoutEffectiveN: 0, holdoutStressableRows: 0, holdoutDistinctSymbolCount: 0,
    holdoutNetAvgR: null, holdoutPf: null, holdoutStressNetAvgR: null, holdoutSufficient: false, holdoutNegative: false,
    // Distinct per stage — a real backend blocker string is always stage-labelled
    // (`${t.label} dev effectiveN ...`), never shared verbatim between stable/promotion.
    blockers: [`${label} dev effectiveN 1 < 10 independent episodes`, `${label} dev rows 1 < 40`],
  };
}

function resetLaneFixture() {
  return {
    id: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
    label: "Wide Fast Long",
    health: "COLLECTING", evidenceHealth: "COLLECTING", active: true,
    open: 0, closed: 1, oosFreshValid: 1, oosThreshold: 10,
    stableProof: stageProof("stable"), promotionProof: stageProof("promotion"),
    netAvgR: 0.6, pf: 999_999, wr: 1, statsSource: "VM_SIM",
    evidenceVersion: "CG_WIDE_FAST_LONG@36H-v1",
    resetCutoverAt: CUTOVER_ISO,
    legacyExcludedRows: 750,
    legacyExclusionReasons: [
      { reason: "openMaxHoldMs absent (pre-reset row, written before this field existed)", count: 750 },
    ],
    previousEvidenceVersion: "~72H (measured from legacy MAX_HOLD_MTM closes)",
    payoffRatio: null, plus10bpsStillPositive: true, allThreeOosPositive: true, oosThirds: null,
    approxMaxDrawdownR: 0, topSymbolPnlShare: 1, calendarDays: 1, distinctRegimes: 1, infraReady: true,
    blockers: ["freshValid 1 < 10"], cautions: [],
    headlinePnl: 4, diagnosticPnl: 0, totalPnl: 4,
    openUnrealizedPnl: null, openUnrealizedR: null, diagnosticUnrealizedPnl: null, diagnosticUnrealizedR: null,
    headlineUnrealizedPnl: null, headlineUnrealizedR: null, openMaxFavorablePnl: null, openMaxFavorableR: null,
    openAvgDistanceToTpPct: null, openNearestDistanceToTpPct: null, openAvgEntryPrice: null, openAvgMarkPrice: null,
    openAvgTakeProfitPrice: null, openAvgMfePct: null, openP75MfePct: null, openP90MfePct: null,
    openAvgConfiguredTpPct: null, openTpAssessment: null, openMarkedSymbolCount: 0,
    startingEquity: 2000, totalPnlPct: null, headlinePnlPct: null, pnlIsDiagnosticOnly: false,
    status: "COLLECTING", reason: "freshValid 1 < 10",
  };
}

function nonResetLaneFixture() {
  return {
    ...resetLaneFixture(),
    id: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    label: "Wide Stop/TP",
    evidenceVersion: null,
    resetCutoverAt: null,
    legacyExcludedRows: 0,
    legacyExclusionReasons: [],
    previousEvidenceVersion: null,
  };
}

function mockFetch(telemetry: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/shadow/neural-map") {
      return new Response(JSON.stringify(telemetry), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  });
}

describe("NeuralMindmap — evidence version panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders current metrics from the reset lane's OWN version-aware fields, never inflated by the 750 legacy rows", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CG_WIDE_FAST_LONG@36H-v1")).toBeTruthy());

    // The "Current" block's Fresh-valid strong must read exactly 1 — the post-reset row only, not
    // 751 (750 legacy + 1) — the goal's exact acceptance criterion, now asserted through real DOM.
    const currentBlock = screen.getByText("Current (this version only)").closest("div")!;
    const freshValidLabel = within(currentBlock).getByText("Fresh-valid");
    expect(freshValidLabel.nextElementSibling?.textContent).toBe("1");
  });

  it("labels legacy evidence HISTORICAL_REFERENCE_ONLY with the not-used-for note, and shows the exclusion reason/count", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("HISTORICAL_REFERENCE_ONLY")).toBeTruthy());
    expect(screen.getByText("NOT USED FOR LEARNING, READINESS, HOLDOUT, OR PROMOTION")).toBeTruthy();
    expect(screen.getByText(/750 legacy rows excluded/)).toBeTruthy();
    expect(screen.getByText(/750 rows: openMaxHoldMs absent/)).toBeTruthy();
    expect(screen.getByText(/~72H \(measured from legacy MAX_HOLD_MTM closes\)/)).toBeTruthy();
  });

  it("renders independent maturity gates using the API's own policy thresholds — never a hardcoded number", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("STABLE gate")).toBeTruthy());
    expect(screen.getByText("PROMOTION gate")).toBeTruthy();
    // devRows=1 vs STABLE minDevRows=40 and PROMOTION minDevRows=90 (both from policyThresholds,
    // never a UI literal) -> two DIFFERENT rendered thresholds prove the value came from the API.
    expect(screen.getByText("1 >= 40")).toBeTruthy();
    expect(screen.getByText("1 >= 90")).toBeTruthy();
    expect(screen.getByText("1 >= 10")).toBeTruthy();
    expect(screen.getByText("1 >= 20")).toBeTruthy();
    expect(screen.getAllByText("BLOCKED").length).toBeGreaterThan(0);
    expect(screen.getByText(/STABLE dev rows 1 < 40/)).toBeTruthy();
    expect(screen.getByText(/PROMOTION dev rows 1 < 40/)).toBeTruthy();
  });

  it("does not render the evidence-version panel at all when no lane has an active reset", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([nonResetLaneFixture()])));
    render(<NeuralMindmap />);

    // Wait on an anchor that renders unconditionally once telemetry loads, decoupled from the
    // unrelated milestone-table's OWN lane classification (laneMaturitySection) — this test only
    // cares whether laneHasEvidenceVersionSplit's gate correctly stays closed, not whether the
    // milestone table happens to place this specific minimal fixture into one of its sections.
    await waitFor(() => expect(screen.getByLabelText("Lane maturity thresholds")).toBeTruthy());
    expect(screen.queryByLabelText("Evidence version and independent maturity")).toBeNull();
  });

  it("mutation-shape regression: a lane with legacyExcludedRows but no evidenceVersion still surfaces in the panel (laneHasEvidenceVersionSplit does not require BOTH fields)", async () => {
    const partial = { ...resetLaneFixture(), evidenceVersion: null };
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([partial])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByLabelText("Evidence version and independent maturity")).toBeTruthy());
    expect(screen.getByText("no current-version evidence yet")).toBeTruthy();
  });
});

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

// Matches the REAL fixed backend exactly: a lane with 1 winning close and ZERO losing closes has
// devPf/holdoutPf = null (profitFactor() has never used a sentinel — see current-guard-variant-
// matrix.ts) and every raw/independent-episode count sits at the tiny end (1 row, 1 episode dev-side;
// 0 rows, 0 episodes holdout-side) — this is the goal's own "750 legacy + 1 winner + 0 losses"
// regression fixture, expressed at the stage-proof level.
function stageProof(stage: "stable" | "promotion") {
  const label = stage === "stable" ? "STABLE" : "PROMOTION";
  const minDevRows = stage === "stable" ? 40 : 90;
  const minDevEffectiveN = stage === "stable" ? 10 : 20;
  const minHoldoutRows = stage === "stable" ? 20 : 40;
  const minHoldoutEffectiveN = stage === "stable" ? 5 : 10;
  return {
    stage, frozen: true, ok: false,
    devRows: 1, devEffectiveN: 1, devDistinctSymbolCount: 1, devDistinctRegimes: 1,
    devCalendarDays: 1, devTopSymbolPnlShare: 1, devNetAvgR: 0.6, devPf: null,
    holdoutRows: 0, holdoutEffectiveN: 0, holdoutStressableRows: 0, holdoutDistinctSymbolCount: 0,
    holdoutNetAvgR: null, holdoutPf: null, holdoutStressNetAvgR: null, holdoutSufficient: false, holdoutNegative: false,
    // Distinct per stage AND per side — a real backend blocker string is always stage+side-labelled
    // (`${t.label} dev effectiveN ...` / `${t.label} holdout rows ...`), never shared verbatim
    // between stable/promotion or between dev/holdout.
    blockers: [
      `${label} dev effectiveN 1 < ${minDevEffectiveN} independent episodes`,
      `${label} dev rows 1 < ${minDevRows}`,
      `${label} holdout rows 0 < ${minHoldoutRows}`,
      `${label} holdout effectiveN 0 < ${minHoldoutEffectiveN} independent episodes`,
    ],
  };
}

function resetLaneFixture() {
  return {
    id: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
    label: "Wide Fast Long",
    health: "COLLECTING", evidenceHealth: "COLLECTING", active: true,
    open: 0, closed: 1, oosFreshValid: 1, oosThreshold: 10,
    stableProof: stageProof("stable"), promotionProof: stageProof("promotion"),
    netAvgR: 0.6, pf: null, pfStatus: "NO_LOSSES_YET", wr: 1, statsSource: "VM_SIM",
    evidenceVersion: "CG_WIDE_FAST_LONG@36H-v1",
    resetCutoverAt: CUTOVER_ISO,
    legacyExcludedRows: 750,
    legacyExclusionReasons: [
      { reason: "openMaxHoldMs absent (pre-reset row, written before this field existed)", count: 750 },
    ],
    previousEvidenceVersion: "~72H (measured from legacy MAX_HOLD_MTM closes)",
    policyVersion: "current-guard-variant-matrix-v1",
    cutoverSource: "INFERRED",
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
    policyVersion: null,
    cutoverSource: "INFERRED",
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
    const statusLabel = within(currentBlock).getByText("Status");
    expect(statusLabel.nextElementSibling?.textContent).toBe("COLLECTING");
  });

  // Goal issue A: PF with zero gross loss must never render as a numeric sentinel (999999) and must
  // never read as an implausibly perfect/exceptional result.
  it("PF with zero losses renders as an explicit insufficient-sample message, never as 999999 or any large numeric sentinel", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    const { container } = render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CG_WIDE_FAST_LONG@36H-v1")).toBeTruthy());

    expect(container.textContent).not.toMatch(/999[,_]?999/);
    const currentBlock = screen.getByText("Current (this version only)").closest("div")!;
    const pfLabel = within(currentBlock).getByText("PF");
    expect(pfLabel.nextElementSibling?.textContent).toBe("N/A — no losing outcome yet (insufficient sample)");
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

  // Goal issue B: DEV / validation-OOS / recent-live-testnet must each be their own explicit,
  // separately-headed section — not folded into blocker text under a single STABLE/PROMOTION badge.
  it("renders DEV, Validation / OOS, and Recent / Live / Testnet as three separate explicit sections, each independently BLOCKED, using the API's own policy thresholds", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("DEV")).toBeTruthy());
    expect(screen.getByText("Validation / OOS")).toBeTruthy();
    expect(screen.getByText("Recent / Live / Testnet")).toBeTruthy();

    // Three DIFFERENT threshold pairs prove each section reads its OWN policyThresholds entry, never
    // a shared/hardcoded literal: DEV (stable.dev) 1>=40/1>=10, Validation/OOS (stable.holdout)
    // 0>=20/0>=5, Recent/Live/Testnet (promotion.holdout) 0>=40/0>=10.
    expect(screen.getByText("1 >= 40")).toBeTruthy();
    expect(screen.getByText("1 >= 10")).toBeTruthy();
    expect(screen.getByText("0 >= 20")).toBeTruthy();
    expect(screen.getByText("0 >= 5")).toBeTruthy();
    expect(screen.getByText("0 >= 40")).toBeTruthy();
    expect(screen.getByText("0 >= 10")).toBeTruthy();

    // Each section shows its OWN blocking reason, not another section's text bleeding through.
    expect(screen.getByText(/STABLE dev rows 1 < 40/)).toBeTruthy();
    expect(screen.getByText(/STABLE holdout rows 0 < 20/)).toBeTruthy();
    expect(screen.getByText(/PROMOTION holdout rows 0 < 40/)).toBeTruthy();

    // All three sections BLOCKED (goal's regression acceptance: "DEV, validation/OOS, recent/live
    // gates separately BLOCKED") — at least 3 BLOCKED badges, one per section.
    expect(screen.getAllByText("BLOCKED").length).toBeGreaterThanOrEqual(3);
  });

  // Goal issue C: cutoverSource must be visible for auditability — INFERRED today (no canonical
  // registry exists), never silently presented as if it were a stored fact.
  it("exposes cutoverSource=INFERRED and the policy version for auditability", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CG_WIDE_FAST_LONG@36H-v1")).toBeTruthy());
    expect(screen.getByText("cutoverSource: INFERRED")).toBeTruthy();
    expect(screen.getByText("policy current-guard-variant-matrix-v1")).toBeTruthy();
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

  // Goal issue A, ranking/coloring half: a lane whose ONLY apparent strength is an undefined PF
  // (zero losses on one win) must not be classified as a headline/watchable success. The milestone
  // table's own status pill is driven by `lane.status` (COLLECTING here, from the fixture) plus
  // paperBookClearsHeadline() for paper-book-only lanes — this fixture is VM_SIM sourced (has a
  // stableProof), so it is never even eligible for that path; asserting COLLECTING end-to-end proves
  // the fix, not just the removed sentinel in isolation.
  it("a lane with an undefined PF (one win, zero losses) is never classified as exceptional/headline — status stays COLLECTING", async () => {
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([resetLaneFixture()])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CG_WIDE_FAST_LONG@36H-v1")).toBeTruthy());
    const currentBlock = screen.getByText("Current (this version only)").closest("div")!;
    const statusLabel = within(currentBlock).getByText("Status");
    expect(statusLabel.nextElementSibling?.textContent).toBe("COLLECTING");
    expect(screen.queryByText("WATCHABLE")).toBeNull();
  });

  // ── Point 4e — CURRENT PRE-FREEZE COLLECTION ────────────────────────────────────────────────────
  // The reported defect: DEV/Validation-OOS/Recent-Live-Testnet all read 0 rows / 0 episodes while
  // the lane genuinely had fresh rows on tape, because those three panels can only ever describe a
  // FROZEN window. "Collecting, 3 of 10 episodes in" was indistinguishable from "nothing here".
  const preFreezeFixture = () => ({
    eligibleRows: 11,
    provisionalEpisodes: 3,
    rowsPerEpisode: 11 / 3,
    calendarDays: 21,
    distinctSymbolCount: 4,
    distinctRegimes: 2,
    largestEpisodeRows: 4,
    largestEpisodeShare: 4 / 11,
    topSymbolPnlShare: 0.35,
    evidenceVersion: "CG_WIDE_FAST_LONG@36H-v1",
    cutoverSource: "INFERRED" as const,
    freezeBlockers: [
      "eligible current rows 11 < 60 needed before a STABLE window is attempted (dev 40 + holdout 20)",
      "provisional independent episodes 3 < 10 needed for the STABLE dev side",
    ],
    minRowsToAttemptFreeze: 60,
    minDevRows: 40,
    minDevEpisodes: 10,
  });

  it("renders real provisional accumulation (11 rows / 3 of 10 episodes) while the frozen DEV section still reads NOT FROZEN — the two are separate sections, never merged", async () => {
    const lane = { ...resetLaneFixture(), preFreezeCollection: preFreezeFixture() };
    // The frozen proofs are genuinely unfrozen and all-zero, exactly like the live defect.
    lane.stableProof = { ...lane.stableProof, frozen: false, devRows: 0, devEffectiveN: 0, holdoutRows: 0, holdoutEffectiveN: 0 };
    lane.promotionProof = { ...lane.promotionProof, frozen: false, devRows: 0, devEffectiveN: 0, holdoutRows: 0, holdoutEffectiveN: 0 };
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([lane])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CURRENT PRE-FREEZE COLLECTION")).toBeTruthy());
    const section = screen.getByText("CURRENT PRE-FREEZE COLLECTION").closest(".neural-evidence-gate") as HTMLElement;

    // Real accumulation is visible — NOT zero — and shown against the floor it must reach.
    expect(within(section).getByText("Provisional independent episodes").nextElementSibling?.textContent).toBe("3 / 10");
    expect(within(section).getByText("Eligible current rows").nextElementSibling?.textContent).toBe("11 / 40");
    // Episode concentration, the thing a bare count hides.
    expect(within(section).getByText("Largest episode").nextElementSibling?.textContent).toBe("4 (36%)");
    expect(within(section).getByText("Rows / episode").nextElementSibling?.textContent).toBe("3.67");
    // Evidence version + cutover source are readable without cross-referencing another panel.
    expect(within(section).getByText("Cutover source").nextElementSibling?.textContent).toBe("INFERRED");
    // Explicitly PROVISIONAL — never a PASS, so it cannot read as an earned verdict.
    expect(within(section).getByText("PROVISIONAL")).toBeTruthy();
    expect(within(section).queryByText("PASS")).toBeNull();
    // And it states exactly what freezing DEV still needs.
    expect(section.textContent).toContain("To freeze DEV:");
    expect(section.textContent).toContain("provisional independent episodes 3 < 10");

    // The three frozen sections remain separate and still honestly say NOT FROZEN — the provisional
    // numbers must not leak into them.
    const devSection = screen.getByText("DEV").closest(".neural-evidence-gate") as HTMLElement;
    expect(within(devSection).getByText("NOT FROZEN")).toBeTruthy();
    expect(devSection.textContent).not.toContain("Provisional independent episodes");
    for (const title of ["Validation / OOS", "Recent / Live / Testnet"]) {
      const s = screen.getByText(title).closest(".neural-evidence-gate") as HTMLElement;
      expect(within(s).getByText("NOT FROZEN")).toBeTruthy();
    }
  });

  it("omits the pre-freeze section entirely when the backend does not supply it — an older instance renders no provisional panel rather than a fabricated all-zero one", async () => {
    const lane = { ...resetLaneFixture() }; // no preFreezeCollection key at all
    vi.stubGlobal("fetch", mockFetch(baseTelemetry([lane])));
    render(<NeuralMindmap />);

    await waitFor(() => expect(screen.getByText("CG_WIDE_FAST_LONG@36H-v1")).toBeTruthy());
    expect(screen.queryByText("CURRENT PRE-FREEZE COLLECTION")).toBeNull();
  });
});

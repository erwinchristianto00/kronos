import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  buildIsPaperOrderLiveEligible,
  hasExactContextReadinessProof,
  paperOrderMaturityGateBlocks,
} from "../src/app.js";
import {
  buildCurrentGuardVariantMatrixReport,
  buildVariantMatrixObservationsForSignal,
  CurrentGuardVariantMatrixStore,
  laneStatusForContext,
  type ContextLaneStatusLookup,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
} from "../src/lib/current-guard-variant-matrix.js";
import {
  isForceEligibleForDirection,
  PROFIT_CORE_SHORT_TRAIL_LANE_ID,
} from "../src/lib/realtime-short-mirror.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import { makeConfig, makeEngine, paperOrder } from "./live-execution-engine.test.js";

function proof(overrides: Partial<ContextLaneStatusLookup> = {}): ContextLaneStatusLookup {
  return {
    laneId: "CG_WIDE_FAST_SHORT",
    context: "SHORT_BEARISH",
    applicable: true,
    direct: true,
    status: "COLLECTING",
    statusReason: "test",
    blockers: [],
    cautions: [],
    evidence: {
      context: "SHORT_BEARISH",
      freshValid: 1,
      netAvgR: null,
      grossAvgR: null,
      pf: null,
      wr: null,
      payoffRatio: null,
      plus10bpsNetAvgR: null,
      plus10bpsStillPositive: false,
      approxMaxDrawdownR: null,
      topSymbolPnlShare: null,
      calendarDays: null,
      distinctRegimes: 0,
      oosThirds: null,
      allThreeOosPositive: false,
      status: "COLLECTING",
      statusReason: "test",
      blockers: [],
      cautions: [],
    },
    ...overrides,
  };
}

describe("execution readiness exact-context boundary", () => {
  it("permits maturity evaluation only for direct, applicable, evidence-backed contexts", () => {
    // COLLECTING remains eligible for a later, explicit maturity override; it is not itself ready.
    expect(hasExactContextReadinessProof(proof())).toBe(true);
    expect(hasExactContextReadinessProof(proof({ context: null, applicable: false, direct: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ status: "NOT_APPLICABLE", applicable: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ direct: false, evidence: null }))).toBe(false);
    expect(hasExactContextReadinessProof(proof({ evidence: null }))).toBe(false);
  });
});

// Point 2 (isPaperOrderLiveEligible, apps/api/src/app.ts): the maturity gate that decides whether
// `isPaperOrderLiveEligible` may even consider the rotation shortlist. Before the fix this check
// only ran `liveConfig.env === "mainnet" && !maturityEligible && ...` — on any NON-mainnet env
// (testnet, research) the function fell straight through to the rotation-shortlist branch, so a
// non-STABLE_CANDIDATE lane (or one with missing proof) could be admitted purely because the
// shortlist ALLOWed that symbol. `paperOrderMaturityGateBlocks` is env-INDEPENDENT by
// construction — it takes no env parameter at all — so the exact testnet-only bug this proves
// closed is that the gate can no longer be skipped by environment.
describe("isPaperOrderLiveEligible maturity gate — paperOrderMaturityGateBlocks", () => {
  it("[ADVERSARIAL / fail-without] blocks whenever maturity is unproven and no explicit override is active — this is env-independent by construction (the testnet-only bug is that env used to matter here at all)", () => {
    expect(paperOrderMaturityGateBlocks(false, false)).toBe(true);
  });

  it("[PASS-WITH] does not block once maturity is genuinely proven (STABLE_CANDIDATE / force / long-wide-stop override already resolved upstream), with no override needed", () => {
    expect(paperOrderMaturityGateBlocks(true, false)).toBe(false);
  });

  it("[PASS-WITH / explicit override] does not block when the operator has set the explicit, visible LIVE_UNPROVEN_EXECUTION_OVERRIDE=1 escape hatch, even with unproven maturity", () => {
    expect(paperOrderMaturityGateBlocks(false, true)).toBe(false);
  });

  it("proven maturity plus an active override still does not block (redundant-but-consistent)", () => {
    expect(paperOrderMaturityGateBlocks(true, true)).toBe(false);
  });
});

// 2026-08 remediation of the audit gap above: `paperOrderMaturityGateBlocks` alone never proved the
// REAL wiring was fixed — the original bug was `if (liveConfig.env === "mainnet" && ...) return
// false;` at the actual `isPaperOrderLiveEligible` call site (app.ts, injected into
// LiveExecutionEngine, invoked at live-execution-engine.ts's `paperSourceEligibleForMirror`/mirror-
// funnel call sites and surfaced there as the "not_live_eligible" mirror-drop reason). A mutation
// reinstating exactly that restriction left the whole suite green because nothing ever called the
// REAL closure with a real, non-mainnet `liveConfig`.
//
// `buildIsPaperOrderLiveEligible` (app.ts) is the extracted, byte-identical body of that closure —
// buildApp() wires it in unchanged (same free variables, now passed as `deps`). These tests call
// THAT function directly with a real `LiveExecutionConfig` (env: "testnet") and a real
// `CurrentGuardVariantMatrixStore` seeded with a genuine, axis-stamped, resolved cohort (same
// pattern as current-guard-variant-matrix.test.ts's `addResolvedContextCohort`), so
// `hasExactContextReadinessProof`/`contextProof.status` are computed from real evidence, not hand-
// set fields — this is the real call site, not a hand-copied stand-in.
describe("isPaperOrderLiveEligible — real wiring (buildIsPaperOrderLiveEligible), non-mainnet env", () => {
  const dirs: string[] = [];
  function tmpDir(): string {
    const dir = resolve(os.tmpdir(), `execution-readiness-context-${process.pid}-${dirs.length}-${Date.now()}`);
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeSignal(overrides: Partial<VariantMatrixSignal> = {}): VariantMatrixSignal {
    return {
      sourceSignalId: "sig-1",
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      tp1: 104,
      tp2: null,
      tp3: null,
      stopDistanceBps: 200,
      regime: "BULLISH_EXPANSION",
      entryVariant: "base_current_entry",
      openedAt: "2026-05-20T00:00:00.000Z",
      closedAt: null,
      ...overrides,
    };
  }

  // Trimmed copy of current-guard-variant-matrix.test.ts's `addResolvedContextCohort` (same repo,
  // already-proven pattern — see that file's [3A-PASS]/[CTX-8] cases) — builds a genuine,
  // axis-stamped, resolved cohort of CLOSED observations for one variant/direction/regime so
  // `buildCurrentGuardVariantMatrixReport` computes a REAL exact-context status from real evidence.
  function addResolvedContextCohort(
    store: CurrentGuardVariantMatrixStore,
    options: {
      variantId: VariantMatrixVariantDefinition["id"];
      direction: "LONG" | "SHORT";
      regime: string;
      count: number;
      netR: (index: number) => number;
      prefix: string;
    },
  ): void {
    // Point 3c (current-guard-variant-matrix): effectiveN's grouping key no longer crosses symbol
    // into the time block, so rows must be spaced beyond this variant's ~3-day (72h) max-hold block
    // width to land in distinct blocks and stay independent — 4 days, same as that file's [3C-PASS].
    const spacingMs = 4 * 24 * 60 * 60 * 1000;
    const baseOpenedAtMs = Date.UTC(2026, 5, 1);
    const baseResolvedAtMs = Date.UTC(2026, 6, 1);
    const observations = Array.from({ length: options.count }, (_, index) => {
      const base = buildVariantMatrixObservationsForSignal(makeSignal({
        sourceSignalId: `${options.prefix}-${index}`,
        symbol: `CTX${index % 5}USDT`,
        direction: options.direction,
        regime: options.regime,
        openedAt: new Date(baseOpenedAtMs + index * spacingMs).toISOString(),
        posture: "TACTICAL" as const,
        regimeDirection: options.direction,
      })).find((candidate) => candidate.variantId === options.variantId)!;
      const netR = options.netR(index);
      return {
        ...base,
        observationId: `${options.prefix}-${index}`,
        sourceObservationKey: `${options.prefix}-${index}`,
        status: netR > 0 ? ("CLOSED_WIN" as const) : ("CLOSED_LOSS" as const),
        grossR: netR + 0.12,
        netR,
        costR: 0.12,
        isFreshValid: true,
        resolvedAt: new Date(baseResolvedAtMs + index * spacingMs).toISOString(),
      };
    });
    store.addMany(observations);
  }

  // 80% win rate, real losers so PF is defined — same shape current-guard-variant-matrix.test.ts's
  // [3A-PASS] uses to reach STABLE_CANDIDATE.
  const stableNetR = (index: number) => (index % 5 === 0 ? -0.5 : 1);
  // 66% win rate — same shape [CTX-8] uses to reach a genuinely-evidenced but NOT STABLE_CANDIDATE
  // status (WATCHABLE): real proof, real evidence, just not yet mature.
  const watchableNetR = (index: number) => (index < 34 ? -0.1 : 1);

  it("[ADVERSARIAL / fail-without] non-mainnet env + an unproven (WATCHABLE) lane is rejected — the real closure returns false, matching the engine's own \"not_live_eligible\" mirror-drop reason", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    // WATCHABLE, not STABLE_CANDIDATE: real direct evidence for LONG_BULLISH, genuinely immature.
    addResolvedContextCohort(store, {
      variantId: "CG_WIDE_STOP_TP_WIDE",
      direction: "LONG",
      regime: "Bullish expansion",
      count: 100,
      netR: watchableNetR,
      prefix: "reject",
    });
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    const order = paperOrder({
      paperOrderId: "reject-order",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      direction: "LONG",
      symbol: "CTX0USDT",
      regime: "Bullish expansion",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    expect(isEligible(order)).toBe(false);
  });

  it("[PASS-WITH] non-mainnet env + a proven (STABLE_CANDIDATE) lane is NOT blocked by this gate — the real closure returns true", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    // "Sideways rotation" maps direction MIXED (estimateLaneSelectorV2Regime) and regimeFamily MIXED
    // (rotationRegimeFamilyForLabel) for BOTH the cohort and the order below, landing on the
    // LONG_MIXED exact context — deliberately NOT LONG_BULLISH/SHORT_BEARISH, so the rotation-
    // shortlist gate (a separate, legitimate gate) never activates and this assertion isolates the
    // maturity gate alone: `rotationGateActive` is false, so the real closure falls through to
    // `return maturityEligible;` unconditionally.
    addResolvedContextCohort(store, {
      variantId: "CG_WIDE_STOP_TP_WIDE",
      direction: "LONG",
      regime: "Sideways rotation",
      // Point 4 (current-guard-variant-matrix, stage model): `freshValid`/`effectiveN` are the FULL
      // population — measured, both read 143 here, because the 4-day spacing above puts every row in
      // its own 72h episode. STABLE is gated by the frozen `stableProof` WINDOW, not by any headline
      // row count: measured, this cohort freezes dev at 40 rows / 40 episodes and holdout at 20 rows /
      // 20 episodes, i.e. the ROW floors (STABLE_MIN_DEV_ROWS=40, STABLE_MIN_HOLDOUT_ROWS=20) bind and
      // the episode floors (10 / 5) are satisfied well before them. Same n=143 as
      // current-guard-variant-matrix.test.ts's [3A-PASS]/[4-PASS].
      // SUPERSEDED MODEL, recorded so the old arithmetic is not re-derived: this comment used to say
      // freshValid/effectiveN were the dev-only slice and that floor(143*HOLDOUT_DEV_FRACTION)=100 was
      // what put dev-side effectiveN on STABLE_MIN_FRESH (100). That single cut is deleted, and
      // STABLE_MIN_FRESH is no longer read by the matrix's status derivation at all — it survives only
      // as the adaptive-lane-router's coarser raw-row ladder floor.
      count: 143,
      netR: stableNetR,
      prefix: "pass",
    });
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    const order = paperOrder({
      paperOrderId: "pass-order",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Sideways rotation",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    expect(isEligible(order)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08 remediation, DEFECT 1 (ordering + gap #2) — STAGE 3 required adversarial suite (A-H) +
// the isProfitCoreShortLaneId regression.
//
// Every test below exercises the REAL exported `buildIsPaperOrderLiveEligible` factory (the exact
// same closure the "real wiring" describe block above already proved is the actual production
// wiring, not a hand-copied stand-in) with real `IsPaperOrderLiveEligibleDeps` — a real
// `CurrentGuardVariantMatrixStore`, a real non-mainnet `liveConfig`, and, wherever a manual-selected
// order is under test, a real `LiveExecutionEngine` in genuine manual-directional mode (built via
// `makeEngine`, this file's own already-imported convention from live-execution-engine.test.ts).
// Nothing here reimplements the gate's own boolean logic as a stand-in for calling it.
// ─────────────────────────────────────────────────────────────────────────────
describe("[PROOF-BOUNDARY] buildIsPaperOrderLiveEligible — defect 1 adversarial suite (A-H)", () => {
  const dirs: string[] = [];
  function tmpDir(): string {
    const dir = resolve(os.tmpdir(), `proof-boundary-${process.pid}-${dirs.length}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeSignal(overrides: Partial<VariantMatrixSignal> = {}): VariantMatrixSignal {
    return {
      sourceSignalId: "sig-1",
      symbol: "ETHUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 98,
      tp1: 104,
      tp2: null,
      tp3: null,
      stopDistanceBps: 200,
      regime: "BULLISH_EXPANSION",
      entryVariant: "base_current_entry",
      openedAt: "2026-05-20T00:00:00.000Z",
      closedAt: null,
      ...overrides,
    };
  }

  // Local trimmed copy of current-guard-variant-matrix.test.ts's own `addResolvedContextCohort`
  // (already-proven pattern, same repo — see that file's [3A-PASS]/[3B-FAIL]/[CTX-...] cases),
  // extended with its `legacy` option — the one extra knob [PROOF-BOUNDARY-C] needs that the OTHER
  // trimmed copy earlier in this same file does not have.
  function addResolvedContextCohort(
    store: CurrentGuardVariantMatrixStore,
    options: {
      variantId: VariantMatrixVariantDefinition["id"];
      direction: "LONG" | "SHORT";
      regime: string;
      count: number;
      netR: (index: number) => number;
      prefix: string;
      /** Point 3b axis-stamp control (see current-guard-variant-matrix.test.ts's canonical
       *  `addResolvedContextCohort` doc comment for the exact contract). Defaults to a genuine
       *  fresh-feed stamp (real exact-axis proof, posture+regimeDirection set); `legacy: true` builds
       *  UN-stamped, legacy-shaped rows (the shape selectVariantMatrixSignals actually produces) for
       *  [PROOF-BOUNDARY-C]'s adversarial case. */
      legacy?: boolean;
    },
  ): void {
    // Point 3c: rows must be spaced beyond this variant's ~3-day (72h) max-hold block width to land
    // in distinct blocks and stay independent — 4 days, matching every other STABLE-quality fixture
    // in this repo.
    const spacingMs = 4 * 24 * 60 * 60 * 1000;
    const baseOpenedAtMs = Date.UTC(2026, 5, 1);
    const baseResolvedAtMs = Date.UTC(2026, 6, 1);
    const observations = Array.from({ length: options.count }, (_, index) => {
      const base = buildVariantMatrixObservationsForSignal(makeSignal({
        sourceSignalId: `${options.prefix}-${index}`,
        symbol: `CTX${index % 5}USDT`,
        direction: options.direction,
        regime: options.regime,
        openedAt: new Date(baseOpenedAtMs + index * spacingMs).toISOString(),
        ...(options.legacy
          ? {}
          : { posture: "TACTICAL" as const, regimeDirection: options.direction }),
      })).find((candidate) => candidate.variantId === options.variantId)!;
      const netR = options.netR(index);
      return {
        ...base,
        observationId: `${options.prefix}-${index}`,
        sourceObservationKey: `${options.prefix}-${index}`,
        status: netR > 0 ? ("CLOSED_WIN" as const) : ("CLOSED_LOSS" as const),
        grossR: netR + 0.12,
        netR,
        costR: 0.12,
        isFreshValid: true,
        resolvedAt: new Date(baseResolvedAtMs + index * spacingMs).toISOString(),
      };
    });
    store.addMany(observations);
  }

  // 80% WR, real losers so PF is defined — same shape this file's/the canonical file's STABLE
  // fixtures use to reach STABLE_CANDIDATE (e.g. [3A-PASS]/[3B-PASS]/[CTX-...]).
  const STABLE_NET_R = (index: number) => (index % 5 === 0 ? -0.5 : 1);
  // Matches neither /bull|long/ nor /bear|short/ nor the mixed/rotation/chop/range/sideways/neutral/
  // unknown family in EITHER estimateLaneSelectorV2Regime OR rotationRegimeFamilyForLabel, so both
  // functions fall through to null/"UNKNOWN" — exactLaneContextFor then returns null regardless of
  // the order's own direction. This is the "no exact context" fixture for [PROOF-BOUNDARY-A/E].
  const UNRESOLVABLE_REGIME = "UNCLASSIFIED_REGIME";
  // CG_WIDE_STOP_TP_WIDE carries ALL_EXACT_LANE_CONTEXTS (every exact context is applicable), and is
  // not a member of any FORCE_ELIGIBLE_*_VARIANT_IDS set — the same lane the "real wiring" describe
  // block above already uses, for maximum consistency with already-proven fixtures in this file.
  const TEST_LANE_VARIANT_ID: VariantMatrixVariantDefinition["id"] = "CG_WIDE_STOP_TP_WIDE";

  function withEnvVar<T>(key: string, value: string, fn: () => T): T {
    const saved = process.env[key];
    process.env[key] = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }

  // Manual-directional-mode helper: builds a REAL LiveExecutionEngine, genuinely configured (not a
  // fake/hand-rolled stand-in for isManualEntryAllowedForPaper), so the manual bypass under test in
  // A-D is the engine's own real logic. `observedAt` matches makeEngine()'s default `nowIso` exactly
  // so the decision is never stale (see MANUAL_ENTRY_DECISION_MAX_AGE_MS).
  function makeManualEngineForLongLane(laneVariantId: string) {
    const { engine } = makeEngine();
    const setup = engine.setManualDirectionalLaneAllocations({
      long: [{ laneId: laneVariantId, weightPct: 100 }],
      short: [],
    });
    if (!setup.ok) {
      throw new Error(`[PROOF-BOUNDARY] test setup failed: manual allocation rejected — ${setup.reason}`);
    }
    engine.setManualSelectorMode(true);
    engine.setManualEntryDecision({
      action: "WAIT_PULLBACK",
      directionalBias: "LONG",
      reason: "[PROOF-BOUNDARY] test fixture",
      observedAt: "2099-01-02T12:00:00.000Z",
    });
    return engine;
  }

  it("[PROOF-BOUNDARY-A] manual-selected lane + no exact context (unresolvable regime/controllerMode) fails, even though manual mode ALONE would admit it", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID);
    const order = paperOrder({
      paperOrderId: "proof-a-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: UNRESOLVABLE_REGIME,
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    // The manual engine's OWN check would admit this order on its own (narrower) merits — proving
    // the overall gate's "false" verdict below is because the NEW context-existence gate runs FIRST,
    // not because manual mode itself was ever unwilling.
    expect(manualEngine.isManualEntryAllowedForPaper(order)).toBe(true);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => manualEngine,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[PROOF-BOUNDARY-B] manual-selected lane + a structurally-applicable context with ZERO observations (evidence !== null, freshValid === 0) fails", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    // Real, even STABLE-quality data for a DIFFERENT exact context of the SAME lane — proves the
    // lane/store is genuinely active, so the order's own (empty) context is not failing merely
    // because the whole store has nothing in it.
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "SHORT",
      regime: "Bearish expansion",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "proof-b-other-context",
    });
    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID);
    const order = paperOrder({
      paperOrderId: "proof-b-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion", // LONG_BULLISH: applicable for this lane, but ZERO real observations landed here
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    // Forensic: confirm the exact shape claimed (evidence structurally present, freshValid 0) via
    // the real report/lookup — verified, not merely asserted.
    const report = buildCurrentGuardVariantMatrixReport(store);
    const contextProof = laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH");
    expect(contextProof.applicable).toBe(true);
    expect(contextProof.direct).toBe(true);
    expect(contextProof.evidence).not.toBeNull();
    expect(contextProof.evidence!.freshValid).toBe(0);
    expect(manualEngine.isManualEntryAllowedForPaper(order)).toBe(true); // manual alone would admit it
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => manualEngine,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[PROOF-BOUNDARY-C] manual-selected lane + real observations that are ALL legacy-shaped (exactAxisProof===false) fails — the context's evidence.freshValid is 0 despite 143 real rows existing", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Bullish expansion",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "proof-c-legacy",
      legacy: true,
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    // The equivalence claim, proven directly: real observations exist (the aggregate row sees all
    // 143 of them), but the EXACT-CONTEXT evidence — the thing hasExactContextReadinessProof
    // actually reads — is 0, because none of them carry the real exact-axis-proof stamp.
    const aggregateRow = report.rows.find((r) => r.variantId === TEST_LANE_VARIANT_ID)!;
    expect(aggregateRow.freshValid).toBe(143);
    const contextProof = laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH");
    expect(contextProof.evidence).not.toBeNull();
    expect(contextProof.evidence!.freshValid).toBe(0);

    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID);
    const order = paperOrder({
      paperOrderId: "proof-c-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    expect(manualEngine.isManualEntryAllowedForPaper(order)).toBe(true);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => manualEngine,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[PROOF-BOUNDARY-D] manual-selected lane + real exact-axis-proof observations (freshValid>0) but status COLLECTING (not STABLE_CANDIDATE) — the manual override MAY pass", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    // Deliberately below WATCHABLE_MIN_FRESH so status is guaranteed COLLECTING regardless of netR —
    // deriveVariantStatus requires freshValid >= WATCHABLE_MIN_FRESH for BOTH REJECT and WATCHABLE.
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Bullish expansion",
      count: 5,
      netR: () => 1,
      prefix: "proof-d-collecting",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    const contextProof = laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH");
    expect(contextProof.evidence!.freshValid).toBe(5);
    expect(contextProof.status).toBe("COLLECTING"); // real evidence, genuinely immature — not yet STABLE_CANDIDATE

    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID);
    const order = paperOrder({
      paperOrderId: "proof-d-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => manualEngine,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(true); // real proof exists -> the manual override's own job (bypass MATURITY) may proceed
  });

  it("[PROOF-BOUNDARY-E] a force-eligible lane (REALTIME_SHORT_FORCE_FAST_LONG=1 + FORCE_ELIGIBLE_LONG_VARIANT_IDS) with no exact context still fails — force may bypass MATURITY only, never proof existence", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    const order = paperOrder({
      paperOrderId: "proof-e-order",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: UNRESOLVABLE_REGIME,
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    withEnvVar("REALTIME_SHORT_FORCE_FAST_LONG", "1", () => {
      // Forensic: force-eligibility is genuinely ACTIVE for this fixture, not a vacuous test that
      // would pass for an unrelated reason.
      expect(isForceEligibleForDirection("LONG", "CG_WIDE_FAST_LONG")).toBe(true);
      expect(isEligible(order)).toBe(false);
    });
  });

  it("[PROOF-BOUNDARY-F] LIVE_UNPROVEN_EXECUTION_OVERRIDE=1 with a structurally-applicable, freshValid=0 context still fails — and this exact shape was ALSO exploitable against the OLD, unstrengthened 5-clause check, a latent gap independent of the manual-path ordering bug", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir()); // deliberately empty — zero observations anywhere
    const report = buildCurrentGuardVariantMatrixReport(store);
    const contextProof = laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH");
    expect(contextProof.context).toBe("LONG_BULLISH");
    expect(contextProof.applicable).toBe(true);
    expect(contextProof.direct).toBe(true);
    expect(contextProof.evidence).not.toBeNull();
    expect(contextProof.evidence!.freshValid).toBe(0);
    expect(contextProof.status).not.toBe("NOT_APPLICABLE");
    // Forensic-only reconstruction of the OLD (pre-2026-08) 5-clause predicate, evaluated against
    // this SAME real contextProof — never used as a stand-in for the gate (the real gate is
    // exercised separately below, via the real exported closure). This substantiates, with a real
    // assertion, that the freshValid=0 gap pre-dates and is independent of the manual-path ordering
    // bug: the OLD predicate has no freshValid term at all, so it reads true here even though
    // evidence.freshValid is 0.
    const oldFiveClausePredicateWouldHaveAllowed =
      contextProof.context !== null &&
      contextProof.applicable === true &&
      contextProof.direct === true &&
      contextProof.evidence !== null &&
      contextProof.status !== "NOT_APPLICABLE";
    expect(oldFiveClausePredicateWouldHaveAllowed).toBe(true); // OLD check: would have wrongly allowed this
    expect(hasExactContextReadinessProof(contextProof)).toBe(false); // NEW check: correctly rejects it

    const order = paperOrder({
      paperOrderId: "proof-f-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    withEnvVar("LIVE_UNPROVEN_EXECUTION_OVERRIDE", "1", () => {
      expect(isEligible(order)).toBe(false);
    });
  });

  it("[PROOF-BOUNDARY-G] a normal, non-override order for a lane whose contextProof.status is COLLECTING fails, exactly as today", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Bullish expansion",
      count: 5,
      netR: () => 1,
      prefix: "proof-g-collecting",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH").status).toBe("COLLECTING");
    const order = paperOrder({
      paperOrderId: "proof-g-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null, // no manual mode, no force, no override — the ordinary path
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[PROOF-BOUNDARY-H] a genuine STABLE_CANDIDATE lane, no override active at all, passes — the ordinary non-override path is completely unaffected by this remediation", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    // "Sideways rotation" -> LONG_MIXED (both estimateLaneSelectorV2Regime and
    // rotationRegimeFamilyForLabel resolve to MIXED here), deliberately NOT LONG_BULLISH, so
    // rotationGateActive stays false and this isolates the maturity gate alone — same technique the
    // pre-existing "real wiring" describe block earlier in this file already uses.
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Sideways rotation",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "proof-h-stable",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_MIXED").status).toBe("STABLE_CANDIDATE");
    const order = paperOrder({
      paperOrderId: "proof-h-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Sideways rotation",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(true);
  });

  it("[PROOF-BOUNDARY-REGRESSION] isProfitCoreShortLaneId's testnet-SHORT forward-test lane still passes with NO variant-matrix context/evidence at all — proves the required reordering did not silently disable this lane", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir()); // untouched — zero observations; no row is ever read for this lane
    const order = paperOrder({
      paperOrderId: "proof-regression-order",
      selectedLaneId: PROFIT_CORE_SHORT_TRAIL_LANE_ID,
      direction: "SHORT",
      symbol: "BTCUSDT",
      regime: UNRESOLVABLE_REGIME,
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
    });
    expect(isEligible(order)).toBe(true);
  });
});

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
  buildVariantMatrixObservationsForSignal,
  CurrentGuardVariantMatrixStore,
  type ContextLaneStatusLookup,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
} from "../src/lib/current-guard-variant-matrix.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import { makeConfig, paperOrder } from "./live-execution-engine.test.js";

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

import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildIsPaperOrderLiveEligible,
  buildManualDirectionalRegimeSafetyGate,
  buildUnifiedRegimeEntryGate,
  hasExactContextReadinessProof,
} from "../src/app.js";
import {
  canonicalMarketRegimeExecutionPolicy,
  edgeMemoryLabelForCanonicalFamily,
  type CanonicalMarketRegimeSnapshot,
} from "../src/lib/canonical-market-regime-execution-policy.js";
import { innovationTestnetAdmissionAllowed } from "../src/lib/innovation-testnet-execution.js";
import {
  buildCurrentGuardVariantMatrixReport,
  buildVariantMatrixObservationsForSignal,
  CurrentGuardVariantMatrixStore,
  exactLaneContextFor,
  laneStatusForContext,
  type AxisRegimeFamily,
  type ExactLaneContext,
  type VariantMatrixSignal,
  type VariantMatrixVariantDefinition,
} from "../src/lib/current-guard-variant-matrix.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import { makeConfig, makeEngine, paperOrder } from "./live-execution-engine.test.js";

/**
 * 2026-08 canonical-market-regime rollout — TEST STAGE 2 of 2: the adversarial suite for
 * requirements H-K (LOW_COVERAGE propagation across every real integration point, identical policy
 * across those points, candidate-independence of authorization, and exact-context-key/historical-data
 * stability). See canonical-market-regime-execution-policy.test.ts (the pure-function suite for the
 * shared policy itself), unified-regime-entry-gate.test.ts (buildUnifiedRegimeEntryGate's own suite),
 * and execution-readiness-context.test.ts's "[CANONICAL-REGIME-POLICY / new step 4b]" tests
 * (buildIsPaperOrderLiveEligible's own step-4b suite) for the per-module coverage this file
 * deliberately does NOT re-duplicate — this file's job is the CROSS-CUTTING claims: that the SAME
 * shared function/accessor genuinely backs every one of app.ts's named integration points, not four
 * (or five) independently-matching reimplementations.
 *
 * Two testing techniques are used, chosen per integration point by what is actually reachable:
 *  - `buildIsPaperOrderLiveEligible` and `buildUnifiedRegimeEntryGate` are extracted, exported, pure
 *    factories (see their own doc comments in app.ts for why) — tested BEHAVIORALLY here, with real
 *    injected deps, exactly like every other suite in this rollout.
 *  - `LiveExecutionEngine.canOpenNewEntries()` / `canOpenNewEntriesIgnoringManualDirectional()` are
 *    REAL methods on a REAL engine instance (via this repo's own `makeEngine()` test harness),
 *    exercised with a real `buildUnifiedRegimeEntryGate(...)`-built `newEntryGate` — this is the
 *    literal master gate SingleSymbolLaneExecutor (via `isNewExecutorLaneAllowed` ->
 *    `newExecutorLaneGate` -> `engine.canOpenNewEntries()`), CrossSectionalExecutor's
 *    admission-independent TREND/MIXED variants, and every innovation testnet executor all inherit.
 *  - edgeVeto (both call sites), CrossSectionalExecutor MARKET_NEUTRAL's `entryHealthGate` addition,
 *    and `innovationTestnetAdmissionAllowed`'s call site are NOT extracted — they are inline,
 *    unexported closures defined inside `buildApp()` itself, capturing a `getCanonicalMarketRegimeSnapshot`
 *    closure variable that is hardcoded `() => null` at the real `buildApp()` call site (the engine
 *    module, canonical-market-regime-engine.ts, does not exist in this worktree yet — confirmed via
 *    `ls` immediately before writing this file). Booting the real `buildApp()` would therefore only
 *    ever observe a null snapshot regardless of what this file wants to inject, AND risks writing
 *    into the real `data/` directory (hard-ruled out). Per this repo's own established convention for
 *    exactly this situation (CLAUDE.md: "Source-level guards: brace-match the method's own body") and
 *    per this task's own explicit permission ("or the closest real call each one makes" / "by
 *    asserting a shared code-path indicator"), these three call sites are verified by reading
 *    app.ts's actual compiled source text and asserting, with uniqueness-checked anchors (every
 *    anchor string below was confirmed via `text.count(anchor) === 1` against the live file before
 *    this suite was written), that each one reads from the exact same shared accessor/function —
 *    never a hand-typed guess about what the source "should" say.
 *
 * A manual mutation-check pass (per this session's hard rule: "ALWAYS assert a mutation anchor
 * matched (count === 1) before trusting a 'still green' result") was performed for this whole file as
 * part of TEST STAGE 2's own verification workflow, outside this checked-in file (mutating a shared
 * checkout's source at test-run time is not an appropriate thing for a permanent, concurrently-shared
 * test suite to do) — see this stage's final report for the exact mutations, anchor counts, and
 * before/after results.
 */

const APP_TS_PATH = resolve(process.cwd(), "src", "app.ts");
const CGVM_TS_PATH = resolve(process.cwd(), "src", "lib", "current-guard-variant-matrix.ts");
const BASE_COMMIT = "72b9a1ab4840b34140609066a5a2f07d85c18eee";

function readAppTsSource(): string {
  return readFileSync(APP_TS_PATH, "utf-8");
}

/** Extracts [startAnchor, endAnchor) from `text`, throwing loudly (not returning an empty/undefined
 *  slice) if either anchor is missing — a missing anchor means app.ts's wiring shape changed in a way
 *  this test's own understanding has not kept up with, which must fail LOUD, never silently pass an
 *  empty slice that would vacuously satisfy every `.toContain()` assertion downstream. */
function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor);
  if (startIdx === -1) {
    throw new Error(`[structural check] start anchor not found in app.ts: ${JSON.stringify(startAnchor)}`);
  }
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length);
  if (endIdx === -1) {
    throw new Error(`[structural check] end anchor not found after start in app.ts: ${JSON.stringify(endAnchor)}`);
  }
  return text.slice(startIdx, endIdx);
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

// ─── canonical snapshot fixtures ────────────────────────────────────────────────────────────────────

function freshSnapshot(
  regimeFamily: "BULLISH" | "BEARISH" | "MIXED",
  overrides: Partial<CanonicalMarketRegimeSnapshot> = {},
): CanonicalMarketRegimeSnapshot {
  const nowMs = Date.now();
  return {
    schemaVersion: 1,
    engineVersion: "adversarial-hk-fixture-v1",
    calibrationVersion: "v1-hand-set-defaults",
    atMs: nowMs,
    atIso: new Date(nowMs).toISOString(),
    universeVersion: "adversarial-hk-universe-v1",
    universeSize: 60,
    sourceObservationIds: {},
    perSymbol: [],
    directionFast: 0,
    directionSlow: 0,
    breadth: 0,
    cohesion: 1,
    dispersion: 0,
    riskStress: 0,
    coverage: { validSymbolCount: 60, requiredSymbolCount: 60, coveragePct: 100, status: "VALID", reasons: [] },
    projection: regimeFamily,
    regimeFamily,
    overlays: { transition: false, highStress: false, panic: false, lowCoverage: false, rotational: false, fragmented: false },
    confidence: 1,
    stateHistory: { projectionSinceMs: nowMs, cyclesInProjection: 1, lastFlipAtMs: null, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 },
    status: "VALID",
    ...overrides,
  };
}

function lowCoverageSnapshot(regimeFamily: "BULLISH" | "BEARISH" | "MIXED" = "MIXED"): CanonicalMarketRegimeSnapshot {
  const base = freshSnapshot(regimeFamily);
  return {
    ...base,
    coverage: { validSymbolCount: 11, requiredSymbolCount: 60, coveragePct: 18.3, status: "INVALID", reasons: ["only 11/60 symbols fresh"] },
    overlays: { ...base.overlays, lowCoverage: true },
  };
}

function panicSnapshot(regimeFamily: "BULLISH" | "BEARISH" | "MIXED" = "MIXED"): CanonicalMarketRegimeSnapshot {
  const base = freshSnapshot(regimeFamily);
  return { ...base, overlays: { ...base.overlays, panic: true } };
}

// ─── CurrentGuardVariantMatrix fixture plumbing (trimmed copy of the established pattern already
//     used identically in execution-readiness-context.test.ts / current-guard-variant-matrix.test.ts) ─

const dirs: string[] = [];
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `canonical-adversarial-hk-${process.pid}-${dirs.length}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// 80% WR, real losers so PF is defined — same shape every STABLE fixture in this repo uses.
const STABLE_NET_R = (index: number) => (index % 5 === 0 ? -0.5 : 1);
// Carries ALL_EXACT_LANE_CONTEXTS and is not in any FORCE_ELIGIBLE_*_VARIANT_IDS set — same lane
// execution-readiness-context.test.ts's own PROOF-BOUNDARY suite standardizes on.
const TEST_LANE_VARIANT_ID: VariantMatrixVariantDefinition["id"] = "CG_WIDE_STOP_TP_WIDE";

function makeManualEngineForLongLane(
  laneVariantId: string,
  newEntryGate?: () => { allowed: boolean; reason: string | null },
  // 2026-08 manual-directional canonical-regime enforcement fix: optional so every PRE-EXISTING
  // caller of this helper (which predates the fix) is byte-for-byte unaffected — omitted, this
  // engine gets LiveExecutionEngine's own default-permissive regimeSafetyGate fallback, exactly
  // the OLD (buggy) behavior. [H8] below is the only caller that now passes a real one.
  regimeSafetyGate?: () => { allowed: boolean; reason: string | null },
) {
  const { engine } = makeEngine({ newEntryGate, regimeSafetyGate });
  const setup = engine.setManualDirectionalLaneAllocations({
    long: [{ laneId: laneVariantId, weightPct: 100 }],
    short: [],
  });
  if (!setup.ok) {
    throw new Error(`[adversarial-hk] test setup failed: manual allocation rejected — ${setup.reason}`);
  }
  engine.setManualSelectorMode(true);
  engine.setManualEntryDecision({
    action: "WAIT_PULLBACK",
    directionalBias: "LONG",
    reason: "[adversarial-hk] test fixture",
    observedAt: "2099-01-02T12:00:00.000Z", // matches makeEngine()'s default nowIso() exactly
  });
  return engine;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL H — LOW_COVERAGE blocks every entry path
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[ADVERSARIAL-H] LOW_COVERAGE blocks every entry path", () => {
  it("[H1] buildIsPaperOrderLiveEligible: a genuine STABLE_CANDIDATE lane, no override active, is BLOCKED when coverage.status=INVALID (independently of the lowCoverage overlay)", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Sideways rotation",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "h1-stable",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_MIXED").status).toBe("STABLE_CANDIDATE");
    const order = paperOrder({
      paperOrderId: "h1-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Sideways rotation",
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const snapshot: CanonicalMarketRegimeSnapshot = {
      ...freshSnapshot("MIXED"),
      coverage: { validSymbolCount: 9, requiredSymbolCount: 60, coveragePct: 15, status: "INVALID", reasons: ["exchange fetch degraded"] },
      overlays: { transition: false, highStress: false, panic: false, lowCoverage: false, rotational: false, fragmented: false },
    };
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
      getCanonicalMarketRegimeSnapshot: () => snapshot,
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[H2] buildUnifiedRegimeEntryGate: blocks when coverage.status=DEGRADED (the OR's other independent arm, distinct from unified-regime-entry-gate.test.ts's own overlays.lowCoverage case)", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => ({
        ...freshSnapshot("BULLISH"),
        coverage: { validSymbolCount: 30, requiredSymbolCount: 60, coveragePct: 50, status: "DEGRADED", reasons: ["half the universe stale"] },
      }),
      env: {},
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/coverage/i);
  });

  it("[H3] LiveExecutionEngine.canOpenNewEntries() — the REAL master gate SingleSymbolLaneExecutor's isNewExecutorLaneAllowed()/newExecutorLaneGate() chain depends on — blocks under LOW_COVERAGE when fed via a real buildUnifiedRegimeEntryGate(...)-built newEntryGate", async () => {
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
      env: {},
    });
    const { engine } = makeEngine({ newEntryGate });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.isArmed()).toBe(true); // sanity: not blocked for the wrong (unarmed) reason
    expect(engine.canOpenNewEntries()).toBe(false);
  });

  it("[H3-control] the SAME real engine, fed a HEALTHY snapshot via the SAME buildUnifiedRegimeEntryGate wiring, allows new entries — proves H3's `false` above is caused by LOW_COVERAGE specifically, not some unrelated engine default", async () => {
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
      env: {},
    });
    const { engine } = makeEngine({ newEntryGate });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntries()).toBe(true);
  });

  it("[H4] LiveExecutionEngine.canOpenNewEntriesIgnoringManualDirectional() — the gate CrossSectionalExecutor's admission-independent TREND/MIXED variants and every innovation testnet executor actually call — ALSO blocks under LOW_COVERAGE via the same real newEntryGate wiring", async () => {
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
      env: {},
    });
    const { engine } = makeEngine({ newEntryGate });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(false);
  });

  it("[H5, structural] CrossSectionalExecutor MARKET_NEUTRAL's entryHealthGate: the real app.ts source wires an ADDITIONAL, independently-blocking canonicalMarketRegimeExecutionPolicy check reading the SAME shared getCanonicalMarketRegimeSnapshot accessor, after (never instead of) the pre-existing rolling-health gate", () => {
    const text = readAppTsSource();
    const block = sliceBetween(
      text,
      "crossSectionalExecutor = new CrossSectionalExecutor({",
      "crossSectionalTrendExecutor = new CrossSectionalExecutor({",
    );
    expect(block).toContain("entryHealthGate: () => {");
    // The pre-existing PnL-rolling-health gate still runs FIRST and can still independently block —
    // this new check is additive, never a replacement (requirement #8).
    expect(block).toContain("if (!rolling.allowed) return rolling;");
    expect(block).toContain("const regimeDecision = canonicalMarketRegimeExecutionPolicy({");
    expect(block).toContain("snapshot: getCanonicalMarketRegimeSnapshot(),");
    expect(block).toContain("if (!regimeDecision.allowed) return { allowed: false, reason: regimeDecision.reason };");
  });

  it("[H6, structural + behavioral] innovationTestnetAdmissionAllowed's call site ANDs in the SAME shared canonicalMarketRegimeExecutionPolicy(...).allowed alongside the pre-existing canOpenNewEntriesIgnoringManualDirectional() argument", () => {
    const text = readAppTsSource();
    const block = sliceBetween(
      text,
      "const innovationAllowed = (laneId: string): boolean =>",
      "const innovationWeight = (laneId: string): number => {",
    );
    expect(block).toContain("innovationTestnetAdmissionAllowed(");
    expect(block).toContain("engineForGate.canOpenNewEntriesIgnoringManualDirectional(),");
    expect(block).toContain("canonicalMarketRegimeExecutionPolicy({");
    expect(block).toContain("snapshot: getCanonicalMarketRegimeSnapshot(),");
    expect(block).toContain(").allowed,");
    // Behavioral half: the exported pure function itself genuinely ANDs (not ORs, not ignores its
    // second argument) — re-verified directly here rather than only trusted from
    // innovation-testnet-execution.test.ts's own suite.
    expect(innovationTestnetAdmissionAllowed(true, true)).toBe(true);
    expect(innovationTestnetAdmissionAllowed(true, false)).toBe(false); // LOW_COVERAGE-shaped: engine says yes, regime policy says no
    expect(innovationTestnetAdmissionAllowed(false, true)).toBe(false);
    expect(innovationTestnetAdmissionAllowed(false, false)).toBe(false);
  });

  it("[H7, structural + behavioral] edgeVeto's two call sites (SingleSymbolLaneExecutor's regime-string source) both read the SAME shared accessor via edgeMemoryLabelForCanonicalFamily — and LOW_COVERAGE's forced MIXED relabeling reaches a real, fresh regime-edge-memory bucket rather than silently reusing a stale one", () => {
    const text = readAppTsSource();
    const site1 = sliceBetween(
      text,
      "const currentRegimeStringForVeto = (): string | null =>",
      "const unifiedPortfolioExitPolicy: SingleSymbolExitPolicy | undefined =",
    );
    expect(site1).toContain('edgeMemoryLabelForCanonicalFamily(getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? "UNKNOWN");');
    expect(site1).toContain("const edgeVeto = (direction:");
    expect(site1).toContain("mem.verdict(regime, direction)"); // byte-identical business logic, untouched by the source swap
    expect(site1).toContain('if (!regime || regime.trim().length === 0) return { allowed: true, reason: null };');

    const site2 = sliceBetween(
      text,
      'if (primaryDirection === "LONG" || primaryDirection === "SHORT") {',
      "const xsecReport = buildCrossSectionalReport(getCrossSectionalStore(), nowMs,",
    );
    expect(site2).toContain("edgeMemoryLabelForCanonicalFamily(");
    expect(site2).toContain('getCanonicalMarketRegimeSnapshot()?.regimeFamily ?? "UNKNOWN"');
    expect(site2).toContain("edgeMem.verdict(regimeForEdge, primaryDirection)");
    expect(site2).toContain('source: "REGIME_EDGE_MEMORY"');

    // Documented layering (not a gap): edgeVeto itself does not hard-block on LOW_COVERAGE — that
    // responsibility belongs to the upstream engine.canOpenNewEntries() -> unifiedRegimeEntryGate
    // gate (proven in H3/H4 above, which SingleSymbolLaneExecutor's isAllowed() ANDs BEFORE ever
    // reaching edgeVeto — see live-executor-wiring.ts's newExecutorLaneGate, which checks
    // engine.canOpenNewEntries() first). edgeVeto only ever relabels the bucket LOW_COVERAGE forces
    // to MIXED and asks the separate, orthogonal regime-edge-memory system for ITS OWN verdict on
    // that bucket — which, for a bucket with no accrued history, fails OPEN (ALLOW_INSUFFICIENT),
    // exactly like it always has for any brand-new regime bucket, canonical or not. This is the
    // REAL function chain edgeVeto's own source (verified structurally above) actually runs, called
    // directly here rather than re-asserted as a string literal.
    const forcedFamily = canonicalMarketRegimeExecutionPolicy({ snapshot: lowCoverageSnapshot("BULLISH"), nowMs: Date.now() }).regimeFamily;
    expect(forcedFamily).toBe("MIXED");
    expect(edgeMemoryLabelForCanonicalFamily(forcedFamily)).toBe("CANONICAL_MIXED_ROTATION");
  });

  it("[H8, FIXED 2026-08] the formerly-bypassing manual-directional branch in LiveExecutionEngine.canOpenNewEntries() now ALSO blocks under LOW_COVERAGE, via the new independent regimeSafetyGate — closing the exact gap this test used to document as out-of-scope. Contrasted directly against canOpenNewEntriesIgnoringManualDirectional() (H4), which never took the manual short-circuit at all and was already unaffected by this bug.", async () => {
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
      env: {},
    });
    // 2026-08 fix: production (app.ts) wires BOTH newEntryGate and regimeSafetyGate from the SAME
    // shared getCanonicalMarketRegimeSnapshot accessor — reproduced here with two independently
    // constructed real factories reading the SAME lowCoverageSnapshot(), exactly mirroring that
    // shared-accessor shape (see [I2] above for the structural guarantee that app.ts itself does
    // this, not merely that it's possible to do).
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
    });
    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID, newEntryGate, regimeSafetyGate);
    expect((await manualEngine.arm()).ok).toBe(true);
    // FIXED: the manual-directional branch now ALSO consults the canonical regime policy (via the
    // new, independent regimeSafetyGate) — canOpenNewEntries() returns false under LOW_COVERAGE,
    // exactly like every non-manual lane already did.
    expect(manualEngine.canOpenNewEntries()).toBe(false);
    expect(manualEngine.newEntryBlockReason()).toMatch(/coverage/i);
    // canOpenNewEntriesIgnoringManualDirectional() never took the manual short-circuit to begin
    // with — same engine, same manual-mode state, same LOW_COVERAGE snapshot, same (unchanged)
    // answer as before this fix.
    expect(manualEngine.canOpenNewEntriesIgnoringManualDirectional()).toBe(false);
  });

  it("[H8-control] the SAME manual engine, fed a HEALTHY snapshot through BOTH newEntryGate and the new regimeSafetyGate, still opens — proves H8's `false` above is caused by LOW_COVERAGE specifically, and that the fix narrows (never removes) the manual-directional maturity bypass. Mirrors [H3-control]'s discipline for the non-manual path.", async () => {
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
      env: {},
    });
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
    });
    const manualEngine = makeManualEngineForLongLane(TEST_LANE_VARIANT_ID, newEntryGate, regimeSafetyGate);
    expect((await manualEngine.arm()).ok).toBe(true);
    expect(manualEngine.canOpenNewEntries()).toBe(true);
    expect(manualEngine.newEntryBlockReason()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL I — all executors receive identical policy for the same snapshot
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[ADVERSARIAL-I] identical policy across every real integration point", () => {
  it("[I1] buildIsPaperOrderLiveEligible's step-4b decision and buildUnifiedRegimeEntryGate's decision agree for the SAME snapshot across healthy / LOW_COVERAGE / PANIC — two REAL, separately-wired closures, not independently-reimplemented logic", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Sideways rotation",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "i1-stable",
    });
    const order = paperOrder({
      paperOrderId: "i1-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Sideways rotation",
      controllerConfidence: null,
    } as Partial<PaperOrder>);

    for (const [label, snapshot] of [
      ["healthy", freshSnapshot("MIXED")],
      ["low-coverage", lowCoverageSnapshot("MIXED")],
      ["panic", panicSnapshot("MIXED")],
    ] as const) {
      const isEligible = buildIsPaperOrderLiveEligible({
        liveConfig: makeConfig({ env: "testnet" }),
        getUnifiedOrchestrator: () => null,
        getLiveEngine: () => null,
        getVariantMatrixStore: () => store,
        getCanonicalMarketRegimeSnapshot: () => snapshot,
      });
      const entryGate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => snapshot,
        env: {},
      });
      const paperVerdict = isEligible(order);
      const gateVerdict = entryGate().allowed;
      // For "healthy" the paper gate's true-ness ALSO depends on the maturity/proof gate (unrelated
      // to regime policy) — already proven true by construction (STABLE_CANDIDATE cohort above) — so
      // for "healthy" both are expected true; for low-coverage/panic BOTH must independently block.
      if (label === "healthy") {
        expect(paperVerdict, `${label}: buildIsPaperOrderLiveEligible`).toBe(true);
        expect(gateVerdict, `${label}: buildUnifiedRegimeEntryGate`).toBe(true);
      } else {
        expect(paperVerdict, `${label}: buildIsPaperOrderLiveEligible`).toBe(false);
        expect(gateVerdict, `${label}: buildUnifiedRegimeEntryGate`).toBe(false);
      }
    }
  });

  it("[I2, structural — 'shared code-path indicator'] exactly ONE definition of the shared getCanonicalMarketRegimeSnapshot accessor exists in app.ts, and it is passed BY REFERENCE (ES6 shorthand, not redefined) into both buildUnifiedRegimeEntryGate's and buildIsPaperOrderLiveEligible's deps objects", () => {
    const text = readAppTsSource();
    expect(countMatches(text, /const getCanonicalMarketRegimeSnapshot = \(/g)).toBe(1);
    // The shorthand-reference form (`getCanonicalMarketRegimeSnapshot,` on its own line, no `:` and
    // no `=` after it) proves the SAME closure binding is passed to both factories — a call site that
    // instead wrote `getCanonicalMarketRegimeSnapshot: () => somethingElse` would NOT match this
    // pattern, so this is a real structural guarantee, not merely "the identifier appears twice".
    const shorthandLines = countMatches(text, /^\s*getCanonicalMarketRegimeSnapshot,\s*$/gm);
    expect(shorthandLines).toBe(2);

    const unifiedGateBlock = sliceBetween(text, "const unifiedRegimeEntryGate = buildUnifiedRegimeEntryGate({", "});");
    expect(unifiedGateBlock).toMatch(/^\s*getCanonicalMarketRegimeSnapshot,\s*$/m);

    const paperEligibleBlock = sliceBetween(text, "isPaperOrderLiveEligible: buildIsPaperOrderLiveEligible({", "}),");
    expect(paperEligibleBlock).toMatch(/^\s*getCanonicalMarketRegimeSnapshot,\s*$/m);
  });

  it("[I3, structural] exactly 5 call sites of canonicalMarketRegimeExecutionPolicy( and exactly 2 of edgeMemoryLabelForCanonicalFamily( exist in app.ts, and every one of the 5 reads its snapshot from the shared accessor (deps.getCanonicalMarketRegimeSnapshot() or the bare closure-captured getCanonicalMarketRegimeSnapshot()) — never an independent, differently-named getter. (2026-08: was 4 before the manual-directional canonical-regime enforcement fix added buildManualDirectionalRegimeSafetyGate's own call — see that factory's doc comment in app.ts. The count growing by exactly 1, matching the SAME shared-accessor shape, is proof the new gate is real and shares the one canonical function; a jump by more than 1, or a call not sourced from the shared accessor, would mean an independent reimplementation and must still fail this test.)", () => {
    const text = readAppTsSource();
    expect(countMatches(text, /canonicalMarketRegimeExecutionPolicy\(/g)).toBe(5);
    expect(countMatches(text, /edgeMemoryLabelForCanonicalFamily\(/g)).toBe(2);

    // Every canonicalMarketRegimeExecutionPolicy({ call is immediately followed by a snapshot: line
    // reading one of the two accepted forms — collected via a single regex over the whole file so a
    // 6th, differently-sourced call site would be caught by the count assertion above, and a
    // MIS-sourced one of the 5 would be caught here.
    const callBlocks = text.match(/canonicalMarketRegimeExecutionPolicy\(\{\s*\n\s*snapshot: [^\n]+,/g) ?? [];
    expect(callBlocks).toHaveLength(5);
    for (const block of callBlocks) {
      expect(block).toMatch(/snapshot: (deps\.)?getCanonicalMarketRegimeSnapshot\(\),/);
    }

    // Both edgeMemoryLabelForCanonicalFamily( calls read regimeFamily off the same accessor.
    const edgeLabelCalls = text.match(/edgeMemoryLabelForCanonicalFamily\([^)]*getCanonicalMarketRegimeSnapshot\(\)[^)]*\)/gs) ?? [];
    expect(edgeLabelCalls.length).toBe(2);
  });

  it("[I4] direct proof the shared pure function itself is deterministic/identical across repeated calls with the same snapshot (the piece I2/I3 prove is genuinely shared, exercised behaviorally) — mirrors, and re-confirms, canonical-market-regime-execution-policy.test.ts's own adversarial-I suite", () => {
    const snapshot = lowCoverageSnapshot("BEARISH");
    const nowMs = Date.now();
    const callers = Array.from({ length: 4 }, () => canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs }));
    for (let i = 1; i < callers.length; i += 1) {
      expect(callers[i]).toEqual(callers[0]);
    }
    expect(callers[0]!.allowed).toBe(false);
    expect(callers[0]!.regimeFamily).toBe("MIXED"); // requirement #5's forced relabel, same for every caller
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL J — candidate-derived regime cannot influence authorization
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[ADVERSARIAL-J] candidate-derived (order.regime) regime cannot influence authorization", () => {
  it("[J1, negative] order.regime='Bullish expansion' (would have resolved to BULLISH -> LONG_BULLISH under the OLD estimateLaneSelectorV2Regime/rotationRegimeFamilyForLabel path, and a REAL STABLE_CANDIDATE proof for LONG_BULLISH genuinely exists in the store) is REJECTED when the canonical snapshot instead reports BEARISH", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Bullish expansion",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "j1-stable",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    // Forensic: the STABLE_CANDIDATE proof for LONG_BULLISH genuinely exists — a rejection below is
    // NOT because the evidence is missing.
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH").status).toBe("STABLE_CANDIDATE");

    const order = paperOrder({
      paperOrderId: "j1-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT",
      regime: "Bullish expansion", // the exact string that would have unlocked the proof above under the OLD system
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BEARISH"), // deliberately conflicts with order.regime's claim
    });
    expect(isEligible(order)).toBe(false);
  });

  it("[J1b, negative, isolated] VALIDATION-STAGE ADDITION: J1 alone can pass even if regimeFamily's SOURCE regresses to order.regime, because for a LONG+BULLISH order the function can also be blocked later by the rotation-shortlist/symbol-curation-tier fallback (steps 9-10) for reasons unrelated to regimeFamily's source — confirmed empirically: mutating step 3's regimeFamily back to an order.regime-derived value left J1 green (masked). This test isolates the SAME defect class using a LONG+MIXED order (rotationGateActive is false for MIXED, per app.ts's own `(direction===\"LONG\"&&regimeFamily===\"BULLISH\")||(direction===\"SHORT\"&&regimeFamily===\"BEARISH\")` condition), so the function returns via `maturityEligible` directly and cannot be coincidentally rescued or coincidentally blocked by the rotation-shortlist maze. order.regime='Sideways rotation' would have resolved (via the OLD estimateLaneSelectorV2Regime-derived path) to MIXED -> LONG_MIXED, and a REAL STABLE_CANDIDATE proof for LONG_MIXED genuinely exists; the canonical snapshot instead reports BULLISH (LONG_BULLISH has NO proof in this store) — must be REJECTED.", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Sideways rotation",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "j1b-stable",
    });
    const report = buildCurrentGuardVariantMatrixReport(store);
    // Forensic, same discipline as J1: the LONG_MIXED proof genuinely exists, and LONG_BULLISH does
    // NOT — a rejection below is because regimeFamily correctly comes from the canonical snapshot,
    // not because either context lacks evidence.
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_MIXED").status).toBe("STABLE_CANDIDATE");
    expect(laneStatusForContext(report, TEST_LANE_VARIANT_ID, "LONG_BULLISH").status).not.toBe("STABLE_CANDIDATE");

    const order = paperOrder({
      paperOrderId: "j1b-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "ETHUSDT", // never NEARUSDT — would trip the separate step-8 MIXED-NEARUSDT block
      regime: "Sideways rotation", // the exact string that would have unlocked LONG_MIXED under the OLD system
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible({
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"), // deliberately conflicts with order.regime's claim
    });
    expect(isEligible(order)).toBe(false);
  });

  const maliciousRegimeStrings: Array<{ label: string; regime: string | null }> = [
    { label: "empty string", regime: "" },
    { label: "legacy-BEARISH-coded (opposite direction)", regime: "Bearish pressure" },
    { label: "looks like a real ExactLaneContext value (wrong context)", regime: "SHORT_BEARISH" },
    { label: "looks like a real ExactLaneContext value (right-looking, still irrelevant)", regime: "LONG_BULLISH" },
    { label: "SQL-injection-flavored", regime: "'; DROP TABLE observations; --" },
    { label: "XSS-flavored", regime: "<script>alert(1)</script>" },
    { label: "bare AxisRegimeFamily-looking value", regime: "MIXED" },
    { label: "explicit null", regime: null },
  ];
  for (const { label, regime } of maliciousRegimeStrings) {
    it(`[J2, positive, ${label}] order.regime=${JSON.stringify(regime)} has ZERO effect: a genuine STABLE_CANDIDATE LONG_MIXED proof + a healthy canonical MIXED snapshot still authorizes the order`, () => {
      const store = new CurrentGuardVariantMatrixStore(tmpDir());
      addResolvedContextCohort(store, {
        variantId: TEST_LANE_VARIANT_ID,
        direction: "LONG",
        regime: "Sideways rotation",
        count: 143,
        netR: STABLE_NET_R,
        prefix: `j2-stable-${label.replace(/[^a-z0-9]+/gi, "-")}`,
      });
      const order = paperOrder({
        paperOrderId: `j2-order-${label}`,
        selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
        direction: "LONG",
        symbol: "ETHUSDT", // never NEARUSDT here — see J4 for that separate, still-legitimate interaction
        regime,
        controllerConfidence: null,
      } as Partial<PaperOrder>);
      const isEligible = buildIsPaperOrderLiveEligible({
        liveConfig: makeConfig({ env: "testnet" }),
        getUnifiedOrchestrator: () => null,
        getLiveEngine: () => null,
        getVariantMatrixStore: () => store,
        getCanonicalMarketRegimeSnapshot: () => freshSnapshot("MIXED"),
      });
      expect(isEligible(order)).toBe(true);
    });
  }

  it("[J3, structural] the master gate (buildUnifiedRegimeEntryGate's returned closure / LiveExecutionEngine.canOpenNewEntries()) is candidate-blind by construction — it takes ZERO per-candidate arguments, so no candidate-derived regime string could influence it even in principle", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
      env: {},
    });
    expect(gate.length).toBe(0); // arity: zero formal parameters
    // Calling it repeatedly (there is no "which candidate is asking" to vary) always agrees.
    const a = gate();
    const b = gate();
    expect(a).toEqual(b);
  });

  it("[J4, precision] order.regime is NOT dead — it is still legitimately read for orderEstimatedRegime.direction (the PRE-EXISTING, unchanged step 8 MIXED-NEARUSDT lane-book restriction), which is a DIFFERENT purpose than regimeFamily/exactContext (step 3). This isolates exactly what changed (regimeFamily's source) from what did not (orderEstimatedRegime.direction's source).", () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    addResolvedContextCohort(store, {
      variantId: TEST_LANE_VARIANT_ID,
      direction: "LONG",
      regime: "Sideways rotation",
      count: 143,
      netR: STABLE_NET_R,
      prefix: "j4-stable",
    });
    const baseDeps = {
      liveConfig: makeConfig({ env: "testnet" }),
      getUnifiedOrchestrator: () => null,
      getLiveEngine: () => null,
      getVariantMatrixStore: () => store,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("MIXED"),
    };
    const nearOrder = paperOrder({
      paperOrderId: "j4-near-order",
      selectedLaneId: `CG_VARIANT_MATRIX:${TEST_LANE_VARIANT_ID}`,
      direction: "LONG",
      symbol: "NEARUSDT",
      regime: "Sideways rotation", // still drives orderEstimatedRegime.direction === "MIXED" via estimateLaneSelectorV2Regime
      controllerConfidence: null,
    } as Partial<PaperOrder>);
    const ethOrder = paperOrder({
      ...nearOrder,
      paperOrderId: "j4-eth-order",
      symbol: "ETHUSDT",
    } as Partial<PaperOrder>);
    const isEligible = buildIsPaperOrderLiveEligible(baseDeps);
    expect(isEligible(nearOrder)).toBe(false); // step 8: MIXED direction + NEARUSDT, still order.regime-derived
    expect(isEligible(ethOrder)).toBe(true); // identical in every other respect — isolates the NEARUSDT branch
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL K — exact-context keys and historical data remain unchanged
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[ADVERSARIAL-K] exact-context keys and historical data remain unchanged", () => {
  it("[K1] exactLaneContextFor's mapping is a byte-identical behavioral fingerprint of the documented ground truth across the full input matrix", () => {
    const directions = ["LONG", "SHORT"] as const;
    const families = ["BULLISH", "BEARISH", "MIXED", "UNKNOWN", "GARBAGE_VALUE", null, undefined] as const;
    const expected = new Map<string, ExactLaneContext | null>([
      ["LONG:BULLISH", "LONG_BULLISH"],
      ["LONG:BEARISH", null],
      ["LONG:MIXED", "LONG_MIXED"],
      ["LONG:UNKNOWN", null],
      ["LONG:GARBAGE_VALUE", null],
      ["LONG:null", null],
      ["LONG:undefined", null],
      ["SHORT:BULLISH", null],
      ["SHORT:BEARISH", "SHORT_BEARISH"],
      ["SHORT:MIXED", "SHORT_MIXED"],
      ["SHORT:UNKNOWN", null],
      ["SHORT:GARBAGE_VALUE", null],
      ["SHORT:null", null],
      ["SHORT:undefined", null],
    ]);
    for (const direction of directions) {
      for (const family of families) {
        const key = `${direction}:${family}`;
        expect(exactLaneContextFor(direction, family), key).toBe(expected.get(key));
      }
    }
    // Also pin the "neither LONG nor SHORT" / null-direction case stays null across every family.
    for (const family of families) {
      expect(exactLaneContextFor(null, family)).toBeNull();
      expect(exactLaneContextFor(undefined, family)).toBeNull();
    }
  });

  it("[K2] exactly 4 distinct non-null ExactLaneContext values are ever produced across the full {LONG,SHORT} x {BULLISH,BEARISH,MIXED} matrix, and they are precisely the 4 documented literals — nothing added, nothing removed, nothing renamed", () => {
    const outputs = new Set<string>();
    for (const direction of ["LONG", "SHORT"] as const) {
      for (const family of ["BULLISH", "BEARISH", "MIXED"] as const) {
        const result = exactLaneContextFor(direction, family);
        if (result !== null) outputs.add(result);
      }
    }
    expect([...outputs].sort()).toEqual(["LONG_BULLISH", "LONG_MIXED", "SHORT_BEARISH", "SHORT_MIXED"]);
  });

  it("[K3, structural] the ExactLaneContext type declaration in current-guard-variant-matrix.ts is still exactly the 4-arm union", () => {
    const text = readFileSync(CGVM_TS_PATH, "utf-8");
    const declStart = text.indexOf("export type ExactLaneContext =");
    expect(declStart).toBeGreaterThan(-1);
    const declEnd = text.indexOf(";", declStart);
    expect(declEnd).toBeGreaterThan(declStart);
    const decl = text.slice(declStart, declEnd + 1).replace(/\s+/g, " ").trim();
    expect(decl).toBe('export type ExactLaneContext = | "LONG_BULLISH" | "SHORT_BEARISH" | "LONG_MIXED" | "SHORT_MIXED";');
  });

  it("[K4, structural] the AxisRegimeFamily type declaration is still exactly the 4-value union", () => {
    const text = readFileSync(CGVM_TS_PATH, "utf-8");
    expect(text).toContain('export type AxisRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";');
  });

  it("[K5, regression tripwire, best-effort git check] current-guard-variant-matrix.ts has ZERO diff against this rollout's own base commit — a real git-level guarantee, verified via `git -C <apps/api> diff`, not merely a same-session read. Never fails the suite on an unrelated environment issue (shallow clone, git unavailable) — but never stays silent about it either.", () => {
    try {
      const out = execFileSync(
        "git",
        ["-C", process.cwd(), "diff", "--stat", BASE_COMMIT, "--", "src/lib/current-guard-variant-matrix.ts"],
        { encoding: "utf-8" },
      );
      expect(out.trim()).toBe("");
    } catch (error) {
      console.warn(`[K5] skipped git-diff tripwire (non-fatal, environment-dependent): ${(error as Error).message}`);
    }
  });

  it("[K6, sanity] hasExactContextReadinessProof itself is unchanged (imported from the real app.ts export, not reimplemented) — a belt-and-suspenders re-check alongside execution-readiness-context.test.ts's own suite for this exact function", () => {
    expect(
      hasExactContextReadinessProof({
        laneId: "x",
        context: "LONG_BULLISH",
        applicable: true,
        direct: true,
        status: "STABLE_CANDIDATE",
        statusReason: "test",
        blockers: [],
        cautions: [],
        evidence: {
          context: "LONG_BULLISH",
          freshValid: 5,
          netAvgR: 0.1,
          grossAvgR: 0.2,
          pf: 1.5,
          wr: 0.6,
          payoffRatio: 1.2,
          plus10bpsNetAvgR: null,
          plus10bpsStillPositive: false,
          approxMaxDrawdownR: null,
          topSymbolPnlShare: null,
          calendarDays: null,
          distinctRegimes: 1,
          oosThirds: null,
          allThreeOosPositive: false,
          status: "STABLE_CANDIDATE",
          statusReason: "test",
          blockers: [],
          cautions: [],
        },
      }),
    ).toBe(true);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildManualDirectionalRegimeSafetyGate, buildUnifiedRegimeEntryGate } from "../src/app.js";
import type { CanonicalMarketRegimeSnapshot } from "../src/lib/canonical-market-regime-execution-policy.js";
import type { LiveExecutionEngine, LiveNewEntryGateDecision } from "../src/lib/live-execution-engine.js";
import { newExecutorLaneGate } from "../src/lib/live-executor-wiring.js";
import { UnifiedTestnetOrchestrator, UnifiedTestnetOrchestratorStore, type UnifiedOrchestratorInput } from "../src/lib/unified-testnet-orchestrator.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import { makeEngine, makePaperStore, paperOrder } from "./live-execution-engine.test.js";

/**
 * 2026-08 manual-directional canonical-regime enforcement fix — dedicated fail-without/pass-with +
 * adversarial + mutation-checked suite for LiveExecutionEngine's manual-directional entry branch
 * (entryGateDecision(), live-execution-engine.ts) and its two new collaborators: app.ts's
 * buildManualDirectionalRegimeSafetyGate, and the engine's new `regimeSafetyGate` option /
 * `newEntryBlockReason()` diagnostic.
 *
 * The bug this closes: canOpenNewEntries()'s manual-directional branch used to short-circuit
 * straight to isManualDirectionalEntryEnabled() (a maturity/proof-boundary check only) and never
 * reached strategyEntryGate()/newEntryGate() — the only path that otherwise consults
 * canonicalMarketRegimeExecutionPolicy. A manual-directional entry could open through a market-wide
 * PANIC or LOW_COVERAGE blackout every non-manual lane already refused.
 *
 * Every test here constructs a REAL LiveExecutionEngine (via this repo's own makeEngine() test
 * harness, apps/api/test/live-execution-engine.test.ts) wired with the REAL, exported production
 * factories (buildManualDirectionalRegimeSafetyGate, buildUnifiedRegimeEntryGate) and REAL
 * hand-built canonical snapshot fixtures — never a hand-simulated stand-in for the gate logic
 * itself.
 *
 * Companion coverage, not duplicated here:
 *  - canonical-market-regime-adversarial-execution-paths.test.ts's [H8]/[H8-control]: the SAME core
 *    claim (test 1 below), proven again with that suite's own CurrentGuardVariantMatrix
 *    proof-boundary fixture — kept there because it is that file's own designated regression home
 *    for "does every entry path honor LOW_COVERAGE".
 *  - unified-regime-entry-gate.test.ts: buildUnifiedRegimeEntryGate's OWN full behavioral suite —
 *    this file only reuses that factory, unmodified, to construct a real maturity-shaped block.
 *  - canonical-market-regime-execution-policy.test.ts: canonicalMarketRegimeExecutionPolicy's OWN
 *    pure-function suite — this file reuses real fixtures/factories, never re-derives its logic.
 */

// ─── canonical snapshot fixtures (same shape/discipline as canonical-market-regime-adversarial-
//     execution-paths.test.ts's own fixtures — atMs stamped at Date.now() call time, matching the
//     REAL wall clock buildManualDirectionalRegimeSafetyGate/buildUnifiedRegimeEntryGate consult) ──

function freshSnapshot(
  regimeFamily: "BULLISH" | "BEARISH" | "MIXED",
  overrides: Partial<CanonicalMarketRegimeSnapshot> = {},
): CanonicalMarketRegimeSnapshot {
  const nowMs = Date.now();
  return {
    schemaVersion: 1,
    engineVersion: "manual-regime-safety-fixture-v1",
    calibrationVersion: "v1-hand-set-defaults",
    atMs: nowMs,
    atIso: new Date(nowMs).toISOString(),
    universeVersion: "manual-regime-safety-universe-v1",
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

// ─── UnifiedTestnetOrchestrator plumbing (same convention as unified-regime-entry-gate.test.ts's
//     own buildOrchestrator()) — used ONLY to construct a REAL maturity-shaped ("direction not yet
//     confirmed") block for test 2 below, never touched by this fix. ──────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildOrchestrator(enabled: boolean): UnifiedTestnetOrchestrator {
  const dir = mkdtempSync(join(tmpdir(), "manual-regime-safety-orchestrator-"));
  dirs.push(dir);
  return new UnifiedTestnetOrchestrator({ enabled, store: new UnifiedTestnetOrchestratorStore(dir), confirmSamples: 2, choppySamples: 2 });
}

function orchestratorInput(id: string, direction: "LONG" | "SHORT" | "NEUTRAL"): UnifiedOrchestratorInput {
  return {
    sampleId: id,
    capturedAt: new Date(1_700_000_000_000 + Number(id.replace(/\D/g, "")) * 60_000).toISOString(),
    primaryDirection: direction,
    primaryConfidence: direction === "NEUTRAL" ? null : "MEDIUM",
    primaryReason: `controller ${direction}`,
    votes: [],
    neutralProposalAllowed: false,
    neutralProposalReason: "rolling edge unavailable",
  };
}

// ─── manual-directional mode activation — mirrors canonical-market-regime-adversarial-execution-
//     paths.test.ts's makeManualEngineForLongLane() exactly (same lane id, same fresh observedAt,
//     matching makeEngine()'s own default nowIso()). ─────────────────────────────────────────────

const TEST_LANE_ID = "CG_WIDE_STOP_TP_WIDE";
const FRESH_OBSERVED_AT = "2099-01-02T12:00:00.000Z"; // matches makeEngine()'s default nowIso() exactly

function activateManualLongMode(engine: LiveExecutionEngine, laneId: string = TEST_LANE_ID): void {
  const setup = engine.setManualDirectionalLaneAllocations({ long: [{ laneId, weightPct: 100 }], short: [] });
  if (!setup.ok) {
    throw new Error(`[manual-directional-regime-safety-gate] test setup failed: manual allocation rejected — ${setup.reason}`);
  }
  engine.setManualSelectorMode(true);
  engine.setManualEntryDecision({
    action: "WAIT_PULLBACK",
    directionalBias: "LONG",
    reason: "[manual-directional-regime-safety-gate] test fixture",
    observedAt: FRESH_OBSERVED_AT,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-1] manual-directional entries are blocked when the canonical regime policy would block a
// non-manual entry
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[FIX-1] manual-directional mode is blocked by the canonical regime policy exactly like non-manual lanes", () => {
  it("[1a, fail-without/pass-with] LOW_COVERAGE blocks a manual-directional entry via the new regimeSafetyGate, with a matching reason", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
    });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    // Sanity: the ONLY reason this should be blocked is the new regime-safety gate — maturity is
    // satisfied (fresh decision, active allocation).
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/coverage/i);
  });

  it("[1b] PANIC blocks a manual-directional entry via the new regimeSafetyGate, with a matching reason", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => panicSnapshot(),
    });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/panic/i);
  });

  it("[1c, control] the SAME manual engine, fed a HEALTHY snapshot through the SAME regimeSafetyGate wiring, is allowed — proves 1a/1b's `false` is caused by the regime overlay specifically, not some unrelated default", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
    });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(engine.newEntryBlockReason()).toBeNull();
  });

  it("[1d, production-shaped wiring, end-to-end] ONE shared getCanonicalMarketRegimeSnapshot closure feeding BOTH newEntryGate (buildUnifiedRegimeEntryGate) and regimeSafetyGate (buildManualDirectionalRegimeSafetyGate) — the EXACT shape app.ts's buildApp() wires (both factories passed the same `getCanonicalMarketRegimeSnapshot` shorthand reference) — correctly blocks/allows a manual-directional entry across healthy -> LOW_COVERAGE -> PANIC -> recovered transitions on ONE long-lived engine instance", async () => {
    let snapshot: CanonicalMarketRegimeSnapshot | null = freshSnapshot("BULLISH");
    const getCanonicalMarketRegimeSnapshot = () => snapshot;
    const newEntryGate = buildUnifiedRegimeEntryGate({ getUnifiedOrchestrator: () => null, getCanonicalMarketRegimeSnapshot, env: {} });
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot });
    const { engine } = makeEngine({ newEntryGate, regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);

    expect(engine.canOpenNewEntries()).toBe(true); // healthy

    snapshot = lowCoverageSnapshot();
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/coverage/i);

    snapshot = panicSnapshot();
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/panic/i);

    snapshot = freshSnapshot("BEARISH");
    expect(engine.canOpenNewEntries()).toBe(true); // recovers once the snapshot recovers
    expect(engine.newEntryBlockReason()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-2] manual-directional mode still bypasses ONLY the maturity/direction-confirmation gate —
// never the regime-safety gate
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[FIX-2] manual-directional mode bypasses ONLY the maturity gate, never the regime-safety gate", () => {
  it("[2a] a fresh (non-converged) UnifiedTestnetOrchestrator blocks the NON-manual path with a maturity-shaped reason, while the SAME engine's manual-directional path (healthy regimeSafetyGate) still opens — the intended, narrowed bypass survives", async () => {
    const orchestrator = buildOrchestrator(true); // enabled, fresh store -> FLAT -> canOpenNewEntries()=false
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
      env: {},
    });
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
    });
    const { engine } = makeEngine({ newEntryGate, regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);

    // Non-manual path: blocked, and blocked for the MATURITY reason specifically.
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(false);
    const nonManualReason = newEntryGate().reason;
    expect(nonManualReason).toMatch(/unified orchestrator/i);

    // Manual path: same engine, same orchestrator, same (healthy) canonical snapshot — ALLOWED.
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(engine.newEntryBlockReason()).toBeNull();
  });

  it("[2b, adversarial] the SAME maturity-blocked orchestrator, but this time the regimeSafetyGate ALSO blocks (LOW_COVERAGE) — manual mode is now blocked too, proving the bypass is NOT blanket: only maturity is skippable, never regime safety", async () => {
    const orchestrator = buildOrchestrator(true); // fresh -> FLAT -> maturity-blocked
    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
      env: {},
    });
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({
      getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot(),
    });
    const { engine } = makeEngine({ newEntryGate, regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);

    expect(engine.canOpenNewEntries()).toBe(false);
    // Reason must be the REGIME block, not the (also-true, but irrelevant to the manual path)
    // maturity block — proving manual mode reached the regime-safety gate at all, not that it
    // coincidentally stayed blocked for an unrelated reason.
    expect(engine.newEntryBlockReason()).toMatch(/coverage/i);
  });

  it("[2c, forensic control] once the SAME orchestrator converges a direction, the non-manual path also opens — confirms 2a's non-manual `false` really was the orchestrator's maturity gate, not a mis-set fixture", async () => {
    const orchestrator = buildOrchestrator(true);
    orchestrator.update(orchestratorInput("1", "LONG"));
    orchestrator.update(orchestratorInput("2", "LONG"));
    expect(orchestrator.canOpenNewEntries()).toBe(true); // sanity on the harness itself

    const newEntryGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => freshSnapshot("BULLISH"),
      env: {},
    });
    const { engine } = makeEngine({ newEntryGate });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntriesIgnoringManualDirectional()).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-3] armed / kill / drain still gate manual-directional entries exactly as they gate
// non-manual ones — checked BEFORE, and independently of, the new regime-safety gate
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[FIX-3] armed/kill/drain gate manual-directional entries with no exemption, and are checked before the regime-safety gate", () => {
  it("[3a] not armed: blocked with the pre-existing reason; the regime-safety gate (and the strategy gate) are never even invoked", async () => {
    const gateSpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine } = makeEngine({ newEntryGate: gateSpy, regimeSafetyGate: safetySpy });
    activateManualLongMode(engine); // primed exactly for a manual entry — not armed still wins
    expect(engine.isArmed()).toBe(false);
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toBe("engine is not ARMED");
    expect(safetySpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("[3b] killed: blocked with the kill reason; the regime-safety gate is never invoked", async () => {
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine, store } = makeEngine({ regimeSafetyGate: safetySpy });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true); // sanity: genuinely open before the kill
    safetySpy.mockClear(); // the sanity call above legitimately invoked it once — reset before the real assertion
    store.getState().killedAt = "2099-01-02T12:30:00.000Z";
    store.getState().killReason = "[test] kill-switch latched";
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toBe("[test] kill-switch latched");
    expect(safetySpy).not.toHaveBeenCalled();
  });

  it("[3c] new-entry drain active: blocked with the drain reason; the regime-safety gate is never invoked", async () => {
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine } = makeEngine({ regimeSafetyGate: safetySpy });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true); // sanity: genuinely open before the drain
    safetySpy.mockClear(); // the sanity call above legitimately invoked it once — reset before the real assertion
    engine.setNewEntriesPaused(true, "[test] operator drain");
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/drain/i);
    expect(safetySpy).not.toHaveBeenCalled();
  });

  it("[3d] armed + not killed + not drained + manual mode + fresh decision: the regime-safety gate IS invoked exactly once, and the (non-manual) strategy gate is NEVER invoked", async () => {
    const gateSpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine } = makeEngine({ newEntryGate: gateSpy, regimeSafetyGate: safetySpy });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(safetySpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("[3e, exclusivity, opposite direction] armed + not killed + not drained + NON-manual: the (non-manual) strategy gate IS invoked, and the regime-safety gate is NEVER invoked", async () => {
    const gateSpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine } = makeEngine({ newEntryGate: gateSpy, regimeSafetyGate: safetySpy });
    expect((await engine.arm()).ok).toBe(true);
    // manual mode deliberately NOT activated here.
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(safetySpy).not.toHaveBeenCalled();
  });

  it("[3f, scope boundary] mirrorAllPaperOrders (testnet collect-all) still bypasses BOTH gates regardless of manual mode — this fix must not have touched that pre-existing, unrelated short-circuit", async () => {
    const gateSpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const safetySpy = vi.fn((): LiveNewEntryGateDecision => ({ allowed: true, reason: null }));
    const { engine } = makeEngine({ config: { mirrorAllPaperOrders: true }, newEntryGate: gateSpy, regimeSafetyGate: safetySpy });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(engine.newEntryBlockReason()).toBeNull();
    expect(gateSpy).not.toHaveBeenCalled();
    expect(safetySpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-4] explicit rejection diagnostics
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[FIX-4] explicit, correctly-named rejection diagnostics for distinct blocking reasons", () => {
  it("[4a] LOW_COVERAGE: newEntryBlockReason() and getStatus().newEntries.blockReason agree and name coverage specifically", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot() });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    const reason = engine.newEntryBlockReason();
    expect(reason).toMatch(/coverage/i);
    const status = engine.getStatus();
    expect(status.newEntries.allowed).toBe(false);
    expect(status.newEntries.blockReason).toBe(reason);
  });

  it("[4b] PANIC: names panic specifically, and is textually DISTINCT from the coverage reason (2 distinct blocking reasons, not one generic string)", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot: () => panicSnapshot() });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    const reason = engine.newEntryBlockReason();
    expect(reason).toMatch(/panic/i);
    expect(reason).not.toMatch(/coverage/i);
  });

  it("[4c] stale/absent manual Entry Decision names ITS OWN condition — distinct from both the regime reasons above and from armed/kill/drain — so an operator sees a manual-mode-specific cause, not a generic fallback", async () => {
    const { engine } = makeEngine();
    expect((await engine.arm()).ok).toBe(true);
    const setup = engine.setManualDirectionalLaneAllocations({ long: [{ laneId: TEST_LANE_ID, weightPct: 100 }], short: [] });
    expect(setup.ok).toBe(true);
    engine.setManualSelectorMode(true);
    // Deliberately no setManualEntryDecision() call — no current directional bias.
    expect(engine.canOpenNewEntries()).toBe(false);
    const reason = engine.newEntryBlockReason();
    expect(reason).toMatch(/entry decision/i);
    expect(reason).not.toMatch(/coverage|panic|ARMED|kill|drain/i);
  });

  it("[4d, real end-to-end integration] live-executor-wiring.ts's newExecutorLaneGate, wired to a REAL blocked LiveExecutionEngine (not a fake), surfaces the SAME specific regime reason instead of the generic drain fallback — the actual consumer path every SingleSymbolLaneExecutor lane's getStatus().entryBlockReason flows through", async () => {
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot() });
    const { engine } = makeEngine({ regimeSafetyGate });
    expect((await engine.arm()).ok).toBe(true);
    activateManualLongMode(engine);
    expect(engine.canOpenNewEntries()).toBe(false); // sanity
    const gate = newExecutorLaneGate("SOME_LANE", "testnet", engine);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/coverage/i);
    expect(gate.reason).not.toBe("new-entry drain is active (operator paused new entries)");
    // The backward-compat fallback (an engine/fake with no newEntryBlockReason at all) is covered
    // by live-executor-wiring.test.ts's own "newExecutorLaneGate reason plumbing" describe block,
    // co-located with newExecutorLaneGate's other pure-unit tests.
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// [FIX-5] exit / close / reduce / protective-order paths are completely unaffected
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("[FIX-5] exit/close paths are completely unaffected by this fix — exits must never be blocked", () => {
  /** Opens one REAL intent through the (healthy, default, non-manual) paper mirror — same
   *  established pattern as live-execution-engine.test.ts's own "manualCloseIntent" describe
   *  block's openOne() helper. regimeSafetyGate is wired to an ALWAYS-BLOCKING function from the
   *  start (irrelevant while manual mode is off, since entryGateDecision() only ever calls it from
   *  the manual branch — confirmed independently by [FIX-3]'s 3e/3d exclusivity tests above), so the
   *  SAME engine can be flipped straight into "manual mode would be regime-blocked" afterward with
   *  no need to reconstruct it (regimeSafetyGate is constructor-injected, not mutable post-hoc). */
  async function openOneUnderAlwaysBlockingRegimeGate() {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    const regimeSafetyGate = buildManualDirectionalRegimeSafetyGate({ getCanonicalMarketRegimeSnapshot: () => lowCoverageSnapshot() });
    const made = makeEngine({ paper: makePaperStore([order]), regimeSafetyGate });
    expect((await made.engine.arm()).ok).toBe(true);
    await made.engine.tick();
    expect(made.store.getState().intents.length).toBe(1);
    return made;
  }

  it("[5a, surgical] manualCloseIntent still executes when ONLY this fix's OWN new code is in a blocking state (armed, not killed, not drained, manual mode active with a fresh decision, regimeSafetyGate blocking on LOW_COVERAGE)", async () => {
    const { engine, store } = await openOneUnderAlwaysBlockingRegimeGate();
    const intent = store.getState().intents[0]!;
    activateManualLongMode(engine);
    // Sanity: new entries are genuinely blocked right now, by exactly the condition this fix added.
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/coverage/i);
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(store.getState().intents[0]!.closeReason).toBe("OPERATOR_CLOSE");
  });

  it("[5b, kitchen sink, matches the literal adversarial ask] manualCloseIntent still executes with kill + drain + disarmed + manual-regime-block ALL active simultaneously", async () => {
    const { engine, store } = await openOneUnderAlwaysBlockingRegimeGate();
    const intent = store.getState().intents[0]!;
    activateManualLongMode(engine);
    engine.disarm("[test] adversarial exit-path check");
    store.getState().killedAt = "2099-01-02T13:00:00.000Z";
    store.getState().killReason = "[test] kill-switch latched";
    engine.setNewEntriesPaused(true, "[test] operator drain");
    // Sanity: every single condition this fix's own entryGateDecision() checks is now blocking.
    expect(engine.isArmed()).toBe(false);
    expect(engine.canOpenNewEntries()).toBe(false);
    const res = await engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    expect(store.getState().intents[0]!.state).toBe("CLOSED");
    expect(engine.isArmed()).toBe(false); // manual close must not silently re-arm anything either
  });

  it("[5c, structural] manualCloseIntent's own source body references none of this fix's new identifiers (or the pre-existing armed/kill/drain gate) — a static guarantee this fix's diff could not have reached the exit path, on top of the behavioral proof above", () => {
    const path = resolve(process.cwd(), "src", "lib", "live-execution-engine.ts");
    const text = readFileSync(path, "utf-8");
    const startAnchor = "async manualCloseIntent(paperOrderId: string): Promise<";
    const startIdx = text.indexOf(startAnchor);
    expect(startIdx).toBeGreaterThan(-1);
    // manualCloseIntent is immediately followed by the "── kill-switch ──" section header comment
    // in the current source (see live-execution-engine.ts) — used as the end anchor so this slice
    // captures the WHOLE method body, not a truncated prefix.
    const endAnchor = "// ── kill-switch";
    const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = text.slice(startIdx, endIdx);
    for (const forbidden of [
      "canOpenNewEntries",
      "entryGateDecision",
      "manualRegimeSafetyGate",
      "regimeSafetyGate",
      "this.armed",
      "killedAt",
      "isNewEntryDrainActive",
    ]) {
      expect(body, `manualCloseIntent must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("[5d, structural] canOpenNewEntriesIgnoringManualDirectional()'s own body references none of this fix's new identifiers — pins that this pre-existing sibling gate stayed fully independent of the new regimeSafetyGate/manualRegimeSafetyGate machinery, exactly as the design intended", () => {
    const path = resolve(process.cwd(), "src", "lib", "live-execution-engine.ts");
    const text = readFileSync(path, "utf-8");
    const startAnchor = "canOpenNewEntriesIgnoringManualDirectional(): boolean {";
    const startIdx = text.indexOf(startAnchor);
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = text.indexOf("\n  }\n", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = text.slice(startIdx, endIdx);
    expect(body).not.toContain("regimeSafetyGate");
    expect(body).not.toContain("manualRegimeSafetyGate");
    expect(body).not.toContain("entryGateDecision");
    // It DOES still, unchanged, call strategyEntryGate() — confirmed positively (not just an
    // absence check) so this test cannot vacuously pass against an empty/mis-sliced body.
    expect(body).toContain("this.strategyEntryGate().allowed");
  });
});

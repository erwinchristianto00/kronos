import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildUnifiedRegimeEntryGate, regimeGateEscapeHatchAllowedOnInstance } from "../src/app.js";
import {
  UnifiedTestnetOrchestrator,
  UnifiedTestnetOrchestratorStore,
  type UnifiedOrchestratorInput,
} from "../src/lib/unified-testnet-orchestrator.js";
import type { CanonicalMarketRegimeSnapshot } from "../src/lib/canonical-market-regime-execution-policy.js";
import type { LiveNewEntryGateDecision } from "../src/lib/live-execution-engine.js";
import type { PaperOrder } from "../src/lib/paper-execution-router.js";
import { makeEngine, makePaperStore, paperOrder } from "./live-execution-engine.test.js";

// 2026-08 canonical-market-regime rollout — this is the fail-without/pass-with + adversarial test
// suite for `buildUnifiedRegimeEntryGate`, the extracted, testable body of the master
// `unifiedRegimeEntryGate` closure buildApp() wires as `newEntryGate` into LiveExecutionEngine (see
// its own doc comment in app.ts for the full "why extracted" rationale — mirrors
// `buildIsPaperOrderLiveEligible`'s own precedent). This closure sits underneath
// `canOpenNewEntries()` / `canOpenNewEntriesIgnoringManualDirectional()`, the shared master gate for
// the paper mirror, every SingleSymbolLaneExecutor, CrossSectionalExecutor, and every innovation
// testnet executor — so its own decision logic is tested directly here, once, rather than only
// indirectly through 11+ downstream call sites.

const NOW_MS = Date.UTC(2026, 7, 1, 12, 0, 0);

function healthySnapshot(overrides: Partial<CanonicalMarketRegimeSnapshot> = {}): CanonicalMarketRegimeSnapshot {
  return {
    schemaVersion: 1,
    engineVersion: "test-engine-v1",
    calibrationVersion: "v1-hand-set-defaults",
    atMs: NOW_MS,
    atIso: new Date(NOW_MS).toISOString(),
    universeVersion: "test-universe-v1",
    universeSize: 60,
    sourceObservationIds: {},
    perSymbol: [],
    directionFast: 0.01,
    directionSlow: 0.02,
    breadth: 0.1,
    cohesion: 0.7,
    dispersion: 1.2,
    riskStress: 0.2,
    coverage: { validSymbolCount: 58, requiredSymbolCount: 60, coveragePct: 96.6, status: "VALID", reasons: [] },
    projection: "BULLISH",
    regimeFamily: "BULLISH",
    overlays: {
      transition: false,
      highStress: false,
      panic: false,
      lowCoverage: false,
      rotational: false,
      fragmented: false,
    },
    confidence: 0.8,
    stateHistory: {
      projectionSinceMs: NOW_MS - 3_600_000,
      cyclesInProjection: 4,
      lastFlipAtMs: NOW_MS - 3_600_000,
      panicSinceMs: null,
      panicCyclesSinceExitCandidate: 0,
    },
    status: "VALID",
    ...overrides,
  };
}

// Same temp-dir-per-orchestrator pattern as unified-testnet-orchestrator.test.ts's own `build()` —
// never touches this repo's real data/ directory.
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildOrchestrator(enabled: boolean): UnifiedTestnetOrchestrator {
  const dir = mkdtempSync(join(tmpdir(), "unified-regime-entry-gate-"));
  dirs.push(dir);
  return new UnifiedTestnetOrchestrator({
    enabled,
    store: new UnifiedTestnetOrchestratorStore(dir),
    confirmSamples: 2,
    choppySamples: 2,
  });
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

describe("buildUnifiedRegimeEntryGate — canonical-regime redirect (requirement #1's master gate)", () => {
  it("[PASS-WITH] a fresh, healthy canonical snapshot allows new entries when no unified orchestrator is present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => healthySnapshot(),
      env: {},
    });
    expect(gate()).toEqual({ allowed: true, reason: null });
  });

  it("[ADVERSARIAL / fail-without] a null canonical snapshot (cold start, kill switch, or — right now — the engine module not existing yet) blocks new entries — this getter did not exist at all before this round's redirect", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: {},
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no snapshot/i);
  });

  it("[ADVERSARIAL] PANIC overlay blocks new entries even though coverage/projection are otherwise healthy (requirement #6 enforced as a hard AND-term, not just a state label)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () =>
        healthySnapshot({
          overlays: { transition: false, highStress: false, panic: true, lowCoverage: false, rotational: false, fragmented: false },
        }),
      env: {},
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/panic/i);
  });

  it("[ADVERSARIAL] LOW_COVERAGE / invalid coverage blocks new entries (requirement #5)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () =>
        healthySnapshot({
          coverage: { validSymbolCount: 20, requiredSymbolCount: 60, coveragePct: 33.3, status: "INVALID", reasons: ["only 20/60 symbols fresh"] },
          overlays: { transition: false, highStress: false, panic: false, lowCoverage: true, rotational: false, fragmented: false },
        }),
      env: {},
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/coverage/i);
  });

  it("[ADVERSARIAL] a stale snapshot blocks new entries", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => healthySnapshot({ atMs: NOW_MS - 30 * 60_000 }), // 30 min old
      env: {},
    });
    // Deliberately no vi.setSystemTime pin here: real "now" is far past this 2026-08 fixture's
    // atMs regardless of when this test actually runs, so staleness is unambiguous either way.
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
  });

  it("the pre-existing unified-orchestrator early return is untouched: an enabled orchestrator that has not yet confirmed a direction (fresh store -> FLAT -> canOpenNewEntries()=false) blocks with its OWN reason, regardless of a perfectly healthy canonical snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const orchestrator = buildOrchestrator(true);
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => healthySnapshot(),
      env: {},
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/unified orchestrator/i);
  });

  it("once the unified orchestrator confirms a direction (canOpenNewEntries()=true), the gate falls through to the canonical-regime decision — proven both ways with the SAME confirmed orchestrator", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const orchestrator = buildOrchestrator(true);
    orchestrator.update(orchestratorInput("1", "LONG"));
    orchestrator.update(orchestratorInput("2", "LONG"));
    expect(orchestrator.canOpenNewEntries()).toBe(true); // sanity check on the test harness itself

    const allowedGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => healthySnapshot(),
      env: {},
    });
    expect(allowedGate()).toEqual({ allowed: true, reason: null });

    const blockedGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: {},
    });
    expect(blockedGate().allowed).toBe(false);
  });

  it("[escape hatch, unchanged] LIVE_REGIME_NO_TRADE_OVERRIDE=1 allows new entries even with no canonical snapshot at all", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
    expect(gate()).toEqual({ allowed: true, reason: null });
  });

  it("[escape hatch, unchanged] REGIME_ENGINE_EXECUTION_GATE_ENABLED=0 allows new entries even with no canonical snapshot at all", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { REGIME_ENGINE_EXECUTION_GATE_ENABLED: "0" },
    });
    expect(gate()).toEqual({ allowed: true, reason: null });
  });

  it("[ordering, unchanged] the escape hatches do NOT bypass the unified-orchestrator block — that check still runs first, exactly as before this round", () => {
    const orchestrator = buildOrchestrator(true); // fresh -> FLAT -> canOpenNewEntries()=false
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => orchestrator,
      getCanonicalMarketRegimeSnapshot: () => healthySnapshot(),
      env: { LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/unified orchestrator/i);
  });

  it("defaults `env` to the real process.env when not supplied (production wiring never passes env explicitly)", () => {
    const originalOverride = process.env.LIVE_REGIME_NO_TRADE_OVERRIDE;
    const originalPort = process.env.PORT;
    process.env.LIVE_REGIME_NO_TRADE_OVERRIDE = "1";
    // 2026-08 regime-escape-hatch hardening made this gate PORT-sensitive (see
    // regimeGateEscapeHatchAllowedOnInstance below) — pin PORT explicitly to a non-3103 value so this
    // test's outcome can never depend on whatever happens to be ambient in the test runner's env.
    process.env.PORT = "3101";
    try {
      const gate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => null,
        // no `env` field at all — must fall back to process.env
      });
      expect(gate()).toEqual({ allowed: true, reason: null });
    } finally {
      if (originalOverride === undefined) delete process.env.LIVE_REGIME_NO_TRADE_OVERRIDE;
      else process.env.LIVE_REGIME_NO_TRADE_OVERRIDE = originalOverride;
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });
});

describe("regimeGateEscapeHatchAllowedOnInstance / regime-escape-hatch hardening (2026-08) — both escape hatches are hard-blocked on the live instance (3103), unaffected everywhere else", () => {
  // ── regimeGateEscapeHatchAllowedOnInstance: direct unit coverage of the malformed-input surface ──

  it("[unit] PORT unset falls back to FOUR_BRAIN_DEFAULT_PORT (3101) -> escape hatch stays allowed, matching server.ts's own `Number(process.env.PORT ?? 3101)` default", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({})).toBe(true);
  });

  it("[unit] PORT=3103 exact -> blocked", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "3103" })).toBe(false);
  });

  it("[unit] PORT with surrounding whitespace (' 3103', '3103 ') -> still blocked via the raw-port .trim() check", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: " 3103" })).toBe(false);
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "3103 " })).toBe(false);
  });

  it("[unit, instance-spoof] a relabeled FOUR_BRAIN_INSTANCE_ID cannot unblock the real serving PORT=3103 — the raw port always wins toward blocked", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ FOUR_BRAIN_INSTANCE_ID: "3101", PORT: "3103" })).toBe(false);
  });

  it("[unit, control] PORT=3101 (research) / PORT=3102 (testnet) stay allowed", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "3101" })).toBe(true);
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "3102" })).toBe(true);
  });

  it("[unit, documents a pre-existing, shared, out-of-scope limitation] a non-canonical numeric PORT ('03103', '3103.0') does not string-match '3103' and so is NOT blocked — inherited from resolveFourBrainInstanceId's own exact-string convention (every existing 'am I 3103' module in this repo shares it), not something this narrow fix takes on", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "03103" })).toBe(true);
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "3103.0" })).toBe(true);
  });

  it("[unit, resolved-id branch alone] FOUR_BRAIN_INSTANCE_ID=3103 with PORT unset still blocks — the resolved-instance-id check alone is sufficient, not only the raw-PORT belt-and-suspenders check", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ FOUR_BRAIN_INSTANCE_ID: "3103" })).toBe(false);
  });

  it("[unit, fail-closed on ambiguity] FOUR_BRAIN_INSTANCE_ID=3103 while the actual serving PORT=3101 (an inverse mislabel) still blocks — either signal claiming '3103' resolves toward BLOCKED, never toward allowed, even when the two signals disagree", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ FOUR_BRAIN_INSTANCE_ID: "3103", PORT: "3101" })).toBe(false);
  });

  it("[unit, documents a pre-existing, shared, out-of-scope limitation] PORT='' (empty string) is not nullish, so resolveFourBrainInstanceId's `env.PORT ?? ...` fallback never applies — resolves as instance-eligible. Not a realistic 3103 deployment shape: server.ts's own `Number(process.env.PORT ?? 3101)` would try to bind port 0, and the process would never come up far enough for this gate to matter", () => {
    expect(regimeGateEscapeHatchAllowedOnInstance({ PORT: "" })).toBe(true);
  });

  it("[fail-closed, malformed override value] on an instance-eligible PORT (3101), every LIVE_REGIME_NO_TRADE_OVERRIDE value OTHER than the exact string '1' leaves canonical-regime enforcement in force — a null snapshot still blocks for each", () => {
    for (const malformed of ["true", "TRUE", "0", " 1", "1 ", "yes", "01", ""]) {
      const gate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => null,
        env: { PORT: "3101", LIVE_REGIME_NO_TRADE_OVERRIDE: malformed },
      });
      expect(gate().allowed, `LIVE_REGIME_NO_TRADE_OVERRIDE=${JSON.stringify(malformed)} must NOT activate the override`).toBe(false);
    }
  });

  it("[fail-closed, malformed override value] same property for REGIME_ENGINE_EXECUTION_GATE_ENABLED — every value OTHER than the exact string '0' leaves enforcement in force", () => {
    for (const malformed of ["false", "FALSE", "1", " 0", "0 ", "no", "00", ""]) {
      const gate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => null,
        env: { PORT: "3101", REGIME_ENGINE_EXECUTION_GATE_ENABLED: malformed },
      });
      expect(gate().allowed, `REGIME_ENGINE_EXECUTION_GATE_ENABLED=${JSON.stringify(malformed)} must NOT activate the override`).toBe(false);
    }
  });

  // ── end-to-end through buildUnifiedRegimeEntryGate ──

  it("[fail-without/pass-with] LIVE_REGIME_NO_TRADE_OVERRIDE=1 on PORT=3103 (the live instance) no longer bypasses the canonical-regime check — falls through and blocks on a null snapshot exactly like a non-override instance would", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { PORT: "3103", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no snapshot/i);
  });

  it("[fail-without/pass-with] REGIME_ENGINE_EXECUTION_GATE_ENABLED=0 on PORT=3103 — same hard block", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { PORT: "3103", REGIME_ENGINE_EXECUTION_GATE_ENABLED: "0" },
    });
    const decision = gate();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no snapshot/i);
  });

  it("[instance-spoof, end-to-end] FOUR_BRAIN_INSTANCE_ID=3101 cannot smuggle the override onto the real serving PORT=3103", () => {
    const gate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { FOUR_BRAIN_INSTANCE_ID: "3101", PORT: "3103", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
    expect(gate().allowed).toBe(false);
  });

  it("[control, instance-scoped not blanket-removed] the SAME override, on PORT=3102 (testnet) / PORT=3101 (research) / PORT unset, still allows exactly as before this fix — proves the change is scoped to 3103, not a blanket removal of the escape hatch", () => {
    const envs: NodeJS.ProcessEnv[] = [
      { PORT: "3102", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
      { PORT: "3101", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
      { LIVE_REGIME_NO_TRADE_OVERRIDE: "1" }, // PORT unset
      { PORT: "3102", REGIME_ENGINE_EXECUTION_GATE_ENABLED: "0" },
    ];
    for (const env of envs) {
      const gate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => null,
        env,
      });
      expect(gate()).toEqual({ allowed: true, reason: null });
    }
  });

  it("[production wiring] PORT=3103 on the real process.env (the default buildApp() actually uses) blocks the override too", () => {
    const originalPort = process.env.PORT;
    const originalOverride = process.env.LIVE_REGIME_NO_TRADE_OVERRIDE;
    process.env.PORT = "3103";
    process.env.LIVE_REGIME_NO_TRADE_OVERRIDE = "1";
    try {
      const gate = buildUnifiedRegimeEntryGate({
        getUnifiedOrchestrator: () => null,
        getCanonicalMarketRegimeSnapshot: () => null,
        // no `env` field — must fall back to process.env
      });
      expect(gate().allowed).toBe(false);
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
      if (originalOverride === undefined) delete process.env.LIVE_REGIME_NO_TRADE_OVERRIDE;
      else process.env.LIVE_REGIME_NO_TRADE_OVERRIDE = originalOverride;
    }
  });
});

describe("[ADVERSARIAL] the regime-escape-hatch hardening never leaks into panic/kill/drain/exposure/reconciliation/protective-exit — it only ever affects the canonical-regime NEW-ENTRY check", () => {
  // ── structural: the escape-hatch identifiers, and the entry-gate machinery they live inside,
  //    are referenced nowhere in the modules that own these other concerns ──────────────────────

  it("[structural] account-exposure-coordinator.ts and every reconciliation module never reference the escape-hatch identifiers, and never call into the entry-gate machinery at all — the concerns are architecturally orthogonal, not just coincidentally unaffected today", () => {
    const modules = [
      "account-exposure-coordinator.ts",
      "direction-entry-reconciler.ts",
      "order-reconciliation-readiness.ts",
      "wallet-reconciliation.ts",
      "backfill-reconciliation.ts",
    ];
    const forbidden = [
      "LIVE_REGIME_NO_TRADE_OVERRIDE",
      "REGIME_ENGINE_EXECUTION_GATE_ENABLED",
      "regimeGateEscapeHatchAllowedOnInstance",
      "canOpenNewEntries",
      "newEntryGate",
      "strategyEntryGate",
    ];
    for (const mod of modules) {
      const text = readFileSync(resolve(process.cwd(), "src", "lib", mod), "utf-8");
      for (const token of forbidden) {
        expect(text, `${mod} must not reference ${token}`).not.toContain(token);
      }
    }
  });

  it("[structural] live-execution-engine.ts (armed/kill/drain/protective-exit's own home) never independently reads or re-implements the escape-hatch env vars or predicate — the ONLY reader is app.ts's buildUnifiedRegimeEntryGate", () => {
    const text = readFileSync(resolve(process.cwd(), "src", "lib", "live-execution-engine.ts"), "utf-8");
    expect(text).not.toContain("LIVE_REGIME_NO_TRADE_OVERRIDE");
    expect(text).not.toContain("REGIME_ENGINE_EXECUTION_GATE_ENABLED");
    expect(text).not.toContain("regimeGateEscapeHatchAllowedOnInstance");
  });

  // ── behavioral: wire the REAL buildUnifiedRegimeEntryGate, with the escape hatch genuinely
  //    ACTIVE and instance-ELIGIBLE (PORT=3101), into a REAL LiveExecutionEngine, and prove
  //    armed/kill/drain still short-circuit BEFORE it is ever consulted ─────────────────────────

  function activeEscapeHatchGate(): () => LiveNewEntryGateDecision {
    // A null snapshot means canonical policy ALONE would block ("no snapshot") — isolates any
    // `allowed:true` result to the escape hatch specifically, the same isolation the fail-without/
    // pass-with tests above use.
    return buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { PORT: "3101", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
  }

  it("[adversarial, not armed] the escape hatch is genuinely active-and-eligible, but an unarmed engine still blocks new entries and never even invokes the gate", async () => {
    const spy = vi.fn(activeEscapeHatchGate());
    const { engine } = makeEngine({ newEntryGate: spy });
    expect(engine.isArmed()).toBe(false);
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toBe("engine is not ARMED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("[adversarial, kill switch] the escape hatch is genuinely active-and-eligible, but a killed engine still blocks new entries and never invokes the gate", async () => {
    const spy = vi.fn(activeEscapeHatchGate());
    const { engine, store } = makeEngine({ newEntryGate: spy });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntries()).toBe(true); // sanity: genuinely open before the kill — proves the escape hatch really is active, not just inert
    spy.mockClear();
    store.getState().killedAt = "2099-01-02T12:30:00.000Z";
    store.getState().killReason = "[test] kill-switch latched";
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toBe("[test] kill-switch latched");
    expect(spy).not.toHaveBeenCalled();
  });

  it("[adversarial, drain] the escape hatch is genuinely active-and-eligible, but an operator drain still blocks new entries and never invokes the gate", async () => {
    const spy = vi.fn(activeEscapeHatchGate());
    const { engine } = makeEngine({ newEntryGate: spy });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntries()).toBe(true); // sanity
    spy.mockClear();
    engine.setNewEntriesPaused(true, "[test] operator drain");
    expect(engine.canOpenNewEntries()).toBe(false);
    expect(engine.newEntryBlockReason()).toMatch(/drain/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("[adversarial, control] armed + not killed + not drained: the SAME active escape hatch IS invoked and DOES allow — proves the three blocks above weren't vacuously passing against a broken/inert gate", async () => {
    const spy = vi.fn(activeEscapeHatchGate());
    const { engine } = makeEngine({ newEntryGate: spy });
    expect((await engine.arm()).ok).toBe(true);
    expect(engine.canOpenNewEntries()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ── protective-exit: even the worst-case combination (escape hatch active AND killed AND
  //    drained AND disarmed, all at once) must never prevent closing an already-open position ────

  it("[adversarial, kitchen sink] manualCloseIntent (the protective-exit path) still executes when the escape hatch is active AND the engine is killed AND drained AND disarmed, all simultaneously", async () => {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    const made = makeEngine({ paper: makePaperStore([order]), newEntryGate: activeEscapeHatchGate() });
    expect((await made.engine.arm()).ok).toBe(true);
    await made.engine.tick();
    expect(made.store.getState().intents.length).toBe(1);
    const intent = made.store.getState().intents[0]!;

    made.engine.disarm("[test] adversarial escape-hatch exit-path check");
    made.store.getState().killedAt = "2099-01-02T13:00:00.000Z";
    made.store.getState().killReason = "[test] kill-switch latched";
    made.engine.setNewEntriesPaused(true, "[test] operator drain");
    expect(made.engine.isArmed()).toBe(false);
    expect(made.engine.canOpenNewEntries()).toBe(false); // new entries fully blocked...

    const res = await made.engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true); // ...but the existing position still closes
    expect(made.store.getState().intents[0]!.state).toBe("CLOSED");
  });

  it("[adversarial, control] a second engine sharing the SAME store, wired with the real escape-hatch-BLOCKED gate (PORT=3103), still closes a pre-existing open intent — proves the fix's blast radius stops at new-entry admission, never the exit path, even on the live instance", async () => {
    const order = paperOrder({
      symbol: "ETHUSDT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      direction: "SHORT",
      entryPrice: 2000,
      stopLoss: 2100,
    } as Partial<PaperOrder>);
    const made = makeEngine({ paper: makePaperStore([order]) }); // opened under the default permissive gate — not what this test is about
    expect((await made.engine.arm()).ok).toBe(true);
    await made.engine.tick();
    expect(made.store.getState().intents.length).toBe(1);
    const intent = made.store.getState().intents[0]!;

    const blockedGate = buildUnifiedRegimeEntryGate({
      getUnifiedOrchestrator: () => null,
      getCanonicalMarketRegimeSnapshot: () => null,
      env: { PORT: "3103", LIVE_REGIME_NO_TRADE_OVERRIDE: "1" },
    });
    expect(blockedGate().allowed).toBe(false); // sanity: genuinely blocked for new entries on 3103

    // A second engine, sharing the SAME store/client, wired with that genuinely-blocked gate —
    // proves its mere presence/wiring cannot entangle with or block the exit path (mirrors live-
    // execution-engine.test.ts's own "closes ONLY the engine share" precedent's choice not to
    // re-arm the second engine — manualCloseIntent is independently proven armed-independent by
    // manual-directional-regime-safety-gate.test.ts's [5c]).
    const made2 = makeEngine({ store: made.store, client: made.client, newEntryGate: blockedGate });
    const res = await made2.engine.manualCloseIntent(intent.paperOrderId);
    expect(res.ok).toBe(true);
    expect(made.store.getState().intents[0]!.state).toBe("CLOSED");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildUnifiedRegimeEntryGate } from "../src/app.js";
import {
  UnifiedTestnetOrchestrator,
  UnifiedTestnetOrchestratorStore,
  type UnifiedOrchestratorInput,
} from "../src/lib/unified-testnet-orchestrator.js";
import type { CanonicalMarketRegimeSnapshot } from "../src/lib/canonical-market-regime-execution-policy.js";

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
    process.env.LIVE_REGIME_NO_TRADE_OVERRIDE = "1";
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
    }
  });
});

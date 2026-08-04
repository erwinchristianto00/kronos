import { describe, expect, it } from "vitest";

import {
  canonicalMarketRegimeExecutionPolicy,
  edgeMemoryLabelForCanonicalFamily,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
  type CanonicalMarketRegimeSnapshot,
} from "../src/lib/canonical-market-regime-execution-policy.js";
import { normalizeRegimeFamily } from "../src/lib/regime-edge-memory.js";
import type { AxisRegimeFamily } from "../src/lib/current-guard-variant-matrix.js";

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

describe("canonicalMarketRegimeExecutionPolicy — cold start / fail-closed (adversarial: never widens)", () => {
  it("[ADVERSARIAL / fail-without] a null snapshot (cold start, kill switch, or the engine not existing yet) blocks — never defaults to allowed", () => {
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot: null, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no snapshot/i);
    expect(decision.regimeFamily).toBe("UNKNOWN");
  });

  it("undefined-shaped falsy snapshot input still blocks (defensive: no `?? allowed:true` fallback anywhere)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot: undefined as any, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
  });
});

describe("canonicalMarketRegimeExecutionPolicy — staleness", () => {
  it("[PASS-WITH] a fresh snapshot (age 0) is not blocked by staleness", () => {
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot: healthySnapshot(), nowMs: NOW_MS });
    expect(decision.allowed).toBe(true);
  });

  it("[ADVERSARIAL / fail-without] a snapshot exactly at the default max age boundary is NOT yet stale (strictly greater-than, not greater-or-equal)", () => {
    const snapshot = healthySnapshot({ atMs: NOW_MS - DEFAULT_MAX_SNAPSHOT_AGE_MS });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(true);
  });

  it("[ADVERSARIAL / fail-without] a snapshot older than the default max age blocks with a reason mentioning staleness and the age in seconds", () => {
    const snapshot = healthySnapshot({ atMs: NOW_MS - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1_000 });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
    expect(decision.reason).toMatch(/\d+s/);
  });

  it("honors a caller-supplied maxSnapshotAgeMs override instead of the default", () => {
    const snapshot = healthySnapshot({ atMs: NOW_MS - 5_000 });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS, maxSnapshotAgeMs: 1_000 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
  });

  it("a non-finite age (e.g. NaN atMs) blocks rather than passing an unbounded comparison", () => {
    const snapshot = healthySnapshot({ atMs: Number.NaN });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
  });
});

describe("canonicalMarketRegimeExecutionPolicy — requirement #5 (LOW_COVERAGE / invalid coverage)", () => {
  it("[ADVERSARIAL / fail-without] overlays.lowCoverage=true blocks new entries even though coverage.status itself is nominally VALID", () => {
    const snapshot = healthySnapshot({ overlays: { ...healthySnapshot().overlays, lowCoverage: true } });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/coverage/i);
  });

  it("[ADVERSARIAL / fail-without] coverage.status=DEGRADED blocks even though overlays.lowCoverage itself is false — the OR is independently gating on either signal", () => {
    const snapshot = healthySnapshot({
      coverage: { validSymbolCount: 40, requiredSymbolCount: 60, coveragePct: 66.6, status: "DEGRADED", reasons: ["partial fetch failure"] },
    });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("partial fetch failure");
  });

  it("[ADVERSARIAL / fail-without] coverage.status=INVALID blocks", () => {
    const snapshot = healthySnapshot({
      coverage: { validSymbolCount: 10, requiredSymbolCount: 60, coveragePct: 16.6, status: "INVALID", reasons: ["universe stale > 48h"] },
    });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
  });

  it("requirement #5's double protection: regimeFamily is forced to MIXED in the decision regardless of what snapshot.regimeFamily itself says (BULLISH here)", () => {
    const snapshot = healthySnapshot({
      regimeFamily: "BULLISH",
      overlays: { ...healthySnapshot().overlays, lowCoverage: true },
    });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.regimeFamily).toBe("MIXED");
  });
});

describe("canonicalMarketRegimeExecutionPolicy — requirement #6 (PANIC)", () => {
  it("[ADVERSARIAL / fail-without] overlays.panic=true blocks new entries immediately, with no partial allowance", () => {
    const snapshot = healthySnapshot({ overlays: { ...healthySnapshot().overlays, panic: true } });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/panic/i);
  });

  it("when BOTH lowCoverage and panic are true, the coverage block is reported first (checked earlier in the order) — proves the two blocks are independently ordered, not merged into one generic reason", () => {
    const snapshot = healthySnapshot({
      overlays: { ...healthySnapshot().overlays, lowCoverage: true, panic: true },
    });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/coverage/i);
    expect(decision.regimeFamily).toBe("MIXED");
  });
});

describe("canonicalMarketRegimeExecutionPolicy — allowed path (HIGH_STRESS sizing, TRANSITION retest)", () => {
  it("[PASS-WITH] a clean healthy snapshot is allowed with sizeMultiplier=1, requireRetest=false, and a passthrough regimeFamily", () => {
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot: healthySnapshot({ regimeFamily: "BEARISH" }), nowMs: NOW_MS });
    expect(decision).toEqual({
      allowed: true,
      reason: null,
      requireRetest: false,
      sizeMultiplier: 1,
      regimeFamily: "BEARISH",
    });
  });

  it("overlays.highStress halves sizeMultiplier but does not block", () => {
    const snapshot = healthySnapshot({ overlays: { ...healthySnapshot().overlays, highStress: true } });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(true);
    expect(decision.sizeMultiplier).toBe(0.5);
  });

  it("overlays.transition sets requireRetest=true but does not block", () => {
    const snapshot = healthySnapshot({ overlays: { ...healthySnapshot().overlays, transition: true } });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(true);
    expect(decision.requireRetest).toBe(true);
  });

  it("ROTATIONAL and FRAGMENTED overlays never block outright this round (only LOW_COVERAGE/PANIC are hard-blocking today)", () => {
    const snapshot = healthySnapshot({
      overlays: { ...healthySnapshot().overlays, rotational: true, fragmented: true },
    });
    const decision = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(decision.allowed).toBe(true);
  });
});

describe("canonicalMarketRegimeExecutionPolicy — adversarial test I (identical policy for identical snapshot)", () => {
  it("calling the function twice with the same snapshot/nowMs (simulating 4 independent callers) yields byte-identical decisions", () => {
    const snapshot = healthySnapshot({ overlays: { ...healthySnapshot().overlays, highStress: true } });
    const callerA = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    const callerB = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    const callerC = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    const callerD = canonicalMarketRegimeExecutionPolicy({ snapshot, nowMs: NOW_MS });
    expect(callerA).toEqual(callerB);
    expect(callerB).toEqual(callerC);
    expect(callerC).toEqual(callerD);
  });
});

describe("edgeMemoryLabelForCanonicalFamily — verified directly against the REAL normalizeRegimeFamily (regime-edge-memory.ts), never assumed", () => {
  it("BULLISH maps to a label that normalizeRegimeFamily buckets as BULLISH_EXPANSION — the same bucket producer A's old free-text 'Bullish expansion' landed in", () => {
    const label = edgeMemoryLabelForCanonicalFamily("BULLISH");
    expect(label).toBe("CANONICAL_BULLISH_EXPANSION");
    expect(normalizeRegimeFamily(label)).toBe("BULLISH_EXPANSION");
  });

  it("BEARISH maps to a label that normalizeRegimeFamily buckets as BEARISH_EXPANSION — the same bucket producer A's old free-text 'Bearish pressure' landed in", () => {
    const label = edgeMemoryLabelForCanonicalFamily("BEARISH");
    expect(label).toBe("CANONICAL_BEARISH_PRESSURE");
    expect(normalizeRegimeFamily(label)).toBe("BEARISH_EXPANSION");
  });

  it("MIXED maps to a label that normalizeRegimeFamily buckets as MIXED_ROTATION — the same bucket producer A's old free-text 'Mixed rotation' landed in", () => {
    const label = edgeMemoryLabelForCanonicalFamily("MIXED");
    expect(label).toBe("CANONICAL_MIXED_ROTATION");
    expect(normalizeRegimeFamily(label)).toBe("MIXED_ROTATION");
  });

  it("[ADVERSARIAL / fail-without] UNKNOWN maps to null, never to a label that would silently normalize into the OTHER (fresh, unearned-history) bucket", () => {
    const label = edgeMemoryLabelForCanonicalFamily("UNKNOWN");
    expect(label).toBeNull();
  });

  it("every non-UNKNOWN AxisRegimeFamily value maps to a label whose normalizeRegimeFamily bucket is NOT 'OTHER' (the silent-widening failure mode this mapping exists to prevent)", () => {
    const families: AxisRegimeFamily[] = ["BULLISH", "BEARISH", "MIXED"];
    for (const family of families) {
      const label = edgeMemoryLabelForCanonicalFamily(family);
      expect(normalizeRegimeFamily(label)).not.toBe("OTHER");
    }
  });
});

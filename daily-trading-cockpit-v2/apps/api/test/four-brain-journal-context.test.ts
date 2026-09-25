/**
 * Regression tests for the "BUG 2" fix: the app.ts `runFourBrainShadowCycle({...})` call site used to
 * supply NO `journalContext` at all, so every EXECUTIVE_DECISION record ever appended to
 * data/four-brain-decision-journal.jsonl carried instanceId/rawFeatures/normalizedFeatures/
 * sourceStatuses/missingReasons/incumbent as hard `null` (the audit trail this layer exists to build was
 * silently incomplete). `buildFourBrainJournalContext` (exported from app.ts, pure, zero I/O) turns the
 * exact per-tick gather-deps snapshot into that provenance; the app.ts call site now wires it in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFourBrainShadowTick, _resetFourBrainSingleFlightForTests } from "../src/lib/four-brain-shadow-tick.js";
import { assembleFourBrainTick } from "../src/lib/four-brain-live-gather.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";
import { buildFourBrainJournalContext } from "../src/app.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const edge = {
  lookup: (_r: string | null, d: "LONG" | "SHORT") => (d === "LONG" ? { avgNetR: 0.1, n: 40 } : { avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

function fakeDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "3101",
    nowMs: NOW,
    axisScore: 0.4, axisAtMs: NOW - 2 * MIN, axisSlopePerHour: 0.01,
    btcAtrPercentile: null, atrAtMs: null,
    advancersPct: 0.55, breadthAtMs: NOW - 2 * MIN,
    sentiment: null, sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: edge,
    controllerBias: "LONG", convictionScore: 0.6, allowsLong: true, allowsShort: false,
    bestLaneReportForDirection: () => null,
    crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
    openSignals: [
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "sig-1", openedAtMs: NOW - 3 * MIN, entryPrice: 100, stopPrice: 97 },
    ],
    maxSignalAgeMs: 50 * MIN,
    crowdingStateForSymbol: () => null,
    openPositions: [],
    markPriceForSymbol: () => ({ price: null, atMs: null }),
    cortexDecisionId: "cortex-x", cortexFinalPctForLane: () => 40, laneEligibleIncumbent: () => true,
    killLatched: false, killReason: null,
    ...o,
  };
}

function gatherFrom(deps: FourBrainBindingDeps) {
  return () => assembleFourBrainTick(buildFourBrainGatherInput(deps));
}

beforeEach(() => {
  _resetFourBrainSingleFlightForTests();
});

describe("buildFourBrainJournalContext — pure builder", () => {
  it("reports instanceId/rawFeatures/normalizedFeatures/sourceStatuses/missingReasons/incumbent from REAL per-tick data, never fabricated", () => {
    const deps = fakeDeps();
    const ctx = buildFourBrainJournalContext(deps, [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 55 }]);

    expect(ctx.instanceId).toBe("3101");

    const raw = ctx.rawFeatures as Record<string, unknown>;
    expect(raw.axisScore).toBe(0.4);
    expect(raw.regimeRaw).toBe("Bullish expansion");

    const norm = ctx.normalizedFeatures as Record<string, unknown>;
    expect(norm.allowsLong).toBe(true);
    expect(norm.allowsShort).toBe(false);

    const statuses = ctx.sourceStatuses as Record<string, string>;
    expect(statuses.axisScore).toBe("FRESH");
    expect(statuses.regimeRaw).toBe("FRESH");
    // Known-unavailable sources stay honestly MISSING — never fabricated as 0/FRESH.
    expect(statuses.sentiment).toBe("MISSING");
    expect(statuses.btcAtrPercentile).toBe("MISSING");
    expect(statuses.crowdAlignLong).toBe("MISSING");
    expect(statuses.kronosAgree).toBe("MISSING");
    expect(statuses.chronos2Agree).toBe("MISSING");
    expect(statuses.timesfmAgree).toBe("MISSING");

    const reasons = ctx.missingReasons as Record<string, string>;
    expect(reasons.sentiment).toBeTruthy();
    expect(reasons.btcAtrPercentile).toBeTruthy();
    expect(reasons.axisScore).toBeUndefined(); // FRESH ⇒ no missing-reason entry

    const incumbent = ctx.incumbent as Record<string, unknown>;
    expect(incumbent.laneAllocations).toEqual([{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 55 }]);
    expect(incumbent.controllerBias).toBe("LONG");
  });

  it("MISSING flips to FRESH when the underlying binding value is present (never a static/fabricated map)", () => {
    const ctx = buildFourBrainJournalContext(fakeDeps({ sentiment: 0.3, btcAtrPercentile: 40, crowdAlignLong: 0.1, kronosAgree: -0.2, chronos2Agree: 0.4, timesfmAgree: -0.5 }), []);
    const statuses = ctx.sourceStatuses as Record<string, string>;
    expect(statuses.sentiment).toBe("FRESH");
    expect(statuses.btcAtrPercentile).toBe("FRESH");
    expect(statuses.crowdAlignLong).toBe("FRESH");
    expect(statuses.kronosAgree).toBe("FRESH");
    expect(statuses.chronos2Agree).toBe("FRESH");
    expect(statuses.timesfmAgree).toBe("FRESH");
    const reasons = ctx.missingReasons as Record<string, string>;
    expect(reasons.sentiment).toBeUndefined();
  });
});

describe("Four-Brain shadow-tick journal — Bug 2 fail-without/pass-with", () => {
  it("FAIL-WITHOUT: an unsupplied journalContext (the ORIGINAL app.ts call site) journals hard-null provenance", () => {
    const journaled: Record<string, unknown>[] = [];
    const res = runFourBrainShadowTick({
      mode: "shadow",
      nowMs: NOW,
      gather: gatherFrom(fakeDeps()),
      journalAppend: (r) => journaled.push(r),
      // journalContext deliberately omitted — reproduces the pre-fix app.ts call site exactly.
      tickId: "t-no-ctx",
    });
    expect(res.executiveDecisions.length).toBeGreaterThan(0);
    const execRecord = journaled.find((r) => r.kind === "EXECUTIVE_DECISION")!;
    expect(execRecord).toBeTruthy();
    expect(execRecord.instanceId).toBeNull();
    expect(execRecord.rawFeatures).toBeNull();
    expect(execRecord.normalizedFeatures).toBeNull();
    expect(execRecord.sourceStatuses).toBeNull();
    expect(execRecord.missingReasons).toBeNull();
    expect(execRecord.incumbent).toBeNull();
  });

  it("PASS-WITH: wiring buildFourBrainJournalContext as journalContext (the fix) populates real provenance on every journaled decision", () => {
    const journaled: Record<string, unknown>[] = [];
    const deps = fakeDeps();
    const res = runFourBrainShadowTick({
      mode: "shadow",
      nowMs: NOW,
      gather: gatherFrom(deps),
      journalAppend: (r) => journaled.push(r),
      journalContext: () => buildFourBrainJournalContext(deps, [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 55 }]),
      tickId: "t-with-ctx",
    });
    expect(res.executiveDecisions.length).toBeGreaterThan(0);
    const execRecord = journaled.find((r) => r.kind === "EXECUTIVE_DECISION")!;
    expect(execRecord).toBeTruthy();
    expect(execRecord.instanceId).toBe("3101");
    expect(execRecord.rawFeatures).not.toBeNull();
    expect((execRecord.rawFeatures as Record<string, unknown>).axisScore).toBe(0.4);
    expect(execRecord.normalizedFeatures).not.toBeNull();
    expect(execRecord.sourceStatuses).not.toBeNull();
    expect((execRecord.sourceStatuses as Record<string, string>).sentiment).toBe("MISSING");
    expect(execRecord.missingReasons).not.toBeNull();
    expect((execRecord.missingReasons as Record<string, string>).sentiment).toBeTruthy();
    expect(execRecord.incumbent).not.toBeNull();
    expect((execRecord.incumbent as Record<string, unknown>).laneAllocations).toEqual([
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 55 },
    ]);
    // Exact-fill reinforcement is journaled with the decision so a later close can be audited against
    // the recommendation that actually saw the cohort, rather than a rebuilt/live value.
    expect(execRecord.executionReinforcement).toMatchObject({ source: "TIER1_REALIZED" });
  });
});

describe("app.ts real call site actually wires journalContext (source-level guard)", () => {
  it("the runFourBrainShadowCycle({...}) call in app.ts supplies a journalContext key", () => {
    const appTsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts");
    const text = readFileSync(appTsPath, "utf-8");
    const callIdx = text.indexOf("runFourBrainShadowCycle({");
    expect(callIdx, "runFourBrainShadowCycle call site not found in app.ts").toBeGreaterThanOrEqual(0);
    // 2026-07-27: this scanned a fixed 1500-char window on the theory that "the object literal
    // itself is short". It stopped being short — the order-flow sensor was added to the same
    // literal and pushed `journalContext:` out to char 2644, so the guard went red while the
    // wiring it guards was present and correct the whole time. A brittle guard that cries wolf is
    // worse than no guard: it teaches people that red means "probably the test again".
    //
    // Bound the window to the literal's OWN extent by matching braces, so it stays exact no matter
    // how many fields the call grows. String/comment contents are not stripped — a stray brace
    // inside either would skew the match — but every field here is code, and the assertions below
    // would fail loudly rather than silently pass if it ever did.
    const openIdx = text.indexOf("{", callIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    expect(closeIdx, "could not brace-match the runFourBrainShadowCycle({...}) literal").toBeGreaterThan(openIdx);
    const windowText = text.slice(openIdx, closeIdx + 1);
    expect(windowText).toContain("journalContext:");
    expect(windowText).toContain("buildFourBrainJournalContext");
  });
});

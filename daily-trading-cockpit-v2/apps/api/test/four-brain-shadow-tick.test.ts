import { describe, it, expect, beforeEach, vi } from "vitest";
import { runFourBrainShadowTick, _resetFourBrainSingleFlightForTests } from "../src/lib/four-brain-shadow-tick.js";
import { assembleFourBrainTick } from "../src/lib/four-brain-live-gather.js";
import { buildFourBrainGatherInput, resolveFourBrainInstanceId, fourBrainInstanceAllowed, fourBrainShadowActive, unrealizedRFromPosition, type FourBrainBindingDeps, type EntryMicrostructure } from "../src/lib/four-brain-live-gather-bindings.js";
import { decideEntry } from "../src/lib/entry-brain.js";

// 2026-07-22 regression harness: runBrainSafely isolation needs ONE brain call to genuinely throw, which
// none of the pure brains do on any malformed-but-typed input (by design — they degrade gracefully). A
// module mock is the clean way to prove isolation without fighting that design. Default OFF (real
// decideEntry runs for every other test in this file); a single test flips it on, then resets in `finally`.
let forceEntryBrainThrow = false;
vi.mock("../src/lib/entry-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entry-brain.js")>();
  return {
    ...actual,
    decideEntry: (input: Parameters<typeof actual.decideEntry>[0]) => {
      if (forceEntryBrainThrow) throw new Error("[test] forced decideEntry crash");
      return actual.decideEntry(input);
    },
  };
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// A fake edge memory: LONG has proven positive edge; SHORT none; no veto.
const fakeEdge = {
  lookup: (_r: string | null, d: "LONG" | "SHORT") => (d === "LONG" ? { avgNetR: 0.1, n: 120 } : { avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

function fakeDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "3102",
    nowMs: NOW,
    axisScore: 0.5, axisAtMs: NOW - 2 * MIN, axisSlopePerHour: 0.02,
    btcAtrPercentile: 45, atrAtMs: NOW - 10 * MIN,
    advancersPct: 0.65, breadthAtMs: NOW - 2 * MIN,
    sentiment: null, sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: fakeEdge,
    controllerBias: "LONG", convictionScore: 0.7, allowsLong: true, allowsShort: true,
    bestLaneReportForDirection: (d) => (d === "LONG" ? { netAvgR: 0.08, resolvedCount: 60 } : null),
    crowdAlignLong: 0.2, crowdAtMs: NOW - 3 * MIN,
    kronosAgree: null, kronosAtMs: null,
    openSignals: [
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "sig-1", openedAtMs: NOW - 3 * MIN, entryPrice: 100, stopPrice: 97 },
    ],
    maxSignalAgeMs: 50 * MIN,
    crowdingStateForSymbol: () => "NEUTRAL",
    openPositions: [
      { paperOrderId: "pos-1", laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "ETHUSDT", direction: "LONG", entryPrice: 200, stopPrice: 194, mfeR: 1.2, maeR: -0.3, createdAtMs: NOW - 30 * MIN },
    ],
    markPriceForSymbol: () => ({ price: 206, atMs: NOW - 30_000 }),
    cortexDecisionId: "BRAIN_DECISION:x",
    cortexFinalPctForLane: () => 40,
    laneEligibleIncumbent: () => true,
    killLatched: false,
    killReason: null,
    ...o,
  };
}

function gatherFrom(deps: FourBrainBindingDeps) {
  return () => assembleFourBrainTick(buildFourBrainGatherInput(deps));
}

function spyJournal() {
  const records: Record<string, unknown>[] = [];
  return { records, append: (r: Record<string, unknown>) => void records.push(r) };
}

beforeEach(() => _resetFourBrainSingleFlightForTests());

describe("Four-Brain shadow tick — gate + single-flight + fail-open", () => {
  it("mode OFF ⇒ ZERO gather + ZERO journal I/O", () => {
    let gatherCalls = 0;
    const j = spyJournal();
    const r = runFourBrainShadowTick({ mode: "off", nowMs: NOW, gather: () => { gatherCalls += 1; return assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps())); }, journalAppend: j.append, tickId: "t" });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("mode-off");
    expect(gatherCalls).toBe(0);
    expect(j.records).toHaveLength(0);
  });

  it("a gather exception fails OPEN (gather-error), never throws, never journals", () => {
    const j = spyJournal();
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: () => { throw new Error("boom"); }, journalAppend: j.append, tickId: "t" });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("gather-error");
    expect(r.metrics.gatherErrors).toBe(1);
    expect(j.records).toHaveLength(0);
  });

  it("a journal exception does NOT fail the tick (report-only, fail-open)", () => {
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: () => { throw new Error("disk full"); }, tickId: "t" });
    expect(r.ran).toBe(true);
    expect(r.metrics.journalErrors).toBeGreaterThan(0);
  });

  it("single-flight: a re-entrant tick while one is running is SKIPPED (never overlaps)", () => {
    const j = spyJournal();
    let innerResult: string | null = null;
    const reentrantGather = () => {
      // While THIS tick holds the latch, a nested tick must be skipped.
      innerResult = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: j.append, tickId: "inner" }).reason;
      return assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps()));
    };
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: reentrantGather, journalAppend: j.append, tickId: "outer" });
    expect(r.ran).toBe(true);
    expect(innerResult).toBe("single-flight-skip");
  });
});

describe("Four-Brain shadow tick — decisions + journal + determinism", () => {
  it("produces market/direction/entry/exit decisions + journals executive + snapshot records", () => {
    const j = spyJournal();
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: j.append, journalContext: (g) => ({ instanceId: g.instanceId }), tickId: "t" });
    expect(r.ran).toBe(true);
    expect(r.marketState?.family).toBeDefined();
    expect(r.directions.length).toBeGreaterThan(0);
    expect(r.executiveDecisions.length).toBe(2); // 1 entry candidate + 1 exit candidate
    const kinds = j.records.map((x) => x.kind);
    expect(kinds).toContain("EXECUTIVE_DECISION");
    expect(kinds).toContain("MARKET_SNAPSHOT");
    // every record is report-only + carries the instance id (3101/3102 isolation)
    for (const rec of j.records) {
      expect(rec.reportOnly).toBe(true);
      expect(rec.instanceId).toBe("3102");
    }
  });

  it("[REGRESSION 2026-07-22] one candidate's decideEntry throwing does NOT abort the whole tick — the market snapshot + the exit candidate's decision still journal, and it's counted (not silently lost)", () => {
    forceEntryBrainThrow = true;
    try {
      const j = spyJournal();
      const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: j.append, tickId: "t" });
      expect(r.ran).toBe(true); // the tick as a WHOLE still completes — previously this would have been reason:"exception", ran:false
      expect(r.metrics.brainErrors).toBeGreaterThan(0);
      expect(r.executiveDecisions).toHaveLength(1); // only the exit candidate's exec survives; the entry candidate is skipped
      const kinds = j.records.map((x) => x.kind);
      expect(kinds).toContain("MARKET_SNAPSHOT"); // previously would have been lost too (whole-tick abort)
      expect(kinds).toContain("EXECUTIVE_DECISION");
    } finally {
      forceEntryBrainThrow = false;
    }
  });

  it("review fix (HIGH): an emitMetrics that throws does NOT escape the tick (fail-open)", () => {
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: () => {}, emitMetrics: () => { throw new Error("metrics sink down"); }, tickId: "t" });
    expect(r.ran).toBe(true); // metrics throw swallowed
    // and even on the gather-error path (emit inside the early return) it must not throw
    _resetFourBrainSingleFlightForTests();
    const r2 = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: () => { throw new Error("x"); }, journalAppend: () => {}, emitMetrics: () => { throw new Error("also down"); }, tickId: "t2" });
    expect(r2.reason).toBe("gather-error");
  });

  it("review fix (MEDIUM): entry + exit on the same lane+symbol+status get DISTINCT decision IDs (no dropped records)", () => {
    // Kill latched ⇒ both the entry candidate and the exit position for the same lane+symbol resolve to
    // BLOCKED_BY_RISK. They must NOT collide into one journal record.
    const dep = fakeDeps({
      killLatched: true, killReason: "daily loss",
      openSignals: [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "s1", openedAtMs: NOW - MIN, entryPrice: 100, stopPrice: 97 }],
      openPositions: [{ paperOrderId: "p1", laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", entryPrice: 100, stopPrice: 97, mfeR: 0.5, maeR: -0.2, createdAtMs: NOW - 20 * MIN }],
    });
    const j = spyJournal();
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(dep), journalAppend: j.append, tickId: "t" });
    const ids = r.executiveDecisions.map((d) => d.decisionId);
    expect(new Set(ids).size).toBe(2); // distinct — not collapsed to 1
    expect(r.metrics.duplicateDecisionIds).toBe(0);
    expect(j.records.filter((x) => x.kind === "EXECUTIVE_DECISION")).toHaveLength(2);
  });

  it("review fix (MEDIUM): a STALE mark is unusable — no unrealizedR / hardExit from stale data", () => {
    const dep = fakeDeps({ markPriceForSymbol: () => ({ price: 3400, atMs: NOW - 10 * MIN }) }); // 10min old vs 60s position TTL
    const input = buildFourBrainGatherInput(dep);
    const exitRaw = input.exitCandidatesRaw[0]!;
    expect(exitRaw.currentPrice).toBeNull(); // stale mark → unusable
    expect(exitRaw.unrealizedR).toBeNull();
    // hardExit must NOT be true from a stale mark below the stop (kill is off here)
    expect(exitRaw.exec.hardExitTriggered).toBe(false);
  });

  it("review fix (LOW): audit `raw` preserves the AS-READ value for unit-converted sources", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps({ btcAtrPercentile: 80, advancersPct: 0.3 })));
    const vol = g.marketReadings.find((x) => x.sourceId === "btc-atr-percentile")!;
    expect(vol.raw).toBe(80); // as-read percentile, NOT the /100 normalized 0.8
    expect(vol.normalized).toBeCloseTo(0.8, 10);
    const breadth = g.marketReadings.find((x) => x.sourceId === "breadth-advancers")!;
    expect(breadth.raw).toBe(0.3); // as-read, NOT the ×2−1 normalized −0.4
    expect(breadth.normalized).toBeCloseTo(-0.4, 10);
  });

  it("deterministic replay ⇒ identical executive decision IDs", () => {
    _resetFourBrainSingleFlightForTests();
    const a = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: () => {}, tickId: "a" });
    _resetFourBrainSingleFlightForTests();
    const b = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(fakeDeps()), journalAppend: () => {}, tickId: "b" });
    expect(a.executiveDecisions.map((d) => d.decisionId)).toEqual(b.executiveDecisions.map((d) => d.decisionId));
  });
});

describe("Four-Brain gather assembly — identity, freshness, unknown lanes", () => {
  it("rejects duplicate candidate identities and records them", () => {
    const dep = fakeDeps({
      openSignals: [
        { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "dup", openedAtMs: NOW - MIN, entryPrice: 100, stopPrice: 97 },
        { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "dup", openedAtMs: NOW - MIN, entryPrice: 100, stopPrice: 97 },
      ],
    });
    const g = assembleFourBrainTick(buildFourBrainGatherInput(dep));
    expect(g.entryCandidates).toHaveLength(0); // both dropped (unsafe to pick one)
    expect(g.diagnostics.duplicateEntryKeys.length).toBe(1);
  });

  it("surfaces an unknown lane (never silently dropped)", () => {
    const dep = fakeDeps({ openSignals: [{ laneId: "TOTALLY_MADE_UP_LANE", symbol: "BTCUSDT", direction: "LONG", observationId: "s", openedAtMs: NOW - MIN, entryPrice: 100, stopPrice: 97 }] });
    const g = assembleFourBrainTick(buildFourBrainGatherInput(dep));
    expect(g.diagnostics.unknownLanes).toContain("TOTALLY_MADE_UP_LANE");
  });

  it("a STALE signal cannot ENTER_NOW", () => {
    const dep = fakeDeps({ openSignals: [{ laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "old", openedAtMs: NOW - 90 * MIN, entryPrice: 100, stopPrice: 97 }] });
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(dep), journalAppend: () => {}, tickId: "t" });
    const entryExec = r.executiveDecisions.find((d) => d.entry);
    expect(entryExec?.entry?.action).toBe("SKIP");
  });

  it("[FIX 2026-07-24] two DIFFERENT real candidates sharing side+action get DISTINCT entry.decisionId end-to-end — the collision this task fixes (decisionId used to be a pure function of nowMs+side+action only, silently dropping/misattributing the losing candidate's counterfactual outcome)", () => {
    const dep = fakeDeps({
      openSignals: [
        { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "old-1", openedAtMs: NOW - 90 * MIN, entryPrice: 100, stopPrice: 97 },
        { laneId: "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG", symbol: "ETHUSDT", direction: "LONG", observationId: "old-2", openedAtMs: NOW - 90 * MIN, entryPrice: 200, stopPrice: 194 },
      ],
    });
    const g = assembleFourBrainTick(buildFourBrainGatherInput(dep));
    expect(g.entryCandidates).toHaveLength(2); // distinct identities — neither rejected as a duplicate
    const [c1, c2] = g.entryCandidates;
    expect(c1!.input.candidateKey).toBeTruthy();
    expect(c2!.input.candidateKey).toBeTruthy();
    expect(c1!.input.candidateKey).not.toBe(c2!.input.candidateKey); // the gather wired a real, distinct salt
    const d1 = decideEntry(c1!.input);
    const d2 = decideEntry(c2!.input);
    expect(d1.action).toBe("SKIP");
    expect(d2.action).toBe("SKIP"); // BOTH SKIP: same side+action bucket — would have collided pre-fix
    expect(d1.decisionId).not.toBe(d2.decisionId);
  });

  it("MISSING microstructure stays MISSING (never fabricated); a future timestamp is ERROR", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps()));
    const entry = g.entryCandidates[0]!;
    const slip = entry.readings.find((x) => x.sourceId === "expected-slippage-bps")!;
    expect(slip.status).toBe("MISSING");
    expect(slip.normalized).toBeNull();
    expect(slip.missingReason).toBeTruthy();
    // liquidity is UNAVAILABLE → MISSING in the market readings
    const liq = g.marketReadings.find((x) => x.sourceId === "order-book-depth")!;
    expect(liq.status).toBe("MISSING");
  });

  it("invalid position mark (NaN) never yields NaN unrealizedR / exit decision", () => {
    const dep = fakeDeps({ markPriceForSymbol: () => ({ price: Number.NaN, atMs: NOW }) });
    expect(unrealizedRFromPosition("LONG", 200, Number.NaN, 194)).toBeNull();
    const r = runFourBrainShadowTick({ mode: "shadow", nowMs: NOW, gather: gatherFrom(dep), journalAppend: () => {}, tickId: "t" });
    const exitExec = r.executiveDecisions.find((d) => d.exit);
    expect(Number.isFinite(exitExec?.exit?.exitFraction)).toBe(true);
    expect(exitExec?.exit?.suggestedStop === null || Number.isFinite(exitExec?.exit?.suggestedStop)).toBe(true);
  });

  it("full snapshot readings carry raw + normalized + unit + timestamp + status + missing reason", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps()));
    const trend = g.marketReadings.find((x) => x.sourceId === "regime-axis-score")!;
    expect(trend).toMatchObject({ unit: "-1..1", freshnessClass: "regime" });
    expect(trend.observedAtMs).toBe(NOW - 2 * MIN);
    expect(trend.status).toBe("FRESH");
    expect(typeof trend.normalized).toBe("number");
  });
});

describe("Four-Brain incumbent parity", () => {
  it("controller posture does NOT create an extra veto (only edge-memory does) — bearish posture keeps riskBlockedReason null", () => {
    // allowsLong/allowsShort false (controller says stand aside) but edge memory ALLOWS → no incumbent block.
    const input = buildFourBrainGatherInput(fakeDeps({ allowsLong: false, allowsShort: false }));
    expect(input.entryCandidatesRaw[0]!.exec.riskBlockedReason).toBeNull();
  });

  it("edge-memory VETO propagates as the incumbent risk-block reason", () => {
    const vetoEdge = { lookup: () => ({ avgNetR: -0.2, n: 200 }), verdict: () => ({ decision: "VETO_NEGATIVE" }), hasPositiveLane: () => false };
    const input = buildFourBrainGatherInput(fakeDeps({ edgeMemory: vetoEdge, regimeRaw: "Bearish" }));
    expect(input.entryCandidatesRaw[0]!.exec.riskBlockedReason).toContain("VETO");
  });

  it("kill latched ⇒ every candidate's incumbent risk-block reason is set", () => {
    const input = buildFourBrainGatherInput(fakeDeps({ killLatched: true, killReason: "daily loss" }));
    expect(input.entryCandidatesRaw[0]!.exec.riskBlockedReason).toBe("daily loss");
    expect(input.exitCandidatesRaw[0]!.exec.killLatched).toBe(true);
  });

  it("resolveFourBrainInstanceId distinguishes instances via PORT", () => {
    expect(resolveFourBrainInstanceId({ PORT: "3101" } as NodeJS.ProcessEnv)).toBe("3101");
    expect(resolveFourBrainInstanceId({ FOUR_BRAIN_INSTANCE_ID: "live" } as NodeJS.ProcessEnv)).toBe("live");
  });

  // Regression (2026-07-19): a missing PORT env var used to resolve to "unknown" — NOT in
  // FOUR_BRAIN_DEFAULT_INSTANCE_ALLOWLIST — which silently fail-closed every instance-scoped four-brain
  // feature (collection, shadow tick, lane-context journal) on any instance that never explicitly set PORT,
  // exactly like the main/research instance whose PORT was unset for its entire lifetime. It must instead
  // agree with server.ts's own default (`Number(process.env.PORT ?? 3101)`).
  it("resolveFourBrainInstanceId falls back to server.ts's OWN default port (3101), never 'unknown', when PORT is unset", () => {
    expect(resolveFourBrainInstanceId({} as NodeJS.ProcessEnv)).toBe("3101");
    expect(resolveFourBrainInstanceId({} as NodeJS.ProcessEnv)).not.toBe("unknown");
    // and that default is consequential: it lands inside the default instance allowlist, so an instance
    // that never set PORT is no longer silently excluded from every gated four-brain feature.
    expect(fourBrainInstanceAllowed({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("instance allowlist permits 3101/3102 and HARD-BLOCKS live 3103 (even if allowlisted)", () => {
    expect(fourBrainInstanceAllowed({ PORT: "3101" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fourBrainInstanceAllowed({ PORT: "3102" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fourBrainInstanceAllowed({ PORT: "3103" } as NodeJS.ProcessEnv)).toBe(false);
    // a stray env trying to allow 3103 is still hard-blocked
    expect(fourBrainInstanceAllowed({ PORT: "3103", FOUR_BRAIN_INSTANCE_ALLOWLIST: "3101,3102,3103" } as NodeJS.ProcessEnv)).toBe(false);
    // an unknown instance not in the allowlist is excluded
    expect(fourBrainInstanceAllowed({ PORT: "9999" } as NodeJS.ProcessEnv)).toBe(false);
  });

  // Regression (2026-07-23): app.ts used to expose fourBrainMetricsRef/fourBrainRecentDecisionsRef to the
  // /api/shadow/four-brain route unconditionally inside its `if (!isTest)` wiring block — i.e. on EVERY
  // non-test process regardless of FOUR_BRAIN_MODE — so the route's `enabled: health !== null` was really
  // testing "did this process reach that code block", not "is the shadow cycle actually armed here". A
  // mode-off (or non-allowlisted) instance would report enabled:true with an honestly-all-zero but
  // misleadingly-labeled health object, indistinguishable from "shadow mode is on and hasn't ticked yet".
  // fourBrainShadowActive is the single composed gate app.ts now uses for BOTH arming the interval AND
  // exposing the refs, so this proves the exact condition the route's honesty depends on.
  it("fourBrainShadowActive requires BOTH mode==='shadow' AND instance-allowed — off/unallowlisted/live-port must be false", () => {
    expect(fourBrainShadowActive({ FOUR_BRAIN_MODE: "shadow", PORT: "3101" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fourBrainShadowActive({ FOUR_BRAIN_MODE: "shadow", PORT: "3102" } as NodeJS.ProcessEnv)).toBe(true);
    // mode off (the default) ⇒ inactive even on an otherwise-allowed instance
    expect(fourBrainShadowActive({ PORT: "3101" } as NodeJS.ProcessEnv)).toBe(false);
    expect(fourBrainShadowActive({} as NodeJS.ProcessEnv)).toBe(false);
    // mode on but the instance isn't allowlisted
    expect(fourBrainShadowActive({ FOUR_BRAIN_MODE: "shadow", PORT: "9999" } as NodeJS.ProcessEnv)).toBe(false);
    // mode on but this IS the hard-blocked live instance — never active no matter what
    expect(fourBrainShadowActive({ FOUR_BRAIN_MODE: "shadow", PORT: "3103" } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      fourBrainShadowActive({ FOUR_BRAIN_MODE: "shadow", PORT: "3103", FOUR_BRAIN_INSTANCE_ALLOWLIST: "3101,3102,3103" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("Adapter B — microstructure accessor wired through the gather into Entry", () => {
  const freshMicro: EntryMicrostructure = {
    distanceFromVwapAtr: 0.5, candleExtensionAtr: 0.5, breakoutConfirmed: true, volumeConfirmed: true, candleFresh: true, observedAtMs: NOW - MIN,
  };

  it("accessor output populates VWAP-distance/extension FRESH while order-book depth stays MISSING", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps({ entryMicrostructure: () => freshMicro })));
    const input = g.entryCandidates[0]!.input;
    expect(input.candleFresh).toBe(true);
    const d = decideEntry(input);
    expect(d.sourceStatuses.distanceFromVwapAtr).toBe("FRESH");
    expect(d.sourceStatuses.candleExtensionAtr).toBe("FRESH");
    // Order-book depth (spread/slippage) has no source ⇒ stays MISSING even with a candle adapter present.
    expect(d.sourceStatuses.spreadBps).toBe("MISSING");
    expect(d.sourceStatuses.expectedSlippageBps).toBe("MISSING");
  });

  it("accessor reporting candleFresh=false blocks ENTER_NOW through the gather (stale candles)", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps({ entryMicrostructure: () => ({ ...freshMicro, candleFresh: false }) })));
    const d = decideEntry(g.entryCandidates[0]!.input);
    expect(d.action).not.toBe("ENTER_NOW");
  });

  it("no accessor ⇒ micro is MISSING (unchanged fail-open behaviour, never fabricated)", () => {
    const g = assembleFourBrainTick(buildFourBrainGatherInput(fakeDeps())); // fakeDeps has no entryMicrostructure
    const input = g.entryCandidates[0]!.input;
    expect(input.candleFresh ?? null).toBeNull();
    const d = decideEntry(input);
    expect(d.sourceStatuses.distanceFromVwapAtr).toBe("MISSING");
    expect(d.sourceStatuses.spreadBps).toBe("MISSING");
  });
});

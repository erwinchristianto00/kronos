/**
 * 2026-08 remediation, DEFECT 2 — STAGE 3 required concurrency suite (A-G), prefixed
 * [SINGLE-FLIGHT-*].
 *
 * Every test below calls the REAL exported, wrapped production functions:
 *   - Surface A: `resolveVariantMatrixObservations` (current-guard-variant-matrix.ts), whose
 *     exported body is now a thin wrapper around `runExclusiveForStore` + the renamed
 *     `resolveVariantMatrixObservationsInner`.
 *   - Surface B: `admitPaperOpportunities` + `runPaperAdmissionAndResolution`
 *     (paper-execution-router.ts) — both still exported and callable exactly as before; the lock
 *     itself lives at the shadow.ts ROUTE-HANDLER level (wrapping the whole
 *     admit-then-resolve block), so these tests reconstruct that SAME composition directly, using
 *     the SAME real `runExclusiveForStore` utility and the SAME real underlying functions the route
 *     handler calls — never a hand-rolled reimplementation of either.
 *
 * Nothing here reimplements `runExclusiveForStore`'s own join/release logic as a stand-in; it is
 * imported and used directly throughout.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  buildCurrentGuardVariantMatrixReport,
  buildVariantMatrixObservationsForSignal,
  CurrentGuardVariantMatrixStore,
  resolveVariantMatrixObservations,
  type CurrentGuardVariantMatrixObservation,
  type KlineTuple,
  type VariantMatrixBinanceClient,
  type VariantMatrixSignal,
} from "../src/lib/current-guard-variant-matrix.js";
import {
  PaperExecutionRouterStore,
  admitPaperOpportunities,
  runPaperAdmissionAndResolution,
  type PaperKlineTuple,
  type PaperOpportunity,
  type PaperOrder,
  type PaperResolverClient,
} from "../src/lib/paper-execution-router.js";
import { runExclusiveForStore } from "../src/lib/store-mutation-single-flight.js";
import { buildAdaptiveLaneRouterReport } from "../src/lib/adaptive-lane-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";

// ── shared helpers ──────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "single-flight-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Surface A fixtures (current-guard-variant-matrix) ───────────────────────

const RESOLVER_TARGET_VARIANT_ID = "CG_WIDE_STOP_TP_WIDE";

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
    // Relative to real "now" (not a fixed calendar date) so this obs is always young enough to be
    // walked by the resolver's Phase-2 loop (< EXPIRY_MS = 7 days) regardless of when this suite
    // actually runs — a fixed historical date would instead get marked EXPIRED by Phase 1 before the
    // resolver ever reaches the candle-fetch step, which would silently defeat every test below.
    openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    closedAt: null,
    ...overrides,
  };
}

/** Exactly ONE fresh OPEN observation (not the whole per-variant fan-out
 * `buildVariantMatrixObservationsForSignal` produces) — precise control over how many
 * candle-fetches a single resolver pass should perform. */
function makeOneOpenObservation(args: { observationId: string; symbol?: string }): CurrentGuardVariantMatrixObservation {
  const signal = makeSignal({ sourceSignalId: args.observationId, symbol: args.symbol ?? "ETHUSDT" });
  const built = buildVariantMatrixObservationsForSignal(signal).find(
    (o) => o.variantId === RESOLVER_TARGET_VARIANT_ID,
  )!;
  return { ...built, observationId: args.observationId, sourceObservationKey: args.observationId };
}

/** Instrumented fake Binance client: counts real `getKlines` invocations and records each call's
 *  own wall-clock [start,end] window (after an optional artificial delay) so tests can prove
 *  genuine overlap/non-overlap directly, not by inference. Always returns zero candles, so a
 *  fed observation stays OPEN/unresolved — deliberate: it lets the SAME observation be walked
 *  again by a genuinely later, independent pass without needing to fabricate a realistic
 *  win/loss candle path. */
function makeTrackingVariantClient(delayMs: number): {
  client: VariantMatrixBinanceClient;
  calls: () => number;
  windows: () => Array<{ start: number; end: number }>;
} {
  let count = 0;
  const windows: Array<{ start: number; end: number }> = [];
  const client: VariantMatrixBinanceClient = {
    async getKlines(): Promise<KlineTuple[]> {
      count += 1;
      const start = Date.now();
      if (delayMs > 0) await sleep(delayMs);
      windows.push({ start, end: Date.now() });
      return [];
    },
  };
  return { client, calls: () => count, windows: () => windows };
}

// ── Surface B fixtures (paper-execution-router) ─────────────────────────────

function emptyGate() {
  return buildLiveTradingGateReport({});
}

function regimeOf(raw: string | null) {
  return buildRegimeDirectionControllerReport({
    currentRegime: raw,
    adaptiveDirectionBias: null,
    primaryValidationLane: null,
  });
}

function routerOf(regime: string | null) {
  return buildAdaptiveLaneRouterReport({
    generatedAt: new Date().toISOString(),
    regimeReport: regimeOf(regime),
    gateReport: emptyGate(),
  });
}

/** A pre-seeded, already-OPEN paper order for `runPaperAdmissionAndResolution`'s resolution phase
 *  to have genuine async work on (a real getKlines fetch) — this is what creates the in-flight
 *  window a second, uncoordinated caller could interleave with if it were not joined. */
function makeOpenPaperOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  const now = new Date().toISOString();
  return {
    paperOrderId: "sf-seed-order",
    sourceObservationId: "sf-seed-obs",
    sourceSignalId: null,
    dedupeKey: "sf-seed-obs:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    symbol: "ETHUSDT",
    direction: "SHORT",
    regime: "BULLISH_EXPANSION",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 300,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
    ...overrides,
  } as PaperOrder;
}

function makeTrackingPaperClient(delayMs: number): { client: PaperResolverClient; calls: () => number } {
  let count = 0;
  const client: PaperResolverClient = {
    async getKlines(): Promise<PaperKlineTuple[]> {
      count += 1;
      if (delayMs > 0) await sleep(delayMs);
      return [];
    },
  };
  return { client, calls: () => count };
}

let opportunityCounter = 0;
/** Same shape as the proven-admittable fixture in paper-execution-router.test.ts's own [9b]/[9c]
 *  (LONG, "Bullish expansion" regime — a combination already confirmed to admit). */
function makeOpportunity(overrides: Partial<PaperOpportunity> = {}): PaperOpportunity {
  opportunityCounter += 1;
  const openedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const base: PaperOpportunity = {
    sourceCandidateId: `sf-opportunity-${opportunityCounter}`,
    scanBatchId: "sf-scan-batch",
    symbol: "BTCUSDT",
    direction: "LONG",
    regime: "Bullish expansion",
    laneId: "SINGLE_FLIGHT_TEST_LANE",
    variantId: "SINGLE_FLIGHT_TEST_LANE",
    controllerMode: "LONG_ONLY",
    entryPrice: 100,
    stopLoss: 95,
    takeProfitLevels: [108],
    variantExitRule: "scaleout_tp1_trail",
    fillMode: "taker",
    plannedStopDistanceBps: 500,
    oosUnconfirmed: true,
    paperRiskLabel: "EXPERIMENTAL",
    paperOrderMode: "HEADLINE",
    openedAt,
    provenance: null,
    provenanceFieldMissing: [],
  };
  return { ...base, ...overrides };
}

// ═════════════════════════════════════════════════════════════════════════
// Surface A — resolveVariantMatrixObservations
// ═════════════════════════════════════════════════════════════════════════
describe("[SINGLE-FLIGHT] Surface A — resolveVariantMatrixObservations", () => {
  it("[SINGLE-FLIGHT-A] two simultaneous calls against the SAME store execute exactly ONE real resolver pass", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    store.add(makeOneOpenObservation({ observationId: "sf-a-obs-1" }));
    const { client, calls } = makeTrackingVariantClient(30);

    const p1 = resolveVariantMatrixObservations(store, client);
    const p2 = resolveVariantMatrixObservations(store, client);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls()).toBe(1); // exactly one real candle-fetch invocation — direct count, not inference
    expect(r2).toBe(r1); // identical result reference: the second call joined, it did not recompute
  });

  it("[SINGLE-FLIGHT-C] a simulated dashboard-audit-summary-style call (fire-and-forget) and a simulated operator-brief-style call (raced against a timeout) against the SAME cgvmStore cannot overlap", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    store.add(makeOneOpenObservation({ observationId: "sf-c-obs-1" }));
    const { client, calls } = makeTrackingVariantClient(30);

    // dashboard-audit-summary's real shape (shadow.ts ~line 1463): fire-and-forget, `.catch(() => {})`,
    // never awaited by its own caller.
    const fireAndForget = resolveVariantMatrixObservations(store, client).catch(() => {});

    // operator-brief's real shape (shadow.ts ~line 2257/2285): race the SAME call against a timeout
    // shorter than the client's own delay — exactly the "handler can move on while the real work is
    // still running in the background" shape the defect narrative describes.
    const operatorBriefPromise = resolveVariantMatrixObservations(store, client);
    const raced = await Promise.race([
      operatorBriefPromise,
      new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 5)),
    ]);
    expect(raced).toBe("TIMED_OUT"); // confirms the race genuinely gave up before the real 30ms pass finished

    // Whichever branch the race took, both callers' underlying work is the SAME single pass.
    const settled = await operatorBriefPromise;
    await fireAndForget;

    expect(calls()).toBe(1); // still exactly one real pass, regardless of which caller "gave up" first
    expect(settled).toEqual({ resolved: 0, expired: 0, dataFailures: 0, errors: 0 });
  });

  it("[SINGLE-FLIGHT-D] a pass that throws still releases the lock — a subsequent call starts a genuinely NEW pass, not a join against a dead promise", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    store.add(makeOneOpenObservation({ observationId: "sf-d-obs-1" }));
    const { client } = makeTrackingVariantClient(0);

    // `resolveVariantMatrixObservationsInner` is itself deliberately fail-open (every phase is
    // wrapped in its own try/catch, so a normal run can never reject) — the ONE real call this
    // resolver makes before entering that protected region is `store.beginBatch()`, so a controlled
    // failure injected there is a genuine, real rejection path through real code, not a
    // reimplementation of the gate.
    const beginBatchSpy = vi.spyOn(store, "beginBatch").mockImplementationOnce(() => {
      throw new Error("[SINGLE-FLIGHT-D] injected failure — forces the wrapped resolver's returned promise to reject");
    });

    await expect(resolveVariantMatrixObservations(store, client)).rejects.toThrow(/injected failure/);

    // The lock must be released after the rejection settles: a call made AFTER it has settled must
    // start a genuinely new pass (not join a dead promise forever).
    const after = await resolveVariantMatrixObservations(store, client);
    expect(after).toEqual({ resolved: 0, expired: 0, dataFailures: 0, errors: 0 });
    expect(beginBatchSpy).toHaveBeenCalledTimes(2); // one rejected attempt, then one genuinely new pass

    beginBatchSpy.mockRestore();
  });

  it("[SINGLE-FLIGHT-E] two DIFFERENT store instances run fully concurrently, never serialized against each other", async () => {
    const storeA = new CurrentGuardVariantMatrixStore(tmpDir());
    const storeB = new CurrentGuardVariantMatrixStore(tmpDir());
    storeA.add(makeOneOpenObservation({ observationId: "sf-e-a-1" }));
    storeB.add(makeOneOpenObservation({ observationId: "sf-e-b-1" }));
    const { client, windows } = makeTrackingVariantClient(40);

    const startedAt = Date.now();
    await Promise.all([
      resolveVariantMatrixObservations(storeA, client),
      resolveVariantMatrixObservations(storeB, client),
    ]);
    const totalMs = Date.now() - startedAt;

    const [w1, w2] = windows();
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    // Genuine wall-clock overlap: each call's window started before the OTHER call's window ended.
    expect(w1!.start).toBeLessThan(w2!.end);
    expect(w2!.start).toBeLessThan(w1!.end);
    // If the two stores were (incorrectly) cross-serialized, total time would be roughly additive
    // (~2x the delay); confirm it stayed close to ONE delay window instead.
    expect(totalMs).toBeLessThan(40 * 2);
  });

  it("[SINGLE-FLIGHT-F] joined callers receive the exact same final output as the original caller — not a placeholder, not an independently recomputed report", async () => {
    const store = new CurrentGuardVariantMatrixStore(tmpDir());
    store.add(makeOneOpenObservation({ observationId: "sf-f-obs-1", symbol: "AAAUSDT" }));
    store.add(makeOneOpenObservation({ observationId: "sf-f-obs-2", symbol: "BBBUSDT" }));
    const { client, calls } = makeTrackingVariantClient(20);

    const p1 = resolveVariantMatrixObservations(store, client);
    const p2 = resolveVariantMatrixObservations(store, client);
    const p3 = resolveVariantMatrixObservations(store, client); // a third joiner, for good measure
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(calls()).toBe(2); // one real pass, both observations fetched once each — not 4, not 6
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(store.getResolverMeta()?.walkCursor).toBe(2); // exactly one pass's worth of work, not a multiple of it
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Surface B — admitPaperOpportunities + runPaperAdmissionAndResolution, composed via
// runExclusiveForStore the SAME way shadow.ts's route handler now does.
// ═════════════════════════════════════════════════════════════════════════
describe("[SINGLE-FLIGHT] Surface B — paper admission + resolution", () => {
  it("[SINGLE-FLIGHT-B] a simulated PAPER_AUTO_CYCLE-style call and a simulated direct operator-brief-style call, fired concurrently against the same paperStore, share the same pass (one real admission-and-resolution pass, same joined result, no duplicate PaperOrder)", async () => {
    const dir = tmpDir();
    const paperStore = new PaperExecutionRouterStore(dir);
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    paperStore.ensurePaperStartAt(new Date(Date.now() - 5 * 60_000).toISOString());
    // A genuinely resolvable OPEN order already in the book — gives runPaperAdmissionAndResolution's
    // resolution phase real async work (a real getKlines fetch), creating a genuine in-flight window.
    paperStore.add(makeOpenPaperOrder());

    const routerReport = routerOf("Bullish expansion");
    const gateReport = emptyGate();
    const vmReport = buildCurrentGuardVariantMatrixReport(vmStore);
    const opportunity = makeOpportunity();
    const { client } = makeTrackingPaperClient(15);
    const now = new Date().toISOString();

    let realPassCount = 0;
    const fn = async () => {
      realPassCount += 1;
      const admission = admitPaperOpportunities({ store: paperStore, opportunities: [opportunity], routerReport, gateReport, now });
      const perf = await runPaperAdmissionAndResolution({
        store: paperStore,
        vmStore,
        routerReport,
        vmReport,
        gateReport,
        binanceClient: client,
        now,
      });
      return { admission, perf };
    };

    // "PAPER_AUTO_CYCLE-style" call — the headless ticker's own self-fetch, fired first.
    const paperAutoCycleCall = runExclusiveForStore(paperStore, fn);
    // "direct operator-brief-style" call — a genuinely independent, concurrent trigger against the
    // SAME store, fired immediately after (mirrors two uncoordinated production entry points).
    const directOperatorBriefCall = runExclusiveForStore(paperStore, fn);

    const [r1, r2] = await Promise.all([paperAutoCycleCall, directOperatorBriefCall]);

    expect(realPassCount).toBe(1); // only ONE real admission-and-resolution pass ran
    expect(r2).toBe(r1); // the joining caller received the IDENTICAL result reference
    expect(paperStore.all.filter((o) => o.selectedLaneId === opportunity.laneId).length).toBe(1); // exactly one PaperOrder for this opportunity, not two
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Combined — walkCursor (Surface A) + no duplicate admission (Surface B) under overlap
// ═════════════════════════════════════════════════════════════════════════
describe("[SINGLE-FLIGHT] combined — walkCursor advances once per real pass, and no duplicate admission under overlap", () => {
  it("[SINGLE-FLIGHT-G] two overlapping calls: the resolver's walkCursor advances exactly once per real pass, and the same signal never gets a second PaperOrder", async () => {
    // ── Surface A half: walkCursor ──
    const vmStore = new CurrentGuardVariantMatrixStore(tmpDir());
    vmStore.add(makeOneOpenObservation({ observationId: "sf-g-vm-1", symbol: "GGGUSDT" }));
    vmStore.add(makeOneOpenObservation({ observationId: "sf-g-vm-2", symbol: "HHHUSDT" }));
    vmStore.add(makeOneOpenObservation({ observationId: "sf-g-vm-3", symbol: "IIIUSDT" }));
    const { client: vmClient, calls: vmCalls } = makeTrackingVariantClient(15);

    await Promise.all([
      resolveVariantMatrixObservations(vmStore, vmClient),
      resolveVariantMatrixObservations(vmStore, vmClient),
    ]);
    // PRIMARY discriminator: real candle-fetch invocations. None of these 3 obs ever resolve (empty
    // candles), so each independent, un-joined pass would call getKlines 3 times — 2 un-joined
    // passes would total 6. Counting is required here specifically because
    // `resolveVariantMatrixObservationsInner` defers every store write to a single end-of-run flush
    // (see its own "accumulate patches" comment): an un-joined second pass reads the SAME
    // not-yet-flushed cursor/store state as the first and independently computes the SAME
    // `walkCursorStart + walked` delta, so walkCursor ALONE can coincidentally read correctly even
    // when two genuinely independent passes both ran — confirmed empirically against a deliberate
    // break-the-join mutation of runExclusiveForStore during this suite's own development. The call
    // count does not share that blind spot: it is 6, not 3, the moment a second real pass runs.
    expect(vmCalls()).toBe(3);
    expect(vmStore.getResolverMeta()?.walkCursor).toBe(3); // corroborating — see comment above for why this check alone is not sufficient

    // ── Surface B half: no duplicate admission ──
    const dir = tmpDir();
    const paperStore = new PaperExecutionRouterStore(dir);
    const paperVmStore = new CurrentGuardVariantMatrixStore(dir);
    paperStore.ensurePaperStartAt(new Date(Date.now() - 5 * 60_000).toISOString());
    const routerReport = routerOf("Bullish expansion");
    const gateReport = emptyGate();
    const vmReport = buildCurrentGuardVariantMatrixReport(paperVmStore);
    const opportunity = makeOpportunity({ sourceCandidateId: "sf-g-opportunity", symbol: "SOLUSDT" });
    const { client: paperClient } = makeTrackingPaperClient(15);
    const now = new Date().toISOString();

    // PRIMARY discriminator: real-pass invocation count. `admitPaperOpportunities` is itself
    // synchronous with its own dedupe check against live store state (confirmed elsewhere in this
    // repo's own paper-execution-router.test.ts), so "no duplicate PaperOrder" alone can pass even
    // WITHOUT the lock working — a first, un-joined admission commits synchronously before a second,
    // independent pass's own admission call ever runs, and that second call's OWN dedupe check then
    // (correctly, but incidentally) suppresses it. Counting real invocations of the composed
    // admit-then-resolve pass is what actually isolates the LOCK's own contribution — confirmed
    // empirically against the same break-the-join mutation referenced above.
    let realPassCount = 0;
    const fn = async () => {
      realPassCount += 1;
      const admission = admitPaperOpportunities({ store: paperStore, opportunities: [opportunity], routerReport, gateReport, now });
      const perf = await runPaperAdmissionAndResolution({
        store: paperStore,
        vmStore: paperVmStore,
        routerReport,
        vmReport,
        gateReport,
        binanceClient: paperClient,
        now,
      });
      return { admission, perf };
    };

    await Promise.all([
      runExclusiveForStore(paperStore, fn),
      runExclusiveForStore(paperStore, fn),
    ]);

    expect(realPassCount).toBe(1);
    expect(paperStore.all.filter((o) => o.selectedLaneId === opportunity.laneId).length).toBe(1);
  });
});

/**
 * Point 6 — live-execution-engine end-to-end test.
 *
 * Drives the REAL LiveExecutionEngine (via the existing FakeLiveClient pattern from
 * live-execution-engine.test.ts — reused, never reinvented) together with the REAL production
 * scan -> CORTEX -> paper allocator -> PaperOrder -> Four-Brain -> Executive Review chain (reused
 * from cortex-four-brain-causal-chain-e2e.test.ts's own helpers).
 *
 * Sequence exercised: a real PaperOrder is admitted -> a real execution intent is created FIRST via
 * LiveExecutionEngine.tick(), before any Executive Review exists -> the real Four-Brain review runs
 * and late-binds onto that already-existing intent (point 2's late-binding path, through point 5's
 * per-tick intent index) -> the intent is filled/closed through real engine ticks against the fake
 * exchange client -> a real Tier-1 outcome is resolved via resolveExecutiveReviewPositions off the
 * REAL closed LiveIntent object (never hand-built, never cast) -> exactly one CORTEX learner example.
 *
 * Never emits a paper OUTCOME_RESOLUTION event — Tier-1 economics come from the real Executive Review
 * runtime exactly as production does.
 *
 * No LiveIntent is ever hand-constructed or type-cast anywhere in this file: every intent object
 * used comes from `liveStore.getState().intents`, populated only by real LiveExecutionEngine.tick()
 * calls against the fake Binance client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { PaperExecutionRouterStore, type PaperOrder } from "../src/lib/paper-execution-router.js";
import { buildPaperOrderOwnershipIndex } from "../src/lib/paper-order-ownership-index.js";
import { attachExecutiveReviewToExactPaperOrder } from "../src/lib/executive-review-admission.js";
import { ExecutiveReviewStore } from "../src/lib/executive-review-store.js";
import { resolveExecutiveReviewPositions } from "../src/lib/executive-review-runtime.js";
import { buildCortexShadowTrainingDataset } from "../src/lib/cortex-shadow-refit.js";
import { CORTEX_LIVE_BETA } from "../src/lib/cortex-brain.js";
import {
  readForwardCausalEvents,
  forwardCausalJournalPath,
  type ForwardEvent,
} from "../src/experience-engine/forward-causal-collection.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";
import { _resetCortexDecisionSnapshotsForTests } from "../src/lib/cortex-decision-snapshot.js";
import { buildLiveIntentIndexByPaperOrderId } from "../src/lib/live-intent-index.js";
import { LiveExecutionEngine, LiveExecutionStore, type LiveIntent } from "../src/lib/live-execution-engine.js";

// ── Reused, not reinvented: point 6's own explicit requirement. Both files' helpers were made
// `export` as a purely additive preparatory step (no logic change) so this file can drive the real
// production chain plus a real fake-exchange LiveExecutionEngine without any duplicate fixtures. ──
import {
  type ChainEnv,
  setupChainEnv,
  teardownChainEnv,
  buildAdmittedOrder,
  runFourBrainTickForOrder,
  policyFor,
  CANONICAL_CORTEX_LANE_ID,
} from "./helpers/cortex-four-brain-causal-chain-e2e-fixtures.js";
import { FakeLiveClient, makePaperStore, makeEngine } from "./helpers/live-execution-engine-fixtures.js";

// ── Local temp-dir bookkeeping for the LiveExecutionStore instances this file creates directly
// (never routed through live-execution-engine.test.ts's own private `tmp()`/`dirs`, so cleanup stays
// entirely within this file's own afterEach). ────────────────────────────────────────────────────
const liveDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(os.tmpdir(), prefix));
  liveDirs.push(d);
  return d;
}

/** A real, fully independent LiveExecutionEngine wired to a fake Binance client, mirroring exactly
 *  ONE PaperOrder. `mirrorAllPaperOrders: true` is a real, production-used testnet config value (it
 *  bypasses the HEADLINE/diagnostic-label/watermark gates that exist to rank/dedupe a whole scan
 *  batch — irrelevant here since there is exactly one candidate order) rather than a test-only
 *  shortcut invented for this file. `paperOrders` is passed as a literal array (not `store.all`) so
 *  a later mutation of the real PaperExecutionRouterStore (e.g. the attach step's
 *  `paperStore.update(...)`) can never leak into what this engine sees — the engine already read
 *  everything it needs to open the intent by the time any review attaches. */
function makeLiveEngineForOrders(
  paperOrders: readonly PaperOrder[],
  nowIso: string,
): { engine: LiveExecutionEngine; client: FakeLiveClient; store: LiveExecutionStore } {
  const client = new FakeLiveClient();
  const store = new LiveExecutionStore(tmpDir("live-store-"));
  const { engine } = makeEngine({
    client,
    store,
    paper: makePaperStore([...paperOrders]),
    config: { mirrorAllPaperOrders: true },
    nowIso: () => nowIso,
  });
  return { engine, client, store };
}

/** Fills the intent's TP1 LIMIT completely (the `tp1_full` lane exit rule banks 100% at TP1 — no
 *  runner, no breakeven replace) and drives the position flat, so ONE more `engine.tick()` settles
 *  the intent straight to CLOSED — mirrors live-execution-engine.test.ts's own "tp1_full lane" test. */
async function fillTp1AndClose(
  engine: LiveExecutionEngine,
  client: FakeLiveClient,
  store: LiveExecutionStore,
  symbol: string,
  realizedPnl: number,
  commission: number,
  entryTradeAtMs: number,
  exitTradeAtMs: number,
): Promise<LiveIntent> {
  const intent = store.getState().intents[0]!;
  client.orderStatusById.set(intent.tp1OrderId!, "FILLED");
  client.positionsBySymbol.set(symbol, 0);
  // The original protective STOP never triggered (TP1 is what closed this position) — tell the fake
  // client's queryAlgoOrder that explicitly (actualOrderId: null). Without this override the fake's
  // default stub reports EVERY algo order as already-triggered (actualOrderId = its own id), which
  // would fold the still-resting stop into the close settlement's requiredOrderIds and make a real
  // close spuriously SETTLEMENT_INCOMPLETE.
  client.algoOrderOverrides.set(intent.stopOrderId!, { algoStatus: "NEW", actualOrderId: null });
  // Both the entry AND the exit order must appear in /userTrades — settlement's own
  // collectUserTradesSettlementCoverage requires EVERY id in requiredOrderIds (which always includes
  // intent.entryOrderId, see live-execution-engine.ts's close-settlement call site) to be visible
  // before it reports settlementFetchComplete: true; a missing entry-side row is exactly what makes
  // outcomeReason() reject a real close as SETTLEMENT_INCOMPLETE (never linked to Tier 1). Real,
  // realistic epoch-ms `time` values (never small placeholder integers) matter here specifically
  // because buildCortexShadowTrainingDataset derives entryFilledAtMs straight off this trade's own
  // `time` field and rejects anything before CORTEX_SHADOW_REFIT_DEFAULT_EPOCH as PRE_RESET_EPOCH.
  client.trades = [
    {
      symbol,
      orderId: intent.entryOrderId!,
      price: intent.plannedEntryPrice,
      qty: intent.qty,
      realizedPnl: 0,
      commission: 0.02,
      commissionAsset: "USDT",
      time: entryTradeAtMs,
    },
    {
      symbol,
      orderId: intent.tp1OrderId!,
      price: intent.tp1Price,
      qty: intent.qty,
      realizedPnl,
      commission,
      commissionAsset: "USDT",
      time: exitTradeAtMs,
    },
  ];
  await engine.tick();
  return store.getState().intents[0]!;
}

/** The one causally-linked sizing/exit-lifecycle snapshot every test in this file needs off a freshly
 *  opened intent, for both direct assertions and the invariance comparison. */
function sizingSnapshot(intent: LiveIntent) {
  return {
    qty: intent.qty,
    tp1Qty: intent.tp1Qty,
    plannedEntryPrice: intent.plannedEntryPrice,
    stopLossPrice: intent.stopLossPrice,
    tp1Price: intent.tp1Price,
    effectiveRiskUsd: intent.effectiveRiskUsd,
    appliedNotionalUsd: intent.appliedNotionalUsd,
    requiredNotionalUsd: intent.requiredNotionalUsd,
    notionalCapUsd: intent.notionalCapUsd,
    stopDistancePct: intent.stopDistancePct,
    cortexAppliedWeightPct: intent.cortexAppliedWeightPct,
    cortexRawStaticWeightPct: intent.cortexRawStaticWeightPct,
  };
}

describe("CORTEX <-> LiveExecutionEngine live-execution e2e (point 6, real functions only)", () => {
  let ctx: ChainEnv;

  beforeEach(() => {
    ctx = setupChainEnv();
    _resetCortexDecisionSnapshotsForTests();
    _resetCortexProductionChainDiagnosticsForTests();
  });
  afterEach(() => {
    teardownChainEnv(ctx);
    while (liveDirs.length > 0) rmSync(liveDirs.pop()!, { recursive: true, force: true });
  });

  it("real intent created BEFORE the review; real late-binding attach; real close; real Tier-1; exactly one CORTEX learner example", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    const { engine, client, store: liveStore } = makeLiveEngineForOrders(store.all, nowIso);

    expect((await engine.arm()).ok).toBe(true);

    // Step A: the execution intent is created FIRST, via the real engine, before any review exists.
    await engine.tick();
    expect(client.placed.map((p) => p.type)).toEqual(["MARKET", "STOP_MARKET", "LIMIT"]);
    expect(liveStore.getState().intents).toHaveLength(1);
    let intent = liveStore.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.paperOrderId).toBe(order.paperOrderId);
    expect(intent.executiveReviewLink).toBeUndefined();
    // Point 2's stamping, proven against a REAL causalIdentity (never hand-built).
    expect(intent.causalLineage).toEqual({
      opportunityId: order.causalIdentity!.opportunityId,
      cortexDecisionId: order.causalIdentity!.cortexDecisionId,
      allocationSnapshotId: order.causalIdentity!.allocationSnapshotId,
      canonicalCortexLaneId: order.causalIdentity!.canonicalCortexLaneId,
      instanceId: order.causalIdentity!.instanceId,
      policyDeploymentAt: order.causalIdentity!.policyDeploymentAt,
      // 6 additional fields (blocker 2), read directly off the real PaperOrder, not off causalIdentity.
      paperOrderId: order.paperOrderId,
      sourceObservationId: order.sourceObservationId,
      scanBatchId: order.scanBatchId ?? null,
      paperLaneId: order.selectedLaneId,
      symbol: order.symbol,
      direction: order.direction,
    });
    const placedBeforeAttach = client.placed.map((p) => ({ ...p }));
    const sizingBeforeAttach = sizingSnapshot(intent);

    // Step B: the real Four-Brain review runs AFTER the intent already exists.
    const { executive, candidateId, featureSnapshot } = runFourBrainTickForOrder(ctx, store, order);
    expect(candidateId).toBe(order.sourceObservationId);
    expect(executive.candidateStatus).toBe("VALID");
    expect(executive.entry?.action).toBe("ENTER_NOW");
    expect(executive.allocationContext.cortexAllocationSnapshotId).toBe(order.causalIdentity!.allocationSnapshotId);

    // Point 5's real per-tick index — never a linear scan — built off the real live store.
    const liveIntentIndexByPaperOrderId = buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents);
    expect(liveIntentIndexByPaperOrderId.get(order.paperOrderId)).toBe(intent);

    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const attachResult = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set([order.paperOrderId]),
      env: ctx.env,
      brainFeatureSnapshot: featureSnapshot,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      liveIntentIndexByPaperOrderId,
      saveLiveIntents: () => liveStore.save(),
    });
    expect(attachResult).toBe("ATTACHED");

    intent = liveStore.getState().intents[0]!; // re-read: the attach mutated this real intent in place
    expect(intent.executiveReviewLink).not.toBeUndefined();
    const review = reviewStore.get().reviews[0]!;
    expect(intent.executiveReviewLink!.executiveReviewId).toBe(review.executiveReviewId);
    expect(review.opportunityId).toBe(order.causalIdentity!.opportunityId);
    const linkedOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    expect(linkedOrder.executiveReviewLink).not.toBeNull();

    // Proof the attach is provably inert to execution: neither the exchange requests already sent
    // nor the sizing/risk fields already frozen at open moved.
    expect(client.placed.map((p) => ({ ...p }))).toEqual(placedBeforeAttach);
    expect(sizingSnapshot(intent)).toEqual(sizingBeforeAttach);
    expect(engine.isArmed()).toBe(true);
    expect(engine.getCortexPromotedWeights()).toBeNull();
    expect(CORTEX_LIVE_BETA).toBe(0);

    // A later tick with no new candidates neither re-attaches nor re-places anything.
    await engine.tick();
    expect(client.placed.length).toBe(placedBeforeAttach.length);

    // Step C: close the position through the real engine (fake exchange, real lifecycle code).
    const closed = await fillTp1AndClose(engine, client, liveStore, order.symbol, 5, 0.04, ctx.NOW + 60_000, ctx.NOW + 120_000);
    expect(closed.state).toBe("CLOSED");
    expect(closed.executiveReviewLink).not.toBeUndefined(); // the review link survives the close untouched

    // Step D: real Tier-1 resolution off the REAL closed intent — never a hand-built/cast LiveIntent.
    const nowMsForResolve = Date.parse(closed.closedAt!) + 20 * 60_000; // past the completed-candle boundary
    const summary = resolveExecutiveReviewPositions(reviewStore, liveStore.getState().intents, nowMsForResolve);
    expect(summary.linked).toBe(1);
    expect(reviewStore.get().tier1).toHaveLength(1);
    const tier1 = reviewStore.get().tier1[0]!;
    expect(tier1.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(tier1.canonicalCortexLaneId).toBe(CANONICAL_CORTEX_LANE_ID);
    expect(cortexProductionChainDiagnostics().CORTEX_TIER1_RESOLVED).toBeGreaterThanOrEqual(1);

    // Step E: real forward-causal events — never a paper OUTCOME_RESOLUTION.
    const journalPath = forwardCausalJournalPath(ctx.env)!;
    const forwardEvents: ForwardEvent[] = readForwardCausalEvents(journalPath);
    expect(forwardEvents.some((e) => e.eventType === "OUTCOME_RESOLUTION")).toBe(false);

    // Step F: exactly one CORTEX learner example.
    const dataset = buildCortexShadowTrainingDataset({
      outcomes: [tier1],
      forwardEvents,
      policy: policyFor(ctx),
      nowMs: ctx.NOW + 24 * 3_600_000,
    });
    expect(dataset.examples).toHaveLength(1);
    const example = dataset.examples[0]!;
    expect(example.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(example.canonicalCortexLaneId).toBe(CANONICAL_CORTEX_LANE_ID);
    expect(cortexProductionChainDiagnostics().CORTEX_LEARNER_ELIGIBLE).toBeGreaterThanOrEqual(1);
  });

  // ── GAP fix (round 3 remediation, 2026-08-02): buildLiveIntentIndexByPaperOrderId previously
  // indexed intents ONLY by their primary paperOrderId, never by intent.sourcePaperOrders[i]
  // .paperOrderId — so a genuine pyramid-add/netted order's id could never resolve to its owning
  // intent, executingPaperOrderIds (app.ts) could never mark it executing, and
  // executive-review-admission.ts's sourceEntry branch was unreachable in production. This test
  // proves the fix end to end through the REAL LiveExecutionEngine (fake Binance client only) and
  // the REAL production admission chain — a second real PaperOrder is admitted for the SAME
  // symbol/lane/direction as the first (via buildAdmittedOrder's additive `scanBatchId` option, see
  // its own doc comment for why that produces a genuinely distinct, non-deduplicated order) and, on
  // a later engine tick, the real `addToIntent` pyramid path nets it into the already-OPEN intent as
  // a sourcePaperOrders entry — never a hand-built LiveIntentSource. ──────────────────────────────
  it("[pyramid-add] a genuine second source order netted into an already-OPEN intent late-binds via its REAL sourcePaperOrders entry — proving the sourceEntry branch is reachable in production", async () => {
    const { order: order1Initial } = await buildAdmittedOrder(ctx);
    // A second real admission for the SAME candidate/symbol/lane/direction, under a distinct
    // scanBatchId so it is never suppressed as a duplicate of order1 (allocatorDedupeKey embeds the
    // scanBatchId) — a genuinely independent real PaperOrder, not a clone of order1.
    const { order: order2Initial } = await buildAdmittedOrder(ctx, { scanBatchId: `${ctx.scanBatchId}-pyramid` });
    // buildAdmittedOrder constructs its OWN `new PaperExecutionRouterStore(ctx.paperDir)` internally
    // per call — each instance loads from disk at construction and never hot-reloads afterward, so
    // the store object returned by the FIRST call never sees what the SECOND call's own store
    // instance persisted. A fresh store constructed here, AFTER both real admissions have persisted
    // to the SAME `ctx.paperDir`, is the one real, current view containing both orders — used for
    // the rest of this test exactly like the single `store` the other tests in this file share.
    const store = new PaperExecutionRouterStore(ctx.paperDir);
    store.update(order1Initial.paperOrderId, { variantExitRule: "tp1_full" });
    store.update(order2Initial.paperOrderId, { variantExitRule: "tp1_full" });
    const order1 = store.all.find((o) => o.paperOrderId === order1Initial.paperOrderId)!;
    const order2 = store.all.find((o) => o.paperOrderId === order2Initial.paperOrderId)!;
    expect(order2.paperOrderId).not.toBe(order1.paperOrderId);
    expect(order2.symbol).toBe(order1.symbol);
    expect(order2.selectedLaneId).toBe(order1.selectedLaneId);
    expect(order2.direction).toBe(order1.direction);

    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    // A literal, mutable array — NOT `store.all` — so tick 1 sees ONLY order1 (mirroring
    // makeLiveEngineForOrders' own decoupling contract); order2 is appended to this SAME array
    // object before tick 2, which the engine reads live off `this.paperStore.all` every tick.
    const paperArray: PaperOrder[] = [order1];
    const client = new FakeLiveClient();
    const liveStore = new LiveExecutionStore(tmpDir("live-store-pyramid-"));
    const { engine } = makeEngine({
      client,
      store: liveStore,
      paper: makePaperStore(paperArray),
      // Generous caps — this test is proving the sourceEntry index/attach path, not exercising
      // sizing/risk-cap edges; a tight default cap coincidentally blocking the second add would be
      // an unrelated false negative.
      config: { mirrorAllPaperOrders: true, maxAggregateIntentRiskUsd: 1000, maxConcurrentPositions: 5 },
      nowIso: () => nowIso,
    });
    expect((await engine.arm()).ok).toBe(true);

    // Tick 1: opens the intent from order1 alone (identical to the main happy-path test above).
    await engine.tick();
    expect(liveStore.getState().intents).toHaveLength(1);
    let intent = liveStore.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.paperOrderId).toBe(order1.paperOrderId);
    expect(intent.sourcePaperOrders?.map((s) => s.paperOrderId)).toEqual([order1.paperOrderId]);

    // Tick 2: order2 becomes visible to the SAME engine/paper array. Same symbol + same lane + same
    // exit rule + same direction + an already-OPEN intent on that symbol ⇒ the real addToIntent
    // (pyramid-add) path fires — never a second intent.
    paperArray.push(order2);
    await engine.tick();
    expect(liveStore.getState().intents).toHaveLength(1); // still ONE intent — netted, not a second position
    intent = liveStore.getState().intents[0]!;
    expect(intent.paperOrderId).toBe(order1.paperOrderId); // primary is unchanged by the add
    const sourceIds = intent.sourcePaperOrders?.map((s) => s.paperOrderId) ?? [];
    expect(sourceIds).toContain(order1.paperOrderId);
    expect(sourceIds).toContain(order2.paperOrderId); // order2 genuinely netted in — a SOURCE, never a primary

    // THE GAP FIX, proven against the real index: order2 (source-only) now resolves to the SAME
    // intent as order1 (primary) — before this fix, `.get(order2.paperOrderId)` was always
    // `undefined` here, no matter how real the intent was.
    const liveIntentIndexByPaperOrderId = buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents);
    expect(liveIntentIndexByPaperOrderId.get(order2.paperOrderId)).toBe(intent);
    expect(liveIntentIndexByPaperOrderId.get(order1.paperOrderId)).toBe(intent);
    expect(liveIntentIndexByPaperOrderId.conflictedPaperOrderIds.size).toBe(0);

    // Real Four-Brain tick + real late-binding attach for order2 SPECIFICALLY (the source order, not
    // the primary) — proving the sourceEntry branch (executive-review-admission.ts) is genuinely
    // reachable end to end, driven exactly as app.ts's real executingPaperOrderIds derivation now
    // computes it (index keys UNION conflictedPaperOrderIds).
    const { executive, candidateId, featureSnapshot } = runFourBrainTickForOrder(ctx, store, order2);
    expect(candidateId).toBe(order2.sourceObservationId);
    expect(executive.entry?.action).toBe("ENTER_NOW");
    expect(executive.allocationContext.cortexAllocationSnapshotId).toBe(order2.causalIdentity!.allocationSnapshotId);

    const reviewStore = new ExecutiveReviewStore(join(tmpDir("reviews-pyramid-"), "reviews.json"));
    const attachResult = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set([
        ...liveIntentIndexByPaperOrderId.keys(),
        ...liveIntentIndexByPaperOrderId.conflictedPaperOrderIds,
      ]),
      env: ctx.env,
      brainFeatureSnapshot: featureSnapshot,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      liveIntentIndexByPaperOrderId,
      saveLiveIntents: () => liveStore.save(),
    });
    expect(attachResult).toBe("ATTACHED");

    intent = liveStore.getState().intents[0]!; // re-read: the attach mutated this real intent in place
    const sourceEntry = intent.sourcePaperOrders?.find((s) => s.paperOrderId === order2.paperOrderId);
    expect(sourceEntry?.executiveReviewLink).not.toBeUndefined();
    expect(intent.executiveReviewLink).toBeUndefined(); // the PRIMARY (order1) entry is untouched
    const review = reviewStore.get().reviews[0]!;
    expect(sourceEntry?.executiveReviewLink?.executiveReviewId).toBe(review.executiveReviewId);
    expect(review.opportunityId).toBe(order2.causalIdentity!.opportunityId);
    const linkedOrder2 = store.all.find((o) => o.paperOrderId === order2.paperOrderId)!;
    expect(linkedOrder2.executiveReviewLink).not.toBeNull();
    // order1's own PaperOrder is untouched by an attach that targeted order2.
    const untouchedOrder1 = store.all.find((o) => o.paperOrderId === order1.paperOrderId)!;
    expect(untouchedOrder1.executiveReviewLink).toBeFalsy();
  });

  // ── Negative cases: each must fail closed with an explicit rejection, driven through the real
  // late-binding path against a REAL intent — never a fabricated assertion. ────────────────────────

  it("[negative] duplicate late-binding attach attempt — ORDER_ALREADY_LINKED, never a second review row", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    const { engine, store: liveStore } = makeLiveEngineForOrders(store.all, nowIso);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();

    const { executive, candidateId, featureSnapshot } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const attachOnce = () =>
      attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore: store,
        executive,
        candidateId,
        executingPaperOrderIds: new Set([order.paperOrderId]),
        env: ctx.env,
        brainFeatureSnapshot: featureSnapshot,
        paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
        liveIntentIndexByPaperOrderId: buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents),
        saveLiveIntents: () => liveStore.save(),
      });

    expect(attachOnce()).toBe("ATTACHED");
    expect(reviewStore.get().reviews).toHaveLength(1);
    // Real duplicate replay of the exact same late-binding attach call.
    expect(attachOnce()).toBe("ORDER_ALREADY_LINKED");
    expect(reviewStore.get().reviews).toHaveLength(1); // never a second row, never re-attached
  });

  it("[negative] a CLOSED intent fails closed as INTENT_TERMINAL — a review can never late-bind onto a dead intent", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    const { engine, client, store: liveStore } = makeLiveEngineForOrders(store.all, nowIso);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const closed = await fillTp1AndClose(engine, client, liveStore, order.symbol, 5, 0.04, ctx.NOW + 60_000, ctx.NOW + 120_000);
    expect(closed.state).toBe("CLOSED");
    expect(closed.executiveReviewLink).toBeUndefined(); // never attached before it closed

    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set([order.paperOrderId]), // still "executing" per the intent index — it just terminated
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      liveIntentIndexByPaperOrderId: buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents),
      saveLiveIntents: () => liveStore.save(),
    });
    expect(result).toBe("INTENT_TERMINAL");
    expect(reviewStore.get().reviews).toHaveLength(0);
    expect(store.all.find((o) => o.paperOrderId === order.paperOrderId)!.executiveReviewLink).toBeFalsy();
  });

  it("[negative] an intent with no causalLineage fails closed as INTENT_LINEAGE_MISSING — never guessed", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const originalIdentity = order.causalIdentity!;
    const originalCanonicalLaneId = order.canonicalCortexLaneId;
    const originalSnapshot = order.cortexDecisionSnapshot;
    // Real store mutation (never a hand-built PaperOrder): simulate the intent being opened at a
    // moment the PaperOrder genuinely carried no causalIdentity yet.
    store.update(order.paperOrderId, { causalIdentity: null });
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    const { engine, store: liveStore } = makeLiveEngineForOrders(store.all, nowIso);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = liveStore.getState().intents[0]!;
    expect(intent.state).toBe("OPEN");
    expect(intent.causalLineage).toBeUndefined(); // never fabricated at open time

    // Real store mutation again: the PaperOrder's causalIdentity is reassigned back to its real,
    // valid value AFTER the intent already exists — exactly the reachable reassignment mechanism
    // paper-execution-router.ts's re-price path documents. The intent's own lineage snapshot,
    // stamped once at open, is never revisited.
    store.update(order.paperOrderId, {
      causalIdentity: originalIdentity,
      canonicalCortexLaneId: originalCanonicalLaneId,
      cortexDecisionSnapshot: originalSnapshot,
    });
    const restoredOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, restoredOrder);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set([order.paperOrderId]),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      liveIntentIndexByPaperOrderId: buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents),
      saveLiveIntents: () => liveStore.save(),
    });
    expect(result).toBe("INTENT_LINEAGE_MISSING");
    expect(reviewStore.get().reviews).toHaveLength(0);
    expect(store.all.find((o) => o.paperOrderId === order.paperOrderId)!.executiveReviewLink).toBeFalsy();
  });

  it("[negative] a PaperOrder whose causalIdentity was reassigned after the intent opened fails closed as INTENT_LINEAGE_CONFLICT — never overwritten", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();
    const { engine, store: liveStore } = makeLiveEngineForOrders(store.all, nowIso);
    expect((await engine.arm()).ok).toBe(true);
    await engine.tick();
    const intent = liveStore.getState().intents[0]!;
    expect(intent.causalLineage).toBeDefined();
    expect(intent.causalLineage!.opportunityId).toBe(order.causalIdentity!.opportunityId);

    // Real store mutation: a genuine post-admission causalIdentity reassignment (the exact mechanism
    // paper-execution-router.ts's re-price path documents) — only opportunityId changes, so every
    // OTHER gate this function checks (the CORTEX allocation-link fields) still passes, isolating the
    // assertion to the lineage comparison itself.
    store.update(order.paperOrderId, {
      causalIdentity: { ...order.causalIdentity!, opportunityId: "a-reassigned-opportunity-id-simulating-reprice" },
    });
    const reassignedOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    expect(reassignedOrder.causalIdentity!.opportunityId).not.toBe(intent.causalLineage!.opportunityId);

    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, reassignedOrder);
    expect(executive.allocationContext.cortexAllocationSnapshotId).toBe(reassignedOrder.causalIdentity!.allocationSnapshotId);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set([order.paperOrderId]),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      liveIntentIndexByPaperOrderId: buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents),
      saveLiveIntents: () => liveStore.save(),
    });
    expect(result).toBe("INTENT_LINEAGE_CONFLICT");
    expect(reviewStore.get().reviews).toHaveLength(0);
    // The intent's own stamped lineage is untouched — never silently overwritten to match the
    // reassigned identity.
    expect(liveStore.getState().intents[0]!.causalLineage!.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(store.all.find((o) => o.paperOrderId === order.paperOrderId)!.executiveReviewLink).toBeFalsy();
  });

  // ── Invariance: review/lineage attachment must be provably inert to execution. ─────────────────

  it("[invariance] review attachment does not change the exchange requests, sizing, risk parameters, reconciliation, arming, weights, CORTEX_LIVE_BETA, or promotion state", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.update(order.paperOrderId, { variantExitRule: "tp1_full" });
    const liveOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    const nowIso = new Date(ctx.NOW + 5 * 60_000).toISOString();

    async function run(attachReview: boolean) {
      // Each run gets its OWN engine/client/store, but the SAME real PaperOrder content — a literal
      // one-element array decoupled from `store.all`, so the `attachReview` run's later
      // `paperStore.update(...)` (on the real router store) can never leak into either run's own
      // engine input.
      const { engine, client, store: liveStore } = makeLiveEngineForOrders([liveOrder], nowIso);
      const armResult = await engine.arm();
      await engine.tick();
      const intentAfterOpen = liveStore.getState().intents[0]!;
      const sizing = sizingSnapshot(intentAfterOpen);

      let attachResult: string | null = null;
      if (attachReview) {
        const { executive, candidateId, featureSnapshot } = runFourBrainTickForOrder(ctx, store, order);
        const reviewStore = new ExecutiveReviewStore(join(tmpDir("reviews-"), "reviews.json"));
        attachResult = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore: store,
          executive,
          candidateId,
          executingPaperOrderIds: new Set([order.paperOrderId]),
          env: ctx.env,
          brainFeatureSnapshot: featureSnapshot,
          paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
          liveIntentIndexByPaperOrderId: buildLiveIntentIndexByPaperOrderId(liveStore.getState().intents),
          saveLiveIntents: () => liveStore.save(),
        });
      }

      const closed = await fillTp1AndClose(engine, client, liveStore, order.symbol, 5, 0.04, ctx.NOW + 60_000, ctx.NOW + 120_000);
      return {
        attachResult,
        armResult,
        placed: client.placed.map((p) => ({ ...p })),
        canceled: [...client.canceled],
        leverageCalls: [...client.leverageCalls],
        getUserTradesCalls: client.getUserTradesCalls,
        status: { armed: engine.getStatus().armed, env: engine.getStatus().env, enabled: engine.getStatus().enabled },
        promotedWeights: engine.getCortexPromotedWeights(),
        sizing,
        closedState: closed.state,
        closedReason: closed.closeReason,
        realizedPnlUsd: closed.realizedPnlUsd,
        feesUsd: closed.feesUsd,
      };
    }

    const without = await run(false);
    const withAttach = await run(true);

    expect(without.attachResult).toBeNull();
    expect(withAttach.attachResult).toBe("ATTACHED");

    // The exact exchange requests sent to the fake Binance client — byte-identical (same
    // paperOrderId ⇒ identical derived clientOrderIds, same fixed clock, same real order fields).
    expect(withAttach.placed).toEqual(without.placed);
    // Position sizing + risk parameters (stop/target levels), frozen at intent open, untouched.
    expect(withAttach.sizing).toEqual(without.sizing);
    // Reconciliation/settlement behavior untouched.
    expect(withAttach.canceled).toEqual(without.canceled);
    expect(withAttach.leverageCalls).toEqual(without.leverageCalls);
    expect(withAttach.getUserTradesCalls).toBe(without.getUserTradesCalls);
    expect(withAttach.closedState).toBe(without.closedState);
    expect(withAttach.closedReason).toBe(without.closedReason);
    expect(withAttach.realizedPnlUsd).toBeCloseTo(without.realizedPnlUsd!, 9);
    expect(withAttach.feesUsd).toBeCloseTo(without.feesUsd!, 9);
    // Arming state untouched.
    expect(withAttach.armResult).toEqual(without.armResult);
    expect(withAttach.status).toEqual(without.status);
    // CORTEX promoted-weight / promotion state untouched — both remain null (never installed here).
    expect(withAttach.promotedWeights).toBeNull();
    expect(without.promotedWeights).toBeNull();
    // CORTEX_LIVE_BETA is a hard-coded module constant (cortex-brain.ts) — review attachment holds
    // no reference to it and cannot touch it; asserted here as the explicit, named invariant.
    expect(CORTEX_LIVE_BETA).toBe(0);
  });
});

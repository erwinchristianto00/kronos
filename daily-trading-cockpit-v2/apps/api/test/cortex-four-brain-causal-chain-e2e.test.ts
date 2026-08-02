/**
 * Point 9 — real production-chain end-to-end test.
 *
 * Drives the ACTUAL production functions for the whole scanner -> CORTEX -> paper allocator ->
 * PaperOrder -> Four-Brain -> Executive Review -> Tier-1 outcome -> CORTEX learner chain. No final
 * Forward event, allocation context, or Tier-1 outcome is hand-constructed: every identity that
 * crosses a boundary is read back off what the previous production call actually produced.
 *
 * Never emits a paper OUTCOME_RESOLUTION event — the Tier-1 economics are resolved through the real
 * Executive Review runtime (`resolveExecutiveReviewPositions` / `ExecutiveReviewStore.resolve`)
 * exactly as production does, not through the paper resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Candidate, Direction } from "@dtc/shared";
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
  DECISION_PIPELINE_POLICY_VERSION,
} from "@dtc/shared";

import {
  buildPaperOpportunityAllocatorReport,
  type PaperOpportunityAllocatorInputs,
  type PaperOpportunity,
} from "../src/lib/paper-opportunity-allocator.js";
import {
  PaperExecutionRouterStore,
  admitPaperOpportunities,
  type PaperOrder,
} from "../src/lib/paper-execution-router.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  type VariantMatrixSignal,
  type KlineTuple,
  type CurrentGuardVariantMatrixReport,
} from "../src/lib/current-guard-variant-matrix.js";
import { buildAdaptiveLaneRouterReport } from "../src/lib/adaptive-lane-router.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "../src/lib/cortex-brain-store.js";
import { assembleCortexContext, CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";
import {
  publishCortexDecisionSnapshotsForScan,
  cortexDecisionSnapshotsForScan,
  exactCortexDecisionSnapshotForScan,
  _resetCortexDecisionSnapshotsForTests,
} from "../src/lib/cortex-decision-snapshot.js";
import { CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID } from "../src/lib/cortex-live-gather.js";
import { buildPaperOrderOwnershipIndex, paperOrderOwnershipKey } from "../src/lib/paper-order-ownership-index.js";
import { allocationContextWithExactCortexPaperBridge } from "../src/lib/cortex-paper-allocation-bridge.js";
import { attachExecutiveReviewToExactPaperOrder } from "../src/lib/executive-review-admission.js";
import { ExecutiveReviewStore, type ExecutiveReviewOutcome } from "../src/lib/executive-review-store.js";
import { resolveExecutiveReviewPositions } from "../src/lib/executive-review-runtime.js";
import type { LiveIntent } from "../src/lib/live-execution-engine.js";
import { MarketContextSnapshotStore } from "../src/lib/market-context-snapshot-store.js";
import { assembleFourBrainTick } from "../src/lib/four-brain-live-gather.js";
import {
  buildFourBrainGatherInput,
  type FourBrainBindingDeps,
  type EntryMicrostructure,
} from "../src/lib/four-brain-live-gather-bindings.js";
import { runFourBrainShadowTick, _resetFourBrainSingleFlightForTests } from "../src/lib/four-brain-shadow-tick.js";
import { EXECUTIVE_SCHEMA_VERSION, type ExecutiveDecision } from "../src/lib/four-brain-types.js";
import {
  readForwardCausalEvents,
  forwardCausalJournalPath,
  type ForwardEvent,
  type CanonicalPolicyContext,
} from "../src/experience-engine/forward-causal-collection.js";
import { buildCortexShadowTrainingDataset } from "../src/lib/cortex-shadow-refit.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";

// ── Small shared helpers (mirrors paper-opportunity-allocator.test.ts's own fixture idioms) ──────

function tmpDir(prefix: string): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
}
function emptyGate() {
  return buildLiveTradingGateReport({});
}
function routerOf(regime: string | null) {
  return buildAdaptiveLaneRouterReport({
    generatedAt: new Date().toISOString(),
    regimeReport: buildRegimeDirectionControllerReport({ currentRegime: regime, adaptiveDirectionBias: null, primaryValidationLane: null }),
    gateReport: emptyGate(),
  });
}

/** VM store with fresh SHORT signals — only needed so the allocator has a populated report; the
 *  candidate that matters for this test is the explicit LONG candidate passed separately. */
async function buildVmReport(dir: string): Promise<CurrentGuardVariantMatrixReport> {
  const vmStore = new CurrentGuardVariantMatrixStore(dir);
  const recentBase = Date.now() - 5 * 60_000;
  const signals: VariantMatrixSignal[] = Array.from({ length: 10 }, (_, i) => ({
    sourceSignalId: `sig-${i}`,
    symbol: `SYM${String(i).padStart(3, "0")}USDT`,
    direction: "SHORT" as const,
    entryPrice: 100,
    stopLoss: 103,
    tp1: 96,
    tp2: null,
    tp3: null,
    stopDistanceBps: 300,
    regime: "BEARISH_EXPANSION",
    entryVariant: "base_current_entry",
    openedAt: new Date(recentBase + i * 5_000).toISOString(),
    closedAt: null,
  }));
  mirrorVariantMatrixSignals(signals, vmStore, new Date().toISOString());
  const flexBinance = {
    getKlines: async (
      _s: string,
      _i: string,
      opts: { startTime: number; endTime: number; limit: number },
    ): Promise<KlineTuple[]> => {
      const signalMs = opts.startTime + 300_000;
      return [
        [signalMs - 300_000, "0", "100.2", "99.9", "100", "0", signalMs] as KlineTuple,
        [signalMs, "0", "100.5", "95.5", "96", "0", signalMs + 300_000] as KlineTuple,
        [signalMs + 300_000, "0", "97", "95", "95.5", "0", signalMs + 600_000] as KlineTuple,
      ];
    },
  };
  await resolveVariantMatrixObservations(vmStore, flexBinance);
  return buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
}

function makeLongCandidate(): Candidate {
  const direction: Direction = "LONG";
  const plan = {
    selectedEntryVariant: null,
    calibratedExpectedNetR: 0.2,
    calibrationVerdict: "CALIBRATED_POSITIVE",
    chaseRisk: "LOW",
    routeReasonCodes: [],
    costR: -0.05,
  };
  return {
    rank: 1,
    symbol: "ETHUSDT",
    direction,
    finalDirection: direction,
    currentPrice: 100,
    stopLoss: 97,
    takeProfits: { tp1: 104, tp2: null, tp3: null },
    indicators: { fiveMinute: { latestClose: 100 } },
    sourceConflict: false,
    directionConflict: false,
    trendScore: 75,
    selectedExecutionPlan: plan,
  } as unknown as Candidate;
}

const freshMicro: EntryMicrostructure = {
  distanceFromVwapAtr: 0.4,
  candleExtensionAtr: 0.4,
  breakoutConfirmed: true,
  volumeConfirmed: true,
  candleFresh: true,
  observedAtMs: 0, // stamped per-call below
};

const allowingEdge = {
  lookup: (_r: string | null, d: "LONG" | "SHORT") => (d === "LONG" ? { avgNetR: 0.12, n: 140 } : { avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

// ── Environment plumbing: every real production function this chain touches resolves activation,
// causal collection, and canonical policy off process.env — never a caller-supplied override — so
// the test stamps process.env itself and restores it afterward. ──────────────────────────────────

export interface ChainEnv {
  dirs: string[];
  paperDir: string;
  causalDir: string;
  marketContextDir: string;
  cortexDir: string;
  reviewFile: string;
  NOW: number;
  POLICY_DEPLOYED_AT: string;
  scanBatchId: string;
  env: NodeJS.ProcessEnv;
  previousEnv: Record<string, string | undefined>;
}

let seq = 0;
export function setupChainEnv(): ChainEnv {
  seq += 1;
  const dirs: string[] = [];
  const dir = (prefix: string): string => {
    const d = tmpDir(prefix);
    dirs.push(d);
    return d;
  };
  const NOW = Date.now() + seq * 10_000; // stagger across tests sharing one process clock
  const POLICY_DEPLOYED_AT = new Date(NOW - 24 * 3_600_000).toISOString();
  const env: NodeJS.ProcessEnv = {
    PORT: "3102",
    CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow",
    CAUSAL_EXPERIENCE_COLLECTION_DIR: dir("causal-"),
    END_TO_END_CORRECTNESS_DEPLOYED_AT: POLICY_DEPLOYED_AT,
  };
  const previousEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previousEnv[key] = process.env[key];
    process.env[key] = env[key];
  }
  delete process.env.FOUR_BRAIN_INSTANCE_ID; // must fall back to PORT
  return {
    dirs,
    paperDir: dir("paper-"),
    causalDir: env.CAUSAL_EXPERIENCE_COLLECTION_DIR!,
    marketContextDir: dir("market-context-"),
    cortexDir: dir("cortex-"),
    reviewFile: join(dir("reviews-"), "reviews.json"),
    NOW,
    POLICY_DEPLOYED_AT,
    scanBatchId: `cortex-e2e-batch-${seq}`,
    env,
    previousEnv,
  };
}
export function teardownChainEnv(ctx: ChainEnv): void {
  for (const [key, value] of Object.entries(ctx.previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of ctx.dirs) rmSync(d, { recursive: true, force: true });
}

export const CANONICAL_CORTEX_LANE_ID = CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID; // "CG_MFE_GIVEBACK_LONG"
const PAPER_LANE_ID = "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK"; // the one real, mapped paper lane for this roster id

/** Steps 1-5 of the plan: real scan batch + candidates, real CORTEX tick, real publish, real
 *  allocator report, real admission. Returns the persisted PaperOrder plus everything a later step
 *  needs, all read back from production stores/functions — nothing hand-assembled.
 *
 *  `options.scanBatchId` (optional, additive — every existing call site omits it and gets the exact
 *  original behavior: `ctx.scanBatchId`) lets a caller admit a SECOND, genuinely distinct real
 *  PaperOrder for the SAME candidate/symbol/lane/direction within the same ChainEnv — e.g. to prove
 *  a live-execution pyramid-add/netted scenario. A different scanBatchId is threaded through the
 *  real CORTEX shadow tick + publish + allocator report, which is enough for the pipeline to
 *  produce a genuinely distinct order: paper-execution-router.ts's allocatorDedupeKey is
 *  `alloc:${scanBatchId}:${sourceCandidateId}:${symbol}:${direction}:${laneId}`, so two calls under
 *  two different scanBatchIds are never suppressed as duplicates of each other, each getting its own
 *  `paper-${randomUUID()}` paperOrderId — never a hand-typed/cloned second PaperOrder. */
export async function buildAdmittedOrder(ctx: ChainEnv, options?: { scanBatchId?: string }): Promise<{
  store: PaperExecutionRouterStore;
  order: PaperOrder;
  opportunity: PaperOpportunity;
  publicationResult: ReturnType<typeof publishCortexDecisionSnapshotsForScan>;
}> {
  const scanBatchId = options?.scanBatchId ?? ctx.scanBatchId;
  const vmReport = await buildVmReport(ctx.paperDir);
  const scanFinishedAt = new Date(ctx.NOW - 30_000).toISOString();
  const admissionNow = new Date(ctx.NOW).toISOString();

  // Step 2: real CORTEX context + real shadow tick, scoped to the exact scan batch.
  const cortexContext = assembleCortexContext(
    {
      regimeFamily: "BULLISH_EXPANSION",
      axisScore: 0.5,
      axisSlopePerHour: 0.02,
      allowLong: true,
      allowShort: true,
      portfolioDrawdownPct: 0,
      killBudgetUtilization: 0,
      killLatched: false,
    },
    [
      {
        laneId: CANONICAL_CORTEX_LANE_ID,
        direction: "LONG",
        edgeMemAvgNetR: 0.1,
        edgeMemN: 40,
        laneNetAvgR: 0.1,
        laneNetAvgN: 40,
        lanePf: 1.2,
        crowdingAlign: 0,
        kronosAgree: null,
        convictionScore: 0.7,
        vetoed: false,
        staticWeightPct: 20,
      },
    ],
  );
  const cortexStore = new CortexBrainStore(join(ctx.cortexDir, "cortex.json"));
  const cortexJournal = new CortexDecisionJournal(join(ctx.cortexDir, "journal.jsonl"));
  const { snapshots } = runCortexShadowTick({
    store: cortexStore,
    journal: cortexJournal,
    context: cortexContext,
    nowIso: new Date(ctx.NOW - 60_000).toISOString(),
    scanBatchId,
    mode: "shadow",
  });
  expect(snapshots.length).toBeGreaterThan(0);

  // Step 3: publish through the now-immutable publisher.
  const publicationResult = publishCortexDecisionSnapshotsForScan(scanBatchId, snapshots);
  expect(publicationResult).toBe("PUBLISHED");

  // Step 4: real paper allocator report, fed the real published snapshots for this exact scan.
  const common: PaperOpportunityAllocatorInputs = {
    candidates: [makeLongCandidate()],
    scanBatchId,
    scanFinishedAt,
    marketRegime: "Bullish expansion",
    routerReport: routerOf("Bullish expansion"),
    now: admissionNow,
    paperStartAt: new Date(ctx.NOW - 3_600_000).toISOString(),
    paperValidationAllowed: false,
    vmReport,
    testnetCollectAllLanes: true,
    cortexDecisionSnapshots: cortexDecisionSnapshotsForScan(scanBatchId),
  };
  const report = buildPaperOpportunityAllocatorReport(common);
  const opportunity = report.selectedOpportunities.find(
    (o) => o.laneId === PAPER_LANE_ID && o.direction === "LONG" && o.canonicalCortexLaneId === CANONICAL_CORTEX_LANE_ID,
  );
  expect(opportunity).toBeDefined();
  expect(opportunity!.cortexDecisionSnapshot).not.toBeNull();
  expect(opportunity!.cortexDecisionSnapshot!.scanBatchId).toBe(scanBatchId);

  // Step 5: real admission.
  const store = new PaperExecutionRouterStore(ctx.paperDir);
  store.ensurePaperStartAt(new Date(ctx.NOW - 3_600_000).toISOString());
  const result = admitPaperOpportunities({
    store,
    opportunities: [opportunity!],
    routerReport: routerOf("Bullish expansion"),
    gateReport: emptyGate(),
    now: admissionNow,
  });
  expect(result.admitted).toBe(1);
  // Scoped by scanBatchId too (not just lane+direction) — with `options.scanBatchId` supplied, the
  // SAME store can already hold an earlier call's order under the same lane/direction, and `.find()`
  // must resolve to the order THIS call just admitted, never whichever one happens to be first.
  const order = store.all.find((o) => o.selectedLaneId === PAPER_LANE_ID && o.direction === "LONG" && o.scanBatchId === scanBatchId);
  expect(order).toBeDefined();
  expect(order!.causalIdentity).not.toBeNull();
  expect(order!.causalIdentity!.canonicalCortexLaneId).toBe(CANONICAL_CORTEX_LANE_ID);
  expect(order!.cortexDecisionSnapshot).not.toBeNull();

  return { store, order: order!, opportunity: opportunity!, publicationResult };
}

/** Step 6: real ownership index + real allocation bridge + a real Four-Brain deps object sourced
 *  directly off the admitted PaperOrder (never a hand-built candidate id), run through the real
 *  Four-Brain gather + shadow tick. Returns the captured ExecutiveDecision + candidateId exactly as
 *  app.ts's onExecutiveDecision receives them. */
export function runFourBrainTickForOrder(
  ctx: ChainEnv,
  store: PaperExecutionRouterStore,
  order: PaperOrder,
): {
  executive: ExecutiveDecision;
  candidateId: string | null;
  marketContextStore: MarketContextSnapshotStore;
  /** The exact per-tick feature snapshot the brains consumed this cycle — real, derived straight off
   *  `deps`, never a fabricated identity field. Mirrors app.ts's own brainFeatureSnapshot handoff
   *  (buildFourBrainJournalContext(lastFourBrainGatherBase, ...)) at a scope this test can build
   *  without importing app.ts's own process-startup module. */
  featureSnapshot: Record<string, unknown>;
} {
  _resetFourBrainSingleFlightForTests();
  const ownershipIndex = buildPaperOrderOwnershipIndex(store.all);
  const marketContextStore = new MarketContextSnapshotStore(ctx.marketContextDir);
  const tickNowMs = ctx.NOW + 5_000;
  const marketContext = marketContextStore.capture({
    instanceId: "3102",
    asOfMs: tickNowMs,
    sourceCutoffMs: tickNowMs - 1_000,
    decisionPipelinePolicyVersion: DECISION_PIPELINE_POLICY_VERSION,
  });
  expect(marketContext).not.toBeNull();

  const openedAtMs = Date.parse(order.openedAt);
  const deps: FourBrainBindingDeps = {
    instanceId: "3102",
    nowMs: tickNowMs,
    axisScore: 0.55,
    axisAtMs: tickNowMs - 2 * 60_000,
    axisSlopePerHour: 0.02,
    btcAtrPercentile: 40,
    atrAtMs: tickNowMs - 8 * 60_000,
    advancersPct: 0.68,
    breadthAtMs: tickNowMs - 2 * 60_000,
    sentiment: null,
    sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: allowingEdge,
    edgeMemoryUpdatedAtMs: tickNowMs - 5 * 60_000,
    controllerCapturedAtMs: tickNowMs - 2 * 60_000,
    controllerBias: "LONG",
    convictionScore: 0.72,
    allowsLong: true,
    allowsShort: true,
    bestLaneReportForDirection: (d) =>
      d === "LONG" ? { netAvgR: 0.09, resolvedCount: 80, lastCycleAt: new Date(tickNowMs - 4 * 60_000).toISOString() } : null,
    crowdAlignLong: 0.2,
    crowdAtMs: tickNowMs - 3 * 60_000,
    kronosAgree: null,
    kronosAtMs: null,
    // The real, production-sourced open signal: every field read verbatim off the admitted order,
    // exactly as app.ts's collectFourBrainOpenSignals() does for a PAPER_ORDER_OWNED row.
    openSignals: [
      {
        laneId: order.selectedLaneId,
        symbol: order.symbol,
        direction: order.direction,
        observationId: order.sourceObservationId,
        openedAtMs,
        entryPrice: order.entryPrice,
        stopPrice: order.stopLoss,
        sourceKind: "PAPER_ORDER_OWNED",
      },
    ],
    maxSignalAgeMs: 50 * 60_000,
    crowdingStateForSymbol: () => "NEUTRAL",
    entryMicrostructure: () => ({ ...freshMicro, observedAtMs: tickNowMs - 60_000 }),
    openPositions: [],
    markPriceForSymbol: () => ({ price: order.entryPrice + 1, atMs: tickNowMs - 30_000 }),
    // Real allocation bridge, built off the real per-tick ownership index — exactly app.ts's
    // allocationContextForLane closure, including its BRIDGED-only unwrap (see cortex-paper-
    // allocation-bridge.ts's CortexPaperBridgeResult: OWNERSHIP_MISSING/OWNERSHIP_AMBIGUOUS carry
    // no context at all, so a non-BRIDGED result falls back to `base` exactly as app.ts does).
    allocationContextForLane: (laneId, candidate) => {
      const base = { source: "STATIC_BASELINE" as const, snapshotId: null, staticWeightPct: 20, evaluatedWeightPct: 20, appliedWeightPct: 20, beta: 0, capturedAtMs: null, policyVersion: "authority-contract/1" };
      const result = allocationContextWithExactCortexPaperBridge({ base, candidate, laneId, ownershipIndex });
      return result.status === "BRIDGED" ? result.context : base;
    },
    marketContext: marketContext!,
    laneEligibleIncumbent: () => true,
    killLatched: false,
    killReason: null,
  };

  let captured: { executive: ExecutiveDecision; candidateId: string | null } | null = null;
  const result = runFourBrainShadowTick({
    mode: "shadow",
    nowMs: tickNowMs,
    gather: () => assembleFourBrainTick(buildFourBrainGatherInput(deps)),
    journalAppend: () => {},
    onExecutiveDecision: (executive, identity) => {
      if (executive.entry?.side === order.direction && executive.symbolOrBasketId === order.symbol) {
        captured = { executive, candidateId: identity.signalId };
      }
    },
    tickId: `e2e:${ctx.scanBatchId}`,
  });
  expect(result.ran).toBe(true);
  expect(captured).not.toBeNull();
  const featureSnapshot: Record<string, unknown> = {
    instanceId: deps.instanceId,
    nowMs: deps.nowMs,
    regimeRaw: deps.regimeRaw,
    axisScore: deps.axisScore,
    convictionScore: deps.convictionScore,
    openSignals: deps.openSignals,
  };
  return { ...(captured as { executive: ExecutiveDecision; candidateId: string | null }), marketContextStore, featureSnapshot };
}

/** Step 8: production execution-intent/position links via the real runtime helper, resolved to a
 *  real Tier-1 outcome — never a hand-built ExecutiveReviewOutcome and never a paper OUTCOME_RESOLUTION. */
function resolveRealTier1(
  ctx: ChainEnv,
  reviewStore: ExecutiveReviewStore,
  order: PaperOrder,
  overrides: Partial<LiveIntent> = {},
): { summary: ReturnType<typeof resolveExecutiveReviewPositions>; nowMs: number } {
  const link = order.executiveReviewLink!;
  const createdAtMs = ctx.NOW + 10_000;
  const entryFilledAtMs = ctx.NOW + 15_000;
  const closedAtMs = ctx.NOW + 20 * 60_000;
  const settlementResolvedAtMs = closedAtMs + 60_000;
  const entryOrderId = "e2e-entry-order-1";
  const exitOrderId = "e2e-exit-order-1";
  // Fully-typed LiveIntent literal — every field the interface requires is present with a
  // realistic value, so this never needs `as unknown as LiveIntent` to satisfy the compiler.
  const intent: LiveIntent = {
    paperOrderId: order.paperOrderId,
    executionIntentId: "e2e-intent-1",
    positionId: "e2e-position-1",
    symbol: order.symbol,
    direction: order.direction,
    state: "CLOSED",
    qty: 1,
    tp1Qty: 1,
    plannedEntryPrice: order.entryPrice,
    stopLossPrice: order.stopLoss,
    tp1Price: order.takeProfitLevels[0] ?? order.entryPrice,
    filledEntryPrice: order.entryPrice,
    entryOrderId,
    stopOrderId: "e2e-stop-order-1",
    tp1OrderId: "e2e-tp1-order-1",
    beStopOrderId: null,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(closedAtMs).toISOString(),
    closedAt: new Date(closedAtMs).toISOString(),
    closeReason: "TP1_FULL",
    lastError: null,
    originalRiskUsd: 100,
    realizedPnlUsd: 25,
    feesUsd: 5,
    feeSource: "EXCHANGE",
    settlementFetchComplete: true,
    requiredOrderIds: [entryOrderId, exitOrderId],
    matchedRequiredOrderIds: [entryOrderId, exitOrderId],
    missingRequiredOrderIds: [],
    entryFilledAt: new Date(entryFilledAtMs).toISOString(),
    settlementResolvedAt: new Date(settlementResolvedAtMs).toISOString(),
    confirmedEntryFills: [
      {
        orderId: entryOrderId,
        tradeId: "e2e-trade-1",
        symbol: order.symbol,
        role: "ENTRY",
        price: order.entryPrice,
        qty: 1,
        commission: 5,
        commissionAsset: "USDT",
        realizedPnl: 0,
        time: entryFilledAtMs,
        maker: false,
      },
    ],
    executiveReviewLink: link,
    sourcePaperOrders: [{ paperOrderId: order.paperOrderId, laneId: order.selectedLaneId, qty: 1, executiveReviewLink: link }],
    ...overrides,
  };
  const nowMs = closedAtMs + 20 * 60_000; // well past the completed-candle boundary
  const summary = resolveExecutiveReviewPositions(reviewStore, [intent], nowMs);
  return { summary, nowMs };
}

export const policyFor = (ctx: ChainEnv): CanonicalPolicyContext & { instanceId: "3102"; fourBrainPolicyVersion: string } => ({
  instanceId: "3102",
  decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
  executionPolicyVersion: EXECUTION_POLICY_VERSION,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  evidenceEra: CURRENT_EVIDENCE_ERA,
  fourBrainPolicyVersion: EXECUTIVE_SCHEMA_VERSION,
  policyDeploymentAt: ctx.POLICY_DEPLOYED_AT,
});

describe("CORTEX <-> Four-Brain production causal chain (e2e, real functions only)", () => {
  let ctx: ChainEnv;

  beforeEach(() => {
    ctx = setupChainEnv();
    _resetCortexDecisionSnapshotsForTests();
    _resetCortexProductionChainDiagnosticsForTests();
  });
  afterEach(() => {
    teardownChainEnv(ctx);
  });

  it("carries one candidate from a real scan batch through CORTEX, the paper allocator, admission, Four-Brain, Executive Review, and into exactly one learner example", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);

    // Step 6/7: real Four-Brain tick sourced off the real PaperOrder, real allocation bridge.
    const { executive, candidateId, featureSnapshot } = runFourBrainTickForOrder(ctx, store, order);
    expect(candidateId).toBe(order.sourceObservationId);
    expect(executive.candidateStatus).toBe("VALID");
    expect(executive.entry?.action).toBe("ENTER_NOW");
    expect(executive.allocationContext.cortexAllocationSnapshotId).toBe(order.causalIdentity!.allocationSnapshotId);

    // Step 7: real attach.
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const attachResult = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set(),
      env: ctx.env,
      brainFeatureSnapshot: featureSnapshot,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(attachResult).toBe("ATTACHED");
    const review = reviewStore.get().reviews[0]!;
    expect(review.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(review.canonicalCortexLaneId).toBe(CANONICAL_CORTEX_LANE_ID);
    expect(review.allocationSnapshotId).toBe(order.causalIdentity!.allocationSnapshotId);

    const linkedOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    expect(linkedOrder.executiveReviewLink).not.toBeNull();

    // Step 8: real position/outcome resolution via the production runtime helper — never a hand-built
    // Tier-1 row, never a paper OUTCOME_RESOLUTION.
    const { summary } = resolveRealTier1(ctx, reviewStore, linkedOrder);
    expect(summary.linked).toBe(1);
    expect(reviewStore.get().tier1).toHaveLength(1);
    const tier1 = reviewStore.get().tier1[0]!;
    expect(tier1.netR).toBeCloseTo(0.25, 9); // realizedPnlUsd(25)/originalRiskUsd(100)
    expect(tier1.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(cortexProductionChainDiagnostics().CORTEX_TIER1_RESOLVED).toBeGreaterThanOrEqual(1);

    // Step 9: real forward-causal events (DECISION_SNAPSHOT + OPPORTUNITY_OPEN only — no OUTCOME_RESOLUTION
    // was ever emitted for this order) + the real learner boundary.
    const journalPath = forwardCausalJournalPath(ctx.env)!;
    const forwardEvents: ForwardEvent[] = readForwardCausalEvents(journalPath);
    expect(forwardEvents.some((e) => e.eventType === "DECISION_SNAPSHOT")).toBe(true);
    expect(forwardEvents.some((e) => e.eventType === "OPPORTUNITY_OPEN")).toBe(true);
    expect(forwardEvents.some((e) => e.eventType === "OUTCOME_RESOLUTION")).toBe(false);

    const dataset = buildCortexShadowTrainingDataset({
      outcomes: [tier1],
      forwardEvents,
      policy: policyFor(ctx),
      nowMs: ctx.NOW + 24 * 3_600_000,
    });
    expect(dataset.examples).toHaveLength(1);
    const example = dataset.examples[0]!;
    expect(example.decisionId).toBe(order.causalIdentity!.cortexDecisionId);
    expect(example.opportunityId).toBe(order.causalIdentity!.opportunityId);
    expect(example.canonicalCortexLaneId).toBe(CANONICAL_CORTEX_LANE_ID);
    expect(example.netR).toBeCloseTo(0.25, 9);
    expect(cortexProductionChainDiagnostics().CORTEX_LEARNER_ELIGIBLE).toBeGreaterThanOrEqual(1);
  });

  // ── Negative cases: each must fail closed with an explicit rejection, never silently degrade. ──

  it("[negative] a legacy VARIANT_MATRIX_OBSERVATION order is found by ownership but structurally carries no CORTEX link", () => {
    const dir = tmpDir("legacy-variant-");
    try {
      const store = new PaperExecutionRouterStore(dir);
      const now = new Date(ctx.NOW).toISOString();
      // A structurally non-attachable Path-A order: real ownership triple, but no scanBatchId/CORTEX
      // snapshot at all — exactly what _buildBaseOrder produces (scanBatchId hardcoded null).
      store.add({
        paperOrderId: "legacy-1",
        sourceType: "VARIANT_MATRIX_OBSERVATION",
        sourceObservationId: "legacy-observation-1",
        sourceSignalId: "legacy-observation-1",
        dedupeKey: "legacy-observation-1:LANE",
        createdAt: now,
        updatedAt: now,
        openedAt: now,
        firstSeenAt: now,
        symbol: "BTCUSDT",
        direction: "LONG",
        regime: "BULLISH_EXPANSION",
        controllerMode: "LONG_ONLY",
        selectedLaneId: "LANE",
        routerPermission: "SHADOW_ONLY",
        entryPrice: 100,
        stopLoss: 95,
        takeProfitLevels: [110],
        plannedStopDistanceBps: 500,
        riskPctOfEquity: 1,
        paperEquity: 2_000,
        plannedRiskAmount: 20,
        plannedPositionNotional: 400,
        plannedRiskR: 1,
        oosUnconfirmed: true,
        infraNotReady: false,
        paperRiskLabel: "EXPERIMENTAL",
        operationalSafetyStatus: "OK",
        diagnosticLabel: null,
        paperStatus: "CREATED",
        grossR: null,
        costR: null,
        netR: null,
        netPnlAmount: null,
        closeReason: null,
        decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
        executionPolicyVersion: EXECUTION_POLICY_VERSION,
        evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        evidenceEra: CURRENT_EVIDENCE_ERA,
        scanBatchId: null,
        canonicalCortexLaneId: null,
        cortexDecisionSnapshot: null,
        causalIdentity: {
          lineageSchemaVersion: "causal-lineage-1",
          decisionId: "causal-decision-legacy-1",
          opportunityId: "causal-opportunity-legacy-1",
          outcomeId: null,
          instanceId: "3102",
          laneId: "LANE",
          symbolOrBasketId: "BTCUSDT",
          direction: "LONG",
          featureSchemaVersion: "causal-paper-opportunity/1",
          decisionRuleVersion: "paper-opportunity-admission/1",
          attributionRuleVersion: "direct-paper-order-link/1",
          cortexDecisionId: null,
          allocationSnapshotId: null,
          canonicalCortexLaneId: null,
          cortexFeatureSchemaVersion: null,
          decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
          executionPolicyVersion: EXECUTION_POLICY_VERSION,
          evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
          evidenceEra: CURRENT_EVIDENCE_ERA,
          policyDeploymentAt: ctx.POLICY_DEPLOYED_AT,
        },
        reportOnly: true,
        paperOnly: true,
      } as PaperOrder);
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const executive: ExecutiveDecision = {
        schemaVersion: EXECUTIVE_SCHEMA_VERSION,
        decisionId: "executive-legacy-1",
        asOfMs: ctx.NOW,
        marketState: {
          schemaVersion: "market-state/1", decisionId: "market-1", asOfMs: ctx.NOW, validUntilMs: ctx.NOW + 1_000,
          family: "BULLISH", bias: "BULLISH", transitionRisk: 0.1, confidence: 0.8, reasons: [],
          sourceStatuses: { trend: "FRESH", volatility: "FRESH", breadth: "FRESH", liquidity: "FRESH", safety: "FRESH" },
        } as never,
        direction: null,
        entry: { schemaVersion: "entry/1", decisionId: "entry-1", asOfMs: ctx.NOW, side: "LONG", action: "ENTER_NOW", score: 0.8, reasons: [], sourceStatuses: {} } as never,
        exit: null,
        allocationContext: { source: "STATIC_BASELINE", snapshotId: null, cortexAllocationSnapshotId: null, staticWeightPct: 20, evaluatedWeightPct: 20, appliedWeightPct: 20, beta: 0, capturedAtMs: null, policyVersion: "authority-contract/1" },
        marketContext: { marketContextSnapshotId: "market-context-legacy-1", asOfMs: ctx.NOW, sourceCutoffMs: ctx.NOW - 1_000, decisionPipelinePolicyVersion: CURRENT_DECISION_POLICY_VERSION },
        laneId: "LANE",
        symbolOrBasketId: "BTCUSDT",
        candidateStatus: "VALID",
        disagreements: [],
        reasons: [],
        reportOnly: true,
        advisoryOnly: true,
      } as unknown as ExecutiveDecision;
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore: store,
        executive,
        candidateId: "legacy-observation-1",
        executingPaperOrderIds: new Set(),
        env: ctx.env,
        paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
      });
      expect(result).toBe("CORTEX_ALLOCATION_LINK_MISSING");
      expect(cortexProductionChainDiagnostics().CORTEX_EXECUTIVE_ATTACHMENT_REJECTED).toBeGreaterThanOrEqual(1);
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[negative] bare (unprefixed) lane id on the executive candidate misses the ownership index — NO_EXACT_CANDIDATE", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const bareLaneExecutive: ExecutiveDecision = { ...executive, laneId: "CG_MFE_GIVEBACK" }; // bare variant id, not order.selectedLaneId
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive: bareLaneExecutive,
      candidateId,
      executingPaperOrderIds: new Set(),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(result).toBe("NO_EXACT_CANDIDATE");
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] wrong candidate ownership id (matches no order's sourceObservationId) — NO_EXACT_CANDIDATE", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    const { executive } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId: "an-observation-id-that-owns-nothing",
      executingPaperOrderIds: new Set(),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(result).toBe("NO_EXACT_CANDIDATE");
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] wrong PaperOrder — duplicate admission sharing the exact ownership key fails closed as AMBIGUOUS_PAPER_OWNERSHIP", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    // A genuine duplicate-admission bug: the SAME real, causally-identified order re-admitted under a
    // different paperOrderId — never a fabricated identity, just the real one's ownership triple
    // colliding, which is exactly the ambiguity class this check exists for.
    store.add({ ...order, paperOrderId: `${order.paperOrderId}-dup` });
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive,
      candidateId,
      executingPaperOrderIds: new Set(),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(result).toBe("AMBIGUOUS_PAPER_OWNERSHIP");
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBeGreaterThanOrEqual(1);
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] wrong paper lane — a paperLaneId absent from PAPER_CORTEX_LANE_MAPPINGS never carries a CORTEX link", async () => {
    const vmReport = await buildVmReport(ctx.paperDir);
    const scanFinishedAt = new Date(ctx.NOW - 30_000).toISOString();
    const admissionNow = new Date(ctx.NOW).toISOString();
    const common: PaperOpportunityAllocatorInputs = {
      candidates: [makeLongCandidate()],
      scanBatchId: ctx.scanBatchId,
      scanFinishedAt,
      marketRegime: "Bullish expansion",
      routerReport: routerOf("Bullish expansion"),
      now: admissionNow,
      paperStartAt: new Date(ctx.NOW - 3_600_000).toISOString(),
      paperValidationAllowed: false,
      vmReport,
      testnetCollectAllLanes: true,
    };
    const report = buildPaperOpportunityAllocatorReport(common);
    // CG_WIDE_STOP_TP_WIDE has no roster entry of its own (the exact historical bug class) — every
    // opportunity built off it must resolve canonicalCortexLaneId to null.
    const unmapped = report.selectedOpportunities.find((o) => o.laneId === "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(unmapped).toBeDefined();
    expect(unmapped!.canonicalCortexLaneId).toBeNull();
    expect(unmapped!.cortexDecisionSnapshot).toBeNull();
    expect(report.cortexLinkageDiagnostics.CORTEX_PAPER_LANE_UNMAPPED).toBeGreaterThan(0);
  });

  it("[negative] cross-scan-batch reuse — a CORTEX snapshot published for one scan batch never resolves for a genuinely different scan batch's lookup", async () => {
    const vmReport = await buildVmReport(ctx.paperDir);
    const scanFinishedAt = new Date(ctx.NOW - 30_000).toISOString();
    const admissionNow = new Date(ctx.NOW).toISOString();
    const scanBatchX = ctx.scanBatchId; // the batch the snapshot is genuinely published under
    const scanBatchY = `${ctx.scanBatchId}-later-cycle`; // a real, different scan batch used for the lookup

    // Real CORTEX tick + real publish, scoped to scan batch X only — mirrors buildAdmittedOrder's
    // own step 2/3, never a hand-built snapshot.
    const cortexContext = assembleCortexContext(
      { regimeFamily: "BULLISH_EXPANSION", axisScore: 0.5, axisSlopePerHour: 0.02, allowLong: true, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      [{
        laneId: CANONICAL_CORTEX_LANE_ID, direction: "LONG", edgeMemAvgNetR: 0.1, edgeMemN: 40,
        laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null,
        convictionScore: 0.7, vetoed: false, staticWeightPct: 20,
      }],
    );
    const cortexStore = new CortexBrainStore(join(ctx.cortexDir, "cortex.json"));
    const cortexJournal = new CortexDecisionJournal(join(ctx.cortexDir, "journal.jsonl"));
    const { snapshots } = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: cortexContext,
      nowIso: new Date(ctx.NOW - 60_000).toISOString(), scanBatchId: scanBatchX, mode: "shadow",
    });
    expect(publishCortexDecisionSnapshotsForScan(scanBatchX, snapshots)).toBe("PUBLISHED");

    // Real allocator report for the genuinely different scan batch Y, fed the real X-batch
    // publication — exactly the bug class of a caller re-using a stale/prior scan cycle's CORTEX
    // handoff for a new scan cycle. exactCortexDecisionSnapshotForScan's own
    // `snapshot.scanBatchId === input.scanBatchId` guard must refuse this for real, driven through
    // the real production allocator function, not a synthetic assertion.
    const common: PaperOpportunityAllocatorInputs = {
      candidates: [makeLongCandidate()],
      scanBatchId: scanBatchY,
      scanFinishedAt,
      marketRegime: "Bullish expansion",
      routerReport: routerOf("Bullish expansion"),
      now: admissionNow,
      paperStartAt: new Date(ctx.NOW - 3_600_000).toISOString(),
      paperValidationAllowed: false,
      vmReport,
      testnetCollectAllLanes: true,
      cortexDecisionSnapshots: cortexDecisionSnapshotsForScan(scanBatchX),
    };
    const report = buildPaperOpportunityAllocatorReport(common);
    const opportunity = report.selectedOpportunities.find(
      (o) => o.laneId === PAPER_LANE_ID && o.direction === "LONG" && o.canonicalCortexLaneId === CANONICAL_CORTEX_LANE_ID,
    );
    expect(opportunity).toBeDefined();
    // The roster mapping still resolves (it is scan-batch-independent) but the snapshot itself
    // refuses to resolve across the genuine batch mismatch.
    expect(opportunity!.cortexDecisionSnapshot).toBeNull();
    expect(opportunity!.cortexAllocationSnapshotId).toBeNull();
    expect(report.cortexLinkageDiagnostics.CORTEX_SNAPSHOT_SCAN_MISSING).toBeGreaterThan(0);

    // Drive the mismatch through real admission — the resulting order carries a canonical lane id
    // (the roster mapping) but no CORTEX snapshot / allocation id at all.
    const store = new PaperExecutionRouterStore(ctx.paperDir);
    store.ensurePaperStartAt(new Date(ctx.NOW - 3_600_000).toISOString());
    const admitted = admitPaperOpportunities({
      store, opportunities: [opportunity!], routerReport: routerOf("Bullish expansion"), gateReport: emptyGate(), now: admissionNow,
    });
    expect(admitted.admitted).toBe(1);
    const order = store.all.find((o) => o.selectedLaneId === PAPER_LANE_ID && o.direction === "LONG")!;
    expect(order.cortexDecisionSnapshot ?? null).toBeNull();
    expect(order.causalIdentity).not.toBeNull();
    expect(order.causalIdentity!.allocationSnapshotId).toBeNull();

    // Drive it the rest of the way through the real Four-Brain tick + real attach: the executive
    // decision still resolves the paper order by ownership, but with no CORTEX allocation snapshot
    // id to match against, attachExecutiveReviewToExactPaperOrder must fail closed exactly like the
    // structurally link-less legacy case above — never silently treating the roster-resolved
    // canonical lane as proof of a real, same-batch CORTEX allocation link.
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const attachResult = attachExecutiveReviewToExactPaperOrder({
      reviewStore, paperStore: store, executive, candidateId, executingPaperOrderIds: new Set(), env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(attachResult).toBe("CORTEX_ALLOCATION_LINK_MISSING");
    expect(cortexProductionChainDiagnostics().CORTEX_EXECUTIVE_ATTACHMENT_REJECTED).toBeGreaterThanOrEqual(1);
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] wrong canonical CORTEX lane — a mismatched-geometry mapping row never resolves a snapshot", async () => {
    const vmReport = await buildVmReport(ctx.paperDir);
    const scanFinishedAt = new Date(ctx.NOW - 30_000).toISOString();
    const admissionNow = new Date(ctx.NOW).toISOString();
    // Real CORTEX snapshot published under THIS scan batch, but for the wrong roster lane
    // (CG_WIDE_FAST_LONG — the point-5/10 regression fixture's own mismatched lane) rather than the
    // candidate's real canonical lane (CANONICAL_CORTEX_LANE_ID / CG_MFE_GIVEBACK_LONG). Never the
    // correct lane is published for this batch at all.
    const cortexContext = assembleCortexContext(
      { regimeFamily: "BULLISH_EXPANSION", axisScore: 0.5, axisSlopePerHour: 0.02, allowLong: true, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      [{ laneId: "CG_WIDE_FAST_LONG", direction: "LONG", edgeMemAvgNetR: 0.1, edgeMemN: 40, laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null, convictionScore: 0.7, vetoed: false, staticWeightPct: 20 }],
    );
    const cortexStore = new CortexBrainStore(join(ctx.cortexDir, "cortex.json"));
    const cortexJournal = new CortexDecisionJournal(join(ctx.cortexDir, "journal.jsonl"));
    const { snapshots } = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: cortexContext,
      nowIso: new Date(ctx.NOW - 60_000).toISOString(), scanBatchId: ctx.scanBatchId, mode: "shadow",
    });
    expect(publishCortexDecisionSnapshotsForScan(ctx.scanBatchId, snapshots)).toBe("PUBLISHED");

    // Real allocator report for the candidate's real, fixed roster lane (CG_MFE_GIVEBACK ->
    // CANONICAL_CORTEX_LANE_ID) — the same pairing buildAdmittedOrder uses end-to-end elsewhere in
    // this file, so the only variable here is that the published snapshot never carries this lane.
    // exactCortexDecisionSnapshotForScan must refuse the mismatch for real, driven through the real
    // production allocator function.
    const common: PaperOpportunityAllocatorInputs = {
      candidates: [makeLongCandidate()],
      scanBatchId: ctx.scanBatchId,
      scanFinishedAt,
      marketRegime: "Bullish expansion",
      routerReport: routerOf("Bullish expansion"),
      now: admissionNow,
      paperStartAt: new Date(ctx.NOW - 3_600_000).toISOString(),
      paperValidationAllowed: false,
      vmReport,
      testnetCollectAllLanes: true,
      cortexDecisionSnapshots: cortexDecisionSnapshotsForScan(ctx.scanBatchId),
    };
    const report = buildPaperOpportunityAllocatorReport(common);
    const opportunity = report.selectedOpportunities.find(
      (o) => o.laneId === PAPER_LANE_ID && o.direction === "LONG" && o.canonicalCortexLaneId === CANONICAL_CORTEX_LANE_ID,
    );
    expect(opportunity).toBeDefined();
    expect(opportunity!.cortexDecisionSnapshot).toBeNull();
    expect(opportunity!.cortexAllocationSnapshotId).toBeNull();
    expect(report.cortexLinkageDiagnostics.CORTEX_CANONICAL_LANE_MISMATCH).toBeGreaterThan(0);

    // Drive the mismatch through real admission — the resulting order carries the candidate's real
    // canonical lane id but no CORTEX snapshot / allocation id, because the batch never published
    // that lane.
    const store = new PaperExecutionRouterStore(ctx.paperDir);
    store.ensurePaperStartAt(new Date(ctx.NOW - 3_600_000).toISOString());
    const admitted = admitPaperOpportunities({
      store, opportunities: [opportunity!], routerReport: routerOf("Bullish expansion"), gateReport: emptyGate(), now: admissionNow,
    });
    expect(admitted.admitted).toBe(1);
    const order = store.all.find((o) => o.selectedLaneId === PAPER_LANE_ID && o.direction === "LONG")!;
    expect(order.cortexDecisionSnapshot ?? null).toBeNull();
    expect(order.causalIdentity).not.toBeNull();
    expect(order.causalIdentity!.allocationSnapshotId).toBeNull();

    // Drive it the rest of the way through the real Four-Brain tick + real attach: this is the exact
    // point where production actually rejects a wrong canonical lane, not merely where a lookup
    // helper returns null.
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const attachResult = attachExecutiveReviewToExactPaperOrder({
      reviewStore, paperStore: store, executive, candidateId, executingPaperOrderIds: new Set(), env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(attachResult).toBe("CORTEX_ALLOCATION_LINK_MISSING");
    expect(cortexProductionChainDiagnostics().CORTEX_EXECUTIVE_ATTACHMENT_REJECTED).toBeGreaterThanOrEqual(1);
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] wrong allocation id — a mutated cortexAllocationSnapshotId on the executive is refused, never silently accepted", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const tampered: ExecutiveDecision = {
      ...executive,
      allocationContext: { ...executive.allocationContext, cortexAllocationSnapshotId: "a-foreign-allocation-snapshot-id" },
    };
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    const result = attachExecutiveReviewToExactPaperOrder({
      reviewStore,
      paperStore: store,
      executive: tampered,
      candidateId,
      executingPaperOrderIds: new Set(),
      env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    });
    expect(result).toBe("CORTEX_ALLOCATION_LINK_MISSING");
    expect(cortexProductionChainDiagnostics().CORTEX_EXECUTIVE_ATTACHMENT_REJECTED).toBeGreaterThanOrEqual(1);
    expect(reviewStore.get().reviews).toHaveLength(0);
  });

  it("[negative] duplicate candidate ownership — two CREATED orders sharing sourceObservationId+laneId+direction fail closed at the allocation bridge too", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    store.add({ ...order, paperOrderId: `${order.paperOrderId}-dup2` });
    const ownershipIndex = buildPaperOrderOwnershipIndex(store.all);
    const key = paperOrderOwnershipKey(order.sourceObservationId, order.selectedLaneId, order.direction);
    expect(ownershipIndex.get(key)?.length).toBe(2);
    const bridged = allocationContextWithExactCortexPaperBridge({
      base: { source: "STATIC_BASELINE", snapshotId: null, staticWeightPct: 20, evaluatedWeightPct: 20, appliedWeightPct: 20, beta: 0, capturedAtMs: null, policyVersion: "authority-contract/1" },
      candidate: { signalId: order.sourceObservationId, direction: order.direction },
      laneId: order.selectedLaneId,
      ownershipIndex,
    });
    // Explicit, distinct fail-fast result — never a fallthrough "base" guess (point 3).
    expect(bridged.status).toBe("OWNERSHIP_AMBIGUOUS");
    expect((bridged as { context?: unknown }).context).toBeUndefined();
    expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBeGreaterThanOrEqual(1);
  });

  it("[negative] conflicting scan publication — a second, content-different publish for the same scanBatchId is refused downstream", () => {
    const laneObs = (finalPct: number) => [{
      laneId: CANONICAL_CORTEX_LANE_ID, direction: "LONG" as const, edgeMemAvgNetR: 0.1, edgeMemN: 40,
      laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null,
      convictionScore: 0.7, vetoed: false, staticWeightPct: finalPct,
    }];
    const top = { regimeFamily: "BULLISH_EXPANSION", axisScore: 0.5, axisSlopePerHour: 0.02, allowLong: true, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false };
    const cortexStore = new CortexBrainStore(join(ctx.cortexDir, "cortex.json"));
    const cortexJournal = new CortexDecisionJournal(join(ctx.cortexDir, "journal.jsonl"));
    const first = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: assembleCortexContext(top, laneObs(20)),
      nowIso: new Date(ctx.NOW - 60_000).toISOString(), scanBatchId: ctx.scanBatchId, mode: "shadow",
    });
    expect(publishCortexDecisionSnapshotsForScan(ctx.scanBatchId, first.snapshots)).toBe("PUBLISHED");
    const second = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: assembleCortexContext(top, laneObs(45)), // content differs
      nowIso: new Date(ctx.NOW - 50_000).toISOString(), scanBatchId: ctx.scanBatchId, mode: "shadow",
    });
    expect(publishCortexDecisionSnapshotsForScan(ctx.scanBatchId, second.snapshots)).toBe("CONFLICT");
    // Refused downstream: the whole batch is now unusable, not "still serving the first array".
    expect(cortexDecisionSnapshotsForScan(ctx.scanBatchId)).toEqual([]);
    expect(exactCortexDecisionSnapshotForScan({
      scanBatchId: ctx.scanBatchId, canonicalCortexLaneId: CANONICAL_CORTEX_LANE_ID, direction: "LONG",
      snapshots: cortexDecisionSnapshotsForScan(ctx.scanBatchId),
    })).toBeNull();
  });

  it("[negative] wrong execution intent — a position link whose executionIntentId does not match any review link stays pending, never fabricates a Tier-1 row", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    expect(attachExecutiveReviewToExactPaperOrder({
      reviewStore, paperStore: store, executive, candidateId, executingPaperOrderIds: new Set(), env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    })).toBe("ATTACHED");
    const linkedOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    // Real production helper, but the intent carries no executionIntentId/positionId/entryOrderId at
    // all — resolveExecutiveReviewPositions' own positionLink() guard requires all three before an
    // intent is even eligible to be treated as an execution position.
    const { summary } = resolveRealTier1(ctx, reviewStore, linkedOrder, {
      executionIntentId: undefined,
      positionId: undefined,
      entryOrderId: null,
    });
    expect(summary.linked).toBe(0);
    expect(summary.pending).toBeGreaterThan(0);
    expect(reviewStore.get().tier1).toHaveLength(0);
    expect(reviewStore.get().reviews[0]?.state).toBe("PENDING_EXECUTION_LINK");
  });

  it("[negative] wrong position — an intent whose sourcePaperOrders link points at a different review is rejected, not netted into this one's Tier-1", async () => {
    const { store, order } = await buildAdmittedOrder(ctx);
    const { executive, candidateId } = runFourBrainTickForOrder(ctx, store, order);
    const reviewStore = new ExecutiveReviewStore(ctx.reviewFile);
    expect(attachExecutiveReviewToExactPaperOrder({
      reviewStore, paperStore: store, executive, candidateId, executingPaperOrderIds: new Set(), env: ctx.env,
      paperOrderOwnershipIndex: buildPaperOrderOwnershipIndex(store.all),
    })).toBe("ATTACHED");
    const linkedOrder = store.all.find((o) => o.paperOrderId === order.paperOrderId)!;
    const realLink = linkedOrder.executiveReviewLink!;
    const foreignLink = { ...realLink, executiveReviewId: "a-foreign-review-id-that-does-not-exist" };
    const { summary } = resolveRealTier1(ctx, reviewStore, linkedOrder, {
      executiveReviewLink: foreignLink,
      sourcePaperOrders: [{ paperOrderId: linkedOrder.paperOrderId, laneId: linkedOrder.selectedLaneId, qty: 1, executiveReviewLink: foreignLink }],
    });
    // The runtime helper finds a link object (the intent carries one), but no review exists under that
    // foreign id, so store.resolve() reports MISSING_EXECUTIVE_REVIEW_ID and the attempt lands in
    // "pending", never linked, and never fabricates a Tier-1 row for either review.
    expect(summary.examined).toBe(1);
    expect(summary.linked).toBe(0);
    expect(summary.pending).toBeGreaterThan(0);
    expect(reviewStore.get().tier1).toHaveLength(0);
    expect(reviewStore.get().reviews[0]?.state).toBe("PENDING_EXECUTION_LINK");
  });
});

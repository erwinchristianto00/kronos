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
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
} from "@dtc/shared";

import {
  buildPaperOpportunityAllocatorReport,
  type PaperOpportunityAllocatorInputs,
} from "../src/lib/paper-opportunity-allocator.js";
import {
  PaperExecutionRouterStore,
  admitPaperOpportunities,
  type PaperOrder,
} from "../src/lib/paper-execution-router.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "../src/lib/cortex-brain-store.js";
import { assembleCortexContext } from "../src/lib/cortex-brain.js";
import {
  publishCortexDecisionSnapshotsForScan,
  cortexDecisionSnapshotsForScan,
  exactCortexDecisionSnapshotForScan,
  scanBatchTickBinding,
  _resetCortexDecisionSnapshotsForTests,
} from "../src/lib/cortex-decision-snapshot.js";
import { buildPaperOrderOwnershipIndex, paperOrderOwnershipKey } from "../src/lib/paper-order-ownership-index.js";
import { allocationContextWithExactCortexPaperBridge } from "../src/lib/cortex-paper-allocation-bridge.js";
import { attachExecutiveReviewToExactPaperOrder } from "../src/lib/executive-review-admission.js";
import { ExecutiveReviewStore } from "../src/lib/executive-review-store.js";
import { resolveExecutiveReviewPositions } from "../src/lib/executive-review-runtime.js";
import type { LiveIntent } from "../src/lib/live-execution-engine.js";
import { EXECUTIVE_SCHEMA_VERSION, type ExecutiveDecision } from "../src/lib/four-brain-types.js";
import {
  readForwardCausalEvents,
  forwardCausalJournalPath,
  type ForwardEvent,
} from "../src/experience-engine/forward-causal-collection.js";
import { buildCortexShadowTrainingDataset } from "../src/lib/cortex-shadow-refit.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";

// ── Reused, not reinvented: cortex-four-brain-live-execution-e2e.test.ts's own explicit requirement.
// These fixtures used to be defined inline here; see the helpers module's own header for why a plain
// ES import of a *.test.ts file made that unsafe once a second file needed them too. ───────────────
import {
  type ChainEnv,
  setupChainEnv,
  teardownChainEnv,
  tmpDir,
  emptyGate,
  routerOf,
  buildVmReport,
  makeLongCandidate,
  PAPER_LANE_ID,
  CANONICAL_CORTEX_LANE_ID,
  buildAdmittedOrder,
  runFourBrainTickForOrder,
  policyFor,
} from "./helpers/cortex-four-brain-causal-chain-e2e-fixtures.js";

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
          logicalRole: null,
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

  it("[negative] two real periodic ticks with the same scanBatchId — the second runs unbound (scanBatchId: null) rather than skipping", () => {
    // Mirrors app.ts's actual periodic-tick sequence (both cortexShadowTick and
    // cortexStandaloneShadowTick share this exact shape) directly against the real underlying
    // functions — app.ts's own closures are unexported locals and cannot be imported/driven directly.
    // Drives the SAME shared helper app.ts's two call sites use (scanBatchTickBinding in
    // cortex-decision-snapshot.ts) rather than re-deriving the conditional inline here.
    const laneObs = (finalPct: number) => [{
      laneId: CANONICAL_CORTEX_LANE_ID, direction: "LONG" as const, edgeMemAvgNetR: 0.1, edgeMemN: 40,
      laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null,
      convictionScore: 0.7, vetoed: false, staticWeightPct: finalPct,
    }];
    const top = { regimeFamily: "BULLISH_EXPANSION", axisScore: 0.5, axisSlopePerHour: 0.02, allowLong: true, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false };
    const cortexStore = new CortexBrainStore(join(ctx.cortexDir, "cortex.json"));
    const cortexJournal = new CortexDecisionJournal(join(ctx.cortexDir, "journal.jsonl"));

    // Tick 1: scanBatchId not yet published -> real scanBatchId, then attempt publish (unchanged
    // behavior for the not-yet-published case).
    const binding1 = scanBatchTickBinding(ctx.scanBatchId);
    expect(binding1).toEqual({ shouldPublish: true, tickScanBatchId: ctx.scanBatchId });
    const first = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: assembleCortexContext(top, laneObs(20)),
      nowIso: new Date(ctx.NOW - 60_000).toISOString(),
      scanBatchId: binding1.tickScanBatchId, mode: "shadow",
    });
    expect(first.snapshots.every((s) => s.sourceScanBatchId === ctx.scanBatchId)).toBe(true);
    if (binding1.shouldPublish) {
      expect(publishCortexDecisionSnapshotsForScan(binding1.tickScanBatchId, first.snapshots)).toBe("PUBLISHED");
    }

    // Tick 2 (repeat, same scanBatchId — the scan cache has not refreshed, exactly like the real
    // 5-min-tick-vs-7-min-scan-cache cadence): the batch is now already published, so this tick must
    // run UNBOUND (scanBatchId: null), not be silently skipped and not re-tagged with the real id.
    const binding2 = scanBatchTickBinding(ctx.scanBatchId);
    expect(binding2).toEqual({ shouldPublish: false, tickScanBatchId: null });
    const second = runCortexShadowTick({
      store: cortexStore, journal: cortexJournal, context: assembleCortexContext(top, laneObs(20)),
      nowIso: new Date(ctx.NOW - 50_000).toISOString(),
      scanBatchId: binding2.tickScanBatchId, mode: "shadow",
    });
    // Ran unbound, not skipped: the tick still produced real output snapshots...
    expect(second.snapshots.length).toBeGreaterThan(0);
    // ...but stamped with a null sourceScanBatchId, exactly as runCortexShadowTick does when handed
    // scanBatchId: null (cortex-brain-store.ts's only use of deps.scanBatchId).
    expect(second.snapshots.every((s) => s.sourceScanBatchId === null)).toBe(true);
    // No publish attempted for tick 2 (mirrors app.ts's `if (scanBatchBinding.shouldPublish)` gate) —
    // the real batch's stored content is unaffected, still tick 1's.
    expect(binding2.shouldPublish).toBe(false);
    expect(cortexDecisionSnapshotsForScan(ctx.scanBatchId)).toEqual(
      first.snapshots.map((s) => ({ ...s, scanBatchId: ctx.scanBatchId })),
    );
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

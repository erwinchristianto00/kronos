import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
} from "@dtc/shared";

import { attachExecutiveReviewToExactPaperOrder } from "../src/lib/executive-review-admission.js";
import { ExecutiveReviewStore, type ExecutiveReviewExecutionLink } from "../src/lib/executive-review-store.js";
import { PaperExecutionRouterStore, type PaperOrder } from "../src/lib/paper-execution-router.js";
import { buildPaperOrderOwnershipIndex } from "../src/lib/paper-order-ownership-index.js";
import { buildLiveIntentIndexByPaperOrderId } from "../src/lib/live-intent-index.js";
import type { LiveIntent, LiveIntentCausalLineage } from "../src/lib/live-execution-engine.js";
import type { CausalIdentity } from "../src/experience-engine/forward-causal-collection.js";
import type { ExecutiveDecision } from "../src/lib/four-brain-types.js";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
} from "../src/lib/cortex-production-chain-diagnostics.js";

// The shared per-tick ownership index (paper-order-ownership-index.ts), rebuilt fresh off the
// store's CURRENT orders immediately before each attach call below — exactly mirroring the old
// `input.paperStore.all.filter(...)` scan's always-current-state semantics, so every existing
// assertion below still proves identical matching behavior, just reached through the index instead
// of a linear scan. Production instead builds this once per tick (app.ts) and reuses it across the
// whole tick's decisions; per-call rebuilding here is what "always reflects the current store"
// requires when a single test performs several sequential attach calls with store mutations
// between them (e.g. the cross-link test below).
function ownershipIndexFor(store: PaperExecutionRouterStore): ReturnType<typeof buildPaperOrderOwnershipIndex> {
  return buildPaperOrderOwnershipIndex(store.all);
}

// Every fixture order below is created/opened at 1_000ms (1970-01-01T00:00:01.000Z); the
// deployment boundary must be at or before that instant for isCausalIdentityCurrentlyValid's
// decision/open-clock check to accept it.
const POLICY_DEPLOYED_AT = "1970-01-01T00:00:00.000Z";
const shadowEnv = {
  CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow",
  END_TO_END_CORRECTNESS_DEPLOYED_AT: POLICY_DEPLOYED_AT,
} as NodeJS.ProcessEnv;

function causalIdentity(overrides: Partial<CausalIdentity> = {}): CausalIdentity {
  return {
    lineageSchemaVersion: "causal-lineage-1",
    decisionId: "causal-decision-1",
    opportunityId: "opportunity-1",
    outcomeId: null,
    instanceId: "3101",
    laneId: "LANE",
    symbolOrBasketId: "BTCUSDT",
    direction: "LONG",
    featureSchemaVersion: "causal-paper-opportunity/1",
    decisionRuleVersion: "paper-opportunity-admission/1",
    attributionRuleVersion: "direct-paper-order-link/1",
    cortexDecisionId: "cortex-decision-1",
    allocationSnapshotId: "cortex-allocation-1",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    cortexFeatureSchemaVersion: 1,
    decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    evidenceEra: CURRENT_EVIDENCE_ERA,
    policyDeploymentAt: POLICY_DEPLOYED_AT,
    ...overrides,
  };
}

// The immutable lineage subset a real LiveIntent captures at open time (live-execution-engine.ts's
// lineageFromPaperOrder) — matching causalIdentity()'s default fields exactly, so a fixture intent
// built with the default lineage() genuinely lines up with a fixture paper()'s causalIdentity().
function lineage(overrides: Partial<LiveIntentCausalLineage> = {}): LiveIntentCausalLineage {
  return {
    opportunityId: "opportunity-1",
    cortexDecisionId: "cortex-decision-1",
    allocationSnapshotId: "cortex-allocation-1",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    instanceId: "3101",
    policyDeploymentAt: POLICY_DEPLOYED_AT,
    // 6 additional fields (blocker 2), matching paper()'s default field values exactly so a
    // default lineage() and default paper() line up.
    paperOrderId: "paper-1",
    sourceObservationId: "candidate-1", // paper()'s default sourceObservationId
    scanBatchId: "batch-1", // paper()'s default scanBatchId
    paperLaneId: "LANE", // mirrors paper()'s default selectedLaneId
    symbol: "BTCUSDT", // paper()'s default symbol
    direction: "LONG", // paper()'s default direction
    ...overrides,
  };
}

// The ExecutiveReviewExecutionLink deterministically derived by attachExecutiveReviewToExactPaperOrder
// from the default paper()/executive() fixtures — i.e. the SAME link a fresh attach would compute.
// Shared by the partial-write-recovery and idempotent-replay tests below so they don't each hand-roll
// a slightly different (and easy to typo) copy.
function defaultReviewLink(overrides: Partial<ExecutiveReviewExecutionLink> = {}): ExecutiveReviewExecutionLink {
  return {
    executiveReviewId: "executive-review:executive-1:opportunity-1",
    candidateId: "candidate-1",
    opportunityId: "opportunity-1",
    laneId: "LANE",
    marketContextSnapshotId: "market-context-1",
    allocationSnapshotId: "cortex-allocation-1",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    direction: "LONG",
    marketState: "BULLISH",
    evidenceEra: CURRENT_EVIDENCE_ERA,
    decisionPipelinePolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    fourBrainPolicyVersion: "executive/2",
    ...overrides,
  };
}

// Minimal but type-complete LiveIntent fixture — every required (non-optional) LiveIntent field is
// supplied, exactly like paper()'s equivalent role for PaperOrder below.
function liveIntent(overrides: Partial<LiveIntent> = {}): LiveIntent {
  const now = new Date(1_000).toISOString();
  return {
    paperOrderId: "paper-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    state: "OPEN",
    qty: 1,
    tp1Qty: 0.5,
    plannedEntryPrice: 100,
    stopLossPrice: 95,
    tp1Price: 110,
    filledEntryPrice: 100,
    entryOrderId: "entry-1",
    stopOrderId: "stop-1",
    tp1OrderId: "tp1-1",
    beStopOrderId: null,
    realizedPnlUsd: null,
    feesUsd: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
    lastError: null,
    causalLineage: lineage(),
    ...overrides,
  };
}

function paper(overrides: Partial<PaperOrder> = {}): PaperOrder {
  const now = new Date(1_000).toISOString();
  return {
    paperOrderId: "paper-1",
    sourceObservationId: "candidate-1",
    sourceSignalId: "candidate-1",
    dedupeKey: "candidate-1:LANE",
    createdAt: now,
    updatedAt: now,
    openedAt: now,
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
    scanBatchId: "batch-1",
    canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
    cortexDecisionSnapshot: {
      decisionId: "cortex-decision-1", allocationSnapshotId: "cortex-allocation-1", atMs: 900,
      scanBatchId: "batch-1", sourceScanBatchId: "batch-1", laneId: "CG_WIDE_FAST_LONG", direction: "LONG", featureSchemaVersion: 1,
      featureVector: [1], regimeFamily: "BULLISH", eligible: true, finalPct: 0, evalFinalPct: 0,
    },
    causalIdentity: causalIdentity(),
    reportOnly: true,
    paperOnly: true,
    ...overrides,
  };
}

function executive(overrides: Partial<ExecutiveDecision> = {}): ExecutiveDecision {
  return {
    schemaVersion: "executive/2",
    decisionId: "executive-1",
    asOfMs: 1_000,
    marketState: {
      schemaVersion: "market-state/1",
      decisionId: "market-1",
      asOfMs: 1_000,
      validUntilMs: 2_000,
      family: "BULLISH",
      bias: "BULLISH",
      transitionRisk: 0.1,
      confidence: 0.8,
      reasons: [],
      sourceStatuses: { trend: "FRESH", volatility: "FRESH", breadth: "FRESH", liquidity: "FRESH", safety: "FRESH" },
    },
    direction: null,
    entry: { schemaVersion: "entry/1", decisionId: "entry-1", asOfMs: 1_000, side: "LONG", action: "ENTER_NOW", score: 0.8, reasons: [], sourceStatuses: { signal: "FRESH", candle: "FRESH", orderflow: "FRESH" } },
    exit: null,
    allocationContext: { source: "STATIC_BASELINE", snapshotId: null, cortexAllocationSnapshotId: "cortex-allocation-1", staticWeightPct: 100, evaluatedWeightPct: 100, appliedWeightPct: 100, beta: 0, capturedAtMs: null, policyVersion: "authority-contract/1" },
    marketContext: { marketContextSnapshotId: "market-context-1", asOfMs: 1_000, sourceCutoffMs: 900, decisionPipelinePolicyVersion: CURRENT_DECISION_POLICY_VERSION },
    laneId: "LANE",
    symbolOrBasketId: "BTCUSDT",
    candidateStatus: "VALID",
    disagreements: [],
    reasons: [],
    reportOnly: true,
    advisoryOnly: true,
    ...overrides,
  };
}

describe("Executive Review admission", () => {
  it("creates the review before execution and propagates only the exact candidate ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ATTACHED");
      expect(reviewStore.get().reviews).toHaveLength(1);
      expect(paperStore.all[0]?.executiveReviewLink).toMatchObject({
        candidateId: "candidate-1",
        opportunityId: "opportunity-1",
        marketContextSnapshotId: "market-context-1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not cross-link same-symbol records, executing orders, or unstamped legacy evidence", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      paperStore.add(paper({ paperOrderId: "paper-2", sourceObservationId: "candidate-2", sourceSignalId: "candidate-2", dedupeKey: "candidate-2:LANE" }));
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-other", executingPaperOrderIds: new Set(), env: shadowEnv, paperOrderOwnershipIndex: ownershipIndexFor(paperStore) })).toBe("NO_EXACT_CANDIDATE");
      // Point 11: report-only — a 0-match ownership lookup is recorded distinctly from the ambiguous
      // case, never influencing the NO_EXACT_CANDIDATE result itself.
      expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(1);
      expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(0);
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-1", executingPaperOrderIds: new Set(["paper-1"]), env: shadowEnv, paperOrderOwnershipIndex: ownershipIndexFor(paperStore) })).toBe("ORDER_ALREADY_EXECUTING");
      // Genuinely unstamped legacy evidence: never received a causal identity at all.
      paperStore.update("paper-1", { causalIdentity: null });
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-1", executingPaperOrderIds: new Set(), env: shadowEnv, paperOrderOwnershipIndex: ownershipIndexFor(paperStore) })).toBe("POST_FIX_POLICY_MISSING");
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with AMBIGUOUS_PAPER_OWNERSHIP, and records the ownership-index-ambiguous diagnostic, when two admissible orders share the exact same ownership key", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-ambiguous-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      // Duplicate admission: same sourceObservationId + selectedLaneId + direction, both still
      // actionable (CREATED) — a real, if unwanted, ambiguity in the persisted order book.
      paperStore.add(paper());
      paperStore.add(paper({ paperOrderId: "paper-1-duplicate" }));
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-1", executingPaperOrderIds: new Set(), env: shadowEnv, paperOrderOwnershipIndex: ownershipIndexFor(paperStore) })).toBe("AMBIGUOUS_PAPER_OWNERSHIP");
      expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS).toBe(1);
      expect(cortexProductionChainDiagnostics().CORTEX_CANDIDATE_OWNERSHIP_MISSING).toBe(0);
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a present causal identity that no longer matches the current policy context", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper({ causalIdentity: causalIdentity({ executionPolicyVersion: "execution-resolver-correctness-v1" }) }));
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("STALE_CAUSAL_IDENTITY");
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deep-clones the supplied brainFeatureSnapshot so a later mutation of the caller's object cannot alter what was persisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const snapshot: Record<string, unknown> = { trendScore: 0.4, nested: { axisScore: 1 } };
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        brainFeatureSnapshot: snapshot,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ATTACHED");
      // Mutate the caller's own object AFTER admission — the persisted copy must be unaffected.
      snapshot.trendScore = 999;
      (snapshot.nested as Record<string, unknown>).axisScore = 999;
      expect(reviewStore.get().reviews[0]?.brainFeatureSnapshot).toEqual({ trendScore: 0.4, nested: { axisScore: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a null brainFeatureSnapshot (never fabricated) when the caller doesn't supply one", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ATTACHED");
      expect(reviewStore.get().reviews[0]?.brainFeatureSnapshot ?? null).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("namespaces per-brain sourceStatuses so a shared feature-source key name never collides across brains", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        // marketState and entry both use the key "candle" with DIFFERENT freshness — a flat merge
        // would silently let one overwrite the other.
        executive: executive({
          marketState: { schemaVersion: "market-state/1", decisionId: "market-1", asOfMs: 1_000, validUntilMs: 2_000, family: "BULLISH", bias: "BULLISH", transitionRisk: 0.1, confidence: 0.8, reasons: [], sourceStatuses: { candle: "STALE" } },
          entry: { schemaVersion: "entry/1", decisionId: "entry-1", asOfMs: 1_000, side: "LONG", action: "ENTER_NOW", score: 0.8, reasons: [], sourceStatuses: { candle: "FRESH" } },
        }),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ATTACHED");
      const stamped = reviewStore.get().reviews[0]?.sourceStatuses;
      expect(stamped?.marketState?.candle).toBe("STALE");
      expect(stamped?.entry?.candle).toBe("FRESH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // GAP A: prove the lookup now goes through the shared O(1) ownership index instead of a fresh
  // linear `.filter(...)` scan over `paperStore.all`, and that the result is identical either way
  // once the index is actually given the matching data.
  it("resolves the exact candidate strictly through the supplied ownership index, never by independently scanning paperStore.all", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-index-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));

      // Deliberately built from an EMPTY order list, not from paperStore.all — paperStore itself
      // still holds the exact matching order (paper-1 / candidate-1 / LANE / LONG / CREATED). If
      // the function still ran its own linear scan over `input.paperStore.all` (the pre-fix
      // behavior), this call would return ATTACHED regardless of what index is supplied. Getting
      // NO_EXACT_CANDIDATE here instead proves the lookup is resolved strictly through
      // `paperOrderOwnershipIndex`, not re-derived from the store.
      const staleEmptyIndex = buildPaperOrderOwnershipIndex([]);
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: staleEmptyIndex,
      })).toBe("NO_EXACT_CANDIDATE");
      expect(reviewStore.get().reviews).toHaveLength(0);

      // Same store, same candidate — now looked up through the correct index built off the
      // store's current orders (buildPaperOrderOwnershipIndex(paperStore.all), THE per-tick
      // contract app.ts follows). Matching behavior is unchanged from the pre-fix scan: it still
      // attaches exactly once the ownership triple is actually resolvable.
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ATTACHED");
      expect(reviewStore.get().reviews).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trusts the supplied index's own order data rather than re-deriving the candidate from paperStore.all", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-index2-"));
    try {
      // Deliberately empty — nothing ever added via paperStore.add(...). The old `.filter(...)`
      // scan over `input.paperStore.all` would have found zero orders here no matter what.
      const paperStore = new PaperExecutionRouterStore(dir);
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const externallyBuiltIndex = buildPaperOrderOwnershipIndex([paper()]);
      expect(paperStore.all).toHaveLength(0);
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(),
        env: shadowEnv,
        paperOrderOwnershipIndex: externallyBuiltIndex,
      })).toBe("ATTACHED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Executive Review admission — late-binding (point 2)", () => {
  it("still returns ORDER_ALREADY_EXECUTING when no late-binding support is supplied (byte-identical fallback)", () => {
    // This mirrors the pre-existing "does not cross-link..." test's ORDER_ALREADY_EXECUTING
    // assertion above — the ONLY existing test that asserted this result — and proves the fallback
    // is unchanged when liveIntentIndexByPaperOrderId/saveLiveIntents are simply omitted.
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-fallback-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
      })).toBe("ORDER_ALREADY_EXECUTING");
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches the review directly onto an already-existing live intent (OPEN, correct lineage) via the intent index — never a fresh linear scan input", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-attach-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const intent = liveIntent();
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      let saveCount = 0;
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => { saveCount += 1; },
      });
      expect(result).toBe("ATTACHED");
      expect(saveCount).toBe(1);
      expect(intent.executiveReviewLink).toMatchObject({ candidateId: "candidate-1", opportunityId: "opportunity-1" });
      // Attached across all three: the intent, and the PaperOrder — kept in sync.
      expect(paperStore.all[0]?.executiveReviewLink).toMatchObject({ candidateId: "candidate-1", opportunityId: "opportunity-1" });
      expect(reviewStore.get().reviews).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches onto a matching sourcePaperOrders entry (a netted/pyramid source order, not the intent's primary), with the index built through the REAL buildLiveIntentIndexByPaperOrderId — proving the branch is reachable in production", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-source-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      // The intent's PRIMARY is a different paperOrderId; "paper-1" appears only in sourcePaperOrders
      // — a genuine pyramid-add/netted order, exactly the shape openIntent()/add-entry produce in
      // production. GAP fix: the index below is built through the REAL production function, from a
      // real intent with a real sourcePaperOrders entry — not a hand-built `new Map([[id, intent]])`
      // — so a green result here proves the sourceEntry branch is actually reachable end to end
      // (buildLiveIntentIndexByPaperOrderId resolves "paper-1" to this intent via its
      // sourcePaperOrders entry, exactly as app.ts's executingPaperOrderIds/liveIntentIndexByPaperOrderId
      // derivation now does every tick), not merely reachable when a test fabricates the index by hand.
      const intent = liveIntent({
        paperOrderId: "primary-paper",
        causalLineage: lineage({ opportunityId: "opportunity-primary" }),
        sourcePaperOrders: [
          { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() },
        ],
      });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      expect(intentIndex.get("paper-1")).toBe(intent); // sourceEntry resolution actually happened
      expect(intentIndex.get("primary-paper")).toBe(intent);
      expect(intentIndex.conflictedPaperOrderIds.size).toBe(0);
      let saveCount = 0;
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        // Exactly what app.ts's real derivation now produces: index keys UNION conflictedPaperOrderIds.
        executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => { saveCount += 1; },
      });
      expect(result).toBe("ATTACHED");
      expect(saveCount).toBe(1);
      expect(intent.sourcePaperOrders?.[0]?.executiveReviewLink).toMatchObject({ candidateId: "candidate-1" });
      expect(intent.executiveReviewLink).toBeUndefined(); // the PRIMARY entry is untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("source-order path — same four fail-closed guards as the primary-order path, proven reachable via the REAL index", () => {
    // Shared fixture shape for every test below: the intent's PRIMARY is "primary-paper" (a
    // different, already-settled/attached order); "paper-1" — the id executive-review-admission
    // actually receives via the ownership index/paperStore — is a netted/pyramid SOURCE entry only.
    function sourceIntent(overrides: {
      state?: LiveIntent["state"];
      sourceCausalLineage?: LiveIntentCausalLineage | undefined;
      sourceExecutiveReviewLink?: ExecutiveReviewExecutionLink;
    } = {}): LiveIntent {
      return liveIntent({
        paperOrderId: "primary-paper",
        state: overrides.state ?? "OPEN",
        causalLineage: lineage({ opportunityId: "opportunity-primary" }),
        sourcePaperOrders: [
          {
            paperOrderId: "paper-1",
            laneId: "LANE",
            qty: 1,
            causalLineage: "sourceCausalLineage" in overrides ? overrides.sourceCausalLineage : lineage(),
            executiveReviewLink: overrides.sourceExecutiveReviewLink,
          },
        ],
      });
    }

    it("fails closed as INTENT_TERMINAL for a source order whose owning intent is CLOSED/ERROR/KILLED", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-source-terminal-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        for (const state of ["CLOSED", "ERROR", "KILLED"] as const) {
          const intent = sourceIntent({ state });
          const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
          expect(intentIndex.get("paper-1")).toBe(intent);
          const result = attachExecutiveReviewToExactPaperOrder({
            reviewStore,
            paperStore,
            executive: executive(),
            candidateId: "candidate-1",
            executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
            env: shadowEnv,
            paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
            liveIntentIndexByPaperOrderId: intentIndex,
            saveLiveIntents: () => {},
          });
          expect(result).toBe("INTENT_TERMINAL");
        }
        expect(reviewStore.get().reviews).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed as INTENT_LINEAGE_MISSING when the matching sourcePaperOrders entry carries no causalLineage of its own", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-source-nolineage-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        const intent = sourceIntent({ sourceCausalLineage: undefined });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBe(intent);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_LINEAGE_MISSING");
        expect(reviewStore.get().reviews).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed as INTENT_LINEAGE_CONFLICT when the matching sourcePaperOrders entry's captured lineage disagrees with the PaperOrder's current causalIdentity", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-source-conflict-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        // Only the SOURCE entry's own lineage snapshot is stale — proves the check reads the source
        // entry's causalLineage, never the intent's (which stays correct at "opportunity-primary").
        const intent = sourceIntent({ sourceCausalLineage: lineage({ opportunityId: "opportunity-STALE" }) });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBe(intent);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_LINEAGE_CONFLICT");
        expect(reviewStore.get().reviews).toHaveLength(0);
        // Never overwritten.
        expect(intent.sourcePaperOrders?.[0]?.causalLineage?.opportunityId).toBe("opportunity-STALE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed as INTENT_REVIEW_CONFLICT when the matching sourcePaperOrders entry already carries a DIFFERENT executiveReviewLink, never overwriting it", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-source-review-conflict-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        const otherLink: ExecutiveReviewExecutionLink = {
          executiveReviewId: "executive-review:some-other-decision:opportunity-1",
          candidateId: "candidate-other",
          opportunityId: "opportunity-1",
          laneId: "LANE",
          marketContextSnapshotId: "market-context-other",
          allocationSnapshotId: "cortex-allocation-1",
          canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
          direction: "LONG",
          marketState: "BULLISH",
          evidenceEra: CURRENT_EVIDENCE_ERA,
          decisionPipelinePolicyVersion: CURRENT_DECISION_POLICY_VERSION,
          executionPolicyVersion: EXECUTION_POLICY_VERSION,
          evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
          fourBrainPolicyVersion: "executive/2",
        };
        const intent = sourceIntent({ sourceExecutiveReviewLink: otherLink });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBe(intent);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_REVIEW_CONFLICT");
        expect(reviewStore.get().reviews).toHaveLength(0);
        // Never overwritten.
        expect(intent.sourcePaperOrders?.[0]?.executiveReviewLink).toBe(otherLink);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("collision policy (live-intent-index.ts) — a paperOrderId claimed by two distinct intents must never silently resolve to one", () => {
    it("fails closed as INTENT_INDEX_MISS when a paperOrderId is a genuine collision — a SOURCE of one intent and the PRIMARY of a different intent — via the REAL index", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-collision-primary-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        // "paper-1" is BOTH the primary of intentB AND a (non-self) source entry of intentA — a
        // data-integrity anomaly the index must never resolve by guessing which one is "right".
        const intentA = liveIntent({
          paperOrderId: "primary-a",
          sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() }],
        });
        const intentB = liveIntent({ paperOrderId: "paper-1" });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intentA, intentB]);
        expect(intentIndex.get("paper-1")).toBeUndefined(); // retracted, never a guess
        expect(intentIndex.conflictedPaperOrderIds.has("paper-1")).toBe(true);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          // Exactly app.ts's real derivation: conflicted ids are still marked executing.
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_INDEX_MISS");
        expect(reviewStore.get().reviews).toHaveLength(0);
        // Neither intent was mutated by the rejected attempt.
        expect(intentA.sourcePaperOrders?.[0]?.executiveReviewLink).toBeUndefined();
        expect(intentB.executiveReviewLink).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed as INTENT_INDEX_MISS when a paperOrderId is a SOURCE of two different intents at once, via the REAL index", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-collision-source-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        const intentA = liveIntent({
          paperOrderId: "primary-a",
          sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() }],
        });
        const intentB = liveIntent({
          paperOrderId: "primary-b",
          sourcePaperOrders: [{ paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() }],
        });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intentA, intentB]);
        expect(intentIndex.get("paper-1")).toBeUndefined();
        expect(intentIndex.conflictedPaperOrderIds.has("paper-1")).toBe(true);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_INDEX_MISS");
        expect(reviewStore.get().reviews).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("blocker 2(b) — duplicate source row within one intent must fail closed as ambiguous, never silently resolved to the first match", () => {
    it("a genuine (non-primary) source paperOrderId listed TWICE within one intent's own sourcePaperOrders is retracted by live-intent-index.ts itself (blocker 2a) — never even reaches the admission-side ambiguity check, and fails closed as INTENT_INDEX_MISS via the REAL index", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-dupsource-retracted-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        const intent = liveIntent({
          paperOrderId: "primary-a",
          causalLineage: lineage({ opportunityId: "opportunity-primary" }),
          sourcePaperOrders: [
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() },
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() },
          ],
        });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBeUndefined(); // retracted at the index level
        expect(intentIndex.conflictedPaperOrderIds.has("paper-1")).toBe(true);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          // Exactly app.ts's real derivation: index keys UNION conflictedPaperOrderIds.
          executingPaperOrderIds: new Set([...intentIndex.keys(), ...intentIndex.conflictedPaperOrderIds]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_INDEX_MISS");
        expect(reviewStore.get().reviews).toHaveLength(0);
        // Neither duplicate row was mutated by the rejected attempt.
        expect(intent.sourcePaperOrders?.[0]?.executiveReviewLink).toBeUndefined();
        expect(intent.sourcePaperOrders?.[1]?.executiveReviewLink).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("defense in depth: a duplicated PRIMARY self-echo row (which live-intent-index.ts deliberately never counts) still fails closed as INTENT_SOURCE_ROW_AMBIGUOUS — never silently resolved to the first row, even though both duplicate rows carry IDENTICAL lineage/link", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-dupsource-identical-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        // Both rows equal the intent's OWN primary paperOrderId — self-echo-shaped — so
        // live-intent-index.ts's `source.paperOrderId === intent.paperOrderId` skip means NEITHER
        // row is ever counted by the index's owners/sourceRowOccurrences tracking: the index resolves
        // "paper-1" cleanly to this intent with zero conflict. Only the admission-side check (which
        // looks at the intent's OWN sourcePaperOrders array directly, not through the index) can catch
        // this anomaly — proving the defense-in-depth check is genuinely reachable, not dead code.
        const identicalLineage = lineage();
        const intent = liveIntent({
          paperOrderId: "paper-1",
          causalLineage: identicalLineage,
          sourcePaperOrders: [
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: identicalLineage },
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: identicalLineage },
          ],
        });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBe(intent); // index resolves cleanly — no conflict there
        expect(intentIndex.conflictedPaperOrderIds.size).toBe(0);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set(["paper-1"]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_SOURCE_ROW_AMBIGUOUS");
        expect(reviewStore.get().reviews).toHaveLength(0);
        // Never overwritten.
        expect(intent.executiveReviewLink).toBeUndefined();
        expect(intent.sourcePaperOrders?.[0]?.executiveReviewLink).toBeUndefined();
        expect(intent.sourcePaperOrders?.[1]?.executiveReviewLink).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("defense in depth: a duplicated PRIMARY self-echo row still fails closed as INTENT_SOURCE_ROW_AMBIGUOUS when the two duplicate rows carry DIFFERENT lineage/link — never resolves by picking either one", () => {
      const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-dupsource-different-"));
      try {
        const paperStore = new PaperExecutionRouterStore(dir);
        paperStore.add(paper());
        const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
        const intent = liveIntent({
          paperOrderId: "paper-1",
          causalLineage: lineage(),
          sourcePaperOrders: [
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage() },
            { paperOrderId: "paper-1", laneId: "LANE", qty: 1, causalLineage: lineage({ opportunityId: "opportunity-DIFFERENT" }) },
          ],
        });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        expect(intentIndex.get("paper-1")).toBe(intent); // index resolves cleanly — no conflict there
        expect(intentIndex.conflictedPaperOrderIds.size).toBe(0);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set(["paper-1"]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_SOURCE_ROW_AMBIGUOUS");
        expect(reviewStore.get().reviews).toHaveLength(0);
        expect(intent.executiveReviewLink).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("fails closed as INTENT_TERMINAL for an already-closed/settled intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-terminal-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      for (const state of ["CLOSED", "ERROR", "KILLED"] as const) {
        const intent = liveIntent({ state });
        const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
        const result = attachExecutiveReviewToExactPaperOrder({
          reviewStore,
          paperStore,
          executive: executive(),
          candidateId: "candidate-1",
          executingPaperOrderIds: new Set(["paper-1"]),
          env: shadowEnv,
          paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
          liveIntentIndexByPaperOrderId: intentIndex,
          saveLiveIntents: () => {},
        });
        expect(result).toBe("INTENT_TERMINAL");
      }
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed as INTENT_LINEAGE_MISSING when the intent carries no causalLineage at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-nolineage-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const intent = liveIntent({ causalLineage: undefined });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(result).toBe("INTENT_LINEAGE_MISSING");
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed as INTENT_LINEAGE_CONFLICT when the intent's captured lineage disagrees with the PaperOrder's current causalIdentity", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-conflict-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      // Simulates paper-execution-router.ts's re-price path reassigning causalIdentity AFTER the
      // intent was opened — the intent's frozen-at-open lineage no longer matches.
      const intent = liveIntent({ causalLineage: lineage({ opportunityId: "opportunity-STALE" }) });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(result).toBe("INTENT_LINEAGE_CONFLICT");
      expect(reviewStore.get().reviews).toHaveLength(0);
      // Never overwritten — the intent's own lineage is untouched by the rejected attempt.
      expect(intent.causalLineage?.opportunityId).toBe("opportunity-STALE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed as INTENT_REVIEW_CONFLICT when the intent already carries a DIFFERENT executiveReviewLink, never overwriting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-review-conflict-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const otherLink: ExecutiveReviewExecutionLink = {
        executiveReviewId: "executive-review:some-other-decision:opportunity-1",
        candidateId: "candidate-other",
        opportunityId: "opportunity-1",
        laneId: "LANE",
        marketContextSnapshotId: "market-context-other",
        allocationSnapshotId: "cortex-allocation-1",
        canonicalCortexLaneId: "CG_WIDE_FAST_LONG",
        direction: "LONG",
        marketState: "BULLISH",
        evidenceEra: CURRENT_EVIDENCE_ERA,
        decisionPipelinePolicyVersion: CURRENT_DECISION_POLICY_VERSION,
        executionPolicyVersion: EXECUTION_POLICY_VERSION,
        evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        fourBrainPolicyVersion: "executive/2",
      };
      const intent = liveIntent({ executiveReviewLink: otherLink });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(result).toBe("INTENT_REVIEW_CONFLICT");
      expect(reviewStore.get().reviews).toHaveLength(0);
      // Never overwritten.
      expect(intent.executiveReviewLink).toBe(otherLink);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocker 1 — fails closed as INTENT_REVIEW_CONFLICT even when the intent's existing link shares the SAME executiveReviewId as the canonical one but disagrees on another field (full structural equality, not just executiveReviewId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-review-conflict-samereviewid-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      // Same executiveReviewId as the canonical link this (executive, order) pair would derive, but
      // marketState disagrees (e.g. a stale link captured before a since-corrected upstream bug) —
      // under the OLD id-only check this was silently treated as "already correctly linked"; the
      // fixed structural check must fail closed instead.
      const staleSameIdLink: ExecutiveReviewExecutionLink = { ...defaultReviewLink(), marketState: "BEARISH" };
      const intent = liveIntent({ executiveReviewLink: staleSameIdLink });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(result).toBe("INTENT_REVIEW_CONFLICT");
      expect(reviewStore.get().reviews).toHaveLength(0);
      // Never overwritten.
      expect(intent.executiveReviewLink).toBe(staleSameIdLink);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("late-binding: an idempotent replay onto an intent that already carries the SAME link returns ORDER_ALREADY_LINKED, repairs the PaperOrder side, and creates exactly one (not zero, not two) ExecutiveReviewRecord", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-idempotent-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      // The intent already carries the SAME link this exact (executive, order) pair would derive —
      // e.g. a previous late-bind attempt persisted the intent but crashed before paperStore.update
      // landed (a real reachable process-restart gap), so the PaperOrder itself has no link yet.
      const sameLink = defaultReviewLink();
      const intent = liveIntent({ executiveReviewLink: sameLink });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(result).toBe("ORDER_ALREADY_LINKED");
      // The review store started empty even though the intent already carried `sameLink` — this is
      // an artificial-but-valid whitebox state. Under the fixed partial-write-recovery logic, the
      // review under `record.executiveReviewId` (deterministic) gets created here since none existed
      // yet — this is the first-and-only review under that id, NOT a duplicate.
      expect(reviewStore.get().reviews).toHaveLength(1);
      // Repair of the PaperOrder side — the part blocker 1 exists to fix.
      expect(paperStore.all[0]?.executiveReviewLink).toEqual(sameLink);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed as INTENT_INDEX_MISS when executingPaperOrderIds claims the order is executing but the intent index has no entry for it — never assumes which input is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-late-indexmiss-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: new Map(), // deliberately empty — disagrees with executingPaperOrderIds
        saveLiveIntents: () => {},
      });
      expect(result).toBe("INTENT_INDEX_MISS");
      expect(reviewStore.get().reviews).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("blocker 1 — partial-write recovery: every combination of PaperOrder/intent/sourceEntry already carrying the link", () => {
    // Primary-order shape: openIntent()'s self-echo means a primary admission has THREE
    // independently-settable link locations — the PaperOrder, the intent itself, and the intent's
    // own sourcePaperOrders entry for paper-1 (live-execution-engine.ts:6454, planned.map includes
    // planned[0]). Build a fixture with any subset of the three already carrying `defaultReviewLink()`
    // (the SAME link a fresh attach would compute) and confirm the missing ones get repaired, exactly
    // one review ever exists, and only genuinely-missing locations are written to.
    function buildFixture(dir: string, present: { order?: boolean; intent?: boolean; source?: boolean }) {
      const link = defaultReviewLink();
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper({ executiveReviewLink: present.order ? link : undefined }));
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const intent = liveIntent({
        executiveReviewLink: present.intent ? link : undefined,
        sourcePaperOrders: [
          {
            paperOrderId: "paper-1",
            laneId: "LANE",
            qty: 1,
            causalLineage: lineage(),
            executiveReviewLink: present.source ? link : undefined,
          },
        ],
      });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      return { link, paperStore, reviewStore, intent, intentIndex };
    }

    function runAttach(fx: ReturnType<typeof buildFixture>, saveTracker: { count: number }) {
      return attachExecutiveReviewToExactPaperOrder({
        reviewStore: fx.reviewStore,
        paperStore: fx.paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(fx.paperStore),
        liveIntentIndexByPaperOrderId: fx.intentIndex,
        saveLiveIntents: () => { saveTracker.count += 1; },
      });
    }

    it("PaperOrder-only linked: repairs intent + sourceEntry", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-order-only-"));
      try {
        const fx = buildFixture(dir, { order: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.intent.executiveReviewLink).toEqual(fx.link);
        expect(fx.intent.sourcePaperOrders?.[0]?.executiveReviewLink).toEqual(fx.link);
        expect(fx.paperStore.all[0]?.executiveReviewLink).toEqual(fx.link);
        expect(saveTracker.count).toBe(1); // intent/sourceEntry mutated -> saveLiveIntents called once

        // Re-running now that all three agree must be a true no-op (still one review, no extra saves).
        const second = runAttach({ ...fx, intentIndex: buildLiveIntentIndexByPaperOrderId([fx.intent]) }, saveTracker);
        expect(second).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(saveTracker.count).toBe(1); // unchanged — nothing left to repair
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("intent-only linked: repairs sourceEntry + PaperOrder", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-intent-only-"));
      try {
        const fx = buildFixture(dir, { intent: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.intent.sourcePaperOrders?.[0]?.executiveReviewLink).toEqual(fx.link);
        expect(fx.paperStore.all[0]?.executiveReviewLink).toEqual(fx.link);
        expect(saveTracker.count).toBe(1); // sourceEntry mutated -> saveLiveIntents called once
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("sourceEntry-only linked: repairs intent + PaperOrder", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-source-only-"));
      try {
        const fx = buildFixture(dir, { source: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.intent.executiveReviewLink).toEqual(fx.link);
        expect(fx.paperStore.all[0]?.executiveReviewLink).toEqual(fx.link);
        expect(saveTracker.count).toBe(1); // intent mutated -> saveLiveIntents called once
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("PaperOrder + intent linked (pair): repairs sourceEntry only", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-order-intent-"));
      try {
        const fx = buildFixture(dir, { order: true, intent: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.intent.sourcePaperOrders?.[0]?.executiveReviewLink).toEqual(fx.link);
        expect(saveTracker.count).toBe(1); // sourceEntry mutated -> saveLiveIntents called once
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("PaperOrder + sourceEntry linked (pair): repairs intent only", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-order-source-"));
      try {
        const fx = buildFixture(dir, { order: true, source: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.intent.executiveReviewLink).toEqual(fx.link);
        expect(saveTracker.count).toBe(1); // intent mutated -> saveLiveIntents called once
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("intent + sourceEntry linked (pair): repairs PaperOrder only, and never calls saveLiveIntents (nothing to repair there)", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-intent-source-"));
      try {
        const fx = buildFixture(dir, { intent: true, source: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(fx.paperStore.all[0]?.executiveReviewLink).toEqual(fx.link);
        // Neither the intent nor its sourceEntry needed a write — saveLiveIntents must stay untouched.
        expect(saveTracker.count).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("all three already linked (full idempotent replay): zero writes anywhere, exactly one review", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-partial-all-"));
      try {
        const fx = buildFixture(dir, { order: true, intent: true, source: true });
        const saveTracker = { count: 0 };
        const result = runAttach(fx, saveTracker);
        expect(result).toBe("ORDER_ALREADY_LINKED");
        expect(fx.reviewStore.get().reviews).toHaveLength(1);
        expect(saveTracker.count).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("blocker 2 — 12-field lineage: each of the 6 newly-added fields individually causes INTENT_LINEAGE_CONFLICT", () => {
    function attachWithLineageOverride(dir: string, overrides: Partial<LiveIntentCausalLineage>): ReturnType<typeof attachExecutiveReviewToExactPaperOrder> {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      const intent = liveIntent({ causalLineage: lineage(overrides) });
      const intentIndex = buildLiveIntentIndexByPaperOrderId([intent]);
      const result = attachExecutiveReviewToExactPaperOrder({
        reviewStore,
        paperStore,
        executive: executive(),
        candidateId: "candidate-1",
        executingPaperOrderIds: new Set(["paper-1"]),
        env: shadowEnv,
        paperOrderOwnershipIndex: ownershipIndexFor(paperStore),
        liveIntentIndexByPaperOrderId: intentIndex,
        saveLiveIntents: () => {},
      });
      expect(reviewStore.get().reviews).toHaveLength(0); // never written on a rejected attach
      return result;
    }

    it("wrong sourceObservationId individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-sourceobs-"));
      try {
        expect(attachWithLineageOverride(dir, { sourceObservationId: "candidate-WRONG" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("wrong scanBatchId individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-scanbatch-"));
      try {
        expect(attachWithLineageOverride(dir, { scanBatchId: "batch-WRONG" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("wrong paperLaneId individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-lane-"));
      try {
        expect(attachWithLineageOverride(dir, { paperLaneId: "LANE-WRONG" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("wrong symbol individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-symbol-"));
      try {
        expect(attachWithLineageOverride(dir, { symbol: "ETHUSDT" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("wrong direction individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-direction-"));
      try {
        expect(attachWithLineageOverride(dir, { direction: "SHORT" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("wrong paperOrderId individually causes INTENT_LINEAGE_CONFLICT", () => {
      const dir = mkdtempSync(join(tmpdir(), "eram-lineage-paperorderid-"));
      try {
        expect(attachWithLineageOverride(dir, { paperOrderId: "paper-WRONG" })).toBe("INTENT_LINEAGE_CONFLICT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

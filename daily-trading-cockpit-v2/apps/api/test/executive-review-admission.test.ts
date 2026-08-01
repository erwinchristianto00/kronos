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
import { ExecutiveReviewStore } from "../src/lib/executive-review-store.js";
import { PaperExecutionRouterStore, type PaperOrder } from "../src/lib/paper-execution-router.js";
import type { CausalIdentity } from "../src/experience-engine/forward-causal-collection.js";
import type { ExecutiveDecision } from "../src/lib/four-brain-types.js";

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
    const dir = mkdtempSync(join(tmpdir(), "executive-review-admission-"));
    try {
      const paperStore = new PaperExecutionRouterStore(dir);
      paperStore.add(paper());
      paperStore.add(paper({ paperOrderId: "paper-2", sourceObservationId: "candidate-2", sourceSignalId: "candidate-2", dedupeKey: "candidate-2:LANE" }));
      const reviewStore = new ExecutiveReviewStore(join(dir, "reviews.json"));
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-other", executingPaperOrderIds: new Set(), env: shadowEnv })).toBe("NO_EXACT_CANDIDATE");
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-1", executingPaperOrderIds: new Set(["paper-1"]), env: shadowEnv })).toBe("ORDER_ALREADY_EXECUTING");
      // Genuinely unstamped legacy evidence: never received a causal identity at all.
      paperStore.update("paper-1", { causalIdentity: null });
      expect(attachExecutiveReviewToExactPaperOrder({ reviewStore, paperStore, executive: executive(), candidateId: "candidate-1", executingPaperOrderIds: new Set(), env: shadowEnv })).toBe("POST_FIX_POLICY_MISSING");
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
      })).toBe("ATTACHED");
      const stamped = reviewStore.get().reviews[0]?.sourceStatuses;
      expect(stamped?.marketState?.candle).toBe("STALE");
      expect(stamped?.entry?.candle).toBe("FRESH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

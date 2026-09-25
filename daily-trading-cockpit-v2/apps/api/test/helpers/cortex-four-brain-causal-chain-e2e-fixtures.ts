import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

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
} from "../../src/lib/paper-opportunity-allocator.js";
import {
  PaperExecutionRouterStore,
  admitPaperOpportunities,
  type PaperOrder,
} from "../../src/lib/paper-execution-router.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  type VariantMatrixSignal,
  type KlineTuple,
  type CurrentGuardVariantMatrixReport,
} from "../../src/lib/current-guard-variant-matrix.js";
import { buildAdaptiveLaneRouterReport } from "../../src/lib/adaptive-lane-router.js";
import { buildRegimeDirectionControllerReport } from "../../src/lib/regime-direction-controller.js";
import { buildLiveTradingGateReport } from "../../src/lib/live-trading-gate.js";
import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "../../src/lib/cortex-brain-store.js";
import { assembleCortexContext } from "../../src/lib/cortex-brain.js";
import {
  publishCortexDecisionSnapshotsForScan,
  cortexDecisionSnapshotsForScan,
} from "../../src/lib/cortex-decision-snapshot.js";
import { CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID } from "../../src/lib/cortex-live-gather.js";
import { buildPaperOrderOwnershipIndex } from "../../src/lib/paper-order-ownership-index.js";
import { allocationContextWithExactCortexPaperBridge } from "../../src/lib/cortex-paper-allocation-bridge.js";
import { MarketContextSnapshotStore } from "../../src/lib/market-context-snapshot-store.js";
import { assembleFourBrainTick } from "../../src/lib/four-brain-live-gather.js";
import {
  buildFourBrainGatherInput,
  type FourBrainBindingDeps,
  type EntryMicrostructure,
} from "../../src/lib/four-brain-live-gather-bindings.js";
import { runFourBrainShadowTick, _resetFourBrainSingleFlightForTests } from "../../src/lib/four-brain-shadow-tick.js";
import { EXECUTIVE_SCHEMA_VERSION, type ExecutiveDecision } from "../../src/lib/four-brain-types.js";
import { type CanonicalPolicyContext } from "../../src/experience-engine/forward-causal-collection.js";

// Shared test-builder fixtures for the CORTEX <-> Four-Brain production causal chain
// (cortex-four-brain-causal-chain-e2e.test.ts's own "point 9" chain), used by both that file's own
// tests and cortex-four-brain-live-execution-e2e.test.ts's "point 6" chain.
//
// 2026-08: this used to live inside cortex-four-brain-causal-chain-e2e.test.ts, and
// cortex-four-brain-live-execution-e2e.test.ts imported it straight from there. A plain ES import of
// a *.test.ts file executes ALL of that file's top-level describe()/it() registrations too, so the
// importer was silently re-running this file's entire suite in its own collection context on top of
// its own tests. Living in a plain module the `*.test.ts` glob doesn't match, importing a builder
// costs nothing else.

// ── Small shared helpers (mirrors paper-opportunity-allocator.test.ts's own fixture idioms) ──────

export function tmpDir(prefix: string): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
}
export function emptyGate() {
  return buildLiveTradingGateReport({});
}
export function routerOf(regime: string | null) {
  return buildAdaptiveLaneRouterReport({
    generatedAt: new Date().toISOString(),
    regimeReport: buildRegimeDirectionControllerReport({ currentRegime: regime, adaptiveDirectionBias: null, primaryValidationLane: null }),
    gateReport: emptyGate(),
  });
}

/** VM store with fresh SHORT signals — only needed so the allocator has a populated report; the
 *  candidate that matters for this test is the explicit LONG candidate passed separately. */
export async function buildVmReport(dir: string): Promise<CurrentGuardVariantMatrixReport> {
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

export function makeLongCandidate(): Candidate {
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
export const PAPER_LANE_ID = "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK"; // the one real, mapped paper lane for this roster id

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

export const policyFor = (ctx: ChainEnv): CanonicalPolicyContext & { instanceId: "3102"; fourBrainPolicyVersion: string } => ({
  instanceId: "3102",
  decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
  executionPolicyVersion: EXECUTION_POLICY_VERSION,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  evidenceEra: CURRENT_EVIDENCE_ERA,
  fourBrainPolicyVersion: EXECUTIVE_SCHEMA_VERSION,
  policyDeploymentAt: ctx.POLICY_DEPLOYED_AT,
});

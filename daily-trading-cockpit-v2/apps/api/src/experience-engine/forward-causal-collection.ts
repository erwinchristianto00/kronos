/**
 * Forward-only causal experience collection.
 *
 * This module is deliberately append-only and report-only. It never imports an
 * executor, allocator, CORTEX store, or exchange client.  `off` is a hard
 * zero-I/O mode and port 3103 is hard blocked even if an environment value is
 * accidentally copied from a shadow instance.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { resolveFourBrainInstanceId } from "../lib/four-brain-live-gather-bindings.js";
import type { CortexDecisionSnapshot } from "../lib/cortex-decision-snapshot.js";
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
} from "@dtc/shared";

export const CAUSAL_LINEAGE_SCHEMA_VERSION = "causal-lineage-1" as const;
export type CausalDirection = "LONG" | "SHORT" | "NEUTRAL" | "BOTH";

export interface CausalIdentity {
  lineageSchemaVersion: typeof CAUSAL_LINEAGE_SCHEMA_VERSION;
  decisionId: string;
  opportunityId: string;
  outcomeId: string | null;
  instanceId: string;
  laneId: string;
  symbolOrBasketId: string;
  direction: CausalDirection;
  featureSchemaVersion: string;
  decisionRuleVersion: string;
  attributionRuleVersion: string;
  /** Present only when an exact CORTEX decision snapshot was handed to admission. */
  cortexDecisionId: string | null;
  allocationSnapshotId: string | null;
  cortexFeatureSchemaVersion: number | null;
  decisionPolicyVersion: string;
  executionPolicyVersion: string;
  evidencePolicyVersion: string;
  evidenceEra: string;
}

export interface CausalCollectionActivation {
  active: boolean;
  instanceId: string;
  reason: "shadow-active" | "mode-off" | "live-3103-blocked" | "unknown-instance-fail-closed";
}

export interface ForwardPaperOrderLike {
  paperOrderId: string;
  sourceCandidateId?: string | null;
  sourceObservationId: string;
  openedAt: string;
  selectedLaneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  regime?: string | null;
  controllerMode?: string | null;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  plannedStopDistanceBps: number;
  provenance?: { routeScore?: unknown; expectedNetR?: unknown; costR?: unknown; feeSlippageR?: unknown; spreadR?: unknown } | null;
  provenanceFieldMissing?: string[];
  paperStatus: string;
  grossR?: number | null;
  costR?: number | null;
  netR?: number | null;
  closeReason?: string | null;
  closedAtMs?: number | null;
  resolvedAtMs?: number | null;
  closeIntrabarAmbiguous?: boolean;
  decisionPolicyVersion?: string | null;
  executionPolicyVersion?: string | null;
  evidencePolicyVersion?: string | null;
  evidenceEra?: string | null;
  causalIdentity?: CausalIdentity | null;
  cortexDecisionSnapshot?: CortexDecisionSnapshot | null;
}

export interface DecisionSnapshotEvent {
  eventType: "DECISION_SNAPSHOT";
  eventId: string;
  identity: CausalIdentity;
  asOfMs: number;
  reportOnly: true;
  codeVersion: string | null;
  marketState: { regime: string | null; status: "PRESENT" | "MISSING" };
  directionDecision: { direction: "LONG" | "SHORT"; controllerMode: string | null; status: "PRESENT" | "MISSING" };
  entryDecision: { entryPrice: number; stopLoss: number; takeProfitLevels: number[]; plannedStopDistanceBps: number };
  cortexRecommendation: { status: "MISSING"; value: null };
  incumbentDecision: { status: "PRESENT" | "MISSING"; value: string | null };
  features: { names: string[]; values: number[]; availableAtMs: number[]; sourceStatuses: Record<string, "FRESH" | "MISSING" | "STALE" | "ERROR"> };
  cortexTraining: {
    status: "PRESENT" | "MISSING";
    decisionId: string | null;
    featureSchemaVersion: number | null;
    featureVector: number[] | null;
    regimeFamily: string | null;
    eligible: boolean | null;
    finalPct: number | null;
    evalFinalPct: number | null;
  };
  provenance: { originKey: string; sourceObservationId: string; missingFields: string[] };
}

export interface OpportunityOpenEvent {
  eventType: "OPPORTUNITY_OPEN";
  eventId: string;
  identity: CausalIdentity;
  decisionId: string;
  openedAtMs: number;
  entryPrice: number;
  stopDistance: number;
  expectedCostAssumptions: { costR: number | null; feeSlippageR: number | null; spreadR: number | null };
  provenance: { sourceObservationId: string; originKey: string };
  reportOnly: true;
}

export interface OutcomeResolutionEvent {
  eventType: "OUTCOME_RESOLUTION";
  eventId: string;
  identity: CausalIdentity;
  outcomeId: string;
  opportunityId: string;
  decisionId: string;
  openedAtMs: number;
  closedAtMs: number;
  resolvedAtMs: number;
  grossR: number;
  costR: number;
  netR: number;
  exitReason: string | null;
  intrabarAmbiguous: boolean;
  outcomeQuality: "RESOLVED_VALID" | "UNSAFE_INTRABAR";
  directAttribution: "DIRECT_CAUSAL_LINK";
  reportOnly: true;
}

export type ForwardEvent = DecisionSnapshotEvent | OpportunityOpenEvent | OutcomeResolutionEvent;

const hash = (parts: readonly (string | number)[]): string =>
  createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const openedAtMsOf = (order: ForwardPaperOrderLike): number | null => {
  const value = Date.parse(order.openedAt);
  return Number.isFinite(value) ? value : null;
};
const originKeyOf = (order: ForwardPaperOrderLike): string => order.sourceCandidateId || order.sourceObservationId;
const validCortexSnapshot = (order: ForwardPaperOrderLike, openedAtMs: number): CortexDecisionSnapshot | null => {
  const snapshot = order.cortexDecisionSnapshot ?? null;
  if (!snapshot || snapshot.laneId !== order.selectedLaneId || snapshot.atMs > openedAtMs) return null;
  if (!snapshot.decisionId || !snapshot.allocationSnapshotId || !Number.isInteger(snapshot.featureSchemaVersion)) return null;
  if (!Array.isArray(snapshot.featureVector) || !snapshot.featureVector.length || !snapshot.featureVector.every(finite)) return null;
  return snapshot;
};

/** Strict gate owned by this feature. Unlike the older lane journal, it has no COLLECT_ONLY exception for 3103. */
export function resolveCausalCollectionActivation(env: NodeJS.ProcessEnv = process.env): CausalCollectionActivation {
  const instanceId = resolveFourBrainInstanceId(env);
  const rawPort = (env.PORT ?? "").toString().trim();
  if (instanceId === "3103" || rawPort === "3103") return { active: false, instanceId: "3103", reason: "live-3103-blocked" };
  if ((env.CAUSAL_EXPERIENCE_COLLECTION_MODE ?? "").toString().trim().toLowerCase() !== "shadow")
    return { active: false, instanceId, reason: "mode-off" };
  if (instanceId !== "3101" && instanceId !== "3102")
    return { active: false, instanceId, reason: "unknown-instance-fail-closed" };
  return { active: true, instanceId, reason: "shadow-active" };
}

/** Stamps IDs once during opportunity construction. A restart reuses the persisted identity and cannot mint another. */
export function prepareForwardCausalIdentity(order: ForwardPaperOrderLike, env: NodeJS.ProcessEnv = process.env): CausalIdentity | null {
  const activation = resolveCausalCollectionActivation(env);
  if (!activation.active) return null;
  if (order.causalIdentity) return order.causalIdentity;
  const asOfMs = openedAtMsOf(order);
  if (
    asOfMs == null || !order.paperOrderId || !order.selectedLaneId || !order.symbol ||
    order.decisionPolicyVersion !== CURRENT_DECISION_POLICY_VERSION ||
    order.executionPolicyVersion !== EXECUTION_POLICY_VERSION ||
    order.evidencePolicyVersion !== EVIDENCE_POLICY_VERSION ||
    order.evidenceEra !== CURRENT_EVIDENCE_ERA
  ) return null;
  const originKey = originKeyOf(order);
  const cortex = validCortexSnapshot(order, asOfMs);
  const decisionId = `causal-decision-${hash([CAUSAL_LINEAGE_SCHEMA_VERSION, activation.instanceId, originKey, order.selectedLaneId, order.symbol, order.direction, asOfMs])}`;
  return {
    lineageSchemaVersion: CAUSAL_LINEAGE_SCHEMA_VERSION,
    decisionId,
    opportunityId: `causal-opportunity-${hash([activation.instanceId, order.paperOrderId])}`,
    outcomeId: null,
    instanceId: activation.instanceId,
    laneId: order.selectedLaneId,
    symbolOrBasketId: order.symbol,
    direction: order.direction,
    featureSchemaVersion: "causal-paper-opportunity/1",
    decisionRuleVersion: "paper-opportunity-admission/1",
    attributionRuleVersion: "direct-paper-order-link/1",
    cortexDecisionId: cortex?.decisionId ?? null,
    allocationSnapshotId: cortex?.allocationSnapshotId ?? null,
    cortexFeatureSchemaVersion: cortex?.featureSchemaVersion ?? null,
    decisionPolicyVersion: order.decisionPolicyVersion,
    executionPolicyVersion: order.executionPolicyVersion,
    evidencePolicyVersion: order.evidencePolicyVersion,
    evidenceEra: order.evidenceEra,
  };
}

/** Deterministic from persisted semantic close fields only; no process timestamp participates in the identity. */
export function deterministicOutcomeId(order: ForwardPaperOrderLike): string | null {
  const identity = order.causalIdentity;
  if (!identity || !finite(order.closedAtMs) || !finite(order.netR)) return null;
  return `causal-outcome-${hash([identity.opportunityId, order.closedAtMs, order.closeReason ?? "UNKNOWN", order.netR])}`;
}

export function withResolvedCausalIdentity(order: ForwardPaperOrderLike): CausalIdentity | null {
  const identity = order.causalIdentity;
  const outcomeId = deterministicOutcomeId(order);
  if (!identity || !outcomeId) return null;
  if (identity.outcomeId === outcomeId) return identity;
  if (identity.outcomeId) return identity; // Never rewrite an already persisted outcome identity.
  return { ...identity, outcomeId };
}

function featureSnapshot(order: ForwardPaperOrderLike, asOfMs: number): DecisionSnapshotEvent["features"] {
  const candidates: Array<[string, unknown]> = [
    ["entryPrice", order.entryPrice], ["stopLoss", order.stopLoss], ["takeProfit1", order.takeProfitLevels[0]],
    ["plannedStopDistanceBps", order.plannedStopDistanceBps], ["routeScore", order.provenance?.routeScore],
    ["expectedNetR", order.provenance?.expectedNetR], ["costR", order.provenance?.costR],
  ];
  const names: string[] = []; const values: number[] = []; const availableAtMs: number[] = [];
  const sourceStatuses: Record<string, "FRESH" | "MISSING" | "STALE" | "ERROR"> = {};
  for (const [name, value] of candidates) {
    if (finite(value)) { names.push(name); values.push(value); availableAtMs.push(asOfMs); sourceStatuses[name] = "FRESH"; }
    else sourceStatuses[name] = "MISSING";
  }
  return { names, values, availableAtMs, sourceStatuses };
}

function openEvents(order: ForwardPaperOrderLike): ForwardEvent[] {
  const identity = order.causalIdentity;
  const asOfMs = openedAtMsOf(order);
  if (!identity || asOfMs == null) return [];
  const originKey = originKeyOf(order);
  const features = featureSnapshot(order, asOfMs);
  const cortex = validCortexSnapshot(order, asOfMs);
  const decision: DecisionSnapshotEvent = {
    eventType: "DECISION_SNAPSHOT", eventId: identity.decisionId, identity, asOfMs, reportOnly: true,
    codeVersion: null,
    marketState: { regime: order.regime ?? null, status: order.regime ? "PRESENT" : "MISSING" },
    directionDecision: { direction: order.direction, controllerMode: order.controllerMode ?? null, status: order.controllerMode ? "PRESENT" : "MISSING" },
    entryDecision: { entryPrice: order.entryPrice, stopLoss: order.stopLoss, takeProfitLevels: order.takeProfitLevels.slice(), plannedStopDistanceBps: order.plannedStopDistanceBps },
    cortexRecommendation: { status: "MISSING", value: null },
    incumbentDecision: { status: order.controllerMode ? "PRESENT" : "MISSING", value: order.controllerMode ?? null },
    features,
    cortexTraining: cortex
      ? {
          status: "PRESENT",
          decisionId: cortex.decisionId,
          featureSchemaVersion: cortex.featureSchemaVersion,
          featureVector: [...cortex.featureVector],
          regimeFamily: cortex.regimeFamily,
          eligible: cortex.eligible,
          finalPct: cortex.finalPct,
          evalFinalPct: cortex.evalFinalPct,
        }
      : {
          status: "MISSING", decisionId: null, featureSchemaVersion: null, featureVector: null,
          regimeFamily: null, eligible: null, finalPct: null, evalFinalPct: null,
        },
    provenance: { originKey, sourceObservationId: order.sourceObservationId, missingFields: order.provenanceFieldMissing?.slice() ?? [] },
  };
  const opportunity: OpportunityOpenEvent = {
    eventType: "OPPORTUNITY_OPEN", eventId: identity.opportunityId, identity, decisionId: identity.decisionId,
    openedAtMs: asOfMs, entryPrice: order.entryPrice, stopDistance: Math.abs(order.entryPrice - order.stopLoss),
    expectedCostAssumptions: {
      costR: finite(order.provenance?.costR) ? order.provenance!.costR as number : null,
      feeSlippageR: finite(order.provenance?.feeSlippageR) ? order.provenance!.feeSlippageR as number : null,
      spreadR: finite(order.provenance?.spreadR) ? order.provenance!.spreadR as number : null,
    },
    provenance: { sourceObservationId: order.sourceObservationId, originKey }, reportOnly: true,
  };
  return [decision, opportunity];
}

function outcomeEvent(order: ForwardPaperOrderLike): OutcomeResolutionEvent | null {
  const identity = order.causalIdentity;
  const openedAtMs = openedAtMsOf(order);
  const outcomeId = deterministicOutcomeId(order);
  // costR is signed in the paper book, so the invariant is net = gross + cost.
  // No incomplete or arithmetically impossible terminal row may enter the
  // append-only causal journal and later look like a learnable outcome.
  if (
    !identity || !outcomeId || openedAtMs == null || !finite(order.closedAtMs) || !finite(order.resolvedAtMs) ||
    !finite(order.grossR) || !finite(order.costR) || !finite(order.netR) ||
    Math.abs((order.grossR + order.costR) - order.netR) > 1e-9
  ) return null;
  return {
    eventType: "OUTCOME_RESOLUTION", eventId: outcomeId, identity: { ...identity, outcomeId }, outcomeId,
    opportunityId: identity.opportunityId, decisionId: identity.decisionId, openedAtMs, closedAtMs: order.closedAtMs,
    resolvedAtMs: order.resolvedAtMs, grossR: order.grossR, costR: order.costR, netR: order.netR,
    exitReason: order.closeReason ?? null, intrabarAmbiguous: Boolean(order.closeIntrabarAmbiguous),
    outcomeQuality: order.closeIntrabarAmbiguous ? "UNSAFE_INTRABAR" : "RESOLVED_VALID",
    directAttribution: "DIRECT_CAUSAL_LINK", reportOnly: true,
  };
}

const journalPath = (env: NodeJS.ProcessEnv, instanceId: string): string =>
  resolve((env.CAUSAL_EXPERIENCE_COLLECTION_DIR ?? "data").toString(), "causal-experience", instanceId, "events.jsonl");

interface EventIdCacheEntry {
  ids: Set<string>;
  size: number;
  mtimeMs: number;
}

// A resolution pass can emit hundreds of outcomes. Re-reading the complete append-only journal
// for each event made collection O(events x journal-size) and eventually dominated testnet's
// paper cycle. The cache remains safe across recovery tooling because an external file change
// invalidates it before admission checks use the IDs again.
const eventIdCache = new Map<string, EventIdCacheEntry>();

function existingEventIds(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  const stat = statSync(file);
  const cached = eventIdCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.ids;
  const result = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try { const value = JSON.parse(line) as { eventId?: unknown }; if (typeof value.eventId === "string") result.add(value.eventId); } catch { /* Partial tail is never eligible. */ }
  }
  eventIdCache.set(file, { ids: result, size: stat.size, mtimeMs: stat.mtimeMs });
  return result;
}

function appendEvents(events: readonly ForwardEvent[], env: NodeJS.ProcessEnv): boolean {
  const activation = resolveCausalCollectionActivation(env);
  if (!activation.active || !events.length) return false; // gate before any file access
  try {
    const file = journalPath(env, activation.instanceId);
    const seen = existingEventIds(file);
    const requested = new Set<string>();
    const unique = events.filter((event) => {
      if (seen.has(event.eventId) || requested.has(event.eventId)) return false;
      requested.add(event.eventId);
      return true;
    });
    if (!unique.length) return false;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, unique.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    for (const event of unique) seen.add(event.eventId);
    const stat = statSync(file);
    eventIdCache.set(file, { ids: seen, size: stat.size, mtimeMs: stat.mtimeMs });
    return true;
  } catch { return false; } // Collection is observational; it must fail open.
}

/** Call immediately after the existing paper store has accepted a new opportunity. */
export function recordForwardOpportunity(order: ForwardPaperOrderLike, env: NodeJS.ProcessEnv = process.env): boolean {
  return appendEvents(openEvents(order), env);
}

/** Call after the resolver has persisted terminal fields. It never modifies the resolved order. */
export function recordForwardOutcome(order: ForwardPaperOrderLike, env: NodeJS.ProcessEnv = process.env): boolean {
  const event = outcomeEvent(order);
  return event ? appendEvents([event], env) : false;
}

/**
 * Resolver batches are persisted in one append rather than one full admission check per order.
 * This is observational only: every event keeps its deterministic ID and appendEvents still
 * deduplicates both against the journal and within this batch.
 */
export function recordForwardOutcomes(orders: readonly ForwardPaperOrderLike[], env: NodeJS.ProcessEnv = process.env): boolean {
  return appendEvents(orders.flatMap((order) => {
    const event = outcomeEvent(order);
    return event ? [event] : [];
  }), env);
}

export function forwardCausalJournalPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const activation = resolveCausalCollectionActivation(env);
  return activation.active ? journalPath(env, activation.instanceId) : null;
}

/** Read-only parser used by the Experience Store bridge. Torn/unknown rows are never eligible. */
export function readForwardCausalEvents(file: string): ForwardEvent[] {
  if (!existsSync(file)) return [];
  const events: ForwardEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const parsed = JSON.parse(line) as ForwardEvent;
      if (
        parsed && typeof parsed === "object" &&
        (parsed.eventType === "DECISION_SNAPSHOT" || parsed.eventType === "OPPORTUNITY_OPEN" || parsed.eventType === "OUTCOME_RESOLUTION") &&
        typeof parsed.eventId === "string"
      ) events.push(parsed);
    } catch {
      // Partial append tails are intentionally ignored and cannot become labels.
    }
  }
  return events;
}

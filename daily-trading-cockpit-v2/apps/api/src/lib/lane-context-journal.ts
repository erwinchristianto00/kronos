/**
 * Lane-edge / live-context shadow journal (Track 1, report-only). Collects CAUSAL, per-decision snapshots of the
 * real Direction/CORTEX context that CANNOT be safely reconstructed from final aggregates (edge-memory is
 * outcome-fed and overwritten — see LANE_EDGE_FEASIBILITY.md), plus a separate outcome-resolution record with a
 * strict, idempotent attribution to the latest eligible pre-open decision.
 *
 * HARD contract (enforced structurally): forward-only, report-only, no authority. This module imports NO executor,
 * NO edge-memory store, NO beta — it CANNOT mutate edge-memory, lane eligibility, veto, allocation, or the kill
 * switch, and it does NOT reconstruct a past snapshot by reading the current overwritten regime-edge-memory.json.
 * The snapshot builder stores values EXACTLY as the caller captured them at decision time. Pure; the write side is
 * an injected sink so the mode gate + fail-open behaviour is testable without I/O.
 */

export const LANE_CONTEXT_SCHEMA_VERSION = "lane-context-1";
export const LANE_ATTRIBUTION_RULE_VERSION = "lane-attr-1";

export type LaneContextJournalMode = "off" | "shadow";
/** Default OFF; any unknown value is treated as OFF (fail-closed on config). */
export function resolveLaneContextMode(raw: string | undefined | null): LaneContextJournalMode {
  return raw === "shadow" ? "shadow" : "off";
}

export type Direction = "LONG" | "SHORT" | "BOTH" | "NEUTRAL";
export type SourceStatus = "FRESH" | "STALE" | "MISSING" | "ERROR";

/** Explicit lifecycle timestamps for a paper/counterfactual outcome. closedAtMs MUST be the MARKET time the exit
 *  condition was satisfied — never file mtime / append time / process time / replay-completion time. */
export interface OutcomeLifecycle {
  openedAtMs: number;
  /** Market timestamp of the exit. null ⇒ not proven ⇒ MISSING_CLOSE_TIMESTAMP (excluded from gold). */
  closedAtMs: number | null;
  /** Processing timestamp when the outcome was persisted (audit only — NEVER used for attribution ordering). */
  resolvedAtMs: number;
}

export interface LaneContextSnapshot {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  instanceId: string;
  laneId: string;
  symbolOrBasketId: string;
  direction: Direction;
  regimeFamily: string | null;
  axisScore: number | null;
  transitionRisk: number | null;
  longEdge: number | null;
  shortEdge: number | null;
  edgeMemory: number | null;
  edgeMemoryN: number | null;
  conviction: number | null;
  controllerMode: string | null;
  incumbentEligible: boolean;
  vetoed: boolean;
  vetoReason: string | null;
  staticWeightPct: number;
  cortexFinalPct: number | null;
  sourceStatuses: Record<string, SourceStatus>;
  featureSchemaVersion: string;
  reportOnly: true;
}

export type AttributionStatus =
  | "ATTRIBUTED" | "NO_ELIGIBLE_DECISION" | "TTL_EXPIRED" | "IDENTITY_MISMATCH"
  | "SCHEMA_MISMATCH" | "MISSING_CLOSE_TIMESTAMP" | "UNSAFE_OUTCOME";

export interface LaneOutcomeResolution {
  outcomeId: string;
  attributedDecisionId: string | null;
  laneId: string;
  symbolOrBasketId: string;
  direction: string;
  openedAtMs: number;
  closedAtMs: number | null;
  netR: number | null;
  grossR: number | null;
  costR: number | null;
  attributionStatus: AttributionStatus;
  attributionRuleVersion: string;
}

export interface OutcomeToAttribute {
  outcomeId: string;
  laneId: string;
  symbolOrBasketId: string;
  direction: string;
  lifecycle: OutcomeLifecycle;
  netR: number | null;
  grossR: number | null;
  costR: number | null;
  featureSchemaVersion: string;
}

/** Build a decision-time context snapshot from ALREADY-CAPTURED values. Never reads a store. reportOnly is fixed. */
export function buildLaneContextSnapshot(input: Omit<LaneContextSnapshot, "schemaVersion" | "reportOnly" | "featureSchemaVersion"> & { featureSchemaVersion?: string }): LaneContextSnapshot {
  // Deep-copy the only reference field so a later mutation of the caller's context cannot alter the recorded
  // snapshot (as-captured immutability contract). Scalars are copied by the spread.
  return { ...input, sourceStatuses: { ...input.sourceStatuses }, schemaVersion: LANE_CONTEXT_SCHEMA_VERSION, featureSchemaVersion: input.featureSchemaVersion ?? LANE_CONTEXT_SCHEMA_VERSION, reportOnly: true };
}

export interface AttributeOpts {
  ttlMs: number;
  /** Expected feature-schema version; a decision whose schema differs is a SCHEMA_MISMATCH. */
  expectedSchemaVersion?: string;
}

/**
 * Strict outcome→decision attribution. Precedence (each terminal):
 *   MISSING_CLOSE_TIMESTAMP → UNSAFE_OUTCOME → IDENTITY_MISMATCH → NO_ELIGIBLE_DECISION (no pre-open) →
 *   TTL_EXPIRED → SCHEMA_MISMATCH → ATTRIBUTED (latest eligible pre-open decision).
 * A decision AFTER open is never eligible. Pure — no ledger side effects (see LaneAttributionLedger for once-only).
 */
export function attributeOutcome(outcome: OutcomeToAttribute, decisions: LaneContextSnapshot[], opts: AttributeOpts): LaneOutcomeResolution {
  const base = {
    outcomeId: outcome.outcomeId, attributedDecisionId: null as string | null,
    laneId: outcome.laneId, symbolOrBasketId: outcome.symbolOrBasketId, direction: outcome.direction,
    openedAtMs: outcome.lifecycle.openedAtMs, closedAtMs: outcome.lifecycle.closedAtMs,
    netR: outcome.netR, grossR: outcome.grossR, costR: outcome.costR,
    attributionRuleVersion: LANE_ATTRIBUTION_RULE_VERSION,
  };
  const term = (attributionStatus: AttributionStatus, attributedDecisionId: string | null = null): LaneOutcomeResolution => ({ ...base, attributedDecisionId, attributionStatus });

  if (outcome.lifecycle.closedAtMs == null || !Number.isFinite(outcome.lifecycle.closedAtMs)) return term("MISSING_CLOSE_TIMESTAMP");
  if (outcome.netR == null || !Number.isFinite(outcome.netR)) return term("UNSAFE_OUTCOME");

  if (decisions.length === 0) return term("NO_ELIGIBLE_DECISION"); // no snapshots at all — nothing to attribute to
  const identity = decisions.filter((d) => d.laneId === outcome.laneId && d.symbolOrBasketId === outcome.symbolOrBasketId && d.direction === outcome.direction);
  if (identity.length === 0) return term("IDENTITY_MISMATCH"); // snapshots exist, but none match lane/symbol/direction

  const preOpen = identity.filter((d) => d.asOfMs <= outcome.lifecycle.openedAtMs).sort((a, b) => b.asOfMs - a.asOfMs);
  if (preOpen.length === 0) return term("NO_ELIGIBLE_DECISION");

  const latest = preOpen[0]!; // latest eligible pre-open
  if (outcome.lifecycle.openedAtMs - latest.asOfMs > opts.ttlMs) return term("TTL_EXPIRED");
  const expected = opts.expectedSchemaVersion ?? outcome.featureSchemaVersion;
  if (latest.featureSchemaVersion !== expected || outcome.featureSchemaVersion !== expected) return term("SCHEMA_MISMATCH");
  return term("ATTRIBUTED", latest.decisionId);
}

/** Enforces "one outcomeId resolves once": a duplicate close is idempotent (returns the first resolution). */
export class LaneAttributionLedger {
  private readonly resolved = new Map<string, LaneOutcomeResolution>();
  attribute(outcome: OutcomeToAttribute, decisions: LaneContextSnapshot[], opts: AttributeOpts): LaneOutcomeResolution {
    const existing = this.resolved.get(outcome.outcomeId);
    if (existing) return existing; // idempotent — a duplicate close cannot re-label
    const res = attributeOutcome(outcome, decisions, opts);
    this.resolved.set(outcome.outcomeId, res);
    return res;
  }
  has(outcomeId: string): boolean { return this.resolved.has(outcomeId); }
  size(): number { return this.resolved.size; }
}

/** Append sink — production passes a bounded append-only journal writer; tests pass an array push. */
export type LaneJournalSink = (record: { kind: "snapshot"; data: LaneContextSnapshot } | { kind: "resolution"; data: LaneOutcomeResolution }) => void;

/**
 * The report-only journal. When mode !== "shadow" it does ZERO sink I/O. All sink errors fail open (a logging
 * failure must never escape into the caller). Nothing here can touch edge-memory / eligibility / veto / beta.
 */
export class LaneContextJournal {
  constructor(private readonly sink: LaneJournalSink, private readonly mode: LaneContextJournalMode) {}
  private write(rec: Parameters<LaneJournalSink>[0]): boolean {
    if (this.mode !== "shadow") return false; // OFF ⇒ zero I/O
    try { this.sink(rec); return true; } catch { return false; } // fail-open
  }
  recordSnapshot(s: LaneContextSnapshot): boolean { return this.write({ kind: "snapshot", data: s }); }
  recordResolution(r: LaneOutcomeResolution): boolean { return this.write({ kind: "resolution", data: r }); }
  get isActive(): boolean { return this.mode === "shadow"; }
}

/**
 * CORTEX #218 — strict outcome attribution (PURE). Turns the accumulated shadow decision journal + each
 * lane's OWN resolved counterfactual closes into {x, y} training examples, under the operator's exact
 * contract (2026-07-13). This is where a silent bug silently poisons weeks of shadow data, so the whole
 * module is deterministic + heavily fuzzed/tested, and every drop is COUNTED, never quiet.
 *
 * THE CONTRACT (why each rule exists — see cortex-brain.ts #218 ATTRIBUTION CONTRACT):
 *  • Iterate OUTCOMES, not decisions. For each resolved trade, find THE ONE owning decision = the LATEST
 *    journaled decision with at ≤ openedAtMs AND at ≥ openedAtMs − ttl(lane), that had this lane present
 *    (evaluated) with matching direction + current feature schema. (decisions→next-trade would let every
 *    5-min tick before one open claim that trade → one trade mislabels many rows.)
 *  • Bounded window (signal TTL): no decision in [open−ttl, open] ⇒ the trade is UNATTRIBUTED (dropped +
 *    counted). Never force a stale match, never key on resolvedAt (label leakage).
 *  • One outcome claimed once: dedupe by (laneId, observationId).
 *  • netR is ALREADY in R here (the outcome-source layer does the XSEC fraction→R via frozen risk-at-open).
 *  • No silent exclusion: every roster lane gets an explicit CortexLaneLearningStatus + its static weight,
 *    so the promotion gate can see the capital coverage of lanes that lack a live outcome source.
 */
import {
  cortexWinLabel,
  type CortexArchetype,
  type CortexTrainingExample,
} from "./cortex-brain.js";

/** Default bounded validity window if a lane doesn't specify one — the directional exec signal TTL. */
export const CORTEX_ATTR_DEFAULT_TTL_MS = 50 * 60_000;
/** A lane needs at least this many attributed examples before it is called LEARNING_ACTIVE. */
export const CORTEX_ATTR_MIN_EXAMPLES_ACTIVE = 20;

export type CortexLaneDir = "LONG" | "SHORT" | "NEUTRAL";

/** A resolved lane trade normalized for attribution — the allocation-INDEPENDENT counterfactual close
 *  each lane already records every cycle. netR is ALWAYS in R (XSEC already divided by riskDistanceAtOpen
 *  upstream). observationId is the dedupe key. */
export interface CortexLaneOutcome {
  laneId: string;
  archetype: CortexArchetype;
  direction: CortexLaneDir;
  observationId: string;
  openedAtMs: number;
  resolvedAtMs: number;
  netR: number;
  /** Diagnostics only: the risk denominator used (XSEC), null for lanes that store netR natively. */
  riskDistanceAtOpen?: number | null;
}

/** One journaled brain decision, reduced to what attribution needs. `lanes` is keyed by laneId.
 *  finalPct/evalFinalPct are the OPERATIONAL (β=0) vs SHADOW-counterfactual (evaluationBeta) per-lane
 *  weights at decision time — carried through so a resolved outcome's realized netR can be compared
 *  against what the tilt WOULD have weighted it, for #219's decision-alpha (see cortexShadowDecisionAlpha
 *  below). Not used by the refit itself (which only needs x/y). */
export interface CortexDecisionRow {
  atMs: number;
  featureSchemaVersion: number;
  regimeFamily: string;
  lanes: Map<string, { x: number[]; eligible: boolean; direction: CortexLaneDir | null; finalPct: number; evalFinalPct: number }>;
}

/** A roster entry: what CORTEX believes it is tracking, and whether an outcome source is actually wired. */
export interface CortexAttrRosterEntry {
  laneId: string;
  archetype: CortexArchetype;
  staticWeightPct: number;
  /** False ⇒ this lane has NO wired counterfactual close source (e.g. a lane whose store isn't read). */
  hasOutcomeSource: boolean;
}

export type CortexLaneLearningStatus =
  | "LEARNING_ACTIVE" // ≥ min attributed examples at the current schema
  | "NO_OUTCOME_SOURCE" // no wired close source at all
  | "INSUFFICIENT_DATA" // source wired, but < min attributed examples so far
  | "SCHEMA_MISMATCH"; // has outcomes but they only match decisions from a stale feature schema

export interface CortexLaneAttributionStatus {
  laneId: string;
  archetype: CortexArchetype;
  status: CortexLaneLearningStatus;
  outcomesSeen: number;
  attributed: number;
  unattributedNoDecision: number;
  /** Breakdown of unattributedNoDecision (2026-07-22): how many of those drops are structurally
   *  unattributable scars — the outcome's openedAtMs predates the journal's OWN earliest retained
   *  decision, so no owning decision could possibly still exist — vs a genuine coverage gap where the
   *  journal DOES reach back that far but no matching (eligible/direction/schema) slice was ever
   *  found for this lane in the TTL window. unattributedNoDecisionJournalGap +
   *  unattributedNoDecisionGenuineGap === unattributedNoDecision always. Answers "is this lane's low
   *  attribution rate old scar tissue that will age out, or a live gap worth investigating" directly
   *  from the data, without the code-archaeology a prior investigation needed. */
  unattributedNoDecisionJournalGap: number;
  unattributedNoDecisionGenuineGap: number;
  schemaMismatch: number;
  duplicateDropped: number;
  /** 2026-07-22: outcomes dropped for a non-finite openedAtMs/resolvedAtMs/netR — corrupt input, never
   *  a real trade this lane could have learned from. Counted separately from noDecision/schemaMismatch/
   *  duplicate so "every drop is counted, never quiet" (module contract) actually holds for this class too. */
  invalidData: number;
  staticWeightPct: number;
}

/** A training example enriched with the provenance attribution needs to advance the store's counters. */
export interface CortexAttributedExample extends CortexTrainingExample {
  laneId: string;
  archetype: CortexArchetype;
  regimeFamily: string;
  observationId: string;
  netR: number;
  resolvedAtMs: number;
  /** The owning decision's eligible flag (diagnostic). Not a hard filter unless opts.requireEligible. */
  eligibleAtDecision: boolean;
  /** The owning decision's OPERATIONAL (β=0) and SHADOW-counterfactual (evaluationBeta) weight for this
   *  lane, at decision time — for cortexShadowDecisionAlpha below. Diagnostic only, never a training input. */
  finalPctAtDecision: number;
  evalFinalPctAtDecision: number;
}

export interface CortexAttributionResult {
  /** ALL currently-derivable examples (for the refit — recency-weighted over the full window). */
  examples: CortexAttributedExample[];
  perLane: CortexLaneAttributionStatus[];
  /** This-run tally of attributed examples per regime family (informational — the PERSISTED gate counter
   *  lives in the store and is advanced by the watermark delta, so journal rotation can't shrink it). */
  regimeCoverageThisRun: Record<string, number>;
  /** Max resolvedAtMs across attributed examples (the caller advances the store watermark toward this). */
  maxResolvedAtMs: number;
}

export interface CortexAttributionOpts {
  currentSchemaVersion: number;
  /** Bounded validity window per lane (ms). Defaults to CORTEX_ATTR_DEFAULT_TTL_MS. */
  ttlMsForLane?: (laneId: string) => number;
  roster: CortexAttrRosterEntry[];
  minExamplesForActive?: number;
  /** If true, only decisions where the lane was ELIGIBLE (not vetoed) can own an outcome. Default FALSE:
   *  matching on lane PRESENCE keeps the training set unbiased so the model can still learn a veto has
   *  become wrong (a vetoed context otherwise gets zero data → the veto self-perpetuates). The eligible
   *  flag is always recorded on the example either way. */
  requireEligible?: boolean;
}

interface LaneSlice {
  atMs: number;
  x: number[];
  eligible: boolean;
  direction: CortexLaneDir | null;
  schemaVersion: number;
  regimeFamily: string;
  finalPct: number;
  evalFinalPct: number;
}

/**
 * Attribute outcomes to decisions under the strict contract. Pure + deterministic. Every outcome that
 * fails to find an owning decision is counted (never silently dropped), and every roster lane gets an
 * explicit learning status. netR must already be in R.
 */
export function attributeOutcomes(
  decisions: CortexDecisionRow[],
  outcomes: CortexLaneOutcome[],
  opts: CortexAttributionOpts,
): CortexAttributionResult {
  const ttlFor = opts.ttlMsForLane ?? (() => CORTEX_ATTR_DEFAULT_TTL_MS);
  const minActive = opts.minExamplesForActive ?? CORTEX_ATTR_MIN_EXAMPLES_ACTIVE;

  // Per-lane index of decision slices, sorted ascending by time, so we can binary-narrow the window.
  const byLane = new Map<string, LaneSlice[]>();
  for (const d of decisions) {
    if (!Number.isFinite(d.atMs)) continue;
    for (const [laneId, l] of d.lanes) {
      if (!Array.isArray(l.x) || l.x.length === 0 || !l.x.every((v) => Number.isFinite(v))) continue;
      let arr = byLane.get(laneId);
      if (!arr) byLane.set(laneId, (arr = []));
      arr.push({
        atMs: d.atMs,
        x: l.x,
        eligible: l.eligible,
        direction: l.direction,
        schemaVersion: d.featureSchemaVersion,
        regimeFamily: d.regimeFamily,
        finalPct: Number.isFinite(l.finalPct) ? l.finalPct : 0,
        evalFinalPct: Number.isFinite(l.evalFinalPct) ? l.evalFinalPct : (Number.isFinite(l.finalPct) ? l.finalPct : 0),
      });
    }
  }
  for (const arr of byLane.values()) arr.sort((a, b) => a.atMs - b.atMs);

  // The journal's own retention boundary — the earliest atMs among ALL decisions read this run,
  // regardless of lane. An outcome whose openedAtMs predates this could never have an owning decision
  // no matter how the walk below runs; that's a structural scar, not a live coverage gap.
  let journalEarliestAtMs: number | null = null;
  for (const d of decisions) {
    if (!Number.isFinite(d.atMs)) continue;
    if (journalEarliestAtMs === null || d.atMs < journalEarliestAtMs) journalEarliestAtMs = d.atMs;
  }

  // Per-lane counters (seeded from roster so a lane with 0 outcomes still reports a status).
  const counters = new Map<
    string,
    {
      seen: number;
      attributed: number;
      noDecision: number;
      noDecisionJournalGap: number;
      noDecisionGenuineGap: number;
      schemaMismatch: number;
      duplicate: number;
      invalidData: number;
    }
  >();
  const emptyCounter = () => ({
    seen: 0,
    attributed: 0,
    noDecision: 0,
    noDecisionJournalGap: 0,
    noDecisionGenuineGap: 0,
    schemaMismatch: 0,
    duplicate: 0,
    invalidData: 0,
  });
  const rosterById = new Map(opts.roster.map((r) => [r.laneId, r]));
  for (const r of opts.roster) counters.set(r.laneId, emptyCounter());
  const ctr = (laneId: string) => {
    let c = counters.get(laneId);
    if (!c) counters.set(laneId, (c = emptyCounter()));
    return c;
  };

  const examples: CortexAttributedExample[] = [];
  const regimeCoverageThisRun: Record<string, number> = {};
  const consumed = new Set<string>(); // `${laneId}::${observationId}` — one outcome claimed once
  let maxResolvedAtMs = 0;

  // Deterministic order: oldest resolved first (stable, and makes maxResolvedAtMs obvious).
  const sortedOutcomes = [...outcomes].sort(
    (a, b) => a.resolvedAtMs - b.resolvedAtMs || a.laneId.localeCompare(b.laneId) || a.observationId.localeCompare(b.observationId),
  );

  for (const o of sortedOutcomes) {
    const c = ctr(o.laneId);
    c.seen += 1;
    // 2026-07-22 fix: this check used to run BEFORE c.seen+=1, so a corrupt outcome (non-finite
    // timestamp/netR) vanished from every per-lane counter — contradicting the module's own "every
    // drop is COUNTED, never quiet" contract. seen is now bumped first, and invalidData tallies this
    // specific drop reason so it's visible, not silently folded into any other bucket.
    if (!Number.isFinite(o.openedAtMs) || !Number.isFinite(o.resolvedAtMs) || !Number.isFinite(o.netR)) {
      c.invalidData += 1;
      continue;
    }

    const key = `${o.laneId}::${o.observationId}`;
    if (consumed.has(key)) {
      c.duplicate += 1;
      continue;
    }
    // 2026-07-22 fix: mark this key consumed on the FIRST encounter regardless of outcome (success or
    // failure) — previously only the SUCCESS path added to `consumed` (below), so a duplicate outcome
    // that failed to find an owning decision was never recognized as a duplicate on its 2nd+ occurrence;
    // it was independently counted into noDecision/schemaMismatch every time, inflating those buckets.
    consumed.add(key);

    const slices = byLane.get(o.laneId);
    const ttl = Math.max(0, ttlFor(o.laneId));
    const lo = o.openedAtMs - ttl;

    // Find the LATEST slice with atMs in [open−ttl, open], present, direction-consistent, current-schema,
    // (eligible if required). Walk from the end since slices are ascending — the first hit IS the latest.
    // The schema test is INSIDE the walk (not a post-filter on a single pre-chosen owner): a stale-schema
    // slice must NOT shadow an older current-schema owner (that would drop a valid attribution), and
    // schemaMismatch is counted ONLY when EVERY in-window candidate's sole blocking reason was schema —
    // an older (or newer) candidate that separately fails on eligibility/direction makes it a genuine mix
    // of causes, which must fall back to an honest no-owner drop, not a schema-only diagnosis.
    let owner: LaneSlice | null = null;
    let sawSchemaMismatch = false;
    let sawOtherReasonRejection = false;
    if (slices) {
      for (let i = slices.length - 1; i >= 0; i -= 1) {
        const s = slices[i]!;
        if (s.atMs > o.openedAtMs) continue; // decision after the open — cannot own it
        if (s.atMs < lo) break; // past the TTL window; everything earlier is older still
        if (opts.requireEligible && !s.eligible) {
          sawOtherReasonRejection = true;
          continue;
        }
        if (s.direction && o.direction && s.direction !== o.direction) {
          sawOtherReasonRejection = true; // corrupt-row guard
          continue;
        }
        if (s.schemaVersion !== opts.currentSchemaVersion) {
          sawSchemaMismatch = true; // eligible+direction-consistent but stale schema — keep searching older
          continue;
        }
        owner = s;
        break;
      }
    }

    if (!owner) {
      // No current-schema owner. If the only in-window candidate(s) failed on schema alone, that's a genuine
      // schema mismatch; otherwise (nothing eligible/direction-consistent, or a mix of schema + other
      // rejections across candidates) it's an honest no-owner drop.
      if (sawSchemaMismatch && !sawOtherReasonRejection) {
        c.schemaMismatch += 1;
      } else {
        c.noDecision += 1;
        // journalEarliestAtMs === null ⇒ no decisions were read AT ALL this run, so nothing could ever
        // have been attributed — that's a journal-coverage scar too, not a genuine per-lane gap.
        if (journalEarliestAtMs === null || o.openedAtMs < journalEarliestAtMs) c.noDecisionJournalGap += 1;
        else c.noDecisionGenuineGap += 1;
      }
      continue;
    }

    c.attributed += 1;
    const y = cortexWinLabel(o.netR);
    examples.push({
      x: owner.x,
      y,
      tMs: o.resolvedAtMs,
      schemaVersion: owner.schemaVersion,
      laneId: o.laneId,
      archetype: o.archetype,
      regimeFamily: owner.regimeFamily,
      observationId: o.observationId,
      netR: o.netR,
      resolvedAtMs: o.resolvedAtMs,
      eligibleAtDecision: owner.eligible,
      finalPctAtDecision: owner.finalPct,
      evalFinalPctAtDecision: owner.evalFinalPct,
    });
    regimeCoverageThisRun[owner.regimeFamily] = (regimeCoverageThisRun[owner.regimeFamily] ?? 0) + 1;
    if (o.resolvedAtMs > maxResolvedAtMs) maxResolvedAtMs = o.resolvedAtMs;
  }

  // Per-lane status. Union of roster lanes + any lane that produced outcomes (so an outcome for a lane the
  // roster forgot is still surfaced, not swallowed).
  const laneIds = new Set<string>([...rosterById.keys(), ...counters.keys()]);
  const perLane: CortexLaneAttributionStatus[] = [];
  for (const laneId of laneIds) {
    const c = ctr(laneId);
    const roster = rosterById.get(laneId);
    const staticWeightPct = roster?.staticWeightPct ?? 0;
    const archetype = roster?.archetype ?? "TACTICAL";
    let status: CortexLaneLearningStatus;
    if (roster && !roster.hasOutcomeSource) {
      status = "NO_OUTCOME_SOURCE";
    } else if (c.attributed >= minActive) {
      status = "LEARNING_ACTIVE";
    } else if (c.attributed === 0 && c.schemaMismatch > 0) {
      status = "SCHEMA_MISMATCH";
    } else {
      status = "INSUFFICIENT_DATA";
    }
    perLane.push({
      laneId,
      archetype,
      status,
      outcomesSeen: c.seen,
      attributed: c.attributed,
      unattributedNoDecision: c.noDecision,
      unattributedNoDecisionJournalGap: c.noDecisionJournalGap,
      unattributedNoDecisionGenuineGap: c.noDecisionGenuineGap,
      schemaMismatch: c.schemaMismatch,
      duplicateDropped: c.duplicate,
      invalidData: c.invalidData,
      staticWeightPct,
    });
  }
  perLane.sort((a, b) => b.staticWeightPct - a.staticWeightPct || a.laneId.localeCompare(b.laneId));

  return { examples, perLane, regimeCoverageThisRun, maxResolvedAtMs };
}

/** Sum of static weight across roster lanes NOT actively learning — the capital the promotion gate is
 *  "flying blind" on. A big number here must block promotion (a heavily-weighted lane with no outcome
 *  source means the brain would be tilting money it can't evaluate). */
export function cortexBlindCapitalPct(perLane: CortexLaneAttributionStatus[]): number {
  return perLane
    .filter((l) => l.status !== "LEARNING_ACTIVE")
    .reduce((s, l) => s + (Number.isFinite(l.staticWeightPct) ? Math.max(0, l.staticWeightPct) : 0), 0);
}

/** Number of regime families with ≥1 resolved LABELED outcome (the ≥2-family gate reads this over the
 *  PERSISTED store.resolvedByFamily, not decision ticks). Exported for the gate + tests. */
export function cortexRegimeFamilyCoverage(resolvedByFamily: Record<string, number>): number {
  return Object.values(resolvedByFamily).filter((n) => Number.isFinite(n) && n > 0).length;
}

/** Per-lane rollup of the shadow decision-alpha (below). */
export interface CortexShadowDecisionAlphaLane {
  laneId: string;
  n: number;
  cumulativeTiltDeltaR: number;
}

export interface CortexShadowDecisionAlphaResult {
  /** Number of attributed outcomes this was computed over. */
  n: number;
  /** Σ over every attributed outcome of (evalFinalPct − finalPct)/100 × netR — the REALIZED R the
   *  shadow tilt would have added, in aggregate, had it been operating on real capital all along.
   *  Mirrors decideCortex's own `expectedTiltDeltaR` formula exactly, but with the lane's REAL
   *  resolved netR substituted for its pre-decision shrunk-edge estimate — this is the "compared to
   *  realized at resolution" reconciliation expectedTiltDeltaR's own doc comment calls for (#219). */
  cumulativeTiltDeltaR: number;
  /** cumulativeTiltDeltaR / n, or null if n===0 — the average per-outcome edge the tilt adds. */
  meanTiltDeltaR: number | null;
  perLane: CortexShadowDecisionAlphaLane[];
}

/**
 * #219 — CORTEX's shadow decision-alpha: how much R the brain's tilt (at whatever evaluationBeta was in
 * effect at each decision) would have added, realized, over every outcome attribution has already tied
 * back to an owning decision. Pure + deterministic; a diagnostic READ over already-attributed examples,
 * never a training input and never wired to any allocation. Zero examples ⇒ n=0, cumulativeTiltDeltaR=0,
 * meanTiltDeltaR=null (not 0 — "no data yet" must never look identical to "measured zero edge").
 */
export function cortexShadowDecisionAlpha(examples: CortexAttributedExample[]): CortexShadowDecisionAlphaResult {
  const perLane = new Map<string, { n: number; sum: number }>();
  let cumulativeTiltDeltaR = 0;
  let n = 0;
  for (const e of examples) {
    if (!Number.isFinite(e.finalPctAtDecision) || !Number.isFinite(e.evalFinalPctAtDecision) || !Number.isFinite(e.netR)) continue;
    const tiltDeltaR = ((e.evalFinalPctAtDecision - e.finalPctAtDecision) / 100) * e.netR;
    if (!Number.isFinite(tiltDeltaR)) continue;
    cumulativeTiltDeltaR += tiltDeltaR;
    n += 1;
    const l = perLane.get(e.laneId) ?? { n: 0, sum: 0 };
    l.n += 1;
    l.sum += tiltDeltaR;
    perLane.set(e.laneId, l);
  }
  return {
    n,
    cumulativeTiltDeltaR,
    meanTiltDeltaR: n > 0 ? cumulativeTiltDeltaR / n : null,
    perLane: [...perLane.entries()]
      .map(([laneId, v]) => ({ laneId, n: v.n, cumulativeTiltDeltaR: v.sum }))
      .sort((a, b) => Math.abs(b.cumulativeTiltDeltaR) - Math.abs(a.cumulativeTiltDeltaR)),
  };
}

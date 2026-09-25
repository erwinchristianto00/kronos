/**
 * LIVE-LANE WIRING — PURE core (2026-08-02). Computes the four proof fields
 * (`conservativeNetR`, `postFixExactLineage`, `costValid`, `fresh`) that `liveLaneReport()`
 * (cortex-live-gather-bindings.ts) must genuinely, fail-closedly populate for each of the six
 * self-contained edge-lane modules (RC/RCS/SF/IM/PWR/CE) — none of the four may ever default to
 * true. Kept here, import-light and unit-testable with fabricated observation arrays, rather than
 * inline in the impure binding, so every one of the four fields has a direct test that never
 * touches a real store.
 *
 * `four-brain-best-lane-report.ts`'s `selectBestLaneReportForDirection` (already shipped, already
 * strict) requires all four before a report can represent a Direction-Brain edge:
 *   `postFixExactLineage !== true || costValid !== true || fresh !== true` → excluded, and
 *   `conservativeNetR` must be finite AND > 0. That consumer was previously unreachable in
 *   production because liveLaneReport() never populated any of the four — this module is what
 *   makes it reachable, honestly.
 */
import { computeEffectiveN, conservativeLowerBoundR } from "./edge-lower-bound.js";
import { selectNewestCostCohort } from "./paper-cost-cohort.js";

/** The minimal shape every one of the six lane-store observation types already has in common
 *  (symbol/openedAtMs/status/netR), plus the two NEW stamps this fix adds to each of their
 *  interfaces (`postFixLineageV1`, `costModelVersion`) — see edge-lane-cost-model.ts's doc comment
 *  for why these are a SEPARATE generation counter from paper-execution-router.ts's. */
export interface LaneEdgeReportObservationLike {
  symbol: string;
  openedAtMs: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  netR: number | null;
  /** Creation-time-only stamp set by the (fixed) cycle code that records a NEW observation. Legacy
   *  rows persisted before this fix — and any row this fix's own code does not stamp — come back
   *  from disk as `undefined`, which reads as "not proven post-fix", never as true. Never backfilled. */
  postFixLineageV1?: boolean;
  /** EDGE_LANE_COST_MODEL_VERSION at creation time (edge-lane-cost-model.ts). Absent ⇒ legacy row,
   *  treated as generation 1 by paper-cost-cohort.ts's own documented convention. */
  costModelVersion?: number | null;
}

export interface LaneEdgeReportFields {
  conservativeNetR: number | null;
  postFixExactLineage: boolean;
  costValid: boolean;
  fresh: boolean;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** The resolved (CLOSED_WIN/CLOSED_LOSS, finite netR) subset of `observations` — the exact subset
 *  every one of the six modules' own `buildXReport()` functions already use for `netAvgR`/`pf`. */
export function resolvedLaneEdgeObservations<T extends LaneEdgeReportObservationLike>(
  observations: readonly T[],
): T[] {
  return observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
}

/**
 * Compute the four proof fields for one lane's report. `blockWidthMs` must be that lane's own
 * holding-period characteristic (its MAX_HOLD_BARS/MAX_HOLD_HOURS × bar width) — entries on the
 * same symbol inside one hold-period window are correlated, not independent, so effectiveN clusters
 * on `${symbol}:${floor(openedAtMs/blockWidthMs)}`.
 */
export function computeLaneEdgeReportFields<T extends LaneEdgeReportObservationLike>(args: {
  observations: readonly T[];
  blockWidthMs: number;
  lastCycleAt: string | null | undefined;
  nowMs: number;
  freshnessTtlMs: number;
}): LaneEdgeReportFields {
  const resolved = resolvedLaneEdgeObservations(args.observations);

  // fresh: the lane's OWN store must have run a cycle, causally (not future-dated) and within the
  // TTL, before `nowMs`. Never guessed: a lane whose store tracks no lastCycleAt at all (IM) stays
  // permanently fresh=false — see cortex-live-gather-bindings.ts's doc comment on that gap.
  const fresh = (() => {
    if (typeof args.lastCycleAt !== "string") return false;
    const ms = Date.parse(args.lastCycleAt);
    if (!Number.isFinite(ms)) return false;
    if (ms > args.nowMs + 60_000) return false; // future timestamp ⇒ untrusted clock, never fresh
    return args.nowMs - ms <= args.freshnessTtlMs;
  })();

  // postFixExactLineage: EVERY resolved observation backing this report must carry the post-fix
  // lineage stamp — a store still holding (or mixing in) legacy rows reads false, by construction,
  // never partially true. resolved.length===0 also reads false (no evidence ⇒ nothing proven).
  const postFixExactLineage = resolved.length > 0 && resolved.every((o) => o.postFixLineageV1 === true);

  // costValid: every resolved observation must come from the SAME (newest) cost-model generation —
  // a report whose evidence mixes an old and a new cost formula is never valid, even if each row
  // individually carries a real stamp.
  const cohort = selectNewestCostCohort(resolved, 1);
  const costValid = cohort !== null && cohort.rows.length === resolved.length;

  // conservativeNetR: a one-sided lower bound over independent (symbol, time-block) evidence —
  // never the raw pre-aggregated mean a report builder exposes as netAvgR.
  const netRs = resolved.map((o) => o.netR as number);
  const effectiveN = computeEffectiveN(resolved, (o) => `${o.symbol}:${Math.floor(o.openedAtMs / args.blockWidthMs)}`);
  const conservativeNetR = conservativeLowerBoundR(netRs, effectiveN);

  return { conservativeNetR, postFixExactLineage, costValid, fresh };
}

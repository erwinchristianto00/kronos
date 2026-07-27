/**
 * SUB-ADMISSION-FLOOR PAPER ROW EXCLUSION (T1-b) — read-time filter, never a migration.
 *
 * WHAT WENT WRONG (fixed prospectively by T1-a, still present in every stored row):
 * `CG_BASELINE_FAST_05` and `CG_MAKER_FAST_05` carry `stopFloorBps: 1`. That value is a
 * NON-BINDING GEOMETRY SENTINEL — it routes the variant through deriveVariantGeometry's wide
 * branch so the paired TP lands at 0.5R; `Math.max(rawStop, 1)` never binds. The allocator
 * nevertheless passed `def.stopFloorBps ?? WIDE_STOP_MIN_BPS` into the ADMISSION gate, so those
 * two lanes admitted at 1bps while the parent lanes they are supposed to A/B against
 * (CG_BASELINE_CURRENT / CG_MAKER_LIMIT_SIM) admit at WIDE_STOP_MIN_BPS = 300. They therefore
 * took trades their parents never took — breaking the "only the TP moved" isolation AT THE GATE,
 * and admitting raw stops as low as 4.03bps where the modelled cost (`costR = -22/stopBps`)
 * reaches -5.46R on a single close.
 *
 * WHY A PER-ROW PREDICATE AND NOT A LANE BLOCKLIST:
 * After T1-a those same two lanes produce VALID paired rows at >= 300bps. Measured on the testnet
 * store 2026-07-26 they already hold 206 such rows at +0.291 / +0.067 mean netR. A lane blocklist
 * would destroy those forever and would keep destroying every future valid row. The rule below is
 * instead derived FROM THE GATE: a stored row is excluded exactly when its admitted stop distance
 * is below the floor `admissionStopFloorBpsForVariant` NOW returns for ITS OWN variant. That is
 * self-limiting (it excludes exactly the rows that could not exist under the fix), automatically
 * admits future valid rows, and generalises to any variant whose floor later changes.
 *
 * THE PROPERTY THAT MAKES THIS NOT A SELECTION BUG:
 * The predicate is BLIND TO THE OUTCOME COLUMN. It never reads `netR`, `grossR`, `costR`,
 * `paperStatus` beyond "is this a resolved close", `symbol` or `regime`. It excludes winners and
 * losers alike — on the measured store it drops a +0.4016 headline win and a -1.5132 headline loss
 * from the same lane. Retroactively filtering stored outcomes is the exact shape of the
 * survivorship bugs that produced six false positives this week; the ONLY thing that separates
 * this from those is that the rule is causal (it restates the admission gate) rather than
 * performance-derived. Any future edit that makes this predicate read an outcome field destroys
 * that property. Don't.
 *
 * SCOPE — `sourceType` is load-bearing, not decoration:
 * Only the allocator path runs `paperOpportunityStopFloorRejection`. `admitPaperOrders`
 * (paper-execution-router.ts) writes `plannedStopDistanceBps: obs.stopDistanceBps ?? 0` and
 * realtime-short-mirror.ts writes its own — neither is subject to that gate, so a row from those
 * sources at 20bps is NOT a row "that could not exist under the fix". Applying the predicate to
 * them would break the self-limiting property. Measured: 590/590 sub-floor rows on the store were
 * SCAN_CANDIDATE_LANE_ALLOCATOR (100%), so the clause costs nothing today and closes the hole
 * permanently.
 *
 * KNOWN THIRD WRITER of the scoped sourceType (review finding, 2026-07-27):
 * unified-testnet-proposal-source.ts:114 also stamps `sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR"`
 * with `plannedStopDistanceBps: geometry.stopDistanceBps`, and it never calls
 * `paperOpportunityStopFloorRejection`. Today that is harmless on TWO independent counts, neither of
 * which was previously asserted anywhere:
 *   (1) every recipe in RECIPE_BY_DIRECTION carries a BINDING `stopFloorBps` (> 1), so
 *       deriveVariantGeometry's wide branch floors the emitted geometry at that same floor and no
 *       sub-floor row can be produced. This is now pinned by
 *       "[T1-b/6] unified-testnet-proposal recipes cannot emit a sub-floor row" in
 *       paper-subfloor-exclusion.test.ts, which fails the moment a non-binding/absent floor is used.
 *   (2) UnifiedTestnetProposalStore is a read-only overlay; its rows are never persisted into the
 *       research paper store the predicate reads.
 * If (1) is ever changed, that test goes red BEFORE real testnet-executed trades can be silently
 * dropped from every aggregate. Do not delete it.
 *
 * WIRING CONTRACT:
 *  - REPORT-ONLY consumers apply this DIRECTLY and must SURFACE `SubFloorExclusionSummary`, so an
 *    operator can see what was removed and reconstruct the pre-exclusion number. Silent exclusion
 *    is how this codebase produced its artifacts.
 *  - DECISION-PATH consumers (allocation, admission, promotion, CORTEX, edge memory, curation,
 *    lane routing) go through `applySubFloorExclusionForDecisions`, which is DEFAULTED OFF and
 *    returns the caller's own array reference untouched until someone opts in.
 *  - Nothing here mutates or rewrites a stored row. Rows stay auditable in the store forever.
 */

import {
  VARIANT_MATRIX_DEFINITIONS,
  admissionStopFloorBpsForVariant,
} from "./current-guard-variant-matrix.js";

/** Both router namespaces a variant-matrix paper order can be stored under. */
export const VARIANT_MATRIX_LANE_ID_PREFIXES = [
  "CG_LONG_VARIANT_MATRIX:",
  "CG_VARIANT_MATRIX:",
] as const;

/**
 * Strip either router namespace off a `selectedLaneId`, returning the bare variant id — or null
 * when the id carries neither prefix (a non-variant-matrix lane, out of scope for this rule).
 *
 * Three private copies of this already exist (`cortexCgRouterVariantId`, `laneOf`, and an inline
 * `slice` in the allocator). This is the shared one; new callers use it rather than adding a
 * fourth. The existing three are deliberately left alone — `laneOf` in particular has different
 * semantics (lastIndexOf, "UNKNOWN" fallback) and is load-bearing for edge-memory keys.
 */
export function variantIdFromSelectedLaneId(selectedLaneId: string | null | undefined): string | null {
  const id = typeof selectedLaneId === "string" ? selectedLaneId.trim() : "";
  for (const prefix of VARIANT_MATRIX_LANE_ID_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return null;
}

const DEF_BY_VARIANT_ID: ReadonlyMap<string, (typeof VARIANT_MATRIX_DEFINITIONS)[number]> = new Map(
  VARIANT_MATRIX_DEFINITIONS.map((def) => [def.id as string, def]),
);

/**
 * The ONLY source type whose rows passed through `paperOpportunityStopFloorRejection`. See the
 * SCOPE note in the module header — widening this breaks the self-limiting property.
 */
export const SUB_FLOOR_SCOPED_SOURCE_TYPE = "SCAN_CANDIDATE_LANE_ALLOCATOR";

const CLOSED_PAPER_STATUSES: ReadonlySet<string> = new Set(["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"]);

/**
 * Minimal structural shape the predicate needs. Real `PaperOrder` is assignable; so are the
 * narrower order-likes used by the edge-memory, CORTEX and per-symbol-book readers.
 *
 * Deliberately does NOT include `netR` — the predicate must not be able to read the outcome.
 */
export interface SubFloorRowLike {
  paperStatus?: string | null;
  sourceType?: string | null;
  selectedLaneId?: string | null;
  plannedStopDistanceBps?: number | null;
}

/** The admission floor that applies to a stored row today, or null when the row is out of scope. */
export function admissionFloorBpsForStoredRow(row: SubFloorRowLike | null | undefined): number | null {
  const variantId = variantIdFromSelectedLaneId(row?.selectedLaneId);
  if (variantId === null) return null;
  const def = DEF_BY_VARIANT_ID.get(variantId);
  if (def === undefined) return null; // unknown variant id — never excluded (unknown != bad)
  return admissionStopFloorBpsForVariant(def);
}

/**
 * TRUE when this stored row could NOT have been admitted under the current gate.
 *
 * Reads exactly four fields, none of them an outcome. A row with an unknown/absent variant id, a
 * non-allocator source, or a non-terminal status is never excluded.
 */
export function isSubAdmissionFloorPaperRow(row: SubFloorRowLike | null | undefined): boolean {
  if (!row) return false;
  if (!CLOSED_PAPER_STATUSES.has(row.paperStatus ?? "")) return false;
  if (row.sourceType !== SUB_FLOOR_SCOPED_SOURCE_TYPE) return false;
  const floor = admissionFloorBpsForStoredRow(row);
  if (floor === null) return false;
  const bps = row.plannedStopDistanceBps;
  // Mirrors paperOpportunityStopFloorRejection exactly: finite AND >= floor clears. A missing or
  // non-finite bps is treated as NOT clearing, same as the gate.
  return !(typeof bps === "number" && Number.isFinite(bps) && bps >= floor);
}

/** Fields the summary reads. Outcome fields live here, NOT on `SubFloorRowLike`, on purpose. */
export interface SubFloorSummaryRowLike extends SubFloorRowLike {
  netR?: number | null;
  netPnlAmount?: number | null;
  paperOrderMode?: string | null;
  diagnosticLabel?: string | null;
}

/**
 * EXACTLY the HEADLINE scope `buildPaperPerformanceReport` uses (`headlineNetAvgR`, `headlinePF`,
 * `headlineWR`, `realizedPaperPnl` are all computed over this filter). The summary carries a
 * HEADLINE-scoped split as well as an all-closed one because the report exposes NO all-closed mean:
 * reconstructing `headlineNetAvgR` from the all-closed sums is arithmetically wrong whenever the
 * excluded set is not 100% headline — which on the real store it is not (~4 of ~599).
 */
function isHeadlineRow(row: SubFloorSummaryRowLike): boolean {
  return row.paperOrderMode !== "DIAGNOSTIC_ONLY" && row.diagnosticLabel !== "BACKFILL_DIAGNOSTIC";
}

function finiteOr0(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface SubFloorExclusionLaneRow {
  laneId: string;
  admissionStopFloorBps: number | null;
  excludedCount: number;
  excludedNetRSum: number;
  excludedNetAvgR: number | null;
  minStopDistanceBps: number | null;
  maxStopDistanceBps: number | null;
}

/**
 * What was removed, in enough detail to reconstruct the pre-exclusion aggregate.
 *
 * TWO BASES, because the report has two. Use the one that matches the metric you are reconciling:
 *
 *   ALL-CLOSED (matches PaperPerformanceReport.closed — there is no all-closed MEAN on the report):
 *     preClosed  = retainedClosedCount + excludedCount
 *
 *   HEADLINE (matches headlineClosed / headlineNetAvgR / realizedPaperPnl — the numbers the
 *   operator brief and the Telegram snapshot actually print):
 *     preHeadlineClosed  = retainedHeadlineClosedCount + excludedHeadlineCount
 *     preHeadlineNetAvgR = (retainedHeadlineNetRSum + excludedHeadlineNetRSum) / preHeadlineClosed
 *     preRealizedPaperPnl = retainedHeadlineNetPnlAmount + excludedHeadlineNetPnlAmount
 *
 * Applying the ALL-CLOSED sums to a HEADLINE metric is wrong whenever the excluded set is not 100%
 * headline. On the measured store it is ~4 headline out of ~599, so the two bases differ by orders
 * of magnitude. Pinned by "[T1-b/2b] headline reconstruction" in paper-subfloor-exclusion.test.ts,
 * whose fixture deliberately mixes HEADLINE, DIAGNOSTIC_ONLY and BACKFILL_DIAGNOSTIC rows so a
 * fixture where the two bases coincide cannot make the assertion vacuous.
 *
 * NOTE `excludedHeadlineCount + excludedDiagnosticOnlyCount` need NOT equal `excludedCount`: a
 * BACKFILL_DIAGNOSTIC row with paperOrderMode HEADLINE is in neither bucket, exactly as the report
 * treats it.
 *
 * COVERAGE CAVEAT on the mean: the report divides `headlineNetAvgR` by the number of FINITE netR
 * values, while `retainedHeadlineClosedCount` counts every headline close. The two denominators
 * agree only when netR coverage on closed rows is 100%. MEASURED on the testnet store 2026-07-27:
 * 6,378/6,378 closes and 5,597/5,597 non-MTM closes carry a finite netR (100.0%), and the resolver
 * writes netR on every close, so they agree today. If coverage ever drops, the reconstruction
 * becomes approximate — it does not become wrong in a way that changes what is EXCLUDED, only what
 * is reported as having been excluded.
 *
 * MEASURED EXCLUSION on that same store (single pass, 2026-07-27): 585 of 5,597 non-MTM closes
 * (10.5%), 100% of them sourceType SCAN_CANDIDATE_LANE_ALLOCATOR, spread over exactly the four
 * sentinel lanes (CG_BASELINE_FAST_05 204+91, CG_MAKER_FAST_05 199+91). Of those 585, only FOUR are
 * HEADLINE — which is precisely why the HEADLINE-scoped sums above exist.
 */
export interface SubFloorExclusionSummary {
  /** Always true on report-only consumers; mirrors the env flag on decision-path consumers. */
  applied: boolean;
  /** Bump when the predicate's definition changes, so old snapshots stay interpretable. */
  predicateVersion: 1;
  excludedCount: number;
  excludedWin: number;
  excludedLoss: number;
  excludedNetRSum: number;
  excludedNetAvgR: number | null;
  excludedNetPnlAmount: number;
  excludedHeadlineCount: number;
  /** HEADLINE-scoped sums — the ONLY correct basis for reconstructing headlineNetAvgR. */
  excludedHeadlineNetRSum: number;
  excludedHeadlineNetAvgR: number | null;
  excludedHeadlineNetPnlAmount: number;
  excludedDiagnosticOnlyCount: number;
  retainedClosedCount: number;
  retainedNetRSum: number;
  retainedNetAvgR: number | null;
  retainedHeadlineClosedCount: number;
  retainedHeadlineNetRSum: number;
  retainedHeadlineNetAvgR: number | null;
  retainedHeadlineNetPnlAmount: number;
  byLane: SubFloorExclusionLaneRow[];
}

export function emptySubFloorExclusionSummary(applied = true): SubFloorExclusionSummary {
  return {
    applied,
    predicateVersion: 1,
    excludedCount: 0,
    excludedWin: 0,
    excludedLoss: 0,
    excludedNetRSum: 0,
    excludedNetAvgR: null,
    excludedNetPnlAmount: 0,
    excludedHeadlineCount: 0,
    excludedHeadlineNetRSum: 0,
    excludedHeadlineNetAvgR: null,
    excludedHeadlineNetPnlAmount: 0,
    excludedDiagnosticOnlyCount: 0,
    retainedClosedCount: 0,
    retainedNetRSum: 0,
    retainedNetAvgR: null,
    retainedHeadlineClosedCount: 0,
    retainedHeadlineNetRSum: 0,
    retainedHeadlineNetAvgR: null,
    retainedHeadlineNetPnlAmount: 0,
    byLane: [],
  };
}

/**
 * Single counting pass. Allocates NO copy of the input — only the per-lane map, which is bounded by
 * the number of contaminated lanes (2 on the measured store, 0 on a clean one).
 *
 * `onRow` lets `partitionSubFloorPaperRows` reuse this pass to build its arrays; the summary-only
 * path (used by `excludeSubFloorRowsForReport(..., false)` and by every caller that just wants the
 * numbers) passes nothing and therefore copies nothing. This matters: the report builders run on the
 * notification-snapshot provider, on every dashboard render and twice per paper cycle against a
 * ~30k-order store on the same instance that has already OOM'd from exactly this allocation shape
 * (see the PSLE TTL-cache note at routes/shadow.ts:1570).
 */
function scanSubFloorPaperRows<T extends SubFloorSummaryRowLike>(
  rows: readonly T[],
  onRow?: (row: T, excluded: boolean) => void,
): SubFloorExclusionSummary {
  const summary = emptySubFloorExclusionSummary(true);
  const byLane = new Map<string, SubFloorExclusionLaneRow>();

  for (const row of rows) {
    if (!isSubAdmissionFloorPaperRow(row)) {
      onRow?.(row, false);
      if (CLOSED_PAPER_STATUSES.has(row.paperStatus ?? "")) {
        summary.retainedClosedCount += 1;
        summary.retainedNetRSum += finiteOr0(row.netR);
        if (isHeadlineRow(row)) {
          summary.retainedHeadlineClosedCount += 1;
          summary.retainedHeadlineNetRSum += finiteOr0(row.netR);
          summary.retainedHeadlineNetPnlAmount += finiteOr0(row.netPnlAmount);
        }
      }
      continue;
    }
    onRow?.(row, true);
    summary.excludedCount += 1;
    if (row.paperStatus === "PAPER_CLOSED_WIN") summary.excludedWin += 1;
    else summary.excludedLoss += 1;
    summary.excludedNetRSum += finiteOr0(row.netR);
    summary.excludedNetPnlAmount += finiteOr0(row.netPnlAmount);
    if (row.paperOrderMode === "DIAGNOSTIC_ONLY") summary.excludedDiagnosticOnlyCount += 1;
    // HEADLINE scope must match buildPaperPerformanceReport's exactly (mode AND diagnosticLabel), so
    // a BACKFILL_DIAGNOSTIC row is in NEITHER bucket. See the SubFloorExclusionSummary doc.
    if (isHeadlineRow(row)) {
      summary.excludedHeadlineCount += 1;
      summary.excludedHeadlineNetRSum += finiteOr0(row.netR);
      summary.excludedHeadlineNetPnlAmount += finiteOr0(row.netPnlAmount);
    }

    const laneId = row.selectedLaneId ?? "UNKNOWN";
    const lane =
      byLane.get(laneId) ??
      {
        laneId,
        admissionStopFloorBps: admissionFloorBpsForStoredRow(row),
        excludedCount: 0,
        excludedNetRSum: 0,
        excludedNetAvgR: null,
        minStopDistanceBps: null,
        maxStopDistanceBps: null,
      };
    lane.excludedCount += 1;
    lane.excludedNetRSum += finiteOr0(row.netR);
    const bps = row.plannedStopDistanceBps;
    if (typeof bps === "number" && Number.isFinite(bps)) {
      lane.minStopDistanceBps = lane.minStopDistanceBps === null ? bps : Math.min(lane.minStopDistanceBps, bps);
      lane.maxStopDistanceBps = lane.maxStopDistanceBps === null ? bps : Math.max(lane.maxStopDistanceBps, bps);
    }
    byLane.set(laneId, lane);
  }

  summary.excludedNetAvgR = summary.excludedCount > 0 ? summary.excludedNetRSum / summary.excludedCount : null;
  summary.excludedHeadlineNetAvgR =
    summary.excludedHeadlineCount > 0 ? summary.excludedHeadlineNetRSum / summary.excludedHeadlineCount : null;
  summary.retainedNetAvgR =
    summary.retainedClosedCount > 0 ? summary.retainedNetRSum / summary.retainedClosedCount : null;
  summary.retainedHeadlineNetAvgR =
    summary.retainedHeadlineClosedCount > 0
      ? summary.retainedHeadlineNetRSum / summary.retainedHeadlineClosedCount
      : null;
  for (const lane of byLane.values()) {
    lane.excludedNetAvgR = lane.excludedCount > 0 ? lane.excludedNetRSum / lane.excludedCount : null;
  }
  summary.byLane = [...byLane.values()].sort(
    (a, b) => b.excludedCount - a.excludedCount || a.laneId.localeCompare(b.laneId),
  );
  return summary;
}

/** Counting-only: the summary, with NO copy of the input array. */
export function summariseSubFloorPaperRows<T extends SubFloorSummaryRowLike>(
  rows: readonly T[],
): SubFloorExclusionSummary {
  return scanSubFloorPaperRows(rows);
}

/** Single pass: split rows and describe exactly what left. Pure; allocates two arrays. */
export function partitionSubFloorPaperRows<T extends SubFloorSummaryRowLike>(
  rows: readonly T[],
): { retained: T[]; excluded: T[]; summary: SubFloorExclusionSummary } {
  const retained: T[] = [];
  const excluded: T[] = [];
  const summary = scanSubFloorPaperRows(rows, (row, isExcluded) => {
    if (isExcluded) excluded.push(row);
    else retained.push(row);
  });
  return { retained, excluded, summary };
}

/**
 * REPORT entry point. `apply` defaults to true (report semantics: exclude, and surface what left).
 *
 * `apply: false` is for builders that are NOT purely report-only — see the note on
 * buildPaperPerformanceReport. It computes the SAME summary (so the operator still sees what WOULD
 * be removed) but returns the caller's own array untouched, so the aggregates stay byte-identical
 * to pre-change behaviour. `summary.applied` records which of the two happened; a consumer must
 * never read the summary without reading `applied`.
 */
export function excludeSubFloorRowsForReport<T extends SubFloorSummaryRowLike>(
  rows: readonly T[],
  apply = true,
): { rows: readonly T[]; exclusion: SubFloorExclusionSummary } {
  // Count first, copy only if something actually leaves. `apply:false` never copies at all, and a
  // CLEAN book never copies either — the previous shape allocated a near-full duplicate of a ~30k
  // order array on every dashboard render and every notification snapshot regardless.
  const summary = summariseSubFloorPaperRows(rows);
  summary.applied = apply;
  if (!apply || summary.excludedCount === 0) return { rows, exclusion: summary };
  return { rows: rows.filter((row) => !isSubAdmissionFloorPaperRow(row)), exclusion: summary };
}

// ── DECISION-PATH GATE ───────────────────────────────────────────────────────
/**
 * ONE flag for every decision-path consumer, not one per consumer. Splitting it would let the
 * allocator's auto-quarantine and the per-symbol curation report disagree about what the book
 * says — a lane un-benched by one while the other still curates it out on contaminated cells is a
 * state nobody can reason about. The lever is "does this instance read the cleaned book, yes/no".
 *
 * DEFAULT OFF. Deploying this change must alter no allocation, admission, promotion or execution
 * behaviour anywhere until an operator opts in.
 *
 * ROLLOUT HAZARD, stated because it is not obvious: live/3103 does not read this flag directly —
 * it FETCHES the per-symbol curation report computed on research (lane-symbol-curation-cache.ts).
 * Enabling the flag on research therefore silently changes what live reads, with no live-side
 * flag flip at all. Treat "enable on research" as itself a live change requiring sign-off, or pin
 * live's curation cache for the duration.
 */
export const PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV = "PAPER_EXCLUDE_SUBFLOOR_ROWS_DECISIONS";

/** Read at CALL time, never at module load, so an operator (and a test) can toggle it. */
export function subFloorExclusionEnabledForDecisions(): boolean {
  return (process.env[PAPER_SUBFLOOR_EXCLUSION_DECISION_ENV] ?? "").trim() === "1";
}

/**
 * DECISION-PATH entry point. With the flag off this returns the CALLER'S OWN ARRAY REFERENCE —
 * not a copy, not a filtered clone — so the off-state is byte-identical to pre-change behaviour
 * and allocates nothing.
 */
export function applySubFloorExclusionForDecisions<T extends SubFloorRowLike>(
  rows: readonly T[],
): readonly T[] {
  if (!subFloorExclusionEnabledForDecisions()) return rows;
  return rows.filter((row) => !isSubAdmissionFloorPaperRow(row));
}

/**
 * LIVE EDGE DIGGER — collection policy v2 and outcome maturity.
 *
 * Two independent defects made the digger's forward evidence unreadable. Both are collection and
 * presentation problems, not strategy problems: no hypothesis, threshold, geometry or cost is
 * touched here.
 *
 * ── 1. OVERLAPPING ENTRIES ────────────────────────────────────────────────────────────────────
 * Emission is a pure function of the current market snapshot with no knowledge of what is already
 * open, and `entryPrice` is the last CLOSED 1h candle — constant for a whole hour while the cycle
 * runs every ~7 minutes. One signal therefore became 7-10 rows at the SAME price which all stopped
 * out on the SAME candle. Measured on 3101 at `6142032`: 1,169 of 1,221 rows (95.7%) were opened
 * while a row for the same candidate+symbol was already open, maximum concurrent depth 80, and the
 * 42 resolved rows collapsed to 5 distinct (symbol, entryPrice) pairs and ONE canonical episode.
 * Duplicates do not move the mean — they inflate `n`, which is worse, because every standard error
 * and confidence interval computed from the row count was overstated by ~3.7x.
 *
 * ── 2. OUTCOME CENSORING ──────────────────────────────────────────────────────────────────────
 * A stop sits 1.0R away; a target sits 1.5-2.0R away. The nearer barrier is touched first, so in a
 * book younger than its own hold horizon the resolved subset is structurally the fast-losing tail,
 * while every position that is quietly winning is still OPEN and contributes nothing. All 42
 * resolved rows were stops and gross expectancy was exactly -1.0000R — an arithmetic identity of an
 * all-stops subset, not a measurement of anything. `maturedAsOf` below is the fix: a row may only
 * inform a verdict once its FULL horizon has elapsed, at which point a farther target or a timeout
 * has had the same chance to land as the nearer stop.
 *
 * WHERE THE DEDUP STATE LIVES. In the store's own observations, deliberately — not in a side map.
 * The rows are already persisted and already survive restart, so a separate structure could only
 * ever disagree with them. Admission asks the same question the analysis asks ("is there already a
 * row for this candidate+symbol in this episode?") against the same data, using the same episode
 * width as evidence clustering, so the collection rule and the counting rule cannot drift apart.
 */

// TYPE-ONLY import, deliberately. `live-edge-digger.ts` imports this module back for admission and
// maturity, so a runtime import here would close a cycle. The episode width is therefore passed IN
// rather than reached for — which also stops this module from quietly disagreeing with the width
// the analysis clusters on.
import type { ShadowObservation } from "./live-edge-digger.js";

/** Bumped ONLY when the admission rules change. Rows carry the version they were collected under. */
export const COLLECTION_POLICY_VERSION = 2 as const;
export type CollectionPolicyVersion = 1 | 2;

/**
 * Rows written before this field existed are v1 — absent, not null, and the check must treat them
 * the same way. v1 rows stay fully visible as historical diagnostics and are never rewritten, but
 * they can never enter a v2 gate: they were collected under a rule that permitted 80-deep overlap,
 * so their `n` means something different from a v2 row's `n`.
 */
export function policyVersionOf(o: ShadowObservation): CollectionPolicyVersion {
  return (o as { collectionPolicyVersion?: number }).collectionPolicyVersion === 2 ? 2 : 1;
}

export const isPolicyV2 = (o: ShadowObservation): boolean => policyVersionOf(o) === 2;

/**
 * Membership of the CURRENT-POLICY cohort — the only rows any "current" number may aggregate.
 *
 * Two conditions, not one. The version stamp is the primary test, and the cutover instant is the
 * belt-and-braces second: a v2-stamped row opened before the cutover would mean the stamp and the
 * boundary disagree, and this returns false rather than trusting either alone. Requiring both makes
 * the boundary a thing a test can assert instead of a thing the writer promises.
 */
export function isCurrentPolicyRow(o: ShadowObservation, cutoverAtMs: number | null): boolean {
  if (!isPolicyV2(o)) return false;
  if (cutoverAtMs !== null && Number.isFinite(cutoverAtMs) && o.openedAtMs < cutoverAtMs) return false;
  return true;
}

/** The legacy cohort: everything the current cohort excludes. Diagnostic only, never a gate input. */
export function isLegacyRow(o: ShadowObservation, cutoverAtMs: number | null): boolean {
  return !isCurrentPolicyRow(o, cutoverAtMs);
}

export type SuppressionReason =
  /** A row for this candidate+symbol is still OPEN. One live position at a time. */
  | "OPEN_POSITION_EXISTS"
  /** This candidate+symbol already entered inside the current canonical episode — even if that
   *  earlier row has since closed. One market look is one draw; re-entering inside it would
   *  manufacture correlated rows that the episode clustering then has to undo. */
  | "ALREADY_ENTERED_THIS_EPISODE"
  /** Exact `observationId` collision — the same rule, symbol and decision instant. */
  | "DUPLICATE_OBSERVATION";

export interface SuppressedSignal {
  readonly reason: SuppressionReason;
  readonly candidateId: string;
  readonly symbol: string;
  readonly detail: string;
}

export interface AdmissionResult {
  readonly admitted: readonly ShadowObservation[];
  readonly suppressed: readonly SuppressedSignal[];
}

/**
 * Applies collection policy v2 to one cycle's proposed rows.
 *
 * Order matters and is reported as the FIRST binding reason, never a list: an exact duplicate is
 * not an "episode" problem, and an open position older than the episode window is not a duplicate.
 * Conflating them would have made the 3101 overlap look like ordinary dedup noise.
 *
 * Admitted rows are folded into the working set as they are accepted, so two proposals in the SAME
 * batch cannot both slip through.
 */
export function admitUnderPolicyV2(
  proposed: readonly ShadowObservation[],
  existing: readonly ShadowObservation[],
  episodeBlockMs: number,
): AdmissionResult {
  const admitted: ShadowObservation[] = [];
  const suppressed: SuppressedSignal[] = [];

  const seenIds = new Set(existing.map((o) => o.observationId));
  // Only v2 rows constrain admission. A v1 row was collected under a policy that allowed overlap;
  // letting it block a v2 entry would import the old defect into the new evidence.
  const byKey = new Map<string, ShadowObservation[]>();
  for (const o of existing) {
    if (!isPolicyV2(o)) continue;
    const k = `${o.candidateId}|${o.symbol}`;
    const list = byKey.get(k);
    if (list) list.push(o); else byKey.set(k, [o]);
  }

  for (const row of proposed) {
    const key = `${row.candidateId}|${row.symbol}`;
    const prior = byKey.get(key) ?? [];

    if (seenIds.has(row.observationId)) {
      suppressed.push({
        reason: "DUPLICATE_OBSERVATION", candidateId: row.candidateId, symbol: row.symbol,
        detail: `observationId ${row.observationId} already recorded`,
      });
      continue;
    }

    const openRow = prior.find((o) => o.status === "OPEN");
    if (openRow) {
      suppressed.push({
        reason: "OPEN_POSITION_EXISTS", candidateId: row.candidateId, symbol: row.symbol,
        detail: `${row.symbol} already has an OPEN row opened ${openRow.openedAt}`,
      });
      continue;
    }

    // Same canonical episode as ANY prior v2 row for this key — open or closed. Same width as
    // evidence clustering, so a row admitted here can never be merged away as a duplicate draw.
    const sameEpisode = prior.find((o) => Math.abs(row.openedAtMs - o.openedAtMs) < episodeBlockMs);
    if (sameEpisode) {
      const hoursIn = (row.openedAtMs - sameEpisode.openedAtMs) / 3_600_000;
      suppressed.push({
        reason: "ALREADY_ENTERED_THIS_EPISODE", candidateId: row.candidateId, symbol: row.symbol,
        detail: `entered ${hoursIn.toFixed(2)}h ago at ${sameEpisode.openedAt}; episode block is ` +
          `${(episodeBlockMs / 3_600_000).toFixed(0)}h`,
      });
      continue;
    }

    admitted.push(row);
    seenIds.add(row.observationId);
    byKey.set(key, [...prior, row]);
  }

  return { admitted, suppressed };
}

// ---------------------------------------------------------------------------
// Maturity — the censoring guard.
// ---------------------------------------------------------------------------

/** The instant a row's full hold horizon has elapsed and its outcome is no longer censored. */
export function maturesAtMs(o: ShadowObservation): number {
  return o.openedAtMs + o.maxHoldHours * 3_600_000;
}

/**
 * True once the row's entire hold window has passed.
 *
 * Deliberately NOT "has resolved". A row that stopped out after 20 minutes is resolved but tells us
 * only that the nearer barrier was nearer; the farther target never got its full chance. Maturity is
 * a property of ELAPSED TIME, so a matured cohort contains its winners, its losers and its timeouts
 * in their true proportions.
 */
export function isMatured(o: ShadowObservation, nowMs: number): boolean {
  return nowMs >= maturesAtMs(o);
}

/** Matured AND scored AND in the current-policy cohort — the only rows a verdict may rest on. */
export function isJudgeableEvidence(
  o: ShadowObservation,
  nowMs: number,
  cutoverAtMs: number | null = null,
): boolean {
  return isCurrentPolicyRow(o, cutoverAtMs) && isMatured(o, nowMs)
    && o.status !== "OPEN" && typeof o.netR === "number" && Number.isFinite(o.netR);
}

export interface MaturityCensus {
  readonly raw: number;
  readonly open: number;
  readonly resolved: number;
  readonly matured: number;
  /** Horizon elapsed but not yet scored — transient resolver lag, reported so the cohort is never
   *  silently short. */
  readonly maturedPendingResolution: number;
  readonly judgeable: number;
  readonly resolvedFraction: number | null;
  /** When the earliest still-immature row completes its horizon. Null when none are pending. */
  readonly earliestNextMaturityAt: string | null;
  readonly openAgeHoursMedian: number | null;
  readonly openRemainingHoursMin: number | null;
}

/**
 * Census over WHATEVER ROW SET IT IS GIVEN. It does no cohort filtering of its own — deliberately,
 * because the previous version silently described the whole store while its output was rendered
 * under a "current policy" heading. Measured on 3101 at `280cf56`: it reported resolvedFraction
 * 0.252 and an earliest horizon of 2026-08-06T18:01Z when the v2 cohort's true values were 0.000
 * and 2026-08-07T04:09Z. Callers now pass a pre-filtered cohort and the caller is where the cohort
 * is named.
 */
export function maturityCensus(rows: readonly ShadowObservation[], nowMs: number): MaturityCensus {
  const open = rows.filter((r) => r.status === "OPEN");
  const resolved = rows.filter((r) => r.status !== "OPEN" && typeof r.netR === "number");
  const matured = rows.filter((r) => isMatured(r, nowMs));
  // No cohort filter here: `rows` IS the cohort. See the note above.
  const judgeable = rows.filter((r) => isMatured(r, nowMs)
    && r.status !== "OPEN" && typeof r.netR === "number" && Number.isFinite(r.netR));
  const pending = matured.filter((r) => r.status === "OPEN" || typeof r.netR !== "number");

  const immature = rows.filter((r) => !isMatured(r, nowMs));
  const nextAt = immature.length > 0 ? Math.min(...immature.map(maturesAtMs)) : null;

  const ages = open.map((r) => (nowMs - r.openedAtMs) / 3_600_000).sort((a, b) => a - b);
  const remaining = open.map((r) => (maturesAtMs(r) - nowMs) / 3_600_000).filter((v) => v > 0);

  return {
    raw: rows.length,
    open: open.length,
    resolved: resolved.length,
    matured: matured.length,
    maturedPendingResolution: pending.length,
    judgeable: judgeable.length,
    resolvedFraction: rows.length > 0 ? Math.round((resolved.length / rows.length) * 1000) / 1000 : null,
    earliestNextMaturityAt: nextAt === null ? null : new Date(nextAt).toISOString(),
    openAgeHoursMedian: ages.length > 0 ? Math.round(ages[Math.floor(ages.length / 2)]! * 100) / 100 : null,
    openRemainingHoursMin: remaining.length > 0 ? Math.round(Math.min(...remaining) * 100) / 100 : null,
  };
}

/**
 * Deepest concurrent overlap for one candidate+symbol set — the headline number that made the v1
 * defect visible. Reported per candidate so a regression cannot hide behind an aggregate.
 */
export function maxOverlapDepth(rows: readonly ShadowObservation[], nowMs: number): number {
  const byKey = new Map<string, ShadowObservation[]>();
  for (const o of rows) {
    const k = `${o.candidateId}|${o.symbol}`;
    const list = byKey.get(k);
    if (list) list.push(o); else byKey.set(k, [o]);
  }
  let deepest = 0;
  for (const group of byKey.values()) {
    for (const r of group) {
      const closedAt = (o: ShadowObservation): number =>
        o.resolvedAt !== null && Number.isFinite(Date.parse(o.resolvedAt)) ? Date.parse(o.resolvedAt) : nowMs;
      const concurrent = group.filter((p) => p.openedAtMs < r.openedAtMs && closedAt(p) > r.openedAtMs).length;
      if (concurrent > deepest) deepest = concurrent;
    }
  }
  return deepest;
}

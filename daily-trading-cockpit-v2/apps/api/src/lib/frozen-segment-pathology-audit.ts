/**
 * F***** FROZEN CURRENT-GUARD SEGMENT PATHOLOGY AUDIT — REPORT-ONLY
 *
 * Counterfactual / diagnostic pass on the frozen prospective tape's OOS segments.
 * Answers the core question:
 *
 *   "Is segment 1's negative netAvgR caused by an old transient bad batch
 *    (concentrated losses, specific symbols, narrow date window) — or does it
 *    reflect a systematic risk that could recur?"
 *
 * Six sub-analyses:
 *  1. Segment 1 without top-4 worst losses (counterfactual floor)
 *  2. Segment 1 excluding known-problem symbols (SEI/LINK/OP)
 *  3. Segment 1 broken into weekly date batches (temporal concentration check)
 *  4. Seg-1 fib_500 performance vs post-seg-1 fib_500 (entry-quality drift)
 *  5. Post-segment-1 tape (seg 2+3 combined) — what the market looked like after
 *  6. Entry-mix transition: fib_500-only vs diversified entry cohort
 *
 * STRICTLY REPORT-ONLY:
 *  - Pure function. Zero I/O. No side effects. No behavior influence.
 *  - Reads only from the frozen tape's resolvedObservations (already computed).
 *  - reportOnly: true always set.
 */

import type { FrozenCurrentGuardObservation } from "./base-route-current-guard-frozen.js";

// ─── Output interfaces ────────────────────────────────────────────────────────

export interface PathologyCohortStats {
  n: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface PathologyCounterfactualTrade {
  symbol: string;
  openedAt: string;
  netR: number;
  grossR: number;
  entryVariant: string | null;
  regime: string | null;
}

/** A single sub-analysis result with label, stats, and optional note. */
export interface PathologySubAnalysis {
  label: string;
  description: string;
  stats: PathologyCohortStats;
  excludedCount?: number;
  excludedTrades?: PathologyCounterfactualTrade[];
  note: string;
}

/** Weekly (or date-chunked) batch breakdown within segment 1. */
export interface DateBatchStats {
  batchLabel: string;
  dateRange: { from: string; to: string } | null;
  n: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
}

/** Entry-variant mix row: share of trades using this variant in this slice. */
export interface EntryMixRow {
  entryVariant: string;
  n: number;
  sharePct: number; // 0–100
}

/** Comparison of fib_500 performance in seg 1 vs post-seg-1. */
export interface Fib500Comparison {
  seg1: PathologyCohortStats & { n: number };
  postSeg1: PathologyCohortStats & { n: number };
  /**
   * IMPROVED   — fib_500 netAvgR is higher post-seg-1 than in seg-1
   * STABLE     — within ±0.05 difference
   * WORSENED   — fib_500 netAvgR is lower post-seg-1 (broader problem)
   * INSUFFICIENT_DATA — either slice has n < 3
   */
  signal: "IMPROVED" | "WORSENED" | "STABLE" | "INSUFFICIENT_DATA";
  signalNote: string;
}

/** Entry-mix transition analysis. */
export interface EntryMixTransition {
  seg1Mix: EntryMixRow[];
  postSeg1Mix: EntryMixRow[];
  /** fib_500 share in seg 1 vs post-seg-1 (fraction 0–1). */
  fib500ShareSeg1: number | null;
  fib500SharePostSeg1: number | null;
  /** Did fib_500 usage drop by >15pp from seg1 to post-seg-1? */
  mixDrifted: boolean;
  /** Performance of trades where entryVariant contains "fib_500", across full tape. */
  fib500CohortStats: PathologyCohortStats;
  /** Performance of all OTHER entry variants, across full tape. */
  diversifiedCohortStats: PathologyCohortStats;
  note: string;
}

/**
 * Overall verdict on the pathology:
 *
 * OLD_BATCH   — strong evidence it was an old/transient bad patch:
 *               losses concentrated in narrow date window AND seg1-excl still ≥0
 *               OR seg1-without-top4 turns positive.
 * SYSTEMATIC  — evidence of recurring risk: seg1-excl still negative AND
 *               fib_500 doesn't improve post-seg-1.
 * MIXED       — partial evidence for both; need more data.
 * INSUFFICIENT_DATA — not enough sample to conclude.
 */
export type PathologyVerdict =
  | "OLD_BATCH"
  | "SYSTEMATIC"
  | "MIXED"
  | "INSUFFICIENT_DATA";

export interface FrozenSegmentPathologyAudit {
  reportOnly: true;
  computedAt: string;
  /** Total fresh-valid observations fed in. */
  totalN: number;
  /** Segment 1 raw stats (first third, oldest). */
  seg1Stats: PathologyCohortStats;
  /** Segment 1 size. */
  seg1N: number;
  /** Analysis 1: seg 1 without top-4 worst losses. */
  withoutTop4: PathologySubAnalysis;
  /** Analysis 2: seg 1 excluding problem symbols (SEIUSDT/LINKUSDT/OPUSDT). */
  excludingBadActors: PathologySubAnalysis;
  /** Analysis 3: seg 1 by weekly date batch. */
  seg1ByDateBatch: DateBatchStats[];
  /** Analysis 4: fib_500 entry in seg 1 vs post-seg-1. */
  fib500Comparison: Fib500Comparison;
  /** Analysis 5: post-seg-1 tape (seg 2+3 combined). */
  postSeg1Tape: PathologySubAnalysis;
  /** Analysis 6: entry-mix transition. */
  entryMixTransition: EntryMixTransition;
  /** Overall verdict. */
  verdict: PathologyVerdict;
  verdictReason: string;
}

// ─── Numeric helpers ──────────────────────────────────────────────────────────

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function mean(values: Array<number | null | undefined>): number | null {
  const f = finite(values);
  return f.length === 0 ? null : f.reduce((s, v) => s + v, 0) / f.length;
}

function pf(grosses: Array<number | null | undefined>): number | null {
  let win = 0;
  let loss = 0;
  for (const g of grosses) {
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (g > 0) win += g;
    else if (g < 0) loss += Math.abs(g);
  }
  if (loss === 0) return win > 0 ? null : null; // ∞ or n/a — avoid Infinity in JSON
  return win / loss;
}

function wr(grosses: Array<number | null | undefined>): number | null {
  const f = finite(grosses);
  return f.length === 0 ? null : f.filter((g) => g > 0).length / f.length;
}

function cohortStats(slice: FrozenCurrentGuardObservation[]): PathologyCohortStats {
  return {
    n: slice.length,
    netAvgR: mean(slice.map((o) => o.netR)),
    grossAvgR: mean(slice.map((o) => o.grossR)),
    pf: pf(slice.map((o) => o.grossR)),
    wr: wr(slice.map((o) => o.grossR)),
  };
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ─── Sub-analysis helpers ─────────────────────────────────────────────────────

/** Symbols excluded in analysis 2. */
const BAD_ACTOR_SYMBOLS = new Set(["SEIUSDT", "LINKUSDT", "OPUSDT"]);

function isFib500(entryVariant: string | null | undefined): boolean {
  if (!entryVariant) return false;
  const lc = entryVariant.toLowerCase();
  return lc.includes("fib_500") || lc.includes("fib500");
}

/** ISO week key: YYYY-Www */
function weekKey(isoDate: string | null | undefined): string {
  const ms = toMs(isoDate);
  if (ms === 0) return "UNKNOWN";
  const d = new Date(ms);
  // ISO week: Thursday-based
  const thu = new Date(d.getTime());
  thu.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = Math.ceil(
    (1 + (thu.getTime() - yearStart.getTime()) / 86400000 / 7) / 1,
  );
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function buildDateBatches(seg1: FrozenCurrentGuardObservation[]): DateBatchStats[] {
  if (seg1.length === 0) return [];

  // Group by ISO week first
  const weekMap = new Map<string, FrozenCurrentGuardObservation[]>();
  for (const o of seg1) {
    const k = weekKey(o.closedAt ?? o.openedAt);
    const arr = weekMap.get(k) ?? [];
    arr.push(o);
    weekMap.set(k, arr);
  }
  const weeks = Array.from(weekMap.keys()).sort();

  // If only 1 week (all in same week) → fall back to 3 equal chunks
  if (weeks.length <= 1 && seg1.length >= 3) {
    const chunkSize = Math.ceil(seg1.length / 3);
    const chunks: DateBatchStats[] = [];
    for (let i = 0; i < 3; i++) {
      const slice = seg1.slice(i * chunkSize, (i + 1) * chunkSize);
      if (slice.length === 0) continue;
      const dates = slice.map((o) => o.closedAt ?? o.openedAt).filter(Boolean) as string[];
      dates.sort();
      chunks.push({
        batchLabel: `chunk_${i + 1}`,
        dateRange:
          dates.length > 0 ? { from: dates[0]!.slice(0, 10), to: dates.at(-1)!.slice(0, 10) } : null,
        n: slice.length,
        netAvgR: mean(slice.map((o) => o.netR)),
        grossAvgR: mean(slice.map((o) => o.grossR)),
        wr: wr(slice.map((o) => o.grossR)),
      });
    }
    return chunks;
  }

  // Weekly batches
  return weeks.map((wk) => {
    const slice = weekMap.get(wk)!;
    const dates = slice.map((o) => o.closedAt ?? o.openedAt).filter(Boolean) as string[];
    dates.sort();
    return {
      batchLabel: wk,
      dateRange:
        dates.length > 0 ? { from: dates[0]!.slice(0, 10), to: dates.at(-1)!.slice(0, 10) } : null,
      n: slice.length,
      netAvgR: mean(slice.map((o) => o.netR)),
      grossAvgR: mean(slice.map((o) => o.grossR)),
      wr: wr(slice.map((o) => o.grossR)),
    };
  });
}

function entryMixRows(slice: FrozenCurrentGuardObservation[]): EntryMixRow[] {
  if (slice.length === 0) return [];
  const map = new Map<string, number>();
  for (const o of slice) {
    const k = o.entryVariant ?? "UNKNOWN";
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([entryVariant, n]) => ({ entryVariant, n, sharePct: (n / slice.length) * 100 }))
    .sort((a, b) => b.n - a.n);
}

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build the F***** Segment Pathology Audit from the frozen tape's time-ordered
 * fresh-valid resolved observations.
 *
 * @param resolvedObservations  Time-ordered (closedAt asc) fresh-valid observations
 *                              from FrozenCurrentGuardReport.resolvedObservations.
 * @param capturedAt            Optional ISO timestamp override (for testing).
 */
export function buildFrozenSegmentPathologyAudit(
  resolvedObservations: FrozenCurrentGuardObservation[],
  capturedAt?: string,
): FrozenSegmentPathologyAudit {
  const computedAt = capturedAt ?? new Date().toISOString();
  const all = Array.isArray(resolvedObservations) ? resolvedObservations : [];
  const totalN = all.length;

  // ── Segment boundaries (same split as FrozenCurrentGuardReport) ────────────
  const third = totalN >= 3 ? Math.floor(totalN / 3) : 0;
  const seg1 = all.slice(0, third);
  const postSeg1 = all.slice(third); // seg 2 + seg 3 combined

  const seg1Stats = cohortStats(seg1);

  // ── Analysis 1: Segment 1 without top-4 worst losses ──────────────────────
  const seg1SortedByLoss = [...seg1].sort(
    (a, b) => (a.netR ?? Infinity) - (b.netR ?? Infinity),
  );
  const top4Losses = seg1SortedByLoss
    .filter((o) => typeof o.netR === "number" && o.netR < 0)
    .slice(0, 4);
  const top4Keys = new Set(top4Losses.map((o) => o.observationKey));
  const seg1WithoutTop4 = seg1.filter((o) => !top4Keys.has(o.observationKey));
  const withoutTop4Stats = cohortStats(seg1WithoutTop4);
  const withoutTop4: PathologySubAnalysis = {
    label: "Seg-1 without top-4 losses",
    description:
      "Segment 1 after removing the 4 worst individual netR trades. " +
      "If this turns positive, the segment drag is tail-driven, not broad.",
    stats: withoutTop4Stats,
    excludedCount: top4Losses.length,
    excludedTrades: top4Losses.map((o) => ({
      symbol: o.symbol,
      openedAt: o.openedAt,
      netR: o.netR!,
      grossR: o.grossR!,
      entryVariant: o.entryVariant,
      regime: o.regime,
    })),
    note:
      top4Losses.length > 0 && seg1WithoutTop4.length === 0
        ? `All ${seg1.length} seg-1 trades were heavy losses (none survive top-4 removal) → entirely tail-dominated (old-batch signal)`
        : withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR > 0
        ? "Turns POSITIVE without top-4 → loss is tail-concentrated (old-batch signal)"
        : withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR > -0.05
        ? "Near breakeven without top-4 → loss mostly tail-driven"
        : "Still negative without top-4 → broad systematic drag",
  };

  // ── Analysis 2: Segment 1 excluding SEI/LINK/OP ───────────────────────────
  const seg1ExclBadActors = seg1.filter((o) => !BAD_ACTOR_SYMBOLS.has(o.symbol));
  const excludedBadActors = seg1.filter((o) => BAD_ACTOR_SYMBOLS.has(o.symbol));
  const exclStats = cohortStats(seg1ExclBadActors);
  const excludingBadActors: PathologySubAnalysis = {
    label: "Seg-1 excl. SEIUSDT/LINKUSDT/OPUSDT",
    description:
      "Segment 1 after removing historically problematic symbols (SEI/LINK/OP). " +
      "Tests whether these 3 symbols account for the segment drag.",
    stats: exclStats,
    excludedCount: excludedBadActors.length,
    excludedTrades: excludedBadActors
      .sort((a, b) => (a.netR ?? 0) - (b.netR ?? 0))
      .map((o) => ({
        symbol: o.symbol,
        openedAt: o.openedAt,
        netR: o.netR!,
        grossR: o.grossR!,
        entryVariant: o.entryVariant,
        regime: o.regime,
      })),
    note:
      excludedBadActors.length > 0 && seg1ExclBadActors.length === 0
        ? `All ${seg1.length} seg-1 trades were bad-actor symbols (SEI/LINK/OP) — symbol-specific problem is the entire seg-1 drag (strong old-batch signal)`
        : excludedBadActors.length === 0
        ? "None of SEI/LINK/OP present in seg 1 — drag comes from other symbols"
        : exclStats.netAvgR !== null && exclStats.netAvgR > 0
        ? "Turns POSITIVE without SEI/LINK/OP → symbol-specific problem (old-batch signal)"
        : exclStats.netAvgR !== null && exclStats.netAvgR > -0.03
        ? "Near breakeven — SEI/LINK/OP are main contributors to drag"
        : "Still negative after excl. SEI/LINK/OP → broader symbol pool affected",
  };

  // ── Analysis 3: Segment 1 by date batch ───────────────────────────────────
  const seg1ByDateBatch = buildDateBatches(seg1);
  const batchesWithLoss = seg1ByDateBatch.filter(
    (b) => b.netAvgR !== null && b.netAvgR < 0,
  );
  const lossConcentrated =
    seg1ByDateBatch.length >= 2 &&
    batchesWithLoss.length === 1 &&
    batchesWithLoss[0]!.n >= 2;

  // ── Analysis 4: fib_500 seg-1 vs post-seg-1 ───────────────────────────────
  const seg1Fib = seg1.filter((o) => isFib500(o.entryVariant));
  const postSeg1Fib = postSeg1.filter((o) => isFib500(o.entryVariant));
  const seg1FibStats = cohortStats(seg1Fib);
  const postSeg1FibStats = cohortStats(postSeg1Fib);
  const fibSignal =
    ((): Fib500Comparison["signal"] => {
      if (seg1Fib.length < 3 || postSeg1Fib.length < 3) return "INSUFFICIENT_DATA";
      const s1 = seg1FibStats.netAvgR;
      const p1 = postSeg1FibStats.netAvgR;
      if (s1 === null || p1 === null) return "INSUFFICIENT_DATA";
      const diff = p1 - s1;
      if (diff > 0.05) return "IMPROVED";
      if (diff < -0.05) return "WORSENED";
      return "STABLE";
    })();
  const fibSignalNote = (() => {
    switch (fibSignal) {
      case "IMPROVED":
        return `fib_500 net improved by ${((postSeg1FibStats.netAvgR ?? 0) - (seg1FibStats.netAvgR ?? 0)).toFixed(4)}R post-seg-1 → entry matured / market condition improved`;
      case "WORSENED":
        return `fib_500 net worsened post-seg-1 → systematic fib_500 degradation signal`;
      case "STABLE":
        return `fib_500 performance stable across segments → entry type not the primary cause of seg-1 drag`;
      default:
        return `Insufficient fib_500 trades in seg-1 (n=${seg1Fib.length}) or post-seg-1 (n=${postSeg1Fib.length}) to compare`;
    }
  })();
  const fib500Comparison: Fib500Comparison = {
    seg1: { ...seg1FibStats },
    postSeg1: { ...postSeg1FibStats },
    signal: fibSignal,
    signalNote: fibSignalNote,
  };

  // ── Analysis 5: Post-seg-1 tape (seg 2+3 combined) ────────────────────────
  const postSeg1Stats = cohortStats(postSeg1);
  const postSeg1Tape: PathologySubAnalysis = {
    label: "Post-seg-1 tape (seg 2+3 combined)",
    description:
      "Performance of the entire tape excluding the oldest-third segment. " +
      "Represents the market environment AFTER the segment-1 period ended.",
    stats: postSeg1Stats,
    note:
      postSeg1Stats.netAvgR !== null && postSeg1Stats.netAvgR > 0
        ? `Post-seg-1 net=${postSeg1Stats.netAvgR.toFixed(4)} > 0 — edge recovered after seg-1 period`
        : `Post-seg-1 net=${postSeg1Stats.netAvgR?.toFixed(4) ?? "n/a"} — edge has not recovered`,
  };

  // ── Analysis 6: Entry-mix transition ──────────────────────────────────────
  const seg1Mix = entryMixRows(seg1);
  const postSeg1Mix = entryMixRows(postSeg1);
  const fib500Seg1 = seg1Mix.find((r) => isFib500(r.entryVariant));
  const fib500PostSeg1 = postSeg1Mix.find((r) => isFib500(r.entryVariant));
  const fib500ShareSeg1 = fib500Seg1 ? fib500Seg1.sharePct / 100 : 0;
  const fib500SharePostSeg1 = fib500PostSeg1 ? fib500PostSeg1.sharePct / 100 : 0;
  const mixDrifted =
    seg1.length >= 3 && postSeg1.length >= 3 &&
    fib500ShareSeg1 - fib500SharePostSeg1 > 0.15;

  const allFib500 = all.filter((o) => isFib500(o.entryVariant));
  const allOther = all.filter((o) => !isFib500(o.entryVariant));
  const fib500CohortStats = cohortStats(allFib500);
  const diversifiedCohortStats = cohortStats(allOther);

  const mixNote = (() => {
    const parts: string[] = [];
    if (seg1.length > 0) {
      parts.push(
        `Seg-1 fib_500 share: ${(fib500ShareSeg1 * 100).toFixed(0)}%`,
      );
    }
    if (postSeg1.length > 0) {
      parts.push(
        `Post-seg-1 fib_500 share: ${(fib500SharePostSeg1 * 100).toFixed(0)}%`,
      );
    }
    if (mixDrifted) {
      parts.push(
        `Mix drifted >15pp away from fib_500 — entry diversification increased`,
      );
    } else if (seg1.length >= 3 && postSeg1.length >= 3) {
      parts.push(`Entry mix stable across segments`);
    }
    if (allFib500.length > 0 && allOther.length > 0) {
      const fibNet = fib500CohortStats.netAvgR;
      const otherNet = diversifiedCohortStats.netAvgR;
      if (fibNet !== null && otherNet !== null) {
        parts.push(
          fibNet < otherNet
            ? `fib_500 underperforms other entries (${fibNet.toFixed(4)} vs ${otherNet.toFixed(4)}) — systematic fib_500 drag`
            : `fib_500 performs on par or above other entries`,
        );
      }
    }
    return parts.join("; ");
  })();

  const entryMixTransition: EntryMixTransition = {
    seg1Mix,
    postSeg1Mix,
    fib500ShareSeg1: seg1.length > 0 ? fib500ShareSeg1 : null,
    fib500SharePostSeg1: postSeg1.length > 0 ? fib500SharePostSeg1 : null,
    mixDrifted,
    fib500CohortStats,
    diversifiedCohortStats,
    note: mixNote,
  };

  // ── Verdict ────────────────────────────────────────────────────────────────
  const verdict: PathologyVerdict = (() => {
    if (totalN < 9) return "INSUFFICIENT_DATA";
    if (seg1.length < 3) return "INSUFFICIENT_DATA";

    const s1Net = seg1Stats.netAvgR;
    if (s1Net === null) return "INSUFFICIENT_DATA";
    if (s1Net >= 0) {
      // seg 1 is actually fine — shouldn't be called but handle gracefully
      return "INSUFFICIENT_DATA";
    }

    // Evidence for OLD_BATCH (transient):
    // (a) without top-4 turns positive
    // (b) excl. bad-actor symbols turns positive
    // (c) losses concentrated in 1 date batch
    // (d) fib_500 improves post-seg-1
    // (e) entry mix drifted away from problem entry

    // n=0 remaining after removal means ALL trades were heavy losses / bad actors
    // → entirely tail-dominated or entirely symbol-specific — both are old-batch signals
    const turnsPositiveWithoutTop4 =
      (withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR > 0) ||
      (top4Losses.length > 0 && seg1WithoutTop4.length === 0);
    const turnsPositiveExclBadActors =
      (exclStats.netAvgR !== null && exclStats.netAvgR > 0) ||
      (excludedBadActors.length > 0 && seg1ExclBadActors.length === 0);
    const fibImproved = fibSignal === "IMPROVED";

    const oldBatchSignals = [
      turnsPositiveWithoutTop4,
      turnsPositiveExclBadActors,
      lossConcentrated,
      fibImproved,
      mixDrifted,
    ].filter(Boolean).length;

    // Evidence for SYSTEMATIC (recurring):
    // (a) still negative without top-4
    // (b) still negative excl. bad actors
    // (c) fib_500 WORSENED post-seg-1
    // (d) fib500 cohort globally underperforms other entries

    const stillNegativeWithoutTop4 =
      withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR < -0.03;
    const stillNegativeExclBadActors =
      exclStats.netAvgR !== null && exclStats.netAvgR < -0.03;
    const fibWorsened = fibSignal === "WORSENED";
    const fib500DragsGlobally =
      allFib500.length >= 3 &&
      fib500CohortStats.netAvgR !== null &&
      diversifiedCohortStats.netAvgR !== null &&
      fib500CohortStats.netAvgR < diversifiedCohortStats.netAvgR - 0.05;

    const systematicSignals = [
      stillNegativeWithoutTop4,
      stillNegativeExclBadActors,
      fibWorsened,
      fib500DragsGlobally,
    ].filter(Boolean).length;

    if (oldBatchSignals >= 3 && systematicSignals <= 1) return "OLD_BATCH";
    if (systematicSignals >= 3 && oldBatchSignals <= 1) return "SYSTEMATIC";
    return "MIXED";
  })();

  const verdictReason = (() => {
    const s1Net = seg1Stats.netAvgR;
    switch (verdict) {
      case "OLD_BATCH":
        return (
          `Seg-1 net=${s1Net?.toFixed(4) ?? "n/a"} but multiple old-batch indicators present: ` +
          [
            withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR > 0
              ? `without-top-4 → +${withoutTop4Stats.netAvgR.toFixed(4)}`
              : null,
            exclStats.netAvgR !== null && exclStats.netAvgR > 0
              ? `excl-bad-actors → +${exclStats.netAvgR.toFixed(4)}`
              : null,
            lossConcentrated ? "losses in 1 date batch" : null,
            fibSignal === "IMPROVED" ? "fib_500 improved post-seg-1" : null,
            mixDrifted ? "entry mix drifted" : null,
          ]
            .filter(Boolean)
            .join(", ")
        );
      case "SYSTEMATIC":
        return (
          `Seg-1 net=${s1Net?.toFixed(4) ?? "n/a"} with systematic risk indicators: ` +
          [
            withoutTop4Stats.netAvgR !== null && withoutTop4Stats.netAvgR < -0.03
              ? `without-top-4 still ${withoutTop4Stats.netAvgR.toFixed(4)}`
              : null,
            exclStats.netAvgR !== null && exclStats.netAvgR < -0.03
              ? `excl-bad-actors still ${exclStats.netAvgR.toFixed(4)}`
              : null,
            fibSignal === "WORSENED" ? "fib_500 worsened post-seg-1" : null,
          ]
            .filter(Boolean)
            .join(", ")
        );
      case "MIXED":
        return (
          `Seg-1 net=${s1Net?.toFixed(4) ?? "n/a"} — mixed signals; ` +
          `without-top-4 net=${withoutTop4Stats.netAvgR?.toFixed(4) ?? "n/a"}, ` +
          `excl-bad-actors net=${exclStats.netAvgR?.toFixed(4) ?? "n/a"}, ` +
          `fib_500 signal=${fibSignal}. ` +
          `Needs more data to distinguish transient vs systematic.`
        );
      default:
        return `Insufficient data (totalN=${totalN}, seg1N=${seg1.length}) for pathology verdict`;
    }
  })();

  return {
    reportOnly: true,
    computedAt,
    totalN,
    seg1Stats,
    seg1N: seg1.length,
    withoutTop4,
    excludingBadActors,
    seg1ByDateBatch,
    fib500Comparison,
    postSeg1Tape,
    entryMixTransition,
    verdict,
    verdictReason,
  };
}

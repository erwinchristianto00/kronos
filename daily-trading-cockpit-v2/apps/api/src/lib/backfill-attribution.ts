/**
 * Historical backfill — strict attribution (Phase 3 / requirement #3). Generalizes the audited
 * cortex-attribution matcher to the normalized schema and to symbol/basket-level identity. For each OUTCOME,
 * find the LATEST eligible decision that occurred at/before the open, with the SAME identity
 * (lane, symbol/basket, side) and the SAME feature schema, within a bounded TTL. Contract:
 *   • one outcomeId may be attributed only once (consume-once),
 *   • a single close may never label multiple decision ticks (we pick exactly one owner),
 *   • a stale-schema in-window decision must NOT shadow an older current-schema owner,
 *   • every unattributed outcome is counted with a reason (never silently dropped).
 * Pure + deterministic.
 */
import type { HistoricalDecision, HistoricalOutcome } from "./backfill-schema.js";

export const BACKFILL_ATTR_DEFAULT_TTL_MS = 50 * 60_000;

export interface AttributionOpts {
  schemaVersion: number;
  ttlMsForLane?: (laneId: string) => number;
  requireEligible?: boolean;
  /** Require decision.laneId === outcome.laneId (default true). False ⇒ a MARKET-WIDE decision stream
   *  (e.g. the market-state/direction snapshot) can own a per-lane outcome by time alone. */
  matchLane?: boolean;
  /** Require decision.symbolOrBasket === outcome.symbolOrBasket (default true). */
  matchSymbol?: boolean;
  /** Require decision.side === outcome.side (default true). */
  matchSide?: boolean;
}

export interface AttributedPair {
  decision: HistoricalDecision;
  outcome: HistoricalOutcome;
}

export type AttributionDropReason =
  | "bad-timestamps"
  | "duplicate-outcome"
  | "no-eligible-decision"
  | "schema-mismatch";

export interface AttributionDiagnostics {
  /** decision→open lag of attributed pairs (owner.atMs → outcome.openedAtMs), ms. A big p95/max vs the TTL
   *  means many "matches" are only technically valid because they sit near the TTL edge. */
  lagMs: { p50: number | null; p95: number | null; max: number | null };
  /** how many in-window candidate decisions each attributed outcome had (1 = unambiguous owner). */
  candidatesPerOutcome: { p50: number | null; p95: number | null; max: number | null; singleCandidatePct: number };
  /** fraction of attributed pairs whose lag exceeds 0.9×TTL (semantically weak, near-expiry matches). */
  nearTtlPct: number;
  /** decision-side funnel: of all decision ticks, how many were ever used as an owner vs never (expired). */
  decisionSide: { totalDecisions: number; usedAsOwner: number; neverUsedAsOwner: number; neverUsedPct: number };
}

export interface AttributionResult {
  pairs: AttributedPair[];
  drops: Array<{ outcomeId: string; laneId: string; reason: AttributionDropReason }>;
  counts: {
    outcomesSeen: number;
    attributed: number;
    duplicate: number;
    schemaMismatch: number;
    noDecision: number;
    badTimestamps: number;
  };
  diagnostics: AttributionDiagnostics;
  maxResolvedAtMs: number;
}

function pctl(xs: number[], q: number): number | null {
  const u = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (u.length === 0) return null;
  return u[Math.min(u.length - 1, Math.max(0, Math.round(q * (u.length - 1))))]!;
}
/** count of slices with atMs in [lo, hi] via binary bounds on an ascending-atMs array. */
function countInWindow(slices: HistoricalDecision[], lo: number, hi: number): number {
  const lb = (target: number) => { let a = 0, b = slices.length; while (a < b) { const m = (a + b) >> 1; if (slices[m]!.atMs < target) a = m + 1; else b = m; } return a; };
  const ub = (target: number) => { let a = 0, b = slices.length; while (a < b) { const m = (a + b) >> 1; if (slices[m]!.atMs <= target) a = m + 1; else b = m; } return a; };
  return ub(hi) - lb(lo);
}

function identity(laneId: string, symbol: string | null, side: string | null, matchLane: boolean, matchSymbol: boolean, matchSide: boolean): string {
  return `${matchLane ? laneId : ""}|${matchSymbol ? symbol ?? "" : ""}|${matchSide ? side ?? "" : ""}`;
}

export function attributeHistorical(
  decisions: HistoricalDecision[],
  outcomes: HistoricalOutcome[],
  opts: AttributionOpts,
): AttributionResult {
  const matchLane = opts.matchLane !== false;
  const matchSymbol = opts.matchSymbol !== false;
  const matchSide = opts.matchSide !== false;
  const ttlFor = opts.ttlMsForLane ?? (() => BACKFILL_ATTR_DEFAULT_TTL_MS);

  // Index decisions by identity, ascending by time (so a reverse walk finds the LATEST owner first).
  const byKey = new Map<string, HistoricalDecision[]>();
  for (const d of decisions) {
    if (!Number.isFinite(d.atMs)) continue;
    const k = identity(d.laneId, d.symbolOrBasket, d.side, matchLane, matchSymbol, matchSide);
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, (arr = []));
    arr.push(d);
  }
  for (const arr of byKey.values()) arr.sort((a, b) => a.atMs - b.atMs);

  const pairs: AttributedPair[] = [];
  const drops: AttributionResult["drops"] = [];
  const counts = { outcomesSeen: 0, attributed: 0, duplicate: 0, schemaMismatch: 0, noDecision: 0, badTimestamps: 0 };
  const consumed = new Set<string>();
  let maxResolvedAtMs = 0;
  // Diagnostics accumulators (Lock 2 — prove 100% attribution isn't a semantically-weak artifact).
  const lags: number[] = [];
  const candCounts: number[] = [];
  const ownerIds = new Set<string>();
  let nearTtl = 0;

  // Oldest resolved first — stable + makes the watermark obvious.
  const sorted = [...outcomes].sort(
    (a, b) => a.resolvedAtMs - b.resolvedAtMs || a.laneId.localeCompare(b.laneId) || a.outcomeId.localeCompare(b.outcomeId),
  );

  for (const o of sorted) {
    counts.outcomesSeen += 1;
    if (!Number.isFinite(o.openedAtMs) || !Number.isFinite(o.resolvedAtMs) || o.resolvedAtMs < o.openedAtMs) {
      counts.badTimestamps += 1;
      drops.push({ outcomeId: o.outcomeId, laneId: o.laneId, reason: "bad-timestamps" });
      continue;
    }
    const dedupeKey = `${o.laneId}::${o.outcomeId}`;
    if (consumed.has(dedupeKey)) {
      counts.duplicate += 1;
      drops.push({ outcomeId: o.outcomeId, laneId: o.laneId, reason: "duplicate-outcome" });
      continue;
    }

    const k = identity(o.laneId, o.symbolOrBasket, o.side, matchLane, matchSymbol, matchSide);
    const slices = byKey.get(k);
    const ttl = Math.max(0, ttlFor(o.laneId));
    const lo = o.openedAtMs - ttl;

    let owner: HistoricalDecision | null = null;
    let sawSchemaMismatch = false;
    if (slices) {
      for (let i = slices.length - 1; i >= 0; i -= 1) {
        const s = slices[i]!;
        if (s.atMs > o.openedAtMs) continue; // decision after open ⇒ cannot own it
        if (s.atMs < lo) break; // past TTL window; everything earlier is older still
        if (opts.requireEligible && !s.eligible) continue;
        if (s.schemaVersion !== opts.schemaVersion) {
          sawSchemaMismatch = true; // in-window but stale schema — keep searching older (don't let it shadow)
          continue;
        }
        owner = s;
        break;
      }
    }

    if (!owner) {
      if (sawSchemaMismatch) {
        counts.schemaMismatch += 1;
        drops.push({ outcomeId: o.outcomeId, laneId: o.laneId, reason: "schema-mismatch" });
      } else {
        counts.noDecision += 1;
        drops.push({ outcomeId: o.outcomeId, laneId: o.laneId, reason: "no-eligible-decision" });
      }
      continue;
    }

    consumed.add(dedupeKey);
    counts.attributed += 1;
    pairs.push({ decision: owner, outcome: o });
    // Diagnostics: lag, in-window candidate count, near-TTL flag, owner usage.
    const lag = o.openedAtMs - owner.atMs;
    lags.push(lag);
    candCounts.push(slices ? countInWindow(slices, lo, o.openedAtMs) : 0);
    if (ttl > 0 && lag > 0.9 * ttl) nearTtl += 1;
    ownerIds.add(owner.decisionId);
    if (o.resolvedAtMs > maxResolvedAtMs) maxResolvedAtMs = o.resolvedAtMs;
  }

  const totalDecisions = decisions.length;
  const usedAsOwner = ownerIds.size;
  const attributedN = counts.attributed;
  const diagnostics: AttributionDiagnostics = {
    lagMs: { p50: pctl(lags, 0.5), p95: pctl(lags, 0.95), max: pctl(lags, 1) },
    candidatesPerOutcome: {
      p50: pctl(candCounts, 0.5), p95: pctl(candCounts, 0.95), max: pctl(candCounts, 1),
      singleCandidatePct: candCounts.length ? candCounts.filter((c) => c <= 1).length / candCounts.length : 0,
    },
    nearTtlPct: attributedN ? nearTtl / attributedN : 0,
    decisionSide: {
      totalDecisions, usedAsOwner, neverUsedAsOwner: totalDecisions - usedAsOwner,
      neverUsedPct: totalDecisions ? (totalDecisions - usedAsOwner) / totalDecisions : 0,
    },
  };

  return { pairs, drops, counts, diagnostics, maxResolvedAtMs };
}

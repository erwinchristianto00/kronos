/**
 * Regime edge memory — the adaptive core of the smart direction gate.
 *
 * The naive chain decided direction from a momentary trend vote ("≥4 more
 * symbols trending up → Bullish expansion → LONG_ONLY") with ZERO memory of
 * whether that direction has ever made money. This store fixes that: it
 * remembers the realized, HONESTLY-ACCOUNTED edge of every (regimeFamily ×
 * direction) slice and lets the controller hard-veto a direction that has
 * proven negative — so the system can never again authorize a direction that
 * loses money just because price momentarily points that way.
 *
 * Edge = a FROZEN seed prior (computed once from the honestly re-resolved
 * backup) PLUS a live aggregate rebuilt from the current paper store's closed
 * orders. Rebuilding the live part each cycle is idempotent (no double-count,
 * no per-order bookkeeping) and the seed keeps the system smart from day one
 * even though the live store was reset to empty.
 *
 * Honest accounting is a hard prerequisite: only netR from orders that actually
 * closed (TP / SL / 72h max-hold MTM) may feed this. Before the phantom-equity
 * fix, winners closed and losers drifted open — feeding that skew here would
 * teach the gate the exact lie it exists to prevent.
 *
 * ── POINT 5 HARDENING (2026-08-02) — "stays a heuristic, not a claim of proof" ──
 * This store used to label ALLOW_PROVEN from raw `n` (a row count that several
 * symbols firing off ONE market-wide regime reading at the same instant can
 * inflate — this repo's own documented failure mode) and a point-estimate
 * `avgNetR` (which reads "positive" purely from variance at small sample sizes).
 * It also let a seed-only slice (zero live trades) reach ALLOW_PROVEN or
 * VETO_NEGATIVE on its own, and pooled orders from different cost-model
 * generations / policy-deployment eras into one average.
 *
 * The gate (`edgeVerdict`) now reads two STRICT fields instead:
 *   - `effectiveN`   — distinct independent (symbol × time-block) evidence count
 *                       (edge-lower-bound.ts's `computeEffectiveN`), never raw n.
 *   - `conservativeLowerBoundR` — a one-sided lower confidence bound on the mean
 *                       (edge-lower-bound.ts's `conservativeLowerBoundR`), never
 *                       the raw point-estimate `avgNetR`.
 * Both are computed ONLY from the live aggregate's CURRENT cohort: the newest
 * cost-model generation (paper-cost-cohort.ts's `selectNewestCostCohort`,
 * exactly as-is — never a new cohort rule), the current policy-deployment era
 * when one is resolvable (mirrors four-brain-economic-experience.ts's
 * STALE_POLICY_CONTEXT exact-equality discipline), and within a rolling
 * freshness lookback. `seed()` never populates either field (it has no raw
 * per-order evidence to cluster), so a seed-only stat's `effectiveN` is
 * structurally 0 and its `conservativeLowerBoundR` structurally null — it can
 * NEVER, by itself, reach ALLOW_PROVEN or VETO_NEGATIVE, only the cold-start
 * ALLOW_INSUFFICIENT tier. `n`/`avgNetR`/`winRate` are kept as before (summed
 * seed+live, informational only) so existing telemetry/model-input consumers
 * (e.g. cortex-live-gather.ts's `edgeMemN`/`edgeMemAvgNetR`) are unaffected —
 * only the ALLOW_PROVEN/VETO_NEGATIVE GATE itself reads the strict fields.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { resolveEndToEndCorrectnessDeploymentAt } from "@dtc/shared";

import { computeEffectiveN, conservativeLowerBoundR as computeConservativeLowerBoundR } from "./edge-lower-bound.js";
import { selectNewestCostCohort, type CostModelStamped } from "./paper-cost-cohort.js";
import { applySubFloorExclusionForDecisions } from "./paper-subfloor-exclusion.js";

export type EdgeDirection = "LONG" | "SHORT";
export type RegimeFamily = "BULLISH_EXPANSION" | "BEARISH_EXPANSION" | "MIXED_ROTATION" | "OTHER";

export interface EdgeStat {
  /** Raw HEADLINE-closed row count in the (seed+live) merged slice. Informational only — never the
   *  sample-size gate input (see `effectiveN` below). */
  n: number;
  wins: number;
  sumNetR: number;
  avgNetR: number;
  winRate: number;
  /** STRICT gate input: distinct independent (symbol × time-block) evidence count, over the LIVE
   *  cohort's current-cost-generation, current-policy-era, in-lookback rows only (see module doc).
   *  Always 0 for a slice with no such live evidence — in particular, always 0 for a seed-only slice,
   *  by construction (seed() never sets this). */
  effectiveN: number;
  /** STRICT gate input: one-sided conservative lower bound on mean netR over the same live cohort
   *  `effectiveN` was computed from. Null when there isn't enough independent evidence to bound
   *  (effectiveN < 2) — in particular, always null for a seed-only slice. NEVER the raw point-estimate
   *  `avgNetR`. */
  conservativeLowerBoundR: number | null;
}

export type EdgeVerdictDecision = "ALLOW_PROVEN" | "ALLOW_INSUFFICIENT" | "VETO_NEGATIVE";

export interface EdgeVerdict {
  decision: EdgeVerdictDecision;
  reasonCode: string;
  allowed: boolean;
  stat: EdgeStat;
}

/**
 * Minimum INDEPENDENT (effectiveN) closed-trade sample before an edge is "proven". Below this a
 * slice is cold-start: per the operator's choice it is ALLOWED (no shadow wait), but the verdict
 * still flags it so sizing/telemetry can stay cautious. Unchanged by Point 5 — only what's compared
 * against it (effectiveN, not raw n) changed. `direction-brain.test.ts` locks
 * `DIRECTION_EDGE_MIN_SAMPLES === EDGE_MIN_SAMPLES === 30`; do not change this constant.
 */
export const EDGE_MIN_SAMPLES = 30;
/**
 * A proven slice is only allowed when its CONSERVATIVE LOWER BOUND on netR (never the raw point
 * estimate) clears this margin. We require strictly-positive (not merely break-even) because a
 * near-zero edge does not survive real-world execution-cost variance. Proven slices at or below
 * this are hard-vetoed.
 */
export const EDGE_MIN_POSITIVE_AVG_R = 0;

/**
 * Deliberately conservative independence-clustering window for `effectiveN`. This store pools
 * evidence across many symbols/lanes within one regimeFamily × direction slice, so — unlike
 * lane-edge-report-fields.ts's per-lane hold-period-derived block width — a single fixed width is
 * used: comfortably wider than this repo's scan/tick cadence (minutes) so several symbols firing off
 * ONE market-wide regime reading at the same instant collapse into one block (this repo's own
 * documented failure mode — see CLAUDE.md), while remaining far shorter than a typical closed-order
 * hold (hours, up to the 72h max-hold) so genuinely separated trading episodes still count
 * separately.
 */
export const EDGE_MEMORY_BLOCK_WIDTH_MS = 60 * 60 * 1000;

/**
 * Rolling lookback for "current" live-cohort proof evidence. A row can be post-cutover (same policy
 * era) and still be too old to represent current market conditions; this bounds that independently
 * of the cutover-marker check below. Does NOT affect the informational `n`/`avgNetR` — only the
 * strict `effectiveN`/`conservativeLowerBoundR` gate inputs.
 */
export const EDGE_MEMORY_FRESHNESS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeRegimeFamily(raw: string | null | undefined): RegimeFamily {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("bullish") && (s.includes("expansion") || s.includes("pressure") || s.includes("breakout"))) {
    return "BULLISH_EXPANSION";
  }
  if (s.includes("bearish") && (s.includes("expansion") || s.includes("pressure") || s.includes("breakdown"))) {
    return "BEARISH_EXPANSION";
  }
  if (s.includes("mixed") || s.includes("rotation")) return "MIXED_ROTATION";
  return "OTHER";
}

function statKey(regime: RegimeFamily, direction: EdgeDirection): string {
  return `${regime}::${direction}`;
}

function emptyStat(): EdgeStat {
  return { n: 0, wins: 0, sumNetR: 0, avgNetR: 0, winRate: 0, effectiveN: 0, conservativeLowerBoundR: null };
}

function finalizeStat(s: EdgeStat): EdgeStat {
  s.avgNetR = s.n > 0 ? s.sumNetR / s.n : 0;
  s.winRate = s.n > 0 ? (100 * s.wins) / s.n : 0;
  return s;
}

/** Combine two independent lower bounds conservatively: whichever side actually carries real
 *  evidence wins; if BOTH somehow carry real evidence (never true for seed+live given seed()
 *  structurally never sets this — see module doc), report the WORSE (lower) of the two, never the
 *  better — merging must never make the bound look more favorable than either side alone. */
function combineLowerBounds(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function mergeStat(a: EdgeStat, b: EdgeStat): EdgeStat {
  return finalizeStat({
    n: a.n + b.n,
    wins: a.wins + b.wins,
    sumNetR: a.sumNetR + b.sumNetR,
    avgNetR: 0,
    winRate: 0,
    // Seed's effectiveN is structurally always 0 (seed() never sets it), so this sum equals the
    // live side alone — merging can never manufacture independent evidence out of a seed prior.
    effectiveN: a.effectiveN + b.effectiveN,
    conservativeLowerBoundR: combineLowerBounds(a.conservativeLowerBoundR, b.conservativeLowerBoundR),
  });
}

/**
 * Pure verdict from a stat — no I/O, so the controller, allocator and tests share one rule.
 *  - effectiveN < MIN_SAMPLES                                    → ALLOW_INSUFFICIENT (cold-start)
 *  - effectiveN ≥ MIN_SAMPLES, lower bound ≤ margin OR unbounded  → VETO_NEGATIVE (proven non-positive)
 *  - effectiveN ≥ MIN_SAMPLES, lower bound > margin               → ALLOW_PROVEN (proven positive)
 * A seed-only stat has effectiveN=0 and conservativeLowerBoundR=null by construction, so it can only
 * ever land in the first branch — seed data can never, by itself, produce ALLOW_PROVEN OR
 * VETO_NEGATIVE (Point 5d).
 */
export function edgeVerdict(stat: EdgeStat): EdgeVerdict {
  if (stat.effectiveN < EDGE_MIN_SAMPLES) {
    return { decision: "ALLOW_INSUFFICIENT", reasonCode: "EDGE_INSUFFICIENT_SAMPLES", allowed: true, stat };
  }
  if (stat.conservativeLowerBoundR === null || stat.conservativeLowerBoundR <= EDGE_MIN_POSITIVE_AVG_R) {
    return { decision: "VETO_NEGATIVE", reasonCode: "EDGE_PROVEN_NEGATIVE", allowed: false, stat };
  }
  return { decision: "ALLOW_PROVEN", reasonCode: "EDGE_PROVEN_POSITIVE", allowed: true, stat };
}

/** Minimal shape of a closed paper order needed to aggregate live edge. */
export interface ClosedOrderLike extends CostModelStamped {
  paperStatus: string;
  direction: EdgeDirection | string;
  regime?: string | null;
  netR?: number | null;
  paperOrderMode?: string | null;
  diagnosticLabel?: string | null;
  selectedLaneId?: string | null;
  /** T1-b: read only by the sub-admission-floor predicate. Absent ⇒ row is never excluded. */
  sourceType?: string | null;
  plannedStopDistanceBps?: number | null;
  /** Point 5: symbol, for the (symbol × time-block) independence key. Absent ⇒ the row falls into a
   *  single "UNKNOWN" symbol bucket, which is CONSERVATIVE (more likely to collide with other rows'
   *  blocks, never less) rather than fabricating a distinct identity. */
  symbol?: string | null;
  /** Point 5: resolution clock (ms), preferred for time-block clustering + freshness/cutover checks.
   *  Mirrors PaperOrder's own `resolvedAtMs` (PROCESS persistence time). */
  resolvedAtMs?: number | null;
  /** Fallback resolution clock when `resolvedAtMs` is absent — mirrors PaperOrder's own `closedAtMs`
   *  (candle-granularity MARKET time). A row with NEITHER cannot be clustered or freshness-checked
   *  and is excluded from `effectiveN`/`conservativeLowerBoundR` (never assigned a fabricated "now"). */
  closedAtMs?: number | null;
  /** Point 5f: the runtime policy-deployment boundary this row was decided/opened under
   *  (paper-execution-router.ts's own `PaperOrder.policyDeploymentAt`, `@dtc/shared`'s
   *  `resolveEndToEndCorrectnessDeploymentAt()`). Exact-match discipline against the currently
   *  resolved marker — mirrors four-brain-economic-experience.ts's STALE_POLICY_CONTEXT check, never
   *  a "close enough"/windowed comparison. */
  policyDeploymentAt?: string | null;
}

interface EdgeMemoryState {
  version: 1;
  /** Frozen prior from the honest backup re-resolve. Never mutated by live trading. */
  seedStats: Record<string, EdgeStat>;
  /** Derived aggregate of the live paper store's closed orders. Rebuilt each cycle. */
  liveStats: Record<string, EdgeStat>;
  /** Lane-level prior — keyed `${regime}::${direction}::${lane}`. Lets a positive
   *  lane (e.g. tight-stop SHORT) trade even when the direction aggregate is
   *  negative (dominated by a losing lane like the wide-stop SHORT). */
  laneSeedStats: Record<string, EdgeStat>;
  laneLiveStats: Record<string, EdgeStat>;
  seededAt: string | null;
  seedSource: string | null;
  liveUpdatedAt: string | null;
}

export interface EdgeSeedRow {
  regime: RegimeFamily | string;
  direction: EdgeDirection;
  /** Variant id (lane). When set, this row seeds a LANE-level slice. */
  lane?: string;
  n: number;
  wins: number;
  sumNetR: number;
}

/** Extract the variant id (lane) from a selectedLaneId like "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE". */
export function laneOf(selectedLaneId: string | null | undefined): string {
  const s = selectedLaneId ?? "";
  const i = s.lastIndexOf(":");
  return i >= 0 ? s.slice(i + 1) : s || "UNKNOWN";
}

/** The order's resolution clock (ms), preferring `resolvedAtMs` over `closedAtMs`. Null when neither
 *  is a finite number — such a row cannot be placed in a time block and is never assigned one. */
function resolvedTimeMsOf(o: ClosedOrderLike): number | null {
  if (typeof o.resolvedAtMs === "number" && Number.isFinite(o.resolvedAtMs)) return o.resolvedAtMs;
  if (typeof o.closedAtMs === "number" && Number.isFinite(o.closedAtMs)) return o.closedAtMs;
  return null;
}

/** True when `resolvedMs` is within the freshness lookback of `nowMs` and not future-dated beyond a
 *  small clock-skew tolerance (mirrors lane-edge-report-fields.ts's `fresh` idiom). */
function isFreshCurrentEvidence(resolvedMs: number, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (resolvedMs > nowMs + 60_000) return false; // future timestamp ⇒ untrusted clock, never "fresh"
  return nowMs - resolvedMs <= EDGE_MEMORY_FRESHNESS_LOOKBACK_MS;
}

function isHeadlineClosedOrder(o: ClosedOrderLike): o is ClosedOrderLike & { direction: EdgeDirection; netR: number } {
  if (o.paperStatus !== "PAPER_CLOSED_WIN" && o.paperStatus !== "PAPER_CLOSED_LOSS") return false;
  if (o.paperOrderMode === "DIAGNOSTIC_ONLY" || o.diagnosticLabel === "BACKFILL_DIAGNOSTIC") return false;
  if (o.direction !== "LONG" && o.direction !== "SHORT") return false;
  if (typeof o.netR !== "number" || !Number.isFinite(o.netR)) return false;
  return true;
}

function pushGroup(m: Map<string, ClosedOrderLike[]>, k: string, o: ClosedOrderLike): void {
  const arr = m.get(k);
  if (arr) arr.push(o);
  else m.set(k, [o]);
}

/**
 * Build one live-cohort EdgeStat from a group of same-slice HEADLINE closed orders.
 *  1. Cost cohort — never pool two cost-model generations (paper-cost-cohort.ts, used exactly
 *     as-is). `minRows=1`: a single-generation cohort of any size is internally comparable; a small
 *     sample is what `effectiveN`/`EDGE_MIN_SAMPLES` gates below, not this step.
 *  2. Cutover — once a current policy-deployment marker is resolvable, only rows stamped with that
 *     EXACT marker count (mirrors four-brain-economic-experience.ts's STALE_POLICY_CONTEXT exact-
 *     equality check). No marker resolvable (e.g. env unset) ⇒ no cutover has been declared yet, so
 *     this step is a no-op rather than a block-everything default.
 * `n`/`wins`/`sumNetR`/`avgNetR`/`winRate` are informational and computed from steps 1–2 only (kept
 * lenient so existing non-gating telemetry consumers are unaffected). `effectiveN` and
 * `conservativeLowerBoundR` — the STRICT gate inputs — additionally require a resolvable, in-lookback
 * timestamp (step 3); a row failing that can still count toward the informational fields but can
 * never, by itself, support a PROVEN verdict.
 */
function buildLiveStat(
  group: readonly ClosedOrderLike[],
  currentPolicyDeploymentAt: string | null,
  nowMs: number,
): EdgeStat {
  const cohort = selectNewestCostCohort(group, 1);
  const costCurrent = cohort ? cohort.rows : [];
  const current = currentPolicyDeploymentAt == null
    ? costCurrent
    : costCurrent.filter((o) => o.policyDeploymentAt === currentPolicyDeploymentAt);

  const stat = emptyStat();
  for (const o of current) {
    stat.n += 1;
    stat.wins += (o.netR as number) > 0 ? 1 : 0;
    stat.sumNetR += o.netR as number;
  }

  const provable = current.filter((o) => {
    const t = resolvedTimeMsOf(o);
    return t !== null && isFreshCurrentEvidence(t, nowMs);
  });
  const effectiveN = computeEffectiveN(
    provable,
    (o) => `${o.symbol ?? "UNKNOWN"}:${Math.floor((resolvedTimeMsOf(o) as number) / EDGE_MEMORY_BLOCK_WIDTH_MS)}`,
  );
  const netRs = provable.map((o) => o.netR as number);
  stat.effectiveN = effectiveN;
  stat.conservativeLowerBoundR = computeConservativeLowerBoundR(netRs, effectiveN);

  return finalizeStat(stat);
}

export class RegimeEdgeMemoryStore {
  private readonly file: string;
  private state: EdgeMemoryState;
  private readonly now: () => string;
  /** Injectable for tests; defaults to the repo-canonical resolver (`@dtc/shared`). Returns null when
   *  no deployment boundary is configured for this runtime (see buildLiveStat's cutover step). */
  private readonly resolvePolicyDeploymentAt: () => string | null;

  constructor(
    dataDir = "data",
    nowIso: () => string = () => new Date().toISOString(),
    resolvePolicyDeploymentAt: () => string | null = () => resolveEndToEndCorrectnessDeploymentAt(),
  ) {
    this.file = resolve(dataDir, "regime-edge-memory.json");
    this.now = nowIso;
    this.resolvePolicyDeploymentAt = resolvePolicyDeploymentAt;
    this.state = this._load();
  }

  private _load(): EdgeMemoryState {
    try {
      if (existsSync(this.file)) {
        const p = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<EdgeMemoryState>;
        if (p && typeof p === "object") {
          return {
            version: 1,
            seedStats: p.seedStats ?? {},
            liveStats: p.liveStats ?? {},
            laneSeedStats: p.laneSeedStats ?? {},
            laneLiveStats: p.laneLiveStats ?? {},
            seededAt: p.seededAt ?? null,
            seedSource: p.seedSource ?? null,
            liveUpdatedAt: p.liveUpdatedAt ?? null,
          };
        }
      }
    } catch {
      // Corrupt/unreadable: start empty rather than crash the scan.
    }
    return { version: 1, seedStats: {}, liveStats: {}, laneSeedStats: {}, laneLiveStats: {}, seededAt: null, seedSource: null, liveUpdatedAt: null };
  }

  save(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }

  /** Combined seed-prior + live-aggregate for a slice. */
  lookup(regimeRaw: string | null | undefined, direction: EdgeDirection): EdgeStat {
    const k = statKey(normalizeRegimeFamily(regimeRaw), direction);
    return mergeStat(this.state.seedStats[k] ?? emptyStat(), this.state.liveStats[k] ?? emptyStat());
  }

  verdict(regimeRaw: string | null | undefined, direction: EdgeDirection): EdgeVerdict {
    return edgeVerdict(this.lookup(regimeRaw, direction));
  }

  /** Combined seed + live for one LANE slice (regime × direction × lane). */
  laneLookup(regimeRaw: string | null | undefined, direction: EdgeDirection, lane: string): EdgeStat {
    const k = `${normalizeRegimeFamily(regimeRaw)}::${direction}::${lane}`;
    return mergeStat(this.state.laneSeedStats[k] ?? emptyStat(), this.state.laneLiveStats[k] ?? emptyStat());
  }

  laneVerdict(regimeRaw: string | null | undefined, direction: EdgeDirection, lane: string): EdgeVerdict {
    return edgeVerdict(this.laneLookup(regimeRaw, direction, lane));
  }

  /**
   * True when at least one LANE in this regime×direction is proven-positive
   * (effectiveN ≥ MIN_SAMPLES, conservative lower bound > 0). Lets the direction gate allow SHORT
   * even when the direction aggregate is negative, because a tradeable lane exists; the allocator's
   * lane-level veto then admits only that lane. Requires genuine LIVE evidence for that lane — a
   * seed-only lane can never rescue a direction (Point 5d).
   */
  hasPositiveLane(regimeRaw: string | null | undefined, direction: EdgeDirection): boolean {
    const prefix = `${normalizeRegimeFamily(regimeRaw)}::${direction}::`;
    const keys = new Set([...Object.keys(this.state.laneSeedStats), ...Object.keys(this.state.laneLiveStats)]);
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const lane = k.slice(prefix.length);
      const v = this.laneVerdict(regimeRaw, direction, lane);
      if (v.decision === "ALLOW_PROVEN") return true;
    }
    return false;
  }

  /**
   * Install the frozen prior. Rows with `lane` set seed lane-level slices; rows without seed
   * direction-level. Seed rows carry only aggregated (n, wins, sumNetR) counts — no raw per-order
   * (symbol, timestamp, cost-model, policy-era) evidence to cluster — so `effectiveN` and
   * `conservativeLowerBoundR` are left at `emptyStat()`'s 0/null for every seeded slice. This is what
   * makes "seed data alone can never reach ALLOW_PROVEN or VETO_NEGATIVE" a structural guarantee
   * (Point 5d) rather than a policy enforced elsewhere that a future edit could quietly bypass.
   */
  seed(rows: EdgeSeedRow[], source: string): void {
    const stats: Record<string, EdgeStat> = {};
    const laneStats: Record<string, EdgeStat> = {};
    for (const r of rows) {
      const regime = normalizeRegimeFamily(r.regime);
      const target = r.lane ? laneStats : stats;
      const k = r.lane ? `${regime}::${r.direction}::${r.lane}` : statKey(regime, r.direction);
      const prev = target[k] ?? emptyStat();
      prev.n += r.n;
      prev.wins += r.wins;
      prev.sumNetR += r.sumNetR;
      target[k] = prev;
    }
    for (const k of Object.keys(stats)) finalizeStat(stats[k]!);
    for (const k of Object.keys(laneStats)) finalizeStat(laneStats[k]!);
    this.state.seedStats = stats;
    this.state.laneSeedStats = laneStats;
    this.state.seededAt = this.now();
    this.state.seedSource = source;
  }

  /**
   * Rebuild the live aggregate from the current paper store's closed orders.
   * Idempotent — safe to call every cycle.
   *
   * Counts HEADLINE closes ONLY. DIAGNOSTIC_ONLY orders are reject-sampler probes
   * on candidates the quality gate ALREADY rejected — they are systematically the
   * worst trades, so folding them in biases the gate falsely-negative (observed
   * 2026-06-20: 49 diagnostic bullish-longs at −0.99R dragged BULLISH×LONG from the
   * seed's +0.178 to −0.058 and FLIPPED it to VETO, even though zero real headline
   * longs had traded). The live aggregate must reflect REAL trading edge, so it
   * tracks headline only; the seed is the prior until headline evidence accrues.
   * (Trade-off accepted: a hard-vetoed slice makes no headline orders so it cannot
   * un-veto from live data — re-seed to revisit a slice.) BACKFILL excluded too.
   *
   * Point 5 hardening: within each (regime × direction) and (regime × direction × lane) group, the
   * ALLOW_PROVEN/VETO_NEGATIVE gate inputs (`effectiveN`/`conservativeLowerBoundR`) are additionally
   * restricted to the newest cost-model generation, the current policy-deployment era (when
   * resolvable), and a rolling freshness lookback — see `buildLiveStat`'s doc comment.
   */
  updateFromClosedOrders(orders: ClosedOrderLike[]): void {
    // T1-b DECISION PATH (hard veto) — gated, DEFAULT OFF. This aggregate is HEADLINE-only, so it
    // sees only the 4 sub-floor rows that carry paperOrderMode !== DIAGNOSTIC_ONLY — but those 4
    // are the DURABLE contamination: pruneClosedDiagnostic never prunes HEADLINE closes, so unlike
    // the diagnostic pool they never age out. Measured 2026-07-26 they were 4 of the 19 closes in
    // this entire aggregate (21%), all Bullish expansion::LONG. No veto flips at today's sample.
    const scoped = applySubFloorExclusionForDecisions(orders);
    const eligible = scoped.filter(isHeadlineClosedOrder);

    const currentPolicyDeploymentAt = this.resolvePolicyDeploymentAt();
    const nowMs = Date.parse(this.now());

    const dirGroups = new Map<string, ClosedOrderLike[]>();
    const laneGroups = new Map<string, ClosedOrderLike[]>();
    for (const o of eligible) {
      const regime = normalizeRegimeFamily(o.regime);
      const direction = o.direction as EdgeDirection;
      pushGroup(dirGroups, statKey(regime, direction), o);
      pushGroup(laneGroups, `${regime}::${direction}::${laneOf(o.selectedLaneId)}`, o);
    }

    const stats: Record<string, EdgeStat> = {};
    const laneStats: Record<string, EdgeStat> = {};
    for (const [k, group] of dirGroups) stats[k] = buildLiveStat(group, currentPolicyDeploymentAt, nowMs);
    for (const [k, group] of laneGroups) laneStats[k] = buildLiveStat(group, currentPolicyDeploymentAt, nowMs);

    this.state.liveStats = stats;
    this.state.laneLiveStats = laneStats;
    this.state.liveUpdatedAt = this.now();
  }

  snapshot(): EdgeMemoryState {
    return JSON.parse(JSON.stringify(this.state)) as EdgeMemoryState;
  }
}

let _singleton: RegimeEdgeMemoryStore | null = null;
/** Process-wide edge memory, loaded from data/regime-edge-memory.json on first use. */
export function getRegimeEdgeMemory(dataDir = "data"): RegimeEdgeMemoryStore {
  if (!_singleton) _singleton = new RegimeEdgeMemoryStore(dataDir);
  return _singleton;
}

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
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type EdgeDirection = "LONG" | "SHORT";
export type RegimeFamily = "BULLISH_EXPANSION" | "BEARISH_EXPANSION" | "MIXED_ROTATION" | "OTHER";

export interface EdgeStat {
  n: number;
  wins: number;
  sumNetR: number;
  avgNetR: number;
  winRate: number;
}

export type EdgeVerdictDecision = "ALLOW_PROVEN" | "ALLOW_INSUFFICIENT" | "VETO_NEGATIVE";

export interface EdgeVerdict {
  decision: EdgeVerdictDecision;
  reasonCode: string;
  allowed: boolean;
  stat: EdgeStat;
}

/**
 * Minimum closed-trade sample before an edge is "proven". Below this a slice is
 * cold-start: per the operator's choice it is ALLOWED (no shadow wait), but the
 * verdict still flags it so sizing/telemetry can stay cautious.
 */
export const EDGE_MIN_SAMPLES = 30;
/**
 * A proven slice is only allowed when its honest avgNetR clears this margin. We
 * require strictly-positive (not merely break-even) because a near-zero edge
 * does not survive real-world execution-cost variance. Proven slices at or below
 * this are hard-vetoed.
 */
export const EDGE_MIN_POSITIVE_AVG_R = 0;

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
  return { n: 0, wins: 0, sumNetR: 0, avgNetR: 0, winRate: 0 };
}

function finalizeStat(s: EdgeStat): EdgeStat {
  s.avgNetR = s.n > 0 ? s.sumNetR / s.n : 0;
  s.winRate = s.n > 0 ? (100 * s.wins) / s.n : 0;
  return s;
}

function mergeStat(a: EdgeStat, b: EdgeStat): EdgeStat {
  return finalizeStat({
    n: a.n + b.n,
    wins: a.wins + b.wins,
    sumNetR: a.sumNetR + b.sumNetR,
    avgNetR: 0,
    winRate: 0,
  });
}

/**
 * Pure verdict from a stat — no I/O, so the controller, allocator and tests
 * share one rule.
 *  - n < MIN_SAMPLES                 → ALLOW_INSUFFICIENT (cold-start, operator chose no-shadow)
 *  - n ≥ MIN_SAMPLES, avgR ≤ margin  → VETO_NEGATIVE     (proven non-positive — hard block)
 *  - n ≥ MIN_SAMPLES, avgR > margin  → ALLOW_PROVEN      (proven positive — trade it)
 */
export function edgeVerdict(stat: EdgeStat): EdgeVerdict {
  if (stat.n < EDGE_MIN_SAMPLES) {
    return { decision: "ALLOW_INSUFFICIENT", reasonCode: "EDGE_INSUFFICIENT_SAMPLES", allowed: true, stat };
  }
  if (stat.avgNetR <= EDGE_MIN_POSITIVE_AVG_R) {
    return { decision: "VETO_NEGATIVE", reasonCode: "EDGE_PROVEN_NEGATIVE", allowed: false, stat };
  }
  return { decision: "ALLOW_PROVEN", reasonCode: "EDGE_PROVEN_POSITIVE", allowed: true, stat };
}

/** Minimal shape of a closed paper order needed to aggregate live edge. */
export interface ClosedOrderLike {
  paperStatus: string;
  direction: EdgeDirection | string;
  regime?: string | null;
  netR?: number | null;
  paperOrderMode?: string | null;
  diagnosticLabel?: string | null;
  selectedLaneId?: string | null;
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

export class RegimeEdgeMemoryStore {
  private readonly file: string;
  private state: EdgeMemoryState;
  private readonly now: () => string;

  constructor(dataDir = "data", nowIso: () => string = () => new Date().toISOString()) {
    this.file = resolve(dataDir, "regime-edge-memory.json");
    this.now = nowIso;
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
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
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
   * (n ≥ MIN_SAMPLES, avgR > 0). Lets the direction gate allow SHORT even when
   * the direction aggregate is negative, because a tradeable lane exists; the
   * allocator's lane-level veto then admits only that lane.
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

  /** Install the frozen prior. Rows with `lane` set seed lane-level slices; rows without seed direction-level. */
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
   */
  updateFromClosedOrders(orders: ClosedOrderLike[]): void {
    const stats: Record<string, EdgeStat> = {};
    const laneStats: Record<string, EdgeStat> = {};
    const bump = (m: Record<string, EdgeStat>, k: string, netR: number) => {
      const s = m[k] ?? emptyStat();
      s.n += 1;
      s.wins += netR > 0 ? 1 : 0;
      s.sumNetR += netR;
      m[k] = s;
    };
    for (const o of orders) {
      if (o.paperStatus !== "PAPER_CLOSED_WIN" && o.paperStatus !== "PAPER_CLOSED_LOSS") continue;
      if (o.paperOrderMode === "DIAGNOSTIC_ONLY" || o.diagnosticLabel === "BACKFILL_DIAGNOSTIC") continue;
      if (o.direction !== "LONG" && o.direction !== "SHORT") continue;
      if (typeof o.netR !== "number" || !Number.isFinite(o.netR)) continue;
      const regime = normalizeRegimeFamily(o.regime);
      bump(stats, statKey(regime, o.direction), o.netR);
      bump(laneStats, `${regime}::${o.direction}::${laneOf(o.selectedLaneId)}`, o.netR);
    }
    for (const k of Object.keys(stats)) finalizeStat(stats[k]!);
    for (const k of Object.keys(laneStats)) finalizeStat(laneStats[k]!);
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

/**
 * EDGE DIGGER — a READ-ONLY research pipeline that discovers, validates and ranks conditional edges
 * from already-collected forward evidence.
 *
 * WHAT THIS IS NOT. It never places, sizes, admits, gates or closes anything. It imports no
 * executor, no allocator, no exchange client and no store WRITER. It reads evidence, computes
 * statistics, applies the canonical gates, and returns a verdict object. Every field it emits is
 * `reportOnly`. Its maximum possible output is a RECOMMENDATION for a bounded experiment — it can
 * never enable one.
 *
 * THE THREE DISCIPLINES IT EXISTS TO ENFORCE, all of which this codebase has been burned by before:
 *
 *  1. INDEPENDENT EPISODES, NEVER RAW ROWS. A lane once read +0.42R at WR 100% on "n=201" that was
 *     ONE value repeated 201 times. Signals fire on many symbols at the same instant from a single
 *     market-wide reading; those are ONE observation. Every count here is reported BOTH ways, and
 *     every gate reads the episode count. The episode rule is not reimplemented — it is imported
 *     from current-guard-variant-matrix.ts (`countIndependentEpisodes`), the same union-find
 *     accumulator `computeEffectiveN` itself now delegates to, so a research verdict and a readiness
 *     verdict can never disagree about what "independent" means.
 *
 *     ⚠ There is a DIFFERENT exported `computeEffectiveN` in edge-lower-bound.ts — a plain
 *     `new Set(key).size` with no chaining and no max-hold width. It is NOT the readiness rule and
 *     is deliberately not used here.
 *
 *  2. NO POST-OUTCOME LEAKAGE. Each hypothesis predeclares the decision-time features it is allowed
 *     to condition on, and `assertNoPostOutcomeFeatures` fails closed on anything outside that list.
 *     See POST_OUTCOME_FIELDS for the specific trap this codebase contains: `costR` is present at
 *     decision time as a base cost model and then MUTATED IN PLACE at resolution to fold in
 *     stop-out slippage and funding, both of which are functions of the outcome. On a resolved row
 *     `costR` is a post-outcome field, and conditioning on it would leak.
 *
 *  3. CANONICAL EVIDENCE OR AN EXPLICIT INTEGRITY FAILURE. Readiness/promotion admit a row only when
 *     it carries an evidence-version marker (`openMaxHoldMs` matching the lane's live config),
 *     proven entry freshness (`isFreshValid === true`) and a terminal status. A source that cannot
 *     express those markers cannot be validated to the same standard, and this pipeline says so in
 *     `integrity` rather than silently scoring it as if it could — an integrity failure is itself a
 *     REJECT reason (rule F), not a footnote.
 *
 * HOLDOUT DISCIPLINE. current-guard-variant-matrix.ts states that holdout ECONOMICS must never be
 * read by code a human uses to iteratively tune. This pipeline honours that: the validation/OOS and
 * recent partitions are computed and reported, but nothing here selects, ranks or tunes a hypothesis
 * using them — selection happens on DEV only, and the later partitions can only ever REJECT.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  countIndependentEpisodes,
  MAX_TOP_SYMBOL_SHARE,
  PF_FLOOR,
  PROMOTION_MIN_CALENDAR_DAYS,
  PROMOTION_MIN_DISTINCT_SYMBOLS,
  STABLE_MIN_DISTINCT_SYMBOLS,
  STABLE_MIN_EFFECTIVE_N,
  STABLE_MIN_HOLDOUT_EFFECTIVE_N,
  PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
  type EpisodeIdentityRow,
} from "./current-guard-variant-matrix.js";

export const EDGE_DIGGER_VERSION = "edge-digger-v1" as const;

// ---------------------------------------------------------------------------
// Leakage boundary.
// ---------------------------------------------------------------------------

/**
 * Fields that only exist, or only take their final value, AFTER the outcome is known. No hypothesis
 * may condition on any of these. `costR` is the subtle one and is listed deliberately: it is written
 * at creation from the cost model and then overwritten at resolution with
 * `base + stopOutSlippage + funding`, where the slippage term is a function of `status`/
 * `resolutionSource` and the funding term is a function of `durationMinutes`.
 */
export const POST_OUTCOME_FIELDS: readonly string[] = [
  "grossR", "netR", "costR", "status", "resolvedAt", "resolvedAtMs", "durationMinutes",
  "exitReason", "resolutionSource", "maxFavorableR", "maxMfeR", "minMaeR",
  "intrabarResolutionStatus", "holdBars", "grossBasketReturn", "netBasketReturn", "costReturn",
];

/** Fails closed: any allowed-feature list that names a post-outcome field is a construction error,
 *  caught at module load by the frozen registry's own self-check below. */
function assertNoPostOutcomeFeatures(hypothesisId: string, allowed: readonly string[]): void {
  const leaked = allowed.filter((f) => POST_OUTCOME_FIELDS.includes(f));
  if (leaked.length > 0) {
    throw new Error(`edge-digger: hypothesis ${hypothesisId} declares post-outcome feature(s): ${leaked.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Frozen hypothesis registry.
// ---------------------------------------------------------------------------

export type EdgeHypothesisId =
  | "F1_COMPOSITE_CONFIRMED_LONG"
  | "F2_RESIDUAL_MOMENTUM_SHORT"
  | "F3_COMPRESSION_OR_FUNDING_CARRY";

export interface EdgeSourceSpec {
  /** File name under the instance data dir. Read-only; never written by this module. */
  readonly store: string;
  readonly label: string;
  /** Optional direction filter applied to that store's rows for this hypothesis. */
  readonly direction?: "LONG" | "SHORT";
}

export interface EdgeHypothesis {
  readonly id: EdgeHypothesisId;
  readonly title: string;
  /** WHY this could be a real edge — stated before looking at any outcome. */
  readonly rationale: string;
  /** The predeclared entry rule. Frozen: this pipeline evaluates it, it never searches for it. */
  readonly rule: string;
  /** Decision-time features this hypothesis is allowed to condition on. Validated against
   *  POST_OUTCOME_FIELDS at module load. */
  readonly allowedDecisionTimeFeatures: readonly string[];
  readonly costModel: string;
  readonly sources: readonly EdgeSourceSpec[];
  /** Predeclared rejection rules, so a REJECT is never a post-hoc rationalisation. */
  readonly rejectionRules: readonly string[];
}

/**
 * Exactly three families, frozen. There is deliberately no mechanism to add a fourth at runtime and
 * no feature search of any kind: an unlimited search over this much data would manufacture an edge
 * from noise long before it found a real one.
 */
export const EDGE_HYPOTHESES: readonly EdgeHypothesis[] = [
  {
    id: "F1_COMPOSITE_CONFIRMED_LONG",
    title: "Composite-confirmed LONG after retest",
    rationale:
      "A composite/regime estimator that is already confirmed long-side should have its best expectancy " +
      "not at the initial signal but after price retests and holds the level, because the retest removes " +
      "the entries that were pure momentum chase. If real, this shows up as positive after-cost expectancy " +
      "on confirmed-long entries whose setup is a retest/reclaim rather than a fresh break.",
    rule:
      "LONG entries recorded by the composite-estimator and regime-composite confirmation lanes, where " +
      "the lane's own axis/composite score was confirmed positive at entry.",
    allowedDecisionTimeFeatures: [
      "compositeAtEntry", "levelAtEntry", "velocityAtEntry", "kronosContributionAtEntry", "bucket",
      "axisScoreAtEntry", "crowdingStateAtEntry", "entrySetup", "extensionAboveEmaAtr",
      "fundingBpsAtEntry", "atrAtEntry", "ema20AtEntry", "direction", "symbol", "openedAt",
      "entryPrice", "initialStop", "stopDistanceBps", "tpRewardMultiple", "maxHoldHours",
    ],
    costModel:
      "Lane-recorded costR, already folded into the lane's netR at resolution (taker round-trip + " +
      "stop-out slippage + funding). Not separable into fee/slippage/funding components — see " +
      "EdgeCostSensitivity.decomposable.",
    sources: [
      { store: "composite-estimator-edge.json", label: "composite-estimator", direction: "LONG" },
      { store: "regime-composite-edge.json", label: "regime-composite-long", direction: "LONG" },
    ],
    rejectionRules: [
      "after-cost net expectancy <= 0",
      "PF <= PF_FLOOR",
      "clustered bootstrap lower bound <= 0",
      "independent DEV episodes below the canonical STABLE dev floor",
      "top-symbol PnL share above MAX_TOP_SYMBOL_SHARE",
      "NO_TRADE (flat) beats the hypothesis after cost",
      "evidence integrity failure (no canonical evidence-version/freshness marker)",
    ],
  },
  {
    id: "F2_RESIDUAL_MOMENTUM_SHORT",
    title: "Residual-momentum SHORT (incl. BTC/ETH-neutral and hedged forms)",
    rationale:
      "Cross-sectional residual momentum — a symbol's return after removing its beta-driven move — is " +
      "one of the few genuinely non-directional effects: shorting the weakest residual while the market " +
      "component is hedged out should pay regardless of whether the whole market is up or down. If real, " +
      "the hedged/beta-neutral form should be at least as good as the naked short, because it strips the " +
      "market factor that otherwise dominates the P&L.",
    rule:
      "SHORT entries on the residual-momentum lane (single-symbol, ranked by residual return with a " +
      "beta estimate at entry), plus the hedged basket form which shorts residual-weak legs against a " +
      "BTC/ETH benchmark at the recorded hedge beta.",
    allowedDecisionTimeFeatures: [
      "residualReturnAtEntry", "betaAtEntry", "rankAtEntry", "persistenceAtEntry",
      "clusterAvgResidualReturnAtEntry", "cluster", "kind", "direction", "symbol", "openedAt",
      "entryPrice", "initialStop", "stopDistanceBps", "hedgeBeta", "benchmarkSymbol",
      "regimeAtEntry", "shortLegs", "maxHoldBars", "stopReturn", "takeProfitReturn",
    ],
    costModel:
      "Lane-recorded costR / costReturn, already folded into netR. The hedged form additionally pays " +
      "the benchmark leg's round-trip, which the lane records inside its own cost figure.",
    sources: [
      // RESIDUAL_MOMENTUM_LEADER_LAGGARD is report-only (no executor has ever existed for it), and
      // HEDGED_RESIDUAL_SHORT_CONTINUATION_V2's EXECUTION is innovation-campaign-gated. Neither fact
      // blocks this evaluation: the shadow measurement cycles that write both stores are gated only
      // by their own default-on env flags, never by the campaign, so forward measurement evidence
      // accrues with campaigns OFF. That measurement surface is what is read here.
      { store: "residual-momentum-edge.json", label: "residual-momentum", direction: "SHORT" },
      { store: "hedged-residual-short-v2.json", label: "hedged-residual-short-v2" },
    ],
    rejectionRules: [
      "after-cost net expectancy <= 0",
      "PF <= PF_FLOOR",
      "clustered bootstrap lower bound <= 0",
      "independent DEV episodes below the canonical STABLE dev floor",
      "hedged form does not at least match the naked form (the stated mechanism fails)",
      "NO_TRADE (flat) beats the hypothesis after cost",
      "evidence integrity failure (no canonical evidence-version/freshness marker)",
    ],
  },
  {
    id: "F3_COMPRESSION_OR_FUNDING_CARRY",
    title: "Compression-expansion OR funding-carry (whichever has cleaner evidence)",
    rationale:
      "Two independent candidates for the third slot. Compression-expansion: volatility is mean-reverting, " +
      "so a genuine range compression followed by an expansion with confirming taker flow should carry. " +
      "Funding-carry: a persistently paying funding rate is a directly observable cash flow, and a " +
      "market-neutral pair harvesting it should earn the carry minus cost. The pipeline selects whichever " +
      "of the two actually has usable recorded evidence and states why the other was not selected.",
    rule:
      "Compression-expansion: entries after a measured compression (ATR/BB-width percentile) that break " +
      "out with a confirming taker-buy ratio. Funding-carry: neutral pairs opened while the funding basis " +
      "exceeds the modelled breakeven.",
    allowedDecisionTimeFeatures: [
      "atrPercentileAtCompression", "bbWidthPercentileAtCompression", "compressionRangeHigh",
      "compressionRangeLow", "atrAtBreakout", "takerBuyRatio", "volumeRatio", "direction", "symbol",
      "openedAt", "entryPrice", "initialStop", "stopDistanceBps", "targetPrice",
    ],
    costModel: "Lane-recorded costR, already folded into netR.",
    sources: [
      { store: "compression-expansion-edge.json", label: "compression-expansion" },
      { store: "compression-retest-v2.json", label: "compression-retest-v2" },
      { store: "funding-carry-edge.json", label: "funding-carry" },
      { store: "funding-carry-crowding-v2.json", label: "funding-carry-crowding-v2" },
    ],
    rejectionRules: [
      "after-cost net expectancy <= 0",
      "PF <= PF_FLOOR",
      "clustered bootstrap lower bound <= 0",
      "independent DEV episodes below the canonical STABLE dev floor",
      "all rows share one origin instant (no independent evidence at all)",
      "NO_TRADE (flat) beats the hypothesis after cost",
      "evidence integrity failure (no canonical evidence-version/freshness marker)",
    ],
  },
];

// Registry self-check at module load — a leaked feature is a build-time error, not a runtime bug.
for (const h of EDGE_HYPOTHESES) assertNoPostOutcomeFeatures(h.id, h.allowedDecisionTimeFeatures);

// ---------------------------------------------------------------------------
// Evidence loading + canonical integrity classification.
// ---------------------------------------------------------------------------

/** The canonical markers readiness/promotion require of every row it admits. */
export interface EdgeCanonicalMarkers {
  /** An evidence-version pin (`openMaxHoldMs`) proving the row was opened under the lane's CURRENT
   *  config, so a config change cannot retroactively re-admit stale evidence. */
  readonly evidenceVersionPin: boolean;
  /** Proven entry freshness (`isFreshValid === true`, strict tri-state). */
  readonly entryFreshness: boolean;
  /** Terminal status + finite gross/net. This one lane-edge stores DO express. */
  readonly terminalStatusAndFiniteEconomics: boolean;
  /** Causal provenance (decision/opportunity/outcome lineage with a policy era). */
  readonly causalProvenance: boolean;
  /** Cost decomposable into fee / slippage / funding. */
  readonly costDecomposable: boolean;
}

export interface EdgeSourceIntegrity {
  readonly store: string;
  readonly label: string;
  readonly present: boolean;
  readonly rawRows: number;
  readonly eligibleRows: number;
  readonly markers: EdgeCanonicalMarkers;
  readonly missingMarkers: readonly string[];
  /** CANONICAL only if every marker readiness requires is present. Never true for a lane-edge store. */
  readonly verdict: "CANONICAL" | "NON_CANONICAL" | "ABSENT";
  readonly note: string;
}

/** One normalized evidence row. Post-outcome fields are kept (metrics need them) but are never
 *  offered as conditioning features — see POST_OUTCOME_FIELDS. */
export interface EdgeEvidenceRow {
  readonly observationId: string;
  readonly sourceStore: string;
  readonly openedAt: string;
  readonly openedAtMs: number | null;
  readonly resolvedAt: string | null;
  readonly status: string;
  readonly direction: string | null;
  /** null for basket/multi-leg rows, which have legs rather than one symbol. */
  readonly symbol: string | null;
  readonly regime: string | null;
  readonly grossR: number;
  readonly netR: number;
  readonly costR: number | null;
  readonly exitReason: string | null;
  readonly maxFavorableR: number | null;
  /** Max adverse excursion. null when the source never recorded it — reported as null, never as 0. */
  readonly maxAdverseR: number | null;
}

interface RawLaneEdgeStore {
  version?: unknown;
  observations?: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The portion of the canonical eligibility rule a lane-edge row can actually express: terminal
 * status AND finite grossR AND finite netR. This is deliberately a STRICT SUBSET of
 * `isFreshValidObs` and is never presented as equivalent to it — the two markers it cannot check
 * (evidence-version pin, entry freshness) are reported as missing in EdgeSourceIntegrity, which is
 * itself a REJECT reason.
 */
function isEligibleEdgeRow(row: EdgeEvidenceRow): boolean {
  return (row.status === "CLOSED_WIN" || row.status === "CLOSED_LOSS") && finite(row.grossR) && finite(row.netR);
}

function normalizeRow(raw: Record<string, unknown>, store: string): EdgeEvidenceRow | null {
  const observationId = typeof raw.observationId === "string" ? raw.observationId : null;
  const openedAt = typeof raw.openedAt === "string" ? raw.openedAt : null;
  if (!observationId || !openedAt) return null; // malformed — fail closed, never guess an identity
  const grossR = raw.grossR;
  const netR = raw.netR;
  return {
    observationId,
    sourceStore: store,
    openedAt,
    openedAtMs: finite(raw.openedAtMs) ? raw.openedAtMs : toMs(openedAt),
    resolvedAt: typeof raw.resolvedAt === "string" ? raw.resolvedAt : null,
    status: typeof raw.status === "string" ? raw.status : "UNKNOWN",
    direction: typeof raw.direction === "string" ? raw.direction : null,
    symbol: typeof raw.symbol === "string" ? raw.symbol : null,
    regime: typeof raw.regimeAtEntry === "string" ? raw.regimeAtEntry
      : typeof raw.regime === "string" ? raw.regime : null,
    grossR: finite(grossR) ? grossR : Number.NaN,
    netR: finite(netR) ? netR : Number.NaN,
    costR: finite(raw.costR) ? raw.costR : null,
    exitReason: typeof raw.exitReason === "string" ? raw.exitReason : null,
    maxFavorableR: finite(raw.maxFavorableR) ? raw.maxFavorableR : null,
    // No lane-edge store records adverse excursion today. Reported null rather than imputed.
    maxAdverseR: finite(raw.maxAdverseR) ? raw.maxAdverseR : finite(raw.minMaeR) ? raw.minMaeR : null,
  };
}

export interface EdgeSourceLoad {
  readonly integrity: EdgeSourceIntegrity;
  readonly rows: readonly EdgeEvidenceRow[];
}

export function loadEdgeSource(dataDir: string, spec: EdgeSourceSpec): EdgeSourceLoad {
  const file = resolve(dataDir, spec.store);
  const markers: EdgeCanonicalMarkers = {
    // A lane-edge store records none of these. Stated as data, not as an assumption.
    evidenceVersionPin: false,
    entryFreshness: false,
    terminalStatusAndFiniteEconomics: true,
    causalProvenance: false,
    costDecomposable: false,
  };
  const missingMarkers = [
    "evidenceVersionPin (openMaxHoldMs)",
    "entryFreshness (isFreshValid)",
    "causalProvenance (decision/opportunity/outcome lineage)",
    "costDecomposable (fee vs slippage vs funding)",
  ];
  if (!existsSync(file)) {
    return {
      integrity: {
        store: spec.store, label: spec.label, present: false, rawRows: 0, eligibleRows: 0,
        markers, missingMarkers, verdict: "ABSENT",
        note: "store file does not exist on this instance",
      },
      rows: [],
    };
  }
  let parsed: RawLaneEdgeStore;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as RawLaneEdgeStore;
  } catch {
    return {
      integrity: {
        store: spec.store, label: spec.label, present: true, rawRows: 0, eligibleRows: 0,
        markers, missingMarkers, verdict: "NON_CANONICAL",
        note: "store present but unparseable — fails closed to zero rows",
      },
      rows: [],
    };
  }
  const rawList = Array.isArray(parsed.observations) ? parsed.observations : [];
  const normalized: EdgeEvidenceRow[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const row = normalizeRow(item as Record<string, unknown>, spec.store);
    if (!row) continue;
    if (spec.direction && row.direction !== spec.direction) continue;
    normalized.push(row);
  }
  const eligible = normalized.filter(isEligibleEdgeRow);
  return {
    integrity: {
      store: spec.store, label: spec.label, present: true,
      rawRows: rawList.length, eligibleRows: eligible.length,
      markers, missingMarkers, verdict: "NON_CANONICAL",
      note:
        "lane-edge store: expresses terminal status + finite economics, but carries no evidence-version " +
        "pin, no entry-freshness flag and no causal lineage, so canonical readiness eligibility cannot " +
        "be applied to it",
    },
    rows: eligible,
  };
}

// ---------------------------------------------------------------------------
// Episodes + concentration.
// ---------------------------------------------------------------------------

/** The canonical episode-clustering width. Reset lanes run a 36h max-hold today; research over
 *  lane-edge stores has no per-lane `maxHoldHours` to read, so the width is declared here ONCE,
 *  up-front, and reported alongside every episode count so a reader can see what "independent" meant. */
export const EDGE_EPISODE_BLOCK_WIDTH_MS = 36 * 60 * 60 * 1000;

export interface EdgeEpisodeStats {
  readonly rawRows: number;
  readonly independentEpisodes: number;
  readonly rowsPerEpisode: number | null;
  readonly largestEpisodeRows: number;
  readonly largestEpisodeShare: number | null;
  readonly distinctSymbols: number;
  readonly distinctRegimes: number;
  readonly calendarDays: number | null;
  /** distinct(netR)/n — the duplicate-value detector. A value far below 1 means many rows are
   *  literally the same number and the effective sample is far smaller than n. */
  readonly distinctNetRRatio: number | null;
  readonly blockWidthMs: number;
}

function episodeIdentityOf(row: EdgeEvidenceRow): EpisodeIdentityRow {
  return {
    episodeMs: row.openedAtMs,
    observationId: row.observationId,
    // Lane-edge stores carry no scan-batch or market-episode id; merge-only inputs are absent, so
    // clustering falls back to pure openedAt chaining — the same base rule the canonical accumulator
    // applies when those fields are absent on a variant-matrix row.
    batchId: null,
    episodeId: null,
  };
}

/** Deterministic episode grouping that reuses the CANONICAL count. The grouping below reproduces the
 *  accumulator's base chaining rule for concentration reporting only; `independentEpisodes` itself is
 *  always the canonical `countIndependentEpisodes` result, so the reported count can never drift from
 *  readiness even if this local grouping were to. */
function chainGroups(rows: readonly EdgeEvidenceRow[], blockWidthMs: number): EdgeEvidenceRow[][] {
  const dated = rows.filter((r) => r.openedAtMs !== null)
    .slice()
    .sort((a, b) => (a.openedAtMs! - b.openedAtMs!) || (a.observationId < b.observationId ? -1 : 1));
  const undated = rows.filter((r) => r.openedAtMs === null);
  const groups: EdgeEvidenceRow[][] = [];
  let startMs: number | null = null;
  for (const row of dated) {
    if (startMs === null || row.openedAtMs! - startMs >= blockWidthMs) {
      startMs = row.openedAtMs!;
      groups.push([row]);
    } else {
      groups[groups.length - 1]!.push(row);
    }
  }
  if (undated.length > 0) groups.push(undated); // single fail-closed shared bucket
  return groups;
}

export function edgeEpisodeStats(
  rows: readonly EdgeEvidenceRow[],
  blockWidthMs = EDGE_EPISODE_BLOCK_WIDTH_MS,
): EdgeEpisodeStats {
  const independentEpisodes = countIndependentEpisodes(rows.map(episodeIdentityOf), blockWidthMs);
  const groups = chainGroups(rows, blockWidthMs);
  const largestEpisodeRows = groups.reduce((max, g) => Math.max(max, g.length), 0);
  const times = rows.map((r) => r.openedAtMs).filter((m): m is number => m !== null);
  const calendarDays = times.length > 0
    ? Math.round(((Math.max(...times) - Math.min(...times)) / 86_400_000) * 100) / 100
    : null;
  const nets = rows.map((r) => r.netR).filter(finite);
  return {
    rawRows: rows.length,
    independentEpisodes,
    rowsPerEpisode: independentEpisodes > 0 ? Math.round((rows.length / independentEpisodes) * 100) / 100 : null,
    largestEpisodeRows,
    largestEpisodeShare: rows.length > 0 ? Math.round((largestEpisodeRows / rows.length) * 1000) / 1000 : null,
    distinctSymbols: new Set(rows.map((r) => r.symbol).filter((s): s is string => s !== null)).size,
    distinctRegimes: new Set(rows.map((r) => r.regime).filter((s): s is string => s !== null)).size,
    calendarDays,
    distinctNetRRatio: nets.length > 0
      ? Math.round((new Set(nets.map((n) => Math.round(n * 1e10) / 1e10)).size / nets.length) * 1000) / 1000
      : null,
    blockWidthMs,
  };
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

/** Mirrors the dashboard's PF semantics exactly: a zero-denominator PF is UNDEFINED, never a large
 *  finite sentinel that would read as an exceptional result on an insufficient sample. */
export type EdgePfStatus = "COMPUTED" | "NO_LOSSES_YET" | "NO_WINS_YET" | "NO_DATA";

export interface EdgeMetrics {
  readonly n: number;
  readonly netExpectancyR: number | null;
  readonly medianNetR: number | null;
  readonly pf: number | null;
  readonly pfStatus: EdgePfStatus;
  readonly wr: number | null;
  readonly payoffRatio: number | null;
  readonly worstNetR: number | null;
  readonly p05NetR: number | null;
  /** null when the source never recorded excursion — never imputed from netR. */
  readonly maxAdverseExcursionR: number | null;
  readonly grossExpectancyR: number | null;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function edgeMetrics(rows: readonly EdgeEvidenceRow[]): EdgeMetrics {
  const nets = rows.map((r) => r.netR).filter(finite);
  const gross = rows.map((r) => r.grossR).filter(finite);
  if (nets.length === 0) {
    return {
      n: 0, netExpectancyR: null, medianNetR: null, pf: null, pfStatus: "NO_DATA", wr: null,
      payoffRatio: null, worstNetR: null, p05NetR: null, maxAdverseExcursionR: null, grossExpectancyR: null,
    };
  }
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const posSum = wins.reduce((s, v) => s + v, 0);
  const negSum = losses.reduce((s, v) => s + Math.abs(v), 0);
  const pf = posSum > 0 && negSum > 0 ? posSum / negSum : null;
  const pfStatus: EdgePfStatus =
    posSum > 0 && negSum === 0 ? "NO_LOSSES_YET" : negSum > 0 && posSum === 0 ? "NO_WINS_YET" : "COMPUTED";
  const avgWin = wins.length > 0 ? posSum / wins.length : null;
  const avgLoss = losses.length > 0 ? negSum / losses.length : null;
  const sorted = nets.slice().sort((a, b) => a - b);
  const excursions = rows.map((r) => r.maxAdverseR).filter(finite);
  return {
    n: nets.length,
    netExpectancyR: nets.reduce((s, v) => s + v, 0) / nets.length,
    medianNetR: quantile(sorted, 0.5),
    pf,
    pfStatus,
    wr: wins.length / nets.length,
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null,
    worstNetR: sorted[0]!,
    p05NetR: quantile(sorted, 0.05),
    maxAdverseExcursionR: excursions.length > 0 ? Math.min(...excursions) : null,
    grossExpectancyR: gross.length > 0 ? gross.reduce((s, v) => s + v, 0) / gross.length : null,
  };
}

// ---------------------------------------------------------------------------
// Clustered bootstrap.
// ---------------------------------------------------------------------------

/** Deterministic PRNG. A research CI that moved between two runs on identical data would be
 *  unreproducible and therefore worthless as evidence, so no Math.random anywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed derived from the data itself, so the same cohort always yields the same interval. */
function seedFrom(rows: readonly EdgeEvidenceRow[]): number {
  let h = 2166136261;
  for (const r of rows) {
    for (let i = 0; i < r.observationId.length; i++) {
      h ^= r.observationId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

export interface EdgeBootstrap {
  readonly iterations: number;
  readonly clusteredBy: "INDEPENDENT_EPISODE";
  readonly clusters: number;
  readonly lowerBound95: number | null;
  readonly upperBound95: number | null;
  readonly deterministic: true;
  readonly note: string;
}

/**
 * CLUSTER bootstrap: resamples whole EPISODES with replacement, never individual rows. Resampling
 * rows would treat 500 rows drawn from 1 market episode as 500 independent draws and return an
 * interval roughly sqrt(500)x too tight — the precise error this pipeline exists to prevent.
 */
export function edgeClusterBootstrap(
  rows: readonly EdgeEvidenceRow[],
  blockWidthMs = EDGE_EPISODE_BLOCK_WIDTH_MS,
  iterations = 2000,
): EdgeBootstrap {
  const groups = chainGroups(rows, blockWidthMs).filter((g) => g.some((r) => finite(r.netR)));
  if (groups.length === 0) {
    return {
      iterations: 0, clusteredBy: "INDEPENDENT_EPISODE", clusters: 0,
      lowerBound95: null, upperBound95: null, deterministic: true,
      note: "no eligible rows",
    };
  }
  if (groups.length < 2) {
    return {
      iterations: 0, clusteredBy: "INDEPENDENT_EPISODE", clusters: groups.length,
      lowerBound95: null, upperBound95: null, deterministic: true,
      note:
        "fewer than 2 independent episodes — a clustered interval is undefined; reporting null rather " +
        "than an interval computed as if the rows were independent",
    };
  }
  const rand = mulberry32(seedFrom(rows));
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < groups.length; g++) {
      const picked = groups[Math.floor(rand() * groups.length)]!;
      for (const row of picked) {
        if (finite(row.netR)) { sum += row.netR; count++; }
      }
    }
    if (count > 0) means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return {
    iterations,
    clusteredBy: "INDEPENDENT_EPISODE",
    clusters: groups.length,
    lowerBound95: quantile(means, 0.025),
    upperBound95: quantile(means, 0.975),
    deterministic: true,
    note: "episode-level resampling; seed derived from observation ids so repeated runs are identical",
  };
}

// ---------------------------------------------------------------------------
// Splits, sensitivity, concentration, comparisons.
// ---------------------------------------------------------------------------

export interface EdgeSplit {
  readonly key: string;
  readonly rows: number;
  readonly episodes: number;
  readonly netExpectancyR: number | null;
}

function splitBy(
  rows: readonly EdgeEvidenceRow[],
  keyOf: (r: EdgeEvidenceRow) => string | null,
  blockWidthMs: number,
): EdgeSplit[] {
  const buckets = new Map<string, EdgeEvidenceRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const list = buckets.get(key);
    if (list) list.push(row); else buckets.set(key, [row]);
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({
      key,
      rows: list.length,
      episodes: countIndependentEpisodes(list.map(episodeIdentityOf), blockWidthMs),
      netExpectancyR: edgeMetrics(list).netExpectancyR,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

export interface EdgeCostSensitivity {
  /** False for every lane-edge store: costR is one scalar with fee, slippage and funding already
   *  folded together, so a per-component sensitivity cannot be computed from recorded data. */
  readonly decomposable: boolean;
  /** Expectancy after charging N extra bps of round-trip cost, using each row's own recorded
   *  stop distance where available and a conservative default otherwise. */
  readonly stressed: readonly { readonly extraBps: number; readonly netExpectancyR: number | null }[];
  /** The extra round-trip cost (bps) at which expectancy crosses zero. null when already <= 0. */
  readonly breakevenExtraBps: number | null;
  readonly note: string;
}

/** Conservative default stop width used only when a row has no recorded stop distance. Wider stop =>
 *  a given bps cost is a SMALLER fraction of R, so a default that is too wide would understate the
 *  cost impact; 200bps is at the tight end of this book's real stops, keeping the stress honest. */
const DEFAULT_STOP_BPS_FOR_STRESS = 200;

export function edgeCostSensitivity(
  rows: readonly EdgeEvidenceRow[],
  rawBySourceId: ReadonlyMap<string, Record<string, unknown>>,
): EdgeCostSensitivity {
  const stressAt = (extraBps: number): number | null => {
    const vals: number[] = [];
    for (const row of rows) {
      if (!finite(row.netR)) continue;
      const raw = rawBySourceId.get(row.observationId);
      const stopBps = raw && finite(raw.stopDistanceBps) && raw.stopDistanceBps > 0
        ? raw.stopDistanceBps
        : DEFAULT_STOP_BPS_FOR_STRESS;
      vals.push(row.netR - extraBps / stopBps);
    }
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const steps = [0, 2, 5, 10, 20];
  const stressed = steps.map((extraBps) => ({ extraBps, netExpectancyR: stressAt(extraBps) }));
  const base = stressed[0]!.netExpectancyR;
  let breakevenExtraBps: number | null = null;
  if (base !== null && base > 0) {
    for (let bps = 1; bps <= 200; bps++) {
      const v = stressAt(bps);
      if (v !== null && v <= 0) { breakevenExtraBps = bps; break; }
    }
  }
  return {
    decomposable: false,
    stressed,
    breakevenExtraBps,
    note:
      "recorded cost is a single scalar (fee + slippage + funding already folded in at resolution), " +
      "so this is a TOTAL round-trip stress, not a per-component sensitivity",
  };
}

export interface EdgeComparison {
  readonly label: string;
  readonly netExpectancyR: number | null;
  readonly beatsHypothesis: boolean;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Partitions (chronological, predeclared, never tuned).
// ---------------------------------------------------------------------------

/**
 * Predeclared episode-share partition. Fixed here, in source, BEFORE any outcome is read, and never
 * varied per hypothesis — a partition chosen after seeing results is just another tuned parameter.
 * Partitioning is by EPISODE, not by row: a row-share split would cut a single market episode in
 * half and leak the same market look across the boundary.
 */
export const EDGE_PARTITION_SHARES = { dev: 0.6, validation: 0.25, recent: 0.15 } as const;

export type EdgePartitionName = "DEV" | "VALIDATION_OOS" | "RECENT";

export interface EdgePartition {
  readonly partition: EdgePartitionName;
  readonly rows: number;
  readonly episodes: number;
  readonly metrics: EdgeMetrics;
}

export function partitionByEpisode(
  rows: readonly EdgeEvidenceRow[],
  blockWidthMs = EDGE_EPISODE_BLOCK_WIDTH_MS,
): { dev: EdgeEvidenceRow[]; validation: EdgeEvidenceRow[]; recent: EdgeEvidenceRow[] } {
  const groups = chainGroups(rows, blockWidthMs);
  const total = groups.length;
  const devCount = Math.floor(total * EDGE_PARTITION_SHARES.dev);
  const valCount = Math.floor(total * EDGE_PARTITION_SHARES.validation);
  const dev: EdgeEvidenceRow[] = [];
  const validation: EdgeEvidenceRow[] = [];
  const recent: EdgeEvidenceRow[] = [];
  groups.forEach((group, i) => {
    if (i < devCount) dev.push(...group);
    else if (i < devCount + valCount) validation.push(...group);
    else recent.push(...group);
  });
  return { dev, validation, recent };
}

// ---------------------------------------------------------------------------
// Gates.
// ---------------------------------------------------------------------------

export interface EdgeGate {
  readonly id: string;
  readonly label: string;
  readonly current: number | string | null;
  readonly required: number | string;
  readonly comparator: ">=" | ">" | "<=" | "==";
  readonly pass: boolean;
  readonly blockingReason: string | null;
  /** Where the threshold came from — a gate that cannot name its canonical source is not a gate. */
  readonly source: string;
}

function gate(
  id: string, label: string, current: number | null, required: number,
  comparator: ">=" | ">" | "<=", source: string,
): EdgeGate {
  const pass = current === null ? false
    : comparator === ">=" ? current >= required
    : comparator === ">" ? current > required
    : current <= required;
  return {
    id, label, current, required, comparator, pass, source,
    blockingReason: pass ? null
      : current === null ? `${label}: not computable from recorded evidence`
      : `${label}: ${current} ${comparator === "<=" ? ">" : "<"} ${required}`,
  };
}

// ---------------------------------------------------------------------------
// Per-hypothesis evaluation + report.
// ---------------------------------------------------------------------------

export interface EdgeHypothesisReport {
  readonly hypothesis: EdgeHypothesis;
  readonly selectedSources: readonly string[];
  readonly integrity: readonly EdgeSourceIntegrity[];
  readonly episodes: EdgeEpisodeStats;
  readonly partitions: readonly EdgePartition[];
  readonly metrics: EdgeMetrics;
  readonly bootstrap: EdgeBootstrap;
  readonly splits: {
    readonly byMonth: readonly EdgeSplit[];
    readonly byRegime: readonly EdgeSplit[];
    readonly bySymbol: readonly EdgeSplit[];
  };
  readonly costSensitivity: EdgeCostSensitivity;
  readonly concentration: {
    readonly topSymbolShare: number | null;
    readonly topSymbolShareLimit: number;
    readonly largestEpisodeShare: number | null;
    readonly rowsPerEpisode: number | null;
    readonly excessive: boolean;
  };
  readonly comparisons: readonly EdgeComparison[];
  readonly gates: readonly EdgeGate[];
  readonly decision: "CANDIDATE" | "REJECT";
  readonly rejectionReasons: readonly string[];
  readonly evidenceStillNeeded: readonly string[];
}

export interface EdgeDiggerPolicy {
  readonly comparator: ">=";
  readonly devMinIndependentEpisodes: number;
  readonly validationMinIndependentEpisodes: number;
  readonly recentMinIndependentEpisodes: number;
  readonly minDistinctSymbols: number;
  readonly promotionMinDistinctSymbols: number;
  readonly minCalendarDays: number;
  readonly maxTopSymbolPnlShare: number;
  readonly pfFloor: number;
  readonly source: string;
}

/** Every threshold is READ from the canonical policy constants — none is redeclared here. */
export function edgeDiggerPolicy(): EdgeDiggerPolicy {
  return {
    comparator: ">=",
    devMinIndependentEpisodes: STABLE_MIN_EFFECTIVE_N,
    validationMinIndependentEpisodes: STABLE_MIN_HOLDOUT_EFFECTIVE_N,
    recentMinIndependentEpisodes: PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
    minDistinctSymbols: STABLE_MIN_DISTINCT_SYMBOLS,
    promotionMinDistinctSymbols: PROMOTION_MIN_DISTINCT_SYMBOLS,
    minCalendarDays: PROMOTION_MIN_CALENDAR_DAYS,
    maxTopSymbolPnlShare: MAX_TOP_SYMBOL_SHARE,
    pfFloor: PF_FLOOR,
    source: "current-guard-variant-matrix.ts exported policy constants (not redeclared here)",
  };
}

function topSymbolShareOf(rows: readonly EdgeEvidenceRow[]): number | null {
  const bySymbol = new Map<string, number>();
  let totalAbs = 0;
  for (const row of rows) {
    if (!row.symbol || !finite(row.netR)) continue;
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + Math.abs(row.netR));
    totalAbs += Math.abs(row.netR);
  }
  if (totalAbs <= 0 || bySymbol.size === 0) return null;
  return Math.round((Math.max(...bySymbol.values()) / totalAbs) * 1000) / 1000;
}

export function evaluateHypothesis(
  hypothesis: EdgeHypothesis,
  dataDir: string,
  policy: EdgeDiggerPolicy,
  blockWidthMs = EDGE_EPISODE_BLOCK_WIDTH_MS,
): EdgeHypothesisReport {
  const loads = hypothesis.sources.map((spec) => ({ spec, load: loadEdgeSource(dataDir, spec) }));
  const integrity = loads.map((l) => l.load.integrity);

  // F3 selects whichever of its candidate stores actually has usable evidence, and says so.
  const usable = loads.filter((l) => l.load.rows.length > 0);
  const selectedSources = usable.map((l) => l.spec.label);
  const rows = usable.flatMap((l) => l.load.rows);

  // Raw row lookup for cost stress (stopDistanceBps lives on the source row, not the normalized one).
  const rawById = new Map<string, Record<string, unknown>>();
  for (const { spec } of usable) {
    const file = resolve(dataDir, spec.store);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as RawLaneEdgeStore;
      const list = Array.isArray(parsed.observations) ? parsed.observations : [];
      for (const item of list) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (typeof rec.observationId === "string") rawById.set(rec.observationId, rec);
        }
      }
    } catch { /* already reported as unparseable in integrity */ }
  }

  const episodes = edgeEpisodeStats(rows, blockWidthMs);
  const metrics = edgeMetrics(rows);
  const bootstrap = edgeClusterBootstrap(rows, blockWidthMs);
  const parts = partitionByEpisode(rows, blockWidthMs);
  const partitions: EdgePartition[] = ([
    ["DEV", parts.dev], ["VALIDATION_OOS", parts.validation], ["RECENT", parts.recent],
  ] as const).map(([partition, slice]) => ({
    partition,
    rows: slice.length,
    episodes: countIndependentEpisodes(slice.map(episodeIdentityOf), blockWidthMs),
    metrics: edgeMetrics(slice),
  }));

  const topSymbolShare = topSymbolShareOf(rows);
  const concentration = {
    topSymbolShare,
    topSymbolShareLimit: policy.maxTopSymbolPnlShare,
    largestEpisodeShare: episodes.largestEpisodeShare,
    rowsPerEpisode: episodes.rowsPerEpisode,
    excessive: topSymbolShare !== null && topSymbolShare > policy.maxTopSymbolPnlShare,
  };

  const comparisons: EdgeComparison[] = [
    {
      label: "NO_TRADE (flat)",
      netExpectancyR: 0,
      beatsHypothesis: (metrics.netExpectancyR ?? 0) <= 0,
      note: "staying flat costs nothing; any non-positive after-cost expectancy loses to it",
    },
    {
      label: "Simple baseline (gross, i.e. the same entries with zero cost)",
      netExpectancyR: metrics.grossExpectancyR,
      beatsHypothesis: (metrics.grossExpectancyR ?? 0) > (metrics.netExpectancyR ?? 0),
      note: "isolates how much of the result cost alone destroys",
    },
  ];

  const devPart = partitions.find((p) => p.partition === "DEV")!;
  const valPart = partitions.find((p) => p.partition === "VALIDATION_OOS")!;
  const recentPart = partitions.find((p) => p.partition === "RECENT")!;

  const gates: EdgeGate[] = [
    gate("dev_episodes", "DEV independent episodes", devPart.episodes,
      policy.devMinIndependentEpisodes, ">=", "STABLE_MIN_EFFECTIVE_N"),
    gate("validation_episodes", "Validation/OOS independent episodes", valPart.episodes,
      policy.validationMinIndependentEpisodes, ">=", "STABLE_MIN_HOLDOUT_EFFECTIVE_N"),
    gate("recent_episodes", "Recent/live/testnet independent episodes", recentPart.episodes,
      policy.recentMinIndependentEpisodes, ">=", "PROMOTION_MIN_HOLDOUT_EFFECTIVE_N"),
    gate("distinct_symbols", "Distinct symbols", episodes.distinctSymbols,
      policy.minDistinctSymbols, ">=", "STABLE_MIN_DISTINCT_SYMBOLS"),
    gate("calendar_days", "Calendar days", episodes.calendarDays,
      policy.minCalendarDays, ">=", "PROMOTION_MIN_CALENDAR_DAYS"),
    gate("top_symbol_share", "Top-symbol PnL share", topSymbolShare,
      policy.maxTopSymbolPnlShare, "<=", "MAX_TOP_SYMBOL_SHARE"),
    gate("pf", "Profit factor", metrics.pf, policy.pfFloor, ">=", "PF_FLOOR"),
  ];

  // ---- REJECT rules (F). Evaluated in the predeclared order and ALL reported, not just the first.
  const rejectionReasons: string[] = [];
  const nonCanonical = integrity.filter((i) => i.verdict !== "CANONICAL");
  if (nonCanonical.length > 0) {
    rejectionReasons.push(
      `evidence integrity: ${nonCanonical.length} source(s) carry no canonical evidence-version/` +
      `freshness/causal-lineage marker (${nonCanonical.map((i) => i.store).join(", ")}), so canonical ` +
      "readiness eligibility cannot be applied to them",
    );
  }
  if (rows.length === 0) {
    rejectionReasons.push("no eligible forward evidence recorded for this hypothesis");
  }
  if (metrics.netExpectancyR !== null && metrics.netExpectancyR <= 0) {
    rejectionReasons.push(`after-cost net expectancy ${metrics.netExpectancyR.toFixed(4)}R <= 0`);
  }
  if (metrics.pf !== null && metrics.pf <= policy.pfFloor) {
    rejectionReasons.push(`PF ${metrics.pf.toFixed(3)} <= PF_FLOOR ${policy.pfFloor}`);
  }
  if (bootstrap.lowerBound95 !== null && bootstrap.lowerBound95 <= 0) {
    rejectionReasons.push(`clustered bootstrap 95% lower bound ${bootstrap.lowerBound95.toFixed(4)}R <= 0`);
  }
  if (bootstrap.lowerBound95 === null && rows.length > 0) {
    rejectionReasons.push(
      `clustered confidence interval undefined (${bootstrap.clusters} independent episode(s)) — ` +
      "cannot establish a lower bound above zero",
    );
  }
  if (concentration.excessive) {
    rejectionReasons.push(
      `concentration: top-symbol PnL share ${topSymbolShare} > ${policy.maxTopSymbolPnlShare}`,
    );
  }
  if (comparisons[0]!.beatsHypothesis) {
    rejectionReasons.push("NO_TRADE (flat) beats the hypothesis after cost");
  }
  for (const g of gates) {
    if (!g.pass && g.blockingReason) rejectionReasons.push(`gate ${g.id}: ${g.blockingReason}`);
  }

  const decision: "CANDIDATE" | "REJECT" = rejectionReasons.length === 0 ? "CANDIDATE" : "REJECT";

  const evidenceStillNeeded: string[] = [];
  if (devPart.episodes < policy.devMinIndependentEpisodes) {
    evidenceStillNeeded.push(
      `${policy.devMinIndependentEpisodes - devPart.episodes} more independent DEV episodes ` +
      `(have ${devPart.episodes}); at a ${Math.round(blockWidthMs / 3_600_000)}h episode width that is ` +
      "elapsed market time, not more rows from the same window",
    );
  }
  if (valPart.episodes < policy.validationMinIndependentEpisodes) {
    evidenceStillNeeded.push(
      `${policy.validationMinIndependentEpisodes - valPart.episodes} more independent validation/OOS episodes (have ${valPart.episodes})`,
    );
  }
  if (recentPart.episodes < policy.recentMinIndependentEpisodes) {
    evidenceStillNeeded.push(
      `${policy.recentMinIndependentEpisodes - recentPart.episodes} more independent recent/testnet episodes (have ${recentPart.episodes})`,
    );
  }
  if (episodes.distinctSymbols < policy.minDistinctSymbols) {
    evidenceStillNeeded.push(`evidence on ${policy.minDistinctSymbols - episodes.distinctSymbols} more distinct symbol(s)`);
  }
  if ((episodes.calendarDays ?? 0) < policy.minCalendarDays) {
    evidenceStillNeeded.push(
      `${Math.max(0, policy.minCalendarDays - (episodes.calendarDays ?? 0)).toFixed(2)} more calendar days of coverage`,
    );
  }
  if (nonCanonical.length > 0) {
    evidenceStillNeeded.push(
      "canonical evidence markers on this lane family: an evidence-version pin, an entry-freshness " +
      "flag and causal lineage would let readiness-grade eligibility be applied instead of the " +
      "terminal-status-only subset available today",
    );
  }

  return {
    hypothesis,
    selectedSources,
    integrity,
    episodes,
    partitions,
    metrics,
    bootstrap,
    splits: {
      byMonth: splitBy(rows, (r) => (r.openedAt ? r.openedAt.slice(0, 7) : null), blockWidthMs),
      byRegime: splitBy(rows, (r) => r.regime, blockWidthMs),
      bySymbol: splitBy(rows, (r) => r.symbol, blockWidthMs),
    },
    costSensitivity: edgeCostSensitivity(rows, rawById),
    concentration,
    comparisons,
    gates,
    decision,
    rejectionReasons,
    evidenceStillNeeded,
  };
}

export interface EdgeDiggerReport {
  readonly version: typeof EDGE_DIGGER_VERSION;
  readonly generatedAt: string;
  readonly reportOnly: true;
  /** This pipeline can never enable anything. Stated in the payload so a consumer cannot mistake it. */
  readonly liveBlocked: true;
  readonly dataDir: string;
  readonly policy: EdgeDiggerPolicy;
  readonly episodeBlockWidthMs: number;
  readonly partitionShares: typeof EDGE_PARTITION_SHARES;
  readonly hypotheses: readonly EdgeHypothesisReport[];
  readonly candidates: readonly EdgeHypothesisId[];
  /** At most ONE bounded-experiment recommendation, and only from a CANDIDATE. */
  readonly recommendation: string | null;
  readonly notes: readonly string[];
}

export function buildEdgeDiggerReport(opts: {
  dataDir?: string;
  generatedAt?: string;
  blockWidthMs?: number;
} = {}): EdgeDiggerReport {
  const dataDir = opts.dataDir ?? "data";
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const blockWidthMs = opts.blockWidthMs ?? EDGE_EPISODE_BLOCK_WIDTH_MS;
  const policy = edgeDiggerPolicy();
  const hypotheses = EDGE_HYPOTHESES.map((h) => evaluateHypothesis(h, dataDir, policy, blockWidthMs));
  const candidates = hypotheses.filter((h) => h.decision === "CANDIDATE").map((h) => h.hypothesis.id);

  // Ranking happens on DEV only — never on the sealed validation/recent partitions.
  const ranked = hypotheses
    .filter((h) => h.decision === "CANDIDATE")
    .sort((a, b) => {
      const av = a.partitions.find((p) => p.partition === "DEV")!.metrics.netExpectancyR ?? -Infinity;
      const bv = b.partitions.find((p) => p.partition === "DEV")!.metrics.netExpectancyR ?? -Infinity;
      return bv - av;
    });

  const recommendation = ranked.length > 0
    ? `Bounded 3102 (testnet) experiment for ${ranked[0]!.hypothesis.id} only — report-only, ` +
      "campaign remains OFF and must be enabled by an operator, never by this pipeline."
    : null;

  return {
    version: EDGE_DIGGER_VERSION,
    generatedAt,
    reportOnly: true,
    liveBlocked: true,
    dataDir,
    policy,
    episodeBlockWidthMs: blockWidthMs,
    partitionShares: EDGE_PARTITION_SHARES,
    hypotheses,
    candidates,
    recommendation,
    notes: [
      "Independent episodes, never raw rows, gate every decision here.",
      "Episode identity is imported from current-guard-variant-matrix.ts (countIndependentEpisodes) — " +
        "the same union-find rule computeEffectiveN delegates to. It is never reimplemented.",
      "Ranking and selection read the DEV partition only; validation/OOS and recent can only reject.",
      "PF with a zero denominator is reported as null with an explicit pfStatus, never as a large sentinel.",
      "Historical replay is not present in any source read here and could not count as forward validation.",
    ],
  };
}

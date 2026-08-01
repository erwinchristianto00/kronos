/**
 * CORTEX Readiness (2026-07-21, operator ask) — one transparent "% ready" number + its component
 * breakdown, progress-rate, ETA, stuck/slowed classification, data-quality and reinforcement summary,
 * for the /research page. PURE: computeCortexReadiness() is deterministic over injected inputs
 * (brain-store state, latest refit report, collection status, decision-alpha, snapshot history, nowMs)
 * — no I/O, fully unit-testable. The only impure thing in this file is the small bounded daily
 * snapshot-history store at the bottom (atomic tmp+rename, never throws), which exists because most
 * readiness components (blindCapitalPct, lane coverage) have NO historical record anywhere else, so a
 * rate for them can only be measured once daily snapshots start accruing.
 *
 * ── THE FORMULA (no black box — mirrors the ACTUAL promotion-gate inputs) ─────────────────────────
 * readiness% = Σ weight_i × component_i, with:
 *
 *   betaRamp        (weight 0.40) = min(100, cumulativeResolved / CORTEX_BETA_RAMP_N × 100)
 *       — the β schedule primitive itself (cortexBeta ramps 0→β_max over CORTEX_BETA_RAMP_N=300
 *         resolved labeled outcomes; cortexPromotedBeta reuses the same ramp).
 *   capitalCoverage (weight 0.25) = min(100, max(0, (100 − blindCapitalPct) / (100 − FLOOR) × 100))
 *       — mirrors cortexPromotedBeta's blind-capital damping (coverage = 1 − blind/100), normalized
 *         so the component reaches 100% at the DOCUMENTED floor blindCapitalPct ≤ FLOOR (10%), not
 *         only at a perfect 0% (some residual blind capital is acceptable at full readiness).
 *   laneCoverage    (weight 0.20) = learningActiveLanes / rosterSize × 100
 *       — mirrors the 2026-07-21 per-lane promotion gating: only LEARNING_ACTIVE roster lanes may
 *         ever receive CORTEX's tilt, so readiness scales with how much of the roster has proven
 *         learning feedback.
 *   regimeCoverage  (weight 0.15) = min(100, regimeFamiliesWithOutcomes / CORTEX_GATE_MIN_REGIME_FAMILIES × 100)
 *       — mirrors EXACTLY how regimeCoverageGateMet is computed (cortex-refit-runner.ts:
 *         cortexRegimeFamilyCoverage(store.resolvedByFamily) ≥ CORTEX_GATE_MIN_REGIME_FAMILIES=2,
 *         i.e. families with ≥1 resolved LABELED outcome in the persisted store).
 *
 * Weights are judgment (documented, not fit): β-ramp carries the most because sample count is the
 * slowest, hardest requirement; capital > lane because a big-weight blind lane is the promotion
 * gate's own stated blocker; regime least because it's near-binary and was met early in practice.
 *
 * ── "READY" (100%) — the pre-registered definition, all four at their ceiling ─────────────────────
 *   cumulativeResolved ≥ CORTEX_BETA_RAMP_N  (full β ramp)
 *   AND regimeCoverageGateMet                 (≥2 regime families with resolved outcomes)
 *   AND blindCapitalPct ≤ CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT (10% documented floor)
 *   AND learningActiveLanes = rosterSize      (every roster lane LEARNING_ACTIVE)
 * NOTE: "ready" here means the MEASURABLE ramp/coverage inputs are saturated — it is a progress
 * meter, NOT an automatic promotion (promotion stays an explicit operator decision, and liveBeta
 * stays 0 on shadow instances regardless of this number).
 *
 * ── RATE + ETA (honest about the basis) ───────────────────────────────────────────────────────────
 * The ONLY component with a real historical record on day one is betaRamp: the brain store's
 * exact-once outcome ledger (countedObservations) stores each outcome's resolvedAtMs, so
 * resolved-per-UTC-day is directly computable. blindCapitalPct / laneCoverage / regimeCoverage have
 * no history anywhere, so:
 *   basis "history":         once the daily snapshot store has a snapshot ≥1 day old (≤~7.5d), the
 *                            rate is (readinessNow − snapshot.readinessPct) / daysElapsed — the full
 *                            multi-component rate. Preferred as soon as it exists.
 *   basis "ledger-beta-only": before that, rate = weight_betaRamp × (avg resolved/day over the last
 *                            7 UTC days / CORTEX_BETA_RAMP_N × 100) — an UNDER-estimate that ignores
 *                            the other components' movement, labeled as such. Zero once betaRamp is
 *                            already saturated.
 *   basis null:              no ledger data and no history — "cannot estimate yet".
 * ETA = (100 − readiness%) / rate, null when rate is null, ≈0, or negative.
 *
 * ── STATUS (operator thresholds, pre-registered here) ─────────────────────────────────────────────
 *   STUCK            zero newly-resolved outcomes in the last 24h
 *   STEADY_PROGRESS  last-24h resolved ≥ 60% of the prior-7-day per-24h average (or prior avg was 0
 *                    and anything resolved at all — any progress beats a zero baseline)
 *   SLOWED_DOWN      otherwise (< 60% of the prior average)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CORTEX_BETA_MAX, CORTEX_BETA_RAMP_N, cortexBeta, cortexPromotedBeta } from "./cortex-brain.js";
import { CORTEX_GATE_MIN_REGIME_FAMILIES } from "./cortex-refit-runner.js";

// ── documented tunables ───────────────────────────────────────────────────────────────────────────
/** Component weights (must sum to 1). See the module doc for the rationale. */
export const CORTEX_READINESS_WEIGHTS = {
  betaRamp: 0.4,
  capitalCoverage: 0.25,
  laneCoverage: 0.2,
  regimeCoverage: 0.15,
} as const;
/** The documented blind-capital floor: capitalCoverage reads 100% at blindCapitalPct ≤ this. */
export const CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT = 10;
/** STEADY vs SLOWED threshold: last-24h rate as a fraction of the prior-7d per-24h average. */
export const CORTEX_READINESS_STEADY_RATIO = 0.6;
/** Rates at or below this (%/day) are treated as "no usable rate" for the ETA. */
export const CORTEX_READINESS_MIN_RATE_PCT_PER_DAY = 0.01;

const DAY_MS = 86_400_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── injected inputs (the impure gather lives in cortex-readiness-bindings.ts) ─────────────────────
export interface CortexReadinessBrainInput {
  cumulativeResolved: number;
  resolvedByFamily: Record<string, number>;
  /** The resolvedAtMs values of the store's exact-once outcome ledger (countedObservations values) —
   *  the ONLY persisted per-outcome timestamp record, hence THE historical basis for resolved/day.
   *  Bounded by the store's own pruning to the refit lookback (~45d), comfortably ≥ our 8-day windows. */
  ledgerResolvedAtMs: number[];
  updatedAt: string | null;
}

export interface CortexReadinessRefitInput {
  at: string;
  examplesTotal: number;
  journalBadLines: number | null;
  blindCapitalPct: number;
  regimeCoverageGateMet: boolean;
  regimeFamiliesWithOutcomes: number;
  learningActiveLanes: number;
  evaluationBeta: number;
  archetypes: { archetype: string; status: string; examples: number }[];
  perLane: { laneId: string; status: string; staticWeightPct: number }[];
  reinforcement: { laneId: string; positive: number; noReward: number }[];
  learningEpoch: {
    id: "POST_LINEAGE_V2";
    startIso: string;
    startMs: number;
    decisionRowsExcluded: number;
    transitionalOutcomesExcluded: number;
  } | null;
  /** A configured boundary that was REFUSED (future-dated or unparseable). Present so an operator
   *  can tell "no epoch set" apart from "epoch set and rejected" — the two look identical in the
   *  meter but mean opposite things. */
  learningEpochRejection?: {
    reason: "MALFORMED" | "IN_FUTURE";
    raw: string;
    startMs: number | null;
    nowMs: number;
    aheadMs: number | null;
  } | null;
}

export interface CortexReadinessCollectionInput {
  mode: string;
  instanceId: string;
  totalEvents: number;
  decisionSnapshots: number;
  opportunitiesOpened: number;
  outcomesResolved: number;
  unresolvedOpportunities: number;
  validOutcomes: number;
  directOutcomes: number;
  economicWins: number;
  latestAt: string | null;
}

export interface CortexReadinessDecisionAlphaInput {
  n: number;
  cumulativeTiltDeltaR: number;
  meanTiltDeltaR: number | null;
  perLane: { laneId: string; n: number; cumulativeTiltDeltaR: number }[];
  clusteredCi95?: {
    clusterBy: "UTC_DAY";
    clusters: number;
    lowerMeanTiltDeltaR: number;
    upperMeanTiltDeltaR: number;
  } | null;
}

export interface CortexReadinessInputs {
  brain: CortexReadinessBrainInput | null;
  refit: CortexReadinessRefitInput | null;
  collection: CortexReadinessCollectionInput | null;
  decisionAlpha: CortexReadinessDecisionAlphaInput | null;
  /** Daily snapshots from CortexReadinessHistoryStore (any order; may be empty). */
  history: CortexReadinessSnapshot[];
  /** CORTEX_LANE_ROSTER.length at the call site (injected so this module stays dependency-light). */
  rosterSize: number;
  /** How many roster lanes were excluded as retired. Rendered in the laneCoverage detail so the
   *  denominator is never silently different from CORTEX_LANE_ROSTER.length. */
  retiredLaneCount?: number;
  nowMs: number;
}

// ── report shape ──────────────────────────────────────────────────────────────────────────────────
export type CortexReadinessComponentKey = keyof typeof CORTEX_READINESS_WEIGHTS;
export interface CortexReadinessComponent {
  key: CortexReadinessComponentKey;
  pct: number; // 0..100
  weight: number; // fraction of the headline number
  /** The underlying numbers, spelled out — the UI shows this verbatim so nothing is a black box. */
  detail: string;
}

export type CortexReadinessStatusState = "STEADY_PROGRESS" | "SLOWED_DOWN" | "STUCK";

export interface CortexReadinessReport {
  formulaVersion: 1;
  /** The full formula, as text, for the UI tooltip. */
  formula: string;
  readyDefinition: string;
  readinessPct: number;
  ready: boolean;
  learningEpoch: CortexReadinessRefitInput["learningEpoch"];
  /** Set when a boundary was configured and REFUSED. Distinguishes "no epoch" (both null) from
   *  "epoch rejected" (this non-null) — identical in the meter, opposite in meaning. */
  learningEpochRejection: CortexReadinessRefitInput["learningEpochRejection"];
  /** Additive, report-only v1 shadow-refit status. It is optional so the pure readiness formula
   * remains usable by old tests and callers without reading a candidate registry. */
  shadowRefit?: {
    resetEpoch: string | null;
    totalExamined: number;
    directLearningEligible: number;
    rejected: Readonly<Record<string, number>>;
    datasetHash: string | null;
    latestStatus: string | null;
    candidateGenerationId: string | null;
    incumbentGeneration: number | null;
    registryIntegrity: "HEALTHY" | "REGISTRY_CORRUPTED";
    registryIntegrityError: string | null;
    perArchetype: readonly {
      archetype: "BREADTH" | "NEUTRAL" | "TACTICAL";
      eligible: number;
      nEff: number;
      fitStatus: string;
      coefficientMaxDelta: number;
      oosVerdict: "VALID" | "BLOCKED";
    }[];
    beta: { evaluationBeta: 0; liveBeta: 0 };
    promotion: "OFF";
  };
  components: CortexReadinessComponent[];
  beta: {
    evaluationBeta: number;
    /** cortexPromotedBeta at the current inputs — the β a promoted (testnet) instance actually applies. */
    promotedBeta: number;
    betaMax: number;
  };
  rate: {
    pctPerDay: number | null;
    basis: "history" | "ledger-beta-only" | null;
    basisNote: string;
    /** Last 7 UTC days (oldest→today), resolved outcomes per day from the ledger. */
    resolvedPerDay: { dateUtc: string; resolved: number }[];
  };
  eta: {
    etaDays: number | null;
    etaIso: string | null;
    /** Non-null exactly when etaDays is null — WHY there is no estimate. */
    reason: string | null;
  };
  status: {
    state: CortexReadinessStatusState;
    last24hResolved: number;
    prior7dAvgPerDay: number;
    /** last24h as % of the prior-7d average (null when the prior average is 0). */
    ratioPct: number | null;
  };
  quality: {
    cumulativeResolved: number;
    examplesTotal: number | null;
    /** resolvedTotal − labeled examples: outcomes counted for the ramp that could NOT be attributed
     *  to an owning decision (TTL missed / journal rotated / schema) — a real training-data gap. */
    examplesGap: number | null;
    journalBadLines: number | null;
    archetypes: { archetype: string; status: string; examples: number }[];
    familyBalance: { family: string; resolved: number; sharePct: number }[];
    largestFamilySharePct: number | null;
    lanes: { total: number; learningActive: number; insufficientData: number; noOutcomeSource: number; schemaMismatch: number };
  };
  lineage: CortexReadinessCollectionInput | null;
  reinforcement: {
    positive: number;
    noReward: number;
    positiveSharePct: number | null;
    /** 2026-07-22 bug-hunt clarification: a snapshot of the 3 fixed archetypes' (BREADTH/NEUTRAL/
     *  TACTICAL) status from the SINGLE MOST RECENT refit tick only — refitAccepted+refitRejected+
     *  refitNoExamples always sums to exactly 3. This is NOT a cumulative count of how many refit
     *  ticks have ever run (the codebase has no such counter); the refit itself fires on its own
     *  wall-clock cadence (CORTEX_REFIT_INTERVAL_MS, default 6h) independent of these numbers. */
    refitAccepted: number;
    refitRejected: number;
    refitNoExamples: number;
    decisionAlpha: CortexReadinessDecisionAlphaInput | null;
  };
  /** Evidence-quality gate separate from the collection-progress meter above. It never changes beta
   * or auto-promotes; it states whether the accumulated alpha is diversified and statistically usable. */
  promotionEvidence: {
    ready: boolean;
    minimumExamples: number;
    examples: number;
    alphaPositive: boolean;
    clusteredCiLowerAboveZero: boolean;
    clusteredCi95: CortexReadinessDecisionAlphaInput["clusteredCi95"];
    largestPositiveLaneSharePct: number | null;
    maxPositiveLaneSharePct: number;
    largestRegimeFamilySharePct: number | null;
    maxRegimeFamilySharePct: number;
    allArchetypesAccepted: boolean;
    blockers: string[];
  };
  inputsPresent: { brain: boolean; refit: boolean; collection: boolean; decisionAlpha: boolean; historyDays: number };
}

// ── pure helpers (exported for tests) ─────────────────────────────────────────────────────────────

/** Bucket ledger resolvedAtMs into the last `days` UTC calendar days (oldest→today, inclusive). */
export function bucketResolvedByUtcDay(
  ledgerResolvedAtMs: number[],
  nowMs: number,
  days = 7,
): { dateUtc: string; resolved: number }[] {
  const buckets = new Map<string, number>();
  const order: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = utcDateStr(nowMs - i * DAY_MS);
    buckets.set(d, 0);
    order.push(d);
  }
  for (const ms of ledgerResolvedAtMs) {
    if (!Number.isFinite(ms) || ms > nowMs) continue; // ignore corrupt/future timestamps
    const d = utcDateStr(ms);
    if (buckets.has(d)) buckets.set(d, (buckets.get(d) ?? 0) + 1);
  }
  return order.map((dateUtc) => ({ dateUtc, resolved: buckets.get(dateUtc) ?? 0 }));
}

/** Count ledger outcomes resolved within (nowMs − windowMs, nowMs]. */
export function countResolvedInWindow(ledgerResolvedAtMs: number[], nowMs: number, windowMs: number, endOffsetMs = 0): number {
  const end = nowMs - endOffsetMs;
  const start = end - windowMs;
  let n = 0;
  for (const ms of ledgerResolvedAtMs) {
    if (Number.isFinite(ms) && ms > start && ms <= end) n += 1;
  }
  return n;
}

// ── the pure computation ──────────────────────────────────────────────────────────────────────────
export function computeCortexReadiness(inputs: CortexReadinessInputs): CortexReadinessReport {
  const W = CORTEX_READINESS_WEIGHTS;
  const FLOOR = CORTEX_READINESS_BLIND_CAPITAL_FLOOR_PCT;
  const nowMs = inputs.nowMs;
  const rosterSize = Math.max(1, Math.floor(finiteOr(inputs.rosterSize, 0)) || 1);
  const retiredLaneCount = Math.max(0, Math.floor(finiteOr(inputs.retiredLaneCount ?? 0, 0)));

  const cumulativeResolved = Math.max(0, finiteOr(inputs.brain?.cumulativeResolved, 0));
  const ledger = inputs.brain?.ledgerResolvedAtMs ?? [];
  const resolvedByFamily = inputs.brain?.resolvedByFamily ?? {};

  // Regime-family coverage: EXACTLY the gate's own computation (families with ≥1 resolved outcome in
  // the PERSISTED store). Prefer the brain state (the source of truth the refit itself reads); the
  // refit report's copy is only a fallback for a brain-less instance.
  const familiesFromBrain = Object.values(resolvedByFamily).filter((n) => Number.isFinite(n) && n > 0).length;
  const regimeFamiliesWithOutcomes = inputs.brain ? familiesFromBrain : Math.max(0, finiteOr(inputs.refit?.regimeFamiliesWithOutcomes, 0));
  const regimeCoverageGateMet = regimeFamiliesWithOutcomes >= CORTEX_GATE_MIN_REGIME_FAMILIES;

  const blindCapitalPct = inputs.refit ? clamp(finiteOr(inputs.refit.blindCapitalPct, 100), 0, 100) : null;
  const learningActiveLanes = inputs.refit ? Math.max(0, finiteOr(inputs.refit.learningActiveLanes, 0)) : null;

  // ── components ──────────────────────────────────────────────────────────────────────────────────
  const betaRampPct = clamp((cumulativeResolved / CORTEX_BETA_RAMP_N) * 100, 0, 100);
  const capitalCoveragePct = blindCapitalPct == null ? 0 : clamp(((100 - blindCapitalPct) / (100 - FLOOR)) * 100, 0, 100);
  const laneCoveragePct = learningActiveLanes == null ? 0 : clamp((learningActiveLanes / rosterSize) * 100, 0, 100);
  const regimeCoveragePct = clamp((regimeFamiliesWithOutcomes / CORTEX_GATE_MIN_REGIME_FAMILIES) * 100, 0, 100);

  const noRefitNote = "belum ada refit report di instance ini (report muncul setelah refit cycle pertama pasca-boot) — komponen dihitung 0, bukan diasumsikan";
  const components: CortexReadinessComponent[] = [
    {
      key: "betaRamp",
      pct: round2(betaRampPct),
      weight: W.betaRamp,
      detail: `${cumulativeResolved}/${CORTEX_BETA_RAMP_N} resolved labeled outcomes (β ramp schedule)`,
    },
    {
      key: "capitalCoverage",
      pct: round2(capitalCoveragePct),
      weight: W.capitalCoverage,
      detail:
        blindCapitalPct == null
          ? noRefitNote
          : `blind capital ${blindCapitalPct.toFixed(1)}% (bobot statis lane yang belum LEARNING_ACTIVE) — 100% tercapai saat ≤ ${FLOOR}%`,
    },
    {
      key: "laneCoverage",
      pct: round2(laneCoveragePct),
      weight: W.laneCoverage,
      detail:
        learningActiveLanes == null
          ? noRefitNote
          : `${learningActiveLanes}/${rosterSize} roster lanes LEARNING_ACTIVE`
            + (retiredLaneCount > 0 ? ` (${retiredLaneCount} retired lane(s) excluded from the denominator)` : ""),
    },
    {
      key: "regimeCoverage",
      pct: round2(regimeCoveragePct),
      weight: W.regimeCoverage,
      detail: `${regimeFamiliesWithOutcomes}/${CORTEX_GATE_MIN_REGIME_FAMILIES} regime families dengan resolved outcome (gate: ${regimeCoverageGateMet ? "MET" : "NOT MET"})`,
    },
  ];

  const readinessPctRaw =
    W.betaRamp * betaRampPct + W.capitalCoverage * capitalCoveragePct + W.laneCoverage * laneCoveragePct + W.regimeCoverage * regimeCoveragePct;
  let readinessPct = round2(clamp(readinessPctRaw, 0, 100));

  // capitalCoverage's ready-gate must key off the SAME rounded percentage the dashboard displays
  // (round2(capitalCoveragePct)), not the raw blindCapitalPct <= FLOOR comparison — a blindCapitalPct
  // only fractionally above FLOOR (e.g. 10.002 vs a 10 floor) already rounds capitalCoveragePct's
  // displayed value up to "100.00%", so comparing the UNROUNDED float here could show ready:false
  // right next to a component reading that claims full saturation — a visible contradiction.
  const ready =
    cumulativeResolved >= CORTEX_BETA_RAMP_N &&
    regimeCoverageGateMet &&
    blindCapitalPct != null &&
    round2(capitalCoveragePct) >= 100 &&
    learningActiveLanes != null &&
    learningActiveLanes >= rosterSize;

  // 2026-07-22 fix: a weighted SUM of components can round up to a clean 100.00 (e.g. 0.4*100+0.25*
  // 99.99+0.2*100+0.15*100 = 99.9975 → round2 → 100.00) even though one component (capitalCoverage)
  // hasn't actually saturated and `ready` is correctly false — the residual case the 2026-07-22
  // dedup-skip/rounding fix above didn't cover, because that fix only reconciled `ready` against its
  // OWN component's rounding, not the AGGREGATE against `ready`. Never show the headline "100.00%"
  // (and, via remainingPct below, the ETA "arrived now") while `ready` is still false.
  if (readinessPct >= 100 && !ready) readinessPct = 99.99;

  // ── rate (see module doc for the basis hierarchy) ───────────────────────────────────────────────
  const resolvedPerDay = bucketResolvedByUtcDay(ledger, nowMs, 7);
  const last24hResolved = countResolvedInWindow(ledger, nowMs, DAY_MS);
  const prior7dResolved = countResolvedInWindow(ledger, nowMs, 7 * DAY_MS, DAY_MS); // (now−8d, now−1d]
  const prior7dAvgPerDay = prior7dResolved / 7;

  let ratePctPerDay: number | null = null;
  let rateBasis: "history" | "ledger-beta-only" | null = null;
  let basisNote: string;

  // History basis: oldest snapshot from a PREVIOUS UTC day within the last ~7.5 days, ≥1 day old
  // (same-day snapshots are excluded — they'd make the span ≈0 and the rate noise).
  const todayUtc = utcDateStr(nowMs);
  const usableSnaps = inputs.history
    .filter((s) => {
      const atMs = Date.parse(s.atIso);
      return (
        Number.isFinite(atMs) &&
        s.dateUtc < todayUtc &&
        Number.isFinite(s.readinessPct) &&
        nowMs - atMs >= DAY_MS &&
        nowMs - atMs <= 7.5 * DAY_MS
      );
    })
    .sort((a, b) => Date.parse(a.atIso) - Date.parse(b.atIso));
  const baseSnap = usableSnaps[0];
  if (baseSnap) {
    const spanDays = (nowMs - Date.parse(baseSnap.atIso)) / DAY_MS;
    ratePctPerDay = round2((readinessPct - baseSnap.readinessPct) / spanDays);
    rateBasis = "history";
    basisNote = `dari snapshot harian: ${baseSnap.readinessPct.toFixed(2)}% (${baseSnap.dateUtc}) → ${readinessPct.toFixed(2)}% hari ini, ${spanDays.toFixed(1)} hari — mencakup SEMUA komponen`;
  } else if (ledger.length > 0) {
    const last7dResolved = countResolvedInWindow(ledger, nowMs, 7 * DAY_MS);
    const perDay = last7dResolved / 7;
    const betaHeadroom = betaRampPct < 100;
    // 2026-07-22 fix: once β-ramp saturates (no headroom left), this basis has no way to measure the
    // OTHER 3 components (capitalCoverage/laneCoverage/regimeCoverage) until a ≥1-day-old snapshot
    // exists for the "history" basis above to take over — it previously hard-floored to the literal
    // NUMBER 0, which the dashboard renders identically to "measured, genuinely flat" (only `null`
    // renders as the honest "—"). null here correctly falls through to the ETA branch's own
    // ratePctPerDay==null case ("belum bisa diestimasi — belum ada data rate sama sekali") instead of
    // the misleading "rate 0.00%/hari ≈ 0" text.
    ratePctPerDay = betaHeadroom ? round2(W.betaRamp * (perDay / CORTEX_BETA_RAMP_N) * 100) : null;
    rateBasis = "ledger-beta-only";
    basisNote = betaHeadroom
      ? `dari ledger outcome saja (${last7dResolved} resolved / 7 hari ≈ ${perDay.toFixed(1)}/hari → komponen β-ramp) — UNDERESTIMATE: komponen lain belum punya riwayat sampai snapshot harian terkumpul`
      : `β-ramp sudah 100% dan komponen lain belum punya riwayat harian — rate belum bisa diukur sampai snapshot pertama berumur ≥1 hari`;
  } else {
    basisNote = "belum ada data: ledger outcome kosong dan belum ada snapshot harian";
  }

  // ── ETA ─────────────────────────────────────────────────────────────────────────────────────────
  let etaDays: number | null = null;
  let etaIso: string | null = null;
  let etaReason: string | null = null;
  const remainingPct = Math.max(0, 100 - readinessPct);
  if (ready || remainingPct <= 0) {
    etaDays = 0;
    etaIso = new Date(nowMs).toISOString();
  } else if (ratePctPerDay == null || rateBasis == null) {
    etaReason = "belum bisa diestimasi — belum ada data rate sama sekali";
  } else if (ratePctPerDay <= CORTEX_READINESS_MIN_RATE_PCT_PER_DAY) {
    etaReason = `belum bisa diestimasi — rate ${ratePctPerDay.toFixed(2)}%/hari ≈ 0 (atau negatif) di basis "${rateBasis}"`;
  } else {
    etaDays = round2(remainingPct / ratePctPerDay);
    etaIso = new Date(nowMs + etaDays * DAY_MS).toISOString();
  }

  // ── status ──────────────────────────────────────────────────────────────────────────────────────
  let statusState: CortexReadinessStatusState;
  if (last24hResolved === 0) statusState = "STUCK";
  else if (prior7dAvgPerDay <= 0) statusState = "STEADY_PROGRESS"; // any progress beats a zero baseline
  else statusState = last24hResolved >= CORTEX_READINESS_STEADY_RATIO * prior7dAvgPerDay ? "STEADY_PROGRESS" : "SLOWED_DOWN";
  const ratioPct = prior7dAvgPerDay > 0 ? round2((last24hResolved / prior7dAvgPerDay) * 100) : null;

  // ── quality ─────────────────────────────────────────────────────────────────────────────────────
  const familyTotal = Object.values(resolvedByFamily).reduce((s, n) => s + (Number.isFinite(n) && n > 0 ? n : 0), 0);
  const familyBalance = Object.entries(resolvedByFamily)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .map(([family, resolved]) => ({ family, resolved, sharePct: familyTotal > 0 ? round2((resolved / familyTotal) * 100) : 0 }))
    .sort((a, b) => b.resolved - a.resolved);
  const laneStatuses = inputs.refit?.perLane ?? [];
  const laneCount = (status: string) => laneStatuses.filter((l) => l.status === status).length;
  const examplesTotal = inputs.refit ? Math.max(0, finiteOr(inputs.refit.examplesTotal, 0)) : null;

  // ── reinforcement ───────────────────────────────────────────────────────────────────────────────
  const reinforcement = inputs.refit?.reinforcement ?? [];
  const positive = reinforcement.reduce((s, r) => s + Math.max(0, finiteOr(r.positive, 0)), 0);
  const noReward = reinforcement.reduce((s, r) => s + Math.max(0, finiteOr(r.noReward, 0)), 0);
  const archetypes = inputs.refit?.archetypes ?? [];
  const refitAccepted = archetypes.filter((a) => a.status === "ACCEPTED").length;
  const refitRejected = archetypes.filter((a) => a.status.startsWith("REJECTED")).length;
  const refitNoExamples = archetypes.filter((a) => a.status === "NO_EXAMPLES").length;
  const minimumAlphaExamples = 200;
  const maxPositiveLaneSharePct = 60;
  const maxRegimeFamilySharePct = 70;
  const alpha = inputs.decisionAlpha;
  const positiveLaneTotal = (alpha?.perLane ?? []).reduce(
    (sum, lane) => sum + Math.max(0, finiteOr(lane.cumulativeTiltDeltaR, 0)),
    0,
  );
  const largestPositiveLaneSharePct =
    positiveLaneTotal > 0
      ? round2(
          Math.max(
            0,
            ...(alpha?.perLane ?? []).map((lane) => Math.max(0, finiteOr(lane.cumulativeTiltDeltaR, 0))),
          ) / positiveLaneTotal * 100,
        )
      : null;
  const alphaPositive = (alpha?.cumulativeTiltDeltaR ?? 0) > 0 && (alpha?.meanTiltDeltaR ?? 0) > 0;
  const clusteredCiLowerAboveZero = (alpha?.clusteredCi95?.lowerMeanTiltDeltaR ?? Number.NEGATIVE_INFINITY) > 0;
  const allArchetypesAccepted = archetypes.length > 0 && archetypes.every((a) => a.status === "ACCEPTED");
  const largestRegimeFamilySharePct = familyBalance.length > 0 ? familyBalance[0]!.sharePct : null;
  const promotionEvidenceBlockers: string[] = [];
  if ((alpha?.n ?? 0) < minimumAlphaExamples) promotionEvidenceBlockers.push(`decision alpha examples < ${minimumAlphaExamples}`);
  if (!alphaPositive) promotionEvidenceBlockers.push("decision alpha is not positive");
  if (!clusteredCiLowerAboveZero) promotionEvidenceBlockers.push("clustered 95% CI lower bound is not above zero");
  if (largestPositiveLaneSharePct === null || largestPositiveLaneSharePct > maxPositiveLaneSharePct) {
    promotionEvidenceBlockers.push(`positive alpha is concentrated above ${maxPositiveLaneSharePct}% in one lane`);
  }
  if (largestRegimeFamilySharePct === null || largestRegimeFamilySharePct > maxRegimeFamilySharePct) {
    promotionEvidenceBlockers.push(`resolved outcomes are concentrated above ${maxRegimeFamilySharePct}% in one regime family`);
  }
  if (!allArchetypesAccepted) promotionEvidenceBlockers.push("not all archetype refits are accepted");

  return {
    formulaVersion: 1,
    formula:
      `readiness% = ${W.betaRamp * 100}%·min(1, resolved/${CORTEX_BETA_RAMP_N})` +
      ` + ${W.capitalCoverage * 100}%·clamp01((100−blindCapital%)/(100−${FLOOR}))` +
      ` + ${W.laneCoverage * 100}%·(laneAktif/${rosterSize})` +
      ` + ${W.regimeCoverage * 100}%·min(1, regimeFamilies/${CORTEX_GATE_MIN_REGIME_FAMILIES})` +
      ` — semua input = input gate promosi yang sebenarnya (cortexPromotedBeta + regimeCoverageGateMet + per-lane LEARNING_ACTIVE)`,
    readyDefinition:
      `ready (100%) = resolved ≥ ${CORTEX_BETA_RAMP_N} DAN ≥${CORTEX_GATE_MIN_REGIME_FAMILIES} regime families DAN blind capital ≤ ${FLOOR}% DAN semua ${rosterSize} roster lane LEARNING_ACTIVE. ` +
      `Ini meteran progres — promosi tetap keputusan operator eksplisit, bukan otomatis.`,
    readinessPct,
    ready,
    learningEpoch: inputs.refit?.learningEpoch ?? null,
    learningEpochRejection: inputs.refit?.learningEpochRejection ?? null,
    components,
    beta: {
      evaluationBeta: round2(inputs.refit ? finiteOr(inputs.refit.evaluationBeta, cortexBeta(cumulativeResolved)) : cortexBeta(cumulativeResolved)),
      promotedBeta: round2(cortexPromotedBeta(cumulativeResolved, regimeCoverageGateMet, blindCapitalPct ?? 100)),
      betaMax: CORTEX_BETA_MAX,
    },
    rate: { pctPerDay: ratePctPerDay, basis: rateBasis, basisNote, resolvedPerDay },
    eta: { etaDays, etaIso, reason: etaReason },
    status: { state: statusState, last24hResolved, prior7dAvgPerDay: round2(prior7dAvgPerDay), ratioPct },
    quality: {
      cumulativeResolved,
      examplesTotal,
      examplesGap: examplesTotal == null ? null : Math.max(0, cumulativeResolved - examplesTotal),
      journalBadLines: inputs.refit?.journalBadLines ?? null,
      archetypes,
      familyBalance,
      largestFamilySharePct: familyBalance.length > 0 ? familyBalance[0]!.sharePct : null,
      lanes: {
        total: laneStatuses.length,
        learningActive: laneCount("LEARNING_ACTIVE"),
        insufficientData: laneCount("INSUFFICIENT_DATA"),
        noOutcomeSource: laneCount("NO_OUTCOME_SOURCE"),
        schemaMismatch: laneCount("SCHEMA_MISMATCH"),
      },
    },
    lineage: inputs.collection,
    reinforcement: {
      positive,
      noReward,
      positiveSharePct: positive + noReward > 0 ? round2((positive / (positive + noReward)) * 100) : null,
      refitAccepted,
      refitRejected,
      refitNoExamples,
      decisionAlpha: inputs.decisionAlpha,
    },
    promotionEvidence: {
      ready: promotionEvidenceBlockers.length === 0,
      minimumExamples: minimumAlphaExamples,
      examples: alpha?.n ?? 0,
      alphaPositive,
      clusteredCiLowerAboveZero,
      clusteredCi95: alpha?.clusteredCi95 ?? null,
      largestPositiveLaneSharePct,
      maxPositiveLaneSharePct,
      largestRegimeFamilySharePct,
      maxRegimeFamilySharePct,
      allArchetypesAccepted,
      blockers: promotionEvidenceBlockers,
    },
    inputsPresent: {
      brain: inputs.brain != null,
      refit: inputs.refit != null,
      collection: inputs.collection != null,
      decisionAlpha: inputs.decisionAlpha != null,
      historyDays: new Set(inputs.history.map((s) => s.dateUtc)).size,
    },
  };
}

// ── daily snapshot history store (bounded, atomic, never throws) ──────────────────────────────────
export interface CortexReadinessSnapshot {
  dateUtc: string; // YYYY-MM-DD (UTC)
  atIso: string; // last update time for that day
  readinessPct: number;
  components: Partial<Record<CortexReadinessComponentKey, number>>;
  cumulativeResolved: number;
  blindCapitalPct: number | null;
  learningActiveLanes: number | null;
  refitAccepted: number | null;
  refitRejected: number | null;
}

export const CORTEX_READINESS_HISTORY_MAX_DAYS = 120;

/**
 * One snapshot per UTC day (same-day record() calls UPSERT that day's entry, so a day's snapshot
 * converges to its latest value), bounded to the newest CORTEX_READINESS_HISTORY_MAX_DAYS days,
 * written atomically (tmp+rename, the repo-wide store discipline). Load and save both swallow all
 * errors — history is observability, it must never break the endpoint that records it.
 */
export class CortexReadinessHistoryStore {
  private snapshots: CortexReadinessSnapshot[] = [];

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
        if (Array.isArray(parsed)) {
          this.snapshots = parsed.filter(
            (s): s is CortexReadinessSnapshot =>
              Boolean(s) &&
              typeof s === "object" &&
              typeof (s as CortexReadinessSnapshot).dateUtc === "string" &&
              typeof (s as CortexReadinessSnapshot).atIso === "string" &&
              Number.isFinite((s as CortexReadinessSnapshot).readinessPct),
          );
        }
      }
    } catch {
      this.snapshots = []; // corrupt → start fresh (equivalent to "no history yet")
    }
  }

  all(): CortexReadinessSnapshot[] {
    return [...this.snapshots];
  }

  /** Upsert the snapshot's UTC day, trim to the newest MAX_DAYS, persist atomically. Never throws.
   *  Skips the disk write when the day's stored values are effectively unchanged (the endpoint calls
   *  this on every dashboard poll — no reason to rewrite an identical file every 60s). */
  record(snapshot: CortexReadinessSnapshot): void {
    try {
      if (typeof snapshot.dateUtc !== "string" || !Number.isFinite(snapshot.readinessPct)) return;
      const existing = this.snapshots.find((s) => s.dateUtc === snapshot.dateUtc);
      if (
        existing &&
        round2(existing.readinessPct) === round2(snapshot.readinessPct) &&
        existing.cumulativeResolved === snapshot.cumulativeResolved &&
        existing.blindCapitalPct === snapshot.blindCapitalPct &&
        existing.learningActiveLanes === snapshot.learningActiveLanes &&
        existing.refitAccepted === snapshot.refitAccepted &&
        existing.refitRejected === snapshot.refitRejected
      ) {
        return; // unchanged today — no write
      }
      this.snapshots = this.snapshots.filter((s) => s.dateUtc !== snapshot.dateUtc);
      this.snapshots.push(snapshot);
      this.snapshots.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
      if (this.snapshots.length > CORTEX_READINESS_HISTORY_MAX_DAYS) {
        this.snapshots = this.snapshots.slice(this.snapshots.length - CORTEX_READINESS_HISTORY_MAX_DAYS);
      }
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshots), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      /* history persistence is best-effort — never throw into the endpoint */
    }
  }
}

let historySingleton: CortexReadinessHistoryStore | null = null;
export function getCortexReadinessHistoryStore(dataDir = "data"): CortexReadinessHistoryStore {
  if (!historySingleton) historySingleton = new CortexReadinessHistoryStore(resolve(dataDir, "cortex-readiness-history.json"));
  return historySingleton;
}
export function _resetCortexReadinessHistoryStoreForTests(): void {
  historySingleton = null;
}

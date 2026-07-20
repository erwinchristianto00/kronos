/**
 * CORTEX — Central Outcome-attributed Regime-Tiered EXecutive allocator (2026-07-12).
 *
 * The central decision brain that sits ABOVE the ~13 federated lanes and decides, each cycle, the
 * overall posture + a per-lane capital-weight vector — subsuming the static lane-allocation table and
 * RegimeAutopilot's hardcoded presets. It DECIDES; the live-execution-engine still ENFORCES every
 * risk rail (kill-switch, correlated caps, daily-loss, netting, $50 notional cap) — the brain can
 * only produce an allocation vector that flows through the engine's existing validation, so it
 * structurally cannot bypass any guard.
 *
 * This module is PURE + deterministic + has no I/O beyond the store. Phase 1 is SHADOW-only: it is
 * NOT wired to drive any allocation yet. Two entry points:
 *   - decideCortex(context, store, {beta})  → a CortexDecision (posture + per-lane weights + rationale).
 *   - refitArchetypeCoefficients(examples, wPrior, opts) → new logistic coefficients (the learning).
 *
 * "Starts == incumbent" guarantee (PRECISE wording — NOT "byte-identical to the raw static preset"):
 * the emitted weight = (1−β)·staticTable + β·learned, β ramps from 0 by cumulative resolved sample, so
 * with zero learning history β=0 ⇒ blended = static. But CORTEX ALSO applies the same proven-negative
 * `vetoed` hard-zero the live federated system already applies (edge-memory VETO / controller NO_TRADE) —
 * so at β=0 the output equals the POST-FEDERATED-VETO incumbent allocation (static with vetoed lanes
 * zeroed + gross-scaled), NOT the raw preset. That IS what the incumbent actually runs today, provided
 * those vetoes are active on the incumbent (they are). Anti-overfit: lanes pool into 3 archetypes that
 * SHARE a coefficient vector (thin lanes borrow strength), the refit is prior-anchored with λ ∝ 1/N_eff
 * (thin data ⇒ degrade to the prior/static), edge magnitudes are empirical-Bayes shrunk, and β caps the tilt.
 */

export type CortexArchetype = "BREADTH" | "NEUTRAL" | "TACTICAL";
export type CortexPosture = "RISK_ON" | "RISK_OFF" | "FLAT";
export type CortexDirectionStance = "LONG" | "SHORT" | "BOTH" | "NONE";

/** Feature vector dimension — must match laneFeatureVector + coefficient length. */
export const CORTEX_FEATURE_DIM = 10;
export const CORTEX_FEATURE_NAMES = [
  "bias",
  "axisAligned",
  "velAligned",
  "shrunkEdge",
  "logN",
  "laneNetAvgR",
  "lanePf",
  "crowdingAlign",
  "kronosAgree",
  "conviction",
] as const;

// ── tunables (code-anchored, not outcome-fit — the shadow is the calibration pass) ────────────────
export const CORTEX_LANE_CAP_PCT = 35; // no single lane may exceed this share
export const CORTEX_SHRINK_K = 40; // empirical-Bayes shrinkage strength for lane edge magnitude
export const CORTEX_BETA_MAX = 0.3; // max tilt away from the static table (canary ceiling)
export const CORTEX_BETA_RAMP_N = 300; // resolved closes to ramp β from 0 → β_max
export const CORTEX_VEL_FULL = 0.03; // axis slope that saturates the velocity feature
export const CORTEX_EDGE_R_FULL = 0.2; // avgNetR that saturates the edge feature
/** Allocation-magnitude cap (R): bounds ANY lane's edge magnitude to the directional-edge range, so a
 *  large neutral-basket R (e.g. XSEC ~2R) can't dominate the allocation. */
export const CORTEX_MAX_EDGE_MAGNITUDE_R = 0.5;
// Deterministic deleverage is driven by killBudgetUtilization (0..1 = drawdownUsd / kill budget), NOT by
// portfolioDrawdownPct (which is a context/telemetry feature, never normalized against an arbitrary DD_MAX).
export const CORTEX_KILL_UTIL_TILT_START = 0.4; // below: full gross
export const CORTEX_KILL_UTIL_AGGRESSIVE = 0.7; // gradual deleverage below, aggressive above
export const CORTEX_GROSS_AT_AGGRESSIVE = 0.6; // gross G at util=0.70
export const CORTEX_GROSS_FLOOR = 0.25; // gross G at util>=1.0 (engine kill rail takes over there)
export const CORTEX_REFIT_HALF_LIFE_DAYS = 45;
export const CORTEX_REFIT_KAPPA = 60; // λ = λ0·κ/(κ+N_eff)
export const CORTEX_REFIT_LAMBDA0 = 1;
export const CORTEX_REFIT_MAX_JUMP = 8; // reject a refit whose max|w−wPrior| exceeds this (blown-up / separated fit)
/** Bump on ANY change to laneFeatureVector's order/semantics. A same-length feature REORDER would
 *  otherwise silently redefine every learned coefficient (and all 3 archetypes pool one vector, so a
 *  single reorder corrupts all three) — the schema version makes stale training rows self-reject. */
export const CORTEX_FEATURE_SCHEMA_VERSION = 1;
/** netR label hurdle: a win must clear round-trip cost + a small economically-meaningful edge, so a
 *  fee-scratch +0.01R is labelled a loss (y=0), not a win — the model learns edge, not just direction. */
export const CORTEX_WIN_HURDLE_R = 0.03;
/** Tier-1 direction is a SOFT lean on the learned channel, NOT a hard gate (our own measurement:
 *  hard regime-gating hurts every lane; counter-regime fades are what work). Default neutral for the
 *  shadow pass — let the pooled model + the edge-memory veto do the gating, tune the lean only if the
 *  shadow shows posture-conditioning helps. The ONLY hard directional zero is a proven-negative veto. */
export const CORTEX_DIR_ALIGN_LEAN = 1.0;
export const CORTEX_DIR_COUNTER_LEAN = 1.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function finiteOr(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}
function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}
/** Numerically stable log(1+exp(v)) — used to compute the logistic log-likelihood without ever
 *  taking log(sigmoid(z)) directly (which underflows to log(0) once z saturates the sigmoid). */
function softplus(v: number): number {
  return v > 0 ? v + Math.log1p(Math.exp(-v)) : Math.log1p(Math.exp(v));
}
/** The exact objective refitArchetypeCoefficients's Newton step descends (ridge-penalized weighted
 *  negative log-likelihood) — used only to backtrack an oversized step, never to change the fit
 *  itself. -log(p)=softplus(-z), -log(1-p)=softplus(z), so this needs no separate sigmoid() call. */
function penalizedNegLogLik(
  w: readonly number[],
  rows: readonly CortexTrainingExample[],
  a: readonly number[],
  wPrior: readonly number[],
  lambda: number,
): number {
  let nll = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const z = dot(w, rows[r]!.x);
    nll += a[r]! * (rows[r]!.y === 1 ? softplus(-z) : softplus(z));
  }
  let penalty = 0;
  for (let i = 0; i < w.length; i += 1) penalty += (w[i]! - wPrior[i]!) ** 2;
  return nll + 0.5 * lambda * penalty;
}

export interface CortexLaneInput {
  laneId: string;
  archetype: CortexArchetype;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  /** Proven regime×direction edge (regime-edge-memory). */
  edgeMemAvgNetR: number | null;
  edgeMemN: number;
  /** The lane's OWN rolling realized edge (its report) + its resolved-close count (for the NEUTRAL-lane
   *  allocation-magnitude shrink — a neutral basket has no directional edge-memory). */
  laneNetAvgR: number | null;
  laneNetAvgN: number;
  lanePf: number | null;
  /** −1..+1 alignment of derivatives crowding with the lane's direction. */
  crowdingAlign: number | null;
  /** −1..+1 agreement of the Kronos forecast (null ~55% of the time — NaN-guarded). */
  kronosAgree: number | null;
  /** Controller graduated convictionScore 0..1. */
  convictionScore: number | null;
  /** True when edge-memory VETO or the controller (NO_TRADE / edgeGated) hard-blocks this lane. */
  vetoed: boolean;
  /** Today's static allocation weight for this lane (the incumbent the brain tilts around). */
  staticWeightPct: number;
}

export interface CortexContext {
  regimeFamily: string;
  axisScore: number | null;
  axisSlopePerHour: number | null;
  /** Which directions the shared posture layer currently allows. */
  allowLong: boolean;
  allowShort: boolean;
  /** Real drawdown = (equityPeak − currentEquity)/equityPeak, fraction of peak equity. CONTEXT /
   *  telemetry only — does NOT drive gross (never normalized against an arbitrary DD_MAX). */
  portfolioDrawdownPct: number;
  /** 0..1(+): currentDrawdownUsd / kill-budget. DRIVES the deterministic deleverage schedule. */
  killBudgetUtilization: number;
  killLatched: boolean;
  lanes: CortexLaneInput[];
}

export interface CortexLaneDecision {
  laneId: string;
  archetype: CortexArchetype;
  eligible: boolean;
  pWin: number; // learned P(after-cost win | context)
  /** The lane's edge estimate BEFORE the magnitude cap — edge-memory shrink (directional) or own-edge
   *  shrink (neutral). Can be negative/large. (Kept under the legacy name `shrunkNetR` too, = same value.) */
  edgeEstimatePreCap: number;
  shrunkNetR: number;
  /** The allocation magnitude AFTER max(0,·) + the CORTEX_MAX_EDGE_MAGNITUDE_R cap — what actually
   *  scales `raw`. `magnitudeCapped` is true when the cap bound it (edge exceeded the ceiling). Journalled
   *  so a lane that CONTINUOUSLY hammers the cap (e.g. an aggressive XSEC edge) is visible at a glance. */
  allocationMagnitude: number;
  magnitudeCapped: boolean;
  staticPct: number;
  learnedPct: number; // the lane's share of the learned channel (pre-blend), 0..100
  finalPct: number; // the blended + capped + gross-scaled final weight, 0..100
  sizingMult: number;
  reason: string;
  /** The EXACT feature vector fed to the logistic this cycle (length CORTEX_FEATURE_DIM). Surfaced +
   *  journalled so the SHADOW's accumulating decisions ARE valid training rows: #218 attaches the y-label
   *  (the lane's own counterfactual close after this decision's timestamp) to THIS x — without capturing
   *  x at decision time the features are unrecoverable later and weeks of shadow data would be untrainable. */
  featureVector: number[];
}

export interface CortexDecision {
  posture: CortexPosture;
  directionStance: CortexDirectionStance;
  grossG: number; // 0..1 leverage scalar (drawdown/kill deleverage)
  beta: number; // tilt weight actually applied this cycle
  /** Predicted R-delta of the brain's tilt vs the (gross-scaled) static table, using the model's own
   *  shrunk edge estimate. 0 at β=0. At resolution, |expected − realized| is the reality-gap the
   *  pre-registered promotion gate watches (the −193% real-vs-sim scar demands this be measured). */
  expectedTiltDeltaR: number;
  featureSchemaVersion: number;
  lanes: CortexLaneDecision[];
  rationale: string;
}

/** Direction sign for the directional features; neutral baskets don't lean, so 0. */
function laneDirSign(direction: CortexLaneInput["direction"]): number {
  return direction === "LONG" ? 1 : direction === "SHORT" ? -1 : 0;
}

/**
 * Assemble a lane's feature vector from signals that ALREADY exist per cycle (no new signal math).
 * Order must match CORTEX_FEATURE_NAMES. Missing signals fall to a neutral 0 (conviction to 0.5).
 */
export function laneFeatureVector(
  lane: CortexLaneInput,
  ctx: CortexContext,
  shrunkNetR: number,
): number[] {
  const d = laneDirSign(lane.direction);
  const axis = finiteOr(ctx.axisScore, 0);
  const slope = finiteOr(ctx.axisSlopePerHour, 0);
  return [
    1, // bias
    clamp(d * axis, -1, 1), // axisAligned
    clamp((d * slope) / CORTEX_VEL_FULL, -1, 1), // velAligned
    clamp(shrunkNetR / CORTEX_EDGE_R_FULL, -1, 1), // shrunkEdge
    Math.log1p(Math.max(0, finiteOr(lane.edgeMemN, 0))) / 5, // logN (~n=148 → 1.0); finiteOr: a NaN/Inf n (corrupt/missing-field edge-stat) would else make x[4]=NaN → pWin=NaN → rawSum=NaN → the whole learned channel silently zeroes book-wide AND slips past the finite-weight invariant
    clamp(finiteOr(lane.laneNetAvgR, 0) / CORTEX_EDGE_R_FULL, -1, 1), // laneNetAvgR
    clamp(finiteOr(lane.lanePf, 1) - 1, -1, 2), // lanePf centered at 1
    clamp(finiteOr(lane.crowdingAlign, 0), -1, 1), // crowdingAlign
    clamp(finiteOr(lane.kronosAgree, 0), -1, 1), // kronosAgree
    clamp01(finiteOr(lane.convictionScore, 0.5)), // conviction
  ];
}

/** Empirical-Bayes shrink a lane's edge magnitude toward its archetype mean (thin n ⇒ toward mean). */
export function shrinkEdge(avgNetR: number | null, n: number, archetypeMean: number): number {
  const raw = finiteOr(avgNetR, 0);
  const nn = Math.max(0, Number.isFinite(n) ? n : 0);
  const wData = nn / (nn + CORTEX_SHRINK_K);
  return wData * raw + (1 - wData) * archetypeMean;
}

/** Sample-gated shrink of a lane's OWN realized edge toward the neutral prior (0). Used as the
 *  allocation magnitude for NEUTRAL lanes (which have no directional edge-memory) so the XSEC %→R
 *  edge can actually move their weight, not just their p_win. Thin n ⇒ toward 0; null ⇒ 0. */
export function shrinkTowardZero(avgNetR: number | null | undefined, n: number, k = CORTEX_SHRINK_K): number {
  if (!(typeof avgNetR === "number" && Number.isFinite(avgNetR))) return 0;
  const nn = Math.max(0, Number.isFinite(n) ? n : 0);
  return (nn / (nn + k)) * avgNetR;
}

/**
 * Deterministic deleverage schedule driven by killBudgetUtilization (0..1 relative to the kill
 * threshold): <0.40 no tilt (G=1); 0.40–0.70 gradual (1→0.6); 0.70–1.0 aggressive (0.6→0.25);
 * ≥1.0 floored (the engine kill rail takes over there). NOT driven by portfolioDrawdownPct.
 */
export function grossFromKillUtil(util: number): number {
  const u = Math.max(0, finiteOr(util, 0));
  if (u < CORTEX_KILL_UTIL_TILT_START) return 1;
  if (u < CORTEX_KILL_UTIL_AGGRESSIVE) {
    const t = (u - CORTEX_KILL_UTIL_TILT_START) / (CORTEX_KILL_UTIL_AGGRESSIVE - CORTEX_KILL_UTIL_TILT_START);
    return 1 - t * (1 - CORTEX_GROSS_AT_AGGRESSIVE);
  }
  if (u < 1) {
    const t = (u - CORTEX_KILL_UTIL_AGGRESSIVE) / (1 - CORTEX_KILL_UTIL_AGGRESSIVE);
    return CORTEX_GROSS_AT_AGGRESSIVE - t * (CORTEX_GROSS_AT_AGGRESSIVE - CORTEX_GROSS_FLOOR);
  }
  return CORTEX_GROSS_FLOOR;
}

/** β ramps from 0 → β_max by cumulative resolved sample, capped at β_max. This is the SCHEDULE
 *  primitive — it does NOT decide whether the tilt reaches live money. See the two channels below. */
export function cortexBeta(cumulativeResolved: number, betaMax = CORTEX_BETA_MAX): number {
  const n = Math.max(0, Number.isFinite(cumulativeResolved) ? cumulativeResolved : 0);
  return betaMax * clamp01(n / CORTEX_BETA_RAMP_N);
}

// ── β is TWO channels, never one (operator hard rule, 2026-07-13). ────────────────────────────────
// The scar this prevents: "300 resolved ⇒ β auto-rises" would silently promote the brain onto real
// allocations by sample-count alone — the exact thing the pre-registered promotion gate exists to stop.
//
//   evaluationBeta(cumulativeResolved) — schedule-driven. Drives ONLY the shadow counterfactual decision
//      that #219 measures (decision-alpha). Simulation only; touches no allocation, no order, no money.
//   CORTEX_LIVE_BETA — the β actually applied to any live/driving allocation. HARD 0. It changes ONLY
//      via an explicit, gated, operator-approved promotion — NEVER as a function of cumulativeResolved.
//
// So: learning proceeds (coefficients refit), the shadow measures what the brain WOULD do at the ramped
// β, but the operational allocation stays the β=0 post-veto incumbent until the gate passes + a human says
// go. The training data (the per-lane feature x) is β-INDEPENDENT, so this split costs the learner nothing.
export const CORTEX_LIVE_BETA = 0;
/** SHADOW-ONLY counterfactual β (for decision-alpha simulation). NOT the live β. Never feed this into a
 *  decision whose weights drive real allocation — that path uses CORTEX_LIVE_BETA (0) until promotion. */
export function evaluationBeta(cumulativeResolved: number, betaMax = CORTEX_BETA_MAX): number {
  return cortexBeta(cumulativeResolved, betaMax);
}

export interface CortexArchetypeState {
  w: number[]; // logistic coefficients (length CORTEX_FEATURE_DIM)
  refitAt: string | null;
  nEff: number;
}
export interface CortexStoreState {
  version: 1;
  featureSchemaVersion: number;
  archetypes: Record<CortexArchetype, CortexArchetypeState>;
  /** Count of resolved LABELED training outcomes attributed so far (feeds evaluationBeta's schedule).
   *  This is NOT a count of decision ticks — a decision the brain emitted that no trade ever acted on
   *  contributes 0. The promotion gate's ≥2-regime-family test reads resolvedByFamily, not the journal. */
  cumulativeResolved: number;
  /** Resolved LABELED outcomes per regime family (the ≥2-family promotion gate counts THESE). Advanced by
   *  the nightly refit as it attributes outcomes — a family with 0 resolved outcomes has 0 coverage even
   *  if the brain decided under it hundreds of times. */
  resolvedByFamily: Record<string, number>;
  /** Exact-once ledger of outcomes already folded into cumulativeResolved/resolvedByFamily: key
   *  `laneId::observationId` → the outcome's resolvedAtMs (kept only for pruning). This replaces a scalar
   *  resolvedAt high-watermark, which UNDER-counts: resolvedAt is CANDLE/event time (not processing time),
   *  so a fast lane resolving on a later candle would advance a watermark past a slow lane's earlier-candle
   *  resolution and drop it forever. A per-outcome set is exact-once + idempotent + monotonic; it is
   *  pruned to the refit lookback each run (an outcome older than the lookback can't re-appear), so bounded. */
  countedObservations: Record<string, number>;
  updatedAt: string | null;
}

/** A brain that has learned nothing: zero coefficients (p=0.5 everywhere) — combined with β-ramp
 *  from 0, the emitted allocation equals the static table until real outcomes accrue. */
export function emptyCortexState(): CortexStoreState {
  const zero = (): CortexArchetypeState => ({ w: new Array(CORTEX_FEATURE_DIM).fill(0), refitAt: null, nEff: 0 });
  return {
    version: 1,
    featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
    archetypes: { BREADTH: zero(), NEUTRAL: zero(), TACTICAL: zero() },
    cumulativeResolved: 0,
    resolvedByFamily: {},
    countedObservations: {},
    updatedAt: null,
  };
}

/**
 * The core decision. Pure: deterministic in (ctx, state, opts). Emits posture + a per-lane weight
 * vector = (1−β)·static + β·learned, deleveraged by the drawdown/kill gross scalar G. The ONLY hard
 * zero is a `vetoed` lane (proven-negative edge) or kill/FLAT posture. Direction is a SOFT lean
 * (dirLean, default 1.0), NOT a gate — a counter-posture lane is discounted, never zeroed (our own
 * measurement: hard regime-gating hurts every lane). So a direction-incompatible lane CAN still be funded.
 */
export function decideCortex(
  ctx: CortexContext,
  state: CortexStoreState,
  opts: { beta?: number } = {},
): CortexDecision {
  const beta = clamp01(finiteOr(opts.beta, cortexBeta(state.cumulativeResolved))); // finiteOr not ?? — `??` lets NaN through and clamp01(NaN)=NaN poisons the whole allocation + expectedTiltDeltaR
  const killUtil = Math.max(0, finiteOr(ctx.killBudgetUtilization, 0)); // NaN/negative → 0 (defensive)

  // ── Tier 1 — posture + gross scalar (the light governor). ──────────────────────────────────────
  // Gross deleverages on the DETERMINISTIC kill-budget schedule (grossFromKillUtil), NOT on the raw
  // portfolio drawdown fraction — so the deleverage kick-in is anchored to how much of the actual kill
  // budget is spent, not to an arbitrary DD_MAX. Aggressive band (util≥0.70) flips posture to RISK_OFF.
  let posture: CortexPosture;
  let grossG: number;
  if (ctx.killLatched) {
    posture = "FLAT";
    grossG = 0;
  } else {
    grossG = grossFromKillUtil(killUtil);
    posture = killUtil >= CORTEX_KILL_UTIL_AGGRESSIVE ? "RISK_OFF" : "RISK_ON";
  }
  const directionStance: CortexDirectionStance =
    ctx.allowLong && ctx.allowShort ? "BOTH" : ctx.allowLong ? "LONG" : ctx.allowShort ? "SHORT" : "NONE";
  // Direction is a SOFT lean on the learned channel, not a hard gate: an aligned lane is amplified,
  // a counter-posture lane is discounted (never zeroed) — the ONLY hard directional zero is `vetoed`
  // (a proven-negative edge). Defaults are neutral (1.0/1.0) for the shadow pass. This is the fix for
  // the "Tier-1 = covert regime gate" trap: a NO_TRADE-family label no longer zeroes every lane.
  const dirLean = (laneDir: CortexLaneInput["direction"]): number => {
    if (laneDir === "NEUTRAL" || directionStance === "BOTH" || directionStance === "NONE") return 1;
    const aligned =
      (directionStance === "LONG" && laneDir === "LONG") || (directionStance === "SHORT" && laneDir === "SHORT");
    return aligned ? CORTEX_DIR_ALIGN_LEAN : CORTEX_DIR_COUNTER_LEAN;
  };

  // Archetype mean edge (for shrinkage) from THIS cycle's lanes with real samples.
  const archMean: Record<CortexArchetype, number> = { BREADTH: 0, NEUTRAL: 0, TACTICAL: 0 };
  for (const arch of ["BREADTH", "NEUTRAL", "TACTICAL"] as CortexArchetype[]) {
    const withData = ctx.lanes.filter((l) => l.archetype === arch && l.edgeMemN > 0 && Number.isFinite(l.edgeMemAvgNetR ?? NaN));
    archMean[arch] = withData.length ? withData.reduce((s, l) => s + (l.edgeMemAvgNetR as number), 0) / withData.length : 0;
  }

  // ── Tier 2 — per-lane learned weight. ──────────────────────────────────────────────────────────
  const laneCalc = ctx.lanes.map((lane) => {
    // Eligibility hard-gates ONLY on the proven-negative veto + risk (kill / FLAT). Direction is a
    // soft lean applied to `raw` below, NOT an eligibility gate.
    const eligible = !lane.vetoed && !ctx.killLatched && posture !== "FLAT";
    const isDirectional = lane.direction === "LONG" || lane.direction === "SHORT";
    // `shrunk` = the edge-memory feature (feeds x[3], schema v1 unchanged) — directional lanes only.
    const shrunk = shrinkEdge(lane.edgeMemAvgNetR, lane.edgeMemN, archMean[lane.archetype]);
    const x = laneFeatureVector(lane, ctx, shrunk);
    // finiteOr(z,0) is defense-in-depth: the store already rejects a non-finite coefficient vector on load
    // (and applyRefit only writes ACCEPTED finite fits), so z is finite in production — but a corrupt model
    // must NEVER produce a NaN pWin that journals a NaN + silently zeroes the whole learned channel.
    const z = dot(state.archetypes[lane.archetype].w, x);
    const pWin = eligible ? sigmoid(finiteOr(z, 0)) : 0;
    // Allocation MAGNITUDE (separate from the feature vector): directional lanes use the proven
    // regime×direction edge-memory; NEUTRAL lanes (XSEC — no directional edge-memory) use their OWN
    // sample-gated shrunk realized edge, so an XSEC %→R edge can actually move the weight (not just
    // p_win). Always finite, non-negative, and capped so a large neutral R can't dominate.
    const edgeEstimate = isDirectional ? shrunk : shrinkTowardZero(lane.laneNetAvgR, lane.laneNetAvgN);
    const allocationMagnitude = clamp(Math.max(0, edgeEstimate), 0, CORTEX_MAX_EDGE_MAGNITUDE_R);
    const magnitudeCapped = Math.max(0, edgeEstimate) > CORTEX_MAX_EDGE_MAGNITUDE_R; // positive edge hit the ceiling
    const raw = eligible ? Math.max(0, pWin - 0.5) * allocationMagnitude * dirLean(lane.direction) : 0;
    const reason = lane.vetoed
      ? "edge-memory / controller veto"
      : ctx.killLatched
        ? "kill-switch latched"
        : posture === "FLAT"
          ? "posture FLAT"
          : dirLean(lane.direction) < 1
            ? "eligible (counter-posture discount)"
            : "eligible";
    return { lane, eligible, edgeEstimate, allocationMagnitude, magnitudeCapped, pWin, raw, reason, x };
  });

  const rawSum = laneCalc.reduce((s, c) => s + c.raw, 0);

  const lanes: CortexLaneDecision[] = laneCalc.map((c) => {
    const staticPct = Math.max(0, finiteOr(c.lane.staticWeightPct, 0)); // NaN-guard the one un-wrapped input
    const learnedPct = rawSum > 0 && c.eligible ? (c.raw / rawSum) * 100 : 0;
    // Blend toward the static table by β, then deleverage by gross. Eligibility hard-gates on veto/
    // risk only. The de-concentration cap is applied to the TILT, never below the static incumbent:
    // min(blended, max(static, cap)) — so a lane the live table already runs at 80% is NOT silently
    // cut to 35% at β=0. Among ELIGIBLE lanes at β=0 the weight is exactly static × G; a `vetoed` lane is
    // zeroed (same as the incumbent's federated veto). So β=0 == POST-FEDERATED-VETO incumbent, NOT raw preset.
    const blended = (1 - beta) * staticPct + beta * learnedPct;
    const effectiveCap = Math.max(staticPct, CORTEX_LANE_CAP_PCT);
    const finalPct = c.eligible ? Math.min(blended, effectiveCap) * grossG : 0;
    const sizingMult = clamp(0.85 + 0.5 * finiteOr(c.lane.convictionScore, 0.5) * Math.sign(c.edgeEstimate), 0.5, 1.5);
    return {
      laneId: c.lane.laneId,
      archetype: c.lane.archetype,
      eligible: c.eligible,
      pWin: c.pWin,
      edgeEstimatePreCap: c.edgeEstimate,
      shrunkNetR: c.edgeEstimate,
      allocationMagnitude: c.allocationMagnitude,
      magnitudeCapped: c.magnitudeCapped,
      staticPct,
      learnedPct,
      finalPct,
      sizingMult,
      reason: c.reason,
      featureVector: c.x,
    };
  });

  // Reality-gap prediction: the R-delta the brain's tilt is EXPECTED to add vs the gross-scaled static
  // table, per the model's own shrunk edge. 0 at β=0. Compared to realized at resolution.
  const expectedTiltDeltaR = lanes.reduce((s, l) => {
    const staticShareG = (Math.max(0, l.staticPct) * grossG) / 100;
    return s + (l.finalPct / 100 - staticShareG) * l.shrunkNetR;
  }, 0);

  const topLanes = [...lanes]
    .filter((l) => l.finalPct > 0)
    .sort((a, b) => b.finalPct - a.finalPct)
    .slice(0, 3)
    .map((l) => `${l.laneId} ${l.finalPct.toFixed(1)}%`);
  const rationale =
    `${posture}/${directionStance} · β=${beta.toFixed(2)} · G=${grossG.toFixed(2)} · ` +
    (topLanes.length ? `top: ${topLanes.join(", ")}` : "no lanes funded");

  return { posture, directionStance, grossG, beta, expectedTiltDeltaR, featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, lanes, rationale };
}

// ── Learning: decay-weighted, prior-anchored logistic refit via Newton–IRLS ───────────────────────
//
// #218 ATTRIBUTION CONTRACT (implemented in cortex-attribution.ts + cortex-outcome-source.ts). These are
// the ONLY ways to silently waste the weeks of shadow data, so getting them right IS #218:
//  1. ITERATE OUTCOMES, NOT DECISIONS — one owning decision per trade. For each resolved lane trade
//     (its OWN counterfactual close, allocation-independent), pick THE ONE decision that owns it:
//     the LATEST journaled decision with `at <= openedAtMs` AND `at >= openedAtMs − signalTtl(lane)`
//     that had this lane present + ELIGIBLE (staticWeight>0, not vetoed) AND matching direction + schema.
//     The earlier loose form ("for each decision, the next trade with openedAtMs >= at") is WRONG: every
//     5-min decision tick before one open would claim that same trade → one trade mislabels many rows.
//     The TTL bound stops attributing a trade to a decision from hours prior (no signal in that window ⇒
//     the trade is UNATTRIBUTED, dropped + counted — never force a stale match, never key on resolvedAt).
//  2. ONE OUTCOME CLAIMED ONCE. Dedupe examples by (laneId, observationId) so a nightly re-read never
//     double-counts the same trade. Distinct trades sharing one decision are fine (same x, different y).
//  3. XSEC UNIT VIA FROZEN RISK-AT-OPEN. The CROSS_SECTIONAL_* lanes store `netReturn` as a FRACTION,
//     not R. y = cortexWinLabel(netReturn / obs.riskDistanceAtOpen) where riskDistanceAtOpen is FROZEN on
//     the obs at open — NEVER the live CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS at resolve (a deploy between
//     open and resolve would else silently rewrite the denominator of every open basket). A basket with
//     no frozen risk-at-open is INSUFFICIENT_DATA for that lane, not a raw-fraction fallback.
//  4. NO SILENT EXCLUSION — explicit per-lane status. Every roster lane gets a CortexLaneLearningStatus:
//     LEARNING_ACTIVE / NO_OUTCOME_SOURCE / INSUFFICIENT_DATA / SCHEMA_MISMATCH. A lane with no wired
//     outcome source (or all-mismatched schema) is NEVER quietly dropped while the roster is reported
//     "learning"; and the promotion gate tracks the CAPITAL COVERAGE (Σ static weight) of lanes lacking a
//     live outcome source, so a big-weight blind lane blocks promotion instead of hiding.
//  5. schemaVersion FROM THE JOURNAL ROW (top-level featureSchemaVersion), never the live constant; reader
//     is LINE-RESILIENT (per-line try/catch, skip+count bad lines) and reads BOTH .jsonl and .jsonl.1,
//     deduping decisions by (at,laneId). Rotation retains ~26 days vs the 60-day gate, so #218 extracts
//     examples CONTINUOUSLY as closes resolve — not one batch read at gate time (older rows rotate out).
//  Regime coverage for the gate = resolvedByFamily (labeled OUTCOMES per family), NOT decision ticks.
export interface CortexTrainingExample {
  x: number[]; // feature vector (length CORTEX_FEATURE_DIM)
  /**
   * 1 if the trade cleared the win hurdle. CONTRACT (the definitional decision of the whole system):
   * `y` MUST be derived from the lane's OWN counterfactual paper-resolved close — the allocation-
   * independent outcome each lane already measures every cycle — NEVER from netted / portfolio-capped
   * / guard-exited LIVE fills. Training on live-executed outcomes would teach the model to attribute
   * execution + portfolio-interference to lane signal quality, and would re-close the self-starvation
   * loop (a down-weighted lane gets no live data). Use cortexWinLabel(netR) to build it.
   */
  y: 0 | 1;
  tMs: number; // close time (for recency decay)
  /** Feature schema at capture time — refit rejects rows whose schema ≠ the current one. */
  schemaVersion: number;
}

/** Win label with the economic hurdle: a fee-scratch does not count as a win. */
export function cortexWinLabel(netR: number, hurdle = CORTEX_WIN_HURDLE_R): 0 | 1 {
  return Number.isFinite(netR) && netR > hurdle ? 1 : 0;
}

/** Solve A x = b for a small dense system by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) continue; // singular column — skip (ridge λ keeps H PD in practice)
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const pivVal = M[col]![col]!;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r]![col]! / pivVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const diag = M[i]![i]!;
    x[i] = Math.abs(diag) < 1e-12 ? 0 : M[i]![n]! / diag;
  }
  return x;
}

export type CortexRefitStatus =
  | "ACCEPTED"
  | "REJECTED_LOW_NEFF"
  | "REJECTED_NON_CONVERGENCE"
  | "REJECTED_COEFFICIENT_JUMP"
  | "REJECTED_NON_FINITE";

export interface CortexRefitResult {
  w: number[]; // on ANY rejection this is exactly wPrior (== the last healthy fit), so the caller can
  nEff: number; // write unconditionally and never corrupt the active model; status is for logging.
  status: CortexRefitStatus;
}

/**
 * Refit one archetype's logistic coefficients from its resolved closes. Recency-decayed (half-life
 * CORTEX_REFIT_HALF_LIFE_DAYS) and anchored to wPrior with λ = λ0·κ/(κ+N_eff) — so a thin, noisy
 * archetype stays close to the prior (graceful degradation) while a well-sampled one is trusted. This
 * IS "learn from mistakes": a losing context (y=0) drives down the coefficients that fire there.
 * Deterministic. NEVER overwrites a healthy model with a broken fit: any of {no usable data, non-
 * convergence, a coefficient jump > CORTEX_REFIT_MAX_JUMP (separation / blow-up), a non-finite fit}
 * returns wPrior verbatim with the reason in `status`. Rows whose schemaVersion ≠ current are dropped.
 */
export function refitArchetypeCoefficients(
  examples: CortexTrainingExample[],
  wPrior: number[],
  opts: { nowMs: number; halfLifeDays?: number; kappa?: number; lambda0?: number; iterations?: number; maxJump?: number },
): CortexRefitResult {
  const dim = wPrior.length;
  const halfLifeMs = (opts.halfLifeDays ?? CORTEX_REFIT_HALF_LIFE_DAYS) * 86_400_000;
  const kappa = opts.kappa ?? CORTEX_REFIT_KAPPA;
  const lambda0 = opts.lambda0 ?? CORTEX_REFIT_LAMBDA0;
  const iterations = opts.iterations ?? 12;
  const maxJump = opts.maxJump ?? CORTEX_REFIT_MAX_JUMP;

  const rows = examples.filter(
    (e) =>
      Array.isArray(e.x) &&
      e.x.length === dim &&
      e.x.every((v) => Number.isFinite(v)) &&
      (e.y === 0 || e.y === 1) &&
      e.schemaVersion === CORTEX_FEATURE_SCHEMA_VERSION,
  );
  const a = rows.map((e) => Math.pow(0.5, Math.max(0, opts.nowMs - e.tMs) / halfLifeMs));
  const nEff = a.reduce((s, v) => s + v, 0);
  if (rows.length === 0 || nEff <= 0) return { w: [...wPrior], nEff: 0, status: "REJECTED_LOW_NEFF" };
  const lambda = lambda0 * (kappa / (kappa + nEff));

  let w = [...wPrior];
  let converged = false;
  for (let iter = 0; iter < iterations; iter += 1) {
    // gradient g = Xᵀ(a∘(p−y)) + λ(w−wPrior); Hessian H = XᵀWX + λI, W=diag(a·p·(1−p)).
    const g = new Array(dim).fill(0);
    const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
    for (let i = 0; i < dim; i += 1) {
      g[i] = lambda * (w[i]! - wPrior[i]!);
      H[i]![i] += lambda;
    }
    for (let r = 0; r < rows.length; r += 1) {
      const x = rows[r]!.x;
      const p = sigmoid(dot(w, x));
      const wr = a[r]! * p * (1 - p);
      const resid = a[r]! * (p - rows[r]!.y);
      for (let i = 0; i < dim; i += 1) {
        g[i]! += resid * x[i]!;
        const wx = wr * x[i]!;
        for (let j = 0; j < dim; j += 1) H[i]![j]! += wx * x[j]!;
      }
    }
    const step = solveLinear(H, g);
    // 2026-07-20 real-money-adjacent audit fix: the raw Newton step was applied unconditionally.
    // H = XᵀWX + λI is positive definite (λ>0), so -H⁻¹g is a genuine descent direction for the
    // convex penalized log-likelihood below — but on a small, feature-degenerate sample the FULL
    // step can overshoot past where that local quadratic approximation is valid, and an undamped
    // Newton iteration can then lock into a stable, non-decaying oscillation between two points
    // instead of converging OR diverging monotonically (reproduced and confirmed on real TACTICAL
    // archetype data: 12, and even 200, undamped iterations settle into an exact 2-cycle). Standard
    // backtracking line search fixes this: repeatedly halve the step until it actually decreases the
    // objective. Since the direction is always a valid descent direction here, some small enough
    // scale is mathematically guaranteed to improve on it (or the step is already ~0, i.e. converged).
    const currentObjective = penalizedNegLogLik(w, rows, a, wPrior, lambda);
    let scale = 1;
    let maxStep = 0;
    let stepAccepted = false;
    for (let backtrack = 0; backtrack < 30; backtrack += 1) {
      const candidate = w.map((wi, i) => wi - scale * step[i]!);
      if (candidate.every((v) => Number.isFinite(v))) {
        const candidateObjective = penalizedNegLogLik(candidate, rows, a, wPrior, lambda);
        if (Number.isFinite(candidateObjective) && candidateObjective <= currentObjective) {
          for (let i = 0; i < dim; i += 1) maxStep = Math.max(maxStep, Math.abs(scale * step[i]!));
          w = candidate;
          stepAccepted = true;
          break;
        }
      }
      scale *= 0.5;
    }
    if (!stepAccepted) break; // no improving step found even after 30 halvings — non-convergent, not silently applied
    if (maxStep < 1e-8) {
      converged = true;
      break;
    }
  }
  if (!w.every((v) => Number.isFinite(v))) return { w: [...wPrior], nEff, status: "REJECTED_NON_FINITE" };
  if (!converged) return { w: [...wPrior], nEff, status: "REJECTED_NON_CONVERGENCE" };
  let maxJumpSeen = 0;
  for (let i = 0; i < dim; i += 1) maxJumpSeen = Math.max(maxJumpSeen, Math.abs(w[i]! - wPrior[i]!));
  if (maxJumpSeen > maxJump) return { w: [...wPrior], nEff, status: "REJECTED_COEFFICIENT_JUMP" };
  return { w, nEff, status: "ACCEPTED" };
}

// ── Invariants: the brain's output is only trusted if ALL hold (else kill-to-federated). ──────────
export interface CortexInvariantResult {
  ok: boolean;
  violations: string[];
}
export function checkCortexInvariants(decision: CortexDecision, laneCapPct = CORTEX_LANE_CAP_PCT): CortexInvariantResult {
  const violations: string[] = [];
  let sum = 0;
  for (const l of decision.lanes) {
    if (!Number.isFinite(l.finalPct)) violations.push(`${l.laneId}: NaN weight`);
    if (l.finalPct < -1e-9) violations.push(`${l.laneId}: negative weight ${l.finalPct}`);
    // The cap bounds the TILT, never below the static incumbent — effective per-lane cap is
    // max(static, laneCapPct) (matches decideCortex), so a legit 80% incumbent isn't a "violation".
    const effCap = Math.max(Math.max(0, l.staticPct), laneCapPct);
    if (l.finalPct > effCap + 1e-6) violations.push(`${l.laneId}: over cap ${l.finalPct.toFixed(2)} > ${effCap}`);
    if (!l.eligible && l.reason === "edge-memory / controller veto" && l.finalPct > 1e-9) {
      violations.push(`${l.laneId}: funded a vetoed lane (${l.finalPct.toFixed(2)}%)`);
    }
    sum += Math.max(0, l.finalPct);
  }
  if (sum > 100 + 1e-6) violations.push(`total weight ${sum.toFixed(2)}% > 100%`);
  if (!Number.isFinite(decision.grossG) || decision.grossG < 0 || decision.grossG > 1) {
    violations.push(`grossG out of range: ${decision.grossG}`);
  }
  return { ok: violations.length === 0, violations };
}

/** Map a lane id to its archetype (breadth-directional / market-neutral / tactical). */
export function cortexArchetypeForLane(laneId: string): CortexArchetype {
  const id = laneId.toUpperCase();
  if (id.includes("CROSS_SECTIONAL") || id.includes("XSEC") || id.includes("MARKET_NEUTRAL")) return "NEUTRAL";
  if (id.includes("SHORT_FADE") || id.includes("INTRADAY") || id.includes("PANIC") || id.includes("MOMENTUM")) {
    return "TACTICAL";
  }
  return "BREADTH"; // RC / RCS / CE / CG variants
}

// ── Wiring seam: mode gate, context assembly, journal record ──────────────────────────────────────

export type CortexBrainMode = "off" | "shadow" | "live";
/** off (default) = federated allocation unchanged; shadow = decide + journal, drive nothing; live =
 *  drive the allocation table (Phase 4+, gated separately). Anything unrecognized ⇒ off (safe). */
export function cortexBrainMode(env: NodeJS.ProcessEnv = process.env): CortexBrainMode {
  const v = (env.CENTRAL_BRAIN_MODE ?? "").trim().toLowerCase();
  return v === "shadow" ? "shadow" : v === "live" ? "live" : "off";
}

/** A per-lane observation gathered from the EXISTING per-lane paper measurement + edge-memory +
 *  static table (the impure gather happens at the call site; this stays pure/testable). */
export interface CortexLaneObservation {
  laneId: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  edgeMemAvgNetR: number | null;
  edgeMemN: number;
  laneNetAvgR: number | null;
  /** Resolved-close count behind laneNetAvgR — sample-gates the NEUTRAL-lane allocation magnitude. */
  laneNetAvgN: number;
  lanePf: number | null;
  crowdingAlign: number | null;
  kronosAgree: number | null;
  convictionScore: number | null;
  vetoed: boolean;
  staticWeightPct: number;
}

/** Assemble the decision context from already-gathered pieces. Centralizes archetype mapping; pure. */
export function assembleCortexContext(
  top: Omit<CortexContext, "lanes">,
  observations: CortexLaneObservation[],
): CortexContext {
  return {
    ...top,
    lanes: observations.map((o) => ({
      laneId: o.laneId,
      archetype: cortexArchetypeForLane(o.laneId),
      direction: o.direction,
      edgeMemAvgNetR: o.edgeMemAvgNetR,
      edgeMemN: o.edgeMemN,
      laneNetAvgR: o.laneNetAvgR,
      laneNetAvgN: o.laneNetAvgN,
      lanePf: o.lanePf,
      crowdingAlign: o.crowdingAlign,
      kronosAgree: o.kronosAgree,
      convictionScore: o.convictionScore,
      vetoed: o.vetoed,
      staticWeightPct: o.staticWeightPct,
    })),
  };
}

/** Build the append-only journal record for a shadow decision — the auditable trace of WHY, AND the
 *  training-data row. Each lane carries `x` (the exact feature vector) + the raw inputs it was built from,
 *  so #218 can attach the y-label (the lane's own counterfactual close after `at`) to a decision-time x —
 *  WITHOUT this, the shadow accumulates decisions whose features are unrecoverable ⇒ untrainable data. */
export function buildCortexDecisionRecord(args: {
  atIso: string;
  mode: CortexBrainMode;
  ctx: CortexContext;
  decision: CortexDecision;
  invariants: CortexInvariantResult;
  /** The SHADOW counterfactual decision at evaluationBeta (for #219 decision-alpha). Optional — when
   *  absent or equal to `decision`, evaluationBeta==0 and the eval allocation equals the incumbent. */
  evalDecision?: CortexDecision;
  evaluationBeta?: number;
}): Record<string, unknown> {
  // Raw per-lane inputs (the gather's output), keyed by laneId, so x is reconstructable + auditable even
  // if laneFeatureVector's mapping later changes (old rows stay valid under their featureSchemaVersion).
  const rawById = new Map(args.ctx.lanes.map((l) => [l.laneId, l]));
  const evalById = new Map((args.evalDecision ?? args.decision).lanes.map((l) => [l.laneId, l]));
  return {
    kind: "BRAIN_DECISION",
    at: args.atIso,
    mode: args.mode,
    featureSchemaVersion: args.decision.featureSchemaVersion,
    regimeFamily: args.ctx.regimeFamily,
    axisScore: args.ctx.axisScore,
    axisSlopePerHour: args.ctx.axisSlopePerHour,
    portfolioDrawdownPct: args.ctx.portfolioDrawdownPct,
    killBudgetUtilization: args.ctx.killBudgetUtilization,
    killLatched: args.ctx.killLatched,
    posture: args.decision.posture,
    directionStance: args.decision.directionStance,
    grossG: args.decision.grossG,
    // OPERATIONAL β = the live wall (0). The schedule-driven evaluationBeta is a SEPARATE field — journaled
    // so no reader can mistake the shadow counterfactual for an allocation that reached money. `beta` +
    // `expectedTiltDeltaR` are the incumbent (β=0 ⇒ 0 tilt); the eval channel carries the counterfactual.
    beta: args.decision.beta,
    liveBeta: args.decision.beta,
    evaluationBeta: args.evaluationBeta ?? args.decision.beta,
    expectedTiltDeltaR: args.decision.expectedTiltDeltaR,
    evalExpectedTiltDeltaR: (args.evalDecision ?? args.decision).expectedTiltDeltaR,
    invariantsOk: args.invariants.ok,
    invariantViolations: args.invariants.violations,
    rationale: args.decision.rationale,
    lanes: args.decision.lanes.map((l) => {
      const raw = rawById.get(l.laneId);
      return {
        laneId: l.laneId,
        archetype: l.archetype,
        eligible: l.eligible,
        pWin: Number(l.pWin.toFixed(4)),
        // Full magnitude audit trail (operator ask): pre-cap edge estimate → post-cap magnitude (+ cap flag)
        // → learned share → final share. Makes "is XSEC continuously hammering the 0.5 cap?" a one-glance check.
        edgeEstimatePreCap: Number(l.edgeEstimatePreCap.toFixed(4)),
        shrunkNetR: Number(l.shrunkNetR.toFixed(4)),
        allocationMagnitude: Number(l.allocationMagnitude.toFixed(4)),
        magnitudeCapped: l.magnitudeCapped,
        staticPct: Number(l.staticPct.toFixed(2)),
        learnedPct: Number(l.learnedPct.toFixed(2)),
        finalPct: Number(l.finalPct.toFixed(2)),
        // The SHADOW counterfactual allocation for this lane at evaluationBeta (== finalPct when β=0). The
        // per-lane (evalFinalPct − finalPct) IS the tilt #219 scores against realized R for decision-alpha.
        evalFinalPct: Number((evalById.get(l.laneId)?.finalPct ?? l.finalPct).toFixed(2)),
        sizingMult: Number(l.sizingMult.toFixed(3)),
        reason: l.reason,
        // ── TRAINING ROW (the reason weeks of shadow won't be wasted) ────────────────────────────────
        // `x` = the EXACT feature vector fed to the logistic; `raw` = the gather inputs it came from + the
        // lane direction. #218 pairs THIS x with the lane's own counterfactual close after `at` to form a
        // {x, y, tMs, schemaVersion} example. Anything the model consumed is captured, at decision time.
        x: l.featureVector.map((v) => Number(v.toFixed(6))),
        direction: raw?.direction ?? null,
        raw: raw
          ? {
              edgeMemAvgNetR: raw.edgeMemAvgNetR,
              edgeMemN: raw.edgeMemN,
              laneNetAvgR: raw.laneNetAvgR,
              laneNetAvgN: raw.laneNetAvgN,
              lanePf: raw.lanePf,
              crowdingAlign: raw.crowdingAlign,
              kronosAgree: raw.kronosAgree,
              convictionScore: raw.convictionScore,
              vetoed: raw.vetoed,
            }
          : null,
      };
    }),
  };
}

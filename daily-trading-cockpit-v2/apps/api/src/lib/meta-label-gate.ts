/**
 * META-LABEL PER-SIGNAL GATE (report-only shadow scorer, 2026-07-22).
 *
 * López-de-Prado-style meta-labeling: the existing lanes keep generating entry signals exactly as
 * they do today (the paper book IS the signal stream); a SECONDARY transparent classifier estimates,
 * PER INDIVIDUAL SIGNAL, p(win | features at signal time). This differs from CORTEX by one axis:
 * CORTEX weights LANES (capital allocation across ~13 lanes); this scores each SIGNAL — the question
 * it answers is "should THIS entry, from a lane we already fund, have been taken at all?".
 *
 * Pure shadow measurement:
 *  - Every new paper order is scored at (approximately) creation and the score + full feature
 *    snapshot + the model version used are persisted. NOTHING reads the score on any admission,
 *    resolution, allocation, or live path — the gate gates nothing.
 *  - When the order resolves, the record is labeled exactly once with {netR, win} from the paper
 *    resolver's own outcome.
 *  - The report then measures the COUNTERFACTUAL: for each τ in META_LABEL_TAUS, the cohort of
 *    labeled signals with score ≥ τ vs ALL labeled+scored signals — retention %, netAvgR, PF and
 *    the lift. That whole curve is the deliverable; only if it shows real, stable lift does a live
 *    gate ever become a conversation (house rule: prove edge in shadow first).
 *
 * WALK-FORWARD HONESTY (the non-negotiable): a signal is scored with the newest model whose
 * fittedAt <= the signal's creation time — never with a model that has seen the future. Scores are
 * frozen at first-score time (modelVersion persisted per record; refits NEVER retro-score), and a
 * signal created before any model existed scores null ("model not ready"), counted honestly.
 *
 * MISSING FEATURES ARE EXPLICIT NULLS, never fabricated. Scoring and training both use the same
 * effectiveFeatureVector transform: a null feature contributes nothing (skip) and the remaining
 * present features are renormalized (bounded upweight) so missingness shrinks information, not the
 * score's scale.
 *
 * Model: transparent logistic (inspectable weights per named feature), L2-shrunk toward zero, fit
 * by the same Newton–IRLS + backtracking pattern as CORTEX's refit (solveLinear reused from
 * cortex-brain.ts). Refit is periodic (default daily) with a min-examples gate.
 *
 * HOOK CHOICE: periodic sweep over the paper store (NOT call-site hooks). Paper orders are admitted
 * through at least three distinct paths (variant-matrix admission, the scan-candidate allocator,
 * the realtime short mirror) and resolved inside resolvePaperOrders' batched mutation loop —
 * hooking any of those risks touching admission/resolution logic for a report-only feature. The
 * sweep rides the same fire-and-forget shadow ticker as every sibling measurement lane, covers all
 * sources, and cannot affect the paper book (reads orders, writes only its own store).
 *
 * Store idiom: own bounded JSON store, atomic tmp+rename, exactly-once labeling (dedup by
 * paperOrderId) — same discipline as cortex-real-attribution.ts / funding-carry-edge.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { solveLinear } from "./cortex-brain.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function softplus(v: number): number {
  return v > 0 ? v + Math.log1p(Math.exp(-v)) : Math.log1p(Math.exp(v));
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── feature schema ──────────────────────────────────────────────────────────

/** Bump on ANY reorder/semantic change — same lesson as CORTEX_FEATURE_SCHEMA_VERSION: a silent
 *  reorder would redefine every persisted weight. Records carry their schema; the refit only trains
 *  on rows matching the current one. */
export const META_LABEL_FEATURE_SCHEMA_VERSION = 1;

/** Every non-bias feature is constructed to live in [-1, 1] with 0 = neutral/no-information, so a
 *  null (missing source) can be SKIPPED (contribute 0) without fabricating a value. */
export const META_LABEL_FEATURE_NAMES = [
  "bias", //           always 1
  "regimeAlign", //    direction sign × regime-family sign (bull +1 / bear −1 / mixed 0); null when regime missing
  "controllerConf", // controller graduated confidence mapped to [-0.7, 0.7]; null when unlabeled
  "crowdingAlign", //  derivatives-crowding alignment with a FRESH entry in this direction; null when unavailable
  "kronosAlign", //    Kronos bias agreement × its confidence (admission-time provenance); null when not captured
  "bookEdge", //       per-(lane,symbol) realized book netAvgR / 0.5, clamped; null below sample floor
  "atrCentered", //    (ATR% − 1.5)/1.5 clamped — volatility regime around a ~1.5% neutral point; null when uncached
  "hourSin", //        sin(2π·UTC-hour-of-day/24) at signal creation
  "hourCos", //        cos(2π·UTC-hour-of-day/24)
  "edgeMem", //        regime×direction edge-memory avgNetR / 0.3, clamped; null when n=0
  "laneHist", //       the lane's own rolling closed netAvgR / 0.3, clamped; null below sample floor
] as const;

export type MetaLabelFeatureName = (typeof META_LABEL_FEATURE_NAMES)[number];
export const META_LABEL_DIM = META_LABEL_FEATURE_NAMES.length;

/** A feature snapshot. Missing source ⇒ explicit null (never a fabricated neutral). */
export type MetaLabelFeatures = Record<MetaLabelFeatureName, number | null>;

// ── tunables ────────────────────────────────────────────────────────────────

export const META_LABEL_TAUS = [0.5, 0.55, 0.6, 0.65, 0.7] as const;
/** Labeled examples required before the FIRST fit; below this every score is null ("model not
 *  ready"), counted honestly — never a made-up 0.5. */
export const META_LABEL_MIN_EXAMPLES = envNum("META_LABEL_MIN_EXAMPLES", 100);
/** Refit cadence (default daily) — rides the shadow ticker, self-throttled by lastFit time. */
export const META_LABEL_REFIT_INTERVAL_MS = envNum("META_LABEL_REFIT_INTERVAL_MS", 24 * 3_600_000);
/** L2 shrinkage toward zero weights (transparent v1 — no recency decay, no priors beyond 0). */
export const META_LABEL_L2_LAMBDA = envNum("META_LABEL_L2_LAMBDA", 4);
/** Reject a refit whose max|w − wPrior| exceeds this. Same guard, same default, and the same reason
 *  as cortex-brain.ts's CORTEX_REFIT_MAX_JUMP: a blown-up or separated fit must never replace a
 *  healthy model. Without it (the state before 2026-07-26) each nightly refit was free to swing the
 *  model from predictive to anti-predictive and back, making any measured lift a function of which
 *  version happened to be active rather than of the signal. */
export const META_LABEL_REFIT_MAX_JUMP = envNum("META_LABEL_REFIT_MAX_JUMP", 8);
/** Bounded store: settled (labeled/voided) records kept, oldest dropped past this cap. */
export const META_LABEL_MAX_STORED_SETTLED = envNum("META_LABEL_MAX_STORED_SETTLED", 4_000);
/** An unlabeled record whose order can no longer resolve (paper orders expire at 7d) is pruned
 *  after this long — nothing waits forever. */
export const META_LABEL_UNLABELED_MAX_AGE_MS = envNum("META_LABEL_UNLABELED_MAX_AGE_MS", 14 * 86_400_000);
/** Per-cycle cap on NEW scores (each may cost one crowding fetch) — newest signals first. */
export const META_LABEL_MAX_NEW_SCORES_PER_CYCLE = envNum("META_LABEL_MAX_NEW_SCORES_PER_CYCLE", 40);
/** The sweep only claims "features at signal time" while the signal is younger than this — an
 *  order first seen older (e.g. pre-deploy backlog) is skipped, never scored with stale features. */
export const META_LABEL_SCORE_MAX_SIGNAL_AGE_MS = envNum("META_LABEL_SCORE_MAX_SIGNAL_AGE_MS", 30 * 60_000);
/** Model-version history retained so late-swept signals can still bind to the model that predated
 *  their creation (walk-forward selection needs more than just "current"). */
export const META_LABEL_MAX_MODEL_HISTORY = envNum("META_LABEL_MAX_MODEL_HISTORY", 8);
/** Missingness renormalization is bounded: present features are upweighted by at most this factor,
 *  so a nearly-all-null row can't have its one surviving feature amplified into a fake conviction. */
export const META_LABEL_MAX_RENORM = 3;
/** How far back the SCORE pass still bothers re-examining a signal it has never added to the store.
 *  A signal that is `!store.has(...)` and older than this can only be one of two things: it was
 *  ALREADY resolved into skippedAlreadyResolved/skippedTooOld on some earlier cycle (deep inside the
 *  age window below), or it has been deferredByCap every single cycle for this entire window running
 *  (needs a sustained >maxNewScores/cycle flood — a generous multiple of
 *  META_LABEL_SCORE_MAX_SIGNAL_AGE_MS absorbs any realistic pileup). Either way it is safe to stop
 *  touching it. Without this bound `orders` (the full lifetime paper-order history — HEADLINE orders
 *  are NEVER pruned by paper-execution-router.ts) re-produced the SAME permanently-dead backlog in
 *  `unseen` on every cycle forever, re-running map+sort over an ever-larger set (2026-07-22: 528,071
 *  skippedAlreadyResolved counted in just the first 40 cycles — the same ~13k dead orders re-counted
 *  repeatedly, not 528k distinct events). Same failure class as this repo's prior VM-resolver
 *  O(n)-per-poll and unrotated-journal-reread incidents. */
export const META_LABEL_SWEEP_LOOKBACK_MS = envNum("META_LABEL_SWEEP_LOOKBACK_MS", 6 * 3_600_000);

// ── feature transforms (pure) ───────────────────────────────────────────────

function dirSign(direction: "LONG" | "SHORT"): number {
  return direction === "LONG" ? 1 : -1;
}

/** Regime-family sign from the free-text regime label (same regexes as the paper store's axis
 *  stamping): bull ⇒ +1, bear ⇒ −1, mixed/rotation/neutral ⇒ 0. Null regime ⇒ null (missing). */
export function regimeAlignFeature(regime: string | null | undefined, direction: "LONG" | "SHORT"): number | null {
  if (regime == null || regime === "") return null;
  const label = regime.toLowerCase();
  let familySign = 0;
  if (/mixed|rotation|chop|range|sideways|neutral/.test(label)) familySign = 0;
  else if (/bull|long/.test(label)) familySign = 1;
  else if (/bear|short/.test(label)) familySign = -1;
  return clamp(dirSign(direction) * familySign, -1, 1);
}

/** Controller graduated confidence → centered scalar. Unknown/absent labels are NULL (missing),
 *  never silently neutral. */
export function controllerConfFeature(confidence: string | null | undefined): number | null {
  switch ((confidence ?? "").toUpperCase()) {
    case "HIGH":
      return 0.7;
    case "MEDIUM":
      return 0.2;
    case "LOW":
      return -0.3;
    case "DEGRADED":
      return -0.7;
    default:
      return null;
  }
}

/** Crowding alignment for a FRESH entry: joining an EXTREME same-side crowd is the exhausted-crowd
 *  condition (−1, matching isCrowdedAgainstFreshEntry); an elevated/extreme OPPOSITE crowd is a
 *  mild contrarian tailwind. Shape-typed so wiring passes any CrowdingSnapshot without an import
 *  cycle; tests drive fixtures. */
export function crowdingAlignFromSnapshot(
  snapshot: { crowdSide: "LONG" | "SHORT" | "NEUTRAL"; crowdingLevel: "NEUTRAL" | "ELEVATED" | "EXTREME" },
  direction: "LONG" | "SHORT",
): number | null {
  if (snapshot.crowdingLevel === "NEUTRAL" || snapshot.crowdSide === "NEUTRAL") return 0;
  const sameSide = snapshot.crowdSide === direction;
  if (snapshot.crowdingLevel === "EXTREME") return sameSide ? -1 : 0.5;
  return sameSide ? -0.5 : 0.25;
}

/** Kronos agreement × confidence, from the ADMISSION-TIME provenance already stamped on allocator
 *  orders (zero refetch, exactly at-signal-time). Null bias / "UNAVAILABLE" ⇒ null (missing —
 *  which is ~half the time and normal; the model must carry that honestly). */
export function kronosAlignFeature(
  kronosBias: string | null | undefined,
  kronosConfidence: number | null | undefined,
  direction: "LONG" | "SHORT",
): number | null {
  const bias = (kronosBias ?? "").toUpperCase();
  if (bias !== "LONG" && bias !== "SHORT" && bias !== "NEUTRAL") return null;
  const sign = bias === "NEUTRAL" ? 0 : bias === direction ? 1 : -1;
  const conf = finite(kronosConfidence) ? clamp(kronosConfidence, 0, 1) : 0.5;
  return sign * conf;
}

export function bookEdgeFeature(netAvgR: number | null | undefined): number | null {
  return finite(netAvgR) ? clamp(netAvgR / 0.5, -1, 1) : null;
}

/** ATR% centered on a ~1.5% neutral point (typical liquid-alt 5m ATR% scale in this repo's
 *  volatility cache) — below ⇒ quiet tape, above ⇒ hot tape. */
export function atrCenteredFeature(atrPct: number | null | undefined): number | null {
  return finite(atrPct) ? clamp((atrPct - 1.5) / 1.5, -1, 1) : null;
}

export function edgeMemFeature(stat: { avgNetR: number; n: number } | null | undefined): number | null {
  if (!stat || !(stat.n > 0) || !finite(stat.avgNetR)) return null;
  return clamp(stat.avgNetR / 0.3, -1, 1);
}

export function laneHistFeature(netAvgR: number | null | undefined): number | null {
  return finite(netAvgR) ? clamp(netAvgR / 0.3, -1, 1) : null;
}

export function hourFeatures(atIso: string): { hourSin: number | null; hourCos: number | null } {
  const ms = new Date(atIso).getTime();
  if (!Number.isFinite(ms)) return { hourSin: null, hourCos: null };
  const d = new Date(ms);
  const frac = (d.getUTCHours() + d.getUTCMinutes() / 60) / 24;
  return { hourSin: Math.sin(2 * Math.PI * frac), hourCos: Math.cos(2 * Math.PI * frac) };
}

// ── feature snapshot builder (DI accessors — the impure gather stays at the call site) ──────────

/** The subset of a paper order the gate reads. Structural — the real PaperOrder satisfies it. */
export interface MetaLabelOrderLike {
  paperOrderId: string;
  createdAt: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  regime: string | null;
  controllerConfidence?: string | null;
  selectedLaneId: string;
  paperStatus: string;
  netR: number | null;
  provenance?: { kronosBias: string | null; kronosConfidence: number | null } | null;
}

/** Feature sources the sweep injects. EVERY accessor may return null (source missing/stale) — the
 *  snapshot records the null; nothing is fabricated. crowdingAlign may be async (one bounded fetch
 *  per NEW signal, same client call the sibling lanes make per cycle). */
export interface MetaLabelFeatureSources {
  atrPct(symbol: string): number | null;
  edgeMem(regime: string | null, direction: "LONG" | "SHORT"): { avgNetR: number; n: number } | null;
  crowdingAlign(symbol: string, direction: "LONG" | "SHORT"): Promise<number | null> | number | null;
  bookEdgeNetAvgR(laneId: string, symbol: string): number | null;
  laneHistNetAvgR(laneId: string): number | null;
}

export async function buildMetaLabelFeatureSnapshot(
  order: MetaLabelOrderLike,
  sources: MetaLabelFeatureSources,
): Promise<MetaLabelFeatures> {
  const { hourSin, hourCos } = hourFeatures(order.createdAt);
  let crowding: number | null = null;
  try {
    crowding = await sources.crowdingAlign(order.symbol, order.direction);
  } catch {
    crowding = null; // degrade honestly — a failed fetch is a missing feature, never a thrown sweep
  }
  const safe = <T>(fn: () => T | null): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  return {
    bias: 1,
    regimeAlign: regimeAlignFeature(order.regime, order.direction),
    controllerConf: controllerConfFeature(order.controllerConfidence),
    crowdingAlign: finite(crowding) ? clamp(crowding, -1, 1) : null,
    kronosAlign: kronosAlignFeature(
      order.provenance?.kronosBias ?? null,
      order.provenance?.kronosConfidence ?? null,
      order.direction,
    ),
    bookEdge: bookEdgeFeature(safe(() => sources.bookEdgeNetAvgR(order.selectedLaneId, order.symbol))),
    atrCentered: atrCenteredFeature(safe(() => sources.atrPct(order.symbol))),
    hourSin,
    hourCos,
    edgeMem: edgeMemFeature(safe(() => sources.edgeMem(order.regime, order.direction))),
    laneHist: laneHistFeature(safe(() => sources.laneHistNetAvgR(order.selectedLaneId))),
  };
}

// ── null-aware effective vector (shared by scoring AND training — no train/serve skew) ──────────

/**
 * Dense vector from a nullable snapshot: null ⇒ 0 (skip — contributes nothing), and the PRESENT
 * non-bias features are renormalized by (nonBiasCount / presentCount), capped at META_LABEL_MAX_RENORM,
 * so missingness doesn't systematically shrink |z| toward 0.5-scores. All-null non-bias rows fall
 * back to bias-only (the model's base rate). Used identically at fit and score time.
 */
export function effectiveFeatureVector(features: MetaLabelFeatures): number[] {
  const x = new Array<number>(META_LABEL_DIM).fill(0);
  x[0] = 1;
  let present = 0;
  for (let i = 1; i < META_LABEL_DIM; i += 1) {
    if (finite(features[META_LABEL_FEATURE_NAMES[i]!])) present += 1;
  }
  if (present === 0) return x;
  const renorm = Math.min(META_LABEL_MAX_RENORM, (META_LABEL_DIM - 1) / present);
  for (let i = 1; i < META_LABEL_DIM; i += 1) {
    const v = features[META_LABEL_FEATURE_NAMES[i]!];
    if (finite(v)) x[i] = clamp(v, -1, 1) * renorm;
  }
  return x;
}

// ── model ───────────────────────────────────────────────────────────────────

export interface MetaLabelModelVersion {
  version: number; // 1, 2, … (0 is reserved for "no model")
  weights: number[]; // length META_LABEL_DIM, ordered by META_LABEL_FEATURE_NAMES
  featureSchemaVersion: number;
  fittedAtIso: string;
  fittedAtMs: number;
  nTrain: number;
}

/** WALK-FORWARD SELECTION: the newest model that existed BEFORE the signal was created. Null when
 *  no model predates the signal (score must be null — "model not ready", counted honestly). */
export function modelForSignal(
  models: readonly MetaLabelModelVersion[],
  signalCreatedAtMs: number,
): MetaLabelModelVersion | null {
  let best: MetaLabelModelVersion | null = null;
  for (const m of models) {
    if (m.featureSchemaVersion !== META_LABEL_FEATURE_SCHEMA_VERSION) continue;
    if (!(m.fittedAtMs <= signalCreatedAtMs)) continue;
    if (!best || m.fittedAtMs > best.fittedAtMs) best = m;
  }
  return best;
}

/** Newest model matching the CURRENT feature schema — a stale-schema model (e.g. left over after a
 *  featureSchemaVersion bump) must never be treated as "the current model" for refit-due checks or
 *  operator-facing reporting, same guard modelForSignal already applies for walk-forward scoring. */
export function currentSchemaModel(models: readonly MetaLabelModelVersion[]): MetaLabelModelVersion | null {
  let best: MetaLabelModelVersion | null = null;
  for (const m of models) {
    if (m.featureSchemaVersion !== META_LABEL_FEATURE_SCHEMA_VERSION) continue;
    if (!best || m.fittedAtMs > best.fittedAtMs) best = m;
  }
  return best;
}

export function scoreWithModel(model: MetaLabelModelVersion, features: MetaLabelFeatures): number {
  const x = effectiveFeatureVector(features);
  let z = 0;
  for (let i = 0; i < META_LABEL_DIM; i += 1) z += (model.weights[i] ?? 0) * x[i]!;
  return sigmoid(finite(z) ? z : 0);
}

export type MetaLabelFitStatus =
  | "ACCEPTED"
  | "REJECTED_MIN_EXAMPLES"
  | "REJECTED_NON_CONVERGENCE"
  | "REJECTED_NON_FINITE"
  /** The fit converged but moved further from the previous model than META_LABEL_REFIT_MAX_JUMP
   *  allows — a blown-up/separated fit. Mirrors CORTEX_REFIT_MAX_JUMP in cortex-brain.ts, which
   *  exists for exactly this failure. Added 2026-07-26 after measuring that successive nightly
   *  refits swung the model between predictive and ANTI-predictive (v3 cohort lift +0.085R at
   *  tau=0.70 vs v4 cohort -0.213R on its own walk-forward cohort) purely because each refit was an
   *  unanchored from-scratch fit with no continuity to the last healthy one. */
  | "REJECTED_COEFFICIENT_JUMP";

export interface MetaLabelFitResult {
  weights: number[]; // on rejection: all-zero (caller must NOT install it — check status)
  status: MetaLabelFitStatus;
  nTrain: number;
}

export interface MetaLabelTrainingExample {
  features: MetaLabelFeatures;
  y: 0 | 1;
}

function penalizedNegLogLik(
  w: readonly number[],
  X: number[][],
  ys: readonly (0 | 1)[],
  lambda: number,
  wPrior: readonly number[],
): number {
  let nll = 0;
  for (let r = 0; r < X.length; r += 1) {
    let z = 0;
    for (let i = 0; i < w.length; i += 1) z += w[i]! * X[r]![i]!;
    nll += ys[r] === 1 ? softplus(-z) : softplus(z);
  }
  // Shrink toward wPrior (the last healthy fit), NOT toward zero — this is what gives successive
  // refits continuity. wPrior is all-zero on the very first fit, so that case is byte-identical to
  // the previous shrink-to-zero behavior. MUST stay consistent with the gradient/Hessian below:
  // the backtracking line search compares this objective, so anchoring one and not the other would
  // make the search optimize a different function than the Newton step descends.
  let penalty = 0;
  for (let i = 1; i < w.length; i += 1) penalty += (w[i]! - wPrior[i]!) ** 2; // bias unpenalized
  return nll + 0.5 * lambda * penalty;
}

/**
 * Transparent L2-shrunk logistic fit via Newton–IRLS with backtracking line search — the same
 * damped-Newton pattern (and the same solveLinear) as CORTEX's refitArchetypeCoefficients, minus
 * the CORTEX-specific prior/decay/schema plumbing. Deterministic; never returns a non-finite or
 * non-converged fit as ACCEPTED (the caller keeps the previous model on any rejection).
 */
export function fitMetaLabelLogistic(
  examples: readonly MetaLabelTrainingExample[],
  opts: {
    lambda?: number;
    iterations?: number;
    minExamples?: number;
    /** The last healthy model's weights. The ridge shrinks toward THIS instead of toward zero, and
     *  the fit is warm-started from it, so consecutive refits stay continuous. Omitted/undefined
     *  (or wrong length) => all-zero => byte-identical to the pre-2026-07-26 behavior. */
    wPrior?: readonly number[];
  } = {},
): MetaLabelFitResult {
  const lambda = opts.lambda ?? META_LABEL_L2_LAMBDA;
  const iterations = opts.iterations ?? 25;
  const minExamples = opts.minExamples ?? META_LABEL_MIN_EXAMPLES;
  const dim = META_LABEL_DIM;
  const zero = () => new Array<number>(dim).fill(0);
  const wPrior: number[] =
    opts.wPrior && opts.wPrior.length === dim && opts.wPrior.every((v) => Number.isFinite(v))
      ? [...opts.wPrior]
      : zero();

  const usable = examples.filter((e) => e && (e.y === 0 || e.y === 1) && e.features && e.features.bias === 1);
  if (usable.length < minExamples) return { weights: zero(), status: "REJECTED_MIN_EXAMPLES", nTrain: usable.length };

  const X = usable.map((e) => effectiveFeatureVector(e.features));
  const ys = usable.map((e) => e.y);

  let w = [...wPrior]; // warm start from the last healthy fit (all-zero on the first ever fit)
  let converged = false;
  for (let iter = 0; iter < iterations; iter += 1) {
    const g = zero();
    const H = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
    for (let i = 1; i < dim; i += 1) {
      g[i] = lambda * (w[i]! - wPrior[i]!); // anchored ridge — matches penalizedNegLogLik above
      H[i]![i]! += lambda;
    }
    // Tiny ridge on the bias too — numerical PD-ness only, not shrinkage of the base rate.
    H[0]![0]! += 1e-6;
    for (let r = 0; r < X.length; r += 1) {
      const x = X[r]!;
      let z = 0;
      for (let i = 0; i < dim; i += 1) z += w[i]! * x[i]!;
      const p = sigmoid(z);
      const wr = p * (1 - p);
      const resid = p - ys[r]!;
      for (let i = 0; i < dim; i += 1) {
        g[i]! += resid * x[i]!;
        const wx = wr * x[i]!;
        for (let j = 0; j < dim; j += 1) H[i]![j]! += wx * x[j]!;
      }
    }
    const step = solveLinear(H, g);
    const currentObjective = penalizedNegLogLik(w, X, ys, lambda, wPrior);
    let scale = 1;
    let maxStep = 0;
    let stepAccepted = false;
    for (let backtrack = 0; backtrack < 30; backtrack += 1) {
      const candidate = w.map((wi, i) => wi - scale * step[i]!);
      if (candidate.every((v) => Number.isFinite(v))) {
        const candidateObjective = penalizedNegLogLik(candidate, X, ys, lambda, wPrior);
        if (Number.isFinite(candidateObjective) && candidateObjective <= currentObjective) {
          for (let i = 0; i < dim; i += 1) maxStep = Math.max(maxStep, Math.abs(scale * step[i]!));
          w = candidate;
          stepAccepted = true;
          break;
        }
      }
      scale *= 0.5;
    }
    if (!stepAccepted) break;
    if (maxStep < 1e-8) {
      converged = true;
      break;
    }
  }
  if (!w.every((v) => Number.isFinite(v))) return { weights: zero(), status: "REJECTED_NON_FINITE", nTrain: usable.length };
  if (!converged) return { weights: zero(), status: "REJECTED_NON_CONVERGENCE", nTrain: usable.length };
  let maxJump = 0;
  for (let i = 0; i < dim; i += 1) maxJump = Math.max(maxJump, Math.abs(w[i]! - wPrior[i]!));
  if (maxJump > META_LABEL_REFIT_MAX_JUMP) {
    return { weights: zero(), status: "REJECTED_COEFFICIENT_JUMP", nTrain: usable.length };
  }
  return { weights: w, status: "ACCEPTED", nTrain: usable.length };
}

// ── store ───────────────────────────────────────────────────────────────────

export interface MetaLabelRecord {
  signalId: string; // the paperOrderId — the exactly-once dedupe key
  atIso: string; // when the sweep scored it (≈ creation; bounded by META_LABEL_SCORE_MAX_SIGNAL_AGE_MS)
  signalCreatedAtIso: string; // the order's own createdAt (walk-forward anchor)
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  features: MetaLabelFeatures;
  featureSchemaVersion: number;
  /** Null ⇒ no model predated this signal ("model not ready") — honest, never imputed. FROZEN at
   *  first score: refits never rewrite it (walk-forward). */
  score: number | null;
  modelVersion: number | null;
  label?: { netR: number; win: boolean } | null;
  labeledAtIso?: string | null;
  /** Terminal without a usable netR (NO_FILL / CANCELED / REJECTED / DATA_FAILURE / netR-less
   *  expiry) — excluded from cohorts and training, counted honestly. */
  voided?: boolean;
}

export interface MetaLabelCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  scoredTotal: number;
  scoredModelNotReadyTotal: number;
  labeledTotal: number;
  voidedTotal: number;
  skippedAlreadyResolvedTotal: number;
  skippedTooOldTotal: number;
  deferredByCapTotal: number;
  prunedUnlabeledTotal: number;
  lastFitAtIso: string | null;
  lastFitStatus: MetaLabelFitStatus | null;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: MetaLabelCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  scoredTotal: 0,
  scoredModelNotReadyTotal: 0,
  labeledTotal: 0,
  voidedTotal: 0,
  skippedAlreadyResolvedTotal: 0,
  skippedTooOldTotal: 0,
  deferredByCapTotal: 0,
  prunedUnlabeledTotal: 0,
  lastFitAtIso: null,
  lastFitStatus: null,
  lastCycleError: null,
};

interface MetaLabelState {
  version: 1;
  records: MetaLabelRecord[];
  models: MetaLabelModelVersion[];
  cycleMeta: MetaLabelCycleMeta;
}

export class MetaLabelStore {
  private state: MetaLabelState = { version: 1, records: [], models: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  private readonly byId = new Map<string, MetaLabelRecord>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<MetaLabelState>;
        if (Array.isArray(parsed.records)) this.state.records = parsed.records as MetaLabelRecord[];
        if (Array.isArray(parsed.models)) this.state.models = parsed.models as MetaLabelModelVersion[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty (report-only store; never crash the app) */
      }
    }
    for (const r of this.state.records) this.byId.set(r.signalId, r);
  }

  get all(): readonly MetaLabelRecord[] {
    return this.state.records;
  }

  get models(): readonly MetaLabelModelVersion[] {
    return this.state.models;
  }

  get cycleMeta(): MetaLabelCycleMeta {
    return this.state.cycleMeta;
  }

  has(signalId: string): boolean {
    return this.byId.has(signalId);
  }

  get(signalId: string): MetaLabelRecord | undefined {
    return this.byId.get(signalId);
  }

  /** Exactly-once insert — a second add for the same paperOrderId is a no-op. */
  add(record: MetaLabelRecord): boolean {
    if (this.byId.has(record.signalId)) return false;
    this.state.records.push(record);
    this.byId.set(record.signalId, record);
    return true;
  }

  /** Exactly-once labeling: only an unlabeled, un-voided record accepts a label; the first label
   *  is FROZEN (a re-sweep of the same resolved order is a no-op). */
  label(signalId: string, netR: number, atIso: string): boolean {
    const r = this.byId.get(signalId);
    if (!r || r.voided || (r.label != null && r.labeledAtIso != null)) return false;
    if (!finite(netR)) return false;
    r.label = { netR, win: netR > 0 };
    r.labeledAtIso = atIso;
    return true;
  }

  void(signalId: string, atIso: string): boolean {
    const r = this.byId.get(signalId);
    if (!r || r.voided || r.label != null) return false;
    r.voided = true;
    r.labeledAtIso = atIso;
    return true;
  }

  /** Install an ACCEPTED fit as the next model version. History is bounded (oldest dropped) but
   *  scoring only ever needs models that predate live signals, so the newest few suffice. */
  addModel(model: Omit<MetaLabelModelVersion, "version">): MetaLabelModelVersion {
    const version = (this.state.models[this.state.models.length - 1]?.version ?? 0) + 1;
    const mv: MetaLabelModelVersion = { ...model, version };
    this.state.models.push(mv);
    if (this.state.models.length > META_LABEL_MAX_MODEL_HISTORY) {
      this.state.models = this.state.models.slice(this.state.models.length - META_LABEL_MAX_MODEL_HISTORY);
    }
    return mv;
  }

  recordCycle(patch: Partial<MetaLabelCycleMeta> & { lastCycleAt: string }, counts?: Partial<Record<
    | "scored"
    | "scoredModelNotReady"
    | "labeled"
    | "voided"
    | "skippedAlreadyResolved"
    | "skippedTooOld"
    | "deferredByCap"
    | "prunedUnlabeled",
    number
  >>): void {
    const m = this.state.cycleMeta;
    m.lastCycleAt = patch.lastCycleAt;
    m.cycles += 1;
    m.scoredTotal += counts?.scored ?? 0;
    m.scoredModelNotReadyTotal += counts?.scoredModelNotReady ?? 0;
    m.labeledTotal += counts?.labeled ?? 0;
    m.voidedTotal += counts?.voided ?? 0;
    m.skippedAlreadyResolvedTotal += counts?.skippedAlreadyResolved ?? 0;
    m.skippedTooOldTotal += counts?.skippedTooOld ?? 0;
    m.deferredByCapTotal += counts?.deferredByCap ?? 0;
    m.prunedUnlabeledTotal += counts?.prunedUnlabeled ?? 0;
    if (patch.lastFitAtIso !== undefined) m.lastFitAtIso = patch.lastFitAtIso;
    if (patch.lastFitStatus !== undefined) m.lastFitStatus = patch.lastFitStatus;
    m.lastCycleError = patch.lastCycleError ?? null;
  }

  /** Bounded retention: unlabeled records older than META_LABEL_UNLABELED_MAX_AGE_MS are dropped
   *  (their order can no longer resolve — paper orders expire at 7d); settled (labeled/voided)
   *  records are capped, oldest-created dropped first. Returns pruned-unlabeled count. */
  prune(nowMs: number): number {
    const createdMs = (r: MetaLabelRecord) => {
      const ms = new Date(r.signalCreatedAtIso).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const before = this.state.records.length;
    const pendingFresh = this.state.records.filter(
      (r) => r.label == null && !r.voided && nowMs - createdMs(r) <= META_LABEL_UNLABELED_MAX_AGE_MS,
    );
    const prunedUnlabeled =
      this.state.records.filter((r) => r.label == null && !r.voided).length - pendingFresh.length;
    const settled = this.state.records
      .filter((r) => r.label != null || r.voided)
      .sort((a, b) => createdMs(a) - createdMs(b));
    const keptSettled =
      settled.length > META_LABEL_MAX_STORED_SETTLED
        ? settled.slice(settled.length - META_LABEL_MAX_STORED_SETTLED)
        : settled;
    if (pendingFresh.length + keptSettled.length !== before) {
      this.state.records = [...pendingFresh, ...keptSettled];
      this.byId.clear();
      for (const r of this.state.records) this.byId.set(r.signalId, r);
    }
    return Math.max(0, prunedUnlabeled);
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file); // atomic on POSIX — no torn reads
    } catch {
      /* report-only storage failures must never affect the app */
    }
  }
}

let singleton: MetaLabelStore | null = null;
export function getMetaLabelStore(dataDir = "data"): MetaLabelStore {
  if (!singleton) singleton = new MetaLabelStore(resolve(dataDir, "meta-label-gate.json"));
  return singleton;
}

export function _resetMetaLabelStoreForTests(): void {
  singleton = null;
}

// ── sweep cycle ─────────────────────────────────────────────────────────────

/** Statuses under which an order can still resolve (safe to score as a live signal). */
const OPEN_STATUSES = new Set(["CREATED", "PAPER_SUBMITTED", "PAPER_FILLED", "PAPER_PARTIAL"]);

function isTerminalStatus(paperStatus: string): boolean {
  return !OPEN_STATUSES.has(paperStatus);
}

export interface MetaLabelCycleResult {
  scored: number;
  scoredModelNotReady: number;
  labeled: number;
  voided: number;
  skippedAlreadyResolved: number;
  skippedTooOld: number;
  deferredByCap: number;
  prunedUnlabeled: number;
  fit: { ran: boolean; status: MetaLabelFitStatus | null };
}

/**
 * One sweep: (1) label newly-resolved signals exactly once, (2) score new signals with the model
 * that predated each signal's creation, (3) periodic min-examples-gated refit, (4) prune + save.
 * Refit runs AFTER scoring and stamps fittedAt = now, so a model can never score a signal created
 * before the model existed — walk-forward by construction from both directions.
 */
export async function runMetaLabelCycle(opts: {
  store: MetaLabelStore;
  orders: readonly MetaLabelOrderLike[];
  sources: MetaLabelFeatureSources;
  now: number;
  minExamples?: number;
  refitIntervalMs?: number;
  maxNewScores?: number;
  maxSignalAgeMs?: number;
  sweepLookbackMs?: number;
}): Promise<MetaLabelCycleResult> {
  const { store, orders, sources } = opts;
  const nowIso = new Date(opts.now).toISOString();
  const minExamples = opts.minExamples ?? META_LABEL_MIN_EXAMPLES;
  const refitIntervalMs = opts.refitIntervalMs ?? META_LABEL_REFIT_INTERVAL_MS;
  const maxNewScores = opts.maxNewScores ?? META_LABEL_MAX_NEW_SCORES_PER_CYCLE;
  const maxSignalAgeMs = opts.maxSignalAgeMs ?? META_LABEL_SCORE_MAX_SIGNAL_AGE_MS;
  const result: MetaLabelCycleResult = {
    scored: 0,
    scoredModelNotReady: 0,
    labeled: 0,
    voided: 0,
    skippedAlreadyResolved: 0,
    skippedTooOld: 0,
    deferredByCap: 0,
    prunedUnlabeled: 0,
    fit: { ran: false, status: null },
  };

  // Only the records still awaiting a label/void need an order looked up — bounded by the store's
  // own settled-cap (META_LABEL_MAX_STORED_SETTLED), not by the full lifetime paper-order history.
  // `orders` itself carries no index (PaperExecutionRouterStore.all is a flat, NEVER-pruned-for-
  // HEADLINE array — see META_LABEL_SWEEP_LOOKBACK_MS's doc comment), so a full touch is
  // unavoidable, but building the lookup Map only for IDs we will actually use (instead of one
  // entry per lifetime order) keeps the per-cycle allocation bounded by pendingLabel count, not by
  // total order-history size — same "don't do unbounded work every cycle" fix as the SCORE pass.
  const pendingSignalIds = new Set(
    store.all.filter((r) => r.label == null && !r.voided).map((r) => r.signalId),
  );
  const orderById = new Map<string, MetaLabelOrderLike>();
  for (const o of orders) {
    if (pendingSignalIds.has(o.paperOrderId)) orderById.set(o.paperOrderId, o);
  }

  // 1. LABEL pass — exactly-once via the store's frozen-first-label contract.
  for (const record of store.all) {
    if (record.label != null || record.voided) continue;
    const order = orderById.get(record.signalId);
    if (!order || !isTerminalStatus(order.paperStatus)) continue;
    if (finite(order.netR)) {
      if (store.label(record.signalId, order.netR, nowIso)) result.labeled += 1;
    } else if (store.void(record.signalId, nowIso)) {
      result.voided += 1;
    }
  }

  // 2. SCORE pass — newest first so fresh signals never starve behind a backlog; per-cycle cap
  //    bounds the crowding fetches. Signals first seen already-terminal or older than the honesty
  //    window are counted, never scored (their "at signal time" features are unrecoverable).
  //    The sweepLookbackMs bound (below) keeps this pass from re-touching a permanently-dead
  //    backlog forever — see META_LABEL_SWEEP_LOOKBACK_MS's doc comment.
  const createdMsOf = (o: MetaLabelOrderLike) => {
    const ms = new Date(o.createdAt).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  const sweepLookbackMs = opts.sweepLookbackMs ?? META_LABEL_SWEEP_LOOKBACK_MS;
  const sweepDeadlineMs = opts.now - sweepLookbackMs;
  const unseen = orders
    .filter((o) => !store.has(o.paperOrderId))
    .map((o) => ({ o, createdMs: createdMsOf(o) }))
    .filter(
      (e): e is { o: MetaLabelOrderLike; createdMs: number } =>
        e.createdMs !== null && e.createdMs >= sweepDeadlineMs,
    )
    .sort((a, b) => b.createdMs - a.createdMs);
  let newScores = 0;
  for (const { o, createdMs } of unseen) {
    if (isTerminalStatus(o.paperStatus)) {
      result.skippedAlreadyResolved += 1;
      continue;
    }
    if (opts.now - createdMs > maxSignalAgeMs) {
      result.skippedTooOld += 1;
      continue;
    }
    if (newScores >= maxNewScores) {
      result.deferredByCap += 1; // still open + young — next cycle picks it up
      continue;
    }
    const features = await buildMetaLabelFeatureSnapshot(o, sources);
    const model = modelForSignal(store.models, createdMs);
    const score = model ? scoreWithModel(model, features) : null;
    const added = store.add({
      signalId: o.paperOrderId,
      atIso: nowIso,
      signalCreatedAtIso: o.createdAt,
      laneId: o.selectedLaneId,
      symbol: o.symbol,
      direction: o.direction,
      features,
      featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
      score,
      modelVersion: model?.version ?? null,
      label: null,
      labeledAtIso: null,
    });
    if (added) {
      newScores += 1;
      result.scored += 1;
      if (score === null) result.scoredModelNotReady += 1;
    }
  }

  // 3. REFIT pass (after scoring — fittedAt = now can never claim a signal created earlier).
  const lastModel = currentSchemaModel(store.models);
  const labeledExamples: MetaLabelTrainingExample[] = store.all
    .filter((r) => r.label != null && !r.voided && r.featureSchemaVersion === META_LABEL_FEATURE_SCHEMA_VERSION)
    .map((r) => ({ features: r.features, y: (r.label!.win ? 1 : 0) as 0 | 1 }));
  const refitDue = !lastModel || opts.now - lastModel.fittedAtMs >= refitIntervalMs;
  if (refitDue && labeledExamples.length >= minExamples) {
    result.fit.ran = true;
    // Anchor to the last healthy model so successive refits stay continuous (and so a blown-up fit
    // is rejected rather than installed). lastModel is null on the very first fit => unanchored,
    // exactly as before.
    const fit = fitMetaLabelLogistic(labeledExamples, { minExamples, wPrior: lastModel?.weights });
    result.fit.status = fit.status;
    if (fit.status === "ACCEPTED") {
      store.addModel({
        weights: fit.weights,
        featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
        fittedAtIso: nowIso,
        fittedAtMs: opts.now,
        nTrain: fit.nTrain,
      });
    }
  }

  // 4. prune + persist + liveness.
  result.prunedUnlabeled = store.prune(opts.now);
  store.recordCycle(
    {
      lastCycleAt: nowIso,
      ...(result.fit.ran ? { lastFitAtIso: nowIso, lastFitStatus: result.fit.status } : {}),
    },
    {
      scored: result.scored,
      scoredModelNotReady: result.scoredModelNotReady,
      labeled: result.labeled,
      voided: result.voided,
      skippedAlreadyResolved: result.skippedAlreadyResolved,
      skippedTooOld: result.skippedTooOld,
      deferredByCap: result.deferredByCap,
      prunedUnlabeled: result.prunedUnlabeled,
    },
  );
  store.save();
  return result;
}

/** 2026-07-21 review fix: single-flight — a burst of new signals (up to 40 crowding fetches) can
 *  stretch a cycle past the 7-min ticker period; two interleaved cycles could double-score the same
 *  signals against the same store. Same guard idiom as runExitBrainShadowCycleGuarded. */
let mlCycleInFlight = false;
export async function runMetaLabelCycleGuarded(
  opts: Parameters<typeof runMetaLabelCycle>[0],
): Promise<MetaLabelCycleResult | null> {
  if (mlCycleInFlight) return null;
  mlCycleInFlight = true;
  try {
    return await runMetaLabelCycle(opts);
  } catch (error) {
    // Record the failure so the report shows "cycle ran and ERRORED" instead of silently looking
    // identical to "no new signals" — best-effort, never rethrows (fail-open like every sibling).
    try {
      opts.store.recordCycle({
        lastCycleAt: new Date(opts.now).toISOString(),
        lastCycleError: (error as Error).message ?? "unknown cycle error",
      });
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    mlCycleInFlight = false;
  }
}

// ── cohort report (the deliverable: what gating WOULD have done) ────────────

export interface MetaLabelCohortRow {
  tau: number;
  n: number; // labeled + scored population the row is computed over
  retained: number;
  retainedPct: number | null;
  gatedNetAvgR: number | null;
  ungatedNetAvgR: number | null;
  /** gatedNetAvgR − ungatedNetAvgR (per-trade R improvement the gate WOULD have bought). */
  lift: number | null;
  gatedPF: number | null;
  ungatedPF: number | null;
  gatedWr: number | null;
  ungatedWr: number | null;
}

function pf(nets: readonly number[]): number | null {
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  // Same sentinel convention as the sibling reports: no losses + some wins ⇒ 999, nothing ⇒ null.
  return grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null;
}

function wr(nets: readonly number[]): number | null {
  return nets.length ? nets.filter((r) => r > 0).length / nets.length : null;
}

/**
 * The counterfactual table. Population = labeled, non-voided records WITH a score (the only ones a
 * gate could ever have acted on — labeled-but-unscored records are reported separately, never
 * silently folded in). Same population for gated AND ungated, so the lift is apples-to-apples.
 */
export function buildMetaLabelCohortTable(
  records: readonly MetaLabelRecord[],
  taus: readonly number[] = META_LABEL_TAUS,
  opts: {
    /** When set, restrict the population to signals whose score was FROZEN by this model version.
     *  Scores are walk-forward: each record keeps the modelVersion that scored it and is never
     *  retro-scored. Pooling versions therefore measures a mixture of different models, not the one
     *  in use — and the mixture can invert the sign of the answer. Measured 2026-07-26 on testnet:
     *  pooled lift at tau=0.70 read +0.0118R, while the SAME data split by cohort was +0.0853R for
     *  v3 and -0.2125R for v4 (the then-current model). The pooled figure described neither. */
    modelVersion?: number | null;
  } = {},
): MetaLabelCohortRow[] {
  const population = records.filter(
    (r) =>
      r.label != null &&
      !r.voided &&
      finite(r.score) &&
      (opts.modelVersion == null || r.modelVersion === opts.modelVersion),
  );
  const allNets = population.map((r) => r.label!.netR);
  const ungatedNetAvgR = mean(allNets);
  const ungatedPF = pf(allNets);
  const ungatedWr = wr(allNets);
  return taus.map((tau) => {
    const retainedRecords = population.filter((r) => (r.score as number) >= tau);
    const nets = retainedRecords.map((r) => r.label!.netR);
    const gatedNetAvgR = mean(nets);
    return {
      tau,
      n: population.length,
      retained: retainedRecords.length,
      retainedPct: population.length ? (100 * retainedRecords.length) / population.length : null,
      gatedNetAvgR,
      ungatedNetAvgR,
      lift: gatedNetAvgR !== null && ungatedNetAvgR !== null ? gatedNetAvgR - ungatedNetAvgR : null,
      gatedPF: pf(nets),
      ungatedPF,
      gatedWr: wr(nets),
      ungatedWr,
    };
  });
}

export interface MetaLabelReport {
  reportOnly: true;
  featureSchemaVersion: number;
  model: {
    ready: boolean;
    version: number | null;
    fittedAtIso: string | null;
    nTrain: number | null;
    minExamples: number;
    /** Transparent inspection: every weight named. */
    weights: Array<{ feature: MetaLabelFeatureName; weight: number }> | null;
    historyVersions: number[];
    lastFitStatus: MetaLabelFitStatus | null;
    lastFitAtIso: string | null;
  };
  counts: {
    records: number;
    pendingLabel: number;
    labeled: number;
    voided: number;
    scored: number;
    scoredModelNotReady: number;
    labeledAndScored: number;
  };
  /** Per-feature % non-null across all records — the honest "which features actually exist" read. */
  featureCoverage: Array<{ feature: MetaLabelFeatureName; presentPct: number | null }>;
  /** POOLED across every model version — a mixture, retained for history. Do NOT read this as an
   *  evaluation of the current model; see cohortsCurrentModel. */
  cohorts: MetaLabelCohortRow[];
  /** Same table restricted to signals scored BY the current model — the walk-forward-honest view.
   *  Empty when no model is ready. */
  cohortsCurrentModel: MetaLabelCohortRow[];
  currentModelVersion: number | null;
  cycleMeta: MetaLabelCycleMeta;
}

export function buildMetaLabelReport(store: MetaLabelStore): MetaLabelReport {
  const records = store.all;
  const current = currentSchemaModel(store.models);
  const labeled = records.filter((r) => r.label != null && !r.voided);
  const scored = records.filter((r) => finite(r.score));
  const featureCoverage = META_LABEL_FEATURE_NAMES.map((feature) => ({
    feature,
    presentPct: records.length
      ? (100 * records.filter((r) => finite(r.features?.[feature])).length) / records.length
      : null,
  }));
  return {
    reportOnly: true,
    featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
    model: {
      ready: current !== null,
      version: current?.version ?? null,
      fittedAtIso: current?.fittedAtIso ?? null,
      nTrain: current?.nTrain ?? null,
      minExamples: META_LABEL_MIN_EXAMPLES,
      weights: current
        ? META_LABEL_FEATURE_NAMES.map((feature, i) => ({ feature, weight: current.weights[i] ?? 0 }))
        : null,
      historyVersions: store.models.map((m) => m.version),
      lastFitStatus: store.cycleMeta.lastFitStatus,
      lastFitAtIso: store.cycleMeta.lastFitAtIso,
    },
    counts: {
      records: records.length,
      pendingLabel: records.filter((r) => r.label == null && !r.voided).length,
      labeled: labeled.length,
      voided: records.filter((r) => r.voided === true).length,
      scored: scored.length,
      scoredModelNotReady: records.filter((r) => r.score === null).length,
      labeledAndScored: labeled.filter((r) => finite(r.score)).length,
    },
    featureCoverage,
    cohorts: buildMetaLabelCohortTable(records),
    // The honest evaluation of the model actually in use: only signals whose score that model
    // froze. `cohorts` above pools every model version and therefore describes a mixture, not the
    // current model — keep both so the pooled history stays inspectable, but this is the one an
    // operator should read when asking "does the gate I have work?".
    cohortsCurrentModel: current
      ? buildMetaLabelCohortTable(records, META_LABEL_TAUS, { modelVersion: current.version })
      : [],
    currentModelVersion: current?.version ?? null,
    cycleMeta: store.cycleMeta,
  };
}

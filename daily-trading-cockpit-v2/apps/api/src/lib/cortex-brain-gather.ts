/**
 * CORTEX gather (2026-07-12) — turns raw per-lane report/edge/crowding/controller values into a
 * CortexLaneObservation, per the operator-signed semantic contract. Every feature also emits a STATUS
 * ({FRESH, MISSING, STALE}) so a null is recorded as genuinely-absent, NEVER disguised as a valid 0/1
 * observation (the feature vector neutral-fills nulls; the debug record keeps the raw + status).
 *
 * The contract functions here are PURE + testable. The impure fetch (calling the real report builders /
 * edge-memory / crowding / controller / engine) is wired separately at the call site.
 *
 * OPERATOR CONTRACT (locked 2026-07-12):
 *  1. XSEC laneNetAvgR = netAvgReturn / basketStopDistance (source-of-truth 30bps=0.003, NOT ÷0.2);
 *     n===0 or non-finite or stop≤0 → null. Raw numerator+denominator kept for audit.
 *  2. crowdingAlign is DIRECTION-RELATIVE + contrarian-leaning: aligned-with-crowd = −0.5, opposing = +0.25,
 *     balanced = 0, NEUTRAL lane = null. Conservative ordinal; true magnitude shadow-measured.
 *  3. conviction: directional lanes only — matching-direction = actual conviction, opposite = 1−conviction,
 *     NEUTRAL / BOTH / MIXED / UNKNOWN = 0.5. (Valid because our convictionScore is DIRECTIONAL, not
 *     generic market confidence.)
 *  Extras: CG n=0→null; NEUTRAL edge-memory→null (no synth); CG_MFE_GIVEBACK→null unless lane/both slice;
 *  PF unavailable→null (NOT 1); every null recorded status=MISSING.
 */

import { CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS } from "./cross-sectional-edge.js";
import type { CortexLaneObservation } from "./cortex-brain.js";

/** Source-of-truth XSEC per-basket stop distance (fractional). */
export const CORTEX_XSEC_STOP_RETURN = CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS / 10_000;
/** Crowding ordinal (conservative; shadow-measured). */
export const CORTEX_CROWD_ALIGNED = -0.5; // our direction == the crowded side → contrarian warning
export const CORTEX_CROWD_OPPOSING = 0.25; // we oppose the crowd → mild contrarian tailwind
export const CORTEX_CROWD_BALANCED = 0;

export type CortexFeatureStatus = "FRESH" | "MISSING" | "STALE";
export type CrowdSide = "LONG" | "SHORT" | "NEUTRAL";
export type ControllerBias = "LONG" | "SHORT" | "BOTH" | "MIXED" | "UNKNOWN" | "NONE";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Contract feature functions (pure; each returns {value, status, ...debug}) ─────────────────────

/** #1 XSEC basket return (fractional %) → R. n===0 / non-finite / stop≤0 → null. */
export function xsecReturnToR(
  netAvgReturn: number | null,
  stopDistance: number,
  n: number,
): { value: number | null; status: CortexFeatureStatus; numerator: number | null; denominator: number } {
  if (n === 0 || !finite(netAvgReturn) || !finite(stopDistance) || stopDistance <= 0) {
    return { value: null, status: "MISSING", numerator: finite(netAvgReturn) ? netAvgReturn : null, denominator: stopDistance };
  }
  return { value: netAvgReturn / stopDistance, status: "FRESH", numerator: netAvgReturn, denominator: stopDistance };
}

/** 2026-07-22 bug-hunt fix: STALE was declared in CortexFeatureStatus but no function ever computed
 *  it — a frozen upstream lane report (this codebase has a documented real precedent: a resolver
 *  silently frozen for 18 days) looked FRESH forever. 6h is generous vs the shadow tick's own ~7min
 *  cadence, and tight enough to catch a genuinely-frozen lane long before it reaches that incident's
 *  scale. Optional on purpose: several lane stores don't track a cycle timestamp at all (see
 *  liveLaneReport/liveXsecReport in cortex-live-gather-bindings.ts) — absence must mean "cannot
 *  judge staleness", never "assume stale" or "assume fresh". */
export const CORTEX_LANE_STALE_MAX_AGE_MS = 6 * 3_600_000;

export interface CortexLaneCycleStaleness {
  lastCycleAt: string | null | undefined;
  nowMs: number;
}

function isLaneCycleStale(staleness?: CortexLaneCycleStaleness): boolean {
  if (!staleness || !staleness.lastCycleAt) return false;
  const lastMs = Date.parse(staleness.lastCycleAt);
  if (!Number.isFinite(lastMs)) return false;
  return staleness.nowMs - lastMs > CORTEX_LANE_STALE_MAX_AGE_MS;
}

/** A directional lane's own report netAvgR, guarding the CG/VM `0-at-n=0` fabrication → null.
 *  `staleness` is optional (omit when the source store tracks no cycle timestamp at all). */
export function laneNetAvgRGuarded(
  netAvgR: number | null,
  n: number,
  staleness?: CortexLaneCycleStaleness,
): { value: number | null; status: CortexFeatureStatus } {
  if (n === 0 || !finite(netAvgR)) return { value: null, status: "MISSING" };
  return { value: netAvgR, status: isLaneCycleStale(staleness) ? "STALE" : "FRESH" };
}

/** The report builders' "all wins, zero losses" sentinel (grossLoss==0 && grossWin>0 → 999). It is NOT a
 *  real profit factor (there is no denominator) — treat it as PF-unavailable so it neutral-fills, rather
 *  than saturating the lanePf feature at its cap (x[6]=clamp(999−1)=2) off a thin lucky all-win lane. */
export const CORTEX_PF_ALLWINS_SENTINEL = 999;
/** PF: unavailable / no report / no-losses-null / all-wins-sentinel → null, NOT 1 (feature neutral-fills to 1). */
export function lanePfGuarded(
  pf: number | null,
  hasReport: boolean,
  staleness?: CortexLaneCycleStaleness,
): { value: number | null; status: CortexFeatureStatus } {
  if (!hasReport || !finite(pf) || pf === CORTEX_PF_ALLWINS_SENTINEL) return { value: null, status: "MISSING" };
  return { value: pf, status: isLaneCycleStale(staleness) ? "STALE" : "FRESH" };
}

/**
 * #2 crowdingAlign — direction-relative, per-symbol ordinal, mean over the lane's OPEN-position symbols
 * (fixed-universe lanes pass their universe). NEUTRAL lane → null. Empty / no funding → null (MISSING).
 */
export function crowdingAlignForLane(
  perSymbolCrowdSides: readonly CrowdSide[],
  laneDirection: CortexLaneObservation["direction"],
): { value: number | null; status: CortexFeatureStatus } {
  if (laneDirection === "NEUTRAL") return { value: null, status: "MISSING" };
  const usable = perSymbolCrowdSides.filter((s) => s === "LONG" || s === "SHORT" || s === "NEUTRAL");
  if (usable.length === 0) return { value: null, status: "MISSING" };
  const opposite = laneDirection === "LONG" ? "SHORT" : "LONG";
  let sum = 0;
  for (const side of usable) {
    sum += side === laneDirection ? CORTEX_CROWD_ALIGNED : side === opposite ? CORTEX_CROWD_OPPOSING : CORTEX_CROWD_BALANCED;
  }
  return { value: clamp(sum / usable.length, -1, 1), status: "FRESH" };
}

/**
 * #3 conviction — directional lanes only. matching dir = actual conviction; opposite = 1−conviction;
 * NEUTRAL / non-directional controller = 0.5. `conviction` MUST be the DIRECTIONAL convictionScore
 * (0..1), not the MEDIUM-floored confidence.
 */
export function convictionForLane(
  controllerBias: ControllerBias,
  conviction: number | null,
  laneDirection: CortexLaneObservation["direction"],
): number {
  const c = finite(conviction) ? clamp(conviction, 0, 1) : 0.5;
  if (laneDirection === "NEUTRAL") return 0.5;
  if (controllerBias === "LONG") return laneDirection === "LONG" ? c : 1 - c;
  if (controllerBias === "SHORT") return laneDirection === "SHORT" ? c : 1 - c;
  return 0.5; // BOTH / MIXED / UNKNOWN / NONE
}

/**
 * Two DISTINCT drawdown signals (operator-locked 2026-07-12 — do NOT conflate them):
 *  1. portfolioDrawdownFraction = (equityPeak − currentEquity) / equityPeak — the true peak-equity
 *     drawdown fraction. A CONTEXT / telemetry / model feature; it does NOT drive gross (never
 *     normalized against an arbitrary DD_MAX).
 *  2. killBudgetUtilization = currentDrawdownUsd / killBudgetUsd — how much of the actual kill budget is
 *     spent. THIS drives the deterministic deleverage schedule (grossFromKillUtil): bands 0–0.4 no tilt,
 *     0.4–0.7 gradual, 0.7–1.0 aggressive, ≥1.0 the engine kill rail takes over.
 */
export function portfolioDrawdownFraction(equityPeak: number | null, currentEquity: number | null): number {
  if (!finite(equityPeak) || !finite(currentEquity) || equityPeak <= 0) return 0;
  return clamp((equityPeak - currentEquity) / equityPeak, 0, 1);
}
export function killBudgetUtilization(currentDrawdownUsd: number | null, killBudgetUsd: number | null): number {
  if (!finite(currentDrawdownUsd) || !finite(killBudgetUsd) || killBudgetUsd <= 0) return 0;
  return Math.max(0, currentDrawdownUsd / killBudgetUsd); // NOT clamped to 1 — ≥1 signals the kill rail band
}

// ── Lane-observation assembly ──────────────────────────────────────────────────────────────────

/** Raw, already-fetched inputs for one lane (the impure fetch produces these). */
export interface CortexLaneRaw {
  laneId: string;
  direction: CortexLaneObservation["direction"];
  /** edge-memory verdict stat for this lane's direction; null for NEUTRAL / no-slice. */
  edgeMemAvgNetR: number | null;
  edgeMemN: number;
  vetoed: boolean;
  /** the lane's OWN report; for XSEC pass isXsec=true + netAvgReturnFraction (per-basket %). */
  reportNetAvgR: number | null; // R for non-XSEC lanes; ignored for XSEC (use xsecNetAvgReturn)
  reportPf: number | null;
  /** 2026-07-22 bug-hunt fix: the source store's own cycleMeta.lastCycleAt, when it tracks one —
   *  undefined/null for stores that don't (see liveLaneReport's doc comment). Feeds STALE detection
   *  in laneNetAvgRGuarded/lanePfGuarded; absence never implies fresh OR stale. */
  lastCycleAt?: string | null;
  /** Wall-clock "now" for this gather (pure function — never reads Date.now() itself). */
  nowMs: number;
  reportN: number;
  hasReport: boolean;
  isXsec: boolean;
  xsecNetAvgReturn: number | null; // fractional per-basket return (XSEC only)
  xsecStopDistance: number; // fractional (source of truth)
  /** crowd side per symbol over the lane's open positions / universe. */
  crowdSides: readonly CrowdSide[];
  kronosAgree: number | null; // signed −1..+1, CE only; else null
  controllerBias: ControllerBias;
  controllerConviction: number | null; // directional convictionScore 0..1
  staticWeightPct: number;
}

export interface CortexLaneFeatureDebug {
  edgeMem: CortexFeatureStatus;
  laneNetAvgR: CortexFeatureStatus;
  lanePf: CortexFeatureStatus;
  crowdingAlign: CortexFeatureStatus;
  kronosAgree: CortexFeatureStatus;
  xsecRawNumerator?: number | null;
  xsecRawDenominator?: number;
}

/** Apply the full contract to one lane's raw inputs → the observation + a per-feature status debug. */
export function buildLaneObservationFromRaw(raw: CortexLaneRaw): { obs: CortexLaneObservation; debug: CortexLaneFeatureDebug } {
  const staleness: CortexLaneCycleStaleness = { lastCycleAt: raw.lastCycleAt, nowMs: raw.nowMs };
  const laneR = raw.isXsec
    ? xsecReturnToR(raw.xsecNetAvgReturn, raw.xsecStopDistance, raw.reportN)
    : laneNetAvgRGuarded(raw.reportNetAvgR, raw.reportN, staleness);
  const pf = lanePfGuarded(raw.reportPf, raw.hasReport, staleness);
  const crowd = crowdingAlignForLane(raw.crowdSides, raw.direction);
  const edgeMemStatus: CortexFeatureStatus = raw.direction === "NEUTRAL" || !finite(raw.edgeMemAvgNetR) || raw.edgeMemN === 0 ? "MISSING" : "FRESH";
  const kronosStatus: CortexFeatureStatus = finite(raw.kronosAgree) ? "FRESH" : "MISSING";

  const obs: CortexLaneObservation = {
    laneId: raw.laneId,
    direction: raw.direction,
    edgeMemAvgNetR: raw.direction === "NEUTRAL" ? null : finite(raw.edgeMemAvgNetR) ? raw.edgeMemAvgNetR : null,
    edgeMemN: raw.direction === "NEUTRAL" ? 0 : finite(raw.edgeMemN) ? Math.max(0, raw.edgeMemN) : 0, // finite guard: Math.max(0,NaN)=NaN would else leak into the observation + x[4]
    laneNetAvgR: laneR.value,
    // Sample count behind laneNetAvgR — 0 when the guard nulled the edge (fabricated-flat / non-finite),
    // so the NEUTRAL-lane allocation-magnitude shrink degrades a thin/absent basket toward 0.
    laneNetAvgN: laneR.value === null ? 0 : Math.max(0, finite(raw.reportN) ? raw.reportN : 0),
    lanePf: pf.value,
    crowdingAlign: crowd.value,
    kronosAgree: finite(raw.kronosAgree) ? raw.kronosAgree : null,
    convictionScore: convictionForLane(raw.controllerBias, raw.controllerConviction, raw.direction),
    vetoed: raw.direction === "NEUTRAL" ? false : raw.vetoed,
    staticWeightPct: raw.staticWeightPct,
  };
  return {
    obs,
    debug: {
      edgeMem: edgeMemStatus,
      laneNetAvgR: laneR.status,
      lanePf: pf.status,
      crowdingAlign: crowd.status,
      kronosAgree: kronosStatus,
      xsecRawNumerator: raw.isXsec ? (laneR as ReturnType<typeof xsecReturnToR>).numerator : undefined,
      xsecRawDenominator: raw.isXsec ? (laneR as ReturnType<typeof xsecReturnToR>).denominator : undefined,
    },
  };
}

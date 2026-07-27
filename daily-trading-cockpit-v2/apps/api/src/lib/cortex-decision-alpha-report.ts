/**
 * CORTEX #219 — shadow decision-alpha report. Read-only: reads the CACHED result of the nightly refit's
 * decision-alpha computation (see cortex-refit-runner-bindings.ts's latestDecisionAlpha, populated once per
 * refit cycle from the SAME inputs the refit already gathered). Never re-reads the journal/lane stores on
 * its own, never writes anything, never touches CORTEX_LIVE_BETA, never influences allocation.
 *
 * 2026-07-20 incident fix: this used to call gatherCortexRefitInputs()/attributeOutcomes() fresh on every
 * HTTP request. With a 10s dashboard poll, that meant tens of MB of synchronous readFileSync+JSON.parse
 * (decision journal + every lane store, including the 21MB CG variant matrix) every 10 seconds, blocking
 * Node's single event loop badly enough to starve the paper-cycle tick and corrupt the Binance clock-sync
 * timestamp measurement (false "clock skew" refusals). Reading a cache populated once per refit cycle
 * (minutes apart) makes each HTTP request O(1) disk-free.
 */
import { getLatestCortexShadowDecisionAlpha, getLatestCortexShadowDecisionAlphaToday } from "./cortex-refit-runner-bindings.js";
import type { CortexShadowDecisionAlphaResult } from "./cortex-attribution.js";

export interface CortexShadowDecisionAlphaReport {
  reportOnly: true;
  generatedAt: string;
  examplesConsidered: number;
  journalBadLines: number;
  decisionAlpha: CortexShadowDecisionAlphaResult;
  /** Same metric, scoped to outcomes resolved within the current UTC calendar day — lets a dashboard show
   *  CORTEX's shadow (non-executed) contribution for TODAY alongside the real, non-CORTEX P&L for today.
   *  Always in R-multiples, never converted to a dollar figure here — CORTEX has never actually resized a
   *  real order on this instance (see collection.mode / cortex.liveBeta on the sibling collection-status
   *  report), so this is a counterfactual, not captured P&L. */
  today: { dayStart: string; examplesConsidered: number; decisionAlpha: CortexShadowDecisionAlphaResult };
}

const EMPTY_DECISION_ALPHA: CortexShadowDecisionAlphaResult = {
  n: 0,
  cumulativeTiltDeltaR: 0,
  meanTiltDeltaR: null,
  perLane: [],
  clusteredCi95: null,
};

export function buildCortexShadowDecisionAlphaReport(
  options: { nowMs?: number } = {},
): CortexShadowDecisionAlphaReport {
  const nowMs = options.nowMs ?? Date.now();
  const cached = getLatestCortexShadowDecisionAlpha();
  const cachedToday = getLatestCortexShadowDecisionAlphaToday();
  // 2026-07-22 bug-hunt fix: the refit tick that populates cachedToday runs on a plain wall-clock
  // interval (default 6h), NOT aligned to UTC midnight — so right after midnight UTC, cachedToday
  // can still hold YESTERDAY's dayStartMs/examplesConsidered/decisionAlpha for a multi-hour window.
  // Trusting it unconditionally reported yesterday's numbers under today's label. Cross-check against
  // the CURRENT day boundary (exactly like the cachedToday-absent branch already derives) and fall
  // back to an honest empty "today" the moment the cache is stale, rather than mislabeling it.
  const currentDayStartMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const today = cachedToday && cachedToday.dayStartMs === currentDayStartMs
    ? { dayStart: new Date(cachedToday.dayStartMs).toISOString(), examplesConsidered: cachedToday.examplesConsidered, decisionAlpha: cachedToday.decisionAlpha }
    : { dayStart: new Date(currentDayStartMs).toISOString(), examplesConsidered: 0, decisionAlpha: EMPTY_DECISION_ALPHA };
  if (!cached) {
    return {
      reportOnly: true,
      generatedAt: new Date(nowMs).toISOString(),
      examplesConsidered: 0,
      journalBadLines: 0,
      decisionAlpha: EMPTY_DECISION_ALPHA,
      today,
    };
  }
  return {
    reportOnly: true,
    generatedAt: new Date(cached.generatedAtMs).toISOString(),
    examplesConsidered: cached.examplesConsidered,
    journalBadLines: cached.journalBadLines,
    decisionAlpha: cached.decisionAlpha,
    today,
  };
}

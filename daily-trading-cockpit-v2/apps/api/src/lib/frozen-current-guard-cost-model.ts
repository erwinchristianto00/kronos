/**
 * FROZEN CURRENT-GUARD COST MODEL (F*** evidence-quality upgrade) — REPORT-ONLY
 *
 * Computes realistic round-trip cost scenarios for the frozen prospective tape
 * (BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1), using the AC microstructure
 * collector's observed spread distribution (p50/p90/p99) and funding rate as
 * inputs. The goal is to replace the flat "28bps" cost assumption with a
 * spread-/funding-aware family of stress scenarios so that live-readiness
 * reporting reflects real execution-cost geometry.
 *
 * STRICTLY REPORT-ONLY & PURE:
 *  - Zero I/O. No singletons, no file access, no network.
 *  - Does NOT change strategy, admission, route selection, or the frozen tape.
 *  - Only re-derives net economics per scenario from already-resolved
 *    observations. Never mutates inputs.
 *  - reportOnly: true always set.
 *
 * Cost conversion (approximation, documented inline):
 *   netR_scenario = grossR - costR_scenario
 *   costR_scenario = roundTripBps / assumedAvgStopBps
 * assumedAvgStopBps defaults to 200 (stop175 era + variant geometry). The frozen
 * observation shape carries no per-position stopBps, so a representative stop
 * distance is used. If a future schema adds per-position stopBps it should be
 * preferred over the flat assumption.
 */

import type { FrozenCurrentGuardObservation } from "./base-route-current-guard-frozen.js";

const DEFAULT_ASSUMED_AVG_STOP_BPS = 200;

/** Flat baseline taker cost (round-trip) in bps: ~2x ~5bps Binance futures taker fee. */
const REALISTIC_TAKER_BPS = 10;

/** Placeholder funding penalty (bps) when funding data is unavailable. */
const FUNDING_PLACEHOLDER_BPS = 2;

export interface SpreadFundingInputs {
  spreadP50Bps: number | null;
  spreadP90Bps: number | null;
  spreadP99Bps: number | null;
  /** Per-interval funding rate (e.g. 0.0001 = 1bp per 8h). */
  avgFundingRate: number | null;
  depthAvailable: boolean;
  fundingAvailable: boolean;
  spreadAvailable: boolean;
}

export interface RealisticCostScenario {
  scenario: string;
  description: string;
  /** Total modeled round-trip cost in bps. */
  roundTripBps: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  /** netAvgR > 0. */
  pass: boolean;
  /** Same as pass; kept for clarity in reporting. */
  stillPositive: boolean;
}

export interface FrozenCurrentGuardCostModelReport {
  reportOnly: true;
  computedAt: string;
  inputsAvailable: {
    spread: boolean;
    funding: boolean;
    depth: boolean;
  };
  /** Representative stop distance used to convert bps→R (default 200). */
  assumedAvgStopBps: number;
  scenarios: RealisticCostScenario[];
  /** Most stressful (highest roundTripBps) scenario still net positive. */
  worstPassingScenario: string | null;
  /** Least stressful (lowest roundTripBps) scenario that fails. */
  firstFailingScenario: string | null;
  /** True when spread+funding available AND the spread_p90 scenario was computed. */
  modelPopulated: boolean;
  summary: string;
}

// ─── numeric helpers ────────────────────────────────────────────────────────

function finiteNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function mean(values: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(values);
  if (finite.length === 0) return null;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function profitFactor(grosses: Array<number | null | undefined>): number | null {
  let winSum = 0;
  let lossSum = 0;
  for (const g of grosses) {
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (g > 0) winSum += g;
    else if (g < 0) lossSum += Math.abs(g);
  }
  if (lossSum === 0) return winSum > 0 ? Infinity : null;
  return winSum / lossSum;
}

/** PF clamped for serialization: Infinity becomes null. */
function pfFinite(grosses: Array<number | null | undefined>): number | null {
  const pf = profitFactor(grosses);
  return pf === Infinity ? null : pf;
}

function winRate(grosses: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(grosses);
  if (finite.length === 0) return null;
  return finite.filter((g) => g > 0).length / finite.length;
}

// ─── builder ──────────────────────────────────────────────────────────────────

export function buildFrozenCurrentGuardCostModelReport(
  observations: FrozenCurrentGuardObservation[],
  spreadFunding: SpreadFundingInputs,
  capturedAt?: string,
): FrozenCurrentGuardCostModelReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  const assumedAvgStopBps = DEFAULT_ASSUMED_AVG_STOP_BPS;

  const obs = Array.isArray(observations) ? observations : [];
  // Only resolved observations with finite grossR can be re-priced.
  const resolved = obs.filter(
    (o) => o && o.status !== "OPEN" && typeof o.grossR === "number" && Number.isFinite(o.grossR),
  );

  const spreadAvailable = spreadFunding?.spreadAvailable === true;
  const fundingAvailable = spreadFunding?.fundingAvailable === true;
  const depthAvailable = spreadFunding?.depthAvailable === true;

  const p50 = typeof spreadFunding?.spreadP50Bps === "number" && Number.isFinite(spreadFunding.spreadP50Bps)
    ? spreadFunding.spreadP50Bps
    : null;
  const p90 = typeof spreadFunding?.spreadP90Bps === "number" && Number.isFinite(spreadFunding.spreadP90Bps)
    ? spreadFunding.spreadP90Bps
    : null;
  const p99 = typeof spreadFunding?.spreadP99Bps === "number" && Number.isFinite(spreadFunding.spreadP99Bps)
    ? spreadFunding.spreadP99Bps
    : null;

  /**
   * Re-price every resolved observation at a given round-trip cost (bps).
   *   netR = grossR - (roundTripBps / assumedAvgStopBps)
   * PF uses gross-less-cost as the basis so a higher cost lowers PF too.
   */
  const priceAt = (roundTripBps: number): { net: number | null; pf: number | null; wr: number | null } => {
    const extraCostR = roundTripBps / assumedAvgStopBps;
    const nets: number[] = [];
    const grossLessCost: number[] = [];
    for (const o of resolved) {
      const g = o.grossR as number;
      nets.push(g - extraCostR);
      grossLessCost.push(g - extraCostR);
    }
    return {
      net: mean(nets),
      pf: pfFinite(grossLessCost),
      wr: winRate(grossLessCost),
    };
  };

  const scenarios: RealisticCostScenario[] = [];

  let p90ScenarioComputed = false;

  const pushScenario = (
    scenario: string,
    description: string,
    roundTripBps: number,
  ): void => {
    const { net, pf, wr } = priceAt(roundTripBps);
    const pass = net !== null && net > 0;
    scenarios.push({
      scenario,
      description,
      roundTripBps,
      netAvgR: net,
      pf,
      wr,
      pass,
      stillPositive: pass,
    });
  };

  // conservative_flat — pessimistic flat 40bps
  pushScenario("conservative_flat", "Pessimistic flat 40bps round-trip", 40);

  // current_28bps — current flat assumption
  pushScenario("current_28bps", "Current flat 28bps cost assumption", 28);

  // realistic_taker — ~10bps round-trip (2x ~5bps Binance futures taker fee)
  pushScenario(
    "realistic_taker",
    "Realistic taker fee only (~2x 5bps round-trip)",
    REALISTIC_TAKER_BPS,
  );

  // spread_p50 — taker + cross spread on both sides at p50
  if (p50 !== null) {
    pushScenario(
      "spread_p50",
      `Realistic taker + 2x observed p50 spread (${p50.toFixed(1)}bps)`,
      REALISTIC_TAKER_BPS + 2 * p50,
    );
  }

  // spread_p90 — taker + cross spread on both sides at p90
  if (p90 !== null) {
    pushScenario(
      "spread_p90",
      `Realistic taker + 2x observed p90 spread (${p90.toFixed(1)}bps)`,
      REALISTIC_TAKER_BPS + 2 * p90,
    );
    p90ScenarioComputed = true;
  }

  // spread_p99 — taker + cross spread on both sides at p99
  if (p99 !== null) {
    pushScenario(
      "spread_p99",
      `Realistic taker + 2x observed p99 spread (${p99.toFixed(1)}bps)`,
      REALISTIC_TAKER_BPS + 2 * p99,
    );
  }

  // plus_5bps_slippage — p90 spread scenario + 5bps adverse slippage
  // (falls back to realistic_taker base when p90 is unavailable)
  {
    const base = p90 !== null ? REALISTIC_TAKER_BPS + 2 * p90 : REALISTIC_TAKER_BPS;
    pushScenario("plus_5bps_slippage", "Spread p90 + 5bps adverse slippage", base + 5);
  }

  // plus_10bps_slippage — p90 spread scenario + 10bps adverse slippage
  {
    const base = p90 !== null ? REALISTIC_TAKER_BPS + 2 * p90 : REALISTIC_TAKER_BPS;
    pushScenario("plus_10bps_slippage", "Spread p90 + 10bps adverse slippage", base + 10);
  }

  // funding_adverse — p90 spread scenario + funding penalty (1 interval representative hold)
  {
    const base = p90 !== null ? REALISTIC_TAKER_BPS + 2 * p90 : REALISTIC_TAKER_BPS;
    let fundingPenaltyBps: number;
    let fundingLabel: string;
    if (fundingAvailable && typeof spreadFunding.avgFundingRate === "number" && Number.isFinite(spreadFunding.avgFundingRate)) {
      // bps = abs(rate) * 10000 * holdingIntervals (assume 1 representative interval)
      fundingPenaltyBps = Math.abs(spreadFunding.avgFundingRate) * 10_000 * 1;
      fundingLabel = `Spread p90 + funding penalty (${fundingPenaltyBps.toFixed(2)}bps, 1 interval)`;
    } else {
      fundingPenaltyBps = FUNDING_PLACEHOLDER_BPS;
      fundingLabel = `Spread p90 + funding penalty (placeholder ${FUNDING_PLACEHOLDER_BPS}bps; funding unavailable)`;
    }
    pushScenario("funding_adverse", fundingLabel, base + fundingPenaltyBps);
  }

  // worstPassingScenario = most stressful (highest roundTripBps) scenario still positive
  let worstPassingScenario: string | null = null;
  let worstPassingBps = -Infinity;
  // firstFailingScenario = least stressful (lowest roundTripBps) scenario that fails
  let firstFailingScenario: string | null = null;
  let firstFailingBps = Infinity;
  for (const s of scenarios) {
    if (s.pass) {
      if (s.roundTripBps > worstPassingBps) {
        worstPassingBps = s.roundTripBps;
        worstPassingScenario = s.scenario;
      }
    } else {
      if (s.roundTripBps < firstFailingBps) {
        firstFailingBps = s.roundTripBps;
        firstFailingScenario = s.scenario;
      }
    }
  }

  const modelPopulated = spreadAvailable && fundingAvailable && p90ScenarioComputed;

  const summary = modelPopulated
    ? `Realistic cost model populated from AC microstructure (spread p50/p90/p99 + funding) on n=${resolved.length} resolved; ` +
      `worst passing scenario: ${worstPassingScenario ?? "none"}; first failing: ${firstFailingScenario ?? "none"}.`
    : `Cost model NOT fully populated (spreadAvailable=${spreadAvailable}, fundingAvailable=${fundingAvailable}, p90Computed=${p90ScenarioComputed}); ` +
      `scenarios computed on n=${resolved.length} resolved.`;

  return {
    reportOnly: true,
    computedAt,
    inputsAvailable: {
      spread: spreadAvailable,
      funding: fundingAvailable,
      depth: depthAvailable,
    },
    assumedAvgStopBps,
    scenarios,
    worstPassingScenario,
    firstFailingScenario,
    modelPopulated,
    summary,
  };
}

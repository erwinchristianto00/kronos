/**
 * Winners-only counterfactual for the cross-sectional basket lane (report-only).
 *
 * Operator hypothesis (2026-07-07): "instead of opening the full hedged basket (winners AND
 * losers), watch it first, then open only the legs that are doing well." This module tests that
 * against the ALREADY-CLOSED basket history — no execution, no store writes.
 *
 * Three numbers per basket, honestly separated:
 *  - fullBasket   — what actually happened (the stored netReturn convention).
 *  - oracle       — keep only legs whose FINAL return was positive. Pure hindsight: an upper
 *                   bound no real strategy can reach. Reported to show the theoretical ceiling,
 *                   clearly labeled as unattainable.
 *  - checkpoints  — the REALISTIC version of the idea: at a checkpoint (fraction of the basket's
 *                   horizon), look at each leg's return SO FAR (from real historical 1h candles),
 *                   keep only the legs positive so far, and ENTER THEM AT THE CHECKPOINT PRICE —
 *                   the honest late-entry penalty (by the time a leg "proves good" its move has
 *                   already happened). Hold to the basket's actual exit price.
 *
 * The decisive statistic is PERSISTENCE: of the legs positive at the checkpoint, how many were
 * still positive at exit — versus the base rate of any leg finishing positive. If persistence
 * barely beats the base rate, "wait until it proves good" carries no information and the
 * late-entry penalty makes it strictly worse than the full basket.
 *
 * Cost model matches the executor (CROSS_SECTIONAL_ROUNDTRIP_BPS per deployed dollar — every
 * deployed dollar sits in exactly one position and pays one round trip). No extra slippage is
 * modeled beyond that; the verdict text says so.
 */
import type { Candle } from "@dtc/shared";

import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  type CrossSectionalObservation,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";

const HOUR_MS = 3_600_000;

/** Fetches 1h candles covering [startMs, endMs] for a symbol. Injected so tests can stub it. */
export type CandleRangeFetcher = (symbol: string, startMs: number, endMs: number) => Promise<Candle[]>;

/** Futures 1000x-multiplier contracts (1000PEPEUSDT, 1000SHIBUSDT, …) have no spot pair under
 *  that name — the spot pair is the bare symbol. Returns are price RATIOS, so the 1000x scaling
 *  cancels and the bare spot candles price the futures leg's return exactly. */
export function spotSymbolForCandles(symbol: string): string {
  return symbol.startsWith("1000") ? symbol.slice(4) : symbol;
}

interface LegView {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  finalReturn: number;
}

export interface WinnersCounterfactualCheckpointStat {
  checkpointFraction: number;
  /** e.g. "6h of 24h" — approximate, from the modal horizon among evaluated baskets. */
  checkpointLabel: string;
  /** Baskets with full candle coverage at this checkpoint. */
  evaluatedBaskets: number;
  /** Of those, baskets where NO leg was positive at the checkpoint (strategy stays flat). */
  noTradeBaskets: number;
  /** Mean/median/win-rate over the TRADED baskets (no-trades excluded; they return 0 by definition). */
  meanNetReturnPct: number | null;
  medianNetReturnPct: number | null;
  winRatePct: number | null;
  /** Same-subset comparison: the ACTUAL full-basket net over exactly the traded baskets. */
  fullBasketMeanNetReturnPctSameSubset: number | null;
  legsSelected: number;
  legsStillPositiveAtExit: number;
  /** P(final positive | positive at checkpoint) */
  persistencePct: number | null;
  /** Base rate: P(final positive) over ALL legs of the evaluated baskets. */
  baselineLegPositivePct: number | null;
}

export interface WinnersCounterfactualReport {
  generatedAt: string;
  variant: string;
  costReturnPct: number;
  closedCompleteBaskets: number;
  excludedIncompleteLegs: number;
  excludedNoCandleCoverage: number;
  fullBasket: { baskets: number; meanNetReturnPct: number | null; winRatePct: number | null };
  oracle: {
    baskets: number;
    meanNetReturnPct: number | null;
    winRatePct: number | null;
    note: string;
  };
  checkpoints: WinnersCounterfactualCheckpointStat[];
  verdict: string;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pct(x: number | null): number | null {
  return x === null ? null : x * 100;
}

function legViews(obs: CrossSectionalObservation): LegView[] | null {
  const views: LegView[] = [];
  for (const [side, legs] of [["LONG", obs.longLeg], ["SHORT", obs.shortLeg]] as const) {
    for (const leg of legs) {
      if (leg.exitPrice === null || !(leg.entryPrice > 0)) return null; // incomplete — exclude basket
      const finalReturn =
        side === "LONG"
          ? leg.exitPrice / leg.entryPrice - 1
          : 1 - leg.exitPrice / leg.entryPrice;
      views.push({ symbol: leg.symbol, side, entryPrice: leg.entryPrice, exitPrice: leg.exitPrice, finalReturn });
    }
  }
  return views.length > 0 ? views : null;
}

/** Close of the last COMPLETED 1h candle at or before tMs (candle openTime + 1h <= tMs) — never
 *  reads the in-progress candle, so checkpoint selection sees only genuinely-past prices. */
function closeAtOrBefore(candles: Candle[], tMs: number): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.openTime + HOUR_MS <= tMs && (best === null || c.openTime > best.openTime)) best = c;
  }
  return best !== null && best.close > 0 ? best.close : null;
}

export async function buildWinnersCounterfactualReport(
  store: CrossSectionalStore,
  fetchCandles: CandleRangeFetcher,
  opts: { variant?: string; checkpointFractions?: number[]; nowIso?: () => string } = {},
): Promise<WinnersCounterfactualReport> {
  const variant = opts.variant ?? "FILTERED";
  const fractions = opts.checkpointFractions ?? [0.125, 0.25, 0.5];
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const costReturn = CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;

  const closed = store.all.filter(
    (o) => o.status === "CLOSED" && (o.variant ?? "RAW") === variant,
  );
  let excludedIncompleteLegs = 0;
  const baskets: Array<{ obs: CrossSectionalObservation; legs: LegView[] }> = [];
  for (const obs of closed) {
    const legs = legViews(obs);
    if (legs === null) {
      excludedIncompleteLegs += 1;
      continue;
    }
    baskets.push({ obs, legs });
  }

  // One candle fetch per distinct symbol covering the whole evaluated span (memoized).
  const candlesBySymbol = new Map<string, Candle[]>();
  if (baskets.length > 0) {
    const spanStart = Math.min(...baskets.map((b) => b.obs.openedAtMs)) - HOUR_MS;
    const spanEnd = Math.max(...baskets.map((b) => b.obs.openedAtMs + b.obs.horizonMs)) + HOUR_MS;
    const symbols = new Set(baskets.flatMap((b) => b.legs.map((l) => l.symbol)));
    for (const symbol of symbols) {
      try {
        candlesBySymbol.set(symbol, await fetchCandles(spotSymbolForCandles(symbol), spanStart, spanEnd));
      } catch {
        candlesBySymbol.set(symbol, []); // baskets touching this symbol fall out via coverage checks
      }
    }
  }

  // Full-basket baseline: the stored netReturn (already net of the same cost model).
  const fullNets = baskets
    .map((b) => b.obs.netReturn)
    .filter((n): n is number => n !== null && Number.isFinite(n));

  // Oracle: keep only final-positive legs; deployed capital = selected legs, equal weight,
  // one round-trip cost per deployed dollar. Baskets where every leg lost stay flat (excluded
  // from the mean the same way checkpoint no-trades are, and counted in its note).
  const oracleNets: number[] = [];
  let oracleNoTrade = 0;
  for (const b of baskets) {
    const winners = b.legs.filter((l) => l.finalReturn > 0);
    if (winners.length === 0) {
      oracleNoTrade += 1;
      continue;
    }
    oracleNets.push(mean(winners.map((l) => l.finalReturn))! - costReturn);
  }

  const checkpoints: WinnersCounterfactualCheckpointStat[] = [];
  let excludedNoCandleCoverage = 0;
  const coverageExcluded = new Set<string>();

  for (const fraction of fractions) {
    let evaluated = 0;
    let noTrade = 0;
    const strategyNets: number[] = [];
    const fullSameSubset: number[] = [];
    let legsSelected = 0;
    let legsStillPositive = 0;
    let allLegs = 0;
    let allLegsFinalPositive = 0;
    const horizons: number[] = [];

    for (const b of baskets) {
      const checkpointMs = b.obs.openedAtMs + b.obs.horizonMs * fraction;
      const cpPrices = b.legs.map((l) => closeAtOrBefore(candlesBySymbol.get(l.symbol) ?? [], checkpointMs));
      if (cpPrices.some((p) => p === null)) {
        coverageExcluded.add(b.obs.observationId);
        continue;
      }
      evaluated += 1;
      horizons.push(b.obs.horizonMs);
      for (const l of b.legs) {
        allLegs += 1;
        if (l.finalReturn > 0) allLegsFinalPositive += 1;
      }

      const selected: Array<{ leg: LegView; cpPrice: number }> = [];
      for (let i = 0; i < b.legs.length; i += 1) {
        const leg = b.legs[i]!;
        const cpPrice = cpPrices[i]!;
        const soFar = leg.side === "LONG" ? cpPrice / leg.entryPrice - 1 : 1 - cpPrice / leg.entryPrice;
        if (soFar > 0) selected.push({ leg, cpPrice });
      }
      if (selected.length === 0) {
        noTrade += 1;
        continue;
      }
      legsSelected += selected.length;
      const lateEntryReturns = selected.map(({ leg, cpPrice }) =>
        leg.side === "LONG" ? leg.exitPrice / cpPrice - 1 : 1 - leg.exitPrice / cpPrice,
      );
      for (const { leg } of selected) if (leg.finalReturn > 0) legsStillPositive += 1;
      strategyNets.push(mean(lateEntryReturns)! - costReturn);
      const fullNet = b.obs.netReturn;
      if (fullNet !== null && Number.isFinite(fullNet)) fullSameSubset.push(fullNet);
    }

    const modalHorizonH = horizons.length > 0 ? Math.round(median(horizons)! / HOUR_MS) : 24;
    checkpoints.push({
      checkpointFraction: fraction,
      checkpointLabel: `${Math.round(modalHorizonH * fraction)}h of ${modalHorizonH}h`,
      evaluatedBaskets: evaluated,
      noTradeBaskets: noTrade,
      meanNetReturnPct: pct(mean(strategyNets)),
      medianNetReturnPct: pct(median(strategyNets)),
      winRatePct: pct(strategyNets.length === 0 ? null : strategyNets.filter((n) => n > 0).length / strategyNets.length),
      fullBasketMeanNetReturnPctSameSubset: pct(mean(fullSameSubset)),
      legsSelected,
      legsStillPositiveAtExit: legsStillPositive,
      persistencePct: pct(legsSelected === 0 ? null : legsStillPositive / legsSelected),
      baselineLegPositivePct: pct(allLegs === 0 ? null : allLegsFinalPositive / allLegs),
    });
  }
  excludedNoCandleCoverage = coverageExcluded.size;

  const persistenceLifts = checkpoints
    .filter((c) => c.persistencePct !== null && c.baselineLegPositivePct !== null)
    .map((c) => c.persistencePct! - c.baselineLegPositivePct!);
  const beatsFull = checkpoints.filter(
    (c) =>
      c.meanNetReturnPct !== null &&
      c.fullBasketMeanNetReturnPctSameSubset !== null &&
      c.meanNetReturnPct > c.fullBasketMeanNetReturnPctSameSubset,
  ).length;
  const verdict =
    baskets.length === 0
      ? "insufficient data: no closed complete baskets for this variant yet"
      : `across ${checkpoints.length} checkpoints the winners-only strategy beat the full basket on ${beatsFull}/${checkpoints.length}; ` +
        `mean persistence lift over base rate: ${persistenceLifts.length > 0 ? (mean(persistenceLifts)!).toFixed(1) : "n/a"} pp. ` +
        "Oracle is hindsight-only (unattainable ceiling). Late entries are priced at real checkpoint candles; " +
        "no slippage beyond the standard round-trip cost model is included, so live results would be slightly worse than shown.";

  return {
    generatedAt: nowIso(),
    variant,
    costReturnPct: costReturn * 100,
    closedCompleteBaskets: baskets.length,
    excludedIncompleteLegs,
    excludedNoCandleCoverage,
    fullBasket: {
      baskets: fullNets.length,
      meanNetReturnPct: pct(mean(fullNets)),
      winRatePct: pct(fullNets.length === 0 ? null : fullNets.filter((n) => n > 0).length / fullNets.length),
    },
    oracle: {
      baskets: oracleNets.length,
      meanNetReturnPct: pct(mean(oracleNets)),
      winRatePct: pct(oracleNets.length === 0 ? null : oracleNets.filter((n) => n > 0).length / oracleNets.length),
      note: `pure hindsight (keeps only final-positive legs) — an upper bound no real strategy can reach; ${oracleNoTrade} all-loser baskets stay flat`,
    },
    checkpoints,
    verdict,
  };
}

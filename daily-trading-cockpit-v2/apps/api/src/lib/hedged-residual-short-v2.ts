/**
 * HEDGED RESIDUAL SHORT CONTINUATION V2.
 *
 * This is a sibling experiment of RESIDUAL_MOMENTUM_LEADER_LAGGARD, not a
 * renamed parent. It keeps only the internally-promising continuation sign:
 * short the weakest bottom-ranked residuals, then add a smaller BTC long hedge
 * sized from the legs' rolling betas. It never shorts residual winners and
 * therefore does not mix a reversal hypothesis into the parent's continuation
 * evidence.
 *
 * Outcomes are basket close-to-close markouts with a fixed after-cost basket
 * TP/stop/time horizon. No order, paper order, allocator, or live authority.
 */
import type { Candle } from "@dtc/shared";
import { resolve } from "node:path";

import {
  RM_BENCHMARK_SYMBOL,
  RM_BETA_WINDOW_BARS,
  RM_INTERVAL,
  RM_MAX_HOLD_BARS,
  RM_RANK_HISTORY_MAX,
  RM_UNIVERSE,
  computeRankPersistence,
  computeResidualMomentumScore,
  rankResidualMomentum,
  type RankedResidualMomentum,
} from "./residual-momentum-edge.js";
import { REALISTIC_ROUND_TRIP_FEE_SLIP_BPS } from "./shadow-engine.js";
import {
  InnovationShadowStore,
  buildInnovationShadowReport,
  type InnovationCycleResult,
  type InnovationObservationBase,
} from "./innovation-shadow-store.js";

function envNumPos(name: string, dflt: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : dflt;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return variance > 0 ? Math.sqrt(variance) : null;
}

function recentVolatility(candles: readonly Candle[], bars = RM_BETA_WINDOW_BARS): number | null {
  const closes = [...candles]
    .sort((a, b) => a.openTime - b.openTime)
    .map((c) => c.close)
    .filter((value) => finite(value) && value > 0)
    .slice(-(bars + 1));
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index++) {
    returns.push(closes[index]! / closes[index - 1]! - 1);
  }
  return standardDeviation(returns);
}

export const HRS_V2_LANE_ID = "HEDGED_RESIDUAL_SHORT_CONTINUATION_V2" as const;
export const HRS_V2_PARENT_LANE_ID = "RESIDUAL_MOMENTUM_LEADER_LAGGARD" as const;
export const HRS_V2_K = envNumPos("HEDGED_RESIDUAL_SHORT_V2_K", 3);
export const HRS_V2_MAX_RESIDUAL_RETURN = -envNumPos("HEDGED_RESIDUAL_SHORT_V2_MIN_WEAKNESS", 0.0025);
export const HRS_V2_MIN_RANK_PERSISTENCE = envNumPos("HEDGED_RESIDUAL_SHORT_V2_MIN_PERSISTENCE", 0.35);
export const HRS_V2_TAKE_PROFIT_RETURN = envNumPos("HEDGED_RESIDUAL_SHORT_V2_TP_RETURN", 0.005);
export const HRS_V2_STOP_RETURN = envNumPos("HEDGED_RESIDUAL_SHORT_V2_STOP_RETURN", 0.0035);
export const HRS_V2_MAX_HOLD_BARS = envNumPos("HEDGED_RESIDUAL_SHORT_V2_MAX_HOLD_BARS", RM_MAX_HOLD_BARS);
export const HRS_V2_MAX_SETTLED = envNumPos("HEDGED_RESIDUAL_SHORT_V2_MAX_SETTLED", 500);

export interface HedgedResidualShortLeg {
  symbol: string;
  entryPrice: number;
  residualReturnAtEntry: number;
  betaAtEntry: number;
  rankAtEntry: number;
  persistenceAtEntry: number;
  volatilityAtEntry: number;
  weight: number;
}

export interface HedgedResidualShortObservation extends InnovationObservationBase {
  regimeAtEntry: string | null;
  benchmarkSymbol: typeof RM_BENCHMARK_SYMBOL;
  benchmarkEntryPrice: number;
  hedgeBeta: number;
  shortLegs: HedgedResidualShortLeg[];
  takeProfitReturn: number;
  stopReturn: number;
  maxHoldBars: number;
  grossBasketReturn: number | null;
  costReturn: number | null;
  netBasketReturn: number | null;
  holdBars: number | null;
}

export interface HedgedResidualCandidate {
  ranked: RankedResidualMomentum;
  persistence: number;
  volatility: number;
}

export function selectHedgedResidualShortCandidates(opts: {
  ranked: readonly RankedResidualMomentum[];
  volatilityBySymbol: ReadonlyMap<string, number>;
  rankHistoryFor: (symbol: string) => readonly number[];
  k?: number;
  maxResidualReturn?: number;
  minPersistence?: number;
}): HedgedResidualCandidate[] {
  const k = Math.min(opts.k ?? HRS_V2_K, Math.floor(opts.ranked.length / 2));
  const maxResidualReturn = opts.maxResidualReturn ?? HRS_V2_MAX_RESIDUAL_RETURN;
  const minPersistence = opts.minPersistence ?? HRS_V2_MIN_RANK_PERSISTENCE;
  return [...opts.ranked]
    .slice(Math.max(0, opts.ranked.length - k))
    .map((ranked) => ({
      ranked,
      persistence: computeRankPersistence(
        opts.rankHistoryFor(ranked.symbol).slice(-RM_RANK_HISTORY_MAX),
        opts.ranked.length,
      ),
      volatility: opts.volatilityBySymbol.get(ranked.symbol) ?? Number.NaN,
    }))
    .filter(
      (candidate) =>
        candidate.ranked.residualReturn <= maxResidualReturn &&
        candidate.persistence >= minPersistence &&
        finite(candidate.volatility) &&
        candidate.volatility > 0,
    );
}

export function buildHedgedResidualShortObservation(opts: {
  candidates: readonly HedgedResidualCandidate[];
  benchmarkEntryPrice: number;
  regimeAtEntry: string | null;
  now: number;
}): HedgedResidualShortObservation | null {
  if (opts.candidates.length === 0 || !(opts.benchmarkEntryPrice > 0)) return null;
  const inverseVol = opts.candidates.map((candidate) => 1 / candidate.volatility);
  const totalInverseVol = inverseVol.reduce((sum, value) => sum + value, 0);
  if (!(totalInverseVol > 0)) return null;

  const shortLegs = opts.candidates.map((candidate, index): HedgedResidualShortLeg => ({
    symbol: candidate.ranked.symbol,
    entryPrice: candidate.ranked.price,
    residualReturnAtEntry: candidate.ranked.residualReturn,
    betaAtEntry: candidate.ranked.beta,
    rankAtEntry: candidate.ranked.rank,
    persistenceAtEntry: candidate.persistence,
    volatilityAtEntry: candidate.volatility,
    weight: inverseVol[index]! / totalInverseVol,
  }));
  const hedgeBeta = shortLegs.reduce((sum, leg) => sum + leg.weight * Math.max(0, leg.betaAtEntry), 0);
  if (!(hedgeBeta > 0)) return null;
  const bucket = Math.floor(opts.now / 3_600_000) * 3_600_000;

  return {
    observationId: `hrsv2:${shortLegs.map((leg) => leg.symbol).sort().join("-")}:${bucket}`,
    openedAt: new Date(opts.now).toISOString(),
    openedAtMs: opts.now,
    regimeAtEntry: opts.regimeAtEntry,
    benchmarkSymbol: RM_BENCHMARK_SYMBOL,
    benchmarkEntryPrice: opts.benchmarkEntryPrice,
    hedgeBeta,
    shortLegs,
    takeProfitReturn: HRS_V2_TAKE_PROFIT_RETURN,
    stopReturn: HRS_V2_STOP_RETURN,
    maxHoldBars: HRS_V2_MAX_HOLD_BARS,
    grossBasketReturn: null,
    costReturn: null,
    netBasketReturn: null,
    holdBars: null,
    status: "OPEN",
    grossR: null,
    costR: null,
    netR: null,
    exitReason: null,
    resolvedAt: null,
  };
}

function candleByOpenTime(candles: readonly Candle[], afterMs: number): Map<number, Candle> {
  return new Map(
    candles
      .filter((c) => c.openTime > afterMs && finite(c.close) && c.close > 0)
      .map((c) => [c.openTime, c]),
  );
}

export function resolveHedgedResidualShortObservation(
  observation: HedgedResidualShortObservation,
  candlesBySymbol: ReadonlyMap<string, readonly Candle[]>,
  now: number,
): Partial<HedgedResidualShortObservation> | null {
  const benchmarkMap = candleByOpenTime(candlesBySymbol.get(observation.benchmarkSymbol) ?? [], observation.openedAtMs);
  const legMaps = new Map(
    observation.shortLegs.map((leg) => [
      leg.symbol,
      candleByOpenTime(candlesBySymbol.get(leg.symbol) ?? [], observation.openedAtMs),
    ]),
  );
  const commonTimes = [...benchmarkMap.keys()]
    .filter((time) => observation.shortLegs.every((leg) => legMaps.get(leg.symbol)?.has(time)))
    .sort((a, b) => a - b)
    .slice(0, observation.maxHoldBars);

  const grossExposure = 1 + observation.hedgeBeta;
  // Report basket returns on total gross exposure. Every leg pays the same round-trip rate, so
  // the exposure-weighted basket cost remains that rate rather than being double-counted.
  const costReturn = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / 10_000;

  const finalize = (
    grossBasketReturn: number,
    time: number,
    holdBars: number,
    exitReason: string,
  ): Partial<HedgedResidualShortObservation> => {
    const netBasketReturn = grossBasketReturn - costReturn;
    const grossR = grossBasketReturn / observation.stopReturn;
    const costR = costReturn / observation.stopReturn;
    const netR = netBasketReturn / observation.stopReturn;
    return {
      status: netR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossBasketReturn,
      costReturn,
      netBasketReturn,
      holdBars,
      grossR,
      costR,
      netR,
      exitReason,
      resolvedAt: new Date(time).toISOString(),
    };
  };

  for (let index = 0; index < commonTimes.length; index++) {
    const time = commonTimes[index]!;
    const benchmarkClose = benchmarkMap.get(time)!.close;
    const shortReturn = observation.shortLegs.reduce((sum, leg) => {
      const close = legMaps.get(leg.symbol)!.get(time)!.close;
      return sum + leg.weight * (leg.entryPrice - close) / leg.entryPrice;
    }, 0);
    const hedgeReturn =
      observation.hedgeBeta *
      (benchmarkClose - observation.benchmarkEntryPrice) /
      observation.benchmarkEntryPrice;
    const grossBasketReturn = (shortReturn + hedgeReturn) / grossExposure;
    const netBasketReturn = grossBasketReturn - costReturn;
    if (netBasketReturn <= -observation.stopReturn) {
      return finalize(grossBasketReturn, time, index + 1, "BASKET_STOP");
    }
    if (netBasketReturn >= observation.takeProfitReturn) {
      return finalize(grossBasketReturn, time, index + 1, "BASKET_TAKE_PROFIT");
    }
    if (index + 1 >= observation.maxHoldBars) {
      return finalize(grossBasketReturn, time, index + 1, "MAX_HOLD_MTM");
    }
  }

  // A partially missing leg can leave a few common timestamps but never reach maxHoldBars.
  // Expire after a generous three-horizon grace period rather than retaining an unresolvable basket.
  if (
    commonTimes.length < observation.maxHoldBars &&
    now - observation.openedAtMs > observation.maxHoldBars * 3_600_000 * 3
  ) {
    return { status: "EXPIRED", resolvedAt: new Date(now).toISOString() };
  }
  return null;
}

let singleton: InnovationShadowStore<HedgedResidualShortObservation> | null = null;
export function getHedgedResidualShortV2Store(dataDir = "data"): InnovationShadowStore<HedgedResidualShortObservation> {
  if (!singleton) {
    singleton = new InnovationShadowStore(
      resolve(dataDir, "hedged-residual-short-v2.json"),
      HRS_V2_MAX_SETTLED,
    );
  }
  return singleton;
}

export function _resetHedgedResidualShortV2StoreForTests(): void {
  singleton = null;
}

export async function runHedgedResidualShortV2Cycle(opts: {
  store: InnovationShadowStore<HedgedResidualShortObservation>;
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  rankHistoryFor: (symbol: string) => readonly number[];
  universe?: readonly string[];
  regimeAtEntry?: string | null;
}): Promise<InnovationCycleResult> {
  const result: InnovationCycleResult = {
    scanned: 0,
    candidates: 0,
    recorded: 0,
    resolved: 0,
    expired: 0,
    rejected: 0,
  };
  const universe = (opts.universe ?? RM_UNIVERSE).filter((symbol) => symbol !== RM_BENCHMARK_SYMBOL);
  const symbols = new Set([
    RM_BENCHMARK_SYMBOL,
    ...universe,
    ...opts.store.all.flatMap((observation) => [
      observation.benchmarkSymbol,
      ...observation.shortLegs.map((leg) => leg.symbol),
    ]),
  ]);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      // Missing symbols remain absent and cannot fabricate a basket outcome.
    }
  }

  for (const observation of opts.store.all) {
    if (observation.status !== "OPEN") continue;
    const patch = resolveHedgedResidualShortObservation(observation, candlesBySymbol, opts.now);
    if (!patch) continue;
    opts.store.update(observation.observationId, patch);
    if (patch.status === "EXPIRED") result.expired += 1;
    else result.resolved += 1;
  }

  const benchmarkCandles = candlesBySymbol.get(RM_BENCHMARK_SYMBOL) ?? [];
  const scores = universe.flatMap((symbol) => {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles || benchmarkCandles.length === 0) return [];
    const score = computeResidualMomentumScore(candles, benchmarkCandles);
    return score ? [{ ...score, symbol }] : [];
  });
  const ranked = rankResidualMomentum(scores);
  const volatilityBySymbol = new Map(
    universe.flatMap((symbol) => {
      const volatility = recentVolatility(candlesBySymbol.get(symbol) ?? []);
      return volatility ? [[symbol, volatility] as const] : [];
    }),
  );
  const candidates = selectHedgedResidualShortCandidates({
    ranked,
    volatilityBySymbol,
    rankHistoryFor: opts.rankHistoryFor,
  });
  result.candidates = candidates.length;
  if (candidates.length < 2) {
    result.rejected += 1;
  } else {
    const benchmarkEntryPrice = benchmarkCandles.at(-1)?.close ?? 0;
    const observation = buildHedgedResidualShortObservation({
      candidates,
      benchmarkEntryPrice,
      regimeAtEntry: opts.regimeAtEntry ?? null,
      now: opts.now,
    });
    if (observation && opts.store.add(observation)) result.recorded += 1;
  }

  opts.store.recordCycle(new Date(opts.now).toISOString(), result);
  opts.store.save();
  return result;
}

let cycleInFlight = false;
export async function runHedgedResidualShortV2CycleGuarded(
  opts: Parameters<typeof runHedgedResidualShortV2Cycle>[0],
): Promise<InnovationCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runHedgedResidualShortV2Cycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      // Report-only liveness bookkeeping cannot escape this boundary.
    }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function buildHedgedResidualShortV2Report(store = getHedgedResidualShortV2Store()) {
  return buildInnovationShadowReport({
    laneId: HRS_V2_LANE_ID,
    parentLaneId: HRS_V2_PARENT_LANE_ID,
    thesis: "Short persistent bottom-ranked residual laggards and hedge common beta with BTC.",
    signalSource: `${RM_INTERVAL} candles; rolling OLS beta; inverse-vol short legs; close-only basket markout`,
    store,
    details: {
      direction: "SHORT_HEDGED",
      k: HRS_V2_K,
      maxResidualReturn: HRS_V2_MAX_RESIDUAL_RETURN,
      minRankPersistence: HRS_V2_MIN_RANK_PERSISTENCE,
      takeProfitReturn: HRS_V2_TAKE_PROFIT_RETURN,
      stopReturn: HRS_V2_STOP_RETURN,
      maxHoldBars: HRS_V2_MAX_HOLD_BARS,
      costBpsPerRoundTripNotional: REALISTIC_ROUND_TRIP_FEE_SLIP_BPS,
      outcomeModel: "BASKET_CLOSE_MARKOUT_NO_INTRABAR_FILL_ASSUMPTION",
    },
    recent: (observation) => ({
      symbols: observation.shortLegs.map((leg) => leg.symbol),
      hedgeBeta: observation.hedgeBeta,
      regimeAtEntry: observation.regimeAtEntry,
      netR: observation.netR,
      status: observation.status,
      openedAt: observation.openedAt,
    }),
  });
}

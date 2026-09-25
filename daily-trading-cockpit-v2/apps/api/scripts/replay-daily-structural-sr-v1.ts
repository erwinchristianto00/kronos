/**
 * Read-only policy replay for Daily Range Structural S/R V1.
 *
 * Input is one durable Daily Range state JSON captured before the cutover.
 * The script never opens a store, changes a ledger, or calls a private Binance
 * endpoint. It queries only the matching public USD-M history endpoint with a
 * globally serialized request pace, then reports pre-allocation policy facts.
 * It intentionally does not claim to replay later slot/account ownership
 * decisions, which are runtime state rather than a chart policy decision.
 */
import { readFile } from "node:fs/promises";

import type { FuturesKline, FuturesSymbolFilters } from "../src/lib/binance-futures-private.js";
import {
  calculateCausalAtr14,
  dailyRangeEconomicTieBreakHash,
  expectedDailyRangeEntryPrice,
  prepareDailyRangeEconomics,
  type DailyRangeFrictionModel,
} from "../src/lib/daily-range-economics.js";
import { structuralStopForDailyRangeSignal } from "../src/lib/daily-4h-range-acceptance-lane.js";
import { dailyRangeStructuralStopSource, resolveDailyRangeStructuralTarget } from "../src/lib/daily-range-structural-sr.js";

const REQUEST_GAP_MS = Math.max(100, Math.min(5_000, Number(process.env.DAILY_SR_REPLAY_REQUEST_GAP_MS ?? "250")));
const MAX_SIGNALS = Math.max(1, Math.min(250, Number(process.env.DAILY_SR_REPLAY_LIMIT ?? "100")));

type Environment = "mainnet" | "testnet";
type Side = "LONG" | "SHORT";
type Route = "CONTINUATION" | "FADE";

type StoredCandle = {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
};

type StoredSignal = {
  signalId: string;
  strategyVersion?: string;
  symbol: string;
  direction: Side;
  entryPolicy?: Route;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: StoredCandle | null;
  confirmationBar2: StoredCandle;
  breakoutExtreme?: number | null;
  referenceRangeCloseTime?: number | null;
  signalTimestamp: string;
  signalTimestampMs: number;
  reason: string | null;
  economics?: {
    geometry?: { geometryPass?: boolean | null } | null;
  } | null;
  geometry?: { geometryPass?: boolean | null } | null;
  research?: {
    marketQuality?: {
      bestBid?: number | null;
      bestAsk?: number | null;
      bookObservedAt?: string | null;
      bookReceivedAt?: string | null;
      bookSourceTime?: number | null;
    } | null;
  } | null;
};

type StoredState = {
  signals?: StoredSignal[];
  frictionModels?: DailyRangeFrictionModel[];
  frictionModelByUtcDate?: Record<string, string>;
  signalCohorts?: Array<{
    finalizedAt?: string | null;
    allocation?: { finalizedAt?: string | null } | null;
    candidates?: Array<{
      signalId?: string | null;
      decision?: {
        entryEligible?: boolean | null;
        reason?: string | null;
        tradeId?: string | null;
        entryAttemptedAt?: string | null;
      } | null;
    }>;
  }>;
};

type StoredCandidateDecision = {
  entryEligible: boolean | null;
  reason: string | null;
  tradeId: string | null;
  entryAttemptedAt: string | null;
};

type ReplayRow = {
  signalId: string;
  symbol: string;
  timestamp: string;
  route: Route;
  side: Side;
  oldDecision: "PREALLOCATION_ELIGIBLE" | "REJECTED_OR_BLOCKED";
  oldReason: string | null;
  newDecision: "EXECUTION_CANDIDATE" | "LIVE_CONTINUATION_SHADOW" | "REJECTED" | "UNAVAILABLE";
  newReason: string | null;
  stopPct: number | null;
  target: number | null;
  targetSource: string | null;
  targetLevelType: string | null;
  targetTimeframe: string | null;
  grossStructuralRR: number | null;
  plannedNotionalUsd: number | null;
  expectedLossUsd: number | null;
  expectedNetRewardUsd: number | null;
  netRewardRisk: number | null;
  costRatio: number | null;
  tieBreakHash: string | null;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextRequestAt = 0;
async function pacedFetch(url: URL): Promise<unknown> {
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await delay(waitMs);
  nextRequestAt = Date.now() + REQUEST_GAP_MS;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Binance public HTTP ${response.status}`);
  return response.json();
}

function baseUrl(environment: Environment): string {
  return environment === "mainnet" ? "https://fapi.binance.com" : "https://testnet.binancefuture.com";
}

function klineFromPayload(row: unknown, intervalMs: number): FuturesKline | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const openTime = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const closeTime = Number(row[6]);
  if (![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite)
    || openTime < 0 || closeTime !== openTime + intervalMs - 1
    || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || high < low) return null;
  return { openTime, closeTime, open, high, low, close, volume };
}

async function getKlines(input: {
  environment: Environment;
  symbol: string;
  interval: "1h" | "4h";
  endTime: number;
  limit: number;
}): Promise<FuturesKline[]> {
  const intervalMs = input.interval === "1h" ? 60 * 60_000 : 4 * 60 * 60_000;
  const url = new URL("/fapi/v1/klines", baseUrl(input.environment));
  url.searchParams.set("symbol", input.symbol);
  url.searchParams.set("interval", input.interval);
  url.searchParams.set("endTime", String(input.endTime));
  url.searchParams.set("limit", String(input.limit));
  const payload = await pacedFetch(url);
  if (!Array.isArray(payload)) throw new Error("kline payload is not an array");
  return payload.map((row) => klineFromPayload(row, intervalMs)).filter((row): row is FuturesKline => row !== null);
}

async function getFilters(environment: Environment): Promise<Map<string, FuturesSymbolFilters>> {
  const payload = await pacedFetch(new URL("/fapi/v1/exchangeInfo", baseUrl(environment))) as { symbols?: unknown };
  const result = new Map<string, FuturesSymbolFilters>();
  if (!Array.isArray(payload?.symbols)) return result;
  for (const row of payload.symbols) {
    if (!row || typeof row !== "object") continue;
    const item = row as { symbol?: unknown; pricePrecision?: unknown; quantityPrecision?: unknown; filters?: unknown };
    const symbol = typeof item.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
    const filters = Array.isArray(item.filters) ? item.filters as Array<{ filterType?: unknown; tickSize?: unknown; stepSize?: unknown; minQty?: unknown; notional?: unknown; minNotional?: unknown }> : [];
    const price = filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lot = filters.find((filter) => filter.filterType === "LOT_SIZE");
    const notional = filters.find((filter) => filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL");
    const tickSize = Number(price?.tickSize);
    const stepSize = Number(lot?.stepSize);
    const minQty = Number(lot?.minQty);
    const minNotional = Number(notional?.minNotional ?? notional?.notional);
    if (!symbol || !positive(tickSize) || !positive(stepSize) || !positive(minQty) || !positive(minNotional)) continue;
    result.set(symbol, {
      symbol,
      tickSize,
      stepSize,
      minQty,
      minNotional,
      pricePrecision: Number.isInteger(item.pricePrecision) ? Number(item.pricePrecision) : 8,
      quantityPrecision: Number.isInteger(item.quantityPrecision) ? Number(item.quantityPrecision) : 8,
    });
  }
  return result;
}

function oldDecision(input: {
  signal: StoredSignal;
  candidateDecision: StoredCandidateDecision | null;
}): { decision: "PREALLOCATION_ELIGIBLE" | "REJECTED_OR_BLOCKED"; reason: string | null } {
  const { signal, candidateDecision } = input;
  const geometryPass = signal.geometry?.geometryPass ?? signal.economics?.geometry?.geometryPass ?? null;
  const eligible = candidateDecision?.entryEligible === true || Boolean(signal.economics && geometryPass !== false);
  return {
    decision: eligible ? "PREALLOCATION_ELIGIBLE" : "REJECTED_OR_BLOCKED",
    reason: candidateDecision?.reason ?? signal.reason,
  };
}

function frictionFor(state: StoredState, timestampMs: number): DailyRangeFrictionModel | null {
  const id = state.frictionModelByUtcDate?.[utcDate(timestampMs)] ?? null;
  return id ? state.frictionModels?.find((model) => model.id === id) ?? null : null;
}

function addCount(target: Record<string, number>, key: string | null): void {
  const label = key ?? "NONE";
  target[label] = (target[label] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function replayOne(input: {
  signal: StoredSignal;
  state: StoredState;
  environment: Environment;
  filters: Map<string, FuturesSymbolFilters>;
  candidateDecisions: Map<string, StoredCandidateDecision>;
}): Promise<ReplayRow> {
  const { signal, state, environment, filters, candidateDecisions } = input;
  const previous = oldDecision({ signal, candidateDecision: candidateDecisions.get(signal.signalId) ?? null });
  const base: Omit<ReplayRow, "newDecision" | "newReason" | "stopPct" | "target" | "targetSource" | "targetLevelType" | "targetTimeframe" | "grossStructuralRR" | "plannedNotionalUsd" | "expectedLossUsd" | "expectedNetRewardUsd" | "netRewardRisk" | "costRatio" | "tieBreakHash"> = {
    signalId: signal.signalId,
    symbol: signal.symbol,
    timestamp: signal.signalTimestamp,
    route: signal.entryPolicy!,
    side: signal.direction,
    oldDecision: previous.decision,
    oldReason: previous.reason,
  };
  const bbo = signal.research?.marketQuality;
  const friction = frictionFor(state, signal.signalTimestampMs);
  const filter = filters.get(signal.symbol.toUpperCase()) ?? null;
  const observedAt = bbo?.bookObservedAt ?? null;
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!positive(bbo?.bestBid) || !positive(bbo?.bestAsk) || !friction || !filter || !Number.isFinite(observedAtMs)) {
    return {
      ...base,
      newDecision: "UNAVAILABLE",
      newReason: !friction ? "FRICTION_MODEL_UNAVAILABLE" : !filter ? "RISK_BUDGET_UNEXECUTABLE" : "BBO_STALE",
      stopPct: null, target: null, targetSource: null, targetLevelType: null, targetTimeframe: null,
      grossStructuralRR: null, plannedNotionalUsd: null, expectedLossUsd: null, expectedNetRewardUsd: null, netRewardRisk: null, costRatio: null, tieBreakHash: null,
    };
  }
  const expectedEntry = expectedDailyRangeEntryPrice({ side: signal.direction, bbo: { bid: bbo.bestBid!, ask: bbo.bestAsk! }, frictionModel: friction });
  const rawStop = structuralStopForDailyRangeSignal({
    direction: signal.direction,
    rangeHigh: signal.rangeHigh,
    rangeLow: signal.rangeLow,
    confirmationBar1: signal.confirmationBar1,
    confirmationBar2: signal.confirmationBar2,
    entryPolicy: signal.entryPolicy,
    breakoutExtreme: signal.breakoutExtreme,
  });
  if (!expectedEntry || !positive(rawStop)) {
    return {
      ...base,
      newDecision: "REJECTED", newReason: "STOP_ECONOMICS_FAIL",
      stopPct: null, target: null, targetSource: null, targetLevelType: null, targetTimeframe: null,
      grossStructuralRR: null, plannedNotionalUsd: null, expectedLossUsd: null, expectedNetRewardUsd: null, netRewardRisk: null, costRatio: null, tieBreakHash: null,
    };
  }
  try {
    const [oneHourCandles, fourHourCandles] = await Promise.all([
      getKlines({ environment, symbol: signal.symbol, interval: "1h", endTime: signal.signalTimestampMs - 1, limit: 256 }),
      getKlines({ environment, symbol: signal.symbol, interval: "4h", endTime: signal.signalTimestampMs - 1, limit: 128 }),
    ]);
    const target = resolveDailyRangeStructuralTarget({
      direction: signal.direction,
      route: signal.entryPolicy!,
      expectedEntry,
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      referenceRangeCloseTime: signal.referenceRangeCloseTime,
      decisionAtMs: signal.signalTimestampMs,
      oneHourCandles,
      fourHourCandles,
    });
    if (!target.ok) {
      return {
        ...base,
        newDecision: "REJECTED", newReason: target.reason,
        stopPct: Math.abs(expectedEntry - rawStop) / expectedEntry, target: null, targetSource: null, targetLevelType: null, targetTimeframe: null,
        grossStructuralRR: null, plannedNotionalUsd: null, expectedLossUsd: null, expectedNetRewardUsd: null, netRewardRisk: null, costRatio: null, tieBreakHash: null,
      };
    }
    const prepared = prepareDailyRangeEconomics({
      side: signal.direction,
      route: signal.entryPolicy!,
      symbol: signal.symbol,
      batchTimestampMs: signal.signalTimestampMs,
      rawStructuralStop: rawStop,
      stopSource: dailyRangeStructuralStopSource(signal.entryPolicy!),
      structuralTarget: target.target,
      bbo: {
        bid: bbo.bestBid!,
        ask: bbo.bestAsk!,
        observedAt,
        receivedAt: bbo.bookReceivedAt ?? observedAt,
        sourceTime: bbo.bookSourceTime ?? observedAtMs,
      },
      filter,
      frictionModel: friction,
      bboMaxAgeMs: 60_000,
      allocationAtMs: Math.max(signal.signalTimestampMs, observedAtMs) + 1_000,
      atr4hFeature: calculateCausalAtr14({ candles: fourHourCandles, decisionAtMs: signal.signalTimestampMs }),
    });
    if (!prepared.ok) {
      return {
        ...base,
        newDecision: "REJECTED", newReason: prepared.reason,
        stopPct: Math.abs(expectedEntry - rawStop) / expectedEntry,
        target: target.target.target, targetSource: target.target.targetSource, targetLevelType: target.target.targetLevelType, targetTimeframe: target.target.targetSourceTimeframe,
        grossStructuralRR: null, plannedNotionalUsd: null, expectedLossUsd: null, expectedNetRewardUsd: null, netRewardRisk: null, costRatio: null, tieBreakHash: null,
      };
    }
    const economics = prepared.economics;
    const liveShadow = environment === "mainnet" && signal.entryPolicy === "CONTINUATION";
    return {
      ...base,
      newDecision: liveShadow ? "LIVE_CONTINUATION_SHADOW" : "EXECUTION_CANDIDATE",
      newReason: liveShadow ? "LIVE_CONTINUATION_EXECUTION_DISABLED" : null,
      stopPct: economics.stopPct,
      target: economics.structuralTarget,
      targetSource: economics.targetSource,
      targetLevelType: economics.targetLevelType,
      targetTimeframe: economics.targetSourceTimeframe,
      grossStructuralRR: economics.grossStructuralRR,
      plannedNotionalUsd: economics.plannedNotionalUsd,
      expectedLossUsd: economics.expectedLossUsd,
      expectedNetRewardUsd: economics.expectedNetRewardUsd,
      netRewardRisk: economics.netRewardRisk,
      costRatio: economics.costRatio,
      tieBreakHash: dailyRangeEconomicTieBreakHash({
        strategyPolicyId: economics.allocatorPolicyId,
        batchTimestampMs: signal.signalTimestampMs,
        symbol: signal.symbol,
        side: signal.direction,
        route: signal.entryPolicy!,
      }),
    };
  } catch (error) {
    return {
      ...base,
      newDecision: "UNAVAILABLE",
      newReason: error instanceof Error ? `PUBLIC_HISTORY_UNAVAILABLE: ${error.message}` : "PUBLIC_HISTORY_UNAVAILABLE",
      stopPct: Math.abs(expectedEntry - rawStop) / expectedEntry,
      target: null, targetSource: null, targetLevelType: null, targetTimeframe: null,
      grossStructuralRR: null, plannedNotionalUsd: null, expectedLossUsd: null, expectedNetRewardUsd: null, netRewardRisk: null, costRatio: null, tieBreakHash: null,
    };
  }
}

async function main(): Promise<void> {
  const [statePath, environmentArg] = process.argv.slice(2);
  if (!statePath || (environmentArg !== "mainnet" && environmentArg !== "testnet")) {
    throw new Error("usage: tsx scripts/replay-daily-structural-sr-v1.ts <state.json> <mainnet|testnet>");
  }
  const environment = environmentArg as Environment;
  const state = JSON.parse(await readFile(statePath, "utf8")) as StoredState;
  const finalizedSignalIds = new Set<string>();
  const candidateDecisions = new Map<string, StoredCandidateDecision>();
  for (const cohort of state.signalCohorts ?? []) {
    const finalized = Boolean(cohort.finalizedAt ?? cohort.allocation?.finalizedAt);
    for (const candidate of cohort.candidates ?? []) {
      const signalId = candidate.signalId?.trim() ?? "";
      if (!signalId) continue;
      if (candidate.decision) {
        candidateDecisions.set(signalId, {
          entryEligible: candidate.decision.entryEligible ?? null,
          reason: candidate.decision.reason ?? null,
          tradeId: candidate.decision.tradeId ?? null,
          entryAttemptedAt: candidate.decision.entryAttemptedAt ?? null,
        });
      }
      if (finalized) finalizedSignalIds.add(signalId);
    }
  }
  const observedSignals = (state.signals ?? [])
    .filter((signal): signal is StoredSignal => (signal.strategyVersion === "daily-4h-range-auto-route-ny-2r-v2"
        || signal.strategyVersion === "daily-4h-range-auto-route-ny-meme-v3")
      && (signal.entryPolicy === "CONTINUATION" || signal.entryPolicy === "FADE")
      && (signal.direction === "LONG" || signal.direction === "SHORT")
      && positive(signal.rangeHigh) && positive(signal.rangeLow)
      && signal.confirmationBar1 !== null && signal.confirmationBar2 !== null
      && Number.isFinite(signal.signalTimestampMs));
  const unfinalizedExcluded = observedSignals.filter((signal) => !finalizedSignalIds.has(signal.signalId)).length;
  const signals = observedSignals
    .filter((signal) => finalizedSignalIds.has(signal.signalId))
    .sort((left, right) => left.signalTimestampMs - right.signalTimestampMs)
    .slice(-MAX_SIGNALS);
  const filters = await getFilters(environment);
  const rows: ReplayRow[] = [];
  for (const signal of signals) rows.push(await replayOne({ signal, state, environment, filters, candidateDecisions }));
  const summary = {
    environment,
    sourceStrategyVersions: ["daily-4h-range-auto-route-ny-2r-v2", "daily-4h-range-auto-route-ny-meme-v3"],
    sourceSignalsObserved: observedSignals.length,
    sourceSignalsFinalized: observedSignals.length - unfinalizedExcluded,
    unfinalizedExcluded,
    sourceSignalsReplayed: rows.length,
    oldPreallocationEligible: rows.filter((row) => row.oldDecision === "PREALLOCATION_ELIGIBLE").length,
    newStructuralEligible: rows.filter((row) => row.newDecision === "EXECUTION_CANDIDATE" || row.newDecision === "LIVE_CONTINUATION_SHADOW").length,
    newlyAdmitted: rows.filter((row) => row.oldDecision !== "PREALLOCATION_ELIGIBLE" && (row.newDecision === "EXECUTION_CANDIDATE" || row.newDecision === "LIVE_CONTINUATION_SHADOW")).length,
    stillRejectedOrUnavailable: rows.filter((row) => row.newDecision === "REJECTED" || row.newDecision === "UNAVAILABLE").length,
    oldReasons: sortedCounts(rows.reduce<Record<string, number>>((counts, row) => { addCount(counts, row.oldReason); return counts; }, {})),
    newReasons: sortedCounts(rows.reduce<Record<string, number>>((counts, row) => { addCount(counts, row.newReason); return counts; }, {})),
    byRoute: Object.fromEntries((["FADE", "CONTINUATION"] as const).map((route) => {
      const subset = rows.filter((row) => row.route === route);
      return [route, {
        total: subset.length,
        oldPreallocationEligible: subset.filter((row) => row.oldDecision === "PREALLOCATION_ELIGIBLE").length,
        newExecutionCandidates: subset.filter((row) => row.newDecision === "EXECUTION_CANDIDATE").length,
        liveShadowOnly: subset.filter((row) => row.newDecision === "LIVE_CONTINUATION_SHADOW").length,
        newlyAdmitted: subset.filter((row) => row.oldDecision !== "PREALLOCATION_ELIGIBLE" && (row.newDecision === "EXECUTION_CANDIDATE" || row.newDecision === "LIVE_CONTINUATION_SHADOW")).length,
        rejectedOrUnavailable: subset.filter((row) => row.newDecision === "REJECTED" || row.newDecision === "UNAVAILABLE").length,
      }];
    })),
  };
  process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
}

await main();

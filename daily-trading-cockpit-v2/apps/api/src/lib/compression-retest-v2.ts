/**
 * COMPRESSION IGNITION RETEST V2.
 *
 * Parent COMPRESSION_EXPANSION_IGNITION proves the compression, breakout-volume,
 * and taker-flow gate. This sibling does not enter at the breakout close. It
 * waits a bounded number of closed bars for a non-chasing retest that touches
 * the broken range edge, closes back through it, and confirms direction.
 * Parent and child outcomes remain in separate stores.
 */
import type { Candle } from "@dtc/shared";
import { resolve } from "node:path";

import {
  CE_INTERVAL,
  CE_UNIVERSE,
  CompressionExpansionStore,
  buildCompressionExpansionGeometry,
  buildCompressionExpansionReport,
  resolveCompressionExpansionObservation,
  type CECycleResult,
  type CompressionExpansionObservation,
} from "./compression-expansion-edge.js";

function envNumPos(name: string, dflt: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : dflt;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const CE_V2_LANE_ID = "COMPRESSION_IGNITION_RETEST_FLOW_V2" as const;
export const CE_V2_PARENT_LANE_ID = "COMPRESSION_EXPANSION_IGNITION" as const;
export const CE_V2_RETEST_WINDOW_BARS = envNumPos("COMPRESSION_RETEST_V2_WINDOW_BARS", 4);
export const CE_V2_RETEST_TOLERANCE_BPS = envNumPos("COMPRESSION_RETEST_V2_TOLERANCE_BPS", 12);
export const CE_V2_MAX_EXTENSION_ATR = envNumPos("COMPRESSION_RETEST_V2_MAX_EXTENSION_ATR", 0.5);

export interface CompressionRetestDecision {
  passes: boolean;
  breakoutLevel: number | null;
  extensionAtr: number | null;
  reasons: string[];
}

export function evaluateCompressionRetest(
  parent: CompressionExpansionObservation,
  candle: Candle,
): CompressionRetestDecision {
  const breakoutLevel = parent.direction === "LONG"
    ? parent.compressionRangeHigh ?? null
    : parent.compressionRangeLow ?? null;
  const reasons: string[] = [];
  if (!(breakoutLevel !== null && breakoutLevel > 0)) reasons.push("MISSING_PARENT_RANGE");
  if (!(parent.atrAtBreakout > 0)) reasons.push("MISSING_PARENT_ATR");
  let extensionAtr: number | null = null;
  if (breakoutLevel !== null && breakoutLevel > 0 && parent.atrAtBreakout > 0) {
    extensionAtr = Math.abs(candle.close - breakoutLevel) / parent.atrAtBreakout;
    const tolerance = breakoutLevel * CE_V2_RETEST_TOLERANCE_BPS / 10_000;
    if (parent.direction === "LONG") {
      if (!(candle.low <= breakoutLevel + tolerance)) reasons.push("NO_RANGE_RETEST");
      if (!(candle.close > breakoutLevel)) reasons.push("FAILED_RECLAIM");
      if (!(candle.close > candle.open)) reasons.push("NO_DIRECTIONAL_CLOSE");
    } else {
      if (!(candle.high >= breakoutLevel - tolerance)) reasons.push("NO_RANGE_RETEST");
      if (!(candle.close < breakoutLevel)) reasons.push("FAILED_RECLAIM");
      if (!(candle.close < candle.open)) reasons.push("NO_DIRECTIONAL_CLOSE");
    }
    if (extensionAtr > CE_V2_MAX_EXTENSION_ATR) reasons.push("RETEST_CLOSE_TOO_EXTENDED");
  }
  return { passes: reasons.length === 0, breakoutLevel, extensionAtr, reasons };
}

let singleton: CompressionExpansionStore | null = null;
export function getCompressionRetestV2Store(dataDir = "data"): CompressionExpansionStore {
  if (!singleton) {
    singleton = new CompressionExpansionStore(resolve(dataDir, "compression-retest-v2.json"));
  }
  return singleton;
}

export function _resetCompressionRetestV2StoreForTests(): void {
  singleton = null;
}

export async function runCompressionRetestV2Cycle(opts: {
  store: CompressionExpansionStore;
  parentStore: CompressionExpansionStore;
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  universe?: readonly string[];
}): Promise<CECycleResult> {
  const result: CECycleResult = {
    scanned: 0,
    recorded: 0,
    resolved: 0,
    expired: 0,
    compressionIgnitionCandidates: 0,
    takerFlowRejected: 0,
  };
  const universe = opts.universe ?? CE_UNIVERSE;
  const symbols = new Set([
    ...universe,
    ...opts.parentStore.all.map((o) => o.symbol),
    ...opts.store.all.filter((o) => o.status === "OPEN").map((o) => o.symbol),
  ]);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      // Missing candles cannot fabricate a retest and still reach expiry handling below.
    }
  }

  for (const observation of opts.store.all) {
    if (observation.status !== "OPEN") continue;
    const patch = await resolveCompressionExpansionObservation(
      observation,
      candlesBySymbol.get(observation.symbol) ?? [],
      opts.now,
    );
    if (!patch) continue;
    opts.store.update(observation.observationId, patch);
    if (patch.status === "EXPIRED") result.expired += 1;
    else result.resolved += 1;
  }

  for (const parent of opts.parentStore.all) {
    result.scanned += 1;
    if (!finite(parent.compressionRangeHigh) || !finite(parent.compressionRangeLow)) continue;
    const childPrefix = `cev2:${parent.observationId}:`;
    if (opts.store.all.some((observation) => observation.observationId.startsWith(childPrefix))) continue;
    const future = (candlesBySymbol.get(parent.symbol) ?? [])
      .filter((candle) => candle.openTime > parent.openedAtMs)
      .sort((a, b) => a.openTime - b.openTime)
      .slice(0, CE_V2_RETEST_WINDOW_BARS);
    if (future.length === 0) continue;
    result.compressionIgnitionCandidates += 1;
    const accepted = future
      .map((candle) => ({ candle, decision: evaluateCompressionRetest(parent, candle) }))
      .find((row) => row.decision.passes);
    if (!accepted) {
      result.takerFlowRejected += 1;
      continue;
    }
    const geometry = buildCompressionExpansionGeometry(
      parent.direction,
      accepted.candle.close,
      parent.compressionRangeLow,
      parent.compressionRangeHigh,
    );
    if (!geometry) {
      result.takerFlowRejected += 1;
      continue;
    }
    const observationId = `${childPrefix}${accepted.candle.openTime}`;
    const observation: CompressionExpansionObservation = {
      ...geometry,
      observationId,
      symbol: parent.symbol,
      direction: parent.direction,
      openedAt: new Date(accepted.candle.openTime).toISOString(),
      openedAtMs: accepted.candle.openTime,
      atrAtBreakout: parent.atrAtBreakout,
      compressionRangeHigh: parent.compressionRangeHigh,
      compressionRangeLow: parent.compressionRangeLow,
      atrPercentileAtCompression: parent.atrPercentileAtCompression,
      bbWidthPercentileAtCompression: parent.bbWidthPercentileAtCompression,
      volumeRatio: parent.volumeRatio,
      takerBuyRatio: parent.takerBuyRatio,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      maxFavorableR: null,
      exitReason: null,
      resolvedAt: null,
    };
    if (opts.store.add(observation)) result.recorded += 1;
  }

  opts.store.recordCycle(new Date(opts.now).toISOString(), result);
  opts.store.save();
  return result;
}

let cycleInFlight = false;
export async function runCompressionRetestV2CycleGuarded(
  opts: Parameters<typeof runCompressionRetestV2Cycle>[0],
): Promise<CECycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runCompressionRetestV2Cycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      // Report-only failure remains isolated.
    }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function buildCompressionRetestV2Report(store = getCompressionRetestV2Store()) {
  const parentShape = buildCompressionExpansionReport(store.all, store.cycleMeta);
  return {
    ...parentShape,
    laneId: CE_V2_LANE_ID,
    parentLaneId: CE_V2_PARENT_LANE_ID,
    version: "V2" as const,
    thesis: "Enter a flow-confirmed compression breakout only after a bounded range-edge retest and reclaim.",
    signalSource: "PARENT_COMPRESSION_FLOW_SIGNAL + CLOSED_CANDLE_RETEST",
    v2Gate: {
      retestWindowBars: CE_V2_RETEST_WINDOW_BARS,
      toleranceBps: CE_V2_RETEST_TOLERANCE_BPS,
      maxExtensionAtr: CE_V2_MAX_EXTENSION_ATR,
      interval: CE_INTERVAL,
    },
  };
}

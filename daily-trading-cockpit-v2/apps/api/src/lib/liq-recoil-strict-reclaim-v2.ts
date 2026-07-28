/**
 * LIQUIDATION WASHOUT STRICT RECLAIM V2.
 *
 * Parent LIQUIDATION_RECOIL_EVENT enters after a cascade stalls. This sibling
 * waits for a causal reclaim as well: price must recover event-anchored VWAP,
 * retrace a minimum fraction of the cascade, print directional close
 * confirmation, and show a taker-flow flip. The forced-flow evidence and
 * conservative resolver are reused from the parent; observations are isolated.
 */
import type { Candle } from "@dtc/shared";
import { resolve } from "node:path";

import {
  LQR_CANDLE_FETCH_LIMIT,
  LQR_INTERVAL,
  LQR_MAX_OPEN,
  LQR_UNIVERSE,
  LiqRecoilStore,
  buildLiqRecoilGeometry,
  buildLiqRecoilReport,
  detectLiquidationCascade,
  evaluateLiquidationFlowGate,
  resolveLiqRecoilObservation,
  type LiqRecoilObservation,
  type LiquidationCascadeEvent,
  type LqrCycleResult,
  type LqrFlowSample,
} from "./liq-recoil-edge.js";

function envNumPos(name: string, dflt: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : dflt;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const LQR_V2_LANE_ID = "LIQUIDATION_WASHOUT_STRICT_RECLAIM_V2" as const;
export const LQR_V2_PARENT_LANE_ID = "LIQUIDATION_RECOIL_EVENT" as const;
export const LQR_V2_MIN_RETRACE_FRAC = envNumPos("LIQ_RECOIL_V2_MIN_RETRACE_FRAC", 0.25);
export const LQR_V2_TARGET_RETRACE_FRAC = envNumPos("LIQ_RECOIL_V2_TARGET_RETRACE_FRAC", 1);
export const LQR_V2_FLOW_FLIP_RATIO = envNumPos("LIQ_RECOIL_V2_FLOW_FLIP_RATIO", 1.05);

export interface StrictReclaimDecision {
  passes: boolean;
  anchoredVwap: number | null;
  reclaimLevel: number;
  latestTakerRatio: number | null;
  reasons: string[];
}

function eventAnchoredVwap(candles: readonly Candle[], event: LiquidationCascadeEvent): number | null {
  const rows = candles.filter(
    (c) =>
      c.openTime >= event.windowStartMs &&
      c.openTime <= event.lastBarOpenTime &&
      finite(c.volume) &&
      c.volume > 0,
  );
  const volume = rows.reduce((sum, candle) => sum + candle.volume, 0);
  if (!(volume > 0)) return null;
  return rows.reduce(
    (sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume,
    0,
  ) / volume;
}

export function evaluateStrictReclaim(opts: {
  candles: readonly Candle[];
  event: LiquidationCascadeEvent;
  flowSamples: readonly LqrFlowSample[];
  minRetraceFrac?: number;
  flowFlipRatio?: number;
}): StrictReclaimDecision {
  const sorted = [...opts.candles].sort((a, b) => a.openTime - b.openTime);
  const last = sorted.at(-1);
  const previous = sorted.at(-2);
  const anchoredVwap = eventAnchoredVwap(sorted, opts.event);
  const minRetraceFrac = opts.minRetraceFrac ?? LQR_V2_MIN_RETRACE_FRAC;
  const flowFlipRatio = opts.flowFlipRatio ?? LQR_V2_FLOW_FLIP_RATIO;
  const reclaimLevel = opts.event.cascadeDirection === "DOWN"
    ? opts.event.extremePrice + minRetraceFrac * opts.event.cascadeRange
    : opts.event.extremePrice - minRetraceFrac * opts.event.cascadeRange;
  const latestFlow = [...opts.flowSamples]
    .filter((sample) => sample.atMs >= opts.event.extremeBarOpenTime && finite(sample.takerBuySellRatio))
    .sort((a, b) => b.atMs - a.atMs)
    .at(0);
  const latestTakerRatio = latestFlow?.takerBuySellRatio ?? null;
  const reasons: string[] = [];
  if (!last || !previous) reasons.push("MISSING_CONFIRMATION_CANDLES");
  if (anchoredVwap === null) reasons.push("MISSING_EVENT_VWAP");
  if (latestTakerRatio === null) reasons.push("MISSING_FLOW_FLIP");

  if (last && previous && anchoredVwap !== null) {
    if (opts.event.recoilDirection === "LONG") {
      if (!(last.close > anchoredVwap)) reasons.push("VWAP_NOT_RECLAIMED");
      if (!(last.close >= reclaimLevel)) reasons.push("MIN_RETRACE_NOT_REACHED");
      if (!(last.close > previous.close && last.close > last.open)) reasons.push("NO_BULLISH_CLOSE_CONFIRMATION");
      if (!(latestTakerRatio !== null && latestTakerRatio >= flowFlipRatio)) reasons.push("TAKER_FLOW_NOT_FLIPPED_LONG");
    } else {
      if (!(last.close < anchoredVwap)) reasons.push("VWAP_NOT_RECLAIMED");
      if (!(last.close <= reclaimLevel)) reasons.push("MIN_RETRACE_NOT_REACHED");
      if (!(last.close < previous.close && last.close < last.open)) reasons.push("NO_BEARISH_CLOSE_CONFIRMATION");
      if (!(latestTakerRatio !== null && latestTakerRatio <= 1 / flowFlipRatio)) reasons.push("TAKER_FLOW_NOT_FLIPPED_SHORT");
    }
  }
  return { passes: reasons.length === 0, anchoredVwap, reclaimLevel, latestTakerRatio, reasons };
}

let singleton: LiqRecoilStore | null = null;
export function getLiqRecoilStrictReclaimV2Store(dataDir = "data"): LiqRecoilStore {
  if (!singleton) {
    singleton = new LiqRecoilStore(resolve(dataDir, "liq-recoil-strict-reclaim-v2.json"));
  }
  return singleton;
}

export function _resetLiqRecoilStrictReclaimV2StoreForTests(): void {
  singleton = null;
}

export async function runLiqRecoilStrictReclaimV2Cycle(opts: {
  store: LiqRecoilStore;
  parentStore: LiqRecoilStore;
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  universe?: readonly string[];
}): Promise<LqrCycleResult> {
  const result: LqrCycleResult = {
    scanned: 0,
    flowSampled: 0,
    skippedNoCandles: 0,
    eventsDetected: 0,
    ambiguous: 0,
    skippedDuplicate: 0,
    skippedNoFlowData: 0,
    skippedFlowGate: 0,
    skippedAlreadyRecoiled: 0,
    skippedOpenCap: 0,
    entered: 0,
    resolved: 0,
    expired: 0,
    lastEventSymbol: null,
    lastEventCascadeDirection: null,
  };
  const universe = opts.universe ?? LQR_UNIVERSE;
  const symbols = new Set([
    ...universe,
    ...opts.store.all.filter((o) => o.status === "OPEN").map((o) => o.symbol),
  ]);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      // Missing candles cannot pass entry and still reach the parent's expiry fallback.
    }
  }

  for (const observation of opts.store.all) {
    if (observation.status !== "OPEN") continue;
    const patch = resolveLiqRecoilObservation(
      observation,
      candlesBySymbol.get(observation.symbol) ?? [],
      opts.now,
    );
    if (!patch) continue;
    opts.store.update(observation.observationId, patch);
    if (patch.status === "EXPIRED") result.expired += 1;
    else result.resolved += 1;
  }

  let openCount = opts.store.all.filter((observation) => observation.status === "OPEN").length;
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) {
      result.skippedNoCandles += 1;
      continue;
    }
    const detection = detectLiquidationCascade(candles);
    if (!detection.evaluated) {
      result.skippedNoCandles += 1;
      continue;
    }
    if (detection.ambiguous) {
      result.ambiguous += 1;
      continue;
    }
    const event = detection.event;
    if (!event) continue;
    result.eventsDetected += 1;
    result.lastEventSymbol = symbol;
    result.lastEventCascadeDirection = event.cascadeDirection;

    const observationId = `lqrv2:${event.recoilDirection.toLowerCase()}:${symbol}:${event.extremeBarOpenTime}`;
    if (
      opts.store.has(observationId) ||
      opts.store.all.some((o) => o.symbol === symbol && o.direction === event.recoilDirection && o.status === "OPEN")
    ) {
      result.skippedDuplicate += 1;
      continue;
    }

    const flowSamples = opts.parentStore.flowSamples(symbol);
    const forcedFlow = evaluateLiquidationFlowGate(
      flowSamples,
      event.windowStartMs,
      opts.now,
      event.cascadeDirection,
    );
    if (!forcedFlow.hasOiData) {
      result.skippedNoFlowData += 1;
      continue;
    }
    if (!forcedFlow.passes) {
      result.skippedFlowGate += 1;
      continue;
    }
    const reclaim = evaluateStrictReclaim({ candles, event, flowSamples });
    if (!reclaim.passes) {
      result.skippedAlreadyRecoiled += 1;
      continue;
    }
    if (openCount >= LQR_MAX_OPEN) {
      result.skippedOpenCap += 1;
      continue;
    }

    const geometry = buildLiqRecoilGeometry(
      event.lastClose,
      event.recoilDirection,
      event.extremePrice,
      event.cascadeRange,
      { targetRetraceFrac: LQR_V2_TARGET_RETRACE_FRAC },
    );
    if (!geometry.ok) {
      result.skippedAlreadyRecoiled += 1;
      continue;
    }
    const fundingSamples = flowSamples.filter((sample) => finite(sample.fundingBps));
    const observation: LiqRecoilObservation = {
      ...geometry.geometry,
      observationId,
      symbol,
      direction: event.recoilDirection,
      cascadeDirection: event.cascadeDirection,
      openedAt: new Date(opts.now).toISOString(),
      openedAtMs: opts.now,
      cascadeReturn: event.cascadeReturn,
      atrMultipleAtEntry: event.atrMultiple,
      stallBarsAtEntry: event.stallBars,
      extremePrice: event.extremePrice,
      extremeBarOpenTime: event.extremeBarOpenTime,
      preCascadeClose: event.preCascadeClose,
      worstOiChangePercent: forcedFlow.worstOiChangePercent,
      takerRatioAtWorst: forcedFlow.takerRatioAtWorst,
      fundingBpsAtEntry: fundingSamples.at(-1)?.fundingBps ?? null,
      flowSamplesInWindow: forcedFlow.samplesInWindow,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    };
    if (opts.store.add(observation)) {
      result.entered += 1;
      openCount += 1;
    }
  }

  opts.store.recordCycle(new Date(opts.now).toISOString(), result);
  opts.store.save();
  return result;
}

let cycleInFlight = false;
export async function runLiqRecoilStrictReclaimV2CycleGuarded(
  opts: Parameters<typeof runLiqRecoilStrictReclaimV2Cycle>[0],
): Promise<LqrCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runLiqRecoilStrictReclaimV2Cycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      // Report-only failure stays isolated.
    }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function buildLiqRecoilStrictReclaimV2Report(store = getLiqRecoilStrictReclaimV2Store()) {
  const parentShape = buildLiqRecoilReport(store.all, store.cycleMeta);
  const cycleMeta = parentShape.cycleMeta
    ? {
        ...parentShape.cycleMeta,
        candidatesTotal: parentShape.cycleMeta.eventsDetectedTotal,
        recordedTotal: parentShape.cycleMeta.enteredTotal,
        rejectedTotal:
          parentShape.cycleMeta.ambiguousTotal +
          parentShape.cycleMeta.skippedNoFlowDataTotal +
          parentShape.cycleMeta.skippedFlowGateTotal +
          parentShape.cycleMeta.skippedAlreadyRecoiledTotal,
      }
    : null;
  const v2Gate = {
    minRetraceFrac: LQR_V2_MIN_RETRACE_FRAC,
    targetRetraceFrac: LQR_V2_TARGET_RETRACE_FRAC,
    flowFlipRatio: LQR_V2_FLOW_FLIP_RATIO,
    candleFetchLimit: LQR_CANDLE_FETCH_LIMIT,
    interval: LQR_INTERVAL,
  };
  return {
    ...parentShape,
    cycleMeta,
    laneId: LQR_V2_LANE_ID,
    parentLaneId: LQR_V2_PARENT_LANE_ID,
    version: "V2" as const,
    thesis: "Fade a forced liquidation cascade only after event-VWAP, retrace, candle, and taker-flow reclaim.",
    signalSource: "OI_TAKER_FLOW_PROXY + CLOSED_CANDLE_EVENT_VWAP_RECLAIM",
    v2Gate,
    params: {
      ...parentShape.params,
      ...v2Gate,
    },
  };
}

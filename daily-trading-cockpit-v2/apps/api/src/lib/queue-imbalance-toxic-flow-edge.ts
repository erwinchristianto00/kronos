/**
 * QUEUE IMBALANCE + TOXIC FLOW (shadow signal lane).
 *
 * Binance REST depth is a point-in-time L2 snapshot. It can measure depth
 * imbalance but cannot prove order-level queue position, cancels, or maker fill.
 * This lane therefore records directional next-snapshot markout only. It uses
 * aggregate taker flow, spread, and expected taker slippage to reject obviously
 * toxic/untradeable snapshots. No fill simulation and no execution authority.
 */
import { resolve } from "node:path";

import type { BinanceClient } from "./binance.js";
import {
  buildMicrostructureSnapshot,
  type MicrostructureSnapshot,
} from "./order-flow-microstructure.js";
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

export const QITF_LANE_ID = "QUEUE_IMBALANCE_TOXIC_FLOW" as const;
export const QITF_UNIVERSE: readonly string[] = (
  process.env.QUEUE_IMBALANCE_TOXIC_FLOW_UNIVERSE ?? "BTCUSDT,ETHUSDT,SOLUSDT"
)
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
export const QITF_DEPTH_LEVELS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_DEPTH_LEVELS", 20);
export const QITF_DEPTH_WINDOW_BPS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_DEPTH_WINDOW_BPS", 10);
export const QITF_MIN_ABS_IMBALANCE = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MIN_ABS_IMBALANCE", 0.15);
export const QITF_MIN_TAKER_RATIO = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MIN_TAKER_RATIO", 0.58);
export const QITF_MAX_SPREAD_BPS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MAX_SPREAD_BPS", 4);
export const QITF_MAX_SLIPPAGE_BPS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MAX_SLIPPAGE_BPS", 8);
export const QITF_MAX_TOXICITY_PROXY = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MAX_TOXICITY_PROXY", 0.75);
export const QITF_MARKOUT_HORIZON_MS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_MARKOUT_MS", 5 * 60_000);
export const QITF_STALE_AFTER_MS = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_STALE_MS", 60 * 60_000);
export const QITF_RISK_RETURN = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_RISK_RETURN", 0.0035);
export const QITF_NOTIONAL_USD = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_NOTIONAL_USD", 50);
export const QITF_AGGTRADE_LIMIT = envNumPos("QUEUE_IMBALANCE_TOXIC_FLOW_AGGTRADE_LIMIT", 500);

export type QitfDirection = "LONG" | "SHORT";

export interface ToxicFlowAssessment {
  direction: QitfDirection | null;
  toxicityProxy: number | null;
  passes: boolean;
  reasons: string[];
}

export function assessQueueImbalanceToxicFlow(snapshot: MicrostructureSnapshot): ToxicFlowAssessment {
  const imbalance = snapshot.depthImbalance?.imbalance ?? null;
  const takerBuyRatio = snapshot.takerFlow.takerBuyRatio;
  const reasons: string[] = [];
  if (!finite(imbalance)) reasons.push("MISSING_DEPTH_IMBALANCE");
  if (!finite(takerBuyRatio)) reasons.push("MISSING_TAKER_FLOW");
  if (!finite(snapshot.spreadBps)) reasons.push("MISSING_SPREAD");
  if (finite(imbalance) && Math.abs(imbalance) < QITF_MIN_ABS_IMBALANCE) reasons.push("IMBALANCE_TOO_SMALL");

  let direction: QitfDirection | null = null;
  if (finite(imbalance) && finite(takerBuyRatio)) {
    if (imbalance > 0 && takerBuyRatio >= QITF_MIN_TAKER_RATIO) direction = "LONG";
    else if (imbalance < 0 && takerBuyRatio <= 1 - QITF_MIN_TAKER_RATIO) direction = "SHORT";
    else reasons.push("BOOK_AND_TAKER_FLOW_DISAGREE");
  }
  const slippage = direction === "LONG"
    ? snapshot.expectedSlippageBpsBuy
    : direction === "SHORT"
      ? snapshot.expectedSlippageBpsSell
      : null;
  if (finite(snapshot.spreadBps) && snapshot.spreadBps > QITF_MAX_SPREAD_BPS) reasons.push("SPREAD_TOO_WIDE");
  if (!finite(slippage)) reasons.push("UNFILLABLE_REFERENCE_NOTIONAL");
  else if (slippage > QITF_MAX_SLIPPAGE_BPS) reasons.push("SLIPPAGE_TOO_HIGH");

  let toxicityProxy: number | null = null;
  if (finite(takerBuyRatio) && finite(snapshot.spreadBps) && finite(slippage)) {
    const flowExtremity = Math.min(1, Math.abs(takerBuyRatio - 0.5) * 2);
    const spreadPenalty = Math.min(1, snapshot.spreadBps / QITF_MAX_SPREAD_BPS);
    const slippagePenalty = Math.min(1, slippage / QITF_MAX_SLIPPAGE_BPS);
    toxicityProxy = 0.4 * flowExtremity + 0.3 * spreadPenalty + 0.3 * slippagePenalty;
    if (toxicityProxy > QITF_MAX_TOXICITY_PROXY) reasons.push("TOXICITY_PROXY_TOO_HIGH");
  }
  return { direction, toxicityProxy, passes: direction !== null && reasons.length === 0, reasons };
}

export interface QueueImbalanceToxicFlowObservation extends InnovationObservationBase {
  symbol: string;
  direction: QitfDirection;
  entryMid: number;
  depthImbalance: number;
  takerBuyRatio: number;
  tradeCount: number;
  spreadBps: number;
  expectedSlippageBps: number;
  toxicityProxy: number;
  markoutHorizonMs: number;
  exitMid: number | null;
  directionalReturn: number | null;
  netReturn: number | null;
}

export function resolveQueueImbalanceToxicFlowObservation(
  observation: QueueImbalanceToxicFlowObservation,
  currentMid: number | null,
  now: number,
): Partial<QueueImbalanceToxicFlowObservation> | null {
  if (now - observation.openedAtMs < observation.markoutHorizonMs) return null;
  if (!(currentMid !== null && currentMid > 0)) {
    if (now - observation.openedAtMs > QITF_STALE_AFTER_MS) {
      return { status: "EXPIRED", resolvedAt: new Date(now).toISOString() };
    }
    return null;
  }
  const rawReturn = currentMid / observation.entryMid - 1;
  const directionalReturn = observation.direction === "LONG" ? rawReturn : -rawReturn;
  const costReturn = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / 10_000;
  const netReturn = directionalReturn - costReturn;
  const grossR = directionalReturn / QITF_RISK_RETURN;
  const costR = costReturn / QITF_RISK_RETURN;
  const netR = netReturn / QITF_RISK_RETURN;
  return {
    status: netR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    exitMid: currentMid,
    directionalReturn,
    netReturn,
    grossR,
    costR,
    netR,
    exitReason: "NEXT_SNAPSHOT_MARKOUT",
    resolvedAt: new Date(now).toISOString(),
  };
}

let singleton: InnovationShadowStore<QueueImbalanceToxicFlowObservation> | null = null;
export function getQueueImbalanceToxicFlowStore(dataDir = "data") {
  if (!singleton) {
    singleton = new InnovationShadowStore<QueueImbalanceToxicFlowObservation>(
      resolve(dataDir, "queue-imbalance-toxic-flow.json"),
      1_000,
    );
  }
  return singleton;
}

export function _resetQueueImbalanceToxicFlowStoreForTests(): void {
  singleton = null;
}

export async function runQueueImbalanceToxicFlowCycle(opts: {
  store: InnovationShadowStore<QueueImbalanceToxicFlowObservation>;
  client: Pick<BinanceClient, "getFuturesAggTrades" | "getFuturesDepth" | "getFuturesBookTicker">;
  now: number;
  universe?: readonly string[];
}): Promise<InnovationCycleResult> {
  const result: InnovationCycleResult = {
    scanned: 0,
    candidates: 0,
    recorded: 0,
    resolved: 0,
    expired: 0,
    rejected: 0,
  };
  const universe = opts.universe ?? QITF_UNIVERSE;
  const snapshots = new Map<string, MicrostructureSnapshot>();
  for (const symbol of universe) {
    result.scanned += 1;
    try {
      const [trades, depthPayload, book] = await Promise.all([
        opts.client.getFuturesAggTrades(symbol, { limit: QITF_AGGTRADE_LIMIT }),
        opts.client.getFuturesDepth(symbol, QITF_DEPTH_LEVELS),
        opts.client.getFuturesBookTicker(symbol),
      ]);
      snapshots.set(symbol, buildMicrostructureSnapshot({
        symbol,
        capturedAtMs: opts.now,
        trades,
        depthPayload,
        bestBid: book.bid,
        bestAsk: book.ask,
        depthBpsWindow: QITF_DEPTH_WINDOW_BPS,
        sizeNotionalUsd: QITF_NOTIONAL_USD,
      }));
    } catch {
      result.rejected += 1;
    }
  }

  for (const observation of opts.store.all) {
    if (observation.status !== "OPEN") continue;
    const currentMid = snapshots.get(observation.symbol)?.depthImbalance?.midPrice ?? null;
    const patch = resolveQueueImbalanceToxicFlowObservation(observation, currentMid, opts.now);
    if (!patch) continue;
    opts.store.update(observation.observationId, patch);
    if (patch.status === "EXPIRED") result.expired += 1;
    else result.resolved += 1;
  }

  for (const [symbol, snapshot] of snapshots) {
    const assessment = assessQueueImbalanceToxicFlow(snapshot);
    if (!assessment.passes || assessment.direction === null || assessment.toxicityProxy === null) {
      result.rejected += 1;
      continue;
    }
    result.candidates += 1;
    const alreadyOpen = opts.store.all.some(
      (observation) => observation.symbol === symbol && observation.status === "OPEN",
    );
    if (alreadyOpen) continue;
    const entryMid = snapshot.depthImbalance?.midPrice;
    const imbalance = snapshot.depthImbalance?.imbalance;
    const takerBuyRatio = snapshot.takerFlow.takerBuyRatio;
    const expectedSlippage = assessment.direction === "LONG"
      ? snapshot.expectedSlippageBpsBuy
      : snapshot.expectedSlippageBpsSell;
    if (
      !finite(entryMid) ||
      !finite(imbalance) ||
      !finite(takerBuyRatio) ||
      !finite(snapshot.spreadBps) ||
      !finite(expectedSlippage)
    ) {
      result.rejected += 1;
      continue;
    }
    const bucket = Math.floor(opts.now / QITF_MARKOUT_HORIZON_MS) * QITF_MARKOUT_HORIZON_MS;
    const observation: QueueImbalanceToxicFlowObservation = {
      observationId: `qitf:${symbol}:${assessment.direction.toLowerCase()}:${bucket}`,
      symbol,
      direction: assessment.direction,
      openedAt: new Date(opts.now).toISOString(),
      openedAtMs: opts.now,
      entryMid,
      depthImbalance: imbalance,
      takerBuyRatio,
      tradeCount: snapshot.takerFlow.tradeCount,
      spreadBps: snapshot.spreadBps,
      expectedSlippageBps: expectedSlippage,
      toxicityProxy: assessment.toxicityProxy,
      markoutHorizonMs: QITF_MARKOUT_HORIZON_MS,
      exitMid: null,
      directionalReturn: null,
      netReturn: null,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
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
export async function runQueueImbalanceToxicFlowCycleGuarded(
  opts: Parameters<typeof runQueueImbalanceToxicFlowCycle>[0],
): Promise<InnovationCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runQueueImbalanceToxicFlowCycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      // Shadow liveness bookkeeping cannot affect any caller.
    }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function buildQueueImbalanceToxicFlowReport(store = getQueueImbalanceToxicFlowStore()) {
  return buildInnovationShadowReport({
    laneId: QITF_LANE_ID,
    parentLaneId: null,
    version: "V1",
    thesis: "Predict short-horizon markout only when L2 depth and realized taker flow agree and liquidity is not toxic.",
    signalSource: "BINANCE_REST_L2_DEPTH + AGGTRADES_TOXICITY_PROXY; NO_QUEUE_POSITION_OR_FILL_MODEL",
    store,
    details: {
      universe: QITF_UNIVERSE,
      minAbsImbalance: QITF_MIN_ABS_IMBALANCE,
      minDirectionalTakerRatio: QITF_MIN_TAKER_RATIO,
      maxSpreadBps: QITF_MAX_SPREAD_BPS,
      maxSlippageBps: QITF_MAX_SLIPPAGE_BPS,
      maxToxicityProxy: QITF_MAX_TOXICITY_PROXY,
      markoutHorizonMs: QITF_MARKOUT_HORIZON_MS,
      costBps: REALISTIC_ROUND_TRIP_FEE_SLIP_BPS,
      executionAssumption: "NONE_SIGNAL_MARKOUT_ONLY",
    },
    recent: (observation) => ({
      symbol: observation.symbol,
      direction: observation.direction,
      depthImbalance: observation.depthImbalance,
      takerBuyRatio: observation.takerBuyRatio,
      toxicityProxy: observation.toxicityProxy,
      netR: observation.netR,
      status: observation.status,
      openedAt: observation.openedAt,
    }),
  });
}

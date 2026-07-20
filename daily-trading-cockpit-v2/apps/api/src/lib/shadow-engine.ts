import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildVariantSelection,
  buildTradePlan,
  buildStrategyContextSnapshot,
  round,
  type Candle,
  type Candidate,
  type ExecutionEntryVariant,
  type PerformanceStats,
  type ScanResult,
  type ShadowCloseReason,
  type ShadowExecutionEvent,
  type ShadowExecutionSummary,
  type ShadowPosition,
  type ShadowPositionVariant,
  type ShadowScopePerformance,
  type ShadowStateSnapshot,
  type ShadowVariantPerformance,
  type ShadowVariantPosition,
  type SignalFamily,
} from "@dtc/shared";

import type { BinanceClient } from "./binance.js";
import type { DecisionLedger, DecisionLedgerBase } from "./decision-ledger.js";
import { classifyReflection } from "./reflection-agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(__dirname, "../../../../data");
const DUPLICATE_WINDOW_MINUTES = 60;
const DUPLICATE_WINDOW_MS = DUPLICATE_WINDOW_MINUTES * 60 * 1000;
const ENTRY_ZONE_TOLERANCE_RATIO = 0.003;
const MIN_ENTRY_ZONE_TOLERANCE = 0.00000001;
const FEE_BPS_PER_SIDE = 8;
const SLIPPAGE_BPS_PER_SIDE = 6;
export const REALISTIC_FEE_BPS_PER_SIDE = 5; // Binance USD-M Futures VIP 0 taker, per public fee schedule
export const REALISTIC_SLIPPAGE_BPS_PER_SIDE = 6;
export const REALISTIC_ROUND_TRIP_FEE_SLIP_BPS = (REALISTIC_FEE_BPS_PER_SIDE + REALISTIC_SLIPPAGE_BPS_PER_SIDE) * 2; // = 22
/**
 * Policy version marking that costR and grossR share the same entry-price
 * anchor. For base_current_entry that anchor is the scan-time currentPrice;
 * for all other variants it is the variant anchor (vwap, fib_500, etc.).
 * Legacy positions without this field predate the Phase 2 patch.
 */
export const BASE_ROUTE_POLICY_VERSION_V2 = "base-route-anchor-consistent-v2";
const ACTIVE_POSITION_MAX_MS = 24 * 60 * 60 * 1000;
const MIN_ADMISSION_STOP_DISTANCE_BPS = 175;
/** Exported for use by the risk hygiene monitor to identify current-guard tape. */
export const MIN_ADMISSION_STOP_DISTANCE_BPS_EXPORT = MIN_ADMISSION_STOP_DISTANCE_BPS;
export const STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK = "STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK";
export const RISK_HYGIENE_GUARD_V1 = "base-route-risk-hygiene-stop175-v1";
const VARIANTS: ShadowPositionVariant[] = [
  "tp1_full_exit",
  "tp1_50_tp2_runner",
  "tp1_70_runner30",
  "trail_after_tp1",
  "kronos_runner_exit",
  "kronos_flip_exit",
  "whale_conflict_exit",
  "vwap_loss_exit",
];

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, file);
}

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

const SHADOW_MAX_STORED_POSITIONS = envNum("SHADOW_MAX_STORED_POSITIONS", 2000);

/** A position is settled once every variant has finished its own lifecycle (CLOSED, including NO_FILL). */
function isPositionSettled(position: ShadowPosition): boolean {
  return position.variants.every((variant) => variant.state === "CLOSED");
}

function prunePositions(positions: ShadowPosition[]): ShadowPosition[] {
  if (positions.length <= SHADOW_MAX_STORED_POSITIONS) return positions;
  const active = positions.filter((p) => !isPositionSettled(p));
  const settled = positions
    .filter((p) => isPositionSettled(p))
    .sort((a, b) => new Date(b.lastEvaluatedAt).getTime() - new Date(a.lastEvaluatedAt).getTime())
    .slice(0, Math.max(0, SHADOW_MAX_STORED_POSITIONS - active.length));
  return [...active, ...settled];
}

function entryZoneTolerance(price: number): number {
  return Math.max(Math.abs(price) * ENTRY_ZONE_TOLERANCE_RATIO, MIN_ENTRY_ZONE_TOLERANCE);
}

function roundEntryValue(value: number, price: number): number {
  const step = entryZoneTolerance(price);
  return Math.round(value / step) * step;
}

function normalizeEntryZone(entryZone: [number, number] | null, price: number): string {
  if (!entryZone) return "NO_ENTRY";
  return `${roundEntryValue(entryZone[0], price).toFixed(8)}:${roundEntryValue(entryZone[1], price).toFixed(8)}`;
}

function determineSignalFamily(candidate: Candidate): SignalFamily {
  const fiveMinute = candidate.indicators.fiveMinute;
  const oneHour = candidate.indicators.oneHour;
  if (fiveMinute.breakoutHigh || fiveMinute.breakoutLow) return "BREAKOUT";
  if (candidate.finalStatus === "WAIT") return "PULLBACK";
  if (
    (candidate.finalDirection === "LONG" && oneHour.trend === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && oneHour.trend === "BEARISH")
  ) {
    return "TREND_CONTINUATION";
  }
  return "ROTATION_SETUP";
}

function buildIdeaKey(candidate: Candidate, entryZone: [number, number] | null, entryPrice: number, selectedEntryVariant: ExecutionEntryVariant, selectedExitVariant: ShadowPositionVariant): string {
  return [candidate.symbol, candidate.finalDirection, selectedEntryVariant, selectedExitVariant, normalizeEntryZone(entryZone, entryPrice), determineSignalFamily(candidate)].join("|");
}

function buildMarketIdeaKey(candidate: Candidate, entryZone: [number, number] | null, entryPrice: number): string {
  return [candidate.symbol, candidate.finalDirection, normalizeEntryZone(entryZone, entryPrice), determineSignalFamily(candidate)].join("|");
}

function currentPrice(candidate: Candidate): number {
  return candidate.indicators.fiveMinute.latestClose;
}

function entryAnchorForVariant(candidate: Candidate, variant: ExecutionEntryVariant): number | null {
  switch (variant) {
    case "base_current_entry":
      return candidate.indicators.fiveMinute.latestClose;
    case "fib_382_entry":
      return candidate.fibonacci.retracement382;
    case "fib_500_entry":
      return candidate.fibonacci.retracement500;
    case "fib_618_entry":
      return candidate.fibonacci.retracement618;
    case "vwap_retest_entry":
      return candidate.indicators.fiveMinute.vwap;
    case "ema20_pullback_entry":
      return candidate.indicators.fiveMinute.ema20;
    case "no_chase_atr_entry":
      return entryMid(candidate.entryZone) ?? candidate.indicators.fiveMinute.ema20 ?? candidate.indicators.fiveMinute.vwap;
  }
}

function effectiveEntryZone(candidate: Candidate, plan = buildTradePlan(candidate)): [number, number] | null {
  if (candidate.entryZone) return candidate.entryZone;
  const values = [plan.stopLoss, plan.takeProfit1].filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  if (candidate.finalDirection === "LONG") {
    return [candidate.fibonacci.retracement500, candidate.fibonacci.retracement382];
  }
  return [candidate.fibonacci.retracement382, candidate.fibonacci.retracement500];
}

function entryZoneForVariant(candidate: Candidate, selectedEntryVariant: ExecutionEntryVariant, plan = buildTradePlan(candidate)): [number, number] | null {
  if (selectedEntryVariant === "base_current_entry") {
    return effectiveEntryZone(candidate, plan);
  }
  const anchor = entryAnchorForVariant(candidate, selectedEntryVariant);
  const atr = candidate.indicators.fiveMinute.atr14;
  if (anchor === null || !Number.isFinite(anchor)) return effectiveEntryZone(candidate, plan);
  const buffer = Number.isFinite(atr) && atr > 0 ? atr * 0.25 : Math.abs(anchor) * 0.0025;
  return [round(anchor - buffer, 6), round(anchor + buffer, 6)];
}

function entryMid(entryZone: [number, number] | null): number | null {
  return entryZone ? (entryZone[0] + entryZone[1]) / 2 : null;
}

function atrDrift(candidate: Candidate, entryZone: [number, number] | null): number | null {
  const mid = entryMid(entryZone);
  const atr = candidate.indicators.fiveMinute.atr14;
  if (mid === null || !Number.isFinite(mid) || !Number.isFinite(atr) || atr <= 0) return null;
  return Math.abs(currentPrice(candidate) - mid) / atr;
}

function isEntryConditionMet(candidate: Candidate): boolean {
  const plan = buildTradePlan(candidate);
  return (
    (candidate.finalStatus === "TRADE_NOW" || candidate.finalStatus === "READY") &&
    plan.entryAction !== "CANCEL_IF_INVALIDATED" &&
    candidate.stopLoss !== null &&
    candidate.takeProfits.tp1 !== null &&
    (candidate.riskReward ?? 0) >= 1.5 &&
    candidate.dangerScore <= 45
  );
}

function priceInZone(price: number, zone: [number, number] | null): boolean {
  return zone !== null && price >= Math.min(zone[0], zone[1]) && price <= Math.max(zone[0], zone[1]);
}

function candleTouchesLevel(candle: Candle, level: number, direction: "LONG" | "SHORT"): boolean {
  return direction === "LONG" ? candle.low <= level : candle.high >= level;
}

function candleTouchesZone(candle: Candle, zone: [number, number]): boolean {
  const low = Math.min(zone[0], zone[1]);
  const high = Math.max(zone[0], zone[1]);
  return candle.high >= low && candle.low <= high;
}

function entryFillForVariant(
  candidate: Candidate,
  selectedEntryVariant: ExecutionEntryVariant,
  plan = buildTradePlan(candidate),
): { filled: boolean; entryPrice: number; zone: [number, number] | null; reason: string } {
  const price = currentPrice(candidate);
  const zone = entryZoneForVariant(candidate, selectedEntryVariant, plan);
  const anchor = entryAnchorForVariant(candidate, selectedEntryVariant);
  const drift = atrDrift(candidate, zone);

  if (selectedEntryVariant === "base_current_entry") {
    return {
      filled: true,
      entryPrice: price,
      zone,
      reason: "base_current_entry selected; entered at current scan price.",
    };
  }

  if (selectedEntryVariant === "no_chase_atr_entry" && drift !== null && drift <= 0.5) {
    return {
      filled: true,
      entryPrice: price,
      zone,
      reason: `no_chase_atr_entry selected; current price is ${roundMetric(drift)} ATR from the entry zone.`,
    };
  }

  if (priceInZone(price, zone)) {
    return {
      filled: true,
      entryPrice: selectedEntryVariant === "no_chase_atr_entry" ? entryMid(zone) ?? price : anchor ?? entryMid(zone) ?? price,
      zone,
      reason: `${selectedEntryVariant} selected; current price reached the selected entry ${zone ? "zone" : "level"}.`,
    };
  }

  return {
    filled: false,
    entryPrice: anchor ?? entryMid(zone) ?? price,
    zone,
    reason: `${selectedEntryVariant} selected; waiting for price to reach ${zone ? `${roundMetric(Math.min(zone[0], zone[1]))}-${roundMetric(Math.max(zone[0], zone[1]))}` : "the selected entry level"}. Current price ${roundMetric(price)}.`,
  };
}

function hasSimilarEntryZone(existing: [number, number] | null, incoming: [number, number] | null, price: number): boolean {
  if (existing === null && incoming === null) return true;
  if (existing === null || incoming === null) return false;
  const tolerance = entryZoneTolerance(price);
  return Math.abs(existing[0] - incoming[0]) <= tolerance && Math.abs(existing[1] - incoming[1]) <= tolerance;
}

function unrealizedR(direction: "LONG" | "SHORT", entryPrice: number, current: number, stopPrice: number | null): number {
  if (stopPrice === null) return 0;
  const risk = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  const gross = direction === "LONG" ? (current - entryPrice) / risk : (entryPrice - current) / risk;
  return roundMetric(gross);
}

function netRFromGross(entryPrice: number, stopPrice: number | null, gross: number, spreadPercent: number | null | undefined = null): number {
  if (stopPrice === null || entryPrice <= 0) return gross;
  const risk = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(risk) || risk <= 0) return gross;
  const spreadCostPct = spreadPercent !== null && spreadPercent !== undefined && Number.isFinite(spreadPercent) ? spreadPercent : 0;
  const roundTripCostPct = ((FEE_BPS_PER_SIDE + SLIPPAGE_BPS_PER_SIDE) * 2) / 100 + spreadCostPct;
  const riskPct = (risk / entryPrice) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) return gross;
  return roundMetric(gross - roundTripCostPct / riskPct);
}

function costDiagnostics(entryPrice: number, stopPrice: number | null, spreadPercent: number | null | undefined = null) {
  if (stopPrice === null || entryPrice <= 0) {
    return { stopDistanceBps: null, feeSlippageR: null, spreadR: null, costR: null };
  }
  const riskPct = (Math.abs(entryPrice - stopPrice) / entryPrice) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    return { stopDistanceBps: null, feeSlippageR: null, spreadR: null, costR: null };
  }
  const feeSlippagePct = ((FEE_BPS_PER_SIDE + SLIPPAGE_BPS_PER_SIDE) * 2) / 100;
  const spreadPct = spreadPercent !== null && spreadPercent !== undefined && Number.isFinite(spreadPercent) ? spreadPercent : 0;
  const feeSlippageR = roundMetric(feeSlippagePct / riskPct);
  const spreadR = roundMetric(spreadPct / riskPct);
  return {
    stopDistanceBps: roundMetric(riskPct * 100),
    feeSlippageR,
    spreadR,
    costR: roundMetric(feeSlippageR + spreadR),
  };
}

function rAtPrice(direction: "LONG" | "SHORT", entryPrice: number, stopPrice: number | null, exitPrice: number): number {
  if (stopPrice === null) return 0;
  const risk = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  const gross = direction === "LONG" ? (exitPrice - entryPrice) / risk : (entryPrice - exitPrice) / risk;
  return roundMetric(gross);
}

function updatePositionExcursions(position: ShadowPosition, candle: Candle, time: string): void {
  if ((position.entryState ?? "FILLED") !== "FILLED") return;
  const risk = position.stopLoss === null ? null : Math.abs(position.entryPrice - position.stopLoss);
  if (risk === null || !Number.isFinite(risk) || risk <= 0) return;

  // MAE/MFE tracking is analytical only and does not alter execution.
  const favorablePrice = position.direction === "LONG" ? candle.high : candle.low;
  const adversePrice = position.direction === "LONG" ? candle.low : candle.high;
  const favorableR = position.direction === "LONG"
    ? (favorablePrice - position.entryPrice) / risk
    : (position.entryPrice - favorablePrice) / risk;
  const adverseR = position.direction === "LONG"
    ? (position.entryPrice - adversePrice) / risk
    : (adversePrice - position.entryPrice) / risk;

  if (Number.isFinite(favorableR) && favorableR > (position.maxFavorableExcursionR ?? Number.NEGATIVE_INFINITY)) {
    position.maxFavorableExcursionR = roundMetric(Math.max(0, favorableR));
    position.maxFavorablePrice = favorablePrice;
    position.maxFavorableAt = time;
  }
  if (Number.isFinite(adverseR) && adverseR > (position.maxAdverseExcursionR ?? Number.NEGATIVE_INFINITY)) {
    position.maxAdverseExcursionR = roundMetric(Math.max(0, adverseR));
    position.maxAdversePrice = adversePrice;
    position.maxAdverseAt = time;
  }
}

/**
 * Phase 3.1 toxicity-evidence instrumentation — DATA ONLY.
 *
 * Seeds the per-variant R-geometry snapshot at the moment of fill. This must
 * never change exit/scoring behavior: it only persists what the variant *saw*
 * at entry so the toxicity audit can later derive honest MFE/MAE-in-R and
 * forward-path summaries.
 *
 * Idempotent: if entryPriceUsed is already populated, this is a no-op.
 */
function seedVariantInstrumentation(variant: ShadowVariantPosition, position: ShadowPosition): void {
  if (variant.entryPriceUsed !== null && variant.entryPriceUsed !== undefined) return;
  const entry = position.entryPrice;
  const stop = variant.stopPrice ?? position.stopLoss;
  const tp1 = position.tp1;
  if (!Number.isFinite(entry)) return;
  variant.entryPriceUsed = entry;
  variant.stopPriceUsed = stop ?? null;
  variant.tp1PriceUsed = tp1 ?? null;
  const risk = stop !== null && stop !== undefined && Number.isFinite(stop) ? Math.abs(entry - stop) : null;
  variant.initialRiskAbs = risk !== null && Number.isFinite(risk) && risk > 0 ? risk : null;
  if (variant.initialRiskAbs !== null && tp1 !== null && tp1 !== undefined && Number.isFinite(tp1)) {
    const reward = position.direction === "LONG" ? tp1 - entry : entry - tp1;
    variant.tp1RewardAbs = Number.isFinite(reward) ? reward : null;
    variant.tp1RewardR = variant.tp1RewardAbs !== null && variant.initialRiskAbs > 0
      ? roundMetric(variant.tp1RewardAbs / variant.initialRiskAbs)
      : null;
  } else {
    variant.tp1RewardAbs = null;
    variant.tp1RewardR = null;
  }
  // slRiskR is conceptually always -1 when both prices are valid (stop is one R
  // adverse from entry by construction). Persist as -1 when geometry is valid,
  // null otherwise so coverage queries can distinguish.
  variant.slRiskR = variant.initialRiskAbs !== null ? -1 : null;
  // Initialize excursion + path fields so we don't fabricate later — explicit
  // nulls communicate "no candles observed yet".
  variant.mfeAbs = null;
  variant.maeAbs = null;
  variant.mfeR = null;
  variant.maeR = null;
  variant.maxFavorablePrice = null;
  variant.maxAdversePrice = null;
  variant.maxFavorableAt = null;
  variant.maxAdverseAt = null;
  variant.pathStartAt = null;
  variant.pathEndAt = null;
  variant.pathHigh = null;
  variant.pathLow = null;
  variant.resolutionPrice = null;
  variant.pathCandleCount = 0;
  variant.timeToHighMs = null;
  variant.timeToLowMs = null;
}

/**
 * Phase 3.1: updates per-variant excursion + forward-path summary from one
 * 5m candle. Mirrors the LONG/SHORT MAE/MFE convention used by the
 * position-level updatePositionExcursions above:
 *   LONG:  MFE candidate = candle.high - entry; MAE candidate = entry - candle.low.
 *   SHORT: MFE candidate = entry - candle.low;  MAE candidate = candle.high - entry.
 * Excursions are clamped at 0 (favorable-only / adverse-only directions).
 *
 * Analytical only; never influences variant state, scoring, or routing.
 */
function updateVariantInstrumentation(variant: ShadowVariantPosition, position: ShadowPosition, candle: Candle, time: string): void {
  if (variant.entryPriceUsed === null || variant.entryPriceUsed === undefined) return;
  const entry = variant.entryPriceUsed;
  const risk = variant.initialRiskAbs;
  const favorablePrice = position.direction === "LONG" ? candle.high : candle.low;
  const adversePrice = position.direction === "LONG" ? candle.low : candle.high;
  const favorableAbs = position.direction === "LONG" ? candle.high - entry : entry - candle.low;
  const adverseAbs = position.direction === "LONG" ? entry - candle.low : candle.high - entry;
  const candleStartIso = new Date(candle.openTime).toISOString();
  if (Number.isFinite(favorableAbs) && favorableAbs > (variant.mfeAbs ?? Number.NEGATIVE_INFINITY)) {
    variant.mfeAbs = roundMetric(Math.max(0, favorableAbs));
    variant.maxFavorablePrice = favorablePrice;
    variant.maxFavorableAt = time;
    if (risk !== null && risk !== undefined && risk > 0) {
      variant.mfeR = roundMetric(variant.mfeAbs / risk);
    }
    const start = variant.pathStartAt ? new Date(variant.pathStartAt).getTime() : null;
    if (start !== null && Number.isFinite(start)) {
      variant.timeToHighMs = candle.openTime - start;
    }
  }
  if (Number.isFinite(adverseAbs) && adverseAbs > (variant.maeAbs ?? Number.NEGATIVE_INFINITY)) {
    variant.maeAbs = roundMetric(Math.max(0, adverseAbs));
    variant.maxAdversePrice = adversePrice;
    variant.maxAdverseAt = time;
    if (risk !== null && risk !== undefined && risk > 0) {
      variant.maeR = roundMetric(variant.maeAbs / risk);
    }
    const start = variant.pathStartAt ? new Date(variant.pathStartAt).getTime() : null;
    if (start !== null && Number.isFinite(start)) {
      variant.timeToLowMs = candle.openTime - start;
    }
  }
  // Compact forward-path summary
  if (variant.pathStartAt === null || variant.pathStartAt === undefined) {
    variant.pathStartAt = candleStartIso;
  }
  variant.pathEndAt = time;
  variant.pathHigh = variant.pathHigh === null || variant.pathHigh === undefined ? candle.high : Math.max(variant.pathHigh, candle.high);
  variant.pathLow = variant.pathLow === null || variant.pathLow === undefined ? candle.low : Math.min(variant.pathLow, candle.low);
  variant.pathCandleCount = (variant.pathCandleCount ?? 0) + 1;
  // Track resolutionPrice as the latest observed close so inline TP1/TP2/TP3
  // closure paths that don't route through closeVariant still persist a
  // resolution price. closeVariant overwrites with the exact closing price.
  variant.resolutionPrice = candle.close;
}

function realizedSlice(variant: ShadowVariantPosition, position: ShadowPosition, exitPrice: number, sizePct: number) {
  const { direction, entryPrice } = position;
  // R is ALWAYS denominated in the ORIGINAL admission risk (entry vs position.stopLoss, which is
  // never mutated). Denominating in the variant's live stop (moved to breakeven after TP1, then
  // trailed) shrinks the denominator toward zero and fabricates astronomical R — the audit found a
  // runner booked at +201R on a 1434bps-stop signal whose honest original-R outcome was ≈0..1R.
  const originalStop = position.stopLoss;
  const grossSlice = rAtPrice(direction, entryPrice, originalStop, exitPrice) * sizePct;
  const netSlice = netRFromGross(entryPrice, originalStop, rAtPrice(direction, entryPrice, originalStop, exitPrice), position.spreadPercent) * sizePct;
  variant.realizedGrossR = roundMetric(variant.realizedGrossR + grossSlice);
  variant.realizedNetR = roundMetric(variant.realizedNetR + netSlice);
  variant.remainingSizePct = roundMetric(Math.max(0, variant.remainingSizePct - sizePct));
}

function closeVariant(
  variant: ShadowVariantPosition,
  position: ShadowPosition,
  time: string,
  price: number,
  reason: ShadowCloseReason,
): void {
  if (variant.remainingSizePct > 0) {
    realizedSlice(variant, position, price, variant.remainingSizePct);
  }
  variant.state = "CLOSED";
  variant.closedAt = time;
  variant.lastUpdatedAt = time;
  variant.currentPrice = price;
  variant.unrealizedR = 0;
  variant.closeReason = reason;
  variant.profitableAfterCosts = variant.realizedNetR > 0;
  // Phase 3.1: persist forward-path resolution price (analytical only).
  if (variant.entryPriceUsed !== null && variant.entryPriceUsed !== undefined) {
    variant.resolutionPrice = price;
    variant.pathEndAt = variant.pathEndAt ?? time;
  }
}

function makeEvent(position: ShadowPosition, variant: ShadowPositionVariant | "idea", type: ShadowExecutionEvent["type"], createdAt: string, message: string, price: number | null, rValue: number | null): ShadowExecutionEvent {
  return {
    id: randomUUID(),
    positionId: position.id,
    ideaKey: position.ideaKey,
    symbol: position.symbol,
    direction: position.direction,
    variant,
    type,
    message,
    createdAt,
    price,
    rValue,
  };
}

function makeSkippedEntryEvent(
  candidate: Candidate,
  ideaKey: string,
  selectedEntryVariant: ExecutionEntryVariant,
  selectedExitVariant: ShadowPositionVariant,
  createdAt: string,
  message: string,
  price: number | null,
): ShadowExecutionEvent {
  return {
    id: randomUUID(),
    positionId: "pending-entry",
    ideaKey,
    symbol: candidate.symbol,
    direction: candidate.finalDirection as "LONG" | "SHORT",
    variant: "idea",
    type: "ENTRY_SKIPPED",
    message: `${message} Plan: ${selectedEntryVariant} + ${selectedExitVariant}.`,
    createdAt,
    price,
    rValue: null,
  };
}

function fillPendingPosition(position: ShadowPosition, candle: Candle, events: ShadowExecutionEvent[]): boolean {
  if ((position.entryState ?? "FILLED") !== "PENDING_ENTRY") return false;
  const zone = position.entryZone;
  const touched = zone ? candleTouchesZone(candle, zone) : candleTouchesLevel(candle, position.entryPrice, position.direction);
  if (!touched) return false;
  const time = new Date(candle.openTime).toISOString();
  position.entryState = "FILLED";
  position.entryFilledAt = time;
  position.entryFillReason = `Pending ${position.selectedEntryVariant} filled from 5m candle path; exit evaluation starts on the next candle to avoid intrabar ordering assumptions.`;
  position.lastEvaluatedAt = time;
  position.variants = [variantTemplate(position.primaryVariant, time, position.entryPrice, position.stopLoss)];
  // Phase 3.1: seed per-variant R-geometry snapshot at fill (data only).
  for (const v of position.variants) seedVariantInstrumentation(v, position);
  events.push(makeEvent(position, "idea", "OPENED", time, `Shadow trade entered: ${position.entryFillReason} Exit plan ${position.selectedExitVariant}.`, position.entryPrice, null));
  events.push(makeEvent(position, position.primaryVariant, "ENTRY_AMBIGUOUS", time, "Pending entry filled inside this 5m candle; TP/SL checks are deferred until the next candle.", position.entryPrice, null));
  return true;
}

function longLosesVwapOrEma(price: number, candidate: Candidate): boolean {
  return price < candidate.indicators.fiveMinute.vwap || price < candidate.indicators.fiveMinute.ema20;
}

function shortLosesVwapOrEma(price: number, candidate: Candidate): boolean {
  return price > candidate.indicators.fiveMinute.vwap || price > candidate.indicators.fiveMinute.ema20;
}

function whaleConflicts(candidate: Candidate, direction: "LONG" | "SHORT"): boolean {
  return (direction === "LONG" && candidate.whale.signal === "BEARISH") || (direction === "SHORT" && candidate.whale.signal === "BULLISH");
}

function kronosConflicts(candidate: Candidate, direction: "LONG" | "SHORT"): boolean {
  const bias = candidate.selectedKronosBias ?? candidate.kronosBias;
  return bias !== "UNAVAILABLE" &&
    candidate.kronosConfidenceBucket !== "WEAK" &&
    !candidate.horizonConflict &&
    ((direction === "LONG" && bias === "SHORT") || (direction === "SHORT" && bias === "LONG"));
}

function trailStopPrice(position: ShadowPosition, candidate: Candidate): number | null {
  const atr = candidate.indicators.fiveMinute.atr14;
  if (!Number.isFinite(atr) || atr <= 0) return position.entryPrice;
  if (position.direction === "LONG") {
    return Math.max(position.entryPrice, candidate.indicators.fiveMinute.ema20, candidate.indicators.fiveMinute.vwap - atr * 0.25);
  }
  return Math.min(position.entryPrice, candidate.indicators.fiveMinute.ema20, candidate.indicators.fiveMinute.vwap + atr * 0.25);
}

function updateVariantFromCandle(
  position: ShadowPosition,
  variant: ShadowVariantPosition,
  candle: Candle,
  candidate: Candidate | null,
  events: ShadowExecutionEvent[],
) {
  if (variant.state === "CLOSED") return;
  const time = new Date(candle.openTime).toISOString();
  variant.lastUpdatedAt = time;
  variant.currentPrice = candle.close;
  // Unrealized R uses the ORIGINAL admission risk (position.stopLoss), not the moved/trailed
  // variant stop — same denominator convention as realizedSlice.
  variant.unrealizedR = variant.remainingSizePct > 0 ? unrealizedR(position.direction, position.entryPrice, candle.close, position.stopLoss) * variant.remainingSizePct : 0;
  updatePositionExcursions(position, candle, time);
  // Phase 3.1: per-variant excursion + forward-path summary (data only).
  seedVariantInstrumentation(variant, position);
  updateVariantInstrumentation(variant, position, candle, time);

  const stopPrice = variant.stopPrice;
  const hitStop =
    stopPrice !== null &&
    (position.direction === "LONG" ? candle.low <= stopPrice : candle.high >= stopPrice);
  const hitTp1BeforeStop =
    !variant.tp1Hit &&
    position.tp1 !== null &&
    (position.direction === "LONG" ? candle.high >= position.tp1 : candle.low <= position.tp1);
  if (hitStop && hitTp1BeforeStop) {
    events.push(makeEvent(position, variant.variant, "ENTRY_AMBIGUOUS", time, "Same 5m candle touched SL and TP1; shadow uses conservative stop-first resolution.", stopPrice, null));
  }
  if (hitStop) {
    const reason: ShadowCloseReason = variant.slMovedToBreakeven ? "BREAKEVEN" : "SL";
    closeVariant(variant, position, time, stopPrice!, reason);
    events.push(makeEvent(position, variant.variant, reason === "BREAKEVEN" ? "EARLY_EXIT" : "SL_HIT", time, reason === "BREAKEVEN" ? "Breakeven stop closed the runner." : "Stop-loss was hit.", stopPrice!, variant.realizedNetR));
    events.push(makeEvent(position, variant.variant, "CLOSED", time, `Closed on ${reason.toLowerCase()}.`, stopPrice!, variant.realizedNetR));
    return;
  }

  const hitTp1 =
    !variant.tp1Hit &&
    position.tp1 !== null &&
    (position.direction === "LONG" ? candle.high >= position.tp1 : candle.low <= position.tp1);
  if (hitTp1) {
    variant.tp1Hit = true;
    let tp1Size = 0;
    switch (variant.variant) {
      case "tp1_full_exit":
        tp1Size = 1;
        break;
      case "tp1_70_runner30":
        tp1Size = 0.7;
        break;
      default:
        tp1Size = 0.5;
        break;
    }
    realizedSlice(variant, position, position.tp1!, tp1Size);
    events.push(makeEvent(position, variant.variant, "TP1_HIT", time, "TP1 hit.", position.tp1!, variant.realizedNetR));
    if (variant.remainingSizePct <= 0) {
      variant.state = "CLOSED";
      variant.closedAt = time;
      variant.closeReason = "TP1_FULL";
      variant.profitableAfterCosts = variant.realizedNetR > 0;
      events.push(makeEvent(position, variant.variant, "CLOSED", time, "Closed fully at TP1.", position.tp1!, variant.realizedNetR));
      return;
    }
    variant.state = "PARTIAL";
    variant.stopPrice = position.entryPrice;
    variant.slMovedToBreakeven = true;
    events.push(makeEvent(position, variant.variant, "SL_MOVED", time, "Stop moved to breakeven after TP1.", position.entryPrice, null));
  }

  const hitTp2 =
    variant.tp1Hit &&
    !variant.tp2Hit &&
    position.tp2 !== null &&
    (position.direction === "LONG" ? candle.high >= position.tp2 : candle.low <= position.tp2);
  if (hitTp2 && (variant.variant === "tp1_50_tp2_runner" || variant.variant === "tp1_70_runner30" || variant.variant === "kronos_runner_exit")) {
    variant.tp2Hit = true;
    if (variant.variant === "kronos_runner_exit" && position.tp3 !== null) {
      variant.state = "PARTIAL";
      events.push(makeEvent(position, variant.variant, "TP2_HIT", time, "TP2 hit; Kronos runner remains open for TP3 or flip exit.", position.tp2!, variant.realizedNetR));
    } else {
      closeVariant(variant, position, time, position.tp2!, "TP2");
      events.push(makeEvent(position, variant.variant, "TP2_HIT", time, "TP2 hit.", position.tp2!, variant.realizedNetR));
      events.push(makeEvent(position, variant.variant, "CLOSED", time, "Runner closed at TP2.", position.tp2!, variant.realizedNetR));
      return;
    }
  }

  const hitTp3 =
    variant.tp1Hit &&
    position.tp3 !== null &&
    (position.direction === "LONG" ? candle.high >= position.tp3 : candle.low <= position.tp3);
  if (hitTp3 && (variant.variant === "trail_after_tp1" || variant.variant === "kronos_runner_exit" || variant.variant === "kronos_flip_exit" || variant.variant === "whale_conflict_exit" || variant.variant === "vwap_loss_exit")) {
    variant.tp3Hit = true;
    closeVariant(variant, position, time, position.tp3!, "TP3");
    events.push(makeEvent(position, variant.variant, "RUNNER_EXIT", time, "Runner completed at TP3.", position.tp3!, variant.realizedNetR));
    events.push(makeEvent(position, variant.variant, "CLOSED", time, "Closed at TP3.", position.tp3!, variant.realizedNetR));
    return;
  }

  if (!variant.tp1Hit || !candidate) {
    return;
  }

  if (variant.variant === "trail_after_tp1") {
    const trail = trailStopPrice(position, candidate);
    if (trail !== null) {
      variant.stopPrice = position.direction === "LONG" ? Math.max(variant.stopPrice ?? trail, trail) : Math.min(variant.stopPrice ?? trail, trail);
    }
  }

  const shouldExitOnWhale = variant.variant === "whale_conflict_exit" && whaleConflicts(candidate, position.direction);
  const shouldExitOnKronos = variant.variant === "kronos_flip_exit" && kronosConflicts(candidate, position.direction);
  const shouldExitOnVwap =
    variant.variant === "vwap_loss_exit" &&
    (position.direction === "LONG" ? longLosesVwapOrEma(candle.close, candidate) : shortLosesVwapOrEma(candle.close, candidate));
  const shouldTrailExit =
    variant.variant === "trail_after_tp1" &&
    (position.direction === "LONG"
      ? candle.low <= (variant.stopPrice ?? position.entryPrice)
      : candle.high >= (variant.stopPrice ?? position.entryPrice));

  if (shouldExitOnWhale || shouldExitOnKronos || shouldExitOnVwap || shouldTrailExit) {
    const closeReason: ShadowCloseReason = shouldExitOnWhale
      ? "WHALE_CONFLICT"
      : shouldExitOnKronos
        ? "KRONOS_FLIP"
        : shouldExitOnVwap
          ? "VWAP_LOSS"
          : "TRAIL_STOP";
    closeVariant(variant, position, time, candle.close, closeReason);
    events.push(makeEvent(position, variant.variant, "RUNNER_EXIT", time, `Runner exited on ${closeReason.toLowerCase().replace("_", " ")}.`, candle.close, variant.realizedNetR));
    events.push(makeEvent(position, variant.variant, "CLOSED", time, "Runner closed.", candle.close, variant.realizedNetR));
  }
}

function variantTemplate(variant: ShadowPositionVariant, openedAt: string, entryPrice: number, stopLoss: number | null): ShadowVariantPosition {
  return {
    variant,
    state: "OPEN",
    openedAt,
    lastUpdatedAt: openedAt,
    closedAt: null,
    remainingSizePct: 1,
    realizedGrossR: 0,
    realizedNetR: 0,
    unrealizedR: 0,
    currentPrice: entryPrice,
    stopPrice: stopLoss,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    slMovedToBreakeven: false,
    closeReason: "OPEN",
    profitableAfterCosts: false,
  };
}

function summarizeScope(positions: ShadowPosition[], predicate: (position: ShadowPosition) => boolean): ShadowScopePerformance {
  const scopedPositions = positions.filter(predicate);
  const scopedVariants = scopedPositions.flatMap((position) => position.variants);
  const closed = scopedVariants.filter((variant) => variant.state === "CLOSED" && variant.closeReason !== "NO_FILL");
  const open = scopedVariants.filter((variant) => variant.state !== "CLOSED");
  const winners = closed.filter((variant) => variant.realizedNetR > 0);
  const losers = closed.filter((variant) => variant.realizedNetR < 0);
  const lossMagnitude = Math.abs(losers.reduce((sum, variant) => sum + variant.realizedNetR, 0));
  const today = new Date().toISOString().slice(0, 10);
  const dailyClosed = closed.filter((variant) => (variant.closedAt ?? "").slice(0, 10) === today);
  const dailyWinners = dailyClosed.filter((variant) => variant.realizedNetR > 0);
  const dailyLosers = dailyClosed.filter((variant) => variant.realizedNetR < 0);
  const dailyLossMagnitude = Math.abs(dailyLosers.reduce((sum, variant) => sum + variant.realizedNetR, 0));

  const tp1HitCount = scopedVariants.filter((v) => v.tp1Hit).length;
  const profitableTp1Count = scopedVariants.filter((v) => v.tp1Hit && v.realizedNetR > 0).length;
  const slCount = closed.filter((v) => v.closeReason === "SL" || v.closeReason === "BREAKEVEN").length;
  const closedIdeas = scopedPositions.filter((p) => p.variants.some((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL"));
  return {
    uniqueIdeas: scopedPositions.length,
    closedPositions: closedIdeas.length,
    total: scopedVariants.length,
    closed: closed.length,
    open: open.length,
    dailyClosedGrossR: roundMetric(dailyClosed.reduce((sum, variant) => sum + variant.realizedGrossR, 0)),
    dailyClosedNetR: roundMetric(dailyClosed.reduce((sum, variant) => sum + variant.realizedNetR, 0)),
    dailyProfitFactor: dailyClosed.length === 0 || dailyLossMagnitude === 0
      ? null
      : roundMetric(dailyWinners.reduce((sum, variant) => sum + variant.realizedNetR, 0) / dailyLossMagnitude),
    winRate: closed.length ? roundMetric(winners.length / closed.length) : 0,
    profitFactor: closed.length === 0 || lossMagnitude === 0
      ? null
      : roundMetric(winners.reduce((sum, variant) => sum + variant.realizedNetR, 0) / lossMagnitude),
    grossAvgR: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedGrossR, 0) / closed.length) : null,
    netAvgR: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedNetR, 0) / closed.length) : null,
    expectancyPerTrade: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedNetR, 0) / closed.length) : null,
    tp1Rate: scopedVariants.length ? roundMetric(tp1HitCount / scopedVariants.length) : 0,
    profitableTp1Rate: tp1HitCount ? roundMetric(profitableTp1Count / tp1HitCount) : 0,
    slRate: closed.length ? roundMetric(slCount / closed.length) : 0,
    avgWinR: winners.length ? roundMetric(winners.reduce((sum, v) => sum + v.realizedNetR, 0) / winners.length) : null,
    avgLossR: losers.length ? roundMetric(losers.reduce((sum, v) => sum + v.realizedNetR, 0) / losers.length) : null,
  };
}

function summarize(positions: ShadowPosition[], recentLog: ShadowExecutionEvent[], suppressedDuplicates: number): ShadowExecutionSummary {
  const allVariants = positions.flatMap((position) => position.variants);
  const noFill = allVariants.filter((variant) => variant.closeReason === "NO_FILL");
  const resolved = allVariants.filter((variant) => variant.state === "CLOSED" && variant.closeReason !== "NO_FILL");
  const open = allVariants.filter((variant) => variant.state !== "CLOSED");
  const profitable = resolved.filter((variant) => variant.realizedNetR > 0);
  const negativeNet = resolved.filter((variant) => variant.realizedNetR < 0);
  const grossAvg = resolved.length ? roundMetric(resolved.reduce((sum, variant) => sum + variant.realizedGrossR, 0) / resolved.length) : null;
  const netAvg = resolved.length ? roundMetric(resolved.reduce((sum, variant) => sum + variant.realizedNetR, 0) / resolved.length) : null;
  const profitFactorDenominator = Math.abs(negativeNet.reduce((sum, variant) => sum + variant.realizedNetR, 0));
  const profitFactor = resolved.length === 0
    ? null
    : profitFactorDenominator === 0
      ? null
      : roundMetric(profitable.reduce((sum, variant) => sum + variant.realizedNetR, 0) / profitFactorDenominator);
  const avgWinR = profitable.length ? roundMetric(profitable.reduce((sum, variant) => sum + variant.realizedNetR, 0) / profitable.length) : null;
  const losers = resolved.filter((variant) => variant.realizedNetR < 0);
  const avgLossR = losers.length ? roundMetric(losers.reduce((sum, variant) => sum + variant.realizedNetR, 0) / losers.length) : null;
  const today = new Date().toISOString().slice(0, 10);
  const dailyResolved = resolved.filter((variant) => (variant.closedAt ?? "").slice(0, 10) === today);
  const dailyProfitable = dailyResolved.filter((variant) => variant.realizedNetR > 0);
  const dailyNegative = dailyResolved.filter((variant) => variant.realizedNetR < 0);
  const dailyLossMagnitude = Math.abs(dailyNegative.reduce((sum, variant) => sum + variant.realizedNetR, 0));
  const dailyClosedGrossR = roundMetric(dailyResolved.reduce((sum, variant) => sum + variant.realizedGrossR, 0));
  const dailyClosedNetR = roundMetric(dailyResolved.reduce((sum, variant) => sum + variant.realizedNetR, 0));
  const dailyProfitFactor = dailyResolved.length === 0 || dailyLossMagnitude === 0
    ? null
    : roundMetric(dailyProfitable.reduce((sum, variant) => sum + variant.realizedNetR, 0) / dailyLossMagnitude);
  const runnerClosed = resolved.filter((variant) => variant.variant !== "tp1_full_exit" && variant.tp1Hit);
  const runnerSuccessRate = runnerClosed.length ? roundMetric(runnerClosed.filter((variant) => variant.tp2Hit || variant.tp3Hit || variant.realizedNetR > 0.5).length / runnerClosed.length) : 0;
  const profitabilityExplanation = resolved.length === 0
    ? "No closed shadow trades yet; profitability is still unknown."
    : netAvg !== null && netAvg > 0
      ? `Positive net expectancy: closed shadow trades average ${netAvg}R after costs with profit factor ${profitFactor ?? "unknown"}.`
      : `Negative net expectancy: closed shadow trades average ${netAvg ?? 0}R after costs; cost drag and stop-outs are overwhelming gross edge.`;

  const variants: ShadowVariantPerformance[] = VARIANTS.map((variantKey) => {
    const records = allVariants.filter((variant) => variant.variant === variantKey);
    const closed = records.filter((variant) => variant.state === "CLOSED" && variant.closeReason !== "NO_FILL");
    const winners = closed.filter((variant) => variant.realizedNetR > 0);
    const losers = closed.filter((variant) => variant.realizedNetR < 0);
    const pfDenominator = Math.abs(losers.reduce((sum, variant) => sum + variant.realizedNetR, 0));
    return {
      variant: variantKey,
      total: records.length,
      resolved: closed.length,
      open: records.length - closed.length,
      profitable: winners.length,
      tp1Hit: records.filter((variant) => variant.tp1Hit).length,
      slHit: closed.filter((variant) => variant.closeReason === "SL" || variant.closeReason === "BREAKEVEN").length,
      grossAvgR: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedGrossR, 0) / closed.length) : null,
      netAvgR: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedNetR, 0) / closed.length) : null,
      avgWinR: winners.length ? roundMetric(winners.reduce((sum, variant) => sum + variant.realizedNetR, 0) / winners.length) : null,
      avgLossR: losers.length ? roundMetric(losers.reduce((sum, variant) => sum + variant.realizedNetR, 0) / losers.length) : null,
      expectancyPerTrade: closed.length ? roundMetric(closed.reduce((sum, variant) => sum + variant.realizedNetR, 0) / closed.length) : null,
      winRate: closed.length ? roundMetric(winners.length / closed.length) : 0,
      profitFactor: closed.length === 0 || pfDenominator === 0 ? null : roundMetric(winners.reduce((sum, variant) => sum + variant.realizedNetR, 0) / pfDenominator),
    };
  });

  const bestVariantStats = [...variants]
    .filter((variant) => variant.resolved > 0 && variant.netAvgR !== null)
    .sort((left, right) => (right.netAvgR ?? Number.NEGATIVE_INFINITY) - (left.netAvgR ?? Number.NEGATIVE_INFINITY))[0] ?? null;
  const primaryProfitCandidate = summarizeScope(positions, (position) => position.variantSelection?.routeMode === "PROFIT_CANDIDATE");
  const researchExecution = summarizeScope(positions, (position) => (position.variantSelection?.routeMode ?? "RESEARCH_ONLY") === "RESEARCH_ONLY");
  const dataCollectionExecution = summarizeScope(positions, (position) => position.variantSelection?.routeMode === "DATA_COLLECTION");

  return {
    rawExecutedTrades: allVariants.length,
    uniqueIdeas: positions.length,
    openPositions: open.length + positions.filter((position) => (position.entryState ?? "FILLED") === "PENDING_ENTRY").length,
    closedPositions: resolved.length,
    winRate: resolved.length ? roundMetric(profitable.length / resolved.length) : 0,
    profitFactor,
    grossAvgR: grossAvg,
    netAvgR: netAvg,
    dailyClosedGrossR,
    dailyClosedNetR,
    dailyProfitFactor,
    avgWinR,
    avgLossR,
    expectancyPerTrade: netAvg,
    noFillRate: positions.length ? roundMetric(noFill.length / positions.length) : 0,
    runnerSuccessRate,
    profitabilityExplanation,
    tp1Rate: allVariants.length ? roundMetric(allVariants.filter((variant) => variant.tp1Hit).length / allVariants.length) : 0,
    slRate: allVariants.length ? roundMetric(allVariants.filter((variant) => variant.closeReason === "SL" || variant.closeReason === "BREAKEVEN").length / allVariants.length) : 0,
    bestVariant: bestVariantStats?.variant ?? null,
    duplicateSuppressionWindowMinutes: DUPLICATE_WINDOW_MINUTES,
    activeOpenIdeaCount: positions.filter((position) => (position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED")).length,
    suppressedDuplicates,
    bestVariantStats,
    variants,
    bestVariantCombinations: [],
    primaryProfitCandidate,
    researchExecution,
    dataCollectionExecution,
  };
}

export class ShadowExecutionEngine {
  private readonly dataDir: string;
  private readonly positionsFile: string;
  private readonly logFile: string;
  private readonly getPerformanceStats: (() => PerformanceStats | null) | null;
  private decisionLedger: DecisionLedger | null = null;
  constructor(
    private readonly binanceClient: BinanceClient,
    performanceOrDataDir: (() => PerformanceStats | null) | string | null = null,
    maybeDataDir = DEFAULT_DATA_DIR,
  ) {
    this.getPerformanceStats = typeof performanceOrDataDir === "function" ? performanceOrDataDir : null;
    this.dataDir = typeof performanceOrDataDir === "string" ? performanceOrDataDir : maybeDataDir;
    this.positionsFile = resolve(this.dataDir, "shadow-positions.json");
    this.logFile = resolve(this.dataDir, "shadow-execution-log.json");
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  setDecisionLedger(ledger: DecisionLedger | null): void {
    this.decisionLedger = ledger;
  }

  private buildLedgerBase(position: ShadowPosition, timestamp: string): DecisionLedgerBase {
    const selection = position.variantSelection;
    return {
      timestamp,
      symbol: position.symbol,
      direction: position.direction,
      candidateId: position.id,
      ideaId: position.ideaKey,
      selectedExecutionPlan: selection,
      routeMode: selection?.routeMode ?? null,
      routeReasonCodes: selection?.routeReasonCodes ?? [],
      expectedNetR: selection?.expectedNetR ?? null,
      expectedGrossR: selection?.expectedGrossR ?? null,
      costR: position.costR ?? selection?.costR ?? null,
      stopDistanceBps: position.stopDistanceBps ?? selection?.stopDistanceBps ?? null,
      shadowStatus: position.entryState ?? "FILLED",
    };
  }

  private emitLifecycleEvents(
    positions: ShadowPosition[],
    addedEvents: ShadowExecutionEvent[],
  ): void {
    const ledger = this.decisionLedger;
    if (!ledger) return;
    const byId = new Map(positions.map((p) => [p.id, p] as const));
    for (const event of addedEvents) {
      const position = byId.get(event.positionId);
      if (!position) continue;
      const base = this.buildLedgerBase(position, event.createdAt);
      try {
        if (event.type === "ENTRY_PENDING" && event.variant === "idea") {
          ledger.recordEntryPending({
            ...base,
            details: { entryPrice: position.entryPrice, stopLoss: position.stopLoss, tp1: position.tp1 } as Record<string, unknown>,
          } as DecisionLedgerBase);
        } else if (event.type === "OPENED" && event.variant === "idea") {
          ledger.recordEntryFilled({
            ...base,
            details: {
              entryPrice: position.entryPrice,
              stopLoss: position.stopLoss,
              tp1: position.tp1,
              entryVariant: position.selectedEntryVariant,
              exitVariant: position.selectedExitVariant,
            } as Record<string, unknown>,
          } as DecisionLedgerBase);
        } else if (event.type === "DUPLICATE_SUPPRESSED") {
          ledger.append({ ...base, event: "ROUTE_DUPLICATE_SUPPRESSED" });
        } else if (event.type === "CLOSED" && event.variant !== "idea") {
          const variant = position.variants.find((v) => v.variant === event.variant);
          if (!variant) continue;
          ledger.recordExitClosed(base, {
            closeReason: variant.closeReason,
            realizedGrossR: variant.realizedGrossR,
            realizedNetR: variant.realizedNetR,
            variant: variant.variant,
          });
          const codes = classifyReflection({
            symbol: position.symbol,
            direction: position.direction,
            closeReason: variant.closeReason,
            realizedNetR: variant.realizedNetR,
            realizedGrossR: variant.realizedGrossR,
            filled: variant.closeReason !== "NO_FILL",
            plan: position.variantSelection ?? null,
          });
          if (codes.length > 0) {
            ledger.recordReflection(base, codes, {
              closeReason: variant.closeReason,
              realizedNetR: variant.realizedNetR,
            });
          }
        }
      } catch (err) {
        // ledger failures must never break shadow flow
        console.error(`[shadow-engine] decision-ledger lifecycle event (${event.type}) failed:`, err);
      }
    }
  }

  private readPositions(): ShadowPosition[] {
    if (!existsSync(this.positionsFile)) return [];
    const raw = readFileSync(this.positionsFile, "utf-8").trim();
    if (!raw) return [];
    return JSON.parse(raw) as ShadowPosition[];
  }

  private writePositions(positions: ShadowPosition[]) {
    writeJsonAtomic(this.positionsFile, prunePositions(positions));
  }

  private readLog(): ShadowExecutionEvent[] {
    if (!existsSync(this.logFile)) return [];
    const raw = readFileSync(this.logFile, "utf-8").trim();
    if (!raw) return [];
    return JSON.parse(raw) as ShadowExecutionEvent[];
  }

  private writeLog(log: ShadowExecutionEvent[]) {
    writeJsonAtomic(this.logFile, log);
  }

  async processScan(result: ScanResult): Promise<void> {
    const nowIso = result.generatedAt;
    const nowMs = new Date(nowIso).getTime();
    const performance = this.getPerformanceStats?.() ?? null;
    const candidateMap = new Map(result.top10.map((candidate) => [candidate.symbol, candidate] as const));
    const positions = this.readPositions();
    const log = this.readLog();
    const logStartIndex = log.length;
    let suppressedDuplicates = log.filter((event) => event.type === "DUPLICATE_SUPPRESSED").length;

    const openPositions = positions.filter((position) => (position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED"));
    const symbolsToUpdate = [...new Set(openPositions.map((position) => position.symbol))];
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const symbol of symbolsToUpdate) {
      const relevant = openPositions.filter((position) => position.symbol === symbol);
      const earliest = Math.min(...relevant.map((position) => new Date(position.lastEvaluatedAt).getTime()));
      const candleCount = Math.min(Math.max(Math.ceil((nowMs - earliest) / (5 * 60 * 1000)) + 2, 12), 500);
      try {
        candlesBySymbol.set(
          symbol,
          await this.binanceClient.getCandles(symbol, "5m", candleCount, {
            startTime: earliest,
            endTime: nowMs,
          }),
        );
      } catch {
        // best effort only
      }
    }

    for (const position of positions) {
      const isActive = (position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED");
      if (!isActive) continue;

      const candidate = candidateMap.get(position.symbol) ?? null;
      const candles = candlesBySymbol.get(position.symbol) ?? [];
      const lastEvaluatedMs = new Date(position.lastEvaluatedAt).getTime();
      const freshCandles = candles.filter((candle) => candle.openTime > lastEvaluatedMs && candle.openTime <= nowMs);
      for (const candle of freshCandles) {
        const filledOnThisCandle = fillPendingPosition(position, candle, log);
        if (filledOnThisCandle) continue;
        for (const variant of position.variants) {
          updateVariantFromCandle(position, variant, candle, candidate, log);
        }
      }
      const latestPrice = candidate ? currentPrice(candidate) : freshCandles.at(-1)?.close ?? position.entryPrice;
      for (const variant of position.variants) {
        variant.currentPrice = latestPrice;
        if (variant.state !== "CLOSED") {
          variant.unrealizedR = variant.remainingSizePct > 0 ? unrealizedR(position.direction, position.entryPrice, latestPrice, position.stopLoss) * variant.remainingSizePct : 0;
          if (nowMs - new Date(position.firstSeenAt).getTime() >= ACTIVE_POSITION_MAX_MS) {
            closeVariant(variant, position, nowIso, latestPrice, "TIME_EXPIRED");
            log.push(makeEvent(position, variant.variant, "CLOSED", nowIso, "Position expired after 24h shadow window.", latestPrice, variant.realizedNetR));
          }
        }
      }
      if ((position.entryState ?? "FILLED") === "PENDING_ENTRY" && nowMs - new Date(position.firstSeenAt).getTime() >= ACTIVE_POSITION_MAX_MS) {
        position.entryState = "FILLED";
        position.lastEvaluatedAt = nowIso;
        position.lastSeenAt = nowIso;
        if (position.variants.length === 0) {
          const noFillVariant = variantTemplate(position.primaryVariant, position.scannedAt, position.entryPrice, position.stopLoss);
          noFillVariant.state = "CLOSED";
          noFillVariant.closedAt = nowIso;
          noFillVariant.lastUpdatedAt = nowIso;
          noFillVariant.closeReason = "NO_FILL";
          position.variants = [noFillVariant];
        }
        log.push(makeEvent(position, "idea", "CLOSED", nowIso, "Pending entry expired after 24h shadow window without a fill.", latestPrice, null));
        log.push(makeEvent(position, position.primaryVariant, "NO_FILL", nowIso, "No fill: selected pending entry never traded through its level before expiry.", latestPrice, null));
      }
      position.lastEvaluatedAt = nowIso;
      position.lastSeenAt = nowIso;
    }

    for (const candidate of result.top10) {
      if (candidate.finalDirection === "NEUTRAL") continue;
      const plan = buildTradePlan(candidate);
      const selection = candidate.selectedExecutionPlan ?? buildVariantSelection(candidate, performance);
      const fill = entryFillForVariant(candidate, selection.selectedEntryVariant, plan);
      const zone = fill.zone;
      const entryPrice = fill.entryPrice;
      const ideaKey = buildIdeaKey(candidate, zone, entryPrice, selection.selectedEntryVariant, selection.selectedExitVariant);
      const marketZone = effectiveEntryZone(candidate, plan);
      const marketEntryReference = entryMid(marketZone) ?? currentPrice(candidate);
      const marketIdeaKey = buildMarketIdeaKey(candidate, marketZone, marketEntryReference);
      const signalFamily = determineSignalFamily(candidate);

      if (!isEntryConditionMet(candidate)) continue;

      const stopLoss = candidate.stopLoss ?? plan.stopLoss;
      const riskDistance = stopLoss === null ? null : Math.abs(entryPrice - stopLoss);
      const invalidRisk =
        stopLoss === null ||
        riskDistance === null ||
        !Number.isFinite(riskDistance) ||
        riskDistance <= 0 ||
        (candidate.finalDirection === "LONG" ? stopLoss >= entryPrice : stopLoss <= entryPrice);
      const admissionCosts = costDiagnostics(entryPrice, stopLoss, finiteOrNull(candidate.spread.percent));
      const stopTooTight =
        admissionCosts.stopDistanceBps !== null &&
        Number.isFinite(admissionCosts.stopDistanceBps) &&
        admissionCosts.stopDistanceBps < MIN_ADMISSION_STOP_DISTANCE_BPS;

      if (!fill.filled || invalidRisk || stopTooTight) {
        const duplicateGroup = positions.filter((position) =>
          position.ideaKey === ideaKey &&
          position.symbol === candidate.symbol &&
          position.direction === candidate.finalDirection &&
          position.signalFamily === signalFamily &&
          position.selectedEntryVariant === selection.selectedEntryVariant &&
          position.selectedExitVariant === selection.selectedExitVariant &&
          hasSimilarEntryZone(position.entryZone, zone, entryPrice) &&
          ((position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED")) &&
          nowMs - new Date(position.lastSeenAt).getTime() <= DUPLICATE_WINDOW_MS,
        );

        if (duplicateGroup.length > 0) {
          for (const existing of duplicateGroup) {
            existing.scanCount += 1;
            existing.lastSeenAt = nowIso;
            existing.latestStatus = candidate.finalStatus;
            existing.latestScore = candidate.opportunityScore;
            existing.latestReason = candidate.reason;
          }
          suppressedDuplicates += 1;
          log.push(makeEvent(duplicateGroup[0], "idea", "DUPLICATE_SUPPRESSED", nowIso, "Duplicate active market idea suppressed; execution plan preserved.", currentPrice(candidate), null));
          continue;
        }

        const recentSkip = log.find((event) =>
          event.type === "ENTRY_SKIPPED" &&
          event.ideaKey === ideaKey &&
          nowMs - new Date(event.createdAt).getTime() <= DUPLICATE_WINDOW_MS,
        );
        if (invalidRisk) {
          if (!recentSkip) {
            const reason = `${selection.selectedEntryVariant} selected but entry/stop risk is invalid for ${candidate.finalDirection}: entry ${roundMetric(entryPrice)}, stop ${stopLoss === null ? "missing" : roundMetric(stopLoss)}.`;
            log.push(makeSkippedEntryEvent(candidate, ideaKey, selection.selectedEntryVariant, selection.selectedExitVariant, nowIso, reason, currentPrice(candidate)));
          }
          continue;
        }
        if (stopTooTight) {
          if (!recentSkip) {
            const reason =
              `${STOP_DISTANCE_TOO_TIGHT_FOR_COST_RISK}: ${selection.selectedEntryVariant} selected but stop distance ` +
              `${roundMetric(admissionCosts.stopDistanceBps!)}bps is below ${MIN_ADMISSION_STOP_DISTANCE_BPS}bps for normal active/base shadow admission.`;
            log.push(makeSkippedEntryEvent(candidate, ideaKey, selection.selectedEntryVariant, selection.selectedExitVariant, nowIso, reason, currentPrice(candidate)));
          }
          continue;
        }

        if (!recentSkip) {
          const reason = invalidRisk
            ? `${selection.selectedEntryVariant} selected but entry/stop risk is invalid for ${candidate.finalDirection}: entry ${roundMetric(entryPrice)}, stop ${stopLoss === null ? "missing" : roundMetric(stopLoss)}.`
            : fill.reason;
          const primaryVariant = selection.selectedExitVariant;
          const costs = admissionCosts;
          const pendingPosition: ShadowPosition = {
            id: randomUUID(),
            ideaKey,
            marketIdeaKey,
            symbol: candidate.symbol,
            direction: candidate.finalDirection,
            signalFamily,
            scannedAt: nowIso,
            firstSeenAt: nowIso,
            lastSeenAt: nowIso,
            lastEvaluatedAt: nowIso,
            scanCount: 1,
            latestStatus: candidate.finalStatus,
            latestScore: candidate.opportunityScore,
            latestReason: candidate.reason,
            entryZone: zone,
            marketEntryZone: marketZone,
            entryState: "PENDING_ENTRY",
            entryPrice,
            entryFillReason: reason,
            spreadPercent: finiteOrNull(candidate.spread.percent),
            stopDistanceBps: costs.stopDistanceBps,
            feeSlippageR: costs.feeSlippageR,
            spreadR: costs.spreadR,
            costR: costs.costR,
            stopLoss,
            tp1: candidate.takeProfits.tp1 ?? plan.takeProfit1,
            tp2: candidate.takeProfits.tp2 ?? plan.takeProfit2,
            tp3: candidate.takeProfits.tp3 ?? plan.takeProfit3,
            riskReward: candidate.riskReward,
            dangerScore: candidate.dangerScore,
            selectedEntryVariant: selection.selectedEntryVariant,
            selectedExitVariant: selection.selectedExitVariant,
            variantSelection: selection,
            primaryVariant,
            tradePlan: plan,
            variants: [],
            marketRegime: result.marketRegime ?? null,
            strategyContextSnapshot: buildStrategyContextSnapshot({
              candidate,
              selectedExecutionPlan: selection,
              tradePlan: plan,
              signalFamily,
              scanTimestamp: nowIso,
              marketRegime: result.marketRegime ?? null,
            }),
            policyVersion: BASE_ROUTE_POLICY_VERSION_V2,
            riskHygieneGuardMinStopDistanceBps: MIN_ADMISSION_STOP_DISTANCE_BPS,
            riskHygieneGuardVersion: RISK_HYGIENE_GUARD_V1,
          };
          positions.push(pendingPosition);
          log.push(makeEvent(pendingPosition, "idea", "ENTRY_PENDING", nowIso, reason, currentPrice(candidate), null));
        }
        continue;
      }

      const duplicateGroup = positions.filter((position) =>
        position.ideaKey === ideaKey &&
        position.symbol === candidate.symbol &&
        position.direction === candidate.finalDirection &&
        position.signalFamily === signalFamily &&
        position.selectedEntryVariant === selection.selectedEntryVariant &&
        position.selectedExitVariant === selection.selectedExitVariant &&
        hasSimilarEntryZone(position.entryZone, zone, entryPrice) &&
        ((position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED")) &&
        nowMs - new Date(position.lastSeenAt).getTime() <= DUPLICATE_WINDOW_MS,
      );

      if (duplicateGroup.length > 0) {
        for (const existing of duplicateGroup) {
          existing.scanCount += 1;
          existing.lastSeenAt = nowIso;
          existing.latestStatus = candidate.finalStatus;
          existing.latestScore = candidate.opportunityScore;
          existing.latestReason = candidate.reason;
        }
        suppressedDuplicates += 1;
        log.push(makeEvent(duplicateGroup[0], "idea", "DUPLICATE_SUPPRESSED", nowIso, "Duplicate active market idea suppressed; execution plan preserved.", entryPrice, null));
        continue;
      }

      const primaryVariant = selection.selectedExitVariant;
      const costs = admissionCosts;
      const position: ShadowPosition = {
        id: randomUUID(),
        ideaKey,
        marketIdeaKey,
        symbol: candidate.symbol,
        direction: candidate.finalDirection,
        signalFamily,
        scannedAt: nowIso,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        lastEvaluatedAt: nowIso,
        scanCount: 1,
        latestStatus: candidate.finalStatus,
        latestScore: candidate.opportunityScore,
        latestReason: candidate.reason,
        entryZone: zone,
        marketEntryZone: marketZone,
        entryState: "FILLED",
        entryPrice,
        entryFilledAt: nowIso,
        entryFillReason: fill.reason,
        spreadPercent: finiteOrNull(candidate.spread.percent),
        stopDistanceBps: costs.stopDistanceBps,
        feeSlippageR: costs.feeSlippageR,
        spreadR: costs.spreadR,
        costR: costs.costR,
        stopLoss,
        tp1: candidate.takeProfits.tp1 ?? plan.takeProfit1,
        tp2: candidate.takeProfits.tp2 ?? plan.takeProfit2,
        tp3: candidate.takeProfits.tp3 ?? plan.takeProfit3,
        riskReward: candidate.riskReward,
        dangerScore: candidate.dangerScore,
        selectedEntryVariant: selection.selectedEntryVariant,
        selectedExitVariant: selection.selectedExitVariant,
        variantSelection: selection,
        primaryVariant,
        tradePlan: plan,
        variants: [variantTemplate(primaryVariant, nowIso, entryPrice, candidate.stopLoss ?? plan.stopLoss)],
        marketRegime: result.marketRegime ?? null,
        strategyContextSnapshot: buildStrategyContextSnapshot({
          candidate,
          selectedExecutionPlan: selection,
          tradePlan: plan,
          signalFamily,
          scanTimestamp: nowIso,
          marketRegime: result.marketRegime ?? null,
        }),
        policyVersion: BASE_ROUTE_POLICY_VERSION_V2,
        riskHygieneGuardMinStopDistanceBps: MIN_ADMISSION_STOP_DISTANCE_BPS,
        riskHygieneGuardVersion: RISK_HYGIENE_GUARD_V1,
      };
      // Phase 3.1: seed per-variant R-geometry snapshot at fill (data only).
      for (const v of position.variants) seedVariantInstrumentation(v, position);
      positions.push(position);
      log.push(makeEvent(position, "idea", "OPENED", nowIso, `Shadow trade entered: ${fill.reason} Exit plan ${selection.selectedExitVariant}.`, entryPrice, null));
    }

    const addedEvents = log.slice(logStartIndex);
    this.emitLifecycleEvents(positions, addedEvents);

    this.writePositions(positions);
    this.writeLog(log.slice(-1000));
  }

  getAllPositions(): ShadowPosition[] {
    return this.readPositions();
  }

  getExecutionLog(): ShadowExecutionEvent[] {
    return this.readLog();
  }

  getSnapshot(): ShadowStateSnapshot {
    const positions = this.readPositions();
    const log = this.readLog();
    const openPositions = positions
      .filter((position) => (position.entryState ?? "FILLED") === "PENDING_ENTRY" || position.variants.some((variant) => variant.state !== "CLOSED"))
      .sort((left, right) => new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime());
    const suppressedDuplicates = log.filter((event) => event.type === "DUPLICATE_SUPPRESSED").length;
    return {
      generatedAt: new Date().toISOString(),
      summary: summarize(positions, log, suppressedDuplicates),
      openPositions,
      recentLog: log.slice(-80).reverse(),
    };
  }
}

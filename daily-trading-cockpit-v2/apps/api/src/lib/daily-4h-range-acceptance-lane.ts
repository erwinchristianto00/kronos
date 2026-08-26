/**
 * DAILY 4H RANGE ACCEPTANCE — testnet-only experimental lane.
 *
 * This module intentionally has no dependency on MOM36, the regime controller, a
 * continuation model, or the Dynamic basket admission path.  It owns its own
 * deterministic state, signal history, exchange order ids, and safety controls.
 *
 * Binance USD-M accounts in this deployment are one-way/netted.  A persisted
 * open/pending trade is therefore also a symbol lease: other entry paths must not
 * open the same symbol while this lane's reduce-only bracket is live.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  BinanceFuturesPrivateError,
  type BinanceFuturesPrivateClient,
  type FuturesAlgoOrder,
  type FuturesIncomeEntry,
  type FuturesKline,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
} from "./binance-futures-private.js";

export const DAILY_RANGE_LANE_ID = "DAILY_4H_RANGE_ACCEPTANCE";
export const DAILY_RANGE_STRATEGY_VERSION = "daily-4h-range-acceptance-2r-v1";
export const DAILY_RANGE_TRADE_NOTIONAL_USD = 25;
export const DAILY_RANGE_LEVERAGE = 1;
export const DAILY_RANGE_RR = 2;

const FIVE_MIN_MS = 5 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EPSILON = 1e-9;
const MAX_FRESH_SIGNAL_AGE_MS = 95_000;
const CONFIRM_RETRIES = 4;
const DEFAULT_CONFIRM_RETRY_MS = 350;

export type DailyRangeDirection = "LONG" | "SHORT";
export type DailyRangeControlMode = "DISARMED" | "ARMED";
export type DailyRangeTradeStatus =
  | "ENTRY_SUBMITTING"
  | "ENTRY_RECONCILING"
  | "PROTECTING"
  | "OPEN"
  | "EXIT_RECONCILING"
  | "CLOSED"
  | "ENTRY_ABORT_INVALID_RISK"
  | "ENTRY_ABORT_PROTECTION_FAILED"
  | "ENTRY_ABORT_EXECUTION_FAILED"
  | "ENTRY_ABORT_SYMBOL_IN_FLIGHT"
  | "ENTRY_ABORT_ACCOUNT_CONFLICT";

export type DailyRangeSignalReason =
  | "SHORT_BLOCKED"
  | "SYMBOL_OCCUPIED_BY_OTHER_STRATEGY"
  | "LANE_POSITION_ALREADY_OPEN"
  | "OUTSIDE_ENTRY_WINDOW"
  | "EXECUTION_INELIGIBLE"
  | "STALE_DATA"
  | "ACCOUNT_STATE_UNKNOWN"
  | "INSUFFICIENT_MARGIN"
  | "MISSED_SIGNAL_RECOVERY"
  | "LANE_DISARMED"
  | "ENTRY_IN_FLIGHT";

export interface DailyRangeCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DailyRangeLevel {
  dateUtc: string;
  symbol: string;
  fourHourOpenTime: number;
  fourHourCloseTime: number;
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  rangeWidthPct: number | null;
  dailyUniverseMembership: true;
  createdAt: string;
}

export interface DailyRangeSymbolState {
  lastProcessedBarOpenTime: number | null;
  previousClosedCandle: DailyRangeCandle | null;
  longCount: 0 | 1 | 2;
  shortCount: 0 | 1 | 2;
  longLocked: boolean;
  shortLocked: boolean;
}

export interface DailyRangeDayState {
  dateUtc: string;
  initializedAt: string;
  universeSymbols: string[];
  universeSource: string;
  levels: Record<string, DailyRangeLevel>;
  invalidReferenceSymbols: Array<{ symbol: string; reason: string }>;
  symbolStates: Record<string, DailyRangeSymbolState>;
}

export interface DailyRangeSignal {
  signalId: string;
  strategyVersion: typeof DAILY_RANGE_STRATEGY_VERSION;
  laneId: typeof DAILY_RANGE_LANE_ID;
  dateUtc: string;
  symbol: string;
  direction: DailyRangeDirection;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: DailyRangeCandle | null;
  confirmationBar2: DailyRangeCandle;
  signalTimestamp: string;
  signalTimestampMs: number;
  entryEligible: boolean;
  reason: DailyRangeSignalReason | null;
  entryAttemptedAt: string | null;
  tradeId: string | null;
}

export interface DailyRangeTrade {
  tradeId: string;
  signalId: string;
  strategyVersion: typeof DAILY_RANGE_STRATEGY_VERSION;
  laneId: typeof DAILY_RANGE_LANE_ID;
  dateUtc: string;
  symbol: string;
  direction: DailyRangeDirection;
  status: DailyRangeTradeStatus;
  entryOrderId: string | null;
  entryClientOrderId: string;
  signalTimestamp: string;
  entrySubmittedAt: string;
  entryFilledAt: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  /** Exact rounded market quantity persisted before POST for unknown-order reconciliation. */
  requestedQty: number | null;
  entryNotionalUsd: number | null;
  entrySlippageBps: number | null;
  signalReferencePrice: number | null;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: DailyRangeCandle;
  confirmationBar2: DailyRangeCandle;
  structuralStopRaw: number;
  stopPrice: number | null;
  takeProfitRaw: number | null;
  takeProfitPrice: number | null;
  initialRiskPrice: number | null;
  initialRiskPct: number | null;
  initialRiskDollar: number | null;
  rrTarget: typeof DAILY_RANGE_RR;
  stopAlgoOrderId: string | null;
  stopClientAlgoId: string;
  takeProfitAlgoOrderId: string | null;
  takeProfitClientAlgoId: string;
  exitOrderId: string | null;
  exitClientOrderId: string | null;
  exitReason: string | null;
  exitTimestamp: string | null;
  exitPrice: number | null;
  /** Executable bid/ask captured immediately before a lane-originated market exit. */
  exitReferencePrice: number | null;
  /** Positive means adverse slippage versus exitReferencePrice. Null for native trigger exits without a pre-trigger quote. */
  exitSlippageBps: number | null;
  grossPnlUsd: number | null;
  feesUsd: number | null;
  fundingUsd: number | null;
  netPnlUsd: number | null;
  grossR: number | null;
  realizedR: number | null;
  mfePct: number | null;
  maePct: number | null;
  mfeR: number | null;
  maeR: number | null;
  lastMarkPrice: number | null;
  holdingDurationMs: number | null;
  abortReason: string | null;
  lastReconcileError: string | null;
}

/**
 * The only account-level claim this isolated lane is allowed to publish.  It
 * exists for reconciliation/reporting; it never carries permission for another
 * component to amend, close, or resize the trade.
 */
export interface DailyRangeOpenPositionClaim {
  laneId: typeof DAILY_RANGE_LANE_ID;
  tradeId: string;
  symbol: string;
  direction: DailyRangeDirection;
  qty: number;
  entryPrice: number;
  openedAt: string;
  status: Extract<DailyRangeTradeStatus, "PROTECTING" | "OPEN" | "EXIT_RECONCILING">;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  lastReconcileError: string | null;
}

export interface DailyRangeCanaryEvidence {
  canaryId: string;
  at: string;
  status: "RUNNING" | "PASSED" | "FAILED";
  symbol: string | null;
  side: "BUY";
  intendedNotionalUsd: number;
  leverage: number;
  entryOrderId: string | null;
  entryClientOrderId: string | null;
  entryFillPrice: number | null;
  entryQty: number | null;
  stopAlgoOrderId: string | null;
  takeProfitAlgoOrderId: string | null;
  closeOrderId: string | null;
  positionVerified: boolean;
  bracketVerified: boolean;
  bracketCancelled: boolean;
  closeVerified: boolean;
  orphanOrders: number | null;
  orphanPosition: boolean | null;
  failure: string | null;
}

export interface DailyRangeRuntimeState {
  reconciledAt: string | null;
  reconciliationError: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastProcessedMarketBarOpenTime: number | null;
  startedAt: string | null;
}

interface DailyRangePersistedState {
  version: 1;
  control: {
    mode: DailyRangeControlMode;
    armedAt: string | null;
    disarmedAt: string | null;
    disarmReason: string | null;
  };
  days: Record<string, DailyRangeDayState>;
  signals: DailyRangeSignal[];
  trades: DailyRangeTrade[];
  canaries: DailyRangeCanaryEvidence[];
  runtime: DailyRangeRuntimeState;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function firstReferenceReadyAtMs(ms: number): number {
  return utcDayStartMs(ms) + FOUR_HOURS_MS;
}

export function inDailyRangeEntryWindow(ms: number): boolean {
  const start = utcDayStartMs(ms);
  return ms >= start + FOUR_HOURS_MS && ms < start + DAY_MS;
}

function lastClosedFiveMinuteOpenTime(ms: number): number | null {
  const currentOpen = Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
  const completedOpen = currentOpen - FIVE_MIN_MS;
  return completedOpen >= 0 ? completedOpen : null;
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function blankSymbolState(lastProcessedBarOpenTime: number | null): DailyRangeSymbolState {
  return {
    lastProcessedBarOpenTime,
    previousClosedCandle: null,
    longCount: 0,
    shortCount: 0,
    longLocked: false,
    shortLocked: false,
  };
}

function emptyState(nowMs: number): DailyRangePersistedState {
  return {
    version: 1,
    control: { mode: "DISARMED", armedAt: null, disarmedAt: iso(nowMs), disarmReason: "initial state" },
    days: {},
    signals: [],
    trades: [],
    canaries: [],
    runtime: {
      reconciledAt: null,
      reconciliationError: null,
      lastTickAt: null,
      lastError: null,
      lastProcessedMarketBarOpenTime: null,
      startedAt: iso(nowMs),
    },
  };
}

/**
 * A separate, atomic JSON state file.  Unlike incumbent best-effort telemetry
 * stores, failure to persist a new entry state is surfaced to the caller so an
 * order can never be sent without a durable ownership/reconciliation handle.
 */
export class DailyRangeLaneStore {
  private readonly file: string;
  private state: DailyRangePersistedState;

  constructor(dataDir = "data", fileName = "daily-4h-range-acceptance-2r-v1.json", nowMs = Date.now()) {
    this.file = resolve(dataDir, fileName);
    mkdirSync(dirname(this.file), { recursive: true });
    this.state = this.load(nowMs);
  }

  private load(nowMs: number): DailyRangePersistedState {
    try {
      if (!existsSync(this.file)) return emptyState(nowMs);
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DailyRangePersistedState>;
      if (parsed?.version !== 1 || !parsed.control || !parsed.days || !Array.isArray(parsed.signals) || !Array.isArray(parsed.trades)) {
        return emptyState(nowMs);
      }
      return {
        version: 1,
        control: {
          mode: parsed.control.mode === "ARMED" ? "ARMED" : "DISARMED",
          armedAt: parsed.control.armedAt ?? null,
          disarmedAt: parsed.control.disarmedAt ?? null,
          disarmReason: parsed.control.disarmReason ?? null,
        },
        days: parsed.days as Record<string, DailyRangeDayState>,
        signals: parsed.signals as DailyRangeSignal[],
        trades: parsed.trades as DailyRangeTrade[],
        canaries: Array.isArray(parsed.canaries) ? parsed.canaries as DailyRangeCanaryEvidence[] : [],
        runtime: {
          reconciledAt: parsed.runtime?.reconciledAt ?? null,
          reconciliationError: parsed.runtime?.reconciliationError ?? null,
          lastTickAt: parsed.runtime?.lastTickAt ?? null,
          lastError: parsed.runtime?.lastError ?? null,
          lastProcessedMarketBarOpenTime: parsed.runtime?.lastProcessedMarketBarOpenTime ?? null,
          startedAt: parsed.runtime?.startedAt ?? iso(nowMs),
        },
      };
    } catch {
      // A corrupt file cannot safely prove order ownership.  Preserve it for forensics
      // and start with a safe disarmed state rather than trading from invented data.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // The caller will remain disarmed when persistence cannot be repaired.
      }
      return emptyState(nowMs);
    }
  }

  getState(): DailyRangePersistedState {
    return this.state;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf8");
    renameSync(tmp, this.file);
  }

  arm(at: string): void {
    this.state.control = { mode: "ARMED", armedAt: at, disarmedAt: null, disarmReason: null };
    this.save();
  }

  disarm(at: string, reason: string): void {
    this.state.control = { ...this.state.control, mode: "DISARMED", disarmedAt: at, disarmReason: reason };
    this.save();
  }

  hasActiveSymbolLease(symbol: string): DailyRangeTrade | null {
    const normalized = normalizeSymbol(symbol);
    return this.state.trades.find((trade) =>
      trade.symbol === normalized &&
      ["ENTRY_SUBMITTING", "ENTRY_RECONCILING", "PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status),
    ) ?? null;
  }

  findTrade(tradeId: string): DailyRangeTrade | null {
    return this.state.trades.find((trade) => trade.tradeId === tradeId) ?? null;
  }

  findSignal(signalId: string): DailyRangeSignal | null {
    return this.state.signals.find((signal) => signal.signalId === signalId) ?? null;
  }
}

export type DailyRangeExecClient = Pick<
  BinanceFuturesPrivateClient,
  | "getExchangeFilters"
  | "getPositions"
  | "getOpenOrders"
  | "getOpenAlgoOrders"
  | "getBookTicker"
  | "getKlines"
  | "isHedgeMode"
  | "setLeverage"
  | "placeOrder"
  | "placeAlgoOrder"
  | "queryOrder"
  | "queryOrderByClientId"
  | "queryAlgoOrder"
  | "cancelOrder"
  | "cancelAlgoOrder"
  | "getUserTrades"
  | "getIncomeHistory"
>;

export interface DailyRangeUniverseSnapshot {
  symbols: string[];
  source: string;
}

export interface DailyRangeEntryClaims {
  tryClaimEntrySymbol: (symbol: string, owner: string) => boolean;
  releaseEntrySymbol: (symbol: string, owner: string) => void;
}

export interface DailyRangeAcceptanceLaneOptions {
  client: DailyRangeExecClient;
  store: DailyRangeLaneStore;
  /** Current durable C1/C2 pool. It is copied once into each UTC day record. */
  getUniverse: () => DailyRangeUniverseSnapshot;
  getShortBlocklist: () => ReadonlySet<string>;
  entryClaims: DailyRangeEntryClaims;
  environment: "testnet" | "mainnet";
  nowMs?: () => number;
  confirmRetryMs?: number;
}

function symbolSide(direction: DailyRangeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "BUY" : "SELL";
}

function exitSide(direction: DailyRangeDirection): "BUY" | "SELL" {
  return direction === "LONG" ? "SELL" : "BUY";
}

function directionSign(direction: DailyRangeDirection): number {
  return direction === "LONG" ? 1 : -1;
}

function roundToStep(value: number, step: number, mode: "down" | "up"): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const units = value / step;
  const rounded = mode === "down" ? Math.floor(units + 1e-10) : Math.ceil(units - 1e-10);
  const result = rounded * step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  return Number(result.toFixed(Math.min(14, decimals)));
}

export function roundDailyRangeBracket(input: {
  direction: DailyRangeDirection;
  entry: number;
  rawStop: number;
  tickSize: number;
}): {
  stop: number;
  takeProfitRaw: number;
  takeProfit: number;
  riskPrice: number;
} | null {
  if (!finitePositive(input.entry) || !finitePositive(input.rawStop) || !finitePositive(input.tickSize)) return null;
  const stop = input.direction === "LONG"
    ? roundToStep(input.rawStop, input.tickSize, "down")
    : roundToStep(input.rawStop, input.tickSize, "up");
  const riskPrice = input.direction === "LONG" ? input.entry - stop : stop - input.entry;
  if (!(riskPrice > EPSILON)) return null;
  const takeProfitRaw = input.direction === "LONG"
    ? input.entry + DAILY_RANGE_RR * riskPrice
    : input.entry - DAILY_RANGE_RR * riskPrice;
  const takeProfit = input.direction === "LONG"
    ? roundToStep(takeProfitRaw, input.tickSize, "up")
    : roundToStep(takeProfitRaw, input.tickSize, "down");
  const roundedReward = input.direction === "LONG" ? takeProfit - input.entry : input.entry - takeProfit;
  if (!(takeProfit > 0) || roundedReward + EPSILON < DAILY_RANGE_RR * riskPrice) return null;
  return { stop, takeProfitRaw, takeProfit, riskPrice };
}

export function structuralStopForAcceptance(input: {
  direction: DailyRangeDirection;
  rangeHigh: number;
  rangeLow: number;
  confirmationBar1: DailyRangeCandle;
  confirmationBar2: DailyRangeCandle;
}): number {
  return input.direction === "LONG"
    ? Math.min(input.rangeHigh, input.confirmationBar1.low, input.confirmationBar2.low)
    : Math.max(input.rangeLow, input.confirmationBar1.high, input.confirmationBar2.high);
}

function asDailyCandle(value: FuturesKline): DailyRangeCandle {
  return {
    openTime: value.openTime,
    closeTime: value.closeTime,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
  };
}

function safeCsvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderWasExplicitlyRejected(error: unknown): boolean {
  return error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error";
}

function orderStatusFilled(order: FuturesOrder | null): boolean {
  return order !== null && order.status === "FILLED" && order.executedQty > EPSILON && order.avgPrice > 0;
}

function algoLooksTriggered(order: FuturesAlgoOrder | null): boolean {
  if (!order) return false;
  const status = order.algoStatus.toUpperCase();
  return order.actualOrderId !== null || status.includes("TRIGGER") || status.includes("FINISH") || status.includes("EXECUT");
}

function isTerminalTradeStatus(status: DailyRangeTradeStatus): boolean {
  return status === "CLOSED" || status.startsWith("ENTRY_ABORT_");
}

function clampQty(rawQty: number, filter: FuturesSymbolFilters): number | null {
  const qty = roundToStep(rawQty, filter.stepSize, "down");
  if (!(qty >= filter.minQty - EPSILON)) return null;
  return qty;
}

function canaryClientId(kind: "E" | "SL" | "TP" | "X", symbol: string, nowMs: number): string {
  return `DRCANARY-${symbol.slice(0, 7)}-${nowMs.toString(36)}-${kind}`.slice(0, 36);
}

function signalId(dateUtc: string, symbol: string, direction: DailyRangeDirection, closeTime: number): string {
  return `drra1-${dateUtc.replaceAll("-", "")}-${symbol.toLowerCase().slice(0, 8)}-${direction[0]}-${closeTime.toString(36)}`.slice(0, 60);
}

function tradeIdFromSignal(signal: DailyRangeSignal): string {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
  return `drra1-${signal.symbol.toLowerCase().slice(0, 8)}-${signal.signalTimestampMs.toString(36)}-${nonce}`.slice(0, 32);
}

function entryClientId(tradeId: string): string {
  return `${tradeId}-e`.slice(0, 36);
}

function algoClientId(tradeId: string, kind: "sl" | "tp"): string {
  return `${tradeId}-${kind}`.slice(0, 36);
}

function exitClientId(tradeId: string): string {
  return `${tradeId}-x`.slice(0, 36);
}

export class DailyRangeAcceptanceLane {
  private readonly client: DailyRangeExecClient;
  private readonly store: DailyRangeLaneStore;
  private readonly getUniverse: () => DailyRangeUniverseSnapshot;
  private readonly getShortBlocklist: () => ReadonlySet<string>;
  private readonly entryClaims: DailyRangeEntryClaims;
  private readonly environment: "testnet" | "mainnet";
  private readonly nowMs: () => number;
  private readonly confirmRetryMs: number;
  private ticking = false;
  private startupReconciled = false;
  private closingTradeIds = new Set<string>();

  constructor(opts: DailyRangeAcceptanceLaneOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.getUniverse = opts.getUniverse;
    this.getShortBlocklist = opts.getShortBlocklist;
    this.entryClaims = opts.entryClaims;
    this.environment = opts.environment;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.confirmRetryMs = opts.confirmRetryMs ?? DEFAULT_CONFIRM_RETRY_MS;
  }

  isSymbolLeased(symbol: string): { tradeId: string; direction: DailyRangeDirection; status: DailyRangeTradeStatus } | null {
    const trade = this.store.hasActiveSymbolLease(symbol);
    return trade ? { tradeId: trade.tradeId, direction: trade.direction, status: trade.status } : null;
  }

  /**
   * Symbols held by this lane in Binance's one-way/netted account.  This includes unresolved
   * entry/reconciliation states as well as filled positions: a forming cross-sectional basket
   * must skip all of them rather than discovering the conflict only at executor submission.
   */
  getActiveLeaseSymbols(): string[] {
    return [...new Set(
      this.store.getState().trades
        .filter((trade) => !isTerminalTradeStatus(trade.status))
        .map((trade) => trade.symbol),
    )].sort();
  }

  /**
   * Report exact filled, still-open daily-range ownership to the shared account
   * view. Pending submissions deliberately do not appear here: before a fill is
   * proven, presenting requested quantity as an exchange position would invent
   * attribution. The lane's own startup reconciliation remains responsible for
   * those pending states.
  */
  getOpenPositionClaims(): DailyRangeOpenPositionClaim[] {
    return this.store.getState().trades.flatMap((trade) => {
      const status = trade.status;
      if (status !== "PROTECTING" && status !== "OPEN" && status !== "EXIT_RECONCILING") return [];
      if (!finitePositive(trade.entryQty) || !finitePositive(trade.entryFillPrice)) return [];
      return [{
        laneId: DAILY_RANGE_LANE_ID,
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        direction: trade.direction,
        qty: trade.entryQty,
        entryPrice: trade.entryFillPrice,
        openedAt: trade.entryFilledAt ?? trade.entrySubmittedAt,
        status,
        stopPrice: trade.stopPrice,
        takeProfitPrice: trade.takeProfitPrice,
        lastReconcileError: trade.lastReconcileError,
      }];
    });
  }

  /**
   * Signed quantities the isolated lane owns (or has durably submitted). app.ts
   * supplies this to the legacy mirror's reconciliation only on Testnet, so it
   * never mistakes this lane's exchange position for an orphan or nets it away.
   */
  managedNetQty(): Map<string, number> {
    const net = new Map<string, number>();
    for (const trade of this.store.getState().trades) {
      if (isTerminalTradeStatus(trade.status)) continue;
      const qty = trade.entryQty ?? trade.requestedQty;
      if (!finitePositive(qty)) continue;
      net.set(trade.symbol, (net.get(trade.symbol) ?? 0) + directionSign(trade.direction) * qty);
    }
    return net;
  }

  getStatus(): Record<string, unknown> {
    const now = this.nowMs();
    const state = this.store.getState();
    const date = utcDate(now);
    const day = state.days[date] ?? null;
    const performance = this.performanceSummary();
    const signalsToday = state.signals.filter((signal) => signal.dateUtc === date);
    const tradesToday = state.trades.filter((trade) => trade.dateUtc === date);
    const openTrades = state.trades.filter((trade) => !isTerminalTradeStatus(trade.status));
    return {
      ok: true,
      environment: this.environment,
      laneId: DAILY_RANGE_LANE_ID,
      strategyVersion: DAILY_RANGE_STRATEGY_VERSION,
      utcNow: iso(now),
      control: state.control,
      reconciled: this.startupReconciled,
      runtime: state.runtime,
      today: {
        dateUtc: date,
        rangeInitialized: day !== null,
        rangeReady: now >= firstReferenceReadyAtMs(now),
        entryWindowOpen: inDailyRangeEntryWindow(now),
        dailyUniverseCount: day?.universeSymbols.length ?? 0,
        /** Immutable source captured at the UTC-day boundary; lets operators verify pool isolation. */
        dailyUniverseSource: day?.universeSource ?? null,
        dailyUniverseSymbols: day?.universeSymbols ?? [],
        monitoringSymbols: Object.keys(day?.levels ?? {}).length,
        invalidReferenceSymbols: day?.invalidReferenceSymbols ?? [],
        signals: signalsToday.length,
        executedTrades: tradesToday.filter((trade) => trade.entryOrderId !== null).length,
        closedTrades: tradesToday.filter((trade) => trade.status === "CLOSED").length,
      },
      nextReferenceReset: iso(utcDayStartMs(now) + DAY_MS + FOUR_HOURS_MS),
      openTrades,
      totalHistoricalTrades: state.trades.filter((trade) => trade.entryOrderId !== null).length,
      performance,
      lastCanary: state.canaries.at(-1) ?? null,
    };
  }

  /** Read-only review accessor for a durable lane-owned trade.  The returned
   * record is detached from store state so API/dashboard callers cannot alter
   * entry, bracket, or reconciliation ownership by accident. */
  findTrade(tradeId: string): DailyRangeTrade | null {
    const trade = this.store.findTrade(tradeId);
    return trade ? {
      ...trade,
      confirmationBar1: { ...trade.confirmationBar1 },
      confirmationBar2: { ...trade.confirmationBar2 },
    } : null;
  }

  history(kind: "levels" | "signals" | "trades", limit = 500): unknown[] {
    const bounded = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const state = this.store.getState();
    if (kind === "levels") {
      return Object.values(state.days)
        .flatMap((day) => Object.values(day.levels))
        .sort((a, b) => b.fourHourOpenTime - a.fourHourOpenTime || a.symbol.localeCompare(b.symbol))
        .slice(0, bounded);
    }
    const rows = kind === "signals" ? state.signals : state.trades;
    return [...rows].slice(-bounded).reverse();
  }

  exportCsv(kind: "levels" | "signals" | "trades"): string {
    const rows = this.history(kind, 10_000) as Array<Record<string, unknown>>;
    if (rows.length === 0) return "";
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return [columns.join(","), ...rows.map((row) => columns.map((column) => safeCsvCell(row[column])).join(","))].join("\n");
  }

  private performanceSummary(): Record<string, unknown> {
    const executed = this.store.getState().trades.filter((trade) => trade.entryOrderId !== null);
    const closed = executed.filter((trade) => trade.status === "CLOSED" && trade.realizedR !== null && trade.netPnlUsd !== null);
    const wins = closed.filter((trade) => (trade.netPnlUsd ?? 0) > 0);
    const losses = closed.filter((trade) => (trade.netPnlUsd ?? 0) < 0);
    const totalR = closed.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0);
    const grossProfit = wins.reduce((sum, trade) => sum + Math.max(0, trade.netPnlUsd ?? 0), 0);
    const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(Math.min(0, trade.netPnlUsd ?? 0)), 0);
    const mean = closed.length ? totalR / closed.length : null;
    const sortedR = closed.map((trade) => trade.realizedR ?? 0).sort((a, b) => a - b);
    const median = sortedR.length === 0 ? null : sortedR.length % 2 ? sortedR[(sortedR.length - 1) / 2]! : (sortedR[sortedR.length / 2 - 1]! + sortedR[sortedR.length / 2]!) / 2;
    const avgHold = closed.length
      ? closed.reduce((sum, trade) => sum + (trade.holdingDurationMs ?? 0), 0) / closed.length
      : null;
    const byDirection = (direction: DailyRangeDirection) => {
      const rows = closed.filter((trade) => trade.direction === direction);
      return {
        trades: rows.length,
        netPnlUsd: rows.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
        realizedR: rows.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0),
      };
    };
    const bySymbol: Record<string, { trades: number; netPnlUsd: number; realizedR: number }> = {};
    const byDate: Record<string, { trades: number; netPnlUsd: number; realizedR: number }> = {};
    for (const trade of closed) {
      const add = (target: Record<string, { trades: number; netPnlUsd: number; realizedR: number }>, key: string) => {
        const row = target[key] ?? { trades: 0, netPnlUsd: 0, realizedR: 0 };
        row.trades += 1;
        row.netPnlUsd += trade.netPnlUsd ?? 0;
        row.realizedR += trade.realizedR ?? 0;
        target[key] = row;
      };
      add(bySymbol, trade.symbol);
      add(byDate, trade.dateUtc);
    }
    return {
      totalSignals: this.store.getState().signals.length,
      executedTrades: executed.length,
      openTrades: executed.filter((trade) => !isTerminalTradeStatus(trade.status)).length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : null,
      grossPnlUsd: closed.reduce((sum, trade) => sum + (trade.grossPnlUsd ?? 0), 0),
      netPnlUsd: closed.reduce((sum, trade) => sum + (trade.netPnlUsd ?? 0), 0),
      totalRealizedR: totalR,
      meanR: mean,
      medianR: median,
      expectancyR: mean,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
      averageWinnerR: wins.length ? wins.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / wins.length : null,
      averageLoserR: losses.length ? losses.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / losses.length : null,
      averageHoldingDurationMs: avgHold,
      long: byDirection("LONG"),
      short: byDirection("SHORT"),
      bySymbol,
      byUtcDate: byDate,
      takeProfitCount: closed.filter((trade) => trade.exitReason === "TAKE_PROFIT").length,
      stopLossCount: closed.filter((trade) => trade.exitReason === "STOP_LOSS").length,
      executionAbortCount: this.store.getState().trades.filter((trade) => trade.status.startsWith("ENTRY_ABORT_")).length,
    };
  }

  /** Testnet-only manual kill switch. Existing exchange-native brackets are left intact. */
  disarm(reason = "manual lane disarm"): { ok: boolean; mode: DailyRangeControlMode } {
    this.store.disarm(iso(this.nowMs()), reason);
    return { ok: true, mode: "DISARMED" };
  }

  arm(): { ok: boolean; reason: string | null; mode: DailyRangeControlMode } {
    if (this.environment !== "testnet") {
      return { ok: false, reason: "daily range lane is structurally testnet-only", mode: "DISARMED" };
    }
    const lastCanary = this.store.getState().canaries.at(-1);
    if (!lastCanary || lastCanary.status !== "PASSED") {
      return { ok: false, reason: "a complete DRCANARY lifecycle must pass before arm", mode: "DISARMED" };
    }
    if (!this.startupReconciled) {
      return { ok: false, reason: "exchange/account reconciliation is not complete", mode: "DISARMED" };
    }
    this.store.arm(iso(this.nowMs()));
    return { ok: true, reason: null, mode: "ARMED" };
  }

  /**
   * One scheduler tick.  The cadence may be faster than five minutes for bracket
   * reconciliation; kline processing itself is watermark driven and occurs only
   * once for every completed 5m candle.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = this.nowMs();
    const state = this.store.getState();
    state.runtime.lastTickAt = iso(startedAt);
    try {
      if (!this.startupReconciled) await this.reconcileOnStartup();
      await this.reconcileOpenTrades();
      await this.ensureTodayRange();
      if (state.control.mode !== "ARMED") {
        state.runtime.lastError = null;
        this.store.save();
        return;
      }
      if (!inDailyRangeEntryWindow(this.nowMs())) {
        state.runtime.lastError = null;
        this.store.save();
        return;
      }
      await this.processCompletedBars();
      state.runtime.lastError = null;
      this.store.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.runtime.lastError = message;
      try {
        this.store.save();
      } catch {
        // A store error is already the primary, surfaced error.
      }
      console.error(`[daily-range-lane] TICK_FAILED ${message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileOnStartup(): Promise<void> {
    if (this.environment !== "testnet") throw new Error("daily range lane refuses non-testnet runtime");
    const state = this.store.getState();
    try {
      const hedge = await this.client.isHedgeMode();
      if (hedge) throw new Error("P0: testnet account is in hedge mode; daily lane requires verified one-way semantics");
      await this.reconcilePendingEntries();
      await this.reconcileOpenTrades();
      this.startupReconciled = true;
      state.runtime.reconciledAt = iso(this.nowMs());
      state.runtime.reconciliationError = null;
      this.store.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.runtime.reconciliationError = message;
      this.store.disarm(iso(this.nowMs()), `startup reconciliation failed: ${message}`);
      throw error;
    }
  }

  private async ensureTodayRange(): Promise<void> {
    const now = this.nowMs();
    if (now < firstReferenceReadyAtMs(now)) return;
    const state = this.store.getState();
    const date = utcDate(now);
    if (state.days[date]) return;

    const snapshot = this.getUniverse();
    const symbols = [...new Set(snapshot.symbols.map(normalizeSymbol).filter(Boolean))].sort();
    if (symbols.length === 0) throw new Error("daily universe snapshot is empty");
    const dayStart = utcDayStartMs(now);
    const levelResults = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const candles = await this.client.getKlines(symbol, "4h", {
            startTime: dayStart,
            endTime: dayStart + FOUR_HOURS_MS - 1,
            limit: 3,
          });
          const exact = candles.find((candle) => candle.openTime === dayStart && candle.closeTime < dayStart + FOUR_HOURS_MS);
          if (!exact || !(exact.high > exact.low) || !finitePositive(exact.high) || !finitePositive(exact.low)) {
            return { symbol, level: null as DailyRangeLevel | null, reason: "missing or invalid completed UTC 00:00-04:00 candle" };
          }
          const level: DailyRangeLevel = {
            dateUtc: date,
            symbol,
            fourHourOpenTime: dayStart,
            fourHourCloseTime: dayStart + FOUR_HOURS_MS,
            rangeHigh: exact.high,
            rangeLow: exact.low,
            rangeWidth: exact.high - exact.low,
            rangeWidthPct: exact.low > 0 ? (exact.high - exact.low) / exact.low : null,
            dailyUniverseMembership: true,
            createdAt: iso(this.nowMs()),
          };
          return { symbol, level, reason: null as string | null };
        } catch (error) {
          return {
            symbol,
            level: null as DailyRangeLevel | null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const latestCompleted = lastClosedFiveMinuteOpenTime(now);
    const levels: Record<string, DailyRangeLevel> = {};
    const invalidReferenceSymbols: Array<{ symbol: string; reason: string }> = [];
    const symbolStates: Record<string, DailyRangeSymbolState> = {};
    for (const result of levelResults) {
      if (result.level) {
        levels[result.symbol] = result.level;
        // Startup is never an excuse to enter based on a bar which closed before
        // this lane was armed. An already-armed restart retains a persisted watermark.
        symbolStates[result.symbol] = blankSymbolState(latestCompleted);
      } else {
        invalidReferenceSymbols.push({ symbol: result.symbol, reason: result.reason ?? "invalid reference" });
      }
    }
    state.days[date] = {
      dateUtc: date,
      initializedAt: iso(this.nowMs()),
      universeSymbols: symbols,
      universeSource: snapshot.source,
      levels,
      invalidReferenceSymbols,
      symbolStates,
    };
    this.store.save();
    console.log(
      `[daily-range-lane] DAILY_RANGE_INITIALIZED date=${date} universe=${symbols.length} valid=${Object.keys(levels).length} invalid=${invalidReferenceSymbols.length} source=${snapshot.source}`,
    );
  }

  private async processCompletedBars(): Promise<void> {
    const now = this.nowMs();
    const dayStart = utcDayStartMs(now);
    const date = utcDate(now);
    const state = this.store.getState();
    const day = state.days[date];
    if (!day) return;
    const latestCompletedOpen = lastClosedFiveMinuteOpenTime(now);
    if (latestCompletedOpen === null || latestCompletedOpen < dayStart + FOUR_HOURS_MS) return;
    const actions: DailyRangeSignal[] = [];
    for (const [symbol, level] of Object.entries(day.levels)) {
      const symbolState = day.symbolStates[symbol] ?? blankSymbolState(latestCompletedOpen);
      day.symbolStates[symbol] = symbolState;
      const initialOpen = Math.max(dayStart + FOUR_HOURS_MS, (symbolState.lastProcessedBarOpenTime ?? (dayStart + FOUR_HOURS_MS - FIVE_MIN_MS)) + FIVE_MIN_MS);
      if (initialOpen > latestCompletedOpen) continue;
      let candles: DailyRangeCandle[];
      try {
        const rows = await this.client.getKlines(symbol, "5m", {
          startTime: initialOpen,
          endTime: latestCompletedOpen + FIVE_MIN_MS - 1,
          limit: 500,
        });
        candles = rows
          .map(asDailyCandle)
          .filter((bar) => bar.openTime >= initialOpen && bar.openTime <= latestCompletedOpen && bar.closeTime < now)
          .sort((a, b) => a.openTime - b.openTime);
      } catch (error) {
        state.runtime.lastError = `${symbol}: 5m fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      for (const candle of candles) {
        const expected = (symbolState.lastProcessedBarOpenTime ?? candle.openTime - FIVE_MIN_MS) + FIVE_MIN_MS;
        if (candle.openTime !== expected) {
          state.runtime.lastError = `${symbol}: missing 5m candle at ${iso(expected)}`;
          break; // do not leap over a missing state transition
        }
        const emitted = this.applyCandle(day, level, symbolState, candle);
        symbolState.lastProcessedBarOpenTime = candle.openTime;
        symbolState.previousClosedCandle = candle;
        if (emitted) actions.push(emitted);
        // The watermark and any emitted signal form one atomic file update. A crash
        // cannot create an unrecorded advance or duplicate reprocessing of the same bar.
        this.store.save();
      }
    }
    state.runtime.lastProcessedMarketBarOpenTime = latestCompletedOpen;
    this.store.save();
    await Promise.all(actions.map((signal) => this.executeFreshSignal(signal)));
  }

  private applyCandle(
    day: DailyRangeDayState,
    level: DailyRangeLevel,
    symbolState: DailyRangeSymbolState,
    candle: DailyRangeCandle,
  ): DailyRangeSignal | null {
    const longQualified = candle.close >= level.rangeHigh;
    const shortQualified = candle.close <= level.rangeLow;
    // The locks are directional.  A close below HIGH resets the LONG run and a
    // close above LOW resets the SHORT run, exactly matching the V1 contract.
    // Thus an immediate high-to-low reversal resets the former long acceptance
    // while beginning a fresh short count; it still needs two bars on its own
    // side before it can signal.
    let emitted: DailyRangeSignal | null = null;
    if (longQualified) {
      if (symbolState.longCount === 0) symbolState.longCount = 1;
      else if (symbolState.longCount === 1) {
        symbolState.longCount = 2;
        if (!symbolState.longLocked) {
          symbolState.longLocked = true;
          emitted = this.recordSignal(day, level, "LONG", symbolState.previousClosedCandle, candle);
        }
      }
    } else {
      symbolState.longCount = 0;
      symbolState.longLocked = false;
    }
    if (shortQualified) {
      if (symbolState.shortCount === 0) symbolState.shortCount = 1;
      else if (symbolState.shortCount === 1) {
        symbolState.shortCount = 2;
        if (!symbolState.shortLocked && emitted === null) {
          symbolState.shortLocked = true;
          emitted = this.recordSignal(day, level, "SHORT", symbolState.previousClosedCandle, candle);
        }
      }
    } else {
      symbolState.shortCount = 0;
      symbolState.shortLocked = false;
    }
    return emitted;
  }

  private recordSignal(
    day: DailyRangeDayState,
    level: DailyRangeLevel,
    direction: DailyRangeDirection,
    confirmationBar1: DailyRangeCandle | null,
    confirmationBar2: DailyRangeCandle,
  ): DailyRangeSignal {
    const state = this.store.getState();
    // A missing predecessor indicates a corrupt/missing path. Do not manufacture a
    // candle from C2: the signal is retained as stale diagnostic evidence and cannot
    // be executable.
    const bar1 = confirmationBar1 && confirmationBar1.openTime === confirmationBar2.openTime - FIVE_MIN_MS
      ? confirmationBar1
      : null;
    const signal: DailyRangeSignal = {
      signalId: signalId(day.dateUtc, level.symbol, direction, confirmationBar2.closeTime),
      strategyVersion: DAILY_RANGE_STRATEGY_VERSION,
      laneId: DAILY_RANGE_LANE_ID,
      dateUtc: day.dateUtc,
      symbol: level.symbol,
      direction,
      rangeHigh: level.rangeHigh,
      rangeLow: level.rangeLow,
      confirmationBar1: bar1,
      confirmationBar2,
      signalTimestamp: iso(confirmationBar2.closeTime + 1),
      signalTimestampMs: confirmationBar2.closeTime + 1,
      entryEligible: false,
      reason: bar1 === null ? "STALE_DATA" : null,
      entryAttemptedAt: null,
      tradeId: null,
    };
    state.signals.push(signal);
    console.log(`[daily-range-lane] ACCEPTANCE_${direction}_CONFIRMED symbol=${signal.symbol} signal=${signal.signalId}`);
    return signal;
  }

  private markSignal(signal: DailyRangeSignal, input: { eligible: boolean; reason: DailyRangeSignalReason | null; tradeId?: string | null }): void {
    signal.entryEligible = input.eligible;
    signal.reason = input.reason;
    if (input.tradeId !== undefined) signal.tradeId = input.tradeId;
    signal.entryAttemptedAt = iso(this.nowMs());
    this.store.save();
  }

  private createPendingTrade(signal: DailyRangeSignal): DailyRangeTrade | null {
    if (!signal.confirmationBar1) return null;
    const tradeId = tradeIdFromSignal(signal);
    const rawStop = structuralStopForAcceptance({
      direction: signal.direction,
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      confirmationBar1: signal.confirmationBar1,
      confirmationBar2: signal.confirmationBar2,
    });
    const trade: DailyRangeTrade = {
      tradeId,
      signalId: signal.signalId,
      strategyVersion: DAILY_RANGE_STRATEGY_VERSION,
      laneId: DAILY_RANGE_LANE_ID,
      dateUtc: signal.dateUtc,
      symbol: signal.symbol,
      direction: signal.direction,
      status: "ENTRY_SUBMITTING",
      entryOrderId: null,
      entryClientOrderId: entryClientId(tradeId),
      signalTimestamp: signal.signalTimestamp,
      entrySubmittedAt: iso(this.nowMs()),
      entryFilledAt: null,
      entryFillPrice: null,
      entryQty: null,
      requestedQty: null,
      entryNotionalUsd: null,
      entrySlippageBps: null,
      signalReferencePrice: null,
      rangeHigh: signal.rangeHigh,
      rangeLow: signal.rangeLow,
      confirmationBar1: signal.confirmationBar1,
      confirmationBar2: signal.confirmationBar2,
      structuralStopRaw: rawStop,
      stopPrice: null,
      takeProfitRaw: null,
      takeProfitPrice: null,
      initialRiskPrice: null,
      initialRiskPct: null,
      initialRiskDollar: null,
      rrTarget: DAILY_RANGE_RR,
      stopAlgoOrderId: null,
      stopClientAlgoId: algoClientId(tradeId, "sl"),
      takeProfitAlgoOrderId: null,
      takeProfitClientAlgoId: algoClientId(tradeId, "tp"),
      exitOrderId: null,
      exitClientOrderId: null,
      exitReason: null,
      exitTimestamp: null,
      exitPrice: null,
      exitReferencePrice: null,
      exitSlippageBps: null,
      grossPnlUsd: null,
      feesUsd: null,
      fundingUsd: null,
      netPnlUsd: null,
      grossR: null,
      realizedR: null,
      mfePct: null,
      maePct: null,
      mfeR: null,
      maeR: null,
      lastMarkPrice: null,
      holdingDurationMs: null,
      abortReason: null,
      lastReconcileError: null,
    };
    this.store.getState().trades.push(trade);
    signal.tradeId = tradeId;
    this.store.save(); // durable lease BEFORE a private order can be sent
    return trade;
  }

  private async executeFreshSignal(signal: DailyRangeSignal): Promise<void> {
    const state = this.store.getState();
    const now = this.nowMs();
    if (state.control.mode !== "ARMED") {
      this.markSignal(signal, { eligible: false, reason: "LANE_DISARMED" });
      return;
    }
    if (!inDailyRangeEntryWindow(signal.signalTimestampMs)) {
      this.markSignal(signal, { eligible: false, reason: "OUTSIDE_ENTRY_WINDOW" });
      return;
    }
    if (now - signal.signalTimestampMs > MAX_FRESH_SIGNAL_AGE_MS) {
      this.markSignal(signal, { eligible: false, reason: "MISSED_SIGNAL_RECOVERY" });
      return;
    }
    if (!signal.confirmationBar1 || signal.reason === "STALE_DATA") {
      this.markSignal(signal, { eligible: false, reason: "STALE_DATA" });
      return;
    }
    if (signal.direction === "SHORT" && this.getShortBlocklist().has(signal.symbol)) {
      this.markSignal(signal, { eligible: false, reason: "SHORT_BLOCKED" });
      console.log(`[daily-range-lane] SIGNAL_BLOCKED_SHORT symbol=${signal.symbol} signal=${signal.signalId}`);
      return;
    }
    if (this.store.hasActiveSymbolLease(signal.symbol)) {
      this.markSignal(signal, { eligible: false, reason: "LANE_POSITION_ALREADY_OPEN" });
      return;
    }

    const trade = this.createPendingTrade(signal);
    if (!trade) {
      this.markSignal(signal, { eligible: false, reason: "STALE_DATA" });
      return;
    }
    if (!this.entryClaims.tryClaimEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID)) {
      this.abortTrade(trade, "ENTRY_ABORT_SYMBOL_IN_FLIGHT", "shared in-flight symbol claim is held by another lane");
      this.markSignal(signal, { eligible: false, reason: "ENTRY_IN_FLIGHT", tradeId: trade.tradeId });
      return;
    }
    try {
      await this.submitTradeEntry(trade, signal);
    } finally {
      this.entryClaims.releaseEntrySymbol(signal.symbol, DAILY_RANGE_LANE_ID);
    }
  }

  private async readSymbolAccount(symbol: string): Promise<{ positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] }> {
    const [positions, orders, algos] = await Promise.all([
      this.client.getPositions(symbol),
      this.client.getOpenOrders(symbol),
      this.client.getOpenAlgoOrders(symbol),
    ]);
    return { positions, orders, algos };
  }

  /** A confirmed market fill can precede positionRisk visibility by a few polls. */
  private async readVisiblePosition(symbol: string): Promise<FuturesPosition | null> {
    for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt++) {
      const rows = await this.client.getPositions(symbol);
      const position = rows.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (position) return position;
      if (attempt + 1 < CONFIRM_RETRIES && this.confirmRetryMs > 0) {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, this.confirmRetryMs));
      }
    }
    return null;
  }

  private scheduleImmediateReconcile(): void {
    setTimeout(() => void this.tick(), Math.max(250, this.confirmRetryMs));
  }

  private foreignAccountReason(symbol: string, account: { positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] }): string | null {
    const position = account.positions.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
    if (position) return `foreign exchange position ${position.positionAmt}`;
    if (account.orders.some((order) => order.symbol === symbol)) return "foreign open regular order";
    if (account.algos.some((order) => order.symbol === symbol)) return "foreign open conditional order";
    return null;
  }

  private async submitTradeEntry(trade: DailyRangeTrade, signal: DailyRangeSignal): Promise<void> {
    let account: { positions: FuturesPosition[]; orders: FuturesOrder[]; algos: FuturesAlgoOrder[] };
    try {
      account = await this.readSymbolAccount(trade.symbol);
    } catch (error) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `account state unknown: ${error instanceof Error ? error.message : String(error)}`);
      this.markSignal(signal, { eligible: false, reason: "ACCOUNT_STATE_UNKNOWN", tradeId: trade.tradeId });
      return;
    }
    const foreign = this.foreignAccountReason(trade.symbol, account);
    if (foreign) {
      this.abortTrade(trade, "ENTRY_ABORT_ACCOUNT_CONFLICT", foreign);
      this.markSignal(signal, { eligible: false, reason: "SYMBOL_OCCUPIED_BY_OTHER_STRATEGY", tradeId: trade.tradeId });
      console.log(`[daily-range-lane] SYMBOL_OCCUPIED_BY_OTHER_STRATEGY symbol=${trade.symbol} detail=${foreign}`);
      return;
    }

    let filters: Map<string, FuturesSymbolFilters>;
    let referencePrice: number;
    try {
      const [allFilters, book] = await Promise.all([this.client.getExchangeFilters(), this.client.getBookTicker(trade.symbol)]);
      filters = allFilters;
      referencePrice = trade.direction === "LONG" ? book.ask ?? 0 : book.bid ?? 0;
    } catch (error) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `execution reference unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.markSignal(signal, { eligible: false, reason: "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    const filter = filters.get(trade.symbol);
    if (!filter || !finitePositive(referencePrice)) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", "symbol is not execution-feasible on testnet");
      this.markSignal(signal, { eligible: false, reason: "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    const qty = clampQty(DAILY_RANGE_TRADE_NOTIONAL_USD / referencePrice, filter);
    if (qty === null || qty * referencePrice + EPSILON < filter.minNotional) {
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", "25 USDT cannot satisfy exchange quantity/minNotional filter");
      this.markSignal(signal, { eligible: false, reason: "EXECUTION_INELIGIBLE", tradeId: trade.tradeId });
      return;
    }
    trade.signalReferencePrice = referencePrice;
    trade.requestedQty = qty;
    this.store.save();
    try {
      await this.client.setLeverage(trade.symbol, DAILY_RANGE_LEVERAGE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `unable to set required 1x leverage: ${message}`);
      this.markSignal(signal, {
        eligible: false,
        reason: error instanceof BinanceFuturesPrivateError && error.binanceCode === -2019 ? "INSUFFICIENT_MARGIN" : "EXECUTION_INELIGIBLE",
        tradeId: trade.tradeId,
      });
      return;
    }
    this.markSignal(signal, { eligible: true, reason: null, tradeId: trade.tradeId });
    this.store.save();
    let order: FuturesOrder | null = null;
    try {
      order = await this.client.placeOrder({
        symbol: trade.symbol,
        side: symbolSide(trade.direction),
        type: "MARKET",
        quantity: qty,
        newClientOrderId: trade.entryClientOrderId,
      });
    } catch (error) {
      const recovered = await this.queryEntryByClientId(trade);
      if (recovered && orderStatusFilled(recovered)) {
        await this.adoptConfirmedEntry(trade, recovered, referencePrice, filter);
        return;
      }
      if (orderWasExplicitlyRejected(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", reason);
        this.markSignal(signal, {
          eligible: false,
          reason: error instanceof BinanceFuturesPrivateError && error.binanceCode === -2019 ? "INSUFFICIENT_MARGIN" : "EXECUTION_INELIGIBLE",
          tradeId: trade.tradeId,
        });
        return;
      }
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = `entry status unknown: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
      return;
    }
    const confirmed = await this.confirmFilledOrder(trade.symbol, order);
    if (!confirmed) {
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = "market entry not yet confirmed; no retry will be sent";
      this.store.save();
      // A MARKET order is normally final immediately, but a venue can briefly
      // report PARTIALLY_FILLED before its terminal status reaches order query.
      // Reconcile sooner than the normal 30s scheduler: a terminal partial fill
      // must be adopted and bracketed (or flattened), never left naked.
      this.scheduleImmediateReconcile();
      return;
    }
    await this.adoptConfirmedEntry(trade, confirmed, referencePrice, filter);
  }

  private async queryEntryByClientId(trade: DailyRangeTrade): Promise<FuturesOrder | null> {
    try {
      return await this.client.queryOrderByClientId(trade.symbol, trade.entryClientOrderId);
    } catch {
      return null;
    }
  }

  private async confirmFilledOrder(symbol: string, initial: FuturesOrder): Promise<FuturesOrder | null> {
    if (orderStatusFilled(initial)) return initial;
    let last: FuturesOrder | null = initial;
    for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt++) {
      if (this.confirmRetryMs > 0) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, this.confirmRetryMs));
      try {
        const queried = await this.client.queryOrder(symbol, initial.orderId);
        last = queried;
        if (orderStatusFilled(queried)) return queried;
        if (!["NEW", "PARTIALLY_FILLED"].includes(queried.status)) return null;
      } catch {
        // Status remains genuinely unknown; caller persists reconciliation state.
      }
    }
    return orderStatusFilled(last) ? last : null;
  }

  /**
   * The private transport intentionally never retries a POST.  A canary follows
   * the same idempotent recovery contract as a real entry: resolve its exact
   * client id before declaring the submission failed or attempting cleanup.
   */
  private async submitCanaryMarketOrder(input: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    reduceOnly?: boolean;
    clientOrderId: string;
  }): Promise<FuturesOrder> {
    let initial: FuturesOrder | null = null;
    try {
      initial = await this.client.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: "MARKET",
        quantity: input.quantity,
        reduceOnly: input.reduceOnly,
        newClientOrderId: input.clientOrderId,
      });
    } catch (error) {
      try {
        initial = await this.client.queryOrderByClientId(input.symbol, input.clientOrderId);
      } catch {
        throw error;
      }
    }
    const confirmed = await this.confirmFilledOrder(input.symbol, initial);
    if (!confirmed) throw new Error(`canary market order ${input.clientOrderId} is not confirmed filled`);
    return confirmed;
  }

  private async adoptConfirmedEntry(
    trade: DailyRangeTrade,
    order: FuturesOrder,
    referencePrice: number,
    filter: FuturesSymbolFilters,
  ): Promise<void> {
    const qty = order.executedQty;
    const entry = order.avgPrice;
    if (!(qty > EPSILON) || !(entry > 0)) {
      trade.status = "ENTRY_RECONCILING";
      trade.lastReconcileError = "entry fill had no executable quantity/price";
      this.store.save();
      return;
    }
    const bracket = roundDailyRangeBracket({
      direction: trade.direction,
      entry,
      rawStop: trade.structuralStopRaw,
      tickSize: filter.tickSize,
    });
    trade.entryOrderId = order.orderId;
    trade.entryFilledAt = iso(order.updateTime > 0 ? order.updateTime : this.nowMs());
    trade.entryFillPrice = entry;
    trade.entryQty = qty;
    trade.entryNotionalUsd = entry * qty;
    trade.entrySlippageBps = referencePrice > 0
      ? 10_000 * (trade.direction === "LONG" ? (entry - referencePrice) / referencePrice : (referencePrice - entry) / referencePrice)
      : null;
    if (!bracket) {
      trade.lastReconcileError = "actual fill makes structural R invalid after conservative tick rounding";
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_INVALID_RISK", "ENTRY_ABORT_INVALID_RISK");
      return;
    }
    trade.stopPrice = bracket.stop;
    trade.takeProfitRaw = bracket.takeProfitRaw;
    trade.takeProfitPrice = bracket.takeProfit;
    trade.initialRiskPrice = bracket.riskPrice;
    trade.initialRiskPct = bracket.riskPrice / entry;
    trade.initialRiskDollar = bracket.riskPrice * qty;
    if (!(trade.initialRiskDollar > 0)) {
      trade.lastReconcileError = "initial dollar risk is not positive";
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_INVALID_RISK", "ENTRY_ABORT_INVALID_RISK");
      return;
    }
    trade.status = "PROTECTING";
    trade.lastReconcileError = null;
    this.store.save();
    try {
      await this.placeAndVerifyBrackets(trade);
      trade.status = "OPEN";
      trade.lastReconcileError = null;
      this.store.save();
      console.log(
        `[daily-range-lane] ENTRY_PROTECTED trade=${trade.tradeId} symbol=${trade.symbol} qty=${qty} entry=${entry} stop=${trade.stopPrice} tp=${trade.takeProfitPrice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trade.lastReconcileError = `bracket setup failed: ${message}`;
      this.store.save();
      await this.emergencyFlatten(trade, "ENTRY_ABORT_PROTECTION_FAILED", `ENTRY_ABORT_PROTECTION_FAILED:${message}`);
    }
  }

  private async placeAndVerifyBrackets(trade: DailyRangeTrade): Promise<void> {
    if (!finitePositive(trade.entryQty) || !finitePositive(trade.stopPrice) || !finitePositive(trade.takeProfitPrice)) {
      throw new Error("cannot create brackets without confirmed qty/stop/take-profit");
    }
    const account = await this.readSymbolAccount(trade.symbol);
    let pos = account.positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
    if (!pos) pos = await this.readVisiblePosition(trade.symbol);
    if (!pos || Math.sign(pos.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(pos.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
      throw new Error("exchange position does not exactly match lane-owned entry quantity");
    }
    if (pos.leverage !== DAILY_RANGE_LEVERAGE) {
      throw new Error(`exchange leverage ${pos.leverage} differs from required ${DAILY_RANGE_LEVERAGE}x`);
    }
    const existingStop = account.algos.find((algo) => algo.clientAlgoId === trade.stopClientAlgoId) ?? null;
    const existingTp = account.algos.find((algo) => algo.clientAlgoId === trade.takeProfitClientAlgoId) ?? null;
    if (existingStop) trade.stopAlgoOrderId = existingStop.algoId;
    if (existingTp) trade.takeProfitAlgoOrderId = existingTp.algoId;
    this.store.save();
    if (!trade.stopAlgoOrderId) {
      const stop = await this.submitAlgoOrRecover({
        trade,
        type: "STOP_MARKET",
        triggerPrice: trade.stopPrice,
        clientAlgoId: trade.stopClientAlgoId,
      });
      if (!stop) throw new Error("stop order outcome is unknown or absent");
      trade.stopAlgoOrderId = stop.algoId;
      this.store.save();
    }
    if (!trade.takeProfitAlgoOrderId) {
      const takeProfit = await this.submitAlgoOrRecover({
        trade,
        type: "TAKE_PROFIT_MARKET",
        triggerPrice: trade.takeProfitPrice,
        clientAlgoId: trade.takeProfitClientAlgoId,
      });
      if (!takeProfit) throw new Error("take-profit order outcome is unknown or absent");
      trade.takeProfitAlgoOrderId = takeProfit.algoId;
      this.store.save();
    }
    const active = await this.client.getOpenAlgoOrders(trade.symbol);
    const stopActive = active.some((algo) => algo.algoId === trade.stopAlgoOrderId || algo.clientAlgoId === trade.stopClientAlgoId);
    const tpActive = active.some((algo) => algo.algoId === trade.takeProfitAlgoOrderId || algo.clientAlgoId === trade.takeProfitClientAlgoId);
    if (!stopActive || !tpActive) {
      throw new Error(`protective bracket verification failed (stop=${stopActive}, takeProfit=${tpActive})`);
    }
  }

  private async submitAlgoOrRecover(input: {
    trade: DailyRangeTrade;
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
    triggerPrice: number;
    clientAlgoId: string;
  }): Promise<FuturesAlgoOrder | null> {
    try {
      return await this.client.placeAlgoOrder({
        symbol: input.trade.symbol,
        side: exitSide(input.trade.direction),
        type: input.type,
        quantity: input.trade.entryQty!,
        triggerPrice: input.triggerPrice,
        reduceOnly: true,
        clientAlgoId: input.clientAlgoId,
        workingType: "CONTRACT_PRICE",
      });
    } catch (error) {
      const active = await this.client.getOpenAlgoOrders(input.trade.symbol).catch(() => [] as FuturesAlgoOrder[]);
      const recovered = active.find((algo) => algo.clientAlgoId === input.clientAlgoId) ?? null;
      if (recovered) return recovered;
      if (orderWasExplicitlyRejected(error)) throw error;
      // Do not blindly resend an unknown conditional order. A naked position is
      // safer to flatten than to pair with a possibly-duplicated hidden bracket.
      return null;
    }
  }

  private abortTrade(trade: DailyRangeTrade, status: Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>, reason: string): void {
    trade.status = status;
    trade.abortReason = reason;
    trade.lastReconcileError = reason;
    if (!trade.exitTimestamp) trade.exitTimestamp = iso(this.nowMs());
    this.store.save();
  }

  private async reconcilePendingEntries(): Promise<void> {
    const pending = this.store.getState().trades.filter((trade) => trade.status === "ENTRY_SUBMITTING" || trade.status === "ENTRY_RECONCILING");
    for (const trade of pending) {
      const order = await this.queryEntryByClientId(trade);
      const terminalPartialFill = order !== null &&
        order.executedQty > EPSILON &&
        order.avgPrice > 0 &&
        !["NEW", "PARTIALLY_FILLED"].includes(order.status);
      if (order && (orderStatusFilled(order) || terminalPartialFill)) {
        let filter: FuturesSymbolFilters | null = null;
        try {
          filter = (await this.client.getExchangeFilters()).get(trade.symbol) ?? null;
        } catch {
          // Keep the lease pending: without tick filters a bracket cannot be made safe.
        }
        if (!filter) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "filled entry found but exchange filters are unavailable";
          this.store.save();
          continue;
        }
        await this.adoptConfirmedEntry(trade, order, trade.signalReferencePrice ?? order.avgPrice, filter);
        continue;
      }
      if (order && !["NEW", "PARTIALLY_FILLED"].includes(order.status)) {
        this.abortTrade(trade, "ENTRY_ABORT_EXECUTION_FAILED", `entry terminal without fill: ${order.status}`);
        continue;
      }
      try {
        const account = await this.readSymbolAccount(trade.symbol);
        const position = account.positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON);
        if (!position && order === null) {
          // queryOrderByClientId may be temporarily unreachable; keep the durable
          // lease rather than treating a missing response as proof of no order.
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "entry query remains inconclusive; no resend";
          this.store.save();
        } else if (position) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "exchange position exists but entry order cannot be proven by clientOrderId";
          this.store.disarm(iso(this.nowMs()), "unreconciled daily lane entry position");
        }
        if (order?.status === "PARTIALLY_FILLED" && position) {
          trade.status = "ENTRY_RECONCILING";
          trade.lastReconcileError = "market entry remains partially filled; waiting for terminal exchange state before exact-quantity protection";
          this.store.save();
          this.scheduleImmediateReconcile();
        }
      } catch (error) {
        trade.status = "ENTRY_RECONCILING";
        trade.lastReconcileError = `pending entry reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        this.store.save();
      }
    }
  }

  private async reconcileOpenTrades(): Promise<void> {
    const active = this.store.getState().trades.filter((trade) =>
      ["PROTECTING", "OPEN", "EXIT_RECONCILING"].includes(trade.status),
    );
    if (active.length === 0) return;
    let positions: FuturesPosition[];
    let algos: FuturesAlgoOrder[];
    try {
      [positions, algos] = await Promise.all([this.client.getPositions(), this.client.getOpenAlgoOrders()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const trade of active) trade.lastReconcileError = `account reconciliation unavailable: ${message}`;
      this.store.getState().runtime.reconciliationError = message;
      this.store.save();
      return;
    }
    for (const trade of active) {
      const position = positions.find((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (!position) {
        await this.finalizeFlatTrade(trade, algos);
        continue;
      }
      if (!finitePositive(trade.entryQty) || Math.sign(position.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(position.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
        trade.lastReconcileError = `P0 ownership mismatch: exchange=${position.positionAmt}, laneQty=${trade.entryQty ?? "null"}`;
        this.store.disarm(iso(this.nowMs()), `ownership mismatch on ${trade.symbol}`);
        continue;
      }
      this.updateExcursions(trade, position.markPrice);
      const stopActive = algos.some((algo) => algo.algoId === trade.stopAlgoOrderId || algo.clientAlgoId === trade.stopClientAlgoId);
      const tpActive = algos.some((algo) => algo.algoId === trade.takeProfitAlgoOrderId || algo.clientAlgoId === trade.takeProfitClientAlgoId);
      if (!stopActive || !tpActive) {
        trade.lastReconcileError = `protective bracket missing while position remains (stop=${stopActive}, tp=${tpActive})`;
        this.store.disarm(iso(this.nowMs()), `missing bracket on ${trade.symbol}`);
        this.store.save();
        await this.emergencyFlatten(trade, "ENTRY_ABORT_PROTECTION_FAILED", "missing exchange-native bracket while position open");
        continue;
      }
      // A past transport failure must not remain attached to a healthy, freshly
      // verified trade. Leaving it here made the status endpoint report a stale
      // 418 even after a later reconciliation had proved both native brackets.
      trade.lastReconcileError = null;
      if (trade.status === "PROTECTING") {
        trade.status = "OPEN";
      }
    }
    this.store.save();
  }

  private updateExcursions(trade: DailyRangeTrade, markPrice: number): void {
    if (!finitePositive(markPrice) || !finitePositive(trade.entryFillPrice) || !finitePositive(trade.initialRiskPrice)) return;
    const favorablePrice = trade.direction === "LONG" ? markPrice - trade.entryFillPrice : trade.entryFillPrice - markPrice;
    const r = favorablePrice / trade.initialRiskPrice;
    const pct = favorablePrice / trade.entryFillPrice;
    trade.lastMarkPrice = markPrice;
    trade.mfeR = Math.max(trade.mfeR ?? 0, r);
    trade.maeR = Math.min(trade.maeR ?? 0, r);
    trade.mfePct = Math.max(trade.mfePct ?? 0, pct);
    trade.maePct = Math.min(trade.maePct ?? 0, pct);
  }

  private async finalizeFlatTrade(trade: DailyRangeTrade, openAlgos: FuturesAlgoOrder[]): Promise<void> {
    if (this.closingTradeIds.has(trade.tradeId)) return;
    this.closingTradeIds.add(trade.tradeId);
    try {
      let exitReason: string | null = trade.exitReason;
      let exitOrderId: string | null = trade.exitOrderId;
      if (!exitOrderId) {
        const stop = await this.queryAlgoSafely(trade.stopAlgoOrderId);
        const tp = await this.queryAlgoSafely(trade.takeProfitAlgoOrderId);
        if (algoLooksTriggered(tp)) {
          exitReason = "TAKE_PROFIT";
          exitOrderId = tp?.actualOrderId ?? null;
        } else if (algoLooksTriggered(stop)) {
          exitReason = "STOP_LOSS";
          exitOrderId = stop?.actualOrderId ?? null;
        }
      }
      if (!exitOrderId || !exitReason) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = "exchange is flat but no owned exit order can yet be proven";
        this.store.save();
        return;
      }
      await this.cancelOpenSiblingOrders(trade, openAlgos);
      const positionAfterCancel = await this.client.getPositions(trade.symbol);
      if (positionAfterCancel.some((position) => position.symbol === trade.symbol && Math.abs(position.positionAmt) > EPSILON)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = "position reappeared during sibling cancellation";
        this.store.save();
        return;
      }
      const exit = await this.client.queryOrder(trade.symbol, exitOrderId);
      if (!orderStatusFilled(exit)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = `exit order ${exitOrderId} is not yet confirmed filled`;
        this.store.save();
        return;
      }
      trade.exitOrderId = exitOrderId;
      trade.exitReason = exitReason;
      trade.exitPrice = exit.avgPrice;
      trade.exitTimestamp = iso(exit.updateTime > 0 ? exit.updateTime : this.nowMs());
      await this.settleClosedTrade(trade, "CLOSED");
      console.log(`[daily-range-lane] TRADE_CLOSED trade=${trade.tradeId} symbol=${trade.symbol} reason=${exitReason}`);
    } catch (error) {
      trade.status = "EXIT_RECONCILING";
      trade.lastReconcileError = `flat-trade reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
    } finally {
      this.closingTradeIds.delete(trade.tradeId);
    }
  }

  private async queryAlgoSafely(algoId: string | null): Promise<FuturesAlgoOrder | null> {
    if (!algoId) return null;
    try {
      return await this.client.queryAlgoOrder(algoId);
    } catch {
      return null;
    }
  }

  private async cancelOpenSiblingOrders(trade: DailyRangeTrade, openAlgos?: FuturesAlgoOrder[]): Promise<void> {
    const active = openAlgos ?? await this.client.getOpenAlgoOrders(trade.symbol);
    for (const algo of active) {
      const own = algo.algoId === trade.stopAlgoOrderId || algo.algoId === trade.takeProfitAlgoOrderId ||
        algo.clientAlgoId === trade.stopClientAlgoId || algo.clientAlgoId === trade.takeProfitClientAlgoId;
      if (!own) continue;
      try {
        await this.client.cancelAlgoOrder(algo.algoId);
      } catch (error) {
        // A terminal/just-triggered sibling can return an error because it is no
        // longer cancelable. Re-read open orders before deciding it is unresolved.
        const retryOpen = await this.client.getOpenAlgoOrders(trade.symbol).catch(() => [] as FuturesAlgoOrder[]);
        if (retryOpen.some((candidate) => candidate.algoId === algo.algoId || candidate.clientAlgoId === algo.clientAlgoId)) {
          throw error;
        }
      }
    }
    const left = await this.client.getOpenAlgoOrders(trade.symbol);
    const ownLeft = left.filter((algo) =>
      algo.algoId === trade.stopAlgoOrderId || algo.algoId === trade.takeProfitAlgoOrderId ||
      algo.clientAlgoId === trade.stopClientAlgoId || algo.clientAlgoId === trade.takeProfitClientAlgoId,
    );
    if (ownLeft.length > 0) throw new Error(`owned bracket sibling remains open (${ownLeft.map((algo) => algo.algoId).join(",")})`);
  }

  private async settleClosedTrade(trade: DailyRangeTrade, terminalStatus: "CLOSED" | Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>): Promise<void> {
    if (!trade.entryOrderId || !trade.exitOrderId || !finitePositive(trade.initialRiskDollar)) {
      throw new Error("cannot settle without confirmed entry, exit, and initial dollar risk");
    }
    const start = Math.max(0, (toMs(trade.entrySubmittedAt) ?? this.nowMs()) - 10_000);
    const [fills, income] = await Promise.all([
      this.client.getUserTrades(trade.symbol, { startTime: start, limit: 1000 }),
      this.client.getIncomeHistory({ startTime: start, endTime: this.nowMs(), incomeType: "FUNDING_FEE", limit: 1000 }),
    ]);
    const ownIds = new Set([trade.entryOrderId, trade.exitOrderId]);
    const ownFills = fills.filter((fill) => ownIds.has(fill.orderId));
    if (!ownFills.some((fill) => fill.orderId === trade.exitOrderId)) {
      throw new Error("exchange user-trade ledger has not yet exposed the confirmed exit fill");
    }
    const gross = ownFills.reduce((sum, fill) => sum + fill.realizedPnl, 0);
    const fees = ownFills.reduce((sum, fill) => sum + Math.abs(fill.commission), 0);
    const funding = income
      .filter((entry) => entry.symbol === trade.symbol && entry.time >= start)
      .reduce((sum, entry) => sum + entry.income, 0);
    trade.grossPnlUsd = gross;
    trade.feesUsd = fees;
    trade.fundingUsd = funding;
    trade.netPnlUsd = gross - fees + funding;
    trade.grossR = gross / trade.initialRiskDollar;
    trade.realizedR = trade.netPnlUsd / trade.initialRiskDollar;
    const opened = toMs(trade.entryFilledAt) ?? toMs(trade.entrySubmittedAt) ?? this.nowMs();
    const closed = toMs(trade.exitTimestamp) ?? this.nowMs();
    trade.holdingDurationMs = Math.max(0, closed - opened);
    trade.status = terminalStatus;
    trade.lastReconcileError = null;
    this.store.save();
  }

  /** Close exactly one owned daily-lane trade. It never touches a basket or another lane. */
  async manualCloseTrade(tradeId: string): Promise<{ ok: boolean; reason: string | null; netPnlUsd: number | null }> {
    const trade = this.store.findTrade(tradeId);
    if (!trade) return { ok: false, reason: "daily lane trade not found", netPnlUsd: null };
    if (isTerminalTradeStatus(trade.status)) return { ok: false, reason: `trade is already ${trade.status}`, netPnlUsd: trade.netPnlUsd };
    await this.emergencyFlatten(trade, "CLOSED", "MANUAL_CLOSE");
    return {
      ok: trade.status === "CLOSED",
      reason: trade.status === "CLOSED" ? null : trade.lastReconcileError ?? `close remains ${trade.status}`,
      netPnlUsd: trade.netPnlUsd,
    };
  }

  /**
   * Market-close while leaving any existing protective orders active until exchange
   * flatness is proven. This ordering prevents a failed/manual market close from
   * turning a protected trade into a naked one.
   */
  private async emergencyFlatten(
    trade: DailyRangeTrade,
    terminalStatus: "CLOSED" | Extract<DailyRangeTradeStatus, `ENTRY_ABORT_${string}`>,
    reason: string,
  ): Promise<void> {
    if (this.closingTradeIds.has(trade.tradeId)) return;
    this.closingTradeIds.add(trade.tradeId);
    try {
      if (!finitePositive(trade.entryQty)) {
        this.abortTrade(trade, terminalStatus === "CLOSED" ? "ENTRY_ABORT_EXECUTION_FAILED" : terminalStatus, `${reason}: no confirmed owned quantity`);
        return;
      }
      const position = await this.readVisiblePosition(trade.symbol);
      if (!position) {
        // No quantity means there is nothing safe to market-close. Keep the lease only
        // if an exit identity cannot be proved by normal reconciliation.
        if (trade.exitOrderId) {
          await this.cancelOpenSiblingOrders(trade);
          await this.settleClosedTrade(trade, terminalStatus);
        } else {
          trade.status = "EXIT_RECONCILING";
          trade.lastReconcileError = `${reason}: exchange flat before an owned exit can be identified`;
          this.store.disarm(iso(this.nowMs()), `${reason}: confirmed entry not yet visible for safe flatten`);
          this.store.save();
          this.scheduleImmediateReconcile();
        }
        return;
      }
      if (Math.sign(position.positionAmt) !== directionSign(trade.direction) || Math.abs(Math.abs(position.positionAmt) - trade.entryQty) > Math.max(EPSILON, trade.entryQty * 1e-6)) {
        trade.status = "EXIT_RECONCILING";
        trade.lastReconcileError = `${reason}: refusing close due to ownership mismatch exchange=${position.positionAmt} lane=${trade.entryQty}`;
        this.store.disarm(iso(this.nowMs()), `ownership mismatch while emergency closing ${trade.symbol}`);
        return;
      }
      const clientId = trade.exitClientOrderId ?? exitClientId(trade.tradeId);
      trade.exitClientOrderId = clientId;
      trade.exitReason = reason;
      trade.status = "EXIT_RECONCILING";
      try {
        const book = await this.client.getBookTicker(trade.symbol);
        const reference = exitSide(trade.direction) === "SELL" ? book.bid : book.ask;
        trade.exitReferencePrice = finitePositive(reference) ? reference : null;
      } catch {
        // Exit safety must not depend on an auxiliary public quote. Keep the
        // missing reference explicit rather than fabricating zero slippage.
        trade.exitReferencePrice = null;
      }
      this.store.save();
      let order: FuturesOrder | null = null;
      try {
        order = await this.client.placeOrder({
          symbol: trade.symbol,
          side: exitSide(trade.direction),
          type: "MARKET",
          quantity: trade.entryQty,
          reduceOnly: true,
          newClientOrderId: clientId,
        });
      } catch (error) {
        try {
          order = await this.client.queryOrderByClientId(trade.symbol, clientId);
        } catch {
          if (orderWasExplicitlyRejected(error)) {
            trade.lastReconcileError = `${reason}: exit rejected: ${error instanceof Error ? error.message : String(error)}`;
          } else {
            trade.lastReconcileError = `${reason}: exit status unknown; protective brackets intentionally retained`;
          }
          this.store.save();
          return;
        }
      }
      const confirmed = await this.confirmFilledOrder(trade.symbol, order);
      if (!confirmed) {
        trade.lastReconcileError = `${reason}: exit fill not yet confirmed; protective brackets retained`;
        this.store.save();
        return;
      }
      const after = await this.client.getPositions(trade.symbol);
      if (after.some((row) => row.symbol === trade.symbol && Math.abs(row.positionAmt) > EPSILON)) {
        trade.lastReconcileError = `${reason}: market exit did not leave the owned symbol flat; brackets retained`;
        this.store.save();
        return;
      }
      trade.exitOrderId = confirmed.orderId;
      trade.exitPrice = confirmed.avgPrice;
      trade.exitSlippageBps = finitePositive(trade.exitReferencePrice)
        ? 10_000 * (trade.direction === "LONG"
          ? (trade.exitReferencePrice - confirmed.avgPrice) / trade.exitReferencePrice
          : (confirmed.avgPrice - trade.exitReferencePrice) / trade.exitReferencePrice)
        : null;
      trade.exitTimestamp = iso(confirmed.updateTime > 0 ? confirmed.updateTime : this.nowMs());
      await this.cancelOpenSiblingOrders(trade);
      await this.settleClosedTrade(trade, terminalStatus);
      console.log(`[daily-range-lane] ${reason} trade=${trade.tradeId} symbol=${trade.symbol} exit=${trade.exitPrice}`);
    } catch (error) {
      trade.status = "EXIT_RECONCILING";
      trade.lastReconcileError = `${reason}: flatten failed: ${error instanceof Error ? error.message : String(error)}`;
      this.store.save();
    } finally {
      this.closingTradeIds.delete(trade.tradeId);
    }
  }

  /** Controlled exchange canary.  It is deliberately separate from signal/trade history. */
  async runCanary(): Promise<DailyRangeCanaryEvidence> {
    if (this.environment !== "testnet") throw new Error("DRCANARY refuses non-testnet runtime");
    if (this.store.getState().control.mode === "ARMED") throw new Error("disarm daily lane before running a canary");
    if (!this.startupReconciled) await this.reconcileOnStartup();
    await this.ensureTodayRange();
    const now = this.nowMs();
    const evidence: DailyRangeCanaryEvidence = {
      canaryId: `DRCANARY-${now.toString(36)}`,
      at: iso(now),
      status: "RUNNING",
      symbol: null,
      side: "BUY",
      intendedNotionalUsd: DAILY_RANGE_TRADE_NOTIONAL_USD,
      leverage: DAILY_RANGE_LEVERAGE,
      entryOrderId: null,
      entryClientOrderId: null,
      entryFillPrice: null,
      entryQty: null,
      stopAlgoOrderId: null,
      takeProfitAlgoOrderId: null,
      closeOrderId: null,
      positionVerified: false,
      bracketVerified: false,
      bracketCancelled: false,
      closeVerified: false,
      orphanOrders: null,
      orphanPosition: null,
      failure: null,
    };
    this.store.getState().canaries.push(evidence);
    this.store.save();
    let claimed = false;
    try {
      const symbol = await this.selectCanarySymbol();
      if (!symbol) throw new Error("no liquid daily-universe symbol is exchange-flat and unoccupied for DRCANARY");
      evidence.symbol = symbol;
      if (!this.entryClaims.tryClaimEntrySymbol(symbol, "DRCANARY")) throw new Error("canary symbol is currently claimed by another entry path");
      claimed = true;
      const [filters, book, account] = await Promise.all([
        this.client.getExchangeFilters(),
        this.client.getBookTicker(symbol),
        this.readSymbolAccount(symbol),
      ]);
      const foreign = this.foreignAccountReason(symbol, account);
      if (foreign) throw new Error(`canary symbol became occupied: ${foreign}`);
      const filter = filters.get(symbol);
      const reference = book.ask ?? 0;
      if (!filter || !finitePositive(reference)) throw new Error("canary symbol lacks a valid filter/ask");
      const qty = clampQty(DAILY_RANGE_TRADE_NOTIONAL_USD / reference, filter);
      if (!qty || qty * reference + EPSILON < filter.minNotional) throw new Error("canary 25 USDT quantity is not executable");
      await this.client.setLeverage(symbol, DAILY_RANGE_LEVERAGE);
      const entryId = canaryClientId("E", symbol, now);
      evidence.entryClientOrderId = entryId;
      const entry = await this.submitCanaryMarketOrder({
        symbol,
        side: "BUY",
        quantity: qty,
        clientOrderId: entryId,
      });
      evidence.entryOrderId = entry.orderId;
      evidence.entryFillPrice = entry.avgPrice;
      evidence.entryQty = entry.executedQty;
      const afterEntry = await this.client.getPositions(symbol);
      const canaryPosition = afterEntry.find((row) => row.symbol === symbol && row.positionAmt > EPSILON) ?? null;
      if (!canaryPosition || Math.abs(canaryPosition.positionAmt - entry.executedQty) > Math.max(EPSILON, entry.executedQty * 1e-6) || canaryPosition.leverage !== DAILY_RANGE_LEVERAGE) {
        throw new Error("canary entry position/leverage did not match confirmed fill");
      }
      evidence.positionVerified = true;
      const stopPrice = roundToStep(entry.avgPrice * 0.90, filter.tickSize, "down");
      const tpPrice = roundToStep(entry.avgPrice * 1.10, filter.tickSize, "up");
      const stop = await this.client.placeAlgoOrder({
        symbol, side: "SELL", type: "STOP_MARKET", quantity: entry.executedQty, triggerPrice: stopPrice,
        reduceOnly: true, clientAlgoId: canaryClientId("SL", symbol, now), workingType: "CONTRACT_PRICE",
      });
      evidence.stopAlgoOrderId = stop.algoId;
      const tp = await this.client.placeAlgoOrder({
        symbol, side: "SELL", type: "TAKE_PROFIT_MARKET", quantity: entry.executedQty, triggerPrice: tpPrice,
        reduceOnly: true, clientAlgoId: canaryClientId("TP", symbol, now), workingType: "CONTRACT_PRICE",
      });
      evidence.takeProfitAlgoOrderId = tp.algoId;
      const bracket = await this.client.getOpenAlgoOrders(symbol);
      if (!bracket.some((algo) => algo.algoId === stop.algoId) || !bracket.some((algo) => algo.algoId === tp.algoId)) {
        throw new Error("canary protective bracket was not visible at exchange");
      }
      evidence.bracketVerified = true;
      await this.client.cancelAlgoOrder(stop.algoId);
      await this.client.cancelAlgoOrder(tp.algoId);
      const afterCancel = await this.client.getOpenAlgoOrders(symbol);
      if (afterCancel.some((algo) => algo.algoId === stop.algoId || algo.algoId === tp.algoId)) throw new Error("canary bracket cancellation left an open order");
      evidence.bracketCancelled = true;
      const closed = await this.submitCanaryMarketOrder({
        symbol,
        side: "SELL",
        quantity: entry.executedQty,
        reduceOnly: true,
        clientOrderId: canaryClientId("X", symbol, now),
      });
      evidence.closeOrderId = closed.orderId;
      const [afterClosePosition, finalRegularOrders, finalAlgoOrders] = await Promise.all([
        this.client.getPositions(symbol), this.client.getOpenOrders(symbol), this.client.getOpenAlgoOrders(symbol),
      ]);
      evidence.orphanPosition = afterClosePosition.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      evidence.orphanOrders = finalRegularOrders.filter((order) => order.symbol === symbol).length + finalAlgoOrders.filter((algo) => algo.symbol === symbol).length;
      if (evidence.orphanPosition || evidence.orphanOrders !== 0) throw new Error("canary cleanup left exchange exposure/order");
      evidence.closeVerified = true;
      evidence.status = "PASSED";
      this.store.save();
      console.log(`[daily-range-lane] DRCANARY_PASSED symbol=${symbol} entry=${entry.orderId} stop=${stop.algoId} tp=${tp.algoId} close=${closed.orderId}`);
      return evidence;
    } catch (error) {
      evidence.status = "FAILED";
      evidence.failure = error instanceof Error ? error.message : String(error);
      await this.cleanupCanary(evidence);
      this.store.save();
      console.error(`[daily-range-lane] DRCANARY_FAILED ${evidence.failure}`);
      return evidence;
    } finally {
      if (claimed && evidence.symbol) this.entryClaims.releaseEntrySymbol(evidence.symbol, "DRCANARY");
    }
  }

  private async selectCanarySymbol(): Promise<string | null> {
    const state = this.store.getState();
    const day = state.days[utcDate(this.nowMs())];
    const candidates = day?.universeSymbols ?? this.getUniverse().symbols;
    const preferred = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT"];
    const ordered = [...new Set(candidates.map(normalizeSymbol))].sort((a, b) => {
      const pa = preferred.indexOf(a);
      const pb = preferred.indexOf(b);
      return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb) || a.localeCompare(b);
    });
    for (const symbol of ordered) {
      if (this.store.hasActiveSymbolLease(symbol)) continue;
      try {
        const account = await this.readSymbolAccount(symbol);
        if (!this.foreignAccountReason(symbol, account)) return symbol;
      } catch {
        // A candidate that cannot be proven exchange-flat cannot be a canary.
      }
    }
    return null;
  }

  private async cleanupCanary(evidence: DailyRangeCanaryEvidence): Promise<void> {
    if (!evidence.symbol) return;
    const symbol = evidence.symbol;
    try {
      // A POST response may be unknown while the market order is still resting
      // at the exchange. Cancel only this canary's exact client id; never sweep
      // regular orders belonging to another strategy.
      if (evidence.entryClientOrderId) {
        const regular = await this.client.getOpenOrders(symbol);
        const ownEntry = regular.find((order) => order.clientOrderId === evidence.entryClientOrderId);
        if (ownEntry) await this.client.cancelOrder(symbol, ownEntry.orderId).catch(() => undefined);
      }
      const positions = await this.client.getPositions(symbol);
      const position = positions.find((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON) ?? null;
      if (position) {
        const clientId = canaryClientId("X", symbol, this.nowMs());
        const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
        try {
          const order = await this.submitCanaryMarketOrder({
            symbol,
            side,
            quantity: Math.abs(position.positionAmt),
            reduceOnly: true,
            clientOrderId: clientId,
          });
          evidence.closeOrderId = order.orderId;
        } catch {
          // Evidence below reports any remaining orphan; never hide a failed cleanup.
        }
      }
      // Keep protection active until the emergency close is actually flat.  A
      // canary must never teach the production path a naked-position sequence.
      const afterExit = await this.client.getPositions(symbol);
      const stillOpen = afterExit.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      if (!stillOpen) {
        const algos = await this.client.getOpenAlgoOrders(symbol);
        for (const algo of algos) {
          if (algo.algoId === evidence.stopAlgoOrderId || algo.algoId === evidence.takeProfitAlgoOrderId || algo.clientAlgoId.startsWith("DRCANARY")) {
            await this.client.cancelAlgoOrder(algo.algoId).catch(() => undefined);
          }
        }
      }
      const [afterPositions, regular, finalAlgos] = await Promise.all([this.client.getPositions(symbol), this.client.getOpenOrders(symbol), this.client.getOpenAlgoOrders(symbol)]);
      evidence.orphanPosition = afterPositions.some((row) => row.symbol === symbol && Math.abs(row.positionAmt) > EPSILON);
      evidence.orphanOrders = regular.filter((order) => order.symbol === symbol).length + finalAlgos.filter((algo) => algo.symbol === symbol).length;
    } catch (cleanupError) {
      evidence.failure = `${evidence.failure ?? "canary failed"}; cleanup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  }
}

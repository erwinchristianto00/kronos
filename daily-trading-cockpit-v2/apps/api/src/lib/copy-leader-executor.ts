/**
 * Direct outside-Kronos Copy Leader sleeve.
 *
 * This is deliberately a TESTNET-only executor.  Its source is Binance's
 * public Copy Trading order-history feed, while every private destination
 * request goes through the one BinanceFuturesPrivateClient already shared by
 * Kronos.  It never has, accepts, or reads a mainnet account credential.
 *
 * Binance's public order feed currently has no native order/trade id.  A
 * canonical source event id is therefore derived from the immutable observed
 * order record.  Before a row can become an order, the executor rejects any
 * duplicate/ambiguous canonical or logical source key.  This is intentionally
 * fail-closed: inventing a second order from an ambiguous public row is worse
 * than missing a copy event.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BinanceFuturesPrivateError,
  resolveConfirmedFillPrice,
  type BinanceFuturesPrivateClient,
  type FuturesBalance,
  type FuturesOrder,
  type FuturesPosition,
  type FuturesSymbolFilters,
  type FuturesUserTrade,
} from "./binance-futures-private.js";

export const COPY_LEADER_STRATEGY = "COPY_LEADER";
/** Stable reporting lane for the direct Testnet copy sleeve.  It is deliberately
 * separate from every Kronos strategy lane: this is an execution/accounting
 * label, never a signal-selection input. */
export const COPY_LEADER_TIMELINE_LANE_ID = "COPY_LEADER";
export const COPY_LEADER_DESTINATION_ENDPOINT = "https://testnet.binancefuture.com";
export const COPY_LEADER_SOURCE_ORDER_HISTORY_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
export const COPY_LEADER_SOURCE_DETAIL_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail";

export type CopyDirection = "LONG" | "SHORT";
export type CopyLeaderStateName =
  | "DISABLED"
  | "PENDING_COVERAGE"
  | "BLOCKED_TESTNET_SYMBOL_COVERAGE"
  | "BLOCKED_SOURCE_EVENT_ID_AMBIGUOUS"
  | "BLOCKED_SOURCE_EVENT_SEMANTICS"
  | "PAUSED_KRONOS_OVERLAP"
  | "PAUSED_RECONCILIATION_REQUIRED"
  | "PAUSED_ORDER_SUBMISSION_INCONCLUSIVE"
  | "PAUSED_KILL_SWITCH"
  | "ARMED_WAITING_SIGNAL"
  | "EXECUTING"
  | "SOURCE_API_ERROR";

export interface CopyLeaderDefinition {
  id: string;
  name: string;
  tier: "B-Mid" | "B-Low";
  sleeveShare: number;
}

export const COPY_LEADER_DEFINITIONS: readonly CopyLeaderDefinition[] = [
  { id: "4908633203782592768", name: "玄冥二老", tier: "B-Mid", sleeveShare: 0.5 },
  { id: "5121701902529609728", name: "豆壳资管 ALPHA", tier: "B-Low", sleeveShare: 0.3 },
  { id: "4976493653311741953", name: "Tianhao8888", tier: "B-Low", sleeveShare: 0.2 },
] as const;

const STORE_VERSION = 1;
const EVENT_RETENTION = 20_000;
const SOURCE_COVERAGE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const SOURCE_CURSOR_LOOKBACK_MS = 10 * 60_000;
const SOURCE_COVERAGE_REFRESH_MS = 5 * 60_000;
// Binance silently caps this public endpoint to 200 rows even if pageSize is
// higher.  The next page is identified by data.indexValue, never pageNumber.
// Keep a finite cap so partial history can never masquerade as coverage.
const SOURCE_ORDER_MAX_PAGES = 32;
const SOURCE_ORDER_RETRY_DELAYS_MS = [750, 1_500, 3_000] as const;
const EPS = 1e-8;

export interface CopyLeaderRuntimeConfig {
  enabled: boolean;
  destinationEndpoint: string;
  pollMs: number;
  stalenessMs: number;
  sourceLookbackMs: number;
  leverage: number;
  configErrors: string[];
}

function positiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function parseCopyLeaderRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CopyLeaderRuntimeConfig {
  const enabledIntent = env.COPY_LEADER_ENABLED === "1";
  const destinationEndpoint = env.COPY_LEADER_DESTINATION_ENDPOINT ?? COPY_LEADER_DESTINATION_ENDPOINT;
  const configErrors: string[] = [];
  if (destinationEndpoint !== COPY_LEADER_DESTINATION_ENDPOINT) {
    configErrors.push(
      "COPY_LEADER_DESTINATION_ENDPOINT must equal " + COPY_LEADER_DESTINATION_ENDPOINT,
    );
  }
  if (enabledIntent && env.LIVE_BINANCE_ENV !== "testnet") {
    configErrors.push("COPY_LEADER_ENABLED is TESTNET-only and LIVE_BINANCE_ENV is not testnet");
  }
  return {
    enabled: enabledIntent && configErrors.length === 0,
    destinationEndpoint,
    pollMs: positiveInteger(env.COPY_LEADER_SOURCE_POLL_MS, 15_000, 5_000, 60_000),
    stalenessMs: positiveInteger(env.COPY_LEADER_SOURCE_STALENESS_MS, 120_000, 1_000, 10 * 60_000),
    sourceLookbackMs: positiveInteger(env.COPY_LEADER_SOURCE_LOOKBACK_MS, SOURCE_CURSOR_LOOKBACK_MS, 120_000, 60 * 60_000),
    // Fixed 1x makes the stated sleeve limits true margin limits rather than
    // an assumed leverage conversion.  Source quantity is still proportional.
    leverage: 1,
    configErrors,
  };
}

export interface CopySourceOrder {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: string;
  type: string;
  executedQty: number;
  avgPrice: number;
  totalPnl: number;
  orderTimeMs: number;
  orderUpdateTimeMs: number;
  sourceTimestampMs: number;
  sourceEventId: string;
  sourceLogicalKey: string;
  raw: Record<string, unknown>;
}

export interface CopyLeaderCoverage {
  checkedAt: string;
  sourceEventCount: number;
  eligibleEventCount: number;
  unavailableEventCount: number;
  coveragePct: number | null;
  symbols: Array<{ symbol: string; events: number; testnetEligible: boolean }>;
  kronosOverlapSymbols: string[];
}

export interface CopyEventLedgerRow {
  strategy: typeof COPY_LEADER_STRATEGY;
  sourceEventId: string;
  sourceLogicalKey: string;
  leaderId: string;
  sourceTimestamp: string;
  sourceTimestampMs: number;
  /** Price/quantity observed on the public leader event.  Optional so the
   * pre-dashboard ledger remains readable without inventing legacy values. */
  sourceReferencePrice?: number | null;
  sourceExecutedQty?: number | null;
  symbol: string;
  direction: CopyDirection | null;
  action: "ENTRY" | "EXIT" | "CURSOR_SEEDED" | "CONTROL_CLOSE";
  status:
    | "CURSOR_SEEDED"
    | "SKIPPED_STALE_SOURCE_EVENT"
    | "SKIPPED_TESTNET_SYMBOL_UNAVAILABLE"
    | "SKIPPED_UNTRACKED_SOURCE_EXIT"
    | "SKIPPED_KRONOS_PRIORITY_GATE"
    | "SKIPPED_MIN_NOTIONAL"
    | "SKIPPED_SYMBOL_IN_FLIGHT"
    | "SKIPPED_BUDGET_CAP"
    | "ORDER_SUBMISSION_PENDING"
    | "ORDER_REJECTED"
    | "ORDER_SUBMISSION_INCONCLUSIVE"
    | "FILLED"
    | "CLOSED"
    | "ACCOUNTING_INCOMPLETE"
    | "PAUSED_KRONOS_OVERLAP";
  reason: string | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  exchangeFillIds: string[];
  requestedQty: number | null;
  filledQty: number | null;
  fillPrice: number | null;
  fillPriceConfirmed: boolean | null;
  feeUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CopyOwnedLot {
  lotId: string;
  qty: number;
  entryPrice: number;
  entryFeeUsd: number | null;
  reservationId: string | null;
  entryOrderId: string;
  entryClientOrderId: string;
  openedAt: string;
}

export interface CopyOwnedPosition {
  strategy: typeof COPY_LEADER_STRATEGY;
  ownerPositionId: string;
  leaderId: string;
  symbol: string;
  direction: CopyDirection;
  qty: number;
  entryPrice: number;
  status: "OPEN" | "CLOSED" | "ACCOUNTING_INCOMPLETE";
  openedAt: string;
  closedAt: string | null;
  sourceTrackedQty: number;
  realisedPnlUsd: number;
  feesUsd: number | null;
  lots: CopyOwnedLot[];
  /** Durable source lineage. New rows write these ids at fill time; older rows
   * remain displayable but honestly show unavailable source-price detail. */
  sourceEntryEventIds?: string[];
  sourceExitEventIds?: string[];
  lastExitReason?: "EXIT" | "CONTROL_CLOSE" | null;
  reconciliation: {
    lastCheckedAt: string | null;
    exchangeQty: number | null;
    expectedQty: number;
    state: "PENDING" | "MATCHED" | "MISMATCH";
    reason: string | null;
  };
}

/** One or more source events rolled into a copied entry/exit.  Scaling can
 * turn one leader position into multiple fills, so reporting aggregates the
 * exact durable rows instead of pretending there was always one order. */
export interface CopyLeaderTradeEventSummary {
  sourceEventIds: string[];
  sourceTimestamp: string | null;
  firstObservedAt: string | null;
  completedAt: string | null;
  sourceReferencePrice: number | null;
  sourceQty: number | null;
  testnetFillPrice: number | null;
  testnetFilledQty: number | null;
  feeUsd: number | null;
  clientOrderIds: string[];
  exchangeOrderIds: string[];
  fillIds: string[];
}

/** Sanitised owner-side view for the Testnet dashboard.  The exchange remains
 * netted by symbol; this is the Copy Sleeve's durable attribution layer. */
export interface CopyLeaderOpenPositionReport {
  ownerPositionId: string;
  leaderId: string;
  leaderName: string;
  leaderTier: string;
  symbol: string;
  direction: CopyDirection;
  qty: number;
  entryPrice: number;
  status: CopyOwnedPosition["status"];
  openedAt: string;
  sourceTrackedQty: number;
  sourceEntry: CopyLeaderTradeEventSummary | null;
  reconciliation: CopyOwnedPosition["reconciliation"];
}

/** A fully reconciled copy-owned position.  `comparable=false` means the
 * actual Testnet P&L is still shown, but it was closed by a control path rather
 * than a matching fresh source exit and must not be used as leader-edge proof. */
export interface CopyLeaderClosedTradeReport extends Omit<CopyLeaderOpenPositionReport, "status" | "sourceTrackedQty" | "reconciliation"> {
  closedAt: string;
  netRealizedPnlUsd: number;
  grossRealizedPnlUsd: number | null;
  feesUsd: number | null;
  sourceExit: CopyLeaderTradeEventSummary | null;
  closeKind: "SOURCE_EXIT" | "EXTERNAL_CONTROL_CLOSE";
  comparable: boolean;
  sourcePriceReturnPct: number | null;
  copyPriceReturnPct: number | null;
  priceReplicationGapPct: number | null;
}

interface PersistedLeader {
  id: string;
  name: string;
  tier: string;
  sleeveShare: number;
  state: CopyLeaderStateName;
  stateReason: string | null;
  activationCursorAtMs: number | null;
  coverage: CopyLeaderCoverage | null;
  sourceMarginBalanceUsd: number | null;
  sourceMarginBalanceCheckedAt: string | null;
  lastPollAt: string | null;
}

interface CopySleeveSnapshot {
  checkedAt: string;
  availableBalanceUsd: number | null;
  equityUsd: number | null;
  sleeveMarginBudgetUsd: number | null;
  totalGrossCapUsd: number | null;
  perSymbolGrossCapUsd: number | null;
}

interface CopyLeaderPersistentState {
  version: number;
  createdAt: string;
  updatedAt: string;
  leaders: Record<string, PersistedLeader>;
  sleeve: CopySleeveSnapshot | null;
  events: CopyEventLedgerRow[];
  positions: CopyOwnedPosition[];
  lastError: string | null;
}

export class CopyLeaderStore {
  private readonly file: string;
  private state: CopyLeaderPersistentState;

  constructor(dataDir = "data", fileName = "copy-leader-executor.json", nowIso: () => string = () => new Date().toISOString()) {
    this.file = resolve(dataDir, fileName);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // save() below remains best effort; a store failure never submits a retry.
    }
    this.state = this.load(nowIso);
  }

  private load(nowIso: () => string): CopyLeaderPersistentState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CopyLeaderPersistentState;
        if (
          parsed &&
          parsed.version === STORE_VERSION &&
          parsed.leaders &&
          Array.isArray(parsed.events) &&
          Array.isArray(parsed.positions)
        ) {
          return parsed;
        }
      }
    } catch {
      // A corrupt state must fail closed at reconciliation rather than be reused.
    }
    const now = nowIso();
    return {
      version: STORE_VERSION,
      createdAt: now,
      updatedAt: now,
      leaders: {},
      sleeve: null,
      events: [],
      positions: [],
      lastError: null,
    };
  }

  getState(): CopyLeaderPersistentState {
    return this.state;
  }

  save(nowIso: () => string = () => new Date().toISOString()): boolean {
    try {
      this.state.updatedAt = nowIso();
      if (this.state.events.length > EVENT_RETENTION) {
        this.state.events = this.state.events
          .slice()
          .sort((a, b) => b.sourceTimestampMs - a.sourceTimestampMs)
          .slice(0, EVENT_RETENTION);
      }
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch {
      // The executor will not retry an ambiguous submission merely because
      // persistence failed.  The exchange client order id remains queryable.
      return false;
    }
  }
}

type CopyClient = Pick<
  BinanceFuturesPrivateClient,
  | "getBalances"
  | "getPositions"
  | "getExchangeFilters"
  | "getMarkPrice"
  | "setLeverage"
  | "placeOrder"
  | "queryOrder"
  | "queryOrderByClientId"
  | "getUserTrades"
>;

type ExposureGateway = {
  reserve: (req: {
    executorId: string;
    basketId?: string;
    symbol: string;
    direction: CopyDirection;
    requestedNotionalUsd: number;
    clientOrderId: string;
  }) => { ok: boolean; reservationId: string | null; reason?: string };
  commitReservation: (reservationId: string, filled: { qty: number; avgPrice: number }) => void;
  releaseReservation: (reservationId: string, reason: string) => void;
  releaseCommittedReservation?: (reservationId: string, closedQty: number, reason: string) => void;
};

export interface CopyLeaderManagedPosition {
  symbol: string;
  direction: CopyDirection;
  qty: number;
  entryPrice: number;
}

export interface CopyLeaderExecutorOptions {
  client: CopyClient;
  exposure: ExposureGateway;
  store?: CopyLeaderStore;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  leaders?: readonly CopyLeaderDefinition[];
  nowMs?: () => number;
  getKronosUniverse: () => ReadonlySet<string>;
  canOpenNewEntries: () => boolean;
  tryClaimEntrySymbol?: (symbol: string) => boolean;
  releaseEntrySymbol?: (symbol: string) => void;
  updatePositionSnapshot?: (positions: ReadonlyArray<FuturesPosition>) => void;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function milliseconds(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 100_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const source = value as Record<string, unknown>;
  return "{" + Object.keys(source).sort().map((key) => JSON.stringify(key) + ":" + stableJson(source[key])).join(",") + "}";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceOrderIdentity(leaderId: string, raw: Record<string, unknown>): {
  sourceEventId: string;
  sourceLogicalKey: string;
} {
  const logical = {
    leaderId,
    orderTime: raw.orderTime,
    symbol: raw.symbol,
    side: raw.side,
    positionSide: raw.positionSide,
    type: raw.type,
  };
  return {
    sourceEventId: "BAPI_ORDER_V1_" + digest(leaderId + "|" + stableJson(raw)),
    sourceLogicalKey: "BAPI_LOGICAL_V1_" + digest(stableJson(logical)),
  };
}

export function normalizeCopySourceOrder(leaderId: string, raw: Record<string, unknown>): CopySourceOrder | null {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  const side = raw.side === "SELL" ? "SELL" : raw.side === "BUY" ? "BUY" : null;
  const positionSide = typeof raw.positionSide === "string" ? raw.positionSide.trim().toUpperCase() : "";
  const executedQty = numberOrNull(raw.executedQty);
  const avgPrice = numberOrNull(raw.avgPrice);
  const orderTimeMs = milliseconds(raw.orderTime);
  const orderUpdateTimeMs = milliseconds(raw.orderUpdateTime);
  if (
    !symbol ||
    !side ||
    !positionSide ||
    !(executedQty !== null && executedQty > 0) ||
    !(avgPrice !== null && avgPrice > 0) ||
    orderTimeMs === null
  ) {
    return null;
  }
  const normalizedOrderUpdateTimeMs = orderUpdateTimeMs ?? orderTimeMs;
  const identity = sourceOrderIdentity(leaderId, raw);
  return {
    symbol,
    side,
    positionSide,
    type: typeof raw.type === "string" ? raw.type.toUpperCase() : "UNKNOWN",
    executedQty,
    avgPrice,
    totalPnl: numberOrNull(raw.totalPnl) ?? 0,
    orderTimeMs,
    orderUpdateTimeMs: normalizedOrderUpdateTimeMs,
    sourceTimestampMs: normalizedOrderUpdateTimeMs,
    sourceEventId: identity.sourceEventId,
    sourceLogicalKey: identity.sourceLogicalKey,
    raw,
  };
}

export function explicitSourceAction(order: CopySourceOrder): { action: "ENTRY" | "EXIT"; direction: CopyDirection } | null {
  if (order.positionSide === "LONG") {
    return { action: order.side === "BUY" ? "ENTRY" : "EXIT", direction: "LONG" };
  }
  if (order.positionSide === "SHORT") {
    return { action: order.side === "SELL" ? "ENTRY" : "EXIT", direction: "SHORT" };
  }
  return null;
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function floorToStep(value: number, step: number, precision: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const floored = Math.floor((value + EPS) / step) * step;
  const digits = Math.max(0, Math.min(16, precision));
  return Number(floored.toFixed(digits));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function copyClientOrderId(prefix: "E" | "X" | "K", sourceEventId: string): string {
  // Binance accepts at most 36 characters.  Hash characters are lowercase
  // hexadecimal and the prefix distinguishes entry/exit/control attempts.
  return "CL" + prefix + sourceEventId.replace(/[^A-Za-z0-9]/g, "").slice(-31);
}

function sourceEventRow(
  order: CopySourceOrder,
  leaderId: string,
  action: CopyEventLedgerRow["action"],
  direction: CopyDirection | null,
  status: CopyEventLedgerRow["status"],
  nowIso: string,
  reason: string | null = null,
): CopyEventLedgerRow {
  return {
    strategy: COPY_LEADER_STRATEGY,
    sourceEventId: order.sourceEventId,
    sourceLogicalKey: order.sourceLogicalKey,
    leaderId,
    sourceTimestamp: iso(order.sourceTimestampMs),
    sourceTimestampMs: order.sourceTimestampMs,
    sourceReferencePrice: order.avgPrice,
    sourceExecutedQty: order.executedQty,
    symbol: order.symbol,
    direction,
    action,
    status,
    reason,
    clientOrderId: null,
    exchangeOrderId: null,
    exchangeFillIds: [],
    requestedQty: null,
    filledQty: null,
    fillPrice: null,
    fillPriceConfirmed: null,
    feeUsd: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export class CopyLeaderExecutor {
  private readonly client: CopyClient;
  private readonly exposure: ExposureGateway;
  private readonly store: CopyLeaderStore;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly leaders: readonly CopyLeaderDefinition[];
  private readonly nowMs: () => number;
  private readonly getKronosUniverse: () => ReadonlySet<string>;
  private readonly canOpenNewEntries: () => boolean;
  private readonly tryClaimEntrySymbol: (symbol: string) => boolean;
  private readonly releaseEntrySymbol: (symbol: string) => void;
  private readonly updatePositionSnapshot: (positions: ReadonlyArray<FuturesPosition>) => void;
  private readonly config: CopyLeaderRuntimeConfig;
  private running = false;

  constructor(opts: CopyLeaderExecutorOptions) {
    this.client = opts.client;
    this.exposure = opts.exposure;
    this.store = opts.store ?? new CopyLeaderStore();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.env = opts.env ?? process.env;
    this.leaders = opts.leaders ?? COPY_LEADER_DEFINITIONS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.getKronosUniverse = opts.getKronosUniverse;
    this.canOpenNewEntries = opts.canOpenNewEntries;
    this.tryClaimEntrySymbol = opts.tryClaimEntrySymbol ?? (() => true);
    this.releaseEntrySymbol = opts.releaseEntrySymbol ?? (() => {});
    this.updatePositionSnapshot = opts.updatePositionSnapshot ?? (() => {});
    this.config = parseCopyLeaderRuntimeConfig(this.env);
    this.ensureLeaderRows();
  }

  private nowIso(): string {
    return iso(this.nowMs());
  }

  private ensureLeaderRows(): void {
    const state = this.store.getState();
    for (const leader of this.leaders) {
      if (state.leaders[leader.id]) continue;
      state.leaders[leader.id] = {
        id: leader.id,
        name: leader.name,
        tier: leader.tier,
        sleeveShare: leader.sleeveShare,
        state: this.config.enabled ? "PENDING_COVERAGE" : "DISABLED",
        stateReason: this.config.configErrors[0] ?? null,
        activationCursorAtMs: null,
        coverage: null,
        sourceMarginBalanceUsd: null,
        sourceMarginBalanceCheckedAt: null,
        lastPollAt: null,
      };
    }
    this.store.save(() => this.nowIso());
  }

  private leaderState(leaderId: string): PersistedLeader {
    const row = this.store.getState().leaders[leaderId];
    if (!row) throw new Error("copy leader missing from store: " + leaderId);
    return row;
  }

  private setLeaderState(leaderId: string, state: CopyLeaderStateName, reason: string | null): void {
    const row = this.leaderState(leaderId);
    row.state = state;
    row.stateReason = reason;
  }

  private eventById(sourceEventId: string): CopyEventLedgerRow | null {
    return this.store.getState().events.find((event) => event.sourceEventId === sourceEventId) ?? null;
  }

  private eventByLogicalKey(sourceLogicalKey: string): CopyEventLedgerRow | null {
    return this.store.getState().events.find((event) => event.sourceLogicalKey === sourceLogicalKey) ?? null;
  }

  private upsertEvent(row: CopyEventLedgerRow): CopyEventLedgerRow {
    const state = this.store.getState();
    const existing = state.events.find((event) => event.sourceEventId === row.sourceEventId);
    if (existing) {
      Object.assign(existing, row, { createdAt: existing.createdAt, updatedAt: this.nowIso() });
      return existing;
    }
    state.events.push(row);
    return row;
  }

  private ownedPosition(leaderId: string, symbol: string, direction: CopyDirection): CopyOwnedPosition | null {
    return this.store.getState().positions.find(
      (position) =>
        position.leaderId === leaderId &&
        position.symbol === symbol &&
        position.direction === direction &&
        position.status !== "CLOSED" &&
        position.qty > EPS,
    ) ?? null;
  }

  private openOwnedPositions(leaderId?: string): CopyOwnedPosition[] {
    return this.store.getState().positions.filter(
      (position) => position.status !== "CLOSED" && position.qty > EPS && (!leaderId || position.leaderId === leaderId),
    );
  }

  managedPositions(): CopyLeaderManagedPosition[] {
    return this.openOwnedPositions().map((position) => ({
      symbol: position.symbol,
      direction: position.direction,
      qty: position.qty,
      entryPrice: position.entryPrice,
    }));
  }

  managedNetQty(): Map<string, number> {
    const net = new Map<string, number>();
    for (const position of this.openOwnedPositions()) {
      const signed = position.direction === "LONG" ? position.qty : -position.qty;
      net.set(position.symbol, (net.get(position.symbol) ?? 0) + signed);
    }
    return net;
  }

  private definitionForLeader(leaderId: string): CopyLeaderDefinition {
    return this.leaders.find((leader) => leader.id === leaderId) ?? {
      id: leaderId,
      name: leaderId,
      tier: "B-Low",
      sleeveShare: 0,
    };
  }

  private eventsForIds(ids: readonly string[] | undefined): CopyEventLedgerRow[] {
    if (!ids || ids.length === 0) return [];
    const idSet = new Set(ids);
    return this.store.getState().events
      .filter((event) => idSet.has(event.sourceEventId))
      .sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.createdAt.localeCompare(right.createdAt));
  }

  private entryEventsForPosition(position: CopyOwnedPosition): CopyEventLedgerRow[] {
    const explicit = this.eventsForIds(position.sourceEntryEventIds);
    if (explicit.length > 0) return explicit;
    // A pre-reporting row did not yet persist source ids.  Open legacy lots do
    // retain their Testnet client ids, so recover only that safe subset. Closed
    // legacy rows intentionally remain source-detail unavailable rather than
    // being heuristically joined to an unrelated later leader event.
    const legacyClientIds = new Set(position.lots.map((lot) => lot.entryClientOrderId).filter(Boolean));
    if (legacyClientIds.size === 0) return [];
    return this.store.getState().events
      .filter((event) => event.action === "ENTRY" && event.leaderId === position.leaderId && legacyClientIds.has(event.clientOrderId ?? ""))
      .sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.createdAt.localeCompare(right.createdAt));
  }

  private exitEventsForPosition(position: CopyOwnedPosition): CopyEventLedgerRow[] {
    return this.eventsForIds(position.sourceExitEventIds);
  }

  private summariseTradeEvents(events: readonly CopyEventLedgerRow[], select: "FIRST" | "LAST"): CopyLeaderTradeEventSummary | null {
    if (events.length === 0) return null;
    const sorted = events.slice().sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.createdAt.localeCompare(right.createdAt));
    const selected = select === "FIRST" ? sorted[0]! : sorted[sorted.length - 1]!;
    const weightedPrice = (priceOf: (event: CopyEventLedgerRow) => number | null | undefined, qtyOf: (event: CopyEventLedgerRow) => number | null | undefined): number | null => {
      let weighted = 0;
      let qty = 0;
      for (const event of sorted) {
        const price = priceOf(event);
        const weight = qtyOf(event);
        if (!finitePositive(price) || !finitePositive(weight)) continue;
        weighted += price * weight;
        qty += weight;
      }
      return qty > 0 ? weighted / qty : null;
    };
    const sumKnown = (valueOf: (event: CopyEventLedgerRow) => number | null | undefined): number | null => {
      if (sorted.some((event) => valueOf(event) === null || valueOf(event) === undefined || !Number.isFinite(valueOf(event)))) return null;
      return sorted.reduce((sum, event) => sum + Number(valueOf(event)), 0);
    };
    const sourceQty = sumKnown((event) => event.sourceExecutedQty);
    const testnetFilledQty = sumKnown((event) => event.filledQty);
    return {
      sourceEventIds: sorted.map((event) => event.sourceEventId),
      sourceTimestamp: selected.sourceTimestamp,
      firstObservedAt: sorted.map((event) => event.createdAt).sort()[0] ?? null,
      completedAt: sorted.map((event) => event.updatedAt).sort().at(-1) ?? null,
      sourceReferencePrice: weightedPrice((event) => event.sourceReferencePrice, (event) => event.sourceExecutedQty),
      sourceQty,
      testnetFillPrice: weightedPrice((event) => event.fillPrice, (event) => event.filledQty),
      testnetFilledQty,
      feeUsd: sumKnown((event) => event.feeUsd),
      clientOrderIds: Array.from(new Set(sorted.map((event) => event.clientOrderId).filter((value): value is string => Boolean(value)))),
      exchangeOrderIds: Array.from(new Set(sorted.map((event) => event.exchangeOrderId).filter((value): value is string => Boolean(value)))),
      fillIds: Array.from(new Set(sorted.flatMap((event) => event.exchangeFillIds))),
    };
  }

  getOpenPositionReports(): CopyLeaderOpenPositionReport[] {
    return this.openOwnedPositions().map((position) => {
      const leader = this.definitionForLeader(position.leaderId);
      return {
        ownerPositionId: position.ownerPositionId,
        leaderId: position.leaderId,
        leaderName: leader.name,
        leaderTier: leader.tier,
        symbol: position.symbol,
        direction: position.direction,
        qty: position.qty,
        entryPrice: position.entryPrice,
        status: position.status,
        openedAt: position.openedAt,
        sourceTrackedQty: position.sourceTrackedQty,
        sourceEntry: this.summariseTradeEvents(this.entryEventsForPosition(position), "FIRST"),
        reconciliation: { ...position.reconciliation },
      };
    }).sort((left, right) => right.openedAt.localeCompare(left.openedAt) || left.symbol.localeCompare(right.symbol));
  }

  getClosedTrades(): CopyLeaderClosedTradeReport[] {
    return this.store.getState().positions
      .filter((position) => position.status === "CLOSED" && Boolean(position.closedAt))
      .map((position) => {
        const leader = this.definitionForLeader(position.leaderId);
        const entry = this.summariseTradeEvents(this.entryEventsForPosition(position), "FIRST");
        const exits = this.exitEventsForPosition(position);
        const exit = this.summariseTradeEvents(exits, "LAST");
        const latestExit = exits.at(-1) ?? null;
        const closeKind = position.lastExitReason === "CONTROL_CLOSE" || latestExit?.action === "CONTROL_CLOSE"
          ? "EXTERNAL_CONTROL_CLOSE" as const
          : "SOURCE_EXIT" as const;
        const directionSign = position.direction === "LONG" ? 1 : -1;
        const sourcePriceReturnPct = finitePositive(entry?.sourceReferencePrice) && finitePositive(exit?.sourceReferencePrice)
          ? ((exit.sourceReferencePrice - entry.sourceReferencePrice) / entry.sourceReferencePrice) * directionSign * 100
          : null;
        const copyPriceReturnPct = finitePositive(entry?.testnetFillPrice) && finitePositive(exit?.testnetFillPrice)
          ? ((exit.testnetFillPrice - entry.testnetFillPrice) / entry.testnetFillPrice) * directionSign * 100
          : null;
        return {
          ownerPositionId: position.ownerPositionId,
          leaderId: position.leaderId,
          leaderName: leader.name,
          leaderTier: leader.tier,
          symbol: position.symbol,
          direction: position.direction,
          qty: entry?.testnetFilledQty ?? 0,
          entryPrice: position.entryPrice,
          openedAt: position.openedAt,
          sourceEntry: entry,
          closedAt: position.closedAt!,
          netRealizedPnlUsd: position.realisedPnlUsd,
          grossRealizedPnlUsd: position.feesUsd === null ? null : position.realisedPnlUsd + position.feesUsd,
          feesUsd: position.feesUsd,
          sourceExit: exit,
          closeKind,
          comparable: closeKind === "SOURCE_EXIT" && entry !== null && exit !== null,
          sourcePriceReturnPct,
          copyPriceReturnPct,
          priceReplicationGapPct: sourcePriceReturnPct === null || copyPriceReturnPct === null
            ? null
            : copyPriceReturnPct - sourcePriceReturnPct,
        };
      })
      .sort((left, right) => right.closedAt.localeCompare(left.closedAt) || left.symbol.localeCompare(right.symbol));
  }

  realisedPnl(): { today: number; allTime: number; feesUsd: number | null } {
    const now = new Date(this.nowMs());
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let allTime = 0;
    let today = 0;
    let feesKnown = true;
    let fees = 0;
    for (const position of this.store.getState().positions) {
      allTime += position.realisedPnlUsd;
      const closedMs = position.closedAt ? Date.parse(position.closedAt) : NaN;
      if (Number.isFinite(closedMs) && closedMs >= day) today += position.realisedPnlUsd;
      if (position.feesUsd === null) feesKnown = false;
      else fees += position.feesUsd;
    }
    return { today, allTime, feesUsd: feesKnown ? fees : null };
  }

  getStatus(): Record<string, unknown> {
    const state = this.store.getState();
    const pnl = this.realisedPnl();
    const openPositions = this.getOpenPositionReports();
    const closedTrades = this.getClosedTrades();
    return {
      strategy: COPY_LEADER_STRATEGY,
      enabled: this.config.enabled,
      environment: this.env.LIVE_BINANCE_ENV ?? null,
      // Show configured intent and effective endpoint separately.  A bad env
      // value must be visible as CONFIG INEFFECTIVE, never disguised as safe.
      destinationEndpoint: this.config.destinationEndpoint,
      effectiveDestinationEndpoint: this.config.enabled ? COPY_LEADER_DESTINATION_ENDPOINT : null,
      sourceEndpoint: COPY_LEADER_SOURCE_ORDER_HISTORY_ENDPOINT,
      sourceEventIdentity: {
        mode: "CANONICAL_BAPI_ORDER_V1",
        nativeSourceOrderIdAvailable: false,
        ambiguityPolicy: "FAIL_CLOSED",
      },
      configErrors: this.config.configErrors,
      armed: this.config.enabled && this.leaders.some((leader) => {
        const stateName = state.leaders[leader.id]?.state;
        return stateName === "ARMED_WAITING_SIGNAL" || stateName === "EXECUTING";
      }),
      running: this.running,
      pollMs: this.config.pollMs,
      stalenessMs: this.config.stalenessMs,
      sleeve: state.sleeve,
      leaders: this.leaders.map((leader) => ({
        ...state.leaders[leader.id],
        budgetMarginUsd: state.sleeve?.sleeveMarginBudgetUsd === null || state.sleeve?.sleeveMarginBudgetUsd === undefined
          ? null
          : state.sleeve.sleeveMarginBudgetUsd * leader.sleeveShare,
      })),
      /** Raw durable rows kept for existing API consumers/audit export. */
      ownerPositions: state.positions,
      /** Dashboard-safe projections with source and Testnet fill lineage. */
      openPositions,
      closedTradeCount: closedTrades.length,
      closedTrades: closedTrades.slice(0, 200),
      eventLedger: state.events.slice().sort((a, b) => b.sourceTimestampMs - a.sourceTimestampMs).slice(0, 200),
      ownerPnl: pnl,
      lastError: state.lastError,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  pollIntervalMs(): number {
    return this.config.pollMs;
  }

  async tick(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      await this.runTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.getState().lastError = message;
      this.store.save(() => this.nowIso());
      console.error("[copy-leader-executor] tick failed: " + message);
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<void> {
    if (this.env.COPY_LEADER_KILL_SWITCH === "1") {
      for (const leader of this.leaders) {
        this.setLeaderState(leader.id, "PAUSED_KILL_SWITCH", "COPY_LEADER_KILL_SWITCH=1");
        await this.closeLeaderPositions(leader.id, "COPY_LEADER_KILL_SWITCH");
      }
      this.store.save(() => this.nowIso());
      return;
    }

    const [filters, positions, balances] = await Promise.all([
      this.client.getExchangeFilters(),
      this.client.getPositions(),
      this.client.getBalances(),
    ]);
    this.updatePositionSnapshot(positions);
    this.refreshSleeveSnapshot(balances, positions);
    await this.reconcilePersistedPositions(positions);

    for (const leader of this.leaders) {
      await this.tickLeader(leader, filters);
    }
    this.store.save(() => this.nowIso());
  }

  private refreshSleeveSnapshot(balances: readonly FuturesBalance[], positions: readonly FuturesPosition[]): void {
    const usdt = balances.find((balance) => balance.asset === "USDT") ?? null;
    const balance = finitePositive(usdt?.balance ?? null) ? usdt!.balance : null;
    const available = finitePositive(usdt?.availableBalance ?? null) ? usdt!.availableBalance : null;
    const unrealised = positions.reduce(
      (sum, position) => sum + (Number.isFinite(position.unRealizedProfit) ? position.unRealizedProfit : 0),
      0,
    );
    const equity = balance === null ? null : balance + unrealised;
    this.store.getState().sleeve = {
      checkedAt: this.nowIso(),
      availableBalanceUsd: available,
      equityUsd: equity,
      sleeveMarginBudgetUsd: available === null ? null : Math.min(available * 0.1, 500),
      totalGrossCapUsd: equity === null ? null : equity * 0.3,
      perSymbolGrossCapUsd: equity === null ? null : equity * 0.1,
    };
  }

  private async tickLeader(leader: CopyLeaderDefinition, filters: Map<string, FuturesSymbolFilters>): Promise<void> {
    const state = this.leaderState(leader.id);
    const now = this.nowMs();
    const universe = this.getKronosUniverse();

    if (
      !state.coverage ||
      now - Date.parse(state.coverage.checkedAt) > SOURCE_COVERAGE_REFRESH_MS
    ) {
      const coverageOrders = await this.fetchSourceOrders(leader.id, now - SOURCE_COVERAGE_WINDOW_MS, now);
      if (coverageOrders === null) {
        this.setLeaderState(leader.id, "SOURCE_API_ERROR", "public Binance source unavailable");
        return;
      }
      const coverage = this.buildCoverage(coverageOrders, filters, universe);
      state.coverage = coverage;
      if ((coverage.coveragePct ?? 0) < 60) {
        this.setLeaderState(
          leader.id,
          "BLOCKED_TESTNET_SYMBOL_COVERAGE",
          "Testnet source-event coverage " + (coverage.coveragePct ?? 0).toFixed(2) + "% is below 60%",
        );
        return;
      }
      if (coverage.kronosOverlapSymbols.length > 0) {
        this.setLeaderState(
          leader.id,
          "PAUSED_KRONOS_OVERLAP",
          "source uses current Kronos universe: " + coverage.kronosOverlapSymbols.join(", "),
        );
        await this.closeLeaderPositions(leader.id, "PAUSED_KRONOS_OVERLAP");
        return;
      }
      if (coverageOrders.some((order) => explicitSourceAction(order) === null)) {
        this.setLeaderState(
          leader.id,
          "BLOCKED_SOURCE_EVENT_SEMANTICS",
          "source order feed uses positionSide=BOTH without a reduce-only field",
        );
        return;
      }
    }

    if (
      state.state === "BLOCKED_TESTNET_SYMBOL_COVERAGE" ||
      state.state === "BLOCKED_SOURCE_EVENT_SEMANTICS" ||
      state.state === "BLOCKED_SOURCE_EVENT_ID_AMBIGUOUS" ||
      state.state === "PAUSED_KILL_SWITCH"
    ) return;

    if (
      state.state === "PAUSED_RECONCILIATION_REQUIRED" ||
      state.state === "PAUSED_ORDER_SUBMISSION_INCONCLUSIVE"
    ) return;

    const currentCoverageOverlap = (state.coverage?.symbols ?? [])
      .filter((item) => universe.has(item.symbol))
      .map((item) => item.symbol);
    if (currentCoverageOverlap.length > 0) {
      this.setLeaderState(
        leader.id,
        "PAUSED_KRONOS_OVERLAP",
        "source uses current Kronos universe: " + currentCoverageOverlap.join(", "),
      );
      await this.closeLeaderPositions(leader.id, "PAUSED_KRONOS_OVERLAP");
      return;
    }

    if (state.activationCursorAtMs === null) {
      const seedOrders = await this.fetchSourceOrders(leader.id, now - this.config.sourceLookbackMs, now);
      if (seedOrders === null) {
        this.setLeaderState(leader.id, "SOURCE_API_ERROR", "could not initialise activation cursor");
        return;
      }
      if (!this.assertSourceIdentityUnambiguous(leader.id, seedOrders)) return;
      state.activationCursorAtMs = now;
      for (const order of seedOrders) {
        if (order.sourceTimestampMs > now) continue;
        if (!this.eventById(order.sourceEventId)) {
          this.upsertEvent(sourceEventRow(
            order,
            leader.id,
            "CURSOR_SEEDED",
            explicitSourceAction(order)?.direction ?? null,
            "CURSOR_SEEDED",
            this.nowIso(),
            "activation cursor; no historical replay",
          ));
        }
      }
      this.setLeaderState(leader.id, "ARMED_WAITING_SIGNAL", null);
      return;
    }

    const sourceMargin = await this.refreshSourceMarginBalance(leader.id);
    if (sourceMargin === null || sourceMargin <= 0) {
      this.setLeaderState(leader.id, "SOURCE_API_ERROR", "leader margin balance unavailable");
      return;
    }

    const from = Math.max(state.activationCursorAtMs, now - this.config.sourceLookbackMs);
    const orders = await this.fetchSourceOrders(leader.id, from, now);
    state.lastPollAt = this.nowIso();
    if (orders === null) {
      this.setLeaderState(leader.id, "SOURCE_API_ERROR", "public Binance source unavailable");
      return;
    }
    if (!this.assertSourceIdentityUnambiguous(leader.id, orders)) return;
    const orderSymbols = new Set(orders.map((order) => order.symbol));
    const currentOverlap = Array.from(orderSymbols).filter((symbol) => universe.has(symbol));
    if (currentOverlap.length > 0) {
      this.setLeaderState(
        leader.id,
        "PAUSED_KRONOS_OVERLAP",
        "new source event overlaps current Kronos universe: " + currentOverlap.join(", "),
      );
      await this.closeLeaderPositions(leader.id, "PAUSED_KRONOS_OVERLAP");
      return;
    }

    for (const order of orders.slice().sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs)) {
      await this.processSourceOrder(leader, order, filters, sourceMargin);
      if (this.leaderState(leader.id).state.startsWith("PAUSED_") || this.leaderState(leader.id).state.startsWith("BLOCKED_")) {
        return;
      }
    }
    if (this.leaderState(leader.id).state !== "EXECUTING") {
      this.setLeaderState(leader.id, "ARMED_WAITING_SIGNAL", null);
    }
  }

  private buildCoverage(
    orders: readonly CopySourceOrder[],
    filters: ReadonlyMap<string, FuturesSymbolFilters>,
    universe: ReadonlySet<string>,
  ): CopyLeaderCoverage {
    const counts = new Map<string, number>();
    for (const order of orders) counts.set(order.symbol, (counts.get(order.symbol) ?? 0) + 1);
    const sourceEventCount = orders.length;
    const eligibleEventCount = orders.filter((order) => filters.has(order.symbol)).length;
    const symbols = Array.from(counts, ([symbol, events]) => ({
      symbol,
      events,
      testnetEligible: filters.has(symbol),
    })).sort((left, right) => right.events - left.events || left.symbol.localeCompare(right.symbol));
    return {
      checkedAt: this.nowIso(),
      sourceEventCount,
      eligibleEventCount,
      unavailableEventCount: sourceEventCount - eligibleEventCount,
      coveragePct: sourceEventCount > 0 ? (eligibleEventCount / sourceEventCount) * 100 : null,
      symbols,
      kronosOverlapSymbols: symbols.filter((item) => universe.has(item.symbol)).map((item) => item.symbol),
    };
  }

  private async fetchSourceOrders(leaderId: string, startTime: number, endTime: number): Promise<CopySourceOrder[] | null> {
    const payload: Record<string, string | number> = {
      portfolioId: leaderId,
      startTime: Math.max(0, Math.floor(startTime)),
      endTime: Math.max(0, Math.floor(endTime)),
      pageSize: 1000,
    };
    const rawRows: Record<string, unknown>[] = [];
    const seenPageSignatures = new Set<string>();
    const seenCursors = new Set<string>();
    let reportedTotal: number | null = null;

    for (let page = 0; page < SOURCE_ORDER_MAX_PAGES; page += 1) {
      const decoded = await this.fetchSourceOrderPage(payload);
      if (!decoded || !Array.isArray(decoded.data?.list)) return null;

      const pageRows = decoded.data.list
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
      const pageSignature = stableJson(pageRows);
      if (pageRows.length > 0 && seenPageSignatures.has(pageSignature)) return null;
      if (pageRows.length > 0) seenPageSignatures.add(pageSignature);

      const pageTotal = numberOrNull(decoded.data.total);
      if (reportedTotal === null) reportedTotal = pageTotal;
      else if (pageTotal !== null && pageTotal !== reportedTotal) return null;
      rawRows.push(...pageRows);

      if (reportedTotal !== null) {
        if (rawRows.length === reportedTotal) return this.normalizeSourceOrders(leaderId, rawRows);
        if (rawRows.length > reportedTotal) return null;
      }

      const cursor = decoded.data.indexValue;
      if (pageRows.length === 0 || cursor === null || cursor === undefined || cursor === "" || cursor === 0) {
        // If Binance exposes a total, an exhausted cursor is complete only when
        // every reported row was received.  Otherwise the response is partial.
        if (reportedTotal !== null && rawRows.length !== reportedTotal) return null;
        return this.normalizeSourceOrders(leaderId, rawRows);
      }
      const cursorText = String(cursor);
      if (seenCursors.has(cursorText)) return null;
      seenCursors.add(cursorText);
      payload.indexValue = cursorText;
    }
    return null;
  }

  private normalizeSourceOrders(leaderId: string, rows: readonly Record<string, unknown>[]): CopySourceOrder[] {
    return rows
      .map((item) => normalizeCopySourceOrder(leaderId, item))
      .filter((item): item is CopySourceOrder => item !== null);
  }

  private async fetchSourceOrderPage(payload: Record<string, string | number>): Promise<{
    code?: unknown;
    data?: { list?: unknown; total?: unknown; indexValue?: unknown };
  } | null> {
    for (let attempt = 0; attempt <= SOURCE_ORDER_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.fetchImpl(COPY_LEADER_SOURCE_ORDER_HISTORY_ENDPOINT, {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; kronos-copy-leader-testnet/1.0)",
            clienttype: "web",
          },
          body: JSON.stringify(payload),
        });
        const decoded = await response.json() as {
          code?: unknown;
          data?: { list?: unknown; total?: unknown; indexValue?: unknown };
        };
        if (response.ok && String(decoded.code ?? "") === "000000") return decoded;
        // Binance uses this code for transient public-source pressure. Retry
        // the exact cursor a bounded number of times; every other failure is
        // intentionally a fail-closed source error.
        if (String(decoded.code ?? "") !== "11012005" || attempt >= SOURCE_ORDER_RETRY_DELAYS_MS.length) return null;
      } catch {
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, SOURCE_ORDER_RETRY_DELAYS_MS[attempt]!));
    }
    return null;
  }

  private async refreshSourceMarginBalance(leaderId: string): Promise<number | null> {
    const state = this.leaderState(leaderId);
    const now = this.nowMs();
    const last = state.sourceMarginBalanceCheckedAt ? Date.parse(state.sourceMarginBalanceCheckedAt) : NaN;
    if (finitePositive(state.sourceMarginBalanceUsd) && Number.isFinite(last) && now - last < SOURCE_COVERAGE_REFRESH_MS) {
      return state.sourceMarginBalanceUsd;
    }
    try {
      const url = COPY_LEADER_SOURCE_DETAIL_ENDPOINT + "?portfolioId=" + encodeURIComponent(leaderId);
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json, text/plain, */*", clienttype: "web" },
      });
      if (!response.ok) return null;
      const decoded = await response.json() as { code?: unknown; data?: { marginBalance?: unknown } };
      const margin = numberOrNull(decoded.data?.marginBalance);
      if (String(decoded.code ?? "") !== "000000" || !finitePositive(margin)) return null;
      state.sourceMarginBalanceUsd = margin;
      state.sourceMarginBalanceCheckedAt = this.nowIso();
      return margin;
    } catch {
      return null;
    }
  }

  private assertSourceIdentityUnambiguous(leaderId: string, orders: readonly CopySourceOrder[]): boolean {
    const eventIds = new Set<string>();
    const logical = new Map<string, string>();
    for (const order of orders) {
      if (eventIds.has(order.sourceEventId)) {
        this.setLeaderState(
          leaderId,
          "BLOCKED_SOURCE_EVENT_ID_AMBIGUOUS",
          "duplicate canonical source event id in one Binance response",
        );
        return false;
      }
      eventIds.add(order.sourceEventId);
      const sameLogical = logical.get(order.sourceLogicalKey);
      if (sameLogical && sameLogical !== order.sourceEventId) {
        this.setLeaderState(
          leaderId,
          "BLOCKED_SOURCE_EVENT_ID_AMBIGUOUS",
          "one logical Binance source event changed payload without a native order id",
        );
        return false;
      }
      logical.set(order.sourceLogicalKey, order.sourceEventId);
      const persisted = this.eventByLogicalKey(order.sourceLogicalKey);
      if (persisted && persisted.sourceEventId !== order.sourceEventId) {
        this.setLeaderState(
          leaderId,
          "BLOCKED_SOURCE_EVENT_ID_AMBIGUOUS",
          "persisted source logical key changed payload without a native order id",
        );
        return false;
      }
    }
    return true;
  }

  private async processSourceOrder(
    leader: CopyLeaderDefinition,
    order: CopySourceOrder,
    filters: ReadonlyMap<string, FuturesSymbolFilters>,
    sourceMarginBalance: number,
  ): Promise<void> {
    const leaderState = this.leaderState(leader.id);
    const activationAt = leaderState.activationCursorAtMs;
    if (activationAt === null || order.sourceTimestampMs <= activationAt) return;
    if (this.eventById(order.sourceEventId)) return;
    const action = explicitSourceAction(order);
    if (!action) {
      this.setLeaderState(
        leader.id,
        "BLOCKED_SOURCE_EVENT_SEMANTICS",
        "positionSide is not explicit LONG/SHORT",
      );
      return;
    }
    const now = this.nowMs();
    if (now - order.sourceTimestampMs > this.config.stalenessMs) {
      this.upsertEvent(sourceEventRow(
        order,
        leader.id,
        action.action,
        action.direction,
        "SKIPPED_STALE_SOURCE_EVENT",
        this.nowIso(),
        "source event age exceeds " + this.config.stalenessMs + "ms",
      ));
      return;
    }
    if (!filters.has(order.symbol)) {
      this.upsertEvent(sourceEventRow(
        order,
        leader.id,
        action.action,
        action.direction,
        "SKIPPED_TESTNET_SYMBOL_UNAVAILABLE",
        this.nowIso(),
        "symbol absent from active USD-M Testnet exchange filters",
      ));
      return;
    }
    if (this.getKronosUniverse().has(order.symbol)) {
      this.upsertEvent(sourceEventRow(
        order,
        leader.id,
        action.action,
        action.direction,
        "PAUSED_KRONOS_OVERLAP",
        this.nowIso(),
        "symbol entered current Kronos universe",
      ));
      this.setLeaderState(leader.id, "PAUSED_KRONOS_OVERLAP", order.symbol);
      await this.closeLeaderPositions(leader.id, "PAUSED_KRONOS_OVERLAP");
      return;
    }
    if (action.action === "ENTRY") {
      if (!this.canOpenNewEntries()) {
        this.upsertEvent(sourceEventRow(
          order,
          leader.id,
          "ENTRY",
          action.direction,
          "SKIPPED_KRONOS_PRIORITY_GATE",
          this.nowIso(),
          "Kronos new-entry gate is closed",
        ));
        return;
      }
      await this.copyEntry(leader, order, action.direction, filters.get(order.symbol)!, sourceMarginBalance);
    } else {
      await this.copyExit(leader, order, action.direction, filters.get(order.symbol)!);
    }
  }

  private sleeveBudget(leader: CopyLeaderDefinition): {
    sleeve: number;
    leader: number;
    totalGross: number;
    perSymbolGross: number;
  } | null {
    const sleeve = this.store.getState().sleeve;
    if (
      !sleeve ||
      !finitePositive(sleeve.sleeveMarginBudgetUsd) ||
      !finitePositive(sleeve.totalGrossCapUsd) ||
      !finitePositive(sleeve.perSymbolGrossCapUsd)
    ) return null;
    return {
      sleeve: sleeve.sleeveMarginBudgetUsd,
      leader: sleeve.sleeveMarginBudgetUsd * leader.sleeveShare,
      totalGross: sleeve.totalGrossCapUsd,
      perSymbolGross: sleeve.perSymbolGrossCapUsd,
    };
  }

  private async latestPositions(): Promise<FuturesPosition[]> {
    const positions = await this.client.getPositions();
    this.updatePositionSnapshot(positions);
    return positions;
  }

  private expectedSignedQty(position: CopyOwnedPosition): number {
    return position.direction === "LONG" ? position.qty : -position.qty;
  }

  private exchangePosition(positions: readonly FuturesPosition[], symbol: string): FuturesPosition | null {
    return positions.find((position) => position.symbol === symbol) ?? null;
  }

  private ownerMatchesExchange(
    position: CopyOwnedPosition | null,
    exchange: FuturesPosition | null,
  ): { ok: boolean; reason: string | null } {
    const actual = exchange?.positionAmt ?? 0;
    const expected = position ? this.expectedSignedQty(position) : 0;
    if (Math.abs(actual - expected) <= Math.max(EPS, Math.abs(expected) * 1e-6)) return { ok: true, reason: null };
    return {
      ok: false,
      reason: "exchange net " + actual + " differs from copy owner expected " + expected,
    };
  }

  private async currentCopyGrossAtMark(opts: { leaderId?: string; symbol?: string } = {}): Promise<number | null> {
    let gross = 0;
    for (const position of this.openOwnedPositions(opts.leaderId)) {
      if (opts.symbol && position.symbol !== opts.symbol) continue;
      let mark: number | null = null;
      try {
        mark = await this.client.getMarkPrice(position.symbol);
      } catch {
        return null;
      }
      if (!finitePositive(mark)) return null;
      gross += Math.abs(position.qty * mark);
    }
    return gross;
  }

  private async copyEntry(
    leader: CopyLeaderDefinition,
    source: CopySourceOrder,
    direction: CopyDirection,
    filters: FuturesSymbolFilters,
    sourceMarginBalance: number,
  ): Promise<void> {
    const budget = this.sleeveBudget(leader);
    if (!budget) {
      this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "SKIPPED_BUDGET_CAP", "Testnet balance/equity unavailable");
      return;
    }
    const existingOwner = this.ownedPosition(leader.id, source.symbol, direction);
    const positions = await this.latestPositions();
    const exchange = this.exchangePosition(positions, source.symbol);
    const ownership = this.ownerMatchesExchange(existingOwner, exchange);
    if (!ownership.ok) {
      this.setLeaderState(leader.id, "PAUSED_RECONCILIATION_REQUIRED", ownership.reason);
      this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "ACCOUNTING_INCOMPLETE", ownership.reason);
      return;
    }
    const mark = await this.client.getMarkPrice(source.symbol);
    if (!finitePositive(mark)) {
      this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "SKIPPED_BUDGET_CAP", "Testnet mark price unavailable");
      return;
    }
    const sourceNotional = source.executedQty * source.avgPrice;
    const proportionalNotional = sourceNotional * Math.min(1, budget.leader / sourceMarginBalance);
    const [currentGross, currentLeaderGross, currentSymbolGross] = await Promise.all([
      this.currentCopyGrossAtMark(),
      this.currentCopyGrossAtMark({ leaderId: leader.id }),
      this.currentCopyGrossAtMark({ symbol: source.symbol }),
    ]);
    if (currentGross === null || currentLeaderGross === null || currentSymbolGross === null) {
      this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "SKIPPED_BUDGET_CAP", "could not verify marked copy sleeve exposure");
      return;
    }
    const headroom = Math.min(
      budget.leader - currentLeaderGross,
      budget.sleeve - currentGross,
      budget.totalGross - currentGross,
      budget.perSymbolGross - currentSymbolGross,
    );
    const desiredNotional = Math.min(proportionalNotional, headroom);
    const requestedQty = floorToStep(desiredNotional / mark, filters.stepSize, filters.quantityPrecision);
    if (
      !finitePositive(requestedQty) ||
      requestedQty + EPS < filters.minQty ||
      requestedQty * mark + EPS < filters.minNotional
    ) {
      this.recordSimpleSkip(
        source,
        leader.id,
        "ENTRY",
        direction,
        desiredNotional <= 0 ? "SKIPPED_BUDGET_CAP" : "SKIPPED_MIN_NOTIONAL",
        desiredNotional <= 0 ? "copy sleeve/leader/symbol headroom exhausted" : "rounded quantity falls below Testnet filters",
      );
      return;
    }
    if (!this.tryClaimEntrySymbol(source.symbol)) {
      this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "SKIPPED_SYMBOL_IN_FLIGHT", "another executor owns an in-flight symbol claim");
      return;
    }
    const clientOrderId = copyClientOrderId("E", source.sourceEventId);
    let reservationId: string | null = null;
    let submissionAttempted = false;
    let orderAccepted = false;
    try {
      const reserved = this.exposure.reserve({
        executorId: COPY_LEADER_STRATEGY + ":" + leader.id,
        basketId: "COPY:" + leader.id,
        symbol: source.symbol,
        direction,
        requestedNotionalUsd: requestedQty * mark,
        clientOrderId,
      });
      if (!reserved.ok || !reserved.reservationId) {
        this.recordSimpleSkip(source, leader.id, "ENTRY", direction, "SKIPPED_BUDGET_CAP", reserved.reason ?? "central exposure reservation rejected");
        return;
      }
      reservationId = reserved.reservationId;
      const row = sourceEventRow(source, leader.id, "ENTRY", direction, "ORDER_SUBMISSION_PENDING", this.nowIso());
      row.clientOrderId = clientOrderId;
      row.requestedQty = requestedQty;
      this.upsertEvent(row);
      if (!this.store.save(() => this.nowIso())) {
        this.exposure.releaseReservation(reservationId, "COPY_LEADER_ENTRY_NOT_SUBMITTED: durable ledger write failed");
        this.setLeaderState(leader.id, "PAUSED_RECONCILIATION_REQUIRED", "durable copy entry ledger write failed before submission");
        return;
      }

      await this.client.setLeverage(source.symbol, this.config.leverage);
      submissionAttempted = true;
      const order = await this.submitOrReconcile(
        source.symbol,
        {
          symbol: source.symbol,
          side: direction === "LONG" ? "BUY" : "SELL",
          type: "MARKET",
          quantity: requestedQty,
          newClientOrderId: clientOrderId,
        },
        clientOrderId,
      );
      orderAccepted = true;
      const adopted = await this.adoptEntryFill(leader, source, direction, order, reservationId, mark);
      reservationId = null; // adopted/committed
      if (adopted) this.setLeaderState(leader.id, "EXECUTING", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected = !orderAccepted && error instanceof BinanceFuturesPrivateError && error.failureType === "binance_error";
      // After a submit has returned, a later accounting failure must leave the
      // central reservation intact until exchange reconciliation proves whether
      // it filled. Releasing it would permit duplicate exposure.
      if (reservationId && (!submissionAttempted || rejected)) {
        this.exposure.releaseReservation(reservationId, "COPY_LEADER_ENTRY_FAILED:" + message);
      }
      const existing = this.eventById(source.sourceEventId);
      if (existing) {
        existing.status = rejected ? "ORDER_REJECTED" : "ORDER_SUBMISSION_INCONCLUSIVE";
        existing.reason = message;
        existing.updatedAt = this.nowIso();
      }
      if (!rejected) this.setLeaderState(leader.id, "PAUSED_ORDER_SUBMISSION_INCONCLUSIVE", message);
    } finally {
      this.releaseEntrySymbol(source.symbol);
    }
  }

  private async submitOrReconcile(
    symbol: string,
    params: {
      symbol: string;
      side: "BUY" | "SELL";
      type: "MARKET";
      quantity: number;
      reduceOnly?: boolean;
      newClientOrderId: string;
    },
    clientOrderId: string,
  ): Promise<FuturesOrder> {
    try {
      return await this.client.placeOrder(params);
    } catch (error) {
      try {
        const observed = await this.client.queryOrderByClientId(symbol, clientOrderId);
        if (observed.executedQty > 0) return observed;
        if (["REJECTED", "CANCELED", "CANCELLED", "EXPIRED"].includes(observed.status)) throw error;
      } catch (queryError) {
        if (queryError instanceof BinanceFuturesPrivateError && queryError.binanceCode === -2013) throw error;
        throw queryError;
      }
      throw error;
    }
  }

  private async feeForOrder(symbol: string, orderId: string, afterMs: number): Promise<{ feeUsd: number | null; fillIds: string[] }> {
    try {
      const trades = await this.client.getUserTrades(symbol, { startTime: Math.max(0, afterMs - 60_000), limit: 100 });
      const own = trades.filter((trade) => trade.orderId === orderId);
      const allUsdt = own.every((trade) => trade.commissionAsset === "USDT");
      return {
        feeUsd: allUsdt ? own.reduce((sum, trade) => sum + trade.commission, 0) : null,
        fillIds: own.map((trade) => trade.tradeId ?? "").filter(Boolean),
      };
    } catch {
      return { feeUsd: null, fillIds: [] };
    }
  }

  private async adoptEntryFill(
    leader: CopyLeaderDefinition,
    source: CopySourceOrder,
    direction: CopyDirection,
    order: FuturesOrder,
    reservationId: string,
    markFallback: number,
  ): Promise<boolean> {
    const filledQty = finitePositive(order.executedQty) ? order.executedQty : 0;
    if (!finitePositive(filledQty)) throw new Error("exchange entry returned no executed quantity");
    const resolution = await resolveConfirmedFillPrice(this.client, source.symbol, order.orderId, order.avgPrice, markFallback);
    this.exposure.commitReservation(reservationId, { qty: filledQty, avgPrice: resolution.price });
    const fees = await this.feeForOrder(source.symbol, order.orderId, source.sourceTimestampMs);
    const row = this.eventById(source.sourceEventId);
    if (!row) throw new Error("missing persisted entry event");
    row.status = resolution.confirmed ? "FILLED" : "ACCOUNTING_INCOMPLETE";
    row.exchangeOrderId = order.orderId;
    row.exchangeFillIds = fees.fillIds;
    row.filledQty = filledQty;
    row.fillPrice = resolution.price;
    row.fillPriceConfirmed = resolution.confirmed;
    row.feeUsd = fees.feeUsd;
    row.updatedAt = this.nowIso();

    let position = this.ownedPosition(leader.id, source.symbol, direction);
    const lot: CopyOwnedLot = {
      lotId: randomUUID(),
      qty: filledQty,
      entryPrice: resolution.price,
      entryFeeUsd: fees.feeUsd,
      reservationId,
      entryOrderId: order.orderId,
      entryClientOrderId: row.clientOrderId ?? "",
      openedAt: this.nowIso(),
    };
    if (!position) {
      position = {
        strategy: COPY_LEADER_STRATEGY,
        ownerPositionId: "COPY:" + leader.id + ":" + source.symbol + ":" + direction,
        leaderId: leader.id,
        symbol: source.symbol,
        direction,
        qty: filledQty,
        entryPrice: resolution.price,
        status: resolution.confirmed ? "OPEN" : "ACCOUNTING_INCOMPLETE",
        openedAt: this.nowIso(),
        closedAt: null,
        sourceTrackedQty: source.executedQty,
        realisedPnlUsd: 0,
        feesUsd: fees.feeUsd,
        lots: [lot],
        sourceEntryEventIds: [source.sourceEventId],
        sourceExitEventIds: [],
        lastExitReason: null,
        reconciliation: {
          lastCheckedAt: null,
          exchangeQty: null,
          expectedQty: direction === "LONG" ? filledQty : -filledQty,
          state: "PENDING",
          reason: null,
        },
      };
      this.store.getState().positions.push(position);
    } else {
      const oldQty = position.qty;
      position.qty += filledQty;
      position.entryPrice = (position.entryPrice * oldQty + resolution.price * filledQty) / position.qty;
      position.sourceTrackedQty += source.executedQty;
      position.lots.push(lot);
      position.sourceEntryEventIds = Array.from(new Set([...(position.sourceEntryEventIds ?? []), source.sourceEventId]));
      position.feesUsd = position.feesUsd === null || fees.feeUsd === null ? null : position.feesUsd + fees.feeUsd;
      if (!resolution.confirmed) position.status = "ACCOUNTING_INCOMPLETE";
    }
    const positions = await this.latestPositions();
    this.recordReconciliation(position, this.exchangePosition(positions, position.symbol));
    if (position.reconciliation.state !== "MATCHED" || !resolution.confirmed) {
      position.status = "ACCOUNTING_INCOMPLETE";
      this.setLeaderState(leader.id, "PAUSED_RECONCILIATION_REQUIRED", position.reconciliation.reason ?? "entry fill price unconfirmed");
      return false;
    }
    return true;
  }

  private async copyExit(
    leader: CopyLeaderDefinition,
    source: CopySourceOrder,
    direction: CopyDirection,
    filters: FuturesSymbolFilters,
  ): Promise<void> {
    const position = this.ownedPosition(leader.id, source.symbol, direction);
    if (!position || position.sourceTrackedQty <= EPS) {
      this.recordSimpleSkip(source, leader.id, "EXIT", direction, "SKIPPED_UNTRACKED_SOURCE_EXIT", "no copy-owned source quantity");
      return;
    }
    const sourceCloseQty = Math.min(position.sourceTrackedQty, source.executedQty);
    const proportion = Math.min(1, sourceCloseQty / position.sourceTrackedQty);
    let closeQty = floorToStep(position.qty * proportion, filters.stepSize, filters.quantityPrecision);
    if (sourceCloseQty >= position.sourceTrackedQty - EPS) closeQty = position.qty;
    if (!finitePositive(closeQty) || closeQty + EPS < filters.minQty) {
      this.recordSimpleSkip(source, leader.id, "EXIT", direction, "SKIPPED_MIN_NOTIONAL", "rounded source exit is below Testnet lot size");
      return;
    }
    const closed = await this.closeOwnedPosition(position, closeQty, source, "EXIT", direction);
    // Never consume source-close provenance after a partial/ambiguous Testnet
    // exit.  That situation needs reconciliation, not an invisible residual.
    if (closed.completed) position.sourceTrackedQty = Math.max(0, position.sourceTrackedQty - sourceCloseQty);
  }

  private async closeLeaderPositions(leaderId: string, reason: string): Promise<void> {
    for (const position of this.openOwnedPositions(leaderId)) {
      const controlSource: CopySourceOrder = {
        symbol: position.symbol,
        side: position.direction === "LONG" ? "SELL" : "BUY",
        positionSide: position.direction,
        type: "CONTROL",
        executedQty: position.qty,
        avgPrice: position.entryPrice,
        totalPnl: 0,
        orderTimeMs: this.nowMs(),
        orderUpdateTimeMs: this.nowMs(),
        sourceTimestampMs: this.nowMs(),
        sourceEventId: "CONTROL_" + digest(reason + "|" + position.ownerPositionId),
        sourceLogicalKey: "CONTROL_" + digest(reason + "|" + position.ownerPositionId),
        raw: {},
      };
      await this.closeOwnedPosition(position, position.qty, controlSource, "CONTROL_CLOSE", position.direction, reason);
    }
  }

  async closeAllPositionsOrderly(reason: string): Promise<void> {
    for (const leader of this.leaders) await this.closeLeaderPositions(leader.id, reason);
    this.store.save(() => this.nowIso());
  }

  private async closeOwnedPosition(
    position: CopyOwnedPosition,
    requestedQty: number,
    source: CopySourceOrder,
    action: "EXIT" | "CONTROL_CLOSE",
    direction: CopyDirection,
    controlReason: string | null = null,
  ): Promise<{ completed: boolean; filledQty: number }> {
    if (!this.tryClaimEntrySymbol(position.symbol)) {
      this.recordSimpleSkip(source, position.leaderId, action, direction, "SKIPPED_SYMBOL_IN_FLIGHT", "another executor owns an in-flight symbol claim");
      return { completed: false, filledQty: 0 };
    }
    const clientOrderId = copyClientOrderId(action === "EXIT" ? "X" : "K", source.sourceEventId);
    try {
      const before = await this.latestPositions();
      const ownership = this.ownerMatchesExchange(position, this.exchangePosition(before, position.symbol));
      if (!ownership.ok) {
        position.status = "ACCOUNTING_INCOMPLETE";
        this.setLeaderState(position.leaderId, "PAUSED_RECONCILIATION_REQUIRED", ownership.reason);
        this.recordSimpleSkip(source, position.leaderId, action, direction, "ACCOUNTING_INCOMPLETE", ownership.reason);
        return { completed: false, filledQty: 0 };
      }
      const row = sourceEventRow(source, position.leaderId, action, direction, "ORDER_SUBMISSION_PENDING", this.nowIso(), controlReason);
      row.clientOrderId = clientOrderId;
      row.requestedQty = requestedQty;
      this.upsertEvent(row);
      if (!this.store.save(() => this.nowIso())) {
        this.setLeaderState(position.leaderId, "PAUSED_RECONCILIATION_REQUIRED", "durable copy exit ledger write failed before submission");
        return { completed: false, filledQty: 0 };
      }
      const order = await this.submitOrReconcile(
        position.symbol,
        {
          symbol: position.symbol,
          side: position.direction === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: requestedQty,
          reduceOnly: true,
          newClientOrderId: clientOrderId,
        },
        clientOrderId,
      );
      const filledQty = finitePositive(order.executedQty) ? Math.min(order.executedQty, position.qty) : 0;
      if (!finitePositive(filledQty)) throw new Error("exchange reduce-only exit returned no executed quantity");
      const resolution = await resolveConfirmedFillPrice(this.client, position.symbol, order.orderId, order.avgPrice, position.entryPrice);
      const fees = await this.feeForOrder(position.symbol, order.orderId, source.sourceTimestampMs);
      this.applyClosedLots(position, filledQty, resolution.price, fees.feeUsd, controlReason ?? action);
      position.sourceExitEventIds = Array.from(new Set([...(position.sourceExitEventIds ?? []), source.sourceEventId]));
      position.lastExitReason = action;
      const fullyFilled = filledQty >= requestedQty - EPS;
      row.status = resolution.confirmed && fullyFilled ? "CLOSED" : "ACCOUNTING_INCOMPLETE";
      row.exchangeOrderId = order.orderId;
      row.exchangeFillIds = fees.fillIds;
      row.filledQty = filledQty;
      row.fillPrice = resolution.price;
      row.fillPriceConfirmed = resolution.confirmed;
      row.feeUsd = fees.feeUsd;
      row.updatedAt = this.nowIso();
      const after = await this.latestPositions();
      this.recordReconciliation(position, this.exchangePosition(after, position.symbol));
      if (position.reconciliation.state !== "MATCHED" || !resolution.confirmed || !fullyFilled) {
        position.status = "ACCOUNTING_INCOMPLETE";
        this.setLeaderState(
          position.leaderId,
          "PAUSED_RECONCILIATION_REQUIRED",
          position.reconciliation.reason ?? (fullyFilled ? "exit fill price unconfirmed" : "reduce-only exit partially filled"),
        );
        return { completed: false, filledQty };
      } else if (position.qty <= EPS) {
        position.status = "CLOSED";
        position.closedAt = this.nowIso();
      }
      return { completed: true, filledQty };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const row = this.eventById(source.sourceEventId);
      if (row) {
        row.status = "ORDER_SUBMISSION_INCONCLUSIVE";
        row.reason = message;
        row.updatedAt = this.nowIso();
      }
      this.setLeaderState(position.leaderId, "PAUSED_ORDER_SUBMISSION_INCONCLUSIVE", message);
      return { completed: false, filledQty: 0 };
    } finally {
      this.releaseEntrySymbol(position.symbol);
    }
  }

  private applyClosedLots(
    position: CopyOwnedPosition,
    closedQty: number,
    exitPrice: number,
    exitFeeUsd: number | null,
    reason: string,
  ): void {
    let remaining = closedQty;
    let entryFeeForClosed = 0;
    let feesKnown = exitFeeUsd !== null;
    for (const lot of position.lots) {
      if (remaining <= EPS || lot.qty <= EPS) continue;
      const quantity = Math.min(lot.qty, remaining);
      const fraction = quantity / lot.qty;
      const directionSign = position.direction === "LONG" ? 1 : -1;
      position.realisedPnlUsd += (exitPrice - lot.entryPrice) * quantity * directionSign;
      if (lot.entryFeeUsd === null) feesKnown = false;
      else entryFeeForClosed += lot.entryFeeUsd * fraction;
      lot.qty -= quantity;
      remaining -= quantity;
      if (lot.reservationId && this.exposure.releaseCommittedReservation) {
        this.exposure.releaseCommittedReservation(lot.reservationId, quantity, "COPY_LEADER_CLOSE:" + reason);
      }
    }
    position.lots = position.lots.filter((lot) => lot.qty > EPS);
    position.qty = Math.max(0, position.qty - closedQty + remaining);
    if (position.qty > EPS) {
      const notional = position.lots.reduce((sum, lot) => sum + lot.qty * lot.entryPrice, 0);
      position.entryPrice = notional / position.qty;
    }
    if (!feesKnown || position.feesUsd === null) {
      position.feesUsd = null;
    } else {
      const totalFees = entryFeeForClosed + (exitFeeUsd ?? 0);
      position.feesUsd += exitFeeUsd ?? 0;
      position.realisedPnlUsd -= totalFees;
    }
  }

  private recordReconciliation(position: CopyOwnedPosition, exchange: FuturesPosition | null): void {
    const actual = exchange?.positionAmt ?? 0;
    const expected = this.expectedSignedQty(position);
    const match = Math.abs(actual - expected) <= Math.max(EPS, Math.abs(expected) * 1e-6);
    position.reconciliation = {
      lastCheckedAt: this.nowIso(),
      exchangeQty: actual,
      expectedQty: expected,
      state: match ? "MATCHED" : "MISMATCH",
      reason: match ? null : "exchange net " + actual + " differs from copy owner expected " + expected,
    };
  }

  private async reconcilePersistedPositions(positions: readonly FuturesPosition[]): Promise<void> {
    for (const position of this.openOwnedPositions()) {
      this.recordReconciliation(position, this.exchangePosition(positions, position.symbol));
      if (position.reconciliation.state !== "MATCHED") {
        position.status = "ACCOUNTING_INCOMPLETE";
        this.setLeaderState(position.leaderId, "PAUSED_RECONCILIATION_REQUIRED", position.reconciliation.reason);
      }
    }
  }

  private recordSimpleSkip(
    source: CopySourceOrder,
    leaderId: string,
    action: CopyEventLedgerRow["action"],
    direction: CopyDirection | null,
    status: Extract<CopyEventLedgerRow["status"], "SKIPPED_UNTRACKED_SOURCE_EXIT" | "SKIPPED_KRONOS_PRIORITY_GATE" | "SKIPPED_MIN_NOTIONAL" | "SKIPPED_SYMBOL_IN_FLIGHT" | "SKIPPED_BUDGET_CAP" | "ACCOUNTING_INCOMPLETE">,
    reason: string | null,
  ): void {
    this.upsertEvent(sourceEventRow(source, leaderId, action, direction, status, this.nowIso(), reason));
  }
}

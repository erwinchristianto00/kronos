/** Dedicated agent lane. All exchange calls use the incumbent serialized Testnet client.
 * Model authority ends at this boundary: no arbitrary endpoints, config, or foreign orders.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { roundToStep } from "./binance-futures-private.js";
import type { BinanceFuturesPrivateClient, FuturesOrder, FuturesUserTrade } from "./binance-futures-private.js";
import type { AccountExposureCoordinator } from "./account-exposure-coordinator.js";
import { buildAstraReport, type ReportBook } from "./astra-hermes-report.js";
import { AstraResearchContext, candleFeatures, applyExecutionBook } from "./astra-research-context.js";
import { ASTRA_CAPITAL, walletView, type AstraWalletSnapshot } from "./astra-capital.js";
import { finalEntryGate, validateEntryContract, AstraEntryGateError, ASTRA_EXECUTION_VERSION, type AstraEntryContract } from "./astra-entry-contract.js";
import { activeModelPolicy } from "./astra-model-policy.js";

export const ASTRA_LANE_ID = "ASTRA_HERMES_TESTNET";
type Side = "LONG" | "SHORT";
type Client = Pick<BinanceFuturesPrivateClient, "getBookTicker" | "getExecutionBookTickers" | "getKlines" | "getExchangeFilters" |
  "getPositions" | "getBalances" | "getOpenOrders" | "getOpenAlgoOrders" | "setLeverage" |
  "placeOrder" | "queryOrderByClientId" | "placeAlgoOrder" | "queryAlgoOrder" | "cancelAlgoOrder" |
  "getUserTrades" | "getIncomeHistory" | "getAstraTicker24h" | "getAstraPremiumIndexes" | "getAstraCommissionRate">;
export interface AstraDecision {
  id: string; action: "OPEN" | "CLOSE" | "WAIT"; reason: string;
  reasonCode?: "EXPERIMENT_OPEN" | "MANAGEMENT_CLOSE" | "TAKE_PROFIT" | "CUT_LOSS" | "NO_SETUP" | "COST_UNAVAILABLE" | "DATA_UNAVAILABLE" | "EXECUTION_BLOCKED" | "HYPOTHESIS_INVALIDATED" | "MANAGING_POSITION";
  symbol?: string; side?: Side; notionalUsd?: number; stopPrice?: number;
  targetPrice?: number; maxHoldMs?: number; slippageBps?: number; tradeId?: string;
  entryContract?: AstraEntryContract;
}
interface Handle { clientId: string; order?: FuturesOrder; attemptedAt: number }
export interface AstraTrade {
  id: string; decision: AstraDecision; symbol: string; side: Side;
  createdAt: number; entry: Handle; exits: Handle[]; qty: number; entryQty: number;
  entryPrice: number; stopPrice: number; targetPrice: number | null; maxHoldMs: number;
  stopClientId: string; stopAttempted: boolean; stopId: string | null;
  stopDone: boolean; stopExitId: string | null; fills: FuturesUserTrade[];
  closedAt: number | null; state: "ENTRY_PENDING" | "OPEN" | "SETTLING" | "CLOSED" | "NO_FILL";
  reservationId: string | null; settlementComplete: boolean; error: string | null;
  requestedQty: number; limitPrice: number; book: unknown;
  entryGate?: ReturnType<typeof finalEntryGate>;
  safetyExitReason?: string;
  exitReason?: string;
}
interface State {
  version: 1; initialEquity: 25; trades: AstraTrade[];
  decisions: Array<{ at: number; decision: AstraDecision; result: unknown }>;
  funding: Array<{ id: string; tradeId: string; amount: number; time: number }>;
  fundingThrough: number; lastError: string | null;
}
export interface AstraDeps {
  environment: string; file: string; client: Client; now?: () => number;
  entryBlock: () => string | null;
  foreignSymbols: () => string[];
  tryClaim: (symbol: string) => boolean; releaseClaim: (symbol: string) => void;
  exposure: Pick<AccountExposureCoordinator, "reserve" | "commitReservation" | "releaseReservation" | "updatePositionSnapshot">;
}
const terminal = (o?: FuturesOrder) => !!o && ["FILLED", "EXPIRED", "CANCELED", "REJECTED"].includes(o.status);
const sign = (side: Side) => side === "LONG" ? 1 : -1;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 22);
const isActive = (t: AstraTrade) => !["CLOSED", "NO_FILL"].includes(t.state);

export function validateAstraDecision(d: AstraDecision): void {
  if (!d || !/^[a-zA-Z0-9_-]{8,80}$/.test(d.id) || typeof d.reason !== "string" || !d.reason.trim() || d.reason.length > 4000)
    throw new Error("Decision id and bounded rationale required");
  if (!["OPEN", "CLOSE", "WAIT"].includes(d.action)) throw new Error("Unknown action");
  // Optional for durable v1 decisions; v2 agent schema requires explicit classification.
  if (d.reasonCode != null) {
    const codes = d.action === "OPEN" ? ["EXPERIMENT_OPEN"] : d.action === "CLOSE" ? ["MANAGEMENT_CLOSE", "TAKE_PROFIT", "CUT_LOSS"] :
      ["NO_SETUP", "COST_UNAVAILABLE", "DATA_UNAVAILABLE", "EXECUTION_BLOCKED", "HYPOTHESIS_INVALIDATED", "MANAGING_POSITION"];
    if (!codes.includes(d.reasonCode)) throw new Error("Reason code does not match action");
  }
  if (d.action === "CLOSE" && typeof d.tradeId !== "string") throw new Error("Owned tradeId required");
  if (d.action !== "OPEN") return;
  // Naming is not an eligibility policy: the exact exchange-filter Map in open()
  // admits active USDT perpetuals, including single-character and Unicode bases.
  if (typeof d.symbol !== "string" || !d.symbol.endsWith("USDT") || d.symbol.length <= 4 ||
      d.symbol.length > 80 || /[\s\p{C}]/u.test(d.symbol) || !["LONG", "SHORT"].includes(d.side ?? ""))
    throw new Error("Invalid contract or side");
  if (!positive(d.notionalUsd) || !positive(d.stopPrice) || !positive(d.maxHoldMs) || d.maxHoldMs > 30 * 86400000)
    throw new Error("Positive size, native stop and hold time (up to 30 days) required");
  if (d.notionalUsd > ASTRA_CAPITAL.maxEntryNotionalUsd) throw new Error("Maximum entry notional is 25 USDT per OPEN, not total lane equity");
  if (d.targetPrice != null && !positive(d.targetPrice)) throw new Error("Invalid target");
  if (!positive(d.slippageBps) || d.slippageBps > 100) throw new Error("Choose executable-price allowance in (0,100] bps");
}

export class AstraHermesLane {
  private research: AstraResearchContext;
  private reportBooks = new Map<string, ReportBook>();
  private wallet: AstraWalletSnapshot | null = null;
  private walletError: string | null = null;
  private walletRead: Promise<void> | null = null;
  private walletAttemptAt: number | null = null;
  private state: State;
  private tail: Promise<unknown> = Promise.resolve();
  private tickInFlight: Promise<void> | null = null;
  private now: () => number;
  constructor(private deps: AstraDeps) {
    if (deps.environment !== "testnet") throw new Error("Astra is TESTNET ONLY");
    this.now = deps.now ?? Date.now;
    this.research = new AstraResearchContext(deps.client, this.now);
    // Corrupt/mismatched state is fatal; never turn lost ownership into an empty account.
    this.state = existsSync(deps.file) ? JSON.parse(readFileSync(deps.file, "utf8")) : {
      version: 1, initialEquity: 25, trades: [], decisions: [], funding: [], fundingThrough: this.now(), lastError: null,
    };
    if (this.state.version !== 1 || this.state.initialEquity !== 25 || !Array.isArray(this.state.trades)) throw new Error("Invalid Astra ledger");
    this.save();
  }
  private save() {
    mkdirSync(dirname(this.deps.file), { recursive: true });
    writeFileSync(this.deps.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.deps.file + ".tmp", this.deps.file);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task;
  }
  leasedSymbols() { return this.state.trades.filter(isActive).map(t => t.symbol); }
  managedNetQty() {
    return new Map(this.state.trades.filter(t => isActive(t) && t.qty > 0).map(t => [t.symbol, sign(t.side) * t.qty]));
  }
  pendingEntryNetQty() {
    return new Map(this.state.trades.filter(t => t.state === "ENTRY_PENDING").map(t => [t.symbol, sign(t.side) * t.requestedQty]));
  }
  openExposure() {
    return this.state.trades.filter(t => isActive(t) && t.qty > 0).map(t => ({ symbol: t.symbol, direction: t.side, qty: t.qty, entryPrice: t.entryPrice }));
  }
  private async refreshWallet(force = false) {
    if (this.walletRead) {
      // A wedged exchange read must not freeze the private context gateway forever.
      // Non-entry callers may continue with wallet freshness false; entry callers fail closed.
      const pending = this.walletRead;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending.then(() => true, () => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12_000); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        if (!force) return;
        throw new Error("Testnet wallet read did not settle within 12000ms");
      }
      if (!force) return;
    }
    if (!force && this.walletAttemptAt !== null && this.now() - this.walletAttemptAt < 30000) return;
    this.walletAttemptAt = this.now();
    this.walletRead = (async () => {
      try {
        const b = (await this.deps.client.getBalances()).find(b => b.asset === "USDT");
        if (!b || !Number.isFinite(b.balance) || !Number.isFinite(b.availableBalance)) throw new Error("USDT wallet balance unavailable");
        this.wallet = { walletBalance: b.balance, availableBalance: b.availableBalance, fetchedAt: this.now() };
        this.walletError = null;
      } catch (e) { this.walletError = (e as Error).message; }
    })();
    try { await this.walletRead; } finally { this.walletRead = null; }
  }
  status() {
    const fills = this.state.trades.flatMap(t => t.fills);
    const gross = fills.reduce((s, f) => s + f.realizedPnl, 0);
    const fees = fills.reduce((s, f) => s + f.commission, 0);
    const funding = this.state.funding.reduce((s, f) => s + f.amount, 0);
    // The lane declares two policies and fails over between them; printing one as a
    // constant made this field wrong for the whole time the other was deciding.
    return { laneId: ASTRA_LANE_ID, environment: "testnet", ...activeModelPolicy(this.now()),
      executionVersion: ASTRA_EXECUTION_VERSION,
      capital: ASTRA_CAPITAL, wallet: walletView(this.wallet, this.walletError, this.now()),
      gross, fees, funding, net: gross - fees + funding,
      dailyLossCap: null, leverage: 1, fundingThrough: this.state.fundingThrough,
      entryBlock: this.deps.entryBlock(), active: this.state.trades.filter(isActive),
      closed: this.state.trades.filter(t => !isActive(t)).slice(-50),
      decisions: this.state.decisions.slice(-10), lastError: this.state.lastError };
  }
  report() { return buildAstraReport(this.state, this.reportBooks, this.now(), walletView(this.wallet, this.walletError, this.now()), activeModelPolicy(this.now())); }
  async market(symbols: string[], offset = 0, contextMode?: string) {
    if (!Array.isArray(symbols) || symbols.some(s => typeof s !== "string")) throw new Error("Expected symbol list");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history offset");
    if (contextMode !== undefined && contextMode !== "FORMATION_METADATA_V1") throw new Error("Unknown context mode");
    const metadataOnly = contextMode === "FORMATION_METADATA_V1";
    if (metadataOnly && (!symbols.length || symbols.length > 6 || new Set(symbols).size !== symbols.length)) {
      throw new Error("Formation metadata requires 1..6 unique symbols");
    }
    const filters = await this.deps.client.getExchangeFilters();
    if (symbols.some(s => !filters.has(s))) throw new Error("Contract not executable on Testnet");
    const requested = [...new Set(symbols)];
    if (offset > requested.length) throw new Error("History offset exceeds request");
    await this.refreshWallet();
    const universe = [...filters.keys()];
    const unavailableSymbols = [...new Set([...this.deps.foreignSymbols(), ...this.leasedSymbols()])];
    // All contracts remain selectable. History pagination bounds response size and
    // serialized exchange work, not the universe or the number of requested symbols.
    const page = requested.slice(offset, offset + 20);
    const books = requested.length ? new Map() : await this.deps.client.getExecutionBookTickers(universe);
    const entryBudget = this.status().wallet.fresh ? Math.max(0, Math.min(ASTRA_CAPITAL.maxEntryNotionalUsd, this.wallet!.availableBalance / 1.002)) : 0;
    const screen = requested.length ? null : await this.research.overview(universe, books, unavailableSymbols, entryBudget, filters);
    const stats = new Map((screen?.rows ?? []).map(row => [row.symbol, row]));
    const overview = requested.length ? undefined : universe.map(symbol => ({
      symbol, book: books.get(symbol) ?? null, minNotional: filters.get(symbol)!.minNotional,
      unavailableForNewEntry: unavailableSymbols.includes(symbol),
      change24hPct: stats.get(symbol)?.change24hPct ?? null,
      quoteVolume24h: stats.get(symbol)?.quoteVolume24h ?? null,
      range24hPct: stats.get(symbol)?.range24hPct ?? null,
      statsFresh: stats.get(symbol)?.statsFresh ?? false,
    }));
    const rows = [];
    const startedAt = this.now();
    for (const symbol of page) {
      if (rows.length && this.now() - startedAt >= 30000) break;
      // Formation host already refreshes candles/BBO immediately before dispatch.
      // Return account-derived metadata only, never call this an executable snapshot.
      const candles = metadataOnly ? [] : await this.deps.client.getKlines(symbol, "5m", { limit: 100 });
      const economics = await this.research.economics(symbol, null);
      rows.push({ symbol, filters: filters.get(symbol), book: null as import("./binance-futures-private.js").FuturesExecutionBookTicker | null, candles: candles.filter(c => c.closeTime < this.now()),
        features: candleFeatures(candles, this.now()), economics });
    }
    if (rows.length && !metadataOnly) {
      // Quote only AFTER paced history/cost reads, once for the delivered page.
      const freshBooks = await this.deps.client.getExecutionBookTickers(rows.map(row => row.symbol));
      for (const row of rows) {
        row.book = freshBooks.get(row.symbol) ?? null;
        row.economics = applyExecutionBook(row.economics, row.book, this.now());
      }
    }
    const nextOffset = offset + rows.length < requested.length ? offset + rows.length : null;
    return { at: this.now(), contextVersion: "ASTRA_EXPERIMENT_CONTEXT_V2", source: "BINANCE_USDM_TESTNET", universe, overview,
      ...(metadataOnly ? { contextMode, marketDataComplete: false, orderAuthority: false } : {}),
      screening: screen?.screening ?? null,
      unavailableSymbols, status: this.status(), rows,
      historyPage: { offset, returned: rows.length, requested: requested.length, nextOffset,
        instruction: nextOffset === null ? null : "Repeat the same symbols list with offset=nextOffset; no symbols are excluded." } };
  }
  async decide(d: AstraDecision) {
    validateAstraDecision(d);
    return this.serial(async () => {
      const previous = this.state.decisions.find(x => x.decision.id === d.id);
      if (previous) {
        if (JSON.stringify(previous.decision) !== JSON.stringify(d)) throw new Error("Idempotency key reused with different decision");
        return previous.result;
      }
      const row = { at: this.now(), decision: d, result: { status: "PENDING" } as unknown };
      this.state.decisions.push(row); this.save();
      try {
        if (d.action === "OPEN") row.result = await this.open(d);
        else if (d.action === "CLOSE") {
          const trade = this.state.trades.find(t => t.id === d.tradeId && isActive(t));
          if (!trade) throw new Error("No active trade owned by Astra with this id");
          try { await this.reconcile(trade); } catch (e) { trade.error = (e as Error).message; }
          if (trade.state === "OPEN") {
            trade.exitReason = d.reasonCode ?? "MANAGEMENT_CLOSE"; this.save();
            await this.close(trade);
          }
          row.result = trade;
        } else row.result = { status: "WAIT_RECORDED" };
      } catch (e) {
        row.result = { status: e instanceof AstraEntryGateError ? "ENTRY_REJECTED" : "REJECTED_OR_UNRESOLVED",
          reason: String((e as Error).message),
          ...(e instanceof AstraEntryGateError ? { noOrderSubmitted: true, entryGate: e.diagnostic } : {}) };
      }
      // Avoid circular references between durable decisions and live trade objects.
      row.result = JSON.parse(JSON.stringify(row.result)); this.save();
      return row.result;
    });
  }
  private async open(d: AstraDecision) {
    // Required only for a NEW admission. Historical idempotent decisions above,
    // reconciliation and exits do not acquire a new contract after the fact.
    validateEntryContract(d);
    const block = this.deps.entryBlock(); if (block) throw new Error(block);
    await this.refresh();
    if (this.state.trades.some(t => isActive(t) && (t.state !== "OPEN" || t.error))) throw new Error("Resolve pending execution before new entry");
    if (this.state.trades.some(t => t.state === "CLOSED" && !t.settlementComplete)) throw new Error("Settlement incomplete");
    const symbol = d.symbol!;
    if (this.deps.foreignSymbols().includes(symbol) || this.leasedSymbols().includes(symbol)) throw new Error("Symbol already owned");
    const filters = (await this.deps.client.getExchangeFilters()).get(symbol);
    if (!filters) throw new Error("Inactive or non-USDT perpetual contract");
    if (!this.deps.tryClaim(symbol)) throw new Error("Concurrent symbol admission");
    let trade: AstraTrade | undefined;
    try {
      const client = this.deps.client;
      const positions = await client.getPositions();
      this.deps.exposure.updatePositionSnapshot(positions);
      if (positions.some(p => p.symbol === symbol && Math.abs(p.positionAmt) > 1e-9) ||
          (await client.getOpenOrders(symbol)).length || (await client.getOpenAlgoOrders(symbol)).length)
        throw new Error("Foreign exchange position/order on symbol");
      await this.refreshWallet(true);
      if (!this.status().wallet.fresh) throw new Error(`Fresh Testnet wallet required: ${this.walletError ?? "stale"}`);
      const budget = this.wallet!.availableBalance;
      // Binance availableBalance already accounts for margin in existing positions.
      // Do not subtract owned notional again or resurrect the legacy 25-USDT allocation.
      // Shared reservations and Binance's final margin validation still apply.
      if (d.notionalUsd! * 1.002 > budget) throw new Error(`Notional plus fee reserve exceeds Testnet available balance ${budget}`);
      await client.setLeverage(symbol, 1); // A failed leverage change must abort before the order.
      const book = await client.getBookTicker(symbol);
      if (!positive(book.bid) || !positive(book.ask) || book.ask < book.bid ||
          !book.time || Math.abs(this.now() - book.time) > 5000) throw new Error("Stale or invalid executable Testnet book");
      const entryGate = finalEntryGate(d, book, filters.tickSize, this.now());
      const limitPrice = entryGate.limitPrice;
      // Band clipping must not increase quantity relative to incumbent sizing.
      const qty = roundToStep(d.notionalUsd! / Math.max(entryGate.originalLimit, book.ask), filters.stepSize, "down");
      const stop = roundToStep(d.stopPrice!, filters.tickSize, d.side === "LONG" ? "down" : "up");
      if (qty < filters.minQty || qty * Math.min(book.bid, limitPrice) < filters.minNotional) throw new Error("Below venue minQty/minNotional; no automatic size increase");
      if (d.side === "LONG" ? stop >= book.bid : stop <= book.ask) throw new Error("Native stop already crossed");
      if (d.targetPrice != null && (d.side === "LONG" ? d.targetPrice <= book.ask : d.targetPrice >= book.bid)) throw new Error("Target already crossed");
      const clientId = `astra-e-${digest(d.id)}`;
      const reservation = this.deps.exposure.reserve({ executorId: ASTRA_LANE_ID, symbol, direction: d.side!, requestedNotionalUsd: d.notionalUsd!, clientOrderId: clientId });
      if (!reservation.ok) throw new Error(reservation.reason ?? "Account capacity rejected");
      trade = { id: `astra-${digest(d.id)}`, decision: d, symbol, side: d.side!, createdAt: this.now(),
        entry: { clientId, attemptedAt: this.now() }, exits: [], qty: 0, entryQty: 0, entryPrice: 0,
        stopPrice: stop, targetPrice: d.targetPrice ?? null, maxHoldMs: d.maxHoldMs!,
        stopClientId: `astra-s-${digest(d.id)}`, stopAttempted: false, stopId: null, stopDone: false, stopExitId: null,
        fills: [], closedAt: null, state: "ENTRY_PENDING", reservationId: reservation.reservationId,
        settlementComplete: false, error: null, requestedQty: qty, limitPrice, book, entryGate };
      this.state.trades.push(trade); this.save();
      // IOC bounds adverse entry price and does not leave a resting entry behind.
      trade.entry.order = await client.placeOrder({ symbol, side: d.side === "LONG" ? "BUY" : "SELL",
        type: "LIMIT", timeInForce: "IOC", price: limitPrice, quantity: qty, newClientOrderId: clientId });
      this.save(); await this.reconcile(trade); return trade;
    } catch (e) {
      if (trade) { trade.error = (e as Error).message; this.save(); await this.reduceUnprotected(trade); }
      throw e;
    } finally { this.deps.releaseClaim(symbol); }
  }
  private async reconcile(t: AstraTrade) {
    const client = this.deps.client;
    // An uncertain submit is QUERY ONLY, including after restart. Never blind-resend.
    if (!terminal(t.entry.order)) {
      t.entry.order = await client.queryOrderByClientId(t.symbol, t.entry.clientId); this.save();
    }
    if (!terminal(t.entry.order)) throw new Error("Entry not terminal; ownership retained");
    t.entryQty = t.entry.order!.executedQty;
    if (!Number.isFinite(t.entryQty) || t.entryQty < 0) throw new Error("Invalid actual entry quantity");
    if (t.entryQty === 0) {
      t.state = "NO_FILL"; t.settlementComplete = true; t.error = null;
      if (t.reservationId) this.deps.exposure.releaseReservation(t.reservationId, "ASTRA_NO_FILL");
      this.save(); return;
    }
    if (t.state === "ENTRY_PENDING") {
      t.qty = t.entryQty; t.state = "OPEN"; this.save();
    }
    // Confirmed executed quantity is exposure even when the initial response has
    // avgPrice=0. Protect it BEFORE waiting for price/accounting reconciliation.
    if (t.qty > 0 && !t.stopId && t.exits.length === 0) await this.ensureStop(t);
    if (!positive(t.entry.order!.avgPrice)) {
      const recovered = await client.queryOrderByClientId(t.symbol, t.entry.clientId);
      if (!terminal(recovered) || recovered.orderId !== t.entry.order!.orderId || recovered.executedQty !== t.entryQty)
        throw new Error("Recovered entry identity or quantity mismatch; ownership retained");
      t.entry.order = recovered; this.save();
    }
    t.entryPrice = t.entry.order!.avgPrice;
    if (!positive(t.entryPrice)) throw new Error("Actual entry price unavailable; confirmed quantity retained and protected");
    if (t.reservationId) this.deps.exposure.commitReservation(t.reservationId, { qty: t.entryQty, avgPrice: t.entryPrice });
    let exited = 0;
    const exitIds = new Set<string>();
    for (const h of t.exits) {
      if (!terminal(h.order)) { h.order = await client.queryOrderByClientId(t.symbol, h.clientId); this.save(); }
      if (!terminal(h.order)) throw new Error("Close not terminal; do not resend");
      exited += h.order!.executedQty; exitIds.add(h.order!.orderId);
    }
    if (t.stopId && !t.stopDone) {
      const stop = await client.queryAlgoOrder(t.stopId);
      if (stop.actualOrderId) t.stopExitId = stop.actualOrderId;
      if (["CANCELED", "CANCELLED", "EXPIRED", "REJECTED", "FINISHED"].includes(stop.algoStatus)) t.stopDone = true;
    }
    // Fills are refreshed with a bounded full page. Saturation or missing commissions blocks learning/entries.
    const all = await client.getUserTrades(t.symbol, { startTime: t.createdAt - 10000, limit: 1000 });
    if (all.length >= 1000) throw new Error("Fill history page saturated; exact settlement needs pagination");
    if (t.stopExitId) exitIds.add(t.stopExitId);
    const matched = all.filter(f => f.orderId === t.entry.order!.orderId || exitIds.has(f.orderId));
    if (matched.some(f => f.commissionAsset !== "USDT" || !positive(f.qty) || !Number.isFinite(f.commission))) throw new Error("Invalid or non-USDT fee evidence");
    if (matched.length < t.fills.length) throw new Error("Fill history regressed; retained prior accounting and ownership");
    t.fills = matched;
    const stopQty = matched.filter(f => f.orderId === t.stopExitId).reduce((s,f) => s + f.qty, 0);
    exited += stopQty;
    t.qty = Math.max(0, t.entryQty - exited);
    if (exited > t.entryQty + 1e-8) throw new Error("Exit quantities exceed owned entry");
    t.state = t.qty > 1e-9 ? "OPEN" : "SETTLING";
    this.save();
    if (t.qty > 1e-9) {
      const coveredEntry = matched.filter(f => f.orderId === t.entry.order!.orderId).reduce((s,f) => s + f.qty, 0);
      if (Math.abs(coveredEntry - t.entryQty) > 1e-8) throw new Error("Entry fill/fee coverage incomplete");
      if (t.stopDone) throw new Error("Native stop terminal with remaining exposure; manual reconciliation required");
      if (!t.stopId) await this.ensureStop(t);
    } else {
      if (t.stopId && !t.stopDone) {
        await client.cancelAlgoOrder(t.stopId); t.stopDone = true;
      }
      const entryFillQty = matched.filter(f => f.orderId === t.entry.order!.orderId).reduce((s,f) => s + f.qty, 0);
      const exitFillQty = matched.filter(f => exitIds.has(f.orderId)).reduce((s,f) => s + f.qty, 0);
      if (Math.abs(entryFillQty - t.entryQty) > 1e-8 || Math.abs(exitFillQty - t.entryQty) > 1e-8) throw new Error("Fill coverage incomplete; settlement pending");
      const actual = (await client.getPositions(t.symbol)).find(p => p.symbol === t.symbol);
      if (actual && Math.abs(actual.positionAmt) > 1e-9) throw new Error("Exchange still exposed; do not release lease");
      if ((await client.getOpenOrders(t.symbol)).length || (await client.getOpenAlgoOrders(t.symbol)).length) throw new Error("Residual exchange orders; retain ownership");
      t.closedAt = Math.max(...matched.map(f => f.time)); t.state = "CLOSED"; t.settlementComplete = true;
    }
    t.error = null; this.save();
  }
  private async ensureStop(t: AstraTrade) {
    if (t.stopAttempted) {
      const recovered = (await this.deps.client.getOpenAlgoOrders(t.symbol)).find(o => o.clientAlgoId === t.stopClientId);
      if (!recovered) throw new Error("Stop placement unresolved; no duplicate conditional submit");
      t.stopId = recovered.algoId;
    } else {
      t.stopAttempted = true; this.save();
      const stop = await this.deps.client.placeAlgoOrder({ symbol: t.symbol, side: t.side === "LONG" ? "SELL" : "BUY",
        type: "STOP_MARKET", quantity: t.qty, triggerPrice: t.stopPrice, reduceOnly: true,
        clientAlgoId: t.stopClientId, workingType: "MARK_PRICE" });
      t.stopId = stop.algoId;
    }
    this.save();
  }
  private async close(t: AstraTrade) {
    if (t.state !== "OPEN" || t.exits.some(h => !terminal(h.order))) throw new Error("Position is not ready for another close");
    const actual = (await this.deps.client.getPositions(t.symbol)).find(p => p.symbol === t.symbol);
    if (!actual || Math.sign(actual.positionAmt) !== sign(t.side) || Math.abs(Math.abs(actual.positionAmt) - t.qty) > 1e-8)
      throw new Error("Owned quantity does not match exchange; refuse foreign netting");
    const h: Handle = { clientId: `astra-x-${digest(t.id + ':' + t.exits.length)}`, attemptedAt: this.now() };
    t.exits.push(h); this.save();
    // Leave the native stop in place until confirmed flat. Both exits are reduceOnly; no fallback reversing exposure.
    h.order = await this.deps.client.placeOrder({ symbol: t.symbol, side: t.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET", quantity: t.qty, reduceOnly: true, newClientOrderId: h.clientId });
    this.save(); await this.reconcile(t);
  }
  private async reduceUnprotected(t: AstraTrade) {
    if (t.state !== "OPEN" || !(t.qty > 0) || (t.stopId && !t.stopDone) || t.exits.some(h => !terminal(h.order))) return;
    t.safetyExitReason = "NATIVE_PROTECTION_UNAVAILABLE"; this.save();
    try { await this.close(t); } catch (e) { t.error = (e as Error).message; this.save(); }
  }
  private async refresh() {
    for (const t of this.state.trades.filter(isActive)) {
      try { await this.reconcile(t); }
      catch (e) { t.error = (e as Error).message; this.save(); await this.reduceUnprotected(t); }
    }
    // Fetch only funding, bounded by account history watermark; transfers never become lane profit.
    if (this.now() - this.state.fundingThrough > 60000) {
      const until = Math.min(this.now(), this.state.fundingThrough + 86400000);
      const rows = await this.deps.client.getIncomeHistory({ incomeType: "FUNDING_FEE", startTime: this.state.fundingThrough, endTime: until, limit: 1000 });
      if (rows.length >= 1000) throw new Error("Funding page saturated; no optimistic watermark advance");
      for (const row of rows) {
        if (row.incomeType !== "FUNDING_FEE") continue;
        const t = this.state.trades.find(t => t.symbol === row.symbol && t.entryQty > 0 &&
          row.time >= (t.entry.order?.updateTime ?? t.createdAt) && row.time <= (t.closedAt ?? this.now()));
        if (!t) continue;
        if (row.asset !== "USDT" || !row.tranId) throw new Error("Unattributable funding asset/id");
        const id = `${row.symbol}:${row.tranId}`;
        if (!this.state.funding.some(x => x.id === id)) this.state.funding.push({ id, tradeId: t.id, amount: row.income, time: row.time });
      }
      this.state.fundingThrough = until; this.save();
    }
  }
  tick(): Promise<void> {
    // A slow exchange read must not accumulate obsolete timer ticks in front of
    // model decisions. Share the current tick, including while it is queued;
    // retain the serial execution lock and every protection/accounting check.
    if (this.tickInFlight) return this.tickInFlight;
    const task = this.serial(async () => {
      try {
        await this.refresh();
        for (const t of this.state.trades.filter(t => t.state === "OPEN" && !t.error)) {
          const book = await this.deps.client.getBookTicker(t.symbol);
          this.reportBooks.set(t.symbol, book);
          const px = t.side === "LONG" ? book.bid : book.ask;
          const targetHit = positive(px) && !!book.time && Math.abs(this.now() - book.time) <= 5000 &&
            t.targetPrice != null && (px - t.targetPrice) * sign(t.side) >= 0;
          if (targetHit || this.now() - t.createdAt >= t.maxHoldMs) {
            t.exitReason = targetHit ? "TAKE_PROFIT" : "MAX_HOLD"; this.save();
            await this.close(t);
          }
        }
        this.state.lastError = null;
      } catch (e) { this.state.lastError = (e as Error).message; }
      // Refresh display capital only AFTER protection/exit work; failure must not block exits.
      await this.refreshWallet();
      this.save();
    });
    const pending = task.finally(() => {
      if (this.tickInFlight === pending) this.tickInFlight = null;
    });
    this.tickInFlight = pending;
    return pending;
  }
}

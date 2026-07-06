/**
 * Cross-sectional market-neutral EXECUTOR — turns the (measured, edgeReady) RAW
 * cross-sectional basket signal into REAL exchange positions.
 *
 * Design constraints (deliberate):
 *  - TESTNET-FIRST: enabled via CROSS_SECTIONAL_EXEC_ENABLED=1. On mainnet it
 *    additionally requires the operator's `isAllowed()` gate (the live engine's
 *    armed switch) — so the flag alone can never trade real money.
 *  - The basket is a HEDGE: k longs + k shorts at equal notional. Either the
 *    WHOLE basket opens or nothing — if any leg fails, every already-opened leg
 *    is flattened immediately (a partial basket is a naked directional bet).
 *  - One basket open at a time (v1), small fixed notional per leg, 3x leverage by default.
 *  - Exits at the signal's own horizon (default 24 bars = 24h) with MARKET
 *    reduce-only closes; P&L computed from actual fills minus a taker-fee
 *    estimate per side. Honest costs, no mark-to-model.
 *  - Consumes the SAME store the measurement lane writes (getCrossSectionalStore)
 *    so what executes is exactly what was measured — no separate signal path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { BinanceFuturesPrivateClient } from "./binance-futures-private.js";
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  type CrossSectionalObservation,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";

export const CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID = "CROSS_SECTIONAL_MARKET_NEUTRAL";

export type CrossSectionalExecClient = Pick<
  BinanceFuturesPrivateClient,
  "getExchangeFilters" | "placeOrder" | "setLeverage" | "getPositions"
>;

export function isCrossSectionalExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EXEC_ENABLED === "1";
}

const LEG_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_LEG_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 25;
};
const EXEC_LEVERAGE = () => {
  const n = Number.parseInt(process.env.CROSS_SECTIONAL_EXEC_LEVERAGE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
/** Which measured variant to execute. Default FILTERED (operator: follow the /research
 *  filtered symbols, whose allow/blocklists now auto-update from measured leg returns). */
const EXEC_VARIANT = () => process.env.CROSS_SECTIONAL_EXEC_VARIANT ?? "FILTERED";
/**
 * Only execute signals younger than this — a stale basket's momentum ranking has drifted. Signals
 * emit hourly (1h bars); a 15-min window meant the executor could only catch a signal in the first
 * 15 min of the hour, so it almost never opened. Default 50 min: a <1h-old ranking is negligible
 * drift on a 24h hold, and every hourly signal becomes reliably catchable. Env-tunable.
 */
const MAX_SIGNAL_AGE_MS = () =>
  Math.max(60_000, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_SIGNAL_AGE_MS) || 50 * 60_000));
/**
 * Max concurrently-OPEN baskets. Was hard-locked to 1 — with a 24h horizon that capped the whole
 * lane to ONE basket per day (why testnet looked dead). >1 opens a fresh basket each hour it forms,
 * diversifying entry times and accumulating proof far faster; each basket is a bounded $legUsd hedge.
 */
const MAX_OPEN_BASKETS = () =>
  Math.max(1, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS) || 1));
const TAKER_FEE_RATE = 0.0005; // 5 bps per side, conservative
/**
 * Profit-bank trigger, expressed as net (cost-adjusted) return on deployed capital — same unit as
 * cross-sectional-edge.ts's netReturn. Default 0.6% is sourced from measured reality, not a guess:
 * as of 2026-07-06 the executed FILTERED variant's 77 closed baskets averaged netAvgReturn=0.592%
 * at the full 24h HORIZON exit (100% of closes were HORIZON — nothing ever exited early). Baskets
 * were sitting the full horizon even when they'd already reached-or-beaten that average well before
 * hour 24 (see recentNetReturns spread in /api/shadow/cross-sectional-report). Banking the average
 * outcome as soon as it's reached — instead of waiting out the clock for a coin-flip on the rest —
 * frees the basket slot for a fresh cycle sooner. Only ever fires on the profit side; a basket that
 * never reaches this still rides HORIZON (or an existing SL/regime-flip cut) exactly as before.
 */
const TP_NET_RETURN = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0.006;
};

export interface ExecutorLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: number;
  exitPrice: number | null;
  exitOrderId: number | null;
}

export interface ExecutorBasket {
  basketId: string;
  sourceObservationId: string;
  signal: string;
  variant: string;
  openedAt: string;
  closesAtMs: number;
  legs: ExecutorLeg[];
  status: "OPEN" | "CLOSED" | "ABORTED";
  closedAt: string | null;
  closeReason: string | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  netPnlUsd: number | null;
}

interface ExecutorState {
  version: number;
  baskets: ExecutorBasket[];
  /** openedAtMs watermark — signals at/below this are never re-executed. */
  lastSeenSignalMs: number;
}

export class CrossSectionalExecutorStore {
  private readonly file: string;
  private state: ExecutorState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cross-sectional-executor.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): ExecutorState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && Array.isArray(parsed.baskets)) return parsed as ExecutorState;
      }
    } catch {
      // corrupt → fresh (positions reconcile against the exchange on next tick)
    }
    return { version: 1, baskets: [], lastSeenSignalMs: Date.now() };
  }

  getState(): ExecutorState {
    return this.state;
  }

  save(): void {
    try {
      // Atomic write: the previous version wrote the same content to both a .tmp file and
      // directly to this.file, so the .tmp write was dead weight and the main write was never
      // atomic (a crash mid-write could truncate/corrupt this.file). Now the tmp file is the
      // actual write target and gets renamed into place, matching the pattern used elsewhere
      // (paper-execution-router.ts, current-guard-variant-matrix.ts).
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // never let a persistence failure break the tick
    }
  }
}

export interface CrossSectionalExecutorOptions {
  client: CrossSectionalExecClient;
  signalStore: CrossSectionalStore;
  store: CrossSectionalExecutorStore;
  /** Master permission gate. Testnet: () => true. Mainnet: () => engine.isArmed(). */
  isAllowed: () => boolean;
  /** Operator lane allocation weight. 100 = normal leg size; 0 = blocked. */
  laneWeightPct?: () => number;
  nowIso?: () => string;
}

export class CrossSectionalExecutor {
  private readonly client: CrossSectionalExecClient;
  private readonly signalStore: CrossSectionalStore;
  private readonly store: CrossSectionalExecutorStore;
  private readonly isAllowed: () => boolean;
  private readonly laneWeightPct: () => number;
  private readonly nowIso: () => string;
  private ticking = false;
  private lastError: string | null = null;

  constructor(opts: CrossSectionalExecutorOptions) {
    this.client = opts.client;
    this.signalStore = opts.signalStore;
    this.store = opts.store;
    this.isAllowed = opts.isAllowed;
    this.laneWeightPct = opts.laneWeightPct ?? (() => 100);
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
  }

  private allocationWeightPct(): number {
    const pct = Number(this.laneWeightPct());
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  private effectiveLegUsd(): number {
    return LEG_USD() * (this.allocationWeightPct() / 100);
  }

  getStatus(): {
    enabled: boolean;
    allowed: boolean;
    laneId: string;
    legUsd: number;
    baseLegUsd: number;
    allocationWeightPct: number;
    leverage: number;
    variant: string;
    openBasket: ExecutorBasket | null;
    closedCount: number;
    totalNetPnlUsd: number;
    lastError: string | null;
    recent: ExecutorBasket[];
  } {
    const st = this.store.getState();
    const closed = st.baskets.filter((b) => b.status === "CLOSED");
    return {
      enabled: isCrossSectionalExecEnabled(),
      allowed: this.isAllowed(),
      laneId: CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
      legUsd: this.effectiveLegUsd(),
      baseLegUsd: LEG_USD(),
      allocationWeightPct: this.allocationWeightPct(),
      leverage: EXEC_LEVERAGE(),
      variant: EXEC_VARIANT(),
      openBasket: st.baskets.find((b) => b.status === "OPEN") ?? null,
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, b) => s + (b.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      recent: st.baskets.slice(-10),
    };
  }

  /** Single-flight tick: bank early winners, close due baskets, then consider opening a new one. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.closeBasketsHittingProfitTarget();
      await this.closeDueBaskets();
      await this.ensureOpenBasketLeverage();
      if (this.isAllowed()) await this.maybeOpenBasket();
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message ?? "tick failed";
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Proactively close any OPEN basket whose live net (cost-adjusted) return on deployed capital
   * has already reached TP_NET_RETURN, instead of always waiting for the fixed HORIZON. Uses
   * markPrice from getPositions() (a market-level field, safe to reuse even if another concurrent
   * basket shares the same symbol) against THIS basket's own recorded entry prices/qty — never the
   * exchange's aggregated unRealizedProfit, which would blend PnL across baskets sharing a symbol.
   */
  private async closeBasketsHittingProfitTarget(): Promise<void> {
    const st = this.store.getState();
    const openBaskets = st.baskets.filter((b) => b.status === "OPEN");
    if (openBaskets.length === 0) return;

    const positions = await this.client.getPositions();
    const markBySymbol = new Map<string, number>();
    for (const p of positions) {
      if (Number.isFinite(p.markPrice) && p.markPrice > 0) markBySymbol.set(p.symbol, p.markPrice);
    }

    const threshold = TP_NET_RETURN();
    for (const basket of openBaskets) {
      const longLegs = basket.legs.filter((l) => l.side === "LONG");
      const shortLegs = basket.legs.filter((l) => l.side === "SHORT");
      const legReturn = (leg: ExecutorLeg, direction: "LONG" | "SHORT"): number | null => {
        const mark = markBySymbol.get(leg.symbol);
        if (mark === undefined || !(leg.entryPrice > 0)) return null;
        return direction === "LONG" ? (mark - leg.entryPrice) / leg.entryPrice : (leg.entryPrice - mark) / leg.entryPrice;
      };
      const longReturns = longLegs.map((l) => legReturn(l, "LONG"));
      const shortReturns = shortLegs.map((l) => legReturn(l, "SHORT"));
      if (longReturns.some((r) => r === null) || shortReturns.some((r) => r === null)) continue; // incomplete mark data — skip this tick, never force a decision on partial info

      const meanLong = longReturns.length ? longReturns.reduce((a, b) => a! + b!, 0)! / longReturns.length : 0;
      const meanShort = shortReturns.length ? shortReturns.reduce((a, b) => a! + b!, 0)! / shortReturns.length : 0;
      const grossReturn = meanLong / 2 + meanShort / 2; // mirrors legReturnContribution's equal-notional formula
      const costReturn = CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
      const netReturn = grossReturn - costReturn;
      if (netReturn >= threshold) await this.closeBasket(basket, "PROFIT_BANK");
    }
  }

  private async ensureOpenBasketLeverage(): Promise<void> {
    const leverage = EXEC_LEVERAGE();
    const symbols = new Set<string>();
    for (const basket of this.store.getState().baskets) {
      if (basket.status !== "OPEN") continue;
      for (const leg of basket.legs) symbols.add(leg.symbol);
    }
    for (const symbol of symbols) {
      try {
        await this.client.setLeverage(symbol, leverage);
      } catch {
        // best-effort (already set / exchange refused while a close is racing)
      }
    }
  }

  private async closeDueBaskets(): Promise<void> {
    const st = this.store.getState();
    const nowMs = new Date(this.nowIso()).getTime();
    for (const basket of st.baskets) {
      if (basket.status !== "OPEN") continue;
      if (nowMs < basket.closesAtMs) continue;
      await this.closeBasket(basket, "HORIZON");
    }
  }

  private async closeBasket(basket: ExecutorBasket, reason: string): Promise<void> {
    let gross = 0;
    let notionalTouched = 0;
    for (const leg of basket.legs) {
      if (leg.exitOrderId !== null) continue; // already closed (retry path)
      const exitSide = leg.side === "LONG" ? "SELL" : "BUY";
      const order = await this.client.placeOrder({
        symbol: leg.symbol,
        side: exitSide,
        type: "MARKET",
        quantity: leg.qty,
        reduceOnly: true,
        newClientOrderId: `xsec-${basket.basketId.slice(-12)}-x${basket.legs.indexOf(leg)}`,
      });
      leg.exitOrderId = order.orderId;
      leg.exitPrice = order.avgPrice > 0 ? order.avgPrice : leg.entryPrice;
      const dir = leg.side === "LONG" ? 1 : -1;
      gross += dir * (leg.exitPrice - leg.entryPrice) * leg.qty;
      notionalTouched += leg.entryPrice * leg.qty + leg.exitPrice * leg.qty;
      this.store.save(); // persist per leg so a crash mid-close can resume
    }
    const fees = notionalTouched * TAKER_FEE_RATE;
    basket.status = "CLOSED";
    basket.closedAt = this.nowIso();
    basket.closeReason = reason;
    basket.grossPnlUsd = gross;
    basket.feeEstimateUsd = fees;
    basket.netPnlUsd = gross - fees;
    this.store.save();
  }

  private async maybeOpenBasket(): Promise<void> {
    const st = this.store.getState();
    if (st.baskets.filter((b) => b.status === "OPEN").length >= MAX_OPEN_BASKETS()) return;

    const nowMs = new Date(this.nowIso()).getTime();
    // Newest FRESH, still-OPEN signal of the target variant we haven't executed yet.
    // Default FILTERED: symbol-filtered baskets whose allow/blocklists auto-update from
    // measured per-leg returns (see deriveAdaptiveSymbolFilters).
    const targetVariant = EXEC_VARIANT();
    const candidates = this.signalStore.all
      .filter(
        (o: CrossSectionalObservation) =>
          o.status === "OPEN" &&
          (o.variant ?? "RAW") === targetVariant &&
          o.openedAtMs > st.lastSeenSignalMs &&
          nowMs - o.openedAtMs <= MAX_SIGNAL_AGE_MS(),
      )
      .sort((a: CrossSectionalObservation, b: CrossSectionalObservation) => b.openedAtMs - a.openedAtMs);
    const signal = candidates[0];
    if (!signal) return;

    // Watermark BEFORE placing orders: a failed basket must not retry forever.
    st.lastSeenSignalMs = signal.openedAtMs;
    this.store.save();

    const filters = await this.client.getExchangeFilters();
    const legUsd = this.effectiveLegUsd();
    if (!(legUsd > 0)) return;
    const plannedLegs: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; refPrice: number }> = [];
    for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
      for (const leg of legs) {
        const f = filters.get(leg.symbol);
        if (!f || !(leg.entryPrice > 0)) return; // missing filters/price ⇒ skip whole basket
        const rawQty = legUsd / leg.entryPrice;
        const qty = Math.floor(rawQty / f.stepSize) * f.stepSize;
        if (!(qty >= f.minQty)) return; // any un-sizeable leg ⇒ skip whole basket (hedge integrity)
        plannedLegs.push({ symbol: leg.symbol, side, qty: Number(qty.toFixed(8)), refPrice: leg.entryPrice });
      }
    }
    if (plannedLegs.length !== signal.longLeg.length + signal.shortLeg.length) return;

    const basket: ExecutorBasket = {
      basketId: `xb-${signal.openedAtMs.toString(36)}`,
      sourceObservationId: signal.observationId,
      signal: signal.signal,
      variant: signal.variant ?? "RAW",
      openedAt: this.nowIso(),
      closesAtMs: signal.openedAtMs + signal.horizonMs,
      legs: [],
      status: "OPEN",
      closedAt: null,
      closeReason: null,
      grossPnlUsd: null,
      feeEstimateUsd: null,
      netPnlUsd: null,
    };

    try {
      for (const planned of plannedLegs) {
        try {
          await this.client.setLeverage(planned.symbol, EXEC_LEVERAGE());
        } catch {
          // best-effort (already set / position exists)
        }
        const order = await this.client.placeOrder({
          symbol: planned.symbol,
          side: planned.side === "LONG" ? "BUY" : "SELL",
          type: "MARKET",
          quantity: planned.qty,
          newClientOrderId: `xsec-${basket.basketId.slice(-12)}-e${basket.legs.length}`,
        });
        basket.legs.push({
          symbol: planned.symbol,
          side: planned.side,
          qty: planned.qty,
          entryPrice: order.avgPrice > 0 ? order.avgPrice : planned.refPrice,
          entryOrderId: order.orderId,
          exitPrice: null,
          exitOrderId: null,
        });
      }
      st.baskets.push(basket);
      this.store.save();
    } catch (error) {
      // A partial basket is a NAKED directional bet — flatten whatever opened, record ABORTED.
      basket.status = "ABORTED";
      basket.closedAt = this.nowIso();
      basket.closeReason = `OPEN_FAILED:${(error as Error).message}`;
      for (const leg of basket.legs) {
        try {
          const flat = await this.client.placeOrder({
            symbol: leg.symbol,
            side: leg.side === "LONG" ? "SELL" : "BUY",
            type: "MARKET",
            quantity: leg.qty,
            reduceOnly: true,
            newClientOrderId: `xsec-${basket.basketId.slice(-12)}-a${basket.legs.indexOf(leg)}`,
          });
          leg.exitOrderId = flat.orderId;
          leg.exitPrice = flat.avgPrice > 0 ? flat.avgPrice : leg.entryPrice;
        } catch {
          // leave for the operator/reconcile — recorded as ABORTED with legs visible
        }
      }
      st.baskets.push(basket);
      this.store.save();
      throw error;
    }
  }
}

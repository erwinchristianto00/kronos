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

import { resolveConfirmedFillPrice, type BinanceFuturesPrivateClient, type FillPriceResolution } from "./binance-futures-private.js";
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  deriveAdaptiveSymbolFilters,
  type CrossSectionalObservation,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";

export const CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID = "CROSS_SECTIONAL_MARKET_NEUTRAL";
/** 2026-07-08: lane ids for the two additional executor instances (see CrossSectionalExecutorOptions
 *  targetVariant/laneId) that mirror the TREND_BETA_VOL / MIXED_MEAN_REVERSION measured variants.
 *  Each variant's own signal production already regime-gates itself (TREND_LONG/SHORT and
 *  MIXED_CHOP respectively, see cross-sectional-edge.ts's runCrossSectionalCycle) — these lane ids
 *  just let the operator/autopilot separately control the executor's allocation weight, same as
 *  every other lane. */
export const CROSS_SECTIONAL_TREND_LANE_ID = "CROSS_SECTIONAL_TREND";
export const CROSS_SECTIONAL_MIXED_LANE_ID = "CROSS_SECTIONAL_MIXED";

export type CrossSectionalExecClient = Pick<
  BinanceFuturesPrivateClient,
  "getExchangeFilters" | "placeOrder" | "setLeverage" | "getPositions" | "queryOrder"
>;

export function isCrossSectionalExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EXEC_ENABLED === "1";
}

/** 2026-07-07 operator decision: cross-sectional is the FOUNDATION strategy and must run at full
 *  size regardless of the lane-allocation selector — the selector becomes purely the control for
 *  the DIRECTIONAL mirror slot. Without this flag the executor's leg sizing was scaled by the
 *  selector's CROSS_SECTIONAL weight, so picking any directional allocation silently shrank (or
 *  zeroed) the foundation strategy. Armed/kill-switch gating is NOT affected by this flag. */
export function isCrossSectionalAllocationIndependent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_ALLOCATION_INDEPENDENT === "1";
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
/** Basket-level safety breaker (2026-07-07 operator: "safety net, bukan profit killer"): when the
 *  day's REALIZED basket losses breach this, STOP OPENING new baskets until UTC midnight. Open
 *  baskets keep running their own exits untouched — they are hedged and horizon-bounded, and
 *  force-flattening a hedge that can still recover would be exactly the profit-killer this is
 *  deliberately not. 0 = disabled. */
const XSEC_DAILY_MAX_LOSS_USD = () => {
  const n = Number.parseFloat(process.env.CROSS_SECTIONAL_DAILY_MAX_LOSS_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export interface ExecutorLeg {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: number;
  /** False when the exchange never confirmed a real fill price (see resolveFillPrice) and
   *  entryPrice fell back to the pre-trade reference price — a signal the recorded entry
   *  may not reflect what actually executed. True is the normal case. */
  entryPriceConfirmed: boolean;
  exitPrice: number | null;
  exitOrderId: number | null;
  /** Same caveat as entryPriceConfirmed, for the exit fill. Null while still open. */
  exitPriceConfirmed: boolean | null;
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
  /** Stamped by every profit-target check (5-min tick): the basket's CURRENT net return vs the
   *  TP threshold, so the dashboard can show the live TP gap per basket — "tinggal berapa lagi,
   *  bakal nyampe atau engga, ada yang macet atau engga" (2026-07-07 operator ask). */
  lastNetReturn?: number | null;
  lastNetAt?: string | null;
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

  constructor(dataDir = "data", fileName = "cross-sectional-executor.json") {
    this.file = resolve(dataDir, fileName);
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
  /** Delay between queryOrder confirmation retries in resolveFillPrice. Default 400ms; tests pass 0. */
  fillConfirmRetryDelayMs?: number;
  /** Daily basket loss breaker limit override (tests inject; default reads
   *  CROSS_SECTIONAL_DAILY_MAX_LOSS_USD — env mutation in tests leaks across vitest workers). */
  dailyMaxLossUsd?: () => number;
  /** 2026-07-08 (operator: "wire lane baru ke allocation selection"): which measured cross-sectional
   *  variant THIS executor instance mirrors. Defaults to the original global env read
   *  (CROSS_SECTIONAL_EXEC_VARIANT, "FILTERED") so the existing single-instance construction is
   *  byte-for-byte unchanged. Explicit override lets app.ts run MULTIPLE executor instances
   *  concurrently — one per variant (FILTERED/TREND_BETA_VOL/MIXED_MEAN_REVERSION) — each with its
   *  own lane id + allocation weight, instead of one global instance stuck on a single variant. */
  targetVariant?: string;
  /** Lane id this instance reports in getStatus()/laneWeightPct lookups. Defaults to the original
   *  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID (unchanged for the existing FILTERED instance). */
  laneId?: string;
}

export class CrossSectionalExecutor {
  private readonly client: CrossSectionalExecClient;
  private readonly signalStore: CrossSectionalStore;
  private readonly store: CrossSectionalExecutorStore;
  private readonly isAllowed: () => boolean;
  private readonly fillConfirmRetryDelayMs: number;
  private readonly laneWeightPct: () => number;
  private readonly nowIso: () => string;
  private readonly targetVariant: string;
  private readonly laneId: string;
  private ticking = false;
  private lastError: string | null = null;
  private openHalted: string | null = null;
  private readonly dailyMaxLossUsdFn: () => number;

  constructor(opts: CrossSectionalExecutorOptions) {
    this.client = opts.client;
    this.signalStore = opts.signalStore;
    this.store = opts.store;
    this.isAllowed = opts.isAllowed;
    this.laneWeightPct = opts.laneWeightPct ?? (() => 100);
    this.targetVariant = opts.targetVariant ?? EXEC_VARIANT();
    this.laneId = opts.laneId ?? CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID;
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.fillConfirmRetryDelayMs = opts.fillConfirmRetryDelayMs ?? 400;
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? XSEC_DAILY_MAX_LOSS_USD;
  }

  /** Thin wrapper over the shared resolveConfirmedFillPrice, injecting this executor's
   *  test-overridable retry delay and a lane-tagged log line. See binance-futures-private.ts
   *  for why this confirmation step exists (basket xb-mr2x7s6e's real-world avgPrice=0 case). */
  private async resolveFillPrice(
    symbol: string,
    orderId: number,
    initialAvgPrice: number,
    fallbackPrice: number,
  ): Promise<FillPriceResolution> {
    return resolveConfirmedFillPrice(this.client, symbol, orderId, initialAvgPrice, fallbackPrice, {
      retryDelayMs: this.fillConfirmRetryDelayMs,
      onUnconfirmed: (sym, id, fallback) =>
        console.error(
          `[cross-sectional-executor] UNCONFIRMED FILL PRICE: ${sym} order ${id} never returned a ` +
            `real avgPrice after retries — recording ${fallback} as a fallback, but this is NOT a ` +
            `confirmed fill price. PnL involving this leg should be treated as uncertain.`,
        ),
    });
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
    /** Profit-bank threshold as % of deployed capital — shown next to each basket's TP gap. */
    tpNetReturnPct: number;
    /** Realized basket P&L for the current UTC day + the safety-breaker limit (0 = disabled). */
    dailyRealizedUsd: number;
    dailyMaxLossUsd: number;
    /** Non-null while the daily-loss breaker is holding NEW opens (open baskets unaffected). */
    openHalted: string | null;
    openBasket: ExecutorBasket | null;
    /** ALL currently-open baskets, not just the first (openBasket, kept for compatibility, is
     *  just openBaskets[0]). MAX_OPEN_BASKETS can exceed 1 (e.g. testnet runs 4) — any consumer
     *  attributing exchange positions to this lane must attribute EVERY open basket's legs, not
     *  only the first, or the 2nd+ basket's real positions silently show as unattributed. */
    openBaskets: ExecutorBasket[];
    closedCount: number;
    totalNetPnlUsd: number;
    lastError: string | null;
    recent: ExecutorBasket[];
    /** Age of the newest matching-variant OPEN signal, in ms; null if none exist at all.
     *  A basket can only open from a signal within MAX_SIGNAL_AGE_MS of now — surfaced here
     *  so a stuck signal pipeline (upstream of this executor) is visible, not silent. */
    signalAgeMs: number | null;
    signalMaxAgeMs: number;
    signalStale: boolean;
    /** Whether the currently-configured allowlist would have starved a side below the legs a
     *  basket needs (2026-07-07: this silently blocked SHORT-side baskets for ~18h on live —
     *  see deriveAdaptiveSymbolFilters's floor). Recomputed live from the signal store, so this
     *  reflects the CURRENT cycle, not a stale snapshot. */
    adaptiveFilters: ReturnType<typeof deriveAdaptiveSymbolFilters>["provenance"];
  } {
    const st = this.store.getState();
    const closed = st.baskets.filter((b) => b.status === "CLOSED");
    const openBaskets = st.baskets.filter((b) => b.status === "OPEN");
    const targetVariant = this.targetVariant;
    const nowMs = new Date(this.nowIso()).getTime();
    const matching = this.signalStore.all
      .filter((o) => (o.variant ?? "RAW") === targetVariant)
      .sort((a, b) => b.openedAtMs - a.openedAtMs);
    const signalAgeMs = matching[0] ? nowMs - matching[0].openedAtMs : null;
    const signalMaxAgeMs = MAX_SIGNAL_AGE_MS();
    return {
      enabled: isCrossSectionalExecEnabled(),
      allowed: this.isAllowed(),
      laneId: this.laneId,
      legUsd: this.effectiveLegUsd(),
      baseLegUsd: LEG_USD(),
      allocationWeightPct: this.allocationWeightPct(),
      leverage: EXEC_LEVERAGE(),
      variant: targetVariant,
      tpNetReturnPct: TP_NET_RETURN() * 100,
      dailyRealizedUsd: this.dailyRealizedUsd(this.nowIso()),
      dailyMaxLossUsd: this.dailyMaxLossUsdFn(),
      openHalted: this.openHalted,
      openBasket: openBaskets[0] ?? null,
      openBaskets,
      closedCount: closed.length,
      totalNetPnlUsd: closed.reduce((s, b) => s + (b.netPnlUsd ?? 0), 0),
      lastError: this.lastError,
      recent: st.baskets.slice(-10),
      signalAgeMs,
      signalMaxAgeMs,
      signalStale: signalAgeMs === null || signalAgeMs > signalMaxAgeMs,
      adaptiveFilters: deriveAdaptiveSymbolFilters(this.signalStore).provenance,
    };
  }

  /** Realized results of every CLOSED basket, for account-level display: the engine's own
   *  realized ledger deliberately excludes these positions (they are external-managed claims,
   *  not engine intents), so without this summary a banked basket increases the REAL wallet
   *  balance while every "realized P&L" surface stays flat — exactly the operator confusion
   *  this exists to prevent (2026-07-07: "+1.45 banked, kok realized ga nambah??"). */
  getClosedSummary(): {
    closedCount: number;
    wins: number;
    losses: number;
    realizedPnlUsd: number;
    feesUsd: number;
    symbols: string[];
    lastClosedAt: string | null;
  } {
    const closed = this.store.getState().baskets.filter((b) => b.status === "CLOSED");
    const symbols = new Set<string>();
    let realized = 0;
    let fees = 0;
    let wins = 0;
    let losses = 0;
    let lastClosedAt: string | null = null;
    for (const b of closed) {
      const net = b.netPnlUsd ?? 0;
      realized += net;
      fees += b.feeEstimateUsd ?? 0;
      if (net > 0) wins += 1;
      else losses += 1;
      for (const leg of b.legs) symbols.add(leg.symbol);
      if (b.closedAt && (lastClosedAt === null || b.closedAt > lastClosedAt)) lastClosedAt = b.closedAt;
    }
    return { closedCount: closed.length, wins, losses, realizedPnlUsd: realized, feesUsd: fees, symbols: [...symbols].sort(), lastClosedAt };
  }

  /** Every CLOSED basket, store order — feeds account-level merges that need per-basket
   *  closedAt/netPnl (e.g. the lane-performance timeline) rather than the aggregate summary. */
  getClosedBaskets(): ExecutorBasket[] {
    return this.store.getState().baskets.filter((b) => b.status === "CLOSED");
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
    let stamped = false;
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
      basket.lastNetReturn = netReturn;
      basket.lastNetAt = this.nowIso();
      stamped = true;
      if (netReturn >= threshold) await this.closeBasket(basket, "PROFIT_BANK");
    }
    if (stamped) this.store.save(); // persist the TP-gap stamps for the dashboard
  }

  /** Realized basket P&L for the current UTC day — feeds the basket-level safety breaker. */
  private dailyRealizedUsd(nowIso: string): number {
    const day = nowIso.slice(0, 10);
    let sum = 0;
    for (const b of this.store.getState().baskets) {
      if (b.status === "CLOSED" && b.closedAt && b.closedAt.slice(0, 10) === day && b.netPnlUsd !== null) {
        sum += b.netPnlUsd;
      }
    }
    return sum;
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

  /** Un-exited qty that OTHER open baskets hold on this symbol on the OPPOSITE side. When this
   *  covers a leg's qty, closing the leg without reduceOnly is pure cross-basket bookkeeping:
   *  Binance nets per symbol, so the "close" order just transfers the exposure to the sibling
   *  baskets that legitimately own the other side — it can never create exposure the executor's
   *  own books don't account for. */
  private siblingOppositeUnexitedQty(basket: ExecutorBasket, symbol: string, side: "LONG" | "SHORT"): number {
    let qty = 0;
    for (const other of this.store.getState().baskets) {
      if (other === basket || other.status !== "OPEN") continue;
      for (const leg of other.legs) {
        if (leg.symbol === symbol && leg.side !== side && leg.exitOrderId === null) qty += leg.qty;
      }
    }
    return qty;
  }

  private async closeBasket(basket: ExecutorBasket, reason: string): Promise<void> {
    const failures: string[] = [];
    for (const leg of basket.legs) {
      if (leg.exitOrderId !== null) continue; // already closed (retry path)
      const exitSide = leg.side === "LONG" ? "SELL" : "BUY";
      // reduceOnly is the default guard against over-closing stale basket state — but with
      // overlapping baskets the NETTED account position can carry the opposite sign (e.g. this
      // basket long SOL while two siblings are short SOL ⇒ account net short), and Binance then
      // rejects the reduce-only close with -2022, wedging the basket half-closed forever
      // (2026-07-07: testnet basket xb-mr7zdpiz stuck exactly this way for hours). Drop the flag
      // ONLY when sibling baskets' un-exited opposite exposure fully covers this leg — the one
      // case where a plain market close is provably just bookkeeping between our own baskets.
      const reduceOnly = this.siblingOppositeUnexitedQty(basket, leg.symbol, leg.side) < leg.qty - 1e-9;
      try {
        const order = await this.client.placeOrder({
          symbol: leg.symbol,
          side: exitSide,
          type: "MARKET",
          quantity: leg.qty,
          ...(reduceOnly ? { reduceOnly: true } : {}),
          newClientOrderId: `xsec-${basket.basketId.slice(-12)}-x${basket.legs.indexOf(leg)}`,
        });
        leg.exitOrderId = order.orderId;
        const resolved = await this.resolveFillPrice(leg.symbol, order.orderId, order.avgPrice, leg.entryPrice);
        leg.exitPrice = resolved.price;
        leg.exitPriceConfirmed = resolved.confirmed;
      } catch (error) {
        // Keep attempting the REMAINING legs — aborting mid-loop leaves more naked exposure
        // stuck open than closing what we can. The basket stays OPEN and retries next tick.
        failures.push(`${leg.symbol}: ${(error as Error).message}`);
      }
      this.store.save(); // persist per leg so a crash/retry mid-close can resume
    }
    if (failures.length > 0) {
      throw new Error(`basket ${basket.basketId} close incomplete, ${failures.length} leg(s) failed: ${failures[0]}`);
    }
    // Finalize P&L from the STORED per-leg prices, not a loop-local accumulator: on a retry after
    // a partial close, the already-exited legs are skipped above, and the old accumulator silently
    // EXCLUDED them from the basket's final P&L.
    let gross = 0;
    let notionalTouched = 0;
    for (const leg of basket.legs) {
      const exit = leg.exitPrice ?? leg.entryPrice;
      const dir = leg.side === "LONG" ? 1 : -1;
      gross += dir * (exit - leg.entryPrice) * leg.qty;
      notionalTouched += leg.entryPrice * leg.qty + exit * leg.qty;
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
    // Basket safety breaker: halt NEW opens after a bad realized day; never touches open baskets.
    const lossLimit = this.dailyMaxLossUsdFn();
    if (lossLimit > 0) {
      const dayRealized = this.dailyRealizedUsd(this.nowIso());
      if (dayRealized <= -lossLimit) {
        this.openHalted = `daily basket loss breaker: realized ${dayRealized.toFixed(2)} USDT ≤ -${lossLimit} — new opens halted until UTC midnight (open baskets keep their own exits)`;
        return;
      }
    }
    this.openHalted = null;
    if (st.baskets.filter((b) => b.status === "OPEN").length >= MAX_OPEN_BASKETS()) return;

    const nowMs = new Date(this.nowIso()).getTime();
    // Newest FRESH, still-OPEN signal of the target variant we haven't executed yet.
    // Default FILTERED: symbol-filtered baskets whose allow/blocklists auto-update from
    // measured per-leg returns (see deriveAdaptiveSymbolFilters).
    const targetVariant = this.targetVariant;
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
        const resolvedEntry = await this.resolveFillPrice(planned.symbol, order.orderId, order.avgPrice, planned.refPrice);
        basket.legs.push({
          symbol: planned.symbol,
          side: planned.side,
          qty: planned.qty,
          entryPrice: resolvedEntry.price,
          entryOrderId: order.orderId,
          entryPriceConfirmed: resolvedEntry.confirmed,
          exitPrice: null,
          exitOrderId: null,
          exitPriceConfirmed: null,
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
          const resolvedFlat = await this.resolveFillPrice(leg.symbol, flat.orderId, flat.avgPrice, leg.entryPrice);
          leg.exitPrice = resolvedFlat.price;
          leg.exitPriceConfirmed = resolvedFlat.confirmed;
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

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
  regimeSkewCounterfactual,
  type RegimeSkewCounterfactual,
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
  "getExchangeFilters" | "placeOrder" | "setLeverage" | "getPositions" | "queryOrder" | "getUserTrades"
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
/** Store never capped closed/aborted baskets, growing forever. Keeps every OPEN basket
 *  unconditionally and caps settled (CLOSED/ABORTED) ones to the newest N by openedAt. */
const MAX_STORED_BASKETS = () =>
  Math.max(1, Math.floor(Number(process.env.CROSS_SECTIONAL_EXEC_MAX_STORED_BASKETS) || 2000));
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
  entryOrderId: string;
  /** False when the exchange never confirmed a real fill price (see resolveFillPrice) and
   *  entryPrice fell back to the pre-trade reference price — a signal the recorded entry
   *  may not reflect what actually executed. True is the normal case. */
  entryPriceConfirmed: boolean;
  exitPrice: number | null;
  exitOrderId: string | null;
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

/**
 * 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): a REAL, still-open exchange
 * position that this executor's normal bookkeeping can no longer reach through its usual
 * HORIZON/PROFIT_BANK close paths. Two origins:
 *  - maybeOpenBasket's abort path: one leg already opened, a LATER leg's placeOrder then threw
 *    (a naked directional bet), and the abort handler's OWN flatten attempt for the already-opened
 *    leg ALSO failed (e.g. a sibling XSEC executor already holds the opposite side on this symbol,
 *    or a transient exchange/network error). Before this existed, that leg fell out of the
 *    basket's bookkeeping entirely — recorded ABORTED with exitOrderId still null, but nothing
 *    ever looked at it again.
 *  - closeBasket's exit path: a genuine partial MARKET fill on the reduce-only close order left a
 *    real, un-closed remainder on the exchange (see BUG 3's executedQty validation) — the
 *    remainder is tracked here exactly like a failed-flatten leg, not silently dropped.
 * retryOrphanedLegFlattens() retries the flatten every tick until it actually resolves (either a
 * real fill, or the exchange confirming the position is already flat/opposite-signed — never
 * blindly retried forever against a position that's already gone). getStatus().orphanedLegs
 * surfaces this list so an operator (or a future account-wide reconciliation) can never mistake a
 * still-failing retry for "handled".
 */
export interface OrphanedLeg {
  basketId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  entryOrderId: string;
  /** ISO timestamp of the ORIGINAL failure that created this record — never updated on retry. */
  since: string;
  lastAttemptAt: string;
  lastError: string;
  attempts: number;
}

interface ExecutorState {
  version: number;
  baskets: ExecutorBasket[];
  /** openedAtMs watermark — signals at/below this are never re-executed. */
  lastSeenSignalMs: number;
  /** See OrphanedLeg's doc comment. Persisted so a restart doesn't lose track of a still-exposed
   *  position — same convention as live-execution-engine.ts's killSwitchFlattenFailedIntentIds. */
  orphanedLegs: OrphanedLeg[];
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
        if (parsed && Array.isArray(parsed.baskets)) {
          // Legacy records persisted before entryOrderId/exitOrderId became strings (see
          // binance-futures-private.ts's order-ID precision fix) still have these as bare JS
          // numbers on disk — normalize on load so trade-matching `===` against a freshly
          // fetched (genuinely string) order id doesn't silently mismatch on type alone.
          for (const b of parsed.baskets as Array<{ legs?: Array<Record<string, unknown>> }>) {
            for (const leg of b.legs ?? []) {
              if (typeof leg.entryOrderId === "number") leg.entryOrderId = String(leg.entryOrderId);
              if (typeof leg.exitOrderId === "number") leg.exitOrderId = String(leg.exitOrderId);
            }
          }
          // 2026-07-19 real-money audit fix (BUG 1): legacy records persisted before
          // orphanedLegs existed have no such field on disk — default it, never leave it
          // undefined (every reader below assumes an array).
          if (!Array.isArray((parsed as { orphanedLegs?: unknown }).orphanedLegs)) {
            (parsed as { orphanedLegs: OrphanedLeg[] }).orphanedLegs = [];
          }
          return parsed as ExecutorState;
        }
      }
    } catch {
      // corrupt → fresh (positions reconcile against the exchange on next tick)
    }
    return { version: 1, baskets: [], lastSeenSignalMs: Date.now(), orphanedLegs: [] };
  }

  getState(): ExecutorState {
    return this.state;
  }

  private prune(): void {
    const max = MAX_STORED_BASKETS();
    if (this.state.baskets.length <= max) return;
    const open = this.state.baskets.filter((b) => b.status === "OPEN");
    const settled = this.state.baskets
      .filter((b) => b.status !== "OPEN")
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, Math.max(0, max - open.length));
    this.state.baskets = [...open, ...settled];
  }

  save(): void {
    try {
      this.prune();
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
  /** Rolling evidence gate for NEW baskets. Existing baskets keep closing while this is false. */
  entryHealthGate?: () => { allowed: boolean; reason: string | null };
  /** 2026-07-11 real-money audit fix: FILTERED/TREND/MIXED are 3 separate CrossSectionalExecutor
   *  instances, each with its OWN store file, sharing ONE exchange account that Binance nets per
   *  symbol. siblingOppositeUnexitedQty() used to only ever see THIS instance's own baskets — so a
   *  same-symbol opposite-side leg owned by a SIBLING instance was invisible, and dropping
   *  reduceOnly on that basis could either be wrongly refused (a real -2022 later) or wrongly
   *  granted (masking real over-exposure) depending on what the sibling actually held. Defaults to
   *  none (existing single-instance behavior/tests unchanged); app.ts wires each instance to query
   *  the other two's getOpenUnexitedLegs().
   */
  siblingOpenLegs?: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>;
  /** 2026-07-12 fix: dailyRealizedUsd() only ever summed THIS instance's own CLOSED baskets, but
   *  XSEC_DAILY_MAX_LOSS_USD is ONE shared env ceiling checked independently per instance in
   *  maybeOpenBasket — so the REAL combined daily loss across all 3 sibling instances could reach
   *  up to 3x the configured limit before any single instance's own admission check ever halted.
   *  Defaults to none (existing single-instance behavior/tests unchanged); app.ts wires each
   *  instance to sum the other two's getDailyRealizedUsd(nowIso). */
  siblingDailyRealizedUsd?: (nowIso: string) => number;
  /** 2026-07-12 fix: closeBasketsHittingProfitTarget() called this.client.getPositions() (an
   *  uncached, unfiltered signed GET against the account-wide weight budget) independently in
   *  every one of the 3 sibling instances' 5-minute ticks, purely to read symbol-level markPrice —
   *  market-wide data all 3 could share from ONE call. Optional override so app.ts can inject a
   *  short-TTL shared cache across all 3 instances; defaults to the direct client call (existing
   *  single-instance behavior/tests unchanged). */
  sharedGetPositions?: () => ReturnType<CrossSectionalExecClient["getPositions"]>;
  /** 2026-07-19 real-money audit fix: notional (USD) already committed to a symbol by every
   *  OTHER executor sharing this netted Binance account — the 9 SingleSymbolLaneExecutor
   *  instances AND the 2 sibling CrossSectionalExecutor instances (never `self`; app.ts wires
   *  this the same way notionalForSymbolExcluding does for the single-symbol side — see
   *  live-executor-wiring.ts's computeNotionalPerSymbol doc comment). Before this option existed,
   *  a cross-sectional basket leg had ZERO visibility into what the single-symbol lanes (or its
   *  own siblings) already held on the same symbol, so a leg could stack arbitrarily on top of an
   *  already-capped single-symbol position. Defaults to `() => 0` (no other executor's exposure
   *  known / not wired) — existing single-instance construction and tests are unaffected. Paired
   *  with `maxNotionalPerSymbolAcrossLanes` below. */
  existingNotionalForSymbol?: (symbol: string) => number;
  /** 0 (default) = no cap, byte-identical to pre-2026-07-19 behavior. A fresh leg whose notional,
   *  ADDED to existingNotionalForSymbol's reading for that symbol PLUS this instance's own
   *  already-open basket legs on it, would exceed this is skipped — but per this executor's own
   *  hedge-integrity design constraint (see the module doc comment at the top of this file: "Either
   *  the WHOLE basket opens or nothing"), a capped leg skips the ENTIRE basket this tick, exactly
   *  like the existing missing-filters/un-sizeable-leg checks in maybeOpenBasket. This constraint is
   *  TRANSIENT (another lane's position on the symbol may close by the next tick, freeing capacity)
   *  — the watermark is already advanced before this check runs, so the signal is not retried, but
   *  the NEXT fresh signal on the same symbol gets a clean re-evaluation. */
  maxNotionalPerSymbolAcrossLanes?: () => number;
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
  private readonly entryHealthGate: () => { allowed: boolean; reason: string | null };
  private readonly siblingOpenLegs: () => Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }>;
  private readonly siblingDailyRealizedUsd: (nowIso: string) => number;
  private readonly sharedGetPositions: () => ReturnType<CrossSectionalExecClient["getPositions"]>;
  private readonly existingNotionalForSymbolFn: (symbol: string) => number;
  private readonly maxNotionalPerSymbolAcrossLanesFn: () => number;

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
    this.existingNotionalForSymbolFn = opts.existingNotionalForSymbol ?? (() => 0);
    this.maxNotionalPerSymbolAcrossLanesFn = opts.maxNotionalPerSymbolAcrossLanes ?? (() => 0);
    this.dailyMaxLossUsdFn = opts.dailyMaxLossUsd ?? XSEC_DAILY_MAX_LOSS_USD;
    this.entryHealthGate = opts.entryHealthGate ?? (() => ({ allowed: true, reason: null }));
    this.siblingOpenLegs = opts.siblingOpenLegs ?? (() => []);
    this.siblingDailyRealizedUsd = opts.siblingDailyRealizedUsd ?? (() => 0);
    this.sharedGetPositions = opts.sharedGetPositions ?? (() => this.client.getPositions());
  }

  /** This instance's own open (status OPEN), un-exited (exitOrderId===null) basket legs — the
   *  surface a sibling CrossSectionalExecutor instance needs to see THIS instance's exposure. */
  getOpenUnexitedLegs(): Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> {
    const out: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number }> = [];
    for (const basket of this.store.getState().baskets) {
      if (basket.status !== "OPEN") continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null) out.push({ symbol: leg.symbol, side: leg.side, qty: leg.qty });
      }
    }
    return out;
  }

  /** 2026-07-19 real-money audit fix: this instance's OWN open (un-exited) basket legs' notional
   *  on `symbol` — existingNotionalForSymbolFn only ever sums OTHER executor instances (see its own
   *  doc comment), and MAX_OPEN_BASKETS can exceed 1, so THIS instance alone could hold multiple
   *  concurrent baskets whose legs overlap on the same symbol, invisible to the cap without this
   *  (same self-inclusion fix single-symbol-lane-executor.ts already applies for its own kind). */
  private ownOpenNotionalForSymbol(symbol: string): number {
    let sum = 0;
    for (const basket of this.store.getState().baskets) {
      if (basket.status !== "OPEN") continue;
      for (const leg of basket.legs) {
        if (leg.exitOrderId === null && leg.symbol === symbol) sum += leg.qty * leg.entryPrice;
      }
    }
    return sum;
  }

  private entryHealth(): { allowed: boolean; reason: string | null } {
    try {
      const decision = this.entryHealthGate();
      return decision && typeof decision.allowed === "boolean"
        ? { allowed: decision.allowed, reason: decision.reason ?? null }
        : { allowed: false, reason: "invalid cross-sectional entry-health response" };
    } catch (error) {
      return { allowed: false, reason: `cross-sectional entry-health failed: ${(error as Error).message}` };
    }
  }

  /** Thin wrapper over the shared resolveConfirmedFillPrice, injecting this executor's
   *  test-overridable retry delay and a lane-tagged log line. See binance-futures-private.ts
   *  for why this confirmation step exists (basket xb-mr2x7s6e's real-world avgPrice=0 case). */
  private async resolveFillPrice(
    symbol: string,
    orderId: string,
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
    // 2026-07-10: isCrossSectionalAllocationIndependent() was defined (2026-07-07, see its own doc
    // comment above) but never actually consulted here — the foundation lane's real leg size was
    // silently scaled by whatever % the operator gave CROSS_SECTIONAL_MARKET_NEUTRAL in the
    // directional-slot allocation table (confirmed live: 80% weight -> $20 legUsd instead of the
    // documented "$25 full size regardless of allocation"). Only the foundation lane is exempted —
    // CROSS_SECTIONAL_TREND/MIXED (separate instances, own laneId) still scale normally, matching
    // their own doc comment ("let the operator/autopilot separately control the executor's
    // allocation weight, same as every other lane").
    if (isCrossSectionalAllocationIndependent() && this.laneId === CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID) {
      return 100;
    }
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
    /** 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): real, still-open exchange
     *  exposure this executor's normal HORIZON/PROFIT_BANK close paths can no longer reach — see
     *  OrphanedLeg's doc comment. retryOrphanedLegFlattens() retries every tick automatically, but
     *  a NON-EMPTY array here means a position is, right now, still open on the exchange with
     *  every retry so far having failed — an operator (or a future account-wide reconciliation)
     *  must never mistake a still-failing retry for "handled". */
    orphanedLegs: OrphanedLeg[];
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
      allowed: this.isAllowed() && this.entryHealth().allowed,
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
      orphanedLegs: st.orphanedLegs ?? [],
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

  /** 2026-07-12 (profitability Stage 3): report-only regime-skew counterfactual over THIS
   *  executor's real closed baskets — see regimeSkewCounterfactual. Lets the operator see whether
   *  the CROSS_SECTIONAL_REGIME_SKEW tilt (which converts the only true hedge into more same-side
   *  beta) is actually being rewarded, before deciding to keep or disable it. Never affects trading. */
  getRegimeSkewCounterfactual(): RegimeSkewCounterfactual {
    const closed = this.store.getState().baskets.filter((b) => b.status === "CLOSED");
    return regimeSkewCounterfactual(closed);
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
    // 2026-07-19 real-money audit fix (BUG 2): reset HERE, at the top, not unconditionally after
    // every phase runs. closeBasketsHittingProfitTarget()/closeDueBaskets() now catch and record
    // per-basket close failures internally (see their own per-basket try/catch) so ONE wedged
    // basket can no longer abort the whole tick — but that means a failure recorded mid-tick must
    // survive to the end of this function; a trailing unconditional `this.lastError = null` would
    // silently wipe it out the moment the rest of the tick completes without ALSO throwing.
    this.lastError = null;
    try {
      // 2026-07-19 real-money audit fix (BUG 1): retry any leg the basket-open abort path (or a
      // partial exit fill, see BUG 3) previously failed to flatten — see OrphanedLeg's doc
      // comment. Runs FIRST, every tick, for as long as it stays unresolved; a transient failure
      // must self-heal, not leave real exposure silently open forever.
      await this.retryOrphanedLegFlattens();
      await this.closeBasketsHittingProfitTarget();
      await this.closeDueBaskets();
      await this.ensureOpenBasketLeverage();
      const health = this.entryHealth();
      if (!health.allowed) {
        this.openHalted = health.reason ?? "rolling evidence gate blocked new baskets";
      } else if (this.isAllowed()) {
        await this.maybeOpenBasket();
      }
    } catch (error) {
      this.lastError = (error as Error).message ?? "tick failed";
    } finally {
      this.ticking = false;
    }
  }

  /** 2026-07-12 kill-switch response fix: orderly close of every OPEN basket via this executor's
   *  OWN closeBasket mechanics (reduce-only orders with the netting-aware -2022/stale-book
   *  handling) — NEVER a blanket symbol flatten, which would recreate the 2026-07-07
   *  netting-blind-closes incident by eating sibling hedges on shared symbols. Per-basket failures
   *  are collected, not fatal: the account-wide breaker must close as much as it can even when one
   *  basket wedges (that basket stays OPEN and keeps retrying on its own tick). */
  async closeAllBasketsOrderly(reason: string): Promise<{ closed: number; failed: number }> {
    const st = this.store.getState();
    const open = st.baskets.filter((b) => b.status === "OPEN");
    let closed = 0;
    let failed = 0;
    for (const basket of open) {
      try {
        await this.closeBasket(basket, reason);
        if (basket.status !== "OPEN") closed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        this.lastError = (error as Error).message ?? "kill-switch basket close failed";
      }
    }
    return { closed, failed };
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

    const positions = await this.sharedGetPositions();
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
      if (netReturn >= threshold) {
        // 2026-07-19 real-money audit fix (BUG 2): isolate this basket's close attempt so one
        // wedged basket (repeated throw, e.g. a persistent margin/rate-limit condition) cannot
        // prevent OTHER healthy baskets in this same loop from being processed this tick — mirrors
        // closeAllBasketsOrderly's own per-basket try/catch isolation above.
        try {
          await this.closeBasket(basket, "PROFIT_BANK");
        } catch (error) {
          this.lastError = (error as Error).message ?? "profit-bank close failed";
        }
      }
    }
    if (stamped) this.store.save(); // persist the TP-gap stamps for the dashboard
  }

  /** Public surface for sibling instances to sum THIS instance's daily realized P&L — see
   *  CrossSectionalExecutorOptions.siblingDailyRealizedUsd's doc comment. */
  getDailyRealizedUsd(nowIso: string): number {
    return this.dailyRealizedUsd(nowIso);
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
      // 2026-07-19 real-money audit fix (BUG 2): same per-basket isolation as
      // closeBasketsHittingProfitTarget above — one basket's HORIZON close failing must not block
      // every OTHER due basket from being closed this tick.
      try {
        await this.closeBasket(basket, "HORIZON");
      } catch (error) {
        this.lastError = (error as Error).message ?? "horizon close failed";
      }
    }
  }

  /** Un-exited qty that OTHER open baskets hold on this symbol on the OPPOSITE side. When this
   *  covers a leg's qty, closing the leg without reduceOnly is pure cross-basket bookkeeping:
   *  Binance nets per symbol, so the "close" order just transfers the exposure to the sibling
   *  baskets that legitimately own the other side — it can never create exposure the executor's
   *  own books don't account for.
   *
   *  2026-07-11 real-money audit fix: FILTERED/TREND/MIXED are 3 SEPARATE executor instances on
   *  the SAME netted account — this used to only scan THIS instance's own store, so a same-symbol
   *  opposite-side leg owned by a sibling instance was invisible. Now also includes siblingOpenLegs()
   *  (injected in app.ts as the other 2 instances' getOpenUnexitedLegs()). */
  private siblingOppositeUnexitedQty(basket: ExecutorBasket, symbol: string, side: "LONG" | "SHORT"): number {
    let qty = 0;
    for (const other of this.store.getState().baskets) {
      if (other === basket || other.status !== "OPEN") continue;
      for (const leg of other.legs) {
        if (leg.symbol === symbol && leg.side !== side && leg.exitOrderId === null) qty += leg.qty;
      }
    }
    for (const leg of this.siblingOpenLegs()) {
      if (leg.symbol === symbol && leg.side !== side) qty += leg.qty;
    }
    return qty;
  }

  private async closeBasket(basket: ExecutorBasket, reason: string): Promise<void> {
    const failures: string[] = [];
    let staleBookReconciled = false;
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
        const resolved = await this.resolveFillPrice(leg.symbol, order.orderId, order.avgPrice, leg.entryPrice);
        // 2026-07-19 real-money audit fix (BUG 3): a genuine partial MARKET fill on the close
        // order leaves a real, un-closed remainder on the exchange — recording this leg as fully
        // exited would silently understate the account's true exposure. If executedQty
        // meaningfully undershoots the requested qty, only the FILLED portion is booked as
        // closed on this leg (at the confirmed fill price); the un-filled remainder is tracked
        // via the SAME orphaned-leg retry mechanism as BUG 1 (this basket stays consistent —
        // exitOrderId is still set, so the basket's own lifecycle isn't blocked — while the
        // residual keeps getting flattened automatically every tick until it too resolves).
        const executedQty = Number.isFinite(order.executedQty) ? order.executedQty : leg.qty;
        const shortfall = leg.qty - executedQty;
        if (shortfall > 1e-9) {
          this.recordOrphanedLeg(
            basket,
            { ...leg, qty: shortfall },
            new Error(`partial close fill: requested ${leg.qty}, executed ${executedQty} — residual ${shortfall} still open`),
          );
          leg.qty = executedQty > 0 ? executedQty : leg.qty;
        }
        leg.exitOrderId = order.orderId;
        leg.exitPrice = resolved.price;
        leg.exitPriceConfirmed = resolved.confirmed;
      } catch (error) {
        const message = (error as Error).message;
        if (reduceOnly && /(?:code\s*)?-2022|ReduceOnly Order is rejected/i.test(message)) {
          try {
            const positions = await this.client.getPositions(leg.symbol);
            const positionAmt = positions.find((position) => position.symbol === leg.symbol)?.positionAmt ?? 0;
            const expectedSign = leg.side === "LONG" ? 1 : -1;
            // The exchange no longer carries enough same-side quantity for this book leg. Retrying
            // without reduceOnly would CREATE opposite exposure. Reconcile as ABORTED (no invented
            // P&L), continue flattening every other real leg, and remove the stale claim safely.
            if (Math.abs(positionAmt) <= 1e-9 || Math.sign(positionAmt) !== expectedSign) {
              leg.exitOrderId = "POSITION_ALREADY_FLAT";
              leg.exitPrice = null;
              leg.exitPriceConfirmed = false;
              staleBookReconciled = true;
              this.store.save();
              continue;
            }
          } catch {
            // Position lookup failed: preserve the original error/retry behavior below.
          }
        }
        // Keep attempting the REMAINING legs — aborting mid-loop leaves more naked exposure
        // stuck open than closing what we can. The basket stays OPEN and retries next tick.
        failures.push(`${leg.symbol}: ${message}`);
      }
      this.store.save(); // persist per leg so a crash/retry mid-close can resume
    }
    if (failures.length > 0) {
      throw new Error(`basket ${basket.basketId} close incomplete, ${failures.length} leg(s) failed: ${failures[0]}`);
    }
    if (staleBookReconciled) {
      basket.status = "ABORTED";
      basket.closedAt = this.nowIso();
      basket.closeReason = `RECONCILED_POSITION_ALREADY_FLAT:${reason}`;
      basket.grossPnlUsd = null;
      basket.feeEstimateUsd = null;
      basket.netPnlUsd = null;
      this.store.save();
      return;
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
    // 2026-07-12 fee-recording fix: prefer REAL exchange commissions over the flat TAKER_FEE_RATE
    // estimate — one getUserTrades page per unique symbol, filtered to THIS basket's own entry/exit
    // orderIds (correct on the shared netted account, same convention as every other settle path).
    // The flat estimate remains the fallback when any fetch fails (the basket must still finish
    // closing bookkeeping-wise this tick), and when no trade matched at all (paranoia: an empty
    // real sum on legs that demonstrably filled means the page missed them, not that they were free).
    let realFees: number | null = 0;
    let sawAnyTrade = false;
    const orderIdsBySymbol = new Map<string, Set<string>>();
    for (const leg of basket.legs) {
      const ids = orderIdsBySymbol.get(leg.symbol) ?? new Set<string>();
      ids.add(leg.entryOrderId);
      if (leg.exitOrderId !== null && leg.exitOrderId !== "POSITION_ALREADY_FLAT") ids.add(leg.exitOrderId);
      orderIdsBySymbol.set(leg.symbol, ids);
    }
    for (const [symbol, ids] of orderIdsBySymbol) {
      try {
        const trades = await this.client.getUserTrades(symbol, { startTime: new Date(basket.openedAt).getTime(), limit: 1000 });
        for (const t of trades) {
          if (ids.has(t.orderId)) {
            realFees = (realFees ?? 0) + t.commission;
            sawAnyTrade = true;
          }
        }
      } catch {
        realFees = null;
        break;
      }
    }
    const fees = realFees !== null && sawAnyTrade ? realFees : notionalTouched * TAKER_FEE_RATE;
    basket.status = "CLOSED";
    basket.closedAt = this.nowIso();
    basket.closeReason = reason;
    basket.grossPnlUsd = gross;
    basket.feeEstimateUsd = fees;
    basket.netPnlUsd = gross - fees;
    // 2026-07-11: lastNetReturn/lastNetAt were previously only ever stamped by the periodic
    // mark-price check in closeBasketsHittingProfitTarget() — for a HORIZON (or any other) close,
    // that field was left frozen at whatever the last mark-price tick happened to show, which can
    // disagree in SIGN with the actual settled outcome once real exit fills come in (confirmed
    // live: basket xb-mras6v04 settled netPnlUsd +$0.73 but lastNetReturn was still stamped -0.13%
    // from a stale pre-close mark-price estimate). Recompute from the FINAL exit prices here so the
    // field always reflects the true settled outcome once a basket closes, using the same blend
    // methodology as the mark-price estimate (mean long % return / 2 + mean short % return / 2,
    // minus roundtrip cost) — just fed with real fills instead of a mid-flight mark.
    const finalLongLegs = basket.legs.filter((l) => l.side === "LONG");
    const finalShortLegs = basket.legs.filter((l) => l.side === "SHORT");
    const finalLegReturn = (l: ExecutorLeg, direction: "LONG" | "SHORT"): number => {
      const exit = l.exitPrice ?? l.entryPrice;
      return direction === "LONG" ? (exit - l.entryPrice) / l.entryPrice : (l.entryPrice - exit) / l.entryPrice;
    };
    const finalMeanLong = finalLongLegs.length
      ? finalLongLegs.reduce((sum, l) => sum + finalLegReturn(l, "LONG"), 0) / finalLongLegs.length
      : 0;
    const finalMeanShort = finalShortLegs.length
      ? finalShortLegs.reduce((sum, l) => sum + finalLegReturn(l, "SHORT"), 0) / finalShortLegs.length
      : 0;
    basket.lastNetReturn = finalMeanLong / 2 + finalMeanShort / 2 - CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;
    basket.lastNetAt = basket.closedAt;
    this.store.save();
  }

  private async maybeOpenBasket(): Promise<void> {
    const st = this.store.getState();
    // Basket safety breaker: halt NEW opens after a bad realized day; never touches open baskets.
    const lossLimit = this.dailyMaxLossUsdFn();
    if (lossLimit > 0) {
      const nowIso = this.nowIso();
      // 2026-07-12 fix: XSEC_DAILY_MAX_LOSS_USD is ONE shared ceiling across all 3 sibling
      // instances (FILTERED/TREND/MIXED, same netted account) — include their realized P&L too,
      // or the REAL combined daily loss could reach up to 3x this configured limit before any
      // single instance's own check ever halted.
      const dayRealized = this.dailyRealizedUsd(nowIso) + this.siblingDailyRealizedUsd(nowIso);
      if (dayRealized <= -lossLimit) {
        this.openHalted = `daily basket loss breaker: combined realized ${dayRealized.toFixed(2)} USDT ≤ -${lossLimit} — new opens halted until UTC midnight (open baskets keep their own exits)`;
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
    const notionalCap = this.maxNotionalPerSymbolAcrossLanesFn();
    const plannedLegs: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; refPrice: number }> = [];
    for (const [side, legs] of [["LONG", signal.longLeg], ["SHORT", signal.shortLeg]] as const) {
      for (const leg of legs) {
        const f = filters.get(leg.symbol);
        if (!f || !(leg.entryPrice > 0)) return; // missing filters/price ⇒ skip whole basket
        const rawQty = legUsd / leg.entryPrice;
        const qty = Math.floor(rawQty / f.stepSize) * f.stepSize;
        if (!(qty >= f.minQty)) return; // any un-sizeable leg ⇒ skip whole basket (hedge integrity)
        // 2026-07-19 real-money audit fix: this leg's notional, ADDED to whatever every OTHER
        // executor sharing this netted account (the 9 single-symbol lanes AND this instance's own
        // 2 cross-sectional siblings, PLUS this instance's own already-open legs on the symbol)
        // already holds on this exact symbol, must not exceed the shared per-symbol cap — see
        // live-executor-wiring.ts's computeNotionalPerSymbol doc comment for the original
        // single-symbol-only incident this closes. Same skip-WHOLE-basket-this-tick convention as
        // the filters/minQty checks above (this executor's hedge-integrity design constraint: never
        // open one side without the other — see the module doc comment at the top of this file).
        // TRANSIENT, not permanent: the watermark above only advances past THIS signal, so the next
        // fresh signal gets a clean re-evaluation once the colliding exposure frees up.
        if (
          notionalCap > 0 &&
          this.existingNotionalForSymbolFn(leg.symbol) + this.ownOpenNotionalForSymbol(leg.symbol) + qty * leg.entryPrice > notionalCap
        ) return;
        plannedLegs.push({ symbol: leg.symbol, side, qty: Number(qty.toFixed(8)), refPrice: leg.entryPrice });
      }
    }
    if (plannedLegs.length !== signal.longLeg.length + signal.shortLeg.length) return;

    const basket: ExecutorBasket = {
      // 2026-07-12 fix: derived only from the signal's timestamp, with no variant component — the
      // 3 CrossSectionalExecutor instances (FILTERED/TREND/MIXED) each have their OWN store file
      // but share ONE netted Binance account, and newClientOrderId is built from this id's LAST 12
      // chars. Two instances opening baskets whose signals share the same openedAtMs would collide
      // on newClientOrderId, and Binance's per-account idempotency would treat the second instance's
      // real order as a duplicate of the first's. The variant suffix is appended at the END (not
      // the middle) so it always survives basketId.slice(-12) regardless of the timestamp's length.
      basketId: `xb-${signal.openedAtMs.toString(36)}-${this.targetVariant.slice(0, 4).toLowerCase()}`,
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
        // 2026-07-19 real-money audit fix (BUG 3): a genuine partial MARKET fill (realistic on
        // thin-liquidity basket-universe symbols during volatility spikes — exactly what this
        // dispersion strategy targets) must not be silently recorded as if the full requested
        // quantity filled. Record the REAL executedQty so downstream P&L/exposure tracking
        // reflects what actually happened on the exchange, not what was requested.
        const filledQty =
          Number.isFinite(order.executedQty) && order.executedQty > 0 ? order.executedQty : planned.qty;
        basket.legs.push({
          symbol: planned.symbol,
          side: planned.side,
          qty: filledQty,
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
        } catch (flattenError) {
          // 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): this leg is now a
          // REAL, still-open exchange position (e.g. a sibling XSEC executor already holds the
          // opposite side on this symbol, or a transient exchange/network error) that this
          // basket's own bookkeeping can never reach again — it is recorded ABORTED with
          // exitOrderId still null, and nothing else in this file ever revisits an ABORTED
          // basket. Track it explicitly so retryOrphanedLegFlattens() (called every tick) keeps
          // trying to flatten it, and getStatus().orphanedLegs surfaces it prominently — it must
          // never again just silently fall out of this basket's bookkeeping.
          this.recordOrphanedLeg(basket, leg, flattenError);
        }
      }
      st.baskets.push(basket);
      this.store.save();
      throw error;
    }
  }

  /** See OrphanedLeg's doc comment. Pushes a NEW record — callers only ever invoke this once per
   *  leg (the abort-flatten catch fires at most once per leg; a partial-exit remainder is a fresh
   *  leg-like record every time), so no merge-with-existing lookup is needed. */
  private recordOrphanedLeg(basket: ExecutorBasket, leg: ExecutorLeg, error: unknown): void {
    const st = this.store.getState();
    if (!Array.isArray(st.orphanedLegs)) st.orphanedLegs = [];
    const now = this.nowIso();
    const message = (error as Error)?.message ?? "flatten failed";
    st.orphanedLegs.push({
      basketId: basket.basketId,
      symbol: leg.symbol,
      side: leg.side,
      qty: leg.qty,
      entryPrice: leg.entryPrice,
      entryOrderId: leg.entryOrderId,
      since: now,
      lastAttemptAt: now,
      lastError: message,
      attempts: 1,
    });
    this.store.save();
    console.error(
      `[cross-sectional-executor] ORPHANED LEG: ${leg.symbol} ${leg.side} qty=${leg.qty} from basket ` +
        `${basket.basketId} could NOT be flattened (${message}) — real, still-open exchange exposure. ` +
        `Tracked for automatic retry every tick; surfaced via getStatus().orphanedLegs.`,
    );
  }

  /**
   * 2026-07-19 real-money audit fix (BUG 1, HIGH — real-money risk): retries flattening every
   * tracked orphaned leg (see OrphanedLeg's doc comment) on every tick, for as long as it stays
   * unresolved. A plain reduceOnly MARKET close is attempted first (the safe default that can
   * never over-close); if the exchange rejects it with -2022 (this leg's side is no longer
   * covered by a same-signed position — e.g. a sibling XSEC executor's opposite exposure, or the
   * position was already closed by some other path), the real exchange position is queried and,
   * when it confirms the leg is genuinely already flat/opposite-signed, the record is resolved
   * WITHOUT creating new exposure — mirroring closeBasket's own -2022 reconciliation exactly.
   * Any other error (a transient exchange/network blip) just updates the record's lastError/
   * attempts and is retried again on the next tick.
   */
  private async retryOrphanedLegFlattens(): Promise<void> {
    const st = this.store.getState();
    const pending = st.orphanedLegs ?? [];
    if (pending.length === 0) return;
    for (const orphan of [...pending]) {
      try {
        const order = await this.client.placeOrder({
          symbol: orphan.symbol,
          side: orphan.side === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: orphan.qty,
          reduceOnly: true,
          newClientOrderId: `xsec-orph-${orphan.basketId.slice(-10)}-${orphan.symbol.slice(0, 6)}`,
        });
        const resolved = await this.resolveFillPrice(orphan.symbol, order.orderId, order.avgPrice, orphan.entryPrice);
        this.applyOrphanResolution(orphan, order.orderId, resolved.price, resolved.confirmed);
      } catch (error) {
        const message = (error as Error).message ?? "flatten retry failed";
        if (/(?:code\s*)?-2022|ReduceOnly Order is rejected/i.test(message)) {
          try {
            const positions = await this.client.getPositions(orphan.symbol);
            const positionAmt = positions.find((p) => p.symbol === orphan.symbol)?.positionAmt ?? 0;
            const expectedSign = orphan.side === "LONG" ? 1 : -1;
            if (Math.abs(positionAmt) <= 1e-9 || Math.sign(positionAmt) !== expectedSign) {
              // The exchange no longer carries this leg — resolve WITHOUT creating opposite
              // exposure, exactly closeBasket's own RECONCILED_POSITION_ALREADY_FLAT handling.
              this.applyOrphanResolution(orphan, "POSITION_ALREADY_FLAT", null, false);
              continue;
            }
          } catch {
            // position lookup failed too — fall through, keep retrying next tick
          }
        }
        const st2 = this.store.getState();
        const current = (st2.orphanedLegs ?? []).find((o) => o === orphan);
        if (current) {
          current.lastError = message;
          current.lastAttemptAt = this.nowIso();
          current.attempts += 1;
          this.store.save();
        }
      }
    }
  }

  /** Resolves (removes) an orphaned-leg record and, when the ORIGINAL basket/leg record can
   *  still be found, updates it with the real exit — so a basket's own legs array never
   *  disagrees with what actually happened on the exchange. `exitPrice`/`exitPriceConfirmed` are
   *  null/false for the POSITION_ALREADY_FLAT reconciliation path (no real fill occurred). */
  private applyOrphanResolution(
    orphan: OrphanedLeg,
    exitOrderId: string,
    exitPrice: number | null,
    exitPriceConfirmed: boolean,
  ): void {
    const st = this.store.getState();
    const basket = st.baskets.find((b) => b.basketId === orphan.basketId);
    const leg = basket?.legs.find((l) => l.symbol === orphan.symbol && l.side === orphan.side && l.exitOrderId === null);
    if (leg) {
      leg.exitOrderId = exitOrderId;
      leg.exitPrice = exitPrice;
      leg.exitPriceConfirmed = exitPriceConfirmed;
    }
    st.orphanedLegs = (st.orphanedLegs ?? []).filter((o) => o !== orphan);
    this.store.save();
  }
}

/**
 * LIQUIDATION-RECOIL EVENT lane (report-only MEASUREMENT lane).
 *
 * Thesis: liquidation cascades OVERSHOOT. Forced selling (long liquidations) drives price below
 * fair value; once the forced flow exhausts, price recoils. Mirrored for short-liquidation
 * squeezes. This lane detects a cascade-EXHAUSTION event and shadow-enters in the RECOIL direction
 * (against the cascade) with tight structural invalidation beyond the cascade extreme.
 *
 * WHAT THE "LIQUIDATION" SIGNAL ACTUALLY IS IN THIS REPO (blunt): there is NO real liquidation
 * feed anywhere in this codebase — no forceOrder stream, no liquidation prints. The closest honest
 * proxy is BinanceClient.getFuturesFlow's `openInterestChangePercent` (one 5-minute step of
 * /futures/data/openInterestHist) plus `takerBuySellRatio`: a sharp OI CONTRACTION means positions
 * are being force-closed, and the taker imbalance says WHICH side is being flushed (longs
 * liquidating = aggressive selling, ratio < 1; shorts squeezed = aggressive buying, ratio > 1).
 * Even the Tier-3 liquidation-recoil-cross-sectional.ts module has no better raw signal — its
 * "liquidation event" detector is PWR's candle-shape panic gate with the same crowding snapshot as
 * confirmation. So this lane's forced-flow evidence IS that proxy, made primary:
 *
 *   FLOW HISTORY (the part that makes this a liquidation lane, not a candle lane): the 5m OI delta
 *   is instantaneous — by the time a cascade has STALLED long enough to call exhaustion, the OI
 *   drop that defined it has usually already decayed back to ~0. One snapshot at detection time
 *   would therefore reject almost every genuine cascade. Instead the cycle samples getFuturesFlow
 *   (via derivatives-crowding.ts's fetchCrowdingSnapshot — reused, not refetched differently) for
 *   the whole universe every tick (~7 min) and persists a BOUNDED per-symbol history in the store.
 *   The event gate then asks: did ANY sample inside the cascade window show a ≥ LQR_MIN_OI_DROP_PCT
 *   OI contraction WITH taker aggression matching the cascade side? That remembered spike is the
 *   forced-flow fingerprint. Cadence caveat, measured not hidden: at one sample per ~7 min a
 *   sub-5-minute flush can fall between samples and be missed — this lane UNDER-detects; it never
 *   fabricates.
 *
 * DIFFERENTIATION from panic-washout-reclaim-edge.ts (PWR) and its cross-sectional extension
 * (liquidation-recoil-cross-sectional.ts): those are CANDLE-SHAPE detectors — a panic bar (range ≥
 * k×ATR + volume surge) plus an RSI washout, LONG-only, crowding as a secondary gate. This lane is
 * DRIVEN by the OI/taker forced-flow proxy (no RSI, no volume-vs-SMA shape, no reclaim-bar
 * requirement), is BIDIRECTIONAL (short-squeeze recoils are SHORT entries), and requires an
 * explicit exhaustion STALL before entering. Both lanes may fire on the same physical event —
 * that's fine; they are separate measurements of separate gates.
 *
 * DETECTOR (candles supply price geometry; flow supplies the liquidation evidence):
 *   cascade leg:  over the last LQR_CASCADE_WINDOW_BARS closed bars, the excursion from the
 *                 pre-window close to the window extreme (min low = DOWN cascade, max high = UP
 *                 cascade) must be ≥ LQR_CASCADE_ATR_MULT × the PRE-cascade ATR (ATR taken at the
 *                 bar before the window so the cascade cannot inflate its own yardstick — same
 *                 principle as btc-leadlag-snap-edge.ts's vol baseline).
 *   exhaustion:   the extreme must have STALLED: no new extreme for ≥ LQR_STALL_BARS closed bars
 *                 (no knife-catching — a cascade still printing new extremes never fires), and be
 *                 ≤ LQR_MAX_STALL_BARS old (a long-stalled extreme means the recoil already ran).
 *   ambiguity:    if BOTH sides qualify inside one window (V-shaped whipsaw) the symbol is skipped
 *                 — that is not a one-sided cascade.
 *   flow gate:    at least one persisted flow sample inside the cascade window with
 *                 oiChangePercent ≤ −LQR_MIN_OI_DROP_PCT AND taker ratio on the cascade side
 *                 (DOWN ⇒ < 1, UP ⇒ > 1). No sample with OI data ⇒ NO_FLOW_DATA skip (a
 *                 measurement lane must not guess).
 *
 * GEOMETRY (all entries against the cascade):
 *   entry  = last close (the stalled, post-cascade price).
 *   stop   = beyond the cascade extreme + LQR_STOP_BUFFER_FRAC × cascadeRange, distance floored at
 *            LQR_STOP_FLOOR_BPS so a microscopic range cannot create a degenerate R.
 *            R DENOMINATOR (house style) = this stop distance, frozen at entry.
 *   target = extreme + LQR_TARGET_RETRACE_FRAC × cascadeRange (fraction-of-cascade retrace,
 *            measured from the extreme). If price already recoiled past the target the entry is
 *            refused (ALREADY_RECOILED) — the move this lane trades is gone.
 *   hold   = short max-hold: LQR_MAX_HOLD_HOURS hours, mark-to-market at the last bar's close.
 *   resolve = first-touch forward candle walk strictly after entry, SL-first on an ambiguous
 *            same-candle touch, STOP HONESTY: a bar that OPENS through the stop books at its open
 *            (worse than −1R, never clamped). Stale-expiry fallback for symbols whose candles
 *            never arrive (residual-momentum-edge.ts's 2026-07-11 stuck-open fix precedent).
 *
 * Pure measurement: records and resolves shadow observations, exposes a report. NO orders, NO
 * execution-engine wiring, NOTHING trades until the book proves positive (house rule: every new
 * lane proves edge in shadow first). Independent module: own store, cycle, resolver, report.
 * edgeReady gate identical to every sibling: n≥30 && netAvgR≥0.05 && PF>1.1.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { computeATR } from "./candle-indicators.js";
import { fetchCrowdingSnapshot } from "./derivatives-crowding.js";
import type { BinanceClient } from "./binance.js";
import { REALISTIC_ROUND_TRIP_FEE_SLIP_BPS, REALISTIC_SLIPPAGE_BPS_PER_SIDE } from "./shadow-engine.js";

function envNumPos(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export const LQR_LANE_ID = "LIQUIDATION_RECOIL_EVENT" as const;

/** Fast interval — cascades are minutes-scale events. Same lookup convention as sibling lanes. */
export const LQR_INTERVAL = process.env.LIQ_RECOIL_INTERVAL || "5m";
const LQR_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
};
export const LQR_BAR_MS = LQR_INTERVAL_MS[LQR_INTERVAL] ?? LQR_INTERVAL_MS["5m"]!;

/** ATR period for the pre-cascade volatility yardstick. */
export const LQR_ATR_PERIOD = envNumPos("LIQ_RECOIL_ATR_PERIOD", 14);
/** Cascade search window (12 × 5m = 1h). */
export const LQR_CASCADE_WINDOW_BARS = envNumPos("LIQ_RECOIL_CASCADE_WINDOW_BARS", 12);
/** The cascade excursion must be ≥ this many PRE-cascade ATRs — a violent forced move, not drift. */
export const LQR_CASCADE_ATR_MULT = envNumPos("LIQ_RECOIL_CASCADE_ATR_MULT", 4);
/** Exhaustion stall: no new extreme for at least this many closed bars (3 × 5m = 15 min). */
export const LQR_STALL_BARS = envNumPos("LIQ_RECOIL_STALL_BARS", 3);
/** Freshness bound: an extreme older than this many bars means the recoil window has passed. */
export const LQR_MAX_STALL_BARS = envNumPos("LIQ_RECOIL_MAX_STALL_BARS", 8);
/** Forced-flow gate: some in-window 5m OI step must have contracted at least this many percent. */
export const LQR_MIN_OI_DROP_PCT = envNumPos("LIQ_RECOIL_MIN_OI_DROP_PCT", 1);
/** Stop buffer beyond the cascade extreme, as a fraction of the cascade range. */
export const LQR_STOP_BUFFER_FRAC = envNumPos("LIQ_RECOIL_STOP_BUFFER_FRAC", 0.15);
/** Stop-distance floor so a microscopic cascade range cannot create a degenerate R. */
export const LQR_STOP_FLOOR_BPS = envNumPos("LIQ_RECOIL_STOP_FLOOR_BPS", 40);
/** Bounce target: this fraction of the cascade range retraced, measured from the extreme. */
export const LQR_TARGET_RETRACE_FRAC = envNumPos("LIQ_RECOIL_TARGET_RETRACE_FRAC", 0.5);
/** Short max-hold, in HOURS (mark-to-market at expiry) — recoils either happen fast or don't. */
export const LQR_MAX_HOLD_HOURS = envNumPos("LIQ_RECOIL_MAX_HOLD_HOURS", 6);
export const LQR_MAX_HOLD_BARS = Math.max(1, Math.round((LQR_MAX_HOLD_HOURS * 3_600_000) / LQR_BAR_MS));
/** Bound on the concurrent OPEN shadow book. */
export const LQR_MAX_OPEN = envNumPos("LIQ_RECOIL_MAX_OPEN", 8);
/** Bounded retention: settled (non-OPEN) observations kept, oldest pruned first. */
export const LQR_MAX_STORED_OBSERVATIONS = envNumPos("LIQ_RECOIL_MAX_STORED_OBSERVATIONS", 500);
/** Bounded per-symbol flow-sample history (~5.5h at the ~7min ticker cadence). */
export const LQR_FLOW_MAX_SAMPLES_PER_SYMBOL = envNumPos("LIQ_RECOIL_FLOW_MAX_SAMPLES", 48);
/** Flow samples older than this (relative to the newest sample) are pruned on save. */
export const LQR_FLOW_MAX_AGE_MS = envNumPos("LIQ_RECOIL_FLOW_MAX_AGE_MS", 6 * 3_600_000);
/** Candle depth: ATR + cascade window + max-hold resolution walk, with headroom. */
export const LQR_CANDLE_FETCH_LIMIT = Math.max(120, LQR_ATR_PERIOD + LQR_CASCADE_WINDOW_BARS + LQR_MAX_HOLD_BARS + 10);

/** Deliberately SMALL default universe (liquid majors where cascades are tradeable): the flow
 *  history requires one getFuturesFlow (4 HTTP calls) per symbol EVERY cycle, unconditionally —
 *  unlike candle-only lanes there is no "only fetch on signal" shortcut, because the history must
 *  exist BEFORE the event is detectable. 8 symbols ≈ 32 calls/~7min, the same order as existing
 *  per-cycle lanes. Env-overridable. */
export const LQR_UNIVERSE: readonly string[] = (
  process.env.LIQ_RECOIL_UNIVERSE ??
  "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,LINKUSDT,SUIUSDT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ── cascade detection (pure, candle leg) ────────────────────────────────────

export type CascadeDirection = "DOWN" | "UP";

export interface LiquidationCascadeEvent {
  /** Direction of the FORCED move (DOWN = long liquidations, UP = short squeeze). */
  cascadeDirection: CascadeDirection;
  /** Direction this lane ENTERS — always against the cascade. */
  recoilDirection: "LONG" | "SHORT";
  /** openTime of the first bar inside the cascade window. */
  windowStartMs: number;
  /** Close of the bar immediately BEFORE the window — the pre-cascade reference price. */
  preCascadeClose: number;
  /** min low (DOWN) / max high (UP) inside the window. */
  extremePrice: number;
  /** openTime of the (last) bar that printed the extreme — the event identity key. */
  extremeBarOpenTime: number;
  /** |preCascadeClose − extremePrice| in price units. */
  cascadeRange: number;
  /** Signed (extremePrice − preCascadeClose) / preCascadeClose. */
  cascadeReturn: number;
  /** cascadeRange / pre-cascade ATR — how violent the leg was vs normal volatility. */
  atrMultiple: number;
  /** Closed bars since the extreme (≥ LQR_STALL_BARS by construction — the exhaustion stall). */
  stallBars: number;
  lastClose: number;
  lastBarOpenTime: number;
}

export interface LiquidationCascadeDetection {
  /** false = not enough candle history to even look (an honest "couldn't assess", not "no event"). */
  evaluated: boolean;
  /** true when BOTH sides qualified in the same window — a V-shaped whipsaw, skipped. */
  ambiguous: boolean;
  event: LiquidationCascadeEvent | null;
}

function sortedValidCandles(candles: readonly Candle[]): Candle[] {
  return [...candles]
    .filter((c) => finite(c.close) && c.close > 0 && finite(c.low) && finite(c.high) && finite(c.openTime))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Detect a stalled (exhausted) liquidation-cascade LEG from closed candles. Candles supply ONLY the
 * price geometry (leg magnitude, extreme, stall) — the forced-flow evidence is gated separately via
 * evaluateLiquidationFlowGate (see module header). The last candle in the input must be the most
 * recently CLOSED bar (same contract as every sibling detector).
 *
 * A side qualifies when:  excursion ≥ cascadeAtrMult × preATR,  AND the extreme has stalled for
 * stallBars ≤ age ≤ maxStallBars closed bars (extreme age uses the LAST bar that printed the
 * extreme, so an equal re-test resets the stall clock — "no new extreme" is literal).
 */
export function detectLiquidationCascade(
  candles: readonly Candle[],
  opts: {
    cascadeWindowBars?: number;
    atrPeriod?: number;
    cascadeAtrMult?: number;
    stallBars?: number;
    maxStallBars?: number;
  } = {},
): LiquidationCascadeDetection {
  const windowBars = opts.cascadeWindowBars ?? LQR_CASCADE_WINDOW_BARS;
  const atrPeriod = opts.atrPeriod ?? LQR_ATR_PERIOD;
  const cascadeAtrMult = opts.cascadeAtrMult ?? LQR_CASCADE_ATR_MULT;
  const stallBars = opts.stallBars ?? LQR_STALL_BARS;
  const maxStallBars = opts.maxStallBars ?? LQR_MAX_STALL_BARS;

  const sorted = sortedValidCandles(candles);
  const n = sorted.length;
  // Need: ATR warm-up strictly before the window (ATR first valid at index = atrPeriod) + the
  // window itself + the pre-window reference bar.
  if (n < windowBars + atrPeriod + 2) return { evaluated: false, ambiguous: false, event: null };

  const lastIdx = n - 1;
  const windowStartIdx = n - windowBars;
  const preIdx = windowStartIdx - 1;
  const atr = computeATR(sorted, atrPeriod);
  const preAtr = atr[preIdx];
  const preClose = sorted[preIdx]!.close;
  if (!finite(preAtr) || !(preAtr > 0) || !(preClose > 0)) return { evaluated: false, ambiguous: false, event: null };

  // DOWN side: min low in the window; extreme age counted from the LAST bar attaining it.
  let minLow = Infinity;
  let minLowIdx = -1;
  let maxHigh = -Infinity;
  let maxHighIdx = -1;
  for (let i = windowStartIdx; i <= lastIdx; i++) {
    const c = sorted[i]!;
    if (c.low <= minLow) {
      minLow = c.low;
      minLowIdx = i;
    }
    if (c.high >= maxHigh) {
      maxHigh = c.high;
      maxHighIdx = i;
    }
  }

  const downRange = preClose - minLow;
  const downStall = lastIdx - minLowIdx;
  const downQualifies =
    downRange > 0 && downRange / preAtr >= cascadeAtrMult && downStall >= stallBars && downStall <= maxStallBars;

  const upRange = maxHigh - preClose;
  const upStall = lastIdx - maxHighIdx;
  const upQualifies =
    upRange > 0 && upRange / preAtr >= cascadeAtrMult && upStall >= stallBars && upStall <= maxStallBars;

  if (downQualifies && upQualifies) return { evaluated: true, ambiguous: true, event: null };
  if (!downQualifies && !upQualifies) return { evaluated: true, ambiguous: false, event: null };

  const lastCandle = sorted[lastIdx]!;
  const base = {
    preCascadeClose: preClose,
    lastClose: lastCandle.close,
    lastBarOpenTime: lastCandle.openTime,
  };
  // Anchor the flow-evidence window to the EXTREME bar's own position, not to "now minus
  // windowBars": the same stalled cascade is re-scanned every cycle while it waits out its stall,
  // and lastIdx (the current last-closed bar) advances each time even though extremeBarOpenTime
  // does not. Anchoring to "now" would slide windowStartMs forward every cycle and progressively
  // cut the earlier OI/taker-flow evidence out of evaluateLiquidationFlowGate's search window —
  // exactly the evidence a forced-liquidation flush prints right around the extreme.
  const anchoredWindowStartMs = (extremeIdx: number): number => sorted[Math.max(0, extremeIdx - windowBars + 1)]!.openTime;
  const event: LiquidationCascadeEvent = downQualifies
    ? {
        ...base,
        windowStartMs: anchoredWindowStartMs(minLowIdx),
        cascadeDirection: "DOWN",
        recoilDirection: "LONG",
        extremePrice: minLow,
        extremeBarOpenTime: sorted[minLowIdx]!.openTime,
        cascadeRange: downRange,
        cascadeReturn: (minLow - preClose) / preClose,
        atrMultiple: downRange / preAtr,
        stallBars: downStall,
      }
    : {
        ...base,
        windowStartMs: anchoredWindowStartMs(maxHighIdx),
        cascadeDirection: "UP",
        recoilDirection: "SHORT",
        extremePrice: maxHigh,
        extremeBarOpenTime: sorted[maxHighIdx]!.openTime,
        cascadeRange: upRange,
        cascadeReturn: (maxHigh - preClose) / preClose,
        atrMultiple: upRange / preAtr,
        stallBars: upStall,
      };
  return { evaluated: true, ambiguous: false, event };
}

// ── forced-flow gate (pure, OI/taker leg — the liquidation evidence) ─────────

export interface LqrFlowSample {
  atMs: number;
  /** One 5m OI step, percent (getFuturesFlow.openInterestChangePercent). Negative = contraction. */
  oiChangePercent: number | null;
  /** Taker buy/sell volume ratio (<1 = aggressive selling dominates). */
  takerBuySellRatio: number | null;
  fundingBps: number | null;
}

export interface LqrFlowGateResult {
  samplesInWindow: number;
  /** At least one in-window sample carried finite OI data (without it, the gate must abstain). */
  hasOiData: boolean;
  /** Forced-flow fingerprint found: OI contraction ≥ threshold WITH cascade-side taker aggression. */
  passes: boolean;
  /** Most negative in-window OI step (the flush magnitude), null when no OI data. */
  worstOiChangePercent: number | null;
  /** Taker ratio observed on that worst-OI sample (the flush's aggression side). */
  takerRatioAtWorst: number | null;
}

/**
 * The liquidation-evidence gate: inside [windowStartMs, nowMs], did any persisted flow sample show
 * a ≥ minOiDropPct OI contraction with taker aggression on the CASCADE side (DOWN cascade = longs
 * force-sold ⇒ ratio < 1; UP cascade = shorts force-bought ⇒ ratio > 1)? Pure function over the
 * store's sample history; missing data abstains (hasOiData=false), it never passes by default.
 */
export function evaluateLiquidationFlowGate(
  samples: readonly LqrFlowSample[],
  windowStartMs: number,
  nowMs: number,
  cascadeDirection: CascadeDirection,
  opts: { minOiDropPct?: number } = {},
): LqrFlowGateResult {
  const minOiDropPct = opts.minOiDropPct ?? LQR_MIN_OI_DROP_PCT;
  const inWindow = samples.filter((s) => finite(s.atMs) && s.atMs >= windowStartMs && s.atMs <= nowMs);
  const withOi = inWindow.filter((s) => finite(s.oiChangePercent));
  let worst: LqrFlowSample | null = null;
  for (const s of withOi) {
    if (worst === null || (s.oiChangePercent as number) < (worst.oiChangePercent as number)) worst = s;
  }
  const passes = inWindow.some((s) => {
    if (!finite(s.oiChangePercent) || s.oiChangePercent > -minOiDropPct) return false;
    if (!finite(s.takerBuySellRatio)) return false;
    return cascadeDirection === "DOWN" ? s.takerBuySellRatio < 1 : s.takerBuySellRatio > 1;
  });
  return {
    samplesInWindow: inWindow.length,
    hasOiData: withOi.length > 0,
    passes,
    worstOiChangePercent: worst ? (worst.oiChangePercent as number) : null,
    takerRatioAtWorst: worst && finite(worst.takerBuySellRatio) ? worst.takerBuySellRatio : null,
  };
}

// ── geometry (pure) ─────────────────────────────────────────────────────────

export interface LqrGeometry {
  entryPrice: number;
  /** Structural invalidation beyond the cascade extreme (+ buffer), floored at LQR_STOP_FLOOR_BPS. */
  initialStop: number;
  /** Fraction-of-cascade retrace target, measured from the extreme. */
  targetPrice: number;
  /** R DENOMINATOR (house style): the stop distance, frozen at entry. */
  stopDistanceBps: number;
  targetDistanceBps: number;
}

export type LqrGeometryOutcome =
  | { ok: true; geometry: LqrGeometry }
  | { ok: false; reason: "ALREADY_RECOILED" | "INVALID" };

/**
 * Build the recoil entry geometry. LONG (after a DOWN cascade): stop below the cascade low by
 * bufferFrac × range (distance floored at stopFloorBps of entry), target = low + retraceFrac ×
 * range. SHORT mirrored above the cascade high. Entry must still be on the profitable side of the
 * target — if the recoil already retraced past it, the trade this lane measures no longer exists
 * (ALREADY_RECOILED), which is a gate, not an error.
 */
export function buildLiqRecoilGeometry(
  entryPrice: number,
  recoilDirection: "LONG" | "SHORT",
  extremePrice: number,
  cascadeRange: number,
  opts: { stopBufferFrac?: number; stopFloorBps?: number; targetRetraceFrac?: number } = {},
): LqrGeometryOutcome {
  const stopBufferFrac = opts.stopBufferFrac ?? LQR_STOP_BUFFER_FRAC;
  const stopFloorBps = opts.stopFloorBps ?? LQR_STOP_FLOOR_BPS;
  const targetRetraceFrac = opts.targetRetraceFrac ?? LQR_TARGET_RETRACE_FRAC;
  if (!(entryPrice > 0) || !(extremePrice > 0) || !(cascadeRange > 0)) return { ok: false, reason: "INVALID" };

  const buffer = stopBufferFrac * cascadeRange;
  const floorDistance = (stopFloorBps / 10_000) * entryPrice;
  let initialStop: number;
  let targetPrice: number;
  if (recoilDirection === "LONG") {
    initialStop = Math.min(extremePrice - buffer, entryPrice - floorDistance);
    targetPrice = extremePrice + targetRetraceFrac * cascadeRange;
    if (targetPrice <= entryPrice) return { ok: false, reason: "ALREADY_RECOILED" };
  } else {
    initialStop = Math.max(extremePrice + buffer, entryPrice + floorDistance);
    targetPrice = extremePrice - targetRetraceFrac * cascadeRange;
    if (targetPrice >= entryPrice) return { ok: false, reason: "ALREADY_RECOILED" };
  }
  if (!(initialStop > 0) || !(targetPrice > 0)) return { ok: false, reason: "INVALID" };
  const risk = Math.abs(entryPrice - initialStop);
  if (!(risk > 0)) return { ok: false, reason: "INVALID" };
  return {
    ok: true,
    geometry: {
      entryPrice,
      initialStop,
      targetPrice,
      stopDistanceBps: (risk / entryPrice) * 10_000,
      targetDistanceBps: (Math.abs(targetPrice - entryPrice) / entryPrice) * 10_000,
    },
  };
}

// ── observation + resolution (pure) ─────────────────────────────────────────

export interface LiqRecoilObservation extends LqrGeometry {
  observationId: string;
  symbol: string;
  /** Entry direction — the RECOIL side, against the cascade. */
  direction: "LONG" | "SHORT";
  cascadeDirection: CascadeDirection;
  openedAt: string;
  openedAtMs: number;
  cascadeReturn: number;
  atrMultipleAtEntry: number;
  stallBarsAtEntry: number;
  extremePrice: number;
  extremeBarOpenTime: number;
  preCascadeClose: number;
  /** Forced-flow evidence at entry (from the persisted flow history — see module header). */
  worstOiChangePercent: number | null;
  takerRatioAtWorst: number | null;
  fundingBpsAtEntry: number | null;
  flowSamplesInWindow: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: "RECOIL_TARGET" | "CASCADE_STOP" | "MAX_HOLD_MTM" | null;
  resolvedAt: string | null;
}

/** Realistic cost model reused verbatim from shadow-engine.ts's shared constants (same convention
 *  as btc-leadlag-snap-edge.ts / residual-momentum-edge.ts): one round trip's fee+slippage in bps
 *  of notional, converted to R via the stop distance, plus extra adverse fill on a loss. */
function netOf(grossR: number, stopDistanceBps: number, isLoss: boolean): { costR: number; netR: number } {
  const costR =
    REALISTIC_ROUND_TRIP_FEE_SLIP_BPS / stopDistanceBps + (isLoss ? REALISTIC_SLIPPAGE_BPS_PER_SIDE / stopDistanceBps : 0);
  return { costR, netR: grossR - costR };
}

/**
 * Resolve an OPEN observation against forward candles strictly AFTER openedAtMs, ascending, first
 * touch wins, SL-first on an ambiguous same-candle touch (conservative sibling convention). Once an
 * exit is decided no later candle can change it (exactly-once: callers only patch OPEN rows, and a
 * closing patch flips status). STOP HONESTY: a bar that OPENS beyond the stop books at its open —
 * grossR comes out WORSE than −1R, never clamped. Max-hold marks to market at the close of the
 * LQR_MAX_HOLD_BARS-th forward bar. Stale-expiry fallback when no forward candles ever arrive and
 * the observation is long past its hold window.
 */
export function resolveLiqRecoilObservation(
  obs: LiqRecoilObservation,
  forwardCandles: readonly Candle[],
  nowMs: number,
  opts: { maxHoldBars?: number } = {},
): Partial<LiqRecoilObservation> | null {
  const maxHoldBars = opts.maxHoldBars ?? LQR_MAX_HOLD_BARS;
  const fwd = sortedValidCandles(forwardCandles).filter((c) => c.openTime > obs.openedAtMs);
  const risk = Math.abs(obs.entryPrice - obs.initialStop);
  if (!(risk > 0)) return null;
  const isLong = obs.direction === "LONG";

  const finalize = (
    grossR: number,
    atMs: number,
    exitReason: NonNullable<LiqRecoilObservation["exitReason"]>,
  ): Partial<LiqRecoilObservation> => {
    const { costR, netR } = netOf(grossR, obs.stopDistanceBps, grossR < 0);
    return {
      status: grossR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR,
      costR,
      netR,
      exitReason,
      resolvedAt: new Date(atMs).toISOString(),
    };
  };

  for (let i = 0; i < fwd.length; i++) {
    const c = fwd[i]!;
    const slHit = isLong ? c.low <= obs.initialStop : c.high >= obs.initialStop;
    const tpHit = isLong ? c.high >= obs.targetPrice : c.low <= obs.targetPrice;
    if (slHit) {
      // Honest stop fill: a bar that OPENED through the stop fills at its open (worse than −1R).
      const fill = isLong ? Math.min(c.open, obs.initialStop) : Math.max(c.open, obs.initialStop);
      const grossR = isLong ? (fill - obs.entryPrice) / risk : (obs.entryPrice - fill) / risk;
      return finalize(grossR, c.openTime, "CASCADE_STOP");
    }
    if (tpHit) {
      const grossR = isLong ? (obs.targetPrice - obs.entryPrice) / risk : (obs.entryPrice - obs.targetPrice) / risk;
      return finalize(grossR, c.openTime, "RECOIL_TARGET");
    }
    if (i + 1 >= maxHoldBars) {
      const grossR = isLong ? (c.close - obs.entryPrice) / risk : (obs.entryPrice - c.close) / risk;
      return finalize(grossR, c.openTime, "MAX_HOLD_MTM");
    }
  }
  if (fwd.length === 0 && nowMs - obs.openedAtMs > maxHoldBars * LQR_BAR_MS * 3) {
    return { status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
  }
  return null; // still open
}

// ── store ───────────────────────────────────────────────────────────────────

export interface LqrCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  flowSamplesRecordedTotal: number;
  /** Raw stalled-cascade detections. The SAME physical cascade re-detected on consecutive ~7min
   *  cycles recounts here — this is liveness accounting, not statistics; entries themselves are
   *  exactly-once via the (symbol, side, extreme-bar) observation id. */
  eventsDetectedTotal: number;
  ambiguousTotal: number;
  skippedNoFlowDataTotal: number;
  skippedFlowGateTotal: number;
  skippedAlreadyRecoiledTotal: number;
  enteredTotal: number;
  lastEventAt: string | null;
  lastEventSymbol: string | null;
  lastEventCascadeDirection: CascadeDirection | null;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: LqrCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  flowSamplesRecordedTotal: 0,
  eventsDetectedTotal: 0,
  ambiguousTotal: 0,
  skippedNoFlowDataTotal: 0,
  skippedFlowGateTotal: 0,
  skippedAlreadyRecoiledTotal: 0,
  enteredTotal: 0,
  lastEventAt: null,
  lastEventSymbol: null,
  lastEventCascadeDirection: null,
  lastCycleError: null,
};

interface LqrState {
  version: number;
  observations: LiqRecoilObservation[];
  cycleMeta?: LqrCycleMeta;
  /** Persisted per-symbol flow history — REQUIRED, not a cache: the forced-flow spike decays before
   *  the stall confirms, so the gate must be able to look back (see module header). Bounded. */
  flowHistory?: Record<string, LqrFlowSample[]>;
}

export class LiqRecoilStore {
  private state: LqrState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META }, flowHistory: {} };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<LqrState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as LiqRecoilObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
        if (parsed.flowHistory && typeof parsed.flowHistory === "object") {
          this.state.flowHistory = parsed.flowHistory as Record<string, LqrFlowSample[]>;
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): LiqRecoilObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): LqrCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  flowSamples(symbol: string): LqrFlowSample[] {
    return this.state.flowHistory?.[symbol] ?? [];
  }
  recordFlowSample(symbol: string, sample: LqrFlowSample): void {
    const history = this.state.flowHistory ?? {};
    const list = history[symbol] ?? [];
    list.push(sample);
    // Bound immediately (not only on save) so a hot loop can never balloon memory.
    history[symbol] = list.length > LQR_FLOW_MAX_SAMPLES_PER_SYMBOL ? list.slice(list.length - LQR_FLOW_MAX_SAMPLES_PER_SYMBOL) : list;
    this.state.flowHistory = history;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: LiqRecoilObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<LiqRecoilObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  recordCycle(atIso: string, result: LqrCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.flowSamplesRecordedTotal += result.flowSampled;
      meta.eventsDetectedTotal += result.eventsDetected;
      meta.ambiguousTotal += result.ambiguous;
      meta.skippedNoFlowDataTotal += result.skippedNoFlowData;
      meta.skippedFlowGateTotal += result.skippedFlowGate;
      meta.skippedAlreadyRecoiledTotal += result.skippedAlreadyRecoiled;
      meta.enteredTotal += result.entered;
      if (result.eventsDetected > 0) {
        meta.lastEventAt = atIso;
        meta.lastEventSymbol = result.lastEventSymbol;
        meta.lastEventCascadeDirection = result.lastEventCascadeDirection;
      }
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  /** Bounded retention: every OPEN observation is kept (must stay resolvable), plus at most
   *  LQR_MAX_STORED_OBSERVATIONS settled ones — oldest settled dropped first (repo convention).
   *  Flow history: per-symbol sample cap plus age-based pruning relative to the newest sample
   *  anywhere (deterministic — no wall clock in the store), and symbols whose entire history has
   *  aged out are dropped so a shrinking universe cannot leak old symbol keys forever. */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > LQR_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - LQR_MAX_STORED_OBSERVATIONS) : settled;
    this.state.observations = [...open, ...keepSettled];

    const history = this.state.flowHistory ?? {};
    let newest = 0;
    for (const list of Object.values(history)) {
      for (const s of list) if (finite(s.atMs) && s.atMs > newest) newest = s.atMs;
    }
    const cutoff = newest - LQR_FLOW_MAX_AGE_MS;
    const prunedHistory: Record<string, LqrFlowSample[]> = {};
    for (const [symbol, list] of Object.entries(history)) {
      const kept = list.filter((s) => finite(s.atMs) && s.atMs >= cutoff).slice(-LQR_FLOW_MAX_SAMPLES_PER_SYMBOL);
      if (kept.length > 0) prunedHistory[symbol] = kept;
    }
    this.state.flowHistory = prunedHistory;
  }
  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file); // atomic on POSIX — no torn reads
  }
}

let singleton: LiqRecoilStore | null = null;
export function getLiqRecoilStore(dataDir = "data"): LiqRecoilStore {
  if (!singleton) singleton = new LiqRecoilStore(resolve(dataDir, "liq-recoil-edge.json"));
  return singleton;
}
export function _resetLiqRecoilStoreForTests(): void {
  singleton = null;
}

// ── cycle ───────────────────────────────────────────────────────────────────

export interface LqrCycleResult {
  scanned: number;
  /** Flow samples persisted this cycle (fetch failures record nothing — the gate must stay honest). */
  flowSampled: number;
  skippedNoCandles: number;
  eventsDetected: number;
  ambiguous: number;
  skippedDuplicate: number;
  skippedNoFlowData: number;
  skippedFlowGate: number;
  skippedAlreadyRecoiled: number;
  skippedOpenCap: number;
  entered: number;
  resolved: number;
  expired: number;
  lastEventSymbol: string | null;
  lastEventCascadeDirection: CascadeDirection | null;
}

/**
 * One measurement cycle:
 *   1. sample getFuturesFlow (via fetchCrowdingSnapshot — reuse, not a new fetch shape) for every
 *      universe symbol and persist into the bounded flow history (the liquidation evidence must
 *      accrue BEFORE an event is detectable — see module header);
 *   2. fetch candles for the universe plus any symbol with an OPEN observation (a universe shrink
 *      must never strand an open row unresolvable);
 *   3. resolve OPEN observations first (failed fetches pass [] so the stale-expiry fallback still
 *      runs — the residual-momentum stuck-open fix precedent);
 *   4. detect stalled cascades per symbol; gate on the persisted forced-flow evidence; open shadow
 *      entries AGAINST the cascade (exactly-once per symbol+side+extreme-bar via the observation
 *      id; one OPEN per symbol+direction; open book capped).
 * Every cycle records liveness meta — an empty book is distinguishable from a dead cycle.
 */
export async function runLiqRecoilCycle(opts: {
  store: LiqRecoilStore;
  universe?: readonly string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  crowdingClient: Pick<BinanceClient, "getFuturesFlow">;
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
  const nowIso = new Date(opts.now).toISOString();

  // 1. flow sampling — every universe symbol, every cycle. fetchCrowdingSnapshot never throws (its
  //    internal catch degrades to nulls); an all-null snapshot records NOTHING so a fetch outage
  //    can never masquerade as "OI was flat".
  for (const symbol of universe) {
    const snap = await fetchCrowdingSnapshot(opts.crowdingClient, symbol, nowIso);
    if (finite(snap.oiChangePercent) || finite(snap.takerBuySellRatio) || finite(snap.fundingBps)) {
      opts.store.recordFlowSample(symbol, {
        atMs: opts.now,
        oiChangePercent: finite(snap.oiChangePercent) ? snap.oiChangePercent : null,
        takerBuySellRatio: finite(snap.takerBuySellRatio) ? snap.takerBuySellRatio : null,
        fundingBps: finite(snap.fundingBps) ? snap.fundingBps : null,
      });
      result.flowSampled += 1;
    }
  }

  // 2. candle fetch: universe + open-observation symbols.
  const toFetch = new Set<string>([...universe, ...opts.store.all.filter((o) => o.status === "OPEN").map((o) => o.symbol)]);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of toFetch) {
    try {
      candlesBySymbol.set(symbol, await opts.fetchCandles(symbol));
    } catch {
      /* leave unset → resolution passes [] (stale-expiry fallback), detection counts skippedNoCandles */
    }
  }

  // 3. resolve OPEN observations first (exactly-once: only OPEN rows are ever patched).
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const patch = resolveLiqRecoilObservation(obs, candlesBySymbol.get(obs.symbol) ?? [], opts.now);
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else result.resolved += 1;
    }
  }

  // 4. detect → gate → enter.
  let openCount = opts.store.all.filter((o) => o.status === "OPEN").length;
  for (const symbol of universe) {
    result.scanned += 1;
    const candles = candlesBySymbol.get(symbol);
    if (!candles) {
      result.skippedNoCandles += 1;
      continue;
    }
    const detection = detectLiquidationCascade(candles);
    if (!detection.evaluated) {
      // Not enough history to even look — counted with the missing-candle skips (documented).
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

    // Exactly-once per physical cascade: identity = symbol + recoil side + the extreme bar. The
    // same stalled cascade seen again next cycle (stall grows 4, 5, … bars, same extreme bar)
    // maps to the same id and is skipped. One OPEN per symbol+direction on top.
    const observationId = `lqr:${event.recoilDirection.toLowerCase()}:${symbol}:${event.extremeBarOpenTime}`;
    const hasOpenSameSide = opts.store.all.some(
      (o) => o.symbol === symbol && o.direction === event.recoilDirection && o.status === "OPEN",
    );
    if (opts.store.has(observationId) || hasOpenSameSide) {
      result.skippedDuplicate += 1;
      continue;
    }

    const gate = evaluateLiquidationFlowGate(opts.store.flowSamples(symbol), event.windowStartMs, opts.now, event.cascadeDirection);
    if (!gate.hasOiData) {
      result.skippedNoFlowData += 1;
      continue;
    }
    if (!gate.passes) {
      result.skippedFlowGate += 1;
      continue;
    }

    if (openCount >= LQR_MAX_OPEN) {
      result.skippedOpenCap += 1;
      continue;
    }

    const outcome = buildLiqRecoilGeometry(event.lastClose, event.recoilDirection, event.extremePrice, event.cascadeRange);
    if (!outcome.ok) {
      if (outcome.reason === "ALREADY_RECOILED") result.skippedAlreadyRecoiled += 1;
      continue;
    }

    const fundingSamples = opts.store.flowSamples(symbol).filter((s) => finite(s.fundingBps));
    const added = opts.store.add({
      ...outcome.geometry,
      observationId,
      symbol,
      direction: event.recoilDirection,
      cascadeDirection: event.cascadeDirection,
      openedAt: nowIso,
      openedAtMs: opts.now,
      cascadeReturn: event.cascadeReturn,
      atrMultipleAtEntry: event.atrMultiple,
      stallBarsAtEntry: event.stallBars,
      extremePrice: event.extremePrice,
      extremeBarOpenTime: event.extremeBarOpenTime,
      preCascadeClose: event.preCascadeClose,
      worstOiChangePercent: gate.worstOiChangePercent,
      takerRatioAtWorst: gate.takerRatioAtWorst,
      fundingBpsAtEntry: fundingSamples.length ? fundingSamples[fundingSamples.length - 1]!.fundingBps : null,
      flowSamplesInWindow: gate.samplesInWindow,
      status: "OPEN",
      grossR: null,
      costR: null,
      netR: null,
      exitReason: null,
      resolvedAt: null,
    });
    if (added) {
      result.entered += 1;
      openCount += 1;
    }
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

/** 2026-07-21 review fix: single-flight — slow flow fetches can stretch a cycle past the 7-min
 *  ticker period; two interleaved cycles could double-enter the same cascade. Same guard idiom as
 *  runExitBrainShadowCycleGuarded. */
let lqrCycleInFlight = false;
export async function runLiqRecoilCycleGuarded(
  opts: Parameters<typeof runLiqRecoilCycle>[0],
): Promise<LqrCycleResult | null> {
  if (lqrCycleInFlight) return null;
  lqrCycleInFlight = true;
  try {
    return await runLiqRecoilCycle(opts);
  } catch (error) {
    // Record the failure so the report shows "cycle ran and ERRORED" instead of silently looking
    // identical to "no cascade yet" — best-effort, never rethrows.
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    lqrCycleInFlight = false;
  }
}

// ── report ──────────────────────────────────────────────────────────────────

export interface LiqRecoilReport {
  laneId: string;
  interval: string;
  universe: readonly string[];
  /** Honest signal provenance — surfaced on the report so nobody mistakes this for a real feed. */
  signalSource: "OI_TAKER_FLOW_PROXY";
  params: {
    cascadeWindowBars: number;
    cascadeAtrMult: number;
    stallBars: number;
    maxStallBars: number;
    minOiDropPct: number;
    stopBufferFrac: number;
    stopFloorBps: number;
    targetRetraceFrac: number;
    maxHoldHours: number;
    maxOpen: number;
  };
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  targetShare: number | null;
  stopShare: number | null;
  edgeReady: boolean;
  byDirection: Array<{ direction: "LONG" | "SHORT"; resolvedCount: number; netAvgR: number | null; wr: number | null }>;
  avgAtrMultipleAtEntry: number | null;
  avgStallBarsAtEntry: number | null;
  avgWorstOiChangePercentAtEntry: number | null;
  topRecent: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    cascadeDirection: CascadeDirection;
    netR: number | null;
    status: string;
    exitReason: string | null;
    openedAt: string;
    atrMultipleAtEntry: number;
    stallBarsAtEntry: number;
    worstOiChangePercent: number | null;
    takerRatioAtWorst: number | null;
  }>;
  cycleMeta: LqrCycleMeta | null;
}

export function buildLiqRecoilReport(
  observations: readonly LiqRecoilObservation[],
  cycleMeta?: LqrCycleMeta,
): LiqRecoilReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter((o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR));
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const targets = resolved.filter((o) => o.exitReason === "RECOIL_TARGET").length;
  const stops = resolved.filter((o) => o.exitReason === "CASCADE_STOP").length;
  const netAvgR = nets.length ? mean(nets) : null;
  // Same edgeReady gate as every sibling measurement lane: n>=30, net-of-cost avg R >= 0.05, and a
  // real payoff (PF > 1.1).
  const edgeReady = resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;

  const byDirection = (["LONG", "SHORT"] as const).map((direction) => {
    const rows = resolved.filter((o) => o.direction === direction);
    const rowNets = rows.map((o) => o.netR as number);
    return {
      direction,
      resolvedCount: rows.length,
      netAvgR: rowNets.length ? mean(rowNets) : null,
      wr: rows.length ? rowNets.filter((r) => r > 0).length / rows.length : null,
    };
  });

  const worstOis = observations.map((o) => o.worstOiChangePercent).filter((v): v is number => finite(v));

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      symbol: o.symbol,
      direction: o.direction,
      cascadeDirection: o.cascadeDirection,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
      atrMultipleAtEntry: o.atrMultipleAtEntry,
      stallBarsAtEntry: o.stallBarsAtEntry,
      worstOiChangePercent: o.worstOiChangePercent,
      takerRatioAtWorst: o.takerRatioAtWorst,
    }));

  return {
    laneId: LQR_LANE_ID,
    interval: LQR_INTERVAL,
    universe: LQR_UNIVERSE,
    signalSource: "OI_TAKER_FLOW_PROXY",
    params: {
      cascadeWindowBars: LQR_CASCADE_WINDOW_BARS,
      cascadeAtrMult: LQR_CASCADE_ATR_MULT,
      stallBars: LQR_STALL_BARS,
      maxStallBars: LQR_MAX_STALL_BARS,
      minOiDropPct: LQR_MIN_OI_DROP_PCT,
      stopBufferFrac: LQR_STOP_BUFFER_FRAC,
      stopFloorBps: LQR_STOP_FLOOR_BPS,
      targetRetraceFrac: LQR_TARGET_RETRACE_FRAC,
      maxHoldHours: LQR_MAX_HOLD_HOURS,
      maxOpen: LQR_MAX_OPEN,
    },
    openCount: open.length,
    resolvedCount: resolved.length,
    netAvgR,
    grossAvgR: resolved.length ? mean(resolved.map((o) => (finite(o.grossR) ? (o.grossR as number) : 0))) : null,
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    targetShare: resolved.length ? targets / resolved.length : null,
    stopShare: resolved.length ? stops / resolved.length : null,
    edgeReady,
    byDirection,
    avgAtrMultipleAtEntry: observations.length ? mean(observations.map((o) => o.atrMultipleAtEntry)) : null,
    avgStallBarsAtEntry: observations.length ? mean(observations.map((o) => o.stallBarsAtEntry)) : null,
    avgWorstOiChangePercentAtEntry: worstOis.length ? mean(worstOis) : null,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}

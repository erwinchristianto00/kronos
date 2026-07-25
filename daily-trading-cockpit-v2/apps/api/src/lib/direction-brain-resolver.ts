/**
 * Direction Brain outcome resolver (counterfactual measurement, 2026-07-23). Resolves a single
 * PendingDirectionRow (see four-brain-outcome-ledger.ts) against a BTCUSDT 1h candle series into a
 * realized-R outcome, PURE + deterministic (no Date.now/Math.random/I/O — the caller supplies `nowMs`
 * explicitly so PENDING-vs-resolvable status is testable without wall-clock coupling).
 *
 * WHY BTCUSDT-only proxy: the Direction Brain issues ONE decision per horizon per TICK — it is
 * regime-level (no symbol field; see DirectionDecision in four-brain-types.ts and
 * four-brain-live-gather-bindings.ts's own horizon loop, which builds `directions` with no per-symbol
 * branching). Its own inputs (marketBias, BTC ATR-percentile) are already BTC-anchored, so resolving
 * against BTCUSDT alone is the correct, deliberate proxy — NOT a synthetic multi-symbol basket. This was
 * an agreed design choice; do not re-litigate it here.
 *
 * FROZEN reuse (byte-for-byte, not re-derived — see replay-tier-a-core.ts/entry-brain.ts/direction-brain.ts):
 *  - HORIZON_BARS (SCALP=1, INTRADAY=4, SWING=24, on 1h bars) + HOUR, for horizon-to-ms conversion.
 *  - RISK_ATR_MULT (1.5) composed with computeATR's own ATR14, for the R denominator ("risk").
 *  - ENTRY_ROUNDTRIP_COST_BPS (22bps), converted to cost-in-R via the SAME priceCost/riskDistance shape
 *    entry-brain.ts's own expectedNetR uses (stopDistBps = (risk/entryPrice)*10_000; costR =
 *    ENTRY_ROUNDTRIP_COST_BPS/stopDistBps) — which is itself algebraically identical to
 *    replay-execution-emulator.ts's `toR(priceCost, riskDistancePrice) = priceCost/riskDistancePrice`
 *    idiom that replay-tier-a-core.ts's own EXEC_LEVELS cost conversion is built on. Same shape, single
 *    flat round-trip bps input (no EXEC_LEVELS sweep — Direction Brain has one cost assumption, not five).
 *  - DIRECTION_EDGE_HURDLE_R (0.03), the same hurdle direction-brain.ts itself scores against.
 *
 * CRITICAL no-lookahead rule: `targetExitMs = asOfMs + horizonMs` is computed ONCE, from the row's own
 * `asOfMs` + a FIXED horizon-to-ms table — never from `nowMs`. Candle selection (both entry and exit
 * reference) depends ONLY on `asOfMs`/`targetExitMs`, never on `nowMs`; `nowMs` is used SOLELY to decide
 * PENDING vs "attempt resolution now" and, on failure, INSTRUMENT_DATA_MISSING vs EXPIRED_UNRESOLVABLE.
 * Appending candles strictly AFTER `targetExitMs` to the input array must never change the resolved
 * result (see the causality test in test/direction-brain-resolver.test.ts).
 */
import type { Candle } from "@dtc/shared";
import { computeATR } from "./candle-indicators.js";
import { HOUR, HORIZON_BARS, RISK_ATR_MULT, GAP_LOOKBACK_BARS } from "./replay-tier-a-core.js";
import { ENTRY_ROUNDTRIP_COST_BPS } from "./entry-brain.js";
import { DIRECTION_EDGE_HURDLE_R } from "./direction-brain.js";
import type { FourBrainOutcomeHorizon, FourBrainOutcomeDirectionAction, PendingDirectionRow } from "./four-brain-outcome-ledger.js";

export type DirectionResolutionStatus = "PENDING" | "EVALUATED" | "INSTRUMENT_DATA_MISSING" | "EXPIRED_UNRESOLVABLE";

/** Horizon → duration in ms. Derived from HORIZON_BARS × HOUR (1h bars) — reused verbatim, not re-derived. */
export const HORIZON_MS: Record<FourBrainOutcomeHorizon, number> = {
  SCALP: HORIZON_BARS.SCALP * HOUR,
  INTRADAY: HORIZON_BARS.INTRADAY * HOUR,
  SWING: HORIZON_BARS.SWING * HOUR,
};

const ATR_PERIOD = 14;
/** Past this much wall-clock time beyond targetExitMs with STILL no usable candle data, a row is
 *  reclassified from the transient INSTRUMENT_DATA_MISSING to the terminal EXPIRED_UNRESOLVABLE — it
 *  will never be attempted again. Mirrors GAP_LOOKBACK_BARS' own 7d (168h) window from
 *  replay-tier-a-core.ts, the widest rolling window any Tier-A feature reads. */
export const MAX_UNRESOLVABLE_STALENESS_MS = 7 * 24 * HOUR;

export interface ResolvedDirectionOutcome {
  decisionId: string;
  horizon: FourBrainOutcomeHorizon;
  action: FourBrainOutcomeDirectionAction;
  asOfMs: number;
  /** asOfMs + horizon-in-ms — fixed AT DECISION TIME, independent of when resolution actually runs. */
  targetExitMs: number;
  status: DirectionResolutionStatus;
  entryPrice: number | null;
  exitPrice: number | null;
  /** RISK_ATR_MULT × ATR14 at entry — the R denominator. */
  riskAtEntry: number | null;
  longNetR: number | null;
  shortNetR: number | null;
  /** LONG → longNetR; SHORT → shortNetR; FLAT → pinned EXACTLY 0 (never derived); BOTH → mean(long, short). */
  chosenNetR: number | null;
  /** Headline win/loss for the action actually taken (see module doc for the per-action rule; BOTH
   *  requires BOTH legs to individually clear the hurdle, not just their mean). */
  win: 0 | 1 | null;
  /** SECONDARY field, never the headline win/loss: max(longNetR, shortNetR) − chosenNetR, floored at 0.
   *  The floor only ever engages for FLAT (whose chosenNetR is pinned at 0 rather than derived from the
   *  actually-realized move) — LONG/SHORT/BOTH's own chosenNetR already sits at-or-below that max by
   *  construction, so the floor is a no-op for them. Zero for a fully-correct FLAT (neither side would
   *  have cleared the hurdle, in fact neither side even beat scratch). */
  regretR: number | null;
  /** expectedDirectionalR − chosenNetR. ONLY ever computed for LONG/SHORT rows; always null for
   *  FLAT/BOTH (no single predicted R exists to calibrate against a blended/pinned outcome). */
  calibrationGapR: number | null;
}

/** Index of the LATEST candle whose close is already known at-or-before `atOrBeforeMs` — i.e. the latest
 *  candle with `openTime + HOUR <= atOrBeforeMs` (a 1h bar's close is only knowable once the bar has
 *  fully elapsed). Returns -1 if none. PRECONDITION: `candles` ascending by openTime (parseKlines / this
 *  codebase's Binance getCandles both already guarantee this ordering) — never re-sorted here, so this
 *  function's own result depends only on `atOrBeforeMs`, never on array order or wall-clock time. */
function findLatestAvailableIndex(candles: Candle[], atOrBeforeMs: number): number {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.openTime + HOUR <= atOrBeforeMs) idx = i;
    else break;
  }
  return idx;
}

/** True iff any consecutive pair of candles within [fromIdx, toIdx] (inclusive) is not exactly one 1h
 *  bar apart. Same "gap" signature as replay-tier-a-core.ts's own hasDataGapInLookback/countHourGaps,
 *  reimplemented locally (this module's Candle type — the live @dtc/shared shape binance.ts's
 *  getCandles actually returns — is structurally narrower than replay-tier-a-core's own richer
 *  historical-replay Candle interface, so those exported helpers can't be reused type-compatibly). */
function hasHourlyGap(candles: Candle[], fromIdx: number, toIdx: number): boolean {
  const start = Math.max(1, fromIdx);
  for (let k = start; k <= toIdx; k++) {
    if (candles[k]!.openTime - candles[k - 1]!.openTime !== HOUR) return true;
  }
  return false;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function emptyOutcome(
  base: Pick<ResolvedDirectionOutcome, "decisionId" | "horizon" | "action" | "asOfMs" | "targetExitMs">,
  status: DirectionResolutionStatus,
): ResolvedDirectionOutcome {
  return {
    ...base,
    status,
    entryPrice: null,
    exitPrice: null,
    riskAtEntry: null,
    longNetR: null,
    shortNetR: null,
    chosenNetR: null,
    win: null,
    regretR: null,
    calibrationGapR: null,
  };
}

/**
 * Resolve one PendingDirectionRow against a BTCUSDT 1h candle series. `nowMs` gates PENDING vs an
 * attempted resolution AND (on data failure) INSTRUMENT_DATA_MISSING vs EXPIRED_UNRESOLVABLE — it never
 * influences which candle is chosen as entry/exit reference (see module doc's no-lookahead rule).
 */
export function resolveDirectionOutcome(row: PendingDirectionRow, btcCandles: Candle[], nowMs: number): ResolvedDirectionOutcome {
  const { decisionId, asOfMs, horizon, action, expectedDirectionalR } = row;
  const targetExitMs = asOfMs + HORIZON_MS[horizon];
  const base = { decisionId, horizon, action, asOfMs, targetExitMs };

  if (nowMs < targetExitMs) return emptyOutcome(base, "PENDING");

  const dataFailureStatus = (): DirectionResolutionStatus =>
    nowMs - targetExitMs > MAX_UNRESOLVABLE_STALENESS_MS ? "EXPIRED_UNRESOLVABLE" : "INSTRUMENT_DATA_MISSING";

  // ── Entry reference: latest BTC candle closed at-or-before asOfMs ───────────────────────────────
  const entryIdx = findLatestAvailableIndex(btcCandles, asOfMs);
  if (entryIdx < 0) return emptyOutcome(base, dataFailureStatus());
  const entryAvailableAt = btcCandles[entryIdx]!.openTime + HOUR;
  if (asOfMs - entryAvailableAt >= HOUR) return emptyOutcome(base, dataFailureStatus()); // gap right at the point we need data

  // ── ATR14/risk at entry (needs a clean, gap-free trailing window) ───────────────────────────────
  // computeATR is Wilder's RECURSIVE smoother (atr[i] = atr[i-1]*(period-1)/period + tr[i]/period), so a
  // corrupted true-range bleeds into every later ATR value with slowly-decaying weight — NOT just the
  // next ATR_PERIOD(14) bars. Guarded with GAP_LOOKBACK_BARS(168, 7d), the SAME "widest rolling window
  // any Tier-A feature reads" precedent replay-tier-a-core.ts itself uses to gap-guard this identical
  // ATR14 computation (see hasDataGapInLookback there) — a 14-bar-only window here would leave a gap
  // 15-167 bars back silently contaminating riskAtEntry (and everything R-denominated downstream) while
  // still reporting status "EVALUATED", i.e. presented as trustworthy.
  if (hasHourlyGap(btcCandles, Math.max(0, entryIdx - GAP_LOOKBACK_BARS), entryIdx)) return emptyOutcome(base, dataFailureStatus());
  const atr14 = computeATR(btcCandles, ATR_PERIOD);
  const atrAtEntry = atr14[entryIdx];
  if (!finite(atrAtEntry) || atrAtEntry <= 0) return emptyOutcome(base, dataFailureStatus());
  const entryPrice = btcCandles[entryIdx]!.close;
  if (!finite(entryPrice) || entryPrice <= 0) return emptyOutcome(base, dataFailureStatus());
  const risk = RISK_ATR_MULT * atrAtEntry;

  // ── Exit reference: latest BTC candle closed at-or-before targetExitMs (FIXED at decision time) ───
  const exitIdx = findLatestAvailableIndex(btcCandles, targetExitMs);
  if (exitIdx < entryIdx) return emptyOutcome(base, dataFailureStatus());
  const exitAvailableAt = btcCandles[exitIdx]!.openTime + HOUR;
  if (targetExitMs - exitAvailableAt >= HOUR) return emptyOutcome(base, dataFailureStatus()); // gap right at the target exit
  const exitPrice = btcCandles[exitIdx]!.close;
  if (!finite(exitPrice) || exitPrice <= 0) return emptyOutcome(base, dataFailureStatus());

  // ── Gross move → net R, cost mirrored from entry-brain.ts's own ENTRY_ROUNDTRIP_COST_BPS shape ───
  const grossLong = (exitPrice - entryPrice) / risk;
  const stopDistBps = (risk / entryPrice) * 10_000;
  const costR = ENTRY_ROUNDTRIP_COST_BPS / stopDistBps; // stopDistBps > 0 guaranteed (risk>0, entryPrice>0)
  const longNetR = grossLong - costR;
  const shortNetR = -grossLong - costR;

  // ── Per-action scoring ───────────────────────────────────────────────────────────────────────────
  let chosenNetR: number;
  let win: 0 | 1;
  if (action === "LONG") {
    chosenNetR = longNetR;
    win = longNetR > DIRECTION_EDGE_HURDLE_R ? 1 : 0;
  } else if (action === "SHORT") {
    chosenNetR = shortNetR;
    win = shortNetR > DIRECTION_EDGE_HURDLE_R ? 1 : 0;
  } else if (action === "BOTH") {
    chosenNetR = (longNetR + shortNetR) / 2;
    win = longNetR > DIRECTION_EDGE_HURDLE_R && shortNetR > DIRECTION_EDGE_HURDLE_R ? 1 : 0;
  } else {
    // FLAT: netR is PINNED at exactly 0 by definition — never a derived value.
    chosenNetR = 0;
    // FLAT "wins" precisely when doing nothing was objectively correct: neither side cleared the hurdle.
    win = Math.max(longNetR, shortNetR) <= DIRECTION_EDGE_HURDLE_R ? 1 : 0;
  }

  // Regret: secondary field only, floored at 0 (can't have negative regret — a floor that only ever
  // engages for FLAT, since chosenNetR for LONG/SHORT/BOTH already sits at-or-below max(long,short) by
  // construction; see the doc comment on ResolvedDirectionOutcome.regretR).
  const regretR = Math.max(0, Math.max(longNetR, shortNetR) - chosenNetR);

  const calibrationGapR =
    (action === "LONG" || action === "SHORT") && finite(expectedDirectionalR) ? expectedDirectionalR - chosenNetR : null;

  return {
    ...base,
    status: "EVALUATED",
    entryPrice,
    exitPrice,
    riskAtEntry: risk,
    longNetR,
    shortNetR,
    chosenNetR,
    win,
    regretR,
    calibrationGapR,
  };
}

// ── Effective sample size (non-overlapping horizon-window block clustering) ───────────────────────────

export interface DirectionResolvedForClustering {
  horizon: FourBrainOutcomeHorizon;
  asOfMs: number;
}

export interface DirectionEffectiveSampleSize {
  horizon: FourBrainOutcomeHorizon;
  /** Raw count of resolved decisions for this horizon — overstates precision under overlapping windows
   *  (e.g. a new SWING decision every tick while the prior SWING's 24h window is still open). */
  rawN: number;
  /** Count of DISTINCT non-overlapping horizon-window blocks touched — the effective, non-overlapping
   *  sample size. Always <= rawN. */
  effectiveN: number;
  /** Sorted distinct block indices (for inspection/debugging), same units as horizonBlockKey. */
  blockIndices: number[];
}

/** Non-overlapping horizon-window block key: floor(asOfMs / horizonMs). The EXACT dayKey/monthKey
 *  clustering idiom from replay-tier-a-core.ts (`Math.floor(tMs / 86_400_000)`), generalized from a
 *  fixed calendar-day bucket to each horizon's own window width in ms — two decisions of the same
 *  horizon whose windows fall in the same block are correlated/overlapping, not independent draws. */
function horizonBlockKey(asOfMs: number, horizon: FourBrainOutcomeHorizon): number {
  return Math.floor(asOfMs / HORIZON_MS[horizon]);
}

/** Pure helper: given resolved decisions (any status), report raw n AND the non-overlapping-block
 *  effective n per horizon — computed ALONGSIDE raw n, never replacing it (see module doc / task
 *  design: raw n over overlapping SWING/INTRADAY windows overstates precision). */
export function computeDirectionEffectiveSampleSize(resolved: DirectionResolvedForClustering[]): DirectionEffectiveSampleSize[] {
  const byHorizon = new Map<FourBrainOutcomeHorizon, number[]>();
  for (const r of resolved) {
    const arr = byHorizon.get(r.horizon);
    if (arr) arr.push(r.asOfMs);
    else byHorizon.set(r.horizon, [r.asOfMs]);
  }
  const out: DirectionEffectiveSampleSize[] = [];
  for (const [horizon, asOfList] of byHorizon.entries()) {
    const blocks = new Set<number>();
    for (const asOfMs of asOfList) blocks.add(horizonBlockKey(asOfMs, horizon));
    out.push({ horizon, rawN: asOfList.length, effectiveN: blocks.size, blockIndices: [...blocks].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.horizon.localeCompare(b.horizon));
}

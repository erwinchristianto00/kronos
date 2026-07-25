/**
 * ENTRY BRAIN TIER 2 (SIMULATED) outcome resolver (Track 2 of the Direction/Entry counterfactual
 * measurement design, 2026-07-23). Resolves a pending Entry Brain decision (four-brain-outcome-ledger.ts's
 * PendingEntryRow) against a FORWARD candle path when no real fill exists to join to — that is Tier 1
 * (a separate, real-fill resolver built elsewhere this same phase). Tier 2 is the fallback: "what would
 * have happened if this decision's own targetEntry/initialStopPrice had actually been traded."
 *
 * DECISION (already made, not re-litigated here): reuse entry-exit-counterfactual.ts's
 * evaluateEntryActions/simulateTrade UNMODIFIED as the pure resolution core. This file adds NO new
 * simulator and NO take-profit rule — simulateTrade's own hard-stop + time-exit behavior is the only exit
 * logic in play. See that module's own docstring for its intrabar discipline (adverse extreme tested
 * before favorable; a bar touching both is `ambiguousIntrabar`, resolved adverse-first — never weakened
 * here).
 *
 * live-mark-price-cache.ts was evaluated and REJECTED for this purpose: it is a latest-value-only
 * {symbol -> {price, atMs}} record, overwritten wholesale on every ~25s refresh with no history retained
 * (see that module's own LiveMarkPriceCacheStore — a plain Record, `set()` replacing the prior entry
 * outright). It cannot support a retroactive tick-by-tick walk from an arbitrary past asOfMs, which is
 * exactly what Tier 2 needs — candles must come from a real historical range fetch instead (e.g.
 * binance.ts's `getCandles(symbol, "15m", limit, { startTime, endTime })`, which does support that).
 *
 * NEVER INVENTS THE DECISION'S OWN GEOMETRY: entryPrice is always row.targetEntry and riskDistance is
 * always |targetEntry - initialStopPrice| — the decision's actual recorded stop, never a re-derived ATR
 * distance or any other substitute. A row missing either field, or whose implied riskDistance is not a
 * finite positive number, resolves to `null` (fail-safe) rather than a fabricated/partial result.
 *
 * PERMANENT CONFIDENCE TAG (schema field, not a temporary flag): ENTER_NOW rows are tagged MEASURED (a
 * real trade was — per the decision — actually meant to happen at that price). Every WAIT_PULLBACK /
 * WAIT_BREAKOUT / WAIT_CONFIRMATION / SKIP row is tagged EXPERIMENTAL_COST_OF_CAUTION. A WAIT that turns
 * into an ENTER_NOW on a fresh signal two ticks later is not wrong — it deferred — so its simulated
 * "what if I'd entered anyway" outcome must never be presented at the same confidence as a real trade
 * simulation. This tag must never be removed or treated as a migration/cleanup item.
 */
import type { PendingEntryRow, FourBrainOutcomeEntryAction, FourBrainOutcomeEntrySide } from "./four-brain-outcome-ledger.js";
import { evaluateEntryActions, type PathCandle, type EntryParams, type EntryResult } from "./entry-exit-counterfactual.js";
import { ENTRY_ROUNDTRIP_COST_BPS } from "./entry-brain.js";

// ── Tunable constants (named, not magic numbers) ────────────────────────────────────────────────────────

/** Forward-walk cap: 8 hours of 15-minute candles. Tunable — change this ONE constant to retune the cap;
 *  ENTRY_TIER2_HORIZON_BARS is derived from it, never hand-adjusted separately. */
export const ENTRY_TIER2_HORIZON_MS = 8 * 60 * 60_000;
export const ENTRY_TIER2_BAR_MS = 15 * 60_000;
export const ENTRY_TIER2_HORIZON_BARS = Math.floor(ENTRY_TIER2_HORIZON_MS / ENTRY_TIER2_BAR_MS); // 32

/** WAIT_* geometry defaults — only exercised when resolving a WAIT_PULLBACK/WAIT_BREAKOUT/
 *  WAIT_CONFIRMATION row (which always carries EXPERIMENTAL_COST_OF_CAUTION regardless of these values).
 *  Fractions mirror scripts/replay-entry-exit-6mo-run.ts's own PULLBACK_FRAC/BREAKOUT_FRAC precedent
 *  (0.5); window/confirm bar counts are scaled down to this resolver's 15m granularity. */
export const ENTRY_TIER2_WAIT_WINDOW_BARS = 8; // 2h at 15m
export const ENTRY_TIER2_PULLBACK_FRAC = 0.5;
export const ENTRY_TIER2_BREAKOUT_FRAC = 0.5;
export const ENTRY_TIER2_CONFIRM_BARS = 2; // 30min

export type EntryTier2Confidence = "MEASURED" | "EXPERIMENTAL_COST_OF_CAUTION";

/** ENTER_NOW is the only real-trade-simulation action; every WAIT_ variant (or SKIP) row is a
 *  cost-of-caution experiment. This mapping is the PERMANENT schema contract described in the module
 *  docstring above. */
export function entryTier2ConfidenceForAction(action: FourBrainOutcomeEntryAction): EntryTier2Confidence {
  return action === "ENTER_NOW" ? "MEASURED" : "EXPERIMENTAL_COST_OF_CAUTION";
}

export interface EntryTier2ResolvedRow {
  decisionId: string;
  asOfMs: number;
  symbolOrBasketId: string | null;
  laneId: string | null;
  side: FourBrainOutcomeEntrySide;
  action: FourBrainOutcomeEntryAction;
  /** PERMANENT — see module docstring. Never remove; never treat as a temporary migration flag. */
  confidence: EntryTier2Confidence;
  /** Always row.targetEntry — never invented. */
  entryPrice: number;
  /** Always |targetEntry - initialStopPrice| — the decision's own real geometry, never invented. */
  riskDistance: number;
  horizonBars: number;
  /** The EntryResult (from entry-exit-counterfactual.ts's evaluateEntryActions, unmodified) matching this
   *  row's OWN decided action — not all five; Tier 2 resolves what actually happened (or would have),
   *  not a hypothetical menu. */
  result: EntryResult;
  /** True when `result.outcome` walked FEWER than ENTRY_TIER2_HORIZON_BARS bars from its own entryBar
   *  because the supplied candle path ran out first (simulateTrade's `path.length - 1` clamp), NOT because
   *  of a stop-out or a genuine full-horizon time-exit. Only ever true for a WAIT_* row whose trigger fired
   *  after bar 0 against an under-fetched candle path — see the docstring above on resolveEntryTier2Row for
   *  the candle-count contract this is guarding. Always false when `result.outcome.entered` is false (SKIP,
   *  or a WAIT_* whose trigger never fired) or when it was stopped out (a stop is never a truncation). */
  horizonTruncated: boolean;
}

/**
 * Resolve one pending Entry Brain decision's Tier 2 (SIMULATED) counterfactual outcome.
 *
 * `candles` must be 15-minute PathCandles spanning from `row.asOfMs` (candles[0], the decision candle)
 * through `row.asOfMs + ENTRY_TIER2_HORIZON_MS + ENTRY_TIER2_WAIT_WINDOW_BARS * ENTRY_TIER2_BAR_MS` — i.e.
 * ENTRY_TIER2_HORIZON_BARS + ENTRY_TIER2_WAIT_WINDOW_BARS + 1 candles total (matching
 * scripts/replay-entry-exit-6mo-run.ts's own `i .. i + HORIZON + WAIT_WINDOW + 1` slice precedent) — the
 * caller's job (a historical range fetch via binance.ts's getCandles(symbol, "15m", limit, { startTime,
 * endTime }), never live-mark-price-cache.ts). Supplying only ENTRY_TIER2_HORIZON_BARS + 1 candles
 * under-fetches for WAIT_PULLBACK/WAIT_BREAKOUT/WAIT_CONFIRMATION rows whose trigger fires after bar 0:
 * simulateTrade's own `lastBar = min(path.length - 1, entryBar + horizonBars)` cap means a late trigger
 * gets a walk shortened by however many bars into the wait window it fired, not its own full horizon. This
 * resolver cannot detect an under-fetch directly (it only sees the candles it was given), but it DOES flag
 * the resulting shortened walk via `horizonTruncated` below — always check that field before trusting a
 * WAIT_* row's netR/exitBar as a full-horizon outcome.
 *
 * Because evaluateEntryActions/simulateTrade (entry-exit-counterfactual.ts) read the ENTER_NOW reference
 * price from path[0].close (see that module's own docstring: "refPrice = path[0].close"), candles[0] is
 * defensively re-anchored so its close equals row.targetEntry before the call — open/high/low are passed
 * through UNCHANGED (evaluateEntryActions never reads them as the ref price, only close) and nothing else
 * about the candle is fabricated. This guarantees the pure core resolves off the decision's own quoted
 * entry price, never off a possibly-slightly-different raw exchange close for that same bar.
 *
 * Returns null (never a fabricated/partial row) when:
 *  - candles is empty, or
 *  - row.targetEntry or row.initialStopPrice is missing/non-finite/non-positive (never invents the
 *    decision's own geometry), or
 *  - the implied riskDistance is not a finite positive number.
 *
 * The forward walk is capped at ENTRY_TIER2_HORIZON_BARS bars FROM THE TRADE'S OWN ENTRY BAR (bar 0 for
 * ENTER_NOW; the trigger bar, anywhere in 1..ENTRY_TIER2_WAIT_WINDOW_BARS, for a WAIT_* action that fires);
 * simulateTrade's OWN time-exit at that cap (resolving at the cap candle's close) fires automatically when
 * no stop is touched first — this function adds no separate time-exit or take-profit rule. That said, the
 * cap is ALSO clamped to `path.length - 1` (simulateTrade never reads past the supplied candles), so a
 * WAIT_* trade entered late still only walks whatever forward candles remain in the caller's array; see
 * `horizonTruncated` on the returned row, which is true exactly when this clamp — not a stop, not a
 * genuine full-horizon close — is what ended the walk short of ENTRY_TIER2_HORIZON_BARS.
 */
export function resolveEntryTier2Row(row: PendingEntryRow, candles: PathCandle[]): EntryTier2ResolvedRow | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const entryPrice = row.targetEntry;
  const stopPrice = row.initialStopPrice;
  if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (stopPrice == null || !Number.isFinite(stopPrice) || stopPrice <= 0) return null;

  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (!(riskDistance > 0) || !Number.isFinite(riskDistance)) return null;

  // Re-anchor path[0].close to the decision's own targetEntry — see docstring above.
  const path: PathCandle[] = [{ ...candles[0]!, close: entryPrice }, ...candles.slice(1)];

  // Real round-trip cost in R, using the SAME cost convention Entry Brain itself uses for expectedNetR
  // (entry-brain.ts's ENTRY_ROUNDTRIP_COST_BPS) — never a separately-invented cost figure.
  const stopDistBps = (riskDistance / entryPrice) * 10_000;
  const costRoundTripR = stopDistBps > 0 ? ENTRY_ROUNDTRIP_COST_BPS / stopDistBps : 0;

  const params: EntryParams = {
    direction: row.side,
    riskDistance,
    horizonBars: ENTRY_TIER2_HORIZON_BARS,
    costRoundTripR,
    waitWindowBars: ENTRY_TIER2_WAIT_WINDOW_BARS,
    pullbackFrac: ENTRY_TIER2_PULLBACK_FRAC,
    breakoutFrac: ENTRY_TIER2_BREAKOUT_FRAC,
    confirmBars: ENTRY_TIER2_CONFIRM_BARS,
  };

  const results = evaluateEntryActions(path, params);
  const result = results.find((r) => r.action === row.action);
  // Defensive only: row.action already passed FourBrainOutcomeEntryAction's own runtime check upstream
  // (extractPendingEntryRow), and evaluateEntryActions always returns all five actions — this can't
  // actually miss, but we never fabricate a result if it somehow did.
  if (!result) return null;

  // See horizonTruncated's own doc comment above: true only when the walk ended because the supplied path
  // ran out (simulateTrade's path.length-1 clamp), never for a stop-out or a genuine full-horizon exit.
  const { outcome } = result;
  const horizonTruncated =
    outcome.entered &&
    !outcome.stoppedOut &&
    outcome.entryBar != null &&
    outcome.exitBar != null &&
    outcome.exitBar - outcome.entryBar < ENTRY_TIER2_HORIZON_BARS;

  return {
    decisionId: row.decisionId,
    asOfMs: row.asOfMs,
    symbolOrBasketId: row.symbolOrBasketId,
    laneId: row.laneId,
    side: row.side,
    action: row.action,
    confidence: entryTier2ConfidenceForAction(row.action),
    entryPrice,
    riskDistance,
    horizonBars: ENTRY_TIER2_HORIZON_BARS,
    result,
    horizonTruncated,
  };
}

// ── Decile report: chaseRisk / slippageRisk vs realized outcome (existing fields, no new model) ─────────
// entry-brain.ts's EntryDecision already computes chaseRisk/slippageRisk (both 0..1) at decision time; the
// PendingEntryRow ledger itself does not carry them (it only keeps enough to resolve the trade outcome —
// see four-brain-outcome-ledger.ts's own doc comment), so the caller supplies them alongside each row's
// resolved netR (e.g. read back from the full journaled EXECUTIVE_DECISION record's brains.entry slice).
// This is purely a REPORT over those two existing fields — no new scoring model, no new prediction.

export interface EntryTier2DecileInput {
  chaseRisk: number | null;
  slippageRisk: number | null;
  /** Realized netR for this decision (Tier 1 real-fill OR Tier 2 simulated — whichever resolved it). */
  netR: number | null;
}

export interface EntryTier2DecileBucket {
  /** 0..9, decile index over the fixed [0,1] chaseRisk/slippageRisk range. */
  decile: number;
  rangeLo: number;
  rangeHi: number;
  n: number;
  meanNetR: number | null;
}

const DECILE_COUNT = 10;

function round4(v: number | null): number | null {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4;
}

/** Bucket (x, netR) pairs into 10 fixed-width [0,1] deciles. x outside [0,1] or non-finite, or a null x,
 *  is excluded from every bucket (never coerced/clamped into a bucket it didn't actually land in). Empty
 *  buckets report n=0 and meanNetR=null — never a fabricated 0. */
function bucketByDecile(pairs: Array<{ x: number | null; netR: number | null }>): EntryTier2DecileBucket[] {
  const buckets: EntryTier2DecileBucket[] = Array.from({ length: DECILE_COUNT }, (_, i) => ({
    decile: i,
    rangeLo: round4(i / DECILE_COUNT)!,
    rangeHi: round4((i + 1) / DECILE_COUNT)!,
    n: 0,
    meanNetR: null,
  }));
  const sums = new Array<number>(DECILE_COUNT).fill(0);
  const counts = new Array<number>(DECILE_COUNT).fill(0);
  const netCounts = new Array<number>(DECILE_COUNT).fill(0);

  for (const { x, netR } of pairs) {
    if (x == null || !Number.isFinite(x) || x < 0 || x > 1) continue;
    const idx = Math.min(DECILE_COUNT - 1, Math.floor(x * DECILE_COUNT));
    counts[idx] += 1;
    if (netR != null && Number.isFinite(netR)) {
      sums[idx] += netR;
      netCounts[idx] += 1;
    }
  }

  for (let i = 0; i < DECILE_COUNT; i += 1) {
    buckets[i]!.n = counts[i]!;
    buckets[i]!.meanNetR = netCounts[i]! > 0 ? round4(sums[i]! / netCounts[i]!) : null;
  }
  return buckets;
}

/** Report-only: chaseRisk vs realized netR, bucketed by decile. */
export function bucketChaseRiskByDecile(rows: EntryTier2DecileInput[]): EntryTier2DecileBucket[] {
  return bucketByDecile(rows.map((r) => ({ x: r.chaseRisk, netR: r.netR })));
}

/** Report-only: slippageRisk vs realized netR, bucketed by decile. */
export function bucketSlippageRiskByDecile(rows: EntryTier2DecileInput[]): EntryTier2DecileBucket[] {
  return bucketByDecile(rows.map((r) => ({ x: r.slippageRisk, netR: r.netR })));
}

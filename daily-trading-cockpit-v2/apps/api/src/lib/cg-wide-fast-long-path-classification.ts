/**
 * CG_WIDE_FAST_LONG real-trade PATH CLASSIFICATION (operator research brief item 2, 2026-07-10).
 * Pure, offline, read-only. Mutates nothing, touches no live trading behavior.
 *
 * Classifies a single closed CG_WIDE_FAST_LONG trade's post-entry REAL candle path into exactly
 * one of four buckets:
 *   DEAD_ON_ARRIVAL — the real path never even covered estimated round-trip cost + slippage
 *                      before the real close.
 *   SCRATCHABLE     — covered round-trip cost (would have armed the live breakeven-after-cost
 *                      sweep — see productionBreakevenTriggerPrice below) but never reached a
 *                      genuine expansion move.
 *   TRUE_EXPANSION  — reached a genuine favorable expansion: maxMfeR >= a fixed R floor, OR
 *                      >= a volatility-adjusted floor (see resolveTrueExpansionThresholdR).
 *   TOXIC_REVERSAL  — moved hard against the entry thesis FIRST, before the path ever showed
 *                      any useful favorable excursion — checked BEFORE the other three (see the
 *                      precedence doc on classifyCgWideFastLongPath).
 *
 * This module has NO knowledge of LiveIntent, the live execution store, or Binance — it is pure
 * math over values the caller (apps/api/scripts/backfill-cg-wide-fast-long-mfe.ts) already has
 * from its existing walkVariantPath machinery (maxMfeR / minMaeR / productionBreakevenTriggerPrice)
 * plus one additive candle scan (scanCandlePathCrossings below) for first-crossing TIMES that
 * walkVariantPath's own per-exit-rule VariantWalkResult does not expose (it only ever surfaces the
 * time of the ULTIMATE favorable peak — peakAtMs — not "when did running MFE first cross 0.1R").
 *
 * Nothing here touches current-guard-variant-matrix.ts or live-execution-engine.ts. The
 * DEAD_ON_ARRIVAL/SCRATCHABLE boundary reuses walkVariantPath's own
 * "production_breakeven_control" exitRule's productionBreakevenTriggerPrice DIRECTLY (see that
 * module's doc block) rather than re-deriving the cost formula here — per the operator brief's
 * explicit instruction not to reinvent an already-validated threshold.
 */

import type { Candle } from "@dtc/shared";

export type PathClass = "DEAD_ON_ARRIVAL" | "SCRATCHABLE" | "TRUE_EXPANSION" | "TOXIC_REVERSAL";

export interface PathClassificationThresholds {
  /** TRUE_EXPANSION fires if maxMfeR reaches AT LEAST this fixed R floor — the operator brief's
   *  own literal anchor value ("maxMfeR >= 1.0R"). */
  trueExpansionFixedR: number;
  /** TRUE_EXPANSION alternative, volatility-adjusted (see resolveTrueExpansionThresholdR's doc
   *  for the full derivation): fires if maxMfeR reaches at least `trueExpansionAtrMultiple`
   *  entry-ATRs of favorable price movement, expressed in R-terms. Disabled (never fires) when
   *  the trade's entryAtrPriceUnits/riskPriceDistance are unavailable — the module then falls
   *  back to the fixed floor alone, a documented simplification. */
  trueExpansionAtrMultiple: number;
  /** TOXIC_REVERSAL's adverse leg: minMaeR must breach (be <=) this threshold. Negative, e.g.
   *  -0.5 = half a planned-risk-unit against the entry. */
  toxicReversalAdverseR: number;
  /** TOXIC_REVERSAL's "before ANY useful favorable excursion" ceiling: the smallest maxMfeR the
   *  brief still calls a "useful favorable excursion". TOXIC_REVERSAL requires the adverse breach
   *  above to occur strictly before (or, on a same-candle tie, no later than) running maxMfeR
   *  first reaches this small positive level. */
  toxicReversalEarlyFavorableCeilingR: number;
}

/**
 * Default thresholds — operator/researcher judgment calls, NOT derived from this dataset, kept as
 * plain tunable fields so a future sweep can adjust them without touching any logic below:
 *
 *  - trueExpansionFixedR = 1.0 — the brief's own literal anchor.
 *  - trueExpansionAtrMultiple = 3 — "3 entry-ATRs of favorable movement, expressed in R-terms,
 *    counts as a genuine expansion" (a common "this is a real move, not noise" heuristic),
 *    converted into R-space via the trade's OWN entryATR/riskPriceDistance ratio. This is the
 *    "reasonable volatility-adjusted formula" the brief invites, rather than forcing one flat
 *    R value on every trade regardless of how tight/wide its stop is relative to its own symbol's
 *    volatility:
 *      - a lane whose stop is TIGHT relative to the symbol's ATR (ATR is a large fraction of the
 *        stop distance) needs a LARGER R move before that move is distinguishable from ordinary
 *        noise for that symbol;
 *      - a lane whose stop is WIDE relative to ATR (ATR is a small fraction of the stop distance)
 *        needs only a SMALL R move to already represent several real ATRs of movement.
 *    Whichever of the fixed floor or this vol-adjusted floor is SMALLER effectively governs (an
 *    OR — either condition alone is sufficient, exactly per the brief: "maxMfeR >= 1.0R, OR
 *    maxMfeR >= a configurable volatility-adjusted expansion threshold").
 *  - toxicReversalAdverseR = -0.5 — half the planned risk: a meaningful, not noise-level, adverse
 *    move, but still short of a full stop-out (-1R) so it also catches trades that eventually
 *    recovered without ever hitting the hard stop.
 *  - toxicReversalEarlyFavorableCeilingR = 0.1 — small but non-zero: below this the trade cannot
 *    be said to have shown ANY real sign the entry thesis was working before the adverse breach.
 *
 * DOCUMENTED SIMPLIFICATION: when a trade's entryATR/risk data is unavailable (see
 * resolveTrueExpansionThresholdR), TRUE_EXPANSION reduces to the flat trueExpansionFixedR = 1.0R
 * floor alone — within the operator brief's own suggested 0.5-1.0R range for a "reasonable fixed
 * value" fallback.
 */
export const DEFAULT_PATH_CLASSIFICATION_THRESHOLDS: PathClassificationThresholds = {
  trueExpansionFixedR: 1.0,
  trueExpansionAtrMultiple: 3,
  toxicReversalAdverseR: -0.5,
  toxicReversalEarlyFavorableCeilingR: 0.1,
};

/**
 * Resolves the EFFECTIVE TRUE_EXPANSION threshold (R-multiples) for one trade: the smaller of the
 * fixed floor and the volatility-adjusted floor (entryAtrPriceUnits/riskPriceDistance *
 * trueExpansionAtrMultiple), when ATR/risk data is available; the fixed floor alone otherwise.
 * Exported (not inlined into classifyCgWideFastLongPath) so callers building the crossing-time
 * scan (scanCandlePathCrossings) and the classifier itself resolve the IDENTICAL threshold — no
 * risk of the two drifting out of sync.
 */
export function resolveTrueExpansionThresholdR(
  entryAtrPriceUnits: number | null,
  riskPriceDistance: number | null,
  thresholds: PathClassificationThresholds,
): number {
  const volAdjusted =
    entryAtrPriceUnits !== null &&
    Number.isFinite(entryAtrPriceUnits) &&
    entryAtrPriceUnits >= 0 &&
    riskPriceDistance !== null &&
    riskPriceDistance > 0
      ? thresholds.trueExpansionAtrMultiple * (entryAtrPriceUnits / riskPriceDistance)
      : null;
  return volAdjusted !== null ? Math.min(thresholds.trueExpansionFixedR, volAdjusted) : thresholds.trueExpansionFixedR;
}

/**
 * Everything classifyCgWideFastLongPath needs about ONE trade's real path. Deliberately a plain
 * data bag (no candles, no I/O) so the classification logic itself is trivially unit-testable with
 * synthetic values — see apps/api/test/cg-wide-fast-long-path-classification.test.ts.
 */
export interface PathWalkFacts {
  /** Best favorable excursion reached at any point on the real bounded path (R-multiples of the
   *  trade's own planned risk). Reused DIRECTLY from walkVariantPath's VariantWalkResult.maxMfeR —
   *  never recomputed here (per the operator brief: "reuse this walking machinery, do not rebuild
   *  it"). Null when the walk never produced a valid path (e.g. NO_FILL/UNRESOLVED). */
  maxMfeR: number | null;
  /** Worst adverse excursion reached (negative R-multiples, or 0). Reused directly from
   *  VariantWalkResult.minMaeR, same provenance as maxMfeR above. */
  minMaeR: number | null;
  /** Entry-time ATR in PRICE units (same units as entryPrice/stopLoss — NOT pre-divided by risk).
   *  Null when insufficient pre-entry candle history was available to compute it (honest
   *  omission, never estimated/fabricated). */
  entryAtrPriceUnits: number | null;
  /** The trade's own 1R distance in PRICE units (|entryPrice - stopLossPrice|). Required to
   *  translate entryAtrPriceUnits into R-terms. Null/<=0 disables the volatility-adjusted
   *  TRUE_EXPANSION alternative (falls back to the fixed floor only). */
  riskPriceDistance: number | null;
  /** First real-candle timestamp (epoch ms) at which price crossed
   *  VariantWalkResult.productionBreakevenTriggerPrice — the DEAD_ON_ARRIVAL/SCRATCHABLE
   *  boundary. Null = never reached before the real close. */
  timeToBreakevenTriggerMs: number | null;
  /** First timestamp (epoch ms) at which running MAE breached thresholds.toxicReversalAdverseR.
   *  Null = never breached. */
  timeToToxicAdverseMs: number | null;
  /** First timestamp (epoch ms) at which running MFE first reached
   *  thresholds.toxicReversalEarlyFavorableCeilingR ("any useful favorable excursion"). Null =
   *  never reached. */
  timeToSmallFavorableMs: number | null;
}

export interface PathClassificationOutcome {
  pathClass: PathClass;
  /** Short human-readable reason — which specific condition decided the classification. Purely
   *  diagnostic (printed in the backfill report / asserted in tests); never itself branched on. */
  reason: string;
  /** The RESOLVED TRUE_EXPANSION threshold actually used for this trade (see
   *  resolveTrueExpansionThresholdR) — diagnostic only. */
  resolvedExpansionThresholdR: number;
}

/**
 * Pure classification function.
 *
 * PRECEDENCE (documented per the operator brief's explicit instruction — "classify by what
 * happened FIRST/chronologically, not just final outcome"):
 *
 *   1. TOXIC_REVERSAL — checked FIRST, regardless of the trade's FINAL maxMfeR/minMaeR. Fires
 *      when minMaeR breached thresholds.toxicReversalAdverseR AND that breach happened
 *      chronologically no later than running maxMfeR first reaching
 *      thresholds.toxicReversalEarlyFavorableCeilingR (i.e. before — or, on a same-candle tie, not
 *      after — ANY useful favorable excursion). A trade that eventually recovers to breakeven, or
 *      even eventually reaches a 1R+ expansion, is STILL classified TOXIC_REVERSAL if the adverse
 *      move came first — the brief's own worked example ("a trade can be both 'eventually reached
 *      breakeven' AND 'went hard against the thesis first'"). Same-candle ties (both thresholds
 *      crossed within the same 5m candle, so their crossing times are equal) are resolved
 *      conservatively TOWARD TOXIC_REVERSAL — mirroring this codebase's established
 *      same-candle-ambiguity convention (walkVariantPath always resolves an ambiguous same-candle
 *      SL+TP touch as SL-first without 1m refinement; here, adverse-first).
 *   2. TRUE_EXPANSION — maxMfeR >= the resolved expansion threshold (fixed floor OR
 *      volatility-adjusted floor, whichever is smaller). Checked only once TOXIC_REVERSAL has
 *      been ruled out.
 *   3. SCRATCHABLE — the real path reached the breakeven-after-cost trigger price at some point
 *      (timeToBreakevenTriggerMs !== null) but never qualified as TRUE_EXPANSION.
 *   4. DEAD_ON_ARRIVAL — none of the above: the real path never even covered round-trip cost
 *      before its real close.
 */
export function classifyCgWideFastLongPath(
  walkResult: PathWalkFacts,
  thresholds: PathClassificationThresholds = DEFAULT_PATH_CLASSIFICATION_THRESHOLDS,
): PathClassificationOutcome {
  const resolvedExpansionThresholdR = resolveTrueExpansionThresholdR(
    walkResult.entryAtrPriceUnits,
    walkResult.riskPriceDistance,
    thresholds,
  );

  // ── 1. TOXIC_REVERSAL (checked first — see precedence doc above) ────────────────────────────
  const adverseBreached = walkResult.minMaeR !== null && walkResult.minMaeR <= thresholds.toxicReversalAdverseR;
  if (adverseBreached && walkResult.timeToToxicAdverseMs !== null) {
    const neverHadUsefulFavorable = walkResult.timeToSmallFavorableMs === null;
    const adverseCameFirstOrTied =
      walkResult.timeToSmallFavorableMs !== null && walkResult.timeToToxicAdverseMs <= walkResult.timeToSmallFavorableMs;
    if (neverHadUsefulFavorable || adverseCameFirstOrTied) {
      return {
        pathClass: "TOXIC_REVERSAL",
        reason:
          `minMaeR ${walkResult.minMaeR!.toFixed(3)}R breached the toxic threshold ${thresholds.toxicReversalAdverseR}R ` +
          (neverHadUsefulFavorable
            ? "and the trade never reached any useful favorable excursion"
            : `before (or in the same candle as) maxMfeR first reached the small-favorable ceiling ` +
              `${thresholds.toxicReversalEarlyFavorableCeilingR}R`),
        resolvedExpansionThresholdR,
      };
    }
  }

  // ── 2. TRUE_EXPANSION ─────────────────────────────────────────────────────────────────────────
  if (walkResult.maxMfeR !== null && walkResult.maxMfeR >= resolvedExpansionThresholdR) {
    return {
      pathClass: "TRUE_EXPANSION",
      reason:
        `maxMfeR ${walkResult.maxMfeR.toFixed(3)}R reached the expansion threshold ` +
        `${resolvedExpansionThresholdR.toFixed(3)}R (fixed floor ${thresholds.trueExpansionFixedR}R)`,
      resolvedExpansionThresholdR,
    };
  }

  // ── 3. SCRATCHABLE ────────────────────────────────────────────────────────────────────────────
  if (walkResult.timeToBreakevenTriggerMs !== null) {
    return {
      pathClass: "SCRATCHABLE",
      reason: "real path reached the production breakeven-after-cost trigger price but never reached expansion",
      resolvedExpansionThresholdR,
    };
  }

  // ── 4. DEAD_ON_ARRIVAL ────────────────────────────────────────────────────────────────────────
  return {
    pathClass: "DEAD_ON_ARRIVAL",
    reason: "real path never reached the production breakeven-after-cost trigger price before the real close",
    resolvedExpansionThresholdR,
  };
}

export interface CandlePathCrossingLevels {
  /** Absolute PRICE level — walkVariantPath's production_breakeven_control
   *  productionBreakevenTriggerPrice, reused directly. Null disables that crossing (never
   *  reported reached). */
  breakevenTriggerPrice: number | null;
  toxicAdverseR: number;
  smallFavorableR: number;
  /** The resolved TRUE_EXPANSION threshold for THIS trade — pass resolveTrueExpansionThresholdR's
   *  output so timeToExpansion is consistent with what classifyCgWideFastLongPath itself used. */
  expansionThresholdR: number;
}

export interface CandlePathCrossings {
  /** Epoch ms of the candle whose OPEN time coincides with the LAST decrease of the running
   *  minimum MAE — i.e. the trough of the bounded path. Mirrors VariantWalkResult.peakAtMs's "last
   *  increased" convention exactly, just for the adverse side (which walkVariantPath itself does
   *  not expose — this is the additive "equivalent trough timestamp" the operator brief allows
   *  for). Null when the path never went adverse (minMaeR stayed at/above 0) or the scan window
   *  was empty. */
  timeToMAE: number | null;
  timeToBreakevenTrigger: number | null;
  timeToToxicAdverse: number | null;
  timeToSmallFavorable: number | null;
  timeToExpansion: number | null;
}

/**
 * Scans REAL fetched candles bounded to [fromMs, toMs] (inclusive of candle openTime) for the
 * first-crossing times classifyCgWideFastLongPath needs, plus the trough time for the per-trade
 * record's timeToMAE field.
 *
 * Callers should pass the SAME bounds walkVariantPath's own per-intent walk used
 * (VariantWalkResult.openedAtMs / .closedAtMs) so every derived timing field in the per-trade
 * record describes the EXACT same bounded sub-path as the reused maxMfeR/minMaeR/peakAtMs already
 * do — see backfill-cg-wide-fast-long-mfe.ts's path-classification section for how those bounds
 * are obtained and threaded through.
 *
 * Pure function; uses the SAME favorable/adverse-R formula walkVariantPath's own internal
 * updatePath() uses (favorable = max(high-entry,0) for LONG, mfeR = favorable/risk; adverse =
 * min(low-entry,0), maeR = adverse/risk; mirrored for SHORT) — duplicated here (not imported)
 * because walkVariantPath does not export updatePath, and this scan needs FIRST-CROSSING times for
 * thresholds walkVariantPath's own result shape has no concept of (it only ever exposes the time
 * of the ULTIMATE favorable peak, not "when did running MFE first cross 0.1R").
 */
export function scanCandlePathCrossings(input: {
  candles: Candle[];
  direction: "LONG" | "SHORT";
  entryPrice: number;
  riskPriceDistance: number;
  fromMs: number;
  toMs: number;
  levels: CandlePathCrossingLevels;
}): CandlePathCrossings {
  const { candles, direction, entryPrice, riskPriceDistance, fromMs, toMs, levels } = input;
  const result: CandlePathCrossings = {
    timeToMAE: null,
    timeToBreakevenTrigger: null,
    timeToToxicAdverse: null,
    timeToSmallFavorable: null,
    timeToExpansion: null,
  };
  if (!(riskPriceDistance > 0) || !(toMs >= fromMs)) return result;

  let runningMaxMfeR = 0;
  let runningMinMaeR = 0;
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  for (const c of sorted) {
    if (c.openTime < fromMs || c.openTime > toMs) continue;
    const favorable = direction === "LONG" ? Math.max(c.high - entryPrice, 0) : Math.max(entryPrice - c.low, 0);
    const adverse = direction === "LONG" ? Math.min(c.low - entryPrice, 0) : Math.min(entryPrice - c.high, 0);
    const mfeR = favorable / riskPriceDistance;
    const maeR = adverse / riskPriceDistance;
    if (!Number.isFinite(mfeR) || !Number.isFinite(maeR)) continue;

    if (mfeR > runningMaxMfeR) runningMaxMfeR = mfeR;
    if (maeR < runningMinMaeR) {
      runningMinMaeR = maeR;
      result.timeToMAE = c.openTime;
    }

    if (result.timeToBreakevenTrigger === null && levels.breakevenTriggerPrice !== null) {
      const hit = direction === "LONG" ? c.high >= levels.breakevenTriggerPrice : c.low <= levels.breakevenTriggerPrice;
      if (hit) result.timeToBreakevenTrigger = c.openTime;
    }
    if (result.timeToToxicAdverse === null && runningMinMaeR <= levels.toxicAdverseR) {
      result.timeToToxicAdverse = c.openTime;
    }
    if (result.timeToSmallFavorable === null && runningMaxMfeR >= levels.smallFavorableR) {
      result.timeToSmallFavorable = c.openTime;
    }
    if (result.timeToExpansion === null && runningMaxMfeR >= levels.expansionThresholdR) {
      result.timeToExpansion = c.openTime;
    }
  }
  return result;
}

export type EntryRegimeAlignment = "ALIGNED" | "COUNTER_REGIME" | "NEUTRAL";

/**
 * Maps the entry-time RegimeDirectionController mode (LiveIntentSource.controllerMode, captured at
 * intent-creation time — see regime-direction-controller.ts's RegimeDirectionMode) onto how well
 * that regime read agreed with CG_WIDE_FAST_LONG's own LONG-only bias. Operator-brief judgment
 * call, documented here (not derived from data):
 *   ALIGNED        — controllerMode === "LONG_ONLY": the regime engine was itself calling for LONG
 *                     exposure at entry time, the SAME direction as this lane.
 *   COUNTER_REGIME — controllerMode === "SHORT_ONLY" (the regime explicitly favored the OPPOSITE
 *                     direction) OR any "NO_TRADE"-flavoured mode ("NO_TRADE_CHOP",
 *                     "NO_TRADE_NEGATIVE_EDGE" — the regime engine was explicitly NOT validating
 *                     new exposure at all when this LONG was taken).
 *   NEUTRAL        — everything else: "BOTH_ALLOWED", "VALIDATION_ONLY", the WAIT_RETEST_* modes,
 *                     "UNKNOWN", or missing/null (older intents / rescue legs that never passed
 *                     through the controller hook) — genuinely uncertain, neither confirming nor
 *                     opposing the entry.
 * Matches the operator brief's own worked example exactly ("ALIGNED if mode is LONG_ONLY-like,
 * COUNTER_REGIME if SHORT_ONLY-like or NO_TRADE, NEUTRAL otherwise").
 */
export function classifyEntryRegimeAlignmentForLong(controllerMode: string | null | undefined): EntryRegimeAlignment {
  if (controllerMode === "LONG_ONLY") return "ALIGNED";
  if (controllerMode === "SHORT_ONLY" || controllerMode === "NO_TRADE_CHOP" || controllerMode === "NO_TRADE_NEGATIVE_EDGE") {
    return "COUNTER_REGIME";
  }
  return "NEUTRAL";
}

/**
 * The full per-trade record the operator brief asks for.
 *
 * CRITICAL DATA-AVAILABILITY NOTE (deliberately NOT part of this type): fields like OI-change,
 * funding rate, top-trader long/short ratio, or price-impact-efficiency AT ENTRY TIME are NOT
 * included here. Those require real-time market-microstructure collectors
 * (price-impact-efficiency.ts, derivatives-crowding.ts's flowConfirmed, etc.) that were only built
 * TODAY (2026-07-10) and were NOT running when these 79 historical trades were actually entered
 * days/weeks ago — they are genuinely unavailable for historical trades, not just zero, and must
 * never be backfilled/estimated/zero-filled. Omitted entirely rather than nulled, so no caller can
 * mistake "field absent from the type" for "field present but null" (a fabrication risk if a
 * generic serializer ever added them back with a default).
 */
export interface CgWideFastLongClassifiedTradeRecord {
  tradeId: string;
  lane: "CG_WIDE_FAST_LONG";
  symbol: string;
  /** ISO-8601, for human readability. All timeToX fields below are epoch ms instead, to match
   *  VariantWalkResult.peakAtMs's own convention exactly (so they can be diffed against it
   *  directly without a unit conversion). */
  entryTimestamp: string;
  entryHourUtc: number;
  entryPrice: number;
  /** Null when insufficient pre-entry candle history was available (honest omission — see
   *  PathWalkFacts.entryAtrPriceUnits doc). */
  entryATR: number | null;
  /** Directly from LiveIntentSource.regime at entry time — no reconstruction. Null when the
   *  source intent never captured one (older intents / rescue legs). */
  entryRegime: string | null;
  /** Directly from LiveIntentSource.controllerMode at entry time — no reconstruction. */
  entryControllerMode: string | null;
  entryRegimeAlignment: EntryRegimeAlignment;
  /** Reused directly from the existing per-intent walkVariantPath call's maxMfeR/minMaeR. */
  maxMfeR: number | null;
  minMaeR: number | null;
  /** === the reused walk's peakAtMs (epoch ms); null if maxMfeR is null. */
  timeToMFE: number | null;
  /** Additive trough time from scanCandlePathCrossings (epoch ms); null if minMaeR never went
   *  negative or the scan window was empty. */
  timeToMAE: number | null;
  timeToBreakevenTrigger: number | null;
  timeToExpansion: number | null;
  /** Real $ P&L, lane-share-prorated (same convention as the rest of the backfill script's $
   *  figures) — ground truth from the ledger, not simulated. */
  realizedNetPnLUsd: number;
  /** Real $ P&L expressed in R-multiples of the trade's own real planned risk ($) — ground truth,
   *  DISTINCT from the simulated walk's grossR. Null when planned risk (riskUsd) is unavailable or
   *  non-positive. */
  realizedR: number | null;
  /** Real ledger closeReason — ground truth. */
  exitReason: string | null;
  pathClass: PathClass;
  pathClassReason: string;
}

/**
 * CG_WIDE_FAST_LONG backfill (Tier 1 item 4) + exit-rule ablation (Tier 2 item 5).
 * Read-only, offline, mutates nothing.
 *
 * Loads every REAL closed CG_WIDE_FAST_LONG live intent (all-time) from the live
 * execution store, re-walks each one's actual entry→exit candle path with the
 * canonical honest simulator (walkVariantPath — same engine used by the resolver
 * and by paper-execution-router.ts) to recover maxMfeR / minMaeR / peakAtMs /
 * grossR, and reports win/loss/payoff, fee drag, MFE/MAE, giveback-from-peak,
 * time-to-MFE, and a P&L breakdown by symbol and by hour-of-day-UTC.
 *
 * Tier 2 item 5 extends this with an EXIT-RULE ABLATION: the SAME real entry
 * geometry (entry/stop/target) and the SAME fetched candle window for every
 * closed CG_WIDE_FAST_LONG intent is re-walked through ALL SEVEN exit rules —
 * the 4 pre-existing ones (tp1_full, trail_after_tp1, scaleout_tp1_trail,
 * mfe_giveback) plus the 3 new offline-analysis-only ones added alongside this
 * script (atr_trail via walkVariantPath, a pyramid-only-on-confirmed-winner
 * variant via walkPyramidOnConfirmedWinner, and — Task 1, 2026-07-10 —
 * production_breakeven_control, modeling live-execution-engine.ts's REAL
 * maybeCloseLiveBreakevenLaneAfterCost() exit as a VALIDATED CONTROL) — so any
 * difference in the printed comparison table is attributable to exit geometry
 * alone, not to different entries or candle data. Cost is applied uniformly
 * (same taker round-trip bps over the SAME stop distance) across every
 * variant for the same reason. This is purely a report; it changes nothing
 * about the real intent, the live lane, or any default exitRule selection
 * anywhere in the app.
 *
 * Task 2 (2026-07-10) additionally prints a RECONCILIATION section comparing
 * production_breakeven_control's SIMULATED outcome against each real trade's
 * ACTUAL ground truth (real closeReason, real realizedPnlUsd, a derived real
 * exit price). This is a fact-finding report, not a promotion gate — if the
 * simulator cannot reproduce production behavior within the documented
 * tolerance, the report says so plainly (see mismatchReasons) rather than
 * hiding it.
 *
 * A LATER, separate operator research brief (item 2, also 2026-07-10 — NOT the same "Task 2" as
 * the reconciliation paragraph above, which predates it) additionally prints a PATH CLASSIFICATION
 * section: every real trade's post-entry path is classified into DEAD_ON_ARRIVAL / SCRATCHABLE /
 * TRUE_EXPANSION / TOXIC_REVERSAL (see ../src/lib/cg-wide-fast-long-path-classification.ts for the
 * full definitions, thresholds, and precedence rule) and persisted as a full per-trade JSON record
 * to scripts/output/cg-wide-fast-long-path-classification.json. Reuses this script's existing
 * walkVariantPath machinery (maxMfeR/minMaeR/peakAtMs) and the production_breakeven_control
 * control's productionBreakevenTriggerPrice directly — no new exit-cost threshold is invented.
 *
 * Needs live candle data (WARP/non-geo-blocked network — see binance.ts; Indonesia
 * blocks api.binance.com market data). Uses BinanceClient exactly as the existing
 * apps/api/scripts/{honest-reresolve,cgwide-exit-search}.ts backfills do.
 *
 * Usage (from repo root):
 *   cd apps/api && npx tsx scripts/backfill-cg-wide-fast-long-mfe.ts [dataDir]
 *
 * dataDir defaults to apps/api/data (this repo's local/dev store). To analyze the
 * REAL live account, point it at a copy of the live VPS's apps/api/data directory
 * (that store — not this laptop's — is where real CG_WIDE_FAST_LONG closes live).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { LiveExecutionStore, type LiveIntent } from "../src/lib/live-execution-engine.js";
import {
  walkVariantPath,
  walkPyramidOnConfirmedWinner,
  stopDistanceBpsOf,
  TAKER_ROUNDTRIP_BPS,
  ATR_TRAIL_PERIOD,
  VARIANT_MATRIX_DEFINITIONS,
  type KlineTuple,
  type VariantExitRule,
  type VariantFillMode,
  type VariantWalkResult,
} from "../src/lib/current-guard-variant-matrix.js";
import { BinanceClient } from "../src/lib/binance.js";
import { fetchCandlesRange } from "../src/lib/candle-range-fetch.js";
import { computeATR } from "../src/lib/candle-indicators.js";
import {
  classifyCgWideFastLongPath,
  classifyEntryRegimeAlignmentForLong,
  resolveTrueExpansionThresholdR,
  scanCandlePathCrossings,
  DEFAULT_PATH_CLASSIFICATION_THRESHOLDS,
  type PathWalkFacts,
  type CgWideFastLongClassifiedTradeRecord,
} from "../src/lib/cg-wide-fast-long-path-classification.js";
import type { Candle } from "@dtc/shared";

const CANDLE_MS = 5 * 60 * 1000;
const TARGET_VARIANT_ID = "CG_WIDE_FAST_LONG";

// ── Path classification (operator research brief item 2, 2026-07-10) ───────────────────────────
// entryATR needs pre-entry candle HISTORY the main walk's own candle fetch does not provide (that
// fetch only starts 1 candle before entryMs — enough to walk forward, not enough to compute a
// 14-period ATR backward). A small, SEPARATE, additive fetch (reusing fetchCandlesRange, now
// imported from ../src/lib/candle-range-fetch.ts) pulls just enough pre-entry candles for this.
// ATR_TRAIL_PERIOD (imported from
// current-guard-variant-matrix.ts) is reused as the ATR period for consistency with that file's
// own atr_trail exit rule rather than introducing a second, unrelated ATR-period constant.
const ENTRY_ATR_LOOKBACK_BUFFER_CANDLES = 5;
// Output path for the persisted per-trade classification records (see main()'s final section).
// Deliberately NOT under data/ (which may point at a read-only copy of the live VPS's store) —
// this is a derived REPORT artifact, safe to write regardless of which --dataDir was passed.
const PATH_CLASSIFICATION_OUTPUT_PATH = join(import.meta.dirname, "output", "cg-wide-fast-long-path-classification.json");

// Matches the established codebase convention for stripping lane-id prefixes
// (see honest-reresolve.ts's `(o.selectedLaneId ?? "NONE").split(":").pop()`),
// so CG_WIDE_FAST_LONG, CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG, and a testnet→live
// copy's TESTNET_COPY:CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG all match.
function isFastLongLaneId(laneId: string | null | undefined): boolean {
  if (!laneId) return false;
  return laneId.split(":").pop() === TARGET_VARIANT_ID;
}

function intentLaneIds(intent: LiveIntent): string[] {
  if (intent.sourcePaperOrders && intent.sourcePaperOrders.length > 0) {
    return intent.sourcePaperOrders.map((s) => s.laneId);
  }
  return [];
}

// Same predicate production's own getAccountSnapshot().closedLanes uses to decide
// "this intent contributed a closed trade" — no separate `state` filter, matching
// the live ledger's own accounting exactly (see live-execution-engine.ts).
function isRealClosedFastLong(intent: LiveIntent): boolean {
  if (intent.realizedPnlUsd === null || intent.realizedPnlUsd === undefined) return false;
  return intentLaneIds(intent).some(isFastLongLaneId);
}

/** A single Binance symbol position can net entries from MULTIPLE lanes (the engine
 *  is one-way/netted, not per-lane sub-accounts). When that happens the intent's
 *  own realizedPnlUsd/feesUsd/qty describe the WHOLE netted position, not just this
 *  lane's slice. Mirrors production's own closedLanes attribution in
 *  getAccountSnapshot() (live-execution-engine.ts, "2026-07-09 fix" — aggregate by
 *  laneId, share = laneQty/totalQty) so this backfill's dollar figures agree with
 *  what the live dashboard already reports per lane. Entry/stop/target GEOMETRY
 *  cannot be decomposed the same way (Binance nets to one position, one avg price) —
 *  the candle walk necessarily uses the intent's own (blended) entry/stop/target,
 *  same limitation production has everywhere it re-simulates a netted intent. */
function laneShare(intent: LiveIntent): { share: number; laneQty: number } {
  const sources = intent.sourcePaperOrders ?? [];
  if (sources.length === 0) return { share: 1, laneQty: intent.qty };
  const totalQty = sources.reduce((s, x) => s + x.qty, 0);
  const laneQty = sources.filter((s) => isFastLongLaneId(s.laneId)).reduce((s, x) => s + x.qty, 0);
  const share = totalQty > 0 ? laneQty / totalQty : 1 / Math.max(sources.length, 1);
  return { share, laneQty };
}

function variantDef() {
  const def = VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === TARGET_VARIANT_ID);
  if (!def) throw new Error(`Missing variant definition for ${TARGET_VARIANT_ID}`);
  return def;
}

// ── Task 2 (2026-07-10): production_breakeven_control reconciliation ──────────────────────────
// The exact real close-reason string live-execution-engine.ts's maybeCloseLiveBreakevenLaneAfterCost()
// stamps onto a closed LiveIntent (occurs exactly once in apps/api/src, per the Task 1
// investigation — live-execution-engine.ts:2478). walkVariantPath's production_breakeven_control
// exitRule stamps the IDENTICAL string as its own resolutionSource when its modeled trigger fires
// (current-guard-variant-matrix.ts), which is what makes a direct real-vs-simulated comparison
// possible without any string-remapping.
const PRODUCTION_BREAKEVEN_CLOSE_REASON = "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST";

// $ divergence tolerance for the reconciliation's magnitude check. Deliberately GENEROUS and
// explicitly documented as such — NOT a tight statistical bound — given the multiple independent
// approximation sources this same report catalogs per-row (candle-granularity intrabar timing,
// blended-pyramid cost basis, estimated-vs-real commission, MAX_HOLD_MTM close-price proxy). A
// trade's $ outcome is flagged mismatched only when it differs by MORE than the larger of a flat
// $1 floor or 25% of the real trade's own |$| size.
const PNL_MISMATCH_ABS_FLOOR_USD = 1.0;
const PNL_MISMATCH_RELATIVE_TOLERANCE = 0.25;

/** Derives the REAL exit price implied by the intent's OWN ledger figures (investigation 3 item 8):
 *  live-execution-engine.ts's settlement paths compute realizedPnlUsd as ALREADY NET of fees
 *  (net = realizedPnl - fees), and Binance's own realizedPnl for a position is
 *  (exitPrice-entryPrice)*qty for LONG (mirrored for SHORT). So grossRealized = realizedPnlUsd +
 *  (feesUsd ?? 0), and exitPrice = entry ± grossRealized/qty. Deliberately uses the intent's OWN
 *  UN-PRORATED qty/realizedPnlUsd/feesUsd — NOT the lane-share-prorated values this script uses
 *  elsewhere for $ attribution — because the actual Binance exit price is common to the WHOLE
 *  netted position regardless of how many lanes shared it (per investigation 3 item 8's explicit
 *  warning against using the prorated figures here). When feesUsd is null (several real
 *  settlement paths leave it null while still recording a real net realizedPnlUsd — see
 *  live-execution-engine.ts lines 2404/2473/2719/2871/2911 per the investigation), the +fees term
 *  is OMITTED (treated as 0): the derived price then silently absorbs whatever real fee was
 *  actually charged. This is NOT hidden — callers should tag the row with
 *  REAL_FEE_UNAVAILABLE_EXIT_PRICE_OMITS_FEE_TERM (see classifyReconciliation below) whenever this
 *  happens. Returns null when qty<=0 or entry isn't a positive finite number. */
function deriveRealExitPrice(
  direction: "LONG" | "SHORT",
  filledEntryPrice: number,
  realizedPnlUsd: number,
  feesUsd: number | null,
  qty: number,
): number | null {
  if (!(qty > 0) || !Number.isFinite(filledEntryPrice) || !(filledEntryPrice > 0)) return null;
  const grossRealized = realizedPnlUsd + (feesUsd ?? 0);
  return direction === "LONG" ? filledEntryPrice + grossRealized / qty : filledEntryPrice - grossRealized / qty;
}

/** Maps the production_breakeven_control walk's resolutionSource to the PRICE that outcome
 *  implies, so it can be compared against deriveRealExitPrice() above. walkVariantPath is
 *  fundamentally an R-multiple engine, not a price engine — these are the only four
 *  resolutionSource values this exitRule's branch can ever return (see the branch in
 *  current-guard-variant-matrix.ts): the modeled trigger price itself (the control's own exit),
 *  the position's real stop/target levels (an SL/TP close uses those exact prices by
 *  construction), or — for the generic MAX_HOLD_MTM path-end fallback — the last fetched candle's
 *  CLOSE, the SAME approximate proxy this script's own main per-intent walk already uses and
 *  flags (see the "close reasons" section comment above). Returns null for any other
 *  status/resolutionSource (UNRESOLVED/NO_FILL or an unrecognized source). */
function simulatedExitPriceForProductionBreakeven(
  walk: VariantWalkResult,
  stopLossPrice: number,
  tp1Price: number,
  candles: Candle[],
): number | null {
  switch (walk.resolutionSource) {
    case PRODUCTION_BREAKEVEN_CLOSE_REASON:
      return walk.productionBreakevenTriggerPrice;
    case "CANDLE_WALK_TP":
      return tp1Price;
    case "CANDLE_WALK_SL":
    case "AMBIGUOUS_SL_FIRST":
      return stopLossPrice;
    case "MAX_HOLD_MTM":
      return candles.length > 0 ? candles[candles.length - 1]!.close : null;
    default:
      return null;
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

interface ReconciliationRow {
  paperOrderId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  realCloseReason: string | null;
  realFiredViaBreakevenControl: boolean;
  realRealizedPnlUsdShare: number;
  realExitPrice: number | null;
  simStatus: string;
  simResolutionSource: string | null;
  simIntrabarStatus: string | null;
  simFiredViaBreakevenControl: boolean;
  simGrossR: number | null;
  simNetR: number | null;
  simPnlUsdShare: number | null;
  simExitPrice: number | null;
  isPyramided: boolean;
  isNettedWithOtherLane: boolean;
  realFeeWasEstimated: boolean;
  mismatch: boolean;
  mismatchReasons: string[];
}

/** Classifies a single reconciled trade. A trade is a MISMATCH when EITHER (a) the boolean "did
 *  this trade close via the production_breakeven_control mechanism" disagrees between the real
 *  ledger and the simulator, OR (b) both real and simulated $ figures are available and differ
 *  beyond PNL_MISMATCH_ABS_FLOOR_USD / PNL_MISMATCH_RELATIVE_TOLERANCE (see those constants'
 *  docs). Every other flag (pyramided, netted-with-other-lane, estimated-fee, candle-granularity
 *  ambiguity, MAX_HOLD_MTM proxy) is recorded as a CONTEXT annotation regardless of whether the
 *  trade is a mismatch — these are the honest, specific reasons a simulator built on 5m OHLC
 *  candles cannot be expected to perfectly reproduce a live tick-by-tick production mechanism,
 *  not excuses papering over a real divergence. */
function classifyReconciliation(input: {
  realFiredViaBreakevenControl: boolean;
  simFiredViaBreakevenControl: boolean;
  realCloseReason: string | null;
  realRealizedPnlUsdShare: number;
  simPnlUsdShare: number | null;
  isPyramided: boolean;
  isNettedWithOtherLane: boolean;
  realFeeWasEstimated: boolean;
  simIntrabarStatus: string | null;
  simResolutionSource: string | null;
}): { mismatch: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const classificationDisagrees = input.realFiredViaBreakevenControl !== input.simFiredViaBreakevenControl;
  if (classificationDisagrees) {
    reasons.push(
      input.realFiredViaBreakevenControl
        ? "REAL_FIRED_VIA_BREAKEVEN_CONTROL_BUT_SIMULATOR_DID_NOT"
        : "SIMULATOR_FIRED_VIA_BREAKEVEN_CONTROL_BUT_REAL_TRADE_DID_NOT",
    );
  }
  if (
    !input.realFiredViaBreakevenControl &&
    input.realCloseReason !== null &&
    input.realCloseReason !== PRODUCTION_BREAKEVEN_CLOSE_REASON
  ) {
    // The real trade was closed by some OTHER production mechanism entirely (manual close,
    // kill-switch, regime-harvest, a TP1/stop fill under a different close-reason label, etc.)
    // that this isolated single-exit-rule walk cannot know about or compete against — see
    // approximation #4 in current-guard-variant-matrix.ts's constant-block comment.
    reasons.push("REAL_TRADE_CLOSED_BY_UNMODELED_MECHANISM");
  }
  let pnlMismatch = false;
  if (input.simPnlUsdShare !== null && Number.isFinite(input.simPnlUsdShare)) {
    const diff = Math.abs(input.simPnlUsdShare - input.realRealizedPnlUsdShare);
    const tolerance = Math.max(
      PNL_MISMATCH_ABS_FLOOR_USD,
      PNL_MISMATCH_RELATIVE_TOLERANCE * Math.abs(input.realRealizedPnlUsdShare),
    );
    if (diff > tolerance) {
      pnlMismatch = true;
      reasons.push("PNL_MAGNITUDE_DIVERGENCE_BEYOND_TOLERANCE");
    }
  }
  if (input.isPyramided) reasons.push("PYRAMIDED_MULTI_ENTRY_BLENDED_COST_BASIS");
  if (input.isNettedWithOtherLane) reasons.push("NETTED_WITH_OTHER_LANE_ON_SAME_SYMBOL");
  if (input.realFeeWasEstimated) reasons.push("REAL_FEE_UNAVAILABLE_EXIT_PRICE_OMITS_FEE_TERM");
  if (input.simIntrabarStatus === "AMBIGUOUS_SAME_CANDLE_SL_FIRST") reasons.push("CANDLE_GRANULARITY_INTRABAR_AMBIGUITY");
  if (input.simResolutionSource === "MAX_HOLD_MTM") reasons.push("MAX_HOLD_MTM_PROXY_EXIT_PRICE_NOT_A_REAL_FILL");
  return { mismatch: classificationDisagrees || pnlMismatch, reasons };
}

function toKlineTuple(c: Candle): KlineTuple {
  return [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS];
}

// fetchCandlesRange (paginated 5m candle fetch, handles Binance's 1000-candle-per-request cap) now
// lives in ../src/lib/candle-range-fetch.ts (extracted 2026-07-10, operator research brief Task 4) so
// the new hour/session-interaction study script can reuse the IDENTICAL implementation for its BTC
// candle fetches rather than duplicating it — see that module's doc comment for the full rationale.
// Behavior here is byte-for-byte unchanged from the previous local definition.

/** Same-candle SL/TP disambiguation via 1m candles — mirrors the resolve1m closure
 *  in resolveVariantMatrixObservations (current-guard-variant-matrix.ts). Best-effort:
 *  never throws, falls back to walkVariantPath's conservative SL-first on failure. */
function make1mResolver(binance: BinanceClient, symbol: string, direction: "LONG" | "SHORT", S: number, T: number | null) {
  return async (fillCandleOpenMs: number): Promise<"SL" | "TP" | null> => {
    try {
      const raw = await binance.getCandles(symbol, "1m", 6, {
        startTime: fillCandleOpenMs,
        endTime: fillCandleOpenMs + CANDLE_MS,
      });
      for (const c of raw) {
        const slHit = direction === "LONG" ? c.low <= S : c.high >= S;
        const tpHit = T !== null && (direction === "LONG" ? c.high >= T : c.low <= T);
        if (slHit) return "SL";
        if (tpHit) return "TP";
      }
      return null;
    } catch {
      return null;
    }
  };
}

interface BackfillRow {
  paperOrderId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryMs: number;
  closedMs: number;
  closeReason: string | null;
  realizedPnlUsd: number;
  feesUsd: number | null;
  riskUsd: number | null;
  maxMfeR: number | null;
  minMaeR: number | null;
  peakAtMs: number | null;
  grossR: number | null;
  walkStatus: string;
  walkResolutionSource: string | null;
  hourUTC: number;
}

function fmt(n: number | null, digits = 4): string {
  return n === null || !Number.isFinite(n) ? "n/a" : n.toFixed(digits);
}

// ── Exit-rule ablation (Tier 2 item 5, extended by Task 1/2 on 2026-07-10) ──────────────────────
// The 4 pre-existing exitRule values plus the pyramid-confirmed-winner variant (which is walked
// via walkPyramidOnConfirmedWinner, not a plain exitRule) walked over the SAME real entry geometry
// and SAME fetched candle window as the intent's own walk above. atr_trail and (as of Task 1)
// production_breakeven_control are both walked directly via walkVariantPath alongside the other 4
// (they ARE plain exitRules, unlike the pyramid variant).
type AblationVariantId =
  | "tp1_full"
  | "trail_after_tp1"
  | "scaleout_tp1_trail"
  | "mfe_giveback"
  | "atr_trail"
  | "production_breakeven_control"
  | "pyramid_confirmed_winner(tp1_full)";

const ABLATION_SINGLE_EXIT_RULES: VariantExitRule[] = [
  "tp1_full",
  "trail_after_tp1",
  "scaleout_tp1_trail",
  "mfe_giveback",
  "atr_trail",
  "production_breakeven_control",
];

const ABLATION_VARIANT_ORDER: AblationVariantId[] = [...ABLATION_SINGLE_EXIT_RULES, "pyramid_confirmed_winner(tp1_full)"];

interface AblationSample {
  variantId: AblationVariantId;
  netR: number;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

async function main(): Promise<void> {
  const dataDirArg = process.argv[2];
  const dataDir = dataDirArg ? dataDirArg : join(import.meta.dirname, "../data");
  console.log(`Reading live-execution store from: ${dataDir}`);

  const store = new LiveExecutionStore(dataDir);
  const allIntents = store.getState().intents;
  const def = variantDef();

  const candidates = allIntents.filter(isRealClosedFastLong);
  console.log(`Total intents in store: ${allIntents.length}`);
  console.log(`Real closed ${TARGET_VARIANT_ID} intents (all-time): ${candidates.length}`);

  if (candidates.length === 0) {
    console.log(
      `\nNo closed ${TARGET_VARIANT_ID} intents found in this store. If this is the local dev machine, ` +
        `the real trade history lives on the live VPS instead — see the operator run instructions.`,
    );
    return;
  }

  const binance = new BinanceClient();
  const rows: BackfillRow[] = [];
  const ablationSamples: AblationSample[] = [];
  const reconciliationRows: ReconciliationRow[] = [];
  const classifiedRecords: CgWideFastLongClassifiedTradeRecord[] = [];
  let dataFailures = 0;
  let nettedWithOtherLanes = 0;
  let classificationSkipped = 0;

  let processed = 0;
  for (const intent of candidates) {
    processed += 1;
    const entryMs = Date.parse(intent.createdAt);
    const closedMs = Date.parse(intent.closedAt ?? intent.updatedAt);
    if (!Number.isFinite(entryMs) || !Number.isFinite(closedMs) || intent.filledEntryPrice === null) {
      dataFailures += 1;
      console.warn(`  [skip] ${intent.paperOrderId} (${intent.symbol}) — missing entry/close timestamp or fill price`);
      continue;
    }

    const startTime = entryMs - CANDLE_MS;
    const endTime = closedMs + CANDLE_MS;
    let candles: Candle[];
    try {
      candles = await fetchCandlesRange(binance, intent.symbol, startTime, endTime);
    } catch (err) {
      dataFailures += 1;
      console.warn(`  [skip] ${intent.paperOrderId} (${intent.symbol}) — candle fetch failed: ${(err as Error).message}`);
      continue;
    }
    if (candles.length === 0) {
      dataFailures += 1;
      console.warn(`  [skip] ${intent.paperOrderId} (${intent.symbol}) — no candles returned for window`);
      continue;
    }

    const exitRule: VariantExitRule = intent.exitRule ?? def.exitRule;
    const fillMode: VariantFillMode = def.fillMode;
    const resolve1m = make1mResolver(binance, intent.symbol, intent.direction, intent.stopLossPrice, intent.tp1Price ?? null);

    const walk = await walkVariantPath(
      {
        direction: intent.direction,
        entryPrice: intent.filledEntryPrice,
        stopLoss: intent.stopLossPrice,
        target: intent.tp1Price,
        exitRule,
        fillMode,
        openedAtMs: entryMs,
        candles: candles.map(toKlineTuple),
        forceCloseAtEnd: true, // the real trade DID close — never leave it UNRESOLVED for want of a hold cap
      },
      resolve1m,
    );

    // ── Exit-rule ablation (Tier 2 item 5): re-walk the SAME entry geometry + SAME candle window
    //    through all 6 exit rules (4 pre-existing + atr_trail + pyramid_confirmed_winner), fixed
    //    at taker fillMode so the comparison isolates EXIT geometry alone. Cost is the SAME taker
    //    round-trip bps over the SAME stop distance for every variant (fair, apples-to-apples,
    //    matching the whole current-guard-variant-matrix module's own cost convention). Failures
    //    here (e.g. a variant that stays UNRESOLVED) are simply excluded from that variant's
    //    sample — never fabricated.
    const klineCandles = candles.map(toKlineTuple);
    const ablationStopBps = stopDistanceBpsOf(intent.direction, intent.filledEntryPrice, intent.stopLossPrice);
    const ablationCostR = ablationStopBps !== null && ablationStopBps > 0 ? TAKER_ROUNDTRIP_BPS / ablationStopBps : 0;
    let productionBreakevenWalk: VariantWalkResult | null = null;
    for (const rule of ABLATION_SINGLE_EXIT_RULES) {
      const abWalk = await walkVariantPath(
        {
          direction: intent.direction,
          entryPrice: intent.filledEntryPrice,
          stopLoss: intent.stopLossPrice,
          target: intent.tp1Price,
          exitRule: rule,
          fillMode: "taker",
          openedAtMs: entryMs,
          candles: klineCandles,
          forceCloseAtEnd: true,
        },
        resolve1m,
      );
      // Captured for the Task 2 reconciliation below (not re-walked a second time) — same walk,
      // same entries/candles/cost convention as every other ablation variant.
      if (rule === "production_breakeven_control") productionBreakevenWalk = abWalk;
      if (abWalk.grossR !== null) {
        ablationSamples.push({ variantId: rule, netR: abWalk.grossR - ablationCostR });
      }
    }
    const pyramidWalk = await walkPyramidOnConfirmedWinner(
      {
        direction: intent.direction,
        entryPrice: intent.filledEntryPrice,
        stopLoss: intent.stopLossPrice,
        target: intent.tp1Price,
        exitRule: "tp1_full",
        fillMode: "taker",
        openedAtMs: entryMs,
        candles: klineCandles,
        forceCloseAtEnd: true,
      },
      resolve1m,
    );
    // combinedR is already a size-weighted AVERAGE R across both legs; since ablationCostR is the
    // SAME per-leg cost-in-R for both legs (same stop distance assumption), subtracting it once
    // from the blended average is exactly equivalent to netting each leg individually then
    // re-blending (the weights cancel algebraically) — no double-counting or under-counting.
    if (pyramidWalk.combinedR !== null) {
      ablationSamples.push({ variantId: "pyramid_confirmed_winner(tp1_full)", netR: pyramidWalk.combinedR - ablationCostR });
    }

    const { share, laneQty } = laneShare(intent);
    if (share < 0.999) nettedWithOtherLanes += 1;
    const realizedPnlUsdShare = intent.realizedPnlUsd! * share;
    const feesUsdShare = intent.feesUsd !== null ? intent.feesUsd * share : null;
    const riskUsd =
      Number.isFinite(intent.filledEntryPrice) && Number.isFinite(intent.stopLossPrice) && laneQty > 0
        ? Math.abs(intent.filledEntryPrice - intent.stopLossPrice) * laneQty
        : null;

    rows.push({
      paperOrderId: intent.paperOrderId,
      symbol: intent.symbol,
      direction: intent.direction,
      entryMs,
      closedMs,
      closeReason: intent.closeReason,
      realizedPnlUsd: realizedPnlUsdShare,
      feesUsd: feesUsdShare,
      riskUsd,
      maxMfeR: walk.maxMfeR,
      minMaeR: walk.minMaeR,
      peakAtMs: walk.peakAtMs,
      grossR: walk.grossR,
      walkStatus: walk.status,
      walkResolutionSource: walk.resolutionSource,
      hourUTC: new Date(entryMs).getUTCHours(),
    });

    // ── Task 2 (2026-07-10): production_breakeven_control reconciliation row ─────────────────
    // Real ledger figures use the intent's OWN UN-PRORATED realizedPnlUsd/feesUsd/qty for the
    // exit-price derivation (per investigation 3 item 8 — the actual Binance exit price is common
    // to the whole netted position, not divisible by lane share), but the lane-SHARE-prorated
    // realizedPnlUsdShare for the $ P&L comparison (consistent with every other $ figure this
    // script reports, which are all lane-share-prorated to match the live dashboard's own
    // per-lane attribution).
    if (productionBreakevenWalk) {
      const isPyramided = (intent.sourcePaperOrders?.length ?? 0) > 1;
      const realFeeWasEstimated = intent.feesUsd === null;
      const realExitPrice = deriveRealExitPrice(
        intent.direction,
        intent.filledEntryPrice,
        intent.realizedPnlUsd!,
        intent.feesUsd,
        intent.qty,
      );
      const simExitPrice = simulatedExitPriceForProductionBreakeven(
        productionBreakevenWalk,
        intent.stopLossPrice,
        intent.tp1Price,
        candles,
      );
      // R -> $ conversion: the walk's R is relative to the FULL (blended, un-prorated) position's
      // own risk distance and qty (walkVariantPath only ever sees the intent's single blended
      // entry/stop) — so convert using the WHOLE-position dollar risk, THEN apply the same
      // lane-share fraction used for the real $ figure above, for an apples-to-apples comparison.
      const riskUsdWholePosition =
        Number.isFinite(intent.filledEntryPrice) && Number.isFinite(intent.stopLossPrice) && intent.qty > 0
          ? Math.abs(intent.filledEntryPrice - intent.stopLossPrice) * intent.qty
          : null;
      const simNetR = productionBreakevenWalk.grossR !== null ? productionBreakevenWalk.grossR - ablationCostR : null;
      const simPnlUsdShare =
        simNetR !== null && riskUsdWholePosition !== null ? simNetR * riskUsdWholePosition * share : null;
      const realFiredViaBreakevenControl = intent.closeReason === PRODUCTION_BREAKEVEN_CLOSE_REASON;
      const simFiredViaBreakevenControl = productionBreakevenWalk.resolutionSource === PRODUCTION_BREAKEVEN_CLOSE_REASON;
      const { mismatch, reasons } = classifyReconciliation({
        realFiredViaBreakevenControl,
        simFiredViaBreakevenControl,
        realCloseReason: intent.closeReason,
        realRealizedPnlUsdShare: realizedPnlUsdShare,
        simPnlUsdShare,
        isPyramided,
        isNettedWithOtherLane: share < 0.999,
        realFeeWasEstimated,
        simIntrabarStatus: productionBreakevenWalk.intrabarResolutionStatus,
        simResolutionSource: productionBreakevenWalk.resolutionSource,
      });
      reconciliationRows.push({
        paperOrderId: intent.paperOrderId,
        symbol: intent.symbol,
        direction: intent.direction,
        realCloseReason: intent.closeReason,
        realFiredViaBreakevenControl,
        realRealizedPnlUsdShare: realizedPnlUsdShare,
        realExitPrice,
        simStatus: productionBreakevenWalk.status,
        simResolutionSource: productionBreakevenWalk.resolutionSource,
        simIntrabarStatus: productionBreakevenWalk.intrabarResolutionStatus,
        simFiredViaBreakevenControl,
        simGrossR: productionBreakevenWalk.grossR,
        simNetR,
        simPnlUsdShare,
        simExitPrice,
        isPyramided,
        isNettedWithOtherLane: share < 0.999,
        realFeeWasEstimated,
        mismatch,
        mismatchReasons: reasons,
      });
    }

    // ── PATH CLASSIFICATION (operator research brief item 2, 2026-07-10) ─────────────────────
    // Classifies this trade's real post-entry candle path into DEAD_ON_ARRIVAL / SCRATCHABLE /
    // TRUE_EXPANSION / TOXIC_REVERSAL (see cg-wide-fast-long-path-classification.ts for the full
    // definitions/precedence). Reuses walk.maxMfeR/minMaeR/peakAtMs directly (never recomputed)
    // and productionBreakevenWalk.productionBreakevenTriggerPrice directly (the same validated
    // control used by the reconciliation section above) — no new threshold is invented here.
    if (productionBreakevenWalk && walk.openedAtMs !== null && walk.closedAtMs !== null) {
      const riskPriceDistance = Math.abs(intent.filledEntryPrice - intent.stopLossPrice);

      // entryATR needs pre-entry candle HISTORY beyond what the main candle fetch provides (that
      // fetch starts only 1 candle before entryMs). Small, separate, best-effort fetch — failure
      // here never aborts the trade's classification, it just leaves entryATR honestly null (see
      // PathWalkFacts.entryAtrPriceUnits doc: never estimated/fabricated).
      let entryAtrPriceUnits: number | null = null;
      try {
        const atrLookbackCandles = await fetchCandlesRange(
          binance,
          intent.symbol,
          entryMs - (ATR_TRAIL_PERIOD + ENTRY_ATR_LOOKBACK_BUFFER_CANDLES) * CANDLE_MS,
          entryMs + CANDLE_MS,
        );
        const entryIdx = atrLookbackCandles.findIndex(
          (c) => c.openTime <= entryMs && entryMs < c.openTime + CANDLE_MS,
        );
        if (entryIdx >= 0) {
          const atrSeries = computeATR(atrLookbackCandles, ATR_TRAIL_PERIOD);
          const value = atrSeries[entryIdx];
          entryAtrPriceUnits = typeof value === "number" && Number.isFinite(value) ? value : null;
        }
      } catch (err) {
        console.warn(`  [entryATR] ${intent.paperOrderId} (${intent.symbol}) — lookback fetch failed: ${(err as Error).message}`);
      }

      // Entry-time regime/controllerMode: directly from LiveIntentSource, captured AT ENTRY —
      // no reconstruction. "Representative" = the FIRST fast-long-matching source, i.e. the
      // original entry (mirrors live-execution-engine.ts's own convention for classifying a
      // pyramided position's entry regime — later adds' snapshots describe re-entries into an
      // already-open position, not a fresh entry worth its own classification).
      const fastLongSources = (intent.sourcePaperOrders ?? []).filter((s) => isFastLongLaneId(s.laneId));
      const representativeSource = fastLongSources[0];
      const entryRegime = representativeSource?.regime ?? null;
      const entryControllerMode = representativeSource?.controllerMode ?? null;

      const resolvedExpansionThresholdR = resolveTrueExpansionThresholdR(
        entryAtrPriceUnits,
        riskPriceDistance > 0 ? riskPriceDistance : null,
        DEFAULT_PATH_CLASSIFICATION_THRESHOLDS,
      );
      const crossings = scanCandlePathCrossings({
        candles,
        direction: intent.direction,
        entryPrice: intent.filledEntryPrice,
        riskPriceDistance,
        fromMs: walk.openedAtMs,
        toMs: walk.closedAtMs,
        levels: {
          breakevenTriggerPrice: productionBreakevenWalk.productionBreakevenTriggerPrice,
          toxicAdverseR: DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.toxicReversalAdverseR,
          smallFavorableR: DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.toxicReversalEarlyFavorableCeilingR,
          expansionThresholdR: resolvedExpansionThresholdR,
        },
      });

      const walkFacts: PathWalkFacts = {
        maxMfeR: walk.maxMfeR,
        minMaeR: walk.minMaeR,
        entryAtrPriceUnits,
        riskPriceDistance: riskPriceDistance > 0 ? riskPriceDistance : null,
        timeToBreakevenTriggerMs: crossings.timeToBreakevenTrigger,
        timeToToxicAdverseMs: crossings.timeToToxicAdverse,
        timeToSmallFavorableMs: crossings.timeToSmallFavorable,
      };
      const classification = classifyCgWideFastLongPath(walkFacts);

      classifiedRecords.push({
        tradeId: intent.paperOrderId,
        lane: "CG_WIDE_FAST_LONG",
        symbol: intent.symbol,
        entryTimestamp: new Date(entryMs).toISOString(),
        entryHourUtc: new Date(entryMs).getUTCHours(),
        entryPrice: intent.filledEntryPrice,
        entryATR: entryAtrPriceUnits,
        entryRegime,
        entryControllerMode,
        entryRegimeAlignment: classifyEntryRegimeAlignmentForLong(entryControllerMode),
        maxMfeR: walk.maxMfeR,
        minMaeR: walk.minMaeR,
        timeToMFE: walk.peakAtMs,
        timeToMAE: crossings.timeToMAE,
        timeToBreakevenTrigger: crossings.timeToBreakevenTrigger,
        timeToExpansion: crossings.timeToExpansion,
        realizedNetPnLUsd: realizedPnlUsdShare,
        realizedR: riskUsd !== null && riskUsd > 0 ? realizedPnlUsdShare / riskUsd : null,
        exitReason: intent.closeReason,
        pathClass: classification.pathClass,
        pathClassReason: classification.reason,
      });
    } else {
      classificationSkipped += 1;
    }

    if (processed % 25 === 0) console.error(`  …walked ${processed}/${candidates.length}`);
  }

  console.log(`\nSuccessfully walked: ${rows.length} / ${candidates.length} (data failures: ${dataFailures})`);
  console.log(
    `Intents netted with other lanes on the same symbol (dollar figures below are this lane's qty-share only): ${nettedWithOtherLanes}`,
  );
  if (rows.length === 0) {
    console.log("Nothing to summarize — every candidate failed the candle walk.");
    return;
  }

  // ── Win/loss/payoff (real $, from the live ledger) ────────────────────────
  const wins = rows.filter((r) => r.realizedPnlUsd > 0);
  const losses = rows.filter((r) => r.realizedPnlUsd < 0);
  const scratches = rows.filter((r) => r.realizedPnlUsd === 0);
  const avgWinUsd = avg(wins.map((r) => r.realizedPnlUsd));
  const avgLossUsd = avg(losses.map((r) => r.realizedPnlUsd));
  const payoffRatioUsd = avgWinUsd !== null && avgLossUsd !== null && avgLossUsd !== 0 ? avgWinUsd / Math.abs(avgLossUsd) : null;
  const sumRealizedUsd = rows.reduce((s, r) => s + r.realizedPnlUsd, 0);

  // ── Win/loss/payoff (R-space, from the honest candle walk's grossR) ───────
  const withGrossR = rows.filter((r) => r.grossR !== null) as Array<BackfillRow & { grossR: number }>;
  const winsR = withGrossR.filter((r) => r.grossR > 0);
  const lossesR = withGrossR.filter((r) => r.grossR < 0);
  const avgWinR = avg(winsR.map((r) => r.grossR));
  const avgLossR = avg(lossesR.map((r) => r.grossR));
  const payoffRatioR = avgWinR !== null && avgLossR !== null && avgLossR !== 0 ? avgWinR / Math.abs(avgLossR) : null;

  // ── Fee drag ───────────────────────────────────────────────────────────
  const feesKnown = rows.filter((r) => r.feesUsd !== null) as Array<BackfillRow & { feesUsd: number }>;
  const avgFeesUsd = avg(feesKnown.map((r) => r.feesUsd));
  const feeDragRRows = feesKnown.filter((r) => r.riskUsd !== null && r.riskUsd > 0) as Array<
    BackfillRow & { feesUsd: number; riskUsd: number }
  >;
  const avgFeeDragR = avg(feeDragRRows.map((r) => r.feesUsd / r.riskUsd));

  // ── MFE / MAE / time-to-MFE / giveback-from-peak ──────────────────────
  const withMfe = rows.filter((r) => r.maxMfeR !== null) as Array<BackfillRow & { maxMfeR: number }>;
  const withMae = rows.filter((r) => r.minMaeR !== null) as Array<BackfillRow & { minMaeR: number }>;
  const avgMfeR = avg(withMfe.map((r) => r.maxMfeR));
  const avgMaeR = avg(withMae.map((r) => r.minMaeR));
  const withPeak = rows.filter((r) => r.peakAtMs !== null) as Array<BackfillRow & { peakAtMs: number }>;
  const avgTimeToMfeMin = avg(withPeak.map((r) => (r.peakAtMs - r.entryMs) / 60000));
  // Giveback only counted where the trade did NOT close on its own peak candle.
  const givebackRows = rows.filter(
    (r) => r.maxMfeR !== null && r.grossR !== null && r.peakAtMs !== null && r.peakAtMs !== r.closedMs,
  ) as Array<BackfillRow & { maxMfeR: number; grossR: number }>;
  const avgGivebackR = avg(givebackRows.map((r) => r.maxMfeR - r.grossR));

  console.log("\n===== CG_WIDE_FAST_LONG backfill — real closed live trades =====");
  console.log(`n = ${rows.length}  (wins ${wins.length}, losses ${losses.length}, scratches ${scratches.length})`);
  console.log(`Sum realized P&L (USD): ${fmt(sumRealizedUsd, 2)}`);
  console.log(`Avg win  (USD): ${fmt(avgWinUsd, 4)}    Avg loss (USD): ${fmt(avgLossUsd, 4)}    Payoff ratio (USD): ${fmt(payoffRatioUsd, 3)}`);
  console.log(`Avg win  (R, from honest walk):  ${fmt(avgWinR, 3)}    Avg loss (R): ${fmt(avgLossR, 3)}    Payoff ratio (R): ${fmt(payoffRatioR, 3)}`);
  console.log(`Fee drag: avg fees (USD) = ${fmt(avgFeesUsd, 4)} (n=${feesKnown.length})    avg fee drag (R of planned risk) = ${fmt(avgFeeDragR, 4)} (n=${feeDragRRows.length})`);
  console.log(`Avg MFE (R): ${fmt(avgMfeR, 3)} (n=${withMfe.length})    Avg MAE (R): ${fmt(avgMaeR, 3)} (n=${withMae.length})`);
  console.log(`Avg time-to-MFE: ${fmt(avgTimeToMfeMin, 1)} min (n=${withPeak.length})`);
  console.log(`Avg giveback-from-MFE (R, peak minus final realized R, excl. closed-at-peak): ${fmt(avgGivebackR, 3)} (n=${givebackRows.length})`);

  // ── By symbol ──────────────────────────────────────────────────────────
  const bySymbol = new Map<string, BackfillRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  // CG_WIDE_FAST_LONG is one of the lanes the engine auto-flattens the instant it goes
  // net-positive (see LIVE_BREAKEVEN_EXIT_LANE_IDS in live-execution-engine.ts) — many real
  // closes are therefore an early market-exit, NOT a genuine SL/TP touch. walkVariantPath has
  // no "exit at exactly this price" override, so those rows fall through to forceCloseAtEnd's
  // MAX_HOLD_MTM branch and use the last fetched candle's CLOSE as the exit price — a close
  // proxy for the real fill (candle window is bounded to closedAt+1 candle) but not identical
  // to it. This is why real $ P&L (exact, from the ledger) and R-space walk output
  // (approximate, from candles) are reported separately above rather than conflated.
  const closeReasonCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.closeReason ?? "(null)";
    closeReasonCounts.set(key, (closeReasonCounts.get(key) ?? 0) + 1);
  }
  console.log("\n----- close reasons (real, from the ledger) -----");
  for (const [reason, count] of [...closeReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(28)} ${count}`);
  }

  const resolutionCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.walkResolutionSource ?? "(none)";
    resolutionCounts.set(key, (resolutionCounts.get(key) ?? 0) + 1);
  }
  console.log("\n----- walk resolution source (how the candle-walk actually resolved each row) -----");
  console.log("  (anything other than CANDLE_WALK_TP/CANDLE_WALK_SL/*_1M is a MAX_HOLD_MTM approximation — see note above)");
  for (const [source, count] of [...resolutionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(28)} ${count}`);
  }

  console.log("\n----- P&L by symbol -----");
  const symbolRows = [...bySymbol.entries()]
    .map(([symbol, list]) => ({
      symbol,
      n: list.length,
      sumUsd: list.reduce((s, r) => s + r.realizedPnlUsd, 0),
      winRate: list.filter((r) => r.realizedPnlUsd > 0).length / list.length,
      avgMfeR: avg(list.filter((r) => r.maxMfeR !== null).map((r) => r.maxMfeR!)),
    }))
    .sort((a, b) => b.sumUsd - a.sumUsd);
  for (const s of symbolRows) {
    console.log(
      `  ${s.symbol.padEnd(12)} n=${String(s.n).padStart(3)}  sumUsd=${fmt(s.sumUsd, 2).padStart(9)}  WR=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgMFE(R)=${fmt(s.avgMfeR, 3)}`,
    );
  }

  // ── By hour-of-day UTC ─────────────────────────────────────────────────
  const byHour = new Map<number, BackfillRow[]>();
  for (const r of rows) {
    const list = byHour.get(r.hourUTC) ?? [];
    list.push(r);
    byHour.set(r.hourUTC, list);
  }
  console.log("\n----- P&L by hour-of-day (entry hour, UTC) -----");
  for (let h = 0; h < 24; h += 1) {
    const list = byHour.get(h);
    if (!list || list.length === 0) continue;
    const sumUsd = list.reduce((s, r) => s + r.realizedPnlUsd, 0);
    const winRate = list.filter((r) => r.realizedPnlUsd > 0).length / list.length;
    console.log(
      `  ${String(h).padStart(2, "0")}h  n=${String(list.length).padStart(3)}  sumUsd=${fmt(sumUsd, 2).padStart(9)}  WR=${(winRate * 100).toFixed(1).padStart(5)}%`,
    );
  }

  // ── Exit-rule ablation comparison table (Tier 2 item 5, extended by Task 1 on 2026-07-10) ──
  console.log(
    "\n===== Exit-rule ablation — SAME real entries + candles, all 7 exit rules (Tier 2 item 5 + Task 1) =====",
  );
  console.log(
    "(existing 4: tp1_full / trail_after_tp1 / scaleout_tp1_trail / mfe_giveback; " +
      "new 3: atr_trail / production_breakeven_control (Task 1 control) / pyramid_confirmed_winner(tp1_full). " +
      "Cost = same taker round-trip bps over the same stop distance for every variant — differences are exit " +
      "geometry only.)",
  );
  console.log(
    `  ${"variant".padEnd(30)} ${"n".padStart(5)}  ${"netAvgR".padStart(8)}  ${"WR".padStart(7)}  ${"payoff".padStart(7)}`,
  );
  for (const variantId of ABLATION_VARIANT_ORDER) {
    const netRs = ablationSamples.filter((s) => s.variantId === variantId).map((s) => s.netR);
    const n = netRs.length;
    const netAvgR = avg(netRs);
    const wins = netRs.filter((r) => r > 0);
    const losses = netRs.filter((r) => r < 0);
    const wr = n > 0 ? wins.length / n : null;
    const avgWin = avg(wins);
    const avgLoss = avg(losses);
    const payoff = avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;
    console.log(
      `  ${variantId.padEnd(30)} ${String(n).padStart(5)}  ${fmt(netAvgR, 4).padStart(8)}  ` +
        `${(wr !== null ? `${(wr * 100).toFixed(1)}%` : "n/a").padStart(7)}  ${fmt(payoff, 3).padStart(7)}`,
    );
  }

  // ── Task 2 (2026-07-10): production_breakeven_control RECONCILIATION ───────────────────────
  // Compares the simulated production_breakeven_control outcome against each real trade's ACTUAL
  // ground truth. This is a fact-finding report: if the simulator cannot reproduce production
  // behavior within the documented tolerance, that is printed plainly below, not hidden.
  console.log(
    "\n===== production_breakeven_control RECONCILIATION — simulated vs. REAL ground truth (Task 2) =====",
  );
  console.log(`n = ${reconciliationRows.length} (of ${rows.length} successfully-walked real trades)`);

  // -- tradeCountMatch --
  const simResolvedRows = reconciliationRows.filter((r) => r.simGrossR !== null);
  const simUnresolvedIds = reconciliationRows.filter((r) => r.simGrossR === null).map((r) => r.paperOrderId);
  const tradeCountMatch = simResolvedRows.length === reconciliationRows.length;
  console.log("\n-- tradeCountMatch --");
  console.log(
    `  real population: ${reconciliationRows.length}   simulator resolved: ${simResolvedRows.length}   ` +
      `match: ${tradeCountMatch ? "YES" : "NO"}`,
  );
  if (!tradeCountMatch) {
    console.log(`  UNRESOLVED by simulator (excluded from all $ / price stats below): ${simUnresolvedIds.join(", ")}`);
  }

  // -- exitReasonDistribution --
  console.log("\n-- exitReasonDistribution --");
  const realReasonCounts = new Map<string, number>();
  for (const r of reconciliationRows) {
    const key = r.realCloseReason ?? "(null)";
    realReasonCounts.set(key, (realReasonCounts.get(key) ?? 0) + 1);
  }
  console.log("  REAL (closeReason, from the ledger):");
  for (const [reason, count] of [...realReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(45)} ${count}`);
  }
  const simBucket = { firedViaBreakevenControl: 0, stop: 0, tp: 0, maxHoldMtm: 0, other: 0 };
  for (const r of reconciliationRows) {
    if (r.simFiredViaBreakevenControl) simBucket.firedViaBreakevenControl += 1;
    else if (r.simResolutionSource === "CANDLE_WALK_SL" || r.simResolutionSource === "AMBIGUOUS_SL_FIRST") simBucket.stop += 1;
    else if (r.simResolutionSource === "CANDLE_WALK_TP") simBucket.tp += 1;
    else if (r.simResolutionSource === "MAX_HOLD_MTM") simBucket.maxHoldMtm += 1;
    else simBucket.other += 1;
  }
  console.log("  SIMULATED (production_breakeven_control resolutionSource, bucketed):");
  console.log(`    fired via LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST trigger  ${simBucket.firedViaBreakevenControl}`);
  console.log(`    stop-out (SL, incl. same-candle-ambiguous)               ${simBucket.stop}`);
  console.log(`    real TP1 target reached first                           ${simBucket.tp}`);
  console.log(`    MAX_HOLD_MTM fallback (candle window ended)             ${simBucket.maxHoldMtm}`);
  console.log(`    other/unresolved                                        ${simBucket.other}`);

  // -- realTotalNetPnL / simulatedTotalNetPnL / absolutePnLDifference / percentagePnLDifference --
  const realTotalNetPnL = reconciliationRows.reduce((s, r) => s + r.realRealizedPnlUsdShare, 0);
  const simRowsWithPnl = reconciliationRows.filter((r) => r.simPnlUsdShare !== null);
  const simulatedTotalNetPnL = simRowsWithPnl.reduce((s, r) => s + (r.simPnlUsdShare ?? 0), 0);
  const absolutePnLDifference = simulatedTotalNetPnL - realTotalNetPnL;
  const percentagePnLDifference = realTotalNetPnL !== 0 ? (absolutePnLDifference / Math.abs(realTotalNetPnL)) * 100 : null;
  console.log("\n-- realTotalNetPnL / simulatedTotalNetPnL --");
  console.log(`  realTotalNetPnL (USD, sum of real realizedPnlUsd, lane-share-prorated):       ${fmt(realTotalNetPnL, 2)}`);
  console.log(
    `  simulatedTotalNetPnL (USD, sum of sim netR * whole-position riskUsd * laneShare, ` +
      `n=${simRowsWithPnl.length}/${reconciliationRows.length}): ${fmt(simulatedTotalNetPnL, 2)}`,
  );
  console.log(`  absolutePnLDifference (simulated - real): ${fmt(absolutePnLDifference, 2)}`);
  console.log(
    `  percentagePnLDifference: ${percentagePnLDifference === null ? "n/a (real total is 0)" : `${percentagePnLDifference.toFixed(1)}%`}`,
  );

  // -- medianExitPriceDifference / meanExitPriceDifference --
  const priceDiffs = reconciliationRows
    .filter((r) => r.realExitPrice !== null && r.simExitPrice !== null)
    .map((r) => r.simExitPrice! - r.realExitPrice!);
  console.log("\n-- medianExitPriceDifference / meanExitPriceDifference (simulated - real, both directions) --");
  console.log(
    `  n = ${priceDiffs.length}/${reconciliationRows.length} (excludes rows missing a derivable real or simulated exit price)`,
  );
  console.log(`  medianExitPriceDifference: ${fmt(median(priceDiffs), 6)}`);
  console.log(`  meanExitPriceDifference:   ${fmt(avg(priceDiffs), 6)}`);

  // -- mismatchedTradeIds / mismatchReasons --
  const mismatchedRows = reconciliationRows.filter((r) => r.mismatch);
  console.log("\n-- mismatchedTradeIds --");
  console.log(
    `  ${mismatchedRows.length}/${reconciliationRows.length} trades flagged (divergence threshold: classification ` +
      `disagreement OR $ outcome differs by more than max($${PNL_MISMATCH_ABS_FLOOR_USD.toFixed(2)}, ` +
      `${(PNL_MISMATCH_RELATIVE_TOLERANCE * 100).toFixed(0)}% of the real trade's own |$| size) — see constant docs above)`,
  );
  if (mismatchedRows.length > 0) {
    console.log(`  ${mismatchedRows.map((r) => r.paperOrderId).join(", ")}`);
  }

  console.log("\n-- mismatchReasons (tally across mismatched trades only) --");
  const reasonTally = new Map<string, number>();
  for (const r of mismatchedRows) {
    for (const reason of r.mismatchReasons) reasonTally.set(reason, (reasonTally.get(reason) ?? 0) + 1);
  }
  if (reasonTally.size === 0) {
    console.log("  (no mismatches — nothing to categorize)");
  } else {
    for (const [reason, count] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(55)} ${count}`);
    }
  }

  // Whole-population caveat tally (regardless of mismatch) — how much of this reconciliation's
  // confidence is inherently limited by data/modeling gaps, printed honestly rather than buried.
  const caveatCounts = {
    pyramided: reconciliationRows.filter((r) => r.isPyramided).length,
    nettedWithOtherLane: reconciliationRows.filter((r) => r.isNettedWithOtherLane).length,
    realFeeEstimated: reconciliationRows.filter((r) => r.realFeeWasEstimated).length,
    candleGranularityAmbiguous: reconciliationRows.filter((r) => r.simIntrabarStatus === "AMBIGUOUS_SAME_CANDLE_SL_FIRST").length,
    maxHoldMtmProxy: reconciliationRows.filter((r) => r.simResolutionSource === "MAX_HOLD_MTM").length,
  };
  console.log("\n-- whole-population caveat tally (regardless of mismatch status) --");
  console.log(`  pyramided (multi-entry blended cost basis):         ${caveatCounts.pyramided}/${reconciliationRows.length}`);
  console.log(`  netted with another lane on the same symbol:        ${caveatCounts.nettedWithOtherLane}/${reconciliationRows.length}`);
  console.log(`  real fee unavailable (feesUsd null):                ${caveatCounts.realFeeEstimated}/${reconciliationRows.length}`);
  console.log(`  candle-granularity intrabar ambiguity:               ${caveatCounts.candleGranularityAmbiguous}/${reconciliationRows.length}`);
  console.log(`  MAX_HOLD_MTM proxy exit price (not a real fill):    ${caveatCounts.maxHoldMtmProxy}/${reconciliationRows.length}`);

  if (mismatchedRows.length > 0 || !tradeCountMatch) {
    console.log(
      "\n*** HONESTY FLAG: this reconciliation found real divergence between the candle-walk model and " +
        "production ground truth (see mismatchedTradeIds/mismatchReasons above). Per the operator brief: do NOT " +
        "treat the other 6 exit-ablation variants' results as final without accounting for the same candle-walk " +
        "limitations this reconciliation just measured directly against real production behavior — this report " +
        "is the evidence, not a promotion signal. ***",
    );
  } else {
    console.log(
      "\n(No trades were flagged by the divergence threshold above — but see the whole-population caveat tally: " +
        "a small/zero mismatch count does not by itself prove the simulator is unconditionally faithful, only " +
        "that no trade in THIS sample crossed the documented threshold.)",
    );
  }

  // ── PATH CLASSIFICATION report (operator research brief item 2, 2026-07-10) ─────────────────
  console.log("\n===== CG_WIDE_FAST_LONG PATH CLASSIFICATION (operator research brief item 2) =====");
  console.log(
    `n classified = ${classifiedRecords.length} / ${rows.length} successfully-walked trades ` +
      `(skipped: ${classificationSkipped} — missing openedAtMs/closedAtMs on the main walk, should be rare/never for forceCloseAtEnd)`,
  );
  console.log(
    "Thresholds (see cg-wide-fast-long-path-classification.ts for full derivation/reasoning): " +
      `trueExpansionFixedR=${DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.trueExpansionFixedR}R, ` +
      `trueExpansionAtrMultiple=${DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.trueExpansionAtrMultiple}x, ` +
      `toxicReversalAdverseR=${DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.toxicReversalAdverseR}R, ` +
      `toxicReversalEarlyFavorableCeilingR=${DEFAULT_PATH_CLASSIFICATION_THRESHOLDS.toxicReversalEarlyFavorableCeilingR}R`,
  );
  console.log(
    "Precedence: TOXIC_REVERSAL (checked first, chronological) > TRUE_EXPANSION > SCRATCHABLE > DEAD_ON_ARRIVAL",
  );

  const pathClasses: Array<CgWideFastLongClassifiedTradeRecord["pathClass"]> = [
    "DEAD_ON_ARRIVAL",
    "SCRATCHABLE",
    "TRUE_EXPANSION",
    "TOXIC_REVERSAL",
  ];
  console.log("\n-- breakdown by pathClass --");
  for (const pc of pathClasses) {
    const list = classifiedRecords.filter((r) => r.pathClass === pc);
    const pct = classifiedRecords.length > 0 ? (list.length / classifiedRecords.length) * 100 : null;
    const avgRealizedR = avg(list.filter((r) => r.realizedR !== null).map((r) => r.realizedR!));
    const sumUsd = list.reduce((s, r) => s + r.realizedNetPnLUsd, 0);
    console.log(
      `  ${pc.padEnd(18)} n=${String(list.length).padStart(3)}  ${(pct === null ? "n/a" : `${pct.toFixed(1)}%`).padStart(6)}  ` +
        `avgRealizedR=${fmt(avgRealizedR, 3).padStart(7)}  sumRealizedUsd=${fmt(sumUsd, 2).padStart(9)}`,
    );
  }

  console.log("\n-- per-trade records --");
  console.log(
    `  ${"tradeId".padEnd(24)} ${"symbol".padEnd(10)} ${"pathClass".padEnd(16)} ${"maxMfeR".padStart(8)} ${"minMaeR".padStart(8)} ${"realizedR".padStart(9)} ${"entryAlign".padEnd(14)} exitReason`,
  );
  for (const r of classifiedRecords) {
    console.log(
      `  ${r.tradeId.padEnd(24)} ${r.symbol.padEnd(10)} ${r.pathClass.padEnd(16)} ${fmt(r.maxMfeR, 3).padStart(8)} ` +
        `${fmt(r.minMaeR, 3).padStart(8)} ${fmt(r.realizedR, 3).padStart(9)} ${r.entryRegimeAlignment.padEnd(14)} ${r.exitReason ?? "(null)"}`,
    );
  }

  // Persist the full per-trade records as JSON — a derived report artifact (see
  // PATH_CLASSIFICATION_OUTPUT_PATH's doc), useful for the operator brief's follow-on predictor
  // research (item 3) without re-running this whole backfill. Best-effort: a write failure is
  // logged, never thrown (this script's own hard contract is report-only / never throws on I/O).
  try {
    mkdirSync(dirname(PATH_CLASSIFICATION_OUTPUT_PATH), { recursive: true });
    writeFileSync(
      PATH_CLASSIFICATION_OUTPUT_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          lane: TARGET_VARIANT_ID,
          thresholds: DEFAULT_PATH_CLASSIFICATION_THRESHOLDS,
          n: classifiedRecords.length,
          records: classifiedRecords,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`\nPersisted ${classifiedRecords.length} classified trade records to ${PATH_CLASSIFICATION_OUTPUT_PATH}`);
  } catch (err) {
    console.warn(`\n[persist] failed to write ${PATH_CLASSIFICATION_OUTPUT_PATH}: ${(err as Error).message}`);
  }

  console.log(
    "\n[follow-up, not done here] A fuller entry-cohort breakdown (stop-bucket, admission-delay, " +
      "calibration-verdict, etc. — see buildEntryCohortDiagnostic/COHORT_EXTRACTORS in paper-execution-router.ts) " +
      "was considered but not adapted: those extractors are typed against PaperOrder-specific provenance fields " +
      "(o.provenance.*, o.regime, o.plannedStopDistanceBps) that LiveIntent does not carry, so a reuse would mean " +
      "either widening COHORT_EXTRACTORS' input type (risk to its existing PaperOrder callers) or hand-building " +
      "synthetic PaperOrder-shaped objects from LiveIntent (risk of silently-wrong field mapping). Left as a " +
      "documented follow-up rather than forced here; this script's manual symbol/hour breakdown covers the ask.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

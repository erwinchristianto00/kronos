/**
 * Entry Brain (Phase 1, PURE + REPORT-ONLY). Given a valid directional opportunity, decides whether to
 * enter NOW, wait (pullback / breakout / confirmation), or skip — purely on TIMING + microstructure. A
 * correct direction is still rejectable when the entry is poor. Report-only: submits no orders, modifies no
 * pending orders, cannot bypass execution or risk rails.
 *
 * Hard fail-safe rules (verified, deliverable #1):
 *  • A STALE / missing lane signal can NEVER ENTER_NOW (→ SKIP). Signal TTL = the incumbent exec
 *    MAX_SIGNAL_AGE_MS (~50min).
 *  • Invalid stop geometry (missing prices, stop on the wrong side, zero stop distance) → SKIP (fail safe).
 *  • Excessive slippage → SKIP. A null expectedSlippageBps means the book is TOO THIN to fill (the repo's
 *    computeExpectedSlippageBps returns null deliberately) → treat as unhealthy → SKIP, never extrapolate.
 *  • Order-book depth / resting-liquidity is UNAVAILABLE in the repo (no source of truth) → MISSING → the
 *    brain falls back safely (does not fabricate depth, does not require it to enter).
 *
 * Future counterfactual alternatives (documented, NOT wired): {enter now, wait pullback, wait confirmation,
 * skip}. Future evaluation metrics: netR after costs, MAE, slippage, time-to-MFE, stop-out probability,
 * entry efficiency. Target is realized counterfactual netR — never next-candle color.
 */
import {
  clamp01,
  classifySource,
  ENTRY_SCHEMA_VERSION,
  finiteOr,
  fourBrainDecisionId,
  type EntryAction,
  type EntryDecision,
  type EntryOrderType,
  type EntrySide,
  type SourceStatus,
  type SourceStatuses,
  type TaggedSource,
} from "./four-brain-types.js";

/** Round-trip execution cost (bps) for the netR estimate — the repo's REALISTIC 22 bps taker default. */
export const ENTRY_ROUNDTRIP_COST_BPS = 22;
/** Slippage (bps) above which entry is refused outright. */
export const ENTRY_MAX_SLIPPAGE_BPS = 25;

/** Per-source staleness TTLs (ms) for the Entry Brain's microstructure inputs. Order-book-derived reads
 *  (spread/slippage) decay fast; chase geometry (VWAP/extension/pullback) a bit slower. */
export type EntryMicroSourceKey = "distanceFromVwapAtr" | "candleExtensionAtr" | "pullbackDepthAtr" | "spreadBps" | "expectedSlippageBps";
const ENTRY_MICRO_TTL: Record<EntryMicroSourceKey, number> = {
  distanceFromVwapAtr: 10 * 60_000,
  candleExtensionAtr: 10 * 60_000,
  pullbackDepthAtr: 10 * 60_000,
  spreadBps: 5 * 60_000,
  expectedSlippageBps: 5 * 60_000,
};

export interface EntryInput {
  nowMs: number;
  validityMs: number;
  side: EntrySide;

  /** Age of the driving lane signal (ms) + its max allowed age. null age ⇒ no fresh signal (stale). */
  signalAgeMs: number | null;
  maxSignalAgeMs: number;

  /** Geometry (prices). Any missing/invalid ⇒ SKIP (fail-safe). */
  price: number | null;
  targetEntry: number | null;
  invalidationPrice: number | null;
  initialStopPrice: number | null;
  atr?: number | null;

  /** Chase inputs. distanceFromVwapAtr/candleExtensionAtr signed in ATR multiples; pullbackDepthAtr ≥ 0. */
  distanceFromVwapAtr?: TaggedSource;
  candleExtensionAtr?: TaggedSource;
  pullbackDepthAtr?: TaggedSource;
  breakoutConfirmed?: boolean | null;
  volumeConfirmed?: boolean | null;
  /** Candle-data freshness for the microstructure. false ⇒ the candles feeding VWAP/extension/breakout/
   *  volume are STALE, so their confirmation can't be trusted → the Entry Brain must NOT ENTER_NOW.
   *  null/undefined ⇒ no candle adapter wired (microstructure MISSING, not a hard wait). */
  candleFresh?: boolean | null;

  /** Slippage inputs. expectedSlippageBps value=null ⇒ book too thin (unhealthy). */
  spreadBps?: TaggedSource;
  expectedSlippageBps?: TaggedSource;
  /** Order-book depth healthy? UNAVAILABLE in repo ⇒ pass null ⇒ MISSING (not required to enter). */
  bookDepthOk?: boolean | null;

  /** Derivatives crowding context (fail-safe NEUTRAL upstream). */
  crowdingState?: "BUILDING" | "EXHAUSTING" | "UNWINDING" | "NEUTRAL" | null;
  /** Chosen direction's proven edge (R) from the Direction Brain — for the netR estimate. */
  expectedDirectionalR?: number | null;
  roundtripCostBps?: number;
}

function classifySignal(ageMs: number | null, maxMs: number): SourceStatus {
  if (ageMs === null || !Number.isFinite(ageMs)) return "MISSING";
  if (ageMs < 0) return "ERROR"; // future/negative age — causal break
  if (Number.isFinite(maxMs) && maxMs > 0 && ageMs > maxMs) return "STALE";
  return "FRESH";
}

/** True when stop geometry is well-formed for the side (stop on the protective side, non-zero distance). */
function geometryValid(side: EntrySide, entry: number | null, stop: number | null): boolean {
  if (entry === null || stop === null || !Number.isFinite(entry) || !Number.isFinite(stop)) return false;
  if (entry <= 0 || stop <= 0) return false;
  if (side === "LONG" && stop >= entry) return false; // long stop must be BELOW entry
  if (side === "SHORT" && stop <= entry) return false; // short stop must be ABOVE entry
  return Math.abs(entry - stop) > 0;
}

export function decideEntry(input: EntryInput): EntryDecision {
  const nowMs = input.nowMs;
  const st: SourceStatuses = {};
  st.signal = classifySignal(input.signalAgeMs, input.maxSignalAgeMs);
  const signalFresh = st.signal === "FRESH";

  // Route EVERY microstructure TaggedSource through the shared freshness/causal contract (classifySource) —
  // a FUTURE timestamp ⇒ ERROR (unused), a STALE reading ⇒ neutral-filled — exactly like the other brains.
  // Only a FRESH numeric value is used; anything else falls to null (never a stale/future/fabricated number).
  const tagged = (k: EntryMicroSourceKey): number | null => {
    const src = input[k];
    const status = classifySource(src, nowMs, ENTRY_MICRO_TTL[k]);
    st[k] = status;
    return status === "FRESH" && typeof src?.value === "number" ? src.value : null;
  };
  const vwapDist = tagged("distanceFromVwapAtr");
  const extension = tagged("candleExtensionAtr");
  const pullback = tagged("pullbackDepthAtr");
  const spreadBps = tagged("spreadBps");
  const slippageBps = tagged("expectedSlippageBps");
  // expectedSlippageBps value===null means "book too thin to fill" (repo contract) — a distinct signal, but
  // ONLY trustworthy from a FRESH-timestamped reading. classifySource(value=null) ⇒ MISSING, so detect the
  // thin-book case separately, requiring the timestamp to be non-future + within TTL (a stale thin-book read
  // is treated as MISSING slippage, not a hard SKIP).
  const slipSrc = input.expectedSlippageBps;
  const slipTs = slipSrc?.asOfMs;
  // "Book too thin" is a PRESENT, real-time order-book reading whose value is deliberately null — so it must
  // carry a REAL, fresh, non-future timestamp. A null value with NO timestamp is an ABSENT/MISSING source
  // (e.g. the gather never fetched it), NOT a thin book — that falls to the cautious-default slippage path,
  // never a hard SKIP. (Integration bug caught by the Phase-2 dry-run: MISSING was read as thin-book.)
  const slipTimestampFresh =
    typeof slipTs === "number" && Number.isFinite(slipTs) && slipTs <= nowMs + 60_000 && nowMs - slipTs <= ENTRY_MICRO_TTL.expectedSlippageBps;
  const bookTooThin = slipSrc != null && slipSrc.value === null && slipTimestampFresh;
  st.bookDepth = input.bookDepthOk == null ? "MISSING" : "FRESH"; // UNAVAILABLE source → MISSING (not required)

  const reasons: string[] = [];
  const geomOk = geometryValid(input.side, input.targetEntry ?? input.price, input.initialStopPrice);

  // ── Chase risk (0..1): how extended is price in the trade direction ─────────────────────────────
  const dirSign = input.side === "LONG" ? 1 : -1;
  let chaseRisk = 0;
  if (extension !== null) chaseRisk = Math.max(chaseRisk, clamp01(Math.abs(extension) / 3));
  if (vwapDist !== null) chaseRisk = Math.max(chaseRisk, clamp01((dirSign * vwapDist) / 3)); // ran away from fair value in our direction
  if (pullback !== null && pullback > 0.5) chaseRisk *= 0.6; // a real pullback lowers chase risk
  chaseRisk = clamp01(chaseRisk);

  // ── Slippage risk (0..1) ────────────────────────────────────────────────────────────────────────
  let slippageRisk: number;
  if (bookTooThin) {
    slippageRisk = 0.95;
    reasons.push("order book too thin to fill (expectedSlippage=null) → unhealthy");
  } else if (spreadBps === null && slippageBps === null) {
    // BOTH cost inputs MISSING/stale — do NOT fabricate a confident zero-risk read; bias to cautious middle.
    slippageRisk = 0.35;
    reasons.push("slippage/spread MISSING → cautious default risk (no fabricated 0)");
  } else {
    const s = finiteOr(spreadBps, 0) + finiteOr(slippageBps, 0);
    // If exactly one is missing, keep a small uncertainty floor so a half-blind read isn't treated as clean.
    const floor = spreadBps === null || slippageBps === null ? 0.2 : 0;
    slippageRisk = clamp01(Math.max(s / 40, floor)); // ~40bps combined → risk 1
  }

  // ── Action decision tree (fail-safe first) ──────────────────────────────────────────────────────
  const maxSlip = input.roundtripCostBps != null ? Math.max(ENTRY_MAX_SLIPPAGE_BPS, 0) : ENTRY_MAX_SLIPPAGE_BPS;
  let action: EntryAction;
  if (!geomOk) {
    action = "SKIP";
    reasons.push("invalid stop geometry → SKIP (fail-safe)");
  } else if (bookTooThin || (slippageBps !== null && slippageBps > maxSlip)) {
    action = "SKIP";
    reasons.push("excessive slippage → SKIP");
  } else if (!signalFresh) {
    action = "SKIP"; // stale/missing signal can NEVER ENTER_NOW
    reasons.push(`signal ${st.signal} → SKIP (never enter on a non-fresh signal)`);
  } else if (input.candleFresh === false) {
    action = "WAIT_CONFIRMATION"; // stale candle data → cannot confirm the entry → never ENTER_NOW
    reasons.push("candle data STALE → wait for fresh confirmation (never enter on stale candles)");
  } else if (chaseRisk >= 0.9) {
    action = "SKIP"; // excessively extended — skip this opportunity, don't chase
    reasons.push("excessive chase risk → SKIP");
  } else if (chaseRisk >= 0.7) {
    action = "WAIT_PULLBACK";
    reasons.push("price extended (high chase risk) → wait for a pullback");
  } else if (input.breakoutConfirmed === false) {
    action = "WAIT_BREAKOUT";
    reasons.push("breakout not yet confirmed → wait");
  } else if (input.volumeConfirmed === false) {
    action = "WAIT_CONFIRMATION";
    reasons.push("volume not confirmed → wait for confirmation");
  } else {
    action = "ENTER_NOW";
    reasons.push("fresh signal, valid geometry, acceptable chase + slippage");
  }

  // ── Order type ──────────────────────────────────────────────────────────────────────────────────
  const orderType: EntryOrderType =
    action === "ENTER_NOW" ? (slippageRisk < 0.3 ? "MARKET" : "LIMIT") : action === "WAIT_BREAKOUT" ? "STOP_LIMIT" : "LIMIT";

  // ── Prices (fail-safe null when geometry invalid) ───────────────────────────────────────────────
  const targetEntry = geomOk ? (input.targetEntry ?? input.price) : null;
  const initialStopPrice = geomOk ? input.initialStopPrice : null;
  const invalidationPrice = Number.isFinite(input.invalidationPrice as number) ? (input.invalidationPrice as number) : null;

  // ── Expected netR: direction R minus round-trip cost in R (cost/bps ÷ stop-distance-bps) ─────────
  let expectedNetR: number | null = null;
  if (action === "ENTER_NOW" && input.expectedDirectionalR != null && Number.isFinite(input.expectedDirectionalR) && targetEntry && initialStopPrice) {
    const stopDistBps = (Math.abs(targetEntry - initialStopPrice) / targetEntry) * 10_000;
    if (stopDistBps > 0) {
      const costR = (input.roundtripCostBps ?? ENTRY_ROUNDTRIP_COST_BPS) / stopDistBps;
      expectedNetR = input.expectedDirectionalR - costR;
    }
  }

  // ── Confidence ──────────────────────────────────────────────────────────────────────────────────
  let confidence = signalFresh ? clamp01(1 - 0.5 * chaseRisk - 0.5 * slippageRisk) : 0.15;
  if (action === "SKIP") confidence = clamp01(confidence * 0.7 + 0.1);
  confidence = clamp01(confidence);

  return {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    decisionId: fourBrainDecisionId("entry", nowMs, `${input.side}:${action}`),
    asOfMs: nowMs,
    validUntilMs: nowMs + Math.max(0, input.validityMs || 0),
    action,
    side: input.side,
    orderType,
    targetEntry: targetEntry === null ? null : Number(targetEntry),
    invalidationPrice,
    initialStopPrice: initialStopPrice === null ? null : Number(initialStopPrice),
    expectedNetR: expectedNetR === null ? null : Number(expectedNetR),
    chaseRisk,
    slippageRisk,
    confidence,
    reasons,
    sourceStatuses: st,
  };
}

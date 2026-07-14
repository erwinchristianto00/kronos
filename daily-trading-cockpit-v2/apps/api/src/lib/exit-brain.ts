/**
 * Exit Brain (Phase 1, PURE + REPORT-ONLY). Estimates whether an OPEN position still has positive remaining
 * edge or should be reduced / protected / closed. It does NOT claim to predict the exact reversal candle —
 * the goal is to estimate whether expected remaining upside still exceeds expected downside, and to
 * distinguish three separable risks: premature-exit risk, giveback risk, and remaining edge.
 *
 * Hard safety rules (verified, deliverable #1) — enforced here AND by four-brain-invariants:
 *  • The incumbent HARD STOP + KILL SWITCH always OUTRANK the Exit Brain. When either has already fired,
 *    this brain defers to the rail (EXIT_NOW, never HOLD).
 *  • The Exit Brain may NEVER widen a hard stop: any suggestedStop is on the protective side of the
 *    incumbent hard stop (LONG ⇒ ≥ hardStop; SHORT ⇒ ≤ hardStop). It never cancels a kill rail.
 *  • Missing MFE/MAE (null on rescue legs, per the live engine) must never produce NaN — outputs stay null.
 *
 * unrealizedR / mfeR (maxFavorableR) / maeR (maxAdverseR) are all in R = fraction of risk-at-stop, matching
 * the live-execution-engine's manageMfeGiveback hook (deliverable #1). Report-only: mutates nothing.
 *
 * Future counterfactual alternatives (documented, NOT wired): {exit now, hold one more interval, existing
 * TP/SL, trail, scale out}. Future metrics: captured MFE, giveback R, avoided-loss R, premature-exit cost R,
 * netR after costs.
 */
import {
  clamp01,
  EXIT_SCHEMA_VERSION,
  fourBrainDecisionId,
  type ExitAction,
  type ExitDecision,
  type SourceStatuses,
} from "./four-brain-types.js";

export type ExitSide = "LONG" | "SHORT";

export interface ExitInput {
  nowMs: number;
  validityMs: number;
  side: ExitSide;

  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedR: number | null; // R
  mfeR: number | null; // maxFavorableR (R); null on rescue legs / never-hooked intents
  maeR: number | null; // maxAdverseR (R)
  timeInTradeMs?: number | null;
  maxHoldMs?: number | null;

  /** Incumbent hard stop + kill state — the rails that OUTRANK this brain. */
  hardStopPrice: number | null;
  killLatched?: boolean;

  /** Decay / reversal signals (boolean | null; null ⇒ MISSING, never assumed). */
  momentumDecay?: boolean | null;
  volumeExhaustion?: boolean | null;
  divergence?: boolean | null;
  failedNewExtreme?: boolean | null;
  structureBreak?: boolean | null;
  orderFlowReversal?: boolean | null;
  liquidityTargetReached?: boolean | null;
  volTransition?: boolean | null;
  regimeTransition?: boolean | null;
  eventDecay?: boolean | null;
  thesisIntact?: boolean | null;

  scaleOutFraction?: number; // default 0.4
}

/** True when the incumbent hard stop is already breached or the kill switch is latched. */
function hardExitTriggered(input: ExitInput): boolean {
  if (input.killLatched === true) return true;
  const { side, currentPrice, hardStopPrice } = input;
  if (currentPrice == null || hardStopPrice == null || !Number.isFinite(currentPrice) || !Number.isFinite(hardStopPrice)) return false;
  return side === "LONG" ? currentPrice <= hardStopPrice : currentPrice >= hardStopPrice;
}

export function decideExit(input: ExitInput): ExitDecision {
  const nowMs = input.nowMs;
  const st: SourceStatuses = {};
  const reasons: string[] = [];

  // ── Reversal risk (0..1) from the fresh decay signals ───────────────────────────────────────────
  const signals: { key: keyof ExitInput; weight: number }[] = [
    { key: "momentumDecay", weight: 1 },
    { key: "volumeExhaustion", weight: 1 },
    { key: "divergence", weight: 1 },
    { key: "failedNewExtreme", weight: 1 },
    { key: "structureBreak", weight: 1.6 },
    { key: "orderFlowReversal", weight: 1.6 },
    { key: "volTransition", weight: 0.8 },
    { key: "regimeTransition", weight: 1 },
    { key: "eventDecay", weight: 0.8 },
  ];
  let wSum = 0;
  let wTrue = 0;
  for (const s of signals) {
    const val = input[s.key] as boolean | null | undefined;
    if (val == null) {
      st[s.key as string] = "MISSING";
      continue;
    }
    st[s.key as string] = "FRESH";
    wSum += s.weight;
    if (val === true) wTrue += s.weight;
  }
  const thesisIntact = input.thesisIntact;
  st.thesisIntact = thesisIntact == null ? "MISSING" : "FRESH";
  let reversalRisk = wSum > 0 ? wTrue / wSum : 0;
  if (thesisIntact === false) reversalRisk = Math.max(reversalRisk, 0.5);
  reversalRisk = clamp01(reversalRisk);
  const continuationProbability = clamp01((1 - reversalRisk) * (thesisIntact === true ? 1 : thesisIntact === false ? 0.6 : 0.85));

  // ── Giveback (fraction of MFE handed back) — null-safe ──────────────────────────────────────────
  const uR = typeof input.unrealizedR === "number" && Number.isFinite(input.unrealizedR) ? input.unrealizedR : null;
  const mfe = typeof input.mfeR === "number" && Number.isFinite(input.mfeR) ? input.mfeR : null;
  st.unrealizedR = uR === null ? "MISSING" : "FRESH";
  st.mfeR = mfe === null ? "MISSING" : "FRESH";
  st.maeR = input.maeR == null ? "MISSING" : "FRESH";
  let givebackFrac: number | null = null;
  if (uR !== null && mfe !== null && mfe > 0.1) {
    givebackFrac = clamp01((mfe - uR) / mfe);
    if (givebackFrac > 0.5) reasons.push(`giveback risk: handed back ${(givebackFrac * 100).toFixed(0)}% of a ${mfe.toFixed(2)}R peak`);
  }

  // ── edgeRemainingR: rough remaining upside toward a 2R objective, scaled by continuation. Null-safe. ──
  let edgeRemainingR: number | null = null;
  if (uR !== null) {
    edgeRemainingR = Math.max(0, 2 - uR) * continuationProbability - reversalRisk * 0.5;
    edgeRemainingR = Number(edgeRemainingR.toFixed(3));
  }

  const maxHoldExceeded = input.timeInTradeMs != null && input.maxHoldMs != null && input.timeInTradeMs > input.maxHoldMs;

  // ── Action (fail-safe: hard rail first) ─────────────────────────────────────────────────────────
  const hardExit = hardExitTriggered(input);
  let action: ExitAction;
  let exitFraction = 0;
  if (hardExit) {
    action = "EXIT_NOW";
    exitFraction = 1;
    reasons.push("hard stop / kill switch already triggered — Exit Brain defers to the rail");
  } else if (reversalRisk >= 0.7 && (edgeRemainingR === null || edgeRemainingR <= 0)) {
    action = "EXIT_NOW";
    exitFraction = 1;
    reasons.push("high reversal risk with no remaining edge → exit");
  } else if (maxHoldExceeded) {
    action = "EXIT_NOW";
    exitFraction = 1;
    reasons.push("max-hold exceeded → exit");
  } else if (givebackFrac !== null && givebackFrac >= 0.5 && (uR ?? 0) > 0.2) {
    action = reversalRisk >= 0.5 ? "SCALE_OUT" : "TRAIL";
    exitFraction = action === "SCALE_OUT" ? clamp01(input.scaleOutFraction ?? 0.4) : 0;
    reasons.push("banking against giveback while some edge remains");
  } else if (uR !== null && uR >= 1 && reversalRisk >= 0.4) {
    action = "TIGHTEN_STOP";
    reasons.push("in profit with rising reversal risk → tighten");
  } else if (uR !== null && uR >= 0.5 && reversalRisk >= 0.3) {
    action = "MOVE_TO_BREAKEVEN";
    reasons.push("past 0.5R with moderate reversal risk → protect to breakeven");
  } else {
    action = "HOLD";
    reasons.push(
      continuationProbability > 0.6
        ? "remaining edge outweighs reversal risk → hold (premature-exit risk noted)"
        : "no decisive protect/exit trigger → hold",
    );
  }

  // ── suggestedStop: protective side ONLY (never widen the hard stop) ─────────────────────────────
  let suggestedStop: number | null = null;
  let suggestedTrailDistance: number | null = null;
  const entry = typeof input.entryPrice === "number" && Number.isFinite(input.entryPrice) ? input.entryPrice : null;
  const hs = typeof input.hardStopPrice === "number" && Number.isFinite(input.hardStopPrice) ? input.hardStopPrice : null;
  // Number.isFinite, NOT `!= null` — a NaN/Infinity mark-price (fetch gap) must NOT flow into suggestedStop.
  const cp = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice) ? input.currentPrice : null;
  if (action === "MOVE_TO_BREAKEVEN" && entry !== null && hs !== null) {
    // Breakeven, but clamped to never be looser than the incumbent hard stop.
    suggestedStop = input.side === "LONG" ? Math.max(entry, hs) : Math.min(entry, hs);
  } else if (action === "TIGHTEN_STOP" && entry !== null && cp !== null && hs !== null) {
    // Halfway between entry and current price, clamped to the protective side of the hard stop.
    const mid = (entry + cp) / 2;
    suggestedStop = input.side === "LONG" ? Math.max(mid, hs) : Math.min(mid, hs);
  } else if (action === "TRAIL" && cp !== null) {
    // A non-negative trail distance; the actual placement stays with the incumbent trailing logic.
    const dist = entry !== null ? Math.abs(cp - entry) * 0.5 : Math.abs(cp) * 0.01;
    suggestedTrailDistance = Math.max(0, Number(dist.toFixed(8)));
  }

  // Premature-exit vs giveback framing (the three separable risks) always present in reasons.
  if (action !== "HOLD" && action !== "EXIT_NOW" && continuationProbability > 0.6) {
    reasons.push(`premature-exit risk: continuation prob ${continuationProbability.toFixed(2)} still favors staying`);
  }

  return {
    schemaVersion: EXIT_SCHEMA_VERSION,
    decisionId: fourBrainDecisionId("exit", nowMs, `${input.side}:${action}`),
    asOfMs: nowMs,
    validUntilMs: nowMs + Math.max(0, input.validityMs || 0),
    action,
    exitFraction: clamp01(exitFraction),
    edgeRemainingR,
    reversalRisk,
    continuationProbability,
    suggestedStop: suggestedStop === null ? null : Number(suggestedStop),
    suggestedTrailDistance,
    reasons,
    sourceStatuses: st,
  };
}

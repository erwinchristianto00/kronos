/**
 * Direction Brain (Phase 1, PURE + REPORT-ONLY). Estimates whether LONG, SHORT, BOTH, or FLAT is
 * preferable for a given horizon — with THREE INDEPENDENT scores (long / short / flat). Report-only: it
 * opens no trades, mutates no lane eligibility, changes no CORTEX allocation.
 *
 * Hard design rules (verified against the repo, deliverable #1):
 *  • FLAT is a REAL competing baseline, not a fallback — it wins when neither side has clean edge.
 *  • A BULLISH market state must NOT block SHORT; a BEARISH state must NOT block LONG. Market-state bias is
 *    a SOFT nudge to conviction only — never a hard gate (our own measurement: hard regime-gating hurts
 *    every lane; counter-regime shorts are the fades that actually work).
 *  • Independent scores: longScore is built from LONG proven edge + LONG lanes + long conviction; shortScore
 *    from the SHORT side; neither zeroes the other.
 *  • regime-edge-memory VETO_NEGATIVE is a strong PENALTY (proven-negative measured edge) that also lifts
 *    flatScore — but here it is a score input, NOT a hard 0. The hard federated veto lives in CORTEX +
 *    the incumbent rails; this brain only estimates.
 *  • The n=0 "fabricated 0" edge-memory trap is handled UPSTREAM: pass edge as null when n is below the
 *    proven threshold (no proven edge ≠ zero edge). This brain treats a null edge as MISSING, not bearish.
 *
 * SCORING IS DELIBERATELY SIMPLE + REPLACEABLE. The future learned model's TARGET (documented, NOT wired):
 *   counterfactual netR for {long, short, flat} over the horizon, AFTER fees + slippage — NOT next-candle
 *   color (which is noise + look-ahead-prone). The x here (component sub-scores) is journaled so a later
 *   phase can join it to that realized counterfactual, exactly like CORTEX #218.
 */
import {
  classifySource,
  clamp01,
  DIRECTION_SCHEMA_VERSION,
  fourBrainDecisionId,
  type DirectionAction,
  type DirectionDecision,
  type DirectionHorizon,
  type MarketBias,
  type SourceStatuses,
  type TaggedSource,
} from "./four-brain-types.js";

/** Min proven directional edge (R) for a side to be preferred over FLAT. */
export const DIRECTION_EDGE_HURDLE_R = 0.03;
/** Scale that maps an edge in R to a 0..1 sub-score (edge of this size ≈ score 1). */
const EDGE_R_FULL = 0.15;

export interface DirectionInput {
  nowMs: number;
  validityMs: number;
  horizon: DirectionHorizon;

  /** Market-state context (from the Market State Brain). SOFT — nudges conviction, never gates. */
  marketBias: MarketBias;
  transitionRisk: number; // 0..1

  /** Proven regime×direction edge (R, net of cost). NULL when n < proven threshold (never a fabricated 0). */
  longEdge: TaggedSource;
  shortEdge: TaggedSource;
  /** True when edge-memory verdict is VETO_NEGATIVE (proven-negative, no positive-lane rescue). Penalty, not a gate. */
  longVeto?: boolean;
  shortVeto?: boolean;
  /** True when the FOUR-BRAIN layer's OWN self-referential edge memory (four-brain-edge-memory.ts,
   *  fourBrainEdgeVerdict) reports VETO_NEGATIVE for this side — i.e. the Direction Brain's OWN past
   *  LONG/SHORT calls for this horizon have themselves proven net-negative (n >= MIN_SAMPLES). A SECOND,
   *  independent soft penalty stacked next to longVeto/shortVeto (the incumbent engine's edge-memory) —
   *  never a hard gate; see the score blocks below. */
  fourBrainLongVeto?: boolean;
  fourBrainShortVeto?: boolean;

  /** The graduated controller's directional conviction (0..1) + which sides its posture leans to (SOFT). */
  conviction: TaggedSource; // 0..1
  controllerBias?: "LONG" | "SHORT" | "NEUTRAL" | "MIXED" | "UNKNOWN";
  leansLong?: boolean; // controller posture allows/prefers long — a soft discount when false, never a zero
  leansShort?: boolean;

  /** Best FRESH per-direction LANE edge (R) the incumbent engine is currently measuring (independent of edge-memory). */
  longLaneEdge?: TaggedSource;
  shortLaneEdge?: TaggedSource;

  /** Optional confirmations: −1..+1 directional agreement. Often MISSING (kronos ~55%). */
  kronosAgree?: TaggedSource;
  crowdingAlignLong?: TaggedSource; // −1..+1, aligned to LONG (short = −this)

  ttls?: Partial<Record<DirectionSourceKey, number>>;
  hurdleR?: number;
}

export type DirectionSourceKey =
  | "longEdge" | "shortEdge" | "conviction" | "longLaneEdge" | "shortLaneEdge" | "kronosAgree" | "crowdingAlignLong";

const DEFAULT_TTL: Record<DirectionSourceKey, number> = {
  longEdge: 24 * 60 * 60_000, // edge-memory refreshes on closes; slow
  shortEdge: 24 * 60 * 60_000,
  conviction: 30 * 60_000,
  longLaneEdge: 24 * 60 * 60_000,
  shortLaneEdge: 24 * 60 * 60_000,
  kronosAgree: 15 * 60_000,
  crowdingAlignLong: 15 * 60_000,
};

const edgeSub = (r: number | null): number => (r === null ? 0 : clamp01(r / EDGE_R_FULL)); // only POSITIVE edge scores; negative → 0

export function decideDirection(input: DirectionInput): DirectionDecision {
  const nowMs = input.nowMs;
  const ttls = { ...DEFAULT_TTL, ...(input.ttls ?? {}) };
  const st: SourceStatuses = {};
  const fresh = (k: DirectionSourceKey): number | null => {
    const s = classifySource(input[k] as TaggedSource | undefined, nowMs, ttls[k]);
    st[k] = s;
    return s === "FRESH" && typeof (input[k] as TaggedSource | undefined)?.value === "number" ? ((input[k] as TaggedSource).value as number) : null;
  };
  const longEdge = fresh("longEdge");
  const shortEdge = fresh("shortEdge");
  const conviction = fresh("conviction");
  const longLaneEdge = fresh("longLaneEdge");
  const shortLaneEdge = fresh("shortLaneEdge");
  const kronos = fresh("kronosAgree");
  const crowdLong = fresh("crowdingAlignLong");

  const supporting: string[] = [];
  const conflicting: string[] = [];
  const hurdle = Number.isFinite(input.hurdleR as number) ? (input.hurdleR as number) : DIRECTION_EDGE_HURDLE_R;

  // ── Independent LONG score ──────────────────────────────────────────────────────────────────────
  let longScore = 0;
  {
    const parts: number[] = [];
    parts.push(edgeSub(longEdge)); // proven edge-memory (R)
    if (longLaneEdge !== null) parts.push(edgeSub(longLaneEdge));
    if (conviction !== null && input.controllerBias === "LONG") parts.push(clamp01(conviction));
    if (kronos !== null) parts.push(clamp01((kronos + 1) / 2)); // −1..1 → 0..1, only the long-agreeing part
    if (crowdLong !== null) parts.push(clamp01((crowdLong + 1) / 2));
    longScore = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    if (input.marketBias === "BULLISH") longScore = clamp01(longScore + 0.05); // SOFT nudge only
    if (input.leansLong === false) longScore *= 0.7; // soft posture discount — NOT a zero
    if (input.longVeto) {
      longScore *= 0.25; // proven-negative penalty
      conflicting.push("LONG proven-negative edge (edge-memory VETO)");
    }
    if (input.fourBrainLongVeto) {
      longScore *= 0.5; // second, independent proven-negative penalty (four-brain's own self-outcome memory)
      conflicting.push("LONG proven-negative (Four-Brain self-outcome VETO)");
    }
    longScore = clamp01(longScore);
    if (longEdge !== null && longEdge > hurdle) supporting.push(`LONG proven edge ${longEdge.toFixed(3)}R`);
  }

  // ── Independent SHORT score (a bullish state does NOT suppress this) ─────────────────────────────
  let shortScore = 0;
  {
    const parts: number[] = [];
    parts.push(edgeSub(shortEdge));
    if (shortLaneEdge !== null) parts.push(edgeSub(shortLaneEdge));
    if (conviction !== null && input.controllerBias === "SHORT") parts.push(clamp01(conviction));
    if (kronos !== null) parts.push(clamp01((-kronos + 1) / 2)); // short-agreeing part
    if (crowdLong !== null) parts.push(clamp01((-crowdLong + 1) / 2));
    shortScore = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    if (input.marketBias === "BEARISH") shortScore = clamp01(shortScore + 0.05);
    if (input.leansShort === false) shortScore *= 0.7;
    if (input.shortVeto) {
      shortScore *= 0.25;
      conflicting.push("SHORT proven-negative edge (edge-memory VETO)");
    }
    if (input.fourBrainShortVeto) {
      shortScore *= 0.5; // second, independent proven-negative penalty (four-brain's own self-outcome memory)
      conflicting.push("SHORT proven-negative (Four-Brain self-outcome VETO)");
    }
    shortScore = clamp01(shortScore);
    if (shortEdge !== null && shortEdge > hurdle) supporting.push(`SHORT proven edge ${shortEdge.toFixed(3)}R`);
    if (input.marketBias === "BULLISH" && shortScore > 0.4) supporting.push("SHORT retained despite BULLISH state (no hard regime gate)");
  }

  // ── FLAT baseline (a REAL competitor) ───────────────────────────────────────────────────────────
  // FLAT is strong when: neither side clears the hurdle, both edges MISSING, or transition risk is high.
  let flatScore = 0.35; // baseline presence
  const bothMissing = longEdge === null && shortEdge === null;
  if (bothMissing) {
    flatScore = Math.max(flatScore, 0.6);
    supporting.push("no proven directional edge either side → FLAT baseline");
  }
  flatScore = Math.max(flatScore, clamp01(input.transitionRisk) * 0.8); // high transition risk favors standing aside
  const bestDir = Math.max(longScore, shortScore);
  flatScore = clamp01(Math.max(flatScore, 1 - bestDir - 0.1)); // as directional conviction rises, flat recedes
  if (input.longVeto && input.shortVeto) flatScore = Math.max(flatScore, 0.8);

  // ── Action ──────────────────────────────────────────────────────────────────────────────────────
  const longClears = longScore > flatScore && longEdge !== null && longEdge > hurdle;
  const shortClears = shortScore > flatScore && shortEdge !== null && shortEdge > hurdle;
  let action: DirectionAction;
  if (longClears && shortClears && Math.abs(longScore - shortScore) < 0.2 && Math.min(longScore, shortScore) >= 0.5) {
    action = "BOTH"; // genuinely independent two-sided opportunity (repo has both long + short lanes)
    supporting.push("independent two-sided edge → BOTH");
  } else if (longClears && longScore >= shortScore) {
    action = "LONG";
  } else if (shortClears && shortScore > longScore) {
    action = "SHORT";
  } else {
    action = "FLAT";
    if (!bothMissing) supporting.push("neither side clears the FLAT baseline");
  }

  // expectedDirectionalR: the chosen side's proven edge (R), else null. FLAT/BOTH → null (no single R).
  const expectedDirectionalR = action === "LONG" ? longEdge : action === "SHORT" ? shortEdge : null;

  // confidence: separation between the winner and the runner-up + fresh-source coverage.
  const scores = [longScore, shortScore, flatScore].sort((a, b) => b - a);
  const separation = scores[0]! - scores[1]!;
  const freshCount = Object.values(st).filter((s) => s === "FRESH").length;
  let confidence = clamp01(0.5 * separation + 0.5 * (freshCount / Object.keys(DEFAULT_TTL).length));
  if (conflicting.length > 0) confidence *= 0.8; // conflicting signals reduce confidence
  confidence = clamp01(confidence);

  const validUntilMs = nowMs + Math.max(0, input.validityMs || 0);
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    decisionId: fourBrainDecisionId("dir", nowMs, `${input.horizon}:${action}`),
    asOfMs: nowMs,
    validUntilMs,
    horizon: input.horizon,
    action,
    longScore: clamp01(longScore),
    shortScore: clamp01(shortScore),
    flatScore: clamp01(flatScore),
    confidence,
    expectedDirectionalR: expectedDirectionalR === null ? null : Number(expectedDirectionalR),
    supportingSignals: supporting,
    conflictingSignals: conflicting,
    sourceStatuses: st,
  };
}

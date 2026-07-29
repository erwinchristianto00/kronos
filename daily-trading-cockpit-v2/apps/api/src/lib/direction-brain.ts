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
  /** Sample count behind longEdge/shortEdge. Absence of evidence (n===0, or n below
   *  DIRECTION_EDGE_MIN_SAMPLES) must NOT be treated as evidence of absence — see edgeStanding().
   *  Undefined = caller didn't supply a count; the edge is then treated as UNPROVEN regardless of value,
   *  which is the conservative reading (an R with unknown sample size proves nothing). */
  longEdgeN?: number | null;
  shortEdgeN?: number | null;
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
  /** How many outcomes THIS horizon has ever resolved. An explicit 0 means the horizon has never
   *  learned anything and unlocks cold-start exploration (see coldStart below) — without it a fresh
   *  horizon can only ever emit FLAT, because neither side can be PROVEN_ anything and an unmeasured
   *  side scores 0 against a FLAT baseline that floors at 0.6. undefined = "caller does not track
   *  this", which preserves every pre-2026-07-28 behaviour including FLAT-as-a-real-baseline. */
  horizonResolvedN?: number | null;

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
  /** Independent CPU challenger forecasts. Advisory only; missing means no opinion, never neutral. */
  chronos2Agree?: TaggedSource;
  timesfmAgree?: TaggedSource;
  crowdingAlignLong?: TaggedSource; // −1..+1, aligned to LONG (short = −this)

  ttls?: Partial<Record<DirectionSourceKey, number>>;
  hurdleR?: number;
}

export type DirectionSourceKey =
  | "longEdge" | "shortEdge" | "conviction" | "longLaneEdge" | "shortLaneEdge"
  | "kronosAgree" | "chronos2Agree" | "timesfmAgree" | "crowdingAlignLong";

const DEFAULT_TTL: Record<DirectionSourceKey, number> = {
  longEdge: 24 * 60 * 60_000, // edge-memory refreshes on closes; slow
  shortEdge: 24 * 60 * 60_000,
  conviction: 30 * 60_000,
  longLaneEdge: 24 * 60 * 60_000,
  shortLaneEdge: 24 * 60 * 60_000,
  kronosAgree: 15 * 60_000,
  chronos2Agree: 20 * 60_000,
  timesfmAgree: 20 * 60_000,
  crowdingAlignLong: 15 * 60_000,
};

const edgeSub = (r: number | null): number => (r === null ? 0 : clamp01(r / EDGE_R_FULL)); // only POSITIVE edge scores; negative → 0

/** Minimum resolved same-slice samples before an edge R is allowed to PROVE anything (either way).
 *  Reuses regime-edge-memory.ts's EDGE_MIN_SAMPLES verbatim — the same "proven" bar the incumbent
 *  smart-direction-gate uses, so the two layers can never disagree about what counts as proof. */
/*  Declared as a literal rather than imported: regime-edge-memory.ts is a file-backed STORE, and this
 *  brain is a pure core that must not pull I/O into its import graph (four-brain-architecture.test.ts
 *  enforces that). direction-brain.test.ts asserts this stays equal to EDGE_MIN_SAMPLES, so the two can
 *  never silently drift — the same local-const + equality-test idiom used for
 *  DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE vs CORTEX_ATTR_MIN_EXAMPLES_ACTIVE. */
export const DIRECTION_EDGE_MIN_SAMPLES = 30;

export type EdgeStanding = "PROVEN_ABOVE" | "PROVEN_BELOW" | "UNPROVEN";
/** 2026-07-25: absence of evidence is NOT evidence of absence. Before this, the action gate read
 *  `edge !== null && edge > hurdle`, which collapsed three genuinely different states into two and made
 *  one side structurally unreachable: on testnet the edge-memory store held exactly two slices
 *  (BULLISH×LONG n=15 +0.051, BEARISH×SHORT n=4 −0.274), so SHORT was null in bullish regimes (no data)
 *  and negative in bearish ones — it could never clear under ANY market condition, and the measured
 *  record showed SHORT n=0 across 1865 evaluated decisions while LONG went 126. A side must be blocked
 *  only by PROVEN-negative evidence; an unmeasured (or thin-sample) side stays eligible and competes on
 *  score alone, where flatScore's own bothMissing floor (0.6) still makes it earn the decision. */
function edgeStanding(edge: number | null, n: number | null | undefined, hurdle: number): EdgeStanding {
  if (edge === null || n == null || !Number.isFinite(n) || n < DIRECTION_EDGE_MIN_SAMPLES) return "UNPROVEN";
  return edge > hurdle ? "PROVEN_ABOVE" : "PROVEN_BELOW";
}

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
  const chronos2 = fresh("chronos2Agree");
  const timesfm = fresh("timesfmAgree");
  const crowdLong = fresh("crowdingAlignLong");

  // Challenger models get a deliberately smaller contribution than Kronos. They are new
  // on this venue and have no authority to reverse a proven incumbent edge by themselves.
  const challengerLong = (value: number): number => clamp01(0.5 + 0.25 * value);
  const challengerShort = (value: number): number => clamp01(0.5 - 0.25 * value);

  const supporting: string[] = [];
  const conflicting: string[] = [];
  /** 2026-07-26 — report-only conflicts, deliberately kept OUT of the confidence damping below.
   *
   *  `confidence` is damped by `conflicting.length > 0`. Pushing the newly-reported regime-posture
   *  haircuts straight into `conflicting` would therefore have silently moved a numeric output while
   *  the stated goal was pure observability, and it would have confounded the SHORT-reachability
   *  measurement currently running on 3101/3102 (the damping would kick in on nearly every tick,
   *  since one side is almost always off-posture). They are merged into conflictingSignals at the
   *  return so operators see them, but confidence keeps its exact prior semantics. Damping them is
   *  arguably more correct and can be adopted later — as its own change, with its own before/after. */
  const reportOnlyConflicts: string[] = [];
  const hurdle = Number.isFinite(input.hurdleR as number) ? (input.hurdleR as number) : DIRECTION_EDGE_HURDLE_R;

  // ── Independent LONG score ──────────────────────────────────────────────────────────────────────
  let longScore = 0;
  {
    const parts: number[] = [];
    // NOTE: pushed UNCONDITIONALLY (edgeSub(null) === 0) and that is deliberate. Omitting the term for an
    // unmeasured side was tried on 2026-07-25 and reverted: averaging over the remaining sub-signals
    // INFLATES a side with no evidence above one with good measured evidence (it broke "BULLISH does not
    // block SHORT when short edge is strong" by handing the decision to a no-edge LONG on conviction
    // alone). Absence of edge should not boost a side — the structural unreachability it used to cause is
    // fixed at the ACTION GATE instead, via edgeStanding(), where absence stops being disqualifying.
    parts.push(edgeSub(longEdge)); // proven edge-memory (R)
    if (longLaneEdge !== null) parts.push(edgeSub(longLaneEdge));
    if (conviction !== null && input.controllerBias === "LONG") parts.push(clamp01(conviction));
    if (kronos !== null) parts.push(clamp01((kronos + 1) / 2)); // −1..1 → 0..1, only the long-agreeing part
    if (chronos2 !== null) parts.push(challengerLong(chronos2));
    if (timesfm !== null) parts.push(challengerLong(timesfm));
    if (crowdLong !== null) parts.push(clamp01((crowdLong + 1) / 2));
    longScore = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    if (input.marketBias === "BULLISH") longScore = clamp01(longScore + 0.05); // SOFT nudge only
    if (input.leansLong === false) {
      longScore *= 0.7; // soft posture discount — NOT a zero
      // 2026-07-26: this discount used to be applied SILENTLY. It is frequently the single largest
      // suppressor of a side (a flat 30% haircut), yet nothing was pushed to conflicting[], so the
      // payload showed conflictingSignals: [] while the haircut was fully active — the dominant
      // reason for a FLAT was invisible to the operator and to every downstream consumer. Reported
      // on BOTH sides; the SHORT twin below was found first, but the LONG one was equally silent.
      reportOnlyConflicts.push("LONG discounted 30% — regime controller posture does not lean LONG");
    }
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
    parts.push(edgeSub(shortEdge)); // unconditional — see the LONG block's note
    if (shortLaneEdge !== null) parts.push(edgeSub(shortLaneEdge));
    if (conviction !== null && input.controllerBias === "SHORT") parts.push(clamp01(conviction));
    if (kronos !== null) parts.push(clamp01((-kronos + 1) / 2)); // short-agreeing part
    if (chronos2 !== null) parts.push(challengerShort(chronos2));
    if (timesfm !== null) parts.push(challengerShort(timesfm));
    if (crowdLong !== null) parts.push(clamp01((-crowdLong + 1) / 2));
    shortScore = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    if (input.marketBias === "BEARISH") shortScore = clamp01(shortScore + 0.05);
    if (input.leansShort === false) {
      shortScore *= 0.7; // see the LONG twin above — same discount, same reporting obligation
      reportOnlyConflicts.push("SHORT discounted 30% — regime controller posture does not lean SHORT");
    }
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
  // A side is barred ONLY by proven-negative evidence. UNPROVEN (no data, or n < DIRECTION_EDGE_MIN_SAMPLES)
  // still competes — it just has to beat flatScore, which the bothMissing floor already raises to 0.6.
  const longStanding = edgeStanding(longEdge, input.longEdgeN, hurdle);
  const shortStanding = edgeStanding(shortEdge, input.shortEdgeN, hurdle);
  /**
   * EXPLORATION PASS (2026-07-28) — the repair the LONG block's note promised but never delivered.
   *
   * `edgeSub(null) === 0` is deliberate and stays: omitting the term for an unmeasured side was
   * tried on 2026-07-25 and reverted because averaging over the survivors INFLATES a no-evidence
   * side above a measured-good one. That note then says the "structural unreachability it used to
   * cause is fixed at the ACTION GATE instead, via edgeStanding()". It is not: edgeStanding only
   * stops absence from DISQUALIFYING a side, while the gate below still requires
   * `score > flatScore`, and a side whose only sub-signal is edgeSub(null) scores 0 against a FLAT
   * baseline of 0.35 (0.6 when both edges are missing). Absence was non-disqualifying and still
   * unreachable.
   *
   * Measured consequence on the live store: SHORT has produced **ZERO decisions in this store's
   * entire life**, while LONG sits at n=305 / −0.475R. SHORT cannot score without an edge, and
   * cannot acquire an edge without ever being chosen. A closed loop, not a verdict.
   *
   * So a side may also clear when it is UNPROVEN and the opposite side is PROVEN_BELOW: the only
   * MEASURED alternative has been proven bad, and standing aside forever then means never learning
   * whether the other direction works. This is the "exploration of ONE under-measured direction"
   * the BOTH-gate comment below already describes as the intent.
   *
   * Deliberately narrow, and it cannot reopen the 2026-07-25 regression:
   *   • never fires while the opposite side is PROVEN_ABOVE — a strong measured side still wins;
   *   • never fires when both sides are UNPROVEN — with no information either way, FLAT is right;
   *   • never fires against a veto, and PROVEN_BELOW still bars the side outright;
   *   • BOTH is untouched: it requires both sides PROVEN_ABOVE, so exploration can never open two.
   */
  /**
   * COLD START (2026-07-28, same day, second pass). The rule below opens exploration when the
   * OPPOSITE side is PROVEN_BELOW — which unlocked SHORT on INTRADAY, where LONG was measured at
   * -0.475R. It cannot unlock anything on a horizon that has never resolved a single outcome,
   * because nothing there can be PROVEN_ anything. Enabling SCALP the same day proved it: 376 SCALP
   * decisions, 376 of them FLAT, and no path out — never non-FLAT, so never any evidence, so never
   * proven, so never non-FLAT. Exactly the deadlock this exploration pass was written to end,
   * recreated on a fresh horizon.
   *
   * The earlier reasoning — "with no information either way, FLAT is right" — is true of a mature
   * horizon and false of a newborn one, where it guarantees the newborn stays newborn.
   *
   * So a horizon that has resolved NOTHING may compete on the evidence it does have (lane edge,
   * conviction, kronos, crowding — the sub-signals that are not edge-memory). Requires an EXPLICIT
   * zero: `horizonResolvedN` undefined means "the caller does not track this", which keeps every
   * existing behaviour, including FLAT-as-a-real-baseline when both edges are simply missing on a
   * mature horizon. The 2026-07-25 regression is untouched — a side with a measured edge makes this
   * false, so a no-evidence side still cannot outrank a measured-good one.
   */
  /* Keyed ONLY on the horizon's own resolved count. The first attempt also demanded both edges be
   * null, which never held and so never fired: edge-memory is scoped by REGIME and shared across
   * every horizon, so a newborn horizon inherits readings like "SHORT -0.274R at n=4" from decisions
   * taken elsewhere. Those are not this horizon's evidence, and they are exactly what the deadlock
   * hides behind — sub-threshold numbers that prove nothing yet still make the side look measured.
   * PROVEN_BELOW still bars a side outright below, so an inherited edge that IS conclusive keeps its
   * veto. */
  const coldStart = input.horizonResolvedN === 0;
  if (coldStart) supporting.push("horizon has resolved nothing yet → cold-start exploration (not conviction)");
  const explorationOpen = (self: EdgeStanding, other: EdgeStanding): boolean =>
    (self === "UNPROVEN" && other === "PROVEN_BELOW") || (coldStart && self === "UNPROVEN");
  const longExplores =
    explorationOpen(longStanding, shortStanding) && !input.longVeto && !input.fourBrainLongVeto;
  const shortExplores =
    explorationOpen(shortStanding, longStanding) && !input.shortVeto && !input.fourBrainShortVeto;
  if (longExplores) supporting.push("LONG unmeasured while SHORT is proven-below → exploration pass (not conviction)");
  if (shortExplores) supporting.push("SHORT unmeasured while LONG is proven-below → exploration pass (not conviction)");
  const longClears = (longScore > flatScore || longExplores) && longStanding !== "PROVEN_BELOW";
  const shortClears = (shortScore > flatScore || shortExplores) && shortStanding !== "PROVEN_BELOW";
  // 2026-07-26: report evidence standing UNCONDITIONALLY. The UNPROVEN notes below used to be gated
  // on `&& xClears`, i.e. announced only when the thin evidence did NOT bind, and silent in exactly
  // the case an operator needs to see — a side sitting on real but sub-threshold evidence that never
  // gets to matter. Observed on 3101: the store held BULLISH_EXPANSION::LONG at −1.055R over n=2, so
  // a catastrophically negative measured edge produced NO signal of any kind (conflictingSignals was
  // literally []), because n=2 < DIRECTION_EDGE_MIN_SAMPLES makes it UNPROVEN and UNPROVEN was mute.
  // "No slice at all" and "a slice too thin to prove anything" are also genuinely different states
  // and are now distinguished. Purely additive reporting — no threshold and no score changes here.
  const sampleNote = (n: number | null | undefined): string =>
    n == null || !Number.isFinite(n) ? "n=?" : `n=${n} < ${DIRECTION_EDGE_MIN_SAMPLES}`;
  if (longStanding === "UNPROVEN") {
    supporting.push(
      longEdge === null
        ? "LONG edge UNMEASURED (no edge-memory slice for this regime) — competing on score alone"
        : `LONG edge UNPROVEN: ${longEdge.toFixed(3)}R at ${sampleNote(input.longEdgeN)} — not proof either way, competing on score alone`,
    );
  }
  if (shortStanding === "UNPROVEN") {
    supporting.push(
      shortEdge === null
        ? "SHORT edge UNMEASURED (no edge-memory slice for this regime) — competing on score alone"
        : `SHORT edge UNPROVEN: ${shortEdge.toFixed(3)}R at ${sampleNote(input.shortEdgeN)} — not proof either way, competing on score alone`,
    );
  }
  if (longStanding === "PROVEN_BELOW") conflicting.push(`LONG proven at/below hurdle (${(longEdge as number).toFixed(3)}R ≤ ${hurdle}R)`);
  if (shortStanding === "PROVEN_BELOW") conflicting.push(`SHORT proven at/below hurdle (${(shortEdge as number).toFixed(3)}R ≤ ${hurdle}R)`);
  let action: DirectionAction;
  // BOTH is the most committing action (two simultaneous directional positions), so it keeps the STRICT
  // bar: both sides must be PROVEN_ABOVE. Relaxing the gate to let unmeasured sides compete is meant to
  // enable exploration of ONE under-measured direction — never to open two positions on absent evidence.
  const bothProven = longStanding === "PROVEN_ABOVE" && shortStanding === "PROVEN_ABOVE";
  if (bothProven && longClears && shortClears && Math.abs(longScore - shortScore) < 0.2 && Math.min(longScore, shortScore) >= 0.5) {
    action = "BOTH"; // genuinely independent two-sided opportunity (repo has both long + short lanes)
    supporting.push("independent two-sided edge → BOTH");
    // 2026-07-28: compare only among sides that actually CLEARED. These used to read
    // `longClears && longScore >= shortScore` / `shortClears && shortScore > longScore`, which let a
    // side that did NOT clear still veto the one that did, purely by out-scoring it — so a cleared
    // side could lose to a barred one and the action fell through to FLAT. That silently cancelled
    // the exploration pass above (an exploring side scores 0 by construction, since its only
    // sub-signal is edgeSub(null)), and it was already wrong on its own terms. Behaviour when BOTH
    // clear is unchanged: higher score wins, ties go LONG.
  } else if (longClears && (!shortClears || longScore >= shortScore)) {
    action = "LONG";
  } else if (shortClears) {
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
  // An unavailable challenger is not adverse evidence and must not lower the
  // legacy model's confidence merely because the feature was added. It enters
  // coverage only once it supplies a fresh directional opinion.
  const activeSourceCount = Object.keys(DEFAULT_TTL).length
    - (chronos2 === null ? 1 : 0)
    - (timesfm === null ? 1 : 0);
  let confidence = clamp01(0.5 * separation + 0.5 * (freshCount / activeSourceCount));
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
    conflictingSignals: [...conflicting, ...reportOnlyConflicts],
    sourceStatuses: st,
  };
}

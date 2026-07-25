/**
 * GEOPOLITICAL ESCALATION CLASSIFIER (report-only; combines a deterministic quantitative score with
 * an OPTIONAL, strictly-bounded LLM corroboration read).
 *
 * WHAT THIS IS: a second layer on top of lib/geopolitical-conflict-feed.ts's computeConflictIntensity.
 * That module aggregates raw GDELT events into { eventCount, meanGoldstein, highSeverityCount }. This
 * module turns that aggregate into a 0-100 escalationScore, and — optionally — asks an LLM
 * (lib/nvidia-chat-client.ts's requestChatCompletion) to read the same recent headline/event text and
 * return a structured severity opinion, purely as a secondary corroboration/audit signal.
 *
 * PRIMARY vs SECONDARY (the whole point of this module, read carefully):
 *   - computeEscalationScore is PURE and is the PRIMARY signal: zero network/LLM calls, a fixed
 *     documented formula over named constants (DEFAULT_ESCALATION_SCORE_PARAMS below), fully
 *     reproducible from computeConflictIntensity's output alone.
 *   - requestLlmCorroboration is the ONLY I/O in this module. It is SECONDARY and PURELY ADVISORY:
 *     classifyEscalation's finalScore is ALWAYS derived from the quantitative score as a CEILING —
 *     the LLM can only ever (a) lower the final score when it reads the supplied text as LESS severe
 *     than the quantitative signal suggests, confidence-weighted and capped, or (b) supply the
 *     human-readable `reasoning` string for the audit trail. It can NEVER raise the score above the
 *     quantitative ceiling, and an LLM failure/timeout/malformed-output NEVER counts as evidence of
 *     escalation — it just falls back to the quantitative-only score (llmAvailable:false). This
 *     mirrors exit-brain-policy.ts's R0_INVALID_FEATURES convention: a scorer that cannot see (or
 *     that returned garbage) does nothing extra, it never fabricates severity in either direction.
 *
 * ACTION GATE (deliberate deviation from this repo's usual per-lane `_DISABLED`-default-running
 * kill switch — documented explicitly, per house convention, same as geopolitical-conflict-feed.ts's
 * own documented deviation the other direction): GEOPOLITICAL_ESCALATION_LLM_ENABLED gates
 * requestLlmCorroboration's outbound network call and defaults to **disabled** (safe state = no LLM
 * call, quantitative-only). Unlike the passive GDELT collector, this function places a real outbound
 * paid API call built from third-party headline text (a prompt-injection surface) — that is an
 * ACTION, not passive collection, so it follows the repo's explicit-opt-in action-gate convention
 * ("an explicit ENABLED flag, default false, must be flipped for any part of this to have real
 * effect") rather than the passive-collection kill-switch convention. computeEscalationScore and
 * classifyEscalation themselves have no gate — they are pure functions and always safe to call; only
 * the network call is gated.
 *
 * Every score this module produces is fully inspectable: computeEscalationScore returns per-component
 * point breakdowns plus a reasoning trail, and classifyEscalation's reasoning[] documents exactly what
 * the LLM said (if anything) and whether/why it moved the final number — no black-box scores.
 */
import type { ConflictIntensity, GdeltEvent } from "./geopolitical-conflict-feed.js";
import { requestChatCompletion, type ChatMessage, type NvidiaChatConfig } from "./nvidia-chat-client.js";

function finiteNonNegative(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// ── quantitative scoring (pure, primary signal) ─────────────────────────────

/**
 * One exported tunable-constants object (mirrors exit-brain-policy.ts's DEFAULT_EXIT_BRAIN_PARAMS
 * style) — every threshold used by computeEscalationScore lives here as a named, documented field.
 * No magic numbers appear in the scoring function body; they all resolve to a field on this object.
 * Weights sum to exactly 100 (30 + 40 + 30) so the raw score is naturally in [0, 100] before the
 * defensive clamp. Values are documented judgment calls, NOT fitted to any sample.
 */
export interface EscalationScoreParams {
  /** Max points contributed by raw in-window event COUNT (volume of chatter/activity). */
  eventCountWeight: number;
  /** Event count at which the event-count component saturates (reaches eventCountWeight). Linear
   *  ramp from 0 events → 0 points to this count → full weight; never exceeds the weight beyond it. */
  eventCountSaturation: number;
  /** Max points contributed by HIGH-SEVERITY event count (CAMEO roots 09-20 — see
   *  geopolitical-conflict-feed.ts's isHighSeverityCameo). This is the single largest weight because
   *  a handful of high-severity events matters more than a large volume of routine chatter. */
  highSeverityWeight: number;
  /** High-severity count at which that component saturates. */
  highSeveritySaturation: number;
  /** Max points contributed by the mean Goldstein Scale tone of in-window events. */
  goldsteinWeight: number;
  /** The most-conflictual Goldstein Scale value (fixed at −10 by the Goldstein Scale's own
   *  definition — see geopolitical-conflict-feed.ts's module header) used to normalize meanGoldstein
   *  into a [0,1] conflict fraction: meanGoldstein === goldsteinFloor → full goldsteinWeight;
   *  meanGoldstein >= 0 (neutral..cooperative) → 0 points. NOT a magic number: it is the Goldstein
   *  Scale's own fixed minimum, named here so it never appears bare in the formula. */
  goldsteinFloor: number;
}

export const DEFAULT_ESCALATION_SCORE_PARAMS: EscalationScoreParams = {
  eventCountWeight: 30,
  eventCountSaturation: 20,
  highSeverityWeight: 40,
  highSeveritySaturation: 10,
  goldsteinWeight: 30,
  goldsteinFloor: -10,
};

export interface EscalationScoreComputation {
  /** 0-100, clamped. eventCountPoints + highSeverityPoints + goldsteinPoints, defensively bounded. */
  score: number;
  eventCountPoints: number;
  highSeverityPoints: number;
  goldsteinPoints: number;
  /** Human-readable evidence trail — one line per component, always present, never omitted even
   *  when a component contributed 0 (a 0 needs the same visible justification as a nonzero value). */
  reasoning: string[];
}

/**
 * PURE. Maps a ConflictIntensity aggregate into a deterministic 0-100 escalationScore. Zero network
 * calls, zero LLM involvement — this is the module's PRIMARY signal and must be fully computable
 * offline from already-aggregated GDELT data.
 *
 * Formula (every threshold named in params, see EscalationScoreParams docs above):
 *   eventCountPoints    = min(1, eventCount / eventCountSaturation) * eventCountWeight
 *   highSeverityPoints  = min(1, highSeverityCount / highSeveritySaturation) * highSeverityWeight
 *   goldsteinPoints     = meanGoldstein === null ? 0
 *                          : min(1, max(0, clamp(meanGoldstein, goldsteinFloor, -goldsteinFloor) / goldsteinFloor)) * goldsteinWeight
 *   score = clamp(eventCountPoints + highSeverityPoints + goldsteinPoints, 0, 100)
 *
 * FAIL-SAFE DIRECTION: meanGoldstein === null (no in-window event carried a score) contributes
 * exactly 0 points — NEVER treated as maximal conflict and never fabricated as a number. Same for a
 * non-finite or negative eventCount/highSeverityCount (should never happen given
 * computeConflictIntensity's contract, but defensively floored to 0 rather than propagating garbage
 * upward — mirrors exit-brain-policy.ts's R0_INVALID_FEATURES fail-open-to-inert convention).
 */
export function computeEscalationScore(
  conflictIntensity: ConflictIntensity,
  params: EscalationScoreParams = DEFAULT_ESCALATION_SCORE_PARAMS,
): EscalationScoreComputation {
  const { eventCount, meanGoldstein, highSeverityCount } = conflictIntensity;
  const safeEventCount = finiteNonNegative(eventCount) ? eventCount : 0;
  const safeHighSeverityCount = finiteNonNegative(highSeverityCount) ? highSeverityCount : 0;

  const eventCountFrac = params.eventCountSaturation > 0 ? Math.min(1, safeEventCount / params.eventCountSaturation) : 0;
  const eventCountPoints = eventCountFrac * params.eventCountWeight;

  const highSeverityFrac =
    params.highSeveritySaturation > 0 ? Math.min(1, safeHighSeverityCount / params.highSeveritySaturation) : 0;
  const highSeverityPoints = highSeverityFrac * params.highSeverityWeight;

  let goldsteinPoints = 0;
  if (typeof meanGoldstein === "number" && Number.isFinite(meanGoldstein)) {
    const ceiling = -params.goldsteinFloor; // the Goldstein Scale's fixed max (+10 when floor is -10)
    const clamped = Math.max(params.goldsteinFloor, Math.min(ceiling, meanGoldstein));
    const conflictFrac = clamped < 0 && params.goldsteinFloor < 0 ? Math.min(1, clamped / params.goldsteinFloor) : 0;
    goldsteinPoints = conflictFrac * params.goldsteinWeight;
  }

  const rawScore = eventCountPoints + highSeverityPoints + goldsteinPoints;
  const score = Math.max(0, Math.min(100, rawScore));

  const reasoning: string[] = [
    `eventCount=${safeEventCount} -> ${eventCountPoints.toFixed(1)}/${params.eventCountWeight} pts (saturates at ${params.eventCountSaturation} events)`,
    `highSeverityCount=${safeHighSeverityCount} -> ${highSeverityPoints.toFixed(1)}/${params.highSeverityWeight} pts (saturates at ${params.highSeveritySaturation} high-severity events)`,
    meanGoldstein === null || meanGoldstein === undefined
      ? `meanGoldstein=null (no in-window event carried a score) -> 0/${params.goldsteinWeight} pts (fail-safe neutral, never treated as maximal conflict)`
      : `meanGoldstein=${meanGoldstein.toFixed(2)} -> ${goldsteinPoints.toFixed(1)}/${params.goldsteinWeight} pts (floor ${params.goldsteinFloor} = max conflict, 0..+10 = 0 pts)`,
  ];

  return { score, eventCountPoints, highSeverityPoints, goldsteinPoints, reasoning };
}

// ── LLM corroboration (the only I/O in this module; strictly advisory) ─────

/** Default-OFF action gate for requestLlmCorroboration's outbound call — see module header for why
 *  this deviates from the repo's usual default-running `_DISABLED` kill switch. Set
 *  GEOPOLITICAL_ESCALATION_LLM_ENABLED=1 to allow the network call; unset/anything else = disabled. */
export const GEOPOLITICAL_ESCALATION_LLM_ENABLED_FLAG = "GEOPOLITICAL_ESCALATION_LLM_ENABLED";

/** Cap on how many events get folded into the LLM prompt — bounds token usage/cost regardless of how
 *  many events the caller passes in. Most-recent-first is the caller's responsibility (this function
 *  takes events in the order given and simply truncates). */
export const GEOPOLITICAL_ESCALATION_LLM_MAX_EVENTS = 25;

export type LlmConfidence = "low" | "medium" | "high";

export interface LlmCorroborationSuccess {
  ok: true;
  /** 0-100, validated finite + in-range. */
  severity: number;
  reasoning: string;
  confidence: LlmConfidence;
}

export interface LlmCorroborationFailure {
  ok: false;
  /** Always prefixed "LLM_UNAVAILABLE" per spec — the exact suffix documents the specific failure
   *  (disabled by gate, no config, network error, timeout, malformed JSON, out-of-range field, …)
   *  for the audit trail, but every caller-visible branch treats `ok === false` identically: fall
   *  back to the quantitative-only score. */
  reason: string;
}

export type LlmCorroborationResult = LlmCorroborationSuccess | LlmCorroborationFailure;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Defensive JSON parse + validation of the model's response. Malformed JSON, a non-object, an
 *  out-of-range or non-finite severity, an empty/missing reasoning string, or a confidence value
 *  outside {"low","medium","high"} — every one of those degrades to an LLM_UNAVAILABLE failure. This
 *  function NEVER throws and NEVER accepts a partially-valid payload (all three fields are required
 *  and validated together, or none of it is trusted). */
function parseLlmSeverityResponse(text: string): LlmCorroborationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return { ok: false, reason: "LLM_UNAVAILABLE: malformed JSON response" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "LLM_UNAVAILABLE: response was not a JSON object" };
  }
  const rec = parsed as Record<string, unknown>;
  const severity = rec.severity;
  if (typeof severity !== "number" || !Number.isFinite(severity) || severity < 0 || severity > 100) {
    return { ok: false, reason: "LLM_UNAVAILABLE: severity missing, non-numeric, or outside [0,100]" };
  }
  const reasoning = rec.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    return { ok: false, reason: "LLM_UNAVAILABLE: reasoning missing or empty" };
  }
  const confidence = rec.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    return { ok: false, reason: "LLM_UNAVAILABLE: confidence missing or not one of low/medium/high" };
  }
  return { ok: true, severity, reasoning: reasoning.trim(), confidence };
}

function buildCorroborationPrompt(events: readonly GdeltEvent[]): { system: string; user: string } {
  const system =
    "You are a military-escalation severity classifier used purely for corroboration/audit purposes, " +
    "never as the sole basis for any automated action. Read ONLY the supplied event text (headlines, " +
    "actor names, CAMEO codes, Goldstein scores). Do NOT speculate beyond what is given — do not invent " +
    "facts, do not use outside knowledge of current events. Reply with STRICT JSON and NOTHING ELSE, in " +
    'exactly this shape: {"severity": <number 0-100>, "reasoning": <short string>, "confidence": ' +
    '"low"|"medium"|"high"}. No prose, no markdown, no code fences — a single JSON object only.';

  const lines = events.slice(0, GEOPOLITICAL_ESCALATION_LLM_MAX_EVENTS).map((e, i) => {
    const parts = [
      `#${i + 1}`,
      e.title ? `title="${e.title}"` : null,
      e.actor1 ? `actor1=${e.actor1}` : null,
      e.actor2 ? `actor2=${e.actor2}` : null,
      `cameo=${e.cameoCode}`,
      typeof e.goldsteinScale === "number" && Number.isFinite(e.goldsteinScale) ? `goldstein=${e.goldsteinScale}` : null,
    ].filter((p): p is string => p !== null);
    return parts.join(" | ");
  });

  const user =
    lines.length > 0
      ? `Recent conflict-related events (evidence text only, one per line):\n${lines.join("\n")}\n\nReturn STRICT JSON only.`
      : "No event text was supplied. Return STRICT JSON only, reflecting that you have no evidence to assess.";

  return { system, user };
}

/**
 * The only I/O in this module. Builds a system+user prompt from the supplied events' headline/actor/
 * CAMEO text ONLY, calls lib/nvidia-chat-client.ts's requestChatCompletion (same fetchImpl-injected,
 * AbortController-timeout idiom that module already implements — no new HTTP plumbing invented here),
 * and defensively parses/validates the STRICT JSON response.
 *
 * GATED BY GEOPOLITICAL_ESCALATION_LLM_ENABLED (default OFF — see module header): when unset/not "1",
 * or when no nvidiaConfig is supplied, this returns an LLM_UNAVAILABLE failure WITHOUT making any
 * network call. This function NEVER throws — every failure mode (gate closed, missing config, no
 * events, network error, timeout, malformed/invalid JSON) resolves to an ok:false result that the
 * caller (classifyEscalation) treats identically: fall back to the quantitative-only score.
 */
export async function requestLlmCorroboration(
  events: readonly GdeltEvent[],
  nvidiaConfig: NvidiaChatConfig | null,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<LlmCorroborationResult> {
  const env = opts.env ?? process.env;
  if (env[GEOPOLITICAL_ESCALATION_LLM_ENABLED_FLAG] !== "1") {
    return {
      ok: false,
      reason: `LLM_UNAVAILABLE: ${GEOPOLITICAL_ESCALATION_LLM_ENABLED_FLAG} is not "1" (default-off action gate, no call made)`,
    };
  }
  if (!nvidiaConfig) {
    return { ok: false, reason: "LLM_UNAVAILABLE: no NVIDIA chat config supplied (e.g. missing NVIDIA_API_KEY)" };
  }
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "LLM_UNAVAILABLE: no event text supplied for corroboration" };
  }

  const { system, user } = buildCorroborationPrompt(events);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const result = await requestChatCompletion(nvidiaConfig, messages, opts.fetchImpl ?? fetch);
  if (!result.ok) return { ok: false, reason: `LLM_UNAVAILABLE: ${result.reason}` };
  return parseLlmSeverityResponse(result.text);
}

// ── combined classification (pure combination step) ─────────────────────────

/** Confidence-weighting applied to how much the LLM's read is allowed to REDUCE the quantitative
 *  score — a "low" confidence disagreement moves the score far less than a "high" confidence one.
 *  Named constants, no magic numbers in classifyEscalation's body. */
export const ESCALATION_LLM_CONFIDENCE_WEIGHT: Record<LlmConfidence, number> = {
  low: 0.25,
  medium: 0.6,
  high: 1.0,
};

/** Hard cap, in score points, on how far the LLM can ever pull the final score down from the
 *  quantitative score — regardless of confidence or how large the disagreement is. Bounds the
 *  LLM's influence to a minority adjustment, never a wholesale override. */
export const ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS = 20;

export interface EscalationClassification {
  /** computeEscalationScore's output score — the PRIMARY, zero-LLM signal. */
  quantitativeScore: number;
  /** The LLM's reported severity when available and valid; null otherwise. */
  llmSeverity: number | null;
  /** true only when llmResult was supplied AND ok:true AND passed validation. */
  llmAvailable: boolean;
  llmConfidence: LlmConfidence | null;
  /**
   * ALWAYS derived from quantitativeScore as the ceiling-defining input — finalScore <=
   * quantitativeScore, always, by construction:
   *   - llmAvailable === false (no result / failure / invalid output): finalScore === quantitativeScore
   *     EXACTLY. An LLM failure is NEVER evidence of escalation and NEVER inflates the score.
   *   - llmAvailable === true AND llmSeverity >= quantitativeScore (LLM agrees or reads it as MORE
   *     severe): finalScore === quantitativeScore EXACTLY — the LLM is never allowed to raise it.
   *   - llmAvailable === true AND llmSeverity < quantitativeScore (LLM reads it as LESS severe):
   *     finalScore = quantitativeScore − min(ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS,
   *     (quantitativeScore − llmSeverity) × ESCALATION_LLM_CONFIDENCE_WEIGHT[confidence]), floored at 0.
   */
  finalScore: number;
  /** Full evidence trail: computeEscalationScore's per-component lines plus one line describing
   *  exactly what the LLM contributed (or why it didn't) and how that changed (or didn't change)
   *  finalScore. No black-box scores. */
  reasoning: string[];
}

/**
 * PURE combination step. Never calls the network itself — callers pass in whatever
 * requestLlmCorroboration already produced (or `null` to skip LLM corroboration entirely).
 *
 * CRITICAL SAFETY INVARIANT (tested explicitly, see the fail-without/pass-with regression test):
 * finalScore can never exceed quantitativeScore, under any llmResult input, valid or not. The LLM
 * leg exists ONLY to lower confidence / flag a downward disagreement, or to supply human-readable
 * reasoning text — it can never independently raise the escalation state.
 */
export function classifyEscalation(
  conflictIntensity: ConflictIntensity,
  llmResult: LlmCorroborationResult | null,
  params: EscalationScoreParams = DEFAULT_ESCALATION_SCORE_PARAMS,
): EscalationClassification {
  const quant = computeEscalationScore(conflictIntensity, params);
  const reasoning: string[] = [...quant.reasoning];

  const llmAvailable = llmResult !== null && llmResult.ok === true;
  const llmSeverity = llmAvailable ? (llmResult as LlmCorroborationSuccess).severity : null;
  const llmConfidence = llmAvailable ? (llmResult as LlmCorroborationSuccess).confidence : null;

  let finalScore = quant.score;

  if (!llmAvailable) {
    const why = llmResult && llmResult.ok === false ? llmResult.reason : "no LLM result supplied";
    reasoning.push(`LLM corroboration unavailable (${why}) -> finalScore is quantitative-only: ${quant.score.toFixed(1)}.`);
  } else if (llmSeverity !== null && llmSeverity >= quant.score) {
    reasoning.push(
      `LLM read severity=${llmSeverity} (confidence=${llmConfidence}), at/above quantitative ${quant.score.toFixed(1)} -> ignored; the LLM can never raise the score (ceiling = quantitativeScore).`,
    );
  } else if (llmSeverity !== null && llmConfidence !== null) {
    const gap = quant.score - llmSeverity;
    const rawDownweight = gap * ESCALATION_LLM_CONFIDENCE_WEIGHT[llmConfidence];
    const cappedDownweight = Math.min(rawDownweight, ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS);
    finalScore = Math.max(0, quant.score - cappedDownweight);
    reasoning.push(
      `LLM read severity=${llmSeverity} (confidence=${llmConfidence}), below quantitative ${quant.score.toFixed(1)} -> ` +
        `downweighted final score by ${cappedDownweight.toFixed(1)} pts (raw gap ${gap.toFixed(1)} x weight ${ESCALATION_LLM_CONFIDENCE_WEIGHT[llmConfidence]}, capped at ${ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS}) -> finalScore=${finalScore.toFixed(1)}.`,
    );
  }

  return {
    quantitativeScore: quant.score,
    llmSeverity,
    llmAvailable,
    llmConfidence,
    finalScore,
    reasoning,
  };
}

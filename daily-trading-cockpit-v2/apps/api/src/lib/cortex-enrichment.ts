/**
 * CORTEX external-signal enrichment contract (2026-07-12) — the foundation for the sentiment /
 * narrative / event-risk awareness layers (operator design). This module defines ONLY the data
 * contract + freshness/leakage discipline + neutral-fallback; it does NOT fetch or decide anything.
 *
 * Staging (deliberately does NOT bump the active featureSchemaVersion): enrichment is recorded in the
 * decision journal ("v1-shadow-enrichment") and NEVER enters the learned feature vector until it has
 * proven coverage + edge in offline replay + shadow scoring (then a ONE-TIME v2 bump, seeding v2's
 * prior from v1 on the shared features so the model isn't fully reset). Because CortexBrainStore
 * discards a model on schema mismatch, keeping enrichment out of the schema protects the accumulating
 * v1 learning.
 *
 * Two paths (the key architectural split):
 *  - PREDICTIVE (marketMood, narrativeContext) → future feature-vector inputs, learned via the logistic.
 *  - SAFETY (hack / depeg / outage / delisting / exploit) → a DETERMINISTIC rail that modifies gross /
 *    entry-hurdle / signal-TTL OUTSIDE the learned path (sibling of the kill-switch), NOT a feature.
 */

export type ExternalSignalStatus = "FRESH" | "STALE" | "MISSING" | "ERROR";

/**
 * Every external signal carries provenance + freshness so CORTEX can tell a fresh fact from a stale
 * cache / a silent API failure / a re-fetch of old news. `observedAt` = when the underlying fact was
 * true (mood measured / event published); `fetchedAt` = when WE pulled it. A signal that is not FRESH
 * MUST resolve to the neutral feature value (0) — never carry-forward unboundedly.
 */
export interface ExternalSignal<T> {
  value: T;
  observedAt: string | null;
  fetchedAt: string;
  expiresAt: string | null;
  source: string;
  status: ExternalSignalStatus;
  confidence: number; // 0..1
}

/** Slow background mood (Fear & Greed + Reddit + inferred regime). PREDICTIVE. */
export interface MarketMood {
  score: number; // −1..+1
  confidence: number; // 0..1
  ageMs: number;
  sourceCoverage: number; // 0..1 fraction of expected sources present
}

/** Per-lane/per-symbol narrative context. PREDICTIVE. Keep the component parts for audit even though
 *  the model eventually consumes one combined `narrativeAlign`. */
export interface NarrativeContext {
  tags: string[];
  momentum: number; // −1..+1 (narrative momentum; beware: momentum without breadth = one-coin pump)
  breadth: number; // 0..1 (how broadly the narrative's symbols move together)
  crowding: number; // −1..+1 (high momentum + high crowding = late entry)
  alignment: number; // −1..+1: is THIS lane trading WITH (+), AGAINST (−), or unrelated (0) to the narrative
  freshnessMs: number;
}

export type EventCategory =
  | "ETF"
  | "REGULATION"
  | "EXCHANGE_HACK"
  | "DELISTING"
  | "STABLECOIN_DEPEG"
  | "GEOPOLITICAL"
  | "RATES"
  | "LEGAL"
  | "CHAIN_OUTAGE"
  | "EXPLOIT"
  | "OTHER";
export type EventScope = "GLOBAL" | "SECTOR" | "SYMBOL";

/** Event-risk. First an UNCERTAINTY/RISK modifier, only later (Phase E) a directional input. */
export interface EventRisk {
  severity: number; // 0..1
  direction: -1 | 0 | 1;
  confidence: number; // 0..1
  scope: EventScope;
  category: EventCategory | null;
  freshnessMs: number;
  corroborationCount: number; // distinct sources AFTER dedup (30 sites copying one Reuters ≠ 30)
}

/** SAFETY-rail categories: deterministic, narrow, multi-source, expiring — never learned from history
 *  first (a stablecoin depeg / exchange freeze is not a statistical feature). A generic geopolitical
 *  headline is deliberately NOT here — it must not be able to halt the system. */
export const SAFETY_EVENT_CATEGORIES: ReadonlySet<EventCategory> = new Set<EventCategory>([
  "EXCHANGE_HACK",
  "STABLECOIN_DEPEG",
  "DELISTING",
  "CHAIN_OUTAGE",
  "EXPLOIT",
]);
export function isSafetyEvent(category: EventCategory | null | undefined): boolean {
  return category != null && SAFETY_EVENT_CATEGORIES.has(category);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function finiteOr(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Classify a signal's freshness. FRESH only if observed, not expired, and within maxAgeMs of now;
 * MISSING if no observedAt; STALE if too old / expired. (ERROR is set by the fetcher on a failed pull.)
 */
export function classifyFreshness(args: {
  observedAt: string | null;
  expiresAt: string | null;
  nowMs: number;
  maxAgeMs: number;
}): ExternalSignalStatus {
  const obs = parseMs(args.observedAt);
  if (obs === null) return "MISSING";
  // 2026-07-22 fix: a future-dated observedAt (clock-skewed or corrupted fetcher — this codebase has a
  // documented history of Binance clock-sync skew incidents) previously passed straight through as
  // FRESH, since nowMs-obs is negative and never exceeds a positive maxAgeMs. That's not a genuinely
  // observed-in-the-past fact, so it must never be trusted as FRESH.
  if (args.nowMs < obs) return "STALE";
  const exp = parseMs(args.expiresAt);
  if (exp !== null && args.nowMs > exp) return "STALE";
  if (args.nowMs - obs > args.maxAgeMs) return "STALE";
  return "FRESH";
}

/**
 * The value the model should use for a mood signal: the mood score, DOWN-WEIGHTED by confidence ×
 * sourceCoverage — but a non-FRESH signal resolves to the neutral 0 (never carry-forward). This is the
 * "confidence gates, doesn't decorate" rule.
 */
export function moodFeatureValue(signal: ExternalSignal<MarketMood> | null | undefined): number {
  if (!signal || signal.status !== "FRESH") return 0;
  const m = signal.value;
  // 2026-07-22 fix: the outer signal.confidence (fetch/provenance trust — e.g. only some of the
  // expected sources actually responded) was never applied here, unlike narrativeAlignFeatureValue
  // below which DOES multiply by it — a degraded fetch with a high inner MarketMood.confidence would
  // still read as a near-max-strength feature instead of being discounted per the module's own
  // "confidence gates, doesn't decorate" rule.
  const w =
    clamp01(finiteOr(m.confidence, 0)) * clamp01(finiteOr(m.sourceCoverage, 0)) * clamp01(finiteOr(signal.confidence, 1));
  return clamp(finiteOr(m.score, 0) * w, -1, 1);
}

/** The value the model should use for a lane's narrative alignment: alignment × freshness-weight;
 *  neutral 0 when not FRESH. Component parts stay in the journal for audit. */
export function narrativeAlignFeatureValue(signal: ExternalSignal<NarrativeContext> | null | undefined): number {
  if (!signal || signal.status !== "FRESH") return 0;
  const n = signal.value;
  // A narrative with momentum but no breadth (one-coin pump) is discounted; crowding extremity too.
  const quality = clamp01(finiteOr(n.breadth, 0)) * (1 - 0.5 * clamp01(Math.abs(finiteOr(n.crowding, 0))));
  return clamp(finiteOr(n.alignment, 0) * clamp01(finiteOr(signal.confidence, 1)) * (0.5 + 0.5 * quality), -1, 1);
}

/**
 * LEAKAGE GATE (Phase C offline replay). A training/replay row that uses an event is valid ONLY if the
 * event was first seen at or before the decision time — otherwise the news feature is look-ahead
 * (headline at 14:05 must NOT influence the 14:00 decision). Live shadow is inherently causal
 * (firstSeenAt = our fetch time ≤ decisionAt); this guard exists for replay + backfill.
 */
export function isCausalEvent(eventFirstSeenAtMs: number, decisionAtMs: number): boolean {
  return Number.isFinite(eventFirstSeenAtMs) && Number.isFinite(decisionAtMs) && eventFirstSeenAtMs <= decisionAtMs;
}

/**
 * The journal enrichment block — recorded alongside each shadow decision but NOT part of the feature
 * vector (schema stays v1). This is where sentiment/narrative/event accrue for later validation.
 */
export interface CortexEnrichmentBlock {
  schemaStage: "v1-shadow-enrichment";
  decisionAt: string;
  marketMood: ExternalSignal<MarketMood> | null;
  eventRisk: ExternalSignal<EventRisk> | null;
  /** Per-lane narrative context (keyed by laneId). */
  perLaneNarrative: Record<string, ExternalSignal<NarrativeContext>> | null;
}

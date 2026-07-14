/**
 * Market State Brain (Phase 1, PURE + REPORT-ONLY). Describes the CURRENT market state — family, bias,
 * volatility, liquidity, transition risk — WITHOUT opening trades or forcing a direction. It never
 * hard-gates long or short (that is the Direction Brain's separate job, and even there it's a soft lean).
 *
 * Design contract:
 *  • Pure + deterministic in (input). No Date.now / random / IO.
 *  • UNKNOWN is a first-class output when FRESH data is insufficient — missing data never fabricates certainty.
 *  • State is NOT compressed to one label: family + bias + vol-band + liquidity-band + every component score
 *    are preserved for audit.
 *  • Freshness + causality are enforced via classifySource (a FUTURE timestamp → ERROR → unused).
 *  • Only the NARROW deterministic safety events (HACK/DEPEG/DELISTING/OUTAGE/EXPLOIT) set EVENT_DRIVEN.
 *    Geopolitical / macro headlines are a SOFT eventRiskScore that raises transitionRisk — never a
 *    deterministic trade shutdown.
 *
 * The impure gather that maps real repo sources → these normalized components is a later, separately-approved
 * step; the mapping (deliverable #1) pins each source. Component sign/scale conventions are documented inline.
 */
import {
  classifySource,
  clamp01,
  fourBrainDecisionId,
  MARKET_STATE_SCHEMA_VERSION,
  type LiquidityBand,
  type MarketBias,
  type MarketStateDecision,
  type MarketStateFamily,
  type SourceStatus,
  type SourceStatuses,
  type TaggedSource,
  type VolatilityBand,
} from "./four-brain-types.js";

/** The narrow, deterministic safety events that DO justify EVENT_DRIVEN. Geopolitical headlines are NOT here. */
export type MarketSafetyEventKind = "HACK" | "DEPEG" | "DELISTING" | "OUTAGE" | "EXPLOIT";
/** Runtime allow-set — the ONLY kinds that may set family=EVENT_DRIVEN. A caller cannot smuggle any other
 *  "event" (e.g. a geopolitical/macro headline) into EVENT_DRIVEN by mislabelling its kind. */
export const MARKET_SAFETY_EVENT_KINDS: ReadonlySet<string> = new Set<MarketSafetyEventKind>([
  "HACK", "DEPEG", "DELISTING", "OUTAGE", "EXPLOIT",
]);
export interface MarketSafetyEvent {
  kind: MarketSafetyEventKind;
  symbol?: string | null;
  asOfMs: number;
  note?: string;
}

/**
 * Normalized component inputs (each a freshness-tagged reading). Conventions:
 *   trend      −1..+1  signed trend (sign = direction, magnitude = strength) — e.g. regime axis score
 *   volatility  0..1   magnitude (0 dead, 1 extreme) — e.g. ATR%/vol-cache percentile
 *   liquidity   0..1   0 thin, 1 deep — MISSING allowed (→ liquidity UNKNOWN, never fabricated)
 *   breadth    −1..+1  net advancers/decliners
 *   momentum   −1..+1  short-horizon ROC
 *   eventRisk   0..1   SOFT elevated-risk (scheduled events, macro uncertainty) — NOT a shutdown
 *   sentiment  −1..+1  aggregate sentiment
 */
export interface MarketStateInput {
  nowMs: number;
  validityMs: number;
  trend: TaggedSource;
  volatility: TaggedSource;
  liquidity: TaggedSource;
  breadth: TaggedSource;
  momentum: TaggedSource;
  eventRisk: TaggedSource;
  sentiment: TaggedSource;
  /** Active deterministic safety events (narrow). [] when none. */
  safetyEvents?: MarketSafetyEvent[];
  /** Per-source staleness TTLs (ms). Sensible defaults applied when unset. */
  ttls?: Partial<Record<MarketStateSourceKey, number>>;
}

export type MarketStateSourceKey = "trend" | "volatility" | "liquidity" | "breadth" | "momentum" | "eventRisk" | "sentiment";

const DEFAULT_TTL: Record<MarketStateSourceKey, number> = {
  trend: 30 * 60_000,
  volatility: 30 * 60_000,
  liquidity: 5 * 60_000, // liquidity/order-book decays fast
  breadth: 30 * 60_000,
  momentum: 15 * 60_000,
  eventRisk: 6 * 60 * 60_000, // event windows are slow
  sentiment: 60 * 60_000,
};

const VOL_BANDS: [number, VolatilityBand][] = [
  [0.25, "LOW"],
  [0.6, "NORMAL"],
  [0.85, "HIGH"],
];
function volBand(score: number): VolatilityBand {
  for (const [th, band] of VOL_BANDS) if (score < th) return band;
  return "EXTREME";
}
function liquidityBand(score: number | null): LiquidityBand {
  if (score === null) return "UNKNOWN";
  return score < 0.33 ? "THIN" : score < 0.66 ? "NORMAL" : "DEEP";
}

/** Compute the market-state decision. Pure. */
export function decideMarketState(input: MarketStateInput): MarketStateDecision {
  const nowMs = input.nowMs;
  const ttls = { ...DEFAULT_TTL, ...(input.ttls ?? {}) };
  const keys: MarketStateSourceKey[] = ["trend", "volatility", "liquidity", "breadth", "momentum", "eventRisk", "sentiment"];
  const sourceStatuses: SourceStatuses = {};
  const val: Record<MarketStateSourceKey, number | null> = {
    trend: null, volatility: null, liquidity: null, breadth: null, momentum: null, eventRisk: null, sentiment: null,
  };
  for (const k of keys) {
    const st = classifySource(input[k], nowMs, ttls[k]);
    sourceStatuses[k] = st;
    val[k] = st === "FRESH" && typeof input[k]?.value === "number" ? (input[k].value as number) : null;
  }

  const reasons: string[] = [];
  // ONLY the narrow deterministic kinds + a valid non-future timestamp may drive EVENT_DRIVEN. A bogus/
  // geopolitical "kind" is filtered out here — it can never shut trading into EVENT_DRIVEN.
  const safety = (input.safetyEvents ?? []).filter(
    (e) => e && MARKET_SAFETY_EVENT_KINDS.has(e.kind) && Number.isFinite(e.asOfMs) && e.asOfMs <= nowMs + 60_000,
  );

  // Components preserved for audit (null when not FRESH — never a fabricated 0).
  const components = {
    trendScore: val.trend,
    volatilityScore: val.volatility,
    liquidityScore: val.liquidity,
    breadthScore: val.breadth,
    momentumScore: val.momentum,
    eventRiskScore: val.eventRisk,
    sentimentScore: val.sentiment,
  };

  const t = val.trend;
  const vol = val.volatility;
  const mom = val.momentum;
  const br = val.breadth;
  const evt = val.eventRisk;
  const coreFresh = [t, vol, mom].filter((x) => x !== null).length; // trend/vol/momentum are the load-bearing trio

  // ── Family ────────────────────────────────────────────────────────────────────────────────────
  let family: MarketStateFamily;
  if (safety.length > 0) {
    family = "EVENT_DRIVEN";
    reasons.push(`deterministic safety event(s): ${safety.map((e) => e.kind).join(",")}`);
  } else if (coreFresh < 2 || t === null || vol === null) {
    family = "UNKNOWN"; // insufficient FRESH data — do not fabricate a regime
    reasons.push("insufficient fresh core data (trend/volatility) → UNKNOWN");
  } else {
    const m = mom ?? 0;
    const at = Math.abs(t);
    if (vol >= 0.85 && (t < -0.15 || m < -0.3)) {
      family = "PANIC";
      reasons.push("extreme volatility + downside momentum/trend");
    } else if (vol >= 0.6 && m > 0.4 && t <= 0.15) {
      family = "RECOVERY";
      reasons.push("high volatility + upside momentum off a non-positive trend (bounce)");
    } else if (vol < 0.22 && at < 0.2) {
      family = "SQUEEZE";
      reasons.push("low volatility + flat trend (compression)");
    } else if (Math.abs(m) > 0.6 && vol >= 0.5) {
      family = "BREAKOUT";
      reasons.push("strong momentum impulse with expanding volatility");
    } else if (at > 0.4 && Math.sign(t) === Math.sign(m) && vol < 0.85) {
      family = "TREND";
      reasons.push("directional trend aligned with momentum");
    } else if (at < 0.25) {
      family = "RANGE";
      reasons.push("weak trend, contained volatility");
    } else {
      family = "UNKNOWN";
      reasons.push("no clear family from fresh components");
    }
  }

  // ── Bias (never a gate — pure description) ──────────────────────────────────────────────────────
  let bias: MarketBias = "NEUTRAL";
  if (t !== null || br !== null || mom !== null) {
    const parts = [t, br, mom].filter((x): x is number => x !== null);
    const avg = parts.reduce((s, x) => s + x, 0) / parts.length;
    const disagree = t !== null && br !== null && Math.sign(t) !== Math.sign(br) && Math.abs(t) > 0.15 && Math.abs(br) > 0.15;
    if (disagree) bias = "MIXED";
    else if (avg > 0.2) bias = "BULLISH";
    else if (avg < -0.2) bias = "BEARISH";
    else bias = "NEUTRAL";
  } else {
    reasons.push("no fresh directional components → NEUTRAL bias");
  }

  // ── Volatility + liquidity bands ────────────────────────────────────────────────────────────────
  const volatility: VolatilityBand = vol === null ? "NORMAL" : volBand(vol);
  if (vol === null) reasons.push("volatility MISSING → assumed NORMAL (no certainty)");
  const liquidity = liquidityBand(val.liquidity);

  // ── Transition risk (0..1) ──────────────────────────────────────────────────────────────────────
  let transitionRisk = 0;
  if (vol !== null) transitionRisk = Math.max(transitionRisk, vol * 0.6);
  if (evt !== null) transitionRisk = Math.max(transitionRisk, evt); // soft event risk lifts transition risk
  if (safety.length > 0) transitionRisk = Math.max(transitionRisk, 0.9);
  if (family === "PANIC" || family === "BREAKOUT") transitionRisk = Math.max(transitionRisk, 0.7);
  // Component disagreement (trend vs breadth) raises transition risk.
  if (t !== null && br !== null && Math.sign(t) !== Math.sign(br)) transitionRisk = Math.max(transitionRisk, 0.5);
  transitionRisk = clamp01(transitionRisk);

  // ── Confidence (0..1): more FRESH agreeing components ⇒ higher; UNKNOWN ⇒ low ────────────────────
  const freshCount = keys.filter((k) => sourceStatuses[k] === "FRESH").length;
  let confidence = clamp01(freshCount / keys.length);
  if (family === "UNKNOWN") confidence = Math.min(confidence, 0.25);
  if (bias === "MIXED") confidence *= 0.7;
  confidence = clamp01(confidence);

  const validUntilMs = nowMs + Math.max(0, input.validityMs || 0);
  const decisionId = fourBrainDecisionId("mstate", nowMs, `${family}:${bias}:${volatility}`);

  return {
    schemaVersion: MARKET_STATE_SCHEMA_VERSION,
    decisionId,
    asOfMs: nowMs,
    validUntilMs,
    family,
    bias,
    volatility,
    liquidity,
    transitionRisk,
    confidence,
    components,
    reasons,
    sourceStatuses,
  };
}

/** Convenience for callers/tests: the set of source keys this brain consumes. */
export const MARKET_STATE_SOURCE_KEYS: MarketStateSourceKey[] = [
  "trend", "volatility", "liquidity", "breadth", "momentum", "eventRisk", "sentiment",
];

export type { SourceStatus };

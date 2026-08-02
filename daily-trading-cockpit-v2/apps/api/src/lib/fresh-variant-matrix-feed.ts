/**
 * Fresh variant-matrix feed (the live-honest replacement for the shadow-position feed).
 *
 * The old `selectVariantMatrixSignals` derived observations from shadow positions that had already
 * CLOSED, so every observation's entry was ~6h stale (median) and the book was ~100% short — the
 * measured edge used entries you could never actually take live. This feed instead samples the
 * scanner's FRESH candidates (both directions) every scan cycle, stamps `openedAt = now`, tags the
 * regime posture (TACTICAL/EXTENDED) + favored direction, and creates the same per-variant
 * observations. The existing resolver walks them forward over real candles. Result: entries are
 * live-takeable (lag ≈ 0), and longs/shorts/mixed all accrue with posture context.
 *
 * Report-only. Pure aside from writing to the passed store.
 */
import {
  buildVariantMatrixObservationsForSignal,
  VARIANT_MATRIX_DEFINITIONS,
  type CurrentGuardVariantMatrixObservation,
  type CurrentGuardVariantMatrixStore,
  type VariantMatrixSignal,
  type VariantPosture,
  type VariantRegimeDirection,
} from "./current-guard-variant-matrix.js";

export interface FreshFeedCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfitLevels: number[];
  stopDistanceBps?: number | null;
  entryVariant?: string | null;
}

export interface FreshVariantMatrixFeedInputs {
  candidates: FreshFeedCandidate[];
  regime: string | null;
  controllerMode: string | null;
  controllerConfidence?: string | null;
  /** Derivatives crowding state per symbol at signal time (caller fetches it); tags each obs. */
  crowdingBySymbol?: Record<string, string | null>;
  now: string; // ISO
  maxPerCycle?: number;
  /** Shared-origin scan-cycle identity (the scan service's own generatedAt). Every candidate created
   *  from the SAME call is one market episode — this is threaded onto every signal in the batch so
   *  computeEffectiveN can count them as one independent draw instead of one-per-symbol. Optional;
   *  omitted falls through to the deterministic time-block fallback. */
  scanBatchId?: string | null;
}

export interface FreshVariantMatrixFeedResult {
  signalsCreated: number;
  observationsCreated: number;
  skipped: number;
  posture: VariantPosture;
  regimeDirection: VariantRegimeDirection;
  reasons: string[];
}

const DEFAULT_MAX_PER_CYCLE = 12;
const FIRST_VARIANT_ID = VARIANT_MATRIX_DEFINITIONS[0]!.id;

/** Intake-throttle watermark (see runFreshVariantMatrixFeed). Test hook resets it. */
let lastBatchMs = 0;
export function _resetFreshFeedThrottleForTests(): void {
  lastBatchMs = 0;
}

/**
 * Market posture + favored direction at signal time. Self-contained (inlines the lane-selector
 * regime estimator's logic) so the `/` diagnostic instance — whose lane-selector predates
 * `estimateLaneSelectorV2Regime` — can run this without the missing import. Logic is kept identical:
 * EXTENDED only when a clear direction + trend-like regime + MEDIUM/HIGH confidence all hold.
 */
export function freshFeedRegimeContext(
  regime: string | null,
  controllerMode: string | null,
  confidence: string | null,
): { posture: VariantPosture; regimeDirection: VariantRegimeDirection } {
  const r = (regime ?? "").toLowerCase();
  const mode = (controllerMode ?? "").toUpperCase();
  const conf = (confidence ?? "").toUpperCase();
  const mixed =
    mode === "VALIDATION_ONLY" ||
    mode === "NO_TRADE_CHOP" ||
    mode === "BOTH_ALLOWED" ||
    /mixed|rotation|chop|range|sideways|neutral|unknown/.test(r);
  const dir: VariantRegimeDirection | null = mixed
    ? "MIXED"
    : mode === "LONG_ONLY" || /bull|long/.test(r)
      ? "LONG"
      : mode === "SHORT_ONLY" || /bear|short/.test(r)
        ? "SHORT"
        : null;
  const trendLike = /trend|expansion|pressure|continuation|impulse|breakout|strong/.test(r);
  const confidenceOk = conf === "MEDIUM" || conf === "HIGH";
  const extended = dir !== null && dir !== "MIXED" && trendLike && confidenceOk;
  return {
    posture: extended ? "EXTENDED" : "TACTICAL",
    regimeDirection: dir ?? "MIXED",
  };
}

function geometryDirectionOk(c: FreshFeedCandidate): boolean {
  const tp1 = c.takeProfitLevels[0];
  if (!(typeof c.entryPrice === "number" && c.entryPrice > 0)) return false;
  if (!(typeof c.stopLoss === "number" && c.stopLoss > 0)) return false;
  if (!(typeof tp1 === "number" && tp1 > 0)) return false;
  return c.direction === "SHORT"
    ? c.stopLoss > c.entryPrice && tp1 < c.entryPrice
    : c.stopLoss < c.entryPrice && tp1 > c.entryPrice;
}

/** Marker for synthesized opposite-direction candidates so the two cohorts stay separable. */
export const FRESH_MIRROR_OPPOSITE_VARIANT = "FRESH_MIRROR_OPPOSITE";

/**
 * Synthesize the OPPOSITE-direction twin of a candidate: same entry, stop/TPs
 * reflected to the other side at the same distances. This is what makes the feed
 * genuinely BOTH-directions — before this, the feed only sampled the scanner's
 * `finalDirection` (long-biased by construction: anything non-SHORT became LONG),
 * which is why SHORT freshValid starved (~48 obs vs ~750 LONG). Mirrored obs are
 * tagged via `entryVariant` so scanner-conviction vs anti-conviction cohorts can
 * be measured separately.
 */
export function mirrorOppositeCandidate(c: FreshFeedCandidate): FreshFeedCandidate | null {
  if (!geometryDirectionOk(c)) return null;
  const entry = c.entryPrice as number;
  const stop = c.stopLoss as number;
  const mirroredStop = entry + (entry - stop);
  const mirroredTps = c.takeProfitLevels
    .map((tp) => entry - (tp - entry))
    .filter((tp) => Number.isFinite(tp) && tp > 0);
  if (!(mirroredStop > 0) || mirroredTps.length === 0) return null;
  return {
    symbol: c.symbol,
    direction: c.direction === "LONG" ? "SHORT" : "LONG",
    entryPrice: entry,
    stopLoss: mirroredStop,
    takeProfitLevels: mirroredTps,
    stopDistanceBps: c.stopDistanceBps ?? null,
    entryVariant: FRESH_MIRROR_OPPOSITE_VARIANT,
  };
}

export function runFreshVariantMatrixFeed(
  inputs: FreshVariantMatrixFeedInputs,
  store: CurrentGuardVariantMatrixStore,
): FreshVariantMatrixFeedResult {
  const { posture, regimeDirection } = freshFeedRegimeContext(
    inputs.regime,
    inputs.controllerMode,
    inputs.controllerConfidence ?? null,
  );
  const result: FreshVariantMatrixFeedResult = {
    signalsCreated: 0,
    observationsCreated: 0,
    skipped: 0,
    posture,
    regimeDirection,
    reasons: [],
  };
  const maxPerCycle = inputs.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE;

  // INTAKE THROTTLE: at most one batch per interval (default 60 min). The feed used to
  // mint a batch EVERY 7-min scan cycle (~55K obs/day across 23 variants) — the store
  // hit 145MB in two days and resolution starved to zero (every save serializes the
  // whole array). One batch/hour keeps full coverage (obs live for days) at ~1/8th the
  // intake. Process-local watermark: a restart at worst allows one extra batch.
  const nowMs = new Date(inputs.now).getTime();
  const intervalMin = Number.parseFloat(process.env.FRESH_VM_FEED_INTERVAL_MIN ?? "");
  const intervalMs = (Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin : 60) * 60_000;
  if (nowMs - lastBatchMs < intervalMs) {
    result.skipped = inputs.candidates.length;
    result.reasons.push(`throttled:next_batch_in_${Math.ceil((lastBatchMs + intervalMs - nowMs) / 60000)}min`);
    return result;
  }

  // Minute-bucketed entry time: keeps entryLag ≤ ~1min (fresh) AND gives natural per-minute dedupe
  // via the store's sourceObservationKey (symbol|direction|openedAt).
  const openedAt = `${inputs.now.slice(0, 16)}:00.000Z`;

  // Interleave [scanner-direction, mirrored-opposite] per symbol UNDER THE SAME CAP:
  // the per-cycle budget stays constant (no store-growth change) but the direction
  // mix becomes ~50/50 instead of whatever the (long-biased) scanner emitted.
  const expanded: FreshFeedCandidate[] = [];
  for (const c of inputs.candidates) {
    expanded.push(c);
    const mirrored = mirrorOppositeCandidate(c);
    if (mirrored) expanded.push(mirrored);
  }

  for (const c of expanded) {
    if (result.signalsCreated >= maxPerCycle) {
      result.skipped += 1;
      result.reasons.push(`cap_reached:${c.symbol}`);
      continue;
    }
    if (!geometryDirectionOk(c)) {
      result.skipped += 1;
      result.reasons.push(`bad_geometry:${c.symbol}:${c.direction}`);
      continue;
    }
    const key = `${c.symbol}|${c.direction}|${openedAt}`;
    if (store.hasObservation(key, FIRST_VARIANT_ID)) {
      result.skipped += 1;
      result.reasons.push(`duplicate:${c.symbol}:${c.direction}`);
      continue;
    }
    const signal: VariantMatrixSignal = {
      sourceSignalId: `fresh:${c.symbol}:${c.direction}:${openedAt}`,
      symbol: c.symbol,
      direction: c.direction,
      entryPrice: c.entryPrice as number,
      stopLoss: c.stopLoss as number,
      tp1: c.takeProfitLevels[0]!,
      tp2: c.takeProfitLevels[1] ?? null,
      tp3: c.takeProfitLevels[2] ?? null,
      stopDistanceBps: c.stopDistanceBps ?? null,
      regime: inputs.regime,
      entryVariant: c.entryVariant ?? null,
      openedAt,
      closedAt: null,
      posture,
      regimeDirection,
      crowdingState: inputs.crowdingBySymbol?.[c.symbol] ?? null,
      scanBatchId: inputs.scanBatchId ?? null,
    };
    const observations = buildVariantMatrixObservationsForSignal(signal, inputs.now);
    store.addMany(observations);
    result.signalsCreated += 1;
    result.observationsCreated += observations.length;
  }
  // Only a productive batch advances the throttle — a dry cycle (all dupes/bad
  // geometry) may retry next cycle instead of burning the whole interval.
  if (result.signalsCreated > 0) lastBatchMs = nowMs;
  return result;
}

// ---------------------------------------------------------------------------
// Report — fresh-only, posture×direction, with risk-normalized dollars so lanes
// are comparable beyond the per-lane R-multiple (which alone is misleading).
// ---------------------------------------------------------------------------
const FIXED_RISK_USD = 100; // net $ per trade at $100 risk = netAvgR × 100 (R is risk-normalized)

export interface FreshLanePerfRow {
  variantId: string;
  n: number;
  netAvgR: number;
  winRate: number;
  profitFactor: number | null;
  netUsdPer100Risk: number; // dollar-comparable across lanes at fixed risk
  avgStopBps: number | null;
  avgHoldMinutes: number | null;
  avgEntryLagMinutes: number | null;
}

export interface FreshBucketRow {
  tradeDirection: "LONG" | "SHORT";
  posture: VariantPosture | "UNKNOWN";
  n: number;
  netAvgR: number;
  netUsdPer100Risk: number;
  winRate: number;
}

export interface FreshVariantMatrixReport {
  totalObs: number;
  resolved: number;
  freshValid: number; // resolved AND entered fresh (live-takeable)
  staleExcluded: number; // resolved but stale entry — counted out of the live read
  medianEntryLagMinutes: number | null;
  byBucket: FreshBucketRow[];
  byCrowding: Array<{ crowdingState: string; n: number; netAvgR: number; netUsdPer100Risk: number; winRate: number }>;
  lanes: FreshLanePerfRow[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function perf(rs: number[]): { netAvgR: number; winRate: number; profitFactor: number | null } {
  const n = rs.length;
  if (n === 0) return { netAvgR: 0, winRate: 0, profitFactor: null };
  const wins = rs.filter((r) => r > 0);
  const gl = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const gw = wins.reduce((a, b) => a + b, 0);
  return {
    netAvgR: rs.reduce((a, b) => a + b, 0) / n,
    winRate: wins.length / n,
    profitFactor: gl > 0 ? gw / gl : null,
  };
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function buildFreshVariantMatrixReport(store: CurrentGuardVariantMatrixStore): FreshVariantMatrixReport {
  const all = store.all;
  const resolved = all.filter(
    (o) => o.netR != null && Number.isFinite(o.netR) && (o.direction === "LONG" || o.direction === "SHORT"),
  );
  const fresh = resolved.filter((o) => o.isFreshValid === true);

  const byBucketMap = new Map<string, CurrentGuardVariantMatrixObservation[]>();
  const byLaneMap = new Map<string, CurrentGuardVariantMatrixObservation[]>();
  const byCrowdMap = new Map<string, CurrentGuardVariantMatrixObservation[]>();
  for (const o of fresh) {
    const bKey = `${o.direction}|${o.posture ?? "UNKNOWN"}`;
    (byBucketMap.get(bKey) ?? byBucketMap.set(bKey, []).get(bKey)!).push(o);
    (byLaneMap.get(o.variantId) ?? byLaneMap.set(o.variantId, []).get(o.variantId)!).push(o);
    const cKey = o.crowdingState ?? "UNTAGGED";
    (byCrowdMap.get(cKey) ?? byCrowdMap.set(cKey, []).get(cKey)!).push(o);
  }

  const byBucket: FreshBucketRow[] = [...byBucketMap.entries()].map(([k, list]) => {
    const [tradeDirection, posture] = k.split("|") as ["LONG" | "SHORT", VariantPosture | "UNKNOWN"];
    const p = perf(list.map((o) => o.netR!));
    return {
      tradeDirection,
      posture,
      n: list.length,
      netAvgR: p.netAvgR,
      netUsdPer100Risk: p.netAvgR * FIXED_RISK_USD,
      winRate: p.winRate,
    };
  }).sort((a, b) => b.n - a.n);

  const lanes: FreshLanePerfRow[] = [...byLaneMap.entries()].map(([variantId, list]) => {
    const p = perf(list.map((o) => o.netR!));
    return {
      variantId,
      n: list.length,
      netAvgR: p.netAvgR,
      winRate: p.winRate,
      profitFactor: p.profitFactor,
      netUsdPer100Risk: p.netAvgR * FIXED_RISK_USD,
      avgStopBps: avg(list.map((o) => o.stopDistanceBps).filter((x): x is number => x != null)),
      avgHoldMinutes: avg(list.map((o) => o.durationMinutes).filter((x): x is number => x != null)),
      avgEntryLagMinutes: avg(list.map((o) => o.entryLagMinutes).filter((x): x is number => x != null)),
    };
  }).sort((a, b) => b.n - a.n);

  const byCrowding = [...byCrowdMap.entries()].map(([crowdingState, list]) => {
    const p = perf(list.map((o) => o.netR!));
    return {
      crowdingState,
      n: list.length,
      netAvgR: p.netAvgR,
      netUsdPer100Risk: p.netAvgR * FIXED_RISK_USD,
      winRate: p.winRate,
    };
  }).sort((a, b) => b.n - a.n);

  return {
    totalObs: all.length,
    resolved: resolved.length,
    freshValid: fresh.length,
    staleExcluded: resolved.length - fresh.length,
    medianEntryLagMinutes: median(resolved.map((o) => o.entryLagMinutes).filter((x): x is number => x != null)),
    byBucket,
    byCrowding,
    lanes,
  };
}

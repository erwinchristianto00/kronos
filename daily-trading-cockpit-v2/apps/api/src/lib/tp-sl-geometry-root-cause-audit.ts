import type { ExternalDiscoveryEvidenceEra } from "./external-candidate-discovery-intelligence.js";
import {
  classifyExternalRotationOverlayValidity,
  type ExternalRotationOverlayObservation,
} from "./external-rotation-overlay.js";

/**
 * TP/SL GEOMETRY ROOT-CAUSE AUDIT (Phase 2E.3 follow-up diagnostic)
 *
 * Read-only audit that traces WHY external rotation shadow overlay observations
 * show such enormous gross-to-net cost drag (4.5-6.3R per trade). It is a follow-up
 * to the Economics Audit + Credibility Layer, designed to surface the underlying
 * entry-price unit mismatch that fabricates the appearance of "broken stop geometry".
 *
 * Key finding (from manual trace, this audit makes it inspectable per-observation):
 *
 *   The shared execution-plan.ts:`costDiagnostics(candidate, anchor, perf)` computes
 *   `stopDistanceBps` and `costR` against the variant-specific anchor (e.g.,
 *   fib.retracement500 for fib_500_entry, vwap for vwap_retest_entry).
 *
 *   The external-rotation-overlay resolver stores `entryPrice = candidate.currentPrice`
 *   (via plannedEntryPrice — see external-rotation-overlay.ts:318) and computes
 *   realizedGrossR using that entryPrice — NOT the anchor.
 *
 *   When `anchor ≠ currentPrice`, the costR is denominated in anchor-relative R
 *   units, but gross R is denominated in currentPrice-relative R units. The net R
 *   subtraction (gross - costR) is mathematically inconsistent.
 *
 *   For stablecoins / low-volatility pairs, the fib anchor can be near the stop,
 *   making anchor-relative risk near zero, which inflates costR to many R.
 *
 *   The active bot (shadow-engine.ts) does NOT have this bug because its own
 *   costDiagnostics uses the actual position entry (shadow-engine.ts:248,252).
 *
 * Does NOT change:
 *   - stop/TP formulas, resolver behavior, scanner selection, routing, gates,
 *     readiness, caps, or any live trading behavior.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TpSlGeometryRootCauseVerdict =
  | "EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH"
  | "EXTERNAL_DETACHED_PLAN_STOP_GEOMETRY_TOO_TIGHT"
  | "SHARED_STOP_GEOMETRY_WEAKNESS_EXTERNALLY_AMPLIFIED"
  | "COST_MODEL_NEEDS_DEEPER_AUDIT"
  | "INSUFFICIENT_EVIDENCE";

export type CostModelSanityStatus =
  | "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH"
  | "COST_MODEL_APPEARS_CORRECT"
  | "COST_MODEL_NEEDS_DEEPER_AUDIT"
  | "COST_MODEL_BUG_SUSPECTED";

export type ExternalVsActiveComparison =
  | "EXTERNAL_ONLY_GEOMETRY_FAILURE"
  | "SHARED_CORE_GEOMETRY_FAILURE"
  | "SHARED_BUT_EXTERNAL_AMPLIFIED"
  | "INSUFFICIENT_EVIDENCE";

export type RrInflationDriver =
  | "STOP_TOO_TIGHT_DENOMINATOR_INFLATION"
  | "TP_TOO_FAR_NUMERATOR_INFLATION"
  | "BOTH_TIGHT_STOP_AND_FAR_TP"
  | "INSUFFICIENT_EVIDENCE";

export interface PerObservationGeometryMismatch {
  observationId: string;
  symbol: string;
  hypotheticalEntryVariant: string | null;
  storedStopDistanceBps: number | null;       // anchor-relative (from costDiagnostics)
  actualStopDistanceBps: number | null;       // resolverEntry-relative (real fill risk)
  inflationRatio: number | null;              // actual / stored — >1 means stored is too tight
  storedCostR: number | null;                 // anchor-denominated
  realizedGrossR: number | null;
  realizedNetR: number | null;
  costDragR: number | null;                   // gross - net
  riskReward: number | null;
  classification:
    | "ENTRY_ANCHOR_FILL_MISMATCH"
    | "GENUINELY_TIGHT_STOP"
    | "CONSISTENT_GEOMETRY"
    | "UNRESOLVED";
}

export interface RouteVariantGeometryBreakdown {
  entryVariant: string;
  observationCount: number;
  resolvedCount: number;
  medianStoredStopBps: number | null;
  medianActualStopBps: number | null;
  medianInflationRatio: number | null;
  avgCostDragR: number | null;
  pctClassifiedAsMismatch: number | null;
}

export interface TpSlGeometryRootCauseAuditReport {
  generatedAt: string;
  evidenceEra: ExternalDiscoveryEvidenceEra;
  /** Total observations in era (raw, including legacy V1 — these are the ones the audit is FOR). */
  totalObservations: number;
  /** Count of resolved legacy V1 observations the audit was able to inspect. */
  resolvedObservations: number;
  /** Number of post-fix V2 observations in era (audit does not analyze these — they are anchor-consistent by construction). */
  postFixV2ObservationCount: number;
  rootCauseVerdict: TpSlGeometryRootCauseVerdict;
  rootCauseExplanation: string;
  secondaryGeometryFinding:
    | "ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE"
    | "NO_SEPARATE_GEOMETRY_AMPLIFIER_CONFIRMED"
    | "INSUFFICIENT_EVIDENCE";
  activeBotHasSameMismatchBug: boolean;
  legacyV1Only: true;
  costModelSanity: CostModelSanityStatus;
  costModelNotes: string[];
  externalVsActiveComparison: ExternalVsActiveComparison;
  externalVsActiveNotes: string[];
  rrInflationDriver: RrInflationDriver;
  rrInflationNotes: string[];
  perObservationMismatches: PerObservationGeometryMismatch[];
  routeVariantBreakdown: RouteVariantGeometryBreakdown[];
  pctObservationsWithMismatch: number | null;     // share where inflationRatio >= 2
  avgInflationRatio: number | null;
  strongestOffendingVariant: string | null;
  patchDirections: TpSlGeometryPatchDirection[];
  readiness: {
    advisoryEngineReady: boolean;
    readyForResolverBehaviorChange: false;
    readyForCostModelChange: false;
    reasons: string[];
  };
}

export interface TpSlGeometryPatchDirection {
  title: string;
  description: string;
  wouldFix: string;
  whereItWouldLive: string;
  priorityRank: number;
  whyNotImplementedNow: string;
  doesNotImplementNow: true;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MISMATCH_INFLATION_THRESHOLD = 2.0;   // ratio >= this is a mismatch
const MIN_RESOLVED_FOR_VERDICT = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─── Per-observation mismatch classifier ──────────────────────────────────────

export function classifyObservationGeometryMismatch(
  obs: ExternalRotationOverlayObservation,
): PerObservationGeometryMismatch {
  const snap = obs.detachedCandidateSnapshot;
  const state = obs.resolverState;
  const isResolved = obs.outcome?.fillStatus === "FILLED" && obs.outcome.realizedNetR !== null;

  const storedStopDistanceBps = snap.stopDistanceBps;
  const storedCostR = snap.costR;
  const realizedGrossR = obs.outcome?.realizedGrossR ?? null;
  const realizedNetR = obs.outcome?.realizedNetR ?? null;
  const costDragR =
    realizedGrossR !== null && realizedNetR !== null
      ? roundMetric(realizedGrossR - realizedNetR)
      : null;

  let actualStopDistanceBps: number | null = null;
  if (state?.entryPrice && state.stopPrice && state.entryPrice > 0) {
    const actualRiskPct = (Math.abs(state.entryPrice - state.stopPrice) / state.entryPrice) * 100;
    actualStopDistanceBps = roundMetric(actualRiskPct * 100, 2);
  }

  const inflationRatio =
    actualStopDistanceBps !== null && storedStopDistanceBps !== null && storedStopDistanceBps > 0
      ? roundMetric(actualStopDistanceBps / storedStopDistanceBps, 3)
      : null;

  let classification: PerObservationGeometryMismatch["classification"];
  if (!isResolved) {
    classification = "UNRESOLVED";
  } else if (inflationRatio !== null && inflationRatio >= MISMATCH_INFLATION_THRESHOLD) {
    classification = "ENTRY_ANCHOR_FILL_MISMATCH";
  } else if (
    storedStopDistanceBps !== null &&
    storedStopDistanceBps < 100 &&
    (inflationRatio === null || inflationRatio < MISMATCH_INFLATION_THRESHOLD)
  ) {
    classification = "GENUINELY_TIGHT_STOP";
  } else {
    classification = "CONSISTENT_GEOMETRY";
  }

  return {
    observationId: obs.observationId,
    symbol: obs.symbol,
    hypotheticalEntryVariant:
      typeof snap.hypotheticalEntryVariant === "string" ? snap.hypotheticalEntryVariant : null,
    storedStopDistanceBps,
    actualStopDistanceBps,
    inflationRatio,
    storedCostR,
    realizedGrossR,
    realizedNetR,
    costDragR,
    riskReward: snap.riskReward,
    classification,
  };
}

// ─── Route/variant breakdown ──────────────────────────────────────────────────

function buildRouteVariantBreakdown(
  mismatches: PerObservationGeometryMismatch[],
): RouteVariantGeometryBreakdown[] {
  const byVariant = new Map<string, PerObservationGeometryMismatch[]>();
  for (const m of mismatches) {
    const key = m.hypotheticalEntryVariant ?? "UNKNOWN";
    const list = byVariant.get(key) ?? [];
    list.push(m);
    byVariant.set(key, list);
  }

  const result: RouteVariantGeometryBreakdown[] = [];
  for (const [variant, list] of byVariant) {
    const resolved = list.filter((m) => m.classification !== "UNRESOLVED");
    const storedBps = resolved.map((m) => m.storedStopDistanceBps).filter((v): v is number => v !== null);
    const actualBps = resolved.map((m) => m.actualStopDistanceBps).filter((v): v is number => v !== null);
    const ratios = resolved.map((m) => m.inflationRatio).filter((v): v is number => v !== null);
    const drags = resolved.map((m) => m.costDragR).filter((v): v is number => v !== null);
    const mismatchCount = resolved.filter((m) => m.classification === "ENTRY_ANCHOR_FILL_MISMATCH").length;
    result.push({
      entryVariant: variant,
      observationCount: list.length,
      resolvedCount: resolved.length,
      medianStoredStopBps: median(storedBps),
      medianActualStopBps: median(actualBps),
      medianInflationRatio: median(ratios),
      avgCostDragR: average(drags),
      pctClassifiedAsMismatch: resolved.length > 0 ? roundMetric(mismatchCount / resolved.length) : null,
    });
  }

  return result.sort((a, b) => (b.avgCostDragR ?? 0) - (a.avgCostDragR ?? 0));
}

// ─── Cost model sanity ────────────────────────────────────────────────────────

function buildCostModelSanity(
  mismatches: PerObservationGeometryMismatch[],
): { status: CostModelSanityStatus; notes: string[] } {
  const resolved = mismatches.filter((m) => m.classification !== "UNRESOLVED");
  const mismatched = resolved.filter((m) => m.classification === "ENTRY_ANCHOR_FILL_MISMATCH");
  const notes: string[] = [];

  if (resolved.length < MIN_RESOLVED_FOR_VERDICT) {
    notes.push("Too few resolved observations to assess cost model sanity.");
    return { status: "COST_MODEL_NEEDS_DEEPER_AUDIT", notes };
  }

  const pctMismatch = mismatched.length / resolved.length;
  if (pctMismatch >= 0.4) {
    notes.push(
      `Cost model arithmetic appears internally consistent (costR = roundTripCostBps/100/riskPct), but it is applied using anchor-relative risk while gross R uses currentPrice-relative risk.`,
    );
    notes.push(
      `${mismatched.length}/${resolved.length} resolved observations show actual stop distance >= ${MISMATCH_INFLATION_THRESHOLD}x the stored stopDistanceBps — strong signature of entry-anchor / fill-price mismatch.`,
    );
    notes.push(
      "No double-subtraction detected: costR is subtracted once at observation close (external-rotation-overlay.ts:401). Net = gross - costR.",
    );
    return { status: "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH", notes };
  }

  notes.push("No systematic mismatch detected between stored stopDistanceBps and actual fill risk.");
  return { status: "COST_MODEL_APPEARS_CORRECT", notes };
}

// ─── External vs active comparison ────────────────────────────────────────────

function buildExternalVsActiveComparison(): {
  comparison: ExternalVsActiveComparison;
  notes: string[];
} {
  // This is a static finding based on code path tracing, not data comparison. The
  // active bot's shadow-engine.ts:248 costDiagnostics() takes the actual position
  // entryPrice directly and computes costR consistent with the resolver's gross R
  // (also using position.entryPrice). The external overlay's costR is sourced from
  // execution-plan.ts:448 costDiagnostics(candidate, anchor, perf) — using the
  // variant anchor (fib_500/vwap/etc.), while its resolver fills at currentPrice.
  return {
    comparison: "SHARED_BUT_EXTERNAL_AMPLIFIED",
    notes: [
      "Active bot does NOT share the same entry-anchor / fill-price mismatch bug. That bug was specific to legacy V1 external overlay observations.",
      "Active bot (shadow-engine.ts:248-265): costR computed from position.entryPrice (= actual fill price). Resolver gross R uses the same entryPrice. Cost arithmetic is unit-consistent.",
      "External overlay (external-rotation-overlay.ts:318): resolver entryPrice = candidate.currentPrice (plannedEntryPrice). But costR is sourced from execution-plan.ts:448 costDiagnostics(candidate, anchor, perf), where anchor = fib retracement / vwap / ema20.",
      "When anchor != currentPrice, costR is denominated in anchor-risk units but applied as a subtraction from gross R in currentPrice-risk units. Mathematically inconsistent.",
      "Historical active-bot stop geometry pain (ULTRA_TIGHT bucket <100bps shown toxic by stop-geometry-audit.ts) is real, BUT the external overlay's apparent stop tightness is largely an artifact of measuring against anchor rather than fill price.",
    ],
  };
}

function buildSecondaryGeometryFinding(
  mismatches: PerObservationGeometryMismatch[],
  pctMismatch: number,
  resolvedCount: number,
  rrInflationDriver: RrInflationDriver,
): TpSlGeometryRootCauseAuditReport["secondaryGeometryFinding"] {
  if (resolvedCount < MIN_RESOLVED_FOR_VERDICT) {
    return "INSUFFICIENT_EVIDENCE";
  }
  const genuinelyTightCount = mismatches.filter((m) => m.classification === "GENUINELY_TIGHT_STOP").length;
  const tightStoredStopCount = mismatches.filter((m) => m.storedStopDistanceBps !== null && m.storedStopDistanceBps < 100).length;
  if ((pctMismatch > 0 || rrInflationDriver === "STOP_TOO_TIGHT_DENOMINATOR_INFLATION") && tightStoredStopCount / resolvedCount >= 0.5) {
    return "ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE";
  }
  if (genuinelyTightCount / resolvedCount >= 0.5) {
    return "ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE";
  }
  return "NO_SEPARATE_GEOMETRY_AMPLIFIER_CONFIRMED";
}

// ─── RR inflation analysis ────────────────────────────────────────────────────

function buildRrInflationAnalysis(
  mismatches: PerObservationGeometryMismatch[],
): { driver: RrInflationDriver; notes: string[] } {
  const resolved = mismatches.filter((m) => m.classification !== "UNRESOLVED");
  if (resolved.length < MIN_RESOLVED_FOR_VERDICT) {
    return {
      driver: "INSUFFICIENT_EVIDENCE",
      notes: ["Too few resolved observations to assess RR inflation driver."],
    };
  }

  const rrs = resolved.map((m) => m.riskReward).filter((v): v is number => v !== null);
  const avgRr = average(rrs);
  const tightStopCount = resolved.filter((m) => m.storedStopDistanceBps !== null && m.storedStopDistanceBps < 100).length;
  const pctTightStop = tightStopCount / resolved.length;
  const highRrAlsoTightStop = resolved.filter(
    (m) =>
      m.riskReward !== null &&
      m.riskReward >= 5 &&
      m.storedStopDistanceBps !== null &&
      m.storedStopDistanceBps < 100,
  ).length;
  const highRrCount = resolved.filter((m) => m.riskReward !== null && m.riskReward >= 5).length;
  const pctHighRrAlsoTightStop = highRrCount > 0 ? highRrAlsoTightStop / highRrCount : 0;

  const notes: string[] = [
    `Avg RR across resolved observations: ${avgRr !== null ? avgRr.toFixed(2) : "n/a"}x.`,
    `${tightStopCount}/${resolved.length} resolved obs have stored stopDistanceBps < 100bps (${(pctTightStop * 100).toFixed(1)}%).`,
    `${highRrAlsoTightStop}/${highRrCount} high-RR (>=5x) observations also have stored stop < 100bps (${(pctHighRrAlsoTightStop * 100).toFixed(1)}% of high-RR cases).`,
  ];

  if (pctHighRrAlsoTightStop >= 0.7) {
    notes.push(
      "High RR is predominantly driven by tiny stop denominator (anchor-relative). TP distance numerator is normal.",
    );
    return { driver: "STOP_TOO_TIGHT_DENOMINATOR_INFLATION", notes };
  }
  if (pctTightStop < 0.3 && avgRr !== null && avgRr >= 5) {
    return { driver: "TP_TOO_FAR_NUMERATOR_INFLATION", notes };
  }
  return { driver: "BOTH_TIGHT_STOP_AND_FAR_TP", notes };
}

// ─── Patch directions (no implementation) ─────────────────────────────────────

function buildPatchDirections(): TpSlGeometryPatchDirection[] {
  return [
    {
      title: "Recompute costR at observation fill time using actual resolver entryPrice",
      description:
        "When the overlay resolver records a fill (entryPrice = candidate.currentPrice), recompute costR using costDiagnostics(currentPrice, stopPrice, spreadPct) so it is in the same R-units as realizedGrossR.",
      wouldFix:
        "Eliminates the unit mismatch between gross R (currentPrice-risk) and costR (anchor-risk). Cost drag would reflect actual fee/slippage in actual fill units.",
      whereItWouldLive:
        "apps/api/src/lib/external-rotation-overlay.ts — buildObservation() near line 311 (replace costR snapshot) or closeObservation() near line 401 (recompute before subtraction).",
      priorityRank: 1,
      whyNotImplementedNow:
        "This is an audit task only. The user requested no behavior change to overlay resolver or cost model. Implementation must be reviewed and explicitly authorized.",
      doesNotImplementNow: true,
    },
    {
      title: "Use variant anchor as resolver entryPrice (align overlay with active-bot semantics)",
      description:
        "Set the overlay resolver's entryPrice to the variant anchor (fib_500_retracement, vwap, etc.) instead of candidate.currentPrice, so the fill semantics match the active bot. Resolver gross R would then be in the same R-units as the stored costR.",
      wouldFix:
        "Restores consistency between costR computation and gross R denominator. Same fix path as the active bot.",
      whereItWouldLive:
        "apps/api/src/lib/external-rotation-overlay.ts — plannedEntryPrice() and derivePlanPrices() near line 207-238.",
      priorityRank: 2,
      whyNotImplementedNow:
        "Audit-only task. Also changes overlay fill semantics; may meaningfully alter which candidates fill within 24h expiry. Requires explicit authorization.",
      doesNotImplementNow: true,
    },
    {
      title: "Add resolver geometry guard rejecting observations where anchor-to-stop distance is < N bps",
      description:
        "Reject observation creation when storedStopDistanceBps < some floor (e.g., 50 bps), since these produce uninterpretable economics regardless of which fix path is chosen.",
      wouldFix:
        "Prevents creation of observations whose costR / gross R unit mismatch is most catastrophic.",
      whereItWouldLive:
        "apps/api/src/lib/external-rotation-overlay.ts — buildObservation() near line 276 (after derivePlanPrices()).",
      priorityRank: 3,
      whyNotImplementedNow:
        "Audit-only task. This is a hand-tuned threshold; should follow the unit-mismatch fix, not precede it.",
      doesNotImplementNow: true,
    },
    {
      title: "Active-bot route geometry guard refinement (already known toxic ULTRA_TIGHT bucket)",
      description:
        "Independent of the overlay fix, the active bot's stop-geometry-audit.ts has historically shown <100bps and <175bps stop buckets as net-toxic. A guard rejecting active routes below a minimum stop floor would further reduce real-money cost drag.",
      wouldFix: "Active bot cost drag in genuinely tight-stop trades.",
      whereItWouldLive: "active scanner / ProfitRoutingAgent — exact location to be determined.",
      priorityRank: 4,
      whyNotImplementedNow:
        "Audit-only task. Active bot guard scope is broader than this audit; needs separate authorization.",
      doesNotImplementNow: true,
    },
  ];
}

// ─── Root cause verdict ───────────────────────────────────────────────────────

function buildRootCauseVerdict(
  mismatches: PerObservationGeometryMismatch[],
  pctMismatch: number,
  resolvedCount: number,
): { verdict: TpSlGeometryRootCauseVerdict; explanation: string } {
  if (resolvedCount < MIN_RESOLVED_FOR_VERDICT) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      explanation: `Only ${resolvedCount} FILLED resolved observations — cannot reliably classify TP/SL geometry root cause.`,
    };
  }
  if (pctMismatch >= 0.4) {
    return {
      verdict: "EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH",
      explanation:
        "costR (and stopDistanceBps) are computed by shared execution-plan.ts costDiagnostics() using the variant anchor (e.g., fib_500_retracement, vwap), " +
        "but the external-rotation-overlay resolver fills at candidate.currentPrice. " +
        "When anchor != currentPrice, costR is in anchor-risk R-units while realizedGrossR is in currentPrice-risk R-units. " +
        "The cost subtraction (net = gross - costR) is mathematically inconsistent, producing fabricated cost drag. " +
        "This is external-overlay-specific; the active bot computes costR from its actual fill price (shadow-engine.ts:248) and does not suffer this bug.",
    };
  }
  if (mismatches.filter((m) => m.classification === "GENUINELY_TIGHT_STOP").length / resolvedCount >= 0.5) {
    return {
      verdict: "SHARED_STOP_GEOMETRY_WEAKNESS_EXTERNALLY_AMPLIFIED",
      explanation:
        "Stored stop distances are genuinely tight in resolver units too. Same toxicity that the active bot's ULTRA_TIGHT bucket has shown historically, possibly amplified by external-symbol structural geometry.",
    };
  }
  return {
    verdict: "EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH",
    explanation:
      "Legacy V1 external overlay observations remain dominated by the proven entry-anchor / fill-price mismatch. Tight stop geometry may still amplify damage, but it is not the primary corruption mechanism.",
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildTpSlGeometryRootCauseAuditReport(
  observations: ExternalRotationOverlayObservation[],
  opts: { evidenceEra?: ExternalDiscoveryEvidenceEra } = {},
  now: Date = new Date(),
): TpSlGeometryRootCauseAuditReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const rawEraObservations =
    evidenceEra === "ALL_TIME"
      ? observations
      : observations.filter((obs) => obs.evidenceEra === "POST_CALIBRATION");
  // Audit is targeted at legacy V1 observations (which carry the entry-anchor /
  // fill-price unit mismatch). V2 observations are anchor-consistent by
  // construction and don't need root-cause classification.
  const legacyEraObservations = rawEraObservations.filter(
    (obs) => classifyExternalRotationOverlayValidity(obs) === "LEGACY_ENTRY_ANCHOR_FILL_MISMATCH",
  );
  const postFixV2ObservationCount = rawEraObservations.length - legacyEraObservations.length;
  const eraObservations = legacyEraObservations;

  const mismatches = eraObservations.map(classifyObservationGeometryMismatch);
  const resolved = mismatches.filter((m) => m.classification !== "UNRESOLVED");
  const resolvedCount = resolved.length;

  const ratios = resolved.map((m) => m.inflationRatio).filter((v): v is number => v !== null);
  const avgInflationRatio = average(ratios);
  const mismatchCount = resolved.filter((m) => m.classification === "ENTRY_ANCHOR_FILL_MISMATCH").length;
  const pctObservationsWithMismatch = resolvedCount > 0 ? roundMetric(mismatchCount / resolvedCount) : null;
  const pctMismatch = resolvedCount > 0 ? mismatchCount / resolvedCount : 0;

  const routeVariantBreakdown = buildRouteVariantBreakdown(mismatches);
  const initialCostModelSanity = buildCostModelSanity(mismatches);
  const externalVsActive = buildExternalVsActiveComparison();
  const rrAnalysis = buildRrInflationAnalysis(mismatches);
  const { verdict: rootCauseVerdict, explanation: rootCauseExplanation } = buildRootCauseVerdict(
    mismatches,
    pctMismatch,
    resolvedCount,
  );
  const secondaryGeometryFinding = buildSecondaryGeometryFinding(mismatches, pctMismatch, resolvedCount, rrAnalysis.driver);
  const costModelSanity = rootCauseVerdict === "EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH"
    ? {
        status: "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH" as const,
        notes: initialCostModelSanity.status === "COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH"
          ? initialCostModelSanity.notes
          : [
              "Cost subtraction was not double-counted; the problem was that legacy V1 costR and grossR were normalized against different entry bases.",
              ...initialCostModelSanity.notes,
            ],
      }
    : initialCostModelSanity;
  const strongestOffendingVariant =
    routeVariantBreakdown.length > 0 && (routeVariantBreakdown[0]?.avgCostDragR ?? 0) > 0
      ? routeVariantBreakdown[0]!.entryVariant
      : null;

  const readinessReasons: string[] = [
    "TP/SL geometry root-cause audit is read-only advisory diagnostics only.",
    "readyForResolverBehaviorChange is always false — audit does not authorize overlay resolver changes.",
    "readyForCostModelChange is always false — audit does not authorize cost computation changes.",
  ];
  if (resolvedCount < MIN_RESOLVED_FOR_VERDICT) {
    readinessReasons.unshift(`Only ${resolvedCount} resolved observations — verdict confidence is low.`);
  }

  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    totalObservations: eraObservations.length,
    resolvedObservations: resolvedCount,
    postFixV2ObservationCount,
    rootCauseVerdict,
    rootCauseExplanation,
    secondaryGeometryFinding,
    activeBotHasSameMismatchBug: false,
    legacyV1Only: true,
    costModelSanity: costModelSanity.status,
    costModelNotes: costModelSanity.notes,
    externalVsActiveComparison: externalVsActive.comparison,
    externalVsActiveNotes: externalVsActive.notes,
    rrInflationDriver: rrAnalysis.driver,
    rrInflationNotes: rrAnalysis.notes,
    perObservationMismatches: mismatches,
    routeVariantBreakdown,
    pctObservationsWithMismatch,
    avgInflationRatio: avgInflationRatio !== null ? roundMetric(avgInflationRatio, 3) : null,
    strongestOffendingVariant,
    patchDirections: buildPatchDirections(),
    readiness: {
      advisoryEngineReady: eraObservations.length > 0,
      readyForResolverBehaviorChange: false,
      readyForCostModelChange: false,
      reasons: readinessReasons,
    },
  };
}

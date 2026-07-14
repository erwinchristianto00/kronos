/**
 * Pre-registered block compatibility distance (Market Digital Twin, Phase 2B). Scores how well a candidate block's
 * INITIAL state (from its FROZEN causal prefix) continues the terminal state at the end of the just-placed block.
 * Every numeric feature is normalized by a scale computed from CALIBRATION ONLY, so no high-unit feature dominates and
 * the holdout/development data never influences the normalizer. Categorical features (regime, weekend) contribute a
 * 0/1 term; hour-of-day uses a circular distance. Funding + mark-basis are UNSUPPORTED in a candle-only corpus and are
 * reported as missing components (never fabricated, never counted as compatible). Pure + deterministic.
 */
import type { BlockTransitionState } from "./block-transition-state.js";
import { std, mean } from "./calibration-metrics.js";

/** Numeric features whose scale is learned from calibration. (categorical/circular handled separately) */
export const NUMERIC_FEATURES = ["volatilityShort", "volatilityMedium", "volumeZScore", "recentReturn", "trendSlope", "btcEthCorrelation", "ethBetaToBtc"] as const;
export type NumericFeature = (typeof NUMERIC_FEATURES)[number];

/** Fallback hierarchy: the ACTIVE feature set shrinks as we relax. Matches the operator's required hierarchy. */
export const RELAX_LEVELS: { name: string; features: string[] }[] = [
  { name: "EXACT", features: ["regimeFamily", "volatilityShort", "volatilityMedium", "volumeZScore", "recentReturn", "trendSlope", "wickBodyProfile", "btcEthCorrelation", "ethBetaToBtc", "hourOfDay", "weekend"] },
  { name: "RELAX_HOUR", features: ["regimeFamily", "volatilityShort", "volatilityMedium", "volumeZScore", "recentReturn", "trendSlope", "wickBodyProfile", "btcEthCorrelation", "ethBetaToBtc", "weekend"] },
  { name: "RELAX_WEEKDAY", features: ["regimeFamily", "volatilityShort", "volatilityMedium", "volumeZScore", "recentReturn", "trendSlope", "wickBodyProfile", "btcEthCorrelation", "ethBetaToBtc"] },
  { name: "REGIME_VOL_VOLUME", features: ["regimeFamily", "volatilityShort", "volatilityMedium", "volumeZScore"] },
  { name: "REGIME_VOL", features: ["regimeFamily", "volatilityShort", "volatilityMedium"] },
];
export const INSUFFICIENT = "INSUFFICIENT_COMPATIBLE_BLOCKS";

export interface CompatibilityNormalizer {
  scales: Record<NumericFeature, number>; // per-feature robust scale (std over calibration terminal states)
  wickScale: number; // scale for the wick/body profile distance
  supportSigma: number; // a component is "within support" if its normalized distance ≤ this
}

/** Build the normalizer from CALIBRATION terminal states only. */
export function buildCompatibilityNormalizer(calibrationStates: readonly BlockTransitionState[], supportSigma = 2.5): CompatibilityNormalizer {
  const scales = {} as Record<NumericFeature, number>;
  for (const f of NUMERIC_FEATURES) {
    const vals = calibrationStates.map((s) => s[f]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    scales[f] = (std(vals) ?? 1) || 1;
  }
  const wickVals: number[] = [];
  for (const s of calibrationStates) for (const w of s.wickBodyProfile) if (Number.isFinite(w)) wickVals.push(w);
  const wickScale = (std(wickVals) ?? 0.1) || 0.1;
  return { scales, wickScale, supportSigma };
}

export interface BlockCompatibilityAssessment {
  candidateBlockId: string;
  totalDistance: number;
  componentDistances: Record<string, number | null>;
  missingComponents: string[];
  withinEmpiricalSupport: boolean;
  candidateRank: number; // filled by the selector after ranking
  selectionProbability: number; // filled by the selector
}

/** Circular hour distance in [0,1] (0 = same hour, 1 = 12h apart). */
function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d) / 12;
}

/**
 * Assess a candidate's initial state against the current terminal state for a given ACTIVE feature set. Returns
 * per-component NORMALIZED distances, the mean over active+present components as `totalDistance`, the missing
 * components (null in either state — e.g. funding/mark-basis, or corr on a too-short window), and whether EVERY active
 * present component is within `supportSigma`.
 */
export function assessCompatibility(candidateBlockId: string, terminal: BlockTransitionState, initial: BlockTransitionState, normalizer: CompatibilityNormalizer, activeFeatures: readonly string[]): BlockCompatibilityAssessment {
  const componentDistances: Record<string, number | null> = {};
  const missing: string[] = [];
  const present: number[] = [];
  let withinSupport = true;
  for (const f of activeFeatures) {
    let d: number | null = null;
    if (f === "regimeFamily") {
      d = terminal.regimeFamily != null && initial.regimeFamily != null ? (terminal.regimeFamily === initial.regimeFamily ? 0 : 1) : null;
    } else if (f === "weekend") {
      d = terminal.weekend === initial.weekend ? 0 : 1;
    } else if (f === "hourOfDay") {
      d = hourDistance(terminal.hourOfDay, initial.hourOfDay);
    } else if (f === "wickBodyProfile") {
      const diffs: number[] = [];
      for (let i = 0; i < terminal.wickBodyProfile.length; i += 1) { const tv = terminal.wickBodyProfile[i]; const cv = initial.wickBodyProfile[i]; if (typeof tv === "number" && typeof cv === "number") diffs.push(Math.abs(tv - cv) / normalizer.wickScale); }
      d = diffs.length ? (mean(diffs) ?? null) : null;
    } else {
      const nf = f as NumericFeature;
      const tv = terminal[nf]; const cv = initial[nf];
      d = typeof tv === "number" && typeof cv === "number" && Number.isFinite(tv) && Number.isFinite(cv) ? Math.abs(tv - cv) / normalizer.scales[nf] : null;
    }
    componentDistances[f] = d;
    if (d == null) { missing.push(f); continue; }
    present.push(d);
    // regime + weekend are hard categorical gates within their active level (a mismatch ⇒ not within support)
    if (f === "regimeFamily" && d > 0) withinSupport = false;
    if (d > normalizer.supportSigma) withinSupport = false;
  }
  const totalDistance = present.length ? present.reduce((a, v) => a + v, 0) / present.length : Number.POSITIVE_INFINITY;
  return { candidateBlockId, totalDistance, componentDistances, missingComponents: missing, withinEmpiricalSupport: withinSupport, candidateRank: -1, selectionProbability: 0 };
}

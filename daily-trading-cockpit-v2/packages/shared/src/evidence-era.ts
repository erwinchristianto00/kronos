/**
 * EVIDENCE ERA
 *
 * Deterministic era classifier for shadow positions / tracker records. Lets us
 * isolate "current decision-policy" performance from legacy toxic data so
 * cohort reports don't mix three different planner generations.
 *
 *   LEGACY_PRE_ROUTING:               No routeMode on the persisted plan.
 *   POST_ROUTING_PRE_CALIBRATION:     routeMode exists; no calibration fields.
 *   POST_CALIBRATION:                 calibration fields exist.
 *   UNKNOWN:                          shape doesn't fit any known era.
 *
 * Inference is read-only. Old records are never mutated. New records emitted
 * by buildVariantSelection carry the `evidenceEra` + `decisionPolicyVersion`
 * fields directly, so they don't need inference at all.
 */

import type { VariantSelectionSnapshot } from "./types.js";
import { DECISION_PIPELINE_POLICY_VERSION } from "./policy-versions.js";

export type EvidenceEra =
  | "LEGACY_PRE_END_TO_END_CORRECTNESS_FIX"
  | "POST_END_TO_END_CORRECTNESS_FIX_V1"
  | "LEGACY_PRE_ROUTING"
  | "POST_ROUTING_PRE_CALIBRATION"
  | "POST_CALIBRATION"
  | "UNKNOWN";

/** Bumped whenever decision-policy changes meaningfully. Stamped on every new plan. */
export const CURRENT_DECISION_POLICY_VERSION = DECISION_PIPELINE_POLICY_VERSION;

/** The era that all new records are emitted under. */
/**
 * The versioned post-fix era is only emitted by this deployment.  Records
 * without an explicit stamp remain legacy; no filesystem timestamp inference
 * is used anywhere in this classifier.
 */
export const CURRENT_EVIDENCE_ERA: EvidenceEra = "POST_END_TO_END_CORRECTNESS_FIX_V1";

/** Minimal shape needed to classify — keeps callers from importing all of ShadowPosition. */
export interface EvidenceEraSubject {
  variantSelection?: Pick<
    VariantSelectionSnapshot,
    | "routeMode"
    | "calibratedExpectedNetR"
    | "calibrationVerdict"
    | "evidenceEra"
    | "decisionPolicyVersion"
  > | null;
}

/**
 * Read the explicitly-stamped era when present, otherwise infer from the
 * persisted plan's shape. Does NOT mutate the input.
 */
export function classifyEvidenceEra(subject: EvidenceEraSubject | null | undefined): EvidenceEra {
  const sel = subject?.variantSelection ?? null;
  if (!sel) return "LEGACY_PRE_ROUTING";

  // Stamped on the record? Trust it.
  if (sel.evidenceEra) return sel.evidenceEra;

  const hasRouteMode = typeof sel.routeMode === "string" && sel.routeMode.length > 0;
  const hasCalibration =
    sel.calibratedExpectedNetR !== undefined ||
    sel.calibrationVerdict !== undefined;

  // Shape inference exists solely to display historical audit data. It never
  // grants a record the post-fix era or makes it eligible for new routing.
  if (!hasRouteMode && !hasCalibration) return "LEGACY_PRE_ROUTING";
  if (hasRouteMode && !hasCalibration) return "POST_ROUTING_PRE_CALIBRATION";
  if (hasCalibration) return "POST_CALIBRATION";
  return "UNKNOWN";
}

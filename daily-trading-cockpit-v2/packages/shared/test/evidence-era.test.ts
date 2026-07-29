import { describe, expect, it } from "vitest";

import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  classifyEvidenceEra,
  hasCurrentPostFixPolicyStamp,
} from "../src/evidence-era.js";
import {
  END_TO_END_CORRECTNESS_DEPLOYED_AT,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
} from "../src/policy-versions.js";

describe("classifyEvidenceEra", () => {
  it("returns LEGACY_PRE_ROUTING when there is no variantSelection", () => {
    expect(classifyEvidenceEra(null)).toBe("LEGACY_PRE_ROUTING");
    expect(classifyEvidenceEra(undefined)).toBe("LEGACY_PRE_ROUTING");
    expect(classifyEvidenceEra({ variantSelection: null })).toBe("LEGACY_PRE_ROUTING");
  });

  it("returns POST_ROUTING_PRE_CALIBRATION when routeMode exists but no calibration fields", () => {
    expect(
      classifyEvidenceEra({
        variantSelection: { routeMode: "PROFIT_CANDIDATE" } as never,
      }),
    ).toBe("POST_ROUTING_PRE_CALIBRATION");
  });

  it("returns POST_CALIBRATION when calibration fields are present", () => {
    expect(
      classifyEvidenceEra({
        variantSelection: {
          routeMode: "DATA_COLLECTION",
          calibratedExpectedNetR: -0.2,
          calibrationVerdict: "RAW_EDGE_NOT_VALIDATED",
        } as never,
      }),
    ).toBe("POST_CALIBRATION");
  });

  it("trusts an explicitly-stamped evidenceEra over shape inference", () => {
    expect(
      classifyEvidenceEra({
        variantSelection: {
          // shape suggests POST_ROUTING but the stamp wins
          routeMode: "PROFIT_CANDIDATE",
          evidenceEra: "POST_CALIBRATION",
        } as never,
      }),
    ).toBe("POST_CALIBRATION");
  });

  it("exports stable constants", () => {
    expect(CURRENT_EVIDENCE_ERA).toBe("POST_END_TO_END_CORRECTNESS_FIX_V1");
    expect(typeof CURRENT_DECISION_POLICY_VERSION).toBe("string");
    expect(CURRENT_DECISION_POLICY_VERSION.length).toBeGreaterThan(0);
  });

  it("requires every economic policy stamp for post-fix eligibility", () => {
    const current = {
      evidenceEra: CURRENT_EVIDENCE_ERA,
      decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      policyDeploymentAt: END_TO_END_CORRECTNESS_DEPLOYED_AT,
    };
    expect(hasCurrentPostFixPolicyStamp(current)).toBe(true);
    expect(hasCurrentPostFixPolicyStamp({ ...current, executionPolicyVersion: null })).toBe(false);
    expect(hasCurrentPostFixPolicyStamp({ ...current, policyDeploymentAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });
});

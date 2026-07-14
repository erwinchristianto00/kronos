/**
 * Provenance hierarchy + learning-firewall tests (Market Digital Twin, Phase-1 foundation).
 */
import { describe, it, expect } from "vitest";
import { PROVENANCE_RANK, provenanceRank, eligibilityFor, combineProvenance, isPhase1LearningForbidden, type SimulationProvenance } from "../src/simulation/simulation-provenance.js";
import { buildRunIdentity } from "../src/simulation/simulation-run-identity.js";
import { buildSimulationReport } from "../src/simulation/simulation-report.js";
import { SIMULATION_SAFETY_CONFIG } from "../src/simulation/simulation-safety-boundary.js";
import { checkFrameStreamInvariants } from "../src/simulation/simulation-invariants.js";
import { checkDatasetSeparation } from "../src/simulation/calibration-dataset.js";

describe("provenance hierarchy", () => {
  it("ranks most-grounded → least; OBSERVED_HISTORICAL is rank 0, UNCONSTRAINED_SYNTHETIC last", () => {
    expect(PROVENANCE_RANK[0]).toBe("OBSERVED_HISTORICAL");
    expect(PROVENANCE_RANK.at(-1)).toBe("UNCONSTRAINED_SYNTHETIC");
    expect(provenanceRank("OBSERVED_HISTORICAL")).toBeLessThan(provenanceRank("STRESS_PERTURBATION"));
  });
  it("combining provenance takes the LEAST-grounded (never silently upgrades synthetic to look historical)", () => {
    expect(combineProvenance("OBSERVED_HISTORICAL", "ADVERSARIAL_SYNTHETIC")).toBe("ADVERSARIAL_SYNTHETIC");
    expect(combineProvenance("HISTORICAL_BOOTSTRAP", "EMPIRICALLY_CALIBRATED")).toBe("EMPIRICALLY_CALIBRATED");
  });
  it("eligibility matrix: no phase-1 eligibility is REAL_DATA_ELIGIBLE (firewall)", () => {
    const all: SimulationProvenance[] = [...PROVENANCE_RANK];
    for (const p of all) {
      const e = eligibilityFor(p);
      expect(e.phase1Eligibility).not.toBe("REAL_DATA_ELIGIBLE");
      expect(isPhase1LearningForbidden(e.phase1Eligibility)).toBe(true);
    }
    // observed/bootstrap/calibrated ⇒ TRANSFER_TEST_REQUIRED; stress/adversarial/unconstrained ⇒ STRESS_TEST_ONLY
    expect(eligibilityFor("OBSERVED_HISTORICAL").phase1Eligibility).toBe("TRANSFER_TEST_REQUIRED");
    expect(eligibilityFor("STRESS_PERTURBATION").phase1Eligibility).toBe("STRESS_TEST_ONLY");
    expect(eligibilityFor("UNCONSTRAINED_SYNTHETIC").phase1Eligibility).toBe("STRESS_TEST_ONLY");
  });
});

describe("simulation report + firewall", () => {
  it("report carries the ≤TRANSFER learning eligibility and ENFORCED_NO_TRAINING firewall", () => {
    const identity = buildRunIdentity({ seed: 1, provenance: "HISTORICAL_BOOTSTRAP", configuration: {}, sourceChecksums: ["abc"], startedAtProcessingMs: 0 });
    const report = buildSimulationReport({
      identity, safety: SIMULATION_SAFETY_CONFIG, frameCount: 0, gaps: 0,
      invariants: checkFrameStreamInvariants([]),
    });
    expect(report.learningFirewall).toBe("ENFORCED_NO_TRAINING");
    expect(report.learningEligibility).toBe("TRANSFER_TEST_REQUIRED");
    expect(report.safety.orderPlacementDisabled).toBe(true);
    expect(isPhase1LearningForbidden(report.learningEligibility)).toBe(true);
  });
});

describe("parameter-lock dataset separation", () => {
  it("requires all four partitions and rejects same-origin cross-partition overlap", () => {
    const ok = checkDatasetSeparation([
      { role: "calibration", windows: [{ startMs: 0, endMs: 100, origin: "real" }] },
      { role: "development-validation", windows: [{ startMs: 100, endMs: 200, origin: "real" }] },
      { role: "untouched-realism-holdout", windows: [{ startMs: 200, endMs: 300, origin: "real" }] },
      { role: "untouched-transfer-holdout", windows: [{ startMs: 300, endMs: 400, origin: "real" }] },
    ]);
    expect(ok.ok).toBe(true);
    const bad = checkDatasetSeparation([
      { role: "calibration", windows: [{ startMs: 0, endMs: 150, origin: "real" }] },
      { role: "development-validation", windows: [{ startMs: 100, endMs: 200, origin: "real" }] }, // overlaps calibration
      { role: "untouched-realism-holdout", windows: [] },
      { role: "untouched-transfer-holdout", windows: [] },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.includes("overlap"))).toBe(true);
  });
});

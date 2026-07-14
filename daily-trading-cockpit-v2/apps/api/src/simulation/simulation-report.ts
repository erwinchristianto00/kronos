/**
 * Simulation report shape (Market Digital Twin, Phase-1 foundation). A report-only summary of a run: identity,
 * safety config, source provenance/checksums, frame counts, realism assessment, stylized-facts gate, invariant
 * result, and the LEARNING-FIREWALL eligibility (this phase: never REAL_DATA_ELIGIBLE). Pure builder.
 */
import type { SimulationRunIdentity } from "./simulation-run-identity.js";
import type { SimulationSafetyConfig } from "./simulation-types.js";
import type { RealismAssessment } from "./realism-assessment.js";
import type { StylizedFactsGate } from "./realism-gate.js";
import type { InvariantReport } from "./simulation-invariants.js";
import type { ExperienceLearningEligibility, SimulationProvenance } from "./simulation-provenance.js";
import { eligibilityFor } from "./simulation-provenance.js";

export interface SimulationReport {
  reportKind: "SIMULATION_FOUNDATION_REPORT";
  identity: SimulationRunIdentity;
  safety: SimulationSafetyConfig;
  provenance: SimulationProvenance;
  frameCount: number;
  gaps: number;
  invariants: InvariantReport;
  realism: RealismAssessment | null;
  stylizedFacts: StylizedFactsGate | null;
  /** The eligibility EVERY experience from this run must carry — enforced ≤ TRANSFER_TEST_REQUIRED this phase. */
  learningEligibility: ExperienceLearningEligibility;
  learningFirewall: "ENFORCED_NO_TRAINING";
  notes: string[];
}

export function buildSimulationReport(args: {
  identity: SimulationRunIdentity;
  safety: SimulationSafetyConfig;
  frameCount: number;
  gaps: number;
  invariants: InvariantReport;
  realism?: RealismAssessment | null;
  stylizedFacts?: StylizedFactsGate | null;
  notes?: string[];
}): SimulationReport {
  return {
    reportKind: "SIMULATION_FOUNDATION_REPORT",
    identity: args.identity,
    safety: args.safety,
    provenance: args.identity.provenance,
    frameCount: args.frameCount,
    gaps: args.gaps,
    invariants: args.invariants,
    realism: args.realism ?? null,
    stylizedFacts: args.stylizedFacts ?? null,
    learningEligibility: eligibilityFor(args.identity.provenance).phase1Eligibility,
    learningFirewall: "ENFORCED_NO_TRAINING",
    notes: args.notes ?? [],
  };
}

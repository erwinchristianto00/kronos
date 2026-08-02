import { describe, expect, it } from "vitest";
import {
  _resetCortexProductionChainDiagnosticsForTests,
  cortexProductionChainDiagnostics,
  recordCortexProductionChainDiagnostic,
  type CortexProductionChainDiagnosticCode,
} from "../src/lib/cortex-production-chain-diagnostics.js";

// Point 11: the full set of codes this module must expose, including the seven added this stage.
// Keeping this list explicit (rather than deriving it from the module under test) means a future
// accidental removal of a code from the union/array is caught here, not silently.
const ALL_CODES: readonly CortexProductionChainDiagnosticCode[] = [
  "CORTEX_SNAPSHOT_SCAN_MISSING",
  "CORTEX_PAPER_LANE_UNMAPPED",
  "CORTEX_CANONICAL_LANE_MISMATCH",
  "CORTEX_ALLOCATION_BRIDGE_MISSING",
  "CORTEX_EXECUTIVE_ATTACHMENT_REJECTED",
  "CORTEX_SCAN_PUBLICATION_CONFLICT",
  "CORTEX_STRATEGY_MAPPING_MISMATCH",
  "CORTEX_CANDIDATE_OWNERSHIP_MISSING",
  "CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS",
  "CORTEX_TIER1_RESOLVED",
  "CORTEX_LEARNER_ELIGIBLE",
  "CORTEX_CHAIN_ELIGIBLE_CANDIDATE",
  "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE",
];

describe("cortex-production-chain-diagnostics", () => {
  it("starts every known code at zero after a reset", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const counters = cortexProductionChainDiagnostics();
    for (const code of ALL_CODES) expect(counters[code]).toBe(0);
    // No stray keys beyond the known set either way.
    expect(Object.keys(counters).sort()).toEqual([...ALL_CODES].sort());
  });

  it("increments exactly the recorded code, independently of every other code", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    recordCortexProductionChainDiagnostic("CORTEX_TIER1_RESOLVED");
    recordCortexProductionChainDiagnostic("CORTEX_TIER1_RESOLVED");
    recordCortexProductionChainDiagnostic("CORTEX_LEARNER_ELIGIBLE");
    const counters = cortexProductionChainDiagnostics();
    expect(counters.CORTEX_TIER1_RESOLVED).toBe(2);
    expect(counters.CORTEX_LEARNER_ELIGIBLE).toBe(1);
    for (const code of ALL_CODES) {
      if (code === "CORTEX_TIER1_RESOLVED" || code === "CORTEX_LEARNER_ELIGIBLE") continue;
      expect(counters[code]).toBe(0);
    }
  });

  it("every code added this stage is independently recordable and resettable", () => {
    const newCodes: readonly CortexProductionChainDiagnosticCode[] = [
      "CORTEX_STRATEGY_MAPPING_MISMATCH",
      "CORTEX_CANDIDATE_OWNERSHIP_MISSING",
      "CORTEX_CANDIDATE_OWNERSHIP_AMBIGUOUS",
      "CORTEX_TIER1_RESOLVED",
      "CORTEX_LEARNER_ELIGIBLE",
      "CORTEX_CHAIN_ELIGIBLE_CANDIDATE",
      "GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE",
    ];
    for (const code of newCodes) {
      _resetCortexProductionChainDiagnosticsForTests();
      recordCortexProductionChainDiagnostic(code);
      expect(cortexProductionChainDiagnostics()[code]).toBe(1);
    }
    _resetCortexProductionChainDiagnosticsForTests();
    for (const code of newCodes) expect(cortexProductionChainDiagnostics()[code]).toBe(0);
  });

  it("cortexProductionChainDiagnostics() returns a snapshot copy, not the live counters object", () => {
    _resetCortexProductionChainDiagnosticsForTests();
    const first = cortexProductionChainDiagnostics();
    recordCortexProductionChainDiagnostic("CORTEX_CHAIN_ELIGIBLE_CANDIDATE");
    expect(first.CORTEX_CHAIN_ELIGIBLE_CANDIDATE).toBe(0);
    expect(cortexProductionChainDiagnostics().CORTEX_CHAIN_ELIGIBLE_CANDIDATE).toBe(1);
  });
});

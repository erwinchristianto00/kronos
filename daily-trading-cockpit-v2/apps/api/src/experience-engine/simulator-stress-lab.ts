/** Simulator Stress-Lab contract. It can reject a candidate, but never promotes or trains one. */
export const SIMULATOR_STRESS_POLICY = "EVALUATION_ONLY_NO_COEFFICIENT_UPDATES" as const;
export type StressMeasure = "REGIME_FLIP_INSTABILITY" | "DIRECTION_THRASHING" | "ENTRY_CHASING" | "EXIT_GIVEBACK" | "ALLOCATION_CONCENTRATION" | "DRAWDOWN" | "STALE_MISSING_DATA" | "EXECUTION_COST_SENSITIVITY" | "INVARIANT_FAILURE" | "KILL_RAIL_BEHAVIOR";
export interface StressResult {
  candidateId: string;
  generatorFamily: "PHASE2D_SUCCESSOR" | "PHASE3A_RESIDUAL" | "ADVERSARIAL";
  measure: StressMeasure;
  passed: boolean;
  value: number | null;
  threshold: number | null;
  notes: string[];
}
export interface StressVerdict { candidateId: string; passed: boolean; promotionAuthority: "NONE"; failures: StressResult[]; }

/** A simulator can only fail a candidate. Empty stress coverage is a fail-closed non-pass. */
export function summarizeStress(candidateId: string, results: readonly StressResult[]): StressVerdict {
  const own = results.filter((result) => result.candidateId === candidateId);
  const failures = own.filter((result) => !result.passed);
  return { candidateId, passed: own.length > 0 && failures.length === 0, promotionAuthority: "NONE", failures };
}

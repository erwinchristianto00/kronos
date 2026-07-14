/**
 * Calibration dataset + parameter-lock contract (Market Digital Twin, Phase-1 foundation). Four SEPARATE datasets;
 * the two holdouts are WRITE-ONCE for evaluation and must never be used to tune the simulator. The lock manifest
 * records everything frozen BEFORE the realism holdout is touched. Pure types + a tiny guard.
 */

export type DatasetRole = "calibration" | "development-validation" | "untouched-realism-holdout" | "untouched-transfer-holdout";

export interface DatasetPartition {
  role: DatasetRole;
  /** Disjoint time windows assigned to this partition (no overlap with other partitions of the same origin). */
  windows: Array<{ startMs: number; endMs: number; origin: string }>;
}

/** Everything that MUST be frozen before the realism holdout is evaluated (operator parameter-lock discipline). */
export interface ParameterLockManifest {
  lockedAtProcessingMs: number;
  featureSet: string[];
  calibrationPeriods: Array<{ startMs: number; endMs: number }>;
  blockSizes: number[];
  regimeLabelVersion: string;
  boundaryThresholds: Record<string, number>;
  realismMetrics: string[];
  realismThresholds: Record<string, number>;
  classifierFeatures: string[];
  executionAssumptions: Record<string, number | string>;
  eventDetectionRules: Record<string, string>;
  /** Deterministic hash of all the above — the immutable lock fingerprint. */
  lockHash: string;
}

export interface DatasetSplitCheck { ok: boolean; violations: string[]; }

/** Verify the four partitions are present and their windows do not overlap within the same origin. */
export function checkDatasetSeparation(partitions: readonly DatasetPartition[]): DatasetSplitCheck {
  const violations: string[] = [];
  const roles = new Set(partitions.map((p) => p.role));
  for (const required of ["calibration", "development-validation", "untouched-realism-holdout", "untouched-transfer-holdout"] as DatasetRole[]) {
    if (!roles.has(required)) violations.push(`missing partition: ${required}`);
  }
  // cross-partition overlap check (same origin)
  const flat = partitions.flatMap((p) => p.windows.map((w) => ({ ...w, role: p.role })));
  for (let i = 0; i < flat.length; i += 1) {
    for (let j = i + 1; j < flat.length; j += 1) {
      const a = flat[i]!; const b = flat[j]!;
      if (a.origin !== b.origin || a.role === b.role) continue;
      if (a.startMs < b.endMs && b.startMs < a.endMs) violations.push(`overlap ${a.role}∩${b.role} origin=${a.origin}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

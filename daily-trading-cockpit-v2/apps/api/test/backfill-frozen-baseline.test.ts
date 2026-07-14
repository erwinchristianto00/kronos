import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Frozen research baseline — regression benchmark + authority lock (operator sign-off 2026-07-13).
 * The historical predictive candidate is REJECTED FOR AUTHORITY. This test:
 *   • verifies every frozen artifact's SHA-256 still matches the manifest (a drift tripwire — regenerating the
 *     pipeline and getting different numbers must be a CONSCIOUS re-freeze, not a silent change), and
 *   • locks the do-not invariants: the warm-start candidate is never promotable, the 60-day floor is not met,
 *     liveBeta is unchanged, and the reconciliation still balances.
 * Skips gracefully if the artifacts aren't present in this checkout (the guard activates wherever they are).
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts", "backfill");
const manifestPath = join(DIR, "frozen-baseline.json");

describe("backfill: FROZEN research baseline (regression benchmark + authority lock)", () => {
  const present = existsSync(manifestPath);
  const manifest = present ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

  it.skipIf(!present)("every frozen artifact's SHA-256 still matches the manifest (drift tripwire)", () => {
    for (const [file, expected] of Object.entries<string>(manifest.sha256)) {
      const p = join(DIR, file);
      expect(existsSync(p), `${file} missing`).toBe(true);
      const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
      expect(actual, `${file} drifted from the frozen baseline — re-freeze consciously if intended`).toBe(expected);
    }
  });

  it.skipIf(!present)("authority lock: candidate is never promotable, floor not met, liveBeta unchanged", () => {
    const g = manifest.pinnedMetrics.warmStartGuards;
    expect(g.promotable).toBe(false);
    expect(g.sixtyDayFloorMet).toBe(false);
    expect(g.liveBetaUnchanged).toBe(true);
    expect(g.shadowOnly).toBe(true);
    expect(manifest.status).toContain("REJECTED FOR AUTHORITY");
  });

  it.skipIf(!present)("reconciliation still balances + the do-not list is intact", () => {
    expect(manifest.pinnedMetrics.reconciliation.reconciles).toBe(true);
    for (const prohibition of ["activate the historical candidate", "change live or evaluation beta from this result", "promote it into CORTEX", "tune additional thresholds against the same holdout", "claim the model has learned profitable market adaptation"]) {
      expect(manifest.doNot).toContain(prohibition);
    }
  });
});

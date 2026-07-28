/**
 * COST-MODEL COHORT SELECTION (2026-07-28) — pure, no imports.
 *
 * WHY. `paper-execution-router.ts` stamps `costModelVersion` on every order it closes and states the
 * rule plainly: "Two generations are NOT comparable and must never be pooled silently." Its own
 * doc comment then concedes that the stamp had ZERO readers — `laneEconomics()`,
 * `computeAutoQuarantinedVariantLanes()`, `per-symbol-lane-book-edge.ts`, the meta-label gate, and
 * the CORTEX CG-router outcome source all averaged `netR` straight across every generation.
 *
 * That matters because a generation change moves netR with NO underlying edge change — the v1→v2
 * cutover alone moved maker lanes by up to +16bps/stopBps and taker stop-heavy lanes by −5bps —
 * and those averages drive consequential things: auto-quarantine HALTS a lane's paper admission,
 * and the promotion telemetry is what an operator reads when deciding to size a lane up. A lane
 * whose apparent edge moved purely because the cost basis changed is indistinguishable, in a pooled
 * average, from one whose edge really moved.
 *
 * THE RULE HERE: never pool. Pick the NEWEST generation that carries enough evidence to answer the
 * question, and report which one that was. Picking the newest-with-enough-evidence (rather than
 * simply filtering to the current generation) is what keeps this safe across a cutover: on the day
 * the generation changes, the older cohort still has the sample and keeps driving the decision until
 * the new one fills, instead of every lane abruptly falling back to "no evidence".
 *
 * An ABSENT `costModelVersion` means a legacy row written before stamping existed, which the router
 * documents as v1-but-unverified — so it is treated as generation 1 rather than silently grouped
 * with whatever the current generation happens to be.
 */

/** Generation of a row whose stamp may be absent (legacy rows predate stamping — router calls those v1). */
export const LEGACY_COST_MODEL_GENERATION = 1;

export interface CostModelStamped {
  costModelVersion?: number | null;
}

export function costModelGenerationOf(row: CostModelStamped): number {
  const v = row.costModelVersion;
  return typeof v === "number" && Number.isFinite(v) ? v : LEGACY_COST_MODEL_GENERATION;
}

export interface CostCohort<T> {
  /** The generation these rows were priced under. */
  generation: number;
  rows: T[];
  /** Generations deliberately left out, newest-first — the honest "what did we not look at". */
  excludedGenerations: number[];
  /** Total rows across every generation, so a caller can show what share it actually used. */
  totalRows: number;
}

/** Groups rows by cost-model generation. Order within each group is preserved. */
export function partitionByCostModelGeneration<T extends CostModelStamped>(rows: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const gen = costModelGenerationOf(row);
    const bucket = out.get(gen);
    if (bucket) bucket.push(row);
    else out.set(gen, [row]);
  }
  return out;
}

/**
 * The newest generation holding at least `minRows` rows, or null when no single generation does.
 *
 * `minRows = 0` degrades to "the newest generation that has any rows at all", which is what the
 * report-only telemetry surfaces want: they have no sample gate of their own and simply must not
 * average two bases together.
 *
 * Returning null rather than falling back to the pooled set is deliberate: for a gated decision
 * (auto-quarantine), "no single comparable cohort is large enough" is the same answer the existing
 * minimum-sample gate already gives, and it fails toward NOT acting.
 */
export function selectNewestCostCohort<T extends CostModelStamped>(
  rows: readonly T[],
  minRows = 0,
): CostCohort<T> | null {
  if (rows.length === 0) return null;
  const byGen = partitionByCostModelGeneration(rows);
  const generationsNewestFirst = [...byGen.keys()].sort((a, b) => b - a);
  for (let i = 0; i < generationsNewestFirst.length; i += 1) {
    const generation = generationsNewestFirst[i]!;
    const bucket = byGen.get(generation)!;
    if (bucket.length >= minRows && bucket.length > 0) {
      return {
        generation,
        rows: bucket,
        excludedGenerations: generationsNewestFirst.filter((g) => g !== generation),
        totalRows: rows.length,
      };
    }
  }
  return null;
}

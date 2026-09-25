/**
 * CORTEX persistence (2026-07-12) — Phase 1 shadow.
 *
 * Two durable artifacts, both following this repo's established discipline:
 *  - CortexBrainStore: the learned model state (archetype coefficients + cumulative resolved count),
 *    atomically tmp+rename'd like RegimeCompositeStore / edge-memory. Loaded on boot; seeded to
 *    emptyCortexState() so a fresh brain (β=0) reproduces the POST-FEDERATED-VETO incumbent allocation
 *    (static table with proven-negative/vetoed lanes zeroed), NOT the raw preset.
 *  - CortexDecisionJournal: an append-only jsonl of every shadow decision + its resolved outcome —
 *    the audit trail that makes the brain diagnosable (never-throws appendFileSync, BOUNDED by
 *    size-based rotation so weeks of shadow can't grow it without limit). Report-only; zero trading influence.
 *
 * The store-writer applies a refit ONLY when its status is ACCEPTED, so a broken fit can never
 * overwrite the last healthy model (the refit already returns wPrior on any rejection as a second
 * layer of the same guarantee).
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildCortexDecisionRecord,
  checkCortexInvariants,
  cortexPromotedBeta,
  decideCortex,
  emptyCortexState,
  evaluationBeta,
  CORTEX_LANE_CAP_PCT,
  CORTEX_LIVE_BETA,
  CORTEX_FEATURE_DIM,
  CORTEX_FEATURE_SCHEMA_VERSION,
  type CortexArchetype,
  type CortexBrainMode,
  type CortexContext,
  type CortexDecision,
  type CortexInvariantResult,
  type CortexRefitResult,
  type CortexStoreState,
} from "./cortex-brain.js";
import { engineLaneIdForStaticWeight } from "./cortex-live-gather.js";
import { cortexAllocationSnapshotId, cortexDecisionId, publishCortexDecisionSnapshots, type CortexDecisionSnapshot } from "./cortex-decision-snapshot.js";

/** Strict, read-only decoder for operators/auditors. Runtime deliberately seeds on a bad file so
 * an unavailable shadow learner cannot stop trading; an operator must instead fail closed. */
export type CortexBrainStrictReadStatus =
  | "VALID" | "FILE_MISSING" | "JSON_CORRUPTED" | "SCHEMA_MISMATCH"
  | "PARTIAL_INVALID" | "NONFINITE_COEFFICIENT" | "FEATURE_DIMENSION_MISMATCH" | "HISTORY_INCONSISTENT";
export type CortexBrainStrictRead =
  | { readonly status: "VALID"; readonly state: CortexStoreState }
  | { readonly status: Exclude<CortexBrainStrictReadStatus, "VALID">; readonly state: null };

const strictFiniteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const strictIsoOrNull = (value: unknown): value is string | null => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));

/** Does not normalize, repair, or write. Callers receive a canonical copy only after raw proof. */
export function readCortexBrainStoreStrict(file: string): CortexBrainStrictRead {
  if (!existsSync(file)) return { status: "FILE_MISSING", state: null };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { status: "JSON_CORRUPTED", state: null }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "PARTIAL_INVALID", state: null };
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.featureSchemaVersion !== CORTEX_FEATURE_SCHEMA_VERSION) return { status: "SCHEMA_MISMATCH", state: null };
  if (!value.archetypes || typeof value.archetypes !== "object" || Array.isArray(value.archetypes)) return { status: "PARTIAL_INVALID", state: null };
  const archetypes = {} as CortexStoreState["archetypes"];
  for (const archetype of ["BREADTH", "NEUTRAL", "TACTICAL"] as CortexArchetype[]) {
    const row = (value.archetypes as Record<string, unknown>)[archetype];
    if (!row || typeof row !== "object" || Array.isArray(row)) return { status: "PARTIAL_INVALID", state: null };
    const entry = row as Record<string, unknown>;
    if (!Array.isArray(entry.w)) return { status: "PARTIAL_INVALID", state: null };
    if (entry.w.length !== CORTEX_FEATURE_DIM) return { status: "FEATURE_DIMENSION_MISMATCH", state: null };
    if (!entry.w.every((coefficient) => typeof coefficient === "number" && Number.isFinite(coefficient))) return { status: "NONFINITE_COEFFICIENT", state: null };
    if (!strictFiniteNonNegative(entry.nEff) || !strictIsoOrNull(entry.refitAt)) return { status: "PARTIAL_INVALID", state: null };
    archetypes[archetype] = { w: [...entry.w] as number[], nEff: entry.nEff, refitAt: entry.refitAt };
  }
  if (!strictFiniteNonNegative(value.cumulativeResolved) || !strictIsoOrNull(value.updatedAt)) return { status: "PARTIAL_INVALID", state: null };
  const counters = (field: "resolvedByFamily" | "countedObservations"): Record<string, number> | null => {
    const source = value[field];
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(source)) {
      if (!key || !strictFiniteNonNegative(count)) return null;
      result[key] = count;
    }
    return result;
  };
  const resolvedByFamily = counters("resolvedByFamily"); const countedObservations = counters("countedObservations");
  if (!resolvedByFamily || !countedObservations) return { status: "PARTIAL_INVALID", state: null };
  const familyTotal = Object.values(resolvedByFamily).reduce((total, count) => total + count, 0);
  if (familyTotal !== value.cumulativeResolved || Object.keys(countedObservations).length > value.cumulativeResolved) return { status: "HISTORY_INCONSISTENT", state: null };
  return { status: "VALID", state: { version: 1, featureSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION, archetypes, cumulativeResolved: value.cumulativeResolved, resolvedByFamily, countedObservations, updatedAt: value.updatedAt } };
}

export class CortexBrainStore {
  private state: CortexStoreState;
  constructor(private readonly file: string) {
    this.state = emptyCortexState();
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CortexStoreState>;
        // A stored model from a stale feature schema is discarded (the coefficients no longer map to
        // the current features) — degrade to the seed rather than trust corrupted weights.
        if (parsed.featureSchemaVersion === CORTEX_FEATURE_SCHEMA_VERSION && parsed.archetypes) {
          const s = emptyCortexState();
          for (const a of ["BREADTH", "NEUTRAL", "TACTICAL"] as CortexArchetype[]) {
            const w = parsed.archetypes[a]?.w;
            if (Array.isArray(w) && w.length === CORTEX_FEATURE_DIM && w.every((v) => Number.isFinite(v))) {
              s.archetypes[a] = { w: [...w], refitAt: parsed.archetypes[a]?.refitAt ?? null, nEff: parsed.archetypes[a]?.nEff ?? 0 };
            }
          }
          s.cumulativeResolved = Number.isFinite(parsed.cumulativeResolved) ? (parsed.cumulativeResolved as number) : 0;
          // Restore the resolved-per-family tallies + attribution watermark (both keep the β schedule +
          // regime-coverage gate monotonic across restarts). Validate each family count is finite ≥0.
          if (parsed.resolvedByFamily && typeof parsed.resolvedByFamily === "object") {
            for (const [fam, n] of Object.entries(parsed.resolvedByFamily)) {
              if (typeof n === "number" && Number.isFinite(n) && n >= 0) s.resolvedByFamily[fam] = n;
            }
          }
          if (parsed.countedObservations && typeof parsed.countedObservations === "object") {
            for (const [k, ms] of Object.entries(parsed.countedObservations)) {
              if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) s.countedObservations[k] = ms;
            }
          }
          s.updatedAt = parsed.updatedAt ?? null;
          this.state = s;
        }
      } catch {
        /* corrupt → seed */
      }
    }
  }

  get(): CortexStoreState {
    return this.state;
  }

  /** Apply a nightly refit result for one archetype. Writes coefficients ONLY on ACCEPTED — a
   *  rejected fit leaves the last healthy model untouched (belt to the refit's own wPrior suspenders). */
  applyRefit(archetype: CortexArchetype, result: CortexRefitResult, atIso: string): boolean {
    if (result.status !== "ACCEPTED") return false;
    this.state.archetypes[archetype] = { w: [...result.w], refitAt: atIso, nEff: result.nEff };
    this.state.updatedAt = atIso;
    return true;
  }

  /** Advance the cumulative resolved-close count that ramps β. (Legacy per-cycle path — the real
   *  advancement is recordResolvedOutcomes, driven by the nightly attribution.) */
  addResolved(n: number, atIso: string): void {
    if (Number.isFinite(n) && n > 0) {
      this.state.cumulativeResolved += n;
      this.state.updatedAt = atIso;
    }
  }

  /**
   * Fold newly-attributed resolved outcomes into the counters that feed evaluationBeta's schedule + the
   * regime-coverage gate. EXACT-ONCE via the persisted (laneId::observationId) ledger — NOT a scalar
   * resolvedAt watermark (that under-counts: resolvedAt is candle/event time, so a fast lane resolving on a
   * later candle would advance the watermark past a slow lane's earlier-candle resolution and drop it).
   * Each outcome advances the counters at most once ever; a re-run over the same outcomes adds 0. The
   * ledger is pruned to `pruneBeforeMs` (an id older than the refit lookback can't re-appear in attribution)
   * so it stays bounded. Returns the number of outcomes newly counted this call.
   *
   * Touches ONLY evaluationBeta's input + the gate's coverage — NEVER CORTEX_LIVE_BETA (hard 0 until an
   * explicit gated+approved promotion). Learning ≠ going live.
   */
  recordResolvedOutcomes(
    outcomes: { laneId: string; observationId: string; regimeFamily: string; resolvedAtMs: number }[],
    pruneBeforeMs: number,
    atIso: string,
  ): number {
    let added = 0;
    for (const o of outcomes) {
      if (!(typeof o.resolvedAtMs === "number" && Number.isFinite(o.resolvedAtMs))) continue;
      const key = `${o.laneId}::${o.observationId}`;
      if (this.state.countedObservations[key] !== undefined) continue; // already counted — exact-once
      this.state.countedObservations[key] = o.resolvedAtMs;
      this.state.cumulativeResolved += 1;
      this.state.resolvedByFamily[o.regimeFamily] = (this.state.resolvedByFamily[o.regimeFamily] ?? 0) + 1;
      added += 1;
    }
    // Prune ids older than the lookback so the ledger stays bounded (they can never re-enter attribution).
    if (Number.isFinite(pruneBeforeMs)) {
      for (const [k, ms] of Object.entries(this.state.countedObservations)) {
        if (ms < pruneBeforeMs) delete this.state.countedObservations[k];
      }
    }
    if (added > 0) this.state.updatedAt = atIso;
    return added;
  }

  /** True if this outcome was already folded into the counters (for the runner's dry-run new-count). */
  hasCountedObservation(laneId: string, observationId: string): boolean {
    return this.state.countedObservations[`${laneId}::${observationId}`] !== undefined;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }
}

let storeSingleton: CortexBrainStore | null = null;
export function getCortexBrainStore(dataDir = "data"): CortexBrainStore {
  if (!storeSingleton) storeSingleton = new CortexBrainStore(resolve(dataDir, "cortex-brain.json"));
  return storeSingleton;
}
export function _resetCortexBrainStoreForTests(): void {
  storeSingleton = null;
}

/** Append-only decision/outcome journal. Never throws (matches the snapshot-store contract) — a
 *  logging failure must never break the trading cycle it observes. */
/** Journal size cap before rotation. The shadow appends one decision every cycle for WEEKS (until the
 *  60-day / 300-resolved promotion gate), so an uncapped jsonl is the repo's classic unbounded-store
 *  disk/OOM bomb. 2026-07-22: raised from 8MB (measured ~4.6 days actual retention on testnet — the
 *  prior "~3KB/decision, 8MB ≈ 2.6k decisions" estimate was stale against today's larger per-decision
 *  record shape) to 35MB per file (70MB total across current+.1 backup) ≈ 26 days at the MEASURED
 *  ~2.66MB/day growth rate (testnet, 2026-07-22) — comfortably covers the longest roster lane hold
 *  (COMPOSITE_ESTIMATOR_BIDI_WIDE_*, 144h/6d) with ~4x margin, so a WIDE lane's own decision context
 *  no longer rotates out of the journal before that lane's trade even resolves. */
export const CORTEX_JOURNAL_MAX_BYTES = 35 * 1024 * 1024;

export class CortexDecisionJournal {
  constructor(
    private readonly file: string,
    private readonly maxBytes: number = CORTEX_JOURNAL_MAX_BYTES,
  ) {}
  append(record: unknown): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Size-based rotation (append stays O(1); no whole-file read): when the journal exceeds the cap,
      // roll it to a single .1 backup (overwriting the previous one) and start fresh — bounds disk to
      // ~2×cap and keeps the most-recent window. This is the bounded version of the snapshot pattern.
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        size = 0; // file doesn't exist yet
      }
      if (size >= this.maxBytes) {
        try {
          renameSync(this.file, `${this.file}.1`);
          size = 0;
        } catch {
          /* rotation best-effort */
        }
      }
      // Self-heal a prior partial write: if a crash truncated the last append mid-record, the file won't
      // end in "\n". Start THIS record on a fresh line so the corruption stays isolated to that one
      // (skippable) line and can never merge into a valid record. Defense-in-depth with #218's
      // line-resilient reader (which try/catch-parses per line + reads both .jsonl and .jsonl.1).
      if (size > 0 && !this.endsWithNewline(size)) appendFileSync(this.file, "\n", "utf-8");
      appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      /* journaling is best-effort; swallow */
    }
  }

  private endsWithNewline(size: number): boolean {
    try {
      const fd = openSync(this.file, "r");
      try {
        const buf = Buffer.alloc(1);
        readSync(fd, buf, 0, 1, size - 1);
        return buf[0] === 0x0a; // "\n"
      } finally {
        closeSync(fd);
      }
    } catch {
      return true; // can't check ⇒ assume ok, don't inject spurious newlines
    }
  }
}

let journalSingleton: CortexDecisionJournal | null = null;
export function getCortexDecisionJournal(dataDir = "data"): CortexDecisionJournal {
  if (!journalSingleton) journalSingleton = new CortexDecisionJournal(resolve(dataDir, "cortex-decision-journal.jsonl"));
  return journalSingleton;
}
export function _resetCortexDecisionJournalForTests(): void {
  journalSingleton = null;
}

/**
 * One shadow cycle: advance the resolved count (ramps β), decide, check invariants, journal the
 * auditable trace. Phase 1 = SHADOW → this drives NOTHING (the caller ignores the returned decision
 * for allocation; only journals). The learned-model UPDATE (refit) is a SEPARATE nightly job, not
 * this per-cycle tick. Never throws through the journal. Returns the decision for the report layer.
 *
 * `promotion` is the Phase-4 opt-in (2026-07-20): when present AND `deps.mode === "live"`, this ALSO
 * computes a REAL operational decision at the gated/damped/ramped promoted β (cortexPromotedBeta) and
 * returns its per-lane weights for the caller to push into the execution engine. Absent/null on every
 * still-shadow instance (unchanged behavior — `promotedWeights` is always null there). Every one of
 * these must hold for a non-null result: `envBlocked` false (the LIVE_BINANCE_ENV≠mainnet circuit
 * breaker), `regimeCoverageGateMet` true, and the promoted decision itself passing `checkCortexInvariants`
 * — a failure at any of these silently falls back to null (caller then leaves the incumbent table alone),
 * never to a partially-applied or unchecked tilt.
 */
export function runCortexShadowTick(deps: {
  store: CortexBrainStore;
  journal: CortexDecisionJournal;
  context: CortexContext;
  nowIso: string;
  /** Exact scanner batch that supplied this CORTEX context, if one exists. */
  scanBatchId?: string | null;
  mode: CortexBrainMode;
  resolvedThisCycle?: number;
  promotion?: {
    regimeCoverageGateMet: boolean;
    blindCapitalPct: number;
    envBlocked: boolean;
    /** 2026-07-21 operator ask: only roster lanes with proven LEARNING_ACTIVE status (from the
     *  nightly refit's own attribution, ≥ CORTEX_ATTR_MIN_EXAMPLES_ACTIVE attributed examples) may
     *  ever receive CORTEX's tilt. Every other lane (INSUFFICIENT_DATA/NO_OUTCOME_SOURCE/etc.) is
     *  forced back to its exact operational (β=0) value below — a data-starved lane's untested guess
     *  can never move real capital, while shadow collection/attribution/refit continues unaffected
     *  for every lane regardless, so the two tracks genuinely run in parallel. Absent/empty ⇒ no lane
     *  is eligible (fails safe to fully static, never the reverse). */
    learningActiveLaneIds?: Set<string>;
  } | null;
}): { decision: CortexDecision; invariants: CortexInvariantResult; snapshots: readonly CortexDecisionSnapshot[]; promotedWeights: Record<string, number> | null } {
  if (deps.resolvedThisCycle && deps.resolvedThisCycle > 0) deps.store.addResolved(deps.resolvedThisCycle, deps.nowIso);
  const state = deps.store.get();
  // OPERATIONAL decision = the β=0 post-veto incumbent — what would drive live (drives NOTHING in shadow).
  // liveBeta is a hard 0; the schedule never touches it. This is the record's primary allocation.
  const decision = decideCortex(deps.context, state, { beta: CORTEX_LIVE_BETA });
  const invariants = checkCortexInvariants(decision);
  // EVALUATION decision = the SHADOW counterfactual at the ramped evaluationBeta — the tilt the brain WOULD
  // apply, journaled alongside (never operational) so #219 can measure decision-alpha. Same features (x is
  // β-independent), only the allocation blend differs. β=0 ⇒ identical to the incumbent, so skip the compute.
  const evalBeta = evaluationBeta(state.cumulativeResolved);
  const evalDecision = evalBeta > 0 ? decideCortex(deps.context, state, { beta: evalBeta }) : decision;
  deps.journal.append(
    buildCortexDecisionRecord({ atIso: deps.nowIso, mode: deps.mode, ctx: deps.context, decision, invariants, evalDecision, evaluationBeta: evalBeta }),
  );
  const decisionAtMs = Date.parse(deps.nowIso);
  const snapshots: readonly CortexDecisionSnapshot[] = Number.isFinite(decisionAtMs)
    ? decision.lanes.map((lane) => {
      const decisionId = cortexDecisionId(decisionAtMs, lane.laneId, decision.featureSchemaVersion);
      return {
        decisionId,
        allocationSnapshotId: cortexAllocationSnapshotId(decisionId),
        atMs: decisionAtMs,
        laneId: lane.laneId,
        direction: deps.context.lanes.find((input) => input.laneId === lane.laneId)?.direction ?? null,
        featureSchemaVersion: decision.featureSchemaVersion,
        featureVector: lane.featureVector,
        regimeFamily: deps.context.regimeFamily,
        eligible: lane.eligible,
        finalPct: lane.finalPct,
        evalFinalPct: evalDecision.lanes.find((candidate) => candidate.laneId === lane.laneId)?.finalPct ?? lane.finalPct,
        sourceScanBatchId: deps.scanBatchId ?? null,
      };
    })
    : [];
  publishCortexDecisionSnapshots(snapshots);

  let promotedWeights: Record<string, number> | null = null;
  if (deps.mode === "live" && deps.promotion && !deps.promotion.envBlocked) {
    const promotedBeta = cortexPromotedBeta(state.cumulativeResolved, deps.promotion.regimeCoverageGateMet, deps.promotion.blindCapitalPct);
    if (promotedBeta > 0) {
      const promoted = decideCortex(deps.context, state, { beta: promotedBeta });
      // 2026-07-21 operator ask: gate the tilt itself per-lane. `decision` above is the SAME context/state
      // at β=0 — already computed, already journaled — so a non-active lane's "effective" entry here is
      // BYTE-IDENTICAL to its true static-scaled operational value (no new decideCortex call needed, no
      // approximation: decideCortex's own blend is (1-β)·staticPct + β·learnedPct, and finalPct at β=0 IS
      // staticPct exactly). Only LEARNING_ACTIVE lanes keep the real tilted (promoted) entry.
      const learningActiveLaneIds = deps.promotion.learningActiveLaneIds ?? new Set<string>();
      const staticFinalPctByLaneId = new Map(decision.lanes.map((l) => [l.laneId, l]));
      const effectiveLanes = promoted.lanes.map((l) =>
        learningActiveLaneIds.has(l.laneId) ? l : (staticFinalPctByLaneId.get(l.laneId) ?? l),
      );
      const effectiveDecision: CortexDecision = { ...promoted, lanes: effectiveLanes };
      const promotedInvariants = checkCortexInvariants(effectiveDecision);
      // 2026-07-20 fix: checkCortexInvariants' "total weight ≤ 100%" check sums the RAW roster, which
      // structurally double-counts a direction-split lane (CG_MFE_GIVEBACK_LONG/_SHORT both carry the
      // SAME real static weight per engineLaneIdForStaticWeight's own doc — that's by design, so each
      // half's OWN per-half cap (max(staticPct, CORTEX_LANE_CAP_PCT)) is correct even at β=0). A
      // legitimate allocation table summing to exactly 100% therefore raw-sums to
      // 100% + staticPct(split lane) and trips this check FOREVER, at any β, regardless of tilt quality
      // — decideCortex's blend is (1-β)·staticPct + β·learnedPct, and learnedPct is genuinely normalized
      // to sum to 100 across the roster (the split competes fairly for capital there), so the ONLY
      // source of over-100% is the (1-β)-weighted duplicate static contribution. Every OTHER invariant
      // (NaN/negative/per-lane cap/vetoed-funded/grossG range) is still a real per-entry check and stays
      // gating as-is; only "total weight" is deferred to the folded-vs-budget check below.
      const nonTotalViolations = promotedInvariants.violations.filter((v) => !v.startsWith("total weight "));
      if (nonTotalViolations.length === 0) {
        // Fold the roster's synthetic direction-split ids (e.g. CG_MFE_GIVEBACK_LONG/_SHORT) onto the
        // one real engine lane they both size — see engineLaneIdForStaticWeight's own doc for why: the
        // execution engine has no concept of the split, only ONE real weight slot per engine lane id.
        const summed: Record<string, number> = {};
        const staticByEngineLaneId: Record<string, number> = {};
        const rosterCountByEngineLaneId: Record<string, number> = {};
        for (const l of effectiveLanes) {
          const engineLaneId = engineLaneIdForStaticWeight(l.laneId);
          summed[engineLaneId] = (summed[engineLaneId] ?? 0) + Math.max(0, l.finalPct);
          // Duplicate roster entries share the identical real static value (both call the SAME real
          // accessor) — max() is just a defensive tie-break, not an actual combine rule.
          staticByEngineLaneId[engineLaneId] = Math.max(staticByEngineLaneId[engineLaneId] ?? 0, l.staticPct);
          rosterCountByEngineLaneId[engineLaneId] = (rosterCountByEngineLaneId[engineLaneId] ?? 0) + 1;
        }
        const foldedTotal = Object.values(summed).reduce((s, w) => s + w, 0);
        // 2026-07-21 precision fix: a non-active roster entry is forced to its EXACT β=0 static value
        // (byte-identical to `decision.lanes`, per the comment above) — it is NEVER tilted, so budgeting
        // its extra at `(1-promotedBeta)` (the discount that made sense for the OLD "every copy is tilted"
        // assumption) systematically UNDER-budgets it by `promotedBeta · staticPct`, which is exactly why
        // this check was rejecting promotion on every single cycle in production despite the actual
        // deviation from the incumbent being tiny. The duplicate's extra is FULL and undiscounted:
        const duplicateStaticExtra = Object.entries(rosterCountByEngineLaneId).reduce(
          (sum, [engineLaneId, count]) => sum + Math.max(0, count - 1) * (staticByEngineLaneId[engineLaneId] ?? 0),
          0,
        );
        // 2026-07-21 CRITICAL fix (adversarial-review finding): the budget below allows a
        // LEARNING_ACTIVE lane's own tilt headroom, but the aggregate foldedTotal>foldedBudget
        // comparison can't tell WHERE any extra actually came from — headroom sitting on one active
        // lane can silently absorb a genuine over-100% CORRUPTION on a completely different, unrelated
        // lane (e.g. an operator/autopilot table whose individual entries each validate but SUM past
        // 100% — setLaneAllocations validates each entry's range, never the total). Neither lane need
        // breach its OWN per-lane cap for this, so the post-fold per-lane check below (a concentration
        // check) does not catch it — this is an aggregate-total failure. Validate the incumbent (β=0)
        // baseline itself, independent of any active-lane headroom, BEFORE trusting that headroom to
        // explain any further growth: the untilted table must already fit the one shape this promotion
        // path understands and accepts (100% + the known roster-split duplicate), full stop.
        const staticByEngineLaneForBaseline: Record<string, number> = {};
        for (const l of decision.lanes) {
          const engineLaneId = engineLaneIdForStaticWeight(l.laneId);
          staticByEngineLaneForBaseline[engineLaneId] = (staticByEngineLaneForBaseline[engineLaneId] ?? 0) + Math.max(0, l.finalPct);
        }
        const staticFoldedTotal = Object.values(staticByEngineLaneForBaseline).reduce((s, w) => s + w, 0);
        const expectedStaticCeiling = effectiveDecision.grossG * (100 + duplicateStaticExtra);
        if (staticFoldedTotal > expectedStaticCeiling + 1e-6) {
          console.error(
            `[cortex-live] incumbent (β=0) folded total ${staticFoldedTotal.toFixed(2)}% already exceeds its expected ${expectedStaticCeiling.toFixed(2)}% ceiling before any tilt — falling back to the incumbent table this cycle`,
          );
        } else {
          // The ONLY legitimate source of growth beyond the now-validated duplicate-adjusted 100%
          // baseline is a LEARNING_ACTIVE lane's own tilt — bounded, per lane, by the SAME effectiveCap
          // the fold-cap check below re-verifies. Summing that per-lane worst case (cap − static) over
          // just the active roster entries gives an exact, still-conservative ceiling for "every active
          // lane tilts all the way to its own cap simultaneously" — not an approximation, an actual
          // reachable bound — so ordinary small-β production tilts (which use only a sliver of this
          // headroom) are no longer spuriously rejected, while the fold-cap check remains the real
          // per-lane backstop.
          const activeTiltHeadroom = effectiveLanes
            .filter((l) => learningActiveLaneIds.has(l.laneId))
            .reduce((sum, l) => sum + Math.max(0, Math.max(l.staticPct, CORTEX_LANE_CAP_PCT) - l.staticPct), 0);
          const foldedBudget = expectedStaticCeiling + activeTiltHeadroom;
          if (foldedTotal > foldedBudget + 1e-6) {
            console.error(
              `[cortex-live] promoted decision's folded total ${foldedTotal.toFixed(2)}% exceeds its budget ${foldedBudget.toFixed(2)}% — falling back to the incumbent table this cycle`,
            );
          } else {
            // 2026-07-20 safety-review fix (CRITICAL): checkCortexInvariants above validated each ROSTER
            // entry against its OWN per-lane cap individually — a split that shares one real engine lane
            // can each independently pass that check yet SUM well past the real concentration cap once
            // folded onto the one lane the engine actually sizes (e.g. LONG at its own 35% cap + SHORT at
            // 12% both "pass", but the real lane would be installed at 47%). Re-validate the FOLDED total
            // PER LANE against the same effCap formula decideCortex/checkCortexInvariants use; any
            // violation discards the WHOLE promoted map for this cycle — never a silent partial install.
            const foldViolations = Object.entries(summed).filter(
              ([engineLaneId, w]) => w > Math.max(staticByEngineLaneId[engineLaneId] ?? 0, CORTEX_LANE_CAP_PCT) + 1e-6,
            );
            if (foldViolations.length === 0) {
              promotedWeights = summed;
            } else {
              console.error(
                "[cortex-live] promoted decision failed the POST-FOLD per-engine-lane cap — falling back to the incumbent table this cycle",
                foldViolations,
              );
            }
          }
        }
      } else {
        console.error("[cortex-live] promoted decision failed invariants — falling back to the incumbent table this cycle", nonTotalViolations);
      }
    }
  }
  return { decision, invariants, snapshots, promotedWeights };
}

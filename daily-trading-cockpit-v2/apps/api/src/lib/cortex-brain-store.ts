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
 *  disk/OOM bomb. Bound it: at ~3KB/decision, 8MB ≈ 2.6k decisions; one rolling .1 backup ⇒ ≤16MB on disk. */
export const CORTEX_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

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
  mode: CortexBrainMode;
  resolvedThisCycle?: number;
  promotion?: { regimeCoverageGateMet: boolean; blindCapitalPct: number; envBlocked: boolean } | null;
}): { decision: CortexDecision; invariants: CortexInvariantResult; promotedWeights: Record<string, number> | null } {
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

  let promotedWeights: Record<string, number> | null = null;
  if (deps.mode === "live" && deps.promotion && !deps.promotion.envBlocked) {
    const promotedBeta = cortexPromotedBeta(state.cumulativeResolved, deps.promotion.regimeCoverageGateMet, deps.promotion.blindCapitalPct);
    if (promotedBeta > 0) {
      const promoted = decideCortex(deps.context, state, { beta: promotedBeta });
      const promotedInvariants = checkCortexInvariants(promoted);
      if (promotedInvariants.ok) {
        // Fold the roster's synthetic direction-split ids (e.g. CG_MFE_GIVEBACK_LONG/_SHORT) onto the
        // one real engine lane they both size — see engineLaneIdForStaticWeight's own doc for why: the
        // execution engine has no concept of the split, only ONE real weight slot per engine lane id.
        const summed: Record<string, number> = {};
        const staticByEngineLaneId: Record<string, number> = {};
        for (const l of promoted.lanes) {
          const engineLaneId = engineLaneIdForStaticWeight(l.laneId);
          summed[engineLaneId] = (summed[engineLaneId] ?? 0) + Math.max(0, l.finalPct);
          // Duplicate roster entries share the identical real static value (both call the SAME real
          // accessor) — max() is just a defensive tie-break, not an actual combine rule.
          staticByEngineLaneId[engineLaneId] = Math.max(staticByEngineLaneId[engineLaneId] ?? 0, l.staticPct);
        }
        // 2026-07-20 safety-review fix (CRITICAL): checkCortexInvariants above validated each ROSTER
        // entry against its OWN per-lane cap individually — a split that shares one real engine lane
        // can each independently pass that check yet SUM well past the real concentration cap once
        // folded onto the one lane the engine actually sizes (e.g. LONG at its own 35% cap + SHORT at
        // 12% both "pass", but the real lane would be installed at 47%). Re-validate the FOLDED total
        // against the same effCap formula decideCortex/checkCortexInvariants use; any violation
        // discards the WHOLE promoted map for this cycle — never a silent partial/clamped install.
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
      } else {
        console.error("[cortex-live] promoted decision failed invariants — falling back to the incumbent table this cycle", promotedInvariants.violations);
      }
    }
  }
  return { decision, invariants, promotedWeights };
}

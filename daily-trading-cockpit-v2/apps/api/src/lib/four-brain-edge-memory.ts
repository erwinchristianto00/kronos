/**
 * Four-Brain EDGE-MEMORY feedback (Track 2 of the learning-feedback-loop spec, 2026-07-23, REPORT-ONLY,
 * SELF-referential). Lets the Direction Brain see ITS OWN measured LONG/SHORT track record — sourced from
 * direction-entry-outcome-store.ts's RESOLVED DirectionOutcomeRecord[] (the exact counterfactual outcomes
 * /api/shadow/direction-entry-outcomes already reports) — and apply a SOFT proven-negative penalty next
 * to the existing (incumbent) edge-memory veto, mirroring regime-edge-memory.ts's smart-direction-gate
 * discipline but scoped entirely to the four-brain layer's own decisions. Nothing here reads or writes
 * any order/lane/allocation state; it is a pure read-derived view over an existing report-only store.
 *
 * ── SCHEMA-DRIVEN DEVIATION FROM THE DESIGN NOTE (documented, not papered over) ──────────────────────
 * The design intent was to bucket by regimeFamily × direction × horizon, mirroring regime-edge-memory.ts's
 * own regimeFamily × direction key exactly, extended with horizon. But DirectionOutcomeRecord
 * (direction-entry-outcome-store.ts) carries NO regime field: PendingDirectionRow / extractPendingDirectionRow
 * (four-brain-outcome-ledger.ts:43-50,193-208) never captured one — only {decisionId, asOfMs, horizon,
 * action, expectedDirectionalR} survive from the journaled decision through to the resolved record (see
 * direction-entry-reconciler.ts's own DirectionOutcomeRecord construction). Track 2 is scoped to its own
 * new file plus two minimal wiring edits (per its own spec) — direction-entry-outcome-store.ts is
 * deliberately NOT one of them, and it is shared with Track 1's backfill harness, so this file cannot
 * honestly retrofit a per-record regime tag that was never captured.
 *
 * Rather than silently mislabel every row under one fabricated regime bucket (which would make the
 * `regimeRaw` parameter LOOK like it does something it doesn't), this store buckets by
 * `${direction}::${horizon}` ONLY. `regimeRaw` is still accepted by `fourBrainEdgeVerdict` — matching
 * regime-edge-memory.ts's own `verdict(regimeRaw, direction)` shape and the call site's
 * `fourBrainEdgeVerdict(fbEdge, dep.regimeRaw, "LONG", horizon)` wiring — but is currently UNUSED for
 * bucketing (kept for API-shape parity + forward compatibility: if a later change threads regime context
 * into DirectionOutcomeRecord, only this file's bucket key needs to change; every call site already
 * passes regimeRaw through). This is still an honest, real, self-referential measurement — just
 * direction/horizon-conditioned rather than regime-conditioned. Under-conditioning only makes the veto
 * MORE conservative (a broader pool is harder to prove negative), never less honest.
 *
 * ── "Diagnostic-exclusion" discipline (mirrors regime-edge-memory.ts's own DIAGNOSTIC_ONLY/
 * BACKFILL_DIAGNOSTIC exclusion) ────────────────────────────────────────────────────────────────────
 * Only rows with status "RESOLVED" are counted — EXPIRED_UNRESOLVABLE rows never got a real chosenNetR
 * (direction-brain-resolver.ts's emptyOutcome() pins chosenNetR:null for every non-EVALUATED status).
 * FLAT/BOTH action rows are ALSO excluded from the LONG/SHORT buckets: FLAT's chosenNetR is pinned to
 * EXACTLY 0 by definition (never a real directional outcome), and BOTH's chosenNetR is
 * mean(longNetR, shortNetR) — a blended figure not attributable to either side alone. Folding either in
 * would be exactly the contamination regime-edge-memory.ts's own doc warns about (49 diagnostic
 * bullish-longs flipping BULLISH×LONG from +0.178 to −0.058 there). Only rows whose `action` IS "LONG"
 * (chosenNetR === longNetR at resolution time) or IS "SHORT" (chosenNetR === shortNetR) are counted.
 *
 * ── Anti-fabrication (mirrors four-brain-live-gather-bindings.ts's own edgeR() "n=0 fabricated-0 trap") ──
 * n < MIN_SAMPLES ⇒ ALLOW_INSUFFICIENT with avgNetR:null — never a synthetic zero/negative edge.
 */
import {
  getDirectionEntryOutcomeStore,
  type DirectionEntryOutcomeStore,
  type DirectionOutcomeRecord,
} from "./direction-entry-outcome-store.js";
import type { FourBrainOutcomeHorizon } from "./four-brain-outcome-ledger.js";
import { EDGE_MIN_SAMPLES } from "./regime-edge-memory.js";

export type FourBrainEdgeDirection = "LONG" | "SHORT";
export type FourBrainEdgeVerdictDecision = "ALLOW_PROVEN" | "ALLOW_INSUFFICIENT" | "VETO_NEGATIVE";

/** Min RESOLVED same-direction rows before a slice is "proven" either way. Reuses regime-edge-memory.ts's
 *  own EDGE_MIN_SAMPLES verbatim (not re-derived) — same threshold, for consistency between the two
 *  independent edge-memory stores. */
export const MIN_SAMPLES = EDGE_MIN_SAMPLES;

export interface FourBrainEdgeLookup {
  n: number;
  /** null when n===0 — NEVER a fabricated zero. See module doc's anti-fabrication section. */
  avgNetR: number | null;
}

export interface FourBrainEdgeVerdict {
  verdict: FourBrainEdgeVerdictDecision;
  avgNetR: number | null;
  n: number;
}

interface Bucket {
  n: number;
  sumNetR: number;
}

function bucketKey(direction: FourBrainEdgeDirection, horizon: FourBrainOutcomeHorizon): string {
  return `${direction}::${horizon}`;
}

/** Pure fold: RESOLVED, LONG/SHORT-only rows → per (direction, horizon) {n, sumNetR}. See module doc's
 *  "diagnostic-exclusion" section for exactly why FLAT/BOTH/non-RESOLVED rows are excluded. Exported for
 *  tests; not part of the public feature surface. */
export function foldDirectionOutcomeRecordsForEdgeMemory(
  records: readonly DirectionOutcomeRecord[],
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const r of records) {
    if (r.status !== "RESOLVED") continue;
    if (r.action !== "LONG" && r.action !== "SHORT") continue;
    if (typeof r.chosenNetR !== "number" || !Number.isFinite(r.chosenNetR)) continue; // defensive; should not arise
    const key = bucketKey(r.action, r.horizon);
    const b = buckets.get(key) ?? { n: 0, sumNetR: 0 };
    b.n += 1;
    b.sumNetR += r.chosenNetR;
    buckets.set(key, b);
  }
  return buckets;
}

/**
 * Self-referential Direction-Brain edge memory. Rebuilt idempotently from
 * DirectionEntryOutcomeStore's RESOLVED DirectionOutcomeRecord[] only (own outcomes only — see module doc
 * for why this is direction×horizon-keyed, not regime×direction×horizon). Owns no persisted file of its
 * own: `rebuild()` is a full, deterministic re-fold of the outcome store's CURRENT records (bounded by
 * that store's own MAX_DIRECTION_RECORDS=800), never an incremental patch that could drift from it.
 */
export class FourBrainEdgeMemoryStore {
  private buckets: Map<string, Bucket> = new Map();

  constructor(private readonly outcomeStore: DirectionEntryOutcomeStore) {
    this.rebuild();
  }

  /** Recompute buckets from the outcome store's CURRENT persisted records. Idempotent + safe to call
   *  every time a fresh verdict is needed (e.g. once per shadow tick). */
  rebuild(): void {
    this.buckets = foldDirectionOutcomeRecordsForEdgeMemory(this.outcomeStore.getState().direction.records);
  }

  /** {n, avgNetR} for one (direction, horizon) slice. n===0 ⇒ avgNetR:null (never a fabricated 0 — see
   *  module doc's anti-fabrication section). */
  lookup(direction: FourBrainEdgeDirection, horizon: FourBrainOutcomeHorizon): FourBrainEdgeLookup {
    const b = this.buckets.get(bucketKey(direction, horizon));
    if (!b || b.n === 0) return { n: 0, avgNetR: null };
    return { n: b.n, avgNetR: b.sumNetR / b.n };
  }
}

/**
 * Pure verdict from a (direction, horizon) slice — the same 3-way rule as regime-edge-memory.ts's
 * edgeVerdict, applied to the Direction Brain's own self-referential accuracy:
 *  - n < MIN_SAMPLES        → ALLOW_INSUFFICIENT (cold-start; avgNetR reported null, never fabricated)
 *  - n ≥ MIN_SAMPLES, avg≤0 → VETO_NEGATIVE (proven-negative — a SOFT penalty at the call site, never a
 *    hard gate; see direction-brain.ts's fourBrainLongVeto/fourBrainShortVeto wiring)
 *  - n ≥ MIN_SAMPLES, avg>0 → ALLOW_PROVEN
 *
 * `regimeRaw` is accepted (matching regime-edge-memory.ts's own verdict(regimeRaw, direction) shape and
 * this project's wiring call `fourBrainEdgeVerdict(fbEdge, dep.regimeRaw, "LONG", horizon)`) but currently
 * UNUSED for bucketing — see FourBrainEdgeMemoryStore's / this module's doc for why (DirectionOutcomeRecord
 * carries no regime field to bucket on).
 */
export function fourBrainEdgeVerdict(
  store: FourBrainEdgeMemoryStore,
  regimeRaw: string | null | undefined,
  direction: FourBrainEdgeDirection,
  horizon: FourBrainOutcomeHorizon,
): FourBrainEdgeVerdict {
  void regimeRaw; // accepted for signature parity / forward-compat only — see module doc
  const { n, avgNetR } = store.lookup(direction, horizon);
  if (n < MIN_SAMPLES || avgNetR === null) {
    return { verdict: "ALLOW_INSUFFICIENT", avgNetR: null, n };
  }
  return { verdict: avgNetR <= 0 ? "VETO_NEGATIVE" : "ALLOW_PROVEN", avgNetR, n };
}

let _singleton: FourBrainEdgeMemoryStore | null = null;
/** Process-wide four-brain edge memory, backed by the process-wide DirectionEntryOutcomeStore (the SAME
 *  singleton /api/shadow/direction-entry-outcomes reads — see direction-entry-outcome-store.ts:956).
 *  Mirrors getRegimeEdgeMemory's singleton pattern (regime-edge-memory.ts:306): `dataDir` only matters on
 *  first construction. Always rebuilds before returning so callers see the freshest resolved outcomes
 *  (cheap — bounded by MAX_DIRECTION_RECORDS). */
export function getFourBrainEdgeMemory(dataDir = "data"): FourBrainEdgeMemoryStore {
  if (!_singleton) {
    _singleton = new FourBrainEdgeMemoryStore(getDirectionEntryOutcomeStore(dataDir));
  } else {
    _singleton.rebuild();
  }
  return _singleton;
}
/** Test-only reset — mirrors _resetDirectionEntryOutcomeStoreForTests's contract exactly. */
export function _resetFourBrainEdgeMemoryForTests(): void {
  _singleton = null;
}

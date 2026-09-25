/**
 * Four-Brain EDGE-MEMORY feedback (Track 2 of the learning-feedback-loop spec, 2026-07-23, REPORT-ONLY,
 * SELF-referential). Lets the Direction Brain see ITS OWN measured LONG/SHORT track record — sourced from
 * direction-entry-outcome-store.ts's RESOLVED DirectionOutcomeRecord[] (the exact counterfactual outcomes
 * /api/shadow/direction-entry-outcomes already reports). It is a market-direction calibration view only;
 * exact testnet-fill reinforcement is handled separately. Nothing here reads or writes any
 * order/lane/allocation state; it is a pure read-derived view over an existing report-only store.
 *
 * ── Canonical-regime lineage ───────────────────────────────────────────────────────────────────────
 * Direction outcomes carry the executor's canonical regime from their original Executive record and are
 * bucketed by canonical-regime × direction × horizon. Legacy records remain explicitly UNKNOWN; no later
 * market state is inferred for them and they cannot contaminate BULLISH/BEARISH/MIXED calibration.
 *
 * These outcomes are BTC-proxy MARKET-DIRECTION CALIBRATION only. They are no longer wired into a
 * candidate recommendation. Candidate-level positive/negative reinforcement comes from the separate
 * Tier-1 exact-fill lane × regime × symbol × side memory.
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
import { resolve } from "node:path";
import type { FourBrainOutcomeHorizon } from "./four-brain-outcome-ledger.js";
import { EDGE_MIN_SAMPLES } from "./regime-edge-memory.js";
import { HORIZON_MS } from "./direction-brain-resolver.js";

export type FourBrainEdgeDirection = "LONG" | "SHORT";
export type FourBrainEdgeVerdictDecision = "ALLOW_PROVEN" | "ALLOW_INSUFFICIENT" | "VETO_NEGATIVE";
export type FourBrainEdgeRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

/** Min RESOLVED same-direction rows before a slice is "proven" either way. Reuses regime-edge-memory.ts's
 *  own EDGE_MIN_SAMPLES verbatim (not re-derived) — same threshold, for consistency between the two
 *  independent edge-memory stores. */
export const MIN_SAMPLES = EDGE_MIN_SAMPLES;

export interface FourBrainEdgeLookup {
  /** Raw resolved-row count. Reported for transparency but NOT what gates the verdict — see effectiveN. */
  n: number;
  /** Non-overlapping-window count: distinct floor(asOfMs / HORIZON_MS[horizon]) blocks among this
   *  bucket's rows — the same block definition direction-brain-resolver.ts and
   *  direction-entry-outcome-store.ts already use. THIS is what gates the verdict.
   *
   *  2026-07-26 fix. Previously the MIN_SAMPLES gate read raw n, which overstates the evidence badly
   *  because a horizon's decisions overlap: measured on live testnet data, SWING carried raw n=881
   *  against effectiveN=4, and LONG/SWING was firing VETO_NEGATIVE off 45 raw rows that were really
   *  ~4 independent draws (avgNetR -3.63R, an artifact of a handful of overlapping windows).
   *  INTRADAY was raw 1117 vs effectiveN 27. The outcome store's own report already gates on
   *  effective sample size for exactly this reason; this memory was the one consumer that did not,
   *  so it was suppressing a real LONG score on evidence it did not have. */
  effectiveN: number;
  /** null when n===0 — NEVER a fabricated zero. See module doc's anti-fabrication section. */
  avgNetR: number | null;
}

export interface FourBrainEdgeVerdict {
  verdict: FourBrainEdgeVerdictDecision;
  avgNetR: number | null;
  /** Raw row count — reported, but NOT the sufficiency test. */
  n: number;
  /** Non-overlapping windows — THIS is what MIN_SAMPLES is compared against. */
  effectiveN: number;
}

interface Bucket {
  n: number;
  sumNetR: number;
  /** Distinct non-overlapping horizon blocks this bucket's rows fall in. A Set (not a counter)
   *  because rows arrive in no guaranteed order here — unlike the outcome store, which can use an
   *  O(1) last-block-seen counter precisely because it books rows in non-decreasing asOfMs order.
   *  Bounded by the store's own MAX_DIRECTION_RECORDS, so this cannot grow without limit. */
  blocks: Set<number>;
}

export function fourBrainEdgeRegimeFamily(value: unknown): FourBrainEdgeRegimeFamily {
  return value === "BULLISH" || value === "BEARISH" || value === "MIXED" || value === "UNKNOWN"
    ? value
    : "UNKNOWN";
}

function bucketKey(
  regimeFamily: FourBrainEdgeRegimeFamily,
  direction: FourBrainEdgeDirection,
  horizon: FourBrainOutcomeHorizon,
): string {
  return `${regimeFamily}::${direction}::${horizon}`;
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
    const key = bucketKey(fourBrainEdgeRegimeFamily(r.canonicalRegimeFamily), r.action, r.horizon);
    const b = buckets.get(key) ?? { n: 0, sumNetR: 0, blocks: new Set<number>() };
    b.n += 1;
    b.sumNetR += r.chosenNetR;
    const horizonMs = HORIZON_MS[r.horizon];
    if (Number.isFinite(r.asOfMs) && horizonMs > 0) b.blocks.add(Math.floor(r.asOfMs / horizonMs));
    buckets.set(key, b);
  }
  return buckets;
}

/**
 * Self-referential Direction-Brain edge memory. Rebuilt idempotently from
 * DirectionEntryOutcomeStore's RESOLVED DirectionOutcomeRecord[] only (own outcomes only — see module doc
 * for why this is canonical-regime×direction×horizon keyed). Owns no persisted file of its
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

  /** {n, effectiveN, avgNetR} for one (canonical regime, direction, horizon) slice. n===0 ⇒ avgNetR:null (never a
   *  fabricated 0 — see module doc's anti-fabrication section). effectiveN ≤ n always. */
  lookup(
    regimeOrDirection: string | null | undefined,
    directionOrHorizon: FourBrainEdgeDirection | FourBrainOutcomeHorizon,
    maybeHorizon?: FourBrainOutcomeHorizon,
  ): FourBrainEdgeLookup {
    // Two-argument UNKNOWN lookup is retained solely for older report/tests. New runtime callers must
    // use (canonicalRegimeFamily, direction, horizon); an older record can never leak into a known regime.
    const legacyUnknown = maybeHorizon === undefined;
    const regimeFamily = legacyUnknown ? "UNKNOWN" : fourBrainEdgeRegimeFamily(regimeOrDirection);
    const direction = (legacyUnknown ? regimeOrDirection : directionOrHorizon) as FourBrainEdgeDirection;
    const horizon = (legacyUnknown ? directionOrHorizon : maybeHorizon) as FourBrainOutcomeHorizon;
    const b = this.buckets.get(bucketKey(regimeFamily, direction, horizon));
    if (!b || b.n === 0) return { n: 0, effectiveN: 0, avgNetR: null };
    return { n: b.n, effectiveN: b.blocks.size, avgNetR: b.sumNetR / b.n };
  }
}

/**
 * Pure verdict from a (canonical regime, direction, horizon) slice — the same 3-way rule as regime-edge-memory.ts's
 * edgeVerdict, applied to the Direction Brain's own self-referential accuracy:
 *  - effectiveN < MIN_SAMPLES  → ALLOW_INSUFFICIENT (cold-start; avgNetR reported null, never fabricated)
 *  - effectiveN ≥ MIN_SAMPLES, avg≤0 → VETO_NEGATIVE (proven-negative — a SOFT penalty at the call site,
 *    never a hard gate; see direction-brain.ts's fourBrainLongVeto/fourBrainShortVeto wiring)
 *  - effectiveN ≥ MIN_SAMPLES, avg>0 → ALLOW_PROVEN
 *
 * The gate reads effectiveN (non-overlapping windows), NOT raw n — 2026-07-26 fix. Gating on raw n
 * let a bucket veto on evidence it did not have: live testnet had LONG/SWING at raw n=45 but only
 * ~4 independent windows, and it was suppressing LONG scores off an avgNetR of -3.63R that a handful
 * of overlapping windows produced. avgNetR is still the mean over ALL n rows (that is the best point
 * estimate available); only the SUFFICIENCY test changed.
 *
 * UNKNOWN is a deliberately separate legacy/missing regime bucket, not a fallback to a newer market state.
 */
export function fourBrainEdgeVerdict(
  store: FourBrainEdgeMemoryStore,
  regimeFamily: string | null | undefined,
  direction: FourBrainEdgeDirection,
  horizon: FourBrainOutcomeHorizon,
): FourBrainEdgeVerdict {
  const { n, effectiveN, avgNetR } = store.lookup(regimeFamily, direction, horizon);
  if (effectiveN < MIN_SAMPLES || avgNetR === null) {
    return { verdict: "ALLOW_INSUFFICIENT", avgNetR: null, n, effectiveN };
  }
  return { verdict: avgNetR <= 0 ? "VETO_NEGATIVE" : "ALLOW_PROVEN", avgNetR, n, effectiveN };
}

/** Edge memory is keyed by the same outcome data root as its source store. */
const edgeStoresByDataDir = new Map<string, FourBrainEdgeMemoryStore>();
/** Process-wide four-brain edge memory. The default remains `data/`; a focused testnet rollout can
 * use its own root and therefore cannot turn historic results into a new-cohort veto. */
export function getFourBrainEdgeMemory(dataDir = "data"): FourBrainEdgeMemoryStore {
  const key = resolve(dataDir);
  let store = edgeStoresByDataDir.get(key);
  if (!store) {
    store = new FourBrainEdgeMemoryStore(getDirectionEntryOutcomeStore(dataDir));
    edgeStoresByDataDir.set(key, store);
  } else store.rebuild();
  return store;
}
/** Test-only reset — mirrors _resetDirectionEntryOutcomeStoreForTests's contract exactly. */
export function _resetFourBrainEdgeMemoryForTests(): void {
  edgeStoresByDataDir.clear();
}

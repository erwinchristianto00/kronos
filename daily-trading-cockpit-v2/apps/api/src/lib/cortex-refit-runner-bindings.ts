/**
 * CORTEX #218 — impure bindings for the nightly refit: read the decision journal (line-resilient, both
 * the live .jsonl and the rotated .jsonl.1) + each lane's OWN resolved closes out of the six edge stores,
 * the cross-sectional store, and the CG variant matrix, then normalize them into the pure runner's inputs.
 * Every record that can't be normalized is TALLIED by reason (skipsByLane) so nothing is silently dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "./cortex-brain.js";
import {
  cortexShadowDecisionAlpha,
  type CortexDecisionRow,
  type CortexLaneDir,
  type CortexLaneOutcome,
  type CortexShadowDecisionAlphaResult,
} from "./cortex-attribution.js";
import {
  directionalObsToOutcome,
  xsecObsToOutcome,
  buildCortexAttrRoster,
  cortexLaneTtlMs,
  parseIsoMs,
  type CortexOutcomeSkipReason,
  type RawDirectionalObs,
  type RawXsecObs,
} from "./cortex-outcome-source.js";
import { runCortexRefit, type CortexRefitInput, type CortexRefitReport } from "./cortex-refit-runner.js";
import type { CortexBrainStore } from "./cortex-brain-store.js";
import {
  CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID,
  CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID,
  CORTEX_LANE_ROSTER,
} from "./cortex-live-gather.js";

import { applySubFloorExclusionForDecisions } from "./paper-subfloor-exclusion.js";
import { selectNewestCostCohort } from "./paper-cost-cohort.js";
import { getRegimeCompositeStore, RC_PAPER_LANE_ID } from "./regime-composite-edge.js";
import { getRegimeCompositeShortStore, RCS_PAPER_LANE_ID } from "./regime-composite-short-edge.js";
import { getShortFadeStore, SF_PAPER_LANE_ID } from "./short-fade-edge.js";
import { getIntradayMomentumStore, IM_PAPER_LANE_ID } from "./intraday-momentum-edge.js";
import { getPanicWashoutStore, PWR_PAPER_LANE_ID } from "./panic-washout-reclaim-edge.js";
import { getCompositeEstimatorStore, ceLaneIdForBucket } from "./composite-estimator-edge.js";
import { getCrossSectionalStore, type CrossSectionalObservation } from "./cross-sectional-edge.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  CROSS_SECTIONAL_TREND_LANE_ID,
  CROSS_SECTIONAL_MIXED_LANE_ID,
} from "./cross-sectional-executor.js";
import { getCurrentGuardVariantMatrixStore } from "./current-guard-variant-matrix.js";
import { peekPaperExecutionRouterStore } from "./paper-execution-router.js";
import {
  resolveCortexLearningEpoch,
  type CortexLearningEpochRejection,
  filterCortexLearningEpochRows,
  type CortexLearningEpoch,
} from "./cortex-learning-epoch.js";
import { forwardCausalJournalPath, readForwardCausalEvents, resolveCanonicalPolicyContext } from "../experience-engine/forward-causal-collection.js";
import { buildCortexExperienceBridge } from "../experience-engine/cortex-experience-bridge.js";

/** Only pull outcomes resolved within this window — older ones can't attribute (their decisions rotated
 *  out of the ~26-day journal) and the refit's recency decay makes them ~zero weight anyway. Bounds the
 *  CG matrix read (which can hold 100k+ obs). */
export const CORTEX_REFIT_LOOKBACK_MS = 45 * 86_400_000;

/**
 * Raw lane stores are paper/simulation measurement stores, not the normalized Experience Store. They
 * are permanently ineligible for CORTEX training because they do not carry an
 * exact decision → opportunity → outcome identity chain.
 *
 * WHAT THIS ACTUALLY DOES, stated plainly because the original wording invited a wrong reading (it
 * was summarised elsewhere as "CORTEX now trains only on causal-eligible data", which is not what
 * either branch does):
 *
 * The deprecated environment variable is intentionally ignored. A future
 * Experience Store bridge must pass direct identities and eligibility through
 * this binding; it may not re-enable this raw fallback.
 */
export function cortexRawStoreTrainingEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

/** Direction is part of the causal identity. CG_MFE is executable both ways, so its two books
 * must not share labels or training examples. */
const CG_ROSTER: readonly { laneId: string; variantId: string; direction: "LONG" | "SHORT" }[] = [
  { laneId: "CG_WIDE_FAST_LONG", variantId: "CG_WIDE_FAST_LONG", direction: "LONG" },
  { laneId: "CG_WIDE_LONG_RUNNER", variantId: "CG_WIDE_LONG_RUNNER", direction: "LONG" },
  { laneId: CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID, variantId: "CG_MFE_GIVEBACK", direction: "LONG" },
  { laneId: CORTEX_CG_MFE_GIVEBACK_SHORT_LANE_ID, variantId: "CG_MFE_GIVEBACK", direction: "SHORT" },
];
const XSEC_STORE_VARIANTS: Record<string, string> = {
  [CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID]: "FILTERED",
  [CROSS_SECTIONAL_TREND_LANE_ID]: "TREND_BETA_VOL",
  [CROSS_SECTIONAL_MIXED_LANE_ID]: "MIXED_MEAN_REVERSION",
};

// ─── PAPER-EXECUTION-ROUTER outcome source for the three DEAD LONG CG lanes ──────────────────────────
//
// WHY (measured 2026-07-26): the CG block below reads ONLY getCurrentGuardVariantMatrixStore().all, and
// that store's LONG side is dead — its LONG rows were all written inside one 23-hour window on
// 2026-06-27 and every one of them resolved BEFORE the CORTEX decision journal's earliest retained
// decision, so the three CG LONG lanes can never reach the 20 attributed examples LEARNING_ACTIVE needs
// no matter how long they wait. data/paper-execution-router.json, by contrast, holds fresh CLOSED orders
// for exactly those lanes with a real netR and a real market close timestamp. A router order's
// `openedAt` is the scan-batch timestamp, which always has a journaled brain decision inside the 50-min
// directional TTL, so attribution is causally sound (the owning decision strictly precedes the open) and
// carries no label leakage (nothing here is keyed on resolvedAt).
//
// ENV-GATED, DEFAULT OFF: with CORTEX_CG_ROUTER_OUTCOMES unset/≠"1" this whole block contributes
// nothing — no store read, no observations, no source entries — so the refit's inputs are byte-for-byte
// what they are today on every instance, including real-money mainnet 3103.

/** Router `selectedLaneId` namespaces. BOTH appear on real LONG orders (confirmed in the live store), so
 *  the prefix is NOT a usable direction label — direction is always taken from the order itself. Mirrors
 *  entry-brain-tier1-realized-resolver.ts's VARIANT_MATRIX_LANE_PREFIXES. */
const CG_ROUTER_LANE_PREFIXES = ["CG_LONG_VARIANT_MATRIX:", "CG_VARIANT_MATRIX:"] as const;

/**
 * Strip either router namespace off a `selectedLaneId`, returning the bare variant id — or null when the
 * id carries neither prefix (a non-variant-matrix router lane, which this source must ignore entirely).
 */
export function cortexCgRouterVariantId(selectedLaneId: string | null | undefined): string | null {
  const id = typeof selectedLaneId === "string" ? selectedLaneId.trim() : "";
  for (const prefix of CG_ROUTER_LANE_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return null;
}

/**
 * EXPLICIT ALLOWLIST — variantId → CORTEX laneId — for the THREE dead LONG lanes and nothing else.
 *
 * This is deliberately NOT `CG_ROSTER.find(l => l.variantId === v && l.direction === ord.direction)`:
 * that generic form also matches CG_MFE_GIVEBACK_SHORT, which already has a healthy, working
 * variant-matrix outcome source. Blending a second data-generating process (paper-router fills, a
 * different fill/cost/exit model) into a lane that is already learning would corrupt it mid-flight while
 * looking like nothing more than "more data". Every entry here is LONG by construction, and the reader
 * additionally requires the ORDER's own direction to be LONG, so a SHORT order can never land in any of
 * these books even if a future writer reuses one of these variant ids.
 */
const CG_ROUTER_LONG_LANE_BY_VARIANT: ReadonlyMap<string, string> = new Map<string, string>([
  ["CG_WIDE_FAST_LONG", "CG_WIDE_FAST_LONG"],
  ["CG_WIDE_LONG_RUNNER", "CG_WIDE_LONG_RUNNER"],
  ["CG_MFE_GIVEBACK", CORTEX_CG_MFE_GIVEBACK_LONG_LANE_ID],
]);

/** The CORTEX lane ids this source may EVER write to. Exported so a test can assert the negative
 *  (CG_MFE_GIVEBACK_SHORT is not a member) without reaching into module internals. */
export const CORTEX_CG_ROUTER_ALLOWED_LANE_IDS: readonly string[] = [...CG_ROUTER_LONG_LANE_BY_VARIANT.values()];

/** The mark-to-market close reason. 141/200 of CG_WIDE_LONG_RUNNER's router closes carry it. */
const ROUTER_MAX_HOLD_MTM_REASON = "MAX_HOLD_MTM";

/** ECMA-262's maximum representable time value. `new Date(x).toISOString()` THROWS RangeError beyond it,
 *  and this code runs inside the real-money mainnet process — one corrupt row in a 100k-order book must
 *  degrade to a counted BAD_TIMESTAMP, never take down the whole nightly refit. */
const MAX_EPOCH_MS = 8.64e15;
function safeEpochToIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS ? new Date(ms).toISOString() : null;
}

/** The minimal structural shape this source needs from a PaperOrder (real PaperOrder is assignable). */
export interface CortexCgRouterOrderLike {
  paperOrderId: string;
  selectedLaneId: string;
  direction: "LONG" | "SHORT";
  openedAt: string;
  paperStatus: string;
  netR: number | null;
  /** MARKET timestamp of the exit candle — the documented attribution key (never updatedAt/Date.now). */
  closedAtMs?: number | null;
  closeReason?: string | null;
  /** T1-b: read only by the sub-admission-floor predicate. Absent ⇒ row is never excluded. */
  sourceType?: string | null;
  plannedStopDistanceBps?: number | null;
  /** Cost-model generation `netR` was priced under. Generations are NOT comparable, and netR is the
   *  training reward here — see the cohort selection in collectCortexCgRouterObs. */
  costModelVersion?: number | null;
}

export interface CortexCgRouterLaneCounts {
  /** Observations handed to the normalizer for this lane. */
  admitted: number;
  /** MAX_HOLD_MTM closes DROPPED because CORTEX_CG_ROUTER_INCLUDE_MTM is off (the default). */
  maxHoldMtmExcluded: number;
  /** MAX_HOLD_MTM closes ADMITTED because the operator explicitly opted in. NOT realized edge. */
  maxHoldMtmIncluded: number;
  /** Router orders for this lane that never reached a WIN/LOSS close (still open, rejected, no-fill…). */
  nonClosedSkipped: number;
}

export interface CortexCgRouterOutcomeSummary {
  /** CORTEX_CG_ROUTER_OUTCOMES === "1". False ⇒ this source contributed literally nothing. */
  enabled: boolean;
  /** False ⇒ the paper-router singleton was NOT already resident, so nothing was read (see the
   *  cold-parse guard on readResidentCgRouterOrders). Honest "we produced no data and why". */
  storeResident: boolean;
  /** Router orders scanned (0 when disabled or not resident). */
  ordersScanned: number;
  /** CORTEX_CG_ROUTER_INCLUDE_MTM === "1". TRUE means mark-to-market marks are being fed to the learner
   *  as if they were realized outcomes — see the honesty note on collectCortexCgRouterObs. */
  includeMaxHoldMtm: boolean;
  /** Total MTM marks admitted across all three lanes. Non-zero here is the loud signal that this run's
   *  CG LONG evidence is NOT purely realized. */
  maxHoldMtmIncludedTotal: number;
  byLane: Record<string, CortexCgRouterLaneCounts>;
}

function emptyRouterLaneCounts(): CortexCgRouterLaneCounts {
  return { admitted: 0, maxHoldMtmExcluded: 0, maxHoldMtmIncluded: 0, nonClosedSkipped: 0 };
}

export function emptyCortexCgRouterSummary(
  over: Partial<CortexCgRouterOutcomeSummary> = {},
): CortexCgRouterOutcomeSummary {
  return {
    enabled: false,
    storeResident: false,
    ordersScanned: 0,
    includeMaxHoldMtm: false,
    maxHoldMtmIncludedTotal: 0,
    byLane: {},
    ...over,
  };
}

/** CORTEX_CG_ROUTER_OUTCOMES — default OFF. Opt-in only, exact "1" (no truthy-string ambiguity). */
export function cortexCgRouterOutcomesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CORTEX_CG_ROUTER_OUTCOMES === "1";
}

/** CORTEX_CG_ROUTER_INCLUDE_MTM — default OFF. Its own flag, deliberately NOT folded into the one
 *  above: turning the router source on must not silently also turn mark-to-market marks on. */
export function cortexCgRouterIncludeMaxHoldMtm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CORTEX_CG_ROUTER_INCLUDE_MTM === "1";
}

/**
 * PURE: fold paper-router orders into per-lane RawDirectionalObs for the three allowlisted LONG CG lanes.
 *
 * MAX_HOLD_MTM HONESTY GUARD (default: EXCLUDE). A MAX_HOLD_MTM close is a mark-to-market snapshot at the
 * max-hold horizon, not a realized exit — the documented phantom-equity hazard. 141 of
 * CG_WIDE_LONG_RUNNER's 200 router closes are MAX_HOLD_MTM and its router netR sums to roughly +104R,
 * while the SAME lane in the variant-matrix store shows 337 CLOSED_LOSS against 2 CLOSED_WIN. That
 * divergence is strong evidence the +104R is a marking artifact rather than edge, so these marks are
 * DROPPED unless the operator sets CORTEX_CG_ROUTER_INCLUDE_MTM=1. Either way the counts are reported
 * per lane (and logged by runCortexNightlyRefit), and admitted marks are namespaced `router-mtm:` rather
 * than `router:` so their provenance stays visible forever in the store's counted-observation ledger —
 * nobody can later read an MTM-fed lane as realized edge.
 *
 * Everything that is not admitted is COUNTED in the returned summary (module contract: no silent drops).
 * Rows with a corrupt openedAt / missing close timestamp / non-finite netR are deliberately PASSED
 * THROUGH to directionalObsToOutcome so they are tallied as BAD_TIMESTAMP / NO_OUTCOME_VALUE in the
 * standard skipsByLane report, exactly like the variant-matrix block does.
 *
 * COST: a single O(orders) pass of string compares + one Map lookup each, run once per refit interval
 * (6h by default). On the largest real book that is single-digit milliseconds — orders of magnitude below
 * the file parse this deliberately never performs (see readResidentCgRouterOrders).
 */
export function collectCortexCgRouterObs(
  orders: readonly CortexCgRouterOrderLike[],
  opts: { includeMaxHoldMtm: boolean },
): { byLane: Map<string, RawDirectionalObs[]>; byLaneCounts: Record<string, CortexCgRouterLaneCounts> } {
  const byLane = new Map<string, RawDirectionalObs[]>();
  const byLaneCounts: Record<string, CortexCgRouterLaneCounts> = {};
  for (const laneId of CG_ROUTER_LONG_LANE_BY_VARIANT.values()) {
    byLane.set(laneId, []);
    byLaneCounts[laneId] = emptyRouterLaneCounts();
  }

  // T1-b DECISION PATH (refit → promotion) — gated, DEFAULT OFF, and a GUARD RATHER THAN A FIX.
  // Measured over the testnet store 2026-07-26: the three-lane allowlist below
  // (CG_WIDE_FAST_LONG / CG_WIDE_LONG_RUNNER / CG_MFE_GIVEBACK) holds 408 closed non-MTM LONG
  // router rows and EXACTLY ZERO of them are sub-floor — the two contaminated variants
  // (CG_BASELINE_FAST_05 / CG_MAKER_FAST_05) are not on the allowlist and never have been. So
  // enabling the flag changes no CORTEX weight, no readiness status and no promotion TODAY. It is
  // wired anyway because CG_ROUTER_LONG_LANE_BY_VARIANT is a hand-maintained constant: without
  // this, the next person to add a fourth lane inherits the contamination silently.
  // The zero-delta claim is enforced by a test, not remembered.
  // NEVER pool cost-model generations into CORTEX training. netR IS the reward signal here, and a
  // generation change moves it with no edge change whatsoever (the v1->v2 cutover alone moved maker
  // lanes up to +16bps/stopBps and taker stop-heavy lanes -5bps). Pooled, the identical setup would
  // appear to pay differently depending only on WHEN it closed relative to the cutover — a step
  // change in the reward that is indistinguishable, to a fitted coefficient, from a real edge shift.
  // Judge on the newest generation present; minRows=0 because the refit's own min-examples gate
  // downstream is what decides whether the sample is adequate.
  const subFloorScoped = applySubFloorExclusionForDecisions(orders);
  const scoped = selectNewestCostCohort(subFloorScoped)?.rows ?? [];
  for (const ord of scoped) {
    const variantId = cortexCgRouterVariantId(ord?.selectedLaneId);
    if (variantId === null) continue; // not a variant-matrix router lane at all
    const laneId = CG_ROUTER_LONG_LANE_BY_VARIANT.get(variantId);
    if (laneId === undefined) continue; // (a) NOT on the three-lane allowlist — e.g. CG_WIDE_STOP_TP_WIDE
    // (b) Direction comes from the ORDER, never from the "CG_LONG_" prefix. Both namespaces carry LONG
    // orders in the real store, and this is also the second, independent guard that keeps a SHORT
    // CG_MFE_GIVEBACK order out of the already-healthy CG_MFE_GIVEBACK_SHORT book.
    if (ord.direction !== "LONG") continue;

    const counts = byLaneCounts[laneId]!;
    const isClosed = ord.paperStatus === "PAPER_CLOSED_WIN" || ord.paperStatus === "PAPER_CLOSED_LOSS";
    if (!isClosed) {
      counts.nonClosedSkipped += 1;
      continue;
    }

    const isMtm = (ord.closeReason ?? "") === ROUTER_MAX_HOLD_MTM_REASON;
    if (isMtm && !opts.includeMaxHoldMtm) {
      counts.maxHoldMtmExcluded += 1;
      continue;
    }
    if (isMtm) counts.maxHoldMtmIncluded += 1;

    // A corrupt openedAt becomes NaN (NOT a silent skip) so directionalObsToOutcome tallies BAD_TIMESTAMP.
    const openedAtMs = parseIsoMs(ord.openedAt) ?? Number.NaN;
    // closedAtMs is the MARKET close timestamp — the only legitimate attribution key here. A row without a
    // usable one becomes resolvedAt=null ⇒ BAD_TIMESTAMP, never a fabricated resolvedAtMs/updatedAt/
    // Date.now() fallback (paper-execution-router.ts is explicit that resolvedAtMs is audit-only).
    const resolvedAt = safeEpochToIso(ord.closedAtMs);

    byLane.get(laneId)!.push({
      // Namespaced so it can never collide with a variant-matrix observationId for the same lane (the
      // attribution dedupe key is `${laneId}::${observationId}`), and so MTM provenance is permanent.
      observationId: `${isMtm ? "router-mtm" : "router"}:${ord.paperOrderId}`,
      openedAtMs,
      resolvedAt,
      status: ord.paperStatus === "PAPER_CLOSED_WIN" ? "CLOSED_WIN" : "CLOSED_LOSS",
      netR: typeof ord.netR === "number" && Number.isFinite(ord.netR) ? ord.netR : null,
    });
    counts.admitted += 1;
  }

  return { byLane, byLaneCounts };
}

/**
 * (c) COLD-PARSE GUARD — how this is guaranteed:
 *
 * This reader calls peekPaperExecutionRouterStore(), which returns the module singleton ONLY if some
 * earlier caller already constructed it, and NEVER constructs it. It is therefore impossible for the
 * refit to be the first caller that materializes the store, and impossible for this code path to
 * trigger the ~107 MB synchronous readFileSync + JSON.parse that `new PaperExecutionRouterStore()`
 * performs. On testnet/live the store is instantiated at boot (app.ts wires it into the execution
 * engine), so `.all` is a free in-memory array reference. In the standalone-CORTEX path (app.ts's
 * cortexStandaloneRefitTick, liveEngine absent) it is typically NOT resident — there this returns null
 * and the source honestly contributes nothing, rather than paying a multi-second event-loop block on
 * every refit interval. That was the failure shape of the 2026-07-20 testnet-unresponsive incident (a
 * 234 MB file re-read per poll, CPU 140%), and the refit shares its process with the live mainnet
 * execution engine on 3103.
 */
function readResidentCgRouterOrders(): readonly CortexCgRouterOrderLike[] | null {
  const store = peekPaperExecutionRouterStore();
  return store ? store.all : null;
}

/** Impure wrapper: apply the two env flags + the residency guard, then fold via the pure collector. */
export function gatherCortexCgRouterOutcomes(deps: {
  env?: NodeJS.ProcessEnv;
  readOrders?: () => readonly CortexCgRouterOrderLike[] | null;
}): { byLane: Map<string, RawDirectionalObs[]>; summary: CortexCgRouterOutcomeSummary } {
  const env = deps.env ?? process.env;
  if (!cortexCgRouterOutcomesEnabled(env)) {
    // Default path: no store touched, no source entries produced — today's behavior exactly.
    return { byLane: new Map(), summary: emptyCortexCgRouterSummary() };
  }
  const includeMaxHoldMtm = cortexCgRouterIncludeMaxHoldMtm(env);
  const orders = (deps.readOrders ?? readResidentCgRouterOrders)();
  if (orders === null) {
    return {
      byLane: new Map(),
      summary: emptyCortexCgRouterSummary({ enabled: true, storeResident: false, includeMaxHoldMtm }),
    };
  }
  const { byLane, byLaneCounts } = collectCortexCgRouterObs(orders, { includeMaxHoldMtm });
  return {
    byLane,
    summary: {
      enabled: true,
      storeResident: true,
      ordersScanned: orders.length,
      includeMaxHoldMtm,
      maxHoldMtmIncludedTotal: Object.values(byLaneCounts).reduce((s, c) => s + c.maxHoldMtmIncluded, 0),
      byLane: byLaneCounts,
    },
  };
}

/**
 * PURE: render the CG-router source's one-line operator log, or null when the source is disabled (the
 * default — a disabled source must not add a line of noise to every refit tick).
 *
 * The MTM wording is deliberately blunt: when marks are included the line says so in capitals and names
 * them "NOT-REALIZED", so an operator reading the log can never mistake an MTM-fed lane's R for edge.
 */
export function formatCortexCgRouterOutcomeSummary(summary: CortexCgRouterOutcomeSummary): string | null {
  if (!summary.enabled) return null;
  if (!summary.storeResident) {
    return "[cortex-refit] CG_ROUTER_OUTCOMES=1 but the paper-execution-router store is NOT resident in this process — no router outcomes read (deliberate: never cold-parse the ~107MB book on the refit interval).";
  }
  const lanes = Object.entries(summary.byLane)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([laneId, c]) =>
        `${laneId} admitted=${c.admitted} mtmExcluded=${c.maxHoldMtmExcluded} mtmIncluded=${c.maxHoldMtmIncluded} nonClosed=${c.nonClosedSkipped}`,
    )
    .join(" | ");
  const mtmNote =
    summary.maxHoldMtmIncludedTotal > 0
      ? ` *** WARNING: ${summary.maxHoldMtmIncludedTotal} MAX_HOLD_MTM mark-to-market closes were ADMITTED as outcomes (CORTEX_CG_ROUTER_INCLUDE_MTM=1). These are NOT-REALIZED marks; their R is not edge. Their observationIds are namespaced "router-mtm:". ***`
      : "";
  return `[cortex-refit] CG_ROUTER_OUTCOMES=1 scanned=${summary.ordersScanned} includeMaxHoldMtm=${summary.includeMaxHoldMtm} — ${lanes}${mtmNote}`;
}

function logCortexCgRouterOutcomeSummary(summary: CortexCgRouterOutcomeSummary): void {
  const line = formatCortexCgRouterOutcomeSummary(summary);
  if (line !== null) console.log(line);
}

/** Parse the append-only journal into decision rows. Per-line try/catch (a truncated line is skipped +
 *  counted, never aborts the read), reads .jsonl.1 (older) before .jsonl (newer), dedupes rows by `at`. */
export function readCortexDecisionRows(files: string[]): { rows: CortexDecisionRow[]; badLines: number; totalLines: number } {
  const byAt = new Map<string, CortexDecisionRow>();
  let badLines = 0;
  let totalLines = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      totalLines += 1;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        badLines += 1;
        continue;
      }
      // 2026-07-22 fix: these 2 checks previously dropped the line with no counter touched, contradicting
      // this file's own header claim that "every record that can't be normalized is TALLIED by reason ...
      // so nothing is silently dropped". A syntactically-valid but semantically-invalid line (wrong/missing
      // `kind`/`at`, or an unparsable `at`) is exactly the class of corruption `badLines` exists to surface —
      // it must count the same as a JSON.parse failure, not vanish silently. The dedupe check right after
      // (identical decision re-seen across .jsonl/.jsonl.1 rotation) stays UNCOUNTED — that's expected,
      // not corruption.
      if (rec.kind !== "BRAIN_DECISION" || typeof rec.at !== "string") {
        badLines += 1;
        continue;
      }
      if (byAt.has(rec.at)) continue; // dedupe: identical decision across rotation
      const atMs = parseIsoMs(rec.at);
      if (atMs === null) {
        badLines += 1;
        continue;
      }
      const lanes = new Map<string, { x: number[]; eligible: boolean; direction: CortexLaneDir | null; finalPct: number; evalFinalPct: number }>();
      const rawLanes = Array.isArray(rec.lanes) ? (rec.lanes as Record<string, unknown>[]) : [];
      for (const l of rawLanes) {
        const laneId = typeof l.laneId === "string" ? l.laneId : null;
        const x = Array.isArray(l.x) ? (l.x as unknown[]).map(Number) : null;
        if (!laneId || !x || x.length === 0 || !x.every((v) => Number.isFinite(v))) continue;
        const dir = l.direction === "LONG" || l.direction === "SHORT" || l.direction === "NEUTRAL" ? (l.direction as CortexLaneDir) : null;
        const finalPct = typeof l.finalPct === "number" && Number.isFinite(l.finalPct) ? l.finalPct : 0;
        // Older rows journaled before #219 have no evalFinalPct — fall back to finalPct (β=0 ⇒ no tilt,
        // which is the correct reading for a row that never carried an eval-counterfactual weight at all).
        const evalFinalPct = typeof l.evalFinalPct === "number" && Number.isFinite(l.evalFinalPct) ? l.evalFinalPct : finalPct;
        lanes.set(laneId, { x, eligible: l.eligible === true, direction: dir, finalPct, evalFinalPct });
      }
      byAt.set(rec.at, {
        atMs,
        featureSchemaVersion: typeof rec.featureSchemaVersion === "number" ? rec.featureSchemaVersion : 0,
        regimeFamily: typeof rec.regimeFamily === "string" ? rec.regimeFamily : "UNKNOWN",
        lanes,
      });
    }
  }
  return { rows: [...byAt.values()].sort((a, b) => a.atMs - b.atMs), badLines, totalLines };
}

type Skips = Record<string, Partial<Record<CortexOutcomeSkipReason, number>>>;
function bump(skips: Skips, laneId: string, reason: CortexOutcomeSkipReason): void {
  const s = (skips[laneId] ??= {});
  s[reason] = (s[reason] ?? 0) + 1;
}

/** Fold a normalize result into the outcome list / skip tally. */
function absorb(
  laneId: string,
  res: ReturnType<typeof directionalObsToOutcome>,
  out: CortexLaneOutcome[],
  skips: Skips,
): void {
  if (res.ok) out.push(res.outcome);
  else bump(skips, laneId, res.skip);
}

/**
 * Read every roster lane's resolved closes into normalized outcomes. Pure over the injected `.all` arrays
 * (the caller supplies the real store snapshots), so this is unit-testable with fakes.
 */
export function collectCortexOutcomes(sources: {
  directional: { laneId: string; obs: RawDirectionalObs[] }[];
  xsec: { laneId: string; obs: RawXsecObs[] }[];
  sinceMs?: number;
}): { outcomes: CortexLaneOutcome[]; skipsByLane: Skips } {
  const outcomes: CortexLaneOutcome[] = [];
  const skips: Skips = {};
  const since = sources.sinceMs ?? 0;
  for (const { laneId, obs } of sources.directional) {
    for (const o of obs) {
      const rms = parseIsoMs(o.resolvedAt);
      if (o.status !== "OPEN" && rms !== null && rms < since) continue; // outside lookback
      absorb(laneId, directionalObsToOutcome(laneId, o), outcomes, skips);
    }
  }
  for (const { laneId, obs } of sources.xsec) {
    for (const o of obs) {
      const rms = parseIsoMs(o.resolvedAt);
      if (o.status !== "OPEN" && rms !== null && rms < since) continue;
      absorb(laneId, xsecObsToOutcome(laneId, o), outcomes, skips);
    }
  }
  return { outcomes, skipsByLane: skips };
}

/** The lane IDs actually covered by a wired reader — derived from the `directional` and `xsec` source
 *  arrays this same function builds from the real stores. This (never a hardcoded constant) is what
 *  decides hasOutcomeSource: a CORTEX_LANE_ROSTER lane added without a matching push into either array
 *  correctly reports NO_OUTCOME_SOURCE (structurally unwired) instead of being silently reported as
 *  INSUFFICIENT_DATA (which implies it just needs more time to accumulate). Pure + independently testable.
 *
 *  2026-07-26 HONESTY FIX: this used to test laneId MEMBERSHIP only, so a source entry pushed with an
 *  EMPTY observation array counted as "wired". The CG block below pushes all four CG lanes
 *  unconditionally (`for (const [laneId, obs] of cgByLane) directional.push({ laneId, obs })`) — one
 *  entry per roster lane whether or not the variant matrix holds a single row for it — so three CG LONG
 *  lanes whose outcome source has been structurally dead for weeks were reported INSUFFICIENT_DATA
 *  ("just needs more time") and the readiness card showed noOutcomeSource: 0, which is why nobody
 *  noticed. An entry with zero observations is not a source; it is the absence of one. `obs` is a
 *  REQUIRED parameter (not optional-with-a-permissive-default) precisely so no future caller can
 *  re-introduce the membership-only reading by simply forgetting to pass it.
 *
 *  This is a REPORTING-status change only, and it cannot silence a lane that is actually learning:
 *  cortex-attribution.ts assigns NO_OUTCOME_SOURCE from exactly this hasOutcomeSource flag (its first
 *  branch), and a lane with zero observations necessarily has zero attributed examples, so no lane can
 *  move from LEARNING_ACTIVE to NO_OUTCOME_SOURCE because of this. Statuses stay single-sourced in
 *  cortex-attribution.ts — this function only feeds it an honest input, it does not define a second
 *  parallel notion of the status. */
export function cortexWiredOutcomeSourceLaneIds(
  directional: readonly { laneId: string; obs: readonly unknown[] }[],
  xsec: readonly { laneId: string; obs: readonly unknown[] }[],
): Set<string> {
  const wired = new Set<string>();
  // A lane may legitimately be fed by MORE THAN ONE source entry (e.g. a CG LONG lane reading both the
  // variant matrix and the paper-execution router below), so it is wired when ANY of its entries is
  // non-empty — never "the last entry seen".
  for (const src of directional) if (src.obs.length > 0) wired.add(src.laneId);
  for (const src of xsec) if (src.obs.length > 0) wired.add(src.laneId);
  return wired;
}

/**
 * The top-level impure gather: reads the journal + all lane stores from disk, builds the full CortexRefitInput.
 * hasOutcomeSource is derived from cortexWiredOutcomeSourceLaneIds(directional, xsec) below: a roster lane
 * whose reader is missing — OR whose reader is present but produced ZERO observations — reports
 * NO_OUTCOME_SOURCE rather than the far more forgiving INSUFFICIENT_DATA, so a structurally dead source
 * can never masquerade as "just needs more time" (2026-07-26; see that function's doc comment).
 */
export function gatherCortexRefitInputs(deps: {
  dataDir: string;
  journalFile: string;
  nowMs: number;
  nowIso: string;
  staticWeightPctForLane: (laneId: string) => number;
  /** Env controls legacy raw-store compatibility. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the CG-router source. Defaults to the RESIDENT-ONLY reader (never a cold parse —
   *  see readResidentCgRouterOrders). Returning null means "no router data available this run". */
  readCgRouterOrders?: () => readonly CortexCgRouterOrderLike[] | null;
  /** Standalone research has no allocation table; never fabricate one for readiness. */
  baselineAvailable?: boolean;
}): CortexRefitInput & {
  journalBadLines: number;
  cgRouterOutcomes: CortexCgRouterOutcomeSummary;
  learningEpoch: (CortexLearningEpoch & {
    decisionRowsExcluded: number;
    transitionalOutcomesExcluded: number;
  }) | null;
  /** Non-null when a boundary WAS configured and refused — see resolveCortexLearningEpoch. Carried
   *  into the readiness payload so a refusal is visible next to the meter it would have zeroed. */
  learningEpochRejection: CortexLearningEpochRejection | null;
} {
  const { epoch, rejection: learningEpochRejection } = resolveCortexLearningEpoch(deps.env, deps.nowMs);
  const sinceMs = Math.max(
    deps.nowMs - CORTEX_REFIT_LOOKBACK_MS,
    epoch?.startMs ?? Number.NEGATIVE_INFINITY,
  );

  const journal = readCortexDecisionRows([`${deps.journalFile}.1`, deps.journalFile]);

  if (!cortexRawStoreTrainingEnabled(deps.env)) {
    const causalJournal = forwardCausalJournalPath(deps.env ?? process.env);
    // A missing canonical policy context (unset/malformed/future deployment stamp) is treated
    // exactly like a missing journal: no bridge, zero rows. It must never fall back to reading
    // policy expectations off the events themselves — that is what let a stale identity through.
    const expectedPolicy = resolveCanonicalPolicyContext(deps.env ?? process.env);
    const bridge = (causalJournal && expectedPolicy)
      ? buildCortexExperienceBridge(readForwardCausalEvents(causalJournal), expectedPolicy)
      : null;
    const decisions = (bridge?.decisions ?? []).filter((row) => row.atMs >= sinceMs);
    const outcomes = (bridge?.outcomes ?? []).filter((row) => row.openedAtMs >= sinceMs && row.resolvedAtMs >= sinceMs);
    const directLaneIds = new Set(outcomes.map((outcome) => outcome.laneId));
    const emptyRouter = emptyCortexCgRouterSummary();
    return {
      // The only learner input is the direct, eligibility-checked Experience
      // Store bridge. Missing lineage yields zero examples, never a TTL guess.
      decisions,
      outcomes,
      roster: buildCortexAttrRoster(deps.staticWeightPctForLane, (laneId) => directLaneIds.has(laneId)),
      nowMs: deps.nowMs,
      nowIso: deps.nowIso,
      currentSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
      ttlMsForLane: cortexLaneTtlMs,
      skipsByLane: {},
      pruneBeforeMs: sinceMs - 5 * 86_400_000,
      baselineAvailable: deps.baselineAvailable,
      requireExactOwnership: true,
      journalBadLines: journal.badLines,
      cgRouterOutcomes: emptyRouter,
      learningEpoch: epoch
        ? { ...epoch, decisionRowsExcluded: 0, transitionalOutcomesExcluded: 0 }
        : null,
      learningEpochRejection,
    };
  }

  // Directional edge stores → RawDirectionalObs (netR already in R).
  const dirObs = (all: { observationId: string; openedAtMs: number; resolvedAt: string | null; status: string; netR: number | null }[]): RawDirectionalObs[] =>
    all.map((o) => ({ observationId: o.observationId, openedAtMs: o.openedAtMs, resolvedAt: o.resolvedAt, status: o.status, netR: o.netR }));

  const directional: { laneId: string; obs: RawDirectionalObs[] }[] = [
    { laneId: RC_PAPER_LANE_ID, obs: dirObs(getRegimeCompositeStore(deps.dataDir).all) },
    { laneId: RCS_PAPER_LANE_ID, obs: dirObs(getRegimeCompositeShortStore(deps.dataDir).all) },
    { laneId: SF_PAPER_LANE_ID, obs: dirObs(getShortFadeStore(deps.dataDir).all) },
    { laneId: IM_PAPER_LANE_ID, obs: dirObs(getIntradayMomentumStore(deps.dataDir).all) },
    { laneId: PWR_PAPER_LANE_ID, obs: dirObs(getPanicWashoutStore(deps.dataDir).all) },
  ];

  // Composite estimator — one store, four buckets → four laneIds.
  const ceAll = getCompositeEstimatorStore(deps.dataDir).all;
  for (const bucket of ["WIDE_LONG", "WIDE_SHORT", "FAST_LONG", "FAST_SHORT"] as const) {
    directional.push({
      laneId: ceLaneIdForBucket(bucket),
      obs: ceAll.filter((o) => o.bucket === bucket).map((o) => ({ observationId: o.observationId, openedAtMs: o.openedAtMs, resolvedAt: o.resolvedAt, status: o.status, netR: o.netR })),
    });
  }

  // CG variant matrix — filter by BOTH variant and direction. A direction-agnostic geometry such as
  // CG_MFE_GIVEBACK cannot be trained as a single LONG-labelled lane when most observations are SHORT.
  const cgAll = getCurrentGuardVariantMatrixStore(deps.dataDir).all;
  const cgByLane = new Map<string, RawDirectionalObs[]>();
  for (const lane of CG_ROSTER) cgByLane.set(lane.laneId, []);
  for (const o of cgAll) {
    const owner = CG_ROSTER.find((lane) => lane.variantId === o.variantId && lane.direction === o.direction);
    if (!owner) continue;
    // A corrupt openedAt becomes NaN (NOT a silent skip) so directionalObsToOutcome tallies it as
    // BAD_TIMESTAMP — the module's "every record is tallied by reason" guarantee holds.
    const openedAtMs = parseIsoMs(o.openedAt) ?? Number.NaN;
    cgByLane.get(owner.laneId)!.push({ observationId: o.observationId, openedAtMs, resolvedAt: o.resolvedAt, status: o.status, netR: o.netR });
  }
  for (const [laneId, obs] of cgByLane) directional.push({ laneId, obs });

  // CG paper-execution-router source for the three dead LONG CG lanes (env-gated, DEFAULT OFF — with the
  // flag unset this yields an empty map and pushes nothing, so `directional` is identical to today's).
  // Pushed as SEPARATE source entries rather than merged into cgByLane so the two data-generating
  // processes stay distinguishable in the arrays, and so cortexWiredOutcomeSourceLaneIds' "any non-empty
  // entry wires the lane" rule reports the truth when one source is empty and the other is not.
  const cgRouter = gatherCortexCgRouterOutcomes({ env: deps.env, readOrders: deps.readCgRouterOrders });
  for (const [laneId, obs] of cgRouter.byLane) directional.push({ laneId, obs });

  // Cross-sectional store — one store, three variants → three laneIds. netReturn is a fraction.
  // 2026-07-22 bug fix: CrossSectionalStore's constructor already appends "cross-sectional-edge.json"
  // to dataDir internally (see cross-sectional-edge.ts) — passing an already-suffixed path here made
  // it resolve to a nonexistent nested path, so load() silently returned {observations: []} on every
  // call. CORTEX's attribution saw ZERO cross-sectional observations for all 3 xsec lanes (NEUTRAL/
  // TREND/MIXED) regardless of how much real measurement/execution data existed. Use the shared
  // singleton (matches every other store factory in this function) so this also picks up any
  // not-yet-persisted in-process state, not just what's on disk.
  const xsecAll = getCrossSectionalStore(deps.dataDir).all;
  const xsec: { laneId: string; obs: RawXsecObs[] }[] = Object.entries(XSEC_STORE_VARIANTS).map(([laneId, variant]) => ({
    laneId,
    obs: xsecAll
      .filter((o: CrossSectionalObservation) => (o.variant ?? "RAW") === variant)
      .map((o: CrossSectionalObservation) => ({
        observationId: o.observationId,
        openedAtMs: o.openedAtMs,
        resolvedAt: o.resolvedAt,
        status: o.status,
        netReturn: o.netReturn,
        riskDistanceAtOpen: o.riskDistanceAtOpen ?? null,
        stopLossReturn: o.stopLossReturn ?? null,
      })),
  }));

  const collected = collectCortexOutcomes({ directional, xsec, sinceMs });
  // Resolution time alone is insufficient: a position opened before the epoch and closed after it
  // carries pre-fix decision lineage. Keep it in its source artifact, but exclude it from this model.
  const epochRows = filterCortexLearningEpochRows(journal.rows, collected.outcomes, epoch);

  const wiredLaneIds = cortexWiredOutcomeSourceLaneIds(directional, xsec);
  const roster = buildCortexAttrRoster(deps.staticWeightPctForLane, (laneId) => wiredLaneIds.has(laneId));

  return {
    decisions: epochRows.decisions,
    outcomes: epochRows.outcomes,
    roster,
    nowMs: deps.nowMs,
    nowIso: deps.nowIso,
    currentSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
    ttlMsForLane: cortexLaneTtlMs,
    skipsByLane: collected.skipsByLane,
    // Prune the counted-observation ledger STRICTLY OLDER than the bindings' lookback (5-day buffer) so an
    // outcome the bindings still return (resolvedAtMs ≥ sinceMs) can never be pruned and then re-counted.
    pruneBeforeMs: sinceMs - 5 * 86_400_000,
    baselineAvailable: deps.baselineAvailable,
    journalBadLines: journal.badLines,
    cgRouterOutcomes: cgRouter.summary,
    learningEpoch: epoch
      ? {
          ...epoch,
          decisionRowsExcluded: epochRows.decisionRowsExcluded,
          transitionalOutcomesExcluded: epochRows.transitionalOutcomesExcluded,
        }
      : null,
    learningEpochRejection,
  };
}

/** The last nightly-refit report, exposed for #219's dashboard / an ops route (no recompute).
 *  cgRouterOutcomes rides along so the CG-router source's state — on/off, resident/not, and above all
 *  how many mark-to-market marks (if any) were fed in — is readable from the report, not just the log. */
export type CortexRefitReportWithMeta = CortexRefitReport & {
  journalBadLines: number;
  cgRouterOutcomes: CortexCgRouterOutcomeSummary;
  learningEpoch: (CortexLearningEpoch & {
    decisionRowsExcluded: number;
    transitionalOutcomesExcluded: number;
  }) | null;
};
let latestRefitReport: CortexRefitReportWithMeta | null = null;
export function getLatestCortexRefitReport(): CortexRefitReportWithMeta | null {
  return latestRefitReport;
}
export function _resetLatestCortexRefitReportForTests(): void {
  latestRefitReport = null;
}

/**
 * 2026-07-20 real-incident fix: the decision-alpha HTTP route originally called gatherCortexRefitInputs
 * (full journal + every lane-store JSON re-read from disk, tens of MB) fresh on EVERY request. The
 * dashboard card polls it every 10s, which repeatedly blocked the single Node event loop long enough to
 * starve the paper-cycle tick and inflate the Binance clock-sync measurement into a false "clock skew"
 * refusal — testnet effectively hung. Fix: compute decision-alpha ONCE per refit cycle here (reusing
 * `report.examples` — runCortexRefit's own attributeOutcomes() output, see its doc comment in
 * cortex-refit-runner.ts; 2026-07-22 fix removed a SECOND attributeOutcomes call that used to
 * recompute the identical result here — zero extra disk I/O AND zero duplicate CPU work now), cache
 * it, and have the HTTP route (cortex-decision-alpha-report.ts) only ever read the cache. */
let latestDecisionAlpha: { generatedAtMs: number; examplesConsidered: number; journalBadLines: number; decisionAlpha: CortexShadowDecisionAlphaResult } | null = null;
export function getLatestCortexShadowDecisionAlpha(): typeof latestDecisionAlpha {
  return latestDecisionAlpha;
}
export function _resetLatestCortexShadowDecisionAlphaForTests(): void {
  latestDecisionAlpha = null;
}

/** Same shape as above, but scoped to outcomes resolved within the CURRENT UTC calendar day only — this is
 *  what lets the "Realized P&L (today)" dashboard panel show CORTEX's shadow contribution alongside the
 *  real (non-CORTEX) P&L for the SAME day, instead of only an all-time/window figure. Computed from the
 *  SAME already-gathered `report.examples` as latestDecisionAlpha — a cheap in-memory filter, zero extra I/O. */
let latestDecisionAlphaToday: { generatedAtMs: number; dayStartMs: number; examplesConsidered: number; decisionAlpha: CortexShadowDecisionAlphaResult } | null = null;
export function getLatestCortexShadowDecisionAlphaToday(): typeof latestDecisionAlphaToday {
  return latestDecisionAlphaToday;
}
export function _resetLatestCortexShadowDecisionAlphaTodayForTests(): void {
  latestDecisionAlphaToday = null;
}
/** Test-only: inject a specific cached "today" value (e.g. a stale prior-day cache) without running
 *  the full nightly-refit pipeline — see cortex-decision-alpha-report.test.ts's 2026-07-22 stale-cache
 *  regression test. */
export function _setLatestCortexShadowDecisionAlphaTodayForTests(value: typeof latestDecisionAlphaToday): void {
  latestDecisionAlphaToday = value;
}

/**
 * One nightly refit pass, wired to the real stores + journal. Report-only + idempotent: applies ACCEPTED
 * archetype refits + advances cumulativeResolved/resolvedByFamily via the watermark, and NEVER touches
 * CORTEX_LIVE_BETA. Never throws through (a refit failure must not break the tick that schedules it).
 */
export function runCortexNightlyRefit(deps: {
  store: CortexBrainStore;
  dataDir: string;
  journalFile: string;
  staticWeightPctForLane: (laneId: string) => number;
  nowMs: number;
  nowIso: string;
  apply?: boolean;
  /** Both forwarded to gatherCortexRefitInputs; see the CG-router source above. */
  env?: NodeJS.ProcessEnv;
  readCgRouterOrders?: () => readonly CortexCgRouterOrderLike[] | null;
  baselineAvailable?: boolean;
}): CortexRefitReportWithMeta {
  const input = gatherCortexRefitInputs({
    dataDir: deps.dataDir,
    journalFile: deps.journalFile,
    nowMs: deps.nowMs,
    nowIso: deps.nowIso,
    staticWeightPctForLane: deps.staticWeightPctForLane,
    env: deps.env,
    readCgRouterOrders: deps.readCgRouterOrders,
    baselineAvailable: deps.baselineAvailable,
  });
  const report = runCortexRefit(deps.store, { ...input, apply: deps.apply });
  const withMeta = {
    ...report,
    journalBadLines: input.journalBadLines,
    cgRouterOutcomes: input.cgRouterOutcomes,
    learningEpoch: input.learningEpoch,
  };
  latestRefitReport = withMeta;

  logCortexCgRouterOutcomeSummary(input.cgRouterOutcomes);

  // 2026-07-22 bug-hunt fix: reuse THIS run's own attributeOutcomes() output (report.examples) —
  // runCortexRefit already computed it on the exact same inputs a few lines above. Re-running the
  // full sort + per-lane TTL-window search + dedupe walk here doubled the CPU cost of every nightly
  // refit tick on identical data (see cortex-refit-runner.ts's CortexRefitReport.examples doc comment).
  const attrExamples = report.examples;
  latestDecisionAlpha = {
    generatedAtMs: deps.nowMs,
    examplesConsidered: attrExamples.length,
    journalBadLines: input.journalBadLines,
    decisionAlpha: cortexShadowDecisionAlpha(attrExamples),
  };

  const dayStartMs = startOfUtcDayMs(deps.nowMs);
  const todaysExamples = attrExamples.filter((e) => e.resolvedAtMs >= dayStartMs);
  latestDecisionAlphaToday = {
    generatedAtMs: deps.nowMs,
    dayStartMs,
    examplesConsidered: todaysExamples.length,
    decisionAlpha: cortexShadowDecisionAlpha(todaysExamples),
  };

  return withMeta;
}

/** Start of the UTC calendar day containing `nowMs`, as an epoch-ms boundary. Pure, no Date-locale
 *  ambiguity (integer floor-division on epoch ms is always UTC by construction). */
export function startOfUtcDayMs(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400_000;
}

export { CORTEX_LANE_ROSTER };

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

/** Only pull outcomes resolved within this window — older ones can't attribute (their decisions rotated
 *  out of the ~26-day journal) and the refit's recency decay makes them ~zero weight anyway. Bounds the
 *  CG matrix read (which can hold 100k+ obs). */
export const CORTEX_REFIT_LOOKBACK_MS = 45 * 86_400_000;

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

/** The lane IDs actually covered by a wired reader — the union of the `directional` and `xsec` source
 *  arrays this same function builds from the real stores. This (never a hardcoded constant) is what
 *  decides hasOutcomeSource: a CORTEX_LANE_ROSTER lane added without a matching push into either array
 *  correctly reports NO_OUTCOME_SOURCE (structurally unwired) instead of being silently reported as
 *  INSUFFICIENT_DATA (which implies it just needs more time to accumulate). Pure + independently testable. */
export function cortexWiredOutcomeSourceLaneIds(
  directional: { laneId: string }[],
  xsec: { laneId: string }[],
): Set<string> {
  return new Set<string>([...directional.map((d) => d.laneId), ...xsec.map((x) => x.laneId)]);
}

/**
 * The top-level impure gather: reads the journal + all lane stores from disk, builds the full CortexRefitInput.
 * hasOutcomeSource is derived from cortexWiredOutcomeSourceLaneIds(directional, xsec) below — all 15 roster
 * lanes currently have a wired reader; if a lane ever loses its source (or a new roster lane is added without
 * a matching push into `directional`/`xsec`), it will report NO_OUTCOME_SOURCE instead of silently vanishing.
 */
export function gatherCortexRefitInputs(deps: {
  dataDir: string;
  journalFile: string;
  nowMs: number;
  nowIso: string;
  staticWeightPctForLane: (laneId: string) => number;
}): CortexRefitInput & { journalBadLines: number } {
  const sinceMs = deps.nowMs - CORTEX_REFIT_LOOKBACK_MS;

  const journal = readCortexDecisionRows([`${deps.journalFile}.1`, deps.journalFile]);

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

  const { outcomes, skipsByLane } = collectCortexOutcomes({ directional, xsec, sinceMs });

  const wiredLaneIds = cortexWiredOutcomeSourceLaneIds(directional, xsec);
  const roster = buildCortexAttrRoster(deps.staticWeightPctForLane, (laneId) => wiredLaneIds.has(laneId));

  return {
    decisions: journal.rows,
    outcomes,
    roster,
    nowMs: deps.nowMs,
    nowIso: deps.nowIso,
    currentSchemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
    ttlMsForLane: cortexLaneTtlMs,
    skipsByLane,
    // Prune the counted-observation ledger STRICTLY OLDER than the bindings' lookback (5-day buffer) so an
    // outcome the bindings still return (resolvedAtMs ≥ sinceMs) can never be pruned and then re-counted.
    pruneBeforeMs: sinceMs - 5 * 86_400_000,
    journalBadLines: journal.badLines,
  };
}

/** The last nightly-refit report, exposed for #219's dashboard / an ops route (no recompute). */
let latestRefitReport: (CortexRefitReport & { journalBadLines: number }) | null = null;
export function getLatestCortexRefitReport(): (CortexRefitReport & { journalBadLines: number }) | null {
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
}): CortexRefitReport & { journalBadLines: number } {
  const input = gatherCortexRefitInputs({
    dataDir: deps.dataDir,
    journalFile: deps.journalFile,
    nowMs: deps.nowMs,
    nowIso: deps.nowIso,
    staticWeightPctForLane: deps.staticWeightPctForLane,
  });
  const report = runCortexRefit(deps.store, { ...input, apply: deps.apply });
  const withMeta = { ...report, journalBadLines: input.journalBadLines };
  latestRefitReport = withMeta;

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

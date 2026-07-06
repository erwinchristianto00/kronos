/**
 * F****** FROZEN CURRENT-GUARD POST-CUTOVER TAPE — REPORT-ONLY
 *
 * The F***** pathology audit classified OOS Segment 1 of the frozen prospective
 * tape (BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1) as OLD_BATCH — a transient,
 * non-representative bad patch (concentrated tail losses, fib_500-only entry mix,
 * narrow date window). The full frozen tape therefore mixes an old-method batch
 * with the current/new method, which keeps the F**** promotion tracker blocked on
 * a Segment-1 negative that no longer reflects how trades are taken.
 *
 * This module defines a CLEAN FORWARD-VALIDATION tape for the current/new method
 * only — everything that closed AFTER the end of Segment 1. The cutover boundary
 * is locked ONCE (when the pathology verdict is OLD_BATCH and there is enough
 * sample) and is then IMMUTABLE.
 *
 * Lane label: BASE_ROUTE_STOP175_CURRENT_GUARD_POST_CUTOVER_V1
 * Storage:    <dataDir>/base-route-current-guard-post-cutover.json
 *
 * STRICTLY REPORT-ONLY:
 *  - Stores ONLY boundary metadata (cutover timestamp + reason). It NEVER stores
 *    duplicate observations and NEVER touches the frozen store or the live shadow
 *    tape (data/shadow-positions.json). Segment 1 is neither deleted nor hidden;
 *    it remains fully present in the frozen tape. This tape merely *reads past*
 *    the cutover for forward-validation math.
 *  - Does NOT change strategy, admission, route selection, or any frozen criteria.
 *  - All writes wrapped in try/catch; never throws.
 *  - Advisory status only; no consumer may gate live behavior on it. liveBlocked
 *    stays true; microPilotAllowed stays false.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  R_SANITY_CAP_R,
  type ForensicsRow,
  type FrozenCurrentGuardObservation,
  type FrozenCurrentGuardReport,
} from "./base-route-current-guard-frozen.js";
import type { CostSensitivityRow, SegmentStats } from "./base-route-current-guard-stability-audit.js";
import {
  buildFrozenCurrentGuardCostModelReport,
  type FrozenCurrentGuardCostModelReport,
  type SpreadFundingInputs,
} from "./frozen-current-guard-cost-model.js";
import type { FrozenSegmentPathologyAudit } from "./frozen-segment-pathology-audit.js";

export const POST_CUTOVER_LANE =
  "BASE_ROUTE_STOP175_CURRENT_GUARD_POST_CUTOVER_V1" as const;

/** Minimum fresh-valid sample on the frozen tape before a cutover may be locked. */
const MIN_FRESH_VALID_TO_LOCK = 9;

const AVERAGE_STOP_BPS = 200;

/** Acceptable rolling-drawdown magnitude (R) for a stable/promotion candidate. */
const MAX_DRAWDOWN_R_LIMIT = 5;
/** Maximum top-symbol PnL share for a stable/promotion candidate. */
const MAX_TOP_SYMBOL_SHARE = 0.4;

export const POST_CUTOVER_REASON =
  "Segment 1 classified OLD_BATCH by pathology audit." as const;

// ─── Boundary (the only thing persisted) ────────────────────────────────────

export interface PostCutoverBoundary {
  laneVersion: typeof POST_CUTOVER_LANE;
  /** All frozen observations with closedAt STRICTLY AFTER this belong to the tape. */
  cutoverTimestamp: string;
  reason: string;
  /** When the boundary was first locked (immutable thereafter). */
  frozenAt: string;
  derivedFrom: {
    /** Pathology verdict at lock time (expected OLD_BATCH). */
    pathologyVerdict: string;
    /** Frozen fresh-valid sample size at lock time. */
    freshValidAtLock: number;
    /** Segment-1 size at lock time (Math.floor(n/3)). */
    seg1NAtLock: number;
    /** closedAt of the last Segment-1 observation (== cutoverTimestamp). */
    seg1LastClosedAt: string;
  };
}

interface PostCutoverStoreFile {
  boundary: PostCutoverBoundary | null;
}

// ─── numeric helpers ────────────────────────────────────────────────────────

function finiteNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function mean(values: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(values);
  if (finite.length === 0) return null;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function profitFactor(grosses: Array<number | null | undefined>): number | null {
  let winSum = 0;
  let lossSum = 0;
  for (const g of grosses) {
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (g > 0) winSum += g;
    else if (g < 0) lossSum += Math.abs(g);
  }
  if (lossSum === 0) return winSum > 0 ? Infinity : null;
  return winSum / lossSum;
}

function pfFinite(grosses: Array<number | null | undefined>): number | null {
  const pf = profitFactor(grosses);
  return pf === Infinity ? null : pf;
}

function winRate(grosses: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(grosses);
  if (finite.length === 0) return null;
  return finite.filter((g) => g > 0).length / finite.length;
}

function toMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function segmentOf(label: string, slice: FrozenCurrentGuardObservation[]): SegmentStats {
  return {
    label,
    n: slice.length,
    netAvgR: mean(slice.map((p) => p.netR)),
    grossAvgR: mean(slice.map((p) => p.grossR)),
    pf: pfFinite(slice.map((p) => p.grossR)),
    wr: winRate(slice.map((p) => p.grossR)),
  };
}

function breakdownRows(
  slice: FrozenCurrentGuardObservation[],
  keyFn: (o: FrozenCurrentGuardObservation) => string,
  totalAbsGross: number,
  maxRows = 15,
): ForensicsRow[] {
  const map = new Map<string, FrozenCurrentGuardObservation[]>();
  for (const o of slice) {
    const k = keyFn(o);
    const arr = map.get(k) ?? [];
    arr.push(o);
    map.set(k, arr);
  }
  const rows: ForensicsRow[] = [];
  for (const [key, arr] of map.entries()) {
    const grosses = arr.map((o) => o.grossR);
    const absGrossSum = finiteNumbers(grosses).reduce((s, v) => s + Math.abs(v), 0);
    rows.push({
      key,
      n: arr.length,
      netAvgR: mean(arr.map((o) => o.netR)),
      grossAvgR: mean(grosses),
      pf: pfFinite(grosses),
      wr: winRate(grosses),
      pnlSharePct: totalAbsGross > 0 ? absGrossSum / totalAbsGross : null,
    });
  }
  rows.sort((a, b) => {
    if (a.netAvgR === null && b.netAvgR === null) return 0;
    if (a.netAvgR === null) return 1;
    if (b.netAvgR === null) return -1;
    return a.netAvgR - b.netAvgR;
  });
  return rows.slice(0, maxRows);
}

function drawdownAndStreak(
  obs: FrozenCurrentGuardObservation[],
): { drawdownR: number | null; streak: number | null } {
  const nets = finiteNumbers(obs.map((o) => o.netR));
  if (nets.length === 0) return { drawdownR: null, streak: null };
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let curStreak = 0;
  let maxStreak = 0;
  for (const n of nets) {
    cum += n;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (n < 0) {
      curStreak += 1;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else {
      curStreak = 0;
    }
  }
  return { drawdownR: maxDd, streak: maxStreak };
}

function rollingWindow(
  label: string,
  obs: FrozenCurrentGuardObservation[],
  size: number,
): RollingWindowStat {
  const slice = obs.slice(Math.max(0, obs.length - size));
  return {
    window: label,
    n: slice.length,
    netAvgR: mean(slice.map((o) => o.netR)),
    pf: pfFinite(slice.map((o) => o.grossR)),
    wr: winRate(slice.map((o) => o.grossR)),
  };
}

function buildCostSensitivity(obs: FrozenCurrentGuardObservation[]): CostSensitivityRow[] {
  const scenarioNet = (extraRoundTripBps: number): { net: number | null; pf: number | null } => {
    const extraCostR = extraRoundTripBps / AVERAGE_STOP_BPS;
    const adjustedNet: number[] = [];
    const adjustedGross: number[] = [];
    for (const p of obs) {
      if (typeof p.grossR !== "number" || !Number.isFinite(p.grossR)) continue;
      const baseCost = typeof p.costR === "number" && Number.isFinite(p.costR) ? p.costR : 0;
      adjustedNet.push(p.grossR - baseCost - extraCostR);
      adjustedGross.push(p.grossR - extraCostR);
    }
    return { net: mean(adjustedNet), pf: pfFinite(adjustedGross) };
  };
  const rows: CostSensitivityRow[] = [];
  {
    const net = mean(obs.map((p) => p.netR));
    rows.push({
      scenario: "default",
      roundTripBps: 0,
      netAvgR: net,
      pf: pfFinite(obs.map((p) => p.grossR)),
      stillPositive: net !== null && net > 0,
    });
  }
  for (const [scenario, bps] of [
    ["plus_5bps_slippage", 5],
    ["plus_10bps_slippage", 10],
  ] as const) {
    const { net, pf } = scenarioNet(bps);
    rows.push({
      scenario,
      roundTripBps: bps,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }
  return rows;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class PostCutoverStore {
  private readonly file: string;
  private boundary: PostCutoverBoundary | null;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "base-route-current-guard-post-cutover.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort; report-only
    }
    this.boundary = this._load();
  }

  get path(): string {
    return this.file;
  }

  getBoundary(): PostCutoverBoundary | null {
    return this.boundary;
  }

  private _load(): PostCutoverBoundary | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PostCutoverStoreFile>;
      return parsed.boundary ?? null;
    } catch {
      return null;
    }
  }

  private _save(): void {
    try {
      const payload: PostCutoverStoreFile = { boundary: this.boundary };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // storage failures must never throw — this lane is report-only
    }
  }

  /**
   * Lock the cutover boundary ONCE, at the end of frozen Segment 1, when the
   * pathology audit has classified that segment as OLD_BATCH and there is enough
   * sample. The boundary is immutable after first lock — subsequent calls are
   * no-ops and return the existing boundary. This guarantees the forward-test
   * tape cannot be retroactively re-anchored to flatter the metrics.
   */
  ensureBoundary(
    frozen: FrozenCurrentGuardReport | undefined | null,
    pathology: FrozenSegmentPathologyAudit | undefined | null,
  ): PostCutoverBoundary | null {
    try {
      if (this.boundary !== null) return this.boundary; // immutable once locked
      if (!frozen || !pathology) return null;
      if (pathology.verdict !== "OLD_BATCH") return null;

      const sorted = Array.isArray(frozen.resolvedObservations)
        ? frozen.resolvedObservations
        : [];
      const freshValid = sorted.length;
      if (freshValid < MIN_FRESH_VALID_TO_LOCK) return null;

      // Segment 1 == first third (mirrors the frozen report's own thirds split).
      const third = Math.floor(freshValid / 3);
      if (third < 1) return null;
      const seg1Last = sorted[third - 1];
      if (!seg1Last) return null;
      const cutoverTimestamp = seg1Last.closedAt ?? seg1Last.openedAt;
      if (!cutoverTimestamp) return null;

      this.boundary = {
        laneVersion: POST_CUTOVER_LANE,
        cutoverTimestamp,
        reason: POST_CUTOVER_REASON,
        frozenAt: new Date().toISOString(),
        derivedFrom: {
          pathologyVerdict: pathology.verdict,
          freshValidAtLock: freshValid,
          seg1NAtLock: third,
          seg1LastClosedAt: cutoverTimestamp,
        },
      };
      this._save();
      return this.boundary;
    } catch {
      // report-only; never throw
      return this.boundary;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let singleton: PostCutoverStore | null = null;

export function getPostCutoverStore(dataDir = "data"): PostCutoverStore {
  if (!singleton) {
    singleton = new PostCutoverStore(dataDir);
  }
  return singleton;
}

export function _resetPostCutoverStoreForTests(): void {
  singleton = null;
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface RollingWindowStat {
  window: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export type PostCutoverStatus =
  | "AWAITING_CUTOVER"
  | "COLLECTING"
  | "WATCHABLE"
  | "STABLE_CANDIDATE"
  | "PROMOTION_CANDIDATE"
  | "REJECT";

export interface PostCutoverReportOptions {
  capturedAt?: string;
  /** Infra-readiness gates required (with everything else) for PROMOTION_CANDIDATE. */
  killSwitchReady?: boolean;
  orderReconciliationReady?: boolean;
  exchangeHealthReady?: boolean;
}

export interface PostCutoverReport {
  reportOnly: true;
  laneId: typeof POST_CUTOVER_LANE;
  computedAt: string;

  boundary: PostCutoverBoundary | null;
  /** True when a cutover boundary is locked AND at least one obs is post-cutover. */
  cutoverActive: boolean;

  /** Sample sizes WITHIN the post-cutover tape only. */
  total: number;
  open: number;
  resolved: number;
  freshValid: number;
  /**
   * Obs excluded from freshValid because |grossR| or |netR| exceeds the physical sanity cap (20R).
   * These are fabricated R values from the pre-fix shadow-engine R-denominator bug (runner slices
   * divided by the moved/trailed stop distance — audit found a +201R runner whose honest outcome
   * was ≈0..1R). Surfaced so the exclusion is never silent.
   */
  rSanityExcludedCount: number;

  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  daysCovered: number;

  costSensitivity: CostSensitivityRow[];
  realisticCostModel: FrozenCurrentGuardCostModelReport | null;

  rolling: RollingWindowStat[]; // last_10, last_20, last_50

  /** OOS thirds WITHIN the post-cutover tape (never includes Segment 1). */
  oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null;
  allThreeSegmentsPositive: boolean;

  bySymbol: ForensicsRow[];
  byEntryVariant: ForensicsRow[];
  byRegime: ForensicsRow[];
  topSymbolPnlShare: number | null;

  approxMaxDrawdownR: number | null;
  maxAdverseStreak: number | null;

  resolvedPerDay: number | null;
  freshValidPerDay: number | null;
  etaToN100Days: number | null;
  etaToN100Date: string | null;
  etaToN200Days: number | null;
  etaToN200Date: string | null;

  plus10bpsStillPositive: boolean;

  status: PostCutoverStatus;
  statusReason: string;
  blockers: string[];
  cautions: string[];
}

/**
 * Build the post-cutover tape report. Reads ONLY from the frozen report's
 * resolvedObservations (filtered to closedAt strictly after the cutover) plus
 * the locked boundary. Segment 1 is excluded from every metric here, but is NOT
 * deleted — it still lives in the frozen tape.
 */
export function buildPostCutoverReport(
  frozen: FrozenCurrentGuardReport | undefined | null,
  boundary: PostCutoverBoundary | null,
  spreadFunding: SpreadFundingInputs | undefined | null,
  opts: PostCutoverReportOptions = {},
): PostCutoverReport {
  const computedAt = opts.capturedAt ?? new Date().toISOString();

  const allSorted = frozen && Array.isArray(frozen.resolvedObservations)
    ? frozen.resolvedObservations
    : [];

  const cutoverMs = boundary ? toMs(boundary.cutoverTimestamp) : null;

  // Post-cutover tape: fresh-valid resolved obs that closed AFTER the cutover.
  // Strict `>` excludes the last Segment-1 observation itself.
  const postObs =
    cutoverMs === null
      ? []
      : allSorted.filter((o) => {
          const ms = toMs(o.closedAt) || toMs(o.openedAt);
          return ms > cutoverMs;
        });

  const cutoverActive = boundary !== null && postObs.length > 0;

  const total = postObs.length;
  const open = postObs.filter((o) => o.status === "OPEN").length;
  const resolvedObs = postObs.filter((o) => o.status !== "OPEN");
  const resolved = resolvedObs.length;
  const finiteRObs = resolvedObs.filter(
    (o) =>
      typeof o.grossR === "number" &&
      Number.isFinite(o.grossR) &&
      typeof o.netR === "number" &&
      Number.isFinite(o.netR),
  );
  // R-sanity quarantine: |R| beyond 20R is physically implausible for this lane's admission
  // geometry (>=175bps stops) and matches the VM tape's MFE/MAE cap. Such obs are fabricated by
  // the pre-fix shadow-engine R-denominator bug and must not feed economics. Counted, never silent.
  const freshValidObs = finiteRObs.filter(
    (o) => Math.abs(o.grossR as number) <= R_SANITY_CAP_R && Math.abs(o.netR as number) <= R_SANITY_CAP_R,
  );
  // Include the upstream frozen-tape exclusions: this builder normally consumes the frozen
  // report's ALREADY-sanitized resolvedObservations, so without propagation the post-cutover
  // lane (the one dashboards surface) would show zero and hide the data-quality caution.
  const rSanityExcludedCount =
    finiteRObs.length - freshValidObs.length + (frozen?.rSanityExcludedCount ?? 0);
  const freshValid = freshValidObs.length;

  const netAvgR = mean(freshValidObs.map((o) => o.netR));
  const pf = pfFinite(freshValidObs.map((o) => o.grossR));
  const wr = winRate(freshValidObs.map((o) => o.grossR));

  // days covered
  const days = new Set<string>();
  for (const o of resolvedObs) {
    const ms = toMs(o.closedAt) || toMs(o.openedAt);
    if (ms > 0) days.add(new Date(ms).toISOString().slice(0, 10));
  }
  const daysCovered = days.size;

  // OOS thirds WITHIN the post-cutover tape (already time-ordered).
  let oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null = null;
  if (freshValidObs.length >= 3) {
    const third = Math.floor(freshValidObs.length / 3);
    oosSegments = [
      segmentOf("post_segment_1", freshValidObs.slice(0, third)),
      segmentOf("post_segment_2", freshValidObs.slice(third, third * 2)),
      segmentOf("post_segment_3", freshValidObs.slice(third * 2)),
    ];
  }
  const allThreeSegmentsPositive =
    oosSegments !== null && oosSegments.every((s) => s.netAvgR !== null && s.netAvgR > 0);

  // breakdowns
  const totalAbsGross = finiteNumbers(freshValidObs.map((o) => o.grossR)).reduce(
    (s, v) => s + Math.abs(v),
    0,
  );
  const bySymbol = breakdownRows(freshValidObs, (o) => o.symbol, totalAbsGross, 15);
  const byEntryVariant = breakdownRows(
    freshValidObs,
    (o) => o.entryVariant ?? "UNKNOWN",
    totalAbsGross,
    15,
  );
  const byRegime = breakdownRows(freshValidObs, (o) => o.regime ?? "UNKNOWN", totalAbsGross, 15);

  // top symbol pnl share
  const symbolMap = new Map<string, number>();
  for (const o of freshValidObs) {
    if (typeof o.grossR !== "number" || !Number.isFinite(o.grossR)) continue;
    symbolMap.set(o.symbol, (symbolMap.get(o.symbol) ?? 0) + Math.abs(o.grossR));
  }
  let topSymbolPnlShare: number | null = null;
  if (totalAbsGross > 0) {
    topSymbolPnlShare = 0;
    for (const v of symbolMap.values()) {
      const share = v / totalAbsGross;
      if (share > topSymbolPnlShare) topSymbolPnlShare = share;
    }
  }

  // rolling windows
  const rolling: RollingWindowStat[] = [
    rollingWindow("last_10", freshValidObs, 10),
    rollingWindow("last_20", freshValidObs, 20),
    rollingWindow("last_50", freshValidObs, 50),
  ];

  // drawdown / streak
  const { drawdownR: approxMaxDrawdownR, streak: maxAdverseStreak } =
    drawdownAndStreak(freshValidObs);

  // cost sensitivity + realistic cost model (on post-cutover obs only)
  const costSensitivity = buildCostSensitivity(freshValidObs);
  const realisticCostModel = spreadFunding
    ? buildFrozenCurrentGuardCostModelReport(freshValidObs, spreadFunding, computedAt)
    : null;

  const plus10bpsStillPositive = (() => {
    if (realisticCostModel) {
      const s = realisticCostModel.scenarios.find((sc) => sc.scenario === "plus_10bps_slippage");
      if (s) return s.pass === true;
    }
    const cs = costSensitivity.find((r) => r.scenario === "plus_10bps_slippage");
    return cs ? cs.stillPositive === true : false;
  })();

  // velocity / ETA
  const daysDenom = Math.max(daysCovered, 1);
  const resolvedPerDay = resolved / daysDenom;
  const freshValidPerDay = freshValid / daysDenom;
  const etaDays = (target: number, current: number, perDay: number): number | null => {
    if (current >= target) return 0;
    if (perDay <= 0 || !Number.isFinite(perDay)) return null;
    return (target - current) / perDay;
  };
  const nowMs = Date.parse(computedAt);
  const etaDate = (d: number | null): string | null => {
    if (d === null || !Number.isFinite(nowMs)) return null;
    return new Date(nowMs + d * 86_400_000).toISOString().slice(0, 10);
  };
  const etaToN100Days = etaDays(100, freshValid, freshValidPerDay);
  const etaToN200Days = etaDays(200, freshValid, freshValidPerDay);

  // ── status / gate logic ────────────────────────────────────────────────────
  const netPositive = typeof netAvgR === "number" && Number.isFinite(netAvgR) && netAvgR > 0;
  const netStrong = typeof netAvgR === "number" && Number.isFinite(netAvgR) && netAvgR > 0.05;
  const pfStrong = typeof pf === "number" && Number.isFinite(pf) && pf > 1.2;
  const pfWatchable = typeof pf === "number" && Number.isFinite(pf) && pf > 1.2;
  const drawdownAcceptable =
    approxMaxDrawdownR === null || Math.abs(approxMaxDrawdownR) <= MAX_DRAWDOWN_R_LIMIT;
  const concentrationOk =
    topSymbolPnlShare === null || topSymbolPnlShare <= MAX_TOP_SYMBOL_SHARE;
  const costStressFails = !plus10bpsStillPositive;

  const infraReady =
    opts.killSwitchReady === true &&
    opts.orderReconciliationReady === true &&
    opts.exchangeHealthReady === true;

  const stableGatesMet =
    allThreeSegmentsPositive && netStrong && pfStrong && concentrationOk && drawdownAcceptable;

  let status: PostCutoverStatus;
  let statusReason: string;

  if (boundary === null) {
    status = "AWAITING_CUTOVER";
    statusReason =
      "No cutover boundary locked yet — pathology verdict must be OLD_BATCH with sufficient frozen sample before the post-cutover tape begins.";
  } else if (freshValid < 50) {
    status = "COLLECTING";
    const netStr = netAvgR === null ? "n/a" : netAvgR.toFixed(4);
    statusReason = `freshValid=${freshValid} (<50) post-cutover — collecting forward-validation evidence (netAvgR=${netStr}).`;
  } else if (!netPositive || costStressFails) {
    status = "REJECT";
    const netStr = netAvgR === null ? "n/a" : netAvgR.toFixed(4);
    statusReason = !netPositive
      ? `netAvgR=${netStr} ≤ 0 post-cutover — no forward edge; rejected.`
      : `netAvgR=${netStr}>0 but +10bps cost-stress scenario is not net positive — rejected on cost stress.`;
  } else if (freshValid >= 200 && stableGatesMet && infraReady) {
    status = "PROMOTION_CANDIDATE";
    statusReason =
      `freshValid=${freshValid}≥200, all post-cutover OOS thirds positive, netAvgR=${(netAvgR as number).toFixed(4)}>0.05, ` +
      `PF=${(pf as number).toFixed(2)}>1.20, top symbol share≤${(MAX_TOP_SYMBOL_SHARE * 100).toFixed(0)}%, drawdown acceptable, infra ready.`;
  } else if (freshValid >= 100 && stableGatesMet) {
    status = "STABLE_CANDIDATE";
    statusReason =
      `freshValid=${freshValid}≥100, all post-cutover OOS thirds positive, netAvgR=${(netAvgR as number).toFixed(4)}>0.05, ` +
      `PF=${(pf as number).toFixed(2)}>1.20, top symbol share≤${(MAX_TOP_SYMBOL_SHARE * 100).toFixed(0)}%, drawdown acceptable.`;
  } else if (freshValid >= 50 && netPositive && pfWatchable && plus10bpsStillPositive) {
    status = "WATCHABLE";
    statusReason =
      `freshValid=${freshValid}≥50, netAvgR=${(netAvgR as number).toFixed(4)}>0, PF=${(pf as number).toFixed(2)}>1.20, +10bps positive.`;
  } else {
    status = "COLLECTING";
    const netStr = netAvgR === null ? "n/a" : netAvgR.toFixed(4);
    statusReason = `freshValid=${freshValid} post-cutover, netAvgR=${netStr} — below WATCHABLE bar.`;
  }

  // ── blockers (what's missing to reach PROMOTION_CANDIDATE) ──────────────────
  const blockers: string[] = [];
  if (boundary === null) {
    blockers.push("CUTOVER: no boundary locked (pathology verdict not OLD_BATCH or insufficient frozen sample).");
  }
  if (freshValid < 200) {
    blockers.push(`SAMPLE_SIZE: post-cutover freshValid=${freshValid}, need ≥200.`);
  }
  if (!allThreeSegmentsPositive) {
    blockers.push("OOS_STABILITY: not all post-cutover OOS thirds positive (need 3/3, or n≥3 to compute).");
  }
  if (!netStrong) {
    const netStr = netAvgR === null ? "n/a" : netAvgR.toFixed(4);
    blockers.push(`NET_EXPECTANCY: netAvgR=${netStr}, need >0.05.`);
  }
  if (!pfStrong) {
    const pfStr = pf === null ? "n/a" : pf.toFixed(2);
    blockers.push(`PROFIT_FACTOR: PF=${pfStr}, need >1.20.`);
  }
  if (costStressFails) {
    blockers.push("COST_STRESS: +10bps slippage scenario not net positive.");
  }
  if (!concentrationOk) {
    const shStr = topSymbolPnlShare === null ? "n/a" : `${(topSymbolPnlShare * 100).toFixed(1)}%`;
    blockers.push(`CONCENTRATION: top symbol share=${shStr}, need ≤${(MAX_TOP_SYMBOL_SHARE * 100).toFixed(0)}%.`);
  }
  if (!drawdownAcceptable) {
    const ddStr = approxMaxDrawdownR === null ? "n/a" : approxMaxDrawdownR.toFixed(2);
    blockers.push(`DRAWDOWN: approxMaxDrawdownR=${ddStr}R, need |dd|≤${MAX_DRAWDOWN_R_LIMIT}R.`);
  }
  if (!infraReady) {
    blockers.push("INFRA: kill-switch / order-reconciliation / exchange-health readiness not all implemented.");
  }

  // ── cautions ────────────────────────────────────────────────────────────────
  const cautions: string[] = [
    "Report-only forward-validation tape; no live behavior is gated on this status. liveBlocked stays true; microPilotAllowed stays false.",
    "Segment 1 (OLD_BATCH) is NOT deleted — it remains in the frozen tape (F***). This tape only reads past the locked cutover for clean forward-test math.",
    "PROMOTION_CANDIDATE here is necessary but NOT sufficient for a micro-pilot — infra readiness (kill switch / order reconciliation / exchange health) must also be implemented.",
  ];
  if (boundary !== null) {
    cautions.push(
      `Cutover locked at ${boundary.cutoverTimestamp} (immutable): "${boundary.reason}"`,
    );
  }
  if (!realisticCostModel || realisticCostModel.modelPopulated !== true) {
    cautions.push("Realistic cost model not fully populated; +10bps check uses fallback cost-sensitivity table.");
  }
  if (rSanityExcludedCount > 0) {
    cautions.push(
      `DATA QUALITY: ${rSanityExcludedCount} obs excluded — |R| > ${R_SANITY_CAP_R}R is physically implausible (pre-fix R-denominator bug fabricated runner R against the moved stop). Multi-slice exits mirrored before the fix may still be optimistic.`,
    );
  }

  return {
    reportOnly: true,
    laneId: POST_CUTOVER_LANE,
    computedAt,
    boundary,
    cutoverActive,
    total,
    open,
    resolved,
    freshValid,
    rSanityExcludedCount,
    netAvgR,
    pf,
    wr,
    daysCovered,
    costSensitivity,
    realisticCostModel,
    rolling,
    oosSegments,
    allThreeSegmentsPositive,
    bySymbol,
    byEntryVariant,
    byRegime,
    topSymbolPnlShare,
    approxMaxDrawdownR,
    maxAdverseStreak,
    resolvedPerDay: Number.isFinite(resolvedPerDay) ? resolvedPerDay : null,
    freshValidPerDay: Number.isFinite(freshValidPerDay) ? freshValidPerDay : null,
    etaToN100Days,
    etaToN100Date: etaDate(etaToN100Days),
    etaToN200Days,
    etaToN200Date: etaDate(etaToN200Days),
    plus10bpsStillPositive,
    status,
    statusReason,
    blockers,
    cautions,
  };
}

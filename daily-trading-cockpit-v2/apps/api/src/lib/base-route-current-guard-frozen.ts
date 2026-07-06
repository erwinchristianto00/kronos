/**
 * BASE ROUTE CURRENT-GUARD FROZEN PROSPECTIVE TAPE (F***) — REPORT-ONLY
 *
 * Mirrors qualifying current-guard observations into an isolated frozen tape so
 * that PROSPECTIVE (forward-test) performance can be evaluated against criteria
 * frozen at creation time. This avoids moving the goalposts on an in-sample
 * tape that already looks good.
 *
 * Lane label: BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1
 * Storage: <dataDir>/base-route-current-guard-frozen.json
 *
 * STRICTLY REPORT-ONLY:
 *  - Isolated file. NEVER touches the live shadow tape (data/shadow-positions).
 *  - Only MIRRORS observations that ALREADY qualify under the current-guard
 *    definition. Does NOT change base route admission, create new trades, or
 *    duplicate real trade logic.
 *  - Criteria snapshot stored once on first mirror and never changed.
 *  - All writes wrapped in try/catch; never throws.
 *  - reportOnly: true always set.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  CostSensitivityRow,
  CurrentGuardClosedPosition,
  SegmentStats,
} from "./base-route-current-guard-stability-audit.js";

export const FROZEN_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;

/**
 * Physical sanity cap on per-obs |R| (matches the VM tape's 20R MFE/MAE cap). Obs beyond this are
 * fabricated by the pre-fix shadow-engine R-denominator bug (runner slices were divided by the
 * moved/trailed stop distance — the audit found a +201R runner whose honest original-R outcome was
 * ≈0..1R). Both frozen tapes quarantine such obs from economics; the exclusion is always counted.
 */
export const R_SANITY_CAP_R = 20;

const AVERAGE_STOP_BPS = 200;

export interface FrozenCriteriaSnapshot {
  version: typeof FROZEN_LANE;
  frozenAt: string;
  criteria: {
    guardEra: "RISK_HYGIENE_GUARD_V1";
    minStopDistanceBps: 175;
    policyVersion: "base-route-anchor-consistent-v2";
    description: string;
  };
}

export interface FrozenCurrentGuardObservation {
  reportOnly: true;
  laneVersion: typeof FROZEN_LANE;
  observationKey: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  openedAt: string;
  closedAt: string | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS";
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  regime: string | null;
  entryVariant: string | null;
  exitVariant: string | null;
  policyVersion: string | null;
  /** Optional — when populated, used for stop-bucket breakdown in OOS segment forensics. */
  stopDistanceBps?: number | null;
  mirroredAt: string;
}

interface FrozenStoreFile {
  criteria: FrozenCriteriaSnapshot | null;
  observations: FrozenCurrentGuardObservation[];
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

function makeObservationKey(symbol: string, direction: string, openedAt: string): string {
  return `${symbol}|${direction}|${openedAt}`;
}

/**
 * Convert current-guard closed positions into frozen observations. All inputs
 * here are CLOSED positions (the monitor only exposes closed current-guard
 * positions), so status is CLOSED_WIN / CLOSED_LOSS based on grossR sign.
 * OPEN observations would carry status "OPEN" with null economics, but the
 * monitor does not expose open positions at this granularity, so this helper
 * emits CLOSED observations only.
 */
export function toFrozenObservations(
  positions: CurrentGuardClosedPosition[],
): FrozenCurrentGuardObservation[] {
  const mirroredAt = new Date().toISOString();
  const out: FrozenCurrentGuardObservation[] = [];
  for (const p of positions) {
    if (!p || typeof p.symbol !== "string") continue;
    const isWin = typeof p.grossR === "number" && Number.isFinite(p.grossR) && p.grossR > 0;
    out.push({
      reportOnly: true,
      laneVersion: FROZEN_LANE,
      observationKey: makeObservationKey(p.symbol, p.direction, p.openedAt),
      symbol: p.symbol,
      direction: p.direction,
      openedAt: p.openedAt,
      closedAt: p.closedAt ?? null,
      status: isWin ? "CLOSED_WIN" : "CLOSED_LOSS",
      grossR: typeof p.grossR === "number" ? p.grossR : null,
      netR: typeof p.netR === "number" ? p.netR : null,
      costR: typeof p.costR === "number" ? p.costR : null,
      regime: p.regime ?? null,
      entryVariant: p.entryVariant ?? null,
      exitVariant: p.exitVariant ?? null,
      policyVersion: p.policyVersion ?? null,
      stopDistanceBps: p.stopDistanceBps ?? null,
      mirroredAt,
    });
  }
  return out;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class FrozenCurrentGuardStore {
  private readonly file: string;
  private criteria: FrozenCriteriaSnapshot | null;
  private observations: FrozenCurrentGuardObservation[];

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "base-route-current-guard-frozen.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort; report-only
    }
    const loaded = this._load();
    this.criteria = loaded.criteria;
    this.observations = loaded.observations;
  }

  get path(): string {
    return this.file;
  }

  get all(): FrozenCurrentGuardObservation[] {
    return this.observations;
  }

  getCriteria(): FrozenCriteriaSnapshot | null {
    return this.criteria;
  }

  private _load(): FrozenStoreFile {
    try {
      if (!existsSync(this.file)) return { criteria: null, observations: [] };
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FrozenStoreFile>;
      return {
        criteria: parsed.criteria ?? null,
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      };
    } catch {
      return { criteria: null, observations: [] };
    }
  }

  save(): void {
    try {
      const payload: FrozenStoreFile = {
        criteria: this.criteria,
        observations: this.observations,
      };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // storage failures must never throw — this lane is report-only
    }
  }

  private _defaultCriteria(): FrozenCriteriaSnapshot {
    return {
      version: FROZEN_LANE,
      frozenAt: new Date().toISOString(),
      criteria: {
        guardEra: "RISK_HYGIENE_GUARD_V1",
        minStopDistanceBps: 175,
        policyVersion: "base-route-anchor-consistent-v2",
        description:
          "Frozen prospective tape mirroring qualifying current-guard closes " +
          "(riskHygieneGuardMinStopDistanceBps=175, anchor-consistent V2). " +
          "Criteria frozen at first mirror; report-only; never influences live behavior.",
      },
    };
  }

  /**
   * Mirror qualifying observations into the frozen tape. Dedupe by observationKey.
   * Stores the criteria snapshot once on first mirror and never changes it.
   * Re-mirroring updates resolution status (OPEN → CLOSED_*) but never the criteria.
   */
  mirror(qualifying: FrozenCurrentGuardObservation[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    try {
      if (this.criteria === null) {
        this.criteria = this._defaultCriteria();
      }
      const index = new Map<string, number>();
      this.observations.forEach((o, i) => index.set(o.observationKey, i));

      for (const obs of qualifying) {
        if (!obs || typeof obs.observationKey !== "string") continue;
        const existingIdx = index.get(obs.observationKey);
        if (existingIdx === undefined) {
          this.observations.push(obs);
          index.set(obs.observationKey, this.observations.length - 1);
          added += 1;
        } else {
          const existing = this.observations[existingIdx]!;
          // Only update resolution status / economics; preserve original mirroredAt.
          const changed =
            existing.status !== obs.status ||
            existing.closedAt !== obs.closedAt ||
            existing.grossR !== obs.grossR ||
            existing.netR !== obs.netR;
          if (changed) {
            this.observations[existingIdx] = {
              ...existing,
              status: obs.status,
              closedAt: obs.closedAt,
              grossR: obs.grossR,
              netR: obs.netR,
              costR: obs.costR,
              regime: obs.regime,
              entryVariant: obs.entryVariant,
              exitVariant: obs.exitVariant,
              policyVersion: obs.policyVersion,
            };
            updated += 1;
          }
        }
      }
      if (added > 0 || updated > 0) {
        this.save();
      } else if (this.criteria !== null && !existsSync(this.file)) {
        // ensure criteria snapshot persists even if no observations
        this.save();
      }
    } catch {
      // report-only; never throw
    }
    return { added, updated };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let singleton: FrozenCurrentGuardStore | null = null;

export function getFrozenCurrentGuardStore(dataDir = "data"): FrozenCurrentGuardStore {
  if (!singleton) {
    singleton = new FrozenCurrentGuardStore(dataDir);
  }
  return singleton;
}

export function _resetFrozenCurrentGuardStoreForTests(): void {
  singleton = null;
}

// ─── OOS Segment Forensics ───────────────────────────────────────────────────

/** Per-group breakdown row used inside OosSegmentForensics. */
export interface ForensicsRow {
  key: string; // symbol / entryVariant / regime / stopBucket label
  n: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
  /** Share of total absolute gross PnL for this segment (0–1). */
  pnlSharePct: number | null;
}

/** Single losing trade record for the losing-trades list. */
export interface ForensicsLossTrade {
  symbol: string;
  openedAt: string;
  closedAt: string | null;
  netR: number;
  grossR: number;
  costR: number | null;
  regime: string | null;
  entryVariant: string | null;
  stopDistanceBps: number | null;
}

/**
 * Per-OOS-segment forensics: why is segment N positive/negative?
 * Breakdowns by symbol, entry variant, regime, and stop bucket.
 * All breakdowns sorted by netAvgR ascending (worst performers first).
 */
export interface OosSegmentForensics {
  segmentLabel: string;
  n: number;
  netAvgR: number | null;
  avgCostR: number | null;
  /** By-symbol breakdown, sorted worst-first (top 15). */
  bySymbol: ForensicsRow[];
  /** By-entry-variant breakdown, sorted worst-first. */
  byEntryVariant: ForensicsRow[];
  /** By-regime breakdown, sorted worst-first. */
  byRegime: ForensicsRow[];
  /**
   * By-stop-distance-bucket breakdown.
   * Buckets: 175-199, 200-249, 250-299, 300+, UNKNOWN.
   * UNKNOWN used when stopDistanceBps is not available.
   */
  byStopBucket: ForensicsRow[];
  /**
   * All losing trades sorted by netR ascending (worst first).
   * Capped at 30 rows to avoid excessively long dashboard output.
   */
  losingTrades: ForensicsLossTrade[];
  /**
   * Top 5 single worst netR trades (worst drag contributors).
   * Subset of losingTrades.
   */
  topLossContributors: ForensicsLossTrade[];
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface FrozenTapeVelocity {
  resolvedPerDay: number | null;
  freshValidPerDay: number | null;
  etaToN100Days: number | null;
  etaToN200Days: number | null;
  etaToN100Date: string | null; // ISO date estimate (YYYY-MM-DD)
  etaToN200Date: string | null;
}

export interface OosSegmentWatch {
  segment1: SegmentStats | null;
  segment2: SegmentStats | null;
  segment3: SegmentStats | null;
  weakestSegment: { label: string; netAvgR: number | null } | null;
  positiveSegmentCount: number; // how many of 3 are net positive
  allSegmentsPositive: boolean;
  requiredFuturePositiveSegments: number; // how many more positive segments needed (target: all 3)
  stabilityStatus: "STABILITY_BLOCKED" | "STABILITY_OK"; // BLOCKED until allSegmentsPositive
  note: string;
}

export interface FrozenCurrentGuardReport {
  reportOnly: true;
  laneVersion: typeof FROZEN_LANE;
  computedAt: string;
  criteriaFrozenAt: string | null;
  total: number;
  open: number;
  resolved: number;
  freshValid: number;
  /** Obs excluded from freshValid because |R| > R_SANITY_CAP_R (pre-fix R-denominator fabrication). */
  rSanityExcludedCount: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  daysCovered: number;
  oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null;
  allThreeSegmentsPositive: boolean;
  costSensitivity: CostSensitivityRow[];
  topSymbolPnlShare: number;
  velocity: FrozenTapeVelocity;
  oosWatch: OosSegmentWatch;
  status: "COLLECTING" | "WATCHABLE" | "STABLE_CANDIDATE" | "PROMOTION_CANDIDATE";
  statusReason: string;
  /**
   * Report-only: the fresh-valid resolved observations, time-ordered by
   * closedAt (then openedAt). Exposed so downstream pure modules (e.g. the
   * F**** promotion tracker) can compute rolling windows / drawdown without
   * re-reading the store. Backward-compatible additive field.
   */
  resolvedObservations: FrozenCurrentGuardObservation[];
  /**
   * Per-OOS-segment forensics — null when fewer than 3 fresh-valid observations.
   * Answers: which symbol / entry / regime / cost bucket drove each segment's P&L.
   * Segment 1 = oldest third; Segment 3 = most recent third.
   * Sorted worst-first within each breakdown. Report-only; no behavior influence.
   */
  oosSegmentForensics: [OosSegmentForensics, OosSegmentForensics, OosSegmentForensics] | null;
}

// ─── Forensics helpers ───────────────────────────────────────────────────────

function stopBucketLabel(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "UNKNOWN";
  if (bps < 200) return "175-199";
  if (bps < 250) return "200-249";
  if (bps < 300) return "250-299";
  return "300+";
}

function buildForensicsRows(
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
    const nets = arr.map((o) => o.netR);
    const absGrossSum = finiteNumbers(grosses).reduce((s, v) => s + Math.abs(v), 0);
    rows.push({
      key,
      n: arr.length,
      netAvgR: mean(nets),
      grossAvgR: mean(grosses),
      pf: pfFinite(grosses),
      wr: winRate(grosses),
      pnlSharePct: totalAbsGross > 0 ? absGrossSum / totalAbsGross : null,
    });
  }
  // sort worst-first by netAvgR (nulls last)
  rows.sort((a, b) => {
    if (a.netAvgR === null && b.netAvgR === null) return 0;
    if (a.netAvgR === null) return 1;
    if (b.netAvgR === null) return -1;
    return a.netAvgR - b.netAvgR;
  });
  return rows.slice(0, maxRows);
}

function buildOosSegmentForensics(
  segmentLabel: string,
  slice: FrozenCurrentGuardObservation[],
): OosSegmentForensics {
  const n = slice.length;
  const netAvgR = mean(slice.map((o) => o.netR));
  const avgCostR = mean(slice.map((o) => o.costR));

  const totalAbsGross = finiteNumbers(slice.map((o) => o.grossR)).reduce(
    (s, v) => s + Math.abs(v),
    0,
  );

  const bySymbol = buildForensicsRows(slice, (o) => o.symbol, totalAbsGross, 15);
  const byEntryVariant = buildForensicsRows(
    slice,
    (o) => o.entryVariant ?? "UNKNOWN",
    totalAbsGross,
    15,
  );
  const byRegime = buildForensicsRows(
    slice,
    (o) => o.regime ?? "UNKNOWN",
    totalAbsGross,
    15,
  );
  const byStopBucket = buildForensicsRows(
    slice,
    (o) => stopBucketLabel(o.stopDistanceBps),
    totalAbsGross,
    10,
  );

  // losing trades: all observations with netR < 0, sorted worst first, capped at 30
  const losing = slice
    .filter((o) => typeof o.netR === "number" && Number.isFinite(o.netR) && o.netR < 0)
    .sort((a, b) => (a.netR ?? 0) - (b.netR ?? 0));
  const toTrade = (o: FrozenCurrentGuardObservation): ForensicsLossTrade => ({
    symbol: o.symbol,
    openedAt: o.openedAt,
    closedAt: o.closedAt,
    netR: o.netR!,
    grossR: o.grossR!,
    costR: o.costR,
    regime: o.regime,
    entryVariant: o.entryVariant,
    stopDistanceBps: o.stopDistanceBps ?? null,
  });
  const losingTrades = losing.slice(0, 30).map(toTrade);
  const topLossContributors = losing.slice(0, 5).map(toTrade);

  return {
    segmentLabel,
    n,
    netAvgR,
    avgCostR,
    bySymbol,
    byEntryVariant,
    byRegime,
    byStopBucket,
    losingTrades,
    topLossContributors,
  };
}

// ─── Segment stats ──────────────────────────────────────────────────────────

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

export function buildFrozenCurrentGuardReport(
  store: FrozenCurrentGuardStore,
): FrozenCurrentGuardReport {
  const computedAt = new Date().toISOString();
  const criteria = store.getCriteria();
  const all = store.all ?? [];
  const total = all.length;
  const open = all.filter((o) => o.status === "OPEN").length;
  const resolvedObs = all.filter((o) => o.status !== "OPEN");
  const resolved = resolvedObs.length;
  const finiteRObs = resolvedObs.filter(
    (o) =>
      typeof o.grossR === "number" &&
      Number.isFinite(o.grossR) &&
      typeof o.netR === "number" &&
      Number.isFinite(o.netR),
  );
  // R-sanity quarantine (see R_SANITY_CAP_R in frozen-current-guard-post-cutover): |R| > 20R is
  // physically implausible for >=175bps-stop admissions and marks obs fabricated by the pre-fix
  // shadow-engine R-denominator bug. Excluded from economics; surfaced via rSanityExcludedCount.
  const freshValidObs = finiteRObs.filter(
    (o) => Math.abs(o.grossR as number) <= R_SANITY_CAP_R && Math.abs(o.netR as number) <= R_SANITY_CAP_R,
  );
  const rSanityExcludedCount = finiteRObs.length - freshValidObs.length;
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

  // OOS thirds (time-ordered by closedAt)
  const sorted = [...freshValidObs].sort((a, b) => {
    const am = toMs(a.closedAt) || toMs(a.openedAt);
    const bm = toMs(b.closedAt) || toMs(b.openedAt);
    return am - bm;
  });
  let oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null = null;
  let oosSegmentForensics: [OosSegmentForensics, OosSegmentForensics, OosSegmentForensics] | null =
    null;
  if (sorted.length >= 3) {
    const third = Math.floor(sorted.length / 3);
    const seg1Slice = sorted.slice(0, third);
    const seg2Slice = sorted.slice(third, third * 2);
    const seg3Slice = sorted.slice(third * 2);
    oosSegments = [
      segmentOf("segment_1", seg1Slice),
      segmentOf("segment_2", seg2Slice),
      segmentOf("segment_3", seg3Slice),
    ];
    oosSegmentForensics = [
      buildOosSegmentForensics("segment_1", seg1Slice),
      buildOosSegmentForensics("segment_2", seg2Slice),
      buildOosSegmentForensics("segment_3", seg3Slice),
    ];
  }
  const allThreeSegmentsPositive =
    oosSegments !== null && oosSegments.every((s) => s.netAvgR !== null && s.netAvgR > 0);

  // top symbol pnl share (abs gross)
  const symbolMap = new Map<string, number>();
  let totalAbsGross = 0;
  for (const o of freshValidObs) {
    if (typeof o.grossR !== "number" || !Number.isFinite(o.grossR)) continue;
    const abs = Math.abs(o.grossR);
    symbolMap.set(o.symbol, (symbolMap.get(o.symbol) ?? 0) + abs);
    totalAbsGross += abs;
  }
  let topSymbolPnlShare = 0;
  if (totalAbsGross > 0) {
    for (const v of symbolMap.values()) {
      const share = v / totalAbsGross;
      if (share > topSymbolPnlShare) topSymbolPnlShare = share;
    }
  }

  const costSensitivity = buildCostSensitivity(freshValidObs);

  // ─── velocity / ETA ─────────────────────────────────────────────────────────
  const daysDenom = Math.max(daysCovered, 1);
  const resolvedPerDay = resolved / daysDenom;
  const freshValidPerDay = freshValid / daysDenom;
  const etaDays = (target: number, current: number, perDay: number): number | null => {
    if (current >= target) return 0;
    if (perDay <= 0 || !Number.isFinite(perDay)) return null;
    return (target - current) / perDay;
  };
  const nowMs = Date.parse(computedAt);
  const etaDate = (etaDays: number | null): string | null => {
    if (etaDays === null || !Number.isFinite(nowMs)) return null;
    return new Date(nowMs + etaDays * 86_400_000).toISOString().slice(0, 10);
  };
  const etaToN100Days = etaDays(100, freshValid, freshValidPerDay);
  const etaToN200Days = etaDays(200, freshValid, freshValidPerDay);
  const velocity: FrozenTapeVelocity = {
    resolvedPerDay: Number.isFinite(resolvedPerDay) ? resolvedPerDay : null,
    freshValidPerDay: Number.isFinite(freshValidPerDay) ? freshValidPerDay : null,
    etaToN100Days,
    etaToN200Days,
    etaToN100Date: etaDate(etaToN100Days),
    etaToN200Date: etaDate(etaToN200Days),
  };

  // ─── OOS segment watch ────────────────────────────────────────────────────────
  const seg1 = oosSegments?.[0] ?? null;
  const seg2 = oosSegments?.[1] ?? null;
  const seg3 = oosSegments?.[2] ?? null;
  const segList = [seg1, seg2, seg3].filter((s): s is SegmentStats => s !== null);
  const isSegPositive = (s: SegmentStats | null): boolean =>
    s !== null && s.netAvgR !== null && s.netAvgR > 0;
  const positiveSegmentCount = segList.filter(isSegPositive).length;
  const allSegmentsPositive = oosSegments !== null && positiveSegmentCount === 3;
  let weakestSegment: { label: string; netAvgR: number | null } | null = null;
  for (const s of segList) {
    if (s.netAvgR === null) continue;
    if (weakestSegment === null || weakestSegment.netAvgR === null || s.netAvgR < weakestSegment.netAvgR) {
      weakestSegment = { label: s.label, netAvgR: s.netAvgR };
    }
  }
  const requiredFuturePositiveSegments = oosSegments === null ? 3 : Math.max(0, 3 - positiveSegmentCount);
  const stabilityStatus: OosSegmentWatch["stabilityStatus"] = allSegmentsPositive
    ? "STABILITY_OK"
    : "STABILITY_BLOCKED";
  let oosNote: string;
  if (oosSegments === null) {
    oosNote = "Insufficient sample for 3 OOS segments — STABILITY_BLOCKED until all 3 segments computable and positive.";
  } else if (allSegmentsPositive) {
    oosNote = "All 3 OOS segments net positive — STABILITY_OK.";
  } else {
    const weakLabel = weakestSegment?.label ?? "n/a";
    const weakNet = weakestSegment?.netAvgR;
    const weakStr = typeof weakNet === "number" ? weakNet.toFixed(2) : "n/a";
    oosNote =
      `${weakLabel} weakest (net=${weakStr}); edge concentrated in recent segments — ` +
      `STABILITY_BLOCKED until all 3 OOS segments positive.`;
  }
  const oosWatch: OosSegmentWatch = {
    segment1: seg1,
    segment2: seg2,
    segment3: seg3,
    weakestSegment,
    positiveSegmentCount,
    allSegmentsPositive,
    requiredFuturePositiveSegments,
    stabilityStatus,
    note: oosNote,
  };

  // status rules
  let status: FrozenCurrentGuardReport["status"];
  let statusReason: string;
  const stable =
    resolved >= 100 &&
    netAvgR !== null &&
    netAvgR > 0.05 &&
    pf !== null &&
    pf > 1.2 &&
    allThreeSegmentsPositive;
  if (resolved < 50) {
    status = "COLLECTING";
    statusReason = `resolved=${resolved} (<50) — collecting prospective evidence`;
  } else if (stable && resolved >= 200 && topSymbolPnlShare <= 0.4) {
    status = "PROMOTION_CANDIDATE";
    statusReason = `resolved=${resolved}≥200, netAvgR=${netAvgR!.toFixed(4)}, PF=${pf!.toFixed(2)}, all 3 OOS positive, top symbol share=${(topSymbolPnlShare * 100).toFixed(1)}%≤40%`;
  } else if (stable) {
    status = "STABLE_CANDIDATE";
    statusReason = `resolved=${resolved}≥100, netAvgR=${netAvgR!.toFixed(4)}>0.05, PF=${pf!.toFixed(2)}>1.20, all 3 OOS positive`;
  } else if (resolved >= 50 && netAvgR !== null && netAvgR > 0) {
    status = "WATCHABLE";
    statusReason = `resolved=${resolved}≥50, netAvgR=${netAvgR.toFixed(4)}>0`;
  } else {
    status = "COLLECTING";
    statusReason = `resolved=${resolved}${netAvgR !== null ? `, netAvgR=${netAvgR.toFixed(4)}` : ""} — does not meet WATCHABLE bar`;
  }

  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    computedAt,
    criteriaFrozenAt: criteria?.frozenAt ?? null,
    total,
    open,
    resolved,
    freshValid,
    rSanityExcludedCount,
    netAvgR,
    pf,
    wr,
    daysCovered,
    oosSegments,
    allThreeSegmentsPositive,
    costSensitivity,
    topSymbolPnlShare,
    velocity,
    oosWatch,
    status,
    statusReason,
    resolvedObservations: sorted,
    oosSegmentForensics,
  };
}

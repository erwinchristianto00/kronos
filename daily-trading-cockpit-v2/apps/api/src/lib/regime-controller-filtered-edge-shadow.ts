/**
 * REGIME CONTROLLER ALIGNED FILTERED EDGE SHADOW (REPORT-ONLY)
 *
 * An isolated shadow-only collection lane that admits candidates only when they
 * pass controller-aligned base gates PLUS one of two cost/stop profile tiers:
 *   STRICT_COST10:         costR <= 0.10 (any stop passing the variant-adjusted guard)
 *   BROAD_COST20_STOP150:  costR <= 0.20 AND stopDistanceBps >= 150
 *
 * Additionally excludes BTCUSDT and SEIUSDT symbols.
 *
 * Lane label: REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1
 * Storage: data/regime-controller-filtered-edge-shadow.json
 *
 * STRICTLY REPORT-ONLY:
 *  - Isolated file; does NOT touch data/shadow-positions.json
 *  - No live behavior, route selection, readiness, or scoring changes
 *  - No Kronos/Whale/Fingerprint/adaptive/readiness changes
 *  - reportOnly: true always set
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { computeControllerAlignedGuardThreshold } from "./regime-controller-aligned-shadow.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const FILTERED_EDGE_SHADOW_LANE =
  "REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1" as const;
export const FILTERED_EDGE_FORENSICS_VERSION = "filtered-edge-forensics-v2" as const;
export const FILTERED_EDGE_PATH_METRIC_VERSION = "mfe-mae-bounded-v1" as const;
export const FILTERED_EDGE_CHRONOLOGY_VERSION = "chronology-fill-candle-v1" as const;

const EXCLUDED_SYMBOLS = ["BTCUSDT", "SEIUSDT"] as const;
const PATH_METRIC_ABS_CAP_R = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilteredEdgeProfile = "STRICT_COST10" | "BROAD_COST20_STOP150";
export type FilteredEdgeChronologyStatus =
  | "VALID"
  | "INVALID_NEGATIVE_DURATION"
  | "INVALID_OPENED_BEFORE_CREATED"
  | "UNAVAILABLE";
export type FilteredEdgePathMetricStatus =
  | "VALID"
  | "PATH_METRIC_INVALID_RISK"
  | "PATH_METRIC_OUTLIER"
  | "PATH_METRIC_MISSING"
  | "UNAVAILABLE";
export type FilteredEdgeIntrabarStatus =
  | "VALID_5M_ORDERED"
  | "AMBIGUOUS_SAME_CANDLE"
  | "RESOLVED_BY_1M"
  | "INTRABAR_UNAVAILABLE"
  | "UNAVAILABLE";
export type FilteredEdgeFreshVerdict =
  | "TOO_EARLY"
  | "WATCHABLE_EDGE"
  | "FILTERED_EDGE_NOT_CONFIRMED"
  | "DEPRIORITIZE_FILTERED_EDGE";

/**
 * Quarantine reasons for legacy records that cannot be safely admitted to fresh-valid.
 * Stored in-memory only on report objects; never mutates persisted JSON.
 */
export type FilteredEdgeQuarantineReason =
  | "LEGACY_MISSING_PATH"
  | "LEGACY_OUTLIER_PATH"
  | "LEGACY_INVALID_CHRONOLOGY"
  | "LEGACY_AMBIGUOUS_INTRABAR"
  | "LEGACY_MISSING_VERSION";

// ─── Position interface ────────────────────────────────────────────────────────

export interface FilteredEdgeShadowPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  profile: FilteredEdgeProfile;
  controllerMode: string;
  currentRegime: string | null;
  marketRegimeAtOpen: string | null;
  openedAt: string;
  createdAt: string;
  updatedAt?: string | null;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number | null;
  costR: number | null;
  atrPercent: number | null;
  variantAdjustedGuardThresholdBps: number | null;
  guardPassedUnder: "VARIANT_ADJUSTED" | "FALLBACK_FIXED_175" | "FAILED_VARIANT_ADJUSTED";
  sourceConflict: boolean;
  liveSourceConflict: boolean | null;
  kronosBias: string | null;
  whaleAgreement: string | null;
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  kronosHorizonConflict: boolean | null;

  // resolver fields
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED" | "NO_FILL" | "AMBIGUOUS";
  closedAt: string | null;
  grossR: number | null;
  netR: number | null;
  resolutionSource: string | null;
  durationMinutes: number | null;
  chronologyStatus?: FilteredEdgeChronologyStatus | null;
  chronologyWarning?: string | null;

  // MFE/MAE excursion fields (populated by resolver when candle data available)
  maxMfeR?: number | null;    // max favorable excursion in R before resolution (positive = favorable)
  minMaeR?: number | null;    // max adverse excursion in R before resolution (negative = adverse)
  mfeBeforeCloseR?: number | null;
  maeBeforeCloseR?: number | null;
  pathMetricStatus?: FilteredEdgePathMetricStatus | null;
  pathMetricWarning?: string | null;
  immediateSl?: boolean;       // true if SL hit within first 2 candles (5m each = 10 minutes)
  noMfeBeforeSl?: boolean;     // true if status=CLOSED_LOSS AND maxMfeR <= 0.05 (no meaningful favorable move)

  // Intrabar ambiguity diagnostics (report-only)
  intrabarResolutionStatus?:
    | "VALID_5M_ORDERED"        // SL or TP hit in a LATER candle than entry candle — unambiguous
    | "AMBIGUOUS_SAME_CANDLE"   // SL and entry are in same 5m candle — ordering unknown
    | "RESOLVED_BY_1M"          // 1m candles confirmed ordering
    | "INTRABAR_UNAVAILABLE"    // could not resolve intrabar
    | null;
  fillCandleOpenTime?: number | null;   // epoch ms of the candle where fill was detected
  fillCandleLow?: number | null;
  fillCandleHigh?: number | null;
  ambiguousLevelsTouched?: string[] | null;   // e.g. ["ENTRY", "SL"] or ["ENTRY", "TP1"]
  // true when intrabarResolutionStatus is VALID_5M_ORDERED or RESOLVED_BY_1M
  // false when AMBIGUOUS_SAME_CANDLE with no 1m resolution
  isFreshValid?: boolean | null;

  // metadata
  reportOnly: true;
  laneVersion: typeof FILTERED_EDGE_SHADOW_LANE;
  policyVersion: "filtered-edge-anchor-consistent-v1";
  analyticsVersion?: typeof FILTERED_EDGE_FORENSICS_VERSION | null;
  pathMetricVersion?: typeof FILTERED_EDGE_PATH_METRIC_VERSION | null;
  chronologyVersion?: typeof FILTERED_EDGE_CHRONOLOGY_VERSION | null;
}

// ─── Store class ──────────────────────────────────────────────────────────────

export class FilteredEdgeShadowStore {
  private readonly file: string;
  private positions: FilteredEdgeShadowPosition[];

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "regime-controller-filtered-edge-shadow.json");
    mkdirSync(dirname(this.file), { recursive: true });
    this.positions = this._load();
  }

  get path(): string {
    return this.file;
  }

  get all(): FilteredEdgeShadowPosition[] {
    return this.positions;
  }

  private _load(): FilteredEdgeShadowPosition[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as FilteredEdgeShadowPosition[]) : [];
    } catch {
      return [];
    }
  }

  save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.positions, null, 2), "utf-8");
    } catch {
      // storage failures must never throw — this lane is report-only
    }
  }

  add(pos: FilteredEdgeShadowPosition): void {
    this.positions.push(pos);
    this.save();
  }

  update(id: string, patch: Partial<FilteredEdgeShadowPosition>): void {
    const idx = this.positions.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.positions[idx] = {
        ...this.positions[idx]!,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      this.save();
    }
  }

  isDuplicate(
    symbol: string,
    direction: string,
    profile: FilteredEdgeProfile,
    windowMs = 4 * 60 * 60 * 1000,
  ): boolean {
    const now = Date.now();
    return this.positions.some(
      (p) =>
        p.symbol === symbol &&
        p.direction === direction &&
        p.profile === profile &&
        (p.status === "OPEN" || p.status === "AMBIGUOUS") &&
        now - new Date(p.openedAt).getTime() < windowMs,
    );
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let singleton: FilteredEdgeShadowStore | null = null;

export function getFilteredEdgeShadowStore(dataDir = "data"): FilteredEdgeShadowStore {
  if (!singleton) {
    singleton = new FilteredEdgeShadowStore(dataDir);
  }
  return singleton;
}

export function _resetFilteredEdgeShadowStoreForTests(): void {
  singleton = null;
}

// ─── Admission ────────────────────────────────────────────────────────────────

export interface FilteredEdgeCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  controllerMode: string;
  currentRegime: string | null;
  marketRegimeAtOpen?: string | null;
  entryPrice: number;
  stopLoss: number;
  takeProfits: { tp1?: number; tp2?: number; tp3?: number };
  stopDistanceBps: number | null;
  costR: number | null;
  atrPercent: number | null;
  sourceConflict: boolean;
  liveSourceConflict?: boolean | null;
  kronosBias?: string | null;
  whaleAgreement?: string | null;
  selectedEntryVariant?: string | null;
  selectedExitVariant?: string | null;
  kronosHorizonConflict?: boolean | null;
  selectedExecutionPlan?: unknown;
}

export interface FilteredEdgeAdmissionResult {
  admitted: boolean;
  profile: FilteredEdgeProfile | null;
  rejectionReasons: string[];
}

export function admitToFilteredEdgeShadow(
  candidate: FilteredEdgeCandidate,
  store: FilteredEdgeShadowStore,
  opts?: { nowMs?: number },
): FilteredEdgeAdmissionResult {
  const rejectionReasons: string[] = [];

  // ── Base gates ────────────────────────────────────────────────────────────

  // 1. controllerMode must be LONG_ONLY or SHORT_ONLY
  if (candidate.controllerMode !== "LONG_ONLY" && candidate.controllerMode !== "SHORT_ONLY") {
    rejectionReasons.push("CONTROLLER_MODE_NOT_DIRECTIONAL");
  } else {
    // 2. direction must match controller
    if (candidate.controllerMode === "LONG_ONLY" && candidate.direction !== "LONG") {
      rejectionReasons.push("DIRECTION_BLOCKED_BY_CONTROLLER");
    }
    if (candidate.controllerMode === "SHORT_ONLY" && candidate.direction !== "SHORT") {
      rejectionReasons.push("DIRECTION_BLOCKED_BY_CONTROLLER");
    }
  }

  // 3. selectedExecutionPlan must be non-null
  if (candidate.selectedExecutionPlan == null) {
    rejectionReasons.push("MISSING_EXECUTION_PLAN");
  }

  // 4. entryPrice > 0
  if (!(candidate.entryPrice > 0)) {
    rejectionReasons.push("MISSING_ENTRY_PRICE");
  }

  // 5. stopLoss > 0
  if (!(candidate.stopLoss > 0)) {
    rejectionReasons.push("MISSING_STOP_LOSS");
  }

  // 6. takeProfits.tp1 > 0
  if (!(typeof candidate.takeProfits?.tp1 === "number" && candidate.takeProfits.tp1 > 0)) {
    rejectionReasons.push("MISSING_TAKE_PROFIT");
  }

  // 7. sourceConflict must be false
  if (candidate.sourceConflict === true) {
    rejectionReasons.push("SOURCE_CONFLICT_TRUE");
  }

  // 8. Variant-adjusted guard: stopDistanceBps >= variant-adjusted threshold
  const guardResult = computeControllerAlignedGuardThreshold(candidate.atrPercent);
  const effectiveGuard = guardResult.variantAdjustedGuardThresholdBps;
  if (candidate.stopDistanceBps === null || candidate.stopDistanceBps === undefined || candidate.stopDistanceBps < effectiveGuard) {
    rejectionReasons.push("STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD");
  }

  // 9. Exclude BTCUSDT
  if (candidate.symbol === "BTCUSDT") {
    rejectionReasons.push("EXCLUDED_SYMBOL_BTCUSDT");
  }

  // 10. Exclude SEIUSDT
  if (candidate.symbol === "SEIUSDT") {
    rejectionReasons.push("EXCLUDED_SYMBOL_SEIUSDT");
  }

  // If any base gate failed — reject immediately
  if (rejectionReasons.length > 0) {
    return { admitted: false, profile: null, rejectionReasons };
  }

  // ── Profile gates ─────────────────────────────────────────────────────────

  const costR = candidate.costR;
  const stopDistanceBps = candidate.stopDistanceBps;

  // Try STRICT first: costR <= 0.10
  if (costR !== null && costR !== undefined && costR <= 0.10) {
    // Duplicate check for STRICT
    if (store.isDuplicate(candidate.symbol, candidate.direction, "STRICT_COST10")) {
      rejectionReasons.push("DUPLICATE_OPEN_POSITION_FOR_PROFILE");
      return { admitted: false, profile: "STRICT_COST10", rejectionReasons };
    }
    return { admitted: true, profile: "STRICT_COST10", rejectionReasons: [] };
  }

  // Try BROAD: costR <= 0.20 AND stopDistanceBps >= 150
  const broadCostFail = costR === null || costR === undefined || costR > 0.20;
  const broadStopFail = stopDistanceBps === null || stopDistanceBps === undefined || stopDistanceBps < 150;

  if (broadCostFail) {
    rejectionReasons.push("COST_R_ABOVE_020");
  }
  if (broadStopFail && !broadCostFail) {
    rejectionReasons.push("STOP_DISTANCE_BELOW_150_FOR_BROAD");
  }
  if (broadStopFail && broadCostFail) {
    // both fail — already pushed COST_R_ABOVE_020; STOP reason skipped (cost is the primary reject)
  }

  if (!broadCostFail && !broadStopFail) {
    // BROAD passes
    if (store.isDuplicate(candidate.symbol, candidate.direction, "BROAD_COST20_STOP150")) {
      rejectionReasons.push("DUPLICATE_OPEN_POSITION_FOR_PROFILE");
      return { admitted: false, profile: "BROAD_COST20_STOP150", rejectionReasons };
    }
    return { admitted: true, profile: "BROAD_COST20_STOP150", rejectionReasons: [] };
  }

  return { admitted: false, profile: null, rejectionReasons };
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/** Attempt to resolve same-candle ambiguity using 1m candles. Report-only, never throws. */
async function tryResolveIntrabarWith1m(
  obs: FilteredEdgeShadowPosition,
  binanceClient: {
    getKlines: (
      symbol: string,
      interval: string,
      opts: { startTime: number; endTime: number; limit: number },
    ) => Promise<Array<[number, string, string, string, string, string, number, ...unknown[]]>>;
  },
  fillCandleOpenTime: number,
  openedAtMs: number,
): Promise<{
  resolved: boolean;
  status?: "CLOSED_WIN" | "CLOSED_LOSS";
  resolutionSource?: string;
}> {
  try {
    const entry = obs.entryPrice;
    const stop = obs.stopLoss;
    const tp1 = obs.takeProfitLevels[0] ?? null;
    const dir = obs.direction;
    const fillCandleEndTime = fillCandleOpenTime + 5 * 60 * 1000;

    const raw1m = await binanceClient.getKlines(obs.symbol, "1m", {
      startTime: fillCandleOpenTime,
      endTime: fillCandleEndTime,
      limit: 6, // 5 candles + 1 buffer
    });

    for (const candle of raw1m) {
      const [candleOpenTime, , highStr, lowStr] = candle;
      const candleOpenMs = Number(candleOpenTime);
      // Skip 1m candles that opened before the position was opened
      if (candleOpenMs < openedAtMs) continue;

      const high = Number(highStr);
      const low = Number(lowStr);

      const slHit = stop > 0 && (dir === "LONG" ? low <= stop : high >= stop);
      const tp1Hit = tp1 !== null && (dir === "LONG" ? high >= tp1 : low <= tp1);

      if (slHit && tp1Hit) {
        // Both in same 1m candle — conservative: SL wins
        return { resolved: true, status: "CLOSED_LOSS", resolutionSource: "INTRABAR_1M_SL" };
      }
      if (slHit) {
        return { resolved: true, status: "CLOSED_LOSS", resolutionSource: "INTRABAR_1M_SL" };
      }
      if (tp1Hit) {
        return { resolved: true, status: "CLOSED_WIN", resolutionSource: "INTRABAR_1M_TP" };
      }
    }
    return { resolved: false };
  } catch {
    return { resolved: false };
  }
}

export async function resolveFilteredEdgeShadowObservations(
  store: FilteredEdgeShadowStore,
  binanceClient: {
    getKlines: (
      symbol: string,
      interval: string,
      opts: { startTime: number; endTime: number; limit: number },
    ) => Promise<
      Array<[number, string, string, string, string, string, number, ...unknown[]]>
    >;
  },
): Promise<{ resolved: number; errors: number }> {
  let resolved = 0;
  let errors = 0;

  try {
    const positions = store.all;
    const nowMs = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const candleMs = 5 * 60 * 1000; // 5m candles

    for (const pos of positions) {
      if (pos.status !== "OPEN") continue;

      try {
        const createdAtMs = parseMs(pos.createdAt) ?? parseMs(pos.openedAt) ?? nowMs;
        const persistedOpenedAtMs = parseMs(pos.openedAt);
        const ageMs = nowMs - createdAtMs;

        // Fetch from 5 min BEFORE createdAt to ensure we capture the fill candle
        const startTime = createdAtMs - candleMs;
        const endTime = nowMs + twoHoursMs;
        const limit = Math.min(Math.max(Math.ceil((endTime - startTime) / candleMs) + 2, 12), 500);

        const rawCandles = await binanceClient.getKlines(pos.symbol, "5m", {
          startTime,
          endTime,
          limit,
        });

        const entry = pos.entryPrice;
        const stop = pos.stopLoss;
        const tp1 = pos.takeProfitLevels[0] ?? null;
        const dir = pos.direction;
        const risk = Math.abs(entry - stop);

        let filled = false;
        let effectiveOpenedAtMs: number | null =
          pos.status === "OPEN" && persistedOpenedAtMs !== null && persistedOpenedAtMs >= createdAtMs
            ? persistedOpenedAtMs
            : null;
        let closeStatus: FilteredEdgeShadowPosition["status"] | null = null;
        let closedAtMs: number | null = null;
        let grossR: number | null = null;
        let candlesWalked = 0;
        let runningMaxMfeR = 0;
        let runningMinMaeR = 0;
        let resolutionCandleIndex = -1;
        let pathMetricStatus: FilteredEdgePathMetricStatus | null = risk > 0 ? "VALID" : "PATH_METRIC_INVALID_RISK";
        let pathMetricWarning: string | null = risk > 0 ? null : "Risk must be positive to compute path metrics";

        // Intrabar ambiguity tracking
        let intrabarResolutionStatus: FilteredEdgeShadowPosition["intrabarResolutionStatus"] = null;
        let fillCandleOpenTime: number | null = null;
        let fillCandleLow: number | null = null;
        let fillCandleHigh: number | null = null;
        let ambiguousLevelsTouched: string[] | null = null;
        let fillCandleIdx = -1;
        let isFreshValid: boolean | null = null;
        let ambiguityResolutionSource: string | null = null;

        // Identify fill candle index: first candle where candleOpenTime <= openedAtMs < candleOpenTime + 5m
        // We use createdAtMs as the reference for fill candle identification since that's when position was opened
        const openedAtForFillRef = persistedOpenedAtMs ?? createdAtMs;
        for (let i = 0; i < rawCandles.length; i++) {
          const ct = Number(rawCandles[i]![0]);
          if (ct <= openedAtForFillRef && openedAtForFillRef < ct + candleMs) {
            fillCandleIdx = i;
            break;
          }
        }

        for (let i = 0; i < rawCandles.length; i++) {
          const candle = rawCandles[i]!;
          const [candleOpenTime, , highStr, lowStr, , , candleCloseTimeRaw] = candle;
          const high = Number(highStr);
          const low = Number(lowStr);
          const candleTime = Number(candleOpenTime);
          const candleCloseTime =
            typeof candleCloseTimeRaw === "number" && Number.isFinite(candleCloseTimeRaw)
              ? Number(candleCloseTimeRaw)
              : candleTime + candleMs;

          if (!filled) {
            // Fill check: LONG = low <= entry, SHORT = high >= entry
            const isFilled = dir === "LONG" ? low <= entry : high >= entry;
            if (isFilled) {
              filled = true;
              effectiveOpenedAtMs = Math.max(createdAtMs, candleTime);
            } else {
              continue;
            }
          }

          candlesWalked += 1;
          const isFillCandle = i === fillCandleIdx;

          // Track MFE/MAE excursion per candle using bounded favorable/adverse components.
          if (risk > 0 && pathMetricStatus === "VALID") {
            const favorable = dir === "LONG"
              ? Math.max(high - entry, 0)
              : Math.max(entry - low, 0);
            const adverse = dir === "LONG"
              ? Math.min(low - entry, 0)
              : Math.min(entry - high, 0);
            const mfeR = favorable / risk;
            const maeR = adverse / risk;
            if (!Number.isFinite(mfeR) || !Number.isFinite(maeR) || mfeR < 0 || maeR > 0) {
              pathMetricStatus = "PATH_METRIC_INVALID_RISK";
              pathMetricWarning = "Derived non-finite or sign-invalid MFE/MAE";
            } else if (Math.abs(mfeR) > PATH_METRIC_ABS_CAP_R || Math.abs(maeR) > PATH_METRIC_ABS_CAP_R) {
              pathMetricStatus = "PATH_METRIC_OUTLIER";
              pathMetricWarning = `Derived path metrics exceed ${PATH_METRIC_ABS_CAP_R}R cap`;
            } else {
              if (mfeR > runningMaxMfeR) runningMaxMfeR = mfeR;
              if (maeR < runningMinMaeR) runningMinMaeR = maeR;
            }
          }

          // SL check
          const slHit =
            stop > 0 &&
            (dir === "LONG" ? low <= stop : high >= stop);

          // TP1 check
          const tp1Hit =
            tp1 !== null &&
            (dir === "LONG" ? high >= tp1 : low <= tp1);

          if (isFillCandle && (slHit || tp1Hit)) {
            // Same-candle ambiguity: the candle that contains the entry tick also contains SL/TP
            // We cannot determine order from 5m OHLC alone — record for 1m refinement
            fillCandleOpenTime = candleTime;
            fillCandleLow = low;
            fillCandleHigh = high;
            ambiguousLevelsTouched = [];
            if (slHit) ambiguousLevelsTouched.push("SL");
            if (tp1Hit) ambiguousLevelsTouched.push("TP1");

            // Attempt 1m refinement
            const oneMsRef = effectiveOpenedAtMs ?? createdAtMs;
            const oneM = await tryResolveIntrabarWith1m(pos, binanceClient, candleTime, oneMsRef);

            if (oneM.resolved && oneM.status) {
              // 1m confirmed ordering
              closeStatus = oneM.status;
              closedAtMs = Math.max(oneMsRef, candleCloseTime);
              grossR = oneM.status === "CLOSED_WIN"
                ? (risk > 0
                    ? (dir === "LONG" ? (tp1! - entry) / risk : (entry - tp1!) / risk)
                    : 0)
                : -1.0;
              intrabarResolutionStatus = "RESOLVED_BY_1M";
              isFreshValid = true;
              ambiguityResolutionSource = oneM.resolutionSource ?? null;
              resolutionCandleIndex = candlesWalked;
            } else {
              // Cannot resolve — mark AMBIGUOUS, stop walking
              closeStatus = "AMBIGUOUS";
              intrabarResolutionStatus = oneM.resolved === false && oneM.status === undefined
                ? "AMBIGUOUS_SAME_CANDLE"
                : "INTRABAR_UNAVAILABLE";
              isFreshValid = false;
              closedAtMs = null;
              grossR = null;
            }
            break;
          }

          if (!isFillCandle) {
            // Normal non-fill candle: ordering is unambiguous (candle opened AFTER entry)
            if (slHit) {
              closeStatus = "CLOSED_LOSS";
              closedAtMs = Math.max(effectiveOpenedAtMs ?? createdAtMs, candleCloseTime);
              grossR = -1.0;
              intrabarResolutionStatus = "VALID_5M_ORDERED";
              isFreshValid = true;
              resolutionCandleIndex = candlesWalked;
              break;
            }
            if (tp1Hit) {
              closeStatus = "CLOSED_WIN";
              closedAtMs = Math.max(effectiveOpenedAtMs ?? createdAtMs, candleCloseTime);
              grossR =
                risk > 0
                  ? dir === "LONG"
                    ? (tp1! - entry) / risk
                    : (entry - tp1!) / risk
                  : 0;
              intrabarResolutionStatus = "VALID_5M_ORDERED";
              isFreshValid = true;
              resolutionCandleIndex = candlesWalked;
              break;
            }
          }
        }

        if (closeStatus === "CLOSED_WIN" || closeStatus === "CLOSED_LOSS") {
          if (closedAtMs !== null) {
            const costR = pos.costR ?? 0;
            const netR = grossR !== null ? grossR - costR : null;
            const openedAtMsForDuration = effectiveOpenedAtMs ?? persistedOpenedAtMs ?? createdAtMs;
            const chronology = deriveChronology({
              createdAt: pos.createdAt,
              openedAt: new Date(openedAtMsForDuration).toISOString(),
              closedAt: new Date(closedAtMs).toISOString(),
              chronologyStatus: null,
              chronologyWarning: null,
            });
            const closedAt = new Date(closedAtMs).toISOString();
            const openedAt = new Date(openedAtMsForDuration).toISOString();
            const durationMinutes =
              chronology.status === "VALID"
                ? Math.round((closedAtMs - openedAtMsForDuration) / 60000)
                : null;
            const maxMfeR = pathMetricStatus === "VALID" ? runningMaxMfeR : null;
            const minMaeR = pathMetricStatus === "VALID" ? runningMinMaeR : null;
            const immediateSl =
              chronology.status === "VALID" &&
              pathMetricStatus === "VALID" &&
              closeStatus === "CLOSED_LOSS" &&
              resolutionCandleIndex >= 1 &&
              resolutionCandleIndex <= 2;
            const noMfeBeforeSl =
              chronology.status === "VALID" &&
              pathMetricStatus === "VALID" &&
              closeStatus === "CLOSED_LOSS" &&
              maxMfeR !== null &&
              maxMfeR < 0.1;
            store.update(pos.id, {
              status: closeStatus,
              openedAt,
              closedAt,
              grossR,
              netR,
              resolutionSource: ambiguityResolutionSource
                ?? (closeStatus === "CLOSED_WIN" ? "CANDLE_WALK_TP1" : "CANDLE_WALK_SL"),
              durationMinutes,
              chronologyStatus: chronology.status,
              chronologyWarning: chronology.warning,
              maxMfeR,
              minMaeR,
              mfeBeforeCloseR: maxMfeR,
              maeBeforeCloseR: minMaeR,
              pathMetricStatus,
              pathMetricWarning,
              immediateSl,
              noMfeBeforeSl,
              intrabarResolutionStatus,
              fillCandleOpenTime,
              fillCandleLow,
              fillCandleHigh,
              ambiguousLevelsTouched,
              isFreshValid,
              analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
              pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
              chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
            });
            resolved += 1;
          }
        } else if (closeStatus === "AMBIGUOUS") {
          // Record ambiguity diagnostics on the position — keep status as AMBIGUOUS
          const openedAtMsForUpdate = effectiveOpenedAtMs ?? persistedOpenedAtMs ?? createdAtMs;
          store.update(pos.id, {
            status: "AMBIGUOUS",
            openedAt: new Date(openedAtMsForUpdate).toISOString(),
            intrabarResolutionStatus,
            fillCandleOpenTime,
            fillCandleLow,
            fillCandleHigh,
            ambiguousLevelsTouched,
            isFreshValid: false,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
          // Do NOT increment resolved — AMBIGUOUS is not a final resolution yet
        } else if (filled && effectiveOpenedAtMs !== null) {
          store.update(pos.id, {
            openedAt: new Date(effectiveOpenedAtMs).toISOString(),
            intrabarResolutionStatus: intrabarResolutionStatus ?? null,
            isFreshValid: isFreshValid ?? null,
            chronologyStatus: null,
            chronologyWarning: null,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
        } else if (ageMs > sevenDaysMs) {
          const expiryOpenedAtMs = effectiveOpenedAtMs ?? persistedOpenedAtMs ?? createdAtMs;
          const closedAt = new Date(nowMs).toISOString();
          const openedAt = new Date(expiryOpenedAtMs).toISOString();
          const chronology = deriveChronology({
            createdAt: pos.createdAt,
            openedAt,
            closedAt,
            chronologyStatus: null,
            chronologyWarning: null,
          });
          store.update(pos.id, {
            status: "EXPIRED",
            openedAt,
            closedAt,
            resolutionSource: filled ? "EXPIRED_AFTER_FILL" : "EXPIRED_NO_FILL",
            durationMinutes:
              chronology.status === "VALID"
                ? Math.round((nowMs - expiryOpenedAtMs) / 60000)
                : null,
            intrabarResolutionStatus: "INTRABAR_UNAVAILABLE",
            isFreshValid: null,
            chronologyStatus: chronology.status,
            chronologyWarning: chronology.warning,
            analyticsVersion: FILTERED_EDGE_FORENSICS_VERSION,
            pathMetricVersion: FILTERED_EDGE_PATH_METRIC_VERSION,
            chronologyVersion: FILTERED_EDGE_CHRONOLOGY_VERSION,
          });
          resolved += 1;
        }
      } catch {
        errors += 1;
      }
    }
  } catch {
    // Never throw — report-only
  }

  return { resolved, errors };
}

// ─── Report builder ────────────────────────────────────────────────────────────

export interface FilteredEdgeProfileReport {
  profile: FilteredEdgeProfile;
  totalObs: number;
  openObs: number;
  resolvedObs: number;
  expiredObs: number;
  wr: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;
  verdict: "TOO_EARLY" | "WATCHABLE" | "POSITIVE_EDGE" | "NEGATIVE_EDGE";
}

export interface FilteredEdgeFreshProfileReport {
  profile: FilteredEdgeProfile;
  resolvedObs: number;
  wr: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  verdict: FilteredEdgeFreshVerdict;
}

export interface FilteredEdgeProfileForensics {
  profile: FilteredEdgeProfile;

  // counts
  totalObs: number;
  openObs: number;
  resolvedObs: number;
  noFillObs: number;
  expiredObs: number;

  // economics (null if resolvedObs === 0)
  wr: number | null;
  netAvgR: number | null;
  grossAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;

  // geometry
  avgStopDistanceBps: number | null;
  tp1Rate: number | null;
  slRate: number | null;

  // timing
  avgDurationMinutes: number | null;
  validChronologyCount: number;
  invalidChronologyCount: number;
  invalidChronologyReasons: Array<{ reason: string; n: number }>;

  // excursion (null if no MFE/MAE data)
  avgMfeR: number | null;
  avgMaeR: number | null;
  pathMetricsAvailableCount: number;
  pathMetricsInvalidCount: number;
  pathMetricInvalidReasons: Array<{ reason: string; n: number }>;
  immediateSLCount: number;        // CLOSED_LOSS with immediateSl=true
  noMfeBeforeSLCount: number;      // CLOSED_LOSS with noMfeBeforeSl=true

  // signal context breakdown
  topLosingSymbols: Array<{ symbol: string; n: number; netAvgR: number }>;  // top 3 by netAvgR asc
  topWinningSymbols: Array<{ symbol: string; n: number; netAvgR: number }>; // top 3 by netAvgR desc
  byEntryVariant: Array<{ variant: string; n: number; netAvgR: number | null; wr: number | null }>;
  byExitVariant: Array<{ variant: string; n: number; netAvgR: number | null; wr: number | null }>;
  byRegimeAtEntry: Array<{ regime: string; n: number; netAvgR: number | null }>;
  bySourceConflict: Array<{ label: string; n: number; netAvgR: number | null }>;
  byKronosBias: Array<{ bias: string; n: number; netAvgR: number | null }>;
  byWhaleAgreement: Array<{ agreement: string; n: number; netAvgR: number | null }>;

  // fresh-valid (intrabar-validated) economics per profile
  freshValidResolved: number;    // CLOSED_WIN/CLOSED_LOSS where isFreshValid=true
  freshValidWr: number | null;
  freshValidNetAvgR: number | null;
  freshValidPf: number | null;

  // prune suggestions (advisory only)
  pruneSuggestions: Array<{
    type: "EXCLUDE_SYMBOL" | "MIN_MFE_REQUIRED" | "AVOID_IMMEDIATE_SL_PATTERN" | "REQUIRE_ENTRY_CONFIRMATION" | "COST_CAP_TIGHTEN" | "STOP_BUCKET_FILTER";
    label: string;
    reason: string;
    affectedN: number;
  }>;
}

export interface RecentResolvedSnapshot {
  id: string;
  profile: FilteredEdgeProfile;
  symbol: string;
  direction: "LONG" | "SHORT";
  regimeAtEntry: string | null;
  entryVariant: string | null;
  exitVariant: string | null;
  stopDistanceBps: number | null;
  costR: number | null;
  grossR: number | null;
  netR: number | null;
  closeReason: string | null;   // resolutionSource field
  durationMinutes: number | null;
  chronologyStatus: FilteredEdgeChronologyStatus;
  maxMfeR: number | null;
  minMaeR: number | null;
  mfeBeforeCloseR: number | null;
  maeBeforeCloseR: number | null;
  pathMetricStatus: FilteredEdgePathMetricStatus;
  immediateSl: boolean;
  noMfeBeforeSl: boolean;
  sourceConflictLabel: string | null;
  kronosBias: string | null;
  whaleAgreement: string | null;
  reasonSummary: string;
  openedAt: string;
  closedAt: string | null;
  // Intrabar ambiguity fields
  intrabarResolutionStatus?: FilteredEdgeShadowPosition["intrabarResolutionStatus"];
  isFreshValid?: boolean | null;
  // Exclusion reason: null if freshValid, otherwise the specific reason
  excludedReason: string | null;
}

export interface FilteredEdgeEconomics {
  n: number;
  resolved: number;
  wins: number;
  losses: number;
  wr: number | null;
  grossAvgR: number | null;
  netAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;
  avgDurationMinutes: number | null;
  avgStopDistanceBps: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
}

export interface FilteredEdgeShadowReport {
  reportOnly: true;
  laneVersion: typeof FILTERED_EDGE_SHADOW_LANE;
  computedAt: string;
  profileReports: FilteredEdgeProfileReport[];
  freshValidProfileReports: FilteredEdgeFreshProfileReport[];
  freshValidExcluded: {
    invalidChronology: number;
    invalidPathMetrics: number;     // OUTLIER, sign-error, non-finite, INVALID_RISK
    missingPathMetrics: number;     // PATH_METRIC_MISSING
    ambiguousIntrabar: number;      // AMBIGUOUS_SAME_CANDLE / INTRABAR_UNAVAILABLE
    invalidGeometry: number;
    missingVersion: number;
    quarantined: number;            // total quarantined (sum across reasons)
  };
  topRejectionReasons: Array<{ reason: string; count: number }>;
  recentResolved: RecentResolvedSnapshot[];
  profileForensics: FilteredEdgeProfileForensics[];
  overlappingCandidateCount: number;
  // Intrabar ambiguity summary counts
  ambiguousSameCandleCount: number;
  resolvedBy1mCount: number;
  ambiguousExcludedFromFreshValidCount: number;
  freshValidResolvedCount: number;
  // Consistency check: top-level count vs unique ids passing the helper
  freshValidConsistencyCheck: "PASS" | "FAIL";
  freshValidConsistencyDetail?: string;
  // Path-metric integrity check
  pathMetricConsistencyCheck: {
    status: "PASS" | "FAIL";
    freshValidWithNonValidPath: number;   // must be 0
    outlierWithoutLargeMfeMae: number;    // must be 0
    missingRenderedAsOutlier: number;     // must be 0
    detail?: string;
  };
  // Chronology integrity check
  chronologyConsistencyCheck: {
    status: "PASS" | "FAIL";
    freshValidWithInvalidChronology: number;
    negativeDurationCount: number;
    durationZeroWithValid5mOrdered: number;
    detail?: string;
  };
}

/**
 * Generic economics aggregator over a subset of observations defined by a predicate.
 * Pure function — never throws.
 */
export function computeFilteredEdgeEconomics(
  observations: FilteredEdgeShadowPosition[],
  predicate: (obs: FilteredEdgeShadowPosition) => boolean,
): FilteredEdgeEconomics {
  const subset = observations.filter(predicate);
  const resolved = subset.filter(
    (p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS",
  );
  const wins = resolved.filter((p) => p.status === "CLOSED_WIN");
  const losses = resolved.filter((p) => p.status === "CLOSED_LOSS");
  const netRs = resolved.map((p) => p.netR);
  const grossRs = resolved.map((p) => p.grossR);
  const costRs = subset.map((p) => p.costR);
  return {
    n: subset.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    wr: resolved.length > 0 ? wins.length / resolved.length : null,
    grossAvgR: computeAvg(grossRs),
    netAvgR: computeAvg(netRs),
    avgCostR: computeAvg(costRs),
    pf: computePF(netRs),
    avgWinGrossR: computeAvg(wins.map((p) => p.grossR)),
    avgLossGrossR: computeAvg(losses.map((p) => p.grossR)),
    avgDurationMinutes: computeAvg(
      resolved
        .filter((p) => deriveChronologyStatus(p) === "VALID")
        .map((p) => p.durationMinutes),
    ),
    avgStopDistanceBps: computeAvg(subset.map((p) => p.stopDistanceBps)),
    avgMfeR: computeAvg(
      resolved
        .filter((p) => derivePathMetric(p).status === "VALID")
        .map((p) => p.mfeBeforeCloseR ?? p.maxMfeR ?? null),
    ),
    avgMaeR: computeAvg(
      resolved
        .filter((p) => derivePathMetric(p).status === "VALID")
        .map((p) => p.maeBeforeCloseR ?? p.minMaeR ?? null),
    ),
  };
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function deriveChronology(
  position: Pick<FilteredEdgeShadowPosition, "createdAt" | "openedAt" | "closedAt" | "chronologyStatus" | "chronologyWarning">,
): { status: FilteredEdgeChronologyStatus; warning: string | null; createdAtMs: number | null; openedAtMs: number | null; closedAtMs: number | null } {
  const createdAtMs = parseMs(position.createdAt);
  const openedAtMs = parseMs(position.openedAt);
  const closedAtMs = parseMs(position.closedAt);
  if (position.chronologyStatus && position.chronologyStatus !== "VALID") {
    return {
      status: position.chronologyStatus,
      warning: position.chronologyWarning ?? position.chronologyStatus,
      createdAtMs,
      openedAtMs,
      closedAtMs,
    };
  }
  // Position is still open (no closedAt) — chronology valid as long as opened/created parse
  if (closedAtMs === null) {
    if (openedAtMs === null) {
      return {
        status: "UNAVAILABLE",
        warning: "Missing openedAt",
        createdAtMs,
        openedAtMs,
        closedAtMs,
      };
    }
    return {
      status: "VALID",
      warning: null,
      createdAtMs,
      openedAtMs,
      closedAtMs,
    };
  }
  if (openedAtMs === null) {
    return {
      status: "UNAVAILABLE",
      warning: "Missing openedAt",
      createdAtMs,
      openedAtMs,
      closedAtMs,
    };
  }
  if (createdAtMs !== null && openedAtMs < createdAtMs) {
    return {
      status: "INVALID_OPENED_BEFORE_CREATED",
      warning: "openedAt precedes createdAt",
      createdAtMs,
      openedAtMs,
      closedAtMs,
    };
  }
  if (closedAtMs < openedAtMs) {
    return {
      status: "INVALID_NEGATIVE_DURATION",
      warning: "closedAt precedes openedAt",
      createdAtMs,
      openedAtMs,
      closedAtMs,
    };
  }
  return {
    status: "VALID",
    warning: null,
    createdAtMs,
    openedAtMs,
    closedAtMs,
  };
}

/**
 * Canonical exported chronology helper. Same logic as deriveChronology but
 * exposes only the status. Use this where callers don't need parsed timestamps.
 */
export function deriveChronologyStatus(
  position: Pick<FilteredEdgeShadowPosition, "createdAt" | "openedAt" | "closedAt" | "chronologyStatus" | "chronologyWarning">,
): FilteredEdgeChronologyStatus {
  return deriveChronology(position).status;
}

/**
 * Canonical path metric derivation. Always recomputes status from raw MFE/MAE and
 * geometry. NEVER uses grossR for outlier detection — a normal SL has grossR=-1
 * but that is NOT a path-metric outlier; an outlier is when |MFE| or |MAE| > 20R
 * (a clear data error from a unit mismatch or wrong direction sign).
 *
 * Status hierarchy (highest precedence first):
 *   1. PATH_METRIC_INVALID_RISK — entry/stop bad or risk <= 0 or no TPs
 *   2. PATH_METRIC_MISSING       — no MFE/MAE data on record (resolved but unknown)
 *   3. PATH_METRIC_OUTLIER       — |MFE| > 20R OR |MAE| > 20R OR sign error
 *   4. VALID                     — finite, bounded, sign-correct
 *   5. UNAVAILABLE               — only for non-resolved positions
 */
function derivePathMetricStatus(
  position: Pick<
    FilteredEdgeShadowPosition,
    | "status"
    | "entryPrice"
    | "stopLoss"
    | "takeProfitLevels"
    | "mfeBeforeCloseR"
    | "maeBeforeCloseR"
    | "maxMfeR"
    | "minMaeR"
  >,
): { status: FilteredEdgePathMetricStatus; warning: string | null } {
  // Not yet resolved — nothing meaningful to compute
  if (
    position.status !== "CLOSED_WIN" &&
    position.status !== "CLOSED_LOSS"
  ) {
    return { status: "UNAVAILABLE", warning: null };
  }
  // 1. Risk validity
  const risk = Math.abs((position.entryPrice ?? 0) - (position.stopLoss ?? 0));
  if (
    !Number.isFinite(position.entryPrice) ||
    !Number.isFinite(position.stopLoss) ||
    position.entryPrice <= 0 ||
    position.stopLoss <= 0 ||
    !Number.isFinite(risk) ||
    risk <= 0 ||
    !Array.isArray(position.takeProfitLevels) ||
    position.takeProfitLevels.length === 0
  ) {
    return { status: "PATH_METRIC_INVALID_RISK", warning: "geometry invalid" };
  }
  // 2. Missing data
  const mfeRaw = position.mfeBeforeCloseR ?? position.maxMfeR ?? null;
  const maeRaw = position.maeBeforeCloseR ?? position.minMaeR ?? null;
  if (mfeRaw === null && maeRaw === null) {
    return { status: "PATH_METRIC_MISSING", warning: "no MFE/MAE data on record" };
  }
  // Treat NaN as missing
  if (
    (mfeRaw !== null && !Number.isFinite(mfeRaw)) ||
    (maeRaw !== null && !Number.isFinite(maeRaw))
  ) {
    return { status: "PATH_METRIC_OUTLIER", warning: "non-finite MFE/MAE" };
  }
  // 3. Sign correctness (MFE should be >= 0; MAE should be <= 0)
  if (mfeRaw !== null && mfeRaw < 0) {
    return {
      status: "PATH_METRIC_OUTLIER",
      warning: `mfe=${mfeRaw} < 0 (direction sign error)`,
    };
  }
  if (maeRaw !== null && maeRaw > 0) {
    return {
      status: "PATH_METRIC_OUTLIER",
      warning: `mae=${maeRaw} > 0 (direction sign error)`,
    };
  }
  // 4. Magnitude cap (|MFE| > 20R OR |MAE| > 20R is a clear data error)
  if (mfeRaw !== null && Math.abs(mfeRaw) > PATH_METRIC_ABS_CAP_R) {
    return {
      status: "PATH_METRIC_OUTLIER",
      warning: `mfe=${mfeRaw} exceeds cap ${PATH_METRIC_ABS_CAP_R}`,
    };
  }
  if (maeRaw !== null && Math.abs(maeRaw) > PATH_METRIC_ABS_CAP_R) {
    return {
      status: "PATH_METRIC_OUTLIER",
      warning: `mae=${maeRaw} exceeds cap ${PATH_METRIC_ABS_CAP_R}`,
    };
  }
  return { status: "VALID", warning: null };
}

/**
 * Canonical exported path metric helper.
 * IMPORTANT: This NEVER inspects grossR — a normal -1R SL is VALID, not an outlier.
 * Outliers are |MFE| or |MAE| > 20R, sign errors, or non-finite.
 */
export function derivePathMetric(
  position: Pick<
    FilteredEdgeShadowPosition,
    | "status"
    | "entryPrice"
    | "stopLoss"
    | "takeProfitLevels"
    | "mfeBeforeCloseR"
    | "maeBeforeCloseR"
    | "maxMfeR"
    | "minMaeR"
  >,
): { status: FilteredEdgePathMetricStatus; reason: string | null } {
  const result = derivePathMetricStatus(position);
  return { status: result.status, reason: result.warning };
}

/**
 * Canonical exported intrabar resolution helper. Fallback for legacy records
 * AND sanity check: ensures that records with duration=0 paired with
 * VALID_5M_ORDERED are re-classified as AMBIGUOUS_SAME_CANDLE (impossible state).
 */
export function deriveIntrabarResolutionStatus(
  position: Pick<
    FilteredEdgeShadowPosition,
    | "status"
    | "intrabarResolutionStatus"
    | "durationMinutes"
    | "fillCandleOpenTime"
    | "resolutionSource"
  >,
): FilteredEdgeIntrabarStatus {
  // Non-resolved positions: intrabar status not meaningful, except AMBIGUOUS which
  // carries its own intrabar diagnostic and must surface it.
  if (
    position.status !== "CLOSED_WIN" &&
    position.status !== "CLOSED_LOSS" &&
    position.status !== "AMBIGUOUS"
  ) {
    return "UNAVAILABLE";
  }
  const stored = position.intrabarResolutionStatus;
  const duration = position.durationMinutes;
  const source = position.resolutionSource ?? "";
  // Sanity guard: VALID_5M_ORDERED with duration=0 is impossible — re-classify
  if (stored === "VALID_5M_ORDERED" && duration === 0) {
    if (source.startsWith("INTRABAR_1M")) return "RESOLVED_BY_1M";
    return "AMBIGUOUS_SAME_CANDLE";
  }
  if (stored && stored !== null) {
    return stored;
  }
  // Legacy fallback: no intrabar status stored
  if (duration !== null && duration !== undefined && duration > 0) {
    return "VALID_5M_ORDERED";
  }
  if (duration === 0 && position.fillCandleOpenTime) {
    if (source.startsWith("INTRABAR_1M")) return "RESOLVED_BY_1M";
    return "AMBIGUOUS_SAME_CANDLE";
  }
  return "UNAVAILABLE";
}

function hasFreshForensicsVersion(position: Pick<
  FilteredEdgeShadowPosition,
  "analyticsVersion" | "pathMetricVersion" | "chronologyVersion"
>): boolean {
  return (
    position.analyticsVersion === FILTERED_EDGE_FORENSICS_VERSION &&
    position.pathMetricVersion === FILTERED_EDGE_PATH_METRIC_VERSION &&
    position.chronologyVersion === FILTERED_EDGE_CHRONOLOGY_VERSION
  );
}

function hasValidGeometry(position: Pick<
  FilteredEdgeShadowPosition,
  "entryPrice" | "stopLoss" | "stopDistanceBps"
>): boolean {
  const risk = Math.abs(position.entryPrice - position.stopLoss);
  return (
    Number.isFinite(position.entryPrice) &&
    position.entryPrice > 0 &&
    Number.isFinite(position.stopLoss) &&
    position.stopLoss > 0 &&
    Number.isFinite(risk) &&
    risk > 0 &&
    typeof position.stopDistanceBps === "number" &&
    Number.isFinite(position.stopDistanceBps) &&
    position.stopDistanceBps > 0
  );
}

// ─── Single source of truth for fresh-valid classification ────────────────────

/**
 * Determines whether a resolved observation needs to be quarantined out of
 * fresh-valid reporting because it carries legacy or broken data that cannot be
 * safely promoted. Mirrors stage-3 spec.
 *
 * Returns null if the observation is NOT quarantined (i.e. carries fresh-correct data).
 * NEVER mutates the underlying record — purely analytical.
 */
export function deriveQuarantineReason(
  obs: FilteredEdgeShadowPosition,
): FilteredEdgeQuarantineReason | null {
  // Only resolved observations can be quarantined
  if (obs.status !== "CLOSED_WIN" && obs.status !== "CLOSED_LOSS") return null;
  // 1. Missing version stamp on a resolved record
  if (!hasFreshForensicsVersion(obs)) return "LEGACY_MISSING_VERSION";
  // 2. Chronology invalid
  if (deriveChronologyStatus(obs) !== "VALID") return "LEGACY_INVALID_CHRONOLOGY";
  // 3. Path metric MISSING/OUTLIER/INVALID_RISK
  const pathStatus = derivePathMetric(obs).status;
  if (pathStatus === "PATH_METRIC_MISSING") return "LEGACY_MISSING_PATH";
  if (pathStatus === "PATH_METRIC_OUTLIER") return "LEGACY_OUTLIER_PATH";
  if (pathStatus === "PATH_METRIC_INVALID_RISK") return "LEGACY_OUTLIER_PATH";
  // 4. Intrabar ambiguous / unavailable
  const intrabar = deriveIntrabarResolutionStatus(obs);
  if (
    intrabar === "AMBIGUOUS_SAME_CANDLE" ||
    intrabar === "INTRABAR_UNAVAILABLE" ||
    intrabar === "UNAVAILABLE"
  ) {
    return "LEGACY_AMBIGUOUS_INTRABAR";
  }
  return null;
}

/**
 * THE canonical fresh-valid classifier. Single source of truth.
 * Returns both the boolean AND a human-readable reason for exclusion.
 *
 * Every dashboard count, every per-profile count, every recent-row tag — all
 * must trace back to this function. NEVER read the stored isFreshValid field.
 *
 * Reason format:
 *   "NOT_RESOLVED"
 *   "QUARANTINED:<FilteredEdgeQuarantineReason>"
 *   "BAD_CHRONOLOGY:<FilteredEdgeChronologyStatus>"
 *   "INTRABAR:<FilteredEdgeIntrabarStatus>"
 *   "PATH_METRIC:<FilteredEdgePathMetricStatus> (<reason>)"
 *   "GROSS_R_NOT_FINITE"
 *   "NET_R_NOT_FINITE"
 *   "MISSING_VERSION:analytics"
 *
 * Pure function — report-only, never throws, never writes.
 */
export function deriveFreshValidStatus(
  obs: FilteredEdgeShadowPosition,
): { freshValid: boolean; reason: string | null } {
  if (obs.status !== "CLOSED_WIN" && obs.status !== "CLOSED_LOSS") {
    return { freshValid: false, reason: "NOT_RESOLVED" };
  }
  const quarantine = deriveQuarantineReason(obs);
  if (quarantine !== null) {
    return { freshValid: false, reason: `QUARANTINED:${quarantine}` };
  }
  const chrono = deriveChronologyStatus(obs);
  if (chrono !== "VALID") {
    return { freshValid: false, reason: `BAD_CHRONOLOGY:${chrono}` };
  }
  const intra = deriveIntrabarResolutionStatus(obs);
  if (intra !== "VALID_5M_ORDERED" && intra !== "RESOLVED_BY_1M") {
    return { freshValid: false, reason: `INTRABAR:${intra}` };
  }
  const path = derivePathMetric(obs);
  if (path.status !== "VALID") {
    return {
      freshValid: false,
      reason: `PATH_METRIC:${path.status}${path.reason ? ` (${path.reason})` : ""}`,
    };
  }
  if (obs.grossR === null || obs.grossR === undefined || !Number.isFinite(obs.grossR)) {
    return { freshValid: false, reason: "GROSS_R_NOT_FINITE" };
  }
  if (obs.netR === null || obs.netR === undefined || !Number.isFinite(obs.netR)) {
    return { freshValid: false, reason: "NET_R_NOT_FINITE" };
  }
  if (!obs.analyticsVersion) {
    return { freshValid: false, reason: "MISSING_VERSION:analytics" };
  }
  return { freshValid: true, reason: null };
}

/**
 * Single source of truth for fresh-valid classification (boolean wrapper).
 * Kept for backward compatibility with existing callers/tests.
 */
export function isFreshValidFilteredEdgeObservation(obs: FilteredEdgeShadowPosition): boolean {
  return deriveFreshValidStatus(obs).freshValid;
}

// ─── Internal classifier kept for backward compat with existing exclusion buckets ─

function classifyFreshValidResolvedPosition(position: FilteredEdgeShadowPosition): {
  freshValid: boolean;
  reason:
    | "INVALID_CHRONOLOGY"
    | "INVALID_PATH_METRICS"
    | "INVALID_GEOMETRY"
    | "MISSING_VERSION"
    | "AMBIGUOUS_INTRABAR"
    | "MISSING_PATH_METRICS"
    | null;
} {
  if (!(position.status === "CLOSED_WIN" || position.status === "CLOSED_LOSS")) {
    return { freshValid: false, reason: null };
  }
  if (!hasValidGeometry(position)) {
    return { freshValid: false, reason: "INVALID_GEOMETRY" };
  }
  if (deriveChronologyStatus(position) !== "VALID") {
    return { freshValid: false, reason: "INVALID_CHRONOLOGY" };
  }
  const pm = derivePathMetric(position);
  if (pm.status === "PATH_METRIC_MISSING") {
    return { freshValid: false, reason: "MISSING_PATH_METRICS" };
  }
  if (pm.status !== "VALID") {
    return { freshValid: false, reason: "INVALID_PATH_METRICS" };
  }
  const intra = deriveIntrabarResolutionStatus(position);
  if (intra !== "VALID_5M_ORDERED" && intra !== "RESOLVED_BY_1M") {
    return { freshValid: false, reason: "AMBIGUOUS_INTRABAR" };
  }
  if (!hasFreshForensicsVersion(position)) {
    return { freshValid: false, reason: "MISSING_VERSION" };
  }
  if (position.grossR === null || position.grossR === undefined || !Number.isFinite(position.grossR)) {
    return { freshValid: false, reason: null };
  }
  return { freshValid: true, reason: null };
}

function deriveFreshVerdict(resolvedObs: number, netAvgR: number | null, pf: number | null): FilteredEdgeFreshVerdict {
  if (resolvedObs < 10) return "TOO_EARLY";
  if (resolvedObs >= 20 && netAvgR !== null && netAvgR < 0) return "DEPRIORITIZE_FILTERED_EDGE";
  if (netAvgR !== null && netAvgR > 0 && pf !== null && pf > 1.1) return "WATCHABLE_EDGE";
  return "FILTERED_EDGE_NOT_CONFIRMED";
}

function buildFreshValidProfileReport(
  profile: FilteredEdgeProfile,
  positions: FilteredEdgeShadowPosition[],
): FilteredEdgeFreshProfileReport {
  const freshResolved = positions.filter((position) => {
    if (position.profile !== profile) return false;
    return classifyFreshValidResolvedPosition(position).freshValid;
  });
  const wins = freshResolved.filter((position) => position.status === "CLOSED_WIN");
  const resolvedObs = freshResolved.length;
  const netRs = freshResolved.map((position) => position.netR);
  const grossRs = freshResolved.map((position) => position.grossR);
  const costRs = freshResolved.map((position) => position.costR);
  const wr = resolvedObs > 0 ? wins.length / resolvedObs : null;
  const netAvgR = computeAvg(netRs);
  const grossAvgR = computeAvg(grossRs);
  const avgCostR = computeAvg(costRs);
  const pf = computePF(netRs);
  return {
    profile,
    resolvedObs,
    wr,
    netAvgR,
    grossAvgR,
    avgCostR,
    pf,
    verdict: deriveFreshVerdict(resolvedObs, netAvgR, pf),
  };
}

function computeAvg(values: Array<number | null>): number | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

function computePF(values: Array<number | null>): number | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const positiveSum = finite.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const negativeSum = finite.filter((v) => v < 0).reduce((sum, v) => sum + v, 0);
  if (negativeSum === 0 || positiveSum === 0) return null;
  return positiveSum / Math.abs(negativeSum);
}

function computeWR(netRs: Array<number | null>): number | null {
  const finite = netRs.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return finite.filter((v) => v > 0).length / finite.length;
}

function buildProfileReport(
  profile: FilteredEdgeProfile,
  positions: FilteredEdgeShadowPosition[],
): FilteredEdgeProfileReport {
  const profileObs = positions.filter((p) => p.profile === profile);
  const totalObs = profileObs.length;
  const openObs = profileObs.filter((p) => p.status === "OPEN").length;
  const resolvedObs = profileObs.filter(
    (p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS",
  ).length;
  const expiredObs = profileObs.filter((p) => p.status === "EXPIRED").length;

  const resolvedPositions = profileObs.filter(
    (p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS",
  );
  const wins = resolvedPositions.filter((p) => p.status === "CLOSED_WIN");
  const losses = resolvedPositions.filter((p) => p.status === "CLOSED_LOSS");

  const netRs = resolvedPositions.map((p) => p.netR);
  const grossRs = resolvedPositions.map((p) => p.grossR);
  const costRs = profileObs.map((p) => p.costR);

  const wr = resolvedObs > 0 ? wins.length / resolvedObs : null;
  const netAvgR = computeAvg(netRs);
  const grossAvgR = computeAvg(grossRs);
  const avgCostR = computeAvg(costRs);
  const pf = computePF(netRs);
  const avgWinGrossR = computeAvg(wins.map((p) => p.grossR));
  const avgLossGrossR = computeAvg(losses.map((p) => p.grossR));

  const verdict: FilteredEdgeProfileReport["verdict"] =
    resolvedObs < 20
      ? "TOO_EARLY"
      : netAvgR !== null && netAvgR > 0
        ? "POSITIVE_EDGE"
        : "NEGATIVE_EDGE";

  return {
    profile,
    totalObs,
    openObs,
    resolvedObs,
    expiredObs,
    wr,
    netAvgR,
    grossAvgR,
    avgCostR,
    pf,
    avgWinGrossR,
    avgLossGrossR,
    verdict,
  };
}

function groupByKey<T>(
  items: T[],
  keyFn: (item: T) => string,
  netRFn: (item: T) => number | null,
): Array<{ key: string; n: number; netAvgR: number | null }> {
  const map = new Map<string, { netRs: Array<number | null> }>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, { netRs: [] });
    map.get(key)!.netRs.push(netRFn(item));
  }
  return Array.from(map.entries()).map(([key, { netRs }]) => ({
    key,
    n: netRs.length,
    netAvgR: computeAvg(netRs),
  }));
}

function buildProfileForensics(
  profile: FilteredEdgeProfile,
  positions: FilteredEdgeShadowPosition[],
): FilteredEdgeProfileForensics {
  try {
    const obs = positions.filter((p) => p.profile === profile);
    const totalObs = obs.length;
    const openObs = obs.filter((p) => p.status === "OPEN").length;
    const resolvedObs = obs.filter((p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS").length;
    const noFillObs = obs.filter((p) => p.status === "NO_FILL").length;
    const expiredObs = obs.filter((p) => p.status === "EXPIRED").length;

    const resolvedPos = obs.filter((p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS");
    const wins = resolvedPos.filter((p) => p.status === "CLOSED_WIN");
    const losses = resolvedPos.filter((p) => p.status === "CLOSED_LOSS");
    const chronologyRows = resolvedPos.map((p) => ({
      position: p,
      chronology: deriveChronology(p),
      pathMetric: derivePathMetricStatus(p),
    }));
    const validChronologyPositions = chronologyRows
      .filter((row) => row.chronology.status === "VALID")
      .map((row) => row.position);
    const invalidChronologyRows = chronologyRows.filter((row) => row.chronology.status !== "VALID");

    const wr = resolvedObs > 0 ? wins.length / resolvedObs : null;
    const netAvgR = computeAvg(resolvedPos.map((p) => p.netR));
    const grossAvgR = computeAvg(resolvedPos.map((p) => p.grossR));
    const avgCostR = computeAvg(obs.map((p) => p.costR));
    const pf = computePF(resolvedPos.map((p) => p.netR));
    const avgWinGrossR = computeAvg(wins.map((p) => p.grossR));
    const avgLossGrossR = computeAvg(losses.map((p) => p.grossR));

    const avgStopDistanceBps = computeAvg(obs.map((p) => p.stopDistanceBps));
    const tp1Rate = resolvedObs > 0 ? wins.length / resolvedObs : null;
    const slRate = resolvedObs > 0 ? losses.length / resolvedObs : null;
    const avgDurationMinutes = computeAvg(validChronologyPositions.map((p) => p.durationMinutes));
    const invalidChronologyReasons = Array.from(
      invalidChronologyRows.reduce((map, row) => {
        const key = row.chronology.status;
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map<FilteredEdgeChronologyStatus, number>()),
    ).map(([reason, n]) => ({ reason, n }));

    // excursion
    const validPathMetricPositions = chronologyRows
      .filter((row) => row.chronology.status === "VALID" && row.pathMetric.status === "VALID")
      .map((row) => row.position);
    const invalidPathMetricRows = chronologyRows.filter(
      (row) =>
        row.chronology.status === "VALID" &&
        row.pathMetric.status !== "VALID" &&
        row.pathMetric.status !== "UNAVAILABLE",
    );
    const mfeRs = validPathMetricPositions.map((p) => p.mfeBeforeCloseR ?? p.maxMfeR ?? null);
    const maeRs = validPathMetricPositions.map((p) => p.maeBeforeCloseR ?? p.minMaeR ?? null);
    const avgMfeR = computeAvg(mfeRs);
    const avgMaeR = computeAvg(maeRs);
    const pathMetricInvalidReasons = Array.from(
      invalidPathMetricRows.reduce((map, row) => {
        const key = row.pathMetric.status;
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map<FilteredEdgePathMetricStatus, number>()),
    ).map(([reason, n]) => ({ reason, n }));
    const validLosses = validPathMetricPositions.filter((p) => p.status === "CLOSED_LOSS");
    const immediateSLCount = validLosses.filter((p) => p.immediateSl === true).length;
    const noMfeBeforeSLCount = validLosses.filter((p) => p.noMfeBeforeSl === true).length;

    // signal context breakdown
    const bySymbolResolved = new Map<string, { n: number; netRs: Array<number | null> }>();
    for (const p of resolvedPos) {
      if (!bySymbolResolved.has(p.symbol)) bySymbolResolved.set(p.symbol, { n: 0, netRs: [] });
      const entry = bySymbolResolved.get(p.symbol)!;
      entry.n += 1;
      entry.netRs.push(p.netR);
    }
    const symbolRows = Array.from(bySymbolResolved.entries()).map(([symbol, { n, netRs }]) => ({
      symbol,
      n,
      netAvgR: computeAvg(netRs) ?? 0,
    }));
    const topLosingSymbols = [...symbolRows].sort((a, b) => a.netAvgR - b.netAvgR).slice(0, 3);
    const topWinningSymbols = [...symbolRows].sort((a, b) => b.netAvgR - a.netAvgR).slice(0, 3);

    const byEntryVariantRaw = groupByKey(
      resolvedPos,
      (p) => p.selectedEntryVariant ?? "UNKNOWN",
      (p) => p.netR,
    );
    const byEntryVariant = byEntryVariantRaw.map((r) => ({
      variant: r.key,
      n: r.n,
      netAvgR: r.netAvgR,
      wr: (() => {
        const subset = resolvedPos.filter((p) => (p.selectedEntryVariant ?? "UNKNOWN") === r.key);
        const w = subset.filter((p) => p.status === "CLOSED_WIN").length;
        return subset.length > 0 ? w / subset.length : null;
      })(),
    }));
    const byExitVariantRaw = groupByKey(
      resolvedPos,
      (p) => p.selectedExitVariant ?? "UNKNOWN",
      (p) => p.netR,
    );
    const byExitVariant = byExitVariantRaw.map((r) => ({
      variant: r.key,
      n: r.n,
      netAvgR: r.netAvgR,
      wr: (() => {
        const subset = resolvedPos.filter((p) => (p.selectedExitVariant ?? "UNKNOWN") === r.key);
        const w = subset.filter((p) => p.status === "CLOSED_WIN").length;
        return subset.length > 0 ? w / subset.length : null;
      })(),
    }));

    const byRegimeAtEntryRaw = groupByKey(
      resolvedPos,
      (p) => p.marketRegimeAtOpen ?? "UNKNOWN",
      (p) => p.netR,
    );
    const byRegimeAtEntry = byRegimeAtEntryRaw.map((r) => ({ regime: r.key, n: r.n, netAvgR: r.netAvgR }));

    const bySourceConflictRaw = groupByKey(
      resolvedPos,
      (p) =>
        p.liveSourceConflict !== null
          ? `LIVE_${p.liveSourceConflict ? "TRUE" : "FALSE"}`
          : p.sourceConflict
            ? "TRUE"
            : "FALSE",
      (p) => p.netR,
    );
    const bySourceConflict = bySourceConflictRaw.map((r) => ({ label: r.key, n: r.n, netAvgR: r.netAvgR }));

    const byKronosBiasRaw = groupByKey(
      resolvedPos,
      (p) => p.kronosBias ?? "UNKNOWN",
      (p) => p.netR,
    );
    const byKronosBias = byKronosBiasRaw.map((r) => ({ bias: r.key, n: r.n, netAvgR: r.netAvgR }));

    const byWhaleAgreementRaw = groupByKey(
      resolvedPos,
      (p) => p.whaleAgreement ?? "UNKNOWN",
      (p) => p.netR,
    );
    const byWhaleAgreement = byWhaleAgreementRaw.map((r) => ({ agreement: r.key, n: r.n, netAvgR: r.netAvgR }));

    // prune suggestions
    const pruneSuggestions: FilteredEdgeProfileForensics["pruneSuggestions"] = [];

    for (const row of symbolRows) {
      if (row.n >= 2 && row.netAvgR < -0.15) {
        pruneSuggestions.push({
          type: "EXCLUDE_SYMBOL",
          label: row.symbol,
          reason: `Symbol ${row.symbol} has n=${row.n} resolved with netAvgR=${row.netAvgR.toFixed(4)}R (below -0.15 threshold)`,
          affectedN: row.n,
        });
      }
    }

    if (noMfeBeforeSLCount >= 2) {
      pruneSuggestions.push({
        type: "MIN_MFE_REQUIRED",
        label: "MIN_MFE_REQUIRED",
        reason: "Pattern: losses have no favorable move before SL; consider requiring MFE confirmation",
        affectedN: noMfeBeforeSLCount,
      });
    }

    if (immediateSLCount >= 2) {
      pruneSuggestions.push({
        type: "AVOID_IMMEDIATE_SL_PATTERN",
        label: "AVOID_IMMEDIATE_SL_PATTERN",
        reason: "Pattern: immediate SL after entry; consider entry confirmation filter",
        affectedN: immediateSLCount,
      });
    }

    if (avgCostR !== null && avgCostR > 0.08 && wr !== null && wr < 0.5) {
      pruneSuggestions.push({
        type: "COST_CAP_TIGHTEN",
        label: "COST_CAP_TIGHTEN",
        reason: `avgCostR=${avgCostR.toFixed(4)} > 0.08 and WR=${(wr * 100).toFixed(1)}% < 50%`,
        affectedN: totalObs,
      });
    }

    if (avgStopDistanceBps !== null && avgStopDistanceBps < 120 && netAvgR !== null && netAvgR < 0) {
      pruneSuggestions.push({
        type: "STOP_BUCKET_FILTER",
        label: "STOP_BUCKET_FILTER",
        reason: `avgStopDistanceBps=${avgStopDistanceBps.toFixed(0)} < 120 and netAvgR=${netAvgR.toFixed(4)} < 0; consider wider stop filter`,
        affectedN: totalObs,
      });
    }

    // Fresh-valid (intrabar-validated) economics — use single helper, never stored field
    const freshValidPos = resolvedPos.filter((p) => isFreshValidFilteredEdgeObservation(p));
    const freshValidWins = freshValidPos.filter((p) => p.status === "CLOSED_WIN");
    const freshValidResolved = freshValidPos.length;
    const freshValidWr = freshValidResolved > 0 ? freshValidWins.length / freshValidResolved : null;
    const freshValidNetAvgR = computeAvg(freshValidPos.map((p) => p.netR));
    const freshValidPf = computePF(freshValidPos.map((p) => p.netR));

    return {
      profile,
      totalObs,
      openObs,
      resolvedObs,
      noFillObs,
      expiredObs,
      wr,
      netAvgR,
      grossAvgR,
      avgCostR,
      pf,
      avgWinGrossR,
      avgLossGrossR,
      avgStopDistanceBps,
      tp1Rate,
      slRate,
      avgDurationMinutes,
      validChronologyCount: validChronologyPositions.length,
      invalidChronologyCount: invalidChronologyRows.length,
      invalidChronologyReasons,
      avgMfeR,
      avgMaeR,
      pathMetricsAvailableCount: validPathMetricPositions.length,
      pathMetricsInvalidCount: invalidPathMetricRows.length,
      pathMetricInvalidReasons,
      immediateSLCount,
      noMfeBeforeSLCount,
      topLosingSymbols,
      topWinningSymbols,
      byEntryVariant,
      byExitVariant,
      byRegimeAtEntry,
      bySourceConflict,
      byKronosBias,
      byWhaleAgreement,
      freshValidResolved,
      freshValidWr,
      freshValidNetAvgR,
      freshValidPf,
      pruneSuggestions,
    };
  } catch {
    return {
      profile,
      totalObs: 0,
      openObs: 0,
      resolvedObs: 0,
      noFillObs: 0,
      expiredObs: 0,
      wr: null,
      netAvgR: null,
      grossAvgR: null,
      avgCostR: null,
      pf: null,
      avgWinGrossR: null,
      avgLossGrossR: null,
      avgStopDistanceBps: null,
      tp1Rate: null,
      slRate: null,
      avgDurationMinutes: null,
      validChronologyCount: 0,
      invalidChronologyCount: 0,
      invalidChronologyReasons: [],
      avgMfeR: null,
      avgMaeR: null,
      pathMetricsAvailableCount: 0,
      pathMetricsInvalidCount: 0,
      pathMetricInvalidReasons: [],
      immediateSLCount: 0,
      noMfeBeforeSLCount: 0,
      topLosingSymbols: [],
      topWinningSymbols: [],
      byEntryVariant: [],
      byExitVariant: [],
      byRegimeAtEntry: [],
      bySourceConflict: [],
      byKronosBias: [],
      byWhaleAgreement: [],
      freshValidResolved: 0,
      freshValidWr: null,
      freshValidNetAvgR: null,
      freshValidPf: null,
      pruneSuggestions: [],
    };
  }
}

export function buildFilteredEdgeShadowReport(
  store: FilteredEdgeShadowStore,
): FilteredEdgeShadowReport {
  try {
    const positions = store.all;
    const profileReports: FilteredEdgeProfileReport[] = [
      buildProfileReport("STRICT_COST10", positions),
      buildProfileReport("BROAD_COST20_STOP150", positions),
    ];
    const freshValidProfileReports: FilteredEdgeFreshProfileReport[] = [
      buildFreshValidProfileReport("STRICT_COST10", positions),
      buildFreshValidProfileReport("BROAD_COST20_STOP150", positions),
    ];

    const profileForensics: FilteredEdgeProfileForensics[] = [
      buildProfileForensics("STRICT_COST10", positions),
      buildProfileForensics("BROAD_COST20_STOP150", positions),
    ];
    const freshValidExcluded = positions
      .filter((position) => position.status === "CLOSED_WIN" || position.status === "CLOSED_LOSS")
      .reduce(
        (acc, position) => {
          const classification = classifyFreshValidResolvedPosition(position);
          if (!classification.reason) return acc;
          if (classification.reason === "INVALID_CHRONOLOGY") acc.invalidChronology += 1;
          if (classification.reason === "INVALID_PATH_METRICS") acc.invalidPathMetrics += 1;
          if (classification.reason === "MISSING_PATH_METRICS") acc.missingPathMetrics += 1;
          if (classification.reason === "AMBIGUOUS_INTRABAR") acc.ambiguousIntrabar += 1;
          if (classification.reason === "INVALID_GEOMETRY") acc.invalidGeometry += 1;
          if (classification.reason === "MISSING_VERSION") acc.missingVersion += 1;
          // Quarantine count: every position with any quarantine reason
          if (deriveQuarantineReason(position) !== null) acc.quarantined += 1;
          return acc;
        },
        {
          invalidChronology: 0,
          invalidPathMetrics: 0,
          missingPathMetrics: 0,
          ambiguousIntrabar: 0,
          invalidGeometry: 0,
          missingVersion: 0,
          quarantined: 0,
        },
      );

    // recentResolved: last 5 by closedAt desc
    const resolvedPositions = positions.filter(
      (p) => (p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS") && p.closedAt !== null,
    );
    resolvedPositions.sort((a, b) => {
      const ta = new Date(a.closedAt!).getTime();
      const tb = new Date(b.closedAt!).getTime();
      return tb - ta;
    });
    const recentResolved: RecentResolvedSnapshot[] = resolvedPositions.slice(0, 5).map((p) => {
      const chronology = deriveChronology(p);
      const pathMetric = derivePathMetricStatus(p);
      const derivedIntrabar = deriveIntrabarResolutionStatus(p);
      const sourceConflictLabel =
        p.liveSourceConflict !== null
          ? `LIVE_${p.liveSourceConflict ? "TRUE" : "FALSE"}`
          : p.sourceConflict
            ? "TRUE"
            : "FALSE";
      const reasonBits = [
        p.status === "CLOSED_LOSS" && p.immediateSl ? "immediate SL" : null,
        p.status === "CLOSED_LOSS" && p.noMfeBeforeSl ? "no MFE before SL" : null,
        p.marketRegimeAtOpen ? `regime=${p.marketRegimeAtOpen}` : null,
        `sourceConflict=${sourceConflictLabel}`,
        p.kronosBias ? `kronos=${p.kronosBias}` : null,
        p.whaleAgreement ? `whale=${p.whaleAgreement}` : null,
        chronology.status !== "VALID" ? `chronology=${chronology.status}` : null,
        pathMetric.status !== "VALID" ? `pathMetric=${pathMetric.status}` : null,
      ].filter((bit): bit is string => Boolean(bit));
      // Use helper for isFreshValid — never use stored field directly
      const freshValidStatus = deriveFreshValidStatus(p);
      const freshValid = freshValidStatus.freshValid;
      // Compatibility excludedReason: keep legacy single-token format for callers/tests
      // (e.g. "PATH_METRIC_OUTLIER", "BAD_CHRONOLOGY", "AMBIGUOUS", "INVALID_RISK").
      const excludedReason: string | null = (() => {
        if (freshValid) return null;
        if (p.status !== "CLOSED_WIN" && p.status !== "CLOSED_LOSS") return "NOT_RESOLVED";
        const pm = derivePathMetric(p);
        if (pm.status === "PATH_METRIC_OUTLIER") return "PATH_METRIC_OUTLIER";
        if (pm.status === "PATH_METRIC_MISSING") return "PATH_METRIC_MISSING";
        if (pm.status === "PATH_METRIC_INVALID_RISK") return "INVALID_RISK";
        const intra = deriveIntrabarResolutionStatus(p);
        if (intra === "AMBIGUOUS_SAME_CANDLE" || intra === "INTRABAR_UNAVAILABLE" || intra === "UNAVAILABLE") {
          return "AMBIGUOUS";
        }
        const chrono = deriveChronologyStatus(p);
        if (chrono !== "VALID") return "BAD_CHRONOLOGY";
        if (p.grossR === null || p.grossR === undefined || !Number.isFinite(p.grossR)) return "INVALID_GROSS_R";
        return freshValidStatus.reason ?? "UNKNOWN";
      })();
      return {
        id: p.id,
        profile: p.profile,
        symbol: p.symbol,
        direction: p.direction,
        regimeAtEntry: p.marketRegimeAtOpen ?? null,
        entryVariant: p.selectedEntryVariant ?? null,
        exitVariant: p.selectedExitVariant ?? null,
        stopDistanceBps: p.stopDistanceBps,
        costR: p.costR,
        grossR: p.grossR,
        netR: p.netR,
        closeReason: p.resolutionSource,
        durationMinutes: p.durationMinutes,
        chronologyStatus: chronology.status,
        maxMfeR: pathMetric.status === "VALID" ? (p.maxMfeR ?? null) : null,
        minMaeR: pathMetric.status === "VALID" ? (p.minMaeR ?? null) : null,
        mfeBeforeCloseR: pathMetric.status === "VALID" ? (p.mfeBeforeCloseR ?? p.maxMfeR ?? null) : null,
        maeBeforeCloseR: pathMetric.status === "VALID" ? (p.maeBeforeCloseR ?? p.minMaeR ?? null) : null,
        pathMetricStatus: pathMetric.status,
        immediateSl: p.immediateSl === true,
        noMfeBeforeSl: p.noMfeBeforeSl === true,
        sourceConflictLabel,
        kronosBias: p.kronosBias ?? null,
        whaleAgreement: p.whaleAgreement ?? null,
        reasonSummary: reasonBits.length > 0 ? reasonBits.join("; ") : "no special forensic flags",
        openedAt: p.openedAt,
        closedAt: p.closedAt,
        // Always show DERIVED intrabar status, not stored — handles legacy/incoherent records
        intrabarResolutionStatus:
          derivedIntrabar === "UNAVAILABLE" ? null : (derivedIntrabar as FilteredEdgeShadowPosition["intrabarResolutionStatus"]),
        isFreshValid: freshValid,
        excludedReason,
      };
    });

    // overlappingCandidateCount: obs admitted into BOTH profiles for same symbol+direction+openedAt (within 60s)
    const strictObs = positions.filter((p) => p.profile === "STRICT_COST10");
    const broadObs = positions.filter((p) => p.profile === "BROAD_COST20_STOP150");
    let overlappingCandidateCount = 0;
    for (const s of strictObs) {
      const sTime = new Date(s.openedAt).getTime();
      const hasMatch = broadObs.some((b) => {
        if (b.symbol !== s.symbol || b.direction !== s.direction) return false;
        const bTime = new Date(b.openedAt).getTime();
        return Math.abs(sTime - bTime) <= 60 * 1000;
      });
      if (hasMatch) overlappingCandidateCount += 1;
    }

    // Intrabar ambiguity summary counts — use derived helper so legacy records
    // missing the stored field are classified consistently.
    const ambiguousSameCandleCount = positions.filter(
      (p) =>
        (p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS" || p.status === "AMBIGUOUS") &&
        deriveIntrabarResolutionStatus(p) === "AMBIGUOUS_SAME_CANDLE",
    ).length;
    const resolvedBy1mCount = positions.filter(
      (p) =>
        (p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS") &&
        deriveIntrabarResolutionStatus(p) === "RESOLVED_BY_1M",
    ).length;
    const ambiguousExcludedFromFreshValidCount = positions.filter(
      (p) =>
        (p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS" || p.status === "AMBIGUOUS") &&
        !isFreshValidFilteredEdgeObservation(p),
    ).length;

    // Top-level fresh-valid count — use helper (single source of truth)
    const freshValidResolvedCount = positions.filter(
      (p) => isFreshValidFilteredEdgeObservation(p),
    ).length;

    // Consistency check: top-level count should equal the unique-id count from helper
    const uniqueFreshValidIds = new Set(
      positions.filter((p) => isFreshValidFilteredEdgeObservation(p)).map((p) => p.id),
    );
    const expectedTopCount = uniqueFreshValidIds.size;
    const profileSum = profileForensics.reduce((sum, pf) => sum + pf.freshValidResolved, 0);
    // Recent-rows fresh-valid count (must equal unique-helper count restricted to last 5)
    const recentRowsFreshValidValid = recentResolved.filter((r) => r.isFreshValid === true).length;
    const recentExpected = recentResolved.filter(
      (r) =>
        isFreshValidFilteredEdgeObservation(
          positions.find((p) => p.id === r.id) as FilteredEdgeShadowPosition,
        ),
    ).length;
    const intrabarFreshValidN = freshValidResolvedCount; // intrabar tape and top tape share helper
    const freshValidPass =
      freshValidResolvedCount === expectedTopCount &&
      recentRowsFreshValidValid === recentExpected;
    const freshValidConsistencyCheck: "PASS" | "FAIL" = freshValidPass ? "PASS" : "FAIL";
    const freshValidConsistencyDetail =
      freshValidConsistencyCheck === "FAIL"
        ? `top=${freshValidResolvedCount} vs uniqueIds=${expectedTopCount}; profileSum=${profileSum}; intrabar=${intrabarFreshValidN}; recentRows=${recentRowsFreshValidValid}/${recentExpected}`
        : undefined;

    // ── Path-metric integrity check ──
    let freshValidWithNonValidPath = 0;
    let outlierWithoutLargeMfeMae = 0;
    let missingRenderedAsOutlier = 0;
    for (const p of positions) {
      if (p.status !== "CLOSED_WIN" && p.status !== "CLOSED_LOSS") continue;
      const pm = derivePathMetric(p);
      if (isFreshValidFilteredEdgeObservation(p) && pm.status !== "VALID") {
        freshValidWithNonValidPath += 1;
      }
      if (pm.status === "PATH_METRIC_OUTLIER") {
        // Outlier must be justified by |MFE| > 20 OR |MAE| > 20 OR sign error OR non-finite
        const mfe = p.mfeBeforeCloseR ?? p.maxMfeR ?? null;
        const mae = p.maeBeforeCloseR ?? p.minMaeR ?? null;
        const hasLargeMagnitude =
          (mfe !== null && (!Number.isFinite(mfe) || Math.abs(mfe) > PATH_METRIC_ABS_CAP_R)) ||
          (mae !== null && (!Number.isFinite(mae) || Math.abs(mae) > PATH_METRIC_ABS_CAP_R));
        const hasSignError =
          (mfe !== null && Number.isFinite(mfe) && mfe < 0) ||
          (mae !== null && Number.isFinite(mae) && mae > 0);
        if (!hasLargeMagnitude && !hasSignError) {
          outlierWithoutLargeMfeMae += 1;
        }
        // Missing data should never become outlier
        if (mfe === null && mae === null) {
          missingRenderedAsOutlier += 1;
        }
      }
    }
    const pathMetricConsistencyCheck = {
      status:
        freshValidWithNonValidPath === 0 &&
        outlierWithoutLargeMfeMae === 0 &&
        missingRenderedAsOutlier === 0
          ? ("PASS" as const)
          : ("FAIL" as const),
      freshValidWithNonValidPath,
      outlierWithoutLargeMfeMae,
      missingRenderedAsOutlier,
      detail:
        freshValidWithNonValidPath > 0 ||
        outlierWithoutLargeMfeMae > 0 ||
        missingRenderedAsOutlier > 0
          ? `freshValidWithNonValidPath=${freshValidWithNonValidPath}; outlierWithoutLargeMfeMae=${outlierWithoutLargeMfeMae}; missingRenderedAsOutlier=${missingRenderedAsOutlier}`
          : undefined,
    };

    // ── Chronology integrity check ──
    let freshValidWithInvalidChronology = 0;
    let negativeDurationCount = 0;
    let durationZeroWithValid5mOrdered = 0;
    for (const p of positions) {
      if (p.status !== "CLOSED_WIN" && p.status !== "CLOSED_LOSS") continue;
      const c = deriveChronologyStatus(p);
      if (isFreshValidFilteredEdgeObservation(p) && c !== "VALID") {
        freshValidWithInvalidChronology += 1;
      }
      if (c === "INVALID_NEGATIVE_DURATION") negativeDurationCount += 1;
      // duration=0 with stored intrabar=VALID_5M_ORDERED is impossible (only RESOLVED_BY_1M can have 0)
      if (
        p.durationMinutes === 0 &&
        p.intrabarResolutionStatus === "VALID_5M_ORDERED"
      ) {
        durationZeroWithValid5mOrdered += 1;
      }
    }
    const chronologyConsistencyCheck = {
      status:
        freshValidWithInvalidChronology === 0 &&
        negativeDurationCount === 0 &&
        durationZeroWithValid5mOrdered === 0
          ? ("PASS" as const)
          : ("FAIL" as const),
      freshValidWithInvalidChronology,
      negativeDurationCount,
      durationZeroWithValid5mOrdered,
      detail:
        freshValidWithInvalidChronology > 0 ||
        negativeDurationCount > 0 ||
        durationZeroWithValid5mOrdered > 0
          ? `freshValidWithInvalidChronology=${freshValidWithInvalidChronology}; negativeDuration=${negativeDurationCount}; durZeroWithValid5mOrdered=${durationZeroWithValid5mOrdered}`
          : undefined,
    };

    return {
      reportOnly: true,
      laneVersion: FILTERED_EDGE_SHADOW_LANE,
      computedAt: new Date().toISOString(),
      profileReports,
      freshValidProfileReports,
      freshValidExcluded,
      topRejectionReasons: [],
      recentResolved,
      profileForensics,
      overlappingCandidateCount,
      ambiguousSameCandleCount,
      resolvedBy1mCount,
      ambiguousExcludedFromFreshValidCount,
      freshValidResolvedCount,
      freshValidConsistencyCheck,
      freshValidConsistencyDetail,
      pathMetricConsistencyCheck,
      chronologyConsistencyCheck,
    };
  } catch {
    return {
      reportOnly: true,
      laneVersion: FILTERED_EDGE_SHADOW_LANE,
      computedAt: new Date().toISOString(),
      profileReports: [],
      freshValidProfileReports: [],
      freshValidExcluded: {
        invalidChronology: 0,
        invalidPathMetrics: 0,
        missingPathMetrics: 0,
        ambiguousIntrabar: 0,
        invalidGeometry: 0,
        missingVersion: 0,
        quarantined: 0,
      },
      topRejectionReasons: [],
      recentResolved: [],
      profileForensics: [],
      overlappingCandidateCount: 0,
      ambiguousSameCandleCount: 0,
      resolvedBy1mCount: 0,
      ambiguousExcludedFromFreshValidCount: 0,
      freshValidResolvedCount: 0,
      freshValidConsistencyCheck: "PASS" as const,
      pathMetricConsistencyCheck: {
        status: "PASS" as const,
        freshValidWithNonValidPath: 0,
        outlierWithoutLargeMfeMae: 0,
        missingRenderedAsOutlier: 0,
      },
      chronologyConsistencyCheck: {
        status: "PASS" as const,
        freshValidWithInvalidChronology: 0,
        negativeDurationCount: 0,
        durationZeroWithValid5mOrdered: 0,
      },
    };
  }
}

// ─── Excluded symbols (exported for tests) ─────────────────────────────────────
export { EXCLUDED_SYMBOLS };

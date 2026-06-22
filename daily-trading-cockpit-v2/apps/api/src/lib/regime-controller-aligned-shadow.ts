/**
 * REGIME CONTROLLER ALIGNED SHADOW COLLECTION LANE (REPORT-ONLY)
 *
 * An isolated shadow-only collection lane that admits candidates only when the
 * regime direction controller emits LONG_ONLY or SHORT_ONLY AND the candidate
 * direction matches that mode. This lets future audits measure whether
 * controller-filtered trades outperform the unfiltered tape.
 *
 * Lane label: REGIME_CONTROLLER_ALIGNED_SHADOW_V1
 * Storage: data/regime-controller-aligned-shadow.json
 *
 * STRICTLY REPORT-ONLY:
 *  - Isolated file; does NOT touch data/shadow-positions.json
 *  - No live behavior, route selection, readiness, or scoring changes
 *  - No Kronos/Whale/Fingerprint/adaptive/readiness changes
 *  - reportOnly: true always set
 *
 * RESOLVER_NOT_YET_IMPLEMENTED — positions remain OPEN until next patch
 * implements price-based resolution.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, file);
}

import type { RegimeDirectionControllerReport } from "./regime-direction-controller.js";
import { BASE_ROUTE_POLICY_VERSION_V2 } from "./shadow-engine.js";
import {
  buildExitVariantCounterfactuals,
  type ExitVariantCounterfactualReport,
} from "./controller-aligned-exit-counterfactuals.js";
import {
  buildControllerAlignedEdgeIsolationReport,
  type ControllerAlignedEdgeIsolationReport,
} from "./controller-aligned-edge-isolation.js";

// ─── Guard helper ─────────────────────────────────────────────────────────────

/**
 * ATR unit note: atrPercent is in percent-form (e.g. 0.69 means 0.69%).
 * Formula: atrBps = atrPercent * 100  (e.g. 0.69% * 100 = 69 bps)
 * Source: packages/shared/src/indicators.ts
 *   atrPercent = round((atrValue / price) * 100, 4)
 * Test anchor: atrPercent=0.69 → atrBps=69, threshold=max(80,69)=80
 */
export interface ControllerAlignedGuardResult {
  atrBps: number | null;
  variantAdjustedGuardThresholdBps: number;
  rule: "ATR_FLOOR_MAX_80_OR_1X_ATR" | "FALLBACK_FIXED_175";
}

export function computeControllerAlignedGuardThreshold(
  atrPercent: number | null | undefined,
): ControllerAlignedGuardResult {
  if (
    atrPercent !== null &&
    atrPercent !== undefined &&
    Number.isFinite(atrPercent) &&
    atrPercent > 0
  ) {
    // atrPercent is in percent-form: 0.69 = 0.69% → multiply by 100 to get bps
    const atrBps = atrPercent * 100;
    const threshold = Math.max(80, atrBps);
    return {
      atrBps,
      variantAdjustedGuardThresholdBps: threshold,
      rule: "ATR_FLOOR_MAX_80_OR_1X_ATR",
    };
  }
  return {
    atrBps: null,
    variantAdjustedGuardThresholdBps: 175,
    rule: "FALLBACK_FIXED_175",
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const REGIME_CONTROLLER_ALIGNED_SHADOW_LANE_LABEL =
  "REGIME_CONTROLLER_ALIGNED_SHADOW_V1" as const;

const STORAGE_FILENAME = "regime-controller-aligned-shadow.json";
const DEFAULT_DUPLICATE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ExactExitVariantResult {
  variantLabel: "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3";
  grossR: number;
  netR: number;
  outcome: "WIN" | "LOSS" | "PARTIAL_WIN";
}

export interface ExactExitCounterfactuals {
  computedAt: string; // ISO timestamp
  /** Did price reach TP2 before SL, after entry was filled (and after TP1 was hit)? */
  tp2HitBeforeSl: boolean | null;
  /** Did price reach TP3 before SL, after entry was filled (and after TP1 was hit)? */
  tp3HitBeforeSl: boolean | null;
  /** Did the second leg get stopped at SL after TP1 was hit (i.e. price reversed back to SL)? */
  secondLegStoppedAfterTP1: boolean | null;
  /** Exact variant outcomes using candle path data */
  variants: ExactExitVariantResult[];
}

export interface ControllerAlignedShadowPosition {
  id: string; // symbol-direction-routeMode-openedAt
  symbol: string;
  direction: "LONG" | "SHORT";
  routeMode: string | null;
  entryVariant: string | null;
  exitVariant: string | null;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number;
  controllerMode: string; // mode at admission time
  controllerAlignment: "ALIGNED"; // always ALIGNED for admitted positions
  openedAt: string;
  closedAt: string | null;
  marketRegimeAtOpen: string | null;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_BREAKEVEN" | "EXPIRED" | "NO_FILL" | "FAILED_INVALID_GEOMETRY";
  netR: number | null;
  grossR: number | null;
  /** Round-trip cost in R units: (costPerSideBps * 2) / stopDistanceBps */
  costR: number | null;
  /** Minutes from openedAt to closedAt, null if unresolved */
  durationMinutes: number | null;
  /** How the observation was resolved */
  resolutionSource: "TP1_HIT" | "SL_HIT" | "NO_FILL" | "EXPIRED" | "DATA_FAILURE" | null;
  laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1";
  reportOnly: true;
  policyVersion: string; // BASE_ROUTE_POLICY_VERSION_V2
  /**
   * Exact path-based exit counterfactuals computed during the candle walk.
   * null until the observation is resolved via candle data.
   * Supplementary data only — does not affect status/grossR/netR.
   */
  exactExitCounterfactuals?: ExactExitCounterfactuals | null;
}

interface ControllerAlignedShadowState {
  observations: ControllerAlignedShadowPosition[];
  lastUpdatedAt: string | null;
}

// ─── Storage class ────────────────────────────────────────────────────────────

export class RegimeControllerAlignedShadowStore {
  private readonly filePath: string;

  constructor(dataDir = "data") {
    this.filePath = resolve(dataDir, STORAGE_FILENAME);
  }

  readState(): ControllerAlignedShadowState {
    if (!existsSync(this.filePath)) {
      return { observations: [], lastUpdatedAt: null };
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ControllerAlignedShadowState>;
      return {
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        lastUpdatedAt: typeof parsed.lastUpdatedAt === "string" ? parsed.lastUpdatedAt : null,
      };
    } catch {
      return { observations: [], lastUpdatedAt: null };
    }
  }

  writeState(state: { observations: ControllerAlignedShadowPosition[]; lastUpdatedAt: string }): void {
    try {
      const dir = resolve(this.filePath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeJsonAtomic(this.filePath, state);
    } catch {
      // storage failures must never throw — this lane is report-only
    }
  }
}

// ─── Admission ────────────────────────────────────────────────────────────────

export interface ControllerAlignedCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  routeMode?: string | null;
  currentPrice?: number | null;
  /**
   * ATR as percent of price (percent-form: 0.69 = 0.69%).
   * Used by computeControllerAlignedGuardThreshold to derive variant-adjusted
   * guard threshold: max(80bps, 1.0 × atrBps).
   */
  atrPercent?: number | null;
  selectedExecutionPlan?: {
    selectedEntryVariant?: string | null;
    selectedExitVariant?: string | null;
    stopDistanceBps?: number | null;
    routeMode?: string | null;
  } | null;
  finalDirection?: string;
  sourceConflict?: boolean | null;
  kronosBias?: string | null;
  /** Real geometry fields — must be populated by caller for the observation to be economically valid. */
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfitLevels?: number[];
}

export interface AdmitToControllerAlignedShadowResult {
  admitted: number;
  skipped: number;
  skipReasons: Record<string, number>;
}

/**
 * Admit controller-aligned candidates to the isolated shadow lane.
 *
 * Admission rules (all must pass):
 * 1. Controller mode must be LONG_ONLY or SHORT_ONLY
 * 2. Candidate direction must match controller
 * 3. selectedExecutionPlan must exist
 * 4. stopDistanceBps >= 175
 * 5. sourceConflict must not be true
 * 6. No duplicate: same symbol+direction+routeMode already OPEN within duplicateWindowMs
 * 7. entryPrice: use candidate.currentPrice if available; otherwise record with
 *    status=NO_FILL (price feed not yet wired)
 *
 * REPORT-ONLY — never touches data/shadow-positions.json.
 */
export function admitToControllerAlignedShadow(
  candidates: ControllerAlignedCandidate[],
  store: RegimeControllerAlignedShadowStore,
  opts: {
    controllerReport: RegimeDirectionControllerReport;
    currentPrices?: Map<string, number>;
    duplicateWindowMs?: number;
  },
): AdmitToControllerAlignedShadowResult {
  const { controllerReport } = opts;
  const duplicateWindowMs = opts.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;

  const result: AdmitToControllerAlignedShadowResult = {
    admitted: 0,
    skipped: 0,
    skipReasons: {},
  };

  function skip(reason: string): void {
    result.skipped += 1;
    result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1;
  }

  // Rule 1: controller mode must be LONG_ONLY or SHORT_ONLY
  const mode = controllerReport.controllerMode;
  if (mode !== "LONG_ONLY" && mode !== "SHORT_ONLY") {
    for (const _ of candidates) {
      skip("CONTROLLER_MODE_NOT_DIRECTIONAL");
    }
    return result;
  }

  // Load existing state once
  const state = store.readState();
  const now = new Date();
  const nowIso = now.toISOString();

  const newObservations: ControllerAlignedShadowPosition[] = [];

  for (const candidate of candidates) {
    // Rule 2: direction must match controller
    if (mode === "LONG_ONLY" && candidate.direction !== "LONG") {
      skip("DIRECTION_MISMATCH_LONG_ONLY");
      continue;
    }
    if (mode === "SHORT_ONLY" && candidate.direction !== "SHORT") {
      skip("DIRECTION_MISMATCH_SHORT_ONLY");
      continue;
    }

    // Rule 3: selectedExecutionPlan must exist
    if (!candidate.selectedExecutionPlan) {
      skip("NO_EXECUTION_PLAN");
      continue;
    }

    // Rule 4: stopDistanceBps >= variant-adjusted guard threshold
    // Guard = max(80bps, 1.0 × ATR bps). Falls back to fixed 175bps when atrPercent is unavailable.
    const stopBps = candidate.selectedExecutionPlan.stopDistanceBps ?? null;
    const guardResult = computeControllerAlignedGuardThreshold(candidate.atrPercent);
    const effectiveGuard = guardResult.variantAdjustedGuardThresholdBps;
    if (stopBps === null || stopBps < effectiveGuard) {
      skip("STOP_DISTANCE_BELOW_VARIANT_ADJUSTED_GUARD");
      continue;
    }

    // Rule 5: sourceConflict must not be true
    if (candidate.sourceConflict === true) {
      skip("SOURCE_CONFLICT");
      continue;
    }

    // Rule 6: duplicate suppression
    const routeMode =
      candidate.selectedExecutionPlan.routeMode ?? candidate.routeMode ?? null;
    const cutoffTime = new Date(now.getTime() - duplicateWindowMs);
    const isDuplicate = state.observations.some((obs) => {
      if (obs.symbol !== candidate.symbol) return false;
      if (obs.direction !== candidate.direction) return false;
      if (obs.routeMode !== routeMode) return false;
      if (obs.status !== "OPEN") return false;
      try {
        return new Date(obs.openedAt) >= cutoffTime;
      } catch {
        return false;
      }
    });
    // Also check new observations being admitted in this batch
    const isDuplicateInBatch = newObservations.some((obs) => {
      return (
        obs.symbol === candidate.symbol &&
        obs.direction === candidate.direction &&
        obs.routeMode === routeMode
      );
    });

    if (isDuplicate || isDuplicateInBatch) {
      skip("DUPLICATE_WITHIN_WINDOW");
      continue;
    }

    // Rule 7: real geometry validation — entryPrice, stopLoss, takeProfitLevels must be present
    // Resolve entryPrice: prefer explicit candidate.entryPrice, fall back to currentPrices map,
    // then candidate.currentPrice.
    const resolvedEntryPrice =
      (typeof candidate.entryPrice === "number" && Number.isFinite(candidate.entryPrice) && candidate.entryPrice > 0
        ? candidate.entryPrice
        : null) ??
      opts.currentPrices?.get(candidate.symbol) ??
      (typeof candidate.currentPrice === "number" && Number.isFinite(candidate.currentPrice)
        ? candidate.currentPrice
        : null);

    if (resolvedEntryPrice === null || resolvedEntryPrice <= 0) {
      skip("MISSING_REAL_ENTRY_GEOMETRY");
      continue;
    }

    const resolvedStopLoss =
      typeof candidate.stopLoss === "number" && Number.isFinite(candidate.stopLoss) && candidate.stopLoss > 0
        ? candidate.stopLoss
        : null;
    if (resolvedStopLoss === null) {
      skip("MISSING_STOP_LOSS");
      continue;
    }

    const resolvedTpLevels: number[] = Array.isArray(candidate.takeProfitLevels)
      ? candidate.takeProfitLevels.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
      : [];
    if (resolvedTpLevels.length === 0) {
      skip("MISSING_TAKE_PROFIT_LEVELS");
      continue;
    }

    const status: ControllerAlignedShadowPosition["status"] = "OPEN";

    const id = `${candidate.symbol}-${candidate.direction}-${routeMode ?? "null"}-${nowIso}`;

    const observation: ControllerAlignedShadowPosition = {
      id: randomUUID(),
      symbol: candidate.symbol,
      direction: candidate.direction,
      routeMode,
      entryVariant: candidate.selectedExecutionPlan.selectedEntryVariant ?? null,
      exitVariant: candidate.selectedExecutionPlan.selectedExitVariant ?? null,
      entryPrice: resolvedEntryPrice,
      stopLoss: resolvedStopLoss,
      takeProfitLevels: resolvedTpLevels,
      stopDistanceBps: stopBps,
      controllerMode: mode,
      controllerAlignment: "ALIGNED",
      openedAt: nowIso,
      closedAt: null,
      marketRegimeAtOpen: controllerReport.currentRegime ?? null,
      status,
      netR: null,
      grossR: null,
      costR: null,
      durationMinutes: null,
      resolutionSource: null,
      laneLabel: REGIME_CONTROLLER_ALIGNED_SHADOW_LANE_LABEL,
      reportOnly: true,
      policyVersion: BASE_ROUTE_POLICY_VERSION_V2,
    };

    // Note: id field above is unused; we generated a UUID
    void id;

    newObservations.push(observation);
    result.admitted += 1;
  }

  if (newObservations.length > 0) {
    store.writeState({
      observations: [...state.observations, ...newObservations],
      lastUpdatedAt: nowIso,
    });
  }

  return result;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

export interface ResolveControllerAlignedShadowOptions {
  getCandles: (
    symbol: string,
    intervalMinutes: number,
    since: string,
  ) => Promise<
    Array<{
      openTime: number;
      high: number;
      low: number;
      close: number;
    }>
  >;
  /** No-fill window in ms. Position never filled within this window → NO_FILL. Default: 4 hours. */
  noFillWindowMs?: number;
  /** Expiry window in ms. Position age > this → EXPIRED. Default: 72 hours. */
  expiryWindowMs?: number;
  /** Cost per side in bps (round-trip = 2×). Default: 14 bps. */
  costPerSideBps?: number;
}

/**
 * Resolve open controller-aligned shadow observations using candle data.
 *
 * Resolution semantics (mirrors kronos-counterfactual-lane resolver):
 *  - LONG: fill check = candle.low <= entryPrice
 *  - After fill: SL check = candle.low <= stopLoss (before TP — conservative)
 *  - TP1 check = candle.high >= takeProfitLevels[0]
 *  - Same-candle tie: SL wins
 *  - Candles exhausted + not filled + age > noFillWindowMs → NO_FILL
 *  - Age > expiryWindowMs → EXPIRED (even if filled)
 *  - getCandles throws → observation stays OPEN, errors++
 *
 * grossR:
 *  - WIN (LONG): (tp1 - entry) / (entry - stop)
 *  - LOSS: -1.0 (by definition)
 * costR = (costPerSideBps * 2) / stopDistanceBps
 * netR = grossR - costR
 *
 * Report-only. writeState is synchronous. Never throws.
 */
export async function resolveControllerAlignedShadowObservations(
  store: RegimeControllerAlignedShadowStore,
  opts: ResolveControllerAlignedShadowOptions,
): Promise<{ resolved: number; errors: number; skipped: number }> {
  const noFillWindowMs = opts.noFillWindowMs ?? 4 * 60 * 60 * 1000;
  const expiryWindowMs = opts.expiryWindowMs ?? 72 * 60 * 60 * 1000;
  const costPerSideBps = opts.costPerSideBps ?? 14;

  const state = store.readState();
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let resolved = 0;
  let errors = 0;
  let skipped = 0;

  let dirty = false;

  for (const obs of state.observations) {
    // Skip already-resolved observations (including FAILED_INVALID_GEOMETRY)
    if (obs.status !== "OPEN") {
      skipped += 1;
      continue;
    }

    // Guard: validate geometry before attempting candle-based resolution.
    // Observations admitted with placeholder geometry (stopLoss=0, takeProfitLevels=[])
    // are permanently marked FAILED_INVALID_GEOMETRY so they never produce garbage economics.
    const hasValidGeometry =
      obs.entryPrice > 0 &&
      obs.stopLoss > 0 &&
      obs.takeProfitLevels.length > 0 &&
      obs.takeProfitLevels[0]! > 0;
    if (!hasValidGeometry) {
      obs.status = "FAILED_INVALID_GEOMETRY";
      obs.resolutionSource = "DATA_FAILURE";
      obs.closedAt = nowIso;
      dirty = true;
      resolved += 1;
      continue;
    }

    const openedAtMs = new Date(obs.openedAt).getTime();
    const ageMs = nowMs - openedAtMs;

    // Expiry check
    if (ageMs > expiryWindowMs) {
      obs.status = "EXPIRED";
      obs.closedAt = nowIso;
      obs.resolutionSource = "EXPIRED";
      obs.netR = null;
      obs.grossR = null;
      obs.durationMinutes = Math.round(ageMs / 60000);
      dirty = true;
      resolved += 1;
      continue;
    }

    // Skip exact counterfactual recomputation if already done (cache check is below)
    const alreadyHasExact = obs.exactExitCounterfactuals != null;

    // Fetch candles from openedAt to now
    try {
      const candles = await opts.getCandles(obs.symbol, 5, obs.openedAt);

      // Walk candles in chronological order
      let filled = false;
      let closeStatus: ControllerAlignedShadowPosition["status"] | null = null;
      let closedAt: string | null = null;
      let grossR: number | null = null;

      const entry = obs.entryPrice;
      const stop = obs.stopLoss;
      const tp1 = obs.takeProfitLevels[0] ?? null;
      const tp2 = obs.takeProfitLevels[1] ?? null;
      const tp3 = obs.takeProfitLevels[2] ?? null;
      const dir = obs.direction;
      const risk = Math.abs(entry - stop);

      // Exact path tracking variables (extended walk)
      let exactTp1Hit = false;
      // After TP1 hit, track second-leg for TP2/TP3 and SL
      let exactSecondLegStopped = false;
      let exactTp2Hit = false;
      let exactTp3Hit = false;

      for (let ci = 0; ci < candles.length; ci++) {
        const candle = candles[ci]!;
        const candleTime = new Date(candle.openTime).toISOString();

        if (!filled) {
          // Check fill: LONG = price can touch entry from above (low <= entry)
          //             SHORT = price can touch entry from below (high >= entry)
          const isFilled =
            dir === "LONG" ? candle.low <= entry : candle.high >= entry;
          if (isFilled) {
            filled = true;
          } else {
            continue;
          }
        }

        // ── Primary walk (determines obs.status/grossR — unchanged semantics) ──

        if (!exactTp1Hit) {
          // Check SL first (conservative — stop before TP on same candle)
          const slHit =
            stop > 0 &&
            (dir === "LONG" ? candle.low <= stop : candle.high >= stop);

          if (slHit) {
            closeStatus = "CLOSED_LOSS";
            closedAt = candleTime;
            grossR = -1.0;
            break;
          }

          // Check TP1
          if (tp1 !== null) {
            const tp1Hit =
              dir === "LONG" ? candle.high >= tp1 : candle.low <= tp1;
            if (tp1Hit) {
              closeStatus = "CLOSED_WIN";
              closedAt = candleTime;
              grossR =
                risk > 0
                  ? dir === "LONG"
                    ? (tp1 - entry) / risk
                    : (entry - tp1) / risk
                  : 0;
              exactTp1Hit = true;
              // Do NOT break — continue walking to track TP2/TP3 for exact counterfactuals
            }
          }
        } else {
          // ── Second-leg walk (after TP1 confirmed — track TP2 and TP3) ──
          // Conservative: SL wins on same candle as TP level
          const secondSlHit =
            stop > 0 &&
            (dir === "LONG" ? candle.low <= stop : candle.high >= stop);

          if (tp2 !== null && !exactTp2Hit) {
            const tp2Hit =
              dir === "LONG" ? candle.high >= tp2 : candle.low <= tp2;
            if (tp2Hit && secondSlHit) {
              // Same candle: SL wins (conservative)
              exactSecondLegStopped = true;
              break;
            } else if (tp2Hit) {
              exactTp2Hit = true;
              // Continue for TP3 tracking
            } else if (secondSlHit) {
              exactSecondLegStopped = true;
              break;
            }
          } else if (!exactTp2Hit && secondSlHit) {
            // No TP2 defined but SL hit on second leg
            exactSecondLegStopped = true;
            break;
          }

          if (tp3 !== null && !exactTp3Hit) {
            const tp3Hit =
              dir === "LONG" ? candle.high >= tp3 : candle.low <= tp3;
            if (tp3Hit && secondSlHit && !exactTp2Hit) {
              // Same candle: SL wins
              exactSecondLegStopped = true;
              break;
            } else if (tp3Hit) {
              exactTp3Hit = true;
              break; // TP3 is the final target
            } else if (secondSlHit && exactTp2Hit) {
              // TP2 hit but TP3 not yet hit, SL fires
              exactSecondLegStopped = true;
              break;
            } else if (secondSlHit) {
              exactSecondLegStopped = true;
              break;
            }
          } else if (!exactTp3Hit && secondSlHit && exactTp2Hit) {
            // No TP3 defined, TP2 was hit, SL fires — second leg stopped
            exactSecondLegStopped = true;
            break;
          }
        }
      }

      // If TP1 was hit but candles ran out (still open) — no second-leg resolution yet
      if (exactTp1Hit && !exactSecondLegStopped && !exactTp2Hit && !exactTp3Hit) {
        // Candles exhausted after TP1: second leg still open — mark as stopped conservatively
        // only if this was the final resolution (closeStatus set)
        // Leave exact flags as-is (false) — second leg outcome unknown
      }

      if (closeStatus !== null && closedAt !== null) {
        // Compute costR and netR
        const costR =
          obs.stopDistanceBps > 0
            ? (costPerSideBps * 2) / obs.stopDistanceBps
            : null;
        const netR = grossR !== null && costR !== null ? grossR - costR : grossR;
        const openMs = new Date(obs.openedAt).getTime();
        const closeMs = new Date(closedAt).getTime();

        obs.status = closeStatus;
        obs.closedAt = closedAt;
        obs.grossR = grossR;
        obs.costR = costR;
        obs.netR = netR;
        obs.durationMinutes = Math.round((closeMs - openMs) / 60000);
        obs.resolutionSource = closeStatus === "CLOSED_WIN" ? "TP1_HIT" : "SL_HIT";

        // ── Exact exit counterfactuals (supplementary, stored alongside primary resolution) ──
        if (!alreadyHasExact) {
          try {
            const effectiveCostR = costR ?? 0;
            const tp1GrossR =
              risk > 0 && tp1 !== null
                ? dir === "LONG"
                  ? (tp1 - entry) / risk
                  : (entry - tp1) / risk
                : 0;
            const tp2GrossR =
              risk > 0 && tp2 !== null
                ? dir === "LONG"
                  ? (tp2 - entry) / risk
                  : (entry - tp2) / risk
                : tp1GrossR; // fallback to tp1 if no TP2
            const tp3GrossR =
              risk > 0 && tp3 !== null
                ? dir === "LONG"
                  ? (tp3 - entry) / risk
                  : (entry - tp3) / risk
                : tp2GrossR; // fallback to tp2 if no TP3

            // TP1_FULL_EXIT: primary baseline
            const tp1FullGrossR = exactTp1Hit ? tp1GrossR : -1.0;
            const tp1FullOutcome: ExactExitVariantResult["outcome"] = exactTp1Hit ? "WIN" : "LOSS";

            // TP2_FULL_EXIT: hold entire position for TP2
            // - SL before TP1: LOSS
            // - TP1 hit, TP2 hit: WIN at tp2GrossR
            // - TP1 hit, SL on second leg before TP2: LOSS (price reversed past SL)
            let tp2FullGrossR: number;
            let tp2FullOutcome: ExactExitVariantResult["outcome"];
            if (!exactTp1Hit) {
              tp2FullGrossR = -1.0;
              tp2FullOutcome = "LOSS";
            } else if (exactTp2Hit) {
              tp2FullGrossR = tp2GrossR;
              tp2FullOutcome = "WIN";
            } else {
              // TP1 hit but second leg stopped before TP2 (or candles exhausted)
              tp2FullGrossR = -1.0;
              tp2FullOutcome = "LOSS";
            }

            // TP1_50_TP2_50: 50% exits at TP1, 50% waits for TP2 or SL
            let tp1_50_tp2_50GrossR: number;
            let tp1_50_tp2_50Outcome: ExactExitVariantResult["outcome"];
            if (!exactTp1Hit) {
              tp1_50_tp2_50GrossR = -1.0;
              tp1_50_tp2_50Outcome = "LOSS";
            } else if (exactTp2Hit) {
              tp1_50_tp2_50GrossR = 0.5 * tp1GrossR + 0.5 * tp2GrossR;
              tp1_50_tp2_50Outcome = "WIN";
            } else {
              // TP1 hit + second leg stopped: 50% locked at TP1, 50% stopped at -1R
              tp1_50_tp2_50GrossR = 0.5 * tp1GrossR + 0.5 * (-1.0);
              tp1_50_tp2_50Outcome = tp1_50_tp2_50GrossR > 0 ? "PARTIAL_WIN" : "LOSS";
            }

            // TP1_50_RUNNER_TP3: 50% exits at TP1, 50% waits for TP3 or SL
            let tp1_50_tp3GrossR: number;
            let tp1_50_tp3Outcome: ExactExitVariantResult["outcome"];
            if (!exactTp1Hit) {
              tp1_50_tp3GrossR = -1.0;
              tp1_50_tp3Outcome = "LOSS";
            } else if (exactTp3Hit) {
              tp1_50_tp3GrossR = 0.5 * tp1GrossR + 0.5 * tp3GrossR;
              tp1_50_tp3Outcome = "WIN";
            } else {
              // TP1 hit + second leg stopped before TP3
              tp1_50_tp3GrossR = 0.5 * tp1GrossR + 0.5 * (-1.0);
              tp1_50_tp3Outcome = tp1_50_tp3GrossR > 0 ? "PARTIAL_WIN" : "LOSS";
            }

            obs.exactExitCounterfactuals = {
              computedAt: nowIso,
              tp2HitBeforeSl: exactTp1Hit ? exactTp2Hit : null,
              tp3HitBeforeSl: exactTp1Hit ? exactTp3Hit : null,
              secondLegStoppedAfterTP1: exactTp1Hit ? exactSecondLegStopped : null,
              variants: [
                {
                  variantLabel: "TP1_FULL_EXIT",
                  grossR: tp1FullGrossR,
                  netR: tp1FullGrossR - effectiveCostR,
                  outcome: tp1FullOutcome,
                },
                {
                  variantLabel: "TP2_FULL_EXIT",
                  grossR: tp2FullGrossR,
                  netR: tp2FullGrossR - effectiveCostR,
                  outcome: tp2FullOutcome,
                },
                {
                  variantLabel: "TP1_50_TP2_50",
                  grossR: tp1_50_tp2_50GrossR,
                  netR: tp1_50_tp2_50GrossR - effectiveCostR,
                  outcome: tp1_50_tp2_50Outcome,
                },
                {
                  variantLabel: "TP1_50_RUNNER_TP3",
                  grossR: tp1_50_tp3GrossR,
                  netR: tp1_50_tp3GrossR - effectiveCostR,
                  outcome: tp1_50_tp3Outcome,
                },
              ],
            };
          } catch {
            // Exact counterfactual computation failure must never affect primary resolution
            // obs.exactExitCounterfactuals remains null
          }
        }

        dirty = true;
        resolved += 1;
      } else if (!filled && ageMs > noFillWindowMs) {
        // Never filled and past no-fill window
        obs.status = "NO_FILL";
        obs.closedAt = nowIso;
        obs.resolutionSource = "NO_FILL";
        obs.netR = null;
        obs.grossR = null;
        obs.durationMinutes = Math.round(ageMs / 60000);
        dirty = true;
        resolved += 1;
      }
      // else: still open, no action needed
    } catch {
      // Data failure — leave OPEN so we retry next cycle, but persist the diagnostic tag
      obs.resolutionSource = "DATA_FAILURE";
      dirty = true;
      errors += 1;
    }
  }

  if (dirty) {
    store.writeState({
      observations: state.observations,
      lastUpdatedAt: nowIso,
    });
  }

  return { resolved, errors, skipped };
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface RegimeControllerAlignedShadowPayoffAnatomy {
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;
  avgCostR: number | null;
  avgGrossR: number | null;
  grossToNetDrag: number | null;
  tp1HitRate: number | null;
  slHitRate: number | null;
  avgStopDistanceBps: number | null;
  payoffRatio: number | null;
  byMode: Array<{
    controllerMode: string;
    n: number;
    avgWinGrossR: number | null;
    avgLossGrossR: number | null;
    avgCostR: number | null;
    avgGrossR: number | null;
    payoffRatio: number | null;
    tp1HitRate: number | null;
  }>;
}

export interface ExactExitCounterfactualReport {
  reportOnly: true;
  /** Number of resolved observations with exact candle-path data. */
  exactN: number;
  /** Aggregated exact variant results. */
  variants: Array<{
    variantLabel: "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3";
    resolvedN: number;
    winN: number;
    lossN: number;
    partialWinN: number;
    WR: number | null;
    avgGrossR: number | null;
    avgNetR: number | null;
    PF: number | null;
  }>;
  bestByNetAvgR: "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3" | null;
  bestByPF: "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3" | null;
  /** % of TP1 hits where price also reached TP2 before SL on the second leg. */
  tp2HitRate: number | null;
  /** % of TP1 hits where price also reached TP3 before SL on the second leg. */
  tp3HitRate: number | null;
  /** % of TP1 hits where the second leg was stopped at SL. */
  secondLegStopRate: number | null;
  /** Warning: insufficient exact sample for conclusions. */
  insufficientSampleWarning: boolean;
}

export interface RegimeControllerAlignedShadowReport {
  reportOnly: true;
  laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1";
  totalObservations: number;
  openObservations: number;
  resolvedObservations: number;
  noFillObservations: number;
  expiredObservations: number;
  /** Count of observations with placeholder/zero geometry — excluded from economics. */
  invalidGeometryCount: number;
  byMode: Array<{
    controllerMode: string;
    n: number;
    openN: number;
    resolvedN: number;
    netAvgR: number | null;
    PF: number | null;
    WR: number | null;
  }>;
  overallNetAvgR: number | null;
  overallPF: number | null;
  overallWR: number | null;
  verdict: "TOO_EARLY" | "EVIDENCE_AVAILABLE";
  /** Payoff anatomy computed from CLOSED_WIN / CLOSED_LOSS resolved observations. */
  payoffAnatomy?: RegimeControllerAlignedShadowPayoffAnatomy;
  /** Top symbols by netAvgR (ascending = worst first). Only populated when resolved > 0. */
  topSymbols?: Array<{
    symbol: string;
    n: number;
    resolvedN: number;
    netAvgR: number | null;
    WR: number | null;
  }>;
  /**
   * Report-only exit variant counterfactuals (statistical approximation).
   * Only populated when >= 2 CLOSED_WIN or CLOSED_LOSS observations exist.
   * Zero live behavior changes.
   */
  exitVariantCounterfactuals?: ExitVariantCounterfactualReport;
  /**
   * Exact path-based exit counterfactuals computed from candle walk data.
   * Only populated when >= 1 resolved observation has exactExitCounterfactuals.
   * Supplementary to statistical approximation — reportOnly, zero live behavior.
   */
  exactExitCounterfactuals?: ExactExitCounterfactualReport;
  /**
   * Report-only edge isolation report: sub-cohort economics across all
   * analytical dimensions. Zero live behavior changes.
   */
  edgeIsolation?: ControllerAlignedEdgeIsolationReport;
}

function computeAvg(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

function computeNetAvgR(values: Array<number | null>): number | null {
  return computeAvg(values);
}

function computePF(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const positiveSum = finite.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const negativeSum = finite.filter((v) => v < 0).reduce((sum, v) => sum + v, 0);
  if (negativeSum === 0 || positiveSum === 0) return null;
  return positiveSum / Math.abs(negativeSum);
}

function computeWR(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.filter((v) => v > 0).length / finite.length;
}

function buildPayoffAnatomy(
  resolvedObs: ControllerAlignedShadowPosition[],
): RegimeControllerAlignedShadowPayoffAnatomy | undefined {
  // Only CLOSED_WIN and CLOSED_LOSS are used for payoff anatomy
  const wins = resolvedObs.filter((o) => o.status === "CLOSED_WIN");
  const losses = resolvedObs.filter((o) => o.status === "CLOSED_LOSS");
  const total = wins.length + losses.length;
  if (total === 0) return undefined;

  const avgWinGrossR = computeAvg(wins.map((o) => o.grossR));
  const avgLossGrossR = computeAvg(losses.map((o) => o.grossR));
  const avgCostR = computeAvg(resolvedObs.map((o) => o.costR));
  const avgGrossR = computeAvg(resolvedObs.map((o) => o.grossR));
  const avgNetR = computeAvg(resolvedObs.map((o) => o.netR));
  const grossToNetDrag =
    avgGrossR !== null && avgNetR !== null ? avgGrossR - avgNetR : null;

  const tp1HitRate = wins.length / total;
  const slHitRate = losses.length / total;

  const stopBpsValues = resolvedObs
    .map((o) => o.stopDistanceBps)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgStopDistanceBps = stopBpsValues.length > 0
    ? stopBpsValues.reduce((s, v) => s + v, 0) / stopBpsValues.length
    : null;

  const payoffRatio =
    avgWinGrossR !== null && avgLossGrossR !== null && avgLossGrossR !== 0
      ? avgWinGrossR / Math.abs(avgLossGrossR)
      : null;

  // By-mode payoff anatomy
  const modeSet = new Set(resolvedObs.map((o) => o.controllerMode));
  const byMode: RegimeControllerAlignedShadowPayoffAnatomy["byMode"] = [];
  for (const mode of modeSet) {
    const modeObs = resolvedObs.filter((o) => o.controllerMode === mode);
    const modeWins = modeObs.filter((o) => o.status === "CLOSED_WIN");
    const modeLosses = modeObs.filter((o) => o.status === "CLOSED_LOSS");
    const modeTotal = modeWins.length + modeLosses.length;
    const modeAvgWinGrossR = computeAvg(modeWins.map((o) => o.grossR));
    const modeAvgLossGrossR = computeAvg(modeLosses.map((o) => o.grossR));
    byMode.push({
      controllerMode: mode,
      n: modeObs.length,
      avgWinGrossR: modeAvgWinGrossR,
      avgLossGrossR: modeAvgLossGrossR,
      avgCostR: computeAvg(modeObs.map((o) => o.costR)),
      avgGrossR: computeAvg(modeObs.map((o) => o.grossR)),
      payoffRatio:
        modeAvgWinGrossR !== null && modeAvgLossGrossR !== null && modeAvgLossGrossR !== 0
          ? modeAvgWinGrossR / Math.abs(modeAvgLossGrossR)
          : null,
      tp1HitRate: modeTotal > 0 ? modeWins.length / modeTotal : null,
    });
  }
  byMode.sort((a, b) => a.controllerMode.localeCompare(b.controllerMode));

  return {
    avgWinGrossR,
    avgLossGrossR,
    avgCostR,
    avgGrossR,
    grossToNetDrag,
    tp1HitRate,
    slHitRate,
    avgStopDistanceBps,
    payoffRatio,
    byMode,
  };
}

export function buildRegimeControllerAlignedShadowReport(state: {
  observations: ControllerAlignedShadowPosition[];
}): RegimeControllerAlignedShadowReport {
  const observations = state.observations;
  const totalObservations = observations.length;
  const openObservations = observations.filter((o) => o.status === "OPEN").length;
  const invalidGeometryCount = observations.filter((o) => o.status === "FAILED_INVALID_GEOMETRY").length;
  // Economics-eligible: only CLOSED_WIN/LOSS/BREAKEVEN (exclude FAILED_INVALID_GEOMETRY)
  const resolvedObs = observations.filter(
    (o) =>
      o.status === "CLOSED_WIN" ||
      o.status === "CLOSED_LOSS" ||
      o.status === "CLOSED_BREAKEVEN",
  );
  const resolvedObservations = resolvedObs.length;
  const noFillObservations = observations.filter((o) => o.status === "NO_FILL").length;
  const expiredObservations = observations.filter((o) => o.status === "EXPIRED").length;

  // Build by-mode rows (economics only from valid resolved; FAILED_INVALID_GEOMETRY excluded)
  const modeSet = new Set(observations.map((o) => o.controllerMode));
  const byMode: RegimeControllerAlignedShadowReport["byMode"] = [];

  for (const modeKey of modeSet) {
    // n counts all observations in this mode (including invalid geometry — for transparency)
    const modeObs = observations.filter((o) => o.controllerMode === modeKey);
    const openN = modeObs.filter((o) => o.status === "OPEN").length;
    // Economics-eligible resolved only
    const modeResolved = modeObs.filter(
      (o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS" || o.status === "CLOSED_BREAKEVEN",
    );
    const netRs = modeResolved.map((o) => o.netR);

    byMode.push({
      controllerMode: modeKey,
      n: modeObs.length,
      openN,
      resolvedN: modeResolved.length,
      netAvgR: computeNetAvgR(netRs),
      PF: computePF(netRs),
      WR: computeWR(netRs),
    });
  }

  byMode.sort((a, b) => a.controllerMode.localeCompare(b.controllerMode));

  // Overall economics across all economics-eligible resolved observations
  const allNetRs = resolvedObs.map((o) => o.netR);
  const overallNetAvgR = computeNetAvgR(allNetRs);
  const overallPF = computePF(allNetRs);
  const overallWR = computeWR(allNetRs);

  // Verdict: TOO_EARLY until >= 20 valid resolved observations exist
  const verdict: "TOO_EARLY" | "EVIDENCE_AVAILABLE" =
    resolvedObservations >= 20 ? "EVIDENCE_AVAILABLE" : "TOO_EARLY";

  // Payoff anatomy from CLOSED_WIN / CLOSED_LOSS only
  const payoffAnatomy = buildPayoffAnatomy(resolvedObs);

  // Top symbols by netAvgR ascending (worst first), only when there are resolved obs
  let topSymbols: RegimeControllerAlignedShadowReport["topSymbols"];
  if (resolvedObs.length > 0) {
    const symbolMap: Record<string, { n: number; resolvedN: number; netRs: Array<number | null> }> = {};
    for (const obs of observations) {
      const sym = obs.symbol;
      if (!symbolMap[sym]) symbolMap[sym] = { n: 0, resolvedN: 0, netRs: [] };
      symbolMap[sym].n += 1;
      const isResolved = obs.status === "CLOSED_WIN" || obs.status === "CLOSED_LOSS" || obs.status === "CLOSED_BREAKEVEN";
      if (isResolved) {
        symbolMap[sym].resolvedN += 1;
        symbolMap[sym].netRs.push(obs.netR);
      }
    }
    topSymbols = Object.entries(symbolMap)
      .filter(([, v]) => v.resolvedN > 0)
      .map(([symbol, v]) => ({
        symbol,
        n: v.n,
        resolvedN: v.resolvedN,
        netAvgR: computeNetAvgR(v.netRs),
        WR: computeWR(v.netRs),
      }))
      .sort((a, b) => {
        // Sort by netAvgR ascending (worst first); null last
        if (a.netAvgR === null && b.netAvgR === null) return 0;
        if (a.netAvgR === null) return 1;
        if (b.netAvgR === null) return -1;
        return a.netAvgR - b.netAvgR;
      });
  }

  // Exit variant counterfactuals (report-only, pure post-processing on resolved observations).
  // Only computed when there are >= 2 economics-eligible resolved observations.
  const winsAndLosses = resolvedObs.filter(
    (o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS",
  );
  const exitVariantCounterfactuals =
    winsAndLosses.length >= 2
      ? buildExitVariantCounterfactuals(
          winsAndLosses.map((o) => ({
            status: o.status,
            entryPrice: o.entryPrice,
            stopLoss: o.stopLoss,
            takeProfitLevels: o.takeProfitLevels,
            costR: o.costR,
            grossR: o.grossR,
            netR: o.netR,
            controllerMode: o.controllerMode,
            direction: o.direction,
            stopDistanceBps: o.stopDistanceBps,
          })),
        )
      : undefined;

  // Exact path exit counterfactuals — aggregate from observations that have exactExitCounterfactuals.
  const exactExitCounterfactuals = buildExactExitCounterfactualReport(winsAndLosses);

  // Determine exit extension conclusion for edge isolation
  let exitExtensionConclusion: ControllerAlignedEdgeIsolationReport["exitExtensionConclusion"] = "INSUFFICIENT_DATA";
  if (exactExitCounterfactuals && exactExitCounterfactuals.exactN >= 10) {
    const bestLabel = exactExitCounterfactuals.bestByNetAvgR;
    const bestVariant = bestLabel
      ? exactExitCounterfactuals.variants.find((v) => v.variantLabel === bestLabel)
      : null;
    const bestNetAvgR = bestVariant?.avgNetR ?? null;
    if (bestNetAvgR !== null && bestNetAvgR > 0) {
      exitExtensionConclusion = "POSITIVE_EXACT_EXIT";
    } else {
      exitExtensionConclusion = "NO_POSITIVE_EXACT_EXIT";
    }
  }

  // Edge isolation report (report-only; never throws)
  let edgeIsolation: ControllerAlignedEdgeIsolationReport | undefined;
  try {
    edgeIsolation = buildControllerAlignedEdgeIsolationReport(
      winsAndLosses,
      exitExtensionConclusion,
    );
  } catch {
    // Computation failures must never propagate to callers
    edgeIsolation = undefined;
  }

  return {
    reportOnly: true,
    laneLabel: REGIME_CONTROLLER_ALIGNED_SHADOW_LANE_LABEL,
    totalObservations,
    openObservations,
    resolvedObservations,
    noFillObservations,
    expiredObservations,
    invalidGeometryCount,
    byMode,
    overallNetAvgR,
    overallPF,
    overallWR,
    verdict,
    payoffAnatomy,
    topSymbols,
    exitVariantCounterfactuals,
    exactExitCounterfactuals,
    edgeIsolation,
  };
}

// ─── Exact exit counterfactual aggregator ─────────────────────────────────────

type ExactVariantLabel = "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3";
const EXACT_VARIANT_LABELS: ExactVariantLabel[] = [
  "TP1_FULL_EXIT",
  "TP2_FULL_EXIT",
  "TP1_50_TP2_50",
  "TP1_50_RUNNER_TP3",
];

function buildExactExitCounterfactualReport(
  resolvedObs: ControllerAlignedShadowPosition[],
): ExactExitCounterfactualReport | undefined {
  // Only include observations that have exact data
  const withExact = resolvedObs.filter(
    (o) => o.exactExitCounterfactuals != null,
  );

  if (withExact.length === 0) return undefined;

  const exactN = withExact.length;

  // Aggregate per variant
  type VariantRow = { grossR: number; netR: number; outcome: "WIN" | "LOSS" | "PARTIAL_WIN" };
  const rowsByLabel: Record<ExactVariantLabel, VariantRow[]> = {
    TP1_FULL_EXIT: [],
    TP2_FULL_EXIT: [],
    TP1_50_TP2_50: [],
    TP1_50_RUNNER_TP3: [],
  };

  for (const obs of withExact) {
    const exact = obs.exactExitCounterfactuals!;
    for (const v of exact.variants) {
      const label = v.variantLabel as ExactVariantLabel;
      if (rowsByLabel[label]) {
        rowsByLabel[label].push({ grossR: v.grossR, netR: v.netR, outcome: v.outcome });
      }
    }
  }

  function aggregateExactVariant(label: ExactVariantLabel) {
    const rows = rowsByLabel[label];
    const winN = rows.filter((r) => r.outcome === "WIN").length;
    const partialWinN = rows.filter((r) => r.outcome === "PARTIAL_WIN").length;
    const lossN = rows.filter((r) => r.outcome === "LOSS").length;
    const resolvedN = rows.length;
    const WR = resolvedN > 0 ? (winN + partialWinN) / resolvedN : null;

    const grossRs = rows.map((r) => r.grossR);
    const netRs = rows.map((r) => r.netR);
    const avgGrossR = grossRs.length > 0 ? grossRs.reduce((s, v) => s + v, 0) / grossRs.length : null;
    const avgNetR = netRs.length > 0 ? netRs.reduce((s, v) => s + v, 0) / netRs.length : null;

    const positiveSum = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const negativeSum = netRs.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
    const PF = positiveSum > 0 && negativeSum > 0 ? positiveSum / negativeSum : null;

    return { variantLabel: label, resolvedN, winN, lossN, partialWinN, WR, avgGrossR, avgNetR, PF };
  }

  const variants = EXACT_VARIANT_LABELS.map(aggregateExactVariant);

  // Best by avgNetR
  const validByNetR = variants.filter((v) => v.avgNetR !== null);
  const bestByNetAvgR: ExactVariantLabel | null =
    validByNetR.length > 0
      ? validByNetR.reduce((best, v) => (v.avgNetR! > best.avgNetR! ? v : best)).variantLabel
      : null;

  // Best by PF
  const validByPF = variants.filter((v) => v.PF !== null);
  const bestByPF: ExactVariantLabel | null =
    validByPF.length > 0
      ? validByPF.reduce((best, v) => (v.PF! > best.PF! ? v : best)).variantLabel
      : null;

  // TP2/TP3 hit rates and second-leg stop rate (only from observations where TP1 was hit)
  const tp1HitObs = withExact.filter(
    (o) => o.exactExitCounterfactuals!.tp2HitBeforeSl !== null,
  );
  const tp1HitN = tp1HitObs.length;
  const tp2HitRate =
    tp1HitN > 0
      ? tp1HitObs.filter((o) => o.exactExitCounterfactuals!.tp2HitBeforeSl === true).length / tp1HitN
      : null;
  const tp3HitRate =
    tp1HitN > 0
      ? tp1HitObs.filter((o) => o.exactExitCounterfactuals!.tp3HitBeforeSl === true).length / tp1HitN
      : null;
  const secondLegStopRate =
    tp1HitN > 0
      ? tp1HitObs.filter((o) => o.exactExitCounterfactuals!.secondLegStoppedAfterTP1 === true).length / tp1HitN
      : null;

  return {
    reportOnly: true,
    exactN,
    variants,
    bestByNetAvgR,
    bestByPF,
    tp2HitRate,
    tp3HitRate,
    secondLegStopRate,
    insufficientSampleWarning: exactN < 20,
  };
}

// ─── BinanceClient minimal interface for backfill ─────────────────────────────

export interface BinanceClient {
  getCandles(
    symbol: string,
    interval: string,
    limit: number,
    opts?: { startTime?: number; endTime?: number },
  ): Promise<Array<{ openTime: number; high: number; low: number; close: number }>>;
}

// ─── Shared candle-walk helper for exact exit counterfactuals ─────────────────

/**
 * Walk candles and compute exact exit counterfactuals for a single observation.
 * Reuses identical logic to the resolver candle walk — do NOT duplicate.
 *
 * Returns null if the observation has invalid geometry.
 * Conservative same-candle rule: SL wins over TP on same candle.
 */
export function computeExactExitCounterfactualsFromCandles(
  obs: Pick<
    ControllerAlignedShadowPosition,
    | "direction"
    | "entryPrice"
    | "stopLoss"
    | "takeProfitLevels"
    | "stopDistanceBps"
    | "status"
  >,
  candles: Array<{ openTime: number; high: number; low: number; close: number }>,
  opts: { costPerSideBps?: number; nowIso?: string },
): ExactExitCounterfactuals | null {
  const costPerSideBps = opts.costPerSideBps ?? 14;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const entry = obs.entryPrice;
  const stop = obs.stopLoss;
  const tp1 = obs.takeProfitLevels[0] ?? null;
  const tp2 = obs.takeProfitLevels[1] ?? null;
  const tp3 = obs.takeProfitLevels[2] ?? null;
  const dir = obs.direction;
  const risk = Math.abs(entry - stop);
  const stopDistanceBps = obs.stopDistanceBps;

  if (risk <= 0 || tp1 === null) return null;

  const costR = stopDistanceBps > 0 ? (costPerSideBps * 2) / stopDistanceBps : 0;

  const tp1GrossR = dir === "LONG" ? (tp1 - entry) / risk : (entry - tp1) / risk;
  const tp2GrossR =
    tp2 !== null
      ? dir === "LONG"
        ? (tp2 - entry) / risk
        : (entry - tp2) / risk
      : tp1GrossR;
  const tp3GrossR =
    tp3 !== null
      ? dir === "LONG"
        ? (tp3 - entry) / risk
        : (entry - tp3) / risk
      : tp2GrossR;

  let filled = false;
  let exactTp1Hit = false;
  let exactSecondLegStopped = false;
  let exactTp2Hit = false;
  let exactTp3Hit = false;
  let primaryStatus: "WIN" | "LOSS" | null = null;

  for (const candle of candles) {
    if (!filled) {
      const isFilled = dir === "LONG" ? candle.low <= entry : candle.high >= entry;
      if (isFilled) {
        filled = true;
      } else {
        continue;
      }
    }

    if (!exactTp1Hit) {
      const slHit = stop > 0 && (dir === "LONG" ? candle.low <= stop : candle.high >= stop);
      if (slHit) {
        primaryStatus = "LOSS";
        break;
      }
      if (tp1 !== null) {
        const tp1Hit = dir === "LONG" ? candle.high >= tp1 : candle.low <= tp1;
        if (tp1Hit) {
          primaryStatus = "WIN";
          exactTp1Hit = true;
          // continue walking for second-leg TP2/TP3 tracking
        }
      }
    } else {
      const secondSlHit = stop > 0 && (dir === "LONG" ? candle.low <= stop : candle.high >= stop);
      if (tp2 !== null && !exactTp2Hit) {
        const tp2Hit = dir === "LONG" ? candle.high >= tp2 : candle.low <= tp2;
        if (tp2Hit && secondSlHit) {
          exactSecondLegStopped = true;
          break;
        } else if (tp2Hit) {
          exactTp2Hit = true;
        } else if (secondSlHit) {
          exactSecondLegStopped = true;
          break;
        }
      } else if (!exactTp2Hit && secondSlHit) {
        exactSecondLegStopped = true;
        break;
      }
      if (tp3 !== null && !exactTp3Hit) {
        const tp3Hit = dir === "LONG" ? candle.high >= tp3 : candle.low <= tp3;
        if (tp3Hit && secondSlHit && !exactTp2Hit) {
          exactSecondLegStopped = true;
          break;
        } else if (tp3Hit) {
          exactTp3Hit = true;
          break;
        } else if (secondSlHit && exactTp2Hit) {
          exactSecondLegStopped = true;
          break;
        } else if (secondSlHit) {
          exactSecondLegStopped = true;
          break;
        }
      } else if (!exactTp3Hit && secondSlHit && exactTp2Hit) {
        exactSecondLegStopped = true;
        break;
      }
    }
  }

  // If candles exhausted without fill or resolution, infer from obs.status
  if (!filled) {
    // No candle filled — treat based on status
    if (obs.status === "CLOSED_LOSS") {
      primaryStatus = "LOSS";
    } else if (obs.status === "CLOSED_WIN") {
      primaryStatus = "WIN";
      exactTp1Hit = true;
    }
  }

  const effectiveTp1Hit = exactTp1Hit || primaryStatus === "WIN";

  // TP1_FULL_EXIT
  const tp1FullGrossR = effectiveTp1Hit ? tp1GrossR : -1.0;
  const tp1FullOutcome: ExactExitVariantResult["outcome"] = effectiveTp1Hit ? "WIN" : "LOSS";

  // TP2_FULL_EXIT
  let tp2FullGrossR: number;
  let tp2FullOutcome: ExactExitVariantResult["outcome"];
  if (!effectiveTp1Hit) {
    tp2FullGrossR = -1.0;
    tp2FullOutcome = "LOSS";
  } else if (exactTp2Hit) {
    tp2FullGrossR = tp2GrossR;
    tp2FullOutcome = "WIN";
  } else {
    tp2FullGrossR = -1.0;
    tp2FullOutcome = "LOSS";
  }

  // TP1_50_TP2_50
  let tp1_50_tp2_50GrossR: number;
  let tp1_50_tp2_50Outcome: ExactExitVariantResult["outcome"];
  if (!effectiveTp1Hit) {
    tp1_50_tp2_50GrossR = -1.0;
    tp1_50_tp2_50Outcome = "LOSS";
  } else if (exactTp2Hit) {
    tp1_50_tp2_50GrossR = 0.5 * tp1GrossR + 0.5 * tp2GrossR;
    tp1_50_tp2_50Outcome = "WIN";
  } else {
    tp1_50_tp2_50GrossR = 0.5 * tp1GrossR + 0.5 * (-1.0);
    tp1_50_tp2_50Outcome = tp1_50_tp2_50GrossR > 0 ? "PARTIAL_WIN" : "LOSS";
  }

  // TP1_50_RUNNER_TP3
  let tp1_50_tp3GrossR: number;
  let tp1_50_tp3Outcome: ExactExitVariantResult["outcome"];
  if (!effectiveTp1Hit) {
    tp1_50_tp3GrossR = -1.0;
    tp1_50_tp3Outcome = "LOSS";
  } else if (exactTp3Hit) {
    tp1_50_tp3GrossR = 0.5 * tp1GrossR + 0.5 * tp3GrossR;
    tp1_50_tp3Outcome = "WIN";
  } else {
    tp1_50_tp3GrossR = 0.5 * tp1GrossR + 0.5 * (-1.0);
    tp1_50_tp3Outcome = tp1_50_tp3GrossR > 0 ? "PARTIAL_WIN" : "LOSS";
  }

  return {
    computedAt: nowIso,
    tp2HitBeforeSl: effectiveTp1Hit ? exactTp2Hit : null,
    tp3HitBeforeSl: effectiveTp1Hit ? exactTp3Hit : null,
    secondLegStoppedAfterTP1: effectiveTp1Hit ? exactSecondLegStopped : null,
    variants: [
      {
        variantLabel: "TP1_FULL_EXIT",
        grossR: tp1FullGrossR,
        netR: tp1FullGrossR - costR,
        outcome: tp1FullOutcome,
      },
      {
        variantLabel: "TP2_FULL_EXIT",
        grossR: tp2FullGrossR,
        netR: tp2FullGrossR - costR,
        outcome: tp2FullOutcome,
      },
      {
        variantLabel: "TP1_50_TP2_50",
        grossR: tp1_50_tp2_50GrossR,
        netR: tp1_50_tp2_50GrossR - costR,
        outcome: tp1_50_tp2_50Outcome,
      },
      {
        variantLabel: "TP1_50_RUNNER_TP3",
        grossR: tp1_50_tp3GrossR,
        netR: tp1_50_tp3GrossR - costR,
        outcome: tp1_50_tp3Outcome,
      },
    ],
  };
}

// ─── Backfill function ────────────────────────────────────────────────────────

/**
 * Backfill exactExitCounterfactuals for already-resolved observations that were
 * resolved before the exact-exit candle walk extension was added.
 *
 * Report-only. Never throws. Never changes obs.status/grossR/netR.
 * Only adds exactExitCounterfactuals (and version stamps) to eligible observations.
 *
 * Skip conditions (per observation):
 * - status is not CLOSED_WIN / CLOSED_LOSS (not resolved or invalid)
 * - guardPassedUnder === "FAILED_INVALID_GEOMETRY" OR stopLoss <= 0 OR takeProfitLevels empty
 * - exactExitCounterfactuals already present AND forceRecompute !== true
 *
 * Candle window: startTime = obs.openedAt, endTime = obs.closedAt + 4h buffer.
 */
export async function refreshExactExitCounterfactualsForResolvedObservations(
  store: RegimeControllerAlignedShadowStore,
  binanceClient: BinanceClient,
  opts?: { forceRecompute?: boolean; batchSize?: number },
): Promise<{ processed: number; skipped: number; failed: number; alreadyFresh: number }> {
  const forceRecompute = opts?.forceRecompute ?? false;
  const batchSize = opts?.batchSize ?? 20;

  const result = { processed: 0, skipped: 0, failed: 0, alreadyFresh: 0 };

  let state: ReturnType<RegimeControllerAlignedShadowStore["readState"]>;
  try {
    state = store.readState();
  } catch {
    return result;
  }

  const nowIso = new Date().toISOString();
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  // Filter to eligible resolved observations
  const eligible = state.observations.filter((obs) => {
    if (obs.status !== "CLOSED_WIN" && obs.status !== "CLOSED_LOSS") return false;
    if (obs.stopLoss <= 0 || obs.takeProfitLevels.length === 0) return false;
    if (obs.entryPrice <= 0) return false;
    return true;
  });

  // Apply batch limit
  const batch = eligible.slice(0, batchSize);

  let dirty = false;

  for (const obs of batch) {
    // Check if already fresh
    if (obs.exactExitCounterfactuals != null && !forceRecompute) {
      result.alreadyFresh += 1;
      result.skipped += 1;
      continue;
    }

    try {
      const startTimeMs = new Date(obs.openedAt).getTime();
      const endTimeMs = obs.closedAt
        ? new Date(obs.closedAt).getTime() + FOUR_HOURS_MS
        : Date.now();

      const limitNeeded = Math.min(
        Math.max(Math.ceil((endTimeMs - startTimeMs) / 300000) + 2, 12),
        1000,
      );

      const rawCandles = await binanceClient.getCandles(obs.symbol, "5m", limitNeeded, {
        startTime: startTimeMs,
        endTime: endTimeMs,
      });

      const candles = rawCandles
        .filter((c) => c.openTime >= startTimeMs && c.openTime <= endTimeMs)
        .map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close }));

      const exact = computeExactExitCounterfactualsFromCandles(obs, candles, {
        costPerSideBps: 14,
        nowIso,
      });

      if (exact !== null) {
        obs.exactExitCounterfactuals = exact;
        (obs as ControllerAlignedShadowPosition & { exactExitCounterfactualsComputedAt?: string; exactExitCounterfactualsVersion?: string }).exactExitCounterfactualsComputedAt = nowIso;
        (obs as ControllerAlignedShadowPosition & { exactExitCounterfactualsComputedAt?: string; exactExitCounterfactualsVersion?: string }).exactExitCounterfactualsVersion = "exact-exit-v1";
        result.processed += 1;
        dirty = true;
      } else {
        result.skipped += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  if (dirty) {
    try {
      store.writeState({
        observations: state.observations,
        lastUpdatedAt: nowIso,
      });
    } catch {
      // storage failures must never throw — report-only
    }
  }

  return result;
}

// ─── Promotion gate (flag-gated, no live behavior) ────────────────────────────

export type ExitVariantLabel = "TP1_FULL_EXIT" | "TP2_FULL_EXIT" | "TP1_50_TP2_50" | "TP1_50_RUNNER_TP3";

/**
 * Pure advisory function — evaluates whether the best exact exit lane is ready
 * for promotion consideration. Returns a recommendation only; does NOT create
 * any lane, file, or position. Zero live behavior.
 *
 * eligible = true only if exactN >= 10 AND best exit netAvgR > 0.
 *
 * The REGIME_CONTROLLER_ALIGNED_BEST_EXIT_SHADOW_V1 lane is only created if
 * process.env.REGIME_CONTROLLER_BEST_EXIT_ENABLED === "1".
 */
export function evaluateBestExitLanePromotion(report: RegimeControllerAlignedShadowReport): {
  eligible: boolean;
  reason: string;
  bestExitLabel?: ExitVariantLabel;
  bestNetAvgR?: number;
} {
  const exc = report.exactExitCounterfactuals;

  if (!exc) {
    return { eligible: false, reason: "NO_EXACT_EXIT_DATA" };
  }

  if (exc.exactN < 10) {
    return {
      eligible: false,
      reason: `TOO_EARLY_FOR_BEST_EXIT_DECISION (exactN=${exc.exactN} < 10)`,
    };
  }

  if (!exc.bestByNetAvgR) {
    return { eligible: false, reason: "NO_BEST_EXIT_CANDIDATE" };
  }

  // Find the best variant's avgNetR
  const bestVariant = exc.variants.find((v) => v.variantLabel === exc.bestByNetAvgR);
  const bestNetAvgR = bestVariant?.avgNetR ?? null;

  if (bestNetAvgR === null || bestNetAvgR <= 0) {
    return {
      eligible: false,
      reason: "NO_POSITIVE_EXACT_EXIT",
      bestExitLabel: exc.bestByNetAvgR,
      bestNetAvgR: bestNetAvgR ?? undefined,
    };
  }

  return {
    eligible: true,
    reason: `BEST_EXIT_CANDIDATE (exactN=${exc.exactN}, bestNetAvgR=${bestNetAvgR.toFixed(4)})`,
    bestExitLabel: exc.bestByNetAvgR,
    bestNetAvgR,
  };
}

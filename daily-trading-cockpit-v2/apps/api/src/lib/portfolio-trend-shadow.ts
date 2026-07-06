/**
 * PORTFOLIO TREND SHADOW V1 (REPORT-ONLY)
 *
 * Slower portfolio-trend lane that admits candidates only when the regime is
 * trending in the same direction, liquidity is high, and the symbol is not in
 * the toxic-exclusion list. Wider stops (3x ATR), volatility-scaled position
 * sizing, ATR-trailing exit semantics with a 48h time stop fallback.
 *
 * Lane label: PORTFOLIO_TREND_SHADOW_V1
 * Storage:    apps/api/data/portfolio-trend-shadow.json
 *
 * STRICTLY REPORT-ONLY:
 *  - Isolated file; NEVER touches data/shadow-positions.json
 *  - No live behavior, route selection, readiness, or scoring changes
 *  - reportOnly: true always set
 *  - All file I/O wrapped in try/catch
 *  - Disabled via PORTFOLIO_TREND_SHADOW_DISABLED=1
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────

export const PORTFOLIO_TREND_SHADOW_LANE = "PORTFOLIO_TREND_SHADOW_V1" as const;

/**
 * Symbols excluded from automatic admission. Includes BTC/ETH (highly
 * efficient — small edge) and a handful of others identified as toxic
 * across prior shadow lanes. Override per-candidate with `isControl: true`.
 */
export const PORTFOLIO_TREND_TOXIC_SYMBOLS: readonly string[] = [
  "BTCUSDT",
  "LINKUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "NEARUSDT",
];

export const PORTFOLIO_TREND_MAX_CONCURRENT = 5;

const DEFAULT_STOP_MULTIPLIER = 3.0;
const DEFAULT_TRAILING_MULTIPLIER = 2.0;
const DEFAULT_TIME_STOP_HOURS = 48;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────

export type PortfolioTrendStatus =
  | "OPEN"
  | "CLOSED_TRAILING_STOP"
  | "CLOSED_TIME_STOP"
  | "CLOSED_INVALIDATION"
  | "EXPIRED"
  | "AMBIGUOUS";

export type LiquidityTier = "TIER_1" | "TIER_2" | "TIER_3" | "UNKNOWN";

export interface PortfolioTrendPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  createdAt: string;
  openedAt: string;
  closedAt: string | null;

  // Entry context
  marketRegimeAtOpen: string | null;
  trendStrengthAtOpen: number | null;
  atrPercentAtOpen: number | null;
  liquidityTierAtOpen: LiquidityTier;
  volatilityAdjustedMomentum: number | null;

  // Geometry — wider stops than scalper
  entryPrice: number;
  stopLoss: number;
  initialStopMultiplier: number;
  stopDistanceBps: number | null;

  // Position sizing (report-only)
  notionalUnits: number;

  // Exit semantics
  exitMode: "ATR_TRAILING" | "TIME_STOP" | "INVALIDATION";
  timeStopHours: number;
  trailingMultiplier: number;

  // Resolution
  status: PortfolioTrendStatus;
  closeReason: string | null;
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  durationHours: number | null;

  // Path metrics
  maxMfeR: number | null;
  minMaeR: number | null;

  // Version markers
  reportOnly: true;
  laneVersion: typeof PORTFOLIO_TREND_SHADOW_LANE;
  policyVersion: "portfolio-trend-v1";
}

export interface PortfolioTrendCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  marketRegime: string | null;
  trendStrength: number | null;
  atrPercent: number | null;
  entryPrice: number;
  liquidityTier?: LiquidityTier;
  isControl?: boolean;
  costR?: number | null;
}

export interface PortfolioTrendAdmissionResult {
  admitted: boolean;
  position?: PortfolioTrendPosition;
  rejectionReasons: string[];
}

// ── Store ─────────────────────────────────────────────────────────────────

export class PortfolioTrendShadowStore {
  private readonly file: string;
  private positions: PortfolioTrendPosition[];

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "portfolio-trend-shadow.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // never throw on directory creation
    }
    this.positions = this._load();
  }

  get path(): string {
    return this.file;
  }

  get all(): PortfolioTrendPosition[] {
    return this.positions;
  }

  openCount(): number {
    return this.positions.filter((p) => p.status === "OPEN").length;
  }

  hasRecentDuplicate(
    symbol: string,
    direction: "LONG" | "SHORT",
    nowMs: number,
    windowMs = DUPLICATE_WINDOW_MS,
  ): boolean {
    return this.positions.some((p) => {
      if (p.symbol !== symbol || p.direction !== direction) return false;
      const openedMs = Date.parse(p.openedAt);
      if (!Number.isFinite(openedMs)) return false;
      return nowMs - openedMs < windowMs;
    });
  }

  private _load(): PortfolioTrendPosition[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PortfolioTrendPosition[]) : [];
    } catch {
      return [];
    }
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.positions), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // storage failures must never throw — this lane is report-only
    }
  }

  add(pos: PortfolioTrendPosition): void {
    this.positions.push(pos);
    this.save();
  }

  update(id: string, patch: Partial<PortfolioTrendPosition>): void {
    const idx = this.positions.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.positions[idx] = { ...this.positions[idx]!, ...patch };
      this.save();
    }
  }
}

let singleton: PortfolioTrendShadowStore | null = null;
export function getPortfolioTrendShadowStore(dataDir = "data"): PortfolioTrendShadowStore {
  if (!singleton) singleton = new PortfolioTrendShadowStore(dataDir);
  return singleton;
}
export function _resetPortfolioTrendShadowStoreForTests(): void {
  singleton = null;
}

// ── Regime helpers ────────────────────────────────────────────────────────

function isBullishRegime(regime: string | null): boolean {
  if (!regime) return false;
  const r = regime.toUpperCase();
  return r.includes("BULL") || r.includes("LONG_ONLY") || r.includes("LONG_BIAS");
}

function isBearishRegime(regime: string | null): boolean {
  if (!regime) return false;
  const r = regime.toUpperCase();
  return r.includes("BEAR") || r.includes("SHORT_ONLY") || r.includes("SHORT_BIAS");
}

function regimeAllowsDirection(
  regime: string | null,
  direction: "LONG" | "SHORT",
): boolean {
  if (direction === "LONG") return isBullishRegime(regime);
  return isBearishRegime(regime);
}

// ── Admission ─────────────────────────────────────────────────────────────

export function admitToPortfolioTrendShadow(
  candidate: PortfolioTrendCandidate,
  store: PortfolioTrendShadowStore,
  opts?: { nowMs?: number; maxConcurrent?: number },
): PortfolioTrendAdmissionResult {
  const reasons: string[] = [];
  const nowMs = opts?.nowMs ?? Date.now();
  const maxConcurrent = opts?.maxConcurrent ?? PORTFOLIO_TREND_MAX_CONCURRENT;

  // 1. Liquidity
  const liquidity = candidate.liquidityTier ?? "UNKNOWN";
  if (liquidity !== "TIER_1" && liquidity !== "TIER_2") {
    reasons.push("LOW_LIQUIDITY");
  }

  // 2. Toxic exclusion
  if (
    !candidate.isControl &&
    PORTFOLIO_TREND_TOXIC_SYMBOLS.includes(candidate.symbol)
  ) {
    reasons.push("TOXIC_SYMBOL_EXCLUDED");
  }

  // 3. Regime trending in direction
  if (!regimeAllowsDirection(candidate.marketRegime, candidate.direction)) {
    reasons.push("REGIME_NOT_TRENDING");
  }

  // 4. Trend strength
  if (candidate.trendStrength === null || candidate.trendStrength < 0.5) {
    reasons.push("WEAK_TREND");
  }

  // 5. ATR present & positive
  if (
    candidate.atrPercent === null ||
    candidate.atrPercent === undefined ||
    !(candidate.atrPercent > 0)
  ) {
    reasons.push("MISSING_ATR");
  }

  // 6. Entry price
  if (!(candidate.entryPrice > 0)) {
    reasons.push("MISSING_ENTRY_PRICE");
  }

  // 7. Concurrent limit
  if (store.openCount() >= maxConcurrent) {
    reasons.push("MAX_CONCURRENT_REACHED");
  }

  // 8. Duplicate window
  if (store.hasRecentDuplicate(candidate.symbol, candidate.direction, nowMs)) {
    reasons.push("DUPLICATE_RECENT");
  }

  if (reasons.length > 0) {
    return { admitted: false, rejectionReasons: reasons };
  }

  // Compute geometry
  const atrPercent = candidate.atrPercent!;
  const stopMultiplier = DEFAULT_STOP_MULTIPLIER;
  const risk = (candidate.entryPrice * atrPercent / 100) * stopMultiplier;
  const stopLoss =
    candidate.direction === "LONG"
      ? candidate.entryPrice - risk
      : candidate.entryPrice + risk;
  const stopDistanceBps = (risk / candidate.entryPrice) * 10_000;
  // Volatility-scaled notional. Avoid extreme leverage at very low ATR.
  const notionalUnits = Math.min(Math.max(1.0 / atrPercent, 0.25), 2.0);

  const nowIso = new Date(nowMs).toISOString();
  const position: PortfolioTrendPosition = {
    id: `pt-${candidate.symbol}-${candidate.direction}-${nowMs}`,
    symbol: candidate.symbol,
    direction: candidate.direction,
    createdAt: nowIso,
    openedAt: nowIso,
    closedAt: null,
    marketRegimeAtOpen: candidate.marketRegime,
    trendStrengthAtOpen: candidate.trendStrength,
    atrPercentAtOpen: atrPercent,
    liquidityTierAtOpen: liquidity,
    volatilityAdjustedMomentum:
      candidate.trendStrength !== null ? candidate.trendStrength / atrPercent : null,
    entryPrice: candidate.entryPrice,
    stopLoss,
    initialStopMultiplier: stopMultiplier,
    stopDistanceBps,
    notionalUnits,
    exitMode: "ATR_TRAILING",
    timeStopHours: DEFAULT_TIME_STOP_HOURS,
    trailingMultiplier: DEFAULT_TRAILING_MULTIPLIER,
    status: "OPEN",
    closeReason: null,
    grossR: null,
    netR: null,
    costR: candidate.costR ?? null,
    durationHours: null,
    maxMfeR: null,
    minMaeR: null,
    reportOnly: true,
    laneVersion: PORTFOLIO_TREND_SHADOW_LANE,
    policyVersion: "portfolio-trend-v1",
  };

  return { admitted: true, position, rejectionReasons: [] };
}

// ── Resolver (Phase 4 scaffold) ───────────────────────────────────────────

/**
 * Minimal Phase 4 resolver.
 *
 * Currently implements time-stop only:
 *  - If now - openedAt >= timeStopHours * 3600 * 1000 → CLOSED_TIME_STOP
 *    with grossR = 0 (no PnL information available without candle walk).
 *
 * TODO (later phase):
 *  - Walk ATR-trailing exit logic using the ATR series
 *  - Detect TRAILING_STOP hits by comparing live candles to a sliding stop
 *    derived from rolling MFE/ATR product
 *  - Compute true MFE/MAE in R units while walking
 *  - Detect INVALIDATION when the trend reverses (regime flip or trend strength
 *    drop below 0.3)
 *
 * Report-only: never throws.
 */
export async function resolvePortfolioTrendPositions(
  store: PortfolioTrendShadowStore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _binanceClient?: any,
  opts?: { nowMs?: number },
): Promise<{ resolved: number; errors: number }> {
  let resolved = 0;
  let errors = 0;
  try {
    const nowMs = opts?.nowMs ?? Date.now();
    for (const pos of store.all) {
      if (pos.status !== "OPEN") continue;
      try {
        const openedMs = Date.parse(pos.openedAt);
        if (!Number.isFinite(openedMs)) continue;
        const elapsedMs = nowMs - openedMs;
        if (elapsedMs >= pos.timeStopHours * 3600 * 1000) {
          const closedAt = new Date(nowMs).toISOString();
          // grossR/netR are genuinely UNMEASURED here (no candle walk yet — see the TODO above),
          // not zero. A wide-stop trend position that survives long enough to hit the time stop has
          // very likely moved meaningfully; fabricating grossR=0 silently biased freshValid's
          // netAvgR/PF/WR downward and could push a genuinely working trend lane into a false KILL
          // verdict. null is excluded from freshValid by the report builder's own existing filter
          // (`p.grossR !== null`) — the same "honest unmeasured, not a fake number" convention this
          // position already uses for its initial OPEN state.
          store.update(pos.id, {
            status: "CLOSED_TIME_STOP",
            closedAt,
            closeReason: "TIME_STOP_EXPIRED",
            grossR: null,
            netR: null,
            durationHours: elapsedMs / (3600 * 1000),
          });
          resolved += 1;
        }
      } catch {
        errors += 1;
      }
    }
  } catch {
    // never throw — report-only
  }
  return { resolved, errors };
}

// ── Report builder ────────────────────────────────────────────────────────

export interface PortfolioTrendShadowReport {
  reportOnly: true;
  laneVersion: typeof PORTFOLIO_TREND_SHADOW_LANE;
  computedAt: string;
  totalObs: number;
  openObs: number;
  resolvedObs: number;
  freshValidResolved: number;
  freshValidNetAvgR: number | null;
  freshValidPF: number | null;
  freshValidWR: number | null;
  avgHoldingHours: number | null;
  admissionVelocityPerDay: number | null;
  resolvedVelocityPerDay: number | null;
  freshValidVelocityPerDay: number | null;
  turnoverPerDay: number | null;
  symbolConcentration: Array<{ symbol: string; n: number; share: number }>;
  byRegime: Array<{ regime: string; n: number; netAvgR: number | null }>;
  costSensitivity: {
    atDefault: number | null;
    at10bpsRoundtrip: number | null;
    at50bpsRoundtrip: number | null;
  };
  status: "COLLECTING" | "WATCHABLE" | "KILL" | "PROMOTION_CANDIDATE";
  statusReason: string;
}

function avg(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function profitFactor(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  let posSum = 0;
  let negSum = 0;
  for (const v of finite) {
    if (v > 0) posSum += v;
    else if (v < 0) negSum -= v;
  }
  if (negSum === 0) return posSum > 0 ? Infinity : null;
  return posSum / negSum;
}

export function buildPortfolioTrendShadowReport(
  store: PortfolioTrendShadowStore,
  opts?: { nowMs?: number; defaultCostBps?: number },
): PortfolioTrendShadowReport {
  const nowMs = opts?.nowMs ?? Date.now();
  const all = store.all;
  const open = all.filter((p) => p.status === "OPEN");
  const resolved = all.filter(
    (p) =>
      p.status === "CLOSED_TIME_STOP" ||
      p.status === "CLOSED_TRAILING_STOP" ||
      p.status === "CLOSED_INVALIDATION" ||
      p.status === "EXPIRED",
  );
  const freshValid = resolved.filter(
    (p) => p.grossR !== null && Number.isFinite(p.grossR),
  );

  const netAvgR = avg(freshValid.map((p) => p.netR));
  const wins = freshValid.filter((p) => (p.netR ?? 0) > 0).length;
  const wr = freshValid.length > 0 ? wins / freshValid.length : null;
  const pf = profitFactor(freshValid.map((p) => p.netR));

  const avgHoldingHours = avg(freshValid.map((p) => p.durationHours));

  // Turnover (closed per day) — observation window is min(openedAt) to nowMs.
  let admissionVelocityPerDay: number | null = null;
  let resolvedVelocityPerDay: number | null = null;
  let freshValidVelocityPerDay: number | null = null;
  let turnoverPerDay: number | null = null;
  if (all.length > 0) {
    const earliestMs = all.reduce((min, p) => {
      const t = Date.parse(p.createdAt);
      return Number.isFinite(t) && t < min ? t : min;
    }, nowMs);
    const days = Math.max((nowMs - earliestMs) / (24 * 60 * 60 * 1000), 1);
    admissionVelocityPerDay = all.length / days;
    resolvedVelocityPerDay = resolved.length / days;
    freshValidVelocityPerDay = freshValid.length / days;
    turnoverPerDay = resolved.length / days;
  }

  // Symbol concentration
  const symCounts = new Map<string, number>();
  for (const p of all) symCounts.set(p.symbol, (symCounts.get(p.symbol) ?? 0) + 1);
  const totalForShare = all.length;
  const symbolConcentration = [...symCounts.entries()]
    .map(([symbol, n]) => ({
      symbol,
      n,
      share: totalForShare > 0 ? n / totalForShare : 0,
    }))
    .sort((a, b) => b.n - a.n);

  // Regime breakdown
  const regimeBuckets = new Map<string, Array<number | null>>();
  for (const p of freshValid) {
    const k = p.marketRegimeAtOpen ?? "UNKNOWN";
    const arr = regimeBuckets.get(k) ?? [];
    arr.push(p.netR);
    regimeBuckets.set(k, arr);
  }
  const byRegime = [...regimeBuckets.entries()]
    .map(([regime, nets]) => ({ regime, n: nets.length, netAvgR: avg(nets) }))
    .sort((a, b) => b.n - a.n);

  // Cost sensitivity (re-apply different round-trip cost in R)
  function rNetAt(costRoundTripBps: number): number | null {
    const adjusted = freshValid.map((p) => {
      const stopBps = p.stopDistanceBps;
      const grossR = p.grossR;
      if (grossR === null || stopBps === null || stopBps <= 0) return null;
      const costR = costRoundTripBps / stopBps;
      return grossR - costR;
    });
    return avg(adjusted);
  }

  let status: PortfolioTrendShadowReport["status"] = "COLLECTING";
  let statusReason = "freshValid<20";
  if (freshValid.length >= 100 && (netAvgR ?? 0) > 0 && (pf ?? 0) > 1.2) {
    status = "PROMOTION_CANDIDATE";
    statusReason = "freshValid≥100, netAvgR>0, PF>1.20";
  } else if (freshValid.length >= 20 && (netAvgR ?? 0) > 0 && (pf ?? 0) > 1.0) {
    status = "WATCHABLE";
    statusReason = "freshValid≥20, netAvgR>0, PF>1.0";
  } else if (freshValid.length >= 30 && (netAvgR ?? 0) <= 0) {
    status = "KILL";
    statusReason = "freshValid≥30 with non-positive netAvgR";
  }

  return {
    reportOnly: true,
    laneVersion: PORTFOLIO_TREND_SHADOW_LANE,
    computedAt: new Date(nowMs).toISOString(),
    totalObs: all.length,
    openObs: open.length,
    resolvedObs: resolved.length,
    freshValidResolved: freshValid.length,
    freshValidNetAvgR: netAvgR,
    freshValidPF: pf,
    freshValidWR: wr,
    avgHoldingHours,
    admissionVelocityPerDay,
    resolvedVelocityPerDay,
    freshValidVelocityPerDay,
    turnoverPerDay,
    symbolConcentration,
    byRegime,
    costSensitivity: {
      atDefault: netAvgR,
      at10bpsRoundtrip: rNetAt(10),
      at50bpsRoundtrip: rNetAt(50),
    },
    status,
    statusReason,
  };
}

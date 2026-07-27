/**
 * Derivatives crowding signal (report-only) — the #1 behavioral edge from the global-trader
 * research: read funding + OI + taker flow to know when the perp crowd is too one-sided, and
 * whether it's still BUILDING (continuation), EXHAUSTING (fragile/exit), or UNWINDING (flush — fade).
 *
 * Uses BinanceClient.getFuturesFlow (one call → fundingRate + openInterestChangePercent +
 * takerBuySellRatio + longShortRatio). Positive funding ⇒ longs pay shorts ⇒ longs crowded.
 *
 * NOT wired to live execution. Intended use once it has accrued in "/": veto a continuation that
 * enters a same-side EXTREME crowd; confirm a fade that goes AGAINST the crowd; treat UNWINDING as
 * the liquidation-flush-fade trigger. All proven via the fresh measurement first.
 */
import type { BinanceClient } from "./binance.js";

export type CrowdSide = "LONG" | "SHORT" | "NEUTRAL";
export type CrowdingLevel = "NEUTRAL" | "ELEVATED" | "EXTREME";
export type OiTrend = "RISING" | "FALLING" | "FLAT";
export type CrowdingState = "BUILDING" | "EXHAUSTING" | "UNWINDING" | "NEUTRAL";

export interface CrowdingSnapshot {
  symbol: string;
  fundingRate: number | null;
  fundingBps: number | null;
  oiChangePercent: number | null;
  oiTrend: OiTrend;
  takerBuySellRatio: number | null;
  longShortRatio: number | null;
  crowdSide: CrowdSide; // which side pays funding ⇒ crowded
  crowdingLevel: CrowdingLevel; // funding magnitude
  crowdingState: CrowdingState; // combined funding-level × OI-trend
  /** Report-only enrichment (2026-07-10) — see classifyCrowdingStateWithFlow's doc comment for the
   *  exact rule. null when not applicable (EXHAUSTING/NEUTRAL state, or no crowd side to check
   *  against) or when takerBuySellRatio was unavailable. NOT wired to any live decision path. */
  flowConfirmed: boolean | null;
  /** SHADOW (2026-07-26) — what crowdingLevel WOULD be under this symbol's own trailing funding
   *  history instead of the fixed CROWDING_*_BPS thresholds. Falls back to `crowdingLevel` when
   *  the symbol has no usable calibration yet (see crowdingShadowThresholds === null).
   *  READ BY NOTHING. Never gate on this — see the "DO NOT WIRE" banner above the thresholds. */
  crowdingLevelShadow: CrowdingLevel;
  /** The per-symbol thresholds crowdingLevelShadow was computed at, or null when the symbol had
   *  too few samples / a degenerate (non-separable) funding history and the fixed thresholds were
   *  used instead — in which case crowdingLevelShadow === crowdingLevel by construction. */
  crowdingShadowThresholds: CrowdingThresholds | null;
  fetchedAt: string;
}

/** A funding-magnitude threshold pair, in bps per 8h. `elevatedBps < extremeBps` always holds. */
export interface CrowdingThresholds {
  elevatedBps: number;
  extremeBps: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Funding magnitude thresholds (|bps| per 8h).
//
// !! DO NOT WIRE crowdingLevelShadow / classifyCrowdingAtThresholds INTO ANY GATE !!
// `crowdingLevel === "EXTREME"` is a HARD ADMISSION GATE on paths that place REAL ORDERS:
//   1. short-fade-edge.ts:107  passesShortFadeCrowdingGate  requires crowdingState === EXHAUSTING
//      (= EXTREME && OI RISING). Its measurement store DOUBLES AS the executor signal feed —
//      shortFadeOpenSignals(getShortFadeStore()) is app.ts:1371's getOpenSignals for a live
//      SingleSymbolLaneExecutor, armed wherever SHORT_FADE_EXEC_ENABLED=1 (testnet AND mainnet).
//      Testnet store as of 2026-07-26: 7,026 cycles, 175 RSI candidates, 175 crowding-rejected,
//      0 recorded — i.e. the executor receives [] every tick ONLY because EXTREME never fires.
//      Lowering `extremeBps` starts emitting real SHORT entries on the first cycle after deploy.
//   2. realtime-short-mirror.ts:381 same-side EXTREME veto (CROWDING_VETO_ENABLED=1 on testnet).
//   3. regime-composite-edge.ts / regime-composite-short-edge.ts reject EXHAUSTING (both have
//      live executors).
//   4. regime-engine-service.ts:175 fundingRiskAbnormal → noTradeGuard's FUNDING_RISK_ABNORMAL.
//   5. meta-label-gate.ts:198 crowdingAlign — a CORTEX feature; testnet runs CENTRAL_BRAIN_MODE=
//      live, so changing it moves real testnet allocation on the next refit.
//
// The v1 comment deferred this: "Fixed v1; calibrate to per-symbol history (z-score) later."
// Measured 2026-07-26 over 23,122 real testnet funding snapshots (2026-06-24 → 2026-07-06):
//   population |bps|: p50 0.550  p90 1.000  p95 1.252  p99 2.394  p99.9 4.695  max 5.558
//   >= 2 bps: 347 (1.50%, ELEVATED reachable)   >= 5 bps: 13   >= 7 bps: 0 (EXTREME never fired)
// Two facts that decide the shape of the fix, and argue AGAINST rewriting the default:
//   (a) The scale is PER-SYMBOL, not global. Over the same window, max |bps| was 1.000 for
//       BTC/LINK/UNI, 1.218 ETH, 2.800 ADA, 3.212 TRX, 3.345 SEI, 5.558 INJ — a 5.5x spread.
//       Any single global number (2.4, the population p99, included) is simultaneously
//       unreachable for the majors and loose for INJ/SEI/TRX. Replacing 7 with another global
//       constant reproduces the same defect one level down.
//   (b) The sample is a 12-day CALM-FUNDING window that ENDED 2026-07-06 (the collector has not
//       written since). 18.7% of samples sit at exactly 1.0000 bps — Binance's 0.01%/8h base
//       interest rate, i.e. premium ~0. "7 bps was never observed in a calm fortnight" is NOT
//       "7 bps is structurally unreachable"; a genuine crowded-long blowoff prints far more.
// So: the shipped defaults stay EXACTLY where they are (2 / 7) and become env-tunable with
// validated fallback, and the calibration lands as a report-only PER-SYMBOL shadow that nothing
// consumes. The only instance where setting these vars is inert is research (/root/kronos:
// CENTRAL_BRAIN_MODE=shadow, no SHORT_FADE_EXEC_ENABLED, no CROWDING_VETO_ENABLED).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Shipped defaults. Deliberate v1 judgment calls — env may override, these never change. */
export const DEFAULT_CROWDING_ELEVATED_BPS = 2;
export const DEFAULT_CROWDING_EXTREME_BPS = 7;

/**
 * Resolve the FIXED (live) thresholds from env. Repo pattern: validate, and FALL BACK to the
 * default on anything invalid — never clamp, never partially apply.
 *
 * `CROWDING_ELEVATED_BPS` / `CROWDING_EXTREME_BPS`, both finite and > 0. The pair must also
 * satisfy `elevated < extreme`; if it does not, BOTH revert to their defaults rather than
 * leaving a half-applied pair in which (say) a raised elevated silently swallows the extreme
 * band and makes EXTREME unreachable-by-construction.
 */
export function resolveFixedCrowdingThresholds(env: NodeJS.ProcessEnv = process.env): CrowdingThresholds {
  const fallback: CrowdingThresholds = {
    elevatedBps: DEFAULT_CROWDING_ELEVATED_BPS,
    extremeBps: DEFAULT_CROWDING_EXTREME_BPS,
  };
  const elevated = Number(env.CROWDING_ELEVATED_BPS);
  const extreme = Number(env.CROWDING_EXTREME_BPS);
  const elevatedBps = Number.isFinite(elevated) && elevated > 0 ? elevated : DEFAULT_CROWDING_ELEVATED_BPS;
  const extremeBps = Number.isFinite(extreme) && extreme > 0 ? extreme : DEFAULT_CROWDING_EXTREME_BPS;
  if (!(elevatedBps < extremeBps)) return fallback;
  return { elevatedBps, extremeBps };
}

/** The thresholds every live classification uses. Unchanged from v1 unless an operator sets env.
 *
 *  FROZEN deliberately. Pre-refactor these were primitive `export const` numbers that no importer
 *  could reassign; bundling them into an exported object that classifyCrowding() dereferences on
 *  every call would otherwise convert an immutable value governing five REAL-ORDER admission gates
 *  (see the banner above) into a shared mutable global. A single `FIXED_CROWDING_THRESHOLDS
 *  .extremeBps = 2.4` — most plausibly from a future test wanting the short-fade EXHAUSTING branch
 *  without module reloading — would arm a lane that today emits nothing only because EXTREME is
 *  unreachable, and in vitest would leak across every test sharing the module registry.
 *  The pure seam for tests is classifyCrowdingAtThresholds(); it takes thresholds as an argument
 *  precisely so nobody needs to mutate this. */
export const FIXED_CROWDING_THRESHOLDS: Readonly<CrowdingThresholds> = Object.freeze(
  resolveFixedCrowdingThresholds(),
);
export const CROWDING_ELEVATED_BPS = FIXED_CROWDING_THRESHOLDS.elevatedBps;
export const CROWDING_EXTREME_BPS = FIXED_CROWDING_THRESHOLDS.extremeBps;
// OI change over the 5m×2 window (%) that counts as building/unwinding.
export const OI_TREND_PCT = 1;

/**
 * Pure threshold application — the shared core of the live classifier and the shadow classifier.
 * Comparison semantics are byte-identical to the v1 inline expression (`>=` on both bands, EXTREME
 * tested first, sign taken from the raw bps, NEUTRAL level ⇒ NEUTRAL side).
 */
export function classifyCrowdingAtThresholds(
  fundingRate: number | null | undefined,
  thresholds: CrowdingThresholds,
): { crowdSide: CrowdSide; crowdingLevel: CrowdingLevel } {
  if (fundingRate == null || !Number.isFinite(fundingRate)) {
    return { crowdSide: "NEUTRAL", crowdingLevel: "NEUTRAL" };
  }
  const bps = fundingRate * 10000;
  const mag = Math.abs(bps);
  const crowdingLevel: CrowdingLevel =
    mag >= thresholds.extremeBps ? "EXTREME" : mag >= thresholds.elevatedBps ? "ELEVATED" : "NEUTRAL";
  const crowdSide: CrowdSide = crowdingLevel === "NEUTRAL" ? "NEUTRAL" : bps > 0 ? "LONG" : "SHORT";
  return { crowdSide, crowdingLevel };
}

/** THE live classifier. Every gate listed in the banner above reaches EXTREME through here. */
export function classifyCrowding(
  fundingRate: number | null | undefined,
): { crowdSide: CrowdSide; crowdingLevel: CrowdingLevel } {
  return classifyCrowdingAtThresholds(fundingRate, FIXED_CROWDING_THRESHOLDS);
}

export function classifyOiTrend(oiChangePercent: number | null | undefined): OiTrend {
  if (oiChangePercent == null || !Number.isFinite(oiChangePercent)) return "FLAT";
  if (oiChangePercent >= OI_TREND_PCT) return "RISING";
  if (oiChangePercent <= -OI_TREND_PCT) return "FALLING";
  return "FLAT";
}

export function classifyCrowdingState(level: CrowdingLevel, oiTrend: OiTrend): CrowdingState {
  // OI dropping ⇒ positions being forced out ⇒ unwinding (flush, fade-able) — checked first.
  if (oiTrend === "FALLING") return "UNWINDING";
  // Extreme funding while OI still climbs ⇒ fragile, late, exit-territory.
  if (level === "EXTREME" && oiTrend === "RISING") return "EXHAUSTING";
  // Crowding present + OI building ⇒ healthy continuation.
  if (level !== "NEUTRAL" && oiTrend === "RISING") return "BUILDING";
  return "NEUTRAL";
}

/**
 * Report-only enrichment (2026-07-10, Tier-1 audit item 1): fetchCrowdingSnapshot already fetches
 * takerBuySellRatio from Binance but — until now — never used it. This wraps the UNCHANGED
 * classifyCrowdingState() (byte-identical crowdingState output, same 2-arg call, nothing about it
 * is touched) and adds a NEW, purely additive `flowConfirmed` field that checks whether the taker
 * buy/sell flow actually agrees with the direction crowdingState implies.
 *
 * Binance's takerBuySellRatio = taker buyVol / taker sellVol over the window: >1 ⇒ aggressive
 * BUYING dominates, <1 ⇒ aggressive SELLING dominates, ===1 ⇒ balanced (counts as non-dominant).
 *
 * Confirmation rule (documented so this can be audited before it's ever considered for gating live
 * execution — it is NOT wired to any live decision path today):
 *   - BUILDING (crowd growing, OI rising): confirmed when taker flow pushes the SAME way as the
 *     crowded side — a LONG crowd needs buy-dominant flow (ratio > 1), a SHORT crowd needs
 *     sell-dominant flow (ratio < 1). This checks "is the crowd being built by real aggression, or
 *     just resting orders/funding drift".
 *   - UNWINDING (OI falling — positions being forced/closed out): confirmed when taker flow matches
 *     the unwind mechanics — a LONG crowd unwinding is longs closing/getting liquidated, which is
 *     SELL pressure (ratio < 1); a SHORT crowd unwinding is shorts covering, which is BUY pressure
 *     (ratio > 1). If crowdSide is NEUTRAL (funding wasn't elevated but OI still fell) there is no
 *     prior crowd direction to confirm the unwind against, so this stays null.
 *   - EXHAUSTING / NEUTRAL crowdingState: no directional taker-flow expectation is defined by this
 *     signal today — flowConfirmed is null (not applicable), never false, so it can't be misread as
 *     "flow contradicts the state".
 *   - Missing/invalid takerBuySellRatio (null, undefined, non-finite — e.g. a Binance fetch failure)
 *     fails open to null. Never throws, matching fetchCrowdingSnapshot's existing try/catch contract.
 */
export function classifyCrowdingStateWithFlow(
  level: CrowdingLevel,
  oiTrend: OiTrend,
  crowdSide: CrowdSide,
  takerBuySellRatio: number | null | undefined,
): { crowdingState: CrowdingState; flowConfirmed: boolean | null } {
  const crowdingState = classifyCrowdingState(level, oiTrend);
  const hasRatio = takerBuySellRatio != null && Number.isFinite(takerBuySellRatio);

  let flowConfirmed: boolean | null = null;
  if (hasRatio && crowdingState === "BUILDING") {
    if (crowdSide === "LONG") flowConfirmed = takerBuySellRatio > 1;
    else if (crowdSide === "SHORT") flowConfirmed = takerBuySellRatio < 1;
    // crowdSide NEUTRAL during BUILDING shouldn't occur (BUILDING requires level !== NEUTRAL,
    // which always assigns a LONG/SHORT crowdSide) — left null defensively either way.
  } else if (hasRatio && crowdingState === "UNWINDING") {
    if (crowdSide === "LONG") flowConfirmed = takerBuySellRatio < 1;
    else if (crowdSide === "SHORT") flowConfirmed = takerBuySellRatio > 1;
    // crowdSide NEUTRAL ⇒ no prior crowd direction to confirm the unwind against; stays null.
  }
  // EXHAUSTING / NEUTRAL crowdingState: no rule defined, stays null.

  return { crowdingState, flowConfirmed };
}

/** Adding to a crowd already EXTREME on the SAME side — the exhausted-crowd condition to avoid.
 *  Reads `crowdingLevel` (the FIXED-threshold live level) and never `crowdingLevelShadow`. */
export function isCrowdedAgainstFreshEntry(snapshot: CrowdingSnapshot, direction: "LONG" | "SHORT"): boolean {
  return snapshot.crowdingLevel === "EXTREME" && snapshot.crowdSide === direction;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PER-SYMBOL SHADOW CALIBRATION (2026-07-26) — report-only, consumed by nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function envNumPos(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
function envQuantile(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : dflt;
}

/** Trailing |funding bps| samples retained per symbol. 40 symbols × 2000 doubles ≈ 640 KB. */
export const CROWDING_SHADOW_WINDOW = Math.floor(envNumPos("CROWDING_SHADOW_WINDOW", 2000));
/** Below this many samples a symbol has no calibration and the shadow falls back to fixed. */
export const CROWDING_SHADOW_MIN_SAMPLES = Math.floor(envNumPos("CROWDING_SHADOW_MIN_SAMPLES", 200));
export const CROWDING_SHADOW_ELEVATED_QUANTILE = envQuantile("CROWDING_SHADOW_ELEVATED_QUANTILE", 0.9);
export const CROWDING_SHADOW_EXTREME_QUANTILE = envQuantile("CROWDING_SHADOW_EXTREME_QUANTILE", 0.99);
/** Re-derive at most once per this many new samples — bounds the sort to 1-in-N records. */
const CALIBRATION_RECOMPUTE_EVERY = 50;

export interface CrowdingCalibration {
  symbol: string;
  samples: number;
  thresholds: CrowdingThresholds;
  /** Robust location/scale of this symbol's |funding bps|, reported for auditing the fit. */
  medianBps: number;
  madBps: number;
  maxBps: number;
}

function quantileSortedAsc(sortedAsc: readonly number[], q: number): number {
  const n = sortedAsc.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sortedAsc[idx]!;
}

/**
 * Derive a symbol's own thresholds from its trailing |funding bps| history — the "calibrate to
 * per-symbol history" the v1 comment deferred.
 *
 * Empirical quantiles, NOT a mean/sd z-score: the measured distribution is right-skewed with an
 * 18.7% point mass at exactly 1.0000 bps (Binance's 0.01%/8h base rate when premium ≈ 0), where a
 * mean+kσ threshold lands above the observed max for the majors and is therefore just as
 * unreachable as the fixed 7. Quantiles absorb the point mass.
 *
 * Returns null — meaning "this symbol is not calibratable, use the fixed thresholds" — when there
 * are too few samples, or when the two quantiles collide (a degenerate history: e.g. BTCUSDT over
 * the measured window has p90 = p99 = max = 1.000, so there is no separable tail to call extreme).
 * Reporting null is deliberate: it surfaces the degenerate symbols instead of fabricating a
 * threshold at the point mass, which would flip a symbol to EXTREME ~19% of the time.
 *
 * Known and intended property: on a stationary window the calibrated EXTREME rate is pinned near
 * (1 − extremeQuantile) in-sample. The signal is "high relative to this symbol's own recent
 * history", and it exceeds that base rate exactly when funding leaves its trailing regime.
 */
export function deriveCrowdingThresholds(
  absBpsSamples: readonly number[],
  opts?: { minSamples?: number; elevatedQuantile?: number; extremeQuantile?: number },
): CrowdingThresholds | null {
  const minSamples = opts?.minSamples ?? CROWDING_SHADOW_MIN_SAMPLES;
  const elevatedQ = opts?.elevatedQuantile ?? CROWDING_SHADOW_ELEVATED_QUANTILE;
  const extremeQ = opts?.extremeQuantile ?? CROWDING_SHADOW_EXTREME_QUANTILE;
  const clean = absBpsSamples.filter((v) => Number.isFinite(v));
  if (clean.length < minSamples) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const elevatedBps = quantileSortedAsc(sorted, elevatedQ);
  const extremeBps = quantileSortedAsc(sorted, extremeQ);
  if (!(elevatedBps > 0) || !(elevatedBps < extremeBps)) return null;
  return { elevatedBps, extremeBps };
}

/**
 * Bounded per-symbol rolling |funding bps| window. Instantiated as a module singleton that
 * fetchCrowdingSnapshot feeds; tests construct their own so they stay order-independent.
 * O(1) amortised per record; the sort behind a derivation runs at most 1-in-50 records.
 */
export class PerSymbolCrowdingCalibrator {
  private readonly bySymbol = new Map<string, number[]>();
  private readonly cache = new Map<string, { at: number; value: CrowdingCalibration | null }>();
  /**
   * MONOTONIC count of samples ever recorded per symbol — the cache-invalidation key.
   *
   * It must NOT be `arr.length`: record() splices the window to `windowSize`, so once a symbol
   * saturates, arr.length is CONSTANT forever, `arr.length − cached.at` is permanently 0, and the
   * cached value is returned for the life of the process. The "bounded rolling window" would stop
   * rolling exactly when it fills — thresholds (and the null verdict for a degenerate symbol)
   * frozen at whatever the first post-saturation derivation produced, even after 100% of the
   * underlying samples have been evicted and replaced. At the shipped windowSize=2000 with
   * per-cycle sampling that is hours, so every shadow number an operator reads off the crowding
   * endpoint would be a constant from the process's first few hours.
   */
  private readonly recordCount = new Map<string, number>();

  constructor(
    private readonly windowSize: number = CROWDING_SHADOW_WINDOW,
    private readonly minSamples: number = CROWDING_SHADOW_MIN_SAMPLES,
  ) {}

  /** Non-throwing. Ignores null/non-finite funding — those carry no calibration information. */
  record(symbol: string, fundingRate: number | null | undefined): void {
    if (fundingRate == null || !Number.isFinite(fundingRate)) return;
    const arr = this.bySymbol.get(symbol) ?? [];
    arr.push(Math.abs(fundingRate * 10000));
    if (arr.length > this.windowSize) arr.splice(0, arr.length - this.windowSize);
    this.bySymbol.set(symbol, arr);
    this.recordCount.set(symbol, (this.recordCount.get(symbol) ?? 0) + 1);
  }

  /** Total samples ever recorded for a symbol (never decreases; unaffected by window eviction). */
  recordsSeen(symbol: string): number {
    return this.recordCount.get(symbol) ?? 0;
  }

  /** null ⇒ not calibratable yet (too few samples, or a non-separable history). */
  calibrationFor(symbol: string): CrowdingCalibration | null {
    const arr = this.bySymbol.get(symbol);
    if (!arr || arr.length < this.minSamples) return null;
    const seen = this.recordsSeen(symbol);
    const cached = this.cache.get(symbol);
    if (cached && seen - cached.at < CALIBRATION_RECOMPUTE_EVERY) return cached.value;
    const thresholds = deriveCrowdingThresholds(arr, { minSamples: this.minSamples });
    let value: CrowdingCalibration | null = null;
    if (thresholds) {
      const sorted = [...arr].sort((a, b) => a - b);
      const medianBps = quantileSortedAsc(sorted, 0.5);
      const devs = sorted.map((v) => Math.abs(v - medianBps)).sort((a, b) => a - b);
      value = {
        symbol,
        samples: arr.length,
        thresholds,
        medianBps,
        madBps: quantileSortedAsc(devs, 0.5),
        maxBps: sorted[sorted.length - 1]!,
      };
    }
    this.cache.set(symbol, { at: seen, value });
    return value;
  }

  symbols(): string[] {
    return [...this.bySymbol.keys()];
  }

  reset(): void {
    this.bySymbol.clear();
    this.cache.clear();
    this.recordCount.clear();
  }
}

let calibratorSingleton: PerSymbolCrowdingCalibrator | null = null;
/** Process-wide shadow calibrator fed by fetchCrowdingSnapshot. Report-only. */
export function getCrowdingCalibrator(): PerSymbolCrowdingCalibrator {
  calibratorSingleton ??= new PerSymbolCrowdingCalibrator();
  return calibratorSingleton;
}

export async function fetchCrowdingSnapshot(
  client: Pick<BinanceClient, "getFuturesFlow">,
  symbol: string,
  nowIso: string,
  /** Report-only shadow calibrator. Defaults to the process singleton; tests inject their own. */
  calibrator: PerSymbolCrowdingCalibrator = getCrowdingCalibrator(),
): Promise<CrowdingSnapshot> {
  let fundingRate: number | null = null;
  let oiChangePercent: number | null = null;
  let takerBuySellRatio: number | null = null;
  let longShortRatio: number | null = null;
  try {
    const flow = await client.getFuturesFlow(symbol);
    fundingRate = flow.fundingRate;
    oiChangePercent = flow.openInterestChangePercent;
    takerBuySellRatio = flow.takerBuySellRatio;
    longShortRatio = flow.longShortRatio;
  } catch {
    // report-only — never throw; leave nulls ⇒ NEUTRAL
  }
  const { crowdSide, crowdingLevel } = classifyCrowding(fundingRate);
  const oiTrend = classifyOiTrend(oiChangePercent);
  const { crowdingState, flowConfirmed } = classifyCrowdingStateWithFlow(
    crowdingLevel,
    oiTrend,
    crowdSide,
    takerBuySellRatio,
  );

  // SHADOW (report-only). Derived BEFORE recording this sample so a snapshot is never classified
  // against a window that already contains itself — the same look-ahead hygiene the resolver's
  // label-leak audit is about. Nothing below feeds crowdSide/crowdingLevel/crowdingState.
  let crowdingShadowThresholds: CrowdingThresholds | null = null;
  try {
    crowdingShadowThresholds = calibrator.calibrationFor(symbol)?.thresholds ?? null;
    calibrator.record(symbol, fundingRate);
  } catch {
    // report-only — must never affect the live snapshot this function already committed to
    crowdingShadowThresholds = null;
  }
  const crowdingLevelShadow = crowdingShadowThresholds
    ? classifyCrowdingAtThresholds(fundingRate, crowdingShadowThresholds).crowdingLevel
    : crowdingLevel;

  return {
    symbol,
    fundingRate,
    fundingBps: fundingRate == null ? null : fundingRate * 10000,
    oiChangePercent,
    oiTrend,
    takerBuySellRatio,
    longShortRatio,
    crowdSide,
    crowdingLevel,
    crowdingState,
    flowConfirmed,
    crowdingLevelShadow,
    crowdingShadowThresholds,
    fetchedAt: nowIso,
  };
}

export interface CrowdingReport {
  generatedAt: string;
  count: number;
  summary: {
    building: number;
    exhausting: number;
    unwinding: number;
    neutral: number;
    extreme: number;
    /** SHADOW: how many WOULD read EXTREME under per-symbol thresholds. Report-only. */
    extremeShadow: number;
    /** How many snapshots actually had a per-symbol calibration to shadow-classify against. */
    shadowCalibrated: number;
  };
  snapshots: CrowdingSnapshot[];
}

export function summarizeCrowding(snapshots: CrowdingSnapshot[]): CrowdingReport["summary"] {
  return {
    building: snapshots.filter((s) => s.crowdingState === "BUILDING").length,
    exhausting: snapshots.filter((s) => s.crowdingState === "EXHAUSTING").length,
    unwinding: snapshots.filter((s) => s.crowdingState === "UNWINDING").length,
    neutral: snapshots.filter((s) => s.crowdingState === "NEUTRAL").length,
    extreme: snapshots.filter((s) => s.crowdingLevel === "EXTREME").length,
    // MUST also require a real calibration. For an uncalibrated symbol crowdingLevelShadow is
    // ASSIGNED crowdingLevel (the fixed-threshold answer), so an unrestricted filter would count
    // fixed-threshold EXTREMEs as per-symbol shadow verdicts and the operator would read agreement
    // where no per-symbol measurement exists. Masked today only because fixed EXTREME never fires
    // (0/23,122) — it starts double-counting the moment anyone lowers CROWDING_EXTREME_BPS, which
    // is precisely the decision this number exists to inform.
    extremeShadow: snapshots.filter(
      (s) => s.crowdingShadowThresholds != null && s.crowdingLevelShadow === "EXTREME",
    ).length,
    shadowCalibrated: snapshots.filter((s) => s.crowdingShadowThresholds != null).length,
  };
}

export async function buildCrowdingReport(
  client: Pick<BinanceClient, "getFuturesFlow">,
  symbols: string[],
  nowIso: string,
): Promise<CrowdingReport> {
  const snapshots = await Promise.all(symbols.map((s) => fetchCrowdingSnapshot(client, s, nowIso)));
  snapshots.sort((a, b) => Math.abs(b.fundingBps ?? 0) - Math.abs(a.fundingBps ?? 0));
  return { generatedAt: nowIso, count: snapshots.length, summary: summarizeCrowding(snapshots), snapshots };
}

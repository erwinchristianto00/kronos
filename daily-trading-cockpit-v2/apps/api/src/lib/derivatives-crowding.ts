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
  fetchedAt: string;
}

// Funding magnitude thresholds (bps per 8h). Fixed v1; calibrate to per-symbol history (z-score) later.
export const CROWDING_ELEVATED_BPS = 2;
export const CROWDING_EXTREME_BPS = 7;
// OI change over the 5m×2 window (%) that counts as building/unwinding.
export const OI_TREND_PCT = 1;

export function classifyCrowding(
  fundingRate: number | null | undefined,
): { crowdSide: CrowdSide; crowdingLevel: CrowdingLevel } {
  if (fundingRate == null || !Number.isFinite(fundingRate)) {
    return { crowdSide: "NEUTRAL", crowdingLevel: "NEUTRAL" };
  }
  const bps = fundingRate * 10000;
  const mag = Math.abs(bps);
  const crowdingLevel: CrowdingLevel =
    mag >= CROWDING_EXTREME_BPS ? "EXTREME" : mag >= CROWDING_ELEVATED_BPS ? "ELEVATED" : "NEUTRAL";
  const crowdSide: CrowdSide = crowdingLevel === "NEUTRAL" ? "NEUTRAL" : bps > 0 ? "LONG" : "SHORT";
  return { crowdSide, crowdingLevel };
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

/** Adding to a crowd already EXTREME on the SAME side — the exhausted-crowd condition to avoid. */
export function isCrowdedAgainstFreshEntry(snapshot: CrowdingSnapshot, direction: "LONG" | "SHORT"): boolean {
  return snapshot.crowdingLevel === "EXTREME" && snapshot.crowdSide === direction;
}

export async function fetchCrowdingSnapshot(
  client: Pick<BinanceClient, "getFuturesFlow">,
  symbol: string,
  nowIso: string,
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
    fetchedAt: nowIso,
  };
}

export interface CrowdingReport {
  generatedAt: string;
  count: number;
  summary: { building: number; exhausting: number; unwinding: number; neutral: number; extreme: number };
  snapshots: CrowdingSnapshot[];
}

export function summarizeCrowding(snapshots: CrowdingSnapshot[]): CrowdingReport["summary"] {
  return {
    building: snapshots.filter((s) => s.crowdingState === "BUILDING").length,
    exhausting: snapshots.filter((s) => s.crowdingState === "EXHAUSTING").length,
    unwinding: snapshots.filter((s) => s.crowdingState === "UNWINDING").length,
    neutral: snapshots.filter((s) => s.crowdingState === "NEUTRAL").length,
    extreme: snapshots.filter((s) => s.crowdingLevel === "EXTREME").length,
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

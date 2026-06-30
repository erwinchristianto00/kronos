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
    crowdingState: classifyCrowdingState(crowdingLevel, oiTrend),
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

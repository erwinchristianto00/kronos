import type { Candle } from "@dtc/shared";
import { assessThreeLegSymbol, THREE_LEG_QUALITY_LIMITS, type SymbolQuality } from "./three-leg-symbol-quality.js";

export const THREE_LEG_BALANCED_POLICY = "testnet-three-leg-balanced-quality-v3" as const;
export const LIVE_THREE_LEG_BALANCED_POLICY = "live-three-leg-balanced-quality-v3" as const;
export type BalancedQualityPolicy = typeof THREE_LEG_BALANCED_POLICY | typeof LIVE_THREE_LEG_BALANCED_POLICY;
const { minMomentumRetention: _legacyRetention, ...sharedLimits } = THREE_LEG_QUALITY_LIMITS;
/** Experimental Testnet profile. Scenario room is not a forecast or installed TP. */
export const THREE_LEG_BALANCED_LIMITS = Object.freeze({
  ...sharedLimits,
  maxBodyAtr: 2, minNetRewardRisk: 1.1,
  maxLastHourPullbackAtr: .35, maxRecent3RetraceAtr: .15,
  momentumRetentionWarning: .5, scenarioRewardAtr: 2.5,
  pivotConfirmationBars: 2, pivotProminenceAtr: .75, pivotBrokenCloseBufferAtr: .1,
});
export type BalancedSymbolQuality = SymbolQuality & {
  profileId: BalancedQualityPolicy;
  latestHourAtr: number; recent3Atr: number; emaSlope3Atr: number;
  momentumRetention: number | null; warnings: string[]; significantPivots: number[];
};
export function assessBalancedThreeLegSymbol(symbol: string, direction: "LONG" | "SHORT", candles: readonly Candle[] | undefined, cutoffMs: number, policyId: BalancedQualityPolicy = THREE_LEG_BALANCED_POLICY): BalancedSymbolQuality {
  const base = assessThreeLegSymbol(symbol, direction, candles, cutoffMs);
  const q: BalancedSymbolQuality = { ...base, profileId: policyId,
    latestHourAtr: 0, recent3Atr: 0, emaSlope3Atr: 0, momentumRetention: null, warnings: [], significantPivots: [] };
  if (q.reasons.some(r => r === "QUALITY_CANDLES_MISSING_STALE_OR_INVALID" || r === "QUALITY_VOLATILITY_UNAVAILABLE")) return q;
  const cs = candles!.slice(-48), sign = direction === "LONG" ? 1 : -1, p = THREE_LEG_BALANCED_LIMITS;
  const emaBefore3 = cs.slice(0, -3).reduce((ema, c) => ema + (2 / 21) * (c.close - ema), cs[0]!.close);
  q.latestHourAtr = sign * (q.entry - cs.at(-2)!.close) / q.atr;
  q.recent3Atr = sign * (q.entry - cs.at(-4)!.close) / q.atr;
  q.emaSlope3Atr = sign * (q.ema - emaBefore3) / q.atr;
  q.momentumRetention = q.prior3Return > 0 ? q.recent3Return / q.prior3Return : null;
  q.reasons = q.reasons.filter(r => !["QUALITY_TREND_REVERSING", "QUALITY_MOMENTUM_DECELERATING", "QUALITY_INSUFFICIENT_ROOM_AFTER_COSTS", "QUALITY_EXTREME_SPIKE"].includes(r));
  // A small pullback is allowed only with two aligned hours, an aligned EMA and positive EMA slope.
  if (q.alignedHours < p.minAlignedHoursOf3 || q.latestHourAtr < -p.maxLastHourPullbackAtr
    || q.recent3Atr < -p.maxRecent3RetraceAtr || q.extensionAtr < 0 || q.emaSlope3Atr <= 0) q.reasons.push("QUALITY_TREND_NOT_SUPPORTED");
  if (q.momentumRetention !== null && q.momentumRetention < p.momentumRetentionWarning) q.warnings.push("QUALITY_MOMENTUM_DECELERATING");
  if (q.latestHourAtr <= 0 || q.recent3Atr <= 0) q.warnings.push("QUALITY_SMALL_PULLBACK");
  if (q.maxRangeAtr > p.maxRangeAtr || q.maxBodyAtr > p.maxBodyAtr) q.reasons.push("QUALITY_EXTREME_SPIKE");
  // A barrier needs a two-bar pivot and a meaningful close retreat on both sides.
  // Two subsequent closes through the level invalidate that old barrier.
  for (let i = 2; i < cs.length - 3; i++) {
    const level = direction === "LONG" ? cs[i]!.high : cs[i]!.low;
    if (sign * (level - q.entry) <= 0) continue;
    const peers = [cs[i - 2]!, cs[i - 1]!, cs[i + 1]!, cs[i + 2]!];
    if (!peers.every(c => sign * (level - (direction === "LONG" ? c.high : c.low)) >= 0)) continue;
    const leftRetreat = Math.max(...cs.slice(i - 2, i).map(c => sign * (level - c.close)));
    const rightRetreat = Math.max(...cs.slice(i + 1, i + 3).map(c => sign * (level - c.close)));
    if (Math.min(leftRetreat, rightRetreat) < p.pivotProminenceAtr * q.atr) continue;
    if (cs.slice(i + 3).some((c, j, later) => j > 0 && sign * (c.close - level) > p.pivotBrokenCloseBufferAtr * q.atr
      && sign * (later[j - 1]!.close - level) > p.pivotBrokenCloseBufferAtr * q.atr)) continue;
    q.significantPivots.push(level);
  }
  const nearest = q.significantPivots.length ? (direction === "LONG" ? Math.min(...q.significantPivots) : Math.max(...q.significantPivots)) : null;
  q.target = nearest !== null && sign * (nearest - q.entry) < p.scenarioRewardAtr * q.atr ? nearest : q.entry + sign * p.scenarioRewardAtr * q.atr;
  q.targetSource = nearest === q.target ? "PRIOR_SWING" : "BALANCED_ATR_SCENARIO";
  q.rewardPct = sign * (q.target - q.entry) / q.entry;
  q.netRewardRisk = (q.rewardPct - p.roundtripCostRate) / (q.riskPct + p.roundtripCostRate);
  if (q.netRewardRisk < p.minNetRewardRisk || q.rewardPct < p.minRewardCostMultiple * p.roundtripCostRate) q.reasons.push("QUALITY_INSUFFICIENT_ROOM_AFTER_COSTS");
  q.allowed = q.reasons.length === 0;
  return q;
}
export function balancedThreeLegPriceReason(q: SymbolQuality | undefined, price: number, formationPriceScale = 1, policyId: BalancedQualityPolicy = THREE_LEG_BALANCED_POLICY): string | null {
  if (!Number.isFinite(formationPriceScale) || formationPriceScale <= 0) return "THREE_LEG_QUALITY_SCALE_INVALID";
  price /= formationPriceScale;
  if (!q?.allowed || (q as BalancedSymbolQuality).profileId !== policyId
    || ![price, q.entry, q.atr, q.ema, q.target, q.invalidation].every(Number.isFinite) || price <= 0 || q.atr <= 0) return "THREE_LEG_QUALITY_UNAVAILABLE";
  const sign = q.direction === "LONG" ? 1 : -1, p = THREE_LEG_BALANCED_LIMITS;
  const latestHourAtr = (q as BalancedSymbolQuality).latestHourAtr;
  if (!Number.isFinite(latestHourAtr)) return "THREE_LEG_QUALITY_UNAVAILABLE";
  const risk = sign * (price - q.invalidation) / price, reward = sign * (q.target - price) / price;
  if (risk <= 0 || sign * (price - q.ema) < 0) return "THREE_LEG_PRICE_REVERSAL";
  // Fresh deterioration beyond the permitted completed-candle pullback also blocks a cheaper entry.
  if (sign * (price - q.entry) / q.atr < -p.maxLastHourPullbackAtr
    || latestHourAtr + sign * (price - q.entry) / q.atr < -p.maxLastHourPullbackAtr) return "THREE_LEG_PRICE_PULLBACK_EXCEEDED";
  if (sign * (price - q.ema) / q.atr > p.maxExtensionAtr) return "THREE_LEG_PRICE_OVEREXTENDED";
  if (risk * price / q.atr > p.maxInvalidationAtr) return "THREE_LEG_PRICE_INVALIDATION_TOO_FAR";
  if ((reward - p.roundtripCostRate) / (risk + p.roundtripCostRate) < p.minNetRewardRisk
    || reward < p.minRewardCostMultiple * p.roundtripCostRate) return "THREE_LEG_PRICE_ROOM_EXHAUSTED";
  return null;
}

import type { ValidatedFoundryRow } from "./semantic-validators.js";

export interface Tier1LiquiditySpreadPolicy {
  version: string;
  minVolume: number;
  minLiquidityNotional: number;
  maxSpreadBps: number;
  maxAgeMs: number;
}

export interface LiquidityEligibilityState { eligible: boolean; reason: "ELIGIBLE" | "MISSING" | "STALE" | "LOW_VOLUME" | "LOW_LIQUIDITY" | "WIDE_SPREAD"; sourceHash: string | null; asOfMs: number | null; }

export class PointInTimeLiquiditySpread {
  private readonly rows: readonly ValidatedFoundryRow[];
  private readonly policy: Tier1LiquiditySpreadPolicy;
  constructor(rows: readonly ValidatedFoundryRow[], policy: Tier1LiquiditySpreadPolicy) {
    if (!policy.version || !Number.isFinite(policy.minVolume) || policy.minVolume < 0 || !Number.isFinite(policy.minLiquidityNotional) || policy.minLiquidityNotional < 0 || !Number.isFinite(policy.maxSpreadBps) || policy.maxSpreadBps < 0 || !Number.isInteger(policy.maxAgeMs) || policy.maxAgeMs < 0) throw new Error("FOUNDRY_LIQUIDITY_POLICY_INVALID");
    this.rows = rows.slice(); this.policy = { ...policy };
  }
  at(symbol: string, timestampMs: number): LiquidityEligibilityState {
    const row = [...this.rows].reverse().find((candidate) => candidate.symbol === symbol && candidate.timestampMs <= timestampMs) as (ValidatedFoundryRow & { volume: number; liquidityNotional: number; spreadBps: number; validUntilMs: number }) | undefined;
    if (!row) return { eligible: false, reason: "MISSING", sourceHash: null, asOfMs: null };
    if (timestampMs > row.validUntilMs || timestampMs - row.timestampMs > this.policy.maxAgeMs) return { eligible: false, reason: "STALE", sourceHash: row.sourceHash, asOfMs: row.timestampMs };
    if (row.volume < this.policy.minVolume) return { eligible: false, reason: "LOW_VOLUME", sourceHash: row.sourceHash, asOfMs: row.timestampMs };
    if (row.liquidityNotional < this.policy.minLiquidityNotional) return { eligible: false, reason: "LOW_LIQUIDITY", sourceHash: row.sourceHash, asOfMs: row.timestampMs };
    if (row.spreadBps > this.policy.maxSpreadBps) return { eligible: false, reason: "WIDE_SPREAD", sourceHash: row.sourceHash, asOfMs: row.timestampMs };
    return { eligible: true, reason: "ELIGIBLE", sourceHash: row.sourceHash, asOfMs: row.timestampMs };
  }
  policySnapshot(): Tier1LiquiditySpreadPolicy { return { ...this.policy }; }
}

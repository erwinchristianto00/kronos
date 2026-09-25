import { createHash } from "node:crypto";
import type { ExecutorBasket } from "./cross-sectional-executor.js";

export type BasketProtectionObservation = { lastEvaluatedAt: string; previousEvaluatedAt: string | null; intervalMs: number | null; source: "WATCHER" };
/** Reporting only: no current service configuration is allowed into a basket's frozen policy. */
export function basketProtectionSummary(b: ExecutorBasket) {
  const c = b.crossProfitProtection, l = b.dynamicMom36NetLadderExit, v = b.dynamicMom36V3Exit;
  const capital = b.legs.every(x => x.entryPriceConfirmed && x.qty > 0 && x.entryPrice > 0)
    ? b.legs.reduce((s, x) => s + x.qty * x.entryPrice, 0) : null;
  const policy = c ? { version: c.version, policyId: c.policyId, accountingVersion: b.netLiqAccountingVersion, armFraction: c.armFraction, keepFraction: c.keepFraction, hardCutLossThreshold: l?.hardCutLossThreshold ?? v?.hardCutLossThreshold ?? null }
    : l ? { version: l.version, policyId: l.policyId, armNetPnlUsd: l.armNetPnlUsd, armStepNetPnlUsd: l.armStepNetPnlUsd,
      hardCutLossThreshold: l.hardCutLossThreshold, givebackFraction: l.givebackFraction, fullTakeProfitCapitalFraction: l.fullTakeProfitCapitalFraction,
      volatilitySampleIntervalMs: l.volatilitySampleIntervalMs, volatilityLookbackChanges: l.volatilityLookbackChanges,
      volatilityMinChanges: l.volatilityMinChanges, volatilityMultiplier: l.volatilityMultiplier }
    : v ? { version: v.version, policyId: v.version, armFraction: v.mfeArmThreshold, hardCutLossThreshold: v.hardCutLossThreshold,
      givebackFraction: v.mfeGivebackFraction, trailingFraction: v.mfeTrailingFraction } : null;
  const notional = c ? (c.entryNotionalUsd > 0 ? c.entryNotionalUsd : null) : l ? (l.entryCapitalUsd !== null && l.entryCapitalUsd > 0 ? l.entryCapitalUsd : null) : capital;
  return {
    policyId: policy?.policyId ?? null,
    policyFingerprint: policy ? createHash("sha256").update(JSON.stringify(policy)).digest("hex") : null,
    strategyFingerprint: b.policyFingerprint?.policyId ?? null,
    accountingVersion: b.netLiqAccountingVersion ?? "LEGACY",
    netLiquidationDiagnostic: b.lastProtectionDiagnostic ?? null,
    closeRecovery: b.closeRecovery ?? null,
    lastCloseOwnershipCheck: b.lastCloseOwnershipCheck ?? null,
    actualNetIncludingFundingUsd: b.actualNetIncludingFundingUsd ?? null,
    source: policy ? "FROZEN_BASKET_STATE" : "UNKNOWN",
    priceBasis: c ? "NET_LIQUIDATION_BID_ASK" : l || v ? "MARK_WITH_COST_MODEL" : "UNKNOWN",
    entryNotionalUsd: notional,
    armFraction: c?.armFraction ?? (v && !l ? v.mfeArmThreshold : null),
    effectiveArmUsd: c ? (notional === null ? null : c.armFraction * notional) : l?.armNetPnlUsd ?? (v && notional !== null ? v.mfeArmThreshold * notional : null),
    trailArmed: c?.armed ?? l?.trailArmed ?? v?.mfeTrailArmed ?? null,
    floorUsd: c ? (c.floorFraction === null || notional === null ? null : c.floorFraction * notional)
      : l ? l.trailingFloorNetUsd : v && v.mfeTrailingFloor !== null && notional !== null ? v.mfeTrailingFloor * notional : null,
    lastEvaluatedAt: b.protectionObservation?.lastEvaluatedAt ?? c?.lastEvaluatedAt ?? l?.lastObservedAt ?? v?.lastObservedAt ?? null,
    lastEvaluationIntervalMs: b.protectionObservation?.intervalMs ?? null,
    observationSource: b.protectionObservation?.source ?? "LEGACY_TIMESTAMP_ONLY",
  };
}
export type BasketExitAudit = {
  version: "BASKET_EXIT_AUDIT_V1";
  reason: string;
  decisionAt: string;
  origin: "WATCHER" | "LIFECYCLE_NO_TRIGGER_SNAPSHOT";
  protection: ReturnType<typeof basketProtectionSummary>;
  triggerNetPnlUsd: number | null;
  quotes: Array<{ symbol: string; side: string; qty: number; bid: number | null; ask: number | null; bidQty?: number | null; askQty?: number | null; filledQty?: number; remainingQty?: number; quoteObservedAtMs: number | null; mark: number | null; markObservedAtMs: number | null }> | null;
  netLiquidationDiagnostic?: ExecutorBasket["lastProtectionDiagnostic"];
  costSnapshot?: ExecutorBasket["protectionCosts"];
  settlementCosts?: ExecutorBasket["protectionCosts"];
  actualNetIncludingFundingUsd?: number | null;
  events: Array<{ at: string; kind: string; symbol?: string; clientOrderId?: string; orderId?: string | null; quantity?: number; status?: string; exchangeUpdateAt?: string | null; error?: string; confirmed?: boolean }>;
  droppedEvents: number;
  flatConfirmedAt: string | null;
  settlement?: { recordedAt: string; exchangeLastFillAt: string | null; grossPnlUsd: number; feesUsd: number; feeSource: string; netExcludingFundingUsd: number; actualNetExcludingFundingUsd: number | null; actualDeltaToTriggerFloorUsd: number | null; deltaToTriggerFloorUsd: number | null; allPricesConfirmed: boolean; funding: "NOT_INCLUDED"; fills: Array<{ symbol: string; orderId: string; tradeId?: string; price: number; qty: number; commission: number; commissionAsset: string; realizedPnl: number; time: number; role: string }>; fillPagesComplete: boolean };
};
export function exitAuditEvent(b: ExecutorBasket, event: BasketExitAudit["events"][number]) {
  const a = b.exitAudit;
  if (!a) return;
  if (a.events.length < 512) a.events.push(event); else a.droppedEvents++;
}

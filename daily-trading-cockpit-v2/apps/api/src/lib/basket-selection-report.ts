import { basketProtectionSummary } from "./basket-protection-audit.js";
import { closedBasketRealizedBreakdown, type ExecutorBasket } from "./cross-sectional-executor.js";

/** Read only the basket's frozen formation evidence, never the latest formation or current policy. */
export function basketSelectionEvidence(basket: Pick<ExecutorBasket, "dynamicMom36">) {
  const evidence = basket.dynamicMom36?.recentStrengthPreference;
  if (!evidence || typeof evidence !== "object") return null;
  const row = evidence as Record<string, unknown>;
  if ((row.policyId !== "cross-preference-formation-v1" && row.policyId !== "cross-preference-shared-admission-v2" && row.policyId !== "cross-allocation-qualified-ranking-v1")
    || (row.selectionMode !== "BASELINE" && row.selectionMode !== "PREFERRED")) return null;
  return {
    policyId: row.policyId,
    selectionMode: row.selectionMode,
    reason: typeof row.reason === "string" ? row.reason : null,
  };
}

export function closedBasketSelectionReport(baskets: Parameters<typeof closedBasketRealizedBreakdown>[0]) {
  const protection = new Map(baskets.map(b => [b.basketId, { protectionSummary: basketProtectionSummary(b), exitAudit: b.exitAudit ?? null }]));
  const evidence = new Map(baskets.map((basket) => [basket.basketId, basketSelectionEvidence(basket)]));
  return closedBasketRealizedBreakdown(baskets).map((basket) => ({
    ...basket,
    ...protection.get(basket.basketId),
    recentStrengthPreference: evidence.get(basket.basketId) ?? null,
  }));
}

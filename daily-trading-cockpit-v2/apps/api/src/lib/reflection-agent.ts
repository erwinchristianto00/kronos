import type { ReflectionCode, ShadowCloseReason, VariantSelectionSnapshot } from "@dtc/shared";

export interface ReflectionInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  closeReason: ShadowCloseReason;
  realizedNetR: number | null;
  realizedGrossR: number | null;
  filled: boolean;
  plan: VariantSelectionSnapshot | null;
  symbolNetAvgR?: number | null;
  sideNetAvgR?: number | null;
  variantNetAvgR?: number | null;
  kronosHorizonConflict?: boolean;
  kronosAgreed?: boolean;
  whaleAgreed?: boolean;
  whaleDisagreed?: boolean;
}

export function classifyReflection(input: ReflectionInput): ReflectionCode[] {
  const codes: ReflectionCode[] = [];

  if (!input.filled) {
    codes.push("NO_FILL_RESEARCH");
    return codes;
  }

  const netR = input.realizedNetR ?? 0;

  if (input.closeReason === "TP1_FULL" || input.closeReason === "TP2" || input.closeReason === "TP3") {
    if (netR > 0) codes.push("GOOD_TP1_CAPTURE");
    if (netR > 0) codes.push("PROFITABLE_AFTER_COST");
    if (netR <= 0) codes.push("TP1_NOT_PROFITABLE_AFTER_COST");
  }

  if (input.closeReason === "SL") {
    if ((input.plan?.stopDistanceBps ?? 0) > 0 && (input.plan?.stopDistanceBps ?? 999) < 18) {
      codes.push("STOP_TOO_TIGHT");
    }
    if ((input.plan?.chaseRisk ?? "LOW") === "HIGH") {
      codes.push("CHASE_ENTRY");
    }
  }

  if (
    (input.closeReason === "TRAIL_STOP" || input.closeReason === "BREAKEVEN") &&
    netR < (input.plan?.expectedNetR ?? 0)
  ) {
    codes.push("RUNNER_GIVEBACK");
  }

  if ((input.symbolNetAvgR ?? 0) <= -0.05) codes.push("SYMBOL_TOXIC");
  if ((input.sideNetAvgR ?? 0) <= -0.15) codes.push("SIDE_TOXIC");
  if ((input.variantNetAvgR ?? 0) <= -0.05) codes.push("VARIANT_TOXIC");

  if (input.kronosHorizonConflict && netR < 0) codes.push("KRONOS_CONFLICT_IGNORED");
  if (input.whaleDisagreed && netR < 0) codes.push("WHALE_CONFLICT_IGNORED");

  if ((input.plan?.costR ?? 0) >= 0.45 && netR <= 0) codes.push("COST_R_TOO_HIGH");

  return codes;
}

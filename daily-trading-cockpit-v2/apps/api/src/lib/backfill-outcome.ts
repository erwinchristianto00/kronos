/**
 * Historical backfill — outcome / label computation (Phase 4 / requirement #4). From a normalized
 * HistoricalOutcome (a counterfactual/paper close — NEVER a live fill), produce netR-after-cost and the win
 * label under the EXISTING 0.03R economic hurdle (reused from cortex-brain, so the historical label is
 * definitionally identical to the live one). Two supported source shapes:
 *   • native-R  — the source already stores netR in R (paper-execution): use it directly.
 *   • return-based — the source stores grossR/costR as RETURNS + a frozen riskDistanceAtOpen (XSEC):
 *     netReturn = grossR − costR; netR = netReturn ÷ riskDistanceAtOpen.
 * A missing / non-finite / ≤0 risk denominator on the return-based path is REJECTED (never divide by it, never
 * fabricate a denominator). Pure + deterministic.
 */
import { CORTEX_WIN_HURDLE_R, cortexWinLabel } from "./cortex-brain.js";
import type { HistoricalOutcome, RiskDenominatorSource } from "./backfill-schema.js";

export { CORTEX_WIN_HURDLE_R };

export interface OutcomeOpts {
  /** Sensitivity: for rows whose denominator is GLOBAL_CONSTANT_ASSUMED, use this denominator instead of the
   *  stored one — lets the runner sweep 20/30/40 bps and measure how many labels flip. Ignored for rows whose
   *  denominator was RECORDED_AT_OPEN (those are not assumptions to sweep). */
  assumedDenominatorOverride?: number;
}

export type OutcomeRejectReason =
  | "no-netR-and-no-return-components"
  | "cost-missing"
  | "cost-nonfinite"
  | "risk-denominator-missing"
  | "risk-denominator-nonfinite"
  | "risk-denominator-nonpositive"
  | "netR-nonfinite"
  | "contradictory-native-denominator"; // native netR present but a provided riskDistance is itself corrupt (≤0)

export interface OutcomeLabel {
  ok: true;
  netR: number;
  /** Win label under the 0.03R hurdle: a fee-scratch is NOT a win. */
  y: 0 | 1;
  riskDenominator: number | null;
  denominatorProvenance: "native" | "riskDistanceAtOpen";
  /** Provenance of the risk value used (recorded vs assumed constant). Carries through from the outcome. */
  riskDenominatorSource: RiskDenominatorSource | null;
}
export interface OutcomeReject {
  ok: false;
  reason: OutcomeRejectReason;
}

export function computeOutcomeR(o: HistoricalOutcome, opts: OutcomeOpts = {}): OutcomeLabel | OutcomeReject {
  const source = o.riskDenominatorSource ?? null;
  // Sensitivity override applies ONLY to assumed-constant denominators, never to recorded-at-open values.
  const override = source === "GLOBAL_CONSTANT_ASSUMED" && typeof opts.assumedDenominatorOverride === "number" ? opts.assumedDenominatorOverride : null;
  const denom = override ?? o.riskDistanceAtOpen;
  const denomFinite = typeof denom === "number" && Number.isFinite(denom);

  // ── Native-R path: the source already normalized to R. ──
  if (typeof o.netR === "number" && Number.isFinite(o.netR)) {
    // If a denominator is ALSO carried, it must be self-consistent (>0); a ≤0/non-finite one signals a corrupt row.
    if (denom != null && (!denomFinite || (denom as number) <= 0)) return { ok: false, reason: "contradictory-native-denominator" };
    return { ok: true, netR: o.netR, y: cortexWinLabel(o.netR), riskDenominator: denomFinite ? (denom as number) : null, denominatorProvenance: "native", riskDenominatorSource: source };
  }

  // ── Return-based path: need grossR − costR ÷ frozen riskDistanceAtOpen. ──
  const gross = o.grossR;
  const cost = o.costR;
  if (typeof gross !== "number" || !Number.isFinite(gross)) return { ok: false, reason: "no-netR-and-no-return-components" };
  // A return-based row has no native net R. Treating unavailable execution
  // cost as zero fabricates profitability and is forbidden for learning.
  if (cost == null) return { ok: false, reason: "cost-missing" };
  if (typeof cost !== "number" || !Number.isFinite(cost)) return { ok: false, reason: "cost-nonfinite" };
  if (denom == null) return { ok: false, reason: "risk-denominator-missing" };
  if (!denomFinite) return { ok: false, reason: "risk-denominator-nonfinite" };
  if ((denom as number) <= 0) return { ok: false, reason: "risk-denominator-nonpositive" };
  const netReturn = gross - cost;
  const netR = netReturn / (denom as number);
  if (!Number.isFinite(netR)) return { ok: false, reason: "netR-nonfinite" };
  return { ok: true, netR, y: cortexWinLabel(netR), riskDenominator: denom as number, denominatorProvenance: "riskDistanceAtOpen", riskDenominatorSource: source };
}

/** Whether the source-recorded cost is present (fee/slippage availability, for the audit + classification). */
export function hasCostComponent(o: HistoricalOutcome): boolean {
  return typeof o.costR === "number" && Number.isFinite(o.costR);
}

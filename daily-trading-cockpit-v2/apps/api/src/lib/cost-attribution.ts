import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * ENTRY FILL & COST ATTRIBUTION
 *
 * Read-only diagnostic that isolates cost composition (model-assumed vs
 * realized) and entry fill quality. Directly answers the COST_DRAG and
 * SYMBOL_DRAG flags produced by profit-anatomy.ts.
 *
 * Key questions answered:
 *   1. Is the cost model under-estimating actual trade costs?
 *   2. Which symbols have the worst cost overrun?
 *   3. Is entry drift (filling at the wrong price) compounding costs?
 *   4. Does stop-distance width drive R-denominated cost variance?
 *
 * Does NOT change:
 *   - routing, routeMode, variant selection
 *   - shadow fills or exits
 *   - live readiness gates or scanner ranking
 *   - calibration logic
 */

export type CostAttributionEraFilter = "POST_CALIBRATION" | "ALL";

export type CostFlag =
  | "COST_MODEL_UNDERESTIMATED"   // actual cost >> model cost
  | "COST_MODEL_ACCURATE"         // within ±30%
  | "HIGH_SPREAD_COST"            // spread is dominant cost driver
  | "ENTRY_DRIFT_ELEVATED"        // avg entry drift is high
  | "NARROW_STOP_DISTANCE"        // tight stops inflate R-denominated cost
  | "SYMBOL_COST_OUTLIER"         // one symbol has disproportionate cost
  | "CHASE_RISK_ELEVATED";        // many positions flagged HIGH chase risk

export type CostFlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface CostAttributionFlag {
  code: CostFlag;
  severity: CostFlagSeverity;
  message: string;
}

export interface SymbolCostRow {
  symbol: string;
  closedCount: number;
  /** Average (realizedGrossR − realizedNetR) per closed variant. */
  avgActualCostR: number | null;
  /** Average variantSelection.costR at entry time (model assumption). */
  avgModelCostR: number | null;
  /** avgActualCostR − avgModelCostR: positive = paying more than expected. */
  overrunR: number | null;
  /** overrunR / avgModelCostR (null if no model data). */
  overrunPct: number | null;
  avgStopDistanceBps: number | null;
  avgSpreadR: number | null;
  avgFeeSlippageR: number | null;
  /** Net R contribution for context. */
  totalNetRContribution: number;
}

export interface EntryFillQuality {
  /** Positions with `entryState === "FILLED"` and drift data. */
  positionsWithFillData: number;
  avgEntryDriftPct: number | null;
  avgEntryDriftAtr: number | null;
  avgStopDistanceBps: number | null;
  /** Fraction of positions with chaseRisk === "HIGH". */
  highChaseRiskRate: number | null;
  /** Distribution of entryFillReason strings. */
  fillReasonDistribution: Record<string, number>;
  /** How many positions have HIGH drift (driftPct > 50%). */
  highDriftCount: number;
}

export interface CostAttributionSummary {
  eraFilter: CostAttributionEraFilter;
  positionCount: number;
  closedVariantCount: number;
  /** Average (grossR − netR) per closed variant — the realized cost in R. */
  avgActualCostR: number | null;
  /** Average model-assumed costR from variantSelection. */
  avgModelCostR: number | null;
  /** Average model-assumed spreadR from variantSelection. */
  avgModelSpreadR: number | null;
  /** Average model-assumed feeSlippageR from variantSelection. */
  avgModelFeeSlippageR: number | null;
  /** Absolute gap: avgActualCostR − avgModelCostR. */
  costOverrunR: number | null;
  /** costOverrunR / avgModelCostR (negative = paying less than model). */
  costOverrunPct: number | null;
  /** True if actual is within ±30% of model. */
  costModelCalibrated: boolean;
  /** Whether cost data is present at all. */
  hasCostData: boolean;
}

export interface CostAttributionReport {
  generatedAt: string;
  summary: CostAttributionSummary;
  bySymbol: SymbolCostRow[];
  entryFillQuality: EntryFillQuality;
  flags: CostAttributionFlag[];
  interpretation: string;
  notes: string[];
}

export interface CostAttributionInput {
  positions: ShadowPosition[];
  eraFilter?: CostAttributionEraFilter;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function closedVariants(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildCostAttributionReport(
  input: CostAttributionInput,
  now: Date = new Date(),
): CostAttributionReport {
  const generatedAt = now.toISOString();
  const eraFilter: CostAttributionEraFilter = input.eraFilter ?? "POST_CALIBRATION";

  // Era filter
  const filtered =
    eraFilter === "ALL"
      ? input.positions
      : input.positions.filter((p) => classifyEvidenceEra(p) === "POST_CALIBRATION");

  // ── Summary cost stats ──────────────────────────────────────────────────────
  // realizedCostR per closed variant = grossR − netR
  const realizedCosts: number[] = [];
  const modelCosts: number[] = [];
  const modelSpreads: number[] = [];
  const modelFeeSlippage: number[] = [];

  let closedVariantCount = 0;

  for (const p of filtered) {
    const cvs = closedVariants(p);
    if (cvs.length === 0) continue;

    // Model costs come from the position-level fields (stamped at entry time).
    // We prefer position-level over variantSelection since that's what was
    // actually applied when the trade was opened.
    const modelCostR =
      p.costR ?? p.variantSelection?.costR ?? null;
    const modelSpreadR =
      p.spreadR ?? p.variantSelection?.spreadR ?? null;
    const modelFeeSlippageR =
      p.feeSlippageR ?? p.variantSelection?.feeSlippageR ?? null;

    for (const v of cvs) {
      closedVariantCount += 1;
      const realizedCost = v.realizedGrossR - v.realizedNetR;
      realizedCosts.push(realizedCost);

      // Only push model data if available (not all positions have cost fields)
      if (modelCostR !== null) modelCosts.push(modelCostR);
      if (modelSpreadR !== null) modelSpreads.push(modelSpreadR);
      if (modelFeeSlippageR !== null) modelFeeSlippage.push(modelFeeSlippageR);
    }
  }

  const avgActualCostR = mean(realizedCosts);
  const avgModelCostR = mean(modelCosts);
  const avgModelSpreadR = mean(modelSpreads);
  const avgModelFeeSlippageR = mean(modelFeeSlippage);

  const costOverrunR =
    avgActualCostR !== null && avgModelCostR !== null
      ? r4(avgActualCostR - avgModelCostR)
      : null;
  const costOverrunPct =
    costOverrunR !== null && avgModelCostR !== null && avgModelCostR !== 0
      ? r4(costOverrunR / Math.abs(avgModelCostR))
      : null;
  const costModelCalibrated =
    costOverrunPct !== null ? Math.abs(costOverrunPct) <= 0.30 : true;
  const hasCostData = modelCosts.length > 0;

  // ── Per-symbol cost breakdown ───────────────────────────────────────────────
  const symbolMap = new Map<
    string,
    {
      realizedCosts: number[];
      modelCosts: number[];
      stopBps: number[];
      spreads: number[];
      feeSlippages: number[];
      totalNetR: number;
      closedCount: number;
    }
  >();

  for (const p of filtered) {
    const cvs = closedVariants(p);
    if (cvs.length === 0) continue;

    const sym = p.symbol;
    const entry = symbolMap.get(sym) ?? {
      realizedCosts: [], modelCosts: [], stopBps: [],
      spreads: [], feeSlippages: [], totalNetR: 0, closedCount: 0,
    };

    const modelCostR = p.costR ?? p.variantSelection?.costR ?? null;
    const modelSpreadR = p.spreadR ?? p.variantSelection?.spreadR ?? null;
    const modelFeeSlippageR = p.feeSlippageR ?? p.variantSelection?.feeSlippageR ?? null;
    const stopBps = p.stopDistanceBps ?? p.variantSelection?.stopDistanceBps ?? null;

    for (const v of cvs) {
      entry.closedCount += 1;
      entry.realizedCosts.push(v.realizedGrossR - v.realizedNetR);
      entry.totalNetR += v.realizedNetR;
      if (modelCostR !== null) entry.modelCosts.push(modelCostR);
      if (modelSpreadR !== null) entry.spreads.push(modelSpreadR);
      if (modelFeeSlippageR !== null) entry.feeSlippages.push(modelFeeSlippageR);
    }
    if (stopBps !== null) entry.stopBps.push(stopBps);
    symbolMap.set(sym, entry);
  }

  const bySymbol: SymbolCostRow[] = [];
  for (const [symbol, data] of symbolMap) {
    const avgActual = mean(data.realizedCosts);
    const avgModel = mean(data.modelCosts);
    const overrun =
      avgActual !== null && avgModel !== null ? r4(avgActual - avgModel) : null;
    const overrunPct =
      overrun !== null && avgModel !== null && avgModel !== 0
        ? r4(overrun / Math.abs(avgModel))
        : null;

    bySymbol.push({
      symbol,
      closedCount: data.closedCount,
      avgActualCostR: avgActual,
      avgModelCostR: avgModel,
      overrunR: overrun,
      overrunPct,
      avgStopDistanceBps: mean(data.stopBps),
      avgSpreadR: mean(data.spreads),
      avgFeeSlippageR: mean(data.feeSlippages),
      totalNetRContribution: r4(data.totalNetR),
    });
  }
  // Sort by worst total net R contribution (most negative first = biggest drag)
  bySymbol.sort((a, b) => a.totalNetRContribution - b.totalNetRContribution);

  // ── Entry fill quality ──────────────────────────────────────────────────────
  const driftPcts: number[] = [];
  const driftAtrs: number[] = [];
  const stopBpsAll: number[] = [];
  let positionsWithFillData = 0;
  let highChaseRiskCount = 0;
  let positionsWithChaseData = 0;
  let highDriftCount = 0;
  const fillReasonDistribution: Record<string, number> = {};

  for (const p of filtered) {
    const sel = p.variantSelection;
    if (!sel) continue;

    // Chase risk
    if (sel.chaseRisk) {
      positionsWithChaseData += 1;
      if (sel.chaseRisk === "HIGH") highChaseRiskCount += 1;
    }

    // Stop distance
    const stopBps = p.stopDistanceBps ?? sel.stopDistanceBps ?? null;
    if (stopBps !== null) stopBpsAll.push(stopBps);

    // Fill quality
    const driftPct = sel.entryDriftPct;
    const driftAtr = sel.entryDriftAtr;
    if (driftPct !== null && driftPct !== undefined) {
      positionsWithFillData += 1;
      driftPcts.push(Math.abs(driftPct));
      if (Math.abs(driftPct) > 0.5) highDriftCount += 1;
    }
    if (driftAtr !== null && driftAtr !== undefined) {
      driftAtrs.push(Math.abs(driftAtr));
    }

    // Fill reason
    const reason = p.entryFillReason ?? "unknown";
    fillReasonDistribution[reason] = (fillReasonDistribution[reason] ?? 0) + 1;
  }

  const entryFillQuality: EntryFillQuality = {
    positionsWithFillData,
    avgEntryDriftPct: mean(driftPcts),
    avgEntryDriftAtr: mean(driftAtrs),
    avgStopDistanceBps: mean(stopBpsAll),
    highChaseRiskRate:
      positionsWithChaseData > 0
        ? r4(highChaseRiskCount / positionsWithChaseData)
        : null,
    fillReasonDistribution,
    highDriftCount,
  };

  // ── Flags ──────────────────────────────────────────────────────────────────
  const flags: CostAttributionFlag[] = [];

  if (hasCostData) {
    if (!costModelCalibrated && costOverrunPct !== null && costOverrunPct > 0.3) {
      flags.push({
        code: "COST_MODEL_UNDERESTIMATED",
        severity: costOverrunPct > 1.0 ? "CRITICAL" : "WARN",
        message:
          `Model assumed avg ${avgModelCostR?.toFixed(4) ?? "n/a"}R per trade, but actual realized cost ` +
          `is ${avgActualCostR?.toFixed(4) ?? "n/a"}R — ${(costOverrunPct * 100).toFixed(0)}% overrun. ` +
          `Cost assumptions in the model are stale or miss slippage on this symbol set.`,
      });
    } else if (costModelCalibrated) {
      flags.push({
        code: "COST_MODEL_ACCURATE",
        severity: "INFO",
        message:
          `Model cost (${avgModelCostR?.toFixed(4) ?? "n/a"}R) is within ±30% of ` +
          `actual realized cost (${avgActualCostR?.toFixed(4) ?? "n/a"}R). Cost model is calibrated.`,
      });
    }

    // Spread dominance: if spread > 50% of total model cost
    if (
      avgModelSpreadR !== null &&
      avgModelCostR !== null &&
      avgModelCostR > 0 &&
      avgModelSpreadR / avgModelCostR > 0.5
    ) {
      flags.push({
        code: "HIGH_SPREAD_COST",
        severity: "WARN",
        message:
          `Spread accounts for ${((avgModelSpreadR / avgModelCostR) * 100).toFixed(0)}% of total model cost ` +
          `(${avgModelSpreadR.toFixed(4)}R spread vs ${avgModelCostR.toFixed(4)}R total). ` +
          `Consider scanning during tighter spread windows.`,
      });
    }
  } else {
    // No model cost data in positions at all — pre-calibration-era data or missing fields
    if (avgActualCostR !== null) {
      flags.push({
        code: "COST_MODEL_UNDERESTIMATED",
        severity: "INFO",
        message:
          `Actual realized cost is ${avgActualCostR.toFixed(4)}R per trade, but positions lack ` +
          `model cost fields (costR/spreadR/feeSlippageR). Cannot compute overrun without model data.`,
      });
    }
  }

  // Entry drift
  if (
    entryFillQuality.avgEntryDriftPct !== null &&
    entryFillQuality.avgEntryDriftPct > 0.3
  ) {
    flags.push({
      code: "ENTRY_DRIFT_ELEVATED",
      severity: entryFillQuality.avgEntryDriftPct > 0.6 ? "WARN" : "INFO",
      message:
        `Average entry drift is ${(entryFillQuality.avgEntryDriftPct * 100).toFixed(1)}% of the zone ` +
        `(${entryFillQuality.highDriftCount} positions with drift > 50%). ` +
        `Fills at the edge of the entry zone inflate cost and worsen risk/reward.`,
    });
  }

  // Narrow stop distance
  if (
    entryFillQuality.avgStopDistanceBps !== null &&
    entryFillQuality.avgStopDistanceBps < 100
  ) {
    flags.push({
      code: "NARROW_STOP_DISTANCE",
      severity: "WARN",
      message:
        `Average stop distance is ${entryFillQuality.avgStopDistanceBps.toFixed(0)}bps — below 100bps. ` +
        `Tight stops amplify R-denominated cost: a fixed fee of ~10bps becomes ~0.10R at a 100bps stop. ` +
        `Consider using wider, more structurally meaningful stop levels.`,
    });
  }

  // Symbol cost outlier
  const outlierSymbol = bySymbol.find(
    (s) =>
      s.closedCount >= 3 &&
      s.overrunPct !== null &&
      Math.abs(s.overrunPct) > 1.0,
  );
  if (outlierSymbol) {
    flags.push({
      code: "SYMBOL_COST_OUTLIER",
      severity: "WARN",
      message:
        `${outlierSymbol.symbol} has a cost overrun of ${(outlierSymbol.overrunPct! * 100).toFixed(0)}% ` +
        `(model: ${outlierSymbol.avgModelCostR?.toFixed(4) ?? "n/a"}R, ` +
        `actual: ${outlierSymbol.avgActualCostR?.toFixed(4) ?? "n/a"}R). ` +
        `Symbol-specific spread or slippage profile differs significantly from the model.`,
    });
  }

  // Chase risk
  if (
    entryFillQuality.highChaseRiskRate !== null &&
    entryFillQuality.highChaseRiskRate > 0.25
  ) {
    flags.push({
      code: "CHASE_RISK_ELEVATED",
      severity: "WARN",
      message:
        `${(entryFillQuality.highChaseRiskRate * 100).toFixed(0)}% of positions were flagged HIGH chase risk ` +
        `at entry. High-chase entries tend to fill above the zone midpoint, reducing effective R.`,
    });
  }

  // ── Interpretation ──────────────────────────────────────────────────────────
  let interpretation: string;
  const critical = flags.filter((f) => f.severity === "CRITICAL");
  const warns = flags.filter((f) => f.severity === "WARN");

  if (!hasCostData && closedVariantCount === 0) {
    interpretation =
      "No POST_CALIBRATION closed trades with cost data yet. Report will populate as shadow trades close.";
  } else if (!hasCostData) {
    const actualStr = avgActualCostR !== null ? `${avgActualCostR.toFixed(4)}R` : "unknown";
    interpretation =
      `Realized cost per trade is ${actualStr} (gross − net). Model cost fields are missing from ` +
      `positions — likely pre-cost-stamping era data. Once new positions with costR fields close, ` +
      `overrun analysis will become available.`;
  } else if (critical.length > 0) {
    interpretation =
      `Cost model is significantly underestimating actual trade costs. ` +
      `Model assumes ${avgModelCostR?.toFixed(4) ?? "n/a"}R per trade but realizes ` +
      `${avgActualCostR?.toFixed(4) ?? "n/a"}R — the difference ` +
      `(${costOverrunR?.toFixed(4) ?? "n/a"}R/trade) is being silently absorbed by strategy P&L. ` +
      `Cost assumptions need recalibration.`;
  } else if (costModelCalibrated) {
    interpretation =
      `Cost model is well-calibrated (actual within ±30% of model). The P&L loss is driven by ` +
      `strategy performance (low win rate, high SL rate, or poor risk/reward), not cost misaccounting.` +
      (warns.length > 0 ? ` Monitor: ${warns.map((f) => f.code).join(", ")}.` : "");
  } else {
    interpretation =
      `Cost model has a ${((costOverrunPct ?? 0) * 100).toFixed(0)}% overrun. Some of the net P&L ` +
      `loss is explained by underestimated costs. Review cost assumptions.`;
  }

  return {
    generatedAt,
    summary: {
      eraFilter,
      positionCount: filtered.length,
      closedVariantCount,
      avgActualCostR,
      avgModelCostR,
      avgModelSpreadR,
      avgModelFeeSlippageR,
      costOverrunR,
      costOverrunPct,
      costModelCalibrated,
      hasCostData,
    },
    bySymbol,
    entryFillQuality,
    flags,
    interpretation,
    notes: [
      "Cost Attribution is read-only. It does not change routing, execution, calibration, or live readiness.",
      "actualCostR = realizedGrossR − realizedNetR per closed variant.",
      "modelCostR = position.costR ?? variantSelection.costR (the cost assumed when the trade was entered).",
      "costOverrunR = actualCostR − modelCostR. Positive means the model underestimates real costs.",
      "Narrow stop distances amplify R-denominated cost — the same absolute fee is a larger fraction of 1R.",
    ],
  };
}

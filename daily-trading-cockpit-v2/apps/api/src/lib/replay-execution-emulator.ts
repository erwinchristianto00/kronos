/**
 * Historical replay — execution emulator (Phase 5, Levels 0–1). STANDALONE from strategy logic: it turns an
 * order request + realized-path facts into a `SimulatedExecution` with spread / slippage / fee / funding costs
 * in R. It never assumes every valid signal fills — a market order can partially fill, a limit can stay
 * UNFILLED, and a costs-in-R conversion requires a valid risk denominator (≤0 ⇒ R costs are null, never
 * fabricated). Level 2 (depth/queue/impact) requires Tier-C order-book data and is intentionally not emulated
 * here (a mandatory-stop item). Pure + deterministic.
 */

export type ExecutionRealismLevel = 0 | 1 | 2;

export interface EmulatorConfig {
  level: ExecutionRealismLevel;
  spreadBps: number; // full bid/ask spread
  latencyMs: number;
  takerFeeBps: number;
  makerFeeBps: number;
  /** Basic slippage beyond half-spread (Level 1), in bps of reference price. */
  slippageBps: number;
  /** A limit order not touched within this budget EXPIREs. */
  expireMs?: number;
}

export interface OrderRequest {
  orderId: string;
  decisionId: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_LIMIT";
  requestedQty: number;
  referencePrice: number;
  limitPrice?: number;
  /** Stop distance in PRICE units at open — the R denominator. ≤0/non-finite ⇒ R costs are null. */
  riskDistancePrice: number;
  submittedAtMs: number;
  // ── realized-path facts supplied by the replay (NOT decision inputs; they describe what happened after submit)
  /** Did the market reach the limit within the order's life? (for LIMIT/STOP_LIMIT fills) */
  limitTouched?: boolean;
  /** Realized fillable fraction 0..1 (depth-limited); default 1 for a market order at Level ≤1. */
  fillableFraction?: number;
  fundingR?: number | null;
}

export interface SimulatedExecution {
  orderId: string;
  decisionId: string;
  submittedAtMs: number;
  exchangeArrivedAtMs: number;
  filledAtMs: number | null;
  requestedQty: number;
  filledQty: number;
  referencePrice: number;
  averageFillPrice: number | null;
  spreadCostR: number | null;
  slippageR: number | null;
  feeR: number | null;
  fundingR: number | null;
  status: "FILLED" | "PARTIAL" | "UNFILLED" | "REJECTED" | "EXPIRED";
}

const toR = (priceCost: number, riskDistancePrice: number): number | null =>
  Number.isFinite(riskDistancePrice) && riskDistancePrice > 0 && Number.isFinite(priceCost) ? priceCost / riskDistancePrice : null;

export function simulateExecution(o: OrderRequest, cfg: EmulatorConfig): SimulatedExecution {
  const arrived = o.submittedAtMs + (cfg.level >= 1 ? Math.max(0, cfg.latencyMs) : 0);
  const dir = o.side === "BUY" ? 1 : -1;
  const ref = o.referencePrice;
  const base: SimulatedExecution = {
    orderId: o.orderId, decisionId: o.decisionId, submittedAtMs: o.submittedAtMs, exchangeArrivedAtMs: arrived,
    filledAtMs: null, requestedQty: o.requestedQty, filledQty: 0, referencePrice: ref,
    averageFillPrice: null, spreadCostR: null, slippageR: null, feeR: null, fundingR: o.fundingR ?? null, status: "UNFILLED",
  };
  if (!Number.isFinite(ref) || ref <= 0 || !(o.requestedQty > 0)) return { ...base, status: "REJECTED" };

  // ── Level 0: idealized — fill at reference, fees only. Debug baseline. ──
  if (cfg.level === 0) {
    const feePrice = ref * (cfg.takerFeeBps / 10_000);
    return { ...base, filledAtMs: arrived, filledQty: o.requestedQty, averageFillPrice: ref, spreadCostR: 0, slippageR: 0, feeR: toR(feePrice, o.riskDistancePrice), status: "FILLED" };
  }

  // ── Level 2 needs order-book depth/queue (Tier C) — not emulated here. ──
  if (cfg.level === 2) return { ...base, status: "REJECTED" }; // caller must route Level-2 to a Tier-C emulator

  // ── Level 1: spread + latency + fee + basic slippage. Market fills; limit needs a touch. ──
  const halfSpread = ref * (cfg.spreadBps / 10_000) / 2;
  const slip = ref * (cfg.slippageBps / 10_000);
  const frac = Math.max(0, Math.min(1, o.fillableFraction ?? 1));

  if (o.type === "LIMIT" || o.type === "STOP_LIMIT") {
    if (!o.limitTouched) return { ...base, status: (cfg.expireMs != null ? "EXPIRED" : "UNFILLED") };
    const fillPrice = o.limitPrice ?? ref;
    const feePrice = fillPrice * (cfg.makerFeeBps / 10_000); // resting limit = maker
    const qty = o.requestedQty * frac;
    return {
      ...base, filledAtMs: arrived, filledQty: qty, averageFillPrice: fillPrice,
      spreadCostR: 0, slippageR: 0, feeR: toR(feePrice, o.riskDistancePrice), // limit at its price: no spread/slip cost
      status: frac >= 1 ? "FILLED" : frac > 0 ? "PARTIAL" : "UNFILLED",
    };
  }

  // Market order (taker): pay half-spread + slippage in the adverse direction.
  const fillPrice = ref + dir * (halfSpread + slip);
  const feePrice = fillPrice * (cfg.takerFeeBps / 10_000);
  const qty = o.requestedQty * frac;
  return {
    ...base, filledAtMs: arrived, filledQty: qty, averageFillPrice: fillPrice,
    spreadCostR: toR(halfSpread, o.riskDistancePrice), slippageR: toR(slip, o.riskDistancePrice), feeR: toR(feePrice, o.riskDistancePrice),
    status: frac >= 1 ? "FILLED" : frac > 0 ? "PARTIAL" : "UNFILLED",
  };
}

/** Total round-trip execution cost in R (spread+slip+fee+funding), null-safe. */
export function totalExecutionCostR(e: SimulatedExecution): number {
  return (e.spreadCostR ?? 0) + (e.slippageR ?? 0) + (e.feeR ?? 0) + (e.fundingR ?? 0);
}

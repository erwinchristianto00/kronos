/**
 * Narrow, auditable repair for a historical maker-entry accounting defect.
 *
 * This is NOT an alternate partial-basket admission path. The normal executor
 * must reject/reconcile an inconclusive maker entry. This helper may be used
 * only after an operator explicitly accepts an already-open reduced basket and
 * the persisted leg has the exact impossible signature the old bug created.
 */
import type {
  ExecutorBasket,
  ExecutorLeg,
  OperatorAcceptedPartialBasketException,
  PlannedLeg,
} from "./cross-sectional-executor.js";

export type MissingLegExceptionInput = {
  approvedAt: string;
  symbol: string;
  reason: string;
};

export type MissingLegExceptionResult = {
  reservationId: string | null;
  removedLeg: Pick<ExecutorLeg, "symbol" | "side" | "qty" | "planIndex">;
  exception: OperatorAcceptedPartialBasketException;
};

function exactUnknownMakerPhantom(plan: PlannedLeg, leg: ExecutorLeg): boolean {
  return plan.status === "FILLED" &&
    plan.makerOutcome?.action === "UNKNOWN_REQUERY" &&
    plan.makerOutcome.makerQty === 0 &&
    plan.makerOutcome.takerQty === 0 &&
    leg.entryPriceConfirmed === false &&
    leg.entryLiquidity?.makerQty === 0 &&
    leg.entryLiquidity?.takerQty === 0 &&
    Math.abs(leg.qty - plan.requestedQty) <= 1e-9;
}

/**
 * Removes only the fabricated leg and stamps a permanent operator exception.
 * Throws before mutation unless the basket matches the exact historical bug,
 * so it cannot be repurposed to silently reshape an ordinary live basket.
 */
export function acceptVerifiedMissingLegException(
  basket: ExecutorBasket,
  input: MissingLegExceptionInput,
): MissingLegExceptionResult {
  if (basket.status !== "COMPLETE") {
    throw new Error(`basket ${basket.basketId} is ${basket.status}, not a completed legacy phantom basket`);
  }
  if (basket.operatorException) {
    throw new Error(`basket ${basket.basketId} already has an operator exception`);
  }
  if (!Array.isArray(basket.plan)) {
    throw new Error(`basket ${basket.basketId} has no durable plan`);
  }
  const symbol = input.symbol.trim().toUpperCase();
  const legIndex = basket.legs.findIndex((leg) => leg.symbol.toUpperCase() === symbol && leg.exitOrderId === null);
  if (legIndex < 0) throw new Error(`basket ${basket.basketId} has no open ${symbol} leg to verify`);
  const leg = basket.legs[legIndex]!;
  if (leg.planIndex === undefined) throw new Error(`basket ${basket.basketId} ${symbol} has no plan index`);
  const plan = basket.plan.find((candidate) => candidate.planIndex === leg.planIndex);
  if (!plan || plan.symbol.toUpperCase() !== symbol || plan.side !== leg.side || !exactUnknownMakerPhantom(plan, leg)) {
    throw new Error(`basket ${basket.basketId} ${symbol} does not match the verified UNKNOWN_REQUERY phantom signature`);
  }

  const missingLeg = {
    planIndex: plan.planIndex,
    symbol: plan.symbol,
    side: plan.side,
    requestedQty: plan.requestedQty,
    entryClientOrderId: plan.entryClientOrderId,
  } as const;
  const exception: OperatorAcceptedPartialBasketException = {
    kind: "OPERATOR_ACCEPTED_MISSING_LEG",
    approvedAt: input.approvedAt,
    reason: input.reason,
    missingLegs: [missingLeg],
  };

  // Mutate only after every validation above passed. `COMPLETE` remains the
  // exit-manager state for the five real legs; the exception is the explicit
  // record that this is NOT a normally completed 3L/3S basket.
  basket.legs.splice(legIndex, 1);
  plan.status = "FAILED";
  plan.failureReason = `OPERATOR_ACCEPTED_MISSING_LEG:${input.reason}`;
  basket.operatorException = exception;

  return {
    reservationId: plan.reservationId,
    removedLeg: { symbol: leg.symbol, side: leg.side, qty: leg.qty, planIndex: leg.planIndex },
    exception,
  };
}

import { describe, expect, it } from "vitest";
import { acceptVerifiedMissingLegException } from "../src/lib/cross-sectional-operator-exception.js";
import type { ExecutorBasket } from "../src/lib/cross-sectional-executor.js";

function basket(): ExecutorBasket {
  return {
    basketId: "xb-test-operator-exception",
    sourceObservationId: "xsec:test",
    signal: "MOM36_FILTERED",
    variant: "FILTERED",
    openedAt: "2026-08-22T00:00:00.000Z",
    closesAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
    status: "COMPLETE",
    closedAt: null,
    closeReason: null,
    grossPnlUsd: null,
    feeEstimateUsd: null,
    netPnlUsd: null,
    legs: [
      {
        symbol: "SOLUSDT", side: "LONG", qty: 1, entryPrice: 100, entryOrderId: "sol-entry",
        entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 0,
      },
      {
        symbol: "TAOUSDT", side: "SHORT", qty: 0.081, entryPrice: 229.44, entryOrderId: "tao-maker",
        entryPriceConfirmed: false, entryLiquidity: { makerQty: 0, takerQty: 0, reason: "non-terminal status NEW" },
        exitPrice: null, exitOrderId: null, exitPriceConfirmed: null, planIndex: 1,
      },
    ],
    plan: [
      {
        planIndex: 0, symbol: "SOLUSDT", side: "LONG", requestedQty: 1, refPrice: 100,
        reservationId: "res-sol", entryClientOrderId: "xsec-test-e0", status: "FILLED", failureReason: null,
      },
      {
        planIndex: 1, symbol: "TAOUSDT", side: "SHORT", requestedQty: 0.081, refPrice: 229.44,
        reservationId: "res-tao", entryClientOrderId: "xsec-test-e1", status: "FILLED", failureReason: null,
        makerOutcome: { action: "UNKNOWN_REQUERY", reason: "non-terminal status NEW", makerQty: 0, takerQty: 0 },
      },
    ],
  };
}

describe("operator-approved missing cross-sectional leg exception", () => {
  it("only accepts the exact historical zero-quantity UNKNOWN_REQUERY phantom and retains the real legs", () => {
    const candidate = basket();
    const result = acceptVerifiedMissingLegException(candidate, {
      approvedAt: "2026-08-22T02:23:39.000Z",
      symbol: "TAOUSDT",
      reason: "verified absent on exchange",
    });

    expect(result.reservationId).toBe("res-tao");
    expect(candidate.status).toBe("COMPLETE");
    expect(candidate.legs.map((leg) => leg.symbol)).toEqual(["SOLUSDT"]);
    expect(candidate.plan![1]).toMatchObject({ status: "FAILED", failureReason: expect.stringContaining("OPERATOR_ACCEPTED_MISSING_LEG") });
    expect(candidate.operatorException).toMatchObject({
      kind: "OPERATOR_ACCEPTED_MISSING_LEG",
      missingLegs: [{ symbol: "TAOUSDT", side: "SHORT", requestedQty: 0.081 }],
    });
  });

  it("refuses an ordinary unconfirmed or already-approved leg", () => {
    const candidate = basket();
    candidate.plan![1]!.makerOutcome!.action = "DONE";
    expect(() => acceptVerifiedMissingLegException(candidate, {
      approvedAt: "2026-08-22T02:23:39.000Z", symbol: "TAOUSDT", reason: "no",
    })).toThrow(/phantom signature/);
  });
});

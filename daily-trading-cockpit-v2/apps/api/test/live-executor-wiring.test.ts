import { describe, it, expect } from "vitest";
import { computeExternalManagedNetQty, isNewExecutorLaneAllowed, type LiveExecutorGateEngine } from "../src/lib/live-executor-wiring.js";
import type { CrossSectionalExecutor, ExecutorBasket } from "../src/lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";

function fakeEngine(over: Partial<LiveExecutorGateEngine> = {}): LiveExecutorGateEngine {
  return {
    isArmed: () => true,
    laneSelectionExplicitlyIncludesLane: () => true,
    laneSelectionAllowsLane: () => true,
    ...over,
  };
}

describe("isNewExecutorLaneAllowed", () => {
  it("testnet: allowed once explicitly included, even with no engine.isArmed() requirement", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", fakeEngine())).toBe(true);
  });

  it("testnet: still blocked if NOT explicitly included, even though armed is bypassed on testnet", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", fakeEngine({ laneSelectionExplicitlyIncludesLane: () => false }))).toBe(false);
  });

  it("mainnet: blocked when not armed, even if explicitly included", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", fakeEngine({ isArmed: () => false }))).toBe(false);
  });

  it("mainnet: blocked when armed but NOT explicitly included — the core 2026-07-08 audit fix", () => {
    // This is the exact regression the audit found: without requiring explicit inclusion, an
    // armed engine with NO allocation set at all (or one that simply doesn't happen to restrict
    // this lane) would let a never-before-executed lane trade at full size.
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", fakeEngine({ isArmed: () => true, laneSelectionExplicitlyIncludesLane: () => false }))).toBe(false);
  });

  it("mainnet: allowed when armed AND explicitly included AND allowed", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", fakeEngine())).toBe(true);
  });

  it("mainnet: blocked when explicitly included but laneSelectionAllowsLane independently refuses (defensive second check)", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", fakeEngine({ laneSelectionAllowsLane: () => false }))).toBe(false);
  });

  it("null engine: always blocked on mainnet (no engine to confirm armed/explicit against)", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", null)).toBe(false);
  });

  it("null engine: blocked on testnet too (explicit inclusion defaults to false with no engine)", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", null)).toBe(false);
  });
});

function fakeBasket(legs: ExecutorBasket["legs"]): ExecutorBasket {
  return {
    basketId: "b1", sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
    openedAt: "2026-07-08T00:00:00.000Z", closesAtMs: 0, legs, status: "OPEN",
    closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
}
function fakeLeg(symbol: string, side: "LONG" | "SHORT", qty: number, exitOrderId: number | null = null): ExecutorBasket["legs"][number] {
  return { symbol, side, qty, entryPrice: 1, entryOrderId: 1, entryPriceConfirmed: true, exitPrice: null, exitOrderId, exitPriceConfirmed: null };
}
function fakeXsecExecutor(baskets: ExecutorBasket[]): CrossSectionalExecutor {
  return { getStatus: () => ({ openBaskets: baskets }) } as unknown as CrossSectionalExecutor;
}
function fakePosition(symbol: string, direction: "LONG" | "SHORT", qty: number, exitOrderId: number | null = null): SingleSymbolPosition {
  return {
    positionId: "p1", sourceObservationId: "o1", symbol, direction, qty, entryPrice: 1, entryOrderId: 1,
    entryPriceConfirmed: true, stopPrice: 1, stopAlgoOrderId: null, stopFailureCount: 0, stopUnprotectedSinceIso: null,
    closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0, openedAt: "2026-07-08T00:00:00.000Z",
    status: "OPEN", closedAt: null, closeReason: null, exitPrice: null, exitOrderId, exitPriceConfirmed: null,
    grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
}
function fakeSingleSymbolExecutor(positions: SingleSymbolPosition[]): SingleSymbolLaneExecutor {
  return { getStatus: () => ({ openPositions: positions }) } as unknown as SingleSymbolLaneExecutor;
}

describe("computeExternalManagedNetQty", () => {
  it("sums LONG legs positive and SHORT legs negative across multiple cross-sectional executors", () => {
    const execA = fakeXsecExecutor([fakeBasket([fakeLeg("BTCUSDT", "LONG", 0.5), fakeLeg("ETHUSDT", "SHORT", 2)])]);
    const execB = fakeXsecExecutor([fakeBasket([fakeLeg("BTCUSDT", "LONG", 0.3)])]);
    const net = computeExternalManagedNetQty([execA, execB], []);
    expect(net.get("BTCUSDT")).toBeCloseTo(0.8, 9);
    expect(net.get("ETHUSDT")).toBeCloseTo(-2, 9);
  });

  it("sums LONG/SHORT single-symbol positions the same way, combined with cross-sectional legs on the SAME symbol", () => {
    const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("SOLUSDT", "SHORT", 10)])]);
    const single = fakeSingleSymbolExecutor([fakePosition("SOLUSDT", "LONG", 4)]);
    const net = computeExternalManagedNetQty([xsec], [single]);
    expect(net.get("SOLUSDT")).toBeCloseTo(-6, 9); // -10 (short leg) + 4 (long position)
  });

  it("excludes a leg/position whose exit is already in flight (exitOrderId set) — no longer a claim", () => {
    const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("BTCUSDT", "LONG", 1, 999)])]);
    const single = fakeSingleSymbolExecutor([fakePosition("ETHUSDT", "SHORT", 1, 888)]);
    const net = computeExternalManagedNetQty([xsec], [single]);
    expect(net.has("BTCUSDT")).toBe(false);
    expect(net.has("ETHUSDT")).toBe(false);
  });

  it("skips null executor slots without throwing (matches the shape of a disabled instance)", () => {
    const net = computeExternalManagedNetQty([null, fakeXsecExecutor([fakeBasket([fakeLeg("BTCUSDT", "LONG", 1)])])], [null]);
    expect(net.get("BTCUSDT")).toBeCloseTo(1, 9);
  });

  it("returns an empty map when everything is null or has no open legs/positions", () => {
    expect(computeExternalManagedNetQty([null, null], [null]).size).toBe(0);
    expect(computeExternalManagedNetQty([fakeXsecExecutor([])], [fakeSingleSymbolExecutor([])]).size).toBe(0);
  });
});

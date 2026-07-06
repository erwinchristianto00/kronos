import { describe, it, expect } from "vitest";
import {
  planRegimeFlipRescue,
  parseRegimeFlipRescueConfig,
  type RegimeFlipRescueConfig,
  type RescuePositionView,
} from "../src/lib/regime-flip-rescue.js";

const CFG: RegimeFlipRescueConfig = {
  enabled: true,
  minAgeMs: 60 * 60 * 1000,
  minLossUsd: 1,
  netFraction: 1,
  maxNotionalUsd: 250,
  targetUsd: 0,
  maxSymbols: 2,
  minAvailableBalanceUsd: 10,
  maxHoldMs: 0, // disabled by default in tests; opted into per-test
};

// A stuck XRPUSDT LONG opposing a SHORT regime, 2h old, -4.18 net, mark 1.04.
const STUCK_LONG = (over: Partial<RescuePositionView> = {}): RescuePositionView => ({
  symbol: "XRPUSDT",
  intentDirection: "LONG",
  positionAmt: 236.2,
  markPrice: 1.04,
  unrealizedUsd: -4.18,
  netAfterCostUsd: -4.72,
  openedAtMs: 0,
  inRescue: false,
  priorRealizedUsd: 0,
  ...over,
});

const NOW = 3 * 60 * 60 * 1000; // 3h

describe("planRegimeFlipRescue — flip side", () => {
  it("flips a stuck, red, old opposing LONG to a net SHORT", () => {
    const plan = planRegimeFlipRescue({
      config: { ...CFG, maxNotionalUsd: 1000 }, // high cap to exercise the uncapped sizing math
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(1);
    const f = plan.flips[0]!;
    expect(f.symbol).toBe("XRPUSDT");
    expect(f.side).toBe("SELL"); // regime-aligned (opposite of the stuck LONG)
    // netFraction 1 ⇒ sell origAbs + origAbs = 2× to net short by 1× the original long.
    expect(f.flipQty).toBeCloseTo(236.2 * 2, 6);
    expect(f.targetNetQty).toBeCloseTo(236.2, 6);
  });

  it("caps the flip qty to maxNotionalUsd", () => {
    // 2 × 236.2 × 1.04 ≈ 491 USDT > 250 cap ⇒ qty = 250 / 1.04.
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan.flips[0]!.flipQty).toBeCloseTo(250 / 1.04, 6);
    expect(plan.flips[0]!.reason).toMatch(/capped/);
    // The cap still leaves flipQty (240.38) > origAbs (236.2), so it DOES cross zero — but to a
    // smaller net than the uncapped 236.2 originally intended. targetNetQty must reflect what will
    // ACTUALLY be left after this capped order (240.38 - 236.2 ≈ 4.18), not the stale pre-cap intent.
    expect(plan.flips[0]!.targetNetQty).toBeCloseTo(250 / 1.04 - 236.2, 6);
  });

  it("SKIPS instead of flipping when the notional cap would not even cross zero (would only reduce, not flip, the stuck position)", () => {
    // origAbs=1000 @ markPrice=1.04 ⇒ orig notional 1040 USDT, already over the 250 cap on its own.
    // The old code would have capped flipQty to 250/1.04≈240.4 — LESS than origAbs=1000 — producing
    // an order that only reduces the stuck LONG to ~759.6, never crossing zero, while still being
    // recorded as a "flip" and (on the execution side) labeled rescue=true, losing the engine's
    // normal harvest/hard-cut protection for a position that is still fully opposing the regime.
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG({ positionAmt: 1000, netAfterCostUsd: -20 })],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]!.symbol).toBe("XRPUSDT");
    expect(plan.skips[0]!.reason).toMatch(/would not cross zero/);
  });

  it("flips a stuck SHORT to net LONG when the regime is LONG_ONLY (opposingDirection SHORT)", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "SHORT",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG({ intentDirection: "SHORT", positionAmt: -100, unrealizedUsd: -3, netAfterCostUsd: -3.4 })],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(1);
    expect(plan.flips[0]!.side).toBe("BUY"); // regime-aligned long
  });

  it("does NOT flip a position already aligned with the regime", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG", // regime is SHORT_ONLY; a SHORT position is regime-aligned
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG({ intentDirection: "SHORT", positionAmt: -100 })],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    // aligned positions are silently ignored (not even a skip)
    expect(plan.skips).toHaveLength(0);
  });

  it("skips when not red enough", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG({ netAfterCostUsd: -0.5 })], // > -1 minLoss
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    expect(plan.skips[0]!.reason).toMatch(/not red enough/);
  });

  it("skips when too fresh", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: 30 * 60 * 1000, // 30m < 60m min age
      availableBalanceUsd: 100,
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    expect(plan.skips[0]!.reason).toMatch(/too fresh/);
  });

  it("skips when available balance is below the floor", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 5, // < 10 floor
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    expect(plan.skips[0]!.reason).toMatch(/available/);
  });

  it("honours the maxSymbols budget across new flips and active rescues", () => {
    const plan = planRegimeFlipRescue({
      config: CFG, // maxSymbols 2
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 1000,
      positions: [
        STUCK_LONG({ symbol: "AAAUSDT" }),
        STUCK_LONG({ symbol: "BBBUSDT" }),
      ],
      activeRescueCount: 1, // one already in rescue ⇒ only 1 new flip allowed
    });
    expect(plan.flips).toHaveLength(1);
    expect(plan.skips.some((s) => s.reason.match(/slot cap/))).toBe(true);
  });

  it("does nothing when disabled", () => {
    const plan = planRegimeFlipRescue({
      config: { ...CFG, enabled: false },
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan).toEqual({ flips: [], flattens: [], skips: [] });
  });

  it("does not flip when the regime is non-directional, but reports a skip", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: null,
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [STUCK_LONG()],
      activeRescueCount: 0,
    });
    expect(plan.flips).toHaveLength(0);
    expect(plan.skips[0]!.reason).toMatch(/not directional/);
  });
});

describe("planRegimeFlipRescue — flatten side", () => {
  // After a flip, the symbol is net SHORT; priorRealized is the loss booked on the long's close.
  const IN_RESCUE = (over: Partial<RescuePositionView> = {}): RescuePositionView => ({
    symbol: "XRPUSDT",
    intentDirection: "LONG",
    positionAmt: -236.2, // now net short
    markPrice: 1.0,
    unrealizedUsd: 5.0,
    netAfterCostUsd: 4.7,
    openedAtMs: 0,
    inRescue: true,
    priorRealizedUsd: -4.72, // loss booked at flip
    ...over,
  });

  it("flattens when combined (priorRealized + current net) ≥ target", () => {
    // -4.72 + 4.7 = -0.02 < 0 ⇒ NOT yet; bump current to clear it.
    const plan = planRegimeFlipRescue({
      config: CFG, // target 0
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [IN_RESCUE({ unrealizedUsd: 5.5, netAfterCostUsd: 5.2 })], // -4.72 + 5.2 = 0.48 ≥ 0
      activeRescueCount: 1,
    });
    expect(plan.flattens).toHaveLength(1);
    const fl = plan.flattens[0]!;
    expect(fl.side).toBe("BUY"); // reduce a net short
    expect(fl.qty).toBeCloseTo(236.2, 6);
    expect(fl.combinedUsd).toBeCloseTo(0.48, 6);
  });

  it("does NOT flatten while combined venture is still under water", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [IN_RESCUE({ netAfterCostUsd: 4.0 })], // -4.72 + 4.0 = -0.72 < 0
      activeRescueCount: 1,
    });
    expect(plan.flattens).toHaveLength(0);
    expect(plan.skips[0]!.reason).toMatch(/in rescue/);
  });

  it("respects a positive target before flattening", () => {
    const plan = planRegimeFlipRescue({
      config: { ...CFG, targetUsd: 2 },
      opposingDirection: "LONG",
      nowMs: NOW,
      availableBalanceUsd: 100,
      // combined = -4.72 + 6.0 = 1.28 < 2 ⇒ hold
      positions: [IN_RESCUE({ netAfterCostUsd: 6.0 })],
      activeRescueCount: 1,
    });
    expect(plan.flattens).toHaveLength(0);
  });

  it("max-hold cut flattens a still-red rescue once it has been open too long", () => {
    const plan = planRegimeFlipRescue({
      config: { ...CFG, maxHoldMs: 6 * 60 * 60 * 1000 }, // 6h
      opposingDirection: "LONG",
      nowMs: 10 * 60 * 60 * 1000, // 10h
      availableBalanceUsd: 100,
      // combined = -4.72 + 2.0 = -2.72 < target 0, but opened at 0 ⇒ 10h ≥ 6h ⇒ cut
      positions: [IN_RESCUE({ netAfterCostUsd: 2.0, openedAtMs: 0 })],
      activeRescueCount: 1,
    });
    expect(plan.flattens).toHaveLength(1);
    expect(plan.flattens[0]!.reason).toMatch(/max-hold/);
  });

  it("flattens a rescued symbol even when the regime flipped non-directional", () => {
    const plan = planRegimeFlipRescue({
      config: CFG,
      opposingDirection: null, // regime no longer directional
      nowMs: NOW,
      availableBalanceUsd: 100,
      positions: [IN_RESCUE({ netAfterCostUsd: 5.2 })], // combined 0.48 ≥ 0
      activeRescueCount: 1,
    });
    expect(plan.flattens).toHaveLength(1);
  });
});

describe("parseRegimeFlipRescueConfig", () => {
  it("is disabled on mainnet regardless of the flag", () => {
    const cfg = parseRegimeFlipRescueConfig({ LIVE_TESTNET_RESCUE_ENABLED: "1" } as NodeJS.ProcessEnv, "mainnet");
    expect(cfg.enabled).toBe(false);
  });

  it("enables only on testnet with the flag set", () => {
    expect(parseRegimeFlipRescueConfig({ LIVE_TESTNET_RESCUE_ENABLED: "1" } as NodeJS.ProcessEnv, "testnet").enabled).toBe(true);
    expect(parseRegimeFlipRescueConfig({} as NodeJS.ProcessEnv, "testnet").enabled).toBe(false);
  });

  it("applies env overrides and sane defaults", () => {
    const cfg = parseRegimeFlipRescueConfig(
      { LIVE_TESTNET_RESCUE_ENABLED: "1", LIVE_TESTNET_RESCUE_NET_FRACTION: "0.5", LIVE_TESTNET_RESCUE_MAX_NOTIONAL_USD: "120" } as NodeJS.ProcessEnv,
      "testnet",
    );
    expect(cfg.netFraction).toBe(0.5);
    expect(cfg.maxNotionalUsd).toBe(120);
    expect(cfg.minAgeMs).toBe(60 * 60 * 1000); // default
    expect(cfg.maxSymbols).toBe(2); // default
  });
});

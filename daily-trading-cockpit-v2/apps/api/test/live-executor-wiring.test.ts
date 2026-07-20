import { describe, it, expect, afterEach } from "vitest";
import {
  computeExternalManagedNetQty,
  computeNotionalPerSymbol,
  maxNotionalPerSymbolAcrossLanes,
  computeClusterOpenSymbols,
  maxClusterPositionsAcrossLanes,
  isNewExecutorLaneAllowed,
  rollingNetEntryHealth,
  type LiveExecutorGateEngine,
} from "../src/lib/live-executor-wiring.js";
import type { CrossSectionalExecutor, ExecutorBasket, OrphanedLeg } from "../src/lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";

function fakeEngine(over: Partial<LiveExecutorGateEngine> = {}): LiveExecutorGateEngine {
  return {
    isArmed: () => true,
    canOpenNewEntries: () => true,
    laneSelectionExplicitlyIncludesLane: () => true,
    laneSelectionAllowsLane: () => true,
    ...over,
  };
}

describe("isNewExecutorLaneAllowed", () => {
  it("testnet: allowed once armed, entry gate open, and explicitly included", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", fakeEngine())).toBe(true);
  });

  it("testnet: blocked if NOT explicitly included", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", fakeEngine({ laneSelectionExplicitlyIncludesLane: () => false }))).toBe(false);
  });

  it("mainnet: blocked when not armed, even if explicitly included", () => {
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", fakeEngine({ isArmed: () => false }))).toBe(false);
  });

  it("testnet and mainnet: blocked while the shared new-entry gate is closed", () => {
    const drained = fakeEngine({ canOpenNewEntries: () => false });
    expect(isNewExecutorLaneAllowed("MY_LANE", "testnet", drained)).toBe(false);
    expect(isNewExecutorLaneAllowed("MY_LANE", "mainnet", drained)).toBe(false);
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

  it("mainnet: unproven executor is testnet-only unless the explicit override is present", () => {
    const saved = process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE;
    delete process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE;
    expect(isNewExecutorLaneAllowed("NEW_LANE", "mainnet", fakeEngine(), { mainnetEntryEligible: false })).toBe(false);
    expect(isNewExecutorLaneAllowed("NEW_LANE", "testnet", fakeEngine(), { mainnetEntryEligible: false })).toBe(true);
    process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE = "1";
    expect(isNewExecutorLaneAllowed("NEW_LANE", "mainnet", fakeEngine(), { mainnetEntryEligible: false })).toBe(true);
    if (saved === undefined) delete process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE;
    else process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE = saved;
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

describe("rollingNetEntryHealth", () => {
  it("requires enough recent closes and both short/long rolling averages above zero", () => {
    expect(rollingNetEntryHealth([0.01, 0.02])).toMatchObject({ allowed: false, shortAvg: null });
    expect(rollingNetEntryHealth(Array.from({ length: 30 }, () => 0.01))).toMatchObject({ allowed: true });
    const recentlyToxic = [...Array.from({ length: 22 }, () => 0.01), ...Array.from({ length: 8 }, () => -0.05)];
    expect(rollingNetEntryHealth(recentlyToxic)).toMatchObject({ allowed: false });
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
function fakeOrphanedLeg(symbol: string, side: "LONG" | "SHORT", qty: number, entryPrice = 1): OrphanedLeg {
  return {
    basketId: "b1", symbol, side, qty, entryPrice, entryOrderId: "1",
    since: "2026-07-19T00:00:00.000Z", lastAttemptAt: "2026-07-19T00:00:00.000Z", lastError: "test fixture", attempts: 1,
  };
}
function fakeXsecExecutor(baskets: ExecutorBasket[], orphanedLegs: OrphanedLeg[] = []): CrossSectionalExecutor {
  return { getStatus: () => ({ openBaskets: baskets, orphanedLegs }) } as unknown as CrossSectionalExecutor;
}
function fakePosition(symbol: string, direction: "LONG" | "SHORT", qty: number, exitOrderId: number | null = null, entryPrice = 1): SingleSymbolPosition {
  return {
    positionId: "p1", sourceObservationId: "o1", symbol, direction, qty, entryPrice, entryOrderId: 1,
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

  describe("2026-07-19 real-money audit follow-up: orphaned legs count as real exposure", () => {
    it("folds an orphaned leg's qty into the net exactly like an open basket leg", () => {
      const exec = fakeXsecExecutor([], [fakeOrphanedLeg("BTCUSDT", "LONG", 0.4)]);
      const net = computeExternalManagedNetQty([exec], []);
      expect(net.get("BTCUSDT")).toBeCloseTo(0.4, 9);
    });

    it("combines an orphaned leg with a live open leg on the SAME symbol", () => {
      const exec = fakeXsecExecutor([fakeBasket([fakeLeg("ETHUSDT", "SHORT", 1)])], [fakeOrphanedLeg("ETHUSDT", "LONG", 0.3)]);
      const net = computeExternalManagedNetQty([exec], []);
      expect(net.get("ETHUSDT")).toBeCloseTo(-0.7, 9); // -1 (short leg) + 0.3 (orphan)
    });
  });
});

describe("computeNotionalPerSymbol (2026-07-09 cross-lane per-symbol notional cap fix)", () => {
  it("sums notional (qty*entryPrice) UNSIGNED across executors on the SAME symbol — same-direction stacking ADDS, doesn't cancel", () => {
    // The exact incident: REGIME_COMPOSITE_CONFIRMATION_LONG and COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG
    // both went LONG on ETHUSDT simultaneously — this must ADD their notional, not net them like
    // computeExternalManagedNetQty (signed) does for reconcile purposes.
    const regimeComposite = fakeSingleSymbolExecutor([fakePosition("ETHUSDT", "LONG", 0.085, null, 1755.84)]);
    const wideLongBucket = fakeSingleSymbolExecutor([fakePosition("ETHUSDT", "LONG", 0.05, null, 1755.84)]);
    const notional = computeNotionalPerSymbol([regimeComposite, wideLongBucket]);
    expect(notional.get("ETHUSDT")).toBeCloseTo(0.085 * 1755.84 + 0.05 * 1755.84, 6);
  });

  it("sums opposite-direction positions on the same symbol as ADDITIONAL exposure, not netted", () => {
    const longExec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 1, null, 100)]);
    const shortExec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "SHORT", 1, null, 100)]);
    const notional = computeNotionalPerSymbol([longExec, shortExec]);
    expect(notional.get("BTCUSDT")).toBeCloseTo(200, 6); // 100 + 100, NOT 0
  });

  it("excludes a position whose exit is already in flight (exitOrderId set)", () => {
    const exec = fakeSingleSymbolExecutor([fakePosition("SOLUSDT", "LONG", 1, 999, 78)]);
    expect(computeNotionalPerSymbol([exec]).has("SOLUSDT")).toBe(false);
  });

  it("skips null executor slots and returns an empty map when nothing is open", () => {
    expect(computeNotionalPerSymbol([null, fakeSingleSymbolExecutor([])]).size).toBe(0);
  });

  describe("2026-07-19 real-money audit fix: bidirectional single-symbol <-> cross-sectional visibility", () => {
    it("omitting the cross-sectional param (existing call sites) is byte-identical to pre-fix behavior", () => {
      const exec = fakeSingleSymbolExecutor([fakePosition("BTCUSDT", "LONG", 1, null, 100)]);
      expect(computeNotionalPerSymbol([exec])).toEqual(new Map([["BTCUSDT", 100]]));
    });

    it("folds in cross-sectional basket legs' notional on the SAME symbol as a single-symbol lane", () => {
      const single = fakeSingleSymbolExecutor([fakePosition("ETHUSDT", "LONG", 0.05, null, 1755.84)]);
      const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("ETHUSDT", "LONG", 0.03, null)])]);
      // ETHUSDT entryPrice defaults to 1 in fakeLeg — combined = 0.05*1755.84 (single) + 0.03*1 (xsec leg)
      const notional = computeNotionalPerSymbol([single], [xsec]);
      expect(notional.get("ETHUSDT")).toBeCloseTo(0.05 * 1755.84 + 0.03 * 1, 6);
    });

    it("excludes a cross-sectional leg whose exit is already in flight (exitOrderId set)", () => {
      const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("SOLUSDT", "SHORT", 1, 999)])]);
      expect(computeNotionalPerSymbol([], [xsec]).has("SOLUSDT")).toBe(false);
    });

    it("skips null cross-sectional slots and returns an empty map when nothing is open on either side", () => {
      expect(computeNotionalPerSymbol([null], [null, fakeXsecExecutor([])]).size).toBe(0);
    });
  });

  describe("2026-07-19 real-money audit follow-up: an unresolved orphaned leg counts toward the cap", () => {
    it("folds an orphaned leg's notional into the total on its symbol", () => {
      const exec = fakeXsecExecutor([], [fakeOrphanedLeg("SOLUSDT", "LONG", 2, 100)]);
      const notional = computeNotionalPerSymbol([], [exec]);
      expect(notional.get("SOLUSDT")).toBeCloseTo(200, 6);
    });

    it("prevents a fresh single-symbol lane from silently exceeding the cap alongside an unresolved orphan", () => {
      const xsec = fakeXsecExecutor([], [fakeOrphanedLeg("SOLUSDT", "LONG", 2, 100)]); // $200 already real/unresolved
      const notionalBefore = computeNotionalPerSymbol([], [xsec]);
      expect(notionalBefore.get("SOLUSDT")).toBeCloseTo(200, 6);
      // A single-symbol lane sizing a fresh $100 entry on the same symbol would see $300 total,
      // not $100 — exactly the visibility this cap exists to provide.
      const single = fakeSingleSymbolExecutor([fakePosition("SOLUSDT", "LONG", 1, null, 100)]);
      const notionalAfter = computeNotionalPerSymbol([single], [xsec]);
      expect(notionalAfter.get("SOLUSDT")).toBeCloseTo(300, 6);
    });
  });
});

describe("maxNotionalPerSymbolAcrossLanes", () => {
  const key = "LIVE_MAX_NOTIONAL_PER_SYMBOL_ACROSS_LANES";
  const saved = process.env[key];
  afterEach(() => {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  });

  it("defaults to 250 and honors a valid positive override", () => {
    delete process.env[key];
    expect(maxNotionalPerSymbolAcrossLanes()).toBe(250);
    process.env[key] = "400";
    expect(maxNotionalPerSymbolAcrossLanes()).toBe(400);
  });

  it("ignores a non-positive or garbage override and falls back to the default", () => {
    process.env[key] = "-10";
    expect(maxNotionalPerSymbolAcrossLanes()).toBe(250);
    process.env[key] = "not-a-number";
    expect(maxNotionalPerSymbolAcrossLanes()).toBe(250);
  });
});

describe("maxClusterPositionsAcrossLanes", () => {
  const key = "LIVE_MAX_CLUSTER_POSITIONS";
  const saved = process.env[key];
  afterEach(() => {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  });

  it("defaults to 3 (matching live-execution-engine.ts's own maxClusterPositions default) and honors a valid override", () => {
    delete process.env[key];
    expect(maxClusterPositionsAcrossLanes()).toBe(3);
    process.env[key] = "5";
    expect(maxClusterPositionsAcrossLanes()).toBe(5);
  });

  it("ignores a negative or garbage override and falls back to the default", () => {
    process.env[key] = "-1";
    expect(maxClusterPositionsAcrossLanes()).toBe(3);
    process.env[key] = "not-a-number";
    expect(maxClusterPositionsAcrossLanes()).toBe(3);
  });
});

describe("computeClusterOpenSymbols (2026-07-19 real-money audit fix: correlated-cluster cap reach)", () => {
  it("groups the legacy mirror's own open intents by cluster+direction, keyed the same way live-execution-engine.ts's clusterOpenCounts does", () => {
    // SOLUSDT and AVAXUSDT are both in the L1 cluster (see correlation-clusters.ts's DEFAULT_CLUSTER_MAP).
    const open = computeClusterOpenSymbols(
      [{ symbol: "SOLUSDT", direction: "LONG" }, { symbol: "AVAXUSDT", direction: "LONG" }],
      [],
      [],
    );
    expect(open.get("L1:LONG")).toEqual(new Set(["SOLUSDT", "AVAXUSDT"]));
  });

  it("folds in cross-sectional basket legs and single-symbol lane positions on the SAME cluster+direction", () => {
    const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("ADAUSDT", "LONG", 10)])]);
    const single = fakeSingleSymbolExecutor([fakePosition("SUIUSDT", "LONG", 4)]);
    // ADAUSDT, SUIUSDT are both L1 — same cluster as the mirror's SOLUSDT intent below.
    const open = computeClusterOpenSymbols([{ symbol: "SOLUSDT", direction: "LONG" }], [xsec], [single]);
    expect(open.get("L1:LONG")).toEqual(new Set(["SOLUSDT", "ADAUSDT", "SUIUSDT"]));
  });

  it("separates clusters and directions into distinct keys — an L1 short does not count against an L1 long, and MEME stays separate from L1", () => {
    const open = computeClusterOpenSymbols(
      [
        { symbol: "SOLUSDT", direction: "LONG" },
        { symbol: "ADAUSDT", direction: "SHORT" },
        { symbol: "DOGEUSDT", direction: "LONG" },
      ],
      [],
      [],
    );
    expect(open.get("L1:LONG")).toEqual(new Set(["SOLUSDT"]));
    expect(open.get("L1:SHORT")).toEqual(new Set(["ADAUSDT"]));
    expect(open.get("MEME:LONG")).toEqual(new Set(["DOGEUSDT"]));
  });

  it("excludes MAJORS (BTC/ETH) entirely, matching live-execution-engine.ts's own per-cluster exemption", () => {
    const open = computeClusterOpenSymbols(
      [{ symbol: "BTCUSDT", direction: "LONG" }, { symbol: "ETHUSDT", direction: "LONG" }],
      [],
      [],
    );
    expect(open.size).toBe(0);
  });

  it("excludes a cross-sectional leg or single-symbol position whose exit is already in flight", () => {
    const xsec = fakeXsecExecutor([fakeBasket([fakeLeg("ADAUSDT", "LONG", 1, 999)])]);
    const single = fakeSingleSymbolExecutor([fakePosition("SUIUSDT", "LONG", 1, 888)]);
    expect(computeClusterOpenSymbols([], [xsec], [single]).size).toBe(0);
  });

  it("skips null executor slots and returns an empty map when nothing is open anywhere", () => {
    expect(computeClusterOpenSymbols([], [null], [null]).size).toBe(0);
  });

  it("2026-07-19 real-money audit follow-up: an orphaned leg counts toward its cluster exactly like an open leg", () => {
    // ADAUSDT is L1 — same cluster as the mirror's SOLUSDT intent.
    const xsec = fakeXsecExecutor([], [fakeOrphanedLeg("ADAUSDT", "LONG", 10)]);
    const open = computeClusterOpenSymbols([{ symbol: "SOLUSDT", direction: "LONG" }], [xsec], []);
    expect(open.get("L1:LONG")).toEqual(new Set(["SOLUSDT", "ADAUSDT"]));
  });
});

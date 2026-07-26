/**
 * ONE write of the simulated R-path store per resolver pass (2026-07-26 review fix #3).
 *
 * WHY THIS IS NOT COSMETIC: the SIMULATED-tier side-record originally called recordResolvedPath()
 * without { deferSave: true }, so EVERY resolved paper order serialized and writeFileSync'd the WHOLE
 * store synchronously. At steady state (MAX_SIM_PATHS = 300 paths, ~420 points each) that file is
 * ~3.5MB and resolverMaxOrders defaults to 80 — ~565ms of BLOCKED EVENT LOOP per pass, measured. This
 * resolver shares its process with the live mainnet execution engine on 3103, which makes it a
 * real-money latency hazard rather than slow bookkeeping. The write is now deferred and flushed
 * exactly once, off resolvePaperOrders' existing beginBatch/endBatch wrapper.
 *
 * The assertion is on the WRITE COUNT (fs is instrumented), because that is the property that
 * regresses silently — the stored contents look identical either way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Counts writeFileSync calls per target file. Everything still hits the real fs. */
const writes: string[] = [];
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: actual,
    writeFileSync: (file: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
      writes.push(String(file));
      return (actual.writeFileSync as (...a: unknown[]) => void)(file, ...rest);
    },
  };
});

const {
  PaperExecutionRouterStore,
  resolvePaperOrders,
  PAPER_EXECUTION_MODEL_IDEAL,
} = await import("../src/lib/paper-execution-router.js");
const { SimulatedPaperPathStore, getSimulatedPaperPathStore, _resetSimulatedPaperPathStoreForTests } = await import(
  "../src/lib/paper-simulated-path-store.js"
);
type PaperOrder = import("../src/lib/paper-execution-router.js").PaperOrder;
type PaperResolverClient = import("../src/lib/paper-execution-router.js").PaperResolverClient;
type PaperKlineTuple = import("../src/lib/paper-execution-router.js").PaperKlineTuple;

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-sim-batch-"));
  dirs.push(dir);
  return dir;
}
beforeEach(() => {
  writes.length = 0;
  _resetSimulatedPaperPathStoreForTests();
});
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** LONG order: entry 100, stop 97 (300bps), tp 106. `mfe_giveback` is one of the exit rules the
 *  resolver hands to walkVariantPath (the only branch that produces an rPath at all). */
function longOrder(openedAt: string, id: string): PaperOrder {
  const now = new Date().toISOString();
  return {
    variantExitRule: "mfe_giveback",
    paperOrderId: id,
    sourceObservationId: `obs-${id}`,
    sourceSignalId: null,
    dedupeKey: `${id}:lane`,
    createdAt: now,
    updatedAt: now,
    openedAt,
    symbol: "ETHUSDT",
    direction: "LONG",
    regime: "BULLISH_EXPANSION",
    controllerMode: "LONG_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 97,
    takeProfitLevels: [106],
    plannedStopDistanceBps: 300,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

/** Six 5m candles that drift up and then take profit at 106 — long enough to produce a real,
 *  multi-point rPath for every order. 1m refinement returns []. */
const client: PaperResolverClient = {
  getKlines: async (_symbol, interval, opts) => {
    if (interval === "1m") return [];
    const signalMs = opts.startTime + 300_000;
    const out: PaperKlineTuple[] = [];
    for (let i = -1; i < 6; i += 1) {
      const openMs = signalMs + i * 300_000;
      const close = i < 5 ? 100 + Math.max(0, i) : 106.5;
      out.push([openMs, "0", String(close + 0.2), String(close - 0.2), String(close), "0", openMs + 300_000]);
    }
    return out;
  },
};

const simTmpWrites = () => writes.filter((f) => f.includes("paper-simulated-paths.json")).length;

describe("simulated R-path store is written ONCE per resolver pass", () => {
  it("N resolved orders produce N stored paths but exactly ONE store write", async () => {
    const dir = tmp();
    const store = new PaperExecutionRouterStore(dir);
    const openedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const N = 12;
    for (let i = 0; i < N; i += 1) store.add(longOrder(openedAt, `o-${i}`));

    const res = await resolvePaperOrders(store, client, PAPER_EXECUTION_MODEL_IDEAL);
    expect(res.resolved).toBe(N);

    // Every path was captured…
    const persisted = new SimulatedPaperPathStore(dir);
    expect(persisted.listPaths()).toHaveLength(N);
    expect(persisted.listPaths()[0]!.ticks.length).toBeGreaterThan(1);
    // …and the whole ~O(store) serialization happened exactly once, not once per order.
    // Pre-fix this was N (12); at production settings it is resolverMaxOrders (80).
    expect(simTmpWrites()).toBe(1);
  });

  it("a pass that resolves nothing writes the store zero times (flush is a no-op while clean)", async () => {
    const dir = tmp();
    const store = new PaperExecutionRouterStore(dir);
    await resolvePaperOrders(store, client, PAPER_EXECUTION_MODEL_IDEAL);
    expect(simTmpWrites()).toBe(0);
  });

  it("the single flush still happens when the pass THROWS (it is hung off the finally)", async () => {
    const dir = tmp();
    const store = new PaperExecutionRouterStore(dir);

    // A path already recorded (deferred) by an earlier order in this pass: dirty, not yet written.
    expect(
      getSimulatedPaperPathStore(dir).recordResolvedPath(
        {
          key: "recorded-before-the-throw",
          laneId: "LANE_X",
          symbol: "ETHUSDT",
          direction: "LONG",
          closedAtMs: Date.now(),
          closeR: 0.5,
          rPath: [
            { tsMs: Date.now() - 600_000, currentR: 0 },
            { tsMs: Date.now() - 300_000, currentR: 0.5 },
          ],
        },
        { deferSave: true },
      ),
    ).toBe(true);
    expect(simTmpWrites()).toBe(0);

    const allSpy = vi.spyOn(store, "all", "get").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(resolvePaperOrders(store, client, PAPER_EXECUTION_MODEL_IDEAL)).rejects.toThrow("boom");
    allSpy.mockRestore();

    // Deferring must not mean LOSING the record when the pass dies — the finally still flushed, once.
    expect(simTmpWrites()).toBe(1);
    expect(new SimulatedPaperPathStore(dir).has("recorded-before-the-throw")).toBe(true);
  });
});

/**
 * Direction + Entry Brain outcome RECONCILER tests.
 *
 * Focus (per task spec):
 *  - idempotent dedup: calling the reconciliation logic twice on the same due row must not double-score it
 *  - the three-layer gate (mode-off / unallowlisted instance / live port 3103 must all leave it inactive)
 *  - cycleMeta reflecting a real error when a dependency throws mid-cycle
 *
 * The Tier1/Tier2 non-blending guarantee itself is covered exhaustively at the report-builder level in
 * test/direction-entry-outcome-store.test.ts; this file additionally proves the reconciler routes a
 * Tier-1-resolved row and a Tier-2-resolved row into the store with their own distinct tier tags.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Candle } from "@dtc/shared";
import type { PathCandle } from "../src/lib/entry-exit-counterfactual.js";
import type { PendingDirectionRow, PendingEntryRow } from "../src/lib/four-brain-outcome-ledger.js";
import type { PositionPath } from "../src/lib/position-path-recorder.js";
import { DirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";
import {
  runDirectionEntryReconciliationCycle,
  fourBrainOutcomeModeEnabled,
  directionEntryReconcilerActive,
  type DirectionEntryReconcilerDeps,
  type OutcomeLedgerLike,
} from "../src/lib/direction-entry-reconciler.js";

const HOUR_MS = 3_600_000;

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-direction-entry-reconciler-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A simple in-memory fake ledger giving the test full control over what "pending" looks like and
 *  whether removal actually takes effect — used to simulate a crash-and-restart mid-cycle (ledger
 *  removal never landed) for the idempotent-dedup test. */
function fakeLedger(opts: {
  direction?: PendingDirectionRow[];
  entry?: PendingEntryRow[];
  /** When true, removeDirectionByIds/removeEntryByIds are no-ops — the same rows are offered again on
   *  the next getPendingXRows() call, exactly like a crash before the ledger removal landed. */
  neverRemove?: boolean;
}): OutcomeLedgerLike {
  let direction = opts.direction ?? [];
  let entry = opts.entry ?? [];
  return {
    getPendingDirectionRows: () => direction.map((r) => ({ ...r })),
    getPendingEntryRows: () => entry.map((r) => ({ ...r })),
    removeDirectionByIds: (ids) => {
      if (opts.neverRemove) return;
      direction = direction.filter((r) => !ids.has(r.decisionId));
    },
    removeEntryByIds: (ids) => {
      if (opts.neverRemove) return;
      entry = entry.filter((r) => !ids.has(r.decisionId));
    },
  };
}

/** A flat 1h BTCUSDT candle series, `count` bars starting at `startMs`, price constant (no gaps, no
 *  data-quality failures) — enough for resolveDirectionOutcome to reach a real EVALUATED result. */
function flatCandles(startMs: number, count: number, price = 60000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ openTime: startMs + i * HOUR_MS, open: price, high: price + 5, low: price - 5, close: price, volume: 100 });
  }
  return out;
}

function baseDeps(overrides: Partial<DirectionEntryReconcilerDeps> = {}): DirectionEntryReconcilerDeps {
  return {
    ledger: fakeLedger({}),
    store: new DirectionEntryOutcomeStore(tmp()),
    listClosedPositionPaths: () => [],
    fetchDirectionCandles: async () => null,
    fetchEntryTier2Candles: async () => null,
    ...overrides,
  };
}

function closedPath(overrides: Partial<PositionPath> = {}): PositionPath {
  return {
    key: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::1",
    meta: { laneId: "CG_WIDE_FAST_LONG", symbol: "BTCUSDT", direction: "LONG", source: "engine" },
    ticks: [{ t: 1000, r: 0 }],
    rawTickCount: 1,
    thinned: 0,
    closedAtMs: 5000,
    closeR: 0.5,
    ...overrides,
  };
}

describe("fourBrainOutcomeModeEnabled / directionEntryReconcilerActive — three-layer gate", () => {
  it("fourBrainOutcomeModeEnabled requires the brand-new FOUR_BRAIN_OUTCOME_MODE flag EXACTLY 'shadow'", () => {
    expect(fourBrainOutcomeModeEnabled({ FOUR_BRAIN_OUTCOME_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fourBrainOutcomeModeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(fourBrainOutcomeModeEnabled({ FOUR_BRAIN_OUTCOME_MODE: "on" } as NodeJS.ProcessEnv)).toBe(false);
    // enabling four-brain shadow mode alone must NOT turn this flag on — it is a SEPARATE env var.
    expect(fourBrainOutcomeModeEnabled({ FOUR_BRAIN_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("directionEntryReconcilerActive requires ALL THREE layers — mode-off leaves it inactive even with shadow active elsewhere", () => {
    expect(
      directionEntryReconcilerActive({ FOUR_BRAIN_MODE: "shadow", PORT: "3101" } as NodeJS.ProcessEnv),
    ).toBe(false); // layer (a) missing: FOUR_BRAIN_OUTCOME_MODE unset
  });

  it("directionEntryReconcilerActive is inactive on an unallowlisted instance even with both other layers on", () => {
    expect(
      directionEntryReconcilerActive({
        FOUR_BRAIN_OUTCOME_MODE: "shadow",
        FOUR_BRAIN_MODE: "shadow",
        PORT: "9999",
      } as NodeJS.ProcessEnv),
    ).toBe(false); // layer (b): fourBrainInstanceAllowed rejects an unknown port
  });

  it("directionEntryReconcilerActive HARD-BLOCKS live port 3103 even if every flag (including a stray allowlist) tries to allow it", () => {
    expect(
      directionEntryReconcilerActive({
        FOUR_BRAIN_OUTCOME_MODE: "shadow",
        FOUR_BRAIN_MODE: "shadow",
        PORT: "3103",
        FOUR_BRAIN_INSTANCE_ALLOWLIST: "3101,3102,3103",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("directionEntryReconcilerActive is inactive when fourBrainShadowActive's own gate (layer c) is off, even with the new flag on", () => {
    expect(
      directionEntryReconcilerActive({
        FOUR_BRAIN_OUTCOME_MODE: "shadow",
        PORT: "3101",
        // FOUR_BRAIN_MODE unset ⇒ fourBrainShadowActive is false
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("directionEntryReconcilerActive is true only with ALL THREE layers satisfied on an allowed research/testnet instance", () => {
    expect(
      directionEntryReconcilerActive({
        FOUR_BRAIN_OUTCOME_MODE: "shadow",
        FOUR_BRAIN_MODE: "shadow",
        PORT: "3101",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      directionEntryReconcilerActive({
        FOUR_BRAIN_OUTCOME_MODE: "shadow",
        FOUR_BRAIN_MODE: "shadow",
        PORT: "3102",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("runDirectionEntryReconciliationCycle — idempotent dedup", () => {
  it("a Tier-1-resolvable Entry row is scored exactly once even if the ledger fails to remove it (crash-and-restart simulation)", async () => {
    const pendingEntry: PendingEntryRow[] = [
      {
        decisionId: "entry-1",
        asOfMs: 1000,
        symbolOrBasketId: "BTCUSDT",
        laneId: "CG_WIDE_FAST_LONG",
        side: "LONG",
        action: "ENTER_NOW",
        targetEntry: 100,
        initialStopPrice: 95,
        expectedNetR: 0.2,
      },
    ];
    const ledger = fakeLedger({ entry: pendingEntry, neverRemove: true });
    const store = new DirectionEntryOutcomeStore(tmp());
    const deps = baseDeps({
      ledger,
      store,
      listClosedPositionPaths: () => [closedPath()],
    });

    const first = await runDirectionEntryReconciliationCycle(deps);
    expect(first.entryProcessed).toBe(1);
    expect(store.getState().entry.resolvedRealMatchCount).toBe(1);

    // Second cycle: the SAME row is still "pending" (ledger removal never landed), and the SAME closed
    // path is still offered by listClosedPositionPaths — a naive re-run would double-score it.
    const second = await runDirectionEntryReconciliationCycle(deps);
    expect(second.entryProcessed).toBe(0); // idempotent: recordEntryOutcome refuses the already-booked id
    expect(store.getState().entry.resolvedRealMatchCount).toBe(1); // still exactly 1, never 2
  });

  it("a Direction row resolved via real candles is scored exactly once across two cycles on the same due row", async () => {
    const asOfMs = 20 * HOUR_MS; // entryIdx must be >= ATR period (14) for computeATR to have warmed up
    const pendingDirection: PendingDirectionRow[] = [
      { decisionId: "dir-1", asOfMs, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.05 },
    ];
    const ledger = fakeLedger({ direction: pendingDirection, neverRemove: true });
    const store = new DirectionEntryOutcomeStore(tmp());
    // Candle series with ample gap-free history before asOfMs (need >168 bars back for the ATR gap guard)
    // and a bar available at/after targetExitMs (asOfMs + 1h for SCALP).
    const candles = flatCandles(0, 400);
    const nowMs = asOfMs + 2 * HOUR_MS; // safely past targetExitMs
    const deps = baseDeps({ ledger, store, fetchDirectionCandles: async () => candles, now: () => nowMs });

    const first = await runDirectionEntryReconciliationCycle(deps);
    expect(first.directionProcessed).toBe(1);
    expect(store.getState().direction.evaluatedCount).toBe(1);

    const second = await runDirectionEntryReconciliationCycle(deps);
    expect(second.directionProcessed).toBe(0);
    expect(store.getState().direction.evaluatedCount).toBe(1);
  });
});

describe("REGRESSION (adversarial review 2026-07-23): Tier 1 'one close claimed once' holds ACROSS cycles", () => {
  it("a real close already claimed by one decision in cycle 1 must NOT be re-matched to a second decision in cycle 2, even though listClosedPositionPaths() keeps re-offering the same close (rolling window)", async () => {
    // Two pending decisions, same lane/symbol/side, both inside the one real close's TTL window. The
    // resolver's own rule picks the LATEST eligible candidate as the owner — so entry-B (asOfMs=300)
    // should win over entry-A (asOfMs=100) in cycle 1.
    const entryA: PendingEntryRow = {
      decisionId: "entry-A-older",
      asOfMs: 100,
      symbolOrBasketId: "BTCUSDT",
      laneId: "CG_WIDE_FAST_LONG",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.2,
    };
    const entryB: PendingEntryRow = {
      decisionId: "entry-B-newer",
      asOfMs: 300,
      symbolOrBasketId: "BTCUSDT",
      laneId: "CG_WIDE_FAST_LONG",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.2,
    };
    const realClose = closedPath({ key: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::real-1", ticks: [{ t: 400, r: 0 }], closedAtMs: 500 });
    const ledger = fakeLedger({ entry: [entryA, entryB] }); // normal removal — mirrors real ledger behavior
    const store = new DirectionEntryOutcomeStore(tmp());
    const deps = baseDeps({
      ledger,
      store,
      now: () => 350, // well before either row's own Tier-2-eligible deadline — isolates this to Tier 1 only
      // listClosedPositionPaths is a ROLLING WINDOW (position-path-recorder.ts's own MAX_CLOSED_PATHS) —
      // it keeps re-offering the SAME close on every cycle, exactly like production.
      listClosedPositionPaths: () => [realClose],
    });

    const first = await runDirectionEntryReconciliationCycle(deps);
    expect(first.entryProcessed).toBe(1);
    const afterFirst = store.getState().entry.records;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.decisionId).toBe("entry-B-newer"); // the resolver's own "latest eligible" rule
    expect(afterFirst[0]!.matchedCloseKey).toBe("CG_WIDE_FAST_LONG::BTCUSDT::LONG::real-1");
    expect(store.hasClaimedTier1CloseKey("CG_WIDE_FAST_LONG::BTCUSDT::LONG::real-1")).toBe(true);

    // Cycle 2: entry-B was removed from the ledger (booked); entry-A is still pending. The SAME close is
    // still returned by listClosedPositionPaths (rolling window). Pre-fix, entry-A would now get matched
    // to that SAME real close (a second, different decision claiming a close already claimed) — violating
    // the resolver's own "one close claimed once" invariant. Post-fix, the close is filtered out before
    // ever reaching the resolver, so entry-A stays PENDING (not booked at all this cycle).
    const second = await runDirectionEntryReconciliationCycle(deps);
    expect(second.entryProcessed).toBe(0);
    const afterSecond = store.getState().entry.records;
    expect(afterSecond).toHaveLength(1); // still just the one TIER1_REALIZED row from cycle 1
    expect(afterSecond.some((r) => r.decisionId === "entry-A-older")).toBe(false);
    expect(store.getState().entry.resolvedRealMatchCount).toBe(1); // never 2
  });
});

describe("runDirectionEntryReconciliationCycle — Tier 1 vs Tier 2 routing (never blended)", () => {
  it("routes a Tier-1-matched row and a Tier-2-simulated row into the store with distinct tier tags", async () => {
    const tier1Row: PendingEntryRow = {
      decisionId: "entry-tier1",
      asOfMs: 100, // must be <= the closed path's own openedAtMs (400) — a decision can't own a close it postdates
      symbolOrBasketId: "BTCUSDT",
      laneId: "CG_WIDE_FAST_LONG",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.2,
    };
    // Old enough that Tier 1 gets a fair shot but, since it won't match (no closed path for THIS
    // decisionId's lane/symbol/side/window), Tier 2 is attempted once its own eligibility deadline passes.
    const tier2Row: PendingEntryRow = {
      decisionId: "entry-tier2",
      asOfMs: 0,
      symbolOrBasketId: "ETHUSDT",
      laneId: "RC_LANE",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.1,
    };
    const ledger = fakeLedger({ entry: [tier1Row, tier2Row] });
    const store = new DirectionEntryOutcomeStore(tmp());
    const nowMs = 24 * HOUR_MS; // well past tier2Row's own Tier-2-eligible deadline
    const tier2Candles = flatCandles(0, 40, 100);
    const deps = baseDeps({
      ledger,
      store,
      now: () => nowMs,
      listClosedPositionPaths: () => [closedPath({ closedAtMs: 500, ticks: [{ t: 400, r: 0 }] })],
      fetchEntryTier2Candles: async () => tier2Candles as PathCandle[],
    });

    const result = await runDirectionEntryReconciliationCycle(deps);
    expect(result.entryProcessed).toBe(2);

    const records = store.getState().entry.records;
    const tier1Rec = records.find((r) => r.decisionId === "entry-tier1")!;
    const tier2Rec = records.find((r) => r.decisionId === "entry-tier2")!;
    expect(tier1Rec.tier).toBe("TIER1_REALIZED");
    expect(tier2Rec.tier).toBe("TIER2_SIMULATED");
    expect(store.getState().entry.resolvedRealMatchCount).toBe(1);
    expect(store.getState().entry.resolvedSimulatedCount).toBe(1);
  });

  it("prefetches unique Tier-2 candle keys with bounded concurrency while preserving the attempt cap", async () => {
    const rows = Array.from({ length: 12 }, (_, index): PendingEntryRow => ({
      decisionId: `entry-prefetch-${index}`,
      asOfMs: index,
      symbolOrBasketId: `SYM${index}USDT`,
      laneId: "CG_WIDE_FAST_LONG",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.1,
    }));
    let active = 0;
    let peakActive = 0;
    let calls = 0;
    const result = await runDirectionEntryReconciliationCycle(
      baseDeps({
        ledger: fakeLedger({ entry: rows }),
        store: new DirectionEntryOutcomeStore(tmp()),
        now: () => 24 * HOUR_MS,
        maxEntryTier2AttemptsPerCycle: 10,
        entryTier2FetchConcurrency: 3,
        fetchEntryTier2Candles: async (_symbol, sinceMs) => {
          calls += 1;
          active += 1;
          peakActive = Math.max(peakActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return flatCandles(sinceMs, 40, 100) as PathCandle[];
        },
      }),
    );
    expect(calls).toBe(10);
    expect(peakActive).toBeGreaterThan(1);
    expect(peakActive).toBeLessThanOrEqual(3);
    expect(result.entryProcessed).toBe(10);
    expect(result.entrySkippedNotDue).toBe(0);
  });

  it("keeps Tier-2 scheduler deferrals separate from actual missing candle data", async () => {
    const rows = Array.from({ length: 4 }, (_, index): PendingEntryRow => ({
      decisionId: `entry-deferred-${index}`,
      asOfMs: index,
      symbolOrBasketId: `SYM${index}USDT`,
      laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL",
      side: "LONG",
      action: index === 0 ? "ENTER_NOW" : "SKIP",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.1,
    }));
    const store = new DirectionEntryOutcomeStore(tmp());
    await runDirectionEntryReconciliationCycle(
      baseDeps({
        ledger: fakeLedger({ entry: rows }),
        store,
        now: () => 24 * HOUR_MS,
        maxEntryTier2AttemptsPerCycle: 1,
        fetchEntryTier2Candles: async () => null,
      }),
    );

    expect(store.getState().entry.currentInstrumentDataMissing).toBe(1);
    expect(store.getState().entry.currentTier2Deferred).toBe(3);
  });

  it("retries one empty Tier-2 candle fetch before marking the source unavailable", async () => {
    const row: PendingEntryRow = {
      decisionId: "entry-retry-empty-fetch",
      asOfMs: 0,
      symbolOrBasketId: "BTCUSDT",
      laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 100,
      initialStopPrice: 95,
      expectedNetR: 0.1,
    };
    const store = new DirectionEntryOutcomeStore(tmp());
    let calls = 0;
    const result = await runDirectionEntryReconciliationCycle(
      baseDeps({
        ledger: fakeLedger({ entry: [row] }),
        store,
        now: () => 24 * HOUR_MS,
        fetchEntryTier2Candles: async (_symbol, sinceMs) => {
          calls += 1;
          return calls === 1 ? null : flatCandles(sinceMs, 40, 100) as PathCandle[];
        },
      }),
    );

    expect(calls).toBe(2);
    expect(result.entryProcessed).toBe(1);
    expect(store.getState().entry.currentInstrumentDataMissing).toBe(0);
  });
});

describe("runDirectionEntryReconciliationCycle — cycleMeta reflects a real error, never silently frozen", () => {
  it("a throwing dependency (fetchDirectionCandles) is captured into cycleMeta.lastError, and the cycle still completes", async () => {
    const pendingDirection: PendingDirectionRow[] = [
      { decisionId: "dir-err", asOfMs: 10 * HOUR_MS, horizon: "SCALP", action: "LONG", expectedDirectionalR: null },
    ];
    const store = new DirectionEntryOutcomeStore(tmp());
    const deps = baseDeps({
      ledger: fakeLedger({ direction: pendingDirection }),
      store,
      now: () => 20 * HOUR_MS,
      fetchDirectionCandles: async () => {
        throw new Error("binance getCandles failed");
      },
    });

    const result = await runDirectionEntryReconciliationCycle(deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("binance getCandles failed");
    expect(store.getState().cycleMeta.lastError).toContain("binance getCandles failed");
    expect(store.getState().cycleMeta.lastRunAtIso).not.toBeNull();
    // the row was never resolved (data failure, no candles) — it must not be silently dropped from the
    // ledger either; the reconciler only removes rows on RESOLVED/EXPIRED_UNRESOLVABLE terminal status.
    expect(result.directionProcessed).toBe(0);
  });

  it("an outer throw (listClosedPositionPaths) is caught, recorded into cycleMeta, and never propagates to the caller", async () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const pendingEntry: PendingEntryRow[] = [
      {
        decisionId: "entry-err",
        asOfMs: 0,
        symbolOrBasketId: "BTCUSDT",
        laneId: "CG_WIDE_FAST_LONG",
        side: "LONG",
        action: "ENTER_NOW",
        targetEntry: 100,
        initialStopPrice: 95,
        expectedNetR: 0.1,
      },
    ];
    const deps = baseDeps({
      ledger: fakeLedger({ entry: pendingEntry }),
      store,
      listClosedPositionPaths: () => {
        throw new Error("position-path-recorder unavailable");
      },
    });

    await expect(runDirectionEntryReconciliationCycle(deps)).resolves.toBeTruthy();
    const result = await runDirectionEntryReconciliationCycle(deps);
    expect(result.error).toContain("position-path-recorder unavailable");
    expect(store.getState().cycleMeta.lastError).toContain("position-path-recorder unavailable");
  });
});

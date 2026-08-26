/**
 * CANONICAL MARKET REGIME — scheduler wiring tests (2026-08, HIGH deployment-scope-gap fix).
 *
 * Before this fix, `runCanonicalMarketRegimeEngineCycleGuarded` (canonical-market-regime-scheduler.ts)
 * had zero production callers and zero test coverage. This file proves two independent things:
 *
 *  1. The scheduler MODULE's own orchestration contract — dependency call order, the coarse kill
 *     switch (checked first, zero I/O when disabled), never-throws error handling, and the
 *     module-level single-flight overlap guard — using fully fake, in-memory deps (no real network,
 *     no disk I/O, nothing under data/ touched).
 *  2. app.ts's WIRING itself — that a setInterval registered after `liveEngine.start()` actually
 *     calls the GUARDED entry point (not the raw ungated one) on the engine's own documented
 *     interval constant, using the store's real nullable prior-snapshot getter. Mirrors
 *     kronos-btc-anchor.test.ts's own "source-level guard" convention: this codebase's `isTest =
 *     Boolean(process.env.VITEST)` gate means every setInterval in buildApp() is structurally
 *     unreachable from a normal test (buildApp() is only ever called for real once, from
 *     server.ts) — there is no established pattern in this codebase for exercising a
 *     buildApp()-registered ticker end-to-end, so this is a static assertion against the real
 *     app.ts source text, not a live-fired timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Candle } from "@dtc/shared";
import type { CanonicalMarketRegimeSnapshot } from "../src/lib/canonical-market-regime-engine.js";
import type { CanonicalMarketRegimeUniverseSnapshot } from "../src/lib/canonical-market-regime-universe.js";
import {
  runCanonicalMarketRegimeEngineCycle,
  runCanonicalMarketRegimeEngineCycleGuarded,
  _resetCanonicalMarketRegimeEngineSchedulerLatchForTests,
  CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS,
  type CanonicalMarketRegimeSchedulerDeps,
} from "../src/lib/canonical-market-regime-scheduler.js";
import { CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY } from "../src/lib/canonical-market-regime-engine.js";

afterEach(() => {
  _resetCanonicalMarketRegimeEngineSchedulerLatchForTests();
  vi.restoreAllMocks();
});

function fakeUniverse(symbols: string[] = []): CanonicalMarketRegimeUniverseSnapshot {
  return {
    schemaVersion: 1,
    thresholdsVersion: 1,
    resolvedAtMs: 1_000_000,
    source: "FRESH",
    symbols,
    perSymbolMeta: {},
  };
}

/** Empty-universe ingestion cycle — deliberately minimal (requiredSymbolCount 0 is explicitly
 *  handled as INVALID coverage, never a crash — see classifyCanonicalMarketRegimeEngineCoverage).
 *  Ordering/guard/error-handling tests below don't need realistic candle data, only a call that
 *  resolves without throwing. */
function emptyIngestionCycle(atMs: number) {
  return {
    atMs,
    interval: "1h",
    requiredSymbolCount: 0,
    validSymbolCount: 0,
    coveragePct: 0,
    perSymbol: {},
    sourceObservationIds: {},
    missingSymbols: [],
    missingReasonCounts: {
      FETCH_ERROR: 0,
      MALFORMED_RESPONSE: 0,
      INSUFFICIENT_COMPLETED_CANDLES: 0,
      NON_CONTIGUOUS_CANDLES: 0,
      UNSUPPORTED_INTERVAL: 0,
    },
  };
}

/** Records every dep invocation (name only, no payload) into a shared array so ordering can be
 *  asserted precisely — mirrors direction-entry-reconciler.test.ts's own baseDeps(overrides) style. */
function baseDeps(
  calls: string[],
  overrides: Partial<CanonicalMarketRegimeSchedulerDeps> = {},
): CanonicalMarketRegimeSchedulerDeps {
  return {
    resolveUniverse: async (nowMs) => {
      calls.push("resolveUniverse");
      return fakeUniverse(["BTCUSDT", "ETHUSDT"]);
    },
    ingestRawObservations: async (symbols, nowMs) => {
      calls.push("ingestRawObservations");
      return emptyIngestionCycle(nowMs);
    },
    fetchBtcCandles: async () => {
      calls.push("fetchBtcCandles");
      return [] as Candle[];
    },
    fetchFuturesFlow: async (symbol) => {
      calls.push(`fetchFuturesFlow:${symbol}`);
      return { fundingRate: null, openInterestChangePercent: null };
    },
    getPriorSnapshot: () => {
      calls.push("getPriorSnapshot");
      return null;
    },
    recordSnapshot: (snapshot) => {
      calls.push("recordSnapshot");
      return true;
    },
    now: () => 1_000_000,
    env: {},
    ...overrides,
  };
}

describe("runCanonicalMarketRegimeEngineCycle — dependency ordering", () => {
  it("calls resolveUniverse, then ingestRawObservations, then getPriorSnapshot, then recordSnapshot, in that relative order", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(baseDeps(calls));
    expect(result.ok).toBe(true);
    const at = (name: string) => calls.indexOf(name);
    expect(at("resolveUniverse")).toBeGreaterThanOrEqual(0);
    expect(at("resolveUniverse")).toBeLessThan(at("ingestRawObservations"));
    expect(at("ingestRawObservations")).toBeLessThan(at("getPriorSnapshot"));
    expect(at("getPriorSnapshot")).toBeLessThan(at("recordSnapshot"));
  });

  it("passes resolveUniverse's own resolved symbols into ingestRawObservations, never a different list", async () => {
    const calls: string[] = [];
    let receivedSymbols: string[] | null = null;
    await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        resolveUniverse: async () => fakeUniverse(["SOLUSDT", "AVAXUSDT"]),
        ingestRawObservations: async (symbols, nowMs) => {
          receivedSymbols = symbols;
          return emptyIngestionCycle(nowMs);
        },
      }),
    );
    expect(receivedSymbols).toEqual(["SOLUSDT", "AVAXUSDT"]);
  });

  it("fetches BTC candles and per-symbol futures flow for every resolved symbol", async () => {
    const calls: string[] = [];
    await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, { resolveUniverse: async () => fakeUniverse(["BTCUSDT", "ETHUSDT", "SOLUSDT"]) }),
    );
    expect(calls).toContain("fetchBtcCandles");
    expect(calls).toContain("fetchFuturesFlow:BTCUSDT");
    expect(calls).toContain("fetchFuturesFlow:ETHUSDT");
    expect(calls).toContain("fetchFuturesFlow:SOLUSDT");
  });

  it("records a real CanonicalMarketRegimeSnapshot, not a placeholder", async () => {
    const calls: string[] = [];
    let recorded: CanonicalMarketRegimeSnapshot | null = null;
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        recordSnapshot: (snapshot) => {
          recorded = snapshot;
          return true;
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(recorded).not.toBeNull();
    expect(recorded!.schemaVersion).toBe(1);
    expect(typeof recorded!.status).toBe("string");
  });
});

describe("runCanonicalMarketRegimeEngineCycle — coarse kill switch", () => {
  it(`performs ZERO dependency calls when ${CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY}=1`, async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, { env: { [CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY]: "1" } }),
    );
    expect(result).toEqual({ ok: true, skipped: "DISABLED" });
    expect(calls).toEqual([]);
  });

  it("runs the full cycle when the kill switch is unset (default ACTIVE, hard cutover)", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(baseDeps(calls, { env: {} }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  });

  it(`runs the full cycle when ${CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY} is any value other than the literal "1"`, async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, { env: { [CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY]: "true" } }),
    );
    expect(result.skipped).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("runCanonicalMarketRegimeEngineCycle — never throws", () => {
  it("resolveUniverse rejecting resolves to {ok:false, error}, never a rejected promise", async () => {
    const calls: string[] = [];
    await expect(
      runCanonicalMarketRegimeEngineCycle(
        baseDeps(calls, {
          resolveUniverse: async () => {
            throw new Error("cold start, no prior universe, network down");
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, error: "cold start, no prior universe, network down" });
  });

  it("ingestRawObservations rejecting resolves to {ok:false, error}", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        ingestRawObservations: async () => {
          throw new Error("ingestion exploded");
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: "ingestion exploded" });
  });

  it("recordSnapshot throwing resolves to {ok:false, error}", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        recordSnapshot: () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: "disk full" });
  });

  it("a single symbol's fetchFuturesFlow rejecting does not fail the whole cycle (best-effort per symbol)", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        resolveUniverse: async () => fakeUniverse(["BTCUSDT", "ETHUSDT"]),
        fetchFuturesFlow: async (symbol) => {
          if (symbol === "ETHUSDT") throw new Error("funding endpoint 500");
          return { fundingRate: 0.0001, openInterestChangePercent: 1.2 };
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("fetchBtcCandles rejecting does not fail the whole cycle (caught, defaults to [])", async () => {
    const calls: string[] = [];
    const result = await runCanonicalMarketRegimeEngineCycle(
      baseDeps(calls, {
        fetchBtcCandles: async () => {
          throw new Error("klines endpoint timed out");
        },
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("runCanonicalMarketRegimeEngineCycleGuarded — single-flight overlap guard", () => {
  it("a second concurrent call returns null while the first is still in flight, and never runs a second real cycle", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = runCanonicalMarketRegimeEngineCycleGuarded(
      baseDeps(calls, {
        resolveUniverse: async () => {
          calls.push("resolveUniverse");
          await gate; // blocks until the test explicitly releases it
          return fakeUniverse(["BTCUSDT"]);
        },
      }),
    );

    // Let the first call actually enter (and set the latch) before firing the second.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["resolveUniverse"]);

    const secondResult = await runCanonicalMarketRegimeEngineCycleGuarded(baseDeps(calls));
    expect(secondResult).toBeNull();
    // The second call must not have invoked ANY dependency — not just "returned null while secretly running".
    expect(calls).toEqual(["resolveUniverse"]);

    releaseFirst();
    const firstResult = await firstPromise;
    expect(firstResult?.ok).toBe(true);
  });

  it("releases the latch after completion — a third call after the first resolves runs normally", async () => {
    const calls: string[] = [];
    const first = await runCanonicalMarketRegimeEngineCycleGuarded(baseDeps(calls));
    expect(first?.ok).toBe(true);
    const secondCalls: string[] = [];
    const second = await runCanonicalMarketRegimeEngineCycleGuarded(baseDeps(secondCalls));
    expect(second?.ok).toBe(true);
    expect(secondCalls.length).toBeGreaterThan(0);
  });

  it("releases the latch even when the wrapped cycle's own dependency throws (finally, not just the happy path)", async () => {
    const calls: string[] = [];
    const failing = await runCanonicalMarketRegimeEngineCycleGuarded(
      baseDeps(calls, {
        resolveUniverse: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(failing).toEqual({ ok: false, error: "boom" });
    const afterCalls: string[] = [];
    const after = await runCanonicalMarketRegimeEngineCycleGuarded(baseDeps(afterCalls));
    expect(after?.ok).toBe(true);
  });
});

describe("app.ts wiring (source-level guard, mirrors kronos-btc-anchor.test.ts's own convention)", () => {
  const APP = readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");

  it("registers the canonical-market-regime cycle on a setInterval AFTER liveEngine.start()", () => {
    const startAt = APP.indexOf("if (!isTest) liveEngine.start();");
    expect(startAt).toBeGreaterThanOrEqual(0);
    const intervalAt = APP.indexOf(
      "setInterval(runCanonicalMarketRegimeEngineTick, CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS);",
    );
    expect(intervalAt).toBeGreaterThan(startAt);
  });

  it("starts reconciliation only after the shared-account cross executor is constructed", () => {
    const startAt = APP.indexOf("if (!isTest) liveEngine.start();");
    const crossExecutorAt = APP.indexOf("crossSectionalExecutor = new CrossSectionalExecutor({");
    expect(crossExecutorAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(crossExecutorAt);
  });

  it("ticks through the GUARDED entry point, never the raw ungated one directly", () => {
    const at = APP.indexOf("const runCanonicalMarketRegimeEngineTick = ");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = APP.slice(at, at + 1500);
    expect(body).toContain("runCanonicalMarketRegimeEngineCycleGuarded(");
    // Guard against a future edit silently swapping in the raw function (no "Guarded" suffix, no
    // single-flight protection) at this exact call site.
    expect(body).not.toMatch(/[^d]runCanonicalMarketRegimeEngineCycle\(/);
  });

  it("uses the engine's own tick-interval constant, never a bare hardcoded number, for the recurring interval", () => {
    const at = APP.indexOf("setInterval(runCanonicalMarketRegimeEngineTick,");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(APP.slice(at, at + 100)).toContain("CANONICAL_MARKET_REGIME_ENGINE_TICK_INTERVAL_MS");
  });

  it("reads the prior snapshot from the store's own nullable getter, never the non-nullable degraded-default accessor", () => {
    const at = APP.indexOf("getPriorSnapshot:");
    expect(at).toBeGreaterThanOrEqual(0);
    const line = APP.slice(at, at + 120);
    expect(line).toContain("getCanonicalMarketRegimeSnapshotStore().get()");
    expect(line).not.toContain("getLatestCanonicalMarketRegimeEngineSnapshot");
  });

  it("is registered unconditionally under the same !isTest gate every other tick in buildApp() uses (no second bespoke gate)", () => {
    const at = APP.indexOf("setTimeout(runCanonicalMarketRegimeEngineTick, 30_000);");
    expect(at).toBeGreaterThanOrEqual(0);
    // The nearest enclosing `if (!isTest) {` must appear before this line, not some other custom
    // condition invented just for this ticker — proven by brace-matching that opening block (CLAUDE.md's
    // own "brace-match the method's own body via `{\n`" convention), not an arbitrary character budget.
    const guardAt = APP.lastIndexOf("if (!isTest) {", at);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const openBraceAt = APP.indexOf("{", guardAt);
    let depth = 0;
    let blockEndAt = -1;
    for (let i = openBraceAt; i < APP.length; i++) {
      if (APP[i] === "{") depth++;
      else if (APP[i] === "}") {
        depth--;
        if (depth === 0) {
          blockEndAt = i;
          break;
        }
      }
    }
    expect(blockEndAt).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(guardAt);
    expect(at).toBeLessThan(blockEndAt);
    // And no UNRELATED `if (!isTest) {`/`}` pair sits strictly between this guard and the setTimeout
    // call (which would mean lastIndexOf latched onto the wrong, non-enclosing block by coincidence).
    expect(APP.slice(openBraceAt + 1, at)).not.toContain("if (!isTest) {");
  });

  it("[REGRESSION 2026-08-05] registration sits OUTSIDE `if (liveConfig.enabled && ...) { ... }` — the scheduler must run on instances with LIVE_EXECUTION_ENABLED unset/0 (research: 3101), not only on instances where live execution happens to be configured", () => {
    // FOUND live, on the 3111 research-staging mirror of 3101: this block originally lived physically
    // inside the liveConfig.enabled section (right after `liveEngine.start()`), so on any instance
    // where LIVE_EXECUTION_ENABLED !== "1" (3101 and its staging mirror both run with it unset/0 by
    // design — research does no live execution) the setTimeout/setInterval calls below never ran at
    // all, silently, despite this exact file's own doc comment insisting registration was
    // "unconditional under `!isTest`". Confirmed via live instrumentation: a research-staging instance
    // produced zero canonical-market-regime log lines across its full runtime; the same code on a
    // LIVE_EXECUTION_ENABLED=1 instance logged a successful cycle within seconds of boot. The prior
    // test above only proves the setTimeout is inside SOME `if (!isTest) {` block — it says nothing
    // about whether THAT block is itself nested inside a larger conditional, which is exactly how this
    // regression slipped past it.
    const liveConfigGuardAt = APP.indexOf(
      "if (liveConfig.enabled && liveConfig.configErrors.length === 0 && liveConfig.env) {",
    );
    expect(liveConfigGuardAt).toBeGreaterThanOrEqual(0);
    const liveConfigOpenBraceAt = APP.indexOf("{", liveConfigGuardAt);
    let depth = 0;
    let liveConfigBlockEndAt = -1;
    for (let i = liveConfigOpenBraceAt; i < APP.length; i++) {
      if (APP[i] === "{") depth++;
      else if (APP[i] === "}") {
        depth--;
        if (depth === 0) {
          liveConfigBlockEndAt = i;
          break;
        }
      }
    }
    expect(liveConfigBlockEndAt).toBeGreaterThan(liveConfigOpenBraceAt);

    const tickDefAt = APP.indexOf("const runCanonicalMarketRegimeEngineTick = ");
    const registrationAt = APP.indexOf("setTimeout(runCanonicalMarketRegimeEngineTick, 30_000);");
    expect(tickDefAt).toBeGreaterThanOrEqual(0);
    expect(registrationAt).toBeGreaterThanOrEqual(0);

    // Neither the tick closure's own definition nor its setTimeout/setInterval registration may fall
    // strictly inside [liveConfigOpenBraceAt, liveConfigBlockEndAt) — either wholly before the block
    // starts, or (as placed by this fix) wholly after it ends.
    const insideLiveConfigBlock = (pos: number) => pos > liveConfigOpenBraceAt && pos < liveConfigBlockEndAt;
    expect(insideLiveConfigBlock(tickDefAt)).toBe(false);
    expect(insideLiveConfigBlock(registrationAt)).toBe(false);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CRISIS_MODE_CYCLE_DISABLED_FLAG,
  isCrisisModeCycleDisabled,
  btcShockFromCycleMeta,
  CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS,
  CrisisModeAuditLogStore,
  runCrisisModeCycle,
  runCrisisModeCycleGuarded,
  buildCrisisModeReport,
  type CrisisModeAuditLogEntry,
} from "../src/lib/crisis-mode-cycle.js";
import { GeopoliticalConflictFeedStore, type GdeltEvent } from "../src/lib/geopolitical-conflict-feed.js";
import { CRISIS_MODE_ACTION_ENABLED_FLAG } from "../src/lib/crisis-mode-controller.js";
import { CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG } from "../src/lib/crisis-mode-instance-guard.js";
import type { BlsCycleMeta } from "../src/lib/btc-leadlag-snap-edge.js";
import type { CrisisModeMarketShockSignals } from "../src/lib/crisis-mode-controller.js";

const BASE = 1_700_000_000_000;

function tmpPath(tag: string): string {
  return `${tmpdir()}/cmc-${tag}-${Date.now()}-${Math.random()}.json`;
}

function ev(overrides: Partial<GdeltEvent> = {}): GdeltEvent {
  return {
    id: `evt-${Math.random()}`,
    dateMs: BASE,
    cameoCode: "190",
    goldsteinScale: -9,
    actor1: "IRAN",
    actor2: "ISRAEL",
    sourceUrl: "https://example.com/a",
    title: "Iran Israel military strike",
    numMentions: 20,
    isHighSeverity: true,
    ...overrides,
  };
}

function emptyBlsCycleMeta(overrides: Partial<BlsCycleMeta> = {}): BlsCycleMeta {
  return {
    lastCycleAt: null,
    cycles: 0,
    shocksDetectedTotal: 0,
    candidatesRankedTotal: 0,
    entriesRecordedTotal: 0,
    skippedNoBetaTotal: 0,
    skippedLowBetaTotal: 0,
    skippedAlreadyMovedTotal: 0,
    lastShockAt: null,
    lastShockBarOpenTime: null,
    lastShockZScore: null,
    lastShockDirection: null,
    lastCycleError: null,
    ...overrides,
  };
}

function noMarketConfirmation(): CrisisModeMarketShockSignals {
  return { btcShock: null, regimeAxisScore: null };
}

function confirmedMarket(): CrisisModeMarketShockSignals {
  return { btcShock: { isShock: true, zScore: 6, direction: "SHORT" }, regimeAxisScore: -0.9 };
}

// Many escalating events, all high-severity + strongly-negative Goldstein, so quantitativeScore
// saturates near 100 regardless of the exact formula constants.
function loadEscalatingEvents(feedStore: GeopoliticalConflictFeedStore, nowMs: number, n = 20): void {
  for (let i = 0; i < n; i++) {
    feedStore.add(ev({ id: `esc-${i}`, dateMs: nowMs - i * 60_000 }));
  }
}

// ── isCrisisModeCycleDisabled ────────────────────────────────────────────────

describe("isCrisisModeCycleDisabled", () => {
  it("defaults to DISABLED (true) when the flag is unset — ships off by default", () => {
    expect(isCrisisModeCycleDisabled({})).toBe(true);
  });
  it("is disabled for any value other than exactly '0'", () => {
    expect(isCrisisModeCycleDisabled({ [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "false" })).toBe(true);
    expect(isCrisisModeCycleDisabled({ [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "1" })).toBe(true);
  });
  it("is enabled only when explicitly set to '0'", () => {
    expect(isCrisisModeCycleDisabled({ [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" })).toBe(false);
  });
});

// ── btcShockFromCycleMeta ─────────────────────────────────────────────────────

describe("btcShockFromCycleMeta", () => {
  it("returns null when no shock has ever been recorded", () => {
    expect(btcShockFromCycleMeta(emptyBlsCycleMeta(), BASE)).toBeNull();
  });

  it("reports isShock:true with the recorded direction/zScore when the shock is fresh", () => {
    const meta = emptyBlsCycleMeta({
      lastShockAt: new Date(BASE).toISOString(),
      lastShockZScore: 4.2,
      lastShockDirection: "SHORT",
    });
    const result = btcShockFromCycleMeta(meta, BASE + 60_000); // 1 min later, well within freshness
    expect(result).toEqual({ isShock: true, zScore: 4.2, direction: "SHORT" });
  });

  it("fails open to isShock:false (direction null) once the shock is older than the freshness window", () => {
    const meta = emptyBlsCycleMeta({
      lastShockAt: new Date(BASE).toISOString(),
      lastShockZScore: 4.2,
      lastShockDirection: "SHORT",
    });
    const staleNow = BASE + CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS + 1;
    const result = btcShockFromCycleMeta(meta, staleNow);
    expect(result?.isShock).toBe(false);
    expect(result?.direction).toBeNull();
    // zScore is still reported for transparency even when stale — only isShock/direction fail closed.
    expect(result?.zScore).toBe(4.2);
  });

  it("returns null when lastShockAt is an unparseable date", () => {
    const meta = emptyBlsCycleMeta({ lastShockAt: "not-a-date", lastShockZScore: 4.2 });
    expect(btcShockFromCycleMeta(meta, BASE)).toBeNull();
  });
});

// ── CrisisModeAuditLogStore ───────────────────────────────────────────────────

describe("CrisisModeAuditLogStore", () => {
  function entry(overrides: Partial<CrisisModeAuditLogEntry> = {}): CrisisModeAuditLogEntry {
    return {
      id: `flip-${Math.random()}`,
      atIso: new Date(BASE).toISOString(),
      atMs: BASE,
      previousActive: false,
      active: true,
      reason: "ACTIVE: test",
      escalationFinalScore: 90,
      escalationQuantitativeScore: 90,
      allocationTiltPct: 10,
      exitToleranceOverride: { baseRetraceFrac: 0.5, minRetraceFrac: 0.2, roundTripGuardR: -0.05 },
      evidence: {
        escalationFinalScore: 90,
        escalationThreshold: 75,
        escalationGatePassed: true,
        btcShockIsShock: true,
        btcShockDirection: "SHORT",
        btcShockZScore: 6,
        btcShockConfirmed: true,
        regimeAxisScore: -0.9,
        regimeAxisScoreMax: -0.5,
        regimeAxisConfirmed: true,
        marketConfirmationPassed: true,
      },
      canApplyActions: false,
      instanceId: "3102",
      ...overrides,
    };
  }

  it("dedups by id — adding the same id twice only keeps one entry", () => {
    const store = new CrisisModeAuditLogStore(tmpPath("dedup"));
    expect(store.addEntry(entry({ id: "flip-1" }))).toBe(true);
    expect(store.addEntry(entry({ id: "flip-1", active: false }))).toBe(false);
    expect(store.all).toHaveLength(1);
  });

  it("atomic write survives reload — entries + lastStatus persist across a fresh instance", () => {
    const path = tmpPath("reload");
    const store = new CrisisModeAuditLogStore(path);
    store.addEntry(entry({ id: "flip-1" }));
    store.setLastStatus({
      atIso: new Date(BASE).toISOString(),
      atMs: BASE,
      conflictIntensity: { eventCount: 3, meanGoldstein: -5, highSeverityCount: 2, windowMs: 1000 },
      escalation: { quantitativeScore: 90, llmSeverity: null, llmAvailable: false, llmConfidence: null, finalScore: 90, reasoning: [] },
      crisisMode: {
        active: true,
        reason: "ACTIVE",
        allocationTiltPct: 10,
        exitToleranceOverride: null,
        reasoning: [],
        evidence: entry().evidence,
      },
      marketShockSignals: confirmedMarket(),
      feedFetchError: null,
      llmAvailable: false,
      canApplyActions: false,
      instanceId: "3102",
    });
    store.save();

    const reloaded = new CrisisModeAuditLogStore(path);
    expect(reloaded.all).toHaveLength(1);
    expect(reloaded.lastStatus?.crisisMode.active).toBe(true);
  });

  it("recovers from a corrupt file (starts empty, never throws)", () => {
    const path = tmpPath("corrupt");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not valid json", "utf-8");
    const store = new CrisisModeAuditLogStore(path);
    expect(store.all).toEqual([]);
    expect(store.lastStatus).toBeNull();
  });

  it("bounded growth by count: prunes oldest entries beyond CRISIS_MODE_AUDIT_MAX_ENTRIES", () => {
    const store = new CrisisModeAuditLogStore(tmpPath("bounded-count"));
    // Directly push more than the cap into the underlying array via addEntry (each with a unique id
    // and increasing atMs) — save() must prune down to the configured cap.
    const cap = 300; // CRISIS_MODE_AUDIT_MAX_ENTRIES default
    for (let i = 0; i < cap + 50; i++) {
      store.addEntry(entry({ id: `flip-${i}`, atMs: BASE + i * 1000, atIso: new Date(BASE + i * 1000).toISOString() }));
    }
    store.save();
    expect(store.all.length).toBeLessThanOrEqual(cap);
    // Newest entries must survive, not oldest.
    expect(store.all.some((e) => e.id === `flip-${cap + 49}`)).toBe(true);
    expect(store.all.some((e) => e.id === "flip-0")).toBe(false);
  });
});

// ── runCrisisModeCycle ────────────────────────────────────────────────────────

describe("runCrisisModeCycle", () => {
  const ORIGINAL_FEED_DISABLED = process.env.GEOPOLITICAL_FEED_DISABLED;
  afterEach(() => {
    if (ORIGINAL_FEED_DISABLED === undefined) delete process.env.GEOPOLITICAL_FEED_DISABLED;
    else process.env.GEOPOLITICAL_FEED_DISABLED = ORIGINAL_FEED_DISABLED;
  });

  it("does nothing (disabled:true, no fetch, no store writes) when CRISIS_MODE_DISABLED is unset (the default)", async () => {
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-a"));
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-a"));
    const result = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: confirmedMarket(),
      env: {}, // CRISIS_MODE_DISABLED unset
    });
    expect(result.disabled).toBe(true);
    expect(auditStore.lastStatus).toBeNull();
    expect(auditStore.all).toHaveLength(0);
    expect(auditStore.cycleMeta.disabledCycles).toBe(1);
  });

  it("runs end-to-end but does NOT record a flip entry on the very first cycle (no prior baseline to flip from)", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1"; // skip the real GDELT fetch entirely
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-b"));
    loadEscalatingEvents(feedStore, BASE, 25);
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-b"));

    const result = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: confirmedMarket(),
      env: { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" },
    });

    expect(result.disabled).toBe(false);
    expect(result.active).toBe(true);
    // 2026-07-22 fix: no prior status existed yet, so this is a baseline reading, not a real flip.
    expect(result.flipped).toBe(false);
    expect(auditStore.all).toHaveLength(0);
    // The current state is still fully visible via lastStatus even with no flip entry logged.
    expect(auditStore.lastStatus?.crisisMode.active).toBe(true);
  });

  it("[REGRESSION 2026-07-22] the very first cycle evaluating to active=false is NOT fabricated as a flip", async () => {
    // This is the exact reported failure: a fresh store's lastStatus is null, so prevActive was
    // coerced to `false` and compared against evaluation.active=false, wrongly reading as "flipped".
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-b2"));
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-b2"));

    const result = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: noMarketConfirmation(), // no escalation, no market confirmation -> inactive
      env: { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" },
    });

    expect(result.active).toBe(false);
    expect(result.flipped).toBe(false);
    expect(auditStore.all).toHaveLength(0);
    expect(auditStore.cycleMeta.flipsTotal).toBe(0);
  });

  it("does NOT record a second flip entry when the active state is unchanged across cycles", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-c"));
    loadEscalatingEvents(feedStore, BASE, 25);
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-c"));
    const env = { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" };

    // Cycle 1 establishes the baseline (active=true) — not itself a flip (no prior state).
    await runCrisisModeCycle({ feedStore, auditStore, now: BASE, marketShockSignals: confirmedMarket(), env });
    expect(auditStore.all).toHaveLength(0);

    // Cycle 2: same signals, active stays true -> genuinely unchanged, no new entry.
    const second = await runCrisisModeCycle({ feedStore, auditStore, now: BASE + 420_000, marketShockSignals: confirmedMarket(), env });
    expect(second.flipped).toBe(false);
    expect(auditStore.all).toHaveLength(0);
  });

  it("records a flip entry each time the active state actually changes relative to a REAL prior state", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-d"));
    loadEscalatingEvents(feedStore, BASE, 25);
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-d"));
    const env = { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" };

    const first = await runCrisisModeCycle({ feedStore, auditStore, now: BASE, marketShockSignals: confirmedMarket(), env });
    expect(first.flipped).toBe(false); // baseline cycle, not a flip
    expect(auditStore.all).toHaveLength(0);

    const second = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE + 420_000,
      marketShockSignals: noMarketConfirmation(), // market no longer confirms -> INACTIVE
      env,
    });
    expect(second.active).toBe(false);
    expect(second.flipped).toBe(true);
    expect(auditStore.all).toHaveLength(1);
    // canApplyActions must be false — nothing enabled the action gates in this env.
    expect(auditStore.all[0]?.canApplyActions).toBe(false);

    const third = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE + 840_000,
      marketShockSignals: confirmedMarket(), // confirms again -> ACTIVE
      env,
    });
    expect(third.active).toBe(true);
    expect(third.flipped).toBe(true);
    expect(auditStore.all).toHaveLength(2);
    // save()'s prune() sorts newest-first, so the most recent flip (active again) comes first on disk.
    expect(auditStore.all.map((e) => e.active)).toEqual([true, false]);
  });

  it("never calls the LLM when GEOPOLITICAL_ESCALATION_LLM_ENABLED is unset (default-off gate honored)", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-e"));
    loadEscalatingEvents(feedStore, BASE, 5);
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-e"));
    let fetchCalled = false;
    const result = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: noMarketConfirmation(),
      nvidiaConfig: { apiKey: "k", baseUrl: "https://integrate.api.nvidia.com/v1", model: "m", timeoutMs: 1000, topP: 1, maxTokens: 10 },
      llmFetchImpl: (async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch,
      env: { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" },
    });
    expect(fetchCalled).toBe(false);
    expect(result.llmAvailable).toBe(false);
  });

  it("records the feed fetch error (fail-open) in the status snapshot without throwing", async () => {
    delete process.env.GEOPOLITICAL_FEED_DISABLED; // let the feed actually attempt a fetch
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-f"));
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-f"));
    const result = await runCrisisModeCycle({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: noMarketConfirmation(),
      fetchOpts: {
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      },
      env: { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" },
    });
    expect(result.disabled).toBe(false);
    expect(result.feedError).toBe("gdelt api request failed");
    expect(auditStore.lastStatus?.feedFetchError).toBe("gdelt api request failed");
  });
});

describe("runCrisisModeCycleGuarded", () => {
  afterEach(() => {
    delete process.env.GEOPOLITICAL_ESCALATION_LLM_ENABLED;
  });

  it("returns null for an overlapping call while a cycle is already in flight", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-g"));
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-g"));
    const env = { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0" };

    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const slowLlmFetch = (async () => {
      await gate;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const first = runCrisisModeCycleGuarded({
      feedStore,
      auditStore,
      now: BASE,
      marketShockSignals: noMarketConfirmation(),
      nvidiaConfig: { apiKey: "k", baseUrl: "https://integrate.api.nvidia.com/v1", model: "m", timeoutMs: 1000, topP: 1, maxTokens: 10 },
      llmFetchImpl: slowLlmFetch,
      env: { ...env, GEOPOLITICAL_ESCALATION_LLM_ENABLED: "1" },
    });
    // Give the first call a tick to set the in-flight flag before firing the second.
    await Promise.resolve();
    const second = await runCrisisModeCycleGuarded({ feedStore, auditStore, now: BASE, marketShockSignals: noMarketConfirmation(), env });
    expect(second).toBeNull();
    releaseFirst();
    await first;
  });
});

// ── buildCrisisModeReport ─────────────────────────────────────────────────────

describe("buildCrisisModeReport", () => {
  const ORIGINAL_FEED_DISABLED = process.env.GEOPOLITICAL_FEED_DISABLED;
  afterEach(() => {
    if (ORIGINAL_FEED_DISABLED === undefined) delete process.env.GEOPOLITICAL_FEED_DISABLED;
    else process.env.GEOPOLITICAL_FEED_DISABLED = ORIGINAL_FEED_DISABLED;
  });

  it("reflects the last cycle's status, gate flags, and recent audit log without re-running I/O", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-h"));
    loadEscalatingEvents(feedStore, BASE, 25);
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-h"));
    const env = { [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0", PORT: "3102" };

    // First cycle establishes the baseline (active=true, not a flip — no prior state to compare).
    await runCrisisModeCycle({ feedStore, auditStore, now: BASE, marketShockSignals: confirmedMarket(), env });
    // Second cycle: market no longer confirms -> a REAL flip to inactive, logged this time.
    await runCrisisModeCycle({ feedStore, auditStore, now: BASE + 420_000, marketShockSignals: noMarketConfirmation(), env });

    const report = buildCrisisModeReport({ feedStore, auditStore, now: BASE + 421_000, env });
    expect(report.cycleDisabled).toBe(false);
    expect(report.instanceId).toBe("3102");
    expect(report.isLiveInstance).toBe(false);
    expect(report.canApplyActions).toBe(false); // action gates unset
    expect(report.status?.crisisMode.active).toBe(false);
    expect(report.recentAuditLog).toHaveLength(1);
    expect(report.conflictFeedReport.storedEventCount).toBeGreaterThan(0);
  });

  it("reports canApplyActions:false even with both action flags on when PORT is the live instance (3103)", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const feedStore = new GeopoliticalConflictFeedStore(tmpPath("feed-i"));
    const auditStore = new CrisisModeAuditLogStore(tmpPath("audit-i"));
    const env = {
      [CRISIS_MODE_CYCLE_DISABLED_FLAG]: "0",
      PORT: "3103",
      [CRISIS_MODE_ACTION_ENABLED_FLAG]: "1",
      [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "1",
    };
    const report = buildCrisisModeReport({ feedStore, auditStore, now: BASE, env });
    expect(report.isLiveInstance).toBe(true);
    expect(report.canApplyActions).toBe(false);
  });
});

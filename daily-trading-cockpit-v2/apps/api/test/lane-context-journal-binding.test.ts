import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveLaneJournalActivation, laneJournalPaths, runResolutionScan, planSnapshotBatch, snapshotIdFor,
  validateResolutionRecord, emptyScanMetrics, type JournalFs, type ResolutionScanDeps, type LaneContextSnapshotInput,
} from "../src/lib/lane-context-journal-binding.js";
import type { ClosedOutcomeInput, ResolutionRecord } from "../src/lib/lane-outcome-processor.js";
import type { LaneContextSnapshot } from "../src/lib/lane-context-journal.js";

class FakeFs implements JournalFs {
  files = new Map<string, string>();
  calls: string[] = [];
  failAppend = false; failCheckpoint = false;
  ensureDir(): void { this.calls.push("ensureDir"); }
  readText(p: string): string | null { this.calls.push("readText"); return this.files.get(p) ?? null; }
  writeAtomic(p: string, d: string): void { this.calls.push("writeAtomic"); if (this.failCheckpoint) throw new Error("ckpt fail"); this.files.set(p, d); }
  appendLines(p: string, lines: string[]): void { this.calls.push("appendLines"); if (this.failAppend) throw new Error("append fail"); this.files.set(p, (this.files.get(p) ?? "") + lines.map((l) => l + "\n").join("")); }
  readTailLines(p: string, max: number): string[] { this.calls.push("readTailLines"); const all = (this.files.get(p) ?? "").split("\n").filter(Boolean); return all.slice(-max); }
  rotateIfNeeded(): void { this.calls.push("rotateIfNeeded"); }
}
const THROW_FS: JournalFs = { ensureDir() { throw new Error("io"); }, readText() { throw new Error("io"); }, writeAtomic() { throw new Error("io"); }, appendLines() { throw new Error("io"); }, readTailLines() { throw new Error("io"); }, rotateIfNeeded() { throw new Error("io"); } };

const outcome = (over: Partial<ClosedOutcomeInput> = {}): ClosedOutcomeInput => ({
  outcomeId: over.outcomeId ?? "o1", laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG",
  openedAtMs: 2000, closedAtMs: 5000, resolvedAtMs: over.resolvedAtMs === undefined ? 6000 : over.resolvedAtMs,
  grossR: 0.55, costR: -0.05, netR: 0.5, closeReason: "TP1_HIT", closeIntrabarAmbiguous: false, featureSchemaVersion: "lane-context-1", terminal: true,
});
const mkDeps = (env: Record<string, string>, fs: JournalFs, outcomes: ClosedOutcomeInput[]): ResolutionScanDeps => ({
  env: env as unknown as NodeJS.ProcessEnv, baseDir: "/base", fs, nowMs: 100000, singleFlightGuard: { inFlight: false },
  readOutcomes: () => outcomes, decisionsFor: () => [], metrics: emptyScanMetrics(),
  ttlMs: 1_800_000, overlapWindowMs: 300_000, detectionMarginMs: 300_000, maxConsumed: 1000, recoverTailLines: 500, journalMaxBytes: 1_000_000,
});
const SHADOW_3102 = { LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3102" };

describe("binding — instance isolation + 3103 block + mode gate", () => {
  it("mode off / unknown / 3103 all fail-closed; 3101+3102 activate", () => {
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "off", FOUR_BRAIN_INSTANCE_ID: "3102" } as never).active).toBe(false);
    expect(resolveLaneJournalActivation({ FOUR_BRAIN_INSTANCE_ID: "3102" } as never).reason).toBe("mode-off");
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "9999" } as never)).toMatchObject({ active: false, reason: "unknown-instance-fail-closed" });
    expect(resolveLaneJournalActivation(SHADOW_3102 as never).active).toBe(true);
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3101" } as never).active).toBe(true);
  });
  it("3103 is blocked by BOTH resolved identity AND raw serving port", () => {
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3103" } as never)).toMatchObject({ active: false, reason: "live-3103-blocked" });
    // a stray id relabelling the live box, but the raw PORT still says 3103 ⇒ still blocked.
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3102", PORT: "3103" } as never)).toMatchObject({ active: false, reason: "live-3103-blocked" });
  });
  it("per-instance paths isolate 3101 and 3102", () => {
    expect(laneJournalPaths("3101", "/b").resolutions).not.toBe(laneJournalPaths("3102", "/b").resolutions);
    expect(laneJournalPaths("3102", "/b").checkpoint).toContain("/3102/");
  });
  it("mode OFF performs ZERO filesystem I/O (throwing fs never touched)", () => {
    const r = runResolutionScan(mkDeps({ LANE_CONTEXT_JOURNAL_MODE: "off", FOUR_BRAIN_INSTANCE_ID: "3102" }, THROW_FS, [outcome()]));
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("mode-off");
  });
});

describe("binding — scan flow, crash semantics, watermark overlap", () => {
  it("tied resolvedAtMs outcomes are BOTH emitted (not lost), then consumed once", () => {
    const fs = new FakeFs();
    const deps = mkDeps(SHADOW_3102, fs, [outcome({ outcomeId: "a", resolvedAtMs: 6000 }), outcome({ outcomeId: "b", resolvedAtMs: 6000 })]);
    const r1 = runResolutionScan(deps);
    expect(r1.appended).toBe(2);
    const r2 = runResolutionScan({ ...deps, metrics: emptyScanMetrics() });
    expect(r2.appended).toBe(0); // both already consumed
  });
  it("a late-persisted outcome INSIDE the overlap window is still emitted", () => {
    const fs = new FakeFs();
    // seed a checkpoint with a high watermark; a resolvedAtMs below it but within overlap must still emit.
    fs.files.set(laneJournalPaths("3102", "/base").checkpoint, JSON.stringify({ schemaVersion: "lane-resolution-ckpt-2", instanceId: "3102", lastScanMs: 0, highWatermarkResolvedAtMs: 200_000, consumed: [], journalPosition: 0, updatedAtMs: 0 }));
    const deps = mkDeps(SHADOW_3102, fs, [outcome({ outcomeId: "late", resolvedAtMs: 200_000 - 100_000 })]); // inside 300k overlap
    expect(runResolutionScan(deps).appended).toBe(1);
  });
  it("APPEND ok + CHECKPOINT fail ⇒ recovers from journal tail, no duplicate semantic record", () => {
    const fs = new FakeFs(); fs.failCheckpoint = true;
    const d1 = mkDeps(SHADOW_3102, fs, [outcome()]);
    const r1 = runResolutionScan(d1);
    expect(r1.appended).toBe(1);
    expect(d1.metrics.checkpointWriteFailures).toBe(1); // checkpoint NOT advanced
    fs.failCheckpoint = false;
    const r2 = runResolutionScan(mkDeps(SHADOW_3102, fs, [outcome()])); // rescan: recovers consumed from journal
    expect(r2.appended).toBe(0); // no duplicate
  });
  it("APPEND failure does NOT advance the checkpoint (outcome stays eligible)", () => {
    const fs = new FakeFs(); fs.failAppend = true;
    const d1 = mkDeps(SHADOW_3102, fs, [outcome()]);
    const r1 = runResolutionScan(d1);
    expect(r1.appended).toBe(0);
    expect(d1.metrics.appendFailures).toBe(1);
    expect(fs.calls).not.toContain("writeAtomic"); // checkpoint never written
    fs.failAppend = false;
    expect(runResolutionScan(mkDeps(SHADOW_3102, fs, [outcome()])).appended).toBe(1); // still eligible
  });
  it("malformed journal tail lines are skipped + counted; valid ids still recovered", () => {
    const fs = new FakeFs();
    const rid = "x".repeat(32);
    fs.files.set(laneJournalPaths("3102", "/base").resolutions, `{bad json\n${JSON.stringify({ outcomeId: "o1", resolutionId: rid, resolvedAtMs: 6000 })}\n`);
    const deps = mkDeps(SHADOW_3102, fs, [outcome({ outcomeId: "o1" })]);
    const r = runResolutionScan(deps);
    expect(deps.metrics.malformedJournalLines).toBe(1);
    expect(r.appended).toBe(0); // o1 recovered from the valid journal line ⇒ not re-emitted
  });
  it("a wrong-instance checkpoint is rejected (corrupt) and the scan proceeds fail-open", () => {
    const fs = new FakeFs();
    fs.files.set(laneJournalPaths("3102", "/base").checkpoint, JSON.stringify({ schemaVersion: "lane-resolution-ckpt-2", instanceId: "3101", consumed: [], highWatermarkResolvedAtMs: 0 }));
    const deps = mkDeps(SHADOW_3102, fs, [outcome()]);
    runResolutionScan(deps);
    expect(deps.metrics.checkpointCorrupt).toBe(1);
  });
  it("single-flight skips a concurrent scan", () => {
    const deps = mkDeps(SHADOW_3102, new FakeFs(), [outcome()]);
    deps.singleFlightGuard.inFlight = true;
    expect(runResolutionScan(deps).reason).toBe("in-flight");
  });
  it("REGRESSION (finding 3): a genuinely-late sub-floor outcome is DETECTED (belowFloorDetected), not silently dropped", () => {
    const fs = new FakeFs();
    fs.files.set(laneJournalPaths("3102", "/base").checkpoint, JSON.stringify({ schemaVersion: "lane-resolution-ckpt-2", instanceId: "3102", highWatermarkResolvedAtMs: 1_000_000, consumed: [], journalPosition: 0, lastScanMs: 0, updatedAtMs: 0 }));
    // read bound = 1_000_000 − overlap(300k) − detectionMargin(300k) = 400k; planner floor = 700k. resolvedAtMs 600k
    // is between them ⇒ reaches the planner (readOutcomes surfaces it) and is COUNTED as below-floor.
    const deps = mkDeps(SHADOW_3102, fs, [outcome({ outcomeId: "late", resolvedAtMs: 600_000 })]);
    runResolutionScan(deps);
    expect(deps.metrics.belowFloorDetected).toBeGreaterThan(0);
  });
  it("REGRESSION (finding 6): a recovery tail too small to cover the window SURFACES recoveryTailInsufficient", () => {
    const fs = new FakeFs();
    const p = laneJournalPaths("3102", "/base").resolutions;
    fs.files.set(p, `${JSON.stringify({ outcomeId: "a", resolvedAtMs: 6000 })}\n${JSON.stringify({ outcomeId: "b", resolvedAtMs: 6001 })}\n`);
    const deps = { ...mkDeps(SHADOW_3102, fs, []), recoverTailLines: 1 }; // tail=1 can't cover 2 in-window records
    runResolutionScan(deps);
    expect(deps.metrics.recoveryTailInsufficient).toBeGreaterThan(0);
  });
});

describe("binding — validation + snapshot tap", () => {
  const rec = (over: Partial<ResolutionRecord> = {}): ResolutionRecord => ({
    outcomeId: "o", attributedDecisionId: null, laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG",
    openedAtMs: 1000, closedAtMs: 2000, netR: 0.5, grossR: 0.55, costR: -0.05, attributionStatus: "ATTRIBUTED", attributionRuleVersion: "lane-attr-1",
    resolutionId: "r", resolvedAtMs: 3000, closeReason: "TP1_HIT", closeIntrabarAmbiguous: false, attributionLagMs: 10, instanceId: "3102", ...over,
  });
  it("validation catches timestamp-order + arithmetic + instance violations", () => {
    expect(validateResolutionRecord(rec(), "3102").ok).toBe(true);
    expect(validateResolutionRecord(rec({ closedAtMs: 500 }), "3102").issues).toContain("opened>closed"); // opened 1000 > closed 500
    expect(validateResolutionRecord(rec({ resolvedAtMs: 1500 }), "3102").issues).toContain("closed>resolved");
    expect(validateResolutionRecord(rec({ netR: 99 }), "3102").issues).toContain("arithmetic-mismatch");
    expect(validateResolutionRecord(rec(), "3101").issues).toContain("instance-mismatch");
  });
  it("snapshot captures CURRENT in-memory values; a later mutation does NOT alter the record", () => {
    const lane: LaneContextSnapshotInput = { laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG", regimeFamily: "TREND", axisScore: 0.4, transitionRisk: 0.2, longEdge: 0.05, shortEdge: null, edgeMemory: 0.05, edgeMemoryN: 42, conviction: 0.6, controllerMode: "GRADUATED", incumbentEligible: true, vetoed: false, vetoReason: null, staticWeightPct: 25, cortexFinalPct: null, sourceStatuses: { edge: "FRESH" } };
    const batch = planSnapshotBatch("3102", 1000, [lane]);
    expect(batch.ok).toBe(true);
    expect(batch.snapshots[0]!.edgeMemory).toBe(0.05);
    lane.edgeMemory = 0.99; lane.sourceStatuses.edge = "STALE"; // mutate the live context AFTER capture
    expect(batch.snapshots[0]!.edgeMemory).toBe(0.05); // recorded snapshot is frozen (scalar)
    expect(batch.snapshots[0]!.sourceStatuses.edge).toBe("FRESH"); // REGRESSION (finding 8): reference field deep-copied, not aliased
  });
  it("a DUPLICATE lane identity rejects the whole batch (fail-safe, no partial write)", () => {
    const l = (): LaneContextSnapshotInput => ({ laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG", regimeFamily: null, axisScore: null, transitionRisk: null, longEdge: null, shortEdge: null, edgeMemory: null, edgeMemoryN: null, conviction: null, controllerMode: null, incumbentEligible: true, vetoed: false, vetoReason: null, staticWeightPct: 10, cortexFinalPct: null, sourceStatuses: {} });
    const batch = planSnapshotBatch("3102", 1000, [l(), l()]);
    expect(batch.ok).toBe(false);
    expect(batch.reason).toMatch(/duplicate-lane/);
    expect(batch.snapshots).toHaveLength(0);
  });
  it("snapshot ids are deterministic per (instance, asOf, lane, symbol, direction, schema)", () => {
    expect(snapshotIdFor("3102", 1, "L", "S", "LONG", "v")).toBe(snapshotIdFor("3102", 1, "L", "S", "LONG", "v"));
    expect(snapshotIdFor("3102", 1, "L", "S", "LONG", "v")).not.toBe(snapshotIdFor("3101", 1, "L", "S", "LONG", "v"));
  });
  it("STRUCTURAL: the binding never imports a beta / allocation / position / stop / kill MUTATION path", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/lib/lane-context-journal-binding.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/\.(placeOrder|cancelOrder|closePosition|setAllocation|updateFromClosedOrders|resetKill|setKill|rampBeta)\s*\(/);
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports).not.toMatch(/live-execution-engine|regime-edge-memory|cortex-brain\b|binance/i);
  });
});

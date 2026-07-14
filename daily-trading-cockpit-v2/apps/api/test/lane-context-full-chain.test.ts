import { describe, it, expect } from "vitest";
import { planSnapshotBatch, runResolutionScan, laneJournalPaths, emptyScanMetrics, type JournalFs, type ResolutionScanDeps, type LaneContextSnapshotInput } from "../src/lib/lane-context-journal-binding.js";
import { type ClosedOutcomeInput } from "../src/lib/lane-outcome-processor.js";
import type { LaneContextSnapshot } from "../src/lib/lane-context-journal.js";

/**
 * Fixture-based FULL CHAIN (Stage-2 evidence #7): decision snapshot → paper open → market close → resolution →
 * attribution. Proves the end-to-end logic with an in-memory fs, independent of the (not-yet-wired) live call
 * sites. One incumbent LONG lane on BTCUSDT decides at t=1000; a paper order opens at t=2000, closes at market
 * t=5000 and is persisted (resolvedAtMs=6000); the resolution scan attributes the outcome back to the snapshot.
 */
class MemFs implements JournalFs {
  files = new Map<string, string>();
  ensureDir(): void {}
  readText(p: string): string | null { return this.files.get(p) ?? null; }
  writeAtomic(p: string, d: string): void { this.files.set(p, d); }
  appendLines(p: string, lines: string[]): void { this.files.set(p, (this.files.get(p) ?? "") + lines.map((l) => l + "\n").join("")); }
  readTailLines(p: string, max: number): string[] { return (this.files.get(p) ?? "").split("\n").filter(Boolean).slice(-max); }
  rotateIfNeeded(): void {}
}

describe("Stage-2 full chain (fixture): snapshot → open → close → resolution → attribution", () => {
  it("attributes a resolved paper outcome back to its decision-time lane-context snapshot", () => {
    const instanceId = "3102";
    // 1) DECISION tick @ t=1000: one active incumbent lane, current in-memory context.
    const lane: LaneContextSnapshotInput = {
      laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG", regimeFamily: "TREND", axisScore: 0.4,
      transitionRisk: 0.2, longEdge: 0.06, shortEdge: null, edgeMemory: 0.06, edgeMemoryN: 40, conviction: 0.7,
      controllerMode: "GRADUATED", incumbentEligible: true, vetoed: false, vetoReason: null, staticWeightPct: 25,
      cortexFinalPct: 20, sourceStatuses: { edge: "FRESH", conviction: "FRESH" },
    };
    const batch = planSnapshotBatch(instanceId, 1000, [lane]);
    expect(batch.ok).toBe(true);
    const snapshots: LaneContextSnapshot[] = batch.snapshots;

    // 2) PAPER OPEN @ t=2000, 3) MARKET CLOSE @ t=5000, persisted (resolvedAtMs=6000) — the outcome the resolver produced.
    const closed: ClosedOutcomeInput = {
      outcomeId: "paper-abc", laneId: "CG_LONG", symbolOrBasketId: "BTCUSDT", direction: "LONG",
      openedAtMs: 2000, closedAtMs: 5000, resolvedAtMs: 6000, grossR: 0.9, costR: -0.05, netR: 0.85,
      closeReason: "TP1_HIT", closeIntrabarAmbiguous: false, featureSchemaVersion: "lane-context-1", terminal: true,
    };

    // 4) RESOLUTION scan attributes it back to the pre-open snapshot.
    const fs = new MemFs();
    const deps: ResolutionScanDeps = {
      env: { LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: instanceId } as unknown as NodeJS.ProcessEnv,
      baseDir: "/base", fs, nowMs: 10_000, singleFlightGuard: { inFlight: false },
      readOutcomes: () => [closed], decisionsFor: () => snapshots, metrics: emptyScanMetrics(),
      ttlMs: 3_600_000, overlapWindowMs: 300_000, detectionMarginMs: 300_000, maxConsumed: 1000, recoverTailLines: 500, journalMaxBytes: 1_000_000,
    };
    const r = runResolutionScan(deps);
    expect(r.ran).toBe(true);
    expect(r.appended).toBe(1);

    // 5) verify the appended resolution record: ATTRIBUTED to the snapshot, with the right lag + market close ts.
    const journal = fs.readTailLines(laneJournalPaths(instanceId, "/base").resolutions, 10);
    const rec = JSON.parse(journal[0]!);
    expect(rec.attributionStatus).toBe("ATTRIBUTED");
    expect(rec.attributedDecisionId).toBe(snapshots[0]!.decisionId); // linked to the decision snapshot
    expect(rec.closedAtMs).toBe(5000); // market close ts, not process time
    expect(rec.attributionLagMs).toBe(2000 - 1000); // open − decision asOf
    expect(rec.netR).toBe(0.85);
    expect(deps.metrics.appended).toBe(1);
  });
});

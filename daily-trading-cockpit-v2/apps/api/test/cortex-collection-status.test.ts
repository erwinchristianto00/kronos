import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { _resetCortexCollectionStatusAccumulatorsForTests, buildCortexCollectionStatus } from "../src/lib/cortex-collection-status.js";
import { resolveCausalCollectionActivation } from "../src/experience-engine/forward-causal-collection.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  _resetCortexCollectionStatusAccumulatorsForTests();
});

describe("cortex collection status", () => {
  it("reports append-only lineage separately from the refit subset", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3102"); mkdirSync(causalDir, { recursive: true });
    writeFileSync(
      join(causalDir, "events.jsonl"),
      // A trailing newline after the LAST line matters here: the real writer (forward-causal-collection.ts's
      // appendEvents) always appends one after every batch, and the incremental reader treats a line with
      // no trailing newline yet as an in-flight partial write (correctly, since a live append-only journal
      // could genuinely be mid-write) — so a realistic fixture must end in "\n" too.
      `${[
        JSON.stringify({ eventType: "DECISION_SNAPSHOT", eventId: "decision-1", asOfMs: 1_000, identity: { decisionId: "decision-1" }, marketState: { regime: "BULLISH" } }),
        JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_100 }),
        JSON.stringify({ eventType: "OUTCOME_RESOLUTION", resolvedAtMs: 1_200, decisionId: "decision-1", identity: { laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", direction: "LONG" }, netR: 0.04, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", intrabarAmbiguous: false }),
        JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_300 }),
      ].join("\n")}\n`,
    );
    writeFileSync(join(dir, "cortex-brain.json"), JSON.stringify({ cumulativeResolved: 1, updatedAt: "1970-01-01T00:00:01.200Z", archetypes: { BREADTH: { nEff: 2.5, refitAt: "1970-01-01T00:00:01.200Z" } } }));

    const report = buildCortexCollectionStatus({ dataDir: dir, env: { PORT: "3102", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir }, nowMs: 2_000 });
    expect(report.collection).toMatchObject({ mode: "shadow", instanceId: "3102", status: "shadow-active" });
    expect(report.lineage).toMatchObject({ decisionSnapshots: 1, opportunitiesOpened: 2, outcomesResolved: 1, unresolvedOpportunities: 1, directOutcomes: 1, economicWins: 1 });
    expect(report.cortex).toMatchObject({ brainPresent: true, cumulativeResolved: 1, liveBeta: 0 });
    expect(report.cortex.archetypes.BREADTH?.effectiveSamples).toBe(2.5);
    expect(report.learning.causalLabels).toEqual({ POSITIVE: 1, NON_POSITIVE: 0, EXCLUDED: 0 });
    expect(report.learning.recentCausalOutcomes[0]).toMatchObject({ laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", regime: "BULLISH", reinforcement: "POSITIVE" });
  });

  it("keeps mainnet collection hard-blocked even when its environment says shadow", () => {
    const report = buildCortexCollectionStatus({ env: { PORT: "3103", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow" } });
    expect(report.collection).toMatchObject({ mode: "off", instanceId: "3103", status: "live-3103-blocked" });
  });

  it("resolves the same instance id as the actual journal writer, never off env.PORT alone (2026-07-19 fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-instance-")); dirs.push(dir);
    // FOUR_BRAIN_INSTANCE_ID disagrees with PORT: the real writer (forward-causal-collection.ts) picks
    // the id via resolveFourBrainInstanceId, which prefers FOUR_BRAIN_INSTANCE_ID over PORT, and journals
    // to causal-experience/<that id>/events.jsonl. The status endpoint must resolve — and read from —
    // that same instance, not silently key off env.PORT on its own.
    const env = {
      PORT: "3101",
      FOUR_BRAIN_INSTANCE_ID: "3102",
      CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow",
      CAUSAL_EXPERIENCE_COLLECTION_DIR: dir,
    };
    const writerActivation = resolveCausalCollectionActivation(env as unknown as NodeJS.ProcessEnv);
    expect(writerActivation.instanceId).toBe("3102");

    const causalDir = join(dir, "causal-experience", writerActivation.instanceId); mkdirSync(causalDir, { recursive: true });
    writeFileSync(join(causalDir, "events.jsonl"), JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_000 }) + "\n");

    const report = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 2_000 });
    expect(report.collection.instanceId).toBe(writerActivation.instanceId);
    expect(report.collection.status).toBe("shadow-active");
    // Proves it actually located and read the writer's real journal (under 3102/), not a
    // nonexistent/blocked path derived from raw PORT ("3101").
    expect(report.lineage.totalEvents).toBe(1);
  });

  // 2026-08-05: resolveCollectionStatus used to be an independent reimplementation of
  // resolveCausalCollectionActivation's own gating logic — a second copy that had no way to learn
  // about FourBrainLogicalRole when the writer gained role-based staging authorization, and silently
  // kept reporting unknown-instance-fail-closed for an instance the real writer had already started
  // collecting on. Now delegates to the canonical function directly; this proves the two can no
  // longer disagree, on the exact shape (role-granted staging mirror) that broke before the fix.
  it("[2026-08-05 fix] a role-granted staging mirror reports the SAME activation as the real journal writer — never a stale unknown-instance-fail-closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-role-")); dirs.push(dir);
    const env = {
      PORT: "3111",
      FOUR_BRAIN_LOGICAL_ROLE: "RESEARCH",
      CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow",
      CAUSAL_EXPERIENCE_COLLECTION_DIR: dir,
    };
    const writerActivation = resolveCausalCollectionActivation(env as unknown as NodeJS.ProcessEnv);
    expect(writerActivation).toMatchObject({ active: true, instanceId: "3111", logicalRole: "RESEARCH", reason: "shadow-active" });

    const report = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 2_000 });
    expect(report.collection).toMatchObject({ mode: "shadow", instanceId: "3111", logicalRole: "RESEARCH", status: "shadow-active" });
    expect(report.collection.instanceId).not.toBe("3101");
  });

  it("only re-reads bytes appended since the last call — never the whole file again (2026-07-20 incident fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-incremental-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3101"); mkdirSync(causalDir, { recursive: true });
    const journalPath = join(causalDir, "events.jsonl");
    const env = { PORT: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };

    writeFileSync(journalPath, `${JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_000 })}\n`);
    const first = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_000 });
    expect(first.lineage.totalEvents).toBe(1);
    expect(first.lineage.opportunitiesOpened).toBe(1);

    // Journal grows in place via APPEND (never rewritten from scratch, matching the real writer). A
    // poll immediately afterward — no TTL window to wait out — must see the new lines right away, and
    // must NOT double-count the line already folded into the accumulator on the previous call.
    writeFileSync(
      journalPath,
      `${JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_100 })}\n${JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_200 })}\n`,
      { flag: "a" },
    );
    const afterGrowth = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_050 });
    expect(afterGrowth.lineage.totalEvents).toBe(3);
    expect(afterGrowth.lineage.opportunitiesOpened).toBe(3);

    // A third, no-op poll (file unchanged) must not change the counts.
    const unchanged = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_100 });
    expect(unchanged.lineage.totalEvents).toBe(3);
  });

  it("leaves a torn/partial trailing line (mid-append) unconsumed until it is completed, never dropped or double-counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-partial-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3101"); mkdirSync(causalDir, { recursive: true });
    const journalPath = join(causalDir, "events.jsonl");
    const env = { PORT: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };

    // One complete line followed by a torn, in-flight write (no trailing newline yet).
    writeFileSync(journalPath, `${JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_000 })}\n{"eventType":"OPPORTUNITY_OPEN","open`);
    const midWrite = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_000 });
    expect(midWrite.lineage.totalEvents).toBe(1); // the torn line must not be parsed yet
    expect(midWrite.collection.journalBadLines).toBe(0); // and must not be counted as a bad line either — just not-yet-consumed

    // The writer completes the line (appends the rest + a fresh newline).
    writeFileSync(journalPath, `edAtMs":1100}\n`, { flag: "a" });
    const completed = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_050 });
    expect(completed.lineage.totalEvents).toBe(2);
    expect(completed.lineage.opportunitiesOpened).toBe(2);
    expect(completed.collection.journalBadLines).toBe(0);
  });

  it("carries the decision→outcome join across incremental reads (a snapshot read in an earlier call still joins a later outcome)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-join-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3101"); mkdirSync(causalDir, { recursive: true });
    const journalPath = join(causalDir, "events.jsonl");
    const env = { PORT: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };

    writeFileSync(journalPath, `${JSON.stringify({ eventType: "DECISION_SNAPSHOT", eventId: "decision-1", asOfMs: 1_000, identity: { decisionId: "decision-1" }, marketState: { regime: "BULLISH" } })}\n`);
    buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_000 }); // first call folds the snapshot into the accumulator's join map

    writeFileSync(
      journalPath,
      `${JSON.stringify({ eventType: "OUTCOME_RESOLUTION", resolvedAtMs: 2_000, decisionId: "decision-1", identity: { laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", direction: "LONG" }, netR: 0.04, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", intrabarAmbiguous: false })}\n`,
      { flag: "a" },
    );
    const report = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_050 }); // second call only reads the new outcome line
    expect(report.learning.recentCausalOutcomes[0]).toMatchObject({ laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", regime: "BULLISH", reinforcement: "POSITIVE" });
  });

  // [2026-07-22 bug-hunt fix] decisionsById had no bound at all — every DECISION_SNAPSHOT ever read
  // added one full row, forever, for the life of the process (unlike recentOutcomes' bounded ring).
  // decisionId is 1:1 with one opportunity (hashed from selectedLaneId+symbol+direction+asOfMs in
  // forward-causal-collection.ts), so it resolves exactly once in real operation — the fix deletes
  // the entry the instant its one OUTCOME_RESOLUTION consumes it. This test proves the deletion
  // actually happens (observable via a synthetic SECOND resolution for the same decisionId — never
  // legitimate in production, but the only way to observe "was this entry actually freed" through
  // the public report API without a dedicated internal-size getter): its marketState join is gone,
  // exactly as it should be for an already-consumed decisionId.
  it("[2026-07-22 bug-hunt fix] decisionsById entry is freed immediately after its one OUTCOME_RESOLUTION consumes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-decisionsById-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3101"); mkdirSync(causalDir, { recursive: true });
    const journalPath = join(causalDir, "events.jsonl");
    const env = { PORT: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };

    writeFileSync(
      journalPath,
      `${[
        JSON.stringify({ eventType: "DECISION_SNAPSHOT", eventId: "decision-1", asOfMs: 1_000, identity: { decisionId: "decision-1" }, marketState: { regime: "BULLISH" } }),
        JSON.stringify({ eventType: "OUTCOME_RESOLUTION", resolvedAtMs: 2_000, decisionId: "decision-1", identity: { laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", direction: "LONG" }, netR: 0.04, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", intrabarAmbiguous: false }),
        // Synthetic second resolution for the SAME decisionId — never legitimate in real data, but the
        // only observable proof (through this public API) that the first lookup deleted the entry.
        JSON.stringify({ eventType: "OUTCOME_RESOLUTION", resolvedAtMs: 3_000, decisionId: "decision-1", identity: { laneId: "CG_TEST", symbolOrBasketId: "ETHUSDT", direction: "LONG" }, netR: 0.02, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", intrabarAmbiguous: false }),
      ].join("\n")}\n`,
    );
    const report = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_000 });
    const bySymbol = new Map(report.learning.recentCausalOutcomes.map((o) => [o.symbolOrBasketId, o]));
    expect(bySymbol.get("BTCUSDT")).toMatchObject({ regime: "BULLISH" }); // first lookup: entry present
    expect(bySymbol.get("ETHUSDT")?.regime).toBeNull(); // second lookup on the SAME decisionId: already freed
  });
});

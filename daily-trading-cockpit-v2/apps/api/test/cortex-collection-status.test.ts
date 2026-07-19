import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCortexCollectionStatus } from "../src/lib/cortex-collection-status.js";
import { resolveCausalCollectionActivation } from "../src/experience-engine/forward-causal-collection.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("cortex collection status", () => {
  it("reports append-only lineage separately from the refit subset", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3102"); mkdirSync(causalDir, { recursive: true });
    writeFileSync(join(causalDir, "events.jsonl"), [
      JSON.stringify({ eventType: "DECISION_SNAPSHOT", eventId: "decision-1", asOfMs: 1_000, identity: { decisionId: "decision-1" }, marketState: { regime: "BULLISH" } }),
      JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_100 }),
      JSON.stringify({ eventType: "OUTCOME_RESOLUTION", resolvedAtMs: 1_200, decisionId: "decision-1", identity: { laneId: "CG_TEST", symbolOrBasketId: "BTCUSDT", direction: "LONG" }, netR: 0.04, outcomeQuality: "RESOLVED_VALID", directAttribution: "DIRECT_CAUSAL_LINK", intrabarAmbiguous: false }),
      JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_300 }),
    ].join("\n"));
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

  it("caches the journal read for a short TTL instead of re-parsing on every call (2026-07-19 OOM-shaped fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-status-cache-")); dirs.push(dir);
    const causalDir = join(dir, "causal-experience", "3101"); mkdirSync(causalDir, { recursive: true });
    const journalPath = join(causalDir, "events.jsonl");
    const env = { PORT: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow", CAUSAL_EXPERIENCE_COLLECTION_DIR: dir };

    writeFileSync(journalPath, [JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_000 })].join("\n"));
    const first = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 10_000 });
    expect(first.lineage.totalEvents).toBe(1);

    // Journal grows in place, simulating live collection continuing to append while an operator tab
    // polls every 10s. A poll well within the TTL window must reuse the cached parse, not re-read the
    // now-larger file.
    writeFileSync(journalPath, [
      JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_000 }),
      JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_100 }),
      JSON.stringify({ eventType: "OPPORTUNITY_OPEN", openedAtMs: 1_200 }),
    ].join("\n"));
    const withinTtl = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 11_000 }); // +1s: well under the TTL
    expect(withinTtl.lineage.totalEvents).toBe(1);

    // Once the TTL has elapsed, a subsequent poll must observe the fresh file content again — the
    // cache must never survive past its window and leave the dashboard permanently stale.
    const afterTtl = buildCortexCollectionStatus({ dataDir: dir, env, nowMs: 20_000 }); // +10s from the first read
    expect(afterTtl.lineage.totalEvents).toBe(3);
  });
});

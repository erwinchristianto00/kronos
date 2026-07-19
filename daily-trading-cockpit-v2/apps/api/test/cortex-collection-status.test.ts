import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCortexCollectionStatus } from "../src/lib/cortex-collection-status.js";

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
});

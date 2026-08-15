import { describe, expect, it } from "vitest";

import type { ExecutiveDecision } from "../src/lib/four-brain-types.js";
import { rankFourBrainShadowEntries } from "../src/lib/four-brain-shadow-ranking.js";

function candidate(id: string, symbol: string, baseExpectedNetR: number, reinforcementAdjustment: number): ExecutiveDecision {
  return {
    decisionId: id,
    laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
    symbolOrBasketId: symbol,
    candidateStatus: "VALID",
    entry: { action: "ENTER_NOW" },
    shadowRanking: {
      baseExpectedNetR,
      reinforcementAdjustment,
      adjustedExpectedNetR: baseExpectedNetR + reinforcementAdjustment,
      rank: null,
      rankEligible: false,
    },
  } as unknown as ExecutiveDecision;
}

describe("Four-Brain shadow ranking", () => {
  it("lets a positive exact-fill adjustment change recommendation order, not just explanatory text", () => {
    const noBoost = candidate("a", "ETHUSDT", 0.20, 0);
    const earnedBoost = candidate("b", "XRPUSDT", 0.17, 0.06);

    const ranked = rankFourBrainShadowEntries([noBoost, earnedBoost]);

    expect(ranked.map((row) => row.decisionId)).toEqual(["b", "a"]);
    expect(ranked[0]!.shadowRanking).toMatchObject({ adjustedExpectedNetR: 0.23, rank: 1, rankEligible: true });
    expect(ranked[1]!.shadowRanking).toMatchObject({ adjustedExpectedNetR: 0.20, rank: 2, rankEligible: true });
  });

  it("keeps a non-eligible row out of the ranked block even when it carries a score", () => {
    const valid = candidate("valid", "ETHUSDT", 0.1, 0);
    const wait = { ...candidate("wait", "XRPUSDT", 0.9, 0), candidateStatus: "WAIT" as const };
    const ranked = rankFourBrainShadowEntries([wait, valid]);

    expect(ranked.map((row) => row.decisionId)).toEqual(["valid", "wait"]);
    expect(ranked[1]!.shadowRanking).toMatchObject({ rank: null, rankEligible: false });
  });
});

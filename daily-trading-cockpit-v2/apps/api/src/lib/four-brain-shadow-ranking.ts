/** Shadow ranking for otherwise-valid Entry Brain candidates.
 *
 * This is the first consumer of positive exact-fill reinforcement.  It is pure and has no
 * execution imports: the result only changes the order displayed/journaled by the shadow layer.
 */
import type { ExecutiveDecision } from "./four-brain-types.js";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function rankFourBrainShadowEntries(decisions: readonly ExecutiveDecision[]): ExecutiveDecision[] {
  const scored = decisions.map((decision, index) => {
    const ranking = decision.shadowRanking;
    const eligible =
      decision.candidateStatus === "VALID" &&
      decision.entry?.action === "ENTER_NOW" &&
      ranking !== null && ranking !== undefined &&
      finite(ranking.adjustedExpectedNetR);
    return { decision, index, eligible, score: eligible ? ranking!.adjustedExpectedNetR! : Number.NEGATIVE_INFINITY };
  });
  const ranked = scored.filter((row) => row.eligible).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftKey = `${left.decision.laneId ?? ""}:${left.decision.symbolOrBasketId ?? ""}:${left.decision.decisionId}`;
    const rightKey = `${right.decision.laneId ?? ""}:${right.decision.symbolOrBasketId ?? ""}:${right.decision.decisionId}`;
    return leftKey.localeCompare(rightKey);
  });
  const rankById = new Map(ranked.map((row, index) => [row.decision.decisionId, index + 1]));
  const annotate = ({ decision }: (typeof scored)[number]): ExecutiveDecision => {
    const ranking = decision.shadowRanking;
    if (!ranking) return decision;
    const rank = rankById.get(decision.decisionId) ?? null;
    return {
      ...decision,
      shadowRanking: {
        ...ranking,
        rank,
        rankEligible: rank !== null,
      },
    };
  };
  // The array order is itself the shadow recommendation order.  Returning the score-sorted valid
  // candidates first means a positive exact-fill adjustment changes both the displayed rank AND
  // which candidate is first in any downstream shadow consumer; non-eligible rows retain their
  // original deterministic order after the ranked block.
  return [
    ...ranked.map(annotate),
    ...scored.filter((row) => !row.eligible).sort((left, right) => left.index - right.index).map(annotate),
  ];
}

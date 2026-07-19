/**
 * Converts the frozen Tier-A replay's incumbent decisions into Experience Engine rows.
 * This is offline-only: it preserves the candle/cost-model limitations instead of
 * presenting reconstructed outcomes as observed exchange fills.
 */
import type { DirectionHorizon } from "../lib/four-brain-types.js";
import { HORIZON_BARS, HOUR, type TADirRow } from "../lib/replay-tier-a-core.js";
import { normalizeExperience, type ExperienceRecord } from "./experience-engine.js";

export const TIER_A_REPLAY_FEATURE_SCHEMA = "tier-a-candle-direction/1";
export const TIER_A_REPLAY_CODE_VERSION = "replay-tier-a-core/frozen";

const directionOf = (action: string): "LONG" | "SHORT" | "FLAT" =>
  action === "LONG" || action === "SHORT" ? action : "FLAT";

/** Only GOLD rows have passed the Tier-A causal and label-safety checks. */
export function exportHistoricalCausalReplay(
  rows: readonly TADirRow[],
  opts: { manifestHash: string; sourceLabel?: string },
): ExperienceRecord[] {
  const codeVersion = `${TIER_A_REPLAY_CODE_VERSION}#${opts.manifestHash}`;
  return rows
    .filter((row) => row.status === "GOLD" && row.chosenNetR !== null && Number.isFinite(row.chosenNetR))
    .map((row) => {
      const direction = directionOf(row.action);
      const horizonMs = HORIZON_BARS[row.horizon as DirectionHorizon] * HOUR;
      const vector = row.x.length === 3 && row.x.every(Number.isFinite) ? row.x.slice() : null;
      return normalizeExperience({
        experienceId: `historical-tier-a:${opts.manifestHash}:${row.symbol}:${row.horizon}:${row.tMs}:${direction}`,
        source: "HISTORICAL_CAUSAL_REPLAY",
        provenance: "HISTORICAL_CAUSAL",
        decisionTimeMs: row.tMs,
        // A FLAT incumbent does not create exposure, but it still has a known horizon-end outcome.
        openedTimeMs: direction === "FLAT" ? null : row.tMs,
        marketCloseTimeMs: row.tMs + horizonMs,
        resolvedTimeMs: row.tMs + horizonMs,
        laneId: `TIER_A_CANDLE_DIRECTION_${row.horizon}`,
        symbolOrBasketId: row.symbol,
        direction,
        featureSchemaVersion: TIER_A_REPLAY_FEATURE_SCHEMA,
        codeVersion,
        featureVector: vector,
        sourceStatuses: {
          candles: "FRESH",
          executionCostModel: "FRESH",
          breadth: "MISSING",
          liquidity: "MISSING",
          sentiment: "MISSING",
        },
        attributionStatus: "ATTRIBUTED",
        outcomeQuality: "RESOLVED_VALID",
        outcomeNetR: row.chosenNetR,
        labels: {
          direction,
          entry: direction === "FLAT" ? "SKIP" : "ENTER_NOW",
          exit: "INCUMBENT_TP_SL",
          allocationMultiple: direction === "FLAT" ? 0 : 1,
        },
        executionLabelKind: "EXECUTION_MODEL_ESTIMATE",
      });
    });
}

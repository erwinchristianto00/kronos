import { describe, expect, it } from "vitest";

import { exportHistoricalCausalReplay } from "../src/experience-engine/historical-causal-replay-export.js";
import type { TADirRow } from "../src/lib/replay-tier-a-core.js";

const row = (overrides: Partial<TADirRow> = {}): TADirRow => ({
  symbol: "BTCUSDT", horizon: "INTRADAY", tMs: 1_700_000_000_001, x: [0.1, 0.2, -0.3],
  action: "LONG", bestAction: "LONG", longNetR: { L1_base: 0.4 }, shortNetR: { L1_base: -0.5 },
  chosenNetR: 0.4, win: 1, status: "GOLD", ...overrides,
});

describe("historical causal replay exporter", () => {
  it("emits complete attributed historical rows without claiming an observed fill", () => {
    const [record] = exportHistoricalCausalReplay([row()], { manifestHash: "abc" });
    expect(record).toMatchObject({
      source: "HISTORICAL_CAUSAL_REPLAY", provenance: "HISTORICAL_CAUSAL", attributionStatus: "ATTRIBUTED",
      executionLabelKind: "EXECUTION_MODEL_ESTIMATE", outcomeNetR: 0.4,
      eligibility: "CANDIDATE_LEARNING_ELIGIBLE",
    });
    expect(record?.sourceStatuses.breadth).toBe("MISSING");
  });

  it("does not export non-gold or unlabelled rows", () => {
    expect(exportHistoricalCausalReplay([row({ status: "REPLAY_ONLY" }), row({ chosenNetR: null })], { manifestHash: "abc" })).toEqual([]);
  });

  it("keeps an incumbent FLAT as a no-exposure SKIP decision", () => {
    const [record] = exportHistoricalCausalReplay([row({ action: "FLAT", chosenNetR: 0 })], { manifestHash: "abc" });
    expect(record?.direction).toBe("FLAT");
    expect(record?.openedTimeMs).toBeNull();
    expect(record?.labels).toMatchObject({ entry: "SKIP", allocationMultiple: 0 });
    expect(record?.eligibilityReasons).toContain("historical_flat_abstention_has_no_trade_label");
  });
});

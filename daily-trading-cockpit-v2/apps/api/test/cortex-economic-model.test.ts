import { describe, expect, it } from "vitest";
import { CORTEX_FEATURE_SCHEMA_VERSION } from "../src/lib/cortex-brain.js";
import {
  predictCortexEconomicNetR,
  refitCortexEconomicModel,
} from "../src/lib/cortex-economic-model.js";

const now = 1_750_000_000_000;
const x = (edge: number) => [1, edge];
const examples = (rows: Array<[number, number]>) => rows.map(([edge, realizedNetR], index) => ({
  x: x(edge),
  realizedNetR,
  tMs: now - index * 60_000,
  schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION,
}));

describe("CORTEX economic model", () => {
  it("learns realized net R rather than a high win-rate binary proxy", () => {
    const fit = refitCortexEconomicModel(
      examples(Array.from({ length: 30 }, (_, i) => i < 24 ? [1, -0.05] as [number, number] : [0, 0.08] as [number, number])),
      [0, 0],
      { nowMs: now, minEffectiveN: 10 },
    );
    const negative = predictCortexEconomicNetR(fit, x(1));
    const positive = predictCortexEconomicNetR(fit, x(0));
    expect(fit.status).toBe("ACCEPTED");
    expect(negative.predictedNetR).toBeLessThan(positive.predictedNetR!);
  });

  it("keeps an extreme outcome from dominating a robust fit", () => {
    const baseline = examples(Array.from({ length: 30 }, () => [1, 0.08] as [number, number]));
    const fit = refitCortexEconomicModel([...baseline, ...examples([[1, -20]])], [0, 0], { nowMs: now, minEffectiveN: 10 });
    expect(fit.status).toBe("ACCEPTED");
    expect(predictCortexEconomicNetR(fit, x(1)).predictedNetR).toBeGreaterThan(0);
  });

  it("fails closed for insufficient or invalid evidence", () => {
    const fit = refitCortexEconomicModel(examples([[1, 0.2]]), [0, 0], { nowMs: now });
    expect(fit.status).toBe("INSUFFICIENT_DATA");
    expect(predictCortexEconomicNetR(fit, x(1)).conservativeExpectedNetR).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCurrentCrossSectionalPolicyFingerprint,
  effectiveCrossSectionalRuntime,
} from "../src/lib/cross-sectional-policy.js";

describe("cross-sectional effective runtime policy", () => {
  it("reports Plain MOM36 independently from the Smart Basket lifecycle switch", () => {
    const env = {
      CROSS_SECTIONAL_SMART_BASKET_V1: "1",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
      CROSS_SECTIONAL_FILTERED_WEIGHTING: "CAPPED_SCORE_RANK",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
    } as NodeJS.ProcessEnv;
    const fingerprint = buildCurrentCrossSectionalPolicyFingerprint("2026-08-20T00:00:00.000Z", env);
    const runtime = effectiveCrossSectionalRuntime(true, env);

    expect(fingerprint.schemaVersion).toBe("CURRENT_POLICY_FORWARD_COHORT_V2");
    expect(fingerprint.formation).toMatchObject({
      formationMode: "PLAIN_MOM36",
      smartFormationRerank: false,
      entryRevalidationEnabled: true,
      scoreGap: 0.058,
      clusterCap: 2,
      weighting: "CAPPED_SCORE_RANK",
    });
    expect(fingerprint.execution).toMatchObject({ adaptiveExitsEnabled: false, adaptiveExitMode: "OFF" });
    expect(runtime).toMatchObject({
      formationMode: "PLAIN_MOM36",
      entryRevalidation: true,
      adaptiveExitMode: "OFF",
    });
  });

  it("reports Smart Formation only when its own rerank switch is ON", () => {
    const env = {
      CROSS_SECTIONAL_SMART_BASKET_V1: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "1",
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "1",
    } as NodeJS.ProcessEnv;
    const fingerprint = buildCurrentCrossSectionalPolicyFingerprint("2026-08-20T00:00:00.000Z", env);
    const runtime = effectiveCrossSectionalRuntime(true, env);

    expect(fingerprint.formation).toMatchObject({
      formationMode: "SMART_FORMATION_RERANK",
      smartFormationRerank: true,
      entryRevalidationEnabled: false,
    });
    expect(runtime).toMatchObject({
      formationMode: "SMART_FORMATION_RERANK",
      entryRevalidation: false,
      adaptiveExitMode: "ON",
    });
  });
});

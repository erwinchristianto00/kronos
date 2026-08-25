import { describe, expect, it } from "vitest";
import {
  buildCurrentCrossSectionalPolicyFingerprint,
  currentCrossSectionalExitPolicy,
  effectiveCrossSectionalRuntime,
  legacyCrossSectionalExitPolicy,
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

    expect(fingerprint.schemaVersion).toBe("CURRENT_POLICY_FORWARD_COHORT_V3");
    expect(fingerprint.formation).toMatchObject({
      formationMode: "PLAIN_MOM36",
      smartFormationRerank: false,
      entryRevalidationEnabled: true,
      scoreGap: 0.058,
      clusterCap: 2,
      weighting: "CAPPED_SCORE_RANK",
    });
    expect(fingerprint.execution).toMatchObject({ adaptiveExitsEnabled: false, adaptiveExitMode: "OFF" });
    expect(fingerprint.reliability).toMatchObject({
      version: "SYMBOL_RELIABILITY_V1",
      enabled: false,
      evidenceContract: "ACTUAL_NO_TP_HOLD_36H_INDEPENDENT_EPISODES_V1",
      minimumIndependentEpisodes: 8,
      requiredDeteriorationWindows: 2,
      requiredConsecutiveEvaluations: 2,
    });
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

  it("freezes Reliability V1 in the policy identity only when explicitly enabled", () => {
    const base = {
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
      CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "36",
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "0",
    } as NodeJS.ProcessEnv;
    const disabled = buildCurrentCrossSectionalPolicyFingerprint("2026-08-20T00:00:00.000Z", base);
    const enabled = buildCurrentCrossSectionalPolicyFingerprint("2026-08-20T00:00:00.000Z", {
      ...base,
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "1",
    });

    expect(disabled.reliability.enabled).toBe(false);
    expect(enabled.reliability.enabled).toBe(true);
    expect(enabled.policyId).not.toBe(disabled.policyId);
  });

  it("enables the explicit full 6% TP only for policy snapshots created under that policy", () => {
    const prior = currentCrossSectionalExitPolicy({
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "1",
      CROSS_SECTIONAL_EXEC_TP_NET_RETURN: "0.06",
      CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "36",
    } as NodeJS.ProcessEnv);
    const current = currentCrossSectionalExitPolicy({
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "0",
      CROSS_SECTIONAL_EXEC_TP_NET_RETURN: "0.06",
      CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: "36",
    } as NodeJS.ProcessEnv);

    expect(prior).toMatchObject({
      takeProfitEnabled: false,
      takeProfitNetReturn: null,
      executionCapHours: 36,
    });
    expect(current).toMatchObject({
      takeProfitEnabled: true,
      takeProfitNetReturn: 0.06,
      executionCapHours: 36,
    });
  });

  it("freezes Dynamic MOM36 as $25/leg, 1x, one slot, no ordinary exits, while preserving the legacy contract", () => {
    const env = {
      CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-shock-36h-v1",
      CROSS_SECTIONAL_POLICY_VERSION: "dynamic-mom36-shock-36h-v1",
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_EXEC_TP_DISABLED: "0",
      CROSS_SECTIONAL_EXEC_TP_NET_RETURN: "0.06",
      CROSS_SECTIONAL_EXEC_STOP_NET_RETURN: "0.03",
      CROSS_SECTIONAL_EXEC_LEG_USD: "999",
      CROSS_SECTIONAL_EXEC_LEVERAGE: "99",
      CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS: "99",
      CROSS_SECTIONAL_LEGACY_EXEC_LEG_USD: "25",
      CROSS_SECTIONAL_LEGACY_EXEC_LEVERAGE: "3",
      CROSS_SECTIONAL_LEGACY_EXEC_MAX_OPEN_BASKETS: "1",
      CROSS_SECTIONAL_LEGACY_EXEC_TP_DISABLED: "0",
      CROSS_SECTIONAL_LEGACY_EXEC_TP_NET_RETURN: "0.06",
      CROSS_SECTIONAL_LEGACY_EXEC_STOP_NET_RETURN: "0",
      CROSS_SECTIONAL_LEGACY_EXEC_MAX_HOLD_HOURS: "36",
    } as NodeJS.ProcessEnv;
    const dynamic = currentCrossSectionalExitPolicy(env);
    const legacy = legacyCrossSectionalExitPolicy(env);
    const fingerprint = buildCurrentCrossSectionalPolicyFingerprint("2026-08-25T00:00:00.000Z", env);

    expect(dynamic).toMatchObject({
      measurementHorizonBars: 36,
      measurementInterval: "1h",
      executionCapHours: 36,
      takeProfitEnabled: false,
      stopLossEnabled: false,
      adaptiveExitsEnabled: false,
      legNotionalUsd: 25,
      leverage: 1,
      maxOpenBaskets: 1,
      ordinaryContextInvalidationEnabled: false,
    });
    expect(legacy).toMatchObject({ takeProfitEnabled: true, leverage: 3, legNotionalUsd: 25, maxOpenBaskets: 1 });
    expect(fingerprint).toMatchObject({
      strategy: { strategyVersion: "dynamic-mom36-shock-36h-v1", signal: "DYNAMIC_MOM36_SHOCK_36H" },
      formation: { weighting: "EQUAL_NOTIONAL", formationMode: "PLAIN_MOM36", smartFormationRerank: false },
      execution: dynamic,
    });
    expect(effectiveCrossSectionalRuntime(true, {
      ...env,
      CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: "1",
    })).toMatchObject({
      adaptiveExitMode: "OFF",
      adaptiveExits: { configured: false, effective: false },
    });
  });
});

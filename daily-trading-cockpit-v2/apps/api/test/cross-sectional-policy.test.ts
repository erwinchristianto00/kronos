import { describe, expect, it } from "vitest";
import {
  buildCurrentCrossSectionalPolicyFingerprint,
  crossSectionalSelectionRuntime,
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
    expect(fingerprint.execution.ordinaryContextInvalidationEnabled).toBe(false);
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

  it("makes selection-policy drift fail closed instead of silently changing 3L/3S geometry", () => {
    const plain = crossSectionalSelectionRuntime({
      CROSS_SECTIONAL_STRATEGY_VERSION: "plain-mom36-filtered-3l3s-36h-usdm-v1",
      CROSS_SECTIONAL_EXEC_VARIANT: "FILTERED",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1",
    } as NodeJS.ProcessEnv);
    expect(plain).toMatchObject({
      selectionMode: "PLAIN_MOM36_3L3S",
      effectiveVariant: "FILTERED",
      geometry: "3L/3S",
      state: "EFFECTIVE",
    });

    const drift = crossSectionalSelectionRuntime({
      CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4",
      CROSS_SECTIONAL_EXEC_VARIANT: "FILTERED",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1",
    } as NodeJS.ProcessEnv);
    expect(drift).toMatchObject({
      selectionMode: "DYNAMIC_MOM36_BREADTH",
      effectiveVariant: "DYNAMIC_MOM36_SHOCK",
      state: "CONFIG_INEFFECTIVE",
    });

    const runtime = effectiveCrossSectionalRuntime(true, {
      CROSS_SECTIONAL_STRATEGY_VERSION: "plain-mom36-filtered-3l3s-36h-usdm-v1",
      CROSS_SECTIONAL_EXEC_VARIANT: "FILTERED",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "1",
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1",
    } as NodeJS.ProcessEnv);
    expect(runtime.selection).toMatchObject({ state: "CONFIG_INEFFECTIVE", geometry: "3L/3S" });
    expect(runtime.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "CROSS_SECTIONAL_SELECTION_RUNTIME", effective: "NO_NEW_BASKETS" }),
    ]));
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

  it("persists v4 continuation and recovered SLOW_AND_FAST provenance without reviving the legacy env wrapper", () => {
    const env = {
      CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4",
      CROSS_SECTIONAL_POLICY_VERSION: "dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4",
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0",
    } as NodeJS.ProcessEnv;
    const fingerprint = buildCurrentCrossSectionalPolicyFingerprint("2026-08-26T00:00:00.000Z", env);
    const exit = currentCrossSectionalExitPolicy(env);

    expect(fingerprint.strategy).toMatchObject({
      strategyVersion: "dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4",
      continuationArtifactId: "dm-36h-v4-20260824T153338Z:sha256:4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114",
      slowFastPolicyId: "slow-fast-mom36-fast4h-strict-sign-v1",
      slowFastImplementationVersion: "legacy-d5243fd-strict-sign-verified-v1",
    });
    expect(exit.dynamicV3Exit).toMatchObject({
      hardCutLossNetReturn: -0.02,
      mfeArmNetReturn: 0.03,
      mfeGivebackFraction: 0.30,
      horizonHours: 36,
    });
  });

  it("keeps V5 on the same continuation exit contract while versioning its fallback policy separately", () => {
    const env = {
      CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      CROSS_SECTIONAL_POLICY_VERSION: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
    } as NodeJS.ProcessEnv;

    expect(buildCurrentCrossSectionalPolicyFingerprint("2026-08-26T06:20:00.000Z", env).strategy).toMatchObject({
      strategyVersion: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      continuationArtifactId: "dm-36h-v4-20260824T153338Z:sha256:4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114",
      slowFastPolicyId: "slow-fast-mom36-fast4h-strict-sign-v1",
    });
    expect(currentCrossSectionalExitPolicy(env).dynamicV3Exit).toMatchObject({
      hardCutLossNetReturn: -0.02,
      mfeArmNetReturn: 0.03,
      mfeGivebackFraction: 0.30,
      horizonHours: 36,
    });
  });

  it("treats the TESTNET V5 contract as effective Dynamic breadth, not a mislabeled Plain 3L/3S basket", () => {
    const env = {
      CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      CROSS_SECTIONAL_POLICY_VERSION: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      CROSS_SECTIONAL_EXEC_VARIANT: "DYNAMIC_MOM36_SHOCK",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1",
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_EXEC_TICK_MS: "60000",
    } as NodeJS.ProcessEnv;

    expect(crossSectionalSelectionRuntime(env)).toMatchObject({
      strategyVersion: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
      configuredVariant: "DYNAMIC_MOM36_SHOCK",
      effectiveVariant: "DYNAMIC_MOM36_SHOCK",
      selectionMode: "DYNAMIC_MOM36_BREADTH",
      geometry: "BREADTH_6_TOTAL",
      state: "EFFECTIVE",
    });
    expect(effectiveCrossSectionalRuntime(true, env).selection).toMatchObject({
      selectionMode: "DYNAMIC_MOM36_BREADTH",
      geometry: "BREADTH_6_TOTAL",
      state: "EFFECTIVE",
    });
    expect(buildCurrentCrossSectionalPolicyFingerprint("2026-08-26T14:08:52.000Z", env)).toMatchObject({
      strategy: {
        strategyVersion: "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5",
        signal: "DYNAMIC_MOM36_SHOCK_36H",
        selectionMode: "DYNAMIC_MOM36_BREADTH",
        selectionState: "EFFECTIVE",
      },
      formation: { weighting: "EQUAL_NOTIONAL", entryRevalidationEnabled: false },
      execution: {
        executionCapHours: 36,
        dynamicV3Exit: {
          hardCutLossNetReturn: -0.02,
          mfeArmNetReturn: 0.03,
          mfeGivebackFraction: 0.30,
        },
      },
    });
  });
});

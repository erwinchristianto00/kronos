/**
 * One explicit, serialisable policy contract for the market-neutral cross-sectional executor.
 *
 * The executor, its status API, and /control must describe the same effective policy.  Keeping
 * this outside either UI prevents an env value from being displayed as active when no runtime path
 * consumes it.  A basket stores this object at admission; later env changes therefore cannot
 * silently change the exit contract of an already-open position.
 */
import { createHash } from "node:crypto";
import {
  crossSectionalAdaptiveExitMode,
  crossSectionalFilteredSideTrendAlignment,
  crossSectionalFormationMode,
  isCrossSectionalSmartBasketLifecycleEnabled,
  isCrossSectionalSmartFormationRerankEnabled,
  type CrossSectionalAdaptiveExitMode,
  type CrossSectionalFormationMode,
  type CrossSectionalSideTrendAlignment,
} from "./cross-sectional-runtime-mode.js";
import { symbolReliabilityPolicyFingerprint } from "./cross-sectional-symbol-reliability.js";
import {
  DYNAMIC_MOM36_HARD_CUT_LOSS,
  DYNAMIC_MOM36_MFE_ARM_THRESHOLD,
  DYNAMIC_MOM36_MFE_GIVEBACK_FRACTION,
  DYNAMIC_MOM36_SHOCK_SIGNAL,
  DYNAMIC_MOM36_SHOCK_VARIANT,
  NO_FROZEN_RUNTIME_SHOCK_ARTIFACT,
  crossSectionalStrategyVersion,
  isDynamicMom36ContinuationStrategy,
  isDynamicMom36ContinuationVersion,
  isDynamicMom36ShockStrategy,
  isDynamicMom36SlowFastStrategy,
  isDynamicMom36SlowFastVersion,
} from "./dynamic-mom36-shock-strategy.js";
import { DYNAMIC_MOM36_CONTINUATION_ARTIFACT_ID } from "./dynamic-mom36-continuation-runtime.js";
import {
  DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION,
  DYNAMIC_MOM36_SLOW_FAST_POLICY_ID,
} from "./dynamic-mom36-slowfast.js";

export const CURRENT_POLICY_FINGERPRINT_SCHEMA = "CURRENT_POLICY_FORWARD_COHORT_V3" as const;

export type RuntimeConfigState = "EFFECTIVE" | "CONFIG_INEFFECTIVE";

export type CrossSectionalExitPolicySnapshot = {
  measurementHorizonBars: number | null;
  measurementInterval: string;
  executionCapHours: number | null;
  takeProfitEnabled: boolean;
  takeProfitNetReturn: number | null;
  stopLossEnabled: boolean;
  stopLossNetReturn: number | null;
  adaptiveExitsEnabled: boolean;
  adaptiveExitMode: CrossSectionalAdaptiveExitMode;
  makerEntryEnabled: boolean;
  makerExitEnabled: boolean;
  makerExitWaitMs: number | null;
  executorTickMs: number;
  /** Frozen sizing and slot controls, so an env change cannot alter an open basket. */
  legNotionalUsd?: number | null;
  leverage?: number | null;
  maxOpenBaskets?: number | null;
  /** Dynamic MOM36 holds through ordinary context changes by explicit policy. */
  ordinaryContextInvalidationEnabled?: boolean;
  /** Strategy-versioned v3 basket exit contract. Null/undefined means not a v3 basket. */
  dynamicV3Exit?: {
    hardCutLossNetReturn: number;
    mfeArmNetReturn: number;
    mfeGivebackFraction: number;
    horizonHours: number;
  } | null;
};

export type CrossSectionalPolicyFingerprint = {
  schemaVersion: typeof CURRENT_POLICY_FINGERPRINT_SCHEMA;
  policyId: string;
  capturedAt: string;
  forwardCohortStartedAt: string | null;
  strategy: {
    strategyVersion: string;
    signal: string;
    sourceSha: string;
    gitHash: string;
    configHash: string;
    modelArtifactId: string;
    /** Additive fields: absent only on pre-v4 persisted fingerprints. */
    continuationArtifactId?: string | null;
    slowFastPolicyId?: string | null;
    slowFastImplementationVersion?: string | null;
    deploymentTimestamp: string | null;
    policyVersion: string;
    variant: string;
    /** What the executor was explicitly configured to consume before runtime validation. */
    configuredVariant?: string;
    /** Explicitly distinguishes balanced Plain MOM36 from breadth-driven directional geometry. */
    selectionMode?: CrossSectionalSelectionMode;
    selectionState?: RuntimeConfigState;
    momentumBars: number | null;
    legsPerSide: number | null;
  };
  universe: {
    longPool: string[];
    shortPool: string[];
    shortBlocklist: string[];
  };
  formation: {
    scoreGap: number | null;
    clusterCap: number | null;
    weighting: string;
    formationMode: CrossSectionalFormationMode;
    smartFormationRerank: boolean;
    sideTrendAlignment: CrossSectionalSideTrendAlignment;
    /** Eligibility used by the balanced score-gap / cluster admission probe. */
    admissionProbeSideTrendAlignment?: CrossSectionalSideTrendAlignment;
    entryRevalidationEnabled: boolean;
    entryHealthBypassed: boolean;
  };
  reliability: ReturnType<typeof symbolReliabilityPolicyFingerprint>;
  execution: CrossSectionalExitPolicySnapshot;
};

export type CrossSectionalEffectiveRuntime = {
  /** Direct, effective behaviour labels for API/dashboard consumers. */
  strategyVersion: string;
  formationMode: CrossSectionalFormationMode;
  sideTrendAlignment: CrossSectionalSideTrendAlignment;
  /** Dynamic V5's admission probe must not inherit the legacy balanced-side eligibility gate. */
  admissionProbeSideTrendAlignment: CrossSectionalSideTrendAlignment;
  adaptiveExitMode: CrossSectionalAdaptiveExitMode;
  entryRevalidation: boolean;
  executorTick: {
    configured: string | null;
    effectiveMs: number;
    state: RuntimeConfigState;
    reason: string | null;
  };
  makerExit: {
    configured: boolean;
    effective: boolean;
    waitMs: number | null;
    state: RuntimeConfigState;
    reason: string | null;
  };
  adaptiveExits: {
    configured: boolean;
    effective: boolean;
    state: RuntimeConfigState;
  };
  selection: CrossSectionalSelectionRuntime;
  mismatches: Array<{ key: string; configured: unknown; effective: unknown; reason: string }>;
};

const parsePositiveNumber = (raw: string | undefined): number | null => {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
};

const parseFiniteNumber = (raw: string | undefined): number | null => {
  const value = Number(raw ?? "");
  return Number.isFinite(value) ? value : null;
};

const parseSymbols = (raw: string | undefined): string[] =>
  [...new Set((raw ?? "").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();

export type CrossSectionalSelectionMode = "PLAIN_MOM36_3L3S" | "DYNAMIC_MOM36_BREADTH";

/**
 * The only admission contract for the cross-sectional executor.
 *
 * Dynamic MOM36 is intentionally permitted to use breadth-driven 6L0S through 0L6S geometry.
 * Plain MOM36 is intentionally a balanced 3L/3S basket.  A strategy-version/variant mismatch
 * used to let the app silently run Dynamic selection while the environment/dashboard claimed the
 * legacy FILTERED contract.  Expose it here so app.ts can fail closed before an order is possible.
 */
export type CrossSectionalSelectionRuntime = {
  strategyVersion: string;
  configuredVariant: string;
  effectiveVariant: "FILTERED" | typeof DYNAMIC_MOM36_SHOCK_VARIANT;
  selectionMode: CrossSectionalSelectionMode;
  geometry: "3L/3S" | "BREADTH_6_TOTAL";
  sideTrendAlignment: CrossSectionalSideTrendAlignment;
  state: RuntimeConfigState;
  reason: string | null;
};

export function crossSectionalSelectionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): CrossSectionalSelectionRuntime {
  const strategyVersion = crossSectionalStrategyVersion(env);
  const dynamic = isDynamicMom36ShockStrategy(env);
  const configuredVariant = (env.CROSS_SECTIONAL_EXEC_VARIANT ?? "FILTERED").trim().toUpperCase() || "FILTERED";
  const effectiveVariant = dynamic ? DYNAMIC_MOM36_SHOCK_VARIANT : "FILTERED";
  const configuredK = parsePositiveNumber(env.CROSS_SECTIONAL_K) ?? 3;
  const regimeSkewEnabled = env.CROSS_SECTIONAL_REGIME_SKEW_ENABLED === "1";
  const sideTrendAlignment = crossSectionalFilteredSideTrendAlignment(env);
  const mode: CrossSectionalSelectionMode = dynamic ? "DYNAMIC_MOM36_BREADTH" : "PLAIN_MOM36_3L3S";

  if (configuredVariant !== effectiveVariant) {
    return {
      strategyVersion,
      configuredVariant,
      effectiveVariant,
      selectionMode: mode,
      geometry: dynamic ? "BREADTH_6_TOTAL" : "3L/3S",
      sideTrendAlignment,
      state: "CONFIG_INEFFECTIVE",
      reason: `CROSS_SECTIONAL_EXEC_VARIANT=${configuredVariant} conflicts with ${strategyVersion}, which requires ${effectiveVariant}`,
    };
  }
  if (!dynamic && configuredK !== 3) {
    return {
      strategyVersion,
      configuredVariant,
      effectiveVariant,
      selectionMode: mode,
      geometry: "3L/3S",
      sideTrendAlignment,
      state: "CONFIG_INEFFECTIVE",
      reason: `Plain MOM36 production contract requires CROSS_SECTIONAL_K=3; got ${configuredK}`,
    };
  }
  if (!dynamic && regimeSkewEnabled) {
    return {
      strategyVersion,
      configuredVariant,
      effectiveVariant,
      selectionMode: mode,
      geometry: "3L/3S",
      sideTrendAlignment,
      state: "CONFIG_INEFFECTIVE",
      reason: "Plain MOM36 production contract requires CROSS_SECTIONAL_REGIME_SKEW_ENABLED=0 to preserve 3L/3S geometry",
    };
  }
  if (!dynamic && sideTrendAlignment !== "SLOW_AND_FAST") {
    return {
      strategyVersion,
      configuredVariant,
      effectiveVariant,
      selectionMode: mode,
      geometry: "3L/3S",
      sideTrendAlignment,
      state: "CONFIG_INEFFECTIVE",
      reason: "Plain MOM36 production contract requires CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT=1 (SLOW_AND_FAST)",
    };
  }
  return {
    strategyVersion,
    configuredVariant,
    effectiveVariant,
    selectionMode: mode,
    geometry: dynamic ? "BREADTH_6_TOTAL" : "3L/3S",
    sideTrendAlignment,
    state: "EFFECTIVE",
    reason: null,
  };
}

/** Scheduler interval used by app.ts. Invalid values are never silently treated as a claimed value. */
export function crossSectionalExecTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.CROSS_SECTIONAL_EXEC_TICK_MS ?? "", 10);
  return Number.isFinite(value) && value >= 1_000 && value <= 300_000 ? value : 60_000;
}

export function isCrossSectionalMakerExitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_MAKER_EXIT_ENABLED === "1";
}

export function crossSectionalMakerExitWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.CROSS_SECTIONAL_MAKER_EXIT_WAIT_MS ?? "", 10);
  return Number.isFinite(value) && value >= 1_000 && value <= 120_000 ? value : 20_000;
}

/** Explicit switch: ghost observation can continue while adaptive exits are not allowed to trade. */
export function isCrossSectionalAdaptiveExitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return crossSectionalAdaptiveExitMode(env) === "ON";
}

export function currentCrossSectionalExitPolicy(env: NodeJS.ProcessEnv = process.env): CrossSectionalExitPolicySnapshot {
  if (isDynamicMom36ShockStrategy(env)) {
    const dynamicContinuation = isDynamicMom36ContinuationStrategy(env);
    // This strategy's execution values are frozen by policy, not left as mutable legacy TP/SL or
    // leverage knobs.  Maker mechanics remain the existing execution engine's responsibility.
    return {
      // The legacy shadow lane may retain a different research horizon.  A Dynamic basket itself
      // is a 36h strategy, and its public policy/status must not advertise that unrelated horizon.
      measurementHorizonBars: 36,
      // Dynamic MOM36 means 36 fully closed one-hour candles. Do not merely echo a mutable
      // legacy env value here: the formation path separately fails closed if it drifts.
      measurementInterval: "1h",
      executionCapHours: 36,
      takeProfitEnabled: false,
      takeProfitNetReturn: null,
      stopLossEnabled: false,
      stopLossNetReturn: null,
      adaptiveExitsEnabled: false,
      adaptiveExitMode: "OFF",
      makerEntryEnabled: env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED === "1",
      makerExitEnabled: isCrossSectionalMakerExitEnabled(env),
      makerExitWaitMs: isCrossSectionalMakerExitEnabled(env) ? crossSectionalMakerExitWaitMs(env) : null,
      executorTickMs: crossSectionalExecTickMs(env),
      legNotionalUsd: 25,
      leverage: 1,
      maxOpenBaskets: 1,
      ordinaryContextInvalidationEnabled: false,
      dynamicV3Exit: dynamicContinuation
        ? {
            hardCutLossNetReturn: DYNAMIC_MOM36_HARD_CUT_LOSS,
            mfeArmNetReturn: DYNAMIC_MOM36_MFE_ARM_THRESHOLD,
            mfeGivebackFraction: DYNAMIC_MOM36_MFE_GIVEBACK_FRACTION,
            horizonHours: 36,
          }
        : null,
    };
  }
  const takeProfitEnabled = env.CROSS_SECTIONAL_EXEC_TP_DISABLED !== "1";
  const stopLossNetReturn = parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_STOP_NET_RETURN);
  return {
    measurementHorizonBars: parsePositiveNumber(env.CROSS_SECTIONAL_HORIZON_BARS),
    measurementInterval: env.CROSS_SECTIONAL_INTERVAL?.trim() || "1h",
    executionCapHours: parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS),
    takeProfitEnabled,
    takeProfitNetReturn: takeProfitEnabled ? (parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN) ?? 0.006) : null,
    stopLossEnabled: stopLossNetReturn !== null,
    stopLossNetReturn,
    adaptiveExitsEnabled: isCrossSectionalAdaptiveExitEnabled(env),
    adaptiveExitMode: crossSectionalAdaptiveExitMode(env),
    makerEntryEnabled: env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED === "1",
    makerExitEnabled: isCrossSectionalMakerExitEnabled(env),
    makerExitWaitMs: isCrossSectionalMakerExitEnabled(env) ? crossSectionalMakerExitWaitMs(env) : null,
    executorTickMs: crossSectionalExecTickMs(env),
    legNotionalUsd: parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_LEG_USD),
    leverage: parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_LEVERAGE),
    maxOpenBaskets: parsePositiveNumber(env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS),
    // Plain MOM36 is Hold-to-36h while adaptive exits are OFF.  Persist this explicitly so a
    // future lifecycle refactor cannot reinterpret a new basket as eligible for a context exit.
    ordinaryContextInvalidationEnabled: false,
  };
}

/**
 * Old rows do not have a policy snapshot.  Deployment pins these keys to the pre-deploy contract
 * so existing positions are not reinterpreted by a new TP/SL/maker policy.  Outside a deployment
 * the fallback remains the historical dynamic env behaviour for backwards-compatible tests/tools.
 */
export function legacyCrossSectionalExitPolicy(env: NodeJS.ProcessEnv = process.env): CrossSectionalExitPolicySnapshot {
  const legacyEnv: NodeJS.ProcessEnv = {
    ...env,
    CROSS_SECTIONAL_STRATEGY_VERSION: "legacy-cross-sectional",
    CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: env.CROSS_SECTIONAL_LEGACY_EXEC_MAX_HOLD_HOURS ?? env.CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS,
    CROSS_SECTIONAL_EXEC_LEG_USD: env.CROSS_SECTIONAL_LEGACY_EXEC_LEG_USD ?? env.CROSS_SECTIONAL_EXEC_LEG_USD,
    CROSS_SECTIONAL_EXEC_LEVERAGE: env.CROSS_SECTIONAL_LEGACY_EXEC_LEVERAGE ?? env.CROSS_SECTIONAL_EXEC_LEVERAGE,
    CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS: env.CROSS_SECTIONAL_LEGACY_EXEC_MAX_OPEN_BASKETS ?? env.CROSS_SECTIONAL_EXEC_MAX_OPEN_BASKETS,
    CROSS_SECTIONAL_EXEC_TP_DISABLED: env.CROSS_SECTIONAL_LEGACY_EXEC_TP_DISABLED ?? env.CROSS_SECTIONAL_EXEC_TP_DISABLED,
    CROSS_SECTIONAL_EXEC_TP_NET_RETURN: env.CROSS_SECTIONAL_LEGACY_EXEC_TP_NET_RETURN ?? env.CROSS_SECTIONAL_EXEC_TP_NET_RETURN,
    CROSS_SECTIONAL_EXEC_STOP_NET_RETURN: env.CROSS_SECTIONAL_LEGACY_EXEC_STOP_NET_RETURN ?? env.CROSS_SECTIONAL_EXEC_STOP_NET_RETURN,
    CROSS_SECTIONAL_MAKER_EXIT_ENABLED: env.CROSS_SECTIONAL_LEGACY_MAKER_EXIT_ENABLED ?? "0",
    CROSS_SECTIONAL_MAKER_EXIT_WAIT_MS: env.CROSS_SECTIONAL_LEGACY_MAKER_EXIT_WAIT_MS ?? env.CROSS_SECTIONAL_MAKER_EXIT_WAIT_MS,
    CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED: env.CROSS_SECTIONAL_LEGACY_ADAPTIVE_EXITS_ENABLED ?? env.CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED,
  };
  return currentCrossSectionalExitPolicy(legacyEnv);
}

export function buildCurrentCrossSectionalPolicyFingerprint(
  nowIso: string,
  env: NodeJS.ProcessEnv = process.env,
): CrossSectionalPolicyFingerprint {
  const selection = crossSectionalSelectionRuntime(env);
  const dynamic = selection.selectionMode === "DYNAMIC_MOM36_BREADTH";
  const strategyVersion = selection.strategyVersion;
  const dynamicContinuation = isDynamicMom36ContinuationVersion(strategyVersion);
  const dynamicSlowFast = isDynamicMom36SlowFastVersion(strategyVersion);
  const sourceSha = env.KRONOS_RELEASE_SHA?.trim() || "UNKNOWN_SOURCE_SHA";
  const body = {
    schemaVersion: CURRENT_POLICY_FINGERPRINT_SCHEMA,
    forwardCohortStartedAt: validIso(env.CROSS_SECTIONAL_CURRENT_POLICY_FORWARD_STARTED_AT),
    strategy: {
      strategyVersion,
      signal: dynamic
        ? DYNAMIC_MOM36_SHOCK_SIGNAL
        : env.CROSS_SECTIONAL_FILTERED_SIGNAL?.trim() || `MOM${env.CROSS_SECTIONAL_MOMENTUM_BARS?.trim() || "36"}_FILTERED`,
      sourceSha,
      gitHash: sourceSha,
      configHash: "PENDING_CONFIG_HASH",
      modelArtifactId: dynamicContinuation
        ? DYNAMIC_MOM36_CONTINUATION_ARTIFACT_ID
        : dynamic ? NO_FROZEN_RUNTIME_SHOCK_ARTIFACT : "NOT_APPLICABLE_LEGACY",
      continuationArtifactId: dynamicContinuation ? DYNAMIC_MOM36_CONTINUATION_ARTIFACT_ID : null,
      slowFastPolicyId: dynamicSlowFast ? DYNAMIC_MOM36_SLOW_FAST_POLICY_ID : null,
      slowFastImplementationVersion: dynamicSlowFast ? DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION : null,
      deploymentTimestamp: validIso(env.CROSS_SECTIONAL_STRATEGY_DEPLOYED_AT),
      policyVersion: env.CROSS_SECTIONAL_POLICY_VERSION?.trim() || "UNVERSIONED_POLICY",
      variant: selection.effectiveVariant,
      configuredVariant: selection.configuredVariant,
      selectionMode: selection.selectionMode,
      selectionState: selection.state,
      momentumBars: parsePositiveNumber(env.CROSS_SECTIONAL_MOMENTUM_BARS),
      legsPerSide: parsePositiveNumber(env.CROSS_SECTIONAL_K) ?? 3,
    },
    universe: {
      longPool: parseSymbols(env.CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST),
      shortPool: parseSymbols(env.CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST),
      shortBlocklist: parseSymbols(env.CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST),
    },
    formation: {
      scoreGap: parseFiniteNumber(env.CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP),
      clusterCap: parseFiniteNumber(env.CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER),
      // Dynamic allocation is raw MOM36 rank plus six equal $25 legs.  The legacy Smart Formation
      // settings remain visible in the environment for old baskets, but are not permitted to
      // silently select or reweight a new Dynamic basket.
      weighting: dynamic ? "EQUAL_NOTIONAL" : env.CROSS_SECTIONAL_FILTERED_WEIGHTING?.trim().toUpperCase() || "EQUAL_NOTIONAL",
      formationMode: dynamic ? "PLAIN_MOM36" : crossSectionalFormationMode(env),
      smartFormationRerank: dynamic ? false : isCrossSectionalSmartFormationRerankEnabled(env),
      sideTrendAlignment: dynamic ? "OFF" : crossSectionalFilteredSideTrendAlignment(env),
      admissionProbeSideTrendAlignment: dynamic ? "OFF" : crossSectionalFilteredSideTrendAlignment(env),
      entryRevalidationEnabled: dynamic ? false : isCrossSectionalSmartBasketLifecycleEnabled(env),
      entryHealthBypassed: env.CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH === "1",
    },
    reliability: symbolReliabilityPolicyFingerprint(env),
    execution: currentCrossSectionalExitPolicy(env),
  };
  const configHash = `xsec-config-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}`;
  const withConfigHash = {
    ...body,
    strategy: { ...body.strategy, configHash },
  };
  const policyId = `xsec-${createHash("sha256").update(JSON.stringify(withConfigHash)).digest("hex").slice(0, 16)}`;
  return { ...withConfigHash, policyId, capturedAt: nowIso };
}

export function effectiveCrossSectionalRuntime(
  supportsMakerExit: boolean,
  env: NodeJS.ProcessEnv = process.env,
): CrossSectionalEffectiveRuntime {
  const selection = crossSectionalSelectionRuntime(env);
  const dynamic = selection.selectionMode === "DYNAMIC_MOM36_BREADTH";
  const rawTick = env.CROSS_SECTIONAL_EXEC_TICK_MS ?? null;
  const parsedTick = rawTick === null ? null : Number.parseInt(rawTick, 10);
  const tickValid = rawTick === null || (parsedTick !== null && Number.isFinite(parsedTick) && parsedTick >= 1_000 && parsedTick <= 300_000);
  const makerConfigured = isCrossSectionalMakerExitEnabled(env);
  const makerEffective = makerConfigured && supportsMakerExit;
  const mismatches: CrossSectionalEffectiveRuntime["mismatches"] = [];
  if (!tickValid) {
    mismatches.push({
      key: "CROSS_SECTIONAL_EXEC_TICK_MS",
      configured: rawTick,
      effective: crossSectionalExecTickMs(env),
      reason: "value must be an integer in [1000, 300000] ms; runtime uses the safe 60000 ms fallback",
    });
  }
  if (makerConfigured && !supportsMakerExit) {
    mismatches.push({
      key: "CROSS_SECTIONAL_MAKER_EXIT_ENABLED",
      configured: true,
      effective: false,
      reason: "executor lacks the quote, cancel, or client-order lookup path required for a safe post-only exit",
    });
  }
  if (selection.state !== "EFFECTIVE") {
    mismatches.push({
      key: "CROSS_SECTIONAL_SELECTION_RUNTIME",
      configured: {
        strategyVersion: selection.strategyVersion,
        variant: selection.configuredVariant,
        k: env.CROSS_SECTIONAL_K ?? "3",
        regimeSkewEnabled: env.CROSS_SECTIONAL_REGIME_SKEW_ENABLED === "1",
        sideTrendAlignment: selection.sideTrendAlignment,
      },
      effective: "NO_NEW_BASKETS",
      reason: selection.reason ?? "selection contract is not effective",
    });
  }
  return {
    strategyVersion: selection.strategyVersion,
    formationMode: dynamic ? "PLAIN_MOM36" : crossSectionalFormationMode(env),
    sideTrendAlignment: dynamic ? "OFF" : selection.sideTrendAlignment,
    admissionProbeSideTrendAlignment: dynamic ? "OFF" : selection.sideTrendAlignment,
    adaptiveExitMode: dynamic ? "OFF" : crossSectionalAdaptiveExitMode(env),
    entryRevalidation: !dynamic && isCrossSectionalSmartBasketLifecycleEnabled(env),
    executorTick: {
      configured: rawTick,
      effectiveMs: crossSectionalExecTickMs(env),
      state: tickValid ? "EFFECTIVE" : "CONFIG_INEFFECTIVE",
      reason: tickValid ? null : mismatches.find((mismatch) => mismatch.key === "CROSS_SECTIONAL_EXEC_TICK_MS")?.reason ?? null,
    },
    makerExit: {
      configured: makerConfigured,
      effective: makerEffective,
      waitMs: makerEffective ? crossSectionalMakerExitWaitMs(env) : null,
      state: !makerConfigured || makerEffective ? "EFFECTIVE" : "CONFIG_INEFFECTIVE",
      reason: makerConfigured && !makerEffective ? mismatches.find((mismatch) => mismatch.key === "CROSS_SECTIONAL_MAKER_EXIT_ENABLED")?.reason ?? null : null,
    },
    adaptiveExits: {
      configured: dynamic ? false : isCrossSectionalAdaptiveExitEnabled(env),
      effective: dynamic ? false : isCrossSectionalAdaptiveExitEnabled(env),
      state: "EFFECTIVE",
    },
    selection,
    mismatches,
  };
}

export function validIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

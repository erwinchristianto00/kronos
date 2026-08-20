/**
 * One explicit, serialisable policy contract for the market-neutral cross-sectional executor.
 *
 * The executor, its status API, and /control must describe the same effective policy.  Keeping
 * this outside either UI prevents an env value from being displayed as active when no runtime path
 * consumes it.  A basket stores this object at admission; later env changes therefore cannot
 * silently change the exit contract of an already-open position.
 */
import { createHash } from "node:crypto";

export const CURRENT_POLICY_FINGERPRINT_SCHEMA = "CURRENT_POLICY_FORWARD_COHORT_V1" as const;

type RuntimeConfigState = "EFFECTIVE" | "CONFIG_INEFFECTIVE";

export type CrossSectionalExitPolicySnapshot = {
  measurementHorizonBars: number | null;
  measurementInterval: string;
  executionCapHours: number | null;
  takeProfitEnabled: boolean;
  takeProfitNetReturn: number | null;
  stopLossEnabled: boolean;
  stopLossNetReturn: number | null;
  adaptiveExitsEnabled: boolean;
  makerEntryEnabled: boolean;
  makerExitEnabled: boolean;
  makerExitWaitMs: number | null;
  executorTickMs: number;
};

export type CrossSectionalPolicyFingerprint = {
  schemaVersion: typeof CURRENT_POLICY_FINGERPRINT_SCHEMA;
  policyId: string;
  capturedAt: string;
  forwardCohortStartedAt: string | null;
  strategy: {
    signal: string;
    sourceSha: string;
    policyVersion: string;
    variant: string;
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
    smartFormationRerank: boolean;
    entryRevalidationEnabled: boolean;
    entryHealthBypassed: boolean;
  };
  execution: CrossSectionalExitPolicySnapshot;
};

export type CrossSectionalEffectiveRuntime = {
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
  // Compatibility default preserves pre-cutover behavior for a deployment that has not declared
  // the switch. The production release writes an explicit =0, which is what makes OFF auditable.
  return env.CROSS_SECTIONAL_ADAPTIVE_EXITS_ENABLED !== "0";
}

export function currentCrossSectionalExitPolicy(env: NodeJS.ProcessEnv = process.env): CrossSectionalExitPolicySnapshot {
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
    makerEntryEnabled: env.CROSS_SECTIONAL_MAKER_ENTRY_ENABLED === "1",
    makerExitEnabled: isCrossSectionalMakerExitEnabled(env),
    makerExitWaitMs: isCrossSectionalMakerExitEnabled(env) ? crossSectionalMakerExitWaitMs(env) : null,
    executorTickMs: crossSectionalExecTickMs(env),
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
    CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS: env.CROSS_SECTIONAL_LEGACY_EXEC_MAX_HOLD_HOURS ?? env.CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS,
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
  const body = {
    schemaVersion: CURRENT_POLICY_FINGERPRINT_SCHEMA,
    forwardCohortStartedAt: validIso(env.CROSS_SECTIONAL_CURRENT_POLICY_FORWARD_STARTED_AT),
    strategy: {
      signal: env.CROSS_SECTIONAL_FILTERED_SIGNAL?.trim() || `MOM${env.CROSS_SECTIONAL_MOMENTUM_BARS?.trim() || "36"}_FILTERED`,
      sourceSha: env.KRONOS_RELEASE_SHA?.trim() || "UNKNOWN_SOURCE_SHA",
      policyVersion: env.CROSS_SECTIONAL_POLICY_VERSION?.trim() || "UNVERSIONED_POLICY",
      variant: env.CROSS_SECTIONAL_EXEC_VARIANT?.trim() || "FILTERED",
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
      weighting: env.CROSS_SECTIONAL_FILTERED_WEIGHTING?.trim().toUpperCase() || "EQUAL_NOTIONAL",
      smartFormationRerank: env.CROSS_SECTIONAL_SMART_FORMATION_RERANK === "1",
      entryRevalidationEnabled: env.CROSS_SECTIONAL_SMART_BASKET_V1 === "1",
      entryHealthBypassed: env.CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH === "1",
    },
    execution: currentCrossSectionalExitPolicy(env),
  };
  const policyId = `xsec-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}`;
  return { ...body, policyId, capturedAt: nowIso };
}

export function effectiveCrossSectionalRuntime(
  supportsMakerExit: boolean,
  env: NodeJS.ProcessEnv = process.env,
): CrossSectionalEffectiveRuntime {
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
  return {
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
      configured: isCrossSectionalAdaptiveExitEnabled(env),
      effective: isCrossSectionalAdaptiveExitEnabled(env),
      state: "EFFECTIVE",
    },
    mismatches,
  };
}

export function validIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

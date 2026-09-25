/**
 * Cross-sectional entry traffic light.
 *
 * The rolling entry-health gate is deliberately strict once a lane has evidence.  A brand-new
 * testnet cohort, however, starts at 0 completed baskets and can never collect its first result
 * if that same gate is treated as a permanent red light.  This module makes that one exception
 * explicit, bounded, and impossible to use on mainnet:
 *
 *   GREEN  — measured rolling edge passes; normal sizing.
 *   YELLOW — only missing sample size, only testnet, only a fresh Smart Basket V1 signal; reduced
 *             size and a separately capped learning cohort.
 *   RED    — negative/proven-bad evidence, a bad gate, non-Smart signal, mainnet, or capacity used.
 *
 * It is intentionally pure so the executor and its tests share exactly the same decision.
 */

export type CrossSectionalEntryAdmissionTier = "GREEN" | "YELLOW" | "RED";

export interface CrossSectionalEntryHealthVerdict {
  allowed: boolean;
  reason: string | null;
}

export interface CrossSectionalEntryAdmission {
  tier: CrossSectionalEntryAdmissionTier;
  allowed: boolean;
  /** True only for the bounded testnet cold-start cohort. */
  learning: boolean;
  /** Multiplies the normal leg notional. RED is zero because it must never size an order. */
  sizeMultiplier: number;
  maxLearningOpen: number;
  reason: string | null;
  rawHealth: CrossSectionalEntryHealthVerdict;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boundedMultiplier(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value > 0 ? Math.min(1, Math.max(0.05, value)) : fallback;
}

export function isCrossSectionalEntryTrafficLightEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_ENTRY_TRAFFIC_LIGHT === "1";
}

export function isCrossSectionalTestnetLearningCohortEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_TESTNET_LEARNING_COHORT === "1";
}

export function isCrossSectionalEvidenceIncomplete(reason: string | null): boolean {
  return /^rolling evidence incomplete:\s*\d+\/\d+\s+recent closes$/i.test(reason ?? "");
}

export function crossSectionalLearningLegMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  return boundedMultiplier(env.CROSS_SECTIONAL_TESTNET_LEARNING_LEG_MULTIPLIER, 0.35);
}

export function crossSectionalLearningMaxOpen(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.CROSS_SECTIONAL_TESTNET_LEARNING_MAX_OPEN, 2);
}

export function evaluateCrossSectionalEntryAdmission(input: {
  rawHealth: CrossSectionalEntryHealthVerdict;
  /** The executor, not the signal producer, verifies this provenance immediately before ordering. */
  smartBasketV1: boolean;
  learningOpenCount: number;
  env?: NodeJS.ProcessEnv;
}): CrossSectionalEntryAdmission {
  const env = input.env ?? process.env;
  const rawHealth = {
    allowed: input.rawHealth.allowed === true,
    reason: input.rawHealth.reason ?? null,
  };
  const maxLearningOpen = crossSectionalLearningMaxOpen(env);

  if (rawHealth.allowed) {
    return {
      tier: "GREEN",
      allowed: true,
      learning: false,
      sizeMultiplier: 1,
      maxLearningOpen,
      reason: null,
      rawHealth,
    };
  }

  if (env.LIVE_BINANCE_ENV !== "testnet") {
    return {
      tier: "RED",
      allowed: false,
      learning: false,
      sizeMultiplier: 0,
      maxLearningOpen,
      reason: `entry health blocked: ${rawHealth.reason ?? "no measured approval"}`,
      rawHealth,
    };
  }
  if (!isCrossSectionalTestnetLearningCohortEnabled(env)) {
    return {
      tier: "RED",
      allowed: false,
      learning: false,
      sizeMultiplier: 0,
      maxLearningOpen,
      reason: `entry health blocked (testnet learning cohort is off): ${rawHealth.reason ?? "no measured approval"}`,
      rawHealth,
    };
  }
  if (!isCrossSectionalEvidenceIncomplete(rawHealth.reason)) {
    return {
      tier: "RED",
      allowed: false,
      learning: false,
      sizeMultiplier: 0,
      maxLearningOpen,
      reason: `entry health has adverse or invalid evidence: ${rawHealth.reason ?? "blocked"}`,
      rawHealth,
    };
  }
  if (!input.smartBasketV1) {
    return {
      tier: "RED",
      allowed: false,
      learning: false,
      sizeMultiplier: 0,
      maxLearningOpen,
      reason: "cold-start learning accepts only a newly formed Smart Basket V1 signal",
      rawHealth,
    };
  }
  if (input.learningOpenCount >= maxLearningOpen) {
    return {
      tier: "RED",
      allowed: false,
      learning: false,
      sizeMultiplier: 0,
      maxLearningOpen,
      reason: `cold-start learning capacity reached: ${input.learningOpenCount}/${maxLearningOpen} reduced-size baskets still open`,
      rawHealth,
    };
  }

  return {
    tier: "YELLOW",
    allowed: true,
    learning: true,
    sizeMultiplier: crossSectionalLearningLegMultiplier(env),
    maxLearningOpen,
    reason: `cold-start learning: ${rawHealth.reason}; Smart Basket V1 only, ${(crossSectionalLearningLegMultiplier(env) * 100).toFixed(0)}% leg size`,
    rawHealth,
  };
}

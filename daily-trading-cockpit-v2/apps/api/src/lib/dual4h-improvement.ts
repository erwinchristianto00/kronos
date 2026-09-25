import type {MomentumFeature} from './daily-momentum4h.js';

/** Prespecified forward experiment; no claim that these thresholds are optimal. */
export const DUAL4H_IMPROVEMENT = {
  id: 'dual4h-selective-confirm-forward-v2-20260921',
  scope: 'TESTNET_ONLY',
  activation: 'MANUAL_ARM_REQUIRED',
  entryFamilyPolicy: 'momentum-only-20260925',
  executableFamilies: ['MOMENTUM'],
  shadowOnlyFadeExits: ['THESIS_12H', 'TIME_6H', 'FIXED_1_5R_24H'],
  momentum: {confirmationCloses: 2, maxExtensionR: 0.5, schedule: '08:00 UTC + first hour'},
  fade: {insideCloses: 2, strongBtc24hPct: 2, strongCoin24hPct: 5, efficiencyMin: 0.6},
  liveExitArmNetPct: 2,
  shadowArmNetPct: [2, 1.25, 0.75],
  retainedPeakFraction: 0.5,
  floorStepNetPct: 0.05,
  riskUsd: 0.25,
  maxNotionalUsd: 25,
  autoPromotion: false,
} as const;

export function dualExecutionBlock(feature: MomentumFeature): string | null {
  if (!feature.dual) return 'DUAL_PROFILE_REQUIRED';
  if (feature.dual.family !== 'MOMENTUM') return 'FADE_PROFILE_SHADOW_ONLY';
  if (!('executionProbe' in feature && feature.executionProbe) && feature.dual.improvementId !== DUAL4H_IMPROVEMENT.id) return 'ENTRY_CONFIRMATION_POLICY_REQUIRED';
  return null;
}

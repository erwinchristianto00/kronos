/**
 * Testnet-only CORTEX cohort for the three lanes the operator is currently running.
 * Historical journals remain intact for audit; this gate only decides what may be read as current
 * CORTEX evidence or refit input after the rollout boundary.
 */
export const CORTEX_TESTNET_FOCUS_LANE_IDS = [
  "CROSS_SECTIONAL_MARKET_NEUTRAL",
  "CROSS_SECTIONAL_DIRECTIONAL_LONG",
  "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
  "CG_MFE_GIVEBACK_LONG",
  "CG_MFE_GIVEBACK_SHORT",
] as const;

export type CortexTestnetFocus = {
  sinceMs: number;
  sinceIso: string;
  laneIds: ReadonlySet<string>;
  label: string;
};

export function resolveCortexTestnetFocus(env: NodeJS.ProcessEnv = process.env): CortexTestnetFocus | null {
  if ((env.CORTEX_TESTNET_FOCUS ?? "").trim() !== "1") return null;
  const instanceId = (env.FOUR_BRAIN_INSTANCE_ID ?? env.PORT ?? "").trim();
  if (instanceId !== "3102") return null;
  const parsed = Date.parse(env.CORTEX_TESTNET_FOCUS_SINCE ?? "");
  if (!Number.isFinite(parsed)) return null;
  return {
    sinceMs: parsed,
    sinceIso: new Date(parsed).toISOString(),
    laneIds: new Set(CORTEX_TESTNET_FOCUS_LANE_IDS),
    label: "3 lane testnet cohort",
  };
}

export function isInCortexTestnetFocus(
  focus: CortexTestnetFocus | null,
  laneId: string | null | undefined,
  atMs: number | null | undefined,
): boolean {
  if (!focus) return true;
  return typeof laneId === "string" && focus.laneIds.has(laneId) && typeof atMs === "number" && Number.isFinite(atMs) && atMs >= focus.sinceMs;
}

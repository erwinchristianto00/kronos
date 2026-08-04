import type { CrossSectionalObservation, CrossSectionalStore } from "./cross-sectional-edge.js";
import {
  BLS_BAR_MS,
  BLS_LANE_ID,
  BLS_MAX_HOLD_BARS,
  type BtcLeadLagObservation,
} from "./btc-leadlag-snap-edge.js";
import {
  CE_MAX_HOLD_BARS,
  type CompressionExpansionObservation,
} from "./compression-expansion-edge.js";
import { CE_V2_LANE_ID } from "./compression-retest-v2.js";
import {
  FC_MAX_HOLD_HOURS,
  FC_PAPER_LANE_ID,
  type FundingCarryObservation,
} from "./funding-carry-edge.js";
import { FC_V2_LANE_ID } from "./funding-carry-crowding-v2.js";
import {
  HRS_V2_LANE_ID,
  type HedgedResidualShortObservation,
} from "./hedged-residual-short-v2.js";
import {
  LQR_LANE_ID,
  LQR_MAX_HOLD_HOURS,
  type LiqRecoilObservation,
} from "./liq-recoil-edge.js";
import { LQR_V2_LANE_ID } from "./liq-recoil-strict-reclaim-v2.js";
import {
  QITF_LANE_ID,
  QITF_RISK_RETURN,
  type QueueImbalanceToxicFlowObservation,
} from "./queue-imbalance-toxic-flow-edge.js";
import type { SingleSymbolFreshSignal } from "./single-symbol-lane-executor.js";

export const INNOVATION_POLICY_ONLY_IDS = ["EXIT_BRAIN", "META_LABEL_GATE"] as const;

export const EXECUTABLE_INNOVATION_LANE_IDS = [
  FC_PAPER_LANE_ID,
  BLS_LANE_ID,
  LQR_LANE_ID,
  HRS_V2_LANE_ID,
  FC_V2_LANE_ID,
  LQR_V2_LANE_ID,
  CE_V2_LANE_ID,
  QITF_LANE_ID,
] as const;

export type ExecutableInnovationLaneId = (typeof EXECUTABLE_INNOVATION_LANE_IDS)[number];

export function isInnovationTestnetExecutionEnabled(
  environment: "testnet" | "mainnet",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment === "testnet" && env.INNOVATION_TESTNET_EXEC_DISABLED !== "1";
}

/**
 * Research maturity/allocation never veto innovation execution; operational account safety does.
 *
 * 2026-08 canonical-market-regime addition (requirement #7 of the canonical-market-regime rollout —
 * see canonical-market-regime-execution-policy.ts): `canonicalRegimeAllowed` is a REQUIRED second
 * parameter, not defaulted — this codebase's explicit-over-implicit convention for anything
 * safety-relevant (e.g. `isInnovationTestnetExecutionEnabled`'s own required `environment`
 * parameter) — AND-ed alongside the existing armed/kill/drain check. The caller (app.ts) passes the
 * SAME shared `canonicalMarketRegimeExecutionPolicy` decision every other execution-affecting path
 * this round now consults; this function does not compute or import that decision itself, it only
 * ANDs in whatever boolean it is handed, keeping this file free of any dependency on the canonical
 * engine's own types/module.
 */
export function innovationTestnetAdmissionAllowed(
  canOpenIgnoringManualDirectional: boolean,
  canonicalRegimeAllowed: boolean,
): boolean {
  return canOpenIgnoringManualDirectional && canonicalRegimeAllowed;
}

/** Innovation collection is full test-size; allocation is informational and cannot starve it. */
export function innovationTestnetWeight(selectedWeightPct: number): number {
  void selectedWeightPct;
  return 100;
}

export function innovationTestnetLegUsd(configured: number): number {
  // Binance USD-M testnet currently rejects non-reduce-only orders below 50 USDT.
  return Number.isFinite(configured) && configured > 0 ? Math.max(55, configured) : 55;
}

export function startInnovationTestnetExecutorSchedule(
  run: () => Promise<void>,
  scheduleEvery: (handler: () => void, intervalMs: number) => ReturnType<typeof setInterval> = setInterval,
): ReturnType<typeof setInterval> {
  // Start before server.ts's 60-second paper cycle can monopolize the event loop for minutes.
  void run();
  return scheduleEvery(() => void run(), 5 * 60_000);
}

export function singleSignalsForDirection(
  observations:
    | readonly BtcLeadLagObservation[]
    | readonly LiqRecoilObservation[]
    | readonly CompressionExpansionObservation[]
    | readonly QueueImbalanceToxicFlowObservation[],
  direction: "LONG" | "SHORT",
): SingleSymbolFreshSignal[] {
  return observations
    .filter((observation) => observation.status === "OPEN" && observation.direction === direction)
    .map((observation) => {
      if ("entryMid" in observation) {
        const stopPrice =
          direction === "LONG"
            ? observation.entryMid * (1 - QITF_RISK_RETURN)
            : observation.entryMid * (1 + QITF_RISK_RETURN);
        return {
          observationId: observation.observationId,
          symbol: observation.symbol,
          entryPrice: observation.entryMid,
          stopPrice,
          targetPrice: null,
          maxHoldMs: observation.markoutHorizonMs,
          openedAtMs: observation.openedAtMs,
        };
      }
      if ("convergenceTarget" in observation) {
        return {
          observationId: observation.observationId,
          symbol: observation.symbol,
          entryPrice: observation.entryPrice,
          stopPrice: observation.initialStop,
          targetPrice: observation.convergenceTarget,
          maxHoldMs: BLS_MAX_HOLD_BARS * BLS_BAR_MS,
          openedAtMs: observation.openedAtMs,
        };
      }
      return {
        observationId: observation.observationId,
        symbol: observation.symbol,
        entryPrice: observation.entryPrice,
        stopPrice: observation.initialStop,
        targetPrice: observation.targetPrice,
        maxHoldMs:
          "cascadeDirection" in observation
            ? LQR_MAX_HOLD_HOURS * 3_600_000
            : CE_MAX_HOLD_BARS * 3_600_000,
        openedAtMs: observation.openedAtMs,
      };
    });
}

function emptyOutcome(): Pick<
  CrossSectionalObservation,
  "grossReturn" | "costReturn" | "netReturn" | "longLegReturn" | "shortLegReturn" | "resolvedAt"
> {
  return {
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: null,
  };
}

export function fundingCarryBaskets(
  observations: readonly FundingCarryObservation[],
): CrossSectionalObservation[] {
  return observations
    .filter((observation) => observation.status === "OPEN")
    .map((observation) => ({
      observationId: observation.observationId,
      openedAt: observation.openedAt,
      openedAtMs: observation.openedAtMs,
      horizonMs: FC_MAX_HOLD_HOURS * 3_600_000,
      signal: "FUNDING_CARRY_PAIR",
      variant: "FILTERED",
      strategyFamily: "MEAN_REVERSION",
      k: 1,
      longK: 1,
      shortK: 1,
      longLeg: [{ symbol: observation.longSymbol, entryPrice: observation.longEntryPrice, exitPrice: null, weight: 0.5 }],
      shortLeg: [{ symbol: observation.shortSymbol, entryPrice: observation.shortEntryPrice, exitPrice: null, weight: 0.5 }],
      status: "OPEN",
      weightingModel: "BETA_VOL_PROXY",
      takeProfitReturn: null,
      stopLossReturn: observation.divergenceStopReturn,
      riskDistanceAtOpen: observation.divergenceStopReturn,
      ...emptyOutcome(),
    }));
}

export function hedgedResidualBaskets(
  observations: readonly HedgedResidualShortObservation[],
): CrossSectionalObservation[] {
  return observations
    .filter((observation) => observation.status === "OPEN" && observation.shortLegs.length > 0)
    .map((observation) => ({
      observationId: observation.observationId,
      openedAt: observation.openedAt,
      openedAtMs: observation.openedAtMs,
      horizonMs: observation.maxHoldBars * 3_600_000,
      signal: "HEDGED_RESIDUAL_SHORT",
      variant: "FILTERED",
      strategyFamily: "MOMENTUM_DISPERSION",
      k: observation.shortLegs.length,
      longK: 1,
      shortK: observation.shortLegs.length,
      longLeg: [{
        symbol: observation.benchmarkSymbol,
        entryPrice: observation.benchmarkEntryPrice,
        exitPrice: null,
        weight: observation.hedgeBeta,
      }],
      shortLeg: observation.shortLegs.map((leg) => ({
        symbol: leg.symbol,
        entryPrice: leg.entryPrice,
        exitPrice: null,
        weight: leg.weight,
      })),
      status: "OPEN",
      weightingModel: "BETA_VOL_PROXY",
      takeProfitReturn: observation.takeProfitReturn,
      stopLossReturn: observation.stopReturn,
      riskDistanceAtOpen: observation.stopReturn,
      ...emptyOutcome(),
    }));
}

export function asCrossSectionalSignalStore(
  getObservations: () => CrossSectionalObservation[],
): Pick<CrossSectionalStore, "all"> {
  return {
    get all() {
      return getObservations();
    },
  };
}

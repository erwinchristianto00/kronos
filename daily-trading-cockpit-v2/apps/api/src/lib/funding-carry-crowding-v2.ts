/**
 * FUNDING-BASIS CARRY + CROWDING V2.
 *
 * Sibling of FUNDING_CARRY_NEUTRAL_PAIR. It reuses the parent's honest funding
 * accrual, divergence, cost, and expiry model, but admits a pair only when the
 * short leg is both absolutely expensive and cross-sectionally crowded.
 * Separate store and report; no execution wiring.
 */
import { resolve } from "node:path";

import {
  FC_UNIVERSE,
  FundingCarryStore,
  buildFundingCarryReport,
  runFundingCarryCycle,
  type FundingCarryCandidate,
  type FundingCarryPremiumFetcher,
  type FundingCarrySymbolSnapshot,
  type FCCycleResult,
} from "./funding-carry-edge.js";

function envNum(name: string, dflt: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : dflt;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const FC_V2_LANE_ID = "FUNDING_BASIS_CARRY_CROWDING_V2" as const;
export const FC_V2_PARENT_LANE_ID = "FUNDING_CARRY_NEUTRAL_PAIR" as const;
export const FC_V2_MIN_SHORT_FUNDING_BPS = envNum("FUNDING_CARRY_V2_MIN_SHORT_FUNDING_BPS", 3);
export const FC_V2_MIN_SHORT_FUNDING_PERCENTILE = envNum(
  "FUNDING_CARRY_V2_MIN_SHORT_FUNDING_PERCENTILE",
  0.8,
);

export function fundingPercentile(
  value: number,
  snapshots: ReadonlyMap<string, FundingCarrySymbolSnapshot>,
): number | null {
  const rates = [...snapshots.values()]
    .map((snapshot) => snapshot.fundingRate)
    .filter(finite)
    .sort((a, b) => a - b);
  if (rates.length < 3) return null;
  const atOrBelow = rates.filter((rate) => rate <= value).length;
  return atOrBelow / rates.length;
}

export function passesFundingCarryCrowdingV2(
  candidate: FundingCarryCandidate,
  snapshots: ReadonlyMap<string, FundingCarrySymbolSnapshot>,
): boolean {
  const percentile = fundingPercentile(candidate.shortFundingRate, snapshots);
  return (
    candidate.shortFundingRate * 10_000 >= FC_V2_MIN_SHORT_FUNDING_BPS &&
    percentile !== null &&
    percentile >= FC_V2_MIN_SHORT_FUNDING_PERCENTILE
  );
}

let singleton: FundingCarryStore | null = null;
export function getFundingCarryCrowdingV2Store(dataDir = "data"): FundingCarryStore {
  if (!singleton) {
    singleton = new FundingCarryStore(resolve(dataDir, "funding-carry-crowding-v2.json"));
  }
  return singleton;
}

export function _resetFundingCarryCrowdingV2StoreForTests(): void {
  singleton = null;
}

export async function runFundingCarryCrowdingV2Cycle(opts: {
  store: FundingCarryStore;
  now: number;
  fetchPremiumIndex: FundingCarryPremiumFetcher;
  universe?: readonly string[];
}): Promise<FCCycleResult> {
  return runFundingCarryCycle({
    ...opts,
    universe: opts.universe ?? FC_UNIVERSE,
    candidateFilter: passesFundingCarryCrowdingV2,
    observationIdPrefix: "fcv2",
  });
}

let cycleInFlight = false;
export async function runFundingCarryCrowdingV2CycleGuarded(
  opts: Parameters<typeof runFundingCarryCrowdingV2Cycle>[0],
): Promise<FCCycleResult | null> {
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runFundingCarryCrowdingV2Cycle(opts);
  } catch (error) {
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      // Shadow liveness bookkeeping must never escape into the parent scheduler.
    }
    return null;
  } finally {
    cycleInFlight = false;
  }
}

export function buildFundingCarryCrowdingV2Report(store = getFundingCarryCrowdingV2Store()) {
  const parentShape = buildFundingCarryReport(store.all, store.cycleMeta);
  const cycleMeta = parentShape.cycleMeta
    ? {
        ...parentShape.cycleMeta,
        candidatesTotal: parentShape.cycleMeta.pairsEvaluatedTotal,
        rejectedTotal:
          parentShape.cycleMeta.belowBreakevenTotal +
          parentShape.cycleMeta.skippedMissingDataTotal +
          parentShape.cycleMeta.skippedOtherClusterTotal,
      }
    : null;
  return {
    ...parentShape,
    cycleMeta,
    laneId: FC_V2_LANE_ID,
    parentLaneId: FC_V2_PARENT_LANE_ID,
    version: "V2" as const,
    thesis:
      "Capture same-cluster funding differential only when the receiving SHORT leg is cross-sectionally crowded.",
    signalSource: "premiumIndex funding+mark; same-cluster pair; absolute and percentile crowding gate",
    v2Gate: {
      minShortFundingBps: FC_V2_MIN_SHORT_FUNDING_BPS,
      minShortFundingPercentile: FC_V2_MIN_SHORT_FUNDING_PERCENTILE,
    },
  };
}

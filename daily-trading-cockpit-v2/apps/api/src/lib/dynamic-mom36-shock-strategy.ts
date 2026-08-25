/**
 * Dynamic MOM36 Shock 36h policy.
 *
 * This module deliberately owns only deterministic strategy mechanics:
 *
 * - MOM36 sign breadth chooses the base 6L0S ... 0L6S allocation;
 * - MOM36 ranking chooses the symbols;
 * - a frozen shock mapping may move at most one allocation rung or veto;
 * - when no frozen runtime mapping exists, the overlay is explicitly NO_EDGE.
 *
 * It does not fetch data, train a model, or inspect historical outcomes.  Keeping it pure is what
 * lets TESTNET and LIVE make the exact same decision from the same snapshot.
 */
import { clusterOf, isMajorCluster } from "./correlation-clusters.js";

export const DYNAMIC_MOM36_SHOCK_36H_V1 = "dynamic-mom36-shock-36h-v1" as const;
export const DYNAMIC_MOM36_SHOCK_SIGNAL = "DYNAMIC_MOM36_SHOCK_36H" as const;
export const DYNAMIC_MOM36_SHOCK_VARIANT = "DYNAMIC_MOM36_SHOCK" as const;
export const DYNAMIC_MOM36_LOOKBACK_BARS = 36 as const;
export const DYNAMIC_MOM36_HORIZON_HOURS = 36 as const;
export const DYNAMIC_MOM36_HORIZON_MS = DYNAMIC_MOM36_HORIZON_HOURS * 3_600_000;

/** There is intentionally no synthetic or trainable fallback model. */
export const NO_FROZEN_RUNTIME_SHOCK_ARTIFACT = "NO_FROZEN_RUNTIME_SHOCK_MAPPING" as const;

export type DynamicMom36ShockState =
  | "NO_EDGE"
  | "CONFIRM_LONG"
  | "CONFIRM_SHORT"
  | "CONFLICT_LONG"
  | "CONFLICT_SHORT"
  | "VETO";

export type DynamicMom36Allocation = {
  longCount: number;
  shortCount: number;
  label: "6L0S" | "5L1S" | "4L2S" | "3L3S" | "2L4S" | "1L5S" | "0L6S";
};

export type DynamicMom36RankedSymbol = {
  symbol: string;
  mom36: number;
  price: number;
  volatility: number | null;
  fastReturn: number | null;
  extensionVol: number | null;
  /** Existing production pool / long eligibility, not an alpha score. */
  longEligible: boolean;
  /** Existing execution eligibility after the short blocklist and current guards. */
  shortEligible: boolean;
  /** Kept separate so a blocked name remains visible in breadth and ranking audit. */
  shortBlocked: boolean;
};

export type FrozenShockOverlay = {
  modelArtifactId: string;
  available: boolean;
  state: DynamicMom36ShockState;
  /** Preserved verbatim as JSON-safe data for the formation snapshot. */
  rawOutput: Record<string, unknown>;
  reason: string | null;
  /** VETO is legal only when the frozen mapping explicitly marks it as such. */
  vetoAllowed: boolean;
};

const SHOCK_STATES = new Set<DynamicMom36ShockState>([
  "NO_EDGE",
  "CONFIRM_LONG",
  "CONFIRM_SHORT",
  "CONFLICT_LONG",
  "CONFLICT_SHORT",
  "VETO",
]);

function jsonSafeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && !Number.isFinite(item)) result[key] = String(item);
    else if (item && typeof item === "object" && !Array.isArray(item)) result[key] = jsonSafeRecord(item);
    else result[key] = item;
  }
  return result;
}

function noEdgeShockOverlay(reason: string, raw: unknown, modelArtifactId: string = NO_FROZEN_RUNTIME_SHOCK_ARTIFACT): FrozenShockOverlay {
  return {
    modelArtifactId,
    available: false,
    state: "NO_EDGE",
    rawOutput: jsonSafeRecord(raw),
    reason,
    vetoAllowed: false,
  };
}

/**
 * Strict adapter for a future *already frozen* runtime shock artifact.  It does not infer a state
 * or use a threshold: a malformed, stale, missing, timeout, or non-finite output simply means
 * NO_EDGE.  Keeping this boundary pure makes the optional overlay testable without creating a
 * second model or silently training/tuning one in the execution path.
 */
export function normalizeFrozenRuntimeShockOverlay(raw: unknown): FrozenShockOverlay {
  const record = jsonSafeRecord(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return noEdgeShockOverlay("frozen shock artifact unavailable", raw);
  }
  const candidate = raw as Record<string, unknown>;
  const modelArtifactId = typeof candidate.modelArtifactId === "string" && candidate.modelArtifactId.trim()
    ? candidate.modelArtifactId.trim()
    : NO_FROZEN_RUNTIME_SHOCK_ARTIFACT;
  if (candidate.available !== true || candidate.artifactPresent !== true) {
    return noEdgeShockOverlay("frozen shock artifact unavailable", raw, modelArtifactId);
  }
  if (candidate.timedOut === true || candidate.featuresAvailable === false || candidate.schemaValid === false) {
    return noEdgeShockOverlay("frozen shock inference is unavailable or incompatible", raw, modelArtifactId);
  }
  const state = candidate.state;
  if (typeof state !== "string" || !SHOCK_STATES.has(state as DynamicMom36ShockState)) {
    return noEdgeShockOverlay("frozen shock output has no valid normalized state", raw, modelArtifactId);
  }
  const probabilities = candidate.probabilities;
  if (probabilities !== undefined) {
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) ||
      Object.values(probabilities as Record<string, unknown>).some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return noEdgeShockOverlay("frozen shock output has non-finite probabilities", raw, modelArtifactId);
    }
  }
  // VETO is never inferred from a raw state name alone.  The frozen model's published mapping has
  // to state explicitly that this result is a legal veto.
  if (state === "VETO" && candidate.vetoAllowed !== true) {
    return noEdgeShockOverlay("frozen shock VETO is not explicitly authorized by its mapping", raw, modelArtifactId);
  }
  return {
    modelArtifactId,
    available: true,
    state: state as DynamicMom36ShockState,
    rawOutput: record,
    reason: typeof candidate.reason === "string" ? candidate.reason : null,
    vetoAllowed: candidate.vetoAllowed === true,
  };
}

export type DynamicMom36Selection = {
  selectedLongs: DynamicMom36RankedSymbol[];
  selectedShorts: DynamicMom36RankedSymbol[];
  blockedShortsSkipped: string[];
  insufficientReason: string | null;
};

export type DynamicMom36Formation = {
  activeUniverse: DynamicMom36RankedSymbol[];
  positiveCount: number;
  negativeCount: number;
  zeroCount: number;
  baseAllocation: DynamicMom36Allocation;
  shock: FrozenShockOverlay;
  finalAllocation: DynamicMom36Allocation;
  vetoed: boolean;
  selection: DynamicMom36Selection;
};

const allocation = (longCount: number): DynamicMom36Allocation => {
  const safeLong = Math.max(0, Math.min(6, Math.floor(longCount)));
  const labels: DynamicMom36Allocation["label"][] = ["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"];
  return { longCount: safeLong, shortCount: 6 - safeLong, label: labels[safeLong]! };
};

/**
 * Treat only machine-noise around exactly zero as zero.  This is a numerical normalisation,
 * deliberately not a tuned epsilon or an additional momentum threshold.
 */
export function dynamicMom36Sign(value: number): -1 | 0 | 1 | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) <= Number.EPSILON * 16) return 0;
  return value > 0 ? 1 : -1;
}

export function baseDynamicMom36Allocation(rows: readonly Pick<DynamicMom36RankedSymbol, "mom36">[]): {
  positiveCount: number;
  negativeCount: number;
  zeroCount: number;
  allocation: DynamicMom36Allocation;
} {
  let positiveCount = 0;
  let negativeCount = 0;
  let zeroCount = 0;
  for (const row of rows) {
    const sign = dynamicMom36Sign(row.mom36);
    if (sign === 1) positiveCount += 1;
    else if (sign === -1) negativeCount += 1;
    else if (sign === 0) zeroCount += 1;
  }

  // A zero is neither bullish nor bearish.  Any such row makes the minority-side interpretation
  // ambiguous, so stay at the deterministic neutral allocation rather than manufacture exposure.
  if (zeroCount > 0) return { positiveCount, negativeCount, zeroCount, allocation: allocation(3) };
  if (negativeCount === 0) return { positiveCount, negativeCount, zeroCount, allocation: allocation(6) };
  if (negativeCount === 1) return { positiveCount, negativeCount, zeroCount, allocation: allocation(5) };
  if (negativeCount === 2) return { positiveCount, negativeCount, zeroCount, allocation: allocation(4) };
  if (positiveCount === 0) return { positiveCount, negativeCount, zeroCount, allocation: allocation(0) };
  if (positiveCount === 1) return { positiveCount, negativeCount, zeroCount, allocation: allocation(1) };
  if (positiveCount === 2) return { positiveCount, negativeCount, zeroCount, allocation: allocation(2) };
  return { positiveCount, negativeCount, zeroCount, allocation: allocation(3) };
}

/**
 * The bounded overlay is intentionally a one-rung operation.  CONFIRM_* names the frozen model's
 * directional evidence.  CONFLICT_LONG means evidence against a net-long base; CONFLICT_SHORT is
 * the mirror.  Neither path can cross neutral in a single decision.
 */
export function applyBoundedShockOverlay(
  base: DynamicMom36Allocation,
  shock: Pick<FrozenShockOverlay, "state" | "vetoAllowed">,
): { allocation: DynamicMom36Allocation; vetoed: boolean } {
  if (shock.state === "VETO") {
    return { allocation: base, vetoed: shock.vetoAllowed };
  }
  let longCount = base.longCount;
  if (shock.state === "CONFIRM_LONG") longCount = Math.min(6, longCount + 1);
  else if (shock.state === "CONFIRM_SHORT") longCount = Math.max(0, longCount - 1);
  else if (shock.state === "CONFLICT_LONG" && longCount > 3) longCount -= 1;
  else if (shock.state === "CONFLICT_SHORT" && longCount < 3) longCount += 1;
  return { allocation: allocation(longCount), vetoed: false };
}

/**
 * Current runtime inspection found no frozen model artifact plus deterministic shock/trajectory
 * mapping wired into the production execution path.  Per policy, absence degrades to base MOM36;
 * it must never block entry, guess a probability, or become an unreviewed new alpha layer.
 */
export function resolveFrozenRuntimeShockOverlay(): FrozenShockOverlay {
  return noEdgeShockOverlay(
    "no frozen runtime shock/trajectory mapping is registered for execution",
    { artifactPresent: false, mappingPresent: false, fallback: "NO_EDGE" },
  );
}

function clusterAllowed(symbol: string, selected: readonly DynamicMom36RankedSymbol[], maxPerCluster: number): boolean {
  if (!(maxPerCluster > 0)) return true;
  const cluster = clusterOf(symbol);
  if (isMajorCluster(cluster)) return true;
  return selected.filter((row) => clusterOf(row.symbol) === cluster).length < maxPerCluster;
}

function rank(rows: readonly DynamicMom36RankedSymbol[], side: "LONG" | "SHORT"): DynamicMom36RankedSymbol[] {
  return [...rows].sort((a, b) => {
    const scoreDelta = side === "LONG" ? b.mom36 - a.mom36 : a.mom36 - b.mom36;
    return scoreDelta || a.symbol.localeCompare(b.symbol);
  });
}

function selectSide(
  rows: readonly DynamicMom36RankedSymbol[],
  side: "LONG" | "SHORT",
  count: number,
  excluded: ReadonlySet<string>,
  maxPerCluster: number,
): { selected: DynamicMom36RankedSymbol[]; blockedSkipped: string[] } {
  const selected: DynamicMom36RankedSymbol[] = [];
  const blockedSkipped: string[] = [];
  for (const row of rank(rows, side)) {
    if (selected.length >= count) break;
    if (excluded.has(row.symbol)) continue;
    if (side === "LONG" ? !row.longEligible : !row.shortEligible) {
      if (side === "SHORT" && row.shortBlocked) blockedSkipped.push(row.symbol);
      continue;
    }
    if (!clusterAllowed(row.symbol, selected, maxPerCluster)) continue;
    selected.push(row);
  }
  return { selected, blockedSkipped };
}

/**
 * Selects final legs only after breadth and the bounded overlay are frozen.  The larger side is
 * chosen first solely to prevent a shared candidate from starving the required side; each side
 * remains a strict MOM36 rank walk and no symbol is reranked by the shock layer.
 */
export function selectDynamicMom36Legs(
  rows: readonly DynamicMom36RankedSymbol[],
  finalAllocation: DynamicMom36Allocation,
  maxPerCluster: number,
): DynamicMom36Selection {
  if (rows.length < 6) {
    return { selectedLongs: [], selectedShorts: [], blockedShortsSkipped: [], insufficientReason: "active inference universe has fewer than six symbols" };
  }
  const longFirst = finalAllocation.longCount >= finalAllocation.shortCount;
  const firstSide: "LONG" | "SHORT" = longFirst ? "LONG" : "SHORT";
  const secondSide: "LONG" | "SHORT" = longFirst ? "SHORT" : "LONG";
  const countFor = (side: "LONG" | "SHORT") => side === "LONG" ? finalAllocation.longCount : finalAllocation.shortCount;
  const first = selectSide(rows, firstSide, countFor(firstSide), new Set(), maxPerCluster);
  const second = selectSide(rows, secondSide, countFor(secondSide), new Set(first.selected.map((row) => row.symbol)), maxPerCluster);
  const selectedLongs = firstSide === "LONG" ? first.selected : second.selected;
  const selectedShorts = firstSide === "SHORT" ? first.selected : second.selected;
  const blockedShortsSkipped = [...new Set([...first.blockedSkipped, ...second.blockedSkipped])];
  const enough = selectedLongs.length === finalAllocation.longCount && selectedShorts.length === finalAllocation.shortCount;
  return {
    selectedLongs,
    selectedShorts,
    blockedShortsSkipped,
    insufficientReason: enough ? null : "insufficient ranked execution-eligible symbols after current pool, blocklist, and cluster guards",
  };
}

export function buildDynamicMom36Formation(input: {
  activeUniverse: readonly DynamicMom36RankedSymbol[];
  maxPerCluster: number;
  shock?: FrozenShockOverlay;
}): DynamicMom36Formation {
  const activeUniverse = [...input.activeUniverse]
    .filter((row) => Number.isFinite(row.mom36) && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => b.mom36 - a.mom36 || a.symbol.localeCompare(b.symbol));
  const breadth = baseDynamicMom36Allocation(activeUniverse);
  const shock = input.shock ?? resolveFrozenRuntimeShockOverlay();
  const overlay = applyBoundedShockOverlay(breadth.allocation, shock);
  const selection = overlay.vetoed
    ? { selectedLongs: [], selectedShorts: [], blockedShortsSkipped: [], insufficientReason: "frozen shock mapping vetoed this candidate" }
    : selectDynamicMom36Legs(activeUniverse, overlay.allocation, input.maxPerCluster);
  return {
    activeUniverse,
    positiveCount: breadth.positiveCount,
    negativeCount: breadth.negativeCount,
    zeroCount: breadth.zeroCount,
    baseAllocation: breadth.allocation,
    shock,
    finalAllocation: overlay.allocation,
    vetoed: overlay.vetoed,
    selection,
  };
}

export function crossSectionalStrategyVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.CROSS_SECTIONAL_STRATEGY_VERSION?.trim() || "legacy-cross-sectional";
}

export function isDynamicMom36ShockStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return crossSectionalStrategyVersion(env) === DYNAMIC_MOM36_SHOCK_36H_V1;
}

export function isDynamicMom36ShockVersion(strategyVersion: string | null | undefined): boolean {
  return strategyVersion === DYNAMIC_MOM36_SHOCK_36H_V1;
}

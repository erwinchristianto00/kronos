/**
 * CORTEX #218 — outcome-source normalizers (PURE). Turns each lane's OWN resolved paper record into a
 * CortexLaneOutcome (netR in R), under the operator's contract:
 *   • directional lanes (RC/RCS/CE/SF/IM/PWR/CG) store netR NATIVELY in R (net of cost) — pass through.
 *   • XSEC baskets store netReturn as a FRACTION → netR = netReturn / riskDistanceAtOpen, where
 *     riskDistanceAtOpen is FROZEN on the record at open (never the live stop config at resolve). A basket
 *     with no frozen risk-at-open is SKIPPED with reason NO_RISK_AT_OPEN — surfaced, never a raw-fraction
 *     fallback and never a silent drop.
 * The IMPURE readers that pull raw records out of the six edge stores + the CG variant matrix live in the
 * refit-runner bindings; this module is structurally-typed + unit-tested so the mapping is provable.
 */
import { cortexArchetypeForLane, type CortexArchetype } from "./cortex-brain.js";
import { CORTEX_LANE_ROSTER, type CortexLaneDirection } from "./cortex-live-gather.js";
import type { CortexAttrRosterEntry, CortexLaneDir, CortexLaneOutcome } from "./cortex-attribution.js";

/** Directional exec signal age — the bounded window to find a trade's owning brain decision. */
export const CORTEX_ATTR_TTL_DIRECTIONAL_MS = 50 * 60_000;
/** Baskets open less often; give the window a little more slack, still bounded (NOT "hours prior"). */
export const CORTEX_ATTR_TTL_XSEC_MS = 90 * 60_000;

export interface CortexOutcomeLaneMeta {
  laneId: string;
  archetype: CortexArchetype;
  direction: CortexLaneDir;
  isXsec: boolean;
  ttlMs: number;
}

const META_BY_LANE: Map<string, CortexOutcomeLaneMeta> = new Map(
  CORTEX_LANE_ROSTER.map((e) => [
    e.laneId,
    {
      laneId: e.laneId,
      archetype: cortexArchetypeForLane(e.laneId),
      direction: e.direction as CortexLaneDir,
      isXsec: e.isXsec,
      ttlMs: e.isXsec ? CORTEX_ATTR_TTL_XSEC_MS : CORTEX_ATTR_TTL_DIRECTIONAL_MS,
    },
  ]),
);

export function cortexOutcomeLaneMeta(laneId: string): CortexOutcomeLaneMeta | null {
  return META_BY_LANE.get(laneId) ?? null;
}

/** The per-lane bounded validity window (ms) for attribution's ttlMsForLane. */
export function cortexLaneTtlMs(laneId: string): number {
  return META_BY_LANE.get(laneId)?.ttlMs ?? CORTEX_ATTR_TTL_DIRECTIONAL_MS;
}

export type CortexOutcomeSkipReason =
  | "NOT_RESOLVED" // still OPEN
  | "NO_OUTCOME_VALUE" // resolved but netR / netReturn is null / non-finite (e.g. EXPIRED w/o fwd candles)
  | "NO_RISK_AT_OPEN" // XSEC basket with no frozen riskDistanceAtOpen — cannot form a valid R
  | "BAD_TIMESTAMP" // openedAtMs / resolvedAt unusable
  | "UNKNOWN_LANE"; // laneId not in the roster

export type CortexOutcomeNormalizeResult =
  | { ok: true; outcome: CortexLaneOutcome }
  | { ok: false; skip: CortexOutcomeSkipReason };

/** A resolved directional paper record (RC/RCS/CE/SF/IM/PWR/CG) — netR already in R. */
export interface RawDirectionalObs {
  observationId: string;
  openedAtMs: number;
  resolvedAt: string | null;
  status: string; // OPEN / CLOSED_WIN / CLOSED_LOSS / EXPIRED
  netR: number | null;
}

/** A resolved cross-sectional basket record — netReturn is a FRACTION; riskDistanceAtOpen is frozen. */
export interface RawXsecObs {
  observationId: string;
  openedAtMs: number;
  resolvedAt: string | null;
  status: string;
  netReturn: number | null;
  /** Frozen-at-open R denominator (new field). stopLossReturn is the legacy fallback for TREND/MIXED. */
  riskDistanceAtOpen?: number | null;
  stopLossReturn?: number | null;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** ISO string → epoch ms, or null. Never throws. */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Normalize a directional resolved record. netR passes through (already in R). */
export function directionalObsToOutcome(laneId: string, obs: RawDirectionalObs): CortexOutcomeNormalizeResult {
  const meta = META_BY_LANE.get(laneId);
  if (!meta || meta.isXsec) return { ok: false, skip: "UNKNOWN_LANE" };
  if (obs.status === "OPEN") return { ok: false, skip: "NOT_RESOLVED" };
  if (!finite(obs.netR)) return { ok: false, skip: "NO_OUTCOME_VALUE" };
  const resolvedAtMs = parseIsoMs(obs.resolvedAt);
  if (!finite(obs.openedAtMs) || resolvedAtMs === null) return { ok: false, skip: "BAD_TIMESTAMP" };
  return {
    ok: true,
    outcome: {
      laneId,
      archetype: meta.archetype,
      direction: meta.direction,
      observationId: obs.observationId,
      openedAtMs: obs.openedAtMs,
      resolvedAtMs,
      netR: obs.netR,
    },
  };
}

/** Normalize a cross-sectional basket record. netR = netReturn / riskDistanceAtOpen (frozen at open). */
export function xsecObsToOutcome(laneId: string, obs: RawXsecObs): CortexOutcomeNormalizeResult {
  const meta = META_BY_LANE.get(laneId);
  if (!meta || !meta.isXsec) return { ok: false, skip: "UNKNOWN_LANE" };
  if (obs.status === "OPEN") return { ok: false, skip: "NOT_RESOLVED" };
  if (!finite(obs.netReturn)) return { ok: false, skip: "NO_OUTCOME_VALUE" };
  const risk = finite(obs.riskDistanceAtOpen) ? obs.riskDistanceAtOpen : finite(obs.stopLossReturn) ? obs.stopLossReturn : null;
  if (!finite(risk) || risk <= 0) return { ok: false, skip: "NO_RISK_AT_OPEN" };
  const resolvedAtMs = parseIsoMs(obs.resolvedAt);
  if (!finite(obs.openedAtMs) || resolvedAtMs === null) return { ok: false, skip: "BAD_TIMESTAMP" };
  return {
    ok: true,
    outcome: {
      laneId,
      archetype: meta.archetype,
      direction: "NEUTRAL",
      observationId: obs.observationId,
      openedAtMs: obs.openedAtMs,
      resolvedAtMs,
      netR: obs.netReturn / risk,
      riskDistanceAtOpen: risk,
    },
  };
}

/**
 * Build the attribution roster (archetype + static weight + whether an outcome source is wired) for every
 * CORTEX roster lane. hasOutcomeSource is a RUNTIME fact (is the lane's store actually being read this run?)
 * — passed in, so a lane whose reader isn't wired is reported NO_OUTCOME_SOURCE, never silently learned.
 */
export function buildCortexAttrRoster(
  staticWeightPctForLane: (laneId: string) => number,
  hasOutcomeSourceForLane: (laneId: string) => boolean,
): CortexAttrRosterEntry[] {
  return CORTEX_LANE_ROSTER.map((e) => ({
    laneId: e.laneId,
    archetype: cortexArchetypeForLane(e.laneId),
    staticWeightPct: Math.max(0, finite(staticWeightPctForLane(e.laneId)) ? staticWeightPctForLane(e.laneId) : 0),
    hasOutcomeSource: hasOutcomeSourceForLane(e.laneId),
  }));
}

export { type CortexLaneDirection };

/**
 * Lane-context snapshot SOURCE assembler (Track 1, Stage-2 snapshot call-site). PURE + dependency-injected: it maps
 * the runtime Direction-Brain context that is live at the four-brain decision tick — regime, per-lane edge-memory,
 * controller conviction/mode, axis, incumbent eligibility, static + cortex weights, per-(regime×direction×lane)
 * veto — into the `LaneContextSnapshotInput[]` the journal records, ONE entry per active incumbent lane.
 *
 * GRANULARITY (documented, honest): the four-brain decision tick does NOT bind a specific traded symbol — the
 * Direction-Brain inputs (edge-memory keyed regime×direction×lane, controller conviction, veto) are lane-level, not
 * per-symbol. So each snapshot's `symbolOrBasketId` is the LANE identity (a lane-wide marker). The live resolution
 * tap (strict lane∧symbol∧direction matcher) therefore ATTRIBUTES lane-level / basket outcomes and the aligned
 * full-chain fixture; per-symbol attribution for multi-symbol lanes is a lane×direction join done OFFLINE. Nothing
 * here is silently dropped: every active incumbent lane (SUPPORTED or UNSUPPORTED_WITH_REASON) yields exactly one
 * snapshot, with the reason surfaced in `vetoReason` / `sourceStatuses`.
 *
 * PURE: no store reads, no I/O, no mutation. All context arrives via injected accessors so every property is
 * testable with plain fakes.
 */
import type { LaneContextSnapshotInput } from "./lane-context-journal-binding.js";

export type SnapshotEdgeDirection = "LONG" | "SHORT";

/** One active incumbent lane, as classified by `classifyIncumbentLanes` (deduped, direction + weight + reason). */
export interface IncumbentLaneForSnapshot {
  laneId: string;
  weightPct: number;
  status: "SUPPORTED" | "UNSUPPORTED_WITH_REASON";
  direction: "LONG" | "SHORT" | "NEUTRAL" | null;
  reason: string | null;
}

export interface LaneContextSourceDeps {
  regimeRaw: string | null;
  axisScore: number | null;
  controllerMode: string | null;
  conviction: number | null;
  /** The active incumbent lanes (classifyIncumbentLanes(...).lanes) — already deduped, exactly once each. */
  lanes: IncumbentLaneForSnapshot[];
  /** Per (direction × lane) edge-memory stat, or null when unavailable ⇒ recorded MISSING (never fabricated). */
  laneEdgeStat: (direction: SnapshotEdgeDirection, lane: string) => { n: number; avgNetR: number } | null;
  /** Per (direction × lane) edge veto verdict, or null ⇒ recorded MISSING. */
  laneVeto: (direction: SnapshotEdgeDirection, lane: string) => { vetoed: boolean; reason: string } | null;
  /** CORTEX final allocation % for the lane (report-only linkage), or null. */
  cortexFinalPctForLane: (lane: string) => number | null;
  /** Whether the lane is an eligible incumbent (weight > 0). */
  laneEligibleIncumbent: (lane: string) => boolean;
}

const edgeDirOf = (d: IncumbentLaneForSnapshot["direction"]): SnapshotEdgeDirection | null =>
  d === "LONG" || d === "SHORT" ? d : null;

/**
 * Assemble one `LaneContextSnapshotInput` per active incumbent lane. Deterministic, order-preserving, 1:1 with
 * `deps.lanes` — no lane added or dropped. `symbolOrBasketId` is the lane identity (see the granularity note above).
 * A NEUTRAL/unknown-direction lane is captured with direction "NEUTRAL" and no edge/veto lookup (they are keyed by
 * LONG/SHORT only) — surfaced as MISSING, not fabricated.
 */
export function buildLaneContextSnapshotInputs(deps: LaneContextSourceDeps): LaneContextSnapshotInput[] {
  return deps.lanes.map((l) => {
    const dir = edgeDirOf(l.direction);
    const stat = dir ? deps.laneEdgeStat(dir, l.laneId) : null;
    const veto = dir ? deps.laneVeto(dir, l.laneId) : null;
    const sourceStatuses: Record<string, "FRESH" | "STALE" | "MISSING" | "ERROR"> = {
      regime: deps.regimeRaw ? "FRESH" : "MISSING",
      edgeMemory: stat ? "FRESH" : "MISSING",
      conviction: deps.conviction != null && Number.isFinite(deps.conviction) ? "FRESH" : "MISSING",
      axis: deps.axisScore != null && Number.isFinite(deps.axisScore) ? "FRESH" : "MISSING",
      veto: veto ? "FRESH" : "MISSING",
      support: l.status === "SUPPORTED" ? "FRESH" : "MISSING",
    };
    return {
      laneId: l.laneId,
      symbolOrBasketId: l.laneId, // LANE-level identity (four-brain tick binds no symbol) — see module header
      direction: l.direction ?? "NEUTRAL",
      regimeFamily: deps.regimeRaw,
      axisScore: deps.axisScore,
      transitionRisk: null, // no sync transition-risk producer at this tick ⇒ MISSING
      longEdge: null,
      shortEdge: null,
      edgeMemory: stat ? stat.avgNetR : null,
      edgeMemoryN: stat ? stat.n : null,
      conviction: deps.conviction,
      controllerMode: deps.controllerMode,
      incumbentEligible: deps.laneEligibleIncumbent(l.laneId),
      vetoed: veto ? veto.vetoed : false,
      // Prefer the edge veto reason; else surface the UNSUPPORTED classification reason so it is never lost.
      vetoReason: veto ? veto.reason : l.status === "UNSUPPORTED_WITH_REASON" ? l.reason : null,
      staticWeightPct: Number.isFinite(l.weightPct) ? l.weightPct : 0,
      cortexFinalPct: deps.cortexFinalPctForLane(l.laneId),
      sourceStatuses,
    };
  });
}

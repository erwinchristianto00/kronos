/**
 * Executive Decision layer (Phase 1, PURE + REPORT-ONLY). Combines Market State + Direction + Entry +
 * CORTEX allocation + the incumbent safety rails + Exit into ONE auditable executive record. It NEVER
 * executes — even when every condition passes. It fails OPEN to incumbent behavior: a missing brain, a
 * missing input, or an exception upstream leaves the incumbent system entirely in charge.
 *
 * A candidate trade is conceptually VALID only when ALL hold (and even then: no execution):
 *   • Direction passes its hurdle (a directional action + cleared hurdle).
 *   • The lane is eligible under the INCUMBENT system (staticWeightPct>0 / FORCE_ELIGIBLE).
 *   • Entry is valid (ENTER_NOW).
 *   • The existing risk rails allow the opportunity (kill switch not latched, no rail block).
 *
 * Disagreements between the brains + incumbent are always journaled (never hidden) — they are the whole
 * point of a separated, auditable architecture.
 */
import {
  EXECUTIVE_SCHEMA_VERSION,
  fourBrainDecisionId,
  type DirectionDecision,
  type EntryDecision,
  type FourBrainExecutionReinforcement,
  type ExecutiveCandidateStatus,
  type ExecutiveDecision,
  type ExitDecision,
  type MarketStateDecision,
} from "./four-brain-types.js";
import { staticAllocationContext, unavailableMarketContext, type AllocationContext, type MarketContextLineage } from "./authority-contract.js";

/**
 * Run a brain decision, failing OPEN on ANY exception (returns `fallback`, default null). The future
 * shadow tick wraps every brain call in this so a bug in one brain can NEVER break the trading cycle it
 * observes — the incumbent system stays entirely in charge. Pure + side-effect-free.
 */
export function runBrainSafely<T>(fn: () => T, fallback: T | null = null): T | null {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface ExecutiveInput {
  nowMs: number;
  marketState: MarketStateDecision;
  direction: DirectionDecision | null;
  entry: EntryDecision | null;
  exit: ExitDecision | null;

  laneId?: string | null;
  symbolOrBasketId?: string | null;

  /** Incumbent lane eligibility (staticWeightPct>0 / FORCE_ELIGIBLE). */
  laneEligibleIncumbent?: boolean;
  /** Read-only operational telemetry. It cannot become a Direction/Entry score or execution gate. */
  allocationContext?: AllocationContext;
  /** Exact market snapshot lineage, or explicit unavailable. */
  marketContext?: MarketContextLineage;
  /** Did direction clear its hurdle (a real directional preference)? Defaults to (action is directional). */
  directionHurdlePassed?: boolean;
  /** Exact, closed Tier-1 testnet-fill evidence. Advisory recommendation only; never execution authority. */
  executionReinforcement?: FourBrainExecutionReinforcement | null;

  /** Risk rails. killLatched OR any riskBlockedReason ⇒ BLOCKED_BY_RISK (overrides all brain approvals). */
  killLatched?: boolean;
  riskBlockedReason?: string | null;
  /** The incumbent hard stop / kill already fired (for exit disagreements). */
  hardExitTriggered?: boolean;
  /** A STABLE discriminator (side + signalId/positionId + entry/exit kind) folded into the decisionId so two
   *  distinct candidates on the SAME lane+symbol+status (e.g. an entry signal AND an exit position, both
   *  BLOCKED_BY_RISK under a latched kill) get DISTINCT ids — otherwise the tick's dedup silently drops one
   *  record from the audit trail exactly when it matters most (found by the Phase-2 review). */
  identityDiscriminator?: string;
}

function detectDisagreements(input: ExecutiveInput): string[] {
  const d: string[] = [];
  const ms = input.marketState;
  const dir = input.direction;
  const entry = input.entry;
  const exit = input.exit;
  const alloc = input.allocationContext;

  if (dir) {
    if (ms.bias === "BULLISH" && dir.action === "SHORT") d.push("Market State BULLISH, Direction SHORT");
    if (ms.bias === "BEARISH" && dir.action === "LONG") d.push("Market State BEARISH, Direction LONG");
    if ((dir.action === "LONG" || dir.action === "SHORT" || dir.action === "BOTH") && entry?.action === "SKIP") {
      d.push(`Direction ${dir.action}, Entry SKIP`);
    }
    // Strong direction resting on stale liquidity data.
    if (dir.confidence >= 0.6 && ms.sourceStatuses.liquidity === "STALE") d.push("Strong direction but STALE liquidity data");
  }
  if (alloc?.source === "UNAVAILABLE") d.push("allocation context unavailable (telemetry only)");
  if (exit?.action === "HOLD" && input.hardExitTriggered === true) d.push("Exit HOLD, hard stop already triggered");
  return d;
}

export function buildExecutiveDecision(input: ExecutiveInput): ExecutiveDecision {
  const ms = input.marketState;
  const dir = input.direction;
  const entry = input.entry;
  const allocationContext = input.allocationContext ?? staticAllocationContext(null);
  const marketContext = input.marketContext ?? unavailableMarketContext(input.nowMs);
  const executionReinforcement = input.executionReinforcement ?? null;
  const baseExpectedNetR = entry && Number.isFinite(entry.expectedNetR) ? entry.expectedNetR : null;
  const reinforcementAdjustment =
    executionReinforcement?.scope === "EXACT_LANE_REGIME_SYMBOL" && Number.isFinite(executionReinforcement.adjustment)
      ? executionReinforcement.adjustment
      : 0;
  const adjustedExpectedNetR = baseExpectedNetR === null ? null : baseExpectedNetR + reinforcementAdjustment;
  const reasons: string[] = [];
  const disagreements = detectDisagreements(input);

  const directionIsDirectional = dir != null && (dir.action === "LONG" || dir.action === "SHORT" || dir.action === "BOTH");
  const hurdlePassed = input.directionHurdlePassed ?? directionIsDirectional;

  let candidateStatus: ExecutiveCandidateStatus;
  if (input.killLatched === true || (input.riskBlockedReason != null && input.riskBlockedReason !== "")) {
    // Risk rail overrides ALL brain approvals.
    candidateStatus = "BLOCKED_BY_RISK";
    reasons.push(`risk rail blocks: ${input.killLatched ? "kill switch latched" : input.riskBlockedReason}`);
  } else if (dir == null) {
    // No direction brain output — nothing new actionable; defer to incumbent.
    candidateStatus = "INCUMBENT_ONLY";
    reasons.push("no Direction Brain output — deferring to incumbent");
  } else if (dir.action === "FLAT") {
    candidateStatus = "FLAT";
    reasons.push("Direction Brain prefers FLAT");
  } else if (entry == null) {
    // Directional preference but no entry-timing evaluation ⇒ cannot validate the entry.
    candidateStatus = "MISSING_DATA";
    reasons.push("directional preference without an Entry Brain evaluation");
  } else if (entry.action === "SKIP") {
    candidateStatus = "SKIP";
    reasons.push("Entry Brain SKIP (timing/geometry/slippage)");
  } else if (entry.action.startsWith("WAIT")) {
    candidateStatus = "WAIT";
    reasons.push(`Entry Brain ${entry.action}`);
  } else if (executionReinforcement?.verdict === "NEGATIVE") {
    // A sufficiently sampled, exact real-fill cohort says this same lane/regime/symbol/side loses.
    // This changes only the Four-Brain SHADOW recommendation, never incumbent routing or an order.
    candidateStatus = "SKIP";
    reasons.push(
      `exact Tier-1 testnet reinforcement NEGATIVE (${executionReinforcement.effectiveN} independent blocks, ` +
        `${executionReinforcement.avgNetR?.toFixed(3) ?? "n/a"}R) — advisory skip`,
    );
  } else {
    // Entry approval is an advisory quality verdict. Allocation is recorded for audit only;
    // incumbent routing and risk rails remain the sole execution authorities.
    const eligible = input.laneEligibleIncumbent === true;
    if (hurdlePassed && eligible) {
      candidateStatus = "VALID";
      reasons.push("direction + incumbent eligibility + entry pass — ADVISORY ONLY; incumbent and rails retain authority");
      if (executionReinforcement?.verdict === "POSITIVE") {
        reasons.push(
          `exact Tier-1 testnet reinforcement POSITIVE (${executionReinforcement.effectiveN} independent blocks, ` +
            `${executionReinforcement.avgNetR?.toFixed(3) ?? "n/a"}R, adjustment ${executionReinforcement.adjustment.toFixed(3)})`,
        );
      }
    } else {
      candidateStatus = "INCUMBENT_ONLY";
      const missing: string[] = [];
      if (!hurdlePassed) missing.push("direction hurdle");
      if (!eligible) missing.push("incumbent lane eligibility");
      reasons.push(`Entry approved but incumbent conditions unavailable (${missing.join(", ")}) — deferring to incumbent`);
    }
  }

  // Market-state UNKNOWN never hard-blocks (invariant) — it is only surfaced as reduced confidence context.
  if (ms.family === "UNKNOWN") reasons.push("market state UNKNOWN (does not hard-block; lowers confidence)");

  return {
    schemaVersion: EXECUTIVE_SCHEMA_VERSION,
    // Key includes side + the entry/exit + signalId/positionId discriminator so two distinct candidates on
    // the SAME lane+symbol+status don't collide into one journal record (Phase-2 review fix).
    decisionId: fourBrainDecisionId(
      "exec",
      input.nowMs,
      `${input.laneId ?? "-"}:${input.symbolOrBasketId ?? "-"}:${input.entry?.side ?? "-"}:${input.identityDiscriminator ?? (input.exit ? "exit" : input.entry ? "entry" : "-")}:${candidateStatus}`,
    ),
    asOfMs: input.nowMs,
    marketState: ms,
    direction: dir,
    entry,
    exit: input.exit,
    allocationContext,
    marketContext,
    laneId: input.laneId ?? null,
    symbolOrBasketId: input.symbolOrBasketId ?? null,
    executionReinforcement,
    shadowRanking: entry
      ? {
          baseExpectedNetR,
          reinforcementAdjustment,
          adjustedExpectedNetR,
          rank: null,
          rankEligible: false,
        }
      : null,
    candidateStatus,
    disagreements,
    reasons,
    reportOnly: true,
    advisoryOnly: true,
  };
}

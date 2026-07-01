import type { RiskConfig, StrategyLane, StrategyMode, TradingDecision } from "./types.js";
import { FORBIDDEN_LANES } from "./constants.js";
import { STRATEGY_MODES } from "./config/strategyModes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Runtime enforcement.
//
// The TypeScript types DO NOT prevent a hand-built `{ ...allowMartingale: true }`
// object literal from satisfying `RiskConfig`, nor a bad `StrategyLane`/`StrategyMode`
// from being constructed — `makeRiskConfig` is convention, not a guarantee. These
// runtime checks close that gap: they are the last line that makes martingale /
// averaging-down / forbidden lanes structurally impossible to trade, even if the
// config or a lane's own logic is wrong.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_LANES);

export function isForbiddenLaneId(id: string): boolean {
  return FORBIDDEN_SET.has(id);
}

/** Returns a violation code if the risk config is unsafe, else null. */
export function riskConfigViolation(risk: RiskConfig): string | null {
  if (risk.allowMartingale === true) return "MARTINGALE_ENABLED";
  if (risk.allowAveragingDown === true) return "AVERAGING_DOWN_ENABLED";
  if (!Number.isFinite(risk.riskPerTradePct) || risk.riskPerTradePct < 0) return "INVALID_RISK_PER_TRADE";
  if (!Number.isFinite(risk.maxOpenPositions) || risk.maxOpenPositions < 0) return "INVALID_MAX_OPEN_POSITIONS";
  return null;
}

// ── throwing assertions (use at construction / validation time) ──────────────

export function assertNoForbiddenRisk(risk: RiskConfig, context = ""): void {
  const v = riskConfigViolation(risk);
  if (v) throw new Error(`assertNoForbiddenRisk: ${v}${context ? ` (${context})` : ""}`);
}

export function assertNoForbiddenLane(laneId: string, context = ""): void {
  if (isForbiddenLaneId(laneId)) {
    throw new Error(`assertNoForbiddenLane: forbidden lane ${laneId}${context ? ` (${context})` : ""}`);
  }
}

/**
 * A StrategyMode is safe iff: it bans every globally-forbidden lane, never gives a
 * forbidden lane positive allocation weight, and carries a sane risk block.
 */
export function assertStrategyModeSafe(mode: StrategyMode): void {
  for (const forbidden of FORBIDDEN_LANES) {
    if (!mode.disabledLanes.includes(forbidden)) {
      throw new Error(`assertStrategyModeSafe[${mode.regime}]: forbidden lane not disabled: ${forbidden}`);
    }
  }
  for (const [lane, weight] of Object.entries(mode.laneWeight)) {
    if (FORBIDDEN_SET.has(lane) && (weight ?? 0) > 0) {
      throw new Error(`assertStrategyModeSafe[${mode.regime}]: forbidden lane weighted: ${lane}=${weight}`);
    }
  }
  const r = mode.risk;
  if (!(r.maxDailyLossPct > 0)) {
    throw new Error(`assertStrategyModeSafe[${mode.regime}]: non-positive maxDailyLossPct`);
  }
  if (r.riskPerTradePct < 0 || r.maxOpenPositions < 0 || r.maxTradesPerDay < 0) {
    throw new Error(`assertStrategyModeSafe[${mode.regime}]: negative risk cap`);
  }
}

export function assertLaneSafe(lane: StrategyLane): void {
  assertNoForbiddenLane(lane.id, `lane ${lane.id}`);
  assertNoForbiddenRisk(lane.risk, `lane ${lane.id}`);
}

// ── the final, non-throwing hard gate for buildTradingDecision ───────────────

export interface SafetyRejection {
  code: string;
  detail: string;
}

/**
 * Given a would-be decision, return a rejection if it is an ENTER that must NOT
 * be allowed (forbidden lane id, or a risk config that enables martingale /
 * averaging-down / is otherwise invalid). NO_TRADE decisions always pass. This is
 * a pure predicate — the caller decides how to degrade (buildTradingDecision
 * converts a rejection into a NO_TRADE, so a config/logic bug fails SAFE rather
 * than crashing a caller).
 */
export function decisionSafetyRejection(decision: TradingDecision): SafetyRejection | null {
  if (decision.action === "NO_TRADE") return null;
  if (isForbiddenLaneId(decision.lane)) {
    return { code: "FORBIDDEN_LANE", detail: `lane ${decision.lane} is globally forbidden` };
  }
  const v = riskConfigViolation(decision.risk);
  if (v) return { code: "FORBIDDEN_RISK", detail: v };
  return null;
}

/**
 * Fail-fast validation of the WHOLE framework's static config: every mode is
 * safe, and none of the shipped lanes carry a forbidden id or unsafe risk.
 * Called by tests; can also be run at boot if the framework is ever wired in.
 */
export function validateFrameworkInvariants(lanes: StrategyLane[]): void {
  for (const mode of Object.values(STRATEGY_MODES)) assertStrategyModeSafe(mode);
  for (const lane of lanes) assertLaneSafe(lane);
}

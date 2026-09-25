/**
 * The first, deliberately narrow Four-Brain -> testnet execution bridge.
 *
 * This is a negative-evidence pilot only.  It cannot create an order, increase a size, relax an
 * incumbent gate, alter a stop/TP, or close an open position.  It may only veto a NEW entry when
 * the exact lane x canonical-regime x symbol x side has already earned a sufficiently sampled
 * NEGATIVE actual-fill verdict.  Positive evidence is intentionally limited to shadow ranking in
 * this rollout; it does not become trade authority.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getFourBrainExecutionReinforcement, type FourBrainExecutionReinforcementStore } from "./four-brain-execution-reinforcement.js";
import { fourBrainInstanceAllowed, fourBrainShadowActive, resolveFourBrainInstanceId, FOUR_BRAIN_LIVE_INSTANCE_PORT } from "./four-brain-live-gather-bindings.js";

export interface FourBrainBridgeCandidate {
  laneId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  signalId: string;
  nowMs: number;
  /**
   * Exact executor geometry, when the caller has it before submitting the order.
   *
   * The negative-veto bridge deliberately ignores these fields. They are carried only for the
   * shadow pre-entry observer, which must evaluate the same causal signal that the executor is
   * about to submit rather than rediscovering a similarly named record later from a measurement
   * store.
   */
  entryPrice?: number | null;
  stopPrice?: number | null;
  openedAtMs?: number | null;
}

export interface FourBrainBridgeDecision {
  allowed: boolean;
  mode: "OFF" | "PILOT_NEGATIVE_VETO";
  action: "NO_OP" | "BLOCK_NEGATIVE";
  reason: string | null;
  evidence: { n: number; effectiveN: number; avgNetR: number | null; verdict: string | null } | null;
}

interface BridgeAudit {
  atMs: number;
  laneId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  action: "NO_OP" | "BLOCK_NEGATIVE";
  reason: string | null;
  effectiveN: number | null;
  avgNetR: number | null;
}

interface BridgeState {
  version: 1;
  evaluations: number;
  blocked: number;
  lastAudit: BridgeAudit | null;
  recent: BridgeAudit[];
}

const FOCUS_LANES = new Set([
  "CROSS_SECTIONAL_MARKET_NEUTRAL",
  "CROSS_SECTIONAL_DIRECTIONAL_LONG",
  "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
  "CG_MFE_GIVEBACK_LONG",
  "CG_MFE_GIVEBACK_SHORT",
]);
const MAX_AUDIT = 100;

/**
 * The live mirror persists CG under a variant-matrix lane id, while Four-Brain keeps separate
 * long/short books. Normalize only that known rollout identity; all other executor lane ids pass
 * through unchanged.
 */
export function normalizeFourBrainTestnetLane(laneId: string, side: "LONG" | "SHORT"): string {
  const normalized = laneId.trim();
  return normalized.toUpperCase().includes("CG_MFE_GIVEBACK")
    ? side === "LONG" ? "CG_MFE_GIVEBACK_LONG" : "CG_MFE_GIVEBACK_SHORT"
    : normalized;
}

function stateFile(dataDir: string): string {
  return resolve(dataDir, "four-brain-testnet-bridge.json");
}

function load(dataDir: string): BridgeState {
  const file = stateFile(dataDir);
  if (!existsSync(file)) return { version: 1, evaluations: 0, blocked: 0, lastAudit: null, recent: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeState>;
    return {
      version: 1,
      evaluations: typeof parsed.evaluations === "number" && Number.isFinite(parsed.evaluations) ? parsed.evaluations : 0,
      blocked: typeof parsed.blocked === "number" && Number.isFinite(parsed.blocked) ? parsed.blocked : 0,
      lastAudit: parsed.lastAudit ?? null,
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-MAX_AUDIT) : [],
    };
  } catch {
    return { version: 1, evaluations: 0, blocked: 0, lastAudit: null, recent: [] };
  }
}

function canonical(value: unknown): "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN" | null {
  return value === "BULLISH" || value === "BEARISH" || value === "MIXED" || value === "UNKNOWN" ? value : null;
}

/**
 * Testnet-only bridge.  `enabled` is intentionally stricter than the shadow collector itself:
 * it demands an explicit pilot mode plus a physical non-live testnet instance.
 */
export class FourBrainTestnetBridge {
  private state: BridgeState;

  constructor(
    private readonly opts: {
      dataDir: string;
      getCanonicalRegimeFamily: () => string | null | undefined;
      reinforcement?: FourBrainExecutionReinforcementStore;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    this.state = load(opts.dataDir);
  }

  private enabled(): boolean {
    const env = this.opts.env ?? process.env;
    if ((env.FOUR_BRAIN_TESTNET_BRIDGE_MODE ?? "").trim().toLowerCase() !== "pilot") return false;
    if ((env.FOUR_BRAIN_TESTNET_FOCUS ?? "") !== "1") return false;
    if ((env.LIVE_BINANCE_ENV ?? "").trim().toLowerCase() !== "testnet") return false;
    if (!fourBrainShadowActive(env) || !fourBrainInstanceAllowed(env)) return false;
    const physical = (env.PORT ?? resolveFourBrainInstanceId(env)).toString();
    return physical !== FOUR_BRAIN_LIVE_INSTANCE_PORT && resolveFourBrainInstanceId(env) !== FOUR_BRAIN_LIVE_INSTANCE_PORT;
  }

  private save(): void {
    try {
      const file = stateFile(this.opts.dataDir);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      renameSync(tmp, file);
    } catch {
      // A lost audit trail must fail open; a write may never suppress an incumbent entry.
    }
  }

  private record(candidate: FourBrainBridgeCandidate, decision: FourBrainBridgeDecision): void {
    const audit: BridgeAudit = {
      atMs: candidate.nowMs,
      laneId: candidate.laneId,
      symbol: candidate.symbol,
      side: candidate.side,
      action: decision.action,
      reason: decision.reason,
      effectiveN: decision.evidence?.effectiveN ?? null,
      avgNetR: decision.evidence?.avgNetR ?? null,
    };
    this.state.evaluations += 1;
    if (decision.action === "BLOCK_NEGATIVE") this.state.blocked += 1;
    this.state.lastAudit = audit;
    this.state.recent = [...this.state.recent, audit].slice(-MAX_AUDIT);
    this.save();
  }

  evaluate(candidate: FourBrainBridgeCandidate): FourBrainBridgeDecision {
    const off: FourBrainBridgeDecision = { allowed: true, mode: "OFF", action: "NO_OP", reason: null, evidence: null };
    try {
      const laneId = normalizeFourBrainTestnetLane(candidate.laneId, candidate.side);
      if (!this.enabled() || !FOCUS_LANES.has(laneId)) return off;
      const normalizedCandidate = laneId === candidate.laneId ? candidate : { ...candidate, laneId };
      const regime = canonical(this.opts.getCanonicalRegimeFamily());
      if (!regime) {
        const result: FourBrainBridgeDecision = {
          allowed: true,
          mode: "PILOT_NEGATIVE_VETO",
          action: "NO_OP",
          reason: "canonical regime unavailable; bridge fails open to incumbent",
          evidence: null,
        };
        this.record(normalizedCandidate, result);
        return result;
      }
      const reinforcement = (this.opts.reinforcement ?? getFourBrainExecutionReinforcement(this.opts.dataDir)).lookup({
        canonicalRegimeFamily: regime,
        laneId,
        symbolOrBasketId: candidate.symbol,
        side: candidate.side,
      });
      const evidence = {
        n: reinforcement.n,
        effectiveN: reinforcement.effectiveN,
        avgNetR: reinforcement.avgNetR,
        verdict: reinforcement.verdict,
      };
      const result: FourBrainBridgeDecision = reinforcement.verdict === "NEGATIVE" && reinforcement.scope === "EXACT_LANE_REGIME_SYMBOL"
        ? {
            allowed: false,
            mode: "PILOT_NEGATIVE_VETO",
            action: "BLOCK_NEGATIVE",
            reason: `Four-Brain pilot veto: exact actual-fill cohort ${laneId}/${regime}/${candidate.symbol}/${candidate.side} is NEGATIVE (${reinforcement.effectiveN} independent blocks, ${reinforcement.avgNetR?.toFixed(3) ?? "n/a"}R)`,
            evidence,
          }
        : { allowed: true, mode: "PILOT_NEGATIVE_VETO", action: "NO_OP", reason: null, evidence };
      this.record(normalizedCandidate, result);
      return result;
    } catch {
      return off; // any bridge defect fails open to the incumbent executor
    }
  }

  getStatus(): BridgeState & { mode: "OFF" | "PILOT_NEGATIVE_VETO"; active: boolean } {
    return {
      ...this.state,
      recent: this.state.recent.slice(),
      mode: this.enabled() ? "PILOT_NEGATIVE_VETO" : "OFF",
      active: this.enabled(),
    };
  }
}

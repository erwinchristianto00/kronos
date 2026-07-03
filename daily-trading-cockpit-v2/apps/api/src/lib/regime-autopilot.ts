/**
 * Regime auto-pilot (Tier 1) — synchronizes regime detection → lane allocation AUTOMATICALLY, so
 * the bot adapts to regime shifts 24/7 without a manual preset-apply. This is the "cuan while you
 * sleep" orchestrator.
 *
 * SAFE BY DESIGN:
 *  - Reads the REPORT-ONLY regime engine's latest detected regime (it does not re-derive anything).
 *  - Maps it to the SAME presets the dashboard shows — with the cross-sectional market-neutral basket
 *    as the backbone (the one proven all-weather edge), directional lanes weighted by regime.
 *  - Applies the allocation to the live engine ONLY after the regime has been STABLE for several
 *    cycles AND a minimum hold has elapsed since the last switch (anti-whipsaw — regime whipsaw must
 *    not thrash the allocation and churn fees).
 *  - Env-gated (REGIME_AUTOPILOT_ENABLED), TESTNET-FIRST. When enabled it OWNS the allocation (a
 *    manual preset is overridden on the next stable cycle); disable it to return to manual control.
 *  - Never arms anything. It only shapes the allocation; the operator still arms (mainnet stays a
 *    manual arm). All existing safety rails (kill-switch, caps, loss hard-cut, profit-bank) still apply.
 */

export interface LaneAllocationEntry {
  laneId: string;
  weightPct: number;
}

/** Per-regime target allocation. Mirrors the dashboard regime-tree presets. */
export const REGIME_AUTOPILOT_PRESETS: Record<string, LaneAllocationEntry[]> = {
  // Bear trend: shorts favored, market-neutral ballast (FAST_SHORT is only marginal, don't go 100%).
  BEAR_TREND: [
    { laneId: "CG_WIDE_FAST_SHORT", weightPct: 60 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 40 },
  ],
  BEARISH_CHOPPY_DEFENSIVE: [
    { laneId: "CG_WIDE_FAST_SHORT", weightPct: 60 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 40 },
  ],
  // No directional conviction → pure market-neutral (the proven all-weather edge).
  NO_TRADE: [{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }],
  // Early recovery: proven long favored + market-neutral ballast.
  NEUTRAL_RECOVERY: [
    { laneId: "CG_WIDE_FAST_LONG", weightPct: 60 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 40 },
  ],
  // Confirmed trend: proven long + the runner (which only earns its place in a real trend).
  TREND_RECOVERY: [
    { laneId: "CG_WIDE_FAST_LONG", weightPct: 70 },
    { laneId: "CG_WIDE_LONG_RUNNER", weightPct: 30 },
  ],
};

export function isRegimeAutopilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGIME_AUTOPILOT_ENABLED === "1";
}

export interface RegimeAutopilotOptions {
  /** Apply an allocation to the live engine (engine.setLaneAllocations). */
  setAllocations: (allocations: LaneAllocationEntry[]) => void;
  /** Latest detected regime string from the report-only regime engine (null when none). */
  getLatestRegime: () => string | null;
  /** Epoch ms clock. */
  nowMs: () => number;
  /** Consecutive same-regime observations required before switching (anti-whipsaw). Default 3. */
  stableCycles?: number;
  /** Minimum ms between allocation switches (anti-whipsaw). Default 30 min. */
  minHoldMs?: number;
}

export interface RegimeAutopilotStatus {
  enabled: boolean;
  observedRegime: string | null;
  stableCount: number;
  appliedRegime: string | null;
  appliedPreset: LaneAllocationEntry[] | null;
  lastSwitchAt: string | null;
  lastSkipReason: string | null;
  stableCycles: number;
  minHoldMs: number;
}

export class RegimeAutopilot {
  private observedRegime: string | null = null;
  private sameCount = 0;
  private appliedRegime: string | null = null;
  private lastSwitchMs = 0;
  private lastSkipReason: string | null = null;
  private readonly stableCycles: number;
  private readonly minHoldMs: number;

  constructor(private readonly opts: RegimeAutopilotOptions) {
    this.stableCycles = opts.stableCycles ?? 3;
    this.minHoldMs = opts.minHoldMs ?? 30 * 60_000;
  }

  /** One decision cycle. Idempotent + guarded — safe to call frequently. */
  tick(): void {
    const regime = this.opts.getLatestRegime();
    if (!regime || !REGIME_AUTOPILOT_PRESETS[regime]) {
      this.lastSkipReason = `no-preset-for:${regime ?? "null"}`;
      return;
    }

    // Track consecutive same-regime observations (anti-whipsaw).
    if (regime === this.observedRegime) {
      this.sameCount += 1;
    } else {
      this.observedRegime = regime;
      this.sameCount = 1;
    }

    if (this.sameCount < this.stableCycles) {
      this.lastSkipReason = `regime-not-stable:${this.sameCount}/${this.stableCycles}`;
      return;
    }
    if (regime === this.appliedRegime) {
      this.lastSkipReason = "already-applied";
      return;
    }
    const now = this.opts.nowMs();
    if (this.appliedRegime !== null && now - this.lastSwitchMs < this.minHoldMs) {
      this.lastSkipReason = `min-hold:${Math.ceil((this.minHoldMs - (now - this.lastSwitchMs)) / 60_000)}min-left`;
      return;
    }

    // Stable + past min-hold + a genuine change → apply.
    this.opts.setAllocations(REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => ({ ...e })));
    this.appliedRegime = regime;
    this.lastSwitchMs = now;
    this.lastSkipReason = null;
  }

  getStatus(): RegimeAutopilotStatus {
    return {
      enabled: isRegimeAutopilotEnabled(),
      observedRegime: this.observedRegime,
      stableCount: this.sameCount,
      appliedRegime: this.appliedRegime,
      appliedPreset: this.appliedRegime ? REGIME_AUTOPILOT_PRESETS[this.appliedRegime]! : null,
      lastSwitchAt: this.lastSwitchMs ? new Date(this.lastSwitchMs).toISOString() : null,
      lastSkipReason: this.lastSkipReason,
      stableCycles: this.stableCycles,
      minHoldMs: this.minHoldMs,
    };
  }
}

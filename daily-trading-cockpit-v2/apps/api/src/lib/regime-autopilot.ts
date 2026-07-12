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

/**
 * Per-regime target allocation. Mirrors the dashboard regime-tree presets.
 *
 * 2026-07-08 redesign (operator: "atur ulang preset untuk regime smart auto trading, jangan sampe
 * ada blocker"): CG_WIDE_LONG_RUNNER and CG_MFE_GIVEBACK are now genuinely selectable here — an
 * explicit allocation entry force-lifts the lane to STABLE_CANDIDATE AND wins its selection slot
 * (see lane-selector-v2.ts's manualEnabledVariantIds bypass + realtime-short-mirror.ts's matching
 * force-lift) — simply adding the lane ID here is now sufficient, no separate code flag needed.
 *
 * Placement follows the theoretical lane review done the same day: CG_MFE_GIVEBACK (3R target,
 * banks a faded winner once past 0.75R) and CG_WIDE_LONG_RUNNER (3R/6-day let-it-run) only earn
 * their keep in a CONFIRMED, genuinely-trending regime — trying to let a winner run 3R in a choppy
 * market rarely gets there at all. So they're added to BEAR_TREND/TREND_RECOVERY (the two
 * "confirmed strong trend" regimes) but deliberately NOT to BEARISH_CHOPPY_DEFENSIVE or
 * NEUTRAL_RECOVERY (still tactical/unconfirmed — fast 0.5R banking fits those better).
 *
 * Same batch also adds CROSS_SECTIONAL_TREND (mirrors the TREND_BETA_VOL measured variant) and
 * CROSS_SECTIONAL_MIXED (mirrors MIXED_MEAN_REVERSION) — see cross-sectional-executor.ts's
 * targetVariant/laneId. These two are a SECOND, independent regime read on top of this one: each
 * variant's own signal production already self-gates on the cross-sectional module's internal
 * breadth classification (TREND_LONG/TREND_SHORT for TREND, MIXED_CHOP for MIXED — see
 * cross-sectional-edge.ts's runCrossSectionalCycle), so giving them weight here only decides
 * whether the executor is ALLOWED to act on that signal when both regime reads agree, not a
 * duplicate of that gate. Placed the same way as the directional runner lanes: CROSS_SECTIONAL_TREND
 * in the two confirmed-trend presets (systematic trend-following fits a confirmed trend), and
 * CROSS_SECTIONAL_MIXED in the two tactical/choppy presets (mean-reversion fits chop, not a trend).
 *
 * Also adds SHORT_FADE_EXHAUSTION_CROWDED and INTRADAY_MOMENTUM_BREAKOUT_LONG (SingleSymbolLaneExecutor
 * instances, see single-symbol-lane-executor.ts) — UNLIKE every lane above, these have never executed
 * a real order anywhere before this date. BEAR_TREND and TREND_RECOVERY are already at the 4-lane cap
 * (setLaneAllocations rejects >4), so rather than displacing an already-proven lane's weight in the
 * "concentrate on the confirmed trend" presets, each new lane gets a modest 15% slot ONLY in the
 * regime that already has room and already dilutes with market-neutral ballast (BEARISH_CHOPPY_DEFENSIVE
 * for the SHORT lane, NEUTRAL_RECOVERY for the LONG lane) — a more conservative regime to prove out a
 * brand-new execution pathway than the fully-concentrated confirmed-trend presets.
 */
export const REGIME_AUTOPILOT_PRESETS: Record<string, LaneAllocationEntry[]> = {
  // Confirmed bear trend: protected runner + systematic cross-sectional trend-following +
  // market-neutral ballast.
  // 2026-07-09 (operator: "masih rugi" — real-data review): CG_WIDE_FAST_SHORT REMOVED. 135 closed
  // live trades, 30% win rate, -$7.93 net — the single biggest realized-loss lane on the account,
  // despite being the lane earlier assumed "proven" (see the 2026-07-08 comment this replaces, and
  // task history: it had already displaced CG_WIDE_STOP_TP_WIDE as "the" short lane once). The data
  // now says neither short lane earns its keep; freed weight goes to market-neutral (the one lane
  // that's actually been net positive at 75-80%+ win rates). See regime-autopilot.test.ts and
  // realtime-short-mirror.ts's REALTIME_SHORT_FORCE_FAST_SHORT env flag (disabled the same day) for
  // the other half of this cut — this preset change alone doesn't stop it; that flag does.
  BEAR_TREND: [
    { laneId: "CG_MFE_GIVEBACK", weightPct: 15 },
    { laneId: "CROSS_SECTIONAL_TREND", weightPct: 25 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 60 },
  ],
  // Choppy/defensive bear — NOT a confirmed trend: fast-bank short + the RSI-exhaustion fade (new,
  // unproven — modest slot) + cross-sectional mean-reversion (fits chop) + market-neutral ballast.
  // No let-it-run lanes (they rarely reach their far target in chop; see the 2026-07-08 review).
  // 2026-07-09: PANIC_WASHOUT_RECLAIM_LONG added (10% slot) — a capitulation dip-buy bounce is a
  // natural countertrend play in a choppy/defensive bear regime specifically (not a confirmed
  // trend), same "modest slot, never-before-executed lane" placement convention as
  // SHORT_FADE_EXHAUSTION_CROWDED above.
  // Same-day: CG_WIDE_FAST_SHORT REMOVED (see BEAR_TREND's comment above for the real-data reason —
  // 135 trades, 30% WR, -$7.93 net) — freed weight goes to market-neutral ballast.
  BEARISH_CHOPPY_DEFENSIVE: [
    { laneId: "SHORT_FADE_EXHAUSTION_CROWDED", weightPct: 15 },
    { laneId: "PANIC_WASHOUT_RECLAIM_LONG", weightPct: 10 },
    { laneId: "CROSS_SECTIONAL_MIXED", weightPct: 20 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 55 },
  ],
  // No directional conviction → pure market-neutral (the proven all-weather edge).
  NO_TRADE: [{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }],
  // Early recovery, not yet trend-confirmed: fast-bank long + the breakout-momentum hunter (new,
  // unproven — modest slot) + cross-sectional mean-reversion (still tactical/choppy) + market-neutral
  // ballast.
  // 2026-07-09: PANIC_WASHOUT_RECLAIM_LONG added here too (same 10%-from-ballast trim) — an early
  // recovery is exactly where a capitulation-then-reclaim bounce is most plausible.
  // 2026-07-11 (audit finding — REGIME_AUTOPILOT_PRESETS never mentioned the 2026-07-10 "formalize
  // RC/CE" lanes; safe today only because laneAllocationOperatorLock is held, but a real landmine
  // the moment that lock is lifted): REGIME_COMPOSITE_CONFIRMATION_LONG and
  // COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG added at the same modest 5%-from-ballast slot convention as
  // every other newly-proven single-symbol lane above — both are LONG-only and internally self-gate
  // on the breadth axis score (>=0.35), the same "early bullish confirmation" fit as
  // INTRADAY_MOMENTUM_BREAKOUT_LONG. Funded by trimming CROSS_SECTIONAL_MARKET_NEUTRAL's ballast
  // (20->10), not by displacing any already-larger directional slot.
  NEUTRAL_RECOVERY: [
    { laneId: "CG_WIDE_FAST_LONG", weightPct: 35 },
    { laneId: "INTRADAY_MOMENTUM_BREAKOUT_LONG", weightPct: 15 },
    { laneId: "PANIC_WASHOUT_RECLAIM_LONG", weightPct: 10 },
    { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 5 },
    { laneId: "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG", weightPct: 5 },
    { laneId: "CROSS_SECTIONAL_MIXED", weightPct: 20 },
    { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 10 },
  ],
  // Confirmed strong trend: fast-bank + full-commit runner (no protection until the 3R target/stop)
  // + protected runner (same 3R target, banks a faded winner past 0.75R) + systematic cross-sectional
  // trend-following. No market-neutral dilution here — this regime is specifically where
  // concentrating on the confirmed direction earns its keep.
  // 2026-07-11 (same audit finding as NEUTRAL_RECOVERY above): REGIME_COMPOSITE_CONFIRMATION_LONG and
  // COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG added here too — a confirmed strong uptrend is exactly where
  // their internal bullish-axis-score self-gate is most likely to be satisfied. No ballast lane exists
  // here to trim, so funded by a modest 5-point trim each off the two largest existing slots
  // (CG_WIDE_FAST_LONG 30->25, CG_WIDE_LONG_RUNNER 25->20) rather than the smaller CG_MFE_GIVEBACK/
  // CROSS_SECTIONAL_TREND slots.
  TREND_RECOVERY: [
    { laneId: "CG_WIDE_FAST_LONG", weightPct: 25 },
    { laneId: "CG_WIDE_LONG_RUNNER", weightPct: 20 },
    { laneId: "CG_MFE_GIVEBACK", weightPct: 20 },
    { laneId: "CROSS_SECTIONAL_TREND", weightPct: 25 },
    { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", weightPct: 5 },
    { laneId: "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG", weightPct: 5 },
  ],
};

export function isRegimeAutopilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGIME_AUTOPILOT_ENABLED === "1";
}

export interface RegimeAutopilotOptions {
  /** Apply an allocation to the live engine (engine.applyRegimeAutopilotAllocation). Returns
   *  {ok:false} on rejection (e.g. a future preset edit violating setLaneAllocations' own
   *  constraints — >4 lanes, duplicate laneId, weightPct outside (0,100]) — tick() must NOT mark
   *  the switch as applied when this happens, or the live engine silently keeps running the OLD
   *  allocation while RegimeAutopilot's own state believes the new one succeeded. */
  setAllocations: (allocations: LaneAllocationEntry[]) => { ok: boolean; reason?: string | null };
  /** Latest detected regime string from the report-only regime engine (null when none). */
  getLatestRegime: () => string | null;
  /** Operator override (2026-07-08): while the execution mode is MANUAL the operator owns the
   *  lane allocation — the autopilot keeps observing but NEVER applies. Absent ⇒ always auto. */
  isManualMode?: () => boolean;
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

    // Operator override (2026-07-08: "autopilot tetep memerintah, tapi kalau execution mode nya
    // manual, gw ambil alih lane allocation"): while manual mode is ON the autopilot only
    // OBSERVES. appliedRegime is reset so the moment the operator flips back to auto, the next
    // stable tick re-applies the preset immediately (no stale "already-applied" short-circuit
    // leaving the operator's manual allocation running in auto mode).
    if (this.opts.isManualMode?.() === true) {
      this.appliedRegime = null;
      this.lastSkipReason = "manual-selector-mode:operator-owns-allocation";
      return;
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

    // Stable + past min-hold + a genuine change → apply. Only mark it applied if the engine
    // actually accepted it — a rejected allocation must not be silently believed to have switched.
    const result = this.opts.setAllocations(REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => ({ ...e })));
    if (!result.ok) {
      this.lastSkipReason = `apply-rejected:${result.reason ?? "unknown"}`;
      return;
    }
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

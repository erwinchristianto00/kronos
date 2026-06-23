/**
 * AE. MICRO-PILOT KILL SWITCH READINESS — REPORT-ONLY SPEC
 *
 * Describes the FUTURE kill-switch controls that would have to exist BEFORE any
 * micro-pilot could be discussed. Nothing here is implemented — it is a
 * readiness/spec report. Every control reports implemented=false, and the
 * module reports ready=false until ALL controls are implemented (which they
 * are not). Pure module: zero I/O, no side effects, never throws.
 */

export const KILL_SWITCH_READINESS_MODULE =
  "MICRO_PILOT_KILL_SWITCH_READINESS" as const;

export interface KillSwitchControl {
  name: string;
  description: string;
  implemented: boolean; // all false for now
  recommendedThreshold: string; // suggested value for future micro-pilot
  riskIfMissing: string;
}

/** v1 live inputs from the live-execution engine config/state (READ-ONLY — reading these does NOT
 *  arm, activate, or flatten anything). The engine already ENFORCES these controls (kill() flattens
 *  reduce-only + disarms; reconcile-mismatch + error-streak auto-disarm); this gate only reports
 *  whether they are wired AND configured to REAL thresholds (the VPS sets limits to 999999 = off). */
export interface KillSwitchLiveInputs {
  engineEnabled: boolean;
  dailyMaxLossUsd: number | null;
  maxDrawdownUsd: number | null;
  maxConsecutiveLosses: number | null;
}
/** A configured limit ≥ this is treated as OFF (the operator parks limits at 999999 = "biarin dulu"). */
export const KILL_SWITCH_OFF_SENTINEL = Number(process.env.KILL_SWITCH_OFF_SENTINEL) || 999999;

export interface KillSwitchReadinessReport {
  reportOnly: true;
  module: typeof KILL_SWITCH_READINESS_MODULE;
  computedAt: string;
  implemented: boolean;
  /** v1 gate: true only when the engine is enabled AND the CRITICAL capital-protection limits
   *  (daily loss, drawdown, consecutive losses) are set to REAL active values + the safety machinery
   *  (manual kill, error-streak + reconcile-mismatch auto-disarm) is wired. The execution-quality
   *  stops (spread/slippage/volatility/stale-data spikes) are advisory and do NOT block v1 ready.
   *  ANDed with exchangeHealth + orderReconciliation in infraReady, and infraReady is itself ANDed
   *  with !liveBlocked — so this can NEVER enable live trading on its own. false without live inputs. */
  ready: boolean;
  readyReasons: string[];
  controls: KillSwitchControl[];
  missingControls: string[]; // names of unimplemented controls
  summary: string;
}

const CONTROLS: ReadonlyArray<Omit<KillSwitchControl, "implemented">> = [
  {
    name: "daily_max_loss_limit",
    description: "Halt all entries once cumulative daily loss breaches a hard limit.",
    recommendedThreshold: "−2R per day or −X% equity",
    riskIfMissing: "Unbounded single-day loss; one bad regime day can wipe the pilot bankroll.",
  },
  {
    name: "max_consecutive_losses",
    description: "Halt after a streak of consecutive losing trades.",
    recommendedThreshold: "5 consecutive losses → halt",
    riskIfMissing: "Edge decay / regime shift goes undetected; losses compound during a losing run.",
  },
  {
    name: "max_drawdown_stop",
    description: "Halt when rolling drawdown breaches a hard floor.",
    recommendedThreshold: "−8R rolling drawdown → halt",
    riskIfMissing: "Drawdown spirals past survivable limits before manual intervention.",
  },
  {
    name: "spread_spike_stop",
    description: "Skip or halt entries when the live spread spikes far beyond historical p99.",
    recommendedThreshold: "spread > p99 × 2 → skip/halt entries",
    riskIfMissing: "Entries fill into illiquid books; realized cost dominates expectancy.",
  },
  {
    name: "slippage_spike_stop",
    description: "Halt when realized slippage exceeds an acceptable bound.",
    recommendedThreshold: "realized slippage > 15bps → halt",
    riskIfMissing: "Execution cost silently erodes net edge; net expectancy turns negative undetected.",
  },
  {
    name: "exchange_error_stop",
    description: "Halt when the exchange returns repeated errors.",
    recommendedThreshold: "≥3 consecutive exchange errors → halt",
    riskIfMissing: "Orders submitted blind during exchange instability; state diverges.",
  },
  {
    name: "stale_data_stop",
    description: "Halt when market/account data age exceeds a freshness bound.",
    recommendedThreshold: "data age > 30s → halt",
    riskIfMissing: "Decisions made on stale prices; fills at unexpected levels.",
  },
  {
    name: "abnormal_volatility_stop",
    description: "Reduce size or halt when volatility spikes far above its median.",
    recommendedThreshold: "ATR% > 3× median → reduce/halt",
    riskIfMissing: "Stops blown through in fast markets; position risk far exceeds intended R.",
  },
  {
    name: "manual_emergency_stop",
    description: "Operator one-click kill that immediately halts all trading.",
    recommendedThreshold: "operator one-click kill",
    riskIfMissing: "No human override; cannot stop a misbehaving system in real time.",
  },
  {
    name: "auto_disable_on_reconciliation_mismatch",
    description: "Auto-disable trading on any local-vs-exchange ledger mismatch.",
    recommendedThreshold: "any ledger mismatch → auto-disable",
    riskIfMissing: "Orphaned/duplicated positions accumulate while the system keeps trading.",
  },
];

export function buildKillSwitchReadinessReport(
  capturedAt?: string,
  live?: KillSwitchLiveInputs,
): KillSwitchReadinessReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  const limitActive = (v: number | null | undefined): boolean =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v < KILL_SWITCH_OFF_SENTINEL;
  const en = !!live && live.engineEnabled;
  const dailyOk = en && limitActive(live!.dailyMaxLossUsd);
  const drawdownOk = en && limitActive(live!.maxDrawdownUsd);
  const streakOk = en && typeof live!.maxConsecutiveLosses === "number" && live!.maxConsecutiveLosses > 0 && live!.maxConsecutiveLosses < 1000;

  // Map each spec control to its real engine state. The engine ENFORCES the first six (config limits
  // + hardcoded auto-disarm/manual-kill); the execution-quality stops are not yet wired in the engine.
  const implementedByName: Record<string, boolean> = {
    daily_max_loss_limit: dailyOk,
    max_drawdown_stop: drawdownOk,
    max_consecutive_losses: streakOk,
    exchange_error_stop: en, // engine auto-disarms on error streak
    manual_emergency_stop: en, // engine.kill() flattens + disarms
    auto_disable_on_reconciliation_mismatch: en, // engine auto-disarms on ledger mismatch
    spread_spike_stop: false,
    slippage_spike_stop: false,
    abnormal_volatility_stop: false,
    stale_data_stop: false,
  };
  const controls: KillSwitchControl[] = CONTROLS.map((c) => ({
    ...c,
    implemented: implementedByName[c.name] ?? false,
  }));
  const missingControls = controls.filter((c) => !c.implemented).map((c) => c.name);

  // v1 ready: engine enabled + critical capital-protection limits active + safety machinery wired.
  const readyReasons: string[] = [];
  if (!live) readyReasons.push("no live engine config (report-only spec mode)");
  else {
    if (!en) readyReasons.push("live engine not enabled");
    if (!dailyOk) readyReasons.push("daily-max-loss limit OFF (set LIVE_DAILY_MAX_LOSS_USD to a real value)");
    if (!drawdownOk) readyReasons.push("max-drawdown limit OFF (set LIVE_MAX_DRAWDOWN_USD to a real value)");
    if (!streakOk) readyReasons.push("max-consecutive-losses limit not set");
  }
  const ready = readyReasons.length === 0 && !!live;
  const implemented = controls.every((c) => c.implemented);

  const summary = ready
    ? `Kill switch v1 READY: engine enabled, daily-loss/drawdown/streak limits active, manual-kill + auto-disarm wired (${controls.filter((c) => c.implemented).length}/${controls.length} controls; execution-quality stops advisory).`
    : `Kill switch NOT ready: ${readyReasons.join("; ") || `${missingControls.length}/${controls.length} controls missing`}.`;

  return {
    reportOnly: true,
    module: KILL_SWITCH_READINESS_MODULE,
    computedAt,
    implemented,
    ready,
    readyReasons,
    controls,
    missingControls,
    summary,
  };
}

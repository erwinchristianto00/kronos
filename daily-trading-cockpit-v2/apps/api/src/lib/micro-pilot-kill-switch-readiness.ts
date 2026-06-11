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

export interface KillSwitchReadinessReport {
  reportOnly: true;
  module: typeof KILL_SWITCH_READINESS_MODULE;
  computedAt: string;
  implemented: false;
  ready: false;
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
): KillSwitchReadinessReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  const controls: KillSwitchControl[] = CONTROLS.map((c) => ({
    ...c,
    implemented: false,
  }));
  const missingControls = controls.filter((c) => !c.implemented).map((c) => c.name);
  const summary = `Kill switch NOT implemented. ${missingControls.length}/${controls.length} controls missing. Required before any micro-pilot.`;

  return {
    reportOnly: true,
    module: KILL_SWITCH_READINESS_MODULE,
    computedAt,
    implemented: false,
    ready: false,
    controls,
    missingControls,
    summary,
  };
}

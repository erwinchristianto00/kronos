/**
 * AF. ORDER RECONCILIATION READINESS — REPORT-ONLY SPEC
 *
 * Describes the FUTURE order-lifecycle tracking and local-vs-exchange
 * reconciliation infrastructure that would have to exist BEFORE any micro-pilot
 * could be discussed. The current system is paper-only and has no order
 * lifecycle, so every lifecycle stage reports tracked=false and the module
 * reports ready=false. Pure module: zero I/O, no side effects, never throws.
 */

export const ORDER_RECONCILIATION_READINESS_MODULE =
  "ORDER_RECONCILIATION_READINESS" as const;

export interface OrderLifecycleStage {
  stage: string;
  description: string;
  tracked: boolean; // all false for now
  requiredLedgerFields: string[];
}

/** v1 live inputs from the live-execution engine's in-memory getStatus() (sync, no I/O). When
 *  omitted the report behaves like the original spec (ready stays false). The engine already
 *  reconciles open intents vs the exchange each tick and records drift in reconcileIssues. */
export interface OrderReconciliationLiveInputs {
  engineEnabled: boolean; // live engine constructed + its tick/reconcile loop runs
  lastTickAgeMs: number | null; // now − lastTickAt; null if never ticked
  reconcileIssueCount: number; // outstanding drift/orphan issues from the last reconcile
  lastTickError: string | null; // last engine-tick error (null = clean)
  openIntentCount: number; // live intents the engine is tracking (its ledger)
}
export const ORDER_RECON_MAX_TICK_AGE_MS = Number(process.env.ORDER_RECON_MAX_TICK_AGE_MS) || 5 * 60 * 1000;

export interface OrderReconciliationReadinessReport {
  reportOnly: true;
  module: typeof ORDER_RECONCILIATION_READINESS_MODULE;
  computedAt: string;
  implemented: boolean;
  /** v1 gate: true only when the engine's reconcile loop is running RECENTLY with NO outstanding
   *  drift/errors. ANDed with killSwitch + exchangeHealth in infraReady, so it can't enable live
   *  alone. false whenever live inputs are absent. */
  ready: boolean;
  readyReasons: string[];
  lifecycleStages: OrderLifecycleStage[];
  requiredLedgerFields: string[]; // aggregate unique
  requiredExchangeChecks: string[];
  risksIfMissing: string[];
  summary: string;
}

const LIFECYCLE_STAGES: ReadonlyArray<Omit<OrderLifecycleStage, "tracked">> = [
  {
    stage: "intended_signal",
    description: "The strategy's intended trade before any order is sent.",
    requiredLedgerFields: ["clientOrderId", "symbol", "side", "intendedQty", "submittedAt"],
  },
  {
    stage: "order_submitted",
    description: "Order dispatched to the exchange; awaiting acknowledgement.",
    requiredLedgerFields: ["clientOrderId", "exchangeOrderId", "submittedAt", "status"],
  },
  {
    stage: "order_accepted",
    description: "Exchange acknowledged and accepted the order.",
    requiredLedgerFields: ["exchangeOrderId", "status"],
  },
  {
    stage: "partial_fill",
    description: "Order partially filled; remaining quantity still working.",
    requiredLedgerFields: ["exchangeOrderId", "filledQty", "avgFillPrice", "fees", "filledAt"],
  },
  {
    stage: "full_fill",
    description: "Order completely filled.",
    requiredLedgerFields: ["exchangeOrderId", "filledQty", "avgFillPrice", "fees", "filledAt", "status"],
  },
  {
    stage: "canceled",
    description: "Order canceled before full fill.",
    requiredLedgerFields: ["exchangeOrderId", "status", "filledQty"],
  },
  {
    stage: "rejected",
    description: "Exchange rejected the order.",
    requiredLedgerFields: ["clientOrderId", "exchangeOrderId", "status"],
  },
  {
    stage: "timeout",
    description: "No exchange response within the expected window.",
    requiredLedgerFields: ["clientOrderId", "submittedAt", "status"],
  },
  {
    stage: "orphaned_position",
    description: "Position exists on the exchange with no corresponding local intent.",
    requiredLedgerFields: ["exchangeOrderId", "symbol", "filledQty", "reconciledAt"],
  },
  {
    stage: "exchange_position_mismatch",
    description: "Local position differs from the exchange-reported position.",
    requiredLedgerFields: ["symbol", "filledQty", "reconciledAt", "status"],
  },
  {
    stage: "local_vs_exchange_ledger_reconciliation",
    description: "Full reconciliation of the local ledger against exchange state.",
    requiredLedgerFields: ["clientOrderId", "exchangeOrderId", "filledQty", "avgFillPrice", "fees", "reconciledAt"],
  },
  {
    stage: "fee_funding_capture",
    description: "Capture realized fees and funding payments per position.",
    requiredLedgerFields: ["fees", "fundingPaid", "reconciledAt"],
  },
  {
    stage: "realized_pnl_reconciliation",
    description: "Reconcile realized PnL between the local ledger and exchange.",
    requiredLedgerFields: ["avgFillPrice", "fees", "fundingPaid", "reconciledAt", "status"],
  },
];

const REQUIRED_LEDGER_FIELDS: readonly string[] = [
  "clientOrderId",
  "exchangeOrderId",
  "symbol",
  "side",
  "intendedQty",
  "filledQty",
  "avgFillPrice",
  "fees",
  "fundingPaid",
  "status",
  "submittedAt",
  "filledAt",
  "reconciledAt",
];

const REQUIRED_EXCHANGE_CHECKS: readonly string[] = [
  "poll open orders",
  "poll positions",
  "poll account balance",
  "poll user trades",
  "compare local vs exchange position",
  "detect orphans",
];

const RISKS_IF_MISSING: readonly string[] = [
  "Orphaned positions could accumulate undetected",
  "PnL drift between local ledger and exchange",
  "Unreconciled fees/funding distort net expectancy",
  "Partial fills mis-accounted",
];

export function buildOrderReconciliationReadinessReport(
  capturedAt?: string,
  live?: OrderReconciliationLiveInputs,
): OrderReconciliationReadinessReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  // When the live engine is enabled it tracks the full order lifecycle + reconciles each tick, so
  // the lifecycle stages are "tracked". Without live inputs this is the original report-only spec.
  const tracked = !!live && live.engineEnabled;
  const lifecycleStages: OrderLifecycleStage[] = LIFECYCLE_STAGES.map((s) => ({ ...s, tracked }));

  const readyReasons: string[] = [];
  if (!live) readyReasons.push("no live engine status (report-only spec mode)");
  else {
    if (!live.engineEnabled) readyReasons.push("live engine not enabled (reconcile loop not running)");
    else if (live.lastTickAgeMs == null) readyReasons.push("engine has not ticked yet");
    else if (live.lastTickAgeMs > ORDER_RECON_MAX_TICK_AGE_MS) {
      readyReasons.push(`last reconcile ${Math.round(live.lastTickAgeMs / 1000)}s ago > ${Math.round(ORDER_RECON_MAX_TICK_AGE_MS / 1000)}s`);
    }
    if (live.reconcileIssueCount > 0) readyReasons.push(`${live.reconcileIssueCount} unresolved reconcile issue(s)`);
    if (live.lastTickError) readyReasons.push(`last tick error: ${live.lastTickError}`);
  }
  const ready = readyReasons.length === 0 && !!live;
  const implemented = tracked;

  return {
    reportOnly: true,
    module: ORDER_RECONCILIATION_READINESS_MODULE,
    computedAt,
    implemented,
    ready,
    readyReasons,
    lifecycleStages,
    requiredLedgerFields: [...REQUIRED_LEDGER_FIELDS],
    requiredExchangeChecks: [...REQUIRED_EXCHANGE_CHECKS],
    risksIfMissing: [...RISKS_IF_MISSING],
    summary: ready
      ? `Order reconciliation v1 READY: engine reconcile loop running, ${live!.openIntentCount} open intent(s), 0 unresolved drift.`
      : `Order reconciliation NOT ready: ${readyReasons.join("; ")}.`,
  };
}

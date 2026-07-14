/**
 * Execution lifecycle-timestamp log (Track 2). A STANDALONE, append-only, fail-open, default-OFF logger for order
 * lifecycle timestamps — the fields free L1 calibration needs but the intent ledger lacks (ack / first-fill /
 * cancel / reject timing), especially to split the material SHORT-side residual. Decoupled from the execution
 * engine: it writes to an injected sink and NEVER participates in order flow, so wiring a `recordLifecycle(...)`
 * call at a lifecycle point cannot alter awaits/retries/timeouts/sequencing, cannot add an exchange API call,
 * cannot create a trade, and cannot touch the kill switch.
 *
 * Safety contract: logging ONLY; fail-open (sink errors swallowed); default-OFF (env `EXEC_LIFECYCLE_TIMESTAMPS=1`
 * or explicit `enabled`); pure derivation. No sensitive payloads / credentials in `extra`.
 */

export type LifecycleEvent =
  | "DECISION" | "SUBMITTED" | "EXCHANGE_ACK" | "FIRST_FILL" | "FINAL_FILL"
  | "CANCEL_REQUESTED" | "CANCEL_ACK" | "REJECTED" | "EXPIRED";

export const LIFECYCLE_SCHEMA_VERSION = "exec-lifecycle-1";

/** The operator's ExecutionLifecycleEvent shape. `eventAtMs` = local observe time; `exchangeEventAtMs` = the
 *  exchange's own timestamp when available (null otherwise) — the two let us measure true submit→ack latency. */
export interface ExecutionLifecycleEvent {
  schemaVersion: string;
  orderId: string;
  decisionId: string | null;
  instanceId: string;
  event: LifecycleEvent;
  eventAtMs: number;
  exchangeEventAtMs: number | null;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  requestedQty: number | null;
  cumulativeFilledQty: number | null;
  source: string;
}

export type LifecycleSink = (rec: ExecutionLifecycleEvent) => void;

/** Env gate — default OFF. Any value other than "1" (incl. unset) keeps the logger inert. */
export function isLifecycleLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXEC_LIFECYCLE_TIMESTAMPS === "1";
}

export interface RecordOpts { enabled?: boolean; failOpen?: boolean; }

/** Record one lifecycle event. Returns true if written, false if inert/failed. NEVER throws when failOpen (default). */
export function recordLifecycle(sink: LifecycleSink, rec: Omit<ExecutionLifecycleEvent, "schemaVersion">, opts: RecordOpts = {}): boolean {
  const enabled = opts.enabled ?? isLifecycleLoggingEnabled();
  if (!enabled) return false;
  const failOpen = opts.failOpen ?? true;
  try {
    sink({ ...rec, schemaVersion: LIFECYCLE_SCHEMA_VERSION });
    return true;
  } catch (err) {
    if (!failOpen) throw err;
    return false;
  }
}

export interface LifecycleTimestamps {
  decisionAt: number | null; submittedAt: number | null; exchangeAckAt: number | null;
  firstFillAt: number | null; finalFillAt: number | null;
  cancelRequestedAt: number | null; cancelAckAt: number | null; rejectedAt: number | null; expiredAt: number | null;
}

export const EMPTY_LIFECYCLE: LifecycleTimestamps = {
  decisionAt: null, submittedAt: null, exchangeAckAt: null, firstFillAt: null, finalFillAt: null,
  cancelRequestedAt: null, cancelAckAt: null, rejectedAt: null, expiredAt: null,
};

/** Fold a per-order event stream into aggregated timestamps. FIRST_FILL keeps earliest; else latest. Prefers the
 *  exchange's own timestamp when present (truer latency), falling back to the local observe time. */
export function foldLifecycle(records: ExecutionLifecycleEvent[]): LifecycleTimestamps {
  const out: LifecycleTimestamps = { ...EMPTY_LIFECYCLE };
  const map: Record<LifecycleEvent, keyof LifecycleTimestamps> = {
    DECISION: "decisionAt", SUBMITTED: "submittedAt", EXCHANGE_ACK: "exchangeAckAt", FIRST_FILL: "firstFillAt",
    FINAL_FILL: "finalFillAt", CANCEL_REQUESTED: "cancelRequestedAt", CANCEL_ACK: "cancelAckAt", REJECTED: "rejectedAt", EXPIRED: "expiredAt",
  };
  const tsOf = (r: ExecutionLifecycleEvent) => (r.exchangeEventAtMs != null && Number.isFinite(r.exchangeEventAtMs) ? r.exchangeEventAtMs : r.eventAtMs);
  for (const r of records.slice().sort((a, b) => tsOf(a) - tsOf(b))) {
    const k = map[r.event];
    const t = tsOf(r);
    if (k === "firstFillAt") out[k] = out[k] == null ? t : Math.min(out[k]!, t);
    else out[k] = t;
  }
  return out;
}

export interface LifecycleLatencies {
  decisionToSubmitMs: number | null; submitToAckMs: number | null; ackToFirstFillMs: number | null;
  firstToFinalFillMs: number | null; cancelReqToAckMs: number | null; submitToRejectMs: number | null;
}

/** Pure latency derivation. Null when either endpoint is missing (never negative-forced). */
export function deriveLatencies(ts: LifecycleTimestamps): LifecycleLatencies {
  const d = (a: number | null, b: number | null): number | null => (a != null && b != null ? b - a : null);
  return {
    decisionToSubmitMs: d(ts.decisionAt, ts.submittedAt),
    submitToAckMs: d(ts.submittedAt, ts.exchangeAckAt),
    ackToFirstFillMs: d(ts.exchangeAckAt, ts.firstFillAt),
    firstToFinalFillMs: d(ts.firstFillAt, ts.finalFillAt),
    cancelReqToAckMs: d(ts.cancelRequestedAt, ts.cancelAckAt),
    submitToRejectMs: d(ts.submittedAt, ts.rejectedAt),
  };
}

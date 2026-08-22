/**
 * A cancel acknowledgement is not a terminal order state.
 *
 * Binance can accept a cancel request while a subsequent order query still returns `NEW` for a
 * short propagation window.  Treating that first read as final leaves an entry unfilled; treating
 * it as zero-filled and crossing immediately can double a fill.  The only safe middle ground is a
 * short, bounded confirmation loop: cross the remainder only after the exchange reports a
 * terminal state with its final executed quantity.  If the answer stays ambiguous, the caller
 * must persist its order identity and recover on a later executor tick.
 *
 * This module deliberately knows nothing about baskets, quantities, or fallback orders.  Both
 * entry executors use the same transport-level rule, while their own recovery logic continues to
 * own exposure and lifecycle decisions.
 */

export interface MakerOrderStatus {
  status: string | null | undefined;
}

const TERMINAL_MAKER_STATUSES = new Set(["FILLED", "CANCELED", "CANCELLED", "EXPIRED", "REJECTED"]);

export function isTerminalMakerOrderStatus(status: string | null | undefined): boolean {
  return TERMINAL_MAKER_STATUSES.has(String(status ?? "").trim().toUpperCase());
}

export interface MakerCancelConfirmation<T extends MakerOrderStatus> {
  order: T;
  /** Number of post-cancel exchange reads attempted.  Persist this for audit, not decisioning. */
  attempts: number;
  terminal: boolean;
}

/**
 * Re-read an order for a small, fixed window after a cancel request.
 *
 * `retries=4` and `retryDelayMs=400` mirrors the existing fill-price confirmation budget: at
 * most about 1.6 seconds plus request time.  Query failures intentionally consume an attempt;
 * otherwise a broken transport could block an executor indefinitely.  The caller receives the
 * last known state and must still fail closed when `terminal` is false.
 */
export async function confirmMakerCancel<T extends MakerOrderStatus>(
  initial: T,
  queryLatest: () => Promise<T>,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<MakerCancelConfirmation<T>> {
  let latest = initial;
  if (isTerminalMakerOrderStatus(latest.status)) {
    return { order: latest, attempts: 0, terminal: true };
  }

  const retries = Math.max(1, Math.floor(opts.retries ?? 4));
  const delayMs = Math.max(0, opts.retryDelayMs ?? 400);
  let attempts = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempts += 1;
    try {
      latest = await queryLatest();
    } catch {
      // Ambiguous by definition.  Keep the previous answer and retry only within the fixed budget.
    }
    if (isTerminalMakerOrderStatus(latest.status)) {
      return { order: latest, attempts, terminal: true };
    }
  }
  return { order: latest, attempts, terminal: false };
}

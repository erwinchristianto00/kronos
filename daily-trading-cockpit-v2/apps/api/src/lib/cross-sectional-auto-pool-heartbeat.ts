import type {
  CrossSectionalAutoPool,
  CrossSectionalAutoPoolRefreshInput,
} from "./cross-sectional-auto-pool.js";

export const CROSS_SECTIONAL_AUTO_POOL_HEARTBEAT_MS = 30_000;

/**
 * Keeps the durable C1/C2 pool current even when no dashboard/brief request arrives.
 * `refreshIfDue` owns the actual cadence and the exchange call, so this heartbeat only asks
 * whether a refresh is due. It never has access to an execution client or an order path.
 */
export function startCrossSectionalAutoPoolHeartbeat(
  pool: Pick<CrossSectionalAutoPool, "refreshIfDue">,
  input: () => CrossSectionalAutoPoolRefreshInput | null,
  opts: {
    heartbeatMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const heartbeatMs = opts.heartbeatMs ?? CROSS_SECTIONAL_AUTO_POOL_HEARTBEAT_MS;
  const refresh = (): void => {
    const resolvedInput = input();
    if (!resolvedInput) return;
    void pool.refreshIfDue(resolvedInput).catch((error) => {
      opts.onError?.(error);
    });
  };

  refresh();
  const timer = setInterval(refresh, heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

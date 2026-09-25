/**
 * Dedicated continuation data collector. It never imports an executor or model trainer.
 *
 * Usage:
 *   npx tsx scripts/continuation-collector.ts [--root=/root/kronos-continuation] [--once]
 */
import {
  BinanceKlineWebsocketSupervisor,
  ContinuationDataCollector,
} from "../src/lib/continuation-data-collector.js";
import {
  acquireContinuationLock,
  continuationLifecyclePaths,
  continuationNowIso,
  ensureContinuationLifecycleDirectories,
} from "../src/lib/continuation-lifecycle.js";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const root = option("root") ?? process.env.CONTINUATION_LIFECYCLE_ROOT;
const once = process.argv.slice(2).includes("--once");
const intervalRaw = Number(process.env.CONTINUATION_RECONCILE_MS ?? 60 * 60_000);
const reconcileIntervalMs = Number.isFinite(intervalRaw) ? Math.max(15 * 60_000, Math.min(6 * 60 * 60_000, intervalRaw)) : 60 * 60_000;
// The Binance WebSocket is an optimization, not a truth source. Keep completed price candles
// fresh by REST even when a proxy accepts the socket but silently starves payloads.
const klineIntervalRaw = Number(process.env.CONTINUATION_KLINE_RECONCILE_MS ?? 2 * 60_000);
const klineReconcileIntervalMs = Number.isFinite(klineIntervalRaw) ? Math.max(60_000, Math.min(15 * 60_000, klineIntervalRaw)) : 2 * 60_000;
const paths = ensureContinuationLifecycleDirectories(continuationLifecyclePaths(root));
const lock = acquireContinuationLock("collector", paths);

if (!lock) {
  console.log(JSON.stringify({ event: "CONT_COLLECTOR_ALREADY_RUNNING", root: paths.root }));
  process.exit(0);
}

const log = (event: string, details: Record<string, unknown>) => console.log(JSON.stringify({ event, at: continuationNowIso(), ...details }));
const collector = new ContinuationDataCollector({ paths, logger: log });
const websocket = new BinanceKlineWebsocketSupervisor(collector, undefined, undefined, log);
let stopping = false;
let reconciling = false;

async function reconcile(reason: string): Promise<void> {
  if (reconciling || stopping) return;
  reconciling = true;
  try {
    const result = await collector.reconcileOnce();
    log("CONT_RECONCILE_COMPLETE", { reason, ...result });
  } catch (error) {
    log("CONT_RECONCILE_FAILED", { reason, error: error instanceof Error ? error.message : String(error) });
  } finally {
    reconciling = false;
  }
}

async function reconcileKlines(reason: string): Promise<void> {
  if (reconciling || stopping) return;
  reconciling = true;
  try {
    const result = await collector.reconcileKlinesOnce();
    log("CONT_KLINE_RECONCILE_COMPLETE", { reason, ...result });
  } catch (error) {
    log("CONT_KLINE_RECONCILE_FAILED", { reason, error: error instanceof Error ? error.message : String(error) });
  } finally {
    reconciling = false;
  }
}

async function main(): Promise<void> {
  log("CONT_COLLECTOR_STARTED", { root: paths.root, once, reconcileIntervalMs, klineReconcileIntervalMs });
  await reconcile("startup");
  if (once) {
    collector.writeHealth();
    lock.release();
    return;
  }
  websocket.start();
  const reconcileTimer = setInterval(() => { void reconcile("scheduled"); }, reconcileIntervalMs);
  const klineReconcileTimer = setInterval(() => { void reconcileKlines("scheduled"); }, klineReconcileIntervalMs);
  const healthTimer = setInterval(() => collector.writeHealth(), 60_000);
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(reconcileTimer);
    clearInterval(klineReconcileTimer);
    clearInterval(healthTimer);
    websocket.stop();
    collector.writeHealth();
    lock.release();
    log("CONT_COLLECTOR_STOPPED", { signal });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

void main().catch((error) => {
  lock.release();
  console.error(JSON.stringify({ event: "CONT_COLLECTOR_FATAL", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

/**
 * Read-only exchange fingerprint for guarded Testnet API cutovers.
 *
 * The dashboard intentionally serves a last-good account cache immediately so
 * it never blocks the UI behind a slow private refresh. That is the right UI
 * behaviour, but it is not sufficient evidence for replacing an executor
 * process. This helper reads the two exchange facts needed by the cutover
 * guard directly: non-zero positions and normal open orders. It never places,
 * cancels, changes, or closes an order.
 */
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";

const DEFAULT_TESTNET_GLOBAL_READ_GAP_MS = 30_000;
// This helper deliberately uses a local-clock signed read. It is strictly
// read-only; a real clock error is rejected by Binance as -1021 and never
// turns into an order. Avoiding a separate /time probe keeps a guarded
// cutover from competing with the public candle queue it is replacing.
const DIRECT_FINGERPRINT_HTTP_READS = 4;

/**
 * The fingerprint deliberately reads positions and open orders. On Testnet
 * those reads share a durable, host-wide lease, so parallel calls cannot both
 * leave the VPS at once. Reserve enough time for positions, orders, plus one
 * slot already owned by the running process.
 */
function directFingerprintTimeoutMs(env: NodeJS.ProcessEnv, bookedAheadMs: number): number {
  const configuredGap = Number.parseInt(env.BINANCE_USDM_TESTNET_GLOBAL_READ_GAP_MS ?? "", 10);
  const globalReadGapMs = Number.isFinite(configuredGap) && configuredGap > 0
    ? configuredGap
    : DEFAULT_TESTNET_GLOBAL_READ_GAP_MS;
  const possibleExistingSlotCount = 1;
  const networkAndSchedulerBudgetMs = 15_000;
  // The gap alone describes an idle lease. Under a backlog the lease is
  // already booked minutes ahead, and this reader must queue behind that like
  // any other participant. Sizing on the gap alone made a guarded cutover fail
  // 6/6 on 2026-09-04 — every attempt timed out at 105s while the public lane
  // was booked ~4 minutes out, so the release that would have relieved the
  // backlog could not be deployed because of the backlog.
  return Math.max(
    30_000,
    bookedAheadMs
      + globalReadGapMs * (DIRECT_FINGERPRINT_HTTP_READS + possibleExistingSlotCount)
      + networkAndSchedulerBudgetMs
      // A final shared-weight gate may legitimately sit out a minute per read.
      + DIRECT_FINGERPRINT_HTTP_READS * 65_000,
  );
}

async function main(): Promise<void> {
  // Resolve from this deployed script, rather than the caller's cwd. Load
  // quietly before dynamically importing the client, whose module evaluates
  // transport cadence constants from process.env at import time.
  const deployDirectory = dirname(process.argv[1] ?? process.cwd());
  loadDotenv({ path: resolve(deployDirectory, "..", ".env"), override: false, quiet: true });
  const {
    BinanceFuturesPrivateClient,
    resolveLiveBinanceEnv,
  } = await import("../apps/api/src/lib/binance-futures-private.js");
  const { BinanceUsdMTestnetReadCoordinator } = await import(
    "../apps/api/src/lib/binance-usdm-testnet-rate-limit.js"
  );
  const environment = resolveLiveBinanceEnv(process.env.LIVE_BINANCE_ENV);
  if (environment !== "testnet") {
    throw new Error("refusing direct fingerprint outside LIVE_BINANCE_ENV=testnet");
  }

  const apiKey = process.env.LIVE_BINANCE_API_KEY ?? "";
  const apiSecret = process.env.LIVE_BINANCE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    throw new Error("LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET missing");
  }

  // This helper is used by a deployment guard while new admissions are
  // drained. A stuck private read must fail the guard and restore control,
  // never leave a healthy process indefinitely paused behind an unbounded
  // network wait. The helper is read-only, so a hard process timeout is safe.
  // Ask the lease how far ahead it is already booked, so this reader waits out
  // a real backlog instead of failing the deployment gate that would relieve it.
  const coordinationDirectory = process.env.BINANCE_USDM_TESTNET_COORDINATION_DIR
    ?? "data/binance-usdm-testnet-transport";
  const bookedAheadMs = Math.max(
    0,
    new BinanceUsdMTestnetReadCoordinator({ directory: coordinationDirectory }).bookedThroughMs() - Date.now(),
  );
  const timeoutMs = directFingerprintTimeoutMs(process.env, bookedAheadMs);
  const timeout = setTimeout(() => {
    console.error(`direct Testnet account fingerprint timed out after ${timeoutMs}ms`);
    process.exit(1);
  }, timeoutMs);
  try {
    const client = new BinanceFuturesPrivateClient({ apiKey, apiSecret, env: environment });
    const [allPositions, openOrders] = await Promise.all([
      client.getPositions(undefined, { allowUnsyncedRead: true }),
      client.getOpenOrders(undefined, { allowUnsyncedRead: true }),
    ]);

    const conditionalOrders = await client.getOpenAlgoOrders();
    const positions = allPositions
      .filter((position) => Number.isFinite(position.positionAmt) && position.positionAmt !== 0)
      .map((position) => ({
        symbol: position.symbol,
        direction: position.positionAmt > 0 ? "LONG" : "SHORT",
        quantity: Math.abs(position.positionAmt),
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.direction.localeCompare(b.direction));

    process.stdout.write(`${JSON.stringify({
      ok: true,
      source: "USD_M_DIRECT_READ",
      openPositionCount: positions.length,
      openOrderCount: openOrders.length,
      positions,
      regularOrders: openOrders.map(o => ({symbol:o.symbol,orderId:o.orderId,side:o.side,quantity:o.origQty})).sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.orderId.localeCompare(b.orderId)),
      conditionalOrders: conditionalOrders.map(o => ({symbol:o.symbol,algoId:o.algoId,side:o.side,quantity:o.quantity,triggerPrice:o.triggerPrice})).sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.algoId.localeCompare(b.algoId)),
    })}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "direct exchange fingerprint failed");
  process.exitCode = 1;
});

/**
 * Read-only exchange fingerprint for guarded LIVE (mainnet) API cutovers.
 *
 * The cutover guard used to take this fingerprint from the running process's
 * own /api/live/account. That endpoint is served by the very process being
 * replaced, so when its transport queue jammed on 2026-09-04 the endpoint
 * stopped answering entirely (HTTP 000 at 300s) and the guard became
 * unsatisfiable — the one situation where a cutover is most needed was the one
 * situation it could not verify. Read the two exchange facts the guard needs
 * directly instead, from a fresh short-lived process with its own transport.
 *
 * This mirrors deploy/verify-testnet-account-fingerprint.ts, whose own comment
 * makes the same argument: a cutover needs exchange truth, not the dashboard's
 * last-good cache. It never places, cancels, changes, or closes an order.
 */
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";

/**
 * Mainnet has no host-wide read lease: each read is one request bounded by the
 * client's own 10s timeout with up to two retries, plus a cold time sync.
 * Sixty seconds covers that comfortably and still fails closed rather than
 * leaving a drained engine waiting on an unbounded network read.
 */
const DIRECT_FINGERPRINT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  // Resolve from this deployed script, not the caller's cwd. Load quietly
  // before importing the client, which reads transport constants from
  // process.env at module evaluation time.
  const deployDirectory = dirname(process.argv[1] ?? process.cwd());
  loadDotenv({ path: resolve(deployDirectory, "..", ".env"), override: false, quiet: true });
  const {
    BinanceFuturesPrivateClient,
    resolveLiveBinanceEnv,
  } = await import("../apps/api/src/lib/binance-futures-private.js");
  const environment = resolveLiveBinanceEnv(process.env.LIVE_BINANCE_ENV);
  if (environment !== "mainnet") {
    throw new Error("refusing direct live fingerprint outside LIVE_BINANCE_ENV=mainnet");
  }

  const apiKey = process.env.LIVE_BINANCE_API_KEY ?? "";
  const apiSecret = process.env.LIVE_BINANCE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    throw new Error("LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET missing");
  }

  // Used by a deployment guard while new admissions are drained. A stuck
  // private read must fail the guard and restore control, never leave a
  // healthy process paused behind an unbounded wait. Read-only, so a hard
  // process timeout is safe.
  const timeout = setTimeout(() => {
    console.error(`direct live account fingerprint timed out after ${DIRECT_FINGERPRINT_TIMEOUT_MS}ms`);
    process.exit(1);
  }, DIRECT_FINGERPRINT_TIMEOUT_MS);
  try {
    const client = new BinanceFuturesPrivateClient({ apiKey, apiSecret, env: environment });
    const [allPositions, openOrders] = await Promise.all([
      client.getPositions(),
      client.getOpenOrders(),
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

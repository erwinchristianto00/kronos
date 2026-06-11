/**
 * READ-ONLY live-execution pre-flight. Loads the same .env the server uses, then makes
 * SIGNED READ-ONLY calls (time, account mode, exchange filters, balances) to verify the
 * keys authenticate and the connection is healthy. Places NO orders. Refuses to run
 * against mainnet keys. Re-runnable: `node_modules/.bin/tsx apps/api/scripts/live-preflight.ts`.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env"), override: true, quiet: true });

const { parseLiveExecutionConfig } = await import("../src/lib/live-execution-engine.js");
const { BinanceFuturesPrivateClient } = await import("../src/lib/binance-futures-private.js");

async function main(): Promise<void> {
  const cfg = parseLiveExecutionConfig();
  console.log(`enabled=${cfg.enabled}  env=${cfg.env}  autoArm=${cfg.autoArm}`);
  if (cfg.configErrors.length > 0) {
    console.log("ABORT — config errors:", cfg.configErrors.join("; "));
    return;
  }
  if (!cfg.enabled || !cfg.env) {
    console.log("ABORT — live execution not enabled (set LIVE_EXECUTION_ENABLED=1).");
    return;
  }
  if (cfg.env !== "testnet") {
    console.log("ABORT — env is NOT testnet. This read-only pre-flight refuses to touch mainnet keys.");
    return;
  }

  const client = new BinanceFuturesPrivateClient({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, env: cfg.env });

  await client.ensureTimeSync();
  console.log(`clock skew = ${Math.round(client.getClockSkewMs())}ms (guard 1000ms)`);

  const hedge = await client.isHedgeMode();
  console.log(`position mode = ${hedge ? "HEDGE (must switch to one-way before arming)" : "ONE-WAY (ok)"}`);

  const filters = await client.getExchangeFilters();
  console.log(`exchange filters loaded for ${filters.size} symbols`);

  const balances = await client.getBalances();
  const usdt = balances.find((b) => b.asset === "USDT");
  console.log(`account read OK — ${balances.length} assets, USDT available = ${usdt ? usdt.availableBalance : "(none)"}`);

  console.log("\nREAD-ONLY CONNECTIVITY: OK ✅  (no orders placed)");
}

main().catch((error: unknown) => {
  const e = error as { failureType?: string; binanceCode?: number; message?: string };
  console.log(`CONNECTIVITY FAILED — ${e.failureType ?? "error"}${e.binanceCode ? ` code ${e.binanceCode}` : ""}: ${e.message ?? String(error)}`);
});

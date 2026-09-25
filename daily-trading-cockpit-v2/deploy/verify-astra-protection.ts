/** Read-only exact exchange evidence for the first owned Astra experiment. */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
async function main() {
  const root = resolve(dirname(process.argv[1]), "..");
  config({ path: resolve(root, ".env"), quiet: true });
  if (process.env.LIVE_BINANCE_ENV !== "testnet") throw new Error("Testnet only");
  process.chdir(resolve(root, "apps/api"));
  const { BinanceFuturesPrivateClient } = await import("../apps/api/src/lib/binance-futures-private.js");
  const c = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: process.env.LIVE_BINANCE_API_KEY ?? "", apiSecret: process.env.LIVE_BINANCE_API_SECRET ?? "" });
  const order = await c.queryOrderByClientId("DOODUSDT", "astra-e-43727aa62995b0de7867d8");
  const positions = await c.getPositions("DOODUSDT");
  const stops = await c.getOpenAlgoOrders("DOODUSDT");
  const fills = await c.getUserTrades("DOODUSDT", { startTime: 1788718200000, limit: 1000 });
  console.log(JSON.stringify({ at: new Date().toISOString(), readOnly: true, order, positions, stops, fills: fills.filter(f => f.orderId === "280274265") }));
}
void main().catch(() => { console.error("Astra exchange evidence read failed"); process.exitCode = 1; });

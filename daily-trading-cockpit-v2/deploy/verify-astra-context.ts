/** Read-only candidate data proof, using the same durable Testnet transport queue. */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";

async function main() {
const root = resolve(dirname(process.argv[1]), "..");
config({ path: resolve(root, ".env"), quiet: true });
if (process.env.LIVE_BINANCE_ENV !== "testnet") throw new Error("Testnet only");
process.chdir(resolve(root, "apps/api"));
const { BinanceFuturesPrivateClient } = await import("../apps/api/src/lib/binance-futures-private.js");
const { AstraResearchContext } = await import("../apps/api/src/lib/astra-research-context.js");
const client = new BinanceFuturesPrivateClient({ env: "testnet", apiKey: process.env.LIVE_BINANCE_API_KEY ?? "", apiSecret: process.env.LIVE_BINANCE_API_SECRET ?? "" });
const timeout = setTimeout(() => { console.error("Astra read-only context verification timeout"); process.exit(1); }, 240000);
try {
  const research = new AstraResearchContext(client, Date.now);
  const filters = await client.getExchangeFilters();
  const books = await client.getExecutionBookTickers([...filters.keys()]);
  const overview = await research.overview([...filters.keys()], books, [], 25, filters);
  const economics = await research.economics("DOGEUSDT", books.get("DOGEUSDT") ?? null);
  if (overview.screening.status !== "AVAILABLE" || economics.commission.status !== "AVAILABLE" || economics.funding.status !== "INDICATIVE")
    throw new Error("Required venue economics/screening data unavailable");
  console.log(JSON.stringify({ at: new Date().toISOString(), environment: "testnet", readOnly: true,
    screening: overview.screening, symbol: "DOGEUSDT", economics }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Astra context verification failed");
  process.exitCode = 1;
} finally { clearTimeout(timeout); }
}
void main().catch(() => { console.error("Astra context preflight failed before read completion"); process.exitCode = 1; });

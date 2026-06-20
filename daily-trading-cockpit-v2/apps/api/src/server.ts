import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root before anything reads process.env
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env"), override: false });

import { buildApp } from "./app.js";

console.log(`[API] SOCIAL_SENTIMENT_PROVIDER=${process.env.SOCIAL_SENTIMENT_PROVIDER ?? "(not set)"}`);

const port = Number(process.env.PORT ?? 3101);

// Optional HTTP/SOCKS5 proxy for Binance market-data endpoints (geo-block workaround).
// Set BINANCE_HTTPS_PROXY=http://127.0.0.1:7890 (Clash) or socks5://127.0.0.1:1080 etc.
let proxyFetchImpl: typeof fetch | undefined;
if (process.env.BINANCE_HTTPS_PROXY) {
  const { ProxyAgent } = await import("undici");
  const agent = new ProxyAgent(process.env.BINANCE_HTTPS_PROXY);
  proxyFetchImpl = (url, init) => fetch(url, { ...init, dispatcher: agent } as RequestInit);
  console.log(`[API] BINANCE_HTTPS_PROXY=${process.env.BINANCE_HTTPS_PROXY}`);
}

const app = await buildApp({ fetchImpl: proxyFetchImpl });

try {
  await app.listen({
    port,
    host: "0.0.0.0",
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// ── Headless paper-cycle ticker ──────────────────────────────────────────────
// Paper admission + resolution otherwise ONLY runs when the dashboard polls
// /api/shadow/operator-brief. Headless (no dashboard open) that means orders are
// never admitted/resolved, lanes never mature, and the live mirror has nothing to
// fire — the bot looks "frozen" (this bit us: 7 orders stuck PAPER_SUBMITTED for
// 88h). So drive the same endpoint server-side on the scan cadence. The live
// engine already ticks on its own timer. PAPER_AUTO_CYCLE=0 disables.
if (process.env.PAPER_AUTO_CYCLE !== "0") {
  const intervalMin = Math.max(1, Number(process.env.PAPER_AUTO_CYCLE_MINUTES ?? 7));
  const url = `http://127.0.0.1:${port}/api/shadow/operator-brief?paper=1&resolve=1`;
  const tick = (): void => {
    fetch(url).catch((e) => console.warn(`[API] paper-cycle tick failed: ${(e as Error).message}`));
  };
  setTimeout(tick, 60_000); // first run after a scan has populated candidates
  setInterval(tick, intervalMin * 60_000);
  console.log(`[API] PAPER_AUTO_CYCLE on — paper admission+resolution every ${intervalMin}min`);
}

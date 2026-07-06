// MUST be the first import: loads .env before any module evaluates a top-level
// process.env read (ESM imports are hoisted, so an inline dotenv config() placed
// after an app import runs too late — see load-env.ts).
import "./load-env.js";

import { buildApp } from "./app.js";
import { getLaneSymbolCurationCacheStore, refreshLaneSymbolCurationCache } from "./lib/lane-symbol-curation-cache.js";

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
  const timeoutMs = Math.max(5_000, Number(process.env.PAPER_AUTO_CYCLE_TIMEOUT_MS ?? 45_000));
  const url = `http://127.0.0.1:${port}/api/shadow/operator-brief?paper=1&resolve=1&headless=1`;
  let paperCycleInFlight = false;
  const tick = (): void => {
    if (paperCycleInFlight) {
      console.warn("[API] paper-cycle tick skipped: previous tick still running");
      return;
    }
    paperCycleInFlight = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[API] paper-cycle tick returned HTTP ${res.status}`);
        }
      })
      .catch((e) => console.warn(`[API] paper-cycle tick failed: ${(e as Error).message}`))
      .finally(() => {
        clearTimeout(timer);
        paperCycleInFlight = false;
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > timeoutMs * 0.8) {
          console.warn(`[API] paper-cycle tick slow: ${elapsedMs}ms`);
        }
      });
  };
  setTimeout(tick, 60_000); // first run after a scan has populated candidates
  setInterval(tick, intervalMin * 60_000);
  console.log(`[API] PAPER_AUTO_CYCLE on — paper admission+resolution every ${intervalMin}min (timeout ${timeoutMs}ms)`);
}

// ── Lane symbol curation fetch ───────────────────────────────────────────────
// Only meaningful on testnet/live: fetches the diagnostic instance's (mature-book) per-symbol-lane
// edge report on a timer and caches it locally, so the allocator's SYMBOL_NOT_CURATED gate has fresh
// data to judge against. Unset (default) on the diagnostic instance itself — it must keep exploring
// the full symbol universe on every lane, since curation has nothing to compute from otherwise.
if (process.env.LANE_SYMBOL_CURATION_ENABLED === "1") {
  const intervalMin = Math.max(1, Number(process.env.LANE_SYMBOL_CURATION_REFRESH_MINUTES ?? 15));
  const cacheStore = getLaneSymbolCurationCacheStore();
  let refreshInFlight = false;
  const refresh = (): void => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    refreshLaneSymbolCurationCache(cacheStore)
      .then((result) => {
        if (!result.ok) {
          console.warn(`[API] lane-symbol-curation refresh failed: ${result.error}`);
        }
      })
      .finally(() => {
        refreshInFlight = false;
      });
  };
  setTimeout(refresh, 15_000); // first run shortly after boot
  setInterval(refresh, intervalMin * 60_000);
  console.log(`[API] LANE_SYMBOL_CURATION_ENABLED on — refreshing every ${intervalMin}min from ${process.env.LANE_SYMBOL_CURATION_SOURCE_URL ?? "http://localhost:3101/api/shadow/per-symbol-lane-edge"}`);
}

// MUST be the first import: loads .env before any module evaluates a top-level
// process.env read (ESM imports are hoisted, so an inline dotenv config() placed
// after an app import runs too late — see load-env.ts).
import "./load-env.js";

import { buildApp } from "./app.js";
import { getLaneSymbolCurationCacheStore, refreshLaneSymbolCurationCache } from "./lib/lane-symbol-curation-cache.js";
import { createSingleFlightRunner } from "./lib/single-flight-runner.js";

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
  const paperCycle = createSingleFlightRunner(async () => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) console.warn(`[API] paper-cycle tick returned HTTP ${res.status}`);
    } catch (error) {
      console.warn(`[API] paper-cycle tick failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > timeoutMs * 0.8) console.warn(`[API] paper-cycle tick slow: ${elapsedMs}ms`);
    }
  }, {
    onQueued: () => console.warn("[API] paper-cycle tick queued: previous tick still running"),
  });
  // Start the repeating timer only AFTER the warm-up tick. Starting setTimeout(60s) and
  // setInterval(1min) together makes both fire simultaneously on the testnet's 1-minute cadence,
  // immediately queuing a duplicate full resolver run after every restart.
  setTimeout(() => {
    paperCycle.tick(); // first run after a scan has populated candidates
    setInterval(paperCycle.tick, intervalMin * 60_000);
  }, 60_000);
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

// ── Wallet reconciliation ticker (report-only) ───────────────────────────────
// Periodically compares the live-execution engine's internal realized-P&L ledger against
// Binance's own /fapi/v1/income for the current UTC day (see lib/wallet-reconciliation.ts for the
// full comparison logic and safety rationale). HARD RULE: on a mismatch beyond tolerance this
// ONLY logs a warning — it must never pause trading, disarm, or take any corrective action. No
// smaller than the live engine's own status; purely an early-warning log line for the operator.
if (process.env.WALLET_RECONCILIATION_ENABLED === "1") {
  const intervalMin = Math.max(1, Number(process.env.WALLET_RECONCILIATION_INTERVAL_MINUTES ?? 30));
  const timeoutMs = Math.max(5_000, Number(process.env.WALLET_RECONCILIATION_TIMEOUT_MS ?? 15_000));
  const url = `http://127.0.0.1:${port}/api/live/wallet-reconciliation`;
  const reconciliation = createSingleFlightRunner(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.warn(`[API] wallet-reconciliation tick returned HTTP ${res.status}`);
        return;
      }
      const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          report?: {
            dayUtc?: string;
            deltaUsd?: number;
            toleranceUsd?: number;
            withinTolerance?: boolean;
            internalLedgerFresh?: boolean;
            note?: string | null;
          };
      } | null;
      if (body?.ok && body.report && body.report.withinTolerance === false) {
        const delta = body.report.deltaUsd ?? 0;
        console.warn(
          `[API] WALLET RECONCILIATION MISMATCH day=${body.report.dayUtc} delta=$${delta.toFixed(2)} ` +
            `exceeds tolerance $${body.report.toleranceUsd} — internal ledger vs Binance income history ` +
            `disagree. Report-only: no trading action taken; investigate manually.`,
        );
      } else if (body?.ok && body.report && body.report.internalLedgerFresh === false) {
        // withinTolerance is forced true here (no comparison was actually made — see
        // wallet-reconciliation.ts) — must NOT be logged (or silently skipped) identically to a
        // genuinely verified healthy day, or an operator loses the one signal that today's tick
        // proved nothing.
        console.warn(
          `[API] wallet reconciliation NOT VERIFIED day=${body.report.dayUtc}: ${body.report.note ?? "internal ledger day mismatch"}`,
        );
      }
    } catch (error) {
      console.warn(`[API] wallet-reconciliation tick failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }, {
    onQueued: () => console.warn("[API] wallet-reconciliation tick queued: previous tick still running"),
  });
  setTimeout(reconciliation.tick, 90_000); // first run well after boot, once the engine + ledger are warm
  setInterval(reconciliation.tick, intervalMin * 60_000);
  console.log(`[API] WALLET_RECONCILIATION_ENABLED on — checking every ${intervalMin}min (timeout ${timeoutMs}ms)`);
}

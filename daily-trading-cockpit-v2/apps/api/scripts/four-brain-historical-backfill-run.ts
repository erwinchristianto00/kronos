/**
 * Four-Brain HISTORICAL BACKFILL warm-start — operator-run CLI entry point (Track 1, 2026-07-23).
 *
 * Wires the pure harness (src/lib/four-brain-historical-backfill.ts) to REAL I/O: the four-brain decision
 * journal on disk, the archived Jan–Jun 2026 BTC/ETH candle CSVs, position-path-recorder.ts's real closed
 * paths, and direction-entry-outcome-store.ts's real persisted store. This is the ONLY place in Track 1
 * that touches the filesystem — every actual resolution rule lives in the harness, unchanged from (or a
 * thin per-row mirror of) the live direction-entry-reconciler.ts.
 *
 * TRIGGER: manual only. `npx tsx scripts/four-brain-historical-backfill-run.ts [--data-dir <dir>]
 * [--klines-dir <dir>] [--dry-run] [--now <ms>]`. Deliberately NOT a boot-time step and NOT an HTTP route
 * — a journal/CSV batch scan is slow, and re-triggerable-by-accident risk (curl, a dashboard button, a
 * process restart) is real; a script the operator runs by hand is strictly safer and simplest. Safe to
 * re-run: every store write is idempotent per decisionId (see writeBackfillResults's own doc).
 *
 * INSTANCE SAFETY: refuses to run at all unless fourBrainInstanceAllowed(process.env) — the EXACT SAME
 * gate (import, not reimplementation) every other four-brain-only feature in this codebase uses to
 * hard-exclude the live/mainnet (3103) instance regardless of any other env. This script has no PORT of
 * its own (it is not a server process), so by default it resolves to the safe research instance id — the
 * gate only actually trips if an operator explicitly sets PORT=3103 or FOUR_BRAIN_INSTANCE_ID=3103 in the
 * invoking shell (e.g. a copy-pasted live-box command), which is exactly the scenario this defense-in-depth
 * is for. NEVER point --data-dir at the live (3103) data directory — this script does not (and, per the
 * design spec, must not) attempt to infer that from the path itself; the env gate is the actual defense.
 *
 * KNOWN SCOPE LIMITS: see src/lib/four-brain-historical-backfill.ts's own doc comment (BTC/ETH-only
 * archive, Jan–Jun 2026, ~26-day journal retention). Nothing here fabricates a result outside those bounds.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseKlines } from "../src/lib/replay-tier-a-core.js";
import type { PathCandle } from "../src/lib/entry-exit-counterfactual.js";
import { BinanceClient } from "../src/lib/binance.js";
import {
  fourBrainInstanceAllowed,
  resolveFourBrainInstanceId,
} from "../src/lib/four-brain-live-gather-bindings.js";
import {
  scanJournalForBackfillRows,
  runHistoricalBackfillOverRows,
  writeBackfillResults,
  FOUR_BRAIN_DECISION_JOURNAL_FILE,
} from "../src/lib/four-brain-historical-backfill.js";
import { ENTRY_TIER2_HORIZON_BARS, ENTRY_TIER2_WAIT_WINDOW_BARS } from "../src/lib/entry-brain-tier2-simulated-resolver.js";
import { getPositionPathRecorder } from "../src/lib/position-path-recorder.js";
import { getDirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";

const ARCHIVE_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
const ARCHIVE_MONTHS = ["01", "02", "03", "04", "05", "06"] as const; // Jan–Jun 2026 — see module doc
const TIER2_FETCH_BARS = ENTRY_TIER2_HORIZON_BARS + ENTRY_TIER2_WAIT_WINDOW_BARS + 1;

interface Args {
  dataDir: string;
  klinesDir: string;
  dryRun: boolean;
  nowMs: number;
}

function parseArgs(argv: string[]): Args {
  let dataDir = "data";
  let klinesDir = "artifacts/simulation/data/extracted";
  let dryRun = false;
  let nowMs = Date.now();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--data-dir") dataDir = argv[++i] ?? dataDir;
    else if (a === "--klines-dir") klinesDir = argv[++i] ?? klinesDir;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--now") {
      const raw = argv[++i];
      const parsed = raw ? Date.parse(raw) : NaN;
      const asMs = raw && /^\d+$/.test(raw) ? Number(raw) : parsed;
      if (Number.isFinite(asMs)) nowMs = asMs;
    }
  }
  return { dataDir, klinesDir, dryRun, nowMs };
}

function readJournalLines(dataDir: string): string[] {
  const current = join(dataDir, FOUR_BRAIN_DECISION_JOURNAL_FILE);
  const rotated = `${current}.1`;
  const lines: string[] = [];
  for (const file of [rotated, current]) {
    // rotated first: preserves overall chronological order for readability (dedup makes the exact order
    // immaterial to correctness — see scanJournalForBackfillRows's own dedup-by-decisionId doc).
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    lines.push(...text.split("\n"));
  }
  return lines;
}

/** Load + concatenate every available monthly CSV for one symbol/timeframe subtree, sorted ascending by
 *  openTime. A missing monthly file (outside the archive's actual coverage) contributes nothing — never
 *  fails the whole load (mirrors scripts/replay-tier-a-6mo-run.ts's own existsSync-guarded fallback). */
function loadArchivedCandles(klinesDir: string, timeframeDirName: "klines_1h" | "klines_15m", timeframeLabel: "1h" | "15m", symbol: string) {
  const all = ARCHIVE_MONTHS.flatMap((month) => {
    const p = join(
      klinesDir,
      timeframeDirName,
      symbol,
      timeframeLabel,
      `${symbol}-${timeframeLabel}-2026-${month}`,
      `${symbol}-${timeframeLabel}-2026-${month}.csv`,
    );
    return existsSync(p) ? parseKlines(readFileSync(p, "utf-8")) : [];
  });
  return all.sort((a, b) => a.openTime - b.openTime);
}

/** 2026-07-23 fix: the archive above is a static Jan–Jun 2026 snapshot from an unrelated 6-month research
 *  arc — it predates the four-brain journal's ACTUAL decision history entirely (four-brain shadow mode was
 *  only deployed 2026-07-13, and the journal itself only retains its most recent ~1-2 days once rotation is
 *  accounted for). Verified live on testnet: with only the archive, every real pending row resolved to
 *  INSTRUMENT_DATA_MISSING or PENDING — zero actual RESOLVED outcomes, defeating Track 1's whole purpose.
 *  Binance's public REST klines endpoint (BinanceClient.getCandles, no auth needed) serves this SAME kind
 *  of already-elapsed real market history for ANY past window on demand — no local archive required at
 *  all for the journal's actual (recent, narrow) date range. Fetched ONCE per run, merged with whatever
 *  archived rows exist (harmless — the two date ranges don't overlap today, and if they ever did, dedup by
 *  openTime keeps the freshest source last). Never touches order placement — this is the exact same public,
 *  no-auth klines endpoint the live reconciler and every replay/backtest tool in this codebase already use.
 *  Best-effort: a network failure here degrades to archive-only coverage (already-handled INSTRUMENT_DATA_MISSING
 *  path), never a crash. */
async function fetchLiveCandles(
  client: BinanceClient,
  symbol: string,
  interval: "1h" | "15m",
  startTimeMs: number,
  endTimeMs: number,
): Promise<PathCandle[]> {
  try {
    const candles = await client.getCandles(symbol, interval, 1500, { startTime: startTimeMs, endTime: endTimeMs });
    return candles.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close }));
  } catch (err) {
    console.error(`[four-brain-historical-backfill] live candle fetch failed for ${symbol} ${interval} (falling back to archive only): ${String(err)}`);
    return [];
  }
}

function mergeCandlesDedupByOpenTime(archived: PathCandle[], live: PathCandle[]): PathCandle[] {
  const byOpenTime = new Map<number, PathCandle>();
  for (const c of archived) byOpenTime.set(c.openTime, c);
  for (const c of live) byOpenTime.set(c.openTime, c); // live wins on overlap — freshest source
  return Array.from(byOpenTime.values()).sort((a, b) => a.openTime - b.openTime);
}

/** Earliest asOfMs across every pending row — the start of the window we actually need candles for.
 *  Returns null when there is nothing to backfill (caller already exits before this point in that case,
 *  but keeping this pure and total avoids a throw on an empty scan). */
function earliestAsOfMs(scan: { directionRows: Array<{ asOfMs: number }>; entryRows: Array<{ asOfMs: number }> }): number | null {
  const all = [...scan.directionRows.map((r) => r.asOfMs), ...scan.entryRows.map((r) => r.asOfMs)];
  return all.length > 0 ? Math.min(...all) : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── Instance safety gate (see module doc) — the EXACT SAME check every other four-brain-only feature
  // in this codebase uses. Never relaxed, never bypassed, never reimplemented locally.
  if (!fourBrainInstanceAllowed(process.env)) {
    console.error(
      `[four-brain-historical-backfill] REFUSING TO RUN: fourBrainInstanceAllowed(process.env) is false ` +
        `for resolved instance id "${resolveFourBrainInstanceId(process.env)}" (PORT=${process.env.PORT ?? "unset"}). ` +
        `This is the live/mainnet hard-block — it never opens for 3103 regardless of any other flag. ` +
        `Re-run with an unset PORT, or PORT/FOUR_BRAIN_INSTANCE_ID set to an allowlisted research/testnet id.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[four-brain-historical-backfill] instance=${resolveFourBrainInstanceId(process.env)} dataDir=${args.dataDir} ` +
      `klinesDir=${args.klinesDir} dryRun=${args.dryRun} nowMs=${args.nowMs} (${new Date(args.nowMs).toISOString()})`,
  );

  // ── Journal scan ──
  const lines = readJournalLines(args.dataDir);
  const scan = scanJournalForBackfillRows(lines);
  console.log(
    `[four-brain-historical-backfill] journal scan: scannedLines=${scan.scannedLines} parsedRecords=${scan.parsedRecords} ` +
      `badLines=${scan.badLines} skippedNonExecutiveDecision=${scan.skippedNonExecutiveDecision} ` +
      `directionRows=${scan.directionRows.length} entryRows=${scan.entryRows.length}`,
  );
  if (scan.directionRows.length === 0 && scan.entryRows.length === 0) {
    console.log("[four-brain-historical-backfill] nothing to backfill (no pending rows found in the journal) — exiting.");
    return;
  }

  // ── Archived candles (Jan-Jun 2026 static snapshot — see loadArchivedCandles' own doc) ──
  const archivedBtc1h = loadArchivedCandles(args.klinesDir, "klines_1h", "1h", "BTCUSDT");
  const archivedTier2BySymbol = new Map<string, ReturnType<typeof loadArchivedCandles>>();
  for (const symbol of ARCHIVE_SYMBOLS) {
    archivedTier2BySymbol.set(symbol, loadArchivedCandles(args.klinesDir, "klines_15m", "15m", symbol));
  }

  // ── Live-fetched candles (see fetchLiveCandles' own doc — covers the journal's ACTUAL date range,
  // which the static archive above does not) ──
  const earliest = earliestAsOfMs(scan);
  const binanceClient = new BinanceClient();
  let liveBtc1h: PathCandle[] = [];
  const liveTier2BySymbol = new Map<string, PathCandle[]>();
  if (earliest !== null) {
    // Buffer BEFORE the earliest decision, extended to nowMs (the furthest any horizon could need —
    // resolveDirectionOutcome/resolveEntryTier2Row already refuse to resolve past their own targetExitMs
    // vs nowMs, so fetching up to nowMs never enables a lookahead). 2026-07-23 fix: the buffer was
    // originally 24h (indicator warm-up slack only) — too narrow. direction-brain-resolver.ts's own
    // hasHourlyGap check requires a GAP-FREE 168h (GAP_LOOKBACK_BARS, 7d) window immediately before each
    // entry candle; with only 24h of pre-decision candles, every direction row's 7-day lookback window
    // extended past the start of the fetched data and read as "has a gap" — INSTRUMENT_DATA_MISSING on
    // 100% of direction rows even with live candles present. 9 days (168h + 1 day slack) covers it.
    const startTimeMs = earliest - 9 * 24 * 3_600_000;
    liveBtc1h = await fetchLiveCandles(binanceClient, "BTCUSDT", "1h", startTimeMs, args.nowMs);
    for (const symbol of ARCHIVE_SYMBOLS) {
      liveTier2BySymbol.set(symbol, await fetchLiveCandles(binanceClient, symbol, "15m", startTimeMs, args.nowMs));
    }
  }

  const btcCandles = mergeCandlesDedupByOpenTime(archivedBtc1h, liveBtc1h);
  const tier2CandlesBySymbol = new Map<string, PathCandle[]>();
  for (const symbol of ARCHIVE_SYMBOLS) {
    tier2CandlesBySymbol.set(symbol, mergeCandlesDedupByOpenTime(archivedTier2BySymbol.get(symbol) ?? [], liveTier2BySymbol.get(symbol) ?? []));
  }
  console.log(
    `[four-brain-historical-backfill] candles (archived+live merged): BTCUSDT-1h=${btcCandles.length} bars ` +
      `(archived=${archivedBtc1h.length}, live=${liveBtc1h.length}); ` +
      ARCHIVE_SYMBOLS.map((s) => `${s}-15m=${tier2CandlesBySymbol.get(s)?.length ?? 0} (archived=${archivedTier2BySymbol.get(s)?.length ?? 0}, live=${liveTier2BySymbol.get(s)?.length ?? 0})`).join(", "),
  );

  /** Per-symbol archived 15m candle lookup: the first archived candle with openTime >= asOfMs (mirrors
   *  Binance's own startTime-inclusive semantics — the SAME contract the live reconciler's real
   *  binanceClient.getCandles(..., { startTime }) fulfills), sliced to TIER2_FETCH_BARS. Only BTCUSDT/
   *  ETHUSDT have archive coverage at all (see module doc's known scope limits) — any other symbol
   *  returns null, never a fabricated candle path. */
  function fetchTier2Candles(symbolOrBasketId: string, asOfMs: number): PathCandle[] | null {
    const candles = tier2CandlesBySymbol.get(symbolOrBasketId);
    if (!candles || candles.length === 0) return null;
    const startIdx = candles.findIndex((c) => c.openTime >= asOfMs);
    if (startIdx < 0) return null;
    const slice = candles.slice(startIdx, startIdx + TIER2_FETCH_BARS);
    return slice.length > 0 ? slice : null;
  }

  // ── Real stores ──
  const positionPathRecorder = getPositionPathRecorder(args.dataDir);
  const closedPositionPaths = positionPathRecorder.listClosedPaths();
  const store = getDirectionEntryOutcomeStore(args.dataDir);

  const results = runHistoricalBackfillOverRows(scan, {
    btcCandles,
    closedPositionPaths,
    fetchTier2Candles,
    isCloseAlreadyClaimed: (closeKey) => store.hasClaimedTier1CloseKey(closeKey),
    nowMs: args.nowMs,
  });

  const directionStatusCounts = new Map<string, number>();
  for (const { outcome } of results.direction) {
    directionStatusCounts.set(outcome.status, (directionStatusCounts.get(outcome.status) ?? 0) + 1);
  }
  const entryStatusCounts = new Map<string, number>();
  for (const { resolution } of results.entry) {
    entryStatusCounts.set(resolution.status, (entryStatusCounts.get(resolution.status) ?? 0) + 1);
  }
  console.log(`[four-brain-historical-backfill] direction resolution: ${JSON.stringify(Object.fromEntries(directionStatusCounts))}`);
  console.log(`[four-brain-historical-backfill] entry resolution: ${JSON.stringify(Object.fromEntries(entryStatusCounts))}`);

  if (args.dryRun) {
    console.log("[four-brain-historical-backfill] --dry-run: not writing to the store. Re-run without --dry-run to persist.");
    return;
  }

  const summary = writeBackfillResults(store, results);
  console.log(`[four-brain-historical-backfill] write summary: ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error("[four-brain-historical-backfill] fatal error", err);
  process.exitCode = 1;
});

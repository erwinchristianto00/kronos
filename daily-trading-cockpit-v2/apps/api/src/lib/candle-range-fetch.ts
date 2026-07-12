/**
 * Shared paginated 5m candle-range fetch helper.
 *
 * EXTRACTED (not rewritten — byte-for-byte identical logic) from
 * apps/api/scripts/backfill-cg-wide-fast-long-mfe.ts's local `fetchCandlesRange`, which is not
 * exported (that file's `main()` runs unconditionally at import time, so importing anything from it
 * directly would trigger a full, network-heavy backfill run as a side effect — see that script's own
 * doc comment on why it extended rather than added a sibling script for the same reason). Pulling
 * this one already-validated, side-effect-free helper into its own pure-ish module (no LiveIntent/
 * store/classification knowledge — just "given a BinanceClient, page through 5m candles for a
 * window") lets BOTH that script and the new hour/session-interaction study
 * (cg-wide-fast-long-hour-session-study.ts, operator research brief Task 4, 2026-07-10) call the
 * IDENTICAL implementation, per that Task 4 brief's explicit instruction: "reuse the same
 * candle-fetch helper Task 2 used, do not build a new one."
 *
 * The backfill script now imports fetchCandlesRange from here instead of defining it locally —
 * a behavior-preserving refactor verified by the full apps/api vitest suite + tsc gate.
 */
import type { Candle } from "@dtc/shared";
import type { BinanceClient } from "./binance.js";

export const CANDLE_MS_5M = 5 * 60 * 1000;

/** Paginated candle fetch — a single trade can span more than Binance's 1000-candle cap on a 5m
 *  interval (~3.5 days). Pages defensively rather than silently truncating long windows. */
export async function fetchCandlesRange(
  binance: BinanceClient,
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  let guard = 0;
  while (cursor < endTime && guard < 50) {
    guard += 1;
    const remaining = Math.ceil((endTime - cursor) / CANDLE_MS_5M) + 2;
    const limit = Math.min(Math.max(remaining, 12), 1000);
    const page = await binance.getCandles(symbol, "5m", limit, { startTime: cursor, endTime });
    if (page.length === 0) break;
    out.push(...page);
    const lastOpen = page[page.length - 1]!.openTime;
    if (lastOpen + CANDLE_MS_5M <= cursor) break; // no forward progress — avoid infinite loop
    cursor = lastOpen + CANDLE_MS_5M;
    if (page.length < limit) break; // exchange returned less than asked — nothing more available
  }
  const seen = new Set<number>();
  const dedup: Candle[] = [];
  for (const c of out) {
    if (seen.has(c.openTime)) continue;
    seen.add(c.openTime);
    dedup.push(c);
  }
  dedup.sort((a, b) => a.openTime - b.openTime);
  return dedup;
}

/**
 * Cross-instance cache for per-lane symbol curation (2026-07-06).
 *
 * Testnet and live don't have enough of their own trade volume to judge per-symbol edge quickly
 * (live: a handful of trades/day; the diagnostic instance / has the mature book — 848 closed on
 * CG_WIDE_FAST_SHORT alone). So instead of each instance computing its own thin, slow-to-mature
 * curation, testnet/live periodically FETCH the diagnostic instance's /api/shadow/per-symbol-lane-edge
 * report (same box, localhost) and cache it here. getCuratedSymbolsForLane() (per-symbol-lane-book-edge.ts)
 * reads this cache to decide, per lane, which symbols currently qualify — auto-rotating as fresh data
 * regenerates the source report.
 *
 * Fail-closed by staleness, not by absence: a missing/old cache means "no curation verdict available"
 * (curated: null), which callers treat as "fall back to this lane's normal, uncurated admission" — it
 * can never silently empty out a lane's symbol universe just because the fetch hiccupped once.
 *
 * The diagnostic instance itself (/) never runs this fetch (LANE_SYMBOL_CURATION_ENABLED unset there)
 * — it must keep admitting the full symbol universe on every lane, or curation would have no fresh
 * data to compute from in the first place.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PerSymbolLaneBookEdgeReport } from "./per-symbol-lane-book-edge.js";

export interface LaneSymbolCurationCacheState {
  report: PerSymbolLaneBookEdgeReport | null;
  /** generatedAt from the source report (used for staleness, not the local fetch time). */
  fetchedAt: string | null;
  lastFetchError: string | null;
}

const EMPTY_STATE: LaneSymbolCurationCacheState = { report: null, fetchedAt: null, lastFetchError: null };

export class LaneSymbolCurationCacheStore {
  private readonly file: string;
  private state: LaneSymbolCurationCacheState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "lane-symbol-curation-cache.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): LaneSymbolCurationCacheState {
    try {
      if (!existsSync(this.file)) return { ...EMPTY_STATE };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object") {
        return {
          report: (parsed.report ?? null) as PerSymbolLaneBookEdgeReport | null,
          fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
          lastFetchError: typeof parsed.lastFetchError === "string" ? parsed.lastFetchError : null,
        };
      }
    } catch {
      // corrupt/partial file — fall through to empty (equivalent to "no cache yet")
    }
    return { ...EMPTY_STATE };
  }

  get(): LaneSymbolCurationCacheState {
    return this.state;
  }

  set(report: PerSymbolLaneBookEdgeReport, fetchedAt: string): void {
    this.state = { report, fetchedAt, lastFetchError: null };
    this._save();
  }

  setError(message: string): void {
    // Keep the last GOOD report/fetchedAt (staleness check will naturally expire it if the
    // failure persists) — only record the error for observability.
    this.state = { ...this.state, lastFetchError: message };
    this._save();
  }

  private _save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // cache-persistence failures must never affect the app
    }
  }
}

let singleton: LaneSymbolCurationCacheStore | null = null;
export function getLaneSymbolCurationCacheStore(): LaneSymbolCurationCacheStore {
  if (!singleton) singleton = new LaneSymbolCurationCacheStore();
  return singleton;
}

export function _resetLaneSymbolCurationCacheStoreForTests(): void {
  singleton = null;
}

export interface RefreshLaneSymbolCurationOptions {
  sourceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches the source report and updates the cache. Never throws — a failed fetch just records
 * the error and leaves the previous (possibly still-fresh) cached report in place, so a single
 * network hiccup can't cause the staleness check to trip early via a state we mutated ourselves.
 */
export async function refreshLaneSymbolCurationCache(
  store: LaneSymbolCurationCacheStore,
  opts: RefreshLaneSymbolCurationOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const sourceUrl = opts.sourceUrl ?? process.env.LANE_SYMBOL_CURATION_SOURCE_URL ?? "http://localhost:3101/api/shadow/per-symbol-lane-edge";
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(sourceUrl, { signal: controller.signal });
    if (!res.ok) {
      const message = `HTTP ${res.status}`;
      store.setError(message);
      return { ok: false, error: message };
    }
    const body = (await res.json()) as PerSymbolLaneBookEdgeReport & { generatedAt?: string };
    if (!body || !Array.isArray(body.cells) || typeof body.generatedAt !== "string") {
      const message = "malformed response body";
      store.setError(message);
      return { ok: false, error: message };
    }
    const { generatedAt, ...report } = body;
    store.set(report as PerSymbolLaneBookEdgeReport, generatedAt);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.setError(message);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

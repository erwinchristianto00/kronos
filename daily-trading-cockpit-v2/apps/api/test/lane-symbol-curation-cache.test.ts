import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LaneSymbolCurationCacheStore,
  refreshLaneSymbolCurationCache,
} from "../src/lib/lane-symbol-curation-cache.js";
import type { PerSymbolLaneBookEdgeReport } from "../src/lib/per-symbol-lane-book-edge.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lane-symbol-curation-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const SAMPLE_REPORT: PerSymbolLaneBookEdgeReport = {
  minClosed: 40,
  minHeadlineClosed: 20,
  posMinAvgR: 0.03,
  negMaxAvgR: -0.03,
  cells: [],
  bestLanePerSymbol: [],
  summary: {
    measuredCells: 0,
    bookPositiveCells: 0,
    promotableCells: 0,
    testnetCandidateCells: 0,
    byDirection: {
      LONG: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
      SHORT: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
      MIXED: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
    },
    symbolsMeasured: 0,
    symbolsTestnetCandidate: 0,
    symbolsPromotable: 0,
  },
};

function fakeFetchOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ generatedAt: "2026-07-06T12:00:00.000Z", ...SAMPLE_REPORT }), {
      status: 200,
    })) as unknown as typeof fetch;
}

function fakeFetchHttpError(status: number): typeof fetch {
  return (async () => new Response("nope", { status })) as unknown as typeof fetch;
}

function fakeFetchThrows(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function fakeFetchMalformed(): typeof fetch {
  return (async () => new Response(JSON.stringify({ foo: "bar" }), { status: 200 })) as unknown as typeof fetch;
}

describe("LaneSymbolCurationCacheStore", () => {
  it("starts empty when no file exists yet", () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    expect(store.get()).toEqual({ report: null, fetchedAt: null, lastFetchError: null });
  });

  it("persists set() and reloads it from disk", () => {
    const dir = tmpDir();
    const store = new LaneSymbolCurationCacheStore(dir);
    store.set(SAMPLE_REPORT, "2026-07-06T12:00:00.000Z");
    const reloaded = new LaneSymbolCurationCacheStore(dir);
    expect(reloaded.get().fetchedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(reloaded.get().report?.minClosed).toBe(40);
  });

  it("setError keeps the previous good report/fetchedAt in place", () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    store.set(SAMPLE_REPORT, "2026-07-06T12:00:00.000Z");
    store.setError("boom");
    const state = store.get();
    expect(state.fetchedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(state.report).not.toBeNull();
    expect(state.lastFetchError).toBe("boom");
  });
});

describe("refreshLaneSymbolCurationCache", () => {
  it("on success, stores the report and generatedAt from the response body", async () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    const result = await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchOk() });
    expect(result.ok).toBe(true);
    expect(store.get().fetchedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(store.get().report?.minClosed).toBe(40);
  });

  it("on HTTP error, records the error and leaves report untouched", async () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    const result = await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchHttpError(503) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
    expect(store.get().report).toBeNull();
  });

  it("on thrown/network error, never throws — records the error instead", async () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    const result = await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchThrows("ECONNREFUSED") });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("on malformed response body, records an error instead of caching garbage", async () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    const result = await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchMalformed() });
    expect(result.ok).toBe(false);
    expect(store.get().report).toBeNull();
  });

  it("a failed refresh does not overwrite a previously-good cached report", async () => {
    const store = new LaneSymbolCurationCacheStore(tmpDir());
    await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchOk() });
    await refreshLaneSymbolCurationCache(store, { fetchImpl: fakeFetchThrows("timeout") });
    expect(store.get().report?.minClosed).toBe(40);
    expect(store.get().fetchedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(store.get().lastFetchError).toBe("timeout");
  });
});

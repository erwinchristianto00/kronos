import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  computeConflictIntensity,
  fetchRecentConflictEvents,
  filterToConflictKeywords,
  isHighSeverityCameo,
  isMassViolenceCameo,
  cameoRoot,
  GeopoliticalConflictFeedStore,
  runGeopoliticalConflictFeedCycle,
  runGeopoliticalConflictFeedCycleGuarded,
  buildConflictFeedReport,
  GEOPOLITICAL_FEED_MAX_STORED_EVENTS,
  GEOPOLITICAL_FEED_MAX_AGE_MS,
  DEFAULT_CONFLICT_KEYWORDS,
  type GdeltEvent,
} from "../src/lib/geopolitical-conflict-feed.js";

const DAY_MS = 24 * 3_600_000;
const BASE = 1_700_000_000_000;

function ev(overrides: Partial<GdeltEvent> = {}): GdeltEvent {
  return {
    id: `evt-${Math.random()}`,
    dateMs: BASE,
    cameoCode: "010",
    goldsteinScale: 1,
    actor1: "IRAN",
    actor2: "ISRAEL",
    sourceUrl: "https://example.com/a",
    title: "Iran Israel statement",
    numMentions: 3,
    isHighSeverity: false,
    ...overrides,
  };
}

function tmpStorePath(tag: string): string {
  return `${tmpdir()}/gcf-${tag}-${Date.now()}-${Math.random()}.json`;
}

// Minimal fetch-Response mock, matching the shape fetchRecentConflictEvents reads (ok/status/json).
function mockResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

// ── CAMEO taxonomy ────────────────────────────────────────────────────────

describe("cameoRoot / isHighSeverityCameo / isMassViolenceCameo", () => {
  it("parses the root category from 2-4 digit CAMEO codes", () => {
    expect(cameoRoot("010")).toBe(1);
    expect(cameoRoot("193")).toBe(19);
    expect(cameoRoot("20")).toBe(20);
    expect(cameoRoot("2041")).toBe(20);
  });

  it("returns null for unparseable codes", () => {
    expect(cameoRoot("")).toBeNull();
    expect(cameoRoot("abc")).toBeNull();
    expect(cameoRoot("1")).toBeNull();
    expect(cameoRoot("123456")).toBeNull();
  });

  it("classifies verbal-conflict (09-16) and material-conflict (17-20) roots as high severity", () => {
    expect(isHighSeverityCameo("090")).toBe(true); // root 9, boundary
    expect(isHighSeverityCameo("160")).toBe(true); // root 16, boundary
    expect(isHighSeverityCameo("170")).toBe(true); // root 17
    expect(isHighSeverityCameo("200")).toBe(true); // root 20, boundary
    expect(isHighSeverityCameo("204")).toBe(true); // root 20 (4-digit code)
  });

  it("does NOT classify cooperation/statement roots (01-08) as high severity", () => {
    expect(isHighSeverityCameo("010")).toBe(false);
    expect(isHighSeverityCameo("080")).toBe(false);
  });

  it("classifies only roots 19-20 as mass violence (the '190-200 range')", () => {
    expect(isMassViolenceCameo("180")).toBe(false); // root 18 ASSAULT — high severity but not mass violence
    expect(isMassViolenceCameo("190")).toBe(true);
    expect(isMassViolenceCameo("196")).toBe(true);
    expect(isMassViolenceCameo("200")).toBe(true);
    expect(isMassViolenceCameo("204")).toBe(true);
  });
});

// ── computeConflictIntensity (pure) ─────────────────────────────────────────

describe("computeConflictIntensity", () => {
  it("returns null meanGoldstein (never 0) on an empty window", () => {
    const result = computeConflictIntensity([], BASE, DAY_MS);
    expect(result).toEqual({ eventCount: 0, meanGoldstein: null, highSeverityCount: 0, windowMs: DAY_MS });
  });

  it("returns null meanGoldstein when events exist but none carry a Goldstein score", () => {
    const events = [ev({ dateMs: BASE, goldsteinScale: null }), ev({ dateMs: BASE - 1000, goldsteinScale: null })];
    const result = computeConflictIntensity(events, BASE, DAY_MS);
    expect(result.eventCount).toBe(2);
    expect(result.meanGoldstein).toBeNull();
  });

  it("counts high vs low severity correctly and computes mean Goldstein only over scored events", () => {
    const events = [
      ev({ dateMs: BASE, cameoCode: "010", goldsteinScale: 2, isHighSeverity: isHighSeverityCameo("010") }), // low severity
      ev({ dateMs: BASE - 1000, cameoCode: "193", goldsteinScale: -8, isHighSeverity: isHighSeverityCameo("193") }), // high severity
      ev({ dateMs: BASE - 2000, cameoCode: "204", goldsteinScale: -10, isHighSeverity: isHighSeverityCameo("204") }), // high severity
      ev({ dateMs: BASE - 3000, cameoCode: "057", goldsteinScale: null, isHighSeverity: isHighSeverityCameo("057") }), // low severity, no score
    ];
    const result = computeConflictIntensity(events, BASE, DAY_MS);
    expect(result.eventCount).toBe(4);
    expect(result.highSeverityCount).toBe(2);
    // mean over the 3 scored events: (2 + -8 + -10) / 3
    expect(result.meanGoldstein).toBeCloseTo((2 - 8 - 10) / 3, 10);
  });

  it("includes events exactly at both window boundaries (inclusive-inclusive)", () => {
    const windowMs = 10_000;
    const events = [
      ev({ id: "at-start", dateMs: BASE - windowMs }), // exactly at start — INCLUDED
      ev({ id: "at-end", dateMs: BASE }), // exactly at now — INCLUDED
      ev({ id: "just-before-start", dateMs: BASE - windowMs - 1 }), // EXCLUDED
      ev({ id: "just-after-end", dateMs: BASE + 1 }), // EXCLUDED
    ];
    const result = computeConflictIntensity(events, BASE, windowMs);
    expect(result.eventCount).toBe(2);
  });

  it("never mutates the windowMs echoed back", () => {
    const result = computeConflictIntensity([], BASE, 12_345);
    expect(result.windowMs).toBe(12_345);
  });
});

// ── filterToConflictKeywords (pure) ─────────────────────────────────────────

describe("filterToConflictKeywords", () => {
  it("keeps events mentioning a scope keyword and drops unrelated ones", () => {
    const events = [
      ev({ id: "iran-hit", actor1: "IRAN", title: "Iran strike reported" }),
      ev({ id: "unrelated", actor1: "FRANCE", actor2: "GERMANY", title: "Trade talks continue", sourceUrl: "https://x/y" }),
    ];
    const filtered = filterToConflictKeywords(events, DEFAULT_CONFLICT_KEYWORDS);
    expect(filtered.map((e) => e.id)).toEqual(["iran-hit"]);
  });
});

// ── fetchRecentConflictEvents (I/O, fail-open) ──────────────────────────────

describe("fetchRecentConflictEvents", () => {
  it("fails open (empty array, structured error) when fetchImpl throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.events).toEqual([]);
    expect(result.error).toBe("gdelt api request failed");
  });

  it("fails open with a timeout-specific reason when the request aborts", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl, timeoutMs: 5 });
    expect(result.events).toEqual([]);
    expect(result.error).toBe("gdelt api request timed out");
  });

  it("fails open when the response is not ok", async () => {
    const fetchImpl = (async () => mockResponse({}, { ok: false, status: 503 })) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.events).toEqual([]);
    expect(result.error).toBe("gdelt api returned HTTP 503");
  });

  it("fails open when res.json() throws (invalid JSON)", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.events).toEqual([]);
    expect(result.error).toBe("invalid JSON response");
  });

  it("fails open when the JSON shape is unrecognized", async () => {
    const fetchImpl = (async () => mockResponse({ nonsense: 1 })) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.events).toEqual([]);
    expect(result.error).toBe("unrecognized response shape");
  });

  it("parses a valid GDELT-shaped payload, drops records missing required fields, and applies the keyword filter", async () => {
    const payload = {
      events: [
        {
          GLOBALEVENTID: 123,
          SQLDATE: "20260722",
          EventCode: "190",
          GoldsteinScale: -9.0,
          Actor1Name: "IRAN",
          Actor2Name: "ISRAEL",
          SOURCEURL: "https://news.example/1",
          NumMentions: 12,
        },
        {
          // missing EventCode entirely — must be dropped, not defaulted.
          GLOBALEVENTID: 124,
          SQLDATE: "20260722",
          Actor1Name: "IRAN",
        },
        {
          GLOBALEVENTID: 125,
          SQLDATE: "20260721",
          EventCode: "010",
          Actor1Name: "FRANCE",
          Actor2Name: "GERMANY",
          SOURCEURL: "https://news.example/3",
        },
      ],
    };
    const fetchImpl = (async () => mockResponse(payload)) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.error).toBeNull();
    // record 124 dropped (no CAMEO code), record 125 dropped (keyword filter — France/Germany).
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe("123");
    expect(result.events[0]!.cameoCode).toBe("190");
    expect(result.events[0]!.goldsteinScale).toBe(-9.0);
    expect(result.events[0]!.isHighSeverity).toBe(true);
  });

  it("[REGRESSION 2026-07-22] drops a record whose EventCode arrives as a JSON number, instead of silently misreading its root", async () => {
    // "010" (root 01, verbal cooperation — not high severity) serialized as the number 10 would
    // read back as String(10) = "10", and cameoRoot("10") = 10, which IS in the 9-20 conflict band
    // — a cooperative event would get silently flagged isHighSeverity: true. Since the leading zero
    // is unrecoverable once numeric, the honest behavior is to drop the record as unclassifiable.
    const payload = {
      events: [
        { GLOBALEVENTID: 777, SQLDATE: "20260722", EventCode: 10, Actor1Name: "FRANCE", Actor2Name: "IRAN" },
      ],
    };
    const fetchImpl = (async () => mockResponse(payload)) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.error).toBeNull();
    expect(result.events).toHaveLength(0); // dropped, never fabricated as isHighSeverity: true
  });

  it("accepts a bare top-level array response shape too", async () => {
    const payload = [
      {
        GLOBALEVENTID: 999,
        SQLDATE: "20260722",
        EventCode: "204",
        GoldsteinScale: -10,
        Actor1Name: "IRAN",
        Actor2Name: "ISRAEL",
      },
    ];
    const fetchImpl = (async () => mockResponse(payload)) as unknown as typeof fetch;
    const result = await fetchRecentConflictEvents({ fetchImpl });
    expect(result.error).toBeNull();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe("999");
  });
});

// ── GeopoliticalConflictFeedStore (dedup + bounded growth + atomic write) ──

describe("GeopoliticalConflictFeedStore", () => {
  it("dedups by id — adding the same id twice only stores it once", () => {
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("dedup"));
    const e = ev({ id: "dup-1" });
    expect(store.add(e)).toBe(true);
    expect(store.add({ ...e })).toBe(false); // same id, different object identity
    expect(store.all).toHaveLength(1);
  });

  it("persists via atomic tmp+rename write and survives reload", () => {
    const file = tmpStorePath("reload");
    const store = new GeopoliticalConflictFeedStore(file);
    store.add(ev({ id: "a", dateMs: BASE }));
    store.add(ev({ id: "b", dateMs: BASE - 1000 }));
    store.save();

    const reloaded = new GeopoliticalConflictFeedStore(file);
    expect(reloaded.all.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(reloaded.cycleMeta).toBeDefined();
  });

  it("starts empty (never throws) when the file is missing or corrupt", () => {
    const missing = new GeopoliticalConflictFeedStore(tmpStorePath("missing"));
    expect(missing.all).toEqual([]);

    const file = tmpStorePath("corrupt");
    // Write garbage directly, bypassing the store's own atomic writer.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ not valid json", "utf-8");
    const corrupt = new GeopoliticalConflictFeedStore(file);
    expect(corrupt.all).toEqual([]);
  });

  it("bounds stored events at GEOPOLITICAL_FEED_MAX_STORED_EVENTS, keeping the newest", () => {
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("bound-count"));
    const total = GEOPOLITICAL_FEED_MAX_STORED_EVENTS + 25;
    for (let i = 0; i < total; i++) {
      store.add(ev({ id: `e${i}`, dateMs: BASE + i * 1000 })); // ascending — last added is newest
    }
    store.save();
    expect(store.all.length).toBeLessThanOrEqual(GEOPOLITICAL_FEED_MAX_STORED_EVENTS);
    // The newest event must survive; the oldest must have been pruned.
    expect(store.all.some((e) => e.id === `e${total - 1}`)).toBe(true);
    expect(store.all.some((e) => e.id === "e0")).toBe(false);
  });

  it("prunes events older than GEOPOLITICAL_FEED_MAX_AGE_MS relative to the newest stored event", () => {
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("bound-age"));
    store.add(ev({ id: "newest", dateMs: BASE }));
    store.add(ev({ id: "stale", dateMs: BASE - GEOPOLITICAL_FEED_MAX_AGE_MS - 1 }));
    store.add(ev({ id: "fresh", dateMs: BASE - 1000 }));
    store.save();
    const ids = store.all.map((e) => e.id);
    expect(ids).toContain("newest");
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });
});

// ── cycle (kill switch + wiring) ─────────────────────────────────────────

describe("runGeopoliticalConflictFeedCycle", () => {
  const ORIGINAL_DISABLED = process.env.GEOPOLITICAL_FEED_DISABLED;
  afterEach(() => {
    if (ORIGINAL_DISABLED === undefined) delete process.env.GEOPOLITICAL_FEED_DISABLED;
    else process.env.GEOPOLITICAL_FEED_DISABLED = ORIGINAL_DISABLED;
  });

  it("defaults to ENABLED — runs the fetch when the env var is unset", async () => {
    delete process.env.GEOPOLITICAL_FEED_DISABLED;
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("enabled"));
    const payload = {
      events: [
        { GLOBALEVENTID: 1, SQLDATE: "20260722", EventCode: "190", GoldsteinScale: -9, Actor1Name: "IRAN", Actor2Name: "ISRAEL" },
      ],
    };
    const fetchImpl = (async () => mockResponse(payload)) as unknown as typeof fetch;
    const result = await runGeopoliticalConflictFeedCycle({ store, now: BASE, fetchOpts: { fetchImpl } });
    expect(result.disabled).toBe(false);
    expect(result.fetched).toBe(1);
    expect(result.added).toBe(1);
    expect(store.all).toHaveLength(1);
  });

  it("short-circuits (no fetch) when GEOPOLITICAL_FEED_DISABLED=1", async () => {
    process.env.GEOPOLITICAL_FEED_DISABLED = "1";
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("disabled"));
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return mockResponse({ events: [] });
    }) as unknown as typeof fetch;
    const result = await runGeopoliticalConflictFeedCycle({ store, now: BASE, fetchOpts: { fetchImpl } });
    expect(result.disabled).toBe(true);
    expect(fetchCalled).toBe(false);
    expect(store.cycleMeta.disabledCycles).toBe(1);
  });

  it("dedups across cycles (second cycle with an overlapping event adds nothing new)", async () => {
    delete process.env.GEOPOLITICAL_FEED_DISABLED;
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("cross-cycle-dedup"));
    const payload = {
      events: [{ GLOBALEVENTID: 42, SQLDATE: "20260722", EventCode: "190", Actor1Name: "IRAN", Actor2Name: "ISRAEL" }],
    };
    const fetchImpl = (async () => mockResponse(payload)) as unknown as typeof fetch;
    const first = await runGeopoliticalConflictFeedCycle({ store, now: BASE, fetchOpts: { fetchImpl } });
    const second = await runGeopoliticalConflictFeedCycle({ store, now: BASE + 1000, fetchOpts: { fetchImpl } });
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(store.all).toHaveLength(1);
  });

  it("records the fetch error on the cycle result and cycleMeta without throwing", async () => {
    delete process.env.GEOPOLITICAL_FEED_DISABLED;
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("fetch-error"));
    const fetchImpl = (async () => {
      throw new Error("dns failure");
    }) as unknown as typeof fetch;
    const result = await runGeopoliticalConflictFeedCycle({ store, now: BASE, fetchOpts: { fetchImpl } });
    expect(result.disabled).toBe(false);
    expect(result.fetched).toBe(0);
    expect(result.error).toBe("gdelt api request failed");
    expect(store.cycleMeta.lastError).toBe("gdelt api request failed");
  });
});

describe("runGeopoliticalConflictFeedCycleGuarded", () => {
  it("single-flight: a second overlapping call returns null while the first is in-flight", async () => {
    const store = new GeopoliticalConflictFeedStore(tmpStorePath("guarded"));
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const fetchImpl = (async () => {
      await gate;
      return mockResponse({ events: [] });
    }) as unknown as typeof fetch;

    const firstPromise = runGeopoliticalConflictFeedCycleGuarded({ store, now: BASE, fetchOpts: { fetchImpl } });
    // Give the first call a tick to set the in-flight flag before firing the second.
    await Promise.resolve();
    const second = await runGeopoliticalConflictFeedCycleGuarded({ store, now: BASE, fetchOpts: { fetchImpl } });
    expect(second).toBeNull();

    releaseFirst!();
    const first = await firstPromise;
    expect(first).not.toBeNull();
  });
});

// ── report (transparency) ────────────────────────────────────────────────

describe("buildConflictFeedReport", () => {
  it("surfaces per-event evidence (id, cameo code, goldstein) alongside the aggregate intensity", () => {
    const events = [
      ev({ id: "e1", dateMs: BASE, cameoCode: "204", goldsteinScale: -10, isHighSeverity: true }),
      ev({ id: "e2", dateMs: BASE - 500, cameoCode: "010", goldsteinScale: 1, isHighSeverity: false }),
    ];
    const report = buildConflictFeedReport(events, BASE, DAY_MS);
    expect(report.signalSource).toBe("GDELT_EVENT_DATABASE");
    expect(report.intensity.eventCount).toBe(2);
    expect(report.massViolenceCount).toBe(1);
    expect(report.topRecent.map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(report.topRecent[0]!.isMassViolence).toBe(true);
  });
});

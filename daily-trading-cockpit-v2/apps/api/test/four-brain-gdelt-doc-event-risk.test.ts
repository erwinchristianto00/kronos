import { describe, expect, it } from "vitest";

import {
  buildGdeltDocEventRisk,
  fetchGdeltDocEventRisk,
  parseGdeltDocSeenAtMs,
} from "../src/lib/four-brain-gdelt-doc-event-risk.js";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

describe("Four-Brain GDELT DOC event-risk source", () => {
  it("parses the documented compact GDELT timestamp without guessing", () => {
    expect(parseGdeltDocSeenAtMs("20260814T113000Z")).toBe(Date.UTC(2026, 7, 14, 11, 30, 0));
    expect(parseGdeltDocSeenAtMs("not-a-date")).toBeNull();
  });

  it("counts only unique, dated, in-window records and maps the transparent count to 0..1", () => {
    const payload = {
      articles: [
        { url: "https://one", title: "one", seendate: "20260814T110000Z" },
        { url: "https://one", title: "duplicate", seendate: "20260814T110000Z" },
        { url: "https://two", title: "two", seendate: "20260814T100000Z" },
        { url: "https://old", title: "old", seendate: "20260812T100000Z" },
        { url: "https://future", title: "future", seendate: "20260814T130200Z" },
      ],
    };
    const risk = buildGdeltDocEventRisk(payload, NOW, { saturationArticles: 4 });
    expect(risk).toEqual({
      score: 0.5,
      articleCount: 2,
      latestArticleAtMs: Date.UTC(2026, 7, 14, 11, 0, 0),
      observedAtMs: NOW,
    });
  });

  it("treats a successful empty response as a real zero, while non-empty undated data remains unavailable", () => {
    expect(buildGdeltDocEventRisk({ articles: [] }, NOW)).toMatchObject({ score: 0, articleCount: 0 });
    expect(buildGdeltDocEventRisk({ articles: [{ url: "https://bad", title: "bad", seendate: "bad" }] }, NOW)).toBeNull();
  });

  it("returns an explicit failure for a non-success HTTP response and never invents a score", async () => {
    const result = await fetchGdeltDocEventRisk({
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      now: () => NOW,
    });
    expect(result).toEqual({ ok: false, reason: "gdelt DOC HTTP 503" });
  });
});

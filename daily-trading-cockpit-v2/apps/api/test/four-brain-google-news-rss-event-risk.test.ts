import { describe, expect, it } from "vitest";

import {
  buildGoogleNewsRssEventRisk,
  fetchGoogleNewsRssEventRisk,
} from "../src/lib/four-brain-google-news-rss-event-risk.js";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

function rss(items: string): string {
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

describe("Four-Brain Google News RSS event-risk fallback", () => {
  it("counts only unique, dated, in-window items and maps the transparent count to 0..1", () => {
    const payload = rss(`
      <item><guid>one</guid><title>one</title><pubDate>Fri, 14 Aug 2026 11:00:00 GMT</pubDate></item>
      <item><guid>one</guid><title>duplicate</title><pubDate>Fri, 14 Aug 2026 11:00:00 GMT</pubDate></item>
      <item><guid>two</guid><title>two</title><pubDate>Fri, 14 Aug 2026 10:00:00 GMT</pubDate></item>
      <item><guid>old</guid><title>old</title><pubDate>Wed, 12 Aug 2026 10:00:00 GMT</pubDate></item>
      <item><guid>future</guid><title>future</title><pubDate>Fri, 14 Aug 2026 13:02:00 GMT</pubDate></item>
    `);
    expect(buildGoogleNewsRssEventRisk(payload, NOW, { saturationArticles: 4 })).toEqual({
      score: 0.5,
      articleCount: 2,
      latestArticleAtMs: Date.UTC(2026, 7, 14, 11, 0, 0),
      observedAtMs: NOW,
    });
  });

  it("treats a successful empty feed as a measured zero, while non-empty undated items remain unavailable", () => {
    expect(buildGoogleNewsRssEventRisk(rss(""), NOW)).toMatchObject({ score: 0, articleCount: 0 });
    expect(buildGoogleNewsRssEventRisk(rss("<item><guid>bad</guid><title>bad</title></item>"), NOW)).toBeNull();
  });

  it("returns an explicit failure for a non-success HTTP response and never invents a score", async () => {
    const result = await fetchGoogleNewsRssEventRisk({
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      now: () => NOW,
    });
    expect(result).toEqual({ ok: false, reason: "Google News RSS HTTP 503" });
  });
});

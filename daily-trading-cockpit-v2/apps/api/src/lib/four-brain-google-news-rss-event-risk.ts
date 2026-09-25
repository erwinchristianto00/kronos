/**
 * Four-Brain testnet fallback event-risk source: Google News RSS article-volume proxy.
 *
 * GDELT DOC remains the primary source. This fallback exists because the public GDELT endpoint can
 * rate-limit the server (HTTP 429). It is deliberately narrow, quantitative, and transparent: it
 * counts unique RSS items with a real publication time inside the same trailing window. It does
 * not classify article sentiment, infer truth, or make an execution decision.
 */

export const FOUR_BRAIN_GOOGLE_NEWS_RSS_BASE_URL = "https://news.google.com/rss/search";
export const FOUR_BRAIN_GOOGLE_NEWS_RSS_QUERY = "Iran Israel military conflict";
export const FOUR_BRAIN_GOOGLE_NEWS_RSS_WINDOW_MS = 24 * 60 * 60_000;
export const FOUR_BRAIN_GOOGLE_NEWS_RSS_SATURATION_ARTICLES = 25;
export const FOUR_BRAIN_GOOGLE_NEWS_RSS_TIMEOUT_MS = 20_000;

interface GoogleNewsRssItem {
  id: string | null;
  title: string | null;
  publishedAtMs: number | null;
}

export interface GoogleNewsRssEventRisk {
  /** Bounded [0,1] count / saturation; it is a news-volume proxy, not an event prediction. */
  score: number;
  articleCount: number;
  latestArticleAtMs: number | null;
  observedAtMs: number;
}

export type FetchGoogleNewsRssEventRiskResult =
  | { ok: true; risk: GoogleNewsRssEventRisk }
  | { ok: false; reason: string };

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function xmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  return nonEmpty(match[1].replace(/^<!\\[CDATA\\[/, "").replace(/\\]\\]>$/, ""));
}

function parseItems(xml: string): GoogleNewsRssItem[] | null {
  if (typeof xml !== "string") return null;
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return blocks.map((match) => {
    const block = match[1];
    const published = xmlTag(block, "pubDate");
    const parsed = published ? Date.parse(published) : NaN;
    return {
      id: xmlTag(block, "guid") ?? xmlTag(block, "link"),
      title: xmlTag(block, "title"),
      publishedAtMs: Number.isFinite(parsed) ? parsed : null,
    };
  });
}

/** Build a score from RSS XML already fetched. Non-empty but undated feeds remain unavailable. */
export function buildGoogleNewsRssEventRisk(
  xml: string,
  observedAtMs: number,
  opts: { windowMs?: number; saturationArticles?: number } = {},
): GoogleNewsRssEventRisk | null {
  if (!Number.isFinite(observedAtMs)) return null;
  const items = parseItems(xml);
  if (items === null) return null;
  const dated = items.filter((item) => item.publishedAtMs !== null);
  if (items.length > 0 && dated.length === 0) return null;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0
    ? opts.windowMs!
    : FOUR_BRAIN_GOOGLE_NEWS_RSS_WINDOW_MS;
  const saturation = Number.isFinite(opts.saturationArticles) && opts.saturationArticles! > 0
    ? opts.saturationArticles!
    : FOUR_BRAIN_GOOGLE_NEWS_RSS_SATURATION_ARTICLES;
  const startMs = observedAtMs - windowMs;
  const unique = new Map<string, GoogleNewsRssItem>();
  for (const item of dated) {
    const publishedAtMs = item.publishedAtMs!;
    if (publishedAtMs < startMs || publishedAtMs > observedAtMs + 60_000) continue;
    const key = item.id ?? `${item.title ?? "untitled"}::${publishedAtMs}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const inWindow = [...unique.values()];
  const latestArticleAtMs = inWindow.reduce<number | null>((latest, item) =>
    latest === null || item.publishedAtMs! > latest ? item.publishedAtMs! : latest, null);
  return {
    score: Math.max(0, Math.min(1, inWindow.length / saturation)),
    articleCount: inWindow.length,
    latestArticleAtMs,
    observedAtMs,
  };
}

/** Fetch the public Google News RSS search endpoint with a bounded timeout and no side effects. */
export async function fetchGoogleNewsRssEventRisk(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  query?: string;
  timeoutMs?: number;
  windowMs?: number;
  saturationArticles?: number;
} = {}): Promise<FetchGoogleNewsRssEventRiskResult> {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0
    ? opts.timeoutMs!
    : FOUR_BRAIN_GOOGLE_NEWS_RSS_TIMEOUT_MS;
  const url = new URL(FOUR_BRAIN_GOOGLE_NEWS_RSS_BASE_URL);
  url.searchParams.set("q", opts.query ?? FOUR_BRAIN_GOOGLE_NEWS_RSS_QUERY);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (opts.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": "Mozilla/5.0 (compatible; Kronos-FourBrain-Testnet/1.0)",
      },
    });
    if (!response.ok) return { ok: false, reason: `Google News RSS HTTP ${response.status}` };
    const risk = buildGoogleNewsRssEventRisk(await response.text(), (opts.now ?? Date.now)(), {
      windowMs: opts.windowMs,
      saturationArticles: opts.saturationArticles,
    });
    return risk ? { ok: true, risk } : { ok: false, reason: "Google News RSS response had no usable dated article evidence" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Google News RSS request failed: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Four-Brain testnet event-risk source: a transparent GDELT DOC conflict-news volume proxy.
 *
 * The old GDELT Event Database endpoint is not available from this deployment (HTTP 404), so it
 * must not be treated as a live source. GDELT's documented DOC 2.0 artlist endpoint is available
 * and returns dated article records. This module counts unique, in-window records for the fixed
 * conflict query and maps only that measurable count into 0..1. It makes no judgement about who
 * is right, whether an article is true, or whether risk will rise: it is a bounded transition-risk
 * proxy for unusually dense relevant news coverage.
 *
 * It is report-only and testnet-only by its app.ts caller. A failed/invalid response returns no
 * score; callers retain their last measurement and normal freshness logic eventually marks it
 * STALE. A successful empty response is a real measured zero, not a fabricated value.
 */

export const FOUR_BRAIN_GDELT_DOC_BASE_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const FOUR_BRAIN_GDELT_DOC_QUERY = "Iran Israel military conflict";
export const FOUR_BRAIN_GDELT_DOC_WINDOW_MS = 24 * 60 * 60_000;
export const FOUR_BRAIN_GDELT_DOC_SATURATION_ARTICLES = 25;
export const FOUR_BRAIN_GDELT_DOC_TIMEOUT_MS = 30_000;

interface GdeltDocArticle {
  url: string | null;
  title: string | null;
  seenAtMs: number | null;
}

export interface GdeltDocEventRisk {
  /** Bounded [0,1] count / saturation; it is a news-volume proxy, not an event prediction. */
  score: number;
  articleCount: number;
  latestArticleAtMs: number | null;
  observedAtMs: number;
}

export type FetchGdeltDocEventRiskResult =
  | { ok: true; risk: GdeltDocEventRisk }
  | { ok: false; reason: string };

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** GDELT DOC timestamps are normally YYYYMMDDTHHMMSSZ; unparseable dates are never guessed. */
export function parseGdeltDocSeenAtMs(value: unknown): number | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    const ms = Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6]),
    );
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractArticles(payload: unknown): GdeltDocArticle[] | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).articles;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const article = item as Record<string, unknown>;
    return [{
      url: nonEmpty(article.url),
      title: nonEmpty(article.title),
      seenAtMs: parseGdeltDocSeenAtMs(article.seendate),
    }];
  });
}

/** Build a score from a response that has already been fetched. Returns null when dated evidence is unusable. */
export function buildGdeltDocEventRisk(
  payload: unknown,
  observedAtMs: number,
  opts: { windowMs?: number; saturationArticles?: number } = {},
): GdeltDocEventRisk | null {
  if (!Number.isFinite(observedAtMs)) return null;
  const articles = extractArticles(payload);
  if (articles === null) return null;
  const dated = articles.filter((article) => article.seenAtMs !== null);
  // A non-empty response with no usable date cannot establish a fresh, causal event window.
  if (articles.length > 0 && dated.length === 0) return null;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0 ? opts.windowMs! : FOUR_BRAIN_GDELT_DOC_WINDOW_MS;
  const saturation = Number.isFinite(opts.saturationArticles) && opts.saturationArticles! > 0
    ? opts.saturationArticles!
    : FOUR_BRAIN_GDELT_DOC_SATURATION_ARTICLES;
  const startMs = observedAtMs - windowMs;
  const unique = new Map<string, GdeltDocArticle>();
  for (const article of dated) {
    const seenAtMs = article.seenAtMs!;
    if (seenAtMs < startMs || seenAtMs > observedAtMs + 60_000) continue;
    const key = article.url ?? `${article.title ?? "untitled"}::${seenAtMs}`;
    if (!unique.has(key)) unique.set(key, article);
  }
  const inWindow = [...unique.values()];
  const latestArticleAtMs = inWindow.reduce<number | null>((latest, article) =>
    latest === null || article.seenAtMs! > latest ? article.seenAtMs! : latest, null);
  return {
    score: Math.max(0, Math.min(1, inWindow.length / saturation)),
    articleCount: inWindow.length,
    latestArticleAtMs,
    observedAtMs,
  };
}

/** Fetch the documented GDELT DOC artlist endpoint with a bounded timeout and no side effects. */
export async function fetchGdeltDocEventRisk(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  query?: string;
  timeoutMs?: number;
  maxRecords?: number;
  windowMs?: number;
  saturationArticles?: number;
} = {}): Promise<FetchGdeltDocEventRiskResult> {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : FOUR_BRAIN_GDELT_DOC_TIMEOUT_MS;
  const maxRecords = Number.isFinite(opts.maxRecords) && opts.maxRecords! > 0 ? Math.floor(opts.maxRecords!) : 75;
  const params = new URLSearchParams({
    query: opts.query ?? FOUR_BRAIN_GDELT_DOC_QUERY,
    mode: "artlist",
    format: "json",
    maxrecords: String(Math.min(250, maxRecords)),
    timespan: "1d",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${FOUR_BRAIN_GDELT_DOC_BASE_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; Kronos-FourBrain-Testnet/1.0)" },
    });
    if (!response.ok) return { ok: false, reason: `gdelt DOC HTTP ${response.status}` };
    const payload: unknown = await response.json();
    const observedAtMs = (opts.now ?? Date.now)();
    const risk = buildGdeltDocEventRisk(payload, observedAtMs, {
      windowMs: opts.windowMs,
      saturationArticles: opts.saturationArticles,
    });
    return risk ? { ok: true, risk } : { ok: false, reason: "gdelt DOC response had no usable dated article evidence" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `gdelt DOC request failed: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}

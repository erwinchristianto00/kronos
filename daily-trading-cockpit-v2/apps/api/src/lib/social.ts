import type { SentimentSignal } from "@dtc/shared";

export interface SocialAvailability {
  available: boolean;
  configured: boolean;
  provider?: string;
  message: string;
}

export interface SocialClient {
  availability(): Promise<SocialAvailability>;
  getSignal(symbol: string): Promise<SentimentSignal>;
}

interface SocialClientOptions {
  provider: string | undefined;
  baseUrl: string | undefined;
  redditClientId?: string | undefined;
  redditClientSecret?: string | undefined;
  redditUserAgent?: string | undefined;
  redditSubreddits?: string | undefined;
  fetchImpl?: typeof fetch;
}

interface CustomSentimentResponse {
  signal?: string;
  score?: number;
  confidence?: number;
  scope?: string;
  source?: string;
  reason?: string;
}

interface FearGreedResponse {
  data?: Array<{
    value?: string;
    value_classification?: string;
    timestamp?: string;
  }>;
}

interface RedditTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{
      kind?: string;
      data?: {
        title?: string;
        selftext?: string;
        body?: string;
        ups?: number;
        num_comments?: number;
        created_utc?: number;
        subreddit?: string;
      };
    }>;
  };
}

const PROVIDERS = new Set(["none", "custom", "reddit", "feargreed"]);
const CACHE_TTL_MS = 5 * 60 * 1000;
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";

const SYMBOL_ALIASES: Record<string, string[]> = {
  BTCUSDT: ["btc", "bitcoin", "$btc"],
  ETHUSDT: ["eth", "ethereum", "$eth"],
  SOLUSDT: ["sol", "solana", "$sol"],
  DOGEUSDT: ["doge", "dogecoin", "$doge"],
  AVAXUSDT: ["avax", "avalanche", "$avax"],
  LINKUSDT: ["link", "chainlink", "$link"],
  SUIUSDT: ["sui", "$sui"],
  PEPEUSDT: ["pepe", "$pepe"],
  ARBUSDT: ["arb", "arbitrum", "$arb"],
  OPUSDT: ["op", "optimism", "$op"],
  INJUSDT: ["inj", "injective", "$inj"],
  WLDUSDT: ["wld", "worldcoin", "$wld"],
  APTUSDT: ["apt", "aptos", "$apt"],
  SEIUSDT: ["sei", "$sei"],
  NEARUSDT: ["near", "near protocol", "$near"],
  BNBUSDT: ["bnb", "binance coin", "$bnb"],
  XRPUSDT: ["xrp", "ripple", "$xrp"],
  ADAUSDT: ["ada", "cardano", "$ada"],
  FETUSDT: ["fet", "fetch ai", "$fet"],
  RNDRUSDT: ["rndr", "render", "$rndr"],
};

const BULLISH_TERMS = [
  "bullish",
  "breakout",
  "pump",
  "rally",
  "accumulate",
  "long",
  "moon",
  "uptrend",
  "buy",
  "support held",
];

const BEARISH_TERMS = [
  "bearish",
  "dump",
  "selloff",
  "short",
  "rug",
  "downtrend",
  "breakdown",
  "capitulation",
  "rejected",
  "resistance held",
];

function unavailable(reason: string, source = "none"): SentimentSignal {
  return {
    available: false,
    signal: "UNAVAILABLE",
    score: 0,
    confidence: 0,
    source,
    reason,
  };
}

function normalizeSignal(signal: string): SentimentSignal["signal"] | null {
  const rawSignal = signal.toUpperCase();
  return rawSignal === "BULLISH" || rawSignal === "BEARISH" || rawSignal === "NEUTRAL" ? rawSignal : null;
}

function normalizeScope(scope: string | undefined): SentimentSignal["scope"] | undefined {
  if (!scope) {
    return undefined;
  }
  const normalized = scope.toUpperCase();
  return normalized === "MARKET" || normalized === "SYMBOL" ? normalized : undefined;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function keywordSentiment(text: string): { bullishHits: number; bearishHits: number } {
  const normalized = text.toLowerCase();
  return {
    bullishHits: BULLISH_TERMS.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0),
    bearishHits: BEARISH_TERMS.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0),
  };
}

export class HttpSocialClient implements SocialClient {
  private readonly fetchImpl: typeof fetch;
  private readonly provider: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly redditClientId: string | undefined;
  private readonly redditClientSecret: string | undefined;
  private readonly redditUserAgent: string;
  private readonly redditSubreddits: string[];
  private readonly cache = new Map<string, { expiresAt: number; value: SentimentSignal }>();
  private redditToken: { accessToken: string; expiresAt: number } | null = null;

  constructor(options: SocialClientOptions) {
    this.provider = options.provider;
    this.baseUrl = options.baseUrl;
    this.redditClientId = options.redditClientId;
    this.redditClientSecret = options.redditClientSecret;
    this.redditUserAgent = options.redditUserAgent || "daily-trading-cockpit-v2/0.1";
    this.redditSubreddits = parseCsv(options.redditSubreddits, ["CryptoCurrency", "Bitcoin", "ethtrader", "solana", "Altcoin"]);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async availability(): Promise<SocialAvailability> {
    if (!this.provider || this.provider === "none") {
      return {
        available: false,
        configured: false,
        provider: "none",
        message: "Social provider none is disabled.",
      };
    }
    if (!PROVIDERS.has(this.provider)) {
      return {
        available: false,
        configured: true,
        provider: this.provider,
        message: `Social provider ${this.provider} is not supported.`,
      };
    }
    if (this.provider === "custom" && !this.baseUrl) {
      return {
        available: false,
        configured: true,
        provider: "custom",
        message: "Social provider custom is missing SOCIAL_SENTIMENT_URL.",
      };
    }
    if (this.provider === "reddit" && (!this.redditClientId || !this.redditClientSecret)) {
      return {
        available: false,
        configured: true,
        provider: "reddit",
        message: "Social provider reddit is missing Reddit OAuth credentials.",
      };
    }

    return {
      available: true,
      configured: true,
      provider: this.provider,
      message: `Social provider ${this.provider} is active.`,
    };
  }

  private getCached(cacheKey: string): SentimentSignal | null {
    const cached = this.cache.get(cacheKey);
    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }
    return cached.value;
  }

  private setCached(cacheKey: string, value: SentimentSignal): SentimentSignal {
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    });
    return value;
  }

  private async getCustomSignal(symbol: string): Promise<SentimentSignal> {
    if (!this.baseUrl) {
      return unavailable("Custom social sentiment adapter is configured without SOCIAL_SENTIMENT_URL.", "custom");
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set("symbol", symbol);
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Custom social sentiment request failed with ${response.status}.`);
    }

    const payload = (await response.json()) as CustomSentimentResponse;
    const signal = payload.signal ? normalizeSignal(payload.signal) : null;
    const score = Number(payload.score);
    const confidence = Number(payload.confidence ?? payload.score);
    if (!signal || !Number.isFinite(score)) {
      throw new Error("Custom social sentiment response is invalid.");
    }

    return {
      available: true,
      signal,
      score: clampScore(score),
      confidence: Number.isFinite(confidence) ? clampScore(confidence) : clampScore(score),
      scope: normalizeScope(payload.scope) ?? "SYMBOL",
      source: payload.source ?? "custom",
      reason: payload.reason ?? `Custom social sentiment is ${signal.toLowerCase()}.`,
    };
  }

  private async getFearGreedSignal(): Promise<SentimentSignal> {
    const response = await this.fetchImpl("https://api.alternative.me/fng/?limit=1&format=json", {
      headers: {
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Fear & Greed request failed with ${response.status}.`);
    }

    const payload = (await response.json()) as FearGreedResponse;
    const latest = payload.data?.[0];
    const value = Number(latest?.value);
    if (!Number.isFinite(value)) {
      throw new Error("Fear & Greed response is invalid.");
    }

    if (value >= 60) {
      return {
        available: true,
        signal: "BULLISH",
        score: clampScore(value),
        confidence: clampScore(Math.max(45, value)),
        scope: "MARKET",
        source: "feargreed",
        reason: `Market-wide Fear & Greed is bullish at ${value}.`,
      };
    }
    if (value <= 40) {
      return {
        available: true,
        signal: "BEARISH",
        score: clampScore(100 - value),
        confidence: clampScore(Math.max(45, 100 - value)),
        scope: "MARKET",
        source: "feargreed",
        reason: `Market-wide Fear & Greed is bearish at ${value}.`,
      };
    }
    return {
      available: true,
      signal: "NEUTRAL",
      score: 50,
      confidence: 45,
      scope: "MARKET",
      source: "feargreed",
      reason: `Market-wide Fear & Greed is neutral at ${value}.`,
    };
  }

  private async getRedditAccessToken(): Promise<string> {
    if (this.redditToken && this.redditToken.expiresAt > Date.now() + 15_000) {
      return this.redditToken.accessToken;
    }
    if (!this.redditClientId || !this.redditClientSecret) {
      throw new Error("Reddit OAuth credentials are missing.");
    }

    const encoded = Buffer.from(`${this.redditClientId}:${this.redditClientSecret}`).toString("base64");
    const response = await this.fetchImpl(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${encoded}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.redditUserAgent,
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) {
      throw new Error(`Reddit OAuth token request failed with ${response.status}.`);
    }

    const payload = (await response.json()) as RedditTokenResponse;
    if (!payload.access_token) {
      throw new Error("Reddit OAuth token response is invalid.");
    }

    this.redditToken = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    return payload.access_token;
  }

  private async fetchRedditListing(path: string, params: Record<string, string>): Promise<RedditListingResponse> {
    const token = await this.getRedditAccessToken();
    const url = new URL(path, REDDIT_API_BASE);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": this.redditUserAgent,
        accept: "application/json",
      },
    });
    if (response.status === 429) {
      throw new Error("Reddit OAuth listing request was rate limited.");
    }
    if (!response.ok) {
      throw new Error(`Reddit OAuth listing request failed with ${response.status}.`);
    }
    return (await response.json()) as RedditListingResponse;
  }

  private async getRedditSignal(symbol: string): Promise<SentimentSignal> {
    const aliases = SYMBOL_ALIASES[symbol] ?? [symbol.replace("USDT", "").toLowerCase()];
    const query = aliases.join(" OR ");

    const searches = await Promise.all(
      this.redditSubreddits.map(async (subreddit) => {
        const [posts, comments] = await Promise.all([
          this.fetchRedditListing(`/r/${subreddit}/search`, {
            q: query,
            restrict_sr: "1",
            sort: "new",
            limit: "10",
            t: "day",
            type: "link",
          }),
          this.fetchRedditListing(`/r/${subreddit}/comments`, {
            limit: "10",
          }),
        ]);
        return { subreddit, posts, comments };
      }),
    );

    let weightedBullish = 0;
    let weightedBearish = 0;
    let mentionCount = 0;
    let totalWeight = 0;
    let newestMentionAgeHours = 24;

    for (const result of searches) {
      const postChildren = result.posts.data?.children ?? [];
      const commentChildren = result.comments.data?.children ?? [];
      const allItems = [...postChildren, ...commentChildren];

      for (const item of allItems) {
        const entry = item.data;
        const text = `${entry?.title ?? ""} ${entry?.selftext ?? ""} ${entry?.body ?? ""}`.trim();
        const normalizedText = text.toLowerCase();
        if (!aliases.some((alias) => normalizedText.includes(alias.toLowerCase()))) {
          continue;
        }

        const { bullishHits, bearishHits } = keywordSentiment(text);
        const ups = Math.min(Number(entry?.ups ?? 0), 200);
        const comments = Math.min(Number(entry?.num_comments ?? 0), 100);
        const created = Number(entry?.created_utc ?? 0) * 1000;
        const ageHours = created > 0 ? Math.max(0, (Date.now() - created) / 3_600_000) : 24;
        newestMentionAgeHours = Math.min(newestMentionAgeHours, ageHours);
        const recencyWeight = Math.max(0.3, 1 - ageHours / 48);
        const engagementWeight = Math.min(3, 1 + ups / 100 + comments / 80);
        const weight = Math.min(4, recencyWeight * engagementWeight);
        totalWeight += weight;
        mentionCount += 1;
        weightedBullish += bullishHits * weight;
        weightedBearish += bearishHits * weight;
      }
    }

    if (mentionCount === 0) {
      return unavailable(`Reddit OAuth found no fresh symbol mentions for ${symbol}.`, "reddit");
    }

    const net = weightedBullish - weightedBearish;
    const magnitude = weightedBullish + weightedBearish;
    if (magnitude < 1) {
      return {
        available: true,
        signal: "NEUTRAL",
        score: 50,
        confidence: clampScore(35 + Math.min(20, mentionCount * 2)),
        scope: "SYMBOL",
        source: "reddit",
        reason: `Reddit OAuth mentions ${mentionCount} posts/comments for ${symbol}, but sentiment keywords are mixed.`,
      };
    }

    const normalizedEdge = net / magnitude;
    const signal = normalizedEdge > 0.12 ? "BULLISH" : normalizedEdge < -0.12 ? "BEARISH" : "NEUTRAL";
    const score = signal === "NEUTRAL" ? 50 : clampScore(50 + Math.min(35, Math.abs(normalizedEdge) * 45 + Math.min(mentionCount, 20)));
    const confidence = clampScore(
      35 + Math.min(35, mentionCount * 2) + Math.min(20, totalWeight * 2) + Math.max(0, 8 - newestMentionAgeHours / 3),
    );

    return {
      available: true,
      signal,
      score,
      confidence,
      scope: "SYMBOL",
      source: "reddit",
      reason: `Reddit OAuth ${signal.toLowerCase()} tilt from ${mentionCount} recent symbol mentions across ${this.redditSubreddits.length} subreddits.`,
    };
  }

  async getSignal(symbol: string): Promise<SentimentSignal> {
    const availability = await this.availability();
    if (!availability.available) {
      return unavailable(availability.message, availability.provider ?? "none");
    }

    const cacheKey = `${this.provider}:${this.provider === "feargreed" ? "market" : symbol}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const signal =
        this.provider === "custom"
          ? await this.getCustomSignal(symbol)
          : this.provider === "reddit"
            ? await this.getRedditSignal(symbol)
            : await this.getFearGreedSignal();
      return this.setCached(cacheKey, signal);
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : "Social sentiment adapter failed.", this.provider ?? "none");
    }
  }
}

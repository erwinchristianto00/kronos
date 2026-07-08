/**
 * NEW-COIN RADAR (2026-07-08 operator: "bikin sistem untuk cari coin baru, jangan yang udah usang,
 * pelajari fundamentalnya, teknologi dan cara kerja, manfaatnya apa").
 *
 * REPORT-ONLY research module: discovers RECENTLY-LISTED Binance USD-M perpetuals (exchangeInfo
 * onboardDate — the exchange's own listing timestamp, no guessing), excludes the stale scanner
 * UNIVERSE, and enriches each discovery with a FUNDAMENTAL PROFILE from CoinGecko's public API:
 * what the project is, its technology/categories, market cap vs fully-diluted valuation (dilution
 * risk), circulating ratio, developer activity, links. Everything is honestly-null when a source
 * has no data — a missing profile is flagged NO_FUNDAMENTAL_DATA, never fabricated.
 *
 * NOTHING here trades or feeds admission. Promotion into the scanner UNIVERSE stays a manual
 * operator decision, made from this report.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function isNewCoinRadarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEW_COIN_RADAR_ENABLED === "1";
}

/** How recent a listing must be to count as "new" (default 120 days). */
const MAX_AGE_DAYS = () => {
  const n = Number.parseInt(process.env.NEW_COIN_RADAR_MAX_AGE_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
};
/** Fundamentals fetched per cycle (CoinGecko free-tier friendly). */
const ENRICH_PER_CYCLE = () => {
  const n = Number.parseInt(process.env.NEW_COIN_RADAR_ENRICH_PER_CYCLE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 15) : 8;
};
const REFRESH_MS = 12 * 3_600_000; // discovery + enrichment cadence
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const BINANCE_FAPI = "https://fapi.binance.com";

export interface NewCoinFundamentals {
  coingeckoId: string;
  name: string;
  /** Truncated English project description — "apa itu, teknologinya, manfaatnya". */
  description: string | null;
  categories: string[];
  marketCapRank: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  /** circulating/total supply — LOW ratio = heavy future unlocks (dilution risk). */
  circulatingRatio: number | null;
  genesisDate: string | null;
  homepage: string | null;
  github: string | null;
  githubStars: number | null;
  commits4w: number | null;
}

export interface RadarCoin {
  symbol: string;
  baseAsset: string;
  onboardDate: string;
  ageDays: number;
  volume24hUsd: number | null;
  lastPrice: number | null;
  fundamentals: NewCoinFundamentals | null;
  /** 0-100 research-worthiness composite; null until fundamentals + volume are known. */
  score: number | null;
  flags: string[];
  enrichedAt: string | null;
}

export interface NewCoinRadarState {
  version: number;
  fetchedAt: string | null;
  coins: RadarCoin[];
  lastError: string | null;
  lastCycleAt: string | null;
}

export class NewCoinRadarStore {
  private readonly file: string;
  private state: NewCoinRadarState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "new-coin-radar.json");
    try {
      if (existsSync(this.file)) {
        this.state = JSON.parse(readFileSync(this.file, "utf8")) as NewCoinRadarState;
        return;
      }
    } catch {
      // corrupted file ⇒ start fresh (report-only data, safe to rebuild)
    }
    this.state = { version: 1, fetchedAt: null, coins: [], lastError: null, lastCycleAt: null };
  }

  getState(): NewCoinRadarState {
    return this.state;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}

let _store: NewCoinRadarStore | null = null;
export function getNewCoinRadarStore(dataDir = "data"): NewCoinRadarStore {
  if (!_store) _store = new NewCoinRadarStore(dataDir);
  return _store;
}
export function _resetNewCoinRadarStoreForTests(): void {
  _store = null;
}

/** Research-worthiness composite. Deliberately simple + transparent — every component is visible
 *  in the report so the operator can disagree with the weighting, not with hidden math. */
export function scoreRadarCoin(coin: {
  ageDays: number;
  volume24hUsd: number | null;
  fundamentals: NewCoinFundamentals | null;
}): { score: number | null; flags: string[] } {
  const flags: string[] = [];
  const f = coin.fundamentals;
  if (!f) flags.push("NO_FUNDAMENTAL_DATA");
  if (coin.volume24hUsd !== null && coin.volume24hUsd < 20_000_000) flags.push("LOW_LIQUIDITY");
  if (coin.ageDays < 14) flags.push("VERY_NEW");
  if (f?.circulatingRatio !== null && f?.circulatingRatio !== undefined && f.circulatingRatio < 0.3) flags.push("HIGH_DILUTION");
  if (f && f.commits4w !== null && f.commits4w === 0) flags.push("NO_RECENT_DEV_ACTIVITY");

  if (!f || coin.volume24hUsd === null) return { score: null, flags };

  let score = 0;
  // Liquidity 0-30: log-scaled, $10M→~10, $100M→~20, $1B→30.
  score += Math.max(0, Math.min(30, (Math.log10(Math.max(coin.volume24hUsd, 1)) - 6) * 10));
  // Dilution 0-20: full circulation = 20.
  if (f.circulatingRatio !== null) score += Math.max(0, Math.min(20, f.circulatingRatio * 20));
  // Market presence 0-20: rank 1→20, rank 500+→0.
  if (f.marketCapRank !== null) score += Math.max(0, 20 - (f.marketCapRank / 500) * 20);
  // Developer activity 0-15.
  if (f.commits4w !== null) score += Math.max(0, Math.min(15, f.commits4w / 4));
  // Documentation/identity 0-15: description + homepage + github.
  if (f.description && f.description.length > 80) score += 7;
  if (f.homepage) score += 4;
  if (f.github) score += 4;
  return { score: Math.round(Math.max(0, Math.min(100, score))), flags };
}

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Binance futures listings newer than maxAgeDays, excluding known/stale universe symbols. */
export async function discoverNewListings(opts: {
  fetchJson?: FetchJson;
  nowMs: number;
  excludeSymbols: ReadonlySet<string>;
  maxAgeDays?: number;
}): Promise<Array<{ symbol: string; baseAsset: string; onboardDate: string; ageDays: number }>> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const maxAgeDays = opts.maxAgeDays ?? MAX_AGE_DAYS();
  const info = (await fetchJson(`${BINANCE_FAPI}/fapi/v1/exchangeInfo`)) as {
    symbols?: Array<{ symbol: string; status: string; contractType?: string; quoteAsset?: string; baseAsset?: string; onboardDate?: number }>;
  };
  const out: Array<{ symbol: string; baseAsset: string; onboardDate: string; ageDays: number }> = [];
  for (const s of info.symbols ?? []) {
    if (s.status !== "TRADING" || s.contractType !== "PERPETUAL" || s.quoteAsset !== "USDT") continue;
    if (!s.onboardDate || !Number.isFinite(s.onboardDate)) continue;
    if (opts.excludeSymbols.has(s.symbol)) continue;
    const ageDays = (opts.nowMs - s.onboardDate) / 86_400_000;
    if (ageDays < 0 || ageDays > maxAgeDays) continue;
    out.push({
      symbol: s.symbol,
      baseAsset: (s.baseAsset ?? s.symbol.replace(/USDT$/, "")).replace(/^1000+/, ""),
      onboardDate: new Date(s.onboardDate).toISOString(),
      ageDays: Math.round(ageDays * 10) / 10,
    });
  }
  return out.sort((a, b) => a.ageDays - b.ageDays); // newest first
}

/** CoinGecko lookup: base asset ticker → best-matching coin id (highest market cap when the
 *  ticker is ambiguous — CoinGecko lists many copycats under popular tickers). */
export async function resolveCoingeckoIds(
  baseAssets: string[],
  fetchJson: FetchJson = defaultFetchJson,
): Promise<Map<string, string>> {
  const list = (await fetchJson(`${COINGECKO_BASE}/coins/list`)) as Array<{ id: string; symbol: string; name: string }>;
  const wanted = new Set(baseAssets.map((b) => b.toLowerCase()));
  const candidates = list.filter((c) => wanted.has(c.symbol.toLowerCase()));
  if (candidates.length === 0) return new Map();
  const byTicker = new Map<string, string[]>();
  for (const c of candidates) {
    const key = c.symbol.toLowerCase();
    byTicker.set(key, [...(byTicker.get(key) ?? []), c.id]);
  }
  const resolved = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const [ticker, ids] of byTicker) {
    if (ids.length === 1) resolved.set(ticker, ids[0]!);
    else ambiguous.push(...ids);
  }
  if (ambiguous.length > 0) {
    // One markets call ranks the duplicates by real market cap.
    const markets = (await fetchJson(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ambiguous.join(","))}&per_page=250`,
    )) as Array<{ id: string; symbol: string; market_cap: number | null }>;
    const bestByTicker = new Map<string, { id: string; mcap: number }>();
    for (const m of markets) {
      const key = m.symbol.toLowerCase();
      const mcap = m.market_cap ?? 0;
      const prev = bestByTicker.get(key);
      if (!prev || mcap > prev.mcap) bestByTicker.set(key, { id: m.id, mcap });
    }
    for (const [ticker, best] of bestByTicker) {
      if (!resolved.has(ticker)) resolved.set(ticker, best.id);
    }
  }
  return resolved;
}

export async function fetchFundamentals(
  coingeckoId: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<NewCoinFundamentals | null> {
  const raw = (await fetchJson(
    `${COINGECKO_BASE}/coins/${encodeURIComponent(coingeckoId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=true&sparkline=false`,
  )) as {
    id?: string;
    name?: string;
    description?: { en?: string };
    categories?: string[];
    market_cap_rank?: number | null;
    genesis_date?: string | null;
    links?: { homepage?: string[]; repos_url?: { github?: string[] } };
    market_data?: {
      market_cap?: { usd?: number };
      fully_diluted_valuation?: { usd?: number };
      circulating_supply?: number | null;
      total_supply?: number | null;
    };
    developer_data?: { stars?: number | null; commit_count_4_weeks?: number | null };
  };
  if (!raw?.id) return null;
  const md = raw.market_data;
  const circ = md?.circulating_supply ?? null;
  const total = md?.total_supply ?? null;
  const desc = (raw.description?.en ?? "").replace(/<[^>]+>/g, "").trim();
  return {
    coingeckoId: raw.id,
    name: raw.name ?? raw.id,
    description: desc ? desc.slice(0, 600) : null,
    categories: (raw.categories ?? []).filter(Boolean).slice(0, 6),
    marketCapRank: raw.market_cap_rank ?? null,
    marketCapUsd: md?.market_cap?.usd ?? null,
    fdvUsd: md?.fully_diluted_valuation?.usd ?? null,
    circulatingRatio: circ !== null && total !== null && total > 0 ? Math.round((circ / total) * 1000) / 1000 : null,
    genesisDate: raw.genesis_date ?? null,
    homepage: raw.links?.homepage?.[0] || null,
    github: raw.links?.repos_url?.github?.[0] || null,
    githubStars: raw.developer_data?.stars ?? null,
    commits4w: raw.developer_data?.commit_count_4_weeks ?? null,
  };
}

/** Full cycle: discover → keep/merge cache → enrich the least-recently-enriched N. */
export async function runNewCoinRadarCycle(opts: {
  store: NewCoinRadarStore;
  nowMs: number;
  excludeSymbols: ReadonlySet<string>;
  fetchJson?: FetchJson;
  /** Delay between CoinGecko calls (rate-limit kindness). Tests pass 0. */
  paceMs?: number;
}): Promise<{ discovered: number; enriched: number }> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const paceMs = opts.paceMs ?? 2_000;
  const st = opts.store.getState();
  if (st.fetchedAt && opts.nowMs - new Date(st.fetchedAt).getTime() < REFRESH_MS) {
    return { discovered: 0, enriched: 0 }; // fresh enough
  }

  const listings = await discoverNewListings({ fetchJson, nowMs: opts.nowMs, excludeSymbols: opts.excludeSymbols });

  // 24h quote volume for every discovered symbol in ONE public call.
  const tickers = (await fetchJson(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`)) as Array<{ symbol: string; quoteVolume?: string; lastPrice?: string }>;
  const volBySymbol = new Map(tickers.map((t) => [t.symbol, { vol: Number(t.quoteVolume), price: Number(t.lastPrice) }]));

  const prevBySymbol = new Map(st.coins.map((c) => [c.symbol, c]));
  const coins: RadarCoin[] = listings.map((l) => {
    const prev = prevBySymbol.get(l.symbol);
    const t = volBySymbol.get(l.symbol);
    const base: RadarCoin = {
      ...l,
      volume24hUsd: t && Number.isFinite(t.vol) ? Math.round(t.vol) : null,
      lastPrice: t && Number.isFinite(t.price) ? t.price : null,
      fundamentals: prev?.fundamentals ?? null,
      score: null,
      flags: [],
      enrichedAt: prev?.enrichedAt ?? null,
    };
    const scored = scoreRadarCoin(base);
    return { ...base, score: scored.score, flags: scored.flags };
  });

  // Enrich the N never/least-recently enriched, largest volume first (research the tradeable ones).
  const toEnrich = coins
    .filter((c) => c.fundamentals === null)
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    .slice(0, ENRICH_PER_CYCLE());
  let enriched = 0;
  if (toEnrich.length > 0) {
    const ids = await resolveCoingeckoIds(toEnrich.map((c) => c.baseAsset), fetchJson);
    for (const coin of toEnrich) {
      const id = ids.get(coin.baseAsset.toLowerCase());
      if (!id) {
        coin.flags = [...new Set([...coin.flags, "NO_FUNDAMENTAL_DATA"])];
        continue;
      }
      try {
        if (paceMs > 0) await sleep(paceMs);
        coin.fundamentals = await fetchFundamentals(id, fetchJson);
        coin.enrichedAt = new Date(opts.nowMs).toISOString();
        const scored = scoreRadarCoin(coin);
        coin.score = scored.score;
        coin.flags = scored.flags;
        enriched += 1;
      } catch {
        // rate-limited/unavailable — next cycle retries; never fabricate
      }
    }
  }

  st.coins = coins;
  st.fetchedAt = new Date(opts.nowMs).toISOString();
  st.lastCycleAt = new Date(opts.nowMs).toISOString();
  st.lastError = null;
  opts.store.save();
  return { discovered: coins.length, enriched };
}

export async function runNewCoinRadarCycleGuarded(opts: Parameters<typeof runNewCoinRadarCycle>[0]): Promise<void> {
  try {
    await runNewCoinRadarCycle(opts);
  } catch (error) {
    const st = opts.store.getState();
    st.lastError = (error as Error).message ?? "radar cycle failed";
    st.lastCycleAt = new Date(opts.nowMs).toISOString();
    opts.store.save();
  }
}

export function buildNewCoinRadarReport(store: NewCoinRadarStore, nowMs: number) {
  const st = store.getState();
  return {
    enabled: isNewCoinRadarEnabled(),
    fetchedAt: st.fetchedAt,
    lastCycleAt: st.lastCycleAt,
    lastError: st.lastError,
    staleHours: st.fetchedAt ? Math.round(((nowMs - new Date(st.fetchedAt).getTime()) / 3_600_000) * 10) / 10 : null,
    maxAgeDays: MAX_AGE_DAYS(),
    coins: [...st.coins].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    notes: [
      "REPORT-ONLY: tidak ada yang otomatis masuk universe/trading — promosi simbol tetap keputusan operator.",
      "Sumber: Binance exchangeInfo onboardDate (tanggal listing resmi) + CoinGecko (deskripsi/teknologi/mcap/FDV/dev-activity).",
      "score null / flag NO_FUNDAMENTAL_DATA = data belum ada — bukan nol, tidak difabrikasi.",
    ],
  };
}

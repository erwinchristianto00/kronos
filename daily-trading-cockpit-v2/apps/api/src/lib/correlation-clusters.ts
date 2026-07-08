/**
 * Correlation clusters for the position-concentration cap.
 *
 * The old cap treated EVERY non-BTC/ETH symbol as one "correlated alt" basket with a flat 3/direction
 * limit — so you could only ever hold 3 alts per side, however uncorrelated they were (the operator's
 * "each batch only opens 3 symbols, too slow"). This replaces that with a coarse CLUSTER map: the cap
 * applies PER cluster PER direction, so genuinely different baskets (an L1 short and a meme short) no
 * longer fight for the same 3 slots — while still blocking the concentration that caused a real loss
 * (a SUI/ADA/AVAX cluster dumping together; see the live-correlated-concentration-loss-cut incident).
 *
 * This map is a coarse first pass (NOT a live correlation matrix). To stay SAFE when it is wrong:
 *   - unknown symbols fall into a single shared "OTHER" cluster (grouped, not each free) — conservative;
 *   - a hard TOTAL position cap (maxConcurrentPositions) backstops it regardless of clustering accuracy.
 * Override the whole map with env CORRELATION_CLUSTER_MAP_JSON ({ "CLUSTER": ["SYMBOL", ...] }).
 *
 * BTC/ETH are the MAJORS cluster — kept exempt from the per-cluster cap (market benchmarks, the proven
 * prior behavior), bounded only by the total cap.
 */

export const MAJORS_CLUSTER = "MAJORS";
export const OTHER_CLUSTER = "OTHER";

/** Coarse category clusters for common Binance USDT-perp symbols. */
const DEFAULT_CLUSTER_MAP: Record<string, string[]> = {
  MAJORS: ["BTCUSDT", "ETHUSDT"],
  L1: [
    "SOLUSDT", "AVAXUSDT", "NEARUSDT", "SUIUSDT", "SEIUSDT", "APTUSDT", "ADAUSDT", "DOTUSDT",
    "ATOMUSDT", "TONUSDT", "TRXUSDT", "INJUSDT", "KASUSDT", "ALGOUSDT", "HBARUSDT",
  ],
  L2_DEFI: [
    "ARBUSDT", "OPUSDT", "LINKUSDT", "UNIUSDT", "AAVEUSDT", "MKRUSDT", "LDOUSDT", "CRVUSDT",
    "MATICUSDT", "STRKUSDT", "DYDXUSDT", "PENDLEUSDT",
  ],
  // "1000PEPEUSDT"/"1000SHIBUSDT"/"1000BONKUSDT"/"1000FLOKIUSDT" are the real Binance futures
  // symbols (1000x-multiplier contracts) — the bare names below never match what actually flows
  // through the pipeline (2026-07-08, same class of bug as cross-sectional-edge.ts's PEPEUSDT fix).
  MEME: ["DOGEUSDT", "WIFUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "1000BONKUSDT", "1000FLOKIUSDT", "1000SATSUSDT"],
  // "RNDRUSDT", not "RENDERUSDT" — Binance FUTURES renamed the RNDR contract to RENDER, but this
  // system scores/executes render tokens under the SPOT ticker "RNDRUSDT" throughout (2026-07-08:
  // confirmed "RENDERUSDT" never matches anything this pipeline actually passes to clusterOf()).
  AI: ["FETUSDT", "RNDRUSDT", "TAOUSDT", "WLDUSDT", "ARKMUSDT"],
};

function loadClusterMap(env: NodeJS.ProcessEnv = process.env): Record<string, string[]> {
  const raw = env.CORRELATION_CLUSTER_MAP_JSON;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(v)) out[k] = v.map((s) => String(s).toUpperCase());
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // fall through to default on any parse error
    }
  }
  return DEFAULT_CLUSTER_MAP;
}

/** symbol → cluster (memoized per resolved map). Unknown symbols → shared OTHER cluster. */
function buildSymbolIndex(map: Record<string, string[]>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [cluster, symbols] of Object.entries(map)) {
    for (const s of symbols) index.set(s.toUpperCase(), cluster);
  }
  return index;
}

let cachedMapRaw: string | undefined;
let cachedIndex: Map<string, string> | null = null;

export function clusterOf(symbol: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CORRELATION_CLUSTER_MAP_JSON ?? "";
  if (cachedIndex === null || cachedMapRaw !== raw) {
    cachedIndex = buildSymbolIndex(loadClusterMap(env));
    cachedMapRaw = raw;
  }
  return cachedIndex.get(symbol.toUpperCase()) ?? OTHER_CLUSTER;
}

export function isMajorCluster(cluster: string): boolean {
  return cluster === MAJORS_CLUSTER;
}

/** True for BTC/ETH — exempt from the per-cluster cap (bounded only by the total cap). */
export function isMajorSymbol(symbol: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return isMajorCluster(clusterOf(symbol, env));
}

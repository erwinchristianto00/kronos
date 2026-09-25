import type { CanonicalMarketRegimeSnapshot } from "./canonical-market-regime-engine.js";
import { DEFAULT_MAX_SNAPSHOT_AGE_MS } from "./canonical-market-regime-execution-policy.js";

/** Presentation only. Never replaces the controller or supplies execution permissions. */
export function buildMarketRegimeDisplay(snapshot: CanonicalMarketRegimeSnapshot, nowMs = Date.now()) {
  const ageMs = nowMs - snapshot.atMs;
  const validTime = Number.isFinite(ageMs) && ageMs >= 0;
  const usable = snapshot.status === "VALID" && snapshot.coverage.status === "VALID"
    && !snapshot.overlays.lowCoverage && snapshot.coverage.validSymbolCount > 0;
  const freshness = !validTime || !usable ? "UNAVAILABLE"
    : ageMs > DEFAULT_MAX_SNAPSHOT_AGE_MS ? "STALE" : "FRESH";
  return {
    source: "CANONICAL_MARKET_REGIME" as const,
    capturedAt: validTime && usable ? new Date(snapshot.atMs).toISOString() : null,
    maxAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
    freshness,
    projection: freshness === "FRESH" ? snapshot.projection : null,
    confidence: freshness === "FRESH" && Number.isFinite(snapshot.confidence)
      ? Math.min(1, Math.max(0, snapshot.confidence)) : null,
    validSymbolCount: snapshot.coverage.validSymbolCount,
    requiredSymbolCount: snapshot.coverage.requiredSymbolCount,
    reason: !validTime ? "Invalid snapshot timestamp"
      : !usable ? `Market data unavailable (${snapshot.status}; ${snapshot.coverage.status})`
      : freshness === "STALE" ? "Market snapshot is older than 20 minutes" : null,
  };
}

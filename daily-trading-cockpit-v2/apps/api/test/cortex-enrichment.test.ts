import { describe, it, expect } from "vitest";
import {
  classifyFreshness,
  moodFeatureValue,
  narrativeAlignFeatureValue,
  isCausalEvent,
  isSafetyEvent,
  type ExternalSignal,
  type MarketMood,
  type NarrativeContext,
} from "../src/lib/cortex-enrichment.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

function moodSig(over: Partial<ExternalSignal<MarketMood>> = {}, mood: Partial<MarketMood> = {}): ExternalSignal<MarketMood> {
  return {
    value: { score: 0.6, confidence: 0.8, ageMs: 0, sourceCoverage: 1, ...mood },
    observedAt: iso(-60_000),
    fetchedAt: iso(0),
    expiresAt: iso(3_600_000),
    source: "fear-greed+reddit",
    status: "FRESH",
    confidence: 0.8,
    ...over,
  };
}

describe("cortex-enrichment — freshness contract", () => {
  it("FRESH when recently observed and not expired", () => {
    expect(classifyFreshness({ observedAt: iso(-60_000), expiresAt: iso(3_600_000), nowMs: NOW, maxAgeMs: 6 * 3_600_000 })).toBe("FRESH");
  });
  it("STALE when older than maxAge", () => {
    expect(classifyFreshness({ observedAt: iso(-8 * 3_600_000), expiresAt: null, nowMs: NOW, maxAgeMs: 6 * 3_600_000 })).toBe("STALE");
  });
  it("STALE when past expiry even if recent", () => {
    expect(classifyFreshness({ observedAt: iso(-60_000), expiresAt: iso(-1), nowMs: NOW, maxAgeMs: 6 * 3_600_000 })).toBe("STALE");
  });
  it("MISSING when no observedAt", () => {
    expect(classifyFreshness({ observedAt: null, expiresAt: null, nowMs: NOW, maxAgeMs: 6 * 3_600_000 })).toBe("MISSING");
  });
  it("[REGRESSION 2026-07-22] STALE (not FRESH) when observedAt is in the FUTURE (clock-skewed or corrupted fetcher) — nowMs-obs is negative and would otherwise never exceed maxAgeMs", () => {
    expect(classifyFreshness({ observedAt: iso(10 * 60_000), expiresAt: iso(3_600_000), nowMs: NOW, maxAgeMs: 6 * 3_600_000 })).toBe("STALE");
  });
});

describe("cortex-enrichment — neutral-on-stale (confidence gates, never carry-forward)", () => {
  it("FRESH mood → score weighted by inner confidence × coverage × OUTER signal.confidence (2026-07-22 fix: outer provenance confidence — default 0.8 from moodSig() — was previously ignored)", () => {
    const v = moodFeatureValue(moodSig({}, { score: 0.6, confidence: 0.5, sourceCoverage: 0.5 }));
    expect(v).toBeCloseTo(0.6 * 0.5 * 0.5 * 0.8, 6);
  });
  it("[REGRESSION 2026-07-22] a low outer signal.confidence (degraded fetch) discounts the feature even when the inner MarketMood.confidence is high", () => {
    const highOuterConfidence = moodFeatureValue(moodSig({ confidence: 0.95 }, { score: 0.9, confidence: 0.95, sourceCoverage: 1 }));
    const lowOuterConfidence = moodFeatureValue(moodSig({ confidence: 0.1 }, { score: 0.9, confidence: 0.95, sourceCoverage: 1 }));
    expect(lowOuterConfidence).toBeCloseTo(0.9 * 0.95 * 1 * 0.1, 6);
    expect(Math.abs(lowOuterConfidence)).toBeLessThan(Math.abs(highOuterConfidence));
  });
  it("STALE / MISSING / ERROR mood → 0 (no carry-forward)", () => {
    expect(moodFeatureValue(moodSig({ status: "STALE" }))).toBe(0);
    expect(moodFeatureValue(moodSig({ status: "MISSING" }))).toBe(0);
    expect(moodFeatureValue(moodSig({ status: "ERROR" }))).toBe(0);
    expect(moodFeatureValue(null)).toBe(0);
  });
  it("low source coverage down-weights the mood toward 0", () => {
    const full = moodFeatureValue(moodSig({}, { sourceCoverage: 1 }));
    const thin = moodFeatureValue(moodSig({}, { sourceCoverage: 0.1 }));
    expect(Math.abs(thin)).toBeLessThan(Math.abs(full));
  });
});

describe("cortex-enrichment — narrative alignment", () => {
  const narr = (over: Partial<NarrativeContext> = {}, status: ExternalSignal<NarrativeContext>["status"] = "FRESH"): ExternalSignal<NarrativeContext> => ({
    value: { tags: ["AI"], momentum: 0.7, breadth: 0.8, crowding: 0.2, alignment: 0.9, freshnessMs: 0, ...over },
    observedAt: iso(-60_000), fetchedAt: iso(0), expiresAt: iso(3_600_000), source: "narrative-tags", status, confidence: 1,
  });
  it("aligned + broad narrative → positive feature", () => {
    expect(narrativeAlignFeatureValue(narr())).toBeGreaterThan(0.3);
  });
  it("momentum without breadth (one-coin pump) is discounted vs broad", () => {
    const broad = narrativeAlignFeatureValue(narr({ breadth: 0.9 }));
    const thin = narrativeAlignFeatureValue(narr({ breadth: 0.05 }));
    expect(thin).toBeLessThan(broad);
  });
  it("not-FRESH narrative → 0", () => {
    expect(narrativeAlignFeatureValue(narr({}, "STALE"))).toBe(0);
  });
});

describe("cortex-enrichment — leakage gate + safety split", () => {
  it("event is causal only if first seen at/before the decision", () => {
    expect(isCausalEvent(NOW - 5 * 60_000, NOW)).toBe(true); // seen 14:00 for a 14:00 decision
    expect(isCausalEvent(NOW + 5 * 60_000, NOW)).toBe(false); // headline at 14:05 can't drive 14:00 (look-ahead)
    expect(isCausalEvent(NaN, NOW)).toBe(false);
  });
  it("safety categories are the narrow deterministic set; generic geopolitical is NOT", () => {
    expect(isSafetyEvent("STABLECOIN_DEPEG")).toBe(true);
    expect(isSafetyEvent("EXCHANGE_HACK")).toBe(true);
    expect(isSafetyEvent("EXPLOIT")).toBe(true);
    expect(isSafetyEvent("GEOPOLITICAL")).toBe(false); // must never be able to halt the system alone
    expect(isSafetyEvent("ETF")).toBe(false); // predictive, not a safety rail
    expect(isSafetyEvent(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { buildCortexShadowDecisionAlphaReport } from "../src/lib/cortex-decision-alpha-report.js";
import {
  _resetLatestCortexShadowDecisionAlphaForTests,
  _resetLatestCortexShadowDecisionAlphaTodayForTests,
  _setLatestCortexShadowDecisionAlphaTodayForTests,
  startOfUtcDayMs,
} from "../src/lib/cortex-refit-runner-bindings.js";

describe("buildCortexShadowDecisionAlphaReport (#219, 2026-07-20)", () => {
  it("before any refit cycle has populated the cache, reports zero examples, never a fabricated 0-edge", () => {
    _resetLatestCortexShadowDecisionAlphaForTests();
    const report = buildCortexShadowDecisionAlphaReport({ nowMs: Date.parse("2026-07-20T00:00:00Z") });
    expect(report.reportOnly).toBe(true);
    expect(report.examplesConsidered).toBe(0);
    expect(report.journalBadLines).toBe(0);
    expect(report.decisionAlpha).toEqual({ n: 0, cumulativeTiltDeltaR: 0, meanTiltDeltaR: null, perLane: [], clusteredCi95: null });
  });

  it("before any refit cycle, the #219 'today' slice also reports zero examples with a correctly-derived UTC day boundary", () => {
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetLatestCortexShadowDecisionAlphaTodayForTests();
    const nowMs = Date.parse("2026-07-21T09:12:00Z");
    const report = buildCortexShadowDecisionAlphaReport({ nowMs });
    expect(report.today.examplesConsidered).toBe(0);
    expect(report.today.decisionAlpha).toEqual({ n: 0, cumulativeTiltDeltaR: 0, meanTiltDeltaR: null, perLane: [], clusteredCi95: null });
    expect(Date.parse(report.today.dayStart)).toBe(startOfUtcDayMs(nowMs));
  });

  it("[2026-07-22 bug-hunt fix] a cachedToday left over from a PRIOR UTC day is never mislabeled as today's data — falls back to an honest empty 'today' until the next refit tick catches up", () => {
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetLatestCortexShadowDecisionAlphaTodayForTests();
    // Simulate: the refit tick last ran late on 2026-07-20 (still that day's dayStartMs), but "now" is
    // already well into 2026-07-21 — a real, everyday gap given the default 6h refit cadence isn't
    // aligned to UTC midnight.
    const yesterdayDayStartMs = startOfUtcDayMs(Date.parse("2026-07-20T23:50:00Z"));
    _setLatestCortexShadowDecisionAlphaTodayForTests({
      generatedAtMs: Date.parse("2026-07-20T23:50:00Z"),
      dayStartMs: yesterdayDayStartMs,
      examplesConsidered: 42,
      decisionAlpha: { n: 42, cumulativeTiltDeltaR: 1.23, meanTiltDeltaR: 0.0293, perLane: [], clusteredCi95: null },
    });
    const nowMs = Date.parse("2026-07-21T02:15:00Z"); // ~2h15m into the new UTC day
    const report = buildCortexShadowDecisionAlphaReport({ nowMs });
    // Must NOT surface yesterday's 42 examples / real deltaR under today's label.
    expect(report.today.examplesConsidered).toBe(0);
    expect(report.today.decisionAlpha).toEqual({ n: 0, cumulativeTiltDeltaR: 0, meanTiltDeltaR: null, perLane: [], clusteredCi95: null });
    expect(Date.parse(report.today.dayStart)).toBe(startOfUtcDayMs(nowMs));
    expect(Date.parse(report.today.dayStart)).not.toBe(yesterdayDayStartMs);
  });

  it("a cachedToday matching the CURRENT UTC day is trusted as-is", () => {
    _resetLatestCortexShadowDecisionAlphaForTests();
    _resetLatestCortexShadowDecisionAlphaTodayForTests();
    const nowMs = Date.parse("2026-07-21T09:12:00Z");
    _setLatestCortexShadowDecisionAlphaTodayForTests({
      generatedAtMs: nowMs,
      dayStartMs: startOfUtcDayMs(nowMs),
      examplesConsidered: 7,
      decisionAlpha: { n: 7, cumulativeTiltDeltaR: 0.5, meanTiltDeltaR: 0.0714, perLane: [], clusteredCi95: null },
    });
    const report = buildCortexShadowDecisionAlphaReport({ nowMs: nowMs + 60_000 });
    expect(report.today.examplesConsidered).toBe(7);
    expect(report.today.decisionAlpha.n).toBe(7);
  });

  it("is a pure read: never triggers any disk I/O of its own (reads only the in-memory cache)", () => {
    _resetLatestCortexShadowDecisionAlphaForTests();
    // No dataDir/journalFile options exist anymore on the report builder — this is now a synchronous,
    // disk-free read of whatever the nightly refit cycle last cached. The absence of those params in the
    // type signature itself is the regression guard for the 2026-07-20 event-loop-blocking incident.
    expect(() => buildCortexShadowDecisionAlphaReport({ nowMs: Date.now() })).not.toThrow();
  });
});

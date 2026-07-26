import { describe, it, expect } from "vitest";
import { classifySource, freshValueOr } from "../src/lib/four-brain-types.js";
import { untimedSrc } from "./four-brain-fixtures.js";

/**
 * 2026-07-26 regression: classifySource() granted FRESH to any value that arrived without a
 * timestamp, even under a configured TTL — a fail-OPEN on the freshness contract, and a silent one
 * (the payload read FRESH). Observed on research/3101: app.ts derives every Direction reading's
 * observedAtMs from axisAtMs, which is null whenever axisScore is MISSING, so longEdge / conviction
 * / longLaneEdge / shortLaneEdge were reported FRESH permanently over values of unknown age.
 *
 * classifySource had NO test file at all before this one.
 */
describe("classifySource — untimed values must not claim freshness", () => {
  const NOW = 1_700_000_000_000;
  const TTL = 15 * 60_000;

  it("FAIL-WITHOUT: an untimed value under a configured TTL is STALE, not FRESH", () => {
    // Pre-fix this returned "FRESH": `typeof asOf === "number"` was false, so the whole TTL block
    // was skipped and control fell through to `return "FRESH"`.
    expect(classifySource(untimedSrc(0.42), NOW, TTL)).toBe("STALE");
  });

  it("the untimed value is then actually dropped downstream, not merely relabelled", () => {
    const s = untimedSrc(0.42);
    const status = classifySource(s, NOW, TTL);
    expect(freshValueOr(s, status, -1)).toBe(-1); // neutral, never the unverifiable 0.42
  });

  it("a genuinely timeless source (no TTL configured) still reads FRESH", () => {
    // The caller made no recency claim, so there is nothing to fail closed on.
    expect(classifySource(untimedSrc(0.42), NOW, 0)).toBe("FRESH");
    expect(classifySource(untimedSrc(0.42), NOW, Number.POSITIVE_INFINITY)).toBe("FRESH");
    expect(classifySource(untimedSrc(0.42), NOW, Number.NaN)).toBe("FRESH");
  });

  it("MISSING still wins over the new STALE branch (value absent is checked first)", () => {
    // four-brain-live-gather-bindings.ts's `missing()` helper emits {normalized: null,
    // observedAtMs: null}; it must stay MISSING so missingReason keeps being recorded.
    expect(classifySource(untimedSrc(null), NOW, TTL)).toBe("MISSING");
    expect(classifySource(null, NOW, TTL)).toBe("MISSING");
    expect(classifySource(undefined, NOW, TTL)).toBe("MISSING");
  });

  it("timestamped behaviour is untouched: FRESH / STALE / ERROR boundaries hold", () => {
    expect(classifySource({ value: 1, asOfMs: NOW }, NOW, TTL)).toBe("FRESH");
    expect(classifySource({ value: 1, asOfMs: NOW - TTL }, NOW, TTL)).toBe("FRESH"); // exactly at TTL
    expect(classifySource({ value: 1, asOfMs: NOW - TTL - 1 }, NOW, TTL)).toBe("STALE");
    expect(classifySource({ value: 1, asOfMs: NOW + 60_001 }, NOW, TTL)).toBe("ERROR"); // future, past skew
    expect(classifySource({ value: 1, asOfMs: Number.NaN }, NOW, TTL)).toBe("ERROR");
    expect(classifySource({ value: Number.NaN, asOfMs: NOW }, NOW, TTL)).toBe("ERROR");
  });
});

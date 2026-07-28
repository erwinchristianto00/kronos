/**
 * SCALE CORRECTION (2026-07-28). The fixtures below used to pass 0.8 / 0.1 / 0.95, i.e. the 0..1
 * scale the implementation wrongly assumed. `kronosConfidence` is 0..100 — tracker.ts's own buckets
 * settle it (<45 WEAK, <70 MEDIUM, >=70 STRONG) and every live scan row measured that day carried
 * exactly 100. Under the old code `Math.min(1, confidence)` saturated every real reading to 1.0, so
 * these tests passed while production could not distinguish a 46 from a 99. Fixtures now use the
 * scale producers actually emit. See kronos-btc-anchor.test.ts for the fail-without/pass-with pair.
 */
import { describe, it, expect } from "vitest";
import { kronosAgreeFromScan } from "../src/lib/kronos-agree-reading.js";
import type { Candidate } from "@dtc/shared";

/**
 * `kronosAgree` was a hardcoded null in app.ts — "no sync kronos-agree producer" — so the Direction
 * Brain has been calling market direction on ~2 of its 5 sub-signals. Kronos was never unreachable:
 * it runs on the VPS and the scanner already calls it every cycle. These tests pin the mapping and,
 * above all, that an ABSENT opinion returns null and never 0 — the consumer treats a finite value as
 * a real reading and stamps it FRESH, so a fabricated neutral is worse than no value at all.
 */
const AT = 1_800_000_000_000;
const cand = (o: Partial<Candidate> = {}): Candidate =>
  ({ symbol: "BTCUSDT", selectedKronosBias: "LONG", kronosConfidence: 80, ...o }) as unknown as Candidate;

describe("kronosAgreeFromScan — mapping to −1..1", () => {
  it("LONG is positive and SHORT is negative, scaled by the model's own confidence", () => {
    expect(kronosAgreeFromScan([cand()], "BTCUSDT", AT)).toEqual({ agree: 0.8, atMs: AT });
    expect(kronosAgreeFromScan([cand({ selectedKronosBias: "SHORT" })], "BTCUSDT", AT)).toEqual({ agree: -0.8, atMs: AT });
  });

  it("a hesitant call cannot push as hard as a certain one", () => {
    const weak = kronosAgreeFromScan([cand({ kronosConfidence: 10 })], "BTCUSDT", AT).agree!;
    const strong = kronosAgreeFromScan([cand({ kronosConfidence: 95 })], "BTCUSDT", AT).agree!;
    expect(Math.abs(weak)).toBeLessThan(Math.abs(strong));
  });

  it("stays inside −1..1 even if a confidence ever arrives out of range", () => {
    expect(kronosAgreeFromScan([cand({ kronosConfidence: 400 })], "BTCUSDT", AT).agree).toBe(1);
  });

  it("prefers the scanner's resolved pick over the single-timeframe fallback", () => {
    const c = cand({ selectedKronosBias: "SHORT", kronosBias: "LONG" });
    expect(kronosAgreeFromScan([c], "BTCUSDT", AT).agree).toBeLessThan(0);
  });

  it("falls back to kronosBias when no resolved pick exists", () => {
    const c = cand({ selectedKronosBias: null, kronosBias: "LONG" });
    expect(kronosAgreeFromScan([c], "BTCUSDT", AT).agree).toBe(0.8);
  });

  it("carries the SCAN's clock, not the reader's", () => {
    expect(kronosAgreeFromScan([cand()], "BTCUSDT", AT).atMs).toBe(AT);
  });

  it("matches the symbol case-insensitively and ignores other rows", () => {
    const rows = [cand({ symbol: "ETHUSDT", selectedKronosBias: "SHORT" }), cand({ symbol: "btcusdt" })];
    expect(kronosAgreeFromScan(rows, "BTCUSDT", AT).agree).toBe(0.8);
  });
});

describe("absent is null, never a fabricated 0", () => {
  /** THE RULE THAT MATTERS. classifySource stamps any finite value FRESH, so a 0 would enter the
   *  Direction score as a genuine "no opinion" reading from a live source. */
  it.each([
    ["UNAVAILABLE bias", cand({ selectedKronosBias: "UNAVAILABLE", kronosBias: "UNAVAILABLE" })],
    ["no bias at all", cand({ selectedKronosBias: null, kronosBias: undefined as never })],
    ["missing confidence", cand({ kronosConfidence: null })],
    ["non-finite confidence", cand({ kronosConfidence: Number.NaN })],
    ["zero confidence", cand({ kronosConfidence: 0 })],
  ])("%s ⇒ null", (_label, c) => {
    expect(kronosAgreeFromScan([c], "BTCUSDT", AT)).toEqual({ agree: null, atMs: null });
  });

  it.each([
    ["no candidates", [] as Candidate[]],
    ["null candidates", null],
    ["symbol not present", [cand({ symbol: "ETHUSDT" })]],
  ])("%s ⇒ null", (_label, rows) => {
    expect(kronosAgreeFromScan(rows, "BTCUSDT", AT)).toEqual({ agree: null, atMs: null });
  });

  /** No producer clock ⇒ no reading. A value without a timestamp cannot be freshness-gated, and the
   *  consumer's fail-closed classifier would have to guess. */
  it("a usable opinion with no scan clock is still null", () => {
    expect(kronosAgreeFromScan([cand()], "BTCUSDT", null)).toEqual({ agree: null, atMs: null });
  });
});

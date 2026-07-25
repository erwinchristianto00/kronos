import { describe, it, expect } from "vitest";
import type { Candle } from "@dtc/shared";
import { HOUR } from "../src/lib/replay-tier-a-core.js";
import {
  resolveDirectionOutcome,
  computeDirectionEffectiveSampleSize,
  HORIZON_MS,
  MAX_UNRESOLVABLE_STALENESS_MS,
  type ResolvedDirectionOutcome,
} from "../src/lib/direction-brain-resolver.js";
import type { PendingDirectionRow, FourBrainOutcomeHorizon, FourBrainOutcomeDirectionAction } from "../src/lib/four-brain-outcome-ledger.js";

// ── Fixture builder ───────────────────────────────────────────────────────────────────────────────────
// Flat BTC price series (close=100, high=105, low=95 every bar → constant TR=10 → ATR14=10 exactly once
// warmed up) with ONE candle (at `jumpIndex`) whose close is overridden to `jumpClose`. entryIdx is
// always 14 for asOfMs = 15*HOUR (candles[14].openTime=14*HOUR, availableAt=15*HOUR<=asOfMs; candles[15]
// availableAt=16*HOUR>asOfMs). risk at entry = RISK_ATR_MULT(1.5) * ATR14(10) = 15.
function makeCandles(count: number, jumpIndex: number | null, jumpClose: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = i === jumpIndex ? jumpClose : 100;
    out.push({ openTime: i * HOUR, open: 100, high: Math.max(100, close) + 5, low: Math.min(100, close) - 5, close, volume: 1 });
  }
  return out;
}

const ENTRY_IDX = 14;
const AS_OF_MS = ENTRY_IDX * HOUR + HOUR; // 15*HOUR
const RISK = 15; // 1.5 * ATR14(10)
const COST_R = 22 / ((RISK / 100) * 10_000); // ENTRY_ROUNDTRIP_COST_BPS / stopDistBps = 22/1500

function row(horizon: FourBrainOutcomeHorizon, action: FourBrainOutcomeDirectionAction, expectedDirectionalR: number | null = null): PendingDirectionRow {
  return { decisionId: `dir-${horizon}-${action}`, asOfMs: AS_OF_MS, horizon, action, expectedDirectionalR };
}

function exitIndexFor(horizon: FourBrainOutcomeHorizon): number {
  return ENTRY_IDX + HORIZON_MS[horizon] / HOUR;
}

describe("resolveDirectionOutcome", () => {
  it("LONG win: a real favorable move clears the hurdle net of cost", () => {
    const exitIdx = exitIndexFor("SCALP");
    const candles = makeCandles(exitIdx + 3, exitIdx, 115); // Δ=+15 → grossLong = 15/15 = 1.0
    const out = resolveDirectionOutcome(row("SCALP", "LONG", 0.5), candles, AS_OF_MS + HORIZON_MS.SCALP + HOUR);

    expect(out.status).toBe("EVALUATED");
    expect(out.entryPrice).toBe(100);
    expect(out.exitPrice).toBe(115);
    expect(out.riskAtEntry).toBeCloseTo(RISK, 9);
    expect(out.longNetR).toBeCloseTo(1.0 - COST_R, 9);
    expect(out.chosenNetR).toBeCloseTo(1.0 - COST_R, 9);
    expect(out.win).toBe(1);
    expect(out.regretR).toBeCloseTo(0, 9); // chosenNetR IS the max side for LONG here
    expect(out.calibrationGapR).toBeCloseTo(0.5 - (1.0 - COST_R), 9);
  });

  it("LONG loss: an adverse move fails the hurdle net of cost", () => {
    const exitIdx = exitIndexFor("SCALP");
    const candles = makeCandles(exitIdx + 3, exitIdx, 85); // Δ=-15 → grossLong = -1.0
    const out = resolveDirectionOutcome(row("SCALP", "LONG"), candles, AS_OF_MS + HORIZON_MS.SCALP + HOUR);

    expect(out.status).toBe("EVALUATED");
    expect(out.longNetR).toBeCloseTo(-1.0 - COST_R, 9);
    expect(out.chosenNetR).toBeCloseTo(-1.0 - COST_R, 9);
    expect(out.win).toBe(0);
    expect(out.calibrationGapR).toBeNull(); // expectedDirectionalR was null on this row
  });

  it("FLAT correct: no real move existed on either side — netR pinned at 0, regret exactly 0", () => {
    const exitIdx = exitIndexFor("SCALP");
    const candles = makeCandles(exitIdx + 3, exitIdx, 100); // Δ=0 → both sides only pay cost, net negative
    const out = resolveDirectionOutcome(row("SCALP", "FLAT"), candles, AS_OF_MS + HORIZON_MS.SCALP + HOUR);

    expect(out.status).toBe("EVALUATED");
    expect(out.chosenNetR).toBe(0); // PINNED, never derived
    expect(out.longNetR).toBeCloseTo(-COST_R, 9);
    expect(out.shortNetR).toBeCloseTo(-COST_R, 9);
    expect(out.win).toBe(1); // neither side cleared the hurdle → FLAT was objectively correct
    expect(out.regretR).toBeCloseTo(0, 9); // floored: max(long,short) was itself negative
    expect(out.calibrationGapR).toBeNull(); // never invented for FLAT
  });

  it("FLAT incorrect: a real favorable LONG move existed — regret > 0, headline win = 0", () => {
    const exitIdx = exitIndexFor("SCALP");
    const candles = makeCandles(exitIdx + 3, exitIdx, 115); // Δ=+15, same move as the LONG-win case
    const out = resolveDirectionOutcome(row("SCALP", "FLAT"), candles, AS_OF_MS + HORIZON_MS.SCALP + HOUR);

    expect(out.status).toBe("EVALUATED");
    expect(out.chosenNetR).toBe(0);
    expect(out.win).toBe(0); // LONG would have cleared the hurdle → FLAT was the wrong call
    expect(out.regretR).toBeCloseTo(1.0 - COST_R, 9); // max(longNetR, shortNetR) - 0
    expect(out.calibrationGapR).toBeNull();
  });

  it("BOTH requires BOTH legs to clear the hurdle, not just the mean", () => {
    const exitIdx = exitIndexFor("SCALP");
    const candles = makeCandles(exitIdx + 3, exitIdx, 115); // Δ=+15: longNetR huge, shortNetR deeply negative
    const out = resolveDirectionOutcome(row("SCALP", "BOTH", 0.9), candles, AS_OF_MS + HORIZON_MS.SCALP + HOUR);

    expect(out.status).toBe("EVALUATED");
    // mean cancels the directional move entirely, leaving only the (negative) double-cost drag —
    // a real, structural finding: BOTH can never beat cost when longNetR + shortNetR = -2*costR always.
    expect(out.chosenNetR).toBeCloseTo(-COST_R, 9);
    expect(out.win).toBe(0); // longNetR alone clears the hurdle handily, but shortNetR does not — BOTH loses
    expect(out.regretR).toBeCloseTo(1.0, 9); // max(longNetR, shortNetR) - chosenNetR = (1-costR) - (-costR) = 1.0
    expect(out.calibrationGapR).toBeNull(); // never invented for BOTH
  });

  it("causality: appending candles strictly AFTER targetExitMs never changes the resolved outcome", () => {
    const exitIdx = exitIndexFor("INTRADAY");
    const base = makeCandles(exitIdx + 1, exitIdx, 130);
    const r = row("INTRADAY", "LONG", 0.2);
    const nowMs = AS_OF_MS + HORIZON_MS.INTRADAY + HOUR;

    const withoutFuture = resolveDirectionOutcome(r, base, nowMs);

    // Append many MORE candles after targetExitMs with wildly different (diverging) prices, and also
    // push `nowMs` far further into the future — neither should change which candle is the exit
    // reference nor any downstream number.
    const withFuture: Candle[] = [...base];
    for (let i = base.length; i < base.length + 50; i++) {
      withFuture.push({ openTime: i * HOUR, open: 9999, high: 10999, low: 8999, close: 9999, volume: 1 });
    }
    const withFutureResolved: ResolvedDirectionOutcome = resolveDirectionOutcome(r, withFuture, nowMs + 1000 * HOUR);

    expect(withFutureResolved).toEqual(withoutFuture);
    expect(withoutFuture.status).toBe("EVALUATED");
  });

  it("PENDING while the horizon has not yet elapsed", () => {
    const exitIdx = exitIndexFor("SWING");
    const candles = makeCandles(exitIdx + 1, exitIdx, 120);
    const out = resolveDirectionOutcome(row("SWING", "LONG"), candles, AS_OF_MS + HORIZON_MS.SWING - 1);
    expect(out.status).toBe("PENDING");
    expect(out.chosenNetR).toBeNull();
  });

  it("INSTRUMENT_DATA_MISSING when the candle series gaps exactly across the needed exit window", () => {
    const exitIdx = exitIndexFor("SCALP");
    const full = makeCandles(exitIdx + 3, exitIdx, 115);
    const gapped = full.filter((_, i) => i !== exitIdx); // drop the exact candle needed as the exit reference
    const nowMs = AS_OF_MS + HORIZON_MS.SCALP + HOUR; // well past target, but within the staleness window
    const out = resolveDirectionOutcome(row("SCALP", "LONG"), gapped, nowMs);
    expect(out.status).toBe("INSTRUMENT_DATA_MISSING");
    expect(out.chosenNetR).toBeNull();
  });

  it("EXPIRED_UNRESOLVABLE once the data gap has persisted past the staleness window", () => {
    const exitIdx = exitIndexFor("SCALP");
    const full = makeCandles(exitIdx + 3, exitIdx, 115);
    const gapped = full.filter((_, i) => i !== exitIdx);
    const nowMs = AS_OF_MS + HORIZON_MS.SCALP + MAX_UNRESOLVABLE_STALENESS_MS + HOUR;
    const out = resolveDirectionOutcome(row("SCALP", "LONG"), gapped, nowMs);
    expect(out.status).toBe("EXPIRED_UNRESOLVABLE");
  });

  it("detects an hourly gap FAR back in the ATR trailing window (beyond the old 14-bar-only check) and refuses to fabricate a distorted riskAtEntry", () => {
    // entryIdx = 200. A one-off 2h (instead of 1h) step is introduced at index 100 — 100 bars before
    // entryIdx. That's well outside a 14-bar (ATR_PERIOD) lookback but inside a 168-bar
    // (GAP_LOOKBACK_BARS) lookback, i.e. exactly the blind spot the review flagged: ATR14 is a
    // RECURSIVE smoother (atr[i] = atr[i-1]*13/14 + tr[i]/14), so a corrupted true-range 100 bars back
    // still bleeds a non-trivial (decayed, not zeroed) weight into atrAtEntry — the resolver must not
    // silently accept it as "clean" just because it's outside the last 14 bars.
    const ENTRY = 200;
    const GAP_AT = 100; // ENTRY - 100, inside GAP_LOOKBACK_BARS(168) but outside ATR_PERIOD(14)
    const total = ENTRY + 5;
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < total; i++) {
      if (i === GAP_AT) t += 2 * HOUR; // one missing hourly bar right here
      else if (i > 0) t += HOUR;
      candles.push({ openTime: t, open: 100, high: 105, low: 95, close: 100, volume: 1 });
    }

    const asOfMs = candles[ENTRY]!.openTime + HOUR; // exactly entryAvailableAt — entryIdx resolves to ENTRY
    const r: PendingDirectionRow = { decisionId: "dir-gap-far-back", asOfMs, horizon: "SCALP", action: "LONG", expectedDirectionalR: null };
    const nowMs = asOfMs + HORIZON_MS.SCALP + HOUR;

    const out = resolveDirectionOutcome(r, candles, nowMs);

    // Must NOT be EVALUATED with a fabricated riskAtEntry computed over a window that silently
    // contained a gap — must be refused as a data-integrity failure instead.
    expect(out.status).toBe("INSTRUMENT_DATA_MISSING");
    expect(out.riskAtEntry).toBeNull();
    expect(out.chosenNetR).toBeNull();
  });
});

describe("computeDirectionEffectiveSampleSize", () => {
  it("clusters overlapping decisions into non-overlapping horizon-window blocks, alongside raw n", () => {
    const swingWindow = HORIZON_MS.SWING; // 24h = 86_400_000ms
    const intradayWindow = HORIZON_MS.INTRADAY; // 4h

    const resolved = [
      // 3 SWING decisions all inside block 0 (asOfMs in [0, swingWindow)) — correlated, same window.
      { horizon: "SWING" as const, asOfMs: 0 },
      { horizon: "SWING" as const, asOfMs: 5 * HOUR },
      { horizon: "SWING" as const, asOfMs: 10 * HOUR },
      // 1 more SWING decision a full window later — a genuinely independent block.
      { horizon: "SWING" as const, asOfMs: swingWindow + 1 * HOUR },
      // 2 INTRADAY decisions inside the same 4h block.
      { horizon: "INTRADAY" as const, asOfMs: 0 },
      { horizon: "INTRADAY" as const, asOfMs: 1 * HOUR },
    ];

    const result = computeDirectionEffectiveSampleSize(resolved);
    const swing = result.find((r) => r.horizon === "SWING")!;
    const intraday = result.find((r) => r.horizon === "INTRADAY")!;

    expect(swing.rawN).toBe(4);
    expect(swing.effectiveN).toBe(2); // raw n overstates precision — only 2 independent windows
    expect(intraday.rawN).toBe(2);
    expect(intraday.effectiveN).toBe(1);
  });
});

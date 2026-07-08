import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

import { CrossSectionalStore, type CrossSectionalObservation } from "../src/lib/cross-sectional-edge.js";
import { buildTpSweepReport } from "../src/lib/cross-sectional-tp-sweep.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2099-01-02T00:00:00.000Z");
const COST = 0.0012; // 12 bps house cost model

function closedBasket(id: string, horizonNet: number): CrossSectionalObservation {
  return {
    observationId: id,
    openedAt: new Date(T0).toISOString(),
    openedAtMs: T0,
    horizonMs: 24 * HOUR,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    k: 1,
    longLeg: [{ symbol: "AUSDT", entryPrice: 100, exitPrice: 101 }],
    shortLeg: [],
    status: "CLOSED",
    grossReturn: horizonNet + COST,
    costReturn: COST,
    netReturn: horizonNet,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: new Date(T0 + 24 * HOUR).toISOString(),
  };
}

/** Price 100.5 for hours 1-2, then 101.5 from hour 3 on: with a single long leg the basket net is
 *  (p/100 − 1)/2 − cost, so 0.6% is first touched exactly at hour 3; 1.33% never touches. */
function stepPath(): Candle[] {
  return Array.from({ length: 27 }, (_, i) => {
    const openTime = T0 - HOUR + i * HOUR;
    const hoursAfterOpen = (openTime + HOUR - T0) / HOUR; // candle CLOSES at openTime+1h
    const price = hoursAfterOpen >= 3 ? 101.5 : 100.5;
    return { openTime, open: price, high: price, low: price, close: price, volume: 1 };
  });
}

describe("cross-sectional TP-threshold sweep (EV per slot-day)", () => {
  it("[SWEEP] touched threshold exits at first touch; untouched rides to the stored horizon outcome", async () => {
    const store = new CrossSectionalStore(mkdtempSync(join(tmpdir(), "xsec-sweep-")));
    store.add(closedBasket("b1", 0.004) as never); // horizon outcome +0.4%
    const report = await buildTpSweepReport(store, async () => stepPath(), {
      thresholdsPct: [0.6, 1.33],
      nowIso: () => "2099-02-01T00:00:00.000Z",
    });
    expect(report.closedCompleteBaskets).toBe(1);
    const row06 = report.rows.find((r) => r.thresholdPct === 0.6)!;
    expect(row06.touched).toBe(1);
    expect(row06.meanHoldHours).toBeCloseTo(3, 6);
    expect(row06.meanNetReturnPct).toBeCloseTo(0.6, 6);
    // EV per slot-day = 0.6% × (24h / 3h) = 4.8%/day
    expect(row06.evPerSlotDayPct).toBeCloseTo(4.8, 6);
    const row133 = report.rows.find((r) => r.thresholdPct === 1.33)!;
    expect(row133.touched).toBe(0);
    expect(row133.meanHoldHours).toBeCloseTo(24, 6);
    expect(row133.meanNetReturnPct).toBeCloseTo(0.4, 6); // stored horizon net
    expect(row133.evPerSlotDayPct).toBeCloseTo(0.4, 6);
    expect(row133.approxUsdOnStandardBasket).toBeCloseTo(2, 2); // ≈ the operator's "$2" intuition
  });

  it("[SWEEP-COVERAGE] a basket without candle coverage is excluded, not mispriced", async () => {
    const store = new CrossSectionalStore(mkdtempSync(join(tmpdir(), "xsec-sweep2-")));
    store.add(closedBasket("b1", 0.004) as never);
    const report = await buildTpSweepReport(store, async () => [], {
      thresholdsPct: [0.6],
      nowIso: () => "2099-02-01T00:00:00.000Z",
    });
    expect(report.closedCompleteBaskets).toBe(0);
    expect(report.excludedNoCandleCoverage).toBe(1);
  });
});

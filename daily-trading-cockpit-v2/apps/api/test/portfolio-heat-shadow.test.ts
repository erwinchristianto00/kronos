import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeHeatShadowSnapshot,
  recordHeatShadowSnapshot,
} from "../src/lib/portfolio-heat-shadow.js";

const tmp = () => mkdtempSync(join(tmpdir(), "heat-shadow-"));

// Minimal order shape the module reads. base time = a fixed ISO so TW-day is deterministic.
function ord(
  id: string,
  openOffsetMin: number,
  holdMin: number,
  netR: number,
): {
  paperOrderId: string;
  paperStatus: string;
  openedAt: string;
  updatedAt: string;
  netR: number;
  netPnlAmount: number;
  plannedRiskAmount: number;
} {
  const base = Date.parse("2026-06-08T00:00:00.000Z");
  const openedAt = new Date(base + openOffsetMin * 60_000).toISOString();
  const updatedAt = new Date(base + (openOffsetMin + holdMin) * 60_000).toISOString();
  return {
    paperOrderId: id,
    paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
    openedAt,
    updatedAt,
    netR,
    netPnlAmount: netR * 20,
    plannedRiskAmount: 20,
  };
}

describe("portfolio-heat-shadow", () => {
  // [HS-1] sweep shape + survivorship signature: uncapped has the highest peak risk and (net-positive
  // book) the highest terminal equity; tighter caps strictly reduce peak risk.
  it("[HS-1] heat sweep: uncapped maximizes both terminal equity and peak risk on a net-positive book", () => {
    // 15 longs opening together (heavy concurrency) all winning +1R, then 1 loser -1R later.
    // 15 × 1% = 15% peak heat, so even the smallest sweep cap (10%) actually binds.
    const orders = [
      ...Array.from({ length: 15 }, (_, i) => ord(`w${i}`, 0, 60, 1)),
      ord("l1", 120, 60, -1),
    ];
    const snap = computeHeatShadowSnapshot(orders, 2000, "2026-06-08T12:00:00.000Z");

    expect(snap.reportOnly).toBe(true);
    expect(snap.measurementOnly).toBe(true);
    expect(snap.heatSweep.length).toBe(8);

    const uncapped = snap.heatSweep.find((r) => r.heatCapPct === -1)!;
    const tight = snap.heatSweep.find((r) => r.heatCapPct === 10)!;

    // Uncapped lets all 6 longs stack => higher peak risk than a 10% cap.
    expect(uncapped.peakRiskPct).toBeGreaterThan(tight.peakRiskPct);
    // Net-positive book => uncapped (bigger bets) ends richer than the throttled 10% cap.
    expect(uncapped.terminalEq).toBeGreaterThan(tight.terminalEq);
    // Peak risk is monotonic non-decreasing as the cap loosens.
    const byCap = [...snap.heatSweep].sort(
      (a, b) => (a.heatCapPct < 0 ? 1e9 : a.heatCapPct) - (b.heatCapPct < 0 ? 1e9 : b.heatCapPct),
    );
    for (let i = 1; i < byCap.length; i++) {
      expect(byCap[i].peakRiskPct).toBeGreaterThanOrEqual(byCap[i - 1].peakRiskPct - 1e-9);
    }
  });

  // [HS-2] ruin cliff + sample-sufficiency gate are computed honestly.
  it("[HS-2] ruin cliff derives from the worst day and a thin/up-only sample is flagged insufficient", () => {
    // The day's edge is the SUM of netR that TW day; make it net-negative (-1R) so a cliff exists.
    const orders = [ord("l1", 0, 30, -1), ord("l2", 10, 30, -1), ord("w1", 60, 30, 1)];
    const snap = computeHeatShadowSnapshot(orders, 2000, "2026-06-08T12:00:00.000Z");
    expect(snap.worstDayR).toBeLessThan(0);
    // worst day -1R => per-trade risk of 100% would wipe out; cliff = 1/|worstDayR| = 100%.
    expect(snap.ruinCliffPerTradePct).toBeCloseTo(100, 0);
    expect(snap.sampleSufficientForLiveSizing).toBe(false);
    expect(snap.twDays).toBe(1);
  });

  // [HS-3] recorder upserts one row per TW day (idempotent within a day) and writes measurement-only file.
  it("[HS-3] recordHeatShadowSnapshot upserts by TW day and never duplicates the day", () => {
    const dir = tmp();
    const orders = [ord("w1", 0, 30, 1), ord("l1", 60, 30, -1)];
    const first = recordHeatShadowSnapshot(dir, orders, 2000, "2026-06-08T10:00:00.000Z");
    const second = recordHeatShadowSnapshot(dir, orders, 2000, "2026-06-08T14:00:00.000Z");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const file = join(dir, "portfolio-heat-shadow-snapshots.json");
    expect(existsSync(file)).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.measurementOnly).toBe(true);
    // Both writes are the same TW day => exactly one row, latest captured-at wins.
    expect(doc.snapshots.length).toBe(1);
    expect(doc.snapshots[0].twDate).toBe("2026-06-08");
    expect(doc.snapshots[0].capturedAt).toBe("2026-06-08T14:00:00.000Z");
  });
});

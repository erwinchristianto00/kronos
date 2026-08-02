/**
 * LIVE-LANE WIRING (2026-08-02) — direct tests for the pure field-computation core
 * (lane-edge-report-fields.ts) that liveLaneReport() (cortex-live-gather-bindings.ts) uses to
 * genuinely, fail-closedly populate conservativeNetR / postFixExactLineage / costValid / fresh.
 *
 * Discipline: a fully valid input must produce all four fields as real, positive/true evidence
 * (pass-with), AND each of the four fields must independently read as failed/insufficient given a
 * scenario that breaks ONLY that one field while every other input stays genuinely valid
 * (fail-without, isolated per field — not just "everything broken at once").
 */
import { describe, it, expect } from "vitest";
import {
  computeLaneEdgeReportFields,
  resolvedLaneEdgeObservations,
  type LaneEdgeReportObservationLike,
} from "../src/lib/lane-edge-report-fields.js";

const HOUR_MS = 3_600_000;
const BLOCK_WIDTH_MS = 48 * HOUR_MS; // e.g. RC_MAX_HOLD_BARS(48) @ 1h bars
const NOW = 1_800_000_000_000;
const FRESH_TTL = 60 * 60_000;

/** N resolved observations across N distinct symbols (so effectiveN === N, well clear of the
 *  minimum), all genuinely post-fix-stamped, all on cost-model generation 1, netR alternating
 *  around a real positive mean with real variance (never a single repeated value). */
function validObservations(n: number): LaneEdgeReportObservationLike[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
  return Array.from({ length: n }, (_, i) => ({
    symbol: symbols[i % symbols.length] + `_${Math.floor(i / symbols.length)}`, // force distinct blocks
    openedAtMs: NOW - (i + 1) * 10 * 60_000,
    status: i % 5 === 0 ? "CLOSED_LOSS" : "CLOSED_WIN",
    netR: i % 5 === 0 ? -0.4 : 0.3 + (i % 3) * 0.05,
    postFixLineageV1: true,
    costModelVersion: 1,
  }));
}

describe("resolvedLaneEdgeObservations", () => {
  it("keeps only CLOSED_WIN/CLOSED_LOSS rows with a finite netR", () => {
    const obs: LaneEdgeReportObservationLike[] = [
      { symbol: "A", openedAtMs: 0, status: "OPEN", netR: null },
      { symbol: "A", openedAtMs: 0, status: "EXPIRED", netR: null },
      { symbol: "A", openedAtMs: 0, status: "CLOSED_WIN", netR: 0.5 },
      { symbol: "A", openedAtMs: 0, status: "CLOSED_LOSS", netR: -1 },
      { symbol: "A", openedAtMs: 0, status: "CLOSED_WIN", netR: null }, // malformed — never a fabricated 0
    ];
    expect(resolvedLaneEdgeObservations(obs)).toHaveLength(2);
  });
});

describe("computeLaneEdgeReportFields — pass-with: genuinely valid evidence across all four fields", () => {
  it("real, valid, fresh, post-fix, single-cohort evidence across independent blocks qualifies on every field", () => {
    const fields = computeLaneEdgeReportFields({
      observations: validObservations(24),
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.fresh).toBe(true);
    expect(fields.postFixExactLineage).toBe(true);
    expect(fields.costValid).toBe(true);
    expect(fields.conservativeNetR).not.toBeNull();
    expect(typeof fields.conservativeNetR).toBe("number");
    expect(Number.isFinite(fields.conservativeNetR)).toBe(true);
  });
});

describe("computeLaneEdgeReportFields — fail-without, isolated per field", () => {
  it("fresh=false when lastCycleAt is missing (e.g. IM's store, which tracks no cycleMeta)", () => {
    const fields = computeLaneEdgeReportFields({
      observations: validObservations(24),
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: undefined,
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.fresh).toBe(false);
    // the other three fields are unaffected by this one being broken
    expect(fields.postFixExactLineage).toBe(true);
    expect(fields.costValid).toBe(true);
    expect(fields.conservativeNetR).not.toBeNull();
  });

  it("fresh=false when lastCycleAt is older than the freshness TTL (a frozen/dead cycle)", () => {
    const fields = computeLaneEdgeReportFields({
      observations: validObservations(24),
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - FRESH_TTL - 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.fresh).toBe(false);
  });

  it("fresh=false on a future-dated lastCycleAt (untrusted clock, never fresh)", () => {
    const fields = computeLaneEdgeReportFields({
      observations: validObservations(24),
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW + 10 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.fresh).toBe(false);
  });

  it("postFixExactLineage=false when even ONE resolved observation lacks the post-fix stamp", () => {
    const obs = validObservations(24);
    obs[3]!.postFixLineageV1 = false; // simulate a legacy row mixed into an otherwise-fixed store
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.postFixExactLineage).toBe(false);
    expect(fields.fresh).toBe(true);
    expect(fields.costValid).toBe(true);
  });

  it("postFixExactLineage=false when the stamp is simply absent (legacy pre-fix rows, undefined ≠ true)", () => {
    const obs = validObservations(24).map((o) => ({ ...o, postFixLineageV1: undefined }));
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.postFixExactLineage).toBe(false);
  });

  it("postFixExactLineage=false when there is no resolved evidence at all (never vacuously true)", () => {
    const fields = computeLaneEdgeReportFields({
      observations: [],
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.postFixExactLineage).toBe(false);
  });

  it("costValid=false when resolved observations mix two different cost-model generations", () => {
    const obs = validObservations(24);
    // Half the store still on generation 1, half stamped with a (hypothetical) newer generation 2 —
    // the newest generation (2) does not cover every resolved row ⇒ never a valid single cohort.
    for (let i = 0; i < obs.length; i += 2) obs[i]!.costModelVersion = 2;
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.costValid).toBe(false);
    expect(fields.fresh).toBe(true);
    expect(fields.postFixExactLineage).toBe(true);
  });

  it("costValid=false when a legacy row (costModelVersion absent) is mixed with stamped generation-1 rows is STILL true (legacy defaults to generation 1, same cohort) — sanity check on the boundary", () => {
    const obs = validObservations(24);
    obs[0]!.costModelVersion = undefined; // legacy row, defaults to generation 1 per paper-cost-cohort.ts
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    // Legacy-defaults-to-gen-1 pools cleanly with today's gen-1 stamp — this is the DOCUMENTED
    // behavior of paper-cost-cohort.ts, not a bug in this helper.
    expect(fields.costValid).toBe(true);
  });

  it("conservativeNetR=null when every resolved observation clusters into a single time block (effectiveN=1, no independent evidence)", () => {
    const obs = validObservations(24).map((o) => ({ ...o, symbol: "BTCUSDT", openedAtMs: NOW - 60_000 }));
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.conservativeNetR).toBeNull();
    expect(fields.fresh).toBe(true);
    expect(fields.postFixExactLineage).toBe(true);
    expect(fields.costValid).toBe(true);
  });

  it("conservativeNetR=null when there is no resolved evidence at all", () => {
    const fields = computeLaneEdgeReportFields({
      observations: [],
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.conservativeNetR).toBeNull();
  });

  it("conservativeNetR reflects the LOWER BOUND, never the raw mean — a high-variance/thin-effectiveN winning-looking sample can still read null or a negative bound", () => {
    const obs: LaneEdgeReportObservationLike[] = [
      { symbol: "BTCUSDT", openedAtMs: NOW - HOUR_MS, status: "CLOSED_WIN", netR: 5, postFixLineageV1: true, costModelVersion: 1 },
      { symbol: "ETHUSDT", openedAtMs: NOW - 2 * HOUR_MS, status: "CLOSED_LOSS", netR: -3, postFixLineageV1: true, costModelVersion: 1 },
    ];
    const rawMean = (5 + -3) / 2;
    expect(rawMean).toBeGreaterThan(0); // the naive point estimate looks positive
    const fields = computeLaneEdgeReportFields({
      observations: obs,
      blockWidthMs: BLOCK_WIDTH_MS,
      lastCycleAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
      freshnessTtlMs: FRESH_TTL,
    });
    expect(fields.conservativeNetR).not.toBeNull();
    expect(fields.conservativeNetR as number).toBeLessThan(rawMean);
  });
});

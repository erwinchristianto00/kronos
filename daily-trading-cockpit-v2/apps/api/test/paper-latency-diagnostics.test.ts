import { describe, it, expect } from "vitest";

import {
  buildPaperLatencyDiagnostics,
  buildPaperLatencyBriefLines,
  PAPER_LATENCY_THRESHOLDS,
  PAPER_LATENCY_RULES_ENABLED,
  PAPER_ORDER_EXPIRY_MS,
  LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const BASE_TIME = Date.parse("2026-06-03T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Minimal PaperOrder for the latency builder. The builder only reads
 * openedAt / createdAt / updatedAt / paperStatus / closedAtMs; the rest is filler so
 * the object satisfies the PaperOrder type.
 */
function mkOrder(args: {
  openedAt: string;
  createdAt: string;
  updatedAt: string;
  paperStatus?: PaperOrderStatus;
  symbol?: string;
  /** MARKET ts of the exit bar. Omitted ⇒ the row carries no exit timestamp. */
  closedAtMs?: number | null;
}): PaperOrder {
  return {
    ...(args.closedAtMs === undefined ? {} : { closedAtMs: args.closedAtMs }),
    paperOrderId: "lat-test",
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    openedAt: args.openedAt,
    symbol: args.symbol ?? "ETHUSDT",
    direction: "SHORT",
    regime: null,
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 300,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: args.paperStatus ?? "PAPER_CLOSED_WIN",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

describe("paper latency diagnostics (E2E corridor — measurement-only)", () => {
  // ════ BLOCK A — CURRENT CYCLE LATENCY ════

  // [1] full current-cycle admission: scan + freshest candle + this-cycle order
  it("[1] full ORDER_AND_SCAN sample when an admission was created this cycle", () => {
    const now = iso(BASE_TIME);
    const scanFinishedAt = iso(BASE_TIME - 30_000); // scan 30s ago
    const observationMs = BASE_TIME - 45_000; // price observation (candle open) 45s ago
    const order = mkOrder({
      openedAt: iso(BASE_TIME - 90_000), // source observation 90s ago
      createdAt: iso(BASE_TIME - 80_000), // admitted 10s after observation
      updatedAt: iso(BASE_TIME - 20_000),
      paperStatus: "PAPER_CLOSED_WIN",
    });

    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt,
      freshestCandidatePriceObservationMs: observationMs,
      latestOrders: [order],
      createdThisCycle: 1,
    });

    expect(lat.scanAgeSec).toBeCloseTo(30, 1);
    expect(lat.candidateAgeSec).toBeCloseTo(45, 1);
    expect(lat.priceAgeSec).toBeCloseTo(90, 1); // now − openedAt
    expect(lat.scanToAdmissionDelaySec).toBeCloseTo(10, 1); // createdAt − openedAt
    expect(lat.createdThisCycle).toBe(1);
    expect(lat.sampleSource).toBe("ORDER_AND_SCAN");
    expect(lat.reportOnly).toBe(true);
  });

  // [2] no admission this cycle → admission metrics n/a, priceAge falls back to candidateAge
  it("[2] NO_NEW_ADMISSION: createdThisCycle=0 → admission metrics n/a, priceAge=candidateAge", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 60_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 120_000,
      latestOrders: [],
      createdThisCycle: 0,
    });
    expect(lat.sampleSource).toBe("NO_NEW_ADMISSION");
    expect(lat.scanAgeSec).toBeCloseTo(60, 1);
    expect(lat.candidateAgeSec).toBeCloseTo(120, 1);
    expect(lat.scanToAdmissionDelaySec).toBeNull();
    expect(lat.priceAgeSec).toBeCloseTo(120, 1); // fallback to candidateAge
  });

  // [3] an OLD open order present but nothing admitted this cycle must NOT leak into Block A
  it("[3] old open order does NOT contaminate current-cycle admission metrics", () => {
    const now = iso(BASE_TIME);
    const oldOpen = mkOrder({
      openedAt: iso(BASE_TIME - 8_960_500), // ~2.49h old (the reported backlog)
      createdAt: iso(BASE_TIME - 8_835_600), // ~2.45h old
      updatedAt: iso(BASE_TIME - 8_835_600),
      paperStatus: "PAPER_SUBMITTED", // still open
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 30_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 45_000,
      latestOrders: [oldOpen], // newest order is OLD and open
      openOrders: [oldOpen],
      createdThisCycle: 0, // nothing admitted this cycle
    });
    // Block A: clean current-cycle freshness, no admission leak
    expect(lat.sampleSource).toBe("NO_NEW_ADMISSION");
    expect(lat.scanToAdmissionDelaySec).toBeNull();
    expect(lat.priceAgeSec).toBeCloseTo(45, 1); // candidate freshness, NOT 8960s
    // Block B: the 2.45h age surfaces HERE, correctly labeled
    expect(lat.openOrderCount).toBe(1);
    expect(lat.oldestOpenAgeSec).toBeCloseTo(8960.5, 0);
    expect(lat.resolverBacklogAgeSec).toBeCloseTo(8835.6, 0);
    expect(lat.backlogSampleSource).toBe("OPEN_ORDER_BACKLOG");
    // ~2.49h hold → normal bucket; lane id contains WIDE → SWING_WIDE
    expect(lat.holdProfile).toBe("SWING_WIDE");
    expect(lat.openHoldBuckets.normalWideHold).toBe(1);
    expect(lat.oldestOpenHoldSec).toBeCloseTo(8960.5, 0);
  });

  // [4] order-only this cycle: no scan/candle → scan & candidate null, price from order
  it("[4] ORDER_ONLY: this-cycle admission with no scan/candle", () => {
    const now = iso(BASE_TIME);
    const order = mkOrder({
      openedAt: iso(BASE_TIME - 50_000),
      createdAt: iso(BASE_TIME - 45_000),
      updatedAt: iso(BASE_TIME - 5_000),
      paperStatus: "PAPER_CLOSED_LOSS",
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [order],
      createdThisCycle: 1,
    });
    expect(lat.sampleSource).toBe("ORDER_ONLY");
    expect(lat.scanAgeSec).toBeNull();
    expect(lat.candidateAgeSec).toBeNull();
    expect(lat.priceAgeSec).toBeCloseTo(50, 1);
    expect(lat.scanToAdmissionDelaySec).toBeCloseTo(5, 1);
  });

  // [5] none: all null, NO_NEW_ADMISSION, empty backlog
  it("[5] empty everything → NO_NEW_ADMISSION, all null, backlog NONE", () => {
    const lat = buildPaperLatencyDiagnostics({
      now: iso(BASE_TIME),
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
    });
    expect(lat.sampleSource).toBe("NO_NEW_ADMISSION");
    expect(lat.scanAgeSec).toBeNull();
    expect(lat.candidateAgeSec).toBeNull();
    expect(lat.priceAgeSec).toBeNull();
    expect(lat.scanToAdmissionDelaySec).toBeNull();
    expect(lat.openOrderCount).toBe(0);
    expect(lat.oldestOpenAgeSec).toBeNull();
    expect(lat.p90OpenAgeSec).toBeNull();
    expect(lat.resolverBacklogAgeSec).toBeNull();
    expect(lat.backlogSampleSource).toBe("NONE");
    expect(lat.latencyBlocker).toBeNull();
  });

  // ════ BLOCK B — OPEN ORDER / RESOLVER BACKLOG ════

  // [6] open-order backlog: oldest age, p90, resolver backlog, terminal orders excluded
  it("[6] backlog aggregates only open orders; terminal orders are excluded", () => {
    const now = iso(BASE_TIME);
    const open1 = mkOrder({
      openedAt: iso(BASE_TIME - 100_000),
      createdAt: iso(BASE_TIME - 95_000),
      updatedAt: iso(BASE_TIME - 95_000),
      paperStatus: "PAPER_SUBMITTED",
    });
    const open2 = mkOrder({
      openedAt: iso(BASE_TIME - 300_000), // oldest
      createdAt: iso(BASE_TIME - 290_000),
      updatedAt: iso(BASE_TIME - 290_000),
      paperStatus: "CREATED",
    });
    const closed = mkOrder({
      openedAt: iso(BASE_TIME - 999_000),
      createdAt: iso(BASE_TIME - 998_000),
      updatedAt: iso(BASE_TIME - 10_000),
      paperStatus: "PAPER_CLOSED_WIN", // terminal → excluded
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 30_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 30_000,
      latestOrders: [],
      openOrders: [open1, open2, closed],
      createdThisCycle: 0,
    });
    expect(lat.openOrderCount).toBe(2); // closed excluded
    expect(lat.oldestOpenAgeSec).toBeCloseTo(300, 0); // max openedAt age
    expect(lat.resolverBacklogAgeSec).toBeCloseTo(290, 0); // max createdAt age
    expect(lat.p90OpenAgeSec).toBeCloseTo(300, 0); // nearest-rank p90 of {100,300}
    expect(lat.backlogSampleSource).toBe("OPEN_ORDER_BACKLOG");
  });

  // [7] unresolvedTooLongCount uses the SLA threshold (defaults to PAPER_ORDER_EXPIRY_MS)
  it("[7] unresolvedTooLongCount counts open orders past the SLA threshold", () => {
    const now = iso(BASE_TIME);
    const recent = mkOrder({
      openedAt: iso(BASE_TIME - 60_000),
      createdAt: iso(BASE_TIME - 55_000),
      updatedAt: iso(BASE_TIME - 55_000),
      paperStatus: "PAPER_SUBMITTED",
    });
    const stale = mkOrder({
      openedAt: iso(BASE_TIME - 200_000),
      createdAt: iso(BASE_TIME - 190_000), // 190s elapsed-since-admission
      updatedAt: iso(BASE_TIME - 190_000),
      paperStatus: "CREATED",
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      openOrders: [recent, stale],
      createdThisCycle: 0,
      unresolvedMaxAgeSec: 120, // 120s SLA → only `stale` (190s) trips
    });
    expect(lat.unresolvedTooLongCount).toBe(1);

    // default threshold is the 7-day order-expiry SLA — neither trips
    const latDefault = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      openOrders: [recent, stale],
      createdThisCycle: 0,
    });
    expect(latDefault.unresolvedTooLongCount).toBe(0);
    expect(PAPER_ORDER_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  // [7a] open-hold buckets label each open order against the lane's normal profile
  it("[7a] openHoldBuckets bins open holds; none force a close", () => {
    const now = iso(BASE_TIME);
    const mk = (hoursAgo: number) =>
      mkOrder({
        openedAt: iso(BASE_TIME - hoursAgo * 3_600_000),
        createdAt: iso(BASE_TIME - hoursAgo * 3_600_000),
        updatedAt: iso(BASE_TIME - hoursAgo * 3_600_000),
        paperStatus: "PAPER_SUBMITTED",
      });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      openOrders: [mk(10), mk(35), mk(50), mk(80), mk(192)], // 10h, 35h, 50h, 80h, 8d
      createdThisCycle: 0,
    });
    expect(lat.openOrderCount).toBe(5);
    expect(lat.openHoldBuckets).toEqual({
      normalWideHold: 1, // 10h
      extendedHoldWatch: 1, // 35h
      staleWideHold: 1, // 50h
      reviewRequired: 1, // 80h
      expiredBySla: 1, // 8d
    });
    expect(lat.holdProfile).toBe("SWING_WIDE"); // lane id contains WIDE
  });

  // [7b] expectedHold p50/p90 come from CLOSED hold samples (the lane's "normal")
  it("[7b] expectedHoldP50/P90 derive from closed hold samples", () => {
    const lat = buildPaperLatencyDiagnostics({
      now: iso(BASE_TIME),
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      openOrders: [],
      closedHoldSamplesSec: [20, 22, 27, 30].map((h) => h * 3600),
    });
    expect(lat.expectedHoldP50Sec).toBeCloseTo(22 * 3600, 0); // nearest-rank p50 of 4
    expect(lat.expectedHoldP90Sec).toBeCloseTo(30 * 3600, 0);
    expect(lat.holdProfile).toBe("NONE"); // no open orders
  });

  // [7c] PAPER_FILLED/PARTIAL open orders are flagged as resolver-unprocessable (latent stuck)
  it("[7c] resolverUnprocessableOpenCount flags statuses the resolver never re-checks", () => {
    const now = iso(BASE_TIME);
    const submitted = mkOrder({
      openedAt: iso(BASE_TIME - 3_600_000),
      createdAt: iso(BASE_TIME - 3_600_000),
      updatedAt: iso(BASE_TIME - 3_600_000),
      paperStatus: "PAPER_SUBMITTED", // processable
    });
    const filled = mkOrder({
      openedAt: iso(BASE_TIME - 3_600_000),
      createdAt: iso(BASE_TIME - 3_600_000),
      updatedAt: iso(BASE_TIME - 3_600_000),
      paperStatus: "PAPER_FILLED", // open but resolver skips it
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      openOrders: [submitted, filled],
      createdThisCycle: 0,
    });
    expect(lat.openOrderCount).toBe(2); // both are non-terminal
    expect(lat.resolverUnprocessableOpenCount).toBe(1); // only PAPER_FILLED
  });

  // ════ ADVISORY CORRIDOR (unchanged semantics) ════

  // [8] staleSkipped is ALWAYS 0 even when ages massively exceed thresholds
  it("[8] staleSkipped stays 0 — corridor never enforces", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 3_600_000), // 1h old scan ≫ 600s
      freshestCandidatePriceObservationMs: BASE_TIME - 3_600_000,
      latestOrders: [],
    });
    expect(lat.staleSkipped).toBe(0);
  });

  // [9] advisory blocker is ADVISORY-prefixed while rules disabled (default)
  it("[9] rulesEnabled=false → latencyBlocker is ADVISORY-prefixed", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 1_200_000), // 20 min ≫ 600s scan max
      freshestCandidatePriceObservationMs: BASE_TIME - 1_200_000,
      latestOrders: [],
    });
    expect(lat.rulesEnabled).toBe(false);
    expect(lat.latencyBlocker).toBe("ADVISORY:SCAN_TOO_OLD_NO_HEADLINE");
    expect(lat.staleSkipped).toBe(0);
  });

  // [10] rulesEnabled=true → blocker un-prefixed (but enforcement still unwired here)
  it("[10] rulesEnabled=true → latencyBlocker un-prefixed, staleSkipped still 0", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 1_200_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 700_000, // candidate also > 600s
      latestOrders: [],
      rulesEnabled: true,
    });
    expect(lat.rulesEnabled).toBe(true);
    expect(lat.latencyBlocker).toBe("SCAN_TOO_OLD_NO_HEADLINE");
    expect(lat.staleSkipped).toBe(0);
  });

  // [11] within paper thresholds → no trip, blocker null
  it("[11] fresh scan/candidate within 600s → no rule trips", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 120_000), // 2 min < 600s
      freshestCandidatePriceObservationMs: BASE_TIME - 200_000, // < 600s
      latestOrders: [],
    });
    expect(lat.ruleEvals.every((r) => !r.wouldTrip)).toBe(true);
    expect(lat.latencyBlocker).toBeNull();
  });

  // [12] price/admission thresholds are OFF in the PAPER profile → never trip
  it("[12] PAPER profile leaves price/admission corridors open (null threshold → no trip)", () => {
    const now = iso(BASE_TIME);
    const order = mkOrder({
      openedAt: iso(BASE_TIME - 5_000_000), // hugely stale price
      createdAt: iso(BASE_TIME - 4_000_000), // huge admission delay
      updatedAt: iso(BASE_TIME - 1_000),
      paperStatus: "PAPER_CLOSED_WIN",
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 1_000), // scan fresh
      freshestCandidatePriceObservationMs: BASE_TIME - 1_000, // candidate fresh
      latestOrders: [order],
      createdThisCycle: 1,
    });
    const priceRule = lat.ruleEvals.find((r) => r.rule === "PRICE_TOO_STALE_SKIP")!;
    const admissionRule = lat.ruleEvals.find((r) => r.rule === "ADMISSION_DELAY_EXCEEDED")!;
    expect(priceRule.thresholdSec).toBeNull();
    expect(priceRule.wouldTrip).toBe(false);
    expect(admissionRule.thresholdSec).toBeNull();
    expect(admissionRule.wouldTrip).toBe(false);
    expect(lat.latencyBlocker).toBeNull(); // scan & candidate fresh, others off
  });

  // [13] clock skew: small negative clamps to 0; large negative → null
  it("[13] clamps small negative ages to 0, drops large negatives as null", () => {
    const now = iso(BASE_TIME);
    const latSkew = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME + 500), // 0.5s future → clamp to 0
      freshestCandidatePriceObservationMs: BASE_TIME + 5_000, // 5s future → bad data → null
      latestOrders: [],
    });
    expect(latSkew.scanAgeSec).toBe(0);
    expect(latSkew.candidateAgeSec).toBeNull();
  });

  // [14] thresholds & rules-flag defaults exposed as expected
  it("[14] active PAPER thresholds + master switch defaults are correct", () => {
    expect(PAPER_LATENCY_RULES_ENABLED).toBe(false);
    expect(PAPER_LATENCY_THRESHOLDS.profile).toBe("PAPER");
    expect(PAPER_LATENCY_THRESHOLDS.scanMaxAgeSec).toBe(600);
    expect(PAPER_LATENCY_THRESHOLDS.candidateMaxAgeSec).toBe(600);
    expect(PAPER_LATENCY_THRESHOLDS.priceMaxAgeSec).toBeNull();
    expect(PAPER_LATENCY_THRESHOLDS.admissionMaxDelaySec).toBeNull();
    expect(LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE.profile).toBe("LIVE_MICRO_PILOT");
    expect(LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE.priceMaxAgeSec).not.toBeNull();
    expect(LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE.admissionMaxDelaySec).not.toBeNull();
  });

  // ════ BRIEF RENDERING ════

  // [15] brief lines render the two labeled blocks + key tokens, report-only
  it("[15] brief lines render Block A + Block B with current-cycle and backlog tokens", () => {
    const now = iso(BASE_TIME);
    const newOrder = mkOrder({
      openedAt: iso(BASE_TIME - 90_000),
      createdAt: iso(BASE_TIME - 80_000),
      updatedAt: iso(BASE_TIME - 20_000),
    });
    const oldOpen = mkOrder({
      openedAt: iso(BASE_TIME - 8_960_500),
      createdAt: iso(BASE_TIME - 8_835_600),
      updatedAt: iso(BASE_TIME - 8_835_600),
      paperStatus: "PAPER_SUBMITTED",
    });
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 30_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 45_000,
      latestOrders: [newOrder],
      openOrders: [oldOpen],
      createdThisCycle: 1,
    });
    const lines = buildPaperLatencyBriefLines(lat);
    const text = lines.join("\n");
    expect(text).toContain("LATENCY");
    expect(text).toContain("MEASUREMENT-ONLY");
    expect(text).toContain("A. CURRENT CYCLE LATENCY");
    expect(text).toContain("B. OPEN ORDER / RESOLVER BACKLOG");
    expect(text).toContain("scanAgeSec=");
    expect(text).toContain("candidateAgeSec=");
    expect(text).toContain("priceAgeSec=");
    expect(text).toContain("scanToAdmissionDelaySec=");
    expect(text).toContain("createdThisCycle=1");
    expect(text).toContain("sampleSource=ORDER_AND_SCAN");
    expect(text).toContain("openOrderCount=1");
    expect(text).toContain("oldestOpenAgeSec=");
    expect(text).toContain("p90OpenAgeSec=");
    expect(text).toContain("resolverBacklogAgeSec=");
    expect(text).toContain("unresolvedTooLongCount=");
    expect(text).toContain("sampleSource=OPEN_ORDER_BACKLOG");
    expect(text).toContain("holdProfile=SWING_WIDE");
    expect(text).toContain("expectedHoldP50=");
    expect(text).toContain("openHoldBuckets: normalWideHold=");
    expect(text).toContain("resolverUnprocessableOpenCount=");
    expect(text).toContain("rulesEnabled=false");
    expect(text).toContain("staleSkipped=0");
    expect(text).toContain("LIVE_MICRO_PILOT");
    expect(text).toContain("NOT active");
  });

  // [16] no new admission renders admissionDelay=n/a + NO_NEW_ADMISSION in Block A
  it("[16] NO_NEW_ADMISSION renders scanToAdmissionDelaySec=n/a in the brief", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 30_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 45_000,
      latestOrders: [],
      createdThisCycle: 0,
    });
    const text = buildPaperLatencyBriefLines(lat).join("\n");
    expect(text).toContain("scanToAdmissionDelaySec=n/a");
    expect(text).toContain("sampleSource=NO_NEW_ADMISSION");
  });

  // [17] custom thresholds: an explicit candidate corridor trips advisory
  it("[17] explicit thresholds evaluate wouldTrip without enforcing", () => {
    const now = iso(BASE_TIME);
    const lat = buildPaperLatencyDiagnostics({
      now,
      scanFinishedAt: iso(BASE_TIME - 10_000),
      freshestCandidatePriceObservationMs: BASE_TIME - 100_000, // 100s
      latestOrders: [],
      thresholds: {
        profile: "PAPER",
        scanMaxAgeSec: 600,
        candidateMaxAgeSec: 60, // 100s > 60s → trips
        priceMaxAgeSec: null,
        admissionMaxDelaySec: null,
      },
    });
    const candRule = lat.ruleEvals.find((r) => r.rule === "CANDIDATE_TOO_OLD_SKIP")!;
    expect(candRule.wouldTrip).toBe(true);
    expect(lat.latencyBlocker).toBe("ADVISORY:CANDIDATE_TOO_OLD_SKIP");
    expect(lat.staleSkipped).toBe(0);
  });
});

// ════ BLOCK C — LABEL LEAK (createdAt vs openedAt) ════
//
// openedAt is the OBSERVATION instant (entryPrice belongs to it); createdAt is the
// DECISION instant (regime / controllerMode / routerPermission / provenance belong to
// IT). openedAt PRECEDES createdAt — verified on the live testnet store 2026-07-26:
// createdAt − openedAt positive on 29,968/29,968 rows, closed cohort p50 +213.9s /
// p90 +394.2s / max +586.6s. The resolver anchors its candle walk on openedAt, so 106 of
// 6,229 closed rows carrying closedAtMs had closedAtMs < createdAt (86 of them TP1_HIT
// wins) — the outcome was decided by price action that predated the label.
//
// These fields REPORT that leak. They must never change resolution or netR.
describe("paper latency diagnostics — Block C label leak (report-only)", () => {
  const T = BASE_TIME;
  /** Median admission delay measured on the real testnet closed cohort. */
  const LEAK_SEC = 214;
  const CANDLE_SEC = 300;

  function mkClosed(args: { leakSec: number; closedAtMs?: number | null; status?: PaperOrderStatus }) {
    return mkOrder({
      openedAt: iso(T),
      createdAt: iso(T + args.leakSec * 1000),
      updatedAt: iso(T + 900_000),
      paperStatus: args.status ?? "PAPER_CLOSED_WIN",
      closedAtMs: args.closedAtMs,
    });
  }

  /** Builder call with no Block A/B sample — isolates Block C. */
  function build(closedOrders: PaperOrder[]) {
    return buildPaperLatencyDiagnostics({
      now: iso(T + 1_000_000),
      scanFinishedAt: null,
      freshestCandidatePriceObservationMs: null,
      latestOrders: [],
      createdThisCycle: 0,
      closedOrders,
    });
  }

  // [C1] the load-bearing case: an order whose exit BAR closed before its own createdAt
  it("[LABEL-LEAK] counts closed orders resolved before their own label existed and reports the leak percentiles", () => {
    const lat = build([
      // A — exit bar closed at T+120s, i.e. BEFORE createdAt (T+214s): pre-decision resolution.
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 120_000 }),
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 600_000 }),
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 900_000 }),
    ]);
    expect(lat.resolvedBeforeDecisionCount).toBe(1);
    expect(lat.labelLeakClosedWithExitTsCount).toBe(3);
    expect(lat.labelLeakP50Sec).toBe(LEAK_SEC);
    expect(lat.labelLeakP90Sec).toBe(LEAK_SEC);
    expect(lat.labelLeakMaxSec).toBe(LEAK_SEC);
    expect(lat.labelLeakClosedSampleCount).toBe(3);
    expect(lat.labelLeakSampleSource).toBe("CLOSED_ORDER_COHORT");
    expect(lat.labelLeakExitTsSampleSource).toBe("CLOSED_ORDER_COHORT");
    // The resolver admits the WHOLE 5m bar containing openedAt, so the resolvable pre-decision
    // window is the admission delay PLUS one WHOLE candle. Named an UPPER BOUND, not a p50:
    // the 300s term is the maximum pre-openedAt reach of that bar, whose median reach is ~150s.
    expect(lat.preDecisionResolvableSecUpperBoundAtP50).toBe(LEAK_SEC + CANDLE_SEC);
  });

  // [C1b] THE UNDERSTATEMENT. resolvedBeforeDecisionCount is a STRICT LOWER BOUND: an exit bar
  //       that OPENED before createdAt and closed after it is equally suspect (the SL/TP touch
  //       inside it may predate the label — unknowable at 5m) but is not counted by it. Since the
  //       median admission delay (214s) is under one candle (300s), that straddling population is
  //       large: measured 114 strict vs 197 straddling on the testnet store, so reading the strict
  //       counter alone understates the possibly-leaked cohort by 2.7x (1.8% vs 5.0%).
  it("[LABEL-LEAK] an exit bar STRADDLING createdAt is counted separately, not silently dropped", () => {
    const lat = build([
      // strict: whole exit bar closed before the label existed.
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 120_000 }),
      // straddling: bar spans (T+0, T+300s], createdAt is T+214s — opened before, closed after.
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 300_000 }),
      // also straddling: bar spans (T+213s, T+513s], createdAt T+214s sits just inside it.
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 513_000 }),
      // clean: bar opened at T+300s, strictly AFTER createdAt (T+214s).
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 600_000 }),
    ]);
    expect(lat.resolvedBeforeDecisionCount).toBe(1);
    expect(lat.exitBarStraddlesDecisionCount).toBe(2);
    expect(lat.labelLeakClosedWithExitTsCount).toBe(4);
    // The number a quarantine decision must actually use.
    expect(lat.resolvedBeforeDecisionCount + lat.exitBarStraddlesDecisionCount).toBe(3);
  });

  // [C1c] provenance for the COUNTERS has a different denominator than provenance for the
  //       PERCENTILES. A cohort of legacy rows predating the Track-1a closedAtMs field yields a
  //       full percentile sample and a ZERO counter denominator; reporting "measured" for a 0/0
  //       counter is the exact failure mode [C2] exists to prevent, one level down.
  it("[LABEL-LEAK] a cohort with no closedAtMs at all reports exitTs provenance NONE, not a clean 0/0", () => {
    const lat = build([
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: null }),
      mkClosed({ leakSec: LEAK_SEC }),
    ]);
    expect(lat.labelLeakClosedSampleCount).toBe(2);
    expect(lat.labelLeakSampleSource).toBe("CLOSED_ORDER_COHORT"); // percentiles ARE measured
    expect(lat.labelLeakClosedWithExitTsCount).toBe(0);
    expect(lat.resolvedBeforeDecisionCount).toBe(0);
    expect(lat.exitBarStraddlesDecisionCount).toBe(0);
    expect(lat.labelLeakExitTsSampleSource).toBe("NONE"); // …but the counters are NOT
  });

  // [C2] "no sample" must be distinguishable from "no leak" — otherwise an unmeasured
  //      book reads as a clean one.
  it("[LABEL-LEAK] an absent cohort reports NONE, not a fabricated zero-leak", () => {
    const none = build([]);
    expect(none.labelLeakSampleSource).toBe("NONE");
    expect(none.labelLeakClosedSampleCount).toBe(0);
    expect(none.labelLeakP50Sec).toBeNull();
    expect(none.labelLeakMaxSec).toBeNull();
    expect(none.preDecisionResolvableSecUpperBoundAtP50).toBeNull();
    expect(none.labelLeakExitTsSampleSource).toBe("NONE");
    expect(none.resolvedBeforeDecisionCount).toBe(0);

    // A real cohort with zero pre-decision resolutions looks DIFFERENT.
    const clean = build([mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 900_000 })]);
    expect(clean.labelLeakSampleSource).toBe("CLOSED_ORDER_COHORT");
    expect(clean.resolvedBeforeDecisionCount).toBe(0);
    expect(clean.labelLeakClosedWithExitTsCount).toBe(1);
  });

  // [C3] denominator honesty: legacy rows without closedAtMs still carry a leak delta but
  //      cannot be judged for pre-decision resolution.
  it("[LABEL-LEAK] rows without closedAtMs count toward the percentiles but not the leak denominator", () => {
    const lat = build([
      mkClosed({ leakSec: 100, closedAtMs: null }),
      mkClosed({ leakSec: 200 }), // omitted entirely (legacy row)
      mkClosed({ leakSec: 300, closedAtMs: T + 10_000 }), // exit bar precedes createdAt(T+300s)
    ]);
    expect(lat.labelLeakClosedSampleCount).toBe(3);
    expect(lat.labelLeakClosedWithExitTsCount).toBe(1);
    expect(lat.resolvedBeforeDecisionCount).toBe(1);
    expect(lat.labelLeakMaxSec).toBe(300);
  });

  // [C4] the sign must survive. The original task statement claimed openedAt FOLLOWS
  //      createdAt; the real store says the opposite on 100% of rows. A diagnostic that
  //      clamped or nulled negatives could never have settled that, so the raw signed
  //      value is preserved.
  it("[LABEL-LEAK] a negative (skewed) delta is reported as negative, never clamped to 0 or nulled", () => {
    const lat = build([mkClosed({ leakSec: -45, closedAtMs: T + 900_000 })]);
    expect(lat.labelLeakP50Sec).toBe(-45);
    expect(lat.labelLeakMaxSec).toBe(-45);
    expect(lat.labelLeakSampleSource).toBe("CLOSED_ORDER_COHORT");
  });

  // [C5] cohort scope: only real WIN/LOSS closes are labels. Expiries / no-fills / still-open
  //      rows never produced an outcome label and must not dilute the leak stats.
  it("[LABEL-LEAK] non-outcome statuses are excluded from the cohort", () => {
    const lat = build([
      mkClosed({ leakSec: 100, closedAtMs: T + 10_000, status: "PAPER_EXPIRED" }),
      mkClosed({ leakSec: 100, closedAtMs: T + 10_000, status: "PAPER_NO_FILL" }),
      mkClosed({ leakSec: 100, closedAtMs: T + 10_000, status: "PAPER_SUBMITTED" }),
      mkClosed({ leakSec: 500, closedAtMs: T + 900_000, status: "PAPER_CLOSED_LOSS" }),
    ]);
    expect(lat.labelLeakClosedSampleCount).toBe(1);
    expect(lat.labelLeakP50Sec).toBe(500);
    expect(lat.resolvedBeforeDecisionCount).toBe(0);
  });

  // [C6] REPORT-ONLY guard: Block C is purely additive. Supplying the cohort must not move
  //      a single Block A / Block B / corridor value. If a future change ever wires the leak
  //      into enforcement, this fails.
  it("[LABEL-LEAK] Block C is additive — Block A/B and the rules corridor are byte-identical with and without the cohort", () => {
    const inputs = {
      now: iso(T + 1_000_000),
      scanFinishedAt: iso(T + 970_000),
      freshestCandidatePriceObservationMs: T + 955_000,
      latestOrders: [mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 120_000 })],
      openOrders: [
        mkOrder({
          openedAt: iso(T + 900_000),
          createdAt: iso(T + 900_100),
          updatedAt: iso(T + 900_100),
          paperStatus: "PAPER_SUBMITTED",
        }),
      ],
      createdThisCycle: 1,
    };
    const without = buildPaperLatencyDiagnostics(inputs);
    const withCohort = buildPaperLatencyDiagnostics({
      ...inputs,
      closedOrders: [mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 120_000 })],
    });

    const stripBlockC = (d: typeof without) => {
      const {
        labelLeakClosedSampleCount: _a,
        labelLeakP50Sec: _b,
        labelLeakP90Sec: _c,
        labelLeakMaxSec: _d,
        resolvedBeforeDecisionCount: _e,
        labelLeakClosedWithExitTsCount: _f,
        preDecisionResolvableSecUpperBoundAtP50: _g,
        labelLeakSampleSource: _h,
        exitBarStraddlesDecisionCount: _i,
        labelLeakExitTsSampleSource: _j,
        ...rest
      } = d;
      return rest;
    };
    expect(stripBlockC(withCohort)).toEqual(stripBlockC(without));
    // ...and the corridor is still measurement-only.
    expect(withCohort.reportOnly).toBe(true);
    expect(withCohort.staleSkipped).toBe(0);
    expect(withCohort.resolvedBeforeDecisionCount).toBe(1);
    expect(without.labelLeakSampleSource).toBe("NONE");
  });

  // [C7] the operator has to be able to SEE it, otherwise "expose" did nothing.
  it("[LABEL-LEAK] the brief renders Block C with the leak counter", () => {
    const lat = build([
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 120_000 }),
      mkClosed({ leakSec: LEAK_SEC, closedAtMs: T + 900_000 }),
    ]);
    const text = buildPaperLatencyBriefLines(lat).join("\n");
    expect(text).toContain("C. LABEL LEAK (createdAt vs openedAt — REPORT-ONLY, resolver UNCHANGED)");
    expect(text).toContain("labelLeakP50=214.0s");
    expect(text).toContain("resolvedBeforeDecision=1/2");
    expect(text).toContain("possiblyLeaked=1/2");
    expect(text).toContain("preDecisionResolvableUpperBound@p50=514.0s");
    expect(text).toContain("exitTsSource=CLOSED_ORDER_COHORT");
    expect(text).toContain("sampleSource=CLOSED_ORDER_COHORT");
  });
});

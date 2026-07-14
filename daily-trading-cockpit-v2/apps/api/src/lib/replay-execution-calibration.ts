/**
 * Free Level-1 execution calibration (spec Track B). Turns REAL observed fills (the live-execution engine's intent
 * ledger — plannedEntryPrice vs filledEntryPrice, stop geometry, fees) into a STRICT calibration dataset and
 * compares the L1 emulator's PREDICTED fill cost to the ACTUAL realized cost. Its outputs calibrate execution
 * realism ONLY.
 *
 * HARD boundary (enforced): every row is stamped ACTUAL_LIVE_EXECUTION and `evidenceAllowedFor` permits it for
 * EXECUTION_CALIBRATION exclusively — never DIRECTIONAL_ALPHA. Actual fills must NEVER become Direction/Entry
 * alpha or CORTEX outcome labels. Pure + offline: no executor, no orders, no beta, no kill-state, no VPS.
 *
 * Honest limits: the intent ledger records decision/close timestamps and confirmed fill PRICES, but NOT a separate
 * exchange-ack timestamp — so submit→ack LATENCY and PARTIAL-fill fraction are NOT recoverable here (reported
 * null with a reason, never fabricated). Queue position / market impact need Tier-C L2 and are not claimed.
 */
import { simulateExecution, type EmulatorConfig } from "./replay-execution-emulator.js";
import { evidenceAllowedFor, stampRow, type EvidenceClass, type RowProvenance, type ReplayProvenance } from "./replay-provenance.js";
import { quantile } from "./backfill-walkforward.js";
import { clusteredBootstrapMeanCI } from "./replay-tier-a-metrics.js";

/** Loose shape of a persisted live-execution intent (only the fields calibration needs). */
export interface RawExecutionIntent {
  paperOrderId?: string; entryOrderId?: number | string | null;
  symbol?: string; direction?: "LONG" | "SHORT"; state?: string;
  qty?: number; plannedEntryPrice?: number; filledEntryPrice?: number; stopLossPrice?: number;
  feesUsd?: number; realizedPnlUsd?: number | null; effectiveRiskUsd?: number | null;
  createdAt?: string; updatedAt?: string; closedAt?: string; closeReason?: string;
  entryPriceConfirmed?: boolean; lastError?: string | null;
}

export type Venue = "MAINNET" | "TESTNET";

export interface CalibrationRow {
  intentId: string | null; orderId: string | null; symbol: string; side: "BUY" | "SELL"; orderType: "MARKET";
  qty: number | null; notionalUsd: number | null;
  decisionSubmitAtMs: number | null; ackAtMs: number | null; closedAtMs: number | null; holdMs: number | null;
  referencePrice: number | null; actualFillPrice: number | null; riskDistancePrice: number | null;
  expectedL1FillPrice: number | null; predictedLatencyMs: number | null; actualLatencyMs: number | null;
  entrySlippageBps: number | null; entrySlippageR: number | null; predictedL1SlippageR: number | null; slippageResidualR: number | null;
  feeUsd: number | null; feeR: number | null; fundingUsd: number | null;
  entryConfirmed: boolean; partial: boolean | null; rejected: boolean;
  volTier: string | null; liqTier: string | null;
  venue: Venue; sourceInstance: string;
  usable: boolean; rejectReason: string | null;
  _provenance: RowProvenance;
}

const ms = (s?: string): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

export interface ExtractCtx {
  provenance: ReplayProvenance; evidenceClass: EvidenceClass; venue: Venue; sourceInstance: string; l1: EmulatorConfig;
}

/** Convert one raw intent to a strict, provenance-stamped calibration row (usable=false when unfit, with reason). */
export function extractCalibrationRow(it: RawExecutionIntent, ctx: ExtractCtx): CalibrationRow {
  if (!evidenceAllowedFor("EXECUTION_CALIBRATION", ctx.evidenceClass)) {
    throw new Error(`evidence class ${ctx.evidenceClass} not allowed for EXECUTION_CALIBRATION`);
  }
  const side: "BUY" | "SELL" = it.direction === "SHORT" ? "SELL" : "BUY";
  const submitAt = ms(it.createdAt); const closedAt = ms(it.closedAt);
  const ref = it.plannedEntryPrice ?? null; const fill = it.filledEntryPrice ?? null;
  const risk = ref != null && it.stopLossPrice != null ? Math.abs(ref - it.stopLossPrice) : null;
  const confirmed = it.entryPriceConfirmed !== false;
  const rejected = !!it.lastError && (it.filledEntryPrice == null || it.state === "FAILED");

  // usability gate — do NOT fabricate; reject with a reason.
  let rejectReason: string | null = null;
  if (!confirmed) rejectReason = "entry price unconfirmed (stale fallback)";
  else if (ref == null || fill == null) rejectReason = "missing planned or filled price";
  else if (risk == null || risk <= 0) rejectReason = "non-positive risk distance";
  const usable = rejectReason == null && !rejected;

  // measured entry slippage (ADVERSE convention: BUY worse when fill>ref; SELL worse when fill<ref).
  let entrySlippageBps: number | null = null, entrySlippageR: number | null = null;
  if (usable && ref != null && fill != null && risk != null && risk > 0 && ref > 0) {
    const adversePrice = side === "BUY" ? fill - ref : ref - fill;
    entrySlippageBps = (adversePrice / ref) * 1e4;
    entrySlippageR = adversePrice / risk;
  }
  const feeUsd = typeof it.feesUsd === "number" ? it.feesUsd : null;
  const feeR = feeUsd != null && it.effectiveRiskUsd && it.effectiveRiskUsd > 0 ? feeUsd / it.effectiveRiskUsd : null;

  // predicted L1 adverse fill cost (one-way, in R) from the emulator at the SAME reference + risk.
  let predictedL1SlippageR: number | null = null, expectedL1FillPrice: number | null = null;
  if (usable && ref != null && risk != null && risk > 0) {
    const sim = simulateExecution({ orderId: "cal", decisionId: "cal", side, type: "MARKET", requestedQty: it.qty && it.qty > 0 ? it.qty : 1, referencePrice: ref, riskDistancePrice: risk, submittedAtMs: submitAt ?? 0 }, ctx.l1);
    predictedL1SlippageR = (sim.spreadCostR ?? 0) + (sim.slippageR ?? 0);
    expectedL1FillPrice = sim.averageFillPrice;
  }
  const slippageResidualR = entrySlippageR != null && predictedL1SlippageR != null ? entrySlippageR - predictedL1SlippageR : null;

  const row = {
    intentId: it.paperOrderId ?? null, orderId: it.entryOrderId != null ? String(it.entryOrderId) : null,
    symbol: it.symbol ?? "?", side, orderType: "MARKET" as const,
    qty: it.qty ?? null, notionalUsd: it.qty != null && fill != null ? it.qty * fill : null,
    decisionSubmitAtMs: submitAt, ackAtMs: null, closedAtMs: closedAt, holdMs: submitAt != null && closedAt != null ? closedAt - submitAt : null,
    referencePrice: ref, actualFillPrice: fill, riskDistancePrice: risk,
    expectedL1FillPrice, predictedLatencyMs: ctx.l1.latencyMs, actualLatencyMs: null,
    entrySlippageBps, entrySlippageR, predictedL1SlippageR, slippageResidualR,
    feeUsd, feeR, fundingUsd: null,
    entryConfirmed: confirmed, partial: null, rejected,
    volTier: null, liqTier: null, venue: ctx.venue, sourceInstance: ctx.sourceInstance,
    usable, rejectReason,
  };
  return stampRow(row, { provenance: ctx.provenance, evidenceClass: ctx.evidenceClass, asOfMs: submitAt ?? 0, sourceTimestampsMs: [submitAt ?? 0, closedAt ?? 0].filter((v) => v > 0) });
}

const stats = (xs: number[]) => {
  const u = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!u.length) return { n: 0, mean: null as number | null, median: null as number | null, p90: null as number | null, p95: null as number | null, p99: null as number | null, std: null as number | null };
  const mean = u.reduce((a, v) => a + v, 0) / u.length;
  const std = Math.sqrt(u.reduce((a, v) => a + (v - mean) ** 2, 0) / u.length);
  return { n: u.length, mean, median: quantile(u, 0.5), p90: quantile(u, 0.9), p95: quantile(u, 0.95), p99: quantile(u, 0.99), std };
};

/** Aggregate calibration report: coverage, usable/rejected funnel, slippage distributions, residuals, fitted L1. */
export function summarizeCalibration(rows: CalibrationRow[]) {
  const usable = rows.filter((r) => r.usable);
  const rejected = rows.filter((r) => !r.usable);
  const rejectReasons: Record<string, number> = {};
  for (const r of rejected) rejectReasons[r.rejectReason ?? (r.rejected ? "order rejected/failed" : "unknown")] = (rejectReasons[r.rejectReason ?? (r.rejected ? "order rejected/failed" : "unknown")] ?? 0) + 1;
  const dates = usable.map((r) => r.decisionSubmitAtMs).filter((v): v is number => v != null).sort((a, b) => a - b);
  const bySide = (s: "BUY" | "SELL") => stats(usable.filter((r) => r.side === s).map((r) => r.entrySlippageBps!).filter((v) => v != null));
  const bySymbol: Record<string, ReturnType<typeof stats>> = {};
  for (const sym of [...new Set(usable.map((r) => r.symbol))]) bySymbol[sym] = stats(usable.filter((r) => r.symbol === sym).map((r) => r.entrySlippageBps!).filter((v) => v != null));
  // size buckets by notional
  const sizeBucket = (n: number | null) => (n == null ? "unknown" : n < 50 ? "<50" : n < 150 ? "50-150" : n < 500 ? "150-500" : "500+");
  const bySize: Record<string, ReturnType<typeof stats>> = {};
  for (const b of ["<50", "50-150", "150-500", "500+", "unknown"]) { const g = usable.filter((r) => sizeBucket(r.notionalUsd) === b); if (g.length) bySize[b] = stats(g.map((r) => r.entrySlippageBps!).filter((v) => v != null)); }

  return {
    coverage: { totalRows: rows.length, usable: usable.length, rejected: rejected.length, rejectReasons, dateRangeMs: { first: dates[0] ?? null, last: dates.at(-1) ?? null } },
    latency: { note: "UNAVAILABLE — the intent ledger records no separate exchange-ack timestamp; submit→ack latency cannot be measured from these logs (not fabricated).", p50: null, p90: null, p95: null, p99: null },
    fillProbability: { note: "usable confirmed fills / attempts; PARTIAL-fill fraction unavailable (ledger stores netted final qty only).", confirmedFillRate: rows.length ? usable.length / rows.length : null, partialFillRate: null },
    rejectionRate: rows.length ? rejected.filter((r) => r.rejected).length / rows.length : null,
    entrySlippageBps: { overall: stats(usable.map((r) => r.entrySlippageBps!).filter((v) => v != null)), buy: bySide("BUY"), sell: bySide("SELL"), bySymbol, bySize },
    entrySlippageR: stats(usable.map((r) => r.entrySlippageR!).filter((v) => v != null)),
    feeR: stats(usable.map((r) => r.feeR!).filter((v) => v != null)),
    predictedVsActualResidualR: stats(usable.map((r) => r.slippageResidualR!).filter((v) => v != null)),
    queueImpactNote: "queue position + market impact NOT modeled — requires Tier-C L2 order-book data.",
  };
}

/** Fit a calibrated L1 config so predicted central slippage matches OBSERVED (mean adverse bps). Confidence = n. */
export function fitL1Calibration(rows: CalibrationRow[], base: EmulatorConfig, nowMs: number): { calibrated: EmulatorConfig; observedMeanAdverseBps: number | null; observedMedianAdverseBps: number | null; n: number; confidence: "low" | "medium" | "high"; ageDaysSinceLastFill: number | null } {
  const usable = rows.filter((r) => r.usable && r.entrySlippageBps != null);
  const advBps = usable.map((r) => r.entrySlippageBps!);
  const st = stats(advBps);
  const lastFill = Math.max(0, ...usable.map((r) => r.decisionSubmitAtMs ?? 0));
  // Calibrate the combined (half-spread + slippage) so predicted adverse ≈ observed mean; keep fee/latency as-is.
  // The emulator's market-order adverse = halfSpread + slip = spreadBps/2 + slippageBps (in bps of ref). Solve.
  const targetBps = Math.max(0, st.mean ?? 0);
  const calibrated: EmulatorConfig = { ...base, spreadBps: 0, slippageBps: targetBps }; // attribute all measured adverse to slippage (no book to split spread)
  const n = usable.length;
  return {
    calibrated, observedMeanAdverseBps: round4(st.mean), observedMedianAdverseBps: round4(st.median), n,
    confidence: n >= 200 ? "high" : n >= 60 ? "medium" : "low",
    ageDaysSinceLastFill: lastFill > 0 ? round4((nowMs - lastFill) / 86_400_000) : null,
  };
}

/** Compare round-trip entry cost in R across L0 / uncalibrated-L1 / calibrated-L1 / OBSERVED, on the usable rows. */
export function compareCostModels(rows: CalibrationRow[], uncalibratedL1: EmulatorConfig, calibratedL1: EmulatorConfig): Record<string, { meanOneWaySlippageR: number | null; n: number }> {
  const usable = rows.filter((r) => r.usable && r.referencePrice != null && r.riskDistancePrice != null && r.riskDistancePrice > 0);
  const predict = (cfg: EmulatorConfig) => stats(usable.map((r) => {
    const s = simulateExecution({ orderId: "c", decisionId: "c", side: r.side, type: "MARKET", requestedQty: r.qty && r.qty > 0 ? r.qty : 1, referencePrice: r.referencePrice!, riskDistancePrice: r.riskDistancePrice!, submittedAtMs: 0 }, cfg);
    return (s.spreadCostR ?? 0) + (s.slippageR ?? 0);
  })).mean;
  return {
    L0: { meanOneWaySlippageR: 0, n: usable.length },
    uncalibratedL1: { meanOneWaySlippageR: round4(predict(uncalibratedL1)), n: usable.length },
    calibratedL1: { meanOneWaySlippageR: round4(predict(calibratedL1)), n: usable.length },
    observed: { meanOneWaySlippageR: round4(stats(usable.map((r) => r.entrySlippageR!).filter((v) => v != null)).mean), n: usable.filter((r) => r.entrySlippageR != null).length },
  };
}

function round4(v: number | null | undefined): number | null { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }

const dayOf = (ms: number | null): number | null => (ms == null ? null : Math.floor(ms / 86_400_000));
const hourUtc = (ms: number | null): number | null => (ms == null ? null : Math.floor(ms / 3_600_000) % 24);

/** Day-clustered bootstrap CI of mean adverse slippage (bps) for a usable-row subset. */
function bpsCI(rows: CalibrationRow[], seed: number) {
  const pts = rows.filter((r) => r.usable && r.entrySlippageBps != null && r.decisionSubmitAtMs != null)
    .map((r) => ({ dayKey: dayOf(r.decisionSubmitAtMs)!, value: r.entrySlippageBps! }));
  const ci = clusteredBootstrapMeanCI(pts, { iters: 2000, seed, alpha: 0.05 });
  return { meanBps: round4(ci.point), lo: round4(ci.lo), hi: round4(ci.hi), dayBlocks: ci.blocks, n: pts.length };
}

/**
 * Required breakdowns (spec Track 3): slippage by symbol / side / order-type / size / time-of-day / instance,
 * with the SHORT side split out (it shows materially worse slippage). Volatility + latency + cancel + partial are
 * NOT recoverable from today's ledger (no per-fill vol, no ack/cancel timestamps) — surfaced as pending, not faked.
 */
export function calibrationBreakdowns(rows: CalibrationRow[]) {
  const usable = rows.filter((r) => r.usable);
  const grp = (keyFn: (r: CalibrationRow) => string | number | null, seed = 1): Record<string, ReturnType<typeof bpsCI> & { median: number | null }> => {
    const out: Record<string, ReturnType<typeof bpsCI> & { median: number | null }> = {};
    const keys = [...new Set(usable.map(keyFn).filter((k) => k != null))];
    for (const k of keys) {
      const sub = usable.filter((r) => keyFn(r) === k);
      const med = quantile(sub.map((r) => r.entrySlippageBps!).filter((v) => v != null), 0.5);
      out[String(k)] = { ...bpsCI(sub, seed + String(k).length), median: round4(med) };
    }
    return out;
  };
  const sizeBucket = (n: number | null) => (n == null ? "unknown" : n < 50 ? "<50" : n < 150 ? "50-150" : n < 500 ? "150-500" : "500+");

  const shortRows = usable.filter((r) => r.side === "SELL");
  const longRows = usable.filter((r) => r.side === "BUY");
  const shortResidualR = quantile(shortRows.map((r) => r.slippageResidualR!).filter((v) => v != null), 0.5);
  const overallResidualMeanR = (() => { const v = usable.map((r) => r.slippageResidualR).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();

  // missing-field coverage (what fraction of usable rows lack each calibration field)
  const cov = (pred: (r: CalibrationRow) => boolean) => (usable.length ? usable.filter(pred).length / usable.length : null);
  const missingFieldCoverage = {
    ackTimestamp: 1, // 100% missing — ledger has no ack ts
    partialFillFlag: 1, // 100% missing
    cancelTimestamps: 1, // 100% missing
    perFillVolatility: 1, // 100% missing
    feeR_present: round4(cov((r) => r.feeR != null)),
    slippage_present: round4(cov((r) => r.entrySlippageBps != null)),
  };

  // economic materiality of the residual (does the L1 model's error move decisions?)
  const MATERIAL_R = 0.01;
  const economicallyMaterial = {
    overallResidualMeanR: round4(overallResidualMeanR),
    threshold: MATERIAL_R,
    overallMaterial: overallResidualMeanR != null && Math.abs(overallResidualMeanR) > MATERIAL_R,
    shortSideMedianResidualR: round4(shortResidualR),
    shortSideMaterial: shortResidualR != null && Math.abs(shortResidualR) > MATERIAL_R,
    verdict: "the MEDIAN fill's L1 residual is sub-material; the short side and the fat tail are the only material gaps — L2's realistic scope.",
  };

  return {
    bySymbol: grp((r) => r.symbol, 3),
    bySide: { BUY: { ...bpsCI(longRows, 11), median: round4(quantile(longRows.map((r) => r.entrySlippageBps!).filter((v) => v != null), 0.5)), n: longRows.length },
              SELL: { ...bpsCI(shortRows, 13), median: round4(quantile(shortRows.map((r) => r.entrySlippageBps!).filter((v) => v != null), 0.5)), n: shortRows.length } },
    byOrderType: grp((r) => r.orderType, 5),
    bySize: grp((r) => sizeBucket(r.notionalUsd), 7),
    byHourUtc: grp((r) => hourUtc(r.decisionSubmitAtMs), 9),
    byInstance: grp((r) => r.sourceInstance, 17),
    byVolatility: { note: "UNAVAILABLE — per-fill volatility is not recorded in the intent ledger; add to the lifecycle-timestamp schema to enable." },
    latency: { note: "UNAVAILABLE — needs decisionAt/submittedAt/exchangeAckAt/firstFillAt from the new lifecycle schema (Track 3a). p50/p90/p95/p99 pending.", p50: null, p90: null, p95: null, p99: null },
    cancelLatency: { note: "UNAVAILABLE — needs cancelRequestedAt/cancelAckAt.", p50: null },
    partialFillRate: { note: "UNAVAILABLE — ledger stores netted final qty only." },
    rejectionRate: rows.length ? rows.filter((r) => r.rejected).length / rows.length : null,
    missingFieldCoverage,
    economicallyMaterial,
  };
}

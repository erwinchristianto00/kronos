/**
 * Four-Brain shadow-tick metrics aggregator (report-only). Accumulates FourBrainTickMetrics across ticks so
 * the operator report can show: tick completion / error / skip counts, missing+stale source rates, invariant
 * failures, and gather / inference / journal latency percentiles. Pure bookkeeping — imports NOTHING that
 * mutates live state; it only READS the metrics the tick already produced. Latency samples are kept in a
 * BOUNDED ring (never unbounded growth). No Date.now (deterministic + resume-safe).
 */
import type { FourBrainTickMetrics } from "./four-brain-shadow-tick.js";

const RING_CAP = 512; // bounded latency history per stage

class Ring {
  private buf: number[] = [];
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > RING_CAP) this.buf.shift();
  }
  percentile(p: number): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
  }
  get count(): number { return this.buf.length; }
}

export interface FourBrainMetricsSummary {
  ticks: {
    attempted: number;
    completed: number;
    skippedSingleFlight: number;
    gatherErrors: number;
    exceptions: number;
    journalErrors: number;
    invariantFailures: number;
  };
  decisions: { total: number; duplicateDecisionIds: number; unknownLanes: number; duplicateIdentities: number };
  coverage: { lastLaneCoverage: number; maxLaneCoverage: number; lastPositionCoverage: number; maxPositionCoverage: number };
  /** Per freshness-class: fraction of readings that were stale / missing / error (0..1) over all ticks. */
  sourceQuality: Record<string, { total: number; freshPct: number; stalePct: number; missingPct: number; errorPct: number }>;
  byCandidateStatus: Record<string, number>;
  byBrainAction: Record<string, number>;
  latencyMs: {
    gather: { p50: number | null; p90: number | null; p99: number | null; samples: number };
    inference: { p50: number | null; p90: number | null; p99: number | null; samples: number };
    journal: { p50: number | null; p90: number | null; p99: number | null; samples: number };
  };
}

export class FourBrainMetricsAggregator {
  private attempted = 0;
  private completed = 0;
  private skipped = 0;
  private gatherErrors = 0;
  private exceptions = 0;
  private journalErrors = 0;
  private invariantFailures = 0;
  private decisions = 0;
  private dupDecisionIds = 0;
  private unknownLanes = 0;
  private dupIdentities = 0;
  private lastLaneCoverage = 0;
  private maxLaneCoverage = 0;
  private lastPositionCoverage = 0;
  private maxPositionCoverage = 0;
  private byCandidateStatus: Record<string, number> = {};
  private byBrainAction: Record<string, number> = {};
  private freshness: Record<string, { total: number; fresh: number; stale: number; missing: number; error: number }> = {};
  private gatherRing = new Ring();
  private inferenceRing = new Ring();
  private journalRing = new Ring();

  /** Fold one tick's metrics + its terminal reason into the running totals. */
  record(m: FourBrainTickMetrics, reason: "mode-off" | "single-flight-skip" | "gather-error" | "exception" | "ok"): void {
    if (reason === "mode-off") return; // a gated-off tick is not an attempt
    this.attempted += m.attempted;
    if (reason === "ok") this.completed += 1;
    this.skipped += m.skippedSingleFlight;
    this.gatherErrors += m.gatherErrors;
    if (reason === "exception") this.exceptions += 1;
    this.journalErrors += m.journalErrors;
    this.invariantFailures += m.invariantFailures;
    this.decisions += m.decisions;
    this.dupDecisionIds += m.duplicateDecisionIds;
    this.unknownLanes += m.unknownLanes;
    this.dupIdentities += m.duplicateIdentities;
    this.lastLaneCoverage = m.laneCoverage;
    this.maxLaneCoverage = Math.max(this.maxLaneCoverage, m.laneCoverage);
    this.lastPositionCoverage = m.positionCoverage;
    this.maxPositionCoverage = Math.max(this.maxPositionCoverage, m.positionCoverage);
    for (const [k, v] of Object.entries(m.byCandidateStatus)) this.byCandidateStatus[k] = (this.byCandidateStatus[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.byBrainAction)) this.byBrainAction[k] = (this.byBrainAction[k] ?? 0) + v;
    for (const [cls, c] of Object.entries(m.staleOrMissingByClass)) {
      const agg = (this.freshness[cls] ??= { total: 0, fresh: 0, stale: 0, missing: 0, error: 0 });
      agg.fresh += c.fresh; agg.stale += c.stale; agg.missing += c.missing; agg.error += c.error;
      agg.total += c.fresh + c.stale + c.missing + c.error;
    }
    this.gatherRing.push(m.gatherMs);
    this.inferenceRing.push(m.inferenceMs);
    this.journalRing.push(m.journalMs);
  }

  summary(): FourBrainMetricsSummary {
    const sourceQuality: FourBrainMetricsSummary["sourceQuality"] = {};
    for (const [cls, a] of Object.entries(this.freshness)) {
      const t = a.total > 0 ? a.total : 1;
      sourceQuality[cls] = {
        total: a.total,
        freshPct: (a.fresh / t) * 100,
        stalePct: (a.stale / t) * 100,
        missingPct: (a.missing / t) * 100,
        errorPct: (a.error / t) * 100,
      };
    }
    const pct = (r: Ring) => ({ p50: r.percentile(50), p90: r.percentile(90), p99: r.percentile(99), samples: r.count });
    return {
      ticks: {
        attempted: this.attempted,
        completed: this.completed,
        skippedSingleFlight: this.skipped,
        gatherErrors: this.gatherErrors,
        exceptions: this.exceptions,
        journalErrors: this.journalErrors,
        invariantFailures: this.invariantFailures,
      },
      decisions: { total: this.decisions, duplicateDecisionIds: this.dupDecisionIds, unknownLanes: this.unknownLanes, duplicateIdentities: this.dupIdentities },
      coverage: {
        lastLaneCoverage: this.lastLaneCoverage, maxLaneCoverage: this.maxLaneCoverage,
        lastPositionCoverage: this.lastPositionCoverage, maxPositionCoverage: this.maxPositionCoverage,
      },
      sourceQuality,
      byCandidateStatus: { ...this.byCandidateStatus },
      byBrainAction: { ...this.byBrainAction },
      latencyMs: { gather: pct(this.gatherRing), inference: pct(this.inferenceRing), journal: pct(this.journalRing) },
    };
  }
}

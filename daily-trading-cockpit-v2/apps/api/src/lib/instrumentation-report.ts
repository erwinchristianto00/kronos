/**
 * Report over the two recorders installed 2026-08-17, both of which exist because the questions they
 * answer were previously UNANSWERABLE — not for lack of history, but because the data was never
 * created:
 *
 *   1. Baskets the minScoreGap gate refused. `buildCrossSectionalBasket` returned null and wrote
 *      nothing, so the live store held ZERO observations below the 0.02 floor (measured: minimum
 *      recorded scoreGap 0.0202 FILTERED / 0.0315 RAW). "Is the gate set right?" could never be
 *      answered from live data however long the lane ran.
 *   2. Open interest and orderbook depth. `futures/data/*` caps at ~30 days (= 15 independent 48h
 *      blocks) and depth has no history at all, so neither can be tested retrospectively — the only
 *      route is to start recording.
 *
 * Pure over injected file contents so the shape is testable without a filesystem or a clock.
 */

export interface RejectedBasketRow {
  openedAtMs: number;
  signal: string;
  scoreGap: number;
  minScoreGap: number;
  longs: Array<{ symbol: string; score: number }>;
  shorts: Array<{ symbol: string; score: number }>;
}

export interface MicroRow {
  t: number;
  sym: string;
  oi: number | null;
  bid?: number;
  ask?: number;
  spreadBps?: number | null;
  imb5?: number;
  imb20?: number;
  bidUsd20?: number;
  askUsd20?: number;
}

export interface InstrumentationReport {
  generatedAt: string;
  rejected: {
    count: number;
    /** How far below the floor each refusal sat, in percentage points — a refusal 0.05pp short is a
     *  very different fact from one 1.5pp short, and the raw log alone does not say which. */
    rows: Array<RejectedBasketRow & { shortfallPp: number; horizonElapsed: boolean; evaluableAt: string }>;
    nearMisses: number;
    horizonMs: number;
  };
  micro: {
    symbols: number;
    snapshots: number;
    firstAt: string | null;
    lastAt: string | null;
    hoursCovered: number;
    /** 48h blocks accumulated so far, and the target that makes an effect of realistic size
     *  detectable. Stated so the page cannot be mistaken for something already conclusive. */
    blocks: number;
    blocksNeeded: number;
    latest: MicroRow[];
  };
}

/** Tolerant of partial/corrupt trailing lines — an append-only file can be read mid-write. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip the partial line rather than lose the whole file
    }
  }
  return out;
}

export function buildInstrumentationReport(
  rejectedText: string,
  microText: string,
  opts: { nowMs: number; horizonMs: number; blocksNeeded?: number },
): InstrumentationReport {
  const rejected = parseJsonl<RejectedBasketRow>(rejectedText).filter(
    (r) => Number.isFinite(r.openedAtMs) && Number.isFinite(r.scoreGap),
  );
  const rows = rejected
    .slice()
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .map((r) => ({
      ...r,
      shortfallPp: (r.minScoreGap - r.scoreGap) * 100,
      horizonElapsed: r.openedAtMs + opts.horizonMs <= opts.nowMs,
      evaluableAt: new Date(r.openedAtMs + opts.horizonMs).toISOString(),
    }));

  const micro = parseJsonl<MicroRow>(microText).filter((r) => Number.isFinite(r.t) && typeof r.sym === "string");
  const times = micro.map((r) => r.t).sort((a, b) => a - b);
  const first = times[0] ?? null;
  const last = times[times.length - 1] ?? null;
  const hours = first !== null && last !== null ? (last - first) / 3_600_000 : 0;
  const lastT = last;
  const latest = lastT === null ? [] : micro.filter((r) => r.t === lastT).sort((a, b) => a.sym.localeCompare(b.sym));

  return {
    generatedAt: new Date(opts.nowMs).toISOString(),
    rejected: {
      count: rows.length,
      rows,
      // Within 0.5pp of the floor: these are the refusals where the gate's exact level actually decided.
      nearMisses: rows.filter((r) => r.shortfallPp <= 0.5).length,
      horizonMs: opts.horizonMs,
    },
    micro: {
      symbols: new Set(micro.map((r) => r.sym)).size,
      snapshots: micro.length,
      firstAt: first === null ? null : new Date(first).toISOString(),
      lastAt: last === null ? null : new Date(last).toISOString(),
      hoursCovered: hours,
      blocks: Math.floor(hours / 48),
      blocksNeeded: opts.blocksNeeded ?? 45,
      latest,
    },
  };
}

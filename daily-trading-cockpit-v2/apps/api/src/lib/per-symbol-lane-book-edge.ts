/**
 * Per-symbol × lane BOOK edge (report-only analysis).
 *
 * The lane-level auto-quarantine benches a whole variant lane when its REALIZED paper-book economics
 * go negative at adequate sample. But edge is heterogeneous ACROSS symbols inside a lane — a benched
 * lane can still contain a handful of symbols that are genuinely book-positive. The operator sees the
 * `/` panel's OPTIMISTIC sim per-symbol numbers (byAxisSymbol) and (reasonably) wants to trade the
 * green ones — but the sim is not what pays. This re-scores every (lane × symbol) cell on the SAME
 * realized paper book that drives the bench (mean of order.netR over CLOSED orders), for ALL
 * directions (LONG / SHORT / MIXED), so we can answer honestly: which symbols carry real, book-proven
 * edge, and via which lane — the disciplined basis for opening MORE than the current 3-per-batch cap.
 *
 * Two honesty overlays make this promotion-safe (added 2026-07-05 after the first read showed every
 * positive cell was diagnostic-only and some were fill-model mirages):
 *   - CONFIRMATION: HEADLINE closes are the real, admitted trades; DIAGNOSTIC_ONLY closes are the
 *     measurement sleeve (can be more optimistic / non-representative). A cell is only HEADLINE_CONFIRMED
 *     when its headline-only economics ALSO clear the bar. `promotable` requires it; `testnetCandidate`
 *     is the diagnostic-credible set to run on testnet to EARN that confirmation.
 *   - EXECUTABLE / SUSPICIOUS FILL: MAKER lanes can't execute live (maker vs taker adverse selection),
 *     and PF/WR that are too-good-to-be-true (pf huge, wr≈100%) are fill-model artifacts, not edge.
 *
 * Pure: caller passes the paper orders; nothing is mutated or executed. This measures; it does not
 * promote. Promotion to testnet/live must still be an explicit, separately-gated step.
 */

const CLOSED = new Set(["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"]);
const PERFECT_PF_SENTINEL = 999;

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isDiagnostic(o: PsleOrder): boolean {
  return o.paperOrderMode === "DIAGNOSTIC_ONLY" || o.diagnosticLabel === "BACKFILL_DIAGNOSTIC";
}

/** MAKER lanes need maker fills that don't survive live taker execution — never live-executable. */
function isExecutableLane(laneId: string): boolean {
  return !/MAKER/i.test(laneId);
}

export interface PsleOrder {
  symbol: string;
  selectedLaneId: string;
  direction?: "LONG" | "SHORT" | null;
  paperStatus: string;
  netR: number | null;
  paperOrderMode?: string | null;
  diagnosticLabel?: string | null;
}

export type PsleVerdict = "BOOK_POSITIVE" | "BOOK_NEGATIVE" | "BOOK_MARGINAL" | "INSUFFICIENT";
export type PsleConfirmation = "HEADLINE_CONFIRMED" | "HEADLINE_NEGATIVE" | "HEADLINE_MARGINAL" | "DIAGNOSTIC_ONLY";

interface Econ {
  closed: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  totalR: number;
}

function econOf(list: PsleOrder[]): Econ {
  const nets = list.map((o) => o.netR).filter(finite);
  const positive = nets.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const negative = nets.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
  const totalR = nets.reduce((a, b) => a + b, 0);
  const wins = list.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN").length;
  return {
    closed: list.length,
    netAvgR: nets.length > 0 ? totalR / nets.length : null,
    pf: negative > 0 ? positive / negative : positive > 0 ? PERFECT_PF_SENTINEL : null,
    wr: list.length > 0 ? wins / list.length : null,
    totalR,
  };
}

export interface PsleCell {
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT" | "MIXED" | null;
  /** Correlated-alt basket membership (BTC/ETH are the exempt majors) — feeds the future per-cluster cap. */
  bucket: "MAJOR" | "ALT";
  closed: number;
  headlineClosed: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  totalR: number;
  /** Headline-only (real admitted trades) economics — the promotion-relevant read. */
  headlineNetAvgR: number | null;
  headlinePf: number | null;
  executable: boolean;
  /** pf/wr too-good-to-be-true → fill-model artifact, not real edge. */
  suspiciousFill: boolean;
  verdict: PsleVerdict;
  confirmation: PsleConfirmation;
  /** BOOK_POSITIVE, executable, not suspicious, AND headline-confirmed → OK to consider for LIVE. */
  promotable: boolean;
  /** BOOK_POSITIVE, executable, not suspicious, not headline-contradicted → run on TESTNET to confirm. */
  testnetCandidate: boolean;
}

export interface PsleBestLane {
  symbol: string;
  direction: "LONG" | "SHORT" | "MIXED" | null;
  bucket: "MAJOR" | "ALT";
  bestLaneId: string | null;
  bestNetAvgR: number | null;
  bestClosed: number;
  stage: "PROMOTABLE" | "TESTNET_CANDIDATE" | "NONE";
  positiveLaneCount: number;
  measuredLaneCount: number;
}

export interface PerSymbolLaneBookEdgeReport {
  minClosed: number;
  minHeadlineClosed: number;
  posMinAvgR: number;
  negMaxAvgR: number;
  cells: PsleCell[];
  bestLanePerSymbol: PsleBestLane[];
  summary: {
    measuredCells: number;
    bookPositiveCells: number;
    promotableCells: number;
    testnetCandidateCells: number;
    byDirection: Record<"LONG" | "SHORT" | "MIXED", { measured: number; bookPositive: number; testnetCandidate: number; promotable: number }>;
    symbolsMeasured: number;
    symbolsTestnetCandidate: number;
    symbolsPromotable: number;
  };
}

export interface PsleOptions {
  /** Adequate-sample floor for a book verdict (mirrors the quarantine's own bar). Default 40. */
  minClosed?: number;
  /** Headline closes required before a cell can be HEADLINE_CONFIRMED (else DIAGNOSTIC_ONLY). Default 20. */
  minHeadlineClosed?: number;
  /** netAvgR at/above this (with PF>1) = BOOK_POSITIVE. Default +0.03 (symmetric to the -0.03 bench bar). */
  posMinAvgR?: number;
  /** netAvgR at/below this = BOOK_NEGATIVE. Default -0.03. */
  negMaxAvgR?: number;
  /** Cells with fewer closed than this are dropped entirely (noise). Default 10. */
  displayFloor?: number;
  /** PF at/above this is flagged suspiciousFill (fill-model artifact). Default 10. */
  suspiciousPf?: number;
  /** WR at/above this is flagged suspiciousFill. Default 0.98. */
  suspiciousWr?: number;
}

function isMajor(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s === "BTCUSDT" || s === "ETHUSDT";
}

function bookVerdict(e: Econ, minClosed: number, posMinAvgR: number, negMaxAvgR: number): PsleVerdict {
  if (e.closed < minClosed || e.netAvgR === null) return "INSUFFICIENT";
  if (e.netAvgR >= posMinAvgR && e.pf !== null && e.pf > 1) return "BOOK_POSITIVE";
  if (e.netAvgR <= negMaxAvgR) return "BOOK_NEGATIVE";
  return "BOOK_MARGINAL";
}

function confirmationOf(h: Econ, minHeadlineClosed: number, posMinAvgR: number, negMaxAvgR: number): PsleConfirmation {
  if (h.closed < minHeadlineClosed || h.netAvgR === null) return "DIAGNOSTIC_ONLY";
  if (h.netAvgR >= posMinAvgR && h.pf !== null && h.pf > 1) return "HEADLINE_CONFIRMED";
  if (h.netAvgR <= negMaxAvgR) return "HEADLINE_NEGATIVE";
  return "HEADLINE_MARGINAL";
}

export type LaneSymbolCurationTier = "testnet" | "live";

export interface LaneSymbolCurationDecision {
  /** null = no verdict available (stale/missing report, or this lane has zero measured cells)
   *  → callers must treat this as "not curated yet", i.e. fall back to the lane's normal,
   *  uncurated (full-universe) admission. A non-null array (even empty) is authoritative:
   *  the lane HAS enough data to judge, and only these symbols (or none) qualify. */
  curated: string[] | null;
  reason: "OK" | "STALE_OR_MISSING" | "NO_DATA_FOR_LANE";
}

/**
 * Per-lane symbol curation, derived from the SAME book cells this report already computes.
 * `testnet` tier uses `testnetCandidate` (book-positive, executable, not a fill artifact — the bar
 * for earning real/headline confirmation). `live` tier uses `promotable` (additionally
 * headline-confirmed) — real money only trades symbols with REAL admitted-trade proof, not just
 * diagnostic sleeve evidence. Both auto-rotate: recomputed fresh from the full order history each
 * time the source report regenerates, so a symbol that decays below the bar drops out next cycle
 * and a newly-proven one is added — no manual list to maintain.
 */
export function getCuratedSymbolsForLane(
  report: PerSymbolLaneBookEdgeReport | null,
  reportGeneratedAt: string | null,
  laneId: string,
  tier: LaneSymbolCurationTier,
  maxStalenessMs: number,
  nowMs: number = Date.now(),
): LaneSymbolCurationDecision {
  if (!report || !reportGeneratedAt) return { curated: null, reason: "STALE_OR_MISSING" };
  const generatedAtMs = new Date(reportGeneratedAt).getTime();
  if (!Number.isFinite(generatedAtMs) || nowMs - generatedAtMs > maxStalenessMs) {
    return { curated: null, reason: "STALE_OR_MISSING" };
  }
  const cells = report.cells.filter((c) => c.laneId === laneId);
  if (cells.length === 0) return { curated: null, reason: "NO_DATA_FOR_LANE" };
  const qualifies = tier === "live" ? (c: PsleCell) => c.promotable : (c: PsleCell) => c.testnetCandidate;
  return { curated: cells.filter(qualifies).map((c) => c.symbol), reason: "OK" };
}

export function buildPerSymbolLaneBookEdge(
  orders: PsleOrder[],
  opts: PsleOptions = {},
): PerSymbolLaneBookEdgeReport {
  const minClosed = opts.minClosed ?? 40;
  const minHeadlineClosed = opts.minHeadlineClosed ?? 20;
  const posMinAvgR = opts.posMinAvgR ?? 0.03;
  const negMaxAvgR = opts.negMaxAvgR ?? -0.03;
  const displayFloor = opts.displayFloor ?? 10;
  const suspiciousPf = opts.suspiciousPf ?? 10;
  const suspiciousWr = opts.suspiciousWr ?? 0.98;

  const groups = new Map<string, PsleOrder[]>();
  for (const o of orders) {
    if (!CLOSED.has(o.paperStatus)) continue;
    if (!o.selectedLaneId || !o.symbol) continue;
    const key = `${o.selectedLaneId} ${o.symbol}`;
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }

  const cells: PsleCell[] = [];
  for (const [key, list] of groups) {
    const [laneId, symbol] = key.split(" ") as [string, string];
    if (list.length < displayFloor) continue;
    const all = econOf(list);
    const headline = econOf(list.filter((o) => !isDiagnostic(o)));
    const dirs = new Set(list.map((o) => o.direction).filter((d): d is "LONG" | "SHORT" => d === "LONG" || d === "SHORT"));
    const direction: PsleCell["direction"] = dirs.size === 1 ? [...dirs][0]! : dirs.size === 0 ? null : "MIXED";
    const executable = isExecutableLane(laneId);
    const suspiciousFill =
      (all.pf !== null && all.pf >= suspiciousPf) || (all.wr !== null && all.wr >= suspiciousWr);
    const verdict = bookVerdict(all, minClosed, posMinAvgR, negMaxAvgR);
    const confirmation = confirmationOf(headline, minHeadlineClosed, posMinAvgR, negMaxAvgR);
    const crediblePositive = verdict === "BOOK_POSITIVE" && executable && !suspiciousFill;
    const promotable = crediblePositive && confirmation === "HEADLINE_CONFIRMED";
    const testnetCandidate = crediblePositive && confirmation !== "HEADLINE_NEGATIVE";
    cells.push({
      laneId,
      symbol,
      direction,
      bucket: isMajor(symbol) ? "MAJOR" : "ALT",
      closed: all.closed,
      headlineClosed: headline.closed,
      netAvgR: all.netAvgR,
      pf: all.pf,
      wr: all.wr,
      totalR: all.totalR,
      headlineNetAvgR: headline.netAvgR,
      headlinePf: headline.pf,
      executable,
      suspiciousFill,
      verdict,
      confirmation,
      promotable,
      testnetCandidate,
    });
  }

  // Best lane per symbol: promotable first, else testnet-candidate, by netAvgR.
  const bySymbol = new Map<string, PsleCell[]>();
  for (const c of cells) {
    const list = bySymbol.get(c.symbol);
    if (list) list.push(c);
    else bySymbol.set(c.symbol, [c]);
  }
  const bestLanePerSymbol: PsleBestLane[] = [];
  for (const [symbol, list] of bySymbol) {
    const byR = (a: PsleCell, b: PsleCell) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity);
    const promotables = list.filter((c) => c.promotable).sort(byR);
    const testnetCands = list.filter((c) => c.testnetCandidate).sort(byR);
    const best = promotables[0] ?? testnetCands[0] ?? null;
    const stage: PsleBestLane["stage"] = promotables[0] ? "PROMOTABLE" : testnetCands[0] ? "TESTNET_CANDIDATE" : "NONE";
    bestLanePerSymbol.push({
      symbol,
      direction: best?.direction ?? list[0]?.direction ?? null,
      bucket: isMajor(symbol) ? "MAJOR" : "ALT",
      bestLaneId: best?.laneId ?? null,
      bestNetAvgR: best?.netAvgR ?? null,
      bestClosed: best?.closed ?? 0,
      stage,
      positiveLaneCount: list.filter((c) => c.verdict === "BOOK_POSITIVE").length,
      measuredLaneCount: list.filter((c) => c.verdict !== "INSUFFICIENT").length,
    });
  }

  const stageRank = (c: PsleCell) => (c.promotable ? 0 : c.testnetCandidate ? 1 : c.verdict === "BOOK_POSITIVE" ? 2 : c.verdict === "BOOK_MARGINAL" ? 3 : c.verdict === "INSUFFICIENT" ? 4 : 5);
  cells.sort((a, b) => stageRank(a) - stageRank(b) || (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity) || b.closed - a.closed);
  const bestStageRank: Record<PsleBestLane["stage"], number> = { PROMOTABLE: 0, TESTNET_CANDIDATE: 1, NONE: 2 };
  bestLanePerSymbol.sort((a, b) => bestStageRank[a.stage] - bestStageRank[b.stage] || (b.bestNetAvgR ?? -Infinity) - (a.bestNetAvgR ?? -Infinity));

  const byDirection: PerSymbolLaneBookEdgeReport["summary"]["byDirection"] = {
    LONG: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
    SHORT: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
    MIXED: { measured: 0, bookPositive: 0, testnetCandidate: 0, promotable: 0 },
  };
  for (const c of cells) {
    const d = c.direction ?? "MIXED";
    const slot = byDirection[d];
    if (c.verdict !== "INSUFFICIENT") slot.measured += 1;
    if (c.verdict === "BOOK_POSITIVE") slot.bookPositive += 1;
    if (c.testnetCandidate) slot.testnetCandidate += 1;
    if (c.promotable) slot.promotable += 1;
  }

  return {
    minClosed,
    minHeadlineClosed,
    posMinAvgR,
    negMaxAvgR,
    cells,
    bestLanePerSymbol,
    summary: {
      measuredCells: cells.filter((c) => c.verdict !== "INSUFFICIENT").length,
      bookPositiveCells: cells.filter((c) => c.verdict === "BOOK_POSITIVE").length,
      promotableCells: cells.filter((c) => c.promotable).length,
      testnetCandidateCells: cells.filter((c) => c.testnetCandidate).length,
      byDirection,
      symbolsMeasured: bestLanePerSymbol.filter((s) => s.measuredLaneCount > 0).length,
      symbolsTestnetCandidate: bestLanePerSymbol.filter((s) => s.stage === "TESTNET_CANDIDATE" || s.stage === "PROMOTABLE").length,
      symbolsPromotable: bestLanePerSymbol.filter((s) => s.stage === "PROMOTABLE").length,
    },
  };
}

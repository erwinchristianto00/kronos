/**
 * Narrative tags per symbol + basket narrative-tilt/edge report (2026-07-07 operator ask:
 * "Bangun tag narasi per simbol (AI/meme/L1/DeFi) + report apakah basket condong ke narasi
 * tertentu dan apakah itu menambah edge").
 *
 * Crypto is narrative-driven: money rotates between sectors (AI season, meme season, L1
 * rotation) faster than fundamentals move. The cross-sectional basket already trades pure
 * momentum ranks — this module measures whether those ranks are secretly a NARRATIVE bet
 * (e.g. every long is AI, every short is MEME ⇒ the "market-neutral" basket is actually a
 * sector spread) and whether any narrative's legs carry real edge.
 *
 * REPORT-ONLY. Nothing here gates admission or execution — measure first, wire later.
 * Static tags are deliberate: narrative membership changes over months, not hours, and a
 * hand-audited map cannot silently drift the way a scraped one can. Multi-tag is allowed
 * where genuinely dual (NEAR is both an L1 and an AI-rotation name).
 */
import type { CrossSectionalObservation } from "./cross-sectional-edge.js";
import type { ExecutorBasket } from "./cross-sectional-executor.js";

export type Narrative = "MAJOR" | "L1" | "L2" | "AI" | "MEME" | "DEFI" | "PAYMENTS" | "DEPIN";

/** Hand-audited map for the scanner UNIVERSE (see scan-service.ts). Futures aliases with a
 *  1000x multiplier (1000PEPEUSDT) resolve through narrativesFor's prefix strip. */
export const SYMBOL_NARRATIVES: Readonly<Record<string, readonly Narrative[]>> = {
  BTCUSDT: ["MAJOR"],
  ETHUSDT: ["MAJOR", "L1"],
  BNBUSDT: ["MAJOR", "L1"],
  SOLUSDT: ["L1"],
  AVAXUSDT: ["L1"],
  ADAUSDT: ["L1"],
  APTUSDT: ["L1"],
  SEIUSDT: ["L1"],
  SUIUSDT: ["L1"],
  NEARUSDT: ["L1", "AI"],
  INJUSDT: ["L1", "DEFI"],
  XRPUSDT: ["PAYMENTS"],
  DOGEUSDT: ["MEME"],
  PEPEUSDT: ["MEME"],
  LINKUSDT: ["DEFI"],
  ARBUSDT: ["L2"],
  OPUSDT: ["L2"],
  WLDUSDT: ["AI"],
  FETUSDT: ["AI"],
  RNDRUSDT: ["AI", "DEPIN"],
};

/** Tags for a futures symbol; strips Binance's 1000x-multiplier prefix (1000PEPEUSDT → PEPEUSDT).
 *  Unknown symbols return [] — reported as untagged, never guessed. */
export function narrativesFor(symbol: string): readonly Narrative[] {
  return SYMBOL_NARRATIVES[symbol] ?? SYMBOL_NARRATIVES[symbol.replace(/^1000/, "")] ?? [];
}

interface NarrativeSideStats {
  legs: number;
  resolvedLegs: number;
  /** Mean direction-adjusted per-leg return (LONG: exit/entry−1; SHORT: −(exit/entry−1)).
   *  null when no resolved legs — never fabricate a number from an empty sample. */
  meanAdjReturn: number | null;
  winRate: number | null;
}

export interface NarrativeEdgeRow {
  narrative: Narrative | "UNTAGGED";
  long: NarrativeSideStats;
  short: NarrativeSideStats;
  /** Combined both-sides direction-adjusted mean — the "does this narrative add edge" number. */
  combined: NarrativeSideStats;
}

export interface NarrativeTiltRow {
  narrative: Narrative | "UNTAGGED";
  longLegs: number;
  shortLegs: number;
  /** longLegs − shortLegs: persistent positive/negative = the basket systematically bets FOR/AGAINST
   *  this narrative — a hidden sector exposure inside a nominally market-neutral book. */
  net: number;
}

export interface NarrativeTiltReport {
  generatedAt: string;
  tags: Record<string, readonly Narrative[]>;
  /** Signal-store observations (measurement lane) — larger sample, sim prices. */
  measured: { variant: string; observations: number; resolved: number; edge: NarrativeEdgeRow[] };
  /** Executor baskets — small sample but REAL fills on the exchange. */
  executed: { baskets: number; closed: number; edge: NarrativeEdgeRow[] };
  /** Narrative composition of the most recent window (open + recent), long vs short. */
  tilt: { windowBaskets: number; rows: NarrativeTiltRow[]; dominantLong: string | null; dominantShort: string | null };
  notes: string[];
}

type LegSample = { narrative: Narrative | "UNTAGGED"; side: "LONG" | "SHORT"; adjReturn: number | null };

function sampleLeg(symbol: string, side: "LONG" | "SHORT", entryPrice: number, exitPrice: number | null): LegSample[] {
  const adjReturn =
    exitPrice !== null && entryPrice > 0
      ? (side === "LONG" ? 1 : -1) * (exitPrice / entryPrice - 1)
      : null;
  const tags = narrativesFor(symbol);
  if (tags.length === 0) return [{ narrative: "UNTAGGED", side, adjReturn }];
  return tags.map((narrative) => ({ narrative, side, adjReturn }));
}

function sideStats(samples: LegSample[]): NarrativeSideStats {
  const resolved = samples.filter((s) => s.adjReturn !== null) as Array<LegSample & { adjReturn: number }>;
  return {
    legs: samples.length,
    resolvedLegs: resolved.length,
    meanAdjReturn: resolved.length ? resolved.reduce((a, s) => a + s.adjReturn, 0) / resolved.length : null,
    winRate: resolved.length ? resolved.filter((s) => s.adjReturn > 0).length / resolved.length : null,
  };
}

function edgeRows(samples: LegSample[]): NarrativeEdgeRow[] {
  const byNarrative = new Map<Narrative | "UNTAGGED", LegSample[]>();
  for (const s of samples) {
    const list = byNarrative.get(s.narrative) ?? [];
    list.push(s);
    byNarrative.set(s.narrative, list);
  }
  return [...byNarrative.entries()]
    .map(([narrative, list]) => ({
      narrative,
      long: sideStats(list.filter((s) => s.side === "LONG")),
      short: sideStats(list.filter((s) => s.side === "SHORT")),
      combined: sideStats(list),
    }))
    .sort((a, b) => b.combined.resolvedLegs - a.combined.resolvedLegs);
}

export function buildNarrativeTiltReport(opts: {
  measuredObservations: CrossSectionalObservation[];
  executedBaskets: ExecutorBasket[];
  variant?: string;
  nowIso: string;
  /** How many most-recent baskets/observations feed the CURRENT-tilt section. */
  tiltWindow?: number;
}): NarrativeTiltReport {
  const variant = opts.variant ?? "FILTERED";
  const tiltWindow = Math.max(1, opts.tiltWindow ?? 10);

  const measuredObs = opts.measuredObservations.filter((o) => (o.variant ?? "RAW") === variant);
  const measuredSamples: LegSample[] = [];
  for (const o of measuredObs) {
    for (const l of o.longLeg) measuredSamples.push(...sampleLeg(l.symbol, "LONG", l.entryPrice, l.exitPrice));
    for (const l of o.shortLeg) measuredSamples.push(...sampleLeg(l.symbol, "SHORT", l.entryPrice, l.exitPrice));
  }

  // 2026-08-05 (second-audit finding): defensive accountingStatus check alongside the pre-existing
  // status filter, mirroring every other ExecutorBasket consumer's exclusion (see
  // cross-sectional-executor.ts:910/943/961/985/994/1322, routes/live.ts's
  // mergeCrossSectionalIntoLaneSeries). Today accountingStatus is only ever set together with
  // status:"ABORTED" (see closeBasket's staleBookReconciled branch), so this is currently a no-op
  // in practice -- but this report-only narrative feed should not silently start including an
  // out-of-band-flattened basket's real prices if that coupling is ever loosened.
  const executedReal = opts.executedBaskets.filter(
    (b) => b.status !== "ABORTED" && b.accountingStatus !== "ACCOUNTING_INCOMPLETE",
  );
  const executedSamples: LegSample[] = [];
  for (const b of executedReal) {
    for (const l of b.legs) executedSamples.push(...sampleLeg(l.symbol, l.side, l.entryPrice, l.exitPrice));
  }

  // Current tilt: executed baskets are the book that actually exists — prefer them; fall back to
  // measured observations only when the executor has no history at all (e.g. research instance).
  const tiltSource: LegSample[] = [];
  let windowBaskets = 0;
  if (executedReal.length > 0) {
    const recent = executedReal.slice(-tiltWindow);
    windowBaskets = recent.length;
    for (const b of recent) for (const l of b.legs) tiltSource.push(...sampleLeg(l.symbol, l.side, l.entryPrice, null));
  } else {
    const recent = measuredObs.slice(-tiltWindow);
    windowBaskets = recent.length;
    for (const o of recent) {
      for (const l of o.longLeg) tiltSource.push(...sampleLeg(l.symbol, "LONG", l.entryPrice, null));
      for (const l of o.shortLeg) tiltSource.push(...sampleLeg(l.symbol, "SHORT", l.entryPrice, null));
    }
  }
  const tiltMap = new Map<Narrative | "UNTAGGED", { longLegs: number; shortLegs: number }>();
  for (const s of tiltSource) {
    const row = tiltMap.get(s.narrative) ?? { longLegs: 0, shortLegs: 0 };
    if (s.side === "LONG") row.longLegs += 1;
    else row.shortLegs += 1;
    tiltMap.set(s.narrative, row);
  }
  const tiltRows: NarrativeTiltRow[] = [...tiltMap.entries()]
    .map(([narrative, r]) => ({ narrative, longLegs: r.longLegs, shortLegs: r.shortLegs, net: r.longLegs - r.shortLegs }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const dominantLong = tiltRows.filter((r) => r.net > 0)[0]?.narrative ?? null;
  const dominantShort = tiltRows.filter((r) => r.net < 0)[0]?.narrative ?? null;

  return {
    generatedAt: opts.nowIso,
    tags: { ...SYMBOL_NARRATIVES },
    measured: {
      variant,
      observations: measuredObs.length,
      resolved: measuredObs.filter((o) => o.status !== "OPEN").length,
      edge: edgeRows(measuredSamples),
    },
    executed: {
      baskets: executedReal.length,
      closed: executedReal.filter((b) => b.status === "CLOSED").length,
      edge: edgeRows(executedSamples),
    },
    tilt: { windowBaskets, rows: tiltRows, dominantLong, dominantShort },
    notes: [
      "REPORT-ONLY: nothing gates execution on narratives yet — measure before wiring.",
      "meanAdjReturn is per-leg and direction-adjusted (SHORT legs flipped); null = no resolved legs, never fabricated.",
      "A multi-tag symbol (e.g. RNDR = AI+DEPIN) counts once per tag, so narrative rows overlap by design.",
      "tilt.net persistently positive/negative on one narrative = the market-neutral basket is carrying a hidden sector bet.",
    ],
  };
}

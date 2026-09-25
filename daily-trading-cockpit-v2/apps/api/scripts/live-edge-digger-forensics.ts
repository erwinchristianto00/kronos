/**
 * LIVE EDGE DIGGER — read-only loss forensics.
 *
 * Answers one question against a SNAPSHOT of the shadow store: when the digger reports negative
 * candidates, what is actually producing the number?
 *
 * STRICTLY READ-ONLY. It opens one file for reading and writes nothing anywhere. It does not import
 * the cycle module, so it cannot start a scan, resolve a position, or touch the live store. Point it
 * at a COPY, never at the file a running instance is writing:
 *
 *   npx tsx scripts/live-edge-digger-forensics.ts /path/to/snapshot.json [--json]
 *
 * Every metric is computed with the SAME functions the engine uses (`independentEpisodes`,
 * `candidateMetrics`, `clusterBootstrap`), so a number here cannot drift from the number the
 * dashboard shows. Cost components are re-derived from the stored fields using the engine's own
 * formulas and then reconciled against the stored `costR` — if the reconstruction disagreed, the
 * decomposition would be fiction, so the script reports the mismatch count rather than assuming.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  EPISODE_BLOCK_WIDTH_MS,
  FUNDING_BPS_PER_8H,
  STOP_SLIPPAGE_BPS,
  candidateMetrics,
  clusterBootstrap,
  independentEpisodes,
  type ShadowObservation,
} from "../src/lib/live-edge-digger.js";
import { TAKER_ROUNDTRIP_BPS } from "../src/lib/current-guard-variant-matrix.js";

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ruleOf = (candidateId: string): string => candidateId.split("@")[0] ?? candidateId;
const isResolved = (o: ShadowObservation): boolean =>
  o.status !== "OPEN" && typeof o.netR === "number" && Number.isFinite(o.netR);

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function fmt(v: number | null | undefined, dp = 4): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(dp);
}
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

/** The instant a row stopped being live: its resolution, or the snapshot horizon if still OPEN. */
function closedAtMs(o: ShadowObservation, snapshotMs: number): number {
  if (o.resolvedAt !== null) {
    const t = Date.parse(o.resolvedAt);
    if (Number.isFinite(t)) return t;
  }
  return snapshotMs;
}

// ---------------------------------------------------------------------------
// Cost decomposition — the engine's formulas, re-derived per row.
// ---------------------------------------------------------------------------

interface CostParts {
  feeR: number;
  slippageR: number;
  fundingR: number;
  totalR: number;
  /** |reconstructed - stored|. Non-trivial values would invalidate the decomposition. */
  reconstructionError: number;
}

function costParts(o: ShadowObservation): CostParts | null {
  if (typeof o.costR !== "number" || typeof o.holdHours !== "number") return null;
  const stopBps = o.stopDistanceBps;
  if (!(stopBps > 0)) return null;
  const feeR = TAKER_ROUNDTRIP_BPS / stopBps;
  const slippageR = o.exitReason === "STOP" || o.exitReason === "AMBIGUOUS_STOP_FIRST"
    ? STOP_SLIPPAGE_BPS / stopBps
    : 0;
  const periods = Math.floor(o.holdHours / 8);
  const fundingR = periods > 0 ? (periods * FUNDING_BPS_PER_8H) / stopBps : 0;
  const totalR = feeR + slippageR + fundingR;
  return { feeR, slippageR, fundingR, totalR, reconstructionError: Math.abs(-totalR - o.costR) };
}

// ---------------------------------------------------------------------------
// A. Overlap — entries opened while a prior row of the same candidate+symbol was live.
// ---------------------------------------------------------------------------

interface OverlapStat {
  key: string;
  rows: number;
  overlapping: number;
  maxDepth: number;
  distinctEntryPrices: number;
  /** Rows that are the FIRST live entry for their candidate+symbol (the no-re-entry counterfactual). */
  firstEntryRows: ShadowObservation[];
}

function overlapFor(rows: readonly ShadowObservation[], snapshotMs: number, key: string): OverlapStat {
  const ordered = rows.slice().sort((a, b) => a.openedAtMs - b.openedAtMs);
  let overlapping = 0;
  let maxDepth = 0;
  const firstEntryRows: ShadowObservation[] = [];
  // A row is admissible under "one live position at a time" only if nothing earlier is still live.
  let liveUntil = -Infinity;
  for (const r of ordered) {
    const live = ordered.filter((p) => p.openedAtMs < r.openedAtMs && closedAtMs(p, snapshotMs) > r.openedAtMs);
    if (live.length > 0) overlapping += 1;
    maxDepth = Math.max(maxDepth, live.length);
    if (r.openedAtMs >= liveUntil) {
      firstEntryRows.push(r);
      liveUntil = closedAtMs(r, snapshotMs);
    }
  }
  return {
    key, rows: ordered.length, overlapping, maxDepth,
    distinctEntryPrices: new Set(ordered.map((r) => r.entryPrice)).size,
    firstEntryRows,
  };
}

/** One entry per candidate per episode: keep the earliest row in each episode block. */
function oneEntryPerEpisode(rows: readonly ShadowObservation[]): ShadowObservation[] {
  const ordered = rows.slice().sort((a, b) => a.openedAtMs - b.openedAtMs);
  const kept: ShadowObservation[] = [];
  let blockStart = -Infinity;
  for (const r of ordered) {
    if (r.openedAtMs - blockStart >= EPISODE_BLOCK_WIDTH_MS) {
      kept.push(r);
      blockStart = r.openedAtMs;
    }
  }
  return kept;
}

/** Equal weight per episode, not per row — one market look is one draw however many rows it made. */
function episodeWeightedExpectancy(rows: readonly ShadowObservation[]): number | null {
  const resolved = rows.filter(isResolved);
  if (resolved.length === 0) return null;
  const byExit = groupBy(resolved, (r) => r.resolvedAt ?? String(r.openedAtMs));
  const perEpisode = [...byExit.values()]
    .map((g) => mean(g.map((r) => r.netR as number)))
    .filter((v): v is number => v !== null);
  return mean(perEpisode);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const path = process.argv[2];
  const asJson = process.argv.includes("--json");
  if (!path) {
    console.error("usage: tsx scripts/live-edge-digger-forensics.ts <snapshot.json> [--json]");
    process.exit(2);
  }

  const raw = readFileSync(path, "utf8");
  const storeHash = createHash("sha256").update(raw).digest("hex");
  const parsed = JSON.parse(raw) as {
    observations?: ShadowObservation[];
    attempts?: Record<string, { ruleId: string; candidateId: string; cyclesEvaluated: number; cyclesFired: number; observationsEmitted: number; firstEvaluatedAt: string | null }>;
    cycleMeta?: Record<string, unknown>;
  };
  const obs = parsed.observations ?? [];
  const attempts = Object.values(parsed.attempts ?? {});
  if (obs.length === 0) {
    console.log("store contains no observations — nothing to analyse");
    return;
  }

  const snapshotMs = Math.max(...obs.map((o) => o.openedAtMs));
  const resolved = obs.filter(isResolved);
  const open = obs.filter((o) => o.status === "OPEN");

  const out: string[] = [];
  const p = (s = ""): void => { out.push(s); };

  p("=".repeat(100));
  p("LIVE EDGE DIGGER — READ-ONLY LOSS FORENSICS");
  p("=".repeat(100));
  p(`snapshot sha256   : ${storeHash}`);
  p(`observations      : ${obs.length}  (resolved ${resolved.length} / open ${open.length})`);
  p(`window            : ${new Date(Math.min(...obs.map((o) => o.openedAtMs))).toISOString()} .. ${new Date(snapshotMs).toISOString()}`);
  p(`window hours      : ${((snapshotMs - Math.min(...obs.map((o) => o.openedAtMs))) / HOUR).toFixed(2)}`);
  p(`candidates seen   : ${new Set(obs.map((o) => o.candidateId)).size}   symbols ${new Set(obs.map((o) => o.symbol)).size}   cycles ${new Set(obs.map((o) => o.cycleId)).size}`);
  p(`rules in registry : ${attempts.length}`);

  // ---- F. INTEGRITY (run first: everything downstream depends on it) ----------------------------
  p("");
  p("-".repeat(100));
  p("F. INTEGRITY");
  p("-".repeat(100));
  const ids = obs.map((o) => o.observationId);
  const dupIds = ids.length - new Set(ids).size;
  p(`duplicate observationId          : ${dupIds}`);

  let badRMath = 0, badCostSign = 0, badReconstruction = 0, staleOutcome = 0, formingBar = 0;
  const reconErrors: number[] = [];
  for (const o of resolved) {
    const risk = Math.abs(o.entryPrice - o.stopPrice);
    const expectedGross = o.direction === "LONG"
      ? ((o.exitPrice as number) - o.entryPrice) / risk
      : (o.entryPrice - (o.exitPrice as number)) / risk;
    if (Math.abs(expectedGross - (o.grossR as number)) > 1e-6) badRMath += 1;
    if ((o.costR as number) > 0) badCostSign += 1;
    if (Math.abs((o.grossR as number) + (o.costR as number) - (o.netR as number)) > 1e-9) badRMath += 1;
    const cp = costParts(o);
    if (cp) { reconErrors.push(cp.reconstructionError); if (cp.reconstructionError > 1e-9) badReconstruction += 1; }
    if (o.resolvedAt === null || o.exitReason === null || o.exitPrice === null) staleOutcome += 1;
    const f = o.features as unknown as { lastClosedCandleCloseMs?: number; asOfMs?: number };
    if (typeof f?.lastClosedCandleCloseMs === "number" && typeof f?.asOfMs === "number"
        && f.lastClosedCandleCloseMs > f.asOfMs) formingBar += 1;
  }
  p(`R-math violations (gross/net)    : ${badRMath}`);
  p(`positive (wrong-sign) costR      : ${badCostSign}`);
  p(`cost reconstruction mismatches   : ${badReconstruction}  (max err ${reconErrors.length ? Math.max(...reconErrors).toExponential(2) : "n/a"})`);
  p(`malformed / stale outcomes       : ${staleOutcome}`);
  p(`rows using a not-yet-closed bar  : ${formingBar}`);
  const anchored = attempts.filter((a) => a.firstEvaluatedAt !== null).length;
  p(`freeze anchors present           : ${anchored}/${attempts.length}`);
  let preFreeze = 0;
  for (const a of attempts) {
    if (a.firstEvaluatedAt === null) continue;
    const t = Date.parse(a.firstEvaluatedAt);
    preFreeze += obs.filter((o) => o.candidateId === a.candidateId && o.openedAtMs < t).length;
  }
  p(`rows opened BEFORE their anchor  : ${preFreeze}`);

  // ---- D. EXIT EFFECTS -------------------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("D. EXIT EFFECTS");
  p("-".repeat(100));
  p(`${"exitReason".padEnd(22)}${"n".padStart(6)}${"meanNetR".padStart(12)}${"meanGrossR".padStart(12)}${"sumNetR".padStart(12)}${"medHoldH".padStart(10)}`);
  for (const reason of ["TARGET", "STOP", "AMBIGUOUS_STOP_FIRST", "MAX_HOLD_MTM"]) {
    const g = resolved.filter((o) => o.exitReason === reason);
    const holds = g.map((o) => o.holdHours as number).sort((a, b) => a - b);
    p(
      reason.padEnd(22) +
      String(g.length).padStart(6) +
      fmt(mean(g.map((o) => o.netR as number))).padStart(12) +
      fmt(mean(g.map((o) => o.grossR as number))).padStart(12) +
      fmt(g.reduce((a, o) => a + (o.netR as number), 0), 2).padStart(12) +
      (holds.length ? holds[Math.floor(holds.length / 2)]!.toFixed(2) : "n/a").padStart(10),
    );
  }
  // Censoring: can an open row even reach a timeout yet?
  const elapsed = open.filter((o) => (snapshotMs - o.openedAtMs) / HOUR >= o.maxHoldHours).length;
  p("");
  p(`open rows whose horizon has fully elapsed : ${elapsed}/${open.length}`);
  p(`  -> MAX_HOLD_MTM is ${elapsed === 0 ? "STRUCTURALLY IMPOSSIBLE" : "possible"} in this window`);
  const ambiguous = resolved.filter((o) => o.exitReason === "AMBIGUOUS_STOP_FIRST");
  p(`ambiguous intrabar rows                   : ${ambiguous.length}`);
  if (ambiguous.length === 0) {
    p("  -> best/worst intrabar bounds are IDENTICAL to the canonical result; ambiguity explains 0.0000R");
  } else {
    const worst = mean(resolved.map((o) => o.netR as number));
    const best = mean(resolved.map((o) => {
      if (o.exitReason !== "AMBIGUOUS_STOP_FIRST") return o.netR as number;
      const risk = Math.abs(o.entryPrice - o.stopPrice);
      const g = Math.abs(o.targetPrice - o.entryPrice) / risk;
      return g - TAKER_ROUNDTRIP_BPS / o.stopDistanceBps;
    }));
    p(`  worst-case (canonical, stop-first) mean netR : ${fmt(worst)}`);
    p(`  best-case  (ambiguous pay target)  mean netR : ${fmt(best)}`);
    p(`  ambiguity accounts for at most               : ${fmt((best ?? 0) - (worst ?? 0))} R`);
  }

  // ---- C. COST DRAG ----------------------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("C. COST DRAG");
  p("-".repeat(100));
  const parts = resolved.map(costParts).filter((v): v is CostParts => v !== null);
  const grossMean = mean(resolved.map((o) => o.grossR as number));
  const netMean = mean(resolved.map((o) => o.netR as number));
  p(`gross expectancy : ${fmt(grossMean)} R`);
  p(`  fee (taker rt) : ${fmt(-(mean(parts.map((c) => c.feeR)) ?? 0))} R`);
  p(`  stop slippage  : ${fmt(-(mean(parts.map((c) => c.slippageR)) ?? 0))} R`);
  p(`  funding        : ${fmt(-(mean(parts.map((c) => c.fundingR)) ?? 0))} R`);
  p(`net expectancy   : ${fmt(netMean)} R`);
  const totalCost = (grossMean ?? 0) - (netMean ?? 0);
  p(`cost share of the loss : ${netMean !== null && netMean < 0 ? ((totalCost / Math.abs(netMean)) * 100).toFixed(2) + "%" : "n/a"}`);
  p(`classification   : ${
    grossMean === null ? "INSUFFICIENT EVIDENCE"
    : grossMean > 0 && (netMean ?? 0) <= 0 ? "GROSS POSITIVE, NET NEGATIVE (cost-driven)"
    : grossMean <= 0 ? "GROSS NEGATIVE BEFORE COST (cost is not the cause)"
    : "GROSS POSITIVE, NET POSITIVE"}`);

  // ---- A + B PER CANDIDATE ---------------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("A+B. PER-CANDIDATE TABLE (overlap, episodes, counterfactuals)");
  p("-".repeat(100));
  const header =
    "candidate".padEnd(38) + "raw".padStart(6) + "open".padStart(6) + "res".padStart(5) +
    "eps".padStart(5) + "ovlp".padStart(6) + "dEnt".padStart(6) +
    "rawExp".padStart(10) + "epsExp".padStart(10) + "cf1n:R".padStart(11) + "cf2r/all".padStart(10) +
    "WR".padStart(7) + "PF".padStart(14);
  p(header);
  const perCandidate: Record<string, unknown>[] = [];
  for (const [cid, rows] of [...groupBy(obs, (o) => o.candidateId)].sort((a, b) => b[1].length - a[1].length)) {
    const res = rows.filter(isResolved);
    const m = candidateMetrics(res);
    const eps = independentEpisodes(res);
    // Overlap aggregated over candidate+symbol.
    let ovlp = 0, dEnt = 0;
    const cf1: ShadowObservation[] = [];
    for (const [sym, srows] of groupBy(rows, (o) => o.symbol)) {
      const st = overlapFor(srows, snapshotMs, `${cid}|${sym}`);
      ovlp += st.overlapping; dEnt += st.distinctEntryPrices;
      cf1.push(...st.firstEntryRows);
    }
    const cf1Res = cf1.filter(isResolved);
    const cf2All = oneEntryPerEpisode(rows);
    const cf2Res = cf2All.filter(isResolved);
    const cf1Exp = mean(cf1Res.map((o) => o.netR as number));
    const cf2Exp = mean(cf2Res.map((o) => o.netR as number));
    p(
      ruleOf(cid).slice(0, 37).padEnd(38) +
      String(rows.length).padStart(6) +
      String(rows.filter((o) => o.status === "OPEN").length).padStart(6) +
      String(res.length).padStart(5) +
      String(eps).padStart(5) +
      String(ovlp).padStart(6) +
      String(dEnt).padStart(6) +
      fmt(m.netExpectancyR, 3).padStart(10) +
      fmt(episodeWeightedExpectancy(res), 3).padStart(10) +
      `${cf1Res.length}:${cf1Exp === null ? "n/a" : cf1Exp.toFixed(2)}`.padStart(10) +
      `${cf2Res.length}/${cf2All.length}`.padStart(10) +
      (m.wr === null ? "n/a" : (m.wr * 100).toFixed(0) + "%").padStart(7) +
      (m.pf === null ? m.pfStatus : m.pf.toFixed(3)).padStart(14),
    );
    const bs = clusterBootstrap(res);
    perCandidate.push({
      candidateId: cid, rule: ruleOf(cid), raw: rows.length,
      open: rows.filter((o) => o.status === "OPEN").length, resolved: res.length,
      episodes: eps, overlappingRows: ovlp, distinctEntryPrices: dEnt,
      rawExpectancyR: m.netExpectancyR, episodeWeightedExpectancyR: episodeWeightedExpectancy(res),
      counterfactualOneLivePerSymbolR: cf1Exp, counterfactualOnePerEpisodeR: cf2Exp,
      wr: m.wr, pf: m.pf, pfStatus: m.pfStatus,
      grossExpectancyR: m.grossExpectancyR,
      ci95: [bs.lowerBound95, bs.upperBound95], clusters: bs.clusters,
    });
  }

  // ---- B. SHARED-EVENT DEPENDENCE --------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("B. SHARED-EVENT DEPENDENCE (all resolved rows pooled)");
  p("-".repeat(100));
  p(`raw resolved rows            : ${resolved.length}`);
  p(`independent episodes         : ${independentEpisodes(resolved)}`);
  p(`distinct exit instants       : ${new Set(resolved.map((o) => o.resolvedAt)).size}`);
  p(`distinct (symbol,entryPrice) : ${new Set(resolved.map((o) => `${o.symbol}@${o.entryPrice}`)).size}`);
  p(`distinct netR values         : ${new Set(resolved.map((o) => (o.netR as number).toFixed(10))).size}`);
  const byExit = groupBy(resolved, (o) => o.resolvedAt ?? "?");
  const largest = Math.max(0, ...[...byExit.values()].map((g) => g.length));
  p(`largest shared-exit cluster  : ${largest} rows (${((largest / resolved.length) * 100).toFixed(1)}% of all resolved)`);
  p("");
  p("shared exit instants (multi-candidate losses land together):");
  for (const [t, g] of [...byExit].sort((a, b) => b[1].length - a[1].length)) {
    const cands = new Set(g.map((o) => ruleOf(o.candidateId)));
    const syms = new Set(g.map((o) => o.symbol));
    p(`  ${t}  rows=${String(g.length).padStart(3)}  candidates=${cands.size}  symbols=${[...syms].join(",")}  meanNetR=${fmt(mean(g.map((o) => o.netR as number)))}`);
  }
  p("");
  p(`pooled raw-row expectancy       : ${fmt(mean(resolved.map((o) => o.netR as number)))} R`);
  p(`pooled episode-weighted         : ${fmt(episodeWeightedExpectancy(resolved))} R`);

  // ---- E. SPLITS -------------------------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("E. RULE / MARKET MISMATCH");
  p("-".repeat(100));
  const splits: [string, (o: ShadowObservation) => string][] = [
    ["direction", (o) => o.direction],
    ["symbol", (o) => o.symbol],
    ["regimeAtEntry", (o) => o.regimeAtEntry ?? "null"],
    ["origin", (o) => (ruleOf(o.candidateId).startsWith("GEN_") ? "generated" : "seed")],
    ["day", (o) => o.openedAt.slice(0, 10)],
  ];
  for (const [label, keyOf] of splits) {
    p("");
    p(`by ${label}:`);
    for (const [k, g] of [...groupBy(resolved, keyOf)].sort((a, b) => b[1].length - a[1].length)) {
      p(`  ${k.padEnd(24)} n=${String(g.length).padStart(3)}  meanNetR=${fmt(mean(g.map((o) => o.netR as number)))}  episodes=${independentEpisodes(g)}`);
    }
  }
  // Emission-side coverage: what the scanner is actually producing, resolved or not.
  p("");
  p("emission concentration (ALL rows, resolved or not):");
  for (const [k, g] of [...groupBy(obs, (o) => o.symbol)].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    p(`  ${k.padEnd(12)} rows=${String(g.length).padStart(5)} (${((g.length / obs.length) * 100).toFixed(1)}%)  distinctEntryPrices=${new Set(g.map((o) => o.entryPrice)).size}`);
  }

  // ---- CENSORING: is the resolved subset even a fair sample? ------------------------------------
  p("");
  p("-".repeat(100));
  p("G. OUTCOME CENSORING (why the resolved subset is not a random sample)");
  p("-".repeat(100));
  p(`emitted rows                 : ${obs.length}`);
  p(`resolved so far              : ${resolved.length}  (${((resolved.length / obs.length) * 100).toFixed(1)}%)`);
  p(`still open                   : ${open.length}  (${((open.length / obs.length) * 100).toFixed(1)}%)`);
  p("");
  p("A stop sits 1.0R away; a target sits targetRMultiple R away. Whichever is CLOSER resolves first,");
  p("so in a young store the resolved subset is structurally the fast-losing tail. Rows that are");
  p("winning but have not yet touched their target are still counted as OPEN and contribute nothing.");
  p("");
  const rMultiples = new Set(resolved.map((o) => Math.abs(o.targetPrice - o.entryPrice) / Math.abs(o.entryPrice - o.stopPrice)));
  const distMoves = resolved.map((o) => ({
    stopPct: (Math.abs(o.entryPrice - o.stopPrice) / o.entryPrice) * 100,
    targetPct: (Math.abs(o.targetPrice - o.entryPrice) / o.entryPrice) * 100,
  }));
  p(`target R-multiples in resolved set : ${[...rMultiples].map((v) => v.toFixed(2)).join(", ")}`);
  if (distMoves.length > 0) {
    const sp = distMoves.map((d) => d.stopPct).sort((a, b) => a - b);
    const tp = distMoves.map((d) => d.targetPct).sort((a, b) => a - b);
    p(`stop distance   %: min ${sp[0]!.toFixed(2)}  med ${sp[Math.floor(sp.length / 2)]!.toFixed(2)}  max ${sp.at(-1)!.toFixed(2)}`);
    p(`target distance %: min ${tp[0]!.toFixed(2)}  med ${tp[Math.floor(tp.length / 2)]!.toFixed(2)}  max ${tp.at(-1)!.toFixed(2)}`);
  }
  // Under a driftless walk, P(touch -1R before +kR) = k/(1+k). This is the ZERO-EDGE expectation,
  // i.e. what an all-stops result looks like when nothing at all is wrong with the hypotheses.
  const episodesPooled = independentEpisodes(resolved);
  const distinctEvents = new Set(resolved.map((o) => o.resolvedAt)).size;
  const ks = [...rMultiples];
  const pStopPerEvent = ks.length > 0 ? mean(ks.map((k) => k / (1 + k)))! : 0.5;
  p("");
  p(`zero-edge P(stop before target)   : ${(pStopPerEvent * 100).toFixed(1)}% per event (driftless walk, k=${ks.map((v) => v.toFixed(2)).join("/")})`);
  p(`independent events observed       : ${distinctEvents} distinct exit instants / ${episodesPooled} canonical episode(s)`);
  p(`P(all ${distinctEvents} are stops | ZERO edge)      : ${(Math.pow(pStopPerEvent, distinctEvents) * 100).toFixed(1)}%`);
  p(`  -> ${Math.pow(pStopPerEvent, distinctEvents) > 0.05
    ? "NOT significant. An all-losses result of this size is an ordinary draw under a zero-edge null."
    : "significant at the 5% level."}`);

  // ---- A. AGGREGATE OVERLAP ---------------------------------------------------------------------
  p("");
  p("-".repeat(100));
  p("A. OVERLAP AGGREGATE");
  p("-".repeat(100));
  let totalOverlap = 0, totalMaxDepth = 0, groups = 0;
  const worstGroups: OverlapStat[] = [];
  for (const [cid, rows] of groupBy(obs, (o) => o.candidateId)) {
    for (const [sym, srows] of groupBy(rows, (o) => o.symbol)) {
      const st = overlapFor(srows, snapshotMs, `${ruleOf(cid)}|${sym}`);
      totalOverlap += st.overlapping;
      totalMaxDepth = Math.max(totalMaxDepth, st.maxDepth);
      groups += 1;
      worstGroups.push(st);
    }
  }
  p(`candidate+symbol groups          : ${groups}`);
  p(`rows opened while one was live   : ${totalOverlap}/${obs.length} (${((totalOverlap / obs.length) * 100).toFixed(1)}%)`);
  p(`max concurrent depth             : ${totalMaxDepth}`);
  p("");
  p("worst groups (rows vs distinct entry prices — equal counts mean every row is a fresh price):");
  for (const st of worstGroups.sort((a, b) => b.rows - a.rows).slice(0, 10)) {
    p(`  ${st.key.slice(0, 52).padEnd(54)} rows=${String(st.rows).padStart(4)} overlapping=${String(st.overlapping).padStart(4)} distinctEntries=${String(st.distinctEntryPrices).padStart(4)} maxDepth=${st.maxDepth}`);
  }

  console.log(out.join("\n"));
  if (asJson) {
    console.log("\n<<<JSON>>>");
    console.log(JSON.stringify({
      storeHash,
      window: { fromMs: Math.min(...obs.map((o) => o.openedAtMs)), toMs: snapshotMs },
      totals: { observations: obs.length, resolved: resolved.length, open: open.length },
      integrity: { dupIds, badRMath, badCostSign, badReconstruction, staleOutcome, formingBar, preFreeze, anchored, attempts: attempts.length },
      pooled: {
        rawExpectancyR: mean(resolved.map((o) => o.netR as number)),
        episodeWeightedExpectancyR: episodeWeightedExpectancy(resolved),
        grossExpectancyR: grossMean,
        episodes: independentEpisodes(resolved),
        distinctExitInstants: new Set(resolved.map((o) => o.resolvedAt)).size,
      },
      perCandidate,
    }, null, 2));
  }
}

main();

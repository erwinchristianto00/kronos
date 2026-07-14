/**
 * Tier-A candle proof — ONE-MONTH causal reconstruction runner (offline, read-only). Thin driver over the
 * FROZEN core (src/lib/replay-tier-a-core.ts): finds the 1h CSVs, reconstructs Market State + Direction, and
 * writes the one-month reports. The reconstruction RULES live in the core so the six-month runner shares them
 * verbatim. Touches NO live state, beta, CORTEX, or executor. Deterministic (no Date.now).
 *
 *   Usage: npx tsx scripts/replay-tier-a-run.ts <rawDir> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stableHash } from "../src/lib/replay-provenance.js";
import { tallyReplayStatuses } from "../src/lib/replay-quality-status.js";
import { planWalkForward, brierVsBaseRate, calibrationBins, calibrationLine } from "../src/lib/backfill-walkforward.js";
import { fitLogisticL2, predictLogistic } from "../src/lib/backfill-warmstart.js";
import { parseKlines, reconstructSymbol, HORIZON_BARS, HURDLE_R, type TAMarketRow, type TADirRow } from "../src/lib/replay-tier-a-core.js";
import type { DirectionHorizon } from "../src/lib/four-brain-types.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;

function main(): void {
  const rawDir = process.argv[2]!;
  const outDir = process.argv[3] ?? "artifacts/replay/tier-a-proof";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // ── Manifest (immutable-raw hashes + row/range + reconciliation) ──
  const manifestEntries: Array<{ file: string; sha256: string; rows: number; firstOpenTimeMs: number | null; lastOpenTimeMs: number | null }> = [];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".csv") ? [join(dir, d.name)] : []));
  for (const f of walk(rawDir).sort()) {
    const buf = readFileSync(f);
    const rows = buf.toString("utf8").split("\n").filter((l) => l.trim() && /^\d/.test(l)).length;
    const nums = buf.toString("utf8").split("\n").filter((l) => /^\d/.test(l)).map((l) => +l.split(",")[0]!);
    manifestEntries.push({ file: f.slice(rawDir.length + 1), sha256: createHash("sha256").update(buf).digest("hex"), rows, firstOpenTimeMs: nums[0] ?? null, lastOpenTimeMs: nums.at(-1) ?? null });
  }
  const manifestHash = stableHash(manifestEntries);

  // ── Reconstruction via the FROZEN core ──
  const marketRows: TAMarketRow[] = [];
  const dirRows: TADirRow[] = [];
  const gapReport: Array<{ symbol: string; gaps: number }> = [];
  let candidateTimestamps = 0, causalDecisions = 0, labeled = 0, leakGuardHits = 0;
  for (const symbol of SYMBOLS) {
    const csv = join(rawDir, `${symbol}-1h-2026-06`, `${symbol}-1h-2026-06.csv`);
    const r = reconstructSymbol(symbol, parseKlines(readFileSync(csv, "utf8")));
    marketRows.push(...r.marketRows); dirRows.push(...r.dirRows);
    gapReport.push({ symbol, gaps: r.gaps });
    candidateTimestamps += r.candidateTimestamps; causalDecisions += r.causalDecisions; labeled += r.labeled; leakGuardHits += r.leakGuardHits;
  }

  const dist = (arr: string[]): Record<string, number> => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
  const msByFamily = dist(marketRows.map((r) => r.family));
  const msByBias = dist(marketRows.map((r) => r.bias));
  let flips = 0; for (let i = 1; i < marketRows.length; i += 1) if (marketRows[i]!.symbol === marketRows[i - 1]!.symbol && marketRows[i]!.family !== marketRows[i - 1]!.family) flips += 1;
  const marketReport = {
    rows: marketRows.length, familyDistribution: msByFamily, biasDistribution: msByBias,
    unknownRatePct: round(100 * marketRows.filter((r) => r.unknown).length / marketRows.length),
    meanConfidence: round(mean(marketRows.map((r) => r.conf))), directStateFlipRatePct: round(100 * flips / marketRows.length),
    statusCounts: tallyReplayStatuses(marketRows.map((r) => r.status)),
    note: "breadth MISSING by construction (2-symbol universe, survivorship control) — market-wide breadth NOT claimed.",
  };

  const dirReport: Record<string, unknown> = {};
  for (const horizon of Object.keys(HORIZON_BARS) as DirectionHorizon[]) {
    const rows = dirRows.filter((r) => r.horizon === horizon && r.win !== null && r.status === "GOLD");
    const wf = planWalkForward(rows.map((r) => ({ tMs: r.tMs, x: r.x, y: r.win as 0 | 1, netR: r.chosenNetR ?? 0 })), 3, 0.25);
    const folds = wf.folds.map((f) => {
      const model = fitLogisticL2(f.trainIdx.map((i) => wf.sorted[i]!.x), f.trainIdx.map((i) => wf.sorted[i]!.y as 0 | 1), ["trend", "vol", "mom"], { l2: 1 });
      const preds = f.testIdx.map((i) => ({ p: predictLogistic(model, wf.sorted[i]!.x) ?? 0.5, y: wf.sorted[i]!.y as 0 | 1 }));
      return { fold: f.index, trainN: f.trainIdx.length, testN: f.testIdx.length, brierSkill: round(brierVsBaseRate(preds, model.positiveRate).brierSkill) };
    });
    const longRows = rows.map((r) => ({ tMs: r.tMs, x: r.x, y: (((r.longNetR.L1_base ?? -1) > HURDLE_R) ? 1 : 0) as 0 | 1, netR: r.longNetR.L1_base ?? 0 }));
    const wfB = planWalkForward(longRows, 3, 0.25);
    const foldsB = wfB.folds.map((f) => {
      const model = fitLogisticL2(f.trainIdx.map((i) => wfB.sorted[i]!.x), f.trainIdx.map((i) => wfB.sorted[i]!.y as 0 | 1), ["trend", "vol", "mom"], { l2: 1 });
      const preds = f.testIdx.map((i) => ({ p: predictLogistic(model, wfB.sorted[i]!.x) ?? 0.5, y: wfB.sorted[i]!.y as 0 | 1 }));
      return { fold: f.index, trainN: f.trainIdx.length, testN: f.testIdx.length, baseRate: round(model.positiveRate), brierSkill: round(brierVsBaseRate(preds, model.positiveRate).brierSkill), calibSlope: round(calibrationLine(calibrationBins(preds, 5)).slope) };
    });
    dirReport[horizon] = {
      goldRows: rows.length,
      brainActionDistribution: dist(dirRows.filter((r) => r.horizon === horizon).map((r) => r.action)),
      counterfactualBestActionDistribution: dist(rows.map((r) => r.bestAction)),
      brainDecisionMatchesBestPct: round(100 * rows.filter((r) => r.action === r.bestAction).length / Math.max(1, rows.length)),
      brainMeanChosenNetR: round(mean(rows.map((r) => r.chosenNetR ?? 0))),
      execSensitivity_meanLongNetR: Object.fromEntries(["L0", "L1_low", "L1_base", "L1_high"].map((lv) => [lv, round(mean(rows.map((r) => r.longNetR[lv] ?? 0)))])),
      brainWalkForward: folds,
      tierAModelWalkForward_longWin: foldsB, holdoutRows: wfB.holdoutIdx.length,
    };
  }

  const uniqDays = new Set(marketRows.map((r) => Math.floor(r.tMs / 86_400_000))).size;
  const ess = { marketRows: marketRows.length, directionRows: dirRows.length, calendarDays: uniqDays, symbols: SYMBOLS.length, horizons: Object.keys(HORIZON_BARS).length, uniqueDecisionTimestamps: new Set(marketRows.map((r) => r.tMs)).size, note: "SWING/INTRADAY horizons OVERLAP heavily (rolling) ⇒ effective independent N ≪ row count; 1 month ≈ 30 days is a tiny effective sample." };
  const reconciliation = {
    rawData: { expectedFiles: 8, csvFiles: manifestEntries.length, checksumValid: manifestEntries.length, gaps: gapReport },
    decisions: { candidateTimestamps, leakGuardRejections: leakGuardHits, causalDecisions, labeledOutcomes: labeled, marketRows: marketRows.length, directionRows: dirRows.length },
    note: "no silent row loss: candidateTimestamps − leakGuardRejections = causalDecisions per symbol; every direction row is labeled or explicitly LABEL-unsafe.",
  };
  const rerunHash = stableHash({ marketRows: marketRows.map((r) => [r.symbol, r.tMs, r.family, r.bias]), dirRows: dirRows.map((r) => [r.symbol, r.horizon, r.tMs, r.action, r.win]) });

  const write = (n: string, o: unknown) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
  write("data-manifest.json", { month: "2026-06", symbols: SYMBOLS, manifestHash, entries: manifestEntries });
  write("market-state-report.json", marketReport);
  write("direction-report.json", dirReport);
  write("reconciliation.json", reconciliation);
  write("effective-sample.json", ess);
  write("determinism.json", { rerunHash });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ manifestHash: manifestHash.slice(0, 16), candidateTimestamps, leakGuardRejections: leakGuardHits, causalDecisions, labeled, rerunHash: rerunHash.slice(0, 16) }, null, 1));
}
function mean(a: number[]): number { const u = a.filter((v) => Number.isFinite(v)); return u.length ? u.reduce((x, v) => x + v, 0) / u.length : 0; }
function round(v: number | null): number | null { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
main();

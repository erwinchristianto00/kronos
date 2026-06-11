#!/usr/bin/env node
/**
 * READ-ONLY audit: TopContributorFingerprintV0 predicate overlap diagnostics.
 * Verifies that crossed match/veto thresholds explain NEITHER=0 in current dashboard.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SHADOW_POSITIONS_PATH = path.join(REPO_ROOT, "data", "shadow-positions.json");
const DECISION_LOG_PATH = path.join(REPO_ROOT, "data", "decision-log.jsonl");

const isFin = Number.isFinite;
const r4 = (v) => (v === null || v === undefined || !isFin(v) ? null : Math.round(v * 10_000) / 10_000);
const r2 = (v) => (v === null || v === undefined || !isFin(v) ? null : Math.round(v * 100) / 100);

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const p75 = (arr) => quantile([...arr].sort((a, b) => a - b), 0.75);
const median = (arr) => quantile([...arr].sort((a, b) => a - b), 0.5);

const SUPPORT_ATR_MIN = 2.0;
const MIN_TOP = 10;
const MIN_NEG = 3;

// ─── Load records ────────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(SHADOW_POSITIONS_PATH, "utf8"));
const positions = Array.isArray(raw) ? raw : (raw.positions ?? raw);

function pickClosedVariant(p) {
  return (
    p.variants?.find((v) => v.variant === p.selectedExitVariant && v.state === "CLOSED") ??
    p.variants?.find((v) => v.state === "CLOSED") ??
    null
  );
}

const records = [];
for (const p of positions) {
  const variant = pickClosedVariant(p);
  if (!variant) continue;
  const ctx = p.strategyContextSnapshot;
  if (!ctx) continue;
  records.push({
    context: ctx,
    outcome: {
      symbol: p.symbol,
      openedAt: p.entryFilledAt ?? variant.openedAt ?? p.scannedAt ?? null,
      realizedNetR: typeof variant.realizedNetR === "number" ? variant.realizedNetR : null,
    },
  });
}

function inCohort(r) {
  const ctx = r.context;
  if (ctx.evidenceEra !== "POST_CALIBRATION") return false;
  const reg = ctx.marketRegime;
  if (!reg || !String(reg).toUpperCase().includes("BEAR")) return false;
  if (ctx.direction !== "SHORT") return false;
  if (ctx.selectedEntryVariant !== "vwap_retest_entry") return false;
  if (ctx.selectedExitVariant !== "tp1_full_exit") return false;
  if (ctx.whaleAgreement !== "AGREES") return false;
  return true;
}
const cohort = records.filter(inCohort);

// ─── Re-derive profile ───────────────────────────────────────────────────────
function netSumR(recs) {
  return recs.map((r) => r.outcome.realizedNetR).filter(isFin).reduce((a, b) => a + b, 0);
}
function bySymbol(recs) {
  const m = new Map();
  for (const r of recs) {
    if (!r.context.symbol) continue;
    if (!m.has(r.context.symbol)) m.set(r.context.symbol, []);
    m.get(r.context.symbol).push(r);
  }
  const out = [];
  for (const [symbol, list] of m) out.push({ symbol, records: list, netSum: netSumR(list) });
  return out;
}
const symStats = bySymbol(cohort);
const positiveSyms = symStats.filter((s) => s.netSum > 0).sort((a, b) => b.netSum - a.netSum);
const topSyms = new Set(positiveSyms.slice(0, 2).map((s) => s.symbol));
const topRecs = [];
const negRecs = [];
for (const s of symStats) {
  if (topSyms.has(s.symbol)) topRecs.push(...s.records);
  else if (s.netSum < 0) negRecs.push(...s.records);
}
const topStop = topRecs.map((r) => r.context.stopDistanceBps).filter(isFin);
const topDrift = topRecs.map((r) => r.context.entryDriftPctOfZone).filter(isFin);
const negStop = negRecs.map((r) => r.context.stopDistanceBps).filter(isFin);
const negDrift = negRecs.map((r) => r.context.entryDriftPctOfZone).filter(isFin);

const stopMatchMax = r4(p75(topStop));
const driftMatchMax = r4(p75(topDrift));
const stopVetoMin = r4(median(negStop));
const driftVetoMin = r4(median(negDrift));

// ─── Bucket per classifier ───────────────────────────────────────────────────
function evalRec(r) {
  const ctx = r.context;
  const stopBps = ctx.stopDistanceBps;
  const drift = ctx.entryDriftPctOfZone;
  const atr = ctx.entryDriftAtr;
  const chase = ctx.chaseRisk;

  const stopFin = isFin(stopBps);
  const driftFin = isFin(drift);

  const MATCH_CORE_STOP = stopFin && stopBps <= stopMatchMax;
  const MATCH_CORE_DRIFT = driftFin && drift <= driftMatchMax;
  const VETO_STOP = stopFin && stopBps >= stopVetoMin;
  const VETO_DRIFT = driftFin && drift >= driftVetoMin;
  const coreMatch = MATCH_CORE_STOP && MATCH_CORE_DRIFT;
  const anyVeto = VETO_STOP || VETO_DRIFT;
  const SUPPORT = chase === "HIGH" || (isFin(atr) && atr >= SUPPORT_ATR_MIN);

  let bucket;
  if (anyVeto) bucket = "VETO";
  else if (coreMatch) bucket = "MATCH";
  else bucket = "NEITHER";

  return { MATCH_CORE_STOP, MATCH_CORE_DRIFT, VETO_STOP, VETO_DRIFT, coreMatch, anyVeto, SUPPORT, bucket };
}

const evaluated = cohort.map((r) => ({ r, e: evalRec(r) }));
const matchCount = evaluated.filter((x) => x.e.bucket === "MATCH").length;
const vetoCount = evaluated.filter((x) => x.e.bucket === "VETO").length;
const neitherCount = evaluated.filter((x) => x.e.bucket === "NEITHER").length;

// ─── Stats helpers ──────────────────────────────────────────────────────────
function stats(recs) {
  const rs = recs.map((x) => (x.r ?? x).outcome.realizedNetR).filter(isFin);
  const n = (recs.length);
  if (rs.length === 0) return { n, netAvgR: null, PF: null, winPct: null };
  const sum = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((v) => v > 0);
  const losses = rs.filter((v) => v < 0);
  const lossAbs = losses.reduce((a, b) => a + Math.abs(b), 0);
  return {
    n,
    netAvgR: r4(sum / rs.length),
    PF: lossAbs === 0 ? null : r2(wins.reduce((a, b) => a + b, 0) / lossAbs),
    winPct: Math.round((wins.length / rs.length) * 100),
  };
}

// ─── Output report ─────────────────────────────────────────────────────────
let out = "";
out += "# Fingerprint V0 Overlap Audit\n\n";
out += "## A. Reconstructed profile\n\n";
out += "| Field | Reproduced | Dashboard |\n|---|---|---|\n";
out += `| sample n | ${cohort.length} | 172 |\n`;
out += `| top-records | ${topRecs.length} | 57 |\n`;
out += `| negative-records | ${negRecs.length} | 67 |\n`;
out += `| stopMatchMax | ${stopMatchMax} | 299 |\n`;
out += `| driftMatchMax | ${driftMatchMax} | -0.48 |\n`;
out += `| stopVetoMin | ${stopVetoMin} | 273 |\n`;
out += `| driftVetoMin | ${driftVetoMin} | -0.74 |\n`;
out += `| match count | ${matchCount} | 34 |\n`;
out += `| veto count | ${vetoCount} | 138 |\n`;
out += `| neither count | ${neitherCount} | 0 |\n\n`;
out += `top syms: [${[...topSyms].join(", ")}]\n\n`;

// ─── B. Predicate overlap ───────────────────────────────────────────────────
function group(filter) {
  return evaluated.filter(({ e }) => filter(e)).map((x) => x.r);
}
function row(label, recs) {
  const s = stats(recs);
  return `| ${label} | ${s.n} | ${s.netAvgR} | ${s.PF} | ${s.winPct} |\n`;
}

out += "## B. Raw predicate overlap\n\n";
out += "| Group | n | netAvgR | PF | Win% |\n|---|---:|---:|---:|---:|\n";
out += row("match-core-only (core=T, veto=F)", group((e) => e.coreMatch && !e.anyVeto));
out += row("veto-only (core=F, veto=T)", group((e) => !e.coreMatch && e.anyVeto));
out += row("both-match-and-veto (core=T, veto=T)", group((e) => e.coreMatch && e.anyVeto));
out += row("neither (core=F, veto=F)", group((e) => !e.coreMatch && !e.anyVeto));
out += row("core-match without support", group((e) => e.coreMatch && !e.SUPPORT));
out += row("support only (no core-match, w/ support)", group((e) => !e.coreMatch && e.SUPPORT));
out += row("veto by stop only", group((e) => e.VETO_STOP && !e.VETO_DRIFT));
out += row("veto by drift only", group((e) => !e.VETO_STOP && e.VETO_DRIFT));
out += row("veto by both", group((e) => e.VETO_STOP && e.VETO_DRIFT));
out += "\n";

// ─── C. Math overlap ────────────────────────────────────────────────────────
out += "## C. Mathematical overlap explanation\n\n";
out += `- stopVetoMin (${stopVetoMin}) <= stopMatchMax (${stopMatchMax}): ${stopVetoMin <= stopMatchMax}\n`;
out += `- driftVetoMin (${driftVetoMin}) <= driftMatchMax (${driftMatchMax}): ${driftVetoMin <= driftMatchMax}\n`;
const safeNotCore = group((e) => !e.anyVeto && !e.coreMatch);
out += `- count (NOT vetoed AND NOT core-match): ${safeNotCore.length} (should be 0 if hypothesis holds)\n\n`;

// ─── D. BOTH absorbed into VETO ─────────────────────────────────────────────
const bothCount = evaluated.filter(({ e }) => e.coreMatch && e.anyVeto).length;
out += "## D. BOTH absorbed into VETO\n\n";
out += `- Of ${vetoCount} VETO records, ${bothCount} also satisfy core-match (would be MATCH under different precedence).\n\n`;

// ─── E. Joint cell table ───────────────────────────────────────────────────
function cell(stopFn, driftFn, label, verdict) {
  const recs = evaluated.filter(({ r }) => {
    const s = r.context.stopDistanceBps, d = r.context.entryDriftPctOfZone;
    if (!isFin(s) || !isFin(d)) return false;
    return stopFn(s) && driftFn(d);
  }).map((x) => x.r);
  const s = stats(recs);
  return `| ${label} | ${s.n} | ${s.netAvgR} | ${verdict} |\n`;
}
out += "## E. Per-cell joint feature space\n\n";
out += "| stop | drift | n | net mean | classifier verdict |\n|---|---|---:|---:|---|\n";
const sLo = (s) => s < stopVetoMin;
const sMid = (s) => s >= stopVetoMin && s < stopMatchMax;
const sHi = (s) => s >= stopMatchMax;
const dLo = (d) => d < driftVetoMin;
const dMid = (d) => d >= driftVetoMin && d < driftMatchMax;
const dHi = (d) => d >= driftMatchMax;
out += cell(sLo, dLo, `stop<${stopVetoMin} | drift<${driftVetoMin}`, "core-match-only");
out += cell(sLo, dMid, `stop<${stopVetoMin} | ${driftVetoMin}<=drift<${driftMatchMax}`, "both-then-veto");
out += cell(sLo, dHi, `stop<${stopVetoMin} | drift>=${driftMatchMax}`, "veto-drift-only");
out += cell(sMid, dLo, `${stopVetoMin}<=stop<${stopMatchMax} | drift<${driftVetoMin}`, "both-then-veto");
out += cell(sMid, dMid, `${stopVetoMin}<=stop<${stopMatchMax} | mid`, "both-then-veto");
out += cell(sMid, dHi, `${stopVetoMin}<=stop<${stopMatchMax} | drift>=${driftMatchMax}`, "veto-both");
out += cell(sHi, dLo, `stop>=${stopMatchMax} | drift<${driftVetoMin}`, "veto-stop-only");
out += cell(sHi, dMid, `stop>=${stopMatchMax} | mid`, "veto-stop-only");
out += cell(sHi, dHi, `stop>=${stopMatchMax} | drift>=${driftMatchMax}`, "veto-both");
out += "\n";

// ─── F. Robustness on match-only ───────────────────────────────────────────
const matchOnly = group((e) => e.coreMatch && !e.anyVeto);
const days = new Set();
const syms = new Map();
for (const r of matchOnly) {
  if (r.outcome.openedAt) days.add(r.outcome.openedAt.slice(0, 10));
  const sym = r.context.symbol;
  syms.set(sym, (syms.get(sym) ?? 0) + (r.outcome.realizedNetR ?? 0));
}
const symArr = [...syms.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
const totalSum = symArr.reduce((a, b) => a + b[1], 0);
const top2Share = totalSum === 0 ? null : r4((symArr.slice(0, 2).reduce((a, b) => a + b[1], 0)) / totalSum);
out += "## F. Robustness (informational, match-core-only)\n\n";
out += `- match-only n: ${matchOnly.length}\n`;
out += `- calendarDayCount: ${days.size}\n`;
out += `- distinctSymbolCount: ${syms.size}\n`;
out += `- top2 sym share (signed): ${top2Share}\n\n`;

// ─── G. Snapshots ──────────────────────────────────────────────────────────
out += "## G. Prior snapshots\n\n";
if (fs.existsSync(DECISION_LOG_PATH)) {
  let priorCrossed = 0, priorNonCrossed = 0;
  const lines = fs.readFileSync(DECISION_LOG_PATH, "utf8").split("\n").filter(Boolean);
  for (const ln of lines) {
    try {
      const j = JSON.parse(ln);
      const mt = j?.report?.profile?.matchThresholds ?? j?.profile?.matchThresholds;
      const vt = j?.report?.profile?.vetoThresholds ?? j?.profile?.vetoThresholds;
      if (!mt || !vt) continue;
      const sM = mt.stopDistanceBpsMax, dM = mt.entryDriftPctOfZoneMax;
      const sV = vt.stopDistanceBpsMin, dV = vt.entryDriftPctOfZoneMin;
      if (sV !== null && sM !== null && dV !== null && dM !== null) {
        const crossed = sV <= sM && dV <= dM;
        if (crossed) priorCrossed++;
        else priorNonCrossed++;
      }
    } catch {}
  }
  out += `- decision-log.jsonl: crossed-threshold snapshots=${priorCrossed}, non-crossed=${priorNonCrossed}\n`;
} else {
  out += `- decision-log.jsonl not found at ${DECISION_LOG_PATH}; no historical comparison.\n`;
}

console.log(out);

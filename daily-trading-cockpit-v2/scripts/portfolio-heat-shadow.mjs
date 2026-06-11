#!/usr/bin/env node
// Portfolio-heat SHADOW viewer (read-only). Renders the daily snapshots that the API records
// each paper pass (see apps/api/src/lib/portfolio-heat-shadow.ts) so you can watch the
// profit-vs-risk-vs-ruin curve evolve as more trading days — especially bad regimes — accumulate.
//
//   node scripts/portfolio-heat-shadow.mjs
//
// It NEVER computes a fix or touches the book; it only displays measurement snapshots.
// Reads: apps/api/data/portfolio-heat-shadow-snapshots.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "apps", "api", "data", "portfolio-heat-shadow-snapshots.json");

if (!fs.existsSync(FILE)) {
  console.log("No snapshots yet. They are written each paper pass (operator-brief?paper=1).");
  console.log("Trigger one, then re-run this viewer.");
  process.exit(0);
}

const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
const snaps = doc.snapshots ?? [];
if (snaps.length === 0) {
  console.log("Snapshot file present but empty — run a paper pass to populate it.");
  process.exit(0);
}
const latest = snaps[snaps.length - 1];

console.log("PORTFOLIO-HEAT SHADOW  (measurement only — no gate, no trade)\n");
console.log(`latest snapshot: ${latest.twDate}  |  ${latest.bookClosed} closed  |  realized ${latest.realizedNT} NT  |  ${latest.twDays} TW days`);
console.log(
  `peak concurrent risk: ${latest.peakConcurrentRiskR}R = ${latest.peakRiskPctOfEquity}% of equity` +
    `  (>100% => one correlated stop-out wipes the account)\n`,
);

console.log("── latest heat-cap curve (per-trade 1% equity, equity-linked, compounding) ──");
console.log("heatCap  | terminalEq | peakRisk%Eq | maxDrawdown");
for (const r of latest.heatSweep) {
  const label = r.heatCapPct < 0 ? "UNCAPPED" : `${r.heatCapPct}%`;
  console.log(
    ` ${label.padStart(7)} | ${Math.round(r.terminalEq).toString().padStart(10)} | ${r.peakRiskPct.toFixed(0).padStart(7)}%    | ${r.maxDrawdownPct.toFixed(0)}%`,
  );
}

if (snaps.length > 1) {
  console.log("\n── history (one row per TW day) ──");
  console.log("date       | closed | realizedNT | peakRisk%Eq | worstDayR | sampleOK?");
  for (const s of snaps) {
    console.log(
      ` ${s.twDate} | ${String(s.bookClosed).padStart(6)} | ${String(s.realizedNT).padStart(10)} | ${String(s.peakRiskPctOfEquity).padStart(7)}%    | ${String(s.worstDayR).padStart(7)}   | ${s.sampleSufficientForLiveSizing ? "yes" : "no"}`,
    );
  }
}

console.log(`
── HONEST READ ──
• More heat = more in-sample profit, but peakRisk% and drawdown rise with it. The uncapped curve
  "wins" only because the sampled days had no fatal sequence (survivorship). Survival line for LIVE:
  keep peakRisk% at/under ~100% of equity (above it, a correlated stop = liquidation, no recovery).
• Ruin cliff (worst observed day = total wipeout) at per-trade risk ~${latest.ruinCliffPerTradePct ?? "n/a"}%.
• sampleOK = ${latest.sampleSufficientForLiveSizing ? "YES" : "NO"} (needs >=30 days incl. a real down-regime, worstDayR<=-40).` +
  `${latest.sampleSufficientForLiveSizing ? "" : " Until YES, this sample CANNOT size live trading — keep accumulating days and re-run."}\n`);

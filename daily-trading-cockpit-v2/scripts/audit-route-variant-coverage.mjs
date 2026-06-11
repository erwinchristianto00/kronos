#!/usr/bin/env node
// Read-only audit: trace route variant lifecycle (generation -> persistence ->
// fill -> close -> strategy experience record) using shadow-positions.json and
// scan-history.jsonl. No mutation, no writes other than stdout.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const positionsPath = resolve(repoRoot, "data/shadow-positions.json");
const scanHistoryPath = resolve(repoRoot, "data/scan-history.jsonl");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function tryLoadJsonl(path, max = 100000) {
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-max)) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

const positions = loadJson(positionsPath);
const scanHistory = tryLoadJsonl(scanHistoryPath, 200000);

console.log(`positions.json: ${positions.length} positions`);
console.log(`scan-history.jsonl: ${scanHistory.length} records (most recent ${scanHistory.length} loaded)`);

// ---------------- Position-level inventory ----------------
const byCombo = new Map();
const entryDist = new Map();
const exitDist = new Map();
const stateDist = new Map();
const variantArrayLen = new Map();
const closedCloseReasons = new Map();
const eras = new Map();
let positionsWithMultiVariant = 0;
let positionsWithMismatchedVariant = 0;

for (const p of positions) {
  const e = p.selectedEntryVariant ?? "(none)";
  const x = p.selectedExitVariant ?? "(none)";
  const key = `${e} + ${x}`;
  entryDist.set(e, (entryDist.get(e) ?? 0) + 1);
  exitDist.set(x, (exitDist.get(x) ?? 0) + 1);
  const era = p.variantSelection?.evidenceEra ?? "UNKNOWN";
  eras.set(era, (eras.get(era) ?? 0) + 1);

  const variants = Array.isArray(p.variants) ? p.variants : [];
  if (variants.length > 1) positionsWithMultiVariant += 1;
  variantArrayLen.set(variants.length, (variantArrayLen.get(variants.length) ?? 0) + 1);

  // mismatch: selectedExitVariant not present in p.variants[]
  if (variants.length > 0 && !variants.some((v) => v.variant === x)) {
    positionsWithMismatchedVariant += 1;
  }

  // determine lifecycle state per variant
  const filled = (p.entryState ?? "FILLED") === "FILLED";
  const pendingEntry = (p.entryState ?? "FILLED") === "PENDING_ENTRY";
  const hasClosed = variants.some((v) => v.state === "CLOSED");
  const hasOpen = variants.some((v) => v.state !== "CLOSED");

  let state;
  if (pendingEntry) state = "pending-entry";
  else if (variants.length === 0) state = "filled-no-variants"; // shouldn't happen
  else if (hasClosed && !hasOpen) state = "closed";
  else if (hasOpen) state = "filled-open";
  else state = "other";
  stateDist.set(state, (stateDist.get(state) ?? 0) + 1);

  if (!byCombo.has(key))
    byCombo.set(key, {
      total: 0,
      pendingEntry: 0,
      filledOpen: 0,
      closed: 0,
      noFill: 0,
      filledNoVariants: 0,
    });
  const bucket = byCombo.get(key);
  bucket.total += 1;
  if (state === "pending-entry") bucket.pendingEntry += 1;
  else if (state === "filled-open") bucket.filledOpen += 1;
  else if (state === "closed") bucket.closed += 1;
  else if (state === "filled-no-variants") bucket.filledNoVariants += 1;

  for (const v of variants) {
    if (v.state === "CLOSED") {
      const r = v.closeReason ?? "(none)";
      closedCloseReasons.set(r, (closedCloseReasons.get(r) ?? 0) + 1);
      if (r === "NO_FILL") bucket.noFill += 1;
    }
  }
}

console.log("\n--- selectedEntryVariant distribution ---");
for (const [k, v] of [...entryDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log("\n--- selectedExitVariant distribution ---");
for (const [k, v] of [...exitDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log("\n--- evidenceEra distribution ---");
for (const [k, v] of [...eras.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v}`);
console.log("\n--- position.variants[] array length distribution ---");
for (const [k, v] of [...variantArrayLen.entries()].sort((a, b) => a[0] - b[0])) console.log(`  variants.length=${k}  ${v} positions`);
console.log(`positions with >1 variant in array: ${positionsWithMultiVariant}`);
console.log(`positions where selectedExitVariant missing from variants[]: ${positionsWithMismatchedVariant}`);

console.log("\n--- per-combo lifecycle funnel (positions) ---");
console.log("combo | total | pending-entry | filled-open | closed | no-fill (closeReason)");
for (const [k, v] of [...byCombo.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${k.padEnd(48)} total=${v.total}  pendingEntry=${v.pendingEntry}  filledOpen=${v.filledOpen}  closed=${v.closed}  noFill=${v.noFill}`);
}

console.log("\n--- close-reason distribution (across all closed variants in all positions) ---");
for (const [k, v] of [...closedCloseReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

// ---------------- Scan-history (what was *generated*, before persistence) ----------------
// Scan candidates carry selectedExecutionPlan{ selectedEntryVariant, selectedExitVariant }.
const scanEntryDist = new Map();
const scanExitDist = new Map();
const scanComboDist = new Map();
let scanCandidatesTotal = 0;
for (const rec of scanHistory) {
  const candidates = Array.isArray(rec?.candidates) ? rec.candidates : Array.isArray(rec?.records) ? rec.records : [];
  for (const c of candidates) {
    const plan = c?.selectedExecutionPlan ?? c?.variantSelection ?? null;
    if (!plan) continue;
    scanCandidatesTotal += 1;
    const e = plan.selectedEntryVariant ?? "(none)";
    const x = plan.selectedExitVariant ?? "(none)";
    scanEntryDist.set(e, (scanEntryDist.get(e) ?? 0) + 1);
    scanExitDist.set(x, (scanExitDist.get(x) ?? 0) + 1);
    const key = `${e} + ${x}`;
    scanComboDist.set(key, (scanComboDist.get(key) ?? 0) + 1);
  }
}

console.log(`\n--- scan-history candidate selection (${scanCandidatesTotal} candidate plans across ${scanHistory.length} scan records) ---`);
if (scanCandidatesTotal > 0) {
  console.log("entry variants picked by scoring:");
  for (const [k, v] of [...scanEntryDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log("exit variants picked by scoring:");
  for (const [k, v] of [...scanExitDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log("top 20 combos picked:");
  for (const [k, v] of [...scanComboDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${k.padEnd(48)} ${v}`);
}

// ---------------- StrategyExperienceRecord-equivalent (closed primary variant) ----------------
const expRecordCombos = new Map();
let closedPositionsTotal = 0;
let primaryClosedMatchesSelected = 0;
let primaryClosedDiffersFromSelected = 0;
for (const p of positions) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const sel = p.selectedExitVariant;
  // mirror primaryClosedVariant() in strategy-intelligence.ts
  const primary = variants.find((v) => v.variant === sel && v.state === "CLOSED")
    ?? variants.find((v) => v.state === "CLOSED")
    ?? null;
  if (!primary) continue;
  closedPositionsTotal += 1;
  if (primary.variant === sel) primaryClosedMatchesSelected += 1;
  else primaryClosedDiffersFromSelected += 1;
  const key = `${p.selectedEntryVariant} + ${primary.variant}`;
  expRecordCombos.set(key, (expRecordCombos.get(key) ?? 0) + 1);
}
console.log(`\n--- StrategyExperienceRecord-equivalent (primaryClosedVariant ingest) ---`);
console.log(`closed positions producing a record: ${closedPositionsTotal}`);
console.log(`primary closed variant equals selectedExitVariant: ${primaryClosedMatchesSelected}`);
console.log(`primary closed variant differs from selectedExitVariant: ${primaryClosedDiffersFromSelected}`);
console.log("combo distribution (entry + primaryClosedVariant exit):");
for (const [k, v] of [...expRecordCombos.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(48)} ${v}`);

// ---------------- Sanity: examine first/last position with variants > 1 if any ----------------
const multiVariantSamples = positions.filter((p) => Array.isArray(p.variants) && p.variants.length > 1).slice(0, 3);
if (multiVariantSamples.length > 0) {
  console.log("\n--- sample positions with multi-variant arrays ---");
  for (const p of multiVariantSamples) {
    console.log(`  id=${p.id} sym=${p.symbol} selected=${p.selectedEntryVariant}+${p.selectedExitVariant}  variants=${p.variants.map((v) => `${v.variant}:${v.state}`).join(", ")}`);
  }
} else {
  console.log("\nNo position contains more than one ShadowVariantPosition in its variants[] array.");
}

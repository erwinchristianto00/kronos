/**
 * Free Level-1 execution calibration runner (Track B, offline, READ-ONLY). Reads copied live-execution intent
 * ledgers (real observed fills), extracts a strict calibration dataset, fits a calibrated L1, and compares
 * L0 / uncalibrated-L1 / calibrated-L1 / OBSERVED. MAINNET (live) and TESTNET fills are kept SEPARATE (different
 * liquidity). Actual fills calibrate EXECUTION ONLY — never directional alpha. No live touch, no beta, no orders.
 *
 *   Usage: npx tsx scripts/replay-calibration-run.ts <fillsDir> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stableHash, type ReplayProvenance } from "../src/lib/replay-provenance.js";
import { extractCalibrationRow, summarizeCalibration, fitL1Calibration, compareCostModels, calibrationBreakdowns, type RawExecutionIntent, type CalibrationRow, type Venue } from "../src/lib/replay-execution-calibration.js";
import { EXEC_LEVELS } from "../src/lib/replay-tier-a-core.js";

const REFERENCE_NOW = Date.parse("2026-07-13T21:00:00Z"); // fixed "now" for deterministic calibration age
const L1 = EXEC_LEVELS.L1_base; // the frozen "uncalibrated" L1 assumption used in the candle proof

const SOURCES: Array<{ file: string; venue: Venue; instance: string }> = [
  { file: "live-execution-3103.json", venue: "MAINNET", instance: "3103-live" },
  { file: "live-execution-3103-backup-0628.json", venue: "MAINNET", instance: "3103-live-backup-0628" },
  { file: "live-execution-local-churn-0612.json", venue: "MAINNET", instance: "3103-local-churn-0612" },
  { file: "live-execution-3102.json", venue: "TESTNET", instance: "3102-testnet" },
];

function loadIntents(path: string): RawExecutionIntent[] {
  if (!existsSync(path)) return [];
  const d = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(d?.intents) ? d.intents : Array.isArray(d) ? d : [];
}

function main(): void {
  const fillsDir = process.argv[2]!;
  const outDir = process.argv[3] ?? "artifacts/replay/tier-a-proof/calibration";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const prov: ReplayProvenance = {
    replayRunId: "calib-2026-07-13", codeCommitHash: "uncommitted-worktree", codeBuildHash: "n/a", containerImageDigest: null,
    configHash: stableHash(L1), featureSchemaVersion: "exec-calib-1", modelSchemaVersion: "n/a", laneRosterVersion: "n/a",
    marketDataSource: "live-execution-intent-ledger", marketDataVersion: "2026-07-13", marketDataManifestHash: "n/a",
    replayMode: "OBSERVED_LIVE_SHADOW", startedAtMs: REFERENCE_NOW, completedAtMs: REFERENCE_NOW,
  };

  const rowsByInstance: Record<string, CalibrationRow[]> = {};
  const allRows: CalibrationRow[] = [];
  const inventory: Array<{ instance: string; venue: Venue; rawIntents: number; extracted: number; usable: number }> = [];
  for (const s of SOURCES) {
    const intents = loadIntents(join(fillsDir, s.file));
    const rows = intents.map((it) => extractCalibrationRow(it, { provenance: prov, evidenceClass: "ACTUAL_LIVE_EXECUTION", venue: s.venue, sourceInstance: s.instance, l1: L1 }));
    rowsByInstance[s.instance] = rows;
    allRows.push(...rows);
    inventory.push({ instance: s.instance, venue: s.venue, rawIntents: intents.length, extracted: rows.length, usable: rows.filter((r) => r.usable).length });
  }

  const mainnet = allRows.filter((r) => r.venue === "MAINNET");
  const testnet = allRows.filter((r) => r.venue === "TESTNET");
  const mainnetFit = fitL1Calibration(mainnet, L1, REFERENCE_NOW);
  const testnetFit = fitL1Calibration(testnet, L1, REFERENCE_NOW);

  const report = {
    inventory,
    provenanceNote: "All rows ACTUAL_LIVE_EXECUTION → evidenceAllowedFor(EXECUTION_CALIBRATION) only; NEVER directional-alpha or CORTEX labels. MAINNET and TESTNET kept separate (different liquidity/microstructure).",
    mainnet: {
      summary: summarizeCalibration(mainnet),
      l1Calibration: mainnetFit,
      costModelComparison: compareCostModels(mainnet, L1, mainnetFit.calibrated),
      breakdowns: calibrationBreakdowns(mainnet),
    },
    testnet: {
      summary: summarizeCalibration(testnet),
      l1Calibration: testnetFit,
      costModelComparison: compareCostModels(testnet, L1, testnetFit.calibrated),
      breakdowns: calibrationBreakdowns(testnet),
      note: "TESTNET venue — real Binance testnet matching, but liquidity ≠ mainnet; use for method validation, not mainnet cost.",
    },
    limitations: [
      "submit→ack LATENCY not recoverable (ledger has no ack timestamp) — reported null, not fabricated.",
      "PARTIAL-fill fraction not recoverable (ledger stores netted final qty).",
      "QUEUE position + MARKET IMPACT not modeled — require Tier-C L2 order book.",
      "Calibration is at INTENT/order granularity (entry fill), not per-exchange-trade.",
    ],
  };
  const rerunHash = stableHash({ inventory, mainnetMeanAdv: report.mainnet.l1Calibration.observedMeanAdverseBps, testnetMeanAdv: report.testnet.l1Calibration.observedMeanAdverseBps });

  const write = (n: string, o: unknown) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
  write("calibration-report.json", report);
  write("calibration-determinism.json", { rerunHash });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    inventory,
    mainnet: { usable: mainnet.filter((r) => r.usable).length, observedMeanAdverseBps: mainnetFit.observedMeanAdverseBps, observedMedianAdverseBps: mainnetFit.observedMedianAdverseBps, confidence: mainnetFit.confidence, costModel: report.mainnet.costModelComparison, residualR: report.mainnet.summary.predictedVsActualResidualR },
    testnet: { usable: testnet.filter((r) => r.usable).length, observedMeanAdverseBps: testnetFit.observedMeanAdverseBps, confidence: testnetFit.confidence },
    rerunHash: rerunHash.slice(0, 16),
  }, null, 1));
}
main();

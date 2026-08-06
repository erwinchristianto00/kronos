import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { registryEntry, tournamentHash } from "../contract/tournament-contract.js";
import type { RankedTournamentCandidate } from "./governance.js";
import type { TournamentRunRegistryEntry, TournamentRunResult } from "../tournament-types.js";

function stableJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, stableJson(value), "utf8");
  renameSync(temporary, path);
}

/**
 * Research-only artifact writer. The registry is append-only by runId; conflicting
 * content for an existing ID is an integrity error, never silently overwritten.
 */
export function persistTournamentRun(rootDir: string, result: TournamentRunResult): { runDirectory: string; registryHash: string } {
  const root = resolve(rootDir); const runDirectory = resolve(root, "runs", result.manifest.runId);
  mkdirSync(runDirectory, { recursive: true });
  atomicWrite(resolve(runDirectory, "manifest.json"), result.manifest);
  atomicWrite(resolve(runDirectory, "trade-ledger.json"), result.trades);
  atomicWrite(resolve(runDirectory, "result.json"), { strategyMetrics: result.strategyMetrics, portfolioMetrics: result.portfolioMetrics, warnings: result.warnings, valid: result.valid, invalidReasons: result.invalidReasons });
  const registryPath = resolve(root, "run-registry.json");
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) as TournamentRunRegistryEntry[] : [];
  if (!Array.isArray(registry)) throw new Error("TOURNAMENT_REGISTRY_CORRUPT");
  const next = registryEntry(result.manifest, result.valid);
  const existing = registry.find((entry) => entry.runId === next.runId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(next)) throw new Error("TOURNAMENT_REGISTRY_RUN_ID_CONFLICT");
  if (!existing) atomicWrite(registryPath, [...registry, next]);
  const finalRegistry = existing ? registry : [...registry, next];
  return { runDirectory, registryHash: tournamentHash(finalRegistry) };
}

export function renderTournamentComparisonReport(input: { title: string; datasetHash: string; rankings: readonly RankedTournamentCandidate[] }): string {
  const lines = [`# ${input.title}`, "", `Dataset hash: \`${input.datasetHash}\``, "", "| Strategy | Gate | Rank | Expectancy | PF | Max DD | Evidence |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const candidate of input.rankings) {
    const metric = candidate.metrics;
    lines.push(`| ${candidate.strategyId} | ${candidate.hardGate.passes ? "PASS" : `FAIL: ${candidate.hardGate.failures.join(", ")}`} | ${candidate.rankScore?.toFixed(3) ?? "n/a"} | ${metric.expectancyAfterCost.toFixed(4)} | ${metric.profitFactor?.toFixed(3) ?? "n/a"} | ${(metric.maxDrawdown * 100).toFixed(2)}% | ${metric.independentEpisodes} |`);
  }
  lines.push("", "Only hard-gate survivors receive a percentile rank. OPTIMISTIC-only results are diagnostic and cannot pass governance.");
  return `${lines.join("\n")}\n`;
}

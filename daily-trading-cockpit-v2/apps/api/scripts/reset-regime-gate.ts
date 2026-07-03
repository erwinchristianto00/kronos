import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type StoreShape = {
  observations?: unknown[];
  resolverMeta?: unknown;
};

function safeStamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf-8");
  renameSync(tmp, file);
}

function observationCount(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as StoreShape | unknown[];
    if (Array.isArray(parsed)) return parsed.length;
    return Array.isArray(parsed?.observations) ? parsed.observations.length : 0;
  } catch {
    return 0;
  }
}

function resetStore(file: string, now: string): { file: string; previousObservations: number; backupPath: string | null } {
  mkdirSync(dirname(file), { recursive: true });
  const previousObservations = observationCount(file);
  let backupPath: string | null = null;

  if (existsSync(file)) {
    const backupDir = resolve(dirname(file), "gate-reset-backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = resolve(backupDir, `current-guard-variant-matrix.${safeStamp(now)}.json`);
    copyFileSync(file, backupPath);
  }

  writeJsonAtomic(file, {
    observations: [],
    resolverMeta: {
      lastRunAt: now,
      resolvedCount: 0,
      expiredCount: 0,
      dataFailureCount: 0,
      errorCount: 0,
      walkCursor: 0,
    },
    resetMeta: {
      resetAt: now,
      reason: "REGIME_GATE_V2_CAPTURED_EXTENDED_CONTEXT_RESET",
      previousObservations,
      backupPath,
    },
  });

  return { file, previousObservations, backupPath };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const now = new Date().toISOString();

const targets = [
  resolve(repoRoot, "data/current-guard-variant-matrix.json"),
  resolve(apiRoot, "data/current-guard-variant-matrix.json"),
];

const results = targets.map((target) => resetStore(target, now));

for (const result of results) {
  console.log(
    [
      `reset=${result.file}`,
      `previousObservations=${result.previousObservations}`,
      `backup=${result.backupPath ?? "NONE"}`,
    ].join(" "),
  );
}

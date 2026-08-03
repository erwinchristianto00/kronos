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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resetStore(
  file: string,
  now: string,
  dryRun: boolean,
): { file: string; previousObservations: number; backupPath: string | null } {
  mkdirSync(dirname(file), { recursive: true });
  const previousObservations = observationCount(file);
  let backupPath: string | null = null;

  if (dryRun) {
    return { file, previousObservations, backupPath: null };
  }

  if (existsSync(file)) {
    const backupDir = resolve(dirname(file), "gate-reset-backups");
    mkdirSync(backupDir, { recursive: true });
    backupPath = resolve(backupDir, `current-guard-variant-matrix.${safeStamp(now)}.json`);
    copyFileSync(file, backupPath);
  }

  writeJsonAtomic(file, {
    observations: [],
    // Written EXPLICITLY, not merely omitted, so this reset's blast radius is visible in the diff:
    // it also destroys every frozen stage proof window (the immutable STABLE/PROMOTION
    // development/holdout boundaries in current-guard-variant-matrix.ts). Those windows take weeks
    // of episode accumulation to re-earn. The backup above is the only copy afterwards.
    stageCuts: {},
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

// Destructive by nature (wipes both variant-matrix stores to empty) — defaults to a
// dry-run preview, matching repair-axis-history.ts's safer --apply convention, so a
// mistaken/muscle-memory invocation can't instantly zero live data with no preview.
const apply = hasFlag("--apply");

const targets = [
  resolve(repoRoot, "data/current-guard-variant-matrix.json"),
  resolve(apiRoot, "data/current-guard-variant-matrix.json"),
];

const results = targets.map((target) => resetStore(target, now, !apply));

console.log(`mode=${apply ? "APPLY" : "DRY_RUN"}${apply ? "" : " (pass --apply to actually reset)"}`);
for (const result of results) {
  console.log(
    [
      `${apply ? "reset" : "would-reset"}=${result.file}`,
      `previousObservations=${result.previousObservations}`,
      `backup=${result.backupPath ?? (apply ? "NONE" : "N/A (dry-run)")}`,
    ].join(" "),
  );
}

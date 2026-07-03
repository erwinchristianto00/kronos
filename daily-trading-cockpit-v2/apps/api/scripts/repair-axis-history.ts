import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Direction = "LONG" | "SHORT";
type AxisRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

type AxisFields = {
  axisVersion?: 1;
  axisDirection?: Direction;
  axisRegimeFamily?: AxisRegimeFamily;
  axisKey?: string;
};

type PaperOrderLike = AxisFields & {
  direction?: unknown;
  regime?: unknown;
  paperOrderId?: unknown;
};

type PaperStoreLike = {
  orders?: PaperOrderLike[];
};

type VariantObservationLike = AxisFields & {
  direction?: unknown;
  regime?: unknown;
  observationId?: unknown;
  posture?: unknown;
  regimeDirection?: unknown;
};

type VariantMatrixStoreLike = {
  observations?: VariantObservationLike[];
  resolverMeta?: unknown;
};

type RepairCounters = {
  file: string;
  total: number;
  changed: number;
  alreadyOk: number;
  skipped: number;
  missingCapturedContext?: number;
  inferredCapturedContext?: number;
  byAxis: Record<string, number>;
  backupPath: string | null;
};

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function safeStamp(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, file);
}

function backupFile(file: string, now: string): string | null {
  if (!existsSync(file)) return null;
  const backupDir = resolve(dirname(file), "axis-repair-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `${file.split("/").pop()}.${safeStamp(now)}.bak`);
  copyFileSync(file, backupPath);
  return backupPath;
}

function normalizeDirection(value: unknown): Direction | null {
  return value === "LONG" || value === "SHORT" ? value : null;
}

function regimeFamily(regime: unknown): AxisRegimeFamily {
  const label = String(regime ?? "").toLowerCase();
  if (/mixed|rotation|chop|range|sideways|neutral/.test(label)) return "MIXED";
  if (/bull|long/.test(label)) return "BULLISH";
  if (/bear|short/.test(label)) return "BEARISH";
  return "UNKNOWN";
}

function regimeDirectionFromFamily(family: AxisRegimeFamily): Direction | "MIXED" | null {
  if (family === "BULLISH") return "LONG";
  if (family === "BEARISH") return "SHORT";
  if (family === "MIXED") return "MIXED";
  return null;
}

function axisKey(direction: Direction, family: AxisRegimeFamily): string {
  return `${direction}::${family}`;
}

function applyAxisFields(row: PaperOrderLike | VariantObservationLike): { changed: boolean; key: string | null } {
  const direction = normalizeDirection(row.direction);
  if (!direction) return { changed: false, key: null };
  const family = regimeFamily(row.regime);
  const key = axisKey(direction, family);
  const changed =
    row.axisVersion !== 1 ||
    row.axisDirection !== direction ||
    row.axisRegimeFamily !== family ||
    row.axisKey !== key;
  if (changed) {
    row.axisVersion = 1;
    row.axisDirection = direction;
    row.axisRegimeFamily = family;
    row.axisKey = key;
  }
  return { changed, key };
}

function repairPaperStore(file: string, now: string, apply: boolean): RepairCounters {
  const store = readJson<PaperStoreLike>(file);
  const orders = Array.isArray(store.orders) ? store.orders : [];
  const counters: RepairCounters = {
    file,
    total: orders.length,
    changed: 0,
    alreadyOk: 0,
    skipped: 0,
    byAxis: {},
    backupPath: null,
  };
  for (const order of orders) {
    const { changed, key } = applyAxisFields(order);
    if (!key) {
      counters.skipped += 1;
      continue;
    }
    counters.byAxis[key] = (counters.byAxis[key] ?? 0) + 1;
    if (changed) counters.changed += 1;
    else counters.alreadyOk += 1;
  }
  if (apply && counters.changed > 0) {
    counters.backupPath = backupFile(file, now);
    writeJsonAtomic(file, store);
  }
  return counters;
}

function repairVariantMatrix(file: string, now: string, apply: boolean, fillCapturedContext: boolean): RepairCounters {
  const store = readJson<VariantMatrixStoreLike>(file);
  const observations = Array.isArray(store.observations) ? store.observations : [];
  const counters: RepairCounters = {
    file,
    total: observations.length,
    changed: 0,
    alreadyOk: 0,
    skipped: 0,
    missingCapturedContext: 0,
    inferredCapturedContext: 0,
    byAxis: {},
    backupPath: null,
  };
  for (const observation of observations) {
    const before = JSON.stringify({
      axisVersion: observation.axisVersion,
      axisDirection: observation.axisDirection,
      axisRegimeFamily: observation.axisRegimeFamily,
      axisKey: observation.axisKey,
      posture: observation.posture,
      regimeDirection: observation.regimeDirection,
    });
    const { key } = applyAxisFields(observation);
    if (!key) {
      counters.skipped += 1;
      continue;
    }
    counters.byAxis[key] = (counters.byAxis[key] ?? 0) + 1;

    const capturedMissing = observation.posture !== "TACTICAL" && observation.posture !== "EXTENDED";
    const dirMissing = observation.regimeDirection !== "LONG" && observation.regimeDirection !== "SHORT" && observation.regimeDirection !== "MIXED";
    if (capturedMissing || dirMissing) counters.missingCapturedContext = (counters.missingCapturedContext ?? 0) + 1;

    if (fillCapturedContext && (capturedMissing || dirMissing)) {
      const family = observation.axisRegimeFamily ?? regimeFamily(observation.regime);
      const inferredDirection = regimeDirectionFromFamily(family);
      observation.regimeDirection = inferredDirection ?? "MIXED";
      observation.posture = family === "MIXED" || family === "UNKNOWN" ? "TACTICAL" : "EXTENDED";
      counters.inferredCapturedContext = (counters.inferredCapturedContext ?? 0) + 1;
    }

    const after = JSON.stringify({
      axisVersion: observation.axisVersion,
      axisDirection: observation.axisDirection,
      axisRegimeFamily: observation.axisRegimeFamily,
      axisKey: observation.axisKey,
      posture: observation.posture,
      regimeDirection: observation.regimeDirection,
    });
    if (before !== after) counters.changed += 1;
    else counters.alreadyOk += 1;
  }
  if (apply && counters.changed > 0) {
    counters.backupPath = backupFile(file, now);
    writeJsonAtomic(file, store);
  }
  return counters;
}

function main(): void {
  const apply = hasFlag("--apply");
  const fillCapturedContext = hasFlag("--fill-captured-context");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(argValue("--data-dir") ?? resolve(scriptDir, "../data"));
  const now = new Date().toISOString();
  const paperFile = resolve(dataDir, "paper-execution-router.json");
  const vmFile = resolve(dataDir, "current-guard-variant-matrix.json");

  const results: RepairCounters[] = [];
  if (existsSync(paperFile)) results.push(repairPaperStore(paperFile, now, apply));
  if (existsSync(vmFile)) results.push(repairVariantMatrix(vmFile, now, apply, fillCapturedContext));

  const report = {
    repair: "axis-history-v1",
    mode: apply ? "APPLY" : "DRY_RUN",
    appliedAt: apply ? now : null,
    dryRunAt: apply ? null : now,
    fillCapturedContext,
    note: "Repairs reporting axes only. It does not alter entry/exit/PnL/closeReason/trade outcome fields.",
    results,
  };

  if (apply) {
    const reportPath = resolve(dataDir, "axis-repair-report.json");
    writeJsonAtomic(reportPath, report);
    console.log(`report=${reportPath}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main();

import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const CONFIRMATION = "RESET_INTERNAL_STATE";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/reset-internal-state.ts --data-dir=/absolute/path --confirm=RESET_INTERNAL_STATE --offline",
  );
}

function summarize(path: string): { files: number; directories: number; bytes: number } {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const visit = (entry: string) => {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) {
      directories += 1;
      for (const child of readdirSync(entry)) visit(resolve(entry, child));
      return;
    }
    files += 1;
    bytes += stat.size;
  };
  if (lstatSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) visit(resolve(path, entry));
  }
  return { files, directories, bytes };
}

const requestedDataDir = arg("data-dir");
if (!requestedDataDir || arg("confirm") !== CONFIRMATION || !process.argv.includes("--offline")) usage();
if (!isAbsolute(requestedDataDir)) throw new Error("--data-dir must be absolute");

const dataDir = resolve(requestedDataDir);
const parentDir = dirname(dataDir);
const rel = relative(parentDir, dataDir);
if (!rel || rel.startsWith("..") || basename(dataDir) !== "data") {
  throw new Error(`Refusing unsafe data directory: ${dataDir}`);
}

mkdirSync(dataDir, { recursive: true });
const dataDirStat = lstatSync(dataDir);
if (!dataDirStat.isDirectory() || dataDirStat.isSymbolicLink()) {
  throw new Error(`Refusing non-directory or symlink data path: ${dataDir}`);
}
const before = summarize(dataDir);
const resetAt = new Date().toISOString();
const resetId = `reset-${resetAt.replace(/[:.]/g, "-")}`;
const manifest = {
  resetId,
  resetAt,
  dataDir,
  scope: "internal runtime state only; no Binance order, position, balance, or exchange history was modified",
  previousContents: before,
};

// The manifest deliberately lives outside data: data is fully emptied, while the operator has
// an immutable audit receipt describing exactly what was removed.
const manifestPath = resolve(parentDir, `${resetId}-manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
for (const entry of readdirSync(dataDir)) rmSync(resolve(dataDir, entry), { recursive: true, force: true });

console.log(JSON.stringify({ ...manifest, manifestPath, after: summarize(dataDir) }, null, 2));

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const CONFIRMATION = "RESET_INTERNAL_STATE";
const MAINNET_CONFIRMATION = "I_UNDERSTAND_THIS_IS_REAL_MONEY";

/**
 * Entries under data/ this script must NEVER delete, and why.
 *
 * 2026-07-28 incident: the loop below used to delete EVERY top-level entry with no exclusion list at
 * all. That includes `live-execution.json` — the LiveExecutionEngine's durable ledger of the
 * kill-switch latch (`killedAt`), the drain pause (`newEntriesPaused`), the operator lane locks, and
 * the currently OPEN live intents. Deleting it is functionally an unguarded `resetKill()` plus an
 * un-pause: `LiveExecutionStore._load()` falls back to `_empty()`, which sets `killedAt: null` and
 * `newEntriesPaused: false`, and the engine constructor then auto-arms on any instance whose config
 * allows it (`if (this.config.autoArm && !this.store.getState().killedAt) this.armed = true`).
 * That is exactly what happened: testnet auto-armed after a reset and opened a fresh position which
 * had to be manually disarmed and flattened. The `.bak` sibling is preserved too — it lived in the
 * same wiped directory, so the store's `_parse(file) ?? _parse(file.bak) ?? _empty()` fallback chain
 * offered no protection whatsoever.
 *
 * The other two are not safety latches but are irreplaceable REAL-MONEY history: `position-paths.json`
 * is the only path from a live intent back to its lane (live intents carry no laneId), and
 * `execution-fills.json` holds actual fill/commission records. Deleting either also makes this
 * script's own manifest scope line ("no Binance order, position, balance, or exchange history was
 * modified") a false statement rather than a true one.
 */
const PRESERVED_ENTRIES: ReadonlySet<string> = new Set([
  "live-execution.json",
  "live-execution.json.bak",
  "position-paths.json",
  "position-paths.json.bak",
  "execution-fills.json",
  "execution-fills.json.bak",
]);

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/reset-internal-state.ts --data-dir=/absolute/path --confirm=RESET_INTERNAL_STATE --offline\n" +
      `       (a mainnet instance additionally requires --confirm-mainnet=${MAINNET_CONFIRMATION})`,
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

/**
 * Whether the instance owning this data dir trades REAL money, read from its own `.env`
 * (`<repo>/.env`, three levels above `<repo>/apps/api/data`). Never prints or returns any env VALUE —
 * only this one boolean.
 *
 * This is the guard for the second half of the same incident: the only scoping check used to be
 * `basename(dataDir) === "data"`, and research/testnet/live all keep a directory with that exact
 * basename. One wrong `--data-dir` therefore silently retargeted the wipe at a different instance,
 * with nothing to distinguish the real-money one. Identifying mainnet from the instance's own config
 * is portable in a way that hardcoding deployment paths would not be.
 */
function instanceIsMainnet(dataDir: string): { mainnet: boolean; envPath: string; envFound: boolean } {
  const envPath = resolve(dataDir, "..", "..", "..", ".env");
  if (!existsSync(envPath)) return { mainnet: false, envPath, envFound: false };
  let mainnet = false;
  try {
    for (const rawLine of readFileSync(envPath, "utf-8").split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("#")) continue;
      const [key, ...rest] = line.split("=");
      if (key?.trim() !== "LIVE_BINANCE_ENV") continue;
      if (rest.join("=").trim().replace(/^["']|["']$/g, "") === "mainnet") mainnet = true;
    }
  } catch {
    // Unreadable .env => cannot prove it is NOT mainnet. Fall through to the caller's own
    // treat-as-unknown handling rather than silently reporting "safe".
    return { mainnet: false, envPath, envFound: false };
  }
  return { mainnet, envPath, envFound: true };
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

// A mainnet instance needs a second, differently-worded confirmation naming the risk. The generic
// --confirm token is identical for every instance, so on its own it cannot express "yes, I mean the
// real-money one". An unreadable/absent .env is treated as UNKNOWN, not as safe.
const { mainnet, envPath, envFound } = instanceIsMainnet(dataDir);
if (!envFound) {
  throw new Error(
    `Refusing to reset: cannot read ${envPath} to determine whether this instance trades real money. ` +
      `Point --data-dir at a real instance's data directory, or confirm the instance manually first.`,
  );
}
if (mainnet && arg("confirm-mainnet") !== MAINNET_CONFIRMATION) {
  throw new Error(
    `Refusing to reset a MAINNET instance (${envPath} has LIVE_BINANCE_ENV=mainnet) without ` +
      `--confirm-mainnet=${MAINNET_CONFIRMATION}. This directory belongs to the real-money account.`,
  );
}

const before = summarize(dataDir);
const resetAt = new Date().toISOString();
const resetId = `reset-${resetAt.replace(/[:.]/g, "-")}`;

const presentEntries = readdirSync(dataDir);
const preserved = presentEntries.filter((entry) => PRESERVED_ENTRIES.has(entry)).sort();
const toRemove = presentEntries.filter((entry) => !PRESERVED_ENTRIES.has(entry));

// The manifest deliberately lives outside data: data is emptied (except the preserved entries),
// while the operator keeps an audit receipt describing exactly what was removed.
//
// It is written TWICE — "IN_PROGRESS" before the loop, "COMPLETED" after — because the deletion loop
// is not atomic. Previously the manifest was written once, up front, and contained only the
// pre-reset summary, so a run interrupted mid-loop (Ctrl-C / OOM / dropped SSH) left a
// complete-looking receipt that gave no indication some subsystems had been cleared and others had
// not. A manifest still reading IN_PROGRESS is now the signal that exactly that happened.
const manifestPath = resolve(parentDir, `${resetId}-manifest.json`);
const manifestBase = {
  resetId,
  resetAt,
  dataDir,
  // Scope is now DERIVED from the preservation policy rather than asserted as a fixed string. The
  // old hardcoded line claimed no order/position/balance/exchange history was modified while the
  // loop was in fact deleting the live execution ledger, the live lane-attribution paths, and the
  // real fill records.
  scope:
    "internal runtime/learning state only; the live execution ledger (kill-switch latch, drain " +
    "pause, lane locks, open intents), live position-path attribution, and execution fill records " +
    "are PRESERVED. No Binance order, position, balance, or exchange history is modified.",
  instanceIsMainnet: mainnet,
  preservedEntries: preserved,
  removedEntryCount: toRemove.length,
  previousContents: before,
};
writeFileSync(manifestPath, `${JSON.stringify({ ...manifestBase, status: "IN_PROGRESS" }, null, 2)}\n`);

for (const entry of toRemove) rmSync(resolve(dataDir, entry), { recursive: true, force: true });

const after = summarize(dataDir);
const finalManifest = { ...manifestBase, status: "COMPLETED", manifestPath, after };
writeFileSync(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);

console.log(JSON.stringify(finalManifest, null, 2));

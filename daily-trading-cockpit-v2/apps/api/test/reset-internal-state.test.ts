import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

/**
 * RESET-INTERNAL-STATE SAFETY (2026-07-28).
 *
 * WHY THIS FILE EXISTS. `scripts/reset-internal-state.ts` had no test at all, and on 2026-07-28 it
 * deleted every top-level entry under a target `data/` directory with no exclusion list. That set
 * includes `live-execution.json`, the LiveExecutionEngine's durable kill-switch latch / drain pause /
 * lane locks / open-intent ledger, so running it was functionally an unguarded `resetKill()` plus an
 * un-pause. Testnet auto-armed immediately afterwards and opened a position that had to be manually
 * disarmed and flattened. The manifest the script wrote simultaneously asserted that "no Binance
 * order, position, balance, or exchange history was modified".
 *
 * The script is invoked as a real subprocess here rather than imported, because its guards run at
 * module scope on `process.argv` — importing it could not exercise the argument handling that is
 * itself half the defect.
 */

const SCRIPT = resolve(__dirname, "..", "scripts", "reset-internal-state.ts");
const CONFIRM = "RESET_INTERNAL_STATE";
const MAINNET_CONFIRM = "I_UNDERSTAND_THIS_IS_REAL_MONEY";

/**
 * Builds a throwaway instance laid out exactly like a real one — `<repo>/apps/api/data` with the
 * instance's `.env` three levels above the data dir — because the mainnet guard reads that `.env`,
 * and a fixture with a flat layout would silently skip the very check under test.
 */
function makeInstance(liveEnv: "mainnet" | "testnet" | null): { dataDir: string; repoRoot: string } {
  const repoRoot = mkdtempSync(join(os.tmpdir(), "reset-instance-"));
  const dataDir = join(repoRoot, "apps", "api", "data");
  mkdirSync(dataDir, { recursive: true });
  if (liveEnv) {
    writeFileSync(join(repoRoot, ".env"), `SOME_OTHER_KEY=1\nLIVE_BINANCE_ENV=${liveEnv}\nTRAILING=x\n`);
  } else {
    writeFileSync(join(repoRoot, ".env"), "SOME_OTHER_KEY=1\n");
  }
  // A representative mix: live-money ledgers plus disposable learning state.
  writeFileSync(join(dataDir, "live-execution.json"), JSON.stringify({ killedAt: "2026-07-28T00:00:00.000Z" }));
  writeFileSync(join(dataDir, "live-execution.json.bak"), JSON.stringify({ killedAt: "2026-07-28T00:00:00.000Z" }));
  writeFileSync(join(dataDir, "position-paths.json"), JSON.stringify({ paths: ["intent:abc:2026"] }));
  writeFileSync(join(dataDir, "execution-fills.json"), JSON.stringify({ fills: [{ commission: 0.42 }] }));
  writeFileSync(join(dataDir, "cortex-brain.json"), JSON.stringify({ weights: [1, 2, 3] }));
  writeFileSync(join(dataDir, "paper-execution-router.json"), JSON.stringify({ orders: [] }));
  mkdirSync(join(dataDir, "lane-context"), { recursive: true });
  writeFileSync(join(dataDir, "lane-context", "nested.json"), "{}");
  return { dataDir, repoRoot };
}

function runReset(dataDir: string, extraArgs: string[] = []): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", SCRIPT, `--data-dir=${dataDir}`, `--confirm=${CONFIRM}`, "--offline", ...extraArgs],
      { encoding: "utf-8", cwd: resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function manifestFor(dataDir: string): Record<string, unknown> {
  const parent = resolve(dataDir, "..");
  const file = readdirSync(parent).find((f) => f.startsWith("reset-") && f.endsWith("-manifest.json"));
  expect(file, "a manifest should have been written").toBeTruthy();
  return JSON.parse(readFileSync(join(parent, file!), "utf-8"));
}

describe("reset-internal-state safety", () => {
  it("[PRESERVE] never deletes the live execution ledger, its .bak, position paths, or fill records", () => {
    const { dataDir } = makeInstance("testnet");
    const r = runReset(dataDir);
    expect(r.ok, `script should succeed; stderr: ${r.stderr}`).toBe(true);

    // The whole incident in one assertion: the kill-switch latch must survive the wipe. Deleting it
    // resets killedAt to null via LiveExecutionStore._empty() and lets the engine auto-arm.
    expect(existsSync(join(dataDir, "live-execution.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "live-execution.json"), "utf-8")).killedAt).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    // The .bak sibling lives in the SAME directory, so the store's file -> .bak -> empty fallback
    // chain gave no protection once both were deleted.
    expect(existsSync(join(dataDir, "live-execution.json.bak"))).toBe(true);
    // Irreplaceable real-money history: live intents carry no laneId, so position-paths.json is the
    // only route from a live close back to its lane.
    expect(existsSync(join(dataDir, "position-paths.json"))).toBe(true);
    expect(existsSync(join(dataDir, "execution-fills.json"))).toBe(true);

    // ...while the disposable learning state IS still cleared — otherwise the script does nothing.
    expect(existsSync(join(dataDir, "cortex-brain.json"))).toBe(false);
    expect(existsSync(join(dataDir, "paper-execution-router.json"))).toBe(false);
    expect(existsSync(join(dataDir, "lane-context"))).toBe(false);
  });

  it("[MAINNET] refuses a real-money instance unless the mainnet-specific token is supplied", () => {
    const { dataDir } = makeInstance("mainnet");
    const blocked = runReset(dataDir);
    expect(blocked.ok).toBe(false);
    expect(blocked.stderr).toMatch(/MAINNET/);
    // Nothing may be touched by a refused run.
    expect(existsSync(join(dataDir, "cortex-brain.json"))).toBe(true);
    expect(existsSync(join(dataDir, "live-execution.json"))).toBe(true);

    // The generic --confirm token is byte-identical for every instance, so on its own it can never
    // express "yes, I mean the real-money one" -- which is why a wrong --data-dir used to be silent.
    const allowed = runReset(dataDir, [`--confirm-mainnet=${MAINNET_CONFIRM}`]);
    expect(allowed.ok, `explicit mainnet confirm should proceed; stderr: ${allowed.stderr}`).toBe(true);
    expect(existsSync(join(dataDir, "cortex-brain.json"))).toBe(false);
    expect(existsSync(join(dataDir, "live-execution.json"))).toBe(true); // still preserved
    expect(manifestFor(dataDir).instanceIsMainnet).toBe(true);
  });

  it("[UNKNOWN-INSTANCE] refuses when it cannot read the instance .env to classify the target", () => {
    // An unreadable/absent .env cannot prove the target is NOT the real-money instance, so the
    // honest answer is to refuse rather than to assume "safe".
    const repoRoot = mkdtempSync(join(os.tmpdir(), "reset-orphan-"));
    const dataDir = join(repoRoot, "apps", "api", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "cortex-brain.json"), "{}");
    const r = runReset(dataDir);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/cannot read|determine whether/i);
    expect(existsSync(join(dataDir, "cortex-brain.json"))).toBe(true);
  });

  it("[MANIFEST] states the derived scope, names what it preserved, and completes", () => {
    const { dataDir } = makeInstance("testnet");
    runReset(dataDir);
    const m = manifestFor(dataDir);

    // Written twice (IN_PROGRESS -> COMPLETED) so an interrupted, non-atomic run is detectable. The
    // old manifest was written once BEFORE the loop and never updated, so a half-finished wipe left
    // a complete-looking receipt.
    expect(m.status).toBe("COMPLETED");
    expect(m.after).toBeTruthy();
    expect((m.preservedEntries as string[]).sort()).toEqual([
      "execution-fills.json",
      "live-execution.json",
      "live-execution.json.bak",
      "position-paths.json",
    ]);
    // The scope line must describe the preservation policy rather than assert a blanket claim that
    // the code contradicted.
    expect(m.scope as string).toMatch(/PRESERVED/);
    expect(m.scope as string).toMatch(/kill-switch/i);
  });
});

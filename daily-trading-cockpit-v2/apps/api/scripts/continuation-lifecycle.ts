/**
 * Dedicated scheduler for the continuation champion/challenger lifecycle.
 * It owns no order path; the runner is lock-protected and safely skips when inputs/resources are
 * not eligible. Usage: npx tsx scripts/continuation-lifecycle.ts [--root=/root/kronos-continuation] [--once]
 */
import { ContinuationLifecycleRunner } from "../src/lib/continuation-lifecycle-runner.js";
import { continuationLifecyclePaths, ensureContinuationLifecycleDirectories } from "../src/lib/continuation-lifecycle.js";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const root = option("root") ?? process.env.CONTINUATION_LIFECYCLE_ROOT;
const once = process.argv.slice(2).includes("--once");
const intervalRaw = Number(process.env.CONTINUATION_LIFECYCLE_TICK_MS ?? 15 * 60_000);
const tickMs = Number.isFinite(intervalRaw) ? Math.max(5 * 60_000, Math.min(6 * 60 * 60_000, intervalRaw)) : 15 * 60_000;
const paths = ensureContinuationLifecycleDirectories(continuationLifecyclePaths(root));
const runner = new ContinuationLifecycleRunner({ paths });
let running = false;
let stopping = false;

async function tick(reason: string): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    await runner.runOnce();
  } catch (error) {
    console.error(JSON.stringify({ event: "CONT_LIFECYCLE_TICK_FAILED", reason, error: error instanceof Error ? error.message : String(error) }));
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "CONT_LIFECYCLE_STARTED", root: paths.root, once, tickMs }));
  await tick("startup");
  if (once) return;
  const timer = setInterval(() => { void tick("scheduled"); }, tickMs);
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log(JSON.stringify({ event: "CONT_LIFECYCLE_STOPPED", signal }));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

void main().catch((error) => {
  console.error(JSON.stringify({ event: "CONT_LIFECYCLE_FATAL", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

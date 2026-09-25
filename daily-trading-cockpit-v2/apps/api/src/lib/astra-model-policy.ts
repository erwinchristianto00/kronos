/** Which decision policy the Astra lane is actually running on, right now.
 *
 * The lane declares two policies and fails over between them, so a dashboard that
 * prints one of them as a constant is wrong for the whole time the other is in use.
 * This resolves the live answer from the V8 supervisor's own state and always says
 * where the answer came from, so "we could not tell" is never rendered as a fact.
 *
 * Read-only, synchronous, mtime-cached and total: every failure path returns the
 * declared primary with a source that admits it. Nothing here may throw — these
 * fields sit on the status and report routes the runner itself polls.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AstraModelPolicy {
  model: string;
  reasoning: string;
  modelRole: string;
  /** Where the two fields above came from; never omit it from a rendered view. */
  modelSource: "SUPERVISOR_STATE" | "SUPERVISOR_STATE_STALE" | "V8_NOT_ARMED" | "DECLARED_DEFAULT";
}

/** Mirrors the FAST_TRADING rows of astra_router_v9.POLICIES. Only a last resort: the
 * supervisor's own record of the policy it froze into a job is preferred over this
 * table wherever it exists. Keyed by ROUTER state, because that is what now decides
 * which model a trading decision is given to. */
const DECLARED: Record<string, { model: string; reasoning: string; provider: string }> = {
  ASTRA_PRIMARY: { model: "gpt-6-astra", reasoning: "medium", provider: "openai-codex" },
  CLAUDE_FALLBACK: { model: "claude-opus-5", reasoning: "high", provider: "anthropic" },
};
const DECLARED_ROLE = "ASTRA_PRIMARY";
export const DECLARED_PRIMARY: AstraModelPolicy = {
  model: DECLARED[DECLARED_ROLE].model, reasoning: DECLARED[DECLARED_ROLE].reasoning,
  modelRole: DECLARED_ROLE, modelSource: "DECLARED_DEFAULT",
};

/** A supervisor that has not polled in this long is not evidence about right now. */
const STALE_MS = 300000;
/** The supervisor state is a bounded working set; anything this size is a bug elsewhere
 * and must not become a synchronous multi-megabyte parse on a dashboard GET. */
const MAX_BYTES = 8 * 1024 * 1024;

const runtimeRoot = () => process.env.ASTRA_RUNTIME_ROOT ?? "/opt/kronos-astra/runtime";

/** Everything the answer depends on except the clock, so staleness stays live while
 * the file parse is reused. Caching the rendered view instead would freeze the
 * staleness flag at whatever it was when the file last changed. */
interface Reading { armed: boolean; role: string; model: string; reasoning: string; polledAt: number }
let cache: { key: string; reading: Reading } | null = null;

function readJson(path: string): Record<string, unknown> | null {
  const stat = statSync(path);
  if (stat.size > MAX_BYTES) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The identity the supervisor itself recorded for the most recent TRADING job,
 * preferred over the static table so a policy change in Python cannot silently drift
 * from what is shown. Coaching jobs are excluded: this field describes who decides
 * trades, and coaching runs on its own model regardless of the router. */
function recordedIdentity(state: Record<string, unknown>, provider: string) {
  const jobs = Object.values((state.jobs ?? {}) as Record<string, { at?: number; mode?: string; modelPolicy?: Record<string, unknown> }>);
  // Restricted to the provider the router is currently on. The newest trading job may
  // be the PRIMARY attempt that just failed over, and naming that model beside a
  // CLAUDE_FALLBACK role would render a state the lane was never in.
  const own = jobs
    .filter(j => j?.modelPolicy && j.modelPolicy.task === "FAST_TRADING"
                 && j.modelPolicy.provider === provider && typeof j.modelPolicy.model === "string")
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  if (own?.modelPolicy) {
    return { model: String(own.modelPolicy.model), reasoning: String(own.modelPolicy.effort ?? "") };
  }
  return null;
}

function read(root: string): Reading {
  const manifest = readJson(join(root, "v8-manifest.json"));
  if (!manifest || manifest.armed !== true) {
    // Nothing failed over, because V8 orchestration is not the thing running this lane.
    return { armed: false, role: DECLARED_ROLE, ...DECLARED[DECLARED_ROLE], polledAt: 0 };
  }
  const state = readJson(join(root, "hermes-home/v8/supervisor.json"));
  const router = (state?.router ?? {}) as { routerState?: unknown };
  const role = typeof router.routerState === "string" && router.routerState in DECLARED
    ? router.routerState : DECLARED_ROLE;
  const identity = (state && recordedIdentity(state, DECLARED[role].provider)) || DECLARED[role];
  return { armed: true, role, model: identity.model,
    reasoning: identity.reasoning || DECLARED[role].reasoning,
    polledAt: typeof state?.lastPollAt === "number" ? state.lastPollAt : 0 };
}

/** Never throws: a missing, unreadable or malformed state file is reported as the
 * declared default rather than failing the routes that carry it — including the
 * `/status` route the runner itself polls before every job. */
export function activeModelPolicy(now = Date.now()): AstraModelPolicy {
  let reading: Reading;
  try {
    const root = runtimeRoot();
    const key = [root, statSync(join(root, "hermes-home/v8/supervisor.json")).mtimeMs,
      statSync(join(root, "v8-manifest.json")).mtimeMs].join(":");
    reading = cache?.key === key ? cache.reading : read(root);
    cache = { key, reading };
  } catch {
    cache = null;
    return DECLARED_PRIMARY;
  }
  return { model: reading.model, reasoning: reading.reasoning, modelRole: reading.role,
    modelSource: !reading.armed ? "V8_NOT_ARMED"
      : now - reading.polledAt > STALE_MS ? "SUPERVISOR_STATE_STALE" : "SUPERVISOR_STATE" };
}

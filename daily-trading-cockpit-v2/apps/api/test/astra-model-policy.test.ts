import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeModelPolicy } from "../src/lib/astra-model-policy.js";

const now = 1800000000000;
const dirs: string[] = [];
const previousRoot = process.env.ASTRA_RUNTIME_ROOT;

afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
  if (previousRoot === undefined) delete process.env.ASTRA_RUNTIME_ROOT;
  else process.env.ASTRA_RUNTIME_ROOT = previousRoot;
});

/** Each case gets its own root so the mtime cache cannot leak between tests. */
function runtime(manifest: unknown, supervisor: unknown) {
  const root = mkdtempSync(join(tmpdir(), "astra-policy-"));
  dirs.push(root);
  const encode = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  if (manifest !== undefined) writeFileSync(join(root, "v8-manifest.json"), encode(manifest));
  if (supervisor !== undefined) {
    mkdirSync(join(root, "hermes-home/v8"), { recursive: true });
    writeFileSync(join(root, "hermes-home/v8/supervisor.json"), encode(supervisor));
  }
  process.env.ASTRA_RUNTIME_ROOT = root;
  return root;
}

const armed = { cohortId: "ASTRA_HERMES_FAST_LEARNING_V8", armed: true };
const onFallback = {
  lastPollAt: now - 1000,
  router: { routerState: "CLAUDE_FALLBACK" },
  jobs: {
    old: { at: now - 90000, modelPolicy: { task: "FAST_TRADING", role: "PRIMARY", provider: "openai-codex", model: "gpt-6-astra", effort: "medium" } },
    live: { at: now - 30000, modelPolicy: { task: "FAST_TRADING", role: "FALLBACK", provider: "anthropic", model: "claude-opus-5", effort: "high" } },
  },
};

describe("the model the Astra dashboard reports", () => {
  it("names the fallback while the fallback is the one deciding", () => {
    runtime(armed, onFallback);
    expect(activeModelPolicy(now)).toEqual({
      model: "claude-opus-5", reasoning: "high", modelRole: "CLAUDE_FALLBACK", modelSource: "SUPERVISOR_STATE" });
  });

  it("names the primary again once the lane switches back", () => {
    runtime(armed, { ...onFallback, router: { routerState: "ASTRA_PRIMARY" },
      jobs: { live: { at: now, modelPolicy: { task: "FAST_TRADING", role: "PRIMARY", provider: "openai-codex", model: "gpt-6-astra", effort: "medium" } } } });
    expect(activeModelPolicy(now)).toMatchObject({ model: "gpt-6-astra", reasoning: "medium", modelRole: "ASTRA_PRIMARY" });
  });

  it("prefers the identity the supervisor recorded over the built-in table", () => {
    // A model renamed in Python must not keep being reported under its old name here.
    runtime(armed, { ...onFallback,
      jobs: { live: { at: now, modelPolicy: { task: "FAST_TRADING", role: "FALLBACK", provider: "anthropic", model: "claude-opus-5-1", effort: "high" } } } });
    expect(activeModelPolicy(now).model).toBe("claude-opus-5-1");
  });

  it("uses the declared table when no trading job has run yet", () => {
    runtime(armed, { lastPollAt: now, jobs: {}, router: { routerState: "CLAUDE_FALLBACK" } });
    expect(activeModelPolicy(now)).toMatchObject({ model: "claude-opus-5", reasoning: "high" });
  });

  it("does not name the primary that just failed over while in fallback", () => {
    // The newest trading job is the failed Astra attempt; the role says CLAUDE_FALLBACK.
    runtime(armed, { lastPollAt: now, router: { routerState: "CLAUDE_FALLBACK" },
      jobs: { failed: { at: now, modelPolicy: { task: "FAST_TRADING", role: "PRIMARY", provider: "openai-codex", model: "gpt-6-astra", effort: "medium" } } } });
    expect(activeModelPolicy(now)).toMatchObject({ model: "claude-opus-5", reasoning: "high", modelRole: "CLAUDE_FALLBACK" });
  });

  it("ignores coaching jobs when naming who decides trades", () => {
    runtime(armed, { lastPollAt: now, router: { routerState: "ASTRA_PRIMARY" },
      jobs: { coach: { at: now, modelPolicy: { task: "COACHING", role: "PRIMARY", provider: "anthropic", model: "claude-opus-5", effort: "high" } } } });
    expect(activeModelPolicy(now)).toMatchObject({ model: "gpt-6-astra", reasoning: "medium" });
  });

  it("marks the answer stale rather than presenting a dead supervisor as current", () => {
    runtime(armed, { ...onFallback, lastPollAt: now - 600000 });
    expect(activeModelPolicy(now)).toMatchObject({ model: "claude-opus-5", modelSource: "SUPERVISOR_STATE_STALE" });
  });

  it("goes stale on the clock alone, without waiting for the file to change", () => {
    // The cached parse must not freeze the staleness flag at what it was when read.
    runtime(armed, onFallback);
    expect(activeModelPolicy(now).modelSource).toBe("SUPERVISOR_STATE");
    expect(activeModelPolicy(now + 600000).modelSource).toBe("SUPERVISOR_STATE_STALE");
  });

  it("says V8 is not arming the lane instead of guessing a role", () => {
    runtime({ ...armed, armed: false }, onFallback);
    expect(activeModelPolicy(now)).toEqual({
      model: "gpt-6-astra", reasoning: "medium", modelRole: "ASTRA_PRIMARY", modelSource: "V8_NOT_ARMED" });
  });

  it("reports the declared default rather than throwing when the state is unreadable", () => {
    // This value rides on /status, which the runner itself polls before every job.
    for (const broken of [[undefined, undefined], [armed, undefined], [armed, "{not json"]] as const) {
      runtime(broken[0], broken[1]);
      expect(activeModelPolicy(now).modelSource).toBe("DECLARED_DEFAULT");
    }
  });

  it("never claims a role the lane does not declare", () => {
    runtime(armed, { ...onFallback, router: { routerState: "SOMETHING_ELSE" }, jobs: {} });
    expect(activeModelPolicy(now)).toMatchObject({ modelRole: "ASTRA_PRIMARY", model: "gpt-6-astra" });
  });
});

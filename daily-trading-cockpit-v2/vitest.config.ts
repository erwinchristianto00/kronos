import { defineConfig } from "vitest/config";

/**
 * ROOT vitest config — exists solely so that running vitest FROM THE REPO ROOT behaves like the
 * canonical `npm test`.
 *
 * WHY (2026-07-27): `npm test` runs each workspace in its own cwd, so `apps/api/vitest.config.ts`
 * applies and its `testTimeout: 20000` is honoured. But `npx vitest run` invoked from the repo
 * root picks up NO config — there was none here — and silently fell back to vitest's 5s default.
 * The root invocation discovers all 263 files (apps/api's 256 plus packages/shared's 7), so it
 * looks like the more complete command; it is simply the one running the integration-style suites
 * at a quarter of their intended budget.
 *
 * The result was a phantom that cost real time: a rotating cast of 2-3 "failures" per run —
 * direction-entry-outcome-store, scan-route, paper-execution-router, cortex-real-attribution,
 * kronos-routes, paper-opportunity-allocator — every one of which passed in isolation. That reads
 * exactly like parallel-execution flakiness and was reported as such, twice. It was neither flaky
 * nor parallel: those files simply take longer than 5s when the process is warm and memory-loaded,
 * and which ones crossed the line varied with scheduling. Under `npm test`, and now under a root
 * run, all 5,011 tests pass.
 *
 * The timeouts intentionally mirror apps/api/vitest.config.ts rather than importing it: the two
 * roots resolve differently and a shared module here would couple them for no benefit. If that
 * file's budget changes, change this one too — the comment in each names the other.
 *
 * Do not delete this as redundant. Its whole purpose is that the wrong-but-plausible command stops
 * producing wrong-but-plausible results.
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});

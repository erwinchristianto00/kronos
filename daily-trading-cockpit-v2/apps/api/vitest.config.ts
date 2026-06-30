import { defineConfig } from "vitest/config";

// Several suites are integration-style: they mirror dozens of signals and resolve hundreds of
// synthetic observations through the candle-walk engine (e.g. buildWinningVmReport → ~840 obs).
// Run single-threaded (see the `test` npm script) these can take a few seconds each, and the 5s
// vitest default is too tight under the warmed, memory-loaded full-suite process — a borderline
// test (paper-opportunity-allocator [13]) times out only when run after the whole suite. Give the
// resolution-heavy tests headroom; this changes no production behavior.
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});

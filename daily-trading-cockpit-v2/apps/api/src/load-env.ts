// Loads .env from the repo root as a SIDE EFFECT on import.
//
// This must be imported as the FIRST import of the server entrypoint. ESM imports
// are hoisted and run depth-first BEFORE any other top-level statement, so calling
// dotenv's config() inline after `import { buildApp } from "./app.js"` runs too
// late: app.js (and its transitive libs) evaluate their top-level
// `const X = Number(process.env.X) || default` reads before .env is loaded, leaving
// env-tunable knobs (WATCHABLE_MIN_FRESH, GUARDRAIL_MIN_OOS, HEADLINE_MAX_*) on
// their code defaults. Runtime reads (API keys, etc.) were unaffected, which masked
// the bug. Putting the load in its own module that is imported first guarantees the
// env is populated before any consumer module is evaluated — regardless of whether
// the process is launched via a dotenv-preloading wrapper (laptop) or plain tsx (VPS/pm2).
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env"), override: false });

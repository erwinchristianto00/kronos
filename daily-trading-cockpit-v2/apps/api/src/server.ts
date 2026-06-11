import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root before anything reads process.env
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env"), override: false });

import { buildApp } from "./app.js";

console.log(`[API] SOCIAL_SENTIMENT_PROVIDER=${process.env.SOCIAL_SENTIMENT_PROVIDER ?? "(not set)"}`);

const port = Number(process.env.PORT ?? 3101);

const app = await buildApp();

try {
  await app.listen({
    port,
    host: "0.0.0.0",
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

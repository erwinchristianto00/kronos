import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/cortex-shadow-refit-operator.ts");
const source = readFileSync(file, "utf8");

describe("CORTEX operator runner authority boundary", () => {
  it("imports only report-only stores and cannot reach execution/allocation authority", () => {
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+[\"']/.test(line)).join("\n");
    for (const forbidden of ["live-execution-engine", "binance-futures-private", "paper-execution-router", "live-executor-wiring", "realtime-short-mirror", "cross-sectional-executor", "allocation", "app.ts"]) expect(imports).not.toContain(forbidden);
    for (const forbidden of ["placeOrder(", "closePosition(", "setAllocations(", "engageKillSwitch(", "runCortexRefit(", "runCortexNightlyRefit("]) expect(source).not.toContain(forbidden);
  });

  it("has no scheduler or HTTP surface", () => {
    for (const forbidden of ["setInterval(", "setTimeout(", ".post(", "fastify"]) expect(source).not.toContain(forbidden);
  });
});

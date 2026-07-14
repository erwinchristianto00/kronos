/**
 * Simulation SAFETY boundary — structural import scan + fail-closed contract. Proves the whole src/simulation/
 * package cannot reach live trading authority: it imports no live execution engine / authenticated exchange client /
 * deploy util, and contains none of the forbidden authority call identifiers. This is the hard isolation proof.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSimulationSafety, isSimulationSafe, SIMULATION_SAFETY_CONFIG, FORBIDDEN_AUTHORITY_SYMBOLS, FORBIDDEN_IMPORTS } from "../src/simulation/simulation-safety-boundary.js";

const SIM_DIR = join(__dirname, "..", "src", "simulation");
const simFiles = readdirSync(SIM_DIR).filter((f) => f.endsWith(".ts")).map((f) => ({ f, text: readFileSync(join(SIM_DIR, f), "utf8") }));
const importLines = (text: string): string[] => text.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));

describe("simulation safety — structural isolation from live authority", () => {
  it("the package contains .ts modules to scan", () => {
    expect(simFiles.length).toBeGreaterThanOrEqual(15);
  });

  it("NO simulation module imports a live-execution / authenticated-exchange / deploy module", () => {
    const offenders: string[] = [];
    for (const { f, text } of simFiles) {
      for (const bad of FORBIDDEN_IMPORTS) {
        // check only IMPORT lines (a doc comment mentioning the name is fine)
        if (importLines(text).some((l) => l.includes(bad))) offenders.push(`${f} imports ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("NO simulation module CALLS a forbidden authority symbol (import/call sites, not doc prose)", () => {
    const offenders: string[] = [];
    for (const { f, text } of simFiles) {
      if (f === "simulation-safety-boundary.ts") continue; // this file DECLARES the denylist as string data
      for (const sym of FORBIDDEN_AUTHORITY_SYMBOLS) {
        // match a call/import usage `sym(` or `.sym(` or `import { sym`, not the word inside a comment
        const codeLines = text.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
        if (codeLines.some((l) => new RegExp(`(^|[^\\w.])${sym}\\s*\\(`).test(l) || new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b`).test(l) || new RegExp(`\\.${sym}\\s*\\(`).test(l))) {
          offenders.push(`${f} uses ${sym}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no simulation module uses Date.now / Math.random / child_process (determinism + isolation)", () => {
    const offenders: string[] = [];
    for (const { f, text } of simFiles) {
      if (f === "simulation-safety-boundary.ts") continue; // DECLARES the denylist tokens as string data
      const codeLines = text.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
      for (const banned of ["Date.now(", "Math.random(", "child_process"]) {
        if (codeLines.some((l) => l.includes(banned))) offenders.push(`${f} uses ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("safety config: the frozen contract validates; any deviation FAILS CLOSED", () => {
    expect(requireSimulationSafety(SIMULATION_SAFETY_CONFIG)).toEqual(SIMULATION_SAFETY_CONFIG);
    expect(isSimulationSafe(SIMULATION_SAFETY_CONFIG)).toBe(true);
    expect(isSimulationSafe(null)).toBe(false);
    expect(isSimulationSafe({})).toBe(false);
    expect(isSimulationSafe({ ...SIMULATION_SAFETY_CONFIG, privateExchangeAccess: true } as never)).toBe(false);
    expect(isSimulationSafe({ ...SIMULATION_SAFETY_CONFIG, orderPlacementDisabled: false } as never)).toBe(false);
    expect(() => requireSimulationSafety({} as never)).toThrow();
  });
});

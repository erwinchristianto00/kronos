import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyCortexState } from "../src/lib/cortex-brain.js";
import {
  CORTEX_OPERATOR_EXIT,
  parseCortexShadowRefitOperatorArgs,
  runCortexShadowRefitOperator,
} from "../src/lib/cortex-shadow-refit-operator.js";

const dirs: string[] = [];
const SHA = "a".repeat(40);
function fixture(): { cwd: string; data: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "cortex-operator-")); dirs.push(root);
  const cwd = join(root, "apps", "api"); const data = join(cwd, "data");
  // The test fixture writes source artifacts directly; the runner only uses canonical readers.
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "executive-review-store.json"), JSON.stringify({ version: 1, reviews: [], tier1: [], tier2: [], processedIds: [], rejected: [] }));
  writeFileSync(join(data, "cortex-brain.json"), JSON.stringify(emptyCortexState()));
  const journal = join(data, "causal-experience", "3101"); mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, "events.jsonl"), "");
  const env = {
    PORT: "3101", FOUR_BRAIN_INSTANCE_ID: "3101", CAUSAL_EXPERIENCE_COLLECTION_MODE: "shadow",
    CAUSAL_EXPERIENCE_COLLECTION_DIR: data, END_TO_END_CORRECTNESS_DEPLOYED_AT: "2026-08-01T07:19:35.000Z",
  } as NodeJS.ProcessEnv;
  return { cwd, data, env };
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("CORTEX shadow-refit operator", () => {
  it("fails malformed CLI before store access and defaults to dry-run", () => {
    expect(parseCortexShadowRefitOperatorArgs([])).toMatchObject({ blocker: "INSTANCE_ARGUMENT_REQUIRED", exitCode: 2 });
    expect(parseCortexShadowRefitOperatorArgs(["--instance=3103"])).toMatchObject({ blocker: "INSTANCE_NOT_ALLOWED", exitCode: 2 });
    expect(parseCortexShadowRefitOperatorArgs(["--instance=3101"])).toMatchObject({ args: { instance: "3101", mode: "dry-run" } });
    const result = runCortexShadowRefitOperator([], { cwd: "/does/not/exist" });
    expect(result.exitCode).toBe(CORTEX_OPERATOR_EXIT.USAGE);
    expect(result.blockers).toEqual(["INSTANCE_ARGUMENT_REQUIRED"]);
  });

  it("keeps a dry-run genuinely mutation free and reports canonical empty evidence", () => {
    const f = fixture(); const before = readdirSync(f.data).sort();
    const result = runCortexShadowRefitOperator(["--instance=3101", "--dry-run"], { cwd: f.cwd, env: f.env, nowMs: Date.parse("2026-08-02T00:00:00.000Z"), codeVersion: () => ({ value: SHA, source: "test" }) });
    expect(result.verdict).toBe("CORTEX_OPERATOR_NO_REFIT");
    expect(result.exitCode).toBe(0);
    expect(result.prospective.directEligible).toBe(0);
    expect(result.prospective.beta).toEqual({ evaluationBeta: 0, liveBeta: 0 });
    expect(result.prospective.promotion).toBe("OFF");
    expect(result.mutationPlan).toEqual({ writeAuthorized: false, filesToChange: [], persisted: false });
    expect(readdirSync(f.data).sort()).toEqual(before);
    expect(existsSync(join(f.data, "cortex-shadow-refit-candidates.json"))).toBe(false);
    expect(existsSync(join(f.data, "cortex-shadow-refit-operator.lock"))).toBe(false);
  });

  it("requires runtime identity, policy, and source snapshot stability", () => {
    const f = fixture();
    const mismatch = runCortexShadowRefitOperator(["--instance=3102"], { cwd: f.cwd, env: f.env, codeVersion: () => ({ value: SHA, source: "test" }) });
    expect(mismatch.blockers).toEqual(["INSTANCE_RUNTIME_MISMATCH"]);
    const changing = runCortexShadowRefitOperator(["--instance=3101"], { cwd: f.cwd, env: f.env, codeVersion: () => ({ value: SHA, source: "test" }), onAfterRead: () => writeFileSync(join(f.data, "causal-experience", "3101", "events.jsonl"), "\n") });
    expect(changing.blockers).toEqual(["SOURCE_SNAPSHOT_CHANGED"]);
  });

  it("commits through the sealed registry only and removes its own narrow lock", () => {
    const f = fixture();
    const result = runCortexShadowRefitOperator(["--instance=3101", "--commit"], { cwd: f.cwd, env: f.env, nowMs: Date.parse("2026-08-02T00:00:00.000Z"), codeVersion: () => ({ value: SHA, source: "test" }) });
    expect(result.verdict).toBe("CORTEX_OPERATOR_NO_REFIT");
    const registry = join(realpathSync(f.data), "cortex-shadow-refit-candidates.json");
    expect(result.mutationPlan).toEqual({ writeAuthorized: true, filesToChange: [registry, `${registry}.bak`], persisted: true });
    expect(existsSync(join(f.data, "cortex-shadow-refit-candidates.json"))).toBe(true);
    expect(existsSync(join(f.data, "cortex-shadow-refit-candidates.json.bak"))).toBe(true);
    expect(existsSync(join(f.data, "cortex-shadow-refit-operator.lock"))).toBe(false);
  });

  it("fails closed on an existing operator lock and unresolved code version", () => {
    const f = fixture(); writeFileSync(join(f.data, "cortex-shadow-refit-operator.lock"), "operator-review-required");
    const locked = runCortexShadowRefitOperator(["--instance=3101", "--commit"], { cwd: f.cwd, env: f.env, codeVersion: () => ({ value: SHA, source: "test" }) });
    expect(locked.blockers).toEqual(["RUN_ALREADY_IN_PROGRESS"]);
    rmSync(join(f.data, "cortex-shadow-refit-operator.lock"));
    const unresolved = runCortexShadowRefitOperator(["--instance=3101", "--commit"], { cwd: f.cwd, env: f.env, codeVersion: () => ({ value: null, source: null }) });
    expect(unresolved.blockers).toEqual(["CODE_VERSION_UNRESOLVED"]);
  });

  it("never treats a corrupt incumbent file as canonical generation zero", () => {
    const f = fixture(); writeFileSync(join(f.data, "cortex-brain.json"), "{not-json");
    const result = runCortexShadowRefitOperator(["--instance=3101"], { cwd: f.cwd, env: f.env, codeVersion: () => ({ value: SHA, source: "test" }) });
    expect(result.blockers).toEqual(["INCUMBENT_STORE_CORRUPTED"]);
    expect(result.incumbent.generationZeroProven).toBe(false);
  });

  it("rejects a registry change between planning and persistence without removing a foreign registry", () => {
    const f = fixture(); const registry = join(f.data, "cortex-shadow-refit-candidates.json");
    const result = runCortexShadowRefitOperator(["--instance=3101", "--commit"], {
      cwd: f.cwd, env: f.env, codeVersion: () => ({ value: SHA, source: "test" }),
      onBeforePersist: () => writeFileSync(registry, "{concurrent-change"),
    });
    expect(result.blockers).toEqual(["REGISTRY_CHANGED_DURING_RUN"]);
    expect(existsSync(join(f.data, "cortex-shadow-refit-operator.lock"))).toBe(false);
  });
});

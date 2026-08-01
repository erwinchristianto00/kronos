import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  OPERATOR_SOURCE_CLOSURE,
  verifyCortexOperatorCodeProvenance,
} from "../src/lib/cortex-shadow-refit-operator.js";

const roots: string[] = [];
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd: string, args: readonly string[]): string => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

function repository(): { root: string; api: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "cortex-provenance-")); roots.push(root);
  for (const file of OPERATOR_SOURCE_CLOSURE) {
    const source = resolve(appRoot, "../..", file); const target = resolve(root, file);
    mkdirSync(dirname(target), { recursive: true }); cpSync(source, target);
  }
  git(root, ["init"]); git(root, ["config", "user.email", "operator@test.invalid"]); git(root, ["config", "user.name", "Operator Test"]);
  git(root, ["add", "."]); git(root, ["commit", "-m", "closure"]);
  return { root, api: resolve(root, "apps/api"), sha: git(root, ["rev-parse", "HEAD"]) };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("CORTEX operator deployed-code provenance", () => {
  it("rejects fake SHAs, stale source, and modified closure files", () => {
    const repo = repository();
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: "f".repeat(40), source: "env:DEPLOYMENT_COMMIT_SHA" }).status).toBe("CODE_VERSION_UNRESOLVED");
    writeFileSync(resolve(repo.root, "apps/api/src/lib/cortex-brain.ts"), `${readFileSync(resolve(repo.root, "apps/api/src/lib/cortex-brain.ts"), "utf8")}\n// modified runtime source\n`);
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYED_SOURCE_HASH_MISMATCH");
    git(repo.root, ["add", "."]); git(repo.root, ["commit", "-m", "new deployed source"]);
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYED_SOURCE_HASH_MISMATCH");
  });

  it("accepts only a clean closure byte-identical to the claimed Git commit", () => {
    const repo = repository();
    const verified = verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" });
    expect(verified).toMatchObject({ status: "VALID", sha: repo.sha, source: "git:HEAD+closure" });
    expect(verified.files.map((file) => file.path)).toEqual([...OPERATOR_SOURCE_CLOSURE]);
  });
});

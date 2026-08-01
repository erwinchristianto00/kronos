import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCortexOperatorSourceClosure,
  verifyCortexOperatorCodeProvenance,
} from "../src/lib/cortex-shadow-refit-operator.js";

const roots: string[] = [];
const sourceApi = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceClosure = resolveCortexOperatorSourceClosure(sourceApi);
if ("blocker" in sourceClosure) throw new Error(`test source closure unavailable: ${sourceClosure.blocker}`);
const git = (cwd: string, args: readonly string[]): string => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

function repository(): { root: string; api: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "cortex-provenance-")); roots.push(root);
  for (const file of sourceClosure.files) {
    const target = resolve(root, file.path); mkdirSync(dirname(target), { recursive: true }); cpSync(resolve(sourceClosure.root, file.path), target);
  }
  git(root, ["init"]); git(root, ["config", "user.email", "operator@test.invalid"]); git(root, ["config", "user.name", "Operator Test"]);
  git(root, ["add", "."]); git(root, ["commit", "-m", "closure"]);
  return { root, api: resolve(root, "daily-trading-cockpit-v2/apps/api"), sha: git(root, ["rev-parse", "HEAD"]) };
}
function manifest(repo: { root: string; api: string; sha: string }, commit = repo.sha): { schemaVersion: string; commitSha: string; files: { path: string; sha256: string }[] } {
  const closure = resolveCortexOperatorSourceClosure(repo.api); if ("blocker" in closure) throw new Error(closure.blocker);
  return { schemaVersion: "cortex-operator-deployment-manifest/1", commitSha: commit, files: closure.files.map((file) => ({ path: file.path, sha256: file.sha256 })) };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("CORTEX operator deployed-code provenance", () => {
  it("uses the actual nested Git root and accepts a clean recursive closure", () => {
    const repo = repository(); const verified = verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" });
    expect(verified).toMatchObject({ status: "VALID", sha: repo.sha, source: "git:HEAD+closure" });
    expect(resolveCortexOperatorSourceClosure(repo.api)).toMatchObject({ root: realpathSync(repo.root) });
    expect(verifyCortexOperatorCodeProvenance("/definitely-not-a-kronos-worktree", {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("GIT_ROOT_UNRESOLVED");
    expect(verified.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "daily-trading-cockpit-v2/apps/api/src/lib/four-brain-live-gather-bindings.ts",
      "daily-trading-cockpit-v2/apps/api/src/lib/four-brain-economic-experience.ts",
      "daily-trading-cockpit-v2/apps/api/src/experience-engine/cortex-experience-bridge.ts",
    ]));
  });

  it("blocks fake SHAs and any modified transitive runtime dependency", () => {
    const repo = repository();
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: "f".repeat(40), source: "env:DEPLOYMENT_COMMIT_SHA" }).status).toBe("CODE_VERSION_UNRESOLVED");
    for (const path of [
      "daily-trading-cockpit-v2/apps/api/src/lib/four-brain-live-gather-bindings.ts",
      "daily-trading-cockpit-v2/apps/api/src/lib/four-brain-economic-experience.ts",
      "daily-trading-cockpit-v2/apps/api/src/experience-engine/cortex-experience-bridge.ts",
    ]) {
      writeFileSync(resolve(repo.root, path), `${readFileSync(resolve(repo.root, path), "utf8")}\n// modified runtime source\n`);
      expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYED_SOURCE_HASH_MISMATCH");
      git(repo.root, ["checkout", "--", path]);
    }
  });

  it("fails unresolved imports but ignores unrelated dirty files outside closure", () => {
    const repo = repository(); const operator = resolve(repo.root, "daily-trading-cockpit-v2/apps/api/src/lib/cortex-shadow-refit-operator.ts");
    writeFileSync(operator, `${readFileSync(operator, "utf8")}\nimport \"./not-found.js\";\n`);
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("IMPORT_CLOSURE_INVALID");
    git(repo.root, ["checkout", "--", "daily-trading-cockpit-v2/apps/api/src/lib/cortex-shadow-refit-operator.ts"]);
    writeFileSync(resolve(repo.root, "unrelated.txt"), "not in operator closure");
    expect(verifyCortexOperatorCodeProvenance(repo.api, {}, { value: repo.sha, source: "git:HEAD" }).status).toBe("VALID");
  });

  it("requires an exact manifest closure and Git blob identity", () => {
    const repo = repository(); const file = resolve(repo.api, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest(repo)));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: repo.sha, source: "git:HEAD" })).toMatchObject({ status: "VALID", sha: repo.sha });
    writeFileSync(file, JSON.stringify({ ...manifest(repo), schemaVersion: "unknown" }));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYMENT_MANIFEST_INVALID");
    const traversal = manifest(repo); traversal.files[0] = { ...traversal.files[0]!, path: "../escape.ts" }; writeFileSync(file, JSON.stringify(traversal));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYMENT_MANIFEST_INVALID");
    const incomplete = manifest(repo); incomplete.files.pop(); writeFileSync(file, JSON.stringify(incomplete));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYMENT_MANIFEST_INVALID");
    const extra = manifest(repo); extra.files.push({ path: "extra.ts", sha256: "a".repeat(64) }); writeFileSync(file, JSON.stringify(extra));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: repo.sha, source: "git:HEAD" }).status).toBe("DEPLOYMENT_MANIFEST_INVALID");
    const old = repo.sha; const changed = resolve(repo.root, "daily-trading-cockpit-v2/apps/api/src/lib/cortex-brain.ts");
    writeFileSync(changed, `${readFileSync(changed, "utf8")}\n// new deployment\n`); git(repo.root, ["add", "."]); git(repo.root, ["commit", "-m", "new deployment"]);
    writeFileSync(file, JSON.stringify(manifest(repo, old)));
    expect(verifyCortexOperatorCodeProvenance(repo.api, { DEPLOYMENT_MANIFEST_PATH: "manifest.json" }, { value: old, source: "git:HEAD" }).status).toBe("DEPLOYED_SOURCE_HASH_MISMATCH");
  });
});

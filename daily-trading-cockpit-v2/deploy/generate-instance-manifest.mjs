#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const INCLUDED_ROOTS = [
  "apps/api/src",
  "apps/web/src",
  "packages/shared/src",
  "deploy",
  "package.json",
  "package-lock.json",
];
const EXCLUDED_PARTS = new Set(["manifests", "node_modules", "dist", "data", ".git"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walk(root, target, output) {
  if (!existsSync(target)) return;
  const stat = statSync(target);
  if (stat.isFile()) {
    output.push(target);
    return;
  }
  for (const name of readdirSync(target).sort()) {
    if (EXCLUDED_PARTS.has(name)) continue;
    walk(root, resolve(target, name), output);
  }
}

export function buildInstanceManifest({ instanceId, rootDir, generatedAt = new Date().toISOString() }) {
  const root = resolve(rootDir);
  const files = [];
  for (const included of INCLUDED_ROOTS) walk(root, resolve(root, included), files);
  const checksums = files
    .map((file) => {
      const path = relative(root, file).replaceAll("\\", "/");
      return { path, bytes: statSync(file).size, sha256: sha256(readFileSync(file)) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const digestInput = checksums.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n");
  let gitSha = null;
  let gitDirty = null;
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    gitDirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).trim().length > 0;
  } catch {
    // A source archive may not contain .git; checksums remain authoritative.
  }
  return {
    schemaVersion: 1,
    instanceId: String(instanceId),
    generatedAt,
    gitSha,
    gitDirty,
    fileCount: checksums.length,
    rootDigestSha256: sha256(digestInput),
    checksums,
  };
}

export function compareInstanceManifests(expected, actual) {
  const expectedByPath = new Map(expected.checksums.map((row) => [row.path, row.sha256]));
  const actualByPath = new Map(actual.checksums.map((row) => [row.path, row.sha256]));
  const changed = [];
  const missing = [];
  const unexpected = [];
  for (const [path, digest] of expectedByPath) {
    if (!actualByPath.has(path)) missing.push(path);
    else if (actualByPath.get(path) !== digest) changed.push(path);
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) unexpected.push(path);
  }
  return {
    ok: changed.length === 0 && missing.length === 0 && unexpected.length === 0,
    expectedRootDigestSha256: expected.rootDigestSha256,
    actualRootDigestSha256: actual.rootDigestSha256,
    changed,
    missing,
    unexpected,
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const instanceId = valueAfter(args, "--instance");
  const rootDir = valueAfter(args, "--root") ?? process.cwd();
  const out = valueAfter(args, "--out");
  const verify = valueAfter(args, "--verify");
  if (!instanceId) throw new Error("--instance is required");
  const manifest = buildInstanceManifest({ instanceId, rootDir });
  if (verify) {
    const expected = JSON.parse(readFileSync(resolve(verify), "utf-8"));
    const comparison = compareInstanceManifests(expected, manifest);
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    if (!comparison.ok) process.exitCode = 2;
    return;
  }
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out) {
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, payload, "utf-8");
  } else {
    process.stdout.write(payload);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

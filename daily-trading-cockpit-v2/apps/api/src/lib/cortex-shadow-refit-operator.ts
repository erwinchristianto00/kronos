/**
 * One-shot, report-only adapter for the sealed CORTEX shadow-refit path.
 * It reads the same canonical stores as runtime attribution but has no route to
 * execution, allocation, promotion, or process control.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative } from "node:path";

import { readCortexBrainStoreStrict } from "./cortex-brain-store.js";
import { emptyCortexState, type CortexStoreState } from "./cortex-brain.js";
import { EXECUTIVE_SCHEMA_VERSION } from "./four-brain-types.js";
import { resolveFourBrainInstanceId } from "./four-brain-live-gather-bindings.js";
import { ExecutiveReviewStore, type ExecutiveReviewOutcome } from "./executive-review-store.js";
import {
  CORTEX_SHADOW_REFIT_DEFAULT_EPOCH,
  CORTEX_SHADOW_REFIT_REGISTRY_FILE,
  CortexShadowRefitRegistryStore,
  planCortexShadowRefit,
  type CortexShadowRefitPlan,
} from "./cortex-shadow-refit.js";
import {
  forwardCausalJournalPath,
  readForwardCausalEvents,
  resolveCanonicalPolicyContext,
  type CanonicalPolicyContext,
  type ForwardEvent,
} from "../experience-engine/forward-causal-collection.js";

export const CORTEX_OPERATOR_EXIT = { SUCCESS: 0, USAGE: 2, BLOCKED: 3, VALIDATION: 4, UNEXPECTED: 5 } as const;
export type CortexOperatorMode = "dry-run" | "commit";
export type CortexOperatorVerdict =
  | "CORTEX_OPERATOR_DRY_RUN_PASS" | "CORTEX_OPERATOR_COMMIT_PASS"
  | "CORTEX_OPERATOR_NO_REFIT" | "CORTEX_OPERATOR_NO_NEW_ELIGIBLE_DATA"
  | "CORTEX_OPERATOR_BLOCKED" | "CORTEX_OPERATOR_VALIDATION_FAILURE";

export interface CortexOperatorArgs { readonly instance: "3101" | "3102"; readonly mode: CortexOperatorMode; readonly json: boolean; }
export interface CortexOperatorFile { readonly path: string; readonly sha256: string; readonly size: number; readonly mtimeMs: number; }
export interface CortexOperatorReport {
  readonly schemaVersion: "cortex-operator-runner/1";
  readonly verdict: CortexOperatorVerdict;
  readonly exitCode: number;
  readonly blockers: readonly string[];
  readonly invocation: { readonly mode: CortexOperatorMode; readonly requestedInstance: string | null; readonly runtimeInstance: string | null; readonly cwd: string; readonly dataDir: string | null; readonly codeVersion: string | null; readonly codeVersionSource: string | null; readonly verifiedCodeVersion: string | null; readonly verifiedCodeSource: string | null; readonly verifiedSourceFiles: readonly CortexOperatorFile[]; readonly resetEpoch: string; readonly generatedAt: string; };
  readonly policy: (CanonicalPolicyContext & { readonly fourBrainPolicyVersion: string }) | null;
  readonly sourceSnapshot: { readonly stable: boolean; readonly files: readonly CortexOperatorFile[]; readonly executiveOutcomeCount: number; readonly forwardEventCount: number; };
  readonly incumbent: { readonly generation: number | null; readonly generationZeroProven: boolean; readonly featureSchemaVersion: number | null; readonly coefficientFingerprint: string | null; readonly archetypes: Record<string, { readonly nEff: number; readonly refitAt: string | null }> | null; };
  readonly registry: { readonly path: string | null; readonly exists: boolean; readonly schemaVersion: string | null; readonly integrityStatus: string | null; readonly latestCandidateGeneration: string | null; readonly latestAuditStatus: string | null; };
  readonly prospective: { readonly status: string | null; readonly datasetHash: string | null; readonly generationFingerprint: string | null; readonly candidateGenerationId: string | null; readonly totalExamined: number; readonly directEligible: number; readonly archivedPreEpoch: number; readonly rejected: Readonly<Record<string, number>>; readonly beta: { readonly evaluationBeta: 0; readonly liveBeta: 0 }; readonly promotion: "OFF"; };
  readonly mutationPlan: { readonly writeAuthorized: boolean; readonly filesToChange: readonly string[]; readonly persisted: boolean; };
}

export interface CortexOperatorDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
  /** Test-only injection. The production CLI exposes no data directory override. */
  readonly dataDir?: string;
  readonly codeVersion?: () => { value: string | null; source: string | null };
  /** Test-only provenance seam. The production CLI always verifies manifest/Git closure itself. */
  readonly verifyCodeProvenance?: (candidate: { value: string | null; source: string | null }) => CortexOperatorCodeProvenance;
  readonly onAfterRead?: () => void;
  /** Test-only hook to prove registry identity is checked immediately before persistence. */
  readonly onBeforePersist?: () => void;
}

const sha = (contents: Buffer | string): string => createHash("sha256").update(contents).digest("hex");
const validSha = (value: string | null): value is string => value != null && /^[a-f0-9]{40}$/i.test(value);
const inside = (root: string, candidate: string): boolean => relative(root, candidate) === "" || !relative(root, candidate).startsWith(".." + "/") && relative(root, candidate) !== "..";
export const OPERATOR_SOURCE_CLOSURE = [
  "apps/api/scripts/cortex-shadow-refit-operator.ts",
  "apps/api/src/lib/cortex-shadow-refit-operator.ts",
  "apps/api/src/lib/cortex-shadow-refit.ts",
  "apps/api/src/lib/cortex-brain-store.ts",
  "apps/api/src/lib/cortex-brain.ts",
  "apps/api/src/lib/cortex-economic-model.ts",
  "apps/api/src/lib/executive-review-store.ts",
  "apps/api/src/experience-engine/forward-causal-collection.ts",
  "apps/api/src/lib/four-brain-types.ts",
  "packages/shared/src/evidence-era.ts",
  "packages/shared/src/policy-versions.ts",
] as const;
export interface CortexOperatorCodeProvenance {
  readonly status: "VALID" | "CODE_VERSION_UNRESOLVED" | "DEPLOYMENT_MANIFEST_INVALID" | "DEPLOYED_SOURCE_HASH_MISMATCH" | "GIT_SOURCE_MISMATCH";
  readonly sha: string | null;
  readonly source: string | null;
  readonly files: readonly CortexOperatorFile[];
}

export function parseCortexShadowRefitOperatorArgs(argv: readonly string[]): { args: CortexOperatorArgs | null; blocker: string | null; exitCode: number } {
  let instance: string | null = null; let mode: CortexOperatorMode = "dry-run"; let modeSeen = false; let json = false;
  for (const arg of argv) {
    if (arg.startsWith("--instance=")) { if (instance !== null) return { args: null, blocker: "INSTANCE_ARGUMENT_INVALID", exitCode: CORTEX_OPERATOR_EXIT.USAGE }; instance = arg.slice(11); continue; }
    if (arg === "--dry-run") { if (modeSeen && mode !== "dry-run") return { args: null, blocker: "MODE_ARGUMENT_CONFLICT", exitCode: CORTEX_OPERATOR_EXIT.USAGE }; mode = "dry-run"; modeSeen = true; continue; }
    if (arg === "--commit") { if (modeSeen && mode !== "commit") return { args: null, blocker: "MODE_ARGUMENT_CONFLICT", exitCode: CORTEX_OPERATOR_EXIT.USAGE }; mode = "commit"; modeSeen = true; continue; }
    if (arg === "--json") { json = true; continue; }
    return { args: null, blocker: "UNKNOWN_ARGUMENT", exitCode: CORTEX_OPERATOR_EXIT.USAGE };
  }
  if (instance == null || instance === "") return { args: null, blocker: "INSTANCE_ARGUMENT_REQUIRED", exitCode: CORTEX_OPERATOR_EXIT.USAGE };
  if (instance !== "3101" && instance !== "3102") return { args: null, blocker: "INSTANCE_NOT_ALLOWED", exitCode: CORTEX_OPERATOR_EXIT.USAGE };
  return { args: { instance, mode, json }, blocker: null, exitCode: CORTEX_OPERATOR_EXIT.SUCCESS };
}

function resolveDataDir(cwd: string, testDataDir?: string): { root: string; dataDir: string } | { blocker: string } {
  const root = resolve(cwd);
  const dataDir = resolve(testDataDir ?? resolve(root, "data"));
  if (!inside(root, dataDir)) return { blocker: "ACTIVE_DATA_DIR_OUTSIDE_RUNTIME_ROOT" };
  if (!existsSync(dataDir)) return { blocker: "ACTIVE_DATA_DIR_MISSING" };
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalDataDir = realpathSync(dataDir);
    if (lstatSync(dataDir).isSymbolicLink() || !inside(canonicalRoot, canonicalDataDir)) return { blocker: "ACTIVE_DATA_DIR_OUTSIDE_RUNTIME_ROOT" };
    return { root: canonicalRoot, dataDir: canonicalDataDir };
  } catch { return { blocker: "ACTIVE_DATA_DIR_OUTSIDE_RUNTIME_ROOT" }; }
}

function readStable(file: string, root: string): CortexOperatorFile {
  if (!existsSync(file)) throw new Error(`REQUIRED_SOURCE_STORE_MISSING:${file}`);
  const canonical = realpathSync(file);
  if (lstatSync(file).isSymbolicLink() || !inside(root, canonical)) throw new Error(`ACTIVE_DATA_DIR_OUTSIDE_RUNTIME_ROOT:${file}`);
  const bytes = readFileSync(file); const before = statSync(file);
  return { path: file, sha256: sha(bytes), size: before.size, mtimeMs: before.mtimeMs };
}
function unchanged(file: CortexOperatorFile): boolean {
  try { const stat = statSync(file.path); return stat.size === file.size && stat.mtimeMs === file.mtimeMs && sha(readFileSync(file.path)) === file.sha256; } catch { return false; }
}
function coefficientFingerprint(state: CortexStoreState): string { return sha(JSON.stringify({ featureSchemaVersion: state.featureSchemaVersion, archetypes: ["BREADTH", "NEUTRAL", "TACTICAL"].map((a) => ({ a, w: state.archetypes[a as keyof typeof state.archetypes].w })) })); }
function generation(state: CortexStoreState): { generation: number | null; proven: boolean } {
  const zero = emptyCortexState();
  const zeroVectors = ["BREADTH", "NEUTRAL", "TACTICAL"].every((a) => state.archetypes[a as keyof typeof state.archetypes].w.every((v, i) => v === zero.archetypes[a as keyof typeof zero.archetypes].w[i]));
  const noHistory = state.cumulativeResolved === 0 && state.updatedAt === null && Object.keys(state.countedObservations).length === 0 && Object.values(state.resolvedByFamily).every((count) => count === 0) && ["BREADTH", "NEUTRAL", "TACTICAL"].every((a) => state.archetypes[a as keyof typeof state.archetypes].refitAt == null && state.archetypes[a as keyof typeof state.archetypes].nEff === 0);
  return zeroVectors && noHistory ? { generation: 0, proven: true } : { generation: null, proven: false };
}
function resolveCodeVersion(cwd: string, env: NodeJS.ProcessEnv, injected?: CortexOperatorDeps["codeVersion"]): { value: string | null; source: string | null } {
  if (injected) return injected();
  for (const key of ["DEPLOYMENT_COMMIT_SHA", "GIT_COMMIT_SHA", "CODE_VERSION"]) { const value = env[key]?.trim() ?? ""; if (validSha(value)) return { value, source: `env:${key}` }; }
  try { const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return validSha(value) ? { value, source: "git:HEAD" } : { value: null, source: null }; } catch { return { value: null, source: null }; }
}
function command(cwd: string, args: readonly string[]): string | null {
  try { return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}
function closureFiles(repoRoot: string): CortexOperatorFile[] | null {
  try {
    return OPERATOR_SOURCE_CLOSURE.map((entry) => {
      const path = resolve(repoRoot, entry); const contents = readFileSync(path);
      return { path: entry, sha256: sha(contents), size: contents.length, mtimeMs: statSync(path).mtimeMs };
    });
  } catch { return null; }
}
function readDeploymentManifest(file: string, repoRoot: string): CortexOperatorCodeProvenance | null {
  if (!existsSync(file)) return { status: "DEPLOYMENT_MANIFEST_INVALID", sha: null, source: `manifest:${file}`, files: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const commit = typeof raw.commitSha === "string" ? raw.commitSha : typeof raw.commitSHA === "string" ? raw.commitSHA : null;
    const hashes = raw.sourceHashes && typeof raw.sourceHashes === "object" && !Array.isArray(raw.sourceHashes) ? raw.sourceHashes as Record<string, unknown> : null;
    const files = closureFiles(repoRoot);
    if (!validSha(commit) || !hashes || !files) return { status: "DEPLOYMENT_MANIFEST_INVALID", sha: null, source: `manifest:${file}`, files: [] };
    if (files.some((entry) => hashes[entry.path] !== entry.sha256)) return { status: "DEPLOYED_SOURCE_HASH_MISMATCH", sha: commit, source: `manifest:${file}`, files };
    return { status: "VALID", sha: commit, source: `manifest:${file}`, files };
  } catch { return { status: "DEPLOYMENT_MANIFEST_INVALID", sha: null, source: `manifest:${file}`, files: [] }; }
}
export function verifyCortexOperatorCodeProvenance(cwd: string, env: NodeJS.ProcessEnv, candidate: { value: string | null; source: string | null }): CortexOperatorCodeProvenance {
  const repoRoot = resolve(cwd, "../..");
  const manifest = env.DEPLOYMENT_MANIFEST_PATH?.trim();
  if (manifest) return readDeploymentManifest(resolve(manifest), repoRoot)!;
  if (!validSha(candidate.value)) return { status: "CODE_VERSION_UNRESOLVED", sha: null, source: candidate.source, files: [] };
  const resolved = command(repoRoot, ["rev-parse", `${candidate.value}^{commit}`]);
  const files = closureFiles(repoRoot);
  if (!resolved || !validSha(resolved) || !files) return { status: "CODE_VERSION_UNRESOLVED", sha: null, source: candidate.source, files: [] };
  for (const file of files) {
    const expected = command(repoRoot, ["show", `${resolved}:${file.path}`]);
    // `git show` text is not sufficient for arbitrary bytes; source closure is TypeScript text,
    // and Git's blob hash check below independently proves exact byte identity.
    const blob = command(repoRoot, ["rev-parse", `${resolved}:${file.path}`]);
    const localBlob = command(repoRoot, ["hash-object", resolve(repoRoot, file.path)]);
    if (expected == null || blob == null || localBlob !== blob) return { status: "DEPLOYED_SOURCE_HASH_MISMATCH", sha: resolved, source: candidate.source, files };
  }
  const clean = command(repoRoot, ["status", "--porcelain", "--", ...OPERATOR_SOURCE_CLOSURE]);
  if (clean == null || clean !== "") return { status: "GIT_SOURCE_MISMATCH", sha: resolved, source: candidate.source, files };
  return { status: "VALID", sha: resolved, source: candidate.source === "git:HEAD" ? "git:HEAD+closure" : `${candidate.source}+closure`, files };
}
function registryIdentity(file: string, registry: CortexShadowRefitRegistryStore): { exists: boolean; sha256: string | null; schemaVersion: string; integrityHash: string; lastGenerationFingerprint: string | null } {
  const current = registry.get();
  return {
    exists: existsSync(file), sha256: existsSync(file) ? sha(readFileSync(file)) : null,
    schemaVersion: current.schemaVersion, integrityHash: current.registryIntegrityHash,
    lastGenerationFingerprint: current.lastGenerationFingerprint,
  };
}
function sameRegistryIdentity(left: ReturnType<typeof registryIdentity>, right: ReturnType<typeof registryIdentity>): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256 && left.schemaVersion === right.schemaVersion && left.integrityHash === right.integrityHash && left.lastGenerationFingerprint === right.lastGenerationFingerprint;
}
function strictIncumbentBlocker(status: ReturnType<typeof readCortexBrainStoreStrict>["status"]): string {
  if (status === "FILE_MISSING") return "INCUMBENT_STORE_MISSING";
  if (status === "JSON_CORRUPTED") return "INCUMBENT_STORE_CORRUPTED";
  if (status === "SCHEMA_MISMATCH") return "INCUMBENT_STORE_SCHEMA_MISMATCH";
  return "INCUMBENT_STORE_PARTIAL_INVALID";
}

function blank(mode: CortexOperatorMode, requestedInstance: string | null, cwd: string, nowMs: number): CortexOperatorReport {
  return { schemaVersion: "cortex-operator-runner/1", verdict: "CORTEX_OPERATOR_BLOCKED", exitCode: CORTEX_OPERATOR_EXIT.BLOCKED, blockers: [], invocation: { mode, requestedInstance, runtimeInstance: null, cwd, dataDir: null, codeVersion: null, codeVersionSource: null, verifiedCodeVersion: null, verifiedCodeSource: null, verifiedSourceFiles: [], resetEpoch: CORTEX_SHADOW_REFIT_DEFAULT_EPOCH, generatedAt: new Date(nowMs).toISOString() }, policy: null, sourceSnapshot: { stable: false, files: [], executiveOutcomeCount: 0, forwardEventCount: 0 }, incumbent: { generation: null, generationZeroProven: false, featureSchemaVersion: null, coefficientFingerprint: null, archetypes: null }, registry: { path: null, exists: false, schemaVersion: null, integrityStatus: null, latestCandidateGeneration: null, latestAuditStatus: null }, prospective: { status: null, datasetHash: null, generationFingerprint: null, candidateGenerationId: null, totalExamined: 0, directEligible: 0, archivedPreEpoch: 0, rejected: {}, beta: { evaluationBeta: 0, liveBeta: 0 }, promotion: "OFF" }, mutationPlan: { writeAuthorized: false, filesToChange: [], persisted: false } };
}

export function runCortexShadowRefitOperator(argv: readonly string[], deps: CortexOperatorDeps = {}): CortexOperatorReport {
  const parsed = parseCortexShadowRefitOperatorArgs(argv); const nowMs = deps.nowMs ?? Date.now(); const cwd = resolve(deps.cwd ?? process.cwd());
  if (!parsed.args) { const result = blank("dry-run", null, cwd, nowMs); return { ...result, exitCode: parsed.exitCode, blockers: [parsed.blocker!], verdict: "CORTEX_OPERATOR_BLOCKED" }; }
  const args = parsed.args; let report = blank(args.mode, args.instance, cwd, nowMs); const env = deps.env ?? process.env;
  const data = resolveDataDir(cwd, deps.dataDir);
  if ("blocker" in data) return { ...report, blockers: [data.blocker] };
  const runtimeInstance = resolveFourBrainInstanceId(env); report = { ...report, invocation: { ...report.invocation, runtimeInstance, dataDir: data.dataDir } };
  if (runtimeInstance !== args.instance) return { ...report, blockers: ["INSTANCE_RUNTIME_MISMATCH"] };
  const canonical = resolveCanonicalPolicyContext(env);
  if (!canonical || Object.values(canonical).some((v) => typeof v !== "string" || !v)) return { ...report, blockers: ["POLICY_CONTEXT_INCOMPLETE"] };
  if (!Number.isFinite(Date.parse(canonical.policyDeploymentAt))) return { ...report, blockers: ["POLICY_CONTEXT_INVALID"] };
  if (!EXECUTIVE_SCHEMA_VERSION) return { ...report, blockers: ["FOUR_BRAIN_POLICY_VERSION_UNRESOLVED"] };
  const policy = { ...canonical, instanceId: args.instance, fourBrainPolicyVersion: EXECUTIVE_SCHEMA_VERSION } as const;
  const code = resolveCodeVersion(cwd, env, deps.codeVersion);
  const provenance = deps.verifyCodeProvenance?.(code) ?? verifyCortexOperatorCodeProvenance(cwd, env, code);
  report = { ...report, invocation: { ...report.invocation, codeVersion: code.value, codeVersionSource: code.source, verifiedCodeVersion: provenance.sha, verifiedCodeSource: provenance.source, verifiedSourceFiles: provenance.files }, policy };
  if (provenance.status !== "VALID") return { ...report, blockers: [provenance.status] };
  if (!provenance.sha) return { ...report, blockers: ["CODE_VERSION_UNRESOLVED"] };
  const causalDir = resolve((env.CAUSAL_EXPERIENCE_COLLECTION_DIR ?? "data").toString());
  try { if (realpathSync(causalDir) !== data.dataDir) return { ...report, blockers: ["ACTIVE_DATA_DIR_AMBIGUOUS"] }; } catch { return { ...report, blockers: ["ACTIVE_DATA_DIR_AMBIGUOUS"] }; }
  const executiveFile = resolve(data.dataDir, "executive-review-store.json");
  const brainFile = resolve(data.dataDir, "cortex-brain.json");
  const configuredJournal = forwardCausalJournalPath(env);
  if (!configuredJournal || !existsSync(configuredJournal)) return { ...report, blockers: ["REQUIRED_SOURCE_STORE_MISSING"] };
  let journal: string;
  try { journal = realpathSync(configuredJournal); } catch { return { ...report, blockers: ["REQUIRED_SOURCE_STORE_MISSING"] }; }
  if (!inside(data.root, journal)) return { ...report, blockers: ["ACTIVE_DATA_DIR_OUTSIDE_RUNTIME_ROOT"] };
  const registryFile = resolve(data.dataDir, CORTEX_SHADOW_REFIT_REGISTRY_FILE);
  const lock = resolve(data.dataDir, "cortex-shadow-refit-operator.lock");
  let ownsLock = false;
  if (args.mode === "commit") {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx"); ownsLock = true;
      writeFileSync(fd, JSON.stringify({ schemaVersion: "cortex-shadow-refit-operator-lock/1", pid: process.pid, instance: args.instance, startedAt: new Date(nowMs).toISOString(), codeVersion: provenance.sha, runId: randomUUID() }));
      closeSync(fd); fd = null;
    } catch (error) {
      if (fd != null) closeSync(fd);
      if (ownsLock) { try { rmSync(lock); } catch { /* best effort: never remove a foreign lock */ } }
      return { ...report, blockers: [ownsLock ? "OPERATOR_LOCK_METADATA_WRITE_FAILED" : "RUN_ALREADY_IN_PROGRESS"] };
    }
  }
  try {
    let files: CortexOperatorFile[];
    try {
      files = [readStable(executiveFile, data.root), readStable(brainFile, data.root), readStable(journal, data.root)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...report, blockers: [message.split(":")[0]!] };
    }
    const executiveStore = new ExecutiveReviewStore(executiveFile); const outcomes = executiveStore.get().tier1 as readonly ExecutiveReviewOutcome[];
    const events = readForwardCausalEvents(journal); const strictIncumbent = readCortexBrainStoreStrict(brainFile); deps.onAfterRead?.();
    if (!files.every(unchanged)) return { ...report, blockers: ["SOURCE_SNAPSHOT_CHANGED"] };
    if (strictIncumbent.status !== "VALID") return { ...report, blockers: [strictIncumbentBlocker(strictIncumbent.status)] };
    const incumbent = strictIncumbent.state;
    const incumbentGeneration = generation(incumbent); const archetypes = Object.fromEntries(["BREADTH", "NEUTRAL", "TACTICAL"].map((a) => [a, { nEff: incumbent.archetypes[a as keyof typeof incumbent.archetypes].nEff, refitAt: incumbent.archetypes[a as keyof typeof incumbent.archetypes].refitAt }]));
    const registry = new CortexShadowRefitRegistryStore(registryFile); const registryState = registry.get();
    const initialRegistryIdentity = registryIdentity(registryFile, registry);
    report = { ...report, sourceSnapshot: { stable: true, files, executiveOutcomeCount: outcomes.length, forwardEventCount: events.length }, incumbent: { generation: incumbentGeneration.generation, generationZeroProven: incumbentGeneration.proven, featureSchemaVersion: incumbent.featureSchemaVersion, coefficientFingerprint: coefficientFingerprint(incumbent), archetypes }, registry: { path: registryFile, exists: existsSync(registryFile), schemaVersion: registryState.schemaVersion, integrityStatus: registryState.integrityStatus, latestCandidateGeneration: registryState.candidates.at(-1)?.generationId ?? null, latestAuditStatus: registryState.lastAudit?.status ?? null } };
    if (!incumbentGeneration.proven || incumbentGeneration.generation == null) return { ...report, blockers: ["INCUMBENT_GENERATION_UNRESOLVED"] };
    if (registry.isCorrupted()) return { ...report, blockers: ["REGISTRY_CORRUPTED"] };
    const plan: CortexShadowRefitPlan = planCortexShadowRefit({ outcomes, forwardEvents: events, policy, incumbent, registry, nowMs, codeVersion: provenance.sha, incumbentGeneration: incumbentGeneration.generation });
    const p = plan.report; const prospective = { status: p.status, datasetHash: p.dataset.datasetHash, generationFingerprint: p.candidate?.generationFingerprint ?? registryState.lastGenerationFingerprint, candidateGenerationId: p.candidate?.generationId ?? null, totalExamined: p.dataset.examined, directEligible: p.dataset.examples.length, archivedPreEpoch: p.dataset.archivedPreEpoch, rejected: p.dataset.rejected, beta: p.beta, promotion: "OFF" as const };
    report = { ...report, prospective, blockers: p.blockers };
    if (p.status === "BLOCKED" || !plan.nextRegistry) return { ...report, blockers: [...p.blockers, "REFIT_PLAN_BLOCKED"] };
    if (args.mode === "dry-run") return { ...report, exitCode: CORTEX_OPERATOR_EXIT.SUCCESS, verdict: p.status === "NO_NEW_ELIGIBLE_DATA" ? "CORTEX_OPERATOR_NO_NEW_ELIGIBLE_DATA" : p.status === "NO_REFIT" ? "CORTEX_OPERATOR_NO_REFIT" : "CORTEX_OPERATOR_DRY_RUN_PASS" };
    deps.onBeforePersist?.();
    if (!files.every(unchanged)) return { ...report, blockers: ["SOURCE_SNAPSHOT_CHANGED"] };
    const registryBeforePersist = new CortexShadowRefitRegistryStore(registryFile);
    if (!sameRegistryIdentity(initialRegistryIdentity, registryIdentity(registryFile, registryBeforePersist))) return { ...report, blockers: ["REGISTRY_CHANGED_DURING_RUN"] };
    try {
      registry.save(plan.nextRegistry);
      return { ...report, exitCode: CORTEX_OPERATOR_EXIT.SUCCESS, verdict: p.status === "NO_NEW_ELIGIBLE_DATA" ? "CORTEX_OPERATOR_NO_NEW_ELIGIBLE_DATA" : p.status === "NO_REFIT" ? "CORTEX_OPERATOR_NO_REFIT" : "CORTEX_OPERATOR_COMMIT_PASS", mutationPlan: { writeAuthorized: true, filesToChange: [registryFile, `${registryFile}.bak`], persisted: true } };
    } catch { return { ...report, exitCode: CORTEX_OPERATOR_EXIT.VALIDATION, verdict: "CORTEX_OPERATOR_VALIDATION_FAILURE", blockers: ["REGISTRY_PERSISTENCE_FAILED"] }; }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...report, exitCode: CORTEX_OPERATOR_EXIT.UNEXPECTED, verdict: "CORTEX_OPERATOR_VALIDATION_FAILURE", blockers: [`OPERATOR_UNEXPECTED_FAILURE:${detail}`] };
  } finally {
    if (ownsLock) try { rmSync(lock); } catch { /* only this process's exclusive lock may be removed */ }
  }
}

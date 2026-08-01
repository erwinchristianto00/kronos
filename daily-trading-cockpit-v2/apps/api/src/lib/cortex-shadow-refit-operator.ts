/**
 * One-shot, report-only adapter for the sealed CORTEX shadow-refit path.
 * It reads the same canonical stores as runtime attribution but has no route to
 * execution, allocation, promotion, or process control.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative } from "node:path";

import { CortexBrainStore } from "./cortex-brain-store.js";
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
  readonly invocation: { readonly mode: CortexOperatorMode; readonly requestedInstance: string | null; readonly runtimeInstance: string | null; readonly cwd: string; readonly dataDir: string | null; readonly codeVersion: string | null; readonly codeVersionSource: string | null; readonly resetEpoch: string; readonly generatedAt: string; };
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
  readonly onAfterRead?: () => void;
}

const sha = (contents: Buffer | string): string => createHash("sha256").update(contents).digest("hex");
const validSha = (value: string | null): value is string => value != null && /^[a-f0-9]{40}$/i.test(value);
const inside = (root: string, candidate: string): boolean => relative(root, candidate) === "" || !relative(root, candidate).startsWith(".." + "/") && relative(root, candidate) !== "..";

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
  const noHistory = state.cumulativeResolved === 0 && Object.keys(state.countedObservations).length === 0 && ["BREADTH", "NEUTRAL", "TACTICAL"].every((a) => state.archetypes[a as keyof typeof state.archetypes].refitAt == null && state.archetypes[a as keyof typeof state.archetypes].nEff === 0);
  return zeroVectors && noHistory ? { generation: 0, proven: true } : { generation: null, proven: false };
}
function resolveCodeVersion(cwd: string, env: NodeJS.ProcessEnv, injected?: CortexOperatorDeps["codeVersion"]): { value: string | null; source: string | null } {
  if (injected) return injected();
  for (const key of ["DEPLOYMENT_COMMIT_SHA", "GIT_COMMIT_SHA", "CODE_VERSION"]) { const value = env[key]?.trim() ?? ""; if (validSha(value)) return { value, source: `env:${key}` }; }
  try { const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return validSha(value) ? { value, source: "git:HEAD" } : { value: null, source: null }; } catch { return { value: null, source: null }; }
}

function blank(mode: CortexOperatorMode, requestedInstance: string | null, cwd: string, nowMs: number): CortexOperatorReport {
  return { schemaVersion: "cortex-operator-runner/1", verdict: "CORTEX_OPERATOR_BLOCKED", exitCode: CORTEX_OPERATOR_EXIT.BLOCKED, blockers: [], invocation: { mode, requestedInstance, runtimeInstance: null, cwd, dataDir: null, codeVersion: null, codeVersionSource: null, resetEpoch: CORTEX_SHADOW_REFIT_DEFAULT_EPOCH, generatedAt: new Date(nowMs).toISOString() }, policy: null, sourceSnapshot: { stable: false, files: [], executiveOutcomeCount: 0, forwardEventCount: 0 }, incumbent: { generation: null, generationZeroProven: false, featureSchemaVersion: null, coefficientFingerprint: null, archetypes: null }, registry: { path: null, exists: false, schemaVersion: null, integrityStatus: null, latestCandidateGeneration: null, latestAuditStatus: null }, prospective: { status: null, datasetHash: null, generationFingerprint: null, candidateGenerationId: null, totalExamined: 0, directEligible: 0, archivedPreEpoch: 0, rejected: {}, beta: { evaluationBeta: 0, liveBeta: 0 }, promotion: "OFF" }, mutationPlan: { writeAuthorized: false, filesToChange: [], persisted: false } };
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
  const code = resolveCodeVersion(cwd, env, deps.codeVersion); report = { ...report, invocation: { ...report.invocation, codeVersion: code.value, codeVersionSource: code.source }, policy };
  if (!code.value) return { ...report, blockers: ["CODE_VERSION_UNRESOLVED"] };
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
  let files: CortexOperatorFile[];
  try {
    files = [readStable(executiveFile, data.root), readStable(brainFile, data.root), readStable(journal, data.root)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...report, blockers: [message.split(":")[0]!] };
  }
  try {
    const executiveStore = new ExecutiveReviewStore(executiveFile); const outcomes = executiveStore.get().tier1 as readonly ExecutiveReviewOutcome[];
    const events = readForwardCausalEvents(journal); const incumbent = new CortexBrainStore(brainFile).get(); deps.onAfterRead?.();
    if (!files.every(unchanged)) return { ...report, blockers: ["SOURCE_SNAPSHOT_CHANGED"] };
    const incumbentGeneration = generation(incumbent); const archetypes = Object.fromEntries(["BREADTH", "NEUTRAL", "TACTICAL"].map((a) => [a, { nEff: incumbent.archetypes[a as keyof typeof incumbent.archetypes].nEff, refitAt: incumbent.archetypes[a as keyof typeof incumbent.archetypes].refitAt }]));
    const registry = new CortexShadowRefitRegistryStore(registryFile); const registryState = registry.get();
    report = { ...report, sourceSnapshot: { stable: true, files, executiveOutcomeCount: outcomes.length, forwardEventCount: events.length }, incumbent: { generation: incumbentGeneration.generation, generationZeroProven: incumbentGeneration.proven, featureSchemaVersion: incumbent.featureSchemaVersion, coefficientFingerprint: coefficientFingerprint(incumbent), archetypes }, registry: { path: registryFile, exists: existsSync(registryFile), schemaVersion: registryState.schemaVersion, integrityStatus: registryState.integrityStatus, latestCandidateGeneration: registryState.candidates.at(-1)?.generationId ?? null, latestAuditStatus: registryState.lastAudit?.status ?? null } };
    if (!incumbentGeneration.proven || incumbentGeneration.generation == null) return { ...report, blockers: ["INCUMBENT_GENERATION_UNRESOLVED"] };
    if (registry.isCorrupted()) return { ...report, blockers: ["REGISTRY_CORRUPTED"] };
    const plan: CortexShadowRefitPlan = planCortexShadowRefit({ outcomes, forwardEvents: events, policy, incumbent, registry, nowMs, codeVersion: code.value, incumbentGeneration: incumbentGeneration.generation });
    const p = plan.report; const prospective = { status: p.status, datasetHash: p.dataset.datasetHash, generationFingerprint: p.candidate?.generationFingerprint ?? registryState.lastGenerationFingerprint, candidateGenerationId: p.candidate?.generationId ?? null, totalExamined: p.dataset.examined, directEligible: p.dataset.examples.length, archivedPreEpoch: p.dataset.archivedPreEpoch, rejected: p.dataset.rejected, beta: p.beta, promotion: "OFF" as const };
    report = { ...report, prospective, blockers: p.blockers };
    if (p.status === "BLOCKED" || !plan.nextRegistry) return { ...report, blockers: [...p.blockers, "REFIT_PLAN_BLOCKED"] };
    if (args.mode === "dry-run") return { ...report, exitCode: CORTEX_OPERATOR_EXIT.SUCCESS, verdict: p.status === "NO_NEW_ELIGIBLE_DATA" ? "CORTEX_OPERATOR_NO_NEW_ELIGIBLE_DATA" : p.status === "NO_REFIT" ? "CORTEX_OPERATOR_NO_REFIT" : "CORTEX_OPERATOR_DRY_RUN_PASS" };
    const lock = resolve(data.dataDir, "cortex-shadow-refit-operator.lock"); let lockFd: number | null = null;
    try {
      mkdirSync(dirname(lock), { recursive: true }); lockFd = openSync(lock, "wx"); writeFileSync(lockFd, JSON.stringify({ pid: process.pid, instance: args.instance, startedAt: new Date(nowMs).toISOString(), codeVersion: code.value }));
    } catch { return { ...report, blockers: ["RUN_ALREADY_IN_PROGRESS"] }; }
    try {
      if (!files.every(unchanged)) return { ...report, blockers: ["SOURCE_SNAPSHOT_CHANGED"] };
      registry.save(plan.nextRegistry);
      return { ...report, exitCode: CORTEX_OPERATOR_EXIT.SUCCESS, verdict: p.status === "NO_NEW_ELIGIBLE_DATA" ? "CORTEX_OPERATOR_NO_NEW_ELIGIBLE_DATA" : p.status === "NO_REFIT" ? "CORTEX_OPERATOR_NO_REFIT" : "CORTEX_OPERATOR_COMMIT_PASS", mutationPlan: { writeAuthorized: true, filesToChange: [registryFile, `${registryFile}.bak`], persisted: true } };
    } catch { return { ...report, exitCode: CORTEX_OPERATOR_EXIT.VALIDATION, verdict: "CORTEX_OPERATOR_VALIDATION_FAILURE", blockers: ["REGISTRY_PERSISTENCE_FAILED"] }; }
    finally { if (lockFd != null) try { rmSync(lock); } catch { /* operator must inspect an unexpected lock cleanup failure */ } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...report, exitCode: CORTEX_OPERATOR_EXIT.UNEXPECTED, verdict: "CORTEX_OPERATOR_VALIDATION_FAILURE", blockers: [`OPERATOR_UNEXPECTED_FAILURE:${detail}`] };
  }
}

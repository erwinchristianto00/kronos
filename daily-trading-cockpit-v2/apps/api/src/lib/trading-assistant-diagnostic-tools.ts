/**
 * Narrow, read-only diagnostic tools for the CORTEX chat assistant.
 *
 * There is deliberately no arbitrary shell, arbitrary URL, write, restart, process-signal, or trading
 * operation here. Every filesystem path is rooted under one of three configured repo roots, sensitive
 * directories/files are denied, symlinks cannot escape their root, outputs are bounded, and likely secrets
 * are redacted before any text is sent to the external model.
 */
import { execFile } from "node:child_process";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChatToolDefinition } from "./nvidia-chat-client.js";

export type DiagnosticInstance = "main" | "testnet" | "live";

export interface DiagnosticToolConfig {
  enabled: boolean;
  roots: Record<DiagnosticInstance, string>;
  logsDir: string;
  maxFiles: number;
  maxOutputChars: number;
}

const INSTANCES: DiagnosticInstance[] = ["main", "testnet", "live"];
const DENIED_SEGMENTS = new Set([".git", ".ssh", "node_modules", "data", "dist", "coverage", "archive", "backups"]);
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".css", ".html", ".yml", ".yaml"]);
const MAX_READ_LINES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 192 * 1024;
const DEFAULT_MAX_FILES = 6_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;

const TOOL_PARAMETERS = {
  instance: { type: "string", enum: INSTANCES, description: "Which deployed repo to inspect." },
} as const;

export const DIAGNOSTIC_TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List readable source/config files under a deployed repo path. Read-only and bounded.",
      parameters: {
        type: "object",
        properties: { ...TOOL_PARAMETERS, path: { type: "string", description: "Repo-relative directory, default '.'." } },
        required: ["instance"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search readable source/config files for a literal case-insensitive string and return file:line evidence.",
      parameters: {
        type: "object",
        properties: {
          ...TOOL_PARAMETERS,
          query: { type: "string", description: "Literal text to search for; not a shell command or regex." },
          path: { type: "string", description: "Optional repo-relative directory to narrow the search." },
        },
        required: ["instance", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a bounded line range from one readable source/config file.",
      parameters: {
        type: "object",
        properties: {
          ...TOOL_PARAMETERS,
          path: { type: "string", description: "Repo-relative file path." },
          start_line: { type: "integer", minimum: 1, description: "First line, inclusive; default 1." },
          end_line: { type: "integer", minimum: 1, description: "Last line, inclusive; capped to 200 lines." },
        },
        required: ["instance", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show bounded git status for one deployed repo. Read-only.",
      parameters: { type: "object", properties: { ...TOOL_PARAMETERS }, required: ["instance"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show a bounded working-tree or staged diff, optionally narrowed to one safe repo-relative path.",
      parameters: {
        type: "object",
        properties: {
          ...TOOL_PARAMETERS,
          path: { type: "string", description: "Optional safe repo-relative path." },
          staged: { type: "boolean", description: "True for staged diff; false for working-tree diff." },
        },
        required: ["instance"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_service_logs",
      description: "Read the last bounded lines from a fixed PM2 API log. Likely credentials are redacted.",
      parameters: {
        type: "object",
        properties: {
          ...TOOL_PARAMETERS,
          stream: { type: "string", enum: ["out", "error"], description: "PM2 stdout or stderr log." },
          lines: { type: "integer", minimum: 1, maximum: 200, description: "Number of tail lines; default 80." },
        },
        required: ["instance"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "service_health",
      description: "GET the fixed read-only health endpoint for one or all Kronos API instances.",
      parameters: {
        type: "object",
        properties: { instance: { type: "string", enum: ["main", "testnet", "live", "all"] } },
        additionalProperties: false,
      },
    },
  },
];

function positiveInteger(value: string | undefined, fallback: number, cap: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(cap, Math.floor(parsed)) : fallback;
}

export function loadDiagnosticToolConfig(env: NodeJS.ProcessEnv = process.env): DiagnosticToolConfig {
  return {
    enabled: env.CORTEX_CHAT_DIAGNOSTIC_ENABLED === "1",
    roots: {
      main: env.CORTEX_CHAT_ROOT_MAIN ?? "/root/kronos/daily-trading-cockpit-v2",
      testnet: env.CORTEX_CHAT_ROOT_TESTNET ?? "/root/kronos-testnet/daily-trading-cockpit-v2",
      live: env.CORTEX_CHAT_ROOT_LIVE ?? "/root/kronos-live/daily-trading-cockpit-v2",
    },
    logsDir: env.CORTEX_CHAT_PM2_LOG_DIR ?? "/root/.pm2/logs",
    maxFiles: positiveInteger(env.CORTEX_CHAT_MAX_FILES, DEFAULT_MAX_FILES, 10_000),
    maxOutputChars: positiveInteger(env.CORTEX_CHAT_MAX_TOOL_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, 50_000),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function instanceFrom(value: unknown): DiagnosticInstance | null {
  return typeof value === "string" && INSTANCES.includes(value as DiagnosticInstance) ? value as DiagnosticInstance : null;
}

function sensitiveRelativePath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
  if (segments.some((part) => DENIED_SEGMENTS.has(part) || part === ".env" || part.startsWith(".env."))) return true;
  const base = segments.at(-1) ?? "";
  return /^(id_rsa|id_ed25519|credentials|authorized_keys)$/.test(base) || /\.(pem|key|p12|pfx|keystore)$/.test(base);
}

function allowedTextFile(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && ALLOWED_EXTENSIONS.has(lower.slice(dot));
}

function cleanRelativeInput(value: unknown, fallback = "."): string {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || value.length > 500 || value.includes("\0") || isAbsolute(value)) throw new Error("path must be a short repo-relative path");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("path traversal is not allowed");
  if (sensitiveRelativePath(normalized)) throw new Error("sensitive path is not readable");
  return normalized || ".";
}

async function safeResolvedPath(config: DiagnosticToolConfig, instance: DiagnosticInstance, relativeInput: unknown, requireFile?: boolean): Promise<{ root: string; full: string; relative: string }> {
  const requested = cleanRelativeInput(relativeInput);
  const root = await realpath(config.roots[instance]);
  const candidate = resolve(root, requested);
  const full = await realpath(candidate);
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error("resolved path escapes repo root");
  const realRelative = relative(root, full).replaceAll("\\", "/") || ".";
  if (sensitiveRelativePath(realRelative)) throw new Error("sensitive resolved path is not readable");
  const info = await lstat(full);
  if (info.isSymbolicLink()) throw new Error("symbolic links are not readable");
  if (requireFile && !info.isFile()) throw new Error("path is not a file");
  if (!requireFile && !info.isDirectory()) throw new Error("path is not a directory");
  return { root, full, relative: realRelative };
}

function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "[REDACTED_NVIDIA_KEY]")
    .replace(/((?:api[_-]?(?:key|secret)|secret[_-]?key|password|authorization|bearer|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]");
}

function bounded(config: DiagnosticToolConfig, text: string): string {
  const clean = redactSecrets(text);
  if (clean.length <= config.maxOutputChars) return clean;
  return `${clean.slice(0, config.maxOutputChars)}\n...[truncated at ${config.maxOutputChars} chars]`;
}

async function candidateFiles(config: DiagnosticToolConfig, instance: DiagnosticInstance, relativePath: unknown): Promise<{ root: string; files: string[] }> {
  const start = await safeResolvedPath(config, instance, relativePath, false);
  const files: string[] = [];
  const queue = [start.full];
  while (queue.length > 0 && files.length < config.maxFiles) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = resolve(directory, entry.name);
      const rel = relative(start.root, full).replaceAll("\\", "/");
      if (sensitiveRelativePath(rel)) continue;
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && allowedTextFile(rel)) files.push(rel);
      if (files.length >= config.maxFiles) break;
    }
  }
  return { root: start.root, files };
}

function runExec(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && !stdout) {
        rejectPromise(new Error(stderr.trim() || error.message));
        return;
      }
      resolvePromise(stdout || stderr);
    });
  });
}

async function tailFile(path: string, lines: number): Promise<string> {
  const info = await stat(path);
  const bytes = Math.min(info.size, MAX_LOG_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes));
    return buffer.toString("utf8").split("\n").slice(-lines).join("\n");
  } finally {
    await handle.close();
  }
}

const LOG_NAMES: Record<DiagnosticInstance, string> = {
  main: "dtc-api",
  testnet: "dtc-api-testnet",
  live: "dtc-api-live",
};

const HEALTH_PORTS: Record<DiagnosticInstance, number> = { main: 3101, testnet: 3102, live: 3103 };

export interface DiagnosticToolDeps {
  fetchImpl?: typeof fetch;
}

export async function executeDiagnosticTool(
  config: DiagnosticToolConfig,
  name: string,
  rawArgs: unknown,
  deps: DiagnosticToolDeps = {},
): Promise<string> {
  if (!config.enabled) return JSON.stringify({ ok: false, error: "diagnostic tools disabled" });
  const args = asRecord(rawArgs);
  try {
    if (name === "service_health") {
      const requested = args.instance === "all" || args.instance == null ? INSTANCES : [instanceFrom(args.instance)].filter((value): value is DiagnosticInstance => value != null);
      if (requested.length === 0) throw new Error("invalid instance");
      const fetchImpl = deps.fetchImpl ?? fetch;
      const health = await Promise.all(requested.map(async (instance) => {
        try {
          const response = await fetchImpl(`http://127.0.0.1:${HEALTH_PORTS[instance]}/api/health`, { method: "GET", signal: AbortSignal.timeout(3_000) });
          return { instance, ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
        } catch {
          return { instance, ok: false, status: null, body: null };
        }
      }));
      return bounded(config, JSON.stringify({ ok: true, health }));
    }

    const instance = instanceFrom(args.instance);
    if (!instance) throw new Error("invalid instance");
    const root = await realpath(config.roots[instance]);

    if (name === "list_files") {
      const found = await candidateFiles(config, instance, args.path);
      return bounded(config, JSON.stringify({ ok: true, instance, files: found.files.slice(0, 500), scannedCap: config.maxFiles }));
    }

    if (name === "search_code") {
      if (typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 160 || args.query.includes("\0")) throw new Error("query must be 2-160 characters");
      const query = args.query.toLowerCase();
      const found = await candidateFiles(config, instance, args.path);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const path of found.files) {
        const full = resolve(found.root, path);
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;
        const lines = (await readFile(full, "utf8")).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index]!.toLowerCase().includes(query)) matches.push({ path, line: index + 1, text: lines[index]!.trim().slice(0, 500) });
          if (matches.length >= 80) break;
        }
        if (matches.length >= 80) break;
      }
      return bounded(config, JSON.stringify({ ok: true, instance, query: args.query, matches, filesConsidered: found.files.length }));
    }

    if (name === "read_file") {
      const target = await safeResolvedPath(config, instance, args.path, true);
      if (!allowedTextFile(target.relative)) throw new Error("file type is not readable");
      const info = await stat(target.full);
      if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte read limit`);
      const allLines = (await readFile(target.full, "utf8")).split("\n");
      const startLine = typeof args.start_line === "number" && Number.isInteger(args.start_line) ? Math.max(1, args.start_line) : 1;
      const requestedEnd = typeof args.end_line === "number" && Number.isInteger(args.end_line) ? Math.max(startLine, args.end_line) : startLine + 79;
      const endLine = Math.min(allLines.length, requestedEnd, startLine + MAX_READ_LINES - 1);
      const content = allLines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n");
      return bounded(config, JSON.stringify({ ok: true, instance, path: target.relative, startLine, endLine, totalLines: allLines.length, content }));
    }

    if (name === "git_status") {
      const output = await runExec("/usr/bin/git", ["status", "--short", "--untracked-files=all"], root);
      return bounded(config, JSON.stringify({ ok: true, instance, output }));
    }

    if (name === "git_diff") {
      const commandArgs = ["diff", "--no-ext-diff", "--unified=3"];
      if (args.staged === true) commandArgs.push("--cached");
      const requestedPath = args.path != null && args.path !== "" ? cleanRelativeInput(args.path) : null;
      if (!requestedPath) commandArgs.push("--stat");
      commandArgs.push("--");
      if (requestedPath) commandArgs.push(requestedPath);
      const output = await runExec("/usr/bin/git", commandArgs, root);
      return bounded(config, JSON.stringify({ ok: true, instance, staged: args.staged === true, detail: requestedPath != null, output }));
    }

    if (name === "read_service_logs") {
      const stream = args.stream === "error" ? "error" : "out";
      const lines = typeof args.lines === "number" && Number.isInteger(args.lines) ? Math.max(1, Math.min(200, args.lines)) : 80;
      const logPath = resolve(config.logsDir, `${LOG_NAMES[instance]}-${stream}.log`);
      const content = await tailFile(logPath, lines);
      return bounded(config, JSON.stringify({ ok: true, instance, stream, lines, content }));
    }

    throw new Error("unknown diagnostic tool");
  } catch (error) {
    const message = error instanceof Error ? error.message : "diagnostic tool failed";
    return bounded(config, JSON.stringify({ ok: false, error: message }));
  }
}

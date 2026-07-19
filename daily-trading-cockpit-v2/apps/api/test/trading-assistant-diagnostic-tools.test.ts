import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_TOOL_DEFINITIONS,
  executeDiagnosticTool,
  type DiagnosticToolConfig,
} from "../src/lib/trading-assistant-diagnostic-tools.js";

const dirs: string[] = [];
function tempDir(prefix = "diagnostic-tools-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(): { root: string; logs: string; config: DiagnosticToolConfig } {
  const root = tempDir();
  const logs = tempDir("diagnostic-logs-");
  mkdirSync(resolve(root, "apps/api/src"), { recursive: true });
  writeFileSync(resolve(root, "apps/api/src/example.ts"), "const first = 1;\nconst needle = 'safe';\nconst last = 3;\n");
  writeFileSync(resolve(root, ".env"), "NVIDIA_API_KEY=nvapi-should-never-leak\n");
  return {
    root,
    logs,
    config: { enabled: true, roots: { main: root, testnet: root, live: root }, logsDir: logs, maxFiles: 100, maxOutputChars: 10_000 },
  };
}

describe("read-only diagnostic tool boundary", () => {
  it("exposes only explicitly read-only tool names", () => {
    const names = DIAGNOSTIC_TOOL_DEFINITIONS.map((tool) => tool.function.name);
    expect(names).toEqual(["list_files", "search_code", "read_file", "git_status", "git_diff", "read_service_logs", "service_health"]);
    expect(names.join(" ")).not.toMatch(/write|edit|shell|exec|restart|order|arm|close/i);
  });

  it("reads a bounded line range and returns file:line evidence", async () => {
    const { config } = fixture();
    const result = JSON.parse(await executeDiagnosticTool(config, "read_file", { instance: "main", path: "apps/api/src/example.ts", start_line: 2, end_line: 2 }));
    expect(result).toMatchObject({ ok: true, startLine: 2, endLine: 2 });
    expect(result.content).toContain("2: const needle");
    expect(result.content).not.toContain("const first");
  });

  it("blocks env files, traversal, and symlink escapes", async () => {
    const { root, config } = fixture();
    const outside = tempDir("diagnostic-outside-");
    writeFileSync(resolve(outside, "secret.ts"), "export const secret = 'no';\n");
    symlinkSync(resolve(outside, "secret.ts"), resolve(root, "apps/api/src/escape.ts"));
    const envResult = JSON.parse(await executeDiagnosticTool(config, "read_file", { instance: "main", path: ".env" }));
    const traversal = JSON.parse(await executeDiagnosticTool(config, "read_file", { instance: "main", path: "../../etc/passwd" }));
    const symlink = JSON.parse(await executeDiagnosticTool(config, "read_file", { instance: "main", path: "apps/api/src/escape.ts" }));
    expect(envResult.ok).toBe(false);
    expect(traversal.ok).toBe(false);
    expect(symlink.ok).toBe(false);
  });

  it("searches literal text without interpreting regex or shell syntax", async () => {
    const { root, config } = fixture();
    writeFileSync(resolve(root, "apps/api/src/literal.ts"), "const value = '.*; rm -rf /';\n");
    const result = JSON.parse(await executeDiagnosticTool(config, "search_code", { instance: "main", path: "apps/api/src", query: ".*; rm -rf /" }));
    expect(result.ok).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path).toBe("apps/api/src/literal.ts");
  });

  it("redacts likely credentials from fixed PM2 log output", async () => {
    const { logs, config } = fixture();
    writeFileSync(resolve(logs, "dtc-api-live-error.log"), "error api_key=plain-secret\nprovider nvapi-abcdef123\n");
    const serialized = await executeDiagnosticTool(config, "read_service_logs", { instance: "live", stream: "error", lines: 20 });
    expect(serialized).not.toContain("plain-secret");
    expect(serialized).not.toContain("nvapi-abcdef123");
    expect(serialized).toContain("REDACTED");
  });

  it("health tool only calls fixed localhost GET endpoints", async () => {
    const { config } = fixture();
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const result = JSON.parse(await executeDiagnosticTool(config, "service_health", { instance: "all" }, { fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3101/api/health",
      "http://127.0.0.1:3102/api/health",
      "http://127.0.0.1:3103/api/health",
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

/**
 * Trading-assistant chat feature: journal reader, NVIDIA client, context assembler, and route gating. The most
 * important test in this file is the read-only-boundary test — it asserts the context assembler NEVER issues a
 * non-GET request or a request to any path outside the confirmed read-only allowlist, regardless of what the
 * (injected, fake) HTTP responses contain.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readCortexJournalTail } from "../src/lib/cortex-journal-reader.js";
import { _resetNvidiaChatCircuitForTests, loadNvidiaChatConfig, requestChatCompletion, requestChatTurn, type ChatMessage } from "../src/lib/nvidia-chat-client.js";
import { buildTradingAssistantContext } from "../src/lib/trading-assistant-context.js";
import { registerTradingAssistantRoutes, isTradingAssistantEnabled } from "../src/routes/trading-assistant.js";
import { _resetCortexBrainStoreForTests } from "../src/lib/cortex-brain-store.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "trading-assistant-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  _resetCortexBrainStoreForTests();
  _resetNvidiaChatCircuitForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const decisionLine = (at: string, laneId: string, finalPct: number) =>
  JSON.stringify({
    kind: "BRAIN_DECISION",
    at,
    mode: "shadow",
    featureSchemaVersion: 1,
    regimeFamily: "BULLISH_EXPANSION",
    axisScore: 0.5,
    axisSlopePerHour: 0.01,
    portfolioDrawdownPct: 0.02,
    killBudgetUtilization: 0.1,
    killLatched: false,
    posture: "RISK_ON",
    directionStance: "LONG",
    grossG: 1,
    beta: 0,
    liveBeta: 0,
    evaluationBeta: 0.12,
    expectedTiltDeltaR: 0.01,
    evalExpectedTiltDeltaR: 0.02,
    invariantsOk: true,
    invariantViolations: [],
    rationale: `RISK_ON/LONG · beta=0.00 · top: ${laneId} ${finalPct}%`,
    lanes: [{ laneId, archetype: "BREADTH", eligible: true, pWin: 0.55, edgeEstimatePreCap: 0.04, shrunkNetR: 0.04, allocationMagnitude: 0.04, magnitudeCapped: false, staticPct: 20, learnedPct: 22, finalPct, evalFinalPct: finalPct, sizingMult: 1, reason: "eligible", x: new Array(10).fill(0), direction: "LONG", raw: null }],
  });

describe("readCortexJournalTail", () => {
  it("returns [] when no journal file exists", () => {
    expect(readCortexJournalTail(tmp(), 10)).toEqual([]);
  });

  it("parses valid BRAIN_DECISION lines and caps at maxEntries, most-recent last", () => {
    const dir = tmp();
    const lines = [decisionLine("2026-07-14T00:00:00Z", "LANE_A", 10), decisionLine("2026-07-14T01:00:00Z", "LANE_B", 20), decisionLine("2026-07-14T02:00:00Z", "LANE_C", 30)];
    writeFileSync(resolve(dir, "cortex-decision-journal.jsonl"), `${lines.join("\n")}\n`);
    const entries = readCortexJournalTail(dir, 2);
    expect(entries.length).toBe(2);
    expect(entries[entries.length - 1]!.lanes[0]!.laneId).toBe("LANE_C");
  });

  it("skips a torn/corrupt line instead of aborting the whole read", () => {
    const dir = tmp();
    const good = decisionLine("2026-07-14T00:00:00Z", "LANE_A", 10);
    writeFileSync(resolve(dir, "cortex-decision-journal.jsonl"), `${good}\n{"kind":"BRAIN_DECISION","at":"broken`);
    const entries = readCortexJournalTail(dir, 10);
    expect(entries.length).toBe(1);
    expect(entries[0]!.lanes[0]!.laneId).toBe("LANE_A");
  });

  it("falls back to the .1 rotation backup when the main file has fewer than maxEntries", () => {
    const dir = tmp();
    writeFileSync(resolve(dir, "cortex-decision-journal.jsonl"), `${decisionLine("2026-07-14T02:00:00Z", "NEW", 30)}\n`);
    writeFileSync(resolve(dir, "cortex-decision-journal.jsonl.1"), `${decisionLine("2026-07-14T01:00:00Z", "OLD", 20)}\n`);
    const entries = readCortexJournalTail(dir, 5);
    expect(entries.map((e) => e.lanes[0]!.laneId)).toEqual(["OLD", "NEW"]);
  });
});

describe("nvidia-chat-client", () => {
  it("loadNvidiaChatConfig returns null without NVIDIA_API_KEY", () => {
    expect(loadNvidiaChatConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("loadNvidiaChatConfig applies documented defaults when the key is present", () => {
    const cfg = loadNvidiaChatConfig({ NVIDIA_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("meta/llama-3.3-70b-instruct");
    expect(cfg!.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(cfg!.topP).toBe(0.7);
    expect(cfg!.maxTokens).toBe(1024);
  });

  it("rejects a custom provider URL unless it is explicitly allowed", () => {
    expect(loadNvidiaChatConfig({ NVIDIA_API_KEY: "k", CORTEX_CHAT_BASE_URL: "https://attacker.invalid/v1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(loadNvidiaChatConfig({ NVIDIA_API_KEY: "k", CORTEX_CHAT_BASE_URL: "http://integrate.api.nvidia.com/v1", CORTEX_CHAT_ALLOW_CUSTOM_BASE_URL: "1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(loadNvidiaChatConfig({ NVIDIA_API_KEY: "k", CORTEX_CHAT_BASE_URL: "https://trusted-proxy.invalid/v1", CORTEX_CHAT_ALLOW_CUSTOM_BASE_URL: "1" } as NodeJS.ProcessEnv)?.baseUrl).toBe("https://trusted-proxy.invalid/v1");
  });

  it("requestChatCompletion returns the assistant text on a successful response", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { temperature: number; top_p: number; max_tokens: number };
      expect(body).toMatchObject({ temperature: 0.2, top_p: 0.7, max_tokens: 1024 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    });
    const result = await requestChatCompletion({ apiKey: "k", baseUrl: "https://x", model: "m", timeoutMs: 1000, topP: 0.7, maxTokens: 1024 }, [{ role: "user", content: "hi" }] as ChatMessage[], fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, text: "hello" });
  });

  it("requestChatCompletion fails open (ok:false) on a non-OK HTTP status, never throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider-secret-debug-detail", { status: 500 }));
    const result = await requestChatCompletion({ apiKey: "k", baseUrl: "https://x", model: "m", timeoutMs: 1000, topP: 0.7, maxTokens: 1024 }, [], fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "nvidia api returned HTTP 500" });
    expect(JSON.stringify(result)).not.toContain("provider-secret-debug-detail");
  });

  it("requestChatCompletion fails open on a network throw, never propagates the exception", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await requestChatCompletion({ apiKey: "k", baseUrl: "https://x", model: "m", timeoutMs: 1000, topP: 0.7, maxTokens: 1024 }, [], fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });

  it("requestChatTurn parses OpenAI-compatible tool calls and sends tools with auto choice", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown[]; tool_choice?: string; parallel_tool_calls?: boolean };
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(false);
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"instance":"main","path":"package.json"}' } }] } }] }), { status: 200 });
    });
    const result = await requestChatTurn(
      { apiKey: "k", baseUrl: "https://x", model: "m", timeoutMs: 1000, topP: 0.7, maxTokens: 1024 },
      [{ role: "user", content: "inspect" }],
      [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.tool_calls?.[0]?.function.name).toBe("read_file");
  });

  it("falls back after a retryable primary failure and keeps the fallback circuit open", async () => {
    const models: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "primary") return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "fallback answer" } }] }), { status: 200 });
    });
    const config = {
      apiKey: "k",
      baseUrl: "https://x",
      model: "primary",
      fallbackModel: "fallback",
      primaryTimeoutMs: 100,
      fallbackCooldownMs: 60_000,
      timeoutMs: 1000,
      topP: 0.7,
      maxTokens: 1024,
    };
    const first = await requestChatTurn(config, [{ role: "user", content: "hi" }], undefined, fetchImpl as unknown as typeof fetch);
    const second = await requestChatTurn(config, [{ role: "user", content: "again" }], undefined, fetchImpl as unknown as typeof fetch);
    expect(first.ok && first.model).toBe("fallback");
    expect(second.ok && second.model).toBe("fallback");
    expect(models).toEqual(["primary", "fallback", "fallback"]);
  });

  it("does not fall back on authentication or request errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await requestChatTurn(
      { apiKey: "k", baseUrl: "https://x", model: "primary", fallbackModel: "fallback", timeoutMs: 1000, topP: 0.7, maxTokens: 1024 },
      [{ role: "user", content: "hi" }],
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, reason: "nvidia api returned HTTP 401" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("buildTradingAssistantContext", () => {
  it("reports cortexAvailable=false with no journal file, and liveAvailable=false when the peer is unreachable", async () => {
    const dir = tmp();
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const ctx = await buildTradingAssistantContext({ dataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(ctx.cortexAvailable).toBe(false);
    expect(ctx.liveAvailable).toBe(false);
    expect(ctx.contextText).toContain("No CORTEX decision data available");
    expect(ctx.contextText).toContain("Could not reach the live/mainnet instance");
  });

  it("includes the latest CORTEX decision + learned-model summary when a journal is present", async () => {
    const dir = tmp();
    writeFileSync(resolve(dir, "cortex-decision-journal.jsonl"), `${decisionLine("2026-07-14T00:00:00Z", "CG_WIDE_FAST_LONG", 22.5)}\n`);
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const ctx = await buildTradingAssistantContext({ dataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(ctx.cortexAvailable).toBe(true);
    expect(ctx.contextText).toContain("CG_WIDE_FAST_LONG");
    expect(ctx.contextText).toContain("RISK_ON");
  });

  it("includes live/mainnet account data when the peer responds successfully", async () => {
    const dir = tmp();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/live/account")) {
        return new Response(JSON.stringify({ ok: true, accountEquity: 279.4, walletBalance: 279.4, unrealizedPnl: 0, openPositionCount: 1, positions: [{ symbol: "ETHUSDT", direction: "LONG", unrealizedPnl: 3.2, laneIds: ["CG_WIDE_STOP_TP_WIDE"] }], closedLanes: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, walletBalance: 279.4, availableBalance: 279.4 }), { status: 200 });
    });
    const ctx = await buildTradingAssistantContext({ dataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(ctx.liveAvailable).toBe(true);
    expect(ctx.contextText).toContain("ETHUSDT");
    expect(ctx.contextText).toContain("279.40");
  });

  it("survives malformed numeric and array fields from the live peer without inventing zeroes", async () => {
    const dir = tmp();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (input.toString().endsWith("/api/live/account")) {
        return new Response(JSON.stringify({ ok: true, accountEquity: "bad", walletBalance: null, unrealizedPnl: null, openPositionCount: "bad", positions: [null], closedLanes: [null] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const ctx = await buildTradingAssistantContext({ dataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(ctx.liveAvailable).toBe(true);
    expect(ctx.contextText).toContain("Equity=$n/a");
    expect(ctx.contextText).toContain("openPositions=n/a");
  });

  // [FRESHNESS-FIX] 2026-07-20: wallet-reconciliation's report forces withinTolerance=true (and
  // deltaUsd=0) whenever internalLedgerFresh is false — i.e. no comparison actually happened (see
  // wallet-reconciliation.ts's !internalLedgerFresh branch). Before this fix, the context text only
  // read r.withinTolerance, so this "not verified" state rendered identically to "within tolerance"
  // — an operator reading the assistant's answer could not tell a genuinely healthy day from one the
  // check never actually ran on.
  it("[FRESHNESS-FIX] renders a distinct NOT VERIFIED status when internalLedgerFresh=false, instead of 'within tolerance'", async () => {
    const dir = tmp();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (input.toString().endsWith("/api/live/wallet-reconciliation")) {
        return new Response(
          JSON.stringify({
            ok: true,
            report: {
              dayUtc: "2026-07-10",
              internalRealizedPnlUsd: 0,
              comparisonExchangeUsd: 999,
              deltaUsd: 0,
              withinTolerance: true,
              internalLedgerFresh: false,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const ctx = await buildTradingAssistantContext({ dataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(ctx.contextText).toContain("NOT VERIFIED");
    expect(ctx.contextText).not.toContain("(within tolerance)");
  });

  it("SAFETY: never issues a non-GET request, and only ever to the confirmed read-only allowlist paths", async () => {
    const dir = tmp();
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await buildTradingAssistantContext({ dataDir: dir, livePeerBaseUrl: "http://127.0.0.1:3103", fetchImpl: fetchImpl as unknown as typeof fetch, peerTimeoutMs: 100 });
    expect(calls.length).toBeGreaterThan(0);
    const allowlist = ["http://127.0.0.1:3103/api/live/account", "http://127.0.0.1:3103/api/live/balance", "http://127.0.0.1:3103/api/live/wallet-reconciliation"];
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(allowlist).toContain(call.url);
    }
  });
});

describe("isTradingAssistantEnabled", () => {
  it("is false by default", () => {
    expect(isTradingAssistantEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is true only when explicitly set to \"1\"", () => {
    expect(isTradingAssistantEnabled({ CORTEX_CHAT_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTradingAssistantEnabled({ CORTEX_CHAT_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("POST /api/trading-assistant/ask route gating", () => {
  function stubSuccessfulAssistantFetch(onMessages?: (messages: ChatMessage[]) => void): void {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
        onMessages?.(body.messages);
        return new Response(JSON.stringify({ choices: [{ message: { content: "safe answer" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  }

  it("returns 503 disabled when CORTEX_CHAT_ENABLED is unset, without touching the network", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "0");
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const res = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    await app.close();
  });

  it("returns 503 when enabled but NVIDIA_API_KEY is missing", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "");
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const res = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("rejects an empty question with 400", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const res = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /status reports enabled only when both flag and key are present", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const res = await app.inject({ method: "GET", url: "/api/trading-assistant/status" });
    expect(res.json()).toEqual({ enabled: true, model: "meta/llama-3.3-70b-instruct", fallbackModel: null, diagnosticEnabled: false, reason: null });
    await app.close();
  });

  it("deduplicates the current question and stores only a hash in the audit log", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    const secretQuestion = "why is this lane blocked secret-value-123";
    let sentMessages: ChatMessage[] = [];
    stubSuccessfulAssistantFetch((messages) => { sentMessages = messages; });
    const dataDir = tmp();
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-assistant/ask",
      payload: { question: secretQuestion, history: [{ role: "assistant", content: "prior" }, { role: "user", content: secretQuestion }] },
    });
    expect(res.statusCode).toBe(200);
    expect(sentMessages.filter((message) => message.role === "user" && message.content === secretQuestion)).toHaveLength(1);
    const audit = readFileSync(resolve(dataDir, "trading-assistant-log.jsonl"), "utf8");
    expect(audit).not.toContain(secretQuestion);
    expect(audit).not.toContain("secret-value-123");
    expect(JSON.parse(audit).questionHash).toMatch(/^[a-f0-9]{16}$/);
    await app.close();
  });

  it("rate-limits repeated assistant calls per client", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    vi.stubEnv("CORTEX_CHAT_RATE_LIMIT_PER_MINUTE", "1");
    stubSuccessfulAssistantFetch();
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const first = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "first" } });
    const second = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "second" } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("uses CORTEX_CHAT_DATA_DIR when the dashboard instance has no local CORTEX journal", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    const cortexDataDir = tmp();
    vi.stubEnv("CORTEX_CHAT_DATA_DIR", cortexDataDir);
    writeFileSync(resolve(cortexDataDir, "cortex-decision-journal.jsonl"), `${decisionLine("2026-07-15T00:00:00Z", "REMOTE_CORTEX_LANE", 25)}\n`);
    stubSuccessfulAssistantFetch();
    const app = Fastify();
    await registerTradingAssistantRoutes(app);
    const res = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "status cortex" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().cortexAvailable).toBe(true);
    await app.close();
  });

  it("executes an allowlisted diagnostic tool loop and reports which tool was actually used", async () => {
    vi.stubEnv("CORTEX_CHAT_ENABLED", "1");
    vi.stubEnv("NVIDIA_API_KEY", "k");
    vi.stubEnv("CORTEX_CHAT_DIAGNOSTIC_ENABLED", "1");
    const root = tmp();
    mkdirSync(resolve(root, "apps/api/src"), { recursive: true });
    writeFileSync(resolve(root, "apps/api/src/example.ts"), "export const checked = true;\n");
    vi.stubEnv("CORTEX_CHAT_ROOT_MAIN", root);
    vi.stubEnv("CORTEX_CHAT_ROOT_TESTNET", root);
    vi.stubEnv("CORTEX_CHAT_ROOT_LIVE", root);
    let chatCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/chat/completions")) {
        chatCalls += 1;
        const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; tools?: unknown[] };
        expect(body.tools?.length).toBeGreaterThan(0);
        if (chatCalls === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_read", type: "function", function: { name: "read_file", arguments: '{"instance":"main","path":"apps/api/src/example.ts","start_line":1,"end_line":5}' } }] } }] }), { status: 200 });
        }
        expect(body.messages.some((message) => message.role === "tool" && message.content.includes("checked"))).toBe(true);
        return new Response(JSON.stringify({ choices: [{ message: { content: "Verified from apps/api/src/example.ts:1." } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const app = Fastify();
    await registerTradingAssistantRoutes(app, { dataDir: tmp() });
    const res = await app.inject({ method: "POST", url: "/api/trading-assistant/ask", payload: { question: "cek bug example" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, diagnosticEnabled: true, toolsUsed: ["read_file"] });
    expect(chatCalls).toBe(2);
    await app.close();
  });
});

/**
 * Thin OpenAI-compatible chat-completion client for NVIDIA's NIM API catalog (build.nvidia.com), used by the
 * trading-assistant chat feature. Tool calling is optional: the model may request one of the explicitly supplied
 * tool definitions, but the application remains the sole executor and can reject every call. There is no generic
 * shell/network bridge. `fetchImpl` is injected so tests never hit the network.
 */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ChatMessage = {
  role: "system" | "user";
  content: string;
} | {
  role: "assistant";
  content: string | null;
  tool_calls?: ChatToolCall[];
} | {
  role: "tool";
  content: string;
  tool_call_id: string;
  name?: string;
};

export interface NvidiaChatConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  topP: number;
  maxTokens: number;
  fallbackModel?: string;
  primaryTimeoutMs?: number;
  fallbackCooldownMs?: number;
}

const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const providerCircuitOpenUntil = new Map<string, number>();

function resolveBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const requested = (env.CORTEX_CHAT_BASE_URL || DEFAULT_NVIDIA_BASE_URL).replace(/\/+$/, "");
  try {
    const url = new URL(requested);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "integrate.api.nvidia.com" && env.CORTEX_CHAT_ALLOW_CUSTOM_BASE_URL !== "1") return null;
    return requested;
  } catch {
    return null;
  }
}

export function loadNvidiaChatConfig(env: NodeJS.ProcessEnv = process.env): NvidiaChatConfig | null {
  const apiKey = env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) return null;
  const timeoutMs = Number(env.CORTEX_CHAT_TIMEOUT_MS) > 0 ? Number(env.CORTEX_CHAT_TIMEOUT_MS) : 20_000;
  const fallbackModel = env.CORTEX_CHAT_FALLBACK_MODEL?.trim() || undefined;
  return {
    apiKey,
    baseUrl,
    model: env.CORTEX_CHAT_MODEL || "meta/llama-3.3-70b-instruct",
    timeoutMs,
    topP: Number(env.CORTEX_CHAT_TOP_P) > 0 && Number(env.CORTEX_CHAT_TOP_P) <= 1 ? Number(env.CORTEX_CHAT_TOP_P) : 0.7,
    maxTokens: Number(env.CORTEX_CHAT_MAX_TOKENS) > 0 ? Math.min(4096, Math.floor(Number(env.CORTEX_CHAT_MAX_TOKENS))) : 1024,
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(fallbackModel
      ? {
          primaryTimeoutMs: Math.max(1_000, Math.min(timeoutMs, Number(env.CORTEX_CHAT_PRIMARY_TIMEOUT_MS) || 8_000)),
          fallbackCooldownMs: Math.max(10_000, Math.min(3_600_000, Number(env.CORTEX_CHAT_FALLBACK_COOLDOWN_MS) || 600_000)),
        }
      : {}),
  };
}

export type ChatCompletionResult = { ok: true; text: string } | { ok: false; reason: string };
export type ChatTurnResult = {
  ok: true;
  message: Extract<ChatMessage, { role: "assistant" }>;
  model: string;
} | { ok: false; reason: string };

async function requestModelTurn(
  config: NvidiaChatConfig,
  model: string,
  timeoutMs: number,
  messages: ChatMessage[],
  tools?: ChatToolDefinition[],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        top_p: config.topP,
        max_tokens: config.maxTokens,
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `nvidia api returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] };
    const raw = json.choices?.[0]?.message;
    const content = typeof raw?.content === "string" ? raw.content : null;
    const toolCalls = Array.isArray(raw?.tool_calls)
      ? raw.tool_calls
          .filter((call): call is Record<string, unknown> => call != null && typeof call === "object")
          .map((call, index): ChatToolCall | null => {
            const fn = call.function;
            if (fn == null || typeof fn !== "object") return null;
            const name = (fn as Record<string, unknown>).name;
            const args = (fn as Record<string, unknown>).arguments;
            if (typeof name !== "string" || typeof args !== "string") return null;
            const id = typeof call.id === "string" && call.id.length > 0 ? call.id.slice(0, 160) : `tool_call_${index}`;
            return { id, type: "function", function: { name: name.slice(0, 100), arguments: args.slice(0, 10_000) } };
          })
          .filter((call): call is ChatToolCall => call != null)
      : [];
    if ((!content || content.trim().length === 0) && toolCalls.length === 0) return { ok: false, reason: "empty completion" };
    return { ok: true, model, message: { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) } };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "nvidia api request timed out" : "nvidia api request failed";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

function retryableProviderFailure(result: ChatTurnResult): boolean {
  if (result.ok) return false;
  return result.reason === "nvidia api request timed out" ||
    result.reason === "nvidia api request failed" ||
    /^nvidia api returned HTTP (429|5\d\d)$/.test(result.reason);
}

export async function requestChatTurn(
  config: NvidiaChatConfig,
  messages: ChatMessage[],
  tools?: ChatToolDefinition[],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnResult> {
  const fallbackModel = config.fallbackModel?.trim();
  if (!fallbackModel || fallbackModel === config.model) {
    return requestModelTurn(config, config.model, config.timeoutMs, messages, tools, fetchImpl);
  }

  const circuitKey = `${config.baseUrl}|${config.model}`;
  const now = Date.now();
  if ((providerCircuitOpenUntil.get(circuitKey) ?? 0) > now) {
    return requestModelTurn(config, fallbackModel, config.timeoutMs, messages, tools, fetchImpl);
  }

  const primary = await requestModelTurn(
    config,
    config.model,
    config.primaryTimeoutMs ?? Math.min(config.timeoutMs, 8_000),
    messages,
    tools,
    fetchImpl,
  );
  if (primary.ok || !retryableProviderFailure(primary)) return primary;

  providerCircuitOpenUntil.set(circuitKey, now + (config.fallbackCooldownMs ?? 600_000));
  return requestModelTurn(config, fallbackModel, config.timeoutMs, messages, tools, fetchImpl);
}

export function _resetNvidiaChatCircuitForTests(): void {
  providerCircuitOpenUntil.clear();
}

export async function requestChatCompletion(
  config: NvidiaChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatCompletionResult> {
  const result = await requestChatTurn(config, messages, undefined, fetchImpl);
  if (!result.ok) return result;
  const text = result.message.content;
  return typeof text === "string" && text.trim().length > 0 ? { ok: true, text } : { ok: false, reason: "empty completion" };
}

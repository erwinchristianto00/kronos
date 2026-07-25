import { describe, it, expect, afterEach } from "vitest";
import type { ConflictIntensity } from "../src/lib/geopolitical-conflict-feed.js";
import type { GdeltEvent } from "../src/lib/geopolitical-conflict-feed.js";
import {
  computeEscalationScore,
  requestLlmCorroboration,
  classifyEscalation,
  DEFAULT_ESCALATION_SCORE_PARAMS,
  ESCALATION_LLM_CONFIDENCE_WEIGHT,
  ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS,
  GEOPOLITICAL_ESCALATION_LLM_ENABLED_FLAG,
  type LlmCorroborationResult,
} from "../src/lib/geopolitical-escalation-classifier.js";
import type { NvidiaChatConfig } from "../src/lib/nvidia-chat-client.js";

function intensity(overrides: Partial<ConflictIntensity> = {}): ConflictIntensity {
  return {
    eventCount: 0,
    meanGoldstein: null,
    highSeverityCount: 0,
    windowMs: 24 * 3_600_000,
    ...overrides,
  };
}

function ev(overrides: Partial<GdeltEvent> = {}): GdeltEvent {
  return {
    id: `evt-${Math.random()}`,
    dateMs: 1_700_000_000_000,
    cameoCode: "193",
    goldsteinScale: -8,
    actor1: "IRAN",
    actor2: "ISRAEL",
    sourceUrl: "https://example.com/a",
    title: "Iran strikes Israeli position",
    numMentions: 5,
    isHighSeverity: true,
    ...overrides,
  };
}

const NVIDIA_CONFIG: NvidiaChatConfig = {
  apiKey: "test-key",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  model: "meta/llama-3.3-70b-instruct",
  timeoutMs: 5_000,
  topP: 0.7,
  maxTokens: 512,
};

function mockResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function chatCompletionBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

const ENABLED_ENV = { [GEOPOLITICAL_ESCALATION_LLM_ENABLED_FLAG]: "1" } as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  // nothing persisted by this module — no store to reset.
});

// ── computeEscalationScore: exact threshold behavior ────────────────────────

describe("computeEscalationScore", () => {
  it("returns 0 for a fully quiet window (no events, no goldstein, no high-severity)", () => {
    const result = computeEscalationScore(intensity());
    expect(result.score).toBe(0);
    expect(result.eventCountPoints).toBe(0);
    expect(result.highSeverityPoints).toBe(0);
    expect(result.goldsteinPoints).toBe(0);
  });

  it("saturates eventCountPoints at eventCountWeight when eventCount >= eventCountSaturation", () => {
    const atSaturation = computeEscalationScore(intensity({ eventCount: DEFAULT_ESCALATION_SCORE_PARAMS.eventCountSaturation }));
    expect(atSaturation.eventCountPoints).toBe(DEFAULT_ESCALATION_SCORE_PARAMS.eventCountWeight);

    const overSaturation = computeEscalationScore(intensity({ eventCount: DEFAULT_ESCALATION_SCORE_PARAMS.eventCountSaturation * 5 }));
    expect(overSaturation.eventCountPoints).toBe(DEFAULT_ESCALATION_SCORE_PARAMS.eventCountWeight);
  });

  it("scales eventCountPoints linearly below saturation", () => {
    const half = DEFAULT_ESCALATION_SCORE_PARAMS.eventCountSaturation / 2;
    const result = computeEscalationScore(intensity({ eventCount: half }));
    expect(result.eventCountPoints).toBeCloseTo(DEFAULT_ESCALATION_SCORE_PARAMS.eventCountWeight / 2, 6);
  });

  it("saturates highSeverityPoints at highSeverityWeight when highSeverityCount >= saturation", () => {
    const result = computeEscalationScore(intensity({ highSeverityCount: DEFAULT_ESCALATION_SCORE_PARAMS.highSeveritySaturation }));
    expect(result.highSeverityPoints).toBe(DEFAULT_ESCALATION_SCORE_PARAMS.highSeverityWeight);
  });

  it("gives full goldsteinPoints at the Goldstein floor (most conflictual) and 0 at/above neutral", () => {
    const worst = computeEscalationScore(intensity({ meanGoldstein: DEFAULT_ESCALATION_SCORE_PARAMS.goldsteinFloor }));
    expect(worst.goldsteinPoints).toBe(DEFAULT_ESCALATION_SCORE_PARAMS.goldsteinWeight);

    const neutral = computeEscalationScore(intensity({ meanGoldstein: 0 }));
    expect(neutral.goldsteinPoints).toBe(0);

    const cooperative = computeEscalationScore(intensity({ meanGoldstein: 10 }));
    expect(cooperative.goldsteinPoints).toBe(0);
  });

  it("scales goldsteinPoints linearly between neutral and the floor", () => {
    const halfway = DEFAULT_ESCALATION_SCORE_PARAMS.goldsteinFloor / 2; // e.g. -5 when floor is -10
    const result = computeEscalationScore(intensity({ meanGoldstein: halfway }));
    expect(result.goldsteinPoints).toBeCloseTo(DEFAULT_ESCALATION_SCORE_PARAMS.goldsteinWeight / 2, 6);
  });

  it("treats meanGoldstein=null as 0 points — NEVER fabricated as maximal conflict", () => {
    const result = computeEscalationScore(intensity({ meanGoldstein: null, eventCount: 50, highSeverityCount: 50 }));
    expect(result.goldsteinPoints).toBe(0);
    // full marks on the other two components + 0 on goldstein == exactly weight sum minus goldsteinWeight
    expect(result.score).toBe(DEFAULT_ESCALATION_SCORE_PARAMS.eventCountWeight + DEFAULT_ESCALATION_SCORE_PARAMS.highSeverityWeight);
  });

  it("reaches exactly 100 when every component is fully saturated at its worst value", () => {
    const result = computeEscalationScore(
      intensity({
        eventCount: DEFAULT_ESCALATION_SCORE_PARAMS.eventCountSaturation * 2,
        highSeverityCount: DEFAULT_ESCALATION_SCORE_PARAMS.highSeveritySaturation * 2,
        meanGoldstein: DEFAULT_ESCALATION_SCORE_PARAMS.goldsteinFloor,
      }),
    );
    expect(result.score).toBe(100);
  });

  it("defensively floors non-finite/negative eventCount and highSeverityCount to 0 rather than propagating garbage", () => {
    const result = computeEscalationScore(intensity({ eventCount: -5, highSeverityCount: Number.NaN }));
    expect(result.eventCountPoints).toBe(0);
    expect(result.highSeverityPoints).toBe(0);
  });

  it("always returns a non-empty reasoning trail with one line per component", () => {
    const result = computeEscalationScore(intensity());
    expect(result.reasoning.length).toBe(3);
    for (const line of result.reasoning) expect(typeof line).toBe("string");
  });

  it("is pure: calling it twice with the same input returns the same score", () => {
    const input = intensity({ eventCount: 7, highSeverityCount: 3, meanGoldstein: -4 });
    const a = computeEscalationScore(input);
    const b = computeEscalationScore(input);
    expect(a.score).toBe(b.score);
  });
});

// ── requestLlmCorroboration: default-off gate + fail-open behavior ──────────

describe("requestLlmCorroboration", () => {
  it("returns LLM_UNAVAILABLE WITHOUT calling fetchImpl when the enable flag is unset (default-off action gate)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return mockResponse(chatCompletionBody(JSON.stringify({ severity: 90, reasoning: "x", confidence: "high" })));
    }) as unknown as typeof fetch;

    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    if (!result.ok) expect(result.reason).toContain("LLM_UNAVAILABLE");
  });

  it("returns LLM_UNAVAILABLE when enabled but no nvidiaConfig is supplied", async () => {
    const result = await requestLlmCorroboration([ev()], null, { env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("returns LLM_UNAVAILABLE when enabled but no events are supplied", async () => {
    const result = await requestLlmCorroboration([], NVIDIA_CONFIG, { env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("parses a valid strict-JSON response into ok:true with severity/reasoning/confidence", async () => {
    const fetchImpl = (async () =>
      mockResponse(chatCompletionBody(JSON.stringify({ severity: 72, reasoning: "Multiple strikes reported.", confidence: "medium" })))) as unknown as typeof fetch;

    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.severity).toBe(72);
      expect(result.confidence).toBe("medium");
      expect(result.reasoning).toContain("strikes");
    }
  });

  it("tolerates a response wrapped in a markdown code fence", async () => {
    const fenced = "```json\n" + JSON.stringify({ severity: 40, reasoning: "ok", confidence: "low" }) + "\n```";
    const fetchImpl = (async () => mockResponse(chatCompletionBody(fenced))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(true);
  });

  it("fails open to LLM_UNAVAILABLE when fetchImpl throws (network error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE when the request times out (AbortError)", async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const fastTimeoutConfig: NvidiaChatConfig = { ...NVIDIA_CONFIG, timeoutMs: 10 };
    const result = await requestLlmCorroboration([ev()], fastTimeoutConfig, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("LLM_UNAVAILABLE");
  }, 10_000);

  it("fails open to LLM_UNAVAILABLE on malformed JSON content", async () => {
    const fetchImpl = (async () => mockResponse(chatCompletionBody("this is not json at all"))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE on out-of-range severity", async () => {
    const fetchImpl = (async () =>
      mockResponse(chatCompletionBody(JSON.stringify({ severity: 150, reasoning: "too high", confidence: "high" })))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE on negative severity", async () => {
    const fetchImpl = (async () =>
      mockResponse(chatCompletionBody(JSON.stringify({ severity: -5, reasoning: "negative", confidence: "high" })))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE when confidence is missing", async () => {
    const fetchImpl = (async () => mockResponse(chatCompletionBody(JSON.stringify({ severity: 50, reasoning: "ok" })))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE when confidence has an invalid value", async () => {
    const fetchImpl = (async () =>
      mockResponse(chatCompletionBody(JSON.stringify({ severity: 50, reasoning: "ok", confidence: "extreme" })))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE when reasoning is missing or empty", async () => {
    const fetchImpl = (async () => mockResponse(chatCompletionBody(JSON.stringify({ severity: 50, reasoning: "", confidence: "low" })))) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });

  it("fails open to LLM_UNAVAILABLE on a non-2xx HTTP response", async () => {
    const fetchImpl = (async () => mockResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch;
    const result = await requestLlmCorroboration([ev()], NVIDIA_CONFIG, { fetchImpl, env: ENABLED_ENV });
    expect(result.ok).toBe(false);
  });
});

// ── classifyEscalation: combination rule + the critical safety invariant ────

describe("classifyEscalation", () => {
  it("falls back to quantitative-only when llmResult is null (no corroboration attempted)", () => {
    const quant = computeEscalationScore(intensity({ eventCount: 10, highSeverityCount: 2 }));
    const result = classifyEscalation(intensity({ eventCount: 10, highSeverityCount: 2 }), null);
    expect(result.llmAvailable).toBe(false);
    expect(result.llmSeverity).toBeNull();
    expect(result.finalScore).toBe(quant.score);
    expect(result.quantitativeScore).toBe(quant.score);
  });

  it("falls back to quantitative-only when llmResult is a failure (ok:false) — never inflated", () => {
    const ci = intensity({ eventCount: 5, highSeverityCount: 1, meanGoldstein: -3 });
    const quant = computeEscalationScore(ci);
    const failure: LlmCorroborationResult = { ok: false, reason: "LLM_UNAVAILABLE: network error" };
    const result = classifyEscalation(ci, failure);
    expect(result.llmAvailable).toBe(false);
    expect(result.finalScore).toBe(quant.score);
  });

  it("never raises finalScore above quantitativeScore even when the LLM reports a much higher severity", () => {
    // Low quantitative signal (quiet window) but a hypothetical/malicious LLM response claiming max severity.
    const ci = intensity({ eventCount: 1, highSeverityCount: 0, meanGoldstein: 2 });
    const quant = computeEscalationScore(ci);
    const highLlm: LlmCorroborationResult = { ok: true, severity: 100, reasoning: "claims catastrophic escalation", confidence: "high" };
    const result = classifyEscalation(ci, highLlm);
    expect(result.llmAvailable).toBe(true);
    expect(result.llmSeverity).toBe(100);
    // THE critical invariant: finalScore must equal the quantitative ceiling, never the LLM's higher number.
    expect(result.finalScore).toBe(quant.score);
    expect(result.finalScore).toBeLessThanOrEqual(quant.score);
  });

  it("lowers finalScore, confidence-weighted and capped, when the LLM reads LESS severe than quantitative", () => {
    const ci = intensity({ eventCount: 20, highSeverityCount: 10, meanGoldstein: -10 }); // quant = 100
    const quant = computeEscalationScore(ci);
    const lowLlm: LlmCorroborationResult = { ok: true, severity: 0, reasoning: "text reads as posturing, not action", confidence: "high" };
    const result = classifyEscalation(ci, lowLlm);
    expect(result.finalScore).toBeLessThan(quant.score);
    // capped: quant(100) - min(cap, gap*weight) = 100 - min(20, 100*1.0) = 80
    expect(result.finalScore).toBe(quant.score - ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS);
  });

  it("applies a smaller downweight for lower LLM confidence given the same disagreement gap", () => {
    const ci = intensity({ eventCount: 20, highSeverityCount: 10, meanGoldstein: -10 }); // quant = 100
    const quant = computeEscalationScore(ci);
    const gap = quant.score - 50; // llmSeverity = 50
    const lowConfLlm: LlmCorroborationResult = { ok: true, severity: 50, reasoning: "uncertain", confidence: "low" };
    const result = classifyEscalation(ci, lowConfLlm);
    const expectedDownweight = Math.min(ESCALATION_LLM_MAX_DOWNWEIGHT_POINTS, gap * ESCALATION_LLM_CONFIDENCE_WEIGHT.low);
    expect(result.finalScore).toBeCloseTo(quant.score - expectedDownweight, 6);
    expect(expectedDownweight).toBeLessThan(gap); // low confidence never fully applies the raw gap
  });

  it("never lets finalScore go below 0 even with an extreme downweight", () => {
    const ci = intensity({ eventCount: 1, highSeverityCount: 0, meanGoldstein: 1 }); // small quant score
    const lowLlm: LlmCorroborationResult = { ok: true, severity: 0, reasoning: "nothing here", confidence: "high" };
    const result = classifyEscalation(ci, lowLlm);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
  });

  it("leaves finalScore unchanged when the LLM severity exactly equals the quantitative score", () => {
    const ci = intensity({ eventCount: 10, highSeverityCount: 2 });
    const quant = computeEscalationScore(ci);
    const equalLlm: LlmCorroborationResult = { ok: true, severity: quant.score, reasoning: "agrees", confidence: "medium" };
    const result = classifyEscalation(ci, equalLlm);
    expect(result.finalScore).toBe(quant.score);
  });

  it("always returns a non-empty, inspectable reasoning trail", () => {
    const ci = intensity({ eventCount: 3 });
    const result = classifyEscalation(ci, null);
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.reasoning.some((line) => line.toLowerCase().includes("quantitative"))).toBe(true);
  });

  // ── fail-without/pass-with regression: the whole point of this module ─────
  it("REGRESSION: an LLM failure must never be treated as evidence of escalation — " +
    "this test fails if a future change lets the LLM-failure branch default to a high severity number", () => {
    const quietWindow = intensity({ eventCount: 0, highSeverityCount: 0, meanGoldstein: null });
    const quant = computeEscalationScore(quietWindow);
    expect(quant.score).toBe(0); // sanity: a fully quiet window scores 0

    const failureModes: (LlmCorroborationResult | null)[] = [
      null,
      { ok: false, reason: "LLM_UNAVAILABLE: nvidia api request timed out" },
      { ok: false, reason: "LLM_UNAVAILABLE: malformed JSON response" },
      { ok: false, reason: "LLM_UNAVAILABLE: nvidia api returned HTTP 500" },
    ];

    for (const failure of failureModes) {
      const result = classifyEscalation(quietWindow, failure);
      // A BUGGY implementation might do `const llmSeverity = llmResult?.severity ?? 100` (defaulting a
      // missing/failed read to a high number "just in case"). That bug would make finalScore jump to
      // a nonzero/high value here. The correct, safe behavior keeps it pinned at the quantitative 0.
      expect(result.finalScore).toBe(0);
      expect(result.llmAvailable).toBe(false);
    }
  });
});

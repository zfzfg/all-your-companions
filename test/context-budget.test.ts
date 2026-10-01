import { describe, expect, it } from "vitest";
import { checkContextBudget, contextTokens, contextUsed, effectiveContextWindow, estimateContextPrompt,
  mergeContextObservation, type ContextObservation } from "../src/context-budget";
import { parseContextCatalog } from "../src/context-catalog";
import { contextWindowForClaudeModel, normalizeClaudeUpdate } from "../src/claude-backend";
import { contextWindowForModel, normalizeGeminiUpdate, parseAgyModelsOutput } from "../src/gemini-backend";
import { MuseBackend } from "../src/muse-backend";

const now = Date.parse("2026-09-30T12:00:00Z");
function observation(overrides: Partial<ContextObservation> = {}): ContextObservation {
  return { provider: "grok", access: "account-a", modelId: "grok-4.7", sessionId: "s1", generation: 1,
    source: "catalog", observedAt: now, limitQuality: "verified", usageQuality: "verified",
    limits: { contextWindow: 256000, outputReserve: 8000 }, used: 1000, ...overrides };
}

describe("context source resolution", () => {
  it("accepts a real native 500000 window and preserves it over catalog refresh", () => {
    const live = observation({ source: "session", limits: { contextWindow: 500000 } });
    const resolved = mergeContextObservation(observation(), live);
    expect(resolved.limits.contextWindow).toBe(500000);
    expect(mergeContextObservation(resolved, observation()).limits.contextWindow).toBe(500000);
  });
  it("ignores older usage independently of the limit source", () => {
    const previous = observation({ usageObservedAt: now, used: 100 });
    const incoming = observation({ usageObservedAt: now - 1, used: 900 });
    expect(mergeContextObservation(previous, incoming).used).toBe(100);
  });
  it("keeps the CLI's 256000 budget rather than adopting the public API's 500000", () => {
    const resolved = mergeContextObservation(observation(), observation({ source: "documented", limitQuality: "estimated",
      limits: { contextWindow: 500000 }, used: undefined }));
    expect(effectiveContextWindow(resolved.limits)).toBe(256000);
    expect(resolved.used).toBe(1000);
  });
  it("lets a live session override its catalog, including with a smaller window", () => {
    const live = observation({ source: "session", limits: { contextWindow: 200000 } });
    expect(mergeContextObservation(observation(), live).limits.contextWindow).toBe(200000);
    expect(mergeContextObservation(live, observation()).limits.contextWindow).toBe(200000);
  });
  it("does not promote a catalog limit just because native usage arrived", () => {
    const result = mergeContextObservation(observation(), observation({ source: "session", limits: {},
      limitQuality: "unknown", used: 0 }));
    expect(result.source).toBe("catalog");
    expect(result.used).toBe(0);
  });
  it.each(["access", "modelId", "sessionId", "generation"] as const)("does not carry usage across a changed %s", key => {
    const next = observation({ [key]: key === "generation" ? 2 : "different", used: undefined, limits: {} });
    expect(mergeContextObservation(observation(), next).used).toBeUndefined();
  });
  it.each([NaN, Infinity, 0, -1, 1.5, "256000"])("rejects invalid limits %s", invalid => {
    expect(contextTokens(invalid)).toBeUndefined();
  });
  it("accepts zero usage and shows usage above the limit unchanged", () => {
    expect(contextUsed(0)).toBe(0);
    expect(mergeContextObservation(observation(), observation({ used: 300000 })).used).toBe(300000);
  });
});

describe("native catalog parsing", () => {
  it("reads Grok's nested info and never copies credentials into metadata", () => {
    const result = parseContextCatalog("grok", { fetched_at: new Date(now).toISOString(), models: {
      "grok-4.7": { api_key: "secret", info: { model: "grok-4.7", context_window: 256000, extra_headers: { secret: "secret" } } },
      "grok-4.7-build-fast": { info: { context_window: 256000 } },
      "future-model": { info: {} },
    } }, now, "a");
    expect(result.models).toHaveLength(3);
    expect(result.models[0].limits.contextWindow).toBe(256000);
    expect(result.models[2].limits.contextWindow).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.stale).toBe(false);
  });
  it("discovers GPT-6.1 Sol and applies the Codex effective factor once", () => {
    const result = parseContextCatalog("codex", { fetched_at: new Date(now).toISOString(), models: [
      { slug: "gpt-6.1-sol", context_window: 272000, effective_context_window_percent: 95 },
      { slug: "new-model", context_window: 160000, effective_context_window_percent: 90 },
    ] }, now, "a");
    expect(result.models[0].modelId).toBe("gpt-6.1-sol");
    expect(effectiveContextWindow(result.models[0].limits)).toBe(258400);
    expect(result.models[0].limits.reserveIncluded).toBe(true);
    const live = observation({ provider: "codex", limits: { effectiveContextTokens: 258400, reserveIncluded: true } });
    expect(checkContextBudget(live, { tokens: 258400, quality: "verified", complete: true }).action).toBe("allow");
  });
  it("marks missing/expired timestamps stale and scopes accounts separately", () => {
    expect(parseContextCatalog("grok", {}, now, "a").stale).toBe(true);
    const raw = { fetched_at: new Date(now - 86400000).toISOString(), models: {} };
    expect(parseContextCatalog("grok", raw, now, "a").stale).toBe(true);
    expect(parseContextCatalog("grok", raw, now, "a").access).not.toBe(parseContextCatalog("grok", raw, now, "b").access);
  });
});

describe("provider fallbacks", () => {
  it("leaves unknown Claude and Antigravity models unknown despite names", () => {
    expect(contextWindowForClaudeModel("future", "Model [1M]")).toBeUndefined();
    expect(contextWindowForModel("gemini-future")).toBeUndefined();
    expect(contextWindowForModel("claude-future")).toBeUndefined();
    expect(contextWindowForModel("claude-sonnet-4-6")).toBeUndefined();
  });
  it("ordinary Antigravity events never override a known window", () => {
    expect(normalizeGeminiUpdate({ sessionUpdate: "tool_call", content: [] }, {}).contextWindow).toBeUndefined();
    expect(normalizeGeminiUpdate({ sessionUpdate: "agent_message_chunk" }, {}).contextWindow).toBeUndefined();
  });
  it("Claude adapter sizes remain estimated without explicit provenance", () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: "usage_update", size: 1000000 }).contextQuality).toBe("estimated");
    expect(normalizeClaudeUpdate({ sessionUpdate: "usage_update", size: 1000000,
      _meta: { contextWindowAuthoritative: true } }).contextQuality).toBe("verified");
  });
  it("validates Muse native counts and accepts an empty context", () => {
    const backend = new MuseBackend();
    expect(backend.normalizeUpdate({ sessionUpdate: "usage_update", used: 0, size: 100 }, {}).contextUsed).toBe(0);
    expect(backend.normalizeUpdate({ sessionUpdate: "usage_update", used: -1, size: Infinity }, {}).contextWindow).toBeUndefined();
  });
  it("discovers unknown Antigravity models and accepts structured native limits", () => {
    const tsv = parseAgyModelsOutput("gemini-new\tGemini New");
    expect(tsv.availableModels[0]._meta.totalContextTokens).toBeUndefined();
    const json = parseAgyModelsOutput(JSON.stringify({ models: [{ modelId: "gemini-new", inputTokenLimit: 123456, outputTokenLimit: 8192 }] }));
    expect(json.availableModels[0]._meta).toMatchObject({ totalContextTokens: 123456, contextQuality: "verified" });
  });
});

describe("pre-send budget decisions", () => {
  it("allows an exact fit and blocks one token over, including configured output", () => {
    expect(checkContextBudget(observation(), { tokens: 248000, quality: "verified", complete: true }).action).toBe("allow");
    expect(checkContextBudget(observation(), { tokens: 248001, quality: "verified", complete: true }).action).toBe("block");
  });
  it("does not subtract output from an independent input limit", () => {
    const o = observation({ limits: { inputTokenLimit: 100, outputReserve: 50 } });
    expect(checkContextBudget(o, { tokens: 100, quality: "verified", complete: true }).action).toBe("allow");
  });
  it.each([
    { quality: "estimated" as const, complete: true },
    { quality: "verified" as const, complete: false },
  ])("warns when the count is incomplete or estimated", count => {
    expect(checkContextBudget(observation(), { tokens: 300000, ...count }).action).toBe("warn");
  });
  it("never blocks on stale/estimated limits or unknown output reserves", () => {
    const count = { tokens: 300000, quality: "verified" as const, complete: true };
    expect(checkContextBudget(observation({ stale: true }), count).action).toBe("warn");
    expect(checkContextBudget(observation({ limitQuality: "estimated" }), count).action).toBe("warn");
    expect(checkContextBudget(observation({ limits: { contextWindow: 256000 } }), count).action).toBe("warn");
  });
  it("unknown limits and invalid counters never invent a percentage or a block", () => {
    expect(checkContextBudget(undefined, { tokens: 500, quality: "estimated" }).reason).toBe("unknown");
    expect(checkContextBudget(observation(), { tokens: NaN, quality: "verified", complete: true }).action).toBe("warn");
  });
  it("handles Unicode and multimodal prompts as incomplete estimates", () => {
    const count = estimateContextPrompt([{ type: "text", text: "😀中文ä" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(count.tokens).toBeGreaterThan(0);
    expect(count.quality).toBe("estimated");
    expect(count.complete).toBe(false);
  });
});

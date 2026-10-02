import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { ContextBudgetExceededError, type ContextPromptCount } from "../src/context-budget";

function clientWithCounter(count: (prompt: readonly any[]) => Promise<ContextPromptCount>) {
  const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, backend: new CodexBackend(), contextTokenCounter: count });
  client.sessionId = "session-one";
  client.currentModelId = "gpt-6.1-sol";
  client.observeContext({ source: "session", limitQuality: "verified", usageQuality: "verified", used: 100,
    limits: { effectiveContextTokens: 258400, reserveIncluded: true } });
  const request = vi.fn(async () => ({ stopReason: "end_turn" }));
  (client as any).request = request;
  return { client, request };
}

describe("the common ACP send guard", () => {
  it("preserves Codex ACP usage as a native last-request count, including repeated counts", () => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, backend: new CodexBackend() });
    client.sessionId = "session-one";
    client.currentModelId = "gpt-test";
    for (const used of [32000, 32000, 0]) {
      (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used, size: 400000 }, {}, "session-one");
      expect(client.contextBudget).toMatchObject({ used, usageSource: "session", usageSemantics: "last-request", usageStale: false });
    }
  });
  it("publishes prompt input including cache once, without output and reasoning", async () => {
    const { client, request } = clientWithCounter(async () => ({ tokens: 1, quality: "estimated" }));
    request.mockResolvedValue({ stopReason: "end_turn", usage: { inputTokens: 120, cachedReadTokens: 80,
      outputTokens: 40, thoughtTokens: 20, totalTokens: 240 } } as any);
    await client.prompt("hello");
    expect(client.contextBudget).toMatchObject({ used: 200, usageQuality: "verified", usageSemantics: "last-request" });
  });
  it("blocks before a prompt RPC when the complete request is verifiably too large", async () => {
    const { client, request } = clientWithCounter(async () => ({ tokens: 258401, quality: "verified", complete: true }));
    await expect(client.prompt("oversized")).rejects.toBeInstanceOf(ContextBudgetExceededError);
    expect(request).not.toHaveBeenCalled();
  });
  it("sends an exact fit, and never reduces an already-effective Codex window again", async () => {
    const { client, request } = clientWithCounter(async () => ({ tokens: 258400, quality: "verified", complete: true }));
    await client.prompt("fit");
    expect(request).toHaveBeenCalledWith("session/prompt", { sessionId: "session-one", prompt: [{ type: "text", text: "fit" }] });
  });
  it("the guard counts and sends the same frozen snapshot", async () => {
    let continueCounting!: () => void;
    const ready = new Promise<void>(resolve => { continueCounting = resolve; });
    let counted = "";
    const { client, request } = clientWithCounter(async prompt => {
      counted = prompt[0].text;
      await ready;
      return { tokens: 100, quality: "estimated" };
    });
    const prompt = [{ type: "text" as const, text: "original" }];
    const sent = client.prompt(prompt);
    prompt[0].text = "changed while counting";
    continueCounting();
    await sent;
    expect(counted).toBe("original");
    expect(request.mock.calls[0]).toEqual(["session/prompt", { sessionId: "session-one", prompt: [{ type: "text", text: "original" }] }]);
  });
  it("allows estimates and counter failures without claiming strict enforcement", async () => {
    const { client, request } = clientWithCounter(async () => ({ tokens: 300000, quality: "estimated" }));
    const notices: string[] = [];
    client.on("contextBudgetNotice", text => notices.push(text));
    await client.prompt("estimate");
    expect(request).toHaveBeenCalled();
    expect(notices[0]).toContain("Estimated");
    const failed = clientWithCounter(async () => { throw new Error("count API offline"); });
    await failed.client.prompt("hello");
    expect(failed.request).toHaveBeenCalled();
  });
  it("allows compaction even when the normal prompt would be blocked", async () => {
    const count = vi.fn(async () => ({ tokens: 300000, quality: "verified" as const, complete: true }));
    const { client, request } = clientWithCounter(count);
    await client.prompt("/compact");
    expect(count).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalled();
  });
  it("resets usage on model switch and ignores an old model's delayed update", async () => {
    const { client } = clientWithCounter(async () => ({ tokens: 100, quality: "estimated" }));
    client.availableModels = [{ modelId: "small", name: "Small", totalContextTokens: 1000, contextQuality: "verified" }];
    await client.setModel("small");
    expect(client.contextBudget?.modelId).toBe("small");
    expect(client.contextBudget?.used).toBeUndefined();
    (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used: 400000, size: 500000 }, { modelId: "gpt-6.1-sol" }, "session-one");
    expect(client.contextBudget?.limits.contextWindow).toBe(1000);
  });
  it("rejects observations from another generation or child session", () => {
    const { client } = clientWithCounter(async () => ({ tokens: 100, quality: "estimated" }));
    client.observeContext({ generation: 99, source: "session", limitQuality: "verified", limits: { contextWindow: 500000 } });
    client.observeContext({ sessionId: "child", source: "session", limitQuality: "verified", limits: { contextWindow: 500000 } });
    expect(client.contextBudget?.limits.effectiveContextTokens).toBe(258400);
  });
  it("unknown models warn only once per generation while remaining usable", async () => {
    const { client } = clientWithCounter(async () => ({ tokens: 100, quality: "estimated" }));
    await client.setModel("undocumented-future-model");
    const notices: string[] = [];
    client.on("contextBudgetNotice", text => notices.push(text));
    await client.prompt("first");
    await client.prompt("second");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("limit unknown");
  });
});

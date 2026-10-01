import { describe, expect, it } from "vitest";
import manifest from "../package.json";
import fixture from "./fixtures/native-context-contracts.json";
import { normalizeCodexUpdate, normalizeCodexPromptResult } from "../src/codex-backend";
import { normalizeClaudeUpdate, normalizeClaudePromptResult } from "../src/claude-backend";
import { normalizeGeminiUpdate, normalizeGeminiPromptResult } from "../src/gemini-backend";
import { MuseBackend } from "../src/muse-backend";
import { AcpClient } from "../src/acp";
import { Projection } from "../adapters/muse/projection.mts";

describe("versioned native context contracts", () => {
  it("pins the evidence to the shipped adapter and SDK versions", () => {
    expect(manifest.dependencies["@agentclientprotocol/codex-acp"]).toBe(fixture.versions.codex);
    expect(manifest.dependencies["@agentclientprotocol/claude-agent-acp"]).toBe(fixture.versions.claude);
    expect(manifest.dependencies["@muse-code/sdk"]).toBe(fixture.versions.muse);
  });
  it("keeps Codex last-call usage separate from its effective capacity", () => {
    expect(normalizeCodexUpdate(fixture.codex).contextObservation).toMatchObject({
      usageSemantics: "last-request", limits: { effectiveContextTokens: 258400, reserveIncluded: true } });
    const result = normalizeCodexPromptResult({ usage: { inputTokens: 50, cachedReadTokens: 20, outputTokens: 30, totalTokens: 100 } });
    expect(result._meta.totalTokens).toBe(70);
    expect(result._meta.contextUsageSemantics).toBe("last-request");
  });
  it("does not promote Claude accumulated turn usage or compact fallback zero", () => {
    expect(normalizeClaudePromptResult({ usage: { inputTokens: 220000 } })._meta.contextUsageSemantics).toBe("turn-cumulative");
    expect(normalizeClaudeUpdate({ ...fixture.claude, used: 0 }).contextObservation?.usageSemantics).toBe("last-request");
  });
  it("leaves undocumented Antigravity usage unknown", () => {
    expect(normalizeGeminiUpdate(fixture.antigravity, {}).contextObservation?.usageSemantics).toBe("unknown");
    expect(normalizeGeminiPromptResult({ usage: { totalTokens: 2400 } })._meta.contextUsageSemantics).toBe("unknown");
  });
  it("carries MSP context through the host, including zero and a smaller snapshot", () => {
    const backend = new MuseBackend();
    const client = new AcpClient({ cliPath: "fake", cwd: "/", backend, log: () => {} });
    client.sessionId = "s";
    client.currentModelId = "m";
    const projection = new Projection(update => (client as any).handleSessionUpdate(update, undefined, "s"), () => {});
    projection.accept("session/contextUsage", { usedTokens: 80000, windowTokens: 1007997 });
    projection.accept("session/contextUsage", { usedTokens: 100, windowTokens: 1007997 });
    expect(client.contextBudget?.used).toBe(100);
    projection.accept("session/contextUsage", { usedTokens: 0, windowTokens: 1007997 });
    expect(client.contextBudget).toMatchObject({ used: 0, usageSemantics: "current-context", runtime: { product: "muse-code" } });
    expect(JSON.stringify(client.contextBudget)).not.toContain("native");
  });
});

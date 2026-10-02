import { describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { historicalContextObservation, mergeContextObservation, type ContextObservation } from "../src/context-budget";

function observation(overrides: Partial<ContextObservation> = {}): ContextObservation {
  return { provider: "codex", access: "a", sessionId: "s", modelId: "m", generation: 1,
    source: "session", observedAt: 10, usageObservedAt: 10, limitQuality: "verified", usageQuality: "verified",
    limits: { contextWindow: 100000 }, used: 80000, usageSemantics: "current-context", ...overrides };
}

describe("context lifecycle and semantics", () => {
  it("retains verified Codex prompt-input provenance without changing its semantics", () => {
    const next = mergeContextObservation(undefined, observation({ usageSemantics: "last-request" }));
    expect(next.used).toBe(80000);
    expect(next.usageSemantics).toBe("last-request");
    expect(next.usageQuality).toBe("verified");
  });
  it.each(["billing", "subscription", "turn-cumulative", "session-cumulative"] as const)(
    "%s does not become native context occupancy", usageSemantics => {
      expect(mergeContextObservation(undefined, observation({ usageSemantics })).used).toBeUndefined();
    });
  it("preserves independent usage provenance across catalog refresh", () => {
    const next = mergeContextObservation(observation(), observation({ source: "catalog", used: undefined,
      usageQuality: "unknown", observedAt: 20 }));
    expect(next.used).toBe(80000);
    expect(next.usageSource).toBe("session");
    expect(next.usageObservedAt).toBe(10);
  });
  it("accepts a shrinking native snapshot and a real zero", () => {
    const smaller = mergeContextObservation(observation(), observation({ used: 40000, usageObservedAt: 20 }));
    expect(smaller.used).toBe(40000);
    expect(mergeContextObservation(smaller, observation({ used: 0, usageObservedAt: 30 })).used).toBe(0);
  });
  it("restores historical observations as stale estimates", () => {
    const old = historicalContextObservation(observation());
    expect(old).toMatchObject({ stale: true, usageStale: true, usageQuality: "estimated", used: 80000 });
  });
  it("invalidates compact usage without losing capacity and rejects old revisions", () => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, backend: new CodexBackend() });
    client.sessionId = "s";
    client.currentModelId = "m";
    client.observeContext(observation({ generation: 0 }));
    const revision = client.contextBudget!.revision!;
    client.clearContextUsage(true);
    expect(client.contextBudget).toMatchObject({ limits: { contextWindow: 100000 }, usageStale: true });
    expect(client.contextBudget?.used).toBeUndefined();
    client.observeContext({ ...observation({ generation: 0 }), revision });
    expect(client.contextBudget?.used).toBeUndefined();
  });
});

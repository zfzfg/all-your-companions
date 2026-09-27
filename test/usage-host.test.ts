import { describe, expect, it, vi } from "vitest";
import { createUsageHost, type UsageHostDeps } from "../src/usage-host";
import { Session } from "../src/session";

describe("UsageHost", () => {
  function makeHarness() {
    const store = new Map<string, any>();
    const posted: any[] = [];
    const appended: string[] = [];
    const deps: UsageHostDeps = {
      host: {
        appendLine: (line: string) => appended.push(line),
        getConfiguration: () => ({ get: (_k: string, def: any) => def }),
      } as any,
      state: {
        get: <T>(k: string, def?: T): T => (store.get(k) ?? def) as T,
        update: vi.fn(async (k: string, val: any) => { store.set(k, val); }),
      },
      emit: (_session: Session, msg: any) => { posted.push(msg); },
      sessionCwd: () => "/workspace",
      readDotEnv: () => ({}),
      getFocused: () => new Session(),
      getPool: () => [],
    };
    const usageHost = createUsageHost(deps);
    return { usageHost, deps, store, posted, appended };
  }

  it("accumulates real measured usage and updates state", async () => {
    const { usageHost, store, posted, appended } = makeHarness();
    const session = new Session();
    session.activeSessionId = "sess-1";
    session.provider = "claude";
    session.userMessageCount = 1;
    session.historyEventCount = 1;

    await usageHost.accumulateUsage(session, {
      totalTokens: 150,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    expect(appended.some((line) => line.includes("[usage] claude turn"))).toBe(true);
    expect(posted.some((m) => m.type === "usage")).toBe(true);
    const overrides = store.get("grok.sessionMeta");
    expect(overrides?.["sess-1"]?.usageLog).toHaveLength(1);
  });

  it("restores usage from persisted ledger", () => {
    const { usageHost, store, posted } = makeHarness();
    store.set("grok.sessionMeta", {
      "sess-1": {
        usageLog: [{ afterUserMessage: 1, usage: { totalTokens: 200 } }],
      },
    });

    const session = new Session();
    session.activeSessionId = "sess-1";
    session.userMessageCount = 1;

    usageHost.restoreUsage(session);
    expect(posted.some((m) => m.type === "usage")).toBe(true);
  });
});

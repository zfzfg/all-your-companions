/**
 * Inbound webview router (W-15 Schritt D1).
 * Proves the domain split still answers /agent before a normal send, and that
 * a relayed card lands on the child session.
 */
import { describe, expect, it, vi } from "vitest";
import { SidebarInbound, type SidebarInboundDeps } from "../src/sidebar-inbound";
import { Session } from "../src/session";
import type { WebviewMsg } from "../src/protocol";

function harness(over: Partial<SidebarInboundDeps> = {}) {
  const calls: string[] = [];
  const focused = new Session();
  const handleSend = vi.fn(async () => { calls.push("send"); });
  const handleAgentCommand = vi.fn(async () => { calls.push("agent"); });
  const deps = {
    host: { appendLine: () => {}, getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
    state: { get: () => ({}), update: async () => {} },
    getFocused: () => focused,
    getPool: () => new Set<Session>([focused]),
    workspaceRoot: () => "/work",
    sessionCwd: () => "/work",
    emit: () => {},
    post: () => {},
    postLocal: () => {},
    resolveRelayedAnswer: () => undefined,
    slots: {},
    boot: {},
    composer: { handleSend, handleAgentCommand },
    sessions: {

},
sessionSettings: {

},
worktrees: {

},
    review: {},
    workflow: {

},
authoring: {

},
children: {

},
    routines: {},
    providers: {},
    projects: {},
    settings: {},
    ...over,
  } as SidebarInboundDeps;
  return { inbound: new SidebarInbound(deps), deps, calls, focused, handleSend, handleAgentCommand };
}

describe("SidebarInbound", () => {
  it("keeps the context interface at or under 25 members", () => {
    const { deps } = harness();
    expect(Object.keys(deps).length).toBeLessThanOrEqual(25);
  });

  it("sends ordinary text through the composer", async () => {
    const h = harness();
    await h.inbound.dispatch({ type: "send", text: "hello" } as WebviewMsg);
    expect(h.handleSend).toHaveBeenCalledWith("hello", false, h.focused, undefined, undefined);
    expect(h.handleAgentCommand).not.toHaveBeenCalled();
  });

  it("answers /agent before the send reaches a provider", async () => {
    const h = harness();
    await h.inbound.dispatch({ type: "send", text: "/agent researcher find it" } as WebviewMsg);
    expect(h.handleAgentCommand).toHaveBeenCalledWith("/agent researcher find it", h.focused);
    expect(h.handleSend).not.toHaveBeenCalled();
  });

  it("delivers a relayed answer to the child session", async () => {
    const child = new Session();
    const h = harness({
      resolveRelayedAnswer: () => ({ session: child, msg: { type: "send", text: "from the child" } as WebviewMsg }),
    });
    await h.inbound.dispatch({ type: "ready" } as WebviewMsg);
    expect(h.handleSend).toHaveBeenCalledWith("from the child", false, child, undefined, undefined);
  });

  it("ignores a message type none of the routers own", async () => {
    const h = harness();
    await expect(h.inbound.dispatch({ type: "not-a-real-message" } as unknown as WebviewMsg)).resolves.toBeUndefined();
    expect(h.handleSend).not.toHaveBeenCalled();
  });
});


describe("context-window inbound routing", () => {
  it("does not change model-switch behavior for another provider", async () => {
    const switchModel = vi.fn(async () => {});
    const h = harness({ sessionSettings: { switchModel } as any });
    h.focused.provider = "codex";
    h.focused.turnToken = {};
    h.focused.client = { currentModelId: "old" } as any;
    await h.inbound.dispatch({ type: "setModel", modelId: "new", provider: "codex" });
    expect(switchModel).toHaveBeenCalledWith("new", h.focused, "codex");
  });

  it("answers both numeric forms without consuming a normal send", async () => {
    const notifyUser = vi.fn();
    const h = harness({ providers: { notifyUser } as any });
    const setContextWindow = vi.fn(async () => {});
    h.focused.client = { contextWindowSelection: { sessionId: "s", modelId: "m", generation: 1 }, setContextWindow } as any;
    await h.inbound.dispatch({ type: "send", text: "/context-window 500k" });
    await h.inbound.dispatch({ type: "send", text: "/context-window 256000" });
    expect(setContextWindow.mock.calls.map((c: any[]) => c[0])).toEqual([500000, 256000]);
    expect(h.handleSend).not.toHaveBeenCalled();
  });
  it("opens the picker for the bare command and refuses changes during a turn", async () => {
    const post = vi.fn(); const notifyUser = vi.fn();
    const h = harness({ post, providers: { notifyUser } as any });
    const setContextWindow = vi.fn();
    h.focused.client = { contextWindowSelection: { sessionId: "s", modelId: "m", generation: 1 }, setContextWindow } as any;
    await h.inbound.dispatch({ type: "send", text: "/context-window" });
    expect(post.mock.calls[0][0].openPicker).toBe(true);
    h.focused.turnToken = {};
    await h.inbound.dispatch({ type: "send", text: "/context-window 500k" });
    expect(setContextWindow).not.toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalled();
    expect(h.handleSend).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { UsageHost } from "../src/usage-host";
import { Session } from "../src/session";
import { bootWebview, dispatch } from "./webview-harness";
vi.mock("../src/sessions", async original => ({
  ...await original<typeof import("../src/sessions")>(),
  readContextUsage: () => ({ used: 80000, window: 100000 }),
}));
function client() {
  const c = new AcpClient({ cliPath: "fake", cwd: "/repo", log: () => {} });
  c.sessionId = "grok-session"; c.currentModelId = "grok-build";
  return c;
}
describe("Grok compact, host reload and historical replay", () => {
  it("keeps old 80% stale until a fresh smaller occupancy arrives", () => {
    const session = new Session(); session.activeSessionId = "grok-session"; session.client = client();
    let h = bootWebview();
    const showSession = () => dispatch(h.window, { type: "session", provider: "grok", sessionId: "grok-session", currentModelId: "grok-build" });
    showSession();
    session.client.observeContext({ source: "session", usageSemantics: "current-context", used: 80000,
      usageQuality: "verified", limitQuality: "verified", limits: { contextWindow: 100000 } });
    dispatch(h.window, { type: "contextUsage", context: session.client.contextBudget, used: 80000, window: 100000 });
    expect(h.doc.getElementById("donut-arc")!.style.display).toBe("");
    const oldRevision = session.client.contextBudget!.revision;
    (session.client as any).onLine(JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification",
      params: { sessionId: "grok-session", update: { sessionUpdate: "auto_compact_started" } } }));
    expect(session.client.contextBudget?.used).toBeUndefined();
    session.client.observeContext({ revision: oldRevision, source: "session", used: 80000, usageQuality: "verified", limits: {}, limitQuality: "unknown" });
    expect(session.client.contextBudget?.used).toBeUndefined();
    // Leave the view and reconstruct both host client and webview, as a reload does.
    session.client = client(); h = bootWebview(); showSession();
    const usage = new UsageHost({ state: { get: (_key: string, fallback: unknown) => fallback },
      sessionCwd: () => "/repo", emit: (_s: Session, msg: any) => dispatch(h.window, msg),
    } as any);
    usage.emitContextUsage(session);
    expect(session.client.contextBudget).toMatchObject({ stale: true, usageQuality: "estimated", used: 80000 });
    expect(h.doc.getElementById("donut-arc")!.style.display).toBe("none");
    session.client.observeContext({ source: "session", used: 12345, usageSemantics: "current-context", usageQuality: "verified",
      limitQuality: "verified", limits: { contextWindow: 100000 } });
    dispatch(h.window, { type: "contextUsage", context: session.client.contextBudget, used: 12345, window: 100000 });
    expect(h.doc.getElementById("donut-arc")!.style.display).toBe("");
    expect(h.doc.getElementById("donut-label")!.textContent).not.toContain("80");
  });
});

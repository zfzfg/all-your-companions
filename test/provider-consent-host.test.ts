// #171 (upstream 4444697): connection is a fact the person states by pressing
// Connect / Sign in. Nothing may run a vendor's binary for an agent that is
// not connected — and a refresh or a successful probe never connects one.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function sidebarWith(connections: Record<string, boolean>) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerConnectionState = { ...connections };
  sidebar.host = { appendLine: vi.fn(), createTerminal: vi.fn(() => ({ show: vi.fn() })) };
  sidebar.locateProvider = vi.fn((provider: string) => `/bin/${provider}`);
  sidebar.state = { get: vi.fn(() => undefined), update: vi.fn(async () => {}) };
  sidebar.postProviderState = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  return sidebar;
}

describe("stored connection consent at the host boundary (#171)", () => {
  it.each(["grok", "codex", "claude", "gemini"])("never probes a %s that is installed but not connected", async (provider) => {
    const sidebar = sidebarWith({});
    const spawn = vi.fn();
    sidebar.createProviderBackend = spawn;
    await expect(sidebar.reprobeProviderCredentials(provider)).resolves.toBe(false);
    await expect(sidebar.probeProviderVersion(provider)).resolves.toBe("");
    await sidebar.refreshAdapterHistory(provider, "/repo");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("will not spawn a temporary client to clean up after an unconnected agent", async () => {
    const sidebar = sidebarWith({});
    sidebar.createProviderBackend = vi.fn();
    await expect(sidebar.discardAdapterEmptySession("claude", "s-1", "/repo")).resolves.toBe(false);
    expect(sidebar.createProviderBackend).not.toHaveBeenCalled();
  });

  it("starts saved connections clean instead of importing inferred ones", () => {
    const sidebar = sidebarWith({});
    const migrated = sidebar.migrateProviderConnections();
    expect(migrated).toEqual({});
    expect(sidebar.state.get).toHaveBeenCalledWith("grok.providerConnections.v2");
    expect(sidebar.state.update).toHaveBeenCalledWith("grok.providerConnections.v2", {});
  });

  it("records the consent when Sign in is pressed, before the CLI runs", async () => {
    const sidebar = sidebarWith({});
    const session = new Session();
    session.provider = "claude";
    sidebar.focused = session;
    sidebar.pool = new Set([session]);
    sidebar.workspaceRoot = vi.fn(() => "/repo");
    sidebar.providerNeedsLogin = {};
    sidebar.post = vi.fn();
    sidebar.newFocusedSession = vi.fn(async () => {});
    sidebar.loginReprobeTimers = new Map();
    sidebar.watchProviderLogin = vi.fn();
    const order: string[] = [];
    sidebar.setProviderConnected = vi.fn(async (provider: string, connected: boolean) => {
      order.push(`connected:${provider}:${connected}`);
      sidebar.providerConnectionState[provider] = connected;
    });
    sidebar.host.createTerminal = vi.fn(() => { order.push("terminal"); return { show: vi.fn() }; });
    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" }, session, "local");
    expect(order.slice(0, 2)).toEqual(["connected:claude:true", "terminal"]);
  });
});

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
  it.each(["C:/Users/dev/.gemini/bin/agy.exe", "/usr/local/bin/agy"])("opens interactive Antigravity sign-in without unsupported auth arguments for %s", async (cliPath) => {
    const sidebar = sidebarWith({ gemini: true });
    sidebar.focused = new Session();
    sidebar.pool = new Set([sidebar.focused]);
    sidebar.workspaceRoot = () => "/repo";
    sidebar.providerNeedsLogin = {};
    sidebar.post = vi.fn();
    sidebar.watchProviderLogin = vi.fn();
    sidebar.locateProvider = () => cliPath;
    sidebar.setProviderConnected = vi.fn(async () => {});
    sidebar.setProviderNeedsLogin = vi.fn();
    await sidebar.onMessage({ type: "runGrokLogin", provider: "gemini" });
    expect(sidebar.host.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ shellPath: cliPath, shellArgs: [] }));
    expect(sidebar.setProviderConnected).toHaveBeenCalledWith("gemini", true);
    expect(sidebar.watchProviderLogin).toHaveBeenCalledWith("gemini");
  });
  it.each(["grok", "codex", "claude", "gemini", "muse"])("uses the existing %s sign-in without opening login", async (provider) => {
    const sidebar = sidebarWith({});
    sidebar.focused = new Session();
    sidebar.pool = new Set([sidebar.focused]);
    sidebar.workspaceRoot = () => "/repo";
    sidebar.providerNeedsLogin = {};
    sidebar.post = vi.fn();
    sidebar.setProviderNeedsLogin = vi.fn();
    sidebar.reprobeProviderCredentials = vi.fn(async () => true);
    sidebar.providerCredentialFilePresent = vi.fn(() => true);
    sidebar.adoptSessionsForConnectedProvider = vi.fn(async () => {});
    sidebar.setProviderConnected = vi.fn(async () => { sidebar.providerConnectionState[provider] = true; });
    await sidebar.onMessage({ type: "runGrokLogin", provider });
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalledWith(provider, sidebar.focused);
    expect(sidebar.setProviderNeedsLogin).toHaveBeenLastCalledWith(provider, false);
  });

  it("coalesces Connect and ignores its result after Disconnect", async () => {
    const sidebar = sidebarWith({});
    sidebar.focused = new Session();
    sidebar.pool = new Set([sidebar.focused]);
    sidebar.workspaceRoot = () => "/repo";
    sidebar.post = vi.fn();
    sidebar.setProviderNeedsLogin = vi.fn();
    sidebar.setProviderConnected = vi.fn(async () => { sidebar.providerConnectionState.codex = true; });
    let resolve!: (ready: boolean) => void;
    sidebar.reprobeProviderCredentials = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    sidebar.adoptSessionsForConnectedProvider = vi.fn();
    const first = sidebar.onMessage({ type: "runGrokLogin", provider: "codex" });
    await Promise.resolve();
    await sidebar.onMessage({ type: "runGrokLogin", provider: "codex" });
    expect(sidebar.reprobeProviderCredentials).toHaveBeenCalledTimes(1);
    sidebar.providerConnectionState.codex = false;
    resolve(true);
    await first;
    expect(sidebar.adoptSessionsForConnectedProvider).not.toHaveBeenCalled();
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
  });

  it("keeps Antigravity connected until interactive logout is observed", async () => {
    const sidebar = sidebarWith({ gemini: true });
    sidebar.locateProvider = () => "C:/Users/dev/.gemini/bin/agy.exe";
    sidebar.host.showWarningMessage = vi.fn(async () => "Sign Out");
    sidebar.host.showErrorMessage = vi.fn();
    sidebar.finishProviderLogout = vi.fn();
    await sidebar.logout("gemini");
    expect(sidebar.host.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ shellArgs: [] }));
    expect(sidebar.host.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Enter /logout"));
    expect(sidebar.finishProviderLogout).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState.gemini).toBe(true);
  });
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
    sidebar.reprobeProviderCredentials = vi.fn(async () => { order.push("probe"); return false; });
    sidebar.setProviderNeedsLogin = vi.fn();
    sidebar.host.createTerminal = vi.fn(() => { order.push("terminal"); return { show: vi.fn() }; });
    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" });
    expect(order.slice(0, 2)).toEqual(["connected:claude:true", "probe"]);
  });
});

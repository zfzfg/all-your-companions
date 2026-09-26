import { describe, expect, it, vi } from "vitest";
import { ProviderSetup, type ProviderSetupDeps } from "../src/provider-setup";

function createFakeDeps(overrides: Partial<ProviderSetupDeps> = {}): {
  deps: ProviderSetupDeps;
  posted: any[];
  postedLocal: any[];
  toSettings: any[];
  config: Record<string, any>;
  stateData: Record<string, any>;
} {
  const posted: any[] = [];
  const postedLocal: any[] = [];
  const toSettings: any[] = [];
  const config: Record<string, any> = {
    cliPath: "",
    codexCliPath: "",
    claudeCliPath: "",
    geminiCliPath: "",
    museCliPath: "",
    "acp.promptIdleTimeoutMs": 120000,
    "acp.promptAbsoluteTimeoutMs": 300000,
    "acp.requestTimeoutMs": 60000,
  };
  const stateData: Record<string, any> = {};

  const host: any = {
    getConfiguration: vi.fn((section: string) => ({
      get: vi.fn((key: string, fallback?: any) => {
        const fullKey = section === "grok" ? key : `${section}.${key}`;
        return fullKey in config ? config[fullKey] : (key in config ? config[key] : fallback);
      }),
    })),
    appendLine: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
  };

  const context: any = {
    globalStorageUri: { fsPath: "/tmp/storage" },
  };

  const state: any = {
    get: vi.fn((key: string, fallback?: any) => (key in stateData ? stateData[key] : fallback)),
    update: vi.fn(async (key: string, val: any) => { stateData[key] = val; }),
  };

  const deps: ProviderSetupDeps = {
    host,
    context,
    state,
    providerCliVersions: {},
    workspaceRoot: () => "/workspace",
    post: (msg) => { posted.push(msg); },
    postLocal: (msg) => { postedLocal.push(msg); },
    postToSettingsEditor: (msg) => { toSettings.push(msg); },
    cacheProviderModels: vi.fn(async () => {}),
    probeProviderVersion: vi.fn(async () => "1.0.0"),
    invalidateSubscriptionUsage: vi.fn(),
    rearmAuthRecovery: vi.fn(),
    refreshGithubState: vi.fn(async () => {}),
    buildEnv: vi.fn(() => ({})),
    removeSessionFromDisk: vi.fn(() => true),
    ...overrides,
  };

  return { deps, posted, postedLocal, toSettings, config, stateData };
}

describe("ProviderSetup collaborator", () => {
  it("initializes with empty connection state and migrates from storage", () => {
    const { deps, stateData } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    expect(setup.providerConnections()).toEqual({});
    expect(setup.hasProviderConsent("grok")).toBe(false);

    stateData["grok.providerConnections.v2"] = { grok: true, codex: true };
    const migrated = setup.migrateProviderConnections();
    expect(migrated).toEqual({ grok: true, codex: true });
  });

  it("updates connection state in memory and emits providerState", () => {
    const { deps, posted } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    setup.setProviderConnectedInMemory("codex", true);

    expect(setup.hasProviderConsent("codex")).toBe(true);
    expect(setup.providerConnections().codex).toBe(true);
    expect(deps.probeProviderVersion).toHaveBeenCalledWith("codex");

    const stateMsg = posted.find((m) => m.type === "providerState");
    expect(stateMsg).toBeDefined();
  });

  it("computes acpClientTimeouts from host configuration", () => {
    const { deps } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    const timeouts = setup.acpClientTimeouts();
    expect(timeouts).toEqual({
      promptIdleTimeoutMs: 120000,
      promptAbsoluteTimeoutMs: 300000,
      requestTimeoutMs: 60000,
    });
  });

  it("sets needsLogin and invalidates usage when an account lapses", () => {
    const { deps } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    setup.setProviderNeedsLogin("claude", true);

    expect(setup.providerNeedsLogin.claude).toBe(true);
    expect(deps.invalidateSubscriptionUsage).toHaveBeenCalledWith("claude");
  });

  it("resolves defaultProviderForProject based on usable providers", () => {
    const { deps, stateData } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    // When nothing is connected or located, fallback is grok
    expect(setup.defaultProviderForProject("/workspace")).toBe("grok");

    // When codex is connected and located
    setup.providerConnectionState = { codex: true };
    setup.codexCliPath = process.execPath; // an existing file
    expect(setup.usableProviders()).toContain("codex");
    expect(setup.defaultProviderForProject("/workspace")).toBe("codex");

    // Project preference override
    stateData["grok.projectProviderDefaults"] = {
      "/workspace": { provider: "codex" },
    };
    expect(setup.defaultProviderForProject("/workspace")).toBe("codex");
  });

  it("disposes reprobe timers and abort controller cleanly", () => {
    const { deps } = createFakeDeps();
    const setup = new ProviderSetup(deps);
    const controller = new AbortController();
    setup.codexInstallAbort = controller;

    setup.dispose();
    expect(controller.signal.aborted).toBe(true);
    expect(setup.codexInstallAbort).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createCliUpdateHost, type CliUpdateHostDeps } from "../src/cli-update-host";
import { Session } from "../src/session";

describe("CliUpdateHost", () => {
  function makeHarness() {
    const store = new Map<string, any>();
    const posted: any[] = [];
    const updateStatuses: any[] = [];
    const appended: string[] = [];
    let focused = new Session();
    const deps: CliUpdateHostDeps = {
      host: {
        appendLine: (l: string) => appended.push(l),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
      } as any,
      state: {
        get: <T>(k: string, def?: T): T => (store.get(k) ?? def) as T,
        update: vi.fn(async (k: string, val: any) => { store.set(k, val); }),
      },
      context: { globalStorageUri: { fsPath: "/storage" } },
      post: (msg) => posted.push(msg),
      postGrokUpdateStatus: (msg) => updateStatuses.push(msg),
      postProviderState: vi.fn(),
      providerCliVersions: {},
      hasProviderConsent: () => true,
      locateProvider: () => "/bin/grok",
      readGrokVersion: async () => "2.0.0",
      connectedProviders: () => ["grok"],
      installManagedCodexCli: vi.fn(async () => {}),
      reprobeProviderCredentials: vi.fn(async () => {}),
      getFocused: () => focused,
      setFocused: (s) => { focused = s; },
      getPool: () => [focused],
      newLocalSession: () => new Session(),
      disposePool: vi.fn(async () => {}),
      startSession: vi.fn(async () => {}),
    };
    const cliUpdateHost = createCliUpdateHost(deps);
    return { cliUpdateHost, deps, store, posted, updateStatuses, appended };
  }

  it("updates model cache when CLI version changes", async () => {
    const { cliUpdateHost, deps, store, appended } = makeHarness();
    store.set("grok.providerModelCache", {
      grok: { cliVersion: "1.0.0", models: [] },
    });

    await cliUpdateHost.refreshModelsIfCliChanged("grok", "2.0.0");

    expect(deps.reprobeProviderCredentials).toHaveBeenCalledWith("grok");
    expect(appended.some((l) => l.includes("1.0.0 -> 2.0.0"))).toBe(true);
    const updated = store.get("grok.providerModelCache");
    expect(updated?.grok?.cliVersion).toBe("2.0.0");
  });

  it("does nothing when CLI version is identical", async () => {
    const { cliUpdateHost, deps, store } = makeHarness();
    store.set("grok.providerModelCache", {
      grok: { cliVersion: "1.0.0", models: [] },
    });

    await cliUpdateHost.refreshModelsIfCliChanged("grok", "1.0.0");

    expect(deps.reprobeProviderCredentials).not.toHaveBeenCalled();
  });
});

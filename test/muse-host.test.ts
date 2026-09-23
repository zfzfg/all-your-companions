// Muse Code as the fifth provider (upstream 9a4aa6b, adapted): the host finds
// it, starts it through our ESM adapter, lists it, and never runs it for an
// account the person has not connected (#171).
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { MuseBackend } from "../src/muse-backend";
import { providerCapability } from "../src/provider-capabilities";
import { providerDisplayName, providerLoginState, missingProviderState, PROVIDER_ORDER } from "../src/provider-ui";
import { supportsClientMcpServers, supportsModeSwitching, usesAdapterHistory } from "../src/acp-backend";

function host(connections: Record<string, boolean>) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerConnectionState = connections;
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.host = { appendLine: vi.fn(), getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) };
  sidebar.post = vi.fn();
  sidebar.settingsEditor = undefined;
  sidebar.locateProvider = vi.fn((p: string) => (p === "muse" ? "/usr/local/bin/muse" : undefined));
  return sidebar;
}

describe("Muse as a provider", () => {
  it("is enumerated, named and has its own onboarding states", () => {
    expect(PROVIDER_ORDER).toContain("muse");
    expect(providerDisplayName("muse")).toBe("Muse Code");
    expect(providerLoginState("muse")).toBe("muse-login");
    expect(missingProviderState("muse")).toBe("missing-muse");
  });

  it("declares what the adapter can and cannot do in the capability matrix", () => {
    expect(usesAdapterHistory("muse")).toBe(true);
    expect(supportsModeSwitching("muse")).toBe(false);
    expect(supportsClientMcpServers("muse")).toBe(false);
    expect(providerCapability("muse", "steer").state).toBe("no");
    expect(providerCapability("muse", "delegationShim").state).toBe("yes");
  });

  it("starts through our ESM adapter with the user's executable", () => {
    const spec = new MuseBackend().spawn({ cliPath: "/usr/local/bin/muse", cwd: "/w", env: {} } as any);
    expect(spec.args[0]).toMatch(/muse-adapter[\\/]main\.mjs$/);
    expect(spec.env.MUSE_CODE_EXECUTABLE).toBe("/usr/local/bin/muse");
    expect(spec.shell).toBe(false);
  });

  it("gets a Settings row, connected only when consented and located", () => {
    const off = host({}).providerStateMessage();
    expect(off.providers.find((p: any) => p.id === "muse")).toEqual({ id: "muse", connected: false });
    const on = host({ muse: true }).providerStateMessage();
    expect(on.providers.find((p: any) => p.id === "muse").connected).toBe(true);
  });

  it("never reprobes Muse credentials (no status RPC) and never runs it without consent", async () => {
    const sidebar = host({});
    await expect(sidebar.reprobeProviderCredentials("muse")).resolves.toBe(false);
    await expect(sidebar.probeProviderVersion("muse")).resolves.toBe("");
  });
});

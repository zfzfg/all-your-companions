// Updating the person's own Codex / Claude CLI (upstream 22443dc, a896ba1):
// only for a connected agent, in a visible terminal, the way it was installed.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";

function harness(cliPath: string, connected = true) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const sent: string[] = [];
  sidebar.providerConnectionState = { codex: connected, claude: connected };
  sidebar.locateProvider = vi.fn(() => cliPath);
  sidebar.context = { globalStorageUri: { fsPath: "/storage" } };
  sidebar.host = {
    appendLine: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: (t: string) => sent.push(t) })),
  };
  sidebar.installManagedCodexCli = vi.fn(async () => {});
  return { sidebar, sent };
}

describe("updateProviderCli", () => {
  it("reinstalls an npm global into the prefix it actually lives in", async () => {
    const { sidebar, sent } = harness("/home/u/.local/lib/node_modules/@openai/codex/bin/codex.js");
    await sidebar.updateProviderCli("codex");
    expect(sent[0]).toMatch(/^npm install -g --prefix "\/home\/u\/\.local" @openai\/codex@/);
  });

  it("runs the CLI's own updater for a standalone install", async () => {
    const { sidebar, sent } = harness("/usr/local/bin/claude-standalone");
    await sidebar.updateProviderCli("claude");
    expect(sent[0]).toBe('"/usr/local/bin/claude-standalone" update');
  });

  it("does nothing for an agent that is not connected (#171)", async () => {
    const { sidebar, sent } = harness("/usr/local/bin/claude", false);
    await sidebar.updateProviderCli("claude");
    expect(sent).toEqual([]);
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
  });
});

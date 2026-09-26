import { describe, expect, it } from "vitest";
import { Uri, type HostWebview } from "../src/host";
import { getNonce, WebviewHtml, type WebviewHtmlDeps } from "../src/webview-html";

function deps(): WebviewHtmlDeps {
  const unused = () => {
    throw new Error("the rail document does not use this");
  };
  return {
    context: { extensionUri: Uri.file("/ext") } as WebviewHtmlDeps["context"],
    host: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } as WebviewHtmlDeps["host"],
    focused: { provider: "grok" } as WebviewHtmlDeps["focused"],
    appPurpose: () => "knowledge",
    chatFontScale: () => 100,
    voiceBackendState: unused as WebviewHtmlDeps["voiceBackendState"],
    sessionCwd: () => "/work",
    voiceSetting: ((_cwd, _key, fallback) => fallback) as WebviewHtmlDeps["voiceSetting"],
    providerStateMessage: unused as WebviewHtmlDeps["providerStateMessage"],
    providerRefreshInFlight: false,
    githubStatePayload: unused as WebviewHtmlDeps["githubStatePayload"],
    providerCliVersions: {},
    mcpServersView: [],
    mcpConnectorsMessage: unused as WebviewHtmlDeps["mcpConnectorsMessage"],
    showThinking: () => false,
  };
}

describe("webview documents", () => {
  it("mints a 32-character nonce", () => {
    expect(getNonce()).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("builds the projects rail from extensionUri and does not load chat.js", () => {
    const joined: string[] = [];
    const webview = {
      cspSource: "vscode-webview://csp",
      asWebviewUri: (uri: { toString(): string }) => {
        joined.push(uri.toString());
        return { toString: () => uri.toString() };
      },
    } as unknown as HostWebview;
    const html = new WebviewHtml(deps()).getProjectsRailHtml(webview);
    expect(html).toContain('id="projects-rail"');
    expect(html).toContain("projects-rail.js");
    expect(html).not.toContain("chat.js");
    expect(joined.some((uri) => uri.includes("/ext") && uri.includes("media"))).toBe(true);
  });
});

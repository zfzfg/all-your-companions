import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { normalizeRepoPath } from "../src/sessions";

function stubVoiceSidebar(opts: { focusedCwd?: string } = {}) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = new Session();
  sidebar.focused.cwd = opts.focusedCwd ?? "/desk";
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || opts.focusedCwd || "/desk");
  sidebar.resolveVoiceApiKey = vi.fn(() => "key");
  sidebar.defaultProviderForProject = () => "grok";
  sidebar.readDotEnv = () => ({});
  sidebar.voiceSetting = vi.fn((_c: string, _k: string, fb: unknown) => fb);
  sidebar.postLocal = vi.fn();
  sidebar.settingsEditor = { webview: { postMessage: vi.fn() } };
  sidebar.sendRemoteClient = vi.fn();
  sidebar.remoteClients = new RemoteClientState<Session>("");
  sidebar.lastVoiceConfiguredByCwd = new Map();
  sidebar.lastPostedVoiceConfigured = new Map();
  return sidebar;
}

describe("postVoiceConfigured dedupes identical frames", () => {
  it("posts once per destination when the watcher fires repeatedly", () => {
    const sidebar = stubVoiceSidebar();
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.select("phone", "/repo");

    sidebar.postVoiceConfigured();
    sidebar.postVoiceConfigured();
    sidebar.postVoiceConfigured();

    expect(sidebar.postLocal).toHaveBeenCalledTimes(1);
    expect(sidebar.settingsEditor.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(sidebar.sendRemoteClient).toHaveBeenCalledTimes(1);
    expect(sidebar.sendRemoteClient).toHaveBeenCalledWith(
      "phone",
      expect.objectContaining({ type: "voiceConfigured", value: true }),
      "/repo",
    );
  });

  it("still posts when the send phrase changes", () => {
    const sidebar = stubVoiceSidebar();
    sidebar.postVoiceConfigured();
    sidebar.voiceSetting = vi.fn((_c: string, key: string, fb: unknown) =>
      key === "voiceSendPhrase" ? "ok send" : fb,
    );
    sidebar.postVoiceConfigured();
    expect(sidebar.postLocal).toHaveBeenCalledTimes(2);
  });

  it("a snapshot seed skips the next identical watcher post for that tab", () => {
    const sidebar = stubVoiceSidebar();
    const payload = sidebar.voiceConfiguredMsg("/repo", true);
    sidebar.seedPostedVoiceConfigured("remote:phone", payload);
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.select("phone", "/repo");

    sidebar.postVoiceConfigured();

    expect(sidebar.sendRemoteClient).not.toHaveBeenCalled();
    expect(sidebar.postLocal).toHaveBeenCalledTimes(1);
  });

  it("credential-failure false does not swallow a later genuine true", () => {
    const sidebar = stubVoiceSidebar();
    const falseMsg = sidebar.voiceConfiguredMsg("/repo", false);
    sidebar.deliverVoiceConfigured("remote:phone", falseMsg, () => {
      sidebar.sendRemoteClient("phone", falseMsg, "/repo");
    });
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.select("phone", "/repo");

    sidebar.postVoiceConfigured();

    expect(sidebar.sendRemoteClient).toHaveBeenCalledTimes(2);
    expect(sidebar.sendRemoteClient.mock.calls[1][1]).toEqual(
      expect.objectContaining({ type: "voiceConfigured", value: true }),
    );
  });

  it("does not confuse the telemetry cwd map with the posted-frame cache", () => {
    const sidebar = stubVoiceSidebar({ focusedCwd: "/repo" });
    sidebar.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath("/gone"), true]]);
    sidebar.postVoiceConfigured();
    expect(sidebar.lastVoiceConfiguredByCwd.has(normalizeRepoPath("/gone"))).toBe(false);
    expect(sidebar.lastVoiceConfiguredByCwd.get(normalizeRepoPath("/repo"))).toBe(true);
    expect(sidebar.lastPostedVoiceConfigured.get("local")).toBeTruthy();
  });

  it("a recreated local webview is a new destination and gets the frame again", () => {
    const sidebar = stubVoiceSidebar();
    sidebar.postVoiceConfigured();
    sidebar.postVoiceConfigured();
    expect(sidebar.postLocal).toHaveBeenCalledTimes(1);

    sidebar.forgetPostedVoiceConfigured("local");
    sidebar.postVoiceConfigured();

    expect(sidebar.postLocal).toHaveBeenCalledTimes(2);
    expect(sidebar.postLocal.mock.calls[1][0]).toEqual(
      expect.objectContaining({ type: "voiceConfigured", value: true }),
    );
  });
});

describe("voiceConfigured cache dies with the renderer", () => {
  it("resolveWebviewView and postInitialState drop the local entry; remote release drops the tab", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const resolveStart = src.indexOf("resolveWebviewView(");
    const resolveEnd = src.indexOf("resolveProjectsRailView(", resolveStart);
    const resolveBody = src.slice(resolveStart, resolveEnd);
    expect(resolveBody).toContain('forgetPostedVoiceConfigured("local")');

    const initialStart = src.indexOf("private postInitialState(");
    const initialEnd = src.indexOf("private rehydrateWebviewFromFocused", initialStart);
    const initialBody = src.slice(initialStart, initialEnd);
    expect(initialBody).toContain('forgetPostedVoiceConfigured("local")');
    expect(initialBody.indexOf('forgetPostedVoiceConfigured("local")'))
      .toBeLessThan(initialBody.indexOf("this.postVoiceConfigured()"));

    const releaseStart = src.indexOf("private releaseRemoteClient(");
    const releaseEnd = src.indexOf("private retainRemoteClients(", releaseStart);
    expect(src.slice(releaseStart, releaseEnd)).toContain("forgetPostedVoiceConfigured(`remote:${clientId}`)");
  });
});

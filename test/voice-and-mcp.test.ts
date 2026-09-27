import { describe, expect, it, vi } from "vitest";
import { VoiceAndMcp, type VoiceAndMcpDeps } from "../src/voice-and-mcp";
import { Session } from "../src/session";

function makeHarness(opts: { focused?: Session } = {}) {
  const focused = opts.focused ?? new Session();
  focused.provider = "grok";
  focused.cwd = "/workspace";
  const posted: any[] = [];
  const emitted: any[] = [];
  const stateData: Record<string, any> = {};

  const deps: VoiceAndMcpDeps = {
    host: {
      appendLine: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showSaveDialog: vi.fn(),
      showQuickPick: vi.fn(),
      openExternal: vi.fn(),
      openSettings: vi.fn(),
      createTerminal: vi.fn(),
      getConfiguration: vi.fn(() => ({
        get: (_k: string, fallback: any) => fallback,
        inspect: () => undefined,
      })),
      isInWorkspace: vi.fn(() => true),
      canOpenSettingsEditor: true,
      openHostResolvedPath: vi.fn(),
      fs: { readFile: vi.fn(async () => new Uint8Array([1, 2, 3])) },
    },
    state: {
      get: (k: string, fb?: any) => stateData[k] ?? fb,
      update: vi.fn(async (k: string, v: any) => { stateData[k] = v; }),
    },
    context: {
      secrets: {
        get: vi.fn(async () => undefined),
        store: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      globalStorageUri: { fsPath: "/tmp/global-storage" },
    },
    getFocused: () => focused,
    getPool: () => [focused],
    voiceOps: {
      sessionCwd: () => focused.cwd || "/workspace",
      workspaceRoot: () => "/workspace",
      defaultProviderForProject: () => "grok",
      resolveSttApiKey: vi.fn(() => "test-stt-key"),
      voiceBackendState: vi.fn(() => ({ backend: "xai", backends: { grok: "xai" } })),
      postLocal: (msg) => { posted.push(msg); },
      post: (msg) => { posted.push(msg); },
    },
    mcpOps: {
      connectedProviders: () => ["grok"],
      newLocalSession: () => new Session(),
      setSessionCwd: vi.fn(),
      startSession: vi.fn(async () => {}),
      askUserMcpServer: vi.fn(async () => undefined),
      companionsMcpServer: vi.fn(async () => undefined),
      noteCompanionsSkip: vi.fn(),
      postWelcomeTips: vi.fn(),
      getSettingsWebview: () => undefined,
    },
    mediaOps: {
      emit: (_s, msg) => { emitted.push(msg); },
      getViewWebview: () => undefined,
      isImagePathAuthorizedNow: vi.fn(() => true),
      registerFullImage: vi.fn(() => "handle-123"),
      importImageFromDisk: vi.fn(async () => focused),
      postChips: vi.fn(),
    },
  };

  const vm = new VoiceAndMcp(deps);
  return { vm, deps, focused, posted, emitted, stateData };
}

describe("VoiceAndMcp Subsystem", () => {
  describe("voice lifecycle & state", () => {
    it("claims and releases voice cwd properly", () => {
      const { vm } = makeHarness();
      expect(vm.claimVoice("/workspace/repoA")).toBe(true);
      expect(vm.localVoiceCwd).toBe("/workspace/repoA");
      expect(vm.claimVoice("/workspace/repoB")).toBe(false);

      vm.releaseVoice("/workspace/other");
      expect(vm.localVoiceCwd).toBe("/workspace/repoA");

      vm.releaseVoice("/workspace/repoA");
      expect(vm.localVoiceCwd).toBeUndefined();
    });

    it("rejectVoiceStart posts voiceError and shows warning", () => {
      const { vm, deps, posted } = makeHarness();
      vm.rejectVoiceStart();
      expect(posted).toContainEqual({ type: "voiceError" });
      expect(deps.host.showWarningMessage).toHaveBeenCalledWith("Voice control is already active.");
    });

    it("postVoiceConfigured broadcasts voiceConfigured frame", () => {
      const { vm, posted } = makeHarness();
      vm.postVoiceConfigured();
      expect(posted.length).toBeGreaterThan(0);
      expect(posted[0]).toMatchObject({
        type: "voiceConfigured",
        value: true,
      });
    });

    it("stopVoiceInput clears streamer, recorder, and active context", () => {
      const { vm, posted } = makeHarness();
      vm.localVoiceCwd = "/workspace";
      vm.voiceFinalizing = true;
      const initialGen = vm.voiceGeneration;

      vm.stopVoiceInput();
      expect(vm.voiceGeneration).toBe(initialGen + 1);
      expect(vm.localVoiceCwd).toBeUndefined();
      expect(vm.voiceFinalizing).toBe(false);
      expect(posted).toContainEqual({ type: "voiceState", status: "idle" });
    });
  });

  describe("mcp connectors and notifications", () => {
    it("returns connected connector store from persisted state", () => {
      const { vm, stateData } = makeHarness();
      stateData["grok.mcpConnectors"] = {
        github: { endpoint: "https://api.github.com", readOnly: false },
      };
      const store = vm.connectedConnectorStore();
      expect(store.github).toBeDefined();
      expect(store.github.endpoint).toBe("https://api.github.com");
    });

    it("mcpConnectorsMessage constructs structured host message", () => {
      const { vm, stateData } = makeHarness();
      stateData["grok.mcpConnectors"] = {};
      const msg = vm.mcpConnectorsMessage();
      expect(msg.type).toBe("mcpConnectors");
      expect(Array.isArray(msg.connectors)).toBe(true);
    });

    it("applyMcpNotification handles null support safely", () => {
      const { vm, focused } = makeHarness();
      vm.mcpListSupported = false;
      vm.applyMcpNotification(focused, "notifications/tools/list_changed", {});
      expect(vm.mcpServers).toHaveLength(0);
    });
  });

  describe("media and dropped files", () => {
    it("isServableFromDisk rejects arbitrary paths outside grok/codex homes", () => {
      const { vm } = makeHarness();
      expect(vm.isServableFromDisk("/etc/passwd", "grok")).toBe(false);
      expect(vm.isServableFromDisk("C:\\Windows\\System32\\cmd.exe", "grok")).toBe(false);
    });

    it("postGeneratedMedia handles inline data within size cap", async () => {
      const { vm, focused, emitted } = makeHarness();
      const b64 = Buffer.from("hello world").toString("base64");
      await vm.postGeneratedMedia(
        { kind: "data", media: "image", mimeType: "image/png", data: b64 },
        focused,
        1,
      );
      expect(emitted).toContainEqual({
        type: "media",
        media: "image",
        src: `data:image/png;base64,${b64}`,
      });
    });

    it("addDroppedFile drops nonexistent files gracefully", async () => {
      const { vm, focused } = makeHarness();
      const res = await vm.addDroppedFile("/nonexistent/file.txt", false, () => focused);
      expect(res).toBeUndefined();
    });
  });
});

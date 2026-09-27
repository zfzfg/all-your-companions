import { describe, expect, it, vi } from "vitest";
import {
  createSidebarStateHost,
  type SidebarStateHostDeps,
} from "../src/sidebar-state-host";
import { Session } from "../src/session";
import { Uri } from "../src/host";

describe("SidebarStateHost", () => {
  function makeHarness() {
    const store = new Map<string, any>();
    const posted: any[] = [];
    const emitted: any[] = [];
    const focusedSession = new Session();

    const deps: SidebarStateHostDeps = {
      host: {
        getConfiguration: vi.fn(() => ({
          get: (key: string, def: any) => def,
        })),
        canSwitchWorkspaceFolder: false,
        canRelocateView: true,
        canUseSecondarySideBar: true,
        canShowOutput: true,
        canToggleDevTools: false,
        canShowMcpSettings: false,
        canOpenInEditor: true,
        canServeMediaRanges: false,
        canShowInFolder: true,
        canPreviewInApp: false,
        canOpenSettingsEditor: false,
      } as any,
      state: {
        get: <T>(k: string, def?: T): T => (store.get(k) ?? def) as T,
        update: vi.fn(async (k: string, val: any) => { store.set(k, val); }),
      },
      context: {
        extensionVersion: "0.2.0",
      } as any,
      getFocused: () => focusedSession,
      getView: () => undefined,
      post: (msg) => posted.push(msg),
      emit: (_session, msg) => emitted.push(msg),
      workspaceRoot: () => "/workspace",
      canAddProjectFolder: () => false,
      touch: vi.fn(),
      markRead: vi.fn(),
      refreshWorkflowCompletions: vi.fn(),
      displayMode: () => "agent",
      postWorkflowList: vi.fn(),
      postMode: vi.fn(),
      postRepoCatalog: vi.fn(),
      postSessionsList: vi.fn(),
      postSessionName: vi.fn(),
      registerFullImage: vi.fn((p: string) => `handle:${p}`),
    };

    const host = createSidebarStateHost(deps);
    return { host, deps, store, posted, emitted, focusedSession };
  }

  it("builds initial state message with default config and capabilities", () => {
    const { host } = makeHarness();
    const msg = host.buildInitialStateMsg();
    expect(msg.type).toBe("initialState");
    expect(msg.extVersion).toBe("0.2.0");
    expect(msg.cwd).toBe("/workspace");
    expect(msg.hostKind).toBe("extension");
    expect(msg.capabilities.relocateView).toBe(true);
  });

  it("retires move view hint and posts update", async () => {
    const { host, store, posted } = makeHarness();
    await host.retireMoveViewHint();
    expect(store.get("grok.moveViewPickerUsed")).toBe(true);
    expect(posted).toContainEqual({ type: "moveViewHint", value: false });
  });

  it("localPreviewChips maps image chips with previewSrc and fullId", () => {
    const { host, focusedSession } = makeHarness();
    const mockWebview = {
      asWebviewUri: (uri: Uri) => `webview://${uri.fsPath}`,
    } as any;

    const fileChip = {
      id: "c1",
      hidden: false,
      kind: "file" as const,
      path: "/workspace/photo.png",
      relPath: "photo.png",
      mimeType: "image/png",
      imageIndex: 0,
    };
    focusedSession.chips = [fileChip];

    const preview = host.localPreviewChips(focusedSession, mockWebview);
    expect(preview).toHaveLength(1);
    expect((preview[0] as any).previewSrc).toBe("webview:///workspace/photo.png");
    expect((preview[0] as any).fullId).toBe("handle:/workspace/photo.png");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createPermissionHost,
  GrokDiffContentProvider,
  type PermissionHostDeps,
} from "../src/permission-host";
import { Session } from "../src/session";
import { Uri } from "../src/host";

describe("PermissionHost", () => {
  function makeHarness() {
    const store = new Map<string, any>();
    const posted: any[] = [];
    const emitted: any[] = [];
    const deps: PermissionHostDeps = {
      host: {
        appendLine: vi.fn(),
        showWarningMessage: vi.fn(async () => "Continue anyway"),
      } as any,
      state: {
        get: <T>(k: string, def?: T): T => (store.get(k) ?? def) as T,
        update: vi.fn(async (k: string, val: any) => { store.set(k, val); }),
      },
      emit: (_session, msg) => emitted.push(msg),
      post: (msg) => posted.push(msg),
      sessionCwd: () => "/workspace",
      workspaceRoot: () => "/workspace",
      getFocused: () => new Session(),
      getSettingsWebview: () => undefined,
      confirmInChat: vi.fn(async () => true),
    };
    const permissionHost = createPermissionHost(deps);
    return { permissionHost, deps, store, posted, emitted };
  }

  it("loads empty permission rule state initially", () => {
    const { permissionHost } = makeHarness();
    const state = permissionHost.loadPermissionRuleState("/workspace");
    expect(state.global).toEqual([]);
    expect(state.active).toEqual([]);
  });

  it("GrokDiffContentProvider provides and clears text contents", () => {
    const provider = new GrokDiffContentProvider();
    const uri1 = Uri.file("/file1.ts");
    const uri2 = Uri.file("/file2.ts");

    provider.set(uri1, "content1");
    provider.set(uri2, "content2");

    expect(provider.provideTextDocumentContent(uri1)).toBe("content1");
    expect(provider.provideTextDocumentContent(uri2)).toBe("content2");

    provider.delete(uri1);
    expect(provider.provideTextDocumentContent(uri1)).toBe("");
    expect(provider.provideTextDocumentContent(uri2)).toBe("content2");
  });

  it("handles ruleFileFs operations via host.fs", async () => {
    const { permissionHost, deps } = makeHarness();
    const statMock = vi.fn(async () => ({ type: 1, size: 42 }));
    const readMock = vi.fn(async () => Buffer.from("hello world", "utf8"));
    const writeMock = vi.fn(async () => {});
    const mkdirMock = vi.fn(async () => {});

    (deps.host as any).fs = {
      stat: statMock,
      readFile: readMock,
      writeFile: writeMock,
      createDirectory: mkdirMock,
    } as any;

    const fsWrapper = permissionHost.ruleFileFs();
    const statRes = await fsWrapper.stat("/workspace/rule.md");
    expect(statRes).toEqual({ isDirectory: false, size: 42 });

    const textRes = await fsWrapper.readText("/workspace/rule.md");
    expect(textRes).toBe("hello world");

    await fsWrapper.writeText("/workspace/rule.md", "new text");
    expect(writeMock).toHaveBeenCalled();

    await fsWrapper.mkdir("/workspace/dir");
    expect(mkdirMock).toHaveBeenCalled();
  });

  it("posts rule files to both sidebar post and settings webview", () => {
    const { permissionHost, deps, posted } = makeHarness();
    const settingsPosted: any[] = [];
    deps.getSettingsWebview = () => ({
      postMessage: vi.fn(async (m) => {
        settingsPosted.push(m);
        return true;
      }),
    });

    permissionHost.postRuleFiles([{
      scope: "project",
      kind: "file",
      label: "AGENT.md",
      path: "/workspace/AGENT.md",
      exists: true,
      providers: ["grok"],
    }]);

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("ruleFiles");
    expect(settingsPosted).toHaveLength(1);
    expect(settingsPosted[0].type).toBe("ruleFiles");
  });
});

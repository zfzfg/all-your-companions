import { describe, expect, it, vi } from "vitest";
import { ProjectFolders, type ProjectFoldersDeps } from "../src/project-folders";
import { Session } from "../src/session";

function createMockDeps(overrides: Partial<ProjectFoldersDeps> = {}): {
  deps: ProjectFoldersDeps;
  disposed: Session[];
  posted: any[];
  emitted: any[];
  stateStore: Record<string, any>;
} {
  const disposed: Session[] = [];
  const posted: any[] = [];
  const emitted: any[] = [];
  const stateStore: Record<string, any> = {};

  const focused = new Session();
  focused.cwd = "/workspace/project1";
  const pool = new Set<Session>([focused]);

  const deps: ProjectFoldersDeps = {
    host: {
      canSwitchWorkspaceFolder: true,
      workspaceRoot: () => "/workspace/project1",
      openWorkspaceFolders: () => ["/workspace/project1"],
      showOpenDialog: vi.fn(async () => ["/workspace/project2"]),
      showWarningMessage: vi.fn(async () => "Hide anyway"),
      addWorkspaceFolder: vi.fn(() => true),
      removeWorkspaceFolder: vi.fn(() => true),
      setActiveWorkspaceFolder: vi.fn(() => true),
      appendLine: vi.fn(),
      createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
    },
    state: {
      get: vi.fn((key: string, def?: any) => (key in stateStore ? stateStore[key] : def)),
      update: vi.fn(async (key: string, val: any) => {
        stateStore[key] = val;
      }),
    },
    context: {
      globalState: {
        get: vi.fn((key: string, def?: any) => (key in stateStore ? stateStore[key] : def)),
        update: vi.fn(async (key: string, val: any) => {
          stateStore[key] = val;
        }),
      } as any,
      globalStorageUri: { fsPath: "/storage" } as any,
    },
    sessionOps: {
      getFocused: () => focused,
      setFocused: vi.fn(),
      getPool: () => pool,
      newLocalSession: () => new Session(),
      sessionCwd: (s) => s.cwd || "/workspace/project1",
      setSessionCwd: vi.fn(),
      startSession: vi.fn(async () => true),
      parkFocused: vi.fn(),
      disposeSession: vi.fn(async (s) => {
        disposed.push(s);
      }),
      defaultProviderForProject: () => "grok",
      isAuthorizedCwd: () => true,
    },
    uiOps: {
      emit: vi.fn((_s, msg) => {
        emitted.push(msg);
      }),
      post: vi.fn((msg) => {
        posted.push(msg);
      }),
      postRepoCatalog: vi.fn(),
      postSessionsList: vi.fn(),
      getSelectedRepoCwd: () => "/workspace/project1",
      setSelectedRepoCwd: vi.fn(),
      getSettingsEditorWebview: () => undefined,
    },
    catalogOps: {
      resolveLocalRepoTarget: vi.fn((cwd) => ({ cwd })),
      workspaceRoot: () => "/workspace/project1",
      extraProjectFolders: () => ["/extra/dir"],
      canAddProjectFolder: () => true,
      getWorktreeCache: () => [],
      setWorktreeCache: vi.fn(),
      getAuthEpoch: () => 1,
      bumpAuthEpoch: vi.fn(() => 2),
    },
    mediaOps: {
      getFullImagePaths: () => new Map(),
      getFullImageHandles: () => new Map(),
      getLocalVoiceCwd: () => undefined,
      getLocalVoiceCredentialCwd: () => undefined,
      stopVoiceInput: vi.fn(),
    },
    localWorkspaceSwitchQueue: {
      run: vi.fn(async (fn: () => any) => fn()),
    } as any,
    ...overrides,
  };

  return { deps, disposed, posted, emitted, stateStore };
}

describe("ProjectFolders", () => {
  it("formats project setup message with sanitized root", () => {
    const { deps } = createMockDeps();
    const pf = new ProjectFolders(deps);
    const msg = pf.projectSetupMessage({ busy: "new" });
    expect(msg.type).toBe("projectSetup");
    expect(msg.busy).toBe("new");
    expect(msg.root).toBeDefined();
  });

  it("handles validation error in createProject gracefully", async () => {
    const { deps, posted } = createMockDeps();
    const pf = new ProjectFolders(deps);
    await pf.createProject("   ");
    expect(posted).toContainEqual(expect.objectContaining({ type: "projectSetup", error: expect.any(String) }));
  });

  it("handles validation error in cloneProject gracefully", async () => {
    const { deps, posted } = createMockDeps();
    const pf = new ProjectFolders(deps);
    await pf.cloneProject("not a valid url");
    expect(posted).toContainEqual(expect.objectContaining({ type: "projectSetup", error: expect.any(String) }));
  });

  it("identifies sessions bound to a given closed folder", () => {
    const { deps } = createMockDeps();
    const pf = new ProjectFolders(deps);

    const s1 = new Session();
    s1.cwd = "/workspace/folderA";
    const s2 = new Session();
    s2.cwd = "/workspace/folderB";
    deps.sessionOps.getPool = () => new Set([s1, s2]);
    deps.sessionOps.getFocused = () => s1;
    deps.sessionOps.sessionCwd = (s) => s.cwd || "";

    const boundA = pf.sessionsBoundToFolder("/workspace/folderA");
    expect(boundA).toHaveLength(1);
    expect(boundA[0]).toBe(s1);

    const boundB = pf.sessionsBoundToFolder("/workspace/folderB");
    expect(boundB).toHaveLength(1);
    expect(boundB[0]).toBe(s2);
  });

  it("revokes closed project folder and disposes doomed sessions", () => {
    const { deps, disposed } = createMockDeps();
    const pf = new ProjectFolders(deps);

    const s = new Session();
    s.cwd = "/closed/folder";
    deps.sessionOps.getPool = () => new Set([s]);
    deps.sessionOps.getFocused = () => s;
    deps.sessionOps.sessionCwd = () => "/closed/folder";

    pf.revokeClosedProjectFolder("/closed/folder");
    expect(disposed).toContain(s);
    expect(deps.catalogOps.bumpAuthEpoch).toHaveBeenCalled();
  });

  it("supports getOverride on methods", async () => {
    const overridden = vi.fn(async () => {});
    const { deps } = createMockDeps({
      getOverride: ((name: string) => (name === "addProjectFolder" ? overridden : undefined)) as any,
    });
    const pf = new ProjectFolders(deps);
    await pf.addProjectFolder("/path");
    expect(overridden).toHaveBeenCalledWith("/path");
  });
});

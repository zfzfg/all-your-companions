import { describe, expect, it, vi } from "vitest";
import { WorktreeHost, SESSION_META_KEY, type WorktreeHostDeps } from "../src/worktree-host";
import type { Host } from "../src/host";
import { Session } from "../src/session";

function makeDeps(overrides: Partial<WorktreeHostDeps> = {}): { deps: WorktreeHostDeps; infoMessages: string[] } {
  const infoMessages: string[] = [];
  const defaultHost = {
    showInformationMessage: vi.fn((msg: string) => {
      infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    appendLine: vi.fn(),
  } as unknown as Host;

  const currentSession = new Session();
  currentSession.activeSessionId = "sess-1";
  currentSession.provider = "grok";
  currentSession.cwd = "/workspace/repo";

  const deps: WorktreeHostDeps = {
    host: defaultHost,
    focused: currentSession,
    pool: new Set([currentSession]),
    state: {
      get: vi.fn((_key: string, fallback: unknown) => fallback),
      update: vi.fn(),
    } as any,
    sessionCache: new Map(),
    workspaceRoot: () => "/workspace/repo",
    sessionCwd: (s) => s.cwd ?? "",
    historyCwdFor: () => "/workspace/repo",
    openWorkspaceFolders: () => ["/workspace/repo"],
    resolveLocalRepoTarget: () => undefined,
    newLocalSession: () => {
      const s = new Session();
      s.activeSessionId = "sess-new";
      s.provider = "grok";
      return s;
    },
    parkFocused: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    postSessionsList: vi.fn(),
    removeSessionFromDisk: vi.fn().mockReturnValue(true),
    confirmInChat: vi.fn().mockResolvedValue(true),
    detachClient: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };

  return { deps, infoMessages };
}

describe("WorktreeHost", () => {
  it("exports the standard SESSION_META_KEY constant", () => {
    expect(SESSION_META_KEY).toBe("grok.sessionMeta");
  });

  it("refuses to create a nested worktree when already in one", async () => {
    const { deps, infoMessages } = makeDeps();
    deps.focused.worktree = {
      path: "/workspace/repo-wt",
      label: "feat-test",
      sourceGitRoot: "/workspace/repo",
    };

    const host = new WorktreeHost(deps);
    await host.newWorktreeSession();

    expect(infoMessages.some((m) => m.includes("already in a worktree"))).toBe(true);
  });

  it("informs when trying to apply a session that is not in a worktree", async () => {
    const { deps, infoMessages } = makeDeps();
    deps.focused.worktree = undefined;

    const host = new WorktreeHost(deps);
    await host.applyFocusedWorktree(deps.focused);

    expect(infoMessages.some((m) => m.includes("not in a worktree"))).toBe(true);
  });

  it("informs when trying to remove a session that is not in a worktree", async () => {
    const { deps, infoMessages } = makeDeps();
    deps.focused.worktree = undefined;

    const host = new WorktreeHost(deps);
    await host.removeFocusedWorktree(deps.focused);

    expect(infoMessages.some((m) => m.includes("not in a worktree"))).toBe(true);
  });

  it("manages worktreeCache and localWorktrees accessors", () => {
    const { deps } = makeDeps();
    const host = new WorktreeHost(deps);

    expect(host.worktreeCache).toEqual([]);
    host.worktreeCache = [
      {
        id: "wt-1",
        path: "/wt/1",
        sourceRepo: "/repo",
        repoName: "repo",
        kind: "session",
        creationMode: "linked",
        gitRef: "HEAD",
        headCommit: "",
        status: "alive",
        label: "wt-1",
        userProvidedLabel: true,
      },
    ];
    expect(host.worktreeCache).toHaveLength(1);
    expect(host.worktreeCache[0].id).toBe("wt-1");

    expect(host.localWorktrees).toBeUndefined();
    const fakeLw = {} as any;
    host.localWorktrees = fakeLw;
    expect(host.localWorktrees).toBe(fakeLw);
  });
});

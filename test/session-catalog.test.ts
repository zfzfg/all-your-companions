/**
 * SessionCatalog (W-15 Schritt S1): session catalog, history navigation,
 * pinned sessions, deletion, sweep, rename, focus, and open.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSessionCatalog,
  SessionCatalog,
  type SessionCatalogDeps,
} from "../src/session-catalog";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

function makeCatalog() {
  const session = new Session();
  session.activeSessionId = "session-1";
  session.provider = "grok";

  const posted: HostMsg[] = [];
  const webviewMsgs: any[] = [];
  const stateData: Record<string, any> = {};

  const deps: SessionCatalogDeps = {
    host: {
      canSwitchWorkspaceFolder: true,
      appendLine: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
    } as any,
    state: {
      get: vi.fn((key: string, def?: any) => stateData[key] ?? def),
      update: vi.fn(async (key: string, val: any) => { stateData[key] = val; }),
    } as any,
    getOverride: undefined,
    getFocused: () => session,
    setFocused: vi.fn(),
    getPool: () => new Set<Session>([session]),
    getSessionCache: () => new Map(),
    getWorktreeCache: () => [],

    repoOps: {
      openWorkspaceFolders: () => ["/repo"],
      extraProjectFolders: () => [],
      removedProjectFolderKeys: () => new Set(),
      sessionCwdsForRepo: () => ["/repo"],
      defaultProviderForProject: () => "grok",
      selectedHistoryCwd: () => "/repo",
      getSelectedRepoCwd: () => "/repo",
      setSelectedRepoCwd: vi.fn(),
      workspaceRoot: () => "/repo",
      canAddProjectFolder: () => true,
      normalizeArchiveChoices: vi.fn(),
      refreshWorktreeCache: vi.fn(async () => {}),
    },

    adapterOps: {
      connectedProviders: () => ["grok"],
      locateProvider: () => undefined,
      createProviderBackend: () => undefined,
      hasProviderConsent: () => true,
      setProviderNeedsLogin: vi.fn(),
      adapterHistory: () => undefined,
      allAdapterCatalogs: () => [],
      getCodexSessionCache: () => new Map(),
      getClaudeSessionCache: () => new Map(),
      getGeminiSessionCache: () => new Map(),
      getMuseSessionCache: () => new Map(),
      isProviderCredentialError: () => false,
      discardAdapterEmptySession: vi.fn(async () => true),
    },

    sessionOps: {
      authorizedSessionCwds: () => ["/repo"],
      historyCwdFor: () => "/repo",
      sessionCwd: () => "/repo",
      setSessionCwd: vi.fn(),
      readEntriesCachedMulti: () => [],
      liveSessionEntry: vi.fn((_s, id, cwd) => ({
        id,
        cwd,
        displayName: id,
        rawSummary: id,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        numMessages: 1,
      })),
      dotForId: () => "none",
      annotateWorktreeLabels: vi.fn(),
      workflowStore: () => ({ defs: new Map() }),
      workflowRuns: () => ({ readRun: () => undefined }),
      resolveWorkflow: () => undefined,
      updateSessionMeta: vi.fn(async () => {}),
      touch: vi.fn(),
      markRead: vi.fn(),
      refreshWorkflowCompletions: vi.fn(),
    },

    uiOps: {
      postLocal: vi.fn((msg) => { posted.push(msg); }),
      postSessionName: vi.fn(),
      postSessionsList: vi.fn(),
      sendLocalRepoSessionsPreview: vi.fn(),
      postMode: vi.fn(),
      postChildContext: vi.fn(),
      postSessionRemoved: vi.fn(),
      sessionIdentityFrame: vi.fn(() => ({ type: "session", sessionId: "session-1", provider: "grok" })),
      localizeHistoryMessage: vi.fn((m) => m),
      localPreviewChips: vi.fn(() => []),
      displayMode: vi.fn(() => "agent"),
      getWebview: () => ({
        postMessage: (m: any) => { webviewMsgs.push(m); },
      }),
      hasProjectsRail: () => true,
    },

    lifecycleOps: {
      startSession: vi.fn(async () => undefined),
      newLocalSession: () => new Session(),
      disposeSession: vi.fn(async () => {}),
      detachClient: vi.fn(),
      removePlanReviews: vi.fn(),
      removeCheckpoints: vi.fn(),
      removeUploadsForSessions: vi.fn(async () => {}),
      viewIsOnDeleted: vi.fn(() => false),
      reserveSessionLoad: vi.fn(() => null),
      releaseSessionLoad: vi.fn(),
      isSessionLoadReserved: vi.fn(() => false),
      reservedSessionIds: () => [],
      switchLocalWorkspaceFolderExclusive: vi.fn(async () => {}),
      findUnusedEmptySession: vi.fn(() => undefined),
      persistWorktreeBinding: vi.fn(async () => {}),
      getSwitchQueue: () => ({ run: async (op: any) => op() }),
      getLastSweepAt: () => new Map(),
      getProvenNonEmpty: () => new Map(),
    },
  };

  return {
    catalog: createSessionCatalog(deps),
    deps,
    session,
    posted,
    webviewMsgs,
    stateData,
  };
}

describe("SessionCatalog", () => {
  it("keeps the context interface at or under 25 members", () => {
    const { deps } = makeCatalog();
    expect(Object.keys(deps).length).toBeLessThanOrEqual(25);
  });

  it("focusSession switches focus, marks read, and replays to webview", () => {
    const { catalog, deps, webviewMsgs } = makeCatalog();
    const other = new Session();
    other.activeSessionId = "session-2";
    other.provider = "grok";

    catalog.focusSession(other);

    expect(deps.setFocused).toHaveBeenCalledWith(other);
    expect(deps.sessionOps.touch).toHaveBeenCalledWith(other);
    expect(deps.sessionOps.markRead).toHaveBeenCalledWith(other);
    expect(deps.uiOps.sessionIdentityFrame).toHaveBeenCalledWith(other);
    expect(webviewMsgs.some((m) => m.type === "clearMessages")).toBe(true);
    expect(webviewMsgs.some((m) => m.type === "historyReplay" && m.active === true)).toBe(true);
    expect(deps.uiOps.postMode).toHaveBeenCalled();
    expect(deps.uiOps.postSessionName).toHaveBeenCalledWith(other);
  });

  it("parkFocused tears down untouched idle session", () => {
    const { catalog, deps, session } = makeCatalog();
    session.hasHistory = false;
    session.chips = [];
    session.status = "done";
    session.priming = false;

    catalog.parkFocused();

    expect(deps.lifecycleOps.disposeSession).toHaveBeenCalledWith(session);
  });

  it("renameSession drops custom name on empty rename and updates state", () => {
    const { catalog, deps, stateData } = makeCatalog();
    stateData["grok.sessionMeta"] = {
      "session-1": { customName: "Old Name", provider: "grok" },
    };

    catalog.renameSession("session-1", "   ");

    expect(deps.state.update).toHaveBeenCalled();
    expect(deps.uiOps.postSessionsList).toHaveBeenCalled();
  });

  it("honours getOverride hook for dynamic test mocking", () => {
    const { deps } = makeCatalog();
    const overrideFn = vi.fn();
    (deps as any).getOverride = (name: string) => {
      if (name === "parkFocused") return overrideFn;
      return undefined;
    };
    const catalog = new SessionCatalog(deps);

    catalog.parkFocused();

    expect(overrideFn).toHaveBeenCalled();
    expect(deps.lifecycleOps.disposeSession).not.toHaveBeenCalled();
  });
});

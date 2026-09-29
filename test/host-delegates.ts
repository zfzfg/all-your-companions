// Sidebar methods that moved into QuestionHost / ReviewHost are thin
// delegators. A prototype stub has to install the real collaborators or the
// first call throws on a missing field.
import { ProviderSetup } from "../src/provider-setup";
import { QuestionHost } from "../src/question-host";
import { ReviewHost } from "../src/review-host";
import { WorktreeHost } from "../src/worktree-host";

export function wireExtractedHosts(sidebar: any): void {
  sidebar.emit = sidebar.emit ?? (() => {});
  sidebar.host = sidebar.host ?? {};
  sidebar.host.appendLine = sidebar.host.appendLine ?? (() => {});
  sidebar.host.getConfiguration = sidebar.host.getConfiguration ?? (() => ({ get: (_k: string, d: unknown) => d }));
  sidebar.questionHost = new QuestionHost({
    get host() { return sidebar.host; },
    emit: (...args) => sidebar.emit(...args),
    setStatus: (...args) => sidebar.setStatus?.(...args),
    get hostPipeMux() { return sidebar.hostPipeMux; },
    set hostPipeMux(value) { sidebar.hostPipeMux = value; },
    get askUserChannel() { return sidebar.askUserChannel; },
    set askUserChannel(value) { sidebar.askUserChannel = value; },
    get context() { return sidebar.context; },
    get pool() { return sidebar.pool; },
    reservedMcpIdentityFor: (...args) => sidebar.reservedMcpIdentityFor?.(...args),
    touch: (...args) => sidebar.touch?.(...args),
  });
  sidebar.reviewHost = new ReviewHost({
    get diffSeq() { return sidebar.diffSeq ?? 0; },
    set diffSeq(value) { sidebar.diffSeq = value; },
    get diffProvider() { return sidebar.diffProvider; },
    get openDiffsByRequest() { return sidebar.openDiffsByRequest; },
    get host() { return sidebar.host; },
    sessionCwd: (...args) => sidebar.sessionCwd?.(...args) ?? "",
    emit: (...args) => sidebar.emit(...args),
    get checkpointStore() { return sidebar.checkpointStore; },
    confirmInChat: (...args) => sidebar.confirmInChat?.(...args),
    createPlanReviewSnapshot: (...args) => sidebar.createPlanReviewSnapshot?.(...args),
    syncHumanWait: (...args) => sidebar.questionHost.syncHumanWait(...args),
    setStatus: (...args) => sidebar.setStatus?.(...args),
    get turnGitBaselines() { return sidebar.turnGitBaselines; },
    get gitRunGate() { return sidebar.gitRunGate; },
    notifyUser: (...args) => sidebar.notifyUser?.(...args),
    truncateSessionCardsAfterRewind: (...args) => sidebar.truncateSessionCardsAfterRewind?.(...args),
    applyRewindToView: (...args) => sidebar.applyRewindToView?.(...args),
    restoreComposerFor: (...args) => sidebar.restoreComposerFor?.(...args),
  });
  sidebar.worktreeHost = new WorktreeHost({
    get host() { return sidebar.host; },
    get focused() { return sidebar.focused; },
    set focused(value) { sidebar.focused = value; },
    get pool() { return sidebar.pool ?? new Set(); },
    get state() { return sidebar.state; },
    get sessionCache() { return sidebar.sessionCache ?? new Map(); },
    workspaceRoot: () => sidebar.workspaceRoot?.() ?? "",
    sessionCwd: (...args) => sidebar.sessionCwd?.(...args) ?? "",
    historyCwdFor: () => sidebar.historyCwdFor?.() ?? "",
    openWorkspaceFolders: () => sidebar.openWorkspaceFolders?.() ?? [],
    resolveLocalRepoTarget: (...args) => sidebar.resolveLocalRepoTarget?.(...args),
    newLocalSession: (...args) => sidebar.newLocalSession?.(...args),
    parkFocused: () => sidebar.parkFocused?.(),
    startSession: (...args) => sidebar.startSession?.(...args),
    postSessionsList: () => sidebar.postSessionsList?.(),
    removeSessionFromDisk: (...args) => sidebar.removeSessionFromDisk?.(...args) ?? false,
    confirmInChat: (...args) => sidebar.confirmInChat?.(...args) ?? Promise.resolve(false),
    detachClient: (...args) => sidebar.detachClient?.(...args),
  });
  sidebar.providerSetup = new ProviderSetup({
    sidebarOps: {
      get host() { return sidebar.host; },
      grokCompactThresholdSetting: () => sidebar.grokCompactThresholdSetting?.() ?? 80,
      companionsSetting: (_key, fallback) => fallback,
    },
    get host() { return sidebar.host; },
    get context() { return sidebar.context; },
    get state() { return sidebar.state; },
    get providerCliVersions() { return sidebar.providerCliVersions ?? {}; },
    workspaceRoot: () => sidebar.workspaceRoot?.() ?? "",
    post: (...args) => sidebar.post?.(...args),
    postLocal: (...args) => sidebar.postLocal?.(...args),
    postToSettingsEditor: (...args) => { void sidebar.settingsEditor?.webview?.postMessage?.(...args); },
    cacheProviderModels: (...args) => sidebar.cacheProviderModels?.(...args) ?? Promise.resolve(),
    probeProviderVersion: (...args) => sidebar.probeProviderVersion?.(...args) ?? Promise.resolve(""),
    invalidateSubscriptionUsage: (...args) => sidebar.invalidateSubscriptionUsage?.(...args),
    rearmAuthRecovery: (...args) => sidebar.rearmAuthRecovery?.(...args),
    refreshGithubState: () => sidebar.refreshGithubState?.() ?? Promise.resolve(),
    buildEnv: (...args) => sidebar.buildEnv?.(...args) ?? {},
    removeSessionFromDisk: (...args) => sidebar.removeSessionFromDisk?.(...args) ?? true,
    getOverride: (name: string) => {
      if (Object.prototype.hasOwnProperty.call(sidebar, name)) {
        return sidebar[name];
      }
      return undefined;
    },
  });
}


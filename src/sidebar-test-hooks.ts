/**
 * Test hooks seam for integration testing of GrokSidebar against the extension host.
 * Extracted from GrokSidebar as part of W-15 (Step S7a).
 */

import type { HostMsg, WebviewMsg } from "./protocol";
import type { PromptUsage } from "./acp-dispatch";
import { enforceCompleteSessionCost, sumUsage } from "./acp-dispatch";
import type { FileChip } from "./chips";
import type { Session } from "./session";
import type { AcpClient } from "./acp";
import type { SessionMetaOverrides } from "./sessions";
import { SESSION_META_KEY } from "./worktree-host";

export interface SidebarTestHooks {
  onPost(fn: (message: HostMsg) => void): void;
  fromLocal(message: WebviewMsg): Promise<void>;
  replayFocused(messages: HostMsg[], during?: () => void, fail?: boolean): Promise<void>;
  seedFocusedSession(
    id: string,
    cwd: string,
    messages?: HostMsg[],
    hasHistory?: boolean,
    chips?: FileChip[],
  ): void;
  seedLocalBackgroundSession(id: string, cwd: string): void;
  openLocalSession(id: string, cwd: string): Promise<void>;
  emitContextUsage(): void;
  seedUsageLedger(
    entries: { afterUserMessage: number; afterHistoryEvent?: number; usage?: PromptUsage }[],
    userMessageCount: number,
  ): Promise<void>;
  restartUsageSession(
    id: string,
    mode: "clear" | "summarize",
    summaryUsage?: PromptUsage,
  ): Promise<void>;
  rewindUsageLedger(surviving: number): Promise<void>;
  completeUsageTurn(usage: PromptUsage): Promise<void>;
  reloadUsageLedger(userMessageCount: number): {
    usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
    sessionUsage: PromptUsage | undefined;
  };
  delayNextSessionStart(resumeId?: string): { started: Promise<void>; release(): void };
  seedFocusedWorktreeSession(
    id: string,
    worktree: NonNullable<Session["worktree"]>,
  ): {
    applyCount(): number;
    removeCount(): number;
    lastApplyPath(): string | undefined;
    lastRemovePath(): string | undefined;
    restore(): void;
  };
  isolateFromInstalledGrok(): void;
  locatedGrokCli(): string | undefined;
  provisionFakeGrok(cliPath: string): () => void;
  sweepEmptySessions(cwd: string): void;
  workspaceRoot(): string;
}

export function createSidebarTestHooks(sidebar: any): SidebarTestHooks {
  return {
    onPost: (fn) => {
      sidebar.postTap = fn;
    },
    fromLocal: (message) => sidebar.onMessage(message),
    replayFocused: async (messages, during, fail = false) => {
      const session = sidebar.focused;
      await sidebar.replayLoadedHistory(session, async () => {
        for (const message of messages) sidebar.emit(session, message);
        during?.();
        if (fail) throw new Error("synthetic session/load failure");
      });
    },
    seedFocusedSession: (id, cwd, messages = [], hasHistory = false, chips = []) => {
      const session = sidebar.newLocalSession();
      session.cwd = cwd;
      session.activeSessionId = id;
      session.client = { dispose() {}, sessionId: id } as AcpClient;
      session.hasHistory = hasHistory;
      session.chips = chips;
      session.buffer.push(...messages);
      sidebar.parkFocused();
      sidebar.focused = session;
      sidebar.pool.add(session);
    },
    seedLocalBackgroundSession: (id, cwd) => {
      const session = sidebar.newLocalSession();
      session.cwd = cwd;
      session.activeSessionId = id;
      session.client = { dispose() {}, sessionId: id } as AcpClient;
      session.hasHistory = true;
      sidebar.pool.add(session);
    },
    openLocalSession: (id, cwd) => sidebar.openSession(id, cwd),
    emitContextUsage: () => sidebar.emitContextUsage(sidebar.focused),
    seedUsageLedger: async (entries, userMessageCount) => {
      const session = sidebar.focused;
      const id = session.activeSessionId;
      if (!id) throw new Error("Seeded usage session has no id");
      session.userMessageCount = userMessageCount;
      const usageLog = entries.map((entry) => ({
        ...entry,
        usage: entry.usage ? { ...entry.usage } : undefined,
      }));
      const usage = enforceCompleteSessionCost(
        sumUsage(usageLog),
        usageLog,
        userMessageCount,
      );
      const overrides = (sidebar.state.get(SESSION_META_KEY, {}) ?? {}) as SessionMetaOverrides;
      await sidebar.state.update(SESSION_META_KEY, {
        ...overrides,
        [id]: {
          ...(overrides[id] ?? {}),
          usage,
          usageLog,
        },
      });
    },
    restartUsageSession: async (id, mode, summaryUsage) => {
      const session = sidebar.focused;
      session.activeSessionId = id;
      session.userMessageCount = 0;
      session.historyEventCount = 0;
      if (mode === "summarize" && summaryUsage) {
        await sidebar.accumulateUsage(session, { totalTokens: 1, usage: summaryUsage });
      }
    },
    rewindUsageLedger: async (surviving) => {
      const session = sidebar.focused;
      if (!session.activeSessionId) throw new Error("Seeded usage session has no id");
      await sidebar.truncateSessionCardsAfterRewind(session.activeSessionId, surviving);
      session.userMessageCount = surviving;
    },
    completeUsageTurn: async (usage) => {
      const session = sidebar.focused;
      session.userMessageCount += 1;
      await sidebar.accumulateUsage(session, { totalTokens: 1, usage });
    },
    reloadUsageLedger: (userMessageCount) => {
      const id = sidebar.focused.activeSessionId;
      if (!id) return { usageLog: [], sessionUsage: undefined };
      const ledger = sidebar.persistedUsageLedger(id, userMessageCount);
      return { usageLog: ledger.usageLog, sessionUsage: ledger.usage };
    },
    delayNextSessionStart: (resumeId) => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      sidebar.testSessionStartDelay = { resumeId, started: markStarted, wait };
      return { started, release };
    },
    seedFocusedWorktreeSession: (id, worktree) => {
      const prev = sidebar.focused;
      void sidebar.detachClient(prev)?.dispose();
      sidebar.focused = sidebar.newLocalSession();
      sidebar.focused.activeSessionId = id;
      sidebar.focused.cwd = worktree.sourceGitRoot;
      sidebar.focused.worktree = worktree;
      let applyCount = 0;
      let removeCount = 0;
      let lastApplyPath: string | undefined;
      let lastRemovePath: string | undefined;
      sidebar.focused.client = {
        dispose() {},
        sessionId: id,
        applyWorktree: async (worktreePath: string) => {
          applyCount += 1;
          lastApplyPath = worktreePath;
          return { status: "ok", files: [], gitRoot: worktree.sourceGitRoot };
        },
        removeWorktree: async (worktreePath: string) => {
          removeCount += 1;
          lastRemovePath = worktreePath;
          throw new Error("test-probe-stop");
        },
      } as unknown as AcpClient;
      return {
        applyCount: () => applyCount,
        removeCount: () => removeCount,
        lastApplyPath: () => lastApplyPath,
        lastRemovePath: () => lastRemovePath,
        restore: () => {
          sidebar.focused = prev;
        },
      };
    },
    isolateFromInstalledGrok: () => {
      sidebar.testForceMissingGrokCli = true;
      sidebar.cliPath = undefined;
      sidebar.setProviderConnectedInMemory("grok", false);
    },
    locatedGrokCli: () => sidebar.locateProvider("grok"),
    provisionFakeGrok: (cliPath) => {
      const previous = {
        cliPath: sidebar.cliPath,
        connected: sidebar.providerConnections().grok === true,
      };
      sidebar.cliPath = cliPath;
      sidebar.setProviderConnectedInMemory("grok", true);
      return () => {
        sidebar.cliPath = previous.cliPath;
        sidebar.setProviderConnectedInMemory("grok", previous.connected);
      };
    },
    sweepEmptySessions: (cwd) => sidebar.sweepEmptySessions(cwd, { force: true }),
    workspaceRoot: () => sidebar.workspaceRoot(),
  };
}

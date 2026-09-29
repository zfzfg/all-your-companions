const REPO_PREVIEW_SIZE = 3;
import { gitRootForPath, type WorktreeParentRef, worktreeCwdsForRepo } from "./worktree";
import {
  capSessionMetaAutoNames,
  cliSessionTitle,
  fallbackName,
  readSessionEntries,
  expiredArchiveChoiceKeys,
  newestTranscriptMtime
} from "./sessions";
import { computeDot } from "./session-pool";

import { type ProviderModelInfo } from "./provider-ui";
import * as fs from "node:fs";
export interface SessionCatalogSidebarOps {
  modelsForSession: (session: Session, ownModels: readonly any[], currentModelId?: string, newSession?: boolean) => ProviderModelInfo[];
  readonly state: HostContext["globalState"];
  sessionCwd: (session?: Session) => string;
  resolveLocalRepoTarget: (cwd: string) => RepoListEntry | undefined;
  readonly focused: Session;
  postLocal: (message: HostMsg) => void;
  readonly sessionCache: Map<string, { mtimeMs: number; entry: SessionListEntry; }>;
  workspaceRoot: () => string;
  readonly worktreeCache: WorktreeRecord[];
  readonly host: Host;
  allAdapterCatalogs: () => Iterable<readonly SessionListEntry[]>;
  isAuthorizedCwd: (cwd: string | undefined) => boolean;
  postSessionsList: (opts?: SessionsListOptions) => void;
  readonly pool: Set<Session>;
  pushDot: (session: Session) => void;
  adapterHistory: (provider: AcpProvider) => { cache: Map<string, SessionListEntry[]>; at: Map<string, number>; refresh: Map<string, Promise<void>>; } | undefined;
  hasProviderConsent: (provider: AcpProvider) => boolean;
  locateProvider: (provider: AcpProvider) => string | undefined;
  createProviderBackend: (provider: AcpProvider, effort?: string) => import("./acp-backend").AcpBackend | undefined;
}
/**
 * Session catalog and history navigation: repo discovery, session listing,
 * pin tracking, deletion, clear-all, sweep, rename, focus, and open.
 * Extracted from GrokSidebar (W-15 Schritt S1).
 */

import * as os from "node:os";
import * as path from "node:path";
import { AcpClient } from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isAdapterProvider } from "./acp-backend";
import { providerDisplayName } from "./provider-ui";
import type { Host, HostContext } from "./host";
import { Session, SessionStartIntent, sessionUiSnapshot } from "./session";
import { type Dot } from "./session-pool";
import type { HostMsg } from "./protocol";
import { OpenClock } from "./open-timing";
import { SESSION_META_KEY } from "./worktree-host";
import {
  SessionListEntry,
  SessionMetaOverrides,
  RepoArchives,
  RepoColors,
  RepoListEntry,
  RepoPins,
  REPO_COLOR_IDS,
  capAutoName,
  clearSessions,
  defaultFs,
  deleteSessionDir,
  discoverRepos,
  findSessionCatalogCwd,
  indexSessions,
  isEmptySession,
  neighbourAfterDelete,
  normalizeRepoPath,
  orderedResumeCwdCandidates,
  resolveGrokHome,
  sessionCwdBelongsToRepo,
  sessionDirFor
} from "./sessions";
import { withoutArchiveFields } from "./project-discovery";
import {
  adapterEntriesEligibleForClear,
  adapterListEntry,
  findCachedAdapterSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  projectProviderKey,
  type ProviderHistoryCursor
} from "./provider-ui";
import { effectiveSessionType } from "./session-type";
import { authorizedListCwd, filterEntriesByAuthorizedCwd } from "./workspace-auth";
import {
  matchWorktreeForCwd,
  mergeSessionIndexes,
  normalizeFsPath,
  pathsEqual,
  type WorktreeRecord,
  worktreesForRepo
} from "./worktree";
import { historySubtitle } from "./workflow-run";
import { GrokSidebar } from "./sidebar";

export const SESSION_PAGE_SIZE = 100;
export const REPO_PINS_KEY = "grok.repoPins";
export const REPO_ARCHIVES_KEY = "grok.repoArchives";
export const REPO_COLORS_KEY = "grok.repoColors";

export interface SessionsListOptions {
  offset?: number;
  limit?: number;
  query?: string;
  providerCursor?: ProviderHistoryCursor;
}
export type GrokSessionsListOptions = Omit<SessionsListOptions, "providerCursor">;
export type GrokSessionsListMessage = Extract<HostMsg, { type: "sessions" }>;

export interface SessionCatalogRepoOps {
  openWorkspaceFolders(): readonly string[];
  extraProjectFolders(): readonly string[];
  removedProjectFolderKeys(): Set<string>;
  defaultProviderForProject(cwd: string): AcpProvider;
  selectedHistoryCwd(): string;
  getSelectedRepoCwd(): string | undefined;
  setSelectedRepoCwd(cwd: string | undefined): void;
  workspaceRoot(): string;
  canAddProjectFolder(): boolean;
  refreshWorktreeCache(): Promise<void>;
}

export interface SessionCatalogAdapterOps {
  connectedProviders(): AcpProvider[];
  locateProvider(provider: AcpProvider): string | undefined;
  createProviderBackend(provider: AcpProvider): any;
  hasProviderConsent(provider: AcpProvider): boolean;
  setProviderNeedsLogin(provider: AcpProvider, needs: boolean): void;
  adapterHistory(provider: AcpProvider): {
    at: Map<string, number>;
    refresh: Map<string, Promise<void>>;
    cache: Map<string, SessionListEntry[]>;
  } | undefined;
  allAdapterCatalogs(): Iterable<readonly SessionListEntry[]>;
  getCodexSessionCache(): Map<string, SessionListEntry[]>;
  getClaudeSessionCache(): Map<string, SessionListEntry[]>;
  getGeminiSessionCache(): Map<string, SessionListEntry[]>;
  getMuseSessionCache(): Map<string, SessionListEntry[]>;
  isProviderCredentialError(provider: AcpProvider, error: unknown): boolean;
}

export interface SessionCatalogSessionOps {
  authorizedSessionCwds(): string[];
  historyCwdFor(): string;
  sessionCwd(session: Session): string;
  setSessionCwd(session: Session, cwd: string, workspaceRoot?: string): void;
  workflowStore(): { defs: Map<string, any> };
  workflowRuns(): { readRun(id: string): any };
  resolveWorkflow(session: Session, name: string): any;
  touch(session: Session): void;
  refreshWorkflowCompletions(session: Session): void;
}

export interface SessionCatalogUiOps {
  postLocal(msg: HostMsg | any): void;
  postSessionsList(): void;
  postMode(): void;
  postChildContext(session: Session): void;
  postSessionRemoved(id: string | undefined, cwd: string): void;
  localizeHistoryMessage(msg: any, webview: any): any;
  localPreviewChips(session: Session, webview: any): any;
  displayMode(session: Session): any;
  getWebview(): any;
  hasProjectsRail(): boolean;
}

export interface SessionCatalogLifecycleOps {
  startSession(
    id?: string,
    target?: Session,
    intent?: SessionStartIntent,
    clock?: OpenClock,
  ): Promise<AcpClient | undefined>;
  newLocalSession(): Session;
  disposeSession(session: Session): Promise<void>;
  detachClient(session: Session): AcpClient | undefined;
  removePlanReviews(id: string): void;
  removeCheckpoints(id: string): void;
  removeUploadsForSessions(ids: string[], overrides: SessionMetaOverrides): Promise<void>;
  viewIsOnDeleted(id: string): boolean;
  reserveSessionLoad(id: string): { reservation: any } | undefined | null;
  releaseSessionLoad(id: string, reservation: any, failure: unknown): void;
  isSessionLoadReserved(id: string): boolean;
  reservedSessionIds(): Iterable<string>;
  switchLocalWorkspaceFolderExclusive(
    cwd: string,
    opts?: { warnOnRefusal?: boolean },
  ): Promise<void>;
  findUnusedEmptySession(targetCwd: string, leavingId: string | null | undefined): any;
  persistWorktreeBinding(session: Session): Promise<void>;
  getSwitchQueue(): { run<T>(op: () => Promise<T>): Promise<T> };
}

/**
 * Top-level context interface for SessionCatalog.
 * Strict ceiling of <= 25 members (currently 10 members).
 */
export interface SessionCatalogDeps {
  readonly host: Host;
  readonly state: HostContext["globalState"];
  readonly getOverride?: <T extends (...args: any[]) => any>(name: string) => T | undefined;

  getFocused(): Session;
  setFocused(session: Session): void;
  getPool(): Set<Session>;
  getSessionCache(): Map<string, { mtimeMs: number; entry: SessionListEntry }>;
  getWorktreeCache(): WorktreeRecord[];

  readonly repoOps: SessionCatalogRepoOps;
  readonly adapterOps: SessionCatalogAdapterOps;
  readonly sessionOps: SessionCatalogSessionOps;
  readonly uiOps: SessionCatalogUiOps;
  readonly lifecycleOps: SessionCatalogLifecycleOps;

  readonly sidebarOps: SessionCatalogSidebarOps;
}

export class SessionCatalog {
  constructor(private readonly deps: SessionCatalogDeps) { }

  private allAdapterCatalogs(): Iterable<readonly SessionListEntry[]> {
    return this.deps.adapterOps.allAdapterCatalogs();
  }

  private disposeSession(session: Session): Promise<void> {
    return this.deps.lifecycleOps.disposeSession(session);
  }

  repoCatalog(): RepoListEntry[] {
    const testOverride = this.deps.getOverride?.<typeof this.repoCatalog>("repoCatalog");
    if (testOverride) return testOverride();

    const pins = this.deps.state.get<RepoPins>(REPO_PINS_KEY, {});
    const worktreeLabels = new Map<string, string>();
    for (const o of Object.values(
      this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {}),
    )) {
      if (o.worktreePath && o.worktreeLabel) {
        worktreeLabels.set(normalizeRepoPath(o.worktreePath), o.worktreeLabel);
      }
    }
    for (const wt of this.deps.getWorktreeCache()) {
      worktreeLabels.set(normalizeRepoPath(wt.path), wt.label);
    }
    const discovered = discoverRepos({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
      pins,
      archives: this.deps.host.canArchiveRepos
        ? this.deps.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})
        : undefined,
      colors: this.deps.state.get<RepoColors>(REPO_COLORS_KEY, {}),
      tmpDir: os.tmpdir(),
      trustedCwds: [
        ...this.deps.repoOps.openWorkspaceFolders(),
        ...this.deps.repoOps.extraProjectFolders(),
      ],
      worktreeLabels,
      log: (m) => this.deps.host.appendLine(m),
    });
    const removed = this.deps.repoOps.removedProjectFolderKeys();
    if (!removed.size) return discovered;
    for (const open of this.deps.repoOps.openWorkspaceFolders()) {
      removed.delete(normalizeRepoPath(open));
    }
    if (!removed.size) return discovered;
    return discovered.filter((r) => !removed.has(normalizeRepoPath(r.cwd)));
  }

  localRepoCatalogEntries(): RepoListEntry[] {
    const testOverride = this.deps.getOverride?.<typeof this.localRepoCatalogEntries>(
      "localRepoCatalogEntries",
    );
    if (testOverride) return testOverride();

    const full = this.repoCatalog();
    let entries: RepoListEntry[];
    if (!this.deps.host.canSwitchWorkspaceFolder) {
      const added = new Set(
        this.deps.repoOps.extraProjectFolders().map((c) => normalizeRepoPath(c)),
      );
      entries = added.size
        ? full.map((r) => (added.has(normalizeRepoPath(r.cwd)) ? { ...r, added: true } : r))
        : full;
    } else {
      const open = this.deps.repoOps.openWorkspaceFolders();
      if (!open.length) {
        entries = [];
      } else {
        const byKey = new Map(full.map((r) => [normalizeRepoPath(r.cwd), r]));
        entries = [];
        for (const cwd of open) {
          const key = normalizeRepoPath(cwd);
          const hit = byKey.get(key);
          if (hit) {
            entries.push(hit);
            continue;
          }
          const colors = this.deps.state.get<RepoColors>(REPO_COLORS_KEY, {});
          const colorChoice = colors[key]?.color;
          const archiveChoice = this.deps.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})[key];
          entries.push({
            cwd,
            label: path.basename(cwd) || cwd,
            available: true,
            pinned: false,
            updatedAt: 0,
            archived: !!archiveChoice?.archived,
            archivedAt: archiveChoice?.at ?? 0,
            color: colorChoice && (REPO_COLOR_IDS as readonly string[]).includes(colorChoice)
              ? colorChoice
              : "",
          });
        }
      }
    }
    return this.applyArchiveCapability(entries);
  }

  private applyArchiveCapability(entries: RepoListEntry[]): RepoListEntry[] {
    if (this.deps.host.canArchiveRepos) return entries;
    return entries.map((e) => withoutArchiveFields(e) as RepoListEntry);
  }

  resolveLocalRepoTarget(cwd: string): RepoListEntry | undefined {
    const testOverride = this.deps.getOverride?.<typeof this.resolveLocalRepoTarget>(
      "resolveLocalRepoTarget",
    );
    if (testOverride) return testOverride(cwd);

    const entries = this.localRepoCatalogEntries();
    let hit = entries.find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) {
      const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const owners = entries.filter(
        (r) =>
          r.available &&
          this.sessionCwdsForRepo(r.cwd, overrides)
            .some((c) => pathsEqual(c, cwd)),
      );
      hit = owners.length === 1 ? owners[0] : undefined;
    }
    if (!hit || !hit.available) return undefined;
    return hit;
  }

  postRepoCatalog(): void {
    const testOverride = this.deps.getOverride?.<typeof this.postRepoCatalog>("postRepoCatalog");
    if (testOverride) return testOverride();

    this.normalizeArchiveChoices();
    const localEntries = this.localRepoCatalogEntries().map((entry) => ({
      ...entry,
      defaultProvider: this.deps.repoOps.defaultProviderForProject(entry.cwd),
    }));
    const activeCwd = this.deps.sessionOps.sessionCwd(this.deps.getFocused());
    const selectedKey = normalizeRepoPath(this.deps.repoOps.selectedHistoryCwd());
    const selected = localEntries.find((r) => normalizeRepoPath(r.cwd) === selectedKey);
    const inLocal = (cwd: string) =>
      !!cwd && localEntries.some((r) => normalizeRepoPath(r.cwd) === normalizeRepoPath(cwd));
    if (selected && inLocal(selected.cwd)) {
      this.deps.repoOps.setSelectedRepoCwd(selected.cwd);
    } else if (inLocal(activeCwd)) {
      this.deps.repoOps.setSelectedRepoCwd(activeCwd);
    } else {
      const root = this.deps.repoOps.workspaceRoot();
      this.deps.repoOps.setSelectedRepoCwd(
        root && inLocal(root) ? root : localEntries[0]?.cwd ?? "",
      );
    }
    const localSelected =
      this.deps.repoOps.getSelectedRepoCwd() || this.deps.repoOps.workspaceRoot() || "";
    this.deps.uiOps.postLocal({
      type: "repos",
      entries: localEntries,
      selectedCwd: localSelected,
      activeCwd,
      canAddProject: this.deps.repoOps.canAddProjectFolder(),
      canCreateProject: this.deps.repoOps.canAddProjectFolder(),
      canCloneProject: this.deps.repoOps.canAddProjectFolder(),
      workspaceCwd: this.deps.repoOps.workspaceRoot() || "",
    });
  }

  buildPinnedSessions(): { entries: SessionListEntry[]; dots: Record<string, Dot> } {
    const testOverride = this.deps.getOverride?.<typeof this.buildPinnedSessions>(
      "buildPinnedSessions",
    );
    if (testOverride) return testOverride();

    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const authorized = this.deps.sessionOps.authorizedSessionCwds();
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.deps.host.appendLine(m);
    const byCwd = new Map<string, { cwd: string; ids: string[] }>();
    for (const [id, o] of Object.entries(overrides)) {
      if (typeof o?.pinnedAt !== "number" || !o.pinnedCwd) continue;
      if (!authorizedListCwd(o.pinnedCwd, authorized, pathsEqual)) continue;
      const key = normalizeFsPath(o.pinnedCwd);
      const bucket = byCwd.get(key) ?? { cwd: o.pinnedCwd, ids: [] };
      bucket.ids.push(id);
      byCwd.set(key, bucket);
    }
    const entries: SessionListEntry[] = [];
    const cachedAdapterIds = new Set(
      [...this.allAdapterCatalogs()].flat().map((entry) => entry.id),
    );
    for (const { cwd, ids } of byCwd.values()) {
      const adapterIds = new Set(
        ids.filter((id) => {
          const provider = overrides[id]?.provider;
          return (provider && isAdapterProvider(provider)) || cachedAdapterIds.has(id);
        }),
      );
      if (adapterIds.size) {
        this.scheduleAdapterHistoryRefresh("codex", cwd);
        this.scheduleAdapterHistoryRefresh("claude", cwd);
        this.scheduleAdapterHistoryRefresh("gemini", cwd);
        this.scheduleAdapterHistoryRefresh("muse", cwd);
      }
      for (const id of adapterIds) {
        const cached = findCachedAdapterSession(
          this.allAdapterCatalogs(),
          id,
          [cwd],
          (entryCwd: string, allowed: readonly string[]) =>
            sessionCwdBelongsToRepo(entryCwd, allowed, pathsEqual),
        );
        if (!cached) continue;
        entries.push({
          ...cached,
          customName: overrides[id]?.customName,
          displayName:
            overrides[id]?.customName?.trim() || cached.rawSummary || cached.displayName,
          pinnedAt: overrides[id]?.pinnedAt,
        });
      }
      const wanted = new Set(ids.filter((id) => !adapterIds.has(id)));
      if (!wanted.size) continue;
      const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
      const present = index.filter((e) => wanted.has(e.id));
      if (!present.length) continue;
      const mtimeById = new Map<string, number>(
        present.map((e: { id: string; mtimeMs: number }) => [e.id, e.mtimeMs]),
      );
      const cwdById = new Map<string, string>(
        present.map((e: { id: string }) => [e.id, cwd]),
      );
      entries.push(
        ...this.readEntriesCachedMulti(
          present.map((e: { id: string }) => e.id),
          mtimeById,
          cwdById,
          overrides,
          grokHome,
          log,
        ),
      );
    }
    const filtered = filterEntriesByAuthorizedCwd(entries, authorized, pathsEqual);
    filtered.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    const dots: Record<string, Dot> = {};
    for (const e of filtered) dots[e.id] = this.dotForId(e.id);
    return { entries: filtered, dots };
  }

  postPinnedSessions(): void {
    const testOverride = this.deps.getOverride?.<typeof this.postPinnedSessions>("postPinnedSessions");
    if (testOverride) return testOverride();

    const hasLocalRail =
      this.deps.host.canSwitchWorkspaceFolder || this.deps.uiOps.hasProjectsRail();
    if (!hasLocalRail) return;
    this.deps.uiOps.postLocal({ type: "pinnedSessions", ...this.buildPinnedSessions() });
  }

  buildSessionsList(
    cwd: string,
    opts?: SessionsListOptions,
    activeId: string | null | undefined = this.deps.getFocused()?.activeSessionId,
  ): Extract<HostMsg, { type: "sessions" }> {
    const testOverride = this.deps.getOverride?.<typeof this.buildSessionsList>("buildSessionsList");
    if (testOverride) return testOverride(cwd, opts, activeId);

    const offset = Math.max(0, opts?.offset ?? 0);
    const authorized = this.deps.sessionOps.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? "",
      };
    }
    cwd = listCwd;
    const providers = this.deps.adapterOps.connectedProviders();
    const adapterProviders = providers.filter(isAdapterProvider);
    for (const provider of adapterProviders) {
      this.scheduleAdapterHistoryRefresh(provider, cwd);
    }
    if (!adapterProviders.length) {
      return this.buildGrokSessionsList(cwd, opts, activeId);
    }

    const query = opts?.query ?? "";
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const providerCursor = opts?.providerCursor ?? { grokOffset: offset };
    const grok = this.buildGrokSessionsList(
      cwd,
      query
        ? { offset: 0, limit: Number.MAX_SAFE_INTEGER, query }
        : { offset: providerCursor.grokOffset, limit, query },
      activeId,
    );
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const adapter: SessionListEntry[] = [];
    if (providers.includes("codex")) {
      adapter.push(...(this.deps.adapterOps.getCodexSessionCache().get(projectProviderKey(cwd)) ?? []));
    }
    if (providers.includes("claude")) {
      adapter.push(...(this.deps.adapterOps.getClaudeSessionCache().get(projectProviderKey(cwd)) ?? []));
    }
    if (providers.includes("gemini")) {
      adapter.push(...(this.deps.adapterOps.getGeminiSessionCache().get(projectProviderKey(cwd)) ?? []));
    }
    if (providers.includes("muse")) {
      adapter.push(...(this.deps.adapterOps.getMuseSessionCache().get(projectProviderKey(cwd)) ?? []));
    }
    for (const session of this.deps.getPool()) {
      if (
        !isAdapterProvider(session.provider) ||
        !session.activeSessionId ||
        !pathsEqual(this.deps.sessionOps.sessionCwd(session), cwd)
      ) {
        continue;
      }
      if (adapter.some((entry) => entry.id === session.activeSessionId)) continue;
      adapter.push(
        this.liveSessionEntry(
          session,
          session.activeSessionId,
          this.deps.sessionOps.sessionCwd(session),
          overrides,
        ),
      );
    }
    adapter.sort(
      (a: SessionListEntry, b: SessionListEntry) =>
        b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
    const merged = query
      ? mergeProviderSessionEntries(grok?.entries ?? [], adapter, providers, query)
      : undefined;
    const combinedPage = query
      ? undefined
      : mergeProviderHistoryPage(grok, adapter, providerCursor, limit);
    const entries = query
      ? (merged ?? []).slice(offset, offset + limit)
      : combinedPage?.entries ?? [];
    const dots: Record<string, Dot> = {};
    for (const entry of entries) dots[entry.id] = this.dotForId(entry.id);
    const nextOffset = query
      ? offset + entries.length
      : Math.max(offset + entries.length, combinedPage?.providerCursor.grokOffset ?? 0);
    const total = query ? merged?.length ?? 0 : (grok?.total ?? 0) + adapter.length;
    return {
      type: "sessions",
      entries,
      activeId,
      dots,
      offset,
      total,
      hasMore: query ? nextOffset < total : combinedPage?.hasMore ?? false,
      nextOffset,
      ...(!query && combinedPage ? { providerCursor: combinedPage.providerCursor } : {}),
      query,
    };
  }

  scheduleAdapterHistoryRefresh(provider: AcpProvider, cwd: string): void {
    const testOverride = this.deps.getOverride?.<typeof this.scheduleAdapterHistoryRefresh>(
      "scheduleAdapterHistoryRefresh",
    );
    if (testOverride) return testOverride(provider, cwd);

    if (!isAdapterProvider(provider) || !this.deps.adapterOps.connectedProviders().includes(provider)) {
      return;
    }
    const history = this.deps.adapterOps.adapterHistory(provider);
    if (!history) return;
    const key = projectProviderKey(cwd);
    if (history.refresh.has(key)) return;
    if (Date.now() - (history.at.get(key) ?? 0) < 10_000) return;
    const refresh = (
      provider === "codex"
        ? this.refreshCodexHistory(cwd, key)
        : this.refreshAdapterHistory(provider, cwd, key)
    )
      .catch((error) => {
        this.deps.host.appendLine(`[${provider}] session listing failed: ${(error as Error).message}`);
        const credential = this.deps.adapterOps.isProviderCredentialError(provider, error);
        if (!credential) return;
        history.at.set(key, Date.now());
        this.deps.adapterOps.setProviderNeedsLogin(provider, true);
      })
      .finally(() => history.refresh.delete(key));
    history.refresh.set(key, refresh);
  }

  async refreshCodexHistory(cwd: string, key = projectProviderKey(cwd)): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.refreshCodexHistory>("refreshCodexHistory");
    if (testOverride) return testOverride(cwd, key);
    return this.refreshAdapterHistory("codex", cwd, key);
  }

  async refreshAdapterHistory(
    provider: AcpProvider,
    cwd: string,
    key = projectProviderKey(cwd),
  ): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.refreshAdapterHistory>(
      "refreshAdapterHistory",
    );
    if (testOverride) return testOverride(provider, cwd, key);

    if (!isAdapterProvider(provider) || !this.deps.adapterOps.hasProviderConsent(provider)) return;
    const history = this.deps.adapterOps.adapterHistory(provider);
    const cliPath = this.deps.adapterOps.locateProvider(provider);
    const backend = this.deps.adapterOps.createProviderBackend(provider);
    if (
      !history ||
      !cliPath ||
      !backend ||
      !this.deps.adapterOps.connectedProviders().includes(provider)
    ) {
      return;
    }
    const client = new AcpClient({
      cliPath,
      cwd,
      env: { ...process.env },
      backend,
      log: (message) => this.deps.host.appendLine(message),
    });
    try {
      await client.start();
      const result = await client.listSessions(cwd, process.platform);
      const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const stableOverrides: SessionMetaOverrides = { ...overrides };
      for (const entry of result.sessions) {
        const previous = stableOverrides[entry.sessionId] ?? {};
        if (typeof previous.activeAt === "number") continue;
        stableOverrides[entry.sessionId] = {
          ...previous,
          activeAt: adapterListEntry(entry, {}, provider, Date.now()).updatedAt,
        };
      }
      const entries = result.sessions.map((entry) =>
        adapterListEntry(entry, stableOverrides, provider),
      );
      history.cache.set(key, entries);
      history.at.set(key, Date.now());
      await this.updateSessionMeta((current) => {
        let changed = false;
        const next = { ...current };
        for (const entry of result.sessions) {
          const previous = next[entry.sessionId] ?? {};
          const title = typeof entry.title === "string" ? entry.title.trim() : "";
          const autoName = capAutoName(title);
          const updated = {
            ...previous,
            provider,
            providerCwd: entry.cwd,
            activeAt:
              typeof previous.activeAt === "number"
                ? previous.activeAt
                : stableOverrides[entry.sessionId]?.activeAt,
            ...(!previous.customName && autoName ? { autoName } : {}),
          };
          if (JSON.stringify(updated) !== JSON.stringify(previous)) {
            next[entry.sessionId] = updated;
            changed = true;
          }
        }
        return changed ? next : null;
      });
    } finally {
      await client.dispose();
    }
    this.deps.uiOps.postSessionsList();
    this.sendLocalRepoSessionsPreview(cwd);
  }

  buildGrokSessionsList(
    cwd: string,
    opts?: GrokSessionsListOptions,
    activeId: string | null | undefined = this.deps.getFocused()?.activeSessionId,
  ): GrokSessionsListMessage {
    const testOverride = this.deps.getOverride?.<typeof this.buildGrokSessionsList>(
      "buildGrokSessionsList",
    );
    if (testOverride) return testOverride(cwd, opts, activeId);

    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const query = (opts?.query ?? "").trim().toLowerCase();
    const authorized = this.deps.sessionOps.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? "",
      };
    }
    cwd = listCwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.deps.host.appendLine(m);

    void this.deps.repoOps.refreshWorktreeCache();

    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const index = mergeSessionIndexes(
      repoCwds.map((c) => ({
        cwd: c,
        entries: indexSessions({ fs: defaultFs, grokHome, cwd: c, log }),
      })),
    );
    const mtimeById = new Map<string, number>(
      index.map((e: { id: string; mtimeMs: number }) => [e.id, e.mtimeMs]),
    );
    const cwdById = new Map<string, string>(
      index.map((e: { id: string; cwd: string }) => [e.id, e.cwd]),
    );

    let pageEntries: SessionListEntry[];
    let total: number;
    let nextOffset: number;
    if (query) {
      const all = this.readEntriesCachedMulti(
        index.map((e: { id: string }) => e.id),
        mtimeById,
        cwdById,
        overrides,
        grokHome,
        log,
      )
        .filter((e) => e.kind !== "subagent");
      all.sort((a: SessionListEntry, b: SessionListEntry) => b.updatedAt - a.updatedAt);
      const matched = all.filter(
        (e) =>
          e.displayName.toLowerCase().includes(query) ||
          (e.worktreeLabel && e.worktreeLabel.toLowerCase().includes(query)),
      );
      total = matched.length;
      pageEntries = matched.slice(offset, offset + limit);
      nextOffset = offset + pageEntries.length;
    } else {
      total = index.length;
      const pageIndex = index.slice(offset, offset + limit);
      const pageIds = pageIndex.map((e: { id: string }) => e.id);
      pageEntries = this.readEntriesCachedMulti(pageIds, mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      pageEntries.sort((a: SessionListEntry, b: SessionListEntry) => b.updatedAt - a.updatedAt);
      nextOffset = offset + pageIds.length;
    }
    this.annotateWorktreeLabels(pageEntries, overrides, cwd);
    for (const entry of pageEntries) {
      if (effectiveSessionType(overrides[entry.id]) === "crew") {
        entry.sessionType = "crew";
        const runId = overrides[entry.id]?.crewRunId;
        const live = [...this.deps.getPool()].find((s) => s.workflowRun?.runId === runId);
        if (live?.workflowRun) {
          const def =
            this.deps.sessionOps.workflowStore().defs.get(live.workflowRun.runId) ??
            this.deps.sessionOps.resolveWorkflow(live, live.workflowRun.workflowName);
          entry.crewStatus = historySubtitle(live.workflowRun, def);
        } else if (runId) {
          const stored = this.deps.sessionOps.workflowRuns().readRun(runId);
          if (stored) {
            const def = this.deps.sessionOps.resolveWorkflow(
              this.deps.getFocused(),
              stored.workflowName,
            );
            entry.crewStatus = historySubtitle(stored, def);
          }
        }
      }
      const hidden = overrides[entry.id]?.hiddenReason;
      if (hidden) entry.hiddenReason = hidden;
    }

    const hasMore = nextOffset < total;

    if (!query && offset === 0) {
      const onDisk = new Set(index.map((e: { id: string }) => e.id));
      const seen = new Set(pageEntries.map((e: { id: string }) => e.id));
      const synthetic: SessionListEntry[] = [];
      for (const s of this.deps.getPool()) {
        const id = s.activeSessionId;
        if (!id || onDisk.has(id) || seen.has(id)) continue;
        const sCwd = this.deps.sessionOps.sessionCwd(s);
        if (!repoCwdKeys.has(normalizeFsPath(sCwd))) continue;
        const entry = this.liveSessionEntry(s, id, sCwd, overrides);
        if (s.worktree) entry.worktreeLabel = s.worktree.label;
        synthetic.push(entry);
        seen.add(id);
      }
      if (synthetic.length) {
        synthetic.sort((a, b) => b.updatedAt - a.updatedAt);
        pageEntries = [...synthetic, ...pageEntries];
      }
    }

    const liveEmpty = new Set<string>();
    const liveProvider = new Map<string, AcpProvider>();
    for (const s of this.deps.getPool()) {
      if (!s.activeSessionId) continue;
      liveProvider.set(s.activeSessionId, s.provider);
      if (!s.hasHistory) liveEmpty.add(s.activeSessionId);
    }
    for (const e of pageEntries) {
      const provider = liveProvider.get(e.id);
      if (provider) e.provider = provider;
      if (!e.customName && liveEmpty.has(e.id)) e.displayName = "New session";
    }

    const dots: Record<string, Dot> = {};
    for (const e of pageEntries) dots[e.id] = this.dotForId(e.id);
    for (const s of this.deps.getPool()) {
      if (s.activeSessionId && !(s.activeSessionId in dots)) {
        dots[s.activeSessionId] = this.dotForId(s.activeSessionId);
      }
    }
    return {
      type: "sessions",
      entries: pageEntries,
      activeId,
      dots,
      offset,
      total,
      hasMore,
      nextOffset,
      query: opts?.query ?? "",
    };
  }

  renameSession(id: string, name: string, requestedCwd?: string): void {
    const testOverride = this.deps.getOverride?.<typeof this.renameSession>("renameSession");
    if (testOverride) return testOverride(id, name, requestedCwd);

    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const trimmed = (name || "").trim();
    const next: SessionMetaOverrides = { ...overrides };
    if (!trimmed) {
      const cur = next[id];
      if (cur) {
        const { customName: _drop, ...rest } = cur;
        if (Object.keys(rest).length === 0) delete next[id];
        else next[id] = rest;
      }
    } else {
      next[id] = { ...(next[id] ?? {}), customName: trimmed };
    }
    void this.deps.state.update(SESSION_META_KEY, next);
    this.deps.getSessionCache().delete(id);
    for (const adapter of ["codex", "claude"] as const) {
      const history = this.deps.adapterOps.adapterHistory(adapter);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(
          key,
          entries.map((entry) => {
            if (entry.id !== id) return entry;
            const customName = next[id]?.customName?.trim() || undefined;
            return {
              ...entry,
              customName,
              displayName:
                customName ||
                entry.rawSummary ||
                next[id]?.autoName ||
                `Untitled (${new Date(entry.updatedAt).toLocaleDateString()})`,
            };
          }),
        );
      }
    }
    const live = [...this.deps.getPool()].find((session) => session.activeSessionId === id);
    this.deps.uiOps.postSessionsList();
    if (live) this.postSessionName(live);
    if (requestedCwd) this.sendLocalRepoSessionsPreview(requestedCwd);
  }

  sessionHasLiveOwner(session: Session): boolean {
    const testOverride = this.deps.getOverride?.<typeof this.sessionHasLiveOwner>("sessionHasLiveOwner");
    if (testOverride) return testOverride(session);
    return session === this.deps.getFocused();
  }

  reportProtectedSession(action: "delete" | "clear"): void {
    const testOverride = this.deps.getOverride?.<typeof this.reportProtectedSession>("reportProtectedSession");
    if (testOverride) return testOverride(action);
    const text =
      action === "delete"
        ? "This conversation is open. Close it before deleting it."
        : "Open conversations were kept. Close them before clearing them.";
    void this.deps.host.showInformationMessage(text);
  }

  notifyUser(level: "info" | "warning" | "error", text: string): void {
    const testOverride = this.deps.getOverride?.<typeof this.notifyUser>("notifyUser");
    if (testOverride) return testOverride(level, text);
    if (level === "error") void this.deps.host.showErrorMessage(text);
    else if (level === "warning") void this.deps.host.showWarningMessage(text);
    else void this.deps.host.showInformationMessage(text);
  }

  async deleteSession(
    id: string,
    _name: string | undefined,
    requestedCwd?: string,
  ): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.deleteSession>("deleteSession");
    if (testOverride) return testOverride(id, _name, requestedCwd);

    const overridesNow = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    if (this.deps.lifecycleOps.isSessionLoadReserved(id)) {
      this.deps.host.appendLine(`[sessions] refused delete of reserved session ${id}`);
      this.reportProtectedSession("delete");
      return;
    }
    const live = [...this.deps.getPool()].find((s) => s.activeSessionId === id);
    const localNamedCwd = requestedCwd
      ? this.resolveLocalRepoTarget(requestedCwd)?.cwd ??
      (this.localTrustedSessionCwds(overridesNow).some((c) => pathsEqual(c, requestedCwd))
        ? requestedCwd
        : undefined)
      : undefined;
    const cachedAdapter = [...this.allAdapterCatalogs()]
      .flat()
      .find((entry) => entry.id === id);
    const cwd =
      live?.cwd ||
      overridesNow[id]?.worktreePath ||
      this.deps.getSessionCache().get(id)?.entry.cwd ||
      cachedAdapter?.cwd ||
      localNamedCwd ||
      this.deps.sessionOps.historyCwdFor();
    const provider =
      live?.provider ?? overridesNow[id]?.provider ?? cachedAdapter?.provider ?? "grok";

    const visibleEntries = this.buildSessionsList(
      cwd,
      { limit: Number.MAX_SAFE_INTEGER },
      undefined,
    ).entries;
    if (isAdapterProvider(provider)) {
      let temporary: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.deps.adapterOps.locateProvider(provider);
        const backend = this.deps.adapterOps.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        const client =
          live?.client ??
          (temporary = new AcpClient({
            cliPath,
            cwd,
            env: { ...process.env },
            backend,
            log: (message) => this.deps.host.appendLine(message),
          }));
        if (temporary) await temporary.start();
        await client.deleteSession(id);
      } catch (error) {
        this.deps.host.appendLine(
          `[sessions] ${name} could not delete ${id}, removing it locally: ${(error as Error).message}`,
        );
      }
      if (temporary) await temporary.dispose();
      if (live) void this.disposeSession(live);
      const history = this.deps.adapterOps.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(
            key,
            entries.filter((entry) => entry.id !== id),
          );
        }
      }
    } else {
      if (live) void this.disposeSession(live);
      try {
        deleteSessionDir({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          cwd,
          id,
        });
      } catch (e) {
        this.deps.host.appendLine(`[sessions] delete failed for ${id}: ${(e as Error).message}`);
      }
    }
    if (live) live.deleted = true;
    this.deps.getSessionCache().delete(id);
    this.deps.lifecycleOps.removePlanReviews(id);
    this.deps.lifecycleOps.removeCheckpoints(id);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.deps.lifecycleOps.removeUploadsForSessions([id], overrides);
    if (overrides[id]) {
      const next = { ...overrides };
      delete next[id];
      void this.deps.state.update(SESSION_META_KEY, next);
    }
    const neighbour = neighbourAfterDelete(visibleEntries, id);
    // THE ONLY QUESTION: is the view sitting on something that no longer
    // exists? If so it needs a home; if not, wherever the person is now is
    // where they want to be.
    const viewNeedsHome = this.deps.lifecycleOps.viewIsOnDeleted(id);
    if (viewNeedsHome) {
      if (neighbour) await this.openSession(neighbour.id, neighbour.cwd);
      if (this.deps.lifecycleOps.viewIsOnDeleted(id)) {
        const nextFocused = this.deps.lifecycleOps.newLocalSession();
        this.deps.setFocused(nextFocused);
        this.deps.sessionOps.setSessionCwd(
          nextFocused,
          this.deps.sessionOps.historyCwdFor(),
          this.deps.repoOps.workspaceRoot(),
        );
        nextFocused.provider = this.deps.repoOps.defaultProviderForProject(
          this.deps.sessionOps.historyCwdFor(),
        );
        await this.deps.lifecycleOps.startSession();
      }
    }
    this.deps.uiOps.postSessionsList();
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
  }

  async clearAllSessions(requestedCwd: string): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.clearAllSessions>("clearAllSessions");
    if (testOverride) return testOverride(requestedCwd);

    const repo = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, requestedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const exiting: Promise<void>[] = [];
    for (const s of [...this.deps.getPool()]) {
      if (this.sessionHasLiveOwner(s)) continue;
      if (!repoCwdKeys.has(normalizeFsPath(this.deps.sessionOps.sessionCwd(s)))) continue;
      exiting.push(this.disposeSession(s));
    }
    if (exiting.length) await Promise.allSettled(exiting);

    const adapterHistoryChecked = new Set<AcpProvider>();
    for (const provider of this.deps.adapterOps.connectedProviders().filter(isAdapterProvider)) {
      try {
        await this.refreshAdapterHistory(provider, cwd);
        adapterHistoryChecked.add(provider);
      } catch (error) {
        const text = `${providerDisplayName(provider)} history could not be checked, so its conversations were not cleared: ${(error as Error).message}`;
        this.deps.host.appendLine(`[sessions] ${text}`);
        void this.deps.host.showErrorMessage(text);
      }
    }
    const protectedIds = new Set(
      [...this.deps.getPool()]
        .filter((session) => this.sessionHasLiveOwner(session))
        .map((session) => session.activeSessionId)
        .filter((id): id is string => !!id),
    );
    for (const id of this.deps.lifecycleOps.reservedSessionIds()) protectedIds.add(id);
    const requesterId = this.deps.getFocused().activeSessionId;
    const repoEntries = mergeSessionIndexes(
      repoCwds.map((sessionCwd) => ({
        cwd: sessionCwd,
        entries: indexSessions({ fs: defaultFs, grokHome, cwd: sessionCwd }),
      })),
    );
    const adapterEntries = adapterEntriesEligibleForClear(
      [
        {
          provider: "codex",
          entries: this.deps.adapterOps.getCodexSessionCache().get(projectProviderKey(cwd)) ?? [],
        },
        {
          provider: "claude",
          entries: this.deps.adapterOps.getClaudeSessionCache().get(projectProviderKey(cwd)) ?? [],
        },
        {
          provider: "gemini",
          entries: this.deps.adapterOps.getGeminiSessionCache().get(projectProviderKey(cwd)) ?? [],
        },
      ],
      adapterHistoryChecked,
    );
    const allEntries = [...repoEntries, ...adapterEntries];
    const keptForAnotherOwner = allEntries.some(
      (entry) => protectedIds.has(entry.id) && entry.id !== requesterId,
    );
    const clearableCount = allEntries.filter((entry) => !protectedIds.has(entry.id)).length;
    if (clearableCount === 0) {
      if (keptForAnotherOwner) this.reportProtectedSession("clear");
      else this.notifyUser("info", "No history to clear.");
      this.deps.uiOps.postSessionsList();
      this.sendLocalRepoSessionsPreview(cwd);
      return;
    }

    const removedIds = new Set<string>();
    for (const sessionCwd of repoCwds) {
      try {
        for (const id of clearSessions({
          fs: defaultFs,
          grokHome,
          cwd: sessionCwd,
          exceptIds: protectedIds,
        })) {
          removedIds.add(id);
        }
      } catch (e) {
        this.deps.host.appendLine(
          `[sessions] clear-all failed for ${sessionCwd}: ${(e as Error).message}`,
        );
      }
    }
    for (const provider of ["codex", "claude"] as const) {
      if (!adapterHistoryChecked.has(provider)) continue;
      const history = this.deps.adapterOps.adapterHistory(provider);
      const entries = (history?.cache.get(projectProviderKey(cwd)) ?? []).filter(
        (entry) => !protectedIds.has(entry.id),
      );
      if (!entries.length) continue;
      let client: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.deps.adapterOps.locateProvider(provider);
        const backend = this.deps.adapterOps.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        client = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.deps.host.appendLine(message),
        });
        await client.start();
        for (const entry of entries) {
          try {
            await client.deleteSession(entry.id);
            removedIds.add(entry.id);
          } catch (error) {
            const text = `${name} refused to delete “${entry.displayName}”: ${(error as Error).message}`;
            this.deps.host.appendLine(`[sessions] ${text}`);
            void this.deps.host.showErrorMessage(text);
          }
        }
      } catch (error) {
        const text = `${name} conversations were not cleared: ${(error as Error).message}`;
        this.deps.host.appendLine(`[sessions] ${text}`);
        void this.deps.host.showErrorMessage(text);
      } finally {
        if (client) await client.dispose();
      }
    }
    const removed = [...removedIds];

    if (removed.length) {
      const gone = new Set(removed);
      for (const adapter of ["codex", "claude"] as const) {
        const history = this.deps.adapterOps.adapterHistory(adapter);
        if (!history) continue;
        for (const [key, entries] of history.cache) {
          history.cache.set(
            key,
            entries.filter((entry) => !gone.has(entry.id)),
          );
        }
      }
    }

    if (removed.length) {
      await this.deps.lifecycleOps.removeUploadsForSessions(removed, overrides);
      const next = { ...overrides };
      let changed = false;
      for (const id of removed) {
        this.deps.getSessionCache().delete(id);
        this.deps.lifecycleOps.removePlanReviews(id);
        this.deps.lifecycleOps.removeCheckpoints(id);
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) await this.deps.state.update(SESSION_META_KEY, next);
    }

    const gone = new Set(removed);
    let removedFocused = false;
    for (const s of [...this.deps.getPool()]) {
      if (s.activeSessionId && gone.has(s.activeSessionId)) {
        removedFocused ||= s === this.deps.getFocused();
        void this.disposeSession(s);
      }
    }
    if (removedFocused) {
      const nextFocused = this.deps.lifecycleOps.newLocalSession();
      this.deps.setFocused(nextFocused);
      await this.deps.lifecycleOps.startSession();
    }
    this.deps.uiOps.postSessionsList();
    this.sendLocalRepoSessionsPreview(cwd);
    if (keptForAnotherOwner) this.reportProtectedSession("clear");
  }

  focusSession(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.focusSession>("focusSession");
    if (testOverride) return testOverride(session);

    if (session === this.deps.getFocused()) return;
    this.deps.setFocused(session);
    this.deps.sessionOps.touch(session);
    this.markRead(session);
    this.deps.sessionOps.refreshWorkflowCompletions(session);
    const wv = this.deps.uiOps.getWebview();
    const identity = this.sessionIdentityFrame(session);
    if (wv) {
      wv.postMessage({ type: "clearMessages" });
      if (identity) wv.postMessage(identity);
      wv.postMessage({ type: "historyReplay", active: true });
      for (const m of session.buffer) {
        wv.postMessage(this.deps.uiOps.localizeHistoryMessage(m, wv));
      }
      wv.postMessage({ type: "historyReplay", active: false });
      for (const m of sessionUiSnapshot(
        session,
        this.deps.uiOps.displayMode(session),
        this.deps.uiOps.localPreviewChips(session, wv),
      )) {
        wv.postMessage(m);
      }
    }
    this.deps.uiOps.postMode();
    this.postRepoCatalog();
    this.postSessionName(session);
    this.deps.uiOps.postChildContext(session);
  }

  parkFocused(): void {
    const testOverride = this.deps.getOverride?.<typeof this.parkFocused>("parkFocused");
    if (testOverride) return testOverride();

    const cur = this.deps.getFocused();
    if (cur.deleted) return;
    const busy = cur.status === "working" || cur.status === "needs-you";
    if (cur.needsProvider || cur.strandedDraft || cur.queuedSends.length > 0) {
      this.deps.getPool().add(cur);
      return;
    }
    if (cur.hasHistory || busy || cur.chips.length > 0 || cur.worktree) return;
    if (cur.priming) return;
    this.teardownEmptySession(cur);
  }

  teardownEmptySession(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.teardownEmptySession>(
      "teardownEmptySession",
    );
    if (testOverride) return testOverride(session);

    const id = session.activeSessionId;
    const cwd = this.deps.sessionOps.sessionCwd(session);
    const provider = session.provider;
    const client = isAdapterProvider(provider)
      ? this.deps.lifecycleOps.detachClient(session)
      : undefined;
    void this.deps.lifecycleOps.disposeSession(session);
    if (isAdapterProvider(provider)) {
      void this.discardAdapterEmptySession(provider, id, cwd, client)
        .finally(() => client?.dispose())
        .then((removed) => {
          if (removed) this.deps.uiOps.postSessionRemoved(id, cwd);
        })
        .catch((error) => {
          this.deps.host.appendLine(
            `[${provider}] empty-session cleanup failed: ${(error as Error).message}`,
          );
        });
    } else if (this.removeSessionFromDisk(id, cwd)) {
      this.deps.uiOps.postSessionRemoved(id, cwd);
    }
  }

  removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean {
    const testOverride = this.deps.getOverride?.<typeof this.removeSessionFromDisk>(
      "removeSessionFromDisk",
    );
    if (testOverride) return testOverride(id, sessionCwd);

    if (!id) return false;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cwd =
      sessionCwd ||
      overrides[id]?.worktreePath ||
      this.deps.getSessionCache().get(id)?.entry.cwd ||
      this.deps.repoOps.workspaceRoot();
    const grokHome = resolveGrokHome(process.env);
    let removed = false;
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
      removed = true;
    } catch (e) {
      this.deps.host.appendLine(
        `[sessions] could not remove empty session ${id}: ${(e as Error).message}`,
      );
    }
    if (overrides[id]) {
      void this.deps.lifecycleOps.removeUploadsForSessions([id], overrides);
      const next = { ...overrides };
      delete next[id];
      void this.deps.state.update(SESSION_META_KEY, next);
    }
    this.deps.getSessionCache().delete(id);
    return removed;
  }

  sweepEmptySessions(
    cwd: string = this.deps.repoOps.workspaceRoot(),
    opts: { force?: boolean } = {},
  ): void {
    const testOverride = this.deps.getOverride?.<typeof this.sweepEmptySessions>("sweepEmptySessions");
    if (testOverride) return testOverride(cwd, opts);

    if (!cwd) return;
    const repoKey = normalizeRepoPath(cwd);
    const startedAt = Date.now();
    const lastSweepAt = this.lastSweepAt;
    const lastSweep = lastSweepAt.get(repoKey) ?? 0;
    if (!opts.force && startedAt - lastSweep < GrokSidebar.SWEEP_INTERVAL_MS) return;
    lastSweepAt.set(repoKey, startedAt);
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.deps.host.appendLine(m);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const liveIds = new Set<string>();
    for (const s of this.deps.getPool()) if (s.activeSessionId) liveIds.add(s.activeSessionId);
    if (this.deps.getFocused().activeSessionId) {
      liveIds.add(this.deps.getFocused().activeSessionId!);
    }
    for (const id of this.deps.lifecycleOps.reservedSessionIds()) liveIds.add(id);

    const provenNonEmpty = this.provenNonEmpty;
    let proven = provenNonEmpty.get(repoKey);
    if (!proven) {
      proven = new Set<string>();
      provenNonEmpty.set(repoKey, proven);
    }
    const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
    const removed: string[] = [];
    const now = Date.now();
    const considered = new Set<string>();
    const candidates: typeof index = [];
    for (const entry of index.slice(0, GrokSidebar.SWEEP_SCAN_LIMIT)) {
      considered.add(entry.id);
      candidates.push(entry);
    }
    for (const { id, mtimeMs } of candidates) {
      if (liveIds.has(id) || proven.has(id)) continue;
      if (now - mtimeMs < GrokSidebar.SWEEP_MIN_AGE_MS) continue;
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) continue;
      let raw: any;
      try {
        raw = JSON.parse(defaultFs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      } catch {
        continue;
      }
      let chatHistory: string | undefined;
      let historyUnreadable = false;
      const historyPath = path.join(sessDir, "chat_history.jsonl");
      try {
        chatHistory = defaultFs.readFileSync(historyPath, "utf8");
      } catch {
        historyUnreadable = defaultFs.existsSync(historyPath);
      }
      const overrideMeta = overrides[id];
      const empty = isEmptySession({
        customName: overrideMeta?.customName,
        pinnedAt: overrideMeta?.pinnedAt,
        worktreePath: overrideMeta?.worktreePath,
        queuedDraft: overrideMeta?.queuedDraft,
        kind: typeof raw?.session_kind === "string" ? raw.session_kind : undefined,
        hiddenReason: overrideMeta?.hiddenReason,
        numMessages: typeof raw?.num_messages === "number" ? raw.num_messages : 0,
        summary: typeof raw?.session_summary === "string" ? raw.session_summary : "",
        generatedTitle: typeof raw?.generated_title === "string" ? raw.generated_title : "",
        chatHistory,
        historyUnreadable,
      });
      if (!empty) {
        if (!historyUnreadable) proven.add(id);
        continue;
      }
      try {
        deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
        removed.push(id);
      } catch (e) {
        log(`[sessions] could not sweep ${id}: ${(e as Error).message}`);
      }
    }
    if (removed.length) {
      const next = { ...overrides };
      void this.deps.lifecycleOps.removeUploadsForSessions(removed, overrides);
      for (const id of removed) {
        delete next[id];
        this.deps.getSessionCache().delete(id);
      }
      void this.deps.state.update(SESSION_META_KEY, next);
      log(`[sessions] swept ${removed.length} empty session(s) from history`);
      this.deps.uiOps.postSessionsList();
    }
  }

  async newFocusedSession(requestedCwd?: string): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.newFocusedSession>("newFocusedSession");
    if (testOverride) return testOverride(requestedCwd);

    const named = requestedCwd ? this.resolveLocalRepoTarget(requestedCwd) : undefined;
    if (requestedCwd && !named) {
      void this.deps.host.showWarningMessage(
        `That project is no longer available:\n${requestedCwd}`,
      );
      this.postRepoCatalog();
      this.deps.uiOps.postSessionsList();
      return;
    }
    if (named && !pathsEqual(named.cwd, this.deps.repoOps.getSelectedRepoCwd() || "")) {
      this.deps.repoOps.setSelectedRepoCwd(named.cwd);
    }
    const targetCwd = named?.cwd ?? this.deps.sessionOps.historyCwdFor();
    const leavingId = this.deps.getFocused().activeSessionId ?? null;
    this.parkFocused();
    const unused = this.deps.lifecycleOps.findUnusedEmptySession(targetCwd, leavingId);
    if (unused?.session?.client) {
      this.focusSession(unused.session);
    } else if (unused?.session) {
      this.deps.setFocused(unused.session);
      this.deps.getPool().add(this.deps.getFocused());
      this.deps.uiOps.getWebview()?.postMessage({ type: "clearMessages" });
      await this.deps.lifecycleOps.startSession(unused.id, this.deps.getFocused(), "ensure");
    } else if (unused) {
      await this.openSession(unused.id, unused.cwd);
    } else {
      const fresh = this.deps.lifecycleOps.newLocalSession();
      this.deps.setFocused(fresh);
      this.deps.sessionOps.setSessionCwd(fresh, targetCwd, this.deps.repoOps.workspaceRoot());
      fresh.provider = this.deps.repoOps.defaultProviderForProject(targetCwd);
      this.deps.uiOps.getWebview()?.postMessage({ type: "clearMessages" });
      await this.deps.lifecycleOps.startSession();
    }
    await this.deps.lifecycleOps.persistWorktreeBinding(this.deps.getFocused());
    this.sweepEmptySessions(this.deps.sessionOps.sessionCwd(this.deps.getFocused()));
    this.postRepoCatalog();
    this.deps.uiOps.postSessionsList();
  }

  async openSession(id: string, sessionCwd?: string): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.openSession>("openSession");
    if (testOverride) return testOverride(id, sessionCwd);

    const clock = new OpenClock();
    const claim = this.deps.lifecycleOps.reserveSessionLoad(id);
    if (!claim) {
      this.deps.host.appendLine(
        `[sessions] refused local resume (session load is reserved by another view)`,
      );
      void this.deps.host.showInformationMessage(
        "This conversation is already being opened in another tab or view.",
      );
      return;
    }
    let failure: unknown;
    try {
      const open = () => this.openSessionReserved(id, sessionCwd, clock);
      if (this.deps.host.canSwitchWorkspaceFolder) {
        await this.deps.lifecycleOps.getSwitchQueue().run(open);
      } else {
        await open();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.deps.lifecycleOps.releaseSessionLoad(id, claim.reservation, failure);
    }
    this.sweepEmptySessions(this.deps.sessionOps.sessionCwd(this.deps.getFocused()));
    // The history list follows the conversation the LOCAL user just opened.
    if (this.deps.host.canSwitchWorkspaceFolder) return;
    const openedIn = this.resolveLocalRepoTarget(
      this.deps.sessionOps.sessionCwd(this.deps.getFocused()),
    );
    if (openedIn && !pathsEqual(openedIn.cwd, this.deps.repoOps.getSelectedRepoCwd() || "")) {
      this.deps.repoOps.setSelectedRepoCwd(openedIn.cwd);
      this.postRepoCatalog();
      this.deps.uiOps.postSessionsList();
    }
  }

  localTrustedSessionCwds(overrides: SessionMetaOverrides): string[] {
    const testOverride = this.deps.getOverride?.<typeof this.localTrustedSessionCwds>(
      "localTrustedSessionCwds",
    );
    if (testOverride) return testOverride(overrides);

    const out: string[] = [];
    const seen = new Set<string>();
    const add = (cwd: string | undefined) => {
      if (!cwd) return;
      const key = normalizeRepoPath(cwd);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(cwd);
    };
    if (this.deps.host.canSwitchWorkspaceFolder) {
      for (const repoCwd of this.deps.repoOps.openWorkspaceFolders()) {
        for (const c of this.sessionCwdsForRepo(repoCwd, overrides)) add(c);
      }
      add(this.deps.repoOps.workspaceRoot());
      return out;
    }
    add(this.deps.repoOps.workspaceRoot());
    if (this.deps.repoOps.getSelectedRepoCwd()) add(this.deps.repoOps.getSelectedRepoCwd());
    for (const repo of this.repoCatalog()) {
      for (const c of this.sessionCwdsForRepo(repo.cwd, overrides)) add(c);
    }
    return out;
  }

  async followSessionWorkspace(session: Session): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.followSessionWorkspace>(
      "followSessionWorkspace",
    );
    if (testOverride) return testOverride(session);

    if (!this.deps.host.canSwitchWorkspaceFolder) return;
    const intendedTarget = session.worktree?.sourceGitRoot ?? session.cwd;
    if (!intendedTarget) {
      this.deps.host.appendLine(
        "[sessions] skipped active-folder follow (resumed session has no project root)",
      );
      return;
    }
    const target = session.cwd ? this.resolveLocalRepoTarget(session.cwd)?.cwd : undefined;
    if (!target) {
      this.deps.host.appendLine(
        `[sessions] skipped active-folder follow (no single open folder owns ${intendedTarget})`,
      );
      return;
    }
    await this.deps.lifecycleOps.switchLocalWorkspaceFolderExclusive(target, {
      warnOnRefusal: false,
    });
  }

  async openSessionReserved(
    id: string,
    sessionCwd?: string,
    clock?: OpenClock,
  ): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.openSessionReserved>(
      "openSessionReserved",
    );
    if (testOverride) return testOverride(id, sessionCwd, clock);

    for (const s of this.deps.getPool()) {
      if (s.activeSessionId === id && s.client) {
        await this.followSessionWorkspace(s);
        this.focusSession(s);
        return;
      }
    }
    this.parkFocused();
    const fresh = this.deps.lifecycleOps.newLocalSession();
    this.deps.setFocused(fresh);
    this.deps.getPool().add(fresh);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const o = overrides[id];
    fresh.provider = o?.provider ?? "grok";
    const trustedCwds = this.localTrustedSessionCwds(overrides);
    const candidates = orderedResumeCwdCandidates({
      messageCwd: sessionCwd,
      trustedCwds,
      metaWorktreePath: o?.worktreePath,
      cachedCwd: o?.providerCwd ?? this.deps.getSessionCache().get(id)?.entry.cwd,
      sameCwd: pathsEqual,
    });
    const cwd = isAdapterProvider(fresh.provider)
      ? candidates.find((candidate) => trustedCwds.some((trusted) => pathsEqual(candidate, trusted)))
      : findSessionCatalogCwd({
        fs: defaultFs,
        grokHome: resolveGrokHome(process.env),
        id,
        candidates,
      });
    if (!cwd) {
      this.deps.host.appendLine(
        `[sessions] refused resumeSession (session ${id} not found under any trusted catalog cwd)`,
      );
      void this.deps.host.showInformationMessage(
        "Could not restore this conversation. It may have been deleted. Starting a new session.",
      );
      await this.deps.lifecycleOps.startSession();
      this.postRepoCatalog();
      return;
    }
    fresh.cwd = cwd;
    if (o?.worktreePath && pathsEqual(o.worktreePath, cwd)) {
      fresh.worktree = {
        path: o.worktreePath,
        label: o.worktreeLabel || path.basename(o.worktreePath),
        sourceGitRoot: o.sourceGitRoot || this.deps.repoOps.workspaceRoot(),
      };
    } else {
      const hit = matchWorktreeForCwd(
        cwd,
        worktreesForRepo(this.deps.getWorktreeCache(), this.deps.repoOps.workspaceRoot(), {
          includeDead: true,
        }),
      );
      if (hit) {
        fresh.worktree = {
          path: hit.path,
          label: hit.label,
          sourceGitRoot: hit.sourceRepo || this.deps.repoOps.workspaceRoot(),
          id: hit.id,
        };
      }
    }
    await this.followSessionWorkspace(fresh);
    fresh.hasHistory = true;
    await this.deps.lifecycleOps.startSession(id, fresh, "ensure", clock);
    this.markRead(fresh);
    this.postRepoCatalog();
  }


  /**
     * Re-post the model catalog for a session already on screen.
     *
     * Connecting a second agent used to leave the picker stale until the user
     * clicked New session — on a session that was already new. An empty
     * conversation has nothing to protect, so its catalog is refreshed in place;
     * one with history is left alone, because changing the model list under a
     * live thread is a different thing entirely.
     */
  /**
   * The identity frame for a conversation that is already live.
   *
   * Re-focusing one replays its transcript and its UI snapshot and, until
   * 2026-09-01, stopped there. `sessionUiSnapshot` carries `modelChanged`, so
   * the model PICKER updated — but `session` is the only frame that sets the
   * provider, and it was never sent on this path. Switching from a Grok
   * conversation to a live Codex one therefore left the client believing it was
   * still on Grok: the composer said "Ask Grok", the working indicator said
   * "grokking", the model list stayed the old session's, and steering was
   * attempted against a CLI that has no such method (owner, from a phone,
   * 2026-09-01 — the model picker showing the right model while everything
   * around it showed the wrong agent is exactly this frame's absence).
   *
   * The same omission the `sessionName` note in focusSession records, one field
   * over: send the small identity frame the client needs, rather than rebuild a
   * catalog to carry it.
   *
   * `newSession: false` — a re-focus is not a new conversation, matching what
   * startSession passes for a resume.
   */
  public sessionIdentityFrame(session: Session): HostMsg | undefined {
    const testOverride = this.deps.getOverride?.<typeof this.sessionIdentityFrame>("sessionIdentityFrame");
    if (testOverride) return testOverride(session);

    const client = session.client;
    if (!client?.sessionId) return undefined;
    return {
      type: "session",
      sessionId: client.sessionId,
      // `?? []` is load-bearing. A session can have a sessionId before its
      // model list arrives — a phone JOINING a conversation the desk already
      // holds is the ordinary case — and `modelsForSession` maps over this
      // array unconditionally. Without the fallback it threw here, after
      // `clearMessages` had already gone out, so the client was left cleared
      // with an error instead of a transcript. Ten integration tests said so
      // and I had not run them.
      models: this.deps.sidebarOps.modelsForSession(session, client.availableModels ?? [], client.currentModelId, false),
      currentModelId: client.currentModelId,
      worktree: !!session.worktree,
      provider: session.provider
    };
  }

  /** Synthesize a list entry for a live session grok hasn't written a `summary.json` for yet (a
     *  brand-new one). The disk-scan index can't see it, so without this the active row would vanish
     *  from history when the popover is opened the instant a session goes live. Uses the best name we
     *  have in memory: a generated/renamed `customName`, else the first user message, else a
     *  placeholder — all of which the next refresh replaces with grok's own summary once it lands. */
  /** The name this session shows in the history list — what the user actually
   *  reads, which is what a fork should be named after (#48).
   *
   *  Precedence mirrors the list itself: the user's `customName` first (that IS
   *  the row's label for any session that has one), then grok's own title, then
   *  the first user message.
   *
   *  The one deliberate departure: a **legacy primer-derived** title is skipped.
   *  Older builds sent the primer as message #1, so inheriting that invisible
   *  internal title into a fork would propagate it forever. `cliSessionTitle`
   *  rejects it and we fall through to something real. */
  public sessionDisplayName(session: Session): string {
    const testOverride = this.deps.getOverride?.<typeof this.sessionDisplayName>("sessionDisplayName");
    if (testOverride) return testOverride(session);

    const id = session.activeSessionId;
    if (!id) return "";
    const override = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    const custom = override?.customName?.trim();
    if (custom) return custom;
    // A live empty session is deliberately shown as "New session" in the
    // history list, even if grok has already left a summary file behind.
    if (!session.hasHistory) return "New session";
    try {
      const cwd = this.deps.sidebarOps.sessionCwd(session);
      const grokHome = resolveGrokHome(process.env);
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) throw new Error("no session dir");
      const raw = JSON.parse(fs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      const title = cliSessionTitle(raw?.session_summary, raw?.generated_title);
      if (title) return fallbackName(title, Date.now());
    } catch {
      // No summary yet (grok flushes it at turn end) — fall through.
    }
    // Same last resort the history list uses ("Untitled (<date>)"), so a fork of
    // a nameless session reads like a row rather than a bare "(Fork)".
    const generated = (override?.autoName || "").trim();
    const opening = (session.firstUserMessageForTitle || "").trim();
    const first = session.client && isAdapterProvider(session.client.provider) ? generated || opening : opening || generated;
    return fallbackName(first, Date.now());
  }

  /** Push the focused conversation's title independently of history pagination.
     *  The VS Code webview must not depend on the history popover having been
     *  opened. */
  public postSessionName(session: Session, name = this.sessionDisplayName(session)): void {
    const testOverride = this.deps.getOverride?.<typeof this.postSessionName>("postSessionName");
    if (testOverride) return testOverride(session, name);

    const id = session.activeSessionId;
    if (!id) return;
    const cwd = this.deps.sidebarOps.sessionCwd(session);
    // The owning PROJECT, resolved the same way the rail groups worktrees under
    // their parent. Only when it differs from the cwd — an ordinary session is
    // its own project and the field would be noise.
    const owner = this.deps.sidebarOps.resolveLocalRepoTarget(cwd)?.cwd;
    const message: HostMsg = {
      type: "sessionName",
      sessionId: id,
      name,
      cwd,
      ...(owner && !pathsEqual(owner, cwd) ? { repoCwd: owner } : {})
    };
    if (session === this.deps.sidebarOps.focused) this.deps.sidebarOps.postLocal(message);
  }

  public liveSessionEntry(
    session: Session,
    id: string,
    cwd: string,
    overrides: SessionMetaOverrides,
  ): SessionListEntry {
    const testOverride = this.deps.getOverride?.<typeof this.liveSessionEntry>("liveSessionEntry");
    if (testOverride) return testOverride(session, id, cwd, overrides);

    const now = Date.now();
    const customName = overrides[id]?.customName?.trim() || undefined;
    // No summary.json to read yet, so grok has no title for this one — the best
    // we have is the opening message, live or as the stored `autoName`.
    const firstMsg = (session.firstUserMessageForTitle || "").trim()
      || (overrides[id]?.autoName || "").trim();
    const displayName = customName || (firstMsg ? fallbackName(firstMsg, now) : "New session");
    const ts = session.lastActiveAt || now;
    return {
      id,
      cwd,
      displayName,
      rawSummary: firstMsg,
      customName,
      updatedAt: ts,
      createdAt: ts,
      numMessages: session.userMessageCount,
      modelId: undefined,
      provider: session.provider
    };
  }

  /**
     * Like {@link readEntriesCached} but each id may live under a different cwd
     * (workspace vs worktree). Groups stale ids by cwd so we still batch the
     * disk reads per catalog.
     */
  public readEntriesCachedMulti(
    ids: string[],
    mtimeById: Map<string, number>,
    cwdById: Map<string, string>,
    overrides: SessionMetaOverrides,
    grokHome: string,
    log: (m: string) => void,
  ): SessionListEntry[] {
    const testOverride = this.deps.getOverride?.<typeof this.readEntriesCachedMulti>("readEntriesCachedMulti");
    if (testOverride) return testOverride(ids, mtimeById, cwdById, overrides, grokHome, log);

    const staleByCwd = new Map<string, string[]>();
    for (const id of ids) {
      const cached = this.deps.sidebarOps.sessionCache.get(id);
      if (cached && cached.mtimeMs === (mtimeById.get(id) ?? -1)) continue;
      const c = cwdById.get(id) || this.deps.sidebarOps.workspaceRoot();
      const list = staleByCwd.get(c) ?? [];
      list.push(id);
      staleByCwd.set(c, list);
    }
    for (const [c, stale] of staleByCwd) {
      const fresh = readSessionEntries({ fs: defaultFs, grokHome, cwd: c, ids: stale, overrides, log });
      for (const e of fresh) {
        this.deps.sidebarOps.sessionCache.set(e.id, { mtimeMs: mtimeById.get(e.id) ?? 0, entry: e });
      }
    }
    return ids.map((id) => this.deps.sidebarOps.sessionCache.get(id)?.entry).filter((e): e is SessionListEntry => !!e);
  }

  public annotateWorktreeLabels(
    entries: SessionListEntry[],
    overrides: SessionMetaOverrides,
    workspaceCwd: string,
  ): void {
    const testOverride = this.deps.getOverride?.<typeof this.annotateWorktreeLabels>("annotateWorktreeLabels");
    if (testOverride) return testOverride(entries, overrides, workspaceCwd);

    const repoWts = worktreesForRepo(this.deps.sidebarOps.worktreeCache, workspaceCwd, { includeDead: true });
    for (const e of entries) {
      const fromMeta = overrides[e.id]?.worktreeLabel;
      if (fromMeta) {
        e.worktreeLabel = fromMeta;
        continue;
      }
      const hit = matchWorktreeForCwd(e.cwd, repoWts);
      if (hit) e.worktreeLabel = hit.label;
      else if (e.cwd && !pathsEqual(e.cwd, workspaceCwd)) {
        // Session lives outside the workspace (likely a worktree we no longer
        // track) — still surface the basename so the row is distinguishable.
        e.worktreeLabel = path.basename(e.cwd);
      }
    }
  }

  /** Answer `listRepoSessions`: the newest few sessions for ONE repo, without
     *  making it the client's selection. `cwd` is matched against the catalog the
     *  client was already sent. Unknown and unavailable paths receive the same
     *  coarse empty refusal, so a remote cannot use the answer to probe whether
     *  an arbitrary path exists on the host. Both local and remote use
     *  {@link localRepoCatalogEntries} (open folders on desktop, full catalog on
     *  VS Code) so the preview scope cannot exceed the trust set. */
  public buildRepoSessionsPreview(
    cwd: string,
    limit: number | undefined,
    activeId: string | null | undefined,
  ): HostMsg {
    const testOverride = this.deps.getOverride?.<typeof this.buildRepoSessionsPreview>("buildRepoSessionsPreview");
    if (testOverride) return testOverride(cwd, limit, activeId);

    const hit = this.deps.sidebarOps.resolveLocalRepoTarget(cwd);
    if (!hit || !hit.available) {
      this.deps.sidebarOps.host.appendLine(`[rail] listRepoSessions failed: project unavailable`);
      return { type: "repoSessions", cwd, entries: [], dots: {}, total: 0, error: "project-unavailable" };
    }
    // Clamp: the rail wants a handful, and an unbounded limit would make every
    // repo row a full history read.
    const size = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || REPO_PREVIEW_SIZE));
    const list = this.buildSessionsList(
      hit.cwd,
      { offset: 0, limit: size },
      activeId,
    );
    if (list.type !== "sessions") {
      this.deps.sidebarOps.host.appendLine(`[rail] listRepoSessions failed: session list unavailable`);
      return { type: "repoSessions", cwd: hit.cwd, entries: [], dots: {}, total: 0, error: "sessions-unavailable" };
    }
    return {
      type: "repoSessions",
      // The host's own spelling, not the one the client sent — the rail keys its
      // rows on this, and echoing an arbitrary casing would split one repo into
      // two rail entries.
      cwd: hit.cwd,
      entries: list.entries,
      dots: list.dots,
      total: list.total
    };
  }

  public sendLocalRepoSessionsPreview(cwd: string, limit?: number): void {
    const testOverride = this.deps.getOverride?.<typeof this.sendLocalRepoSessionsPreview>("sendLocalRepoSessionsPreview");
    if (testOverride) return testOverride(cwd, limit);

    this.deps.sidebarOps.postLocal(this.buildRepoSessionsPreview(cwd, limit, this.deps.sidebarOps.focused.activeSessionId));
  }

  /** Pin/unpin one conversation. Stored on the session's own override entry, so
     *  it survives a rename and travels with nothing else — `pinnedCwd` is kept
     *  alongside because the Pinned group spans repos and has to know where to
     *  read each session from without scanning every checkout. */
  public async toggleSessionPin(id: string, cwd: string | undefined, pinned: boolean): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.toggleSessionPin>("toggleSessionPin");
    if (testOverride) return testOverride(id, cwd, pinned);

    if (!id) return;
    await this.updateSessionMeta((overrides) => {
      const existing = overrides[id];
      // Resolve the home repo once, at pin time: the client sends the row's own
      // cwd (already gated against the catalog), and falling back to whatever
      // repo happens to be selected would file the pin under the wrong project.
      const cachedAdapterCwd = [...this.deps.sidebarOps.allAdapterCatalogs()].flat().find((entry) => entry.id === id)?.cwd;
      const home = cwd || existing?.pinnedCwd || this.deps.sidebarOps.sessionCache.get(id)?.entry.cwd || cachedAdapterCwd;
      if (!home) return null; // nothing to write (pin or unpin)
      // Authorization is not only "cwd was once in the catalog": a remote client
      // that knows a session id must not mutate pin state for a closed project.
      // No protocol change — wire still allows optional cwd; we re-check home.
      if (!this.deps.sidebarOps.isAuthorizedCwd(home)) return null;
      const next: SessionMetaOverrides = { ...overrides };
      const entry = { ...(existing ?? {}) };
      if (pinned) {
        entry.pinnedAt = Date.now();
        entry.pinnedCwd = home;
      } else {
        delete entry.pinnedAt;
        delete entry.pinnedCwd;
      }
      // An override that now carries nothing is noise in globalState — drop it
      // rather than accumulating empty objects for every session ever unpinned.
      if (Object.keys(entry).length === 0) delete next[id];
      else next[id] = entry;
      return next;
    });
    // The pin lives in globalState, not in the session's summary.json, so the
    // file's mtime does not move and the entry cache would keep serving a row
    // with the OLD pin state — the pin control would then still say "Pin" right
    // after pinning, and clicking it would pin again instead of unpinning. Same
    // reason `customName` invalidates here: an override changes the entry
    // without touching disk.
    this.deps.sidebarOps.sessionCache.delete(id);
    this.deps.sidebarOps.postSessionsList(); // fans out the pinned refresh too
  }

  public updateSessionMeta(
    mutate: (current: SessionMetaOverrides) => SessionMetaOverrides | null,
  ): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.updateSessionMeta>("updateSessionMeta");
    if (testOverride) return testOverride(mutate);

    const run = this.sessionMetaWrites.then(async () => {
      const current = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const next = mutate(current);
      if (next) await this.deps.sidebarOps.state.update(SESSION_META_KEY, capSessionMetaAutoNames(next).value);
    });
    // Keep the chain alive even if one link throws, or every later write dies.
    this.sessionMetaWrites = run.catch(() => { });
    return run;
  }

  /** Session catalogs to index for a repo row: the checkout itself plus the
     *  isolated worktrees that belong to it. Worktrees are deliberately NOT repo
     *  rows (a worktree is not a checkout you choose between, and `discoverRepos`
     *  excludes `<grokHome>/worktrees` by path), so their sessions have to surface
     *  under the parent — otherwise leaving a worktree session strands it. */
  public sessionCwdsForRepo(repoCwd: string, overrides: SessionMetaOverrides): string[] {
    const testOverride = this.deps.getOverride?.<typeof this.sessionCwdsForRepo>("sessionCwdsForRepo");
    if (testOverride) return testOverride(repoCwd, overrides);

    const cwds: string[] = [];
    const seen = new Set<string>();
    const add = (p?: string) => {
      if (!p) return;
      const key = normalizeFsPath(p);
      if (!key || seen.has(key)) return;
      seen.add(key);
      cwds.push(p);
    };
    add(repoCwd);
    const known: WorktreeParentRef[] = [
      ...Object.values(overrides)
        .filter((o) => o.worktreePath)
        .map((o) => ({ path: o.worktreePath!, sourceGitRoot: o.sourceGitRoot })),
      ...this.deps.sidebarOps.worktreeCache.map((wt) => ({ path: wt.path, sourceGitRoot: wt.sourceRepo })),
      ...[...this.deps.sidebarOps.pool]
        .filter((s) => s.worktree)
        .map((s) => ({ path: s.worktree!.path, sourceGitRoot: s.worktree!.sourceGitRoot })),
    ];
    for (const p of worktreeCwdsForRepo({
      repoCwd,
      repoGitRoot: gitRootForPath(repoCwd, defaultFs) ?? repoCwd,
      worktrees: known
    })) {
      add(p);
    }
    return cwds;
  }

  /** The dashboard dot for a grok-session id, from live status (if it's a live pool
     *  member) plus the persisted unread badge (which outlives the live process). */
  public dotForId(id: string): Dot {
    const testOverride = this.deps.getOverride?.<typeof this.dotForId>("dotForId");
    if (testOverride) return testOverride(id);

    const live = [...this.deps.sidebarOps.pool].find((s) => s.activeSessionId === id);
    const meta = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    return computeDot({ liveStatus: live?.status, unread: meta?.unread, unreadError: meta?.unreadError });
  }

  /** Persist (or clear) a session's unread badge in globalState session-meta. */
  public setMetaUnread(id: string | undefined, unread: boolean, error: boolean): void {
    const testOverride = this.deps.getOverride?.<typeof this.setMetaUnread>("setMetaUnread");
    if (testOverride) return testOverride(id, unread, error);

    if (!id) return;
    const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const next: SessionMetaOverrides = { ...overrides };
    if (unread) {
      if (cur.unread && !!cur.unreadError === error) return; // unchanged
      next[id] = { ...cur, unread: true, unreadError: error || undefined };
    } else {
      if (!cur.unread && !cur.unreadError) return; // nothing to clear
      const { unread: _u, unreadError: _e, ...rest } = cur;
      if (Object.keys(rest).length === 0) delete next[id];
      else next[id] = rest;
    }
    void this.deps.sidebarOps.state.update(SESSION_META_KEY, next);
  }

  /** Clear a session's unread badge (it's being opened/viewed) and refresh its dot. */
  public markRead(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.markRead>("markRead");
    if (testOverride) return testOverride(session);

    const id = session.activeSessionId;
    if (!id) return;
    const meta = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    if (!meta?.unread && !meta?.unreadError) return;
    this.setMetaUnread(id, false, false);
    this.deps.sidebarOps.pushDot(session);
  }

  /**
     * Mark a conversation as used NOW, and re-push the lists that order by it.
     *
     * Called when a message is sent and when a session is created — the two
     * moments a person would expect their conversation to jump to the top. The
     * lists order by the recency clock (`updates.jsonl` mtime for grok; host
     * `activeAt` for adapters), and grok writes that file about 2.1 seconds
     * after a send (measured), so without this the row sits still through
     * the whole wait and a brand-new conversation is missing entirely.
     *
     * Every project and every session is treated the same; there is no special
     * case for archived, which is a client presentation concept and has no
     * business in the activity path.
     */
  public noteSessionActivity(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.noteSessionActivity>("noteSessionActivity");
    if (testOverride) return testOverride(session);

    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const activeAt = Date.now();
    const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.deps.sidebarOps.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...(overrides[sid] ?? {}), activeAt }
    });
    for (const provider of (["codex", "claude", "gemini", "muse"] as const)) {
      const history = this.deps.sidebarOps.adapterHistory(provider);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(key, entries.map((entry) =>
          entry.id === sid ? { ...entry, updatedAt: activeAt } : entry));
      }
    }
    const cwd = this.deps.sidebarOps.sessionCwd(session);
    this.deps.sidebarOps.postSessionsList();
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
  }

  /**
     * Re-push the project preview a finished turn just reordered.
     *
     * The rail's Recent group ranks by `updatedAt`, which is the session FILE's
     * mtime — and the extension is not what writes that file, the agent process
     * is. So rename and delete refresh (we do those) while sending a message did
     * not: nothing in here knew the row had moved. Recent stayed on whatever
     * order it was built with until something unrelated happened to redraw it.
     *
     * The turn ending is the closest signal we own. The agent writes the
     * transcript around the same moment, not necessarily before, so this reads a
     * beat later — and once more after that, because a single delay is a guess
     * about someone else's disk write. Two cheap directory scans, only when a
     * turn actually ended.
     */
  public refreshSessionOrderAfterTurn(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.refreshSessionOrderAfterTurn>("refreshSessionOrderAfterTurn");
    if (testOverride) return testOverride(session);

    const cwd = this.deps.sidebarOps.sessionCwd(session);
    if (!cwd) return;
    for (const delay of [400, 1600]) {
      const timer = setTimeout(() => {
        this.turnOrderTimers.delete(timer);
        try {
          this.sendLocalRepoSessionsPreview(cwd);
        } catch {
          /* a preview refresh is never worth failing a turn over */
        }
      }, delay);
      this.turnOrderTimers.add(timer);
    }
  }

  /** Adapter catalogs own their persistence, so abandoning an empty conversation
     *  must use the advertised ACP delete rather than touching Grok's store. */
  public async discardAdapterEmptySession(
    provider: AcpProvider,
    id: string | undefined,
    cwd: string,
    liveClient?: AcpClient,
  ): Promise<boolean> {
    const testOverride = this.deps.getOverride?.<typeof this.discardAdapterEmptySession>("discardAdapterEmptySession");
    if (testOverride) return testOverride(provider, id, cwd, liveClient);

    if (!id || !isAdapterProvider(provider)) return false;
    // A live client proves this conversation already ran; a temporary one may
    // only be spawned for a connected agent (#171).
    if (!liveClient && !this.deps.sidebarOps.hasProviderConsent(provider)) return false;
    let temporary: AcpClient | undefined;
    try {
      let client = liveClient;
      if (!client) {
        const cliPath = this.deps.sidebarOps.locateProvider(provider);
        const backend = this.deps.sidebarOps.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${providerDisplayName(provider)} CLI is not available.`);
        client = temporary = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.deps.sidebarOps.host.appendLine(message)
        });
        await client.start();
      }
      await client.deleteSession(id);
      const history = this.deps.sidebarOps.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => entry.id !== id));
        }
      }
      const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      if (overrides[id]) {
        const next = { ...overrides };
        delete next[id];
        await this.deps.sidebarOps.state.update(SESSION_META_KEY, next);
      }
      return true;
    } catch (error) {
      this.deps.sidebarOps.host.appendLine(`[${provider}] could not discard empty session ${id}: ${(error as Error).message}`);
      return false;
    } finally {
      if (temporary) await temporary.dispose();
    }
  }

  /** Retire choices superseded by transcript activity, including worktrees.
     *  Store maintenance only, performed when publishing the catalog. */
  public normalizeArchiveChoices(): void {
    const testOverride = this.deps.getOverride?.<typeof this.normalizeArchiveChoices>("normalizeArchiveChoices");
    if (testOverride) return testOverride();

    if (!this.deps.sidebarOps.host.canArchiveRepos) return;
    const archives = this.deps.sidebarOps.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {});
    if (!Object.keys(archives).length) return;
    const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const grokHome = resolveGrokHome(process.env);
    const expired = expiredArchiveChoiceKeys({
      archives,
      newestActivityAt: (cwd: string) => {
        let newest = 0;
        for (const c of this.sessionCwdsForRepo(cwd, overrides)) {
          const at = newestTranscriptMtime({ fs: defaultFs, grokHome, cwd: c });
          if (at > newest) newest = at;
        }
        return newest;
      }
    });
    if (!expired.length) return;
    const next: RepoArchives = { ...archives };
    for (const key of expired) {
      this.deps.sidebarOps.host.appendLine(`[archive] ${next[key]?.cwd ?? key} has been worked in since — its archive choice no longer applies`);
      delete next[key];
    }
    void this.deps.sidebarOps.state.update(REPO_ARCHIVES_KEY, next);
  }

  public sessionMetaWrites: Promise<void> = Promise.resolve();

  public turnOrderTimers = new Set<ReturnType<typeof setTimeout>>();

  dispose(): void {
    for (const timer of this.turnOrderTimers) clearTimeout(timer);
    this.turnOrderTimers.clear();
  }


  /** Last real sweep per repo, for SWEEP_INTERVAL_MS. */
  public lastSweepAt = new Map<string, number>();


  /** Every session id in a repo that has been PROVEN to hold real work, for this
   *  activation. The sweep runs on every new/opened session, and without this each
   *  run would re-read every `summary.json` under the repo; with it, a repeat run
   *  reads only directories it has never classified. Safe to keep forever: a
   *  session that has a real user turn never becomes empty again. Keyed by
   *  {@link normalizeRepoPath}. */
  public provenNonEmpty = new Map<string, Set<string>>();
}

export function createSessionCatalog(deps: SessionCatalogDeps): SessionCatalog {
  return new SessionCatalog(deps);
}

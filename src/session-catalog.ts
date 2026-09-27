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
import {
  Session,
  SessionStartIntent,
  sessionUiSnapshot,
} from "./session";
import { type Dot } from "./session-pool";
import type { HostMsg } from "./protocol";
import { OpenClock } from "./open-timing";
import {
  SESSION_META_KEY,
} from "./worktree-host";
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
  sessionDirFor,
} from "./sessions";
import { withoutArchiveFields } from "./project-discovery";
import {
  adapterEntriesEligibleForClear,
  adapterListEntry,
  findCachedAdapterSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  projectProviderKey,
  type ProviderHistoryCursor,
} from "./provider-ui";
import {
  effectiveSessionType,
} from "./session-type";
import {
  authorizedListCwd,
  filterEntriesByAuthorizedCwd,
} from "./workspace-auth";
import {
  matchWorktreeForCwd,
  mergeSessionIndexes,
  normalizeFsPath,
  pathsEqual,
  type WorktreeRecord,
  worktreesForRepo,
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
  sessionCwdsForRepo(repoCwd: string, overrides: SessionMetaOverrides): string[];
  defaultProviderForProject(cwd: string): AcpProvider;
  selectedHistoryCwd(): string;
  getSelectedRepoCwd(): string | undefined;
  setSelectedRepoCwd(cwd: string | undefined): void;
  workspaceRoot(): string;
  canAddProjectFolder(): boolean;
  normalizeArchiveChoices(): void;
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
  discardAdapterEmptySession(
    provider: AcpProvider,
    id: string | undefined,
    cwd: string,
    client?: AcpClient,
  ): Promise<boolean>;
}

export interface SessionCatalogSessionOps {
  authorizedSessionCwds(): string[];
  historyCwdFor(): string;
  sessionCwd(session: Session): string;
  setSessionCwd(session: Session, cwd: string, workspaceRoot?: string): void;
  readEntriesCachedMulti(
    ids: string[],
    mtimeById: Map<string, number>,
    cwdById: Map<string, string>,
    overrides: SessionMetaOverrides,
    grokHome: string,
    log: (m: string) => void,
  ): SessionListEntry[];
  liveSessionEntry(
    session: Session,
    id: string,
    cwd: string,
    overrides: SessionMetaOverrides,
  ): SessionListEntry;
  dotForId(id: string): Dot;
  annotateWorktreeLabels(
    entries: SessionListEntry[],
    overrides: SessionMetaOverrides,
    workspaceCwd: string,
  ): void;
  workflowStore(): { defs: Map<string, any> };
  workflowRuns(): { readRun(id: string): any };
  resolveWorkflow(session: Session, name: string): any;
  updateSessionMeta(
    updater: (current: SessionMetaOverrides) => SessionMetaOverrides | null,
  ): Promise<void>;
  touch(session: Session): void;
  markRead(session: Session): void;
  refreshWorkflowCompletions(session: Session): void;
}

export interface SessionCatalogUiOps {
  postLocal(msg: HostMsg | any): void;
  postSessionName(session: Session): void;
  postSessionsList(): void;
  sendLocalRepoSessionsPreview(cwd: string): void;
  postMode(): void;
  postChildContext(session: Session): void;
  postSessionRemoved(id: string | undefined, cwd: string): void;
  sessionIdentityFrame(session: Session): any;
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
  getLastSweepAt(): Map<string, number>;
  getProvenNonEmpty(): Map<string, Set<string>>;
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
}

export class SessionCatalog {
  constructor(private readonly deps: SessionCatalogDeps) {}

  private allAdapterCatalogs(): Iterable<readonly SessionListEntry[]> {
    return this.deps.adapterOps.allAdapterCatalogs();
  }

  private disposeSession(session: Session): Promise<void> {
    return this.deps.lifecycleOps.disposeSession(session);
  }

  private sendLocalRepoSessionsPreview(cwd: string): void {
    this.deps.uiOps.sendLocalRepoSessionsPreview(cwd);
  }

  private sessionIdentityFrame(session: Session): any {
    return this.deps.uiOps.sessionIdentityFrame(session);
  }

  repoCatalog(): RepoListEntry[] {
    const override = this.deps.getOverride?.<typeof this.repoCatalog>("repoCatalog");
    if (override) return override();

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
    const override = this.deps.getOverride?.<typeof this.localRepoCatalogEntries>(
      "localRepoCatalogEntries",
    );
    if (override) return override();

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
    const override = this.deps.getOverride?.<typeof this.resolveLocalRepoTarget>(
      "resolveLocalRepoTarget",
    );
    if (override) return override(cwd);

    const entries = this.localRepoCatalogEntries();
    let hit = entries.find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) {
      const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const owners = entries.filter(
        (r) =>
          r.available &&
          this.deps.repoOps
            .sessionCwdsForRepo(r.cwd, overrides)
            .some((c) => pathsEqual(c, cwd)),
      );
      hit = owners.length === 1 ? owners[0] : undefined;
    }
    if (!hit || !hit.available) return undefined;
    return hit;
  }

  postRepoCatalog(): void {
    const override = this.deps.getOverride?.<typeof this.postRepoCatalog>("postRepoCatalog");
    if (override) return override();

    this.deps.repoOps.normalizeArchiveChoices();
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
    const override = this.deps.getOverride?.<typeof this.buildPinnedSessions>(
      "buildPinnedSessions",
    );
    if (override) return override();

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
        ...this.deps.sessionOps.readEntriesCachedMulti(
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
    for (const e of filtered) dots[e.id] = this.deps.sessionOps.dotForId(e.id);
    return { entries: filtered, dots };
  }

  postPinnedSessions(): void {
    const override = this.deps.getOverride?.<typeof this.postPinnedSessions>("postPinnedSessions");
    if (override) return override();

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
    const override = this.deps.getOverride?.<typeof this.buildSessionsList>("buildSessionsList");
    if (override) return override(cwd, opts, activeId);

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
        this.deps.sessionOps.liveSessionEntry(
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
    for (const entry of entries) dots[entry.id] = this.deps.sessionOps.dotForId(entry.id);
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
    const override = this.deps.getOverride?.<typeof this.scheduleAdapterHistoryRefresh>(
      "scheduleAdapterHistoryRefresh",
    );
    if (override) return override(provider, cwd);

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
    const override = this.deps.getOverride?.<typeof this.refreshCodexHistory>("refreshCodexHistory");
    if (override) return override(cwd, key);
    return this.refreshAdapterHistory("codex", cwd, key);
  }

  async refreshAdapterHistory(
    provider: AcpProvider,
    cwd: string,
    key = projectProviderKey(cwd),
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.refreshAdapterHistory>(
      "refreshAdapterHistory",
    );
    if (override) return override(provider, cwd, key);

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
      await this.deps.sessionOps.updateSessionMeta((current) => {
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
    const override = this.deps.getOverride?.<typeof this.buildGrokSessionsList>(
      "buildGrokSessionsList",
    );
    if (override) return override(cwd, opts, activeId);

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

    const repoCwds = this.deps.repoOps.sessionCwdsForRepo(cwd, overrides);
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
      const all = this.deps.sessionOps
        .readEntriesCachedMulti(
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
      pageEntries = this.deps.sessionOps
        .readEntriesCachedMulti(pageIds, mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      pageEntries.sort((a: SessionListEntry, b: SessionListEntry) => b.updatedAt - a.updatedAt);
      nextOffset = offset + pageIds.length;
    }
    this.deps.sessionOps.annotateWorktreeLabels(pageEntries, overrides, cwd);
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
        const entry = this.deps.sessionOps.liveSessionEntry(s, id, sCwd, overrides);
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
    for (const e of pageEntries) dots[e.id] = this.deps.sessionOps.dotForId(e.id);
    for (const s of this.deps.getPool()) {
      if (s.activeSessionId && !(s.activeSessionId in dots)) {
        dots[s.activeSessionId] = this.deps.sessionOps.dotForId(s.activeSessionId);
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
    const override = this.deps.getOverride?.<typeof this.renameSession>("renameSession");
    if (override) return override(id, name, requestedCwd);

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
    if (live) this.deps.uiOps.postSessionName(live);
    if (requestedCwd) this.sendLocalRepoSessionsPreview(requestedCwd);
  }

  sessionHasLiveOwner(session: Session): boolean {
    return session === this.deps.getFocused();
  }

  reportProtectedSession(action: "delete" | "clear"): void {
    const text =
      action === "delete"
        ? "This conversation is open. Close it before deleting it."
        : "Open conversations were kept. Close them before clearing them.";
    void this.deps.host.showInformationMessage(text);
  }

  notifyUser(level: "info" | "warning" | "error", text: string): void {
    if (level === "error") void this.deps.host.showErrorMessage(text);
    else if (level === "warning") void this.deps.host.showWarningMessage(text);
    else void this.deps.host.showInformationMessage(text);
  }

  async deleteSession(
    id: string,
    _name: string | undefined,
    requestedCwd?: string,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.deleteSession>("deleteSession");
    if (override) return override(id, _name, requestedCwd);

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
    const override = this.deps.getOverride?.<typeof this.clearAllSessions>("clearAllSessions");
    if (override) return override(requestedCwd);

    const repo = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, requestedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwds = this.deps.repoOps.sessionCwdsForRepo(cwd, overrides);
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
      this.deps.uiOps.sendLocalRepoSessionsPreview(cwd);
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
    const override = this.deps.getOverride?.<typeof this.focusSession>("focusSession");
    if (override) return override(session);

    if (session === this.deps.getFocused()) return;
    this.deps.setFocused(session);
    this.deps.sessionOps.touch(session);
    this.deps.sessionOps.markRead(session);
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
    this.deps.uiOps.postSessionName(session);
    this.deps.uiOps.postChildContext(session);
  }

  parkFocused(): void {
    const override = this.deps.getOverride?.<typeof this.parkFocused>("parkFocused");
    if (override) return override();

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
    const override = this.deps.getOverride?.<typeof this.teardownEmptySession>(
      "teardownEmptySession",
    );
    if (override) return override(session);

    const id = session.activeSessionId;
    const cwd = this.deps.sessionOps.sessionCwd(session);
    const provider = session.provider;
    const client = isAdapterProvider(provider)
      ? this.deps.lifecycleOps.detachClient(session)
      : undefined;
    void this.deps.lifecycleOps.disposeSession(session);
    if (isAdapterProvider(provider)) {
      void this.deps.adapterOps
        .discardAdapterEmptySession(provider, id, cwd, client)
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
    const override = this.deps.getOverride?.<typeof this.removeSessionFromDisk>(
      "removeSessionFromDisk",
    );
    if (override) return override(id, sessionCwd);

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
    const override = this.deps.getOverride?.<typeof this.sweepEmptySessions>("sweepEmptySessions");
    if (override) return override(cwd, opts);

    if (!cwd) return;
    const repoKey = normalizeRepoPath(cwd);
    const startedAt = Date.now();
    const lastSweepAt = this.deps.lifecycleOps.getLastSweepAt();
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

    const provenNonEmpty = this.deps.lifecycleOps.getProvenNonEmpty();
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
    const override = this.deps.getOverride?.<typeof this.newFocusedSession>("newFocusedSession");
    if (override) return override(requestedCwd);

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
    const override = this.deps.getOverride?.<typeof this.openSession>("openSession");
    if (override) return override(id, sessionCwd);

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
    const override = this.deps.getOverride?.<typeof this.localTrustedSessionCwds>(
      "localTrustedSessionCwds",
    );
    if (override) return override(overrides);

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
        for (const c of this.deps.repoOps.sessionCwdsForRepo(repoCwd, overrides)) add(c);
      }
      add(this.deps.repoOps.workspaceRoot());
      return out;
    }
    add(this.deps.repoOps.workspaceRoot());
    if (this.deps.repoOps.getSelectedRepoCwd()) add(this.deps.repoOps.getSelectedRepoCwd());
    for (const repo of this.repoCatalog()) {
      for (const c of this.deps.repoOps.sessionCwdsForRepo(repo.cwd, overrides)) add(c);
    }
    return out;
  }

  async followSessionWorkspace(session: Session): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.followSessionWorkspace>(
      "followSessionWorkspace",
    );
    if (override) return override(session);

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
    const override = this.deps.getOverride?.<typeof this.openSessionReserved>(
      "openSessionReserved",
    );
    if (override) return override(id, sessionCwd, clock);

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
    this.deps.sessionOps.markRead(fresh);
    this.postRepoCatalog();
  }
}

export function createSessionCatalog(deps: SessionCatalogDeps): SessionCatalog {
  return new SessionCatalog(deps);
}

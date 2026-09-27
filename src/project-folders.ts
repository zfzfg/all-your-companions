/**
 * ProjectFolders: management of workspace folders, new project creation,
 * repository cloning, and folder revocation lifecycle.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S5).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MementoLike } from "./persisted-state";
import type { HostWebview } from "./host";
import type { HostMsg, GithubState } from "./protocol";
import type { AcpProvider } from "./acp-backend";
import type { Session } from "./session";
import type { AsyncSerialQueue } from "./async-serial";
import { pathsEqual } from "./worktree";
import { normalizeRepoPath } from "./sessions";
import { sessionBoundToClosedFolder, pathBoundToClosedFolder, imageHandlesToRevoke } from "./workspace-auth";
import { sessionHasWorkInFlight } from "./session";
import {
  githubEnvTokenName,
  githubEnvTokenBlocksSignOutMessage,
  readGithubAuthState,
  logoutGithub,
  loginGithubWithToken,
  listGithubRepositories,
  DISCONNECTED_GITHUB,
  type GithubAuthState,
} from "./github-auth";
import {
  GITHUB_CLI_DOWNLOAD,
  githubCliInstallCommand,
  githubSignInCommand,
  projectNameError,
  projectDestination,
  cloneUrlError,
  cloneDestination,
  normalizeCloneUrl,
  classifyCloneFailure,
  cloneFailureText,
  offersGithubSetup,
  githubFixFor,
  displayPath,
  legacyProjectRootPath,
  shouldUseLegacyRoot,
  rememberedRootFor,
  projectRoot,
} from "./project-create";
import { commandOnPath, runGitClone } from "./git-clone";

export const REMOVED_PROJECT_FOLDERS_KEY = "grok.removedProjectFolders";
export const EXTRA_PROJECT_FOLDERS_KEY = "grok.extraProjectFolders";
export const REPO_PINS_KEY = "grok.repoPins";
export const PROJECT_ROOT_CHOICE_KEY = "grok.projectRootChoice";
export const SESSION_META_KEY = "grok.sessionMetaOverrides";

export type RepoPins = Record<string, boolean>;
export type SessionMetaOverrides = Record<
  string,
  { worktreePath?: string; worktreeLabel?: string; sourceGitRoot?: string; [key: string]: unknown }
>;

export interface ProjectFoldersHostOps {
  canSwitchWorkspaceFolder: boolean;
  workspaceRoot(): string;
  openWorkspaceFolders(): readonly string[];
  showOpenDialog(options: any): Promise<string[] | undefined> | Thenable<string[] | undefined>;
  showWarningMessage(msg: string, ...args: any[]): Promise<any> | Thenable<any>;
  addWorkspaceFolder(folder: string): boolean;
  removeWorkspaceFolder(folder: string): boolean;
  setActiveWorkspaceFolder(target: string): boolean;
  appendLine(line: string): void;
  createTerminal(options: { name: string }): { show(): void; sendText(text: string): void };
}

export interface ProjectFoldersSessionOps {
  getFocused(): Session;
  setFocused(s: Session): void;
  getPool(): Set<Session>;
  newLocalSession(): Session;
  sessionCwd(s: Session): string;
  setSessionCwd(s: Session, cwd: string, explicit: string): void;
  startSession(id?: string, session?: Session, mode?: string): Promise<any>;
  parkFocused(): void;
  disposeSession(s: Session): Promise<void>;
  defaultProviderForProject(cwd: string): AcpProvider;
  isAuthorizedCwd(cwd?: string): boolean;
}

export interface ProjectFoldersUiOps {
  emit(s: Session, msg: HostMsg): void;
  post(msg: HostMsg): void;
  postRepoCatalog(): void;
  postSessionsList(): void;
  getSelectedRepoCwd(): string | undefined;
  setSelectedRepoCwd(cwd: string): void;
  getSettingsEditorWebview(): HostWebview | undefined;
}

export interface ProjectFoldersCatalogOps {
  resolveLocalRepoTarget(cwd: string): any;
  workspaceRoot(): string;
  extraProjectFolders(): string[];
  canAddProjectFolder(): boolean;
  getWorktreeCache(): any[];
  setWorktreeCache(w: any[]): void;
  getAuthEpoch(): number;
  bumpAuthEpoch(): number;
}

export interface ProjectFoldersMediaOps {
  getFullImagePaths(): Map<string, string>;
  getFullImageHandles(): Map<string, string>;
  getLocalVoiceCwd(): string | undefined;
  getLocalVoiceCredentialCwd(): string | undefined;
  stopVoiceInput(): void;
}

export interface ProjectFoldersDeps {
  host: ProjectFoldersHostOps;
  state: {
    get<T>(key: string, def?: T): T;
    update(key: string, val: any): Thenable<void>;
  };
  context: {
    globalState: MementoLike;
    globalStorageUri?: any;
  };
  sessionOps: ProjectFoldersSessionOps;
  uiOps: ProjectFoldersUiOps;
  catalogOps: ProjectFoldersCatalogOps;
  mediaOps: ProjectFoldersMediaOps;
  localWorkspaceSwitchQueue: AsyncSerialQueue;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class ProjectFolders {
  public githubConnection: GithubAuthState | undefined;

  constructor(private readonly deps: ProjectFoldersDeps) {}

  public async selectRepo(cwd: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.selectRepo>("selectRepo");
    if (override) return override(cwd);

    const hit = this.deps.catalogOps.resolveLocalRepoTarget(cwd);
    if (!hit) return;

    if (this.deps.host.canSwitchWorkspaceFolder) {
      await this.switchLocalWorkspaceFolder(hit.cwd);
      return;
    }

    this.deps.uiOps.setSelectedRepoCwd(hit.cwd);
    this.deps.uiOps.postRepoCatalog();
    this.deps.uiOps.postSessionsList();
  }

  public async switchLocalWorkspaceFolder(
    cwd: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.switchLocalWorkspaceFolder>("switchLocalWorkspaceFolder");
    if (override) return override(cwd, options);

    const target = cwd;
    return this.deps.localWorkspaceSwitchQueue.run(() =>
      this.switchLocalWorkspaceFolderExclusive(target, options),
    );
  }

  public async switchLocalWorkspaceFolderExclusive(
    target: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.switchLocalWorkspaceFolderExclusive>(
      "switchLocalWorkspaceFolderExclusive",
    );
    if (override) return override(target, options);

    const prevRoot = this.deps.catalogOps.workspaceRoot();
    const prevSelected = this.deps.uiOps.getSelectedRepoCwd();
    const listMayHaveChanged = () =>
      !pathsEqual(target, prevRoot) || !pathsEqual(prevSelected ?? "", this.deps.uiOps.getSelectedRepoCwd() ?? "");
    if (!pathsEqual(target, prevRoot)) {
      if (!this.deps.host.setActiveWorkspaceFolder(target)) {
        this.deps.host.appendLine(
          `[workspace] refused setActiveWorkspaceFolder (not an open folder): ${target}`,
        );
        if (options.warnOnRefusal !== false) {
          void this.deps.host.showWarningMessage(
            `That folder is not open in this app:\n${target}`,
          );
        }
        return;
      }
    }
    this.deps.uiOps.setSelectedRepoCwd(target);
    this.deps.uiOps.postRepoCatalog();

    const focused = this.deps.sessionOps.getFocused();
    if (pathsEqual(this.deps.sessionOps.sessionCwd(focused), target) && focused.client) {
      if (listMayHaveChanged()) this.deps.uiOps.postSessionsList();
      return;
    }

    this.deps.uiOps.postRepoCatalog();
    if (listMayHaveChanged()) this.deps.uiOps.postSessionsList();
  }

  public async addProjectFolder(cwd?: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.addProjectFolder>("addProjectFolder");
    if (override) return override(cwd);

    if (!this.deps.catalogOps.canAddProjectFolder()) return;
    const wasEmpty =
      this.deps.host.canSwitchWorkspaceFolder && !this.deps.host.openWorkspaceFolders().length;
    let folder = cwd;
    if (!folder) {
      const picked = await this.deps.host.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Add Project",
      });
      folder = picked?.[0];
    }
    if (!folder) return;
    const resolved = path.resolve(folder);
    if (!this.deps.host.canSwitchWorkspaceFolder) {
      await this.rememberExtraProjectFolder(resolved);
      return;
    }
    if (!this.deps.host.addWorkspaceFolder(folder)) {
      void this.deps.host.showWarningMessage(`Could not open folder:\n${folder}`);
      return;
    }
    this.deps.catalogOps.bumpAuthEpoch();
    await this.switchLocalWorkspaceFolder(resolved);
    if (wasEmpty) {
      const focused = this.deps.sessionOps.getFocused();
      this.deps.sessionOps.setSessionCwd(focused, resolved, resolved);
      if (!focused.hasHistory && !focused.client) {
        focused.provider = this.deps.sessionOps.defaultProviderForProject(resolved);
      }
      await this.deps.sessionOps.startSession(undefined, focused, "ensure");
    }
  }

  public projectHomeDir(): string {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }

  public projectRootPath(): string {
    const home = this.projectHomeDir();
    const remembered = this.deps.context.globalState.get<"legacy" | "current">(
      PROJECT_ROOT_CHOICE_KEY,
    );
    let legacyIsDirectory = false;
    if (!remembered) {
      try {
        const legacy = legacyProjectRootPath(home);
        legacyIsDirectory = fs.existsSync(legacy) && fs.statSync(legacy).isDirectory();
      } catch {
        /* unreadable home — fall through to current name */
      }
    }
    const useLegacyRoot = shouldUseLegacyRoot({ remembered, legacyIsDirectory });
    if (!remembered) {
      void Promise.resolve(
        this.deps.context.globalState.update(
          PROJECT_ROOT_CHOICE_KEY,
          rememberedRootFor(useLegacyRoot),
        ),
      ).catch(() => {});
    }
    return projectRoot(home, { useLegacyRoot });
  }

  public projectSetupMessage(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): Extract<HostMsg, { type: "projectSetup" }> {
    return {
      type: "projectSetup",
      root: displayPath(this.projectRootPath(), this.projectHomeDir()),
      ...extra,
    };
  }

  public githubStatePayload(): GithubState {
    const s = this.githubConnection;
    if (!s) {
      return {
        connected: false,
        cliPresent: true,
      };
    }
    return {
      connected: s.connected,
      ...(s.login ? { login: s.login } : {}),
      ...(s.envTokenInForce ? { envTokenInForce: true } : {}),
      ...(s.error ? { error: true } : {}),
      cliPresent: s.cliPresent,
      ...(s.message ? { message: s.message } : {}),
    };
  }

  public githubStateMessage(): Extract<HostMsg, { type: "githubState" }> {
    return { type: "githubState", github: this.githubStatePayload() };
  }

  public postGithubState(): void {
    const message = this.githubStateMessage();
    this.deps.uiOps.post(message);
    void this.deps.uiOps.getSettingsEditorWebview()?.postMessage(message);
  }

  public async refreshGithubState(): Promise<void> {
    this.githubConnection = await readGithubAuthState();
    this.postGithubState();
  }

  public postProjectSetup(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): void {
    this.deps.uiOps.post(this.projectSetupMessage(extra));
  }

  public async createProject(name: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.createProject>("createProject");
    if (override) return override(name);

    const nameError = projectNameError(name);
    if (nameError) {
      this.postProjectSetup({ error: nameError });
      return;
    }
    const root = this.projectRootPath();
    const dest = projectDestination(root, name);
    if (!dest) {
      this.postProjectSetup({ error: "That name can't be used for a folder." });
      return;
    }
    this.postProjectSetup({ busy: "new" });
    try {
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(dest)) {
        this.postProjectSetup({ error: `"${name.trim()}" is already in ${displayPath(root, this.projectHomeDir())}.` });
        return;
      }
      fs.mkdirSync(dest);
    } catch (e) {
      this.postProjectSetup({ error: `Could not create the folder: ${(e as Error).message}` });
      return;
    }
    await this.addProjectFolder(dest);
    this.postProjectSetup({ done: true });
  }

  public async cloneProject(url: string, name?: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.cloneProject>("cloneProject");
    if (override) return override(url, name);

    const urlError = cloneUrlError(url);
    if (urlError) {
      this.postProjectSetup({ error: urlError });
      return;
    }
    const root = this.projectRootPath();
    const folderError = name !== undefined ? projectNameError(name) : null;
    if (folderError) {
      this.postProjectSetup({ error: folderError, collision: name?.trim() });
      return;
    }
    const dest = name !== undefined
      ? projectDestination(root, name)
      : cloneDestination(root, url);
    if (!dest) {
      this.postProjectSetup({ error: "That URL doesn't name a repository." });
      return;
    }
    this.postProjectSetup({ busy: "clone" });
    try {
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(dest)) {
        this.postProjectSetup({
          error: `${path.basename(dest)} is already in ${displayPath(root, this.projectHomeDir())}. Pick a different folder name.`,
          collision: path.basename(dest),
        });
        return;
      }
    } catch (e) {
      this.postProjectSetup({ error: `Could not create the folder: ${(e as Error).message}` });
      return;
    }
    const trimmed = normalizeCloneUrl(url) ?? url.trim();
    const failure = await runGitClone(trimmed, dest);
    if (failure) {
      try {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* leave it */
      }
      const kind = classifyCloneFailure(failure);
      let error = cloneFailureText(kind, failure);
      let fix: { fix?: "auth-gh" | "install-gh"; fixCommand?: string } = {};
      if (offersGithubSetup(trimmed, kind)) {
        const offer = githubFixFor(process.platform, commandOnPath);
        if (offer.kind === "auth") fix = { fix: "auth-gh" };
        else if (offer.kind === "install") fix = { fix: "install-gh", fixCommand: offer.command };
        else {
          error += ` Install the GitHub CLI from ${offer.where} first.`;
        }
      }
      this.postProjectSetup({ error, ...fix });
      return;
    }
    await this.addProjectFolder(dest);
    this.postProjectSetup({ done: true });
  }

  public async setupGithubCli(action: "install" | "auth"): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.setupGithubCli>("setupGithubCli");
    if (override) return override(action);

    if (action === "auth") {
      const term = this.deps.host.createTerminal({ name: "GitHub sign-in" });
      term.show();
      term.sendText(githubSignInCommand(process.platform));
      return;
    }
    const install = githubCliInstallCommand(process.platform);
    if (!install) {
      this.postProjectSetup({
        error: `Install the GitHub CLI from ${GITHUB_CLI_DOWNLOAD}, then try again.`,
      });
      return;
    }
    const term = this.deps.host.createTerminal({ name: "Install GitHub CLI" });
    term.show();
    term.sendText(install.display);
  }

  public async listGithubRepos(): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.listGithubRepos>("listGithubRepos");
    if (override) return override();

    if (!this.githubConnection) this.githubConnection = await readGithubAuthState();
    if (!this.githubConnection.connected || this.githubConnection.error) {
      this.deps.uiOps.post({ type: "githubRepos", repos: [] });
      return;
    }
    const result = await listGithubRepositories();
    this.deps.uiOps.post({
      type: "githubRepos",
      repos: result.repos,
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  public async githubSignOut(): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.githubSignOut>("githubSignOut");
    if (override) return override();

    const current = this.githubConnection;
    const login = current?.login;
    if (current?.envTokenInForce) {
      const name = githubEnvTokenName() ?? "GH_TOKEN";
      this.githubConnection = {
        ...current,
        error: true,
        message: githubEnvTokenBlocksSignOutMessage(name),
      };
      this.postGithubState();
      return;
    }
    const result = await logoutGithub(login);
    if (!result.ok) {
      this.githubConnection = {
        ...(current ?? { ...DISCONNECTED_GITHUB, login: login || "" }),
        error: true,
        message: result.error,
      };
      this.postGithubState();
      return;
    }
    await this.refreshGithubState();
  }

  public async githubLoginWithToken(token: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.githubLoginWithToken>("githubLoginWithToken");
    if (override) return override(token);

    const result = await loginGithubWithToken(token);
    if (!result.ok) {
      this.deps.host.appendLine("[github] token login failed");
      const current = this.githubConnection ?? { ...DISCONNECTED_GITHUB };
      this.githubConnection = { ...current, error: true, message: result.error };
      this.postGithubState();
      return;
    }
    this.deps.host.appendLine("[github] token login completed");
    await this.refreshGithubState();
  }

  public async rememberExtraProjectFolder(resolved: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.rememberExtraProjectFolder>("rememberExtraProjectFolder");
    if (override) return override(resolved);

    let ok = false;
    try {
      ok = fs.statSync(resolved).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      void this.deps.host.showWarningMessage(`Not a folder:\n${resolved}`);
      return;
    }
    const key = normalizeRepoPath(resolved);
    const alreadyListed =
      !!this.deps.catalogOps.resolveLocalRepoTarget(resolved) ||
      pathsEqual(resolved, this.deps.catalogOps.workspaceRoot() || "");
    if (alreadyListed) {
      await this.selectRepo(resolved);
      return;
    }
    const tombstones = this.deps.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    if (Array.isArray(tombstones) && tombstones.some((c) => normalizeRepoPath(c) === key)) {
      await this.deps.state.update(
        REMOVED_PROJECT_FOLDERS_KEY,
        tombstones.filter((c) => normalizeRepoPath(c) !== key),
      );
    }
    const stored = this.deps.catalogOps.extraProjectFolders();
    if (!stored.some((c) => normalizeRepoPath(c) === key)) {
      await this.deps.state.update(EXTRA_PROJECT_FOLDERS_KEY, [...stored, resolved]);
    }
    await this.selectRepo(resolved);
  }

  public async forgetExtraProjectFolder(cwd?: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.forgetExtraProjectFolder>("forgetExtraProjectFolder");
    if (override) return override(cwd);

    if (!cwd) return;
    const working = this.sessionsBoundToFolder(cwd).filter(sessionHasWorkInFlight);
    if (working.length) {
      const many = working.length > 1;
      const ok = await this.deps.host.showWarningMessage(
        `Hide "${path.basename(cwd)}"?\n\n` +
          `${many ? `${working.length} conversations are` : "A conversation is"} still working. ` +
          `Hiding it ends ${many ? "them" : "it"} and discards the turn in progress.`,
        { modal: true },
        "Hide anyway",
      );
      if (ok !== "Hide anyway") return;
    }
    if (pathsEqual(cwd, this.deps.catalogOps.workspaceRoot() || "")) {
      void this.deps.host.showWarningMessage(
        "This is the folder VS Code has open, so it cannot be removed from the list. " +
          "Close the folder in VS Code instead.",
      );
      return;
    }
    const key = normalizeRepoPath(cwd);
    const stored = this.deps.catalogOps.extraProjectFolders();
    const next = stored.filter((c) => normalizeRepoPath(c) !== key);
    if (next.length === stored.length) return;
    await this.deps.state.update(EXTRA_PROJECT_FOLDERS_KEY, next);

    const pins = this.deps.state.get<RepoPins>(REPO_PINS_KEY, {});
    if (pins[key]) {
      const nextPins = { ...pins };
      delete nextPins[key];
      await this.deps.state.update(REPO_PINS_KEY, nextPins);
    }
    const tombstones = this.deps.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    const list = Array.isArray(tombstones) ? tombstones : [];
    if (!list.some((c) => normalizeRepoPath(c) === key)) {
      await this.deps.state.update(REMOVED_PROJECT_FOLDERS_KEY, [...list, cwd]);
    }
    this.revokeClosedProjectFolder(cwd);
    const pool = this.deps.sessionOps.getPool();
    const focused = this.deps.sessionOps.getFocused();
    if (!pool.has(focused) && !focused.client) {
      const nextFocused = this.deps.sessionOps.newLocalSession();
      this.deps.sessionOps.setFocused(nextFocused);
      this.deps.uiOps.emit(nextFocused, { type: "clearMessages" });
    }
    this.deps.uiOps.postRepoCatalog();
    this.deps.uiOps.postSessionsList();
  }

  public async removeProjectFolder(cwd?: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.removeProjectFolder>("removeProjectFolder");
    if (override) return override(cwd);

    if (!this.deps.host.canSwitchWorkspaceFolder) {
      await this.forgetExtraProjectFolder(cwd);
      return;
    }
    const target = cwd || this.deps.host.workspaceRoot();
    if (!target) return;

    const working = this.sessionsBoundToFolder(target).filter(sessionHasWorkInFlight);
    if (working.length) {
      const many = working.length > 1;
      const ok = await this.deps.host.showWarningMessage(
        `Close "${path.basename(target)}"?\n\n` +
          `${many ? `${working.length} conversations are` : "A conversation is"} still working. ` +
          `Closing ends ${many ? "them" : "it"} and discards the turn in progress.`,
        { modal: true },
        "Close anyway",
      );
      if (ok !== "Close anyway") return;
    }

    const activeRoot = this.deps.host.workspaceRoot();
    const wasActive = !!activeRoot && pathsEqual(target, activeRoot);
    if (!this.deps.host.removeWorkspaceFolder(target)) {
      void this.deps.host.showWarningMessage(`Could not close folder:\n${target}`);
      return;
    }
    this.revokeClosedProjectFolder(target);

    const next = this.deps.host.workspaceRoot();
    if (wasActive && next) {
      await this.switchLocalWorkspaceFolder(next);
    } else if (!next) {
      const focused = this.deps.sessionOps.getFocused();
      const pool = this.deps.sessionOps.getPool();
      if (pool.has(focused) || focused.client) {
        this.deps.sessionOps.parkFocused();
      }
      const nextFocused = this.deps.sessionOps.newLocalSession();
      this.deps.sessionOps.setFocused(nextFocused);
      this.deps.uiOps.setSelectedRepoCwd("");
      this.deps.uiOps.emit(nextFocused, { type: "clearMessages" });
      this.presentEmptyProjectState(nextFocused);
    } else {
      const focused = this.deps.sessionOps.getFocused();
      const pool = this.deps.sessionOps.getPool();
      if (!pool.has(focused) && !focused.client) {
        this.deps.sessionOps.setFocused(this.deps.sessionOps.newLocalSession());
      }
      this.deps.uiOps.postRepoCatalog();
      this.deps.uiOps.postSessionsList();
    }
  }

  public presentEmptyProjectState(session: Session): void {
    session.priming = false;
    this.deps.uiOps.emit(session, { type: "setBusy", value: false });
    this.deps.uiOps.emit(session, {
      type: "onboarding",
      state: "no-project",
      platform: process.platform,
    });
    this.deps.uiOps.postRepoCatalog();
    this.deps.uiOps.postSessionsList();
  }

  public sessionsBoundToFolder(closedCwd: string): Session[] {
    const bound: Session[] = [];
    const seen = new Set<Session>();
    const consider = (s: Session | undefined) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      if (
        sessionBoundToClosedFolder(
          this.deps.sessionOps.sessionCwd(s),
          s.worktree?.path,
          s.worktree?.sourceGitRoot,
          closedCwd,
          pathsEqual,
        )
      ) {
        bound.push(s);
      }
    };
    for (const s of this.deps.sessionOps.getPool()) consider(s);
    consider(this.deps.sessionOps.getFocused());
    return bound;
  }

  public revokeClosedProjectFolder(closedCwd: string): void {
    const epoch = this.deps.catalogOps.bumpAuthEpoch();
    this.revokeVoiceForClosedFolder(closedCwd);

    const doomed = this.sessionsBoundToFolder(closedCwd);
    for (const s of doomed) void this.deps.sessionOps.disposeSession(s);

    this.invalidateImageHandlesUnder(closedCwd);

    const worktreeCache = this.deps.catalogOps.getWorktreeCache().filter(
      (w: any) =>
        !pathsEqual(w.sourceRepo, closedCwd) &&
        !pathBoundToClosedFolder(w.path, closedCwd, pathsEqual),
    );
    this.deps.catalogOps.setWorktreeCache(worktreeCache);

    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    let metaChanged = false;
    const nextMeta: SessionMetaOverrides = { ...overrides };
    for (const [id, o] of Object.entries(overrides)) {
      if (
        (o.worktreePath && pathBoundToClosedFolder(o.worktreePath, closedCwd, pathsEqual)) ||
        (o.sourceGitRoot && pathsEqual(o.sourceGitRoot, closedCwd))
      ) {
        const { worktreePath: _wp, worktreeLabel: _wl, sourceGitRoot: _sg, ...rest } = o;
        nextMeta[id] = rest;
        metaChanged = true;
      }
    }
    if (metaChanged) void this.deps.state.update(SESSION_META_KEY, nextMeta);

    this.deps.host.appendLine(`[auth] revoked project folder ${closedCwd} (epoch=${epoch})`);
  }

  public invalidateImageHandlesUnder(closedCwd: string): void {
    const paths = this.deps.mediaOps.getFullImagePaths();
    const handles = imageHandlesToRevoke(paths, closedCwd, pathsEqual);
    const handlesMap = this.deps.mediaOps.getFullImageHandles();
    for (const handle of handles) {
      const p = paths.get(handle);
      paths.delete(handle);
      if (p && handlesMap.get(p) === handle) handlesMap.delete(p);
    }
  }

  public revokeVoiceForClosedFolder(closedCwd: string): void {
    const voiceCwd = this.deps.mediaOps.getLocalVoiceCwd();
    const credCwd = this.deps.mediaOps.getLocalVoiceCredentialCwd();
    if (
      (voiceCwd && pathBoundToClosedFolder(voiceCwd, closedCwd, pathsEqual)) ||
      (credCwd && pathBoundToClosedFolder(credCwd, closedCwd, pathsEqual))
    ) {
      this.deps.mediaOps.stopVoiceInput();
    }
  }
}

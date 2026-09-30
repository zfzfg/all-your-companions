import { resolveGrokHome } from "./sessions";
import { HostMsg, WebviewMsg } from "./protocol";
import { Session } from "./session";
import { resolveCodexHome } from "./codex-cli-locator";
import { Uri, disposeAll } from "./host";
import type {
  Host,
  HostContext,
  HostDisposable,
  HostWebview,
  HostWebviewView,
  HostEditorWebview
} from "./host";
import { type SessionsListOptions } from "./session-catalog";
export interface SidebarViewHostSidebarOpsState {
  readonly host: Host;
  readonly focused: Session;
  codexCliPath: string | undefined;
  claudeCliPath: string | undefined;
  museCliPath: string | undefined;
  geminiCliPath: string | undefined;
  mentionIndex: { at: number; rels: string[]; absByRel: Map<string, string>; } | null;
  readonly otherCwdMentionIndexes: Map<string, { at: number; rels: string[]; absByRel: Map<string, string>; }>;
  readonly pool: Set<Session>;
  readonly context: HostContext;
}
export interface SidebarViewHostSidebarOpsActions {
  forgetPostedVoiceConfigured: (destKey: string) => void;
  getHtml: (webview: HostWebview) => string;
  onMessage: (msg: WebviewMsg) => Promise<void>;
  restorePersistedDraft: (session: Session) => void;
  watchActiveEditor: () => void;
  reapPool: () => void;
  postVoiceConfigured: () => void;
  postFontScale: () => void;
  postShowThinking: () => void;
  postProviderState: () => void;
  post: (message: HostMsg) => void;
  refreshImplicitChip: (forcePost?: boolean) => void;
  applyTerminalShellPref: () => void;
  offerGrokRestartForCompactThreshold: () => Promise<void>;
  postThumbsFeedback: () => void;
  refreshFeedbackAvailability: (session: Session) => void;
  emit: (session: Session, message: HostMsg) => void;
  getProjectsRailHtml: (webview: HostWebview) => string;
  imageStagingDir: () => string;
  mirrorToProjectsRail: (message: HostMsg) => void;
  providerStateMessage: () => Extract<HostMsg, { type: "providerState"; }>;
  postRepoCatalog: () => void;
  postSessionsList: (opts?: SessionsListOptions) => void;
  getSettingsHtml: (webview: HostWebview, opts?: { category?: string; }) => string;
}
export interface SidebarViewHostSidebarOps {
  readonly state: SidebarViewHostSidebarOpsState;
  readonly actions: SidebarViewHostSidebarOpsActions;
}

export interface SidebarViewHostDeps {
  readonly sidebarOps: SidebarViewHostSidebarOps;
  readonly getOverride?: <T extends (...args: any[]) => any>(name: string) => T | undefined;
}
export class SidebarViewHost {
  constructor(private readonly deps: SidebarViewHostDeps) { }
  public view?: HostWebviewView;
  /** Second local consumer of catalog-shaped host messages. Absent until resolved. */
  public projectsRail?: HostWebviewView;
  /** VS Code settings tab. Desktop/remote keep the in-page overlay. */
  public settingsEditor?: HostEditorWebview;
  public configWatcher?: HostDisposable;
  public reaper?: ReturnType<typeof setInterval>;
  resolveWebviewView(view: HostWebviewView): void {
    const testOverride = this.deps.getOverride?.<typeof this.resolveWebviewView>("resolveWebviewView");
    if (testOverride) return testOverride(view);

    this.view = view;
    // Assigning html boots a new renderer. The `local` cache entry belonged
    // to the previous JS state and must not suppress the next identical frame.
    this.deps.sidebarOps.actions.forgetPostedVoiceConfigured("local");
    view.webview.options = {
      enableScripts: true,
      // Extension assets keep extensionUri identity (vscode-remote on remote hosts).
      // Staging + grok home are genuinely local disk paths → Uri.file.
      localResourceRoots: this.chatLocalResourceRoots()
    };
    view.webview.html = this.deps.sidebarOps.actions.getHtml(view.webview);
    // Message handlers run async; without this catch a throw (e.g. an fs error
    // in an image-attach path) becomes a silent unhandled rejection and the
    // user's action just... does nothing.
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.deps.sidebarOps.actions.onMessage(m).catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.deps.sidebarOps.state.host.appendLine(`[webview] ${m.type} failed: ${msg}`);
        void this.deps.sidebarOps.state.host.showErrorMessage(`Grok: ${m.type} failed — ${msg}`);
      });
    });
    this.deps.sidebarOps.actions.restorePersistedDraft(this.deps.sidebarOps.state.focused);
    this.deps.sidebarOps.actions.watchActiveEditor();
    // Periodic idle-TTL sweep over the live-session pool (the LRU cap is enforced
    // eagerly on each new start; this catches sessions that simply went stale).
    if (!this.reaper) {
      this.reaper = setInterval(() => {
        this.deps.sidebarOps.actions.reapPool();
      }, SidebarViewHost.REAP_INTERVAL_MS);
    }
    // Re-tell the webview whether voice is set up when the relevant settings
    // change, so the mic button's "needs setup" hint updates without a reload.
    this.configWatcher?.dispose();
    const configChanges = this.deps.sidebarOps.state.host.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("grok.voiceApiKey") ||
        e.affectsConfiguration("grok.voiceOpenAiApiKey") ||
        e.affectsConfiguration("grok.voiceBackend") ||
        e.affectsConfiguration("grok.ffmpegPath") ||
        e.affectsConfiguration("grok.voiceSendPhrase") ||
        e.affectsConfiguration("grok.voiceKeyterms")
      ) {
        this.deps.sidebarOps.actions.postVoiceConfigured();
      }
      if (e.affectsConfiguration("grok.chatFontScale")) {
        this.deps.sidebarOps.actions.postFontScale();
      }
      if (e.affectsConfiguration("grok.showThinking")) {
        this.deps.sidebarOps.actions.postShowThinking();
      }
      if (e.affectsConfiguration("grok.codexCliPath")) {
        this.deps.sidebarOps.state.codexCliPath = undefined;
        this.deps.sidebarOps.actions.postProviderState();
      }
      if (e.affectsConfiguration("grok.claudeCliPath")) {
        this.deps.sidebarOps.state.claudeCliPath = undefined;
        this.deps.sidebarOps.actions.postProviderState();
      }
      if (e.affectsConfiguration("grok.museCliPath")) {
        this.deps.sidebarOps.state.museCliPath = undefined;
        this.deps.sidebarOps.actions.postProviderState();
      }
      if (e.affectsConfiguration("grok.geminiCliPath") || e.affectsConfiguration("companions.antigravityCliPath") || e.affectsConfiguration("companions.geminiCliPath")) {
        this.deps.sidebarOps.state.geminiCliPath = undefined;
        this.deps.sidebarOps.actions.postProviderState();
      }
      if (e.affectsConfiguration("grok.expandCommandOutputs")) {
        this.deps.sidebarOps.actions.post({
          type: "expandCommandOutputs",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("expandCommandOutputs", false)
        });
      }
      if (e.affectsConfiguration("grok.steerByDefault")) {
        this.deps.sidebarOps.actions.post({
          type: "steerByDefault",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("steerByDefault", false)
        });
      }
      if (e.affectsConfiguration("grok.promptNav")) {
        const value = this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("promptNav", true) !== false;
        this.deps.sidebarOps.actions.post({ type: "promptNav", value });
        void this.settingsEditor?.webview.postMessage({ type: "promptNav", value });
      }
      if (e.affectsConfiguration("grok.soundNotifications")) {
        this.deps.sidebarOps.actions.post({
          type: "soundNotifications",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("soundNotifications", false)
        });
      }
      if (e.affectsConfiguration("grok.processingSound")) {
        this.deps.sidebarOps.actions.post({
          type: "processingSound",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("processingSound", false)
        });
      }
      if (e.affectsConfiguration("grok.readRepliesAloud")) {
        this.deps.sidebarOps.actions.post({
          type: "readRepliesAloud",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("readRepliesAloud", false)
        });
      }
      if (e.affectsConfiguration("grok.summarizeRepliesAloud")) {
        this.deps.sidebarOps.actions.post({
          type: "summarizeRepliesAloud",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true)
        });
      }
      if (e.affectsConfiguration("grok.includeActiveFileByDefault")) {
        // Apply the toggle immediately: disabling removes a visible context
        // chip right away (not on the next editor event), enabling shows it.
        this.deps.sidebarOps.actions.refreshImplicitChip(true);
      }
      if (e.affectsConfiguration("grok.mentionIndexLimit")) {
        // Drop the TTL-cached findFiles snapshot so the next `@` rebuilds with
        // the new cap (otherwise a raise would wait up to MENTION_INDEX_TTL_MS).
        this.deps.sidebarOps.state.mentionIndex = null;
        this.deps.sidebarOps.state.otherCwdMentionIndexes.clear();
      }
      if (e.affectsConfiguration("grok.terminalShell")) {
        this.deps.sidebarOps.actions.applyTerminalShellPref();
      }
      if (e.affectsConfiguration("grok.telemetry.enabled")) {
        this.deps.sidebarOps.actions.post({
          type: "telemetryEnabled",
          value: this.deps.sidebarOps.state.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true)
        });
      }
      if (e.affectsConfiguration("companions.grok.autoCompactThresholdPercent")) {
        void this.deps.sidebarOps.actions.offerGrokRestartForCompactThreshold();
      }
      if (e.affectsConfiguration("grok.thumbsFeedback")) {
        this.deps.sidebarOps.actions.postThumbsFeedback();
        for (const session of [this.deps.sidebarOps.state.focused, ...this.deps.sidebarOps.state.pool]) {
          this.deps.sidebarOps.actions.refreshFeedbackAvailability(session);
        }
      }
    });
    const authWatcher = this.deps.sidebarOps.state.host.createFileSystemWatcher(
      resolveGrokHome(process.env),
      "auth.json",
    );
    const refreshVoiceConfigured = () => {
      this.deps.sidebarOps.actions.postVoiceConfigured();
      // A running CLI may still hold the previous login, so nothing is asked
      // here: publish cleared usage now; a new process binds the new account.
      for (const session of new Set([this.deps.sidebarOps.state.focused, ...this.deps.sidebarOps.state.pool])) {
        if (session.subscriptionUsage && !session.subscriptionUsage.current()) {
          this.deps.sidebarOps.actions.emit(session, { type: "subscriptionUsage", windows: [] });
        }
      }
    };
    authWatcher.onDidCreate(refreshVoiceConfigured);
    authWatcher.onDidChange(refreshVoiceConfigured);
    authWatcher.onDidDelete(refreshVoiceConfigured);
    this.configWatcher = disposeAll(configChanges, authWatcher);
    this.deps.sidebarOps.actions.applyTerminalShellPref();
  }

  /**
     * Primary side bar projects rail. Same catalog stream as the chat webview
     * (`repos` / `sessions` / `repoSessions` / `pinnedSessions` / `sessionDot`),
     * never chat traffic — a second `chat.js` client would double-own sessions.
     */
  resolveProjectsRailView(view: HostWebviewView): void {
    const testOverride = this.deps.getOverride?.<typeof this.resolveProjectsRailView>("resolveProjectsRailView");
    if (testOverride) return testOverride(view);

    this.projectsRail = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "media"),
        Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "resources"),
      ]
    };
    view.webview.html = this.deps.sidebarOps.actions.getProjectsRailHtml(view.webview);
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.onProjectsRailMessage(m).catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.deps.sidebarOps.state.host.appendLine(`[projects-rail] ${m.type} failed: ${msg}`);
        void this.deps.sidebarOps.state.host.showErrorMessage(`Grok Projects: ${m.type} failed — ${msg}`);
      });
    });
  }

  /** Drop the rail handle when the view is disposed (or re-created). */
  disposeProjectsRailView(): void {
    const testOverride = this.deps.getOverride?.<typeof this.disposeProjectsRailView>("disposeProjectsRailView");
    if (testOverride) return testOverride();

    this.projectsRail = undefined;
  }

  public chatLocalResourceRoots(): Uri[] {
    const testOverride = this.deps.getOverride?.<typeof this.chatLocalResourceRoots>("chatLocalResourceRoots");
    if (testOverride) return testOverride();

    return [
      Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "media"),
      Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "resources"),
      Uri.file(this.deps.sidebarOps.actions.imageStagingDir()),
      // grok writes generated media under ~/.grok/sessions/<cwd>/<id>/{images,videos};
      // serving it via asWebviewUri (instead of a base64 data: URI) lets the
      // webview stream a multi-MB video from disk — see postGeneratedMedia.
      Uri.file(resolveGrokHome()),
      Uri.file(resolveCodexHome()),
    ];
  }

  /**
     * Rail actions only. `ready` pushes catalog — never postInitialState / startSession
     * (those belong to the chat view). Everything else reuses onMessage so there is
     * one host path for resume/pin/rename/delete.
     */
  public async onProjectsRailMessage(msg: WebviewMsg): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.onProjectsRailMessage>("onProjectsRailMessage");
    if (testOverride) return testOverride(msg);

    if (msg.type === "ready") {
      this.pushProjectsRailCatalog();
      return;
    }
    if (!SidebarViewHost.PROJECTS_RAIL_WEBVIEW_TYPES.has(msg.type)) {
      this.deps.sidebarOps.state.host.appendLine(`[projects-rail] ignored ${msg.type}`);
      return;
    }
    await this.deps.sidebarOps.actions.onMessage(msg);
    // Opening a conversation from the rail is someone saying which conversation
    // they want to be in, so put them in it. The rail lives in its own activity
    // bar container, so without this the chat can stay behind another view and
    // the click looks like it did nothing.
    //
    // Only these two, and only from the RAIL: renaming, pinning or deleting a
    // row is housekeeping done while looking at the list, and yanking the view
    // out from under that would be the opposite of helpful. This handler is
    // rail-only, so the chat asking for its own session never lands here.
    if (msg.type === "resumeSession" || msg.type === "newSession") {
      await this.deps.sidebarOps.state.host.revealChatView();
    }
  }

  /** Catalog snapshot for a freshly-resolved rail (or its ready handshake). */
  public pushProjectsRailCatalog(): void {
    const testOverride = this.deps.getOverride?.<typeof this.pushProjectsRailCatalog>("pushProjectsRailCatalog");
    if (testOverride) return testOverride();

    if (!this.projectsRail) return;
    this.deps.sidebarOps.actions.mirrorToProjectsRail(this.deps.sidebarOps.actions.providerStateMessage());
    this.deps.sidebarOps.actions.postRepoCatalog();
    this.deps.sidebarOps.actions.postSessionsList();
  }

  /**
     */
  async openSettingsEditor(category?: string): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.openSettingsEditor>("openSettingsEditor");
    if (testOverride) return testOverride(category);

    const targetCategory = category === "rules" ? "advanced" : category;
    if (this.settingsEditor) {
      this.settingsEditor.reveal();
      if (targetCategory) {
        void this.settingsEditor.webview.postMessage({ type: "settingsCategory", category: targetCategory });
      }
      return;
    }
    const panel = this.deps.sidebarOps.state.host.openEditorWebview({
      viewType: "grok.settings",
      title: "All your Companions Settings",
      localResourceRoots: [
        Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "media"),
        Uri.joinPath(this.deps.sidebarOps.state.context.extensionUri, "resources"),
      ]
    });
    if (!panel) return;
    this.settingsEditor = panel;
    panel.onDidDispose(() => {
      if (this.settingsEditor === panel) this.settingsEditor = undefined;
    });
    panel.webview.html = this.deps.sidebarOps.actions.getSettingsHtml(panel.webview, {
      category: targetCategory
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const msg = raw as WebviewMsg;
      void this.onSettingsPanelMessage(msg).catch((e) => {
        const text = (e as Error)?.message ?? String(e);
        this.deps.sidebarOps.state.host.appendLine(`[settings] ${msg.type} failed: ${text}`);
      });
    });
  }

  public async onSettingsPanelMessage(msg: WebviewMsg): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.onSettingsPanelMessage>("onSettingsPanelMessage");
    if (testOverride) return testOverride(msg);

    if (!SidebarViewHost.SETTINGS_PANEL_TYPES.has(msg.type)) {
      this.deps.sidebarOps.state.host.appendLine(`[settings] ignored ${msg.type}`);
      return;
    }
    await this.deps.sidebarOps.actions.onMessage(msg);
  }

  // 1h
  private static readonly REAP_INTERVAL_MS = 5 * 60 * 1000;

  private static readonly SETTINGS_PANEL_TYPES = new Set<WebviewMsg["type"]>([
    "openSettingsSurface",
    "closeSettingsSurface",
    // The standalone VS Code Settings tab is a first-class surface for this
    // page — it loads settings.js and nothing else. Without these five it
    // posts `listRoutines`, gets "[settings] ignored", and shows an empty
    // Routines page with no projects, no models and no way to create one.
    "listRoutines",
    "saveRoutine",
    "deleteRoutine",
    "setRoutinePaused",
    "runRoutineNow",
    // Agents & Crew is a settings-tab page in exactly the same way, and
    // without these five it posts `listAgentRoles`, gets "[settings] ignored",
    // and shows an empty page with no way to create anything.
    "listAgentRoles",
    "saveAgentRole",
    "deleteAgentRole",
    "saveCrewFlow",
    "deleteCrewFlow",
    "saveWorkflow",
    "validateWorkflow",
    "generateWorkflow",
    "cancelWorkflowGenerate",
    "setDefaultWorkflow",
    "addWorkflowStagesBlock",
    "runWorkflow",
    // The rest of Agents & Crew and Advanced: roster, routing, the two
    // toggles, rule files, permission rules, and workflow Export.
    "subagentRosterSave",
    "subagentRoutingSave",
    "setSubagentsEnabled",
    "setCrewStageSubagents",
    "setCompanionsSetting",
    "listRuleFiles",
    "openRuleFile",
    "listPermissionRules",
    "deletePermissionRule",
    "adoptPermissionRules",
    "openText",
    "setShowThinking",
    "setAppPurpose",
    "setExpandCommandOutputs",
    "setSteerByDefault",
    "setSoundNotifications",
    "setProcessingSound",
    "setReadRepliesAloud",
    "setSummarizeRepliesAloud",
    "setVoiceSendPhrase",
    "setVoiceKeyterms",
    "setVoiceBackend",
    "configureOpenAiVoice",
    "setTelemetryEnabled",
    "setThumbsFeedback",
    "openGlobalConfig",
    "openProjectConfig",
    "listMcpServers",
    "connectMcpConnector",
    "disconnectMcpConnector",
    "showLogs",
    "toggleDevTools",
    "openSettings",
    "openUrl",
    "moveView",
    "logout",
    "setupGithubCli",
    "githubSignOut",
    "githubLoginWithToken",
    "runGrokLogin",
    "refreshProviders",
    // An agent row's "Re-check connection" after a terminal sign-in started
    // FROM this page.
    "recheckConnection",
    "checkGrokUpdate",
    "updateGrok",
  ]);

  /** Webview→host actions the rail may post. Closed set — never send/cancel/etc. */
  private static readonly PROJECTS_RAIL_WEBVIEW_TYPES = new Set<WebviewMsg["type"]>([
    "createProject",
    "cloneProject",
    "setupGithubCli",
    "listGithubRepos",
    // The rail renders the same clone form as the chat, so it can reach the
    // token paste too.
    "githubLoginWithToken",
    "listSessions",
    "listRepoSessions",
    "selectRepo",
    "resumeSession",
    "newSession",
    "toggleSessionPin",
    "renameSession",
    "deleteSession",
    "clearAllSessions",
    "setRepoArchived",
    "setRepoColor",
    // Host-local by construction: it opens a native folder dialog. Reachable
    // from the rail because that is where the project list lives; a remote
    // cannot send it (remote-policy classifies it `host-local`).
    "addProjectFolder",
    // The way back out. Same host-local classification — on VS Code it forgets
    // a hand-added folder, which is the only revocation that surface has.
    "removeProjectFolder",
  ]);

  dispose(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    this.configWatcher?.dispose();
    this.configWatcher = undefined;
    try { this.settingsEditor?.dispose(); } catch { /* tab already gone */ }
    this.settingsEditor = undefined;
  }
}

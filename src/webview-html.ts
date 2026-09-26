/** HTML documents for the chat webview, the settings tab, and the projects rail. */
import type { Host, HostContext, HostWebview } from "./host";
import { Uri } from "./host";
import type { AcpProvider } from "./acp-backend";
import { Session } from "./session";
import { sanitizeVoiceKeyterms, DEFAULT_SEND_PHRASE, VoiceBackendState } from "./voice";
import { HostMsg } from "./protocol";
import type { GithubState } from "./protocol";
import { DEFAULT_APP_PURPOSE } from "./app-purpose";
import type { AppPurpose } from "./app-purpose";
import { MCP_GLOBAL_SCOPE_WARNING } from "./mcp";
import type { McpServerView } from "./mcp";

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export interface WebviewHtmlDeps {
  readonly context: HostContext;
  readonly host: Host;
  appPurpose(): AppPurpose;
  chatFontScale(): number;
  voiceBackendState(cwd: string, provider: AcpProvider): VoiceBackendState;
  sessionCwd(session: Session): string;
  readonly focused: Session;
  voiceSetting<T>(cwd: string, key: string, fallback: T): T;
  providerStateMessage(): Extract<HostMsg, { type: "providerState" }>;
  readonly providerRefreshInFlight: boolean;
  githubStatePayload(): GithubState;
  readonly providerCliVersions: Partial<Record<AcpProvider, string>>;
  readonly mcpServersView: McpServerView[];
  mcpConnectorsMessage(): Extract<HostMsg, { type: "mcpConnectors" }>;
  showThinking(): boolean;
}

export class WebviewHtml {
  constructor(private readonly deps: WebviewHtmlDeps) {}

  private get context() { return this.deps.context; }

  private get host() { return this.deps.host; }

  private get appPurpose() { return this.deps.appPurpose; }

  private get chatFontScale() { return this.deps.chatFontScale; }

  private get voiceBackendState() { return this.deps.voiceBackendState; }

  private get sessionCwd() { return this.deps.sessionCwd; }

  private get focused() { return this.deps.focused; }

  private get voiceSetting() { return this.deps.voiceSetting; }

  private get providerStateMessage() { return this.deps.providerStateMessage; }

  private get providerRefreshInFlight() { return this.deps.providerRefreshInFlight; }

  private get githubStatePayload() { return this.deps.githubStatePayload; }

  private get providerCliVersions() { return this.deps.providerCliVersions; }

  private get mcpServersView() { return this.deps.mcpServersView; }

  private get mcpConnectorsMessage() { return this.deps.mcpConnectorsMessage; }

  private get showThinking() { return this.deps.showThinking; }


  /**
   * HTML for the primary-side-bar projects rail. Self-contained: does not load
   * chat.js (that would create a second chat client).
   */
  getProjectsRailHtml(webview: HostWebview): string {
    const nonce = getNonce();
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<style>
  /* The same cold-start gap the chat webview guards against — see getHtml.
     Cheaper here because the rail is nearly empty before its script runs: a
     search box and a scroll region, which unstyled is a full-width native
     input on a white page. projects-rail.css re-reveals. */
  html, body { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  body { visibility: hidden; }
</style>
<link rel="stylesheet" href="${mediaUri("projects-rail.css")}" />
</head>
<body>
  <aside id="projects-rail" class="projects-rail" aria-label="Projects">
    <div class="rail-search-wrap">
      <span class="rail-search-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </span>
      <input id="rail-search" class="rail-search" type="search" placeholder="Filter projects…" autocomplete="off" spellcheck="false" aria-label="Filter projects" />
    </div>
    <div id="rail-scroll" class="rail-scroll"></div>
  </aside>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("projects-rail.js")}"></script>
</body>
</html>`;
  }

  getSettingsHtml(
    webview: HostWebview,
    opts: { category?: string },
  ): string {
    const nonce = getNonce();
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    const cfg = this.host.getConfiguration("grok");
    const boot = {
      snapshot: {
        appPurpose: this.appPurpose() || DEFAULT_APP_PURPOSE,
        showThinking: cfg.get("showThinking", false),
        expandCommandOutputs: cfg.get("expandCommandOutputs", false),
        steerByDefault: cfg.get("steerByDefault", false),
        promptNav: cfg.get<boolean>("promptNav", true) !== false,
        fontScale: this.chatFontScale(),
        soundNotifications: cfg.get("soundNotifications", false),
        processingSound: cfg.get("processingSound", false),
        readRepliesAloud: cfg.get("readRepliesAloud", false),
        summarizeRepliesAloud: cfg.get("summarizeRepliesAloud", true),
        voiceConfigured: !!this.voiceBackendState(this.sessionCwd(this.focused), this.focused.provider).backend,
        voiceBackendState: this.voiceBackendState(this.sessionCwd(this.focused), this.focused.provider),
        voiceSendPhrase: this.voiceSetting(
          this.sessionCwd(this.focused),
          "voiceSendPhrase",
          DEFAULT_SEND_PHRASE,
        ),
        voiceKeyterms: sanitizeVoiceKeyterms(
          this.voiceSetting(this.sessionCwd(this.focused), "voiceKeyterms", []),
        ),
        telemetryEnabled: cfg.get("telemetry.enabled", true),
        thumbsFeedback: cfg.get("thumbsFeedback", false),
        providers: this.providerStateMessage().providers,
        providersChecking: this.providerRefreshInFlight,
        githubState: this.githubStatePayload(),
        extVersion: this.context.extensionVersion,
        cliVersion: this.providerCliVersions.grok || "",
        hostKind: "extension" as const,
        grokUpdate: null,
        mcpServers: this.mcpServersView,
        mcpLoading: false,
        mcpError: "",
        mcpWarning: MCP_GLOBAL_SCOPE_WARNING,
        mcpConnectors: this.mcpConnectorsMessage().connectors,
        // `null` rather than `[]`: the page distinguishes "not asked yet"
        // (which paints a loading line) from "asked, and there are none".
        agentRoles: null,
        crewFlows: null,
        agentRoleProviders: [],
      },
      category: opts.category || "general",
      env: {
        isRemote: false,
        isDesktop: false,
        clientOwnsFontScale: false,
        steerSupported: true,
        providersKnown: true,
        hostCaps: {
          relocateView: this.host.canRelocateView,
          secondarySideBar: this.host.canUseSecondarySideBar,
          showOutput: this.host.canShowOutput,
          toggleDevTools: this.host.canToggleDevTools,
          settingsEditor: true,
          ...(this.host.canShowMcpSettings ? { mcpSettings: true } : {}),
        },
      },
    };
    const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="en" class="settings-page">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<style>
  /* Background only, not the visibility pair the chat and rail webviews use:
     this page's body holds one empty div until settings.js mounts into it, so
     there is no unstyled content to hide — only an unpainted page, which
     without this is white on a dark theme. */
  html, body { background: var(--vscode-editor-background, var(--vscode-sideBar-background)); }
</style>
<link rel="stylesheet" href="${mediaUri("settings.css")}" />
<title>All your Companions Settings</title>
</head>
<body class="settings-page">
  <div id="settings-root"></div>
  <script nonce="${nonce}">window.__grokSettingsBoot = ${bootJson};</script>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("settings.js")}"></script>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var boot = window.__grokSettingsBoot || {};
      var tts = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
      window.GrokVoiceSettings.install(window.GrokSettings);
      var surface = window.GrokSettings.mount(document.getElementById("settings-root"), {
        snapshot: boot.snapshot,
        env: Object.assign({ ttsAvailable: tts }, boot.env || {}),
        post: function (msg) { vscode.postMessage(msg); },
        standalone: true,
        category: boot.category,
        onClose: function () { vscode.postMessage({ type: "closeSettingsSurface" }); }
      });
      window.addEventListener("message", function (e) {
        var msg = e.data;
        if (!msg || !msg.type || !surface) return;
        if (msg.type === "voiceConfigured") {
          surface.update({ voiceConfigured: !!msg.value, voiceBackendState: msg.backendState,
            voiceSendPhrase: msg.sendPhrase, voiceKeyterms: msg.keyterms });
        }
        if (msg.type === "grokUpdateStatus") {
          var next = { grokUpdate: {
            current: msg.current, latest: msg.latest,
            updateAvailable: !!msg.updateAvailable, error: msg.error || null,
            policy: msg.policy || null,
          } };
          if (msg.current) next.cliVersion = msg.current;
          surface.update(next);
        }
        if (msg.type === "providerState" && Array.isArray(msg.providers)) {
          surface.update({ providers: msg.providers, providersChecking: msg.checking === true });
        }
        if (msg.type === "githubState" && msg.github) {
          surface.update({ githubState: msg.github });
        }
        if (msg.type === "mcpServers") {
          surface.update({
            mcpServers: Array.isArray(msg.servers) ? msg.servers : [],
            mcpLoading: msg.loading === true,
            mcpError: msg.error || "",
            mcpWarning: msg.warning || "",
          });
        }
        if (msg.type === "mcpConnectors") {
          surface.update({
            mcpConnectors: Array.isArray(msg.connectors) ? msg.connectors : [],
          });
        }
        if (msg.type === "agentRoles") {
          surface.update({
            agentRoles: Array.isArray(msg.roles) ? msg.roles : [],
            crewFlows: Array.isArray(msg.flows) ? msg.flows : [],
            agentRoleProviders: Array.isArray(msg.providers) ? msg.providers : [],
            agentRoleProblems: Array.isArray(msg.problems) ? msg.problems : [],
            agentRolesCwd: msg.cwd || "",
            agentRolesHasProject: msg.hasProject === true,
            agentRolesError: msg.error || "",
            agentRolesErrorId: msg.errorId || "",
            workflows: Array.isArray(msg.workflows) ? msg.workflows : [],
            defaultWorkflow: msg.defaultWorkflow || "idea-to-done",
            subagentRoster: Array.isArray(msg.subagentRoster) ? msg.subagentRoster : [],
            subagentsEnabled: msg.subagentsEnabled !== false,
            subagentRouting: Array.isArray(msg.subagentRouting) ? msg.subagentRouting : [],
            crewStagesMayUseSubagents: msg.crewStagesMayUseSubagents === true,
            companionSettings: msg.companionSettings || {},
            efforts: Array.isArray(msg.efforts) ? msg.efforts : []
          });
        }
        if (msg.type === "ruleFiles") {
          surface.update({ ruleFiles: Array.isArray(msg.files) ? msg.files : [] });
        }
        if (msg.type === "permissionRules") {
          surface.update({
            permissionRules: Array.isArray(msg.rules) ? msg.rules : [],
            permissionRulesOrderCopy: typeof msg.orderCopy === "string" ? msg.orderCopy : "",
            permissionRulesPending: msg.pendingAdoption && typeof msg.pendingAdoption === "object" ? msg.pendingAdoption : null
          });
        }
        if (msg.type === "workflowGenerator") {
          surface.update({
            workflowGenerator: {
              status: msg.status || "idle",
              requestId: msg.requestId || "",
              progress: msg.progress || "",
              draft: msg.draft,
              mermaid: msg.mermaid || "",
              validation: msg.validation,
              error: msg.error || "",
              compiler: msg.compiler
            }
          });
        }
        if (msg.type === "routines") {
          surface.update({
            routines: Array.isArray(msg.entries) ? msg.entries : [],
            routineProjects: Array.isArray(msg.projects) ? msg.projects : [],
            routineModels: Array.isArray(msg.models) ? msg.models : [],
            routineError: msg.error || "",
            routineErrorId: msg.errorId || "",
          });
        }
        if (msg.type === "error") {
          // A quota-refused save arrives as a plain error. Attribute it to the
          // Routines page, which is what the reader is looking at.
          surface.update({ routineError: msg.text || "", routineErrorId: "" });
        }
        if (msg.type === "settingsCategory" && msg.category) surface.setCategory(msg.category);
      });
    })();
  </script>
</body>
</html>`;
  }

  getHtml(webview: HostWebview): string {
    const nonce = getNonce();
    // Join under extensionUri so remote hosts keep vscode-remote:// (Uri.file
    // on extensionPath.fsPath would point the webview at a missing local path).
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    const resourceUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "resources", file));

    // Desktop multi-folder: host ships the rail mount. VS Code never does —
    // absence of `#projects-rail` is the property that keeps the extension's
    // chat column free of an in-panel rail (the projects view is a separate
    // primary-side-bar webview). A `repos` frame still arrives for clear-all.
    // Chrome mirrors AFK Pilot: brand + panel toggle, search, scroll, footer
    // theme toggle (no account avatar). chat.js only empties #rail-scroll.
    const railMark = this.host.canSwitchWorkspaceFolder
      ? resourceUri("grok-icon.svg")
      : "";
    const railMount = this.host.canSwitchWorkspaceFolder
      ? `
  <aside id="projects-rail" class="projects-rail" aria-label="Projects">
    <div class="rail-top">
      <span class="rail-brand" title="Grok Build Desktop">
        <span class="mark" style="--rail-mark:url('${railMark}')" aria-hidden="true"></span>
        <span class="wordmark"><b>Grok</b> <span class="dim">Build</span></span>
      </span>
      <button id="desk-rail-toggle" class="rail-icon-btn" type="button" title="Hide projects" aria-label="Hide projects" aria-expanded="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
      </button>
    </div>
    <div class="rail-search-wrap">
      <span class="rail-search-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </span>
      <input id="rail-search" class="rail-search" type="search" placeholder="Filter projects…" autocomplete="off" spellcheck="false" aria-label="Filter projects" />
    </div>
    <div id="rail-scroll" class="rail-scroll"></div>
    <div class="rail-foot">
      <div class="rail-user" aria-hidden="true"></div>
      <button id="rail-gear-btn" class="rail-icon-btn" type="button" title="Settings" aria-label="Settings" hidden></button>
      <button id="desk-theme-toggle" class="rail-icon-btn" type="button" title="Toggle theme" aria-label="Toggle light and dark theme">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5z"/></svg>
      </button>
    </div>
  </aside>`
      : "";
    const openMain = this.host.canSwitchWorkspaceFolder ? `<div class="app-main">` : "";
    const closeMain = this.host.canSwitchWorkspaceFolder ? `</div>` : "";
    // Files shell is in the first HTML frame so desktop never paints the
    // panel-less column and then upgrades. Inject reuses this node.
    const fileShellOpen = this.host.canSwitchWorkspaceFolder
      ? `<div id="desk-ft-shell" class="desk-ft-shell"><div class="desk-ft-chat">`
      : "";
    const fileShellClose = this.host.canSwitchWorkspaceFolder ? `</div></div>` : "";
    const deskLayoutClass = this.host.canSwitchWorkspaceFolder ? " has-rail desk-with-ft" : "";
    const firstFrameLayout = this.host.canSwitchWorkspaceFolder
      ? `
  body.desk.has-rail { display: flex; flex-direction: row; align-items: stretch; }
  body.desk.has-rail #projects-rail { width: var(--rail-width, 260px); flex-shrink: 0; height: 100%; display: flex; flex-direction: column; }
  body.desk.has-rail .app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  body.desk.has-rail .desk-ft-shell { display: flex; flex: 1 1 auto; flex-direction: row; min-width: 0; min-height: 0; height: 100%; }
  body.desk.has-rail .desk-ft-chat { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }`
      : "";
    // The shared file-panel asset is desktop-only in this generated document.
    // VS Code gets neither the tag nor the bytes, making the no-file-panel
    // decision structural.
    const filePanelStyle = this.host.canSwitchWorkspaceFolder
      ? `<link rel="stylesheet" href="${mediaUri("file-panel.css")}" />`
      : "";
    // The highlighter rides the same gate and MUST precede the panel: the panel
    // reads `GrokSyntaxHighlight` at render time, and a missing global there
    // silently degrades every file to plain text rather than failing loudly.
    const filePanelScript = this.host.canSwitchWorkspaceFolder
      ? `<script nonce="${nonce}" src="${mediaUri("syntax-highlight.js")}"></script>\n` +
        `  <script nonce="${nonce}" src="${mediaUri("file-panel.js")}"></script>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<style>
  /* Critical pre-stylesheet paint. VS Code serves chat.css through its webview
     service worker, which can cold-start a beat after the HTML renders — that
     gap otherwise paints the panel with no stylesheet at all. It was the welcome
     screen on a white background; on a restored session it is skeleton bars as
     white rectangles, the composer as a bare textarea and the context meter as
     raw text. Same gap, and whichever one shows depends only on what the panel
     happened to open with, so hold the WHOLE body rather than one screen of it.
     html keeps its background, so the gap shows the theme colour rather than
     white, and chat.css re-reveals (visibility: visible on body). */
  html, body { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  body { visibility: hidden; }
${firstFrameLayout}
</style>
<link rel="stylesheet" href="${mediaUri("chat.css")}" />
<link rel="stylesheet" href="${mediaUri("settings.css")}" />
${filePanelStyle}
</head>
<body class="desk${deskLayoutClass}${this.showThinking() ? "" : " thinking-hidden"}" style="--chat-zoom: ${this.chatFontScale()}">
${this.host.canSwitchWorkspaceFolder ? `<script nonce="${nonce}">try{if(localStorage.getItem("desk-rail-open")==="0")document.body.classList.add("desk-rail-collapsed")}catch(e){}</script>` : ""}
${railMount}
${openMain}
  <header class="top-bar">
    <div id="session-name-chip" class="session-name-chip" hidden>
      <button id="session-name-label" class="session-name-label" type="button"></button>
      <!-- Which project this conversation belongs to. History went
           multi-workspace, so the open conversation is no longer necessarily
           from the folder VS Code has open, and the name alone stopped saying
           where you are. Same treatment the rail gives its cross-project rows. -->
      <span id="session-name-repo" class="session-name-repo" hidden></span>
      <button id="session-name-edit" class="session-name-edit icon-btn" type="button" hidden></button>
    </div>
    <!-- AP-15. Two mutually exclusive controls in one slot: the segmented
         switch while the session is empty, the locked badge afterwards. This is
         NOT the composer's Agent/Plan/Auto-accept picker — that one decides what
         the agent may do in a turn, this one decides what the conversation is.
         The removed prototype's #mode-switch-bar must not come back here. -->
    <div id="session-type-picker" class="cx-seg cx-session-type" role="radiogroup" aria-label="Session type" title="Session type decides how this conversation works. The Agent/Plan picker decides what the agent may do in a turn." hidden>
      <button id="session-type-agent" class="cx-seg-opt session-type-opt" type="button" role="radio" aria-checked="true" tabindex="0" data-session-type="agent">Agent</button>
      <button id="session-type-crew" class="cx-seg-opt session-type-opt" type="button" role="radio" aria-checked="false" tabindex="-1" data-session-type="crew">Crew</button>
    </div>
    <span id="session-type-badge" class="cx-pill cx-pill--outline cx-session-badge" hidden></span>
    <button id="history-btn" class="icon-btn" title="Session history"></button>
    <button id="new-btn" class="icon-btn" title="New session"></button>
    ${this.host.canSwitchWorkspaceFolder ? `<div id="session-head-actions"></div>` : ""}
    ${this.host.canSwitchWorkspaceFolder ? "" : `<div id="vscode-session-actions"></div>`}
    <div id="history-popover" class="toolbar-popover history-popover" hidden></div>
  </header>
${fileShellOpen}
  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <span class="welcome-mark" role="img" aria-label="Grok" style="--welcome-mark:url('${resourceUri("grok-icon.svg")}')"></span>
      <h2>All your Companions</h2>
      <p class="welcome-byline muted">Unified AI Companions · Antigravity, Grok, Codex &amp; Claude</p>
      <p id="welcome-version" class="muted welcome-status-busy"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Starting</span></p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>

  <footer class="composer">
    <button id="scroll-bottom-btn" class="scroll-bottom-btn" type="button" title="Scroll to bottom"></button>
    <!-- The dock: every companion panel that pins above the composer shares
         one bounded, scrollable column, so four of them open at once cannot
         push the input off the panel. Each panel is hidden until it has
         something to say; an empty dock takes no space. -->
    <div id="cx-dock" class="cx-dock">
      <!-- AP-15/AP-17. A new Crew session picks its workflow here before the
           first message; the composer below is where the idea is typed. -->
      <section id="crew-empty" class="cx-rail cx-crew-start" aria-label="Start a crew run" hidden>
        <div class="cx-rail-head">
          <span class="cx-rail-toggle is-static">
            <span class="cx-rail-icon" aria-hidden="true" data-icon="users"></span>
            <span class="cx-rail-title">Choose a workflow</span>
          </span>
        </div>
        <div id="crew-workflow-list" class="cx-choice-list" role="radiogroup" aria-label="Workflow"></div>
        <div class="cx-rail-foot">
          <span class="cx-hint">Describe the idea below, then start.</span>
          <button id="crew-start" class="cx-btn cx-btn--primary cx-btn--sm" type="button">Start workflow</button>
        </div>
      </section>
      <!-- Agent step checklist (AP-02). Present but hidden until a structured
           plan update with entries arrives; providers that send plan TEXT
           never fill it. -->
      <section id="todo-rail" class="cx-rail" aria-label="Tasks" hidden>
        <div class="cx-rail-head">
          <button id="todo-rail-head" class="cx-rail-toggle" type="button" aria-expanded="true" aria-controls="todo-rail-list">
            <span class="cx-rail-caret" aria-hidden="true" data-icon="chevronDown"></span>
            <span class="cx-rail-icon" aria-hidden="true" data-icon="listChecks"></span>
            <span class="cx-rail-title">Tasks</span>
            <span id="todo-rail-count" class="cx-rail-meta"></span>
          </button>
        </div>
        <div class="cx-rail-bar" aria-hidden="true"><span id="todo-rail-bar"></span></div>
        <ol id="todo-rail-list" class="cx-rail-body cx-list-plain"></ol>
      </section>
      <!-- AP-16 §6.10 point 5. Answers "why is this still working?" while a
           turn waits on its subagents, and disappears when the last one is done. -->
      <section id="subagent-tray" class="cx-rail cx-rail--purple" aria-label="Running subagents" hidden>
        <div class="cx-rail-head">
          <span class="cx-rail-toggle is-static">
            <span class="cx-rail-icon" aria-hidden="true" data-icon="bot"></span>
            <span class="cx-rail-title">Subagents</span>
            <span id="subagent-tray-title" class="cx-rail-meta"></span>
          </span>
        </div>
        <ol id="subagent-tray-list" class="cx-rail-body cx-list-plain"></ol>
      </section>
      <section id="crew-run" class="cx-rail" aria-label="Crew run" hidden>
        <div class="cx-rail-head">
          <button id="crew-run-toggle" class="cx-rail-toggle" type="button" aria-expanded="true" aria-controls="crew-run-list">
            <span class="cx-rail-caret" aria-hidden="true" data-icon="chevronDown"></span>
            <span class="cx-rail-icon" aria-hidden="true" data-icon="users"></span>
            <span id="crew-run-title" class="cx-rail-title">Crew</span>
            <span id="crew-run-count" class="cx-rail-meta"></span>
          </button>
          <div class="cx-rail-actions">
            <button id="crew-run-stop" class="cx-btn cx-btn--danger cx-btn--sm" type="button">Stop</button>
          </div>
        </div>
        <div class="cx-rail-bar" aria-hidden="true"><span id="crew-run-bar"></span></div>
        <ol id="crew-run-list" class="cx-rail-body cx-list-plain cx-steps"></ol>
      </section>
      <!-- Multi-file change overview (AP-09). Hidden until a turn produces
           diffs; empty list hides it rather than painting a blank card. -->
      <section id="review-center" class="cx-rail" aria-label="Review changes" hidden>
        <div class="cx-rail-head">
          <button id="review-center-toggle" class="cx-rail-toggle" type="button" aria-expanded="true" aria-controls="review-center-body">
            <span class="cx-rail-caret" aria-hidden="true" data-icon="chevronDown"></span>
            <span class="cx-rail-icon" aria-hidden="true" data-icon="gitCompare"></span>
            <span class="cx-rail-title">Review</span>
            <span id="review-center-count" class="cx-rail-meta"></span>
          </button>
        </div>
        <div id="review-center-body" class="cx-rail-section">
          <div class="cx-rail-toolbar">
            <div class="cx-seg" role="tablist" aria-label="Review scope">
              <button id="review-scope-turn" class="cx-seg-opt" type="button" role="tab" aria-selected="true" aria-controls="review-center-list">This turn</button>
              <button id="review-scope-session" class="cx-seg-opt" type="button" role="tab" aria-selected="false" aria-controls="review-center-list">Session</button>
            </div>
            <span class="cx-spacer"></span>
            <button id="review-handoff" class="cx-btn cx-btn--sm" type="button">Hand off</button>
            <button id="review-revert-all" class="cx-btn cx-btn--danger cx-btn--sm" type="button">Discard all</button>
          </div>
          <ul id="review-center-list" class="cx-rail-body cx-list-plain" role="tabpanel"></ul>
        </div>
      </section>
    </div>
    <div class="composer-card">
      <div id="attachments" class="attachments"></div>
      <div class="composer-input-wrap">
        <div id="input-highlight" class="input-highlight" aria-hidden="true" dir="auto"></div>
        <textarea id="input" placeholder="Ask Grok..." rows="2" dir="auto"></textarea>
        <button id="mic-btn" class="mic-btn" title="Voice control"></button>
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button id="add-btn" class="icon-btn" title="Add context"></button>
          <button id="gear-btn" class="icon-btn" title="Settings"></button>
          <div class="context-donut" id="donut" title="Context usage">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-editorWidget-border,#444)" stroke-width="3"/>
              <circle id="donut-arc" cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-charts-green,#4ec9b0)" stroke-width="3" stroke-dasharray="0 999" transform="rotate(-90 8 8)"/>
            </svg>
            <span id="donut-label" class="small muted">0%</span>
          </div>
          <div id="chips"></div>
        </div>
        <div class="toolbar-right">
          <button id="mode-btn" class="toolbar-btn" title="Pick mode"></button>
          <button id="send-btn" class="send"></button>
        </div>
      </div>
    </div>
    <div id="mode-popover" class="toolbar-popover" hidden></div>
    <div id="gear-popover" class="toolbar-popover gear-popover" hidden></div>
    <div id="add-popover" class="toolbar-popover" hidden></div>
    <div id="context-popover" class="toolbar-popover" hidden></div>
    <div id="slash-popover" class="slash-popover" hidden></div>
    <div id="mention-popover" class="slash-popover mention-popover" hidden></div>
  </footer>
${fileShellClose}
${closeMain}

  <script nonce="${nonce}">
    // Configure MathJax before its bundle loads. We drive typesetting manually
    // via MathJax.tex2svg (startup.typeset:false), so it never scans the page.
    // svg.fontCache:'local' makes each equation's SVG embed its own glyph paths
    // (self-contained — required for the upcoming SVG/PNG export). enableMenu:false
    // drops the right-click menu (its assets would need network/CSP exceptions).
    // enableAssistiveMml:false is critical: by default MathJax appends a hidden
    // <mjx-assistive-mml> MathML copy of every equation, normally hidden by CSS
    // that MathJax injects when it manages the page. We drive it manually via
    // tex2svg + outerHTML, so that hiding CSS isn't applied and Chromium renders
    // the MathML natively — a visible *second* copy of every equation.
    window.MathJax = {
      tex: { processEnvironments: true, processRefs: true },
      svg: { fontCache: "local" },
      options: { enableMenu: false, enableAssistiveMml: false },
      startup: { typeset: false }
    };
  </script>
  <script nonce="${nonce}" src="${mediaUri("mathjax/tex-svg-full.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("mermaid/mermaid.min.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("settings.js")}"></script>
  ${filePanelScript}
  <script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body>
</html>`;
  }
}

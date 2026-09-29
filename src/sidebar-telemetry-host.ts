const INSTALL_ID_KEY = "grok.installId";
import type { ConnectedConnectorStore } from "./mcp-connectors";
import { type AppPurpose } from "./app-purpose";
import { normalizeRepoPath } from "./sessions";
import { randomUUID } from "node:crypto";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  sessionStartHostKind,
  sessionStartSurface,
  shouldSendTelemetry,
  OFFICIAL_EXTENSION_ID
} from "./telemetry";
import { rememberedEffort, type EffortPrefs } from "./mode-prefs";
import { Session } from "./session";
import { PersistedState } from "./persisted-state";
import * as os from "node:os";
import type { Host, HostContext } from "./host";
export interface SidebarTelemetryHostSidebarOps {
  readonly host: Host;
  readonly context: HostContext;
  sessionCwd: (session?: Session) => string;
  readonly state: PersistedState;
  displayMode: (session?: Session) => "agent" | "plan" | "yolo";
  chatFontScale: () => number;
  appPurpose: () => AppPurpose;
  readonly lastVoiceConfiguredByCwd: Map<string, boolean>;
  voiceSetting: <T>(cwd: string, key: string, fallback: T) => T;
  readonly lastProviderConnected: { grok: boolean; codex: boolean; claude: boolean; gemini: boolean; } | null;
  connectedConnectorStore: () => ConnectedConnectorStore;
}

export interface SidebarTelemetryHostDeps {
  readonly sidebarOps: SidebarTelemetryHostSidebarOps;
  readonly getOverride?: <T extends (...args: any[]) => any>(name: string) => T | undefined;
}
export class SidebarTelemetryHost {
  constructor(private readonly deps: SidebarTelemetryHostDeps) { }

  /** Fire the single `session_start` telemetry event for the first real user
     *  message of `session` (callers gate on isFirstSend, so empty sessions
     *  never reach here). Respects VS Code's global telemetry setting + our own
     *  `grok.telemetry.enabled`; fully fire-and-forget. Must not rediscover
     *  providers or resolve credentials — those flags come from the last
     *  providerState / voiceConfigured refresh. */
  public reportSessionStart(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.reportSessionStart>("reportSessionStart");
    if (testOverride) return testOverride(session);

    // Telemetry must NEVER affect the user's turn. Build the event synchronously
    // from already-cached session + settings + the last connection/voice snapshot
    // (so it captures THIS session's mode/model/effort — focus could move during
    // the turn's awaits), then fire it asynchronously off the send path and
    // swallow any error silently. The PROD project always (dev host / local
    // installs included — only the probe script uses DEV).
    try {
      const enabled = shouldSendTelemetry(
        this.deps.sidebarOps.host.isTelemetryEnabled,
        this.deps.sidebarOps.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true),
        this.deps.sidebarOps.context.extensionId === OFFICIAL_EXTENSION_ID,
      );
      if (!enabled) return;
      const cfg = this.deps.sidebarOps.host.getConfiguration("grok");
      const appVersion = this.deps.sidebarOps.context.extensionVersion;
      const cwd = this.deps.sidebarOps.sessionCwd(session);
      // Read before installId(): getOrCreate would create the id first and make
      // every send look like a returning install. Reuse the value rather than
      // asking twice — PersistedState.get() is a disk-backed read (refreshSync
      // stats the file), so a second call would be a second probe on the send
      // path for an answer we already hold. Only a genuine first run falls
      // through to installId(), and only once ever.
      const existingInstallId = this.deps.sidebarOps.state.get<string>(INSTALL_ID_KEY);
      const returningInstall = existingInstallId !== undefined;
      const event = buildSessionStartEvent(
        {
          installId: existingInstallId ?? this.installId(),
          mode: this.deps.sidebarOps.displayMode(session),
          model: session.client?.currentModelId || cfg.get<string>("defaultModel", "") || "",
          effort: session.client?.currentReasoningEffort
            || rememberedEffort(
              cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
              session.provider,
              cfg.get<string>("defaultEffort", ""),
            ),
          // Feature flags + host kind + connection snapshot. Config/enum values
          // only — the same class of anonymous property as mode/model/effort,
          // never content, paths, or free text. The builder allowlists every key.
          showThinking: cfg.get<boolean>("showThinking", false),
          expandToolDetails: cfg.get<boolean>("expandCommandOutputs", false),
          steerByDefault: cfg.get<boolean>("steerByDefault", false),
          chatFontScale: Math.round(this.deps.sidebarOps.chatFontScale() * 100),
          readRepliesAloud: cfg.get<boolean>("readRepliesAloud", false),
          soundNotifications: cfg.get<boolean>("soundNotifications", false),
          ...sessionStartSurface(),
          host: this.deps.sidebarOps.host.appName || undefined,
          hostKind: sessionStartHostKind(this.deps.sidebarOps.host.canSwitchWorkspaceFolder),
          appPurpose: this.deps.sidebarOps.appPurpose(),
          voiceConfigured: this.deps.sidebarOps.lastVoiceConfiguredByCwd.get(normalizeRepoPath(cwd)),
          voiceStreaming: cfg.get<boolean>("voiceStreaming", true),
          voiceLanguageSet: !!String(this.deps.sidebarOps.voiceSetting(cwd, "voiceLanguage", "") || "").trim(),
          grokConnected: this.deps.sidebarOps.lastProviderConnected?.grok,
          codexConnected: this.deps.sidebarOps.lastProviderConnected?.codex,
          claudeConnected: this.deps.sidebarOps.lastProviderConnected?.claude,
          geminiConnected: this.deps.sidebarOps.lastProviderConnected?.gemini,
          provider: session.provider,
          connectorCount: Object.keys(this.deps.sidebarOps.connectedConnectorStore()).length,
          worktree: !!session.worktree,
          returningInstall: returningInstall
        },
        {
          appVersion,
          osName: osNameFromPlatform(process.platform),
          osVersion: os.release(),
          locale: this.deps.sidebarOps.host.language || "",
          isDebug: !this.deps.sidebarOps.context.isProduction
        },
        randomUUID(),
        new Date().toISOString(),
      );
      // Off the send path entirely; postEvent is itself non-blocking + self-guarding.
      setImmediate(() => postEvent(APTABASE_APP_KEY_PROD, event));
    } catch {
      // Silent — a telemetry failure must never surface to or affect the user.
    }
  }

  /** Anonymous, per-install GUID — generated once and kept in shared client state
     *  (so it survives extension updates and identifies this machine across clients).
     *  It's an opaque random id, not tied to any
     *  account or the grok login; it's sent only as an event property so distinct
     *  installs can be counted without identifying anyone. */
  public installId(): string {
    const testOverride = this.deps.getOverride?.<typeof this.installId>("installId");
    if (testOverride) return testOverride();

    return this.deps.sidebarOps.state.getOrCreate(INSTALL_ID_KEY, randomUUID);
  }
}
